import type { Database } from "bun:sqlite";
import {
	decodeBudgetBaselinePayload,
	decodeBudgetSnapshotPayload,
} from "../review-budget/record-lines.js";
import type { RecordStore } from "./record-store.js";
import type {
	ReviewBudgetBaseline,
	ReviewBudgetSnapshotRecord,
} from "./review-budget-store.js";

export interface ReviewBudgetIndex {
	upsertBaseline(baseline: ReviewBudgetBaseline, idempotencyKey: string): void;
	upsertSnapshot(
		snapshot: ReviewBudgetSnapshotRecord,
		idempotencyKey: string,
		recordSeq: number,
	): void;
	getBaseline(runId: string): ReviewBudgetBaseline | null;
	latestSnapshot(runId: string): ReviewBudgetSnapshotRecord | null;
	listSnapshots(runId: string): ReviewBudgetSnapshotRecord[];
}

interface BaselineRow {
	id: string;
	run_id: string;
	capture_kind: "initial" | "opt_in";
	b0: number;
	b: number;
	original_ledger_json: string;
	surface_snapshot_json: string;
	original_section: string | null;
	config_snapshot_json: string;
	mode: "advisory" | "enforced";
	created_at: string;
}

interface SnapshotRow {
	id: string;
	run_id: string;
	step_name: string | null;
	phase: string | null;
	iteration: number | null;
	current_ledger_json: string;
	findings_json: string;
	assessments_json: string;
	baseline_assessment_json: string | null;
	effective_gate_causes_json: string | null;
	suppressed_gate_causes_json: string | null;
	prior_findings_json: string | null;
	diagnostics_json: string | null;
	derived_json: string | null;
	created_at: string;
}

function baselineFromRow(row: BaselineRow): ReviewBudgetBaseline {
	return {
		id: row.id,
		runId: row.run_id,
		captureKind: row.capture_kind,
		b0: row.b0,
		b: row.b,
		originalLedger: JSON.parse(row.original_ledger_json),
		surface: JSON.parse(row.surface_snapshot_json),
		originalSection: row.original_section,
		configSnapshot: JSON.parse(row.config_snapshot_json),
		mode: row.mode,
		createdAt: row.created_at,
	};
}

function snapshotFromRow(row: SnapshotRow): ReviewBudgetSnapshotRecord {
	const result: ReviewBudgetSnapshotRecord = {
		id: row.id,
		runId: row.run_id,
		stepName: row.step_name ?? undefined,
		phase: row.phase,
		iteration: row.iteration,
		currentLedger: JSON.parse(row.current_ledger_json),
		findings: JSON.parse(row.findings_json),
		assessments: JSON.parse(row.assessments_json),
		derived: row.derived_json === null ? null : JSON.parse(row.derived_json),
		effectiveGateCauses:
			row.effective_gate_causes_json === null
				? []
				: JSON.parse(row.effective_gate_causes_json),
		suppressedGateCauses:
			row.suppressed_gate_causes_json === null
				? []
				: JSON.parse(row.suppressed_gate_causes_json),
		createdAt: row.created_at,
		priorFindings:
			row.prior_findings_json === null
				? []
				: JSON.parse(row.prior_findings_json),
		diagnostics:
			row.diagnostics_json === null ? [] : JSON.parse(row.diagnostics_json),
	};
	if (row.baseline_assessment_json !== null) {
		result.baselineAssessment = JSON.parse(row.baseline_assessment_json);
	}
	return result;
}

