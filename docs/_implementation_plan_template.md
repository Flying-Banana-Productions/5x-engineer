# Implementation Plan Template

> **Purpose:** Standard structure for implementation plans that guide non-trivial feature work, refactors, and migrations. Plans are living documents — update phases and checklists as work progresses, and append revision history entries after reviews.
>
> **File naming:** `{NNN}-impl-{subject-slug}.md` where `NNN` is the next sequence number.
> - Feature: `530-impl-venue-daily-booking-limit.md`
> - Refactor: `500-openapi-decomposition.md`
> - Migration: `500-migration-member-centric-booking.md`
>
> **Scaling guidance:** Not every plan needs every section. Use the plan size indicators below:
> - **Small** (single vertical slice, 1–2 days): Metadata, Overview, Design Decisions, Changes by Layer or Phases, Files Touched, Tests, Not In Scope
> - **Medium** (3–5 phases, multi-day): Add Prerequisites, Estimated Timeline, Provenance
> - **Large** (5+ phases, multi-week): Add Executive Summary, Table of Contents, Architecture Overview, per-phase Completion Gates, Appendix
>
> **Lifecycle:** Draft → Reviewed → In Progress → Complete → Archived (to `archive/`)

# {Feature/Change Title}

**Version:** 1.0
**Created:** {Month Day, Year}
**Status:** Draft — pending staff engineer review

---

> **Include for large plans only.** For small/medium plans, skip to Overview.

## Executive Summary

{1-2 paragraph high-level summary: what this delivers, why it matters, and the implementation approach.}

### Scope

**In scope:**
- {Deliverable or capability}
- {Deliverable or capability}

**Out of scope:**
- {Explicitly excluded item + brief rationale}

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **{Decision}** | {Why this approach was chosen over alternatives} |
| **{Decision}** | {Why} |

### References

- [{Design doc}]({relative path}) — {context}
- [{Review}]({relative path}) — {context}

---

> **Include for large plans only.**

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Phase 1: {Title}](#phase-1-title)
3. ...

---

## Overview

{2-4 sentences: what exists today, what's changing, and why.}

**Current behavior:**
- {Observable behavior with code pointers (file:line)}
- {Observable behavior}

**New behavior:**
- {What changes for the user/system}
- {What changes}

> **Include when this plan depends on prior work.**

**Prerequisites:**
- [{Dependency plan}]({relative path}) — {status}

---

## Design Decisions

{Each decision as a bold statement followed by rationale. Cover alternatives considered and why they were rejected.}

**{Decision statement}.** {Rationale — why this approach, what alternatives were considered, trade-offs accepted.}

**{Decision statement}.** {Rationale.}

---

> **Include for large plans with significant architectural changes.**

## Architecture Overview

{ASCII diagram or prose describing system components, data flow, or state transitions.}

```
{Diagram}
```

---

## {Phases or Changes by Layer}

> **Choose one organizational approach:**
> - **Phases** (most common): Ordered by implementation sequence. Best when work touches multiple layers in stages.
> - **Changes by Layer**: Organized by architectural layer (domain types, validation, service, API, UI). Best for single vertical-slice features.
>
> Use `## Phase N:` or `## Changes by Layer` as the section heading, then `###` sub-sections for each phase/layer.

### Phase 1: {Title}

> For large plans, include a completion gate per phase:
> **Completion gate:** {Unambiguous definition of done for this phase.}

#### 1.1 {Component/file} — {brief description}

**File:** `{path/to/file.ts}`, lines {N–M}

{Description of change. Include code snippets for non-trivial modifications:}

```typescript
{Code snippet — interfaces, function signatures, key logic}
```

#### 1.2 {Component/file} — {brief description}

{Description of change.}

- [ ] {Checklist item}
- [ ] {Checklist item}

---

### Phase 2: {Title}

{Continue pattern.}

---

## Files Touched

| File | Change |
|------|--------|
| `{path/to/file.ts}` | {Brief description of change} |
| `{path/to/file.ts}` | {Brief description of change} |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `{file.ts}` | {What the test proves} |
| Integration | `{feature.test.ts}` | {What the test proves} |

---

## Not In Scope

- **{Item}** — {why it's excluded or where it's tracked}
- **{Item}** — {why}

---

> **Include for medium/large plans.**

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | {Brief description} | {estimate} |
| 2 | {Brief description} | {estimate} |
| **Total** | | **{total}** |

---

> **Include when this work follows up on or replaces prior work.**

## Provenance

{1-2 sentences explaining why this work exists — prior plan it follows, user feedback that triggered it, or review finding it addresses. Link to predecessor docs.}

---

## Revision History

> **Do not include this section in the initial draft.** Append a revision entry after each review cycle or significant plan update.

### v{N}.{M} ({date}) — {Brief title}

Addresses items from [{review title}]({relative path}):

**P0 blockers resolved:**
- **{Item}**: {How it was resolved}

**P1 items resolved:**
- **{Item}**: {How it was resolved}
