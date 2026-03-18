/**
 * Adapter-level tests for global --pretty / --no-pretty flag parsing in bin.ts
 * and import-time TTY auto-detection in output.ts.
 *
 * These tests run the CLI as a subprocess (bin.ts entry point) so they exercise
 * the real flag-preprocessing code path rather than calling setPrettyPrint()
 * directly.  Subprocess stdout is piped, so the TTY auto-detect default is
 * compact (non-TTY).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-bin-pretty-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Run the CLI via bin.ts with given args, capturing stdout/stderr.
 * Uses `harness list` as a lightweight command that always
 * produces a JSON envelope.
 */
async function runCli(
	cwd: string,
	extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", "run", BIN, "harness", "list", ...extraArgs], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: cleanGitEnv(),
	});
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/** True if the JSON string is pretty-printed (contains newlines + indentation). */
function isPretty(json: string): boolean {
	return json.includes("\n") && json.includes('  "ok"');
}

describe("bin.ts global pretty flag parsing", () => {
	test(
		"default: compact JSON when stdout is piped (TTY auto-detect)",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runCli(tmp);
				expect(exitCode).toBe(0);
				expect(isPretty(stdout)).toBe(false);
				// Verify it's still valid JSON
				const envelope = JSON.parse(stdout.trim());
				expect(envelope.ok).toBe(true);
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--pretty: forces pretty-printed JSON",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runCli(tmp, ["--pretty"]);
				expect(exitCode).toBe(0);
				expect(isPretty(stdout)).toBe(true);
				const envelope = JSON.parse(stdout.trim());
				expect(envelope.ok).toBe(true);
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--no-pretty: forces compact JSON",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runCli(tmp, ["--no-pretty"]);
				expect(exitCode).toBe(0);
				expect(isPretty(stdout)).toBe(false);
				const envelope = JSON.parse(stdout.trim());
				expect(envelope.ok).toBe(true);
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--pretty --no-pretty: last flag wins (compact)",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runCli(tmp, [
					"--pretty",
					"--no-pretty",
				]);
				expect(exitCode).toBe(0);
				expect(isPretty(stdout)).toBe(false);
				const envelope = JSON.parse(stdout.trim());
				expect(envelope.ok).toBe(true);
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--no-pretty --pretty: last flag wins (pretty)",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { stdout, exitCode } = await runCli(tmp, [
					"--no-pretty",
					"--pretty",
				]);
				expect(exitCode).toBe(0);
				expect(isPretty(stdout)).toBe(true);
				const envelope = JSON.parse(stdout.trim());
				expect(envelope.ok).toBe(true);
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);
});
