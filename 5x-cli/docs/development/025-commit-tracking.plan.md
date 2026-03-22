# Track Commits in the Run Step Journal

**Version:** 1.5
**Created:** March 19, 2026
**Status:** Draft

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-19 | Initial draft |
| 1.1 | 2026-03-19 | Address review feedback: move commit responsibility to orchestrator (R1), add worktree safety note (R2), fix stderr/stdout handling (R3), add worktree test coverage (R4). See `reviews/5x-cli-docs-development-025-commit-tracking.plan-review.md`. |
| 1.2 | 2026-03-19 | Review cycle 2: fix worktree review-path re-rooting (R1 P0), enumerate all protocol relaxation sites (R2 P1). Replace false "worktree paths are safe" design decision. Add Phase 1f for review-path fix. Expand task 1e with full file list. |
| 1.3 | 2026-03-19 | Review cycle 3: add `src/providers/opencode.ts` commit-required prompt text to task 1e enumeration (P2). |
| 1.4 | 2026-03-19 | Design pivot: author owns commits via `5x commit`, not orchestrator. Revert protocol relaxation (1e). Add `run_id` template variable (1g). Rewrite Phase 4 (templates use `5x commit`) and Phase 5 (skills reflect author-owns-commits). |
| 1.5 | 2026-03-19 | Review cycle 4: fix "orchestrator reaches for command" contradiction, clarify Phase 4 template instructions, add `run_id` test coverage to Phase 2.

## Overview

During a 5x run, agents implement phases, fix quality issues, and revise
plans. The resulting git commits are invisible to the run journal — the
step history shows author/reviewer/quality steps but has no record of the
actual code changes produced. This makes it impossible to answer questions
like "what commits were made during phase 2?" or "show me the diff for
this run."

This plan adds a top-level `5x commit` command that atomically stages
files, creates a git commit, and records the commit as a `git:commit` step
in the run's step journal. No schema migration is needed — commits are
stored as regular steps using the existing `result_json` column.

**Agents commit via `5x commit`.** Templates are updated to replace raw
`git add` / `git commit` with `5x commit --run {{run_id}}`. This gives
agents the same pre-commit hook feedback loop they had before (hooks fire,
agent iterates in-session) while adding journal recording atomically.
The `--commit` field in `5x protocol emit author --complete` remains
required — agents report the commit hash produced by `5x commit`. The
`run_id` template variable is auto-populated from `--run` context.

## Design Decisions

**Commits are steps, not a separate table.** The v4 migration consolidated
four tables into one unified `steps` journal. Adding a `commits` table
would go against that architectural direction. Commit metadata fits
naturally in `result_json` and benefits from existing step infrastructure
(phase association, timeline ordering, pagination via `run state`).

**`5x commit` is a top-level command, not `5x run commit`.** Agents invoke
this command directly via `5x commit --run {{run_id}}`. Nesting it under
`run` adds verbosity for no benefit. The `--run` flag ties it to a run.

**File staging requires an explicit choice.** Either `--files <list>` or
`--all-files` must be provided — never implicit staging. This forces the
caller to reason about what changed and make a deliberate decision.

**`--dry-run` uses `git add --dry-run` for both paths.** Both
`--all-files --dry-run` and `--files <list> --dry-run` use the `git add`
dry-run variant, producing consistent output format with zero side effects.
`git commit --dry-run` was considered but its output is identical to
`git status` and would create a format mismatch between the two paths.

**Git commit fires before journal recording.** The git commit (including
any pre-commit / commit-msg hooks) must succeed before the step is
recorded in the journal. If hooks reject the commit, the command fails
early with no DB side effects. This prevents phantom journal entries for
commits that never landed.

**Step name convention is `git:commit`.** Follows the existing namespacing
pattern (`author:*`, `quality:check`, `event:*`). The `phase` column on
the step provides phase-level queryability without encoding it in the step
name.

**Author owns commits via `5x commit`.** Agents call `5x commit` directly
instead of raw `git commit`. This preserves the pre-commit hook feedback
loop — if hooks reject the commit, the agent sees the failure immediately
and can iterate in-session without orchestrator re-invocation. The
orchestrator validates that a commit hash is present in the author's
structured output (unchanged from before). The `run_id` is plumbed into
templates as an auto-populated variable so agents can call
`5x commit --run {{run_id}}`.

