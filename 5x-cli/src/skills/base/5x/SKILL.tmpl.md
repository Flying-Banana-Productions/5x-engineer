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

If you are running in Windows or PowerShell, also load `5x-windows` for
shell-specific examples and host ergonomics. Do not load it on non-Windows
platforms unless you specifically need those examples.

## Tools

- `5x config show [--context <dir>]` — read the resolved runtime config
  (iteration limits, quality retry limits, timeout settings, paths). Use
  this instead of hardcoding numbers. The `--context` flag resolves
  nearest-config overrides for monorepo sub-projects.

## Human Interaction Model

Workflow steps describe human gates **by intent** (message, allowed choices,
what to record next). Inline `5x prompt choose` / `5x prompt input` examples
are the **CLI contract** for that intent — they are **not** a requirement to
spawn subprocesses when you already have a working chat or question UI.

How you collect the response:

1. **You have a question/input tool** (e.g., MCP question tool, built-in
   ask-user tool): use it directly. This is preferred — it keeps the
   interaction in your native UI.
2. **You have a conversational UI**: ask the human in the conversation
   and use their reply.
3. **Neither of the above**: spawn `5x prompt choose` / `5x prompt input`
   as a subprocess. This works in direct terminal sessions and shell
   scripts but can fail when no TTY is available (e.g. some agent
   terminals). Pass `--default` to provide a fallback for non-interactive
   environments.

{{#if any_native}}
### Native harness (orchestrator with a chat or question UI)

You are the **orchestrator**, not a headless shell. **Default to (1) or (2)** above
and map each gate to the same choices and branching the skill describes. **Do not**
rely on `5x prompt` subprocesses for routine gates — they may lack `/dev/tty` and
fail in agent-driven terminals.

- **Typical IDE-native harness:** use **AskQuestion** (or equivalent) for
  multiple choice; use the chat thread for freeform guidance.
- **Other environments:** use that product's chat / native question tools the same way.

Use `5x run record` with the same JSON shapes the skill specifies after the human
chooses. Reserve **`5x prompt *`** for scripts, CI, or environments with no chat UI.
{{/if}}

## Delegating to Subagents

{{#if any_native}}
### Native delegation (Task tool)

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

When using `--run`, do not pass `--var plan_path=...` unless you are
intentionally overriding run-linked plan resolution. By default, the CLI
resolves `plan_path` from the run context and mapped worktree (when present),
which keeps author and reviewer on the same file.
{{/if}}
{{#if any_invoke}}
### Invoke delegation (5x invoke)

These skills support environments where some roles use `5x invoke` delegation.

Delegate work by invoking the role/template pair directly and letting
`5x invoke --record` validate and record in one step:

```bash
RESULT=$(5x invoke <author|reviewer> <template> --run $RUN \
  --var key=value \
  --record --record-step <step_name>)

STATUS=$(echo "$RESULT" | jq -r '.data.result.result // .data.result.readiness')
COMMIT=$(echo "$RESULT" | jq -r '.data.result.commit // empty')
SESSION_ID=$(echo "$RESULT" | jq -r '.data.session_id // empty')
```

This pattern works for all author and reviewer delegation steps.
`5x invoke --record` is the single recording point.

When using `--run`, do not pass `--var plan_path=...` unless you are
intentionally overriding run-linked plan resolution.
{{/if}}

{{#if any_native}}
## Task Reuse (Native)

**Task reuse** is optional and best-effort for native-delegated roles.
The Task tool returns an **agent id** from each subagent invocation. Pass
it back as **`resume`** to continue the same subagent conversation — the
subagent picks up where it left off instead of starting fresh.

**Do not** pass that agent id to `5x template render --session`; that
flag is for **invoke-mode delegation** (provider session) and `*-continued` template
selection. If a second `5x template render` in the same phase needs a
flag, use **`--new-session`** when appropriate (see process skills).

If reuse is unavailable or awkward, start fresh (omit **`resume`**) —
never fail a workflow because reuse didn't work.
{{/if}}
{{#if any_invoke}}
## Session Reuse (Invoke)

**Session reuse** is optional and best-effort for invoke-delegated roles.
`5x invoke` returns a `session_id` from each invocation. Pass it back via
`--session` to resume the same provider session with full prior context.

To also get a shorter continued-template variant, pass `--session`
to `5x invoke` (it forwards the value to template rendering internally).
If session reuse is unavailable or awkward, start a fresh invocation
(omit `--session`) — never fail a workflow because session reuse didn't
work.
{{/if}}

## Gotchas

- **Single recording point:**
{{#if any_native}}
  - For native delegation: `5x protocol validate --record` handles recording.
{{/if}}
{{#if any_invoke}}
  - For invoke delegation: `5x invoke --record` handles validation + recording.
{{/if}}
{{#if any_native}}
- **Task reuse is best-effort** (native roles). Never fail a workflow because
  task reuse didn't work. Start fresh (omit `resume`) and move on.
{{/if}}
{{#if any_invoke}}
- **Session reuse is best-effort** (invoke roles). Never fail a workflow because
  session reuse didn't work. Drop the stale `session_id` (omit `--session`)
  and move on.
{{/if}}
- **`result: "complete"` without a commit = invariant violation** in any
  author step. Authors commit via `5x commit --run $RUN` (which records
  the commit in the run journal).
{{#if author_native}}
- For native author: Re-invoke with a fresh subagent (omit `resume`).
{{/if}}
{{#if author_invoke}}
- For invoke author: Re-invoke without `--session`.
{{/if}}
  If it fails again, escalate to the human.
- **Read iteration/retry limits from `5x config show`.** Never hardcode
  numbers like "max 5 iterations" or "max 2 retries" — the human may
  have customized these in `5x.toml`.
{{#if author_native}}
- **Empty or invalid subagent output (author)**: Retry once with a fresh subagent
  (omit `resume`). If it fails again, escalate to the human.
{{/if}}
{{#if author_invoke}}
- **Empty or invalid subagent output (author)**: Retry once without `--session`.
  If it fails again, escalate to the human.
{{/if}}
