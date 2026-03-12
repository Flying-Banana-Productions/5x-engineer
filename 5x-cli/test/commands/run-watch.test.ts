/**
 * Tests for `5x run watch` command.
 *
 * The watch command is long-running, so most tests use subprocess invocations
 * with pre-populated log files and SIGINT to terminate.
 */

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanGitEnv } from "../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-run-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function setupProject(dir: string): string {
	Bun.spawnSync(["git", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});

	// Minimal project structure
	mkdirSync(join(dir, "docs", "development"), { recursive: true });
	writeFileSync(
		join(dir, "docs", "development", "test-plan.md"),
		"# Plan\n\n## Phase 1\n\n- [ ] Task\n",
	);
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "commit", "-m", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});

	return dir;
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Run 5x CLI and collect output. Kills after timeoutMs to handle long-running watch. */
async function run5x(
	cwd: string,
	args: string[],
	timeoutMs = 5000,
): Promise<CmdResult> {
	const proc = Bun.spawn(["bun", "run", BIN, ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const timer = setTimeout(() => proc.kill("SIGINT"), timeoutMs);

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	clearTimeout(timer);
	return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function parseJson(stdout: string): Record<string, unknown> {
	return JSON.parse(stdout) as Record<string, unknown>;
}

function writeLine(file: string, obj: Record<string, unknown>): void {
	appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

/** Initialize a run via CLI and return the run ID. */
async function initRun(projectRoot: string): Promise<string> {
	const proc = Bun.spawn(
		[
			"bun",
			"run",
			BIN,
			"run",
			"init",
			"--plan",
			"docs/development/test-plan.md",
		],
		{
			cwd: projectRoot,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stdout = await new Response(proc.stdout).text();
	await proc.exited;
	const result = JSON.parse(stdout.trim()) as {
		ok: boolean;
		data: { run_id: string };
	};
	return result.data.run_id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("5x run watch", () => {
	test(
		"rejects invalid run-id",
		async () => {
			const dir = makeTmpDir();
			try {
				const projectRoot = setupProject(dir);
				const result = await run5x(projectRoot, [
					"run",
					"watch",
					"--run",
					"../../../etc/passwd",
				]);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				expect((json.error as Record<string, unknown>).code).toBe(
					"INVALID_ARGS",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"errors with RUN_NOT_FOUND when neither DB entry nor log dir exists",
		async () => {
			const dir = makeTmpDir();
			try {
				const projectRoot = setupProject(dir);
				const result = await run5x(projectRoot, [
					"run",
					"watch",
					"--run",
					"run_nonexistent1",
				]);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				expect((json.error as Record<string, unknown>).code).toBe(
					"RUN_NOT_FOUND",
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"warns and proceeds when DB entry missing but log dir exists",
		async () => {
			const dir = makeTmpDir();
			try {
				const projectRoot = setupProject(dir);

				// Create log dir manually (no run init)
				const logDir = join(projectRoot, ".5x", "logs", "run_fakeid12345");
				mkdirSync(logDir, { recursive: true });
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "t1",
					type: "text",
					delta: "hello",
				});

				const result = await run5x(
					projectRoot,
					["run", "watch", "--run", "run_fakeid12345", "--poll-interval", "10"],
					150,
				);
				expect(result.stderr).toContain("not found in DB");
				expect(result.stderr).toContain("Proceeding");

				// Should still output NDJSON lines
				const lines = result.stdout.split("\n").filter((l) => l.length > 0);
				expect(lines.length).toBeGreaterThanOrEqual(1);
				const entry = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
				expect(entry.source).toBe("agent-001.ndjson");
				expect(entry.type).toBe("text");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"outputs raw NDJSON by default with source field",
		async () => {
			const dir = makeTmpDir();
			try {
				const projectRoot = setupProject(dir);
				const runId = await initRun(projectRoot);

				// Write some log entries
				const logDir = join(projectRoot, ".5x", "logs", runId);
				mkdirSync(logDir, { recursive: true });
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:00Z",
					type: "session_start",
					role: "author",
					template: "author-next-phase",
					run: runId,
					phase_number: "1",
				});
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:01Z",
					type: "text",
					delta: "Hello world",
				});

				const result = await run5x(
					projectRoot,
					["run", "watch", "--run", runId, "--poll-interval", "10"],
					150,
				);

				const lines = result.stdout.split("\n").filter((l) => l.length > 0);
				expect(lines.length).toBe(2);

				const line1 = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
				expect(line1.source).toBe("agent-001.ndjson");
				expect(line1.type).toBe("session_start");
				expect(line1.role).toBe("author");

				const line2 = JSON.parse(lines[1] ?? "") as Record<string, unknown>;
				expect(line2.source).toBe("agent-001.ndjson");
				expect(line2.type).toBe("text");
				expect(line2.delta).toBe("Hello world");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--human-readable renders session_start as label header",
		async () => {
			const dir = makeTmpDir();
			try {
				const projectRoot = setupProject(dir);
				const runId = await initRun(projectRoot);

				const logDir = join(projectRoot, ".5x", "logs", runId);
				mkdirSync(logDir, { recursive: true });
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:00Z",
					type: "session_start",
					role: "author",
					template: "author-next-phase",
					run: runId,
					phase_number: "1",
				});
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:01Z",
					type: "text",
					delta: "Implementation started\n",
				});

				const result = await run5x(
					projectRoot,
					[
						"run",
						"watch",
						"--run",
						runId,
						"--human-readable",
						"--poll-interval",
						"10",
					],
					500,
				);

				// Should contain the label header
				expect(result.stdout).toContain("[author-phase-1]");
				// Should contain the text content (newline in delta ensures StreamWriter flushes)
				expect(result.stdout).toContain("Implementation started");
				// Should NOT contain raw JSON
				expect(result.stdout).not.toContain('"source"');
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--human-readable handles multi-file with label switching",
		async () => {
			const dir = makeTmpDir();
			try {
				const projectRoot = setupProject(dir);
				const runId = await initRun(projectRoot);

				const logDir = join(projectRoot, ".5x", "logs", runId);
				mkdirSync(logDir, { recursive: true });

				// Agent 1: author phase 1
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:00Z",
					type: "session_start",
					role: "author",
					template: "author-next-phase",
					run: runId,
					phase_number: "1",
				});
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:01Z",
					type: "text",
					delta: "Author output\n",
				});

				// Agent 2: reviewer phase 1
				writeLine(join(logDir, "agent-002.ndjson"), {
					ts: "2026-01-01T00:00:02Z",
					type: "session_start",
					role: "reviewer",
					template: "reviewer-commit",
					run: runId,
					phase_number: "1",
				});
				writeLine(join(logDir, "agent-002.ndjson"), {
					ts: "2026-01-01T00:00:03Z",
					type: "text",
					delta: "Reviewer output\n",
				});

				const result = await run5x(
					projectRoot,
					[
						"run",
						"watch",
						"--run",
						runId,
						"--human-readable",
						"--poll-interval",
						"10",
					],
					500,
				);

				// Both labels should appear
				expect(result.stdout).toContain("[author-phase-1]");
				expect(result.stdout).toContain("[reviewer-phase-1]");
				expect(result.stdout).toContain("Author output");
				expect(result.stdout).toContain("Reviewer output");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--no-replay skips existing content",
		async () => {
			const dir = makeTmpDir();
			try {
				const projectRoot = setupProject(dir);
				const runId = await initRun(projectRoot);

				const logDir = join(projectRoot, ".5x", "logs", runId);
				mkdirSync(logDir, { recursive: true });
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:00Z",
					type: "text",
					delta: "old content",
				});

				const result = await run5x(
					projectRoot,
					[
						"run",
						"watch",
						"--run",
						runId,
						"--tail-only",
						"--poll-interval",
						"10",
					],
					150,
				);

				// Should not contain existing content
				expect(result.stdout).not.toContain("old content");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--human-readable falls back to filename for unknown files",
		async () => {
			const dir = makeTmpDir();
			try {
				const projectRoot = setupProject(dir);
				const runId = await initRun(projectRoot);

				const logDir = join(projectRoot, ".5x", "logs", runId);
				mkdirSync(logDir, { recursive: true });

				// No session_start — just a text event
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:00Z",
					type: "text",
					delta: "unlabeled\n",
				});

				const result = await run5x(
					projectRoot,
					[
						"run",
						"watch",
						"--run",
						runId,
						"--human-readable",
						"--poll-interval",
						"10",
					],
					500,
				);

				// Should fall back to filename-based label
				expect(result.stdout).toContain("[agent-001]");
				expect(result.stdout).toContain("unlabeled");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"exits non-zero on unexpected streaming error (P1.1)",
		async () => {
			const dir = makeTmpDir();
			try {
				const projectRoot = setupProject(dir);
				const runId = await initRun(projectRoot);

				// Write multiple log entries so the harness can throw after the first write
				const logDir = join(projectRoot, ".5x", "logs", runId);
				mkdirSync(logDir, { recursive: true });
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:00Z",
					type: "text",
					delta: "first line",
				});
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:01Z",
					type: "text",
					delta: "second line",
				});
				writeLine(join(logDir, "agent-001.ndjson"), {
					ts: "2026-01-01T00:00:02Z",
					type: "text",
					delta: "third line",
				});

				const harness = resolve(
					import.meta.dir,
					"../helpers/watch-error-harness.ts",
				);
				const proc = Bun.spawn(["bun", "run", harness, projectRoot, runId], {
					cwd: projectRoot,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});

				const [stderr, exitCode] = await Promise.all([
					new Response(proc.stderr).text(),
					proc.exited,
				]);

				expect(stderr).toContain("[watch] Error:");
				expect(exitCode).not.toBe(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);
});
