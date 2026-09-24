import type { RecordStore } from "../control-plane/record-store.js";
import type { ReviewBudgetStore } from "../control-plane/review-budget-store.js";
import type {
	ImplementationBindingPayload,
	ImplementationReviewContextPayload,
	ImplementationReviewObservationPayload,
} from "../review-budget/record-lines.js";
import {
	isCompleteDebtClaimEvidence,
	type ReviewBudgetMode,
} from "../review-budget/types.js";
import { persistedFindingsFromSnapshots } from "./apply.js";
import { requiredClosureOutcomeFindings } from "./closure.js";
import { codeDiffRetrievalCommand } from "./code-diff.js";
import { evaluateImplementationCorrectionEligibility } from "./corrections.js";
import { humanDebtDecisionsFromImplementationDecisions } from "./credit-reconciliation.js";
import {
	type ApprovedScope,
	classifyDecisionAcceptance,
	listImplementationDecisions,
	type ReviewDecisionPayload,
} from "./decisions.js";
import {
	canonicalPhaseId,
	readImplementationCodeClosure,
} from "./implementation.js";
import {
	listRecordedImplementationReviews,
	readImplementationBinding,
} from "./implementation-state.js";
import { createReviewGovernanceStore } from "./store.js";
import type {
	FindingIdentity,
	ImplementationNextAction,
	PersistedFinding,
	PlanReviewRoute,
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

export interface ImplementationDueClaimContext {
	creditClaimId: string;
	phaseId: string;
	approvedArchitectureDelta: number;
	effectiveMagnitude: number;
	after: string;
	waiverDecisionId: string | null;
}

export interface ImplementationRiskContext {
	decisionId: string;
	title: string;
	rationale: string;
	approvedScope: string[];
	source: "imported" | "implementation";
}

export interface ImplementationWaiverContext {
	decisionId: string;
	creditClaimId: string;
	approvedMagnitude: number;
	originalMagnitude: number;
}

export interface ImplementationAuthorFindingContext {
	id: string;
	title: string;
	scopeClass: string;
	priority: string;
	action: string;
	reason: string;
	planWorkItemIds: string[];
}

export interface ImplementationReviewPromptContext {
	reviewKind: "initial" | "closure";
	mode: "advisory" | "enforced";
	bindingId: string;
	sourceRunId: string;
	sourceSnapshotId: string;
	approvedPlanCommit: string;
	phaseId: string;
	phaseHeading: string;
	approvedWorkItemIds: string[];
	phaseScope: string[];
	reviewContextId: string | null;
	fullDiffRetrieval: string | null;
	requiredOutcomeIds: string[];
	dueClaims: ImplementationDueClaimContext[];
	deferredOrAcceptedRisks: ImplementationRiskContext[];
	debtWaivers: ImplementationWaiverContext[];
	authorRoute: PlanReviewRoute | null;
	authorNextAction: ImplementationNextAction | null;
	finalCorrection: boolean;
	eligibleItemId: string | null;
	actionableFindings: ImplementationAuthorFindingContext[];
	textGuard: {
		id: string;
		spans: Array<{ heading: string; staleText: string }>;
	} | null;
}

function findingTitle(
	observations: readonly ImplementationReviewObservationPayload[],
	findingId: string,
): string {
	for (const observation of [...observations].reverse()) {
		const item = observation.originalVerdict.items.find(
			(entry) => entry.id === findingId,
		);
		if (item?.title?.trim()) return item.title.trim();
	}
	return findingId;
}

function supersededIds(
	decisions: readonly { decisionId?: string; supersedesDecisionId?: string }[],
): Set<string> {
	return new Set(
		decisions.flatMap((decision) =>
			decision.supersedesDecisionId ? [decision.supersedesDecisionId] : [],
		),
	);
}

function importedRisks(
	binding: ImplementationBindingPayload,
): ImplementationRiskContext[] {
	const decisions = binding.effectiveDecisions.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const decision = entry as Partial<ReviewDecisionPayload>;
		if (
			decision.kind !== "plan-review-governance" ||
			decision.choice !== "defer_accept_risk" ||
			typeof decision.decisionId !== "string" ||
			typeof decision.rationale !== "string"
		) {
			return [];
		}
		return [decision];
	});
	const superseded = supersededIds(decisions);
	return decisions.flatMap((decision) => {
		if (!decision.decisionId || superseded.has(decision.decisionId)) return [];
		const scope = [
			...(decision.approvedScope?.retained ?? []),
			...(decision.findingRefs ?? []).map((finding) => finding.findingId),
		];
		const title =
			decision.findingRefs?.map((finding) => finding.findingId).join(", ") ||
			decision.decisionId;
		return [
			{
				decisionId: decision.decisionId,
				title,
				rationale: decision.rationale ?? "",
				approvedScope: [...new Set(scope)],
				source: "imported" as const,
			},
		];
	});
}

