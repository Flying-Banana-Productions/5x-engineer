/**
 * v1 Diff command — citty adapter.
 *
 * `5x diff [--since <ref>] [--stat]`
 *
 * Business logic lives in diff.handler.ts.
 */

import { defineCommand } from "citty";
import { runDiff } from "./diff.handler.js";

export default defineCommand({
	meta: {
		name: "diff",
		description: "Get a git diff relative to a reference",
	},
	args: {
		since: {
			type: "string",
			description:
				"Git ref to diff against (commit, branch, tag). If omitted, diffs working tree against HEAD.",
		},
		stat: {
			type: "boolean",
			description: "Include diffstat summary",
			default: false,
		},
	},
	run: ({ args }) =>
		runDiff({
			since: args.since as string | undefined,
			stat: args.stat as boolean | undefined,
		}),
});
