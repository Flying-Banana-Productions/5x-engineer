/**
 * Quality gate command handler — business logic for quality gate execution.
 *
 * Framework-independent: no citty imports.
 *
 * Phase 3a (013-worktree-authoritative-execution-context):
 * When `--run` is present, the handler uses the run context resolver to
 * auto-resolve the effective working directory from the run's worktree
 * mapping. Quality gates execute in the mapped worktree and config is
 * resolved from the plan's sub-project via `contextDir` (Phase 1c).
 * Log paths are anchored to `controlPlaneRoot/stateDir`.
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveLayeredConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { runQualityGates } from "../gates/quality.js";
import { outputError, outputSuccess } from "../output.js";
import { resolveProjectContext } from "./context.js";
import { DB_FILENAME, resolveControlPlaneRoot } from "./control-plane.js";
import { resolveRunExecutionContext } from "./run-context.js";
import { RecordError, recordStepInternal } from "./run-v1.handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityParams {
	record?: boolean;
	recordStep?: string;
	run?: string;
	phase?: string;
	workdir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Auto-record the quality result as a run step.
 *
 * IMPORTANT: This runs AFTER outputSuccess() has written the primary envelope.
 * All errors must go to stderr — never outputError() (which would write a
 * second JSON envelope to stdout, corrupting the stream).
 */
async function autoRecord(
	params: QualityParams,
	qualityData: Record<string, unknown>,
): Promise<void> {
	if (!params.run) {
		console.error(
			"Warning: --run is required when using --record. Step was not recorded.",
		);
		process.exitCode = 1;
		return;
	}

	const stepName = params.recordStep ?? "quality:check";

	try {
		await recordStepInternal({
			run: params.run,
			stepName,
			result: JSON.stringify(qualityData),
			phase: params.phase,
		});
	} catch (err) {
		// Recording is a side effect — primary envelope already written.
		// Warn on stderr with structured code, set non-zero exit via process.exitCode.
		if (err instanceof RecordError) {
			console.error(
				`Warning: failed to record step [${err.code}]: ${err.message}`,
			);
		} else {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`Warning: failed to record step: ${msg}`);
		}
		process.exitCode = 1;
	}
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function runQuality(params: QualityParams = {}): Promise<void> {
	// -----------------------------------------------------------------------
	// Phase 3a: When --run is present, resolve control-plane root and run
	// execution context to determine effective workdir and plan path for
	// config resolution (Phase 1c contextDir threading).
	// -----------------------------------------------------------------------
	let effectiveWorkdir: string | undefined;
	let controlPlaneRoot: string | undefined;
	let stateDir = ".5x";
	let configContextDir: string | undefined;

	if (params.run) {
		const controlPlane = resolveControlPlaneRoot(params.workdir);

		if (controlPlane.mode !== "none") {
			controlPlaneRoot = controlPlane.controlPlaneRoot;
			stateDir = controlPlane.stateDir;

			const dbRelPath = join(stateDir, DB_FILENAME);
			const db = getDb(controlPlaneRoot, dbRelPath);
			try {
				runMigrations(db);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(
					`Database upgrade required. Run "5x upgrade" to fix.\n\nDetails: ${msg}`,
				);
			}

			const ctxResult = resolveRunExecutionContext(db, params.run, {
				controlPlaneRoot,
				explicitWorkdir: params.workdir ? resolve(params.workdir) : undefined,
			});

			if (!ctxResult.ok) {
				if (ctxResult.error.code !== "RUN_NOT_FOUND") {
					outputError(ctxResult.error.code, ctxResult.error.message, {
						detail: ctxResult.error.detail,
					});
				}
				// RUN_NOT_FOUND: fall through — use normal resolution
			} else {
				const ctx = ctxResult.context;
				effectiveWorkdir = params.workdir
					? resolve(params.workdir)
					: ctx.effectiveWorkingDirectory;
				// Use plan path directory for config layering
				configContextDir = dirname(ctx.effectivePlanPath);
			}
		}
	}

	// Resolve project context — use layered config if we have a contextDir
	let projectRoot: string;
	let qualityGates: string[];

	if (configContextDir && controlPlaneRoot) {
		// Phase 1c: plan-path-anchored config layering
		const result = await resolveLayeredConfig(
			controlPlaneRoot,
			configContextDir,
		);
		projectRoot = effectiveWorkdir ?? controlPlaneRoot;
		qualityGates = result.config.qualityGates;
	} else if (effectiveWorkdir) {
		// Explicit workdir but no config context (unlikely, but handle)
		const ctx = await resolveProjectContext({ startDir: effectiveWorkdir });
		projectRoot = effectiveWorkdir;
		qualityGates = ctx.config.qualityGates;
	} else {
		// Default: resolve from cwd
		const ctx = await resolveProjectContext({ startDir: params.workdir });
		projectRoot = ctx.projectRoot;
		qualityGates = ctx.config.qualityGates;
	}

	if (qualityGates.length === 0) {
		const qualityData = {
			passed: true,
			results: [],
		};
		outputSuccess(qualityData);

		// Auto-record the empty-gates success if --record is set
		if (params.record) {
			await autoRecord(params, qualityData);
		}
		return;
	}

	// Use a temporary run context for logging purposes
	const runId = params.run ?? `quality-${Date.now()}`;
	// Phase 3a: re-anchor log path to controlPlaneRoot/stateDir
	const logBase = controlPlaneRoot ?? projectRoot;
	const logDir = join(logBase, stateDir, "logs", runId);
	mkdirSync(logDir, { recursive: true, mode: 0o700 });

	const result = await runQualityGates(qualityGates, projectRoot, {
		runId,
		logDir,
		phase: "0",
		attempt: 1,
	});

	const qualityData = {
		passed: result.passed,
		results: result.results.map((r) => ({
			command: r.command,
			passed: r.passed,
			duration_ms: Math.round(r.duration),
			output: r.output,
		})),
	};

	outputSuccess(qualityData);

	// Auto-record if --record is set
	if (params.record) {
		await autoRecord(params, qualityData);
	}
}