**Review paths are re-rooted to the worktree when a run has a mapped
worktree.** Git rejects `git add <absolute-path>` when the path is outside
the current worktree, even if the path belongs to the same repository's
main working tree. This means `review_path` (generated from
`config.paths.reviews`, which resolves under the control-plane root)
cannot be staged from a linked worktree. The fix: when a run has a mapped
worktree, `generateReviewPath()` re-roots the review directory relative
to the worktree. For example, if `config.paths.reviews` resolves to
`/project/docs/development/reviews/`, the path relative to the project
root is `docs/development/reviews/`, and the re-rooted path becomes
`/project/.5x/worktrees/feature/docs/development/reviews/`. This keeps
all work — code, plans, and reviews — inside the worktree branch until
merge. The `plan_path` is already re-rooted via
`resolveRunExecutionContext` → `ctx.effectivePlanPath`; the review path
gets the same treatment.

## Phase 1: `5x commit` command, `run_id` template variable, and worktree review-path fix

**Completion gate:** `5x commit` creates a git commit, records a
`git:commit` step in the run journal, and returns a JSON envelope with
commit metadata. `--dry-run` shows what would happen without side effects.
`--files` and `--all-files` are mutually exclusive and one is required.
The `--commit` field on `5x protocol emit author --complete` remains
required (no protocol relaxation). `run_id` is auto-populated as an
internal template variable when `--run` is provided. Review paths are
re-rooted to the worktree when a run has a mapped worktree. All existing
tests pass.

- [x] **1a.** Create `src/commands/commit.ts` — Commander registration.
  Top-level command `commit` on the parent program. Flags:
  - `-r, --run <id>` — required (`.requiredOption`)
  - `-m, --message <msg>` — required (`.requiredOption`)
  - `--files <paths...>` — variadic string list
  - `--all-files` — boolean flag
  - `--phase <phase>` — optional string
  - `--dry-run` — boolean flag
  Add mutual exclusion validation in `.action()`: error if both `--files`
  and `--all-files` are provided, error if neither is provided. Import and
  call `runCommit()` from `./commit.handler.js`.

- [x] **1b.** Create `src/commands/commit.handler.ts` — business logic.
  Export `CommitParams` interface and `async runCommit(params)` function.

  `CommitParams`:
  ```
  run: string
  message: string
  files?: string[]
  allFiles?: boolean
  phase?: string
  dryRun?: boolean
  startDir?: string   // for testability; defaults to run context resolution
  ```

  Handler flow:
  1. Call `resolveDbContext()` to get `db` and `controlPlane`.
  2. Call `resolveRunExecutionContext(db, params.run, { controlPlaneRoot })`
     to get the effective working directory (respects worktree mapping).
     Error if not ok.
  3. Validate run is `active` (the context resolver returns run status).
  4. **If `--dry-run`:**
     - If `--all-files`: run `git add -A --dry-run` in the effective
       working directory via `subprocess()`.
     - If `--files`: run `git add --dry-run -- <file1> <file2>...` in the
       effective working directory.
     - Output the dry-run result plus the step record shape that would be
       created, via `outputSuccess()`.
     - Return (no git or DB side effects).
  5. **Stage files:**
     - If `--all-files`: run `git add -A` in the effective working
       directory.
     - If `--files`: run `git add -- <file1> <file2>...` in the effective
       working directory.
  6. **Commit:** run `git commit -m <message>` in the effective working
     directory. This fires any configured git hooks (pre-commit,
     commit-msg, etc.). If the commit fails for any reason — hooks
     reject it, nothing to commit, or any other git error — surface the
     failure message from `stderr || stdout` (git reports some errors
     like "nothing to commit" on stdout, not stderr) and call
     `outputError("COMMIT_FAILED", stderr || stdout)` immediately. No
     step is recorded in the journal. This fail-early ordering is
     critical: the journal must never contain a `git:commit` step for a
     commit that doesn't exist in git history.
  7. **Read commit metadata:**
     - Hash via `git rev-parse HEAD`.
     - Short hash via `git rev-parse --short HEAD`.
     - File list via `git diff-tree --no-commit-id --name-only -r HEAD`.
  8. **Record step:** call `recordStepInternal()` with:
     - `run: params.run`
     - `stepName: "git:commit"`
     - `phase: params.phase`
     - `result: JSON.stringify({ hash, short_hash, message, files })`
  9. **Output:** `outputSuccess({ hash, short_hash, message, files,
     run_id, step_id }, textFormatter)`.

  Text formatter: print a concise summary like
  `[<short_hash>] <message> (<N> files)`.

  Use `subprocess()` from `src/utils/subprocess.ts` for all git calls
  (it already strips `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`).

  Note: All `git add` invocations with explicit file lists use `--` before
  the file list to prevent filenames beginning with `-` from being
  interpreted as flags (consistent with existing pattern in `src/git.ts`).

