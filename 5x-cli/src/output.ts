/**
 * JSON output envelope helpers for v1 CLI commands.
 *
 * All v1 commands return `{ ok: true, data }` or `{ ok: false, error }`.
 * Command handlers throw `CliError`; bin.ts catches it, writes the error
 * envelope to stdout, and exits with the specified exit code.
 *
 * Exit codes:
 *   0 — Success
 *   1 — General error / unhandled
 *   2 — TEMPLATE_NOT_FOUND, PLAN_NOT_FOUND, PROVIDER_NOT_FOUND, INVALID_PROVIDER
 *   3 — NON_INTERACTIVE
 *   4 — PLAN_LOCKED
 *   5 — DIRTY_WORKTREE
 *   6 — MAX_STEPS_EXCEEDED
 *   7 — INVALID_STRUCTURED_OUTPUT
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
	console.log(JSON.stringify(envelope));
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
