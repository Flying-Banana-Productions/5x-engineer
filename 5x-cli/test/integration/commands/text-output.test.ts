/**
 * Integration tests for --text / --json output format flags and
 * FIVEX_OUTPUT_FORMAT environment variable.
 *
 * Covers: Phase 4b (flags + env), Phase 4c (text-mode errors),
 * Phase 4d (custom formatters), Phase 4e (generic fallback).
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-text-out-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

async function run5x(
	cwd: string,
	args: string[],
	env?: Record<string, string | undefined>,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: { ...cleanGitEnv(), ...env },
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

/** Set up a minimal git project for commands that need one. */
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
	const planPath = join(planDir, "test-plan.md");
	writeFileSync(
		planPath,
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Task A\n- [x] Task B\n\n## Phase 2: Build\n\n- [ ] Task C\n",
	);

	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");
	writeFileSync(join(dir, "file.txt"), "original content\n");

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

// ---------------------------------------------------------------------------
// Phase 4b: --text flag and env var
// ---------------------------------------------------------------------------

describe("--text / --json flag and env var", () => {
	test(
		"--text at start of argv: no JSON envelope in stdout",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--text", "harness", "list"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).not.toContain('{"ok"');
				// Should have text output instead
				expect(result.stdout).toContain("harness");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--text at end of argv: no JSON envelope in stdout",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["harness", "list", "--text"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).not.toContain('{"ok"');
				expect(result.stdout).toContain("harness");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--json overrides --text: last flag wins",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, [
					"--text",
					"--json",
					"harness",
					"list",
				]);
				expect(result.exitCode).toBe(0);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.ok).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"FIVEX_OUTPUT_FORMAT=text activates text mode",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["harness", "list"], {
					FIVEX_OUTPUT_FORMAT: "text",
				});
				expect(result.exitCode).toBe(0);
				expect(result.stdout).not.toContain('{"ok"');
				expect(result.stdout).toContain("harness");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--json overrides FIVEX_OUTPUT_FORMAT=text",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--json", "harness", "list"], {
					FIVEX_OUTPUT_FORMAT: "text",
				});
				expect(result.exitCode).toBe(0);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.ok).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"unknown FIVEX_OUTPUT_FORMAT value is ignored (defaults to JSON)",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["harness", "list"], {
					FIVEX_OUTPUT_FORMAT: "bogus",
				});
				expect(result.exitCode).toBe(0);
				const envelope = JSON.parse(result.stdout);
				expect(envelope.ok).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--pretty is ignored in text mode: produces text, not JSON",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, [
					"--text",
					"--pretty",
					"harness",
					"list",
				]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).not.toContain('{"ok"');
				expect(result.stdout).toContain("harness");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--no-pretty is ignored in text mode: produces text, not JSON",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, [
					"--text",
					"--no-pretty",
					"harness",
					"list",
				]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).not.toContain('{"ok"');
				expect(result.stdout).toContain("harness");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--pretty still works in JSON mode (unchanged behavior)",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--pretty", "harness", "list"]);
				expect(result.exitCode).toBe(0);
				// Pretty JSON has newlines and indentation
				expect(result.stdout).toContain("\n");
				expect(result.stdout).toContain('  "ok"');
				const envelope = JSON.parse(result.stdout);
				expect(envelope.ok).toBe(true);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Text-mode help/version display
// ---------------------------------------------------------------------------

