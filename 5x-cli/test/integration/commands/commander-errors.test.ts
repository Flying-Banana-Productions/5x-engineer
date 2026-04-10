/**
 * Integration tests for commander.js error handling.
 *
 * Validates that commander error codes are mapped to the correct JSON
 * envelope error codes:
 *   - commander.unknownCommand  -> UNKNOWN_COMMAND
 *   - commander.unknownOption   -> UNKNOWN_OPTION
 *   - choice/required validation -> INVALID_ARGS
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-cmdr-err-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(cwd: string, args: string[]): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

describe("commander error code mapping", () => {
	test(
		"unknown command produces UNKNOWN_COMMAND envelope",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["run", "int"]);
				expect(result.exitCode).toBe(1);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				const error = data.error as { code: string; message: string };
				expect(error.code).toBe("UNKNOWN_COMMAND");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"unknown option produces UNKNOWN_OPTION envelope",
		async () => {
			const tmp = makeTmpDir();
			try {
				// Use `run list` (no required options) to avoid required-option
				// errors masking the unknown-option error
				const result = await run5x(tmp, ["run", "list", "--bogus"]);
				expect(result.exitCode).toBe(1);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				const error = data.error as { code: string; message: string };
				expect(error.code).toBe("UNKNOWN_OPTION");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"invalid choice produces INVALID_ARGS envelope",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, [
					"run",
					"complete",
					"-r",
					"abc",
					"-s",
					"invalid",
				]);
				expect(result.exitCode).toBe(1);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				const error = data.error as { code: string; message: string };
				expect(error.code).toBe("INVALID_ARGS");
				expect(error.message).toContain("Allowed choices");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"missing required option produces INVALID_ARGS envelope",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["run", "init"]);
				expect(result.exitCode).toBe(1);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				const error = data.error as { code: string; message: string };
				expect(error.code).toBe("INVALID_ARGS");
				expect(error.message).toContain("required");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});

describe("--pretty/--no-pretty on parse errors", () => {
	test(
		"--no-pretty on parse error produces compact JSON envelope",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--no-pretty", "run", "init"]);
				expect(result.exitCode).toBe(1);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				// Compact JSON: no newlines between braces
				expect(result.stdout).not.toContain("\n  ");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--pretty on parse error produces formatted JSON envelope",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["run", "init", "--pretty"]);
				expect(result.exitCode).toBe(1);
				// Pretty JSON: has indentation
				expect(result.stdout).toContain("\n  ");
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});

describe("--worktree [path] consolidation", () => {
	function setupProject(dir: string): { planPath: string } {
		Bun.spawnSync(["git", "init"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		Bun.spawnSync(["git", "config", "user.name", "Test"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		const planDir = join(dir, "docs", "development");
		mkdirSync(planDir, { recursive: true });
		const planPath = join(planDir, "001-test.md");
		writeFileSync(planPath, "# Plan\n\n## Phase 1\n\n- [ ] Task\n");

		mkdirSync(join(dir, ".5x"), { recursive: true });
		writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");

		Bun.spawnSync(["git", "add", "-A"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		Bun.spawnSync(["git", "commit", "-m", "init"], {
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});

		return { planPath };
	}

	test(
		"--worktree-path backward compat emits deprecation warning",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { planPath } = setupProject(tmp);
				const result = await run5x(tmp, [
					"run",
					"init",
					"--plan",
					planPath,
					"--worktree",
					"--worktree-path",
					join(tmp, "wt-dir"),
				]);
				expect(result.stderr).toContain("--worktree-path is deprecated");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"-w flag works as --worktree boolean shorthand",
		async () => {
			const tmp = makeTmpDir();
			try {
				const { planPath } = setupProject(tmp);
				const result = await run5x(tmp, ["run", "init", "-p", planPath, "-w"]);
				// Should succeed and create a worktree
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { worktree?: Record<string, unknown> };
				expect(payload.worktree).toBeDefined();
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});
