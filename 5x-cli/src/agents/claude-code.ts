/**
 * Claude Code CLI adapter.
 *
 * Drives Claude Code via `claude -p "<prompt>" --output-format stream-json --verbose`.
 * Streams NDJSON events during execution: each line is written to an optional
 * `logStream`, delivered to an optional `onEvent` callback, and the final
 * `type: "result"` event is parsed into an `AgentResult`.
 *
 * Timeout guarantee: `invoke(timeout=X)` returns within O(X + KILL_GRACE_MS +
 * DRAIN_TIMEOUT_MS) regardless of subprocess behavior. After the deadline the
 * adapter sends SIGTERM, waits a short grace, then SIGKILL, and bounds stdout
 * draining via AbortController cancellation.
 *
 * Failure semantics: a non-zero exit code OR `is_error === true` in the result
 * event maps to a non-zero `AgentResult.exitCode`. This prevents orchestration
 * from treating agent-reported errors as successes.
 *
 * Non-fatal invariant: `logStream.write()` and `onEvent()` failures MUST NOT
 * fail the invocation. They are caught; on first error a warning is emitted
 * and the failing callback is disabled for the remainder of the stream.
 *
 * Bounded memory: the reader does not accumulate full stdout. Only the result
 * event and the first ~4KB of output (as a diagnostic fallback) are retained.
 *
 * Prompt delivery: prompts are passed via `-p` on the command line. Very large
 * prompts may hit OS ARG_MAX limits (~128–256 KiB). Templates must stay within
 * MAX_PROMPT_LENGTH.
 */