describe("text-mode help and version display", () => {
	test(
		"no args in text mode: shows help and exits 0",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, [], {
					FIVEX_OUTPUT_FORMAT: "text",
				});
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Usage:");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--text with no args: shows help and exits 0",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--text"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Usage:");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--text --help: shows help and exits 0",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--text", "--help"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Usage:");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--text -V: shows version and exits 0",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--text", "-V"]);
				expect(result.exitCode).toBe(0);
				// Version string should be a semver-like pattern
				expect(result.stdout).toMatch(/\d+\.\d+/);
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Phase 4c: Text-mode errors
// ---------------------------------------------------------------------------

describe("text-mode error handling", () => {
	test(
		"missing required option: single Error line on stderr, no Commander help",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--text", "run", "init"]);
				expect(result.exitCode).toBe(1);
				// Exactly one Error: line on stderr
				const errorLines = result.stderr
					.split("\n")
					.filter((l) => l.startsWith("Error:"));
				expect(errorLines).toHaveLength(1);
				// No Commander help/usage text
				expect(result.stderr).not.toContain("Usage:");
				expect(result.stderr).not.toContain("Options:");
				// stdout should be empty
				expect(result.stdout).toBe("");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"unknown command: single Error line on stderr, no Commander suggestion",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--text", "bogus"]);
				expect(result.exitCode).toBe(1);
				const errorLines = result.stderr
					.split("\n")
					.filter((l) => l.startsWith("Error:"));
				expect(errorLines).toHaveLength(1);
				// No Commander suggestion text
				expect(result.stderr).not.toContain("(Did you mean");
				expect(result.stdout).toBe("");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"unknown option: single Error line on stderr, no Commander help",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--text", "run", "list", "--bogus"]);
				expect(result.exitCode).toBe(1);
				const errorLines = result.stderr
					.split("\n")
					.filter((l) => l.startsWith("Error:"));
				expect(errorLines).toHaveLength(1);
				expect(result.stderr).not.toContain("Usage:");
				expect(result.stdout).toBe("");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"CliError in text mode: Error on stderr, stdout empty",
		async () => {
			const tmp = makeTmpDir();
			try {
				setupProject(tmp);
				const result = await run5x(tmp, [
					"--text",
					"run",
					"complete",
					"-r",
					"nonexistent",
				]);
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain("Error:");
				expect(result.stdout).toBe("");
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"JSON mode error unchanged: missing --plan produces JSON envelope on stdout",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["run", "init"]);
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toContain('{"ok":false');
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Phase 4d: Custom formatter integration tests
// ---------------------------------------------------------------------------

describe("custom formatter output (--text)", () => {
	test(
		"diff --text with changes: raw diff text, not JSON",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				writeFileSync(join(dir, "file.txt"), "modified content\n");

				const result = await run5x(dir, ["--text", "diff"]);
				expect(result.exitCode).toBe(0);
				// Raw diff text
				expect(result.stdout).toContain("file.txt");
				expect(result.stdout).toContain("-original content");
				expect(result.stdout).toContain("+modified content");
				// Not JSON
				expect(result.stdout).not.toContain('"data"');
				expect(result.stdout).not.toContain('"ref"');
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"diff --text --stat: includes file(s) changed summary",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				writeFileSync(join(dir, "file.txt"), "modified content\n");

				const result = await run5x(dir, ["--text", "diff", "--stat"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("file(s) changed");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"run state --text: contains section headers",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);

				// Init a run
				const initResult = await run5x(dir, [
					"run",
					"init",
					"--plan",
					planPath,
				]);
				expect(initResult.exitCode).toBe(0);
				const initData = JSON.parse(initResult.stdout);
				const runId = initData.data.run_id;

				// Record a step so Steps: and Summary: sections appear
				const recordResult = await run5x(dir, [
					"run",
					"record",
					"author:phase-1",
					"--run",
					runId,
					"--result",
					'{"status":"complete"}',
				]);
				expect(recordResult.exitCode).toBe(0);

				// State in text mode
				const result = await run5x(dir, [
					"--text",
					"run",
					"state",
					"--run",
					runId,
				]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Run:");
				expect(result.stdout).toContain("Status:");
				expect(result.stdout).toContain("Steps:");
				expect(result.stdout).toContain("Summary:");
				// Not JSON
				expect(result.stdout).not.toContain('{"ok"');
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run list --text: contains column headers",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);

				// Create a run first
				const initResult = await run5x(dir, [
					"run",
					"init",
					"--plan",
					planPath,
				]);
				expect(initResult.exitCode).toBe(0);

				const result = await run5x(dir, ["--text", "run", "list"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("ID");
				expect(result.stdout).toContain("Plan");
				// Not JSON
				expect(result.stdout).not.toContain('{"ok"');
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"run list --text with no runs: empty message",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, ["--text", "run", "list"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("(no runs)");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"plan phases --text: contains checkbox notation",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);

				const result = await run5x(dir, ["--text", "plan", "phases", planPath]);
				expect(result.exitCode).toBe(0);
				// Should contain checkbox notation
				expect(result.stdout).toMatch(/\[[ x]\]/);
				// Not JSON
				expect(result.stdout).not.toContain('{"ok"');
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// Phase 4e: Generic formatter fallback
// ---------------------------------------------------------------------------

describe("generic formatter fallback (--text)", () => {
	test(
		"run complete --text: plain text key-value, not JSON",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);

				// Init a run
				const initResult = await run5x(dir, [
					"run",
					"init",
					"--plan",
					planPath,
				]);
				expect(initResult.exitCode).toBe(0);
				const initData = JSON.parse(initResult.stdout);
				const runId = initData.data.run_id;

				// Complete in text mode
				const result = await run5x(dir, [
					"--text",
					"run",
					"complete",
					"-r",
					runId,
					"--status",
					"completed",
				]);
				expect(result.exitCode).toBe(0);
				// Should have key-value text
				expect(result.stdout).toContain("run_id");
				expect(result.stdout).toContain("status");
				expect(result.stdout).toContain("completed");
				// Not JSON
				expect(result.stdout).not.toContain('{"ok"');
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"harness list --text: plain text key-value, not JSON",
		async () => {
			const tmp = makeTmpDir();
			try {
				const result = await run5x(tmp, ["--text", "harness", "list"]);
				expect(result.exitCode).toBe(0);
				// Should contain key-value text
				expect(result.stdout).toContain("harness");
				expect(result.stdout).toContain("opencode");
				// Not JSON
				expect(result.stdout).not.toContain('{"ok"');
			} finally {
				cleanupDir(tmp);
			}
		},
		{ timeout: 15000 },
	);
});
