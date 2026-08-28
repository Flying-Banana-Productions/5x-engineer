# Review: Invocation Registry — Phase 5 Cancel/Status Action, CLI, and Dashboard Seam

**Review type:** `a157975a092c82b074f8b4ea7ea45bb58e33d3a3` (and subsequent commits: none)  
**Scope:** Phase 5 cancellation action, status/cancel commands, explicit identity handling, JSON envelopes, dashboard seam, and specified tests.  
**Reviewer:** Staff engineer (correctness, architecture, security, performance, operability, tests, and plan compliance)  
**Local verification:** Focused Phase 5 tests — 26 passed; `bun run typecheck` — passed; `bun run lint` — passed. `bun test` exceeded the 120-second review timeout without reporting a test failure.

**Implementation plan:** `docs/development/plans/207-invocation-registry-plan.md`  
**Technical design:** N/A

## Summary

Phase 5 meets its action and CLI contract. Cancellation validates the actor, uses the store CAS as the exactly-once adapter-call gate, records truthful adapter outcomes, and rejects unsupported running invocations without a request mutation, adapter call, stream abort, or run-status mutation. Status requires explicit identifiers, intersects combined id/run requests without exposing foreign rows, and maps all CLI output through snake_case envelopes. The dashboard is absent, and the documented in-process seam and HTTP contract meet the conditional requirement.

**Readiness:** Ready — no blocking correctness, architecture, security, performance, operability, test, or plan-compliance issues found.

---

## What shipped

- **Cancellation action:** Runtime actor validation; unsupported no-side-effect rejection; CAS-winner-only adapter invocation; idempotent repeat and terminal behavior; missing, failed, and thrown adapter outcomes are recorded without escaping.
- **Explicit worker commands:** `5x invoke status --id/--run` and `5x invoke cancel <id>` resolve a single injected database context and use no ambient run lookup.
- **Safe presentation:** Status and cancel responses use `toInvocationStatusEnvelope`, keeping CLI data snake_case and omitting opaque handles.
- **Dashboard seam:** Exports consumer actions and documents the conditional authenticated HTTP routes without introducing a dashboard server.
- **Tests:** Unit coverage includes actor validation, supported/unsupported cancellation outcomes and exactly-once behavior; handler coverage includes no-ambient behavior and id/run intersection; integration coverage verifies CLI envelopes and unchanged active run status.

---

## Strengths

- The cancellation request CAS precedes adapter lookup/call, so concurrent callers cannot issue multiple adapter cancellations.
- Unsupported cancellation returns a truthful error before mutating invocation request state; neither handler nor action touches `runs.status`.
- The combined id/run path rejects a missing or foreign invocation before serializing it, avoiding cross-run data disclosure.
- Runtime actor validation preserves the control-plane authorization boundary even when TypeScript callers bypass static typing.
- The absent-dashboard path follows the plan rather than adding unauthenticated HTTP surface area.

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
- [x] Supported adapters are invoked exactly once through the request CAS; repeat and terminal requests are no-ops.
- [x] Unsupported running rows leave invocation request fields and run status unchanged.
- [x] Status uses explicit id/run inputs only; combined inputs intersect and do not reveal foreign rows.
- [x] Actor validation, snake_case CLI envelopes, and opaque-handle exclusion are enforced.

**P1 recommended**
- [x] Dashboard-absent seam is documented with token-owned authentication responsibility.
- [x] Focused tests, typecheck, and lint pass; full suite showed no failure before the review timeout.
