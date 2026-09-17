export const DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE = `# {Feature/Change Title}

**Version:** 1.0
**Created:** {Month Day, Year}
**Status:** Draft

## Overview

{Describe current behavior, desired behavior, and why this change is needed.}

## Design Decisions

**{Decision statement}.** {Rationale and trade-offs.}

## Delivery Budget

- Estimate confidence: {low | medium | high}

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | {Work item} | {1\\|2\\|3\\|5\\|8} | {0 or ±1/2/3/5} | - | - | {Why this score} |

Scoring: effort 1 localized, 2 multi-file one subsystem, 3 cross-subsystem, 5 new abstraction/persistence/platform, 8 major migration/uncertainty. Tests belong to the item they validate. Architecture delta is maintenance burden (negative = simpler post-state). Negative architecture requires a debt claim DCn (intrinsic|adjacent|unrelated) and a matching Debt Claims block with target implementation phase, minimal-compliant effort/architecture deltas, and concrete before/after evidence. Addresses lists stable review-item IDs incorporated into this row (- if none). Do not write totals, ceilings, or budget status; the CLI derives them.

Work-item IDs (W1, W2, …) are stable across revisions. Add rows or rescore with rationale; never reuse an ID for a different item. Debt-claim IDs (DC0, DC1, …) are also stable. Changing coupling, architecture delta, target phase, minimal deltas, or before/after evidence makes an existing claim changed and requires reviewer re-assessment.

### Debt Claims

#### DC0

- Target phase: {phase-N}
- Minimal-compliant effort delta: {0 or 1\\|2\\|3\\|5\\|8}
- Minimal-compliant architecture delta: {0 or ±1/2/3/5}
- Before: {concrete pre-state}
- After: {concrete simpler post-state}

Omit this subsection when every work-item architecture delta is non-negative.

### Surface Snapshot

- Subsystems: {n}
- Production files: {n}
- Persistent/external boundaries: {n}

## Phase 1: {Title}

**Completion gate:** {How you know this phase is done.}

- [ ] {Checklist item}
- [ ] {Checklist item}

## Phase 2: {Title}

**Completion gate:** {How you know this phase is done.}

- [ ] {Checklist item}
- [ ] {Checklist item}

## Files Touched

| File | Change |
|------|--------|
| {path/to/file.ts} | {Brief description} |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | {file} | {Behavior} |
| Integration | {file} | {Workflow} |

## Not In Scope

- {Explicitly excluded item}

## Revision History

### v{N}.{M} ({date}) — {Short title}

- {What changed after review}
`;

export const DEFAULT_REVIEW_TEMPLATE = `# Review: {Subject Title}

**Review type:** {commit hash | plan path | design path}
**Scope:** {What was reviewed}
**Reviewer:** Staff engineer
**Local verification:** {Command + result | Not run}

## Summary

{Overall readiness and critical findings.}

**Readiness:** {Ready | Ready with corrections | Not ready} — {One-line reason}

## Strengths

- {Strength}
- {Strength}

## Production Readiness Blockers

### P0.{n} — {Issue title}

**Risk:** {Impact if not fixed}

**Requirement:** {Clear acceptance criteria}

## High Priority (P1)

### P1.{n} — {Issue title}

{Recommendation and rationale}

## Medium Priority (P2)

- {Improvement opportunity}

## Readiness Checklist

**P0 blockers**
- [ ] {Item}

**P1 recommended**
- [ ] {Item}

## Addendum ({date}) — {Title}

### What's Addressed

- {Resolved item}

### Remaining Concerns

- {Open item}
`;
