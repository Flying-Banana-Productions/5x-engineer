# Operations and recovery

[README](../README.md) · [CLI reference](cli-reference.md) · [Upgrading](upgrading.md)

## Inspect progress

```bash
5x plan list --text
5x plan list --exclude-finished --text
5x plan phases docs/development/my-feature.md --text
5x run list --text
5x run state --run <id> --text
5x run state --plan docs/development/my-feature.md --text
5x run watch --run <id> --human-readable
```

Run state includes history, step-budget usage, and applicable review-budget and
implementation-governance details. `--tail <n>` and `--since-step <id>` reduce the
history returned. `run watch` streams worker logs; `invoke --stderr` also enables
provider output when the calling terminal is not a TTY.

Invocation status has a separate explicit identity contract:

```bash
5x invoke status --run <id>
5x invoke status --id <invocation-uuid>
5x invoke cancel <invocation-uuid>
```

Cancellation is provider-capability dependent. Unsupported cancellation is
rejected without changing run status; the registry is not a promise that every
local provider process can currently be cancelled through this command.

## Select a run

For commands using ambient identity, precedence is:

1. Explicit `--run <id>`.
2. `FIVEX_RUN` in the process environment.
3. A unique active run mapped to the current linked worktree.
4. A compatible `current-run` pointer in the control-plane state directory.
5. Piped `run_id`, for invoke/record commands that support it.

`run init` writes the pointer. For a shell session, explicitly selecting a run
avoids relying on a shared pointer:

```bash
export FIVEX_RUN=<run-id>
5x run state --text
```

Invalid, stale, incompatible, or ambiguous context produces a typed error; a
higher-precedence error is not silently bypassed. Piped context does not override
the environment. Use explicit IDs in scripts coordinating multiple runs, queue
workers, and invocation-registry operations. Some governance actions also require
explicit `--run`; inspect their help.

## Git-aware plan discovery

`plan list`, `plan phases`, and `run state --plan` can inspect progress without
switching branches. Discovery considers working copies, mapped worktrees, local
and remote-tracking `5x/*` branches, and `plans.branch` when configured.

```bash
5x plan list --fetch --text            # Explicitly refresh remote 5x refs
5x plan list --all-refs --text         # Include other branch candidates
5x plan phases <path> --source local   # Exactly the supplied local file
5x plan phases <path> --ref main       # Committed snapshot at this ref
5x plan list --ref origin/5x/my-plan
```

Fetching is never implicit. `--source local` and `--ref` are mutually exclusive.
Working-copy sources include uncommitted changes; ref sources use their tips.

Divergent histories are not ranked by percentage complete. `plan list` reports
`status: "diverged"` with null progress counts and `diverged_sources`;
`plan phases` returns `PLAN_DIVERGED` until a source is selected explicitly.
Later deletions/archive moves supersede stale ancestor copies, and archived
subtrees are excluded. Deleted/missing plans disappear from the list, but
`run state --plan` can retain their historical records.

JSON exposes `plan_state`, `source_kind`, `source_path`, `source_ref`, and
`source_dirty`. `content_commit`/`source_commit` identify the selected content
baseline or ref tip; `progress_commit` identifies the last change to the plan or
its records. These are provenance, not implementation-review range endpoints.

## Worktrees and local coordination

```bash
5x run init --plan <path> --worktree
5x run init --plan <path> --worktree <existing-worktree-path>
5x worktree list --text
5x worktree create --plan <path> --branch <branch>
5x worktree attach --plan <path> --path <existing-worktree-path>
5x worktree detach --plan <path>
5x worktree remove --plan <path>
```

`run init --worktree` reuses a mapping, attaches a unique matching worktree, or
creates one. Failure is an error, not silent fallback to shared-checkout work.
Allow time for checkout and `worktree.postCreate` when setting tool timeouts.

`invoke`, `quality run`, `diff`, and other run-aware operations resolve the mapped
checkout. Native prompts communicate its directory in appended runtime context;
the worker must follow it. `detach` removes only the mapping; `remove` removes
the worktree, with force behavior described by `--help`.

The repository control plane is resolved through Git's common directory. Its
local state normally lives in `.5x/`:

