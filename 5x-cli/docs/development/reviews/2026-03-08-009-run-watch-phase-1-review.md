# Review: 009 Run Watch + Invoke Stderr (Phase 1)

**Review type:** commit `d643a9fa4b` (+ follow-on `c4ba7b66e9`)
**Scope:** `run watch` (NDJSON + human-readable), `NdjsonTailer`, `session_start` log metadata, `invoke --stderr`, shared `validateRunId`, tests/docs
**Reviewer:** Staff engineer
**Local verification:** `bun test --concurrent --dots test/utils/ndjson-tailer.test.ts test/commands/run-watch.test.ts` (pass)

## Summary

Implementation matches the plan intent: `invoke` logs are now self-describing via a CLI-written `session_start` entry, harnesses can force console streaming via `--stderr`, and `5x run watch --run <id>` provides real-time monitoring with a machine-parseable default (NDJSON on stdout) plus an opt-in human-readable renderer.

Follow-on hardening in `c4ba7b66e9` materially improves safety/operability: log dir creation is permission-restricted, watch-side event reconstruction is guarded to avoid crashes on malformed/legacy entries, and tailer IO errors degrade gracefully.

**Readiness:** Ready with corrections — core behavior is correct; remaining items are mechanical hardening + small test gaps.

## Strengths

- Output contract is sane: raw NDJSON to stdout by default; human-readable behind `--human-readable`; pre-stream errors still return normal envelopes.
- Security posture improved: `validateRunId()` is shared and blocks path traversal for both `invoke` and `run watch`.
- Operability: DB-fast-fail with log-dir fallback supports ad-hoc invocations; warnings go to stderr and stdout stays clean.
- Tailer design is pragmatic and safe: bounded chunk reads, bounded partial-line buffering, truncation handling, deterministic `poll()` for tests.
- Human-readable interleaving is handled: `StreamWriter` boundaries enforced on file switches and label headers.

## Production Readiness Blockers

- None.

## High Priority (P1)

### P1.1 — Ensure `run watch` always detaches SIGINT handler (and never throws mid-stream)

**Action:** `auto_fix`

`runV1Watch()` attaches a process-level `SIGINT` handler, then awaits long-running loops. If an unexpected exception escapes (e.g., tailer internal bug, writer error), the handler may remain attached and `bin.ts` may emit an error envelope into stdout mid-stream.

Recommendation: wrap the watch execution in `try/finally` to always `process.off("SIGINT", onSigint)` and to ensure the tailer is destroyed/aborted on error; convert unexpected streaming-time errors into best-effort stderr warnings + abort.

### P1.2 — Add direct unit coverage for `validateRunId()` boundaries

**Action:** `auto_fix`

`validateRunId()` is currently exercised indirectly (e.g., `run watch` invalid id test). Add a focused unit test suite for boundary cases (length 1/64, allowed `_`/`-`, disallowed `.`/`/`, leading hyphen, empty string) to prevent accidental regex drift.

## Medium Priority (P2)

- **Action:** `auto_fix` — Consider tightening/warning on existing log-dir permissions in `run watch` (today it sets mode on creation only; a manually-created log dir may remain too-open).
- **Action:** `human_required` — Decide whether `[watch] Warning: malformed JSON...` (stderr) should be rate-limited or made quieter in typical usage; current behavior is correct but can be noisy on partial/rotated writes.

## Readiness Checklist

**P0 blockers**
- [x] `session_start` is log-only metadata and not part of provider `AgentEvent`
- [x] `run watch` defaults to machine-parseable stdout and keeps warnings on stderr
- [x] Tailer bounded reads + bounded buffers + truncation handling
- [x] Human-readable output flushes StreamWriter state on file switches

**P1 recommended**
- [x] `run watch` cleanup is `try/finally`-safe; unexpected errors do not corrupt stdout
- [x] `validateRunId()` has direct unit coverage for boundary cases

## Addendum (2026-03-08) — Review of follow-on fix commit `19cef1d`

### What's Addressed

- P1.1 implemented: `runV1Watch()` now uses `try/finally` to always `process.off("SIGINT", ...)` and `tailer.destroy()`; unexpected streaming-time errors are emitted to stderr (avoids a JSON envelope landing mid-stdout stream).
- P1.2 implemented: added direct unit coverage for `SAFE_RUN_ID` + `validateRunId()` boundary cases in `test/run-id.test.ts`.
- P2.1 implemented: `run watch` warns if an existing log dir is group/other accessible (mode has any `0o077` bits).

### Remaining Concerns

- P2.2 still open (`human_required`): decide whether watch-side stderr warnings (e.g., malformed JSON) should be rate-limited / quieted; current behavior is safe but can be noisy.
- `human_required`: decide desired exit semantics on unexpected watch failures. Current implementation logs to stderr and returns (likely exit code 0); if this is used in automation, consider setting `process.exitCode = 1` when catching unexpected errors.
- `auto_fix`: consider including `err.stack` (when available) in the stderr log for unexpected watch errors to improve debuggability without corrupting stdout.
