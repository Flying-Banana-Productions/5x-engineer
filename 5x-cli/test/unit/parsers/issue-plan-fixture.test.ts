import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import { parsePlan } from "../../../src/parsers/plan.js";
import { readAuthoritativeBudget } from "../../../src/plan-schema/authority.js";
import { loadPlanDocument } from "../../../src/plan-schema/document.js";

const FIXTURE = readFileSync(
	resolve(import.meta.dir, "../../fixtures/issue-resolution/compact-plan.md"),
	"utf-8",
);

describe("compact issue-resolution plan fixture", () => {
	test("loads as a schema 1 document with Issue Coverage inside the contract", () => {
		const loaded = loadPlanDocument(FIXTURE, 1);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.document.schema).toBe(1);
		const governing = loaded.document.governingLines.join("\n");
		expect(governing).toContain("## Issue Coverage");
		expect(governing).toMatch(
			/^Source brief: \S+\/brief\.md at [0-9a-f]{40}$/m,
		);
		expect(governing).toContain(
			"| github.com/OWNER/REPO#42 | AC1: project override wins over a user-level value | W1 / Phase 1 | Precedence regression test |",
		);
		expect(governing).not.toContain("## Revision History");
	});

	test("parses exactly one phase with its gate and checklist", () => {
		const loaded = loadPlanDocument(FIXTURE, 1);
		if (!loaded.ok) throw new Error(loaded.message);
		const plan = parsePlan(loaded.document.authorityMarkdown);
		expect(plan.phases.map((phase) => phase.number)).toEqual(["1"]);
		const [phase] = plan.phases;
		expect(phase?.completionGate).toContain("precedence regression test");
		expect(phase?.items).toHaveLength(2);
		expect(phase?.items.every((item) => !item.checked)).toBe(true);
	});

	test("Delivery Budget parses with stable IDs, no totals, and criteria kept out of Addresses", () => {
		const parsed = parseDeliveryBudget(FIXTURE);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.workItems.map((item) => item.id)).toEqual(["W1"]);
		expect(parsed.value.workItems[0]?.addresses).toEqual([]);
		expect(parsed.value.surface.productionFiles).toBe(1);
		expect(FIXTURE).not.toMatch(/\btotal\b/i);

		const authoritative = readAuthoritativeBudget(FIXTURE, 1);
		expect(authoritative.ok).toBe(true);
		if (!authoritative.ok) return;
		expect(authoritative.parsed.ok).toBe(true);
	});

	test("contains no fenced heading or checklist lines", () => {
		let inFence = false;
		const fenced: string[] = [];
		for (const line of FIXTURE.split("\n")) {
			if (line.trimStart().startsWith("```")) {
				inFence = !inFence;
				continue;
			}
			if (inFence) fenced.push(line);
		}
		expect(fenced.some((line) => /^\s*#/.test(line))).toBe(false);
		expect(fenced.some((line) => /\[[ xX]\]/.test(line))).toBe(false);
	});
});