- [x] **1c.** Register the command in `src/bin.ts`:
  - Add `import { registerCommit } from "./commands/commit.js";`
  - Add `registerCommit(program);` in the registration block.

- [x] **1d.** Add `COMMIT_FAILED` to the exit code map in `src/output.ts`
  if not already present. Map to exit code 1 (general error).

- [x] **1e.** Revert the protocol relaxation changes. The `--commit` field
  on `5x protocol emit author --complete` remains required. Restore the
  original behavior across these files:

  1. **`src/commands/protocol-emit.handler.ts` lines 220-225** — Restore
     the hard error that rejects `--complete` without `--commit`. The
     `if (result === "complete" && !commit)` block should be restored.
  2. **`src/commands/protocol-emit.handler.ts` lines 245-246** — Change
     `requireCommit: false` back to
     `requireCommit: normalized.result === "complete"` in both stdin and
     flag paths.
  3. **`src/commands/protocol.ts` line 196** — Update the help text from
     `"Git commit hash (optional)"` back to
     `"Git commit hash (required with --complete)"`.
  4. **`src/commands/protocol-helpers.ts` line 97** — Change
     `const requireCommit = opts.requireCommit === true;` back to
     `const requireCommit = opts.requireCommit !== false;` so the default
     is `true` (require commit) rather than `false`.
  5. **`src/providers/opencode.ts` lines 148-156** — Restore the original
     prompt text: "If result is complete, you MUST include the commit hash."

- [x] **1f.** Fix review-path generation for worktree-mapped runs.
  (Keep as-is — unchanged from v1.3)

- [x] **1g.** Add `run_id` as an internal template variable. The `run_id`
  from the `--run` flag is not currently exposed to templates. Add it
  to `resolveInternalTemplateVariables()` so authors can reference
  `{{run_id}}` in their commit commands.

  Changes:

  1. **`src/commands/template-vars.ts`** — In `resolveInternalTemplateVariables()`,
     add `run_id` to `internalVars` when `runId` is provided:
     ```
     if (runId) {
       internalVars.run_id = runId;
     }
     ```
     Also add `run_id` to `ResolveAndRenderOptions` interface for consistency.

  2. **`src/commands/template.handler.ts`** — Pass `resolvedRunId` through
     to `resolveAndRenderTemplate()` (already flows via `params.run`).

  3. **`src/commands/invoke.handler.ts`** — Pass `run_id` through
     to `resolveAndRenderTemplate()` when rendering agent prompts.

## Phase 2: Unit tests

**Completion gate:** Unit tests cover the handler's core paths: successful
commit + step recording, `--dry-run` both variants, mutual exclusion
validation, inactive run rejection, nothing-to-commit error, worktree
commit + recording, review-path re-rooting. All tests pass under
`bun test --concurrent`.

- [x] **2a.** Create `test/unit/commands/commit.test.ts`. Tests call
  `runCommit()` directly with a `startDir` temp directory containing a
  git repo. Setup helper:
  - Create temp dir, `git init`, configure `user.name`/`user.email`,
    create an initial commit.
  - Create a run in the DB via `createRunV1()`.

  Test cases:
  1. **Commit with `--all-files`** — create a file in the temp repo,
     call `runCommit({ run, message, allFiles: true })`. Verify: git log
     shows the commit, step recorded in DB with `step_name: "git:commit"`
     and `result_json` containing hash, message, files.
  2. **Commit with `--files`** — create two files, commit with only one
     specified. Verify: only the specified file is in the commit, the
     other remains unstaged.
  3. **`--dry-run` with `--all-files`** — verify no commit is created,
     no step recorded, output contains expected file list.
  4. **`--dry-run` with `--files`** — same verification with explicit
     file list.
  5. **Neither `--files` nor `--all-files`** — verify validation error.
  6. **Both `--files` and `--all-files`** — verify validation error.
  7. **Run not active** — complete the run first, then attempt commit.
     Verify error.
  8. **Nothing to commit** — call with `--all-files` on a clean worktree.
     Verify `COMMIT_FAILED` error with a meaningful message (the
     "nothing to commit" text from git stdout is surfaced, not empty
     stderr).
  9. **Phase recorded** — commit with `--phase 2`, verify step has
     `phase: "2"`.
  10. **Hook failure prevents journal recording** — install a
      `pre-commit` hook that exits non-zero in the temp repo. Create a
      file, attempt `runCommit()`. Verify: `COMMIT_FAILED` error, no
      commit in git log, no `git:commit` step in the DB.
  11. **Mapped worktree commit** — create a run with a mapped worktree
      (via `git worktree add`), create a file in the worktree, call
      `runCommit()` with the run ID. Verify: the commit is created in
      the worktree's branch, `git:commit` step is recorded in the DB
      with correct hash, and `git log` in the worktree shows the commit.

  Note: The handler needs a `startDir` parameter for testability (same
  pattern as `initScaffold`, `runDiff`). Add this to `CommitParams` as an
  optional field, defaulting to resolving from the run context.

