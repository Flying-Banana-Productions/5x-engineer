import { describe, expect, test } from "bun:test";
import {
	composePlanReviewerRecord,
	hasPriorPlanReviewerStep,
} from "../../../src/commands/review-budget-context.js";
import { recordedEnvelope } from "../../../src/control-plane/index.js";
import { PlanDiffError } from "../../../src/review-governance/plan-diff.js";
import {
	makeBudgetContext,
	TEST_ORIGIN,
} from "./review-budget-test-helpers.js";

function appendStep(
	ctx: ReturnType<typeof makeBudgetContext>,
	stepName: string,
	phase: string,
	headCommit?: string,
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
			head_commit: headCommit ?? null,
			patch_id: null,
			diff_summary: null,
			duration_ms: null,
			tokens_in: null,
			tokens_out: null,
			cost_usd: null,
			model: null,
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

const planMarkdown = `# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Work | 2 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0
`;

const validInitialVerdict = {
	readiness: "ready" as const,
	items: [],
	baselineAssessment: {
		independentEffortEstimate: 2,
		confidence: "high" as const,
		reason: "The plan is small and self-contained.",
	},
};

describe("composePlanReviewerRecord", () => {
	test("keeps protocol and invoke composition byte-for-byte equivalent", async () => {
		const protocol = makeBudgetContext({ mode: "enforced" });
		const invoke = makeBudgetContext({ mode: "enforced" });
		const common = {
			runId: "run1",
			stepName: "reviewer:review",
			phase: "plan",
			iteration: 1,
			planMarkdown,
			verdict: validInitialVerdict,
			optInBaseline: false,
			origin: TEST_ORIGIN,
			warn: () => {},
		};
		const protocolResult = await composePlanReviewerRecord({
			ctx: protocol,
			...common,
		});
		const invokeResult = await composePlanReviewerRecord({
			ctx: invoke,
			...common,
		});
		expect(protocolResult.status).toBe("applied");
		expect(invokeResult.status).toBe("applied");
		if (
			protocolResult.status !== "applied" ||
			invokeResult.status !== "applied"
		)
			throw new Error("expected applied results");
		expect(JSON.stringify(protocolResult.verdict)).toBe(
			JSON.stringify(invokeResult.verdict),
		);
		const { id: _protocolId, ...protocolSnapshot } =
			protocolResult.pendingSnapshot;
		const { id: _invokeId, ...invokeSnapshot } = invokeResult.pendingSnapshot;
		expect(protocolSnapshot).toEqual(invokeSnapshot);
		const protocolBaseline = protocol.store.getBaseline("run1");
		const invokeBaseline = invoke.store.getBaseline("run1");
		if (!protocolBaseline || !invokeBaseline)
			throw new Error("missing baseline");
		const { id: _protocolBaselineId, ...protocolBaselineValue } =
			protocolBaseline;
		const { id: _invokeBaselineId, ...invokeBaselineValue } = invokeBaseline;
		expect(protocolBaselineValue).toEqual(invokeBaselineValue);
		protocol.db.close();
		invoke.db.close();
	});

	test("rejects invalid initial evidence before writing a baseline", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		const result = await composePlanReviewerRecord({
			ctx,
			runId: "run1",
			stepName: "reviewer:review",
			phase: "plan",
			iteration: 1,
			planMarkdown,
			verdict: { readiness: "ready", items: [] },
			optInBaseline: false,
			origin: TEST_ORIGIN,
			warn: () => {},
		});
		expect(result).toMatchObject({
			status: "error",
			code: "INITIAL_BASELINE_ASSESSMENT_REQUIRED",
		});
		expect(ctx.store.getBaseline("run1")).toBeNull();
		expect(ctx.recordStore.listLines("run1", "budget")).toEqual([]);
		ctx.db.close();
	});

	test("consumes persisted prior findings after reconstructing closure state", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		const initial = await composePlanReviewerRecord({
			ctx,
			runId: "run1",
			stepName: "reviewer:review",
			phase: "plan",
			iteration: 1,
			planMarkdown,
			verdict: {
				...validInitialVerdict,
				readiness: "not_ready",
				items: [
					{
						id: "P1.1",
						title: "Atomic write",
						action: "auto_fix",
						reason: "Retries can duplicate the write.",
						scopeClass: "acceptance_required",
						effortDelta: 1,
						architectureDelta: 0,
						estimateConfidence: "high",
						failure: "A retry can write twice.",
						lowestCostCorrection: "Use an idempotency key.",
					},
				],
			},
			optInBaseline: false,
			origin: TEST_ORIGIN,
			warn: () => {},
		});
		expect(initial.status).toBe("applied");
		if (initial.status !== "applied") throw new Error("initial review failed");
		ctx.store.appendSnapshot({
			...initial.pendingSnapshot,
			origin: TEST_ORIGIN,
		});

		const closure = await composePlanReviewerRecord({
			ctx,
			runId: "run1",
			stepName: "reviewer:review",
			phase: "plan",
			iteration: 2,
			planMarkdown,
			verdict: {
				readiness: "ready",
				items: [],
				priorFindings: [{ id: "P1.1", status: "addressed" }],
			},
			optInBaseline: false,
			origin: TEST_ORIGIN,
			warn: () => {},
		});
		expect(closure.status).toBe("applied");
		if (closure.status !== "applied") throw new Error("closure review failed");
		expect(closure.verdict.governance).toMatchObject({
			reviewKind: "closure",
			findingOutcomes: [{ findingId: "P1.1", status: "addressed" }],
		});
		ctx.db.close();
	});

	test("projects the same deterministic diff fallback through the shared seam", async () => {
		const ctx = makeBudgetContext({ mode: "enforced" });
		const initial = await composePlanReviewerRecord({
			ctx,
			runId: "run1",
			stepName: "reviewer:review",
			phase: "plan",
			iteration: 1,
			planMarkdown,
			verdict: validInitialVerdict,
			optInBaseline: false,
			origin: TEST_ORIGIN,
			warn: () => {},
		});
		if (initial.status !== "applied") throw new Error("initial review failed");
		ctx.store.appendSnapshot({
			...initial.pendingSnapshot,
			origin: TEST_ORIGIN,
		});
		appendStep(ctx, "reviewer:review", "plan", "abc123");
		const result = await composePlanReviewerRecord({
			ctx,
			runId: "run1",
			stepName: "reviewer:review",
			phase: "plan",
			iteration: 2,
			planMarkdown,
			verdict: {
				readiness: "not_ready",
				priorFindings: [],
				items: [
					{
						id: "P1.2",
						title: "New unsafe branch",
						action: "auto_fix",
						reason: "The plan revision introduced an unsafe branch.",
						scopeClass: "acceptance_required",
						effortDelta: 1,
						architectureDelta: 0,
						estimateConfidence: "high",
						failure: "The new branch can lose a write.",
						lowestCostCorrection: "Persist before acknowledging.",
						introducedBy: {
							commitRange: "abc123..def456",
							diffHunk: "@@ -1 +1 @@\n-old\n+new",
							explanation: "The replacement changes acknowledgement order.",
						},
					},
				],
			},
			optInBaseline: false,
			origin: TEST_ORIGIN,
			warn: () => {},
			buildDiffContext: async () => {
				throw new PlanDiffError(
					"PLAN_DIFF_BINARY_UNSUPPORTED",
					"The plan-only diff is binary.",
				);
			},
		});
		expect(result).toMatchObject({
			status: "error",
			code: "PLAN_DIFF_CONTEXT_MISSING",
		});
		expect(JSON.stringify(result)).toContain("PLAN_DIFF_BINARY_UNSUPPORTED");
		ctx.db.close();
	});
});
