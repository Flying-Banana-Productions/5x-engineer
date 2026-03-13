# Review: Harness & Skills Uninstall Phase 3

**Review type:** commit `dd34980ccd621cd616b0d4710b660ce3e6c7ce13`
**Scope:** Phase 3 harness uninstall command changes in `src/commands/harness.handler.ts`, `src/commands/harness.ts`, and coverage in `test/unit/commands/harness.test.ts` plus `test/integration/commands/harness.test.ts`
**Reviewer:** Staff engineer
**Local verification:** `bun run typecheck` - passed; `bun test test/unit/commands/harness.test.ts` - 23 passed; `bun test test/integration/commands/harness.test.ts` - 14 passed

## Summary

The filesystem uninstall path is implemented correctly and the scope validation/root-resolution behavior broadly matches the Phase 3 plan. This phase is still not ready because the new command does not emit the required success JSON envelope on stdout, so it breaks the v1 CLI contract and does not satisfy the phase completion gate.

**Readiness:** Not ready - one blocking correctness/plan-compliance gap remains in the CLI output layer.

## Strengths

- `harnessUninstallCore()` cleanly separates the data-building path from the side-effecting summary printer, which is the right structure for direct unit testing.
- Scope validation and `resolveCheckoutRoot(cwd) ?? cwd` fallback are implemented consistently with the plan, including the non-git project cleanup path.
- The uninstall flow delegates deletion to `plugin.uninstall()` rather than reaching into plugin internals, preserving the architecture established in Phase 2.
- Targeted unit and integration coverage exercises single-scope, `--all`, missing-file, and validation scenarios.

## Production Readiness Blockers

### P1.1 - Success path does not emit the required JSON envelope

**Risk:** `5x harness uninstall` currently writes only human-readable stderr lines and returns normally without calling `outputSuccess()`. That leaves stdout empty on success, making the command inconsistent with the repo's v1 CLI contract and unusable for scripts expecting `{ ok: true, data }` output.

**Requirement:** Update the output layer to emit `outputSuccess(output)` after printing the human-readable summary, and add an integration assertion covering the stdout envelope shape for a successful uninstall. Classify fix action as `auto_fix`.

## High Priority (P1)

None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Emit the uninstall success envelope with `outputSuccess(output)` and add stdout-envelope coverage in `test/integration/commands/harness.test.ts`. (`auto_fix`)

## Addendum (2026-03-13) - P1.1 verification

### What's Addressed

- `src/commands/harness.handler.ts` now calls `outputSuccess(output)` immediately after `printUninstallSummary(output)`, restoring the required `{ ok: true, data }` success envelope on stdout for `5x harness uninstall`.
- `test/integration/commands/harness.test.ts` adds a successful uninstall assertion that parses stdout JSON and verifies the expected envelope shape, covering the previously missing contract check.
- Local re-verification passed: `bun run typecheck`; `bun test test/integration/commands/harness.test.ts`.

### Remaining Concerns

- None. The prior blocker is resolved and this Phase 3 change set is ready.
