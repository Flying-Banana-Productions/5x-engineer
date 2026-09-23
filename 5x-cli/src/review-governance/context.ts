import type { RecordStore } from "../control-plane/record-store.js";
import type { ReviewBudgetStore } from "../control-plane/review-budget-store.js";
import type { ReviewBudgetMode } from "../review-budget/types.js";
import { persistedFindingsFromSnapshots } from "./apply.js";
import { requiredClosureOutcomeFindings } from "./closure.js";
import type { ApprovedScope } from "./decisions.js";
import { createReviewGovernanceStore } from "./store.js";
import type {
	FindingIdentity,
	PersistedFinding,
	ReviewDecisionChoice,
} from "./types.js";

export interface PlanReviewPromptContext {
	reviewKind: "initial" | "closure";
	mode: "advisory" | "enforced";
	priorFindings: PersistedFinding[];
	requiredOutcomeIds: string[];
	deferredOrAcceptedRisks: Array<{
		decisionId: string;
		finding: FindingIdentity;
		decision: ReviewDecisionChoice;
		rationale: string;
		evidence: string[];
		approvedScope: ApprovedScope;
	}>;
	approvedScope: ApprovedScope;
	governingBaseline: number;
	requestAuthorReestimate: boolean;
}

export function buildPlanReviewPromptContext(input: {
	runId: string;
	configuredMode: ReviewBudgetMode;
	store: ReviewBudgetStore;
	recordStore: RecordStore;
}): PlanReviewPromptContext | null {
	try {
		if (input.recordStore.getRun(input.runId) === null) return null;
	} catch {
		return null;
	}
	const baseline = input.store.getBaseline(input.runId);
	const mode = baseline?.mode ?? input.configuredMode;
	if (!baseline || mode === "off") return null;
	const snapshots = input.store.listSnapshots(input.runId);
	const governance = createReviewGovernanceStore(input.recordStore);
	const state = governance.deriveGoverningState(input.runId, baseline.b0);
	const priorFindings = persistedFindingsFromSnapshots(snapshots);
	const decisions = governance.listDecisions(input.runId);
	const deferredOrAcceptedRisks = state.history.flatMap((decision) =>
		decision.choice === "defer_accept_risk"
			? decision.findingRefs.map((finding) => ({
					decisionId: decision.decisionId,
					finding: structuredClone(finding),
					decision: decision.choice,
					rationale: decision.rationale,
					evidence: [...decision.evidence],
					approvedScope: structuredClone(decision.approvedScope),
				}))
			: [],
	);
	return {
		reviewKind: snapshots.length === 0 ? "initial" : "closure",
		mode,
		priorFindings,
		requiredOutcomeIds: requiredClosureOutcomeFindings({
			priorFindings,
			priorDecisions: decisions,
		}).map((finding) => finding.findingId),
		deferredOrAcceptedRisks,
		approvedScope: structuredClone(state.approvedScope),
		governingBaseline: state.governingBaseline,
		requestAuthorReestimate: Boolean(state.baselineReestimatePending),
	};
}

function list(values: readonly string[]): string {
	return values.length === 0 ? "(none)" : values.join("; ");
}

export function formatReviewerGovernanceContext(
	context: PlanReviewPromptContext,
): string {
	const findings = context.priorFindings.length
		? context.priorFindings
				.map(
					(finding) =>
						`- ${finding.findingId} (${finding.fingerprint})${finding.status ? ` [${finding.status}]` : ""}: ${finding.title}; scope: ${finding.scopeClass}; failure: ${finding.failure}; lowest-cost correction: ${finding.lowestCostCorrection}`,
				)
				.join("\n")
		: "- (none)";
	const risks = context.deferredOrAcceptedRisks.length
		? context.deferredOrAcceptedRisks
				.map(
					(entry) =>
						`- ${entry.finding.findingId} (${entry.finding.fingerprint}), decision ${entry.decisionId}: ${entry.rationale}; evidence: ${list(entry.evidence)}`,
				)
				.join("\n")
		: "- (none)";
	return `## Plan-review governance context\n\n- Review kind: ${context.reviewKind}\n- Pinned mode: ${context.mode}\n- Required prior-finding outcome IDs: ${list(context.requiredOutcomeIds)}\n- Governing baseline (B): ${context.governingBaseline}\n- Retained scope: ${list(context.approvedScope.retained)}\n- Removed scope: ${list(context.approvedScope.removed)}\n- Author re-estimate requested: ${context.requestAuthorReestimate ? "yes" : "no"}\n\n### Prior findings\n\n${findings}\n\n### Deferred or accepted-risk findings\n\n${risks}`;
}

/** Keep render and invoke prompt projection byte-for-byte aligned. */
export function appendPlanReviewPromptContext(input: {
	prompt: string;
	diffAppend?: string | null;
	governanceAppend?: string | null;
}): string {
	let prompt = input.prompt;
	if (input.diffAppend) prompt += `\n${input.diffAppend}`;
	if (input.governanceAppend) prompt += `\n\n${input.governanceAppend}`;
	return prompt;
}

export function formatAuthorGoverningDecisions(
	context: PlanReviewPromptContext,
): string {
	const skipped = context.deferredOrAcceptedRisks.map(
		(entry) => `${entry.finding.findingId} (${entry.finding.fingerprint})`,
	);
	return `## Governing decisions\n\n- Finding IDs not to implement unless material new evidence is reviewed: ${list(skipped)}\n- Retained scope: ${list(context.approvedScope.retained)}\n- Removed scope: ${list(context.approvedScope.removed)}\n- Author re-estimate requested: ${context.requestAuthorReestimate ? "yes" : "no"}\n- Governing baseline (B): ${context.governingBaseline}`;
}
