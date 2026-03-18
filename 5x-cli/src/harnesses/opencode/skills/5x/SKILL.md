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

## Session Reuse

**Session reuse** is optional and best-effort. "Session" here means the
agent's conversational session — the identifier that lets you resume the
same agent conversation rather than starting fresh. The Task tool returns
a `task_id` from each invocation; pass it back to continue the same
subagent session.

Pass the session identifier to `5x template render --session <id>` to
automatically select a shorter continued-template variant. If session
reuse is unavailable or awkward, start a fresh session — never fail a
workflow because session reuse didn't work.

## Gotchas

- **`5x protocol validate --record` is the single recording point.**
  Never record separately — validate handles it.
- **Session reuse is best-effort.** Never fail a workflow because
  session reuse didn't work. Start a fresh session and move on.
- **`result: "complete"` without a commit = invariant violation** in any
  author step. Re-invoke with a fresh session. If it fails again,
  escalate to the human.
- **Read iteration/retry limits from `5x config show`.** Never hardcode
  numbers like "max 5 iterations" or "max 2 retries" — the human may
  have customized these in `5x.toml`.
- **Empty or invalid subagent output**: Retry once with a fresh session
  (no `task_id`). If it fails again, escalate to the human.
