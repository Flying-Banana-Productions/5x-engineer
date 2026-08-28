# Review: Invocation Registry — Phase 4 Invoke Registration Lifecycle

**Review type:** `8573e9cbd6024a7a8719379cdef7a46b6533202c` (and subsequent commits: none)  
**Scope:** Phase 4 lifecycle registration, heartbeat ownership, terminal CAS behavior, provider-close ownership, fault paths, and specified tests.  
**Reviewer:** Staff engineer (correctness, architecture, security, performance, operability, tests, and plan compliance)  
**Local verification:** `bun test --concurrent` — 2,918 passed; `bun run typecheck` — passed; `bun run lint` — passed; focused lifecycle and invoke-registry tests — 15 passed.

**Implementation plan:** `docs/development/plans/207-invocation-registry-plan.md`  
**Technical design:** N/A

## Summary

Phase 4 meets its lifecycle contract. A successful session is registered before either fallible log operation, all post-session execution (including validation) runs inside the lifecycle boundary, and the outer `finally` owns provider close. The independent, rate-limited heartbeat interval is cleared on both terminal paths, while the stream callback is only an optimization. Terminal writes retain CAS semantics and do not overwrite an abandonment race.

**Readiness:** Ready — no blocking correctness, architecture, security, performance, operability, test, or plan-compliance issues found.

---

## What shipped

- **Lifecycle helper:** Registers, heartbeats, derives failed/cancelled/completed terminal observations, and clears its timer in `finally`.
- **Invoke wiring:** Registers immediately after session success with an opaque `none` handle and `cancellationSupported: false`; log setup, streaming, and structured-output validation are lifecycle-owned.
- **Provider ownership:** Retains close-on-session-start failure and uses an outer post-session `finally` for every later path.
- **Tests:** Covers success, error, cancellation, terminal CAS loss, heartbeat throttling/silent liveness/timer cleanup, and the two required pre-stream log faults.

---

## Strengths

- Registration occurs before `prepareLogPath` and `appendSessionStart`, so either failure is durably observed as failed rather than leaving an unregistered provider session.
- The heartbeat timer is independent of provider events and is made inert before clearing, preventing an already-queued callback from updating a terminal invocation.
- Completion, failure, cancellation, and the fallback finalization all use the store's terminal CAS, preserving a concurrent doctor abandonment instead of overwriting it.
- No cancellation adapter, abort signal, PID, or process-lifecycle behavior was introduced; production registrations accurately advertise unsupported cancellation.

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
- [x] Session registration is immediate after successful start/resume and precedes fallible logging.
- [x] Provider close is owned on session-start and all post-session fault paths.
- [x] Terminal CAS behavior preserves an already-abandoned row.

**P1 recommended**
- [x] Independent heartbeat timer remains effective for silent invokes and is cleared on success and error.
- [x] Required pre-stream fault injection and production unsupported-cancellation registration are covered.
- [x] Focused and full tests, typecheck, and lint pass.
