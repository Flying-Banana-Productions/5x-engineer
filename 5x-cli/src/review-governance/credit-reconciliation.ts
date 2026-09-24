/**
 * Approved-credit reconciliation.
 *
 * Due intrinsic claims become realized credit. Future claims stay provisional.
 * Implementation finding deltas and unknown claims never mint credit. A Phase 6
 * correction proof can carry an existing assessment to its correction commit;
 * it cannot invent assessments or clear a shortfall.
 */

import { deriveBudget } from "../review-budget/arithmetic.js";
import type {
	ImplementationBindingPayload,
	ImplementationClaimObservation,
	ImplementationCorrectionAttemptPayload,
	ImplementationCreditClaimRecord,
	ImplementationCreditReconciliationPayload,
	ImplementationObservationGateCause,
	ImplementationReviewStepKey,
} from "../review-budget/record-lines.js";
import {
	isCompleteDebtClaimEvidence,
	type ParsedWorkItem,
} from "../review-budget/types.js";
import type { ImplementationDiagnostic, PlanReviewRoute } from "./types.js";

export interface HumanDebtWaiver {
	kind: "waiver";
	decisionId: string;
	creditClaimId: string;
	/** Remaining approved magnitude. Cannot exceed the original claim. */
	approvedMagnitude: number;
	active: boolean;
}

export interface HumanDebtRestoration {
	kind: "restoration";
	decisionId: string;
	creditClaimId: string;
	supersedesObservationId: string;
	active: boolean;
}

export type HumanDebtDecision = HumanDebtWaiver | HumanDebtRestoration;

export interface PriorClaimAssessment {
	observationId: string;
	reviewedCommit: string;
	claims: readonly ImplementationClaimObservation[];
	/** True when target-phase code changed after this assessment. */
	laterCodeChanged: boolean;
}

export interface CreditReconciliationInput {
	binding: ImplementationBindingPayload;
	phase: string;
	reviewedCommit: string;
	readiness: "ready" | "ready_with_corrections" | "not_ready";
	route: PlanReviewRoute;
	realizations: readonly ImplementationClaimObservation[];
	priorAssessments?: readonly PriorClaimAssessment[];
	/**
	 * Earlier reconciliation records. Past-phase claims keep the latest
	 * settled row from their own phase.
	 */
	priorReconciliations?: readonly ImplementationCreditReconciliationPayload[];
	correctionAttempts?: readonly ImplementationCorrectionAttemptPayload[];
	humanDebtDecisions?: readonly HumanDebtDecision[];
	/**
	 * Binding id and hashes recorded independently of `binding` (a prior
	 * observation, step, or Phase 8 decision). Omit when no such record
	 * exists. Copying these fields from `binding` cannot detect staleness.
	 * Phase 8 decision records are expected to carry this fingerprint so
	 * composition can pass it here.
	 */
	bindingEvidence?: {
		id: string;
		ledgerHash: string;
		decisionsHash: string;
	};
	id?: string;
	observationId?: string;
	stepKey?: ImplementationReviewStepKey;
	supersedesId?: string | null;
	createdAt?: string;
}

export interface CreditReconciliationRejection {
	status: "rejected";
	code:
		| "CREDIT_CLAIM_DUPLICATE"
		| "CREDIT_CLAIM_UNKNOWN"
		| "CREDIT_CLAIM_FUTURE"
		| "CREDIT_CLAIM_WRONG_PHASE"
		| "CREDIT_REALIZATION_INVALID"
		| "STALE_BINDING";
	message: string;
}

export interface CreditReconciliationSuccess {
	status: "reconciled";
	record: ImplementationCreditReconciliationPayload;
	gateCauses: ImplementationObservationGateCause[];
	diagnostics: ImplementationDiagnostic[];
	/** Plan-only runs never reach this result. */
	dueClaimObligation: true;
}

export type CreditReconciliationResult =
	| CreditReconciliationRejection
	| CreditReconciliationSuccess;

interface ApprovedClaim {
	creditClaimId: string;
	phaseId: string;
	approvedArchitectureDelta: number;
	magnitude: number;
}

