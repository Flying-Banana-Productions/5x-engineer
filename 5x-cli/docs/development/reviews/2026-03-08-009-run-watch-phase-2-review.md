# Review: 009 Run Watch + Invoke Stderr (Phase 2)

**Review type:** commit `d643a9f` (+ follow-ons through `HEAD`)
**Scope:** `run watch` handler/adapter, `NdjsonTailer`, `session_start` metadata, shared `validateRunId`, `invoke --stderr`, skills/docs, and targeted tests
**Reviewer:** Staff engineer
**Local verification:** `bun test --concurrent --dots test/utils/ndjson-tailer.test.ts test/commands/run-watch.test.ts test/run-id.test.ts test/commands/invoke.test.ts` (pass)

## Summary

The implementation is in good shape. Core behavior matches the plan, and the follow-on hardening after `d643a9f` addresses the substantive issues from the earlier phase review: cleanup is now `try/finally`-safe, log-dir permissions are tightened/warned, malformed log entries no longer crash human-readable watch mode, and shared run-id validation has direct unit coverage.

Remaining gaps are mechanical, not architectural: `run watch` still resolves unexpected streaming failures with a successful process exit, and the Phase 5 test gate is not fully met because there is no explicit coverage proving `invoke --stderr` is threaded through and honored.

**Readiness:** Ready with corrections — implementation is functionally sound; remaining work is limited to mechanical operability/test hardening.

## Strengths

- Correct output ownership: default `run watch` keeps stdout machine-parseable, while human-readable output is opt-in and warnings stay on stderr.
- Good architectural fit: `session_start` stays log-only, `validateRunId()` is shared, and `NdjsonTailer` remains runtime-agnostic and testable via `poll()`.
- Security posture is appropriate: run IDs are path-safe and log directories are created with restricted permissions, with warnings on permissive existing dirs.
- Operability improved materially since the initial commit: watch-mode cleanup and malformed-entry handling now degrade safely instead of corrupting stdout or crashing.
- Prior review concerns were mostly closed by `c4ba7b6` and `19cef1d`; no new regressions showed up in targeted verification.

## Production Readiness Blockers

- None.

## High Priority (P1)

### P1.1 — `run watch` reports success on unexpected streaming failures

**Action:** `auto_fix`

`runV1Watch()` catches unexpected streaming errors, writes a stderr message, aborts, and then returns normally (`src/commands/run-v1.handler.ts:549`). In practice that means an internal watch failure likely exits with status 0, which is misleading for scripts and harnesses using process status as the health signal.

Recommendation: set a non-zero exit code on this path (for example `process.exitCode = 1`) and add a focused test that forces a watch-time failure and asserts stderr warning + non-zero exit.

### P1.2 — Phase 5 test gate is incomplete for `invoke --stderr`

**Action:** `auto_fix`

The flag is wired in `src/commands/invoke.ts` and used in `src/commands/invoke.handler.ts`, but there is no explicit test coverage proving `--stderr` is passed through and bypasses the TTY gate. The plan's Phase 5 completion criteria call for tests that verify the flag is passed through and respected.

Recommendation: add targeted unit/integration coverage around `invokeStreamed()`/`invokeAgent()` that exercises both default non-TTY suppression and forced stderr streaming with `--stderr`.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] `session_start` remains log-only metadata, not provider contract surface
- [x] `run watch` preserves stdout as a clean streaming channel
- [x] Earlier cleanup/permission/type-guard review findings are addressed in follow-on commits

**P1 recommended**
- [ ] Unexpected watch-time internal failures exit non-zero
- [ ] `invoke --stderr` has direct behavioral test coverage

## Addendum (2026-03-08) — Follow-on review for `7052304`

This follow-on commit closes the remaining mechanical gaps from the main review. With these fixes in place, the phase is ready.

### What's Addressed

- `runV1Watch()` now sets `process.exitCode = 1` on unexpected streaming failures, so broken watch sessions no longer report success.
- `test/commands/run-watch.test.ts` adds a subprocess harness that forces a mid-stream stdout failure and verifies stderr warning plus non-zero exit.
- `test/commands/invoke.test.ts` now covers both sides of the `--stderr` contract: default suppression on non-TTY stderr and forced streaming when `--stderr` is present.
- Reviewer-path CLI coverage was added too, so the flag is exercised on both `invoke author` and `invoke reviewer`.

### Remaining Concerns

- None.
