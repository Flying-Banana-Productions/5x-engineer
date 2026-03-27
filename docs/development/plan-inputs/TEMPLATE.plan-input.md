# Plan input: <short slice title>

<!--
  Copy this file to a new name (e.g. booking-core-v1.plan-input.md) and remove this comment block.
-->

## Metadata

| Field | Value |
|--------|--------|
| **Slice ID** | `<e.g. booking-core-v1>` |
| **Status** | `draft` \| `ready` \| `superseded` |
| **Owner** | |
| **Generated plan** | `<path under paths.plans, once created, or —>` |
| **Last updated** | YYYY-MM-DD |

---

## One-line goal

<Single sentence: what exists in the codebase when this plan is done.>

---

## In scope

Concrete deliverables this plan may include (be picky; smaller is better):

- …
- …

---

## Out of scope / deferred

Explicitly **not** in this plan (prevents scope creep; list follow-up slices if known):

- …
- …

---

## Primary documents (read in order)

Link paths **relative to repo root**. Put the master index first, then depth-first into only what this slice needs.

1. `docs/00-technical-design-overview.md` — …
2. `docs/…` — …
3. …

**Optional excerpt:** If the author harness works best with one file, you may add a tiny `*.excerpt.md` that quotes only the relevant sections; still list canonical sources above.

---

## Dependencies

What must **already be merged** before this plan runs:

- [ ] …
- [ ] …

**Assumptions** (ok to be wrong, but then spike or revise docs):

- …

---

## Constraints

Adjust to your project and `5x.toml`:

| Constraint | Value |
|------------|--------|
| Target phase count | ≤ … phases (soft cap for reviewability) |
| Must touch areas | e.g. `src/db`, `src/openapi` |
| Forbidden for this slice | e.g. no new external SaaS integrations |

---

## Exit criteria

Observable checks before marking the implementation run complete (adapt to your quality gates):

- …
- …
- Tests: …
- Docs / OpenAPI: …

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices — do not implement here):

1. …
2. …

**Suggested next slice** (optional): `<filename or slice ID>`

---

## Risks / spikes

| Risk | Mitigation |
|------|------------|
| … | … |

If a risk needs exploration before commitment, name a **spike phase** inside the generated plan rather than guessing in this file.
