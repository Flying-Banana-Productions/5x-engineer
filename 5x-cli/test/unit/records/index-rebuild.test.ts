/**
 * Unit tests for records index rebuild: upsert, skip newer local-only, idempotent.
 *
 * Each case owns a unique temp git checkout and SQLite connection, closed
 * before the directory is removed, so `--concurrent` cannot delete another
 * test's repo or trigger SQLITE_IOERR_VNODE on a live handle.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config.js";
import {
	encodeJsonlFile,
	encodeRunJson,
} from "../../../src/control-plane/record-layout.js";
import {
	RECORD_LINE_SCHEMA_VERSION,
	type RecordLine,
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
	type RunRecordSummary,
	stepIdempotencyKey,
} from "../../../src/control-plane/record-types.js";
import {
	createRunV1,
	getRunV1,
	getSteps,
	recordStep,
} from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";
import { rebuildRecordsIndex } from "../../../src/records/index-rebuild.js";
import { resolvePlanProgress } from "../../../src/records/resolve.js";
import { cleanGitEnv } from "../../helpers/clean-env.js";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN: RecordOrigin = {
	recorder: { installation_id: INSTALLATION_ID, actor: "tester" },
	performer: { kind: "system", role: "cli" },
};
const EXPORTER: RecordOrigin = {
	recorder: { installation_id: "22222222-2222-4222-8222-222222222222" },
	performer: { kind: "system", role: "exporter" },
};

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "5x-index-rebuild-"));
	try {
		await fn(dir);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

function git(args: string[], cwd: string): string {
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
	return result.stdout.toString().trim();
}

function initRepo(dir: string): void {
	git(["init"], dir);
	git(["config", "user.email", "test@test.com"], dir);
	git(["config", "user.name", "Test"], dir);
	git(["branch", "-M", "main"], dir);
	writeFileSync(join(dir, ".gitignore"), ".5x/\n");
	git(["add", "-A"], dir);
	git(["commit", "-m", "init"], dir);
}

function v1Summary(
	id: string,
	overrides: Partial<RunRecordSummary> = {},
): RunRecordSummary {
	return {
		id,
		plan_path: "docs/development/alpha.md",
		config_json: null,
		created_at: "2026-09-01 12:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "1.3.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: { installation_id: INSTALLATION_ID, actor: "tester" },
		...overrides,
	};
}

function stepLine(
	runId: string,
	name: string,
	opts?: { phase?: string | null; iteration?: number; createdAt?: string },
): RecordLine {
	const phase = opts?.phase ?? "1";
	const iteration = opts?.iteration ?? 1;
	return {
		runId,
		stream: "steps",
		idempotencyKey: stepIdempotencyKey({
			runId,
			stepName: name,
			phase,
			iteration,
		}),
		payload: {
			step_name: name,
			phase,
			iteration,
			result_json: { ok: true, step: name },
			head_commit: "abc123",
			patch_id: null,
			diff_summary: null,
			duration_ms: 10,
			tokens_in: 1,
			tokens_out: 2,
			cost_usd: 0.01,
			model: "test-model",
		},
		createdAt: opts?.createdAt ?? "2026-09-01 12:00:00",
		schemaVersion: RECORD_LINE_SCHEMA_VERSION,
		provenance: "recorded",
		origin: ORIGIN,
	};
}

function writeRecords(
	dir: string,
	summary: RunRecordSummary,
	steps: RecordLine[],
): void {
	const slug = "alpha";
	const runDir = join(dir, "docs", "development", "runs", slug, summary.id);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "run.json"), encodeRunJson(summary));
	writeFileSync(join(runDir, "steps.jsonl"), encodeJsonlFile(steps));
	mkdirSync(join(dir, "docs", "development"), { recursive: true });
	writeFileSync(
		join(dir, "docs", "development", "alpha.md"),
		"# Alpha\n\n## Phase 1: P1\n\n- [x] task\n",
	);
}

function commitAll(dir: string, message: string): void {
	git(["add", "-A"], dir);
	git(["commit", "-m", message], dir);
}

function openOwnedDb(dir: string): Database {
	mkdirSync(join(dir, ".5x"), { recursive: true });
	const db = new Database(join(dir, ".5x", "5x.db"));
	db.exec("PRAGMA foreign_keys=ON");
	db.exec("PRAGMA busy_timeout=5000");
	runMigrations(db);
	return db;
}

function closeOwned(db: Database): void {
	try {
		db.close();
	} catch {
		/* already closed */
	}
}

