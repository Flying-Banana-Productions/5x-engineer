# Review: Phase 3 working-tree JSONL RecordStore

**Review type:** `516ce06f9d2513deb706f427f0dda08a3fdeae63` and follow-ons  
**Scope:** Phase 3 JSONL layout/codecs, durable mixed-stream transaction recovery, per-run locking, redaction helpers, and git helpers.  
**Reviewer:** Staff engineer (correctness, durability, security, operability, tests)  
**Local verification:** `bunx tsc --noEmit && bun test --concurrent` — 3111 pass, 0 fail; focused Phase 3 suite — 104 pass, 0 fail.

**Implementation plan:** `docs/development/plans/212-git-native-run-records-plan.md`

## Summary

The implementation establishes a well-tested working-tree RecordStore with versioned JSONL codecs, durable staging/commit-marker mechanics, atomic hard-link lock publication, and the requested git/redaction helpers. The happy path, normal crash boundaries, live/stale lock handling, and codec compatibility cases are strong. It is not ready to advance because recovery can accept a missing staged replacement without verifying the corresponding live stream, exposing a mixed batch, and the public `atomicAppend` contract is not made safe for multi-run inputs.

**Readiness:** Not ready — two transaction-integrity gaps must be corrected and covered before Phase 4 depends on the store.

---

## What shipped

- **Working-tree RecordStore:** JSONL-backed run summaries and three record streams with contract-suite coverage.
- **Durability and locking:** Per-run journal, commit marker, directory sync calls, crash recovery, and atomic lock publication.
- **Codecs and privacy helpers:** Forward-compatible envelopes, origin parsing/stripping, and payload/origin redaction utilities.
- **Git helpers:** Patch ID, numstat, show, and last-touching-commit helpers with unit coverage.

---

## Strengths

- Lock publication uses a fsynced unique temp plus `linkSync`, avoiding the empty-`wx` lock creation race.
- Codec validation correctly preserves caller-supplied `runId`, rejects conflict markers, and applies recorded/backfilled origin rules.
- Fault-injection and multi-process tests exercise meaningful recovery and contention scenarios.
- Newer run-summary formats are read-compatible but protected from destructive rewrites.

---

## Production readiness blockers

### P0.1 — Committed recovery can expose a partial mixed-stream transaction

**Classification:** `auto_fix`

**Risk:** When a valid commit marker exists, `rollForward` treats a missing `.txn.<stream>.new` as proof that the replacement was completed. It does not verify that the live `<stream>.jsonl` hashes to the journal's `new_sha256`. A lost/deleted staging file before its rename (or other on-disk corruption) therefore permits recovery to clean the journal and return one old stream beside another newly applied stream, violating the fail-closed all-or-nothing requirement.

**Requirement:** For every listed stream with no staged `.new`, verify the live stream exists and matches `new_sha256`; otherwise throw `RECORD_TXN_CORRUPT` without deleting artifacts. Add fault coverage for a committed batch with one `.new` removed while its live stream remains old/missing, asserting all reads fail closed and artifacts remain.

**Location:** `src/control-plane/record-fs.ts:1123-1138` (`rollForward`)

---

### P0.2 — `atomicAppend` silently loses atomicity for multi-run input

**Classification:** `auto_fix`

**Risk:** The public `AppendOp` carries `runId` and neither interface nor implementation restricts a batch to one run. The filesystem implementation acquires all locks but commits each run's independent journal sequentially; a process crash after the first `commitPrepared` makes one run durable and leaves later runs absent. This differs from the memory implementation, which clone-swaps all referenced runs, and violates the documented all-or-nothing operation semantics.

**Requirement:** Either reject batches containing more than one `runId` consistently in both backends before mutation, documenting the per-run transaction boundary, or implement a durable cross-run coordinator. Add contract coverage for the chosen behavior and a crash case if cross-run batches remain supported.

**Location:** `src/control-plane/record-fs.ts:567-670`; `src/control-plane/record-memory.ts:215-250`

---

## High priority (P1)

None.

---

## Readiness checklist

**P0 blockers**
- [ ] P0.1: Validate the live hash when a committed journal's staged replacement is absent; fail closed on mismatch.
- [ ] P0.2: Define and enforce/implement atomicity for multi-run `atomicAppend` batches consistently across backends.

**P1 recommended**
- [x] Preserve the existing focused codec, crash-recovery, and multi-process lock coverage while adding the missing integrity cases.

---

## Addendum (2026-09-03) — Transaction-integrity remediation

**Reviewed:** `5c0723209a13d6d13f60ab1e648a6bec470f42f7` (including remediation commit `97774fc`)

### What's addressed (✅)
- **P0.1 — committed recovery validation:** ✅ Resolved. `rollForward` now checks every missing staged replacement against the journal's expected live SHA-256 and throws `RECORD_TXN_CORRUPT` before cleanup when it cannot prove the replacement was applied. New tests cover both a missing live target and a retained old target after deleting one committed `.new` file.
- **P0.2 — multi-run atomic batches:** ✅ Resolved. The contract explicitly scopes `atomicAppend` to one run, and both memory and filesystem stores call the shared pre-mutation validator, returning `INVALID_ATOMIC_APPEND` for mixed-run batches. The shared contract verifies neither run mutates.

### Remaining concerns
- No regressions identified in the remediation diff. The focused record-store tests pass (80 tests) and `bunx tsc --noEmit` passes.

### Updated readiness
- **Phase 3 completion:** ✅ — prior transaction-integrity blockers are addressed with matching contract and fault-injection coverage.
- **Ready for next phase:** ✅
