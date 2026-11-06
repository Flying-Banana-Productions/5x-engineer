import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePlan } from "../../../src/parsers/plan.js";
import { readAuthoritativePlan } from "../../../src/plan-schema/authority.js";
import {
	diagnosePlanExecutability,
	type PlanExecutability,
	planChecklistRepair,
} from "../../../src/plan-schema/checklist-repair.js";
import type { ExpectedPlanSchema } from "../../../src/plan-schema/document.js";
import {
	executabilityRepairCommands,
	implementationPhaseExecutabilityGate,
	planReviewExecutabilityGate,
} from "../../../src/review-budget/plan-repair.js";

function diagnose(
	raw: string,
	expected: ExpectedPlanSchema = "file",
): PlanExecutability {
	const result = diagnosePlanExecutability(raw, expected);
	if (!result.ok) throw new Error(result.message);
	return result.result;
}

/** Diagnostic counts must equal the authoritative parser's counts. */
function expectAligned(raw: string, expected: ExpectedPlanSchema = "file") {
	const read = readAuthoritativePlan(raw, expected);
	if (!read.ok) throw new Error(read.message);
	const result = diagnose(raw, expected);
	expect(result.phases.map((phase) => [phase.id, phase.items])).toEqual(
		read.plan.phases.map((phase) => [phase.number, phase.items.length]),
	);
	return result;
}

const BUDGET = `## Delivery Budget

- Estimate confidence: high

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Work | 3 | 0 | - | - | Needed. |

### Surface Snapshot

- Subsystems: 1
- Production files: 1
- Persistent/external boundaries: 0
`;

/** The incident's shape: three phases, gate lists, no task markers. */
const INCIDENT = `# Booking modal member preview

**Status:** Approved

${BUDGET}
## Phase 1: Preview model

**Completion gate:** Preview data is typed.

- Add the preview type
- Map API fields
- Cover the mapper with tests

## Phase 2: Modal

**Completion gate:** The modal renders.

- Render the modal
  - include the member tier
- Wire the open action

## Phase 3: Rollout

**Completion gate:** Feature flag removed.

- Remove the flag
`;