- [x] **2b.** Create review-path re-rooting unit tests in
  `test/unit/commands/template-vars.test.ts` (or add to the existing
  file if one exists). Tests call `resolveInternalTemplateVariables()`
  directly.

  Test cases:
  1. **Review path without worktree** — call with no `worktreeRoot`.
     Verify: `review_path` resolves under `projectRoot` as before.
  2. **Review path with worktree** — call with `worktreeRoot` set to a
     temp worktree path. Verify: `review_path` is re-rooted to the
     worktree (e.g., `/worktree/docs/reviews/plan-review.md` instead of
     `/project/docs/reviews/plan-review.md`).
  3. **Plan review path with worktree** — same test using a plan-review
     template name. Verify: the `planReviews` config path is re-rooted.
  4. **Explicit review_path not re-rooted** — when `review_path` is
     provided via explicit vars, it should NOT be re-rooted (explicit
     always wins).
  5. **`run_id` variable populated** — call with `runId` set. Verify:
     `run_id` appears in the resolved variables with the correct value.
  6. **`run_id` variable absent when not provided** — call without `runId`.
     Verify: `run_id` is not present in resolved variables.

- [x] **2c.** Add `run_id` template integration tests. Create a new file
  `test/integration/commands/template-render.test.ts` or add to an existing
  template-related integration test file. Spawn `5x template render --run <id>
  author-next-phase` and verify the JSON output includes `run_id` in the
  `variables` object with the correct run ID.

- [x] **2d.** Verify all tests pass:
  `bun test test/unit/commands/commit.test.ts`,
  `bun test test/unit/commands/template-vars.test.ts`, and
  the relevant template integration test file from 2c.

## Phase 3: Integration tests

**Completion gate:** Integration tests spawn `5x commit` as a subprocess
and verify stdout JSON envelopes, exit codes, and git state. All tests
pass under `bun test --concurrent`.

- [x] **3a.** Create `test/integration/commands/commit.test.ts`. Tests
  spawn the CLI binary via `Bun.spawnSync`. Setup:
  - Create temp dir with git repo and `5x init`.
  - Create a run via `5x run init --plan <path>`.
  - Use `cleanGitEnv()` for all spawns, `stdin: "ignore"`, per-test
    `timeout: 15000`.

  Test cases:
  1. **Happy path with `--all-files`** — create a file, run
     `5x commit --run <id> -m "test" --all-files`. Verify: exit 0,
     JSON envelope has `ok: true`, `data.hash` is a valid SHA,
     `data.files` includes the created file.
  2. **Happy path with `--files`** — same but with explicit file list.
  3. **`--dry-run`** — verify exit 0, no commit in git log, JSON output
     contains expected preview.
  4. **Missing `--files` and `--all-files`** — verify non-zero exit,
     error envelope.
  5. **`--text` mode** — verify human-readable output format.
  6. **Step appears in `5x run state`** — after commit, run
     `5x run state --run <id>` and verify `git:commit` step is present.
  7. **Hook failure** — install a `pre-commit` hook that exits 1.
     Run `5x commit`. Verify: non-zero exit, error envelope with
     `COMMIT_FAILED`, no step in `5x run state`.
  8. **Mapped worktree end-to-end** — create a linked worktree via
     `git worktree add`, create a run mapped to that worktree, create a
     file in the worktree, run `5x commit --run <id> -m "test"
     --all-files`. Verify: exit 0, commit exists in the worktree branch,
     `git:commit` step appears in `5x run state`.

- [x] **3b.** Verify all tests pass:
  `bun test test/integration/commands/commit.test.ts`.

## Phase 4: Update templates to use `5x commit`

