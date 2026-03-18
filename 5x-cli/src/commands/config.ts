/**
 * Config management commands — commander adapter.
 *
 * Subcommands: show
 *
 * Business logic lives in config.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { configShow } from "./config.handler.js";

export function registerConfig(parent: Command) {
	const config = parent
		.command("config")
		.summary("Configuration operations")
		.description(
			"Inspect the resolved 5x configuration. Configuration is loaded from\n" +
				"5x.toml (or 5x.config.js/mjs) with layered resolution for sub-project\n" +
				"overrides.",
		);

	config
		.command("show")
		.summary("Display the resolved configuration")
		.description(
			"Show the fully resolved configuration including defaults, config file\n" +
				"values, and layered overrides. Use --context to resolve config from a\n" +
				"specific directory context (e.g. a sub-project).",
		)
		.option(
			"--context <dir>",
			"Config context directory for layered resolution",
			process.cwd(),
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x config show\n" +
				"  $ 5x config show --context packages/api\n" +
				"  $ 5x config show --text",
		)
		.action(async (opts) => {
			await configShow({
				contextDir: opts.context,
			});
		});
}
