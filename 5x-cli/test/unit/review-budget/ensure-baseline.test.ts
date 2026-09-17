import { describe, expect, test } from "bun:test";
import {
	createMemoryRecordStore,
	createReviewBudgetStore,
	type RecordOrigin,
	RUN_RECORD_FORMAT_VERSION,
} from "../../../src/control-plane/index.js";
import { ensurePlanReviewBaseline } from "../../../src/review-budget/ensure-baseline.js";
import {
	DEFAULT_REVIEW_BUDGET_CONFIG,
	type ReviewBudgetConfig,
} from "../../../src/review-budget/types.js";

const plan = `## Delivery Budget
- Estimate confidence: high
| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | Work | 2 | 0 | - | - | Needed |
### Surface Snapshot
- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0`;
const config: ReviewBudgetConfig = {
	mode: "advisory",
	...DEFAULT_REVIEW_BUDGET_CONFIG,
};

function setup(origin: RecordOrigin) {
	const records = createMemoryRecordStore();
	records.putRun({
		id: "run1",
		plan_path: "plan.md",
		config_json: null,
		created_at: "2026-01-01 00:00:00",
		sealed_at: null,
		status: "active",
		final_head_commit: null,
		cli_version: "test",
		format_version: RUN_RECORD_FORMAT_VERSION,
		creator: origin.recorder,
	});
	return { records, store: createReviewBudgetStore(records) };
}

