import type {
	ClosureDiagnostic,
	PriorFindingOutcome,
	ReviewGateCause,
} from "../review-governance/types.js";
import type {
	BaselineAssessment,
	CreditAssessmentInput,
	FindingDelta,
	ParsedDeliveryBudget,
	ReviewBudgetMode,
	ReviewBudgetThresholds,
	SurfaceSnapshot,
} from "./types.js";

export const IMPLEMENTATION_STATE_VERSION = 1 as const;

export type BudgetRecordKind =
	| "baseline"
	| "snapshot"
	| "implementation-binding"
	| "implementation-compatibility"
	| "implementation-text-amendment";
export type CaptureKind = "initial" | "opt_in";

export interface BudgetBaselinePayload {
	kind: "baseline";
	id: string;
	runId: string;
	captureKind: CaptureKind;
	b0: number;
	b: number;
	originalLedger: ParsedDeliveryBudget;
	surface: SurfaceSnapshot;
	originalSection: string | null;
	configSnapshot: ReviewBudgetThresholds;
	mode: Exclude<ReviewBudgetMode, "off">;
	createdAt: string;
}

export interface BudgetSnapshotStepKey {
	stepName: string;
	phase: string | null;
	iteration: number | null;
}

export interface BudgetSnapshotPayload {
	kind: "snapshot";
	id: string;
	runId: string;
	stepKey: BudgetSnapshotStepKey;
	currentLedger: ParsedDeliveryBudget;
	findings: FindingDelta[];
	assessments: CreditAssessmentInput[];
	baselineAssessment?: BaselineAssessment;
	priorFindings?: PriorFindingOutcome[];
	effectiveGateCauses?: ReviewGateCause[];
	suppressedGateCauses?: ReviewGateCause[];
	diagnostics?: ClosureDiagnostic[];
	createdAt: string;
}

export function baselineIdempotencyKey(runId: string): string {
	return `budget:baseline:${runId}`;
}

export function snapshotIdempotencyKey(
	runId: string,
	stepKey: BudgetSnapshotStepKey,
): string {
	return `budget:snapshot:${runId}:${stepKey.stepName}:${stepKey.phase ?? ""}:${stepKey.iteration ?? ""}`;
}

function object(raw: unknown, label: string): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new TypeError(`${label} must be an object`);
	}
	return raw as Record<string, unknown>;
}

function stringField(
	value: unknown,
	field: string,
	allowEmpty = false,
): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new TypeError(`${field} must be a string`);
	}
	return value;
}

export function encodeBudgetBaselinePayload(
	payload: BudgetBaselinePayload,
): unknown {
	return structuredClone(payload);
}

export function decodeBudgetBaselinePayload(
	raw: unknown,
): BudgetBaselinePayload {
	const value = object(raw, "budget baseline payload");
	if (value.kind !== "baseline") throw new TypeError("invalid baseline kind");
	if (value.captureKind !== "initial" && value.captureKind !== "opt_in") {
		throw new TypeError("invalid baseline captureKind");
	}
	if (typeof value.b0 !== "number" || value.b0 <= 0) {
		throw new TypeError("baseline b0 must be positive");
	}
	if (typeof value.b !== "number" || value.b <= 0) {
		throw new TypeError("baseline b must be positive");
	}
	return {
		kind: "baseline",
		id: stringField(value.id, "id"),
		runId: stringField(value.runId, "runId"),
		captureKind: value.captureKind,
		b0: value.b0,
		b: value.b,
		originalLedger: structuredClone(
			object(value.originalLedger, "originalLedger"),
		) as unknown as ParsedDeliveryBudget,
		surface: structuredClone(
			object(value.surface, "surface"),
		) as unknown as SurfaceSnapshot,
		originalSection:
			value.originalSection === null
				? null
				: stringField(value.originalSection, "originalSection", true),
		configSnapshot: structuredClone(
			object(value.configSnapshot, "configSnapshot"),
		) as unknown as ReviewBudgetThresholds,
		mode:
			value.mode === "enforced" || value.mode === "advisory"
				? value.mode
				: "advisory",
		createdAt: stringField(value.createdAt, "createdAt"),
	};
}

