# Review: 007 Session Continuation (Phase 1)

**Review type:** commit `fde358e` + `docs/development/007-impl-session-continuation.md`
**Scope:** Phase 1 (types + plumbing): `EscalationEvent.sessionId`, `EscalationResponse.continue_session`, `InvokeOptions.sessionId`, and propagating `InvokeStatus.sessionId` onto author escalations
**Reviewer:** Staff engineer
**Local verification:** `bun run typecheck` (pass), `bun run test` (592 pass)

## Summary

Phase-1 wiring is small, low-risk, and consistent with existing patterns; typecheck/tests pass. One plan-compliance gap: the plan marks P1.3 complete but the “failed continuation suppresses repeat c” behavior is not implementable/implemented yet (needs Phase 2 state to exist), so either the checkboxing should be adjusted or the plan should explicitly defer that sub-requirement.

**Readiness:** Ready with corrections — implementation is sound; a few mechanical follow-ups to keep the plan/phase boundaries crisp and avoid future footguns.

## Strengths

- Minimal surface-area change; adds `sessionId` as optional and only plumbs it on success-path author escalations.
- Keeps error/invariant-violation escalations free of potentially-invalid session metadata.
- Doesn’t change runtime behavior yet (no new gate option implemented in this commit), so low regression risk.
- CI-like signals are green locally (`typecheck`, full test suite).

## Production Readiness Blockers

(None for Phase 1.)

## High Priority (P1)

### P1.1 — Plan compliance: P1.3 marked complete but missing “failed continuation suppresses repeat c” logic

P1.3 in `docs/development/007-impl-session-continuation.md` includes a requirement to omit `sessionId` after a failed continuation attempt (to prevent a loop of retrying a broken session). Commit `fde358e` correctly captures `sessionId` for author `needs_human`/`failed` escalations, but there is no `continueSessionId` concept yet, so the “failed continuation” suppression cannot exist.

Recommendation: either (a) adjust the plan’s P1.3 checkboxing to reflect what’s actually delivered in Phase 1, or (b) move the “failed continuation suppression” acceptance criteria into Phase 2 where the state exists.

### P1.2 — Confirm `sessionId` exposure expectations (logs / run events)

`EscalationEvent.sessionId` will be persisted via run events (and potentially surfaced by future UIs). If OpenCode session IDs are considered sensitive (attach capability, cross-user correlation, etc.), add explicit redaction or ensure they’re only shown when necessary.

## Medium Priority (P2)

- `EscalationResponse` now includes `continue_session` but no gate/state-machine implementation exists yet; ensure Phase 2 implements parsing + routing atomically so we don’t end up with a gate returning an action the orchestrator can’t handle.

## Readiness Checklist

**P0 blockers**
- [ ] None

**P1 recommended**
- [ ] Align Phase 1 completion markers vs actual delivered scope (`docs/development/007-impl-session-continuation.md`)
- [ ] Decide whether/where `sessionId` should be redacted or hidden in gate output/log views
