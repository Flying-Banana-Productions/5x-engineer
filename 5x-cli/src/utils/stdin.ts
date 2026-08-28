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

/** Sentinel returned when the waiter's AbortSignal fires. */
export const ABORTED = Symbol("ABORTED");

/** Process SIGINT seam for unit tests. Production uses `process`. */
export interface StdinSigintHost {
	once(event: "SIGINT", listener: () => void): void;
	removeListener(event: "SIGINT", listener: () => void): void;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Buffered leftover from previous readLine calls. */
let stdinBuffer = "";
/** Whether stdin has ended. */
let stdinEnded = false;

let inputStreamOverride: NodeJS.ReadableStream | null = null;
let pipeStreamFactory: (() => ReadableStream<Uint8Array>) | null = null;
let sigintHost: StdinSigintHost = process;

/** @internal Reset module state between unit tests. */
export function _resetStdinForTest(): void {
	stdinBuffer = "";
	stdinEnded = false;
	inputStreamOverride = null;
	pipeStreamFactory = null;
	sigintHost = process;
}

/** @internal Inject the TTY/line input stream for unit tests. */
export function _setInputStreamForTest(
	stream: NodeJS.ReadableStream | null,
): void {
	inputStreamOverride = stream;
}

/** @internal Inject the pipe ReadableStream factory for unit tests. */
export function _setPipeStreamForTest(
	factory: (() => ReadableStream<Uint8Array>) | null,
): void {
	pipeStreamFactory = factory;
}

/** @internal Inject the SIGINT host so tests never emit process SIGINT. */
export function _setSigintHostForTest(host: StdinSigintHost | null): void {
	sigintHost = host ?? process;
}

// ---------------------------------------------------------------------------
// Read functions
// ---------------------------------------------------------------------------

/** Get the appropriate input stream (process.stdin or /dev/tty fallback). */
function getInputStream(): NodeJS.ReadableStream {
	if (inputStreamOverride) return inputStreamOverride;
	if (ttyIn) return ttyIn;
	return process.stdin;
}

function getPipeStream(): ReadableStream<Uint8Array> {
	if (pipeStreamFactory) return pipeStreamFactory();
	return Bun.stdin.stream();
}

function pauseIfPossible(input: NodeJS.ReadableStream): void {
	if ("pause" in input && typeof input.pause === "function") {
		(input as NodeJS.ReadStream).pause();
	}
}

function resumeIfPossible(input: NodeJS.ReadableStream): void {
	if ("resume" in input && typeof input.resume === "function") {
		(input as NodeJS.ReadStream).resume();
	}
}

/**
 * Read a single line from stdin (or /dev/tty fallback).
 * Returns EOF on close, SIGINT on interrupt, ABORTED if `signal` fires.
 */
export function readLine(
	signal?: AbortSignal,
): Promise<string | typeof EOF | typeof SIGINT | typeof ABORTED> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(ABORTED);
			return;
		}

		const nlIdx = stdinBuffer.indexOf("\n");
		if (nlIdx !== -1) {
			const line = stdinBuffer.slice(0, nlIdx);
			stdinBuffer = stdinBuffer.slice(nlIdx + 1);
			resolve(line);
			return;
		}

		if (stdinEnded) {
			resolve(EOF);
			return;
		}

		const input = getInputStream();
		let settled = false;

		const cleanup = () => {
			input.removeListener("data", onData);
			input.removeListener("end", onEnd);
			sigintHost.removeListener("SIGINT", onSigint);
			signal?.removeEventListener("abort", onAbort);
			pauseIfPossible(input);
		};

		const finish = (
			value: string | typeof EOF | typeof SIGINT | typeof ABORTED,
		) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};

		const onData = (chunk: Buffer | string) => {
			stdinBuffer += typeof chunk === "string" ? chunk : chunk.toString();
			const idx = stdinBuffer.indexOf("\n");
			if (idx !== -1) {
				const line = stdinBuffer.slice(0, idx);
				stdinBuffer = stdinBuffer.slice(idx + 1);
				finish(line);
			}
		};
		const onEnd = () => {
			stdinEnded = true;
			finish(EOF);
		};
		const onSigint = () => {
			finish(SIGINT);
		};
		const onAbort = () => {
			finish(ABORTED);
		};

		resumeIfPossible(input);
		input.on("data", onData);
		input.on("end", onEnd);
		sigintHost.once("SIGINT", onSigint);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Read all remaining stdin until stream-end (Ctrl+D). Uses /dev/tty fallback
 * if available. Stream-end is the collected text (including `""`), never EOF.
 * SIGINT resolves the SIGINT sentinel (partial chunks are discarded).
 */
export function readAll(
	signal?: AbortSignal,
): Promise<string | typeof SIGINT | typeof ABORTED> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve(ABORTED);
			return;
		}

		const input = getInputStream();
		const chunks: (Buffer | string)[] = [];
		let settled = false;

		const cleanup = () => {
			input.removeListener("data", onData);
			input.removeListener("end", onEnd);
			sigintHost.removeListener("SIGINT", onSigint);
			signal?.removeEventListener("abort", onAbort);
			pauseIfPossible(input);
		};

		const finish = (value: string | typeof SIGINT | typeof ABORTED) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};

		const onData = (chunk: Buffer | string) => {
			chunks.push(chunk);
		};
		const onEnd = () => {
			const text = chunks
				.map((c) => (typeof c === "string" ? c : c.toString()))
				.join("");
			finish(text);
		};
		const onSigint = () => {
			finish(SIGINT);
		};
		const onAbort = () => {
			finish(ABORTED);
		};

		resumeIfPossible(input);
		input.on("data", onData);
		input.on("end", onEnd);
		sigintHost.once("SIGINT", onSigint);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Read stdin pipe (non-TTY) to completion. Abort cancels the stream reader. */
export async function readStdinPipe(
	signal?: AbortSignal,
): Promise<string | typeof ABORTED> {
	if (signal?.aborted) return ABORTED;

	const stream = getPipeStream();
	const reader = stream.getReader();

	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const chunks: Uint8Array[] = [];
		while (true) {
			const result = await reader.read();
			if (signal?.aborted) return ABORTED;
			if (result.done) break;
			if (result.value) chunks.push(result.value);
		}
		if (signal?.aborted) return ABORTED;
		return decodeUtf8Chunks(chunks);
	} catch (err) {
		if (signal?.aborted) return ABORTED;
		throw err;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

function decodeUtf8Chunks(chunks: Uint8Array[]): string {
	const total = chunks.reduce((n, c) => n + c.byteLength, 0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}
