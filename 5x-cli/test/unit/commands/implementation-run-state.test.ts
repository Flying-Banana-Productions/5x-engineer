import { describe, expect, test } from "bun:test";
import {
	formatStateText,
	type ImplementationGovernanceClaimView,
	type ImplementationGovernanceState,
	presentImplementationGovernance,
} from "../../../src/commands/run-v1.handler.js";
import type {
	ImplementationBindingPayload,
	ImplementationCorrectionAttemptPayload,
	ImplementationCreditReconciliationPayload,
	ImplementationReviewContextPayload,
	ImplementationReviewObservationPayload,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import type { ImplementationGovernanceReadiness } from "../../../src/review-governance/implementation-boundary.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";
import type { DerivedImplementationGate } from "../../../src/review-governance/store.js";

const COMMIT = "a".repeat(40);
const BASE = "b".repeat(40);
const PLAN = "# Plan\n";

function binding(): ImplementationBindingPayload {
	return {
		kind: "implementation-binding",
		version: 1,
		id: "bind-1",
		executionRunId: "run-1",
		sourceRunId: "source-run",
		sourceSnapshotId: "snap-1",
		sourceBaselineId: "base-1",
		approvedPlanCommit: COMMIT,
		approvedPlanHash: hashPlanBytes(PLAN),
		approvedPlanBytes: PLAN,
		b0: 8,
		governingB: 8,
		mode: "enforced",
		thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		ledger: {
			estimateConfidence: "high",
			workItems: [
				{
					id: "W1",
					title: "Keep",
					effort: 3,
					architectureDelta: 2,
					debtClaim: null,
					addresses: [],
					rationale: "Burden",
					line: 1,
				},
				{
					id: "W2",
					title: "Simplify",
					effort: 2,
					architectureDelta: -3,
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
					rationale: "Credit",
					line: 2,
				},
				{
					id: "W3",
					title: "Later",
					effort: 1,
					architectureDelta: -2,
					debtClaim: {
						debtClaimId: "DC2",
						coupling: "intrinsic",
						targetPhase: "2",
						minimalAlternativeEffortDelta: 0,
						minimalAlternativeArchitectureDelta: 0,
						before: "two",
						after: "one",
					},
					addresses: [],
					rationale: "Future",
					line: 3,
				},
			],
			surface: {
				subsystems: 1,
				productionFiles: 1,
				persistentOrExternalBoundaries: 0,
			},
		},
		effectiveDecisions: [],
		phaseMap: [
			{ id: "1", heading: "Phase 1" },
			{ id: "2", heading: "Phase 2" },
		],
		debtTargets: [
			{ claimId: "DC1", sourceLabel: "1", phaseId: "1" },
			{ claimId: "DC2", sourceLabel: "2", phaseId: "2" },
		],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-09-24 00:00:00",
	};
}

function readiness(): ImplementationGovernanceReadiness {
	return {
		executionObligations: true,
		checklistSufficient: false,
		planDrifted: false,
		bindingPresent: true,
		phases: [
			{
				phase: "1",
				reviewed: true,
				claimsReconciled: true,
				activeMaterialGate: false,
				ready: true,
			},
		],
	};
}

function observation(): ImplementationReviewObservationPayload {
	return {
		kind: "implementation-review",
		version: 1,
		id: "obs-1",
		runId: "run-1",
		stepKey: { stepName: "reviewer:commit", phase: "1", iteration: 1 },
		bindingId: "bind-1",
		contextId: "ctx-1",
		domain: "implementation",
		phase: "1",
		originalVerdict:
			{} as ImplementationReviewObservationPayload["originalVerdict"],
		outcomes: [],
		route: "author_revision",
		nextAction: "author_revision",
		diagnostics: [],
		claimObservations: [],
		gateCauses: [{ kind: "credit_unreconciled", claimIds: ["DC1"] }],
		telemetry: {
			reviewCycles: 2,
			fixCycles: 1,
			reviewOriginatedCommits: 1,
			qualityReruns: 1,
			classCounts: {
				implementation_defect: 1,
				plan_defect: 0,
				scope_expansion: 0,
				pre_existing: 0,
			},
			planAmendments: 0,
			addedPaths: ["src/a.ts"],
			boundaryInventory: [],
			effortVariance: 1,
			architectureVariance: 0,
		},
		budgetInvariant: { W: 6, R: 0, B: 8, D: 0 },
		completionAuthorized: false,
		createdAt: "2026-09-24 00:00:00",
	};
}

function context(): ImplementationReviewContextPayload {
	return {
		kind: "implementation-review-context",
		version: 1,
		id: "ctx-1",
		executionRunId: "run-1",
		bindingId: "bind-1",
		phase: "1",
		baseCommit: BASE,
		reviewedCommit: COMMIT,
		patchHash: "sha256:patch",
		excludedPaths: [],
		hunks: [],
		binaryPaths: [],
		createdAt: "2026-09-24 00:00:00",
	};
}

function reconciliation(): ImplementationCreditReconciliationPayload {
	return {
		kind: "implementation-credit-reconciliation",
		version: 1,
		id: "rec-1",
		runId: "run-1",
		stepKey: { stepName: "reviewer:commit", phase: "1", iteration: 1 },
		bindingId: "bind-1",
		observationId: "obs-1",
		phase: "1",
		reviewedCommit: COMMIT,
		claims: [
			{
				creditClaimId: "DC1",
				phaseId: "1",
				status: "partial",
				approvedArchitectureDelta: -3,
				effectiveApprovedMagnitude: 3,
				realizedArchitectureDelta: -1,
				evidence: `partial at ${COMMIT}`,
				assessedCommit: COMMIT,
				sourceObservationId: "obs-1",
				carried: false,
				waiverDecisionId: null,
			},
			{
				creditClaimId: "DC2",
				phaseId: "2",
				status: "not_realized",
				approvedArchitectureDelta: -2,
				effectiveApprovedMagnitude: 2,
				realizedArchitectureDelta: 0,
				evidence: "absent",
				assessedCommit: COMMIT,
				sourceObservationId: null,
				carried: false,
				waiverDecisionId: null,
			},
		],
		pendingClaimIds: [],
		supersedesId: null,
		supersedesObservationId: null,
		budget: {
			W: 6,
			R: 0,
			B: 8,
			P: 2,
			N: 1,
			D: 1,
			E: 10,
			S: 10,
			A: 12,
			provisionalCredit: 0,
			realizedCredit: 1,
			budgetBand: "within_standard",
			budgetAlerts: ["credit_unrealized"],
			requiresHuman: false,
		},
		creditUnrealized: true,
		material: false,
		completionSatisfied: true,
		createdAt: "2026-09-24 00:00:00",
	};
}

function attempt(
	outcome: ImplementationCorrectionAttemptPayload["outcome"],
): ImplementationCorrectionAttemptPayload {
	return {
		kind: "implementation-correction-attempt",
		version: 1,
		id: "attempt-1",
		runId: "run-1",
		observationId: "obs-1",
		phase: "1",
		bindingId: "bind-1",
		authorCommit: COMMIT,
		tree: "tree",
		qualityConfigDigest: "digest",
		executionDirectory: "/tmp",
		outcome,
		shortcutInvalidated: outcome !== "passed",
		reason: outcome,
		qualityPassed: outcome === "passed",
		qualitySkipped: false,
		qualityTimedOut: false,
		qualityResults: [],
		architectureDelta: 0,
		boundaryChanges: [],
		changedPaths: ["src/a.ts"],
		inventoryClean: true,
		boundaryUncertain: false,
		sourceObservationId: "obs-1",
		assessedCommit: BASE,
		destinationCommit: COMMIT,
		carriedClaims: [],
		qualityRerun: outcome === "passed" ? 1 : 0,
		createdAt: "2026-09-24 00:00:00",
	};
}

const gate: DerivedImplementationGate = {
	domain: "implementation",
	gateId: "gate-1",
	runId: "run-1",
	observationId: "obs-1",
	bindingId: "bind-1",
	phase: "1",
	ledgerHash: "ledger",
	decisionsHash: "decisions",
	causes: [{ kind: "credit_shortfall", claimIds: ["DC1"], claims: [] }],
	resolved: false,
};

describe("implementation run state", () => {
	test("separates gross effort, ceilings, provisional credit, realized credit, and burden", () => {
		const state = presentImplementationGovernance({
			readiness: readiness(),
			binding: binding(),
			contexts: [context()],
			observations: [observation()],
			reconciliations: [reconciliation()],
			correctionAttempts: [attempt("failed")],
			activeGate: gate,
		});
		expect(state.domain).toBe("implementation");
		expect(state.phase).toBe("1");
		expect(state.checklistSufficient).toBe(false);
		expect(state.binding).toMatchObject({
			id: "bind-1",
			sourceRunId: "source-run",
			sourceSnapshotId: "snap-1",
			mode: "enforced",
		});
		expect(state.reviewedRange).toMatchObject({
			baseCommit: BASE,
			reviewedCommit: COMMIT,
			patchHash: "sha256:patch",
		});
		expect(state.activeGate?.gateId).toBe("gate-1");
		expect(state.qualityAttempt).toMatchObject({
			outcome: "failed",
			shortcutInvalidated: true,
			qualityPassed: false,
		});
		expect(state.telemetry).toMatchObject({
			reviewCycles: 2,
			effortVariance: 1,
			architectureVariance: 0,
		});
		expect(state.credit).toEqual({
			grossEffort: 6,
			inheritedBaseline: 8,
			standardCeiling: 10,
			effectiveCeiling: 10,
			absoluteCeiling: 12,
			provisionalCredit: 0,
			realizedCredit: 1,
			positiveBurden: 2,
		});
		const partial = state.claims.find((claim) => claim.creditClaimId === "DC1");
		const missed = state.claims.find((claim) => claim.creditClaimId === "DC2");
		expect(partial).toMatchObject({
			status: "partial",
			due: true,
			reconciled: true,
			approvedArchitectureDelta: -3,
			measuredArchitectureDelta: -1,
			realizedCredit: 1,
			physicallyRealized: true,
		});
		expect(missed).toMatchObject({
			status: "not_realized",
			measuredArchitectureDelta: 0,
			realizedCredit: 0,
			physicallyRealized: false,
		});
		expect(state.credit?.realizedCredit).not.toBe(3);
		expect(state.credit?.positiveBurden).toBe(2);
		expect(state.credit?.grossEffort).toBe(6);
	});

	test("a waiver is not described as physically realized credit", () => {
		const record = reconciliation();
		const current = record.claims[0];
		if (!current) throw new Error("missing claim");
		record.claims[0] = {
			...current,
			status: "waived",
			effectiveApprovedMagnitude: 0,
			realizedArchitectureDelta: null,
			waiverDecisionId: "decision-1",
		};
		record.budget = {
			...record.budget,
			provisionalCredit: 2,
			realizedCredit: 0,
			N: 2,
		};
		const state = presentImplementationGovernance({
			readiness: readiness(),
			binding: binding(),
			contexts: [context()],
			observations: [observation()],
			reconciliations: [record],
			correctionAttempts: [],
			activeGate: null,
		});
		expect(
			state.claims.find((claim) => claim.creditClaimId === "DC1"),
		).toMatchObject({
			status: "waived",
			realizedCredit: 0,
			physicallyRealized: false,
			waiverDecisionId: "decision-1",
			measuredArchitectureDelta: null,
		});
		expect(state.credit).toMatchObject({
			provisionalCredit: 2,
			realizedCredit: 0,
			positiveBurden: 2,
			grossEffort: 6,
		});
	});

	test("before reconciliation, approved credit stays provisional", () => {
		const state = presentImplementationGovernance({
			readiness: readiness(),
			binding: binding(),
			contexts: [],
			observations: [],
			reconciliations: [],
			correctionAttempts: [],
			activeGate: null,
		});
		expect(state.reviewedRange).toBeNull();
		expect(state.credit?.realizedCredit).toBe(0);
		expect(state.credit?.provisionalCredit).toBeGreaterThan(0);
		expect(state.credit?.grossEffort).toBe(6);
		expect(state.credit?.positiveBurden).toBe(2);
		expect(state.claims.every((claim) => claim.physicallyRealized)).toBe(false);
		expect(state.claims.every((claim) => claim.realizedCredit === 0)).toBe(
			true,
		);
	});

	test("text formatter tags waived and not_realized claims and separates credit", () => {
		const claim = (
			overrides: Partial<ImplementationGovernanceClaimView> &
				Pick<ImplementationGovernanceClaimView, "creditClaimId" | "status">,
		): ImplementationGovernanceClaimView => ({
			phase: "1",
			due: true,
			reconciled: true,
			approvedArchitectureDelta: -2,
			effectiveApprovedMagnitude: 2,
			measuredArchitectureDelta: null,
			realizedCredit: 0,
			physicallyRealized: false,
			waiverDecisionId: null,
			...overrides,
		});
		const governance: ImplementationGovernanceState = {
			executionObligations: true,
			checklistSufficient: false,
			planDrifted: false,
			bindingPresent: true,
			phases: [],
			domain: "implementation",
			phase: "1",
			binding: {
				id: "bind-1",
				sourceRunId: "source-run",
				sourceSnapshotId: "snap-1",
				sourceBaselineId: "base-1",
				approvedPlanCommit: COMMIT,
				mode: "enforced",
			},
			reviewedRange: null,
			activeGate: null,
			qualityAttempt: null,
			telemetry: null,
			credit: {
				grossEffort: 6,
				inheritedBaseline: 8,
				standardCeiling: 10,
				effectiveCeiling: 9,
				absoluteCeiling: 12,
				provisionalCredit: 3,
				realizedCredit: 1,
				positiveBurden: 2,
			},
			claims: [
				claim({
					creditClaimId: "DC-waived",
					status: "waived",
					waiverDecisionId: "decision-1",
					effectiveApprovedMagnitude: 0,
				}),
				claim({
					creditClaimId: "DC-missed",
					status: "not_realized",
					measuredArchitectureDelta: 0,
				}),
				claim({
					creditClaimId: "DC-kept",
					status: "realized",
					measuredArchitectureDelta: -1,
					realizedCredit: 1,
					physicallyRealized: true,
				}),
			],
		};
		const lines: string[] = [];
		const original = console.log;
		console.log = (...args: unknown[]) => lines.push(String(args[0] ?? ""));
		try {
			formatStateText({
				run: {
					id: "run-1",
					plan_path: "/plan.md",
					status: "active",
					created_at: "2026-09-24 00:00:00",
					updated_at: "2026-09-24 00:00:00",
				},
				steps: [],
				summary: {
					total_steps: 0,
					phases_completed: [],
					total_tokens_in: 0,
					total_tokens_out: 0,
					total_cost_usd: 0,
					total_duration_ms: 0,
				},
				steps_used: 0,
				max_steps: 250,
				steps_remaining: 250,
				implementation_governance: governance,
			});
		} finally {
			console.log = original;
		}
		const text = lines.join("\n");
		expect(text).toContain(
			"Implementation credit: gross_effort=6 baseline=8 standard=10 effective=9 absolute=12 provisional=3 realized=1 positive_burden=2",
		);
		expect(text).toContain(
			"DC-waived=waived measured=none credit=0 not_physically_realized",
		);
		expect(text).toContain(
			"DC-missed=not_realized measured=0 credit=0 not_physically_realized",
		);
		expect(text).toContain("DC-kept=realized measured=-1 credit=1");
		expect(text).not.toContain(
			"DC-kept=realized measured=-1 credit=1 not_physically_realized",
		);
	});
});
