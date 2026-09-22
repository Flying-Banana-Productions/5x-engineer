import { describe, expect, test } from "bun:test";
import { recordPlanReviewerStepWithSnapshot } from "../../../src/commands/review-budget-context.js";
import {
	createReviewBudgetIndex,
	reindexReviewBudget,
} from "../../../src/control-plane/index.js";
import {
	makeBudgetContext,
	pendingSnapshot,
} from "../commands/review-budget-test-helpers.js";

const params = {
	run: "run1",
	stepName: "reviewer:review",
	result: JSON.stringify({ readiness: "ready", items: [] }),
	phase: "plan",
	iteration: 1,
	performer: { kind: "agent" as const, role: "reviewer" },
};

describe("paired review-budget persistence", () => {
	test("failed unique append leaves no step, snapshot line, or projections", async () => {
		const ctx = makeBudgetContext();
		ctx.recordStore.atomicAppendIfAllNew = () => {
			throw new Error("injected append failure");
		};
		await expect(
			recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx),
		).rejects.toThrow("injected append failure");
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(0);
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(0);
		expect(ctx.db.query("SELECT count(*) AS n FROM steps").get()).toEqual({
			n: 0,
		});
		expect(
			ctx.db.query("SELECT count(*) AS n FROM review_budget_snapshots").get(),
		).toEqual({ n: 0 });
		ctx.db.close();
	});

	test("unique success and complete-tuple retry retain one authoritative snapshot", async () => {
		const ctx = makeBudgetContext();
		await recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx);
		await recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx);
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(1);
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(1);
		expect(ctx.store.latestSnapshot("run1")?.baselineAssessment).toEqual(
			pendingSnapshot().baselineAssessment,
		);
		expect(
			ctx.db.query("SELECT count(*) AS n FROM review_budget_snapshots").get(),
		).toEqual({ n: 1 });
		ctx.db.close();
	});

	test("retry repairs missing SQLite step and snapshot projections", async () => {
		const ctx = makeBudgetContext();
		await recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx);
		ctx.db.run("DELETE FROM steps");
		ctx.db.run("DELETE FROM review_budget_snapshots");
		await recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx);
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(1);
		expect(ctx.db.query("SELECT count(*) AS n FROM steps").get()).toEqual({
			n: 1,
		});
		expect(
			ctx.db.query("SELECT count(*) AS n FROM review_budget_snapshots").get(),
		).toEqual({ n: 1 });
		ctx.db.close();
	});

	test("projection failure after durable success is repaired on retry", async () => {
		const ctx = makeBudgetContext();
		const project = ctx.store.projectSnapshot.bind(ctx.store);
		let fail = true;
		ctx.store.projectSnapshot = (...args) => {
			if (fail) {
				fail = false;
				throw new Error("injected index failure");
			}
			return project(...args);
		};
		await expect(
			recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx),
		).rejects.toThrow("injected index failure");
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(1);
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(1);
		ctx.db.run("DELETE FROM steps");
		await recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx);
		expect(ctx.db.query("SELECT count(*) AS n FROM steps").get()).toEqual({
			n: 1,
		});
		expect(
			ctx.db.query("SELECT count(*) AS n FROM review_budget_snapshots").get(),
		).toEqual({ n: 1 });
		ctx.db.close();
	});

	test("reindex restores the first baseline assessment from the record", async () => {
		const ctx = makeBudgetContext();
		await recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx);
		ctx.db.run("DELETE FROM review_budget_snapshots");
		const index = createReviewBudgetIndex(ctx.db);
		reindexReviewBudget(ctx.recordStore, index, "run1");
		expect(index.latestSnapshot("run1")?.baselineAssessment).toEqual(
			pendingSnapshot().baselineAssessment,
		);
		ctx.db.close();
	});
});
