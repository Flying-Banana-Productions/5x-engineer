import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { createAndVerifyAdapter } from "../agents/factory.js";
import type { LegacyAgentAdapter } from "../agents/types.js";
import { loadConfig } from "../config.js";
import { getDb } from "../db/connection.js";
import { runMigrations } from "../db/schema.js";
import { checkGitSafety } from "../git.js";
import {
	resolveReviewPath,
	runPlanReviewLoop,
} from "../orchestrator/plan-review-loop.js";
import { parsePlan } from "../parsers/plan.js";
import { canonicalizePlanPath } from "../paths.js";
import { resolveProjectRoot } from "../project-root.js";

export default defineCommand({
	meta: {
		name: "plan-review",
		description: "Run automated review loop on an implementation plan",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to implementation plan markdown file",
			required: true,
		},
		auto: {
			type: "boolean",
			description:
				"Auto-resolve mechanical fixes; still escalate human_required items",
			default: false,
		},
		"allow-dirty": {
			type: "boolean",
			description: "Allow running with a dirty working tree",
			default: false,
		},
		quiet: {
			type: "boolean",
			description:
				"Suppress formatted agent output (default: auto, quiet when stdout is not a TTY). Log files are always written. Logs may contain sensitive data.",
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

		// Derive project root consistently (config file > git root > cwd)
		const projectRoot = resolveProjectRoot();
		const { config } = await loadConfig(projectRoot);

		// Git safety check
		if (!args["allow-dirty"]) {
			try {
				const safety = await checkGitSafety(projectRoot);
				if (!safety.safe) {
					console.error(
						"Error: Working tree has uncommitted changes. " +
							"Commit or stash them, or pass --allow-dirty to proceed.",
					);
					process.exit(1);
				}
			} catch {
				// git not available or not a repo — skip check
			}
		}

		// Initialize DB
		const db = getDb(projectRoot, config.db.path);
		runMigrations(db);

		// Resolve review path
		const reviewsDir = resolve(projectRoot, config.paths.reviews);
		const reviewPath = resolveReviewPath(db, canonical, reviewsDir);

		// Initialize adapters
		console.log();
		console.log(`  Plan: ${plan.title}`);
		console.log(`  Review path: ${reviewPath}`);
		console.log();

		const authorAdapter = await createAndVerifyAdapter(config.author);
		const reviewerAdapter = await createAndVerifyAdapter(config.reviewer);

		// Resolve effective quiet mode: explicit flag > TTY detection
		const effectiveQuiet =
			args.quiet !== undefined ? args.quiet : !process.stdout.isTTY;

		// Run the loop
		const result = await runPlanReviewLoop(
			canonical,
			reviewPath,
			db,
			authorAdapter as unknown as LegacyAgentAdapter,
			reviewerAdapter as unknown as LegacyAgentAdapter,
			config,
			{
				auto: args.auto,
				allowDirty: args["allow-dirty"],
				projectRoot,
				quiet: effectiveQuiet,
			},
		);

		// Display final result
		console.log();
		if (result.approved) {
			console.log("  Plan review: APPROVED");
		} else {
			console.log("  Plan review: NOT APPROVED");
		}
		console.log(`  Iterations: ${result.iterations}`);
		console.log(`  Review: ${result.reviewPath}`);
		console.log(`  Run ID: ${result.runId.slice(0, 8)}`);
		if (result.escalations.length > 0) {
			console.log(`  Escalations: ${result.escalations.length}`);
		}
		console.log();

		if (result.approved) {
			console.log(`  Next: 5x run ${planPath}`);
			console.log();
		}

		if (!result.approved) {
			process.exit(1);
		}
	},
});