describe("rebuildRecordsIndex", () => {
	test("upserts runs and steps; second pass is a no-op on counts", async () => {
		await withTmp(async (dir) => {
			initRepo(dir);
			const summary = v1Summary("run_alpha");
			writeRecords(dir, summary, [stepLine("run_alpha", "author:impl")]);
			commitAll(dir, "records");
			const db = openOwnedDb(dir);
			try {
				const { config } = await loadConfig(dir, undefined, undefined, dir);

				const first = await rebuildRecordsIndex({
					db,
					workdir: dir,
					config,
					resolve: resolvePlanProgress,
				});
				expect(first.runs_upserted).toBe(1);
				expect(first.steps_upserted).toBe(1);
				expect(first.plans).toContain("alpha");

				const run = getRunV1(db, "run_alpha");
				expect(run).not.toBeNull();
				expect(run?.status).toBe("active");
				const steps = getSteps(db, "run_alpha");
				expect(steps).toHaveLength(1);
				expect(steps[0]?.session_id).toBeNull();
				expect(steps[0]?.log_path).toBeNull();
				expect(steps[0]?.step_name).toBe("author:impl");
				expect(JSON.parse(steps[0]?.result_json ?? "{}")).toEqual({
					ok: true,
					step: "author:impl",
				});
				const row = steps[0] as unknown as Record<string, unknown>;
				expect(row.origin).toBeUndefined();
				expect(row.provenance).toBeUndefined();

				const second = await rebuildRecordsIndex({
					db,
					workdir: dir,
					config,
					resolve: resolvePlanProgress,
				});
				expect(second.runs_upserted).toBe(0);
				expect(second.steps_upserted).toBe(0);
			} finally {
				closeOwned(db);
			}
		});
	});

	test("does not overwrite existing result_json; keeps newer local-only steps", async () => {
		await withTmp(async (dir) => {
			initRepo(dir);
			const summary = v1Summary("run_alpha");
			const line = stepLine("run_alpha", "author:impl");
			writeRecords(dir, summary, [line]);
			commitAll(dir, "records");
			const db = openOwnedDb(dir);
			try {
				createRunV1(db, {
					id: "run_alpha",
					planPath: join(dir, "docs/development/alpha.md"),
				});
				recordStep(db, {
					run_id: "run_alpha",
					step_name: "author:impl",
					phase: "1",
					iteration: 1,
					result_json: JSON.stringify({ kept: true }),
				});
				recordStep(db, {
					run_id: "run_alpha",
					step_name: "local:inflight",
					phase: "1",
					iteration: 1,
					result_json: JSON.stringify({ local: true }),
				});
				db.query("UPDATE steps SET created_at = ?1 WHERE step_name = ?2").run(
					"2026-09-02 12:00:00",
					"local:inflight",
				);

				const { config } = await loadConfig(dir, undefined, undefined, dir);
				const result = await rebuildRecordsIndex({
					db,
					workdir: dir,
					config,
					resolve: resolvePlanProgress,
				});
				expect(result.steps_upserted).toBe(0);
				expect(result.steps_skipped_newer_local).toBe(1);

				const steps = getSteps(db, "run_alpha");
				const recorded = steps.find((s) => s.step_name === "author:impl");
				expect(JSON.parse(recorded?.result_json ?? "{}")).toEqual({
					kept: true,
				});
				expect(steps.some((s) => s.step_name === "local:inflight")).toBe(true);
			} finally {
				closeOwned(db);
			}
		});
	});

	test("backfilled run.json creator null stays unknown; SQLite has no origin", async () => {
		await withTmp(async (dir) => {
			initRepo(dir);
			const summary = v1Summary("run_backfill", {
				creator: null,
				sealer: null,
				status: "completed",
				sealed_at: "2026-09-01 13:00:00",
				materializer: EXPORTER,
			});
			const line: RecordLine = {
				...stepLine("run_backfill", "author:impl"),
				runId: "run_backfill",
				provenance: "backfilled",
				origin: null,
				materializer: EXPORTER,
			};
			writeRecords(dir, summary, [line]);
			commitAll(dir, "backfill");
			const db = openOwnedDb(dir);
			try {
				const { config } = await loadConfig(dir, undefined, undefined, dir);
				await rebuildRecordsIndex({
					db,
					workdir: dir,
					config,
					resolve: resolvePlanProgress,
				});

				const run = getRunV1(db, "run_backfill");
				expect(run?.status).toBe("completed");
				const onDisk = JSON.parse(
					readFileSync(
						join(dir, "docs/development/runs/alpha/run_backfill/run.json"),
						"utf8",
					),
				) as { creator: unknown; sealer: unknown; materializer: unknown };
				expect(onDisk.creator).toBeNull();
				expect(onDisk.sealer).toBeNull();
				expect(onDisk.materializer).toBeTruthy();
				const step = getSteps(db, "run_backfill")[0];
				expect(step?.session_id).toBeNull();
				expect(
					(step as unknown as Record<string, unknown>).origin,
				).toBeUndefined();
			} finally {
				closeOwned(db);
			}
		});
	});

	test("--plan slug limits indexing to one plan", async () => {
		await withTmp(async (dir) => {
			initRepo(dir);
			writeRecords(dir, v1Summary("run_alpha"), [
				stepLine("run_alpha", "author:impl"),
			]);
			const betaDir = join(dir, "docs/development");
			writeFileSync(
				join(betaDir, "beta.md"),
				"# Beta\n\n## Phase 1: P1\n\n- [ ] task\n",
			);
			const betaRun = join(dir, "docs/development/runs/beta/run_beta");
			mkdirSync(betaRun, { recursive: true });
			writeFileSync(
				join(betaRun, "run.json"),
				encodeRunJson(
					v1Summary("run_beta", { plan_path: "docs/development/beta.md" }),
				),
			);
			writeFileSync(
				join(betaRun, "steps.jsonl"),
				encodeJsonlFile([
					{
						...stepLine("run_beta", "author:impl"),
						runId: "run_beta",
						idempotencyKey: stepIdempotencyKey({
							runId: "run_beta",
							stepName: "author:impl",
							phase: "1",
							iteration: 1,
						}),
					},
				]),
			);
			commitAll(dir, "two plans");
			const db = openOwnedDb(dir);
			try {
				const { config } = await loadConfig(dir, undefined, undefined, dir);
				const result = await rebuildRecordsIndex({
					db,
					workdir: dir,
					config,
					planSlug: "alpha",
					resolve: resolvePlanProgress,
				});
				expect(result.plans).toEqual(["alpha"]);
				expect(getRunV1(db, "run_alpha")).not.toBeNull();
				expect(getRunV1(db, "run_beta")).toBeNull();
			} finally {
				closeOwned(db);
			}
		});
	});
});
