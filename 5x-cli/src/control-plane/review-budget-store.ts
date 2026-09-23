import { sumEffort } from "../review-budget/arithmetic.js";
import {
	baselineIdempotencyKey,
	type CaptureKind,
	decodeBudgetBaselinePayload,
	decodeBudgetSnapshotPayload,
	encodeBudgetBaselinePayload,
	encodeBudgetSnapshotPayload,
	snapshotIdempotencyKey,
} from "../review-budget/record-lines.js";
import type {
	BaselineAssessment,
	CreditAssessmentInput,
	DerivedBudgetResult,
	FindingDelta,
	ParsedDeliveryBudget,
	ReviewBudgetMode,
	ReviewBudgetThresholds,
	SurfaceSnapshot,
} from "../review-budget/types.js";
import type {
	ClosureDiagnostic,
	PriorFindingOutcome,
	ReviewGateCause,
} from "../review-governance/types.js";
import { createReviewBudgetId } from "./ids.js";
import type { RecordStore } from "./record-store.js";
import { type RecordOrigin, recordedEnvelope } from "./record-types.js";
import type { ReviewBudgetIndex } from "./review-budget-index.js";

export interface ReviewBudgetBaseline {
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

export interface ReviewBudgetSnapshotRecord {
	id: string;
	runId: string;
	phase: string | null;
	iteration: number | null;
	stepName?: string;
	currentLedger: ParsedDeliveryBudget;
	findings: FindingDelta[];
	assessments: CreditAssessmentInput[];
	baselineAssessment?: BaselineAssessment;
	priorFindings: PriorFindingOutcome[];
	derived: DerivedBudgetResult | null;
	effectiveGateCauses: ReviewGateCause[];
	suppressedGateCauses: ReviewGateCause[];
	diagnostics: ClosureDiagnostic[];
	createdAt: string;
}

export interface CaptureBaselineInput {
	runId: string;
	captureKind: CaptureKind;
	parsed: ParsedDeliveryBudget;
	originalSection?: string;
	configSnapshot: ReviewBudgetThresholds;
	mode: Exclude<ReviewBudgetMode, "off">;
	origin: RecordOrigin;
}

export type CaptureBaselineResult =
	| { ok: true; created: true; baseline: ReviewBudgetBaseline }
	| { ok: true; created: false; baseline: ReviewBudgetBaseline };

export interface AppendSnapshotInput {
	runId: string;
	stepName: string;
	phase?: string;
	iteration?: number;
	currentLedger: ParsedDeliveryBudget;
	findings: FindingDelta[];
	assessments: CreditAssessmentInput[];
	baselineAssessment?: BaselineAssessment;
	priorFindings?: PriorFindingOutcome[];
	derived?: DerivedBudgetResult;
	effectiveGateCauses?: ReviewGateCause[];
	suppressedGateCauses?: ReviewGateCause[];
	diagnostics?: ClosureDiagnostic[];
	/** Optional for the Phase 4 utility; otherwise the baseline line origin is reused. */
	origin?: RecordOrigin;
}

export interface ReviewBudgetStore {
	getBaseline(runId: string): ReviewBudgetBaseline | null;
	captureBaseline(input: CaptureBaselineInput): CaptureBaselineResult;
	appendSnapshot(input: AppendSnapshotInput): ReviewBudgetSnapshotRecord;
	latestSnapshot(runId: string): ReviewBudgetSnapshotRecord | null;
	listSnapshots(runId: string): ReviewBudgetSnapshotRecord[];
	/** Rebuild one snapshot projection from its authoritative record line. */
	projectSnapshot(
		runId: string,
		idempotencyKey: string,
		derived?: DerivedBudgetResult,
	): ReviewBudgetSnapshotRecord | null;
}

function baselineRecord(raw: unknown): ReviewBudgetBaseline {
	const payload = decodeBudgetBaselinePayload(raw);
	return {
		id: payload.id,
		runId: payload.runId,
		captureKind: payload.captureKind,
		b0: payload.b0,
		b: payload.b,
		originalLedger: payload.originalLedger,
		surface: payload.surface,
		originalSection: payload.originalSection,
		configSnapshot: payload.configSnapshot,
		mode: payload.mode,
		createdAt: payload.createdAt,
	};
}

function snapshotRecord(
	raw: unknown,
	derived: DerivedBudgetResult | null = null,
): ReviewBudgetSnapshotRecord {
	const payload = decodeBudgetSnapshotPayload(raw);
	return {
		id: payload.id,
		runId: payload.runId,
		stepName: payload.stepKey.stepName,
		phase: payload.stepKey.phase,
		iteration: payload.stepKey.iteration,
		currentLedger: payload.currentLedger,
		findings: payload.findings,
		assessments: payload.assessments,
		...(payload.baselineAssessment === undefined
			? {}
			: { baselineAssessment: payload.baselineAssessment }),
		derived,
		effectiveGateCauses: payload.effectiveGateCauses ?? [],
		suppressedGateCauses: payload.suppressedGateCauses ?? [],
		priorFindings: payload.priorFindings ?? [],
		diagnostics: payload.diagnostics ?? [],
		createdAt: payload.createdAt,
	};
}

function now(): string {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function createReviewBudgetStore(
	recordStore: RecordStore,
	index?: ReviewBudgetIndex,
): ReviewBudgetStore {
	function budgetLines(runId: string) {
		return recordStore.listLines(runId, "budget");
	}

	function projectSnapshotToIndex(
		runId: string,
		idempotencyKey: string,
		record: ReviewBudgetSnapshotRecord,
	): void {
		if (!index) return;
		const allLines = budgetLines(runId);
		const seq = allLines.findIndex(
			(line) => line.idempotencyKey === idempotencyKey,
		);
		if (seq >= 0) index.upsertSnapshot(record, idempotencyKey, seq);
	}

	return {
		getBaseline(runId) {
			const line = recordStore.getLine(
				runId,
				"budget",
				baselineIdempotencyKey(runId),
			);
			if (!line) return null;
			const baseline = baselineRecord(line.payload);
			const cached = index?.getBaseline(runId);
			if (cached?.id === baseline.id) return cached;
			index?.upsertBaseline(baseline, line.idempotencyKey);
			return baseline;
		},

		captureBaseline(input) {
			const b0 = sumEffort(input.parsed.workItems);
			if (!Number.isInteger(b0) || b0 <= 0) {
				throw new RangeError(
					"review budget baseline b0 must be a positive integer",
				);
			}
			const createdAt = now();
			const key = baselineIdempotencyKey(input.runId);
			const result = recordStore.append({
				runId: input.runId,
				stream: "budget",
				idempotencyKey: key,
				payload: encodeBudgetBaselinePayload({
					kind: "baseline",
					id: createReviewBudgetId(),
					runId: input.runId,
					captureKind: input.captureKind,
					b0,
					b: b0,
					originalLedger: input.parsed,
					surface: input.parsed.surface,
					originalSection: input.originalSection ?? null,
					configSnapshot: input.configSnapshot,
					mode: input.mode,
					createdAt,
				}),
				createdAt,
				...recordedEnvelope(input.origin),
			});
			const baseline = baselineRecord(result.line.payload);
			index?.upsertBaseline(baseline, key);
			return {
				ok: true,
				created: result.created,
				baseline,
			} as CaptureBaselineResult;
		},

		appendSnapshot(input) {
			const stepKey = {
				stepName: input.stepName,
				phase: input.phase ?? null,
				iteration: input.iteration ?? null,
			};
			const key = snapshotIdempotencyKey(input.runId, stepKey);
			const baselineLine = recordStore.getLine(
				input.runId,
				"budget",
				baselineIdempotencyKey(input.runId),
			);
			const origin = input.origin ?? baselineLine?.origin;
			if (!origin) {
				throw new Error(
					"appendSnapshot requires an origin or an attributed baseline",
				);
			}
			const createdAt = now();
			const result = recordStore.append({
				runId: input.runId,
				stream: "budget",
				idempotencyKey: key,
				payload: encodeBudgetSnapshotPayload({
					kind: "snapshot",
					id: createReviewBudgetId(),
					runId: input.runId,
					stepKey,
					currentLedger: input.currentLedger,
					findings: input.findings,
					assessments: input.assessments,
					...(input.baselineAssessment === undefined
						? {}
						: { baselineAssessment: input.baselineAssessment }),
					priorFindings: input.priorFindings ?? [],
					effectiveGateCauses: input.effectiveGateCauses ?? [],
					suppressedGateCauses: input.suppressedGateCauses ?? [],
					diagnostics: input.diagnostics ?? [],
					createdAt,
				}),
				createdAt,
				...recordedEnvelope(origin),
			});
			const record = snapshotRecord(result.line.payload, input.derived ?? null);
			projectSnapshotToIndex(input.runId, key, record);
			return record;
		},

		latestSnapshot(runId) {
			const snapshots = this.listSnapshots(runId);
			return snapshots.at(-1) ?? null;
		},

		listSnapshots(runId) {
			const allLines = budgetLines(runId);
			const snapshots = allLines.flatMap((line, recordSeq) =>
				typeof line.payload === "object" &&
				line.payload !== null &&
				(line.payload as { kind?: unknown }).kind === "snapshot"
					? [{ line, recordSeq }]
					: [],
			);
			const cached = index?.listSnapshots(runId);
			if (
				cached !== undefined &&
				cached.length === snapshots.length &&
				cached.every((record, position) => {
					const payload = decodeBudgetSnapshotPayload(
						snapshots[position]?.line.payload,
					);
					return (
						record.id === payload.id &&
						(payload.baselineAssessment === undefined ||
							record.baselineAssessment !== undefined)
					);
				})
			) {
				return cached;
			}
			const records: ReviewBudgetSnapshotRecord[] = [];
			for (const { line, recordSeq } of snapshots) {
				const record = snapshotRecord(line.payload);
				records.push(record);
				index?.upsertSnapshot(record, line.idempotencyKey, recordSeq);
			}
			return records;
		},

		projectSnapshot(runId, idempotencyKey, derived) {
			const line = recordStore.getLine(runId, "budget", idempotencyKey);
			if (!line) return null;
			const record = snapshotRecord(line.payload, derived ?? null);
			projectSnapshotToIndex(runId, idempotencyKey, record);
			return record;
		},
	};
}