/** A plan-only run has no implementation binding and no due-claim obligation. */
export function implementationDueClaimObligation(
	binding: ImplementationBindingPayload | null,
): boolean {
	return binding !== null;
}

function phaseIndex(
	phaseMap: readonly { id: string }[],
	phaseId: string,
): number {
	return phaseMap.findIndex((phase) => phase.id === phaseId);
}

function proposesCompletion(input: CreditReconciliationInput): boolean {
	return (
		input.readiness === "ready" ||
		input.readiness === "ready_with_corrections" ||
		input.route === "complete" ||
		input.route === "final_corrections"
	);
}

function activeWaiver(
	decisions: readonly HumanDebtDecision[],
	claimId: string,
): HumanDebtWaiver | undefined {
	return [...decisions]
		.reverse()
		.find(
			(decision): decision is HumanDebtWaiver =>
				decision.kind === "waiver" &&
				decision.active &&
				decision.creditClaimId === claimId,
		);
}

function restored(
	decisions: readonly HumanDebtDecision[],
	observationId: string,
	claimId: string,
): boolean {
	return decisions.some(
		(decision) =>
			decision.kind === "restoration" &&
			decision.active &&
			decision.creditClaimId === claimId &&
			decision.supersedesObservationId === observationId,
	);
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

function proofCarries(
	attempt: ImplementationCorrectionAttemptPayload,
	source: PriorClaimAssessment,
	destinationCommit: string,
	bindingId: string,
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
		attempt.bindingId === bindingId &&
		attempt.observationId === source.observationId &&
		attempt.sourceObservationId === source.observationId &&
		attempt.assessedCommit === source.reviewedCommit &&
		attempt.destinationCommit === destinationCommit &&
		attempt.authorCommit === destinationCommit &&
		claimsMatch(attempt.carriedClaims, source.claims)
	);
}

function carriedAssessment(
	input: CreditReconciliationInput,
	claimId: string,
): {
	assessment: PriorClaimAssessment;
	claim: ImplementationClaimObservation;
} | null {
	const attempts = input.correctionAttempts ?? [];
	for (const prior of [...(input.priorAssessments ?? [])].reverse()) {
		if (
			restored(input.humanDebtDecisions ?? [], prior.observationId, claimId)
		) {
			continue;
		}
		const claim = prior.claims.find((item) => item.creditClaimId === claimId);
		if (!claim) continue;
		const proof = attempts.some((attempt) =>
			proofCarries(attempt, prior, input.reviewedCommit, input.binding.id),
		);
		if (proof && prior.laterCodeChanged) return { assessment: prior, claim };
		if (!prior.laterCodeChanged) return { assessment: prior, claim };
	}
	return null;
}

function approvedClaims(
	binding: ImplementationBindingPayload,
): ApprovedClaim[] | CreditReconciliationRejection {
	const seenTargets = new Set<string>();
	for (const target of binding.debtTargets) {
		if (seenTargets.has(target.claimId)) {
			return {
				status: "rejected",
				code: "STALE_BINDING",
				message: `Debt target ${target.claimId} is duplicated.`,
			};
		}
		seenTargets.add(target.claimId);
		if (phaseIndex(binding.phaseMap, target.phaseId) < 0) {
			return {
				status: "rejected",
				code: "STALE_BINDING",
				message: `Debt target ${target.claimId} phase ${target.phaseId} is not in the binding phase map.`,
			};
		}
	}
	const claims: ApprovedClaim[] = [];
	for (const item of binding.ledger.workItems) {
		const claim = eligibleClaim(item);
		if (!claim) continue;
		const target = binding.debtTargets.find(
			(entry) => entry.claimId === claim.creditClaimId,
		);
		if (!target) {
			return {
				status: "rejected",
				code: "STALE_BINDING",
				message: `Eligible claim ${claim.creditClaimId} has no normalized phase target.`,
			};
		}
		claims.push({ ...claim, phaseId: target.phaseId });
	}
	return claims;
}