function dueClaimsForPhase(
	binding: ImplementationBindingPayload,
	phaseId: string,
	waivers: readonly ImplementationWaiverContext[],
): ImplementationDueClaimContext[] {
	const claims: ImplementationDueClaimContext[] = [];
	for (const item of binding.ledger.workItems) {
		if (item.architectureDelta >= 0) continue;
		const claim = item.debtClaim;
		if (!isCompleteDebtClaimEvidence(claim) || claim.coupling !== "intrinsic") {
			continue;
		}
		const target = binding.debtTargets.find(
			(entry) => entry.claimId === claim.debtClaimId,
		);
		if (!target || target.phaseId !== phaseId) continue;
		const waiver = [...waivers]
			.reverse()
			.find((entry) => entry.creditClaimId === claim.debtClaimId);
		const original = Math.abs(item.architectureDelta);
		claims.push({
			creditClaimId: claim.debtClaimId,
			phaseId,
			approvedArchitectureDelta: item.architectureDelta,
			effectiveMagnitude: waiver?.approvedMagnitude ?? original,
			after: claim.after,
			waiverDecisionId: waiver?.decisionId ?? null,
		});
	}
	return claims;
}

/**
 * Shared implementation context for native and invoke prompts.
 * `sessionId` does not reset the review round or the captured binding.
 */
