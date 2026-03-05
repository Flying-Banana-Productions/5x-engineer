/**
 * v1 Human interaction commands.
 *
 * `5x prompt choose <message> --options <a,b,c> [--default <a>]`
 * `5x prompt confirm <message> [--default yes|no]`
 * `5x prompt input <message> [--multiline]`
 *
 * Presents interactive prompts when stdin is a TTY.
 * In non-TTY mode, returns defaults or throws NON_INTERACTIVE.
 */

import { defineCommand } from "citty";
import { outputError, outputSuccess } from "../output.js";

// ---------------------------------------------------------------------------
// Stdin helpers
// ---------------------------------------------------------------------------

function isTTY(): boolean {
	// Allow tests to force interactive mode via env var.
	if (process.env.FORCE_TTY === "1") return true;
	// Bun test sets NODE_ENV=test even when stdin is a TTY. Disable interactive
	// prompts in test runs to avoid hanging suites.
	if (process.env.NODE_ENV === "test") return false;
	return !!process.stdin.isTTY;
}

/** Sentinel returned by readLine when stdin receives EOF (Ctrl+D). */
const EOF = Symbol("EOF");
/** Sentinel returned by readLine when SIGINT is received. */
const SIGINT = Symbol("SIGINT");

/** Buffered leftover from previous readLine calls. */
let stdinBuffer = "";
/** Whether stdin has ended. */
let stdinEnded = false;

/** Read a single line from stdin. Returns EOF symbol on stdin close, SIGINT symbol on interrupt. */
function readLine(): Promise<string | typeof EOF | typeof SIGINT> {
	return new Promise((resolve) => {
		// Check buffer for a complete line first
		const nlIdx = stdinBuffer.indexOf("\n");
		if (nlIdx !== -1) {
			const line = stdinBuffer.slice(0, nlIdx);
			stdinBuffer = stdinBuffer.slice(nlIdx + 1);
			resolve(line);
			return;
		}

		// If stdin already ended and no newline in buffer, return EOF
		if (stdinEnded) {
			resolve(EOF);
			return;
		}

		const cleanup = () => {
			process.stdin.removeListener("data", onData);
			process.stdin.removeListener("end", onEnd);
			process.removeListener("SIGINT", onSigint);
			process.stdin.pause();
		};

		const onData = (chunk: Buffer) => {
			stdinBuffer += chunk.toString();
			const nlIdx = stdinBuffer.indexOf("\n");
			if (nlIdx !== -1) {
				const line = stdinBuffer.slice(0, nlIdx);
				stdinBuffer = stdinBuffer.slice(nlIdx + 1);
				cleanup();
				resolve(line);
			}
		};
		const onEnd = () => {
			stdinEnded = true;
			cleanup();
			resolve(EOF);
		};
		const onSigint = () => {
			cleanup();
			resolve(SIGINT);
		};
		process.stdin.resume();
		process.stdin.on("data", onData);
		process.stdin.on("end", onEnd);
		process.once("SIGINT", onSigint);
	});
}

/** Read all remaining stdin until EOF (Ctrl+D). */
function readAll(): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		const cleanup = () => {
			process.stdin.removeListener("data", onData);
			process.stdin.removeListener("end", onEnd);
			process.removeListener("SIGINT", onSigint);
			process.stdin.pause();
		};
		const onData = (chunk: Buffer) => {
			chunks.push(chunk);
		};
		const onEnd = () => {
			cleanup();
			resolve(Buffer.concat(chunks).toString());
		};
		const onSigint = () => {
			cleanup();
			resolve(Buffer.concat(chunks).toString());
		};
		process.stdin.resume();
		process.stdin.on("data", onData);
		process.stdin.on("end", onEnd);
		process.once("SIGINT", onSigint);
	});
}

