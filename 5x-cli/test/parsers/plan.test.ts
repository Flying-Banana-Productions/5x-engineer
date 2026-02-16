import { describe, test, expect } from "bun:test";
import { parsePlan } from "../../src/parsers/plan.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// --- Fixture-based tests (deterministic) ---

describe("parsePlan", () => {
  test("extracts title", () => {
    const md = `# My Great Plan

**Version:** 2.1
**Status:** In Progress

## Phase 1: Setup

- [ ] Do something
`;
    const plan = parsePlan(md);
    expect(plan.title).toBe("My Great Plan");
  });

  test("extracts metadata", () => {
    const md = `# Plan

**Version:** 3.0
**Status:** Draft — some notes here

## Phase 1: X

- [ ] A
`;
    const plan = parsePlan(md);
    expect(plan.version).toBe("3.0");
    expect(plan.status).toBe("Draft — some notes here");
  });

  test("parses phases with checklist items", () => {
    const md = `# Plan

**Version:** 1.0
**Status:** In Progress

## Phase 1: Setup

**Completion gate:** Tests pass.

- [x] First item
- [x] Second item
- [ ] Third item

## Phase 2: Build

**Completion gate:** Build succeeds.

- [ ] Fourth item
- [ ] Fifth item
`;
    const plan = parsePlan(md);
    expect(plan.phases.length).toBe(2);
    expect(plan.phases[0]!.number).toBe(1);
    expect(plan.phases[0]!.title).toBe("Setup");
    expect(plan.phases[0]!.completionGate).toBe("Tests pass.");
    expect(plan.phases[0]!.items.length).toBe(3);
    expect(plan.phases[0]!.items[0]!.checked).toBe(true);
    expect(plan.phases[0]!.items[0]!.text).toBe("First item");
    expect(plan.phases[0]!.items[2]!.checked).toBe(false);
    expect(plan.phases[0]!.isComplete).toBe(false);
    expect(plan.phases[1]!.number).toBe(2);
    expect(plan.phases[1]!.completionGate).toBe("Build succeeds.");
    expect(plan.currentPhase?.number).toBe(1);
    expect(plan.completionPercentage).toBe(40); // 2/5
  });

  test("handles all-complete phases", () => {
    const md = `# Plan

**Version:** 1.0
**Status:** Done

## Phase 1: Done

- [x] A
- [x] B

## Phase 2: Still Going

- [ ] C
`;
    const plan = parsePlan(md);
    expect(plan.phases[0]!.isComplete).toBe(true);
    expect(plan.phases[1]!.isComplete).toBe(false);
    expect(plan.currentPhase?.number).toBe(2);
    expect(plan.completionPercentage).toBe(67); // 2/3
  });

  test("handles COMPLETE suffix in heading", () => {
    const md = `# Plan

**Version:** 1.0
**Status:** In Progress

## Phase 1: Setup - COMPLETE

- [x] A
- [x] B

## Phase 2: Build

- [ ] C
`;
    const plan = parsePlan(md);
    expect(plan.phases[0]!.isComplete).toBe(true);
    expect(plan.phases[0]!.title).toBe("Setup");
    expect(plan.currentPhase?.number).toBe(2);
  });

  test("handles dotted phase numbers (e.g., 1.1)", () => {
    const md = `# Plan

**Version:** 1.0
**Status:** In Progress

## Phase 1: Setup

- [x] First item

## Phase 1.1: Retrofit

**Completion gate:** DB works.

- [ ] Add database
- [ ] Add migrations

## Phase 2: Build

- [ ] Build it
`;
    const plan = parsePlan(md);
    expect(plan.phases.length).toBe(3);
    expect(plan.phases[0]!.number).toBe(1);
    expect(plan.phases[1]!.number).toBe(1.1);
    expect(plan.phases[1]!.title).toBe("Retrofit");
    expect(plan.phases[1]!.completionGate).toBe("DB works.");
    expect(plan.phases[1]!.items.length).toBe(2);
    expect(plan.phases[2]!.number).toBe(2);
    expect(plan.currentPhase?.number).toBe(1.1);
    expect(plan.completionPercentage).toBe(25); // 1/4 items checked
  });

  test("handles ### phase headings", () => {
    const md = `# Plan

**Version:** 1.0
**Status:** Draft

### Phase 1: First

- [ ] Item

### Phase 2: Second

- [ ] Item
`;
    const plan = parsePlan(md);
    expect(plan.phases.length).toBe(2);
  });

  test("handles plan with no phases", () => {
    const md = `# Empty Plan

**Version:** 1.0
**Status:** Draft

Just some text, no phases.
`;
    const plan = parsePlan(md);
    expect(plan.phases.length).toBe(0);
    expect(plan.currentPhase).toBeNull();
    expect(plan.completionPercentage).toBe(0);
  });

  test("handles all phases complete", () => {
    const md = `# Plan

**Version:** 2.0
**Status:** Complete

## Phase 1: One

- [x] Done

## Phase 2: Two - COMPLETE

- [x] Also done
`;
    const plan = parsePlan(md);
    expect(plan.phases.every((p) => p.isComplete)).toBe(true);
    expect(plan.currentPhase).toBeNull();
    expect(plan.completionPercentage).toBe(100);
  });

  test("line numbers are 1-indexed", () => {
    const md = `# Plan

**Version:** 1.0
**Status:** Draft

## Phase 1: Test

- [ ] First item
- [ ] Second item
`;
    const plan = parsePlan(md);
    expect(plan.phases[0]!.line).toBeGreaterThan(0);
    expect(plan.phases[0]!.items[0]!.line).toBeGreaterThan(0);
    // Second item should be on a later line
    expect(plan.phases[0]!.items[1]!.line).toBeGreaterThan(
      plan.phases[0]!.items[0]!.line
    );
  });

  test("missing metadata returns empty strings", () => {
    const md = `# Bare Plan

## Phase 1: Only Phase

- [ ] Item
`;
    const plan = parsePlan(md);
    expect(plan.title).toBe("Bare Plan");
    expect(plan.version).toBe("");
    expect(plan.status).toBe("");
    expect(plan.phases.length).toBe(1);
  });
});

// --- Smoke test against real plan (loose assertions only) ---

const REAL_PLAN_PATH = resolve(
  import.meta.dir,
  "../../../docs/development/001-impl-5x-cli.md"
);

describe("parsePlan — real plan smoke test", () => {
  const skip = !existsSync(REAL_PLAN_PATH);

  test.skipIf(skip)("parses without errors and returns plausible structure", () => {
    const content = readFileSync(REAL_PLAN_PATH, "utf-8");
    const plan = parsePlan(content);

    // Loose structural assertions — don't pin exact values
    expect(plan.title.length).toBeGreaterThan(0);
    expect(plan.version.length).toBeGreaterThan(0);
    expect(plan.status.length).toBeGreaterThan(0);
    expect(plan.phases.length).toBeGreaterThanOrEqual(7);
    expect(plan.completionPercentage).toBeGreaterThanOrEqual(0);
    expect(plan.completionPercentage).toBeLessThanOrEqual(100);

    // Every phase should have a number, title, and a line reference
    for (const phase of plan.phases) {
      expect(phase.number).toBeGreaterThan(0);
      expect(phase.title.length).toBeGreaterThan(0);
      expect(phase.line).toBeGreaterThan(0);
    }

    // Most phases should have checklist items
    const phasesWithItems = plan.phases.filter((p) => p.items.length > 0);
    expect(phasesWithItems.length).toBeGreaterThan(plan.phases.length / 2);
  });
});
