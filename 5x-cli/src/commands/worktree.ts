/**
 * v1 Worktree management commands.
 *
 * Subcommands: create, remove, list
 *
 * All commands return JSON envelopes via outputSuccess/outputError.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { getPlan, upsertPlan } from "../db/operations.js";
import { runMigrations } from "../db/schema.js";
import {
	branchNameFromPlan,
	createWorktree,
	deleteBranch,
	hasUncommittedChanges,
	isBranchMerged,
	listWorktrees,
	removeWorktree,
	runWorktreeSetupCommand,
} from "../git.js";
import { outputError, outputSuccess } from "../output.js";
import { canonicalizePlanPath } from "../paths.js";
import { resolveProjectRoot } from "../project-root.js";

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
// Subcommands
// ---------------------------------------------------------------------------

const createCmd = defineCommand({
	meta: {
		name: "create",
		description: "Create a git worktree for a plan",
	},
	args: {
		plan: {
			type: "string",
			description: "Path to implementation plan",
			required: true,
		},
		branch: {
			type: "string",
			description: "Branch name (default: derived from plan filename)",
		},
	},
	async run({ args }) {
		const planPath = resolve(args.plan);

		// Validate that the plan file exists before proceeding
		if (!existsSync(planPath)) {
			outputError("PLAN_NOT_FOUND", `Plan file not found: ${planPath}`, {
				path: planPath,
			});
		}

		const canonical = canonicalizePlanPath(planPath);
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

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
		const branch = args.branch || branchNameFromPlan(canonical);
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
	},
});

const removeCmd = defineCommand({
	meta: {
		name: "remove",
		description: "Remove a worktree for a plan",
	},
	args: {
		plan: {
			type: "string",
			description: "Path to implementation plan",
			required: true,
		},
		force: {
			type: "boolean",
			description: "Remove even with uncommitted changes",
			default: false,
		},
	},
	async run({ args }) {
		const planPath = resolve(args.plan);
		const canonical = canonicalizePlanPath(planPath);
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		const plan = getPlan(db, canonical);
		if (!plan?.worktree_path) {
			outputError(
				"WORKTREE_NOT_FOUND",
				"No worktree associated with this plan",
			);
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
		if (!args.force) {
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
			await removeWorktree(projectRoot, wtPath, args.force);
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
	},
});

const listCmd = defineCommand({
	meta: {
		name: "list",
		description: "List active worktrees",
	},
	args: {},
	async run() {
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

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
	},
});

export default defineCommand({
	meta: {
		name: "worktree",
		description: "Manage git worktrees for plan execution",
	},
	subCommands: {
		create: () => Promise.resolve(createCmd),
		remove: () => Promise.resolve(removeCmd),
		list: () => Promise.resolve(listCmd),
	},
});
