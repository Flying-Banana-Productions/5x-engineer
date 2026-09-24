import { createHash, randomUUID } from "node:crypto";
import type {
	RecordLine,
	RecordStore,
	StepRecordPayload,
} from "../control-plane/index.js";
import {
	decodeBudgetSnapshotPayload,
	decodeImplementationReviewObservationPayload,
	type ImplementationObservationGateCause,
} from "../review-budget/record-lines.js";
import type {
	FindingIdentity,
	ImplementationDecisionChoice,
	ImplementationNextAction,
	ReviewDecisionChoice,
	ReviewGateCause,
} from "./types.js";

export const REVIEW_DECISION_VERSION = 1 as const;

export interface ApprovedScope {
	retained: string[];
	removed: string[];
}

export interface ArchitectureApproval {
	decisionId: string;
	approvedP: number;
	approvedItemIds: string[];
	approvedWorkItemIds: string[];
}

export interface AcceptedRisk extends FindingIdentity {
	decisionId: string;
	rationale: string;
	evidence: string[];
}

export interface ReviewDecisionPayload {
	kind: "plan-review-governance";
	version: typeof REVIEW_DECISION_VERSION;
	decisionId: string;
	gateId: string;
	snapshotId: string;
	choice: ReviewDecisionChoice;
	decisionIntentHash: string;
	findingRefs: FindingIdentity[];
	rationale: string;
	evidence: string[];
	approvedScope: ApprovedScope;
	governingBaselineChange?: { from: number; to: number };
	architectureApproval?: {
		approvedP: number;
		approvedItemIds: string[];
		approvedWorkItemIds: string[];
	};
	supersedesDecisionId?: string;
	createdAt: string;
}

export interface GoverningReviewState {
	governingBaseline: number;
	baselineDisputeResolution?: {
		decisionId: string;
		choice: "retain_baseline" | "adjust_baseline";
	};
	baselineReestimatePending?: { decisionId: string };
	approvedScope: ApprovedScope;
	acceptedRisks: AcceptedRisk[];
	architectureApprovals: ArchitectureApproval[];
	aborted: boolean;
	history: ReviewDecisionPayload[];
	auditOnly: Array<{ decision: ReviewDecisionPayload; diagnostic: string }>;
}

