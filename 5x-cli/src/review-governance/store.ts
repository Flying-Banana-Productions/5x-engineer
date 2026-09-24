import type {
	AppendOp,
	RecordOrigin,
	RecordStore,
	StepRecordPayload,
} from "../control-plane/index.js";
import type { PromptStore } from "../control-plane/store.js";
import {
	isReviewGatePromptContext,
	REVIEW_GATE_PROMPT_CONTEXT_VERSION,
	type ReviewGatePromptContext,
} from "../control-plane/types.js";
import {
	decodeBudgetSnapshotPayload,
	decodeImplementationReviewObservationPayload,
	type ImplementationObservationGateCause,
	type ImplementationReviewObservationPayload,
} from "../review-budget/record-lines.js";
import {
	decodeImplementationDecisionPayload,
	decodeReviewDecisionPayload,
	encodeImplementationDecisionPayload,
	encodeReviewDecisionPayload,
} from "./codec.js";
import {
	applyDecisionCauseCoverage,
	applyImplementationDecisionCauseCoverage,
	classifyDecisionAcceptance,
	deriveGateId,
	foldGoverningReviewState,
	type GoverningReviewState,
	governanceCorrectionKey,
	governanceDecisionKey,
	type ImplementationDecisionPayload,
	implementationDecisionNextAction,
	listGovernanceDecisions,
	listImplementationDecisions,
	type ReviewDecisionPayload,
} from "./decisions.js";
import type {
	ImplementationDecisionChoice,
	ImplementationNextAction,
	ReviewDecisionRoute,
	ReviewGateCause,
} from "./types.js";

export interface DerivedReviewGate {
	gateId: string;
	runId: string;
	snapshotId: string;
	causes: ReviewGateCause[];
	resolved: boolean;
	decision?: ReviewDecisionPayload;
}

export const REVIEW_DECISION_REQUIRED_FIELDS: Record<
	ReviewDecisionPayload["choice"],
	string[]
> = {
	increase_budget: ["rationale", "baseline"],
	adjust_baseline: ["rationale", "baseline"],
	retain_baseline: ["rationale"],
	request_author_reestimate: ["rationale"],
	trade_scope: ["rationale", "retained or removed scope"],
	defer_accept_risk: ["rationale", "evidence", "findingRefs"],
	// Threshold-crossing ID fields are added from the current gate below.
	approve_architecture_burden: ["rationale", "approvedP"],
	abort: ["rationale"],
};

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

export function allowedChoicesForGate(input: {
	causes: readonly ReviewGateCause[];
	baselineReestimatePending?: boolean;
}): ReviewDecisionPayload["choice"][] {
	const choices: ReviewDecisionPayload["choice"][] = [];
	for (const cause of input.causes) {
		if (cause.kind === "budget_alert" && cause.alert === "baseline_disputed") {
			choices.push("adjust_baseline", "retain_baseline");
			if (!input.baselineReestimatePending)
				choices.push("request_author_reestimate", "trade_scope");
		} else if (cause.kind === "budget_band") {
			choices.push("increase_budget", "trade_scope", "defer_accept_risk");
		} else if (
			cause.kind === "budget_alert" &&
			cause.alert === "positive_architecture_exceeded"
		) {
			choices.push(
				"approve_architecture_burden",
				"trade_scope",
				"defer_accept_risk",
			);
		} else {
			choices.push("trade_scope");
			// Finding-backed safety/semantic causes are scoped. Submission still
			// requires explicit accepted-risk evidence.
			if ("finding" in cause) choices.push("defer_accept_risk");
		}
	}
	choices.push("abort");
	return unique(choices);
}

