# Review: 009 Run Watch + Invoke Stderr (Phase 3)

**Review type:** commit `d643a9f` (+ relevant follow-ons `c4ba7b6`, `19cef1d`, `7052304`)
**Scope:** `run watch`, `NdjsonTailer`, `session_start` metadata, shared `validateRunId()`, `invoke --stderr`, skill guidance, and targeted verification against `docs/development/009-run-watch-and-stderr.md`
**Reviewer:** Staff engineer
**Local verification:** `bun test --concurrent --dots test/utils/ndjson-tailer.test.ts test/commands/run-watch.test.ts test/run-id.test.ts test/commands/invoke.test.ts` (pass)

## Summary

The implementation now meets the plan cleanly. Core behavior from `d643a9f` is correct, and the follow-on fixes close the earlier operability and test-strategy gaps: watch-mode failures now exit non-zero, cleanup is deterministic, malformed/legacy log entries degrade safely, permissions are tightened/warned, and `invoke --stderr` has direct behavioral coverage.

**Readiness:** Ready - phase requirements are met, prior review concerns are closed, and the feature is production-ready within the current CLI architecture.

## Strengths

- Correct contract: `run watch` keeps default stdout machine-parseable, while `--human-readable` is explicit and stderr remains the warning channel.
- Good architectural fit: `session_start` stays log-only, `validateRunId()` is shared, and `NdjsonTailer` remains runtime-agnostic and directly testable.
- Security posture is appropriate: run IDs are path-safe, log directories are created with restricted permissions, and permissive existing directories are surfaced.
- Operability is solid: SIGINT cleanup is reliable, watch-time internal failures no longer look successful, and malformed log data does not crash rendering.
- Test strategy matches the risk areas: deterministic tailer tests, subprocess watch-failure coverage, and explicit `--stderr` behavior tests for both invoke roles.

## Production Readiness Blockers

- None.

## High Priority (P1)

- None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] `run watch` output contract matches the plan: NDJSON by default, human-readable opt-in.
- [x] `session_start` remains CLI-written log metadata, not provider contract surface.
- [x] Tailer behavior is bounded and resilient: chunked reads, capped partial buffers, truncation handling, malformed-line skip.
- [x] Unexpected watch-time failures surface as stderr errors and non-zero exit.

**P1 recommended**
- [x] `run watch` cleanup is `try/finally`-safe and detaches its SIGINT handler.
- [x] Shared run-id validation has direct boundary coverage.
- [x] `invoke --stderr` is behaviorally verified for non-TTY stderr on both author and reviewer paths.
