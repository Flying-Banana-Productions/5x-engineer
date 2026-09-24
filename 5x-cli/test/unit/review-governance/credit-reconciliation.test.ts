import { describe, expect, test } from "bun:test";
import { createMemoryRecordStore } from "../../../src/control-plane/record-memory.js";
import {
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
} from "../../../src/control-plane/record-types.js";
import { createReviewBudgetStore } from "../../../src/control-plane/review-budget-store.js";
import {
	decodeImplementationCreditReconciliationPayload,
	encodeImplementationCreditReconciliationPayload,
	type ImplementationBindingPayload,
	type ImplementationClaimObservation,
	type ImplementationCorrectionAttemptPayload,
} from "../../../src/review-budget/record-lines.js";
import {
	type ArchitectureDelta,
	DEFAULT_REVIEW_BUDGET_CONFIG,
	type EffortPoints,
} from "../../../src/review-budget/types.js";
import {
	implementationDueClaimObligation,
	reconcileApprovedCredits,
} from "../../../src/review-governance/credit-reconciliation.js";
import { recordCreditReconciliation } from "../../../src/review-governance/implementation-state.js";

const ORIGIN: RecordOrigin = {
	recorder: { installation_id: "00000000-0000-4000-8000-000000000001" },
	performer: { kind: "system", role: "cli" },
};
const COMMIT = "b".repeat(40);
const NEXT = "d".repeat(40);

function claim(
	id: string,
	phaseId: string,
	architectureDelta: ArchitectureDelta,
	effort: EffortPoints = 1,
): ImplementationBindingPayload["ledger"]["workItems"][number] {
	return {
		id: `W-${id}`,
		title: id,
		effort,
		architectureDelta,
		debtClaim: {
			debtClaimId: id,
			coupling: "intrinsic",
			targetPhase: phaseId,
			minimalAlternativeEffortDelta: 0,
			minimalAlternativeArchitectureDelta: 0,
			before: "many",
			after: "one",
		},
		addresses: [],
		rationale: "Approved",
		line: 1,
	};
}

function binding(input?: {
	items?: ImplementationBindingPayload["ledger"]["workItems"];
	phases?: Array<{ id: string; heading: string }>;
	b?: number;
}): ImplementationBindingPayload {
	const items = input?.items ?? [claim("DC1", "1", -3)];
	const phases = input?.phases ?? [
		{ id: "1", heading: "Phase 1" },
		{ id: "2", heading: "Phase 2" },
	];
	return {
		kind: "implementation-binding",
		version: 1,
		id: "bind-1",
		executionRunId: "run-1",
		sourceRunId: "source",
		sourceSnapshotId: "snap",
		sourceBaselineId: "base",
		approvedPlanCommit: "c".repeat(40),
		approvedPlanHash: "sha256:plan",
		approvedPlanBytes: "# Plan\n",
		b0: input?.b ?? 20,
		governingB: input?.b ?? 20,
		mode: "enforced",
		thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		ledger: {
			estimateConfidence: "high",
			workItems: items,
			surface: {
				subsystems: 1,
				productionFiles: 1,
				persistentOrExternalBoundaries: 0,
			},
		},
		effectiveDecisions: [],
		phaseMap: phases,
		debtTargets: items.flatMap((item) =>
			item.debtClaim
				? [
						{
							claimId: item.debtClaim.debtClaimId,
							sourceLabel: item.debtClaim.targetPhase,
							phaseId: item.debtClaim.targetPhase,
						},
					]
				: [],
		),
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-09-24 00:00:00",
	};
}

function realized(
	id: string,
	delta: number,
	kind: ImplementationClaimObservation["realization"] = "realized",
	commit = COMMIT,
): ImplementationClaimObservation {
	return {
		creditClaimId: id,
		realization: kind,
		realizedArchitectureDelta: delta,
		evidence: `Post-state at ${commit} matches the approved shape.`,
	};
}

function reconcile(
	overrides: Partial<Parameters<typeof reconcileApprovedCredits>[0]> = {},
) {
	const source = overrides.binding ?? binding();
	return reconcileApprovedCredits({
		binding: source,
		phase: "1",
		reviewedCommit: COMMIT,
		readiness: "ready",
		route: "complete",
		realizations: [realized("DC1", -3)],
		...overrides,
	});
}

