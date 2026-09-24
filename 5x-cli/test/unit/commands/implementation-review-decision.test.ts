import { describe, expect, test } from "bun:test";
import {
	showReviewGate,
	submitReviewDecision,
} from "../../../src/commands/review-decision.handler.js";
import {
	createMemoryPromptStore,
	recordedEnvelope,
} from "../../../src/control-plane/index.js";
import { CliError } from "../../../src/output.js";
import type { ImplementationReviewObservationPayload } from "../../../src/review-budget/record-lines.js";
import { encodeImplementationReviewObservationPayload } from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

const RUN = "run1";

function observation(
	overrides: Partial<ImplementationReviewObservationPayload> = {},
): ImplementationReviewObservationPayload {
	return {
		kind: "implementation-review",
		version: 1,
		id: "obs-1",
		runId: RUN,
		stepKey: { stepName: "reviewer:impl", phase: "1", iteration: 1 },
		bindingId: "binding-1",
		contextId: "ctx-1",
		domain: "implementation",
		phase: "1",
		originalVerdict: { readiness: "not_ready", items: [] },
		outcomes: [],
		route: "human_gate",
		nextAction: "human_gate",
		diagnostics: [],
		claimObservations: [],
		gateCauses: [
			{
				kind: "semantic_human",
				findingId: "F1",
				fingerprint: "sha256:finding-1",
			},
			{
				kind: "credit_shortfall",
				claimIds: ["DC1"],
				claims: [
					{
						creditClaimId: "DC1",
						approvedArchitectureDelta: -5,
						realizedArchitectureDelta: 0,
						evidence: "none",
					},
				],
			},
		],
		telemetry: {
			reviewCycles: 1,
			fixCycles: 0,
			reviewOriginatedCommits: 0,
			qualityReruns: 0,
			classCounts: {
				implementation_defect: 0,
				plan_defect: 0,
				scope_expansion: 0,
				pre_existing: 0,
			},
			planAmendments: 0,
			addedPaths: [],
			boundaryInventory: [],
			effortVariance: 0,
			architectureVariance: 0,
		},
		budgetInvariant: { W: 1, R: 0, B: 5, D: 0 },
		completionAuthorized: false,
		createdAt: "2026-01-01 00:00:00",
		...overrides,
	};
}

