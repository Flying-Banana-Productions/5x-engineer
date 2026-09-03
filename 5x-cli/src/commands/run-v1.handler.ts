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
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
	type FiveXConfig,
	loadConfig,
	resolveLayeredConfig,
} from "../config.js";
import {
	type AppendOp,
	type RecordLine,
	type RecordOrigin,
	type RecordPerformer,
	type RecordRecorder,
	type RecordStore,
	RecordStoreError,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	redactStepPayload,
	type StepRecordPayload,
	stepIdempotencyKey,
} from "../control-plane/index.js";
import {
	decodeJsonlFile,
	parseRunJson,
} from "../control-plane/record-layout.js";
import type {
	PreparedRecordStep,
	PrepareRecordStepOutcome,
} from "../control-plane/record-writer-types.js";
import { getDb } from "../db/connection.js";
import { getPlan, upsertPlan } from "../db/operations.js";
import {
	completeRun,
	computeRunSummary,
	createRunV1,
	findExistingStep,
	getActiveRunV1,
	getRunV1,
	getSteps,
	listRuns,
	nextIteration,
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
	commitFiles,
	computeDiffSummary,
	computePatchId,
	createWorktree,
	getLatestCommit,
	gitLsTreePaths,
	gitShowFile,
	isBranchRelevant,
	listChangedFiles,
	listWorktrees,
	runWorktreeSetupCommand,
} from "../git.js";
import { emitFreshnessWarnings } from "../harnesses/freshness.js";
import type { FreshnessReport } from "../harnesses/manifest.js";
import {
	acquireLock,
	isLocked,
	type LockDirOpts,
	type LockInfo,
	registerLockCleanup,
	releaseLock,
} from "../lock.js";
import {
	CliError,
	exitCodeForError,
	formatGenericText,
	getOutputFormat,
	outputError,
	outputSuccess,
} from "../output.js";
import { parsePlan } from "../parsers/plan.js";
import {
	canonicalizePlanPath,
	isPathUnder,
	planSlugFromPath,
	realpathExisting,
	relativePathUnder,
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
import { resolveRecordPerformer } from "../records/origin.js";
import { resolveRecordsRoot } from "../records/paths.js";
import {
	envelopeFromProgress,
	fetchFiveXWithWarnings,
	formatProgressSourceLine,
	resolvePlanProgress,
} from "../records/resolve.js";
import { generateRunId, validateRunId } from "../run-id.js";
import { NdjsonTailer } from "../utils/ndjson-tailer.js";
import { StreamWriter } from "../utils/stream-writer.js";
import { version } from "../version.js";
import { resolveDbContext } from "./context.js";
import {
	type ControlPlaneResult,
	controlPlaneDbPath,
	normalizeDbPath,
	resolveControlPlaneRoot,
} from "./control-plane.js";
import { createRecordContext, RecordContextError } from "./record-context.js";
import { resolveRunExecutionContext } from "./run-context.js";
import {
	type AmbientRunResult,
	type AmbientRunSource,
	requireAmbientRunId,
	resolveAmbientRunId,
} from "./run-identity.js";
import {
	clearPointerIfMatch,
	currentRunPath,
	writePointer,
} from "./run-pointer.js";

export type { PreparedRecordStep, PrepareRecordStepOutcome };

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
	startDir?: string;
	env?: NodeJS.Dict<string>;
	fetch?: boolean;
	allRefs?: boolean;
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
	startDir?: string;
	env?: NodeJS.Dict<string>;
	/**
	 * Who performed this step. Callers that know (invoke, protocol with role)
	 * MUST pass this. Omitted → `resolveRecordPerformer` default
	 * `{ kind: "system", role: "cli" }` except `human:*` steps.
	 * Never inferred from Git, OS username, or hostname.
	 */
	performer?: RecordPerformer;
}

export interface RunCompleteParams {
	run?: string;
	status?: "completed" | "aborted";
	reason?: string;
	startDir?: string;
	env?: NodeJS.Dict<string>;
}

export interface RunReopenParams {
	run?: string;
	startDir?: string;
	env?: NodeJS.Dict<string>;
}

export interface RunListParams {
	plan?: string;
	status?: string;
	limit?: number;
	startDir?: string;
	env?: NodeJS.Dict<string>;
}

/** Ambient sources `run list` may advertise. `flag` / `pipe` are never used here. */
export type ListAmbientSource = "environment" | "worktree" | "pointer";

const LIST_FOCUS_LABEL: Record<ListAmbientSource, string> = {
	environment: "env",
	worktree: "worktree",
	pointer: "pointer",
};

export interface ListRunRow {
	id: string;
	plan_path: string;
	status: string;
	created_at: string;
	updated_at: string;
	step_count: number;
	ambient?: true;
	ambient_source?: ListAmbientSource;
}

function isListAmbientSource(
	source: AmbientRunSource,
): source is ListAmbientSource {
	return (
		source === "environment" || source === "worktree" || source === "pointer"
	);
}

/**
 * Stamp the ambiently focused run (if listed). Resolution failures and
 * `source: "none"` leave the payload unmarked — list itself still succeeds.
 */
export function applyAmbientListMarker(
	runs: ListRunRow[],
	ambient: AmbientRunResult,
): ListRunRow[] {
	if (!ambient.ok || !ambient.runId || !isListAmbientSource(ambient.source)) {
		return runs;
	}
	const focused = runs.find((r) => r.id === ambient.runId);
	if (!focused) return runs;
	focused.ambient = true;
	focused.ambient_source = ambient.source;
	return runs;
}

export interface RunRelinkParams {
	run?: string;
	plan?: string | true; // path, or true for auto-search by filename
	worktree?: string;
	startDir?: string;
	env?: NodeJS.Dict<string>;
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
	/** Post-insert step count (idempotent re-records report the true total). */
	total_steps: number;
}

export interface RecordStepContext {
	db: Database;
	config: FiveXConfig;
	controlPlane?: ControlPlaneResult;
	recordStore?: RecordStore;
	originFor?: (performer: RecordPerformer) => RecordOrigin;
	redactedRecorder?: () => RecordRecorder;
}

function storeGetLine(
	recordStore: RecordStore,
	runId: string,
	stream: "steps" | "decisions" | "budget",
	idempotencyKey: string,
): RecordLine | null {
	try {
		return recordStore.getLine(runId, stream, idempotencyKey);
	} catch (err) {
		if (err instanceof RecordStoreError && err.code === "RUN_NOT_FOUND") {
			return null;
		}
		throw err;
	}
}

function storeListLines(
	recordStore: RecordStore,
	runId: string,
	stream: "steps" | "decisions" | "budget",
): RecordLine[] {
	try {
		return recordStore.listLines(runId, stream);
	} catch (err) {
		if (err instanceof RecordStoreError && err.code === "RUN_NOT_FOUND") {
			return [];
		}
		throw err;
	}
}

