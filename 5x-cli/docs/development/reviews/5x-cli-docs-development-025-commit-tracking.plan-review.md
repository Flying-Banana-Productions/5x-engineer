# Review: Track Commits in the Run Step Journal

**Review type:** `docs/development/025-commit-tracking.plan.md`
**Scope:** Plan review for `5x commit`, run-journal recording, template updates, and commit-tracking tests.
**Reviewer:** Staff engineer
**Local verification:** Source review plus local git/worktree behavior check (`git add <absolute-review-path>` from a linked worktree fails as outside-repository)

## Summary

The core direction is right: recording commits as normal `steps` fits the v4 journal model, and a run-scoped `5x commit` command is the right product surface. But the plan is not ready as written. It updates prompts to call `5x commit --run {{run_id}} ...` without plumbing `run_id` into those templates, and it preserves a review-file path model that breaks once the command executes inside mapped worktrees.

**Readiness:** not_ready - blocking template-contract and worktree-path issues remain.

## Strengths

- Reuses the existing unified `steps` journal instead of adding a parallel commits table.
- Orders the work sensibly: command first, then tests, then prompt/skill migrations.
- Keeps the safety invariant correct: only record `git:commit` after the git commit actually succeeds.

## Production Readiness Blockers

### P0.1 - Templates are updated to use `{{run_id}}`, but the plan does not add any way to render that variable

**Action:** `auto_fix`

**Risk:** Phase 4's prompt changes are not implementable as written. The targeted templates do not currently declare `run_id`, and template rendering only auto-injects `plan_path` / `review_path`-related internals. If the plan is followed literally, prompts will either render an unresolved `{{run_id}}` token or force ad hoc template-variable changes during implementation.

**Requirement:** Add explicit template-contract work for `run_id`: either declare/inject `run_id` for every author/reviewer template that will call `5x commit`, or choose a different invocation pattern that does not depend on a missing variable.

**Evidence:**
- Planned usage: `docs/development/025-commit-tracking.plan.md:237-256`
- Current template variables omit `run_id`: `src/templates/author-generate-plan.md:5`, `src/templates/author-next-phase.md:5`, `src/templates/author-process-plan-review.md:5`, `src/templates/reviewer-plan.md:5`
- Template rendering only auto-injects `plan_path` / internal vars, not `run_id`: `src/commands/template-vars.ts:350-375`

### P0.2 - Reviewer-path commits are not worktree-safe

**Action:** `human_required`

**Risk:** The plan replaces reviewer-side `git add {{review_path}}` with `5x commit --run ... --files {{review_path}}`, but `5x commit` is intentionally run-scoped and resolves its working directory through `resolveRunExecutionContext()`. `review_path` is auto-generated under the control-plane repo, while mapped runs execute in the linked worktree. Passing that absolute control-plane path to `git add` from the worktree fails as an outside-repository path, so reviewer commits will still break in worktree-backed runs.

**Requirement:** Make an explicit architectural choice for review-artifact commits in worktree mode: e.g. generate a worktree-local effective review path, re-root `review_path` before commit, or teach `5x commit` to translate repo-owned absolute paths into the effective worktree. Document that choice in the plan and cover it in tests.

**Evidence:**
- Reviewer template changes proposed here: `docs/development/025-commit-tracking.plan.md:252-260`
- Review paths are generated under configured review dirs, not worktree-relative: `src/commands/template-vars.ts:195-227`
- Run-scoped commands execute in the mapped worktree: `src/commands/run-context.ts:155-201`

## High Priority (P1)

### P1.1 - The planned `COMMIT_FAILED` message source is wrong for a clean worktree failure

**Action:** `auto_fix`

The handler plan says to surface `stderr` on commit failure, but `git commit -m ...` commonly reports "nothing to commit" on stdout, not stderr. That means the plan's own "nothing to commit" test can pass only if the implementation diverges from the documented flow.

**Recommendation:** Change the handler spec to surface `stderr || stdout` (or a normalized git-failure message) and add that expectation to the error-path tests.

**Evidence:**
- Planned behavior: `docs/development/025-commit-tracking.plan.md:116-123`
- `subprocess.execGit()` captures stdout and stderr separately: `src/utils/subprocess.ts:50-64`

### P1.2 - The test plan misses the most important run-scoped case: mapped worktrees

**Action:** `auto_fix`

The command's main architectural behavior is "commit in the effective working directory for the run," yet neither Phase 2 nor Phase 3 includes a mapped-worktree case. Without that coverage, the most failure-prone path in this design remains unverified.

**Recommendation:** Add at least one unit or integration test that creates a mapped worktree run, performs `5x commit`, and verifies both git state and `git:commit` journal recording from the worktree context.

## Medium Priority (P2)

- **Action:** `auto_fix` - Add `--` before explicit file lists in the documented `git add` invocations (`git add --dry-run -- <files>`, `git add -- <files>`). The current plan regresses the existing safety pattern in `src/git.ts:174` for filenames beginning with `-`.

## Readiness Checklist

**P0 blockers**
- [ ] Add explicit `run_id` template-variable plumbing for every prompt updated to call `5x commit`.
- [ ] Resolve how reviewer review files are mapped/staged when a run executes in a linked worktree.

**P1 recommended**
- [ ] Update the handler spec so `COMMIT_FAILED` surfaces stdout-backed git failures such as "nothing to commit".
- [ ] Add mapped-worktree coverage to the unit/integration test plan.

## Addendum (2026-03-19) - Review Round 2

### What's Addressed

- **R1 (missing `run_id` plumbing):** addressed by moving commit responsibility out of agent templates and into orchestrator skills. That removes the unresolved-template-variable problem entirely.
- **R3 (stdout vs stderr):** addressed. The handler spec now explicitly surfaces `stderr || stdout`, and the unit test plan names the `nothing to commit` stdout case.
- **R4 (mapped-worktree coverage):** addressed. The revised plan adds both a unit-level mapped-worktree commit case and an integration-level end-to-end mapped-worktree case.

### Remaining Concerns

- **P0 / `human_required`:** R2 is not actually resolved. The new design-decision note claims `git add <absolute-path>` from a linked worktree succeeds for repo-owned absolute paths, but local verification still shows the opposite: Git rejects an absolute path in the control-plane checkout as outside the linked worktree (`fatal: ... is outside repository at ...`). The original blocker remains for reviewer artifacts committed via `5x commit --run ... --files $REVIEW_PATH`. The plan still needs an explicit approach for mapping review files into the effective worktree or otherwise avoiding control-plane-root paths during run-scoped commits.
- **P1 / `auto_fix`:** The orchestrator-owns-commits change inventory is incomplete. Phase 1 only mentions relaxing `5x protocol emit author --complete`, but the current commit-required contract also lives in `src/commands/protocol-helpers.ts`, `src/protocol.ts`, `src/providers/opencode.ts`, `src/harnesses/opencode/5x-code-author.md`, and existing skill text that treats `complete` without a commit as an invariant violation. Phase 4/5 covers some prompt/skill updates, but the plan should explicitly include validator/provider/schema/help-text updates so the new contract is end-to-end consistent rather than only changing `emit`.

**Readiness:** not_ready