export interface DecisionAcceptance {
	accepted: boolean;
	stale: boolean;
	diagnostic?: string;
	reviewerPosition?: number;
	humanPosition?: number;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function computeDecisionIntentHash(
	input: Omit<
		ReviewDecisionPayload,
		"decisionId" | "createdAt" | "decisionIntentHash"
	>,
): string {
	return `sha256:${createHash("sha256").update(canonical(input)).digest("hex")}`;
}

export function createReviewDecision(
	input: Omit<
		ReviewDecisionPayload,
		"kind" | "version" | "decisionId" | "createdAt" | "decisionIntentHash"
	> & {
		decisionId?: string;
		createdAt?: string;
	},
): ReviewDecisionPayload {
	const base = {
		kind: "plan-review-governance" as const,
		version: REVIEW_DECISION_VERSION,
		gateId: input.gateId,
		snapshotId: input.snapshotId,
		choice: input.choice,
		findingRefs: structuredClone(input.findingRefs),
		rationale: input.rationale,
		evidence: [...input.evidence],
		approvedScope: structuredClone(input.approvedScope),
		...(input.governingBaselineChange
			? { governingBaselineChange: { ...input.governingBaselineChange } }
			: {}),
		...(input.architectureApproval
			? { architectureApproval: structuredClone(input.architectureApproval) }
			: {}),
		...(input.supersedesDecisionId
			? { supersedesDecisionId: input.supersedesDecisionId }
			: {}),
	};
	const decisionIntentHash = computeDecisionIntentHash(base);
	return validateReviewDecision({
		...base,
		decisionId: input.decisionId ?? randomUUID(),
		createdAt: input.createdAt ?? new Date().toISOString(),
		decisionIntentHash,
	});
}

function nonEmpty(values: readonly string[]): boolean {
	return values.length > 0 && values.every((value) => value.trim().length > 0);
}

export function validateReviewDecision(
	input: ReviewDecisionPayload,
): ReviewDecisionPayload {
	if (
		input.kind !== "plan-review-governance" ||
		input.version !== REVIEW_DECISION_VERSION
	)
		throw new TypeError("unsupported review decision kind or version");
	for (const [name, value] of [
		["decisionId", input.decisionId],
		["gateId", input.gateId],
		["snapshotId", input.snapshotId],
		["rationale", input.rationale],
		["createdAt", input.createdAt],
	] as const) {
		if (!value.trim()) throw new TypeError(`${name} must be non-empty`);
	}
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			input.decisionId,
		)
	)
		throw new TypeError("decisionId must be a UUID");
	if (
		input.supersedesDecisionId &&
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			input.supersedesDecisionId,
		)
	)
		throw new TypeError("supersedesDecisionId must be a UUID");
	if (!/^sha256:[0-9a-f]{64}$/.test(input.decisionIntentHash))
		throw new TypeError("decisionIntentHash must be a SHA-256 hash");
	if (
		input.choice === "increase_budget" ||
		input.choice === "adjust_baseline"
	) {
		const change = input.governingBaselineChange;
		if (
			!change ||
			!Number.isInteger(change.to) ||
			change.to <= 0 ||
			!Number.isInteger(change.from) ||
			change.from <= 0
		)
			throw new TypeError(
				`${input.choice} requires a positive integer governingBaselineChange`,
			);
	}
	if (input.choice === "abort" && input.governingBaselineChange)
		throw new TypeError("abort cannot mutate the governing baseline");
	if (
		input.choice === "trade_scope" &&
		input.approvedScope.retained.length + input.approvedScope.removed.length ===
			0
	)
		throw new TypeError("trade_scope requires a scope delta");
	if (
		input.choice === "defer_accept_risk" &&
		(input.findingRefs.length === 0 || !nonEmpty(input.evidence))
	)
		throw new TypeError("defer_accept_risk requires finding refs and evidence");
	if (input.choice === "approve_architecture_burden") {
		const approval = input.architectureApproval;
		if (
			!approval ||
			!Number.isInteger(approval.approvedP) ||
			approval.approvedP < 0 ||
			!Array.isArray(approval.approvedItemIds) ||
			!Array.isArray(approval.approvedWorkItemIds)
		)
			throw new TypeError(
				"approve_architecture_burden requires an approval envelope",
			);
		// Empty ID lists represent aggregate-only approval. The gate-aware
		// submission validator checks exact threshold-crossing ID coverage.
	}
	const expected = computeDecisionIntentHash({
		kind: input.kind,
		version: input.version,
		gateId: input.gateId,
		snapshotId: input.snapshotId,
		choice: input.choice,
		findingRefs: input.findingRefs,
		rationale: input.rationale,
		evidence: input.evidence,
		approvedScope: input.approvedScope,
		governingBaselineChange: input.governingBaselineChange,
		architectureApproval: input.architectureApproval,
		supersedesDecisionId: input.supersedesDecisionId,
	});
	if (expected !== input.decisionIntentHash)
		throw new TypeError("decisionIntentHash does not match decision fields");
	return structuredClone(input);
}

function stepPayload(line: RecordLine): StepRecordPayload | null {
	if (!line.payload || typeof line.payload !== "object") return null;
	const value = line.payload as Partial<StepRecordPayload>;
	return typeof value.step_name === "string" &&
		Number.isInteger(value.iteration)
		? (value as StepRecordPayload)
		: null;
}

