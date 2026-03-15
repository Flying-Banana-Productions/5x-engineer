/**
 * v1 Worktree management commands — commander adapter.
 *
 * Subcommands: create, attach, detach, remove, list
 *
 * Business logic lives in worktree.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import {
	worktreeAttach,
	worktreeCreate,
	worktreeDetach,
	worktreeList,
	worktreeRemove,
} from "./worktree.handler.js";

export function registerWorktree(parent: Command) {
	const worktree = parent
		.command("worktree")
		.summary("Manage git worktrees for plan execution")
		.description(
			"Manage git worktrees for plan execution. In managed mode, run from the main checkout; worktree create is blocked from linked worktrees unless --allow-nested is passed.",
		);

	worktree
		.command("create")
		.summary("Create a git worktree for a plan")
		.description("Create a git worktree for a plan")
		.requiredOption("-p, --plan <path>", "Path to implementation plan")
		.option(
			"-b, --branch <name>",
			"Branch name (default: derived from plan filename)",
		)
		.option(
			"--allow-nested",
			"Allow creating a worktree from a linked-worktree context",
		)
		.action(async (opts) => {
			await worktreeCreate({
				plan: opts.plan,
				branch: opts.branch,
				allowNested: opts.allowNested,
			});
		});

	worktree
		.command("attach")
		.summary("Attach an existing git worktree to a plan")
		.description("Attach an existing git worktree to a plan")
		.requiredOption("-p, --plan <path>", "Path to implementation plan")
		.requiredOption("--path <dir>", "Path to existing git worktree")
		.action(async (opts) => {
			await worktreeAttach({
				plan: opts.plan,
				path: opts.path,
			});
		});

	worktree
		.command("detach")
		.summary("Detach a plan from its worktree without deleting the worktree")
		.description(
			"Detach a plan from its worktree without deleting the worktree",
		)
		.requiredOption("-p, --plan <path>", "Path to implementation plan")
		.action(async (opts) => {
			await worktreeDetach({
				plan: opts.plan,
			});
		});

	worktree
		.command("remove")
		.summary("Remove a worktree for a plan")
		.description(
			"Remove a worktree for a plan. Cannot remove the worktree you are currently inside.",
		)
		.requiredOption("-p, --plan <path>", "Path to implementation plan")
		.option("-f, --force", "Remove even with uncommitted changes")
		.action(async (opts) => {
			await worktreeRemove({
				plan: opts.plan,
				force: opts.force,
			});
		});

	worktree
		.command("list")
		.summary("List active worktrees")
		.description("List active worktrees")
		.action(async () => {
			await worktreeList();
		});
}
