import { describe, test, expect } from "bun:test";
import { parsePlan } from "../../src/parsers/plan.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REAL_PLAN = readFileSync(
  resolve(import.meta.dir, "../../../docs/development/001-impl-5x-cli.md"),
  "utf-8"
);

describe("parsePlan", () => {
  test("extracts title from real plan", () => {
    const plan = parsePlan(REAL_PLAN);
    expect(plan.title).toBe("5x CLI — Automated Author-Review Loop Runner");
  });

  test("extracts metadata", () => {
    const plan = parsePlan(REAL_PLAN);
    expect(plan.version).toBe("1.2");
    expect(plan.status).toContain("Draft");
  });

  test("parses all phases from real plan", () => {
    const plan = parsePlan(REAL_PLAN);
    expect(plan.phases.length).toBe(7);
    expect(plan.phases[0]!.number).toBe(1);
    expect(plan.phases[0]!.title).toContain("Foundation");
    expect(plan.phases[6]!.number).toBe(7);
    expect(plan.phases[6]!.title).toContain("Upgrade");
  });

  test("extracts checklist items", () => {
    const plan = parsePlan(REAL_PLAN);
    const phase1 = plan.phases[0]!;
    // Phase 1 has many checklist items across sub-sections
    expect(phase1.items.length).toBeGreaterThan(10);
    // All should be unchecked in the current plan
    expect(phase1.items.every((i) => !i.checked)).toBe(true);
  });

  test("extracts completion gates", () => {
    const plan = parsePlan(REAL_PLAN);
    expect(plan.phases[0]!.completionGate).toContain("5x status");
    expect(plan.phases[1]!.completionGate).toContain("Claude Code adapter");
  });

  test("identifies current phase as first incomplete", () => {
    const plan = parsePlan(REAL_PLAN);
    // All unchecked, so currentPhase is Phase 1
    expect(plan.currentPhase?.number).toBe(1);
  });

  test("calculates completion percentage", () => {
    const plan = parsePlan(REAL_PLAN);
    // All unchecked
    expect(plan.completionPercentage).toBe(0);
  });

  test("handles checked items", () => {
    const md = `# Test Plan

**Version:** 1.0
**Status:** In Progress

## Phase 1: Setup

**Completion gate:** Tests pass.

- [x] First item
- [x] Second item
- [ ] Third item

## Phase 2: Build

- [ ] Fourth item
- [ ] Fifth item
`;
    const plan = parsePlan(md);
    expect(plan.phases.length).toBe(2);
    expect(plan.phases[0]!.items.length).toBe(3);
    expect(plan.phases[0]!.items[0]!.checked).toBe(true);
    expect(plan.phases[0]!.items[2]!.checked).toBe(false);
    expect(plan.phases[0]!.isComplete).toBe(false);
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
});
