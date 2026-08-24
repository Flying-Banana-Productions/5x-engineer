# Review: Phase 2 state-root and pointer lifecycle

**Review type:** `7cf5c0f32d154f9865b60a909a4eba067e04f614` and follow-on commits  
**Scope:** Phase 2 control-plane state paths, `current-run` lifecycle, and associated tests  
**Reviewer:** Staff engineer (correctness, reliability, operability, tests)  
**Local verification:** `bun run lint` passed; targeted `bun test test/unit/commands/control-plane-state-path.test.ts test/unit/commands/run-pointer.test.ts test/integration/commands/run-v1.test.ts` passed (54 tests). Full `bun test` exceeded the 120-second review timeout without reporting a test failure.

**Implementation plan:** `docs/development/plans/204-run-context-ergonomics-plan.md`  
**Technical design:** `docs/v2/204-run-context-ergonomics.md`

## Summary

The implementation correctly centralizes state-file path construction and updates the in-scope DB consumers to avoid absolute-path shadow databases. Pointer helpers are small, fail predictably on I/O errors, and lifecycle tests cover overwrite, conditional clearing, and the pre-existing managed absolute-state-root case. However, a first `run init` in a project configured with an absolute `db.path` but without an already-created DB writes the database at the configured state root while writing `current-run` under the checkout's `.5x`; this violates the required shared state root and leaves a stale pointer after completion.

**Readiness:** ready_with_corrections — one directly derivable state-root correctness fix is required before Phase 2 is complete.

---

## What shipped

- **Control-plane state paths:** Added `controlPlaneStatePath` and `controlPlaneDbPath`, and migrated the Phase 2 direct DB-open call sites.
- **Focus pointer lifecycle:** Added pointer read/write/conditional-clear helpers; `run init` writes a pointer and export hint, and `run complete` clears only a matching pointer.
- **Coverage:** Added unit coverage for relative/absolute state paths and pointer helpers, plus lifecycle integration coverage including a pre-existing absolute state DB.

---

## Strengths

- Absolute state directories are handled in one shared helper rather than repeated path joins.
- The pointer clear operation preserves a newer run's pointer and treats a missing pointer as a no-op.
- The integration test asserts both the real absolute DB/pointer location and absence of a shadow path.
- The changed code passes formatting/lint and the focused unit/integration suite.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — Bootstrap pointer uses a different state root than its DB

**Classification:** `auto_fix`

When `resolveControlPlaneRoot()` returns `none`, `runV1Init` correctly opens the configured `db.path` via `stateDirForDb`, but still calls `writeFocusPointer(projectRoot, stateDir, runId)` with `controlPlane.stateDir`, which is `.5x` in none mode. Thus a fresh project with an absolute configured `db.path` creates `<absolute-state-dir>/5x.db` and `<project>/.5x/current-run`. A subsequent `run complete` resolves the now-existing DB as managed and tries to clear `<absolute-state-dir>/current-run`, leaving the local pointer stale. Use the same effective state-root value for the init pointer as for the DB, and add an integration case for an absolute configured path with no pre-created DB; assert init and matching completion use only the configured state root.

**Location:** `src/commands/run-v1.handler.ts:891-895,1005`; `test/integration/commands/run-v1.test.ts:1975-2086`

---

## Medium priority (P2)

None.

---

## Readiness checklist

**P0 blockers**
- [x] No P0 blockers identified.

**P1 required corrections**
- [ ] P1.1 (`auto_fix`): Keep the bootstrap DB and `current-run` pointer in the same configured state root, including first-use absolute `db.path`.

---

## Canonical review outcome

```json
{
  "readiness": "ready_with_corrections",
  "items": [
    {
      "id": "P1.1",
      "title": "Bootstrap pointer uses a different state root than its DB",
      "action": "auto_fix",
      "reason": "Fresh absolute-db.path projects write current-run under .5x while the DB is at the configured state root, leaving a stale pointer after completion.",
      "priority": "P1"
    }
  ],
  "summary": "Phase 2 correctly handles existing absolute state roots, but first-use absolute db.path bootstrap splits the DB and pointer roots. Apply the mechanical state-root fix and regression test before proceeding."
}
```

## Protocol-metadata recovery addendum

This recovery records the finding with the canonical reviewer item metadata required for routing. The state-root split is directly derivable from the implementation and is an automatic correction, not a human decision.

```json
{
  "readiness": "ready_with_corrections",
  "items": [
    {
      "title": "Bootstrap pointer uses a different state root than its DB",
      "action": "auto_fix",
      "reason": "In none mode with a first-use absolute db.path, run init opens the DB at the configured absolute state root but writes current-run under the checkout .5x directory; later completion clears the absolute location and leaves the local pointer stale."
    }
  ],
  "summary": "One mechanical state-root correction and regression test are required before Phase 2 is complete."
}
```

## Re-review addendum — `cad56406ecb48a7d001d60c3b05cc0a7b15e7c56`

**Prior P1.1 status:** addressed. `runV1Init` now passes `stateDirForDb` to both resumed and newly-created pointer writes, so none-mode first use of an absolute configured `db.path` puts `5x.db` and `current-run` in the same absolute state root. On completion, control-plane discovery is managed and resolves that same root for the conditional clear.

The added integration case starts with no state DB, asserts that the DB and pointer are created only in the configured absolute state root, rules out local/shadow paths, and verifies matching completion clears that pointer. The full current Phase 2 implementation was inspected; no new in-scope issues were identified. `bun run lint` and the focused Phase 2 unit/integration suite passed (55 tests).

### Canonical re-review outcome

```json
{
  "readiness": "ready",
  "items": [],
  "summary": "The prior bootstrap state-root split is addressed and no new Phase 2 issues were found."
}
```
