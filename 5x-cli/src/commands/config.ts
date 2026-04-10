/**
 * Config management commands — commander adapter.
 *
 * Subcommands: show, set, unset, add, remove
 *
 * Business logic lives in config.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import {
	configAdd,
	configRemove,
	configSet,
	configShow,
	configUnset,
} from "./config.handler.js";

export function registerConfig(parent: Command) {
	const config = parent
		.command("config")
		.summary("Configuration operations")
		.description(
			"Inspect and edit the resolved 5x configuration. Configuration is loaded from\n" +
				"5x.toml (or 5x.config.js/mjs) with layered resolution for sub-project\n" +
				"overrides. Use config set/unset/add/remove to write TOML (not JS/MJS active configs).",
		);

	config
		.command("show")
		.summary("Display the resolved configuration")
		.description(
			"Show the fully resolved configuration including defaults, config file\n" +
				"values, and layered overrides. Use --context to resolve config from a\n" +
				"specific directory context (e.g. a sub-project).",
		)
		.option(
			"--context <dir>",
			"Config context directory for layered resolution",
			process.cwd(),
		)
		.option(
			"--key <dotted.key>",
			"Show a single config entry (value-only in text mode)",
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x config show\n" +
				"  $ 5x config show --context packages/api\n" +
				"  $ 5x config show --key author.provider\n" +
				"  $ 5x config show --text",
		)
		.action(async (opts) => {
			await configShow({
				contextDir: opts.context,
				key: opts.key,
			});
		});

	config
		.command("set")
		.summary("Set a config value in TOML")
		.description(
			"Write a dotted config key to the nearest 5x.toml (or 5x.toml.local with\n" +
				"--local), creating the file if needed. Values are coerced from strings.\n" +
				"Fails when the active config source is 5x.config.js/.mjs — run `5x upgrade` first.",
		)
		.argument("<key>", "Dotted key (e.g. author.provider)")
		.argument("<value>", "Value (string; numbers and booleans are coerced)")
		.option("--local", "Write to the .local overlay beside the nearest TOML")
		.option(
			"--context <dir>",
			"Directory used to resolve nearest config (default: cwd)",
			process.cwd(),
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				"  $ 5x config set author.provider claude-code\n" +
				"  $ 5x config set maxStepsPerRun 500 --context packages/api\n" +
				"  $ 5x config set author.harnessModels.opencode gpt-5 --local\n",
		)
		.action(async (key, value, opts) => {
			await configSet({
				key,
				value,
				local: opts.local,
				contextDir: opts.context,
			});
		});

	config
		.command("unset")
		.summary("Remove a config key from TOML")
		.description(
			"Remove a dotted key from the target TOML file. Deletes the file if it\n" +
				"becomes empty. Same targeting rules as config set.",
		)
		.argument("<key>", "Dotted key to remove")
		.option("--local", "Target the .local overlay beside the nearest TOML")
		.option(
			"--context <dir>",
			"Directory used to resolve nearest config (default: cwd)",
			process.cwd(),
		)
		.action(async (key, opts) => {
			await configUnset({
				key,
				local: opts.local,
				contextDir: opts.context,
			});
		});

	config
		.command("add")
		.summary("Append a value to a string-array config key")
		.description(
			"Append a string to an array key (e.g. qualityGates). Idempotent if the\n" +
				"value is already present. Same targeting as config set (--local, --context).\n" +
				"Fails when the active config source is 5x.config.js/.mjs — run `5x upgrade` first.",
		)
		.argument("<key>", "Registry array key (e.g. qualityGates)")
		.argument("<value>", "String to append")
		.option("--local", "Write to the .local overlay beside the nearest TOML")
		.option(
			"--context <dir>",
			"Directory used to resolve nearest config (default: cwd)",
			process.cwd(),
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				'  $ 5x config add qualityGates "bun test"\n' +
				"  $ 5x config add qualityGates lint --context packages/api\n",
		)
		.action(async (key, value, opts) => {
			await configAdd({
				key,
				value,
				local: opts.local,
				contextDir: opts.context,
			});
		});

	config
		.command("remove")
		.summary("Remove a value from a string-array config key")
		.description(
			"Remove a string from an array key. Removing the last entry drops the key.\n" +
				"Same targeting as config set. Fails for JS/MJS active configs — run `5x upgrade` first.",
		)
		.argument("<key>", "Registry array key (e.g. qualityGates)")
		.argument("<value>", "String to remove")
		.option("--local", "Target the .local overlay beside the nearest TOML")
		.option(
			"--context <dir>",
			"Directory used to resolve nearest config (default: cwd)",
			process.cwd(),
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				'  $ 5x config remove qualityGates "bun test"\n' +
				"  $ 5x config remove qualityGates lint --local\n",
		)
		.action(async (key, value, opts) => {
			await configRemove({
				key,
				value,
				local: opts.local,
				contextDir: opts.context,
			});
		});
}
