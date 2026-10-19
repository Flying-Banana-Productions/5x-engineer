/**
 * Canonical effective execution revision.
 *
 * The binding line stays immutable. Legacy recoveries and semantic amendments
 * append revisions. Historical lines without a revision field are attributed
 * from journal order inside one stream. This module does not append records
 * or synthesize a reviewer assessment for a legacy recovery.
 */

import { createHash } from "node:crypto";
import type { RecordStore } from "../control-plane/record-store.js";
import {
	type RecordLine,
	type StepRecordPayload,
	stepIdempotencyKey,
} from "../control-plane/record-types.js";
import { parseDeliveryBudget } from "../parsers/delivery-budget.js";
import { type Phase, parsePlan } from "../parsers/plan.js";
import {
	type AmendmentAssessment,
	type AmendmentClaimEdit,
	type AmendmentPreservedPhase,
	type AmendmentResolvedFinding,
	parseAmendmentAssessment,
	type VerdictItem,
} from "../protocol.js";
import {
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
} from "../review-budget/record-lines.js";
import type { ParsedDeliveryBudget } from "../review-budget/types.js";
import {
	type ImplementationDecisionPayload,
	validateImplementationDecision,
} from "./decisions.js";
import { fingerprintImplementationVerdictItem } from "./fingerprint.js";
import { normalizeCheckboxMarkers } from "./plan-amendment.js";
import {
	PROTECTED_PLAN_SECTION_TITLES,
	planHeadingSpans,
} from "./plan-markdown.js";

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
}

export type EffectiveExecutionResult =
	| EffectiveExecution
	| { ok: false; diagnostic: RevisionFoldDiagnostic };

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

function protectedText(markdown: string): string {
	const parts: string[] = [];
	for (const heading of planHeadingSpans(markdown)) {
		if (!PROTECTED_PLAN_SECTION_TITLES.has(heading.text.toLowerCase()))
			continue;
		parts.push(
			normalizeCheckboxMarkers(
				markdown.slice(heading.lineStart, heading.sectionEnd),
			),
		);
	}
	return parts.join("\n");
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
		"Copy those values into amendmentAssessment. Do not infer preserved phases,",
		"finding resolution, or claim effects from readiness, summary, or rationale.",
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
			const duplicate = remember({
				id: observation.id,
				phase: observation.phase,
				kind: "observation",
				revisionId: revision,
				recordId: line.idempotencyKey,
				completionAuthorized: observation.completionAuthorized,
				findings,
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
			if (
				lineage.preservedPhases.length > 0 &&
				protectedText(authorizedBytes) !==
					protectedText(lineage.approvedPlanBytes)
			) {
				return fail(
					"budget",
					line.idempotencyKey,
					"A shared design, acceptance, or scope section changed, so earlier phases cannot be preserved.",
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
		const citedApplicable =
			record.observationId !== undefined &&
			applicableObservations.has(record.observationId) &&
			!invalidatedObservations.has(record.observationId);
		evidence.push({
			stream: "budget",
			recordId: record.recordId,
			kind: record.kind,
			revisionId: record.revisionId,
			applicability: invalidated ? "invalidated" : "applicable",
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
	for (const record of seen) {
		if (record.kind !== "observation" || !selectedIds.has(record.revisionId)) {
			continue;
		}
		for (const finding of record.findings) {
			const resolved = resolutions.get(
				`${finding.phase}\u0000${finding.observationId}\u0000${finding.findingId}`,
			);
			findings.push({
				...finding,
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
	};
}
