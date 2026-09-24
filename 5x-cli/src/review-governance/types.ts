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
	/** Commits whose plan-only patch is byte-equivalent to currentPlanCommit. */
	equivalentPlanCommits?: string[];
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
			/** Stable identities that caused an architecture threshold alert. */
			itemIds?: string[];
			workItemIds?: string[];
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
	| "DEBT_AFTER_NOT_SIMPLER"
	| "PLAN_DIFF_CONTEXT_MISSING"
	| "INTRODUCED_RANGE_MISMATCH"
	| "INTRODUCED_HUNK_NOT_FOUND";

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

export type FinalCorrectionFailure =
	| "no_corrections"
	| "non_auto_fix"
	| "effort_exceeded"
	| "architecture_change"
	| "reviewer_verification_required"
	| "exception_requires_review"
	| "effective_ceiling_exceeded";

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

export type ReviewDomain = "plan" | "implementation";

export type ImplementationDiagnosticCode =
	| "PHASE_CONFLICT"
	| "UNKNOWN_PHASE"
	| "IMPLEMENTATION_CONTEXT_MISSING"
	| "IMPLEMENTATION_CONTRACT_IN_PLAN_PHASE"
	| "PLAN_CONTRACT_IN_IMPLEMENTATION_PHASE"
	| "WORK_ITEM_UNKNOWN"
	| "CREDIT_CLAIM_UNKNOWN"
	| "CREDIT_EVIDENCE_UNRESOLVED"
	| "PLAN_IMPACT_AMBIGUOUS"
	| "PLAN_IMPACT_OVERLAP"
	| "PLAN_IMPACT_PROTECTED"
	| "PLAN_IMPACT_NOT_AUTHORIZED"
	| "PRE_EXISTING_NOT_ACTIONABLE"
	| "SCOPE_EXPANSION_NOT_AUTO"
	| "SOURCE_OF_CORRECTION_PRECEDENCE"
	| "BOUNDARY_IMPACT_UNKNOWN"
	| "CRITICAL_PRE_EXISTING_REQUIRES_HUMAN"
	| "CODE_DIFF_CONTEXT_MISSING"
	| "CODE_RANGE_MISMATCH"
	| "CODE_HUNK_NOT_FOUND"
	| "CODE_HUNK_WRONG_FILE"
	| "CODE_HUNK_CONTEXT_ONLY"
	| "CODE_HUNK_BINARY"
	| "CODE_HUNK_COMBINED"
	| "CODE_HUNK_WHITESPACE"
	| "CODE_HUNK_EVIDENCE_INCOMPLETE"
	| "PRIOR_FINDING_UNKNOWN"
	| "PRIOR_FINDING_DUPLICATE"
	| "PRIOR_FINDING_OMITTED"
	| "PRIOR_FINDING_ITEM_MISSING"
	| "PRIOR_FINDING_ITEM_UNEXPECTED"
	| "NEW_FINDING_EVIDENCE_REQUIRED"
	| "CRITICAL_LATE_REQUIRES_HUMAN"
	| "PRIOR_DECISION_MISMATCH"
	| "PRIOR_DECISION_NEW_EVIDENCE_REQUIRED";

export interface ImplementationDiagnostic {
	code: ImplementationDiagnosticCode;
	severity: "error" | "info";
	message: string;
	itemId?: string;
}

export type ImplementationNextAction =
	| "plan_amendment"
	| "author_revision"
	| "human_gate"
	| "complete";

/** Human choices for an implementation gate. Plan choices stay on the plan payload. */
export type ImplementationDecisionChoice =
	| "authorize_amendment"
	| "defer_accept_risk"
	| "restore_simplification"
	| "approve_higher_burden"
	| "reduce_scope"
	| "abort";

export interface ResolvedPlanImpactSpan {
	itemId: string;
	heading: string;
	staleText: string;
	/** UTF-8 byte offset into the approved text anchor. */
	start: number;
	/** Exclusive UTF-8 byte offset. */
	end: number;
}

export interface ImplementationFindingIdentity extends FindingIdentity {
	phase: string;
	planWorkItemIds: readonly string[];
}

export interface ImplementationGovernanceResult {
	domain: "implementation";
	phase: string;
	reviewRound: number;
	route: PlanReviewRoute;
	nextAction: ImplementationNextAction;
	hypotheticalEnforcedRoute?: PlanReviewRoute;
	shortcutCandidate: boolean;
	exemptionAuthorized: boolean;
	actionableItems: VerdictItem[];
	/**
	 * Identities hashed with the admitted numeric phase. Later observation
	 * writers reuse these instead of fingerprinting without a phase.
	 */
	findingIdentities: readonly ImplementationFindingIdentity[];
	nonblockingMarkdown: string;
	diagnostics: ImplementationDiagnostic[];
}
