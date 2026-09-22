# Review: 208 Review Budget Advisory — Phase 8 (Run-state output)

**Review type:** `7d97e0d3c6a2d88b315e31aae61fab8ca55735d2`  
**Scope:** `review_budget` header in `5x run state` JSON + text (`src/commands/run-v1.handler.ts`), new unit test `test/unit/commands/run-state-review-budget.test.ts`  
**Reviewer:** Staff engineer (correctness, record-vs-cache integrity, operability, test strategy)  
**Local verification:** `bun test test/unit/commands test/integration/commands/run-v1.test.ts test/integration/records` — 688 pass / 0 fail; `bunx tsc --noEmit` clean; `bunx biome check` on touched files clean. Ad-hoc repro written for P1.1 (fails as described; not committed).

**Implementation plan:** `5x-cli/docs/development/plans/208-review-budget-advisory-plan.md` (Phase 8)  
**Technical design:** N/A

## Summary

Phase 8 adds a `review_budget` object to `5x run state` (DB path and git-record `--plan` path) and a one-line `Budget:` text forecast. The builder is a pure exported function over the `ReviewBudgetStore` facade, reads through an empty index, prefers cached `derived`, and recomputes from record lines via `deriveBudget` — all consistent with the plan's record-vs-cache decision. The gate's headline requirement (post-wipe `I` / `baseline_direction` match record-time) is met and tested. One correctness gap: every recompute path hard-codes `semanticHumanRequired: false`, so `requires_human` silently flips from `true` to `false` after an index wipe and is always understated on the git-record path. Test coverage is thin relative to the branches shipped.

**Readiness:** Ready with corrections — one mechanical P1 (recomputed `requires_human` diverges from record time) plus test/operability P2s; no human decisions needed.

---

## What shipped

- **`buildReviewBudgetState`** (`run-v1.handler.ts:984`): `off` → omitted; no baseline → `v1_compat` / `uninitialized`; baseline → `active` with numbers from latest snapshot `derived`, recompute fallback, pre-first-record fallback (`R = 0`, live plan parse or original ledger), `stale_plan` drift flag.
- **`runV1State` wiring**: DB path uses `createRecordContext` + `createReviewBudgetStore(recordStore, createReviewBudgetIndex(db))`; git-record path loads `budget.jsonl` (commit + working-tree fallback) into a `MemoryRecordStore` and reuses the same builder.
- **Text formatter**: `Budget:  W+R=…  E=…  band=…  alerts=…  (mode[, stale plan])`, or `status=…` when not active.
- **Enforced-mode warning** on stderr via injectable `warn`; `enforcement_implemented: false` always.
- **Test seams**: `RunStateParams.dbContext`, `RunStateParams.warn`.
- **Tests**: 4 unit tests (off/v1_compat, index-wipe reconstruction, text line, enforced warning).

---

## Strengths

- Single pure builder shared by both state paths; no formula duplication — all numbers come from `deriveBudget` / `sumEffort`, per the "one pure module" design decision.
- Record is authoritative: index wipe is repaired by read-through in the facade, and `I` comes from the first snapshot carrying `baselineAssessment`, exactly as §8.1 specifies. The extra `derived.I === null && initialAssessment` guard defends against stale/incomplete cache rows.
- `stale_plan` compares against snapshot `W` without mixing sources; snapshot numbers remain displayed.
- Git-record path degrades gracefully on absent/undecodable `budget.jsonl` (empty lines → `uninitialized`/`v1_compat`).
- Existing fail-closed worktree check runs before `createRecordContext`, so the new context construction does not introduce a new unhandled `RecordContextError` path.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — Recomputed `requires_human` drops semantic `human_required` (diverges from record time) — `auto_fix`

Both recompute branches in `buildReviewBudgetState` (`run-v1.handler.ts:1028`, `:1043`) pass `semanticHumanRequired: false`. At record time `apply.ts:303` passes `verdict.items.some(item => item.action === "human_required")`. Consequences:

- After an index wipe (or null `derived_json`), `review_budget.requires_human` flips `true → false` for a review whose only human trigger was a `human_required` item. Verified with an ad-hoc test: before wipe `true`, after wipe `false`.
- The read-through in `listSnapshots` re-upserts snapshots with `derived: null`, so the wrong value is then permanent for that run, not transient.
- The git-record (`--plan`) path has no index at all, so it *always* recomputes and *always* understates.

