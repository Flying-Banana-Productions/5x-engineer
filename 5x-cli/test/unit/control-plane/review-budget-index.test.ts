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
import { recordedEnvelope } from "../../../src/control-plane/record-types.js";
import { runMigrations } from "../../../src/db/schema.js";
import { deriveBudget } from "../../../src/review-budget/arithmetic.js";
import {
	encodeImplementationSemanticAmendmentPayload,
	type ImplementationSemanticAmendmentPayload,
} from "../../../src/review-budget/record-lines.js";
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
				mode: "advisory",
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

			const amendment: ImplementationSemanticAmendmentPayload = {
				kind: "implementation-plan-amendment",
				version: 1,
				id: "rev-1",
				bindingId: "binding-1",
				executionRunId: "run1",
				predecessorRevisionId: "binding-1",
				authorizationId: "11111111-1111-4111-8111-111111111111",
				humanStep: { idempotencyKey: "step:human" },
				approvalStep: { idempotencyKey: "step:approval" },
				parentLineageId: null,
				beforeCommit: "a".repeat(40),
				afterCommit: "b".repeat(40),
				beforeBlobHash: `sha256:${"ab".repeat(32)}`,
				afterBlobHash: `sha256:${"cd".repeat(32)}`,
				approvedPlanCommit: "b".repeat(40),
				approvedPlanHash: `sha256:${"cd".repeat(32)}`,
				approvedPlanBytes: "plan",
				earliestAffectedPhase: "2",
				preservedPhases: [],
				resolvedFindings: [],
				claimEdits: [],
				invalidatedContextIds: [],
				invalidatedObservationIds: [],
				intentDigest: `sha256:${"ef".repeat(32)}`,
				createdAt: "2026-10-19T00:00:00.000Z",
			};
			records.append({
				runId: "run1",
				stream: "budget",
				idempotencyKey: "budget:implementation-plan-amendment:binding-1:rev-1",
				payload: encodeImplementationSemanticAmendmentPayload(amendment),
				...recordedEnvelope(origin),
			});
			records.append({
				runId: "run1",
				stream: "budget",
				idempotencyKey: "budget:implementation-plan-amendment:future",
				payload: { kind: "implementation-plan-amendment", version: 2 },
				...recordedEnvelope(origin),
			});
			reindexReviewBudget(records, index, "run1");
			expect(index.listSnapshots("run1")).toHaveLength(1);
			expect(index.getBaseline("run1")?.id).toBe(rebuiltBaseline?.id);
		} finally {
			db.close();
		}
	});
});
