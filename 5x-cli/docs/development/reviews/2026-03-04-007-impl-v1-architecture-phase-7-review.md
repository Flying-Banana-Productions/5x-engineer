# Review: 007 impl v1 architecture - Phase 7

**Review type:** commit `9f284e1`
**Scope:** `5x prompt choose/confirm/input` (Phase 7) plus Phase 6 follow-on command registrations/tests and quality gate streaming changes
**Reviewer:** Staff engineer
**Local verification:** `bun test test/commands/prompt.test.ts test/commands/diff.test.ts test/commands/plan-v1.test.ts test/commands/quality-v1.test.ts` (32 pass)

## Summary

Phase 7 is implemented and matches the plan at a functional level: prompts are routed to stderr, results are returned as JSON envelopes, and non-TTY behavior is covered by tests. One interactive-path bug (EOF handling) can cause the CLI to hang, which is a mechanical fix before calling this phase complete.

**Readiness:** Ready with corrections — interactive EOF can hang `choose`/`confirm`.

## Strengths

- Clear separation of concerns: prompt UI to stderr, machine-readable JSON only on stdout (`src/commands/prompt.ts`, `src/output.ts`, `src/bin.ts`)
- Non-interactive behavior is explicit and well-tested (defaults vs `NON_INTERACTIVE` exit 3)
- Input reading supports both piped stdin and interactive multiline without buffering surprises
- Quality gate streaming changes reduce OOM risk by bounding inline output while preserving full logs (`src/gates/quality.ts`)

## Production Readiness Blockers

### P0.1 — Interactive EOF can hang `prompt choose` / `prompt confirm`

**Risk:** If stdin closes (common case: user presses Ctrl+D at an interactive prompt), `readLine()` never resolves because it only completes on `\n` or `SIGINT`. This can hang an orchestrator waiting on the prompt result.

**Requirement:** `readLine()` must resolve on stdin EOF.

Acceptance criteria:
- Add an `end` listener in `readLine()` that cleans up and resolves the buffered text (or empty string)
- Ensure `choose`/`confirm` return deterministically on EOF (e.g. treat as empty input: use default if present; otherwise error)

## High Priority (P1)

### P1.1 — Interactive invalid input handling should be stricter / more predictable

Today, `choose` falls back to default (or first option) on invalid input; `confirm` falls back to default (or false). This is deterministic, but it can hide user mistakes and differs from the plan wording "wait for selection".

Recommendation:
- Decide on a consistent policy for interactive invalid input: reprompt until valid vs emit `INVALID_INPUT` and exit non-zero
- Add coverage for the chosen policy (unit-testable if prompt IO is refactored to accept injectable streams)

## Medium Priority (P2)

- `src/commands/quality-v1.ts` header comment still mentions a `--config` flag that is not implemented; align docs/comments with the actual CLI surface
- Consider cancel semantics: `SIGINT` currently resolves to empty input and may silently choose a default/first option; emitting a dedicated error code (and stable exit code) would make orchestration safer

## Readiness Checklist

**P0 blockers**
- [ ] `prompt` interactive mode handles EOF without hanging

**P1 recommended**
- [ ] `prompt choose/confirm` interactive invalid input policy is explicit and tested

## Addendum (2026-03-05) — Re-review after fixes (`68edc79`)

### What's Addressed

- P0.1 fixed: `readLine()` now resolves on EOF via an `end` listener; `choose`/`confirm` handle EOF deterministically (`src/commands/prompt.ts`)
- P1.1 addressed: interactive `choose`/`confirm` now reprompt on invalid input instead of silently defaulting; added interactive-path tests via `FORCE_TTY=1` (`test/commands/prompt.test.ts`)
- P2 addressed: `src/commands/quality-v1.ts` comment no longer advertises `--config`
- Cancel semantics improved: SIGINT now returns `INTERRUPTED` with exit code 130 (`src/output.ts`, `src/commands/prompt.ts`)

### Remaining Concerns

- Docs/contract drift: new error codes `EOF` (exit 3) and `INTERRUPTED` (exit 130) are not reflected in the exit-code docstring in `src/output.ts` nor in the implementation plan’s exit-code table; document these (or rename/scope them) so skills can rely on them
- `FORCE_TTY` is a useful test hook but is now part of runtime behavior; consider namespacing (e.g. `5X_FORCE_TTY`) or scoping to test-only to reduce surprise
