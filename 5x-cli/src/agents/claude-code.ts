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

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

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

	async invoke(opts: InvokeOptions): Promise<AgentResult> {
		const startTime = performance.now();
		const timeout = opts.timeout ?? DEFAULT_TIMEOUT_MS;
		const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;

		const args = buildArgs(opts, maxTurns);

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn([CLAUDE_BINARY, ...args], {
				cwd: opts.workdir,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			});
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
		const result = await raceWithTimeout(proc, timeout);
		const duration = Math.round(performance.now() - startTime);

		const stdoutStream = proc.stdout as ReadableStream<Uint8Array> | null;
		const stderrStream = proc.stderr as ReadableStream<Uint8Array> | null;

		if (result.timedOut) {
			proc.kill();
			// Drain what we can
			const partialStdout = await drainStream(stdoutStream);
			const partialStderr = await drainStream(stderrStream);
			return {
				output: partialStdout,
				exitCode: 124, // conventional timeout exit code
				duration,
				error: `Agent timed out after ${timeout}ms. stderr: ${partialStderr}`,
			};
		}

		const [stdout, stderr] = await Promise.all([
			drainStream(stdoutStream),
			drainStream(stderrStream),
		]);
		const exitCode = result.exitCode ?? 1;

		// Attempt to parse JSON output
		const parsed = parseJsonOutput(stdout);

		if (parsed) {
			return {
				output: parsed.result ?? "",
				exitCode,
				duration: parsed.duration_ms ?? duration,
				tokens: extractTokens(parsed),
				cost: parsed.total_cost_usd ?? undefined,
				error: exitCode !== 0 ? stderr || undefined : undefined,
				sessionId: parsed.session_id ?? undefined,
			};
		}

		// JSON parse failed — fall back to raw stdout
		return {
			output: stdout,
			exitCode,
			duration,
			error: stderr || undefined,
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

async function drainStream(
	stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
	if (!stream) return "";
	try {
		const chunks: Uint8Array[] = [];
		const reader = stream.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		const decoder = new TextDecoder();
		return chunks.map((c) => decoder.decode(c, { stream: true })).join("");
	} catch {
		return "";
	}
}

interface RaceResult {
	timedOut: boolean;
	exitCode?: number;
}

async function raceWithTimeout(
	proc: ReturnType<typeof Bun.spawn>,
	timeoutMs: number,
): Promise<RaceResult> {
	return new Promise<RaceResult>((resolve) => {
		const timer = setTimeout(() => {
			resolve({ timedOut: true });
		}, timeoutMs);

		proc.exited.then((exitCode) => {
			clearTimeout(timer);
			resolve({ timedOut: false, exitCode });
		});
	});
}

// Re-export for testing
export { buildArgs, parseJsonOutput, type ClaudeCodeJsonOutput };
