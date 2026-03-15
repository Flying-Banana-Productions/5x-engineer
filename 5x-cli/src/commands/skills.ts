/**
 * Skills management commands — commander adapter.
 *
 * Subcommands: install, uninstall
 *
 * Business logic lives in skills.handler.ts.
 */

import { Argument, type Command } from "@commander-js/extra-typings";
import { skillsInstall, skillsUninstall } from "./skills.handler.js";

export function registerSkills(parent: Command) {
	const skills = parent
		.command("skills")
		.summary("Manage agent skills")
		.description(
			"Install and uninstall 5x skill files that are discovered by AI agent clients.\n" +
				"Skills provide structured instructions for plan authoring, code review, and\n" +
				"phase execution.",
		);

	skills
		.command("install")
		.summary("Install skills for agent client discovery")
		.description(
			'Copy skill files to the specified scope directory. "user" installs to\n' +
				'~/.agents/skills/ for global availability; "project" installs to\n' +
				".agents/skills/ for project-scoped access.",
		)
		.addArgument(
			new Argument("<scope>", "Install scope: user or project").choices([
				"user",
				"project",
			] as const),
		)
		.option("-f, --force", "Overwrite existing skill files")
		.option(
			"--install-root <dir>",
			'Override the default ".agents" directory name (e.g. ".claude", ".opencode")',
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x skills install user\n" +
				"  $ 5x skills install project -f                      # overwrite existing\n" +
				"  $ 5x skills install project --install-root .claude   # custom directory",
		)
		.action(async (scope, opts) => {
			await skillsInstall({
				scope: scope as "user" | "project",
				force: opts.force,
				installRoot: opts.installRoot,
				homeDir: process.env.HOME,
			});
		});

	skills
		.command("uninstall")
		.summary("Uninstall skills from the specified scope")
		.description(
			'Remove 5x skill files from the specified scope. Use "all" to remove from\n' +
				"both user and project scopes.",
		)
		.addArgument(
			new Argument("<scope>", "Uninstall scope: all, user, or project").choices(
				["all", "user", "project"] as const,
			),
		)
		.option(
			"--install-root <dir>",
			'Override the default ".agents" directory name (e.g. ".claude", ".opencode")',
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x skills uninstall project\n" +
				"  $ 5x skills uninstall all",
		)
		.action(async (scope, opts) => {
			await skillsUninstall({
				scope: scope as "all" | "user" | "project",
				installRoot: opts.installRoot,
				homeDir: process.env.HOME,
			});
		});
}
