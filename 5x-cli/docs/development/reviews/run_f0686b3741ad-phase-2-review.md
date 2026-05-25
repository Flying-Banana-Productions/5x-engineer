# Review: Phase 2 — Cursor Agent session and provider lifecycle

**Review type:** `f003d9b7b68699554a4b18d382e949dbf2ce498f`  
**Scope:** Phase 2 only per `docs/development/plans/022-cursor-agent-provider.md` — `CursorAgentSession`, `CursorAgentProvider`, NDJSON reader, subprocess lifecycle (`forceKillSubprocess`, tracking, timeout/cancellation), `runStreamed`/`run`, `close`, and mocked-spawn unit tests  
**Reviewer:** Staff engineer (reliability, provider contract alignment, subprocess lifecycle)  
**Local verification:** `bun test test/unit/providers/cursor-agent/` (83 pass); targeted Phase 2 files `provider.test.ts` + `session.test.ts` (26 pass)

**Implementation plan:** `docs/development/plans/022-cursor-agent-provider.md`  
**Technical design:** N/A

## Summary

Commit `f003d9b` replaces the Phase 1 provider stub with a full `AgentProvider` / `AgentSession` implementation aligned with the Claude Code provider pattern. `CursorAgentProvider` runs `agent create-chat` for real session IDs, tracks subprocesses for idempotent `close()`, and wires session reuse via `resumeSession`. `CursorAgentSession` spawns per-run `stream-json` processes with prompt wrapping, byte guarding, inactivity-based timeouts, abort fan-in, structured output attachment, and canonical event ordering (`usage` before `done`).

Mocked-spawn unit tests cover the Phase 2 checklist including streaming success/failure paths, timeout/cancellation kills, structured output, prompt limits, create-chat failures, and provider close during an active hung run. No production blockers were found within Phase 2 scope; integration wiring remains correctly deferred to Phase 3.

**Readiness:** Ready — Phase 2 completion gate is met and tests pass; remaining notes are optional polish before broad rollout.

---

## What shipped

- **`session.ts`**: `readNdjsonLines`, `forceKillSubprocess`, `CursorAgentSession` with `run`/`runStreamed`, `createCursorChatSessionId`, abort fan-in, inactivity timeout reset, structured output attachment, stderr excerpts on failure.
- **`provider.ts`**: `CursorAgentProvider` implementing `AgentProvider` and `CursorAgentExecutionHost` — `startSession`, `resumeSession`, subprocess tracking, idempotent `close()`.
- **Unit tests**: `session.test.ts` (16 tests) and `provider.test.ts` (10 tests) with mocked `Bun.spawn`.
- **Plan update**: Phase 2 checklist items marked complete in `022-cursor-agent-provider.md`.

---

## Strengths

- **Pattern parity with Claude Code**: NDJSON reader, `anySignal` fallback, SIGTERM→grace→SIGKILL kill path, process tracking, and streaming timeout semantics mirror the proven external-provider structure.
- **Plan alignment (DD2–DD4, DD8)**: Run spawns use `buildRunArgs` with `-p`, `stream-json`, partial output, `--resume`, workspace cwd, env-based secrets, prompt wrap-before-guard for structured output, and mapper-driven `finalAssistantText` extraction.
- **Session lifecycle (DD3)**: Real Cursor chat IDs from `create-chat`; `resumeSession` reuses tracked handles and skips `create-chat` for external IDs; clear install/auth error messages on ENOENT, non-zero exit, and empty stdout.
- **Streaming contract**: Partial events map to `text`; terminal paths emit `usage` then `done`; error paths yield deterministic `AgentEvent.error` without spawning on prompt over-limit.
- **Test coverage**: Includes inactivity timeout and cancellation tests for `runStreamed` (with kill assertions), plus provider `close()` killing a hung subprocess — addressing common gaps in early provider implementations.

---

## Production readiness blockers

None for Phase 2 scope.

---

## High priority (P1)

None for Phase 2 scope. Integration tests, factory resolution, and mock-`agent` PATH harness are correctly tracked in Phase 3.

---

## Medium priority (P2)

- **Unused imports**: `session.ts` imports `AgentCancellationError` and `AgentTimeoutError` but does not use them (Claude Code throws these from `run()`; cursor-agent delegates through generic `Error` from stream error events). Remove dead imports or adopt typed errors in `run()` for parity.
- **`create-chat` argv helper**: `createCursorChatSessionId` hardcodes `["create-chat"]` instead of reusing Phase 1 `buildCreateChatArgs()`. Behavior is correct; consolidating avoids drift if the subcommand shape changes.
- **Post-`done` non-zero exit**: After a terminal `result` yields `done`, a subsequent non-zero process exit still emits an extra `error` event. Unlikely in practice when the mapper accepts the result line, but `invokeStreamed` may treat the invocation as success while logging a trailing error. Consider suppressing the exit-code error when `sawTerminal` is already true, or breaking the stream on first error in invoke.
- **NDJSON chunk boundaries**: Tests use single-chunk stdout streams; a multi-chunk `readNdjsonLines` test would lock UTF-8 split behavior (same optional hardening noted in Claude Code Phase 2 review).

---

## Readiness checklist

**P0 blockers**

- [x] None identified

**P1 recommended**

- [x] N/A for Phase 2 (Phase 3 integration is the next gate)

---

## Addendum (2026-05-24) — Initial review

**Reviewed:** `f003d9b7b68699554a4b18d382e949dbf2ce498f`

### What's addressed (✅)

- **Phase 2.1–2.6**: NDJSON reader, process lifecycle, session creation, streaming/non-streaming runs, and provider close are implemented per the plan.
- **Completion gate**: `CursorAgentSession` and `CursorAgentProvider` implement the provider contract with mocked subprocess coverage (26 Phase 2 tests; 83 total in package).

### Remaining concerns

- Phase 3 (workspace wiring, mock-`agent` integration tests, opt-in live probe) remains open per the plan.
- P2 polish items above are non-blocking follow-ups.

### Updated readiness

- **Phase 2 completion:** ✅ — Session/provider lifecycle and unit tests are in place.
- **Ready for next phase:** ✅ — Proceed to Phase 3 integration and factory resolution.