export function reviewGatePromptContext(input: {
	gate: DerivedReviewGate;
	baselineReestimatePending?: boolean;
	eligibleFindings?: readonly { findingId: string; fingerprint: string }[];
}): Extract<ReviewGatePromptContext, { type: "plan_review_gate" }> {
	const causeFindings = unique(
		input.gate.causes.flatMap((cause) =>
			"finding" in cause
				? [`${cause.finding.findingId}\u0000${cause.finding.fingerprint}`]
				: [],
		),
	).map((value) => {
		const [findingId, fingerprint] = value.split("\u0000");
		return { findingId: findingId ?? "", fingerprint: fingerprint ?? "" };
	});
	const eligibleFindings = [
		...new Map(
			[...causeFindings, ...(input.eligibleFindings ?? [])].map((finding) => [
				`${finding.findingId}\u0000${finding.fingerprint}`,
				structuredClone(finding),
			]),
		).values(),
	];
	const requiredFieldsByChoice = structuredClone(
		REVIEW_DECISION_REQUIRED_FIELDS,
	);
	const architectureCauses = input.gate.causes.flatMap((cause) =>
		cause.kind === "budget_alert" &&
		cause.alert === "positive_architecture_exceeded"
			? [cause]
			: [],
	);
	if (architectureCauses.some((cause) => (cause.itemIds?.length ?? 0) > 0))
		requiredFieldsByChoice.approve_architecture_burden.push("approvedItemIds");
	if (architectureCauses.some((cause) => (cause.workItemIds?.length ?? 0) > 0))
		requiredFieldsByChoice.approve_architecture_burden.push(
			"approvedWorkItemIds",
		);
	return {
		type: "plan_review_gate",
		gateId: input.gate.gateId,
		snapshotId: input.gate.snapshotId,
		causes: structuredClone(input.gate.causes),
		eligibleFindings,
		allowedChoices: allowedChoicesForGate({
			causes: input.gate.causes,
			baselineReestimatePending: input.baselineReestimatePending,
		}),
		requiredFieldsByChoice,
	};
}

/** Create or repair the notification projection for a derived open gate. */
export function ensureReviewGatePrompt(input: {
	promptStore: PromptStore;
	gate: DerivedReviewGate;
	baselineReestimatePending?: boolean;
	eligibleFindings?: readonly { findingId: string; fingerprint: string }[];
}): ReturnType<PromptStore["createPrompt"]> {
	const existing = input.promptStore
		.listOpenPrompts(input.gate.runId)
		.find((prompt) => prompt.context?.gateId === input.gate.gateId);
	if (existing) return existing;
	const context = reviewGatePromptContext(input);
	return input.promptStore.createPrompt({
		runId: input.gate.runId,
		kind: "choose",
		message: `Plan review requires a governance decision for gate ${input.gate.gateId}`,
		options: context.allowedChoices,
		defaultValue: null,
		contextVersion: REVIEW_GATE_PROMPT_CONTEXT_VERSION,
		context,
	});
}

export function ensureImplementationGatePrompt(input: {
	promptStore: PromptStore;
	gate: DerivedImplementationGate;
	ledgerHash: string;
	decisionsHash: string;
}): ReturnType<PromptStore["createPrompt"]> {
	const existing = input.promptStore
		.listOpenPrompts(input.gate.runId)
		.find((prompt) => prompt.context?.gateId === input.gate.gateId);
	if (existing) return existing;
	const context = implementationGatePromptContext(input);
	return input.promptStore.createPrompt({
		runId: input.gate.runId,
		kind: "choose",
		message: `Implementation review requires a governance decision for gate ${input.gate.gateId}`,
		options: context.allowedChoices,
		defaultValue: null,
		contextVersion: REVIEW_GATE_PROMPT_CONTEXT_VERSION,
		context,
	});
}

export function resolveGatePromptProjection(
	promptStore: PromptStore,
	runId: string,
	gateId: string,
	decisionId: string,
): void {
	for (const prompt of promptStore.listOpenPrompts(runId)) {
		if (prompt.context?.gateId === gateId) {
			if (!promptStore.resolveReviewGatePrompt) continue;
			try {
				promptStore.resolveReviewGatePrompt(prompt.id, decisionId);
			} catch {
				// Projection is repairable from the authoritative decision line.
			}
		}
	}
}

