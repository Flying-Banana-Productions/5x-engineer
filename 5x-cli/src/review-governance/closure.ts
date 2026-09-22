import type { ReviewerVerdict } from "../protocol.js";
import {
	isArchitectureDelta,
	isCompleteDebtClaimEvidence,
} from "../review-budget/types.js";
import {
	canonicalFindingFingerprint,
	normalizeFindingEvidenceText,
} from "./fingerprint.js";
import type {
	ClosureDiagnostic,
	ClosureValidationResult,
	DebtEligibility,
	GovernanceReviewerVerdict,
	GovernanceVerdictItem,
	PersistedFinding,
	PlanDiffContext,
	PriorFindingStatus,
	ReviewDecision,
} from "./types.js";

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function diagnostic(
	code: ClosureDiagnostic["code"],
	message: string,
	context: Pick<ClosureDiagnostic, "itemId" | "findingId" | "decisionId"> = {},
): ClosureDiagnostic {
	return { code, message, ...context };
}

function materialFailure(value: unknown): value is string {
	if (!nonEmpty(value)) return false;
	const normalized = normalizeFindingEvidenceText(value);
	return !/^(?:incomplete|incompleteness|completeness|missing detail|unclear)[.!]?$/.test(
		normalized,
	);
}

function fingerprintItem(
	item: GovernanceVerdictItem,
	fallback?: PersistedFinding,
): string | null {
	const scopeClass = item.scopeClass ?? fallback?.scopeClass;
	const failure = item.failure ?? fallback?.failure;
	const correction =
		item.lowestCostCorrection ?? fallback?.lowestCostCorrection;
	if (!scopeClass || !nonEmpty(failure) || !nonEmpty(correction)) return null;
	return canonicalFindingFingerprint({
		title: item.title || fallback?.title || "",
		scopeClass,
		failure,
		lowestCostCorrection: correction,
	});
}

function activeDecisions(
	decisions: readonly ReviewDecision[],
): ReviewDecision[] {
	const superseded = new Set(
		decisions
			.map((decision) => decision.supersedesDecisionId)
			.filter((id): id is string => nonEmpty(id)),
	);
	return decisions.filter(
		(decision) =>
			decision.active !== false &&
			!decision.supersededByDecisionId &&
			!superseded.has(decision.decisionId),
	);
}

function isRiskDecision(decision: ReviewDecision): boolean {
	return (
		decision.choice === "defer_accept_risk" ||
		decision.choice === "defer" ||
		decision.choice === "accept_risk"
	);
}

function decisionFindingRef(
	decision: ReviewDecision,
	findingId: string,
): ReviewDecision["findingRefs"][number] | undefined {
	return decision.findingRefs.find((ref) => ref.findingId === findingId);
}

function validateInitialItem(item: GovernanceVerdictItem): ClosureDiagnostic[] {
	const diagnostics: ClosureDiagnostic[] = [];
	if (
		!item.scopeClass ||
		!Number.isInteger(item.effortDelta) ||
		(item.effortDelta ?? -1) < 0 ||
		!isArchitectureDelta(item.architectureDelta) ||
		!item.estimateConfidence ||
		!nonEmpty(item.lowestCostCorrection)
	) {
		diagnostics.push(
			diagnostic(
				"INITIAL_ITEM_FIELDS_REQUIRED",
				`Finding '${item.id}' requires scope, effort/architecture deltas, estimate confidence, and a lowest-cost correction.`,
				{ itemId: item.id },
			),
		);
	}
	if (!materialFailure(item.failure)) {
		diagnostics.push(
			diagnostic(
				"INITIAL_ITEM_FAILURE_NOT_MATERIAL",
				`Finding '${item.id}' must name the material requirement or system failure it prevents.`,
				{ itemId: item.id },
			),
		);
	}
	return diagnostics;
}

