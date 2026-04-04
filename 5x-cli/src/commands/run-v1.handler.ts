/**
 * Run v1 command handlers — business logic for run lifecycle management.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Phase 3b (013-worktree-authoritative-execution-context):
 * All run subcommands use `resolveControlPlaneRoot` (via `resolveDbContext`)
 * for DB resolution, ensuring they never read/write a worktree-local DB
 * when a root DB exists. Artifact paths (logs, locks, worktrees) are
 * anchored to `controlPlaneRoot/stateDir`. `run init` validates that plan
 * paths are under `controlPlaneRoot`.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import {
	type FiveXConfig,
	loadConfig,
	resolveLayeredConfig,
} from "../config.js";
import { getDb } from "../db/connection.js";
import { getPlan, upsertPlan } from "../db/operations.js";
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
	updateRunPlanPath,
} from "../db/operations-v1.js";
import { runMigrations } from "../db/schema.js";
import {
	branchNameFromPlan,
	checkGitSafety,
	createWorktree,
	isBranchRelevant,
	listWorktrees,
	runWorktreeSetupCommand,
} from "../git.js";
import {
	acquireLock,
	isLocked,
	type LockDirOpts,
	registerLockCleanup,
	releaseLock,
} from "../lock.js";
import {
	CliError,
	exitCodeForError,
	outputError,
	outputSuccess,
} from "../output.js";
import { parsePlan } from "../parsers/plan.js";
import {
	canonicalizePlanPath,
	planSlugFromPath,
	resolvePlanArg,
} from "../paths.js";
import {
	extractInvokeMetadata,
	extractPipeContext,
	isStdinPiped,
	readUpstreamEnvelope,
} from "../pipe.js";
import { resolveProjectRoot } from "../project-root.js";
import type { AgentEvent } from "../providers/types.js";
import { generateRunId, validateRunId } from "../run-id.js";
import { NdjsonTailer } from "../utils/ndjson-tailer.js";
import { StreamWriter } from "../utils/stream-writer.js";
import { resolveDbContext } from "./context.js";
import {
	type ControlPlaneResult,
	DB_FILENAME,
	normalizeDbPath,
	resolveControlPlaneRoot,
} from "./control-plane.js";
import { resolveRunExecutionContext } from "./run-context.js";

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface RunInitParams {
	plan: string;
	allowDirty?: boolean;
	worktree?: boolean;
	worktreePath?: string;
}

export interface RunStateParams {
	run?: string;
	plan?: string;
	tail?: number;
	sinceStep?: number;
}

export interface RunRecordParams {
	stepName?: string; // can come from pipe (template's step_name) or positional
	run?: string; // can come from pipe
	result?: string; // raw JSON string, "-" for stdin, "@path" for file; can come from pipe
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

export interface RunRelinkParams {
	run: string;
	plan?: string | true; // path, or true for auto-search by filename
	worktree?: string;
}

// ---------------------------------------------------------------------------
// RecordError — structured domain error for recording failures
// ---------------------------------------------------------------------------

/** Structured recording error — preserves code/detail without CLI side effects. */
export class RecordError extends Error {
	readonly code: string;
	readonly detail?: unknown;

	constructor(code: string, message: string, detail?: unknown) {
		super(message);
		this.name = "RecordError";
		this.code = code;
		this.detail = detail;
	}
}

/** Result from recording a step (no CLI side effects). */
export interface RecordStepResult {
	step_id: number;
	step_name: string;
	phase: string | null;
	iteration: number | null;
	recorded: boolean;
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
	return 250; // default
}

type WorktreeAction = "reused" | "attached" | "created";

interface WorktreeInitResult {
	action: WorktreeAction;
	worktree_path: string;
	branch: string;
	warnings?: string[];
}

/**
 * Phase 4: Derive top-level `worktree_path` and `worktree_plan_path` fields
 * for the `run init` success payload. These fields sit alongside the nested
 * `worktree` object so that `extractPipeContext` (which reads top-level keys)
 * can propagate worktree context to downstream pipe consumers without having
 * to dive into nested structures.
 *
 * `worktree_plan_path` is the plan file path re-rooted into the mapped
 * worktree. It is only included when the plan file actually exists there.
 */
function deriveWorktreeContextFields(
	worktreeResult: WorktreeInitResult | undefined,
	planPath: string,
	controlPlaneRoot: string,
): { worktree_path?: string; worktree_plan_path?: string } {
	if (!worktreeResult) return {};

	const fields: { worktree_path?: string; worktree_plan_path?: string } = {
		worktree_path: worktreeResult.worktree_path,
	};

	// Derive worktree-relative plan path and include only if the file exists
	const relPlanPath = relative(controlPlaneRoot, planPath);
	if (!relPlanPath.startsWith("..") && !isAbsolute(relPlanPath)) {
		const worktreePlanPath = join(worktreeResult.worktree_path, relPlanPath);
		if (existsSync(worktreePlanPath)) {
			fields.worktree_plan_path = worktreePlanPath;
		}
	}

	return fields;
}

