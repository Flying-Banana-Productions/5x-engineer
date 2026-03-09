# Review: CLI Composability Phase 5 (`--var @-` / `@path`)

**Review type:** commit `96e7723`
**Scope:** Phase 5 implementation in `src/commands/invoke.handler.ts`, tests in `test/commands/invoke-var-file.test.ts`, and plan compliance against `docs/development/010-cli-composability.md`
**Reviewer:** Staff engineer
**Local verification:** Ran `bun test test/commands/invoke-var-file.test.ts` and `bun test test/commands/invoke-pipe.test.ts` — both passed

## Summary

The implementation lands the main Phase 5 behavior: `--var key=@-` consumes stdin, `--var key=@path` reads file content, and `@-` correctly blocks upstream envelope ingestion. The main issue is API compatibility: any literal `--var key=@value` input is now reinterpreted as a file read, which violates the plan's explicit backward-compatibility constraint and can break existing scripts.

**Readiness:** Not ready — Phase 5 behavior mostly works, but the new `@...` parsing introduces a CLI contract regression that needs a deliberate compatibility decision before this phase can be considered complete.

## Strengths

- `hasStdinVarFlag()` cleanly separates stdin-reservation detection from variable parsing, which keeps the Phase 4 pipe-ingestion flow readable and consistent.
- The new integration suite exercises the intended happy paths and stdin-conflict behavior, and the targeted test run passed locally.

## Production Readiness Blockers

### P0.1 — `--var` no longer supports literal values that start with `@`

**Risk:** Existing callers that legitimately pass values like `--var token=@abc`, `--var mention=@user`, or any other literal `@...` string now fail with file-read errors or unexpected behavior. That is a breaking CLI change in a phase whose plan explicitly says the rollout must remain additive/backward-compatible.

**Requirement:** Preserve a way to pass literal leading-`@` values without triggering file IO, and document the chosen rule. This likely needs a human decision on syntax/API semantics (for example: explicit opt-in prefix, escaping convention, or narrower file-detection rules), plus regression coverage for literal `@...` values.

## High Priority (P1)

- None.

## Medium Priority (P2)

- Add an end-to-end assertion that the stdin/file payload actually reaches template rendering or provider input; current Phase 5 tests mostly prove command success and conflict handling, but they do not verify the loaded value is the one used.

## Readiness Checklist

**P0 blockers**
- [x] Resolve the CLI compatibility contract for literal leading-`@` variable values and add regression tests.

**P1 recommended**
- [x] Add a stronger behavioral test that proves `@-` and `@path` values are injected into the rendered invocation payload, not just accepted by the command.

## Addendum (2026-03-08) — Follow-on commit `226ce59`

### What's Addressed

- The prior P2 coverage gap is closed. `test/commands/invoke-var-file.test.ts` now enables sample-provider echo mode, reads the emitted NDJSON log, and asserts that both `--var user_notes=@./file` and `--var user_notes=@-` content reaches the rendered prompt sent to the provider.
- This directly matches the remaining Phase 5 test recommendation from the original review. Local verification: `bun test test/commands/invoke-var-file.test.ts` passed.

### Remaining Concerns

- `P0.1` remains open. `src/commands/invoke.handler.ts:149` still interprets any leading-`@` value as file input, so literal values like `--var token=@abc` remain a breaking compatibility regression against the plan's additive/backward-compatible requirement.
- Readiness stays `Not ready` until the CLI contract for literal leading-`@` values is resolved and covered by regression tests.

## Addendum (2026-03-09) — P0.1 resolution

### What's Addressed

- `P0.1` is resolved. `src/commands/invoke.handler.ts` now uses an `isFileReference()` helper that only triggers file-read when the value after `@` starts with `.` or `/` (i.e., `@./relative` or `@/absolute`). Literal `@`-prefixed values like `--var token=@abc` or `--var mention=@user` are passed through unchanged.
- Three regression tests added in `test/commands/invoke-var-file.test.ts`: `@username` literal passthrough, `@abc123` literal passthrough, and bare `@` literal passthrough. All verify the value reaches the rendered prompt via sample-provider echo logs.
- The P1 checklist item (stronger behavioral test for `@-` and `@path`) was already addressed in the prior addendum (`226ce59`).
- Readiness: **Ready** — all review items are resolved.
