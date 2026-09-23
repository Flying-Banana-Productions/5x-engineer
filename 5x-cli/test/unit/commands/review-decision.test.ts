import { describe, expect, test } from "bun:test";
import {
	showPlanReviewGate,
	submitPlanReviewDecision,
} from "../../../src/commands/review-decision.handler.js";
import {
	createMemoryPromptStore,
	recordedEnvelope,
	waitForReviewGateDecision,
} from "../../../src/control-plane/index.js";
import { CliError } from "../../../src/output.js";
import { deriveBudget } from "../../../src/review-budget/arithmetic.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	foldGoverningReviewState,
	type ReviewDecisionPayload,
} from "../../../src/review-governance/decisions.js";
import { reindexReviewGovernance } from "../../../src/review-governance/sqlite-index.js";
import { createReviewGovernanceStore } from "../../../src/review-governance/store.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

function fixture(opts?: { maxSteps?: number }) {
	const ctx = makeBudgetContext({ maxSteps: opts?.maxSteps });
	const promptStore = createMemoryPromptStore();
	const ledger = {
		estimateConfidence: "high" as const,
		workItems: [
			{
				id: "W1",
				title: "work",
				effort: 2 as const,
				architectureDelta: 0 as const,
				debtClaim: null,
				addresses: [],
				rationale: "required",
				line: 1,
			},
		],
		surface: {
			subsystems: 1,
			productionFiles: 1,
			persistentOrExternalBoundaries: 0,
		},
	};
	ctx.store.captureBaseline({
		runId: "run1",
		captureKind: "initial",
		mode: "enforced",
		parsed: ledger,
		configSnapshot: DEFAULT_REVIEW_BUDGET_CONFIG,
		origin: TEST_ORIGIN,
	});
	const budget = deriveBudget({
		B0: 2,
		B: 2,
		I: 5,
		workItems: ledger.workItems,
		findings: [],
		assessments: [],
		config: DEFAULT_REVIEW_BUDGET_CONFIG,
		semanticHumanRequired: false,
	});
	ctx.recordStore.append({
		runId: "run1",
		stream: "steps",
		idempotencyKey: "reviewer",
		payload: {
			step_name: "reviewer:plan",
			phase: "plan",
			iteration: 1,
			result_json: { readiness: "ready", summary: "ok", items: [], budget },
			head_commit: null,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
		},
		...recordedEnvelope(TEST_ORIGIN),
	});
	ctx.store.appendSnapshot({
		runId: "run1",
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
		currentLedger: ledger,
		findings: [],
		assessments: [],
		baselineAssessment: {
			independentEffortEstimate: 5,
			confidence: "high",
			reason: "material disagreement",
		},
		derived: budget,
		effectiveGateCauses: [{ kind: "budget_alert", alert: "baseline_disputed" }],
		origin: TEST_ORIGIN,
	});
	return { ctx, promptStore };
}

function rebuiltAcceptance(ctx: ReturnType<typeof fixture>["ctx"]): string[] {
	const liveState = createReviewGovernanceStore(
		ctx.recordStore,
	).deriveGoverningState("run1", 2);
	ctx.db.exec(
		"DELETE FROM review_decision_index; DELETE FROM review_gate_index",
	);
	reindexReviewGovernance(ctx.recordStore, ctx.db, "run1");
	const rows = ctx.db
		.query(
			"SELECT acceptance, payload_json FROM review_decision_index WHERE run_id = ? ORDER BY record_seq",
		)
		.all("run1") as Array<{ acceptance: string; payload_json: string }>;
	const rebuiltState = foldGoverningReviewState({
		b0: 2,
		decisions: rows.map(
			(row) => JSON.parse(row.payload_json) as ReviewDecisionPayload,
		),
		steps: ctx.recordStore.listLines("run1", "steps"),
		budget: ctx.recordStore.listLines("run1", "budget"),
	});
	expect(rebuiltState).toEqual(liveState);
	return rows.map((row) => row.acceptance);
}

