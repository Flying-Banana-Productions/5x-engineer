/**
 * Unit tests for step-budget visibility (203 phase 3).
 *
 * Covers threshold helpers, `run state` budget fields at 0 steps,
 * post-insert `total_steps` (including idempotent re-records), and
 * MAX_STEPS_EXCEEDED remediation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeStepBudget,
	formatStateText,
	RecordError,
	recordStepInternal,
	STEP_WARNING_RATIO,
	stepBudgetWarning,
} from "../../../src/commands/run-v1.handler.js";
import { FiveXConfigSchema } from "../../../src/config.js";
import { _resetForTest, closeDb, getDb } from "../../../src/db/connection.js";
import { createRunV1 } from "../../../src/db/operations-v1.js";
import { runMigrations } from "../../../src/db/schema.js";

describe("computeStepBudget", () => {
	test("remaining is max - used", () => {
		expect(computeStepBudget(0, 250)).toEqual({
			used: 0,
			max: 250,
			remaining: 250,
		});
		expect(computeStepBudget(200, 250)).toEqual({
			used: 200,
			max: 250,
			remaining: 50,
		});
	});

	test("remaining is floored at 0 when used exceeds max", () => {
		expect(computeStepBudget(300, 250).remaining).toBe(0);
	});
});

describe("stepBudgetWarning", () => {
	test("threshold is 80%", () => {
		expect(STEP_WARNING_RATIO).toBe(0.8);
	});

	test("199/250 is silent", () => {
		expect(stepBudgetWarning(computeStepBudget(199, 250))).toBeUndefined();
	});

	test("200/250 warns", () => {
		const warning = stepBudgetWarning(computeStepBudget(200, 250));
		expect(warning).toBe(
			"Approaching maxStepsPerRun (200/250); raise maxStepsPerRun or split the work.",
		);
	});

	test("at max still warns (record succeeds only below the ceiling)", () => {
		const warning = stepBudgetWarning(computeStepBudget(250, 250));
		expect(warning).toContain("250/250");
	});

	test("max <= 0 is silent", () => {
		expect(stepBudgetWarning(computeStepBudget(1, 0))).toBeUndefined();
		expect(stepBudgetWarning(computeStepBudget(1, -10))).toBeUndefined();
	});
});

describe("formatStateText", () => {
	test("prints budget fields even at 0 steps", () => {
		const lines: string[] = [];
		const orig = console.log;
		console.log = (...args: unknown[]) => {
			lines.push(String(args[0] ?? ""));
		};
		try {
			formatStateText({
				run: {
					id: "run_abc",
					plan_path: "/tmp/plan.md",
					status: "active",
					created_at: "2026-08-18T00:00:00.000Z",
					updated_at: "2026-08-18T00:00:00.000Z",
				},
				steps: [],
				summary: {
					total_steps: 0,
					phases_completed: [],
					total_tokens_in: 0,
					total_tokens_out: 0,
					total_cost_usd: 0,
					total_duration_ms: 0,
				},
				steps_used: 0,
				max_steps: 250,
				steps_remaining: 250,
			});
		} finally {
			console.log = orig;
		}
		expect(
			lines.some((l) => l.includes("Steps:   0 / 250 (250 remaining)")),
		).toBe(true);
	});
});

describe("recordStepInternal step budget", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "5x-step-budget-"));
		const db = getDb(tmp);
		runMigrations(db);
		createRunV1(db, { id: "run1", planPath: join(tmp, "plan.md") });
	});

	afterEach(() => {
		closeDb();
		_resetForTest();
		rmSync(tmp, { recursive: true, force: true });
	});

	function dbContext(maxStepsPerRun = 250) {
		return {
			db: getDb(tmp),
			config: FiveXConfigSchema.parse({ maxStepsPerRun }),
		};
	}

	test("returns total_steps after insert", async () => {
		const result = await recordStepInternal(
			{ run: "run1", stepName: "s1", result: "{}" },
			dbContext(),
		);
		expect(result.recorded).toBe(true);
		expect(result.total_steps).toBe(1);
		expect(result.max_steps).toBe(250);
	});

	test("idempotent re-record reports the true count (does not false-trigger)", async () => {
		const first = await recordStepInternal(
			{
				run: "run1",
				stepName: "author:impl:status",
				phase: "1",
				iteration: 1,
				result: '{"ok":true}',
			},
			dbContext(),
		);
		expect(first.recorded).toBe(true);
		expect(first.total_steps).toBe(1);

		const second = await recordStepInternal(
			{
				run: "run1",
				stepName: "author:impl:status",
				phase: "1",
				iteration: 1,
				result: '{"ok":true}',
			},
			dbContext(),
		);
		expect(second.recorded).toBe(false);
		expect(second.total_steps).toBe(1);
		expect(
			stepBudgetWarning(computeStepBudget(second.total_steps, 250)),
		).toBeUndefined();
	});

	test("199 used of 250 stays below the warning band; 200 crosses it", async () => {
		const ctx = dbContext(250);
		const db = ctx.db;
		for (let i = 0; i < 198; i++) {
			db.exec(
				`INSERT INTO steps (run_id, step_name, iteration, result_json)
				 VALUES ('run1', 'step-${i}', 1, '{}')`,
			);
		}

		const at199 = await recordStepInternal(
			{ run: "run1", stepName: "step-198", result: "{}" },
			ctx,
		);
		expect(at199.total_steps).toBe(199);
		expect(
			stepBudgetWarning(computeStepBudget(at199.total_steps, at199.max_steps)),
		).toBeUndefined();

		const at200 = await recordStepInternal(
			{ run: "run1", stepName: "step-199", result: "{}" },
			ctx,
		);
		expect(at200.total_steps).toBe(200);
		expect(
			stepBudgetWarning(computeStepBudget(at200.total_steps, at200.max_steps)),
		).toBeDefined();
	});

	test("MAX_STEPS_EXCEEDED detail includes remediation", async () => {
		const ctx = dbContext(3);
		const db = ctx.db;
		for (let i = 0; i < 3; i++) {
			db.exec(
				`INSERT INTO steps (run_id, step_name, iteration, result_json)
				 VALUES ('run1', 'step-${i}', 1, '{}')`,
			);
		}

		let caught: RecordError | undefined;
		try {
			await recordStepInternal(
				{ run: "run1", stepName: "overflow", result: "{}" },
				ctx,
			);
		} catch (err) {
			if (err instanceof RecordError) caught = err;
			else throw err;
		}
		expect(caught).toBeDefined();
		expect(caught?.code).toBe("MAX_STEPS_EXCEEDED");
		const detail = caught?.detail as Record<string, unknown>;
		expect(detail.current_steps).toBe(3);
		expect(detail.max_steps).toBe(3);
		expect(String(detail.remediation)).toContain("Raise maxStepsPerRun");
		expect(String(detail.remediation)).toContain(
			"5x config set maxStepsPerRun",
		);
		expect(String(detail.remediation)).toContain("split the work");
	});
});
