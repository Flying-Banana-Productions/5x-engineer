# Review: Real-time Agent Logs Phase 1 Execution

**Review type:** `6413a6fcbe..394b210`  \
**Scope:** 002 Phase 1 execution: ClaudeCodeAdapter switch to `--output-format stream-json` NDJSON streaming + `InvokeOptions` hooks (`logStream`, `onEvent`); follow-on test/runtime changes  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, performance, operability, test strategy)  \
**Local verification:** `cd 5x-cli && bun test` PASS (302 pass, 1 skip)

**Implementation plan:** `docs/development/002-impl-realtime-agent-logs.md`  \
**Technical design:** `docs/development/001-impl-5x-cli.md`

## Summary

Phase 1 lands the adapter-side foundation for real-time agent logs: Claude Code now emits NDJSON (`stream-json`) and the adapter drains stdout/stderr concurrently, tees raw NDJSON to an optional log stream, surfaces parsed events via an optional callback, and extracts the final `type:"result"` event into `AgentResult`.

Main remaining risks are around failure modes at scale: a single huge NDJSON line can force unbounded buffering, and WritableStream failures are not reliably non-fatal unless `'error'` events/backpressure are handled.

**Readiness:** Ready with corrections - OK to proceed to Phase 2 wiring, but address P0 items (line-length + stream error handling) before treating streamed logs as reliable artifacts.

---

## What shipped

- **Adapter streaming + timeout semantics:** concurrent drain, abort-bounded timeout path, parse final result event (`5x-cli/src/agents/claude-code.ts`).
- **Invocation hooks:** `InvokeOptions.logStream` and `InvokeOptions.onEvent(event, rawLine)` (`5x-cli/src/agents/types.ts`).
- **Tests updated for NDJSON + deterministic timeout tests:** broad unit coverage; removed wall-clock dependencies (`5x-cli/test/agents/claude-code.test.ts`).
- **Test harness ergonomics:** concurrent test runner, dots reporter, global console suppression preload (`5x-cli/package.json`, `5x-cli/bunfig.toml`, `5x-cli/test/setup.ts`).

---

## Strengths

- **Correct streaming shape:** starts stdout/stderr drains immediately after spawn; avoids pipe backpressure deadlocks.
- **Bounded steady-state memory:** does not accumulate full stdout; retains only result event + bounded fallback.
- **Non-fatal callback surface:** formatter/log writer failures do not abort the invocation (best-effort observability).
- **Deterministic tests:** timeout path is exercised without real timers; reduces flake and runtime.

---

## Production readiness blockers

### P0.1 - Bound per-line buffering (avoid OOM on single huge NDJSON lines)

**Risk:** `readNdjson` buffers until it sees `\n`. A single very large event line (e.g., tool_result content) can force unbounded `buffer` growth, defeating streaming and risking OOM.

**Requirement:** enforce a maximum in-flight line size (or streaming-safe parsing) so memory remains bounded even when a newline is delayed.

**Implementation guidance:** in `readNdjson` (`5x-cli/src/agents/claude-code.ts`), cap `buffer.length` (bytes) and on overflow: (1) stop parsing, (2) continue teeing raw bytes to `logStream` if possible, (3) degrade `onEvent` to disabled, (4) retain boundedFallback only.

### P0.2 - Make logStream failures truly non-fatal (handle async stream errors)

**Risk:** file streams usually fail via `'error'` events (async), not synchronous throws. Current try/catch around `logStream.write()` will not catch disk-full/permission errors, and an unhandled `'error'` event can crash the process.

**Requirement:** log streaming must not crash the CLI; failures must be captured and surfaced (warning + continue invocation).

**Implementation guidance:** in Phase 2, when creating the write stream, attach an `'error'` handler and flip a shared "log stream failed" state so the adapter stops writing. Optionally, accept a small adapter-side wrapper (writer fn) instead of a raw `WritableStream`.

---

## High priority (P1)

### P1.1 - Respect logStream backpressure (avoid buffered write amplification)

`logStream.write()` return value is ignored; under slow disk/IO contention, buffering can grow. Recommendation: either accept this as v1 and measure, or gate on `'drain'` when `write()` returns false.