export function buildImplementationReviewPromptContext(input: {
	runId: string;
	phase: string;
	store: ReviewBudgetStore;
	recordStore: RecordStore;
	reviewContext?: Pick<
		ImplementationReviewContextPayload,
		"id" | "baseCommit" | "reviewedCommit" | "excludedPaths"
	> | null;
	workdir?: string;
	sessionId?: string;
}): ImplementationReviewPromptContext | null {
	void input.sessionId;
	const binding = readImplementationBinding(input.store, input.runId);
	if (!binding) return null;
	const phaseId = canonicalPhaseId(input.phase) ?? input.phase.trim();
	const phase = binding.phaseMap.find((entry) => entry.id === phaseId);
	const observations = listRecordedImplementationReviews(
		input.store,
		input.runId,
	).filter(
		(observation) =>
			observation.bindingId === binding.id && observation.phase === phaseId,
	);
	const closure = readImplementationCodeClosure(
		input.recordStore,
		input.runId,
		phaseId,
	);
	const steps = input.recordStore.listLines(input.runId, "steps");
	const budget = input.recordStore.listLines(input.runId, "budget");
	const listed = listImplementationDecisions(input.recordStore, input.runId);
	const accepted = listed.decisions.filter(
		(decision) =>
			decision.bindingId === binding.id &&
			classifyDecisionAcceptance({ decision, steps, budget }).accepted,
	);
	const superseded = supersededIds(accepted);
	const active = accepted.filter(
		(decision) => !superseded.has(decision.decisionId),
	);
	const risks = active.flatMap((decision) => {
		if (decision.choice !== "defer_accept_risk") return [];
		return decision.findingRefs.map((finding) => {
			const item = [...observations]
				.reverse()
				.flatMap((observation) => observation.originalVerdict.items)
				.find((entry) => entry.id === finding.findingId);
			return {
				decisionId: decision.decisionId,
				title: findingTitle(observations, finding.findingId),
				rationale: decision.rationale,
				approvedScope:
					item?.planWorkItemIds && item.planWorkItemIds.length > 0
						? [...item.planWorkItemIds]
						: [finding.findingId],
				source: "implementation" as const,
			};
		});
	});
	const waivers = humanDebtDecisionsFromImplementationDecisions(active).flatMap(
		(decision) => {
			if (decision.kind !== "waiver" || !decision.active) return [];
			const item = binding.ledger.workItems.find(
				(workItem) =>
					workItem.debtClaim?.debtClaimId === decision.creditClaimId,
			);
			return [
				{
					decisionId: decision.decisionId,
					creditClaimId: decision.creditClaimId,
					approvedMagnitude: decision.approvedMagnitude,
					originalMagnitude: Math.abs(item?.architectureDelta ?? 0),
				},
			];
		},
	);
	const latest = observations.at(-1) ?? null;
	const eligibility = latest
		? evaluateImplementationCorrectionEligibility(latest.originalVerdict)
		: null;
	const finalCorrection = latest?.route === "final_corrections";
	const actionable = (latest?.originalVerdict.items ?? []).flatMap((item) => {
		if (
			item.scopeClass === "pre_existing" &&
			item.lateDiscovery !== "critical_safety"
		) {
			return [];
		}
		if (
			item.scopeClass === "scope_expansion" ||
			item.lateDiscovery === "critical_safety"
		) {
			return [];
		}
		if (
			item.scopeClass === "plan_defect" &&
			item.planImpact?.kind !== "text_only"
		) {
			return [];
		}
		if (finalCorrection && item.id !== eligibility?.itemId) return [];
		return [
			{
				id: item.id,
				title: item.title,
				scopeClass: item.scopeClass ?? "",
				priority: item.priority ?? "",
				action: item.action,
				reason: item.reason,
				planWorkItemIds: [...(item.planWorkItemIds ?? [])],
			},
		];
	});
	const workItemsForPhase = binding.ledger.workItems.filter((item) =>
		binding.debtTargets.some(
			(target) =>
				target.phaseId === phaseId &&
				item.debtClaim?.debtClaimId === target.claimId,
		),
	);
	return {
		reviewKind: closure.priorReviewCount === 0 ? "initial" : "closure",
		mode: binding.mode,
		bindingId: binding.id,
		sourceRunId: binding.sourceRunId,
		sourceSnapshotId: binding.sourceSnapshotId,
		approvedPlanCommit: binding.approvedPlanCommit,
		phaseId,
		phaseHeading: phase?.heading ?? "",
		approvedWorkItemIds: binding.ledger.workItems.map((item) => item.id),
		phaseScope: [
			...(phase ? [`${phase.id}: ${phase.heading}`] : []),
			...workItemsForPhase.map((item) => `${item.id}: ${item.title}`),
		],
		reviewContextId: input.reviewContext?.id ?? null,
		fullDiffRetrieval: input.reviewContext
			? codeDiffRetrievalCommand({
					baseCommit: input.reviewContext.baseCommit,
					reviewedCommit: input.reviewContext.reviewedCommit,
					excludedPaths: input.reviewContext.excludedPaths,
					...(input.workdir ? { workdir: input.workdir } : {}),
				})
			: null,
		requiredOutcomeIds: closure.priorCodeFindings.map((finding) => finding.id),
		dueClaims: dueClaimsForPhase(binding, phaseId, waivers),
		deferredOrAcceptedRisks: [...importedRisks(binding), ...risks],
		debtWaivers: waivers,
		authorRoute: latest?.route ?? null,
		authorNextAction: latest?.nextAction ?? null,
		finalCorrection,
		eligibleItemId: finalCorrection ? (eligibility?.itemId ?? null) : null,
		actionableFindings: actionable,
		textGuard: latest?.textGuard
			? {
					id: latest.textGuard.id,
					spans: latest.textGuard.allowedSpans.map((span) => ({
						heading: span.heading,
						staleText: span.staleText,
					})),
				}
			: null,
	};
}

function claimLine(claim: ImplementationDueClaimContext): string {
	const waiver = claim.waiverDecisionId
		? `; waiver ${claim.waiverDecisionId} sets effective magnitude ${claim.effectiveMagnitude}`
		: `; effective magnitude ${claim.effectiveMagnitude}`;
	return `- ${claim.creditClaimId} (phase ${claim.phaseId}): approved architecture delta ${claim.approvedArchitectureDelta}${waiver}; approved after-state: ${claim.after}`;
}

function riskLine(entry: ImplementationRiskContext): string {
	return `- ${entry.title}, decision ${entry.decisionId} (${entry.source}): ${entry.rationale}; approved scope: ${list(entry.approvedScope)}`;
}

