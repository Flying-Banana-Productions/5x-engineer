# Track Commits in the Run Step Journal

**Version:** 1.1
**Created:** March 19, 2026
**Status:** Draft

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-19 | Initial draft |
| 1.1 | 2026-03-19 | Address review feedback: move commit responsibility to orchestrator (R1), add worktree safety note (R2), fix stderr/stdout handling (R3), add worktree test coverage (R4). See `reviews/5x-cli-docs-development-025-commit-tracking.plan-review.md`. |

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

**Agents do not commit directly.** Templates are updated to *remove* all
commit instructions from agents. Instead, the orchestrator calls
`5x commit` after each successful agent completion. This eliminates the
need to plumb `run_id` into agent templates, keeps commit logic centralized
in skill workflows, and opens the door for future non-git version control
contexts (though that is not in scope here). The `--commit` field in
`5x protocol emit author --complete` becomes optional to support this
pattern.

## Design Decisions

**Commits are steps, not a separate table.** The v4 migration consolidated
four tables into one unified `steps` journal. Adding a `commits` table
would go against that architectural direction. Commit metadata fits
naturally in `result_json` and benefits from existing step infrastructure
(phase association, timeline ordering, pagination via `run state`).

**`5x commit` is a top-level command, not `5x run commit`.** The
orchestrator reaches for this command directly — nesting it under `run`
adds verbosity for no benefit. The `--run` flag ties it to a run.

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

**Orchestrator owns commits, not agents.** Agents report
`result: "complete"` without a commit hash. The orchestrator then calls
`5x commit` to stage, commit, and record in the journal. This avoids
the need to inject `run_id` into agent templates and centralizes commit
logic in skill workflows where the orchestrator already has full run
context. Templates are simplified by removing commit instructions entirely.

**Worktree-based runs are safe with absolute paths.** Git worktrees share
the same repository object store with the main working tree. The `git add`
command with absolute paths works correctly from linked worktrees because
the paths resolve within the shared repository. The review-path concern
(R2 in the review) was investigated and found to be a non-issue:
`review_path` is an absolute path within the repository, and `git add`
with absolute paths from a linked worktree operates on the shared index
and object store. This was verified by testing `git add <absolute-path>`
from a linked worktree — it succeeds as long as the path is within the
repository's working tree or a linked worktree.

## Phase 1: `5x commit` command and protocol relaxation

**Completion gate:** `5x commit` creates a git commit, records a
`git:commit` step in the run journal, and returns a JSON envelope with
commit metadata. `--dry-run` shows what would happen without side effects.
`--files` and `--all-files` are mutually exclusive and one is required.
The `--commit` field on `5x protocol emit author --complete` is optional
(no longer required). All existing tests pass.

- [ ] **1a.** Create `src/commands/commit.ts` — Commander registration.
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

- [ ] **1b.** Create `src/commands/commit.handler.ts` — business logic.
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

- [ ] **1c.** Register the command in `src/bin.ts`:
  - Add `import { registerCommit } from "./commands/commit.js";`
  - Add `registerCommit(program);` in the registration block.

- [ ] **1d.** Add `COMMIT_FAILED` to the exit code map in `src/output.ts`
  if not already present. Map to exit code 1 (general error).

- [ ] **1e.** Relax the `--commit` requirement on
  `5x protocol emit author --complete`. In the protocol emit command
  handler (`src/commands/protocol.ts` or the relevant emit logic), make
  the `--commit` flag optional when `--complete` is passed. Agents may
  still provide a commit hash, but it is no longer required. Update any
  validation that currently errors on a missing `--commit` with
  `--complete` to allow it.

## Phase 2: Unit tests

**Completion gate:** Unit tests cover the handler's core paths: successful
commit + step recording, `--dry-run` both variants, mutual exclusion
validation, inactive run rejection, nothing-to-commit error, worktree
commit + recording. All tests pass under `bun test --concurrent`.

