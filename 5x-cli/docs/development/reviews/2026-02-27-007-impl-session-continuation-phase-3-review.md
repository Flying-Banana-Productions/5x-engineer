# Review: 007 Session Continuation (Phase 3)

**Review type:** commit `dedda65` (+ follow-on `ed7eca3` doc-only) and `docs/development/007-impl-session-continuation.md`
**Scope:** Phase 3 tests + final correctness/plan-compliance pass for session continuation at escalation gate (headless + TUI), orchestrator continuation routing, and OpenCode adapter session reuse
**Reviewer:** Staff engineer
**Local verification:** `bun run typecheck` (pass), `bun test` (634 pass)

## Summary

Implementation largely matches the plan and closes the Phase 3 test surface: continuation is eligibility-gated, orchestrator routes `continue_session` back into the right author state with a minimal continuation prompt, and adapter continuation is directly unit-tested (skips `session.create()`, preserves `onSessionCreated`, propagates sessionId through both prompts, returns `result.sessionId`).

One correctness/UX edge case remains in TUI parsing: when continuation is ineligible, user input `continue-session` is currently interpreted as `continue` with guidance (via the `continue:` guidance regex). This can silently start a fresh session when the user intended to resume, and it creates surprising guidance text.

**Readiness:** Ready with corrections -- small, mechanical parsing fix + test update.

## Strengths

- Plan compliance: P3.1-P3.3 coverage is implemented (TUI gate, orchestrator continuation routing/suppression semantics, adapter continuation behavior).
- Correct suppression semantics: sessionId is only suppressed after a *failed* continuation attempt, preserving multi-turn `needs_human` continuation.
- Operability: defensive trace hook for `continue_session` with missing sessionId avoids brittle assumptions and keeps fallback behavior explicit.

## Production Readiness Blockers

(None.)

## High Priority (P1)

### P1.1 -- TUI parsing treats ineligible `continue-session` as `continue` + guidance

**Risk:** User intends "resume session" but silently triggers "start fresh", with accidental guidance injected (e.g. `continue-session` -> guidance `session`). This is confusing and can change run outcomes.

**Requirement:** When `canContinueSession` is false, `parseEscalationDecision()` must treat both `c` *and* `continue-session` (with or without `: guidance`) as invalid (return null), so the TUI gate emits the invalid-input toast and waits for a valid option.

## Medium Priority (P2)

- Security posture check: `EscalationEvent.sessionId` is persisted in run events/results and trace hooks. If session IDs are treated as capability-like tokens in any environment (shared machines, artifact uploads), consider redaction/guardrails or documenting the assumption that local sessions are non-sensitive. (action: human_required)

## Readiness Checklist

**P0 blockers**
- [ ] None

**P1 recommended**
- [ ] TUI: reject `continue-session` text when ineligible (treat as invalid, do not fall through to `continue:` guidance parsing)

## Addendum (2026-02-27) — P1.1 Follow-on Fix Review (commit `35e2774`)

### What's Addressed

- P1.1 resolved: `parseEscalationDecision()` now rejects `c` / `continue-session` (and guidance variants) when `canContinueSession` is false/absent, preventing accidental fallthrough to `continue` + guidance.
- Tests updated to assert null-return behavior for `continue-session`, `continue-session: ...`, and `c: ...` when ineligible.
- Local verification: `bun test` (636 pass).

### Remaining Concerns

- P2 security posture note still applies: `sessionId` appears in events/results and trace hooks; if IDs are sensitive in any environment, add redaction/guardrails or document assumptions.

With P1.1 addressed, Phase 3 looks complete and is ready to advance.
