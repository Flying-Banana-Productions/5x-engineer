import type { ReviewerVerdict, VerdictItem } from "../protocol.js";
import type {
	BudgetAlert,
	BudgetBand,
	CouplingClass,
	PlanScopeClass,
} from "../review-budget/types.js";

export type PriorFindingStatus =
	| "addressed"
	| "partially_addressed"
	| "still_open";

export interface IntroducedByPlanHunk {
	commitRange: string;
	diffHunk: string;
	explanation: string;
}

export interface PriorDecisionEvidence {
	priorDecisionId: string;
	newEvidence: string;
}

export interface IntroducedHunkEvidence {
	kind: "introduced_hunk";
	introducedBy: IntroducedByPlanHunk;
}

export interface CriticalSafetyEvidence {
	kind: "critical_safety";
	lateDiscovery: "critical_safety";
	evidence: string;
}

export interface DecisionReraiseEvidence extends PriorDecisionEvidence {
	kind: "prior_decision_new_evidence";
}

export type BlockingFindingEvidence =
	| IntroducedHunkEvidence
	| CriticalSafetyEvidence
	| DecisionReraiseEvidence;

export type PlanReviewRoute =
	| "complete"
	| "author_revision"
	| "final_corrections"
	| "human_gate";

export type ReviewDecisionRoute = PlanReviewRoute | "aborted";

export interface FindingIdentity {
	findingId: string;
	fingerprint: string;
}

export interface PriorFindingOutcome {
	id: string;
	status: PriorFindingStatus;
}

export interface PersistedFinding extends FindingIdentity {
	title: string;
	scopeClass: PlanScopeClass;
	failure: string;
	lowestCostCorrection: string;
	status?: PriorFindingStatus;
}

/**
 * Phase-one view of a durable decision. The complete append-only payload is
 * introduced with the decision store; closure policy needs only these fields.
 */
export interface ReviewDecision {
	decisionId: string;
	choice: ReviewDecisionChoice;
	findingRefs: ReadonlyArray<FindingIdentity & { scopeClass?: PlanScopeClass }>;
	rationale?: string;
	evidence?: readonly string[];
	supersedesDecisionId?: string;
	supersededByDecisionId?: string;
	active?: boolean;
}

export type ReviewDecisionChoice =
	| "increase_budget"
	| "adjust_baseline"
	| "retain_baseline"
	| "request_author_reestimate"
	| "trade_scope"
	| "defer_accept_risk"
	| "approve_architecture_burden"
	| "abort";

export interface PlanDiffContext {
	previousReviewCommit: string;
	currentPlanCommit: string;
	planPath: string;
	patch: string;
	hunks: Array<{ header: string; text: string; hash: string }>;
}

export type DebtEligibility =
	| {
			eligible: true;
			creditClaimId: string;
			coupling: "intrinsic";
			targetPhase: string;
	  }
	| {
			eligible: false;
			creditClaimId?: string;
			reason:
				| "incomplete_evidence"
				| "non_intrinsic"
				| "not_credit_eligible"
				| "invalid_target_phase"
				| "not_simpler";
	  };

interface ReviewGateCauseBase {
	resolvedBy?: string;
}

export type ReviewGateCause =
	| (ReviewGateCauseBase & {
			kind: "budget_band";
			band: Extract<BudgetBand, "over_effective" | "over_absolute">;
	  })
	| (ReviewGateCauseBase & {
			kind: "budget_alert";
			alert: BudgetAlert;
	  })
	| (ReviewGateCauseBase & {
			kind: "semantic_human";
			finding: FindingIdentity;
	  })
	| (ReviewGateCauseBase & {
			kind: "critical_safety";
			finding: FindingIdentity;
	  })
	| (ReviewGateCauseBase & {
			kind: "adjacent_debt";
			finding: FindingIdentity;
			coupling: Extract<CouplingClass, "adjacent">;
	  });

export type ClosureDiagnosticCode =
	| "INITIAL_BASELINE_ASSESSMENT_REQUIRED"
	| "INITIAL_ITEM_FIELDS_REQUIRED"
	| "INITIAL_ITEM_FAILURE_NOT_MATERIAL"
	| "PRIOR_FINDING_UNKNOWN"
	| "PRIOR_FINDING_DUPLICATE"
	| "PRIOR_FINDING_OMITTED"
	| "PRIOR_FINDING_ITEM_MISSING"
	| "PRIOR_FINDING_ITEM_UNEXPECTED"
	| "PRIOR_FINDING_ITEM_DUPLICATE"
	| "PRIOR_FINDING_FINGERPRINT_CHANGED"
	| "NEW_FINDING_EVIDENCE_REQUIRED"
	| "INTRODUCED_AND_CRITICAL_CONFLICT"
	| "INTRODUCED_HUNK_EVIDENCE_INCOMPLETE"
	| "CRITICAL_SAFETY_SCOPE_INVALID"
	| "CRITICAL_SAFETY_EVIDENCE_REQUIRED"
	| "PRIOR_DECISION_REQUIRED"
	| "PRIOR_DECISION_STALE"
	| "PRIOR_DECISION_FINDING_MISMATCH"
	| "PRIOR_DECISION_NEW_EVIDENCE_REQUIRED"
	| "ADJACENT_DEBT_REQUIRES_HUMAN"
	| "UNRELATED_DEBT_NONBLOCKING"
	| "DEBT_EVIDENCE_INCOMPLETE"
	| "DEBT_TARGET_PHASE_INVALID"
	| "DEBT_AFTER_NOT_SIMPLER";

export interface ClosureDiagnostic {
	code: ClosureDiagnosticCode;
	severity: "error" | "info";
	message: string;
	itemId?: string;
	findingId?: string;
	decisionId?: string;
}

export interface ClosureValidationResult {
	/** True when the evidence contract has no violations. */
	valid: boolean;
	/** Advisory mode accepts a verdict while retaining all diagnostics. */
	accepted: boolean;
	diagnostics: ClosureDiagnostic[];
	requiredOutcomeIds: string[];
	findingOutcomes: Array<FindingIdentity & { status: PriorFindingStatus }>;
}

export interface PlanReviewGovernanceResult {
	reviewKind: "initial" | "closure";
	normalizedReadiness: ReviewerVerdict["readiness"];
	route: PlanReviewRoute;
	gateCauses: ReviewGateCause[];
	findingOutcomes: Array<FindingIdentity & { status: PriorFindingStatus }>;
	diagnostics: ClosureDiagnostic[];
	hypotheticalEnforcedRoute?: PlanReviewRoute;
}

/** Closure-only protocol fields, kept separate until protocol integration. */
export type GovernanceVerdictItem = VerdictItem & {
	failure?: string;
	lowestCostCorrection?: string;
	introducedBy?: IntroducedByPlanHunk;
	lateDiscovery?: "critical_safety";
	lateDiscoveryEvidence?: string;
	priorDecisionId?: string;
	newEvidence?: string;
	requiresReviewerVerification?: boolean;
};

export type GovernanceReviewerVerdict = ReviewerVerdict & {
	items: GovernanceVerdictItem[];
	priorFindings?: PriorFindingOutcome[];
};
