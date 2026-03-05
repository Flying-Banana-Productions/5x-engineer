/**
 * Stdin I/O utilities for interactive prompts.
 *
 * Extracted from src/commands/prompt.ts to enable reuse across command handlers
 * without coupling to the citty CLI framework.
 */

// ---------------------------------------------------------------------------
// TTY detection
// ---------------------------------------------------------------------------

/** Check if stdin is a TTY (respects 5X_FORCE_TTY and NODE_ENV=test). */
export function isTTY(): boolean {
	// Allow tests to force interactive mode via env var.
	if (process.env["5X_FORCE_TTY"] === "1") return true;
	// Bun test sets NODE_ENV=test even when stdin is a TTY. Disable interactive
	// prompts in test runs to avoid hanging suites.
	if (process.env.NODE_ENV === "test") return false;
	return !!process.stdin.isTTY;
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

/** Read a single line from stdin. Returns EOF symbol on stdin close, SIGINT symbol on interrupt. */
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
export function readAll(): Promise<string> {
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
export async function readStdinPipe(): Promise<string> {
	return await new Response(Bun.stdin.stream()).text();
}