**Completion gate:** All templates that previously used raw `git add` /
`git commit` now use `5x commit --run {{run_id}}`. The `run_id` variable
is declared in each template's frontmatter. Agents preserve the pre-commit
hook feedback loop by calling `5x commit` directly. All existing tests pass.

- [x] **4a.** Update author templates. The author templates don't currently
  show the actual `git add`/`git commit` commands — they only have a
  CRITICAL section stating that changes must be committed. Update each
  of the following files to:
  1. Add `run_id` to the `variables:` frontmatter declaration.
  2. **In the Completion section**, add explicit instructions showing
     the `5x commit` command to use:
     ```
     When ready to commit, run:

         5x commit --run {{run_id}} -m "<descriptive message>" --all-files

     Then produce your structured result:

         5x protocol emit author --complete --commit <hash>
     ```
  3. Keep and update the CRITICAL section to reference `5x commit`:
     "CRITICAL: You MUST commit all changes using `5x commit` before finishing..."

  Templates to update:
  - `src/templates/author-generate-plan.md`
  - `src/templates/author-next-phase.md`
  - `src/templates/author-fix-quality.md`
  - `src/templates/author-process-plan-review.md`
  - `src/templates/author-process-impl-review.md`

- [x] **4b.** Update reviewer templates. Replace `git add` + `git commit`
  with `5x commit`:
  - `src/templates/reviewer-plan.md` — replace with `5x commit --run {{run_id}} --files {{review_path}} -m "docs: add plan review"`.
  - `src/templates/reviewer-plan-continued.md` — use `5x commit --run {{run_id}} --files {{review_path}} -m "docs: update plan review"`.
  - `src/templates/reviewer-commit.md` — use `5x commit --run {{run_id}} --files {{review_path}} -m "review: <phase or context summary>"`.

  Add `run_id` to each template's `variables:` frontmatter.

- [x] **4c.** Update agent definitions in `src/harnesses/opencode/`:
  - `5x-code-author.md` — update the "you must make a git commit"
    section to reference `5x commit --run {{run_id}} --all-files`. Keep
    the invariant — agents still commit, just via the tracked command.
  - `5x-plan-author.md` — same update.

## Phase 5: Update skills to reflect author-owns-commits

**Completion gate:** Skills reflect that agents call `5x commit` directly.
The old "agent must commit" invariants stay — they just reference the
`5x commit` command. No orchestrator-level commit calls are added. All
existing tests pass.

- [ ] **5a.** Update `src/harnesses/opencode/skills/5x-phase-execution/SKILL.md`:
  - Keep the "After author completes" sections unchanged — they already
    reference the author producing a commit.
  - Update any prose that mentions `git commit` to mention `5x commit`.
  - **Keep** the fallback commit block (lines ~217-223) — it should now
    use `5x commit` instead of `git add` + `git commit`.
  - Keep the invariant language — "result: complete without a commit"
    is still an error, but now the commit is produced via `5x commit`.

- [ ] **5b.** Update `src/harnesses/opencode/skills/5x/SKILL.md`:
  - Keep the "`result: "complete"` without a commit = invariant violation"
    guidance — agents still commit.
  - Update the delegation example prose to reference `5x commit` instead
    of raw git commands.
  - Keep the note that agents commit and report the hash.

- [ ] **5c.** Update `src/harnesses/opencode/skills/5x-plan/SKILL.md`:
  - Keep the invariant about author producing a commit.
  - Update any `git commit` references to `5x commit`.

- [ ] **5d.** Update `src/harnesses/opencode/skills/5x-plan-review/SKILL.md`:
  - Keep the invariant about author revisions producing a commit.
  - Update any `git commit` references to `5x commit`.

- [ ] **5e.** Run full test suite: `bun test`. Verify template content
  tests (if any assert on specific template strings) still pass.

## Files Touched

