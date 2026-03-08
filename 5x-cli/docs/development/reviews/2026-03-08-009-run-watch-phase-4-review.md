# Review: 009 Run Watch + Invoke Stderr (Phase 4)

**Review type:** commit `d643a9f` (+ follow-ons through `7052304`)
**Scope:** `run watch`, `NdjsonTailer`, `session_start` metadata, shared `validateRunId()`, `invoke --stderr`, skills/docs, and follow-on fixes from prior review rounds
**Reviewer:** Staff engineer
**Local verification:** `bun test --concurrent --dots test/utils/ndjson-tailer.test.ts test/commands/run-watch.test.ts test/run-id.test.ts test/commands/invoke.test.ts` (pass)

## Summary

The implementation is production-ready. The core behavior from `d643a9f` matches the plan, and the follow-on fixes close the operability and test gaps raised in the earlier phase reviews: watch-mode failures now exit non-zero, cleanup is deterministic, `--stderr` has direct behavioral coverage, and skill guidance/documentation are aligned with the shipped CLI behavior.

**Readiness:** Ready - all planned phases are implemented, prior review concerns are addressed, and targeted verification passed.

## Strengths

- Correct contract shape: `run watch` keeps stdout machine-parseable by default, switches cleanly to human-readable rendering with `--human-readable`, and keeps warnings/errors on stderr.
- Good architectural fit: `session_start` stays log-only metadata, `validateRunId()` is shared, and `NdjsonTailer` remains isolated, bounded, and deterministic under test.
- Security/operability are solid: path traversal is blocked at the run-id layer, log directories are created with restricted permissions, permissive existing dirs warn, and watch cleanup is `try/finally`-safe.
- Test strategy now matches the plan: targeted coverage exists for invalid IDs, DB fallback, replay/tail-only behavior, human-readable labels, malformed/mid-stream failures, and both sides of the `invoke --stderr` contract.
- Prior review items were addressed: the open items from `docs/development/reviews/2026-03-08-009-run-watch-phase-1-review.md` and `docs/development/reviews/2026-03-08-009-run-watch-phase-2-review.md` are closed by follow-on commits `19cef1d` and `7052304`.

## Production Readiness Blockers

- None.

## High Priority (P1)

- None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] `run watch` validates run IDs safely and prevents path traversal
- [x] Default watch output remains clean NDJSON on stdout with `source` tagging
- [x] Human-readable mode labels interleaved streams correctly and avoids cross-stream buffer bleed
- [x] Unexpected watch-time failures warn on stderr and exit non-zero
- [x] `invoke --stderr` is wired through CLI and handler layers and is covered behaviorally

**P1 recommended**
- [x] Earlier review findings from prior phase reviews are addressed in follow-on commits
- [x] Plan phases 1-7 are reflected in code, tests, and skill guidance
