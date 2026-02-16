import { describe, test, expect } from "bun:test";
import { parseVerdictBlock, parseStatusBlock } from "../../src/parsers/signals.js";

describe("parseVerdictBlock", () => {
  test("parses valid verdict block", () => {
    const text = `Some review content...

<!-- 5x:verdict
protocolVersion: 1
readiness: ready_with_corrections
reviewPath: docs/development/reviews/2026-02-15-001-review.md
items:
  - id: p1-naming
    title: Inconsistent naming convention
    action: auto_fix
    reason: Mechanical rename
  - id: p0-security
    title: Missing input validation
    action: human_required
    reason: Requires judgment about validation strategy
-->
`;
    const verdict = parseVerdictBlock(text);
    expect(verdict).not.toBeNull();
    expect(verdict!.protocolVersion).toBe(1);
    expect(verdict!.readiness).toBe("ready_with_corrections");
    expect(verdict!.reviewPath).toBe("docs/development/reviews/2026-02-15-001-review.md");
    expect(verdict!.items.length).toBe(2);
    expect(verdict!.items[0]!.id).toBe("p1-naming");
    expect(verdict!.items[0]!.action).toBe("auto_fix");
    expect(verdict!.items[1]!.action).toBe("human_required");
  });

  test("returns null for missing block", () => {
    expect(parseVerdictBlock("No block here")).toBeNull();
  });

  test("returns null for malformed YAML", () => {
    const text = `<!-- 5x:verdict
{{{not valid yaml
-->`;
    expect(parseVerdictBlock(text)).toBeNull();
  });

  test("returns null for missing required fields", () => {
    const text = `<!-- 5x:verdict
protocolVersion: 1
readiness: ready
-->`;
    // Missing reviewPath and items
    expect(parseVerdictBlock(text)).toBeNull();
  });

  test("returns null for invalid readiness value", () => {
    const text = `<!-- 5x:verdict
protocolVersion: 1
readiness: maybe
reviewPath: foo.md
items: []
-->`;
    expect(parseVerdictBlock(text)).toBeNull();
  });

  test("last block wins when multiple present", () => {
    const text = `
<!-- 5x:verdict
protocolVersion: 1
readiness: not_ready
reviewPath: first.md
items: []
-->

Some more content...

<!-- 5x:verdict
protocolVersion: 1
readiness: ready
reviewPath: second.md
items: []
-->
`;
    const verdict = parseVerdictBlock(text);
    expect(verdict!.readiness).toBe("ready");
    expect(verdict!.reviewPath).toBe("second.md");
  });

  test("handles unknown protocolVersion gracefully", () => {
    const text = `<!-- 5x:verdict
protocolVersion: 99
readiness: ready
reviewPath: foo.md
items: []
-->`;
    const verdict = parseVerdictBlock(text);
    // Still parses, just warns
    expect(verdict).not.toBeNull();
    expect(verdict!.readiness).toBe("ready");
  });

  test("skips items with invalid action", () => {
    const text = `<!-- 5x:verdict
protocolVersion: 1
readiness: ready_with_corrections
reviewPath: foo.md
items:
  - id: a
    title: Good item
    action: auto_fix
    reason: ok
  - id: b
    title: Bad action
    action: maybe_fix
    reason: nope
-->`;
    const verdict = parseVerdictBlock(text);
    expect(verdict!.items.length).toBe(1);
    expect(verdict!.items[0]!.id).toBe("a");
  });

  test("handles item with missing reason", () => {
    const text = `<!-- 5x:verdict
protocolVersion: 1
readiness: ready_with_corrections
reviewPath: foo.md
items:
  - id: a
    title: No reason
    action: auto_fix
-->`;
    const verdict = parseVerdictBlock(text);
    expect(verdict!.items[0]!.reason).toBe("");
  });
});

describe("parseStatusBlock", () => {
  test("parses valid status block", () => {
    const text = `Agent output...

<!-- 5x:status
protocolVersion: 1
result: completed
planPath: docs/development/001-impl-foo.md
summary: Generated 5-phase implementation plan
-->
`;
    const status = parseStatusBlock(text);
    expect(status).not.toBeNull();
    expect(status!.protocolVersion).toBe(1);
    expect(status!.result).toBe("completed");
    expect(status!.planPath).toBe("docs/development/001-impl-foo.md");
    expect(status!.summary).toBe("Generated 5-phase implementation plan");
  });

  test("parses status with commit and phase", () => {
    const text = `<!-- 5x:status
protocolVersion: 1
result: completed
commit: abc123def
phase: 3
summary: Implemented phase 3 components
-->`;
    const status = parseStatusBlock(text);
    expect(status!.commit).toBe("abc123def");
    expect(status!.phase).toBe(3);
  });

  test("parses needs_human result", () => {
    const text = `<!-- 5x:status
protocolVersion: 1
result: needs_human
reason: Ambiguous requirements
blockedOn: Database schema decision
context: Two valid approaches exist
-->`;
    const status = parseStatusBlock(text);
    expect(status!.result).toBe("needs_human");
    expect(status!.reason).toBe("Ambiguous requirements");
    expect(status!.blockedOn).toBe("Database schema decision");
  });

  test("returns null for missing block", () => {
    expect(parseStatusBlock("No status here")).toBeNull();
  });

  test("returns null for malformed YAML", () => {
    const text = `<!-- 5x:status
:::bad yaml:::
-->`;
    expect(parseStatusBlock(text)).toBeNull();
  });

  test("returns null for invalid result value", () => {
    const text = `<!-- 5x:status
protocolVersion: 1
result: maybe_done
-->`;
    expect(parseStatusBlock(text)).toBeNull();
  });

  test("returns null for missing result field", () => {
    const text = `<!-- 5x:status
protocolVersion: 1
summary: No result field
-->`;
    expect(parseStatusBlock(text)).toBeNull();
  });

  test("last block wins", () => {
    const text = `
<!-- 5x:status
protocolVersion: 1
result: failed
reason: first attempt
-->

More output...

<!-- 5x:status
protocolVersion: 1
result: completed
summary: retry succeeded
-->
`;
    const status = parseStatusBlock(text);
    expect(status!.result).toBe("completed");
    expect(status!.summary).toBe("retry succeeded");
  });

  test("optional fields default to undefined", () => {
    const text = `<!-- 5x:status
protocolVersion: 1
result: completed
-->`;
    const status = parseStatusBlock(text);
    expect(status!.planPath).toBeUndefined();
    expect(status!.commit).toBeUndefined();
    expect(status!.phase).toBeUndefined();
  });

  test("handles unknown protocolVersion", () => {
    const text = `<!-- 5x:status
protocolVersion: 2
result: completed
-->`;
    const status = parseStatusBlock(text);
    expect(status).not.toBeNull();
    expect(status!.result).toBe("completed");
  });
});
