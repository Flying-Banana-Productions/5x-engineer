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
		`5x-run-v1-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/** Create a minimal project with git repo and plan file. */
function setupProject(dir: string): {
	planPath: string;
	projectRoot: string;
} {
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

	// Create .5x directory and gitignore it (matches real `5x init` behavior)
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

	// Initial commit so worktree is clean
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

	return { planPath, projectRoot: dir };
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

describe("5x run lifecycle", () => {
	test("full lifecycle: init → record → state → complete", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Init
			const initResult = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			expect(initResult.exitCode).toBe(0);
			const initData = parseJson(initResult.stdout);
			expect(initData.ok).toBe(true);
			const runId = (initData.data as Record<string, unknown>).run_id as string;
			expect(runId).toMatch(/^run_[a-f0-9]{12}$/);
			expect((initData.data as Record<string, unknown>).resumed).toBe(false);
			expect((initData.data as Record<string, unknown>).status).toBe("active");

			// Record a step
			const recordResult = await run5x(projectRoot, [
				"run",
				"record",
				"author:impl:status",
				"--run",
				runId,
				"--result",
				'{"result":"complete"}',
				"--phase",
				"1",
			]);
			expect(recordResult.exitCode).toBe(0);
			const recordData = parseJson(recordResult.stdout);
			expect(recordData.ok).toBe(true);
			expect((recordData.data as Record<string, unknown>).recorded).toBe(true);
			expect((recordData.data as Record<string, unknown>).iteration).toBe(1);

			// State
			const stateResult = await run5x(projectRoot, [
				"run",
				"state",
				"--run",
				runId,
			]);
			expect(stateResult.exitCode).toBe(0);
			const stateData = parseJson(stateResult.stdout);
			expect(stateData.ok).toBe(true);
			const data = stateData.data as Record<string, unknown>;
			const steps = data.steps as unknown[];
			expect(steps).toHaveLength(1);
			const summary = data.summary as Record<string, unknown>;
			expect(summary.total_steps).toBe(1);

			// Complete
			const completeResult = await run5x(projectRoot, [
				"run",
				"complete",
				"--run",
				runId,
				"--status",
				"completed",
				"--reason",
				"All done",
			]);
			expect(completeResult.exitCode).toBe(0);
			const completeData = parseJson(completeResult.stdout);
			expect(completeData.ok).toBe(true);
			expect((completeData.data as Record<string, unknown>).status).toBe(
				"completed",
			);

			// Verify run is no longer active
			const listResult = await run5x(projectRoot, [
				"run",
				"list",
				"--status",
				"active",
			]);
			expect(listResult.exitCode).toBe(0);
			const listData = parseJson(listResult.stdout);
			const runs = (listData.data as Record<string, unknown>).runs as unknown[];
			expect(runs).toHaveLength(0);
		} finally {
			cleanupDir(dir);
		}
	});

	test("idempotent init returns existing active run", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// First init
			const first = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			expect(first.exitCode).toBe(0);
			const firstData = parseJson(first.stdout);
			const runId = (firstData.data as Record<string, unknown>)
				.run_id as string;
			expect((firstData.data as Record<string, unknown>).resumed).toBe(false);

			// Second init — should return same run with resumed=true
			const second = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			expect(second.exitCode).toBe(0);
			const secondData = parseJson(second.stdout);
			expect((secondData.data as Record<string, unknown>).run_id).toBe(runId);
			expect((secondData.data as Record<string, unknown>).resumed).toBe(true);
		} finally {
			cleanupDir(dir);
		}
	});

	test("plan lock enforcement — lock held by live PID returns PLAN_LOCKED", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Manually create a lock with current PID (simulating another process)
			// Use a different PID that is alive (PID 1 is always alive on Linux)
			const lockDir = join(projectRoot, ".5x", "locks");
			mkdirSync(lockDir, { recursive: true });

			const { canonicalizePlanPath } = await import("../../src/paths.js");
			const { createHash } = await import("node:crypto");
			const canonical = canonicalizePlanPath(planPath);
			const hash = createHash("sha256")
				.update(canonical)
				.digest("hex")
				.slice(0, 16);
			const lockPath = join(lockDir, `${hash}.lock`);

			// Use PID 1 — always alive on Linux
			writeFileSync(
				lockPath,
				JSON.stringify({
					pid: 1,
					startedAt: new Date().toISOString(),
					planPath: canonical,
				}),
			);

			const result = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			expect(result.exitCode).toBe(4); // PLAN_LOCKED exit code
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe("PLAN_LOCKED");
		} finally {
			cleanupDir(dir);
		}
	});

	test("stale lock recovery — lock held by dead PID is stolen", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Create a lock with a dead PID
			const lockDir = join(projectRoot, ".5x", "locks");
			mkdirSync(lockDir, { recursive: true });

			const { canonicalizePlanPath } = await import("../../src/paths.js");
			const { createHash } = await import("node:crypto");
			const canonical = canonicalizePlanPath(planPath);
			const hash = createHash("sha256")
				.update(canonical)
				.digest("hex")
				.slice(0, 16);
			const lockPath = join(lockDir, `${hash}.lock`);

			// Use a very high PID that is almost certainly dead
			writeFileSync(
				lockPath,
				JSON.stringify({
					pid: 999999999,
					startedAt: new Date().toISOString(),
					planPath: canonical,
				}),
			);

			// Init should succeed by stealing the stale lock
			const result = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			expect((data.data as Record<string, unknown>).status).toBe("active");
		} finally {
			cleanupDir(dir);
		}
	});

	test("dirty worktree check without --allow-dirty", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Create an uncommitted file to make worktree dirty
			writeFileSync(join(projectRoot, "dirty-file.txt"), "dirty content");

			const result = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			expect(result.exitCode).toBe(5); // DIRTY_WORKTREE exit code
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe(
				"DIRTY_WORKTREE",
			);
		} finally {
			cleanupDir(dir);
		}
	});

	test("--allow-dirty bypasses dirty worktree check", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Create an uncommitted file to make worktree dirty
			writeFileSync(join(projectRoot, "dirty-file.txt"), "dirty content");

			const result = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
				"--allow-dirty",
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
		} finally {
			cleanupDir(dir);
		}
	});

	test("step recording with INSERT OR IGNORE — duplicate returns recorded=false", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Init
			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// First record
			const first = await run5x(projectRoot, [
				"run",
				"record",
				"author:impl:status",
				"--run",
				runId,
				"--result",
				'{"status":"complete"}',
				"--phase",
				"1",
				"--iteration",
				"1",
			]);
			expect(first.exitCode).toBe(0);
			expect(
				(parseJson(first.stdout).data as Record<string, unknown>).recorded,
			).toBe(true);

			// Duplicate record — same step_name, phase, iteration
			const second = await run5x(projectRoot, [
				"run",
				"record",
				"author:impl:status",
				"--run",
				runId,
				"--result",
				'{"status":"different"}',
				"--phase",
				"1",
				"--iteration",
				"1",
			]);
			expect(second.exitCode).toBe(0);
			expect(
				(parseJson(second.stdout).data as Record<string, unknown>).recorded,
			).toBe(false);
		} finally {
			cleanupDir(dir);
		}
	});

	test("auto-increment iteration", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// Record without --iteration (auto-increment)
			const r1 = await run5x(projectRoot, [
				"run",
				"record",
				"author:impl:status",
				"--run",
				runId,
				"--result",
				'{"iter":1}',
				"--phase",
				"1",
			]);
			expect(
				(parseJson(r1.stdout).data as Record<string, unknown>).iteration,
			).toBe(1);

			const r2 = await run5x(projectRoot, [
				"run",
				"record",
				"author:impl:status",
				"--run",
				runId,
				"--result",
				'{"iter":2}',
				"--phase",
				"1",
			]);
			expect(
				(parseJson(r2.stdout).data as Record<string, unknown>).iteration,
			).toBe(2);

			const r3 = await run5x(projectRoot, [
				"run",
				"record",
				"author:impl:status",
				"--run",
				runId,
				"--result",
				'{"iter":3}',
				"--phase",
				"1",
			]);
			expect(
				(parseJson(r3.stdout).data as Record<string, unknown>).iteration,
			).toBe(3);
		} finally {
			cleanupDir(dir);
		}
	});

	test("max steps per run enforcement", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// The default maxStepsPerRun is 50. Let's directly insert 50 steps
			// via the DB to avoid running 50 CLI commands.
			// Instead, we'll use a smaller config. We need to modify the run's
			// config_json to have a lower max.
			const { getDb } = await import("../../src/db/connection.js");
			const { _resetForTest, closeDb } = await import(
				"../../src/db/connection.js"
			);
			const db = getDb(projectRoot);
			db.exec(
				`UPDATE runs SET config_json = '{"maxStepsPerRun":3}' WHERE id = '${runId}'`,
			);
			closeDb();
			_resetForTest();

			// Record 3 steps (at the limit)
			for (let i = 0; i < 3; i++) {
				const r = await run5x(projectRoot, [
					"run",
					"record",
					`step-${i}`,
					"--run",
					runId,
					"--result",
					"{}",
				]);
				expect(r.exitCode).toBe(0);
			}

			// 4th step should fail
			const overflow = await run5x(projectRoot, [
				"run",
				"record",
				"step-overflow",
				"--run",
				runId,
				"--result",
				"{}",
			]);
			expect(overflow.exitCode).toBe(6); // MAX_STEPS_EXCEEDED
			const overflowData = parseJson(overflow.stdout);
			expect(overflowData.ok).toBe(false);
			expect((overflowData.error as Record<string, unknown>).code).toBe(
				"MAX_STEPS_EXCEEDED",
			);
		} finally {
			cleanupDir(dir);
		}
	});

	test("run reopen", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Init and complete
			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			await run5x(projectRoot, [
				"run",
				"complete",
				"--run",
				runId,
				"--status",
				"completed",
			]);

			// Reopen
			const reopenResult = await run5x(projectRoot, [
				"run",
				"reopen",
				"--run",
				runId,
			]);
			expect(reopenResult.exitCode).toBe(0);
			const reopenData = parseJson(reopenResult.stdout);
			expect(reopenData.ok).toBe(true);
			expect((reopenData.data as Record<string, unknown>).status).toBe(
				"active",
			);
			expect((reopenData.data as Record<string, unknown>).previous_status).toBe(
				"completed",
			);

			// Verify run is active again via state
			const stateResult = await run5x(projectRoot, [
				"run",
				"state",
				"--run",
				runId,
			]);
			expect(stateResult.exitCode).toBe(0);
			const stateRun = (
				parseJson(stateResult.stdout).data as Record<string, unknown>
			).run as Record<string, unknown>;
			expect(stateRun.status).toBe("active");

			// State should show run:complete and run:reopen steps
			const steps = (
				parseJson(stateResult.stdout).data as Record<string, unknown>
			).steps as Array<Record<string, unknown>>;
			const stepNames = steps.map((s) => s.step_name);
			expect(stepNames).toContain("run:complete");
			expect(stepNames).toContain("run:reopen");
		} finally {
			cleanupDir(dir);
		}
	});

	test("run list with filters", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Create and complete a run
			const init1 = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const run1Id = (parseJson(init1.stdout).data as Record<string, unknown>)
				.run_id as string;
			await run5x(projectRoot, [
				"run",
				"complete",
				"--run",
				run1Id,
				"--status",
				"completed",
			]);

			// Create a second active run
			const init2 = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			// run2 created for list filtering; ID not needed
			expect(init2.exitCode).toBe(0);

			// List all
			const allResult = await run5x(projectRoot, ["run", "list"]);
			expect(allResult.exitCode).toBe(0);
			const allRuns = (
				parseJson(allResult.stdout).data as Record<string, unknown>
			).runs as unknown[];
			expect(allRuns.length).toBeGreaterThanOrEqual(2);

			// List active only
			const activeResult = await run5x(projectRoot, [
				"run",
				"list",
				"--status",
				"active",
			]);
			const activeRuns = (
				parseJson(activeResult.stdout).data as Record<string, unknown>
			).runs as Array<Record<string, unknown>>;
			expect(activeRuns.length).toBeGreaterThanOrEqual(1);
			for (const r of activeRuns) {
				expect(r.status).toBe("active");
			}

			// List completed only
			const compResult = await run5x(projectRoot, [
				"run",
				"list",
				"--status",
				"completed",
			]);
			const compRuns = (
				parseJson(compResult.stdout).data as Record<string, unknown>
			).runs as Array<Record<string, unknown>>;
			expect(compRuns.length).toBeGreaterThanOrEqual(1);
			for (const r of compRuns) {
				expect(r.status).toBe("completed");
			}

			// List with limit
			const limitResult = await run5x(projectRoot, [
				"run",
				"list",
				"--limit",
				"1",
			]);
			const limitRuns = (
				parseJson(limitResult.stdout).data as Record<string, unknown>
			).runs as unknown[];
			expect(limitRuns).toHaveLength(1);
		} finally {
			cleanupDir(dir);
		}
	});

	test("state with --tail returns only last N steps", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// Record 5 steps
			for (let i = 0; i < 5; i++) {
				await run5x(projectRoot, [
					"run",
					"record",
					`step-${i}`,
					"--run",
					runId,
					"--result",
					`{"i":${i}}`,
				]);
			}

			// State with --tail 2
			const result = await run5x(projectRoot, [
				"run",
				"state",
				"--run",
				runId,
				"--tail",
				"2",
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout).data as Record<string, unknown>;
			const steps = data.steps as Array<Record<string, unknown>>;
			expect(steps).toHaveLength(2);
			expect(steps[0]?.step_name).toBe("step-3");
			expect(steps[1]?.step_name).toBe("step-4");

			// Summary still covers full run
			const summary = data.summary as Record<string, unknown>;
			expect(summary.total_steps).toBe(5);
		} finally {
			cleanupDir(dir);
		}
	});

	test("state with --since-step returns steps after given ID", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// Record 3 steps and capture the first step_id
			const r1 = await run5x(projectRoot, [
				"run",
				"record",
				"step-a",
				"--run",
				runId,
				"--result",
				"{}",
			]);
			const firstStepId = (parseJson(r1.stdout).data as Record<string, unknown>)
				.step_id as number;

			await run5x(projectRoot, [
				"run",
				"record",
				"step-b",
				"--run",
				runId,
				"--result",
				"{}",
			]);
			await run5x(projectRoot, [
				"run",
				"record",
				"step-c",
				"--run",
				runId,
				"--result",
				"{}",
			]);

			// State with --since-step (first step id)
			const result = await run5x(projectRoot, [
				"run",
				"state",
				"--run",
				runId,
				"--since-step",
				String(firstStepId),
			]);
			expect(result.exitCode).toBe(0);
			const steps = (parseJson(result.stdout).data as Record<string, unknown>)
				.steps as Array<Record<string, unknown>>;
			expect(steps).toHaveLength(2);
			expect(steps[0]?.step_name).toBe("step-b");
			expect(steps[1]?.step_name).toBe("step-c");
		} finally {
			cleanupDir(dir);
		}
	});

	test("state via --plan looks up active run", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			expect(init.exitCode).toBe(0);

			// State via --plan
			const result = await run5x(projectRoot, [
				"run",
				"state",
				"--plan",
				planPath,
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
		} finally {
			cleanupDir(dir);
		}
	});

	test("record with @file reads result from file", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// Write JSON to a file
			const jsonFile = join(projectRoot, "result.json");
			writeFileSync(jsonFile, '{"from":"file"}');

			const result = await run5x(projectRoot, [
				"run",
				"record",
				"test:step",
				"--run",
				runId,
				"--result",
				`@${jsonFile}`,
			]);
			expect(result.exitCode).toBe(0);
			expect(
				(parseJson(result.stdout).data as Record<string, unknown>).recorded,
			).toBe(true);

			// Verify the step was recorded with file content
			const state = await run5x(projectRoot, ["run", "state", "--run", runId]);
			const steps = (parseJson(state.stdout).data as Record<string, unknown>)
				.steps as Array<Record<string, unknown>>;
			expect(steps[0]?.result_json).toBe('{"from":"file"}');
		} finally {
			cleanupDir(dir);
		}
	});

	test("record rejects non-active run", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// Complete the run
			await run5x(projectRoot, ["run", "complete", "--run", runId]);

			// Try to record on completed run
			const result = await run5x(projectRoot, [
				"run",
				"record",
				"test:step",
				"--run",
				runId,
				"--result",
				"{}",
			]);
			expect(result.exitCode).not.toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe(
				"RUN_NOT_ACTIVE",
			);
		} finally {
			cleanupDir(dir);
		}
	});

	test("reopen already-active run returns error", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// Try to reopen an active run
			const result = await run5x(projectRoot, [
				"run",
				"reopen",
				"--run",
				runId,
			]);
			expect(result.exitCode).not.toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe(
				"RUN_ALREADY_ACTIVE",
			);
		} finally {
			cleanupDir(dir);
		}
	});

	test("complete with abort status records run:abort step", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			const result = await run5x(projectRoot, [
				"run",
				"complete",
				"--run",
				runId,
				"--status",
				"aborted",
				"--reason",
				"user requested abort",
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect((data.data as Record<string, unknown>).status).toBe("aborted");

			// Verify abort step was recorded
			const state = await run5x(projectRoot, ["run", "state", "--run", runId]);
			const steps = (parseJson(state.stdout).data as Record<string, unknown>)
				.steps as Array<Record<string, unknown>>;
			const abortStep = steps.find((s) => s.step_name === "run:abort");
			expect(abortStep).toBeDefined();
			const result_json = JSON.parse(
				abortStep?.result_json as string,
			) as Record<string, unknown>;
			expect(result_json.reason).toBe("user requested abort");
		} finally {
			cleanupDir(dir);
		}
	});

	test("complete does not release another live PID's lock", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Init a run (acquires lock for this process)
			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// Now overwrite the lock to simulate another live PID owning it.
			// Use PID 1 which is always alive on Linux.
			const { canonicalizePlanPath } = await import("../../src/paths.js");
			const { createHash } = await import("node:crypto");
			const canonical = canonicalizePlanPath(planPath);
			const hash = createHash("sha256")
				.update(canonical)
				.digest("hex")
				.slice(0, 16);
			const lockFilePath = join(projectRoot, ".5x", "locks", `${hash}.lock`);
			writeFileSync(
				lockFilePath,
				JSON.stringify({
					pid: 1,
					startedAt: new Date().toISOString(),
					planPath: canonical,
				}),
			);

			// Try to complete — should be rejected because lock is owned by PID 1
			const result = await run5x(projectRoot, [
				"run",
				"complete",
				"--run",
				runId,
				"--status",
				"completed",
			]);
			expect(result.exitCode).toBe(4); // PLAN_LOCKED
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe("PLAN_LOCKED");
		} finally {
			cleanupDir(dir);
		}
	});

	test("reopen rejects when plan is locked by another live PID", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Init and complete a run
			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			await run5x(projectRoot, [
				"run",
				"complete",
				"--run",
				runId,
				"--status",
				"completed",
			]);

			// Now create a lock owned by PID 1 (always alive on Linux)
			const { canonicalizePlanPath } = await import("../../src/paths.js");
			const { createHash } = await import("node:crypto");
			const canonical = canonicalizePlanPath(planPath);
			const hash = createHash("sha256")
				.update(canonical)
				.digest("hex")
				.slice(0, 16);
			const lockDir = join(projectRoot, ".5x", "locks");
			mkdirSync(lockDir, { recursive: true });
			writeFileSync(
				join(lockDir, `${hash}.lock`),
				JSON.stringify({
					pid: 1,
					startedAt: new Date().toISOString(),
					planPath: canonical,
				}),
			);

			// Reopen should fail
			const result = await run5x(projectRoot, [
				"run",
				"reopen",
				"--run",
				runId,
			]);
			expect(result.exitCode).toBe(4); // PLAN_LOCKED
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe("PLAN_LOCKED");
		} finally {
			cleanupDir(dir);
		}
	});

	test("numeric args validation — NaN and negative values rejected", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			// Init a run
			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// --tail with NaN
			const tailResult = await run5x(projectRoot, [
				"run",
				"state",
				"--run",
				runId,
				"--tail",
				"abc",
			]);
			expect(tailResult.exitCode).not.toBe(0);
			const tailData = parseJson(tailResult.stdout);
			expect((tailData.error as Record<string, unknown>).code).toBe(
				"INVALID_ARGS",
			);

			// --tail with 0 (must be positive)
			const tailZero = await run5x(projectRoot, [
				"run",
				"state",
				"--run",
				runId,
				"--tail",
				"0",
			]);
			expect(tailZero.exitCode).not.toBe(0);
			expect(
				(parseJson(tailZero.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --iteration with 0 (must be positive)
			const iterResult = await run5x(projectRoot, [
				"run",
				"record",
				"test:step",
				"--run",
				runId,
				"--result",
				"{}",
				"--iteration",
				"0",
			]);
			expect(iterResult.exitCode).not.toBe(0);
			expect(
				(parseJson(iterResult.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --iteration with NaN
			const iterNaN = await run5x(projectRoot, [
				"run",
				"record",
				"test:step2",
				"--run",
				runId,
				"--result",
				"{}",
				"--iteration",
				"abc",
			]);
			expect(iterNaN.exitCode).not.toBe(0);
			expect(
				(parseJson(iterNaN.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --limit with NaN
			const limitResult = await run5x(projectRoot, [
				"run",
				"list",
				"--limit",
				"not-a-number",
			]);
			expect(limitResult.exitCode).not.toBe(0);
			expect(
				(parseJson(limitResult.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --tokens-in with NaN
			const tokensResult = await run5x(projectRoot, [
				"run",
				"record",
				"test:tokens",
				"--run",
				runId,
				"--result",
				"{}",
				"--tokens-in",
				"xyz",
			]);
			expect(tokensResult.exitCode).not.toBe(0);
			expect(
				(parseJson(tokensResult.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --cost-usd with NaN
			const costResult = await run5x(projectRoot, [
				"run",
				"record",
				"test:cost",
				"--run",
				runId,
				"--result",
				"{}",
				"--cost-usd",
				"not-a-cost",
			]);
			expect(costResult.exitCode).not.toBe(0);
			expect(
				(parseJson(costResult.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");
		} finally {
			cleanupDir(dir);
		}
	});

	test("numeric args reject trailing junk (strict parsing)", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// --tail with trailing junk: "1abc" should be rejected, not parsed as 1
			const tailJunk = await run5x(projectRoot, [
				"run",
				"state",
				"--run",
				runId,
				"--tail",
				"1abc",
			]);
			expect(tailJunk.exitCode).not.toBe(0);
			expect(
				(parseJson(tailJunk.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --limit with trailing junk
			const limitJunk = await run5x(projectRoot, [
				"run",
				"list",
				"--limit",
				"5xyz",
			]);
			expect(limitJunk.exitCode).not.toBe(0);
			expect(
				(parseJson(limitJunk.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --since-step with trailing junk
			const sinceJunk = await run5x(projectRoot, [
				"run",
				"state",
				"--run",
				runId,
				"--since-step",
				"3abc",
			]);
			expect(sinceJunk.exitCode).not.toBe(0);
			expect(
				(parseJson(sinceJunk.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --iteration with trailing junk
			const iterJunk = await run5x(projectRoot, [
				"run",
				"record",
				"test:junk",
				"--run",
				runId,
				"--result",
				"{}",
				"--iteration",
				"2foo",
			]);
			expect(iterJunk.exitCode).not.toBe(0);
			expect(
				(parseJson(iterJunk.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --tokens-in with trailing junk
			const tokensJunk = await run5x(projectRoot, [
				"run",
				"record",
				"test:junk2",
				"--run",
				runId,
				"--result",
				"{}",
				"--tokens-in",
				"100abc",
			]);
			expect(tokensJunk.exitCode).not.toBe(0);
			expect(
				(parseJson(tokensJunk.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --cost-usd with trailing junk (float parsing)
			const costJunk = await run5x(projectRoot, [
				"run",
				"record",
				"test:junk3",
				"--run",
				runId,
				"--result",
				"{}",
				"--cost-usd",
				"1.5abc",
			]);
			expect(costJunk.exitCode).not.toBe(0);
			expect(
				(parseJson(costJunk.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");

			// --duration-ms with trailing junk
			const durationJunk = await run5x(projectRoot, [
				"run",
				"record",
				"test:junk4",
				"--run",
				runId,
				"--result",
				"{}",
				"--duration-ms",
				"500ms",
			]);
			expect(durationJunk.exitCode).not.toBe(0);
			expect(
				(parseJson(durationJunk.stdout).error as Record<string, unknown>).code,
			).toBe("INVALID_ARGS");
		} finally {
			cleanupDir(dir);
		}
	});

	test("corrupt config_json falls back to default maxStepsPerRun", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			// Corrupt the config_json in the DB
			const { getDb } = await import("../../src/db/connection.js");
			const { _resetForTest, closeDb } = await import(
				"../../src/db/connection.js"
			);
			const db = getDb(projectRoot);
			db.exec(
				`UPDATE runs SET config_json = 'NOT-VALID-JSON' WHERE id = '${runId}'`,
			);
			closeDb();
			_resetForTest();

			// Record should still work (falls back to global default)
			const result = await run5x(projectRoot, [
				"run",
				"record",
				"test:step",
				"--run",
				runId,
				"--result",
				"{}",
			]);
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
		} finally {
			cleanupDir(dir);
		}
	});

	test("record with optional metadata fields", async () => {
		const dir = makeTmpDir();
		try {
			const { planPath, projectRoot } = setupProject(dir);

			const init = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				planPath,
			]);
			const runId = (parseJson(init.stdout).data as Record<string, unknown>)
				.run_id as string;

			const result = await run5x(projectRoot, [
				"run",
				"record",
				"author:impl:status",
				"--run",
				runId,
				"--result",
				'{"complete":true}',
				"--phase",
				"1",
				"--session-id",
				"sess-abc",
				"--model",
				"gpt-4o",
				"--tokens-in",
				"1000",
				"--tokens-out",
				"500",
				"--cost-usd",
				"0.05",
				"--duration-ms",
				"5000",
				"--log-path",
				"/logs/agent-001.ndjson",
			]);
			expect(result.exitCode).toBe(0);

			// Verify metadata in state
			const state = await run5x(projectRoot, ["run", "state", "--run", runId]);
			const steps = (parseJson(state.stdout).data as Record<string, unknown>)
				.steps as Array<Record<string, unknown>>;
			const step = steps[0];
			expect(step?.session_id).toBe("sess-abc");
			expect(step?.model).toBe("gpt-4o");
			expect(step?.tokens_in).toBe(1000);
			expect(step?.tokens_out).toBe(500);
			expect(step?.cost_usd).toBe(0.05);
			expect(step?.duration_ms).toBe(5000);
			expect(step?.log_path).toBe("/logs/agent-001.ndjson");
		} finally {
			cleanupDir(dir);
		}
	});
});