- [ ] **2a.** Create `test/unit/commands/commit.test.ts`. Tests call
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

- [ ] **2b.** Verify all tests pass: `bun test test/unit/commands/commit.test.ts`.

## Phase 3: Integration tests

**Completion gate:** Integration tests spawn `5x commit` as a subprocess
and verify stdout JSON envelopes, exit codes, and git state. All tests
pass under `bun test --concurrent`.

- [ ] **3a.** Create `test/integration/commands/commit.test.ts`. Tests
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

- [ ] **3b.** Verify all tests pass:
  `bun test test/integration/commands/commit.test.ts`.

## Phase 4: Update templates to remove commit instructions

**Completion gate:** All templates that previously instructed agents to
commit have those instructions removed. Agents focus on producing work
and reporting structured results without committing. The `--commit` field
in structured output is documented as optional. All existing tests pass.

- [ ] **4a.** Update author templates. In each of the following files,
  **remove** the "you MUST commit all changes to git" instruction block,
  the CRITICAL block about committing, and any `git add` / `git commit`
  instructions. Do NOT replace with `5x commit` — the orchestrator
  handles commits:
  - `src/templates/author-generate-plan.md` — remove commit instructions.
    The agent reports `result: "complete"` without a commit hash.
  - `src/templates/author-next-phase.md` — same removal.
  - `src/templates/author-fix-quality.md` — same removal.
  - `src/templates/author-process-plan-review.md` — same removal.
  - `src/templates/author-process-impl-review.md` — same removal.

  In all cases: the agent's structured output (`5x protocol emit author
  --complete`) no longer requires `--commit`. The agent reports completion
  and the orchestrator takes responsibility for committing.

- [ ] **4b.** Update reviewer templates. **Remove** the explicit
  `git add` + `git commit` commands. The orchestrator commits review
  artifacts after the reviewer completes:
  - `src/templates/reviewer-plan.md` — remove commit instructions.
  - `src/templates/reviewer-plan-continued.md` — same removal.
  - `src/templates/reviewer-commit.md` — same removal.

- [ ] **4c.** Update agent definitions in `src/harnesses/opencode/`:
  - `5x-code-author.md` — remove the "you must make a git commit"
    section. Clarify that the agent produces work and reports
    `result: "complete"` — the orchestrator handles committing.
  - `5x-plan-author.md` — same update.

## Phase 5: Update skills to add orchestrator-level `5x commit` calls

**Completion gate:** Skills that orchestrate agent workflows call
`5x commit` after each successful agent/reviewer completion step.
The old invariant "result: complete without a commit = invariant
violation" is removed — the orchestrator owns commits. All existing
tests pass.

- [ ] **5a.** Update `src/harnesses/opencode/skills/5x-phase-execution/SKILL.md`:
  - After each successful author completion (code implementation, quality
    fix), add an orchestrator step that calls
    `5x commit --run $RUN -m "<message>" --all-files --phase "$PHASE"`.
  - After each successful reviewer completion (plan review, impl review),
    add an orchestrator step that calls
    `5x commit --run $RUN --files $REVIEW_PATH -m "review: phase $PHASE"
    --phase "$PHASE"`.
  - Remove the fallback commit block (lines ~217-223, `git add` +
    `git commit` for uncommitted review files) — it is replaced by the
    orchestrator `5x commit` call above.
  - Remove any invariant language that treats "agent completed without a
    commit" as an error condition.

- [ ] **5b.** Update `src/harnesses/opencode/skills/5x/SKILL.md`:
  - Remove the invariant "`result: "complete"` without a commit =
    invariant violation". Replace with guidance that the orchestrator
    calls `5x commit` after each successful agent completion to record
    commits in the run journal.
  - Add a note that agents no longer commit directly — they report
    `result: "complete"` and the orchestrator is responsible for staging,
    committing, and journal recording via `5x commit`.

- [ ] **5c.** Update `src/harnesses/opencode/skills/5x-plan/SKILL.md`:
  - Remove the invariant about author producing a commit.
  - Add orchestrator-level `5x commit` calls after successful author
    plan generation and after successful author plan revision steps.

- [ ] **5d.** Update `src/harnesses/opencode/skills/5x-plan-review/SKILL.md`:
  - Remove the invariant about author revisions producing a commit.
  - Add orchestrator-level `5x commit` calls after successful author
    revision and after successful reviewer review steps.

- [ ] **5e.** Run full test suite: `bun test`. Verify template content
  tests (if any assert on specific template strings) still pass.

## Files Touched

| File | Change |
|------|--------|
| `src/commands/commit.ts` | **New** — Commander registration |
| `src/commands/commit.handler.ts` | **New** — business logic |
| `src/bin.ts` | Add `registerCommit` import and call |
| `src/output.ts` | Add `COMMIT_FAILED` to exit code map (if needed) |
| `src/commands/protocol.ts` (or relevant emit logic) | Make `--commit` optional on `--complete` |
| `src/templates/author-generate-plan.md` | Remove git commit instructions |
| `src/templates/author-next-phase.md` | Remove git commit instructions |
| `src/templates/author-fix-quality.md` | Remove git commit instructions |
| `src/templates/author-process-plan-review.md` | Remove git commit instructions |
| `src/templates/author-process-impl-review.md` | Remove git commit instructions |
| `src/templates/reviewer-plan.md` | Remove `git add`/`git commit` instructions |
| `src/templates/reviewer-plan-continued.md` | Remove `git add`/`git commit` instructions |
| `src/templates/reviewer-commit.md` | Remove `git add`/`git commit` instructions |
| `src/harnesses/opencode/5x-code-author.md` | Remove commit requirement |
| `src/harnesses/opencode/5x-plan-author.md` | Remove commit requirement |
| `src/harnesses/opencode/skills/5x-phase-execution/SKILL.md` | Add orchestrator `5x commit` calls, remove fallback commit |
| `src/harnesses/opencode/skills/5x/SKILL.md` | Replace commit invariant with orchestrator-owns-commits guidance |
| `src/harnesses/opencode/skills/5x-plan/SKILL.md` | Add orchestrator `5x commit` calls, remove agent commit invariant |
| `src/harnesses/opencode/skills/5x-plan-review/SKILL.md` | Add orchestrator `5x commit` calls, remove agent commit invariant |
| `test/unit/commands/commit.test.ts` | **New** — unit tests (incl. worktree case) |
| `test/integration/commands/commit.test.ts` | **New** — integration tests (incl. worktree case) |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `commit.test.ts` | Handler: commit+record, dry-run, validation, error paths, worktree commit |
| Integration | `commit.test.ts` | CLI: JSON envelopes, exit codes, git state, step in run state, worktree end-to-end |
| Regression | Full suite | Templates render, existing command behavior unchanged |

## Estimated Scope

| Phase | Size | Notes |
|-------|------|-------|
| Phase 1 | Medium | ~120 lines handler + ~30 lines registration + protocol relaxation |
| Phase 2 | Medium | ~220 lines test coverage (incl. worktree case) |
| Phase 3 | Medium | ~170 lines integration tests (incl. worktree case) |
| Phase 4 | Small | Template text removals across 8 files |
| Phase 5 | Small-Medium | Skill/agent updates across 6 files — adding `5x commit` orchestration |

## Not In Scope

- Schema migration — no new tables or columns needed
- `5x diff --run --phase` range-diff capability (future enhancement)
- Changes to `commitFiles()` in `src/git.ts` — it remains available for
  non-run-scoped usage
- Auto-discovery of active run from working directory (explicit `--run`
  only for v1)
- `--no-record` flag — use `git commit` directly if you don't want tracking
- Non-git version control backends — the orchestrator-owns-commits design
  opens the door for this, but it is not in scope for this plan
