import type { ReviewBudgetSnapshotRecord } from "../control-plane/review-budget-store.js";
import type { ReviewerVerdict, VerdictItem } from "../protocol.js";
import {
	computeCeilings,
	computeEffectiveCeiling,
	computeProvisionalD,
	deriveBudget,
} from "../review-budget/arithmetic.js";
import type {
	BudgetAlert,
	DerivedBudgetResult,
	FindingDelta,
	ParsedWorkItem,
} from "../review-budget/types.js";
import type {
	GoverningReviewState,
	ReviewDecisionPayload,
} from "./decisions.js";
import { canonicalFindingFingerprint } from "./fingerprint.js";
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

export interface DerivePlanReviewGovernanceInput {
	mode: "advisory" | "enforced";
	reviewKind: "initial" | "closure";
	verdict: ReviewerVerdict;
	budget: DerivedBudgetResult;
	closure: ClosureValidationResult;
	governingState: GoverningReviewState;
	/** Optional because the plan-208 budget aggregate does not retain source IDs. */
	architectureContext?: ArchitectureRoutingContext;
}

function findingIdentity(item: VerdictItem): FindingIdentity {
	return {
		findingId: item.id,
		fingerprint: canonicalFindingFingerprint({
			title: item.title,
			scopeClass:
				item.scopeClass === "risk_reduction" || item.scopeClass === "polish"
					? item.scopeClass
					: "acceptance_required",
			failure: item.failure?.trim() || item.reason,
			lowestCostCorrection: item.lowestCostCorrection?.trim() || item.reason,
		}),
	};
}

function sameFinding(a: FindingIdentity, b: FindingIdentity): boolean {
	return a.findingId === b.findingId && a.fingerprint === b.fingerprint;
}

