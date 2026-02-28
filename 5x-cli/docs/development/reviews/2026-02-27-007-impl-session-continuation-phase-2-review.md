# Review: 007 Session Continuation (Phase 2)

**Review type:** commit `dfdaa0f` + `docs/development/007-impl-session-continuation.md`
**Scope:** Phase 2 (gate + adapter + state machine): headless/TUI escalation `continue-session`, adapter session reuse via `InvokeOptions.sessionId`, orchestrator routing + continuation prompt
**Reviewer:** Staff engineer
**Local verification:** `bun run typecheck` (pass), `bun test` (592 pass)

## Summary

Core wiring matches the plan: eligibility-gated `continue-session` option, adapter-level session reuse, and state-machine routing that re-enters the author state with a minimal continuation prompt. Two correctness/plan-compliance gaps keep this from being “done”: (1) `sessionId` is currently suppressed on *any* escalation after a continuation attempt (including `needs_human`), which blocks multi-turn continuation; (2) the headless gate treats ineligible `c` as abort instead of invalid/re-prompt.

**Readiness:** Ready with corrections — implementation is close; fix the continuation suppression semantics and headless input handling, then proceed to Phase 3 tests.

## Strengths

- Fits existing architecture: no DB coupling, in-memory `sessionId` plumbing, and reuse of existing adapter/session APIs.
- TUI gate UX is improved: eligibility-aware toast copy + clearer invalid-input messaging.
- Adapter reuse is clean: `onSessionCreated` still fires (keeps TUI attach working) and tracing distinguishes create vs continue.
- State-machine integration is straightforward: `continue_session` routes via existing `retryState ?? preEscalateState` logic.

## Production Readiness Blockers

(None for Phase 2 specifically, assuming the corrections below are applied before relying on the feature.)

## High Priority (P1)

### P1.1 — Continuation suppression is too aggressive (breaks multi-turn continuation)

After a `continue_session` invocation, escalations with `needs_human` currently omit `sessionId` (e.g. `executeEscalationSessionId` / `qrEscalationSessionId` / `afEscalationSessionId` are forced to `undefined` whenever `*ContinueSessionId` is set). This prevents choosing `continue-session` again even when the session is healthy and simply needs another human response.

Recommendation: only suppress `sessionId` when the continuation attempt itself is known-bad (e.g. prompt throws, or the agent returns `failed` in a way that indicates the session cannot be continued). Do not suppress on `needs_human` after continuation; that’s a primary use-case for continuing.

## Medium Priority (P2)

- Headless gate plan compliance: in `src/gates/human.ts`, entering `c` when `event.sessionId` is absent aborts immediately; spec calls for invalid + re-prompt.
- Tests are missing for the new behavior (planned Phase 3): add coverage for `continue_session` parsing/eligibility in TUI/headless gates, and for state-machine routing + `InvokeOptions.sessionId` propagation (including the “suppress only on failed continuation” rule).
- Defensive invariant: in `src/orchestrator/phase-execution-loop.ts`, handle `continue_session` when `lastEscalation.sessionId` is absent (custom gate or future refactor) with a clear fallback (treat as `continue` or re-escalate with guidance).
- Maintainability: continuation prompt assembly is duplicated across EXECUTE / QUALITY_RETRY / AUTO_FIX; consider extracting a small helper to keep semantics consistent.

## Readiness Checklist

**P0 blockers**
- [ ] None

**P1 recommended**
- [ ] Allow repeated `continue-session` across multiple `needs_human` escalations (only suppress on truly failed continuation)
- [ ] Headless gate: treat ineligible `c` as invalid and re-prompt (don’t silently abort)
- [ ] Add Phase 3 tests for gates + orchestrator + adapter continuation paths

## Addendum (2026-02-28) — Follow-up Review for commit `8cdfa11`

### What's Addressed

- P1.1 fixed: sessionId suppression now triggers only when a continuation attempt returns `failed`; `needs_human` after continuation preserves `sessionId` (multi-turn continuation).
- Headless gate plan compliance: ineligible `c` re-prompts instead of aborting; unknown input re-prompts with a clear hint.
- Defensive invariant implemented: `continue_session` with missing `sessionId` traces and falls back to fresh-session semantics.
- Maintainability improved: continuation prompt assembly extracted to `buildContinuationPrompt()` and reused across EXECUTE / QUALITY_RETRY / AUTO_FIX.
- Phase 3 tests added: TUI parsing/eligibility/toast coverage + orchestrator routing/propagation/suppression/multi-turn coverage.

### Remaining Concerns

- Adapter test gap: there is still no direct unit test proving `OpenCodeAdapter` skips `session.create()` when `InvokeOptions.sessionId` is provided (and that `onSessionCreated` is fired with the existing ID). Orchestrator tests use a mock adapter, so this path can regress silently.
- Headless gate behavior remains effectively untested (acknowledged in `test/gates/human.test.ts`); acceptable if we’re explicitly relying on TUI + orchestrator integration for coverage, but it’s still a risk surface.

Updated readiness: Ready with corrections — core behavior matches the plan and prior review items are addressed; add adapter continuation tests to close Phase 3 plan coverage.
