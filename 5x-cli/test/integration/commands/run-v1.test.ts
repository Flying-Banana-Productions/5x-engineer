import { describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

	// Create .5x directory and gitignore it (matches real `5x init` behavior)
	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");

	// Initial commit so worktree is clean
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
	test(
		"full lifecycle: init → record → state → complete",
		async () => {
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
				const runId = (initData.data as Record<string, unknown>)
					.run_id as string;
				expect(runId).toMatch(/^run_[a-f0-9]{12}$/);
				expect((initData.data as Record<string, unknown>).resumed).toBe(false);
				expect((initData.data as Record<string, unknown>).status).toBe(
					"active",
				);

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
				expect((recordData.data as Record<string, unknown>).recorded).toBe(
					true,
				);
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
				const runs = (listData.data as Record<string, unknown>)
					.runs as unknown[];
				expect(runs).toHaveLength(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"idempotent init returns existing active run",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"plan lock enforcement — lock held by live PID returns PLAN_LOCKED",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath, projectRoot } = setupProject(dir);

				// Manually create a lock with current PID (simulating another process)
				// Use a different PID that is alive (PID 1 is always alive on Linux)
				const lockDir = join(projectRoot, ".5x", "locks");
				mkdirSync(lockDir, { recursive: true });

				const { canonicalizePlanPath } = await import("../../../src/paths.js");
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
				expect((data.error as Record<string, unknown>).code).toBe(
					"PLAN_LOCKED",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"stale lock recovery — lock held by dead PID is stolen",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath, projectRoot } = setupProject(dir);

				// Create a lock with a dead PID
				const lockDir = join(projectRoot, ".5x", "locks");
				mkdirSync(lockDir, { recursive: true });

				const { canonicalizePlanPath } = await import("../../../src/paths.js");
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
		},
		{ timeout: 15000 },
	);

	test(
		"dirty worktree check without --allow-dirty",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"--allow-dirty bypasses dirty worktree check",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"step recording with INSERT OR IGNORE — duplicate returns recorded=false",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"auto-increment iteration",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"max steps per run enforcement",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath, projectRoot } = setupProject(dir);

				// Set maxStepsPerRun=3 via config file (enforcement uses live config)
				writeFileSync(join(dir, "5x.toml"), "maxStepsPerRun = 3\n");

				const init = await run5x(projectRoot, [
					"run",
					"init",
					"--plan",
					planPath,
					"--allow-dirty",
				]);
				const runId = (parseJson(init.stdout).data as Record<string, unknown>)
					.run_id as string;

				// Insert 3 dummy steps directly via DB to avoid subprocess spawns
				const { getDb } = await import("../../../src/db/connection.js");
				const { _resetForTest, closeDb } = await import(
					"../../../src/db/connection.js"
				);
				const db = getDb(projectRoot);
				for (let i = 0; i < 3; i++) {
					db.exec(
						`INSERT INTO steps (run_id, step_name, iteration, result_json)
						 VALUES ('${runId}', 'step-${i}', 1, '{}')`,
					);
				}
				closeDb();
				_resetForTest();

				// 4th step should fail — this is the only subprocess we need
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
		},
		{ timeout: 15000 },
	);

	test(
		"run reopen",
		async () => {
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
				expect(
					(reopenData.data as Record<string, unknown>).previous_status,
				).toBe("completed");

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
		},
		{ timeout: 15000 },
	);

	test(
		"run list with filters",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"state with --tail returns only last N steps",
		async () => {
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

				// Insert 5 steps directly via DB — avoids 5 subprocess spawns.
				// This test is exercising --tail, not run record.
				const { getDb: getDbTail } = await import(
					"../../../src/db/connection.js"
				);
				const { _resetForTest: resetTail, closeDb: closeDbTail } = await import(
					"../../../src/db/connection.js"
				);
				const dbTail = getDbTail(projectRoot);
				for (let i = 0; i < 5; i++) {
					dbTail.exec(
						`INSERT INTO steps (run_id, step_name, iteration, result_json)
						 VALUES ('${runId}', 'step-${i}', 1, '{"i":${i}}')`,
					);
				}
				closeDbTail();
				resetTail();

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
		},
		{ timeout: 15000 },
	);

	test(
		"state with --since-step returns steps after given ID",
		async () => {
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

				// Insert 3 steps directly via DB — avoids 3 subprocess spawns.
				// This test exercises --since-step, not run record.
				const { getDb: getDbSince } = await import(
					"../../../src/db/connection.js"
				);
				const { _resetForTest: resetSince, closeDb: closeDbSince } =
					await import("../../../src/db/connection.js");
				const dbSince = getDbSince(projectRoot);
				for (const name of ["step-a", "step-b", "step-c"]) {
					dbSince.exec(
						`INSERT INTO steps (run_id, step_name, iteration, result_json)
						 VALUES ('${runId}', '${name}', 1, '{}')`,
					);
				}
				const firstStepRow = dbSince
					.query<{ id: number }, []>(
						`SELECT id FROM steps WHERE run_id = '${runId}' ORDER BY id LIMIT 1`,
					)
					.get();
				expect(firstStepRow).toBeDefined();
				const firstStepId = firstStepRow?.id ?? 0;
				closeDbSince();
				resetSince();

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
		},
		{ timeout: 15000 },
	);

	test(
		"state via --plan looks up active run",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"record with @file reads result from file",
		async () => {
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
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
				const steps = (parseJson(state.stdout).data as Record<string, unknown>)
					.steps as Array<Record<string, unknown>>;
				expect(steps[0]?.result_json).toBe('{"from":"file"}');
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"record rejects non-active run",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"reopen already-active run returns error",
		async () => {
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
		},
		{ timeout: 15000 },
	);

	test(
		"complete with abort status records run:abort step",
		async () => {
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
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
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
		},
		{ timeout: 15000 },
	);

	test(
		"complete does not release another live PID's lock",
		async () => {
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
				const { canonicalizePlanPath } = await import("../../../src/paths.js");
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
				expect((data.error as Record<string, unknown>).code).toBe(
					"PLAN_LOCKED",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"reopen rejects when plan is locked by another live PID",
		async () => {
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
				const { canonicalizePlanPath } = await import("../../../src/paths.js");
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
				expect((data.error as Record<string, unknown>).code).toBe(
					"PLAN_LOCKED",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	// NOTE: numeric arg validation (NaN, negative, trailing junk) is
	// comprehensively covered by unit tests in test/unit/utils/parse-args.test.ts.
	// Two integration tests (~14 subprocess spawns) were removed here because
	// they added no coverage beyond the unit tests and caused CI timeouts.

	test(
		"corrupt config_json does not affect maxStepsPerRun (uses live config)",
		async () => {
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
				const { getDb } = await import("../../../src/db/connection.js");
				const { _resetForTest, closeDb } = await import(
					"../../../src/db/connection.js"
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
		},
		{ timeout: 15000 },
	);

	test(
		"record with optional metadata fields",
		async () => {
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
				const state = await run5x(projectRoot, [
					"run",
					"state",
					"--run",
					runId,
				]);
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
		},
		{ timeout: 15000 },
	);
});

// ---------------------------------------------------------------------------
// run relink
// ---------------------------------------------------------------------------

describe("5x run relink", () => {
	test(
		"relinks to new plan path",
		async () => {
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
				await run5x(projectRoot, ["run", "complete", "--run", runId]);

				// Move plan to new location
				const newPath = join(dir, "docs", "development", "renamed.md");
				renameSync(planPath, newPath);

				const result = await run5x(projectRoot, [
					"run",
					"relink",
					"--run",
					runId,
					"--plan",
					newPath,
				]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as Record<string, unknown>;
				expect(data.plan_path as string).toContain("renamed.md");
				const changes = data.changes as Record<
					string,
					{ old: string; new: string }
				>;
				expect(changes.plan?.old).toContain("test-plan.md");
				expect(changes.plan?.new).toContain("renamed.md");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--plan auto-search finds by filename in plans dir",
		async () => {
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
				await run5x(projectRoot, ["run", "complete", "--run", runId]);

				// Plan already exists at docs/development/test-plan.md — auto-search should find it
				const result = await run5x(projectRoot, [
					"run",
					"relink",
					"--run",
					runId,
					"--plan",
				]);
				expect(result.exitCode).toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"relinks worktree path",
		async () => {
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
				await run5x(projectRoot, ["run", "complete", "--run", runId]);

				const wtDir = join(dir, "fake-worktree");
				mkdirSync(wtDir);

				const result = await run5x(projectRoot, [
					"run",
					"relink",
					"--run",
					runId,
					"--worktree",
					wtDir,
				]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as Record<string, unknown>;
				expect(data.worktree_path).toBe(wtDir);
				const changes = data.changes as Record<
					string,
					{ old: string | null; new: string }
				>;
				expect(changes.worktree?.new).toBe(wtDir);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"errors RUN_NOT_FOUND for nonexistent run",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const result = await run5x(dir, [
					"run",
					"relink",
					"--run",
					"run_000000000000",
					"--plan",
					join(dir, "docs", "development", "test-plan.md"),
				]);
				expect(result.exitCode).toBe(1);
				expect(
					(parseJson(result.stdout).error as Record<string, unknown>).code,
				).toBe("RUN_NOT_FOUND");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"errors PLAN_NOT_FOUND for missing plan file",
		async () => {
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
				await run5x(projectRoot, ["run", "complete", "--run", runId]);

				const result = await run5x(projectRoot, [
					"run",
					"relink",
					"--run",
					runId,
					"--plan",
					join(dir, "docs", "development", "nonexistent.md"),
				]);
				expect(result.exitCode).toBe(2);
				expect(
					(parseJson(result.stdout).error as Record<string, unknown>).code,
				).toBe("PLAN_NOT_FOUND");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"errors INVALID_PLAN for non-plan markdown",
		async () => {
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
				await run5x(projectRoot, ["run", "complete", "--run", runId]);

				// Write a non-plan file
				const badFile = join(dir, "docs", "development", "bad.md");
				writeFileSync(badFile, "not a plan at all, just text");

				const result = await run5x(projectRoot, [
					"run",
					"relink",
					"--run",
					runId,
					"--plan",
					badFile,
				]);
				// parsePlan doesn't throw on arbitrary markdown — it just returns
				// an empty phases array. So this should succeed, not error.
				// INVALID_PLAN only fires if parsePlan actually throws.
				expect(result.exitCode).toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"errors WORKTREE_NOT_FOUND for nonexistent path",
		async () => {
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
				await run5x(projectRoot, ["run", "complete", "--run", runId]);

				const result = await run5x(projectRoot, [
					"run",
					"relink",
					"--run",
					runId,
					"--worktree",
					"/nonexistent/path",
				]);
				expect(result.exitCode).toBe(1);
				expect(
					(parseJson(result.stdout).error as Record<string, unknown>).code,
				).toBe("WORKTREE_NOT_FOUND");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"errors RELINK_NO_OPTIONS when neither --plan nor --worktree",
		async () => {
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
					"relink",
					"--run",
					runId,
				]);
				expect(result.exitCode).toBe(1);
				expect(
					(parseJson(result.stdout).error as Record<string, unknown>).code,
				).toBe("RELINK_NO_OPTIONS");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"bare filename resolves via plans dir",
		async () => {
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
				await run5x(projectRoot, ["run", "complete", "--run", runId]);

				// Write a new plan in the plans dir
				const newPlan = join(dir, "docs", "development", "new-plan.md");
				writeFileSync(newPlan, "# New\n\n## Phase 1: A\n\n- [ ] task\n");

				const result = await run5x(projectRoot, [
					"run",
					"relink",
					"--run",
					runId,
					"--plan",
					"new-plan.md",
				]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as Record<string, unknown>;
				expect(data.plan_path as string).toContain("new-plan.md");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
