/**
 * v1 Human interaction commands — commander adapter.
 *
 * `5x prompt choose <message> --options <a,b,c> [--default <a>]`
 * `5x prompt confirm <message> [--default yes|no]`
 * `5x prompt input <message> [--multiline]`
 *
 * Business logic lives in prompt.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { promptChoose, promptConfirm, promptInput } from "./prompt.handler.js";

export function registerPrompt(parent: Command) {
	const prompt = parent
		.command("prompt")
		.summary("Human interaction prompts")
		.description("Human interaction prompts");

	prompt
		.command("choose")
		.summary("Present a choice prompt")
		.description("Present a choice prompt")
		.argument("<message>", "Prompt message")
		.requiredOption("-o, --options <list>", "Comma-separated list of options")
		.option(
			"-d, --default <value>",
			"Default option (used in non-interactive mode)",
		)
		.action(async (message, opts) => {
			await promptChoose({
				message,
				options: opts.options,
				default: opts.default,
			});
		});

	prompt
		.command("confirm")
		.summary("Present a yes/no confirmation prompt")
		.description("Present a yes/no confirmation prompt")
		.argument("<message>", "Prompt message")
		.option("-d, --default <value>", 'Default value: "yes" or "no"')
		.action(async (message, opts) => {
			await promptConfirm({
				message,
				default: opts.default,
			});
		});

	prompt
		.command("input")
		.summary("Read text input from user or stdin pipe")
		.description("Read text input from user or stdin pipe")
		.argument("<message>", "Prompt message")
		.option("--multiline", "Read multiline input (Ctrl+D to finish)")
		.action(async (message, opts) => {
			await promptInput({
				message,
				multiline: opts.multiline,
			});
		});
}
