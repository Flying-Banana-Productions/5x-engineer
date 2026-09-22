import type { ReviewBudgetSnapshotRecord } from "../control-plane/review-budget-store.js";
import type { ReviewerVerdict, VerdictItem } from "../protocol.js";
import { deriveBudget } from "../review-budget/arithmetic.js";
import type {
	CreditAssessmentInput,
	DerivedBudgetResult,
	FindingDelta,
	ParsedWorkItem,
} from "../review-budget/types.js";
import type {
	GoverningReviewState,
	ReviewDecisionPayload,
} from "./decisions.js";
import { fingerprintVerdictItem } from "./fingerprint.js";
import type {
	ClosureValidationResult,
	FinalCorrectionFailure,
	FindingIdentity,
	PlanReviewGovernanceResult,
	PlanReviewRoute,
	ReviewDecisionRoute,
	ReviewGateCause,
} from "./types.js";

export interface ArchitectureRoutingContext {
	itemIds: readonly string[];
	workItemIds: readonly string[];
}

export interface ReviewBudgetRoutingContext {
	workItems: readonly ParsedWorkItem[];
	findings: readonly FindingDelta[];
	assessments: readonly CreditAssessmentInput[];
}

export interface DerivePlanReviewGovernanceInput {
	mode: "advisory" | "enforced";
	reviewKind: "initial" | "closure";
	verdict: ReviewerVerdict;
	budget: DerivedBudgetResult;
	closure: ClosureValidationResult;
	governingState: GoverningReviewState;
	/** Full plan-208 inputs; routing reruns canonical arithmetic after filtering. */
	budgetContext: ReviewBudgetRoutingContext;
}

function findingIdentity(
	item: VerdictItem,
	findingOutcomes: readonly FindingIdentity[],
	state: GoverningReviewState,
): FindingIdentity | null {
	const outcome = findingOutcomes.find(
		(candidate) => candidate.findingId === item.id,
	);
	if (outcome) return outcome;
	const accepted = state.acceptedRisks.find(
		(candidate) => candidate.findingId === item.id,
	);
	if (accepted && (!item.failure || !item.lowestCostCorrection))
		return { findingId: accepted.findingId, fingerprint: accepted.fingerprint };
	return { findingId: item.id, fingerprint: fingerprintVerdictItem(item) };
}

function sameFinding(a: FindingIdentity, b: FindingIdentity): boolean {
	return a.findingId === b.findingId && a.fingerprint === b.fingerprint;
}

function activeItems(
	items: readonly VerdictItem[],
	state: GoverningReviewState,
	findingOutcomes: readonly FindingIdentity[],
): VerdictItem[] {
	return items.filter((item) => {
		const identity = findingIdentity(item, findingOutcomes, state);
		if (!identity) return true;
		const accepted = state.acceptedRisks.find((risk) =>
			sameFinding(risk, identity),
		);
		if (!accepted) return true;
		// Closure validation has already established whether a re-raise is valid.
		return (
			item.priorDecisionId === accepted.decisionId &&
			Boolean(item.newEvidence?.trim())
		);
	});
}

function architectureApproval(
	budget: DerivedBudgetResult,
	state: GoverningReviewState,
	context: ArchitectureRoutingContext,
): string | undefined {
	for (const approval of [...state.architectureApprovals].reverse()) {
		if (budget.P > approval.approvedP) continue;
		if (!context.itemIds.every((id) => approval.approvedItemIds.includes(id)))
			continue;
		if (
			!context.workItemIds.every((id) =>
				approval.approvedWorkItemIds.includes(id),
			)
		)
			continue;
		return approval.decisionId;
	}
	return undefined;
}

function causesFor(input: {
	items: readonly VerdictItem[];
	budget: DerivedBudgetResult;
	state: GoverningReviewState;
	architectureContext: ArchitectureRoutingContext;
	findingOutcomes: readonly FindingIdentity[];
}): ReviewGateCause[] {
	const causes: ReviewGateCause[] = [];
	if (
		input.budget.budgetBand === "over_effective" ||
		input.budget.budgetBand === "over_absolute"
	) {
		causes.push({ kind: "budget_band", band: input.budget.budgetBand });
	}
	for (const alert of input.budget.budgetAlerts) {
		if (alert === "credit_unrealized") continue;
		if (alert === "baseline_disputed") {
			causes.push({
				kind: "budget_alert",
				alert,
				...(input.state.baselineDisputeResolution
					? { resolvedBy: input.state.baselineDisputeResolution.decisionId }
					: {}),
			});
			continue;
		}
		const resolvedBy = architectureApproval(
			input.budget,
			input.state,
			input.architectureContext,
		);
		causes.push({
			kind: "budget_alert",
			alert,
			itemIds: [...input.architectureContext.itemIds].sort(),
			workItemIds: [...input.architectureContext.workItemIds].sort(),
			...(resolvedBy ? { resolvedBy } : {}),
		});
	}
	for (const item of input.items) {
		const finding = findingIdentity(item, input.findingOutcomes, input.state);
		if (!finding) continue;
		if (item.lateDiscovery === "critical_safety") {
			causes.push({ kind: "critical_safety", finding });
		} else if (
			item.action === "human_required" &&
			item.coupling === "adjacent"
		) {
			causes.push({ kind: "adjacent_debt", finding, coupling: "adjacent" });
		} else if (item.action === "human_required") {
			causes.push({ kind: "semantic_human", finding });
		}
	}
	return causes;
}

