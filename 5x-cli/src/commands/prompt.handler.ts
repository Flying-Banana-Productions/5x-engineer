/**
 * Prompt command handlers — business logic for interactive prompts.
 *
 * Framework-independent: no CLI framework imports. Uses stdin utilities from
 * src/utils/stdin.ts and output helpers from src/output.ts.
 *
 * Prompt text is written via getPromptOutput() (stderr normally, /dev/tty
 * when stdin is piped but a terminal is available). JSON results always
 * go to stdout via outputSuccess/outputError.
 */

import { outputError, outputSuccess } from "../output.js";
import {
	EOF,
	getPromptOutput,
	isTTY,
	readAll,
	readLine,
	readStdinPipe,
	SIGINT,
} from "../utils/stdin.js";

// ---------------------------------------------------------------------------
// Prompt output helpers
// ---------------------------------------------------------------------------

/** Write a line to the prompt output stream (stderr or /dev/tty). */
function promptLine(text: string): void {
	getPromptOutput().write(`${text}\n`);
}

/** Write text without a trailing newline to the prompt output stream. */
function promptWrite(text: string): void {
	getPromptOutput().write(text);
}

// ---------------------------------------------------------------------------
// Param interfaces
// ---------------------------------------------------------------------------

export interface ChooseParams {
	message: string;
	options: string; // comma-separated, parsed inside handler
	default?: string;
}

export interface ConfirmParams {
	message: string;
	default?: string; // "yes"|"no"|"y"|"n"|"true"|"false"
}

export interface InputParams {
	message: string;
	multiline?: boolean;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function promptChoose(params: ChooseParams): Promise<void> {
	const optionsList = params.options
		.split(",")
		.map((o) => o.trim())
		.filter(Boolean);

	if (optionsList.length === 0) {
		outputError(
			"INVALID_OPTIONS",
			"At least one option must be provided via --options",
		);
	}

	const defaultVal = params.default;

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
	promptLine("");
	promptLine(`  ${params.message}`);
	promptLine("");
	for (let i = 0; i < optionsList.length; i++) {
		const marker = defaultVal === optionsList[i] ? " (default)" : "";
		promptLine(`    ${i + 1}. ${optionsList[i]}${marker}`);
	}
	promptLine("");

	const defaultHint = defaultVal ? ` [${defaultVal}]` : "";

	// Reprompt loop: require valid input before proceeding
	for (;;) {
		promptWrite(`  Choice${defaultHint}: `);
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
			promptLine("  Invalid selection. Please enter a number or option name.");
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
		promptLine("  Invalid selection. Please enter a number or option name.");
	}
}

export async function promptConfirm(params: ConfirmParams): Promise<void> {
	const defaultVal = params.default;
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
		defaultBool === true ? "[Y/n]" : defaultBool === false ? "[y/N]" : "[y/n]";

	// Reprompt loop: require valid input before proceeding
	for (;;) {
		promptWrite(`  ${params.message} ${hint}: `);
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
		promptLine("  Invalid input. Please enter y or n.");
	}
}

export async function promptInput(params: InputParams): Promise<void> {
	if (!isTTY()) {
		// Non-TTY: read from stdin pipe
		const text = await readStdinPipe();
		outputSuccess({ input: text });
		return;
	}

	// Interactive
	if (params.multiline) {
		promptLine(`  ${params.message} (Ctrl+D to finish):`);
		const text = await readAll();
		outputSuccess({ input: text });
	} else {
		promptWrite(`  ${params.message}: `);
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
}
