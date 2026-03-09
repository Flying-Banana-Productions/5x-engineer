/**
 * Worktree command handlers — business logic for git worktree management.
 *
 * Framework-independent: no citty imports.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getPlan, upsertPlan } from "../db/operations.js";
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

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface WorktreeCreateParams {
	plan: string;
	branch?: string;
}

export interface WorktreeRemoveParams {
	plan: string;
	force?: boolean;
}

export interface WorktreeAttachParams {
	plan: string;
	path: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive worktree directory path from plan path.
 * Uses basename + a short hash of the full canonical path to avoid collisions
 * when plans in different directories share the same filename. */
function worktreeDir(projectRoot: string, planPath: string): string {
	const slug = basename(planPath).replace(/\.md$/, "");
	const hash = createHash("sha256").update(planPath).digest("hex").slice(0, 6);
	return join(projectRoot, ".5x", "worktrees", `${slug}-${hash}`);
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

	const canonical = canonicalizePlanPath(planPath);
	const { projectRoot, config, db } = await resolveDbContext();

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
	const branch = params.branch || branchNameFromPlan(canonical);
	const wtPath = worktreeDir(projectRoot, canonical);

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

	const { projectRoot, db } = await resolveDbContext();
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
	const { projectRoot, db } = await resolveDbContext();

	const plan = getPlan(db, canonical);
	if (!plan?.worktree_path) {
		outputError("WORKTREE_NOT_FOUND", "No worktree associated with this plan");
	}

	const wtPath = plan.worktree_path as string;

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

export async function worktreeList(): Promise<void> {
	const { projectRoot, db } = await resolveDbContext();

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
