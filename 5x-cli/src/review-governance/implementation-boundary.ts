/**
 * Read-only implementation admission and completion predicate.
 *
 * Enforced runs require a reviewed phase (or an exact Phase 6 correction
 * proof), reconciled due claims, no open material gate, and plan bytes that
 * match the approved text plus verified amendment lineage. Advisory runs
 * report the same findings and do not block on debt, gates, or drift.
 * A budgeted non-off execution still cannot skip binding.
 */

import type { RecordStore } from "../control-plane/record-store.js";
import type { ReviewBudgetStore } from "../control-plane/review-budget-store.js";
import type {
	ImplementationBindingPayload,
	ImplementationClaimObservation,
	ImplementationCompatibilityPayload,
	ImplementationCorrectionAttemptPayload,
	ImplementationCreditReconciliationPayload,
	ImplementationReviewContextPayload,
	ImplementationReviewObservationPayload,
	ImplementationTextAmendmentPayload,
} from "../review-budget/record-lines.js";
import {
	isCompleteDebtClaimEvidence,
	type ReviewBudgetMode,
} from "../review-budget/types.js";
import { detectPlanDrift } from "./implementation-state.js";
import { deriveOpenImplementationGate } from "./store.js";

export type ImplementationBoundaryIntent =
	| "phase_complete"
	| "run_complete"
	| "advance";

export interface ImplementationBoundaryPhaseReadiness {
	phase: string;
	reviewed: boolean;
	claimsReconciled: boolean;
	activeMaterialGate: boolean;
	ready: boolean;
}

export interface ImplementationGovernanceReadiness {
	/** True when an implementation binding imposes execution obligations. */
	executionObligations: boolean;
	/** Checked plan boxes never authorize enforced advancement. */
	checklistSufficient: false;
	planDrifted: boolean;
	bindingPresent: boolean;
	phases: ImplementationBoundaryPhaseReadiness[];
}

export interface ImplementationBoundaryResult {
	status: "allow" | "deny";
	blocking: boolean;
	code?: string;
	message?: string;
	diagnostics: string[];
	readiness: ImplementationGovernanceReadiness;
}

export interface ImplementationBoundaryInput {
	intent: ImplementationBoundaryIntent;
	/** Phase being completed or entered. Omit for run completion. */
	phase?: string;
	/** Configured mode. An existing binding pins its own mode instead. */
	mode: ReviewBudgetMode;
	binding: ImplementationBindingPayload | null;
	compatibility: ImplementationCompatibilityPayload | null;
	currentPlanBytes: string | null;
	amendments: readonly ImplementationTextAmendmentPayload[];
	observations: readonly ImplementationReviewObservationPayload[];
	contexts: readonly ImplementationReviewContextPayload[];
	reconciliations: readonly ImplementationCreditReconciliationPayload[];
	correctionAttempts: readonly ImplementationCorrectionAttemptPayload[];
	/** Phases with an unresolved material implementation gate. */
	openMaterialGatePhases: readonly string[];
	headCommit: string | null;
	hasImplementationHistory: boolean;
	hasDeliveryBudget: boolean;
	malformed?: { message: string } | null;
}

interface DueClaim {
	creditClaimId: string;
	phaseId: string;
}

function phaseIndex(
	phaseMap: readonly { id: string }[],
	phaseId: string,
): number {
	return phaseMap.findIndex((phase) => phase.id === phaseId);
}

function dueClaims(binding: ImplementationBindingPayload): DueClaim[] {
	const claims: DueClaim[] = [];
	for (const item of binding.ledger.workItems) {
		if (item.architectureDelta >= 0) continue;
		if (!isCompleteDebtClaimEvidence(item.debtClaim)) continue;
		if (item.debtClaim.coupling !== "intrinsic") continue;
		const target = binding.debtTargets.find(
			(entry) => entry.claimId === item.debtClaim.debtClaimId,
		);
		if (!target) continue;
		if (phaseIndex(binding.phaseMap, target.phaseId) < 0) continue;
		claims.push({
			creditClaimId: item.debtClaim.debtClaimId,
			phaseId: target.phaseId,
		});
	}
	return claims;
}