function sharedImplementationLines(
	context: ImplementationReviewPromptContext,
): string {
	return [
		`- Review kind: ${context.reviewKind}`,
		`- Pinned mode: ${context.mode}`,
		`- Binding: ${context.bindingId}`,
		`- Source run: ${context.sourceRunId}`,
		`- Source snapshot: ${context.sourceSnapshotId}`,
		`- Approved plan commit: ${context.approvedPlanCommit}`,
		`- Phase: ${context.phaseId}${context.phaseHeading ? ` — ${context.phaseHeading}` : ""}`,
		`- Approved work-item IDs: ${list(context.approvedWorkItemIds)}`,
		`- Phase scope: ${list(context.phaseScope)}`,
		`- Review context: ${context.reviewContextId ?? "(none)"}`,
		`- Full diff retrieval: ${context.fullDiffRetrieval ? `\`${context.fullDiffRetrieval}\`` : "(none)"}`,
		`- Required prior-finding outcome IDs: ${list(context.requiredOutcomeIds)}`,
	].join("\n");
}

export function formatImplementationReviewerContext(
	context: ImplementationReviewPromptContext,
): string {
	const claims = context.dueClaims.length
		? context.dueClaims.map(claimLine).join("\n")
		: "- (none)";
	const risks = context.deferredOrAcceptedRisks.length
		? context.deferredOrAcceptedRisks.map(riskLine).join("\n")
		: "- (none)";
	const waivers = context.debtWaivers.length
		? context.debtWaivers
				.map(
					(waiver) =>
						`- ${waiver.creditClaimId}, decision ${waiver.decisionId}: approved post-state magnitude ${waiver.approvedMagnitude} (original ${waiver.originalMagnitude})`,
				)
				.join("\n")
		: "- (none)";
	return `## Implementation-review governance context\n\n${sharedImplementationLines(context)}\n\nAssess due claims against the effective approved post-state, including human waivers and reductions. Do not create new credit.\n\n### Due claims\n\n${claims}\n\n### Deferred or accepted-risk decisions\n\n${risks}\n\n### Debt waivers and reductions\n\n${waivers}`;
}

export function formatImplementationAuthorContext(
	context: ImplementationReviewPromptContext,
): string {
	const findings = context.actionableFindings.length
		? context.actionableFindings
				.map(
					(finding) =>
						`- ${finding.id} (${finding.scopeClass}, ${finding.priority}, ${finding.action}) ${list(finding.planWorkItemIds)}: ${finding.title} — ${finding.reason}`,
				)
				.join("\n")
		: "- (none)";
	const guard = context.textGuard
		? context.textGuard.spans
				.map(
					(span) =>
						`- heading \`${span.heading}\`: stale text \`${span.staleText}\``,
				)
				.join("\n")
		: "- (none)";
	const skipped = context.deferredOrAcceptedRisks.map(
		(entry) => `${entry.title} (${entry.decisionId})`,
	);
	return `## Admitted implementation work\n\n${sharedImplementationLines(context)}\n- Recorded route: ${context.authorRoute ?? "(none)"}\n- Next action: ${context.authorNextAction ?? "(none)"}\n- Final correction: ${context.finalCorrection ? "yes" : "no"}\n- Eligible item: ${context.eligibleItemId ?? "(none)"}\n\nImplement only the admitted findings below and the governing decisions in this section. Do not infer extra work from the rest of the review Markdown.\n\n### Actionable findings\n\n${findings}\n\n### Text guard\n\nGuard: ${context.textGuard?.id ?? "(none)"}\n${guard}\n\nReplace only those literal spans, plus checkbox toggles. Structural amendments, budget-table bytes, and scope expansion require an approved amendment workflow.\n\n### Governing decisions\n\n- Finding IDs not to implement unless material new evidence is reviewed: ${list(skipped)}\n- Debt waivers and reductions stay in force. Assess and preserve the effective approved post-state; do not create credit.\n\n### Final correction limit\n\n${context.finalCorrection ? `Change only finding ${context.eligibleItemId ?? "(none)"}.` : "This pass is not a final correction."} Do not clean up unrelated code, tests, docs, or plan structure.`;
}
