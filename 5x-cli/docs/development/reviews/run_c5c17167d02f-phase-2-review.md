# Review: Phase 2 — Claude Code session + provider

**Commit:** `e5e60d05e252884cb2b04c4fafacd64fae5aa100`  
**Scope:** `readNdjsonLines`, `ClaudeCodeSession` (`run` / `runStreamed`, timeouts, cancellation, DD3 session flags), `ClaudeCodeProvider`, plugin `index.ts` (`parseClaudePluginConfig`, default `ProviderPlugin` export), unit tests (`session.test.ts`, `provider.test.ts`), plan checkbox updates for Phase 2  
**Reviewer:** 5x reviewer (subagent)  
**Local verification:** `bun test test/unit/providers/claude-code/` — **59 pass, 0 fail**

## Summary

Phase 2 delivers a coherent `AgentProvider` / `AgentSession` implementation: NDJSON incremental parsing, DD3 `hasRun` / `firstInvocationMode` wiring into `buildCliArgs`, prompt-byte guards, subprocess tracking for `close()`, abort fan-in (`AbortSignal.any` with fallback), and `forceKillSubprocess` (SIGTERM → grace → SIGKILL) on timeout/cancel/close. `run()` uses wall-clock timeout; `runStreamed()` resets an inactivity timer on each parsed line, matching the plan split.

The main gap is **test coverage vs. the written plan**: the Phase 2 checklist marks unit tests complete and lists “Timeout kills process and yields error” under the session section, but **only `run()`’s timeout is asserted**. There are **no** mocked-spawn tests that `runStreamed()` kills the subprocess and yields a timeout (or cancellation) error event—so the completion gate is slightly overstated until those tests exist.

**Readiness (original review):** **Needs follow-up** for P1.1/P2.1 — superseded for those items by Addendum commit `a4edbacc46538acf904519aea80302113c91e2cd`.

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

- [x] P1.1 — Add `runStreamed` timeout + cancellation unit tests — **done** in `a4edbacc46538acf904519aea80302113c91e2cd` (see Addendum).

**P2**

- [x] P2.1 — Resume `cwd` — **done** via `ResumeOptions.workingDirectory` + invoke wiring in `a4edbacc46538acf904519aea80302113c91e2cd` (see Addendum).
- [ ] P2.2 — Optional NDJSON chunk test.

---

## Addendum — `a4edbacc46538acf904519aea80302113c91e2cd`

**Commit:** `a4edbacc46538acf904519aea80302113c91e2cd`  
**Scope:** P1.1 `runStreamed` timeout/cancel mocked-spawn tests; P2.1 `ResumeOptions.workingDirectory`, `ClaudeCodeProvider.resumeSession` cwd, `invoke.handler` passes `workdir` on resume.  
**Reviewer:** 5x reviewer (subagent)  
**Local verification:** `bun test test/unit/providers/claude-code/` — **63 pass, 0 fail**

### Verification

**P1.1 — `runStreamed` timeout / cancel (mocked `Bun.spawn`)**

- **`session.test.ts`:** `runStreamed inactivity timeout yields error and kills subprocess` — stalls stdout with an open-ended `ReadableStream`, `timeout: 0.1`, asserts `kill` count ≥ 1 and an `error` event containing `Agent timed out after 100ms`.
- **`session.test.ts`:** `runStreamed cancellation yields error event and kills subprocess` — `AbortSignal.abort()`, asserts `kill` ≥ 1 and `Agent invocation cancelled` in error messages.

These match the prior recommendation (mirroring `run()` patterns with kill + terminal error shape).

**P2.1 — `ResumeOptions.workingDirectory` + invoke wiring**

- **`src/providers/types.ts`:** `ResumeOptions` documents optional `workingDirectory` for workspace-aligned tool execution.
- **`packages/provider-claude-code/src/provider.ts`:** New resume handle uses `cwd = opts?.workingDirectory ?? process.cwd()` for `ClaudeCodeSessionOptions`.
- **`src/commands/invoke.handler.ts`:** `provider.resumeSession(..., { model: params.model, workingDirectory: workdir })` so resume uses the same resolved `workdir` as `startSession` (explicit `--workdir`, mapped worktree, or `projectRoot`).

**`provider.test.ts`:** Asserts spawn `cwd` for `startSession` on both `run` and `runStreamed`, and `resumeSession` with `workingDirectory: "/tmp/resume-cwd"` for `run`.

### Outcome

P1.1 and P2.1 from this phase-2 review are **addressed** by the commit. Remaining optional follow-up: **P2.2** (multi-chunk `readNdjsonLines` test). Phase 2 readiness relative to the original P1/P2.1 gaps is **improved**; treat the plan checklist as aligned with the new tests once merged.
