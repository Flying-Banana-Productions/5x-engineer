import { describe, expect, test } from "bun:test";
import {
	finalizeAndWritePreparedStep,
	prepareRecordStepAppend,
} from "../../../src/commands/run-v1.handler.js";
import { getRunV1 } from "../../../src/db/operations-v1.js";
import { makeBudgetContext } from "./review-budget-test-helpers.js";

async function prepared(
	ctx: ReturnType<typeof makeBudgetContext>,
	iteration: number | undefined,
) {
	const outcome = await prepareRecordStepAppend(
		{
			run: "run1",
			stepName: "reviewer:review",
			phase: "plan",
			iteration,
			result: "{}",
			performer: { kind: "agent", role: "reviewer" },
		},
		ctx,
	);
	return outcome.prepared;
}

function writeContext(ctx: ReturnType<typeof makeBudgetContext>) {
	const run = getRunV1(ctx.db, "run1");
	if (!run) throw new Error("missing run");
	return {
		db: ctx.db,
		config: ctx.config,
		recordStore: ctx.recordStore,
		originFor: ctx.originFor,
		run,
	};
}

describe("finalizeAndWritePreparedStep", () => {
	test("generic mode keeps atomicAppend and human-style extra-op semantics", async () => {
		const ctx = makeBudgetContext();
		let genericCalls = 0;
		let pairedCalls = 0;
		const generic = ctx.recordStore.atomicAppend.bind(ctx.recordStore);
		ctx.recordStore.atomicAppend = (ops) => {
			genericCalls++;
			return generic(ops);
		};
		const paired = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			pairedCalls++;
			return paired(ops);
		};
		await finalizeAndWritePreparedStep(
			await prepared(ctx, 1),
			writeContext(ctx),
			{
				mode: "generic",
				extraOps: (step, envelope) => [
					{
						runId: step.runId,
						stream: "decisions",
						idempotencyKey: `decision:${step.iteration}`,
						payload: { iteration: step.iteration },
						...envelope,
					},
				],
			},
		);
		expect(genericCalls).toBe(1);
		expect(pairedCalls).toBe(0);
		expect(ctx.recordStore.listLines("run1", "decisions")).toHaveLength(1);
		ctx.db.close();
	});

	test("paired mode never calls general atomicAppend", async () => {
		const ctx = makeBudgetContext();
		let genericCalls = 0;
		let pairedCalls = 0;
		const generic = ctx.recordStore.atomicAppend.bind(ctx.recordStore);
		ctx.recordStore.atomicAppend = (ops) => {
			genericCalls++;
			return generic(ops);
		};
		const paired = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			pairedCalls++;
			return paired(ops);
		};
		await finalizeAndWritePreparedStep(
			await prepared(ctx, 1),
			writeContext(ctx),
			{ mode: "paired-all-new" },
		);
		expect(genericCalls).toBe(0);
		expect(pairedCalls).toBe(1);
		ctx.db.close();
	});

	test("specified-iteration collision does not retry allocate", async () => {
		const ctx = makeBudgetContext();
		const firstPrepared = await prepared(ctx, 1);
		await finalizeAndWritePreparedStep(firstPrepared, writeContext(ctx), {
			mode: "paired-all-new",
		});
		let calls = 0;
		const paired = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			calls++;
			return paired(ops);
		};
		const result = await finalizeAndWritePreparedStep(
			firstPrepared,
			writeContext(ctx),
			{ mode: "paired-all-new" },
		);
		expect(result.outcome).toBe("written");
		if (result.outcome !== "written")
			throw new Error("expected written result");
		expect(result.recorded).toBe(false);
		expect(result.finalized.iteration).toBe(1);
		expect(calls).toBe(1);
		ctx.db.close();
	});

	test("omitted-iteration retry is bounded by remaining room", async () => {
		const ctx = makeBudgetContext({ maxSteps: 3 });
		const paired = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		let calls = 0;
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			calls++;
			const step = ops[0];
			if (!step) throw new Error("missing step");
			ctx.recordStore.append({
				...step,
				payload: {
					...(step.payload as object),
					result_json: { winner: calls },
				},
			});
			return paired(ops);
		};
		await expect(
			finalizeAndWritePreparedStep(
				await prepared(ctx, undefined),
				writeContext(ctx),
				{ mode: "paired-all-new" },
			),
		).rejects.toMatchObject({ code: "RECORD_ITERATION_RETRY_EXHAUSTED" });
		expect(calls).toBe(3);
		ctx.db.close();
	});

	test("paired extra-key collision returns coupled-key-exists before iteration retry", async () => {
		const ctx = makeBudgetContext();
		ctx.recordStore.append({
			runId: "run1",
			stream: "decisions",
			idempotencyKey: "decision:gate",
			payload: { winner: true },
			schemaVersion: 1,
			provenance: "recorded",
			origin: ctx.originFor({ kind: "human" }),
		});
		const result = await finalizeAndWritePreparedStep(
			await prepared(ctx, undefined),
			writeContext(ctx),
			{
				mode: "paired-all-new",
				extraOps: (_step, envelope) => [
					{
						runId: "run1",
						stream: "decisions",
						idempotencyKey: "decision:gate",
						payload: { winner: false },
						...envelope,
					},
				],
			},
		);
		expect(result.outcome).toBe("coupled-key-exists");
		if (result.outcome === "coupled-key-exists") {
			expect(result.key).toBe("decision:gate");
			expect(result.line.payload).toEqual({ winner: true });
		}
		expect(ctx.recordStore.listLines("run1", "steps")).toHaveLength(0);
		ctx.db.close();
	});
});
