/**
 * Unit tests for prepareRecordStepAppend and dual-write recordStepInternal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	prepareRecordStepAppend,
	RecordError,
	recordStepInternal,
} from "../../../src/commands/run-v1.handler.js";
import { FiveXConfigSchema } from "../../../src/config.js";
import type {
	RecordOrigin,
	RecordPerformer,
} from "../../../src/control-plane/index.js";
import {
	createMemoryRecordStore,
	RUN_RECORD_FORMAT_VERSION,
	recordedEnvelope,
	stepIdempotencyKey,
} from "../../../src/control-plane/index.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import {
	completeRun,
	createRunV1,
	getRunV1,
} from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";

const INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";

function originFor(performer: RecordPerformer): RecordOrigin {
	return {
		recorder: { installation_id: INSTALLATION_ID, actor: "tester" },
		performer,
	};
}

const RECORDER = { installation_id: INSTALLATION_ID, actor: "tester" };

describe("prepareRecordStepAppend", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "5x-prepare-"));
		const db = getDb(tmp);
		runMigrations(db);
		createRunV1(db, { id: "run1", planPath: join(tmp, "plan.md") });
	});

	afterEach(() => {
		closeDb();
		_resetForTest();
		rmSync(tmp, { recursive: true, force: true });
	});

	function ctx(maxStepsPerRun = 250) {
		const store = createMemoryRecordStore();
		store.putRun({
			id: "run1",
			plan_path: join(tmp, "plan.md"),
			config_json: { maxStepsPerRun },
			created_at: "2026-01-01 00:00:00",
			sealed_at: null,
			status: "active",
			final_head_commit: null,
			cli_version: "1.0.0",
			format_version: RUN_RECORD_FORMAT_VERSION,
			creator: RECORDER,
		});
		return {
			db: getDb(tmp),
			config: FiveXConfigSchema.parse({ maxStepsPerRun }),
			recordStore: store,
		};
	}

	test("missing run throws RUN_NOT_FOUND with zero store lines", async () => {
		const c = ctx();
		let caught: RecordError | undefined;
		try {
			await prepareRecordStepAppend(
				{ run: "run_missing", stepName: "s1", result: "{}" },
				c,
			);
		} catch (err) {
			if (err instanceof RecordError) caught = err;
			else throw err;
		}
		expect(caught?.code).toBe("RUN_NOT_FOUND");
	});

	test("terminal run throws RUN_NOT_ACTIVE with zero store lines", async () => {
		const c = ctx();
		completeRun(c.db, "run1", "completed");
		let caught: RecordError | undefined;
		try {
			await prepareRecordStepAppend(
				{ run: "run1", stepName: "s1", result: "{}" },
				c,
			);
		} catch (err) {
			if (err instanceof RecordError) caught = err;
			else throw err;
		}
		expect(caught?.code).toBe("RUN_NOT_ACTIVE");
		expect(c.recordStore.listLines("run1", "steps")).toEqual([]);
	});

	test("invalid JSON throws INVALID_JSON with zero store lines", async () => {
		const c = ctx();
		let caught: RecordError | undefined;
		try {
			await prepareRecordStepAppend(
				{ run: "run1", stepName: "s1", result: "not-json" },
				c,
			);
		} catch (err) {
			if (err instanceof RecordError) caught = err;
			else throw err;
		}
		expect(caught?.code).toBe("INVALID_JSON");
		expect(c.recordStore.listLines("run1", "steps")).toEqual([]);
	});

	test("new unique at limit throws MAX_STEPS_EXCEEDED with zero store lines", async () => {
		const c = ctx(1);
		c.db.exec(
			`INSERT INTO steps (run_id, step_name, iteration, result_json)
			 VALUES ('run1', 'existing', 1, '{}')`,
		);
		let caught: RecordError | undefined;
		try {
			await prepareRecordStepAppend(
				{ run: "run1", stepName: "overflow", result: "{}" },
				c,
			);
		} catch (err) {
			if (err instanceof RecordError) caught = err;
			else throw err;
		}
		expect(caught?.code).toBe("MAX_STEPS_EXCEEDED");
		expect(c.recordStore.listLines("run1", "steps")).toEqual([]);
	});

	test("duplicate at limit is duplicate with zero new lines", async () => {
		const c = ctx(1);
		c.db.exec(
			`INSERT INTO steps (run_id, step_name, phase, iteration, result_json)
			 VALUES ('run1', 'step-0', '1', 1, '{}')`,
		);
		const outcome = await prepareRecordStepAppend(
			{
				run: "run1",
				stepName: "step-0",
				phase: "1",
				iteration: 1,
				result: "{}",
			},
			c,
		);
		expect(outcome.outcome).toBe("duplicate");
		expect(outcome.prepared.performer).toEqual({
			kind: "system",
			role: "cli",
		});
		expect(c.recordStore.listLines("run1", "steps")).toEqual([]);
	});

	test("missing worktree throws WORKTREE_MISSING with zero store lines", async () => {
		const c = ctx();
		const run = getRunV1(c.db, "run1");
		const missingWt = join(
			tmpdir(),
			`5x-missing-prepare-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		c.db
			.query("INSERT INTO plans (plan_path, worktree_path) VALUES (?1, ?2)")
			.run(run?.plan_path ?? join(tmp, "plan.md"), missingWt);
		let caught: RecordError | undefined;
		try {
			await prepareRecordStepAppend(
				{ run: "run1", stepName: "s1", result: "{}" },
				{
					...c,
					controlPlane: {
						controlPlaneRoot: tmp,
						stateDir: ".5x",
						mode: "isolated",
					},
				},
			);
		} catch (err) {
			if (err instanceof RecordError) caught = err;
			else throw err;
		}
		expect(caught?.code).toBe("WORKTREE_MISSING");
		expect(c.recordStore.listLines("run1", "steps")).toEqual([]);
	});

	test("params.performer round-trips onto prepared.performer", async () => {
		const c = ctx();
		const performer = {
			kind: "agent" as const,
			role: "reviewer",
			provider: "opencode",
		};
		const outcome = await prepareRecordStepAppend(
			{
				run: "run1",
				stepName: "reviewer:plan",
				result: "{}",
				performer,
			},
			c,
		);
		expect(outcome.outcome).toBe("admit");
		expect(outcome.prepared.performer).toEqual(performer);
	});

	test("omitted performer on human:* becomes operator", async () => {
		const c = ctx();
		const outcome = await prepareRecordStepAppend(
			{ run: "run1", stepName: "human:approve", result: "{}" },
			c,
		);
		expect(outcome.prepared.performer).toEqual({
			kind: "human",
			role: "operator",
		});
	});

	test("omitted performer on git:commit becomes system/cli", async () => {
		const c = ctx();
		const outcome = await prepareRecordStepAppend(
			{ run: "run1", stepName: "git:commit", result: "{}" },
			c,
		);
		expect(outcome.prepared.performer).toEqual({
			kind: "system",
			role: "cli",
		});
	});
});

describe("recordStepInternal dual-write", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "5x-dual-write-"));
		const db = getDb(tmp);
		runMigrations(db);
		createRunV1(db, { id: "run1", planPath: join(tmp, "plan.md") });
	});

	afterEach(() => {
		closeDb();
		_resetForTest();
		rmSync(tmp, { recursive: true, force: true });
	});

	function writer(maxStepsPerRun = 250) {
		const store = createMemoryRecordStore();
		store.putRun({
			id: "run1",
			plan_path: join(tmp, "plan.md"),
			config_json: { maxStepsPerRun },
			created_at: "2026-01-01 00:00:00",
			sealed_at: null,
			status: "active",
			final_head_commit: null,
			cli_version: "1.0.0",
			format_version: RUN_RECORD_FORMAT_VERSION,
			creator: RECORDER,
		});
		return {
			db: getDb(tmp),
			config: FiveXConfigSchema.parse({ maxStepsPerRun }),
			recordStore: store,
			originFor,
			redactedRecorder: () => RECORDER,
		};
	}

	test("admit writes one steps.jsonl line with origin via originFor", async () => {
		const ctx = writer();
		const result = await recordStepInternal(
			{
				run: "run1",
				stepName: "author:impl:status",
				phase: "1",
				iteration: 1,
				result: '{"ok":true}',
			},
			ctx,
		);
		expect(result.recorded).toBe(true);
		const lines = ctx.recordStore.listLines("run1", "steps");
		expect(lines).toHaveLength(1);
		expect(lines[0]?.provenance).toBe("recorded");
		expect(lines[0]?.origin).toEqual(
			originFor({ kind: "system", role: "cli" }),
		);
		expect(JSON.stringify(lines[0])).not.toContain("session_id");
		expect(JSON.stringify(lines[0])).not.toContain("log_path");
	});

	test("re-record returns recorded false and appends no line", async () => {
		const ctx = writer();
		const params = {
			run: "run1",
			stepName: "author:impl:status",
			phase: "1",
			iteration: 1,
			result: '{"ok":true}',
		};
		await recordStepInternal(params, ctx);
		const second = await recordStepInternal(params, ctx);
		expect(second.recorded).toBe(false);
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(1);
	});

	test("human:* also appends a decisions line with the same origin", async () => {
		const ctx = writer();
		await recordStepInternal(
			{
				run: "run1",
				stepName: "human:approve",
				phase: "1",
				iteration: 1,
				result: '{"ok":true}',
			},
			ctx,
		);
		const steps = ctx.recordStore.listLines("run1", "steps");
		const decisions = ctx.recordStore.listLines("run1", "decisions");
		expect(steps).toHaveLength(1);
		expect(decisions).toHaveLength(1);
		expect(steps[0]?.origin).toEqual(
			originFor({ kind: "human", role: "operator" }),
		);
		expect(decisions[0]?.origin).toEqual(steps[0]?.origin);
	});

	test("mixed [step, budget] atomicAppend via originFor shares origin", () => {
		const ctx = writer();
		const performer: RecordPerformer = {
			kind: "agent",
			role: "reviewer",
			provider: "opencode",
		};
		const origin = ctx.originFor(performer);
		const envelope = recordedEnvelope(origin);
		ctx.recordStore.atomicAppend([
			{
				runId: "run1",
				stream: "steps",
				idempotencyKey: stepIdempotencyKey({
					runId: "run1",
					stepName: "reviewer:plan",
					phase: "1",
					iteration: 1,
				}),
				payload: { step_name: "reviewer:plan" },
				...envelope,
			},
			{
				runId: "run1",
				stream: "budget",
				idempotencyKey: "budget:snapshot:1",
				payload: { remaining: 10 },
				...envelope,
			},
		]);
		const step = ctx.recordStore.listLines("run1", "steps")[0];
		const budget = ctx.recordStore.listLines("run1", "budget")[0];
		expect(step?.origin).toEqual(origin);
		expect(budget?.origin).toEqual(origin);
	});
});
