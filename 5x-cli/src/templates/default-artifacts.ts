import { PLAN_SCHEMA_AUTHORITY_INSTRUCTION } from "../plan-schema/document.js";

export const DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE = `<!-- 5x:plan-schema:1 -->

<!--
HOW TO USE (also applies without the 5x workflow skills)
Replace placeholders with project-specific content; delete unused optional sections.
Keep the visible headings, budget columns, and checklist syntax intact: 5x parses them.
This skeleton is schema 1. The human **Version:** line is the document revision, not the schema.
Outside the contract: this declaration, **Version:**, **Created:**, **Status:**,
and ## Revision History. Inside the contract: the title, obligations, budget, phases, gates,
checklists, exclusions, files touched, and tests. Generator how-to comments are
uniquely named note blocks and are not governing. A Draft plan is not execution approval.
${PLAN_SCHEMA_AUTHORITY_INSTRUCTION}
Examples below are illustrative, not approved work or evidence. Replace example IDs
with real stable IDs and use actual source paths, phase targets, and before/after states.
Parser note: HTML comments are not automatically ignored. Example lines are labeled
so they cannot become real headings, table rows, metadata, or checklist items.
-->

\`\`\`text
<!-- 5x:note:start id="execution-context" -->
Informational context. It does not govern the work and does not satisfy a completion gate.
<!-- 5x:note:end id="execution-context" -->
\`\`\`

**Version:** 1.0
**Created:** {Month Day, Year}
**Status:** Draft

<!-- 5x:contract:start -->

# {Feature/Change Title}

## Overview

{Describe current behavior, desired behavior, and why this change is needed.}

## Design Decisions

<!-- 5x:note:start id="generator-design" -->
<!--
Explain the chosen approach and why it is adequate; record material trade-offs.
Example decision: Use the existing transaction helper so both settings writes commit
atomically. A new persistence abstraction would add maintenance cost without improving
the required failure behavior. Optional batching remains outside this change.
-->
<!-- 5x:note:end id="generator-design" -->

**{Decision statement}.** {Rationale and trade-offs.}

## Delivery Budget

- Estimate confidence: {low | medium | high}

<!-- 5x:note:start id="generator-budget" -->
<!--
Use one scored row per deliverable, including its tests. Pick one number per score cell;
do not leave alternatives or write totals. A non-negative architecture row needs no claim.
Example row (copy only the text after the label when adapting it):
Example row: | W1 | Make settings writes atomic, with rollback tests | 2 | 0 | - | - | Reuses the existing transaction helper in one subsystem |
For an incorporated review correction, Addresses might be P1.1 instead of '-'.
-->
<!-- 5x:note:end id="generator-budget" -->

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | {Work item} | {1\\|2\\|3\\|5\\|8} | {0 or ±1/2/3/5} | - | - | {Why this score} |

Scoring: effort 1 localized, 2 multi-file one subsystem, 3 cross-subsystem, 5 new abstraction/persistence/platform, 8 major migration/uncertainty. Tests belong to the item they validate. Architecture delta is maintenance burden (negative = simpler post-state). A negative architecture row's Debt claim cell must use the exact parser syntax DC0 (\`intrinsic\`) (or DC0 (\`adjacent\`) / DC0 (\`unrelated\`)) and have a matching Debt Claims block with target implementation phase, minimal-compliant effort/architecture deltas, and concrete before/after evidence. Addresses lists stable review-item IDs incorporated into this row (- if none). Do not write totals, ceilings, or budget status; the CLI derives them.

Work-item IDs (W1, W2, …) are stable across revisions. Add rows or rescore with rationale; never reuse an ID for a different item. Debt-claim IDs (DC0, DC1, …) are also stable. Changing coupling, architecture delta, target phase, minimal deltas, or before/after evidence makes an existing claim changed and requires reviewer re-assessment.

### Debt Claims

<!-- 5x:note:start id="generator-debt" -->
<!--
Include a claim only for a concrete simplification promised by a negative architecture
row; do not claim credit for unrelated cleanup or a speculative future improvement.
Example negative row: | W2 | Consolidate duplicate settings serializers and tests | 3 | -1 | DC0 (\`intrinsic\`) | - | Required implementation removes the duplicate serializer |
The corresponding claim uses the exact heading and bullet labels shown below.
Example target bullet: - Target phase: phase-2
This means the actual numeric Phase 2 heading in this plan, not an arbitrary phase name.
Example minimal effort bullet: - Minimal-compliant effort delta: 1
Example minimal architecture bullet: - Minimal-compliant architecture delta: 0
The minimal-compliant deltas describe the adequate alternative without the simplification.
Example before bullet: - Before: settings.ts and preferences.ts each own the same serializer
Example after bullet: - After: both callers use the existing serializer in settings.ts; preferences.ts no longer owns one
An implementation reviewer later checks whether this promised post-state was realized.
-->
<!-- 5x:note:end id="generator-debt" -->

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

<!-- 5x:note:start id="generator-checklist" -->
<!--
Write observable requirements, not just activities. Keep each checklist item stable
across revisions; normal execution changes its checkbox state, not its meaning.
Example gate: A failure in either settings write leaves both persisted values unchanged.
Example checklist item: - [ ] Use the transaction helper for both writes and test rollback
Only check an item after its requirement is met. Checked boxes alone do not authorize
phase advancement when the supplied 5x workflow requires review or reconciliation.
-->
<!-- 5x:note:end id="generator-checklist" -->

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

<!-- 5x:contract:end -->

## Revision History

### v{N}.{M} ({date}) — {Short title}

- {What changed after review}
`;