function eligibleClaim(
	item: ParsedWorkItem,
): Omit<ApprovedClaim, "phaseId"> | null {
	if (item.architectureDelta >= 0) return null;
	if (!isCompleteDebtClaimEvidence(item.debtClaim)) return null;
	if (item.debtClaim.coupling !== "intrinsic") return null;
	return {
		creditClaimId: item.debtClaim.debtClaimId,
		approvedArchitectureDelta: item.architectureDelta,
		magnitude: Math.abs(item.architectureDelta),
	};
}

function validateRealization(
	claim: ImplementationClaimObservation,
	approved: ApprovedClaim,
	effectiveMagnitude: number,
): CreditReconciliationRejection | null {
	const delta = claim.realizedArchitectureDelta;
	if (!Number.isInteger(delta) || delta > 0) {
		return {
			status: "rejected",
			code: "CREDIT_REALIZATION_INVALID",
			message: `Claim ${claim.creditClaimId} rejects a positive realized delta.`,
		};
	}
	if (delta < approved.approvedArchitectureDelta) {
		return {
			status: "rejected",
			code: "CREDIT_REALIZATION_INVALID",
			message: `Claim ${claim.creditClaimId} realizes more credit than the approved delta.`,
		};
	}
	if (claim.realization === "realized" && delta !== -effectiveMagnitude) {
		return {
			status: "rejected",
			code: "CREDIT_REALIZATION_INVALID",
			message: `Claim ${claim.creditClaimId} realized requires the full approved delta ${-effectiveMagnitude}.`,
		};
	}
	if (claim.realization === "partial") {
		if (delta >= 0 || Math.abs(delta) >= effectiveMagnitude) {
			return {
				status: "rejected",
				code: "CREDIT_REALIZATION_INVALID",
				message: `Claim ${claim.creditClaimId} partial requires a strictly smaller negative magnitude.`,
			};
		}
	}
	if (claim.realization === "not_realized" && delta !== 0) {
		return {
			status: "rejected",
			code: "CREDIT_REALIZATION_INVALID",
			message: `Claim ${claim.creditClaimId} not_realized requires delta 0.`,
		};
	}
	return null;
}

/** At least a 7-hex prefix of the reviewed commit, or the full SHA. */
function evidenceReferencesCommit(
	evidence: string,
	reviewedCommit: string,
): boolean {
	const text = evidence.toLowerCase();
	const commit = reviewedCommit.toLowerCase();
	if (!text.trim()) return false;
	if (text.includes(commit)) return true;
	if (!/^[0-9a-f]{40}$/.test(commit)) return false;
	const tokens = text.match(/[0-9a-f]{7,40}/g) ?? [];
	return tokens.some((token) => commit.startsWith(token));
}

function evidenceDiagnostic(
	claimId: string,
	reviewedCommit: string,
): ImplementationDiagnostic {
	return {
		code: "CREDIT_EVIDENCE_UNRESOLVED",
		severity: "info",
		message: `Claim ${claimId} evidence must reference reviewed commit ${reviewedCommit}.`,
	};
}

/**
 * Accepted implementation claim decisions become reconciliation inputs.
 * Burden and scope reductions are waivers of the remaining magnitude.
 * Restoration reopens the superseded observation and does not waive credit.
 */
export function humanDebtDecisionsFromImplementationDecisions(
	decisions: readonly {
		decisionId: string;
		choice: string;
		claimAdjustments: readonly {
			creditClaimId: string;
			approvedArchitectureDelta: number;
			supersedesObservationId?: string;
		}[];
	}[],
): HumanDebtDecision[] {
	const mapped: HumanDebtDecision[] = [];
	for (const decision of decisions) {
		for (const adjustment of decision.claimAdjustments) {
			if (
				decision.choice === "approve_higher_burden" ||
				decision.choice === "reduce_scope"
			) {
				mapped.push({
					kind: "waiver",
					decisionId: decision.decisionId,
					creditClaimId: adjustment.creditClaimId,
					approvedMagnitude: -adjustment.approvedArchitectureDelta || 0,
					active: true,
				});
			}
			if (
				decision.choice === "restore_simplification" &&
				adjustment.supersedesObservationId
			) {
				mapped.push({
					kind: "restoration",
					decisionId: decision.decisionId,
					creditClaimId: adjustment.creditClaimId,
					supersedesObservationId: adjustment.supersedesObservationId,
					active: true,
				});
			}
		}
	}
	return mapped;
}

