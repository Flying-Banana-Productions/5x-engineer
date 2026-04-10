/**
 * Tests for --record and --record-step flags on `5x quality run` (Phase 6).
 *
 * Validates that quality --record auto-records as "quality:check",
 * that --record-step overrides the default, that --run is required,
 * and that recording failures don't suppress the primary envelope.
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
		`5x-quality-record-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/** Create a project with git repo, optional quality gates, and an active run. */
async function setupProjectWithRun(
	dir: string,
	qualityGates: string[] = ["echo ok"],
): Promise<{
	projectRoot: string;
	runId: string;
}> {
	// Init git repo
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

	// Create plan file
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "test-plan.md");
	writeFileSync(
		planPath,
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);

	// Create .5x directory and gitignore it
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");

	// Write config with quality gates (using TOML)
	if (qualityGates.length > 0) {
		const gatesArray = qualityGates.map((g) => `"${g}"`).join(", ");
		writeFileSync(join(dir, "5x.toml"), `qualityGates = [${gatesArray}]\n`);
	}

	// Initial commit
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

	// Init a run
	const initProc = Bun.spawn(
		["bun", "run", BIN, "run", "init", "--plan", planPath],
		{
			cwd: dir,
			env: cleanGitEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const initStdout = await new Response(initProc.stdout).text();
	await initProc.exited;
	const initData = JSON.parse(initStdout.trim()) as {
		ok: boolean;
		data: { run_id: string };
	};
	if (!initData.ok) {
		throw new Error(`Failed to init run: ${initStdout}`);
	}

	return { projectRoot: dir, runId: initData.data.run_id };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("quality run --record", () => {
	test(
		"records with default step name 'quality:check'",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				const result = await run5x(projectRoot, [
					"quality",
					"run",
					"--record",
					"--run",
					runId,
				]);

				// Primary envelope should be quality result
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.passed).toBe(true);
				expect(data.results).toBeArray();

				// Verify step was recorded in DB
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const stateJson = parseJson(state.stdout);
				expect(stateJson.ok).toBe(true);
				const steps = (stateJson.data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				expect(steps.length).toBeGreaterThanOrEqual(1);
				expect(steps[0]?.step_name).toBe("quality:check");

				// Verify result_json contains quality data
				const resultJson = JSON.parse(
					steps[0]?.result_json as string,
				) as Record<string, unknown>;
				expect(resultJson.passed).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--record-step overrides default step name",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				const result = await run5x(projectRoot, [
					"quality",
					"run",
					"--record",
					"--record-step",
					"quality:gates",
					"--run",
					runId,
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				// Verify step was recorded with custom step name
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				expect(steps.length).toBeGreaterThanOrEqual(1);
				expect(steps[0]?.step_name).toBe("quality:gates");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--record without --run errors with warning on stderr, not a second envelope",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot } = await setupProjectWithRun(dir);

				const result = await run5x(projectRoot, ["quality", "run", "--record"]);

				// Quality runs first (producing the primary envelope), then recording
				// validation fails because --run is missing. The warning goes to stderr
				// (never outputError, which would produce a second JSON envelope on stdout).
				expect(result.exitCode).not.toBe(0);

				// Primary envelope should be the only JSON on stdout
				const trimmed = result.stdout.trim();
				const json = JSON.parse(trimmed) as Record<string, unknown>;
				expect(json.ok).toBe(true);
				expect(() => JSON.parse(trimmed)).not.toThrow();

				// stderr should contain a warning about --run
				expect(result.stderr).toContain("--run");
				expect(result.stderr).toContain("Warning");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--record still outputs quality JSON envelope to stdout",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				const result = await run5x(projectRoot, [
					"quality",
					"run",
					"--record",
					"--run",
					runId,
				]);

				// Should output only one envelope (the quality result)
				const trimmed = result.stdout.trim();
				const json = JSON.parse(trimmed) as Record<string, unknown>;
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;

				// Should be quality data, not recording data
				expect(data).toHaveProperty("passed");
				expect(data).toHaveProperty("results");
				expect(data).not.toHaveProperty("step_id");
				expect(data).not.toHaveProperty("recorded");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--record with --phase passes phase to recorded step",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot, runId } = await setupProjectWithRun(dir);

				await run5x(projectRoot, [
					"quality",
					"run",
					"--record",
					"--run",
					runId,
					"--phase",
					"2",
				]);

				// Verify phase was recorded
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				expect(steps.length).toBeGreaterThanOrEqual(1);
				expect(steps[0]?.phase).toBe("2");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"non-existent --run fails with RUN_NOT_FOUND (run-scoped hard error)",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot } = await setupProjectWithRun(dir);

				// Use a non-existent run ID — Phase 3 fix: this is now a hard
				// error (RUN_NOT_FOUND) instead of falling through to cwd-based
				// quality execution. A typo in the run ID should not silently
				// execute against the wrong tree.
				const result = await run5x(projectRoot, [
					"quality",
					"run",
					"--record",
					"--run",
					"run_nonexistent_xyz",
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				expect((json.error as Record<string, unknown>).code).toBe(
					"RUN_NOT_FOUND",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--record without --run emits warning to stderr, does not corrupt stdout with a second envelope",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot } = await setupProjectWithRun(dir);

				const result = await run5x(projectRoot, ["quality", "run", "--record"]);

				// The primary quality envelope should be the only JSON on stdout
				const trimmed = result.stdout.trim();
				const json = JSON.parse(trimmed) as Record<string, unknown>;
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.passed).toBe(true);

				// Verify there's exactly one JSON object — no second error envelope
				expect(() => JSON.parse(trimmed)).not.toThrow();

				// stderr should contain a warning about --run being required
				expect(result.stderr).toContain("--run");
				expect(result.stderr).toContain("Warning");

				// Exit code should be non-zero
				expect(result.exitCode).not.toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"--record with empty quality gates still records the result",
		async () => {
			const dir = makeTmpDir();
			try {
				// Set up project with NO quality gates
				const { projectRoot, runId } = await setupProjectWithRun(dir, []);

				const result = await run5x(projectRoot, [
					"quality",
					"run",
					"--record",
					"--run",
					runId,
				]);

				// Primary envelope should be the empty-gates success result
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.passed).toBe(true);
				expect(data.results).toEqual([]);

				// Verify step was recorded in DB
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const stateJson = parseJson(state.stdout);
				expect(stateJson.ok).toBe(true);
				const steps = (stateJson.data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				expect(steps.length).toBeGreaterThanOrEqual(1);
				expect(steps[0]?.step_name).toBe("quality:check");

				// Verify result_json contains the empty-gates quality data
				const resultJson = JSON.parse(
					steps[0]?.result_json as string,
				) as Record<string, unknown>;
				expect(resultJson.passed).toBe(true);
				expect(resultJson.results).toEqual([]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);
});
