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
	args: {},
	run: () => runQuality(),
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
