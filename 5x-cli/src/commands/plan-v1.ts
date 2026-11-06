/**
 * v1 Plan inspection command — commander adapter.
 *
 * `5x plan phases <path>`
 *
 * Business logic lives in plan-v1.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { outputError, outputSuccess } from "../output.js";
import { resolveDbContext } from "./context.js";
import { repairChecklists } from "./plan-checklist-repair.handler.js";
import { planMigrate } from "./plan-migrate.handler.js";
import { planArchive, planList, planPhases } from "./plan-v1.handler.js";
import { createReviewBudgetContext } from "./review-budget-context.js";

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

async function repairRunContext(runId: string) {
	const dbContext = await resolveDbContext();
	if (!dbContext.controlPlane)
		outputError(
			"NO_CONTROL_PLANE",
			"No 5x control-plane DB found. Initialize with 5x init first.",
		);
	return createReviewBudgetContext({ runId, dbContext }, (message) =>
		console.error(`Warning: ${message}`),
	);
}

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
		.option("--source <source>", "Read the supplied local file (local)")
		.option("--ref <ref>", "Read a committed snapshot at the selected ref tip")
		.option(
			"--fetch",
			"Fetch remote 5x/* branches before resolving progress (never implicit)",
		)
		.option(
			"--all-refs",
			"Discover progress from all refs, not only 5x/<slug> and HEAD",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x plan phases docs/development/015-test-separation.md\n" +
				"  $ 5x plan phases ./plan.md | jq '.data.phases[].name'\n" +
				"  $ 5x plan phases ./plan.md --fetch\n" +
				"  PS> $j = 5x plan phases .\\plan.md | ConvertFrom-Json\n" +
				"  PS> $j.data.phases\n\n" +
				"If you are outside the control-plane repo or worktree mapping cannot be resolved,\n" +
				"use the worktree plan path from `5x run state` (for example `worktree_plan_path`).",
		)
		.action(async (path, opts) => {
			await planPhases({
				path,
				source: opts.source,
				ref: opts.ref,
				fetch: opts.fetch,
				allRefs: opts.allRefs,
			});
		});

	plan
		.command("list")
		.option("--source <source>", "Read plans from the local checkout (local)")
		.option("--ref <ref>", "Read plans at the selected ref tip")
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
		.option(
			"--fetch",
			"Fetch remote 5x/* branches before resolving progress (never implicit)",
		)
		.option(
			"--all-refs",
			"Discover plans and progress from all refs, not only 5x/<slug>",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x plan list\n" +
				"  $ 5x --text plan list\n" +
				"  $ 5x plan list --exclude-finished\n" +
				"  $ 5x plan list --fetch\n",
		)
		.action(async (opts) => {
			await planList({
				excludeFinished: opts.excludeFinished,
				source: opts.source,
				ref: opts.ref,
				fetch: opts.fetch,
				allRefs: opts.allRefs,
				startDir: process.cwd(),
			});
		});

	plan
		.command("migrate")
		.summary("Convert an unapproved plan to schema 1")
		.description(
			"Wrap an unapproved working-tree plan as schema 1, or check a selective schema 1 edit.\n" +
				"Refuses when the plan already has an implementation binding or a completed approval.\n" +
				"Writes no governance record and does not approve the plan.",
		)
		.requiredOption("--plan <path>", "Path to the unapproved plan")
		.requiredOption("--mode <mode>", "equivalent or selective")
		.option("--write", "Write the equivalent wrap when --dry-run is absent")
		.option("--dry-run", "Report the conversion without writing the file")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x plan migrate --plan docs/plan.md --mode equivalent --dry-run\n" +
				"  $ 5x plan migrate --plan docs/plan.md --mode equivalent --write\n" +
				"  $ 5x plan migrate --plan docs/plan.md --mode selective\n",
		)
		.action(async (opts) => {
			outputSuccess(
				await planMigrate({
					planPath: opts.plan,
					mode: opts.mode,
					write: opts.write,
					dryRun: opts.dryRun,
				}),
			);
		});

	plan
		.command("repair-checklists")
		.summary("Mechanically repair missing checklist markers")
		.description(
			"Convert plain list markers in identified completion-gate lists into unchecked\n" +
				"task markers. The proof allows only list-prefix changes and existing checkbox\n" +
				"toggles; requirement text, nesting, headings, budget and schema stay byte-identical.\n" +
				"--plan repairs an unapproved draft in place and records nothing. --run proves the\n" +
				"repair against the run's authorized anchor (bound execution, or a completed\n" +
				"plan-review source before binding), commits only the plan file and records a\n" +
				"plan-checklist-repair receipt on the same run. --reason records the operator's\n" +
				"instruction; no reviewer finding, gate, re-review or new run is required, and no\n" +
				"phase is marked complete. Usable while admission reports drift. Repaired runs\n" +
				"need a CLI that understands plan-checklist-repair lineage.",
		)
		.option("--plan <path>", "Unapproved draft plan file")
		.option("--run <id>", "Bound execution run or completed plan-review run")
		.option("--dry-run", "Preview the exact edits without writing")
		.option("--apply", "Write (and on --run, commit and record) the repair")
		.option(
			"--reason <text>",
			"Operator instruction being recorded (required with --run --apply)",
		)
		.option(
			"--phase <id>",
			"Repair this phase (repeatable); replaces the default selection",
			collect,
			[] as string[],
		)
		.option(
			"--lines <start-end>",
			"Repair only list items in this raw line range (repeatable)",
			collect,
			[] as string[],
		)
		.option(
			"--intent <digest>",
			"Preview digest; a changed candidate is re-previewed instead of applied",
		)
		.option(
			"--no-checkpoint",
			"Leave the run's records uncommitted after recording",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x plan repair-checklists --plan docs/plan.md --dry-run\n" +
				"  $ 5x plan repair-checklists --plan docs/plan.md --apply\n" +
				"  $ 5x plan repair-checklists --run <id> --dry-run\n" +
				'  $ 5x plan repair-checklists --run <id> --apply --intent <digest> --reason "Operator authorized checklist-format repair and continuation"\n' +
				"  $ 5x plan repair-checklists --run <id> --phase 2 --lines 40-52 --dry-run\n",
		)
		.action(async (opts) => {
			outputSuccess(
				await repairChecklists(
					{
						planPath: opts.plan,
						runId: opts.run,
						dryRun: opts.dryRun,
						apply: opts.apply,
						reason: opts.reason,
						phases: opts.phase,
						lines: opts.lines,
						intent: opts.intent,
						checkpoint: opts.checkpoint,
						startDir: process.cwd(),
					},
					repairRunContext,
				),
			);
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
