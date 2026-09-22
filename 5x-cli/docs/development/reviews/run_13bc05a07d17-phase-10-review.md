# Review: Review Budget Advisory — Phase 10 (Integration, compatibility, and exports)

**Review type:** `efb06388f33b640688178e8a74699e743e116dba` (with preceding Phase 10 commit `a074e48`)  
**Scope:** Public API exports in `src/index.ts` / `src/control-plane/index.ts`, `test/integration/commands/review-budget.test.ts`, `test/unit/review-budget/public-api.test.ts`, plan-input metadata  
**Reviewer:** Staff engineer (correctness, API surface, compatibility, test strategy)  
**Local verification:** `bun test` — 3446 pass / 0 fail across 215 files; `bunx tsc --noEmit` clean; `biome check` clean on touched files

**Implementation plan:** `docs/development/plans/208-review-budget-advisory-plan.md` (Phase 10)  
**Technical design:** N/A

## Summary

Phase 10 closes the slice: the root package now exports the delivery-budget parser, `deriveBudget`, domain types/guards/constants, record-line payload types, the `ReviewBudgetStore` facade types and factory, `reindexReviewBudget`, and `createReviewBudgetId`. A new spawn-the-CLI integration suite covers every row of the §10.2 compatibility matrix against the working-tree `RecordStore`, including index-wipe reconstruction through `run state`. No production logic changed in this phase.

**Readiness:** Ready — completion gate met (`bun test` green, exports updated, matrix covered); no corrections required.

---

## What shipped

- **Public exports (`src/index.ts`)**: `parseDeliveryBudget`, `incorporatedFindingIds`, `rawDeliveryBudgetSection`, `DeliveryBudgetParse*` types; `deriveBudget`; record-line payload types; facade types + `createReviewBudgetStore`, `reindexReviewBudget`, `createReviewBudgetId`; `AtomicAppendIfAllNewResult`. `efb0638` completes the domain surface (scales, enums, `ReviewBudgetConfig`, `DEFAULT_REVIEW_BUDGET_CONFIG`, `EFFORT_POINTS`, `ARCHITECTURE_DELTAS`, guards) so every exported function signature is nameable by consumers.
- **`control-plane/index.ts`**: adds the missing `AppendSnapshotInput` re-export.
- **Integration suite**: six CLI round-trip tests — v1 emit/validate unchanged + CLI-owned key rejection; baseline capture at render, paired decorated persistence, idempotent retry, index wipe → `run state` rebuild, malformed-plan-after-baseline failure leaving `B0` untouched; fail-closed render for missing section / missing debt evidence; mid-review v1_compat then opt-in; `5x.toml.local` `mode = "off"` and implementation-review v1 contract; `enforced` warning on both render and direct `--record` capture with unchanged routing.
- **Public API unit test**: runtime + compile-time export assertions, and negative assertions that the SQLite index constructor and `bun:sqlite` do not leak through the root.
- **Docs**: plan-input `Generated plan` metadata pointed at the plan; Phase 10 checklist marked complete.

---

## Strengths

- Integration assertions read record lines through `createWorkingTreeRecordStore` and the facade, not SQLite — exactly the "do not green the matrix with SQLite-only baselines" constraint in §10.3.
- The wipe-and-rebuild test proves the record/cache split end to end (`I` and `B0` survive index deletion and the index is repopulated).
- The retry case asserts line counts for both streams, which pins the all-new-or-no-op pairing at the process boundary.
- Export boundary is deliberate: repair (`reindexReviewBudget`) is public, index construction is not, and a test guards that.
- `BaselineAssessment` is exported once from the domain types; protocol's re-export remains the same type, per §10.1.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

None requiring action. Observations only (not review items):

- The integration suite drives `protocol validate --record` only; `invoke reviewer --record` pairing remains covered at the unit level (Phase 7). This matches §10.3, which does not require an invoke spawn test.
- `run state` `status: "v1_compat"` is asserted in `test/unit/commands/run-state-review-budget.test.ts` rather than in the mid-review integration test; acceptable duplication avoidance.
- The source-text assertion on the exact `PlanScopeClass` formatting in `public-api.test.ts` is formatter-sensitive; it is stable under the repo's biome config, so no change requested.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [x] None

**Plan compliance (Phase 10)**
- [x] 10.1 exports present; no SQL helpers or SQLite-only store exported
- [x] 10.2 compatibility matrix — all 12 rows covered
- [x] 10.3 integration tests use `cleanGitEnv`-style spawn helpers, working-tree `RecordStore`, 30s timeouts
- [x] 10.4 `5x.toml.local` overlay disables capture
- [x] Full `bun test` green

---

## Overall production readiness

All ten phases are complete. The slice is additive and advisory: `mode = "off"` and mid-review runs retain v1 behavior, routing and `human_required` semantics are unchanged, authoritative facts live in record lines with SQLite as a rebuildable index, and failure paths are fail-closed with no partial writes. Typecheck, lint, and the full suite pass. The slice is ready to merge.
