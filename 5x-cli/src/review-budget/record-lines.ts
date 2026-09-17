import type {
	BaselineAssessment,
	CreditAssessmentInput,
	FindingDelta,
	ParsedDeliveryBudget,
	ReviewBudgetThresholds,
	SurfaceSnapshot,
} from "./types.js";

export type BudgetRecordKind = "baseline" | "snapshot";
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
	return decoded;
}
