import { describe, expect, test } from "bun:test";
import {
	type DeliveryBudgetParseCode,
	incorporatedFindingIds,
	parseDeliveryBudget,
	rawDeliveryBudgetSection,
} from "../../../src/parsers/delivery-budget.js";

const CANONICAL = `# Plan

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Existing behavior | 3 | 0 | - | F0, F1 | Required behavior |
| W2 | Consolidate paths | 5 | -3 | DC0 (\`intrinsic\`) | - | Reduce coupling |

### Debt Claims

#### DC0

- Target phase: phase-2
- Minimal-compliant effort delta: 2
- Minimal-compliant architecture delta: 0
- Before: five independent proposal construction paths
- After: one invariant-enforcing proposal constructor

### Surface Snapshot

- Subsystems: 4
- Production files: 12
- Persistent/external boundaries: 1
- New shared abstractions or public contracts: 0

## Phase 1: Build

- [ ] Build it
`;

function expectFailure(markdown: string, code: DeliveryBudgetParseCode) {
	const result = parseDeliveryBudget(markdown);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error(`Expected ${code}`);
	expect(result.code).toBe(code);
	expect(result.line).toBeGreaterThan(0);
	expect(result.message).toContain(`Line ${result.line}`);
	return result;
}

function replaceOnce(from: string, to: string): string {
	expect(CANONICAL).toContain(from);
	return CANONICAL.replace(from, to);
}

