/**
 * Canonical effective execution revision.
 *
 * The binding line stays immutable. Legacy recoveries and semantic amendments
 * append revisions. Historical lines without a revision field are attributed
 * from journal order inside one stream. Registration appends one paired
 * receipt. The fold does not synthesize a reviewer assessment for a legacy
 * recovery.
 */

import { createHash } from "node:crypto";
import type { RecordStore } from "../control-plane/record-store.js";
import {
	type AppendOp,
	type AtomicAppendIfAllNewResult,
	type RecordLine,
	type RecordOrigin,
	RecordStoreError,
	type RecordStream,
	recordedEnvelope,
	type StepRecordPayload,
	stepIdempotencyKey,
} from "../control-plane/record-types.js";
import { CliError } from "../output.js";
import { parseDeliveryBudget } from "../parsers/delivery-budget.js";
import { type Phase, parsePlan } from "../parsers/plan.js";
import {
	type AmendmentAssessment,
	type AmendmentClaimEdit,
	type AmendmentPreservedPhase,
	type AmendmentResolvedFinding,
	type AmendmentScope,
	parseAmendmentAssessment,
	parseAmendmentScope,
	type VerdictItem,
} from "../protocol.js";
import {
	decodeBudgetSnapshotPayload,
	decodeImplementationBindingPayload,
	decodeImplementationCorrectionAttemptPayload,
	decodeImplementationCreditReconciliationPayload,
	decodeImplementationPlanRecoveryPayload,
	decodeImplementationReviewContextPayload,
	decodeImplementationReviewObservationPayload,
	decodeImplementationSemanticAmendmentPayload,
	decodeImplementationTextAmendmentPayload,
	type ImplementationBindingPayload,
	type ImplementationCorrectionAttemptPayload,
	type ImplementationCreditReconciliationPayload,
	type ImplementationPlanRecoveryPayload,
	type ImplementationReviewContextPayload,
	type ImplementationReviewObservationPayload,
	type ImplementationReviewStepKey,
	type ImplementationSemanticAmendmentPayload,
	type ImplementationTextAmendmentPayload,
	implementationBindingKey,
	implementationSemanticAmendmentKey,
} from "../review-budget/record-lines.js";
import type {
	ParsedDeliveryBudget,
	ParsedWorkItem,
} from "../review-budget/types.js";
import {
	classifyDecisionAcceptance,
	type ImplementationDecisionPayload,
	listImplementationDecisions,
	validateImplementationDecision,
} from "./decisions.js";
import { fingerprintImplementationVerdictItem } from "./fingerprint.js";
import { normalizeCheckboxMarkers } from "./plan-amendment.js";
import type { FindingIdentity } from "./types.js";

export function initialRevisionId(bindingId: string): string {
	return bindingId;
}

export interface RevisionFoldDiagnostic {
	runId: string;
	stream: "steps" | "decisions" | "budget";
	recordId: string;
	recoveryIds: string[];
	message: string;
}

export interface EffectiveRevision {
	id: string;
	kind:
		| "initial"
		| "legacy_frontier_recovery"
		| "implementation_plan_amendment";
	predecessorId: string | null;
	approvedPlanHash: string;
	approvedPlanBytes: string;
	authorizationId?: string;
	earliestAffectedPhase?: string;
	/** Legacy revisions are not given a synthetic reviewer assessment. */
	amendmentAssessment: null;
	/** Operator attestations copied from a historical recovery receipt. */
	legacy?: {
		scopeConfirmation: string;
		preservedPhaseConfirmation: string;
		commit: string;
	};
}

export interface RegisteredDisposition {
	revisionId: string;
	earliestAffectedPhase: string;
	preservedPhases: AmendmentPreservedPhase[];
	resolvedFindings: AmendmentResolvedFinding[];
	claimEdits: AmendmentClaimEdit[];
}

export interface RevisionEvidence {
	stream: "budget" | "steps" | "decisions";
	recordId: string;
	kind: string;
	revisionId: string;
	applicability: "applicable" | "invalidated" | "baseline";
	certifies: boolean;
	phase?: string;
	observationId?: string;
}

export interface EffectiveFinding {
	phase: string;
	observationId: string;
	findingId: string;
	fingerprint: string;
	recordedRevisionId: string;
	status: "pending" | "amendment_resolved";
	reason?: string;
}

export interface EffectiveExecution {
	ok: true;
	runId: string;
	bindingId: string;
	initialRevisionId: string;
	currentRevisionId: string;
	selectedRevisionId: string;
	pinned: {
		b0: number;
		governingB: number;
		mode: ImplementationBindingPayload["mode"];
		sourceRunId: string;
		bindingId: string;
	};
	revisions: EffectiveRevision[];
	dispositions: RegisteredDisposition[];
	evidence: RevisionEvidence[];
	findings: EffectiveFinding[];
	/**
	 * Authorized plan at the selected prefix, including text amendments
	 * recorded during that revision. Not a second byte chain.
	 */
	approvedPlanBytes: string;
	approvedPlanHash: string;
	/** Lineage parent at the end of the selected prefix. */
	lineageParentId: string | null;
	invalidatedContextIds: string[];
	invalidatedObservationIds: string[];
}

export type EffectiveExecutionResult =
	| EffectiveExecution
	| { ok: false; diagnostic: RevisionFoldDiagnostic };

export interface RevisionHistoryEntry {
	id: string;
	kind: EffectiveRevision["kind"];
	predecessorId: string | null;
	earliestAffectedPhase: string | null;
	authorizationId: string | null;
}

/** Operator view of original binding provenance versus the effective revision. */
export interface RevisionProvenance {
	ok: true;
	completionAuthorized: false;
	original: {
		bindingId: string;
		sourceRunId: string;
		sourceSnapshotId: string;
		sourceBaselineId: string;
		approvedPlanCommit: string;
		approvedPlanHash: string;
		initialRevisionId: string;
		b0: number;
		governingB: number;
		mode: ImplementationBindingPayload["mode"];
	};
	effective: {
		revisionId: string;
		kind: EffectiveRevision["kind"];
		predecessorId: string | null;
		approvedPlanHash: string;
		earliestAffectedPhase: string | null;
		authorizationId: string | null;
		legacy: NonNullable<EffectiveRevision["legacy"]> | null;
	};
	history: RevisionHistoryEntry[];
	affectedPhases: string[];
	retainedEvidence: RevisionEvidence[];
	pendingFindings: EffectiveFinding[];
	resolvedFindings: EffectiveFinding[];
	creditDifferences: AmendmentClaimEdit[];
	/** Claims with no edit on the effective revision. Affected-phase evidence still does not certify. */
	unchangedClaimIds: string[];
	baselineUnchanged: true;
}

export interface RevisionProvenanceFailure {
	ok: false;
	completionAuthorized: false;
	original: RevisionProvenance["original"];
	diagnostic: RevisionFoldDiagnostic;
}

interface ObservedFinding {
	phase: string;
	observationId: string;
	findingId: string;
	fingerprint: string;
	recordedRevisionId: string;
}

interface SeenRecord {
	id: string;
	phase: string;
	kind: "context" | "observation" | "correction" | "credit" | "text";
	revisionId: string;
	recordId: string;
	completionAuthorized: boolean;
	observationId?: string;
	findings: ObservedFinding[];
	/** Closure outcomes from the observation verdict. Absent on other evidence. */
	priorFindings?: ReadonlyArray<{ id: string; status: string }>;
}

interface OpenBoundary {
	id: string;
	contexts: Set<string>;
	observations: Set<string>;
	resolutions: AmendmentResolvedFinding[];
}

const LINEAGE_KINDS = new Set([
	"implementation-text-amendment",
	"implementation-plan-recovery",
	"implementation-plan-amendment",
]);

const EVIDENCE_KINDS = new Set([
	"implementation-review-context",
	"implementation-review",
	"implementation-correction-attempt",
	"implementation-credit-reconciliation",
]);

