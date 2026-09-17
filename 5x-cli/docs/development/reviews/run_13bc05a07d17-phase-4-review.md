# Review: Review Budget Advisory — Phase 4 (budget record lines, RecordStore facade, rebuildable index)

**Review type:** `3885176654e982da5fa09f1254c2b7feb1975c70`  
**Scope:** `atomicAppendIfAllNew` on `RecordStore` (memory + working-tree), `createReviewBudgetId`, budget record-line codecs, `ReviewBudgetStore` facade, schema v8 + `ReviewBudgetIndex` / `reindexReviewBudget`, associated tests  
**Reviewer:** Staff engineer (correctness, durability, record-vs-index authority, test strategy)  
**Local verification:** `bun test test/unit/control-plane test/unit/db test/unit/review-budget` → 367 pass / 0 fail; `bunx tsc --noEmit` clean; `bunx biome check src test` clean

**Implementation plan:** `5x-cli/docs/development/plans/208-review-budget-advisory-plan.md` (Phase 4)  
**Technical design:** N/A

## Summary

Phase 4 lands the persistence layer as planned: the record line is the authority, SQLite is a rebuildable projection, and the new all-new-or-no-op append is implemented inside the existing lock/clone transaction rather than as a wrapper over `atomicAppend`. The frozen per-op `atomicAppend` contract (`[false, true]`) is preserved and regression-tested on both backends. No blockers; three small mechanical hardening items remain.

**Readiness:** Ready with corrections — all remaining items are P2 and mechanical.

---

## What shipped

- **`atomicAppendIfAllNew`**: interface method + `AtomicAppendIfAllNewResult`; memory backend clones, inspects every key, then applies and swaps; working-tree backend shares `atomicAppendUnderLock` with `atomicAppend` and returns the duplicate set under the lock without staging a journal (lock released by the existing `finally`).
- **Record lines** (`src/review-budget/record-lines.ts`): baseline/snapshot payload types, idempotency-key helpers, encode/decode with `baselineAssessment` present/omitted round-trip and structural validation.
- **Facade** (`src/control-plane/review-budget-store.ts`): record-first writes, `b0 <= 0` rejected before append, `recordedEnvelope(origin)` stamped, read-through that prefers a complete index and repairs on miss, insertion-order snapshot reads.
- **Index** (`schema.ts` v8, `review-budget-index.ts`): two tables with `record_seq` ordering, `DO NOTHING` baseline upsert (no `b0` update), snapshot upsert that preserves cached `derived_json`, `reindexReviewBudget`.
- **Tests**: shared contract cases for both stores, facade contract (record-only and indexed), reindex with `I`/`baselineDirection` recompute, schema v8, codec round-trip, phase-boundary import guard; version assertions bumped 7 → 8.

---

## Strengths

- The existence check and the write are one transaction on both backends; the duplicate path commits nothing and leaves first-writer payloads untouched, exactly per §4.0 step 5/7.
- The working-tree implementation reuses the prepared-journal commit path instead of copying the fsync protocol, so crash semantics are inherited rather than re-derived.
- Facade reads always start from the record line; an index row is never returned unless its `id` (and `baselineAssessment` presence) matches the record. This satisfies "no SQLite row is authoritative without a record line".
- Layering constraints hold: no `bun:sqlite` in the facade or codecs, no `src/protocol.ts` imports, no `createRecordContext`, and the boundary test enforces it.
- Timestamp format matches the existing `utcNow` convention in the control plane.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

### P2.1 — `atomicAppendIfAllNew` accepts a batch that repeats the same `(stream, idempotencyKey)`

Both backends inspect keys only against the pre-existing store state. A batch containing the same key twice passes the precheck; `applyOp` then returns `created: false` for the second op, so the call returns `{ created: true, results: [true, false] }`. That violates §4.0 step 6 ("every `created: true`"). Phase 6 never builds such a batch, but this is a shared contract method. Reject an intra-batch repeated key before any mutation (throw `INVALID_ATOMIC_APPEND`, alongside `requireSingleRunAtomicAppend`) in both backends and add one contract test. **Action: auto_fix.**

### P2.2 — No working-tree crash test for `atomicAppendIfAllNew`

§4.0 requires that a working-tree crash before the commit marker leaves the store unchanged. The code path is shared with `atomicAppend`, so behaviour is very likely correct, but the only failure tests for the new method are an envelope-validation throw (shared suite) and `onBeforeCommit` (memory only). Extend the existing `atomicAppend crash recovery` table in `record-store-contract.test.ts` to run the pre-commit events (`after-new`, `after-dirsync:staging`, `after-dirsync:prepared`) through `atomicAppendIfAllNew` and assert both streams are empty after recovery. **Action: auto_fix.**

### P2.3 — Facade re-lists the budget stream once per snapshot

`listSnapshots` (miss path) and `projectSnapshot` call `recordStore.listLines(runId, "budget")` inside a per-line loop to find `record_seq`. On the working-tree store each call re-reads and parses `budget.jsonl`, making repair O(n²) in file reads. Compute the ordinal from the single listing already in hand (`lines.entries()` on the unfiltered stream, as `reindexReviewBudget` does). **Action: auto_fix.**

---

## Notes (no action required this phase)

- `reindexReviewBudget` upserts but never deletes index rows whose record line is gone. The facade is immune (it validates against the record), but any later code that reads `ReviewBudgetIndex` directly would see stale rows. Phases 6–8 should read through `ReviewBudgetStore`, not the index.
- Index writes happen after the record append and are not guarded; an index failure (e.g. missing `runs` row under `foreign_keys=ON`) surfaces as a throw after a durable record write, and `getBaseline` — a read — can throw for the same reason. Retry is idempotent and repairs the projection, which matches the plan's online-repair model; Phase 6 should make sure the run row exists before the facade is used with an index.
- `atomicAppendUnderLock` returns a union narrowed with `as` casts at the two call sites. Acceptable for a private helper; overloads would be tidier.
- `appendSnapshot` accepts an optional `origin` and falls back to the baseline line's origin. This is an additive deviation from the plan signature, confined to the non-production utility path; Phase 6 paired persist does not use it.
- The reindex test uses one snapshot where the plan says two; multi-snapshot ordering is covered by the facade contract test, so coverage is adequate.
- The redundant table-level `CHECK (b0 > 0)` from the plan SQL was dropped in favour of the column check; equivalent.

---

## Readiness checklist

- [x] `atomicAppendIfAllNew` on interface + both backends; existing `atomicAppend` cases unchanged
- [x] `captureBaseline` INSERT-once; second call returns existing `b0`, no second line
- [x] Snapshots keyed to step tuple; insertion-order reads; same-`createdAt` ordering
- [x] Fresh DB → v8; v7 → v8 keeps `invocations`
- [x] Reindex restores baseline + snapshots incl. first-snapshot `baselineAssessment`; `I` / `baselineDirection` recompute identically
- [x] Type-complete against `src/review-budget/types.ts` only; boundary test in place
- [x] Tests, typecheck, lint green
- [x] P2.1–P2.3 corrections

## Phase readiness

Phase 4's completion gate is met. Phase 5 (protocol types, emit, normalize) does not depend on any of the P2 items and can proceed once the mechanical corrections are applied.