/** Best-effort records-first projection repair after a prompt/update crash. */
export function repairReviewGatePrompts(
	recordStore: RecordStore,
	promptStore: PromptStore,
	runId: string,
): number {
	let repaired = 0;
	for (const prompt of promptStore.listOpenPrompts(runId)) {
		const context = prompt.context;
		if (!isReviewGatePromptContext(context)) continue;
		const line = recordStore.getLine(
			runId,
			"decisions",
			governanceDecisionKey(context.gateId),
		);
		if (!line) continue;
		let decision: ReviewDecisionPayload | ImplementationDecisionPayload;
		try {
			decision =
				context.type === "implementation_review_gate"
					? decodeImplementationDecisionPayload(line.payload)
					: decodeReviewDecisionPayload(line.payload);
		} catch {
			continue;
		}
		const acceptance = classifyDecisionAcceptance({
			decision,
			steps: recordStore.listLines(runId, "steps"),
			budget: recordStore.listLines(runId, "budget"),
		});
		if (!acceptance.accepted) continue;
		if (!promptStore.resolveReviewGatePrompt) continue;
		try {
			if (
				promptStore.resolveReviewGatePrompt(prompt.id, decision.decisionId).ok
			)
				repaired++;
		} catch {
			// Keep the notification open for a later repair pass.
		}
	}
	return repaired;
}

export interface ResolveReviewGateInput {
	runId: string;
	decision: ReviewDecisionPayload;
	humanStep: StepRecordPayload;
	origin: RecordOrigin;
}

export type ResolveReviewGateResult =
	| {
			created: true;
			decision: ReviewDecisionPayload;
			route: ReviewDecisionRoute;
	  }
	| { created: false; decision: ReviewDecisionPayload; semanticRetry: boolean };

export class ReviewGovernanceStoreError extends Error {
	readonly code: "REVIEW_GATE_STEP_CONFLICT" | "REVIEW_GATE_DECISION_CONFLICT";
	constructor(
		code: "REVIEW_GATE_STEP_CONFLICT" | "REVIEW_GATE_DECISION_CONFLICT",
		message: string,
	) {
		super(message);
		this.name = "ReviewGovernanceStoreError";
		this.code = code;
	}
}

export interface DerivedImplementationGate {
	domain: "implementation";
	gateId: string;
	runId: string;
	observationId: string;
	bindingId: string;
	phase: string;
	ledgerHash: string;
	decisionsHash: string;
	causes: ImplementationObservationGateCause[];
	resolved: boolean;
}

export interface ResolveImplementationGateResult {
	created: boolean;
	decision: ImplementationDecisionPayload;
	semanticRetry?: boolean;
	route: ReviewDecisionRoute;
	nextAction: ImplementationNextAction | "aborted";
	successorGateId?: string;
}

export interface ReviewGovernanceStore {
	getDecision(runId: string, decisionId: string): ReviewDecisionPayload | null;
	listDecisions(runId: string): ReviewDecisionPayload[];
	deriveOpenGate(runId: string): DerivedReviewGate | null;
	resolveGate(input: ResolveReviewGateInput): ResolveReviewGateResult;
	deriveGoverningState(runId: string, b0: number): GoverningReviewState;
	deriveOpenImplementationGate(
		runId: string,
		phase: string,
	): DerivedImplementationGate | null;
	resolveImplementationGate(input: {
		runId: string;
		decision: ImplementationDecisionPayload;
		humanStep: StepRecordPayload;
		origin: RecordOrigin;
		ledgerHash: string;
		decisionsHash: string;
	}): ResolveImplementationGateResult;
}

function routeForChoice(
	choice: ReviewDecisionPayload["choice"],
): ReviewDecisionRoute {
	if (choice === "abort") return "aborted";
	if (choice === "trade_scope" || choice === "request_author_reestimate")
		return "author_revision";
	// Phase 4 replaces this conservative route with an authoritative budget rerun.
	return "human_gate";
}