export function classifyDecisionAcceptance(input: {
	decision: ReviewDecisionPayload | ImplementationDecisionPayload;
	steps: readonly RecordLine[];
	budget: readonly RecordLine[];
}): DecisionAcceptance {
	if (input.decision.kind === "implementation-review-governance") {
		return classifyImplementationDecisionAcceptance({
			decision: input.decision,
			steps: input.steps,
			budget: input.budget,
		});
	}
	const decision: ReviewDecisionPayload = input.decision;
	const snapshots = input.budget.flatMap((line) => {
		try {
			const payload = decodeBudgetSnapshotPayload(line.payload);
			return payload.id === decision.snapshotId ? [payload] : [];
		} catch {
			return [];
		}
	});
	if (snapshots.length !== 1)
		return {
			accepted: false,
			stale: false,
			diagnostic: "snapshot boundary is missing or duplicated",
		};
	const snapshot = snapshots[0];
	if (!snapshot)
		return {
			accepted: false,
			stale: false,
			diagnostic: "snapshot boundary is missing",
		};
	const key = snapshot.stepKey;
	const reviewerPositions = input.steps.flatMap((line, position) => {
		const payload = stepPayload(line);
		return payload &&
			payload.step_name === key.stepName &&
			(payload.phase ?? null) === key.phase &&
			payload.iteration === key.iteration
			? [position]
			: [];
	});
	const humanPositions = input.steps.flatMap((line, position) => {
		const payload = stepPayload(line);
		if (payload?.step_name !== "human:review-governance") return [];
		const result = payload.result_json;
		return result &&
			typeof result === "object" &&
			(result as { decisionId?: unknown }).decisionId ===
				input.decision.decisionId &&
			(result as { gateId?: unknown }).gateId === input.decision.gateId
			? [position]
			: [];
	});
	if (reviewerPositions.length !== 1 || humanPositions.length !== 1)
		return {
			accepted: false,
			stale: false,
			diagnostic: "decision boundary step is missing or duplicated",
		};
	const reviewerPosition = reviewerPositions[0];
	const humanPosition = humanPositions[0];
	if (reviewerPosition === undefined || humanPosition === undefined)
		return {
			accepted: false,
			stale: false,
			diagnostic: "decision boundary is missing",
		};
	if (humanPosition <= reviewerPosition)
		return {
			accepted: false,
			stale: false,
			diagnostic: "human decision step must follow its reviewer step",
			reviewerPosition,
			humanPosition,
		};
	const stale = input.steps
		.slice(reviewerPosition + 1, humanPosition)
		.some((line) => {
			const payload = stepPayload(line);
			return (
				payload?.phase === "plan" && payload.step_name.startsWith("reviewer:")
			);
		});
	return {
		accepted: !stale,
		stale,
		...(stale
			? { diagnostic: "a newer plan reviewer step existed at acceptance" }
			: {}),
		reviewerPosition,
		humanPosition,
	};
}

export function foldGoverningReviewState(input: {
	b0: number;
	decisions: readonly ReviewDecisionPayload[];
	steps: readonly RecordLine[];
	budget: readonly RecordLine[];
}): GoverningReviewState {
	const state: GoverningReviewState = {
		governingBaseline: input.b0,
		approvedScope: { retained: [], removed: [] },
		acceptedRisks: [],
		architectureApprovals: [],
		aborted: false,
		history: [],
		auditOnly: [],
	};
	const accepted = input.decisions.map((decision) => ({
		decision,
		acceptance: classifyDecisionAcceptance({
			decision,
			steps: input.steps,
			budget: input.budget,
		}),
	}));
	const superseded = new Set(
		accepted.flatMap(({ decision, acceptance }) =>
			acceptance.accepted && decision.supersedesDecisionId
				? [decision.supersedesDecisionId]
				: [],
		),
	);
	for (const { decision, acceptance } of accepted) {
		if (!acceptance.accepted || superseded.has(decision.decisionId)) {
			state.auditOnly.push({
				decision,
				diagnostic: superseded.has(decision.decisionId)
					? "superseded"
					: (acceptance.diagnostic ?? "stale"),
			});
			continue;
		}
		state.history.push(decision);
		if (
			(decision.choice === "increase_budget" ||
				decision.choice === "adjust_baseline") &&
			decision.governingBaselineChange
		)
			state.governingBaseline = decision.governingBaselineChange.to;
		if (
			decision.choice === "retain_baseline" ||
			decision.choice === "adjust_baseline"
		) {
			state.baselineDisputeResolution = {
				decisionId: decision.decisionId,
				choice: decision.choice,
			};
			delete state.baselineReestimatePending;
		} else if (decision.choice === "request_author_reestimate")
			state.baselineReestimatePending = { decisionId: decision.decisionId };
		if (decision.choice === "trade_scope")
			state.approvedScope = structuredClone(decision.approvedScope);
		if (decision.choice === "defer_accept_risk")
			state.acceptedRisks.push(
				...decision.findingRefs.map((finding) => ({
					...finding,
					decisionId: decision.decisionId,
					rationale: decision.rationale,
					evidence: [...decision.evidence],
				})),
			);
		if (
			decision.choice === "approve_architecture_burden" &&
			decision.architectureApproval
		)
			state.architectureApprovals.push({
				decisionId: decision.decisionId,
				...structuredClone(decision.architectureApproval),
			});
		if (decision.choice === "abort") state.aborted = true;
	}
	return state;
}