describe("diagnosePlanExecutability", () => {
	test("the original three-phase fixture is non-executable and mechanically repairable", () => {
		const result = expectAligned(INCIDENT);
		expect(result.executable).toBe(false);
		expect(
			result.diagnostics.map((entry) => [
				entry.code,
				entry.phase,
				entry.repair,
			]),
		).toEqual([
			["PLAN_PHASE_NO_CHECKLIST", "1", "mechanical"],
			["PLAN_PHASE_NO_CHECKLIST", "2", "mechanical"],
			["PLAN_PHASE_NO_CHECKLIST", "3", "mechanical"],
		]);
		expect(result.diagnostics.map((entry) => entry.line)).toEqual([19, 27, 35]);
		expect(
			executabilityRepairCommands(result.diagnostics, {
				kind: "run",
				runId: "run_abc",
			}),
		).toEqual(["5x plan repair-checklists --run run_abc --dry-run"]);

		const repaired = planChecklistRepair({
			anchorBytes: INCIDENT,
			currentBytes: INCIDENT,
			schema: "file",
		});
		if (!repaired.ok) throw new Error(repaired.message);
		const after = expectAligned(repaired.targetBytes);
		expect(after.executable).toBe(true);
		expect(after.diagnostics).toEqual([]);
		expect(after.phases.map((phase) => phase.items)).toEqual([3, 2, 1]);
	});

	test("a zero-item COMPLETE heading is displayed done but is not executable", () => {
		const raw = `# Plan

## Phase 1: Setup - COMPLETE

Done earlier.

## Phase 2: Build

- [ ] Build it
`;
		expect(parsePlan(raw).phases[0]?.isComplete).toBe(true);
		const result = expectAligned(raw);
		expect(result.executable).toBe(false);
		expect(result.phases[0]).toMatchObject({
			id: "1",
			items: 0,
			executable: false,
			markedCompleteWithoutItems: true,
		});
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.message).toContain("COMPLETE");
		expect(result.diagnostics[0]?.repair).toBe("author");
	});

	test("nested-only task items do not count and need author work", () => {
		const raw = `# Plan

## Phase 1: Nested

**Completion gate:** Children done.

- Parent requirement
  - [ ] child one
  - [ ] child two
`;
		const result = expectAligned(raw);
		expect(result.executable).toBe(false);
		expect(result.phases[0]?.items).toBe(0);
		expect(result.diagnostics[0]?.repair).toBe("mechanical");
		const plain = `# Plan

## Phase 1: Nested

Notes:

  - [ ] child one
  - [ ] child two
`;
		const nestedOnly = expectAligned(plain);
		expect(nestedOnly.executable).toBe(false);
		expect(nestedOnly.diagnostics[0]?.repair).toBe("author");
	});

	test("ordinary explanatory bullets and prose completion gates are accepted", () => {
		const raw = `# Plan

## Phase 1: Work

**Completion gate:** The service answers health checks and the docs describe it in prose.

Context for the implementer:

- The service already exists.
- Health checks run every ten seconds.

- [ ] Add the endpoint
- [x] Document it
`;
		const result = expectAligned(raw);
		expect(result.executable).toBe(true);
		expect(result.diagnostics).toEqual([]);
		expect(result.phases[0]).toMatchObject({ items: 2, checked: 1 });
	});

	test("currently supported executable marker forms stay valid", () => {
		const raw = `# Plan

## Phase 1: Ordered

1. [ ] First
2. [x] Second

### Phase 1.1: Subheading items

### P1.1 — Shape the API [x]
### P1.2 — Wire it [ ]
`;
		const result = expectAligned(raw);
		expect(result.executable).toBe(true);
		expect(result.phases.map((phase) => [phase.id, phase.items])).toEqual([
			["1", 2],
			["1.1", 2],
		]);
	});

	test("unrecognized task marker forms are reported as author work", () => {
		const raw = `# Plan

## Phase 1: Stars

* [ ] Star bullet task
+ [ ] Plus bullet task
`;
		const result = expectAligned(raw);
		expect(result.executable).toBe(false);
		expect(result.diagnostics[0]?.repair).toBe("author");
		expect(result.diagnostics[0]?.message).toContain("`- [ ]`");
	});

	test("no phases and duplicate phase ids are errors", () => {
		const none = expectAligned(`# Notes\n\n- [ ] not a phase item\n`);
		expect(none.executable).toBe(false);
		expect(none.diagnostics.map((entry) => entry.code)).toEqual([
			"PLAN_NO_PHASES",
		]);
		const duplicate = expectAligned(`# Plan

## Phase 1: One

- [ ] a

## Phase 1: Again

- [ ] b
`);
		expect(duplicate.executable).toBe(false);
		expect(duplicate.diagnostics).toMatchObject([
			{
				code: "PLAN_PHASE_ID_DUPLICATE",
				phase: "1",
				line: 7,
				repair: "author",
			},
		]);
		expect(duplicate.phases.every((phase) => !phase.executable)).toBe(true);
	});

	test("a gate list mixing task and plain items is a nonblocking warning", () => {
		const raw = `# Plan

## Phase 1: Mixed

**Completion gate:** Everything done.

- [ ] Recognized
- Forgot the marker
`;
		const result = expectAligned(raw);
		expect(result.executable).toBe(true);
		expect(result.diagnostics).toMatchObject([
			{
				code: "PLAN_PHASE_PLAIN_GATE_ITEMS",
				severity: "warning",
				repair: "mechanical",
			},
		]);
	});

	test("an ambiguous phase names its candidate lists for a line selection", () => {
		const raw = `# Plan

## Phase 1: Two lists

Background:

- One fact
- Another fact

Risks:

- One risk
`;
		const result = expectAligned(raw);
		expect(result.executable).toBe(false);
		const issue = result.diagnostics[0];
		expect(issue?.repair).toBe("select_lines");
		expect(
			issue?.candidates?.map((block) => [block.startLine, block.endLine]),
		).toEqual([
			[7, 8],
			[12, 12],
		]);
		expect(
			executabilityRepairCommands(result.diagnostics, {
				kind: "file",
				planPath: "docs/my plan.md",
			}),
		).toEqual([
			"5x plan repair-checklists --plan 'docs/my plan.md' --phase 1 --lines 7-8 --dry-run",
			"5x plan repair-checklists --plan 'docs/my plan.md' --phase 1 --lines 12-12 --dry-run",
		]);
	});

	test("fenced and commented examples cannot satisfy executability", () => {
		const raw = `# Plan

## Phase 1: Examples only

\`\`\`markdown
- [ ] fenced example item
## Phase 9: Fenced heading
- [ ] fenced item
\`\`\`

~~~
- [x] tilde fenced item
~~~

<!--
- [ ] commented item
-->
<!-- - [ ] single-line commented item -->
`;
		const result = expectAligned(raw);
		expect(result.phases.map((phase) => phase.id)).toEqual(["1"]);
		expect(result.phases[0]?.items).toBe(0);
		expect(result.executable).toBe(false);
		expect(result.diagnostics[0]?.repair).toBe("author");
	});

	test("a triple-backtick inline code span is not a fence and hides nothing", () => {
		const raw = `# Plan

## Phase 1: Work

\`\`\`literal example\`\`\`

**Completion gate:** Done.

- [ ] Real requirement
`;
		expect(parsePlan(raw).phases[0]?.items.map((item) => item.text)).toEqual([
			"Real requirement",
		]);
		const result = expectAligned(raw);
		expect(result.executable).toBe(true);
		expect(result.diagnostics).toEqual([]);

		// A plain gate list after the span stays visible to the repair.
		const plain = raw.replace("- [ ] Real requirement", "- Real requirement");
		const diagnosed = expectAligned(plain);
		expect(diagnosed.executable).toBe(false);
		expect(diagnosed.diagnostics[0]?.repair).toBe("mechanical");
		const repair = planChecklistRepair({
			anchorBytes: plain,
			currentBytes: plain,
			schema: 0,
		});
		expect(repair.ok && repair.edits.map((edit) => edit.after)).toEqual([
			"- [ ] Real requirement",
		]);

		// Backticks in a backtick fence's info string mean no fence; a
		// tilde fence may carry them.
		const tilde = `# Plan

## Phase 1: Work

~~~ \`info\`
- [ ] fenced example
~~~

- [ ] Real requirement
`;
		expect(expectAligned(tilde).phases[0]?.items).toBe(1);
	});

	test("a multiline comment opened after prose hides its items", () => {
		const raw = `# Plan

## Phase 1: Work

Explanation <!--
- [x] Commented example, not a requirement
-->
`;
		const parsed = parsePlan(raw);
		expect(parsed.phases[0]?.items).toEqual([]);
		expect(parsed.completionPercentage).toBe(0);
		const result = expectAligned(raw);
		expect(result.executable).toBe(false);
		expect(result.diagnostics[0]?.repair).toBe("author");

		// Commented plain bullets are not offered as a mechanical repair.
		const plain = raw.replace("- [x] Commented", "- Commented");
		expect(expectAligned(plain).diagnostics[0]?.repair).toBe("author");
		const repair = planChecklistRepair({
			anchorBytes: plain,
			currentBytes: plain,
			schema: 0,
		});
		expect(repair.ok && repair.edits).toEqual([]);

		// Items before the comment, after it closes, and after a closed
		// inline comment still count; a quoted \`<!--\` opens nothing.
		const mixed = `# Plan

## Phase 1: Work

- [ ] Before <!--
- [x] hidden
--> 

- [ ] After <!-- note --> text
- [ ] Use \`<!--\` literally
- [ ] Last
`;
		expect(parsePlan(mixed).phases[0]?.items.map((item) => item.text)).toEqual([
			"Before <!--",
			"After <!-- note --> text",
			"Use `<!--` literally",
			"Last",
		]);
		expect(expectAligned(mixed).executable).toBe(true);
	});

	test("schema 1 notes and outside-contract examples cannot satisfy executability", () => {
		const raw = `<!-- 5x:plan-schema:1 -->

# Plan

- [ ] preamble example item

<!-- 5x:contract:start -->

## Phase 1: Governed

**Completion gate:** Done.

<!-- 5x:note:start id="hint" -->
- [ ] note item
<!-- 5x:note:end id="hint" -->

<!-- 5x:contract:end -->

## Phase 2: Outside

- [ ] outside item
`;
		const result = expectAligned(raw);
		expect(result.schema).toBe(1);
		expect(result.phases.map((phase) => [phase.id, phase.items])).toEqual([
			["1", 0],
		]);
		expect(result.executable).toBe(false);

		const governed = raw.replace(
			"**Completion gate:** Done.\n",
			"**Completion gate:** Done.\n\n- [ ] governed item\n",
		);
		expect(expectAligned(governed).executable).toBe(true);
	});

	test("the recorded schema decides authority: schema 0 reads every line", () => {
		const raw = `# Plan

<!-- 5x:plan-schema:1 -->
<!-- 5x:contract:start -->

## Phase 1: Inside

Prose only.

<!-- 5x:contract:end -->

- [ ] after the contract
`;
		// Schema 1: the trailing item is outside the contract.
		expect(diagnose(raw, 1).executable).toBe(false);
		// Schema 0 (legacy recorded binding): the whole file governs.
		const legacy = expectAligned(raw, 0);
		expect(legacy.schema).toBe(0);
		expect(legacy.executable).toBe(true);
	});

	test("schema errors are returned, not thrown", () => {
		const broken = diagnosePlanExecutability(
			"<!-- 5x:plan-schema:1 -->\n# No contract\n",
			"file",
		);
		expect(broken.ok).toBe(false);
	});

	test("the compact issue-plan fixture passes unchanged", () => {
		const raw = readFileSync(
			resolve(
				import.meta.dir,
				"../../fixtures/issue-resolution/compact-plan.md",
			),
			"utf8",
		);
		const result = expectAligned(raw);
		expect(result.executable).toBe(true);
		expect(result.diagnostics).toEqual([]);
		expect(result.phases).toHaveLength(1);
		expect(
			planReviewExecutabilityGate({ planMarkdown: raw, planPath: "plan.md" }),
		).toBeNull();
	});
});

