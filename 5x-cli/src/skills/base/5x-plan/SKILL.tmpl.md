---
name: 5x-plan
description: >-
  Generate an implementation plan from a requirements document, then run
  review/fix cycles until the plan is approved. Load the `5x` skill first.
  Triggers on: 'new feature', 'implementation plan', 'plan from
  requirements', 'generate plan', 'PRD', 'TDD'.
metadata:
  author: 5x-engineer
---

# Skill: 5x-plan

Generate an implementation plan from a requirements document, then run
review/fix cycles until the plan is approved.

## Prerequisites

- A PRD or TDD document exists at a known path
- The project has a 5x config file (`5x.toml`) or uses defaults
- A plan template exists (config paths.templates.plan)
- Plans must live under the repository root (the control-plane root)

## Prerequisite Skill

Load the `5x` skill for delegation patterns, interaction model, and
timeout handling.

## Gotchas

- Plan path must resolve inside `paths.plans` (from config)
- After author generates plan, file must exist AND parse via
  `5x plan phases`
{{#if native}}
- Author must produce a commit via `5x commit` — no commit is an
  invariant violation; re-invoke with a fresh task (omit `task_id`)
{{else}}
- Author must produce a commit via `5x commit` — no commit is an
  invariant violation; re-invoke without `--session`
{{/if}}
- Read `maxReviewIterations` from `5x config show` for the review loop limit
- `run init --worktree` automatically skips the dirty-worktree check
  (worktrees are isolated). Without `--worktree`, use `--allow-dirty`
  if untracked IDE files (`.cursor/`, `.idea/`, etc.) trigger `DIRTY_WORKTREE`

## Tools

- `5x run init --plan <path> [--worktree]` — create or resume a run (use `--worktree` to auto-resolve or create an isolated worktree)
- `5x run state --run <id>` — check what's been done
- `5x run record <step> --run <id> --result '<json>'` — record a step
- `5x run complete --run <id>` — mark run finished
- `5x run list` — list runs (filter by --plan, --status)
- `5x template render <template> --run <id> [--var key=val ...]` — render a task prompt with run/worktree context
{{#if native}}
- `5x protocol validate <author|reviewer> [--run <id> --record --step <name> ...]` — validate and optionally record structured output
{{else}}
- `5x invoke <author|reviewer> <template> --run <id> [--var key=val ...]` — invoke role workflow, validate structured output, and optionally record with `--record`
{{/if}}
- `5x plan phases <path>` — get phase list and check plan parses
- `5x prompt choose <msg> --options <a,b,c>` — ask the human a question
- `5x prompt input <msg>` — get freeform guidance from the human

## Workflow

### Step 1: Initialize

Run `5x run init --plan $PLAN_PATH --worktree`.

`$PLAN_PATH` is the output plan path to be generated. It may not exist yet,
but it must resolve inside `paths.plans`. The requirements/design document is
separate: pass it as `$PRD_PATH`, then provide it to the author via
`--var prd_path=$PRD_PATH`.

The `--worktree` flag ensures an isolated git worktree is resolved or
created for this plan. All subsequent `--run`-scoped commands
(`invoke`, `quality run`, `diff`) automatically execute in the mapped
worktree — no manual `cd` or `--workdir` is needed.

If a run already exists (returned by init), call `5x run state --run $RUN`
and skip to the appropriate step based on recorded history.

### Step 2: Generate the plan

{{#if native}}
Delegate to the plan author via the Task tool:

```bash
RENDERED=$(5x template render author-generate-plan --run $RUN \
  --var prd_path=$PRD_PATH)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

RESULT=<Task tool: subagent_type="5x-plan-author", prompt=$PROMPT>

echo "$RESULT" | 5x protocol validate author \
  --run $RUN --record --step $STEP --phase plan
```
{{else}}
Delegate to the plan author via `5x invoke`:

```bash
RESULT=$(5x invoke author author-generate-plan --run $RUN \
  --var prd_path=$PRD_PATH \
  --record --record-step author:generate-plan --phase plan)

STATUS=$(echo "$RESULT" | jq -r '.data.result.result')
COMMIT=$(echo "$RESULT" | jq -r '.data.result.commit // empty')
SESSION_ID=$(echo "$RESULT" | jq -r '.data.session_id // empty')
```
{{/if}}

Check the result:
- If `result: "complete"` — continue to Step 3.
- If `result: "needs_human"` — present the reason to the human via
  `5x prompt choose` with options: provide-guidance, abort.
  If guidance, collect it via `5x prompt input` and re-invoke with
  `--var user_notes="$GUIDANCE"`.
- If `result: "failed"` — present the reason to the human and abort.

### Step 3: Review loop

This is the same pattern as the 5x-plan-review skill.
Execute the review loop from that skill starting at Step 1 (Review),
using the same $RUN (do not create a new run).

### Step 4: Complete

After the review loop approves the plan (or the human overrides):

    5x run complete --run $RUN

Report to the human: plan is ready at $PLAN_PATH.

## Invariants

- After author generates the plan, the plan file must exist at $PLAN_PATH.
- The plan must parse successfully (`5x plan phases $PLAN_PATH` returns phases).
- The plan must have at least one phase.
- Author must produce a commit via `5x commit` (AuthorStatus.commit is
  present). All author completions — plan generation, plan revision —
  must result in a committed change.

## Recovery

- **Plan file missing after author claims complete**: The author likely
  wrote to the wrong path. Re-invoke with explicit emphasis on the
  output path. If it fails again, ask the human.
{{#if native}}
- **Plan has no parseable phases**: The author didn't follow the template
  structure. Re-invoke with a fresh task (omit `task_id`) and explicit
  instructions to follow the template format.
{{else}}
- **Plan has no parseable phases**: The author didn't follow the template
  structure. Re-invoke without `--session` and explicit instructions to follow
  the template format.
{{/if}}
- **Author claims complete but no commit** (no `5x commit` was run):
{{#if native}}
  Invariant violation — treat as context loss. Re-invoke with a fresh
  task (omit `task_id`). If it fails again, escalate to the human.
- **Subagent returns empty or invalid output**: Retry once with a fresh
  task (omit `task_id`). If it fails again, escalate to the human.
{{else}}
  Invariant violation — treat as context loss. Re-invoke without `--session`.
  If it fails again, escalate to the human.
- **Subagent returns empty or invalid output**: Retry once without `--session`.
  If it fails again, escalate to the human.
{{/if}}

## Completion

The workflow is complete when:
1. The plan exists and parses successfully, AND
2. The reviewer approves it (verdict: ready), OR
3. The human explicitly overrides approval
