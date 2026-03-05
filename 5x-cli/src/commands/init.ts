/**
 * Init command — citty adapter.
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
