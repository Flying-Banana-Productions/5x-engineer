import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDeliveryBudget } from "../../../src/parsers/delivery-budget.js";
import { parsePlan } from "../../../src/parsers/plan.js";
import { readAuthoritativeBudget } from "../../../src/plan-schema/authority.js";
import {
	diagnosePlanExecutability,
	planChecklistRepair,
} from "../../../src/plan-schema/checklist-repair.js";
import { loadPlanDocument } from "../../../src/plan-schema/document.js";
import { reconcileFinalApprovalLedger } from "../../../src/review-governance/plan-approval-finalization.js";

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

// ---------------------------------------------------------------------------
// Plan 217 phase 5: compact issue plans pass executability as written, and
// mechanical repair / approval finalization preserve the issue-plan contract.
// ---------------------------------------------------------------------------

/** The fixture with its phase task markers removed (the incident shape). */
const UNMARKED = FIXTURE.replace(/^- \[[ xX]\] /gm, "- ");

/** The `## Issue Coverage` section through the next `## ` heading. */
function issueCoverage(raw: string): string {
	const start = raw.indexOf("## Issue Coverage");
	const end = raw.indexOf("\n## ", start + 1);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return raw.slice(start, end);
}

/** Lines that differ, as [before, after] pairs. Inputs have equal line counts. */
function changedLines(before: string, after: string): Array<[string, string]> {
	const a = before.split("\n");
	const b = after.split("\n");
	expect(b).toHaveLength(a.length);
	const pairs: Array<[string, string]> = [];
	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) {
			pairs.push([a[index] as string, b[index] as string]);
		}
	}
	return pairs;
}

function budgetOf(raw: string) {
	const parsed = parseDeliveryBudget(raw);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed));
	return parsed.value;
}

const AC_ID = /^AC\d+$/;

