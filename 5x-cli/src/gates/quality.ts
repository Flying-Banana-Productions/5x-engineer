import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
	phase: number;
	attempt: number;
	timeout?: number; // per-command timeout in ms, default 300_000
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_INLINE_OUTPUT = 4096; // 4KB truncation for DB/display
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

/** Truncate output to MAX_INLINE_OUTPUT bytes, appending a notice if truncated. */
function truncateOutput(output: string): string {
	if (output.length <= MAX_INLINE_OUTPUT) return output;
	return `${output.slice(0, MAX_INLINE_OUTPUT)}\n... [truncated — see full log file]`;
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

	// Ensure log directory exists
	if (!existsSync(opts.logDir)) {
		mkdirSync(opts.logDir, { recursive: true });
	}

	for (const command of commands) {
		const result = await runSingleCommand(command, workdir, opts);
		results.push(result);
		if (!result.passed) {
			allPassed = false;
		}
	}

	return { passed: allPassed, results };
}

/**
 * Run a single quality gate command. Exposed for testing.
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

		// Race subprocess against timeout
		const timeoutPromise = new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), timeout),
		);
		const exitPromise = proc.exited;
		const race = await Promise.race([exitPromise, timeoutPromise]);

		if (race === "timeout") {
			proc.kill("SIGTERM");
			// Wait a brief grace then force-kill
			await Promise.race([
				proc.exited,
				new Promise((r) => setTimeout(r, 2000)),
			]);
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already dead
			}

			const duration = performance.now() - start;
			const output = `[TIMEOUT] Command timed out after ${Math.round(timeout / 1000)}s: ${command}`;
			writeFileSync(logPath, output);

			return {
				command,
				passed: false,
				output: truncateOutput(output),
				outputPath: logPath,
				duration,
			};
		}

		const exitCode = race as number;
		const duration = performance.now() - start;

		// Drain stdout/stderr
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);

		const fullOutput = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");

		// Write full output to log file
		writeFileSync(logPath, fullOutput);

		return {
			command,
			passed: exitCode === 0,
			output: truncateOutput(fullOutput),
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
			output: truncateOutput(output),
			outputPath: logPath,
			duration,
		};
	}
}
