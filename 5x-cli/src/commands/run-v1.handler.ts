/**
 * Run v1 command handlers — business logic for run lifecycle management.
 *
 * Framework-independent: no citty imports.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import {
	completeRun,
	computeRunSummary,
	createRunV1,
	getActiveRunV1,
	getRunV1,
	getSteps,
	listRuns,
	type RunRowV1,
	recordStep,
	reopenRun,
	type StepRow,
} from "../db/operations-v1.js";
import { runMigrations } from "../db/schema.js";
import { checkGitSafety } from "../git.js";
import {
	acquireLock,
	isLocked,
	registerLockCleanup,
	releaseLock,
} from "../lock.js";
import { CliError, outputError, outputSuccess } from "../output.js";
import { canonicalizePlanPath } from "../paths.js";
import { resolveProjectRoot } from "../project-root.js";
import type { AgentEvent } from "../providers/types.js";
import { generateRunId, validateRunId } from "../run-id.js";
import { NdjsonTailer } from "../utils/ndjson-tailer.js";
import { StreamWriter } from "../utils/stream-writer.js";
import { resolveDbContext } from "./context.js";

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface RunInitParams {
	plan: string;
	command?: string;
	allowDirty?: boolean;
}

export interface RunStateParams {
	run?: string;
	plan?: string;
	tail?: number;
	sinceStep?: number;
}

export interface RunRecordParams {
	stepName: string;
	run: string;
	result: string; // raw JSON string, "-" for stdin, "@path" for file
	phase?: string;
	iteration?: number;
	sessionId?: string;
	model?: string;
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
	durationMs?: number;
	logPath?: string;
}

export interface RunCompleteParams {
	run: string;
	status?: "completed" | "aborted";
	reason?: string;
}

export interface RunReopenParams {
	run: string;
}

export interface RunListParams {
	plan?: string;
	status?: string;
	limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read --result value: raw JSON string, "-" for stdin, "@path" for file. */
async function readResultJson(raw: string): Promise<string> {
	if (raw === "-") {
		// Read from stdin
		const chunks: Buffer[] = [];
		for await (const chunk of Bun.stdin.stream()) {
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks).toString("utf-8").trim();
	}

	if (raw.startsWith("@")) {
		const filePath = resolve(raw.slice(1));
		return readFileSync(filePath, "utf-8").trim();
	}

	return raw;
}

/** Get maxStepsPerRun from config, honoring deprecated maxAutoIterations alias. */
function getMaxStepsPerRun(config: Record<string, unknown>): number {
	if (
		typeof config === "object" &&
		config !== null &&
		"maxStepsPerRun" in config &&
		typeof config.maxStepsPerRun === "number"
	) {
		return config.maxStepsPerRun;
	}
	// Fallback: honor deprecated maxAutoIterations if maxStepsPerRun absent
	if (
		typeof config === "object" &&
		config !== null &&
		"maxAutoIterations" in config &&
		typeof config.maxAutoIterations === "number"
	) {
		return config.maxAutoIterations;
	}
	return 50; // default
}

