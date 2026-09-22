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
} from "../../../src/review-governance/decisions.js";
import { reindexReviewGovernance } from "../../../src/review-governance/sqlite-index.js";
import { createReviewGovernanceStore } from "../../../src/review-governance/store.js";
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
			const first = reindexReviewGovernance(records, db, runId);
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
					"SELECT gate_id, predecessor_gate_id FROM review_gate_index ORDER BY record_seq",
				)
				.all();
			expect(gates).toEqual([
				{ gate_id: first.gateId, predecessor_gate_id: null },
				{ gate_id: successor.gateId, predecessor_gate_id: first.gateId },
			]);
		} finally {
			db.close();
		}
	});
});
