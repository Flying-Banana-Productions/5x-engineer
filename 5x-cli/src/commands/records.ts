/**
 * Records commands — commander adapter.
 *
 * Registers `5x records index [--plan <slug>]`.
 * `5x records backfill` is Phase 7.
 */

import type { Command } from "@commander-js/extra-typings";
import { recordsIndex } from "./records.handler.js";

export function registerRecords(parent: Command): void {
	const records = parent
		.command("records")
		.summary("Git-native run record index")
		.description(
			"Rebuild the local SQLite index from git-tracked run records, and (later)\n" +
				"export historical SQLite rows into the record format.",
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
}