function ok(result: ReturnType<typeof reconcile>) {
	if (result.status !== "reconciled") {
		throw new Error(`${result.code}: ${result.message}`);
	}
	return result;
}

function proof(
	overrides: Partial<ImplementationCorrectionAttemptPayload> = {},
): ImplementationCorrectionAttemptPayload {
	const carried = [realized("DC1", -3)];
	return {
		kind: "implementation-correction-attempt",
		version: 1,
		id: "attempt-1",
		runId: "run-1",
		observationId: "obs-1",
		phase: "1",
		bindingId: "bind-1",
		authorCommit: NEXT,
		tree: "tree",
		qualityConfigDigest: "sha256:quality",
		executionDirectory: "/work",
		outcome: "passed",
		shortcutInvalidated: false,
		reason: "passed",
		qualityPassed: true,
		qualitySkipped: false,
		qualityTimedOut: false,
		qualityResults: [],
		architectureDelta: 0,
		boundaryChanges: [],
		changedPaths: ["src/fix.ts"],
		inventoryClean: true,
		boundaryUncertain: false,
		sourceObservationId: "obs-1",
		assessedCommit: COMMIT,
		destinationCommit: NEXT,
		carriedClaims: carried,
		qualityRerun: 1,
		createdAt: "2026-09-24 00:00:01",
		...overrides,
	};
}

