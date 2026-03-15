/**
 * v1 Diff command — commander adapter.
 *
 * `5x diff [--since <ref>] [--stat] [--run <id>]`
 *
 * Business logic lives in diff.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { runDiff } from "./diff.handler.js";

export function registerDiff(parent: Command) {
	parent
		.command("diff")
		.summary("Show git diff relative to a reference")
		.description(
			"Generate a git diff of the working tree or a worktree associated with a run.\n" +
				"Without --since, diffs the working tree against HEAD. With --since, diffs\n" +
				"against the specified git ref. Use --stat for a summary of changed files.",
		)
		.option(
			"-s, --since <ref>",
			"Git ref to diff against (commit, branch, tag). If omitted, diffs working tree against HEAD.",
		)
		.option("--stat", "Include diffstat summary")
		.option(
			"-r, --run <id>",
			"Run ID — resolve mapped worktree and diff in that directory",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x diff\n" +
				"  $ 5x diff -s main                                   # diff against main\n" +
				"  $ 5x diff -s HEAD~3 --stat                          # summary of last 3 commits\n" +
				"  $ 5x diff -r abc123                                 # diff in run's worktree",
		)
		.action(async (opts) => {
			await runDiff({
				since: opts.since,
				stat: opts.stat,
				run: opts.run,
			});
		});
}
