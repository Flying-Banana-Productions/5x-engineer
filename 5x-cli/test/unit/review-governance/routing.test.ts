import { describe, expect, test } from "bun:test";
import type { ReviewBudgetSnapshotRecord } from "../../../src/control-plane/review-budget-store.js";
import type { ReviewerVerdict, VerdictItem } from "../../../src/protocol.js";
import { deriveBudget } from "../../../src/review-budget/arithmetic.js";
import type {
	CreditAssessmentInput,
	DerivedBudgetResult,
	FindingDelta,
	ParsedDeliveryBudget,
} from "../../../src/review-budget/types.js";
import type {
	GoverningReviewState,
	ReviewDecisionPayload,
} from "../../../src/review-governance/decisions.js";
import { canonicalFindingFingerprint } from "../../../src/review-governance/fingerprint.js";
import {
	derivePlanReviewGovernance,
	routeAfterDecision,
	validateFinalCorrections,
} from "../../../src/review-governance/routing.js";
import type {
	ClosureValidationResult,
	ReviewDecisionRoute,
} from "../../../src/review-governance/types.js";

const thresholds = {
	growthPercent: 25,
	minimumGrowthPoints: 2,
	debtTradeoffRatio: 1,
	maxDebtCreditPercent: 25,
	absoluteGrowthPercent: 50,
	baselineDisagreementPercent: 25,
	minimumBaselineDisagreementPoints: 2,
	maxPositiveArchitecturePercent: 25,
	minimumPositiveArchitecturePoints: 2,
	singleArchitectureReviewPoints: 5,
};

