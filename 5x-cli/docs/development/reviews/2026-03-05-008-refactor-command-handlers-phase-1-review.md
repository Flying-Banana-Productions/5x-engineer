# Review: 008 Refactor Command Handlers (Phase 1)

**Review type:** commit `c765b0dd2`
**Scope:** `src/utils/stdin.ts`, `src/utils/parse-args.ts`, `src/commands/context.ts`, `test/utils/parse-args.test.ts` + plan updates in `docs/development/008-refactor-command-handlers.md`
**Reviewer:** Staff engineer
**Local verification:** `bun test test/utils/parse-args.test.ts` (pass on current branch; commit under review is `c765b0dd2`)

## Summary

Phase 1 implementation matches the plan intent and the extracted code is a faithful move (no behavioral drift) from the original command implementations. The new utilities are appropriately scoped as adapter-layer helpers (`parse-args`) and framework-independent stdin primitives (`stdin`). The new context helpers (`resolveProjectContext`/`resolveDbContext`) align with existing `resolveProjectRoot(startDir?)` semantics and `loadConfig(projectRoot, providerNames?)` warning-suppression needs.

**Readiness:** Ready

## Strengths

- Extractions are clean and low-risk: `stdin.ts` is copy-equivalent with the prior `prompt.ts` helpers; `parse-args.ts` preserves validation/exit behavior via `outputError`.
- Context split is correct: DB/migrations are only in `resolveDbContext`; non-DB commands can use `resolveProjectContext`.
- `parse-args` has strong unit test coverage (33 cases) and asserts `CliError` + `INVALID_ARGS` semantics.

## High Priority (P1)

- None.

## Medium Priority (P2)

- `parseTimeout()` currently rejects leading-zero forms (e.g. "05") due to `String(parsed) !== rawStr`. This preserves prior behavior from `invoke.ts`, but consider adding an explicit test to make the contract obvious (either accept or document/reject intentionally).
- `parseIntArg()` enforces non-negative integers by default (negative always rejected). This matches prior `run-v1.ts`, but the utility name/docstring can surprise future callers; consider either documenting this prominently or adding an option to allow negatives when needed.

## Readiness Checklist

**Phase 1 gate**
- [x] `src/utils/stdin.ts` exists and matches prior prompt helpers
- [x] `src/utils/parse-args.ts` exists with `parseIntArg`/`parseFloatArg`/`parseTimeout`
- [x] `src/commands/context.ts` provides `resolveProjectContext`/`resolveDbContext`
- [x] `test/utils/parse-args.test.ts` exists and passes
