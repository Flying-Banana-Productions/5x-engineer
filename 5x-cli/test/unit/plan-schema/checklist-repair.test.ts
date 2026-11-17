import { describe, expect, test } from "bun:test";
import { parsePlan } from "../../../src/parsers/plan.js";
import {
	checklistRepairDigest,
	introduceUncheckedMarker,
	mapSpanThroughChecklistRepair,
	planChecklistRepair,
	proveChecklistRepair,
	verifyRecordedChecklistRepair,
} from "../../../src/plan-schema/checklist-repair.js";
import { loadPlanDocument } from "../../../src/plan-schema/document.js";

const BUDGET = `## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Booking preview | 3 | 0 | - | - | Required |

### Surface Snapshot

- Subsystems: 1
- Production files: 2
- Persistent/external boundaries: 0
`;

/** Modeled on the incident: gate lists with nested children, no task markers. */
const INCIDENT = `# Booking modal preview

**Status:** Approved

${BUDGET}
## Phase 1: Preview model

**Completion gate:** Preview data is typed and covered.

- Add the preview type
  - include the member tier
- Map API fields
- Cover the mapper with tests

## Phase 2: Modal

**Completion gate:**

1. Render the modal
2. Wire the open action
   - keyboard focus returns on close

## Phase 3: Release

Ship notes.

## Not In Scope

- Billing changes
`;

function schema1(interior: string, outside = ""): string {
	return `<!-- 5x:plan-schema:1 -->\n**Status:** Approved\n<!-- 5x:contract:start -->\n${interior}<!-- 5x:contract:end -->\n${outside}`;
}

function counts(bytes: string, schema: 0 | 1 | "file" = "file"): number[] {
	const loaded = loadPlanDocument(bytes, schema);
	if (!loaded.ok) throw new Error(loaded.message);
	return parsePlan(loaded.document.authorityMarkdown).phases.map(
		(phase) => phase.items.length,
	);
}

describe("introduceUncheckedMarker", () => {
	test("bullets become '- [ ]' and ordered markers keep their number", () => {
		expect(introduceUncheckedMarker("- Add it")).toBe("- [ ] Add it");
		expect(introduceUncheckedMarker("* Add it")).toBe("- [ ] Add it");
		expect(introduceUncheckedMarker("12) Add it")).toBe("12. [ ] Add it");
		expect(introduceUncheckedMarker("  - nested")).toBe("  - [ ] nested");
		expect(introduceUncheckedMarker("- [x] done")).toBeNull();
		expect(introduceUncheckedMarker("plain prose")).toBeNull();
	});
});