function claimsMatch(
	carried: readonly ImplementationClaimObservation[],
	source: readonly ImplementationClaimObservation[],
): boolean {
	if (carried.length !== source.length) return false;
	return carried.every((claim, index) => {
		const prior = source[index];
		return (
			prior !== undefined &&
			claim.creditClaimId === prior.creditClaimId &&
			claim.realization === prior.realization &&
			claim.realizedArchitectureDelta === prior.realizedArchitectureDelta &&
			claim.evidence === prior.evidence
		);
	});
}

/** Phase 6's exact eligible proof. Generic quality success is not proof. */
export function exactCorrectionCarryProof(
	attempt: ImplementationCorrectionAttemptPayload,
	observation: ImplementationReviewObservationPayload,
	destinationCommit: string,
): boolean {
	return (
		attempt.outcome === "passed" &&
		attempt.shortcutInvalidated === false &&
		attempt.qualityPassed === true &&
		attempt.qualitySkipped === false &&
		attempt.qualityTimedOut === false &&
		attempt.architectureDelta === 0 &&
		attempt.boundaryChanges.length === 0 &&
		attempt.inventoryClean === true &&
		attempt.boundaryUncertain === false &&
		attempt.bindingId === observation.bindingId &&
		attempt.observationId === observation.id &&
		attempt.sourceObservationId === observation.id &&
		attempt.authorCommit === destinationCommit &&
		attempt.destinationCommit === destinationCommit &&
		attempt.assessedCommit.length > 0 &&
		claimsMatch(attempt.carriedClaims, observation.claimObservations)
	);
}

function latestForPhase<T extends { phase: string; bindingId: string }>(
	rows: readonly T[],
	bindingId: string,
	phase: string,
): T | undefined {
	return [...rows]
		.reverse()
		.find((row) => row.bindingId === bindingId && row.phase === phase);
}

function phaseSettlement(input: {
	binding: ImplementationBindingPayload;
	phase: string;
	observations: readonly ImplementationReviewObservationPayload[];
	contexts: readonly ImplementationReviewContextPayload[];
	reconciliations: readonly ImplementationCreditReconciliationPayload[];
	correctionAttempts: readonly ImplementationCorrectionAttemptPayload[];
	openMaterialGatePhases: readonly string[];
	headCommit: string | null;
	requireHeadMatch: boolean;
}): ImplementationBoundaryPhaseReadiness {
	const observation = latestForPhase(
		input.observations,
		input.binding.id,
		input.phase,
	);
	const context = observation
		? input.contexts.find((item) => item.id === observation.contextId)
		: undefined;
	const proof =
		observation && input.headCommit
			? input.correctionAttempts.some((attempt) =>
					exactCorrectionCarryProof(
						attempt,
						observation,
						input.headCommit as string,
					),
				)
			: false;
	const reviewedCommit = context?.reviewedCommit ?? null;
	const headMatches =
		!input.requireHeadMatch ||
		input.headCommit === null ||
		reviewedCommit === input.headCommit ||
		proof;
	const ordinaryComplete =
		observation?.route === "complete" &&
		observation.completionAuthorized === true &&
		headMatches;
	const correctedComplete =
		observation?.route === "final_corrections" && proof && headMatches;
	const reviewed = ordinaryComplete || correctedComplete;

	const phaseClaims = dueClaims(input.binding).filter(
		(claim) => claim.phaseId === input.phase,
	);
	const reconciliation = latestForPhase(
		input.reconciliations,
		input.binding.id,
		input.phase,
	);
	const reconciliationFresh =
		reconciliation !== undefined &&
		(!input.requireHeadMatch ||
			input.headCommit === null ||
			reconciliation.reviewedCommit === input.headCommit ||
			proof);
	const claimsReconciled =
		phaseClaims.length === 0
			? true
			: reconciliationFresh &&
				reconciliation.completionSatisfied === true &&
				reconciliation.pendingClaimIds.length === 0 &&
				reconciliation.material === false;
	const activeMaterialGate = input.openMaterialGatePhases.includes(input.phase);
	return {
		phase: input.phase,
		reviewed: reviewed === true,
		claimsReconciled,
		activeMaterialGate,
		ready: reviewed === true && claimsReconciled && !activeMaterialGate,
	};
}

function emptyReadiness(
	executionObligations: boolean,
): ImplementationGovernanceReadiness {
	return {
		executionObligations,
		checklistSufficient: false,
		planDrifted: false,
		bindingPresent: false,
		phases: [],
	};
}

