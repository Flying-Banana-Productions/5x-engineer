/**
 * Worktree command handlers — business logic for git worktree management.
 *
 * Framework-independent: no CLI framework imports.
 *
 * Phase 6 guards:
 * - `worktree create` fails in linked-worktree context unless `--allow-nested`.
 * - `worktree remove` prevents removing the current checkout worktree.
 * - `worktree attach/detach/remove` emit warnings in isolated mode.
 * - Legacy split-brain detection warns when root DB shadows a local state DB.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
	getPlan,
	listPlansByWorktreePath,
	upsertPlan,
} from "../db/operations.js";
import {
	branchNameFromPlan,
	createWorktree,
	deleteBranch,
	hasUncommittedChanges,
	isBranchMerged,
	isBranchRelevant,
	listWorktrees,
	removeWorktree,
	runWorktreeSetupCommand,
} from "../git.js";
import { outputError, outputSuccess } from "../output.js";
import { canonicalizePlanPath } from "../paths.js";
import { resolveDbContext } from "./context.js";
import {
	type ControlPlaneResult,
	DB_FILENAME,
	resolveCheckoutRoot,
	resolveControlPlaneRoot,
} from "./control-plane.js";

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface WorktreeCreateParams {
	plan: string;
	branch?: string;
	/** Allow creating a worktree from a linked-worktree context (nested). */
	allowNested?: boolean;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
}

export interface WorktreeRemoveParams {
	plan: string;
	force?: boolean;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
}

export interface WorktreeAttachParams {
	plan: string;
	path: string;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
}

