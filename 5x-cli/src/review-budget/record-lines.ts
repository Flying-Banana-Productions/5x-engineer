import type { BoundaryChangeLabel, ReviewerVerdict } from "../protocol.js";
import type { TextAmendmentGuard } from "../review-governance/plan-amendment.js";
import type {
	ClosureDiagnostic,
	ImplementationDiagnostic,
	ImplementationNextAction,
	PlanReviewRoute,
	PriorFindingOutcome,
	ReviewGateCause,
} from "../review-governance/types.js";
import type {
	BaselineAssessment,
	BudgetAlert,
	BudgetBand,
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
	| "implementation-text-amendment"
	| "implementation-review-context"
	| "implementation-review"
	| "implementation-correction-attempt"
	| "implementation-credit-reconciliation";
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

/** One file-qualified hunk. `text` includes the `diff --git` header and the `@@` hunk. */
export interface ImplementationReviewHunk {
	oldPath: string;
	newPath: string;
	header: string;
	text: string;
	hash: string;
}

/**
 * Exact code range prepared before reviewer delegation. Immutable.
 * A later review-document commit does not rewrite these endpoints.
 */
export interface ImplementationReviewContextPayload {
	kind: "implementation-review-context";
	version: typeof IMPLEMENTATION_STATE_VERSION;
	id: string;
	executionRunId: string;
	bindingId: string;
	phase: string;
	previousReviewId?: string;
	baseCommit: string;
	reviewedCommit: string;
	patchHash: string;
	excludedPaths: string[];
	hunks: ImplementationReviewHunk[];
	binaryPaths: string[];
	createdAt: string;
}

export function implementationReviewContextKey(contextId: string): string {
	return `budget:implementation-review-context:${contextId}`;
}

export function encodeImplementationReviewContextPayload(
	payload: ImplementationReviewContextPayload,
): unknown {
	return structuredClone(payload);
}

export function decodeImplementationReviewContextPayload(
	raw: unknown,
): ImplementationReviewContextPayload {
	const value = object(raw, "implementation review context payload");
	if (value.kind !== "implementation-review-context") {
		throw new TypeError("invalid implementation review context kind");
	}
	versionField(value.version);
	if (!Array.isArray(value.excludedPaths) || !Array.isArray(value.hunks)) {
		throw new TypeError("excludedPaths and hunks must be arrays");
	}
	if (!Array.isArray(value.binaryPaths)) {
		throw new TypeError("binaryPaths must be an array");
	}
	const hunks = value.hunks.map((entry, index) => {
		const hunk = object(entry, `hunks[${index}]`);
		return {
			oldPath: stringField(hunk.oldPath, `hunks[${index}].oldPath`, true),
			newPath: stringField(hunk.newPath, `hunks[${index}].newPath`, true),
			header: stringField(hunk.header, `hunks[${index}].header`),
			text: stringField(hunk.text, `hunks[${index}].text`),
			hash: stringField(hunk.hash, `hunks[${index}].hash`),
		};
	});
	const previous =
		value.previousReviewId === undefined
			? undefined
			: stringField(value.previousReviewId, "previousReviewId");
	return {
		kind: "implementation-review-context",
		version: IMPLEMENTATION_STATE_VERSION,
		id: stringField(value.id, "id"),
		executionRunId: stringField(value.executionRunId, "executionRunId"),
		bindingId: stringField(value.bindingId, "bindingId"),
		phase: stringField(value.phase, "phase"),
		...(previous === undefined ? {} : { previousReviewId: previous }),
		baseCommit: stringField(value.baseCommit, "baseCommit"),
		reviewedCommit: stringField(value.reviewedCommit, "reviewedCommit"),
		patchHash: stringField(value.patchHash, "patchHash"),
		excludedPaths: value.excludedPaths.map((entry, index) =>
			stringField(entry, `excludedPaths[${index}]`, true),
		),
		hunks,
		binaryPaths: value.binaryPaths.map((entry, index) =>
			stringField(entry, `binaryPaths[${index}]`),
		),
		createdAt: stringField(value.createdAt, "createdAt"),
	};
}

export interface ImplementationReviewStepKey {
	stepName: string;
	phase: string | null;
	iteration: number | null;
}

/** Reviewer-stated claim result. Stored as an observation, not a budget finding. */
export interface ImplementationClaimObservation {
	creditClaimId: string;
	realization: "realized" | "partial" | "not_realized";
	realizedArchitectureDelta: number;
	evidence: string;
}

/**
 * Material causes kept beside the review route. An inherited budget gate does
 * not replace author revision for an ordinary defect.
 */
export type ImplementationObservationGateCause =
	| {
			kind: "semantic_human";
			findingId: string;
			fingerprint: string;
	  }
	| {
			kind: "critical_safety";
			findingId: string;
			fingerprint: string;
	  }
	| {
			kind: "plan_amendment";
			findingId: string;
			fingerprint: string;
	  }
	| {
			kind: "inherited_budget";
			band: BudgetBand;
			alerts: BudgetAlert[];
	  }
	| {
			kind: "credit_shortfall";
			claimIds: string[];
			claims: Array<{
				creditClaimId: string;
				approvedArchitectureDelta: number;
				realizedArchitectureDelta: number;
				evidence: string;
			}>;
	  }
	| {
			kind: "credit_unreconciled";
			claimIds: string[];
	  };

export interface ImplementationBoundaryInventoryEntry {
	itemId: string;
	/** Labels the reviewer supplied. Empty when that array was empty. */
	changes: BoundaryChangeLabel[];
	/** True when the reviewer omitted boundaryChanges. Never inferred. */
	unknown: boolean;
}

export interface ImplementationReviewClassCounts {
	implementation_defect: number;
	plan_defect: number;
	scope_expansion: number;
	pre_existing: number;
}

/** Activity and path growth. None of these fields are budget inputs. */
export interface ImplementationReviewTelemetry {
	reviewCycles: number;
	fixCycles: number;
	reviewOriginatedCommits: number;
	qualityReruns: number;
	classCounts: ImplementationReviewClassCounts;
	planAmendments: number;
	addedPaths: string[];
	boundaryInventory: ImplementationBoundaryInventoryEntry[];
	effortVariance: number;
	architectureVariance: number;
}

/** Inherited W/R/B/D copied at review time. Variance must not change them. */
export interface ImplementationBudgetInvariant {
	W: number;
	R: number;
	B: number;
	D: number;
}

/**
 * One implementation review, paired with its reviewer step. Plan snapshot
 * readers ignore this kind. It is not a `FindingDelta[]`.
 */
export interface ImplementationReviewObservationPayload {
	kind: "implementation-review";
	version: typeof IMPLEMENTATION_STATE_VERSION;
	id: string;
	runId: string;
	stepKey: ImplementationReviewStepKey;
	bindingId: string;
	contextId: string;
	domain: "implementation";
	phase: string;
	originalVerdict: ReviewerVerdict;
	outcomes: PriorFindingOutcome[];
	route: PlanReviewRoute;
	nextAction: ImplementationNextAction;
	diagnostics: ImplementationDiagnostic[];
	claimObservations: ImplementationClaimObservation[];
	gateCauses: ImplementationObservationGateCause[];
	telemetry: ImplementationReviewTelemetry;
	budgetInvariant: ImplementationBudgetInvariant;
	/**
	 * True only on the durable line when the route is complete and no separate
	 * gate cause remains. A pre-write copy is not authorization.
	 */
	completionAuthorized: boolean;
	/**
	 * Snapshotted before author delegation when text_only spans are authorized.
	 * Absent for design, budget, and ambiguous text-only routes.
	 */
	textGuard?: TextAmendmentGuard;
	createdAt: string;
}

export function implementationReviewObservationKey(
	runId: string,
	stepKey: ImplementationReviewStepKey,
): string {
	return `budget:implementation-review:${runId}:${stepKey.stepName}:${stepKey.phase ?? ""}:${stepKey.iteration ?? ""}`;
}

const REVIEW_ROUTES = new Set<PlanReviewRoute>([
	"complete",
	"author_revision",
	"final_corrections",
	"human_gate",
]);

const NEXT_ACTIONS = new Set<ImplementationNextAction>([
	"plan_amendment",
	"author_revision",
	"human_gate",
	"complete",
]);

const BUDGET_BANDS = new Set<BudgetBand>([
	"within_standard",
	"within_debt_allowance",
	"over_effective",
	"over_absolute",
]);

const BUDGET_ALERTS = new Set<BudgetAlert>([
	"baseline_disputed",
	"positive_architecture_exceeded",
	"credit_unrealized",
]);

const BOUNDARY_LABELS = new Set<BoundaryChangeLabel>([
	"api",
	"schema",
	"dependency",
	"subsystem",
	"architecture",
	"plan-structure",
]);

const OBSERVATION_KEYS = new Set([
	"kind",
	"version",
	"id",
	"runId",
	"stepKey",
	"bindingId",
	"contextId",
	"domain",
	"phase",
	"originalVerdict",
	"outcomes",
	"route",
	"nextAction",
	"diagnostics",
	"claimObservations",
	"gateCauses",
	"telemetry",
	"budgetInvariant",
	"completionAuthorized",
	"textGuard",
	"createdAt",
]);

function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	label: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			throw new TypeError(`${label} has unknown field '${key}'`);
		}
	}
}

