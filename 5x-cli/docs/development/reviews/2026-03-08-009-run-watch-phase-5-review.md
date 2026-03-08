# Review: 009 Run Watch + Invoke Stderr (Phase 5)

**Review type:** commit `d643a9f` (+ follow-ons through `7052304`)
**Scope:** `invoke --stderr` flag wiring, runtime behavior, and Phase 5 test coverage
**Reviewer:** Staff engineer
**Local verification:** `bun test --concurrent --dots test/commands/invoke.test.ts` (pass); `bun test --concurrent --dots test/commands/run-watch.test.ts test/run-id.test.ts` (pass)

## Summary

Phase 5 is implemented correctly. The CLI adapter threads `--stderr` through both `invoke author` and `invoke reviewer`, and the handler uses it exactly as intended: stderr streaming stays suppressed for non-TTY callers by default, but becomes opt-in when a harness explicitly passes `--stderr`.

The follow-on test additions in `7052304` close the main gap from the broader review cycle: behavior is now verified end-to-end against a non-TTY subprocess, which is the exact scenario this flag exists to support.

**Readiness:** Ready - Phase 5 matches the plan and has sufficient behavioral coverage.

## Strengths

- Correct contract: stdout remains reserved for the JSON envelope while human-readable streaming stays on stderr.
- Good ergonomics: `--stderr` is available on both subcommands and remains opt-in, preserving existing quiet-by-default non-TTY behavior.
- Architecture stays clean: the change is a narrow parameter thread into `invokeStreamed()` rather than a broader output-path rewrite.
- Test strategy is appropriate: subprocess tests exercise real non-TTY stderr behavior instead of relying on brittle mocks.

## Production Readiness Blockers

- None.

## High Priority (P1)

- None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] `--stderr` is exposed on both `invoke author` and `invoke reviewer`
- [x] Non-TTY stderr remains suppressed by default
- [x] `--stderr` overrides the TTY gate without affecting stdout JSON output

**P1 recommended**
- [x] Behavioral coverage verifies the default and forced-stderr paths in subprocess execution