function maxStoreIteration(
	lines: RecordLine[],
	stepName: string,
	phase: string | undefined,
): number | null {
	const phaseVal = phase ?? null;
	let max: number | null = null;
	for (const line of lines) {
		const payload = line.payload as Partial<StepRecordPayload> | null;
		if (!payload || typeof payload !== "object") continue;
		if (payload.step_name !== stepName) continue;
		if ((payload.phase ?? null) !== phaseVal) continue;
		if (typeof payload.iteration === "number") {
			if (max === null || payload.iteration > max) max = payload.iteration;
		}
	}
	return max;
}

function lastHeadCommit(lines: RecordLine[]): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		const payload = lines[i]?.payload as Partial<StepRecordPayload> | undefined;
		if (typeof payload?.head_commit === "string" && payload.head_commit) {
			return payload.head_commit;
		}
	}
	return undefined;
}

function parseConfigJson(raw: string | null): unknown {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

function copyPerformer(performer: RecordPerformer): RecordPerformer {
	const out: RecordPerformer = { kind: performer.kind };
	if (performer.role !== undefined) out.role = performer.role;
	if (performer.provider !== undefined) out.provider = performer.provider;
	return out;
}

function parseStepPayload(payload: unknown): StepRecordPayload | null {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return null;
	}
	const p = payload as Partial<StepRecordPayload>;
	if (typeof p.step_name !== "string" || typeof p.iteration !== "number") {
		return null;
	}
	return p as StepRecordPayload;
}

function rethrowAsRecordError(err: unknown): never {
	if (err instanceof RecordError) throw err;
	if (err instanceof RecordContextError) {
		throw new RecordError(err.code, err.message, err.detail);
	}
	if (err instanceof RecordStoreError) {
		throw new RecordError(err.code, err.message);
	}
	throw err;
}

function ensureRunRecord(
	recordStore: RecordStore,
	run: RunRowV1,
	originFor: (performer: RecordPerformer) => RecordOrigin,
): void {
	if (recordStore.getRun(run.id) !== null) return;
	recordStore.putRun({
		id: run.id,
		plan_path: run.plan_path,
		config_json: parseConfigJson(run.config_json),
		created_at: run.created_at,
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: version,
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: null,
		materializer: originFor({ kind: "system", role: "exporter" }),
	});
}

async function resolveRecordWriter(
	params: { run: string; startDir?: string },
	dbContext?: RecordStepContext,
): Promise<{
	db: Database;
	config: FiveXConfig;
	controlPlane?: ControlPlaneResult;
	recordStore: RecordStore;
	originFor: (performer: RecordPerformer) => RecordOrigin;
	redactedRecorder: () => RecordRecorder;
}> {
	if (
		dbContext?.recordStore &&
		dbContext.originFor &&
		dbContext.redactedRecorder
	) {
		return {
			db: dbContext.db,
			config: dbContext.config,
			controlPlane: dbContext.controlPlane,
			recordStore: dbContext.recordStore,
			originFor: dbContext.originFor,
			redactedRecorder: dbContext.redactedRecorder,
		};
	}
	if (dbContext?.recordStore && dbContext.originFor) {
		const originFor = dbContext.originFor;
		return {
			db: dbContext.db,
			config: dbContext.config,
			controlPlane: dbContext.controlPlane,
			recordStore: dbContext.recordStore,
			originFor,
			redactedRecorder: () =>
				originFor({ kind: "system", role: "cli" }).recorder,
		};
	}
	try {
		const ctx = await createRecordContext({
			runId: params.run,
			startDir: params.startDir,
			dbContext: dbContext
				? {
						projectRoot:
							dbContext.controlPlane?.controlPlaneRoot ?? process.cwd(),
						db: dbContext.db,
						config: dbContext.config,
						controlPlane: dbContext.controlPlane,
					}
				: undefined,
		});
		return {
			db: dbContext?.db ?? ctx.db,
			config: dbContext?.config ?? ctx.config,
			controlPlane: dbContext?.controlPlane ?? ctx.controlPlane,
			recordStore: ctx.recordStore,
			originFor: ctx.originFor,
			redactedRecorder: ctx.redactedRecorder,
		};
	} catch (err) {
		rethrowAsRecordError(err);
	}
}

