# Review: Harness & Skills Uninstall Phase 2

**Review type:** commit `ca2a0e79c8045a229145c8a0907fa6a71c731ca3`
**Scope:** Phase 2 plugin contract extensions in `src/harnesses/types.ts`, `src/harnesses/factory.ts`, `src/harnesses/opencode/plugin.ts`, caller updates in `src/commands/harness.handler.ts`, and unit coverage in `test/unit/commands/harness.test.ts`, `test/unit/harnesses/factory.test.ts`, and `test/unit/harnesses/opencode.test.ts`
**Reviewer:** Staff engineer
**Local verification:** `bun run typecheck` - passed; `bun test test/unit/harnesses/factory.test.ts test/unit/harnesses/opencode.test.ts test/unit/commands/harness.test.ts` - 58 passed

## Summary

The contract changes themselves are sound: `HarnessPlugin` now exposes the minimal uninstall/list surface the later phases need, the OpenCode plugin implements it cleanly, and existing install behavior still typechecks and passes targeted unit coverage. The phase is not ready to sign off because the factory tests do not cover the critical external-override path called out in the plan, so the new `source` tracking behavior is still unproven where it matters most.

**Readiness:** Not ready - one blocking test-strategy / plan-compliance gap remains in the `LoadedHarnessPlugin.source` regression coverage.

## Strengths

- `src/harnesses/types.ts` adds `locations`, `describe()`, and `uninstall()` with clean supporting types and keeps the plugin surface narrowly scoped.
- `src/harnesses/opencode/plugin.ts` composes the new behavior from existing loader/installer primitives instead of duplicating path or file-removal logic.
- `src/commands/harness.handler.ts` was updated minimally for the new `loadHarnessPlugin()` return shape, so existing install behavior remains stable.
- `test/unit/harnesses/opencode.test.ts` gives useful direct coverage for `describe()` and `uninstall()` filesystem behavior.

## Production Readiness Blockers

### P1.1 - Missing external-override regression test for harness source tracking

**Risk:** The main regression this phase is supposed to prevent - mislabeling an external package override of a bundled harness as `bundled` - is still not actually exercised by tests. A future refactor could silently reintroduce that bug while this phase still appears green.

**Requirement:** Add a unit test that simulates a successful dynamic import for a bundled harness name and asserts `loadHarnessPlugin()` returns `source: "external"` for that override case, as required by the Phase 2 plan. Classify fix action as `auto_fix`.

## High Priority (P1)

### P1.2 - Invalid harness error text is stale after the contract expansion

`src/harnesses/factory.ts:54` still documents the old plugin contract and omits `locations`, `describe()`, and `uninstall()`. That weakens operability when a third-party plugin fails validation because the error no longer tells authors what shape is actually required. Update the message to reflect the current contract. Classify fix action as `auto_fix`.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Add the missing external-override `source: "external"` regression test in `test/unit/harnesses/factory.test.ts`. (`auto_fix`)
- [ ] Refresh the stale invalid-plugin error contract text in `src/harnesses/factory.ts`. (`auto_fix`)

## Addendum (2026-03-13) — Fix review

### What's Addressed

- `test/unit/harnesses/factory.test.ts` now exercises the exact external-override regression path by injecting a successful external import for the bundled `opencode` name and asserting `loadHarnessPlugin()` returns `source: "external"`, closing the main Phase 2 plan-compliance gap.
- `src/harnesses/factory.ts` now reports the expanded plugin contract in `InvalidHarnessError`, so plugin authors get actionable guidance when validation fails.
- The injected `importFn` keeps the production resolution order intact while making the override path directly unit-testable; that is consistent with the factory's existing architecture and avoids brittle module-loader tricks in the test suite.
- Local verification passed: `bun run typecheck`; `bun test test/unit/harnesses/factory.test.ts test/unit/harnesses/opencode.test.ts test/unit/commands/harness.test.ts`.

### Remaining Concerns

- None. Prior review items are resolved and I did not find new blocking issues in the fix commit.

**Readiness:** Ready — Phase 2 now satisfies the prior review items, matches the plan's required regression coverage, and has sufficient targeted validation for the contract changes.