import type { AgentAdapter, AgentResult, InvokeOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Claude Code NDJSON event schema (subset we depend on)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the `type: "result"` event in stream-json output.
 * Same fields as the old `--output-format json` blob — just arrives as the
 * last NDJSON line rather than the entire stdout.
 */
interface ClaudeCodeJsonOutput {
	type?: string; // "result"
	subtype?: string; // "success" | "error_max_turns" | ...
	is_error?: boolean;
	result?: string; // the agent's text output
	duration_ms?: number;
	total_cost_usd?: number;
	session_id?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
}

/** Fields we require from the result event for a valid result. */
const REQUIRED_FIELDS = ["result"] as const;

// ---------------------------------------------------------------------------
// NDJSON reader result
// ---------------------------------------------------------------------------

interface NdjsonResult {
	/** The parsed `type: "result"` event, or null if not found. */
	resultEvent: ClaudeCodeJsonOutput | null;
	/** The `result` field string from the result event, or "" if not found. */
	rawResultText: string;
	/** First ~4KB of stdout text — diagnostic fallback when no result event. */
	boundedFallback: string;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_MAX_TURNS = 50;
const CLAUDE_BINARY = "claude";

/** Grace period after SIGTERM before escalating to SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** Max time to wait for stdout reader to close after process termination. */
const DRAIN_TIMEOUT_MS = 1_000;
/**
 * Maximum prompt length in bytes passed via `-p` argv. Prompts exceeding this
 * risk hitting OS ARG_MAX limits. Templates should stay well below this bound.
 */
const MAX_PROMPT_LENGTH = 128_000; // ~128 KiB, conservative for Linux
/** Cap on the bounded fallback buffer — prevents OOM on verbose stdout. */
const BOUNDED_FALLBACK_LIMIT = 4_096; // ~4KB

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/** Spawn result returned by the protected spawn method. */
interface SpawnHandle {
	/** Promise that resolves with exit code when the process exits. */
	exited: Promise<number>;
	/** stdout stream. */
	stdout: ReadableStream<Uint8Array> | null;
	/** stderr stream. */
	stderr: ReadableStream<Uint8Array> | null;
	/** Send a signal to the process (default SIGTERM; pass 9 for SIGKILL). */
	kill(signal?: number): void;
}

export class ClaudeCodeAdapter implements AgentAdapter {
	readonly name = "claude-code" as const;

	async isAvailable(): Promise<boolean> {
		try {
			const proc = Bun.spawn([CLAUDE_BINARY, "--version"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			return exitCode === 0;
		} catch {
			// Binary not found or not executable
			return false;
		}
	}

	/**
	 * Spawn the agent subprocess. Override in tests to inject controlled
	 * behavior without re-implementing invoke() logic.
	 */
	protected spawnProcess(args: string[], opts: { cwd: string }): SpawnHandle {
		const proc = Bun.spawn([CLAUDE_BINARY, ...args], {
			cwd: opts.cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});
		return {
			exited: proc.exited,
			stdout: proc.stdout as ReadableStream<Uint8Array> | null,
			stderr: proc.stderr as ReadableStream<Uint8Array> | null,
			kill: (signal?: number) => proc.kill(signal),
		};
	}

	async invoke(opts: InvokeOptions): Promise<AgentResult> {
		const startTime = performance.now();
		const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
		const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

		// Guard against prompts that may exceed OS ARG_MAX (byte-based).
		const promptBytes = Buffer.byteLength(opts.prompt, "utf8");
		if (promptBytes > MAX_PROMPT_LENGTH) {
			const duration = Math.round(performance.now() - startTime);
			return {
				output: "",
				exitCode: 1,
				duration,
				error:
					`Prompt size (${promptBytes} bytes) exceeds MAX_PROMPT_LENGTH ` +
					`(${MAX_PROMPT_LENGTH} bytes). Prompts are passed via argv and are ` +
					`subject to OS command-line length limits.`,
			};
		}

		const args = buildArgs(opts, maxTurns);

		let proc: SpawnHandle;
		try {
			proc = this.spawnProcess(args, { cwd: opts.workdir });
		} catch (err) {
			const duration = Math.round(performance.now() - startTime);
			return {
				output: "",
				exitCode: 1,
				duration,
				error: `Failed to spawn claude process: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		// AbortController for bounded stdout drain during timeout.
		const ac = new AbortController();

		// Start concurrent draining immediately — must not block on each other.
		// If stdout fills while we wait on proc.exited, the process would block.
		const stdoutDone = readNdjson(proc.stdout, {
			logStream: opts.logStream,
			onEvent: opts.onEvent,
			signal: ac.signal,
		});
		const stderrDone = drainStream(proc.stderr);

		// Race process exit against the timeout.
		const raceResult = await raceWithTimeout(proc.exited, timeout);
		const duration = Math.round(performance.now() - startTime);

		let ndjsonResult: NdjsonResult;
		let stderr: string;
		let exitCode: number;

		if (raceResult.timedOut) {
			// SIGTERM → grace → SIGKILL
			await killWithEscalation(proc);
			// Bounded drain: abort the stdout reader if it doesn't close in time.
			// Stderr is raced against the same deadline. Both run in parallel.
			const drainAbortTimer = setTimeout(() => ac.abort(), DRAIN_TIMEOUT_MS);
			const stderrDrained = Promise.race([
				stderrDone,
				new Promise<string>((resolve) =>
					setTimeout(() => resolve(""), DRAIN_TIMEOUT_MS),
				),
			]);
			[ndjsonResult, stderr] = await Promise.all([stdoutDone, stderrDrained]);
			clearTimeout(drainAbortTimer);
			exitCode = 124; // conventional timeout exit code
		} else {
			// Process exited normally — stdout EOF is guaranteed.
			[ndjsonResult, stderr] = await Promise.all([stdoutDone, stderrDone]);
			exitCode = raceResult.exitCode ?? 1;
		}

		// Build AgentResult from the NDJSON result event.
		if (ndjsonResult.resultEvent) {
			const parsed = ndjsonResult.resultEvent;
			// Map is_error=true to failure even if process exited 0.
			const effectiveExitCode =
				parsed.is_error && exitCode === 0 ? 1 : exitCode;
			const errorContext = buildErrorContext(effectiveExitCode, parsed, stderr);
			return {
				output: ndjsonResult.rawResultText,
				exitCode: effectiveExitCode,
				duration: parsed.duration_ms ?? duration,
				tokens: extractTokens(parsed),
				cost: parsed.total_cost_usd ?? undefined,
				error: errorContext,
				sessionId: parsed.session_id ?? undefined,
			};
		}

		// No result event (timeout, crash, or non-NDJSON output) — use bounded fallback.
		return {
			output: ndjsonResult.boundedFallback,
			exitCode,
			duration,
			error:
				exitCode === 124
					? `Agent timed out after ${timeout}ms. stderr: ${stderr}`
					: stderr || (exitCode !== 0 ? `exit code ${exitCode}` : undefined),
		};
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildArgs(opts: InvokeOptions, maxTurns: number): string[] {
	const args = [
		"-p",
		opts.prompt,
		"--output-format",
		"stream-json",
		"--verbose",
		"--max-turns",
		String(maxTurns),
	];

	if (opts.model) {
		args.push("--model", opts.model);
	}

	if (opts.allowedTools && opts.allowedTools.length > 0) {
		args.push("--allowedTools", ...opts.allowedTools);
	}

	return args;
}

/**
 * Parse a single JSON blob as ClaudeCodeJsonOutput.
 *
 * Kept for backward compat / standalone use. In the streaming path, result
 * events are parsed line-by-line inside readNdjson().
 */
function parseJsonOutput(stdout: string): ClaudeCodeJsonOutput | null {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) return null;

	try {
		const parsed = JSON.parse(trimmed) as ClaudeCodeJsonOutput;

		const missing = REQUIRED_FIELDS.filter(
			(f) => parsed[f as keyof ClaudeCodeJsonOutput] === undefined,
		);
		if (missing.length > 0) {
			console.warn(
				`[claude-code] JSON output missing expected fields: ${missing.join(", ")}. ` +
					`Claude Code CLI output schema may have changed.`,
			);
		}

		return parsed;
	} catch {
		return null;
	}
}

function extractTokens(
	parsed: ClaudeCodeJsonOutput,
): { input: number; output: number } | undefined {
	const input = parsed.usage?.input_tokens;
	const output = parsed.usage?.output_tokens;
	if (input !== undefined && output !== undefined) {
		return { input, output };
	}
	return undefined;
}

/**
 * Build an error context string from parsed result event and stderr.
 * Returns undefined when there is no error to report.
 *
 * When exitCode is non-zero, always returns at least `"exit code N"` so
 * callers never see `error: undefined` on a failed invocation.
 */
function buildErrorContext(
	exitCode: number,
	parsed: ClaudeCodeJsonOutput,
	stderr: string,
): string | undefined {
	if (exitCode === 0) return undefined;

	const parts: string[] = [];
	if (parsed.is_error && parsed.subtype) {
		parts.push(`agent error (${parsed.subtype})`);
	} else if (parsed.subtype) {
		parts.push(`subtype: ${parsed.subtype}`);
	}
	if (stderr) {
		parts.push(stderr);
	}
	// Always include at least the exit code so error is never undefined
	// for a failed invocation.
	if (parts.length === 0) {
		parts.push(`exit code ${exitCode}`);
	}
	return parts.join(": ");
}

// ---------------------------------------------------------------------------
// NDJSON streaming reader
// ---------------------------------------------------------------------------

/**
 * Race `reader.read()` against an AbortSignal.
 *
 * When the signal fires, resolves immediately with `{ done: true }` so the
 * caller can break out of its read loop without waiting for `reader.read()`
 * to settle. The pending `reader.read()` promise is orphaned (floating) —
 * acceptable because the stream is not reused after readNdjson returns.
 */
type ChunkReadResult =
	| { done: true; value: undefined }
	| { done: false; value: Uint8Array };

function readWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal | undefined,
): Promise<ChunkReadResult> {
	if (!signal) return reader.read() as Promise<ChunkReadResult>;
	if (signal.aborted)
		return Promise.resolve({ done: true as const, value: undefined });

	return new Promise<ChunkReadResult>((resolve, reject) => {
		const onAbort = () => resolve({ done: true as const, value: undefined });
		signal.addEventListener("abort", onAbort, { once: true });
		reader.read().then(
			(result) => {
				signal.removeEventListener("abort", onAbort);
				resolve(result as ChunkReadResult);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

/**
 * Read NDJSON lines from a ReadableStream.
 *
 * - Uses TextDecoder with stream:true for multi-byte char safety.
 * - Buffers partial lines; splits on `\n`; trims trailing `\r`.
 * - Writes each complete line to `opts.logStream` (non-fatal).
 * - Calls `opts.onEvent(parsedEvent, rawLine)` per parsed JSON line (non-fatal).
 * - Retains the `type: "result"` event for AgentResult extraction.
 * - Retains only the first ~4KB of stdout as a bounded diagnostic fallback.
 * - Checks `opts.signal` before each read; resolves promptly when aborted.
 */
async function readNdjson(
	stream: ReadableStream<Uint8Array> | null,
	opts: {
		logStream?: NodeJS.WritableStream;
		onEvent?: (event: unknown, rawLine: string) => void;
		signal?: AbortSignal;
	},
): Promise<NdjsonResult> {
	if (!stream) {
		return { resultEvent: null, rawResultText: "", boundedFallback: "" };
	}

	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	let resultEvent: ClaudeCodeJsonOutput | null = null;
	let rawResultText = "";
	let boundedFallback = "";
	let logStreamFailed = false;
	let onEventFailed = false;

	// processLine is defined here so it closes over the mutable state above.
	const processLine = (line: string): void => {
		// Write to logStream (non-fatal: disable on first error).
		if (!logStreamFailed && opts.logStream) {
			try {
				opts.logStream.write(`${line}\n`);
			} catch (err) {
				logStreamFailed = true;
				console.warn(
					`[claude-code] logStream write failed (non-fatal): ${err}`,
				);
			}
		}

		// Parse JSON; skip non-JSON lines (they may appear in degraded output).
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}

		// Call onEvent (non-fatal: disable on first exception).
		if (!onEventFailed && opts.onEvent) {
			try {
				opts.onEvent(parsed, line);
			} catch (err) {
				onEventFailed = true;
				console.warn(
					`[claude-code] onEvent callback threw (non-fatal): ${err}`,
				);
			}
		}

		// Retain the result event for AgentResult construction.
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			(parsed as Record<string, unknown>).type === "result"
		) {
			resultEvent = parsed as ClaudeCodeJsonOutput;
			rawResultText = (parsed as ClaudeCodeJsonOutput).result ?? "";
		}
	};

	try {
		while (true) {
			// readWithAbort races reader.read() against the abort signal so the
			// loop exits promptly even if reader.cancel() is slow to propagate.
			let done: boolean;
			let value: Uint8Array | undefined;
			try {
				({ done, value } = await readWithAbort(reader, opts.signal));
			} catch {
				// Stream errored — break with whatever we have so far.
				break;
			}

			if (done) break;
			if (!value) continue;

			const textChunk = decoder.decode(value, { stream: true });

			// Accumulate bounded fallback (first ~4KB only; prevents OOM).
			if (boundedFallback.length < BOUNDED_FALLBACK_LIMIT) {
				const remaining = BOUNDED_FALLBACK_LIMIT - boundedFallback.length;
				boundedFallback +=
					textChunk.length <= remaining
						? textChunk
						: textChunk.slice(0, remaining);
			}

			buffer += textChunk;

			// Split on newlines; keep last (possibly incomplete) chunk as buffer.
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const rawLine of lines) {
				const line = rawLine.replace(/\r$/, ""); // trim Windows CR
				if (!line) continue;
				processLine(line);
			}
		}

		// Flush TextDecoder and handle any remaining partial line.
		const flushed = decoder.decode();
		if (flushed) buffer += flushed;
		if (buffer) {
			const line = buffer.replace(/\r$/, "");
			if (line) processLine(line);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Already released or lock held by orphaned read — safe to ignore.
		}
	}

	return { resultEvent, rawResultText, boundedFallback };
}

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/**
 * Drain a ReadableStream into a string.
 *
 * Uses `new Response(stream).text()` which correctly handles multi-byte
 * character boundaries and flushes the decoder on EOF.
 */
async function drainStream(
	stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
	if (!stream) return "";
	try {
		return await new Response(stream).text();
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Process lifecycle helpers
// ---------------------------------------------------------------------------

interface RaceResult {
	timedOut: boolean;
	exitCode?: number;
}

async function raceWithTimeout(
	exited: Promise<number>,
	timeoutMs: number,
): Promise<RaceResult> {
	return new Promise<RaceResult>((resolve) => {
		const timer = setTimeout(() => {
			resolve({ timedOut: true });
		}, timeoutMs);

		exited.then((exitCode) => {
			clearTimeout(timer);
			resolve({ timedOut: false, exitCode });
		});
	});
}

/**
 * Escalating kill: SIGTERM → wait grace period → SIGKILL.
 * Ensures the process is dead within KILL_GRACE_MS of calling.
 */
async function killWithEscalation(proc: SpawnHandle): Promise<void> {
	proc.kill(); // SIGTERM

	const exited = await Promise.race([
		proc.exited.then(() => true as const),
		new Promise<false>((resolve) =>
			setTimeout(() => resolve(false), KILL_GRACE_MS),
		),
	]);

	if (!exited) {
		proc.kill(9); // SIGKILL
	}
}

// Re-export for testing
export {
	buildArgs,
	parseJsonOutput,
	readNdjson,
	type ClaudeCodeJsonOutput,
	type NdjsonResult,
	type SpawnHandle,
	MAX_PROMPT_LENGTH,
	BOUNDED_FALLBACK_LIMIT,
};