/**
 * `projectedEffort` is the committed-plan forecast before these final
 * corrections. The validator adds their effort exactly once.
 */
export function validateFinalCorrections(input: {
	items: readonly VerdictItem[];
	projectedEffort: number;
	effectiveCeiling: number;
}): { valid: true } | { valid: false; reasons: FinalCorrectionFailure[] } {
	const reasons: FinalCorrectionFailure[] = [];
	if (input.items.length === 0) reasons.push("no_corrections");
	if (input.items.some((item) => item.action !== "auto_fix"))
		reasons.push("non_auto_fix");
	const effort = input.items.reduce(
		(total, item) => total + (item.effortDelta ?? 0),
		0,
	);
	if (effort > 1) reasons.push("effort_exceeded");
	if (input.items.some((item) => (item.architectureDelta ?? 0) !== 0))
		reasons.push("architecture_change");
	if (input.items.some((item) => item.requiresReviewerVerification === true))
		reasons.push("reviewer_verification_required");
	if (
		input.items.some(
			(item) =>
				item.lateDiscovery === "critical_safety" ||
				item.priorDecisionId !== undefined ||
				item.newEvidence !== undefined,
		)
	)
		reasons.push("exception_requires_review");
	if (input.projectedEffort + effort > input.effectiveCeiling)
		reasons.push("effective_ceiling_exceeded");
	return reasons.length === 0 ? { valid: true } : { valid: false, reasons };
}

function v1Route(verdict: ReviewerVerdict): PlanReviewRoute {
	if (verdict.readiness === "ready") return "complete";
	if (
		verdict.items.some((item) => item.action === "human_required") ||
		(verdict.readiness === "not_ready" && verdict.items.length === 0)
	)
		return "human_gate";
	return "author_revision";
}

function deriveEnforced(
	input: Omit<DerivePlanReviewGovernanceInput, "mode">,
): PlanReviewGovernanceResult {
	const items = activeItems(
		input.verdict.items,
		input.governingState,
		input.closure.findingOutcomes,
	);
	const activeIds = new Set(items.map((item) => item.id));
	const findings = input.budgetContext.findings.filter((finding) =>
		activeIds.has(finding.id),
	);
	const architectureContext = {
		itemIds: findings
			.filter(
				(finding) =>
					finding.scopeClass !== "polish" &&
					finding.architectureDelta >=
						input.budget.thresholds.singleArchitectureReviewPoints,
			)
			.map((finding) => finding.id),
		workItemIds: input.budgetContext.workItems
			.filter(
				(item) =>
					item.architectureDelta >=
					input.budget.thresholds.singleArchitectureReviewPoints,
			)
			.map((item) => item.id),
	};
	const effectiveBudget = deriveBudget({
		B0: input.budget.B0,
		B: input.governingState.governingBaseline,
		I: input.budget.I,
		workItems: input.budgetContext.workItems,
		findings,
		assessments: input.budgetContext.assessments,
		config: input.budget.thresholds,
		semanticHumanRequired: items.some(
			(item) => item.action === "human_required",
		),
	});
	if (
		input.budget.budgetAlerts.includes("credit_unrealized") &&
		!effectiveBudget.budgetAlerts.includes("credit_unrealized")
	)
		effectiveBudget.budgetAlerts.push("credit_unrealized");
	const gateCauses = causesFor({
		items,
		budget: effectiveBudget,
		state: input.governingState,
		architectureContext,
		findingOutcomes: input.closure.findingOutcomes,
	});
	if (gateCauses.some((cause) => cause.resolvedBy === undefined)) {
		return {
			reviewKind: input.reviewKind,
			normalizedReadiness: input.verdict.readiness,
			route: "human_gate",
			gateCauses,
			findingOutcomes: input.closure.findingOutcomes,
			diagnostics: input.closure.diagnostics,
		};
	}
	if (items.length === 0) {
		return {
			reviewKind: input.reviewKind,
			normalizedReadiness: "ready",
			route: "complete",
			gateCauses,
			findingOutcomes: input.closure.findingOutcomes,
			diagnostics: input.closure.diagnostics,
		};
	}
	if (
		input.verdict.readiness === "ready_with_corrections" &&
		validateFinalCorrections({
			items,
			projectedEffort: effectiveBudget.W,
			effectiveCeiling: effectiveBudget.E,
		}).valid
	) {
		return {
			reviewKind: input.reviewKind,
			normalizedReadiness: "ready_with_corrections",
			route: "final_corrections",
			gateCauses,
			findingOutcomes: input.closure.findingOutcomes,
			diagnostics: input.closure.diagnostics,
		};
	}
	return {
		reviewKind: input.reviewKind,
		normalizedReadiness: "not_ready",
		route: "author_revision",
		gateCauses,
		findingOutcomes: input.closure.findingOutcomes,
		diagnostics: input.closure.diagnostics,
	};
}