export interface WorktreeDetachParams {
	plan: string;
	/** Working directory override — defaults to `resolve(".")`. */
	startDir?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive worktree directory path from plan path.
 * Uses basename + a short hash of the full canonical path to avoid collisions
 * when plans in different directories share the same filename.
 *
 * Phase 3c: anchored to `<projectRoot>/<stateDir>/worktrees/` instead of
 * `<projectRoot>/.5x/worktrees/`. The `stateDir` defaults to `.5x` for
 * backward compatibility.
 */
function worktreeDir(
	projectRoot: string,
	planPath: string,
	stateDir = ".5x",
): string {
	const slug = basename(planPath).replace(/\.md$/, "");
	const hash = createHash("sha256").update(planPath).digest("hex").slice(0, 6);
	return join(projectRoot, stateDir, "worktrees", `${slug}-${hash}`);
}

/**
 * Detect if the current checkout is a linked worktree (not the main checkout).
 * Returns true if the checkout root differs from the control-plane root.
 */
function isLinkedWorktreeContext(
	controlPlane: ControlPlaneResult,
	startDir?: string,
): boolean {
	const checkoutRoot = resolveCheckoutRoot(resolve(startDir ?? "."));
	if (!checkoutRoot) return false;
	return resolve(checkoutRoot) !== resolve(controlPlane.controlPlaneRoot);
}

/**
 * Emit a split-brain warning to stderr when a root state DB (managed mode)
 * shadows a local state DB in the current checkout. Emitted once per command
 * invocation — callers should invoke this at most once.
 */
export function emitSplitBrainWarning(
	controlPlane: ControlPlaneResult,
	startDir?: string,
): void {
	if (controlPlane.mode !== "managed") return;

	const checkoutRoot = resolveCheckoutRoot(resolve(startDir ?? "."));
	if (!checkoutRoot) return;
	if (resolve(checkoutRoot) === resolve(controlPlane.controlPlaneRoot)) return;

	// Check if the checkout also has a local state DB
	const localStateDir = join(checkoutRoot, controlPlane.stateDir);
	const localDbPath = join(localStateDir, DB_FILENAME);
	if (!existsSync(localDbPath)) return;

	const rootDbPath = join(
		controlPlane.controlPlaneRoot,
		controlPlane.stateDir,
		DB_FILENAME,
	);
	process.stderr.write(
		`Warning: Local state DB at \`${localDbPath}\` is being ignored — using control-plane DB at \`${rootDbPath}\`. ` +
			"Local runs/mappings are not visible in managed mode.\n",
	);
}

/**
 * Emit a warning when worktree operations run in isolated mode, alerting
 * that DB mappings will only be stored in the local (worktree-scoped) DB.
 */
function emitIsolatedModeWarning(
	controlPlane: ControlPlaneResult,
	operation: string,
): void {
	if (controlPlane.mode !== "isolated") return;
	process.stderr.write(
		`Warning: Running \`worktree ${operation}\` in isolated mode. ` +
			"DB mappings are stored in the local worktree-scoped DB only and " +
			"will not be visible from the main checkout.\n",
	);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function worktreeCreate(
	params: WorktreeCreateParams,
): Promise<void> {
	const planPath = resolve(params.plan);

	// Validate that the plan file exists before proceeding
	if (!existsSync(planPath)) {
		outputError("PLAN_NOT_FOUND", `Plan file not found: ${planPath}`, {
			path: planPath,
		});
	}

	// Phase 6: linked-worktree guard — prevent accidental nested worktree
	// creation from a linked-worktree context. Use --allow-nested to bypass.
	const cwd = resolve(params.startDir ?? ".");
	const controlPlane = resolveControlPlaneRoot(cwd);
	if (
		!params.allowNested &&
		controlPlane.mode !== "none" &&
		isLinkedWorktreeContext(controlPlane, params.startDir)
	) {
		outputError(
			"WORKTREE_CONTEXT_INVALID",
			"Cannot create worktree from a linked-worktree context. " +
				'Run from the repository root checkout or pass "--allow-nested".',
			{
				controlPlaneRoot: controlPlane.controlPlaneRoot,
				hint: "--allow-nested",
			},
		);
	}

	// Phase 6: split-brain detection
	emitSplitBrainWarning(controlPlane, params.startDir);

	const canonical = canonicalizePlanPath(planPath);
	const {
		projectRoot,
		config,
		db,
		controlPlane: cp,
	} = await resolveDbContext({ startDir: cwd });
	const stateDir = cp?.stateDir ?? ".5x";

	// Check if worktree already exists for this plan
	const existingPlan = getPlan(db, canonical);
	if (existingPlan?.worktree_path && existsSync(existingPlan.worktree_path)) {
		outputSuccess({
			worktree_path: existingPlan.worktree_path,
			branch: existingPlan.branch,
			created: false,
		});
		return;
	}

	// Determine branch name and worktree path
	// Phase 3c: anchor worktree path to controlPlaneRoot/stateDir
	const branch = params.branch || branchNameFromPlan(canonical);
	const wtPath = worktreeDir(projectRoot, canonical, stateDir);

	// Create the worktree
	try {
		await createWorktree(projectRoot, branch, wtPath);
	} catch (err) {
		outputError(
			"WORKTREE_ERROR",
			`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Run postCreate hook if configured
	const warnings: string[] = [];
	if (config.worktree?.postCreate) {
		try {
			await runWorktreeSetupCommand(wtPath, config.worktree.postCreate);
		} catch (err) {
			// Non-fatal — worktree was created but hook failed
			const msg = `postCreate hook failed: ${err instanceof Error ? err.message : String(err)}`;
			process.stderr.write(`Warning: ${msg}\n`);
			warnings.push(msg);
		}
	}

	// Record in plans table
	upsertPlan(db, {
		planPath: canonical,
		worktreePath: wtPath,
		branch,
	});

	const data: Record<string, unknown> = {
		worktree_path: wtPath,
		branch,
		created: true,
	};
	if (warnings.length > 0) {
		data.warnings = warnings;
	}
	outputSuccess(data);
}

export async function worktreeAttach(
	params: WorktreeAttachParams,
): Promise<void> {
	const planPath = resolve(params.plan);
	if (!existsSync(planPath)) {
		outputError("PLAN_NOT_FOUND", `Plan file not found: ${planPath}`, {
			path: planPath,
		});
	}

	const canonical = canonicalizePlanPath(planPath);
	const wtPath = resolve(params.path);

	if (!existsSync(wtPath)) {
		outputError("WORKTREE_NOT_FOUND", `Worktree path not found: ${wtPath}`, {
			path: wtPath,
		});
	}

	// Phase 6: isolated-mode and split-brain warnings
	const cwd = resolve(params.startDir ?? ".");
	const cpEarly = resolveControlPlaneRoot(cwd);
	emitIsolatedModeWarning(cpEarly, "attach");
	emitSplitBrainWarning(cpEarly, params.startDir);

	const { projectRoot, db } = await resolveDbContext({ startDir: cwd });
	let gitWorktrees: Array<{ path: string; branch: string }> = [];
	try {
		gitWorktrees = await listWorktrees(projectRoot);
	} catch (err) {
		outputError(
			"WORKTREE_ERROR",
			`Failed to list git worktrees: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const match = gitWorktrees.find((w) => w.path === wtPath);
	if (!match) {
		outputError(
			"WORKTREE_INVALID",
			`Path is not a git worktree in this repository: ${wtPath}`,
			{ path: wtPath },
		);
	}

	upsertPlan(db, {
		planPath: canonical,
		worktreePath: wtPath,
		branch: match.branch,
	});

	const warning = isBranchRelevant(match.branch, canonical)
		? undefined
		: `Branch "${match.branch}" does not appear related to plan "${canonical}"`;

	outputSuccess({
		plan_path: canonical,
		worktree_path: wtPath,
		branch: match.branch,
		attached: true,
		...(warning ? { warning } : {}),
	});
}

export async function worktreeRemove(
	params: WorktreeRemoveParams,
): Promise<void> {
	const planPath = resolve(params.plan);
	const canonical = canonicalizePlanPath(planPath);

	// Phase 6: isolated-mode and split-brain warnings
	const cwd = resolve(params.startDir ?? ".");
	const cpEarly = resolveControlPlaneRoot(cwd);
	emitIsolatedModeWarning(cpEarly, "remove");
	emitSplitBrainWarning(cpEarly, params.startDir);

	const { projectRoot, db } = await resolveDbContext({ startDir: cwd });

	const plan = getPlan(db, canonical);
	if (!plan?.worktree_path) {
		outputError("WORKTREE_NOT_FOUND", "No worktree associated with this plan");
	}

	const wtPath = plan.worktree_path as string;
	const references = listPlansByWorktreePath(db, wtPath);
	if (references.length > 1) {
		outputError(
			"WORKTREE_SHARED",
			"Cannot remove a worktree while multiple plans still reference it. Detach the other plans first.",
			{
				worktree_path: wtPath,
				reference_count: references.length,
				referencing_plans: references.map((ref) => ref.plan_path),
				hint: "Use `5x worktree detach --plan <path>` for all but one plan.",
			},
		);
	}

	// Phase 6: prevent removing current checkout worktree
	const checkoutRoot = resolveCheckoutRoot(cwd);
	if (checkoutRoot && resolve(checkoutRoot) === resolve(wtPath)) {
		outputError(
			"WORKTREE_SELF_REMOVE",
			"Cannot remove the worktree you are currently inside. " +
				"Switch to the main checkout first.",
			{ worktree_path: wtPath },
		);
	}

	// If directory doesn't exist, just clear the DB and return
	if (!existsSync(wtPath)) {
		upsertPlan(db, { planPath: canonical, worktreePath: "", branch: "" });
		outputSuccess({
			worktree_path: wtPath,
			removed: true,
			note: "Directory was already missing; cleared DB association",
		});
		return;
	}

	// Check for uncommitted changes unless --force
	if (!params.force) {
		try {
			const dirty = await hasUncommittedChanges(wtPath);
			if (dirty) {
				outputError(
					"DIRTY_WORKTREE",
					"Worktree has uncommitted changes. Commit or stash them, or use --force.",
				);
			}
		} catch {
			// Can't check — proceed
		}
	}

	// Remove worktree
	try {
		await removeWorktree(projectRoot, wtPath, params.force);
	} catch (err) {
		outputError(
			"WORKTREE_ERROR",
			`Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Try to clean up the branch if merged
	const branch = plan.branch;
	let branchDeleted = false;
	if (branch) {
		try {
			const merged = await isBranchMerged(branch, projectRoot);
			if (merged) {
				await deleteBranch(branch, projectRoot);
				branchDeleted = true;
			}
		} catch {
			// Non-fatal — branch cleanup is best effort
		}
	}

	// Clear DB association
	upsertPlan(db, { planPath: canonical, worktreePath: "", branch: "" });

	outputSuccess({
		worktree_path: wtPath,
		removed: true,
		branch_deleted: branchDeleted,
	});
}

export async function worktreeDetach(
	params: WorktreeDetachParams,
): Promise<void> {
	const planPath = resolve(params.plan);
	const canonical = canonicalizePlanPath(planPath);

	const cwd = resolve(params.startDir ?? ".");
	const cpEarly = resolveControlPlaneRoot(cwd);
	emitIsolatedModeWarning(cpEarly, "detach");
	emitSplitBrainWarning(cpEarly, params.startDir);

	const { db } = await resolveDbContext({ startDir: cwd });
	const plan = getPlan(db, canonical);
	if (!plan?.worktree_path) {
		outputError("WORKTREE_NOT_FOUND", "No worktree associated with this plan");
	}

	const wtPath = plan.worktree_path as string;
	const branch = plan.branch;
	upsertPlan(db, { planPath: canonical, worktreePath: "", branch: "" });

	outputSuccess({
		plan_path: canonical,
		worktree_path: null,
		branch: null,
		previous_worktree_path: wtPath,
		previous_branch: branch,
		detached: true,
	});
}

export async function worktreeList(params?: {
	startDir?: string;
}): Promise<void> {
	// Phase 6: split-brain detection (list is safe in all modes, but still warn)
	const cwd = resolve(params?.startDir ?? ".");
	const cpEarly = resolveControlPlaneRoot(cwd);
	emitSplitBrainWarning(cpEarly, params?.startDir);

	const { projectRoot, db } = await resolveDbContext({ startDir: cwd });

	// Get all plans that have worktree associations
	const plans = db
		.query(
			"SELECT plan_path, worktree_path, branch FROM plans WHERE worktree_path IS NOT NULL AND worktree_path != ''",
		)
		.all() as Array<{
		plan_path: string;
		worktree_path: string;
		branch: string | null;
	}>;

	// Cross-reference with git worktrees for active status
	let gitWorktrees: Array<{ path: string; branch: string }> = [];
	try {
		gitWorktrees = await listWorktrees(projectRoot);
	} catch {
		// If git fails, still return DB data
	}

	const gitPaths = new Set(gitWorktrees.map((w) => w.path));

	const worktrees = plans.map((p) => ({
		plan_path: p.plan_path,
		worktree_path: p.worktree_path,
		branch: p.branch,
		exists: gitPaths.has(p.worktree_path) || existsSync(p.worktree_path),
	}));

	outputSuccess({ worktrees });
}