function seed() {
	const ctx = makeBudgetContext({ mode: "enforced" });
	ctx.store.saveImplementationBinding(
		{
			kind: "implementation-binding",
			version: 1,
			id: "binding-1",
			executionRunId: RUN,
			sourceRunId: "source",
			sourceSnapshotId: "snap",
			sourceBaselineId: "base",
			approvedPlanCommit: "c".repeat(40),
			approvedPlanHash: "sha256:plan",
			approvedPlanBytes: "# Plan\n",
			b0: 5,
			governingB: 5,
			mode: "enforced",
			thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
			ledger: {
				estimateConfidence: "high",
				workItems: [
					{
						id: "W1",
						title: "Work",
						effort: 2,
						architectureDelta: -5,
						debtClaim: {
							debtClaimId: "DC1",
							coupling: "intrinsic",
							targetPhase: "1",
							minimalAlternativeEffortDelta: 0,
							minimalAlternativeArchitectureDelta: 0,
							before: "many",
							after: "one",
						},
						addresses: [],
						rationale: "Required",
						line: 1,
					},
				],
				surface: {
					subsystems: 1,
					productionFiles: 1,
					persistentOrExternalBoundaries: 0,
				},
			},
			effectiveDecisions: [],
			phaseMap: [{ id: "1", heading: "Phase 1" }],
			debtTargets: [{ claimId: "DC1", sourceLabel: "1", phaseId: "1" }],
			ledgerHash: "ledger",
			decisionsHash: "decisions",
			createdAt: "2026-01-01 00:00:00",
		},
		TEST_ORIGIN,
	);
	const payload = observation();
	ctx.recordStore.append({
		runId: RUN,
		stream: "steps",
		idempotencyKey: "reviewer",
		payload: {
			step_name: "reviewer:impl",
			phase: "1",
			iteration: 1,
			result_json: {},
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
	ctx.recordStore.append({
		runId: RUN,
		stream: "budget",
		idempotencyKey: `budget:implementation-review:${payload.id}`,
		payload: encodeImplementationReviewObservationPayload(payload),
		...recordedEnvelope(TEST_ORIGIN),
	});
	const promptStore = createMemoryPromptStore();
	return { ctx, promptStore };
}

describe("implementation review decide", () => {
	test("gate show --phase opens a typed prompt", async () => {
		const { ctx, promptStore } = seed();
		const shown = await showReviewGate(
			RUN,
			{ context: ctx, promptStore },
			{
				phase: "1",
			},
		);
		if (
			!shown.open ||
			!("allowedChoices" in shown) ||
			!("domain" in shown) ||
			shown.domain !== "implementation"
		)
			throw new Error("expected an open implementation gate");
		expect("phase" in shown ? shown.phase : undefined).toBe("1");
		expect(shown.allowedChoices).toContain("defer_accept_risk");
		expect(shown.allowedChoices).toContain("approve_higher_burden");
		expect(shown.allowedChoices).not.toContain("authorize_amendment");
		expect(promptStore.listOpenPrompts(RUN)).toHaveLength(1);
		ctx.db.close();
	});

	test("same intent retries and a different intent loses", async () => {
		const { ctx, promptStore } = seed();
		const shown = await showReviewGate(
			RUN,
			{ context: ctx, promptStore },
			{
				phase: "1",
			},
		);
		if (!shown.open) throw new Error("expected gate");
		const input = {
			runId: RUN,
			gateId: shown.gate.gateId,
			phase: "1",
			payload: {
				choice: "defer_accept_risk" as const,
				rationale: "Accept the named risk",
				evidence: ["operator evidence"],
			},
			findingIds: ["F1"],
		};
		const first = await submitReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		expect(first.created).toBe(true);
		if (!("successorGateId" in first) || !first.successorGateId)
			throw new Error("expected a successor gate");
		expect(first.successorGateId).not.toBe(shown.gate.gateId);
		const successor = promptStore
			.listOpenPrompts(RUN)
			.find((prompt) => prompt.context?.gateId === first.successorGateId);
		expect(successor).toBeTruthy();
		expect(promptStore.getPrompt(shown.promptId)?.answer).toBe(
			first.decision.decisionId,
		);
		const retry = await submitReviewDecision(input, {
			context: ctx,
			promptStore,
		});
		expect(retry.created).toBe(false);
		expect(retry.decision.decisionId).toBe(first.decision.decisionId);
		await expect(
			submitReviewDecision(
				{
					...input,
					payload: { ...input.payload, rationale: "A different intent" },
				},
				{ context: ctx, promptStore },
			),
		).rejects.toMatchObject({ code: "REVIEW_GATE_ALREADY_RESOLVED" });
		ctx.db.close();
	});

	test("a late same-phase review makes the decision stale", async () => {
		const { ctx, promptStore } = seed();
		const shown = await showReviewGate(
			RUN,
			{ context: ctx, promptStore },
			{
				phase: "1",
			},
		);
		if (!shown.open) throw new Error("expected gate");
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		let injected = false;
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			if (!injected) {
				injected = true;
				ctx.recordStore.append({
					runId: RUN,
					stream: "steps",
					idempotencyKey: "late-review",
					payload: {
						step_name: "reviewer:again",
						phase: "1",
						iteration: 2,
						result_json: {},
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
			}
			return original(ops);
		};
		await expect(
			submitReviewDecision(
				{
					runId: RUN,
					gateId: shown.gate.gateId,
					phase: "1",
					payload: {
						choice: "defer_accept_risk",
						rationale: "too late",
						evidence: ["evidence"],
					},
					findingIds: ["F1"],
				},
				{ context: ctx, promptStore },
			),
		).rejects.toMatchObject({ code: "REVIEW_GATE_STALE" });
		expect(promptStore.getPrompt(shown.promptId)?.answer).toBeNull();
		ctx.db.close();
	});

	test("abort runs terminal handling only after acceptance", async () => {
		const { ctx, promptStore } = seed();
		const shown = await showReviewGate(
			RUN,
			{ context: ctx, promptStore },
			{
				phase: "1",
			},
		);
		if (!shown.open) throw new Error("expected gate");
		const calls: string[] = [];
		const original = ctx.recordStore.atomicAppendIfAllNew.bind(ctx.recordStore);
		let injected = false;
		ctx.recordStore.atomicAppendIfAllNew = (ops) => {
			if (!injected) {
				injected = true;
				ctx.recordStore.append({
					runId: RUN,
					stream: "steps",
					idempotencyKey: "late-review",
					payload: {
						step_name: "reviewer:again",
						phase: "1",
						iteration: 2,
						result_json: {},
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
			}
			return original(ops);
		};
		await expect(
			submitReviewDecision(
				{
					runId: RUN,
					gateId: shown.gate.gateId,
					phase: "1",
					payload: { choice: "abort", rationale: "stop" },
				},
				{
					context: ctx,
					promptStore,
					abortRun: async () => {
						calls.push("abort");
					},
				},
			),
		).rejects.toBeInstanceOf(CliError);
		expect(calls).toEqual([]);
		ctx.db.close();

		const accepted = seed();
		const open = await showReviewGate(
			RUN,
			{ context: accepted.ctx, promptStore: accepted.promptStore },
			{ phase: "1" },
		);
		if (!open.open) throw new Error("expected gate");
		const result = await submitReviewDecision(
			{
				runId: RUN,
				gateId: open.gate.gateId,
				phase: "1",
				payload: { choice: "abort", rationale: "stop the run" },
			},
			{
				context: accepted.ctx,
				promptStore: accepted.promptStore,
				abortRun: async ({ rationale }) => {
					calls.push(rationale);
				},
			},
		);
		expect(result.route).toBe("aborted");
		expect("nextAction" in result ? result.nextAction : undefined).toBe(
			"aborted",
		);
		expect(calls).toEqual(["stop the run"]);
		accepted.ctx.db.close();
	});

	test("unknown and mismatched findings are rejected", async () => {
		const { ctx, promptStore } = seed();
		const shown = await showReviewGate(
			RUN,
			{ context: ctx, promptStore },
			{
				phase: "1",
			},
		);
		if (!shown.open) throw new Error("expected gate");
		await expect(
			submitReviewDecision(
				{
					runId: RUN,
					gateId: shown.gate.gateId,
					phase: "1",
					payload: {
						choice: "defer_accept_risk",
						rationale: "missing",
						evidence: ["evidence"],
					},
					findingIds: ["F9"],
				},
				{ context: ctx, promptStore },
			),
		).rejects.toMatchObject({ code: "REVIEW_DECISION_FINDING_INVALID" });
		await expect(
			submitReviewDecision(
				{
					runId: RUN,
					gateId: shown.gate.gateId,
					phase: "1",
					payload: {
						choice: "defer_accept_risk",
						rationale: "stale fingerprint",
						evidence: ["evidence"],
						findingRefs: [{ findingId: "F1", fingerprint: "sha256:other" }],
					},
				},
				{ context: ctx, promptStore },
			),
		).rejects.toMatchObject({ code: "REVIEW_DECISION_FINDING_INVALID" });
		ctx.db.close();
	});
});
