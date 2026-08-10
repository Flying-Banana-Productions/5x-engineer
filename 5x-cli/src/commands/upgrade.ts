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
			"Run database migrations, update prompt templates, and apply any configuration\n" +
				"schema changes for the current 5x version. Safe to run multiple times; skips\n" +
				"already up-to-date components unless --force is used. Also reports harness\n" +
				"asset freshness and optionally refreshes stale installs when permitted.",
		)
		.option("-f, --force", "Overwrite templates even if already up-to-date")
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
				"  $ 5x upgrade -f                                     # force template refresh\n" +
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
