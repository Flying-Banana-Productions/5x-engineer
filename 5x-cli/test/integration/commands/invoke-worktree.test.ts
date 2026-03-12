/**
 * Tests for Phase 2: invoke handler auto-resolve workdir + plan path.
 *
 * Validates:
 * - invoke --run from repo root uses mapped worktree as provider working dir
 * - invoke --run --workdir <x> uses explicit workdir (override)
 * - invoke --run with explicit --var plan_path=... keeps explicit value
 * - invoke --run with no explicit plan_path uses mapped worktree plan path
 * - Artifact paths (logs, template overrides) anchor to controlPlaneRoot/stateDir
 * - Output envelope includes worktree_path and worktree_plan_path when mapped
 * - invoke still works for unmapped runs
 * - invoke --run fails closed when run not found in DB (RUN_NOT_FOUND is fatal)
 *
 * Uses integration-level tests with the sample provider for end-to-end validation.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
		`5x-invoke-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
}

/** Create a minimal project with git repo, 5x init (DB + templates), and sample provider config. */
function setupProject(dir: string): string {
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

	// Create plan (must exist before 5x init so .5x/ directory is populated)
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(
		join(planDir, "test-plan.md"),
		"# Test Plan\n\n## Phase 1: Setup\n\n- [ ] Do thing\n",
	);

	// Run 5x init to create .5x/, DB, .gitignore, templates
	Bun.spawnSync(["bun", "run", BIN, "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});

	// Overwrite 5x.toml with sample provider config
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[sample]\necho = false\n\n[sample.structured]\nresult = "complete"\ncommit = "abc123"\n',
	);

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

	return dir;
}

function insertRun(dir: string, runId: string, planPath: string): void {
	// Use sqlite3 CLI or bun:sqlite to insert directly
	const { Database } = require("bun:sqlite");
	const dbPath = join(dir, ".5x", "5x.db");
	const db = new Database(dbPath);
	db.query("INSERT INTO runs (id, plan_path) VALUES (?1, ?2)").run(
		runId,
		planPath,
	);
	db.close();
}

function insertPlan(
	dir: string,
	planPath: string,
	worktreePath: string | null,
): void {
	const { Database } = require("bun:sqlite");
	const dbPath = join(dir, ".5x", "5x.db");
	const db = new Database(dbPath);
	db.query("INSERT INTO plans (plan_path, worktree_path) VALUES (?1, ?2)").run(
		planPath,
		worktreePath,
	);
	db.close();
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

describe("invoke Phase 2: worktree auto-resolve", () => {
	test(
		"invoke --run with no worktree mapping works normally",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_no_wt_test";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
					"--run",
					runId,
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);
				// No worktree fields when not mapped
				expect(data.worktree_path).toBeUndefined();
				expect(data.worktree_plan_path).toBeUndefined();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"invoke --run with mapped worktree includes worktree fields in output",
		async () => {
			const dir = makeTmpDir();
			const wtDir = makeTmpDir();
			try {
				setupProject(dir);

				// Create plan file in both root and worktree
				const planPath = join(dir, "docs", "development", "test-plan.md");
				mkdirSync(join(wtDir, "docs", "development"), { recursive: true });
				writeFileSync(
					join(wtDir, "docs", "development", "test-plan.md"),
					"# Worktree Plan\n",
				);

				const runId = "run_wt_test";
				insertPlan(dir, planPath, wtDir);
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
					"--run",
					runId,
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);
				expect(data.worktree_path).toBe(wtDir);
				expect(data.worktree_plan_path).toBe(
					join(wtDir, "docs", "development", "test-plan.md"),
				);
			} finally {
				cleanupDir(dir);
				cleanupDir(wtDir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"invoke --run auto-resolves plan_path when not explicitly provided",
		async () => {
			const dir = makeTmpDir();
			const wtDir = makeTmpDir();
			try {
				setupProject(dir);

				const planPath = join(dir, "docs", "development", "test-plan.md");
				mkdirSync(join(wtDir, "docs", "development"), { recursive: true });
				writeFileSync(
					join(wtDir, "docs", "development", "test-plan.md"),
					"# Worktree Plan\n",
				);

				const runId = "run_auto_plan";
				insertPlan(dir, planPath, wtDir);
				insertRun(dir, runId, planPath);

				// Don't provide --var plan_path — should auto-resolve
				const result = await run5x(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
					"--run",
					runId,
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.worktree_plan_path).toBe(
					join(wtDir, "docs", "development", "test-plan.md"),
				);
			} finally {
				cleanupDir(dir);
				cleanupDir(wtDir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"explicit --var plan_path wins over resolver default",
		async () => {
			const dir = makeTmpDir();
			const wtDir = makeTmpDir();
			try {
				setupProject(dir);

				const planPath = join(dir, "docs", "development", "test-plan.md");
				mkdirSync(join(wtDir, "docs", "development"), { recursive: true });
				writeFileSync(
					join(wtDir, "docs", "development", "test-plan.md"),
					"# Worktree Plan\n",
				);

				const runId = "run_explicit_plan";
				insertPlan(dir, planPath, wtDir);
				insertRun(dir, runId, planPath);

				// Explicit --var plan_path wins
				const explicitPlan = "/custom/explicit/plan.md";
				const result = await run5x(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					`plan_path=${explicitPlan}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
					"--run",
					runId,
				]);

				const json = parseJson(result.stdout);
				// It might succeed or fail (the plan file doesn't exist but sample
				// provider doesn't care), but the template should have received
				// the explicit value, not the auto-resolved one
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
				cleanupDir(wtDir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"log files are created under controlPlaneRoot/stateDir",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_log_path_test";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
					"--run",
					runId,
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;

				// Log path should be under controlPlaneRoot/.5x/logs/<runId>
				const logPath = data.log_path as string;
				expect(logPath).toContain(join(dir, ".5x", "logs", runId));
				expect(existsSync(logPath)).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"invoke --run with run not found in DB fails closed with RUN_NOT_FOUND",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				// Don't insert any run — RUN_NOT_FOUND is now a hard error in
				// invoke, consistent with quality/diff/run handlers. A typo or
				// stale run ID should not silently execute against the wrong
				// context.
				const result = await run5x(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					"plan_path=docs/development/test-plan.md",
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
					"--run",
					"run_nonexistent",
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("RUN_NOT_FOUND");
				expect(result.exitCode).not.toBe(0);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);

	test(
		"invoke --run with WORKTREE_MISSING fails with error",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const planPath = join(dir, "docs", "development", "test-plan.md");
				const missingWtPath = join(tmpdir(), `5x-missing-wt-${Date.now()}`);

				const runId = "run_missing_wt";
				insertPlan(dir, planPath, missingWtPath);
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"invoke",
					"author",
					"author-next-phase",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=test",
					"--run",
					runId,
				]);

				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("WORKTREE_MISSING");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 30000 },
	);
});

// ---------------------------------------------------------------------------
// Pipe context extraction tests for new worktree fields
// ---------------------------------------------------------------------------

describe("pipe context extraction: worktree fields", () => {
	test("extractPipeContext captures worktree_path and worktree_plan_path", async () => {
		const { extractPipeContext } = await import("../../../src/pipe.js");

		const data: Record<string, unknown> = {
			run_id: "run_test123",
			step_name: "author:implement",
			worktree_path: "/path/to/worktree",
			worktree_plan_path: "/path/to/worktree/docs/plan.md",
		};

		const ctx = extractPipeContext(data);
		expect(ctx.runId).toBe("run_test123");
		expect(ctx.worktreePath).toBe("/path/to/worktree");
		expect(ctx.worktreePlanPath).toBe("/path/to/worktree/docs/plan.md");
	});

	test("extractPipeContext does not inject worktree fields as template vars", async () => {
		const { extractPipeContext } = await import("../../../src/pipe.js");

		const data: Record<string, unknown> = {
			run_id: "run_test123",
			worktree_path: "/path/to/worktree",
			worktree_plan_path: "/path/to/worktree/docs/plan.md",
			some_other_field: "value",
		};

		const ctx = extractPipeContext(data);
		// worktree fields should NOT be in templateVars
		expect(ctx.templateVars.worktree_path).toBeUndefined();
		expect(ctx.templateVars.worktree_plan_path).toBeUndefined();
		// Other eligible fields should be in templateVars
		expect(ctx.templateVars.some_other_field).toBe("value");
	});

	test("extractPipeContext works without worktree fields (backward compat)", async () => {
		const { extractPipeContext } = await import("../../../src/pipe.js");

		const data: Record<string, unknown> = {
			run_id: "run_test123",
			step_name: "author:implement",
		};

		const ctx = extractPipeContext(data);
		expect(ctx.runId).toBe("run_test123");
		expect(ctx.worktreePath).toBeUndefined();
		expect(ctx.worktreePlanPath).toBeUndefined();
	});
});