```text
.5x/
  5x.db                 local index and coordination state
  current-run           ambient focus pointer
  logs/<run-id>/        worker logs
  locks/                plan locks
  worktrees/            default isolated checkouts
  templates/            document skeletons and optional prompt overrides
```

Subproject initialization uses root-owned database/locks/logs/pointer, even before
a root database exists. Root `db.path` can relocate the state directory. Linked
worktrees normally need no independent `.5x/`. An initialized linked checkout
whose parent has no root database can operate in isolated mode; once a root
database exists, managed root state takes precedence.

`LEGACY_SUBPROJECT_STATE` identifies a separate old subproject database. Back it
up and migrate the needed history into root coordination, or move obsolete state
aside after backup. This migration is not automatic.

## Git-native history and commits

Tracked records under `paths.records` contain run summaries (`run.json`),
append-only steps (`steps.jsonl`), decisions, and origin attribution. History
travels with the plan branch. SQLite can re-index those records; local sessions,
locks, prompt coordination, and transcripts are separate and are not recreated
by a record import.

```bash
5x records index
5x records index --plan <slug>
```

Normal workflow commits use `5x commit`:

```bash
5x commit --run <id> -m "feat: implement phase 1" --files src/example.ts
5x commit --run <id> -m "feat: implement phase 1" --all-files
```

A normal commit records its own `git:commit` event, so the tracked journal is
dirty again immediately afterwards. Recording reviews/quality also changes it.
Before waiting on a human or leaving a run active, checkpoint only the records:

```bash
5x commit --run <id> --no-record -m "5x: checkpoint run records"
```

Without file flags this stages/commits only the active run's records, leaving
unrelated staged/dirty files untouched. It appends no event and succeeds with
`committed: false` when already clean. Explicit file flags with `--no-record`
are restricted to the active records directory.

`run complete` seals and commits run records itself. Complete only after the
workflow's review/checklist/governance requirements hold; checked boxes alone
are not approval. `run reopen` reactivates completed/aborted runs without
discarding their evidence.

## Archive or move plans

```bash
5x plan archive <path> --dry-run
5x plan archive <path>
5x run relink --help
```

Archiving refuses active runs unless `--force` explicitly aborts them first.
`--all` addresses all discovered plan files; preview before bulk archiving.
Use `run relink` to repair an association after a plan move, following its
required old/new path or run selection flags.

## Recovery

Start with:

```bash
5x doctor --text
5x doctor --fix --text
```

Doctor checks harness freshness, locks, mappings, lingering runs, database health,
orphaned prompts, invocations, and records. `--fix` applies supported safe repairs
(for example stale/corrupt locks, dead mappings, lossless project harness sync,
orphaned-prompt abandonment, and record-index recovery). It is not blanket
authorization to terminate live work or overwrite customized assets. Warnings
alone do not fail the command; failure findings return nonzero.

| Symptom | Next action |
| --- | --- |
| Harness freshness warning | `5x harness sync`; inspect local-edit conflicts if reported |
| `PLAN_LOCKED` | `5x lock list --text`, then `5x unlock <plan>`; live holders require `--force` |
| Dirty checkout | Commit/stash intended changes, choose isolation, or explicitly use `--allow-dirty` |
| Step budget nearly exhausted | Inspect `run state`; adjust `maxStepsPerRun` or split the work |
| Missing/ambiguous run | Select `--run <id>`; inspect environment, mapping, and pointer |
| `PLAN_DIVERGED` | Inspect candidates and choose `--source local` or `--ref` |
| `IMPLEMENTATION_APPROVAL_REQUIRED` | Select an approved plan-review source with `review implementation bind`; do not bypass admission |
| Governance gate | `review gate show`, obtain a decision, then `review decide` |
| `NON_INTERACTIVE` / `PROMPT_TIMEOUT` | Use the host's human UI, an intentional default, or the appropriate prompt timeout |
| Invalid worker output | Inspect log/error detail and use `protocol schema` / `protocol emit … --help` |
| No phases found | Check numeric `## Phase N: …` headings and Markdown checklists |

For plan amendments, use the installed workflow's recovery guidance. The current
`review implementation recover-plan` is a narrow, operator-confirmed recovery at
an unfinished frontier, not general semantic amendment registration. See
[automation](automation.md#review-governance).