export function derivePlanReviewGovernance(
	input: DerivePlanReviewGovernanceInput,
): PlanReviewGovernanceResult {
	const enforced = deriveEnforced(input);
	if (input.mode === "enforced") return enforced;
	return {
		reviewKind: input.reviewKind,
		normalizedReadiness: input.verdict.readiness,
		route: v1Route(input.verdict),
		gateCauses: enforced.gateCauses,
		findingOutcomes: input.closure.findingOutcomes,
		diagnostics: input.closure.diagnostics,
		hypotheticalEnforcedRoute: enforced.route,
	};
}

function fingerprintById(
	verdict: ReviewerVerdict,
	state: GoverningReviewState,
): Map<string, string> {
	return new Map(
		verdict.items.map((item) => {
			const accepted = state.acceptedRisks.find(
				(candidate) => candidate.findingId === item.id,
			);
			return [
				item.id,
				accepted && (!item.failure || !item.lowestCostCorrection)
					? accepted.fingerprint
					: fingerprintVerdictItem(item),
			];
		}),
	);
}

function filteredFindings(input: {
	findings: readonly FindingDelta[];
	verdict: ReviewerVerdict;
	state: GoverningReviewState;
}): FindingDelta[] {
	const fingerprints = fingerprintById(input.verdict, input.state);
	return input.findings.filter((finding) => {
		const fingerprint = fingerprints.get(finding.id);
		if (!fingerprint) return true;
		const accepted = input.state.acceptedRisks.find(
			(risk) =>
				risk.findingId === finding.id && risk.fingerprint === fingerprint,
		);
		if (!accepted) return true;
		const item = input.verdict.items.find(
			(candidate) => candidate.id === finding.id,
		);
		return Boolean(
			item?.priorDecisionId === accepted.decisionId && item.newEvidence?.trim(),
		);
	});
}

export function routeAfterDecision(input: {
	latestVerdict: ReviewerVerdict;
	latestBudgetSnapshot: ReviewBudgetSnapshotRecord;
	newGoverningState: GoverningReviewState;
	decision: ReviewDecisionPayload;
}): ReviewDecisionRoute {
	if (input.decision.choice === "abort") return "aborted";
	if (
		input.decision.choice === "trade_scope" ||
		input.decision.choice === "request_author_reestimate"
	)
		return "author_revision";
	const previous = input.latestBudgetSnapshot.derived;
	if (!previous)
		throw new TypeError("latest budget snapshot requires a derived budget");
	const findings = filteredFindings({
		findings: input.latestBudgetSnapshot.findings,
		verdict: input.latestVerdict,
		state: input.newGoverningState,
	});
	const activeIds = new Set(findings.map((finding) => finding.id));
	const verdict: ReviewerVerdict = {
		...input.latestVerdict,
		items: input.latestVerdict.items.filter((item) => activeIds.has(item.id)),
	};
	return derivePlanReviewGovernance({
		mode: "enforced",
		reviewKind: verdict.priorFindings ? "closure" : "initial",
		verdict,
		budget: previous,
		closure: {
			valid: true,
			accepted: true,
			diagnostics: [],
			requiredOutcomeIds: [],
			findingOutcomes: [],
		},
		governingState: input.newGoverningState,
		budgetContext: {
			workItems: input.latestBudgetSnapshot.currentLedger.workItems,
			findings,
			assessments: input.latestBudgetSnapshot.assessments,
		},
	}).route;
}
