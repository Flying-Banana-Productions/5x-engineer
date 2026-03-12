/**
 * Harness command — citty adapter.
 *
 * Dispatch-only parent with `install` and `list` subcommands.
 * No parent `run` handler — avoids the citty fall-through issue entirely.
 *
 * Business logic lives in harness.handler.ts.
 */

import { defineCommand } from "citty";
import { harnessInstall, harnessList } from "./harness.handler.js";

const installCmd = defineCommand({
	meta: {
		name: "install",
		description: "Install a harness integration (skills + agent profiles)",
	},
	args: {
		name: {
			type: "positional" as const,
			description: "Harness name (e.g. opencode)",
			required: true as const,
		},
		scope: {
			type: "string" as const,
			description: "Install scope: user or project",
		},
		force: {
			type: "boolean" as const,
			description: "Overwrite existing skill and agent files",
			default: false,
		},
	},
	run: ({ args }) =>
		harnessInstall({
			name: args.name as string,
			scope: args.scope as string | undefined,
			force: args.force as boolean | undefined,
		}),
});

const listCmd = defineCommand({
	meta: {
		name: "list",
		description: "List available harness integrations",
	},
	run: () => harnessList(),
});

export default defineCommand({
	meta: {
		name: "harness",
		description: "Manage harness integrations (OpenCode, Claude Code, etc.)",
	},
	subCommands: {
		install: () => Promise.resolve(installCmd),
		list: () => Promise.resolve(listCmd),
	},
});
