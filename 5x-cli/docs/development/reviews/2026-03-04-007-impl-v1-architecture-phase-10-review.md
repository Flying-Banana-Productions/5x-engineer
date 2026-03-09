# Review: 007 impl v1 architecture - Phase 10 (v0 Cleanup + Public API)

**Review type:** commit `b54d74c` (no follow-on commits)
**Scope:** Phase 10 changes: remove remaining v0 CLI surfaces + update public exports
**Reviewer:** Staff engineer
**Local verification:** `bun test` (658 tests: 657 pass, 1 skip), `bunx --bun tsc --noEmit` (pass), `bunx --bun @biomejs/biome check src/ test/` (pass)

## Summary

Phase 10 goals are met: the last v0-facing command/gate surfaces (`status`, human/TUI gates) are removed, `src/bin.ts` only registers v1 commands, and `src/index.ts` continues converging on a v1 public API (now including JSON envelope helpers). Repo remains green (tests/typecheck/lint).

**Readiness:** Ready with corrections -- phase-complete; a couple small doc/API hygiene items remain.

## Strengths

- Clean, surgical deletions (command + dependent gates + tests) with no dangling imports.
- `src/bin.ts` is now clearly v1-only; removes ambiguity about supported UX.
- `src/index.ts` exports `CliError`/`outputSuccess`/`outputError` + envelope types, aligning with v1 JSON contract.
- Verification is solid: full test suite + typecheck + lint are green.

## Production Readiness Blockers

None found.

## High Priority (P1)

None.

## Medium Priority (P2)

- Update stale `5x status` reference in `src/db/connection.ts` (`openDbReadOnly()` docstring).
- Public API clarity: `createRun()` still has an unused `reviewPath?` parameter in `src/db/operations.ts` (consider deprecating/documenting or removing).
- Update CLI description in `src/bin.ts` to match v1 positioning ("toolbelt of primitives" vs "author-review loop runner").

## Readiness Checklist

**P0 blockers**
- [x] `src/bin.ts` registers only v1 commands
- [x] v0 command/gate surfaces removed (`status`, human/TUI gates)
- [x] Public API exports include v1 output helpers
- [x] Tests + typecheck + lint are green

**P1 recommended**
- [x] None

## Addendum (2026-03-05) — P2 Fix Verification (commit `adb3c90`)

### What's Addressed

- P2.1: `src/db/connection.ts` docstring now references `5x run state`.
- P2.2: `src/db/operations.ts` `createRun()` no longer accepts unused `reviewPath?`.
- P2.3: `src/bin.ts` CLI description updated to v1 positioning.

### New Issues

- None found; tests/typecheck/lint remain green after `adb3c90`.

### Remaining Concerns

- `createRun()` signature change is technically API-breaking for external callers; ensure release/versioning expectations match.

## Addendum (2026-03-05) — Test Timeout Fix Verification (commit `c3588bb`)

### What's Addressed

- P1.1: CLI spawn-based integration tests in `test/commands/invoke.test.ts` now set `{ timeout: 20000 }`, removing reliance on Bun's default 5000ms and preventing observed flake.

### New Issues

- None found.

### Verification Notes

- Local: `bun test` (658 tests: 657 pass, 1 skip), `bunx --bun tsc --noEmit` (pass), `bunx --bun @biomejs/biome check src/ test/` (pass).

### Remaining Concerns

- `createRun()` signature change is technically API-breaking for external callers; ensure release/versioning expectations match.

## Addendum (2026-03-05) — Retest Notes (HEAD `adb3c90`)

### What's Addressed

- Re-validated Phase 10 + P2 follow-up at HEAD; changes remain doc/API hygiene only.

### New Issues

- `bun test` can intermittently timeout on `test/commands/invoke.test.ts` (Bun default 5000ms) at: `invoke > CLI integration > invoke author subcommand is registered`. The same test passes with a higher timeout (e.g. `bun test test/commands/invoke.test.ts --timeout 20000`, ~10s). Recommend setting explicit timeouts for `run5x()` spawn-based integration tests (or raising suite default) to avoid CI flakes.

### Remaining Concerns

- `createRun()` signature change is technically API-breaking for external callers; ensure release/versioning expectations match.
