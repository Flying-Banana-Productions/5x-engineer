import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { createAndVerifyAdapter } from "../agents/factory.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { getPlan, upsertPlan } from "../db/operations.js";
import { runMigrations } from "../db/schema.js";
import { branchNameFromPlan, checkGitSafety, createWorktree } from "../git.js";
import { acquireLock, registerLockCleanup, releaseLock } from "../lock.js";
import { runPhaseExecutionLoop } from "../orchestrator/phase-execution-loop.js";
import { resolveReviewPath } from "../orchestrator/plan-review-loop.js";
import { parsePlan } from "../parsers/plan.js";
import { canonicalizePlanPath } from "../paths.js";
import { resolveProjectRoot } from "../project-root.js";

export default defineCommand({
	meta: {
		name: "run",
		description:
			"Execute implementation phases with automated author-review loops",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to implementation plan markdown file",
			required: true,
		},
		phase: {
			type: "string",
			description: "Start from a specific phase number (e.g., 3, 1.1)",
		},
		auto: {
			type: "boolean",
			description:
				"Skip inter-phase human gates; still escalate on human_required",
			default: false,
		},
		"allow-dirty": {
			type: "boolean",
			description: "Allow running with a dirty working tree",
			default: false,
		},
		"skip-quality": {
			type: "boolean",
			description: "Skip quality gate checks",
			default: false,
		},
		worktree: {
			type: "boolean",
			description: "Create an isolated git worktree for execution",
			default: false,
		},
	},
	async run({ args }) {
		const planPath = resolve(args.path);
		const canonical = canonicalizePlanPath(planPath);

		// Validate plan file
		if (!existsSync(canonical)) {
			console.error(`Error: Plan file not found: ${planPath}`);
			process.exit(1);
		}

		let planContent: string;
		try {
			planContent = readFileSync(canonical, "utf-8");
		} catch {
			console.error(`Error: Could not read plan file: ${canonical}`);
			process.exit(1);
		}

		// Verify it's parseable as a plan
		const plan = parsePlan(planContent);
		if (plan.phases.length === 0) {
			console.error(
				"Error: No phases found in plan file. Is this a valid implementation plan?",
			);
			process.exit(1);
		}

		// Check for incomplete phases
		const incompletePhases = plan.phases.filter((p) => !p.isComplete);
		if (incompletePhases.length === 0) {
			console.log();
			console.log("  All phases are already complete. Nothing to run.");
			console.log();
			process.exit(0);
		}

		// Derive project root
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		// Initialize DB
		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		// --- Resolve workdir ---
		let workdir = projectRoot;

		// Check DB for existing worktree association
		const planRecord = getPlan(db, canonical);
		if (planRecord?.worktree_path) {
			if (existsSync(planRecord.worktree_path)) {
				workdir = planRecord.worktree_path;
				console.log(`  Using worktree: ${workdir}`);
			}
		}

		// Create worktree if requested and not already set
		if (args.worktree && workdir === projectRoot) {
			const branch = branchNameFromPlan(planPath);
			const wtPath = resolve(
				projectRoot,
				".5x",
				"worktrees",
				branch.replace(/\//g, "-"),
			);

			try {
				const info = await createWorktree(projectRoot, branch, wtPath);
				workdir = info.path;
				upsertPlan(db, {
					planPath: canonical,
					worktreePath: info.path,
					branch: info.branch,
				});
				console.log(
					`  Created worktree: ${info.path} (branch: ${info.branch})`,
				);
			} catch (err) {
				console.error(
					`Error: Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}
		}

		// --- Git safety check ---
		if (!args["allow-dirty"]) {
			try {
				const safety = await checkGitSafety(workdir);
				if (!safety.safe) {
					console.error(
						"Error: Working tree has uncommitted changes. " +
							"Commit or stash them, or pass --allow-dirty to proceed.",
					);
					if (safety.untrackedFiles.length > 0) {
						console.error(
							`  Untracked files: ${safety.untrackedFiles.slice(0, 5).join(", ")}${safety.untrackedFiles.length > 5 ? ` (+${safety.untrackedFiles.length - 5} more)` : ""}`,
						);
					}
					process.exit(1);
				}
			} catch {
				// git not available or not a repo — skip check
			}
		}

		// --- Acquire plan lock ---
		const lockResult = acquireLock(projectRoot, canonical);
		if (!lockResult.acquired) {
			if (lockResult.existingLock) {
				console.error(
					`Error: Plan is locked by PID ${lockResult.existingLock.pid} (started ${lockResult.existingLock.startedAt}). ` +
						"Another 5x process is running on this plan.",
				);
			} else {
				console.error("Error: Could not acquire plan lock.");
			}
			process.exit(1);
		}

		if (lockResult.stale) {
			console.log("  Note: Stale lock detected and acquired.");
		}

		// Register lock cleanup
		registerLockCleanup(projectRoot, canonical);

		// --- Resolve review path ---
		const reviewsDir = resolve(projectRoot, config.paths.reviews);
		const reviewPath = resolveReviewPath(db, canonical, reviewsDir);

		// --- Display header ---
		console.log();
		console.log(`  Plan: ${plan.title}`);
		console.log(
			`  Phases: ${incompletePhases.length} remaining of ${plan.phases.length} total`,
		);
		console.log(`  Review: ${reviewPath}`);
		if (args.phase) {
			console.log(`  Starting from phase: ${args.phase}`);
		}
		console.log();

		// --- Initialize adapters ---
		const authorAdapter = await createAndVerifyAdapter(config.author);
		const reviewerAdapter = await createAndVerifyAdapter(config.reviewer);

		// --- Run the loop ---
		try {
			const result = await runPhaseExecutionLoop(
				canonical,
				reviewPath,
				db,
				authorAdapter,
				reviewerAdapter,
				config,
				{
					auto: args.auto,
					allowDirty: args["allow-dirty"],
					skipQuality: args["skip-quality"],
					startPhase: args.phase,
					workdir,
				},
			);

			// --- Display final result ---
			console.log();
			if (result.complete) {
				console.log("  Run: COMPLETE");
			} else if (result.aborted) {
				console.log("  Run: ABORTED");
			} else {
				console.log("  Run: INCOMPLETE");
			}
			console.log(
				`  Phases completed: ${result.phasesCompleted}/${result.totalPhases}`,
			);
			console.log(`  Run ID: ${result.runId.slice(0, 8)}`);
			if (result.escalations.length > 0) {
				console.log(`  Escalations: ${result.escalations.length}`);
			}
			console.log();

			if (!result.complete) {
				process.exit(1);
			}
		} finally {
			releaseLock(projectRoot, canonical);
		}
	},
});
