import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	buildReviewBudgetState,
	formatStateText,
	warnForReviewBudgetRunState,
} from "../../../src/commands/run-v1.handler.js";
import {
	createMemoryRecordStore,
	createReviewBudgetIndex,
	createReviewBudgetStore,
	type RecordOrigin,
} from "../../../src/control-plane/index.js";
import { runMigrations } from "../../../src/db/schema.js";
import { deriveBudget } from "../../../src/review-budget/arithmetic.js";
import {
	DEFAULT_REVIEW_BUDGET_CONFIG,
	type ParsedDeliveryBudget,
} from "../../../src/review-budget/types.js";

const origin: RecordOrigin = {
	recorder: { installation_id: "22222222-2222-4222-8222-222222222222" },
	performer: { kind: "agent", role: "reviewer" },
};

const ledger: ParsedDeliveryBudget = {
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
		productionFiles: 2,
		persistentOrExternalBoundaries: 0,
	},
};

function fixture() {
	const db = new Database(":memory:");
	runMigrations(db);
	db.exec("INSERT INTO runs(id, plan_path) VALUES ('run1', '/plan.md')");
	const records = createMemoryRecordStore();
	records.putRun({
		id: "run1",
		plan_path: "/plan.md",
		config_json: null,
		created_at: "2026-09-17 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "1.3.0",
		format_version: 1,
		creator: origin.recorder,
	});
	const index = createReviewBudgetIndex(db);
	const store = createReviewBudgetStore(records, index);
	const baseline = store.captureBaseline({
		runId: "run1",
		captureKind: "initial",
		parsed: ledger,
		configSnapshot: DEFAULT_REVIEW_BUDGET_CONFIG,
		origin,
	}).baseline;
	const derived = deriveBudget({
		B0: baseline.b0,
		B: baseline.b,
		I: 8,
		workItems: ledger.workItems,
		findings: [],
		assessments: [],
		config: baseline.configSnapshot,
		semanticHumanRequired: false,
	});
	store.appendSnapshot({
		runId: "run1",
		stepName: "reviewer:plan",
		phase: "plan",
		iteration: 1,
		currentLedger: ledger,
		findings: [],
		assessments: [],
		baselineAssessment: {
			independentEffortEstimate: 8,
			confidence: "medium",
			reason: "independent estimate",
		},
		derived,
	});
	return { db, store };
}

describe("run state review budget", () => {
	test("omits review_budget when mode is off and reports v1 compatibility", () => {
		const { db, store } = fixture();
		try {
			expect(
				buildReviewBudgetState({
					runId: "run1",
					mode: "off",
					store,
					hasPriorPlanReviewerStep: false,
				}),
			).toBeUndefined();
			const emptyRecords = createMemoryRecordStore();
			emptyRecords.putRun({
				id: "legacy",
				plan_path: "/legacy.md",
				config_json: null,
				created_at: "2026-09-17 00:00:00",
				sealed_at: null,
				status: "active",
				final_head_commit: null,
				cli_version: "1.3.0",
				format_version: 1,
				creator: origin.recorder,
			});
			const emptyStore = createReviewBudgetStore(emptyRecords);
			expect(
				buildReviewBudgetState({
					runId: "legacy",
					mode: "advisory",
					store: emptyStore,
					hasPriorPlanReviewerStep: true,
				}),
			).toEqual({
				status: "v1_compat",
				mode: "advisory",
				enforcement_implemented: false,
			});
		} finally {
			db.close();
		}
	});

	test("reconstructs authoritative I and direction after the index is wiped", () => {
		const { db, store } = fixture();
		try {
			const before = buildReviewBudgetState({
				runId: "run1",
				mode: "advisory",
				store,
				hasPriorPlanReviewerStep: true,
			});
			expect(before?.status).toBe("active");
			expect(before?.I).toBe(8);
			expect(before?.baseline_direction).toBe("understated");

			db.exec("DELETE FROM review_budget_snapshots");
			db.exec("DELETE FROM review_budget_baselines");
			const after = buildReviewBudgetState({
				runId: "run1",
				mode: "advisory",
				store,
				hasPriorPlanReviewerStep: true,
			});
			expect(after?.I).toBe(before?.I);
			expect(after?.baseline_direction).toBe(before?.baseline_direction);
			expect(after?.W).toBe(5);
			expect(
				db.query("SELECT count(*) AS n FROM review_budget_snapshots").get(),
			).toEqual({ n: 1 });
		} finally {
			db.close();
		}
	});

	test("text formatter includes a compact Budget forecast", () => {
		const { db, store } = fixture();
		const lines: string[] = [];
		const original = console.log;
		console.log = (...args: unknown[]) => lines.push(String(args[0] ?? ""));
		try {
			const reviewBudget = buildReviewBudgetState({
				runId: "run1",
				mode: "advisory",
				store,
				hasPriorPlanReviewerStep: true,
			});
			if (!reviewBudget) throw new Error("missing review budget fixture");
			formatStateText({
				run: {
					id: "run1",
					plan_path: "/plan.md",
					status: "active",
					created_at: "2026-09-17 00:00:00",
					updated_at: "2026-09-17 00:00:00",
				},
				steps: [],
				summary: {
					total_steps: 0,
					phases_completed: [],
					total_tokens_in: 0,
					total_tokens_out: 0,
					total_cost_usd: 0,
					total_duration_ms: 0,
				},
				steps_used: 0,
				max_steps: 250,
				steps_remaining: 250,
				review_budget: reviewBudget,
			});
			expect(lines.some((line) => line.startsWith("Budget:"))).toBe(true);
			expect(lines.join("\n")).toContain("W+R=5");
		} finally {
			console.log = original;
			db.close();
		}
	});

	test("warns for reserved enforced mode only", () => {
		const warnings: string[] = [];
		warnForReviewBudgetRunState("advisory", (warning) =>
			warnings.push(warning),
		);
		warnForReviewBudgetRunState("enforced", (warning) =>
			warnings.push(warning),
		);
		expect(warnings).toEqual([
			"reviewBudget.mode is enforced but enforcement is not implemented; recording advisory telemetry only",
		]);
	});
});