export function createReviewGovernanceStore(
	recordStore: RecordStore,
	promptStore?: PromptStore,
): ReviewGovernanceStore {
	void promptStore;
	return {
		getDecision(runId, decisionId) {
			return (
				this.listDecisions(runId).find(
					(decision) => decision.decisionId === decisionId,
				) ?? null
			);
		},
		listDecisions(runId) {
			return listGovernanceDecisions(recordStore, runId).decisions;
		},
		deriveOpenGate(runId) {
			const snapshots = recordStore
				.listLines(runId, "budget")
				.flatMap((line) => {
					try {
						return [decodeBudgetSnapshotPayload(line.payload)];
					} catch {
						return [];
					}
				});
			const latest = snapshots.at(-1);
			if (!latest) return null;
			let causes = latest.effectiveGateCauses ?? [];
			if (causes.length === 0) return null;
			let predecessorGateId: string | undefined;
			while (causes.length > 0) {
				const gateId = deriveGateId({
					runId,
					snapshotId: latest.id,
					causes,
					...(predecessorGateId ? { predecessorGateId } : {}),
				});
				const line = recordStore.getLine(
					runId,
					"decisions",
					governanceDecisionKey(gateId),
				);
				if (!line)
					return {
						gateId,
						runId,
						snapshotId: latest.id,
						causes,
						resolved: false,
					};
				let decision: ReviewDecisionPayload;
				try {
					decision = decodeReviewDecisionPayload(line.payload);
				} catch {
					return {
						gateId,
						runId,
						snapshotId: latest.id,
						causes,
						resolved: false,
					};
				}
				const next = applyDecisionCauseCoverage(causes, decision);
				if (next.length === 0) return null;
				causes = next;
				predecessorGateId = gateId;
			}
			return null;
		},
		resolveGate(input) {
			if (input.humanStep.step_name !== "human:review-governance")
				throw new TypeError("human governance step has the wrong step name");
			const result = input.humanStep.result_json;
			if (
				!result ||
				typeof result !== "object" ||
				(result as { decisionId?: unknown }).decisionId !==
					input.decision.decisionId ||
				(result as { gateId?: unknown }).gateId !== input.decision.gateId
			)
				throw new TypeError(
					"human governance step must be stamped with decisionId and gateId",
				);
			const now = input.decision.createdAt;
			const decisionKey = input.decision.supersedesDecisionId
				? governanceCorrectionKey(input.decision.decisionId)
				: governanceDecisionKey(input.decision.gateId);
			const ops: AppendOp[] = [
				{
					runId: input.runId,
					stream: "steps",
					idempotencyKey: `step:${input.runId}:human:review-governance:${input.humanStep.phase ?? ""}:${input.humanStep.iteration}`,
					payload: structuredClone(input.humanStep),
					createdAt: now,
					schemaVersion: 1,
					provenance: "recorded",
					origin: input.origin,
				},
				{
					runId: input.runId,
					stream: "decisions",
					idempotencyKey: decisionKey,
					payload: encodeReviewDecisionPayload(input.decision),
					createdAt: now,
					schemaVersion: 1,
					provenance: "recorded",
					origin: input.origin,
				},
			];
			const appended = recordStore.atomicAppendIfAllNew(ops);
			if (appended.created)
				return {
					created: true,
					decision: input.decision,
					route: routeForChoice(input.decision.choice),
				};
			const winnerLine = recordStore.getLine(
				input.runId,
				"decisions",
				decisionKey,
			);
			if (!winnerLine) {
				if (appended.duplicates.some((duplicate) => duplicate.index === 0))
					throw new ReviewGovernanceStoreError(
						"REVIEW_GATE_STEP_CONFLICT",
						"human governance step identity already exists for a different decision",
					);
				throw new ReviewGovernanceStoreError(
					"REVIEW_GATE_DECISION_CONFLICT",
					"governance decision batch conflicted without a readable winner",
				);
			}
			const winner = decodeReviewDecisionPayload(winnerLine.payload);
			return {
				created: false,
				decision: winner,
				semanticRetry:
					winner.decisionIntentHash === input.decision.decisionIntentHash,
			};
		},
		deriveGoverningState(runId, b0) {
			return foldGoverningReviewState({
				b0,
				decisions: this.listDecisions(runId),
				steps: recordStore.listLines(runId, "steps"),
				budget: recordStore.listLines(runId, "budget"),
			});
		},
		deriveOpenImplementationGate(runId, phase) {
			return deriveOpenImplementationGate(recordStore, runId, phase);
		},
		resolveImplementationGate(input) {
			if (input.humanStep.step_name !== "human:review-governance")
				throw new TypeError("human governance step has the wrong step name");
			if (
				input.decision.ledgerHash !== input.ledgerHash ||
				input.decision.decisionsHash !== input.decisionsHash
			)
				throw new TypeError(
					"implementation decision fingerprint does not match the binding",
				);
			const result = input.humanStep.result_json;
			if (
				!result ||
				typeof result !== "object" ||
				(result as { decisionId?: unknown }).decisionId !==
					input.decision.decisionId ||
				(result as { gateId?: unknown }).gateId !== input.decision.gateId
			)
				throw new TypeError(
					"human governance step must be stamped with decisionId and gateId",
				);
			const decisionKey = input.decision.supersedesDecisionId
				? governanceCorrectionKey(input.decision.decisionId)
				: governanceDecisionKey(input.decision.gateId);
			const ops: AppendOp[] = [
				{
					runId: input.runId,
					stream: "steps",
					idempotencyKey: `step:${input.runId}:human:review-governance:${input.humanStep.phase ?? ""}:${input.humanStep.iteration}`,
					payload: structuredClone(input.humanStep),
					createdAt: input.decision.createdAt,
					schemaVersion: 1,
					provenance: "recorded",
					origin: input.origin,
				},
				{
					runId: input.runId,
					stream: "decisions",
					idempotencyKey: decisionKey,
					payload: encodeImplementationDecisionPayload(input.decision),
					createdAt: input.decision.createdAt,
					schemaVersion: 1,
					provenance: "recorded",
					origin: input.origin,
				},
			];
			const appended = recordStore.atomicAppendIfAllNew(ops);
			const stored = appended.created
				? input.decision
				: (() => {
						const winnerLine = recordStore.getLine(
							input.runId,
							"decisions",
							decisionKey,
						);
						if (!winnerLine) {
							if (
								appended.duplicates.some((duplicate) => duplicate.index === 0)
							)
								throw new ReviewGovernanceStoreError(
									"REVIEW_GATE_STEP_CONFLICT",
									"human governance step identity already exists for a different decision",
								);
							throw new ReviewGovernanceStoreError(
								"REVIEW_GATE_DECISION_CONFLICT",
								"governance decision batch conflicted without a readable winner",
							);
						}
						return decodeImplementationDecisionPayload(winnerLine.payload);
					})();
			const successor = deriveOpenImplementationGate(
				recordStore,
				input.runId,
				input.decision.phase,
			);
			const uncovered =
				successor && successor.gateId !== stored.gateId
					? successor.causes.length
					: 0;
			const nextAction = implementationDecisionNextAction(
				stored.choice,
				uncovered,
			);
			const route: ReviewDecisionRoute =
				nextAction === "aborted"
					? "aborted"
					: nextAction === "plan_amendment" || nextAction === "author_revision"
						? "author_revision"
						: nextAction === "human_gate"
							? "human_gate"
							: "complete";
			return {
				created: appended.created,
				decision: stored,
				...(appended.created
					? {}
					: {
							semanticRetry:
								stored.decisionIntentHash === input.decision.decisionIntentHash,
						}),
				route,
				nextAction,
				...(successor && successor.gateId !== stored.gateId
					? { successorGateId: successor.gateId }
					: {}),
			};
		},
	};
}

