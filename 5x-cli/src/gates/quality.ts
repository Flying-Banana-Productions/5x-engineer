import {
	createWriteStream,
	existsSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { endStream } from "../utils/stream.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QualityCommandResult {
	command: string;
	passed: boolean;
	output: string; // truncated for DB/display (first 4KB)
	outputPath?: string; // full output written to log file
	duration: number; // ms
}

export interface QualityResult {
	passed: boolean;
	results: QualityCommandResult[];
}

export interface QualityGateOptions {
	runId: string;
	logDir: string; // .5x/logs/<run-id>/
	phase: string;
	attempt: number;
	timeout?: number; // per-command timeout in ms, default 300_000
	onCommandStart?: (info: {
		index: number;
		total: number;
		command: string;
	}) => void | Promise<void>;
	onCommandComplete?: (info: {
		index: number;
		total: number;
		result: QualityCommandResult;
	}) => void | Promise<void>;
}

async function invokeHook(
	hook: (() => void | Promise<void>) | undefined,
): Promise<void> {
	if (!hook) return;
	try {
		await hook();
	} catch {
		// Best-effort progress hooks; never fail gate execution.
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INLINE_HEAD_BYTES = 2048; // first 2KB for inline output
const INLINE_TAIL_BYTES = 2048; // last 2KB for inline output
const DEFAULT_TIMEOUT = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slugify a command string for use in log filenames. */
function commandSlug(command: string): string {
	return command
		.replace(/[^a-zA-Z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60)
		.toLowerCase();
}

/**
 * Bounded ring buffer that captures the first N and last N bytes of a stream
 * for inline display, without buffering the full output in memory.
 */
class BoundedCapture {
	private head: Buffer[] = [];
	private headBytes = 0;
	private tail: Buffer[] = [];
	private tailBytes = 0;
	private totalBytes = 0;
	private readonly headLimit: number;
	private readonly tailLimit: number;

	constructor(headLimit = INLINE_HEAD_BYTES, tailLimit = INLINE_TAIL_BYTES) {
		this.headLimit = headLimit;
		this.tailLimit = tailLimit;
	}

	push(chunk: Buffer): void {
		this.totalBytes += chunk.length;

		// Fill head buffer first
		if (this.headBytes < this.headLimit) {
			const remaining = this.headLimit - this.headBytes;
			if (chunk.length <= remaining) {
				this.head.push(chunk);
				this.headBytes += chunk.length;
				return; // fully consumed into head
			}
			this.head.push(chunk.subarray(0, remaining));
			this.headBytes += remaining;
			chunk = chunk.subarray(remaining);
		}

		// Append to tail, evicting old data to stay within tailLimit
		this.tail.push(chunk);
		this.tailBytes += chunk.length;
		while (this.tailBytes > this.tailLimit && this.tail.length > 1) {
			const evicted = this.tail.shift();
			if (evicted) this.tailBytes -= evicted.length;
		}
		// If a single chunk exceeds tailLimit, trim from the start
		if (this.tailBytes > this.tailLimit && this.tail.length === 1) {
			const buf = this.tail[0] as Buffer;
			this.tail[0] = buf.subarray(buf.length - this.tailLimit);
			this.tailBytes = this.tail[0].length;
		}
	}

	/** Build the inline output string. */
	toString(): string {
		const headStr = Buffer.concat(this.head).toString("utf-8");
		if (this.totalBytes <= this.headLimit) {
			return headStr;
		}
		const tailStr = Buffer.concat(this.tail).toString("utf-8");
		return `${headStr}\n... [truncated — see full log file]\n${tailStr}`;
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run all configured quality gate commands sequentially.
 * Each command is run as a subprocess in the given workdir.
 * Full output is written to log files; truncated output stored in results.
 */
export async function runQualityGates(
	commands: string[],
	workdir: string,
	opts: QualityGateOptions,
): Promise<QualityResult> {
	const results: QualityCommandResult[] = [];
	let allPassed = true;

	// Ensure log directory exists with user-only permissions (consistent with orchestrators)
	if (!existsSync(opts.logDir)) {
		mkdirSync(opts.logDir, { recursive: true, mode: 0o700 });
	}

	for (const [idx, command] of commands.entries()) {
		await invokeHook(() =>
			opts.onCommandStart?.({
				index: idx,
				total: commands.length,
				command,
			}),
		);

		const result = await runSingleCommand(command, workdir, opts);
		results.push(result);

		await invokeHook(() =>
			opts.onCommandComplete?.({
				index: idx,
				total: commands.length,
				result,
			}),
		);
		if (!result.passed) {
			allPassed = false;
		}
	}

	return { passed: allPassed, results };
}

/**
 * Stream a readable stream to both a log file and a bounded capture buffer.
 * Returns when the stream is fully consumed.
 */
async function drainStream(
	stream: ReadableStream<Uint8Array>,
	logStream: NodeJS.WritableStream,
	capture: BoundedCapture,
): Promise<void> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const buf = Buffer.from(value);
			logStream.write(buf);
			capture.push(buf);
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Run a single quality gate command. Exposed for testing.
 *
 * Streams stdout/stderr directly to the log file while maintaining a bounded
 * in-memory buffer (first 2KB + last 2KB) for the truncated inline output.
 * This prevents OOM on large build/test logs.
 */
export async function runSingleCommand(
	command: string,
	workdir: string,
	opts: QualityGateOptions,
): Promise<QualityCommandResult> {
	const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
	const slug = commandSlug(command);
	const logFileName = `quality-phase${opts.phase}-attempt${opts.attempt}-${slug}.log`;
	const logPath = join(opts.logDir, logFileName);

	const start = performance.now();

	try {
		const proc = Bun.spawn(["sh", "-c", command], {
			cwd: workdir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});

		// Open log file for streaming writes.
		// Attach an error handler immediately: disk-full / permission errors emit
		// 'error' on the stream; without a listener Node.js would crash the process.
		// Log write failures are best-effort — we warn and keep running.
		const logStream = createWriteStream(logPath);
		logStream.on("error", (err) => {
			console.warn(
				`[warn] quality gate log write failed (${logPath}): ${err.message}`,
			);
		});
		const stdoutCapture = new BoundedCapture();
		const stderrCapture = new BoundedCapture();

		// Stream both stdout and stderr concurrently to the log file.
		// Individual write() calls are serialized by the stream, so chunks
		// may interleave but won't corrupt each other. The inline captures
		// are kept separate and combined with a marker at the end.
		const stdoutDone = drainStream(proc.stdout, logStream, stdoutCapture);
		const stderrDone = drainStream(proc.stderr, logStream, stderrCapture);

		// Race subprocess against timeout
		const timeoutPromise = new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), timeout),
		);
		const exitPromise = proc.exited;
		const race = await Promise.race([exitPromise, timeoutPromise]);

		if (race === "timeout") {
			proc.kill("SIGTERM");
			await Promise.race([
				proc.exited,
				new Promise((r) => setTimeout(r, 2000)),
			]);
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already dead
			}

			// Drain any remaining data then append timeout marker —
			// preserves partial output already streamed to the log file.
			await Promise.allSettled([stdoutDone, stderrDone]);
			const timeoutMsg = `\n[TIMEOUT] Command timed out after ${Math.round(timeout / 1000)}s: ${command}\n`;
			logStream.write(timeoutMsg);
			await endStream(logStream);

			const duration = performance.now() - start;
			const stderrStr = stderrCapture.toString();
			let partial = stdoutCapture.toString();
			if (stderrStr) {
				partial += `\n--- stderr ---\n${stderrStr}`;
			}
			const output = `${partial}\n[TIMEOUT] Command timed out after ${Math.round(timeout / 1000)}s: ${command}`;

			return {
				command,
				passed: false,
				output,
				outputPath: logPath,
				duration,
			};
		}

		const exitCode = race as number;
		const duration = performance.now() - start;

		// Wait for streams to fully drain
		await Promise.all([stdoutDone, stderrDone]);
		await endStream(logStream);

		// Build inline output — stdout capture + optional stderr section
		const stderrStr = stderrCapture.toString();
		let inlineOutput = stdoutCapture.toString();
		if (stderrStr) {
			inlineOutput += `\n--- stderr ---\n${stderrStr}`;
		}

		return {
			command,
			passed: exitCode === 0,
			output: inlineOutput,
			outputPath: logPath,
			duration,
		};
	} catch (err) {
		const duration = performance.now() - start;
		const errMsg =
			err instanceof Error ? err.message : "Unknown error running command";
		const output = `[ERROR] ${errMsg}`;
		writeFileSync(logPath, output);

		return {
			command,
			passed: false,
			output,
			outputPath: logPath,
			duration,
		};
	}
}
