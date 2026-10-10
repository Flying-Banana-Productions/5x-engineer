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

Scoring: effort 1 localized, 2 multi-file one subsystem, 3 cross-subsystem, 5 new abstraction/persistence/platform, 8 major migration/uncertainty. Tests belong to the item they validate. Architecture delta is maintenance burden (negative = simpler post-state). A negative architecture row's Debt claim cell must use the exact parser syntax DC0 (\`intrinsic\`) (or DC0 (\`adjacent\`) / DC0 (\`unrelated\`)) and have a matching Debt Claims block with target implementation phase, minimal-compliant effort/architecture deltas, and concrete before/after evidence. Addresses lists stable review-item IDs incorporated into this row (- if none). Do not write totals, ceilings, or budget status; the CLI derives them.

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

Use this document for plan, design, or implementation reviews. Omit sections that do not apply. Markdown is the audit narrative; emit the structured verdict separately using the supplied protocol contract. Do not author CLI-owned routes, totals, or completion authorization.

## Review Context

- Phase / review kind: {Phase ID; initial material pass | closure | N/A}
- Reviewed range: {Exact base..reviewed SHAs from supplied implementation context | N/A}
- Binding / review context: {Supplied identities | N/A}

For governed implementation reviews, the supplied durable context is authoritative for scope, range, decisions, and due claims. Do not substitute current HEAD or a review-document commit as an endpoint.

## Summary

{Overall readiness and critical findings.}

**Readiness:** {Ready | Ready with corrections | Not ready} — {One-line reason}

## Strengths

- {Strength}
- {Strength}

## Production Readiness Blockers

### P0.{n} — {Issue title}

**Classification:** {Supplied contract's scopeClass and action}

**Approved work items:** {W IDs for implementation_defect | N/A}

**Risk:** {Impact if not fixed}

**Requirement:** {Clear acceptance criteria}

**Evidence / correction:** {Concrete failure, lowest-cost correction, and required evidence}

## High Priority (P1)

### P1.{n} — {Issue title}

{Same finding fields as above; keep the ID stable across reviews.}

## Medium Priority (P2)

### P2.{n} — {Issue title}

{Same finding fields as above. Include only actionable corrections here; optional improvements belong below.}

For governed implementation findings, use implementation_defect, plan_defect, scope_expansion, or pre_existing according to the source of the correction. Link implementation_defect to approved planWorkItemIds. A plan_defect uses the concrete planImpact object with kind and locations (heading / staleText); design, budget, or ambiguous text changes require human routing. New ordinary closure blockers need exact file-qualified hunk evidence and a causal explanation. Ordinary pre-existing notes are nonblocking; critical safety findings use the supplied exception contract and require a human. Plan and legacy reviews use their own supplied contract; do not mix enums or implementation-only fields into them.

## Nonblocking follow-ups

- {Optional hardening, polish, or ordinary pre-existing observation and rationale}

These observations are not structured items[], do not affect readiness, and are not admitted author work.

## Approved Credit Realization (governed implementation only)

| Claim ID | Realization | Realized architecture delta | Evidence |
|---|---|---:|---|
| {Due approved DC ID} | {realized / partial / not_realized} | {Bounded approved delta} | {Concrete implemented post-state at reviewed commit} |

Assess only supplied due claims against the effective approved post-state, including governing waivers. Emit creditRealizations separately; do not create new credit or emit plan baseline/credit assessments in implementation verdicts.

## Readiness Checklist

**P0 blockers**
- [ ] {Item}

**P1 actionable corrections**
- [ ] {Item}

## Addendum ({date}) — {Title}

**Reviewed range / context:** {Exact supplied range and context ID | N/A}

### Prior-finding outcomes

| Finding ID | Outcome | Evidence |
|---|---|---|
| {Required prior ID} | {addressed / partially_addressed / still_open} | {Current evidence} |

In governed closure reviews, give exactly one outcome per required prior ID. Partially addressed and still-open findings remain exactly once in structured items[]; addressed findings leave items[]. Review new ordinary blockers only when caused by the exact correction range, subject to the supplied critical-safety exception.

### What's Addressed

- {Resolved item}

### Remaining Concerns

- {Still-open or partially addressed actionable finding, with stable ID}

### Nonblocking follow-ups

- {Observation outside admitted correction scope}

### Updated readiness and credit realization

{Readiness rationale; update due-claim evidence at this reviewed commit when applicable. Checked boxes and reviewer prose alone do not authorize phase advancement.}
`;
