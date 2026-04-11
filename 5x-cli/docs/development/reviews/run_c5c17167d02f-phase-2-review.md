# Review: Phase 2 — Claude Code session + provider

**Commit:** `e5e60d05e252884cb2b04c4fafacd64fae5aa100`  
**Scope:** `readNdjsonLines`, `ClaudeCodeSession` (`run` / `runStreamed`, timeouts, cancellation, DD3 session flags), `ClaudeCodeProvider`, plugin `index.ts` (`parseClaudePluginConfig`, default `ProviderPlugin` export), unit tests (`session.test.ts`, `provider.test.ts`), plan checkbox updates for Phase 2  
**Reviewer:** 5x reviewer (subagent)  
**Local verification:** `bun test test/unit/providers/claude-code/` — **59 pass, 0 fail**

## Summary

Phase 2 delivers a coherent `AgentProvider` / `AgentSession` implementation: NDJSON incremental parsing, DD3 `hasRun` / `firstInvocationMode` wiring into `buildCliArgs`, prompt-byte guards, subprocess tracking for `close()`, abort fan-in (`AbortSignal.any` with fallback), and `forceKillSubprocess` (SIGTERM → grace → SIGKILL) on timeout/cancel/close. `run()` uses wall-clock timeout; `runStreamed()` resets an inactivity timer on each parsed line, matching the plan split.

The main gap is **test coverage vs. the written plan**: the Phase 2 checklist marks unit tests complete and lists “Timeout kills process and yields error” under the session section, but **only `run()`’s timeout is asserted**. There are **no** mocked-spawn tests that `runStreamed()` kills the subprocess and yields a timeout (or cancellation) error event—so the completion gate is slightly overstated until those tests exist.

**Readiness:** **Needs follow-up** — implementation quality is strong; add streaming timeout/cancel tests (or explicitly narrow the plan checklist) before treating Phase 2 as fully closed.

## Strengths

- **DD3:** `isResumeFlagForNextRun()` matches the spec: first run uses `--session-id` or `--resume` from `firstInvocationMode`; subsequent runs always `--resume`. Provider tests cover fork-safe resume and same-instance `resumeSession` after `startSession`.
- **NDJSON:** `readNdjsonLines` buffers correctly, uses `TextDecoder` streaming mode, parses line-delimited JSON, skips malformed lines, and handles a final unterminated line.
- **Lifecycle:** `trackProcess` / `untrackProcess`, `close()` idempotency, and hung-subprocess kill are covered by provider tests.
- **Contract alignment:** `run()` throws `AgentTimeoutError` / `AgentCancellationError` on abort paths; `runStreamed()` emits `usage` before `done` for terminal success.
- **Plugin:** Default export matches `ProviderPlugin` (`name`, async `create`); `parseClaudePluginConfig` applies safe defaults (`dangerously-skip`, `claude` binary) and optional fields.

## Production Readiness Blockers

None for code correctness in isolation; the blocker is **documentation vs. tests** (see P1).

## High Priority (P1)

### P1.1 — Streaming timeout / cancellation not covered by unit tests

**Classification:** `auto_fix`

**Observation:** `session.test.ts` exercises wall-clock timeout and pre-aborted `signal` for **`run()`** only. `runStreamed()` has no analogous tests that (1) stall stdout so inactivity timeout fires, or (2) abort via `opts.signal` mid-stream, asserting `kill` invocation and a terminal `error` event.

**Risk:** Regressions in the streaming abort path (listener wiring, `forceKillSubprocess`, or post-loop `cancelSignal` handling) would not be caught by CI.

**Recommendation:** Add two mocked-spawn tests mirroring the `run()` patterns (open-ended `ReadableStream` + delayed `exited`, assert `kill` and error message shape).

## Medium Priority (P2)

### P2.1 — `resumeSession` working directory is `process.cwd()`

**Classification:** `human_required`

**Observation:** `ResumeOptions` in `src/providers/types.ts` only includes `model`. `ClaudeCodeProvider.resumeSession` sets `cwd: process.cwd()`, while `startSession` uses `opts.workingDirectory`. If a resumed session is created in a CLI context whose cwd differs from the original author workspace, tool execution may target the wrong tree.

**Recommendation:** Either document this as an intentional limitation until the core contract can carry a workdir on resume, or extend `ResumeOptions` / invoke wiring in a follow-up (broader than Phase 2).

### P2.2 — `readNdjsonLines` chunk-boundary coverage (optional)

**Classification:** `auto_fix`

**Observation:** Tests use single-chunk streams. UTF-8 split across reads is handled by `TextDecoder` `{ stream: true }`, but a small multi-chunk test would lock that behavior.

## Low Priority / Notes

- **`run()` vs `runStreamed()` error typing:** Non-streaming uses typed errors; streaming yields `{ type: "error", message }`. Consistent with event-based streaming elsewhere; no change required unless a unified typed stream error is adopted repo-wide.
- **`extractRunResultFromStdout`:** Assumes parseable JSON matching mapper expectations for `--output-format json`; aligned with Phase 1 mapper tests.

## Readiness Checklist

**P0 blockers**

- [ ] None for runtime design; P1 is test/plan alignment, not a logic showstopper.

**P1 recommended**

- [ ] P1.1 — Add `runStreamed` timeout + cancellation unit tests (or adjust plan wording if intentionally deferred).

**P2**

- [ ] P2.1 — Decide on resume `cwd` story (`human_required`).
- [ ] P2.2 — Optional NDJSON chunk test.
