/**
 * Integration tests for `5x plan phases` — CLI subprocess behavior.
 *
 * Tests cover exit codes (PLAN_NOT_FOUND), worktree plan re-mapping
 * through control-plane + DB, and the JSON envelope format. These
 * require spawning the CLI binary and a full project setup.
 *
 * Pure plan-parsing unit tests (phase extraction, checklist counting,
 * sub-phase numbering) are in test/unit/commands/plan-v1.test.ts.
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
		`5x-plan-v1-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

function setupProject(dir: string): void {
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

	mkdirSync(join(dir, ".5x"), { recursive: true });
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");

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
}

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function run5x(
	cwd: string,
	args: string[],
	timeoutMs = 15000,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("5x plan phases (integration)", () => {
	test(
		"returns PLAN_NOT_FOUND for missing file",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, [
					"plan",
					"phases",
					join(dir, "nonexistent.md"),
				]);
				expect(result.exitCode).toBe(2);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(false);
				const error = data.error as { code: string };
				expect(error.code).toBe("PLAN_NOT_FOUND");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"reads plan from mapped worktree when mapping exists",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planDir = join(dir, "docs");
				mkdirSync(planDir, { recursive: true });
				const planPath = join(planDir, "plan.md");
				writeFileSync(
					planPath,
					"# Plan\n\n## Phase 1: Setup\n\n- [ ] Task A\n- [ ] Task B\n",
				);

				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add plan"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});

				// Create a fake worktree directory with the plan fully checked
				const wtDir = join(dir, ".5x", "worktrees", "wt1");
				const wtPlanDir = join(wtDir, "docs");
				mkdirSync(wtPlanDir, { recursive: true });
				writeFileSync(
					join(wtPlanDir, "plan.md"),
					"# Plan\n\n## Phase 1: Setup\n\n- [x] Task A\n- [x] Task B\n",
				);

				// Set up the DB with a plan→worktree mapping
				const { getDb } = await import("../../../src/db/connection.js");
				const { runMigrations } = await import("../../../src/db/schema.js");
				const { upsertPlan } = await import("../../../src/db/operations.js");
				const { _resetForTest } = await import("../../../src/db/connection.js");

				const db = getDb(dir, ".5x/5x.db");
				runMigrations(db);
				upsertPlan(db, { planPath, worktreePath: wtDir });
				db.close();
				_resetForTest();

				const result = await run5x(dir, ["plan", "phases", planPath]);
				expect(result.exitCode).toBe(0);

				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					phases: Array<{ done: boolean; checklist_done: number }>;
					filePaths: { root: string; worktree?: string };
				};

				// Should read from worktree copy (fully checked)
				expect(payload.phases[0]?.done).toBe(true);
				expect(payload.phases[0]?.checklist_done).toBe(2);

				expect(payload.filePaths.root).toBe(planPath);
				expect(payload.filePaths.worktree).toBe(join(wtPlanDir, "plan.md"));
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"reads mapped worktree plan when canonical file is missing",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planDir = join(dir, "docs");
				mkdirSync(planDir, { recursive: true });
				const planPath = join(planDir, "plan.md");

				const wtDir = join(dir, ".5x", "worktrees", "wt-missing-root");
				const wtPlanDir = join(wtDir, "docs");
				mkdirSync(wtPlanDir, { recursive: true });
				writeFileSync(
					join(wtPlanDir, "plan.md"),
					"# Plan\n\n## Phase 1: Setup\n\n- [x] Task A\n",
				);

				const { getDb } = await import("../../../src/db/connection.js");
				const { runMigrations } = await import("../../../src/db/schema.js");
				const { upsertPlan } = await import("../../../src/db/operations.js");
				const { _resetForTest } = await import("../../../src/db/connection.js");

				const db = getDb(dir, ".5x/5x.db");
				runMigrations(db);
				upsertPlan(db, { planPath, worktreePath: wtDir });
				db.close();
				_resetForTest();

				const result = await run5x(dir, ["plan", "phases", planPath]);
				expect(result.exitCode).toBe(0);

				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					phases: Array<{ done: boolean; checklist_done: number }>;
					filePaths: { root: string; worktree?: string };
				};

				expect(payload.phases[0]?.done).toBe(true);
				expect(payload.phases[0]?.checklist_done).toBe(1);
				expect(payload.filePaths.root).toBe(planPath);
				expect(payload.filePaths.worktree).toBe(join(wtPlanDir, "plan.md"));
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"falls back to original path when worktree copy does not exist",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planDir = join(dir, "docs");
				mkdirSync(planDir, { recursive: true });
				const planPath = join(planDir, "plan.md");
				writeFileSync(
					planPath,
					"# Plan\n\n## Phase 1: Setup\n\n- [ ] Task A\n",
				);

				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add plan"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});

				// Create worktree dir but WITHOUT the plan file
				const wtDir = join(dir, ".5x", "worktrees", "wt1");
				mkdirSync(wtDir, { recursive: true });

				const { getDb } = await import("../../../src/db/connection.js");
				const { runMigrations } = await import("../../../src/db/schema.js");
				const { upsertPlan } = await import("../../../src/db/operations.js");
				const { _resetForTest } = await import("../../../src/db/connection.js");

				const db = getDb(dir, ".5x/5x.db");
				runMigrations(db);
				upsertPlan(db, { planPath, worktreePath: wtDir });
				db.close();
				_resetForTest();

				const result = await run5x(dir, ["plan", "phases", planPath]);
				expect(result.exitCode).toBe(0);

				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					phases: Array<{ done: boolean; checklist_done: number }>;
					filePaths: { root: string; worktree?: string };
				};

				expect(payload.phases[0]?.done).toBe(false);
				expect(payload.phases[0]?.checklist_done).toBe(0);
				expect(payload.filePaths.root).toBe(planPath);
				expect(payload.filePaths.worktree).toBeUndefined();
				expect(result.stderr).not.toContain(
					"reading plan from mapped worktree",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"no re-mapping when plan has no worktree mapping",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planPath = join(dir, "plan.md");
				writeFileSync(
					planPath,
					"# Plan\n\n## Phase 1: Setup\n\n- [ ] Task A\n",
				);

				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add plan"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});

				const { getDb } = await import("../../../src/db/connection.js");
				const { runMigrations } = await import("../../../src/db/schema.js");
				const { upsertPlan } = await import("../../../src/db/operations.js");
				const { _resetForTest } = await import("../../../src/db/connection.js");

				const db = getDb(dir, ".5x/5x.db");
				runMigrations(db);
				upsertPlan(db, { planPath });
				db.close();
				_resetForTest();

				const result = await run5x(dir, ["plan", "phases", planPath]);
				expect(result.exitCode).toBe(0);

				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					filePaths: { root: string; worktree?: string };
				};

				expect(payload.filePaths.root).toBe(planPath);
				expect(payload.filePaths.worktree).toBeUndefined();
				expect(result.stderr).not.toContain(
					"reading plan from mapped worktree",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
