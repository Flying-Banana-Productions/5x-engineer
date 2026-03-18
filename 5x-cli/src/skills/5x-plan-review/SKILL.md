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

- An implementation plan exists at a known path (under the repository root)
- The plan parses successfully (`5x plan phases` returns phases)

## Prerequisite Skill

Load the `5x` skill for delegation patterns, interaction model, and
timeout handling.

## Gotchas

- Only completed review-then-author cycles count toward
  `maxReviewIterations` — retries from timeout/empty output don't count
- Empty diff after author "completes" = context loss → use `--new-session`
- `not_ready` with no actionable items → escalate, don't loop
- `SESSION_REQUIRED` error → pass `--new-session` to recover
- Read `maxReviewIterations` from `5x config show` for the iteration limit

## Tools

- `5x run init --plan <path> [--worktree]` — create or resume a run (use `--worktree` to auto-resolve or create an isolated worktree)
- `5x run state --run <id>` — check what's been done
- `5x run record <step> --run <id> --result '<json>'` — record a step
- `5x run complete --run <id>` — mark run finished
- `5x run list` — list runs (filter by --plan, --status)
- `5x template render <template> --run <id> [--var key=val ...]` — render a task prompt with run/worktree context
- `5x protocol validate <author|reviewer> [--run <id> --record --step <name> ...]` — validate and optionally record structured output
- `5x invoke reviewer <template> --run <id> --var key=val` — invoke reviewer (fallback transport)
- `5x invoke author <template> --run <id> --var key=val` — invoke author (fallback transport)
- `5x plan phases <path>` — verify plan still parses after revisions
- `5x prompt choose <msg> --options <a,b,c>` — ask the human
- `5x prompt input <msg>` — get human guidance

### Delegating sub-agent work

**Canonical native delegation example (reviewer:review):**

```bash
# 1. Render the prompt (output follows standard outputSuccess envelope)
#    review_path is auto-generated — do NOT pass --var review_path.
#    Read the auto-generated path from .data.variables.review_path in the output.
#    Session lifecycle: first review has no $REVIEWER_SESSION, subsequent
#    reviews pass --session $REVIEWER_SESSION for continuity.
RENDERED=$(5x template render reviewer-plan --run $RUN \
  --var plan_path=$PLAN_PATH \
  ${REVIEWER_SESSION:+--session $REVIEWER_SESSION})
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')
REVIEW_PATH=$(echo "$RENDERED" | jq -r '.data.variables.review_path')

# 2. Detect native agent (project scope first, then user scope)
if [[ -f ".opencode/agents/5x-reviewer.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-reviewer.md" ]]; then
  # 3a. Launch native subagent (harness provides child session)
  RESULT=<native subagent result JSON>
else
  # 3b. Fallback to 5x invoke (NOTE: --record intentionally omitted here
  #     so that 5x protocol validate --record is the single recording point
  #     for both native and fallback paths, avoiding double-recording)
  RESULT=$(5x invoke reviewer reviewer-plan --run $RUN \
    --var plan_path=$PLAN_PATH \
    ${REVIEWER_SESSION:+--session $REVIEWER_SESSION} 2>/dev/null)
fi

# 4. Validate + record (combined — universal for both paths)
echo "$RESULT" | 5x protocol validate reviewer \
  --run $RUN --record --step $STEP --phase plan --iteration $ITERATION

# 5. Capture session for reuse in subsequent reviews
REVIEWER_SESSION=$(echo "$RESULT" | jq -r '.data.session_id // empty')
```

**Session reuse** is expected when `reviewer.continuePhaseSessions` is
enabled. The tool enforces this: if a prior reviewer step exists for the
current phase, `--session <id>` or `--new-session` is required. Use
`--new-session` only for recovery (context loss, empty output).

When `--session` is passed, the command automatically selects the shorter
`reviewer-plan-continued` template variant if one exists.

Projects using plan-review should enable
`reviewer.continuePhaseSessions = true` in their `5x.toml` once they have
confirmed all reviewer templates have `-continued` variants.

## Workflow

