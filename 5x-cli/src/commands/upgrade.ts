/**
 * Upgrade command — commander adapter.
 *
 * Business logic lives in upgrade.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { runUpgrade } from "./upgrade.handler.js";

export function registerUpgrade(parent: Command) {
	parent
		.command("upgrade")
		.summary("Upgrade project config, database, templates, and harness assets")
		.description(
			"Run database migrations, update prompt templates, refresh harness assets,\n" +
				"and apply any configuration schema changes for the current 5x version.\n" +
				"Safe to run multiple times; skips already up-to-date components unless --force is used.",
		)
		.option("-f, --force", "Overwrite templates even if already up-to-date")
		.option("-n, --dry-run", "Show what would change without writing anything")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x upgrade\n" +
				"  $ 5x upgrade -n                                     # preview changes\n" +
				"  $ 5x upgrade -f                                     # force template refresh",
		)
		.action(async (opts) => {
			await runUpgrade({
				force: opts.force,
				dryRun: opts.dryRun,
			});
		});
}
