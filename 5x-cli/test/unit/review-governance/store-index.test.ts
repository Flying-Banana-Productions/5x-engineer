import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	createMemoryRecordStore,
	type RecordOrigin,
	recordedEnvelope,
	type StepRecordPayload,
} from "../../../src/control-plane/index.js";
import { runMigrations } from "../../../src/db/schema.js";
import { encodeBudgetSnapshotPayload } from "../../../src/review-budget/record-lines.js";
import {
	createReviewDecision,
	deriveGateId,
	foldGoverningReviewState,
	governanceCorrectionKey,
	governanceDecisionKey,
	type ReviewDecisionPayload,
} from "../../../src/review-governance/decisions.js";
import {
	projectReviewGovernance,
	reindexReviewGovernance,
} from "../../../src/review-governance/sqlite-index.js";
import {
	createReviewGovernanceStore,
	ReviewGovernanceStoreError,
} from "../../../src/review-governance/store.js";
import type { ReviewGateCause } from "../../../src/review-governance/types.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
	performer: { kind: "human" },
};
const runId = "run1";
const cause = { kind: "budget_band" as const, band: "over_effective" as const };
const humanStep = (decisionId: string, gateId: string): StepRecordPayload => ({
	step_name: "human:review-governance",
	phase: "plan",
	iteration: 2,
	result_json: { decisionId, gateId },
	head_commit: null,
	patch_id: null,
	diff_summary: null,
	duration_ms: null,
	tokens_in: null,
	tokens_out: null,
	cost_usd: null,
	model: null,
});

function fixture(causes: ReviewGateCause[] = [cause]) {
	const records = createMemoryRecordStore();
	records.putRun({
		id: runId,
		plan_path: "/plan.md",
		config_json: null,
		created_at: "2026-01-01",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "test",
		format_version: 1,
		creator: origin.recorder,
	});
	records.append({
		runId,
		stream: "steps",
		idempotencyKey: "reviewer",
		payload: {
			...humanStep("", ""),
			step_name: "reviewer:plan",
			iteration: 1,
			result_json: {},
		},
		...recordedEnvelope(origin),
	});
	records.append({
		runId,
		stream: "budget",
		idempotencyKey: "snapshot",
		payload: encodeBudgetSnapshotPayload({
			kind: "snapshot",
			id: "snapshot1",
			runId,
			stepKey: { stepName: "reviewer:plan", phase: "plan", iteration: 1 },
			currentLedger: {
				workItems: [],
				surface: {},
				estimateConfidence: "medium",
			} as never,
			findings: [],
			assessments: [],
			effectiveGateCauses: causes,
			suppressedGateCauses: [{ ...cause, resolvedBy: "prior" }],
			createdAt: "2026-01-01",
		}),
		...recordedEnvelope(origin),
	});
	return records;
}

