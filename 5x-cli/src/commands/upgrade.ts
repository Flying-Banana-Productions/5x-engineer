/**
 * Upgrade command — commander adapter.
 *
 * Business logic lives in upgrade.handler.ts.
 */

import { homedir } from "node:os";
import type { Command } from "@commander-js/extra-typings";
import { runUpgrade } from "./upgrade.handler.js";

export function registerUpgrade(parent: Command) {
	parent
		.command("upgrade")
		.summary("Upgrade project config, database, and templates")
		.description(
			"Run database migrations, refresh plan/review document skeletons, and apply\n" +
				"configuration schema changes for the current 5x version. --force overwrites\n" +
				"document skeletons only; installed prompt overrides are preserved and checked.\n" +
				"Use '5x init --install-templates --force' to replace prompt overrides. Harness\n" +
				"assets refresh separately through --sync, harness.autoSync, or '5x harness sync'.",
		)
		.option(
			"-f, --force",
			"Overwrite plan/review document skeletons (not prompt overrides or harness assets)",
		)
		.option(
			"--sync",
			"Refresh stale harness assets this invocation (overrides harness.autoSync)",
		)
		.option(
			"--no-sync",
			"Report harness freshness only (overrides harness.autoSync = true)",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x upgrade\n" +
				"  $ 5x upgrade -f                                     # refresh document skeletons\n" +
				"  $ 5x upgrade --sync                                 # also refresh lossless stale harnesses\n" +
				"  $ 5x upgrade --no-sync                               # report harnesses, never write",
		)
		.action(async (opts) => {
			await runUpgrade({
				force: opts.force,
				// Tri-state: undefined when neither flag is passed. Commander maps
				// `--no-sync` → sync: false and `--sync` → sync: true.
				sync: opts.sync,
				homeDir: homedir(),
			});
		});
}