function allow(
	readiness: ImplementationGovernanceReadiness,
	diagnostics: string[] = [],
): ImplementationBoundaryResult {
	return { status: "allow", blocking: false, diagnostics, readiness };
}

function deny(
	code: string,
	message: string,
	readiness: ImplementationGovernanceReadiness,
	diagnostics: string[],
): ImplementationBoundaryResult {
	return {
		status: "deny",
		blocking: true,
		code,
		message,
		diagnostics,
		readiness,
	};
}

/**
 * Decide whether an enforced implementation boundary may advance.
 * Advisory mode keeps the diagnostics and does not deny debt, gate, or drift.
 * Missing binding on a budgeted non-off execution denies in every non-off mode.
 */
export function evaluateImplementationBoundary(
	input: ImplementationBoundaryInput,
): ImplementationBoundaryResult {
	if (input.malformed) {
		return deny(
			"IMPLEMENTATION_EVIDENCE_MALFORMED",
			input.malformed.message,
			emptyReadiness(input.binding !== null),
			[input.malformed.message],
		);
	}
	if (input.binding === null) {
		const v1 =
			input.compatibility !== null ||
			input.mode === "off" ||
			!input.hasDeliveryBudget;
		if (v1) return allow(emptyReadiness(false));
		const sealingPlanOnly =
			input.intent === "run_complete" && !input.hasImplementationHistory;
		if (sealingPlanOnly) return allow(emptyReadiness(false));
		const message =
			input.intent === "run_complete"
				? "Implementation history cannot seal without an approved execution binding."
				: "A budgeted execution must bind an approved plan before this phase boundary.";
		return deny(
			"IMPLEMENTATION_APPROVAL_REQUIRED",
			message,
			emptyReadiness(false),
			[message],
		);
	}

	const pinned = input.binding.mode;
	const drift = detectPlanDrift({
		approvedPlanBytes: input.binding.approvedPlanBytes,
		approvedPlanHash: input.binding.approvedPlanHash,
		amendments: input.amendments.filter(
			(amendment) => amendment.bindingId === input.binding?.id,
		),
		currentPlanBytes: input.currentPlanBytes ?? "",
	});
	const planMissing = input.currentPlanBytes === null;
	const phasesToCheck = phasesForIntent(
		input.binding,
		input.intent,
		input.phase,
	);
	const unknownPhase =
		input.intent !== "run_complete" &&
		(input.phase === undefined ||
			phaseIndex(input.binding.phaseMap, input.phase) < 0);
	const settlements = phasesToCheck.map((phase) =>
		phaseSettlement({
			binding: input.binding as ImplementationBindingPayload,
			phase: phase.id,
			observations: input.observations,
			contexts: input.contexts,
			reconciliations: input.reconciliations,
			correctionAttempts: input.correctionAttempts,
			openMaterialGatePhases: input.openMaterialGatePhases,
			headCommit: input.headCommit,
			requireHeadMatch: input.intent !== "advance" && phase.id === input.phase,
		}),
	);
	const readiness: ImplementationGovernanceReadiness = {
		executionObligations: true,
		checklistSufficient: false,
		planDrifted: planMissing || drift.drifted,
		bindingPresent: true,
		phases: settlements,
	};
	const diagnostics: string[] = [];
	if (unknownPhase) {
		diagnostics.push(
			`Phase ${input.phase ?? "(missing)"} is not in the approved phase map.`,
		);
	}
	if (planMissing) {
		diagnostics.push("Current plan bytes are missing.");
	} else if (drift.drifted) {
		diagnostics.push(
			drift.reason ??
				"Committed plan bytes differ from the authorized text lineage.",
		);
	} else if (!drift.chainValid) {
		diagnostics.push(
			"The text-amendment lineage is unverified. Checkbox-only matches still use the approved bytes.",
		);
	}
	for (const phase of settlements) {
		if (!phase.reviewed) {
			diagnostics.push(
				`Phase ${phase.phase} is not approved by a completion review or an exact correction proof.`,
			);
		}
		if (!phase.claimsReconciled) {
			diagnostics.push(
				`Phase ${phase.phase} has unreconciled approved claims at the completion commit.`,
			);
		}
		if (phase.activeMaterialGate) {
			diagnostics.push(`Phase ${phase.phase} has an active material gate.`);
		}
	}

	const blocked =
		unknownPhase ||
		planMissing ||
		drift.drifted ||
		settlements.some((phase) => !phase.ready);
	if (!blocked) return allow(readiness, diagnostics);
	if (pinned === "advisory") return allow(readiness, diagnostics);
	const message =
		diagnostics[0] ?? "Implementation boundary denied completion.";
	return deny(
		"IMPLEMENTATION_BOUNDARY_BLOCKED",
		message,
		readiness,
		diagnostics,
	);
}

