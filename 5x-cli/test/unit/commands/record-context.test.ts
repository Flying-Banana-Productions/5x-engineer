/**
 * Tests for createRecordContext — originFor, redactedRecorder, worktree re-root.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRecordContext } from "../../../src/commands/record-context.js";
import { FiveXConfigSchema } from "../../../src/config.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { createRunV1, getRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { loadOrCreateInstallationIdentity } from "../../../src/records/identity.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

function git(args: string[], cwd: string): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		env: cleanGitEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString()}`,
		);
	}
}

afterEach(() => {
	closeDb();
	_resetForTest();
});

describe("createRecordContext", () => {
	test(
		"returns originFor, redactedRecorder, and worktree-re-rooted store",
		async () => {
			const tmp = mkdtempSync(join(tmpdir(), "5x-record-ctx-"));
			const configHome = mkdtempSync(join(tmpdir(), "5x-record-ctx-id-"));
			const prevConfigHome = process.env.FIVEX_CONFIG_HOME;
			process.env.FIVEX_CONFIG_HOME = configHome;
			try {
				git(["init"], tmp);
				git(["config", "user.email", "test@test.com"], tmp);
				git(["config", "user.name", "Test"], tmp);
				mkdirSync(join(tmp, ".5x"), { recursive: true });
				writeFileSync(join(tmp, ".gitignore"), ".5x/\n");
				git(["add", "-A"], tmp);
				git(["commit", "-m", "init"], tmp);

				const db = getDb(tmp);
				runMigrations(db);
				createRunV1(db, {
					id: "run_recordctx1",
					planPath: join(tmp, "plan.md"),
				});

				const config = FiveXConfigSchema.parse({});
				const ctx = await createRecordContext({
					runId: "run_recordctx1",
					dbContext: {
						projectRoot: tmp,
						db,
						config: {
							...config,
							paths: {
								...config.paths,
								records: join(tmp, "docs", "development", "runs"),
							},
						},
						controlPlane: {
							controlPlaneRoot: tmp,
							stateDir: ".5x",
							mode: "isolated",
						},
					},
				});

				expect(ctx.recordsRelPath).toBe("docs/development/runs");
				expect(ctx.recordsAbsPath).toBe(
					join(tmp, "docs", "development", "runs"),
				);
				expect(ctx.executionContext.effectiveWorkingDirectory).toBe(tmp);

				const identity = loadOrCreateInstallationIdentity({
					homeDir: homedir(),
				});
				const origin = ctx.originFor({ kind: "system", role: "cli" });
				expect(origin.recorder.installation_id).toBe(identity.installation_id);
				expect(origin.performer).toEqual({ kind: "system", role: "cli" });
				expect(ctx.redactedRecorder().installation_id).toBe(
					identity.installation_id,
				);
			} finally {
				if (prevConfigHome === undefined) delete process.env.FIVEX_CONFIG_HOME;
				else process.env.FIVEX_CONFIG_HOME = prevConfigHome;
				rmSync(tmp, { recursive: true, force: true });
				rmSync(configHome, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"origin.actor is omitted when records.redact includes origin.actor",
		async () => {
			const tmp = mkdtempSync(join(tmpdir(), "5x-record-ctx-redact-"));
			const configHome = mkdtempSync(join(tmpdir(), "5x-record-ctx-id-r-"));
			const prevConfigHome = process.env.FIVEX_CONFIG_HOME;
			const prevActor = process.env.FIVEX_RECORDS_ACTOR;
			process.env.FIVEX_CONFIG_HOME = configHome;
			process.env.FIVEX_RECORDS_ACTOR = "test-actor";
			try {
				git(["init"], tmp);
				git(["config", "user.email", "test@test.com"], tmp);
				git(["config", "user.name", "Test"], tmp);
				mkdirSync(join(tmp, ".5x"), { recursive: true });
				writeFileSync(join(tmp, ".gitignore"), ".5x/\n");
				git(["add", "-A"], tmp);
				git(["commit", "-m", "init"], tmp);

				const db = getDb(tmp);
				runMigrations(db);
				createRunV1(db, { id: "run_redact1", planPath: join(tmp, "plan.md") });

				const config = FiveXConfigSchema.parse({
					records: { redact: ["origin.actor"] },
				});
				const ctx = await createRecordContext({
					runId: "run_redact1",
					dbContext: {
						projectRoot: tmp,
						db,
						config: {
							...config,
							paths: {
								...config.paths,
								records: join(tmp, "docs", "development", "runs"),
							},
						},
						controlPlane: {
							controlPlaneRoot: tmp,
							stateDir: ".5x",
							mode: "isolated",
						},
					},
				});

				const origin = ctx.originFor({ kind: "human", role: "operator" });
				expect(origin.recorder.actor).toBeUndefined();
				expect(origin.recorder.installation_id).toBeTruthy();
				expect(origin.performer.kind).toBe("human");
				expect(ctx.redactedRecorder().actor).toBeUndefined();
			} finally {
				if (prevConfigHome === undefined) delete process.env.FIVEX_CONFIG_HOME;
				else process.env.FIVEX_CONFIG_HOME = prevConfigHome;
				if (prevActor === undefined) delete process.env.FIVEX_RECORDS_ACTOR;
				else process.env.FIVEX_RECORDS_ACTOR = prevActor;
				rmSync(tmp, { recursive: true, force: true });
				rmSync(configHome, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);

	test(
		"linked worktree re-roots recordsAbsPath under the mapped worktree",
		async () => {
			const tmp = mkdtempSync(join(tmpdir(), "5x-record-ctx-cp-"));
			const worktree = mkdtempSync(join(tmpdir(), "5x-record-ctx-wt-"));
			const configHome = mkdtempSync(join(tmpdir(), "5x-record-ctx-id-wt-"));
			const prevConfigHome = process.env.FIVEX_CONFIG_HOME;
			process.env.FIVEX_CONFIG_HOME = configHome;
			try {
				git(["init"], tmp);
				git(["config", "user.email", "test@test.com"], tmp);
				git(["config", "user.name", "Test"], tmp);
				mkdirSync(join(tmp, ".5x"), { recursive: true });
				mkdirSync(join(tmp, "docs"), { recursive: true });
				const planPath = join(tmp, "docs", "plan.md");
				writeFileSync(planPath, "# Plan\n");
				writeFileSync(join(tmp, ".gitignore"), ".5x/\n");
				git(["add", "-A"], tmp);
				git(["commit", "-m", "init"], tmp);

				const db = getDb(tmp);
				runMigrations(db);
				createRunV1(db, { id: "run_recordctx_wt", planPath });
				const run = getRunV1(db, "run_recordctx_wt");
				db.query(
					"INSERT INTO plans (plan_path, worktree_path) VALUES (?1, ?2)",
				).run(run?.plan_path ?? planPath, worktree);

				const config = FiveXConfigSchema.parse({});
				const ctx = await createRecordContext({
					runId: "run_recordctx_wt",
					dbContext: {
						projectRoot: tmp,
						db,
						config: {
							...config,
							paths: {
								...config.paths,
								records: join(tmp, "docs", "development", "runs"),
							},
						},
						controlPlane: {
							controlPlaneRoot: tmp,
							stateDir: ".5x",
							mode: "isolated",
						},
					},
				});

				expect(ctx.recordsRelPath).toBe("docs/development/runs");
				expect(ctx.recordsAbsPath).toBe(
					join(worktree, "docs", "development", "runs"),
				);
				expect(ctx.recordsAbsPath).not.toBe(
					join(tmp, "docs", "development", "runs"),
				);
				expect(ctx.executionContext.effectiveWorkingDirectory).toBe(worktree);
			} finally {
				if (prevConfigHome === undefined) delete process.env.FIVEX_CONFIG_HOME;
				else process.env.FIVEX_CONFIG_HOME = prevConfigHome;
				rmSync(tmp, { recursive: true, force: true });
				rmSync(worktree, { recursive: true, force: true });
				rmSync(configHome, { recursive: true, force: true });
			}
		},
		{ timeout: 15000 },
	);
});