function validTargetPhase(value: string): boolean {
	return /^phase(?:[-_\s]+)?(?:0|[1-9]\d*)(?:[._-][a-z0-9]+)*$/i.test(
		value.trim(),
	);
}

export function assessDebtEligibility(
	item: GovernanceVerdictItem,
	verdict: ReviewerVerdict,
): DebtEligibility | null {
	if (!item.creditClaim) return null;
	const claim = {
		debtClaimId: item.creditClaim.creditClaimId,
		coupling: item.coupling,
		targetPhase: item.creditClaim.targetPhase,
		minimalAlternativeEffortDelta:
			item.creditClaim.minimalAlternativeEffortDelta,
		minimalAlternativeArchitectureDelta:
			item.creditClaim.minimalAlternativeArchitectureDelta,
		before: item.creditClaim.before,
		after: item.creditClaim.after,
	};
	if (!isCompleteDebtClaimEvidence(claim)) {
		return {
			eligible: false,
			creditClaimId: item.creditClaim.creditClaimId,
			reason: "incomplete_evidence",
		};
	}
	if (item.coupling !== "intrinsic" || claim.coupling !== "intrinsic") {
		return {
			eligible: false,
			creditClaimId: item.creditClaim.creditClaimId,
			reason: "non_intrinsic",
		};
	}
	const assessment = verdict.creditAssessments?.find(
		(entry) => entry.creditClaimId === item.creditClaim?.creditClaimId,
	);
	if (
		assessment?.eligibility !== "eligible" ||
		assessment.coupling !== "intrinsic"
	) {
		return {
			eligible: false,
			creditClaimId: item.creditClaim.creditClaimId,
			reason: "reviewer_ineligible",
		};
	}
	if (!validTargetPhase(claim.targetPhase)) {
		return {
			eligible: false,
			creditClaimId: item.creditClaim.creditClaimId,
			reason: "invalid_target_phase",
		};
	}
	const before = normalizeFindingEvidenceText(claim.before);
	const after = normalizeFindingEvidenceText(claim.after);
	if (
		before === after ||
		(item.architectureDelta ?? 0) >= claim.minimalAlternativeArchitectureDelta
	) {
		return {
			eligible: false,
			creditClaimId: item.creditClaim.creditClaimId,
			reason: "not_simpler",
		};
	}
	return {
		eligible: true,
		creditClaimId: item.creditClaim.creditClaimId,
		coupling: "intrinsic",
		targetPhase: claim.targetPhase,
	};
}

export function validateDebtPolicy(
	verdict: ReviewerVerdict,
): ClosureDiagnostic[] {
	const governed = verdict as GovernanceReviewerVerdict;
	const diagnostics: ClosureDiagnostic[] = [];
	for (const item of governed.items) {
		if (item.coupling === "adjacent" && item.action !== "human_required") {
			diagnostics.push(
				diagnostic(
					"ADJACENT_DEBT_REQUIRES_HUMAN",
					`Adjacent debt finding '${item.id}' must use action 'human_required'.`,
					{ itemId: item.id },
				),
			);
		}
		if (item.coupling === "unrelated") {
			diagnostics.push(
				diagnostic(
					"UNRELATED_DEBT_NONBLOCKING",
					`Unrelated debt finding '${item.id}' belongs in the nonblocking review follow-up, not routing items.`,
					{ itemId: item.id },
				),
			);
		}
		const eligibility = assessDebtEligibility(item, verdict);
		if (!eligibility || eligibility.eligible) continue;
		const codeByReason: Record<
			typeof eligibility.reason,
			ClosureDiagnostic["code"]
		> = {
			incomplete_evidence: "DEBT_EVIDENCE_INCOMPLETE",
			reviewer_ineligible: "DEBT_REVIEWER_INELIGIBLE",
			non_intrinsic: "DEBT_COUPLING_INELIGIBLE",
			invalid_target_phase: "DEBT_TARGET_PHASE_INVALID",
			not_simpler: "DEBT_AFTER_NOT_SIMPLER",
		};
		diagnostics.push(
			diagnostic(
				codeByReason[eligibility.reason],
				`Debt claim on finding '${item.id}' is ineligible: ${eligibility.reason.replaceAll("_", " ")}.`,
				{ itemId: item.id },
			),
		);
	}
	return diagnostics;
}

