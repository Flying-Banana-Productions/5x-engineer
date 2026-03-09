---
name: 5x-plan-review
description: >-
  Run iterative review/fix cycles on an implementation plan until it is
  approved by the reviewer or the human overrides. Use when a plan needs
  quality review before execution.
metadata:
  author: 5x-engineer
---

# Skill: 5x-plan-review

Run iterative review/fix cycles on an implementation plan until it is
approved by the reviewer or the human overrides.

## Prerequisites

- An implementation plan exists at a known path
- The plan parses successfully (`5x plan phases` returns phases)

## Tools

- `5x run init --plan <path>` — create or resume a run
- `5x run state --run <id>` — check what's been done
- `5x run record <step> --run <id> --result '<json>'` — record a step
- `5x run complete --run <id>` — mark run finished
- `5x run list` — list runs (filter by --plan, --status)
- `5x invoke reviewer <template> --run <id> --var key=val` — invoke reviewer
- `5x invoke author <template> --run <id> --var key=val` — invoke author
- `5x plan phases <path>` — verify plan still parses after revisions
- `5x prompt choose <msg> --options <a,b,c>` — ask the human
- `5x prompt input <msg>` — get human guidance

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
# --record auto-records using the template's step_name
RESULT=$(5x invoke reviewer reviewer-plan --run $RUN --record \
  --var plan_path=$PLAN_PATH --var review_path=$REVIEW_PATH 2>/dev/null)

# Parse fields from the envelope
READINESS=$(echo "$RESULT" | jq -r '.data.result.readiness')
SESSION=$(echo "$RESULT" | jq -r '.data.session_id')
```

Use `2>/dev/null` to discard stderr (streaming output) from your context.
The user can monitor progress separately via `5x run watch`.

### Timeout layers

Two independent timeouts apply to agent invocations:

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
Recovery for handling.

### Monitoring agent progress

Sub-agent invocations (`5x invoke`) write NDJSON logs to `.5x/logs/<run-id>/`.
To monitor progress in real-time, suggest the user run in a separate terminal:

    5x run watch --run <run-id> --human-readable

## Workflow

Track $ITERATION starting at 1. Maximum 5 review cycles.
Track $REVIEWER_SESSION (initially empty) for reviewer session reuse.

### Step 1: Review

Invoke the reviewer to review the plan:

    5x invoke reviewer reviewer-plan --run $RUN \
      --record --phase plan \
      --var plan_path=$PLAN_PATH \
      --var review_path=$REVIEW_PATH \
      ${REVIEWER_SESSION:+--session $REVIEWER_SESSION}

`--record` auto-records using the template's `step_name`
(`reviewer:review`). When `--session` is passed, the CLI automatically
uses the `reviewer-plan-continued` template (a shorter prompt) since
the full instructions are already in the session context.

Capture $REVIEWER_SESSION from the response for reuse in subsequent reviews.

### Step 2: Route the verdict

Read the verdict from the response:

**If `readiness: "ready"`:**
  Plan is approved. Go to Step 5 (Complete).

**If `readiness: "ready_with_corrections"`:**
  Check the items. If ALL items have `action: "auto_fix"`:
    Go to Step 3 (Author fix).
  If ANY items have `action: "human_required"`:
    Go to Step 4 (Escalate).

**If `readiness: "not_ready"`:**
  Check the items. If there are actionable items (`auto_fix` or `human_required`):
    If any `human_required`: Go to Step 4 (Escalate).
    If all `auto_fix`: Go to Step 3 (Author fix).
  If there are no actionable items:
    Go to Step 4 (Escalate) — the reviewer flagged issues but
    didn't provide actionable items; human needs to interpret.

### Step 3: Author fix

Invoke the author to revise the plan:

    5x invoke author author-process-plan-review --run $RUN \
      --record --phase plan \
      --var review_path=$REVIEW_PATH \
      --var plan_path=$PLAN_PATH

`--record` auto-records using the template's `step_name`
(`author:fix-review`).

Check the result:
- `result: "complete"` — go to Step 1 (next review cycle).
- `result: "needs_human"` — go to Step 4 (Escalate).
- `result: "failed"` — go to Step 4 (Escalate).

Increment $ITERATION. If $ITERATION > 5, go to Step 4 (Escalate)
with the message "Maximum review iterations reached."

Only successful review-then-author cycles increment $ITERATION.
Author retries due to timeout, empty output, or transient failures
do not count. The max 5 limit applies to completed review cycles,
not total invocations.

Loop back to Step 1.

### Step 4: Escalate

Present the situation to the human:

    5x prompt choose "Review requires human input: $REASON" \
      --options continue-with-guidance,approve-override,abort

**If "continue-with-guidance":**
  Collect guidance: `5x prompt input "Provide guidance for the author"`
  Record: `5x run record "human:gate" --run $RUN --phase plan --result '{"choice":"continue","guidance":"..."}'`
  Re-invoke the author (Step 3) with `--var user_notes="$GUIDANCE"`.

**If "approve-override":**
  Record: `5x run record "human:gate" --run $RUN --phase plan --result '{"choice":"override"}'`
  Go to Step 5 (Complete).

**If "abort":**
  `5x run complete --run $RUN --status aborted --reason "Human chose to abort"`
  Stop.

### Step 5: Complete

    5x run complete --run $RUN

Report to the human: plan review is complete. Verdict: approved
(or overridden). Review document is at $REVIEW_PATH.

## Invariants

- The plan must still parse after author revisions
  (`5x plan phases $PLAN_PATH` succeeds and returns the same phase count).
  Phase additions are acceptable; phase removals or reordering are suspect.
- The review file must exist at $REVIEW_PATH after reviewer invocation.
- Author revisions must produce a commit (AuthorStatus.commit is present).

## Recovery

- **Author revision produces no commit**: Likely the author made no
  changes (disagreed with the review). Check the diff. If the plan is
  genuinely unchanged, present both the review items and the author's
  notes to the human for judgment.
- **Reviewer produces empty items with not_ready**: The reviewer flagged
  a concern but couldn't articulate specific items. Re-invoke the reviewer
  with a fresh session and explicit instructions to provide actionable
  items. If it happens again, escalate to the human.
- **Phase count changed after revision**: The author restructured the
  plan significantly. This may be valid (reviewer asked for it) or a
  problem. Check whether the review items mentioned restructuring. If
  unclear, flag to the human.
- **Author claims complete but plan file is unchanged (empty diff)**:
  Suspect context loss (compaction). Re-invoke with a fresh session
  (omit --session). If it happens twice, escalate to the human.
- **Subprocess returns empty output**: The agent process may have been
  killed by the subprocess tool's timeout before completing. Retry with
  a longer timeout and a fresh session (omit --session). If empty output
  persists after retry, escalate to the human.

## Completion

The workflow is complete when:
1. The reviewer returns `readiness: "ready"`, OR
2. The human explicitly overrides approval