This violates the plan's "after a wipe the header matches what was computed at record time" intent; `FindingDelta` does not carry `action`, so the snapshot alone cannot supply it. The fix is derivable: the snapshot record carries its step key (`stepName`/`phase`/`iteration`), and the coupled reviewer step line (always co-written via `atomicAppendIfAllNew`) holds the verdict items and the `budget` decoration in `result_json`. Add an optional `semanticHumanRequiredFor(snapshot)` (or pre-resolved boolean) input to `buildReviewBudgetState`, have both `runV1State` paths resolve it from the matching step (record `steps` lines in the DB path, `gitRecord.steps` in the git path) using the same `items.some(action === "human_required")` predicate as `apply.ts`, and extend the index-wipe test to assert `requires_human` equality with a `human_required` fixture. The pre-first-record branch (`!latest`) correctly stays `false`.

---

## Medium priority (P2)

- **P2.1 — Test coverage gaps for shipped branches (`auto_fix`)**: No tests for `uninitialized`, active-without-snapshot (pre-first-record: `R = 0`, live plan parse, fallback to `originalLedger` on parse failure), `stale_plan: true` (and its absence when `W` matches), text formatter's non-active `status=` line and `stale plan` suffix, or the null-`derived` cache row (as opposed to a fully wiped index). The new `dbContext` seam is unused: nothing exercises `runV1State` end-to-end to assert `review_budget` presence in the envelope, its omission under `mode = "off"`, or the git-record `budget.jsonl` path. Patterns exist in `run-identity-wiring.test.ts` and `run-v1.test.ts`.
- **P2.2 — Corrupt budget line crashes `run state` (`auto_fix`)**: `getBaseline` / `listSnapshots` decode payloads and throw on a malformed line; `buildReviewBudgetState` is called unguarded in both paths, so one bad `budget.jsonl` line takes down the operator's primary diagnostic command (steps, summary and all). The git-record loader already swallows JSONL decode failures; mirror that posture: catch around the builder, emit a `warn(...)` naming the run, and omit `review_budget` (do not fabricate `uninitialized`, which the plan forbids when a baseline line exists).
- **P2.3 — Duplicated warning literal (`auto_fix`)**: `ENFORCED_REVIEW_BUDGET_WARNING` duplicates the string in `src/review-budget/ensure-baseline.ts:75`. Export one constant from the review-budget module and use it in both places.
- **P2.4 — Text line deviates from the plan sample (`auto_fix`, cosmetic)**: plan shows `(advisory)`; implementation prints the configured mode, so `enforced` renders `(enforced)` even though behavior is advisory-only. Print `(advisory)` — or `(enforced: not implemented)` — so text mode cannot suggest enforcement is live; JSON already has `enforcement_implemented: false`.
- **Note (no action)**: `run state` now writes to the SQLite index as a side effect of read-through repair. This is what the plan prescribes ("reconstruct via … read-through from the facade"); worth remembering if `run state` is ever invoked against a read-only DB.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 — recomputed `requires_human` honors the recorded verdict's `human_required` items (DB path and git-record path), with a wipe-equality test

**P2**
- [ ] P2.1 — tests for uninitialized / pre-first-record / `stale_plan` / null-derived row / `runV1State` envelope + git-record path
- [ ] P2.2 — guard builder against undecodable budget lines; warn and omit
- [ ] P2.3 — single shared enforced-mode warning constant
- [ ] P2.4 — text label cannot imply enforcement

**Phase readiness:** Phase 8 completion gate is met for JSON presence/omission, text block, and post-wipe `I` / `baseline_direction`. Ready for Phase 9 once P1.1 is corrected; P2s can ride along in the same fix commit.

---

## Addendum (2026-09-17) — Re-review at `51cb624`

**Reviewed:** `dc43d56361bec738dc4678340567f81603fe4222` (fix commit) + `51cb624f88327c120bb16a838a8f2bf8c8146dfa` (test-isolation follow-up)  
**Local verification:** `bun test test/unit/commands test/integration/commands/run-v1.test.ts test/integration/records` — 700 pass / 0 fail (up from 688); `bun test test/unit/commands/run-state-review-budget.test.ts test/unit/commands/run-state-review-budget-wiring.test.ts` — 16 pass / 0 fail; `bunx tsc --noEmit` clean; `bunx biome check` on all touched files clean.

### What's addressed (✅)

