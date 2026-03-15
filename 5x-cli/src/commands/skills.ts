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
		.description("Manage agent skills");

	skills
		.command("install")
		.summary(
			"Install skills for agent client discovery (agentskills.io convention)",
		)
		.description(
			"Install skills for agent client discovery (agentskills.io convention)",
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
		.summary(
			"Uninstall skills from the specified scope (agentskills.io convention)",
		)
		.description(
			"Uninstall skills from the specified scope (agentskills.io convention)",
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
		.action(async (scope, opts) => {
			await skillsUninstall({
				scope: scope as "all" | "user" | "project",
				installRoot: opts.installRoot,
				homeDir: process.env.HOME,
			});
		});
}
