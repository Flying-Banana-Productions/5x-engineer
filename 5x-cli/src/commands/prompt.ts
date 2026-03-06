/**
 * v1 Human interaction commands — citty adapter.
 *
 * `5x prompt choose <message> --options <a,b,c> [--default <a>]`
 * `5x prompt confirm <message> [--default yes|no]`
 * `5x prompt input <message> [--multiline]`
 *
 * Business logic lives in prompt.handler.ts.
 */

import { defineCommand } from "citty";
import { promptChoose, promptConfirm, promptInput } from "./prompt.handler.js";

const chooseCmd = defineCommand({
	meta: {
		name: "choose",
		description: "Present a choice prompt",
	},
	args: {
		message: {
			type: "positional",
			description: "Prompt message",
			required: true,
		},
		options: {
			type: "string",
			description: "Comma-separated list of options",
			required: true,
		},
		default: {
			type: "string",
			description: "Default option (used in non-interactive mode)",
		},
	},
	run: ({ args }) =>
		promptChoose({
			message: args.message as string,
			options: args.options as string,
			default: args.default as string | undefined,
		}),
});

const confirmCmd = defineCommand({
	meta: {
		name: "confirm",
		description: "Present a yes/no confirmation prompt",
	},
	args: {
		message: {
			type: "positional",
			description: "Prompt message",
			required: true,
		},
		default: {
			type: "string",
			description: 'Default value: "yes" or "no"',
		},
	},
	run: ({ args }) =>
		promptConfirm({
			message: args.message as string,
			default: args.default as string | undefined,
		}),
});

const inputCmd = defineCommand({
	meta: {
		name: "input",
		description: "Read text input from user or stdin pipe",
	},
	args: {
		message: {
			type: "positional",
			description: "Prompt message",
			required: true,
		},
		multiline: {
			type: "boolean",
			description: "Read multiline input (Ctrl+D to finish)",
			default: false,
		},
	},
	run: ({ args }) =>
		promptInput({
			message: args.message as string,
			multiline: args.multiline as boolean | undefined,
		}),
});

export default defineCommand({
	meta: {
		name: "prompt",
		description: "Human interaction prompts",
	},
	subCommands: {
		choose: () => Promise.resolve(chooseCmd),
		confirm: () => Promise.resolve(confirmCmd),
		input: () => Promise.resolve(inputCmd),
	},
});
