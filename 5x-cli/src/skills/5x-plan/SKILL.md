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
- `5x run list` — list runs (filter by --plan, --status)
- `5x invoke author <template> --run <id> --var key=val` — invoke author sub-agent
- `5x invoke reviewer <template> --run <id> --var key=val` — invoke reviewer sub-agent
- `5x plan phases <path>` — get phase list and check plan parses
- `5x prompt choose <msg> --options <a,b,c>` — ask the human a question
- `5x prompt input <msg>` — get freeform guidance from the human

### Human interaction note

The workflow steps reference `5x prompt` commands to describe **what to
ask the human and when**. How you collect the response depends on your
capabilities:

1. **You have a question/input tool** (e.g., MCP question tool, built-in
   ask-user tool): use it directly. This is preferred — it keeps the
   interaction in your native UI.
2. **You have a conversational UI**: ask the human in the conversation
   and use their reply.
3. **Neither of the above**: spawn `5x prompt choose` / `5x prompt input`
   as a subprocess. This works in direct terminal sessions and shell
   scripts but will fail with `NON_INTERACTIVE` (exit 3) if no terminal
   is available. Pass `--default` to provide a fallback for non-interactive
   environments.

### Invoking sub-agents

**CRITICAL: Always run `5x invoke` as a subprocess** (via your shell/bash
tool), never as an inline tool call. Sub-agent sessions consume tens of
thousands of tokens — running them inline floods your context window and
wastes budget. Running as a subprocess keeps only the final JSON envelope
(~500 bytes) in your context.

```bash
# Correct: subprocess captures only the JSON envelope
RESULT=$(5x invoke author author-generate-plan --run $RUN \
  --var prd_path=$PRD_PATH --var plan_path=$PLAN_PATH 2>/dev/null)

# Parse fields from the envelope
STATUS=$(echo "$RESULT" | jq -r '.data.result.result')
COMMIT=$(echo "$RESULT" | jq -r '.data.result.commit')
```

Use `2>/dev/null` to discard stderr (streaming output) from your context.
The user can monitor progress separately via `5x run watch`.

### Monitoring agent progress

Sub-agent invocations (`5x invoke`) write NDJSON logs to `.5x/logs/<run-id>/`.
To monitor progress in real-time, suggest the user run in a separate terminal:

    5x run watch --run <run-id> --human-readable

## Workflow

### Step 1: Initialize

Run `5x run init --plan $PLAN_PATH --command plan`.

If a run already exists (returned by init), call `5x run state --run $RUN`
and skip to the appropriate step based on recorded history.

### Step 2: Generate the plan

Invoke the author to generate the plan:

    5x invoke author author-generate-plan --run $RUN \
      --var prd_path=$PRD_PATH \
      --var plan_path=$PLAN_PATH

Check the result:
- If `result: "complete"` — record the step and continue to Step 3.
- If `result: "needs_human"` — present the reason to the human via
  `5x prompt choose` with options: provide-guidance, abort.
  If guidance, collect it via `5x prompt input` and re-invoke with
  `--var user_notes="$GUIDANCE"`.
- If `result: "failed"` — present the reason to the human and abort.

Record: `5x run record "author:generate-plan" --run $RUN --result '<result>'`

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
