/**
 * JSON output envelope helpers for v1 CLI commands.
 *
 * Most v1 commands return `{ ok: true, data }` or `{ ok: false, error }`.
 * Streaming commands (e.g., `run watch`) write non-envelope output to stdout
 * (raw NDJSON lines or human-readable text); pre-streaming errors still use
 * the standard envelope. Command handlers throw `CliError`; bin.ts catches
 * it, writes the error envelope to stdout, and exits with the specified
 * exit code.
 *
 * Exit codes:
 *   0 — Success
 *   1 — General error / unhandled
 *   2 — TEMPLATE_NOT_FOUND, PLAN_NOT_FOUND, PROVIDER_NOT_FOUND, INVALID_PROVIDER
 *   3 — NON_INTERACTIVE, EOF (interactive prompt required / stdin closed)
 *   4 — PLAN_LOCKED
 *   5 — DIRTY_WORKTREE
 *   6 — MAX_STEPS_EXCEEDED
 *   7 — INVALID_STRUCTURED_OUTPUT
 *   8 — PHASE_CHECKLIST_INCOMPLETE, PHASE_NOT_FOUND
 * 130 — INTERRUPTED (prompt cancelled via SIGINT)
 */

// ---------------------------------------------------------------------------
// Envelope types
// ---------------------------------------------------------------------------

export interface SuccessEnvelope<T> {
	ok: true;
	data: T;
}

export interface ErrorEnvelope {
	ok: false;
	error: {
		code: string;
		message: string;
		detail?: unknown;
	};
}

export type JsonEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

// ---------------------------------------------------------------------------
// Exit code mapping
// ---------------------------------------------------------------------------

const EXIT_CODE_MAP: Record<string, number> = {
	TEMPLATE_NOT_FOUND: 2,
	PLAN_NOT_FOUND: 2,
	PROVIDER_NOT_FOUND: 2,
	INVALID_PROVIDER: 2,
	NON_INTERACTIVE: 3,
	EOF: 3,
	INTERRUPTED: 130,
	PLAN_LOCKED: 4,
	DIRTY_WORKTREE: 5,
	MAX_STEPS_EXCEEDED: 6,
	INVALID_STRUCTURED_OUTPUT: 7,
	PHASE_CHECKLIST_INCOMPLETE: 8,
	PHASE_NOT_FOUND: 8,
};

/** Resolve exit code from error code. Falls back to 1 for unknown codes. */
export function exitCodeForError(code: string): number {
	return EXIT_CODE_MAP[code] ?? 1;
}

// ---------------------------------------------------------------------------
// CliError
// ---------------------------------------------------------------------------

/**
 * Typed error class for CLI commands.
 *
 * Thrown by command handlers, caught by bin.ts which writes the error
 * envelope to stdout and exits with `exitCode`.
 */
export class CliError extends Error {
	readonly code: string;
	readonly detail?: unknown;
	readonly exitCode: number;

	constructor(
		code: string,
		message: string,
		detail?: unknown,
		exitCode?: number,
	) {
		super(message);
		this.name = "CliError";
		this.code = code;
		this.detail = detail;
		this.exitCode = exitCode ?? exitCodeForError(code);
	}
}

// ---------------------------------------------------------------------------
// Pretty-print state
// ---------------------------------------------------------------------------

/**
 * Pretty-print state for JSON envelopes.
 *
 * Auto-detected from TTY: pretty when stdout is a terminal (human-readable),
 * compact when piped (machine-parseable).  Override with `--pretty` or
 * `--no-pretty` on the CLI.
 */
let prettyPrint: boolean = process.stdout?.isTTY ?? false;

/** Set the pretty-print mode. Called from bin.ts based on `--pretty`/`--no-pretty`. */
export function setPrettyPrint(value: boolean): void {
	prettyPrint = value;
}

/** Serialize a value to JSON respecting the current pretty-print setting. */
export function jsonStringify(value: unknown): string {
	return JSON.stringify(value, null, prettyPrint ? 2 : undefined);
}

// ---------------------------------------------------------------------------
// Output format state
// ---------------------------------------------------------------------------

type OutputFormat = "json" | "text";

let outputFormat: OutputFormat = "json";

/** Set the output format. Called from bin.ts based on --text/--json/env. */
export function setOutputFormat(format: OutputFormat): void {
	outputFormat = format;
}

/** Get the current output format. */
export function getOutputFormat(): OutputFormat {
	return outputFormat;
}

// ---------------------------------------------------------------------------
// Generic text formatter
// ---------------------------------------------------------------------------

/**
 * Render any JSON-serializable data as human-readable aligned key-value
 * text. Used as the fallback when --text is active and no custom formatter
 * is provided to outputSuccess().
 *
 * - Object keys are left-padded to align values
 * - Nested objects are indented
 * - Arrays of primitives are comma-joined on one line
 * - Arrays of objects are rendered as separated blocks
 * - Empty arrays render as "(none)" to preserve semantic meaning
 * - Empty objects render as "(none)" to preserve semantic meaning
 * - Null/undefined values are omitted
 */
export function formatGenericText(data: unknown, indent: number = 0): void {
	const pad = "  ".repeat(indent);

	if (data == null) return;

	if (typeof data !== "object") {
		console.log(`${pad}${data}`);
		return;
	}

	if (Array.isArray(data)) {
		if (data.length === 0) {
			console.log(`${pad}(none)`);
			return;
		}
		for (let i = 0; i < data.length; i++) {
			const item = data[i];
			if (typeof item === "object" && item !== null) {
				formatGenericText(item, indent);
				if (i < data.length - 1) console.log();
			} else {
				console.log(`${pad}${item}`);
			}
		}
		return;
	}

	const entries = Object.entries(data as Record<string, unknown>).filter(
		([, v]) => v != null,
	);
	if (entries.length === 0) {
		console.log(`${pad}(none)`);
		return;
	}

	const maxKey = Math.max(...entries.map(([k]) => k.length));

	for (const [key, value] of entries) {
		if (typeof value === "object" && !Array.isArray(value)) {
			console.log(`${pad}${key}:`);
			formatGenericText(value, indent + 1);
		} else if (Array.isArray(value)) {
			if (value.length === 0) {
				console.log(`${pad}${key.padEnd(maxKey)}  (none)`);
				continue;
			}
			if (value.every((v) => typeof v !== "object")) {
				console.log(`${pad}${key.padEnd(maxKey)}  ${value.join(", ")}`);
			} else {
				console.log(`${pad}${key}:`);
				formatGenericText(value, indent + 1);
			}
		} else {
			console.log(`${pad}${key.padEnd(maxKey)}  ${value}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/**
 * Write success output to stdout. In JSON mode (default), writes a
 * `{ ok: true, data }` envelope. In text mode, calls the provided
 * formatter or falls back to the generic text formatter.
 */
export function outputSuccess<T>(
	data: T,
	textFormatter?: (data: T) => void,
): void {
	if (outputFormat === "text") {
		if (textFormatter) {
			textFormatter(data);
		} else {
			formatGenericText(data);
		}
		return;
	}
	// JSON mode (default) — unchanged
	const normalized = data === undefined ? null : data;
	const envelope = { ok: true as const, data: normalized };
	console.log(jsonStringify(envelope));
}

/**
 * Throw a CliError — caught by bin.ts, which writes the error envelope
 * to stdout and exits with the appropriate code.
 */
export function outputError(
	code: string,
	message: string,
	detail?: unknown,
	exitCode?: number,
): never {
	throw new CliError(code, message, detail, exitCode);
}