/**
 * Phase 3b: `stateDir` parameter anchors worktree path to
 * `<projectRoot>/<stateDir>/worktrees/` instead of `<projectRoot>/.5x/worktrees/`.
 */
function deriveDefaultWorktreeDir(
	projectRoot: string,
	planPath: string,
	stateDir = ".5x",
): string {
	const slug = planSlugFromPath(planPath);
	const hash = createHash("sha256").update(planPath).digest("hex").slice(0, 6);
	return join(projectRoot, stateDir, "worktrees", `${slug}-${hash}`);
}

function isPathUnder(childPath: string, parentPath: string): boolean {
	const relPath = relative(parentPath, childPath);
	return !relPath.startsWith("..") && !isAbsolute(relPath);
}

/**
 * Resolve a configured path against projectRoot.
 * Note: paths.* values are always absolute after config loading,
 * so this is effectively a no-op for config paths. Kept for
 * non-config paths that may still be relative.
 */
function resolveConfiguredPath(
	projectRoot: string,
	configuredPath: string,
): string {
	return isAbsolute(configuredPath)
		? resolve(configuredPath)
		: resolve(projectRoot, configuredPath);
}

async function ensureRunWorktree(
	db: Database,
	projectRoot: string,
	planPath: string,
	explicitPath: string | undefined,
	postCreateHook: string | undefined,
	stateDir = ".5x",
): Promise<WorktreeInitResult> {
	const gitWorktrees = await listWorktrees(projectRoot);

	if (explicitPath) {
		const absPath = resolve(explicitPath);
		const match = gitWorktrees.find((w) => w.path === absPath);
		if (!match) {
			if (!existsSync(absPath)) {
				outputError(
					"WORKTREE_NOT_FOUND",
					`Worktree path not found: ${absPath}`,
					{
						path: absPath,
					},
				);
			}
			outputError(
				"WORKTREE_INVALID",
				`Path is not a git worktree in this repository: ${absPath}`,
				{ path: absPath },
			);
		}

		upsertPlan(db, {
			planPath,
			worktreePath: absPath,
			branch: match.branch,
		});

		return {
			action: "attached",
			worktree_path: absPath,
			branch: match.branch,
		};
	}

	const existing = getPlan(db, planPath);
	if (existing?.worktree_path) {
		const match = gitWorktrees.find((w) => w.path === existing.worktree_path);
		if (match) {
			return {
				action: "reused",
				worktree_path: match.path,
				branch: match.branch,
			};
		}
	}

	const expectedBranch = branchNameFromPlan(planPath);
	const cwd = resolve(".");
	const cwdWorktree = gitWorktrees.find((w) => w.path === cwd);
	if (
		cwdWorktree &&
		(cwdWorktree.branch === expectedBranch ||
			isBranchRelevant(cwdWorktree.branch, planPath))
	) {
		upsertPlan(db, {
			planPath,
			worktreePath: cwdWorktree.path,
			branch: cwdWorktree.branch,
		});
		return {
			action: "attached",
			worktree_path: cwdWorktree.path,
			branch: cwdWorktree.branch,
		};
	}

	const candidates = gitWorktrees.filter(
		(w) => w.branch === expectedBranch || isBranchRelevant(w.branch, planPath),
	);

	if (candidates.length === 1) {
		const candidate = candidates[0] as { path: string; branch: string };
		upsertPlan(db, {
			planPath,
			worktreePath: candidate.path,
			branch: candidate.branch,
		});
		return {
			action: "attached",
			worktree_path: candidate.path,
			branch: candidate.branch,
		};
	}

	if (candidates.length > 1) {
		outputError(
			"WORKTREE_AMBIGUOUS",
			`Multiple matching worktrees found for plan: ${planPath}`,
			{
				plan_path: planPath,
				expected_branch: expectedBranch,
				candidates: candidates.map((w) => ({
					worktree_path: w.path,
					branch: w.branch,
				})),
			},
		);
	}

	const branch = expectedBranch;
	const wtPath = deriveDefaultWorktreeDir(projectRoot, planPath, stateDir);

	const existingByPath = gitWorktrees.find((w) => w.path === wtPath);
	if (existingByPath) {
		upsertPlan(db, {
			planPath,
			worktreePath: wtPath,
			branch: existingByPath.branch,
		});
		return {
			action: "attached",
			worktree_path: wtPath,
			branch: existingByPath.branch,
		};
	}

	if (existsSync(wtPath)) {
		outputError(
			"WORKTREE_INVALID",
			`Default worktree path exists but is not registered in git: ${wtPath}`,
			{ path: wtPath },
		);
	}

	try {
		await createWorktree(projectRoot, branch, wtPath);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		outputError(
			"WORKTREE_ERROR",
			`Failed to create worktree for plan \`${planPath}\`: ${detail} No worktree was attached or created for this run. Re-run without --worktree to use the current checkout, or fix the worktree error and retry.`,
			{
				plan_path: planPath,
				worktree_path: wtPath,
				branch,
			},
		);
	}

	const warnings: string[] = [];
	if (postCreateHook) {
		try {
			await runWorktreeSetupCommand(wtPath, postCreateHook);
		} catch (err) {
			const msg = `postCreate hook failed: ${err instanceof Error ? err.message : String(err)}`;
			process.stderr.write(`Warning: ${msg}\n`);
			warnings.push(msg);
		}
	}

	upsertPlan(db, {
		planPath,
		worktreePath: wtPath,
		branch,
	});

	return {
		action: "created",
		worktree_path: wtPath,
		branch,
		...(warnings.length > 0 ? { warnings } : {}),
	};
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
// Text formatters
// ---------------------------------------------------------------------------

/** Format duration_ms as human-readable string (e.g., "2m 15s" or "45s"). */
function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}
	return `${seconds}s`;
}

