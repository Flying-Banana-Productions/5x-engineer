# Review: 203 recovery and doctor — Phase 5

**Reviewed commit:** `7c5a15a455af71d0ea33e046e4ba5911ff400c5a`  
**Plan:** `docs/development/plans/203-recovery-and-doctor-plan.md` (Phase 5)

## Summary

The three checks are registered and their normal detection behavior follows the planned status and finding-identity mapping. Doctor intentionally ignores `freshnessWarnings=off`, lock repairs use the correct safe lock helpers, and the worktree detector is read-only/non-creating. However, two auto-fixes fail the required re-validation-before-write invariant, so a state change after detection can cause doctor to overwrite a newly unsafe harness install or clear a newly valid worktree mapping. The newly added unit tests also fail under the repository's required concurrent test command because they race while monkey-patching `console.log`.

## Readiness

Not ready — three P1 auto-fixes are required.

## Items

- **P1 — Re-validate lossless harness state immediately before sync** (`auto_fix`; `human_required: false`): `fix` trusts the stale finding's old `losslessRefresh` detail and calls `harnessSyncCore` without first re-running the Tier-2 freshness check. `harnessSyncCore` itself permits a context-mismatched install to be rewritten, so an install which becomes context-mismatched after detection can be auto-synced despite the lossless-sync prohibition. Re-detect the named project harness/scope immediately before writing and proceed only if its current report remains stale/unknown and `losslessRefresh === true`; add a regression test for this revalidation path. `src/doctor/checks/harness-freshness.ts:119-157`

- **P1 — Re-validate the worktree mapping before clearing it** (`auto_fix`; `human_required: false`): `fix` only checks that the database file still exists, then unconditionally calls `upsertPlan(..., worktreePath: "", branch: "")`. If a concurrent attach repairs or changes the mapping after detection, doctor clears that valid mapping. Read the current row from the existing writable DB and only clear it when the same plan remains mapped to the detected missing path; otherwise return `attempted: false`. Add a regression test that changes the row between detection and repair. `src/doctor/checks/worktrees.ts:170-202`

- **P1 — Make Phase 5 unit tests deterministic under the configured concurrent runner** (`auto_fix`; `human_required: false`): the new `captureJson` helpers replace global `console.log` across awaited work. `bun test test/unit/doctor/ --concurrent` fails four new harness-freshness tests (including `syncs only when losslessRefresh`) because concurrent tests clobber each other's capture. The package test script and repository test policy require `--concurrent`; use an injectable output sink/return-value seam or serialize the affected tests rather than mutating global console state. `test/unit/doctor/harness-freshness.test.ts:151-168`

## Verification

- `bun run lint` — passed.
- `bun run typecheck` — passed.
- `bun test test/unit/doctor/` — 54 passed, 0 failed.
- `bun test test/unit/doctor/ --concurrent` — 50 passed, 4 failed (global console capture race).
- `git diff --check 7c5a15a455af71d0ea33e046e4ba5911ff400c5a^ 7c5a15a455af71d0ea33e046e4ba5911ff400c5a` — passed.

## Addendum — Re-review after `21f04671b345846c0a0c426856dc9a93142ef08b`

The harness repair now performs a fresh, named project-scope Tier-2 check before sync and writes only when the current state remains lossless and stale/unknown. The worktree repair now reads the current row, requires the detected path to still match, and refuses recovered paths before clearing anything. The Phase 5 tests no longer mutate global console state and the focused doctor suite passes under `--concurrent`.

**Readiness:** Ready.

**Items:** `[]`

### Verification

- `bun test test/unit/doctor/ --concurrent` — 56 passed, 0 failed.
- `bun run lint` — passed.
- `bun run typecheck` — passed.
- `git diff --check 21f04671b345846c0a0c426856dc9a93142ef08b^ 21f04671b345846c0a0c426856dc9a93142ef08b` — passed.