export const DEFAULT_REVIEW_TEMPLATE = `# Review: {Subject Title}

<!--
HOW TO USE (also applies without the 5x workflow skills)
Replace placeholders, keep finding IDs stable, and omit sections that do not apply.
Separate required corrections from optional follow-ups. Keep evidence visible in the
finished review; comments are authoring guidance, not the structured CLI verdict.
When using 5x, follow the supplied review context and protocol instructions.
Without governance context, record what you actually reviewed, but do not invent
binding/context IDs, approved work-item links, debt claims, or completion authorization.
Standalone Markdown review does not establish governed 5x approval. Examples are
illustrative; do not copy their IDs, code facts, or evidence into a real verdict.
-->

**Review type:** {commit hash | plan path | design path}
**Scope:** {What was reviewed}
**Reviewer:** Staff engineer
**Local verification:** {Command + result | Not run}

Use this document for plan, design, or implementation reviews. Omit sections that do not apply. Markdown is the audit narrative; emit the structured verdict separately using the supplied protocol contract. Do not author CLI-owned routes, totals, or completion authorization.

## Review Context

<!--
Example standalone scope: saveSettings() and its rollback tests at an explicitly
identified commit. Mark binding/context and governed credit sections N/A or omit them.
Example governed scope: use the exact supplied phase, binding, context ID, and range;
do not infer those identities or approval from the editable plan or current HEAD.
-->

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

<!--
Example actionable finding (apply the same fields under its actual priority section):
Example heading: ### P1.1 — Missing rollback on failed settings write
Example risk: A failed second write leaves partially updated persisted state.
Example requirement: Either both writes succeed or neither takes effect.
Example evidence / correction: saveSettings() commits the first write before the
second succeeds. Use the existing transaction helper and test the second-write failure.
For a governed implementation review, add implementation_defect / auto_fix and the
actual approved W IDs only when supported by supplied context. On a closure round,
cite the actual complete file-qualified hunk from the exact supplied correction range.
-->

## High Priority (P1)

### P1.{n} — {Issue title}

{Same finding fields as above; keep the ID stable across reviews.}

## Medium Priority (P2)

### P2.{n} — {Issue title}

{Same finding fields as above. Include only actionable corrections here; optional improvements belong below.}

For governed implementation findings, use implementation_defect, plan_defect, scope_expansion, or pre_existing according to the source of the correction. Link implementation_defect to approved planWorkItemIds. A plan_defect uses the concrete planImpact object with kind and locations (heading / staleText); design, budget, or ambiguous text changes require human routing. New ordinary closure blockers need exact file-qualified hunk evidence and a causal explanation. Ordinary pre-existing notes are nonblocking; critical safety findings use the supplied exception contract and require a human. Plan and legacy reviews use their own supplied contract; do not mix enums or implementation-only fields into them.

## Nonblocking follow-ups

<!--
Example follow-up: Consider batching settings writes if profiling later shows meaningful
overhead. No current acceptance or correctness requirement depends on this optimization.
This is an observation to retain, not a defect to fix during the current author pass.
-->

- {Optional hardening, polish, or ordinary pre-existing observation and rationale}

These observations are not structured items[], do not affect readiness, and are not admitted author work.

## Approved Credit Realization (governed implementation only)

<!--
Use only claims supplied as due by the governing context. Full realization keeps the
approved negative delta; partial uses a strictly smaller negative magnitude; not_realized
uses zero. Extra simplification does not create additional credit.
Example assessment: A supplied DC0 promises removal of one duplicate serializer at -1.
Report realized / -1 only after verifying the duplicate is gone at the reviewed commit,
with actual path and commit evidence. If it remains, report not_realized / 0 and why.
-->

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

<!--
Example closure outcome: P1.1 / addressed / the corrected saveSettings() uses one
transaction, and the second-write failure test verifies both values remain unchanged.
Use partially_addressed or still_open when the requirement is not fully met, and retain
that finding once in the structured items. Use actual evidence, not this example.
-->

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
