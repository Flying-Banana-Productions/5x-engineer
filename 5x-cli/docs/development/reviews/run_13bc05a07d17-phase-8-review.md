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
