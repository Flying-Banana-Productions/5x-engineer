# Review: Phase 3 InvocationStore and CAS contracts

**Review type:** `c7ff391d736bc84cfef0e3ce6e020ef932c43375` (and preceding Phase 3 implementation commit `27f89278e878f440d84648c51674534e10a87f02`)  
**Scope:** Phase 3 InvocationStore interface, SQLite and memory implementations, CAS/staleness behavior, contract tests, and the concurrent-test follow-up.  
**Reviewer:** Staff engineer (correctness, architecture, security, performance, operability, test strategy, and plan compliance)  
**Local verification:** `bun test --concurrent` — 2901 passed; `bun test --concurrent test/unit/control-plane/invocation-store-contract.test.ts --repeat 10` — 31 passed; `bun run typecheck` and `bun run lint` — passed.

**Implementation plan:** `docs/development/plans/207-invocation-registry-plan.md`  
**Technical design:** N/A

## Summary

Phase 3 supplies the planned provider-neutral store boundary, SQLite materialization, UTC timestamp helper, and dual-backend contract coverage. The SQLite stale-abandon predicates correctly distinguish heartbeat and run-terminal liveness, and the follow-up removes the shared connection singleton that made concurrent unit tests close one another's database.

One contract inconsistency remains in the exported memory store: without its optional `getRun` callback it treats an unavailable run lookup as proof that the run is missing, so a `run-terminal` CAS can abandon a live invocation. That violates the documented predicate and must fail closed.

**Readiness:** Ready with corrections — SQLite is sound and the concurrency-test repair is effective, but the memory-store contract needs the deterministic correction below before Phase 3 is accepted.

---

## What shipped

- **InvocationStore contract:** Registration, reads/listing, heartbeat, cancellation and terminal CAS operations, stale listing, and doctor-safe abandon-if-stale API.
- **Store implementations:** SQLite-backed registry with atomic SQL predicates and clone-safe memory implementation.
- **Timestamp handling:** Shared UTC parser for SQLite timestamps, preserving the existing doctor import compatibility.
- **Contract tests:** Dual-backend coverage plus independent, per-test databases and shared-file SQLite race cases.

---

## Strengths

- The SQLite `markAbandonedIfStale` implementation performs the liveness predicate in the update statement, avoiding the heartbeat and run-reopen TOCTOU identified by the plan.
- Registry handles remain opaque and validated; no PID field is introduced or exposed.
- SQLite uses bound parameters throughout store queries, and schema constraints remain the authority for durable lifecycle invariants.
- The test follow-up gives every test-owned SQLite connection a deterministic lifecycle and retains true two-connection shared-file CAS coverage.
- Full concurrent tests, repeated focused contract tests, typecheck, and lint all pass.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — Memory run-terminal CAS fails open when no run lookup is supplied

**Classification:** `auto_fix`

`createMemoryInvocationStore()` declares `getRun` optional, but `markAbandonedIfStale({ staleReason: "run-terminal" })` converts an omitted callback into `null` and `isRunTerminal(null)` treats it as a missing run. Consequently, callers using the public factory without a lookup can abandon any running invocation even though the store has not established that its linked run is missing, completed, or aborted. This is contrary to the interface contract and plan requirement that an active or unknown non-terminal run be a CAS miss.

**Requirement:** If no `getRun` callback is configured, a run-terminal stale-abandon request must return `{ ok: false }` without modifying the invocation. Retain successful abandonment only when the callback explicitly returns `null`, `completed`, or `aborted`.

**Implementation guidance:** In `src/control-plane/invocation-memory.ts:207-211`, distinguish an absent callback from a callback result of `null`, then add a dual-backend-adjacent memory test for the omitted-callback case.

---

## Medium priority (P2)

None.

---

## Readiness checklist

**P0 blockers**
- [x] No P0 blockers identified.

**P1 recommended**
- [ ] `auto_fix`: Make a missing memory `getRun` callback fail closed for `run-terminal` CAS and cover it with a test.

---

## Addendum (2026-08-28) — P1.1 fail-closed memory CAS follow-up

**Reviewed:** `5657a14bd6c035956136a8ea093259d8e862c3e3`

### What's addressed (✅)
- **P1.1 — `auto_fix`:** Addressed. `MemoryInvocationStore.markAbandonedIfStale` now returns a CAS miss when `getRun` is omitted (`src/control-plane/invocation-memory.ts:210-216`), while an explicit callback result of `null` still represents a missing run and permits abandonment.
- **Regression coverage:** Added direct tests for both the omitted-callback fail-closed path and the explicit-missing-run success path (`test/unit/control-plane/invocation-store-contract.test.ts:573-605`).
- **Contract documentation:** The public store contract now states that an omitted memory `getRun` is a CAS miss (`src/control-plane/invocation-store.ts:59-63`).

### Remaining concerns
- None identified in the reviewed delta. The prior finding is fully addressed; no new correctness, architecture, security, performance, operability, test, or plan-compliance issues were found.

### Updated readiness
- **Phase 3 completion:** ✅ — The SQLite and memory stores now both honor the run-terminal stale-abandon safety contract, and the focused concurrent tests (33 passing, repeated 10 times), typecheck, and lint pass.
- **Ready for next phase:** ✅