function activeItems(
	items: readonly VerdictItem[],
	state: GoverningReviewState,
): VerdictItem[] {
	return items.filter((item) => {
		const identity = findingIdentity(item);
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

function budgetForActiveItems(
	budget: DerivedBudgetResult,
	verdict: ReviewerVerdict,
	items: readonly VerdictItem[],
	architectureContext: ArchitectureRoutingContext,
): DerivedBudgetResult {
	const allItems = verdict.items;
	const activeIds = new Set(items.map((item) => item.id));
	const removed = allItems.filter((item) => !activeIds.has(item.id));
	if (removed.length === 0) return budget;
	const removedR = removed.reduce(
		(total, item) =>
			total + (item.scopeClass === "polish" ? 0 : (item.effortDelta ?? 0)),
		0,
	);
	const removedP = removed.reduce(
		(total, item) =>
			total +
			(item.scopeClass !== "polish" && (item.architectureDelta ?? 0) > 0
				? (item.architectureDelta ?? 0)
				: 0),
		0,
	);
	const removedN = removed.reduce((total, item) => {
		if (
			(item.architectureDelta ?? 0) >= 0 ||
			item.coupling !== "intrinsic" ||
			!item.creditClaim
		)
			return total;
		const assessment = verdict.creditAssessments?.find(
			(candidate) =>
				candidate.creditClaimId === item.creditClaim?.creditClaimId,
		);
		if (
			assessment?.eligibility !== "eligible" ||
			assessment.coupling !== "intrinsic"
		)
			return total;
		return total + Math.abs(item.architectureDelta ?? 0);
	}, 0);
	const R = Math.max(0, budget.R - removedR);
	const P = Math.max(0, budget.P - removedP);
	const N = Math.max(0, budget.N - removedN);
	const D = computeProvisionalD(budget.B, N, budget.thresholds);
	const E = computeEffectiveCeiling(budget.S, D, budget.A);
	const projectedEffort = budget.W + R;
	const budgetBand =
		projectedEffort <= budget.S
			? "within_standard"
			: projectedEffort <= E
				? "within_debt_allowance"
				: projectedEffort <= budget.A
					? "over_effective"
					: "over_absolute";
	const remainingSingleArchitecture = items.some(
		(item) =>
			(item.architectureDelta ?? 0) >=
			budget.thresholds.singleArchitectureReviewPoints,
	);
	const budgetAlerts: BudgetAlert[] = budget.budgetAlerts.filter(
		(alert) =>
			alert !== "positive_architecture_exceeded" ||
			P >= budget.positiveArchitectureLimit ||
			remainingSingleArchitecture ||
			architectureContext.workItemIds.length > 0,
	);
	return {
		...budget,
		R,
		P,
		N,
		D,
		E,
		projectedEffort,
		budgetBand,
		budgetAlerts,
		requiresHuman:
			budgetBand === "over_effective" ||
			budgetBand === "over_absolute" ||
			budgetAlerts.some((alert) => alert !== "credit_unrealized") ||
			items.some((item) => item.action === "human_required"),
	};
}

function budgetForGoverningBaseline(
	budget: DerivedBudgetResult,
	governingBaseline: number,
	architectureContext: ArchitectureRoutingContext,
): DerivedBudgetResult {
	if (budget.B === governingBaseline) return budget;
	const { S, A, positiveArchitectureLimit } = computeCeilings(
		governingBaseline,
		budget.thresholds,
	);
	const D = computeProvisionalD(governingBaseline, budget.N, budget.thresholds);
	const E = computeEffectiveCeiling(S, D, A);
	const budgetBand =
		budget.projectedEffort <= S
			? "within_standard"
			: budget.projectedEffort <= E
				? "within_debt_allowance"
				: budget.projectedEffort <= A
					? "over_effective"
					: "over_absolute";
	const hasArchitectureAlert =
		budget.P >= positiveArchitectureLimit ||
		architectureContext.itemIds.length > 0 ||
		architectureContext.workItemIds.length > 0;
	const budgetAlerts: BudgetAlert[] = [];
	for (const alert of budget.budgetAlerts) {
		if (alert !== "positive_architecture_exceeded") budgetAlerts.push(alert);
	}
	if (hasArchitectureAlert) budgetAlerts.push("positive_architecture_exceeded");
	return {
		...budget,
		B: governingBaseline,
		S,
		D,
		E,
		A,
		positiveArchitectureLimit,
		budgetBand,
		budgetAlerts,
		requiresHuman:
			budgetBand === "over_effective" ||
			budgetBand === "over_absolute" ||
			budgetAlerts.some((alert) => alert !== "credit_unrealized"),
	};
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
		const finding = findingIdentity(item);
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
	return verdict.readiness === "ready" ? "complete" : "author_revision";
}

function deriveEnforced(
	input: Omit<DerivePlanReviewGovernanceInput, "mode">,
): PlanReviewGovernanceResult {
	const items = activeItems(input.verdict.items, input.governingState);
	const architectureContext = input.architectureContext ?? {
		itemIds: items
			.filter(
				(item) =>
					(item.architectureDelta ?? 0) >=
					input.budget.thresholds.singleArchitectureReviewPoints,
			)
			.map((item) => item.id),
		workItemIds: [],
	};
	const baselineBudget = budgetForGoverningBaseline(
		input.budget,
		input.governingState.governingBaseline,
		architectureContext,
	);
	const effectiveBudget = budgetForActiveItems(
		baselineBudget,
		input.verdict,
		items,
		architectureContext,
	);
	const gateCauses = causesFor({
		items,
		budget: effectiveBudget,
		state: input.governingState,
		architectureContext,
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

function fingerprintById(verdict: ReviewerVerdict): Map<string, string> {
	return new Map(
		verdict.items.map((item) => [item.id, findingIdentity(item).fingerprint]),
	);
}

function filteredFindings(input: {
	findings: readonly FindingDelta[];
	verdict: ReviewerVerdict;
	state: GoverningReviewState;
}): FindingDelta[] {
	const fingerprints = fingerprintById(input.verdict);
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

function architectureContext(
	verdict: ReviewerVerdict,
	workItems: readonly ParsedWorkItem[],
	threshold: number,
): ArchitectureRoutingContext {
	return {
		itemIds: verdict.items
			.filter((item) => (item.architectureDelta ?? 0) >= threshold)
			.map((item) => item.id),
		workItemIds: workItems
			.filter((item) => item.architectureDelta >= threshold)
			.map((item) => item.id),
	};
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
	const budget = deriveBudget({
		B0: previous.B0,
		B: input.newGoverningState.governingBaseline,
		I: previous.I,
		workItems: input.latestBudgetSnapshot.currentLedger.workItems,
		findings,
		assessments: input.latestBudgetSnapshot.assessments,
		config: previous.thresholds,
		semanticHumanRequired: verdict.items.some(
			(item) => item.action === "human_required",
		),
	});
	return derivePlanReviewGovernance({
		mode: "enforced",
		reviewKind: verdict.priorFindings ? "closure" : "initial",
		verdict,
		budget,
		closure: {
			valid: true,
			accepted: true,
			diagnostics: [],
			requiredOutcomeIds: [],
			findingOutcomes: [],
		},
		governingState: input.newGoverningState,
		architectureContext: architectureContext(
			verdict,
			input.latestBudgetSnapshot.currentLedger.workItems,
			budget.thresholds.singleArchitectureReviewPoints,
		),
	}).route;
}
