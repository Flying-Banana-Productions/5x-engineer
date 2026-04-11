---
name: 5x-plan-review
description: >-
  Run iterative review/fix cycles on an implementation plan until it is
  approved by the reviewer or the human overrides. Load the `5x` skill
  first. Triggers on: 'review plan', 'plan review', 'iterate on plan',
  'get plan approved'.
metadata:
  author: 5x-engineer
---

# Skill: 5x-plan-review

Run iterative review/fix cycles on an implementation plan until it is
approved by the reviewer or the human overrides.

## Prerequisites

- An implementation plan exists and is associated with the run
- The plan parses successfully (`5x plan phases` returns phases)

## Prerequisite Skill

Load the `5x` skill for delegation patterns, interaction model, and
timeout handling.

## Gotchas

- Only completed review-then-author cycles count toward
  `maxReviewIterations` — retries from timeout/empty output don't count
- Empty diff after author "completes" = context loss →
{{#if author_native}}
  start fresh subagent (omit `[[NATIVE_CONTINUE_PARAM]]`)
{{else}}
  start fresh session (omit `--session`)
{{/if}}
- `not_ready` with no actionable items → escalate, don't loop
- `SESSION_REQUIRED` error → pass `--new-session` to `5x template render`
- Read `maxReviewIterations` from `5x config show` for the iteration limit
- When using `--run`, do not pass `--var plan_path=...` unless you are
  intentionally overriding run-linked plan resolution. Let the CLI resolve
  the mapped worktree copy automatically.

## Tools

- `5x run init --plan <path> [--worktree]` — create or resume a run (use `--worktree` to auto-resolve or create an isolated worktree)
- `5x run state --run <id>` — check what's been done
- `5x run record <step> --run <id> --result '<json>'` — record a step
- `5x run complete --run <id>` — mark run finished
- `5x run list` — list runs (filter by --plan, --status)
- `5x template render <template> --run <id> [--var key=val ...]` — render a task prompt with run/worktree context
{{#if any_native}}
- `5x protocol validate <author|reviewer> [--run <id> --record --step <name> ...]` — validate and optionally record structured output (native roles)
{{/if}}
{{#if any_invoke}}
- `5x invoke <author|reviewer> <template> --run <id> [--var key=val ...]` — invoke role workflow, validate structured output, and optionally record with `--record` (invoke roles)
{{/if}}
- `5x plan phases <path>` — verify plan still parses after revisions
{{#if any_native}}
- Human gates — use your **native UI** (see `5x` foundation skill). Record with `5x run record "human:gate"` using the JSON shapes below.
- **`5x prompt` fallback** — only when no chat UI exists; use `--default` if stdin is not a TTY.
{{/if}}
{{#if all_invoke}}
- `5x prompt choose <msg> --options <a,b,c>` — ask the human
- `5x prompt input <msg>` — get human guidance
{{/if}}

{{#if reviewer_native}}
### Delegating sub-agent work (native reviewer)

**Canonical delegation example (reviewer:review):**

```bash
# 1. Render the prompt (output follows standard outputSuccess envelope)
#    review_path is auto-generated — do NOT pass --var review_path.
#    Read the auto-generated path from .data.variables.review_path in the output.
#    Re-reviews: add --new-session if the CLI requires it; do not pass the
#    subagent continuation id as --session (that flag controls CLI continuity,
#    including continued-template selection and invoke-mode session identity).
RENDERED=$(5x template render reviewer-plan --run $RUN)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')
REVIEW_PATH=$(echo "$RENDERED" | jq -r '.data.variables.review_path')

# 2. Launch subagent via Task tool (pass the native continuation parameter to continue the same reviewer)
RESULT=<Task tool: subagent_type="5x-reviewer", prompt=$PROMPT,
        [[NATIVE_CONTINUE_PARAM]]=$REVIEWER_AGENT_ID (omit if empty)>

# 3. Validate + record
echo "$RESULT" | 5x protocol validate reviewer \
  --run $RUN --record --step $STEP --phase plan --iteration $ITERATION

# 4. Capture agent id for reuse in subsequent reviews
REVIEWER_AGENT_ID=<agent id from Task tool result>
```

**Task reuse** is expected when `reviewer.continuePhaseSessions` is
enabled and the reviewer is native. If a prior reviewer step exists for
the current phase, `5x template render` may require **`--session`** (for
invoke-mode session identity) or **`--new-session`** — not the **subagent continuation id**. Pass **`[[NATIVE_CONTINUE_PARAM]]=$REVIEWER_AGENT_ID`** on the Task tool for
subagent continuity. Use `--new-session` on the render only when the
CLI requires it or for recovery (context loss, empty output).

When a **provider** `--session` is passed to `5x template render` (invoke
path), the command can select the shorter `reviewer-plan-continued`
template variant if one exists.
{{/if}}
{{#if reviewer_invoke}}
### Delegating review/author work with invoke (invoke reviewer)

**Canonical delegation example (reviewer:review):**

```bash
RESULT=$(5x invoke reviewer reviewer-plan --run $RUN \
  ${SESSION_ID:+--session $SESSION_ID} \
  --record --record-step reviewer:plan --phase plan --iteration $ITERATION)

READINESS=$(echo "$RESULT" | jq -r '.data.result.readiness')
ITEM_COUNT=$(echo "$RESULT" | jq -r '.data.result.items | length')
SESSION_ID=$(echo "$RESULT" | jq -r '.data.session_id // empty')
```

Session reuse is best-effort when the reviewer uses invoke. Pass
`--session $SESSION_ID` when continuing context. Use `--new-session` only
for recovery.
{{/if}}

Projects using plan-review should enable
`reviewer.continuePhaseSessions = true` in their `5x.toml` once they have
confirmed all reviewer templates have `-continued` variants.

## Workflow

Track $ITERATION starting at 1. Read `maxReviewIterations` from `5x config show` for the maximum.
{{#if reviewer_native}}
Track $REVIEWER_AGENT_ID (initially empty). When `reviewer.continuePhaseSessions`
is enabled, pass **`[[NATIVE_CONTINUE_PARAM]]=$REVIEWER_AGENT_ID`** on the Task tool on
subsequent reviews. Use **`--new-session`** on `5x template render` when
the CLI requires it — do not pass the agent id as `--session`.
{{/if}}
{{#if reviewer_invoke}}
Track $SESSION_ID (initially empty). Session reuse is enforced when
`reviewer.continuePhaseSessions` is enabled and the reviewer uses invoke —
pass `--session $SESSION_ID` on subsequent invoke calls.
{{/if}}
{{#if reviewer_native}}
Read $REVIEW_PATH from `.data.variables.review_path` in the template render output.
{{/if}}
{{#if reviewer_invoke}}
Read $REVIEW_PATH from a separate template render call before each reviewer invoke.
{{/if}}

### Step 1: Review

{{#if reviewer_native}}
Delegate to the reviewer via the Task tool:

```bash
RENDERED=$(5x template render reviewer-plan --run $RUN)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')
REVIEW_PATH=$(echo "$RENDERED" | jq -r '.data.variables.review_path')

RESULT=<Task tool: subagent_type="5x-reviewer", prompt=$PROMPT,
        [[NATIVE_CONTINUE_PARAM]]=$REVIEWER_AGENT_ID (omit if empty)>

echo "$RESULT" | 5x protocol validate reviewer \
  --run $RUN --record --step $STEP --phase plan --iteration $ITERATION
```

When a **provider** `--session` is passed to `5x template render` (invoke
path), the command can select the `reviewer-plan-continued` template variant
when it exists.

Capture `$REVIEWER_AGENT_ID` from the Task tool result for reuse in
subsequent reviews.
{{else}}
Delegate to the reviewer via `5x invoke`:

```bash
# Extract review_path for reporting/audit
REVIEW_PATH=$(5x template render reviewer-plan --run $RUN \
  ${SESSION_ID:+--session $SESSION_ID} \
  | jq -r '.data.variables.review_path')

RESULT=$(5x invoke reviewer reviewer-plan --run $RUN \
  ${SESSION_ID:+--session $SESSION_ID} \
  --record --record-step reviewer:plan --phase plan --iteration $ITERATION)

READINESS=$(echo "$RESULT" | jq -r '.data.result.readiness')
ITEM_COUNT=$(echo "$RESULT" | jq -r '.data.result.items | length')
SESSION_ID=$(echo "$RESULT" | jq -r '.data.session_id // empty')
```
{{/if}}

### Step 2: Route the verdict

Read the verdict from `READINESS` (`.data.result.readiness`):

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

{{#if author_native}}
Delegate to the plan author via the Task tool:

```bash
RENDERED=$(5x template render author-process-plan-review --run $RUN)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

RESULT=<Task tool: subagent_type="5x-plan-author", prompt=$PROMPT>

echo "$RESULT" | 5x protocol validate author \
  --run $RUN --record --step $STEP --phase plan \
  --no-phase-checklist-validate
```
{{else}}
Delegate to the plan author via `5x invoke`:

```bash
RESULT=$(5x invoke author author-process-plan-review --run $RUN \
  --record --record-step author:process-plan-review --phase plan)

STATUS=$(echo "$RESULT" | jq -r '.data.result.result')
COMMIT=$(echo "$RESULT" | jq -r '.data.result.commit // empty')
SESSION_ID=$(echo "$RESULT" | jq -r '.data.session_id // empty')
```
{{/if}}

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

{{#if any_native}}
Present the situation to the human using your **native UI** (multiple choice + freeform where needed). Match the semantics of:

- **Options:** continue-with-guidance, approve-override, abort
- **CLI equivalent (fallback only):**  
  `5x prompt choose "Review requires human input: $REASON" --options continue-with-guidance,approve-override,abort`

**If "continue-with-guidance":**
  Collect guidance, then record:  
  `5x run record "human:gate" --run $RUN --phase plan --result '{"choice":"continue","guidance":"..."}'`  
  Re-invoke the author (Step 3) with `--var user_notes="$GUIDANCE"`.

**If "approve-override":**
  Record: `5x run record "human:gate" --run $RUN --phase plan --result '{"choice":"override"}'`
  Go to Step 5 (Complete).

**If "abort":**
  `5x run complete --run $RUN --status aborted --reason "Human chose to abort"`
  Stop.
{{else}}
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
{{/if}}

### Step 5: Complete

    5x run complete --run $RUN

Report to the human: plan review is complete. Verdict: approved
(or overridden). Review document is at the auto-generated review path
(`$REVIEW_PATH`).

## Invariants

- The plan must still parse after author revisions
  (`5x plan phases $PLAN_PATH` succeeds and returns the same phase count).
  Phase additions are acceptable; phase removals or reordering are suspect.
- The review file must exist at the auto-generated review path after reviewer invocation.
- Author revisions must produce a commit via `5x commit` (AuthorStatus.commit is present).

## Recovery

- **Author revision produces no commit** (no `5x commit` was run):
  Likely the author made no changes (disagreed with the review). Check
  the diff. If the plan is genuinely unchanged, present both the review
  items and the author's notes to the human for judgment.
- **Reviewer produces empty items with not_ready**: The reviewer flagged
  a concern but couldn't articulate specific items. Re-invoke the reviewer
{{#if reviewer_native}}
  with a fresh subagent (omit `[[NATIVE_CONTINUE_PARAM]]`) and explicit instructions to provide
{{else}}
  without `--session` and explicit instructions to provide
{{/if}}
  actionable items. If it happens again, escalate to the human.
- **Phase count changed after revision**: The author restructured the
  plan significantly. This may be valid (reviewer asked for it) or a
  problem. Check whether the review items mentioned restructuring. If
  unclear, flag to the human.
- **Author claims complete but plan file is unchanged (empty diff)**:
{{#if author_native}}
  Suspect context loss (compaction). Re-invoke with a fresh subagent (omit
  `[[NATIVE_CONTINUE_PARAM]]`). If it happens twice, escalate to the human.
{{else}}
  Suspect context loss (compaction). Re-invoke without `--session`.
  If it happens twice, escalate to the human.
{{/if}}
{{#if author_native}}
- **Subagent returns empty or invalid output (author)**: Retry once with a fresh
  subagent (omit `[[NATIVE_CONTINUE_PARAM]]`). If it fails again, escalate to the human.
{{else}}
- **Subagent returns empty or invalid output (author)**: Retry once without `--session`.
  If it fails again, escalate to the human.
{{/if}}
- **SESSION_REQUIRED error**: `5x template render` requires `--session`
  or `--new-session` because `continuePhaseSessions` is enabled and prior
  steps exist. For recovery, prefer **`--new-session`**. For invoke reviewers,
  pass **`--session`** with the provider's `session_id` — not the
  orchestrator subagent continuation id (native reviewers use **`[[NATIVE_CONTINUE_PARAM]]`** on
  the Task-style delegation instead).

## Completion

The workflow is complete when:
1. The reviewer returns `readiness: "ready"`, OR
2. The human explicitly overrides approval
