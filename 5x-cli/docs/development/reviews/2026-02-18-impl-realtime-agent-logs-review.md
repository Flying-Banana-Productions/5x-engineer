# Review: Real-time Agent Log Streaming

**Review type:** `5x-cli/docs/development/002-impl-realtime-agent-logs.md` (v1.1)
**Scope:** Claude Code adapter streaming (`stream-json` NDJSON), per-invocation log durability, console formatting/default output policy, `--quiet` plumbing, test updates
**Reviewer:** Staff engineer (reliability, operability, performance, DX)
**Local verification:** Not run (plan + codebase review)

**Implementation plan:** `5x-cli/docs/development/002-impl-realtime-agent-logs.md`
**Technical design:** `5x-cli/docs/development/001-impl-5x-cli.md`

## Summary

This plan fixes a real operability gap: long-running agent steps are currently silent and most invocations discard raw output, making failures hard to debug. Direction is correct: switch Claude Code to `--output-format stream-json` and treat stdout as an NDJSON event stream that is (1) written to disk as it arrives and (2) optionally formatted to the console.

Main gaps are in the “how” details that prevent new failure modes: the adapter must drain stdout concurrently (not after exit), must not allow `logStream`/`onEvent` failures to crash invocations, and must guarantee log streams are flushed/closed across all success/timeout/error paths.

**Readiness:** Ready with corrections — correct approach, but address P0 items before implementation to avoid deadlocks, FD leaks, and hard-to-diagnose partial logs.

---

## Strengths

- **Uses the right substrate:** `stream-json` provides structured intermediate events + a final `type:"result"` envelope, so routing logic and `AgentResult` shape can stay stable.
- **NDJSON log artifacts:** one-event-per-line is tool-friendly (`jq`, grep) and supports incremental writes.
- **Separates concerns:** adapter handles subprocess + parsing; orchestrator owns rendering + CLI UX.
- **Closes the observability hole:** wiring logs for *all* invocation sites (EXECUTE/QUALITY_RETRY/REVIEW/AUTO_FIX and plan-review loop) aligns with the DB-as-SOT + filesystem-artifacts model in `5x-cli/docs/development/001-impl-5x-cli.md`.

---

## Production readiness blockers

### P0.1 — Specify a safe streaming/timeout algorithm (no deadlocks; bounded memory; deterministic completion)

**Risk:** The current adapter waits for `proc.exited` then drains streams. With `stream-json`, correctness requires draining stdout while the process runs; if stdout is not drained concurrently (or console/logging is slow), the agent process can block on a full pipe. Timeout handling can also hang if the stdout reader is still awaiting `reader.read()` after kill.

**Requirement:**
- Start stdout+stderr draining tasks immediately after spawn.
- `invoke()` completion must wait for: process exit OR timeout, and for stdout drain to reach EOF (or be cancelled boundedly on timeout).
- No unbounded accumulation of stdout; only retain what’s necessary (final `result` event + bounded fallback snippet).

**Implementation guidance:**
- Mirror the quality-gates pattern: create `stdoutDone = readNdjson(proc.stdout, { logStream, onEvent })` and `stderrDone = drain(proc.stderr)`; race exit vs timeout; on timeout: SIGTERM->grace->SIGKILL then `await Promise.race([stdoutDone, sleep(DRAIN_TIMEOUT_MS)])` with cancellation.
- Use a streaming `TextDecoder` (stateful) to avoid splitting multi-byte chars across chunks; split on `\n`, trim a trailing `\r`.
- Keep only: `resultEvent` (parsed object) + `rawResultText` (its `result`) + `boundedFallback` for “no result event” scenarios.

---

### P0.2 — Make logging non-fatal and durable (no crashes on log/format errors; flush/close guaranteed)

**Risk:** Adding `logStream` and `onEvent` introduces new ways to fail an invocation (stream errors, formatter exceptions). Also, not awaiting stream flush/close will create “log file exists but empty/partial” failures similar to the previously-seen quality-gate flush regression.

**Requirement:**
- `logStream` write errors MUST NOT fail the agent invocation; they should be captured as warnings and the adapter/orchestrator must proceed.
- Exceptions thrown by `onEvent`/formatter MUST NOT abort the adapter’s stdout reader.
- Every opened log stream MUST be ended and awaited in a `finally` block in the orchestrator.

**Implementation guidance:**
- Wrap `logStream.write(...)` and `opts.onEvent(...)` in try/catch; on error, stop calling them but continue draining/parsing.
- Extract and reuse a single `endStream(stream)` util (as planned) and require `await endStream(stream)` for every invocation site, including failure/timeout branches.
- In escalation messages, always include the log path (even in non-quiet mode) so users can jump straight to artifacts.

