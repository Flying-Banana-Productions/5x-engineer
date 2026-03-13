/**
 * Template management commands — citty adapter.
 *
 * Subcommands: render
 *
 * Business logic lives in template.handler.ts.
 */

import { defineCommand } from "citty";
import { templateRender } from "./template.handler.js";

const renderCmd = defineCommand({
	meta: {
		name: "render",
		description:
			"Render a prompt template with variable substitution (no provider invocation)",
	},
	args: {
		template: {
			type: "positional" as const,
			description: "Template name (e.g. reviewer-plan, author-next-phase)",
			required: true as const,
		},
		run: {
			type: "string" as const,
			description:
				"Run ID — enables run/worktree context resolution and plan path injection",
		},
		var: {
			type: "string" as const,
			description: "Template variable (key=value, repeatable)",
		},
		session: {
			type: "string" as const,
			description:
				"Session ID — triggers continued-template selection when available",
		},
		workdir: {
			type: "string" as const,
			description: "Working directory override (explicit --workdir wins)",
		},
	},
	run: ({ args }) =>
		templateRender({
			template: args.template as string,
			run: args.run as string | undefined,
			vars: args.var as string | string[] | undefined,
			session: args.session as string | undefined,
			workdir: args.workdir as string | undefined,
		}),
});

export default defineCommand({
	meta: {
		name: "template",
		description: "Prompt template operations",
	},
	subCommands: {
		render: () => Promise.resolve(renderCmd),
	},
});