describe("compact issue plan executability and repair (plan 217 phase 5)", () => {
	test("the compact fixture is executable as written: one phase, prose gate, no filler", () => {
		const diagnosed = diagnosePlanExecutability(FIXTURE, 1);
		if (!diagnosed.ok) throw new Error(diagnosed.message);
		const { result } = diagnosed;
		expect(result.executable).toBe(true);
		expect(result.schema).toBe(1);
		expect(result.diagnostics).toEqual([]);
		expect(result.phases.map((phase) => [phase.id, phase.items])).toEqual([
			["1", 2],
		]);
		// No filler phases, timeline, or full-skeleton sections are required.
		expect(FIXTURE).not.toContain("## Estimated Timeline");
		expect(FIXTURE).not.toContain("## Executive Summary");
		// The prose completion gate stays prose.
		expect(FIXTURE).toMatch(/^\*\*Completion gate:\*\* The precedence/m);
		// No mechanical candidate is proposed for a valid plan.
		const candidate = planChecklistRepair({
			anchorBytes: FIXTURE,
			currentBytes: FIXTURE,
			schema: 1,
		});
		if (!candidate.ok) throw new Error(candidate.message);
		expect(candidate.edits).toEqual([]);
		expect(candidate.unresolved).toEqual([]);
		expect(candidate.targetBytes).toBe(FIXTURE);
	});

	test("without task markers the phase is diagnosed with a deterministic draft repair", () => {
		expect(UNMARKED).not.toBe(FIXTURE);
		const diagnosed = diagnosePlanExecutability(UNMARKED, 1);
		if (!diagnosed.ok) throw new Error(diagnosed.message);
		expect(diagnosed.result.executable).toBe(false);
		const errors = diagnosed.result.diagnostics.filter(
			(entry) => entry.severity === "error",
		);
		expect(
			errors.map((entry) => [entry.code, entry.phase, entry.repair]),
		).toEqual([["PLAN_PHASE_NO_CHECKLIST", "1", "mechanical"]]);
		// Ordinary bullets elsewhere (Not In Scope) are not diagnosed.
		expect(
			diagnosed.result.diagnostics.every((entry) => entry.phase === "1"),
		).toBe(true);
	});

	test("the draft repair restores exactly the fixture and changes only list prefixes", () => {
		// File form: the draft is its own anchor.
		const repaired = planChecklistRepair({
			anchorBytes: UNMARKED,
			currentBytes: UNMARKED,
			schema: 1,
		});
		if (!repaired.ok) throw new Error(repaired.message);
		expect(repaired.unresolved).toEqual([]);
		expect(repaired.resetChecked).toEqual([]);
		expect(repaired.edits.map((edit) => edit.phase)).toEqual(["1", "1"]);
		expect(repaired.edits.every((edit) => edit.topLevel)).toBe(true);
		for (const edit of repaired.edits) {
			expect(edit.after).toBe(edit.before.replace(/^- /, "- [ ] "));
		}
		// Byte-identical to the original compact plan: nothing else moved.
		expect(repaired.targetBytes).toBe(FIXTURE);
		for (const [before, after] of changedLines(
			UNMARKED,
			repaired.targetBytes,
		)) {
			expect(after).toBe(before.replace(/^- /, "- [ ] "));
		}

		const after = diagnosePlanExecutability(repaired.targetBytes, 1);
		if (!after.ok) throw new Error(after.message);
		expect(after.result.executable).toBe(true);
		const loaded = loadPlanDocument(repaired.targetBytes, 1);
		if (!loaded.ok) throw new Error(loaded.message);
		const plan = parsePlan(loaded.document.authorityMarkdown);
		expect(plan.phases).toHaveLength(1);
		expect(plan.phases[0]?.items.map((item) => item.checked)).toEqual([
			false,
			false,
		]);
	});

	test("repair preserves the pinned brief, verbatim ACn rows, mappings and carried assumptions", () => {
		const repaired = planChecklistRepair({
			anchorBytes: UNMARKED,
			currentBytes: UNMARKED,
			schema: 1,
		});
		if (!repaired.ok) throw new Error(repaired.message);
		const target = repaired.targetBytes;
		expect(issueCoverage(target)).toBe(issueCoverage(FIXTURE));
		const sourceBrief = FIXTURE.split("\n").find((line) =>
			line.startsWith("Source brief: "),
		);
		expect(sourceBrief).toBe(
			"Source brief: docs/development/issues/218-issue-42-override-precedence/brief.md at 0123456789abcdef0123456789abcdef01234567",
		);
		expect(target.split("\n")).toContain(sourceBrief as string);
		for (const row of [
			"| github.com/OWNER/REPO#42 | AC1: project override wins over a user-level value | W1 / Phase 1 | Precedence regression test |",
			"| github.com/OWNER/REPO#42 | AC2: environment variables still win over both | W1 / Phase 1 | Existing env precedence test still passes |",
		]) {
			expect(target.split("\n")).toContain(row);
		}
		// Carried assumption and exclusions survive untouched.
		expect(target).toContain(
			"**Brief assumption carried forward.** The brief assumes environment variables keep their current highest precedence; this plan does not change them.",
		);
		expect(target).toContain(
			"## Not In Scope\n\n- Changing environment-variable precedence.\n- Reworking the config file format.\n",
		);
		// Every edit is inside the phase; no Issue Coverage line is touched.
		const coverageLines = new Set(issueCoverage(FIXTURE).split("\n"));
		for (const edit of repaired.edits) {
			expect(coverageLines.has(edit.before)).toBe(false);
		}
	});

	test("repaired and finalized ledgers keep review-finding IDs alone in Addresses", () => {
		const repaired = planChecklistRepair({
			anchorBytes: UNMARKED,
			currentBytes: UNMARKED,
			schema: 1,
		});
		if (!repaired.ok) throw new Error(repaired.message);
		const original = budgetOf(FIXTURE);
		const afterRepair = budgetOf(repaired.targetBytes);
		expect(afterRepair).toEqual(original);
		expect(budgetOf(UNMARKED)).toEqual(original);
		for (const item of afterRepair.workItems) {
			expect(item.addresses.filter((id) => AC_ID.test(id))).toEqual([]);
		}

		// A ready approval finalizes the same ledger with no bookkeeping.
		const ready = reconcileFinalApprovalLedger({
			reviewed: original,
			final: afterRepair,
			admittedFindingIds: [],
		});
		if (!ready.ok) throw new Error(JSON.stringify(ready.changes));
		expect(ready.ledger).toEqual(original);
		expect(ready.addressAdditions).toEqual([]);
		expect(ready.effortCorrections).toEqual([]);

		// A final-corrections pass may add an admitted review-finding ID ...
		const withFinding = repaired.targetBytes.replace(
			"| 1 | 0 | - | - | One function",
			"| 1 | 0 | - | P1.1 | One function",
		);
		expect(withFinding).not.toBe(repaired.targetBytes);
		const corrected = reconcileFinalApprovalLedger({
			reviewed: original,
			final: budgetOf(withFinding),
			admittedFindingIds: ["P1.1"],
		});
		if (!corrected.ok) throw new Error(JSON.stringify(corrected.changes));
		expect(corrected.addressAdditions).toEqual([
			{ workItemId: "W1", findingIds: ["P1.1"] },
		]);
		expect(issueCoverage(withFinding)).toBe(issueCoverage(FIXTURE));

		// ... but an acceptance-criterion ID is never admitted bookkeeping.
		const withCriterion = repaired.targetBytes.replace(
			"| 1 | 0 | - | - | One function",
			"| 1 | 0 | - | AC1 | One function",
		);
		const rejected = reconcileFinalApprovalLedger({
			reviewed: original,
			final: budgetOf(withCriterion),
			admittedFindingIds: ["P1.1"],
		});
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.changes.length).toBeGreaterThan(0);
	});
});
