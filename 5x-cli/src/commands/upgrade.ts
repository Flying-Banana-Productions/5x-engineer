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
		.summary("Upgrade project config, database, and templates")
		.description(
			"Run database migrations, update prompt templates, and apply any configuration\n" +
				"schema changes for the current 5x version. Safe to run multiple times; skips\n" +
				"already up-to-date components unless --force is used.",
		)
		.option("-f, --force", "Overwrite templates even if already up-to-date")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x upgrade\n" +
				"  $ 5x upgrade -f                                     # force template refresh",
		)
		.action(async (opts) => {
			await runUpgrade({
				force: opts.force,
			});
		});
}
