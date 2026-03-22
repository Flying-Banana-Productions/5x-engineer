---
name: 5x
description: >-
  Shared foundation for all 5x workflows. ALWAYS load this skill alongside
  any 5x-plan, 5x-plan-review, or 5x-phase-execution skill. Covers
  delegation patterns, human interaction, timeouts, and cross-cutting
  gotchas.
metadata:
  author: 5x-engineer
---

# Skill: 5x (Foundation)

Cross-cutting orchestration knowledge shared by all 5x process skills.
Load this skill alongside `5x-plan`, `5x-plan-review`, or
`5x-phase-execution` — it is never used independently.

## Tools

- `5x config show [--context <dir>]` — read the resolved runtime config
  (iteration limits, quality retry limits, timeout settings, paths). Use
  this instead of hardcoding numbers. The `--context` flag resolves
  nearest-config overrides for monorepo sub-projects.

## Human Interaction Model

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

## Delegating to Subagents

These skills assume an opencode environment with the 5x harness installed.
Available subagents are listed in the Task tool's `subagent_type` parameter:

| `subagent_type` | Role |
|---|---|
| `5x-plan-author` | Generates and revises implementation plans |
| `5x-code-author` | Implements code changes from approved plans |
| `5x-reviewer` | Quality review, structured verdicts |

Delegate work by rendering the prompt, launching a subagent via the Task
tool, then validating and recording the result:

```bash
# 1. Render the prompt
RENDERED=$(5x template render <template> --run $RUN \
  --var key=value)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

# 2. Launch subagent via Task tool
RESULT=<Task tool: subagent_type=<agent>, prompt=$PROMPT>

# 3. Validate + record
echo "$RESULT" | 5x protocol validate <role> \
  --run $RUN --record --step $STEP
```

This pattern works for all author and reviewer delegation steps.
`5x protocol validate --record` is the single recording point.

## Task Reuse

**Task reuse** is optional and best-effort. The Task tool returns a
`task_id` from each subagent invocation. Pass it back to resume the same
subagent conversation with full prior context — the subagent picks up
where it left off instead of starting fresh.

To also get a shorter continued-template variant, pass the `task_id` as
the `--session` value to `5x template render --session <task_id>`. If
task reuse is unavailable or awkward, start a fresh task (omit
`task_id`) — never fail a workflow because task reuse didn't work.

## Gotchas

- **`5x protocol validate --record` is the single recording point.**
  Never record separately — validate handles it.
- **Task reuse is best-effort.** Never fail a workflow because
  task reuse didn't work. Start a fresh task (omit `task_id`) and move on.
- **`result: "complete"` without a commit = invariant violation** in any
  author step. Authors commit via `5x commit --run $RUN` (which records
  the commit in the run journal). Re-invoke with a fresh task (omit
  `task_id`). If it fails again, escalate to the human.
- **Read iteration/retry limits from `5x config show`.** Never hardcode
  numbers like "max 5 iterations" or "max 2 retries" — the human may
  have customized these in `5x.toml`.
- **Empty or invalid subagent output**: Retry once with a fresh task
  (omit `task_id`). If it fails again, escalate to the human.
