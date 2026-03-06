---
name: 5x-plan
description: >-
  Generate an implementation plan from a requirements document, then run
  review/fix cycles until the plan is approved. Use when starting a new
  feature or project that needs a structured implementation plan.
metadata:
  author: 5x-engineer
---

# Skill: 5x-plan

> **Requires:** v1 CLI primitives (not yet implemented). See `101-cli-primitives.md`.

Generate an implementation plan from a requirements document, then run
review/fix cycles until the plan is approved.

## Prerequisites

- A PRD or TDD document exists at a known path
- The project has a 5x config file (5x.config.js) or uses defaults
- A plan template exists (config paths.templates.plan)

## Tools

- `5x run init --plan <path>` — create or resume a run
- `5x run state --run <id>` — check what's been done
- `5x run record <step> --run <id> --result '<json>'` — record a step
- `5x run complete --run <id>` — mark run finished
- `5x invoke author <template> --run <id> --var key=val` — invoke author sub-agent
- `5x invoke reviewer <template> --run <id> --var key=val` — invoke reviewer sub-agent
- `5x prompt choose <msg> --options <a,b,c>` — ask the human a question
- `5x prompt input <msg>` — get freeform guidance from the human

## Workflow

### Step 1: Initialize

Run `5x run init --plan $PLAN_PATH --command plan`.

If a run already exists (returned by init), call `5x run state --run $RUN`
and skip to the appropriate step based on recorded history.

### Step 2: Generate the plan

Invoke the author to generate the plan:

    5x invoke author author-generate-plan --run $RUN \
      --var prd_path=$PRD_PATH \
      --var plan_path=$PLAN_PATH \
      --var plan_template_path=$TEMPLATE_PATH

Check the result:
- If `result: "complete"` — record the step and continue to Step 3.
- If `result: "needs_human"` — present the reason to the human via
  `5x prompt choose` with options: provide-guidance, abort.
  If guidance, collect it via `5x prompt input` and re-invoke with
  `--var user_notes="$GUIDANCE"`.
- If `result: "failed"` — present the reason to the human and abort.

Record: `5x run record "author:generate-plan" --run $RUN --result '<result>'`

### Step 3: Review loop

This is the same pattern as the 5x-plan-review skill (Section 3.2).
Execute the review loop from that skill starting at the "Review"
step, using the same $RUN (do not create a new run).

### Step 4: Complete

After the review loop approves the plan (or the human overrides):

    5x run complete --run $RUN

Report to the human: plan is ready at $PLAN_PATH.

## Invariants

- After author generates the plan, the plan file must exist at $PLAN_PATH.
- The plan must parse successfully (`5x plan phases $PLAN_PATH` returns phases).
- The plan must have at least one phase.
- Author must produce a commit (AuthorStatus.commit is present). All
  author completions — plan generation, plan revision — must result
  in a committed change.

## Recovery

- **Plan file missing after author claims complete**: The author likely
  wrote to the wrong path. Re-invoke with explicit emphasis on the
  output path. If it fails again, ask the human.
- **Plan has no parseable phases**: The author didn't follow the template
  structure. Re-invoke with a fresh session and explicit instructions
  to follow the template format.
- **Author claims complete but no commit**: Invariant violation — treat
  as context loss. Re-invoke with a fresh session. If it fails again,
  escalate to the human.

## Completion

The workflow is complete when:
1. The plan exists and parses successfully, AND
2. The reviewer approves it (verdict: ready), OR
3. The human explicitly overrides approval