function implementationObservations(
	recordStore: RecordStore,
	runId: string,
): ImplementationReviewObservationPayload[] {
	return recordStore.listLines(runId, "budget").flatMap((line) => {
		try {
			return [decodeImplementationReviewObservationPayload(line.payload)];
		} catch {
			return [];
		}
	});
}

export function deriveOpenImplementationGate(
	recordStore: RecordStore,
	runId: string,
	phase: string,
): DerivedImplementationGate | null {
	const observations = implementationObservations(recordStore, runId).filter(
		(observation) => observation.phase === phase,
	);
	const latest = observations.at(-1);
	if (!latest || latest.gateCauses.length === 0) return null;
	const decisions = listImplementationDecisions(recordStore, runId).decisions;
	let causes = latest.gateCauses;
	let predecessorGateId: string | undefined;
	while (causes.length > 0) {
		const gateId = deriveGateId({
			runId,
			snapshotId: latest.id,
			causes,
			...(predecessorGateId ? { predecessorGateId } : {}),
			domain: "implementation",
			phase,
			bindingId: latest.bindingId,
			observationId: latest.id,
		});
		const decision = decisions.find(
			(candidate) =>
				candidate.gateId === gateId &&
				recordStore.getLine(runId, "decisions", governanceDecisionKey(gateId)),
		);
		if (!decision) {
			return {
				domain: "implementation",
				gateId,
				runId,
				observationId: latest.id,
				bindingId: latest.bindingId,
				phase,
				ledgerHash: "",
				decisionsHash: "",
				causes,
				resolved: false,
			};
		}
		const next = applyImplementationDecisionCauseCoverage(causes, decision);
		if (next.length === 0) return null;
		if (next.length === causes.length) {
			return {
				domain: "implementation",
				gateId,
				runId,
				observationId: latest.id,
				bindingId: latest.bindingId,
				phase,
				ledgerHash: "",
				decisionsHash: "",
				causes,
				resolved: false,
			};
		}
		causes = next;
		predecessorGateId = gateId;
	}
	return null;
}