Track $ITERATION starting at 1. Read `maxReviewIterations` from `5x config show` for the maximum.
Track $REVIEWER_SESSION (initially empty). Session reuse is enforced when
`reviewer.continuePhaseSessions` is enabled — pass `--session $REVIEWER_SESSION`
on subsequent reviews.
Read $REVIEW_PATH from `.data.variables.review_path` in the template render output.

### Step 1: Review

Delegate to the reviewer using the native-first pattern:

```bash
RENDERED=$(5x template render reviewer-plan --run $RUN \
  --var plan_path=$PLAN_PATH \
  ${REVIEWER_SESSION:+--session $REVIEWER_SESSION})
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')
REVIEW_PATH=$(echo "$RENDERED" | jq -r '.data.variables.review_path')

if [[ -f ".opencode/agents/5x-reviewer.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-reviewer.md" ]]; then
  RESULT=<launch native 5x-reviewer subagent with PROMPT>
else
  RESULT=$(5x invoke reviewer reviewer-plan --run $RUN --phase plan \
    --var plan_path=$PLAN_PATH \
    ${REVIEWER_SESSION:+--session $REVIEWER_SESSION} 2>/dev/null)
fi

echo "$RESULT" | 5x protocol validate reviewer \
  --run $RUN --record --step $STEP --phase plan --iteration $ITERATION
```

When `--session` is passed to `5x template render`, the command
automatically selects the `reviewer-plan-continued` template variant
(a shorter prompt) when it exists, since full instructions are already
in the session context.

Capture $REVIEWER_SESSION from the native harness or from
`.data.session_id` in the `5x invoke` fallback response, for optional
reuse in subsequent reviews.

### Step 2: Route the verdict

Read the verdict from the `5x protocol validate` output:

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

Delegate to the plan author using the native-first pattern:

```bash
RENDERED=$(5x template render author-process-plan-review --run $RUN \
  --var plan_path=$PLAN_PATH)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

if [[ -f ".opencode/agents/5x-plan-author.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-plan-author.md" ]]; then
  RESULT=<launch native 5x-plan-author subagent with PROMPT>
else
  RESULT=$(5x invoke author author-process-plan-review --run $RUN \
    --var plan_path=$PLAN_PATH 2>/dev/null)
fi

echo "$RESULT" | 5x protocol validate author \
  --run $RUN --record --step $STEP --phase plan \
  --no-phase-checklist-validate
```

Check the result:
- `result: "complete"` — go to Step 1 (next review cycle).
- `result: "needs_human"` — go to Step 4 (Escalate).
- `result: "failed"` — go to Step 4 (Escalate).

Increment $ITERATION. If $ITERATION exceeds `maxReviewIterations` (from
`5x config show`), go to Step 4 (Escalate) with the message "Maximum
review iterations reached."

Only successful review-then-author cycles increment $ITERATION.
Author retries due to timeout, empty output, or transient failures
do not count. The `maxReviewIterations` limit applies to completed
review cycles, not total invocations.

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
(or overridden). Review document is at the auto-generated review path
(read from `.data.variables.review_path` in the template render output).

## Invariants

- The plan must still parse after author revisions
  (`5x plan phases $PLAN_PATH` succeeds and returns the same phase count).
  Phase additions are acceptable; phase removals or reordering are suspect.
- The review file must exist at the auto-generated review path after reviewer invocation.
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
  Suspect context loss (compaction). Re-invoke with `--new-session` to
  force a fresh session. If it happens twice, escalate to the human.
- **Native subagent returns empty or invalid output**: Retry once with
  `--new-session`. If it fails again, fall back to `5x invoke` or escalate.
- **Subprocess returns empty output**: The agent process may have been
  killed by the subprocess tool's timeout before completing. Retry with
  a longer timeout and `--new-session`. If empty output persists after
  retry, escalate to the human.
- **SESSION_REQUIRED error**: The tool requires `--session <id>` or
  `--new-session` because `continuePhaseSessions` is enabled and prior
  steps exist. Pass `--new-session` to recover from context loss.

## Completion

The workflow is complete when:
1. The reviewer returns `readiness: "ready"`, OR
2. The human explicitly overrides approval
