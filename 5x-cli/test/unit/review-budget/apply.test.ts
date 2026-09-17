import { describe, expect, test } from "bun:test";
import {
	createMemoryRecordStore,
	createReviewBudgetStore,
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
} from "../../../src/control-plane/index.js";
import type { ReviewerVerdict } from "../../../src/protocol.js";
import { applyPlanReviewBudget } from "../../../src/review-budget/apply.js";
import {
	DEFAULT_REVIEW_BUDGET_CONFIG,
	type ReviewBudgetConfig,
} from "../../../src/review-budget/types.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
	performer: { kind: "agent", role: "reviewer" },
};
const config: ReviewBudgetConfig = {
	mode: "advisory",
	...DEFAULT_REVIEW_BUDGET_CONFIG,
};
const plan = `# Plan

## Delivery Budget
- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | Build it | 3 | -1 | DC0 (\`intrinsic\`) | - | Required |

### Debt Claims
#### DC0
- Target phase: phase-1
- Minimal-compliant effort delta: 1
- Minimal-compliant architecture delta: 0
- Before: Direct implementation
- After: Shared implementation

### Surface Snapshot
- Subsystems: 1
- Production files: 2
- Persistent/external boundaries: 0`;

function setup() {
	const records = createMemoryRecordStore();
	records.putRun({
		id: "run1",
		plan_path: "plan.md",
		config_json: null,
		created_at: "2026-09-17 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "test",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: origin.recorder,
	});
	return { records, store: createReviewBudgetStore(records) };
}

function verdict(overrides: Partial<ReviewerVerdict> = {}): ReviewerVerdict {
	return {
		readiness: "ready_with_corrections",
		items: [
			{
				id: "F1",
				title: "Finding",
				action: "auto_fix",
				reason: "Required",
				scopeClass: "acceptance_required",
				effortDelta: 2,
				architectureDelta: 0,
			},
		],
		baselineAssessment: {
			independentEffortEstimate: 3,
			confidence: "high",
			reason: "Independent estimate",
		},
		creditAssessments: [
			{
				creditClaimId: "DC0",
				eligibility: "eligible",
				coupling: "intrinsic",
				reason: "Intrinsic",
			},
		],
		...overrides,
	};
}

function apply(
	store: ReturnType<typeof createReviewBudgetStore>,
	value: ReviewerVerdict,
	overrides: Partial<Parameters<typeof applyPlanReviewBudget>[0]> = {},
) {
	return applyPlanReviewBudget({
		runId: "run1",
		stepName: "reviewer:review",
		phase: "plan",
		iteration: 1,
		planMarkdown: plan,
		verdict: value,
		config,
		store,
		hasPriorPlanReviewerStep: false,
		optInBaseline: false,
		origin,
		warn: () => {},
		...overrides,
	});
}

describe("applyPlanReviewBudget", () => {
	test("skips off and v1-compatible runs", () => {
		const { store } = setup();
		expect(
			apply(store, verdict(), { config: { ...config, mode: "off" } }),
		).toEqual({ status: "skipped", reason: "off" });
		expect(apply(store, verdict(), { hasPriorPlanReviewerStep: true })).toEqual(
			{ status: "skipped", reason: "v1_compat" },
		);
	});

	test("captures and derives without appending a snapshot", () => {
		const { records, store } = setup();
		const result = apply(store, verdict());
		expect(result.status).toBe("applied");
		if (result.status !== "applied") return;
		expect(result.verdict.readiness).toBe("ready_with_corrections");
		expect(result.verdict.budget).toMatchObject({ B0: 3, W: 3, R: 2, N: 1 });
		expect(records.listLines("run1", "budget")).toHaveLength(1);
	});

	test("requires the initial assessment and active item deltas", () => {
		const { store } = setup();
		expect(
			apply(store, verdict({ baselineAssessment: undefined })),
		).toMatchObject({ status: "error", code: "BASELINE_ASSESSMENT_REQUIRED" });
		const missing = verdict();
		delete missing.items[0]?.effortDelta;
		expect(apply(store, missing)).toMatchObject({
			status: "error",
			code: "BUDGET_ITEM_FIELDS_REQUIRED",
		});
	});

	test("rejects unknown assessments and reviewer claim collisions", () => {
		const { store } = setup();
		expect(
			apply(
				store,
				verdict({
					creditAssessments: [
						{
							creditClaimId: "DC9",
							eligibility: "eligible",
							coupling: "intrinsic",
							reason: "Unknown",
						},
					],
				}),
			),
		).toMatchObject({
			status: "error",
			code: "CREDIT_ASSESSMENT_UNKNOWN_CLAIM",
		});
		const collision = verdict();
		const collisionItem = collision.items[0];
		if (!collisionItem) throw new Error("missing fixture item");
		collisionItem.coupling = "intrinsic";
		collisionItem.creditClaim = {
			creditClaimId: "DC0",
			targetPhase: "phase-1",
			minimalAlternativeEffortDelta: 0,
			minimalAlternativeArchitectureDelta: 0,
			before: "A",
			after: "B",
		};
		expect(apply(store, collision)).toMatchObject({
			status: "error",
			code: "CREDIT_CLAIM_ID_COLLISION",
		});
	});

	test("carries unchanged assessments and rejects baselineAssessment on continuation", () => {
		const { store } = setup();
		const first = apply(store, verdict());
		if (first.status !== "applied") throw new Error("expected applied");
		store.appendSnapshot({ ...first.pendingSnapshot, iteration: 1, origin });
		const secondVerdict = verdict({
			baselineAssessment: undefined,
			creditAssessments: [],
		});
		const second = apply(store, secondVerdict, { iteration: 2 });
		expect(second).toMatchObject({ status: "applied" });
		if (second.status === "applied") expect(second.verdict.budget.N).toBe(1);
		expect(apply(store, verdict(), { iteration: 2 })).toMatchObject({
			status: "error",
			code: "BASELINE_ASSESSMENT_UNEXPECTED",
		});
	});

	test("warns in reserved enforced mode without changing routing", () => {
		const { store } = setup();
		const warnings: string[] = [];
		const result = apply(store, verdict(), {
			config: { ...config, mode: "enforced" },
			warn: (message) => warnings.push(message),
		});
		expect(result.status).toBe("applied");
		expect(warnings).toHaveLength(1);
		if (result.status === "applied")
			expect(result.verdict.readiness).toBe("ready_with_corrections");
	});
});