function phasesForIntent(
	binding: ImplementationBindingPayload,
	intent: ImplementationBoundaryIntent,
	phase: string | undefined,
): Array<{ id: string }> {
	if (intent === "run_complete") return [...binding.phaseMap];
	const index = phase === undefined ? -1 : phaseIndex(binding.phaseMap, phase);
	if (index < 0) return [];
	if (intent === "advance") return binding.phaseMap.slice(0, index);
	return binding.phaseMap.slice(0, index + 1);
}

export function evaluateStoredImplementationBoundary(input: {
	store: ReviewBudgetStore;
	recordStore: RecordStore;
	runId: string;
	intent: ImplementationBoundaryIntent;
	phase?: string;
	mode: ReviewBudgetMode;
	currentPlanBytes: string | null;
	headCommit: string | null;
	hasImplementationHistory: boolean;
	hasDeliveryBudget: boolean;
}): ImplementationBoundaryResult {
	let binding: ImplementationBindingPayload | null = null;
	let compatibility: ImplementationCompatibilityPayload | null = null;
	let amendments: ImplementationTextAmendmentPayload[] = [];
	let observations: ImplementationReviewObservationPayload[] = [];
	const contexts: ImplementationReviewContextPayload[] = [];
	let reconciliations: ImplementationCreditReconciliationPayload[] = [];
	let correctionAttempts: ImplementationCorrectionAttemptPayload[] = [];
	try {
		binding = input.store.getImplementationBinding(input.runId);
		compatibility = input.store.getImplementationCompatibility(input.runId);
		if (binding) {
			amendments = input.store.listImplementationTextAmendments(
				input.runId,
				binding.id,
			);
			observations = input.store.listImplementationReviews(input.runId);
			reconciliations = input.store.listImplementationCreditReconciliations(
				input.runId,
			);
			correctionAttempts = input.store.listImplementationCorrectionAttempts(
				input.runId,
			);
			for (const observation of observations) {
				const context = input.store.getImplementationReviewContext(
					input.runId,
					observation.contextId,
				);
				if (context) contexts.push(context);
			}
		}
	} catch (error) {
		return evaluateImplementationBoundary({
			intent: input.intent,
			...(input.phase ? { phase: input.phase } : {}),
			mode: input.mode,
			binding: null,
			compatibility: null,
			currentPlanBytes: input.currentPlanBytes,
			amendments: [],
			observations: [],
			contexts: [],
			reconciliations: [],
			correctionAttempts: [],
			openMaterialGatePhases: [],
			headCommit: input.headCommit,
			hasImplementationHistory: input.hasImplementationHistory,
			hasDeliveryBudget: input.hasDeliveryBudget,
			malformed: {
				message:
					error instanceof Error
						? error.message
						: "Implementation evidence could not be read",
			},
		});
	}
	const openMaterialGatePhases: string[] = [];
	if (binding) {
		for (const phase of binding.phaseMap) {
			const gate = deriveOpenImplementationGate(
				input.recordStore,
				input.runId,
				phase.id,
			);
			if (gate) openMaterialGatePhases.push(phase.id);
		}
	}
	return evaluateImplementationBoundary({
		intent: input.intent,
		...(input.phase ? { phase: input.phase } : {}),
		mode: binding?.mode ?? input.mode,
		binding,
		compatibility,
		currentPlanBytes: input.currentPlanBytes,
		amendments,
		observations,
		contexts,
		reconciliations,
		correctionAttempts,
		openMaterialGatePhases,
		headCommit: input.headCommit,
		hasImplementationHistory: input.hasImplementationHistory,
		hasDeliveryBudget: input.hasDeliveryBudget,
	});
}