function formatStep(step: StepRow) {
	return {
		id: step.id,
		step_name: step.step_name,
		phase: step.phase,
		iteration: step.iteration,
		result_json: step.result_json,
		session_id: step.session_id,
		model: step.model,
		tokens_in: step.tokens_in,
		tokens_out: step.tokens_out,
		cost_usd: step.cost_usd,
		duration_ms: step.duration_ms,
		log_path: step.log_path,
		created_at: step.created_at,
	};
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function runV1Init(params: RunInitParams): Promise<void> {
	const planPath = canonicalizePlanPath(params.plan);
	const projectRoot = resolveProjectRoot();
	const { config } = await loadConfig(projectRoot);

	// 1. Lock-first invariant: acquire plan lock before checking for active run
	const lockResult = acquireLock(projectRoot, planPath);
	if (!lockResult.acquired) {
		outputError(
			"PLAN_LOCKED",
			`Plan is locked by PID ${lockResult.existingLock?.pid}`,
			{
				pid: lockResult.existingLock?.pid,
				started_at: lockResult.existingLock?.startedAt,
			},
		);
	}

	// 2. Check git safety (release lock on failure)
	if (!params.allowDirty) {
		try {
			const safety = await checkGitSafety(projectRoot);
			if (!safety.safe) {
				releaseLock(projectRoot, planPath);
				outputError(
					"DIRTY_WORKTREE",
					"Worktree has uncommitted changes. Use --allow-dirty to override.",
					{
						untracked_files: safety.untrackedFiles,
						branch: safety.branch,
					},
				);
			}
		} catch (err) {
			// Re-throw CliError (from outputError above), only catch git failures
			if (err instanceof CliError) throw err;
			// Not a git repo or git not available — skip safety check
		}
	}

	// 3. Open DB and run migrations
	const db = getDb(projectRoot, config.db.path);
	runMigrations(db);

	// 4. Idempotent: return existing active run if one exists
	const existing = getActiveRunV1(db, planPath);
	if (existing) {
		registerLockCleanup(projectRoot, planPath);
		outputSuccess({
			run_id: existing.id,
			plan_path: existing.plan_path,
			status: existing.status,
			created_at: existing.created_at,
			resumed: true,
		});
		return;
	}

	// 5. Create new run
	const runId = generateRunId();
	createRunV1(db, {
		id: runId,
		planPath,
		command: params.command,
		configJson: JSON.stringify({
			maxStepsPerRun: getMaxStepsPerRun(
				config as unknown as Record<string, unknown>,
			),
		}),
	});

	registerLockCleanup(projectRoot, planPath);

	const run = getRunV1(db, runId);
	outputSuccess({
		run_id: runId,
		plan_path: run?.plan_path ?? planPath,
		status: "active",
		created_at: run?.created_at ?? new Date().toISOString(),
		resumed: false,
	});
}

export async function runV1State(params: RunStateParams): Promise<void> {
	const { db } = await resolveDbContext();

	// Resolve run by ID or plan path
	let run: RunRowV1 | null = null;
	if (params.run) {
		run = getRunV1(db, params.run);
	} else if (params.plan) {
		const planPath = canonicalizePlanPath(params.plan);
		run = getActiveRunV1(db, planPath);
	} else {
		outputError("INVALID_ARGS", "Either --run or --plan is required");
	}

	if (!run) {
		outputError("RUN_NOT_FOUND", "Run not found");
	}

	// Build step query options
	const stepOpts: { sinceStepId?: number; tail?: number } = {};
	if (params.sinceStep !== undefined) {
		stepOpts.sinceStepId = params.sinceStep;
	} else if (params.tail !== undefined) {
		stepOpts.tail = params.tail;
	}

	const steps = getSteps(db, run.id, stepOpts);
	const summary = computeRunSummary(db, run.id);

	outputSuccess({
		run: {
			id: run.id,
			plan_path: run.plan_path,
			command: run.command,
			status: run.status,
			created_at: run.created_at,
			updated_at: run.updated_at,
		},
		steps: steps.map(formatStep),
		summary,
	});
}

export async function runV1Record(params: RunRecordParams): Promise<void> {
	const { config, db } = await resolveDbContext();

	// Verify run exists and is active
	const run = getRunV1(db, params.run);
	if (!run) {
		outputError("RUN_NOT_FOUND", `Run ${params.run} not found`);
	}
	if (run.status !== "active") {
		outputError(
			"RUN_NOT_ACTIVE",
			`Run ${params.run} is ${run.status}, not active`,
		);
	}

	// Enforce maxStepsPerRun (guard against corrupt config_json)
	let runConfig: Record<string, unknown> | null = null;
	if (run.config_json) {
		try {
			runConfig = JSON.parse(run.config_json) as Record<string, unknown>;
		} catch {
			// Corrupt config_json — fall through to global config default
		}
	}
	const maxSteps = runConfig
		? getMaxStepsPerRun(runConfig)
		: getMaxStepsPerRun(config as unknown as Record<string, unknown>);

	const summary = computeRunSummary(db, params.run);
	if (summary.total_steps >= maxSteps) {
		outputError(
			"MAX_STEPS_EXCEEDED",
			`Run has reached the maximum of ${maxSteps} steps`,
			{ current_steps: summary.total_steps, max_steps: maxSteps },
		);
	}

	// Read result JSON
	const resultJson = await readResultJson(params.result);

	// Validate JSON
	try {
		JSON.parse(resultJson);
	} catch {
		outputError("INVALID_JSON", "--result must be valid JSON", {
			raw: resultJson.slice(0, 200),
		});
	}

	const result = recordStep(db, {
		run_id: params.run,
		step_name: params.stepName,
		phase: params.phase,
		iteration: params.iteration,
		result_json: resultJson,
		session_id: params.sessionId,
		model: params.model,
		tokens_in: params.tokensIn,
		tokens_out: params.tokensOut,
		cost_usd: params.costUsd,
		duration_ms: params.durationMs,
		log_path: params.logPath,
	});

	outputSuccess({
		step_id: result.step_id,
		step_name: result.step_name,
		phase: result.phase,
		iteration: result.iteration,
		recorded: result.recorded,
	});
}

export async function runV1Complete(params: RunCompleteParams): Promise<void> {
	const { projectRoot, db } = await resolveDbContext();

	const run = getRunV1(db, params.run);
	if (!run) {
		outputError("RUN_NOT_FOUND", `Run ${params.run} not found`);
	}

	const status = params.status ?? "completed";
	if (status !== "completed" && status !== "aborted") {
		outputError("INVALID_STATUS", '--status must be "completed" or "aborted"');
	}

	// Enforce lock ownership: the plan must either be unlocked, locked by us,
	// or locked by a dead process. If another live PID holds the lock, refuse.
	if (run.plan_path) {
		const lockStatus = isLocked(projectRoot, run.plan_path);
		if (
			lockStatus.locked &&
			!lockStatus.stale &&
			lockStatus.info?.pid !== process.pid
		) {
			outputError(
				"PLAN_LOCKED",
				`Plan is locked by PID ${lockStatus.info?.pid}; cannot complete run owned by another process`,
				{ pid: lockStatus.info?.pid, started_at: lockStatus.info?.startedAt },
			);
		}
	}

	// Record terminal step
	const stepName = status === "completed" ? "run:complete" : "run:abort";
	recordStep(db, {
		run_id: params.run,
		step_name: stepName,
		result_json: JSON.stringify({
			status,
			reason: params.reason ?? null,
		}),
	});

	// Update run status
	completeRun(db, params.run, status);

	// Release plan lock (ownership-safe: only releases if we own it or it's stale)
	if (run.plan_path) {
		releaseLock(projectRoot, run.plan_path);
	}

	outputSuccess({
		run_id: params.run,
		status,
		reason: params.reason ?? null,
	});
}

export async function runV1Reopen(params: RunReopenParams): Promise<void> {
	const { projectRoot, db } = await resolveDbContext();

	const run = getRunV1(db, params.run);
	if (!run) {
		outputError("RUN_NOT_FOUND", `Run ${params.run} not found`);
	}
	if (run.status === "active") {
		outputError("RUN_ALREADY_ACTIVE", `Run ${params.run} is already active`);
	}

	// Enforce lock ownership: if the plan is locked by another live PID, refuse.
	if (run.plan_path) {
		const lockStatus = isLocked(projectRoot, run.plan_path);
		if (
			lockStatus.locked &&
			!lockStatus.stale &&
			lockStatus.info?.pid !== process.pid
		) {
			outputError(
				"PLAN_LOCKED",
				`Plan is locked by PID ${lockStatus.info?.pid}; cannot reopen run`,
				{ pid: lockStatus.info?.pid, started_at: lockStatus.info?.startedAt },
			);
		}
	}

	// Record reopen step with previous status
	recordStep(db, {
		run_id: params.run,
		step_name: "run:reopen",
		result_json: JSON.stringify({
			previous_status: run.status,
		}),
	});

	// Set run back to active
	reopenRun(db, params.run);

	outputSuccess({
		run_id: params.run,
		status: "active",
		previous_status: run.status,
	});
}

export async function runV1List(params: RunListParams): Promise<void> {
	const { db } = await resolveDbContext();

	const runs = listRuns(db, {
		planPath: params.plan ? canonicalizePlanPath(params.plan) : undefined,
		status: params.status,
		limit: params.limit,
	});

	outputSuccess({
		runs: runs.map((r) => ({
			id: r.id,
			plan_path: r.plan_path,
			command: r.command,
			status: r.status,
			created_at: r.created_at,
			updated_at: r.updated_at,
			step_count: r.step_count,
		})),
	});
}

// ---------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------

export interface RunWatchParams {
	run: string;
	humanReadable?: boolean;
	showReasoning?: boolean;
	noReplay?: boolean;
	workdir?: string;
}

export async function runV1Watch(params: RunWatchParams): Promise<void> {
	validateRunId(params.run);

	// Validate run exists — try DB first, fall back to log dir existence
	const { projectRoot, db } = await resolveDbContext({
		startDir: params.workdir,
	});
	const run = getRunV1(db, params.run);
	const logDir = join(projectRoot, ".5x", "logs", params.run);

	if (!run) {
		if (existsSync(logDir)) {
			process.stderr.write(
				`[watch] Warning: run '${params.run}' not found in DB, but log directory exists. Proceeding.\n`,
			);
		} else {
			outputError(
				"RUN_NOT_FOUND",
				`Run '${params.run}' not found (no DB entry and no log directory)`,
			);
		}
	}

	// Ensure log dir exists with restricted permissions (run may have been init'd but no invoke yet)
	mkdirSync(logDir, { recursive: true, mode: 0o700 });

	// Warn if an existing log dir has overly-permissive mode (e.g., manually created without 0o700)
	try {
		const dirMode = statSync(logDir).mode & 0o777;
		if (dirMode & 0o077) {
			process.stderr.write(
				`[watch] Warning: log directory has mode ${dirMode.toString(8).padStart(3, "0")} (group/other access); expected 700\n`,
			);
		}
	} catch {
		// stat failure is non-fatal — proceed
	}

	// Set up abort on SIGINT
	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.on("SIGINT", onSigint);

	const tailer = new NdjsonTailer({
		dir: logDir,
		signal: controller.signal,
		startAtEnd: params.noReplay,
	});

	const humanReadable = params.humanReadable ?? false;
	const showReasoning = params.showReasoning ?? false;

	try {
		if (humanReadable) {
			await watchHumanReadable(tailer, showReasoning);
		} else {
			await watchNdjson(tailer);
		}
	} catch (err) {
		// Unexpected streaming error — emit to stderr (not stdout) and abort cleanly.
		// This prevents bin.ts from writing a JSON error envelope into the middle of
		// a NDJSON or human-readable stdout stream.
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[watch] Error: ${msg}\n`);
		process.exitCode = 1;
		controller.abort();
	} finally {
		process.off("SIGINT", onSigint);
		tailer.destroy();
	}
}

/**
 * Default mode: output raw NDJSON lines with a `source` field to stdout.
 */
async function watchNdjson(tailer: NdjsonTailer): Promise<void> {
	for await (const { file, entry } of tailer) {
		const line = JSON.stringify({ source: file, ...entry });
		process.stdout.write(`${line}\n`);
	}
}

/**
 * Human-readable mode: render events through StreamWriter with label headers.
 */
async function watchHumanReadable(
	tailer: NdjsonTailer,
	showReasoning: boolean,
): Promise<void> {
	const writer = new StreamWriter({
		writer: (s) => process.stdout.write(s),
	});
	const labels = new Map<string, string>();
	let currentFile: string | null = null;

	try {
		for await (const { file, entry } of tailer) {
			const type = entry.type as string;

			// session_start: update label, render header, don't pass to StreamWriter
			if (type === "session_start") {
				const role = entry.role as string;
				const phase = entry.phase_number as string | undefined;
				const label = phase ? `[${role}-phase-${phase}]` : `[${role}]`;
				labels.set(file, label);

				// Print label header immediately
				writer.endBlock();
				writer.writeLine(label);
				currentFile = file;
				continue;
			}

			// On file switch, flush and print label header
			if (file !== currentFile) {
				writer.endBlock();
				const label = labels.get(file) ?? `[${file.replace(".ndjson", "")}]`;
				writer.writeLine(label);
				currentFile = file;
			}

			// Route to StreamWriter — reconstruct AgentEvent from entry
			const event = entryToAgentEvent(entry);
			if (event) {
				writer.writeEvent(event, { showReasoning });
			}
		}
	} finally {
		writer.destroy();
	}
}

/**
 * Best-effort conversion from a parsed log entry to AgentEvent.
 * Returns null for unrecognized types, malformed entries, or legacy log shapes.
 * Never throws — treats bad data as skip-worthy.
 */
function entryToAgentEvent(entry: Record<string, unknown>): AgentEvent | null {
	try {
		const type = entry.type;
		if (typeof type !== "string") return null;

		switch (type) {
			case "text":
				return typeof entry.delta === "string"
					? { type: "text", delta: entry.delta }
					: null;
			case "reasoning":
				return typeof entry.delta === "string"
					? { type: "reasoning", delta: entry.delta }
					: null;
			case "tool_start":
				return typeof entry.tool === "string"
					? {
							type: "tool_start",
							tool: entry.tool,
							input_summary:
								typeof entry.input_summary === "string"
									? entry.input_summary
									: "",
						}
					: null;
			case "tool_end":
				return typeof entry.tool === "string"
					? {
							type: "tool_end",
							tool: entry.tool,
							output: typeof entry.output === "string" ? entry.output : "",
							...(typeof entry.error === "boolean"
								? { error: entry.error }
								: {}),
						}
					: null;
			case "error":
				return typeof entry.message === "string"
					? { type: "error", message: entry.message }
					: null;
			case "usage": {
				const tokens = entry.tokens;
				if (
					typeof tokens !== "object" ||
					tokens === null ||
					typeof (tokens as Record<string, unknown>).in !== "number" ||
					typeof (tokens as Record<string, unknown>).out !== "number"
				) {
					return null;
				}
				return {
					type: "usage",
					tokens: tokens as { in: number; out: number },
					...(typeof entry.costUsd === "number"
						? { costUsd: entry.costUsd }
						: {}),
				};
			}
			case "done":
				return null;
			default:
				return null;
		}
	} catch {
		// Defensive: if any property access throws (e.g., proxy objects), skip
		return null;
	}
}
