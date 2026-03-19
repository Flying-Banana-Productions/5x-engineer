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
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommit } from "../../../src/commands/commit.handler.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { createRunV1, getSteps } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { CliError } from "../../../src/output.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

let tmp: string;
let db: Database;

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "5x-commit-test-"));
}

/**
 * Create a temporary directory with a git repo and 5x control-plane DB.
 * The initial commit includes .gitignore (excluding .5x/) and 5x.toml
 * so the control-plane DB files don't pollute git status.
 */
function initGitRepo(dir: string): void {
	Bun.spawnSync(["git", "init"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});

	// Write control-plane files first so they're committed in the initial commit
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	writeFileSync(join(dir, "5x.toml"), "");
	writeFileSync(join(dir, "README.md"), "# test\n");

	Bun.spawnSync(["git", "add", "-A"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	Bun.spawnSync(["git", "commit", "-m", "initial"], {
		cwd: dir,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
}

function initControlPlane(dir: string): void {
	// Create .5x directory for the DB (gitignored in initial commit)
	const stateDir = join(dir, ".5x");
	mkdirSync(stateDir, { recursive: true });
}

function openDb(dir: string): Database {
	const d = getDb(dir, ".5x/5x.db");
	runMigrations(d);
	return d;
}

function createTestRun(
	database: Database,
	planPath: string,
	runId = "run_test123456",
): string {
	createRunV1(database, { id: runId, planPath });
	return runId;
}

// Suppress outputSuccess from writing to stdout
let consoleLogSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	tmp = makeTmpDir();
	initGitRepo(tmp);
	initControlPlane(tmp);
	db = openDb(tmp);
	consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
	consoleLogSpy.mockRestore();
	closeDb();
	_resetForTest();
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		// Windows cleanup can fail
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runCommit", () => {
	test(
		"commits with --all-files and records git:commit step",
		async () => {
			const planPath = join(tmp, "docs", "plan.md");
			mkdirSync(join(tmp, "docs"), { recursive: true });
			writeFileSync(planPath, "# Plan\n");
			// Need to commit the plan so git repo stays clean for the test
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			Bun.spawnSync(["git", "commit", "-m", "add plan"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});

			const runId = createTestRun(db, planPath);

			// Create a new file to commit
			writeFileSync(join(tmp, "src.ts"), "export const x = 1;\n");

			await runCommit({
				run: runId,
				message: "add src.ts",
				allFiles: true,
				startDir: tmp,
			});

			// Verify git log shows the commit
			const logResult = Bun.spawnSync(["git", "log", "--oneline", "-1"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const logLine = logResult.stdout.toString().trim();
			expect(logLine).toContain("add src.ts");

			// Verify step was recorded in DB
			const steps = getSteps(db, runId);
			const commitStep = steps.find((s) => s.step_name === "git:commit");
			expect(commitStep).toBeDefined();

			const result = JSON.parse(commitStep?.result_json ?? "{}");
			expect(result.hash).toBeTruthy();
			expect(result.short_hash).toBeTruthy();
			expect(result.message).toBe("add src.ts");
			expect(result.files).toContain("src.ts");
		},
		{ timeout: 15000 },
	);

	test(
		"commits with --files and only stages specified files",
		async () => {
			const planPath = join(tmp, "docs", "plan.md");
			mkdirSync(join(tmp, "docs"), { recursive: true });
			writeFileSync(planPath, "# Plan\n");
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			Bun.spawnSync(["git", "commit", "-m", "add plan"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});

			const runId = createTestRun(db, planPath);

			// Create two files, only commit one
			writeFileSync(join(tmp, "a.ts"), "a\n");
			writeFileSync(join(tmp, "b.ts"), "b\n");

			await runCommit({
				run: runId,
				message: "add a.ts only",
				files: ["a.ts"],
				startDir: tmp,
			});

			// Verify only a.ts is in the commit
			const diffResult = Bun.spawnSync(
				["git", "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
				{
					cwd: tmp,
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
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const statusOutput = statusResult.stdout.toString().trim();
			expect(statusOutput).toContain("b.ts");
		},
		{ timeout: 15000 },
	);

	test(
		"--dry-run with --all-files creates no commit and records no step",
		async () => {
			const planPath = join(tmp, "docs", "plan.md");
			mkdirSync(join(tmp, "docs"), { recursive: true });
			writeFileSync(planPath, "# Plan\n");
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			Bun.spawnSync(["git", "commit", "-m", "add plan"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});

			const runId = createTestRun(db, planPath);
			writeFileSync(join(tmp, "dry-test.ts"), "dry run\n");

			// Get HEAD before dry-run
			const headBefore = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
				cwd: tmp,
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
				startDir: tmp,
			});

			// HEAD should not have changed
			const headAfter = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			})
				.stdout.toString()
				.trim();
			expect(headAfter).toBe(headBefore);

			// No step should be recorded
			const steps = getSteps(db, runId);
			expect(steps.filter((s) => s.step_name === "git:commit")).toHaveLength(0);
		},
		{ timeout: 15000 },
	);

	test(
		"--dry-run with --files creates no commit",
		async () => {
			const planPath = join(tmp, "docs", "plan.md");
			mkdirSync(join(tmp, "docs"), { recursive: true });
			writeFileSync(planPath, "# Plan\n");
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			Bun.spawnSync(["git", "commit", "-m", "add plan"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});

			const runId = createTestRun(db, planPath);
			writeFileSync(join(tmp, "dry-test.ts"), "dry run\n");

			const headBefore = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
				cwd: tmp,
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
				startDir: tmp,
			});

			const headAfter = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			})
				.stdout.toString()
				.trim();
			expect(headAfter).toBe(headBefore);
		},
		{ timeout: 15000 },
	);

	test(
		"--dry-run fails when git add --dry-run returns non-zero exit code",
		async () => {
			const planPath = join(tmp, "docs", "plan.md");
			mkdirSync(join(tmp, "docs"), { recursive: true });
			writeFileSync(planPath, "# Plan\n");
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			Bun.spawnSync(["git", "commit", "-m", "add plan"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});

			const runId = createTestRun(db, planPath);

			// Use a pathspec that doesn't exist — git add --dry-run will fail
			try {
				await runCommit({
					run: runId,
					message: "should fail",
					files: ["nonexistent-file-that-does-not-exist.xyz"],
					dryRun: true,
					startDir: tmp,
				});
				// Should not reach here
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("COMMIT_FAILED");
			}
		},
		{ timeout: 15000 },
	);

	test(
		"rejects inactive run",
		async () => {
			const planPath = join(tmp, "docs", "plan.md");
			mkdirSync(join(tmp, "docs"), { recursive: true });
			writeFileSync(planPath, "# Plan\n");
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			Bun.spawnSync(["git", "commit", "-m", "add plan"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});

			const runId = createTestRun(db, planPath);

			// Complete the run
			db.query("UPDATE runs SET status = 'completed' WHERE id = ?1").run(runId);

			try {
				await runCommit({
					run: runId,
					message: "should fail",
					allFiles: true,
					startDir: tmp,
				});
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("RUN_NOT_ACTIVE");
			}
		},
		{ timeout: 15000 },
	);

	test(
		"nothing to commit surfaces COMMIT_FAILED",
		async () => {
			const planPath = join(tmp, "docs", "plan.md");
			mkdirSync(join(tmp, "docs"), { recursive: true });
			writeFileSync(planPath, "# Plan\n");
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			Bun.spawnSync(["git", "commit", "-m", "add plan"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});

			const runId = createTestRun(db, planPath);

			// Don't create any new files — nothing to commit
			try {
				await runCommit({
					run: runId,
					message: "nothing to commit",
					allFiles: true,
					startDir: tmp,
				});
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("COMMIT_FAILED");
				// The message should contain git's "nothing to commit" text
				expect((err as CliError).message).toContain("nothing to commit");
			}
		},
		{ timeout: 15000 },
	);

	test(
		"phase is recorded in step",
		async () => {
			const planPath = join(tmp, "docs", "plan.md");
			mkdirSync(join(tmp, "docs"), { recursive: true });
			writeFileSync(planPath, "# Plan\n");
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			Bun.spawnSync(["git", "commit", "-m", "add plan"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});

			const runId = createTestRun(db, planPath);
			writeFileSync(join(tmp, "phase2.ts"), "phase 2 code\n");

			await runCommit({
				run: runId,
				message: "phase 2 work",
				allFiles: true,
				phase: "2",
				startDir: tmp,
			});

			const steps = getSteps(db, runId);
			const commitStep = steps.find((s) => s.step_name === "git:commit");
			expect(commitStep).toBeDefined();
			expect(commitStep?.phase).toBe("2");
		},
		{ timeout: 15000 },
	);

	test(
		"hook failure prevents journal recording",
		async () => {
			const planPath = join(tmp, "docs", "plan.md");
			mkdirSync(join(tmp, "docs"), { recursive: true });
			writeFileSync(planPath, "# Plan\n");
			Bun.spawnSync(["git", "add", "-A"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			Bun.spawnSync(["git", "commit", "-m", "add plan"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});

			const runId = createTestRun(db, planPath);

			// Install a pre-commit hook that always fails
			const hooksDir = join(tmp, ".git", "hooks");
			mkdirSync(hooksDir, { recursive: true });
			writeFileSync(
				join(hooksDir, "pre-commit"),
				"#!/bin/sh\necho 'hook rejected'\nexit 1\n",
			);
			chmodSync(join(hooksDir, "pre-commit"), 0o755);

			writeFileSync(join(tmp, "hook-test.ts"), "hook test\n");

			const headBefore = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
				cwd: tmp,
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
					startDir: tmp,
				});
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(CliError);
				expect((err as CliError).code).toBe("COMMIT_FAILED");
			}

			// HEAD should not have changed
			const headAfter = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
				cwd: tmp,
				env: cleanGitEnv(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			})
				.stdout.toString()
				.trim();
			expect(headAfter).toBe(headBefore);

			// No git:commit step should be recorded
			const steps = getSteps(db, runId);
			expect(steps.filter((s) => s.step_name === "git:commit")).toHaveLength(0);
		},
		{ timeout: 15000 },
	);
});
