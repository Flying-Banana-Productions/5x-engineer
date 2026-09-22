import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	createMemoryRecordStore,
	createReviewBudgetIndex,
	createReviewBudgetStore,
	type RecordOrigin,
	type RecordStore,
	RUN_RECORD_FORMAT_VERSION,
} from "../../../src/control-plane/index.js";
import { runMigrations } from "../../../src/db/schema.js";
import type {
	BaselineAssessment,
	ParsedDeliveryBudget,
} from "../../../src/review-budget/types.js";
import { DEFAULT_REVIEW_BUDGET_CONFIG } from "../../../src/review-budget/types.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
	performer: { kind: "agent", role: "reviewer", provider: "test" },
};

function ledger(effort: 3 | 5 = 3): ParsedDeliveryBudget {
	return {
		estimateConfidence: "medium",
		workItems: [
			{
				id: "W1",
				title: "Persist budget",
				effort,
				architectureDelta: -1,
				debtClaim: {
					debtClaimId: "DC1",
					coupling: "intrinsic",
					targetPhase: "phase-5",
					minimalAlternativeEffortDelta: 1,
					minimalAlternativeArchitectureDelta: 0,
					before: "Records are authoritative",
					after: "A cache is introduced",
				},
				addresses: [],
				rationale: "Required",
				line: 10,
			},
		],
		surface: {
			subsystems: 1,
			productionFiles: 3,
			persistentOrExternalBoundaries: 1,
		},
	};
}

function putRecordRun(store: RecordStore, runId: string): void {
	store.putRun({
		id: runId,
		plan_path: "docs/development/plans/test.md",
		config_json: null,
		created_at: "2026-09-17 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "1.3.0",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: origin.recorder,
	});
}

function runContract(withIndex: boolean): void {
	test(`capture and snapshots round-trip (${withIndex ? "indexed" : "record-only"})`, () => {
		const records = createMemoryRecordStore();
		putRecordRun(records, "run1");
		const db = withIndex ? new Database(":memory:") : null;
		if (db) {
			db.exec("PRAGMA foreign_keys=ON");
			runMigrations(db);
			db.exec("INSERT INTO runs(id, plan_path) VALUES ('run1', '/plan.md')");
		}
		try {
			const index = db ? createReviewBudgetIndex(db) : undefined;
			const store = createReviewBudgetStore(records, index);
			const first = store.captureBaseline({
				runId: "run1",
				captureKind: "initial",
				parsed: ledger(3),
				originalSection: "| W1 |",
				configSnapshot: DEFAULT_REVIEW_BUDGET_CONFIG,
				origin,
			});
			expect(first.created).toBe(true);
			expect(first.baseline.b0).toBe(3);
			expect(
				first.baseline.originalLedger.workItems[0]?.debtClaim,
			).toMatchObject({
				targetPhase: "phase-5",
				minimalAlternativeEffortDelta: 1,
				minimalAlternativeArchitectureDelta: 0,
				before: "Records are authoritative",
				after: "A cache is introduced",
			});
			const second = store.captureBaseline({
				runId: "run1",
				captureKind: "opt_in",
				parsed: ledger(5),
				configSnapshot: DEFAULT_REVIEW_BUDGET_CONFIG,
				origin,
			});
			expect(second.created).toBe(false);
			expect(second.baseline.b0).toBe(3);
			expect(records.listLines("run1", "budget")).toHaveLength(1);
			expect(records.listLines("run1", "budget")[0]?.origin).toEqual(origin);

			const assessment: BaselineAssessment = {
				independentEffortEstimate: 5,
				confidence: "high",
				reason: "Independent estimate",
			};
			const snapshot1 = store.appendSnapshot({
				runId: "run1",
				stepName: "reviewer:plan",
				phase: "plan",
				iteration: 1,
				currentLedger: ledger(3),
				findings: [],
				assessments: [
					{
						creditClaimId: "DC1",
						eligibility: "eligible",
						coupling: "intrinsic",
					},
				],
				baselineAssessment: assessment,
			});
			const snapshot2 = store.appendSnapshot({
				runId: "run1",
				stepName: "reviewer:plan",
				phase: "plan",
				iteration: 2,
				currentLedger: ledger(3),
				findings: [],
				assessments: [],
			});
			const listed = store.listSnapshots("run1");
			expect(listed.map((item) => item.id)).toEqual([
				snapshot1.id,
				snapshot2.id,
			]);
			expect(listed[0]?.createdAt).toBe(listed[1]?.createdAt);
			expect(listed[0]?.baselineAssessment).toEqual(assessment);
			expect(listed[1]?.baselineAssessment).toBeUndefined();
			expect(listed[0]?.currentLedger.workItems[0]?.debtClaim?.before).toBe(
				"Records are authoritative",
			);
			expect(store.latestSnapshot("run1")?.id).toBe(snapshot2.id);
			if (index) {
				expect(index.getBaseline("run1")?.b0).toBe(3);
				expect(index.listSnapshots("run1")[0]?.baselineAssessment).toEqual(
					assessment,
				);
			}
		} finally {
			db?.close();
		}
	});
}

describe("ReviewBudgetStore contract", () => {
	runContract(false);
	runContract(true);

	test("rejects an empty baseline before appending", () => {
		const records = createMemoryRecordStore();
		putRecordRun(records, "run1");
		const store = createReviewBudgetStore(records);
		expect(() =>
			store.captureBaseline({
				runId: "run1",
				captureKind: "initial",
				parsed: { ...ledger(), workItems: [] },
				configSnapshot: DEFAULT_REVIEW_BUDGET_CONFIG,
				origin,
			}),
		).toThrow("positive integer");
		expect(records.listLines("run1", "budget")).toEqual([]);
	});
});
