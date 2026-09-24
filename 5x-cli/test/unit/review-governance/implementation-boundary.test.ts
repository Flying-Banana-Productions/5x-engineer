import { describe, expect, test } from "bun:test";
import type {
	ImplementationBindingPayload,
	ImplementationCorrectionAttemptPayload,
	ImplementationCreditReconciliationPayload,
	ImplementationReviewContextPayload,
	ImplementationReviewObservationPayload,
} from "../../../src/review-budget/record-lines.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";
import {
	evaluateImplementationBoundary,
	exactCorrectionCarryProof,
} from "../../../src/review-governance/implementation-boundary.js";
import { hashPlanBytes } from "../../../src/review-governance/implementation-state.js";

const COMMIT = "a".repeat(40);
const PLAN = "# Plan\n- [ ] Bind\n";

function binding(
	mode: "enforced" | "advisory" = "enforced",
	bytes = PLAN,
): ImplementationBindingPayload {
	return {
		kind: "implementation-binding",
		version: 1,
		id: "bind-1",
		executionRunId: "run-1",
		sourceRunId: "source",
		sourceSnapshotId: "snap",
		sourceBaselineId: "base",
		approvedPlanCommit: COMMIT,
		approvedPlanHash: hashPlanBytes(bytes),
		approvedPlanBytes: bytes,
		b0: 20,
		governingB: 20,
		mode,
		thresholds: { ...DEFAULT_REVIEW_BUDGET_CONFIG },
		ledger: {
			estimateConfidence: "high",
			workItems: [
				{
					id: "W-DC1",
					title: "DC1",
					effort: 2,
					architectureDelta: -1,
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
					rationale: "Approved",
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
		phaseMap: [
			{ id: "1", heading: "Phase 1" },
			{ id: "2", heading: "Phase 2" },
		],
		debtTargets: [{ claimId: "DC1", sourceLabel: "1", phaseId: "1" }],
		ledgerHash: "ledger",
		decisionsHash: "decisions",
		createdAt: "2026-09-24 00:00:00",
	};
}

function observation(
	route: ImplementationReviewObservationPayload["route"],
	authorized = true,
): ImplementationReviewObservationPayload {
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
		route,
		nextAction: route === "complete" ? "complete" : "author_revision",
		diagnostics: [],
		claimObservations: [
			{
				creditClaimId: "DC1",
				realization: "realized",
				realizedArchitectureDelta: -1,
				evidence: `Post-state at ${COMMIT}`,
			},
		],
		gateCauses: [],
		telemetry: {} as ImplementationReviewObservationPayload["telemetry"],
		budgetInvariant: { W: 2, R: 0, B: 20, D: 0 },
		completionAuthorized: authorized,
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
		baseCommit: "b".repeat(40),
		reviewedCommit: COMMIT,
		patchHash: "sha256:patch",
		excludedPaths: [],
		hunks: [],
		binaryPaths: [],
		createdAt: "2026-09-24 00:00:00",
	};
}

function reconciliation(
	satisfied = true,
): ImplementationCreditReconciliationPayload {
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
		claims: [],
		pendingClaimIds: satisfied ? [] : ["DC1"],
		supersedesId: null,
		supersedesObservationId: null,
		budget: {} as ImplementationCreditReconciliationPayload["budget"],
		creditUnrealized: !satisfied,
		material: false,
		completionSatisfied: satisfied,
		createdAt: "2026-09-24 00:00:00",
	};
}

function input(
	overrides: Partial<Parameters<typeof evaluateImplementationBoundary>[0]> = {},
) {
	return evaluateImplementationBoundary({
		intent: "phase_complete",
		phase: "1",
		mode: "enforced",
		binding: binding(),
		compatibility: null,
		currentPlanBytes: PLAN,
		amendments: [],
		observations: [observation("complete")],
		contexts: [context()],
		reconciliations: [reconciliation()],
		correctionAttempts: [],
		openMaterialGatePhases: [],
		headCommit: COMMIT,
		hasImplementationHistory: true,
		hasDeliveryBudget: true,
		...overrides,
	});
}

describe("evaluateImplementationBoundary", () => {
	test("allows a reviewed reconciled phase and blocks an unbound budgeted completion", () => {
		expect(input().status).toBe("allow");
		const unbound = input({
			binding: null,
			observations: [],
			contexts: [],
			reconciliations: [],
		});
		expect(unbound.status).toBe("deny");
		expect(unbound.code).toBe("IMPLEMENTATION_APPROVAL_REQUIRED");
	});

	test("plan-only and v1 runs may seal; implementation history cannot skip binding", () => {
		expect(
			input({
				intent: "run_complete",
				phase: undefined,
				binding: null,
				hasImplementationHistory: false,
				observations: [],
				reconciliations: [],
			}).status,
		).toBe("allow");
		expect(
			input({
				intent: "run_complete",
				binding: null,
				mode: "off",
				hasImplementationHistory: true,
			}).status,
		).toBe("allow");
		const history = input({
			intent: "run_complete",
			binding: null,
			observations: [],
			reconciliations: [],
		});
		expect(history.code).toBe("IMPLEMENTATION_APPROVAL_REQUIRED");
	});

	test("advisory reports drift and missing review without blocking", () => {
		const result = input({
			binding: binding("advisory"),
			currentPlanBytes: `${PLAN}\nextra\n`,
			observations: [],
			reconciliations: [],
		});
		expect(result.status).toBe("allow");
		expect(result.readiness.planDrifted).toBe(true);
		expect(result.readiness.checklistSufficient).toBe(false);
		expect(result.diagnostics.length).toBeGreaterThan(0);
	});

	test("enforced completion denies drift, gates, and unreconciled claims", () => {
		expect(input({ currentPlanBytes: `${PLAN}changed\n` }).code).toBe(
			"IMPLEMENTATION_BOUNDARY_BLOCKED",
		);
		expect(input({ openMaterialGatePhases: ["1"] }).status).toBe("deny");
		expect(input({ reconciliations: [reconciliation(false)] }).status).toBe(
			"deny",
		);
		expect(
			input({ observations: [observation("author_revision")] }).status,
		).toBe("deny");
	});

	test("checkbox-only and verified text lineage do not count as drift", () => {
		const checked = PLAN.replace("- [ ]", "- [x]");
		expect(input({ currentPlanBytes: checked }).status).toBe("allow");
		const amended = PLAN.replace("Bind", "Bind execution");
		const approved = binding();
		expect(
			input({
				binding: approved,
				currentPlanBytes: amended.replace("- [ ]", "- [x]"),
				amendments: [
					{
						kind: "implementation-text-amendment",
						version: 1,
						id: "amend-1",
						bindingId: approved.id,
						executionRunId: "run-1",
						guardId: "guard",
						sourceObservationId: "obs-1",
						parentLineageId: null,
						beforeCommit: "c".repeat(40),
						afterCommit: COMMIT,
						beforeBlobHash: approved.approvedPlanHash,
						afterBlobHash: hashPlanBytes(amended),
						authorizedPlanBytes: amended,
						createdAt: "2026-09-24 00:00:00",
					},
				],
			}).status,
		).toBe("allow");
	});

	test("earlier unreconciled claims block advancement; same-phase repair does not require the current phase", () => {
		expect(input({ intent: "advance", phase: "1" }).status).toBe("allow");
		expect(
			input({
				intent: "advance",
				phase: "2",
				reconciliations: [],
			}).status,
		).toBe("deny");
		expect(
			input({
				intent: "phase_complete",
				phase: "2",
				observations: [],
				reconciliations: [],
			}).status,
		).toBe("deny");
	});

	test("carry-forward requires the exact eligible correction proof", () => {
		const obs = observation("final_corrections", false);
		const next = "d".repeat(40);
		const attempt = {
			kind: "implementation-correction-attempt",
			version: 1,
			id: "try-1",
			runId: "run-1",
			observationId: obs.id,
			phase: "1",
			bindingId: obs.bindingId,
			authorCommit: next,
			tree: "tree",
			qualityConfigDigest: "digest",
			executionDirectory: "/tmp",
			outcome: "passed",
			shortcutInvalidated: false,
			reason: "",
			qualityPassed: true,
			qualitySkipped: false,
			qualityTimedOut: false,
			qualityResults: [],
			architectureDelta: 0,
			boundaryChanges: [],
			changedPaths: [],
			inventoryClean: true,
			boundaryUncertain: false,
			sourceObservationId: obs.id,
			assessedCommit: COMMIT,
			destinationCommit: next,
			carriedClaims: obs.claimObservations,
			qualityRerun: 0,
			createdAt: "2026-09-24 00:00:00",
		} as ImplementationCorrectionAttemptPayload;
		expect(exactCorrectionCarryProof(attempt, obs, next)).toBe(true);
		expect(
			input({
				observations: [obs],
				correctionAttempts: [attempt],
				headCommit: next,
				reconciliations: [{ ...reconciliation(), reviewedCommit: next }],
			}).status,
		).toBe("allow");
		expect(
			input({
				observations: [obs],
				correctionAttempts: [{ ...attempt, qualitySkipped: true }],
				headCommit: next,
			}).status,
		).toBe("deny");
		expect(
			input({ headCommit: next, observations: [observation("complete")] })
				.status,
		).toBe("deny");
	});

	test("malformed evidence denies enforced and advisory completion", () => {
		expect(
			input({
				binding: binding("advisory"),
				malformed: { message: "bad record" },
			}).code,
		).toBe("IMPLEMENTATION_EVIDENCE_MALFORMED");
	});

	test("review-only commits after reviewedCommit stay fresh for completion and reconciliation", () => {
		const next = "e".repeat(40);
		const fresh = input({
			headCommit: next,
			codeEquivalentCommits: [COMMIT],
		});
		expect(fresh.status).toBe("allow");
		expect(fresh.readiness.phases[0]?.reviewed).toBe(true);
		expect(fresh.readiness.phases[0]?.claimsReconciled).toBe(true);
		const codeDelta = input({ headCommit: next });
		expect(codeDelta.status).toBe("deny");
		expect(codeDelta.readiness.phases[0]?.reviewed).toBe(false);
		expect(codeDelta.readiness.phases[0]?.claimsReconciled).toBe(false);
	});

	test("run completion checks the last phase for code added after review", () => {
		const next = "e".repeat(40);
		const phaseTwo = {
			...observation("complete"),
			id: "obs-2",
			phase: "2",
			contextId: "ctx-2",
			claimObservations: [],
		};
		const phaseTwoContext = {
			...context(),
			id: "ctx-2",
			phase: "2",
		};
		const settled = input({
			intent: "run_complete",
			phase: undefined,
			observations: [observation("complete"), phaseTwo],
			contexts: [context(), phaseTwoContext],
			headCommit: next,
			codeEquivalentCommits: [COMMIT],
		});
		expect(settled.status).toBe("allow");
		const drifted = input({
			intent: "run_complete",
			phase: undefined,
			observations: [observation("complete"), phaseTwo],
			contexts: [context(), phaseTwoContext],
			headCommit: next,
		});
		expect(drifted.status).toBe("deny");
		expect(drifted.readiness.phases.find((phase) => phase.phase === "2")?.reviewed).toBe(
			false,
		);
	});

	test("unresolved HEAD denies enforced completion and stays advisory", () => {
		const missing = input({ headCommit: null });
		expect(missing.status).toBe("deny");
		expect(missing.diagnostics.join("\n")).toContain("HEAD could not be resolved");
		const advisory = input({
			binding: binding("advisory"),
			headCommit: null,
		});
		expect(advisory.status).toBe("allow");
		expect(advisory.diagnostics.join("\n")).toContain("HEAD could not be resolved");
		expect(input({ intent: "advance", phase: "1", headCommit: null }).status).toBe(
			"allow",
		);
	});

	test("a zero-claim phase completes from the review alone", () => {
		const zero = binding();
		const source = zero.ledger.workItems[0];
		if (!source) throw new Error("missing fixture work item");
		zero.ledger = {
			...zero.ledger,
			workItems: [
				{
					...source,
					architectureDelta: 0,
					debtClaim: null,
				},
			],
		};
		zero.debtTargets = [];
		expect(
			input({
				binding: zero,
				reconciliations: [],
				observations: [{ ...observation("complete"), claimObservations: [] }],
			}).status,
		).toBe("allow");
	});
});