function integerField(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new TypeError(`${field} must be an integer`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
	const parsed = integerField(value, field);
	if (parsed < 0) throw new TypeError(`${field} must be a nonnegative integer`);
	return parsed;
}

function booleanField(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new TypeError(`${field} must be a boolean`);
	}
	return value;
}

function decodeObservationStepKey(raw: unknown): ImplementationReviewStepKey {
	const value = object(raw, "stepKey");
	rejectUnknownKeys(
		value,
		new Set(["stepName", "phase", "iteration"]),
		"stepKey",
	);
	const iteration = value.iteration;
	if (iteration !== null && !Number.isInteger(iteration)) {
		throw new TypeError("stepKey.iteration must be an integer or null");
	}
	const phase = value.phase;
	if (phase !== null && typeof phase !== "string") {
		throw new TypeError("stepKey.phase must be a string or null");
	}
	return {
		stepName: stringField(value.stepName, "stepKey.stepName"),
		phase,
		iteration: iteration as number | null,
	};
}

function decodeOriginalVerdict(raw: unknown): ReviewerVerdict {
	const value = object(raw, "originalVerdict");
	if (typeof value.readiness !== "string" || !Array.isArray(value.items)) {
		throw new TypeError("originalVerdict must include readiness and items");
	}
	return structuredClone(value) as unknown as ReviewerVerdict;
}