export function humanDebtDecisionsFromBinding(
	binding: ImplementationBindingPayload,
): HumanDebtDecision[] {
	const decisions: HumanDebtDecision[] = [];
	for (const entry of binding.effectiveDecisions) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (record.active !== true) continue;
		if (typeof record.decisionId !== "string" || !record.decisionId) continue;
		if (typeof record.creditClaimId !== "string" || !record.creditClaimId) {
			continue;
		}
		if (record.kind === "waiver") {
			if (typeof record.approvedMagnitude !== "number") continue;
			decisions.push({
				kind: "waiver",
				decisionId: record.decisionId,
				creditClaimId: record.creditClaimId,
				approvedMagnitude: record.approvedMagnitude,
				active: true,
			});
		}
		if (
			record.kind === "restoration" &&
			typeof record.supersedesObservationId === "string" &&
			record.supersedesObservationId
		) {
			decisions.push({
				kind: "restoration",
				decisionId: record.decisionId,
				creditClaimId: record.creditClaimId,
				supersedesObservationId: record.supersedesObservationId,
				active: true,
			});
		}
	}
	return decisions;
}

function settledPastClaim(
	input: CreditReconciliationInput,
	claimId: string,
	decisions: readonly HumanDebtDecision[],
): ImplementationCreditClaimRecord | null {
	const records = (input.priorReconciliations ?? []).filter(
		(record) => record.bindingId === input.binding.id,
	);
	for (const record of [...records].reverse()) {
		const entry = record.claims.find((item) => item.creditClaimId === claimId);
		if (!entry || record.phase !== entry.phaseId) continue;
		const observationIds = [
			record.observationId,
			entry.sourceObservationId,
		].filter((id): id is string => typeof id === "string" && id.length > 0);
		if (observationIds.some((id) => restored(decisions, id, claimId))) {
			return null;
		}
		if (entry.status === "pending" || entry.status === "future") return null;
		return entry;
	}
	return null;
}

function budgetSnapshot(
	derived: ReturnType<typeof deriveBudget>,
): ImplementationCreditReconciliationPayload["budget"] {
	return {
		W: derived.W,
		R: derived.R,
		B: derived.B,
		P: derived.P,
		N: derived.N,
		D: derived.D,
		E: derived.E,
		S: derived.S,
		A: derived.A,
		provisionalCredit: derived.provisionalCredit ?? 0,
		realizedCredit: derived.realizedCredit ?? 0,
		budgetBand: derived.budgetBand,
		budgetAlerts: derived.budgetAlerts,
		requiresHuman: derived.requiresHuman,
	};
}