export function createReviewBudgetIndex(db: Database): ReviewBudgetIndex {
	return {
		upsertBaseline(baseline, idempotencyKey) {
			db.query(
				`INSERT INTO review_budget_baselines (
					id, run_id, record_idempotency_key, capture_kind, b0, b,
					original_ledger_json, surface_snapshot_json, original_section,
					config_snapshot_json, created_at
					, mode
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(record_idempotency_key) DO NOTHING`,
			).run(
				baseline.id,
				baseline.runId,
				idempotencyKey,
				baseline.captureKind,
				baseline.b0,
				baseline.b,
				JSON.stringify(baseline.originalLedger),
				JSON.stringify(baseline.surface),
				baseline.originalSection,
				JSON.stringify(baseline.configSnapshot),
				baseline.createdAt,
				baseline.mode,
			);
		},
		upsertSnapshot(snapshot, idempotencyKey, recordSeq) {
			db.query(
				`INSERT INTO review_budget_snapshots (
					id, run_id, record_idempotency_key, record_seq, step_name, phase,
					iteration, current_ledger_json, findings_json, assessments_json,
					baseline_assessment_json, effective_gate_causes_json,
					suppressed_gate_causes_json, prior_findings_json, diagnostics_json,
					derived_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(record_idempotency_key) DO UPDATE SET
					record_seq=excluded.record_seq,
					baseline_assessment_json=excluded.baseline_assessment_json,
					effective_gate_causes_json=excluded.effective_gate_causes_json,
					suppressed_gate_causes_json=excluded.suppressed_gate_causes_json,
					prior_findings_json=excluded.prior_findings_json,
					diagnostics_json=excluded.diagnostics_json,
					derived_json=COALESCE(excluded.derived_json, review_budget_snapshots.derived_json)`,
			).run(
				snapshot.id,
				snapshot.runId,
				idempotencyKey,
				recordSeq,
				snapshot.stepName ?? null,
				snapshot.phase,
				snapshot.iteration,
				JSON.stringify(snapshot.currentLedger),
				JSON.stringify(snapshot.findings),
				JSON.stringify(snapshot.assessments),
				snapshot.baselineAssessment === undefined
					? null
					: JSON.stringify(snapshot.baselineAssessment),
				JSON.stringify(snapshot.effectiveGateCauses),
				JSON.stringify(snapshot.suppressedGateCauses),
				JSON.stringify(snapshot.priorFindings ?? []),
				JSON.stringify(snapshot.diagnostics ?? []),
				snapshot.derived === null ? null : JSON.stringify(snapshot.derived),
				snapshot.createdAt,
			);
		},
		getBaseline(runId) {
			const row = db
				.query("SELECT * FROM review_budget_baselines WHERE run_id = ?")
				.get(runId) as BaselineRow | null;
			return row ? baselineFromRow(row) : null;
		},
		latestSnapshot(runId) {
			const row = db
				.query(
					"SELECT * FROM review_budget_snapshots WHERE run_id = ? ORDER BY record_seq DESC LIMIT 1",
				)
				.get(runId) as SnapshotRow | null;
			return row ? snapshotFromRow(row) : null;
		},
		listSnapshots(runId) {
			return (
				db
					.query(
						"SELECT * FROM review_budget_snapshots WHERE run_id = ? ORDER BY record_seq ASC",
					)
					.all(runId) as SnapshotRow[]
			).map(snapshotFromRow);
		},
	};
}

export function reindexReviewBudget(
	recordStore: RecordStore,
	index: ReviewBudgetIndex,
	runId: string,
): void {
	const lines = recordStore.listLines(runId, "budget");
	for (const [recordSeq, line] of lines.entries()) {
		if (
			typeof line.payload !== "object" ||
			line.payload === null ||
			!("kind" in line.payload)
		) {
			continue;
		}
		if ((line.payload as { kind?: unknown }).kind === "baseline") {
			const payload = decodeBudgetBaselinePayload(line.payload);
			index.upsertBaseline(
				{
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
				},
				line.idempotencyKey,
			);
		} else if ((line.payload as { kind?: unknown }).kind === "snapshot") {
			const payload = decodeBudgetSnapshotPayload(line.payload);
			index.upsertSnapshot(
				{
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
					derived: null,
					effectiveGateCauses: payload.effectiveGateCauses ?? [],
					suppressedGateCauses: payload.suppressedGateCauses ?? [],
					priorFindings: payload.priorFindings ?? [],
					diagnostics: payload.diagnostics ?? [],
					createdAt: payload.createdAt,
				},
				line.idempotencyKey,
				recordSeq,
			);
		}
	}
}
