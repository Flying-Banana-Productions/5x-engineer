# Review: CLI Composability Phase 6

**Review type:** Commit `6a4ccb5`
**Scope:** Phase 6 implementation for `--record` / `--record-step` on `invoke` and `quality run`, plus follow-on test/doc updates in the same commit range
**Reviewer:** Staff engineer
**Local verification:** `bun test test/commands/invoke-record.test.ts` and `bun test test/commands/quality-record.test.ts test/commands/quality-v1.test.ts` — passed

## Summary

Phase 6 is mostly in place: both commands wire into `recordStepInternal()`, preserve the primary success envelope on the happy path, and add decent coverage for the main workflows. The remaining gaps are both mechanical but important: one corrupts stdout on some `--record` validation failures, and one skips recording entirely when `quality run` has no configured gates.

**Readiness:** Ready with corrections — core design matches the plan, but two correctness/contract gaps should be fixed before treating the phase as complete.

## Strengths

- Reuses `recordStepInternal()` instead of duplicating DB logic, which keeps Phase 6 aligned with the Phase 3 separation between persistence and CLI output.
- `invoke` recording captures the expected metadata (`session_id`, model, tokens, duration, log path) and keeps the primary envelope shape unchanged on successful auto-recording.
- Tests cover the main happy paths, override behavior, and record-failure warning path for both commands.

## Production Readiness Blockers

- None.

## High Priority (P1)

### P1.1 — `--record` validation can emit a second stdout envelope after success

Action: `auto_fix`.

`outputSuccess()` runs before some `--record` validation branches, then `outputError()` is used for side-effect failures in `src/commands/quality-v1.handler.ts:63` and `src/commands/invoke.handler.ts:481`. Since `outputError()` throws a `CliError` that `bin.ts` renders to stdout, `quality run --record` without `--run` and `invoke --record` on a template with no available step name can produce a second JSON object on stdout. That violates the phase requirement that `--record` never corrupt or suppress the primary envelope and should instead warn on stderr plus exit non-zero.

### P1.2 — `quality run --record` does not record when no quality gates are configured

Action: `auto_fix`.

`src/commands/quality-v1.handler.ts:32` returns early for the empty-gates case, so the new auto-record path is never reached. The plan treats `quality run --record --run R1` as a general Phase 6 capability, and existing base behavior already treats zero gates as a valid successful quality run. In the current implementation, the command reports success but silently skips the requested side effect. Add coverage for the empty-gates + `--record` path.

## Medium Priority (P2)

- Extend Phase 6 tests to cover the two failing edge cases above; current tests mostly validate happy paths and DB failure warnings, so they would not catch stdout corruption or the empty-gates record bypass.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [x] Keep `--record` validation and failure handling off stdout after the primary envelope has been written.
- [x] Ensure `quality run --record` records the empty-gates success result too.

## Addendum (2026-03-08) — Follow-up review for `4b1693b`

### What's Addressed

- `src/commands/invoke.handler.ts:487` now keeps post-success `--record` validation on stderr and sets `process.exitCode`, so missing step-name cases no longer emit a second stdout envelope.
- `src/commands/quality-v1.handler.ts:36` centralizes post-success recording behavior in `autoRecord()`, and `src/commands/quality-v1.handler.ts:80` now applies it to the empty-gates early-return path too.
- `test/commands/invoke-record.test.ts:462` and `test/commands/quality-record.test.ts:371` add coverage for the stdout-corruption regression; `test/commands/quality-record.test.ts:403` covers the empty-gates recording path.
- Local verification passed: `bun test test/commands/invoke-record.test.ts test/commands/quality-record.test.ts`.

### Remaining Concerns

- None. The follow-up commit closes the prior P1 gaps, matches the Phase 6 plan contract, and is ready to treat as complete.
