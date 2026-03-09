/**
 * v1 Worktree management commands — citty adapter.
 *
 * Subcommands: create, remove, list
 *
 * Business logic lives in worktree.handler.ts.
 */

import { defineCommand } from "citty";
import {
	worktreeAttach,
	worktreeCreate,
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
	},
	run: ({ args }) =>
		worktreeCreate({
			plan: args.plan as string,
			branch: args.branch as string | undefined,
		}),
});

const removeCmd = defineCommand({
	meta: {
		name: "remove",
		description: "Remove a worktree for a plan",
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
		description: "Manage git worktrees for plan execution",
	},
	subCommands: {
		create: () => Promise.resolve(createCmd),
		attach: () => Promise.resolve(attachCmd),
		remove: () => Promise.resolve(removeCmd),
		list: () => Promise.resolve(listCmd),
	},
});