### P1.2 - Bound stderr memory

`drainStream(proc.stderr)` buffers stderr into a single string; if stderr can be large, this can spike memory. Recommendation: cap stderr capture (head/tail) or stream stderr to a separate log file.

### P1.3 - Security posture of verbose NDJSON

`--verbose` NDJSON will include tool inputs/results that may contain secrets. Recommendation (Phase 2): ensure log dir permissions are least-surprise, and document "logs may contain sensitive data" in CLI UX/docs.

### P1.4 - Test concurrency + global console patching

`bun test --concurrent` plus global `console.*` monkey-patching (`5x-cli/test/setup.ts`) can introduce order-dependent failures when tests temporarily override console. If flakes appear: isolate those tests (serial) or avoid global console mutation.

---

## Medium priority (P2)

- **Prompt via argv exposure:** prompts passed via `-p` are visible to local process listing; consider stdin/tempfile in a future hardening pass.
- **Schema typing:** NDJSON event shape is `unknown`; add minimal runtime guards for the few fields you depend on (type/subtype/result/is_error).

---

## Readiness checklist

**P0 blockers**
- [ ] Bound `readNdjson` line buffering so a single huge NDJSON line cannot OOM.
- [ ] Handle async `logStream` errors so logging failures are non-fatal and cannot crash the process.

**P1 recommended**
- [ ] Decide/implement backpressure handling strategy for `logStream.write()`.
- [ ] Cap stderr capture or stream it to disk.
- [ ] Document sensitive-data expectations for verbose NDJSON logs.
- [ ] Reduce global console mutation risk under concurrent tests.

---

## Addendum (2026-02-18) - Re-review after remediation commit

**Reviewed:** `7d30d62d4c80` | `docs/development/002-impl-realtime-agent-logs.md` v1.3
**Local verification:** `cd 5x-cli && bun test` PASS (306 pass, 1 skip)

### What's addressed (✅)

- **P0.1 line-buffer bounding:** `readNdjson` now caps the in-flight partial-line buffer (`MAX_LINE_BUFFER_SIZE=1MiB`) and enters degraded mode (raw tee to logStream, parsing + onEvent disabled) with recovery on next newline (`5x-cli/src/agents/claude-code.ts`). Added tests covering degrade + recovery.
- **P0.2 async logStream errors non-fatal:** defensive `'error'` handler attached when logStream supports `.on()`, preventing unhandled error crashes and disabling further writes (`5x-cli/src/agents/claude-code.ts`). Added a unit test that emits `'error'` without crashing.
- **P1.2 stderr bounded:** stderr capture is capped (`MAX_STDERR_SIZE=64KiB`) while still draining the full pipe to avoid subprocess backpressure (`5x-cli/src/agents/claude-code.ts`). Added a unit test for bounding.
- **P1.4 concurrent-test safety:** warnings are routed via DI (`ClaudeCodeAdapter.warn()` + injectable `warn` sinks) so tests no longer monkey-patch global `console.warn` (`5x-cli/src/agents/claude-code.ts`, `5x-cli/test/agents/claude-code.test.ts`, `5x-cli/test/setup.ts`).

### Remaining concerns

- **P1.1 backpressure:** `logStream.write()` backpressure is still ignored; measure and/or gate on `'drain'` if buffered writes show memory growth under verbose streaming.
- **Phase 2 still required for end-to-end P0.2:** adapter now defensively handles `'error'`, but orchestrators should still attach error handlers immediately on stream creation (before handing to adapter) to reduce race windows; plan v1.3 now calls this out.
- **Security/tenancy (Phase 2):** NDJSON logs can contain sensitive tool I/O; ensure log dir permissions + doc/CLI messaging (plan now tracks as Phase 2 item).
- **Precision nit:** size caps are enforced on JS string length (UTF-16 code units), not raw bytes; OK as a guardrail, but keep wording/docs consistent if this matters.

### Updated readiness

- **002 Phase 1 completion:** ✅ - prior P0/P1 items raised in this review are addressed with code + tests.
- **Ready for Phase 2:** ✅ - proceed with orchestrator wiring; keep backpressure + permissions/docs as primary follow-ups.