- **P1.1 — recomputed `requires_human` diverges from record time**: Fixed. `buildReviewBudgetState` now accepts an optional `semanticHumanRequiredFor(snapshot)` callback and threads it into both `deriveBudget` recompute branches (`run-v1.handler.ts`, index-wipe and null-derived-cache paths) in place of the hard-coded `false`. Both `runV1State` call sites supply real implementations:
  - DB path: looks up the coupled `reviewer:*` step by its idempotency key in the record store first (handles the parsed-JSON `StepRecordPayload.result_json` shape), falling back to `getSteps(db, run.id)` + `semanticHumanRequiredFromSteps` (handles the string-encoded `StepRow.result_json` shape) if the record line isn't found.
  - Git-record path: `semanticHumanRequiredFromSteps(snapshot, allSteps)` against `formatGitRecordStep`'s string-encoded `result_json`.
  - `resultHasHumanRequired` correctly normalizes both the parsed-object and JSON-string encodings via a `typeof value === "string"` branch, so both call sites resolve to the same predicate as `apply.ts`'s record-time `verdict.items.some(action === "human_required")`.
  - Verified independently: the index-wipe unit test now asserts `after.requires_human === before.requires_human === true`, and a new wiring test (`runV1State recomputes semantic requires_human from the coupled step`) exercises the full DB path end-to-end with a `human_required` step appended via the record store. Confirmed **fixed**, not just tested — re-ran the original repro pattern from the prior review manually against current code and the flag now holds `true` post-wipe.
  - Minor residual note (not a new blocker): the DB-path closure returns `false` immediately when `snapshot.iteration === null` rather than falling through to the `semanticHumanRequiredFromSteps` fallback for that case. Per the plan's Phase 6 provenance ("generic `recordStepInternal` allocates [iteration] only afterward"), admitted steps always end up with an allocated iteration by the time `run state` reads them, so this is a defensive branch for a state that shouldn't occur in practice, not a live gap.

- **P2.1 — thin test coverage**: Fixed. Two new/expanded suites (`run-state-review-budget.test.ts` grew from 4 to 12 tests; new `run-state-review-budget-wiring.test.ts` adds 6 end-to-end tests) now cover: `uninitialized` status, active pre-first-record with live-plan parse and malformed-plan fallback to `originalLedger`, `stale_plan: true`/absent, a null-derived cache row recomputing with the semantic flag, the non-active and `enforced` text-label rendering, the `stale plan` text suffix, a fully-wired `runV1State` call (both DB and git-record selectors) asserting `review_budget` presence/omission under `mode=off`, and the coupled-step semantic lookup on both paths. This closes essentially all the gaps named in the original P2.1.

- **P2.2 — corrupt budget line crashes `run state`**: Fixed. New `tryBuildReviewBudgetState` wraps `buildReviewBudgetState` in try/catch, warns with a message naming the run and "omitting review_budget", and returns `undefined` instead of throwing. Both `runV1State` call sites (DB and git-record) now route through it. The git-record loader additionally surfaces JSONL decode failures explicitly via a new `budgetDecodeError` field (rather than silently swallowing to an empty array as before), and `runV1State` warns + omits on that path too. Two new tests (`malformed record payload warns and omits review_budget`, `runV1State warns and omits corrupt budget records`, plus `git-record loader surfaces malformed budget JSONL`) exercise this for both paths.

- **P2.3 — duplicated warning literal**: Fixed. `ENFORCED_REVIEW_BUDGET_WARNING` is now defined once in `src/review-budget/ensure-baseline.ts` and imported by `run-v1.handler.ts`; a test asserts the run-state warning path uses the shared constant.

- **P2.4 — text label implies enforcement is live**: Fixed. `formatStateText` now computes a `modeLabel` that renders `"advisory"` for advisory mode and `"enforced: not implemented; advisory telemetry"` for enforced mode, used in both the active and non-active render branches. A test explicitly asserts the output contains `"enforced: not implemented"` and does **not** contain the bare `"(enforced)"` string.

### Remaining concerns

None blocking. No new issues were introduced by the revision — the diff is scoped exactly to the four flagged items plus their test coverage, and a small unrelated test-isolation fix (`progressResolver` seam on `RunStateParams`, added in `51cb624`) that decouples the new wiring tests from the git-backed progress resolver. That seam is additive, optional, and doesn't change production behavior (falls back to `resolvePlanProgress` when omitted).

### Updated readiness

- **Phase 8 completion:** ✅ — all P1/P2 items from the initial review are resolved and verified with passing tests, clean typecheck, and clean lint; no regressions in the broader `run-v1`/records suite (688 → 700 passing).
- **Ready for next phase:** ✅ — Phase 8 can be considered complete; proceed to Phase 9 (templates, skills, docs).
