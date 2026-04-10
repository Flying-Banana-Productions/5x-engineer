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

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** Create `.5x/5x.db` so `resolveControlPlaneRoot` selects managed mode (nested config layering). */
function ensureManagedStateDb(dir: string): void {
	const dbPath = join(dir, ".5x", "5x.db");
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.close();
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
	writeFileSync(join(dir, ".gitignore"), ".5x/\n5x.toml.local\n");

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

function commitAll(dir: string, message: string): void {
	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	Bun.spawnSync(["git", "commit", "-m", message], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
}

const PLAN_ONE_PHASE_TODO = `# Todo Plan

## Phase 1: Only

- [ ] Task
`;

const PLAN_ONE_PHASE_DONE = `# Done Plan

## Phase 1: Only

- [x] Task
`;

const PLAN_TWO_PHASE_ONE_DONE = `# Partial

## Phase 1: A

- [x] a

## Phase 2: B

- [ ] b
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("5x plan list (integration)", () => {
	test(
		"empty plans dir yields plans: [] and exit 0",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				mkdirSync(join(dir, "docs", "development"), { recursive: true });

				const result = await run5x(dir, ["plan", "list"]);
				expect(result.exitCode).toBe(0);
				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(true);
				const data = envelope.data as { plans: unknown[] };
				expect(data.plans).toEqual([]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--text empty plans dir prints Plans directory then (no plans)",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const devDir = join(dir, "docs", "development");
				mkdirSync(devDir, { recursive: true });

				const result = await run5x(dir, ["--text", "plan", "list"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Plans directory:");
				expect(result.stdout).toContain(devDir);
				expect(result.stdout).toContain("(no plans)");
				expect(result.stdout).not.toContain("Plan Path");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"missing plans dir yields plans: [] and exit 0",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, ["plan", "list"]);
				expect(result.exitCode).toBe(0);
				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(true);
				const data = envelope.data as { plans: unknown[] };
				expect(data.plans).toEqual([]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"nested 5x.toml: cwd in subpackage uses that package paths.plans (managed mode)",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				ensureManagedStateDb(dir);

				writeFileSync(
					join(dir, "5x.toml"),
					`[paths]
plans = "plans-at-root"
reviews = "reviews-at-root"
`,
					"utf-8",
				);
				mkdirSync(join(dir, "plans-at-root"), { recursive: true });
				writeFileSync(
					join(dir, "plans-at-root", "root-only.md"),
					PLAN_ONE_PHASE_TODO,
				);

				const pkg = join(dir, "5x-cli");
				mkdirSync(pkg, { recursive: true });
				writeFileSync(
					join(pkg, "5x.toml"),
					`[paths]
plans = "docs/development"
reviews = "docs/development/reviews"
`,
					"utf-8",
				);
				const devDir = join(pkg, "docs", "development");
				mkdirSync(devDir, { recursive: true });
				writeFileSync(join(devDir, "pkg-plan.md"), PLAN_ONE_PHASE_TODO);

				commitAll(dir, "nested-config");

				const result = await run5x(pkg, ["plan", "list"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as {
					plans_dir: string;
					plans: Array<{ plan_path: string }>;
				};
				expect(resolve(data.plans_dir)).toBe(resolve(devDir));
				expect(data.plans.map((p) => p.plan_path)).toEqual(["pkg-plan.md"]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"skips markdown under docs/development/reviews",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const devDir = join(dir, "docs", "development");
				const reviewsDir = join(devDir, "reviews");
				mkdirSync(join(reviewsDir, "nested"), { recursive: true });
				writeFileSync(
					join(reviewsDir, "nested", "run-review.md"),
					PLAN_ONE_PHASE_TODO,
				);
				writeFileSync(join(devDir, "root.md"), PLAN_ONE_PHASE_TODO);
				commitAll(dir, "plans");

				const result = await run5x(dir, ["plan", "list"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as {
					plans: Array<{ plan_path: string }>;
				};
				const paths = data.plans.map((p) => p.plan_path).sort();
				expect(paths).toEqual(["root.md"]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"discovers nested markdown plans recursively outside reviews",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const devDir = join(dir, "docs", "development");
				mkdirSync(join(devDir, "nested", "deep"), { recursive: true });
				writeFileSync(join(devDir, "root.md"), PLAN_ONE_PHASE_TODO);
				writeFileSync(
					join(devDir, "nested", "deep", "leaf.md"),
					PLAN_ONE_PHASE_TODO,
				);
				commitAll(dir, "plans");

				const result = await run5x(dir, ["plan", "list"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as {
					plans: Array<{ plan_path: string }>;
				};
				const paths = data.plans.map((p) => p.plan_path).sort();
				expect(paths).toEqual(["nested/deep/leaf.md", "root.md"]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"sorts by completion pct desc then mtime within each pct group",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const devDir = join(dir, "docs", "development");
				mkdirSync(join(devDir, "zdir"), { recursive: true });
				writeFileSync(
					join(devDir, "zdir", "later-todo.md"),
					PLAN_ONE_PHASE_TODO,
				);
				writeFileSync(join(devDir, "aaa-done.md"), PLAN_ONE_PHASE_DONE);
				commitAll(dir, "plans");

				const result = await run5x(dir, ["plan", "list"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as {
					plans: Array<{ plan_path: string; status: string }>;
				};
				expect(data.plans.map((p) => p.plan_path)).toEqual([
					"aaa-done.md",
					"zdir/later-todo.md",
				]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--exclude-finished omits complete plans",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const devDir = join(dir, "docs", "development");
				mkdirSync(devDir, { recursive: true });
				writeFileSync(join(devDir, "open.md"), PLAN_ONE_PHASE_TODO);
				writeFileSync(join(devDir, "shipped.md"), PLAN_ONE_PHASE_DONE);
				commitAll(dir, "plans");

				const result = await run5x(dir, ["plan", "list", "--exclude-finished"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as {
					plans: Array<{ plan_path: string }>;
				};
				expect(data.plans.map((p) => p.plan_path)).toEqual(["open.md"]);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--text sorts rows by completion % desc then mtime asc within each pct",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const devDir = join(dir, "docs", "development");
				mkdirSync(devDir, { recursive: true });
				const older = new Date("2020-01-01T00:00:00Z");
				const newer = new Date("2020-06-01T00:00:00Z");

				writeFileSync(join(devDir, "newer-fresh.md"), PLAN_ONE_PHASE_TODO);
				writeFileSync(join(devDir, "old-todo.md"), PLAN_ONE_PHASE_TODO);
				writeFileSync(join(devDir, "old-partial.md"), PLAN_TWO_PHASE_ONE_DONE);
				utimesSync(join(devDir, "old-todo.md"), older, older);
				utimesSync(join(devDir, "old-partial.md"), older, older);
				utimesSync(join(devDir, "newer-fresh.md"), newer, newer);
				commitAll(dir, "plans");

				const result = await run5x(dir, ["--text", "plan", "list"]);
				expect(result.exitCode).toBe(0);
				const out = result.stdout;
				const iPartial = out.indexOf("old-partial.md");
				const iTodo = out.indexOf("old-todo.md");
				const iNewer = out.indexOf("newer-fresh.md");
				expect(iPartial).toBeGreaterThan(-1);
				expect(iPartial < iTodo && iTodo < iNewer).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--text prints Plan Path column header and plan rows",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const devDir = join(dir, "docs", "development");
				mkdirSync(devDir, { recursive: true });
				writeFileSync(join(devDir, "text-mode.md"), PLAN_ONE_PHASE_TODO);
				commitAll(dir, "plans");

				const result = await run5x(dir, ["--text", "plan", "list"]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Plans directory:");
				expect(result.stdout).toContain(devDir);
				expect(result.stdout.indexOf("Plans directory:")).toBeLessThan(
					result.stdout.indexOf("Plan Path"),
				);
				expect(result.stdout).toContain("Plan Path");
				expect(result.stdout).toContain("Status");
				expect(result.stdout).toContain("Active Run");
				expect(result.stdout).toContain("text-mode.md");
				expect(result.stdout).not.toContain('"ok"');
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"JSON lists active run id for plan with an active run",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const devDir = join(dir, "docs", "development");
				mkdirSync(devDir, { recursive: true });
				writeFileSync(join(devDir, "with-run.md"), PLAN_ONE_PHASE_TODO);
				commitAll(dir, "plans");

				const initResult = await run5x(dir, [
					"run",
					"init",
					"--plan",
					"docs/development/with-run.md",
				]);
				expect(initResult.exitCode).toBe(0);
				const initData = parseJson(initResult.stdout) as {
					ok: boolean;
					data: { run_id: string };
				};
				expect(initData.ok).toBe(true);
				const runId = initData.data.run_id;

				const listResult = await run5x(dir, ["plan", "list"]);
				expect(listResult.exitCode).toBe(0);
				const data = parseJson(listResult.stdout).data as {
					plans: Array<{ plan_path: string; active_run: string | null }>;
				};
				const row = data.plans.find((p) => p.plan_path === "with-run.md");
				expect(row).toBeDefined();
				expect(row?.active_run).toBe(runId);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"plan on disk with no run init shows runs_total 0 and active_run null",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const devDir = join(dir, "docs", "development");
				mkdirSync(devDir, { recursive: true });
				writeFileSync(join(devDir, "no-db-run.md"), PLAN_ONE_PHASE_TODO);
				commitAll(dir, "plans");

				const result = await run5x(dir, ["plan", "list"]);
				expect(result.exitCode).toBe(0);
				const data = parseJson(result.stdout).data as {
					plans: Array<{
						plan_path: string;
						runs_total: number;
						active_run: string | null;
					}>;
				};
				const row = data.plans.find((p) => p.plan_path === "no-db-run.md");
				expect(row).toBeDefined();
				expect(row?.runs_total).toBe(0);
				expect(row?.active_run).toBeNull();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"stderr warns on markdown without plan phases; JSON lists file with no warning fields",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const devDir = join(dir, "docs", "development");
				mkdirSync(devDir, { recursive: true });
				writeFileSync(
					join(devDir, "README.md"),
					"# Notes\n\nNot an implementation plan.\n",
				);
				writeFileSync(
					join(devDir, "real.plan.md"),
					"# Real\n\n## Phase 1: One\n\n- [ ] Task\n",
				);

				Bun.spawnSync(["git", "add", "-A"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				Bun.spawnSync(["git", "commit", "-m", "plans"], {
					cwd: dir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});

				const result = await run5x(dir, ["plan", "list"]);
				expect(result.exitCode).toBe(0);

				expect(result.stderr).toContain("README.md");
				expect(result.stderr).toContain("no implementation-plan phases");

				const envelope = parseJson(result.stdout);
				expect(envelope.ok).toBe(true);
				expect(JSON.stringify(envelope)).not.toMatch(/warn|Warning/i);

				const data = envelope.data as {
					plans: Array<{ plan_path: string; phases_total: number }>;
				};
				const paths = data.plans.map((p) => p.plan_path).sort();
				expect(paths).toEqual(["README.md", "real.plan.md"]);
				expect(
					data.plans.find((p) => p.plan_path === "README.md")?.phases_total,
				).toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});

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

// ---------------------------------------------------------------------------
// plan archive
// ---------------------------------------------------------------------------

/** Setup a project with a plan and optionally init+complete a run for it. */
async function setupArchiveProject(
	dir: string,
	opts?: { initRun?: boolean; completeRun?: boolean },
): Promise<{ planPath: string; runId?: string }> {
	setupProject(dir);
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	const planPath = join(planDir, "test-plan.md");
	writeFileSync(planPath, PLAN_ONE_PHASE_TODO);
	commitAll(dir, "add plan");

	if (!opts?.initRun) return { planPath };

	const initResult = await run5x(dir, ["run", "init", "--plan", planPath]);
	const runId = (parseJson(initResult.stdout).data as Record<string, unknown>)
		.run_id as string;

	if (opts?.completeRun) {
		await run5x(dir, ["run", "complete", "--run", runId]);
	}

	return { planPath, runId };
}

describe("5x plan archive", () => {
	test(
		"archives plan with completed run",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = await setupArchiveProject(dir, {
					initRun: true,
					completeRun: true,
				});

				const result = await run5x(dir, ["plan", "archive", planPath]);
				expect(result.exitCode).toBe(0);

				const data = parseJson(result.stdout);
				expect(data.ok).toBe(true);
				const payload = data.data as {
					archived: { plan_path: string; archive_path: string }[];
				};
				expect(payload.archived).toHaveLength(1);
				expect(existsSync(planPath)).toBe(false);
				expect(existsSync(join(dir, "docs", "archive", "test-plan.md"))).toBe(
					true,
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"rejects plan with active run",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = await setupArchiveProject(dir, {
					initRun: true,
				});

				const result = await run5x(dir, ["plan", "archive", planPath]);
				expect(result.exitCode).toBe(1);
				const data = parseJson(result.stdout);
				expect((data.error as Record<string, unknown>).code).toBe(
					"PLAN_HAS_ACTIVE_RUN",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--force aborts active run and archives",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = await setupArchiveProject(dir, {
					initRun: true,
				});

				const result = await run5x(dir, [
					"plan",
					"archive",
					planPath,
					"--force",
				]);
				expect(result.exitCode).toBe(0);
				const payload = (
					parseJson(result.stdout).data as Record<string, unknown>
				).archived as { run_aborted: string }[];
				expect(payload[0]?.run_aborted).toBeTruthy();
				expect(existsSync(planPath)).toBe(false);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"repoints run plan_path after archive",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath, runId } = await setupArchiveProject(dir, {
					initRun: true,
					completeRun: true,
				});

				await run5x(dir, ["plan", "archive", planPath]);

				const stateResult = await run5x(dir, [
					"run",
					"state",
					"--run",
					runId as string,
				]);
				expect(stateResult.exitCode).toBe(0);
				const stateData = (
					parseJson(stateResult.stdout).data as Record<string, unknown>
				).run as Record<string, unknown>;
				expect(stateData.plan_path as string).toContain("docs/archive/");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--all skips plans with no runs",
		async () => {
			const dir = makeTmpDir();
			try {
				await setupArchiveProject(dir, {
					initRun: true,
					completeRun: true,
				});
				// Add a second plan with no run
				writeFileSync(
					join(dir, "docs", "development", "no-run.md"),
					PLAN_ONE_PHASE_DONE,
				);
				commitAll(dir, "add no-run plan");

				const result = await run5x(dir, ["plan", "archive", "--all"]);
				expect(result.exitCode).toBe(0);

				const payload = parseJson(result.stdout).data as {
					archived: unknown[];
					skipped: { reason: string }[];
				};
				expect(payload.archived).toHaveLength(1);
				expect(
					payload.skipped.some((s) => s.reason === "no associated runs"),
				).toBe(true);
				expect(result.stderr).toContain("no associated runs");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--all skips plans with active run when no --force",
		async () => {
			const dir = makeTmpDir();
			try {
				// Plan with active run
				await setupArchiveProject(dir, { initRun: true });
				// Second plan with completed run
				const plan2 = join(dir, "docs", "development", "done.md");
				writeFileSync(plan2, PLAN_ONE_PHASE_DONE);
				commitAll(dir, "add done plan");
				const init2 = await run5x(dir, ["run", "init", "--plan", plan2]);
				const runId2 = (parseJson(init2.stdout).data as Record<string, unknown>)
					.run_id as string;
				await run5x(dir, ["run", "complete", "--run", runId2]);

				const result = await run5x(dir, ["plan", "archive", "--all"]);
				expect(result.exitCode).toBe(0);

				const payload = parseJson(result.stdout).data as {
					archived: unknown[];
					skipped: { reason: string }[];
				};
				expect(payload.archived).toHaveLength(1); // done.md
				expect(payload.skipped.some((s) => s.reason === "has active run")).toBe(
					true,
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"archive conflict when target exists",
		async () => {
			const dir = makeTmpDir();
			try {
				const { planPath } = await setupArchiveProject(dir, {
					initRun: true,
					completeRun: true,
				});
				// Pre-create archive target
				mkdirSync(join(dir, "docs", "archive"), { recursive: true });
				writeFileSync(join(dir, "docs", "archive", "test-plan.md"), "# Old\n");

				const result = await run5x(dir, ["plan", "archive", planPath]);
				expect(result.exitCode).toBe(1);
				expect(
					(parseJson(result.stdout).error as Record<string, unknown>).code,
				).toBe("ARCHIVE_CONFLICT");
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
				await setupArchiveProject(dir, {
					initRun: true,
					completeRun: true,
				});

				const result = await run5x(dir, ["plan", "archive", "test-plan.md"]);
				expect(result.exitCode).toBe(0);
				expect(existsSync(join(dir, "docs", "archive", "test-plan.md"))).toBe(
					true,
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"exit 2 for missing plan",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const result = await run5x(dir, ["plan", "archive", "nonexistent.md"]);
				expect(result.exitCode).toBe(2);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"no args errors INVALID_ARGS",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const result = await run5x(dir, ["plan", "archive"]);
				expect(result.exitCode).toBe(1);
				expect(
					(parseJson(result.stdout).error as Record<string, unknown>).code,
				).toBe("INVALID_ARGS");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 15000 },
	);
});
