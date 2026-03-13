/**
 * v1 Worktree management commands — citty adapter.
 *
 * Subcommands: create, attach, detach, remove, list
 *
 * Business logic lives in worktree.handler.ts.
 */

import { defineCommand } from "citty";
import {
	worktreeAttach,
	worktreeCreate,
	worktreeDetach,
	worktreeList,
	worktreeRemove,
} from "./worktree.handler.js";

const createCmd = defineCommand({
	meta: {
		name: "create",
		description: "Create a git worktree for a plan",
	},
	args: {
		plan: {
			type: "string",
			description: "Path to implementation plan",
			required: true,
		},
		branch: {
			type: "string",
			description: "Branch name (default: derived from plan filename)",
		},
		"allow-nested": {
			type: "boolean",
			description: "Allow creating a worktree from a linked-worktree context",
			default: false,
		},
	},
	run: ({ args }) =>
		worktreeCreate({
			plan: args.plan as string,
			branch: args.branch as string | undefined,
			allowNested: args["allow-nested"] as boolean | undefined,
		}),
});

const removeCmd = defineCommand({
	meta: {
		name: "remove",
		description:
			"Remove a worktree for a plan. Cannot remove the worktree you are currently inside.",
	},
	args: {
		plan: {
			type: "string",
			description: "Path to implementation plan",
			required: true,
		},
		force: {
			type: "boolean",
			description: "Remove even with uncommitted changes",
			default: false,
		},
	},
	run: ({ args }) =>
		worktreeRemove({
			plan: args.plan as string,
			force: args.force as boolean | undefined,
		}),
});

const attachCmd = defineCommand({
	meta: {
		name: "attach",
		description: "Attach an existing git worktree to a plan",
	},
	args: {
		plan: {
			type: "string",
			description: "Path to implementation plan",
			required: true,
		},
		path: {
			type: "string",
			description: "Path to existing git worktree",
			required: true,
		},
	},
	run: ({ args }) =>
		worktreeAttach({
			plan: args.plan as string,
			path: args.path as string,
		}),
});

const detachCmd = defineCommand({
	meta: {
		name: "detach",
		description:
			"Detach a plan from its worktree without deleting the worktree",
	},
	args: {
		plan: {
			type: "string",
			description: "Path to implementation plan",
			required: true,
		},
	},
	run: ({ args }) =>
		worktreeDetach({
			plan: args.plan as string,
		}),
});

const listCmd = defineCommand({
	meta: {
		name: "list",
		description: "List active worktrees",
	},
	args: {},
	run: () => worktreeList(),
});

export default defineCommand({
	meta: {
		name: "worktree",
		description:
			"Manage git worktrees for plan execution. In managed mode, run from the main checkout; worktree create is blocked from linked worktrees unless --allow-nested is passed.",
	},
	subCommands: {
		create: () => Promise.resolve(createCmd),
		attach: () => Promise.resolve(attachCmd),
		detach: () => Promise.resolve(detachCmd),
		remove: () => Promise.resolve(removeCmd),
		list: () => Promise.resolve(listCmd),
	},
});
