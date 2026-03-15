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
		.summary("Get a git diff relative to a reference")
		.description("Get a git diff relative to a reference")
		.option(
			"-s, --since <ref>",
			"Git ref to diff against (commit, branch, tag). If omitted, diffs working tree against HEAD.",
		)
		.option("--stat", "Include diffstat summary")
		.option(
			"-r, --run <id>",
			"Run ID — resolve mapped worktree and diff in that directory",
		)
		.action(async (opts) => {
			await runDiff({
				since: opts.since,
				stat: opts.stat,
				run: opts.run,
			});
		});
}