function hashPlanBytes(bytes: string): string {
	return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function payloadRecord(line: RecordLine): Record<string, unknown> | null {
	if (
		typeof line.payload !== "object" ||
		line.payload === null ||
		Array.isArray(line.payload)
	) {
		return null;
	}
	return line.payload as Record<string, unknown>;
}

function stepRecord(line: RecordLine): StepRecordPayload | null {
	const payload = payloadRecord(line);
	if (!payload || typeof payload.step_name !== "string") return null;
	if (typeof payload.iteration !== "number") return null;
	return payload as unknown as StepRecordPayload;
}

function observationStepKey(
	runId: string,
	stepKey: ImplementationReviewStepKey,
): string {
	if (stepKey.iteration === null) {
		return `step:${runId}:${stepKey.stepName}:${stepKey.phase ?? ""}:`;
	}
	return stepIdempotencyKey({
		runId,
		stepName: stepKey.stepName,
		phase: stepKey.phase,
		iteration: stepKey.iteration,
	});
}

function phaseSection(
	markdown: string,
	phases: Phase[],
	index: number,
): string {
	const phase = phases[index];
	if (!phase) return "";
	const end = phases[index + 1]?.line;
	const lines = markdown.split(/\r\n|\n|\r/);
	return normalizeCheckboxMarkers(
		lines
			.slice(phase.line - 1, end === undefined ? undefined : end - 1)
			.join("\n"),
	).trim();
}

function mapPhase(label: string, phaseIds: readonly string[]): string | null {
	const trimmed = label.trim();
	const prefixed = trimmed.match(/^phase[\s-]+(\d+(?:\.\d+)?)$/i);
	const phaseId =
		prefixed?.[1] ?? (/^\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : null);
	if (!phaseId || !phaseIds.includes(phaseId)) return null;
	return phaseId;
}

function claimContract(ledger: ParsedDeliveryBudget, phaseId: string): string {
	return JSON.stringify(
		ledger.workItems
			.filter((item) =>
				item.debtClaim
					? mapPhase(item.debtClaim.targetPhase, [phaseId]) === phaseId
					: false,
			)
			.map((item) => ({
				id: item.id,
				title: item.title,
				effort: item.effort,
				architectureDelta: item.architectureDelta,
				debtClaim: item.debtClaim,
			})),
	);
}

/** Work-item ids named by a preserved phase heading or section body. */
function namedWorkItemIds(section: string): string[] {
	const ids: string[] = [];
	const seenIds = new Set<string>();
	for (const match of section.matchAll(/\b(W\d+)\b/g)) {
		const id = match[1];
		if (!id || seenIds.has(id)) continue;
		seenIds.add(id);
		ids.push(id);
	}
	return ids;
}

function workItemContract(ledger: ParsedDeliveryBudget, id: string): string {
	const item = ledger.workItems.find((entry) => entry.id === id);
	if (!item) return "missing";
	return JSON.stringify({
		id: item.id,
		title: item.title,
		effort: item.effort,
		architectureDelta: item.architectureDelta,
		debtClaim: item.debtClaim,
		addresses: item.addresses,
		rationale: item.rationale,
	});
}

/**
 * Open finding ids for one observation. Same rule as `openCodeFindings`:
 * latest items, plus still-open or partial prior outcomes, minus addressed.
 */
function openFindingIds(
	items: readonly { findingId: string }[],
	priorFindings: readonly { id: string; status: string }[],
): string[] {
	const outcomes = new Map<string, string>();
	for (const outcome of priorFindings) {
		if (outcome.id) outcomes.set(outcome.id, outcome.status);
	}
	const ids: string[] = [];
	const seenIds = new Set<string>();
	const add = (id: string) => {
		if (!id || seenIds.has(id) || outcomes.get(id) === "addressed") return;
		seenIds.add(id);
		ids.push(id);
	};
	for (const item of items) add(item.findingId);
	for (const [id, status] of outcomes) {
		if (status === "still_open" || status === "partially_addressed") add(id);
	}
	return ids;
}

function resolutionFor(
	identity: ObservedFinding,
	group: readonly SeenRecord[],
	resolutions: ReadonlyMap<string, AmendmentResolvedFinding>,
): AmendmentResolvedFinding | undefined {
	for (const observation of group) {
		const resolved = resolutions.get(
			`${identity.phase}\u0000${observation.id}\u0000${identity.findingId}`,
		);
		if (!resolved) continue;
		const recorded = observation.findings.some(
			(finding) =>
				finding.findingId === identity.findingId &&
				finding.fingerprint === resolved.fingerprint,
		);
		if (recorded) return resolved;
	}
	return undefined;
}

function unique(ids: readonly string[]): Set<string> | null {
	const set = new Set(ids);
	return set.size === ids.length ? set : null;
}

/**
 * Trusted predecessor, hash, and diff for a plan-domain amendment review.
 * Callers append this after template rendering. It does not authorize carry.
 */
export function formatAmendmentReviewPromptContext(input: {
	predecessorRevisionId: string;
	reviewedPlanHash: string;
	planDiff: string;
}): string {
	const diff = input.planDiff.trim();
	return [
		"## Trusted Amendment Review Context",
		"",
		"The CLI supplies the predecessor revision, reviewed plan hash, and plan diff.",
		"Copy the predecessor and hash into amendmentAssessment, and review the diff.",
		"Do not infer preserved phases, finding resolution, or claim effects from",
		"readiness, summary, or rationale.",
		"",
		`Predecessor revision: \`${input.predecessorRevisionId}\``,
		`Reviewed plan hash: \`${input.reviewedPlanHash}\``,
		"",
		"Plan diff:",
		"",
		diff.length > 0 ? diff : "(no plan diff)",
		"",
	].join("\n");
}

export function verifyAmendmentAssessment(input: {
	assessment: AmendmentAssessment;
	predecessorRevisionId: string;
	reviewedPlanHash: string;
	observations: ReadonlyArray<{
		id: string;
		phase: string;
		items: ReadonlyArray<{ findingId: string; fingerprint: string }>;
	}>;
}): { ok: true } | { ok: false; message: string } {
	const parsed = parseAmendmentAssessment(input.assessment);
	if (parsed.predecessorRevisionId !== input.predecessorRevisionId) {
		return {
			ok: false,
			message:
				"amendmentAssessment predecessor does not match the trusted revision",
		};
	}
	if (parsed.reviewedPlanHash !== input.reviewedPlanHash) {
		return {
			ok: false,
			message: "amendmentAssessment hash does not match the trusted plan hash",
		};
	}
	for (const finding of parsed.resolvedFindings) {
		const observation = input.observations.find(
			(entry) =>
				entry.id === finding.observationId && entry.phase === finding.phase,
		);
		const item = observation?.items.find(
			(entry) =>
				entry.findingId === finding.findingId &&
				entry.fingerprint === finding.fingerprint,
		);
		if (!observation || !item) {
			return {
				ok: false,
				message: `resolved finding ${finding.findingId} is not on ${finding.phase}/${finding.observationId}`,
			};
		}
	}
	return { ok: true };
}

export function foldEffectiveExecution(input: {
	recordStore: RecordStore;
	runId: string;
	revisionId?: string;
}): EffectiveExecutionResult {
	const opened: string[] = [];
	const fail = (
		stream: RevisionFoldDiagnostic["stream"],
		recordId: string,
		message: string,
		boundaryId?: string,
	): EffectiveExecutionResult => ({
		ok: false,
		diagnostic: {
			runId: input.runId,
			stream,
			recordId,
			recoveryIds: boundaryId ? [...opened, boundaryId] : [...opened],
			message: `${message} Explicit repair or review is required.`,
		},
	});

	const budget = input.recordStore.listLines(input.runId, "budget");
	const bindingLine = budget.find(
		(line) => line.idempotencyKey === implementationBindingKey(input.runId),
	);
	if (!bindingLine) {
		return fail(
			"budget",
			implementationBindingKey(input.runId),
			"No implementation binding is recorded for this run.",
		);
	}
	let binding: ImplementationBindingPayload;
	try {
		binding = decodeImplementationBindingPayload(bindingLine.payload);
	} catch (error) {
		return fail(
			"budget",
			bindingLine.idempotencyKey,
			error instanceof Error ? error.message : String(error),
		);
	}
	if (binding.executionRunId !== input.runId) {
		return fail(
			"budget",
			bindingLine.idempotencyKey,
			"The binding execution run does not match this run.",
		);
	}
	if (hashPlanBytes(binding.approvedPlanBytes) !== binding.approvedPlanHash) {
		return fail(
			"budget",
			bindingLine.idempotencyKey,
			"The binding plan hash does not match its bytes.",
		);
	}
	const extraBinding = budget.find(
		(line) =>
			payloadRecord(line)?.kind === "implementation-binding" &&
			line.idempotencyKey !== bindingLine.idempotencyKey,
	);
	if (extraBinding) {
		return fail(
			"budget",
			extraBinding.idempotencyKey,
			"A second implementation binding is recorded for this run.",
		);
	}

	const decisions: ImplementationDecisionPayload[] = [];
	const decisionIds = new Set<string>();
	const planDecisionIds = new Set<string>();
	for (const line of input.recordStore.listLines(input.runId, "decisions")) {
		const raw = payloadRecord(line);
		if (!raw) continue;
		if (raw.kind === "plan-review-governance") {
			if (typeof raw.decisionId === "string")
				planDecisionIds.add(raw.decisionId);
			continue;
		}
		if (raw.kind !== "implementation-review-governance") continue;
		try {
			const decision = validateImplementationDecision(
				structuredClone(raw) as unknown as ImplementationDecisionPayload,
			);
			if (decisionIds.has(decision.decisionId)) {
				return fail(
					"decisions",
					line.idempotencyKey,
					`Decision ${decision.decisionId} is duplicated.`,
				);
			}
			decisionIds.add(decision.decisionId);
			decisions.push(decision);
		} catch (error) {
			return fail(
				"decisions",
				line.idempotencyKey,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	const initialId = initialRevisionId(binding.id);
	const revisions: EffectiveRevision[] = [
		{
			id: initialId,
			kind: "initial",
			predecessorId: null,
			approvedPlanHash: binding.approvedPlanHash,
			approvedPlanBytes: binding.approvedPlanBytes,
			amendmentAssessment: null,
		},
	];
	const seen: SeenRecord[] = [];
	const seenIds = new Set<string>();
	const stepKeys = new Map<string, string>();
	const boundaries: OpenBoundary[] = [];
	const dispositions: RegisteredDisposition[] = [];
	const consumedAuthorizations = new Set<string>();
	let currentRevisionId = initialId;
	let authorizedBytes = binding.approvedPlanBytes;
	let authorizedHash = binding.approvedPlanHash;
	let parent: string | null = null;
	const authorizedAt = new Map<
		string,
		{ bytes: string; hash: string; parentId: string | null }
	>();
	const rememberAuthorized = () => {
		authorizedAt.set(currentRevisionId, {
			bytes: authorizedBytes,
			hash: authorizedHash,
			parentId: parent,
		});
	};
	rememberAuthorized();

	const revisionIds = () => new Set(revisions.map((revision) => revision.id));

	const attributeRevision = (
		recordId: string,
		stored: string | undefined,
	): string | EffectiveExecutionResult => {
		if (stored === undefined) return currentRevisionId;
		if (!revisionIds().has(stored) || stored !== currentRevisionId) {
			return fail(
				"budget",
				recordId,
				`Stored revision ${stored} does not match the open revision ${currentRevisionId}.`,
			);
		}
		return stored;
	};

	const remember = (record: SeenRecord): EffectiveExecutionResult | null => {
		if (seenIds.has(record.id)) {
			return fail(
				"budget",
				record.recordId,
				`Evidence id ${record.id} is duplicated.`,
			);
		}
		seenIds.add(record.id);
		seen.push(record);
		return null;
	};

	for (const line of budget) {
		const raw = payloadRecord(line);
		if (!raw || typeof raw.kind !== "string") continue;
		const kind = raw.kind;
		if (
			kind === "implementation-binding" ||
			kind === "implementation-compatibility"
		) {
			continue;
		}
		if (!LINEAGE_KINDS.has(kind) && !EVIDENCE_KINDS.has(kind)) continue;

		if (kind === "implementation-review-context") {
			let context: ImplementationReviewContextPayload;
			try {
				context = decodeImplementationReviewContextPayload(line.payload);
			} catch (error) {
				return fail(
					"budget",
					line.idempotencyKey,
					error instanceof Error ? error.message : String(error),
				);
			}
			if (context.bindingId !== binding.id) {
				return fail(
					"budget",
					line.idempotencyKey,
					`Context ${context.id} names a different binding.`,
				);
			}
			const revision = attributeRevision(
				line.idempotencyKey,
				context.revisionId,
			);
			if (typeof revision !== "string") return revision;
			const duplicate = remember({
				id: context.id,
				phase: context.phase,
				kind: "context",
				revisionId: revision,
				recordId: line.idempotencyKey,
				completionAuthorized: false,
				findings: [],
			});
			if (duplicate) return duplicate;
			continue;
		}

		if (kind === "implementation-review") {
			let observation: ImplementationReviewObservationPayload;
			try {
				observation = decodeImplementationReviewObservationPayload(
					line.payload,
				);
			} catch (error) {
				return fail(
					"budget",
					line.idempotencyKey,
					error instanceof Error ? error.message : String(error),
				);
			}
			if (observation.bindingId !== binding.id) {
				return fail(
					"budget",
					line.idempotencyKey,
					`Observation ${observation.id} names a different binding.`,
				);
			}
			const revision = attributeRevision(
				line.idempotencyKey,
				observation.revisionId,
			);
			if (typeof revision !== "string") return revision;
			const findings: ObservedFinding[] = [];
			for (const item of observation.originalVerdict.items) {
				let fingerprint: string;
				try {
					fingerprint = fingerprintImplementationVerdictItem(
						item as VerdictItem,
						observation.phase,
					);
				} catch (error) {
					return fail(
						"budget",
						line.idempotencyKey,
						error instanceof Error ? error.message : String(error),
					);
				}
				findings.push({
					phase: observation.phase,
					observationId: observation.id,
					findingId: item.id,
					fingerprint,
					recordedRevisionId: revision,
				});
			}
			const stepKey = observationStepKey(input.runId, observation.stepKey);
			const prior = stepKeys.get(stepKey);
			if (prior) {
				return fail(
					"budget",
					line.idempotencyKey,
					`Observations ${prior} and ${observation.id} claim step ${stepKey}.`,
				);
			}
			stepKeys.set(stepKey, observation.id);
			const verdictPrior = observation.originalVerdict.priorFindings;
			const duplicate = remember({
				id: observation.id,
				phase: observation.phase,
				kind: "observation",
				revisionId: revision,
				recordId: line.idempotencyKey,
				completionAuthorized: observation.completionAuthorized,
				findings,
				priorFindings: verdictPrior ?? observation.outcomes,
			});
			if (duplicate) return duplicate;
			continue;
		}

		if (
			kind === "implementation-correction-attempt" ||
			kind === "implementation-credit-reconciliation"
		) {
			let record:
				| ImplementationCorrectionAttemptPayload
				| ImplementationCreditReconciliationPayload;
			try {
				record =
					kind === "implementation-correction-attempt"
						? decodeImplementationCorrectionAttemptPayload(line.payload)
						: decodeImplementationCreditReconciliationPayload(line.payload);
			} catch (error) {
				return fail(
					"budget",
					line.idempotencyKey,
					error instanceof Error ? error.message : String(error),
				);
			}
			if (record.bindingId !== binding.id) {
				return fail(
					"budget",
					line.idempotencyKey,
					`${record.id} names a different binding.`,
				);
			}
			const cited = seen.find(
				(entry) =>
					entry.kind === "observation" && entry.id === record.observationId,
			);
			if (!cited) {
				return fail(
					"budget",
					line.idempotencyKey,
					`${record.id} cites missing observation ${record.observationId}.`,
				);
			}
			const stored =
				kind === "implementation-correction-attempt"
					? (record as ImplementationCorrectionAttemptPayload).revisionId
					: undefined;
			const revision = attributeRevision(line.idempotencyKey, stored);
			if (typeof revision !== "string") return revision;
			const duplicate = remember({
				id: record.id,
				phase: record.phase,
				kind:
					kind === "implementation-correction-attempt"
						? "correction"
						: "credit",
				revisionId: revision,
				recordId: line.idempotencyKey,
				completionAuthorized: false,
				observationId: record.observationId,
				findings: [],
			});
			if (duplicate) return duplicate;
			continue;
		}

		let lineage:
			| ImplementationTextAmendmentPayload
			| ImplementationPlanRecoveryPayload
			| ImplementationSemanticAmendmentPayload;
		try {
			if (kind === "implementation-text-amendment") {
				lineage = decodeImplementationTextAmendmentPayload(line.payload);
			} else if (kind === "implementation-plan-recovery") {
				lineage = decodeImplementationPlanRecoveryPayload(line.payload);
			} else {
				lineage = decodeImplementationSemanticAmendmentPayload(line.payload);
			}
		} catch (error) {
			return fail(
				"budget",
				line.idempotencyKey,
				error instanceof Error ? error.message : String(error),
			);
		}
		if (lineage.bindingId !== binding.id) {
			return fail(
				"budget",
				line.idempotencyKey,
				`${lineage.id} names a different binding.`,
			);
		}
		const bytes =
			lineage.kind === "implementation-plan-amendment"
				? lineage.approvedPlanBytes
				: lineage.authorizedPlanBytes;
		const afterHash = hashPlanBytes(bytes);
		if (
			lineage.parentLineageId !== parent ||
			lineage.beforeBlobHash !== authorizedHash ||
			lineage.afterBlobHash !== afterHash ||
			lineage.beforeCommit.length === 0 ||
			lineage.afterCommit.length === 0
		) {
			return fail(
				"budget",
				line.idempotencyKey,
				`Lineage ${lineage.id} has a wrong parent or plan hash.`,
				lineage.id,
			);
		}
		if (lineage.kind === "implementation-text-amendment") {
			const revision = attributeRevision(
				line.idempotencyKey,
				lineage.revisionId,
			);
			if (typeof revision !== "string") return revision;
			const duplicate = remember({
				id: lineage.id,
				phase: "",
				kind: "text",
				revisionId: revision,
				recordId: line.idempotencyKey,
				completionAuthorized: false,
				findings: [],
			});
			if (duplicate) return duplicate;
			authorizedBytes = bytes;
			authorizedHash = afterHash;
			parent = lineage.id;
			rememberAuthorized();
			continue;
		}

		if (revisionIds().has(lineage.id)) {
			return fail(
				"budget",
				line.idempotencyKey,
				`Revision ${lineage.id} is duplicated.`,
				lineage.id,
			);
		}
		const authorization = decisions.filter(
			(decision) => decision.decisionId === lineage.authorizationId,
		);
		if (authorization.length !== 1) {
			return fail(
				"budget",
				line.idempotencyKey,
				`Authorization ${lineage.authorizationId} is missing or duplicated.`,
				lineage.id,
			);
		}
		const decision = authorization[0];
		if (decision?.choice !== "authorize_amendment") {
			return fail(
				"budget",
				line.idempotencyKey,
				`Authorization ${lineage.authorizationId} is not authorize_amendment.`,
				lineage.id,
			);
		}
		if (consumedAuthorizations.has(decision.decisionId)) {
			return fail(
				"budget",
				line.idempotencyKey,
				`Authorization ${decision.decisionId} is already consumed.`,
				lineage.id,
			);
		}
		if (
			lineage.kind === "implementation-plan-amendment" &&
			decision.amendmentScope === undefined
		) {
			return fail(
				"budget",
				line.idempotencyKey,
				`Authorization ${decision.decisionId} omits amendmentScope and cannot authorize a semantic amendment.`,
				lineage.id,
			);
		}

		const predecessorPlan = parsePlan(authorizedBytes);
		const phaseIds = predecessorPlan.phases.map((phase) => phase.number);
		if (new Set(phaseIds).size !== phaseIds.length) {
			return fail(
				"budget",
				line.idempotencyKey,
				"The predecessor plan repeats a phase id.",
				lineage.id,
			);
		}
		const frontier =
			lineage.kind === "implementation-plan-recovery"
				? lineage.phase
				: lineage.earliestAffectedPhase;
		const frontierIndex = phaseIds.indexOf(frontier);
		if (frontierIndex < 0) {
			return fail(
				"budget",
				line.idempotencyKey,
				`Affected phase ${frontier} is not in the predecessor plan.`,
				lineage.id,
			);
		}
		const affected = new Set(phaseIds.slice(frontierIndex));
		const expectedContexts = new Set(
			seen
				.filter(
					(entry) => entry.kind === "context" && affected.has(entry.phase),
				)
				.map((entry) => entry.id),
		);
		const expectedObservations = new Set(
			seen
				.filter(
					(entry) => entry.kind === "observation" && affected.has(entry.phase),
				)
				.map((entry) => entry.id),
		);
		const contextIds = unique(lineage.invalidatedContextIds);
		const observationIds = unique(lineage.invalidatedObservationIds);
		if (!contextIds || !observationIds) {
			return fail(
				"budget",
				line.idempotencyKey,
				`Invalidation sets on ${lineage.id} contain duplicate ids.`,
				lineage.id,
			);
		}
		const missing = [...expectedContexts, ...expectedObservations].filter(
			(id) =>
				expectedContexts.has(id)
					? !contextIds.has(id)
					: !observationIds.has(id),
		);
		const extra = [...contextIds, ...observationIds].filter((id) =>
			contextIds.has(id)
				? !expectedContexts.has(id)
				: !expectedObservations.has(id),
		);
		if (missing.length > 0 || extra.length > 0) {
			const evidenceId = missing[0] ?? extra[0] ?? lineage.id;
			return fail(
				"budget",
				line.idempotencyKey,
				`Recovery ${lineage.id} invalidation set disagrees at evidence ${evidenceId}.`,
				lineage.id,
			);
		}

		let resolutions: AmendmentResolvedFinding[] = [];
		if (lineage.kind === "implementation-plan-amendment") {
			if (lineage.predecessorRevisionId !== currentRevisionId) {
				return fail(
					"budget",
					line.idempotencyKey,
					`Predecessor ${lineage.predecessorRevisionId} is not the current revision ${currentRevisionId}.`,
					lineage.id,
				);
			}
			if (
				lineage.approvedPlanHash !== lineage.afterBlobHash ||
				lineage.approvedPlanHash !== afterHash
			) {
				return fail(
					"budget",
					line.idempotencyKey,
					`Amendment ${lineage.id} plan hash does not match its bytes.`,
					lineage.id,
				);
			}
			const nextPlan = parsePlan(lineage.approvedPlanBytes);
			const nextIds = nextPlan.phases.map((phase) => phase.number);
			if (nextIds.join("\0") !== phaseIds.join("\0")) {
				return fail(
					"budget",
					line.idempotencyKey,
					"Phase ids were deleted, added, reordered, or renumbered.",
					lineage.id,
				);
			}
			const preserved = new Set(
				lineage.preservedPhases.map((phase) => phase.phaseId),
			);
			const required = new Set(phaseIds.slice(0, frontierIndex));
			if (
				preserved.size !== required.size ||
				[...required].some((id) => !preserved.has(id)) ||
				[...preserved].some((id) => !required.has(id))
			) {
				return fail(
					"budget",
					line.idempotencyKey,
					"Preserved phases must be exactly the phases before the affected boundary. Carry is not inferred.",
					lineage.id,
				);
			}
			const beforeLedger = parseDeliveryBudget(authorizedBytes);
			const afterLedger = parseDeliveryBudget(lineage.approvedPlanBytes);
			if (!beforeLedger.ok || !afterLedger.ok) {
				return fail(
					"budget",
					line.idempotencyKey,
					"The amended plan ledger could not be parsed, so claim contracts cannot be checked.",
					lineage.id,
				);
			}
			for (const phaseId of required) {
				const index = phaseIds.indexOf(phaseId);
				if (
					phaseSection(authorizedBytes, predecessorPlan.phases, index) !==
					phaseSection(lineage.approvedPlanBytes, nextPlan.phases, index)
				) {
					return fail(
						"budget",
						line.idempotencyKey,
						`Preserved phase ${phaseId} changed beyond checkbox state.`,
						lineage.id,
					);
				}
				if (
					claimContract(beforeLedger.value, phaseId) !==
					claimContract(afterLedger.value, phaseId)
				) {
					return fail(
						"budget",
						line.idempotencyKey,
						`Preserved phase ${phaseId} changed a linked claim contract.`,
						lineage.id,
					);
				}
				const section = phaseSection(
					authorizedBytes,
					predecessorPlan.phases,
					index,
				);
				for (const workItemId of namedWorkItemIds(section)) {
					if (
						workItemContract(beforeLedger.value, workItemId) !==
						workItemContract(afterLedger.value, workItemId)
					) {
						return fail(
							"budget",
							line.idempotencyKey,
							`Preserved phase ${phaseId} changed a linked work-item contract.`,
							lineage.id,
						);
					}
				}
			}
			for (const finding of lineage.resolvedFindings) {
				const observation = seen.find(
					(entry) =>
						entry.kind === "observation" &&
						entry.id === finding.observationId &&
						entry.phase === finding.phase,
				);
				const item = observation?.findings.find(
					(entry) =>
						entry.findingId === finding.findingId &&
						entry.fingerprint === finding.fingerprint,
				);
				if (!observation || !item) {
					return fail(
						"budget",
						line.idempotencyKey,
						`Resolved finding ${finding.findingId} is not on ${finding.phase}/${finding.observationId}.`,
						lineage.id,
					);
				}
			}
			const scope = decision.amendmentScope;
			if (!scope) {
				return fail(
					"budget",
					line.idempotencyKey,
					`Authorization ${decision.decisionId} omits amendmentScope and cannot authorize a semantic amendment.`,
					lineage.id,
				);
			}
			if (scope.predecessorRevisionId !== lineage.predecessorRevisionId) {
				return fail(
					"budget",
					line.idempotencyKey,
					`Authorization ${decision.decisionId} predecessor ${scope.predecessorRevisionId} does not match amendment predecessor ${lineage.predecessorRevisionId}.`,
					lineage.id,
				);
			}
			const authorizedPhase = phaseIds.indexOf(scope.earliestAffectedPhase);
			if (authorizedPhase < 0) {
				return fail(
					"budget",
					line.idempotencyKey,
					`Authorized phase ${scope.earliestAffectedPhase} is not in the predecessor plan.`,
					lineage.id,
				);
			}
			if (frontierIndex < authorizedPhase) {
				return fail(
					"budget",
					line.idempotencyKey,
					`Amendment boundary ${frontier} is earlier than authorized phase ${scope.earliestAffectedPhase}.`,
					lineage.id,
				);
			}
			for (const edit of lineage.claimEdits) {
				const allowed = scope.claimEdits.some(
					(candidate) =>
						candidate.creditClaimId === edit.creditClaimId &&
						candidate.effect === edit.effect,
				);
				if (!allowed) {
					return fail(
						"budget",
						line.idempotencyKey,
						`Claim edit ${edit.creditClaimId} ${edit.effect} is outside amendmentScope.`,
						lineage.id,
					);
				}
			}
			for (const finding of lineage.resolvedFindings) {
				const allowed = scope.resolutionRefs.some(
					(ref) =>
						ref.phase === finding.phase &&
						ref.observationId === finding.observationId &&
						ref.findingId === finding.findingId &&
						ref.fingerprint === finding.fingerprint,
				);
				if (!allowed) {
					return fail(
						"budget",
						line.idempotencyKey,
						`Resolved finding ${finding.findingId} is outside amendmentScope.`,
						lineage.id,
					);
				}
			}
			const evidenceProblem = verifyRegisteredAmendmentEvidence(
				input.recordStore,
				input.runId,
				lineage,
			);
			if (evidenceProblem) {
				return fail("budget", line.idempotencyKey, evidenceProblem, lineage.id);
			}
			resolutions = lineage.resolvedFindings;
			dispositions.push({
				revisionId: lineage.id,
				earliestAffectedPhase: lineage.earliestAffectedPhase,
				preservedPhases: lineage.preservedPhases,
				resolvedFindings: lineage.resolvedFindings,
				claimEdits: lineage.claimEdits,
			});
		}

		consumedAuthorizations.add(decision.decisionId);
		revisions.push({
			id: lineage.id,
			kind:
				lineage.kind === "implementation-plan-recovery"
					? "legacy_frontier_recovery"
					: "implementation_plan_amendment",
			predecessorId: currentRevisionId,
			approvedPlanHash: afterHash,
			approvedPlanBytes: bytes,
			authorizationId: lineage.authorizationId,
			earliestAffectedPhase: frontier,
			amendmentAssessment: null,
			...(lineage.kind === "implementation-plan-recovery"
				? {
						legacy: {
							scopeConfirmation: lineage.scopeConfirmation,
							preservedPhaseConfirmation: lineage.preservedPhaseConfirmation,
							commit: lineage.afterCommit,
						},
					}
				: {}),
		});
		boundaries.push({
			id: lineage.id,
			contexts: contextIds,
			observations: observationIds,
			resolutions,
		});
		opened.push(lineage.id);
		currentRevisionId = lineage.id;
		authorizedBytes = bytes;
		authorizedHash = afterHash;
		parent = lineage.id;
		rememberAuthorized();
	}

	const observationById = new Map(
		seen
			.filter((entry) => entry.kind === "observation")
			.map((entry) => [entry.id, entry]),
	);
	const decisionRevision = new Map<string, string>();
	for (const decision of decisions) {
		if (decision.bindingId !== binding.id) {
			return fail(
				"decisions",
				decision.decisionId,
				`Decision ${decision.decisionId} names a different binding.`,
			);
		}
		const matches = seen.filter(
			(entry) =>
				entry.kind === "observation" && entry.id === decision.observationId,
		);
		if (matches.length !== 1 || !matches[0]) {
			return fail(
				"decisions",
				decision.decisionId,
				`Decision ${decision.decisionId} does not cite exactly one observation.`,
			);
		}
		decisionRevision.set(decision.decisionId, matches[0].revisionId);
	}

	const stepEvidence: Array<SeenRecord & { evidenceKind: string }> = [];
	const preAuthorPhases = new Set<string>();
	for (const line of input.recordStore.listLines(input.runId, "steps")) {
		const step = stepRecord(line);
		if (!step) continue;
		if (
			step.step_name === "phase:complete" ||
			step.step_name === "git:commit" ||
			step.step_name.startsWith("quality")
		) {
			continue;
		}
		if (step.step_name === "implementation:pre-author") {
			const raw = step.result_json;
			const admission =
				raw && typeof raw === "object" && !Array.isArray(raw)
					? (raw as { bindingId?: unknown; phase?: unknown; kind?: unknown })
					: null;
			if (
				admission?.kind !== "phase-author-admission" ||
				admission.bindingId !== binding.id ||
				typeof admission.phase !== "string"
			) {
				return fail(
					"steps",
					line.idempotencyKey,
					"implementation:pre-author is missing its binding and phase.",
				);
			}
			if (preAuthorPhases.has(admission.phase)) {
				return fail(
					"steps",
					line.idempotencyKey,
					`A second pre-author baseline is recorded for phase ${admission.phase}.`,
				);
			}
			preAuthorPhases.add(admission.phase);
			stepEvidence.push({
				id: line.idempotencyKey,
				phase: admission.phase,
				kind: "text",
				revisionId: initialId,
				recordId: line.idempotencyKey,
				completionAuthorized: false,
				findings: [],
				evidenceKind: "implementation:pre-author",
			});
			continue;
		}
		if (step.step_name === "human:review-governance") {
			const raw = step.result_json;
			const decisionId =
				raw && typeof raw === "object" && !Array.isArray(raw)
					? (raw as { decisionId?: unknown }).decisionId
					: undefined;
			if (typeof decisionId !== "string" || decisionId.length === 0) {
				return fail(
					"steps",
					line.idempotencyKey,
					"human:review-governance is missing decisionId.",
				);
			}
			const implementationMatch = decisionRevision.has(decisionId);
			const planMatch = planDecisionIds.has(decisionId);
			if (implementationMatch === planMatch) {
				return fail(
					"steps",
					line.idempotencyKey,
					`human:review-governance decision ${decisionId} is missing or duplicated.`,
				);
			}
			if (planMatch) continue;
			const revisionId = decisionRevision.get(decisionId);
			if (!revisionId) {
				return fail(
					"steps",
					line.idempotencyKey,
					`human:review-governance decision ${decisionId} has no revision.`,
				);
			}
			stepEvidence.push({
				id: line.idempotencyKey,
				phase: step.phase ?? "",
				kind: "text",
				revisionId,
				recordId: line.idempotencyKey,
				completionAuthorized: false,
				findings: [],
				evidenceKind: "human:review-governance",
			});
			continue;
		}
		if (!step.step_name.startsWith("reviewer:")) continue;
		const key = stepIdempotencyKey({
			runId: input.runId,
			stepName: step.step_name,
			phase: step.phase,
			iteration: step.iteration,
		});
		const observationId = stepKeys.get(key);
		if (!observationId) continue;
		const observation = observationById.get(observationId);
		if (!observation) continue;
		stepEvidence.push({
			id: line.idempotencyKey,
			phase: observation.phase,
			kind: "observation",
			revisionId: observation.revisionId,
			recordId: line.idempotencyKey,
			completionAuthorized: false,
			observationId,
			findings: [],
			evidenceKind: step.step_name,
		});
	}

	const selected =
		input.revisionId === undefined
			? revisions[revisions.length - 1]
			: revisions.find((revision) => revision.id === input.revisionId);
	if (!selected) {
		return fail(
			"budget",
			input.revisionId ?? currentRevisionId,
			`Revision ${input.revisionId ?? ""} is not in the lineage.`,
		);
	}
	const selectedIndex = revisions.findIndex(
		(revision) => revision.id === selected.id,
	);
	const selectedIds = new Set(
		revisions.slice(0, selectedIndex + 1).map((revision) => revision.id),
	);
	const invalidatedContexts = new Set<string>();
	const invalidatedObservations = new Set<string>();
	const resolutions = new Map<string, AmendmentResolvedFinding>();
	for (const boundary of boundaries) {
		if (!selectedIds.has(boundary.id)) continue;
		for (const id of boundary.contexts) invalidatedContexts.add(id);
		for (const id of boundary.observations) invalidatedObservations.add(id);
		for (const finding of boundary.resolutions) {
			resolutions.set(
				`${finding.phase}\u0000${finding.observationId}\u0000${finding.findingId}`,
				finding,
			);
		}
	}

	const evidence: RevisionEvidence[] = [];
	const applicableObservations = new Set<string>();
	for (const record of seen) {
		if (!selectedIds.has(record.revisionId)) continue;
		const invalidated =
			(record.kind === "context" && invalidatedContexts.has(record.id)) ||
			(record.kind === "observation" && invalidatedObservations.has(record.id));
		if (record.kind === "observation" && !invalidated) {
			applicableObservations.add(record.id);
		}
		const citedInvalidated =
			record.observationId !== undefined &&
			invalidatedObservations.has(record.observationId);
		const citedApplicable =
			record.observationId !== undefined &&
			applicableObservations.has(record.observationId) &&
			!citedInvalidated;
		const dependentInvalidated =
			(record.kind === "correction" || record.kind === "credit") &&
			citedInvalidated;
		evidence.push({
			stream: "budget",
			recordId: record.recordId,
			kind: record.kind,
			revisionId: record.revisionId,
			applicability:
				invalidated || dependentInvalidated ? "invalidated" : "applicable",
			certifies:
				record.kind === "observation"
					? !invalidated && record.completionAuthorized
					: (record.kind === "correction" || record.kind === "credit") &&
						citedApplicable,
			...(record.phase ? { phase: record.phase } : {}),
			...(record.observationId ? { observationId: record.observationId } : {}),
		});
	}
	for (const record of stepEvidence) {
		if (!selectedIds.has(record.revisionId)) continue;
		evidence.push({
			stream: "steps",
			recordId: record.recordId,
			kind: record.evidenceKind,
			revisionId: record.revisionId,
			applicability:
				record.evidenceKind === "implementation:pre-author"
					? "baseline"
					: "applicable",
			certifies: false,
			...(record.phase ? { phase: record.phase } : {}),
			...(record.observationId ? { observationId: record.observationId } : {}),
		});
	}
	for (const decision of decisions) {
		const revisionId = decisionRevision.get(decision.decisionId);
		if (!revisionId || !selectedIds.has(revisionId)) continue;
		const observation = observationById.get(decision.observationId);
		const invalidated =
			observation !== undefined && invalidatedObservations.has(observation.id);
		evidence.push({
			stream: "decisions",
			recordId: decision.decisionId,
			kind: decision.choice,
			revisionId,
			applicability: invalidated ? "invalidated" : "applicable",
			certifies: false,
			phase: decision.phase,
			observationId: decision.observationId,
		});
	}

	const findings: EffectiveFinding[] = [];
	const observationsByPhase = new Map<string, SeenRecord[]>();
	for (const record of seen) {
		if (record.kind !== "observation" || !selectedIds.has(record.revisionId)) {
			continue;
		}
		const group = observationsByPhase.get(record.phase);
		if (group) group.push(record);
		else observationsByPhase.set(record.phase, [record]);
	}
	for (const group of observationsByPhase.values()) {
		const latest = group[group.length - 1];
		if (!latest) continue;
		const originals = new Map<string, ObservedFinding>();
		for (const observation of group) {
			for (const finding of observation.findings) {
				if (!originals.has(finding.findingId)) {
					originals.set(finding.findingId, finding);
				}
			}
		}
		for (const findingId of openFindingIds(
			latest.findings,
			latest.priorFindings ?? [],
		)) {
			const identity = originals.get(findingId);
			if (!identity) continue;
			const resolved = resolutionFor(identity, group, resolutions);
			findings.push({
				phase: identity.phase,
				observationId: identity.observationId,
				findingId: identity.findingId,
				fingerprint: identity.fingerprint,
				recordedRevisionId: identity.recordedRevisionId,
				status: resolved ? "amendment_resolved" : "pending",
				...(resolved ? { reason: resolved.reason } : {}),
			});
		}
	}

	return {
		ok: true,
		runId: input.runId,
		bindingId: binding.id,
		initialRevisionId: initialId,
		currentRevisionId,
		selectedRevisionId: selected.id,
		pinned: {
			b0: binding.b0,
			governingB: binding.governingB,
			mode: binding.mode,
			sourceRunId: binding.sourceRunId,
			bindingId: binding.id,
		},
		revisions,
		dispositions: dispositions.filter((entry) =>
			selectedIds.has(entry.revisionId),
		),
		evidence,
		findings,
		approvedPlanBytes:
			authorizedAt.get(selected.id)?.bytes ?? selected.approvedPlanBytes,
		approvedPlanHash:
			authorizedAt.get(selected.id)?.hash ?? selected.approvedPlanHash,
		lineageParentId: authorizedAt.get(selected.id)?.parentId ?? null,
		invalidatedContextIds: [...invalidatedContexts],
		invalidatedObservationIds: [...invalidatedObservations],
	};
}

/** Omitted on the initial revision so ordinary gate ids stay unchanged. */
export function revisionStamp(
	execution: Pick<
		EffectiveExecution,
		"currentRevisionId" | "initialRevisionId"
	>,
): string | undefined {
	return execution.currentRevisionId === execution.initialRevisionId
		? undefined
		: execution.currentRevisionId;
}

/**
 * True when a bound run is reviewing plan bytes that are not the effective
 * approved revision. Unbound plan reviews are not amendment reassessments.
 */
export function planBytesDifferFromEffectiveRevision(input: {
	recordStore: RecordStore;
	runId: string;
	planBytes: string;
}): boolean {
	const folded = foldEffectiveExecution({
		recordStore: input.recordStore,
		runId: input.runId,
	});
	if (!folded.ok) return false;
	return hashPlanBytes(input.planBytes) !== folded.approvedPlanHash;
}

function numericPhaseId(phase: string | null | undefined): string | null {
	if (!phase) return null;
	const trimmed = phase.trim();
	if (/^\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
	const prefixed = trimmed.match(/^phase[\s-]+(\d+(?:\.\d+)?)\b/i);
	return prefixed?.[1] ?? null;
}

/**
 * A phase is revision-reopened only when its latest `phase:complete` precedes
 * the current revision's paired `implementation:amendment` step in the steps
 * journal. SQLite ids are not an order across streams. Legacy recoveries stay
 * on the later author/reviewer step rule.
 */
export function phaseReopenedByRevision(input: {
	phaseMap: readonly { id: string }[];
	execution: EffectiveExecution;
	phaseId: string;
	steps: readonly RecordLine[];
}): boolean {
	const revision = input.execution.revisions.find(
		(entry) => entry.id === input.execution.currentRevisionId,
	);
	if (revision?.kind !== "implementation_plan_amendment") {
		return false;
	}
	const boundary = revision.earliestAffectedPhase;
	if (!boundary) return false;
	const ids = input.phaseMap.map((phase) => phase.id);
	const boundaryIndex = ids.indexOf(boundary);
	const phaseIndex = ids.indexOf(input.phaseId);
	if (boundaryIndex < 0 || phaseIndex < 0) return true;
	if (phaseIndex < boundaryIndex) return false;
	let amendmentIndex = -1;
	let completeIndex = -1;
	for (const [index, line] of input.steps.entries()) {
		const step = stepRecord(line);
		if (!step) continue;
		if (
			step.step_name === "phase:complete" &&
			numericPhaseId(step.phase) === input.phaseId
		) {
			completeIndex = index;
		}
		const result =
			step.result_json &&
			typeof step.result_json === "object" &&
			!Array.isArray(step.result_json)
				? (step.result_json as { amendmentId?: unknown })
				: null;
		if (
			step.step_name === "implementation:amendment" &&
			result?.amendmentId === revision.id
		) {
			amendmentIndex = index;
		}
	}
	if (completeIndex < 0) return false;
	if (amendmentIndex < 0) return true;
	return completeIndex < amendmentIndex;
}

function canonicalIntent(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalIntent).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalIntent(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Digest of one registration intent. The authorization is not reusable for another. */
export function amendmentIntentDigest(input: {
	authorizationId: string;
	predecessorRevisionId: string;
	humanStepKey: string;
	approvalStepKey: string;
	approvedPlanHash: string;
	earliestAffectedPhase: string;
	preservedPhases: readonly AmendmentPreservedPhase[];
	resolvedFindings: readonly AmendmentResolvedFinding[];
	claimEdits: readonly AmendmentClaimEdit[];
}): string {
	const hex = createHash("sha256")
		.update(
			canonicalIntent({
				authorizationId: input.authorizationId,
				predecessorRevisionId: input.predecessorRevisionId,
				humanStepKey: input.humanStepKey,
				approvalStepKey: input.approvalStepKey,
				approvedPlanHash: input.approvedPlanHash,
				earliestAffectedPhase: input.earliestAffectedPhase,
				preservedPhases: [...input.preservedPhases].sort((left, right) =>
					left.phaseId.localeCompare(right.phaseId),
				),
				resolvedFindings: [...input.resolvedFindings].sort((left, right) =>
					`${left.phase}\u0000${left.observationId}\u0000${left.findingId}`.localeCompare(
						`${right.phase}\u0000${right.observationId}\u0000${right.findingId}`,
					),
				),
				claimEdits: [...input.claimEdits].sort((left, right) =>
					`${left.creditClaimId}\u0000${left.effect}`.localeCompare(
						`${right.creditClaimId}\u0000${right.effect}`,
					),
				),
			}),
		)
		.digest("hex");
	return `sha256:${hex}`;
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalIntent(left) === canonicalIntent(right);
}

function verifyRegisteredAmendmentEvidence(
	recordStore: RecordStore,
	runId: string,
	lineage: ImplementationSemanticAmendmentPayload,
): string | null {
	const expected = amendmentIntentDigest({
		authorizationId: lineage.authorizationId,
		predecessorRevisionId: lineage.predecessorRevisionId,
		humanStepKey: lineage.humanStep.idempotencyKey,
		approvalStepKey: lineage.approvalStep.idempotencyKey,
		approvedPlanHash: lineage.approvedPlanHash,
		earliestAffectedPhase: lineage.earliestAffectedPhase,
		preservedPhases: lineage.preservedPhases,
		resolvedFindings: lineage.resolvedFindings,
		claimEdits: lineage.claimEdits,
	});
	if (lineage.intentDigest !== expected) {
		return `Amendment ${lineage.id} intent digest does not match its evidence.`;
	}
	const steps = recordStore.listLines(runId, "steps");
	const human = steps.find(
		(line) => line.idempotencyKey === lineage.humanStep.idempotencyKey,
	);
	const humanStep = human ? stepRecord(human) : null;
	const humanResult =
		humanStep?.result_json &&
		typeof humanStep.result_json === "object" &&
		!Array.isArray(humanStep.result_json)
			? (humanStep.result_json as { decisionId?: unknown; choice?: unknown })
			: null;
	if (
		humanStep?.step_name !== "human:review-governance" ||
		humanResult?.decisionId !== lineage.authorizationId ||
		humanResult?.choice === "continue" ||
		humanResult?.choice === "override"
	) {
		return `Human step ${lineage.humanStep.idempotencyKey} is not the coupled authorize_amendment step.`;
	}
	const approval = steps.find(
		(line) => line.idempotencyKey === lineage.approvalStep.idempotencyKey,
	);
	const approvalStep = approval ? stepRecord(approval) : null;
	const verdict =
		approvalStep?.result_json &&
		typeof approvalStep.result_json === "object" &&
		!Array.isArray(approvalStep.result_json)
			? (approvalStep.result_json as { amendmentAssessment?: unknown })
			: null;
	if (!approvalStep?.step_name.startsWith("reviewer:") || !verdict) {
		return `Approval step ${lineage.approvalStep.idempotencyKey} is not a plan reviewer step.`;
	}
	if (verdict.amendmentAssessment === undefined) {
		return `Approval step ${lineage.approvalStep.idempotencyKey} omits amendmentAssessment.`;
	}
	let assessment: AmendmentAssessment;
	try {
		assessment = parseAmendmentAssessment(verdict.amendmentAssessment);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (
		assessment.predecessorRevisionId !== lineage.predecessorRevisionId ||
		assessment.reviewedPlanHash !== lineage.approvedPlanHash ||
		assessment.earliestAffectedPhase !== lineage.earliestAffectedPhase ||
		!sameJson(assessment.preservedPhases, lineage.preservedPhases) ||
		!sameJson(assessment.resolvedFindings, lineage.resolvedFindings) ||
		!sameJson(assessment.claimEdits, lineage.claimEdits)
	) {
		return `Approval step ${lineage.approvalStep.idempotencyKey} does not match amendment ${lineage.id}.`;
	}
	const paired = steps.filter((line) => {
		const step = stepRecord(line);
		const result =
			step?.result_json &&
			typeof step.result_json === "object" &&
			!Array.isArray(step.result_json)
				? (step.result_json as { amendmentId?: unknown })
				: null;
		return (
			step?.step_name === "implementation:amendment" &&
			result?.amendmentId === lineage.id
		);
	});
	if (paired.length !== 1) {
		return `Amendment ${lineage.id} is missing its paired implementation:amendment step.`;
	}
	return null;
}

function observationFingerprint(
	observation: ImplementationReviewObservationPayload,
	findingId: string,
): string | null {
	for (const cause of observation.gateCauses) {
		if (
			"findingId" in cause &&
			cause.findingId === findingId &&
			typeof cause.fingerprint === "string" &&
			cause.fingerprint.length > 0
		) {
			return cause.fingerprint;
		}
	}
	const item = observation.originalVerdict.items.find(
		(entry) => entry.id === findingId,
	);
	if (!item) return null;
	try {
		return fingerprintImplementationVerdictItem(
			item as VerdictItem,
			observation.phase,
		);
	} catch {
		return null;
	}
}

/**
 * Build amendmentScope from the structured object only.
 * Rationale and gate prose are not read. Missing keys are not defaulted.
 */
export function prepareAuthorizeAmendmentScope(input: {
	choice: string;
	amendmentScope: unknown;
	findingRefs: readonly FindingIdentity[];
	sourceObservationId: string;
	observations: readonly ImplementationReviewObservationPayload[];
	phaseIds: readonly string[];
	currentRevisionId: string;
	ledgerClaimIds: ReadonlySet<string>;
	/** False only when an identical stored decision is retried after the revision advances. */
	requireCurrentPredecessor?: boolean;
}): AmendmentScope | undefined {
	if (input.choice !== "authorize_amendment") {
		if (input.amendmentScope !== undefined) {
			throw new TypeError(
				"amendmentScope is only valid on authorize_amendment",
			);
		}
		return undefined;
	}
	if (input.amendmentScope === undefined) {
		throw new TypeError("authorize_amendment requires amendmentScope");
	}
	if (
		!input.amendmentScope ||
		typeof input.amendmentScope !== "object" ||
		Array.isArray(input.amendmentScope)
	) {
		throw new TypeError("amendmentScope must be an object");
	}
	const record: Record<string, unknown> = {
		...(input.amendmentScope as Record<string, unknown>),
	};
	if (Array.isArray(record.resolutionRefs)) {
		record.resolutionRefs = record.resolutionRefs.map((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				return entry;
			}
			const ref = { ...(entry as Record<string, unknown>) };
			const phase = typeof ref.phase === "string" ? ref.phase : "";
			const observationId =
				typeof ref.observationId === "string" ? ref.observationId : "";
			const findingId = typeof ref.findingId === "string" ? ref.findingId : "";
			const observation = input.observations.find(
				(candidate) =>
					candidate.id === observationId && candidate.phase === phase,
			);
			const recorded = observation
				? observationFingerprint(observation, findingId)
				: null;
			if (recorded) {
				if (
					typeof ref.fingerprint !== "string" ||
					ref.fingerprint.length === 0
				) {
					ref.fingerprint = recorded;
				} else if (ref.fingerprint !== recorded) {
					throw new TypeError(
						`resolution ref ${findingId} fingerprint does not match ${phase}/${observationId}`,
					);
				}
			}
			return ref;
		});
	}
	const scope = parseAmendmentScope(record);
	if (
		input.requireCurrentPredecessor !== false &&
		scope.predecessorRevisionId !== input.currentRevisionId
	) {
		throw new TypeError(
			`predecessor ${scope.predecessorRevisionId} is not the current revision ${input.currentRevisionId}`,
		);
	}
	if (!input.phaseIds.includes(scope.earliestAffectedPhase)) {
		throw new TypeError(
			`phase ${scope.earliestAffectedPhase} is not in the current plan`,
		);
	}
	const source = input.observations.find(
		(observation) => observation.id === input.sourceObservationId,
	);
	for (const edit of scope.claimEdits) {
		if (!input.ledgerClaimIds.has(edit.creditClaimId)) {
			throw new TypeError(
				`claim ${edit.creditClaimId} is not on the bound ledger`,
			);
		}
	}
	for (const ref of scope.resolutionRefs) {
		const observation = input.observations.find(
			(candidate) =>
				candidate.id === ref.observationId && candidate.phase === ref.phase,
		);
		const recorded = observation
			? observationFingerprint(observation, ref.findingId)
			: null;
		if (!observation || recorded !== ref.fingerprint) {
			throw new TypeError(
				`resolution ref ${ref.findingId} is not on ${ref.phase}/${ref.observationId} for this binding`,
			);
		}
		if (observation.id !== input.sourceObservationId) continue;
		const inFindingRefs = input.findingRefs.some(
			(finding) =>
				finding.findingId === ref.findingId &&
				finding.fingerprint === ref.fingerprint,
		);
		const planCause = source?.gateCauses.some(
			(cause) =>
				cause.kind === "plan_amendment" &&
				"findingId" in cause &&
				cause.findingId === ref.findingId &&
				cause.fingerprint === ref.fingerprint,
		);
		if (!inFindingRefs || !planCause) {
			throw new TypeError(
				`source resolution ref ${ref.findingId} is outside findingRefs or a plan_amendment cause`,
			);
		}
	}
	return scope;
}

function debtContract(item: ParsedWorkItem): string {
	const claim = item.debtClaim;
	if (!claim) return "";
	return JSON.stringify({
		coupling: claim.coupling,
		targetPhase: claim.targetPhase,
		minimalAlternativeEffortDelta: claim.minimalAlternativeEffortDelta,
		minimalAlternativeArchitectureDelta:
			claim.minimalAlternativeArchitectureDelta,
		before: claim.before,
		after: claim.after,
	});
}

function claimEffects(
	before: ParsedDeliveryBudget,
	after: ParsedDeliveryBudget,
): AmendmentClaimEdit[] {
	const beforeClaims = new Map<string, ParsedWorkItem>();
	const afterClaims = new Map<string, ParsedWorkItem>();
	for (const [ledger, target] of [
		[before, beforeClaims],
		[after, afterClaims],
	] as const) {
		for (const item of ledger.workItems) {
			const claimId = item.debtClaim?.debtClaimId;
			if (!claimId) continue;
			if (target.has(claimId)) {
				throw new TypeError(`claim ${claimId} is reused`);
			}
			target.set(claimId, item);
		}
	}
	const effects: AmendmentClaimEdit[] = [];
	for (const [claimId, item] of beforeClaims) {
		const next = afterClaims.get(claimId);
		if (!next) {
			effects.push({ creditClaimId: claimId, effect: "withdraw" });
			continue;
		}
		if (next.id !== item.id) {
			throw new TypeError(
				`claim ${claimId} cannot move to work item ${next.id}`,
			);
		}
		if (next.architectureDelta < item.architectureDelta) {
			throw new TypeError(`claim ${claimId} cannot increase approved credit`);
		}
		if (next.architectureDelta > item.architectureDelta) {
			effects.push({ creditClaimId: claimId, effect: "reduce_magnitude" });
		}
		if (debtContract(next) !== debtContract(item)) {
			effects.push({ creditClaimId: claimId, effect: "edit_contract" });
		}
	}
	for (const claimId of afterClaims.keys()) {
		if (!beforeClaims.has(claimId)) {
			throw new TypeError(`new claim ${claimId} cannot be introduced`);
		}
	}
	return effects;
}

function effectSet(edits: readonly AmendmentClaimEdit[]): string {
	return canonicalIntent(
		[...edits].sort((left, right) =>
			`${left.creditClaimId}\u0000${left.effect}`.localeCompare(
				`${right.creditClaimId}\u0000${right.effect}`,
			),
		),
	);
}

function findingKey(finding: {
	phase: string;
	observationId: string;
	findingId: string;
	fingerprint: string;
}): string {
	return `${finding.phase}\u0000${finding.observationId}\u0000${finding.findingId}\u0000${finding.fingerprint}`;
}

export interface AmendmentResolveRequest {
	raw: string;
	phase?: string;
	observationId?: string;
	findingId: string;
}

export function parseResolveSelector(raw: string): AmendmentResolveRequest {
	const token = raw.trim();
	if (!token.includes("/")) return { raw: token, findingId: token };
	const parts = token.split("/");
	if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
		throw new TypeError(
			`--resolves ${raw} must be a finding id or phase/observation-id/finding-id`,
		);
	}
	const [phase, observationId, findingId] = parts;
	if (!phase || !observationId || !findingId) {
		throw new TypeError(
			`--resolves ${raw} must be a finding id or phase/observation-id/finding-id`,
		);
	}
	return { raw: token, phase, observationId, findingId };
}

export interface RegisterImplementationAmendmentInput {
	runId: string;
	humanStepKey: string;
	approvalStepKey: string;
	fromPhase: string;
	resolves: readonly string[];
	dryRun?: boolean;
	committedPlanBytes: string;
	worktreePlanBytes: string;
	approvedPlanCommit: string;
	boundaryCommit: string;
	/** False when HEAD is stale or non-workflow paths changed after approval. */
	headAccepted: boolean;
	/** True when pinned enforced policy still has an unresolved approval gate. */
	unresolvedApprovalGate: boolean;
}

export interface ImplementationAmendmentRegistration {
	created: boolean;
	dryRun: boolean;
	completionAuthorized: false;
	nextAction: "resume_author";
	amendmentId: string;
	predecessorRevisionId: string;
	approvedPlanHash: string;
	approvedPlanCommit: string;
	earliestAffectedPhase: string;
	affectedPhases: string[];
	preservedPhases: AmendmentPreservedPhase[];
	invalidatedContextIds: string[];
	invalidatedObservationIds: string[];
	pendingFindings: Array<{
		phase: string;
		observationId: string;
		findingId: string;
		fingerprint: string;
	}>;
	resolvedFindings: AmendmentResolvedFinding[];
	claimDifferences: AmendmentClaimEdit[];
	preservedBinding: {
		id: string;
		sourceRunId: string;
		b0: number;
		governingB: number;
		mode: ImplementationBindingPayload["mode"];
	};
	authorizedScope: AmendmentScope;
	assessedScope: AmendmentAssessment;
	intersection: {
		earliestAffectedPhase: string;
		claimEdits: AmendmentClaimEdit[];
		resolvedFindings: AmendmentResolvedFinding[];
	};
	provenance: RevisionProvenance;
	step: {
		idempotencyKey: string;
		iteration: number;
		phase: string;
		result: {
			amendmentId: string;
			predecessorRevisionId: string;
			authorizationId: string;
			approvedPlanHash: string;
		};
	};
}

function rejectAmendment(message: string): never {
	throw new CliError("IMPLEMENTATION_AMENDMENT_REJECTED", message);
}

function lineageTail(
	recordStore: RecordStore,
	runId: string,
	binding: ImplementationBindingPayload,
): { parentId: string | null; beforeCommit: string; beforeHash: string } {
	let parentId: string | null = null;
	let beforeCommit = binding.approvedPlanCommit;
	let beforeHash = binding.approvedPlanHash;
	for (const line of recordStore.listLines(runId, "budget")) {
		const kind = payloadRecord(line)?.kind;
		try {
			if (kind === "implementation-text-amendment") {
				const text = decodeImplementationTextAmendmentPayload(line.payload);
				if (text.bindingId !== binding.id) continue;
				parentId = text.id;
				beforeCommit = text.afterCommit;
				beforeHash = text.afterBlobHash;
			} else if (kind === "implementation-plan-recovery") {
				const recovery = decodeImplementationPlanRecoveryPayload(line.payload);
				if (recovery.bindingId !== binding.id) continue;
				parentId = recovery.id;
				beforeCommit = recovery.afterCommit;
				beforeHash = recovery.afterBlobHash;
			} else if (kind === "implementation-plan-amendment") {
				const amendment = decodeImplementationSemanticAmendmentPayload(
					line.payload,
				);
				if (amendment.bindingId !== binding.id) continue;
				parentId = amendment.id;
				beforeCommit = amendment.afterCommit;
				beforeHash = amendment.afterBlobHash;
			}
		} catch (error) {
			rejectAmendment(error instanceof Error ? error.message : String(error));
		}
	}
	return { parentId, beforeCommit, beforeHash };
}

function stepIndex(lines: readonly RecordLine[], key: string): number {
	return lines.findIndex((line) => line.idempotencyKey === key);
}

function journalExpectedKeys(
	recordStore: RecordStore,
	runId: string,
): Partial<Record<RecordStream, string[]>> {
	const keys = (stream: RecordStream) =>
		recordStore.listLines(runId, stream).map((line) => line.idempotencyKey);
	return {
		steps: keys("steps"),
		budget: keys("budget"),
		decisions: keys("decisions"),
	};
}

function resultObject(
	step: StepRecordPayload | null,
): Record<string, unknown> | null {
	const result = step?.result_json;
	if (!result || typeof result !== "object" || Array.isArray(result))
		return null;
	return result as Record<string, unknown>;
}

function originalProvenance(
	binding: ImplementationBindingPayload,
): RevisionProvenance["original"] {
	return {
		bindingId: binding.id,
		sourceRunId: binding.sourceRunId,
		sourceSnapshotId: binding.sourceSnapshotId,
		sourceBaselineId: binding.sourceBaselineId,
		approvedPlanCommit: binding.approvedPlanCommit,
		approvedPlanHash: binding.approvedPlanHash,
		initialRevisionId: initialRevisionId(binding.id),
		b0: binding.b0,
		governingB: binding.governingB,
		mode: binding.mode,
	};
}

function historyEntry(revision: EffectiveRevision): RevisionHistoryEntry {
	return {
		id: revision.id,
		kind: revision.kind,
		predecessorId: revision.predecessorId,
		earliestAffectedPhase: revision.earliestAffectedPhase ?? null,
		authorizationId: revision.authorizationId ?? null,
	};
}

function affectedPhaseIds(
	phaseMap: readonly { id: string }[],
	earliest: string | null,
): string[] {
	if (!earliest) return [];
	const index = phaseMap.findIndex((phase) => phase.id === earliest);
	if (index < 0) return [];
	return phaseMap.slice(index).map((phase) => phase.id);
}

function ledgerClaimIds(binding: ImplementationBindingPayload): string[] {
	const ids: string[] = [];
	for (const item of binding.ledger.workItems) {
		const claimId = item.debtClaim?.debtClaimId;
		if (claimId && !ids.includes(claimId)) ids.push(claimId);
	}
	return ids;
}

function creditEditsFor(
	execution: EffectiveExecution,
	revisionId: string,
): AmendmentClaimEdit[] {
	return (
		execution.dispositions.find((entry) => entry.revisionId === revisionId)
			?.claimEdits ?? []
	);
}

/**
 * Separate the immutable binding from the selected revision. Registration
 * success is never implementation completion.
 */
export function presentRevisionProvenance(input: {
	binding: ImplementationBindingPayload;
	execution: EffectiveExecution;
}): RevisionProvenance {
	const selected =
		input.execution.revisions.find(
			(revision) => revision.id === input.execution.currentRevisionId,
		) ?? input.execution.revisions.at(-1);
	if (!selected) {
		throw new TypeError("Effective execution has no revision.");
	}
	const creditDifferences = creditEditsFor(input.execution, selected.id);
	const edited = new Set(creditDifferences.map((edit) => edit.creditClaimId));
	return {
		ok: true,
		completionAuthorized: false,
		original: originalProvenance(input.binding),
		effective: {
			revisionId: selected.id,
			kind: selected.kind,
			predecessorId: selected.predecessorId,
			approvedPlanHash: selected.approvedPlanHash,
			earliestAffectedPhase: selected.earliestAffectedPhase ?? null,
			authorizationId: selected.authorizationId ?? null,
			legacy: selected.legacy ?? null,
		},
		history: input.execution.revisions.map(historyEntry),
		affectedPhases: affectedPhaseIds(
			input.binding.phaseMap,
			selected.earliestAffectedPhase ?? null,
		),
		retainedEvidence: input.execution.evidence.filter(
			(entry) => entry.applicability !== "invalidated",
		),
		pendingFindings: input.execution.findings.filter(
			(finding) => finding.status === "pending",
		),
		resolvedFindings: input.execution.findings.filter(
			(finding) => finding.status === "amendment_resolved",
		),
		creditDifferences,
		unchangedClaimIds: ledgerClaimIds(input.binding).filter(
			(claimId) => !edited.has(claimId),
		),
		baselineUnchanged: true,
	};
}

export function readRevisionProvenance(input: {
	binding: ImplementationBindingPayload;
	recordStore: RecordStore;
	runId: string;
}): RevisionProvenance | RevisionProvenanceFailure {
	const folded = foldEffectiveExecution({
		recordStore: input.recordStore,
		runId: input.runId,
	});
	if (!folded.ok) {
		return {
			ok: false,
			completionAuthorized: false,
			original: originalProvenance(input.binding),
			diagnostic: folded.diagnostic,
		};
	}
	return presentRevisionProvenance({
		binding: input.binding,
		execution: folded,
	});
}

function presentRegistrationProvenance(input: {
	binding: ImplementationBindingPayload;
	execution: EffectiveExecution;
	amendmentId: string;
	predecessorRevisionId: string;
	approvedPlanHash: string;
	earliestAffectedPhase: string;
	authorizationId: string;
	affectedPhases: readonly string[];
	pendingFindings: ReadonlyArray<{
		phase: string;
		observationId: string;
		findingId: string;
		fingerprint: string;
	}>;
	resolvedFindings: readonly AmendmentResolvedFinding[];
	claimEdits: readonly AmendmentClaimEdit[];
	invalidatedObservationIds: readonly string[];
	invalidatedContextIds: readonly string[];
}): RevisionProvenance {
	const recorded = input.execution.revisions.some(
		(revision) => revision.id === input.amendmentId,
	);
	if (recorded && input.execution.currentRevisionId === input.amendmentId) {
		const live = presentRevisionProvenance({
			binding: input.binding,
			execution: input.execution,
		});
		return {
			...live,
			affectedPhases: [...input.affectedPhases],
			creditDifferences: [...input.claimEdits],
			unchangedClaimIds: ledgerClaimIds(input.binding).filter(
				(claimId) =>
					!input.claimEdits.some((edit) => edit.creditClaimId === claimId),
			),
		};
	}
	const invalidatedObservations = new Set(input.invalidatedObservationIds);
	const invalidatedContexts = new Set(input.invalidatedContextIds);
	const history = input.execution.revisions.map(historyEntry);
	if (!recorded) {
		history.push({
			id: input.amendmentId,
			kind: "implementation_plan_amendment",
			predecessorId: input.predecessorRevisionId,
			earliestAffectedPhase: input.earliestAffectedPhase,
			authorizationId: input.authorizationId,
		});
	}
	const recordedRevision = new Map(
		input.execution.findings.map((finding) => [
			`${finding.phase}\u0000${finding.observationId}\u0000${finding.findingId}`,
			finding.recordedRevisionId,
		]),
	);
	return {
		ok: true,
		completionAuthorized: false,
		original: originalProvenance(input.binding),
		effective: {
			revisionId: input.amendmentId,
			kind: "implementation_plan_amendment",
			predecessorId: input.predecessorRevisionId,
			approvedPlanHash: input.approvedPlanHash,
			earliestAffectedPhase: input.earliestAffectedPhase,
			authorizationId: input.authorizationId,
			legacy: null,
		},
		history,
		affectedPhases: [...input.affectedPhases],
		retainedEvidence: input.execution.evidence.filter((entry) => {
			if (entry.applicability === "invalidated") return false;
			if (
				entry.observationId !== undefined &&
				invalidatedObservations.has(entry.observationId)
			) {
				return false;
			}
			return !invalidatedContexts.has(entry.recordId);
		}),
		pendingFindings: input.pendingFindings.map((finding) => ({
			...finding,
			recordedRevisionId:
				recordedRevision.get(
					`${finding.phase}\u0000${finding.observationId}\u0000${finding.findingId}`,
				) ?? input.predecessorRevisionId,
			status: "pending" as const,
		})),
		resolvedFindings: input.resolvedFindings.map((finding) => ({
			phase: finding.phase,
			observationId: finding.observationId,
			findingId: finding.findingId,
			fingerprint: finding.fingerprint,
			recordedRevisionId:
				recordedRevision.get(
					`${finding.phase}\u0000${finding.observationId}\u0000${finding.findingId}`,
				) ?? input.predecessorRevisionId,
			status: "amendment_resolved" as const,
			reason: finding.reason,
		})),
		creditDifferences: [...input.claimEdits],
		unchangedClaimIds: ledgerClaimIds(input.binding).filter(
			(claimId) =>
				!input.claimEdits.some((edit) => edit.creditClaimId === claimId),
		),
		baselineUnchanged: true,
	};
}

/** Validate and, unless dry-run, durably append one semantic amendment. */
export async function registerImplementationAmendment(
	input: RegisterImplementationAmendmentInput,
	deps: {
		recordStore: RecordStore;
		origin: RecordOrigin;
		now?: () => string;
		/**
		 * Paired append. The command passes the shared admission/finalization seam.
		 * The default is the RecordStore CAS append used by direct callers.
		 */
		appendPair?: (
			ops: AppendOp[],
			expectedKeys: Partial<Record<RecordStream, string[]>>,
		) => Promise<AtomicAppendIfAllNewResult> | AtomicAppendIfAllNewResult;
	},
): Promise<ImplementationAmendmentRegistration> {
	const { recordStore } = deps;
	const run = recordStore.getRun(input.runId);
	if (run?.status !== "active") {
		rejectAmendment("Registration requires an active implementation run.");
	}
	const expectedKeys = journalExpectedKeys(recordStore, input.runId);
	const folded = foldEffectiveExecution({
		recordStore,
		runId: input.runId,
	});
	if (!folded.ok) rejectAmendment(folded.diagnostic.message);
	const bindingLine = recordStore.getLine(
		input.runId,
		"budget",
		implementationBindingKey(input.runId),
	);
	if (!bindingLine) rejectAmendment("The implementation binding is missing.");
	const binding = decodeImplementationBindingPayload(bindingLine.payload);
	if (
		binding.id !== folded.bindingId ||
		binding.b0 !== folded.pinned.b0 ||
		binding.governingB !== folded.pinned.governingB ||
		binding.mode !== folded.pinned.mode ||
		binding.sourceRunId !== folded.pinned.sourceRunId
	) {
		rejectAmendment(
			"Registration keeps the original binding, baseline, and pinned policy.",
		);
	}
	const current = folded.revisions.find(
		(revision) => revision.id === folded.currentRevisionId,
	);
	if (!current) rejectAmendment("The current revision is missing.");
	if (hashPlanBytes(current.approvedPlanBytes) !== current.approvedPlanHash) {
		rejectAmendment("The current revision hash does not match its bytes.");
	}
	if (!input.headAccepted) {
		rejectAmendment(
			"HEAD is stale or non-workflow files changed after the approved plan commit.",
		);
	}
	if (input.worktreePlanBytes !== input.committedPlanBytes) {
		rejectAmendment(
			"The worktree plan does not match the approved committed plan bytes.",
		);
	}
	if (input.unresolvedApprovalGate) {
		rejectAmendment(
			"The coupled plan approval still has an unresolved approval gate.",
		);
	}
	const steps = recordStore.listLines(input.runId, "steps");
	const humanIndex = stepIndex(steps, input.humanStepKey);
	const approvalIndex = stepIndex(steps, input.approvalStepKey);
	const humanLine = humanIndex >= 0 ? steps[humanIndex] : undefined;
	const approvalLine = approvalIndex >= 0 ? steps[approvalIndex] : undefined;
	const humanStep = humanLine ? stepRecord(humanLine) : null;
	const approvalStep = approvalLine ? stepRecord(approvalLine) : null;
	if (humanStep?.step_name !== "human:review-governance") {
		rejectAmendment(
			"The human step must be the coupled human:review-governance record. A generic human:gate does not qualify.",
		);
	}
	const humanResult =
		humanStep.result_json &&
		typeof humanStep.result_json === "object" &&
		!Array.isArray(humanStep.result_json)
			? (humanStep.result_json as {
					decisionId?: unknown;
					choice?: unknown;
				})
			: null;
	if (
		!humanResult ||
		typeof humanResult.decisionId !== "string" ||
		humanResult.choice === "continue" ||
		humanResult.choice === "override"
	) {
		rejectAmendment(
			"The human step must resolve one authorize_amendment decision. Continue and override do not qualify.",
		);
	}
	if (
		approvalStep?.step_name.startsWith("reviewer:") !== true ||
		approvalStep.phase !== "plan"
	) {
		rejectAmendment(
			"The approval step must be a plan reviewer step in this run.",
		);
	}
	if (humanIndex < 0 || approvalIndex <= humanIndex) {
		rejectAmendment("The plan approval must follow its human authorization.");
	}
	const listed = listImplementationDecisions(recordStore, input.runId);
	if (listed.diagnostics.length) {
		rejectAmendment("Implementation decision history is unreadable.");
	}
	const authorization = listed.decisions.find(
		(decision) => decision.decisionId === humanResult.decisionId,
	);
	if (
		authorization?.choice !== "authorize_amendment" ||
		authorization.bindingId !== binding.id
	) {
		rejectAmendment(
			"An authorize_amendment decision coupled to this human step is required.",
		);
	}
	if (!authorization.amendmentScope) {
		rejectAmendment(
			`Authorization ${authorization.decisionId} omits amendmentScope and cannot authorize a semantic amendment.`,
		);
	}
	const scope = authorization.amendmentScope;
	if (
		listed.decisions.some(
			(decision) => decision.supersedesDecisionId === authorization.decisionId,
		)
	) {
		rejectAmendment("Superseded amendment authorizations are rejected.");
	}
	const acceptance = classifyDecisionAcceptance({
		decision: authorization,
		steps,
		budget: recordStore.listLines(input.runId, "budget"),
	});
	if (!acceptance.accepted) {
		rejectAmendment(
			acceptance.diagnostic ?? "The human authorization is not accepted.",
		);
	}
	const baseline = folded.revisions.find(
		(revision) => revision.id === scope.predecessorRevisionId,
	);
	if (!baseline) {
		rejectAmendment(
			`Authorization predecessor ${scope.predecessorRevisionId} is not in the revision chain.`,
		);
	}
	const budgetKey = implementationSemanticAmendmentKey(
		binding.id,
		scope.predecessorRevisionId,
	);
	const recordedPredecessor = recordStore.getLine(
		input.runId,
		"budget",
		budgetKey,
	);
	if (
		!recordedPredecessor &&
		scope.predecessorRevisionId !== folded.currentRevisionId
	) {
		rejectAmendment(
			`Authorization predecessor ${scope.predecessorRevisionId} is not the current revision ${folded.currentRevisionId}.`,
		);
	}
	if (hashPlanBytes(baseline.approvedPlanBytes) !== baseline.approvedPlanHash) {
		rejectAmendment("The predecessor revision hash does not match its bytes.");
	}
	const verdict =
		approvalStep.result_json &&
		typeof approvalStep.result_json === "object" &&
		!Array.isArray(approvalStep.result_json)
			? (approvalStep.result_json as {
					readiness?: unknown;
					items?: unknown;
					amendmentAssessment?: unknown;
					governance?: { route?: unknown };
				})
			: null;
	if (
		verdict?.readiness !== "ready" ||
		!Array.isArray(verdict.items) ||
		verdict.items.length > 0 ||
		verdict.governance?.route === "final_corrections" ||
		(verdict.governance?.route !== undefined &&
			verdict.governance.route !== "complete")
	) {
		rejectAmendment(
			"The coupled plan approval must have normalized route complete. Final corrections require a new assessment.",
		);
	}
	if (verdict.amendmentAssessment === undefined) {
		rejectAmendment(
			"The plan approval has no amendmentAssessment. A ready summary does not authorize carry.",
		);
	}
	let assessment: AmendmentAssessment;
	try {
		assessment = parseAmendmentAssessment(verdict.amendmentAssessment);
	} catch (error) {
		rejectAmendment(error instanceof Error ? error.message : String(error));
	}
	const approvedHash = hashPlanBytes(input.committedPlanBytes);
	if (
		assessment.predecessorRevisionId !== scope.predecessorRevisionId ||
		assessment.reviewedPlanHash !== approvedHash ||
		hashPlanBytes(baseline.approvedPlanBytes) !== baseline.approvedPlanHash
	) {
		rejectAmendment(
			"The assessment predecessor or reviewed plan hash does not match the current revision and committed bytes.",
		);
	}
	if (assessment.earliestAffectedPhase !== input.fromPhase) {
		rejectAmendment(
			"--from-phase must equal the assessment's earliest affected phase.",
		);
	}
	const predecessorPlan = parsePlan(baseline.approvedPlanBytes);
	const phaseIds = predecessorPlan.phases.map((phase) => phase.number);
	const nextPlan = parsePlan(input.committedPlanBytes);
	const nextIds = nextPlan.phases.map((phase) => phase.number);
	if (
		new Set(phaseIds).size !== phaseIds.length ||
		nextIds.join("\u0000") !== phaseIds.join("\u0000")
	) {
		rejectAmendment(
			"Registration cannot delete, add, reorder, or renumber phase ids.",
		);
	}
	const authorizedIndex = phaseIds.indexOf(scope.earliestAffectedPhase);
	const assessedIndex = phaseIds.indexOf(assessment.earliestAffectedPhase);
	if (authorizedIndex < 0 || assessedIndex < 0) {
		rejectAmendment("The affected phase is not in the predecessor plan.");
	}
	if (assessedIndex < authorizedIndex) {
		rejectAmendment(
			`Assessed boundary ${assessment.earliestAffectedPhase} is earlier than authorized phase ${scope.earliestAffectedPhase}. The assessment was not clamped.`,
		);
	}
	const preservedIds = phaseIds.slice(0, assessedIndex);
	const preserved = new Set(
		assessment.preservedPhases.map((phase) => phase.phaseId),
	);
	if (
		preserved.size !== preservedIds.length ||
		preservedIds.some((id) => !preserved.has(id))
	) {
		rejectAmendment(
			"Preserved phases must be exactly the phases before the assessed boundary.",
		);
	}
	const beforeLedger = parseDeliveryBudget(baseline.approvedPlanBytes);
	const afterLedger = parseDeliveryBudget(input.committedPlanBytes);
	if (!beforeLedger.ok || !afterLedger.ok) {
		rejectAmendment("The amended plan ledger could not be parsed.");
	}
	for (const phaseId of preservedIds) {
		const index = phaseIds.indexOf(phaseId);
		if (
			phaseSection(
				baseline.approvedPlanBytes,
				predecessorPlan.phases,
				index,
			) !== phaseSection(input.committedPlanBytes, nextPlan.phases, index)
		) {
			rejectAmendment(
				`Preserved phase ${phaseId} changed beyond checkbox state.`,
			);
		}
		if (
			claimContract(beforeLedger.value, phaseId) !==
			claimContract(afterLedger.value, phaseId)
		) {
			rejectAmendment(
				`Preserved phase ${phaseId} changed a linked claim contract.`,
			);
		}
		const section = phaseSection(
			baseline.approvedPlanBytes,
			predecessorPlan.phases,
			index,
		);
		for (const workItemId of namedWorkItemIds(section)) {
			if (
				workItemContract(beforeLedger.value, workItemId) !==
				workItemContract(afterLedger.value, workItemId)
			) {
				rejectAmendment(
					`Preserved phase ${phaseId} changed a linked work-item contract.`,
				);
			}
		}
	}
	const affected = phaseIds.slice(assessedIndex);
	const completed = new Set<string>();
	for (const line of steps) {
		const step = stepRecord(line);
		if (step?.step_name === "phase:complete" && step.phase) {
			completed.add(step.phase);
		}
	}
	const observations = recordStore
		.listLines(input.runId, "budget")
		.flatMap((line) => {
			try {
				const observation = decodeImplementationReviewObservationPayload(
					line.payload,
				);
				return observation.bindingId === binding.id ? [observation] : [];
			} catch {
				return [];
			}
		});
	for (const observation of observations) {
		if (observation.completionAuthorized) completed.add(observation.phase);
	}
	if (
		affected.some((phaseId) => completed.has(phaseId)) &&
		!scope.reopenCompletedPhases
	) {
		rejectAmendment(
			"Completed phases at or after the assessed boundary require reopenCompletedPhases true. Consent was not inferred.",
		);
	}
	let derivedEffects: AmendmentClaimEdit[];
	try {
		derivedEffects = claimEffects(beforeLedger.value, afterLedger.value);
	} catch (error) {
		rejectAmendment(error instanceof Error ? error.message : String(error));
	}
	if (effectSet(assessment.claimEdits) !== effectSet(derivedEffects)) {
		rejectAmendment(
			"The assessment's claim effects do not match the amended ledger. A broader assessment was not clamped.",
		);
	}
	for (const edit of assessment.claimEdits) {
		const allowed = scope.claimEdits.some(
			(candidate) =>
				candidate.creditClaimId === edit.creditClaimId &&
				candidate.effect === edit.effect,
		);
		if (!allowed) {
			rejectAmendment(
				`Claim edit ${edit.creditClaimId} ${edit.effect} is outside amendmentScope.`,
			);
		}
	}
	const snapshots = recordStore
		.listLines(input.runId, "budget")
		.flatMap((line) => {
			try {
				return [decodeBudgetSnapshotPayload(line.payload)];
			} catch {
				return [];
			}
		});
	const snapshot = snapshots.at(-1);
	if (
		snapshot?.stepKey.phase !== "plan" ||
		snapshot.stepKey.stepName !== approvalStep.step_name ||
		snapshot.stepKey.iteration !== approvalStep.iteration ||
		JSON.stringify(snapshot.currentLedger) !== JSON.stringify(afterLedger.value)
	) {
		rejectAmendment(
			"The latest plan-review snapshot must match the approval step and the amended ledger.",
		);
	}
	const author = steps
		.slice(humanIndex + 1, approvalIndex)
		.reverse()
		.find((line) => {
			const step = stepRecord(line);
			const result = resultObject(step);
			return (
				step?.phase === "plan" &&
				step.step_name.startsWith("author:") &&
				result?.result === "complete" &&
				result.commit === input.approvedPlanCommit
			);
		});
	const boundaryLine = steps
		.slice(0, approvalIndex)
		.reverse()
		.find((line) => stepRecord(line)?.step_name === "git:commit");
	const boundaryHash = resultObject(
		boundaryLine ? stepRecord(boundaryLine) : null,
	)?.hash;
	if (!author || boundaryHash !== input.boundaryCommit) {
		rejectAmendment(
			"The approved plan commit must be the completed author commit, and the review boundary must be the last git:commit before approval.",
		);
	}
	const selectors = input.resolves.map((raw) => {
		try {
			return parseResolveSelector(raw);
		} catch (error) {
			return rejectAmendment(
				error instanceof Error ? error.message : String(error),
			);
		}
	});
	const sourceObservation = observations.find(
		(observation) => observation.id === authorization.observationId,
	);
	if (!sourceObservation || sourceObservation.phase !== authorization.phase) {
		rejectAmendment("The authorization source observation is missing.");
	}
	const selected = selectors.map((selector) => {
		const observation = selector.observationId
			? observations.find(
					(candidate) =>
						candidate.id === selector.observationId &&
						candidate.phase === selector.phase,
				)
			: sourceObservation;
		if (!selector.observationId && selector.phase) {
			rejectAmendment(`--resolves ${selector.raw} is not a source finding id.`);
		}
		if (!observation) {
			rejectAmendment(
				`--resolves ${selector.raw} does not name an observation on this binding.`,
			);
		}
		if (!selector.observationId && observation.id !== sourceObservation.id) {
			rejectAmendment(
				`Plain --resolves ${selector.findingId} is not on the authorization source observation.`,
			);
		}
		const fingerprint = observationFingerprint(observation, selector.findingId);
		if (!fingerprint) {
			rejectAmendment(
				selector.observationId
					? `--resolves ${selector.raw} is not on that observation.`
					: `Plain --resolves ${selector.findingId} is not on the source observation. The same id on another phase is not selected.`,
			);
		}
		const assessed = assessment.resolvedFindings.find(
			(finding) =>
				finding.phase === observation.phase &&
				finding.observationId === observation.id &&
				finding.findingId === selector.findingId &&
				finding.fingerprint === fingerprint,
		);
		if (!assessed) {
			rejectAmendment(
				`--resolves ${selector.findingId} is not an amendment-resolved finding in the assessment.`,
			);
		}
		return assessed;
	});
	if (new Set(selected.map(findingKey)).size !== selected.length) {
		rejectAmendment("Duplicate --resolves selectors are rejected.");
	}
	const assessedKeys = new Set(assessment.resolvedFindings.map(findingKey));
	const selectedKeys = new Set(selected.map(findingKey));
	if (
		assessedKeys.size !== selectedKeys.size ||
		[...assessedKeys].some((key) => !selectedKeys.has(key))
	) {
		rejectAmendment(
			"The requested --resolves set must equal the assessment's amendment-resolved findings.",
		);
	}
	for (const finding of assessment.resolvedFindings) {
		const allowed = scope.resolutionRefs.some(
			(ref) =>
				ref.phase === finding.phase &&
				ref.observationId === finding.observationId &&
				ref.findingId === finding.findingId &&
				ref.fingerprint === finding.fingerprint,
		);
		if (!allowed) {
			rejectAmendment(
				`Resolved finding ${finding.findingId} is outside amendmentScope. The assessment was not clamped.`,
			);
		}
	}
	const contexts = recordStore
		.listLines(input.runId, "budget")
		.flatMap((line) => {
			try {
				const context = decodeImplementationReviewContextPayload(line.payload);
				return context.bindingId === binding.id ? [context] : [];
			} catch {
				return [];
			}
		});
	const affectedSet = new Set(affected);
	const invalidatedContextIds = contexts
		.filter((context) => affectedSet.has(context.phase))
		.map((context) => context.id);
	const invalidatedObservationIds = observations
		.filter((observation) => affectedSet.has(observation.phase))
		.map((observation) => observation.id);
	const tail = lineageTail(recordStore, input.runId, binding);
	const consumed = recordStore.listLines(input.runId, "budget").some((line) => {
		const kind = payloadRecord(line)?.kind;
		if (kind === "implementation-plan-recovery") {
			try {
				return (
					decodeImplementationPlanRecoveryPayload(line.payload)
						.authorizationId === authorization.decisionId
				);
			} catch {
				return false;
			}
		}
		if (kind !== "implementation-plan-amendment") return false;
		try {
			const amendment = decodeImplementationSemanticAmendmentPayload(
				line.payload,
			);
			return (
				amendment.authorizationId === authorization.decisionId &&
				amendment.predecessorRevisionId !== scope.predecessorRevisionId
			);
		} catch {
			return false;
		}
	});
	const digest = amendmentIntentDigest({
		authorizationId: authorization.decisionId,
		predecessorRevisionId: scope.predecessorRevisionId,
		humanStepKey: input.humanStepKey,
		approvalStepKey: input.approvalStepKey,
		approvedPlanHash: approvedHash,
		earliestAffectedPhase: assessment.earliestAffectedPhase,
		preservedPhases: assessment.preservedPhases,
		resolvedFindings: assessment.resolvedFindings,
		claimEdits: assessment.claimEdits,
	});
	const amendmentId = `amendment:${digest.slice("sha256:".length)}`;
	let iteration = 1;
	for (const line of steps) {
		const step = stepRecord(line);
		if (
			step?.step_name === "implementation:amendment" &&
			step.phase === assessment.earliestAffectedPhase &&
			step.iteration >= iteration
		) {
			iteration = step.iteration + 1;
		}
	}
	const stepKey = stepIdempotencyKey({
		runId: input.runId,
		stepName: "implementation:amendment",
		phase: assessment.earliestAffectedPhase,
		iteration,
	});
	const createdAt = deps.now?.() ?? new Date().toISOString();
	const payload: ImplementationSemanticAmendmentPayload = {
		kind: "implementation-plan-amendment",
		version: 1,
		id: amendmentId,
		bindingId: binding.id,
		executionRunId: input.runId,
		predecessorRevisionId: scope.predecessorRevisionId,
		authorizationId: authorization.decisionId,
		humanStep: { idempotencyKey: input.humanStepKey },
		approvalStep: { idempotencyKey: input.approvalStepKey },
		parentLineageId: tail.parentId,
		beforeCommit: tail.beforeCommit,
		afterCommit: input.approvedPlanCommit,
		beforeBlobHash: tail.beforeHash,
		afterBlobHash: approvedHash,
		approvedPlanCommit: input.approvedPlanCommit,
		approvedPlanHash: approvedHash,
		approvedPlanBytes: input.committedPlanBytes,
		earliestAffectedPhase: assessment.earliestAffectedPhase,
		preservedPhases: assessment.preservedPhases,
		resolvedFindings: assessment.resolvedFindings,
		claimEdits: assessment.claimEdits,
		invalidatedContextIds,
		invalidatedObservationIds,
		intentDigest: digest,
		createdAt,
	};
	const stepResult = {
		amendmentId,
		predecessorRevisionId: scope.predecessorRevisionId,
		authorizationId: authorization.decisionId,
		approvedPlanHash: approvedHash,
	};
	const resolvedKeys = new Set(assessment.resolvedFindings.map(findingKey));
	const pendingFindings = folded.findings.flatMap((finding) => {
		if (finding.status !== "pending") return [];
		if (resolvedKeys.has(findingKey(finding))) return [];
		return [
			{
				phase: finding.phase,
				observationId: finding.observationId,
				findingId: finding.findingId,
				fingerprint: finding.fingerprint,
			},
		];
	});
	const registration = (
		created: boolean,
		dryRun: boolean,
	): ImplementationAmendmentRegistration => ({
		created,
		dryRun,
		completionAuthorized: false,
		nextAction: "resume_author",
		amendmentId,
		predecessorRevisionId: scope.predecessorRevisionId,
		approvedPlanHash: approvedHash,
		approvedPlanCommit: input.approvedPlanCommit,
		earliestAffectedPhase: assessment.earliestAffectedPhase,
		affectedPhases: affected,
		preservedPhases: assessment.preservedPhases,
		invalidatedContextIds,
		invalidatedObservationIds,
		pendingFindings,
		resolvedFindings: assessment.resolvedFindings,
		claimDifferences: assessment.claimEdits,
		preservedBinding: {
			id: binding.id,
			sourceRunId: binding.sourceRunId,
			b0: binding.b0,
			governingB: binding.governingB,
			mode: binding.mode,
		},
		authorizedScope: scope,
		assessedScope: assessment,
		intersection: {
			earliestAffectedPhase: assessment.earliestAffectedPhase,
			claimEdits: assessment.claimEdits,
			resolvedFindings: assessment.resolvedFindings,
		},
		provenance: presentRegistrationProvenance({
			binding,
			execution: folded,
			amendmentId,
			predecessorRevisionId: scope.predecessorRevisionId,
			approvedPlanHash: approvedHash,
			earliestAffectedPhase: assessment.earliestAffectedPhase,
			authorizationId: authorization.decisionId,
			affectedPhases: affected,
			pendingFindings,
			resolvedFindings: assessment.resolvedFindings,
			claimEdits: assessment.claimEdits,
			invalidatedObservationIds,
			invalidatedContextIds,
		}),
		step: {
			idempotencyKey: stepKey,
			iteration,
			phase: assessment.earliestAffectedPhase,
			result: stepResult,
		},
	});
	const existing = recordStore.getLine(input.runId, "budget", budgetKey);
	if (existing) {
		let winner: ImplementationSemanticAmendmentPayload;
		try {
			winner = decodeImplementationSemanticAmendmentPayload(existing.payload);
		} catch (error) {
			rejectAmendment(error instanceof Error ? error.message : String(error));
		}
		if (winner.id !== amendmentId || winner.intentDigest !== digest) {
			rejectAmendment(
				"A different amendment already won this predecessor. Inspect its receipt.",
			);
		}
		const recorded = registration(false, Boolean(input.dryRun));
		const paired = steps
			.map(stepRecord)
			.find(
				(step) =>
					step?.step_name === "implementation:amendment" &&
					step.result_json !== null &&
					typeof step.result_json === "object" &&
					(step.result_json as { amendmentId?: string }).amendmentId ===
						winner.id,
			);
		if (paired?.phase) {
			recorded.step = {
				idempotencyKey: stepIdempotencyKey({
					runId: input.runId,
					stepName: paired.step_name,
					phase: paired.phase,
					iteration: paired.iteration,
				}),
				iteration: paired.iteration,
				phase: paired.phase,
				result: stepResult,
			};
		}
		return recorded;
	}
	if (consumed) {
		rejectAmendment(
			"This authorization was already consumed and cannot be reused.",
		);
	}
	if (tail.beforeHash !== baseline.approvedPlanHash) {
		rejectAmendment(
			"The lineage tail does not match the current revision hash.",
		);
	}
	if (input.dryRun) return registration(false, true);
	const stepPayload: StepRecordPayload = {
		step_name: "implementation:amendment",
		phase: assessment.earliestAffectedPhase,
		iteration,
		result_json: stepResult,
		head_commit: input.approvedPlanCommit,
		patch_id: null,
		diff_summary: null,
		duration_ms: null,
		tokens_in: null,
		tokens_out: null,
		cost_usd: null,
		model: null,
	};
	const envelope = recordedEnvelope(deps.origin);
	const ops: AppendOp[] = [
		{
			runId: input.runId,
			stream: "steps",
			idempotencyKey: stepKey,
			payload: stepPayload,
			createdAt,
			...envelope,
		},
		{
			runId: input.runId,
			stream: "budget",
			idempotencyKey: budgetKey,
			payload,
			createdAt,
			...envelope,
		},
	];
	let appended: AtomicAppendIfAllNewResult;
	try {
		appended = await (deps.appendPair
			? deps.appendPair(ops, expectedKeys)
			: recordStore.atomicAppendIfAllNew(ops, expectedKeys));
	} catch (error) {
		if (
			error instanceof RecordStoreError &&
			error.code === "RECORD_PRECONDITION_FAILED"
		) {
			rejectAmendment(
				"Run history changed during registration; repeat the dry-run. No new revision was published.",
			);
		}
		throw error;
	}
	if (!appended.created) {
		const budgetDuplicate = appended.duplicates.find(
			(duplicate) => duplicate.line.idempotencyKey === budgetKey,
		);
		if (!budgetDuplicate) {
			rejectAmendment("Registration did not commit. Repeat the dry-run.");
		}
		const winner = decodeImplementationSemanticAmendmentPayload(
			budgetDuplicate.line.payload,
		);
		if (winner.id !== amendmentId) {
			rejectAmendment(
				"A different amendment already won this predecessor. Inspect its receipt.",
			);
		}
		const readback = recordStore.getLine(input.runId, "budget", budgetKey);
		if (!readback) {
			rejectAmendment("The recorded amendment could not be read back.");
		}
		return registration(false, false);
	}
	const readback = recordStore.getLine(input.runId, "budget", budgetKey);
	const readStep = recordStore.getLine(input.runId, "steps", stepKey);
	if (!readback || !readStep) {
		rejectAmendment("The recorded amendment could not be read back.");
	}
	const stored = decodeImplementationSemanticAmendmentPayload(readback.payload);
	if (stored.id !== amendmentId || stored.intentDigest !== digest) {
		rejectAmendment("Readback does not match the registration intent.");
	}
	const evidenceProblem = verifyRegisteredAmendmentEvidence(
		recordStore,
		input.runId,
		stored,
	);
	if (evidenceProblem) rejectAmendment(evidenceProblem);
	return registration(true, false);
}
