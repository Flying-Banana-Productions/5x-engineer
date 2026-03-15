/**
 * Harness command — commander adapter.
 *
 * Dispatch-only parent with `install`, `list`, and `uninstall` subcommands.
 *
 * Business logic lives in harness.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import {
	harnessInstall,
	harnessList,
	harnessUninstall,
} from "./harness.handler.js";

export function registerHarness(parent: Command) {
	const harness = parent
		.command("harness")
		.summary("Manage harness integrations (OpenCode, Claude Code, etc.)")
		.description("Manage harness integrations (OpenCode, Claude Code, etc.)");

	harness
		.command("install")
		.summary("Install a harness integration (skills + agent profiles)")
		.description("Install a harness integration (skills + agent profiles)")
		.argument("<name>", "Harness name (e.g. opencode)")
		.option("-s, --scope <scope>", "Install scope: user or project")
		.option("-f, --force", "Overwrite existing skill and agent files")
		.action(async (name, opts) => {
			await harnessInstall({
				name,
				scope: opts.scope,
				force: opts.force,
				homeDir: process.env.HOME,
			});
		});

	harness
		.command("list")
		.summary("List available harness integrations")
		.description("List available harness integrations")
		.action(async () => {
			await harnessList({ homeDir: process.env.HOME });
		});

	harness
		.command("uninstall")
		.summary("Uninstall a harness integration (remove skills + agent profiles)")
		.description(
			"Uninstall a harness integration (remove skills + agent profiles)",
		)
		.argument("<name>", "Harness name (e.g. opencode)")
		.option("-s, --scope <scope>", "Uninstall scope: user or project")
		.option("--all", "Uninstall from all supported scopes")
		.action(async (name, opts) => {
			await harnessUninstall({
				name,
				scope: opts.scope,
				all: opts.all,
				homeDir: process.env.HOME,
			});
		});
}
