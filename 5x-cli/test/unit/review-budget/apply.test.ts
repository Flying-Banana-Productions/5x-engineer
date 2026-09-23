import { describe, expect, test } from "bun:test";
import {
	createMemoryRecordStore,
	createReviewBudgetStore,
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
} from "../../../src/control-plane/index.js";
import type { ReviewBudgetSnapshotRecord } from "../../../src/control-plane/review-budget-store.js";
import type { ReviewerVerdict } from "../../../src/protocol.js";
import { reviewerVerdictSchemaFor } from "../../../src/protocol.js";
import {
	applyPlanReviewBudget,
	baselineAssessmentContract,
	findIncompleteDebtClaimItem,
} from "../../../src/review-budget/apply.js";
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
	test("rejects reviewer-authored aggregates", () => {
		const { store } = setup();
		const aggregate = { ...verdict(), budget: { B0: 999 } } as ReviewerVerdict;
		expect(apply(store, aggregate)).toMatchObject({
			status: "error",
			code: "INVALID_STRUCTURED_OUTPUT",
		});
	});

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

	test("still-listed findings remain in R even when Addresses names them", () => {
		const { store } = setup();
		const addressedPlan = plan.replace(
			"| DC0 (`intrinsic`) | - |",
			"| DC0 (`intrinsic`) | F1 |",
		);
		const result = apply(store, verdict(), { planMarkdown: addressedPlan });
		expect(result).toMatchObject({ status: "applied" });
		if (result.status === "applied") expect(result.verdict.budget.R).toBe(2);
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

	test("new and evidence-changed claims require a current assessment", () => {
		const { store } = setup();
		const first = apply(store, verdict());
		if (first.status !== "applied") throw new Error("expected applied");
		store.appendSnapshot({ ...first.pendingSnapshot, origin });
		const continued = verdict({
			baselineAssessment: undefined,
			creditAssessments: [],
		});
		const changed = apply(store, continued, {
			iteration: 2,
			planMarkdown: plan.replace("Before: Direct", "Before: Changed direct"),
		});
		expect(changed).toMatchObject({
			status: "error",
			code: "CREDIT_ASSESSMENT_REQUIRED",
		});

		const newClaimPlan = plan
			.replace(
				"| W1 | Build it | 3 | -1 | DC0 (`intrinsic`) | - | Required |",
				"| W1 | Build it | 3 | -1 | DC0 (`intrinsic`) | - | Required |\n| W2 | More | 1 | -1 | DC1 (`intrinsic`) | - | More |",
			)
			.replace(
				"### Surface Snapshot",
				"#### DC1\n- Target phase: phase-2\n- Minimal-compliant effort delta: 0\n- Minimal-compliant architecture delta: 0\n- Before: One path\n- After: Two paths\n\n### Surface Snapshot",
			);
		expect(
			apply(store, continued, { iteration: 2, planMarkdown: newClaimPlan }),
		).toMatchObject({
			status: "error",
			code: "CREDIT_ASSESSMENT_REQUIRED",
		});
	});

	test("current reassessment overlays persisted eligibility", () => {
		const { store } = setup();
		const first = apply(store, verdict());
		if (first.status !== "applied") throw new Error("expected applied");
		store.appendSnapshot({ ...first.pendingSnapshot, origin });
		const second = apply(
			store,
			verdict({
				baselineAssessment: undefined,
				creditAssessments: [
					{
						creditClaimId: "DC0",
						eligibility: "ineligible",
						coupling: "intrinsic",
						reason: "Reassessed",
					},
				],
			}),
			{ iteration: 2 },
		);
		expect(second).toMatchObject({ status: "applied" });
		if (second.status === "applied") {
			expect(second.verdict.budget.N).toBe(0);
			expect(second.pendingSnapshot.assessments[0]?.eligibility).toBe(
				"ineligible",
			);
		}
	});

	test("author N comes from persisted ledger architecture and requiresHuman is advisory", () => {
		const { store } = setup();
		const baseItem = verdict().items[0];
		if (!baseItem) throw new Error("missing fixture item");
		const human = verdict({
			readiness: "ready_with_corrections",
			items: [
				{
					...baseItem,
					action: "human_required",
					architectureDelta: -5,
					coupling: "unrelated",
					creditClaim: {
						creditClaimId: "RC1",
						targetPhase: "phase-1",
						minimalAlternativeEffortDelta: 0,
						minimalAlternativeArchitectureDelta: 0,
						before: "A",
						after: "B",
					},
				},
			],
		});
		const result = apply(store, human);
		expect(result).toMatchObject({ status: "applied" });
		if (result.status === "applied") {
			expect(result.verdict.budget.N).toBe(1);
			expect(result.verdict.budget.requiresHuman).toBe(true);
			expect(result.verdict.readiness).toBe("ready_with_corrections");
		}
	});

	test("defensive evidence validator rejects injected incomplete negative rows", () => {
		const incomplete = {
			estimateConfidence: "medium" as const,
			workItems: [
				{
					id: "W1",
					title: "Bad claim",
					effort: 1 as const,
					architectureDelta: -1 as const,
					debtClaim: {
						debtClaimId: "DC0",
						coupling: "intrinsic" as const,
					} as never,
					addresses: [],
					rationale: "bad",
					line: 1,
				},
			],
			surface: {
				subsystems: 1,
				productionFiles: 1,
				persistentOrExternalBoundaries: 0,
			},
		};
		expect(findIncompleteDebtClaimItem(incomplete)?.id).toBe("W1");
	});

	test("idempotent retry uses persisted first assessment", () => {
		const { store } = setup();
		const first = apply(store, verdict());
		if (first.status !== "applied") throw new Error("expected applied");
		store.appendSnapshot({ ...first.pendingSnapshot, origin });
		const retry = apply(
			store,
			verdict({
				baselineAssessment: {
					independentEffortEstimate: 99,
					confidence: "low",
					reason: "Conflicting retry",
				},
			}),
		);
		expect(retry).toMatchObject({ status: "applied" });
		if (retry.status === "applied") {
			expect(retry.verdict.budget.I).toBe(3);
			expect(
				retry.pendingSnapshot.baselineAssessment?.independentEffortEstimate,
			).toBe(3);
		}
	});

	test("captures enforced mode without a legacy warning", () => {
		const { store } = setup();
		const warnings: string[] = [];
		const result = apply(store, verdict(), {
			config: { ...config, mode: "enforced" },
			warn: (message) => warnings.push(message),
		});
		expect(result.status).toBe("applied");
		expect(warnings).toHaveLength(0);
		expect(store.getBaseline("run1")?.mode).toBe("enforced");
		if (result.status === "applied")
			expect(result.verdict.readiness).toBe("ready_with_corrections");
	});
});

