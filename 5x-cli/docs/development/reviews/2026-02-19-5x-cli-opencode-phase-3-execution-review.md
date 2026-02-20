# Review: 5x CLI OpenCode Refactor — Phase 3 Execution

**Review type:** `98fd17037d`  \
**Scope:** Phase 3 of `5x-cli/docs/development/003-impl-5x-cli-opencode.md` (OpenCode adapter + SSE log/console streaming + structured output invocation; formatter updates; adapter tests)  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, performance, operability, test strategy)  \
**Local verification:** `bun test` (346 pass, 1 skip)

**Implementation plan:** `5x-cli/docs/development/003-impl-5x-cli-opencode.md` (Phase 3)  \
**Technical design:** `5x-cli/docs/development/001-impl-5x-cli.md` (baseline)

## Summary

This commit lands a real `OpenCodeAdapter` with managed local server lifecycle, per-invocation sessions, structured-output (`json_schema`) prompting, and SSE event streaming into NDJSON logs with optional console formatting. It also updates `sse-formatter.ts` to understand OpenCode event shapes while keeping legacy NDJSON support, and adds substantial adapter/formatter test coverage.

The main staff-level risk is operability/correctness of the SSE stream shutdown + cancellation paths: `writeEventsToLog()` is not actually canceling the SDK subscription, and `InvokeOptions.signal` is currently ignored. As written, real runs can hang in `finally` waiting for the SSE stream to finish, and can leak cross-session events into logs.

**Readiness:** Ready with corrections — Phase 3 is close, but fix P0s before starting Phase 4 (orchestrator refactor depends on reliable invoke/log/cancel behavior).

---

## What shipped

- **OpenCode adapter:** `5x-cli/src/agents/opencode.ts` implements `AgentAdapter` with local server spawn (`createOpencode`), session creation, `session.prompt(format: json_schema)`, timeout/abort handling, and token/cost extraction.
- **SSE → NDJSON log streaming:** `5x-cli/src/agents/opencode.ts` subscribes to `client.event.subscribe()` and writes one JSON event per line to `InvokeOptions.logPath`, with optional console formatting.
- **Console formatter:** `5x-cli/src/utils/sse-formatter.ts` supports OpenCode SSE event shapes (`message.part.delta`, `message.part.updated`, `session.error`) and preserves legacy NDJSON parsing.
- **Tests:** `5x-cli/test/agents/opencode.test.ts` + expanded `5x-cli/test/utils/sse-formatter.test.ts` cover core behaviors (success, timeout, structured-output failures, logging, quiet mode).
- **Public exports:** `5x-cli/src/index.ts` exports `OpenCodeAdapter` and `AgentTimeoutError`.

---

## Strengths

- **Good plan alignment:** matches Phase 3 intent, including the P0.1 “adapter isolation” strategy (factory still throws; adapter tested via direct instantiation).
- **Fail-closed structured output:** explicit `isStructuredOutputError()` handling + invariant validators (`assertAuthorStatus`, `assertReviewerVerdict`) prevent silent advance on malformed responses.
- **Formatter compatibility:** OpenCode shapes added without breaking legacy NDJSON event formatting.
- **Testable seams:** adapter constructor takes a client/server, enabling comprehensive unit tests without spawning a real `opencode` process.

---

## Production readiness blockers

### P0.1 — SSE subscription is not cancellable; invoke can hang in `finally`

**Risk:** `writeEventsToLog()` accepts an `AbortSignal` but does not pass it into the SDK’s `client.event.subscribe(..., options)` signal plumbing. If the SSE stream is idle or long-lived (normal), `eventController.abort()` may not end the `for await` loop promptly (or at all), and `_invoke()` can hang forever awaiting `streamPromise`.

**Requirement:** Aborting an invocation must reliably terminate SSE streaming and allow `_invoke()` to return/throw deterministically.

**Implementation guidance:**
- Pass `abortSignal` into `client.event.subscribe(undefined, { signal: abortSignal })` (or equivalent options object).
- Add a regression test where `event.subscribe()` returns a never-ending stream (or a stream that yields nothing) and ensure `invokeForStatus()` completes.

### P0.2 — `InvokeOptions.signal` is ignored (no external cancellation)

**Risk:** Orchestrators/commands cannot cancel an in-flight invocation (Ctrl-C, gate aborts, parent timeout). This can strand sessions and keep the OpenCode server busy.

**Requirement:** If `opts.signal` is aborted, the adapter must stop streaming, abort the OpenCode session, and throw a clear cancellation error.

**Implementation guidance:**
- Thread `opts.signal` into both the SSE subscription and the prompt request (SDK methods accept `options?: { signal }`).
- Consider `AbortSignal.any([opts.signal, timeoutSignal])` (Node 20+) or a small helper to combine signals.

