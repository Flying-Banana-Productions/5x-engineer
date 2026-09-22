import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	createMemoryRecordStore,
	createReviewBudgetIndex,
	createReviewBudgetStore,
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
	reindexReviewBudget,
} from "../../../src/control-plane/index.js";
import { runMigrations } from "../../../src/db/schema.js";
import { deriveBudget } from "../../../src/review-budget/arithmetic.js";
import {
	type BaselineAssessment,
	DEFAULT_REVIEW_BUDGET_CONFIG,
	type ParsedDeliveryBudget,
} from "../../../src/review-budget/types.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "22222222-2222-4222-8222-222222222222" },
	performer: { kind: "agent", role: "reviewer" },
};

const parsed: ParsedDeliveryBudget = {
	estimateConfidence: "high",
	workItems: [
		{
			id: "W1",
			title: "Feature",
			effort: 5,
			architectureDelta: 0,
			debtClaim: null,
			addresses: [],
			rationale: "required",
			line: 1,
		},
	],
	surface: {
		subsystems: 1,
		productionFiles: 1,
		persistentOrExternalBoundaries: 1,
	},
};

function addRecordRun(
	records: ReturnType<typeof createMemoryRecordStore>,
	id: string,
) {
	records.putRun({
		id,
		plan_path: `docs/development/plans/${id}.md`,
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

describe("review budget index rebuild", () => {
	test("restores record facts and recomputes I/direction identically", () => {
		const db = new Database(":memory:");
		db.exec("PRAGMA foreign_keys=ON");
		runMigrations(db);
		db.exec("INSERT INTO runs(id, plan_path) VALUES ('run1', '/plan.md')");
		db.exec("INSERT INTO runs(id, plan_path) VALUES ('empty', '/empty.md')");
		const records = createMemoryRecordStore();
		addRecordRun(records, "run1");
		addRecordRun(records, "empty");
		const index = createReviewBudgetIndex(db);
		const store = createReviewBudgetStore(records, index);
		try {
			const baseline = store.captureBaseline({
				runId: "run1",
				captureKind: "initial",
				parsed,
				configSnapshot: DEFAULT_REVIEW_BUDGET_CONFIG,
				origin,
			}).baseline;
			const assessment: BaselineAssessment = {
				independentEffortEstimate: 8,
				confidence: "medium",
				reason: "larger than author estimate",
			};
			store.appendSnapshot({
				runId: "run1",
				stepName: "reviewer:plan",
				phase: "plan",
				iteration: 1,
				currentLedger: parsed,
				findings: [],
				assessments: [],
				baselineAssessment: assessment,
			});
			const before = index.latestSnapshot("run1");
			if (!before?.baselineAssessment) throw new Error("missing assessment");
			const derivedBefore = deriveBudget({
				B0: baseline.b0,
				B: baseline.b,
				I: before.baselineAssessment.independentEffortEstimate,
				workItems: before.currentLedger.workItems,
				findings: before.findings,
				assessments: before.assessments,
				config: baseline.configSnapshot,
				semanticHumanRequired: false,
			});

			db.exec(
				"DELETE FROM review_budget_snapshots; DELETE FROM review_budget_baselines",
			);
			expect(index.getBaseline("run1")).toBeNull();
			expect(index.listSnapshots("run1")).toEqual([]);
			reindexReviewBudget(records, index, "run1");
			const rebuiltBaseline = index.getBaseline("run1");
			const rebuilt = index.latestSnapshot("run1");
			expect(rebuiltBaseline).toEqual(baseline);
			expect(rebuilt?.currentLedger).toEqual(before.currentLedger);
			expect(rebuilt?.assessments).toEqual(before.assessments);
			expect(rebuilt?.baselineAssessment).toEqual(assessment);
			if (!rebuiltBaseline || !rebuilt?.baselineAssessment) {
				throw new Error("reindex omitted authoritative records");
			}
			const derivedAfter = deriveBudget({
				B0: rebuiltBaseline.b0,
				B: rebuiltBaseline.b,
				I: rebuilt.baselineAssessment.independentEffortEstimate,
				workItems: rebuilt.currentLedger.workItems,
				findings: rebuilt.findings,
				assessments: rebuilt.assessments,
				config: rebuiltBaseline.configSnapshot,
				semanticHumanRequired: false,
			});
			expect(derivedAfter.I).toBe(derivedBefore.I);
			expect(derivedAfter.baselineDirection).toBe(
				derivedBefore.baselineDirection,
			);

			reindexReviewBudget(records, index, "empty");
			expect(index.getBaseline("empty")).toBeNull();
			expect(index.listSnapshots("empty")).toEqual([]);
		} finally {
			db.close();
		}
	});
});
