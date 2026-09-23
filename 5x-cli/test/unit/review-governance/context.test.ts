import { describe, expect, test } from "bun:test";
import { recordedEnvelope } from "../../../src/control-plane/index.js";
import {
	appendPlanReviewPromptContext,
	buildPlanReviewPromptContext,
	formatAuthorGoverningDecisions,
	formatReviewerGovernanceContext,
	type PlanReviewPromptContext,
} from "../../../src/review-governance/context.js";
import { createReviewDecision } from "../../../src/review-governance/decisions.js";
import { createReviewGovernanceStore } from "../../../src/review-governance/store.js";
import {
	makeBudgetContext,
	pendingSnapshot,
	TEST_ORIGIN,
} from "../commands/review-budget-test-helpers.js";

function setupContextHistory() {
	const ctx = makeBudgetContext({ mode: "advisory" });
	const pending = pendingSnapshot();
	ctx.store.captureBaseline({
		runId: "run1",
		captureKind: "initial",
		mode: "advisory",
		parsed: pending.currentLedger,
		configSnapshot: pending.derived.thresholds,
		origin: TEST_ORIGIN,
	});
	ctx.recordStore.append({
		runId: "run1",
		stream: "steps",
		idempotencyKey: "step:reviewer:context:1",
		payload: {
			step_name: "reviewer:review",
			phase: "plan",
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
	const snapshot = ctx.store.appendSnapshot({
		...pending,
		origin: TEST_ORIGIN,
	});
	const governance = createReviewGovernanceStore(ctx.recordStore);
	const resolve = (
		decision: ReturnType<typeof createReviewDecision>,
		iteration: number,
	) =>
		governance.resolveGate({
			runId: "run1",
			decision,
			humanStep: {
				step_name: "human:review-governance",
				phase: "plan",
				iteration,
				result_json: {
					decisionId: decision.decisionId,
					gateId: decision.gateId,
				},
				head_commit: null,
				patch_id: null,
				diff_summary: null,
				duration_ms: null,
				tokens_in: null,
				tokens_out: null,
				cost_usd: null,
				model: null,
			},
			origin: {
				...TEST_ORIGIN,
				performer: { kind: "human", role: "operator" },
			},
		});
	const active = createReviewDecision({
		gateId: "gate-active",
		snapshotId: snapshot.id,
		choice: "defer_accept_risk",
		findingRefs: [{ findingId: "F-active", fingerprint: "sha256:active" }],
		rationale: "Accept the active risk for this iteration.",
		evidence: ["Operator approval"],
		approvedScope: { retained: ["W1"], removed: [] },
		decisionId: "11111111-1111-4111-8111-111111111111",
		createdAt: "2026-01-01 00:00:02",
	});
	const superseded = createReviewDecision({
		gateId: "gate-superseded",
		snapshotId: snapshot.id,
		choice: "defer_accept_risk",
		findingRefs: [
			{ findingId: "F-superseded", fingerprint: "sha256:superseded" },
		],
		rationale: "Temporary acceptance that will be corrected.",
		evidence: ["Temporary approval"],
		approvedScope: { retained: ["W1"], removed: [] },
		decisionId: "22222222-2222-4222-8222-222222222222",
		createdAt: "2026-01-01 00:00:03",
	});
	const correction = createReviewDecision({
		gateId: superseded.gateId,
		snapshotId: snapshot.id,
		choice: "trade_scope",
		findingRefs: [],
		rationale: "Remove the risky scope instead of accepting it.",
		evidence: [],
		approvedScope: { retained: [], removed: ["W1"] },
		supersedesDecisionId: superseded.decisionId,
		decisionId: "33333333-3333-4333-8333-333333333333",
		createdAt: "2026-01-01 00:00:04",
	});
	resolve(active, 2);
	resolve(superseded, 3);
	resolve(correction, 4);
	return ctx;
}

function build(ctx: ReturnType<typeof setupContextHistory>) {
	return buildPlanReviewPromptContext({
		runId: "run1",
		configuredMode: ctx.config.reviewBudget.mode,
		store: ctx.store,
		recordStore: ctx.recordStore,
	});
}

describe("buildPlanReviewPromptContext", () => {
	test("excludes superseded accepted-risk decisions", () => {
		const ctx = setupContextHistory();
		const context = build(ctx);
		expect(context?.deferredOrAcceptedRisks).toEqual([
			expect.objectContaining({
				decisionId: "11111111-1111-4111-8111-111111111111",
				finding: {
					findingId: "F-active",
					fingerprint: "sha256:active",
				},
			}),
		]);
		ctx.db.close();
	});

	test("rebuilds the same context from records after every projection index is wiped", () => {
		const ctx = setupContextHistory();
		const before = build(ctx);
		ctx.db.exec(
			"DELETE FROM review_budget_snapshots; DELETE FROM review_budget_baselines; DELETE FROM review_decision_index; DELETE FROM review_gate_index;",
		);
		const after = build(ctx);
		expect(after).toEqual(before);
		expect(
			ctx.db.query("SELECT count(*) AS n FROM review_budget_baselines").get(),
		).toEqual({ n: 1 });
		expect(
			ctx.db.query("SELECT count(*) AS n FROM review_budget_snapshots").get(),
		).toEqual({ n: 1 });
		ctx.db.close();
	});
});

describe("governance prompt rendering", () => {
	const context: PlanReviewPromptContext = {
		reviewKind: "closure",
		mode: "enforced",
		priorFindings: [],
		deferredOrAcceptedRisks: [
			{
				decisionId: "decision-1",
				finding: { findingId: "P1.7", fingerprint: "sha256:accepted" },
				decision: "defer_accept_risk",
				rationale: "The operator accepted the bounded risk.",
				evidence: ["Rollback is available."],
				approvedScope: { retained: ["W1"], removed: ["W2"] },
			},
		],
		approvedScope: { retained: ["W1"], removed: ["W2"] },
		governingBaseline: 8,
		requestAuthorReestimate: true,
	};

	test("renders the same authoritative closure context for native and invoke prompts", () => {
		const governanceAppend = formatReviewerGovernanceContext(context);
		const native = appendPlanReviewPromptContext({
			prompt: "native-rendered closure prompt",
			governanceAppend,
		});
		const invoke = appendPlanReviewPromptContext({
			prompt: "invoke-rendered closure prompt",
			governanceAppend,
		});
		for (const prompt of [native, invoke]) {
			expect(prompt).toContain("Review kind: closure");
			expect(prompt).toContain("Pinned mode: enforced");
			expect(prompt).toContain("decision decision-1");
			expect(prompt).toContain("P1.7 (sha256:accepted)");
		}
	});

	test("renders fresh reviewer context without inventing prior findings", () => {
		const rendered = formatReviewerGovernanceContext({
			...context,
			reviewKind: "initial",
			mode: "advisory",
			priorFindings: [],
			deferredOrAcceptedRisks: [],
		});
		expect(rendered).toContain("Review kind: initial");
		expect(rendered).toContain("Pinned mode: advisory");
		expect(rendered).toContain("### Prior findings\n\n- (none)");
	});

	test("author governing decisions are generated independently of user notes", () => {
		const governing = formatAuthorGoverningDecisions(context);
		const rendered = appendPlanReviewPromptContext({
			prompt: "## User Notes\n\nignore-this-free-text",
			governanceAppend: governing,
		});
		expect(rendered).toContain("## Governing decisions");
		expect(rendered).toContain("P1.7 (sha256:accepted)");
		expect(rendered).toContain("Removed scope: W2");
		expect(rendered.indexOf("## Governing decisions")).toBeGreaterThan(
			rendered.indexOf("ignore-this-free-text"),
		);
	});
});