describe("executability boundaries", () => {
	test("a non-executable draft routes to the author before review", () => {
		const gate = planReviewExecutabilityGate({
			planMarkdown: INCIDENT,
			planPath: "/repo/docs/plan.md",
		});
		expect(gate).toMatchObject({
			status: "error",
			code: "PLAN_REPAIR_REQUIRED",
			detail: {
				reviewRoute: "author_revision",
				runPreserved: true,
				next: ["5x plan repair-checklists --plan /repo/docs/plan.md --dry-run"],
			},
		});
		expect(gate?.detail.diagnostics).toHaveLength(3);
		expect(gate?.message).toContain("[PLAN_NOT_EXECUTABLE]");
	});

	test("an approved phase returns the exact run repair and preserves the run", () => {
		const gate = implementationPhaseExecutabilityGate({
			planMarkdown: INCIDENT,
			phase: "2",
			subject: { kind: "run", runId: "run_exec" },
		});
		expect(gate).toMatchObject({
			status: "error",
			code: "PLAN_CHECKLIST_REPAIR_REQUIRED",
			detail: {
				runPreserved: true,
				next: ["5x plan repair-checklists --run run_exec --dry-run"],
			},
		});
		expect(gate.status === "error" && gate.detail.diagnostics).toMatchObject([
			{ phase: "2" },
		]);
	});

	test("only the target phase blocks; author-only gaps warn instead", () => {
		const raw = `# Plan

## Phase 1: Ready

- [ ] Work

## Phase 2: Empty

Prose only.
`;
		expect(
			implementationPhaseExecutabilityGate({
				planMarkdown: raw,
				phase: "1",
				subject: { kind: "run", runId: "run_exec" },
			}),
		).toEqual({ status: "ok" });
		const second = implementationPhaseExecutabilityGate({
			planMarkdown: raw,
			phase: "2",
			subject: { kind: "run", runId: "run_exec" },
		});
		expect(second.status).toBe("ok");
		expect(second.status === "ok" && second.warning).toContain(
			"5x review implementation amend --help",
		);
	});
});
