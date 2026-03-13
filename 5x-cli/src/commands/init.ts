/**
 * Init command — citty adapter.
 *
 * Leaf command (no subcommands). Runs `initScaffold` to set up the 5x
 * control plane in the current project.
 *
 * Harness integrations (OpenCode, Claude Code, etc.) are installed via
 * `5x harness install <name>` — see harness.ts.
 *
 * Business logic lives in init.handler.ts.
 */

import { defineCommand } from "citty";
import { initScaffold } from "./init.handler.js";

export default defineCommand({
	meta: {
		name: "init",
		description: "Initialize 5x workflow in the current project",
	},
	args: {
		force: {
			type: "boolean",
			description: "Overwrite existing config file",
			default: false,
		},
	},
	run: ({ args }) =>
		initScaffold({
			force: args.force as boolean | undefined,
		}),
});
