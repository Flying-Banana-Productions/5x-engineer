/**
 * v1 Commit command — commander adapter.
 *
 * `5x commit --run <id> -m <msg> [--files <paths...> | --all-files] [--phase <p>] [--dry-run]`
 *
 * Atomically stages files, creates a git commit, and records a `git:commit`
 * step in the run's step journal. Business logic lives in commit.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { runCommit } from "./commit.handler.js";

export function registerCommit(parent: Command) {
	parent
		.command("commit")
		.summary("Create a tracked git commit for a run")
		.description(
			"Stage files, create a git commit, and record it as a `git:commit` step\n" +
				"in the run journal. Either --files or --all-files is required.",
		)
		.requiredOption("-r, --run <id>", "Run ID")
		.requiredOption("-m, --message <msg>", "Commit message")
		.option("--files <paths...>", "Specific files to stage")
		.option("--all-files", "Stage all changes (git add -A)")
		.option("--phase <phase>", "Phase identifier for the step")
		.option("--dry-run", "Preview what would happen without side effects")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				'  $ 5x commit --run abc123 -m "implement feature" --all-files\n' +
				'  $ 5x commit --run abc123 -m "fix bug" --files src/foo.ts src/bar.ts\n' +
				'  $ 5x commit --run abc123 -m "test" --all-files --dry-run',
		)
		.action(async (opts) => {
			// Mutual exclusion validation
			if (opts.files && opts.allFiles) {
				const { outputError } = await import("../output.js");
				outputError(
					"INVALID_ARGS",
					"--files and --all-files are mutually exclusive. Provide one or the other.",
				);
			}
			if (!opts.files && !opts.allFiles) {
				const { outputError } = await import("../output.js");
				outputError(
					"INVALID_ARGS",
					"Either --files or --all-files is required.",
				);
			}

			await runCommit({
				run: opts.run,
				message: opts.message,
				files: opts.files,
				allFiles: opts.allFiles,
				phase: opts.phase,
				dryRun: opts.dryRun,
			});
		});
}
