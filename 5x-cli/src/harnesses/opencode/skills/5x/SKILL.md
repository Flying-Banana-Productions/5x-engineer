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

## Delegating Sub-Agent Work

Sub-agent tasks (author and reviewer work) should be delegated using the
**native-first pattern**: render the prompt, detect whether a native agent
is available, run it if so, then validate and record the result. Fall back
to `5x invoke` when no native agent is found.

**Installed OpenCode agent names:**
- `5x-orchestrator` — primary orchestrator (loads skills, delegates to subagents, guides human)
- `5x-plan-author` — generates and revises implementation plans
- `5x-code-author` — implements code changes from approved plans
- `5x-reviewer` — performs quality review and produces structured verdicts

**Native agent detection order:**

1. Project scope: `.opencode/agents/<name>.md`
2. User scope: `~/.config/opencode/agents/<name>.md`
3. Fallback: `5x invoke`

**Generic native-first delegation pattern:**

```bash
# 1. Render the prompt
RENDERED=$(5x template render <template> --run $RUN \
  --var key=value)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

# 2. Detect native agent (project scope first, then user scope)
if [[ -f ".opencode/agents/<agent-name>.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/<agent-name>.md" ]]; then
  # 3a. Launch native subagent (harness provides child session)
  RESULT=<native subagent result JSON>
else
  # 3b. Fallback: 5x invoke (omit --record; validate is the single record point)
  RESULT=$(5x invoke <role> <template> --run $RUN \
    --var key=value 2>/dev/null)
fi

# 4. Validate + record (combined — universal for both paths)
echo "$RESULT" | 5x protocol validate <role> \
  --run $RUN --record --step $STEP
```

This pattern works for all author and reviewer delegation steps. The
fallback `5x invoke` call intentionally omits `--record` so that
`5x protocol validate --record` is the single recording point for both
native and fallback paths, avoiding double-recording.

## Session Reuse

**Session reuse** is optional and best-effort. "Session" here means the
agent's conversational session — the identifier that lets you resume the
same agent conversation rather than starting fresh. In MCP Task tools
this is the `task_id` returned from a Task invocation; in `5x invoke` it
is the `session_id` from the JSON envelope.

If your harness exposes a stable session identifier, you may pass it to
`5x template render --session <id>` to automatically select a shorter
continued-template variant. If session reuse is unavailable or awkward,
start a fresh session — never fail a workflow because session reuse
didn't work.

## Fallback: 5x invoke

When native agents are not installed, delegate using `5x invoke` as a
subprocess. Sub-agent sessions consume tens of thousands of tokens —
capture only the final JSON envelope:

```bash
RESULT=$(5x invoke <role> <template> --run $RUN \
  --var key=value 2>/dev/null)
```

Use `2>/dev/null` to discard stderr (streaming output) from your context.

## Timeout Layers

Two independent timeouts apply to `5x invoke` fallback invocations:

1. **Invocation timeout** (`[author].timeout` / `[reviewer].timeout`
   in config, or `--timeout` CLI override): an inactivity timeout
   inside `5x invoke` that resets on each agent event. When it fires,
   you get a clean `AgentTimeoutError` in the JSON envelope. Do NOT
   pass `--timeout` unless you intend to override the configured value.

2. **Shell tool timeout**: your bash/subprocess tool's wall-clock
   limit. This is a blunt circuit breaker — when it fires, the process
   is killed and you get empty or truncated output.

These serve different purposes and cannot be cleanly aligned. Set your
shell tool timeout generously (e.g., 10 minutes) as a safety net for
catastrophic hangs. Let the invocation timeout handle normal operational
control. An unexpectedly killed subprocess produces empty output — see
the Gotchas section below.

## Gotchas

- **Empty subprocess output = timeout kill.** Never treat empty output
  from `5x invoke` as a valid response. The agent was killed by the
  shell tool's wall-clock timeout. Retry with a longer timeout and a
  fresh session.
- **Always `2>/dev/null` on `5x invoke`.** Stderr contains streaming
  agent output — if captured, it pollutes your context window.
- **Never pass `--timeout` to `5x invoke` unless intentionally
  overriding config.** The invocation timeout is already configured in
  `5x.toml`. Passing `--timeout` overrides it, which is rarely desired.
- **`5x protocol validate --record` is the single recording point.**
  Don't also `--record` on `5x invoke` — that would double-record the
  step.
- **Native agent detection checks project scope before user scope.**
  `.opencode/agents/<name>.md` in the project root takes precedence over
  `~/.config/opencode/agents/<name>.md`.
- **Session reuse is best-effort.** Never fail a workflow because
  session reuse didn't work. Start a fresh session and move on.
- **`result: "complete"` without a commit = invariant violation** in any
  author step. Re-invoke with a fresh session. If it fails again,
  escalate to the human.
- **Read iteration/retry limits from `5x config show`.** Never hardcode
  numbers like "max 5 iterations" or "max 2 retries" — the human may
  have customized these in `5x.toml`.