export function reconcileApprovedCredits(
	input: CreditReconciliationInput,
): CreditReconciliationResult {
	const evidence = input.bindingEvidence;
	if (
		evidence &&
		(evidence.id !== input.binding.id ||
			evidence.ledgerHash !== input.binding.ledgerHash ||
			evidence.decisionsHash !== input.binding.decisionsHash)
	) {
		return {
			status: "rejected",
			code: "STALE_BINDING",
			message:
				"Binding evidence does not match the approved execution binding.",
		};
	}
	const currentIndex = phaseIndex(input.binding.phaseMap, input.phase);
	if (currentIndex < 0) {
		return {
			status: "rejected",
			code: "STALE_BINDING",
			message: `Phase ${input.phase} is not in the binding phase map.`,
		};
	}
	const approved = approvedClaims(input.binding);
	if (!Array.isArray(approved)) return approved;
	const approvedById = new Map(
		approved.map((claim) => [claim.creditClaimId, claim]),
	);
	const seen = new Set<string>();
	for (const realization of input.realizations) {
		if (seen.has(realization.creditClaimId)) {
			return {
				status: "rejected",
				code: "CREDIT_CLAIM_DUPLICATE",
				message: `Credit realization ${realization.creditClaimId} is duplicated.`,
			};
		}
		seen.add(realization.creditClaimId);
		const claim = approvedById.get(realization.creditClaimId);
		if (!claim) {
			return {
				status: "rejected",
				code: "CREDIT_CLAIM_UNKNOWN",
				message: `Credit realization ${realization.creditClaimId} is not an approved intrinsic claim.`,
			};
		}
		const targetIndex = phaseIndex(input.binding.phaseMap, claim.phaseId);
		if (targetIndex > currentIndex) {
			return {
				status: "rejected",
				code: "CREDIT_CLAIM_FUTURE",
				message: `Claim ${claim.creditClaimId} targets phase ${claim.phaseId}, which is not due in phase ${input.phase}.`,
			};
		}
		if (claim.phaseId !== input.phase) {
			return {
				status: "rejected",
				code: "CREDIT_CLAIM_WRONG_PHASE",
				message: `Claim ${claim.creditClaimId} targets phase ${claim.phaseId}, not phase ${input.phase}.`,
			};
		}
	}

	const decisions = input.humanDebtDecisions ?? [];
	for (const decision of decisions) {
		if (decision.kind !== "waiver" || !decision.active) continue;
		const claim = approved.find(
			(item) => item.creditClaimId === decision.creditClaimId,
		);
		if (!claim) {
			return {
				status: "rejected",
				code: "CREDIT_CLAIM_UNKNOWN",
				message: `Waiver ${decision.decisionId} names unknown claim ${decision.creditClaimId}.`,
			};
		}
		if (
			!Number.isInteger(decision.approvedMagnitude) ||
			decision.approvedMagnitude < 0 ||
			decision.approvedMagnitude > claim.magnitude
		) {
			return {
				status: "rejected",
				code: "CREDIT_REALIZATION_INVALID",
				message: `Waiver ${decision.decisionId} cannot increase approved credit.`,
			};
		}
	}

	let provisionalN = 0;
	let realizedN = 0;
	const records: ImplementationCreditClaimRecord[] = [];
	const pending: string[] = [];
	const shortfalls: ImplementationObservationGateCause & {
		kind: "credit_shortfall";
	} = {
		kind: "credit_shortfall",
		claimIds: [],
		claims: [],
	};
	let anyShortfall = false;
	let materialMagnitude = false;
	const diagnostics: ImplementationDiagnostic[] = [];

	for (const claim of approved) {
		const targetIndex = phaseIndex(input.binding.phaseMap, claim.phaseId);
		const waiver = activeWaiver(decisions, claim.creditClaimId);
		const effectiveMagnitude = waiver
			? waiver.approvedMagnitude
			: claim.magnitude;
		if (targetIndex > currentIndex) {
			provisionalN += effectiveMagnitude;
			records.push({
				creditClaimId: claim.creditClaimId,
				phaseId: claim.phaseId,
				status: "future",
				approvedArchitectureDelta: claim.approvedArchitectureDelta,
				effectiveApprovedMagnitude: effectiveMagnitude,
				realizedArchitectureDelta: null,
				evidence: null,
				assessedCommit: null,
				sourceObservationId: null,
				carried: false,
				waiverDecisionId: waiver?.decisionId ?? null,
			});
			continue;
		}

		if (claim.phaseId !== input.phase) {
			const settled = settledPastClaim(input, claim.creditClaimId, decisions);
			if (!settled || settled.realizedArchitectureDelta === null) {
				if (waiver || settled?.status === "waived") {
					records.push({
						creditClaimId: claim.creditClaimId,
						phaseId: claim.phaseId,
						status: "waived",
						approvedArchitectureDelta: claim.approvedArchitectureDelta,
						effectiveApprovedMagnitude: effectiveMagnitude,
						realizedArchitectureDelta: null,
						evidence: settled?.evidence ?? null,
						assessedCommit: settled?.assessedCommit ?? null,
						sourceObservationId: settled?.sourceObservationId ?? null,
						carried: settled !== null,
						waiverDecisionId:
							waiver?.decisionId ?? settled?.waiverDecisionId ?? null,
					});
					continue;
				}
				pending.push(claim.creditClaimId);
				records.push({
					creditClaimId: claim.creditClaimId,
					phaseId: claim.phaseId,
					status: "pending",
					approvedArchitectureDelta: claim.approvedArchitectureDelta,
					effectiveApprovedMagnitude: effectiveMagnitude,
					realizedArchitectureDelta: null,
					evidence: null,
					assessedCommit: null,
					sourceObservationId: null,
					carried: false,
					waiverDecisionId: null,
				});
				continue;
			}
			const measured = Math.abs(settled.realizedArchitectureDelta);
			const applied = Math.min(measured, effectiveMagnitude);
			realizedN += applied;
			const unrealized = effectiveMagnitude - applied;
			if (unrealized > 0) {
				anyShortfall = true;
				if (
					unrealized >= input.binding.thresholds.singleArchitectureReviewPoints
				) {
					materialMagnitude = true;
				}
				shortfalls.claimIds.push(claim.creditClaimId);
				shortfalls.claims.push({
					creditClaimId: claim.creditClaimId,
					approvedArchitectureDelta: waiver
						? -effectiveMagnitude
						: claim.approvedArchitectureDelta,
					realizedArchitectureDelta: settled.realizedArchitectureDelta,
					evidence: settled.evidence ?? "",
				});
			}
			const settledStatus =
				settled.status === "realized" ||
				settled.status === "partial" ||
				settled.status === "not_realized"
					? settled.status
					: "not_realized";
			records.push({
				creditClaimId: claim.creditClaimId,
				phaseId: claim.phaseId,
				status: settledStatus,
				approvedArchitectureDelta: claim.approvedArchitectureDelta,
				effectiveApprovedMagnitude: effectiveMagnitude,
				realizedArchitectureDelta: settled.realizedArchitectureDelta,
				evidence: settled.evidence,
				assessedCommit: settled.assessedCommit,
				sourceObservationId: settled.sourceObservationId,
				carried: true,
				waiverDecisionId: waiver?.decisionId ?? settled.waiverDecisionId,
			});
			continue;
		}

		const fresh = input.realizations.find(
			(item) => item.creditClaimId === claim.creditClaimId,
		);
		const carried = fresh
			? null
			: carriedAssessment(input, claim.creditClaimId);
		const observation = fresh ?? carried?.claim ?? null;
		if (waiver && !observation) {
			records.push({
				creditClaimId: claim.creditClaimId,
				phaseId: claim.phaseId,
				status: "waived",
				approvedArchitectureDelta: claim.approvedArchitectureDelta,
				effectiveApprovedMagnitude: effectiveMagnitude,
				realizedArchitectureDelta: null,
				evidence: null,
				assessedCommit: null,
				sourceObservationId: null,
				carried: false,
				waiverDecisionId: waiver.decisionId,
			});
			continue;
		}
		if (!observation) {
			pending.push(claim.creditClaimId);
			records.push({
				creditClaimId: claim.creditClaimId,
				phaseId: claim.phaseId,
				status: "pending",
				approvedArchitectureDelta: claim.approvedArchitectureDelta,
				effectiveApprovedMagnitude: effectiveMagnitude,
				realizedArchitectureDelta: null,
				evidence: null,
				assessedCommit: null,
				sourceObservationId: null,
				carried: false,
				waiverDecisionId: waiver?.decisionId ?? null,
			});
			continue;
		}
		const evidenceCommit = fresh
			? input.reviewedCommit
			: (carried?.assessment.reviewedCommit ?? input.reviewedCommit);
		const invalid = validateRealization(
			observation,
			claim,
			fresh ? effectiveMagnitude : claim.magnitude,
		);
		if (invalid) return invalid;
		if (!evidenceReferencesCommit(observation.evidence, evidenceCommit)) {
			const message = `Claim ${claim.creditClaimId} evidence must reference reviewed commit ${evidenceCommit}.`;
			if (input.binding.mode === "enforced") {
				return {
					status: "rejected",
					code: "CREDIT_REALIZATION_INVALID",
					message,
				};
			}
			diagnostics.push(evidenceDiagnostic(claim.creditClaimId, evidenceCommit));
			pending.push(claim.creditClaimId);
			records.push({
				creditClaimId: claim.creditClaimId,
				phaseId: claim.phaseId,
				status: "pending",
				approvedArchitectureDelta: claim.approvedArchitectureDelta,
				effectiveApprovedMagnitude: effectiveMagnitude,
				realizedArchitectureDelta: null,
				evidence: null,
				assessedCommit: null,
				sourceObservationId: null,
				carried: false,
				waiverDecisionId: waiver?.decisionId ?? null,
			});
			continue;
		}
		const measured = Math.abs(observation.realizedArchitectureDelta);
		const applied = Math.min(measured, effectiveMagnitude);
		realizedN += applied;
		const unrealized = effectiveMagnitude - applied;
		if (unrealized > 0) {
			anyShortfall = true;
			if (
				unrealized >= input.binding.thresholds.singleArchitectureReviewPoints
			) {
				materialMagnitude = true;
			}
			shortfalls.claimIds.push(claim.creditClaimId);
			shortfalls.claims.push({
				creditClaimId: claim.creditClaimId,
				approvedArchitectureDelta: waiver
					? -effectiveMagnitude
					: claim.approvedArchitectureDelta,
				realizedArchitectureDelta: observation.realizedArchitectureDelta,
				evidence: observation.evidence,
			});
		}
		records.push({
			creditClaimId: claim.creditClaimId,
			phaseId: claim.phaseId,
			status: observation.realization,
			approvedArchitectureDelta: claim.approvedArchitectureDelta,
			effectiveApprovedMagnitude: effectiveMagnitude,
			realizedArchitectureDelta: observation.realizedArchitectureDelta,
			evidence: observation.evidence,
			assessedCommit: fresh
				? input.reviewedCommit
				: (carried?.assessment.reviewedCommit ?? null),
			sourceObservationId: carried?.assessment.observationId ?? null,
			carried: !fresh && carried !== null,
			waiverDecisionId: waiver?.decisionId ?? null,
		});
	}

	const spendableN = provisionalN + realizedN;
	const derived = deriveBudget({
		B0: input.binding.b0,
		B: input.binding.governingB,
		I: null,
		workItems: input.binding.ledger.workItems,
		findings: [],
		assessments: [],
		config: input.binding.thresholds,
		semanticHumanRequired: false,
		approvedClaimContribution: {
			spendableN,
			provisionalN,
			realizedN,
			creditUnrealized: anyShortfall,
			materialCreditShortfall: false,
		},
	});
	const forecastExceeds =
		derived.projectedEffort > derived.E || derived.projectedEffort > derived.A;
	const material =
		shortfalls.claimIds.length > 0 && (forecastExceeds || materialMagnitude);
	if (material) {
		derived.requiresHuman = true;
		derived.budgetAlerts = derived.budgetAlerts.includes("credit_unrealized")
			? derived.budgetAlerts
			: [...derived.budgetAlerts, "credit_unrealized"];
	}

	const completionSatisfied = pending.length === 0;
	const gateCauses: ImplementationObservationGateCause[] = [];
	if (material) gateCauses.push(shortfalls);
	if (proposesCompletion(input) && pending.length > 0) {
		gateCauses.push({ kind: "credit_unreconciled", claimIds: [...pending] });
	}

	const stepKey = input.stepKey ?? {
		stepName: "reviewer:implementation",
		phase: input.phase,
		iteration: null,
	};
	const restoration = [...decisions]
		.reverse()
		.find(
			(decision): decision is HumanDebtRestoration =>
				decision.kind === "restoration" && decision.active,
		);
	return {
		status: "reconciled",
		dueClaimObligation: true,
		gateCauses,
		diagnostics,
		record: {
			kind: "implementation-credit-reconciliation",
			version: 1,
			id: input.id ?? "pending-credit-reconciliation",
			runId: input.binding.executionRunId,
			stepKey,
			bindingId: input.binding.id,
			observationId: input.observationId ?? "pending-observation",
			phase: input.phase,
			reviewedCommit: input.reviewedCommit,
			claims: records,
			pendingClaimIds: pending,
			supersedesId: input.supersedesId ?? null,
			supersedesObservationId: restoration?.supersedesObservationId ?? null,
			budget: budgetSnapshot(derived),
			creditUnrealized: anyShortfall,
			material,
			completionSatisfied,
			createdAt: input.createdAt ?? "",
		},
	};
}