export function encodeBudgetSnapshotPayload(
	payload: BudgetSnapshotPayload,
): unknown {
	const encoded: Record<string, unknown> = {
		kind: payload.kind,
		id: payload.id,
		runId: payload.runId,
		stepKey: structuredClone(payload.stepKey),
		currentLedger: structuredClone(payload.currentLedger),
		findings: structuredClone(payload.findings),
		assessments: structuredClone(payload.assessments),
		createdAt: payload.createdAt,
	};
	if (payload.baselineAssessment !== undefined) {
		encoded.baselineAssessment = structuredClone(payload.baselineAssessment);
	}
	if (payload.priorFindings !== undefined)
		encoded.priorFindings = structuredClone(payload.priorFindings);
	if (payload.effectiveGateCauses !== undefined)
		encoded.effectiveGateCauses = structuredClone(payload.effectiveGateCauses);
	if (payload.suppressedGateCauses !== undefined)
		encoded.suppressedGateCauses = structuredClone(
			payload.suppressedGateCauses,
		);
	if (payload.diagnostics !== undefined)
		encoded.diagnostics = structuredClone(payload.diagnostics);
	return encoded;
}

export function decodeBudgetSnapshotPayload(
	raw: unknown,
): BudgetSnapshotPayload {
	const value = object(raw, "budget snapshot payload");
	if (value.kind !== "snapshot") throw new TypeError("invalid snapshot kind");
	const stepKey = object(value.stepKey, "stepKey");
	if (!Array.isArray(value.findings) || !Array.isArray(value.assessments)) {
		throw new TypeError("snapshot findings and assessments must be arrays");
	}
	const decoded: BudgetSnapshotPayload = {
		kind: "snapshot",
		id: stringField(value.id, "id"),
		runId: stringField(value.runId, "runId"),
		stepKey: {
			stepName: stringField(stepKey.stepName, "stepKey.stepName"),
			phase:
				stepKey.phase === null
					? null
					: stringField(stepKey.phase, "stepKey.phase", true),
			iteration:
				stepKey.iteration === null
					? null
					: typeof stepKey.iteration === "number" &&
							Number.isInteger(stepKey.iteration)
						? stepKey.iteration
						: (() => {
								throw new TypeError(
									"stepKey.iteration must be an integer or null",
								);
							})(),
		},
		currentLedger: structuredClone(
			object(value.currentLedger, "currentLedger"),
		) as unknown as ParsedDeliveryBudget,
		findings: structuredClone(value.findings) as FindingDelta[],
		assessments: structuredClone(value.assessments) as CreditAssessmentInput[],
		createdAt: stringField(value.createdAt, "createdAt"),
	};
	if (value.baselineAssessment !== undefined) {
		const assessment = object(value.baselineAssessment, "baselineAssessment");
		if (
			typeof assessment.independentEffortEstimate !== "number" ||
			!Number.isInteger(assessment.independentEffortEstimate) ||
			assessment.independentEffortEstimate < 0 ||
			(assessment.confidence !== "low" &&
				assessment.confidence !== "medium" &&
				assessment.confidence !== "high")
		) {
			throw new TypeError("invalid baselineAssessment");
		}
		decoded.baselineAssessment = {
			independentEffortEstimate: assessment.independentEffortEstimate,
			confidence: assessment.confidence,
			reason: stringField(assessment.reason, "baselineAssessment.reason"),
		};
	}
	if (value.priorFindings !== undefined) {
		if (!Array.isArray(value.priorFindings))
			throw new TypeError("priorFindings must be an array");
		decoded.priorFindings = structuredClone(
			value.priorFindings,
		) as PriorFindingOutcome[];
	}
	for (const field of [
		"effectiveGateCauses",
		"suppressedGateCauses",
	] as const) {
		if (value[field] !== undefined) {
			if (!Array.isArray(value[field]))
				throw new TypeError(`${field} must be an array`);
			decoded[field] = structuredClone(value[field]) as ReviewGateCause[];
		}
	}
	if (value.diagnostics !== undefined) {
		if (!Array.isArray(value.diagnostics))
			throw new TypeError("diagnostics must be an array");
		decoded.diagnostics = structuredClone(
			value.diagnostics,
		) as ClosureDiagnostic[];
	}
	return decoded;
}

export type ImplementationCompatibilityReason = "no_budget" | "mode_off";

export interface ImplementationPhaseMapping {
	id: string;
	heading: string;
}

