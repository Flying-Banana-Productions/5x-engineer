# Review: Invocation Registry — Provider-Neutral Handles, Cancellation Contract, Doctor Hygiene

**Review type:** `docs/development/plans/207-invocation-registry-plan.md`  
**Scope:** Invocation registry schema, store/CAS semantics, `invoke` lifecycle integration, cancellation/status actions, doctor hygiene, and documentation.  
**Reviewer:** Staff engineer (correctness, concurrency, lifecycle reliability, operability)  
**Local verification:** Static review against the plan, plan input, v2 designs, and current `invoke`, control-plane, doctor, schema, and output implementations. Tests not run (plan review).

**Implementation plan:** `docs/development/plans/207-invocation-registry-plan.md`  
**Technical design:** `docs/v2/200-overview.md`, `202-control-plane.md`, `203-recovery-and-doctor.md`, and `207-state-segmentation.md`

## Summary

The plan has a strong provider-neutral boundary: opaque handles, separate request/outcome/terminal fields, CAS-backed store operations, metadata-only doctor repair, and explicit rejection for unsupported production providers all match the v2 constraints and current prompt-store/doctor patterns. Its phases and test matrix are detailed and appropriately isolate the synthetic cancellable adapter from shipped providers.

Three deterministic corrections are needed before implementation. In particular, the proposed lifecycle boundary is placed after fallible post-session work despite the stated guarantee that every successful session start is registered; the cancellation action pseudocode does not implement its own required adapter-throw behavior; and its absent-adapter result contradicts the declared `unsupported` outcome contract.

**Readiness:** Ready with corrections — correct the concrete lifecycle and cancellation semantics below, then the plan is implementable without a design decision.

---

## Strengths

- **Provider neutrality:** The UUID registry and adapter-owned `{ adapter, ref }` handle avoid the obsolete PID/process-group design and are compatible with remote job identifiers.
- **Truthful cancellation model:** Separating request, adapter outcome, and observed terminal state prevents a successful request from being represented as a completed cancellation.
- **Concurrency design:** Store-level CAS and the explicit one-winner/one-adapter-call rule are clear, testable, and mirror established prompt-store conventions.
- **Operational safety:** Heartbeat-based stale detection and metadata-only doctor repair avoid making unsupported claims about provider process cleanup.
- **Scoped integration:** Retaining existing `AgentProvider`/`AgentSession` ownership and leaving production adapters unsupported avoids speculative provider refactors.

---

## Production readiness blockers

None after the required plan corrections below. The issues are plan-level implementation gaps, not a request to change the approved architecture.

---

## High priority (P1)

### P1.1 — Register at the session-success boundary, before later fallible setup

**Risk:** Phase 4 registers only after `prepareLogPath()` and `appendSessionStart()` (plan lines 463–484, 677–700). Either can throw after `startSession`/`resumeSession` succeeds. That leaves an unregistered provider session and also bypasses the proposed `finally` that closes the provider, contradicting the stated “every invocation that reaches session start” registry guarantee.

**Requirement:** Place registration/lifecycle ownership immediately after successful session creation, or explicitly wrap every post-session operation through provider close and terminalization. Ensure failures preparing the log/session metadata mark the invocation failed and close the provider. Add a fault-injection test for each pre-stream failure path.

**Action:** `auto_fix`

### P1.2 — Make adapter exceptions follow the documented failed-outcome path

**Risk:** The Phase 5 pseudocode directly awaits `adapter.cancel()` (lines 785–789), so a thrown adapter error escapes without `recordCancellationOutcome`. This conflicts with the normative requirement at line 804 and loses the outcome the registry is intended to preserve.

**Requirement:** Wrap adapter lookup/cancel in `try/catch`, persist `failed` on an exception, and return the documented successful request response with a failed outcome. Add an action test for a throwing adapter, not only an adapter returning `{ outcome: "failed" }`.

**Action:** `auto_fix`

### P1.3 — Reconcile missing-adapter outcome with the declared contract

**Risk:** The design decision at line 124 says a supported row with no registered adapter records `cancellation_outcome = "unsupported"`; the Phase 5 implementation sketch instead writes `"failed"` (line 778). This makes client-visible cancellation semantics depend on which section an implementer follows and leaves the `unsupported` outcome untested.

**Requirement:** Choose the already-declared missing-adapter behavior (`unsupported`), update the action pseudocode and expected view, and add the corresponding unit test. Retain `failed` for an adapter that is found but returns/throws failure.

**Action:** `auto_fix`

---

## Medium priority (P2)

- **Combined `status --id --run` semantics:** Define and test that supplying both fields intersects them (or returns a deterministic mismatch/not-found error), rather than returning an ID outside the requested run. This prevents ambiguous filtering as the dashboard consumer arrives. (`action: auto_fix`)
- **Status envelope naming:** The plan calls the TypeScript field `clientState` but the integration expectation says `client_state` (line 874). State the actual JSON envelope convention and make the test expectation match it. (`action: auto_fix`)

---

## Readiness checklist