describe("baselineAssessment contract", () => {
	const snapshot = (
		stepName: string,
		iteration: number,
		withAssessment: boolean,
	): ReviewBudgetSnapshotRecord =>
		({
			stepName,
			phase: "plan",
			iteration,
			...(withAssessment
				? {
						baselineAssessment: {
							independentEffortEstimate: 2,
							confidence: "high",
							reason: "estimate",
						},
					}
				: {}),
		}) as ReviewBudgetSnapshotRecord;
	const step = (iteration: number) => ({
		stepName: "reviewer:plan",
		phase: "plan",
		iteration,
	});

	test("first active review requires, initial retry allows, closure prohibits", () => {
		const initial = snapshot("reviewer:plan", 1, true);
		expect(baselineAssessmentContract([], step(1))).toBe("required");
		expect(baselineAssessmentContract([initial], step(1))).toBe("optional");
		expect(baselineAssessmentContract([initial], step(2))).toBe("prohibited");
		expect(
			baselineAssessmentContract(
				[initial, snapshot("reviewer:plan", 2, false)],
				step(2),
			),
		).toBe("prohibited");
	});

	test("provider schema mirrors each contract", () => {
		const required = reviewerVerdictSchemaFor("required");
		expect(required.required).toEqual([
			"readiness",
			"items",
			"baselineAssessment",
		]);
		const prohibited = reviewerVerdictSchemaFor("prohibited") as {
			properties: Record<string, unknown>;
			not: unknown;
		};
		expect(prohibited.properties).not.toHaveProperty("baselineAssessment");
		expect(prohibited.properties).toHaveProperty("priorFindings");
		expect(prohibited.not).toEqual({ required: ["baselineAssessment"] });
		expect(reviewerVerdictSchemaFor("optional")).toHaveProperty(
			"properties.baselineAssessment",
		);
	});
});