function decodeOutcomes(raw: unknown): PriorFindingOutcome[] {
	if (!Array.isArray(raw)) throw new TypeError("outcomes must be an array");
	return raw.map((entry, index) => {
		const outcome = object(entry, `outcomes[${index}]`);
		const status = outcome.status;
		if (
			status !== "addressed" &&
			status !== "partially_addressed" &&
			status !== "still_open"
		) {
			throw new TypeError(`outcomes[${index}].status is invalid`);
		}
		return {
			id: stringField(outcome.id, `outcomes[${index}].id`),
			status,
		};
	});
}

function decodeObservationDiagnostics(
	raw: unknown,
): ImplementationDiagnostic[] {
	if (!Array.isArray(raw)) throw new TypeError("diagnostics must be an array");
	return raw.map((entry, index) => {
		const diagnostic = object(entry, `diagnostics[${index}]`);
		const severity = diagnostic.severity;
		if (severity !== "error" && severity !== "info") {
			throw new TypeError(`diagnostics[${index}].severity is invalid`);
		}
		const itemId =
			diagnostic.itemId === undefined
				? undefined
				: stringField(diagnostic.itemId, `diagnostics[${index}].itemId`);
		return {
			code: stringField(
				diagnostic.code,
				`diagnostics[${index}].code`,
			) as ImplementationDiagnostic["code"],
			severity,
			message: stringField(diagnostic.message, `diagnostics[${index}].message`),
			...(itemId === undefined ? {} : { itemId }),
		};
	});
}

function decodeClaimObservations(
	raw: unknown,
): ImplementationClaimObservation[] {
	if (!Array.isArray(raw)) {
		throw new TypeError("claimObservations must be an array");
	}
	return raw.map((entry, index) => {
		const claim = object(entry, `claimObservations[${index}]`);
		const realization = claim.realization;
		if (
			realization !== "realized" &&
			realization !== "partial" &&
			realization !== "not_realized"
		) {
			throw new TypeError(`claimObservations[${index}].realization is invalid`);
		}
		return {
			creditClaimId: stringField(
				claim.creditClaimId,
				`claimObservations[${index}].creditClaimId`,
			),
			realization,
			realizedArchitectureDelta: integerField(
				claim.realizedArchitectureDelta,
				`claimObservations[${index}].realizedArchitectureDelta`,
			),
			evidence: stringField(
				claim.evidence,
				`claimObservations[${index}].evidence`,
			),
		};
	});
}

function decodeObservationGateCause(
	raw: unknown,
	index: number,
): ImplementationObservationGateCause {
	const cause = object(raw, `gateCauses[${index}]`);
	if (
		cause.kind === "semantic_human" ||
		cause.kind === "critical_safety" ||
		cause.kind === "plan_amendment"
	) {
		return {
			kind: cause.kind,
			findingId: stringField(cause.findingId, `gateCauses[${index}].findingId`),
			fingerprint: stringField(
				cause.fingerprint,
				`gateCauses[${index}].fingerprint`,
			),
		};
	}
	if (cause.kind === "inherited_budget") {
		if (!BUDGET_BANDS.has(cause.band as BudgetBand)) {
			throw new TypeError(`gateCauses[${index}].band is invalid`);
		}
		if (!Array.isArray(cause.alerts)) {
			throw new TypeError(`gateCauses[${index}].alerts must be an array`);
		}
		return {
			kind: "inherited_budget",
			band: cause.band as BudgetBand,
			alerts: cause.alerts.map((alert, alertIndex) => {
				if (!BUDGET_ALERTS.has(alert as BudgetAlert)) {
					throw new TypeError(
						`gateCauses[${index}].alerts[${alertIndex}] is invalid`,
					);
				}
				return alert as BudgetAlert;
			}),
		};
	}
	if (cause.kind === "credit_shortfall") {
		if (!Array.isArray(cause.claimIds) || !Array.isArray(cause.claims)) {
			throw new TypeError(
				`gateCauses[${index}] credit_shortfall requires claimIds and claims`,
			);
		}
		return {
			kind: "credit_shortfall",
			claimIds: cause.claimIds.map((entry, claimIndex) =>
				stringField(entry, `gateCauses[${index}].claimIds[${claimIndex}]`),
			),
			claims: cause.claims.map((entry, claimIndex) => {
				const claim = object(
					entry,
					`gateCauses[${index}].claims[${claimIndex}]`,
				);
				return {
					creditClaimId: stringField(
						claim.creditClaimId,
						`gateCauses[${index}].claims[${claimIndex}].creditClaimId`,
					),
					approvedArchitectureDelta: integerField(
						claim.approvedArchitectureDelta,
						`gateCauses[${index}].claims[${claimIndex}].approvedArchitectureDelta`,
					),
					realizedArchitectureDelta: integerField(
						claim.realizedArchitectureDelta,
						`gateCauses[${index}].claims[${claimIndex}].realizedArchitectureDelta`,
					),
					evidence: stringField(
						claim.evidence,
						`gateCauses[${index}].claims[${claimIndex}].evidence`,
						true,
					),
				};
			}),
		};
	}
	if (cause.kind === "credit_unreconciled") {
		if (!Array.isArray(cause.claimIds)) {
			throw new TypeError(`gateCauses[${index}].claimIds must be an array`);
		}
		return {
			kind: "credit_unreconciled",
			claimIds: cause.claimIds.map((entry, claimIndex) =>
				stringField(entry, `gateCauses[${index}].claimIds[${claimIndex}]`),
			),
		};
	}
	throw new TypeError(`gateCauses[${index}].kind is invalid`);
}

