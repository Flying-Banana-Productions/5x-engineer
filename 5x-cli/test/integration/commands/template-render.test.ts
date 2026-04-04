/**
 * Tests for `5x template render` — Phase 1, 014-harness-native-subagent.
 *
 * Validates prompt rendering, variable injection, continued-template
 * selection, run-aware envelope fields, and post-render ## Context
 * block injection.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runMigrations } from "../../../src/db/schema.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const BIN = resolve(import.meta.dir, "../../../src/bin.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`5x-template-render-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		rmSync(dir, { recursive: true });
	} catch {}
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

/** Create a minimal project with git repo and 5x config. */
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

	// Create .5x directory with DB
	mkdirSync(join(dir, ".5x"), { recursive: true });
	const db = new Database(join(dir, ".5x", "5x.db"));
	runMigrations(db);
	db.close();

	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n',
	);

	// Plan file for run-aware tests
	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(
		join(planDir, "test-plan.md"),
		"# Test Plan\n\n## Phase 1\n\n- [ ] Do thing\n",
	);

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

/** Insert a run directly into the DB for testing. */
function insertRun(dir: string, runId: string, planPath: string): void {
	const db = new Database(join(dir, ".5x", "5x.db"));
	db.run(
		`INSERT INTO runs (id, plan_path, status, config_json, created_at, updated_at)
		 VALUES (?1, ?2, 'active', '{}', datetime('now'), datetime('now'))`,
		[runId, planPath],
	);
	db.close();
}

function insertPlan(
	dir: string,
	planPath: string,
	worktreePath: string | null,
): void {
	const db = new Database(join(dir, ".5x", "5x.db"));
	db.run(
		`INSERT OR REPLACE INTO plans (plan_path, worktree_path, branch, created_at, updated_at)
		 VALUES (?1, ?2, 'test-branch', datetime('now'), datetime('now'))`,
		[planPath, worktreePath],
	);
	db.close();
}

/** Insert a step directly into the DB for session enforcement testing. */
function insertStep(
	dir: string,
	runId: string,
	stepName: string,
	phase: string | null,
): void {
	const db = new Database(join(dir, ".5x", "5x.db"));
	db.run(
		`INSERT INTO steps (run_id, step_name, phase, iteration, result_json, created_at)
		 VALUES (?1, ?2, ?3, 1, '{}', datetime('now'))`,
		[runId, stepName, phase],
	);
	db.close();
}

