/**
 * Init command — citty adapter.
 *
 * Parent command with subcommands pattern (same as `skills` command).
 *
 * - Bare `5x init [--force]` runs `initScaffold` via the parent `run` handler.
 * - `5x init opencode <user|project>` is a subcommand for harness-native installs.
 *
 * Business logic lives in init.handler.ts.
 */

import { defineCommand } from "citty";
import { initOpencode, initScaffold } from "./init.handler.js";

const opencodeCmd = defineCommand({
	meta: {
		name: "opencode",
		description: "Install 5x skills and native subagent profiles for OpenCode",
	},
	args: {
		scope: {
			type: "positional" as const,
			description:
				"Install scope: user (~/.config/opencode/) or project (.opencode/)",
			required: true as const,
		},
		force: {
			type: "boolean" as const,
			description: "Overwrite existing skill and agent files",
			default: false,
		},
	},
	run: ({ args }) =>
		initOpencode({
			scope: args.scope as "user" | "project",
			force: args.force as boolean | undefined,
		}),
});

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
	subCommands: {
		opencode: () => Promise.resolve(opencodeCmd),
	},
	run: ({ args }) =>
		initScaffold({
			force: args.force as boolean | undefined,
		}),
});
