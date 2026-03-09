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
import { cleanGitEnv } from "../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

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
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

	// Write config with quality gates (using TOML)
	if (qualityGates.length > 0) {
		const gatesArray = qualityGates.map((g) => `"${g}"`).join(", ");
		writeFileSync(join(dir, "5x.toml"), `qualityGates = [${gatesArray}]\n`);
	}

	// Initial commit
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
		"--record without --run errors",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot } = await setupProjectWithRun(dir);

				const result = await run5x(projectRoot, ["quality", "run", "--record"]);

				// Quality runs first (producing output), then recording fails
				// because --run is missing. The primary envelope is already written.
				// The error about --run should appear.
				// Since outputSuccess already wrote the quality result, the error
				// comes as a second envelope OR stderr warning depending on implementation.
				// Per the plan: outputError is called for validation.
				// Since outputSuccess was already called, the behavior depends on
				// whether the code uses outputError (which throws CliError, caught by bin.ts)
				// or just stderr.
				// Looking at the handler: it calls outputError which throws, so
				// bin.ts catches it and outputs the error envelope.
				// This means there will be TWO JSON objects on stdout (quality + error).
				// The exit code should be non-zero.
				expect(result.exitCode).not.toBe(0);

				// The stderr or stdout should contain a message about --run
				const allOutput = result.stdout + result.stderr;
				expect(allOutput).toContain("--run");
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
		"recording failure emits warning to stderr and sets non-zero exit code",
		async () => {
			const dir = makeTmpDir();
			try {
				const { projectRoot } = await setupProjectWithRun(dir);

				// Use a non-existent run ID so recording fails
				const result = await run5x(projectRoot, [
					"quality",
					"run",
					"--record",
					"--run",
					"run_nonexistent_xyz",
				]);

				// The primary quality envelope should still be on stdout
				// (quality gates run independently of recording)
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.passed).toBe(true);

				// stderr should contain a warning about recording failure
				expect(result.stderr).toContain("Warning: failed to record step");

				// Exit code should be non-zero due to recording failure
				expect(result.exitCode).not.toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);
});
