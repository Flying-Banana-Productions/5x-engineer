# Review: 203 recovery and doctor — Phase 3

**Reviewed commit:** `79f3f959d63607801d20295b4ccb01c5bc5520e7`  
**Plan:** `docs/development/plans/203-recovery-and-doctor-plan.md` (Phase 3)  
**Verdict:** Rejected

## Summary

The state budget fields, 80% warning calculation, JSON/text output separation, and maximum-step remediation are implemented as planned. Targeted tests pass (45 passing). However, the maximum-step guard still runs before the idempotent insert check, so a duplicate `run record` at the configured ceiling fails even though it would add no step. This violates the phase's idempotent re-record requirement and makes retrying an already-recorded protocol step fail once the run is full.

## Findings

### Major — idempotent re-records fail at the maximum budget

`recordStepInternal` rejects whenever the current summary equals `maxStepsPerRun` before calling `recordStep`, which is the operation that detects duplicates with `recorded: false`. A retried record for an existing `(run, step_name, iteration)` therefore receives `MAX_STEPS_EXCEEDED` instead of its stable no-op result at the ceiling. The new idempotence test only exercises one step of a 250-step budget and misses this boundary.

**Location:** `src/commands/run-v1.handler.ts:1130-1142`  
**Required action:** Preserve duplicate/no-op behavior at the ceiling while continuing to reject a new unique step, and add coverage for a duplicate re-record when `total_steps === maxStepsPerRun`.

## Verification

- `bun test test/unit/commands/run-step-budget.test.ts test/integration/commands/run-v1.test.ts` — 45 passed, 0 failed.
- Author-reported quality gate: lint plus 2503 tests, 8 skipped, 0 failed.

## Addendum — Re-review after `ab54a611d94eba506d37d8713eb1d2f1e472093e`

**Verdict:** Approved

The ceiling guard now uses `findExistingStep` to recognize exactly the explicit, non-null `(run_id, step_name, phase, iteration)` key that `recordStep` can make an `INSERT OR IGNORE` no-op. A matching duplicate is allowed through and returns `recorded: false`; an omitted iteration, null/omitted phase, or absent matching key remains a unique insert and is rejected at the ceiling. The new boundary test fills a three-step budget, confirms the duplicate no-op response and unchanged count, and confirms a new record receives `MAX_STEPS_EXCEEDED`.

### Verification

- `bun test test/unit/commands/run-step-budget.test.ts test/integration/commands/run-v1.test.ts` — 46 passed, 0 failed.
- Author-reported quality gate: lint plus 2504 tests, 8 skipped, 0 failed.
