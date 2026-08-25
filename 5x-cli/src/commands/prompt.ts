/**
 * v1 Human interaction commands — commander adapter.
 *
 * `5x prompt choose <message> --options <a,b,c> [--default <a>] [--run <id>] [--timeout <ms>]`
 * `5x prompt confirm <message> [--default yes|no] [--run <id>] [--timeout <ms>]`
 * `5x prompt input <message> [--multiline] [--run <id>] [--timeout <ms>]`
 *
 * Business logic lives in prompt.handler.ts.
 */

import type { Command } from "@commander-js/extra-typings";
import { intArg } from "../utils/parse-args.js";
import { promptChoose, promptConfirm, promptInput } from "./prompt.handler.js";
import { defaultResolvePromptContext } from "./prompt-context.js";

const promptDeps = { resolveContext: defaultResolvePromptContext };

export function registerPrompt(parent: Command) {
	const prompt = parent
		.command("prompt")
		.summary("Human interaction prompts")
		.description(
			"Present interactive prompts to the user and return their response as JSON.\n" +
				"Used by agent orchestration to gather human input. Supports non-interactive\n" +
				"mode via defaults for CI/automation.",
		);

	prompt
		.command("choose")
		.summary("Present a choice prompt")
		.description(
			"Display a list of options and wait for the user to select one. Returns the\n" +
				"chosen value. In non-interactive environments, uses --default if provided.",
		)
		.argument("<message>", "Prompt message")
		.requiredOption("-o, --options <list>", "Comma-separated list of options")
		.option(
			"-d, --default <value>",
			"Default option (used in non-interactive mode)",
		)
		.option("--run <id>", "Associate this prompt with a run id")
		.option(
			"--timeout <ms>",
			"Max wait in ms (TTY and no-TTY input pipe: unbounded if omitted; no-TTY choose/confirm without --default: 0)",
			intArg("--timeout"),
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				'  $ 5x prompt choose "Pick a strategy" -o "proceed,skip,abort"\n' +
				'  $ 5x prompt choose "Action?" -o "approve,reject" -d approve',
		)
		.action(async (message, opts) => {
			await promptChoose(
				{
					message,
					options: opts.options,
					default: opts.default,
					run: opts.run,
					timeout: opts.timeout,
				},
				promptDeps,
			);
		});

	prompt
		.command("confirm")
		.summary("Present a yes/no confirmation prompt")
		.description(
			"Display a yes/no confirmation and return the boolean result. In\n" +
				"non-interactive environments, uses --default if provided.",
		)
		.argument("<message>", "Prompt message")
		.option("-d, --default <value>", 'Default value: "yes" or "no"')
		.option("--run <id>", "Associate this prompt with a run id")
		.option(
			"--timeout <ms>",
			"Max wait in ms (TTY and no-TTY input pipe: unbounded if omitted; no-TTY choose/confirm without --default: 0)",
			intArg("--timeout"),
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				'  $ 5x prompt confirm "Deploy to production?"\n' +
				'  $ 5x prompt confirm "Continue?" -d yes',
		)
		.action(async (message, opts) => {
			await promptConfirm(
				{
					message,
					default: opts.default,
					run: opts.run,
					timeout: opts.timeout,
				},
				promptDeps,
			);
		});

	prompt
		.command("input")
		.summary("Read text input from user or stdin pipe")
		.description(
			"Read a line of text input. In multiline mode, reads until EOF (Ctrl+D). When\n" +
				"stdin is a pipe, reads from the pipe regardless of --multiline.",
		)
		.argument("<message>", "Prompt message")
		.option("--multiline", "Read multiline input (Ctrl+D to finish)")
		.option("--run <id>", "Associate this prompt with a run id")
		.option(
			"--timeout <ms>",
			"Max wait in ms (TTY and no-TTY input pipe: unbounded if omitted; no-TTY choose/confirm without --default: 0)",
			intArg("--timeout"),
		)
		.addHelpText(
			"after",
			"\nExamples:\n" +
				'  $ 5x prompt input "Enter your feedback"\n' +
				'  $ 5x prompt input "Paste content" --multiline\n' +
				'  $ echo "automated input" | 5x prompt input "Question"',
		)
		.action(async (message, opts) => {
			await promptInput(
				{
					message,
					multiline: opts.multiline,
					run: opts.run,
					timeout: opts.timeout,
				},
				promptDeps,
			);
		});
}
