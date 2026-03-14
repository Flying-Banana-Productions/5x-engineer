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
// Output helpers
// ---------------------------------------------------------------------------

/**
 * Write success JSON to stdout. Does not exit — the command returns normally.
 */
export function outputSuccess<T>(data: T): void {
	// Normalize undefined → null so JSON.stringify always includes the `data` field.
	// Without this, `JSON.stringify({ ok: true, data: undefined })` drops `data` entirely,
	// violating the `{ ok, data }` envelope contract.
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
