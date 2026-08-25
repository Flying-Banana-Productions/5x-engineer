# Review: Prompt Queue Foundation — Phase 4 CLI lifecycle

**Review type:** `96fc0cfe24b00c8985dcc6ea031f3b614d68ac32`  
**Scope:** Phase 4 CLI SIGINT/SIGTERM ownership and DB/lock cleanup lifecycle.  
**Reviewer:** Staff engineer (correctness, reliability, operability, security)  
**Local verification:** `bun run lint && bun run test` — passed (2,751 tests); focused lifecycle, DB, and lock tests — passed (31 tests).

**Implementation plan:** `docs/development/plans/205-prompt-queue-foundation-plan.md`  
**Technical design:** N/A

## Summary

The implementation adds a process-wide lifecycle that records the first SIGINT or SIGTERM, aborts in-flight work without prematurely exiting, and force-exits only on a second signal or expiry of the grace period. It installs the lifecycle before command parsing, disarms the grace timer after parsing unwinds, and removes DB and lock signal handlers that previously preempted command-level durable cleanup. The implementation meets the Phase 4 acceptance criteria and preserves exit-time, idempotent resource cleanup.

**Readiness:** Ready — lifecycle ownership, grace handling, cleanup behavior, and the specified unit coverage are in place.

---

## What shipped

- **CLI lifecycle:** Added idempotent SIGINT/SIGTERM ownership with an abort signal, recorded cause, grace timer, and force-exit safeguards.
- **CLI entrypoint:** Installs lifecycle handling before `parseAsync` and disarms it after command completion.
- **DB and locks:** Removed signal-time exits so command handlers retain access to SQLite and locks are released on actual process exit.
- **Tests:** Added isolated lifecycle tests and DB/lock regression coverage.

---

## Strengths

- Lifecycle state is isolated behind a small, testable module with a host seam that avoids unsafe process-global test mutation.
- First-signal behavior correctly aborts without calling `process.exit`, enabling the planned prompt abandonment work to run while SQLite remains available.
- Grace-timer, repeated-signal, disarm, and listener-idempotence paths are explicitly covered.
- DB close and lock release remain idempotent exit-time operations, matching the required cleanup ordering constraints.

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

## Readiness checklist

**P0 blockers**
- [x] CLI lifecycle owns first SIGINT/SIGTERM without preemptive exit.
- [x] DB and lock helpers no longer exit on signals.

**P1 recommended**
- [x] Grace timeout, repeat signal, disarm, and idempotent installation are covered.
- [x] Full lint and concurrent test suite pass.