describe("review governance store and projection", () => {
	test("a newer cause-free snapshot supersedes an older open gate", () => {
		const records = fixture();
		records.append({
			runId,
			stream: "budget",
			idempotencyKey: "snapshot-2",
			payload: encodeBudgetSnapshotPayload({
				kind: "snapshot",
				id: "snapshot2",
				runId,
				stepKey: { stepName: "reviewer:plan", phase: "plan", iteration: 2 },
				currentLedger: {
					workItems: [],
					surface: {},
					estimateConfidence: "medium",
				} as never,
				findings: [],
				assessments: [],
				effectiveGateCauses: [],
				createdAt: "2026-01-02",
			}),
			...recordedEnvelope(origin),
		});
		expect(
			createReviewGovernanceStore(records).deriveOpenGate(runId),
		).toBeNull();
	});

	test("first gate decision wins and semantic retry returns the winner", () => {
		const records = fixture();
		const store = createReviewGovernanceStore(records);
		const gate = store.deriveOpenGate(runId);
		if (!gate) throw new Error("expected an open gate");
		expect(gate.gateId).toBe(
			deriveGateId({ runId, snapshotId: "snapshot1", causes: [cause] }),
		);
		const winner = createReviewDecision({
			gateId: gate.gateId,
			snapshotId: gate.snapshotId,
			choice: "retain_baseline",
			findingRefs: [],
			rationale: "Keep the original estimate",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
			decisionId: "11111111-1111-4111-8111-111111111112",
			createdAt: "2026-01-02",
		});
		expect(
			store.resolveGate({
				runId,
				decision: winner,
				humanStep: humanStep(winner.decisionId, winner.gateId),
				origin,
			}).created,
		).toBe(true);
		const retry = createReviewDecision({
			...winner,
			decisionId: "11111111-1111-4111-8111-111111111113",
			createdAt: "2026-01-03",
		});
		const loser = store.resolveGate({
			runId,
			decision: retry,
			humanStep: { ...humanStep(retry.decisionId, retry.gateId), iteration: 3 },
			origin,
		});
		expect(loser.created).toBe(false);
		if (!loser.created) expect(loser.semanticRetry).toBe(true);
		expect(records.listLines(runId, "decisions")).toHaveLength(1);
	});

	test("a resolved decision that covers no cause creates an unchanged-cause successor", () => {
		const records = fixture();
		const governance = createReviewGovernanceStore(records);
		const first = governance.deriveOpenGate(runId);
		if (!first) throw new Error("expected an open gate");
		const decision = createReviewDecision({
			gateId: first.gateId,
			snapshotId: first.snapshotId,
			choice: "increase_budget",
			findingRefs: [],
			rationale: "Increase was insufficient",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
			governingBaselineChange: { from: 5, to: 6 },
		});
		governance.resolveGate({
			runId,
			decision,
			humanStep: humanStep(decision.decisionId, decision.gateId),
			origin,
		});
		const successor = governance.deriveOpenGate(runId);
		if (!successor) throw new Error("expected successor gate");
		expect(successor.gateId).not.toBe(first.gateId);
		expect(successor.causes).toEqual(first.causes);
	});

	test("wiped SQLite projection rebuild preserves acceptance and gate resolution", () => {
		const records = fixture();
		const governance = createReviewGovernanceStore(records);
		const gate = governance.deriveOpenGate(runId);
		if (!gate) throw new Error("expected an open gate");
		const decision = createReviewDecision({
			gateId: gate.gateId,
			snapshotId: gate.snapshotId,
			choice: "retain_baseline",
			findingRefs: [],
			rationale: "Keep baseline",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
		});
		governance.resolveGate({
			runId,
			decision,
			humanStep: humanStep(decision.decisionId, decision.gateId),
			origin,
		});
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			db.exec("INSERT INTO runs(id, plan_path) VALUES ('run1', '/plan.md')");
			const stateBefore = JSON.stringify(
				governance.deriveGoverningState(runId, 5),
			);
			const first = projectReviewGovernance(records, db, runId);
			const before = db
				.query(
					"SELECT decision_id, acceptance, diagnostic FROM review_decision_index ORDER BY record_seq",
				)
				.all();
			db.exec(
				"DELETE FROM review_decision_index; DELETE FROM review_gate_index",
			);
			const second = reindexReviewGovernance(records, db, runId);
			const after = db
				.query(
					"SELECT decision_id, acceptance, diagnostic FROM review_decision_index ORDER BY record_seq",
				)
				.all();
			expect(second).toEqual(first);
			expect(after).toEqual(before);
			const projectedDecisions = (
				db
					.query(
						"SELECT payload_json FROM review_decision_index ORDER BY record_seq",
					)
					.all() as Array<{ payload_json: string }>
			).map((row) => JSON.parse(row.payload_json) as ReviewDecisionPayload);
			const rebuiltState = foldGoverningReviewState({
				b0: 5,
				decisions: projectedDecisions,
				steps: records.listLines(runId, "steps"),
				budget: records.listLines(runId, "budget"),
			});
			expect(JSON.stringify(rebuiltState)).toBe(stateBefore);
			expect(after).toEqual([
				{
					decision_id: decision.decisionId,
					acceptance: "accepted",
					diagnostic: null,
				},
			]);
		} finally {
			db.close();
		}
	});

	test("step-key collisions are distinct from gate resolution", () => {
		const records = fixture();
		const governance = createReviewGovernanceStore(records);
		const gate = governance.deriveOpenGate(runId);
		if (!gate) throw new Error("expected gate");
		records.append({
			runId,
			stream: "steps",
			idempotencyKey: `step:${runId}:human:review-governance:plan:2`,
			payload: humanStep("other-decision", "other-gate"),
			...recordedEnvelope(origin),
		});
		const decision = createReviewDecision({
			gateId: gate.gateId,
			snapshotId: gate.snapshotId,
			choice: "retain_baseline",
			findingRefs: [],
			rationale: "Retain baseline",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
		});
		try {
			governance.resolveGate({
				runId,
				decision,
				humanStep: humanStep(decision.decisionId, decision.gateId),
				origin,
			});
			throw new Error("expected collision");
		} catch (error) {
			expect(error).toBeInstanceOf(ReviewGovernanceStoreError);
			expect((error as ReviewGovernanceStoreError).code).toBe(
				"REVIEW_GATE_STEP_CONFLICT",
			);
		}
		expect(
			records.getLine(runId, "decisions", governanceDecisionKey(gate.gateId)),
		).toBeNull();
	});

	test("correction retries return the conflicting correction, not the gate winner", () => {
		const records = fixture();
		const governance = createReviewGovernanceStore(records);
		const gate = governance.deriveOpenGate(runId);
		if (!gate) throw new Error("expected gate");
		const winner = createReviewDecision({
			gateId: gate.gateId,
			snapshotId: gate.snapshotId,
			choice: "retain_baseline",
			findingRefs: [],
			rationale: "Retain baseline",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
		});
		governance.resolveGate({
			runId,
			decision: winner,
			humanStep: humanStep(winner.decisionId, winner.gateId),
			origin,
		});
		const correction = createReviewDecision({
			gateId: gate.gateId,
			snapshotId: gate.snapshotId,
			choice: "request_author_reestimate",
			findingRefs: [],
			rationale: "Request a corrected estimate",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
			supersedesDecisionId: winner.decisionId,
		});
		governance.resolveGate({
			runId,
			decision: correction,
			humanStep: {
				...humanStep(correction.decisionId, correction.gateId),
				iteration: 3,
			},
			origin,
		});
		const retry = governance.resolveGate({
			runId,
			decision: correction,
			humanStep: {
				...humanStep(correction.decisionId, correction.gateId),
				iteration: 4,
			},
			origin,
		});
		expect(retry.created).toBe(false);
		if (!retry.created) {
			expect(retry.decision.decisionId).toBe(correction.decisionId);
			expect(retry.semanticRetry).toBe(true);
		}
		expect(
			records.getLine(
				runId,
				"decisions",
				governanceCorrectionKey(correction.decisionId),
			),
		).not.toBeNull();
	});

	test("malformed gate decisions remain diagnostic and leave the gate open", () => {
		const records = fixture();
		const governance = createReviewGovernanceStore(records);
		const gate = governance.deriveOpenGate(runId);
		if (!gate) throw new Error("expected gate");
		records.append({
			runId,
			stream: "decisions",
			idempotencyKey: governanceDecisionKey(gate.gateId),
			payload: { kind: "plan-review-governance", version: 999 },
			...recordedEnvelope(origin),
		});
		expect(governance.deriveOpenGate(runId)?.gateId).toBe(gate.gateId);
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			db.exec("INSERT INTO runs(id, plan_path) VALUES ('run1', '/plan.md')");
			const rebuilt = reindexReviewGovernance(records, db, runId);
			expect(rebuilt.diagnostics).toHaveLength(1);
			expect(
				(
					db
						.query("SELECT resolved_decision_id FROM review_gate_index")
						.get() as {
						resolved_decision_id: string | null;
					}
				).resolved_decision_id,
			).toBeNull();
		} finally {
			db.close();
		}
	});

	test("a partial decision creates one successor and the predecessor never reopens", () => {
		const finding = { findingId: "F1", fingerprint: "sha256:finding" };
		const records = fixture([
			{ kind: "budget_alert", alert: "baseline_disputed" },
			{ kind: "semantic_human", finding },
		]);
		const governance = createReviewGovernanceStore(records);
		const first = governance.deriveOpenGate(runId);
		if (!first) throw new Error("expected first gate");
		const retain = createReviewDecision({
			gateId: first.gateId,
			snapshotId: first.snapshotId,
			choice: "retain_baseline",
			findingRefs: [],
			rationale: "Retain the original baseline",
			evidence: [],
			approvedScope: { retained: [], removed: [] },
		});
		governance.resolveGate({
			runId,
			decision: retain,
			humanStep: humanStep(retain.decisionId, retain.gateId),
			origin,
		});
		const successor = governance.deriveOpenGate(runId);
		if (!successor) throw new Error("expected successor gate");
		expect(successor.gateId).not.toBe(first.gateId);
		expect(successor.causes).toEqual([{ kind: "semantic_human", finding }]);
		const defer = createReviewDecision({
			gateId: successor.gateId,
			snapshotId: successor.snapshotId,
			choice: "defer_accept_risk",
			findingRefs: [finding],
			rationale: "Accept this scoped risk",
			evidence: ["The operator accepted the named failure"],
			approvedScope: { retained: ["existing scope"], removed: [] },
		});
		governance.resolveGate({
			runId,
			decision: defer,
			humanStep: { ...humanStep(defer.decisionId, defer.gateId), iteration: 3 },
			origin,
		});
		expect(governance.deriveOpenGate(runId)).toBeNull();

		const db = new Database(":memory:");
		try {
			runMigrations(db);
			db.exec("INSERT INTO runs(id, plan_path) VALUES ('run1', '/plan.md')");
			expect(reindexReviewGovernance(records, db, runId).gates).toBe(2);
			const gates = db
				.query(
					"SELECT gate_id, predecessor_gate_id, record_seq FROM review_gate_index ORDER BY record_seq",
				)
				.all();
			expect(gates).toEqual([
				{ gate_id: first.gateId, predecessor_gate_id: null, record_seq: 0 },
				{
					gate_id: successor.gateId,
					predecessor_gate_id: first.gateId,
					record_seq: 1,
				},
			]);
		} finally {
			db.close();
		}
	});

	test("gate record sequence is scoped to each run", () => {
		const records = fixture();
		const secondRun = "run2";
		records.putRun({
			id: secondRun,
			plan_path: "/plan-2.md",
			config_json: null,
			created_at: "2026-01-01",
			sealed_at: null,
			status: "active",
			final_head_commit: null,
			cli_version: "test",
			format_version: 1,
			creator: origin.recorder,
		});
		records.append({
			runId: secondRun,
			stream: "budget",
			idempotencyKey: "snapshot-run2",
			payload: encodeBudgetSnapshotPayload({
				kind: "snapshot",
				id: "snapshot-run2",
				runId: secondRun,
				stepKey: { stepName: "reviewer:plan", phase: "plan", iteration: 1 },
				currentLedger: {
					workItems: [],
					surface: {},
					estimateConfidence: "medium",
				} as never,
				findings: [],
				assessments: [],
				effectiveGateCauses: [cause],
				createdAt: "2026-01-01",
			}),
			...recordedEnvelope(origin),
		});
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			db.exec(
				"INSERT INTO runs(id, plan_path) VALUES ('run1', '/plan.md'), ('run2', '/plan-2.md')",
			);
			reindexReviewGovernance(records, db);
			const rows = db
				.query(
					"SELECT run_id, record_seq FROM review_gate_index ORDER BY run_id",
				)
				.all();
			expect(rows).toEqual([
				{ run_id: "run1", record_seq: 0 },
				{ run_id: "run2", record_seq: 0 },
			]);
		} finally {
			db.close();
		}
	});
});