/** Format cost as $X.XX. */
function formatCost(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

/**
 * Human-readable text formatter for `run state` output.
 *
 * Renders a run info header, padded step table, and summary line.
 * Omits columns where all values are null.
 */
function formatStateText(data: {
	run: {
		id: string;
		plan_path: string;
		status: string;
		created_at: string;
		updated_at: string;
		worktree_path?: string;
	};
	steps: Array<{
		id: number;
		step_name: string;
		phase: string | null;
		iteration: number | null;
		duration_ms: number | null;
		cost_usd: number | null;
		created_at: string;
		[key: string]: unknown;
	}>;
	summary: {
		total_steps: number;
		phases_completed: string[];
		total_tokens_in: number;
		total_tokens_out: number;
		total_cost_usd: number;
		total_duration_ms: number;
	};
}): void {
	const { run, steps, summary } = data;

	// Header
	console.log(`Run:     ${run.id}`);
	console.log(`Plan:    ${run.plan_path}`);
	console.log(`Status:  ${run.status}`);
	console.log(`Created: ${run.created_at}`);

	if (steps.length === 0) {
		console.log();
		console.log("Steps: (none)");
		return;
	}

	// Determine which optional columns have data
	const hasPhase = steps.some((s) => s.phase != null);
	const hasIteration = steps.some((s) => s.iteration != null);
	const hasDuration = steps.some((s) => s.duration_ms != null);
	const hasCost = steps.some((s) => s.cost_usd != null);

	// Build column definitions: [header, width, getter]
	type Col = {
		header: string;
		width: number;
		get: (s: (typeof steps)[0]) => string;
	};
	const cols: Col[] = [
		{ header: "#", width: 1, get: (s) => String(s.id) },
		{ header: "Step", width: 4, get: (s) => s.step_name },
	];
	if (hasPhase)
		cols.push({ header: "Phase", width: 5, get: (s) => s.phase ?? "" });
	if (hasIteration)
		cols.push({
			header: "Iter",
			width: 4,
			get: (s) => (s.iteration != null ? String(s.iteration) : ""),
		});
	if (hasDuration)
		cols.push({
			header: "Duration",
			width: 8,
			get: (s) => (s.duration_ms != null ? formatDuration(s.duration_ms) : ""),
		});
	if (hasCost)
		cols.push({
			header: "Cost",
			width: 4,
			get: (s) => (s.cost_usd != null ? formatCost(s.cost_usd) : ""),
		});
	cols.push({ header: "Created", width: 7, get: (s) => s.created_at });

	// Calculate actual widths from data
	for (const col of cols) {
		col.width = Math.max(col.width, col.header.length);
		for (const s of steps) {
			col.width = Math.max(col.width, col.get(s).length);
		}
	}

	// Print table
	console.log();
	console.log("Steps:");
	const headerLine = cols.map((c) => c.header.padEnd(c.width)).join("  ");
	console.log(`  ${headerLine}`);
	for (const step of steps) {
		const row = cols.map((c) => c.get(step).padEnd(c.width)).join("  ");
		console.log(`  ${row}`);
	}

	// Summary line
	const parts: string[] = [`${summary.total_steps} steps`];
	if (summary.phases_completed.length > 0) {
		parts.push(`Phases completed: ${summary.phases_completed.length}`);
	}
	if (summary.total_cost_usd > 0) {
		parts.push(`Cost: ${formatCost(summary.total_cost_usd)}`);
	}
	if (summary.total_duration_ms > 0) {
		parts.push(`Duration: ${formatDuration(summary.total_duration_ms)}`);
	}

	console.log();
	console.log(`Summary: ${parts.join(" | ")}`);
}

/**
 * Human-readable text formatter for `run list` output.
 *
 * Column-aligned table with ID, Plan, Status, Steps, Created.
 * Truncates long plan paths with `...`.
 */
function formatListText(data: {
	runs: Array<{
		id: string;
		plan_path: string;
		status: string;
		step_count: number;
		created_at: string;
		updated_at: string;
	}>;
}): void {
	const { runs } = data;

	if (runs.length === 0) {
		console.log("(no runs)");
		return;
	}

	const MAX_PLAN_WIDTH = 50;

	function truncatePlan(path: string): string {
		if (path.length <= MAX_PLAN_WIDTH) return path;
		return `...${path.slice(-(MAX_PLAN_WIDTH - 3))}`;
	}

	// Format rows first to compute widths
	const rows = runs.map((r) => ({
		id: r.id,
		plan: truncatePlan(r.plan_path),
		status: r.status,
		steps: String(r.step_count),
		created: r.created_at.split("T")[0] ?? r.created_at,
	}));

	type ColDef = { header: string; key: keyof (typeof rows)[0]; width: number };
	const cols: ColDef[] = [
		{ header: "ID", key: "id", width: 2 },
		{ header: "Plan", key: "plan", width: 4 },
		{ header: "Status", key: "status", width: 6 },
		{ header: "Steps", key: "steps", width: 5 },
		{ header: "Created", key: "created", width: 7 },
	];

	for (const col of cols) {
		for (const row of rows) {
			col.width = Math.max(col.width, row[col.key].length);
		}
	}

	const headerLine = cols.map((c) => c.header.padEnd(c.width)).join("  ");
	console.log(headerLine);
	for (const row of rows) {
		const line = cols.map((c) => row[c.key].padEnd(c.width)).join("  ");
		console.log(line);
	}
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function runV1Init(params: RunInitParams): Promise<void> {
	// Phase 3b: resolve control-plane root for DB location.
	// `run init` from a linked worktree creates the run in the root DB.
	const controlPlane = resolveControlPlaneRoot();
	const projectRoot =
		controlPlane.mode !== "none"
			? controlPlane.controlPlaneRoot
			: resolveProjectRoot();
	const stateDir = controlPlane.stateDir;
	const lockOpts: LockDirOpts = { stateDir };

	// Load root config first for plan arg resolution (bare filename → plans dir).
	// Layered config is loaded below once the plan path is known.
	const rootResult = await loadConfig(projectRoot);
	const planPath = canonicalizePlanPath(
		resolvePlanArg(params.plan, rootResult.config.paths.plans),
	);

	// Phase 3b: plan-path validation — plan must be under controlPlaneRoot
	// (or projectRoot in none mode). This ensures stored plan_path values
	// are re-rootable into mapped worktrees.
	const relPath = relative(projectRoot, planPath);
	if (relPath.startsWith("..") || isAbsolute(relPath)) {
		outputError(
			"PLAN_OUTSIDE_CONTROL_PLANE",
			`Plan path \`${planPath}\` is outside the repository root \`${projectRoot}\`. Move the plan under the repository root.`,
			{
				plan_path: planPath,
				control_plane_root: projectRoot,
			},
		);
	}

	// Config resolution: use plan-path-anchored layering (Phase 1c) when
	// we have a control-plane root, so config is scoped to the plan's
	// sub-project context.
	let config: Awaited<ReturnType<typeof loadConfig>>["config"];
	let configPath: string | null = null;
	if (controlPlane.mode !== "none") {
		const contextDir = dirname(planPath);
		const result = await resolveLayeredConfig(projectRoot, contextDir);
		config = result.config;
		configPath = result.nearestConfigPath ?? result.rootConfigPath;
	} else {
		config = rootResult.config;
		configPath = rootResult.configPath;
	}

	const configuredPlansDir = resolveConfiguredPath(
		projectRoot,
		config.paths.plans,
	);
	if (!isPathUnder(planPath, configuredPlansDir)) {
		const configHint = configPath
			? ` Update \`${configPath}\` if this project should use a different plans directory.`
			: " Configure `[paths].plans` in `5x.toml` if this project should use a different plans directory.";
		outputError(
			"INVALID_ARGS",
			`Plan path \`${planPath}\` must be inside configured paths.plans directory \`${configuredPlansDir}\`.${configHint}`,
			{
				plan_path: planPath,
				configured_plans_dir: configuredPlansDir,
				config_path: configPath,
			},
		);
	}

	// Normalize db.path to directory semantics (backward compat: `.5x/5x.db` → `.5x`)
	const dbRelPath = join(normalizeDbPath(config.db.path), DB_FILENAME);
	const db = getDb(projectRoot, dbRelPath);
	runMigrations(db);

	const requestedWorktreePath =
		params.worktreePath && params.worktreePath.trim().length > 0
			? params.worktreePath
			: undefined;
	if (requestedWorktreePath && !params.worktree) {
		outputError("INVALID_ARGS", "--worktree-path requires --worktree", {
			worktree_path: requestedWorktreePath,
		});
	}

	// 1. Lock-first invariant: acquire plan lock before checking for active run
	// Phase 3c: pass stateDir to anchor locks under controlPlaneRoot/stateDir
	const lockResult = acquireLock(projectRoot, planPath, lockOpts);
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

	let lockCleanupRegistered = false;

	try {
		let worktreeResult: WorktreeInitResult | undefined;
		if (params.worktree) {
			worktreeResult = await ensureRunWorktree(
				db,
				projectRoot,
				planPath,
				requestedWorktreePath,
				config.worktree?.postCreate,
				stateDir,
			);
		}

		// 2. Check git safety (skip when --worktree: worktrees are isolated)
		if (!params.allowDirty && !params.worktree) {
			try {
				const safety = await checkGitSafety(projectRoot);
				if (!safety.safe) {
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

		// 3. Idempotent: return existing active run if one exists
		const existing = getActiveRunV1(db, planPath);
		if (existing) {
			registerLockCleanup(projectRoot, planPath, lockOpts);
			lockCleanupRegistered = true;
			outputSuccess({
				run_id: existing.id,
				plan_path: existing.plan_path,
				status: existing.status,
				created_at: existing.created_at,
				resumed: true,
				...(worktreeResult ? { worktree: worktreeResult } : {}),
				// Phase 4: top-level worktree context for downstream pipe consumers
				...deriveWorktreeContextFields(worktreeResult, planPath, projectRoot),
			});
			return;
		}

		// 4. Create new run
		const runId = generateRunId();
		createRunV1(db, {
			id: runId,
			planPath,
			configJson: JSON.stringify({
				maxStepsPerRun: getMaxStepsPerRun(
					config as unknown as Record<string, unknown>,
				),
			}),
		});

		registerLockCleanup(projectRoot, planPath, lockOpts);
		lockCleanupRegistered = true;

		const run = getRunV1(db, runId);
		outputSuccess({
			run_id: runId,
			plan_path: run?.plan_path ?? planPath,
			status: "active",
			created_at: run?.created_at ?? new Date().toISOString(),
			resumed: false,
			...(worktreeResult ? { worktree: worktreeResult } : {}),
			// Phase 4: top-level worktree context for downstream pipe consumers
			...deriveWorktreeContextFields(worktreeResult, planPath, projectRoot),
		});
	} catch (err) {
		if (!lockCleanupRegistered) {
			releaseLock(projectRoot, planPath, lockOpts);
		}
		throw err;
	}
}

export async function runV1State(params: RunStateParams): Promise<void> {
	const { config, db, controlPlane } = await resolveDbContext();

	// Resolve run by ID or plan path
	let run: RunRowV1 | null = null;
	if (params.run) {
		run = getRunV1(db, params.run);
	} else if (params.plan) {
		const planPath = canonicalizePlanPath(
			resolvePlanArg(params.plan, config.paths.plans),
		);
		run = getActiveRunV1(db, planPath);
	} else {
		outputError("INVALID_ARGS", "Either --run or --plan is required");
	}

	if (!run) {
		outputError("RUN_NOT_FOUND", "Run not found");
	}

	// Phase 3 fix: validate run-scoped context via shared resolver to honor
	// the fail-closed worktree contract. If the mapped worktree is missing,
	// fail with WORKTREE_MISSING instead of silently returning data from
	// the wrong checkout context.
	const controlPlaneRoot = controlPlane?.controlPlaneRoot;
	if (controlPlaneRoot) {
		const ctxResult = resolveRunExecutionContext(db, run.id, {
			controlPlaneRoot,
		});
		if (!ctxResult.ok) {
			outputError(ctxResult.error.code, ctxResult.error.message, {
				detail: ctxResult.error.detail,
			});
		}
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

	// Phase 3b: report worktree path when run has a mapped worktree
	const plan = run.plan_path ? getPlan(db, run.plan_path) : null;
	const worktreePath = plan?.worktree_path || null;

	outputSuccess(
		{
			run: {
				id: run.id,
				plan_path: run.plan_path,
				status: run.status,
				created_at: run.created_at,
				updated_at: run.updated_at,
				...(worktreePath ? { worktree_path: worktreePath } : {}),
			},
			steps: steps.map(formatStep),
			summary,
		},
		formatStateText,
	);
}

/**
 * Record a step in the database. Pure persistence — no stdout, no CliError.
 * Throws RecordError on validation failures (caller decides how to surface).
 *
 * When `dbContext` is provided, the caller's already-resolved DB/control-plane
 * is used instead of re-resolving via `resolveDbContext()`. This ensures the
 * step is recorded against the same database that the caller used for run
 * context resolution — critical for `5x commit` where re-discovery from cwd
 * could target the wrong control-plane.
 */
export async function recordStepInternal(
	params: RunRecordParams & { run: string; stepName: string; result: string },
	dbContext?: {
		db: Database;
		config: FiveXConfig;
		controlPlane?: ControlPlaneResult;
	},
): Promise<RecordStepResult> {
	const { config, db, controlPlane } = dbContext ?? (await resolveDbContext());

	// Verify run exists and is active
	const run = getRunV1(db, params.run);
	if (!run) {
		throw new RecordError("RUN_NOT_FOUND", `Run ${params.run} not found`);
	}
	if (run.status !== "active") {
		throw new RecordError(
			"RUN_NOT_ACTIVE",
			`Run ${params.run} is ${run.status}, not active`,
		);
	}

	// Phase 3 fix: validate run-scoped context via shared resolver to honor
	// the fail-closed worktree contract. Recording steps against a run with
	// a missing worktree is a drift risk — fail with WORKTREE_MISSING.
	const controlPlaneRoot = controlPlane?.controlPlaneRoot;
	if (controlPlaneRoot) {
		const ctxResult = resolveRunExecutionContext(db, params.run, {
			controlPlaneRoot,
		});
		if (!ctxResult.ok) {
			throw new RecordError(
				ctxResult.error.code,
				ctxResult.error.message,
				ctxResult.error.detail,
			);
		}
	}

	// Enforce maxStepsPerRun from live config (not the snapshot in config_json,
	// so users can bump the limit in 5x.toml without editing the database)
	const maxSteps = getMaxStepsPerRun(
		config as unknown as Record<string, unknown>,
	);

	const summary = computeRunSummary(db, params.run);
	if (summary.total_steps >= maxSteps) {
		throw new RecordError(
			"MAX_STEPS_EXCEEDED",
			`Run has reached the maximum of ${maxSteps} steps`,
			{ current_steps: summary.total_steps, max_steps: maxSteps },
		);
	}

	// Validate JSON
	try {
		JSON.parse(params.result);
	} catch {
		throw new RecordError("INVALID_JSON", "--result must be valid JSON", {
			raw: params.result.slice(0, 200),
		});
	}

	const dbResult = recordStep(db, {
		run_id: params.run,
		step_name: params.stepName,
		phase: params.phase,
		iteration: params.iteration,
		result_json: params.result,
		session_id: params.sessionId,
		model: params.model,
		tokens_in: params.tokensIn,
		tokens_out: params.tokensOut,
		cost_usd: params.costUsd,
		duration_ms: params.durationMs,
		log_path: params.logPath,
	});

	return {
		step_id: dbResult.step_id,
		step_name: dbResult.step_name,
		phase: dbResult.phase,
		iteration: dbResult.iteration,
		recorded: dbResult.recorded,
	};
}

export async function runV1Record(params: RunRecordParams): Promise<void> {
	// Track whether --result - was specified (consumes stdin for raw result)
	const rawResult = params.result;
	const stdinConsumedByResult = rawResult === "-";

	// Resolve raw --result first (existing behavior: "-" for stdin, "@path" for file)
	if (params.result) {
		params.result = await readResultJson(params.result);
	}

	// If stdin is piped and not consumed by --result -, parse upstream envelope
	if (!stdinConsumedByResult && isStdinPiped()) {
		const upstream = await readUpstreamEnvelope();
		if (upstream) {
			const ctx = extractPipeContext(upstream.data);
			const invoke = extractInvokeMetadata(upstream.data);

			// Auto-populate from pipe context (CLI flags take precedence via ??=)
			params.run ??= ctx.runId;
			params.stepName ??= ctx.stepName;
			params.phase ??= ctx.phase;

			if (invoke) {
				// Invoke envelope: extract result + all metadata
				params.result ??= JSON.stringify(invoke.result);
				params.sessionId ??= invoke.sessionId;
				params.model ??= invoke.model;
				params.durationMs ??= invoke.durationMs;
				params.tokensIn ??= invoke.tokensIn;
				params.tokensOut ??= invoke.tokensOut;
				params.costUsd ??= invoke.costUsd;
				params.logPath ??= invoke.logPath;
			} else {
				// Non-invoke envelope: use full data as result JSON
				params.result ??= JSON.stringify(upstream.data);
			}
		}
	}

	// Validate required params are now resolved (after merge)
	if (!params.run) {
		outputError(
			"INVALID_ARGS",
			"--run is required (provide it or pipe from an upstream command)",
		);
	}
	if (!params.stepName) {
		outputError(
			"INVALID_ARGS",
			"Step name is required (provide it as a positional arg or pipe from invoke)",
		);
	}
	if (!params.result) {
		outputError(
			"INVALID_ARGS",
			"--result is required (provide it or pipe from an upstream command)",
		);
	}

	try {
		const result = await recordStepInternal({
			...params,
			run: params.run,
			stepName: params.stepName,
			result: params.result,
		});
		outputSuccess(result);
	} catch (err) {
		if (err instanceof RecordError) {
			outputError(
				err.code,
				err.message,
				err.detail,
				exitCodeForError(err.code),
			);
		}
		throw err;
	}
}

export async function runV1Complete(params: RunCompleteParams): Promise<void> {
	const { projectRoot, db, controlPlane } = await resolveDbContext();
	const lockOpts: LockDirOpts = { stateDir: controlPlane?.stateDir };

	const run = getRunV1(db, params.run);
	if (!run) {
		outputError("RUN_NOT_FOUND", `Run ${params.run} not found`);
	}

	// Phase 3 fix: validate run-scoped context via shared resolver to honor
	// the fail-closed worktree contract. Completing a run with a missing
	// worktree means the run's state may be inconsistent.
	const controlPlaneRoot = controlPlane?.controlPlaneRoot;
	if (controlPlaneRoot) {
		const ctxResult = resolveRunExecutionContext(db, params.run, {
			controlPlaneRoot,
		});
		if (!ctxResult.ok) {
			outputError(ctxResult.error.code, ctxResult.error.message, {
				detail: ctxResult.error.detail,
			});
		}
	}

	const status = params.status ?? "completed";
	if (status !== "completed" && status !== "aborted") {
		outputError("INVALID_STATUS", '--status must be "completed" or "aborted"');
	}

	// Enforce lock ownership: the plan must either be unlocked, locked by us,
	// or locked by a dead process. If another live PID holds the lock, refuse.
	// Phase 3b: pass stateDir to isLocked for correct lock directory resolution
	if (run.plan_path) {
		const lockStatus = isLocked(projectRoot, run.plan_path, lockOpts);
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
	// Phase 3b: pass stateDir to releaseLock
	if (run.plan_path) {
		releaseLock(projectRoot, run.plan_path, lockOpts);
	}

	outputSuccess({
		run_id: params.run,
		status,
		reason: params.reason ?? null,
	});
}

export async function runV1Reopen(params: RunReopenParams): Promise<void> {
	const { projectRoot, db, controlPlane } = await resolveDbContext();
	const lockOpts: LockDirOpts = { stateDir: controlPlane?.stateDir };

	const run = getRunV1(db, params.run);
	if (!run) {
		outputError("RUN_NOT_FOUND", `Run ${params.run} not found`);
	}

	// Phase 3 fix: validate run-scoped context via shared resolver to honor
	// the fail-closed worktree contract. Reopening a run with a missing
	// worktree should fail rather than allow drift.
	const controlPlaneRoot = controlPlane?.controlPlaneRoot;
	if (controlPlaneRoot) {
		const ctxResult = resolveRunExecutionContext(db, params.run, {
			controlPlaneRoot,
		});
		if (!ctxResult.ok) {
			outputError(ctxResult.error.code, ctxResult.error.message, {
				detail: ctxResult.error.detail,
			});
		}
	}

	if (run.status === "active") {
		outputError("RUN_ALREADY_ACTIVE", `Run ${params.run} is already active`);
	}

	// Enforce lock ownership: if the plan is locked by another live PID, refuse.
	// Phase 3b: pass stateDir to isLocked for correct lock directory resolution
	if (run.plan_path) {
		const lockStatus = isLocked(projectRoot, run.plan_path, lockOpts);
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
	const { config, db } = await resolveDbContext();

	const runs = listRuns(db, {
		planPath: params.plan
			? canonicalizePlanPath(resolvePlanArg(params.plan, config.paths.plans))
			: undefined,
		status: params.status,
		limit: params.limit,
	});

	outputSuccess(
		{
			runs: runs.map((r) => ({
				id: r.id,
				plan_path: r.plan_path,
				status: r.status,
				created_at: r.created_at,
				updated_at: r.updated_at,
				step_count: r.step_count,
			})),
		},
		formatListText,
	);
}

// ---------------------------------------------------------------------------
// Relink
// ---------------------------------------------------------------------------

function formatRelinkText(data: Record<string, unknown>): void {
	const changes = data.changes as Record<
		string,
		{ old: string | null; new: string | null }
	>;
	console.log(`Run ${data.run_id}:`);
	if (changes.plan) {
		console.log(
			`  plan:     ${changes.plan.old ?? "(none)"} → ${changes.plan.new}`,
		);
	}
	if (changes.worktree) {
		console.log(
			`  worktree: ${changes.worktree.old ?? "(none)"} → ${changes.worktree.new}`,
		);
	}
}

export async function runV1Relink(params: RunRelinkParams): Promise<void> {
	if (params.plan === undefined && params.worktree === undefined) {
		outputError(
			"RELINK_NO_OPTIONS",
			"At least one of --plan or --worktree must be provided",
		);
	}

	const cwd = resolve(".");
	const { db, config } = await resolveDbContext({
		startDir: cwd,
		contextDir: cwd,
	});

	const run = getRunV1(db, params.run);
	if (!run) {
		outputError("RUN_NOT_FOUND", `Run ${params.run} not found`);
	}

	const changes: Record<string, { old: string | null; new: string | null }> =
		{};
	let effectivePlanPath = run.plan_path;

	// ── Plan relink ──────────────────────────────────────────────────
	if (params.plan !== undefined) {
		let newPlanPath: string;

		if (params.plan === true) {
			// Auto-search: find file with same basename in config.paths.plans
			const filename = basename(run.plan_path);
			const candidate = join(config.paths.plans, filename);
			if (!existsSync(candidate)) {
				outputError(
					"PLAN_NOT_FOUND",
					`Could not find ${filename} in ${config.paths.plans}`,
					{ searched: candidate },
				);
			}
			newPlanPath = candidate;
		} else {
			newPlanPath = resolvePlanArg(params.plan, config.paths.plans);
		}

		if (!existsSync(newPlanPath)) {
			outputError("PLAN_NOT_FOUND", `Plan file not found: ${newPlanPath}`, {
				plan_path: newPlanPath,
			});
		}

		// Validate plan parses correctly
		try {
			const markdown = readFileSync(newPlanPath, "utf-8");
			parsePlan(markdown);
		} catch (err) {
			outputError(
				"INVALID_PLAN",
				`File does not parse as a valid plan: ${newPlanPath}`,
				{
					plan_path: newPlanPath,
					detail: err instanceof Error ? err.message : String(err),
				},
			);
		}

		const canonical = canonicalizePlanPath(newPlanPath);
		const oldPlanPath = run.plan_path;
		updateRunPlanPath(db, params.run, canonical);
		upsertPlan(db, { planPath: canonical });
		effectivePlanPath = canonical;

		changes.plan = { old: oldPlanPath, new: canonical };
	}

	// ── Worktree relink ──────────────────────────────────────────────
	if (params.worktree !== undefined) {
		const newWorktreePath = resolve(params.worktree);
		if (!existsSync(newWorktreePath)) {
			outputError(
				"WORKTREE_NOT_FOUND",
				`Worktree path not found: ${newWorktreePath}`,
				{ path: newWorktreePath },
			);
		}

		const plan = getPlan(db, effectivePlanPath);
		const oldWorktreePath = plan?.worktree_path ?? null;
		upsertPlan(db, {
			planPath: effectivePlanPath,
			worktreePath: newWorktreePath,
		});

		changes.worktree = { old: oldWorktreePath, new: newWorktreePath };
	}

	// Fetch final state for output
	const updatedRun = getRunV1(db, params.run) as NonNullable<
		ReturnType<typeof getRunV1>
	>;
	const updatedPlan = getPlan(db, effectivePlanPath);

	outputSuccess(
		{
			run_id: params.run,
			plan_path: updatedRun.plan_path,
			worktree_path: updatedPlan?.worktree_path ?? null,
			changes,
		},
		formatRelinkText,
	);
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
	pollInterval?: number;
}

export async function runV1Watch(params: RunWatchParams): Promise<void> {
	validateRunId(params.run);

	// Validate run exists — try DB first, fall back to log dir existence
	const { projectRoot, db, controlPlane } = await resolveDbContext({
		startDir: params.workdir,
	});
	const run = getRunV1(db, params.run);
	// Phase 3b: re-anchor log path to controlPlaneRoot/stateDir
	const stateDir = controlPlane?.stateDir ?? ".5x";
	const logDir = join(projectRoot, stateDir, "logs", params.run);

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

	// Phase 3 fix: validate run-scoped context via shared resolver to honor
	// the fail-closed worktree contract. Watching logs from a run with a
	// missing worktree is misleading — fail with WORKTREE_MISSING.
	if (run) {
		const controlPlaneRoot = controlPlane?.controlPlaneRoot;
		if (controlPlaneRoot) {
			const ctxResult = resolveRunExecutionContext(db, params.run, {
				controlPlaneRoot,
				explicitWorkdir: params.workdir ? resolve(params.workdir) : undefined,
			});
			if (!ctxResult.ok) {
				outputError(ctxResult.error.code, ctxResult.error.message, {
					detail: ctxResult.error.detail,
				});
			}
		}
	}

	// Ensure log dir exists with restricted permissions (run may have been init'd but no invoke yet)
	mkdirSync(logDir, { recursive: true, mode: 0o700 });

	// Warn if an existing log dir has overly-permissive mode (e.g., manually created without 0o700).
	// Unix stat bits are not meaningful for this check on Windows.
	if (process.platform !== "win32") {
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
	}

	// Set up abort on SIGINT
	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.on("SIGINT", onSigint);

	const tailer = new NdjsonTailer({
		dir: logDir,
		signal: controller.signal,
		startAtEnd: params.noReplay,
		pollInterval: params.pollInterval,
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
