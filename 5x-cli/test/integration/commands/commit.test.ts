/**
 * Integration tests for `5x commit` command.
 *
 * Spawns the CLI binary via `Bun.spawnSync` and validates stdout JSON
 * envelopes, exit codes, git state, and step journal recording.
 *
 * Phase 3 of 025-commit-tracking.plan.md.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
		`5x-commit-int-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

function git(args: string[], cwd: string): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.toString()}`,
		);
	}
	return result.stdout.toString().trim();
}

/** Set up a minimal git project with .5x init and plan file. */
function setupProject(dir: string): { planPath: string } {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);

	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "test-plan.md");
	writeFileSync(
		planPath,
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);

	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);

	return { planPath };
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

/** Create a run via CLI and return the run ID. */
async function initRun(projectRoot: string, planPath: string): Promise<string> {
	const result = await run5x(projectRoot, ["run", "init", "--plan", planPath]);
	expect(result.exitCode).toBe(0);
	const data = parseJson(result.stdout);
	expect(data.ok).toBe(true);
	return (data.data as { run_id: string }).run_id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("5x commit (integration)", () => {
	test(
		"happy path with --all-files: exit 0, valid JSON envelope, SHA in data",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const runId = await initRun(dir, planPath);

				// Create a file to commit
				writeFileSync(join(dir, "feature.ts"), "export const x = 1;\n");

				const result = await run5x(dir, [
					"commit",
					"--run",
					runId,
					"-m",
					"add feature",
					"--all-files",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				expect(data.hash).toBeTruthy();
				expect(typeof data.hash).toBe("string");
				expect((data.hash as string).length).toBeGreaterThanOrEqual(7);
				expect(data.short_hash).toBeTruthy();
				expect(data.message).toBe("add feature");
				expect(data.files).toContain("feature.ts");
				expect(data.run_id).toBe(runId);
				expect(data.step_id).toBeTruthy();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"happy path with --files: only specified files committed",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const runId = await initRun(dir, planPath);

				writeFileSync(join(dir, "a.ts"), "a\n");
				writeFileSync(join(dir, "b.ts"), "b\n");

				const result = await run5x(dir, [
					"commit",
					"--run",
					runId,
					"-m",
					"add a only",
					"--files",
					"a.ts",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				const files = data.files as string[];
				expect(files).toContain("a.ts");
				expect(files).not.toContain("b.ts");

				// b.ts should remain unstaged
				const status = git(["status", "--porcelain"], dir);
				expect(status).toContain("b.ts");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--dry-run: exit 0, no commit created, preview in output",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const runId = await initRun(dir, planPath);

				writeFileSync(join(dir, "dry-file.ts"), "dry\n");

				// Get current HEAD before dry-run
				const headBefore = git(["rev-parse", "HEAD"], dir);

				const result = await run5x(dir, [
					"commit",
					"--run",
					runId,
					"-m",
					"dry run test",
					"--all-files",
					"--dry-run",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				expect(data.dry_run).toBe(true);

				// No commit should have been created
				const headAfter = git(["rev-parse", "HEAD"], dir);
				expect(headAfter).toBe(headBefore);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"missing --files and --all-files: non-zero exit, error envelope",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const runId = await initRun(dir, planPath);

				const result = await run5x(dir, [
					"commit",
					"--run",
					runId,
					"-m",
					"should fail",
				]);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as { code: string; message: string };
				expect(error.code).toBe("INVALID_ARGS");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--text mode: human-readable output, not JSON",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const runId = await initRun(dir, planPath);

				writeFileSync(join(dir, "text-file.ts"), "text\n");

				const result = await run5x(dir, [
					"--text",
					"commit",
					"--run",
					runId,
					"-m",
					"text mode commit",
					"--all-files",
				]);

				expect(result.exitCode).toBe(0);
				// Text mode should NOT produce JSON envelope
				expect(result.stdout).not.toContain('{"ok"');
				// Should contain the short hash + message format
				expect(result.stdout).toContain("text mode commit");
				expect(result.stdout).toContain("1 files");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"step appears in run state after commit",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const runId = await initRun(dir, planPath);

				writeFileSync(join(dir, "state-check.ts"), "state\n");

				const commitResult = await run5x(dir, [
					"commit",
					"--run",
					runId,
					"-m",
					"state check commit",
					"--all-files",
				]);
				expect(commitResult.exitCode).toBe(0);

				// Check run state for the git:commit step
				const stateResult = await run5x(dir, ["run", "state", "--run", runId]);
				expect(stateResult.exitCode).toBe(0);

				const stateJson = parseJson(stateResult.stdout);
				expect(stateJson.ok).toBe(true);
				const stateData = stateJson.data as Record<string, unknown>;
				const steps = stateData.steps as Array<Record<string, unknown>>;

				const commitStep = steps.find((s) => s.step_name === "git:commit");
				expect(commitStep).toBeDefined();

				// Verify the result_json contains commit metadata
				const resultJson = JSON.parse(
					commitStep?.result_json as string,
				) as Record<string, unknown>;
				expect(resultJson.hash).toBeTruthy();
				expect(resultJson.message).toBe("state check commit");
				expect(resultJson.files).toContain("state-check.ts");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"hook failure: non-zero exit, COMMIT_FAILED, no step in run state",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);
				const runId = await initRun(dir, planPath);

				// Install a pre-commit hook that always fails
				const hookDir = join(dir, ".git", "hooks");
				mkdirSync(hookDir, { recursive: true });
				writeFileSync(
					join(hookDir, "pre-commit"),
					"#!/bin/sh\necho 'hook rejected'\nexit 1\n",
				);
				chmodSync(join(hookDir, "pre-commit"), 0o755);

				writeFileSync(join(dir, "hook-file.ts"), "hook\n");

				const result = await run5x(dir, [
					"commit",
					"--run",
					runId,
					"-m",
					"should be rejected",
					"--all-files",
				]);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as { code: string };
				expect(error.code).toBe("COMMIT_FAILED");

				// Verify no step was recorded
				const stateResult = await run5x(dir, ["run", "state", "--run", runId]);
				expect(stateResult.exitCode).toBe(0);
				const stateData = parseJson(stateResult.stdout).data as Record<
					string,
					unknown
				>;
				const steps = stateData.steps as Array<Record<string, unknown>>;
				const commitSteps = steps.filter((s) => s.step_name === "git:commit");
				expect(commitSteps).toHaveLength(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"mapped worktree end-to-end: commit in worktree branch, step recorded",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = setupProject(dir);

				// Create a run with --worktree to get a mapped worktree
				const initResult = await run5x(dir, [
					"run",
					"init",
					"--plan",
					planPath,
					"--worktree",
				]);
				expect(initResult.exitCode).toBe(0);
				const initData = parseJson(initResult.stdout);
				expect(initData.ok).toBe(true);
				const payload = initData.data as {
					run_id: string;
					worktree_path: string;
				};
				const runId = payload.run_id;
				const wtPath = payload.worktree_path;

				// Create a file in the worktree
				writeFileSync(join(wtPath, "wt-feature.ts"), "worktree code\n");

				// Commit from project root (the handler resolves worktree from run)
				const commitResult = await run5x(dir, [
					"commit",
					"--run",
					runId,
					"-m",
					"worktree commit",
					"--all-files",
				]);

				expect(commitResult.exitCode).toBe(0);
				const commitJson = parseJson(commitResult.stdout);
				expect(commitJson.ok).toBe(true);
				const commitData = commitJson.data as Record<string, unknown>;
				expect(commitData.hash).toBeTruthy();
				expect(commitData.files).toContain("wt-feature.ts");

				// Verify the commit exists in the worktree's git log
				const logOutput = git(["log", "--oneline", "-1"], wtPath);
				expect(logOutput).toContain("worktree commit");

				// Verify git:commit step in run state
				const stateResult = await run5x(dir, ["run", "state", "--run", runId]);
				expect(stateResult.exitCode).toBe(0);
				const stateData = parseJson(stateResult.stdout).data as Record<
					string,
					unknown
				>;
				const steps = stateData.steps as Array<Record<string, unknown>>;
				const commitStep = steps.find((s) => s.step_name === "git:commit");
				expect(commitStep).toBeDefined();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);
});