/** Create a project with continuePhaseSessions enabled for reviewer. */
function setupProjectWithSessionEnforcement(dir: string): void {
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
	const db = new Database(join(dir, ".5x", "5x.db"));
	runMigrations(db);
	db.close();

	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	writeFileSync(
		join(dir, "5x.toml"),
		'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\ncontinuePhaseSessions = true\n',
	);

	const planDir = join(dir, "docs", "development");
	mkdirSync(planDir, { recursive: true });
	writeFileSync(
		join(planDir, "test-plan.md"),
		"# Test Plan\n\n## Phase 1\n\n- [ ] Do thing\n",
	);

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("5x template render", () => {
	test(
		"renders a template and returns outputSuccess envelope",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_test001";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				expect(data.template).toBe("author-next-phase");
				expect(data.selected_template).toBe("author-next-phase");
				expect(data.step_name).toBe("author:implement");
				expect(typeof data.prompt).toBe("string");
				expect((data.prompt as string).length).toBeGreaterThan(0);
				expect(Array.isArray(data.declared_variables)).toBe(true);
				expect(data.run_id).toBe(runId);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"auto-injects run plan_path for author-generate-plan without explicit plan_path var",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "generated-plan.md");
				const runId = "run_generate_plan_001";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"template",
					"render",
					"author-generate-plan",
					"--run",
					runId,
					"--var",
					"prd_path=/tmp/prd.md",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				const vars = data.variables as Record<string, string>;
				expect(vars.plan_path).toBe(planPath);
				expect(vars.prd_path).toBe("/tmp/prd.md");
				expect(data.prompt as string).toContain(planPath);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"renders without --run and excludes run-aware fields",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--var",
					"plan_path=/tmp/some/plan.md",
					"--var",
					"review_path=/tmp/some/review.md",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				expect(data.template).toBe("reviewer-plan");
				expect(data.selected_template).toBe("reviewer-plan");
				expect(data.step_name).toBe("reviewer:review");
				expect(typeof data.prompt).toBe("string");
				// No run-aware fields
				expect(data.run_id).toBeUndefined();
				expect(data.plan_path).toBeUndefined();
				expect(data.worktree_root).toBeUndefined();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"continued-template selection with --session",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--session",
					"sess_abc123",
					"--var",
					"plan_path=/tmp/plan.md",
					"--var",
					"review_path=/tmp/review.md",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				// reviewer-plan has a continued variant
				expect(data.template).toBe("reviewer-plan");
				expect(data.selected_template).toBe("reviewer-plan-continued");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"continued-template falls back to original when no continued variant",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_test002";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"template",
					"render",
					"author-next-phase",
					"--session",
					"sess_abc",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;
				// author-next-phase has no continued variant
				expect(data.template).toBe("author-next-phase");
				expect(data.selected_template).toBe("author-next-phase");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"errors on unknown template",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, [
					"template",
					"render",
					"nonexistent-template",
				]);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("TEMPLATE_NOT_FOUND");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"errors when required variable is missing",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				// author-next-phase requires plan_path, phase_number, user_notes
				const result = await run5x(dir, [
					"template",
					"render",
					"author-next-phase",
					"--var",
					"plan_path=/tmp/plan.md",
					// Missing phase_number and user_notes
				]);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"run-aware fields include run_id and plan_path",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_test003";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=2",
					"--var",
					"user_notes=fix it",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;
				expect(data.run_id).toBe(runId);
				expect(data.plan_path).toBe(planPath);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--var with file reference reads content from file",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				// Create a file with content to inject as a var
				writeFileSync(join(dir, "notes.txt"), "file-injected-notes");

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--var",
					"plan_path=@./notes.txt",
					"--var",
					"review_path=/tmp/review.md",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;
				const prompt = data.prompt as string;
				expect(prompt).toContain("file-injected-notes");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"post-render ## Context block is appended when run has worktree",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_wt001";
				insertRun(dir, runId, planPath);

				// Create a worktree mapping in the plans table
				const db = new Database(join(dir, ".5x", "5x.db"));
				db.run(
					`INSERT OR REPLACE INTO plans (plan_path, worktree_path, branch, created_at, updated_at)
					 VALUES (?1, ?2, 'test-branch', datetime('now'), datetime('now'))`,
					[planPath, dir], // Point worktree at the same dir for testing
				);
				db.close();

				const result = await run5x(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;
				const prompt = data.prompt as string;

				// Verify ## Context block is appended
				expect(prompt).toContain("## Context");
				expect(prompt).toContain("Effective working directory:");
				expect(data.worktree_root).toBe(dir);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"## Context block is NOT appended when no worktree is mapped",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_nowt001";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;
				const prompt = data.prompt as string;

				// No worktree mapping → no appended ## Context block
				expect(prompt).not.toContain(
					"## Context\n\nEffective working directory:",
				);
				expect(prompt).not.toContain("Effective working directory:");
				expect(data.worktree_root).toBeUndefined();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"fails when explicit plan_path mismatches run/worktree plan path",
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

				const runId = "run_template_plan_mismatch";
				insertRun(dir, runId, planPath);
				insertPlan(dir, planPath, wtDir);

				const result = await run5x(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					runId,
					"--var",
					"plan_path=/custom/other/plan.md",
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=",
				]);

				expect(result.exitCode).toBe(1);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const err = json.error as { code: string; message: string };
				expect(err.code).toBe("INVALID_ARGS");
				expect(err.message).toContain("plan_path override mismatch");
				expect(err.message).toContain("--allow-plan-path-override");
			} finally {
				cleanupDir(dir);
				cleanupDir(wtDir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--allow-plan-path-override permits intentional mismatched plan_path",
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

				const runId = "run_template_plan_override";
				insertRun(dir, runId, planPath);
				insertPlan(dir, planPath, wtDir);

				const result = await run5x(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					runId,
					"--allow-plan-path-override",
					"--var",
					"plan_path=/custom/other/plan.md",
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as { warnings?: string[] };
				expect(Array.isArray(data.warnings)).toBe(true);
				expect(data.warnings?.[0]).toContain("plan_path override mismatch");
			} finally {
				cleanupDir(dir);
				cleanupDir(wtDir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"internal variable resolution includes plan_template_path",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				// author-generate-plan template declares plan_template_path
				const result = await run5x(dir, [
					"template",
					"render",
					"author-generate-plan",
					"--var",
					"prd_path=/tmp/prd.md",
					"--var",
					"plan_path=/tmp/plan.md",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;
				const prompt = data.prompt as string;
				// Should contain the resolved plan template path
				expect(prompt).toContain("_implementation_plan_template.md");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"declared_variables lists all template variables",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--var",
					"plan_path=/tmp/plan.md",
					"--var",
					"review_path=/tmp/review.md",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;
				const vars = data.declared_variables as string[];
				expect(vars).toContain("plan_path");
				expect(vars).toContain("review_path");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	// ---------------------------------------------------------------------------
	// Phase 1: Auto-generated review_path tests
	// ---------------------------------------------------------------------------

	test(
		"auto-generates review_path for plan-review template when not explicitly provided",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");

				// reviewer-plan is a plan-review template
				// review_path should be auto-generated
				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--var",
					`plan_path=${planPath}`,
					// No --var review_path=...
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;

				// Verify review_path is in the rendered variables
				const vars = data.variables as Record<string, string>;
				expect(vars.review_path).toBeDefined();
				expect(vars.review_path).toContain("-review.md");
				expect(vars.review_path).toContain("docs-development-test-plan");

				// Verify the prompt contains the auto-generated review path
				const prompt = data.prompt as string;
				expect(prompt).toContain(vars.review_path as string);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"auto-generates review_path for implementation-review template with run context",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_test_review_001";
				insertRun(dir, runId, planPath);

				// reviewer-commit is an implementation-review template
				// review_path should be auto-generated using run_id and phase
				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					runId,
					"--var",
					"commit_hash=abc123",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=2",
					// No --var review_path=...
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;

				// Verify review_path is auto-generated with run_id and phase
				const vars = data.variables as Record<string, string>;
				expect(vars.review_path).toBeDefined();
				expect(vars.review_path).toContain(runId);
				expect(vars.review_path).toContain("phase-2");
				expect(vars.review_path).toContain("-review.md");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"explicit --var review_path overrides auto-generated value",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_test_review_002";
				insertRun(dir, runId, planPath);

				const explicitReviewPath = "/custom/path/my-custom-review.md";

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					runId,
					"--var",
					"commit_hash=abc123",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					`review_path=${explicitReviewPath}`,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;

				// Verify explicit review_path is used, not auto-generated
				const vars = data.variables as Record<string, string>;
				expect(vars.review_path).toBe(explicitReviewPath);

				// Verify the prompt uses the explicit path, not the auto-generated one
				const prompt = data.prompt as string;
				expect(prompt).toContain(explicitReviewPath);
				// run_id now appears in the `5x commit --run` command, so we check
				// that the auto-generated review path (which embeds run_id) is NOT used
				const autoGeneratedReviewFragment = `${runId}-phase-`;
				expect(prompt).not.toContain(autoGeneratedReviewFragment);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"uses runReviews directory from config for implementation reviews",
		async () => {
			const dir = makeTmpDir();
			try {
				// Setup with custom runReviews directory
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
				const db = new Database(join(dir, ".5x", "5x.db"));
				runMigrations(db);
				db.close();

				writeFileSync(join(dir, ".gitignore"), ".5x/\n");
				// Custom config with runReviews directory
				writeFileSync(
					join(dir, "5x.toml"),
					'[author]\nprovider = "sample"\nmodel = "sample/test"\n\n[reviewer]\nprovider = "sample"\nmodel = "sample/test"\n\n[paths]\nrunReviews = ".5x/run-reviews"\n',
				);

				const planDir = join(dir, "docs", "development");
				mkdirSync(planDir, { recursive: true });
				writeFileSync(
					join(planDir, "test-plan.md"),
					"# Test Plan\n\n## Phase 1\n\n- [ ] Do thing\n",
				);

				const planPath = join(planDir, "test-plan.md");
				const runId = "run_custom_dir_001";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					runId,
					"--var",
					"commit_hash=abc123",
					"--var",
					`plan_path=${planPath}`,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;

				// Verify the custom runReviews directory is used
				const vars = data.variables as Record<string, string>;
				expect(vars.review_path).toContain(".5x/run-reviews");
				expect(vars.review_path).toContain(runId);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	// ---------------------------------------------------------------------------
	// Phase 2: author-fix-quality template tests
	// ---------------------------------------------------------------------------

	test(
		"renders author-fix-quality template with all required variables",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_quality_fix_001";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"template",
					"render",
					"author-fix-quality",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=2",
					"--var",
					"user_notes=Test failures in unit/commands",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				expect(data.template).toBe("author-fix-quality");
				expect(data.selected_template).toBe("author-fix-quality");
				expect(data.step_name).toBe("author:fix-quality");

				const prompt = data.prompt as string;
				expect(prompt).toContain("Phase 2");
				expect(prompt).toContain("Test failures in unit/commands");
				expect(prompt).toContain("quality remediation");
				expect(prompt).toContain("quality gate failures");

				// Should NOT contain review_path references since this template doesn't use it
				const vars = data.variables as Record<string, string>;
				expect(vars.review_path).toBeUndefined();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"author-fix-quality template does not require review_path variable",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_quality_fix_002";
				insertRun(dir, runId, planPath);

				// Verify that author-fix-quality does NOT auto-generate review_path
				const result = await run5x(dir, [
					"template",
					"render",
					"author-fix-quality",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=Lint errors in src/commands",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;

				const vars = data.variables as Record<string, string>;
				// author-fix-quality should NOT have review_path in variables
				expect(vars.review_path).toBeUndefined();

				// But should have the required variables
				expect(vars.plan_path).toBe(planPath);
				expect(vars.phase_number).toBe("1");
				expect(vars.user_notes).toBe("Lint errors in src/commands");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"fallback review_path uses run_id when phase is unavailable",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_no_phase_001";
				insertRun(dir, runId, planPath);

				// No phase_number provided - should fallback to <run-id>-review.md
				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					runId,
					"--var",
					"commit_hash=abc123",
					"--var",
					`plan_path=${planPath}`,
					// No phase_number
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				const data = json.data as Record<string, unknown>;

				// Verify fallback filename format: <run-id>-review.md
				const vars = data.variables as Record<string, string>;
				expect(vars.review_path).toBeDefined();
				expect(vars.review_path).toContain(runId);
				expect(vars.review_path).toContain("-review.md");
				// Should NOT contain "phase-" when no phase provided
				expect(vars.review_path).not.toContain("phase-");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	// ---------------------------------------------------------------------------
	// Phase 1: Review path override warning tests (022-orchestration-reliability)
	// ---------------------------------------------------------------------------

	test(
		"warns when explicit review_path is outside configured review directory",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_warn_001";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					runId,
					"--var",
					"commit_hash=abc123",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					`review_path=${join(dir, "docs", "development", "wrong-place.md")}`,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				// Warnings should be present in the envelope
				expect(data.warnings).toBeDefined();
				const warnings = data.warnings as string[];
				expect(warnings.length).toBeGreaterThan(0);
				expect(warnings[0]).toContain(
					"resolves outside configured review directory",
				);

				// Warning should also appear on stderr
				expect(result.stderr).toContain(
					"resolves outside configured review directory",
				);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"no warning when explicit review_path matches configured directory",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_warn_002";
				insertRun(dir, runId, planPath);

				// Default reviews dir is docs/development/reviews (resolved to absolute)
				const reviewsDir = join(dir, "docs", "development", "reviews");
				mkdirSync(reviewsDir, { recursive: true });

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					runId,
					"--var",
					"commit_hash=abc123",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					`review_path=${join(reviewsDir, "custom-review.md")}`,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				// No warnings expected
				expect(data.warnings).toBeUndefined();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"explicit --var review_path overrides still work with warning being additive",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_warn_003";
				insertRun(dir, runId, planPath);

				const explicitReviewPath = "/custom/path/my-custom-review.md";

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					runId,
					"--var",
					"commit_hash=abc123",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					`review_path=${explicitReviewPath}`,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				// Override still works
				const vars = data.variables as Record<string, string>;
				expect(vars.review_path).toBe(explicitReviewPath);

				// Warning is present (additive, not blocking)
				expect(data.warnings).toBeDefined();
				const warnings = data.warnings as string[];
				expect(warnings.length).toBeGreaterThan(0);

				// Prompt uses the explicit path
				const prompt = data.prompt as string;
				expect(prompt).toContain(explicitReviewPath);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	// ---------------------------------------------------------------------------
	// Phase 2: Session management enforcement tests (022-orchestration-reliability)
	// ---------------------------------------------------------------------------

	test(
		"first review succeeds without session flags when continuePhaseSessions enabled",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProjectWithSessionEnforcement(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_sess_first";
				insertRun(dir, runId, planPath);
				// No prior steps — first review

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"SESSION_REQUIRED when prior step exists and no session flag",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProjectWithSessionEnforcement(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_sess_req";
				insertRun(dir, runId, planPath);
				insertStep(dir, runId, "reviewer:review", "plan");

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
				]);

				expect(result.exitCode).toBe(9); // SESSION_REQUIRED
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("SESSION_REQUIRED");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--session selects continued template on subsequent review",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProjectWithSessionEnforcement(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_sess_cont";
				insertRun(dir, runId, planPath);
				insertStep(dir, runId, "reviewer:review", "plan");

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--run",
					runId,
					"--session",
					"sess_123",
					"--var",
					`plan_path=${planPath}`,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				expect(data.selected_template).toBe("reviewer-plan-continued");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--new-session uses full template on subsequent review",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProjectWithSessionEnforcement(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_sess_new";
				insertRun(dir, runId, planPath);
				insertStep(dir, runId, "reviewer:review", "plan");

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--run",
					runId,
					"--new-session",
					"--var",
					`plan_path=${planPath}`,
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				// --new-session forces full template (not continued)
				expect(data.selected_template).toBe("reviewer-plan");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--session and --new-session together errors",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--session",
					"sess_abc",
					"--new-session",
					"--var",
					"plan_path=/tmp/plan.md",
					"--var",
					"review_path=/tmp/review.md",
				]);

				expect(result.exitCode).not.toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("INVALID_ARGS");
				expect(error.message as string).toContain("mutually exclusive");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"no enforcement for template without continued variant when continuePhaseSessions disabled",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir); // Uses default config (continuePhaseSessions: false)
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_no_enforce";
				insertRun(dir, runId, planPath);
				insertStep(dir, runId, "author:implement", "1");

				const result = await run5x(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"TEMPLATE_NOT_FOUND when continuePhaseSessions enabled but no continued variant and --session used",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProjectWithSessionEnforcement(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_no_cont";
				insertRun(dir, runId, planPath);
				insertStep(dir, runId, "reviewer:review", "1");

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					runId,
					"--var",
					"commit_hash=abc123",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--session",
					"sess_123",
				]);

				expect(result.exitCode).toBe(2); // TEMPLATE_NOT_FOUND
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(false);
				const error = json.error as Record<string, unknown>;
				expect(error.code).toBe("TEMPLATE_NOT_FOUND");
				expect(error.message as string).toContain("reviewer-commit-continued");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"--new-session bypasses TEMPLATE_NOT_FOUND for missing continued variant",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProjectWithSessionEnforcement(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_bypass";
				insertRun(dir, runId, planPath);
				insertStep(dir, runId, "reviewer:review", "1");

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					runId,
					"--new-session",
					"--var",
					"commit_hash=abc123",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
				const data = json.data as Record<string, unknown>;
				// Full template selected (not continued)
				expect(data.selected_template).toBe("reviewer-commit");
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"no enforcement without --run",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProjectWithSessionEnforcement(dir);

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--var",
					"plan_path=/tmp/plan.md",
					"--var",
					"review_path=/tmp/review.md",
				]);

				// Should succeed — no run context means no enforcement
				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	// ---------------------------------------------------------------------------
	// Phase 2: run_id template variable integration tests (025-commit-tracking)
	// ---------------------------------------------------------------------------

	test(
		"run_id appears in variables object when --run is provided",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_runid_var_001";
				insertRun(dir, runId, planPath);

				const result = await run5x(dir, [
					"template",
					"render",
					"author-next-phase",
					"--run",
					runId,
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=1",
					"--var",
					"user_notes=",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				const vars = data.variables as Record<string, string>;
				// run_id should appear in the resolved variables
				expect(vars.run_id).toBe(runId);
				// Also present in the envelope
				expect(data.run_id).toBe(runId);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"run_id is absent from variables when --run is not provided",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProject(dir);

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-plan",
					"--var",
					"plan_path=/tmp/some/plan.md",
					"--var",
					"review_path=/tmp/some/review.md",
				]);

				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);

				const data = json.data as Record<string, unknown>;
				const vars = data.variables as Record<string, string>;
				// No --run means no run_id in variables
				expect(vars.run_id).toBeUndefined();
				expect(data.run_id).toBeUndefined();
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);

	test(
		"phase scoping: new phase has no prior steps",
		async () => {
			const dir = makeTmpDir();
			try {
				setupProjectWithSessionEnforcement(dir);
				const planPath = join(dir, "docs", "development", "test-plan.md");
				const runId = "run_phase_scope";
				insertRun(dir, runId, planPath);
				// Prior step for phase 1 — not phase 2
				insertStep(dir, runId, "reviewer:review", "1");

				const result = await run5x(dir, [
					"template",
					"render",
					"reviewer-commit",
					"--run",
					runId,
					"--var",
					"commit_hash=abc123",
					"--var",
					`plan_path=${planPath}`,
					"--var",
					"phase_number=2",
				]);

				// Phase 2 has no prior steps — should succeed without --session
				expect(result.exitCode).toBe(0);
				const json = parseJson(result.stdout);
				expect(json.ok).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		},
		{ timeout: 20000 },
	);
});