export const IMPLEMENTATION_DECISION_REQUIRED_FIELDS: Record<
	ImplementationDecisionChoice,
	string[]
> = {
	authorize_amendment: ["rationale", "findingRefs"],
	defer_accept_risk: ["rationale", "evidence", "findingRefs"],
	restore_simplification: [
		"rationale",
		"claimAdjustments",
		"supersedesObservationId",
	],
	approve_higher_burden: ["rationale", "claimAdjustments"],
	reduce_scope: ["rationale", "claimAdjustments"],
	abort: ["rationale"],
};

export function implementationGatePromptContext(input: {
	gate: DerivedImplementationGate;
	ledgerHash: string;
	decisionsHash: string;
}): ReviewGatePromptContext {
	const eligibleFindings = input.gate.causes.flatMap((cause) =>
		"findingId" in cause
			? [{ findingId: cause.findingId, fingerprint: cause.fingerprint }]
			: [],
	);
	return {
		type: "implementation_review_gate",
		gateId: input.gate.gateId,
		observationId: input.gate.observationId,
		bindingId: input.gate.bindingId,
		phase: input.gate.phase,
		causes: structuredClone(input.gate.causes),
		eligibleFindings,
		allowedChoices: allowedImplementationChoices(input.gate.causes),
		requiredFieldsByChoice: structuredClone(
			IMPLEMENTATION_DECISION_REQUIRED_FIELDS,
		),
		ledgerHash: input.ledgerHash,
		decisionsHash: input.decisionsHash,
	};
}

export function allowedImplementationChoices(
	causes: readonly ImplementationObservationGateCause[],
): ImplementationDecisionChoice[] {
	const choices: ImplementationDecisionChoice[] = [];
	for (const cause of causes) {
		if (cause.kind === "plan_amendment") choices.push("authorize_amendment");
		if (
			cause.kind === "semantic_human" ||
			cause.kind === "critical_safety" ||
			cause.kind === "plan_amendment"
		)
			choices.push("defer_accept_risk");
		if (
			cause.kind === "credit_shortfall" ||
			cause.kind === "inherited_budget"
		) {
			choices.push(
				"restore_simplification",
				"approve_higher_burden",
				"reduce_scope",
			);
		}
		if (cause.kind === "credit_unreconciled") choices.push("reduce_scope");
	}
	choices.push("abort");
	return [...new Set(choices)];
}