function validateCriticalSafety(
	item: GovernanceVerdictItem,
): ClosureDiagnostic[] {
	const diagnostics: ClosureDiagnostic[] = [];
	if (
		item.scopeClass !== "acceptance_required" &&
		item.scopeClass !== "risk_reduction"
	) {
		diagnostics.push(
			diagnostic(
				"CRITICAL_SAFETY_SCOPE_INVALID",
				`Critical late finding '${item.id}' must be acceptance-required or risk-reduction scope.`,
				{ itemId: item.id },
			),
		);
	}
	const evidence = `${item.failure ?? ""} ${item.lateDiscoveryEvidence ?? ""}`;
	if (
		!nonEmpty(item.lateDiscoveryEvidence) ||
		!/(security|vulnerab|authori[sz]ation|data[ -]?loss|corrupt|correctness|incorrect|wrong result|integrity)/i.test(
			evidence,
		)
	) {
		diagnostics.push(
			diagnostic(
				"CRITICAL_SAFETY_EVIDENCE_REQUIRED",
				`Critical late finding '${item.id}' must give concrete security, data-loss, or correctness evidence.`,
				{ itemId: item.id },
			),
		);
	}
	return diagnostics;
}

function validateIntroducedBy(
	item: GovernanceVerdictItem,
): ClosureDiagnostic[] {
	if (
		item.introducedBy &&
		nonEmpty(item.introducedBy.commitRange) &&
		nonEmpty(item.introducedBy.diffHunk) &&
		nonEmpty(item.introducedBy.explanation)
	) {
		return [];
	}
	return [
		diagnostic(
			"INTRODUCED_HUNK_EVIDENCE_INCOMPLETE",
			`Introduced finding '${item.id}' requires a commit range, complete diff hunk, and causal explanation.`,
			{ itemId: item.id },
		),
	];
}

function validateReraise(
	item: GovernanceVerdictItem,
	prior: PersistedFinding | undefined,
	decisions: readonly ReviewDecision[],
): ClosureDiagnostic[] {
	const diagnostics: ClosureDiagnostic[] = [];
	if (!nonEmpty(item.priorDecisionId)) {
		return [
			diagnostic(
				"PRIOR_DECISION_REQUIRED",
				`Re-raised finding '${item.id}' must name its prior risk decision.`,
				{ itemId: item.id, findingId: item.id },
			),
		];
	}
	const decision = decisions.find(
		(entry) => entry.decisionId === item.priorDecisionId,
	);
	if (!decision || !isRiskDecision(decision)) {
		diagnostics.push(
			diagnostic(
				"PRIOR_DECISION_STALE",
				`Finding '${item.id}' names a missing, inactive, or non-risk decision.`,
				{
					itemId: item.id,
					findingId: item.id,
					decisionId: item.priorDecisionId,
				},
			),
		);
		return diagnostics;
	}
	const ref = decisionFindingRef(decision, item.id);
	const fingerprint = fingerprintItem(item, prior);
	if (
		!ref ||
		!prior ||
		!fingerprint ||
		ref.fingerprint !== fingerprint ||
		(ref.scopeClass !== undefined && ref.scopeClass !== item.scopeClass) ||
		prior.scopeClass !== item.scopeClass
	) {
		diagnostics.push(
			diagnostic(
				"PRIOR_DECISION_FINDING_MISMATCH",
				`Finding '${item.id}' no longer matches the fingerprint and scope approved by decision '${decision.decisionId}'.`,
				{
					itemId: item.id,
					findingId: item.id,
					decisionId: decision.decisionId,
				},
			),
		);
	}
	const normalizedEvidence = nonEmpty(item.newEvidence)
		? normalizeFindingEvidenceText(item.newEvidence)
		: "";
	const oldEvidence = [decision.rationale ?? "", ...(decision.evidence ?? [])]
		.map(normalizeFindingEvidenceText)
		.filter(Boolean);
	if (!normalizedEvidence || oldEvidence.includes(normalizedEvidence)) {
		diagnostics.push(
			diagnostic(
				"PRIOR_DECISION_NEW_EVIDENCE_REQUIRED",
				`Finding '${item.id}' requires material evidence not already considered by decision '${decision.decisionId}'.`,
				{
					itemId: item.id,
					findingId: item.id,
					decisionId: decision.decisionId,
				},
			),
		);
	}
	return diagnostics;
}

