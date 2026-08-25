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
  (iteration limits, quality retry limits, timeout settings, paths,
  per-role `delegationMode`, `provider`, and `model`). Use this instead
  of hardcoding numbers. The `--context` flag resolves nearest-config
  overrides for monorepo sub-projects.

## Run identity

Run-scoped commands resolve `--run` from ambient identity when the flag
is omitted, in this order: `FIVEX_RUN` → unique linked-worktree mapping →
`.5x/current-run`. After `5x run init`, export the run id so the rest of
the session does not thread `--run` on every call:

```bash
export FIVEX_RUN=<run_id>   # from init envelope `run_id` or `export_hint`
```

`--run` is optional when any of those signals already identifies the run.

### Recovery / explicit identity

Pass `--run $FIVEX_RUN` (or `--run <id>`) when ambient resolution is
missing or ambiguous — for example `5x commit --run $FIVEX_RUN` and
`5x run record … --run $FIVEX_RUN`.
{{#if any_native}}
Native roles also use `5x protocol validate … --run $FIVEX_RUN --record`.
{{/if}}
Queue workers and remote invocations must still receive an explicit
`--run`; they must not rely on CWD or `.5x/current-run`.

## Delegation mode precedence

Before the **first** author or reviewer delegation in a workflow, read
resolved config:

```bash
5x config show --context $PROJECT_DIR
```

Per-role **`delegationMode` is authoritative** — it overrides harness
defaults and orchestrator habit. **Mixed mode is normal** — e.g.
`author.delegationMode = invoke` with `reviewer.delegationMode = native`.
Each workflow step uses **only that role's branch** in the process skill.

{{#if any_invoke}}
Do not substitute a harness subagent for a role configured as `invoke` —
that bypasses `author.provider` / `author.model` and runs the harness
subagent's model instead.
{{/if}}

**Fail fast:** before delegating, confirm your chosen path matches the
resolved `delegationMode` for that role. If they differ, stop and correct.

{{#if any_native}}
**Native roles** (`delegationMode = native`): harness subagent +
`5x protocol validate --record`.
{{/if}}
{{#if any_invoke}}
**Invoke roles** (`delegationMode = invoke`): `5x invoke --record` (uses
`provider`, `model`, and timeout from config).
{{/if}}

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

**You are the orchestrator.** Execute the skill workflow yourself — render
prompts, delegate author/reviewer work, validate results, route verdicts,
and handle human gates. Subagents handle bounded implementation and review
tasks only; they do not run multi-step workflows on your behalf.

{{#if any_native}}
**Never delegate orchestration to a subagent.** In native harnesses,
subagents **cannot** launch other subagents. Spawning a subtask to run
plan review, phase execution, or any other orchestration loop will fail.
{{/if}}

{{#if any_native}}
### Native delegation (Task tool)

**Use only when `<role>.delegationMode` is `native`.** If the role is
`invoke`, use `5x invoke` instead — see below.

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
# 1. Render the prompt (ambient run identity; pass --run only if needed)
RENDERED=$(5x template render <template> \
  --var key=value)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

# 2. Launch subagent via Task tool
RESULT=<Task tool: subagent_type=<agent>, prompt=$PROMPT>

# 3. Validate + record
echo "$RESULT" | 5x protocol validate <role> \
  --record --step $STEP
```

This pattern applies to **native** roles only.
`5x protocol validate --record` is the single recording point.

When using `--run`, do not pass `--var plan_path=...` unless you are
intentionally overriding run-linked plan resolution. By default, the CLI
resolves `plan_path` from the run context and mapped worktree (when present),
which keeps author and reviewer on the same file.
{{/if}}
{{#if any_invoke}}
### Invoke delegation (5x invoke)

**Required when `<role>.delegationMode` is `invoke`.** Do not substitute a
native subagent — `5x invoke` selects `provider`, `model`, and timeout
from config.

These skills support environments where some roles use `5x invoke` delegation.

Delegate work by invoking the role/template pair directly and letting
`5x invoke --record` validate and record in one step:

```bash
RESULT=$(5x invoke <author|reviewer> <template> \
  --var key=value \
  --record --record-step <step_name>)

STATUS=$(echo "$RESULT" | jq -r '.data.result.result // .data.result.readiness')
COMMIT=$(echo "$RESULT" | jq -r '.data.result.commit // empty')
SESSION_ID=$(echo "$RESULT" | jq -r '.data.session_id // empty')
```

This pattern applies to **invoke** roles only.
`5x invoke --record` is the single recording point.

When using `--run`, do not pass `--var plan_path=...` unless you are
intentionally overriding run-linked plan resolution.
{{/if}}

{{#if any_native}}
## Task Reuse (Native)

**Task reuse** is optional and best-effort for native-delegated roles.
The native delegation API returns a **native subtask id** (track as
`$NATIVE_SUBTASK_ID`) from each subagent invocation. Pass it back as
**`[[NATIVE_CONTINUE_PARAM]]`** to continue the same subagent
conversation — the subagent picks up where it left off instead of
starting fresh.

**Do not** pass the native subtask id to `5x template render --session`
— `--session` takes a **provider session id** (a distinct concept used
only on the invoke path), not a harness-level subtask id. When
continuing a native subagent and a second `5x template render` in the
same phase needs a flag, use **`--continue-native`** — it selects the
`*-continued` template variant (with delta context) without expecting a
provider session. Use **`--new-session`** only for recovery.

If reuse is unavailable or awkward, start fresh (omit **`[[NATIVE_CONTINUE_PARAM]]`**) —
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
  task reuse didn't work. Start fresh (omit `[[NATIVE_CONTINUE_PARAM]]`) and move on.
{{/if}}
{{#if any_invoke}}
- **Session reuse is best-effort** (invoke roles). Never fail a workflow because
  session reuse didn't work. Drop the stale `session_id` (omit `--session`)
  and move on.
{{/if}}
- **`result: "complete"` without a commit = invariant violation** in any
  author step. Authors commit via `5x commit` (ambient run identity;
  records the commit in the run journal). If identity is missing, use
  `5x commit --run $FIVEX_RUN` (see Recovery / explicit identity).
{{#if author_native}}
- For native author: Re-invoke with a fresh subagent (omit `[[NATIVE_CONTINUE_PARAM]]`).
{{/if}}
{{#if author_invoke}}
- For invoke author: Re-invoke without `--session`.
{{/if}}
  If it fails again, escalate to the human.
- **Read iteration/retry limits from `5x config show`.** Never hardcode
  numbers like "max 5 iterations" or "max 2 retries" — the human may
  have customized these in `5x.toml`.
- **Per-role `delegationMode` overrides harness habit.** Running in a
  native harness does not mean every role is native — check config before
  each author/reviewer step.
{{#if any_invoke}}
  Using a harness subagent for an `invoke` role ignores
  `author.provider` / `author.model`.
{{/if}}
{{#if any_native}}
- **Never delegate orchestration to a subagent.** Run the skill loop in
  this agent. Subagents are for author/reviewer roles only — they cannot
  launch further subagents in native harnesses.
{{/if}}
{{#if author_native}}
- **Empty or invalid subagent output (author)**: Retry once with a fresh subagent
  (omit `[[NATIVE_CONTINUE_PARAM]]`). If it fails again, escalate to the human.
{{/if}}
{{#if author_invoke}}
- **Empty or invalid subagent output (author)**: Retry once without `--session`.
  If it fails again, escalate to the human.
{{/if}}
