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
		.summary(
			"Upgrade project config, database, and templates to the latest version",
		)
		.description(
			"Upgrade project config, database, and templates to the latest version",
		)
		.option("-f, --force", "Overwrite templates even if already up-to-date")
		.action(async (opts) => {
			await runUpgrade({
				force: opts.force,
			});
		});
}