function decodeClassCounts(raw: unknown): ImplementationReviewClassCounts {
	const value = object(raw, "telemetry.classCounts");
	return {
		implementation_defect: nonNegativeInteger(
			value.implementation_defect,
			"telemetry.classCounts.implementation_defect",
		),
		plan_defect: nonNegativeInteger(
			value.plan_defect,
			"telemetry.classCounts.plan_defect",
		),
		scope_expansion: nonNegativeInteger(
			value.scope_expansion,
			"telemetry.classCounts.scope_expansion",
		),
		pre_existing: nonNegativeInteger(
			value.pre_existing,
			"telemetry.classCounts.pre_existing",
		),
	};
}

function decodeObservationTelemetry(
	raw: unknown,
): ImplementationReviewTelemetry {
	const value = object(raw, "telemetry");
	if (!Array.isArray(value.addedPaths)) {
		throw new TypeError("telemetry.addedPaths must be an array");
	}
	if (!Array.isArray(value.boundaryInventory)) {
		throw new TypeError("telemetry.boundaryInventory must be an array");
	}
	return {
		reviewCycles: nonNegativeInteger(
			value.reviewCycles,
			"telemetry.reviewCycles",
		),
		fixCycles: nonNegativeInteger(value.fixCycles, "telemetry.fixCycles"),
		reviewOriginatedCommits: nonNegativeInteger(
			value.reviewOriginatedCommits,
			"telemetry.reviewOriginatedCommits",
		),
		qualityReruns: nonNegativeInteger(
			value.qualityReruns,
			"telemetry.qualityReruns",
		),
		classCounts: decodeClassCounts(value.classCounts),
		planAmendments: nonNegativeInteger(
			value.planAmendments,
			"telemetry.planAmendments",
		),
		addedPaths: value.addedPaths.map((entry, index) =>
			stringField(entry, `telemetry.addedPaths[${index}]`, true),
		),
		boundaryInventory: value.boundaryInventory.map((entry, index) => {
			const item = object(entry, `telemetry.boundaryInventory[${index}]`);
			if (!Array.isArray(item.changes)) {
				throw new TypeError(
					`telemetry.boundaryInventory[${index}].changes must be an array`,
				);
			}
			return {
				itemId: stringField(
					item.itemId,
					`telemetry.boundaryInventory[${index}].itemId`,
				),
				changes: item.changes.map((change, changeIndex) => {
					if (!BOUNDARY_LABELS.has(change as BoundaryChangeLabel)) {
						throw new TypeError(
							`telemetry.boundaryInventory[${index}].changes[${changeIndex}] is invalid`,
						);
					}
					return change as BoundaryChangeLabel;
				}),
				unknown: booleanField(
					item.unknown,
					`telemetry.boundaryInventory[${index}].unknown`,
				),
			};
		}),
		effortVariance: nonNegativeInteger(
			value.effortVariance,
			"telemetry.effortVariance",
		),
		architectureVariance: integerField(
			value.architectureVariance,
			"telemetry.architectureVariance",
		),
	};
}

function decodeBudgetInvariant(raw: unknown): ImplementationBudgetInvariant {
	const value = object(raw, "budgetInvariant");
	rejectUnknownKeys(value, new Set(["W", "R", "B", "D"]), "budgetInvariant");
	return {
		W: nonNegativeInteger(value.W, "budgetInvariant.W"),
		R: nonNegativeInteger(value.R, "budgetInvariant.R"),
		B: nonNegativeInteger(value.B, "budgetInvariant.B"),
		D: nonNegativeInteger(value.D, "budgetInvariant.D"),
	};
}

