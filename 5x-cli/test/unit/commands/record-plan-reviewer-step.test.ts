import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { recordPlanReviewerStepWithSnapshot } from "../../../src/commands/review-budget-context.js";
import { recordStepInternal } from "../../../src/commands/run-v1.handler.js";
import { createSqlitePromptStore } from "../../../src/control-plane/index.js";
import { snapshotIdempotencyKey } from "../../../src/review-budget/record-lines.js";
import {
	makeBudgetContext,
	pendingSnapshot,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

const params = {
	run: "run1",
	stepName: "reviewer:review",
	result: JSON.stringify({ readiness: "ready", items: [] }),
	phase: "plan",
	iteration: 1,
	performer: {
		kind: "agent" as const,
		role: "reviewer",
		provider: "cursor",
	},
};

describe("recordPlanReviewerStepWithSnapshot", () => {
	function gateSnapshot(mode: "advisory" | "enforced") {
		return {
			...pendingSnapshot(),
			mode,
			effectiveGateCauses: [
				{ kind: "budget_band" as const, band: "over_effective" as const },
			],
		};
	}

	function captureBaseline(
		ctx: ReturnType<typeof makeBudgetContext>,
		mode: "advisory" | "enforced",
	): void {
		const pending = pendingSnapshot();
		ctx.store.captureBaseline({
			runId: "run1",
			captureKind: "initial",
			mode,
			parsed: pending.currentLedger,
			configSnapshot: pending.derived.thresholds,
			origin: TEST_ORIGIN,
		});
	}

	test("writes exactly one coupled pair with the same origin", async () => {
		const performers: unknown[] = [];
		const ctx = makeBudgetContext({
			originFor: (performer) => {
				performers.push(performer);
				return { ...TEST_ORIGIN, performer };
			},
		});
		const result = await recordPlanReviewerStepWithSnapshot(
			params,
			pendingSnapshot(),
			ctx,
		);
		expect(result.recorded).toBe(true);
		const steps = ctx.recordStore.listLines("run1", "steps");
		const budget = ctx.recordStore.listLines("run1", "budget");
		expect(steps).toHaveLength(1);
		expect(budget).toHaveLength(1);
		expect(steps[0]?.origin).toEqual(budget[0]?.origin);
		expect(performers).toContainEqual(params.performer);
		expect(ctx.store.latestSnapshot("run1")?.baselineAssessment).toEqual(
			pendingSnapshot().baselineAssessment,
		);
		ctx.db.close();
	});

	for (const [name, mutate, code] of [
		[
			"terminal run",
			(ctx: ReturnType<typeof makeBudgetContext>) =>
				ctx.db.run("UPDATE runs SET status='completed'"),
			"RUN_NOT_ACTIVE",
		],
		["invalid JSON", () => {}, "INVALID_JSON"],
	] as const) {
		test(`${name} performs no store append`, async () => {
			const ctx = makeBudgetContext();
			mutate(ctx);
			let calls = 0;
			const original = ctx.recordStore.atomicAppendIfAllNew.bind(
				ctx.recordStore,
			);
			ctx.recordStore.atomicAppendIfAllNew = (ops) => {
				calls++;
				return original(ops);
			};
			const input =
				code === "INVALID_JSON" ? { ...params, result: "{" } : params;
			await expect(
				recordPlanReviewerStepWithSnapshot(input, pendingSnapshot(), ctx),
			).rejects.toMatchObject({ code });
			expect(calls).toBe(0);
			expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(0);
			expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(0);
			ctx.db.close();
		});
	}

	test("new step at the ceiling performs no append", async () => {
		const ctx = makeBudgetContext({ maxSteps: 1 });
		ctx.db.run(
			"INSERT INTO steps(run_id, step_name, phase, iteration, result_json) VALUES ('run1','old','plan',1,'{}')",
		);
		let calls = 0;
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			calls++;
			return original(ops);
		};
		await expect(
			recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx),
		).rejects.toMatchObject({ code: "MAX_STEPS_EXCEEDED" });
		expect(calls).toBe(0);
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(0);
		ctx.db.close();
	});

	test("missing mapped worktree performs no append", async () => {
		const ctx = makeBudgetContext();
		const run = ctx.db
			.query("SELECT plan_path FROM runs WHERE id='run1'")
			.get() as {
			plan_path: string;
		};
		ctx.db
			.query(
				"INSERT INTO plans(plan_path, worktree_path) VALUES(?1,'/tmp/definitely-missing-5x-worktree') ON CONFLICT(plan_path) DO UPDATE SET worktree_path=excluded.worktree_path",
			)
			.run(run.plan_path);
		ctx.controlPlane = {
			controlPlaneRoot: dirname(run.plan_path),
			stateDir: ".5x",
			mode: "managed",
		};
		let calls = 0;
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			calls++;
			return original(ops);
		};
		await expect(
			recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx),
		).rejects.toMatchObject({ code: "WORKTREE_MISSING" });
		expect(calls).toBe(0);
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(0);
		ctx.db.close();
	});

	test("duplicate pair repairs both projections without appending", async () => {
		const ctx = makeBudgetContext({ maxSteps: 1 });
		await recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx);
		ctx.db.run("DELETE FROM steps");
		ctx.db.run("DELETE FROM review_budget_snapshots");
		let calls = 0;
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			calls++;
			return original(ops);
		};
		const result = await recordPlanReviewerStepWithSnapshot(
			params,
			pendingSnapshot(),
			ctx,
		);
		expect(result.recorded).toBe(false);
		expect(calls).toBe(0);
		expect(ctx.db.query("SELECT count(*) AS n FROM steps").get()).toEqual({
			n: 1,
		});
		expect(
			ctx.db.query("SELECT count(*) AS n FROM review_budget_snapshots").get(),
		).toEqual({ n: 1 });
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(1);
		ctx.db.close();
	});

	test("enforced record opens a gate prompt and duplicate repairs it without duplicate records", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		captureBaseline(ctx, "enforced");
		const pending = gateSnapshot("enforced");
		const promptStore = createSqlitePromptStore(ctx.db);
		await recordPlanReviewerStepWithSnapshot(params, pending, ctx);
		expect(promptStore.listOpenPrompts("run1")).toHaveLength(1);
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(1);
		expect(ctx.store.listSnapshots("run1")).toHaveLength(1);

		ctx.db.run("DELETE FROM prompts");
		expect(promptStore.listOpenPrompts("run1")).toHaveLength(0);
		const retry = await recordPlanReviewerStepWithSnapshot(
			params,
			pending,
			ctx,
		);
		expect(retry.recorded).toBe(false);
		expect(promptStore.listOpenPrompts("run1")).toHaveLength(1);
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(1);
		expect(ctx.store.listSnapshots("run1")).toHaveLength(1);
		ctx.db.close();
	});

	test("advisory record with the same gate causes opens no prompt", async () => {
		const ctx = makeBudgetContext({ mode: "advisory" });
		captureBaseline(ctx, "advisory");
		await recordPlanReviewerStepWithSnapshot(
			params,
			gateSnapshot("advisory"),
			ctx,
		);
		expect(createSqlitePromptStore(ctx.db).listOpenPrompts("run1")).toEqual([]);
		ctx.db.close();
	});

	test("pre-existing step without snapshot remains snapshot-less", async () => {
		const ctx = makeBudgetContext();
		await recordStepInternal(params, ctx);
		ctx.db.run("DELETE FROM steps");
		const result = await recordPlanReviewerStepWithSnapshot(
			params,
			pendingSnapshot(),
			ctx,
		);
		expect(result.recorded).toBe(false);
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(0);
		expect(ctx.db.query("SELECT count(*) AS n FROM steps").get()).toEqual({
			n: 1,
		});
		ctx.db.close();
	});

	test("SQLite-only duplicate at the ceiling is a no-op", async () => {
		const ctx = makeBudgetContext({ maxSteps: 1 });
		ctx.db.run(
			"INSERT INTO steps(run_id, step_name, phase, iteration, result_json) VALUES ('run1','reviewer:review','plan',1,'{}')",
		);
		let calls = 0;
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			calls++;
			return original(ops);
		};
		const result = await recordPlanReviewerStepWithSnapshot(
			params,
			pendingSnapshot(),
			ctx,
		);
		expect(result.recorded).toBe(false);
		expect(calls).toBe(0);
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(0);
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(0);
		ctx.db.close();
	});

	test("omitted iteration creates N then N+1, while specified retry is a no-op", async () => {
		const ctx = makeBudgetContext();
		const omitted = { ...params, iteration: undefined };
		const first = await recordPlanReviewerStepWithSnapshot(
			omitted,
			pendingSnapshot(),
			ctx,
		);
		const second = await recordPlanReviewerStepWithSnapshot(
			omitted,
			pendingSnapshot(2),
			ctx,
		);
		expect([first.iteration, second.iteration]).toEqual([1, 2]);
		const retry = await recordPlanReviewerStepWithSnapshot(
			{ ...params, iteration: first.iteration ?? 1 },
			pendingSnapshot(first.iteration ?? 1),
			ctx,
		);
		expect(retry.recorded).toBe(false);
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(2);
		ctx.db.close();
	});

	test("omitted-iteration lost race retries without attaching to the winner", async () => {
		const ctx = makeBudgetContext();
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		let raced = false;
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			if (!raced) {
				raced = true;
				const step = ops[0];
				if (!step) throw new Error("missing step op");
				ctx.recordStore.append({
					...step,
					payload: {
						...(step.payload as object),
						result_json: { winner: true },
					},
				});
			}
			return original(ops);
		};
		const result = await recordPlanReviewerStepWithSnapshot(
			{ ...params, iteration: undefined },
			pendingSnapshot(),
			ctx,
		);
		expect(result.iteration).toBe(2);
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(2);
		expect(ctx.recordStore.listLines("run1", "budget")).toHaveLength(1);
		const winnerSnapshot = snapshotIdempotencyKey("run1", {
			stepName: params.stepName,
			phase: "plan",
			iteration: 1,
		});
		expect(
			ctx.recordStore.getLine("run1", "budget", winnerSnapshot),
		).toBeNull();
		ctx.db.close();
	});

	test("redacted origin is shared by both operations", async () => {
		const redacted = {
			recorder: { installation_id: TEST_ORIGIN.recorder.installation_id },
			performer: params.performer,
		};
		const ctx = makeBudgetContext({ originFor: () => redacted });
		await recordPlanReviewerStepWithSnapshot(params, pendingSnapshot(), ctx);
		for (const line of [
			...ctx.recordStore.listLines("run1", "steps"),
			...ctx.recordStore.listLines("run1", "budget"),
		]) {
			expect(line.origin).toEqual(redacted);
			expect(line.origin?.recorder.actor).toBeUndefined();
		}
		ctx.db.close();
	});
});
