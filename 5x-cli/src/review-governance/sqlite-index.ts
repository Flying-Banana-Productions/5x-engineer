import type { Database } from "bun:sqlite";
import type { RecordStore } from "../control-plane/record-store.js";
import {
	type BudgetSnapshotPayload,
	decodeBudgetSnapshotPayload,
} from "../review-budget/record-lines.js";
import {
	applyDecisionCauseCoverage,
	classifyDecisionAcceptance,
	deriveGateId,
	governanceDecisionKey,
	listGovernanceDecisions,
	type ReviewDecisionPayload,
} from "./decisions.js";
import type { ReviewGateCause } from "./types.js";

export interface GovernanceReindexResult {
	decisions: number;
	gates: number;
	diagnostics: string[];
}

function upsertDecision(
	db: Database,
	input: {
		runId: string;
		decision: ReviewDecisionPayload;
		key: string;
		seq: number;
		acceptance: "accepted" | "stale" | "malformed";
		diagnostic?: string;
	},
): void {
	db.query(`INSERT INTO review_decision_index (
		decision_id, run_id, record_idempotency_key, record_seq, gate_id,
		snapshot_id, choice, intent_hash, payload_json, acceptance, diagnostic, created_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(decision_id) DO UPDATE SET
		record_seq=excluded.record_seq, acceptance=excluded.acceptance,
		diagnostic=excluded.diagnostic, payload_json=excluded.payload_json`).run(
		input.decision.decisionId,
		input.runId,
		input.key,
		input.seq,
		input.decision.gateId,
		input.decision.snapshotId,
		input.decision.choice,
		input.decision.decisionIntentHash,
		JSON.stringify(input.decision),
		input.acceptance,
		input.diagnostic ?? null,
		input.decision.createdAt,
	);
}

function upsertGate(
	db: Database,
	input: {
		gateId: string;
		runId: string;
		snapshotId: string;
		causes: ReviewGateCause[];
		resolvedDecisionId?: string;
		predecessorGateId?: string;
		route?: string;
		seq: number;
	},
): void {
	db.query(`INSERT INTO review_gate_index (
		gate_id, run_id, snapshot_id, predecessor_gate_id, causes_json,
		resolved_decision_id, route, record_seq
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(gate_id) DO UPDATE SET
		resolved_decision_id=excluded.resolved_decision_id,
		route=excluded.route, record_seq=excluded.record_seq`).run(
		input.gateId,
		input.runId,
		input.snapshotId,
		input.predecessorGateId ?? null,
		JSON.stringify(input.causes),
		input.resolvedDecisionId ?? null,
		input.route ?? null,
		input.seq,
	);
}

/** Rebuildable SQLite projection. RecordStore streams remain authoritative. */
export function reindexReviewGovernance(
	recordStore: RecordStore,
	db: Database,
	runId?: string,
): GovernanceReindexResult {
	const runIds = runId ? [runId] : recordStore.listRuns().map((run) => run.id);
	const diagnostics: string[] = [];
	let decisionCount = 0;
	let gateCount = 0;
	for (const id of runIds) {
		db.query("DELETE FROM review_decision_index WHERE run_id = ?").run(id);
		db.query("DELETE FROM review_gate_index WHERE run_id = ?").run(id);
		const decisionLines = recordStore.listLines(id, "decisions");
		const budget = recordStore.listLines(id, "budget");
		const steps = recordStore.listLines(id, "steps");
		const listed = listGovernanceDecisions(recordStore, id);
		diagnostics.push(...listed.diagnostics);
		for (const decision of listed.decisions) {
			const lineSeq = decisionLines.findIndex(
				(line) =>
					(line.payload as { decisionId?: unknown })?.decisionId ===
					decision.decisionId,
			);
			const line = decisionLines[lineSeq];
			const acceptance = classifyDecisionAcceptance({
				decision,
				steps,
				budget,
			});
			upsertDecision(db, {
				runId: id,
				decision,
				key: line?.idempotencyKey ?? `missing:${decision.decisionId}`,
				seq: lineSeq,
				acceptance: acceptance.accepted
					? "accepted"
					: acceptance.stale
						? "stale"
						: "malformed",
				...(acceptance.diagnostic ? { diagnostic: acceptance.diagnostic } : {}),
			});
			if (acceptance.diagnostic)
				diagnostics.push(`${decision.decisionId}: ${acceptance.diagnostic}`);
			decisionCount += 1;
		}
		for (const [seq, line] of budget.entries()) {
			let snapshot: BudgetSnapshotPayload;
			try {
				snapshot = decodeBudgetSnapshotPayload(line.payload);
			} catch {
				continue;
			}
			if (!snapshot.effectiveGateCauses?.length) continue;
			let causes = snapshot.effectiveGateCauses;
			let predecessorGateId: string | undefined;
			let chainDepth = 0;
			while (causes.length > 0) {
				const gateId = deriveGateId({
					runId: id,
					snapshotId: snapshot.id,
					causes,
					...(predecessorGateId ? { predecessorGateId } : {}),
				});
				const winner = listed.decisions.find(
					(decision) =>
						decision.gateId === gateId &&
						decisionLines.some(
							(candidate) =>
								candidate.idempotencyKey === governanceDecisionKey(gateId),
						),
				);
				upsertGate(db, {
					gateId,
					runId: id,
					snapshotId: snapshot.id,
					causes,
					...(predecessorGateId ? { predecessorGateId } : {}),
					...(winner ? { resolvedDecisionId: winner.decisionId } : {}),
					seq: seq + chainDepth,
				});
				gateCount += 1;
				chainDepth += 1;
				if (!winner) break;
				const next = applyDecisionCauseCoverage(causes, winner);
				if (next.length === 0 || next.length === causes.length) break;
				causes = next;
				predecessorGateId = gateId;
			}
		}
	}
	return { decisions: decisionCount, gates: gateCount, diagnostics };
}

/** Live write-through seam used after authoritative record appends. */
export function projectReviewGovernance(
	recordStore: RecordStore,
	db: Database,
	runId: string,
): GovernanceReindexResult {
	return reindexReviewGovernance(recordStore, db, runId);
}