### P0.3 — Workdir/directory semantics missing for tool execution (worktrees)

**Risk:** `LegacyInvokeOptions` had `workdir`; `InvokeOptions` does not, and the adapter does not set `directory` in `session.create()` / `session.prompt()` / `event.subscribe()`. Once Phase 4 wires this adapter into real runs, tool calls (bash/read/write/git) may execute relative to the wrong directory, especially under git worktree workflows.

**Requirement:** The adapter must run sessions and tools against the intended repo/worktree directory, explicitly and consistently.

**Implementation guidance:**
- Add `workdir` (or `directory`) to `InvokeOptions` (or to `OpenCodeAdapter.create({ directory })` as a base), then pass through to all SDK calls that accept `directory`.

---

## High priority (P1)

### P1.1 — `costUsd` drops valid zero values

`costUsd` uses `info.cost || undefined` in `5x-cli/src/agents/opencode.ts`, which converts `0` to `undefined`. Use nullish coalescing (`info.cost ?? undefined`) to preserve correct accounting.

### P1.2 — Events without a session ID are logged (cross-session leakage/noise)

`writeEventsToLog()` logs events where `getEventSessionId()` returns `undefined`. If the server emits global/system events, they can appear in per-invocation logs and blur boundaries between sessions.

Recommendation: default to `continue` when session ID is absent unless there is a known allowlist of safe global events.

---

## Medium priority (P2)

- **Formatter perf guardrails:** `safeInputSummary()` still calls `JSON.stringify()` on tool inputs; for very large inputs (file contents), this can allocate large transient strings. Consider a bounded summarizer that avoids full serialization for objects with large string fields.
- **Quiet-mode semantics:** warnings in `writeEventsToLog()` use `console.error()` even when `quiet=true`. Decide whether `--quiet` should suppress non-fatal warnings.
- **Plan doc hygiene:** `5x-cli/docs/development/003-impl-5x-cli-opencode.md` was modified in this commit but header “Updated” date/version was not bumped (minor, but keeps audit trail honest).

---

## Readiness checklist

**P0 blockers**
- [ ] Make SSE subscription reliably abortable; add a hanging-stream regression test.
- [ ] Implement `InvokeOptions.signal` cancellation path (prompt + SSE + session.abort).
- [ ] Define and implement directory/workdir propagation for OpenCode sessions/tools (worktree-safe).

**P1 recommended**
- [ ] Preserve `costUsd=0` via `??`.
- [ ] Skip/allowlist events lacking session identity to avoid cross-session log pollution.

---

## Phase alignment / next-phase readiness

**Implementation plan phase(s):** `5x-cli/docs/development/003-impl-5x-cli-opencode.md` Phase 3

- **Phase 3 completion:** ⚠️ — core adapter + tests landed, but SSE shutdown/cancellation and directory semantics need correction before the adapter is safe to wire into orchestrators.
- **Ready for Phase 4:** ⚠️ — proceed after P0 fixes; Phase 4 will amplify these issues (hangs/cwd mistakes become end-to-end failures).

---

## Addendum (2026-02-19) — Phase 3 Execution Review Closure

**Reviewed:** `1716b3d705`

**Local verification:** `bun test` (355 pass, 1 skip)

### What's addressed (✅)

- **P0.1 SSE abortability:** `5x-cli/src/agents/opencode.ts` passes the abort signal into `client.event.subscribe(..., { signal })`; adds regression test proving no hang with an idle/never-ending SSE stream.
- **P0.2 external cancellation:** `InvokeOptions.signal` is threaded via `AbortSignal.any()` into both `session.prompt(..., { signal })` and SSE streaming; timeout vs external cancel distinguished; session aborted on both.
- **P0.3 workdir propagation:** `InvokeOptions.workdir` added in `5x-cli/src/agents/types.ts` and passed as `directory` to `session.create()` and `session.prompt()`; tests cover present/absent behavior.
- **P1.1 cost correctness:** `costUsd` uses `info.cost ?? undefined` so `0` is preserved.
- **P1.2 log isolation:** events without a session ID are skipped, preventing cross-session/global event pollution.
- **P2 operability/perf/paper cuts:** quiet-mode suppresses warning spam; `safeInputSummary()` avoids `JSON.stringify` on large top-level string fields; plan header bumped to v1.2 with explicit correction notes.

### Remaining concerns / further required changes

- None required for Phase 3 scope.
- **Phase 4 reminder:** when wiring the adapter into orchestrators, ensure every invocation sets `workdir` deterministically (especially for git worktree runs) and threads a cancellation `signal` from command-level Ctrl-C handling.

### Updated readiness

- **Phase 3 completion:** ✅ — adapter cancellation/log/workdir semantics are now correct and regression-tested.
- **Ready for Phase 4:** ✅