function decodeTextGuard(raw: unknown): TextAmendmentGuard {
	const value = object(raw, "textGuard");
	rejectUnknownKeys(
		value,
		new Set([
			"id",
			"anchorCommit",
			"anchorBlobHash",
			"parentLineageId",
			"tableBytes",
			"allowedSpans",
			"structuralSignature",
			"anchorBytes",
		]),
		"textGuard",
	);
	if (!Array.isArray(value.allowedSpans)) {
		throw new TypeError("textGuard.allowedSpans must be an array");
	}
	const parent = value.parentLineageId;
	return {
		id: stringField(value.id, "textGuard.id"),
		anchorCommit: stringField(value.anchorCommit, "textGuard.anchorCommit"),
		anchorBlobHash: stringField(
			value.anchorBlobHash,
			"textGuard.anchorBlobHash",
		),
		parentLineageId:
			parent === null ? null : stringField(parent, "textGuard.parentLineageId"),
		tableBytes: stringField(value.tableBytes, "textGuard.tableBytes", true),
		allowedSpans: value.allowedSpans.map((entry, index) => {
			const span = object(entry, `textGuard.allowedSpans[${index}]`);
			rejectUnknownKeys(
				span,
				new Set(["itemId", "heading", "staleText", "start", "end"]),
				`textGuard.allowedSpans[${index}]`,
			);
			return {
				itemId: stringField(
					span.itemId,
					`textGuard.allowedSpans[${index}].itemId`,
				),
				heading: stringField(
					span.heading,
					`textGuard.allowedSpans[${index}].heading`,
				),
				staleText: stringField(
					span.staleText,
					`textGuard.allowedSpans[${index}].staleText`,
				),
				start: nonNegativeInteger(
					span.start,
					`textGuard.allowedSpans[${index}].start`,
				),
				end: nonNegativeInteger(
					span.end,
					`textGuard.allowedSpans[${index}].end`,
				),
			};
		}),
		structuralSignature: stringField(
			value.structuralSignature,
			"textGuard.structuralSignature",
		),
		anchorBytes: stringField(value.anchorBytes, "textGuard.anchorBytes", true),
	};
}

export function encodeImplementationReviewObservationPayload(
	payload: ImplementationReviewObservationPayload,
): unknown {
	return structuredClone(payload);
}

export function decodeImplementationReviewObservationPayload(
	raw: unknown,
): ImplementationReviewObservationPayload {
	const value = object(raw, "implementation review observation");
	rejectUnknownKeys(
		value,
		OBSERVATION_KEYS,
		"implementation review observation",
	);
	if (value.kind !== "implementation-review") {
		throw new TypeError("invalid implementation review observation kind");
	}
	versionField(value.version);
	if (value.domain !== "implementation") {
		throw new TypeError("implementation review domain must be implementation");
	}
	if (!REVIEW_ROUTES.has(value.route as PlanReviewRoute)) {
		throw new TypeError("implementation review route is invalid");
	}
	if (!NEXT_ACTIONS.has(value.nextAction as ImplementationNextAction)) {
		throw new TypeError("implementation review nextAction is invalid");
	}
	if (!Array.isArray(value.gateCauses)) {
		throw new TypeError("gateCauses must be an array");
	}
	return {
		kind: "implementation-review",
		version: IMPLEMENTATION_STATE_VERSION,
		id: stringField(value.id, "id"),
		runId: stringField(value.runId, "runId"),
		stepKey: decodeObservationStepKey(value.stepKey),
		bindingId: stringField(value.bindingId, "bindingId"),
		contextId: stringField(value.contextId, "contextId"),
		domain: "implementation",
		phase: stringField(value.phase, "phase"),
		originalVerdict: decodeOriginalVerdict(value.originalVerdict),
		outcomes: decodeOutcomes(value.outcomes),
		route: value.route as PlanReviewRoute,
		nextAction: value.nextAction as ImplementationNextAction,
		diagnostics: decodeObservationDiagnostics(value.diagnostics),
		claimObservations: decodeClaimObservations(value.claimObservations),
		gateCauses: value.gateCauses.map((entry, index) =>
			decodeObservationGateCause(entry, index),
		),
		telemetry: decodeObservationTelemetry(value.telemetry),
		budgetInvariant: decodeBudgetInvariant(value.budgetInvariant),
		completionAuthorized: booleanField(
			value.completionAuthorized,
			"completionAuthorized",
		),
		...(value.textGuard === undefined
			? {}
			: { textGuard: decodeTextGuard(value.textGuard) }),
		createdAt: stringField(value.createdAt, "createdAt"),
	};
}

export type CorrectionAttemptOutcome = "passed" | "failed" | "invalidated";

export interface CorrectionQualityGateResult {
	command: string;
	passed: boolean;
	durationMs: number;
	timedOut: boolean;
}

/**
 * One CLI quality attempt for an eligible implementation correction.
 * A passing line is proof only when `shortcutInvalidated` is false and the
 * inventory fields are the explicit zero-delta proof. It is not a plan snapshot.
 */
