/**
 * Unit tests for plan phase parsing.
 *
 * Tests cover the pure `parsePlan()` function — no subprocesses, no git,
 * no DB. Validates phase extraction, checklist counting, completion
 * detection, and sub-phase numbering.
 *
 * Integration tests for CLI envelope format, exit codes, and worktree
 * mapping remain in test/integration/commands/plan-v1.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { parsedPlanHasPhases, parsePlan } from "../../../src/parsers/plan.js";

// ===========================================================================
// Phase parsing
// ===========================================================================

describe("parsePlan — phase extraction (unit)", () => {
	test("extracts phases with checklist counts", () => {
		const md = `# My Plan

**Version:** 1.0
**Status:** Draft

## Phase 1: Setup

**Completion gate:** Everything is set up.

- [x] Create project structure
- [x] Initialize git repo
- [ ] Write config file

## Phase 2: Implementation

**Completion gate:** Feature works.

- [ ] Implement feature A
- [ ] Implement feature B
- [ ] Write tests
`;

		const plan = parsePlan(md);
		expect(plan.phases.length).toBe(2);

		expect(plan.phases[0]?.number).toBe("1");
		expect(plan.phases[0]?.title).toBe("Setup");
		expect(plan.phases[0]?.isComplete).toBe(false);
		expect(plan.phases[0]?.items.length).toBe(3);
		expect(plan.phases[0]?.items.filter((i) => i.checked).length).toBe(2);

		expect(plan.phases[1]?.number).toBe("2");
		expect(plan.phases[1]?.title).toBe("Implementation");
		expect(plan.phases[1]?.isComplete).toBe(false);
		expect(plan.phases[1]?.items.length).toBe(3);
		expect(plan.phases[1]?.items.filter((i) => i.checked).length).toBe(0);
	});

	test("done=true for fully checked phases", () => {
		const md = `# Plan

## Phase 1: Done Phase

- [x] Task A
- [x] Task B

## Phase 2: Partial Phase

- [x] Task C
- [ ] Task D
`;

		const plan = parsePlan(md);
		expect(plan.phases.length).toBe(2);

		expect(plan.phases[0]?.isComplete).toBe(true);
		expect(plan.phases[0]?.items.length).toBe(2);
		expect(plan.phases[0]?.items.filter((i) => i.checked).length).toBe(2);

		expect(plan.phases[1]?.isComplete).toBe(false);
		expect(plan.phases[1]?.items.length).toBe(2);
		expect(plan.phases[1]?.items.filter((i) => i.checked).length).toBe(1);
	});

	test("handles plan with no phases", () => {
		const md = "# Empty Plan\n\nJust some text.\n";

		const plan = parsePlan(md);
		expect(plan.phases).toEqual([]);
		expect(parsedPlanHasPhases(plan)).toBe(false);
	});

	test("parsedPlanHasPhases is true when at least one Phase heading exists", () => {
		const md = `# P

## Phase 1: A

- [ ] x
`;
		expect(parsedPlanHasPhases(parsePlan(md))).toBe(true);
	});

	test("handles sub-phase numbering", () => {
		const md = `# Plan

## Phase 1: Main Phase

- [x] Task A

## Phase 1.1: Sub Phase

- [ ] Task B
`;

		const plan = parsePlan(md);
		expect(plan.phases.length).toBe(2);
		expect(plan.phases[0]?.number).toBe("1");
		expect(plan.phases[1]?.number).toBe("1.1");
	});
});