const ledger: ParsedDeliveryBudget = {
	estimateConfidence: "high",
	workItems: [
		{
			id: "W1",
			title: "Base work",
			effort: 5,
			architectureDelta: 0,
			debtClaim: null,
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
};

const closure: ClosureValidationResult = {
	valid: true,
	accepted: true,
	diagnostics: [],
	requiredOutcomeIds: [],
	findingOutcomes: [],
};

function state(
	overrides: Partial<GoverningReviewState> = {},
): GoverningReviewState {
	return {
		governingBaseline: 5,
		approvedScope: { retained: [], removed: [] },
		acceptedRisks: [],
		architectureApprovals: [],
		aborted: false,
		history: [],
		auditOnly: [],
		...overrides,
	};
}

function item(overrides: Partial<VerdictItem> = {}): VerdictItem {
	return {
		id: "P1.1",
		title: "Prevent corruption",
		action: "auto_fix",
		reason: "A retry corrupts data",
		scopeClass: "acceptance_required",
		effortDelta: 1,
		architectureDelta: 0,
		failure: "A retry corrupts data",
		lowestCostCorrection: "Make the operation idempotent",
		...overrides,
	};
}

function budget(
	overrides: Partial<DerivedBudgetResult> = {},
): DerivedBudgetResult {
	return {
		B0: 5,
		B: 5,
		I: 5,
		W: 5,
		R: 1,
		projectedEffort: 6,
		S: 7,
		N: 0,
		D: 0,
		E: 7,
		A: 8,
		P: 0,
		baselineDirection: "aligned",
		budgetBand: "within_standard",
		budgetAlerts: [],
		requiresHuman: false,
		positiveArchitectureLimit: 2,
		baselineDisagreementThreshold: 2,
		thresholds,
		...overrides,
	};
}

function route(input: {
	mode?: "advisory" | "enforced";
	readiness?: ReviewerVerdict["readiness"];
	items?: VerdictItem[];
	budget?: DerivedBudgetResult;
	state?: GoverningReviewState;
	ledger?: ParsedDeliveryBudget;
	findings?: FindingDelta[];
	assessments?: CreditAssessmentInput[];
	closure?: ClosureValidationResult;
}) {
	const items = input.items ?? [item()];
	return derivePlanReviewGovernance({
		mode: input.mode ?? "enforced",
		reviewKind: "closure",
		verdict: {
			readiness: input.readiness ?? "not_ready",
			items,
		},
		budget: input.budget ?? budget(),
		closure: input.closure ?? closure,
		governingState: input.state ?? state(),
		budgetContext: {
			workItems: (input.ledger ?? ledger).workItems,
			findings:
				input.findings ??
				items.map((entry) => ({
					id: entry.id,
					effortDelta: entry.effortDelta ?? 0,
					architectureDelta: entry.architectureDelta ?? 0,
					scopeClass: entry.scopeClass,
					coupling: entry.coupling,
				})),
			assessments: input.assessments ?? [],
		},
	});
}

describe("derivePlanReviewGovernance", () => {
	test("routes every recomputed budget band", () => {
		expect(route({ items: [item({ effortDelta: 1 })] }).route).toBe(
			"author_revision",
		);
		const debtFinding: FindingDelta = {
			id: "P1.1",
			effortDelta: 3,
			architectureDelta: -1,
			scopeClass: "acceptance_required",
			coupling: "intrinsic",
			creditClaim: {
				debtClaimId: "debt-1",
				coupling: "intrinsic",
				targetPhase: "Phase 5",
				minimalAlternativeEffortDelta: 1,
				minimalAlternativeArchitectureDelta: 0,
				before: "Duplicated paths",
				after: "One shared path",
			},
		};
		expect(
			route({ items: [item({ effortDelta: 3 })], findings: [debtFinding] })
				.route,
		).toBe("author_revision");
		expect(route({ items: [item({ effortDelta: 3 })] }).route).toBe(
			"human_gate",
		);
		expect(route({ items: [item({ effortDelta: 4 })] }).route).toBe(
			"human_gate",
		);
	});

	test("routes uncovered baseline and architecture alerts to a human", () => {
		expect(route({ budget: budget({ I: 8 }) }).route).toBe("human_gate");
		expect(route({ items: [item({ architectureDelta: 2 })] }).route).toBe(
			"human_gate",
		);
	});

	test("treats credit-unrealized alone as informational", () => {
		expect(
			route({ budget: budget({ budgetAlerts: ["credit_unrealized"] }) }).route,
		).toBe("author_revision");
	});

	test("records resolved baseline causes without reopening later rounds", () => {
		const result = route({
			budget: budget({ I: 8 }),
			state: state({
				baselineDisputeResolution: {
					decisionId: "decision-retain",
					choice: "retain_baseline",
				},
			}),
		});
		expect(result.route).toBe("author_revision");
		expect(result.gateCauses).toEqual([
			{
				kind: "budget_alert",
				alert: "baseline_disputed",
				resolvedBy: "decision-retain",
			},
		]);
	});

	test("a pending re-estimate does not suppress either baseline direction", () => {
		for (const I of [8, 2]) {
			const result = route({
				budget: budget({ I }),
				state: state({
					baselineReestimatePending: { decisionId: "reestimate" },
				}),
			});
			expect(result.route).toBe("human_gate");
			expect(result.gateCauses[0]?.resolvedBy).toBeUndefined();
		}
	});

	test("recomputes budget bands against the folded governing baseline", () => {
		const result = route({
			state: state({ governingBaseline: 10 }),
			items: [item({ effortDelta: 3 })],
		});
		expect(result.route).toBe("author_revision");
		expect(result.gateCauses).toEqual([]);
	});

	test("routes semantic, adjacent-debt, and critical actions with typed causes", () => {
		for (const [candidate, kind] of [
			[item({ action: "human_required" }), "semantic_human"],
			[
				item({ action: "human_required", coupling: "adjacent" }),
				"adjacent_debt",
			],
			[item({ lateDiscovery: "critical_safety" }), "critical_safety"],
		] as const) {
			const result = route({ items: [candidate] });
			expect(result.route).toBe("human_gate");
			expect(result.gateCauses[0]?.kind).toBe(kind);
		}
	});

	test("normalizes invalid final corrections and accepts the strict shortcut", () => {
		expect(route({ readiness: "ready_with_corrections" }).route).toBe(
			"final_corrections",
		);
		const invalid = route({
			readiness: "ready_with_corrections",
			items: [item({ effortDelta: 2 })],
		});
		expect(invalid.route).toBe("author_revision");
		expect(invalid.normalizedReadiness).toBe("not_ready");
		expect(route({ readiness: "ready", items: [item()] }).route).toBe(
			"author_revision",
		);
	});

	test("filters accepted risk before routing without mutating gross budget telemetry", () => {
		const blocker = item({ effortDelta: 3 });
		const original = budget({
			R: 3,
			projectedEffort: 8,
			budgetBand: "over_effective",
		});
		const before = structuredClone(original);
		const fingerprint = canonicalFindingFingerprint({
			title: blocker.title,
			scopeClass: "acceptance_required",
			failure: blocker.failure as string,
			lowestCostCorrection: blocker.lowestCostCorrection as string,
		});
		const result = route({
			items: [blocker],
			budget: original,
			state: state({
				acceptedRisks: [
					{
						findingId: blocker.id,
						fingerprint,
						decisionId: "risk-decision",
						rationale: "Accepted",
						evidence: ["Compensating control"],
					},
				],
			}),
		});
		expect(result.route).toBe("complete");
		expect(original).toEqual(before);
	});

	test("uses closure's canonical identity when an existing item omits evidence fields", () => {
		const complete = item();
		const fingerprint = canonicalFindingFingerprint({
			title: complete.title,
			scopeClass: "acceptance_required",
			failure: complete.failure as string,
			lowestCostCorrection: complete.lowestCostCorrection as string,
		});
		const result = route({
			items: [item({ failure: undefined, lowestCostCorrection: undefined })],
			closure: {
				...closure,
				findingOutcomes: [
					{ findingId: complete.id, fingerprint, status: "still_open" },
				],
			},
			state: state({
				acceptedRisks: [
					{
						findingId: complete.id,
						fingerprint,
						decisionId: "risk-decision",
						rationale: "Accepted",
						evidence: ["Control"],
					},
				],
			}),
		});
		expect(result.route).toBe("complete");
	});

	test("reruns plan-208 debt credit after deferring an intrinsic-credit finding", () => {
		const deferred = item({ id: "P1.debt", effortDelta: 0 });
		const remaining = item({ id: "P1.remaining", effortDelta: 3 });
		const fingerprint = canonicalFindingFingerprint({
			title: deferred.title,
			scopeClass: "acceptance_required",
			failure: deferred.failure as string,
			lowestCostCorrection: deferred.lowestCostCorrection as string,
		});
		const result = route({
			items: [deferred, remaining],
			findings: [
				{
					id: deferred.id,
					effortDelta: 0,
					architectureDelta: -1,
					scopeClass: "acceptance_required",
					coupling: "intrinsic",
					creditClaim: {
						debtClaimId: "reviewer-debt",
						coupling: "intrinsic",
						targetPhase: "Phase 5",
						minimalAlternativeEffortDelta: 1,
						minimalAlternativeArchitectureDelta: 0,
						before: "Duplicated paths",
						after: "One shared path",
					},
				},
				{
					id: remaining.id,
					effortDelta: 3,
					architectureDelta: 0,
					scopeClass: "acceptance_required",
					coupling: undefined,
				},
			],
			state: state({
				acceptedRisks: [
					{
						findingId: deferred.id,
						fingerprint,
						decisionId: "debt-deferral",
						rationale: "Deferred",
						evidence: ["Later phase"],
					},
				],
			}),
		});
		expect(result.route).toBe("human_gate");
		expect(result.gateCauses[0]).toEqual({
			kind: "budget_band",
			band: "over_effective",
		});
	});

	test("advisory preserves v1 routing while reporting the enforced route", () => {
		const result = route({
			mode: "advisory",
			readiness: "ready_with_corrections",
		});
		expect(result.route).toBe("author_revision");
		expect(result.normalizedReadiness).toBe("ready_with_corrections");
		expect(result.hypotheticalEnforcedRoute).toBe("final_corrections");
		expect(
			route({
				mode: "advisory",
				items: [item({ action: "human_required" })],
			}).route,
		).toBe("human_gate");
		expect(
			route({ mode: "advisory", readiness: "not_ready", items: [] }).route,
		).toBe("human_gate");
	});

	test("preserves work-item single-threshold architecture gates after baseline changes and deferrals", () => {
		const workLedger: ParsedDeliveryBudget = {
			...ledger,
			workItems: [
				{
					...(ledger.workItems[0] as ParsedDeliveryBudget["workItems"][number]),
					architectureDelta: 5,
				},
			],
		};
		const adjusted = route({
			budget: budget({ B0: 40, B: 40, I: 40 }),
			state: state({ governingBaseline: 44 }),
			ledger: workLedger,
			items: [],
		});
		expect(adjusted.route).toBe("human_gate");
		expect(adjusted.gateCauses).toContainEqual({
			kind: "budget_alert",
			alert: "positive_architecture_exceeded",
			itemIds: [],
			workItemIds: ["W1"],
		});

		const blocker = item();
		const fingerprint = canonicalFindingFingerprint({
			title: blocker.title,
			scopeClass: "acceptance_required",
			failure: blocker.failure as string,
			lowestCostCorrection: blocker.lowestCostCorrection as string,
		});
		const deferred = route({
			budget: budget({ B0: 40, B: 40, I: 40 }),
			state: state({
				governingBaseline: 44,
				acceptedRisks: [
					{
						findingId: blocker.id,
						fingerprint,
						decisionId: "risk-decision",
						rationale: "Accepted",
						evidence: ["Control"],
					},
				],
			}),
			ledger: workLedger,
			items: [blocker],
		});
		expect(deferred.route).toBe("human_gate");
		expect(deferred.gateCauses[0]).toMatchObject({
			kind: "budget_alert",
			workItemIds: ["W1"],
		});

		const unscopedApproval = state({
			governingBaseline: 44,
			architectureApprovals: [
				{
					decisionId: "old-approval",
					approvedP: 5,
					approvedItemIds: [],
					approvedWorkItemIds: [],
				},
			],
		});
		expect(
			route({
				budget: budget({ B0: 40, B: 40, I: 40 }),
				state: unscopedApproval,
				ledger: workLedger,
				items: [],
			}).route,
		).toBe("human_gate");
	});

	test("preserves the supplied review kind in deterministic output", () => {
		const result = derivePlanReviewGovernance({
			mode: "enforced",
			reviewKind: "initial",
			verdict: { readiness: "ready", items: [] },
			budget: budget({ R: 0, projectedEffort: 5 }),
			closure,
			governingState: state(),
			budgetContext: {
				workItems: ledger.workItems,
				findings: [],
				assessments: [],
			},
		});
		expect(result).toMatchObject({ reviewKind: "initial", route: "complete" });
	});

	test("approved architecture burden re-gates on growth or a new crossing ID", () => {
		const governed = state({
			architectureApprovals: [
				{
					decisionId: "architecture-decision",
					approvedP: 5,
					approvedItemIds: ["P1.1"],
					approvedWorkItemIds: [],
				},
			],
		});
		const architectureBudget = budget({
			P: 5,
			budgetAlerts: ["positive_architecture_exceeded"],
		});
		const approved = derivePlanReviewGovernance({
			mode: "enforced",
			reviewKind: "initial",
			verdict: {
				readiness: "not_ready",
				items: [item({ architectureDelta: 5 })],
			},
			budget: architectureBudget,
			closure,
			governingState: governed,
			budgetContext: {
				workItems: ledger.workItems,
				findings: [
					{
						id: "P1.1",
						effortDelta: 1,
						architectureDelta: 5,
						scopeClass: "acceptance_required",
						coupling: undefined,
					},
				],
				assessments: [],
			},
		});
		expect(approved.route).toBe("author_revision");
		expect(approved.gateCauses[0]?.resolvedBy).toBe("architecture-decision");
		expect(
			derivePlanReviewGovernance({
				mode: "enforced",
				reviewKind: "initial",
				verdict: {
					readiness: "not_ready",
					items: [item({ id: "P1.2", architectureDelta: 5 })],
				},
				budget: architectureBudget,
				closure,
				governingState: governed,
				budgetContext: {
					workItems: ledger.workItems,
					findings: [
						{
							id: "P1.2",
							effortDelta: 1,
							architectureDelta: 5,
							scopeClass: "acceptance_required",
							coupling: undefined,
						},
					],
					assessments: [],
				},
			}).route,
		).toBe("human_gate");
		expect(
			route({
				items: [
					item({ architectureDelta: 5 }),
					item({ id: "P1.2", architectureDelta: 2 }),
				],
				state: governed,
			}).route,
		).toBe("human_gate");
	});
});

describe("validateFinalCorrections", () => {
	test("checks every mechanical and cumulative forecast condition", () => {
		expect(
			validateFinalCorrections({
				items: [item()],
				projectedEffort: 5,
				effectiveCeiling: 6,
			}),
		).toEqual({ valid: true });
		const invalid = validateFinalCorrections({
			items: [
				item({
					action: "human_required",
					effortDelta: 2,
					architectureDelta: 1,
					requiresReviewerVerification: true,
					priorDecisionId: "old-decision",
				}),
			],
			projectedEffort: 5,
			effectiveCeiling: 6,
		});
		expect(invalid).toEqual({
			valid: false,
			reasons: [
				"non_auto_fix",
				"effort_exceeded",
				"architecture_change",
				"reviewer_verification_required",
				"exception_requires_review",
				"effective_ceiling_exceeded",
			],
		});
	});
});

function decision(
	choice: ReviewDecisionPayload["choice"],
): ReviewDecisionPayload {
	return {
		kind: "plan-review-governance",
		version: 1,
		decisionId: "00000000-0000-4000-8000-000000000001",
		gateId: "gate",
		snapshotId: "snapshot",
		choice,
		decisionIntentHash: `sha256:${"0".repeat(64)}`,
		findingRefs: [],
		rationale: "Human decision",
		evidence: [],
		approvedScope: { retained: [], removed: [] },
		createdAt: "2026-09-22T00:00:00.000Z",
	};
}

function snapshot(
	verdict: ReviewerVerdict,
	overrides: Partial<ReviewBudgetSnapshotRecord> = {},
): ReviewBudgetSnapshotRecord {
	const findings = verdict.items.map((entry) => ({
		id: entry.id,
		effortDelta: entry.effortDelta ?? 0,
		architectureDelta: entry.architectureDelta ?? 0,
		scopeClass: entry.scopeClass,
		coupling: entry.coupling,
	}));
	return {
		id: "snapshot",
		runId: "run",
		phase: "plan",
		iteration: 0,
		stepName: "reviewer:plan",
		currentLedger: ledger,
		findings,
		assessments: [],
		derived: deriveBudget({
			B0: 5,
			B: 5,
			I: 5,
			workItems: ledger.workItems,
			findings,
			assessments: [],
			config: thresholds,
			semanticHumanRequired: verdict.items.some(
				(entry) => entry.action === "human_required",
			),
		}),
		effectiveGateCauses: [],
		suppressedGateCauses: [],
		createdAt: "2026-09-22T00:00:00.000Z",
		...overrides,
		priorFindings: overrides.priorFindings ?? [],
		diagnostics: overrides.diagnostics ?? [],
	};
}

describe("routeAfterDecision", () => {
	test.each([
		["trade_scope", "author_revision"],
		["request_author_reestimate", "author_revision"],
		["abort", "aborted"],
	] as const)("applies the explicit %s closure", (choice, expected) => {
		const verdict = {
			readiness: "not_ready" as const,
			items: [item({ effortDelta: 4 })],
		};
		expect(
			routeAfterDecision({
				latestVerdict: verdict,
				latestBudgetSnapshot: snapshot(verdict),
				newGoverningState: state(),
				decision: decision(choice),
			}),
		).toBe(expected);
	});

	test("filters a deferred finding before budget and readiness recomputation", () => {
		const blocker = item({ effortDelta: 3 });
		const verdict = { readiness: "not_ready" as const, items: [blocker] };
		const fingerprint = canonicalFindingFingerprint({
			title: blocker.title,
			scopeClass: "acceptance_required",
			failure: blocker.failure as string,
			lowestCostCorrection: blocker.lowestCostCorrection as string,
		});
		expect(
			routeAfterDecision({
				latestVerdict: verdict,
				latestBudgetSnapshot: snapshot(verdict),
				newGoverningState: state({
					acceptedRisks: [
						{
							findingId: blocker.id,
							fingerprint,
							decisionId: "risk-decision",
							rationale: "Accepted",
							evidence: ["Compensating control"],
						},
					],
				}),
				decision: decision("defer_accept_risk"),
			}),
		).toBe("complete");
	});

	test("returns authoritative correction, revision, and successor routes", () => {
		const rows: Array<[ReviewerVerdict, ReviewDecisionRoute]> = [
			[
				{ readiness: "ready_with_corrections", items: [item()] },
				"final_corrections",
			],
			[{ readiness: "not_ready", items: [item()] }, "author_revision"],
			[
				{
					readiness: "not_ready",
					items: [item({ action: "human_required" })],
				},
				"human_gate",
			],
		];
		for (const [verdict, expected] of rows) {
			expect(
				routeAfterDecision({
					latestVerdict: verdict,
					latestBudgetSnapshot: snapshot(verdict),
					newGoverningState: state(),
					decision: decision("increase_budget"),
				}),
			).toBe(expected);
		}
	});

	test.each([
		"increase_budget",
		"adjust_baseline",
		"retain_baseline",
		"approve_architecture_burden",
	] as const)("authoritatively reruns after %s", (choice) => {
		const verdict = { readiness: "not_ready" as const, items: [item()] };
		expect(
			routeAfterDecision({
				latestVerdict: verdict,
				latestBudgetSnapshot: snapshot(verdict),
				newGoverningState: state(),
				decision: decision(choice),
			}),
		).toBe("author_revision");
	});

	test("fold changes clear budget gates or leave deterministic successors", () => {
		const overVerdict = {
			readiness: "not_ready" as const,
			items: [item({ effortDelta: 3 })],
		};
		const overSnapshot = snapshot(overVerdict);
		for (const choice of ["increase_budget", "adjust_baseline"] as const) {
			expect(
				routeAfterDecision({
					latestVerdict: overVerdict,
					latestBudgetSnapshot: overSnapshot,
					newGoverningState: state({ governingBaseline: 10 }),
					decision: decision(choice),
				}),
			).toBe("author_revision");
		}
		expect(
			routeAfterDecision({
				latestVerdict: overVerdict,
				latestBudgetSnapshot: overSnapshot,
				newGoverningState: state(),
				decision: decision("retain_baseline"),
			}),
		).toBe("human_gate");

		const semanticVerdict = {
			readiness: "not_ready" as const,
			items: [item({ effortDelta: 3, action: "human_required" as const })],
		};
		expect(
			routeAfterDecision({
				latestVerdict: semanticVerdict,
				latestBudgetSnapshot: snapshot(semanticVerdict),
				newGoverningState: state({ governingBaseline: 10 }),
				decision: decision("increase_budget"),
			}),
		).toBe("human_gate");
	});
});