export interface ImplementationCorrectionAttemptPayload {
	kind: "implementation-correction-attempt";
	version: typeof IMPLEMENTATION_STATE_VERSION;
	id: string;
	runId: string;
	observationId: string;
	phase: string;
	bindingId: string;
	authorCommit: string;
	tree: string;
	qualityConfigDigest: string;
	executionDirectory: string;
	outcome: CorrectionAttemptOutcome;
	shortcutInvalidated: boolean;
	reason: string;
	qualityPassed: boolean;
	qualitySkipped: boolean;
	qualityTimedOut: boolean;
	qualityResults: CorrectionQualityGateResult[];
	architectureDelta: number;
	boundaryChanges: BoundaryChangeLabel[];
	changedPaths: string[];
	inventoryClean: boolean;
	boundaryUncertain: boolean;
	sourceObservationId: string;
	assessedCommit: string;
	destinationCommit: string;
	carriedClaims: ImplementationClaimObservation[];
	qualityRerun: number;
	createdAt: string;
}

export function implementationCorrectionAttemptKey(
	runId: string,
	attemptId: string,
): string {
	return `budget:implementation-correction-attempt:${runId}:${attemptId}`;
}

const CORRECTION_OUTCOMES = new Set<CorrectionAttemptOutcome>([
	"passed",
	"failed",
	"invalidated",
]);

const CORRECTION_ATTEMPT_KEYS = new Set([
	"kind",
	"version",
	"id",
	"runId",
	"observationId",
	"phase",
	"bindingId",
	"authorCommit",
	"tree",
	"qualityConfigDigest",
	"executionDirectory",
	"outcome",
	"shortcutInvalidated",
	"reason",
	"qualityPassed",
	"qualitySkipped",
	"qualityTimedOut",
	"qualityResults",
	"architectureDelta",
	"boundaryChanges",
	"changedPaths",
	"inventoryClean",
	"boundaryUncertain",
	"sourceObservationId",
	"assessedCommit",
	"destinationCommit",
	"carriedClaims",
	"qualityRerun",
	"createdAt",
]);

export function encodeImplementationCorrectionAttemptPayload(
	payload: ImplementationCorrectionAttemptPayload,
): unknown {
	return structuredClone(payload);
}

export function decodeImplementationCorrectionAttemptPayload(
	raw: unknown,
): ImplementationCorrectionAttemptPayload {
	const value = object(raw, "implementation correction attempt");
	rejectUnknownKeys(
		value,
		CORRECTION_ATTEMPT_KEYS,
		"implementation correction attempt",
	);
	if (value.kind !== "implementation-correction-attempt") {
		throw new TypeError("invalid implementation correction attempt kind");
	}
	versionField(value.version);
	if (!CORRECTION_OUTCOMES.has(value.outcome as CorrectionAttemptOutcome)) {
		throw new TypeError("implementation correction outcome is invalid");
	}
	if (!Array.isArray(value.qualityResults)) {
		throw new TypeError("qualityResults must be an array");
	}
	if (!Array.isArray(value.boundaryChanges)) {
		throw new TypeError("boundaryChanges must be an array");
	}
	if (!Array.isArray(value.changedPaths)) {
		throw new TypeError("changedPaths must be an array");
	}
	return {
		kind: "implementation-correction-attempt",
		version: IMPLEMENTATION_STATE_VERSION,
		id: stringField(value.id, "id"),
		runId: stringField(value.runId, "runId"),
		observationId: stringField(value.observationId, "observationId"),
		phase: stringField(value.phase, "phase"),
		bindingId: stringField(value.bindingId, "bindingId"),
		authorCommit: stringField(value.authorCommit, "authorCommit"),
		tree: stringField(value.tree, "tree"),
		qualityConfigDigest: stringField(
			value.qualityConfigDigest,
			"qualityConfigDigest",
		),
		executionDirectory: stringField(
			value.executionDirectory,
			"executionDirectory",
		),
		outcome: value.outcome as CorrectionAttemptOutcome,
		shortcutInvalidated: booleanField(
			value.shortcutInvalidated,
			"shortcutInvalidated",
		),
		reason: stringField(value.reason, "reason", true),
		qualityPassed: booleanField(value.qualityPassed, "qualityPassed"),
		qualitySkipped: booleanField(value.qualitySkipped, "qualitySkipped"),
		qualityTimedOut: booleanField(value.qualityTimedOut, "qualityTimedOut"),
		qualityResults: value.qualityResults.map((entry, index) => {
			const result = object(entry, `qualityResults[${index}]`);
			rejectUnknownKeys(
				result,
				new Set(["command", "passed", "durationMs", "timedOut"]),
				`qualityResults[${index}]`,
			);
			return {
				command: stringField(
					result.command,
					`qualityResults[${index}].command`,
				),
				passed: booleanField(result.passed, `qualityResults[${index}].passed`),
				durationMs: nonNegativeInteger(
					result.durationMs,
					`qualityResults[${index}].durationMs`,
				),
				timedOut: booleanField(
					result.timedOut,
					`qualityResults[${index}].timedOut`,
				),
			};
		}),
		architectureDelta: integerField(
			value.architectureDelta,
			"architectureDelta",
		),
		boundaryChanges: value.boundaryChanges.map((entry, index) => {
			const label = stringField(entry, `boundaryChanges[${index}]`);
			if (!BOUNDARY_LABELS.has(label as BoundaryChangeLabel)) {
				throw new TypeError(`boundaryChanges[${index}] is invalid`);
			}
			return label as BoundaryChangeLabel;
		}),
		changedPaths: value.changedPaths.map((entry, index) =>
			stringField(entry, `changedPaths[${index}]`),
		),
		inventoryClean: booleanField(value.inventoryClean, "inventoryClean"),
		boundaryUncertain: booleanField(
			value.boundaryUncertain,
			"boundaryUncertain",
		),
		sourceObservationId: stringField(
			value.sourceObservationId,
			"sourceObservationId",
		),
		assessedCommit: stringField(value.assessedCommit, "assessedCommit"),
		destinationCommit: stringField(
			value.destinationCommit,
			"destinationCommit",
		),
		carriedClaims: decodeClaimObservations(value.carriedClaims),
		qualityRerun: nonNegativeInteger(value.qualityRerun, "qualityRerun"),
		createdAt: stringField(value.createdAt, "createdAt"),
	};
}

