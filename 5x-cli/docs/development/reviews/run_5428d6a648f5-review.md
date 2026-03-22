# Review: 025-commit-tracking Phase 1

**Review type:** commit `995e311d75653f8486a6c4907b8d01d8e05843a7`
**Scope:** Phase 1 implementation of `5x commit`, protocol commit-optional relaxation, and worktree review-path re-rooting
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/commands/protocol-emit.test.ts test/unit/commands/protocol-helpers.test.ts test/unit/commands/protocol-validate.test.ts` - passed (115 tests); `bun test test/integration/commands/protocol-emit.test.ts` - passed (9 tests)

## Summary

Phase 1 lands the new top-level command in the right architectural layer, threads worktree-aware review-path rendering through both template entry points, and updates the author protocol contract consistently across runtime/help/provider prompt surfaces. Main gap: `5x commit` resolves the run context against one control-plane, then records the `git:commit` step through `recordStepInternal()` without passing that same DB/root context, so the journal write can target the wrong DB and fail after the git commit has already landed.

**Readiness:** Ready with corrections - core Phase 1 shape is correct, but `5x commit` still has two mechanical correctness gaps before it is safe to use as the orchestrator's source of truth.

## Strengths

- Command architecture is aligned with the plan: `src/commands/commit.ts` is a thin commander adapter and `src/commands/commit.handler.ts` contains the business logic.
- Protocol relaxation is applied consistently across emit/help/validation/prompt surfaces, and the updated protocol tests pass in both unit and integration coverage.
- Review-path re-rooting is wired through both `template.handler` and `invoke.handler`, which is the right place to keep template generation worktree-aware.

## Production Readiness Blockers

None.

## High Priority (P1)

### P1.1 - `5x commit` can write the git commit and then record against the wrong DB

**Risk:** `runCommit()` resolves the correct control-plane via `params.startDir`, but the later `recordStepInternal()` call re-resolves DB context from process cwd instead of the already-resolved run context. In direct-call usage (the exact testability path the plan requires) or any future non-cwd caller, the git commit can succeed and the journal write can fail with `RUN_NOT_FOUND` or hit the wrong control-plane, leaving an untracked real commit.

**Requirement:** Keep commit recording on the same resolved DB/control-plane that `runCommit()` used for context resolution. Thread the resolved DB/root into step recording, or add a `recordStepInternal` variant that accepts an existing DB/context instead of re-discovering it.

**Action:** `auto_fix`

### P1.2 - `--dry-run` reports success even when `git add --dry-run` fails

**Risk:** The dry-run branch ignores `dryResult.exitCode` and always emits a success envelope. Invalid pathspecs or other git-add failures therefore look like a clean preview, which makes the command misleading exactly when the caller is trying to validate staging behavior safely.

**Requirement:** Treat non-zero `git add --dry-run` exit codes as command failures, mirroring the real staging path. Surface the git error text rather than returning `ok: true`.

**Action:** `auto_fix`

## Medium Priority (P2)

- **P2.1 - New Phase 1 behavior still lacks its own targeted tests.** This commit updates only protocol tests; the new `commit` command and the review-path re-rooting change have no unit or integration coverage yet, so the main risks in this phase remain unpinned until Phase 2/3 lands. **Action:** `auto_fix`

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Keep `git:commit` step recording anchored to the same resolved DB/control-plane used by `runCommit()`.
- [ ] Fail `--dry-run` when `git add --dry-run` returns a non-zero exit code.
- [ ] Add the planned command and review-path tests before relying on this flow in later phases.

## Addendum (2026-03-22) - Phase 1 closeout

### What's Addressed

- `runCommit()` now passes the already-resolved DB/control-plane into `recordStepInternal()`, and `recordStepInternal()` accepts that injected context, so git commits and journal writes stay on the same control-plane.
- The `--dry-run` path now checks `git add --dry-run` exit status and fails with `COMMIT_FAILED` instead of emitting a false success envelope.
- Targeted unit coverage now exists for `commit.handler` core paths and for review-path re-rooting, including the new `run_id` internal template variable.
- Commit `4752f65` correctly reverts the protocol relaxation across emit validation, helper defaults, CLI help text, provider prompt text, and the affected protocol tests.
- `run_id` is now threaded into shared template-variable resolution, matching the Phase 1 requirement for `{{run_id}}` support in later template updates.

### Remaining Concerns

- No new blocking concerns. Phase 1 is ready to close; remaining `5x commit` subprocess coverage and template-render integration coverage belong to the planned Phase 2/3 test work, not this phase gate.

## Addendum (2026-03-22) - Phase 2 unit tests

**Review type:** commit `f2d25b9507789ec9a6dbe932ddaf18f752f1c510`
**Scope:** Phase 2 test coverage for `commit.handler`, template-variable re-rooting, and `run_id` template integration
**Local verification:** `bun test test/unit/commands/commit.test.ts` - passed (12 tests); `bun test test/unit/commands/template-vars.test.ts` - passed (21 tests); `bun test test/integration/commands/template-render.test.ts` - passed (35 tests); `bun test --concurrent test/unit/commands/commit.test.ts test/unit/commands/template-vars.test.ts test/integration/commands/template-render.test.ts` - passed (68 tests)

### Assessment

- Phase 2 matches the plan's intended coverage. `test/unit/commands/commit.test.ts` now covers all 11 named cases from 2a, plus the earlier dry-run failure regression path, without relying on CLI-layer validation.
- `test/unit/commands/template-vars.test.ts` covers the six 2b cases directly: review-path behavior with and without worktrees, plan-review re-rooting, explicit override precedence, and `run_id` present/absent behavior.
- `test/integration/commands/template-render.test.ts` adds the planned `run_id` rendering checks and verifies both the positive and no-`--run` cases at the CLI boundary.
- The tests follow repo conventions for subprocess isolation (`cleanGitEnv()`, `stdin: "ignore"`, per-test timeouts) and are safe under concurrent execution.

### Remaining Concerns

- No blocking issues found in Phase 2. This work is ready to advance to Phase 3 integration coverage.