export interface ImplementationDebtTarget {
	claimId: string;
	sourceLabel: string;
	phaseId: string;
}

/**
 * Immutable copy of an approved plan-review lineage. Plan snapshot readers
 * must ignore this kind. Binding does not capture a new baseline.
 */
export interface ImplementationBindingPayload {
	kind: "implementation-binding";
	version: typeof IMPLEMENTATION_STATE_VERSION;
	id: string;
	executionRunId: string;
	sourceRunId: string;
	sourceSnapshotId: string;
	sourceBaselineId: string;
	approvedPlanCommit: string;
	approvedPlanHash: string;
	approvedPlanBytes: string;
	b0: number;
	governingB: number;
	mode: Exclude<ReviewBudgetMode, "off">;
	thresholds: ReviewBudgetThresholds;
	ledger: ParsedDeliveryBudget;
	effectiveDecisions: unknown[];
	phaseMap: ImplementationPhaseMapping[];
	debtTargets: ImplementationDebtTarget[];
	ledgerHash: string;
	decisionsHash: string;
	createdAt: string;
}

export interface ImplementationCompatibilityPayload {
	kind: "implementation-compatibility";
	version: typeof IMPLEMENTATION_STATE_VERSION;
	id: string;
	executionRunId: string;
	reason: ImplementationCompatibilityReason;
	observedMode: ReviewBudgetMode;
	createdAt: string;
}

/** One guard-verified text amendment. The binding's approved hash stays put. */
export interface ImplementationTextAmendmentPayload {
	kind: "implementation-text-amendment";
	version: typeof IMPLEMENTATION_STATE_VERSION;
	id: string;
	bindingId: string;
	executionRunId: string;
	guardId: string;
	sourceObservationId: string;
	parentLineageId: string | null;
	beforeCommit: string;
	afterCommit: string;
	beforeBlobHash: string;
	afterBlobHash: string;
	authorizedPlanBytes: string;
	createdAt: string;
}

export function implementationBindingKey(runId: string): string {
	return `budget:implementation-binding:${runId}`;
}

export function implementationCompatibilityKey(runId: string): string {
	return `budget:implementation-compatibility:${runId}`;
}

export function implementationTextAmendmentKey(
	bindingId: string,
	amendmentId: string,
): string {
	return `budget:implementation-text-amendment:${bindingId}:${amendmentId}`;
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new TypeError(`${field} must be a positive integer`);
	}
	return value;
}

function versionField(value: unknown): typeof IMPLEMENTATION_STATE_VERSION {
	if (value !== IMPLEMENTATION_STATE_VERSION) {
		throw new TypeError(
			`unsupported implementation-state version ${String(value)}`,
		);
	}
	return IMPLEMENTATION_STATE_VERSION;
}

export function encodeImplementationBindingPayload(
	payload: ImplementationBindingPayload,
): unknown {
	return structuredClone(payload);
}

