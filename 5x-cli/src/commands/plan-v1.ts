/**
 * v1 Plan inspection command — citty adapter.
 *
 * `5x plan phases <path>`
 *
 * Business logic lives in plan-v1.handler.ts.
 */

import { defineCommand } from "citty";
import { planPhases } from "./plan-v1.handler.js";

const phasesCmd = defineCommand({
	meta: {
		name: "phases",
		description: "Parse a plan and return its phases",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to implementation plan",
			required: true,
		},
	},
	run: ({ args }) =>
		planPhases({
			path: args.path as string,
		}),
});

export default defineCommand({
	meta: {
		name: "plan",
		description: "Plan inspection operations",
	},
	subCommands: {
		phases: () => Promise.resolve(phasesCmd),
	},
});
