import { describe, expect, test } from "bun:test";
import { hasPriorPlanReviewerStep } from "../../../src/commands/review-budget-context.js";
import { recordedEnvelope } from "../../../src/control-plane/index.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

function appendStep(
	ctx: ReturnType<typeof makeBudgetContext>,
	stepName: string,
	phase: string,
): void {
	ctx.recordStore.append({
		runId: "run1",
		stream: "steps",
		idempotencyKey: `step:${stepName}:${phase}`,
		payload: {
			step_name: stepName,
			phase,
			iteration: 1,
			result_json: {},
		},
		createdAt: "2026-01-01 00:00:00",
		...recordedEnvelope(TEST_ORIGIN),
	});
}

function insertStep(
	ctx: ReturnType<typeof makeBudgetContext>,
	stepName: string,
	phase: string,
): void {
	ctx.db.run(
		"INSERT INTO steps(run_id, step_name, phase, iteration, result_json) VALUES ('run1', ?, ?, 1, '{}')",
		[stepName, phase],
	);
}

describe("hasPriorPlanReviewerStep", () => {
	test("detects a plan-reviewer step in the SQLite index", () => {
		const ctx = makeBudgetContext();
		insertStep(ctx, "reviewer:review", "plan");
		expect(hasPriorPlanReviewerStep(ctx, "run1")).toBe(true);
		ctx.db.close();
	});

	test("detects an authoritative record-only step when the index is empty", () => {
		const ctx = makeBudgetContext();
		appendStep(ctx, "reviewer:review", "plan");
		expect(hasPriorPlanReviewerStep(ctx, "run1")).toBe(true);
		ctx.db.close();
	});

	test("accepts custom reviewer-prefixed step names", () => {
		const ctx = makeBudgetContext();
		insertStep(ctx, "reviewer:plan-review-custom", "plan");
		expect(hasPriorPlanReviewerStep(ctx, "run1")).toBe(true);
		ctx.db.close();
	});

	test("rejects non-plan reviewer and plan-phase author steps on both paths", () => {
		const ctx = makeBudgetContext();
		insertStep(ctx, "reviewer:review", "phase-1");
		appendStep(ctx, "author:implement", "plan");
		expect(hasPriorPlanReviewerStep(ctx, "run1")).toBe(false);
		ctx.db.close();
	});
});