async function writeRunRecordOnInit(opts: {
	db: Database;
	config: FiveXConfig;
	controlPlane?: ControlPlaneResult;
	projectRoot: string;
	run: RunRowV1;
	resume: boolean;
}): Promise<void> {
	let ctx: Awaited<ReturnType<typeof createRecordContext>>;
	try {
		ctx = await createRecordContext({
			runId: opts.run.id,
			dbContext: {
				projectRoot: opts.projectRoot,
				db: opts.db,
				config: opts.config,
				controlPlane: opts.controlPlane,
			},
		});
	} catch (err) {
		if (err instanceof RecordContextError) {
			outputError(err.code, err.message, err.detail);
		}
		throw err;
	}

	const existing = ctx.recordStore.getRun(opts.run.id);
	if (opts.resume) {
		if (existing && existing.format_version > RUN_RECORD_FORMAT_VERSION) {
			return;
		}
		if (existing?.sealed_at) return;
		if (existing) return;
		ctx.recordStore.putRun({
			id: opts.run.id,
			plan_path: opts.run.plan_path,
			config_json: parseConfigJson(opts.run.config_json),
			created_at: opts.run.created_at,
			sealed_at: null,
			status: "active",
			final_head_commit: null,
			cli_version: version,
			format_version: RUN_RECORD_FORMAT_VERSION,
			creator: null,
			materializer: ctx.originFor({ kind: "system", role: "exporter" }),
		});
		return;
	}

	ctx.recordStore.putRun({
		id: opts.run.id,
		plan_path: opts.run.plan_path,
		config_json: {
			maxStepsPerRun: getMaxStepsPerRun(
				opts.config as unknown as Record<string, unknown>,
			),
		},
		created_at: opts.run.created_at,
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: version,
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: ctx.redactedRecorder(),
	});
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

/** Fixed v2 warning band — not configurable (203 plan-input assumption). */
export const STEP_WARNING_RATIO = 0.8;

export interface StepBudget {
	used: number;
	max: number;
	remaining: number;
}

export function computeStepBudget(used: number, max: number): StepBudget {
	return { used, max, remaining: Math.max(0, max - used) };
}

export function stepBudgetWarning(budget: StepBudget): string | undefined {
	if (budget.max <= 0) return undefined;
	if (budget.used / budget.max < STEP_WARNING_RATIO) return undefined;
	return `Approaching maxStepsPerRun (${budget.used}/${budget.max}); raise maxStepsPerRun or split the work.`;
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

	// Derive worktree-relative plan path and include only if the file exists.
	const relPlanPath = relativePathUnder(planPath, controlPlaneRoot);
	if (relPlanPath !== null) {
		const worktreePlanPath = join(worktreeResult.worktree_path, relPlanPath);
		if (existsSync(worktreePlanPath)) {
			fields.worktree_plan_path = worktreePlanPath;
		}
	}

	return fields;
}

/**
 * Additive JSON fields for stale harness installs (201-harness-freshness §2.4).
 *
 * Returns `{}` when nothing is stale, so the common-case envelope is byte-identical
 * to the pre-freshness one. `warnings` and `harness_freshness` are purely additive:
 * no existing field changes type or disappears.
 */
function harnessFreshnessFields(
	stale: FreshnessReport[],
): Record<string, unknown> {
	if (stale.length === 0) return {};
	return {
		warnings: stale.map(
			(r) => `${r.harness} (${r.scope}) assets are ${r.status}`,
		),
		harness_freshness: stale.map((r) => ({
			harness: r.harness,
			scope: r.scope,
			status: r.status,
			reason: r.reason,
		})),
	};
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
		const absPath = realpathExisting(explicitPath);
		const match = gitWorktrees.find(
			(w) => realpathExisting(w.path) === absPath,
		);
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
		const existingPath = realpathExisting(existing.worktree_path);
		const match = gitWorktrees.find(
			(w) => realpathExisting(w.path) === existingPath,
		);
		if (match) {
			return {
				action: "reused",
				worktree_path: match.path,
				branch: match.branch,
			};
		}
	}

	const expectedBranch = branchNameFromPlan(planPath);
	const cwd = realpathExisting(".");
	const cwdWorktree = gitWorktrees.find(
		(w) => realpathExisting(w.path) === cwd,
	);
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

	const physicalWtPath = realpathExisting(wtPath);
	const existingByPath = gitWorktrees.find(
		(w) => realpathExisting(w.path) === physicalWtPath,
	);
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
export function formatStateText(data: {
	run: {
		id: string;
		plan_path: string;
		status: string;
		created_at: string;
		updated_at: string;
		worktree_path?: string;
	};
	steps: Array<{
		id?: number | null;
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
	steps_used: number;
	max_steps: number;
	steps_remaining: number;
	source?: string;
	source_ref?: string;
	source_age_seconds?: number;
}): void {
	const { run, steps, summary } = data;

	const sourceLine =
		typeof data.source === "string"
			? formatProgressSourceLine({
					kind:
						data.source === "worktree"
							? "worktree"
							: data.source === "HEAD"
								? "HEAD"
								: data.source === "diverged"
									? "diverged"
									: "remote",
					label: data.source,
					age_seconds: data.source_age_seconds,
				})
			: null;
	if (sourceLine) console.log(sourceLine);

	// Header
	console.log(`Run:     ${run.id}`);
	console.log(`Plan:    ${run.plan_path}`);
	console.log(`Status:  ${run.status}`);
	console.log(`Created: ${run.created_at}`);
	console.log(
		`Steps:   ${data.steps_used} / ${data.max_steps} (${data.steps_remaining} remaining)`,
	);

	if (steps.length === 0) {
		console.log();
		console.log("Steps: (none)");
		return;
	}

	// Determine which optional columns have data
	const hasId = steps.some((s) => s.id != null);
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
	const cols: Col[] = [];
	if (hasId) {
		cols.push({
			header: "#",
			width: 1,
			get: (s) => (s.id != null ? String(s.id) : ""),
		});
	}
	cols.push({ header: "Step", width: 4, get: (s) => s.step_name });
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
 * Text formatter for `run record`. Omits `step_budget` / `warnings` so they
 * stay off stdout (warnings go to stderr in text mode; JSON keeps them).
 */
function formatRecordText(
	data: RecordStepResult & {
		step_budget?: StepBudget;
		warnings?: string[];
	},
): void {
	const { step_budget: _budget, warnings: _warnings, ...rest } = data;
	formatGenericText(rest);
}

/**
 * Human-readable text formatter for `run list` output.
 *
 * Column-aligned table with Focus, ID, Plan, Status, Steps, Created.
 * Truncates long plan paths with `...`.
 */
function formatListText(data: { runs: ListRunRow[] }): void {
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
		focus:
			r.ambient && r.ambient_source ? LIST_FOCUS_LABEL[r.ambient_source] : "",
		id: r.id,
		plan: truncatePlan(r.plan_path),
		status: r.status,
		steps: String(r.step_count),
		created: r.created_at.split("T")[0] ?? r.created_at,
	}));

	type ColDef = { header: string; key: keyof (typeof rows)[0]; width: number };
	const cols: ColDef[] = [
		{ header: "Focus", key: "focus", width: 5 },
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

/**
 * Additive PLAN_LOCKED detail: keep pid / started_at, add nested holder,
 * stale: false, and a remediation naming `5x unlock <plan> --force`.
 */
export function planLockedDetail(
	planPath: string,
	lock: LockInfo,
): Record<string, unknown> {
	return {
		pid: lock.pid,
		started_at: lock.startedAt,
		holder: { pid: lock.pid, startedAt: lock.startedAt },
		stale: false,
		remediation: `If this process is hung, run \`5x unlock ${planPath} --force\`.`,
	};
}

// ---------------------------------------------------------------------------
// Focus pointer
// ---------------------------------------------------------------------------

function exportHint(runId: string): string {
	return `export FIVEX_RUN=${runId}`;
}

/** Write the local focus pointer. Fail the command on I/O errors. */
function writeFocusPointer(
	projectRoot: string,
	stateDir: string,
	runId: string,
): void {
	const path = currentRunPath(projectRoot, stateDir);
	try {
		writePointer(path, runId);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		outputError(
			"RUN_POINTER_WRITE_FAILED",
			`Failed to write focus pointer: ${msg}`,
			{
				path,
				run_id: runId,
			},
		);
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
	const rootResult = await loadConfig(
		projectRoot,
		undefined,
		undefined,
		projectRoot,
	);
	const planPath = canonicalizePlanPath(
		resolvePlanArg(params.plan, rootResult.config.paths.plans),
	);

	// Phase 3b: plan-path validation — plan must be under controlPlaneRoot
	// (or projectRoot in none mode). This ensures stored plan_path values
	// are re-rootable into mapped worktrees.
	if (!isPathUnder(planPath, projectRoot)) {
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

	// Effective state root for both the DB and the focus pointer.
	// Managed/isolated: controlPlane.stateDir (already the configured root).
	// None mode: controlPlane.stateDir is the default `.5x` even when config
	// overrides db.path, so use the configured path — otherwise a first-use
	// absolute db.path would write 5x.db at the configured root and
	// current-run under the checkout `.5x`.
	const stateDirForDb =
		controlPlane.mode !== "none"
			? controlPlane.stateDir
			: normalizeDbPath(config.db.path);
	const db = getDb(projectRoot, controlPlaneDbPath(projectRoot, stateDirForDb));
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
		const existing = lockResult.existingLock;
		if (!existing) {
			outputError("PLAN_LOCKED", "Plan is locked");
		}
		outputError(
			"PLAN_LOCKED",
			`Plan is locked by PID ${existing.pid}`,
			planLockedDetail(planPath, existing),
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
				const recordsRoot = resolveRecordsRoot({
					recordsConfigAbs: config.paths.records,
					controlPlaneRoot: projectRoot,
					effectiveWorkdir: projectRoot,
				});
				const safety = await checkGitSafety(projectRoot, {
					exemptRoots: [recordsRoot.recordsAbsPath],
				});
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

		// 2b. Harness freshness fire point (201-harness-freshness §2.4). Tier 1
		// only, once per `run init`, before any work is delegated. Anchored to the
		// plan's directory because that is the context config was resolved from
		// above — using cwd would compare against the wrong context in a monorepo
		// and report a spurious `context-mismatch`.
		//
		// `emitFreshnessWarnings` swallows its own failures: a broken freshness
		// check must never block run creation.
		const staleHarnesses = await emitFreshnessWarnings({
			startDir: dirname(planPath),
		});
		const freshnessFields = harnessFreshnessFields(staleHarnesses);

		// 3. Idempotent: return existing active run if one exists
		const existing = getActiveRunV1(db, planPath);
		if (existing) {
			await writeRunRecordOnInit({
				db,
				config,
				controlPlane: controlPlane.mode !== "none" ? controlPlane : undefined,
				projectRoot,
				run: existing,
				resume: true,
			});
			writeFocusPointer(projectRoot, stateDirForDb, existing.id);
			registerLockCleanup(projectRoot, planPath, lockOpts);
			lockCleanupRegistered = true;
			outputSuccess({
				run_id: existing.id,
				plan_path: existing.plan_path,
				status: existing.status,
				created_at: existing.created_at,
				resumed: true,
				export_hint: exportHint(existing.id),
				...(worktreeResult ? { worktree: worktreeResult } : {}),
				// Phase 4: top-level worktree context for downstream pipe consumers
				...deriveWorktreeContextFields(worktreeResult, planPath, projectRoot),
				...freshnessFields,
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

		writeFocusPointer(projectRoot, stateDirForDb, runId);
		registerLockCleanup(projectRoot, planPath, lockOpts);
		lockCleanupRegistered = true;

		const run = getRunV1(db, runId);
		if (run) {
			await writeRunRecordOnInit({
				db,
				config,
				controlPlane: controlPlane.mode !== "none" ? controlPlane : undefined,
				projectRoot,
				run,
				resume: false,
			});
		}
		outputSuccess({
			run_id: runId,
			plan_path: run?.plan_path ?? planPath,
			status: "active",
			created_at: run?.created_at ?? new Date().toISOString(),
			resumed: false,
			export_hint: exportHint(runId),
			...(worktreeResult ? { worktree: worktreeResult } : {}),
			// Phase 4: top-level worktree context for downstream pipe consumers
			...deriveWorktreeContextFields(worktreeResult, planPath, projectRoot),
			...freshnessFields,
		});
	} catch (err) {
		if (!lockCleanupRegistered) {
			releaseLock(projectRoot, planPath, lockOpts);
		}
		throw err;
	}
}

function stringifyResultJson(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return "null";
	}
}

function formatGitRecordStep(line: RecordLine) {
	const payload = (line.payload ?? {}) as Partial<StepRecordPayload>;
	return {
		step_name: typeof payload.step_name === "string" ? payload.step_name : "",
		phase: payload.phase ?? null,
		iteration: payload.iteration ?? null,
		result_json: stringifyResultJson(payload.result_json),
		model: payload.model ?? null,
		tokens_in: payload.tokens_in ?? null,
		tokens_out: payload.tokens_out ?? null,
		cost_usd: payload.cost_usd ?? null,
		duration_ms: payload.duration_ms ?? null,
		created_at: line.createdAt,
	};
}

function summaryFromGitSteps(
	steps: ReturnType<typeof formatGitRecordStep>[],
): ReturnType<typeof computeRunSummary> {
	const phases = [
		...new Set(
			steps
				.filter((s) => s.step_name === "phase:complete" && s.phase)
				.map((s) => s.phase as string),
		),
	];
	return {
		total_steps: steps.length,
		phases_completed: phases,
		total_tokens_in: steps.reduce((n, s) => n + (s.tokens_in ?? 0), 0),
		total_tokens_out: steps.reduce((n, s) => n + (s.tokens_out ?? 0), 0),
		total_cost_usd: steps.reduce((n, s) => n + (s.cost_usd ?? 0), 0),
		total_duration_ms: steps.reduce((n, s) => n + (s.duration_ms ?? 0), 0),
	};
}

async function loadGitRecordForPlan(opts: {
	workdir: string;
	commit: string | null;
	recordsRelPath: string;
	slug: string;
	worktreePath?: string | null;
}): Promise<{
	summary: ReturnType<typeof parseRunJson>;
	steps: ReturnType<typeof formatGitRecordStep>[];
} | null> {
	const prefix = `${opts.recordsRelPath.replace(/\\/g, "/").replace(/\/$/, "")}/${opts.slug}`;
	let runJsonRels: string[] = [];
	if (opts.commit) {
		runJsonRels = (
			await gitLsTreePaths(opts.workdir, opts.commit, prefix)
		).filter((p) => p.endsWith("/run.json"));
	}

	type Loaded = {
		summary: ReturnType<typeof parseRunJson>;
		stepsText: string | null;
	};
	const loaded: Loaded[] = [];

	for (const rel of runJsonRels) {
		if (!opts.commit) continue;
		const text = await gitShowFile(opts.workdir, opts.commit, rel);
		if (text == null) continue;
		try {
			const summary = parseRunJson(text);
			const stepsRel = rel.replace(/run\.json$/, "steps.jsonl");
			const stepsText = await gitShowFile(opts.workdir, opts.commit, stepsRel);
			loaded.push({ summary, stepsText });
		} catch {}
	}

	if (loaded.length === 0) {
		const roots = [
			opts.worktreePath ? join(opts.worktreePath, ...prefix.split("/")) : null,
			join(opts.workdir, ...prefix.split("/")),
		].filter((p): p is string => Boolean(p));
		for (const root of roots) {
			if (!existsSync(root)) continue;
			try {
				for (const ent of readdirSync(root, { withFileTypes: true })) {
					if (!ent.isDirectory()) continue;
					const runJsonPath = join(root, ent.name, "run.json");
					if (!existsSync(runJsonPath)) continue;
					try {
						const summary = parseRunJson(readFileSync(runJsonPath, "utf-8"));
						const stepsPath = join(root, ent.name, "steps.jsonl");
						const stepsText = existsSync(stepsPath)
							? readFileSync(stepsPath, "utf-8")
							: null;
						loaded.push({ summary, stepsText });
					} catch {}
				}
			} catch {}
		}
	}

	if (loaded.length === 0) return null;
	loaded.sort((a, b) => {
		const aActive = a.summary.status === "active" ? 1 : 0;
		const bActive = b.summary.status === "active" ? 1 : 0;
		if (aActive !== bActive) return bActive - aActive;
		return b.summary.created_at.localeCompare(a.summary.created_at);
	});
	const win = loaded[0];
	if (!win) return null;
	let steps: ReturnType<typeof formatGitRecordStep>[] = [];
	if (win.stepsText) {
		try {
			steps = decodeJsonlFile(win.stepsText, win.summary.id)
				.filter((line) => line.stream === "steps")
				.map(formatGitRecordStep);
		} catch {
			steps = [];
		}
	}
	return { summary: win.summary, steps };
}

export async function runV1State(params: RunStateParams): Promise<void> {
	const { config, db, controlPlane, projectRoot } = await resolveDbContext({
		startDir: params.startDir,
	});

	// `--plan` is an explicit selector: skip ambient identity (including FIVEX_RUN).
	// `--run` wins when both are present (checked first today).
	let run: RunRowV1 | null = null;
	let progressFields: Record<string, unknown> = {};
	if (params.plan && !params.run) {
		const planPath = canonicalizePlanPath(
			resolvePlanArg(params.plan, config.paths.plans),
		);
		run = getActiveRunV1(db, planPath);
		if (params.fetch) {
			await fetchFiveXWithWarnings(projectRoot);
		}
		const recordsRelPath = resolveRecordsRoot({
			recordsConfigAbs: config.paths.records,
			controlPlaneRoot: projectRoot,
			effectiveWorkdir: projectRoot,
		}).recordsRelPath;
		const rel =
			relativePathUnder(planPath, projectRoot)?.replace(/\\/g, "/") ??
			params.plan.replace(/\\/g, "/");
		const mapped = planPath ? getPlan(db, planPath) : null;
		const resolved = await resolvePlanProgress({
			workdir: projectRoot,
			planPath,
			planSlug: planSlugFromPath(rel),
			recordsRelPath,
			worktreePath: mapped?.worktree_path ?? null,
			allRefs: params.allRefs,
		});
		progressFields = envelopeFromProgress(resolved);

		if (!run) {
			const gitRecord = await loadGitRecordForPlan({
				workdir: projectRoot,
				commit: resolved.commit,
				recordsRelPath,
				slug: planSlugFromPath(rel),
				worktreePath: mapped?.worktree_path ?? null,
			});
			if (!gitRecord) {
				outputError("RUN_NOT_FOUND", "Run not found");
			}
			let steps = gitRecord.steps;
			if (params.tail !== undefined) {
				steps = steps.slice(-params.tail);
			}
			const summary = summaryFromGitSteps(steps);
			const maxSteps = getMaxStepsPerRun(
				config as unknown as Record<string, unknown>,
			);
			const budget = computeStepBudget(summary.total_steps, maxSteps);
			outputSuccess(
				{
					run: {
						id: gitRecord.summary.id,
						plan_path: gitRecord.summary.plan_path,
						status: gitRecord.summary.status,
						created_at: gitRecord.summary.created_at,
						updated_at:
							gitRecord.summary.sealed_at ?? gitRecord.summary.created_at,
					},
					steps,
					summary,
					steps_used: budget.used,
					max_steps: budget.max,
					steps_remaining: budget.remaining,
					...progressFields,
				},
				formatStateText,
			);
			return;
		}
	} else {
		if (!controlPlane) {
			outputError(
				"NO_CONTROL_PLANE",
				`No 5x control-plane DB found. Initialize with "5x init" first.`,
			);
		}
		const runId = requireAmbientRunId({
			explicitRun: params.run,
			startDir: params.startDir,
			env: params.env,
			db,
			controlPlane,
		});
		validateRunId(runId);
		params.run = runId;
		run = getRunV1(db, runId);
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
	const maxSteps = getMaxStepsPerRun(
		config as unknown as Record<string, unknown>,
	);
	const budget = computeStepBudget(summary.total_steps, maxSteps);

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
			steps_used: budget.used,
			max_steps: budget.max,
			steps_remaining: budget.remaining,
			...progressFields,
		},
		formatStateText,
	);
}

/**
 * Admit or detect a duplicate step before any JSONL/SQLite write.
 * Slice 06's mixed `[step, budget]` wrapper calls this then `atomicAppend`.
 */
export async function prepareRecordStepAppend(
	params: RunRecordParams & { run: string; stepName: string; result: string },
	ctx: {
		db: Database;
		config: FiveXConfig;
		controlPlane?: ControlPlaneResult;
		recordStore: RecordStore;
	},
): Promise<PrepareRecordStepOutcome> {
	const { db, config, controlPlane, recordStore } = ctx;

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

	let effectiveWorkdir: string | undefined;
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
		effectiveWorkdir = ctxResult.context.effectiveWorkingDirectory;
	}

	let headCommit: string | undefined;
	if (effectiveWorkdir) {
		try {
			headCommit = await getLatestCommit(effectiveWorkdir);
		} catch {
			// Not a git repo or git unavailable — leave head_commit null
		}
	}

	const maxSteps = getMaxStepsPerRun(
		config as unknown as Record<string, unknown>,
	);

	const lookupExisting = (): boolean => {
		if (params.iteration === undefined) return false;
		const key = stepIdempotencyKey({
			runId: params.run,
			stepName: params.stepName,
			phase: params.phase ?? null,
			iteration: params.iteration,
		});
		if (storeGetLine(recordStore, params.run, "steps", key)) return true;
		return (
			findExistingStep(db, {
				run_id: params.run,
				step_name: params.stepName,
				phase: params.phase,
				iteration: params.iteration,
			}) !== null
		);
	};

	const summary = computeRunSummary(db, params.run);
	if (summary.total_steps >= maxSteps) {
		if (!lookupExisting()) {
			throw new RecordError(
				"MAX_STEPS_EXCEEDED",
				`Run has reached the maximum of ${maxSteps} steps`,
				{
					current_steps: summary.total_steps,
					max_steps: maxSteps,
					remediation:
						"Raise maxStepsPerRun via `5x config set maxStepsPerRun <n>`, or split the work into a new run.",
				},
			);
		}
	}

	try {
		JSON.parse(params.result);
	} catch {
		throw new RecordError("INVALID_JSON", "--result must be valid JSON", {
			raw: params.result.slice(0, 200),
		});
	}

	let performer: RecordPerformer;
	if (params.performer) {
		if (
			params.performer.kind !== "human" &&
			params.performer.kind !== "agent" &&
			params.performer.kind !== "system"
		) {
			throw new RecordError(
				"INVALID_ARGS",
				`invalid performer.kind: ${String(params.performer.kind)}`,
			);
		}
		performer = copyPerformer(params.performer);
	} else {
		performer = resolveRecordPerformer({ stepName: params.stepName });
	}

	const prepared: PreparedRecordStep = {
		runId: params.run,
		stepName: params.stepName,
		phase: params.phase,
		iteration: params.iteration,
		resultJson: params.result,
		headCommit,
		sessionId: params.sessionId,
		model: params.model,
		tokensIn: params.tokensIn,
		tokensOut: params.tokensOut,
		costUsd: params.costUsd,
		durationMs: params.durationMs,
		logPath: params.logPath,
		effectiveWorkdir,
		maxSteps,
		performer,
	};

	if (params.iteration !== undefined && lookupExisting()) {
		return { outcome: "duplicate", prepared };
	}
	return { outcome: "admit", prepared };
}

function projectStepToSqlite(
	db: Database,
	prepared: PreparedRecordStep,
	payload: StepRecordPayload,
	iteration: number,
): ReturnType<typeof recordStep> {
	return recordStep(db, {
		run_id: prepared.runId,
		step_name: prepared.stepName,
		phase: prepared.phase,
		iteration,
		result_json: prepared.resultJson,
		session_id: prepared.sessionId,
		model: payload.model ?? undefined,
		tokens_in: payload.tokens_in ?? undefined,
		tokens_out: payload.tokens_out ?? undefined,
		cost_usd: payload.cost_usd ?? undefined,
		duration_ms: payload.duration_ms ?? undefined,
		log_path: prepared.logPath,
		head_commit: payload.head_commit ?? prepared.headCommit,
	});
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
	dbContext?: RecordStepContext,
): Promise<RecordStepResult & { max_steps: number }> {
	const writer = await resolveRecordWriter(params, dbContext);
	const { db, config, controlPlane, recordStore, originFor } = writer;

	const preparedOutcome = await prepareRecordStepAppend(params, {
		db,
		config,
		controlPlane,
		recordStore,
	});
	const { prepared } = preparedOutcome;
	const run = getRunV1(db, prepared.runId);
	if (!run) {
		throw new RecordError("RUN_NOT_FOUND", `Run ${prepared.runId} not found`);
	}

	const projectFromLine = (line: RecordLine): ReturnType<typeof recordStep> => {
		const existingPayload = parseStepPayload(line.payload);
		const iteration =
			existingPayload?.iteration ??
			prepared.iteration ??
			nextIteration(db, prepared.runId, prepared.stepName, prepared.phase);
		const payload: StepRecordPayload = existingPayload ?? {
			step_name: prepared.stepName,
			phase: prepared.phase ?? null,
			iteration,
			result_json: JSON.parse(prepared.resultJson) as unknown,
			head_commit: prepared.headCommit ?? null,
			patch_id: null,
			diff_summary: null,
			duration_ms: prepared.durationMs ?? null,
			tokens_in: prepared.tokensIn ?? null,
			tokens_out: prepared.tokensOut ?? null,
			cost_usd: prepared.costUsd ?? null,
			model: prepared.model ?? null,
		};
		return projectStepToSqlite(db, prepared, payload, iteration);
	};

	if (preparedOutcome.outcome === "duplicate") {
		if (prepared.iteration !== undefined) {
			const key = stepIdempotencyKey({
				runId: prepared.runId,
				stepName: prepared.stepName,
				phase: prepared.phase ?? null,
				iteration: prepared.iteration,
			});
			const existingLine = storeGetLine(
				recordStore,
				prepared.runId,
				"steps",
				key,
			);
			if (existingLine) {
				const dbResult = projectFromLine(existingLine);
				const after = computeRunSummary(db, prepared.runId);
				return {
					step_id: dbResult.step_id,
					step_name: dbResult.step_name,
					phase: dbResult.phase,
					iteration: dbResult.iteration,
					recorded: false,
					total_steps: after.total_steps,
					max_steps: prepared.maxSteps,
				};
			}
		}
		const dbResult = recordStep(db, {
			run_id: prepared.runId,
			step_name: prepared.stepName,
			phase: prepared.phase,
			iteration: prepared.iteration,
			result_json: prepared.resultJson,
			session_id: prepared.sessionId,
			model: prepared.model,
			tokens_in: prepared.tokensIn,
			tokens_out: prepared.tokensOut,
			cost_usd: prepared.costUsd,
			duration_ms: prepared.durationMs,
			log_path: prepared.logPath,
			head_commit: prepared.headCommit,
		});
		const after = computeRunSummary(db, prepared.runId);
		return {
			step_id: dbResult.step_id,
			step_name: dbResult.step_name,
			phase: dbResult.phase,
			iteration: dbResult.iteration,
			recorded: false,
			total_steps: after.total_steps,
			max_steps: prepared.maxSteps,
		};
	}

	const stepLines = storeListLines(recordStore, prepared.runId, "steps");
	let iteration = prepared.iteration;
	if (iteration === undefined) {
		const storeMax = maxStoreIteration(
			stepLines,
			prepared.stepName,
			prepared.phase,
		);
		iteration =
			storeMax !== null
				? storeMax + 1
				: nextIteration(db, prepared.runId, prepared.stepName, prepared.phase);
	}

	let patchId: string | null = null;
	let diffSummary: StepRecordPayload["diff_summary"] = null;
	const previousHead = lastHeadCommit(stepLines);
	if (previousHead && prepared.headCommit && prepared.effectiveWorkdir) {
		try {
			patchId = await computePatchId(
				prepared.effectiveWorkdir,
				previousHead,
				prepared.headCommit,
			);
		} catch {
			patchId = null;
		}
		try {
			const summary = await computeDiffSummary(
				prepared.effectiveWorkdir,
				previousHead,
				prepared.headCommit,
			);
			diffSummary = summary;
		} catch {
			diffSummary = null;
		}
	}

	const payload = redactStepPayload(
		{
			step_name: prepared.stepName,
			phase: prepared.phase ?? null,
			iteration,
			result_json: JSON.parse(prepared.resultJson) as unknown,
			head_commit: prepared.headCommit ?? null,
			patch_id: patchId,
			diff_summary: diffSummary,
			duration_ms: prepared.durationMs ?? null,
			tokens_in: prepared.tokensIn ?? null,
			tokens_out: prepared.tokensOut ?? null,
			cost_usd: prepared.costUsd ?? null,
			model: prepared.model ?? null,
		},
		config.records.redact,
	);

	const origin = originFor(prepared.performer);
	const envelope = recordedEnvelope(origin);
	const stepKey = stepIdempotencyKey({
		runId: prepared.runId,
		stepName: prepared.stepName,
		phase: prepared.phase ?? null,
		iteration,
	});
	const ops: AppendOp[] = [
		{
			runId: prepared.runId,
			stream: "steps",
			idempotencyKey: stepKey,
			payload,
			...envelope,
		},
	];
	if (prepared.stepName.startsWith("human:")) {
		ops.push({
			runId: prepared.runId,
			stream: "decisions",
			idempotencyKey: `decision:human:${stepKey}`,
			payload: {
				kind: "human-step",
				step_name: prepared.stepName,
				phase: prepared.phase ?? null,
				iteration,
				result_json: JSON.parse(prepared.resultJson) as unknown,
			},
			...envelope,
		});
	}

	try {
		ensureRunRecord(recordStore, run, originFor);
		const results = recordStore.atomicAppend(ops);
		const stepResult = results[0];
		if (!stepResult?.created) {
			const existing =
				stepResult?.line ??
				storeGetLine(recordStore, prepared.runId, "steps", stepKey);
			const dbResult = existing
				? projectFromLine(existing)
				: projectStepToSqlite(db, prepared, payload, iteration);
			const after = computeRunSummary(db, prepared.runId);
			return {
				step_id: dbResult.step_id,
				step_name: dbResult.step_name,
				phase: dbResult.phase,
				iteration: dbResult.iteration,
				recorded: false,
				total_steps: after.total_steps,
				max_steps: prepared.maxSteps,
			};
		}
		const dbResult = projectStepToSqlite(db, prepared, payload, iteration);
		const after = computeRunSummary(db, prepared.runId);
		return {
			step_id: dbResult.step_id,
			step_name: dbResult.step_name,
			phase: dbResult.phase,
			iteration: dbResult.iteration,
			recorded: dbResult.recorded,
			total_steps: after.total_steps,
			max_steps: prepared.maxSteps,
		};
	} catch (err) {
		rethrowAsRecordError(err);
	}
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
	let pipeRunId: string | undefined;
	if (!stdinConsumedByResult && isStdinPiped()) {
		const upstream = await readUpstreamEnvelope();
		if (upstream) {
			const ctx = extractPipeContext(upstream.data);
			const invoke = extractInvokeMetadata(upstream.data);

			// Pipe run_id is rank 5 — do not assign onto params.run so FIVEX_RUN wins.
			pipeRunId = ctx.runId;
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

	const dbContext = await resolveDbContext({ startDir: params.startDir });
	if (!dbContext.controlPlane) {
		outputError(
			"NO_CONTROL_PLANE",
			`No 5x control-plane DB found. Initialize with "5x init" first.`,
		);
	}
	const runId = requireAmbientRunId({
		explicitRun: params.run,
		pipeRunId,
		startDir: params.startDir,
		env: params.env,
		db: dbContext.db,
		controlPlane: dbContext.controlPlane,
	});
	validateRunId(runId);
	params.run = runId;

	// Validate remaining required params (after pipe merge + ambient identity)
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
		const result = await recordStepInternal(
			{
				...params,
				run: runId,
				stepName: params.stepName,
				result: params.result,
			},
			dbContext,
		);
		const { max_steps: maxSteps, ...payload } = result;
		const budget = computeStepBudget(payload.total_steps, maxSteps);
		const warning = stepBudgetWarning(budget);
		if (warning && getOutputFormat() === "text") {
			console.error(warning);
		}
		outputSuccess(
			{
				...payload,
				...(warning ? { step_budget: budget, warnings: [warning] } : {}),
			},
			formatRecordText,
		);
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
	const { projectRoot, db, config, controlPlane } = await resolveDbContext({
		startDir: params.startDir,
	});
	const lockOpts: LockDirOpts = { stateDir: controlPlane?.stateDir };

	if (!controlPlane) {
		outputError(
			"NO_CONTROL_PLANE",
			`No 5x control-plane DB found. Initialize with "5x init" first.`,
		);
	}
	const runId = requireAmbientRunId({
		explicitRun: params.run,
		startDir: params.startDir,
		env: params.env,
		db,
		controlPlane,
	});
	validateRunId(runId);
	params.run = runId;

	const run = getRunV1(db, runId);
	if (!run) {
		outputError("RUN_NOT_FOUND", `Run ${runId} not found`);
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
			const info = lockStatus.info;
			if (!info) {
				outputError(
					"PLAN_LOCKED",
					"Plan is locked by another process; cannot complete run owned by another process",
				);
			}
			outputError(
				"PLAN_LOCKED",
				`Plan is locked by PID ${info.pid}; cannot complete run owned by another process`,
				planLockedDetail(run.plan_path, info),
			);
		}
	}

	let recordCtx: Awaited<ReturnType<typeof createRecordContext>>;
	try {
		recordCtx = await createRecordContext({
			runId,
			dbContext: { projectRoot, db, config, controlPlane },
		});
	} catch (err) {
		if (err instanceof RecordContextError) {
			outputError(err.code, err.message, err.detail);
		}
		throw err;
	}

	const summary = recordCtx.recordStore.getRun(runId);
	if (summary && summary.format_version > RUN_RECORD_FORMAT_VERSION) {
		outputError(
			"UNSUPPORTED_FORMAT_VERSION",
			`This CLI writes run.json format_version ${RUN_RECORD_FORMAT_VERSION} and cannot complete a run whose summary is format_version ${summary.format_version}. Use a CLI that understands that format, or do not complete this run with this binary.`,
		);
	}

	const stepName = status === "completed" ? "run:complete" : "run:abort";
	try {
		await recordStepInternal(
			{
				run: runId,
				stepName,
				result: JSON.stringify({
					status,
					reason: params.reason ?? null,
				}),
				performer: { kind: "system", role: "cli" },
			},
			{
				db,
				config,
				controlPlane,
				recordStore: recordCtx.recordStore,
				originFor: recordCtx.originFor,
				redactedRecorder: recordCtx.redactedRecorder,
			},
		);
	} catch (err) {
		if (err instanceof RecordError) {
			outputError(err.code, err.message, err.detail);
		}
		throw err;
	}

	let finalHead: string | null = null;
	try {
		finalHead = await getLatestCommit(
			recordCtx.executionContext.effectiveWorkingDirectory,
		);
	} catch {
		finalHead = null;
	}

	recordCtx.recordStore.putRun({
		id: runId,
		plan_path: run.plan_path,
		config_json: summary?.config_json ?? parseConfigJson(run.config_json),
		created_at: summary?.created_at ?? run.created_at,
		sealed_at: new Date().toISOString(),
		status,
		final_head_commit: finalHead,
		cli_version: summary?.cli_version ?? version,
		format_version: summary?.format_version ?? RUN_RECORD_FORMAT_VERSION,
		creator: summary ? summary.creator : null,
		sealer: recordCtx.redactedRecorder(),
		...(summary?.materializer ? { materializer: summary.materializer } : {}),
	});

	const workdir = recordCtx.executionContext.effectiveWorkingDirectory;
	try {
		const changed = await listChangedFiles(workdir);
		const recordChanges = changed.filter((file) =>
			isPathUnder(resolve(workdir, file), recordCtx.recordsAbsPath),
		);
		if (recordChanges.length > 0) {
			await commitFiles(
				workdir,
				[recordCtx.recordsRelPath],
				`5x: seal run ${runId}`,
			);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		outputError("COMMIT_FAILED", message);
	}

	completeRun(db, runId, status);

	if (run.plan_path) {
		releaseLock(projectRoot, run.plan_path, lockOpts);
	}

	clearPointerIfMatch(
		currentRunPath(projectRoot, controlPlane?.stateDir ?? ".5x"),
		runId,
	);

	outputSuccess({
		run_id: runId,
		status,
		reason: params.reason ?? null,
	});
}

export async function runV1Reopen(params: RunReopenParams): Promise<void> {
	const { projectRoot, db, controlPlane } = await resolveDbContext({
		startDir: params.startDir,
	});
	const lockOpts: LockDirOpts = { stateDir: controlPlane?.stateDir };

	if (!controlPlane) {
		outputError(
			"NO_CONTROL_PLANE",
			`No 5x control-plane DB found. Initialize with "5x init" first.`,
		);
	}
	const runId = requireAmbientRunId({
		explicitRun: params.run,
		startDir: params.startDir,
		env: params.env,
		db,
		controlPlane,
	});
	validateRunId(runId);
	params.run = runId;

	const run = getRunV1(db, runId);
	if (!run) {
		outputError("RUN_NOT_FOUND", `Run ${runId} not found`);
	}

	// Phase 3 fix: validate run-scoped context via shared resolver to honor
	// the fail-closed worktree contract. Reopening a run with a missing
	// worktree should fail rather than allow drift.
	const controlPlaneRoot = controlPlane?.controlPlaneRoot;
	if (controlPlaneRoot) {
		const ctxResult = resolveRunExecutionContext(db, runId, {
			controlPlaneRoot,
		});
		if (!ctxResult.ok) {
			outputError(ctxResult.error.code, ctxResult.error.message, {
				detail: ctxResult.error.detail,
			});
		}
	}

	if (run.status === "active") {
		outputError("RUN_ALREADY_ACTIVE", `Run ${runId} is already active`);
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
			const info = lockStatus.info;
			if (!info) {
				outputError(
					"PLAN_LOCKED",
					"Plan is locked by another process; cannot reopen run",
				);
			}
			outputError(
				"PLAN_LOCKED",
				`Plan is locked by PID ${info.pid}; cannot reopen run`,
				planLockedDetail(run.plan_path, info),
			);
		}
	}

	// Record reopen step with previous status
	recordStep(db, {
		run_id: runId,
		step_name: "run:reopen",
		result_json: JSON.stringify({
			previous_status: run.status,
		}),
	});

	// Set run back to active
	reopenRun(db, runId);

	outputSuccess({
		run_id: runId,
		status: "active",
		previous_status: run.status,
	});
}

export async function runV1List(params: RunListParams): Promise<void> {
	const { config, db, controlPlane } = await resolveDbContext({
		startDir: params.startDir,
	});

	const runs = listRuns(db, {
		planPath: params.plan
			? canonicalizePlanPath(resolvePlanArg(params.plan, config.paths.plans))
			: undefined,
		status: params.status,
		limit: params.limit,
	});

	const listed: ListRunRow[] = runs.map((r) => ({
		id: r.id,
		plan_path: r.plan_path,
		status: r.status,
		created_at: r.created_at,
		updated_at: r.updated_at,
		step_count: r.step_count,
	}));

	if (controlPlane) {
		const ambient = resolveAmbientRunId({
			required: false,
			db,
			controlPlane,
			startDir: params.startDir,
			env: params.env,
		});
		applyAmbientListMarker(listed, ambient);
	}

	outputSuccess({ runs: listed }, formatListText);
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

	const { db, config, controlPlane } = await resolveDbContext({
		startDir: params.startDir,
	});

	if (!controlPlane) {
		outputError(
			"NO_CONTROL_PLANE",
			`No 5x control-plane DB found. Initialize with "5x init" first.`,
		);
	}
	const runId = requireAmbientRunId({
		explicitRun: params.run,
		startDir: params.startDir,
		env: params.env,
		db,
		controlPlane,
	});
	validateRunId(runId);
	params.run = runId;

	const run = getRunV1(db, runId);
	if (!run) {
		outputError("RUN_NOT_FOUND", `Run ${runId} not found`);
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
		updateRunPlanPath(db, runId, canonical);
		upsertPlan(db, { planPath: canonical });
		effectivePlanPath = canonical;

		changes.plan = { old: oldPlanPath, new: canonical };
	}

	// ── Worktree relink ──────────────────────────────────────────────
	if (params.worktree !== undefined) {
		const newWorktreePath = realpathExisting(params.worktree);
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
	const updatedRun = getRunV1(db, runId) as NonNullable<
		ReturnType<typeof getRunV1>
	>;
	const updatedPlan = getPlan(db, effectivePlanPath);

	outputSuccess(
		{
			run_id: runId,
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
	run?: string;
	humanReadable?: boolean;
	showReasoning?: boolean;
	noReplay?: boolean;
	workdir?: string;
	pollInterval?: number;
	env?: NodeJS.Dict<string>;
}

export async function runV1Watch(params: RunWatchParams): Promise<void> {
	// Preserve INVALID_ARGS for an explicit malformed --run (path traversal, etc.).
	if (params.run) validateRunId(params.run);

	// Validate run exists — try DB first, fall back to log dir existence
	const { projectRoot, db, controlPlane } = await resolveDbContext({
		startDir: params.workdir,
	});
	if (!controlPlane) {
		outputError(
			"NO_CONTROL_PLANE",
			`No 5x control-plane DB found. Initialize with "5x init" first.`,
		);
	}
	const runId = requireAmbientRunId({
		explicitRun: params.run,
		startDir: params.workdir,
		env: params.env,
		db,
		controlPlane,
	});
	validateRunId(runId);
	params.run = runId;

	const run = getRunV1(db, runId);
	// Phase 3b: re-anchor log path to controlPlaneRoot/stateDir
	const stateDir = controlPlane?.stateDir ?? ".5x";
	const logDir = join(projectRoot, stateDir, "logs", runId);

	if (!run) {
		if (existsSync(logDir)) {
			process.stderr.write(
				`[watch] Warning: run '${runId}' not found in DB, but log directory exists. Proceeding.\n`,
			);
		} else {
			outputError(
				"RUN_NOT_FOUND",
				`Run '${runId}' not found (no DB entry and no log directory)`,
			);
		}
	}

	// Phase 3 fix: validate run-scoped context via shared resolver to honor
	// the fail-closed worktree contract. Watching logs from a run with a
	// missing worktree is misleading — fail with WORKTREE_MISSING.
	if (run) {
		const controlPlaneRoot = controlPlane?.controlPlaneRoot;
		if (controlPlaneRoot) {
			const ctxResult = resolveRunExecutionContext(db, runId, {
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
