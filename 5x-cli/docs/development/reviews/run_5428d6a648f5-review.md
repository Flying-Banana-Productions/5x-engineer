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

## Addendum (2026-03-22) - Phase 3 integration tests

**Review type:** commit `690e431f0bac6943ef9060faa100bb4707557cf4`
**Scope:** Phase 3 integration coverage for `5x commit`
**Local verification:** `bun test test/integration/commands/commit.test.ts` - passed (8 tests); `bun test --concurrent test/integration/commands/commit.test.ts` - passed (8 tests)

### Assessment

- The new `test/integration/commands/commit.test.ts` covers all eight Phase 3 scenarios: `--all-files`, `--files`, `--dry-run`, missing staging mode, `--text`, `run state` journaling, hook rejection, and mapped-worktree end-to-end behavior.
- The suite follows the repo's integration-test safety conventions: every git or CLI subprocess uses `cleanGitEnv()`, every spawn sets `stdin: "ignore"`, and each subprocess-spawning test declares an explicit timeout.
- Coverage is strongest where it matters most for this feature: the hook-failure case confirms no `git:commit` step is recorded on git rejection, and the mapped-worktree case validates the run-context indirection at the CLI boundary instead of only in unit tests.

### Remaining Concerns

- The fixture setup hand-creates `.5x/` instead of running the planned `5x init` bootstrap step. The tests still pass and exercise `5x commit`, but they no longer validate the exact end-to-end project setup path the Phase 3 plan called for. **Action:** `auto_fix`
- The shared CLI helper uses `Bun.spawn(...)` plus awaited streams instead of the planned `Bun.spawnSync(...)`. This is not a correctness bug and remains concurrency-safe here, but it is a plan-compliance drift worth normalizing for consistency with the documented Phase 3 setup. **Action:** `auto_fix`

## Addendum (2026-03-22) - Phase 4 template updates

**Review type:** commit `5a2e02958c9c31afef4bdf0fec21c7a3d3d9e426`
**Scope:** Phase 4 template and agent-definition updates for `5x commit`
**Local verification:** `bun test test/integration/commands/template-render.test.ts` - passed (35 tests)

### Assessment

- The five author templates now declare `run_id`, update their CRITICAL language to require `5x commit`, and include the explicit `5x commit --run {{run_id}} -m "<descriptive message>" --all-files` completion flow required by 4a.
- The three reviewer templates now declare `run_id` and replace raw `git add` / `git commit` instructions with `5x commit --run {{run_id}} --files {{review_path}} ...`, matching 4b.
- `src/harnesses/opencode/5x-code-author.md` preserves the commit-required invariant while swapping the instructions over to `5x commit`, which is the right shape for 4c.

### Remaining Concerns

- `src/harnesses/opencode/5x-plan-author.md:21` still defines `commit` as optional and says `result: "complete"` only needs a commit "if required," then the new prose says "When your task requires committing changes...". That does not satisfy Phase 4c's "keep the invariant" requirement and leaves the plan author contract inconsistent with the updated author templates and protocol validation. Make this agent definition explicitly require a commit for `result: "complete"`, parallel to `src/harnesses/opencode/5x-code-author.md`. **Action:** `auto_fix`

## Addendum (2026-03-22) - Phase 4 re-review

**Review type:** commit `ce81213`
**Scope:** Verify R1 fix in `src/harnesses/opencode/5x-plan-author.md`

### Assessment

- `src/harnesses/opencode/5x-plan-author.md` now matches the required-commit pattern in `src/harnesses/opencode/5x-code-author.md`: the schema marks `commit` as required when `result` is `complete`, the bullet text says a commit must be included, and the Important section requires `5x commit --run {{run_id}} -m "<descriptive message>" --all-files` before reporting completion.
- R1 is resolved. No remaining Phase 4 blocking issues.

## Addendum (2026-03-22) - Phase 5 skill updates

**Review type:** commit `4ac496e18464fb787ef4572a59a334b3bd5e8aa3`
**Scope:** Phase 5 skill updates for author-owned commits
**Local verification:** `bun test` - passed (1646 tests, 1 skipped)

### Assessment

- All four required skill files were updated in this commit: `src/harnesses/opencode/skills/5x-phase-execution/SKILL.md`, `src/harnesses/opencode/skills/5x/SKILL.md`, `src/harnesses/opencode/skills/5x-plan/SKILL.md`, and `src/harnesses/opencode/skills/5x-plan-review/SKILL.md`.
- `src/harnesses/opencode/skills/5x-phase-execution/SKILL.md` keeps the existing complete-without-commit invariant, updates the fallback reviewer-commit block to `5x commit --run $RUN ... --files $REVIEW_PATH`, and adds `5x commit` to the tool list, matching 5a.
- `src/harnesses/opencode/skills/5x/SKILL.md`, `src/harnesses/opencode/skills/5x-plan/SKILL.md`, and `src/harnesses/opencode/skills/5x-plan-review/SKILL.md` preserve the commit-required invariants while making the prose explicitly refer to commits being produced via `5x commit`, matching 5b-5d.
- I found no lingering `git add` / `git commit` instructions in those four skill files, and this commit does not introduce any orchestrator-level raw git commit flow.

### Remaining Concerns

- No blocking issues found. Phase 5 is complete.
