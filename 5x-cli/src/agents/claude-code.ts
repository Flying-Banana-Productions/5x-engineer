/**
 * Claude Code CLI adapter.
 *
 * Drives Claude Code via `claude -p "<prompt>" --output-format json`.
 * Parses the JSON result into an `AgentResult`.
 *
 * The adapter depends only on the documented `--output-format json` fields.
 * Unknown/extra fields are ignored. If the JSON schema changes in a breaking
 * way (missing required fields), the adapter returns a degraded result with
 * what it can extract and logs a warning.
 *
 * Timeout guarantee: `invoke(timeout=X)` returns within O(X + KILL_GRACE_MS +
 * DRAIN_TIMEOUT_MS) regardless of subprocess behavior. After the deadline the
 * adapter sends SIGTERM, waits a short grace, then SIGKILL, and bounds stream
 * draining with an AbortController.
 *
 * Failure semantics: a non-zero exit code OR `is_error === true` in the parsed
 * JSON output maps to a non-zero `AgentResult.exitCode` with `error` populated
 * from `subtype`/stderr context. This prevents orchestration from treating
 * agent-reported errors as successes.
 *
 * Prompt delivery: prompts are passed via `-p` on the command line. This means
 * very large prompts may hit OS ARG_MAX limits (~128–256 KiB depending on
 * platform). The Claude Code CLI uses stdin as supplementary context, not as a
 * replacement for `-p`. Templates should be kept within MAX_PROMPT_LENGTH and
 * must not embed secrets, since argv is visible via `ps` on multi-user systems.
 */

import type { AgentAdapter, AgentResult, InvokeOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Claude Code JSON output schema (subset we depend on)
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the JSON output from `claude -p ... --output-format json`.
 * We only read fields we actually use — extra fields are ignored.
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

/** Fields we require from the JSON output for a valid result. */
const REQUIRED_FIELDS = ["result"] as const;

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_MAX_TURNS = 50;
const CLAUDE_BINARY = "claude";

/** Grace period after SIGTERM before escalating to SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** Max time to wait for stream draining after process termination. */
const DRAIN_TIMEOUT_MS = 1_000;
/**
 * Maximum prompt length in bytes passed via `-p` argv. Prompts exceeding this
 * risk hitting OS ARG_MAX limits. Templates should stay well below this bound.
 * The Claude Code CLI does not support reading the primary prompt from stdin
 * (stdin provides supplementary context for `-p`), so argv is the only option.
 */
const MAX_PROMPT_LENGTH = 128_000; // ~128 KiB, conservative for Linux

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

		// Guard against prompts that may exceed OS ARG_MAX (byte-based,
		// since ARG_MAX is measured in bytes, not characters).
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

		// Race the process against a timeout
		const result = await raceWithTimeout(proc.exited, timeout);
		const duration = Math.round(performance.now() - startTime);

		if (result.timedOut) {
			// Bounded kill: SIGTERM → grace → SIGKILL
			await killWithEscalation(proc);
			// Bounded drain: abort if streams don't close promptly
			const [partialStdout, partialStderr] = await boundedDrain(
				proc.stdout,
				proc.stderr,
			);
			return {
				output: partialStdout,
				exitCode: 124, // conventional timeout exit code
				duration,
				error: `Agent timed out after ${timeout}ms. stderr: ${partialStderr}`,
			};
		}

		const [stdout, stderr] = await Promise.all([
			drainStream(proc.stdout),
			drainStream(proc.stderr),
		]);
		const exitCode = result.exitCode ?? 1;

		// Attempt to parse JSON output
		const parsed = parseJsonOutput(stdout);

		if (parsed) {
			// Map is_error into failure semantics: if the agent itself reported
			// an error (is_error=true), treat as failure even if exitCode was 0.
			const effectiveExitCode =
				parsed.is_error && exitCode === 0 ? 1 : exitCode;

			const errorContext = buildErrorContext(effectiveExitCode, parsed, stderr);

			return {
				output: parsed.result ?? "",
				exitCode: effectiveExitCode,
				duration: parsed.duration_ms ?? duration,
				tokens: extractTokens(parsed),
				cost: parsed.total_cost_usd ?? undefined,
				error: errorContext,
				sessionId: parsed.session_id ?? undefined,
			};
		}

		// JSON parse failed — fall back to raw stdout
		return {
			output: stdout,
			exitCode,
			duration,
			error:
				exitCode !== 0
					? stderr || `exit code ${exitCode}`
					: stderr || undefined,
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
		"json",
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

function parseJsonOutput(stdout: string): ClaudeCodeJsonOutput | null {
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) return null;

	try {
		const parsed = JSON.parse(trimmed) as ClaudeCodeJsonOutput;

		// Validate we got the fields we need
		const missing = REQUIRED_FIELDS.filter(
			(f) => parsed[f as keyof ClaudeCodeJsonOutput] === undefined,
		);
		if (missing.length > 0) {
			console.warn(
				`[claude-code] JSON output missing expected fields: ${missing.join(", ")}. ` +
					`Claude Code CLI output schema may have changed.`,
			);
			// Still return what we have — degraded but not broken
		}

		return parsed;
	} catch {
		// Not valid JSON — caller will fall back to raw stdout
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
 * Build an error context string from parsed JSON and stderr.
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

/**
 * Drain stdout/stderr with a bounded timeout.
 *
 * Uses `stream.getReader()` + explicit `reader.cancel()` rather than
 * relying on `Response` abort signal semantics (which may not abort
 * in-progress body reads in all runtimes). Returns best-effort partial
 * output if draining takes longer than DRAIN_TIMEOUT_MS.
 */
async function boundedDrain(
	stdoutStream: ReadableStream<Uint8Array> | null,
	stderrStream: ReadableStream<Uint8Array> | null,
): Promise<[string, string]> {
	const result = await Promise.all([
		drainWithTimeout(stdoutStream),
		drainWithTimeout(stderrStream),
	]);
	return result as [string, string];
}

/**
 * Drain a single stream with a timeout. If the stream doesn't close
 * within DRAIN_TIMEOUT_MS, cancel the reader and decode whatever
 * chunks were collected so far.
 */
async function drainWithTimeout(
	stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let timedOut = false;

	const timer = setTimeout(() => {
		timedOut = true;
		reader.cancel().catch(() => {});
	}, DRAIN_TIMEOUT_MS);

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
	} catch {
		// Reader was cancelled or stream errored — decode what we have
	} finally {
		clearTimeout(timer);
		if (!timedOut) {
			reader.releaseLock();
		}
	}

	// Decode collected chunks (handles multi-byte boundaries correctly)
	if (chunks.length === 0) return "";
	const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
	const merged = new Uint8Array(totalLen);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	return new TextDecoder().decode(merged);
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

	// Race: either the process exits within grace, or we escalate
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
	type ClaudeCodeJsonOutput,
	type SpawnHandle,
	MAX_PROMPT_LENGTH,
};
