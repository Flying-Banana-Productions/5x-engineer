/**
 * v1 Plan inspection command — commander adapter.
 *
 * `5x plan phases <path>`
 *
 * Business logic lives in plan-v1.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { planArchive, planList, planPhases } from "./plan-v1.handler.js";

export function registerPlan(parent: Command) {
	const plan = parent
		.command("plan")
		.summary("Plan inspection operations")
		.description(
			"Inspect and parse implementation plans. Plans are markdown documents that\n" +
				"define phases of work for the 5x workflow.",
		);

	plan
		.command("phases")
		.summary("Parse a plan and return its phases")
		.description(
			"Read an implementation plan file and extract its phase structure. Returns an\n" +
				"array of phases with their names, descriptions, and step counts. If the plan\n" +
				"has a mapped worktree copy, 5x prefers that file when it exists.",
		)
		.argument("<path>", "Path to implementation plan")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x plan phases docs/development/015-test-separation.md\n" +
				"  $ 5x plan phases ./plan.md | jq '.data.phases[].name'\n" +
				"  PS> $j = 5x plan phases .\\plan.md | ConvertFrom-Json\n" +
				"  PS> $j.data.phases\n\n" +
				"If you are outside the control-plane repo or worktree mapping cannot be resolved,\n" +
				"use the worktree plan path from `5x run state` (for example `worktree_plan_path`).",
		)
		.action(async (path) => {
			await planPhases({ path });
		});

	plan
		.command("list")
		.summary("List plans and their completion status")
		.description(
			"Scan the configured plans directory tree for markdown plans and summarize\n" +
				"completion status, phase progress, and associated runs. Disk discovery uses\n" +
				"`paths.plans` from config; run data comes from the project database.",
		)
		.option(
			"--exclude-finished",
			"Omit plans whose phases are all complete (100%)",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x plan list\n" +
				"  $ 5x --text plan list\n" +
				"  $ 5x plan list --exclude-finished\n",
		)
		.action(async (opts) => {
			await planList({
				excludeFinished: opts.excludeFinished,
				startDir: process.cwd(),
			});
		});

	plan
		.command("archive")
		.summary("Archive a plan by moving it to the archive folder")
		.description(
			"Move a plan file to the configured archive directory (paths.archive in 5x.toml).\n" +
				"Refuses to archive plans with an active run unless --force is used, which aborts\n" +
				"the active run first. Use --all to archive every plan in the plans directory.",
		)
		.argument("[path]", "Path to the plan file to archive")
		.option("--force", "Abort active runs before archiving")
		.option("--all", "Archive all .md files in the configured plans directory")
		.option(
			"--dry-run",
			"Preview what would be archived without making changes",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x plan archive docs/development/015-feature.md\n" +
				"  $ 5x plan archive docs/development/015-feature.md --force\n" +
				"  $ 5x plan archive --all\n" +
				"  $ 5x plan archive --all --dry-run",
		)
		.action(async (path, opts) => {
			await planArchive({
				path,
				force: opts.force,
				all: opts.all,
				dryRun: opts.dryRun,
			});
		});
}
