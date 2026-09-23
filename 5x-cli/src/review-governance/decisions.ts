import { createHash, randomUUID } from "node:crypto";
import type {
	RecordLine,
	RecordStore,
	StepRecordPayload,
} from "../control-plane/index.js";
import { decodeBudgetSnapshotPayload } from "../review-budget/record-lines.js";
import type {
	FindingIdentity,
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
	decision: ReviewDecisionPayload;
	steps: readonly RecordLine[];
	budget: readonly RecordLine[];
}): DecisionAcceptance {
	const snapshots = input.budget.flatMap((line) => {
		try {
			const payload = decodeBudgetSnapshotPayload(line.payload);
			return payload.id === input.decision.snapshotId ? [payload] : [];
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
	causes: readonly ReviewGateCause[];
	predecessorGateId?: string;
}): string {
	const value = canonical({
		runId: input.runId,
		snapshotId: input.snapshotId,
		causes: [...input.causes].map((cause) => canonical(cause)).sort(),
		predecessorGateId: input.predecessorGateId,
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