**P0 blockers**
- [x] Opaque-handle, no-PID, unsupported-provider, and metadata-only-doctor constraints are consistent with the v2 design and plan input.

**P1 required corrections**
- [ ] Register/finalize and close provider on all failures after session creation (`auto_fix`)
- [ ] Persist a failed cancellation outcome when `adapter.cancel()` throws (`auto_fix`)
- [ ] Use and test the declared `unsupported` outcome for a missing supported adapter (`auto_fix`)
- [ ] Define combined status filter and output field semantics (`auto_fix`)

---

## Addendum — August 28, 2026

The plan and referenced/current implementation were re-reviewed. The original
corrections remain applicable because the plan still contains the cited
lifecycle and cancellation pseudocode. One additional deterministic lifecycle
correction is required.

### Active corrections

1. **Register immediately after session creation and protect all subsequent
   fallible setup with lifecycle finalization and provider close.**
   `prepareLogPath()` and `appendSessionStart()` currently occur after a
   successful `startSession()` / `resumeSession()` and before the proposed
   wrapper. A failure there otherwise leaves an unregistered session and skips
   normal close. Add pre-stream fault-injection coverage.
   - **Action:** `auto_fix`

2. **Catch a thrown `adapter.cancel()` and persist `failed` before returning
   the documented response.** The Phase 5 sketch currently lets this exception
   escape, contrary to its normative behavior. Test an adapter that throws.
   - **Action:** `auto_fix`

3. **Use the specified `unsupported` outcome when a supported row has no
   registered adapter.** Phase 5 currently writes `failed`, contradicting the
   plan's own decision at line 124. Retain `failed` for an adapter that exists
   but returns or throws a failure, and test both cases.
   - **Action:** `auto_fix`

4. **Define combined `status --id --run` behavior and the JSON field naming.**
   Require an ID queried with a run to match that run (or return deterministic
   not-found/mismatch), and reconcile the TypeScript `clientState` property
   with the integration test's `client_state` expectation.
   - **Action:** `auto_fix`

5. **Heartbeat independently of streamed events for the lifetime of a running
   invocation.** Phase 4 only invokes `heartbeat()` when `runStreamed()` emits
   an event. A live provider that is silent for more than the 15-minute stale
   TTL is therefore falsely reported stale and can be metadata-abandoned,
   contradicting the plan's claim that a live long invocation stays fresh.
   Start a rate-limited interval/timer after registration and clear it in the
   lifecycle `finally` (event heartbeats may remain an optimization). Add a
   fake-clock/timer test proving a silent invocation remains fresh past the
   stale threshold and that the timer is cleared on completion/error.
   - **Action:** `auto_fix`

### Addendum readiness

**Ready with corrections.** All five changes are deterministic from the stated
contract, existing invocation flow, and doctor TTL; no policy decision is
needed.

---

## Addendum — Revision 1.1 reassessment (August 28, 2026)

### Prior findings

All five previously active corrections are **addressed** in plan revision 1.1:

1. **Session-boundary registration:** addressed. Registration now occurs before
   `prepareLogPath()` / `appendSessionStart()`, both calls are inside the
   lifecycle callback, provider close is owned by the outer `finally`, and
   separate wiring fault-injection tests are required.
2. **Thrown adapter cancellation:** addressed. The action catches a thrown
   `adapter.cancel()`, persists `failed`, returns the documented result, and
   requires distinct coverage.
3. **Missing adapter outcome:** addressed. A missing adapter for a supported
   row now records `unsupported`, while returned or thrown adapter failures
   record `failed`.
4. **Combined status filtering and output naming:** addressed. `--id` plus
   `--run` is an intersection with a deterministic not-found result, and the
   snake_case CLI/HTTP mapper is specified and tested separately from the
   camelCase in-process view.
5. **Silent-invocation heartbeat:** addressed. The lifecycle owns an
   independent, cleared heartbeat interval and includes fake-clock tests for
   liveness and timer cleanup.

### New active correction

1. **Make doctor abandonment CAS against the observed liveness predicate.**
   Phase 6 says fix re-validates a stale/orphaned row and then calls
   `markAbandoned(id, "stale-metadata")`, but the specified store method only
   CASes `status = 'running'`. A heartbeat can update `updated_at` (or a run can
   be reopened) between the revalidation read and that update; doctor would
   then abandon a live invocation despite the new heartbeat interval. Extend
   the store operation to atomically require the observed stale timestamp/run
   predicate (for example, an `expectedUpdatedAt` CAS plus an atomic current
   run-state check, or a dedicated `markAbandonedIfStale` operation) in both
   SQLite and memory implementations. Add a two-writer test in which a
   heartbeat lands after detection/revalidation but before the fix mutation and
   prove `--fix` does not abandon the row; cover a reopened run similarly.
   - **Action:** `auto_fix`

### Addendum readiness

**Ready with corrections.** The revision resolves every prior finding. The
remaining doctor/heartbeat TOCTOU fix is deterministic and requires no policy
choice.
