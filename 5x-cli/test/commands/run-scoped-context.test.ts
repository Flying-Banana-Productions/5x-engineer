/**
 * Regression tests for Phase 3 run-scoped context resolution.
 *
 * Covers the fail-closed worktree contract across run subcommands,
 * quality run --run, and diff --run. Uses in-memory SQLite databases
 * and subprocess tests as appropriate.
 *
 * Review ref: 013-worktree-authoritative-execution-context-review.md,
 * Phase 3 addendum (commit 9e7f351).
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveRunExecutionContext } from "../../src/commands/run-context.js";
import { _resetForTest, closeDb, getDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/schema.js";
import { cleanGitEnv } from "../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../src/bin.ts");

// ---------------------------------------------------------------------------
// In-memory DB helpers
// ---------------------------------------------------------------------------

let tmp: string;
let db: Database;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "5x-run-scoped-"));
	db = getDb(tmp);
	runMigrations(db);
});

afterEach(() => {
	closeDb();
	_resetForTest();
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {}
});

function createRun(
	planPath: string,
	runId = "run_test123456",
	status = "active",
): void {
	db.query("INSERT INTO runs (id, plan_path, status) VALUES (?1, ?2, ?3)").run(
		runId,
		planPath,
		status,
	);
}

function createPlan(
	planPath: string,
	worktreePath: string | null = null,
): void {
	db.query("INSERT INTO plans (plan_path, worktree_path) VALUES (?1, ?2)").run(
		planPath,
		worktreePath,
	);
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-rsc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

async function run5x(
	cwd: string,
	args: string[],
	timeoutMs = 10000,
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

// ===========================================================================
// Unit tests: run-context resolver with WORKTREE_MISSING
// ===========================================================================

describe("run-context resolver: fail-closed worktree contract", () => {
	test("mapped worktree missing returns WORKTREE_MISSING for state reads", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");

		const missingWtPath = join(tmpdir(), `5x-gone-${Date.now()}`);
		createPlan(planPath, missingWtPath);
		createRun(planPath);

		const result = resolveRunExecutionContext(db, "run_test123456", {
			controlPlaneRoot: tmp,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("WORKTREE_MISSING");
			expect(result.error.detail?.path).toBe(missingWtPath);
		}
	});

	test("mapped worktree present succeeds", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");

		const wtPath = mkdtempSync(join(tmpdir(), "5x-wt-ok-"));
		try {
			createPlan(planPath, wtPath);
			createRun(planPath);

			const result = resolveRunExecutionContext(db, "run_test123456", {
				controlPlaneRoot: tmp,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.context.effectiveWorkingDirectory).toBe(wtPath);
			}
		} finally {
			rmSync(wtPath, { recursive: true, force: true });
		}
	});

	test("completed run with missing worktree still fails WORKTREE_MISSING", () => {
		const planPath = join(tmp, "docs", "plan.md");
		mkdirSync(join(tmp, "docs"), { recursive: true });
		writeFileSync(planPath, "# Plan\n");

		const missingWtPath = join(tmpdir(), `5x-gone2-${Date.now()}`);
		createPlan(planPath, missingWtPath);
		createRun(planPath, "run_completed1", "completed");

		const result = resolveRunExecutionContext(db, "run_completed1", {
			controlPlaneRoot: tmp,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("WORKTREE_MISSING");
		}
	});

	test("plan path outside controlPlaneRoot returns PLAN_PATH_INVALID", () => {
		const outsidePath = "/some/external/path/plan.md";
		createRun(outsidePath, "run_external12");

		const result = resolveRunExecutionContext(db, "run_external12", {
			controlPlaneRoot: tmp,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("PLAN_PATH_INVALID");
		}
	});
});

// ===========================================================================
// Subprocess tests: run state with mapped worktree
// ===========================================================================

describe("run state --run with worktree context", () => {
	test("run state reports worktree_path when run has mapping", async () => {
		const dir = makeTmpDir();
		try {
			const projectRoot = setupProject(dir);

			// Create a worktree for the run
			const wtDir = join(tmpdir(), `5x-wt-state-${Date.now()}`);
			mkdirSync(wtDir, { recursive: true });

			// Init run
			const runId = await initRun(projectRoot);

			// Manually insert worktree mapping into DB
			const testDb = getDb(projectRoot);
			const planPath = resolve(projectRoot, "docs/development/test-plan.md");
			testDb
				.query(
					"INSERT OR REPLACE INTO plans (plan_path, worktree_path) VALUES (?1, ?2)",
				)
				.run(planPath, wtDir);
			closeDb();
			_resetForTest();

			const result = await run5x(projectRoot, ["run", "state", "--run", runId]);

			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as {
				run: { worktree_path?: string };
			};
			expect(payload.run.worktree_path).toBe(wtDir);

			rmSync(wtDir, { recursive: true, force: true });
		} finally {
			try {
				closeDb();
				_resetForTest();
			} catch {}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("run state fails with WORKTREE_MISSING when worktree is gone", async () => {
		const dir = makeTmpDir();
		try {
			const projectRoot = setupProject(dir);

			// Init run
			const runId = await initRun(projectRoot);

			// Map to a non-existent worktree path
			const missingWtDir = join(
				tmpdir(),
				`5x-wt-gone-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			const testDb = getDb(projectRoot);
			const planPath = resolve(projectRoot, "docs/development/test-plan.md");
			testDb
				.query(
					"INSERT OR REPLACE INTO plans (plan_path, worktree_path) VALUES (?1, ?2)",
				)
				.run(planPath, missingWtDir);
			closeDb();
			_resetForTest();

			const result = await run5x(projectRoot, ["run", "state", "--run", runId]);

			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe(
				"WORKTREE_MISSING",
			);
		} finally {
			try {
				closeDb();
				_resetForTest();
			} catch {}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// Subprocess tests: run complete with missing worktree
// ===========================================================================

describe("run complete --run with worktree context", () => {
	test("run complete fails with WORKTREE_MISSING when worktree is gone", async () => {
		const dir = makeTmpDir();
		try {
			const projectRoot = setupProject(dir);

			// Init run
			const runId = await initRun(projectRoot);

			// Map to a non-existent worktree path
			const missingWtDir = join(
				tmpdir(),
				`5x-wt-compl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			const testDb = getDb(projectRoot);
			const planPath = resolve(projectRoot, "docs/development/test-plan.md");
			testDb
				.query(
					"INSERT OR REPLACE INTO plans (plan_path, worktree_path) VALUES (?1, ?2)",
				)
				.run(planPath, missingWtDir);
			closeDb();
			_resetForTest();

			const result = await run5x(projectRoot, [
				"run",
				"complete",
				"--run",
				runId,
			]);

			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe(
				"WORKTREE_MISSING",
			);
		} finally {
			try {
				closeDb();
				_resetForTest();
			} catch {}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// Subprocess tests: diff --run error paths
// ===========================================================================

describe("diff --run error paths", () => {
	test("diff --run fails with RUN_NOT_FOUND for unknown run", async () => {
		const dir = makeTmpDir();
		try {
			const projectRoot = setupProject(dir);

			// Establish the control plane (creates DB via run init)
			await initRun(projectRoot);

			const result = await run5x(projectRoot, [
				"diff",
				"--run",
				"run_doesnotexist",
			]);

			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe(
				"RUN_NOT_FOUND",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("diff --run fails with WORKTREE_MISSING when worktree is gone", async () => {
		const dir = makeTmpDir();
		try {
			const projectRoot = setupProject(dir);

			const runId = await initRun(projectRoot);

			// Map to a non-existent worktree
			const missingWtDir = join(
				tmpdir(),
				`5x-wt-diff-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			const testDb = getDb(projectRoot);
			const planPath = resolve(projectRoot, "docs/development/test-plan.md");
			testDb
				.query(
					"INSERT OR REPLACE INTO plans (plan_path, worktree_path) VALUES (?1, ?2)",
				)
				.run(planPath, missingWtDir);
			closeDb();
			_resetForTest();

			const result = await run5x(projectRoot, ["diff", "--run", runId]);

			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe(
				"WORKTREE_MISSING",
			);
		} finally {
			try {
				closeDb();
				_resetForTest();
			} catch {}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// Subprocess tests: diff without --run backward compatibility
// ===========================================================================

describe("diff without --run backward compat", () => {
	test("diff without --run remains unchanged (produces diff output)", async () => {
		const dir = makeTmpDir();
		try {
			const projectRoot = setupProject(dir);

			// Create a tracked file change so diff has output
			writeFileSync(join(projectRoot, "README.md"), "# Modified\n");

			const result = await run5x(projectRoot, ["diff"]);

			// diff without --run should succeed (exit 0)
			expect(result.exitCode).toBe(0);
			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			// Should NOT require --run and should NOT return RUN_NOT_FOUND
			const error = data.error as Record<string, unknown> | undefined;
			expect(error).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// Subprocess tests: quality run --run error paths
// ===========================================================================

describe("quality run --run error paths", () => {
	test("quality run --run fails with RUN_NOT_FOUND for unknown run", async () => {
		const dir = makeTmpDir();
		try {
			const projectRoot = setupProject(dir);

			// Establish the control plane (creates DB via run init)
			await initRun(projectRoot);

			const result = await run5x(projectRoot, [
				"quality",
				"run",
				"--run",
				"run_doesnotexist",
			]);

			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe(
				"RUN_NOT_FOUND",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("quality run --run fails with WORKTREE_MISSING when worktree is gone", async () => {
		const dir = makeTmpDir();
		try {
			const projectRoot = setupProject(dir);

			const runId = await initRun(projectRoot);

			// Map to a non-existent worktree
			const missingWtDir = join(
				tmpdir(),
				`5x-wt-qual-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			const testDb = getDb(projectRoot);
			const planPath = resolve(projectRoot, "docs/development/test-plan.md");
			testDb
				.query(
					"INSERT OR REPLACE INTO plans (plan_path, worktree_path) VALUES (?1, ?2)",
				)
				.run(planPath, missingWtDir);
			closeDb();
			_resetForTest();

			const result = await run5x(projectRoot, [
				"quality",
				"run",
				"--run",
				runId,
			]);

			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe(
				"WORKTREE_MISSING",
			);
		} finally {
			try {
				closeDb();
				_resetForTest();
			} catch {}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ===========================================================================
// Subprocess tests: run init plan-path validation
// ===========================================================================

describe("run init plan-path validation", () => {
	test("run init rejects plan outside controlPlaneRoot", async () => {
		const dir = makeTmpDir();
		try {
			const projectRoot = setupProject(dir);

			// Create a plan file outside the project
			const externalDir = makeTmpDir();
			const externalPlan = join(externalDir, "external-plan.md");
			writeFileSync(externalPlan, "# External Plan\n");

			const result = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				externalPlan,
			]);

			const data = parseJson(result.stdout);
			expect(data.ok).toBe(false);
			expect((data.error as Record<string, unknown>).code).toBe(
				"PLAN_OUTSIDE_CONTROL_PLANE",
			);

			rmSync(externalDir, { recursive: true, force: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("run init accepts plan inside controlPlaneRoot", async () => {
		const dir = makeTmpDir();
		try {
			const projectRoot = setupProject(dir);

			const result = await run5x(projectRoot, [
				"run",
				"init",
				"--plan",
				"docs/development/test-plan.md",
			]);

			const data = parseJson(result.stdout);
			expect(data.ok).toBe(true);
			const payload = data.data as { run_id: string };
			expect(payload.run_id).toBeTruthy();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