export type CreditReconciliationClaimStatus =
	| "realized"
	| "partial"
	| "not_realized"
	| "pending"
	| "waived"
	| "future";

/** Measured post-state plus the approved envelope after waivers. */
export interface ImplementationCreditClaimRecord {
	creditClaimId: string;
	phaseId: string;
	status: CreditReconciliationClaimStatus;
	approvedArchitectureDelta: number;
	effectiveApprovedMagnitude: number;
	realizedArchitectureDelta: number | null;
	evidence: string | null;
	assessedCommit: string | null;
	sourceObservationId: string | null;
	carried: boolean;
	waiverDecisionId: string | null;
}

export interface ImplementationCreditBudgetSnapshot {
	W: number;
	R: number;
	B: number;
	P: number;
	N: number;
	D: number;
	E: number;
	S: number;
	A: number;
	provisionalCredit: number;
	realizedCredit: number;
	budgetBand: BudgetBand;
	budgetAlerts: BudgetAlert[];
	requiresHuman: boolean;
}

/**
 * Immutable credit fold coupled to one reviewer step. A later restoration
 * appends another record; it does not rewrite this one.
 */
export interface ImplementationCreditReconciliationPayload {
	kind: "implementation-credit-reconciliation";
	version: typeof IMPLEMENTATION_STATE_VERSION;
	id: string;
	runId: string;
	stepKey: ImplementationReviewStepKey;
	bindingId: string;
	observationId: string;
	phase: string;
	reviewedCommit: string;
	claims: ImplementationCreditClaimRecord[];
	pendingClaimIds: string[];
	/** Predecessor reconciliation record. Never an observation id. */
	supersedesId: string | null;
	/** Observation a restoration supersedes. History stays on that observation. */
	supersedesObservationId: string | null;
	budget: ImplementationCreditBudgetSnapshot;
	creditUnrealized: boolean;
	material: boolean;
	completionSatisfied: boolean;
	createdAt: string;
}

export function implementationCreditReconciliationKey(
	runId: string,
	stepKey: ImplementationReviewStepKey,
): string {
	return `budget:implementation-credit-reconciliation:${runId}:${stepKey.stepName}:${stepKey.phase ?? ""}:${stepKey.iteration ?? ""}`;
}

const CREDIT_CLAIM_STATUSES = new Set<CreditReconciliationClaimStatus>([
	"realized",
	"partial",
	"not_realized",
	"pending",
	"waived",
	"future",
]);

const CREDIT_RECONCILIATION_KEYS = new Set([
	"kind",
	"version",
	"id",
	"runId",
	"stepKey",
	"bindingId",
	"observationId",
	"phase",
	"reviewedCommit",
	"claims",
	"pendingClaimIds",
	"supersedesId",
	"supersedesObservationId",
	"budget",
	"creditUnrealized",
	"material",
	"completionSatisfied",
	"createdAt",
]);

export function encodeImplementationCreditReconciliationPayload(
	payload: ImplementationCreditReconciliationPayload,
): unknown {
	return structuredClone(payload);
}

