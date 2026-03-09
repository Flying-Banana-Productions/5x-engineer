/**
 * Upgrade command — citty adapter.
 *
 * Business logic lives in upgrade.handler.ts.
 */

import { defineCommand } from "citty";
import { runUpgrade } from "./upgrade.handler.js";

export default defineCommand({
	meta: {
		name: "upgrade",
		description:
			"Upgrade project config, database, and templates to the latest version",
	},
	args: {
		force: {
			type: "boolean",
			description: "Overwrite templates even if already up-to-date",
			default: false,
		},
	},
	run: ({ args }) =>
		runUpgrade({
			force: args.force as boolean | undefined,
		}),
});
