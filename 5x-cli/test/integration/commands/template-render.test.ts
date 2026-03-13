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

				// No worktree mapping → no ## Context block
				expect(prompt).not.toContain("## Context");
				expect(prompt).not.toContain("Effective working directory:");
				expect(data.worktree_root).toBeUndefined();
			} finally {
				cleanupDir(dir);
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
				expect(prompt).toContain(vars.review_path!);
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

				// Verify the prompt uses the explicit path
				const prompt = data.prompt as string;
				expect(prompt).toContain(explicitReviewPath);
				expect(prompt).not.toContain(runId);
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
});