export function deriveGateId(input: {
	runId: string;
	snapshotId: string;
	causes: ReadonlyArray<ReviewGateCause | ImplementationObservationGateCause>;
	predecessorGateId?: string;
	/** Omitted for plan gates so existing ids stay stable. */
	domain?: "implementation";
	phase?: string;
	bindingId?: string;
	observationId?: string;
}): string {
	const value = canonical({
		runId: input.runId,
		snapshotId: input.snapshotId,
		causes: [...input.causes].map((cause) => canonical(cause)).sort(),
		predecessorGateId: input.predecessorGateId,
		...(input.domain === "implementation"
			? {
					domain: input.domain,
					phase: input.phase,
					bindingId: input.bindingId,
					observationId: input.observationId,
				}
			: {}),
	});
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function governanceDecisionKey(gateId: string): string {
	return `decision:review-gate:${gateId}`;
}
export function governanceCorrectionKey(decisionId: string): string {
	return `decision:review:${decisionId}`;
}

/** Static cause coverage. Budget-changing choices are authoritatively rerun by Phase 4. */
export function applyDecisionCauseCoverage(
	causes: readonly ReviewGateCause[],
	decision: ReviewDecisionPayload,
): ReviewGateCause[] {
	if (
		decision.choice === "trade_scope" ||
		decision.choice === "request_author_reestimate" ||
		decision.choice === "abort"
	)
		return [];
	return causes.filter((cause) => {
		if (
			(decision.choice === "retain_baseline" ||
				decision.choice === "adjust_baseline") &&
			cause.kind === "budget_alert" &&
			cause.alert === "baseline_disputed"
		)
			return false;
		if (
			decision.choice === "approve_architecture_burden" &&
			cause.kind === "budget_alert" &&
			cause.alert === "positive_architecture_exceeded"
		)
			return false;
		if (decision.choice === "defer_accept_risk" && "finding" in cause)
			return !decision.findingRefs.some(
				(finding) =>
					finding.findingId === cause.finding.findingId &&
					finding.fingerprint === cause.finding.fingerprint,
			);
		return true;
	});
}

export function listGovernanceDecisions(
	recordStore: RecordStore,
	runId: string,
): { decisions: ReviewDecisionPayload[]; diagnostics: string[] } {
	const decisions: ReviewDecisionPayload[] = [];
	const diagnostics: string[] = [];
	for (const line of recordStore.listLines(runId, "decisions")) {
		const raw = line.payload as { kind?: unknown } | null;
		if (raw?.kind !== "plan-review-governance") continue;
		try {
			decisions.push(validateReviewDecision(raw as ReviewDecisionPayload));
		} catch (error) {
			diagnostics.push(
				`${line.idempotencyKey}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { decisions, diagnostics };
}

export const IMPLEMENTATION_DECISION_VERSION = 1 as const;

export interface ImplementationClaimAdjustment {
	creditClaimId: string;
	/** Approved post-state. Integer ≤ 0 and no more negative than the original claim. */
	approvedArchitectureDelta: number;
	supersedesObservationId?: string;
}

export interface ImplementationDecisionPayload {
	kind: "implementation-review-governance";
	version: typeof IMPLEMENTATION_DECISION_VERSION;
	decisionId: string;
	gateId: string;
	observationId: string;
	bindingId: string;
	phase: string;
	domain: "implementation";
	choice: ImplementationDecisionChoice;
	decisionIntentHash: string;
	findingRefs: FindingIdentity[];
	rationale: string;
	evidence: string[];
	claimAdjustments: ImplementationClaimAdjustment[];
	ledgerHash: string;
	decisionsHash: string;
	supersedesDecisionId?: string;
	createdAt: string;
}

export function computeImplementationDecisionIntentHash(
	input: Omit<
		ImplementationDecisionPayload,
		"decisionId" | "createdAt" | "decisionIntentHash"
	>,
): string {
	return `sha256:${createHash("sha256").update(canonical(input)).digest("hex")}`;
}

export function createImplementationDecision(
	input: Omit<
		ImplementationDecisionPayload,
		| "kind"
		| "version"
		| "domain"
		| "decisionId"
		| "createdAt"
		| "decisionIntentHash"
	> & {
		decisionId?: string;
		createdAt?: string;
	},
): ImplementationDecisionPayload {
	const base = {
		kind: "implementation-review-governance" as const,
		version: IMPLEMENTATION_DECISION_VERSION,
		gateId: input.gateId,
		observationId: input.observationId,
		bindingId: input.bindingId,
		phase: input.phase,
		domain: "implementation" as const,
		choice: input.choice,
		findingRefs: structuredClone(input.findingRefs),
		rationale: input.rationale,
		evidence: [...input.evidence],
		claimAdjustments: input.claimAdjustments.map((adjustment) => ({
			creditClaimId: adjustment.creditClaimId,
			approvedArchitectureDelta: adjustment.approvedArchitectureDelta,
			...(adjustment.supersedesObservationId
				? { supersedesObservationId: adjustment.supersedesObservationId }
				: {}),
		})),
		ledgerHash: input.ledgerHash,
		decisionsHash: input.decisionsHash,
		...(input.supersedesDecisionId
			? { supersedesDecisionId: input.supersedesDecisionId }
			: {}),
	};
	return validateImplementationDecision({
		...base,
		decisionId: input.decisionId ?? randomUUID(),
		createdAt: input.createdAt ?? new Date().toISOString(),
		decisionIntentHash: computeImplementationDecisionIntentHash(base),
	});
}

function uuid(value: string, name: string): void {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		)
	)
		throw new TypeError(`${name} must be a UUID`);
}

export function validateImplementationDecision(
	input: ImplementationDecisionPayload,
): ImplementationDecisionPayload {
	if (
		input.kind !== "implementation-review-governance" ||
		input.version !== IMPLEMENTATION_DECISION_VERSION ||
		input.domain !== "implementation"
	)
		throw new TypeError("unsupported implementation decision kind or version");
	for (const [name, value] of [
		["decisionId", input.decisionId],
		["gateId", input.gateId],
		["observationId", input.observationId],
		["bindingId", input.bindingId],
		["phase", input.phase],
		["rationale", input.rationale],
		["ledgerHash", input.ledgerHash],
		["decisionsHash", input.decisionsHash],
		["createdAt", input.createdAt],
	] as const) {
		if (!value.trim()) throw new TypeError(`${name} must be non-empty`);
	}
	uuid(input.decisionId, "decisionId");
	if (input.supersedesDecisionId)
		uuid(input.supersedesDecisionId, "supersedesDecisionId");
	if (!/^sha256:[0-9a-f]{64}$/.test(input.decisionIntentHash))
		throw new TypeError("decisionIntentHash must be a SHA-256 hash");
	if (
		!Array.isArray(input.findingRefs) ||
		!Array.isArray(input.claimAdjustments)
	)
		throw new TypeError("findingRefs and claimAdjustments must be arrays");
	if (!Array.isArray(input.evidence))
		throw new TypeError("evidence must be an array");
	const choices: ImplementationDecisionChoice[] = [
		"authorize_amendment",
		"defer_accept_risk",
		"restore_simplification",
		"approve_higher_burden",
		"reduce_scope",
		"abort",
	];
	if (!choices.includes(input.choice))
		throw new TypeError("unsupported implementation decision choice");
	if (
		(input.choice === "authorize_amendment" ||
			input.choice === "defer_accept_risk") &&
		input.findingRefs.length === 0
	)
		throw new TypeError(`${input.choice} requires finding refs`);
	if (input.choice === "defer_accept_risk" && !nonEmpty(input.evidence))
		throw new TypeError("defer_accept_risk requires finding refs and evidence");
	if (
		input.choice === "authorize_amendment" &&
		input.claimAdjustments.length > 0
	)
		throw new TypeError("authorize_amendment rejects claim adjustments");
	if (input.choice === "abort" && input.claimAdjustments.length > 0)
		throw new TypeError("abort cannot change approved credit");
	if (
		(input.choice === "restore_simplification" ||
			input.choice === "approve_higher_burden" ||
			input.choice === "reduce_scope") &&
		input.claimAdjustments.length === 0
	)
		throw new TypeError(`${input.choice} requires claim adjustments`);
	if (
		input.choice !== "defer_accept_risk" &&
		input.choice !== "authorize_amendment" &&
		input.findingRefs.length > 0 &&
		input.choice !== "abort"
	) {
		// Claim choices must not smuggle unrelated finding scope.
		if (
			input.choice === "restore_simplification" ||
			input.choice === "approve_higher_burden" ||
			input.choice === "reduce_scope"
		)
			throw new TypeError(`${input.choice} rejects unrelated finding scope`);
	}
	for (const adjustment of input.claimAdjustments) {
		if (!adjustment.creditClaimId.trim())
			throw new TypeError("creditClaimId must be non-empty");
		if (
			typeof adjustment.approvedArchitectureDelta !== "number" ||
			!Number.isInteger(adjustment.approvedArchitectureDelta) ||
			adjustment.approvedArchitectureDelta > 0
		)
			throw new TypeError(
				"approvedArchitectureDelta must be a non-positive integer",
			);
		if (
			input.choice === "restore_simplification" &&
			!adjustment.supersedesObservationId?.trim()
		)
			throw new TypeError(
				"restore_simplification requires a supersession observation id",
			);
	}
	const expected = computeImplementationDecisionIntentHash({
		kind: input.kind,
		version: input.version,
		gateId: input.gateId,
		observationId: input.observationId,
		bindingId: input.bindingId,
		phase: input.phase,
		domain: input.domain,
		choice: input.choice,
		findingRefs: input.findingRefs,
		rationale: input.rationale,
		evidence: input.evidence,
		claimAdjustments: input.claimAdjustments,
		ledgerHash: input.ledgerHash,
		decisionsHash: input.decisionsHash,
		supersedesDecisionId: input.supersedesDecisionId,
	});
	if (expected !== input.decisionIntentHash)
		throw new TypeError("decisionIntentHash does not match decision fields");
	return structuredClone(input);
}

export function assertImplementationDecisionScope(input: {
	decision: ImplementationDecisionPayload;
	/** Claim ids on the bound approved ledger. */
	allowedClaimIds: ReadonlySet<string>;
	/** Original approved deltas, negative or zero. */
	originalDeltas: ReadonlyMap<string, number>;
	/** Claim ids named by the open gate. */
	gateClaimIds: ReadonlySet<string>;
}): void {
	for (const adjustment of input.decision.claimAdjustments) {
		if (!input.allowedClaimIds.has(adjustment.creditClaimId))
			throw new TypeError(
				`arbitrary claim ${adjustment.creditClaimId} is not on the approved ledger`,
			);
		if (!input.gateClaimIds.has(adjustment.creditClaimId))
			throw new TypeError(
				`claim ${adjustment.creditClaimId} is not a cause of this gate`,
			);
		const original = input.originalDeltas.get(adjustment.creditClaimId);
		if (original === undefined)
			throw new TypeError(
				`claim ${adjustment.creditClaimId} has no approved delta`,
			);
		if (adjustment.approvedArchitectureDelta < original)
			throw new TypeError(
				`claim ${adjustment.creditClaimId} cannot broaden approved credit`,
			);
		if (
			input.decision.choice === "restore_simplification" &&
			adjustment.approvedArchitectureDelta !== original
		)
			throw new TypeError(
				"restore_simplification keeps the original claim magnitude",
			);
		if (
			(input.decision.choice === "approve_higher_burden" ||
				input.decision.choice === "reduce_scope") &&
			adjustment.approvedArchitectureDelta === original
		)
			throw new TypeError(
				`${input.decision.choice} must reduce the approved magnitude`,
			);
	}
}

function reviewerStepPositions(
	steps: readonly RecordLine[],
	stepName: string,
	phase: string | null,
	iteration: number | null,
): number[] {
	return steps.flatMap((line, position) => {
		const payload = stepPayload(line);
		return payload &&
			payload.step_name === stepName &&
			(payload.phase ?? null) === phase &&
			payload.iteration === iteration
			? [position]
			: [];
	});
}

function humanDecisionPositions(
	steps: readonly RecordLine[],
	decision: { decisionId: string; gateId: string },
): number[] {
	return steps.flatMap((line, position) => {
		const payload = stepPayload(line);
		if (payload?.step_name !== "human:review-governance") return [];
		const result = payload.result_json;
		return result &&
			typeof result === "object" &&
			(result as { decisionId?: unknown }).decisionId === decision.decisionId &&
			(result as { gateId?: unknown }).gateId === decision.gateId
			? [position]
			: [];
	});
}

function classifyImplementationDecisionAcceptance(input: {
	decision: ImplementationDecisionPayload;
	steps: readonly RecordLine[];
	budget: readonly RecordLine[];
}): DecisionAcceptance {
	const observations = input.budget.flatMap((line) => {
		try {
			const payload = decodeImplementationReviewObservationPayload(
				line.payload,
			);
			return payload.id === input.decision.observationId ? [payload] : [];
		} catch {
			return [];
		}
	});
	if (observations.length !== 1)
		return {
			accepted: false,
			stale: false,
			diagnostic: "observation boundary is missing or duplicated",
		};
	const observation = observations[0];
	if (!observation)
		return {
			accepted: false,
			stale: false,
			diagnostic: "observation boundary is missing",
		};
	if (
		observation.phase !== input.decision.phase ||
		observation.bindingId !== input.decision.bindingId
	)
		return {
			accepted: false,
			stale: false,
			diagnostic: "decision binding or phase does not match its observation",
		};
	const key = observation.stepKey;
	const reviewerPositions = reviewerStepPositions(
		input.steps,
		key.stepName,
		key.phase,
		key.iteration,
	);
	const humanPositions = humanDecisionPositions(input.steps, input.decision);
	if (reviewerPositions.length !== 1 || humanPositions.length !== 1)
		return {
			accepted: false,
			stale: false,
			diagnostic: "decision boundary step is missing or duplicated",
		};
	const reviewerPosition = reviewerPositions[0];
	const humanPosition = humanPositions[0];
	if (reviewerPosition === undefined || humanPosition === undefined)
		return {
			accepted: false,
			stale: false,
			diagnostic: "decision boundary is missing",
		};
	if (humanPosition <= reviewerPosition)
		return {
			accepted: false,
			stale: false,
			diagnostic: "human decision step must follow its reviewer step",
			reviewerPosition,
			humanPosition,
		};
	const staleReview = input.steps
		.slice(reviewerPosition + 1, humanPosition)
		.some((line) => {
			const payload = stepPayload(line);
			return (
				payload?.phase === input.decision.phase &&
				payload.step_name.startsWith("reviewer:")
			);
		});
	const observationIndex = input.budget.findIndex((line) => {
		try {
			return (
				decodeImplementationReviewObservationPayload(line.payload).id ===
				input.decision.observationId
			);
		} catch {
			return false;
		}
	});
	const supersededBinding = input.budget
		.slice(observationIndex + 1)
		.some((line) => {
			const raw = line.payload as { kind?: unknown; id?: unknown } | null;
			return (
				raw?.kind === "implementation-binding" &&
				raw.id !== input.decision.bindingId
			);
		});
	const stale = staleReview || supersededBinding;
	return {
		accepted: !stale,
		stale,
		...(stale
			? {
					diagnostic: supersededBinding
						? "a superseding binding invalidated execution gate authority"
						: "a newer same-phase reviewer step existed at acceptance",
				}
			: {}),
		reviewerPosition,
		humanPosition,
	};
}

export function implementationDecisionNextAction(
	choice: ImplementationDecisionChoice,
	remainingCauses: number,
): ImplementationNextAction | "aborted" {
	if (choice === "abort") return "aborted";
	if (choice === "authorize_amendment" || choice === "reduce_scope")
		return "plan_amendment";
	if (choice === "restore_simplification") return "author_revision";
	return remainingCauses > 0 ? "human_gate" : "complete";
}

/** Coverage for one implementation decision. At most the uncovered remainder remains. */
export function applyImplementationDecisionCauseCoverage(
	causes: readonly ImplementationObservationGateCause[],
	decision: ImplementationDecisionPayload,
): ImplementationObservationGateCause[] {
	if (decision.choice === "abort") return [];
	const findings = new Set(
		decision.findingRefs.map(
			(finding) => `${finding.findingId}\u0000${finding.fingerprint}`,
		),
	);
	const adjusted = new Map(
		decision.claimAdjustments.map((adjustment) => [
			adjustment.creditClaimId,
			adjustment.approvedArchitectureDelta,
		]),
	);
	const next: ImplementationObservationGateCause[] = [];
	for (const cause of causes) {
		if (
			(decision.choice === "defer_accept_risk" ||
				decision.choice === "authorize_amendment") &&
			(cause.kind === "semantic_human" ||
				cause.kind === "critical_safety" ||
				cause.kind === "plan_amendment") &&
			findings.has(`${cause.findingId}\u0000${cause.fingerprint}`)
		) {
			if (
				decision.choice === "authorize_amendment" &&
				cause.kind !== "plan_amendment"
			) {
				next.push(cause);
			}
			continue;
		}
		if (cause.kind === "credit_shortfall") {
			if (
				decision.choice !== "approve_higher_burden" &&
				decision.choice !== "reduce_scope" &&
				decision.choice !== "restore_simplification"
			) {
				next.push(cause);
				continue;
			}
			const claims = cause.claims.filter((claim) => {
				const approved = adjusted.get(claim.creditClaimId);
				if (approved === undefined) return true;
				if (decision.choice === "restore_simplification") return false;
				return claim.realizedArchitectureDelta > approved;
			});
			if (claims.length > 0)
				next.push({
					...cause,
					claimIds: claims.map((claim) => claim.creditClaimId),
					claims,
				});
			continue;
		}
		if (cause.kind === "credit_unreconciled") {
			next.push(cause);
			continue;
		}
		if (cause.kind === "inherited_budget") {
			if (
				decision.choice === "approve_higher_burden" &&
				cause.alerts.length > 0 &&
				cause.alerts.every((alert) => alert === "credit_unrealized")
			) {
				const shortfallRemains = next.some(
					(item) => item.kind === "credit_shortfall",
				);
				if (!shortfallRemains && cause.band !== "over_absolute") continue;
			}
			next.push(cause);
			continue;
		}
		next.push(cause);
	}
	return next;
}

export function listImplementationDecisions(
	recordStore: RecordStore,
	runId: string,
): { decisions: ImplementationDecisionPayload[]; diagnostics: string[] } {
	const decisions: ImplementationDecisionPayload[] = [];
	const diagnostics: string[] = [];
	for (const line of recordStore.listLines(runId, "decisions")) {
		const raw = line.payload as { kind?: unknown; version?: unknown } | null;
		if (raw?.kind !== "implementation-review-governance") continue;
		if (raw.version !== IMPLEMENTATION_DECISION_VERSION) {
			diagnostics.push(
				`${line.idempotencyKey}: unsupported implementation decision version`,
			);
			continue;
		}
		try {
			decisions.push(
				validateImplementationDecision(raw as ImplementationDecisionPayload),
			);
		} catch (error) {
			diagnostics.push(
				`${line.idempotencyKey}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { decisions, diagnostics };
}

/** Fingerprint carried on an accepted implementation decision, never copied from the binding. */
export function bindingEvidenceFromImplementationDecisions(input: {
	recordStore: RecordStore;
	runId: string;
	bindingId: string;
}): { id: string; ledgerHash: string; decisionsHash: string } | undefined {
	const listed = listImplementationDecisions(input.recordStore, input.runId);
	const steps = input.recordStore.listLines(input.runId, "steps");
	const budget = input.recordStore.listLines(input.runId, "budget");
	const accepted = listed.decisions.filter(
		(decision) =>
			decision.bindingId === input.bindingId &&
			classifyDecisionAcceptance({ decision, steps, budget }).accepted,
	);
	const latest = accepted.at(-1);
	if (!latest) return undefined;
	return {
		id: latest.bindingId,
		ledgerHash: latest.ledgerHash,
		decisionsHash: latest.decisionsHash,
	};
}
