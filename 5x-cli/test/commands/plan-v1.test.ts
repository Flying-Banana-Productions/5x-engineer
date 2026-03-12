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

describe("5x plan phases", () => {
	test(
		"returns phases from a plan file",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planPath = join(dir, "plan.md");
				writeFileSync(
					planPath,
					`# My Plan

**Version:** 1.0
**Status:** Draft

## Phase 1: Setup

**Completion gate:** Everything is set up.

- [x] Create project structure
- [x] Initialize git repo
- [ ] Write config file

## Phase 2: Implementation

**Completion gate:** Feature works.

- [ ] Implement feature A
- [ ] Implement feature B
- [ ] Write tests
`,
				);

				// Add and commit the plan so git is clean
				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add plan"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});

				const result = await run5x(dir, ["plan", "phases", planPath]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					phases: Array<{
						id: string;
						title: string;
						done: boolean;
						checklist_total: number;
						checklist_done: number;
					}>;
				};

				expect(payload.phases.length).toBe(2);

				expect(payload.phases[0]?.id).toBe("1");
				expect(payload.phases[0]?.title).toBe("Setup");
				expect(payload.phases[0]?.done).toBe(false);
				expect(payload.phases[0]?.checklist_total).toBe(3);
				expect(payload.phases[0]?.checklist_done).toBe(2);

				expect(payload.phases[1]?.id).toBe("2");
				expect(payload.phases[1]?.title).toBe("Implementation");
				expect(payload.phases[1]?.done).toBe(false);
				expect(payload.phases[1]?.checklist_total).toBe(3);
				expect(payload.phases[1]?.checklist_done).toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"returns done=true for fully checked phases",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planPath = join(dir, "plan.md");
				writeFileSync(
					planPath,
					`# Plan

## Phase 1: Done Phase

- [x] Task A
- [x] Task B

## Phase 2: Partial Phase

- [x] Task C
- [ ] Task D
`,
				);

				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add plan"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});

				const result = await run5x(dir, ["plan", "phases", planPath]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					phases: Array<{
						id: string;
						done: boolean;
						checklist_total: number;
						checklist_done: number;
					}>;
				};

				expect(payload.phases[0]?.done).toBe(true);
				expect(payload.phases[0]?.checklist_total).toBe(2);
				expect(payload.phases[0]?.checklist_done).toBe(2);

				expect(payload.phases[1]?.done).toBe(false);
				expect(payload.phases[1]?.checklist_total).toBe(2);
				expect(payload.phases[1]?.checklist_done).toBe(1);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

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
				expect(result.exitCode).toBe(2); // PLAN_NOT_FOUND exit code
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
		"handles plan with no phases",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planPath = join(dir, "empty-plan.md");
				writeFileSync(planPath, "# Empty Plan\n\nJust some text.\n");

				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add plan"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});

				const result = await run5x(dir, ["plan", "phases", planPath]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as { phases: unknown[] };
				expect(payload.phases).toEqual([]);
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

				// Write a plan in the root with Phase 1 unchecked
				const planDir = join(dir, "docs");
				mkdirSync(planDir, { recursive: true });
				const planPath = join(planDir, "plan.md");
				writeFileSync(
					planPath,
					`# Plan\n\n## Phase 1: Setup\n\n- [ ] Task A\n- [ ] Task B\n`,
				);

				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add plan"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});

				// Create a fake worktree directory with the plan fully checked
				const wtDir = join(dir, ".5x", "worktrees", "wt1");
				const wtPlanDir = join(wtDir, "docs");
				mkdirSync(wtPlanDir, { recursive: true });
				writeFileSync(
					join(wtPlanDir, "plan.md"),
					`# Plan\n\n## Phase 1: Setup\n\n- [x] Task A\n- [x] Task B\n`,
				);

				// Set up the DB with a plan→worktree mapping
				const { getDb } = await import("../../src/db/connection.js");
				const { runMigrations } = await import("../../src/db/schema.js");
				const { upsertPlan } = await import("../../src/db/operations.js");
				const { _resetForTest } = await import("../../src/db/connection.js");

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

				// filePaths should include both root and worktree
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
					`# Plan\n\n## Phase 1: Setup\n\n- [ ] Task A\n`,
				);

				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add plan"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});

				// Create worktree dir but WITHOUT the plan file
				const wtDir = join(dir, ".5x", "worktrees", "wt1");
				mkdirSync(wtDir, { recursive: true });

				// Set up the DB with mapping to a worktree that lacks the plan
				const { getDb } = await import("../../src/db/connection.js");
				const { runMigrations } = await import("../../src/db/schema.js");
				const { upsertPlan } = await import("../../src/db/operations.js");
				const { _resetForTest } = await import("../../src/db/connection.js");

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

				// Should read from root (unchecked)
				expect(payload.phases[0]?.done).toBe(false);
				expect(payload.phases[0]?.checklist_done).toBe(0);

				// filePaths should have root only, no worktree
				expect(payload.filePaths.root).toBe(planPath);
				expect(payload.filePaths.worktree).toBeUndefined();

				// No re-mapping note since worktree copy doesn't exist
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
					`# Plan\n\n## Phase 1: Setup\n\n- [ ] Task A\n`,
				);

				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add plan"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});

				// Set up DB with plan but NO worktree mapping
				const { getDb } = await import("../../src/db/connection.js");
				const { runMigrations } = await import("../../src/db/schema.js");
				const { upsertPlan } = await import("../../src/db/operations.js");
				const { _resetForTest } = await import("../../src/db/connection.js");

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

				// filePaths should have root only
				expect(payload.filePaths.root).toBe(planPath);
				expect(payload.filePaths.worktree).toBeUndefined();

				// No re-mapping note
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
		"handles sub-phase numbering",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planPath = join(dir, "plan.md");
				writeFileSync(
					planPath,
					`# Plan

## Phase 1: Main Phase

- [x] Task A

## Phase 1.1: Sub Phase

- [ ] Task B
`,
				);

				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "add plan"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdout: "pipe",
					stderr: "pipe",
				});

				const result = await run5x(dir, ["plan", "phases", planPath]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					phases: Array<{ id: string; title: string }>;
				};

				expect(payload.phases.length).toBe(2);
				expect(payload.phases[0]?.id).toBe("1");
				expect(payload.phases[1]?.id).toBe("1.1");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