---

### P0.3 — Define the default console output policy for non-interactive runs

**Risk:** Flipping from “default quiet” to “default stream formatted agent output” can flood CI logs and slow execution (stdout backpressure), and it changes the CLI’s UX baseline in a way that may surprise existing users/scripts.

**Requirement:** Decide and document a deterministic rule for non-interactive contexts.

**Implementation guidance:**
- Recommended: default `quiet = !process.stdout.isTTY` (TTY prints formatted events; non-TTY defaults quiet), with explicit `--quiet/--no-quiet` override.
- If keeping “always verbose by default,” call it out as a breaking UX change and ensure docs/examples use `--quiet` for CI.

---

## High priority (P1)

### P1.1 — Use an explicit extension for NDJSON agent logs

Prefer `agent-<resultId>.ndjson` (or `.jsonl`) over `.log` to make tooling + expectations obvious; keep quality gate outputs as `.log` (plain text).

### P1.2 — Avoid double JSON parsing for console formatting

Adapter already parses each JSON line to find the final `result` event; consider `onEvent?: (event: unknown, rawLine: string) => void` to avoid parsing again in the formatter.

### P1.3 — Make escalation snippets reflect the right source

In `--quiet` mode, “first ~500 chars of agent output” should be derived from the same surface the user would have seen (assistant text / final result), and should include stderr/error context when available (`AgentResult.error`). Also include the log path.

---

## Medium priority (P2)

- **Formatter hardening:** handle multi-part `content[]` arrays (text + tool_use in one message), unknown event types, and optional suppression rules (e.g., drop `system.init.tools` payloads).
- **Backpressure:** if log writes are heavy, consider respecting `Writable.write()` backpressure (`drain` event) to avoid buffering large amounts in memory.
- **Docs:** update `5x-cli/docs/development/001-impl-5x-cli.md` (or CLI README) to mention `.5x/logs/<runId>/` agent NDJSON logs + `--quiet` behavior.

---

## Readiness checklist

**P0 blockers**
- [ ] Define/implement safe concurrent stdout draining + timeout cancellation semantics (P0.1)
- [ ] Ensure log/formatter errors are non-fatal and log streams are always flushed/closed (P0.2)
- [ ] Decide and document default verbosity behavior for non-TTY contexts (P0.3)

**P1 recommended**
- [ ] Switch agent log extension to `.ndjson`/`.jsonl` (P1.1)
- [ ] Consider passing parsed events to formatter to avoid re-parse (P1.2)
- [ ] Standardize escalation messages: include stderr + log path; snippet only in quiet (P1.3)

---

## Addendum (2026-02-18) — Re-review after plan updates

**Reviewed:** `c1e6eec` (docs) | `5x-cli/docs/development/002-impl-realtime-agent-logs.md` (v1.2)

### What's addressed (✅)

- **P0.1 streaming/timeout algorithm:** plan now calls for concurrent stdout draining from spawn time, bounded retention, and timeout drain cancellation.
- **P0.2 non-fatal + durable logging:** `logStream`/`onEvent` are explicitly try/catch non-fatal; orchestrators required to `await endStream()` in `finally` for all paths.
- **P0.3 non-TTY default:** explicit `quiet = !process.stdout.isTTY` default with `--quiet`/`--no-quiet` override.
- **P1.1 NDJSON extension:** agent logs renamed to `agent-<id>.ndjson` and cross-referenced from `5x-cli/docs/development/001-impl-5x-cli.md`.
- **P1.2 avoid re-parse:** `onEvent(event, rawLine)` signature added in the plan.
- **P1.3 escalation context:** quiet-mode snippet explicitly derived from assistant/final result (plus stderr/error context) and log path is always included.
- **P2 hardening notes:** formatter multi-part handling + unknown types + init-tools suppression; backpressure called out.

### Remaining concerns

- **CLI flag shape (`--no-quiet`):** in most CLI frameworks (incl. `citty`) `--no-quiet` is the negation form of a single `quiet` boolean flag; avoid adding a separate `no-quiet` arg that can conflict with built-in negation semantics. Acceptance: `quiet` boolean supports both `--quiet` and `--no-quiet` without a second option name.
- **Timeout cancellation implementability:** the plan references cancelling via `reader.cancel()` on timeout; make the cancellation mechanism explicit (e.g., `readNdjson(..., { signal })` with `AbortController`, or return `{ done, cancel }`) so it’s straightforward to implement + unit test.

### Updated readiness

- **Implementation readiness:** ✅ — plan is now actionable and covers the key failure modes (deadlocks, log durability, CI noise).
