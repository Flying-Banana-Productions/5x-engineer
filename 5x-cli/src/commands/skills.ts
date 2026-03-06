/**
 * Skills management commands — citty adapter.
 *
 * Subcommands: install
 *
 * Business logic lives in skills.handler.ts.
 */

import { defineCommand } from "citty";
import { skillsInstall } from "./skills.handler.js";

const installCmd = defineCommand({
	meta: {
		name: "install",
		description:
			"Install skills for agent client discovery (agentskills.io convention)",
	},
	args: {
		scope: {
			type: "positional" as const,
			description:
				"Install scope: user (~/.agents/skills/) or project (.agents/skills/)",
			required: true as const,
		},
		force: {
			type: "boolean" as const,
			description: "Overwrite existing skill files",
			default: false,
		},
		"install-root": {
			type: "string" as const,
			description:
				'Override the default ".agents" directory name (e.g. ".claude", ".opencode")',
		},
	},
	run: ({ args }) =>
		skillsInstall({
			scope: args.scope as "user" | "project",
			force: args.force as boolean | undefined,
			installRoot: args["install-root"] as string | undefined,
		}),
});

export default defineCommand({
	meta: {
		name: "skills",
		description: "Manage agent skills",
	},
	subCommands: {
		install: () => Promise.resolve(installCmd),
	},
});
