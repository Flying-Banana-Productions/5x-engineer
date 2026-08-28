# Review: Invocation Registry — Phase 6 Doctor Stale-Entry Check

**Review type:** `499f851ff349b108e558a506d26500bfd835b13d` (and subsequent commits: none)  
**Scope:** Phase 6 stale heartbeat and terminal-run detection, doctor repair CAS safety, messaging, registry identity, metadata-only behavior, and specified tests.  
**Reviewer:** Staff engineer (correctness, architecture, security, performance, operability, tests, and plan compliance)  
**Local verification:** Focused Phase 6 tests — 49 passed; `bun run typecheck` — passed; `bun run lint` — passed. A full `bun test` run exceeded the 120-second review timeout without reporting a test failure.

**Implementation plan:** `docs/development/plans/207-invocation-registry-plan.md`  
**Technical design:** N/A

## Summary

Phase 6 meets the stale-entry doctor contract. The seventh check identifies running rows whose heartbeat has exceeded the shared lifecycle TTL or whose linked run is missing/terminal, prioritizes the run-terminal predicate when both apply, and uses `ctx.now` for heartbeat age. Repair performs friendly predicate revalidation, then delegates correctness to `markAbandonedIfStale`; its expected timestamp or same-write terminal-run predicate prevents a concurrent heartbeat or reopen from abandoning a live row. Findings have stable per-invocation identity, and all user-facing stale messages accurately state that provider processes are not reaped.

**Readiness:** Ready — no blocking correctness, architecture, security, performance, operability, test, or plan-compliance issues found.

---

## What shipped

- **Detection:** Read-only scan of running invocation rows with stale-heartbeat OR missing/completed/aborted-run predicates; terminal-run is selected when both are true.
- **Safe repair:** Writable re-read and friendly revalidation followed by authoritative `markAbandonedIfStale`, with race-loss messages for refreshed heartbeats and reopened runs.
- **Operational safety:** Repair abandons only registry metadata; it neither resolves/calls cancellation adapters nor kills/reaps processes.
- **Registry integration:** Adds the seventh built-in check and stable `INVOCATION_STALE` finding keys using `detail.invocationId`.
- **Tests:** Covers clean, heartbeat-stale, run-terminal, combined, completed, successful repair, adapter non-use, and both required competing-writer cases, plus doctor CLI coverage.

---

## Strengths

- The check imports the lifecycle-owned `INVOCATION_STALE_MS` rather than defining a divergent TTL and evaluates heartbeat age against `ctx.now`.
- Run-terminal repair is not invalidated by an irrelevant fresh heartbeat; the store performs the still-terminal/missing run predicate atomically with the status transition.
- The heartbeat repair uses the post-revalidation `updatedAt` as its expected value, making the CAS—not the friendly revalidation—the concurrency correctness gate.
- The implementation preserves the plan's explicit no-PID, no-adapter-call, and no-process-reap boundary.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

None.

---

## Issue action classification

No issues identified; no `auto_fix` or `human_required` actions are required.

---

## Readiness checklist

**P0 blockers**
- [x] Stale heartbeat and missing/terminal-run predicates are detected for running rows, with run-terminal precedence.
- [x] Shared TTL and `ctx.now` are used for deterministic heartbeat age evaluation.
- [x] `--fix` revalidates, then uses predicate-aware `markAbandonedIfStale`; competing heartbeat and run-reopen cases retain the running row.
- [x] `INVOCATION_STALE` keys use `detail.invocationId` and malformed fixable findings fail safely.

**P1 recommended**
- [x] Stale finding text accurately states metadata-only repair and that the underlying provider process is not reaped.
- [x] Focused tests, typecheck, and lint pass; the full suite showed no failure before the review timeout.
