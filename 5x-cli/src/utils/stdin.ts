/**
 * Stdin I/O utilities for interactive prompts.
 *
 * Extracted from src/commands/prompt.ts to enable reuse across command handlers
 * without coupling to the CLI framework.
 *
 * Supports a /dev/tty fallback for environments where stdin is piped but a
 * controlling terminal is available (e.g., bash scripts that capture stdout).
 */

import {
	createReadStream,
	createWriteStream,
	existsSync,
	type ReadStream,
	type WriteStream,
} from "node:fs";

// ---------------------------------------------------------------------------
// TTY detection and /dev/tty fallback
// ---------------------------------------------------------------------------

/** Cached /dev/tty streams (lazily opened, reused across calls). */
let ttyIn: ReadStream | null = null;
let ttyOut: WriteStream | null = null;
let ttyFallbackAvailable: boolean | null = null;

/**
 * Check if /dev/tty is available as a fallback when stdin is not a TTY.
 * This covers the case where a script pipes stdin but the user is at a terminal
 * (e.g., `cat data.json | my-script.sh` where the script needs to prompt).
 */
function hasTtyFallback(): boolean {
	if (ttyFallbackAvailable !== null) return ttyFallbackAvailable;
	if (!existsSync("/dev/tty")) {
		ttyFallbackAvailable = false;
		return false;
	}
	try {
		ttyIn = createReadStream("/dev/tty", { encoding: "utf-8" });
		ttyOut = createWriteStream("/dev/tty");
		ttyFallbackAvailable = true;
		return true;
	} catch {
		ttyFallbackAvailable = false;
		return false;
	}
}

/** Check if stdin is a TTY (respects 5X_FORCE_TTY and NODE_ENV=test). */
export function isTTY(): boolean {
	// Allow tests to force interactive mode via env var.
	if (process.env["5X_FORCE_TTY"] === "1") return true;
	// Bun test sets NODE_ENV=test even when stdin is a TTY. Disable interactive
	// prompts in test runs to avoid hanging suites.
	if (process.env.NODE_ENV === "test") return false;
	if (process.stdin.isTTY) return true;
	// Fallback: try /dev/tty for piped-stdin-but-terminal-available scenarios.
	return hasTtyFallback();
}

/**
 * Get a writable stream for prompt text output.
 * Returns /dev/tty write stream if using the fallback, otherwise stderr.
 * Prompt text must never go to stdout (reserved for JSON output).
 */
export function getPromptOutput(): NodeJS.WritableStream {
	if (ttyOut) return ttyOut;
	return process.stderr;
}

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

/** Sentinel returned by readLine when stdin receives EOF (Ctrl+D). */
export const EOF = Symbol("EOF");

/** Sentinel returned by readLine when SIGINT is received. */
export const SIGINT = Symbol("SIGINT");

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Buffered leftover from previous readLine calls. */
let stdinBuffer = "";
/** Whether stdin has ended. */
let stdinEnded = false;

// ---------------------------------------------------------------------------
// Read functions
// ---------------------------------------------------------------------------

/** Get the appropriate input stream (process.stdin or /dev/tty fallback). */
function getInputStream(): NodeJS.ReadableStream {
	if (ttyIn) return ttyIn;
	return process.stdin;
}

/** Read a single line from stdin (or /dev/tty fallback). Returns EOF symbol on close, SIGINT symbol on interrupt. */
export function readLine(): Promise<string | typeof EOF | typeof SIGINT> {
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

		const input = getInputStream();

		const cleanup = () => {
			input.removeListener("data", onData);
			input.removeListener("end", onEnd);
			process.removeListener("SIGINT", onSigint);
			if ("pause" in input && typeof input.pause === "function") {
				(input as NodeJS.ReadStream).pause();
			}
		};

		const onData = (chunk: Buffer | string) => {
			stdinBuffer += typeof chunk === "string" ? chunk : chunk.toString();
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
		if ("resume" in input && typeof input.resume === "function") {
			(input as NodeJS.ReadStream).resume();
		}
		input.on("data", onData);
		input.on("end", onEnd);
		process.once("SIGINT", onSigint);
	});
}

/** Read all remaining stdin until EOF (Ctrl+D). Uses /dev/tty fallback if available. */
export function readAll(): Promise<string> {
	return new Promise((resolve) => {
		const input = getInputStream();
		const chunks: (Buffer | string)[] = [];

		const cleanup = () => {
			input.removeListener("data", onData);
			input.removeListener("end", onEnd);
			process.removeListener("SIGINT", onSigint);
			if ("pause" in input && typeof input.pause === "function") {
				(input as NodeJS.ReadStream).pause();
			}
		};
		const onData = (chunk: Buffer | string) => {
			chunks.push(chunk);
		};
		const onEnd = () => {
			cleanup();
			const text = chunks
				.map((c) => (typeof c === "string" ? c : c.toString()))
				.join("");
			resolve(text);
		};
		const onSigint = () => {
			cleanup();
			const text = chunks
				.map((c) => (typeof c === "string" ? c : c.toString()))
				.join("");
			resolve(text);
		};
		if ("resume" in input && typeof input.resume === "function") {
			(input as NodeJS.ReadStream).resume();
		}
		input.on("data", onData);
		input.on("end", onEnd);
		process.once("SIGINT", onSigint);
	});
}

/** Read stdin pipe (non-TTY) to completion. */
export async function readStdinPipe(): Promise<string> {
	return await new Response(Bun.stdin.stream()).text();
}
