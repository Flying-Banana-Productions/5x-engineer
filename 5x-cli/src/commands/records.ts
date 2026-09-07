/**
 * Records commands — commander adapter.
 *
 * Registers `5x records index [--plan <slug>]` and
 * `5x records backfill [--plan <slug>] [--target auto|<branch>] [--dry-run]`.
 *
 * `--target auto` does not fetch; it uses already-present remote-tracking refs.
 */

import type { Command } from "@commander-js/extra-typings";
import { recordsBackfill, recordsIndex } from "./records.handler.js";

export function registerRecords(parent: Command): void {
	const records = parent
		.command("records")
		.summary("Git-native run record index and backfill")
		.description(
			"Rebuild the local SQLite index from git-tracked run records, or export\n" +
				"historical SQLite rows into the record format.",
		);

	records
		.command("index")
		.summary("Rebuild the SQLite index from git records")
		.description(
			"Materialize `runs` / `steps` from the resolved git record. Origin is not\n" +
				"copied into SQLite. Newer local-only SQLite steps are kept.",
		)
		.option("--plan <slug>", "Limit indexing to one plan slug")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x records index\n" +
				"  $ 5x records index --plan alpha\n" +
				"  $ 5x --text records index\n",
		)
		.action(async (opts) => {
			await recordsIndex({
				plan: opts.plan,
				startDir: process.cwd(),
			});
		});

	records
		.command("backfill")
		.summary("Export SQLite history into git-native run records")
		.description(
			"Write run.json / JSONL from existing SQLite runs with provenance\n" +
				"backfilled, origin null, and a separate exporter materializer.\n" +
				"--target auto does not fetch; fetch remote 5x/<slug> refs first if needed.",
		)
		.option("--plan <slug>", "Limit export to one plan slug")
		.option(
			"--target <branch>",
			"Branch to write (default auto: 5x/<slug> if it exists, else current)",
			"auto",
		)
		.option("--dry-run", "Print the run → target mapping without writing")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x records backfill --dry-run\n" +
				"  $ 5x records backfill --plan alpha\n" +
				"  $ 5x records backfill --target auto\n" +
				"  $ 5x records backfill --target main\n",
		)
		.action(async (opts) => {
			await recordsBackfill({
				plan: opts.plan,
				target: opts.target,
				dryRun: opts.dryRun,
				startDir: process.cwd(),
			});
		});
}
