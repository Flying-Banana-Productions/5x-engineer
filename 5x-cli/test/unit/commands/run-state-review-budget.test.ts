import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	buildReviewBudgetState,
	formatStateText,
	tryBuildReviewBudgetState,
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

function planMarkdown(effort = 5): string {
	return `# Plan

## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Feature | ${effort} | 0 | - | - | required |

### Surface Snapshot

- Subsystems: 1
- Production files: 2
- Persistent/external boundaries: 0
`;
}

function fixture(
	options: {
		withSnapshot?: boolean;
		semanticHumanRequired?: boolean;
		cacheDerived?: boolean;
	} = {},
) {
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
		mode: "advisory",
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
		semanticHumanRequired: options.semanticHumanRequired ?? false,
	});
	if (options.withSnapshot !== false) {
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
			...(options.cacheDerived === false ? {} : { derived }),
		});
	}
	return { db, store };
}

describe("run state review budget", () => {
	test("uses a pinned baseline when current mode is off and reports v1 compatibility", () => {
		const { db, store } = fixture();
		try {
			expect(
				buildReviewBudgetState({
					runId: "run1",
					mode: "off",
					store,
					hasPriorPlanReviewerStep: false,
				}),
			).toMatchObject({
				status: "active",
				mode: "advisory",
				enforcement_implemented: false,
			});
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
					hasPriorPlanReviewerStep: false,
				}),
			).toEqual({
				status: "uninitialized",
				mode: "advisory",
				enforcement_implemented: false,
			});
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

	test("reconstructs authoritative I, direction, and semantic human flag after index wipe", () => {
		const { db, store } = fixture({ semanticHumanRequired: true });
		try {
			const before = buildReviewBudgetState({
				runId: "run1",
				mode: "advisory",
				store,
				hasPriorPlanReviewerStep: true,
				semanticHumanRequiredFor: () => true,
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
				semanticHumanRequiredFor: () => true,
			});
			expect(after?.I).toBe(before?.I);
			expect(after?.baseline_direction).toBe(before?.baseline_direction);
			expect(after?.W).toBe(5);
			expect(after?.requires_human).toBe(before?.requires_human);
			expect(after?.requires_human).toBe(true);
			expect(
				db.query("SELECT count(*) AS n FROM review_budget_snapshots").get(),
			).toEqual({ n: 1 });
		} finally {
			db.close();
		}
	});

	test("recomputes a null-derived cache row with semantic human-required", () => {
		const { db, store } = fixture({
			semanticHumanRequired: true,
			cacheDerived: false,
		});
		try {
			const state = buildReviewBudgetState({
				runId: "run1",
				mode: "advisory",
				store,
				hasPriorPlanReviewerStep: true,
				semanticHumanRequiredFor: () => true,
			});
			expect(state?.I).toBe(8);
			expect(state?.baseline_direction).toBe("understated");
			expect(state?.requires_human).toBe(true);
		} finally {
			db.close();
		}
	});

	test("active pre-first-record uses live plan and falls back to original ledger", () => {
		const { db, store } = fixture({ withSnapshot: false });
		try {
			const live = buildReviewBudgetState({
				runId: "run1",
				mode: "advisory",
				store,
				hasPriorPlanReviewerStep: false,
				currentPlanMarkdown: planMarkdown(8),
			});
			expect(live?.status).toBe("active");
			expect(live?.W).toBe(8);
			expect(live?.R).toBe(0);
			const fallback = buildReviewBudgetState({
				runId: "run1",
				mode: "advisory",
				store,
				hasPriorPlanReviewerStep: false,
				currentPlanMarkdown: "# malformed plan",
			});
			expect(fallback?.W).toBe(5);
		} finally {
			db.close();
		}
	});

	test("marks only a changed current plan stale", () => {
		const { db, store } = fixture();
		try {
			const matching = buildReviewBudgetState({
				runId: "run1",
				mode: "advisory",
				store,
				hasPriorPlanReviewerStep: true,
				currentPlanMarkdown: planMarkdown(5),
			});
			expect(matching?.stale_plan).toBeUndefined();
			const changed = buildReviewBudgetState({
				runId: "run1",
				mode: "advisory",
				store,
				hasPriorPlanReviewerStep: true,
				currentPlanMarkdown: planMarkdown(8),
			});
			expect(changed?.stale_plan).toBe(true);
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

	test("text formatter labels non-active and enforced telemetry honestly", () => {
		const lines: string[] = [];
		const original = console.log;
		console.log = (...args: unknown[]) => lines.push(String(args[0] ?? ""));
		try {
			formatStateText({
				run: {
					id: "run1",
					plan_path: "/plan.md",
					status: "active",
					created_at: "now",
					updated_at: "now",
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
				max_steps: 1,
				steps_remaining: 1,
				review_budget: {
					status: "v1_compat",
					mode: "enforced",
					enforcement_implemented: false,
				},
			});
			expect(lines.join("\n")).toContain("status=v1_compat");
			expect(lines.join("\n")).toContain(
				"enforced: deterministic governance routing active",
			);
			expect(lines.join("\n")).not.toContain("(enforced)");
		} finally {
			console.log = original;
		}
	});

	test("text formatter includes stale-plan suffix", () => {
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
				currentPlanMarkdown: planMarkdown(8),
			});
			if (!reviewBudget) throw new Error("missing review budget fixture");
			formatStateText({
				run: {
					id: "run1",
					plan_path: "/plan.md",
					status: "active",
					created_at: "now",
					updated_at: "now",
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
				max_steps: 1,
				steps_remaining: 1,
				review_budget: reviewBudget,
			});
			expect(lines.join("\n")).toContain("stale plan");
		} finally {
			console.log = original;
			db.close();
		}
	});

	test("malformed record payload warns and omits review_budget", () => {
		const warnings: string[] = [];
		const state = tryBuildReviewBudgetState(
			{
				runId: "broken",
				mode: "advisory",
				store: {
					getBaseline: () => {
						throw new Error("invalid baseline payload");
					},
				} as never,
				hasPriorPlanReviewerStep: false,
			},
			(message) => warnings.push(message),
		);
		expect(state).toBeUndefined();
		expect(warnings[0]).toContain("run broken");
		expect(warnings[0]).toContain("omitting review_budget");
	});

	test("warns for reserved enforced mode only", () => {
		const warnings: string[] = [];
		warnForReviewBudgetRunState("advisory", (warning) =>
			warnings.push(warning),
		);
		warnForReviewBudgetRunState("enforced", (warning) =>
			warnings.push(warning),
		);
		expect(warnings).toEqual([]);
	});
});