describe("parseDeliveryBudget", () => {
	test("parses the canonical table and joins complete debt evidence", () => {
		const result = parseDeliveryBudget(CANONICAL);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.message);

		expect(result.value.estimateConfidence).toBe("medium");
		expect(result.value.workItems).toHaveLength(2);
		expect(result.value.workItems[1]?.debtClaim).toEqual({
			debtClaimId: "DC0",
			coupling: "intrinsic",
			targetPhase: "phase-2",
			minimalAlternativeEffortDelta: 2,
			minimalAlternativeArchitectureDelta: 0,
			before: "five independent proposal construction paths",
			after: "one invariant-enforcing proposal constructor",
		});
		expect(result.value.surface).toEqual({
			subsystems: 4,
			productionFiles: 12,
			persistentOrExternalBoundaries: 1,
			newSharedAbstractions: 0,
		});
		expect([...incorporatedFindingIds(result.value.workItems)]).toEqual([
			"F0",
			"F1",
		]);
	});

	test("extracts the exact section through its final bullet", () => {
		const section = rawDeliveryBudgetSection(CANONICAL);
		expect(section?.startsWith("## Delivery Budget\n")).toBe(true);
		expect(
			section?.endsWith("- New shared abstractions or public contracts: 0"),
		).toBe(true);
		expect(section).toContain("### Debt Claims");
		expect(section).not.toContain("## Phase 1");
		expect(rawDeliveryBudgetSection("# No budget")).toBeNull();
	});

	test("accepts case-insensitive confidence and split boundary aliases", () => {
		const markdown = replaceOnce("medium", "HIGH").replace(
			"- Persistent/external boundaries: 1",
			"- Persistent schemas or migrations: 2\n- External/platform boundaries: 3",
		);
		const result = parseDeliveryBudget(markdown);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(result.value.surface.persistentOrExternalBoundaries).toBe(5);
	});

	test("reports missing section", () => {
		expectFailure("# Plan\n\n## Phase 1: Build", "BUDGET_SECTION_MISSING");
	});

	test("reports invalid or missing confidence", () => {
		expectFailure(
			replaceOnce("medium", "certain"),
			"BUDGET_INVALID_CONFIDENCE",
		);
		expectFailure(
			replaceOnce("- Estimate confidence: medium\n", ""),
			"BUDGET_INVALID_CONFIDENCE",
		);
	});

	test("reports missing, empty, and malformed tables", () => {
		expectFailure(
			CANONICAL.replace(
				/\| ID \|[\s\S]*?\n\n### Debt Claims/,
				"### Debt Claims",
			),
			"BUDGET_TABLE_MISSING",
		);
		expectFailure(
			CANONICAL.replace(/\| W1[^\n]+\n\| W2[^\n]+\n/, ""),
			"BUDGET_TABLE_EMPTY",
		);
		expectFailure(
			replaceOnce("| ID | Work item |", "| Wrong | Work item |"),
			"BUDGET_TABLE_MALFORMED",
		);
		expectFailure(
			replaceOnce("|---|---|---:|---:|---|---|---|", "|---|---|"),
			"BUDGET_TABLE_MALFORMED",
		);
	});

	test("validates stable work-item IDs", () => {
		expectFailure(replaceOnce("| W1 |", "| task-1 |"), "BUDGET_INVALID_ID");
		expectFailure(replaceOnce("| W2 |", "| W1 |"), "BUDGET_DUPLICATE_ID");
	});

	test("validates effort and architecture allowed sets", () => {
		expectFailure(
			replaceOnce(
				"| W1 | Existing behavior | 3 |",
				"| W1 | Existing behavior | 4 |",
			),
			"BUDGET_INVALID_EFFORT",
		);
		const effort = expectFailure(
			replaceOnce(
				"| W1 | Existing behavior | 3 |",
				"| W1 | Existing behavior | 4 |",
			),
			"BUDGET_INVALID_EFFORT",
		);
		expect(effort.message).toContain("{1, 2, 3, 5, 8}");
		const architecture = expectFailure(
			replaceOnce("| 3 | 0 |", "| 3 | 4 |"),
			"BUDGET_INVALID_ARCHITECTURE",
		);
		expect(architecture.message).toContain("{0, ±1, ±2, ±3, ±5}");
	});

	test("requires valid claims only for negative architecture rows", () => {
		expectFailure(
			replaceOnce("DC0 (`intrinsic`)", "-"),
			"BUDGET_DEBT_CLAIM_REQUIRED",
		);
		expectFailure(
			replaceOnce("DC0 (`intrinsic`)", "DC0"),
			"BUDGET_INVALID_DEBT_CLAIM",
		);
		expectFailure(
			replaceOnce("| 3 | 0 | - |", "| 3 | 0 | DC1 (`intrinsic`) |"),
			"BUDGET_INVALID_DEBT_CLAIM",
		);
	});

	test("requires a matching Debt Claims subsection and block", () => {
		expectFailure(
			CANONICAL.replace(/### Debt Claims[\s\S]*?(?=### Surface Snapshot)/, ""),
			"BUDGET_DEBT_CLAIM_EVIDENCE_MISSING",
		);
		expectFailure(
			CANONICAL.replace(/#### DC0[\s\S]*?(?=### Surface Snapshot)/, ""),
			"BUDGET_DEBT_CLAIM_EVIDENCE_MISSING",
		);
	});

	test("validates target phase and minimal alternatives", () => {
		expectFailure(
			replaceOnce("phase-2", "review"),
			"BUDGET_INVALID_TARGET_PHASE",
		);
		expectFailure(
			replaceOnce(
				"Minimal-compliant effort delta: 2",
				"Minimal-compliant effort delta: 4",
			),
			"BUDGET_INVALID_MINIMAL_ALTERNATIVE",
		);
		expectFailure(
			replaceOnce(
				"Minimal-compliant architecture delta: 0",
				"Minimal-compliant architecture delta: 4",
			),
			"BUDGET_INVALID_MINIMAL_ALTERNATIVE",
		);
	});

	test("rejects empty or vague before and after evidence", () => {
		expectFailure(
			replaceOnce(
				"Before: five independent proposal construction paths",
				"Before:",
			),
			"BUDGET_DEBT_EVIDENCE_EMPTY",
		);
		expectFailure(
			replaceOnce(
				"After: one invariant-enforcing proposal constructor",
				"After: cleaner",
			),
			"BUDGET_DEBT_EVIDENCE_EMPTY",
		);
	});

	test("rejects orphan and duplicate debt claims", () => {
		const orphan = replaceOnce("#### DC0", "#### DC9");
		expectFailure(orphan, "BUDGET_DEBT_CLAIM_ORPHAN");
		const duplicateBlock = replaceOnce(
			"- After: one invariant-enforcing proposal constructor",
			"- After: one invariant-enforcing proposal constructor\n\n#### DC0\n\n- Target phase: 2",
		);
		expectFailure(duplicateBlock, "BUDGET_DUPLICATE_DEBT_CLAIM");
		const duplicateTableClaim = replaceOnce(
			"| W1 | Existing behavior | 3 | 0 | - | F0, F1 | Required behavior |",
			"| W1 | Existing behavior | 3 | -1 | DC0 (`intrinsic`) | F0, F1 | Required behavior |",
		);
		expectFailure(duplicateTableClaim, "BUDGET_DUPLICATE_DEBT_CLAIM");
	});

	test("validates Addresses tokens", () => {
		expectFailure(replaceOnce("F0, F1", "F0, , F1"), "BUDGET_TABLE_MALFORMED");
	});

	test("requires and validates the surface snapshot", () => {
		expectFailure(
			CANONICAL.replace(/### Surface Snapshot[\s\S]*?(?=\n## Phase 1)/, ""),
			"BUDGET_SNAPSHOT_MISSING",
		);
		expectFailure(
			replaceOnce("- Production files: 12", "- Production files: many"),
			"BUDGET_SNAPSHOT_INVALID",
		);
		expectFailure(
			replaceOnce("- Subsystems: 4\n", ""),
			"BUDGET_SNAPSHOT_MISSING",
		);
	});
});
