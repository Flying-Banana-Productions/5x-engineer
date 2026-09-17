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
			captureKind: "initial",
			origin,
			warn: () => {},
		});
		expect(first.ok).toBe(true);
		expect(records.listLines("run1", "budget")[0]?.origin).toEqual(origin);
		const second = ensurePlanReviewBaseline({
			runId: "run1",
			planMarkdown: "broken",
			config,
			store,
			captureKind: "opt_in",
			origin,
			warn: () => {
				throw new Error("must not warn");
			},
		});
		expect(second.ok).toBe(true);
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
			captureKind: "initial",
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
				captureKind: "initial",
				origin,
				warn: () => {},
			}),
		).toMatchObject({ ok: false, code: "BUDGET_SECTION_MISSING" });
		expect(records.listLines("run1", "budget")).toHaveLength(0);
	});
});
