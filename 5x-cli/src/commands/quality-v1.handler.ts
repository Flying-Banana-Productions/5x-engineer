/**
 * Quality gate command handler — business logic for quality gate execution.
 *
 * Framework-independent: no citty imports.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runQualityGates } from "../gates/quality.js";
import { outputSuccess } from "../output.js";
import { resolveProjectContext } from "./context.js";
import { RecordError, recordStepInternal } from "./run-v1.handler.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityParams {
	record?: boolean;
	recordStep?: string;
	run?: string;
	phase?: string;
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
	const { projectRoot, config } = await resolveProjectContext();

	const commands = config.qualityGates;
	if (commands.length === 0) {
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
	const runId = `quality-${Date.now()}`;
	const logDir = join(projectRoot, ".5x", "logs", runId);
	mkdirSync(logDir, { recursive: true, mode: 0o700 });

	const result = await runQualityGates(commands, projectRoot, {
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
