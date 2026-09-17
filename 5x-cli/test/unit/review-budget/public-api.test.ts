import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AppendSnapshotInput,
	AtomicAppendIfAllNewResult,
	BaselineAssessment,
	BudgetBaselinePayload,
	BudgetSnapshotPayload,
	CaptureBaselineInput,
	DebtClaimEvidence,
	ParsedWorkItem,
	ReviewBudgetStore,
} from "../../../src/index.js";
import * as publicApi from "../../../src/index.js";

function acceptsPublicTypes(_value: {
	append: AppendSnapshotInput;
	atomic: AtomicAppendIfAllNewResult;
	assessment: BaselineAssessment;
	baseline: BudgetBaselinePayload;
	capture: CaptureBaselineInput;
	claim: DebtClaimEvidence;
	item: ParsedWorkItem;
	snapshot: BudgetSnapshotPayload;
	store: ReviewBudgetStore;
}): void {}

void acceptsPublicTypes;

describe("review-budget public API", () => {
	test("exports domain operations, record facade, repair, and ids", () => {
		expect(publicApi.parseDeliveryBudget).toBeFunction();
		expect(publicApi.deriveBudget).toBeFunction();
		expect(publicApi.createReviewBudgetStore).toBeFunction();
		expect(publicApi.reindexReviewBudget).toBeFunction();
		expect(publicApi.createReviewBudgetId).toBeFunction();
	});

	test("does not expose SQLite index construction as public authority", () => {
		expect("createReviewBudgetIndex" in publicApi).toBe(false);
		const source = readFileSync(
			join(import.meta.dir, "../../../src/index.ts"),
			"utf8",
		);
		expect(source).not.toContain(
			'from "./control-plane/review-budget-index.js"',
		);
		expect(source).not.toContain('from "bun:sqlite"');
	});

	test("does not leak implementation-review governance fields", () => {
		for (const relative of [
			"../../../src/review-budget/types.ts",
			"../../../src/protocol.ts",
			"../../../src/commands/protocol.ts",
		]) {
			const source = readFileSync(join(import.meta.dir, relative), "utf8");
			expect(source).not.toMatch(/credit[-_A-Za-z]*realization/i);
			expect(source).not.toContain("planImpact");
		}
		const types = readFileSync(
			join(import.meta.dir, "../../../src/review-budget/types.ts"),
			"utf8",
		);
		expect(types).toContain(
			'export type PlanScopeClass =\n\t| "acceptance_required"\n\t| "risk_reduction"\n\t| "polish";',
		);
	});
});