describe("ensurePlanReviewBaseline", () => {
	test("captures once with the caller-supplied system origin", () => {
		const origin: RecordOrigin = {
			recorder: { installation_id: "11111111-1111-4111-8111-111111111111" },
			performer: { kind: "system", role: "cli" },
		};
		const { records, store } = setup(origin);
		const first = ensurePlanReviewBaseline({
			runId: "run1",
			planMarkdown: plan,
			config,
			store,
			hasPriorPlanReviewerStep: false,
			optIn: false,
			origin,
			warn: () => {},
		});
		expect(first.status).toBe("captured");
		expect(records.listLines("run1", "budget")[0]?.origin).toEqual(origin);
		const second = ensurePlanReviewBaseline({
			runId: "run1",
			planMarkdown: "broken",
			config,
			store,
			hasPriorPlanReviewerStep: false,
			optIn: false,
			origin,
			warn: () => {
				throw new Error("must not warn");
			},
		});
		expect(second).toEqual({ status: "skipped", reason: "already" });
		expect(records.listLines("run1", "budget")).toHaveLength(1);
	});

	test("agent safety-net origin and enforced warning are preserved", () => {
		const origin: RecordOrigin = {
			recorder: { installation_id: "22222222-2222-4222-8222-222222222222" },
			performer: { kind: "agent", role: "reviewer", provider: "cursor" },
		};
		const { records, store } = setup(origin);
		const warnings: string[] = [];
		ensurePlanReviewBaseline({
			runId: "run1",
			planMarkdown: plan,
			config: { ...config, mode: "enforced" },
			store,
			hasPriorPlanReviewerStep: false,
			optIn: false,
			origin,
			warn: (message) => warnings.push(message),
		});
		expect(warnings).toHaveLength(1);
		expect(records.listLines("run1", "budget")[0]?.origin).toEqual(origin);
	});

	test("missing section fails without an unattributed line", () => {
		const origin: RecordOrigin = {
			recorder: { installation_id: "33333333-3333-4333-8333-333333333333" },
			performer: { kind: "system", role: "cli" },
		};
		const { records, store } = setup(origin);
		expect(
			ensurePlanReviewBaseline({
				runId: "run1",
				planMarkdown: "# no budget",
				config,
				store,
				hasPriorPlanReviewerStep: false,
				optIn: false,
				origin,
				warn: () => {},
			}),
		).toMatchObject({
			status: "error",
			code: "BUDGET_SECTION_MISSING",
			message: expect.stringContaining("author preflight"),
		});
		expect(records.listLines("run1", "budget")).toHaveLength(0);
	});

	test("mode off skips parsing and warning", () => {
		const origin: RecordOrigin = {
			recorder: { installation_id: "44444444-4444-4444-8444-444444444444" },
			performer: { kind: "system", role: "cli" },
		};
		const { records, store } = setup(origin);
		const result = ensurePlanReviewBaseline({
			runId: "run1",
			planMarkdown: "not a budget",
			config: { ...config, mode: "off" },
			store,
			hasPriorPlanReviewerStep: false,
			optIn: false,
			origin,
			warn: () => {
				throw new Error("must not warn");
			},
		});
		expect(result).toEqual({ status: "skipped", reason: "off" });
		expect(records.listLines("run1", "budget")).toHaveLength(0);
	});

	test("prior review remains v1-compatible unless explicitly opted in", () => {
		const origin: RecordOrigin = {
			recorder: { installation_id: "55555555-5555-4555-8555-555555555555" },
			performer: { kind: "system", role: "cli" },
		};
		const { records, store } = setup(origin);
		expect(
			ensurePlanReviewBaseline({
				runId: "run1",
				planMarkdown: plan,
				config,
				store,
				hasPriorPlanReviewerStep: true,
				optIn: false,
				origin,
				warn: () => {},
			}),
		).toEqual({ status: "skipped", reason: "v1_compat" });
		const optedIn = ensurePlanReviewBaseline({
			runId: "run1",
			planMarkdown: plan,
			config,
			store,
			hasPriorPlanReviewerStep: true,
			optIn: true,
			origin,
			warn: () => {},
		});
		expect(optedIn.status).toBe("captured");
		expect(store.getBaseline("run1")?.captureKind).toBe("opt_in");
		expect(records.listLines("run1", "budget")).toHaveLength(1);
	});

	test("opt-in is rejected outside a baseline-less mid-review run", () => {
		const origin: RecordOrigin = {
			recorder: { installation_id: "66666666-6666-4666-8666-666666666666" },
			performer: { kind: "system", role: "cli" },
		};
		const { store } = setup(origin);
		expect(
			ensurePlanReviewBaseline({
				runId: "run1",
				planMarkdown: plan,
				config,
				store,
				hasPriorPlanReviewerStep: false,
				optIn: true,
				origin,
				warn: () => {},
			}),
		).toMatchObject({
			status: "error",
			code: "BUDGET_BASELINE_OPT_IN_INVALID",
		});
	});

	test("incomplete debt-claim evidence fails closed", () => {
		const origin: RecordOrigin = {
			recorder: { installation_id: "77777777-7777-4777-8777-777777777777" },
			performer: { kind: "system", role: "cli" },
		};
		const { store } = setup(origin);
		const incomplete = plan.replace(
			"| W1 | Work | 2 | 0 | - | - | Needed |",
			"| W1 | Work | 2 | -1 | DC0 (`intrinsic`) | - | Needed |",
		);
		expect(
			ensurePlanReviewBaseline({
				runId: "run1",
				planMarkdown: incomplete,
				config,
				store,
				hasPriorPlanReviewerStep: false,
				optIn: false,
				origin,
				warn: () => {},
			}),
		).toMatchObject({
			status: "error",
			code: "BUDGET_DEBT_CLAIM_EVIDENCE_MISSING",
		});
	});

	test("enforced mode warns only when this call wins capture", () => {
		const origin: RecordOrigin = {
			recorder: { installation_id: "88888888-8888-4888-8888-888888888888" },
			performer: { kind: "system", role: "cli" },
		};
		const { store } = setup(origin);
		const warnings: string[] = [];
		const input = {
			runId: "run1",
			planMarkdown: plan,
			config: { ...config, mode: "enforced" } as ReviewBudgetConfig,
			store,
			hasPriorPlanReviewerStep: false,
			optIn: false,
			origin,
			warn: (message: string) => warnings.push(message),
		};
		ensurePlanReviewBaseline(input);
		ensurePlanReviewBaseline(input);
		expect(warnings).toEqual([
			"reviewBudget.mode is enforced but enforcement is not implemented; recording advisory telemetry only",
		]);
	});
});
