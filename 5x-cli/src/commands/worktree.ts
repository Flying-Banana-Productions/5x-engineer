import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { getPlan, upsertPlan } from "../db/operations.js";
import { runMigrations } from "../db/schema.js";
import {
	deleteBranch,
	hasUncommittedChanges,
	isBranchMerged,
	removeWorktree,
} from "../git.js";
import { canonicalizePlanPath } from "../paths.js";
import { resolveProjectRoot } from "../project-root.js";

const statusCmd = defineCommand({
	meta: {
		name: "status",
		description: "Show worktree info for a plan",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to implementation plan",
			required: true,
		},
	},
	async run({ args }) {
		const planPath = resolve(args.path);
		const canonical = canonicalizePlanPath(planPath);
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		const plan = getPlan(db, canonical);
		if (!plan || (!plan.worktree_path && !plan.branch)) {
			console.log();
			console.log("  No worktree associated with this plan.");
			console.log();
			return;
		}

		console.log();
		console.log(`  Plan: ${canonical}`);
		if (plan.worktree_path) {
			console.log(`  Worktree: ${plan.worktree_path}`);
			console.log(
				`  Exists: ${existsSync(plan.worktree_path) ? "yes" : "no (directory missing)"}`,
			);
		}
		if (plan.branch) {
			console.log(`  Branch: ${plan.branch}`);
		}
		console.log();
	},
});

const cleanupCmd = defineCommand({
	meta: {
		name: "cleanup",
		description: "Remove worktree for a plan",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to implementation plan",
			required: true,
		},
		"delete-branch": {
			type: "boolean",
			description: "Also delete the branch (only if fully merged)",
			default: false,
		},
		force: {
			type: "boolean",
			description: "Remove worktree even with uncommitted changes",
			default: false,
		},
	},
	async run({ args }) {
		const planPath = resolve(args.path);
		const canonical = canonicalizePlanPath(planPath);
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		const plan = getPlan(db, canonical);
		if (!plan?.worktree_path) {
			console.error("Error: No worktree associated with this plan.");
			process.exit(1);
		}

		const wtPath = plan.worktree_path;

		// Check worktree exists
		if (!existsSync(wtPath)) {
			console.log(`  Worktree directory ${wtPath} does not exist.`);
			// Clear DB association
			upsertPlan(db, { planPath: canonical });
			console.log("  Cleared plan worktree association from DB.");
			return;
		}

		// Check for uncommitted changes
		if (!args.force) {
			try {
				const dirty = await hasUncommittedChanges(wtPath);
				if (dirty) {
					console.error(
						"Error: Worktree has uncommitted changes. " +
							"Commit or stash them, or use --force to remove anyway.",
					);
					process.exit(1);
				}
			} catch {
				// Can't check — proceed with caution
			}
		}

		// Remove worktree
		console.log(`  Removing worktree ${wtPath}...`);
		try {
			await removeWorktree(projectRoot, wtPath, args.force);
		} catch (err) {
			console.error(
				`Error: ${err instanceof Error ? err.message : String(err)}`,
			);
			process.exit(1);
		}

		// Optionally delete branch
		if (args["delete-branch"] && plan.branch) {
			const merged = await isBranchMerged(plan.branch, projectRoot);
			if (!merged) {
				console.error(
					`Error: Branch "${plan.branch}" has unmerged commits. ` +
						"Merge it first or omit --delete-branch.",
				);
				// Still clear worktree association even if branch delete fails
			} else {
				try {
					await deleteBranch(plan.branch, projectRoot);
					console.log(`  Deleted branch ${plan.branch}.`);
				} catch (err) {
					console.error(
						`Warning: Could not delete branch: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		} else if (plan.branch) {
			console.log(
				`  Branch ${plan.branch} retained (use --delete-branch to remove).`,
			);
		}

		// Clear DB association
		upsertPlan(db, { planPath: canonical });
		console.log("  Cleared plan worktree association from DB.");
	},
});

export default defineCommand({
	meta: {
		name: "worktree",
		description: "Manage git worktrees for plan execution",
	},
	subCommands: {
		status: () => Promise.resolve(statusCmd),
		cleanup: () => Promise.resolve(cleanupCmd),
	},
});
