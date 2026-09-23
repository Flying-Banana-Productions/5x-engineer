import type { ReviewBudgetSnapshotRecord } from "../control-plane/review-budget-store.js";
import type { ReviewerVerdict } from "../protocol.js";
import type {
	ApplyPlanReviewBudgetResult,
	PendingBudgetSnapshot,
} from "../review-budget/apply.js";
import { validateClosureReview } from "./closure.js";
import type {
	GoverningReviewState,
	ReviewDecisionPayload,
} from "./decisions.js";
import type { PlanDiffFailure } from "./plan-diff.js";
import { derivePlanReviewGovernance } from "./routing.js";
import type {
	PersistedFinding,
	PlanDiffContext,
	PlanReviewGovernanceResult,
} from "./types.js";

type AppliedBudget = Extract<
	ApplyPlanReviewBudgetResult,
	{ status: "applied" }
>;

export type AppliedPlanReviewGovernance =
	| {
			status: "applied";
			verdict: ReviewerVerdict & { governance: PlanReviewGovernanceResult };
			pendingSnapshot: PendingBudgetSnapshot;
	  }
	| { status: "error"; code: string; message: string; diagnostics: unknown[] };

export function persistedFindingsFromSnapshots(
	snapshots: readonly ReviewBudgetSnapshotRecord[],
): PersistedFinding[] {
	const findings = new Map<string, PersistedFinding>();
	for (const snapshot of snapshots) {
		for (const outcome of snapshot.priorFindings ?? []) {
			const prior = findings.get(outcome.id);
			if (prior) findings.set(outcome.id, { ...prior, status: outcome.status });
		}
		for (const finding of snapshot.findings) {
			if (
				!finding.scopeClass ||
				!finding.failure ||
				!finding.lowestCostCorrection ||
				!finding.fingerprint
			)
				continue;
			const prior = findings.get(finding.id);
			findings.set(finding.id, {
				findingId: finding.id,
				fingerprint: finding.fingerprint,
				title: finding.title ?? prior?.title ?? finding.id,
				scopeClass: finding.scopeClass,
				failure: finding.failure,
				lowestCostCorrection: finding.lowestCostCorrection,
				...(prior?.status ? { status: prior.status } : {}),
			});
		}
	}
	return [...findings.values()];
}

export function applyPlanReviewGovernance(input: {
	verdict: ReviewerVerdict;
	budgetResult: AppliedBudget;
	snapshots: readonly ReviewBudgetSnapshotRecord[];
	decisions: readonly ReviewDecisionPayload[];
	diffContext?: PlanDiffContext;
	diffContextFailure?: PlanDiffFailure;
	governingState: GoverningReviewState;
	mode: "advisory" | "enforced";
}): AppliedPlanReviewGovernance {
	const pending = input.budgetResult.pendingSnapshot;
	const priorSnapshots = input.snapshots.filter(
		(snapshot) => snapshot.id !== pending.id,
	);
	const reviewKind = priorSnapshots.length === 0 ? "initial" : "closure";
	const closure = validateClosureReview({
		reviewKind,
		mode: input.mode,
		verdict: input.verdict,
		priorFindings: persistedFindingsFromSnapshots(priorSnapshots),
		priorDecisions: input.decisions,
		...(input.diffContext ? { diffContext: input.diffContext } : {}),
		...(input.diffContextFailure
			? { diffContextFailure: input.diffContextFailure }
			: {}),
	});
	if (!closure.accepted) {
		const first = closure.diagnostics.find((item) => item.severity === "error");
		return {
			status: "error",
			code: first?.code ?? "CLOSURE_REVIEW_INVALID",
			message: first?.message ?? "Closure review evidence is invalid.",
			diagnostics: closure.diagnostics,
		};
	}
	const governance = derivePlanReviewGovernance({
		mode: input.mode,
		reviewKind,
		verdict: input.budgetResult.verdict,
		budget: pending.derived,
		closure,
		governingState: input.governingState,
		budgetContext: {
			workItems: pending.currentLedger.workItems,
			findings: pending.findings,
			assessments: pending.assessments,
		},
	});
	pending.mode = input.mode;
	pending.priorFindings = input.verdict.priorFindings ?? [];
	pending.effectiveGateCauses = governance.gateCauses.filter(
		(cause) => cause.resolvedBy === undefined,
	);
	pending.suppressedGateCauses = governance.gateCauses.filter(
		(cause) => cause.resolvedBy !== undefined,
	);
	pending.diagnostics = governance.diagnostics;
	return {
		status: "applied",
		verdict: { ...input.budgetResult.verdict, governance },
		pendingSnapshot: pending,
	};
}