describe("review decision action", () => {
	test("show creates a typed notification and generic answer is rejected", async () => {
		const { ctx, promptStore } = fixture();
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		expect(shown.open).toBe(true);
		if (!shown.open) throw new Error("expected gate");
		expect(shown.allowedChoices).toContain("retain_baseline");
		const prompt = promptStore.getPrompt(shown.promptId);
		expect(prompt?.context?.type).toBe("plan_review_gate");
		expect(() =>
			promptStore.answerPrompt(
				shown.promptId,
				"retain_baseline",
				"control-plane",
			),
		).toThrow(/5x review decide/);
		expect(ctx.recordStore.listLines("run1", "decisions")).toHaveLength(0);
		ctx.db.close();
	});

	test("records one paired decision, closes notification, waits by decision key, and retries idempotently", async () => {
		const { ctx, promptStore } = fixture({ maxSteps: 2 });
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		const input = {
			runId: "run1",
			gateId: shown.gateId,
			payload: {
				choice: "retain_baseline" as const,
				rationale: "Original estimate is authoritative",
			},
		};
		const first = await submitPlanReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		expect(first.created).toBe(true);
		expect(first.route).toBe("complete");
		expect(promptStore.getPrompt(shown.promptId)?.answer).toBe(
			first.decision.decisionId,
		);
		const waited = await waitForReviewGateDecision(
			ctx.recordStore,
			"run1",
			shown.gateId,
			{
				timeoutMs: 10,
			},
		);
		expect(waited.payload).toHaveProperty(
			"decisionId",
			first.decision.decisionId,
		);
		const retry = await submitPlanReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		expect(retry.created).toBe(false);
		expect(retry.decision.decisionId).toBe(first.decision.decisionId);
		expect(ctx.recordStore.listLines("run1", "decisions")).toHaveLength(1);
		expect(
			ctx.recordStore
				.listLines("run1", "steps")
				.filter(
					(line) =>
						(line.payload as { step_name?: string }).step_name ===
						"human:review-governance",
				),
		).toHaveLength(1);
		ctx.db.close();
	});

	test("after-winner loser allocated at N+1 observes the coupled winner", async () => {
		const { ctx, promptStore } = fixture({ maxSteps: 4 });
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		const input = {
			runId: "run1",
			gateId: shown.gateId,
			payload: { choice: "retain_baseline" as const, rationale: "retain" },
		};
		const winner = await submitPlanReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		const decisionKey = `decision:review-gate:${shown.gateId}`;
		const originalGetLine = ctx.recordStore.getLine.bind(ctx.recordStore);
		let hiddenReads = 0;
		ctx.recordStore.getLine = (runId, stream, key) => {
			if (
				runId === "run1" &&
				stream === "decisions" &&
				key === decisionKey &&
				hiddenReads++ < 2
			)
				return null;
			return originalGetLine(runId, stream, key);
		};
		const originalAtomic = ctx.recordStore.atomicAppendIfAllNew.bind(
			ctx.recordStore,
		);
		let attemptedIteration: number | undefined;
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			attemptedIteration = (
				ops[0]?.payload as { iteration?: number } | undefined
			)?.iteration;
			return originalAtomic(ops);
		};
		const loser = await submitPlanReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		expect(loser.created).toBe(false);
		expect(loser.decision.decisionId).toBe(winner.decision.decisionId);
		expect(attemptedIteration).toBe(2);
		expect(
			ctx.recordStore
				.listLines("run1", "steps")
				.filter(
					(line) =>
						(line.payload as { step_name?: string }).step_name ===
						"human:review-governance",
				),
		).toHaveLength(1);
		ctx.db.close();
	});

	test("authoritative records survive a lost SQLite index write and rebuild", async () => {
		const { ctx, promptStore } = fixture();
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		const input = {
			runId: "run1",
			gateId: shown.gateId,
			payload: { choice: "retain_baseline" as const, rationale: "retain" },
		};
		const winner = await submitPlanReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		ctx.db.exec(
			"DELETE FROM review_decision_index; DELETE FROM review_gate_index",
		);
		const retry = await submitPlanReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		expect(retry.decision.decisionId).toBe(winner.decision.decisionId);
		expect(retry.created).toBe(false);
		expect(rebuiltAcceptance(ctx)).toEqual(["accepted"]);
		ctx.db.close();
	});

	test("exported action records an authenticated adapter performer", async () => {
		const { ctx, promptStore } = fixture();
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		await submitPlanReviewDecision(
			{
				runId: "run1",
				gateId: shown.gateId,
				payload: { choice: "retain_baseline", rationale: "retain" },
				performer: { kind: "human", role: "dashboard-user" },
			},
			{ context: ctx, promptStore },
		);
		const human = ctx.recordStore
			.listLines("run1", "steps")
			.find(
				(line) =>
					(line.payload as { step_name?: string }).step_name ===
					"human:review-governance",
			);
		expect(human?.origin?.performer).toEqual({
			kind: "human",
			role: "dashboard-user",
		});
		ctx.db.close();
	});

	test("conflicting retry reports the winner", async () => {
		const { ctx, promptStore } = fixture();
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		await submitPlanReviewDecision(
			{
				runId: "run1",
				gateId: shown.gateId,
				payload: { choice: "retain_baseline", rationale: "retain" },
			},
			{ context: ctx, promptStore },
		);
		try {
			await submitPlanReviewDecision(
				{
					runId: "run1",
					gateId: shown.gateId,
					payload: {
						choice: "adjust_baseline",
						rationale: "adjust",
						baseline: 4,
					},
				},
				{ context: ctx, promptStore },
			);
			throw new Error("expected conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(CliError);
			expect((error as CliError).code).toBe("REVIEW_GATE_ALREADY_RESOLVED");
			expect((error as CliError).detail).toHaveProperty(
				"decision.choice",
				"retain_baseline",
			);
		}
		ctx.db.close();
	});

	test("request-author-reestimate retry validates against the pre-winner fold", async () => {
		const { ctx, promptStore } = fixture();
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		const input = {
			runId: "run1",
			gateId: shown.gateId,
			payload: {
				choice: "request_author_reestimate" as const,
				rationale: "author should re-estimate",
			},
		};
		const first = await submitPlanReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		const retry = await submitPlanReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		expect(first.route).toBe("author_revision");
		expect(retry).toMatchObject({
			created: false,
			route: "author_revision",
			decision: { decisionId: first.decision.decisionId },
		});
		ctx.db.close();
	});

	test("accepted abort winner repairs a failed terminal side effect on retry", async () => {
		const { ctx, promptStore } = fixture();
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		const input = {
			runId: "run1",
			gateId: shown.gateId,
			payload: { choice: "abort" as const, rationale: "stop the run" },
		};
		await expect(
			submitPlanReviewDecision(input, {
				context: ctx,
				promptStore,
				abortRun: async () => {
					throw new Error("simulated crash after durable append");
				},
			}),
		).rejects.toThrow("simulated crash");
		expect(ctx.recordStore.getRun("run1")?.status).toBe("active");
		const retry = await submitPlanReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		expect(retry).toMatchObject({ created: false, route: "aborted" });
		expect(ctx.recordStore.getRun("run1")?.status).toBe("aborted");
		expect(promptStore.getPrompt(shown.promptId)?.answer).toBe(
			retry.decision.decisionId,
		);
		ctx.db.close();
	});

	test("reviewer-before-human is stale and leaves notification open", async () => {
		const { ctx, promptStore } = fixture();
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		let injected = false;
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			if (!injected) {
				injected = true;
				ctx.recordStore.append({
					runId: "run1",
					stream: "steps",
					idempotencyKey: "new-reviewer",
					payload: {
						...(ctx.recordStore.listLines("run1", "steps")[0]
							?.payload as object),
						step_name: "reviewer:new",
						iteration: 2,
					},
					...recordedEnvelope(TEST_ORIGIN),
				});
			}
			return original(ops);
		};
		await expect(
			submitPlanReviewDecision(
				{
					runId: "run1",
					gateId: shown.gateId,
					payload: { choice: "retain_baseline", rationale: "retain" },
				},
				{ context: ctx, promptStore },
			),
		).rejects.toMatchObject({ code: "REVIEW_GATE_STALE" });
		expect(promptStore.getPrompt(shown.promptId)?.answer).toBeNull();
		expect(rebuiltAcceptance(ctx)).toEqual(["stale"]);
		ctx.db.close();
	});

	test("stale abort remains audit-only and skips terminal side effects", async () => {
		const { ctx, promptStore } = fixture();
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			ctx.recordStore.append({
				runId: "run1",
				stream: "steps",
				idempotencyKey: "reviewer-before-abort",
				payload: {
					...(ctx.recordStore.listLines("run1", "steps")[0]?.payload as object),
					step_name: "reviewer:before-abort",
					iteration: 2,
				},
				...recordedEnvelope(TEST_ORIGIN),
			});
			ctx.recordStore.atomicAppendIfAllNew = original;
			return original(ops);
		};
		let abortCalls = 0;
		await expect(
			submitPlanReviewDecision(
				{
					runId: "run1",
					gateId: shown.gateId,
					payload: { choice: "abort", rationale: "stop" },
				},
				{
					context: ctx,
					promptStore,
					abortRun: async () => {
						abortCalls++;
					},
				},
			),
		).rejects.toMatchObject({ code: "REVIEW_GATE_STALE" });
		expect(abortCalls).toBe(0);
		expect(promptStore.getPrompt(shown.promptId)?.answer).toBeNull();
		ctx.db.close();
	});

	test("reviewer-after-human remains accepted even before live classification", async () => {
		const { ctx, promptStore } = fixture();
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		let injected = false;
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			const result = original(ops);
			if (!injected && result.created) {
				injected = true;
				ctx.recordStore.append({
					runId: "run1",
					stream: "steps",
					idempotencyKey: "reviewer-after-human",
					payload: {
						...(ctx.recordStore.listLines("run1", "steps")[0]
							?.payload as object),
						step_name: "reviewer:after",
						iteration: 2,
					},
					...recordedEnvelope(TEST_ORIGIN),
				});
			}
			return result;
		};
		const decision = await submitPlanReviewDecision(
			{
				runId: "run1",
				gateId: shown.gateId,
				payload: { choice: "retain_baseline", rationale: "retain" },
			},
			{ context: ctx, promptStore },
		);
		expect(decision.created).toBe(true);
		expect(decision.route).toBe("complete");
		expect(promptStore.getPrompt(shown.promptId)?.answer).toBe(
			decision.decision.decisionId,
		);
		expect(rebuiltAcceptance(ctx)).toEqual(["accepted"]);
		ctx.db.close();
	});

	test("accepted-winner retry repairs a record-first prompt-second crash", async () => {
		const { ctx, promptStore } = fixture();
		const shown = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		if (!shown.open) throw new Error("expected gate");
		const resolve = promptStore.resolveReviewGatePrompt?.bind(promptStore);
		if (!resolve) throw new Error("expected projection resolver");
		promptStore.resolveReviewGatePrompt = () => {
			throw new Error("simulated prompt projection crash");
		};
		const decisionInput = {
			runId: "run1",
			gateId: shown.gateId,
			payload: { choice: "retain_baseline" as const, rationale: "retain" },
		};
		const recorded = await submitPlanReviewDecision(decisionInput, {
			context: ctx,
			promptStore,
		});
		expect(recorded.created).toBe(true);
		expect(ctx.recordStore.listLines("run1", "decisions")).toHaveLength(1);
		expect(promptStore.getPrompt(shown.promptId)?.answer).toBeNull();
		promptStore.resolveReviewGatePrompt = resolve;
		const retry = await submitPlanReviewDecision(decisionInput, {
			context: ctx,
			promptStore,
		});
		expect(retry.created).toBe(false);
		expect(promptStore.getPrompt(shown.promptId)?.answer).toBe(
			recorded.decision.decisionId,
		);
		const repaired = await showPlanReviewGate("run1", {
			context: ctx,
			promptStore,
		});
		expect(repaired.open).toBe(false);
		expect(promptStore.getPrompt(shown.promptId)?.answer).not.toBeNull();
		ctx.db.close();
	});
});
