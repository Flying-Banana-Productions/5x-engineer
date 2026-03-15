/**
 * Init command — commander adapter.
 *
 * Leaf command (no subcommands). Runs `initScaffold` to set up the 5x
 * control plane in the current project.
 *
 * Harness integrations (OpenCode, Claude Code, etc.) are installed via
 * `5x harness install <name>` — see harness.ts.
 *
 * Business logic lives in init.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { initScaffold } from "./init.handler.js";

export function registerInit(parent: Command) {
	parent
		.command("init")
		.summary("Initialize 5x workflow in the current project")
		.description("Initialize 5x workflow in the current project")
		.option("-f, --force", "Overwrite existing config file")
		.action(async (opts) => {
			await initScaffold({
				force: opts.force,
			});
		});
}