describe("planChecklistRepair", () => {
	test("repairs the incident shape: top-level gate items only, nested preserved", () => {
		expect(counts(INCIDENT)).toEqual([0, 0, 0]);
		const plan = planChecklistRepair({
			anchorBytes: INCIDENT,
			currentBytes: INCIDENT,
			schema: "file",
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.edits.map((edit) => edit.after)).toEqual([
			"- [ ] Add the preview type",
			"- [ ] Map API fields",
			"- [ ] Cover the mapper with tests",
			"1. [ ] Render the modal",
			"2. [ ] Wire the open action",
		]);
		expect(plan.edits.every((edit) => edit.topLevel)).toBe(true);
		expect(plan.nestedPreserved).toBe(2);
		expect(counts(plan.targetBytes)).toEqual([3, 2, 0]);
		expect(plan.phases.map((p) => [p.id, p.itemsBefore, p.itemsAfter])).toEqual(
			[
				["1", 0, 3],
				["2", 0, 2],
				["3", 0, 0],
			],
		);
		expect(plan.unresolved).toEqual([
			expect.objectContaining({ phase: "3", kind: "needs_author" }),
		]);
		// Explanatory bullets outside phases (Not In Scope, budget) never change.
		expect(plan.targetBytes).toContain("- Billing changes");
		expect(plan.targetBytes).toContain("- Estimate confidence: high");
		// Every other byte is identical.
		const strict = proveChecklistRepair({
			beforeBytes: INCIDENT,
			afterBytes: plan.targetBytes,
			schema: 0,
		});
		expect(strict.ok).toBe(true);
	});

	test("an already edited candidate is verified against the anchor, including nested prefixes", () => {
		const edited = INCIDENT.replace(
			"- Add the preview type\n  - include the member tier",
			"- [ ] Add the preview type\n  - [ ] include the member tier",
		);
		const plan = planChecklistRepair({
			anchorBytes: INCIDENT,
			currentBytes: edited,
			schema: 0,
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.edits.map((edit) => edit.after)).toContain(
			"  - [ ] include the member tier",
		);
		expect(plan.edits.find((e) => e.after.includes("member"))?.topLevel).toBe(
			false,
		);
		expect(counts(plan.targetBytes)).toEqual([3, 2, 0]);
	});

	test("a manually introduced checked marker is previewed as a reset to unchecked", () => {
		const edited = INCIDENT.replace("- Map API fields", "- [x] Map API fields");
		const plan = planChecklistRepair({
			anchorBytes: INCIDENT,
			currentBytes: edited,
			schema: 0,
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.resetChecked).toEqual([
			expect.objectContaining({
				proposed: "- [x] Map API fields",
				repaired: "- [ ] Map API fields",
			}),
		]);
		expect(plan.targetBytes).toContain("- [ ] Map API fields");
		expect(plan.targetBytes).not.toContain("[x]");
	});

	test("existing recognized checkbox progress is retained", () => {
		const anchor = INCIDENT.replace("- Map API fields", "- [ ] Map API fields");
		const current = anchor.replace(
			"- [ ] Map API fields",
			"- [x] Map API fields",
		);
		const plan = planChecklistRepair({
			anchorBytes: anchor,
			currentBytes: current,
			schema: 0,
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.targetBytes).toContain("- [x] Map API fields");
		expect(plan.toggles).toHaveLength(1);
		expect(plan.resetChecked).toHaveLength(0);
		// Mixed list: the remaining plain gate items are converted.
		expect(plan.targetBytes).toContain("- [ ] Add the preview type");
	});

	test("requirement or unrelated governing edits are refused with exact lines", () => {
		const edited = INCIDENT.replace(
			"- Map API fields",
			"- [ ] Map all API fields",
		).replace("| W1 | Booking preview | 3 |", "| W1 | Booking preview | 5 |");
		const plan = planChecklistRepair({
			anchorBytes: INCIDENT,
			currentBytes: edited,
			schema: 0,
		});
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.code).toBe("CHECKLIST_REPAIR_DISALLOWED");
		expect(plan.disallowed?.map((entry) => entry.after)).toEqual([
			"| W1 | Booking preview | 5 | 0 | - | - | Required |",
			"- [ ] Map all API fields",
		]);
	});

	test("an unlabelled list in an empty phase is ambiguous until explicitly selected", () => {
		const bytes = `# Plan

## Phase 1: Work

Some context:

- first idea
- second idea

Then:

- do the thing
- verify the thing
`;
		const plan = planChecklistRepair({
			anchorBytes: bytes,
			currentBytes: bytes,
			schema: "file",
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.edits).toHaveLength(0);
		expect(plan.unresolved[0]?.kind).toBe("ambiguous");
		expect(plan.unresolved[0]?.candidates.map((c) => c.startLine)).toEqual([
			7, 12,
		]);
		const selected = planChecklistRepair({
			anchorBytes: bytes,
			currentBytes: bytes,
			schema: "file",
			selection: { phases: ["1"], lines: [{ start: 12, end: 13 }] },
		});
		if (!selected.ok) throw new Error(selected.message);
		expect(selected.edits.map((edit) => edit.after)).toEqual([
			"- [ ] do the thing",
			"- [ ] verify the thing",
		]);
		expect(selected.unresolved).toHaveLength(0);
	});

	test("a selection naming a missing phase is rejected", () => {
		const plan = planChecklistRepair({
			anchorBytes: INCIDENT,
			currentBytes: INCIDENT,
			schema: "file",
			selection: { phases: ["9"] },
		});
		expect(plan.ok).toBe(false);
		if (!plan.ok) expect(plan.code).toBe("CHECKLIST_REPAIR_SELECTION_INVALID");
	});

	test("phases that already have executable items keep plain explanatory lists", () => {
		const bytes = `# Plan

## Phase 1: Work

**Completion gate:** Done.

- [ ] Real task

Notes:

- an explanatory bullet
`;
		const plan = planChecklistRepair({
			anchorBytes: bytes,
			currentBytes: bytes,
			schema: "file",
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.edits).toHaveLength(0);
		expect(plan.unresolved).toHaveLength(0);
	});

	test("fenced examples never gain markers", () => {
		const bytes = `# Plan

## Phase 1: Work

**Completion gate:**

\`\`\`md
- example only
\`\`\`

- real task
`;
		const plan = planChecklistRepair({
			anchorBytes: bytes,
			currentBytes: bytes,
			schema: "file",
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.targetBytes).toContain("- example only");
		const proof = proveChecklistRepair({
			beforeBytes: bytes,
			afterBytes: bytes.replace("- example only", "- [ ] example only"),
			schema: 0,
		});
		expect(proof.ok).toBe(false);
	});

	test("CRLF endings and non-ASCII text are preserved byte for byte", () => {
		const bytes = INCIDENT.replace(
			"- Map API fields",
			"- Map API fields — café ✓ 日本",
		).replace(/\n/g, "\r\n");
		const plan = planChecklistRepair({
			anchorBytes: bytes,
			currentBytes: bytes,
			schema: "file",
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.targetBytes).toContain(
			"- [ ] Map API fields — café ✓ 日本\r\n",
		);
		expect(plan.targetBytes.split("\r\n").length).toBe(
			bytes.split("\r\n").length,
		);
		expect(plan.targetBytes.replace(/\r\n/g, "")).not.toContain("\n");
		// Changing a line ending is not a prefix repair.
		const proof = proveChecklistRepair({
			beforeBytes: bytes,
			afterBytes: plan.targetBytes.replace("\r\n", "\n"),
			schema: 0,
		});
		expect(proof.ok).toBe(false);
	});

	test("schema 1: only governing lines are proven and notes/outside text are free", () => {
		const anchor = schema1(INCIDENT, "\n## Revision History\n\n- v1\n");
		const current = anchor.replace("- v1\n", "- v1\n- v1.1 repaired\n");
		const plan = planChecklistRepair({
			anchorBytes: anchor,
			currentBytes: current,
			schema: 1,
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(plan.schema).toBe(1);
		expect(plan.targetBytes).toContain("- v1.1 repaired");
		expect(counts(plan.targetBytes, 1)).toEqual([3, 2, 0]);
		const loadedBefore = loadPlanDocument(anchor, 1);
		const loadedAfter = loadPlanDocument(plan.targetBytes, 1);
		if (!loadedBefore.ok || !loadedAfter.ok) throw new Error("schema");
		expect(loadedAfter.document.governingLines.length).toBe(
			loadedBefore.document.governingLines.length,
		);
	});

	test("schema 1: list items outside the contract are not eligible", () => {
		const anchor = schema1(
			"# Plan\n\n## Phase 1: Work\n\n**Completion gate:**\n\n- task\n",
		);
		const forged = anchor.replace(
			"**Status:** Approved",
			"**Status:** Approved\n- [ ] outside",
		);
		const proof = proveChecklistRepair({
			beforeBytes: anchor,
			afterBytes: forged,
			schema: 1,
		});
		// Non-governing text is not part of the proof and cannot add items.
		expect(proof.ok).toBe(true);
		if (proof.ok) expect(proof.edits).toHaveLength(0);
		expect(counts(forged, 1)).toEqual([0]);
	});
});

describe("verifyRecordedChecklistRepair", () => {
	test("replay accepts the exact recorded edit map and refuses drift from it", () => {
		const plan = planChecklistRepair({
			anchorBytes: INCIDENT,
			currentBytes: INCIDENT,
			schema: "file",
		});
		if (!plan.ok) throw new Error(plan.message);
		expect(
			verifyRecordedChecklistRepair({
				beforeBytes: INCIDENT,
				afterBytes: plan.targetBytes,
				schema: 0,
				edits: plan.edits,
			}),
		).toEqual({ ok: true });
		expect(
			verifyRecordedChecklistRepair({
				beforeBytes: INCIDENT,
				afterBytes: plan.targetBytes,
				schema: 0,
				edits: plan.edits.slice(1),
			}).ok,
		).toBe(false);
		const checked = plan.targetBytes.replace(
			"- [ ] Map API fields",
			"- [x] Map API fields",
		);
		expect(
			verifyRecordedChecklistRepair({
				beforeBytes: INCIDENT,
				afterBytes: checked,
				schema: 0,
				edits: plan.edits.map((edit) =>
					edit.after === "- [ ] Map API fields"
						? { ...edit, after: "- [x] Map API fields" }
						: edit,
				),
			}).ok,
		).toBe(false);
		expect(
			verifyRecordedChecklistRepair({
				beforeBytes: INCIDENT,
				afterBytes: INCIDENT,
				schema: 0,
				edits: [],
			}).ok,
		).toBe(false);
	});

	test("digest is deterministic and scope-bound", () => {
		const base = {
			scope: "execution:run:binding",
			beforeBlobHash: "sha256:a",
			afterBlobHash: "sha256:b",
			parentLineageId: null,
			edits: [{ line: 1, before: "- a", after: "- [ ] a" }],
		};
		expect(checklistRepairDigest(base)).toBe(checklistRepairDigest(base));
		expect(checklistRepairDigest({ ...base, scope: "source:run:-" })).not.toBe(
			checklistRepairDigest(base),
		);
	});
});

describe("mapSpanThroughChecklistRepair", () => {
	const before = `# Plan\n\n${BUDGET}\n## Phase 1: Model\n\n**Completion gate:** Typed.\n\n- Add the type ✓\n- Map fields\n\nKeep the stale sentence.\n`;
	const plan = planChecklistRepair({
		anchorBytes: before,
		currentBytes: before,
		schema: 0,
	});
	if (!plan.ok) throw new Error(plan.message);
	const after = plan.targetBytes;
	const span = (text: string) => {
		const start = Buffer.from(before, "utf8").indexOf(text);
		return { start, end: start + Buffer.byteLength(text, "utf8") };
	};
	const map = (text: string) =>
		mapSpanThroughChecklistRepair({
			beforeBytes: before,
			afterBytes: after,
			schema: 0,
			...span(text),
		});
	const slice = (bytes: string, range: { start: number; end: number }) =>
		Buffer.from(bytes, "utf8").subarray(range.start, range.end).toString();

	test("shifts later spans and item text past an inserted marker", () => {
		for (const text of ["Keep the stale sentence.", "Add the type ✓", "Map"]) {
			const mapped = map(text);
			if (!mapped.ok) throw new Error(mapped.message);
			expect(slice(after, mapped)).toBe(text);
		}
	});

	test("refuses a span that covers a repaired list prefix", () => {
		expect(map("- Map fields").ok).toBe(false);
		expect(map("✓\n- Map").ok).toBe(false);
	});
});