function decodeCreditClaim(
	raw: unknown,
	index: number,
): ImplementationCreditClaimRecord {
	const claim = object(raw, `claims[${index}]`);
	if (
		!CREDIT_CLAIM_STATUSES.has(claim.status as CreditReconciliationClaimStatus)
	) {
		throw new TypeError(`claims[${index}].status is invalid`);
	}
	const realized = claim.realizedArchitectureDelta;
	if (realized !== null && !Number.isInteger(realized)) {
		throw new TypeError(
			`claims[${index}].realizedArchitectureDelta must be an integer or null`,
		);
	}
	return {
		creditClaimId: stringField(
			claim.creditClaimId,
			`claims[${index}].creditClaimId`,
		),
		phaseId: stringField(claim.phaseId, `claims[${index}].phaseId`),
		status: claim.status as CreditReconciliationClaimStatus,
		approvedArchitectureDelta: integerField(
			claim.approvedArchitectureDelta,
			`claims[${index}].approvedArchitectureDelta`,
		),
		effectiveApprovedMagnitude: nonNegativeInteger(
			claim.effectiveApprovedMagnitude,
			`claims[${index}].effectiveApprovedMagnitude`,
		),
		realizedArchitectureDelta: realized as number | null,
		evidence:
			claim.evidence === null
				? null
				: stringField(claim.evidence, `claims[${index}].evidence`, true),
		assessedCommit:
			claim.assessedCommit === null
				? null
				: stringField(claim.assessedCommit, `claims[${index}].assessedCommit`),
		sourceObservationId:
			claim.sourceObservationId === null
				? null
				: stringField(
						claim.sourceObservationId,
						`claims[${index}].sourceObservationId`,
					),
		carried: booleanField(claim.carried, `claims[${index}].carried`),
		waiverDecisionId:
			claim.waiverDecisionId === null
				? null
				: stringField(
						claim.waiverDecisionId,
						`claims[${index}].waiverDecisionId`,
					),
	};
}

function decodeCreditBudget(raw: unknown): ImplementationCreditBudgetSnapshot {
	const value = object(raw, "budget");
	if (!BUDGET_BANDS.has(value.budgetBand as BudgetBand)) {
		throw new TypeError("budget.budgetBand is invalid");
	}
	if (!Array.isArray(value.budgetAlerts)) {
		throw new TypeError("budget.budgetAlerts must be an array");
	}
	return {
		W: nonNegativeInteger(value.W, "budget.W"),
		R: integerField(value.R, "budget.R"),
		B: nonNegativeInteger(value.B, "budget.B"),
		P: integerField(value.P, "budget.P"),
		N: nonNegativeInteger(value.N, "budget.N"),
		D: nonNegativeInteger(value.D, "budget.D"),
		E: nonNegativeInteger(value.E, "budget.E"),
		S: nonNegativeInteger(value.S, "budget.S"),
		A: nonNegativeInteger(value.A, "budget.A"),
		provisionalCredit: nonNegativeInteger(
			value.provisionalCredit,
			"budget.provisionalCredit",
		),
		realizedCredit: nonNegativeInteger(
			value.realizedCredit,
			"budget.realizedCredit",
		),
		budgetBand: value.budgetBand as BudgetBand,
		budgetAlerts: value.budgetAlerts.map((alert, index) => {
			if (!BUDGET_ALERTS.has(alert as BudgetAlert)) {
				throw new TypeError(`budget.budgetAlerts[${index}] is invalid`);
			}
			return alert as BudgetAlert;
		}),
		requiresHuman: booleanField(value.requiresHuman, "budget.requiresHuman"),
	};
}

export function decodeImplementationCreditReconciliationPayload(
	raw: unknown,
): ImplementationCreditReconciliationPayload {
	const value = object(raw, "implementation credit reconciliation");
	rejectUnknownKeys(
		value,
		CREDIT_RECONCILIATION_KEYS,
		"implementation credit reconciliation",
	);
	if (value.kind !== "implementation-credit-reconciliation") {
		throw new TypeError("invalid implementation credit reconciliation kind");
	}
	versionField(value.version);
	if (!Array.isArray(value.claims) || !Array.isArray(value.pendingClaimIds)) {
		throw new TypeError("claims and pendingClaimIds must be arrays");
	}
	return {
		kind: "implementation-credit-reconciliation",
		version: IMPLEMENTATION_STATE_VERSION,
		id: stringField(value.id, "id"),
		runId: stringField(value.runId, "runId"),
		stepKey: decodeObservationStepKey(value.stepKey),
		bindingId: stringField(value.bindingId, "bindingId"),
		observationId: stringField(value.observationId, "observationId"),
		phase: stringField(value.phase, "phase"),
		reviewedCommit: stringField(value.reviewedCommit, "reviewedCommit"),
		claims: value.claims.map((entry, index) => decodeCreditClaim(entry, index)),
		pendingClaimIds: value.pendingClaimIds.map((entry, index) =>
			stringField(entry, `pendingClaimIds[${index}]`),
		),
		supersedesId:
			value.supersedesId === null
				? null
				: stringField(value.supersedesId, "supersedesId"),
		supersedesObservationId:
			value.supersedesObservationId == null
				? null
				: stringField(
						value.supersedesObservationId,
						"supersedesObservationId",
					),
		budget: decodeCreditBudget(value.budget),
		creditUnrealized: booleanField(value.creditUnrealized, "creditUnrealized"),
		material: booleanField(value.material, "material"),
		completionSatisfied: booleanField(
			value.completionSatisfied,
			"completionSatisfied",
		),
		createdAt: stringField(value.createdAt, "createdAt"),
	};
}
