# Review: Harness & Skills Uninstall Phase 4

**Review type:** commit `eb00e8ec58e019b36d0fd6a662bc13834f3219b5`
**Scope:** Phase 4 enhanced `5x harness list` changes in `src/commands/harness.handler.ts`, `src/commands/harness.ts`, and coverage in `test/unit/commands/harness.test.ts` plus `test/integration/commands/harness.test.ts`; incidental repo config changes in `5x.toml`
**Reviewer:** Staff engineer
**Local verification:** `bunx --bun tsc --noEmit` - passed; `bun test ./test/unit/commands/harness.test.ts ./test/integration/commands/harness.test.ts` - 45 passed

## Summary

The harness-list implementation itself is directionally good: the new data/output split matches the Phase 4 plan, installed-state detection works, and the targeted tests cover the main project-scope flows. I am not signing off this commit because it also changes `5x.toml` to point plan/review/archive paths at top-level `docs/...` locations that do not contain this feature's artifacts, which breaks the repo's 5x workflow configuration.

**Readiness:** Not ready - Phase 4 code is close, but the commit contains a blocking config regression outside the harness-list logic.

## Strengths

- `src/commands/harness.handler.ts` now has a clean two-layer `buildHarnessListData()` / `harnessList()` structure, which fits the existing handler architecture and makes unit testing straightforward.
- The list data shape matches the plan: source labeling comes from `loadHarnessPlugin()`, scopes are filtered by `plugin.supportedScopes`, and installed state is derived from known managed files only.
- Integration coverage now checks the JSON envelope contract and the installed/not-installed transitions after install and uninstall, which were the key externally visible Phase 4 behaviors.

## Production Readiness Blockers

### P1.1 - `5x.toml` paths no longer point at the actual plan/review directories

**Risk:** The commit changes `[paths]` from `5x-cli/docs/...` to `docs/...`, but this repo's active implementation plans and reviews for this work live under `5x-cli/docs/...`. That misroutes future 5x plan/review/archive operations, so the automation will read from and write to the wrong directories.

**Requirement:** Restore the repository path settings in `5x.toml` so they continue to reference the real artifact locations for this project, or move the artifacts in the same change if the config update is intentional. Classify fix action as `auto_fix`.

## High Priority (P1)

### P1.2 - Unrelated workflow-config churn is bundled into a Phase 4 harness-list commit

`5x.toml` also changes retry limits, removes the configured reviewer/author models, and drops the active quality gate entry. Even where those edits are not strictly broken, they are unrelated to the Phase 4 acceptance criteria and make this commit harder to validate and reason about. Revert the unrelated config churn or split it into a separate change with its own rationale. Classify fix action as `human_required`.

## Medium Priority (P2)

- `src/commands/harness.ts:4` still says the parent command has only `install` and `list` subcommands, which is now stale after adding `uninstall`. Update the module comment in a follow-up cleanup. Classify fix action as `auto_fix`.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Restore `5x.toml` path settings to the real repo artifact directories, or move the directories in the same change. (`auto_fix`)
- [ ] Remove or justify the unrelated `5x.toml` workflow-config churn from this Phase 4 commit. (`human_required`)
- [ ] Refresh the stale subcommand comment in `src/commands/harness.ts`. (`auto_fix`)
