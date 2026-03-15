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
			"Create, attach, detach, and remove git worktrees that isolate plan execution\n" +
				"from the main working tree. Worktrees are tracked in the run database and\n" +
				"automatically resolved by commands that accept --run.",
		);

	worktree
		.command("create")
		.summary("Create a git worktree for a plan")
		.description(
			"Create a new git worktree and associate it with an implementation plan. The\n" +
				"branch name defaults to a sanitized form of the plan filename. The worktree\n" +
				"is registered in the database for automatic resolution.",
		)
		.requiredOption("-p, --plan <path>", "Path to implementation plan")
		.option(
			"-b, --branch <name>",
			"Branch name (default: derived from plan filename)",
		)
		.option(
			"--allow-nested",
			"Allow creating a worktree from a linked-worktree context",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x worktree create -p plan.md\n" +
				"  $ 5x worktree create -p plan.md -b feature/my-branch\n" +
				"  $ 5x worktree create -p plan.md --allow-nested",
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
		.description(
			"Associate an existing git worktree with a plan in the database. Use this\n" +
				"when the worktree was created outside of 5x.",
		)
		.requiredOption("-p, --plan <path>", "Path to implementation plan")
		.requiredOption("--path <dir>", "Path to existing git worktree")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x worktree attach -p plan.md --path /tmp/existing-worktree",
		)
		.action(async (opts) => {
			await worktreeAttach({
				plan: opts.plan,
				path: opts.path,
			});
		});

	worktree
		.command("detach")
		.summary("Detach a plan from its worktree")
		.description(
			"Remove the association between a plan and its worktree in the database. The\n" +
				"git worktree itself is not removed.",
		)
		.requiredOption("-p, --plan <path>", "Path to implementation plan")
		.addHelpText("after", "\nExamples:\n" + "  $ 5x worktree detach -p plan.md")
		.action(async (opts) => {
			await worktreeDetach({
				plan: opts.plan,
			});
		});

	worktree
		.command("remove")
		.summary("Remove a worktree for a plan")
		.description(
			"Delete the git worktree associated with a plan and remove the database\n" +
				"association. Use --force to remove even with uncommitted changes.",
		)
		.requiredOption("-p, --plan <path>", "Path to implementation plan")
		.option("-f, --force", "Remove even with uncommitted changes")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x worktree remove -p plan.md\n" +
				"  $ 5x worktree remove -p plan.md -f                  # force remove dirty",
		)
		.action(async (opts) => {
			await worktreeRemove({
				plan: opts.plan,
				force: opts.force,
			});
		});

	worktree
		.command("list")
		.summary("List active worktrees")
		.description(
			"Show all worktrees tracked in the project database with their associated\n" +
				"plans and paths.",
		)
		.addHelpText("after", "\nExamples:\n" + "  $ 5x worktree list")
		.action(async () => {
			await worktreeList();
		});
}