| File | Change |
|------|--------|
| `src/commands/commit.ts` | **New** — Commander registration |
| `src/commands/commit.handler.ts` | **New** — business logic |
| `src/bin.ts` | Add `registerCommit` import and call |
| `src/output.ts` | Add `COMMIT_FAILED` to exit code map (if needed) |
| `src/commands/protocol-emit.handler.ts` | **Revert** protocol relaxation — restore `--commit` required check (lines 220-225), restore `requireCommit: normalized.result === "complete"` (lines 245-246) |
| `src/commands/protocol.ts` | **Revert** help text from "(optional)" to "(required with --complete)" (line 196) |
| `src/commands/protocol-helpers.ts` | **Revert** `requireCommit` default back to `true` — `opts.requireCommit !== false` (line 97) |
| `src/commands/protocol.handler.ts` | No change — passthrough stays as-is |
| `src/protocol.ts` | No change — `assertAuthorStatus` works with reverted callers |
| `src/providers/opencode.ts` | **Revert** prompt text — restore "you MUST include the commit hash" (lines 148-156) |
| `src/commands/template-vars.ts` | Add `run_id` to internal variables; add `worktreeRoot` param for review_path re-rooting |
| `src/commands/template.handler.ts` | Pass `run_id` and `worktreeRoot` to template resolution |
| `src/commands/invoke.handler.ts` | Pass `run_id` and `worktreeRoot` to template resolution |
| `src/templates/author-generate-plan.md` | Replace `git add`/`git commit` with `5x commit --run {{run_id}}` |
| `src/templates/author-next-phase.md` | Replace `git add`/`git commit` with `5x commit --run {{run_id}}` |
| `src/templates/author-fix-quality.md` | Replace `git add`/`git commit` with `5x commit --run {{run_id}}` |
| `src/templates/author-process-plan-review.md` | Replace `git add`/`git commit` with `5x commit --run {{run_id}}` |
| `src/templates/author-process-impl-review.md` | Replace `git add`/`git commit` with `5x commit --run {{run_id}}` |
| `src/templates/reviewer-plan.md` | Replace `git add`/`git commit` with `5x commit --run {{run_id}} --files {{review_path}}` |
| `src/templates/reviewer-plan-continued.md` | Replace `git add`/`git commit` with `5x commit --run {{run_id}} --files {{review_path}}` |
| `src/templates/reviewer-commit.md` | Replace `git add`/`git commit` with `5x commit --run {{run_id}} --files {{review_path}}` |
| `src/harnesses/opencode/5x-code-author.md` | Update prose to reference `5x commit --run {{run_id}}` |
| `src/harnesses/opencode/5x-plan-author.md` | Update prose to reference `5x commit --run {{run_id}}` |
| `src/harnesses/opencode/skills/5x-phase-execution/SKILL.md` | Update fallback commit block to use `5x commit`, keep author invariants |
| `src/harnesses/opencode/skills/5x/SKILL.md` | Update examples to reference `5x commit`, keep commit invariants |
| `src/harnesses/opencode/skills/5x-plan/SKILL.md` | Update examples to reference `5x commit`, keep commit invariants |
| `src/harnesses/opencode/skills/5x-plan-review/SKILL.md` | Update examples to reference `5x commit`, keep commit invariants |
| `test/unit/commands/commit.test.ts` | **New** — unit tests (incl. worktree case) |
| `test/unit/commands/template-vars.test.ts` | **New or expanded** — review-path re-rooting tests |
| `test/integration/commands/commit.test.ts` | **New** — integration tests (incl. worktree case) |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `commit.test.ts` | Handler: commit+record, dry-run, validation, error paths, worktree commit |
| Unit | `template-vars.test.ts` | Review-path re-rooting: with/without worktree, plan vs impl review, explicit override |
| Integration | `commit.test.ts` | CLI: JSON envelopes, exit codes, git state, step in run state, worktree end-to-end |
| Regression | Full suite | Templates render, existing command behavior unchanged |

## Estimated Scope

| Phase | Size | Notes |
|-------|------|-------|
| Phase 1 | Medium-Large | ~120 lines handler + ~30 lines registration + **revert** protocol relaxation across 4 files + add `run_id` template variable (~20 lines) + review-path re-rooting (~30 lines) |
| Phase 2 | Medium | ~220 lines commit tests + ~60 lines review-path tests |
| Phase 3 | Medium | ~170 lines integration tests (incl. worktree case) |
| Phase 4 | Small | Template updates across 8 files — replace `git commit` with `5x commit` |
| Phase 5 | Small | Skill/agent prose updates across 6 files — keep invariants, reference `5x commit` |

## Not In Scope

- Schema migration — no new tables or columns needed
- `5x diff --run --phase` range-diff capability (future enhancement)
- Changes to `commitFiles()` in `src/git.ts` — it remains available for
  non-run-scoped usage
- Auto-discovery of active run from working directory (explicit `--run`
  only for v1)
- `--no-record` flag — use `git commit` directly if you don't want tracking
- Non-git version control backends — author-owns-commits design preserves
  the git-centric workflow, though `5x commit` abstracts the details
