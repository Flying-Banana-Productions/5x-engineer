# Review: CLI Composability Phase 1

**Review type:** commit `cd69a31` and follow-on commits through `de0ae88`
**Scope:** Phase 1 implementation from `docs/development/010-cli-composability.md` (TTY auto-detect, `--pretty`, skills install stdout/stderr split)
**Reviewer:** Staff engineer
**Local verification:** `bun test test/output.test.ts test/commands/skills-install.test.ts` (36 pass, 0 fail); manual CLI repro confirms `--pretty --no-pretty` still produces pretty JSON

## Summary

Phase 1 is close, but not fully closed. The core behavior from `cd69a31` is in place and no subsequent commits changed the Phase 1 implementation files, but one CLI correctness edge case remains and the test suite still misses the adapter-level coverage called out in the plan review.

**Readiness:** Ready with corrections — implementation matches the phase intent overall, but needs small mechanical fixes before I would treat the phase as fully done.

## Strengths

- `src/output.ts` now defaults JSON formatting from `process.stdout.isTTY`, which aligns the CLI with normal Unix composition expectations.
- `src/commands/skills.handler.ts` cleanly separates machine-readable stdout from human progress on stderr, fixing the parser-hostile mixed stream behavior.
- `test/commands/skills-install.test.ts` verifies the important user-facing contract: clean stdout envelope when piped and explicit pretty output with `--pretty`.

## Production Readiness Blockers

- None.

## High Priority (P1)

### P1.1 -- Global pretty flags ignore CLI ordering

`src/bin.ts:9` processes `--no-pretty` first and `--pretty` second regardless of argument order, so `5x ... --pretty --no-pretty` still ends up pretty-printed. For CLI flags that represent opposing overrides, callers reasonably expect the last occurrence to win. This is a correctness issue in the new global flag handling, and it is mechanical to fix by preserving argv order during preprocessing.

## Medium Priority (P2)

- `test/output.test.ts:196` does not actually validate import-time TTY auto-detect; it re-implements the production expression via `setPrettyPrint(process.stdout?.isTTY ?? false)`. That leaves the adapter-level gap already called out in `docs/development/reviews/2026-03-06-010-cli-composability-plan-review.md:99` still open. Add a `bin.ts`-level test that exercises `--pretty` / `--no-pretty` parsing and a fresh-import path for default TTY detection.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Make global `--pretty` / `--no-pretty` precedence follow argv order, with last flag winning.
- [ ] Add adapter-level coverage for global pretty-flag parsing and import-time TTY default behavior.

## Addendum (2026-03-08) -- Phase 1 follow-up at `394ef32`

### What's Addressed

- `src/bin.ts` now resolves `--pretty` / `--no-pretty` by original argv position, so the last occurrence wins and all copies are stripped before citty parsing.
- `test/bin-pretty.test.ts` adds adapter-level subprocess coverage for compact-by-default piped output plus both override flags and both mixed-order precedence cases.
- Local verification passed: `bun test test/output.test.ts test/commands/skills-install.test.ts test/bin-pretty.test.ts` (41 pass, 0 fail).
- This follow-up closes the two issues from the original review: the CLI ordering bug and the missing adapter-level coverage.

### Remaining Concerns

- None. Phase 1 now meets the plan's completion gate and is ready to close.