describe("approved credit reconciliation", () => {
	test("a plan-only run has no due-claim obligation", () => {
		expect(implementationDueClaimObligation(null)).toBe(false);
		expect(implementationDueClaimObligation(binding())).toBe(true);
	});

	test("no claims reconciles with zero credit", () => {
		const result = ok(
			reconcile({
				binding: binding({
					items: [
						{
							...claim("DC1", "1", -3),
							architectureDelta: 0,
							debtClaim: null,
						},
					],
				}),
				realizations: [],
			}),
		);
		expect(result.record.pendingClaimIds).toEqual([]);
		expect(result.record.completionSatisfied).toBe(true);
		expect(result.record.budget.N).toBe(0);
		expect(result.record.budget.realizedCredit).toBe(0);
		expect(result.gateCauses).toEqual([]);
	});

	test("future claims stay provisional and are not due", () => {
		const result = ok(
			reconcile({
				binding: binding({ items: [claim("LATER", "2", -3)] }),
				realizations: [],
			}),
		);
		expect(result.record.claims[0]?.status).toBe("future");
		expect(result.record.budget.provisionalCredit).toBe(3);
		expect(result.record.budget.realizedCredit).toBe(0);
		expect(result.record.completionSatisfied).toBe(true);
		expect(result.record.pendingClaimIds).toEqual([]);
	});

	test("all realized credit is spendable and does not alert", () => {
		const result = ok(reconcile());
		expect(result.record.budget.realizedCredit).toBe(3);
		expect(result.record.budget.provisionalCredit).toBe(0);
		expect(result.record.creditUnrealized).toBe(false);
		expect(result.record.completionSatisfied).toBe(true);
		expect(result.record.budget.W).toBe(1);
		expect(result.record.budget.P).toBe(0);
	});

	test("partial and not-realized are bounded and do not mint the full claim", () => {
		const partial = ok(
			reconcile({
				realizations: [realized("DC1", -1, "partial")],
			}),
		);
		expect(partial.record.budget.realizedCredit).toBe(1);
		expect(partial.record.creditUnrealized).toBe(true);
		expect(partial.record.material).toBe(false);
		expect(partial.gateCauses).toEqual([]);

		const none = ok(
			reconcile({
				realizations: [realized("DC1", 0, "not_realized")],
			}),
		);
		expect(none.record.budget.realizedCredit).toBe(0);
		expect(none.record.creditUnrealized).toBe(true);
	});

	test("multiple contributions cap D without reducing gross effort or P", () => {
		const result = ok(
			reconcile({
				binding: binding({
					items: [
						claim("A", "1", -5, 8),
						claim("B", "1", -5, 1),
						{
							...claim("POS", "1", 2, 3),
							debtClaim: null,
							architectureDelta: 2,
						},
					],
				}),
				realizations: [realized("A", -5), realized("B", -5)],
			}),
		);
		expect(result.record.budget.realizedCredit).toBe(10);
		expect(result.record.budget.N).toBe(10);
		expect(result.record.budget.D).toBe(5);
		expect(result.record.budget.W).toBe(12);
		expect(result.record.budget.R).toBe(0);
		expect(result.record.budget.P).toBe(2);
	});

	test("implementation variance and unknown negative deltas do not create credit", () => {
		const result = ok(
			reconcile({
				realizations: [realized("DC1", -3)],
			}),
		);
		expect(result.record.budget.realizedCredit).toBe(3);
		expect(result.record.budget.W).toBe(1);
		expect(result.record.budget.R).toBe(0);
		expect(result.record.budget.P).toBe(0);
		const unknown = reconcile({
			realizations: [realized("NOPE", -3)],
		});
		expect(unknown.status).toBe("rejected");
		if (unknown.status === "rejected") {
			expect(unknown.code).toBe("CREDIT_CLAIM_UNKNOWN");
		}
	});

	test("rejects duplicate, future, wrong-phase, overclaimed, and stale bindings", () => {
		expect(
			reconcile({
				realizations: [realized("DC1", -3), realized("DC1", -3)],
			}).status,
		).toBe("rejected");
		expect(
			reconcile({
				binding: binding({ items: [claim("LATER", "2", -3)] }),
				realizations: [realized("LATER", -3)],
			}),
		).toMatchObject({ status: "rejected", code: "CREDIT_CLAIM_FUTURE" });
		expect(
			reconcile({
				phase: "2",
				binding: binding({ items: [claim("EARLY", "1", -3)] }),
				realizations: [realized("EARLY", -3)],
			}),
		).toMatchObject({ status: "rejected", code: "CREDIT_CLAIM_WRONG_PHASE" });
		expect(reconcile({ realizations: [realized("DC1", -5)] })).toMatchObject({
			status: "rejected",
			code: "CREDIT_REALIZATION_INVALID",
		});
		expect(
			reconcile({
				bindingEvidence: {
					id: "bind-1",
					ledgerHash: "other",
					decisionsHash: "decisions",
				},
			}),
		).toMatchObject({ status: "rejected", code: "STALE_BINDING" });
	});

	test("a large shortfall within budget is a material gate and a small one above E is too", () => {
		const within = ok(
			reconcile({
				binding: binding({ items: [claim("DC1", "1", -5)] }),
				realizations: [realized("DC1", 0, "not_realized")],
			}),
		);
		expect(within.record.budget.budgetBand).toBe("within_standard");
		expect(within.record.material).toBe(true);
		expect(within.gateCauses[0]).toMatchObject({
			kind: "credit_shortfall",
			claimIds: ["DC1"],
		});
		expect(within.record.budget.requiresHuman).toBe(true);

		const above = ok(
			reconcile({
				binding: binding({
					items: [
						claim("DC1", "1", -5, 8),
						{ ...claim("E1", "1", 0), debtClaim: null, effort: 8 },
						{ ...claim("E2", "1", 0), debtClaim: null, effort: 8 },
						{ ...claim("E3", "1", 0), debtClaim: null, effort: 8 },
					],
				}),
				realizations: [realized("DC1", -4, "partial")],
			}),
		);
		expect(above.record.budget.W).toBe(32);
		expect(above.record.budget.E).toBeLessThan(32);
		expect(above.record.material).toBe(true);
		expect(
			above.gateCauses.some((cause) => cause.kind === "credit_shortfall"),
		).toBe(true);
	});

	test("an accepted waiver changes the credit envelope and keeps the measured post-state", () => {
		const result = ok(
			reconcile({
				binding: binding({ items: [claim("DC1", "1", -5)] }),
				realizations: [realized("DC1", 0, "not_realized")],
				humanDebtDecisions: [
					{
						kind: "waiver",
						decisionId: "dec-waive",
						creditClaimId: "DC1",
						approvedMagnitude: 0,
						active: true,
					},
				],
			}),
		);
		expect(result.record.material).toBe(false);
		expect(result.gateCauses).toEqual([]);
		expect(result.record.claims[0]).toMatchObject({
			status: "not_realized",
			realizedArchitectureDelta: 0,
			approvedArchitectureDelta: -5,
			effectiveApprovedMagnitude: 0,
			waiverDecisionId: "dec-waive",
		});
		expect(result.record.budget.realizedCredit).toBe(0);
	});

	test("restoration supersedes an observation without marking the claim realized", () => {
		const result = ok(
			reconcile({
				realizations: [],
				readiness: "ready",
				priorAssessments: [
					{
						observationId: "obs-1",
						reviewedCommit: COMMIT,
						claims: [realized("DC1", -3)],
						laterCodeChanged: false,
					},
				],
				humanDebtDecisions: [
					{
						kind: "restoration",
						decisionId: "dec-restore",
						creditClaimId: "DC1",
						supersedesObservationId: "obs-1",
						active: true,
					},
				],
			}),
		);
		expect(result.record.supersedesId).toBeNull();
		expect(result.record.supersedesObservationId).toBe("obs-1");
		expect(result.record.claims[0]?.status).toBe("pending");
		expect(result.record.budget.realizedCredit).toBe(0);
		expect(result.record.completionSatisfied).toBe(false);
		expect(result.gateCauses).toEqual([
			{ kind: "credit_unreconciled", claimIds: ["DC1"] },
		]);
	});

	test("missing due claims stay pending and block completion only when readiness is proposed", () => {
		const ready = ok(reconcile({ realizations: [], readiness: "ready" }));
		expect(ready.record.pendingClaimIds).toEqual(["DC1"]);
		expect(ready.record.completionSatisfied).toBe(false);
		expect(ready.gateCauses).toEqual([
			{ kind: "credit_unreconciled", claimIds: ["DC1"] },
		]);
		const open = ok(
			reconcile({
				realizations: [],
				readiness: "not_ready",
				route: "author_revision",
			}),
		);
		expect(open.record.pendingClaimIds).toEqual(["DC1"]);
		expect(open.record.completionSatisfied).toBe(false);
		expect(open.gateCauses).toEqual([]);
	});

	test("carry-forward accepts only the exact eligible passing proof", () => {
		const prior = {
			observationId: "obs-1",
			reviewedCommit: COMMIT,
			claims: [realized("DC1", -3)],
			laterCodeChanged: true,
		};
		const carried = ok(
			reconcile({
				phase: "1",
				reviewedCommit: NEXT,
				realizations: [],
				priorAssessments: [prior],
				correctionAttempts: [proof()],
			}),
		);
		expect(carried.record.claims[0]).toMatchObject({
			status: "realized",
			carried: true,
			sourceObservationId: "obs-1",
			assessedCommit: COMMIT,
		});
		expect(carried.record.budget.realizedCredit).toBe(3);

		const cases: Array<Partial<ImplementationCorrectionAttemptPayload>> = [
			{ sourceObservationId: "other", observationId: "other" },
			{ destinationCommit: "e".repeat(40), authorCommit: "e".repeat(40) },
			{ outcome: "passed", shortcutInvalidated: true },
			{ qualityPassed: true, inventoryClean: false },
			{ architectureDelta: 1 },
			{ boundaryChanges: ["api"] },
			{ boundaryUncertain: true },
			{ outcome: "invalidated", shortcutInvalidated: true },
		];
		for (const attempt of cases) {
			const rejected = ok(
				reconcile({
					reviewedCommit: NEXT,
					realizations: [],
					priorAssessments: [prior],
					correctionAttempts: [proof(attempt)],
				}),
			);
			expect(rejected.record.claims[0]?.status).toBe("pending");
			expect(rejected.record.budget.realizedCredit).toBe(0);
		}
	});

	test("carry-forward cannot fill a missing claim or clear a shortfall gate", () => {
		const missing = ok(
			reconcile({
				reviewedCommit: NEXT,
				realizations: [],
				priorAssessments: [
					{
						observationId: "obs-1",
						reviewedCommit: COMMIT,
						claims: [],
						laterCodeChanged: true,
					},
				],
				correctionAttempts: [proof({ carriedClaims: [realized("DC1", -3)] })],
			}),
		);
		expect(missing.record.claims[0]?.status).toBe("pending");

		const short = ok(
			reconcile({
				binding: binding({ items: [claim("DC1", "1", -5)] }),
				reviewedCommit: NEXT,
				realizations: [],
				priorAssessments: [
					{
						observationId: "obs-1",
						reviewedCommit: COMMIT,
						claims: [realized("DC1", 0, "not_realized")],
						laterCodeChanged: true,
					},
				],
				correctionAttempts: [
					proof({
						carriedClaims: [realized("DC1", 0, "not_realized")],
					}),
				],
			}),
		);
		expect(short.record.claims[0]?.status).toBe("not_realized");
		expect(short.record.material).toBe(true);
		expect(short.record.budget.realizedCredit).toBe(0);
	});

	test("reconciliation records are immutable and a later one only supersedes", () => {
		const first = ok(
			reconcile({ id: "rec-1", createdAt: "2026-09-24 00:00:00" }),
		);
		const stored = decodeImplementationCreditReconciliationPayload(
			encodeImplementationCreditReconciliationPayload(first.record),
		);
		expect(stored.claims[0]?.creditClaimId).toBe("DC1");
		const records = createMemoryRecordStore();
		records.putRun({
			id: "run-1",
			plan_path: "docs/plan.md",
			config_json: null,
			created_at: "2026-09-24 00:00:00",
			sealed_at: null,
			status: "active",
			final_head_commit: null,
			cli_version: "0.0.0",
			format_version: RUN_RECORD_FORMAT_VERSION,
			creator: ORIGIN.recorder,
		});
		const store = createReviewBudgetStore(records);
		recordCreditReconciliation({
			store,
			payload: first.record,
			origin: ORIGIN,
		});
		const later = ok(
			reconcile({
				id: "rec-2",
				createdAt: "2026-09-24 00:00:02",
				realizations: [],
				stepKey: {
					stepName: "reviewer:implementation",
					phase: "1",
					iteration: 2,
				},
				supersedesId: "rec-1",
				humanDebtDecisions: [
					{
						kind: "restoration",
						decisionId: "dec-restore",
						creditClaimId: "DC1",
						supersedesObservationId: "obs-1",
						active: true,
					},
				],
			}),
		);
		recordCreditReconciliation({
			store,
			payload: later.record,
			origin: ORIGIN,
		});
		const listed = store.listImplementationCreditReconciliations("run-1");
		expect(listed.map((record) => record.id)).toEqual(["rec-1", "rec-2"]);
		expect(listed[0]?.claims[0]?.status).toBe("realized");
		expect(listed[1]?.supersedesId).toBe("rec-1");
		expect(listed[1]?.supersedesObservationId).toBe("obs-1");
		expect(listed[1]?.claims[0]?.status).toBe("pending");
	});

	test("a past-phase settled claim stays realized when later code changes", () => {
		const phaseOne = ok(
			reconcile({
				id: "rec-phase-1",
				observationId: "obs-phase-1",
				createdAt: "2026-09-24 00:00:00",
			}),
		);
		const phaseTwo = ok(
			reconcile({
				phase: "2",
				reviewedCommit: NEXT,
				readiness: "ready",
				route: "complete",
				realizations: [],
				priorReconciliations: [phaseOne.record],
				priorAssessments: [
					{
						observationId: "obs-phase-1",
						reviewedCommit: COMMIT,
						claims: [realized("DC1", -3)],
						laterCodeChanged: true,
					},
				],
			}),
		);
		expect(phaseTwo.record.claims[0]).toMatchObject({
			creditClaimId: "DC1",
			status: "realized",
			realizedArchitectureDelta: -3,
			carried: true,
		});
		expect(phaseTwo.record.budget.realizedCredit).toBe(3);
		expect(phaseTwo.record.pendingClaimIds).toEqual([]);
		expect(phaseTwo.gateCauses).toEqual([]);
		expect(phaseTwo.record.completionSatisfied).toBe(true);
		expect(
			reconcile({
				phase: "2",
				reviewedCommit: NEXT,
				realizations: [realized("DC1", -3, "realized", NEXT)],
				priorReconciliations: [phaseOne.record],
			}),
		).toMatchObject({ status: "rejected", code: "CREDIT_CLAIM_WRONG_PHASE" });
	});

	test("a past-phase claim with no settlement stays unreconciled", () => {
		const open = ok(
			reconcile({
				phase: "1",
				realizations: [],
				readiness: "not_ready",
				route: "author_revision",
				id: "rec-open",
			}),
		);
		const later = ok(
			reconcile({
				phase: "2",
				reviewedCommit: NEXT,
				readiness: "ready",
				realizations: [],
				priorReconciliations: [open.record],
			}),
		);
		expect(later.record.claims[0]?.status).toBe("pending");
		expect(later.gateCauses).toEqual([
			{ kind: "credit_unreconciled", claimIds: ["DC1"] },
		]);
	});

	test("same-phase code changes still invalidate an assessment without a proof", () => {
		const invalidated = ok(
			reconcile({
				reviewedCommit: NEXT,
				realizations: [],
				priorAssessments: [
					{
						observationId: "obs-1",
						reviewedCommit: COMMIT,
						claims: [realized("DC1", -3)],
						laterCodeChanged: true,
					},
				],
			}),
		);
		expect(invalidated.record.claims[0]?.status).toBe("pending");
		expect(invalidated.gateCauses).toEqual([
			{ kind: "credit_unreconciled", claimIds: ["DC1"] },
		]);
	});

	test("a short commit prefix is evidence and a missing reference is advisory", () => {
		const short = ok(
			reconcile({
				realizations: [realized("DC1", -3, "realized", COMMIT.slice(0, 7))],
			}),
		);
		expect(short.record.claims[0]?.status).toBe("realized");

		const advisoryBinding = binding();
		advisoryBinding.mode = "advisory";
		const unresolved = ok(
			reconcile({
				binding: advisoryBinding,
				realizations: [
					{
						...realized("DC1", -3),
						evidence: "The stores collapsed, with no commit cited.",
					},
				],
			}),
		);
		expect(unresolved.record.claims[0]?.status).toBe("pending");
		expect(unresolved.record.budget.realizedCredit).toBe(0);
		expect(unresolved.diagnostics[0]?.code).toBe("CREDIT_EVIDENCE_UNRESOLVED");
		expect(
			reconcile({
				realizations: [
					{
						...realized("DC1", -3),
						evidence: "The stores collapsed, with no commit cited.",
					},
				],
			}),
		).toMatchObject({
			status: "rejected",
			code: "CREDIT_REALIZATION_INVALID",
		});
	});

	test("an ineligible ledger claim id is unknown", () => {
		const seed = binding({
			items: [
				{
					...claim("ADJ", "1", 0),
					architectureDelta: 0,
					debtClaim: {
						debtClaimId: "ADJ",
						coupling: "adjacent",
						targetPhase: "1",
						minimalAlternativeEffortDelta: 0,
						minimalAlternativeArchitectureDelta: 0,
						before: "many",
						after: "one",
					},
				},
			],
		});
		expect(
			reconcile({
				binding: seed,
				realizations: [realized("ADJ", -1, "partial")],
			}),
		).toMatchObject({ status: "rejected", code: "CREDIT_CLAIM_UNKNOWN" });
	});

	test("a waiver without a measurement grants no realized credit", () => {
		const result = ok(
			reconcile({
				binding: binding({ items: [claim("DC1", "1", -3)] }),
				realizations: [],
				readiness: "ready",
				humanDebtDecisions: [
					{
						kind: "waiver",
						decisionId: "dec-waive",
						creditClaimId: "DC1",
						approvedMagnitude: 2,
						active: true,
					},
				],
			}),
		);
		expect(result.record.claims[0]).toMatchObject({
			status: "waived",
			effectiveApprovedMagnitude: 2,
			realizedArchitectureDelta: null,
			evidence: null,
			approvedArchitectureDelta: -3,
		});
		expect(result.record.budget.realizedCredit).toBe(0);
		expect(result.record.completionSatisfied).toBe(true);
		expect(result.gateCauses).toEqual([]);
	});
});
