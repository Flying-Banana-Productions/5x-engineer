/**
 * v1 Run lifecycle commands.
 *
 * Subcommands: init, state, record, complete, reopen, list
 *
 * All commands return JSON envelopes via outputSuccess/outputError.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
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
import { acquireLock, registerLockCleanup, releaseLock } from "../lock.js";
import { CliError, outputError, outputSuccess } from "../output.js";
import { canonicalizePlanPath } from "../paths.js";
import { resolveProjectRoot } from "../project-root.js";
import { generateRunId } from "../run-id.js";

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

/** Get maxStepsPerRun from config, with fallback for pre-Phase-8 configs. */
function getMaxStepsPerRun(config: Record<string, unknown>): number {
	if (
		typeof config === "object" &&
		config !== null &&
		"maxStepsPerRun" in config &&
		typeof config.maxStepsPerRun === "number"
	) {
		return config.maxStepsPerRun;
	}
	return 50; // default
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

const initCmd = defineCommand({
	meta: {
		name: "init",
		description: "Initialize or resume a run for a plan",
	},
	args: {
		plan: {
			type: "string",
			description: "Path to implementation plan",
			required: true,
		},
		command: {
			type: "string",
			description: "Command name (e.g. run, plan-review)",
		},
		"allow-dirty": {
			type: "boolean",
			description: "Allow dirty worktree",
			default: false,
		},
	},
	async run({ args }) {
		const planPath = canonicalizePlanPath(args.plan);
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
		if (!args["allow-dirty"]) {
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
			command: args.command,
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
	},
});

const stateCmd = defineCommand({
	meta: {
		name: "state",
		description: "Get run state including steps and summary",
	},
	args: {
		run: {
			type: "string",
			description: "Run ID",
		},
		plan: {
			type: "string",
			description: "Plan path (alternative to --run)",
		},
		tail: {
			type: "string",
			description: "Return only the last N steps",
		},
		"since-step": {
			type: "string",
			description: "Return only steps after this step ID",
		},
	},
	async run({ args }) {
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		// Resolve run by ID or plan path
		let run: RunRowV1 | null = null;
		if (args.run) {
			run = getRunV1(db, args.run);
		} else if (args.plan) {
			const planPath = canonicalizePlanPath(args.plan);
			run = getActiveRunV1(db, planPath);
		} else {
			outputError("INVALID_ARGS", "Either --run or --plan is required");
		}

		if (!run) {
			outputError("RUN_NOT_FOUND", "Run not found");
		}

		// Build step query options
		const stepOpts: { sinceStepId?: number; tail?: number } = {};
		if (args["since-step"]) {
			stepOpts.sinceStepId = Number.parseInt(args["since-step"], 10);
		} else if (args.tail) {
			stepOpts.tail = Number.parseInt(args.tail, 10);
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
	},
});

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

const recordCmd = defineCommand({
	meta: {
		name: "record",
		description: "Record a step in a run",
	},
	args: {
		stepName: {
			type: "positional",
			description: "Step name (e.g. author:impl:status)",
			required: true,
		},
		run: {
			type: "string",
			description: "Run ID",
			required: true,
		},
		result: {
			type: "string",
			description: 'Result JSON (raw string, "-" for stdin, "@path" for file)',
			required: true,
		},
		phase: {
			type: "string",
			description: "Phase identifier",
		},
		iteration: {
			type: "string",
			description: "Iteration number (auto-increment if omitted)",
		},
		"session-id": {
			type: "string",
			description: "Agent session ID",
		},
		model: {
			type: "string",
			description: "Model used",
		},
		"tokens-in": {
			type: "string",
			description: "Input tokens",
		},
		"tokens-out": {
			type: "string",
			description: "Output tokens",
		},
		"cost-usd": {
			type: "string",
			description: "Cost in USD",
		},
		"duration-ms": {
			type: "string",
			description: "Duration in milliseconds",
		},
		"log-path": {
			type: "string",
			description: "Path to NDJSON log file",
		},
	},
	async run({ args }) {
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		// Verify run exists and is active
		const run = getRunV1(db, args.run);
		if (!run) {
			outputError("RUN_NOT_FOUND", `Run ${args.run} not found`);
		}
		if (run.status !== "active") {
			outputError(
				"RUN_NOT_ACTIVE",
				`Run ${args.run} is ${run.status}, not active`,
			);
		}

		// Enforce maxStepsPerRun
		const maxSteps = run.config_json
			? getMaxStepsPerRun(
					JSON.parse(run.config_json) as Record<string, unknown>,
				)
			: getMaxStepsPerRun(config as unknown as Record<string, unknown>);

		const summary = computeRunSummary(db, args.run);
		if (summary.total_steps >= maxSteps) {
			outputError(
				"MAX_STEPS_EXCEEDED",
				`Run has reached the maximum of ${maxSteps} steps`,
				{ current_steps: summary.total_steps, max_steps: maxSteps },
			);
		}

		// Read result JSON
		const resultJson = await readResultJson(args.result);

		// Validate JSON
		try {
			JSON.parse(resultJson);
		} catch {
			outputError("INVALID_JSON", "--result must be valid JSON", {
				raw: resultJson.slice(0, 200),
			});
		}

		const result = recordStep(db, {
			run_id: args.run,
			step_name: args.stepName,
			phase: args.phase,
			iteration: args.iteration
				? Number.parseInt(args.iteration, 10)
				: undefined,
			result_json: resultJson,
			session_id: args["session-id"],
			model: args.model,
			tokens_in: args["tokens-in"]
				? Number.parseInt(args["tokens-in"], 10)
				: undefined,
			tokens_out: args["tokens-out"]
				? Number.parseInt(args["tokens-out"], 10)
				: undefined,
			cost_usd: args["cost-usd"]
				? Number.parseFloat(args["cost-usd"])
				: undefined,
			duration_ms: args["duration-ms"]
				? Number.parseInt(args["duration-ms"], 10)
				: undefined,
			log_path: args["log-path"],
		});

		outputSuccess({
			step_id: result.step_id,
			step_name: result.step_name,
			phase: result.phase,
			iteration: result.iteration,
			recorded: result.recorded,
		});
	},
});

const completeCmd = defineCommand({
	meta: {
		name: "complete",
		description: "Complete or abort a run",
	},
	args: {
		run: {
			type: "string",
			description: "Run ID",
			required: true,
		},
		status: {
			type: "string",
			description: "Terminal status (completed or aborted)",
			default: "completed",
		},
		reason: {
			type: "string",
			description: "Reason for completion/abort",
		},
	},
	async run({ args }) {
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		const run = getRunV1(db, args.run);
		if (!run) {
			outputError("RUN_NOT_FOUND", `Run ${args.run} not found`);
		}

		const status = args.status as "completed" | "aborted";
		if (status !== "completed" && status !== "aborted") {
			outputError(
				"INVALID_STATUS",
				'--status must be "completed" or "aborted"',
			);
		}

		// Record terminal step
		const stepName = status === "completed" ? "run:complete" : "run:abort";
		recordStep(db, {
			run_id: args.run,
			step_name: stepName,
			result_json: JSON.stringify({
				status,
				reason: args.reason ?? null,
			}),
		});

		// Update run status
		completeRun(db, args.run, status);

		// Release plan lock
		if (run.plan_path) {
			releaseLock(projectRoot, run.plan_path);
		}

		outputSuccess({
			run_id: args.run,
			status,
			reason: args.reason ?? null,
		});
	},
});

const reopenCmd = defineCommand({
	meta: {
		name: "reopen",
		description: "Reopen a completed or aborted run",
	},
	args: {
		run: {
			type: "string",
			description: "Run ID",
			required: true,
		},
	},
	async run({ args }) {
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		const run = getRunV1(db, args.run);
		if (!run) {
			outputError("RUN_NOT_FOUND", `Run ${args.run} not found`);
		}
		if (run.status === "active") {
			outputError("RUN_ALREADY_ACTIVE", `Run ${args.run} is already active`);
		}

		// Record reopen step with previous status
		recordStep(db, {
			run_id: args.run,
			step_name: "run:reopen",
			result_json: JSON.stringify({
				previous_status: run.status,
			}),
		});

		// Set run back to active
		reopenRun(db, args.run);

		outputSuccess({
			run_id: args.run,
			status: "active",
			previous_status: run.status,
		});
	},
});

const listCmd = defineCommand({
	meta: {
		name: "list",
		description: "List runs with optional filters",
	},
	args: {
		plan: {
			type: "string",
			description: "Filter by plan path",
		},
		status: {
			type: "string",
			description: "Filter by status (active, completed, aborted)",
		},
		limit: {
			type: "string",
			description: "Maximum number of results",
		},
	},
	async run({ args }) {
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		const runs = listRuns(db, {
			planPath: args.plan,
			status: args.status,
			limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
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
	},
});

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

export default defineCommand({
	meta: {
		name: "run",
		description: "Run lifecycle management",
	},
	subCommands: {
		init: () => Promise.resolve(initCmd),
		state: () => Promise.resolve(stateCmd),
		record: () => Promise.resolve(recordCmd),
		complete: () => Promise.resolve(completeCmd),
		reopen: () => Promise.resolve(reopenCmd),
		list: () => Promise.resolve(listCmd),
	},
});
