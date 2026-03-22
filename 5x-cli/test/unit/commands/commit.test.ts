/**
 * Unit tests for commit handler (`5x commit`).
 *
 * Phase 1 review fix (P2.1): covers the handler's core paths —
 * successful commit + step recording, dry-run, validation errors,
 * inactive run rejection, nothing-to-commit, dry-run failure, and
 * phase recording.
 *
 * Tests call `runCommit()` directly with a `startDir` temp directory
 * containing a git repo and 5x init (control-plane with DB).
 *
 * Concurrency-safe: each test creates its own isolated temp dir, DB, and
 * DbContext via `setup()`. No shared mutable module-level state — safe
 * under `--concurrent`.
 */

import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommit } from "../../../src/commands/commit.handler.js";
import type { DbContext } from "../../../src/commands/context.js";
import { FiveXConfigSchema } from "../../../src/config.js";
import { createRunV1, getSteps } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { CliError } from "../../../src/output.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

interface TestContext {
	tmp: string;
	db: Database;
	dbContext: DbContext;
	planPath: string;
}

/**
 * Create a fully isolated test environment: temp dir, git repo, DB, and
 * plan file. Returns everything the test needs — no shared mutable state.
 */
function setup(): TestContext {
	const tmp = mkdtempSync(join(tmpdir(), "5x-commit-test-"));

	// Init git repo
	Bun.spawnSync(["git", "init"], {
		cwd: tmp,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: tmp,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: tmp,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});

	// Write control-plane files and plan
	writeFileSync(join(tmp, ".gitignore"), ".5x/\n");
	writeFileSync(join(tmp, "5x.toml"), "");
	writeFileSync(join(tmp, "README.md"), "# test\n");
	mkdirSync(join(tmp, "docs"), { recursive: true });
	const planPath = join(tmp, "docs", "plan.md");
	writeFileSync(planPath, "# Plan\n");

	// Initial commit (includes plan)
	Bun.spawnSync(["git", "add", "-A"], {
		cwd: tmp,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "commit", "-m", "initial"], {
		cwd: tmp,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});

	// Open non-singleton DB
	const stateDir = join(tmp, ".5x");
	mkdirSync(stateDir, { recursive: true });
	const dbPath = resolve(tmp, ".5x/5x.db");
	const db = new Database(dbPath);
	db.exec("PRAGMA journal_mode=WAL");
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	runMigrations(db);

	const config = FiveXConfigSchema.parse({});
	const dbContext: DbContext = {
		projectRoot: tmp,
		config,
		db,
		controlPlane: {
			controlPlaneRoot: tmp,
			stateDir: ".5x",
			mode: "isolated",
		},
	};

	return { tmp, db, dbContext, planPath };
}

/** Clean up test environment. */
function teardown(ctx: TestContext): void {
	try {
		ctx.db.close();
	} catch {
		// Already closed
	}
	try {
		rmSync(ctx.tmp, { recursive: true, force: true });
	} catch {
		// Cleanup can fail
	}
}

