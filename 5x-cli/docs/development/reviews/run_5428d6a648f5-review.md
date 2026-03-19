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