export function validateClosureReview(input: {
	reviewKind: "initial" | "closure";
	mode: "advisory" | "enforced";
	verdict: ReviewerVerdict;
	priorFindings: readonly PersistedFinding[];
	priorDecisions: readonly ReviewDecision[];
	diffContext?: PlanDiffContext;
}): ClosureValidationResult {
	const verdict = input.verdict as GovernanceReviewerVerdict;
	const diagnostics: ClosureDiagnostic[] = [];
	const latestFindings = new Map<string, PersistedFinding>();
	for (const finding of input.priorFindings)
		latestFindings.set(finding.findingId, finding);
	const decisions = activeDecisions(input.priorDecisions);
	const coveredFindingIds = new Set(
		[...latestFindings.values()]
			.filter((finding) =>
				decisions.some((decision) => {
					if (!isRiskDecision(decision)) return false;
					const ref = decisionFindingRef(decision, finding.findingId);
					return (
						ref?.fingerprint === finding.fingerprint &&
						(ref.scopeClass === undefined ||
							ref.scopeClass === finding.scopeClass)
					);
				}),
			)
			.map((finding) => finding.findingId),
	);
	const requiredFindings = [...latestFindings.values()].filter(
		(finding) =>
			finding.status !== "addressed" &&
			!coveredFindingIds.has(finding.findingId),
	);
	const requiredIds = new Set(
		requiredFindings.map((finding) => finding.findingId),
	);

	if (input.reviewKind === "initial") {
		if (!verdict.baselineAssessment) {
			diagnostics.push(
				diagnostic(
					"INITIAL_BASELINE_ASSESSMENT_REQUIRED",
					"Initial plan review requires an independent baseline assessment.",
				),
			);
		}
		for (const item of verdict.items)
			diagnostics.push(...validateInitialItem(item));
	} else {
		const outcomes = verdict.priorFindings ?? [];
		const outcomesById = new Map<string, PriorFindingStatus>();
		for (const outcome of outcomes) {
			if (!requiredIds.has(outcome.id)) {
				diagnostics.push(
					diagnostic(
						"PRIOR_FINDING_UNKNOWN",
						`Prior-finding outcome '${outcome.id}' is not required in this closure review.`,
						{ findingId: outcome.id },
					),
				);
			}
			if (outcomesById.has(outcome.id)) {
				diagnostics.push(
					diagnostic(
						"PRIOR_FINDING_DUPLICATE",
						`Prior-finding outcome '${outcome.id}' appears more than once.`,
						{ findingId: outcome.id },
					),
				);
			}
			outcomesById.set(outcome.id, outcome.status);
		}
		for (const finding of requiredFindings) {
			if (!outcomesById.has(finding.findingId)) {
				diagnostics.push(
					diagnostic(
						"PRIOR_FINDING_OMITTED",
						`Closure review omitted prior finding '${finding.findingId}'.`,
						{ findingId: finding.findingId },
					),
				);
			}
		}

		const itemCounts = new Map<string, number>();
		for (const item of verdict.items)
			itemCounts.set(item.id, (itemCounts.get(item.id) ?? 0) + 1);
		for (const finding of requiredFindings) {
			const status = outcomesById.get(finding.findingId);
			const count = itemCounts.get(finding.findingId) ?? 0;
			if (count > 1) {
				diagnostics.push(
					diagnostic(
						"PRIOR_FINDING_ITEM_DUPLICATE",
						`Prior finding '${finding.findingId}' appears more than once in routing items.`,
						{ findingId: finding.findingId },
					),
				);
			}
			if (
				(status === "partially_addressed" || status === "still_open") &&
				count !== 1
			) {
				diagnostics.push(
					diagnostic(
						"PRIOR_FINDING_ITEM_MISSING",
						`Prior finding '${finding.findingId}' is ${status} and must appear once in routing items.`,
						{ findingId: finding.findingId },
					),
				);
			}
			if (status === "addressed" && count !== 0) {
				diagnostics.push(
					diagnostic(
						"PRIOR_FINDING_ITEM_UNEXPECTED",
						`Addressed prior finding '${finding.findingId}' must not remain in routing items.`,
						{ findingId: finding.findingId },
					),
				);
			}
			const item = verdict.items.find(
				(entry) => entry.id === finding.findingId,
			);
			if (
				item &&
				(!Number.isInteger(item.effortDelta) || (item.effortDelta ?? -1) < 0)
			) {
				diagnostics.push(
					diagnostic(
						"INITIAL_ITEM_FIELDS_REQUIRED",
						`Remaining prior finding '${finding.findingId}' requires a non-negative remaining effortDelta.`,
						{ itemId: item.id, findingId: finding.findingId },
					),
				);
			}
			const currentFingerprint = item ? fingerprintItem(item, finding) : null;
			if (
				item &&
				currentFingerprint &&
				currentFingerprint !== finding.fingerprint
			) {
				diagnostics.push(
					diagnostic(
						"PRIOR_FINDING_FINGERPRINT_CHANGED",
						`Prior finding '${finding.findingId}' changed its canonical identity.`,
						{ itemId: item.id, findingId: finding.findingId },
					),
				);
			}
		}

		for (const item of verdict.items) {
			if (requiredIds.has(item.id)) continue;
			const prior = latestFindings.get(item.id);
			const coveringDecision = decisions.find(
				(decision) =>
					isRiskDecision(decision) &&
					decisionFindingRef(decision, item.id) !== undefined,
			);
			if (coveringDecision || item.priorDecisionId) {
				diagnostics.push(...validateReraise(item, prior, decisions));
				continue;
			}
			if (item.introducedBy && item.lateDiscovery) {
				diagnostics.push(
					diagnostic(
						"INTRODUCED_AND_CRITICAL_CONFLICT",
						`Finding '${item.id}' cannot be both introduced by this revision and a pre-existing critical late discovery.`,
						{ itemId: item.id },
					),
				);
			} else if (item.lateDiscovery === "critical_safety") {
				diagnostics.push(...validateCriticalSafety(item));
			} else if (item.introducedBy) {
				diagnostics.push(...validateIntroducedBy(item));
			} else {
				diagnostics.push(
					diagnostic(
						"NEW_FINDING_EVIDENCE_REQUIRED",
						`New closure finding '${item.id}' requires an introducing plan hunk or critical-safety evidence.`,
						{ itemId: item.id },
					),
				);
			}
		}
	}

	diagnostics.push(...validateDebtPolicy(verdict));
	const findingOutcomes = requiredFindings.flatMap((finding) => {
		const status = verdict.priorFindings?.find(
			(outcome) => outcome.id === finding.findingId,
		)?.status;
		return status
			? [
					{
						findingId: finding.findingId,
						fingerprint: finding.fingerprint,
						status,
					},
				]
			: [];
	});
	return {
		valid: diagnostics.length === 0,
		accepted: input.mode === "advisory" || diagnostics.length === 0,
		diagnostics,
		requiredOutcomeIds: requiredFindings.map((finding) => finding.findingId),
		findingOutcomes,
	};
}