function createTestRun(
	database: Database,
	planPath: string,
	runId = "run_test123456",
): string {
	createRunV1(database, { id: runId, planPath });
	return runId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runCommit", () => {
	test(
		"commits with --all-files and records git:commit step",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);

				// Create a new file to commit
				writeFileSync(join(ctx.tmp, "src.ts"), "export const x = 1;\n");

				await runCommit({
					run: runId,
					message: "add src.ts",
					allFiles: true,
					startDir: ctx.tmp,
					dbContext: ctx.dbContext,
				});

				// Verify git log shows the commit
				const logResult = Bun.spawnSync(["git", "log", "--oneline", "-1"], {
					cwd: ctx.tmp,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const logLine = logResult.stdout.toString().trim();
				expect(logLine).toContain("add src.ts");

				// Verify step was recorded in DB
				const steps = getSteps(ctx.db, runId);
				const commitStep = steps.find((s) => s.step_name === "git:commit");
				expect(commitStep).toBeDefined();

				const result = JSON.parse(commitStep?.result_json ?? "{}");
				expect(result.hash).toBeTruthy();
				expect(result.short_hash).toBeTruthy();
				expect(result.message).toBe("add src.ts");
				expect(result.files).toContain("src.ts");
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"commits with --files and only stages specified files",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);

				// Create two files, only commit one
				writeFileSync(join(ctx.tmp, "a.ts"), "a\n");
				writeFileSync(join(ctx.tmp, "b.ts"), "b\n");

				await runCommit({
					run: runId,
					message: "add a.ts only",
					files: ["a.ts"],
					startDir: ctx.tmp,
					dbContext: ctx.dbContext,
				});

				// Verify only a.ts is in the commit
				const diffResult = Bun.spawnSync(
					["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
					{
						cwd: ctx.tmp,
						env: cleanGitEnv(),
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const committedFiles = diffResult.stdout.toString().trim().split("\n");
				expect(committedFiles).toContain("a.ts");
				expect(committedFiles).not.toContain("b.ts");

				// b.ts should remain unstaged
				const statusResult = Bun.spawnSync(["git", "status", "--porcelain"], {
					cwd: ctx.tmp,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const statusOutput = statusResult.stdout.toString().trim();
				expect(statusOutput).toContain("b.ts");
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--dry-run with --all-files creates no commit and records no step",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);
				writeFileSync(join(ctx.tmp, "dry-test.ts"), "dry run\n");

				// Get HEAD before dry-run
				const headBefore = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
					cwd: ctx.tmp,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				})
					.stdout.toString()
					.trim();

				await runCommit({
					run: runId,
					message: "should not appear",
					allFiles: true,
					dryRun: true,
					startDir: ctx.tmp,
					dbContext: ctx.dbContext,
				});

				// HEAD should not have changed
				const headAfter = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
					cwd: ctx.tmp,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				})
					.stdout.toString()
					.trim();
				expect(headAfter).toBe(headBefore);

				// No step should be recorded
				const steps = getSteps(ctx.db, runId);
				expect(steps.filter((s) => s.step_name === "git:commit")).toHaveLength(
					0,
				);
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--dry-run with --files creates no commit",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);
				writeFileSync(join(ctx.tmp, "dry-test.ts"), "dry run\n");

				const headBefore = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
					cwd: ctx.tmp,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				})
					.stdout.toString()
					.trim();

				await runCommit({
					run: runId,
					message: "should not appear",
					files: ["dry-test.ts"],
					dryRun: true,
					startDir: ctx.tmp,
					dbContext: ctx.dbContext,
				});

				const headAfter = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
					cwd: ctx.tmp,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				})
					.stdout.toString()
					.trim();
				expect(headAfter).toBe(headBefore);
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"--dry-run fails when git add --dry-run returns non-zero exit code",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);

				// Use a pathspec that doesn't exist — git add --dry-run will fail
				try {
					await runCommit({
						run: runId,
						message: "should fail",
						files: ["nonexistent-file-that-does-not-exist.xyz"],
						dryRun: true,
						startDir: ctx.tmp,
						dbContext: ctx.dbContext,
					});
					// Should not reach here
					expect(true).toBe(false);
				} catch (err) {
					expect(err).toBeInstanceOf(CliError);
					expect((err as CliError).code).toBe("COMMIT_FAILED");
				}
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"rejects inactive run",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);

				// Complete the run
				ctx.db
					.query("UPDATE runs SET status = 'completed' WHERE id = ?1")
					.run(runId);

				try {
					await runCommit({
						run: runId,
						message: "should fail",
						allFiles: true,
						startDir: ctx.tmp,
						dbContext: ctx.dbContext,
					});
					expect(true).toBe(false);
				} catch (err) {
					expect(err).toBeInstanceOf(CliError);
					expect((err as CliError).code).toBe("RUN_NOT_ACTIVE");
				}
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"nothing to commit surfaces COMMIT_FAILED",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);

				// Don't create any new files — nothing to commit
				try {
					await runCommit({
						run: runId,
						message: "nothing to commit",
						allFiles: true,
						startDir: ctx.tmp,
						dbContext: ctx.dbContext,
					});
					expect(true).toBe(false);
				} catch (err) {
					expect(err).toBeInstanceOf(CliError);
					expect((err as CliError).code).toBe("COMMIT_FAILED");
					// The message should contain git's "nothing to commit" text
					expect((err as CliError).message).toContain("nothing to commit");
				}
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"phase is recorded in step",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);
				writeFileSync(join(ctx.tmp, "phase2.ts"), "phase 2 code\n");

				await runCommit({
					run: runId,
					message: "phase 2 work",
					allFiles: true,
					phase: "2",
					startDir: ctx.tmp,
					dbContext: ctx.dbContext,
				});

				const steps = getSteps(ctx.db, runId);
				const commitStep = steps.find((s) => s.step_name === "git:commit");
				expect(commitStep).toBeDefined();
				expect(commitStep?.phase).toBe("2");
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"rejects when neither --files nor --all-files provided",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);

				try {
					await runCommit({
						run: runId,
						message: "should fail",
						// Neither files nor allFiles
						startDir: ctx.tmp,
						dbContext: ctx.dbContext,
					});
					expect(true).toBe(false);
				} catch (err) {
					expect(err).toBeInstanceOf(CliError);
					expect((err as CliError).code).toBe("INVALID_ARGS");
					expect((err as CliError).message).toContain(
						"Either --files or --all-files is required",
					);
				}
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"rejects when both --files and --all-files provided",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);

				try {
					await runCommit({
						run: runId,
						message: "should fail",
						files: ["some-file.ts"],
						allFiles: true,
						startDir: ctx.tmp,
						dbContext: ctx.dbContext,
					});
					expect(true).toBe(false);
				} catch (err) {
					expect(err).toBeInstanceOf(CliError);
					expect((err as CliError).code).toBe("INVALID_ARGS");
					expect((err as CliError).message).toContain("mutually exclusive");
				}
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"hook failure prevents journal recording",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);

				// Install a pre-commit hook that always fails
				const hooksDir = join(ctx.tmp, ".git", "hooks");
				mkdirSync(hooksDir, { recursive: true });
				writeFileSync(
					join(hooksDir, "pre-commit"),
					"#!/bin/sh\necho 'hook rejected'\nexit 1\n",
				);
				chmodSync(join(hooksDir, "pre-commit"), 0o755);

				writeFileSync(join(ctx.tmp, "hook-test.ts"), "hook test\n");

				const headBefore = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
					cwd: ctx.tmp,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				})
					.stdout.toString()
					.trim();

				try {
					await runCommit({
						run: runId,
						message: "should fail due to hook",
						allFiles: true,
						startDir: ctx.tmp,
						dbContext: ctx.dbContext,
					});
					expect(true).toBe(false);
				} catch (err) {
					expect(err).toBeInstanceOf(CliError);
					expect((err as CliError).code).toBe("COMMIT_FAILED");
				}

				// HEAD should not have changed
				const headAfter = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
					cwd: ctx.tmp,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				})
					.stdout.toString()
					.trim();
				expect(headAfter).toBe(headBefore);

				// No git:commit step should be recorded
				const steps = getSteps(ctx.db, runId);
				expect(steps.filter((s) => s.step_name === "git:commit")).toHaveLength(
					0,
				);
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"mapped worktree commit — creates commit in worktree branch and records step",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);

				// Create a linked worktree
				const wtDir = join(ctx.tmp, ".5x", "worktrees", "feature");
				mkdirSync(join(ctx.tmp, ".5x", "worktrees"), { recursive: true });
				Bun.spawnSync(["git", "worktree", "add", wtDir, "-b", "feature"], {
					cwd: ctx.tmp,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});

				// Map the plan to the worktree in the plans table
				ctx.db
					.query(
						`INSERT OR REPLACE INTO plans (plan_path, worktree_path, branch, created_at, updated_at)
						 VALUES (?1, ?2, 'feature', datetime('now'), datetime('now'))`,
					)
					.run(ctx.planPath, wtDir);

				// Create a file in the worktree
				writeFileSync(join(wtDir, "wt-file.ts"), "worktree code\n");

				await runCommit({
					run: runId,
					message: "commit in worktree",
					allFiles: true,
					startDir: ctx.tmp,
					dbContext: ctx.dbContext,
				});

				// Verify commit exists in worktree branch
				const logResult = Bun.spawnSync(["git", "log", "--oneline", "-1"], {
					cwd: wtDir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const logLine = logResult.stdout.toString().trim();
				expect(logLine).toContain("commit in worktree");

				// Verify step was recorded in DB with correct hash
				const steps = getSteps(ctx.db, runId);
				const commitStep = steps.find((s) => s.step_name === "git:commit");
				expect(commitStep).toBeDefined();

				const result = JSON.parse(commitStep?.result_json ?? "{}");
				expect(result.hash).toBeTruthy();
				expect(result.message).toBe("commit in worktree");
				expect(result.files).toContain("wt-file.ts");

				// Verify the hash matches what git says in the worktree
				const hashResult = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
					cwd: wtDir,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(result.hash).toBe(hashResult.stdout.toString().trim());
			} finally {
				spy.mockRestore();
				// Remove worktree before cleanup to avoid git lock issues
				Bun.spawnSync(
					[
						"git",
						"worktree",
						"remove",
						"--force",
						join(ctx.tmp, ".5x", "worktrees", "feature"),
					],
					{
						cwd: ctx.tmp,
						env: cleanGitEnv(),
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);
});
