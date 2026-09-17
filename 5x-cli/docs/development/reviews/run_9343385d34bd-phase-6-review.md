# Review: Git-native run records — Phase 6

**Reviewed commits:** `f62c83951fd836575b6279b0a4ccf9a0905d18eb` through `1e291c86bc52f8ff4ac51b95e965e1a58c1fd792`  
**Scope:** Records index rebuild and doctor records check.

## Summary

The command, index projection, read-only provenance handling, no-clobber behavior for existing keys, and focused tests are solid. The phase is not ready: divergent record histories are silently projected from one selected ref, and doctor does not recover a transaction that belongs to a dead/absent lock owner as required.

## Verification

- Focused Phase 6 unit/integration suites: 25 pass, 0 fail.
- `git diff --check` passes.
- `bun test --concurrent` did not complete: it failed `test/integration/commands/invoke-pipe.test.ts` (`explicit --var plan_path=other.md overrides piped data.plan_path`) and then exceeded the 120s review timeout. This appears outside the changed Phase 6 paths, but the full quality gate is not green in this checkout.

## Blocking items

### P1 — Diverged refs are silently selected for index projection

**Location:** `src/records/index-rebuild.ts:413-432`.

`collectRecordIndexSnapshot` consumes `resolved.commit` even when `resolvePlanProgress` returns `source.kind === "diverged"`. The resolver chooses that commit from the highest checklist-progress candidate, so `records index` (and doctor drift detection) materializes one side of split record history without surfacing or resolving the divergence. This violates the plan's "Diverged refs are reported, never picked" rule and can make the local SQLite index omit runs/steps on the other surviving ref.

**Required fix (auto_fix):** Preserve the divergence result in the index snapshot and fail/report it rather than indexing a selected side, or define and implement a non-lossy multi-source projection with explicit source/divergence reporting. Add a real-Git regression with divergent record directories proving no arbitrary side is materialized.

### P1 — Doctor leaves recoverable abandoned transactions unresolved

**Location:** `src/doctor/checks/records.ts:231-245`.

For an absent or stale lock, doctor only calls the non-mutating `isRunTxnCorrupt`; it never acquires/steals the per-run lock and invokes recovery. A valid prepared or committed transaction from a dead process therefore remains torn/incomplete on disk, doctor can return `RECORD_INDEX_OK`, and the SQLite drift view is calculated before the transaction is completed or rolled back. Phase 6 explicitly requires doctor to acquire/steal an absent/stale lock and recover it, while skipping live or malformed locks.

**Required fix (auto_fix):** Expose/use a lock-held recovery operation for doctor. For absent/stale locks, acquire or steal the lock, recover, release it in `finally`, and emit `RECORD_TXN_CORRUPT` only if recovery fails closed. Retain the current no-touch handling for live and malformed locks. Add cases for valid prepared rollback, valid committed roll-forward, and a stale lock.

## Readiness

Not ready pending both P1 fixes.

## Addendum — Phase 6 blocker fixes (2026-09-03)

**Reviewed:** `138cfef8214aba9332c1bbc0ca93f7c2af5539f1`

### P1 resolved — Diverged refs are not projected

The index snapshot now records diverged plans and excludes their records. `rebuildRecordsIndex` fails with `RECORD_PROGRESS_DIVERGED` before any projection, and doctor reports the same non-fixable condition without producing misleading missing/extra-row drift findings. Unit and integration fixtures cover distinct runs on both divergent sides and verify neither is materialized.

### P1 resolved — Doctor recovers abandoned transactions under the writer lock

Doctor now skips live and malformed publication-window locks, while absent/stale locks go through the store's lock-held recovery path. Valid prepared journals roll back, valid committed journals roll forward, stale locks are released after recovery, and corrupt transactions remain fail-closed with their artifacts intact. The added tests cover each case.

### Verification

- Phase 6 unit/integration suites: 31 pass, 0 fail.
- `bun run typecheck` passes.
- `bun run lint` passes.
- `git diff --check b3d640a..138cfef` passes.

### Updated readiness

Ready for the next phase. No remaining Phase 6 blockers or regressions found in the reviewed changes.
