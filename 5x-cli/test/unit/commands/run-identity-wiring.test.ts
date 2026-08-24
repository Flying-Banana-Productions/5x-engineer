/**
 * Handler wiring for ambient run identity (Phase 3).
 *
 * Calls `runCommit` / `runV1State` with an injected DB + pointer so
 * `--run` can be omitted. `env: {}` isolates tests from a parent FIVEX_RUN.
 */

import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommit } from "../../../src/commands/commit.handler.js";
import type { DbContext } from "../../../src/commands/context.js";
import {
	currentRunPath,
	writePointer,
} from "../../../src/commands/run-pointer.js";
import { runV1State } from "../../../src/commands/run-v1.handler.js";
import { FiveXConfigSchema } from "../../../src/config.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { CliError } from "../../../src/output.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

interface TestContext {
	tmp: string;
	db: Database;
	dbContext: DbContext;
	planPath: string;
}

function setup(): TestContext {
	const tmp = mkdtempSync(join(tmpdir(), "5x-identity-wire-"));

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

	writeFileSync(join(tmp, ".gitignore"), ".5x/\n5x.toml.local\n");
	writeFileSync(join(tmp, "5x.toml"), "");
	writeFileSync(join(tmp, "README.md"), "# test\n");
	mkdirSync(join(tmp, "docs"), { recursive: true });
	const planPath = join(tmp, "docs", "plan.md");
	writeFileSync(planPath, "# Plan\n");

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

	const stateDir = join(tmp, ".5x");
	mkdirSync(stateDir, { recursive: true });
	const db = new Database(resolve(tmp, ".5x/5x.db"));
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

function teardown(ctx: TestContext): void {
	try {
		ctx.db.close();
	} catch {
		// already closed
	}
	try {
		rmSync(ctx.tmp, { recursive: true, force: true });
	} catch {
		// cleanup can fail
	}
}

function createTestRun(
	database: Database,
	planPath: string,
	runId = "run_wire123456",
): string {
	createRunV1(database, { id: runId, planPath });
	return runId;
}

describe("ambient identity handler wiring", () => {
	test(
		"commit without identity fails with RUN_CONTEXT_REQUIRED",
		async () => {
			const ctx = setup();
			try {
				createTestRun(ctx.db, ctx.planPath);
				writeFileSync(join(ctx.tmp, "src.ts"), "export const x = 1;\n");

				try {
					await runCommit({
						message: "add src.ts",
						allFiles: true,
						phase: "1",
						startDir: ctx.tmp,
						dbContext: ctx.dbContext,
						env: {},
					});
					expect(true).toBe(false);
				} catch (err) {
					expect(err).toBeInstanceOf(CliError);
					expect((err as CliError).code).toBe("RUN_CONTEXT_REQUIRED");
				}
			} finally {
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"commit without --run uses the focus pointer",
		async () => {
			const spy = spyOn(console, "log").mockImplementation(() => {});
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);
				writePointer(currentRunPath(ctx.tmp, ".5x"), runId);
				writeFileSync(join(ctx.tmp, "src.ts"), "export const x = 1;\n");

				await runCommit({
					message: "add src.ts",
					allFiles: true,
					phase: "1",
					startDir: ctx.tmp,
					dbContext: ctx.dbContext,
					env: {},
				});

				const logResult = Bun.spawnSync(["git", "log", "--oneline", "-1"], {
					cwd: ctx.tmp,
					env: cleanGitEnv(),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(logResult.stdout.toString()).toContain("add src.ts");
			} finally {
				spy.mockRestore();
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"run state without identity fails with RUN_CONTEXT_REQUIRED",
		async () => {
			const ctx = setup();
			try {
				createTestRun(ctx.db, ctx.planPath);
				try {
					await runV1State({
						startDir: ctx.tmp,
						env: {},
					});
					expect(true).toBe(false);
				} catch (err) {
					expect(err).toBeInstanceOf(CliError);
					expect((err as CliError).code).toBe("RUN_CONTEXT_REQUIRED");
				}
			} finally {
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);

	test(
		"run state without --run uses the focus pointer",
		async () => {
			const ctx = setup();
			try {
				const runId = createTestRun(ctx.db, ctx.planPath);
				writePointer(currentRunPath(ctx.tmp, ".5x"), runId);
				await runV1State({
					startDir: ctx.tmp,
					env: {},
				});
			} finally {
				teardown(ctx);
			}
		},
		{ timeout: 15000 },
	);
});