/** Read stdin pipe (non-TTY) to completion. */
async function readStdinPipe(): Promise<string> {
	return await new Response(Bun.stdin.stream()).text();
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

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
	async run({ args }) {
		const optionsList = (args.options as string)
			.split(",")
			.map((o) => o.trim())
			.filter(Boolean);

		if (optionsList.length === 0) {
			outputError(
				"INVALID_OPTIONS",
				"At least one option must be provided via --options",
			);
		}

		const defaultVal = args.default as string | undefined;

		if (defaultVal && !optionsList.includes(defaultVal)) {
			outputError(
				"INVALID_DEFAULT",
				`Default value "${defaultVal}" is not in the options list`,
				{ options: optionsList, default: defaultVal },
			);
		}

		if (!isTTY()) {
			if (defaultVal) {
				outputSuccess({ choice: defaultVal });
				return;
			}
			outputError(
				"NON_INTERACTIVE",
				"Interactive prompt required but stdin is not a TTY (no --default provided)",
			);
		}

		// Interactive: display numbered options and read selection
		console.error(); // stderr to avoid polluting JSON stdout
		console.error(`  ${args.message}`);
		console.error();
		for (let i = 0; i < optionsList.length; i++) {
			const marker = defaultVal === optionsList[i] ? " (default)" : "";
			console.error(`    ${i + 1}. ${optionsList[i]}${marker}`);
		}
		console.error();

		const defaultHint = defaultVal ? ` [${defaultVal}]` : "";

		// Reprompt loop: require valid input before proceeding
		for (;;) {
			process.stderr.write(`  Choice${defaultHint}: `);
			const input = await readLine();

			// EOF (Ctrl+D) — use default if available, otherwise error
			if (input === EOF) {
				if (defaultVal) {
					outputSuccess({ choice: defaultVal });
					return;
				}
				outputError("EOF", "End of input received with no valid selection");
			}

			// SIGINT — exit with dedicated error
			if (input === SIGINT) {
				outputError("INTERRUPTED", "Prompt interrupted by user");
			}

			const trimmed = input.trim();

			// Empty input → use default if available, otherwise reprompt
			if (!trimmed) {
				if (defaultVal) {
					outputSuccess({ choice: defaultVal });
					return;
				}
				console.error(
					"  Invalid selection. Please enter a number or option name.",
				);
				continue;
			}

			// Try numeric selection
			const num = Number.parseInt(trimmed, 10);
			if (!Number.isNaN(num) && num >= 1 && num <= optionsList.length) {
				outputSuccess({ choice: optionsList[num - 1] });
				return;
			}

			// Try exact text match (case-insensitive)
			const match = optionsList.find(
				(o) => o.toLowerCase() === trimmed.toLowerCase(),
			);
			if (match) {
				outputSuccess({ choice: match });
				return;
			}

			// Invalid input — reprompt
			console.error(
				"  Invalid selection. Please enter a number or option name.",
			);
		}
	},
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
	async run({ args }) {
		const defaultVal = args.default as string | undefined;
		let defaultBool: boolean | undefined;

		if (defaultVal !== undefined) {
			const lower = defaultVal.toLowerCase();
			if (lower === "yes" || lower === "y" || lower === "true") {
				defaultBool = true;
			} else if (lower === "no" || lower === "n" || lower === "false") {
				defaultBool = false;
			} else {
				outputError(
					"INVALID_DEFAULT",
					`Default value must be "yes" or "no", got "${defaultVal}"`,
				);
			}
		}

		if (!isTTY()) {
			if (defaultBool !== undefined) {
				outputSuccess({ confirmed: defaultBool });
				return;
			}
			outputError(
				"NON_INTERACTIVE",
				"Interactive prompt required but stdin is not a TTY (no --default provided)",
			);
		}

		// Interactive: display [y/n] prompt
		const hint =
			defaultBool === true
				? "[Y/n]"
				: defaultBool === false
					? "[y/N]"
					: "[y/n]";

		// Reprompt loop: require valid input before proceeding
		for (;;) {
			process.stderr.write(`  ${args.message} ${hint}: `);
			const input = await readLine();

			// EOF (Ctrl+D) — use default if available, otherwise error
			if (input === EOF) {
				if (defaultBool !== undefined) {
					outputSuccess({ confirmed: defaultBool });
					return;
				}
				outputError("EOF", "End of input received with no valid selection");
			}

			// SIGINT — exit with dedicated error
			if (input === SIGINT) {
				outputError("INTERRUPTED", "Prompt interrupted by user");
			}

			const trimmed = input.trim().toLowerCase();

			if (!trimmed && defaultBool !== undefined) {
				outputSuccess({ confirmed: defaultBool });
				return;
			}

			if (trimmed === "y" || trimmed === "yes" || trimmed === "true") {
				outputSuccess({ confirmed: true });
				return;
			}

			if (trimmed === "n" || trimmed === "no" || trimmed === "false") {
				outputSuccess({ confirmed: false });
				return;
			}

			// Invalid input — reprompt
			console.error("  Invalid input. Please enter y or n.");
		}
	},
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
	async run({ args }) {
		if (!isTTY()) {
			// Non-TTY: read from stdin pipe
			const text = await readStdinPipe();
			outputSuccess({ input: text });
			return;
		}

		// Interactive
		if (args.multiline) {
			console.error(`  ${args.message} (Ctrl+D to finish):`);
			const text = await readAll();
			outputSuccess({ input: text });
		} else {
			process.stderr.write(`  ${args.message}: `);
			const text = await readLine();
			if (text === EOF) {
				outputSuccess({ input: "" });
				return;
			}
			if (text === SIGINT) {
				outputError("INTERRUPTED", "Prompt interrupted by user");
			}
			outputSuccess({ input: text });
		}
	},
});

// ---------------------------------------------------------------------------
// Parent command
// ---------------------------------------------------------------------------

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
