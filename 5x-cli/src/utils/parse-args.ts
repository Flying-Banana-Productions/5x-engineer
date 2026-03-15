/**
 * CLI argument parsing utilities.
 *
 * Adapter-layer helpers that convert raw CLI strings into semantic types
 * before passing to handler functions. The unwrapped functions
 * (`parseIntArg`, `parseFloatArg`, `parseTimeout`) are the core parsers.
 * The `intArg`, `floatArg`, `timeoutArg`, and `collect` wrappers adapt
 * them to commander's `(value: string, previous: T) => T` argParser
 * callback signature.
 *
 * Extracted from src/commands/run-v1.ts and src/commands/invoke.ts.
 */

import { CliError, outputError } from "../output.js";

/**
 * Parse and validate an integer CLI argument.
 * Rejects negative values by default (non-negative only).
 * Use `{ positive: true }` to also reject zero.
 * Throws INVALID_ARGS on failure.
 */
export function parseIntArg(
	value: string,
	flag: string,
	opts?: { positive?: boolean },
): number {
	// Strict full-string validation: reject trailing junk like "1abc"
	if (!/^-?\d+$/.test(value)) {
		outputError("INVALID_ARGS", `${flag} must be a valid integer`, {
			value,
		});
	}
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) {
		outputError("INVALID_ARGS", `${flag} must be a valid integer`, {
			value,
		});
	}
	if (opts?.positive && n <= 0) {
		outputError("INVALID_ARGS", `${flag} must be a positive integer`, {
			value,
		});
	}
	if (n < 0) {
		outputError("INVALID_ARGS", `${flag} must be non-negative`, {
			value,
		});
	}
	return n;
}

/**
 * Parse and validate a float CLI argument.
 * Throws INVALID_ARGS on failure.
 */
export function parseFloatArg(
	value: string,
	flag: string,
	opts?: { nonNegative?: boolean },
): number {
	// Strict full-string validation: reject trailing junk like "1.5abc"
	if (!/^-?(\d+)(\.\d+)?$/.test(value)) {
		outputError("INVALID_ARGS", `${flag} must be a valid number`, {
			value,
		});
	}
	const n = Number.parseFloat(value);
	if (!Number.isFinite(n)) {
		outputError("INVALID_ARGS", `${flag} must be a valid number`, {
			value,
		});
	}
	if (opts?.nonNegative && n < 0) {
		outputError("INVALID_ARGS", `${flag} must be non-negative`, {
			value,
		});
	}
	return n;
}

/**
 * Parse --timeout as a positive integer (seconds).
 * Returns undefined if not provided (undefined/null/empty).
 * Throws INVALID_ARGS on invalid input.
 */
export function parseTimeout(
	raw: string | number | undefined,
): number | undefined {
	// Explicitly check for undefined or null (not just falsy, to handle numeric 0)
	if (raw === undefined || raw === null || raw === "") return undefined;

	// If it's already a number (citty may parse numeric args), convert to string for validation
	const rawStr = typeof raw === "number" ? String(raw) : raw;
	const parsed = Number.parseInt(rawStr, 10);

	// Reject NaN, zero, negative numbers, or partial parses (e.g., "10abc" where parsed=10 but rawStr!=="10")
	if (Number.isNaN(parsed) || parsed <= 0 || String(parsed) !== rawStr) {
		outputError(
			"INVALID_ARGS",
			`--timeout must be a positive integer (seconds), got: "${raw}"`,
		);
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// Commander argParser wrappers
// ---------------------------------------------------------------------------

/** Commander argParser wrapper for parseIntArg */
export function intArg(flag: string, opts?: { positive?: boolean }) {
	return (value: string, _prev: number): number =>
		parseIntArg(value, flag, opts);
}

/** Commander argParser wrapper for parseFloatArg */
export function floatArg(flag: string, opts?: { nonNegative?: boolean }) {
	return (value: string, _prev: number): number =>
		parseFloatArg(value, flag, opts);
}

/** Commander argParser wrapper for parseTimeout */
export function timeoutArg() {
	return (value: string, _prev: number | undefined): number => {
		const result = parseTimeout(value);
		if (result === undefined) {
			throw new CliError(
				"INVALID_ARGS",
				"--timeout must be a positive integer",
			);
		}
		return result;
	};
}

/** Commander argParser: collect repeatable --var values into string[] */
export function collect(value: string, prev: string[]): string[] {
	return [...prev, value];
}
