/**
 * Init command — commander adapter.
 *
 * Leaf command (no subcommands). Runs `initScaffold` to set up the 5x
 * control plane in the current project.
 *
 * Harness integrations (OpenCode, Claude Code, etc.) are installed via
 * `5x harness install <name>` — see harness.ts.
 *
 * Business logic lives in init.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { initScaffold } from "./init.handler.js";

export function registerInit(parent: Command) {
	parent
		.command("init")
		.summary("Initialize 5x workflow in the current project")
		.description(
			"Create the .5x directory structure in the current project (no root 5x.toml —\n" +
				"defaults come from the built-in schema). Sets up the SQLite database,\n" +
				"default templates, and .gitignore entries. Use --force to overwrite\n" +
				"scaffolded templates. Use --sub-project-path after a root init to add a\n" +
				"paths-only 5x.toml for a monorepo package.",
		)
		.option(
			"-f, --force",
			"Overwrite existing scaffolded files where applicable",
		)
		.option(
			"--install-templates",
			"Scaffold editable prompt templates to .5x/templates/prompts/ (root init only)",
		)
		.option(
			"--sub-project-path <relativePath>",
			"After root init: write a minimal [paths] 5x.toml under this path (relative to cwd)",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x init\n" +
				"  $ 5x init -f                                        # overwrite templates / sub-project toml\n" +
				"  $ 5x init --install-templates                       # scaffold prompt templates for customization\n" +
				"  $ 5x init --install-templates -f                    # reinstall prompt templates (overwrites)\n" +
				"  $ 5x init --sub-project-path packages/api           # paths-only config for a package",
		)
		.action(async (opts) => {
			await initScaffold({
				force: opts.force,
				installTemplates: opts.installTemplates,
				subProjectPath: opts.subProjectPath,
			});
		});
}
