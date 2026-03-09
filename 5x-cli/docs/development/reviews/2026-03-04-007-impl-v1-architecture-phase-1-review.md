# Review: 007 impl v1 architecture (Phase 1)

**Review type:** commit `48e2d8b` (and follow-ons; none)
**Scope:** `src/providers/*` (types, OpenCode provider, factory) + provider tests
**Reviewer:** Staff engineer
**Local verification:** `bun test test/providers/types.test.ts test/providers/opencode.test.ts` (pass)

## Summary

Phase 1 is largely implemented per plan: a clean `AgentProvider`/`AgentSession` contract, a bundled OpenCode provider supporting managed/external modes, basic SSE->`AgentEvent` mapping, and a plugin-capable factory with forward-compatible config reads. Test coverage is strong and uses the existing v0 mock-client pattern.

**Readiness:** Ready with corrections — one correctness/operability gap in `runStreamed()` timeout/cancellation handling.

## Strengths

- Plan compliance is high: types match the plan, factory supports bundled OpenCode + dynamic plugin import, and forward-compat defaults are implemented.
- Provider implementation is pragmatic: two-phase structured output, recovery polling via `session.messages()`, and best-effort SSE session filtering.
- Test suite is comprehensive for Phase 1 concerns (session lifecycle, structured output, timeout/cancel, streaming events, factory errors).

## Production Readiness Blockers

### P0.1 — `runStreamed()` does not abort server-side session on timeout/cancel

**Risk:** Managed sessions can keep running server-side work after the CLI has timed out/cancelled, causing leaked compute, confusing UX, and inconsistent semantics vs `run()`.

**Requirement:** When `RunOptions.timeout` fires or `RunOptions.signal` aborts during `runStreamed()`, call `client.session.abort({ sessionID })` (best-effort; swallow errors) and emit a terminal `error` event. Add/extend a unit test to assert abort is invoked (mirrors the `run()` timeout test).

## High Priority (P1)

### P1.1 — Avoid hard dependency on `AbortSignal.any` (runtime portability)

`AbortSignal.any()` is not universally available across runtimes/versions. If this CLI is Bun-only it may be OK today, but this becomes a sharp edge for Node execution, older Bun versions, and tests.

Recommendation: implement a small local helper (e.g. `anySignal(signals)`) that falls back to manual fan-in with an `AbortController` when `AbortSignal.any` is missing.

### P1.2 — Make the factory default-provider test deterministic

`test/providers/opencode.test.ts` has a `createProvider()` test that attempts to spawn a real OpenCode server. Even though it try/catches, it can be slow/flaky depending on environment.

Recommendation: avoid spawning external processes in unit/integration tests unless explicitly gated. Options: `test.skip` unless an env var is present, or refactor `createProvider()` to accept an overridable constructor hook for OpenCode in tests.

## Medium Priority (P2)

- `SessionOptions.systemPrompt` / `SessionOptions.timeout` exist but are unused by OpenCode provider; either wire through (if supported by SDK/session), or explicitly document “ignored by provider” behavior.
- `resumeSession()` loses per-session model selection (it uses provider default). If model choice is expected to persist, consider encoding model in session metadata or extending the resume API to accept an override.
- SSE->`AgentEvent` mapping is intentionally minimal; add TODOs/tests for common OpenCode event variants (`message.part.delta`, tool error payload shapes) to reduce future regressions.

## Readiness Checklist

**P0 blockers**
- [x] Abort server-side session in `runStreamed()` on timeout/cancel; add test

**P1 recommended**
- [x] Add `AbortSignal.any` fallback helper
- [x] Remove/gate real OpenCode server spawning from tests

## Addendum (2026-03-04) — Follow-up after `2a18f14`

### What's Addressed

- P0.1 fixed: `runStreamed()` now best-effort calls `client.session.abort({ sessionID })` on timeout/cancel; new tests cover both timeout + external `AbortSignal`.
- P1.1 fixed: introduced `anySignal()` and replaced direct `AbortSignal.any()` usage.
- P1.2 fixed: the `createProvider()` default-provider test is gated behind `TEST_OPENCODE_SERVER`.
- P2.2 addressed: `resumeSession()` supports a model override via new `ResumeOptions` and corresponding tests.

### Remaining Concerns

- Spec/doc drift (new): implementation changed the public provider surface (`SessionOptions` no longer has `systemPrompt`/`timeout`; `resumeSession()` gained an optional options bag) but `docs/v1/100-architecture.md` and parts of `docs/development/007-impl-v1-architecture.md` still describe the original contract.
- This needs an explicit decision: either update `docs/v1/100-architecture.md` (and the plan) to reflect the new API, or restore the removed `SessionOptions` fields to match the published architecture contract (even if OpenCode ignores them for now).

## Addendum (2026-03-04) — Follow-up after `e668ca2`

### What's Addressed

- Spec/doc drift resolved: `docs/v1/100-architecture.md` now matches the implemented provider API (no `SessionOptions.systemPrompt`/`timeout`; `resumeSession(sessionId, opts?)` with `ResumeOptions.model?`).
- Plan sync: `docs/development/007-impl-v1-architecture.md` updated to reflect the same API (including `ResumeOptions`).

### Remaining Concerns

- None for Phase 1 readiness. Note: the main-body P2 bullets about `SessionOptions.systemPrompt`/`timeout` are now obsolete given the chosen API shape; treat them as superseded by the updated architecture docs.
