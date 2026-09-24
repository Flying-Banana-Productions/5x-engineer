import type { Database } from "bun:sqlite";
import { redactOrigin } from "../control-plane/record-redact.js";
import type { RecordStore } from "../control-plane/record-store.js";
import {
	type BudgetSnapshotPayload,
	decodeBudgetSnapshotPayload,
	decodeImplementationBindingPayload,
	decodeImplementationReviewObservationPayload,
	type ImplementationObservationGateCause,
} from "../review-budget/record-lines.js";
import {
	applyDecisionCauseCoverage,
	applyImplementationDecisionCauseCoverage,
	classifyDecisionAcceptance,
	deriveGateId,
	governanceDecisionKey,
	type ImplementationDecisionPayload,
	listGovernanceDecisions,
	listImplementationDecisions,
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
		decision: ReviewDecisionPayload | ImplementationDecisionPayload;
		key: string;
		seq: number;
		acceptance: "accepted" | "stale" | "malformed";
		diagnostic?: string;
	},
): void {
	db.query(`INSERT INTO review_decision_index (
		decision_id, run_id, record_idempotency_key, record_seq, gate_id,
		snapshot_id, choice, intent_hash, payload_json, acceptance, diagnostic, created_at,
		domain, phase, binding_id, observation_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(decision_id) DO UPDATE SET
		record_seq=excluded.record_seq, acceptance=excluded.acceptance,
		diagnostic=excluded.diagnostic, payload_json=excluded.payload_json,
		domain=excluded.domain, phase=excluded.phase, binding_id=excluded.binding_id,
		observation_id=excluded.observation_id`).run(
		input.decision.decisionId,
		input.runId,
		input.key,
		input.seq,
		input.decision.gateId,
		"snapshotId" in input.decision
			? input.decision.snapshotId
			: input.decision.observationId,
		input.decision.choice,
		input.decision.decisionIntentHash,
		JSON.stringify(input.decision),
		input.acceptance,
		input.diagnostic ?? null,
		input.decision.createdAt,
		input.decision.kind === "implementation-review-governance"
			? "implementation"
			: "plan",
		input.decision.kind === "implementation-review-governance"
			? input.decision.phase
			: null,
		input.decision.kind === "implementation-review-governance"
			? input.decision.bindingId
			: null,
		input.decision.kind === "implementation-review-governance"
			? input.decision.observationId
			: null,
	);
}

function upsertGate(
	db: Database,
	input: {
		gateId: string;
		runId: string;
		snapshotId: string;
		causes: ReadonlyArray<ReviewGateCause | ImplementationObservationGateCause>;
		resolvedDecisionId?: string;
		predecessorGateId?: string;
		route?: string;
		seq: number;
		domain?: "plan" | "implementation";
		phase?: string;
		bindingId?: string;
		observationId?: string;
	},
): void {
	db.query(`INSERT INTO review_gate_index (
		gate_id, run_id, snapshot_id, predecessor_gate_id, causes_json,
		resolved_decision_id, route, record_seq, domain, phase, binding_id, observation_id
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(gate_id) DO UPDATE SET
		resolved_decision_id=excluded.resolved_decision_id,
		route=excluded.route, record_seq=excluded.record_seq,
		domain=excluded.domain, phase=excluded.phase,
		binding_id=excluded.binding_id, observation_id=excluded.observation_id`).run(
		input.gateId,
		input.runId,
		input.snapshotId,
		input.predecessorGateId ?? null,
		JSON.stringify(input.causes),
		input.resolvedDecisionId ?? null,
		input.route ?? null,
		input.seq,
		input.domain ?? "plan",
		input.phase ?? null,
		input.bindingId ?? null,
		input.observationId ?? null,
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
		db.query("DELETE FROM implementation_binding_index WHERE run_id = ?").run(
			id,
		);
		db.query(
			"DELETE FROM implementation_observation_index WHERE run_id = ?",
		).run(id);
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
		const implementation = listImplementationDecisions(recordStore, id);
		diagnostics.push(...implementation.diagnostics);
		for (const decision of implementation.decisions) {
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
			const raw = line.payload as { kind?: unknown; version?: unknown } | null;
			if (!raw || typeof raw.kind !== "string") continue;
			if (
				raw.kind !== "implementation-binding" &&
				raw.kind !== "implementation-review"
			)
				continue;
			if (raw.version !== 1) {
				diagnostics.push(
					`${line.idempotencyKey}: unsupported implementation record version`,
				);
				continue;
			}
			if (raw.kind === "implementation-binding") {
				try {
					const binding = decodeImplementationBindingPayload(line.payload);
					db.query(`INSERT INTO implementation_binding_index (
						id, run_id, record_idempotency_key, record_seq, source_run_id,
						approved_plan_commit, ledger_hash, decisions_hash, payload_json,
						origin_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET
						record_seq=excluded.record_seq, payload_json=excluded.payload_json,
						origin_json=excluded.origin_json`).run(
						binding.id,
						id,
						line.idempotencyKey,
						seq,
						binding.sourceRunId,
						binding.approvedPlanCommit,
						binding.ledgerHash,
						binding.decisionsHash,
						JSON.stringify(binding),
						JSON.stringify(redactOrigin(line.origin, [])),
						binding.createdAt,
					);
				} catch (error) {
					diagnostics.push(
						`${line.idempotencyKey}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				continue;
			}
			try {
				const observation = decodeImplementationReviewObservationPayload(
					line.payload,
				);
				db.query(`INSERT INTO implementation_observation_index (
					id, run_id, record_idempotency_key, record_seq, binding_id, phase,
					route, next_action, payload_json, origin_json, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					record_seq=excluded.record_seq, payload_json=excluded.payload_json,
					origin_json=excluded.origin_json`).run(
					observation.id,
					id,
					line.idempotencyKey,
					seq,
					observation.bindingId,
					observation.phase,
					observation.route,
					observation.nextAction,
					JSON.stringify(observation),
					JSON.stringify(redactOrigin(line.origin, [])),
					observation.createdAt,
				);
				if (!observation.gateCauses.length) continue;
				let causes = observation.gateCauses;
				let predecessorGateId: string | undefined;
				let chainDepth = 0;
				while (causes.length > 0) {
					const gateId = deriveGateId({
						runId: id,
						snapshotId: observation.id,
						causes,
						...(predecessorGateId ? { predecessorGateId } : {}),
						domain: "implementation",
						phase: observation.phase,
						bindingId: observation.bindingId,
						observationId: observation.id,
					});
					const winner = implementation.decisions.find(
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
						snapshotId: observation.id,
						causes,
						domain: "implementation",
						phase: observation.phase,
						bindingId: observation.bindingId,
						observationId: observation.id,
						...(predecessorGateId ? { predecessorGateId } : {}),
						...(winner ? { resolvedDecisionId: winner.decisionId } : {}),
						seq: seq + chainDepth,
					});
					gateCount += 1;
					chainDepth += 1;
					if (!winner) break;
					const next = applyImplementationDecisionCauseCoverage(causes, winner);
					if (next.length === 0 || next.length === causes.length) break;
					causes = next;
					predecessorGateId = gateId;
				}
			} catch (error) {
				diagnostics.push(
					`${line.idempotencyKey}: ${error instanceof Error ? error.message : String(error)}`,
				);
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