export function decodeImplementationBindingPayload(
	raw: unknown,
): ImplementationBindingPayload {
	const value = object(raw, "implementation binding payload");
	if (value.kind !== "implementation-binding") {
		throw new TypeError("invalid implementation binding kind");
	}
	versionField(value.version);
	if (value.mode !== "advisory" && value.mode !== "enforced") {
		throw new TypeError(
			"implementation binding mode must be advisory or enforced",
		);
	}
	if (!Array.isArray(value.effectiveDecisions)) {
		throw new TypeError("effectiveDecisions must be an array");
	}
	if (!Array.isArray(value.phaseMap) || !Array.isArray(value.debtTargets)) {
		throw new TypeError("phaseMap and debtTargets must be arrays");
	}
	const phaseMap = value.phaseMap.map((entry, index) => {
		const phase = object(entry, `phaseMap[${index}]`);
		return {
			id: stringField(phase.id, `phaseMap[${index}].id`),
			heading: stringField(phase.heading, `phaseMap[${index}].heading`, true),
		};
	});
	const debtTargets = value.debtTargets.map((entry, index) => {
		const target = object(entry, `debtTargets[${index}]`);
		return {
			claimId: stringField(target.claimId, `debtTargets[${index}].claimId`),
			sourceLabel: stringField(
				target.sourceLabel,
				`debtTargets[${index}].sourceLabel`,
			),
			phaseId: stringField(target.phaseId, `debtTargets[${index}].phaseId`),
		};
	});
	return {
		kind: "implementation-binding",
		version: IMPLEMENTATION_STATE_VERSION,
		id: stringField(value.id, "id"),
		executionRunId: stringField(value.executionRunId, "executionRunId"),
		sourceRunId: stringField(value.sourceRunId, "sourceRunId"),
		sourceSnapshotId: stringField(value.sourceSnapshotId, "sourceSnapshotId"),
		sourceBaselineId: stringField(value.sourceBaselineId, "sourceBaselineId"),
		approvedPlanCommit: stringField(
			value.approvedPlanCommit,
			"approvedPlanCommit",
		),
		approvedPlanHash: stringField(value.approvedPlanHash, "approvedPlanHash"),
		approvedPlanBytes: stringField(
			value.approvedPlanBytes,
			"approvedPlanBytes",
			true,
		),
		b0: positiveInteger(value.b0, "b0"),
		governingB: positiveInteger(value.governingB, "governingB"),
		mode: value.mode,
		thresholds: structuredClone(
			object(value.thresholds, "thresholds"),
		) as unknown as ReviewBudgetThresholds,
		ledger: structuredClone(
			object(value.ledger, "ledger"),
		) as unknown as ParsedDeliveryBudget,
		effectiveDecisions: structuredClone(value.effectiveDecisions),
		phaseMap,
		debtTargets,
		ledgerHash: stringField(value.ledgerHash, "ledgerHash"),
		decisionsHash: stringField(value.decisionsHash, "decisionsHash"),
		createdAt: stringField(value.createdAt, "createdAt"),
	};
}

export function encodeImplementationCompatibilityPayload(
	payload: ImplementationCompatibilityPayload,
): unknown {
	return structuredClone(payload);
}

export function decodeImplementationCompatibilityPayload(
	raw: unknown,
): ImplementationCompatibilityPayload {
	const value = object(raw, "implementation compatibility payload");
	if (value.kind !== "implementation-compatibility") {
		throw new TypeError("invalid implementation compatibility kind");
	}
	versionField(value.version);
	if (value.reason !== "no_budget" && value.reason !== "mode_off") {
		throw new TypeError("invalid implementation compatibility reason");
	}
	if (
		value.observedMode !== "off" &&
		value.observedMode !== "advisory" &&
		value.observedMode !== "enforced"
	) {
		throw new TypeError("invalid implementation compatibility mode");
	}
	return {
		kind: "implementation-compatibility",
		version: IMPLEMENTATION_STATE_VERSION,
		id: stringField(value.id, "id"),
		executionRunId: stringField(value.executionRunId, "executionRunId"),
		reason: value.reason,
		observedMode: value.observedMode,
		createdAt: stringField(value.createdAt, "createdAt"),
	};
}

export function encodeImplementationTextAmendmentPayload(
	payload: ImplementationTextAmendmentPayload,
): unknown {
	return structuredClone(payload);
}

export function decodeImplementationTextAmendmentPayload(
	raw: unknown,
): ImplementationTextAmendmentPayload {
	const value = object(raw, "implementation text amendment payload");
	if (value.kind !== "implementation-text-amendment") {
		throw new TypeError("invalid implementation text amendment kind");
	}
	versionField(value.version);
	return {
		kind: "implementation-text-amendment",
		version: IMPLEMENTATION_STATE_VERSION,
		id: stringField(value.id, "id"),
		bindingId: stringField(value.bindingId, "bindingId"),
		executionRunId: stringField(value.executionRunId, "executionRunId"),
		guardId: stringField(value.guardId, "guardId"),
		sourceObservationId: stringField(
			value.sourceObservationId,
			"sourceObservationId",
		),
		parentLineageId:
			value.parentLineageId === null
				? null
				: stringField(value.parentLineageId, "parentLineageId"),
		beforeCommit: stringField(value.beforeCommit, "beforeCommit"),
		afterCommit: stringField(value.afterCommit, "afterCommit"),
		beforeBlobHash: stringField(value.beforeBlobHash, "beforeBlobHash"),
		afterBlobHash: stringField(value.afterBlobHash, "afterBlobHash"),
		authorizedPlanBytes: stringField(
			value.authorizedPlanBytes,
			"authorizedPlanBytes",
			true,
		),
		createdAt: stringField(value.createdAt, "createdAt"),
	};
}
