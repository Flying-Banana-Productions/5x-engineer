/**
 * v1 Quality gate command — citty adapter.
 *
 * `5x quality run`
 *
 * Business logic lives in quality-v1.handler.ts.
 */

import { defineCommand } from "citty";
import { runQuality } from "./quality-v1.handler.js";

const runCmd = defineCommand({
	meta: {
		name: "run",
		description: "Execute configured quality gates",
	},
	args: {
		record: {
			type: "boolean" as const,
			description:
				'Auto-record the result as a run step (default step name: "quality:check")',
		},
		"record-step": {
			type: "string" as const,
			description:
				'Override step name for recording (default: "quality:check")',
		},
		run: {
			type: "string" as const,
			description: "Run ID (required when using --record)",
		},
		phase: {
			type: "string" as const,
			description: "Phase identifier (used with --record)",
		},
	},
	run: ({ args }) =>
		runQuality({
			record: args.record as boolean | undefined,
			recordStep: args["record-step"] as string | undefined,
			run: args.run as string | undefined,
			phase: args.phase as string | undefined,
		}),
});

export default defineCommand({
	meta: {
		name: "quality",
		description: "Quality gate operations",
	},
	subCommands: {
		run: () => Promise.resolve(runCmd),
	},
});
