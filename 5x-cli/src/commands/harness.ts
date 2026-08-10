/**
 * Harness command — commander adapter.
 *
 * Dispatch-only parent with `install`, `list`, `sync`, and `uninstall`
 * subcommands.
 *
 * Business logic lives in harness.handler.ts.
 */

import { homedir } from "node:os";
import { type Command, Option } from "@commander-js/extra-typings";
import {
	harnessInstall,
	harnessList,
	harnessSync,
	harnessUninstall,
} from "./harness.handler.js";

export function registerHarness(parent: Command) {
	const harness = parent
		.command("harness")
		.summary("Manage harness integrations")
		.description(
			"Install, list, sync, and uninstall harness integrations that connect 5x to AI\n" +
				"agent clients like OpenCode and Claude Code. Harnesses configure agent files,\n" +
				"skills, and MCP server settings.",
		);

	harness
		.command("install")
		.summary("Install a harness integration")
		.description(
			"Install a harness integration for the specified agent client. Creates\n" +
				"configuration files, agent definitions, and skill manifests. Use --scope to\n" +
				"control whether the harness is installed at user level (~/) or project level.",
		)
		.argument("<name>", "Harness name (e.g. opencode)")
		.addOption(
			new Option(
				"-s, --scope <scope>",
				"Install scope: user or project",
			).choices(["user", "project"] as const),
		)
		.option("-f, --force", "Overwrite existing skill and agent files")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x harness install opencode -s project\n" +
				"  $ 5x harness install claude-code -s user\n" +
				"  $ 5x harness install opencode -s project -f         # overwrite existing",
		)
		.action(async (name, opts) => {
			await harnessInstall({
				name,
				scope: opts.scope,
				force: opts.force,
				homeDir: homedir(),
			});
		});

	harness
		.command("list")
		.summary("List available harness integrations")
		.description(
			"Show all available harness integrations with their installation status.",
		)
		.addHelpText("after", "\nExamples:\n" + "  $ 5x harness list")
		.action(async () => {
			await harnessList({ homeDir: homedir() });
		});

	harness
		.command("sync")
		.summary("Re-render installed harness assets to match current config")
		.description(
			"Refresh installed skills and agent profiles so they match the current 5x\n" +
				"config. Targets whatever the on-disk manifests say is installed — no flags\n" +
				"required. Use --check to report without writing.",
		)
		.argument("[name]", "Harness name (default: all installed harnesses)")
		.addOption(
			new Option("-s, --scope <scope>", "Sync scope: user or project").choices([
				"user",
				"project",
			] as const),
		)
		.option("--check", "Report what would change without writing")
		.option("-f, --force", "Overwrite locally modified assets")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x harness sync                        # refresh every installed scope\n" +
				"  $ 5x harness sync opencode -s project\n" +
				"  $ 5x harness sync --check                # report only",
		)
		.action(async (name, opts) => {
			await harnessSync({
				name,
				scope: opts.scope,
				check: opts.check,
				force: opts.force,
				homeDir: homedir(),
			});
		});

	harness
		.command("uninstall")
		.summary("Uninstall a harness integration")
		.description(
			"Remove a harness integration's configuration files. Use --scope to target a\n" +
				"specific scope, or --all to remove from all scopes.",
		)
		.argument("<name>", "Harness name (e.g. opencode)")
		.addOption(
			new Option(
				"-s, --scope <scope>",
				"Uninstall scope: user or project",
			).choices(["user", "project"] as const),
		)
		.option("--all", "Uninstall from all supported scopes")
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x harness uninstall opencode -s project\n" +
				"  $ 5x harness uninstall claude-code --all",
		)
		.action(async (name, opts) => {
			await harnessUninstall({
				name,
				scope: opts.scope,
				all: opts.all,
				homeDir: homedir(),
			});
		});
}
