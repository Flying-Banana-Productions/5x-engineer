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
		expect(publicApi.isCompleteDebtClaimEvidence).toBeFunction();
		expect(publicApi.EFFORT_POINTS).toEqual([1, 2, 3, 5, 8]);
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

	test("keeps plan-budget types free of implementation realization fields", () => {
		const types = readFileSync(
			join(import.meta.dir, "../../../src/review-budget/types.ts"),
			"utf8",
		);
		expect(types).not.toMatch(/credit[-_A-Za-z]*realization/i);
		expect(types).not.toContain("planImpact");
		expect(types).toContain(
			'export type PlanScopeClass =\n\t| "acceptance_required"\n\t| "risk_reduction"\n\t| "polish";',
		);
		const protocol = readFileSync(
			join(import.meta.dir, "../../../src/protocol.ts"),
			"utf8",
		);
		expect(protocol).toMatch(/credit[-_A-Za-z]*realization/i);
		expect(protocol).toContain("planImpact");
		const command = readFileSync(
			join(import.meta.dir, "../../../src/commands/protocol.ts"),
			"utf8",
		);
		expect(command).toMatch(/credit[-_A-Za-z]*realization/i);
	});
});
