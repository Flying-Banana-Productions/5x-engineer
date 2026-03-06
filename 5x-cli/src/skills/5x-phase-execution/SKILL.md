---
name: 5x-phase-execution
description: >-
  Execute implementation phases from an approved plan. Each phase goes through
  author implementation, quality gates, code review, and optional fix cycles.
  Use when a plan has been approved and is ready for execution.
metadata:
  author: 5x-engineer
---

# Skill: 5x-phase-execution

Execute implementation phases from an approved plan. Each phase goes
through: author implementation, quality gates, code review, and
optional fix cycles.

## Prerequisites

- An approved implementation plan exists at a known path
- The plan parses into phases (`5x plan phases` returns phases)
- Quality gates are configured (if any)
- Git working tree is clean, or a worktree has been created (`5x worktree create`)

## Tools

- `5x run init --plan <path>` — create or resume a run
- `5x run state --run <id>` — check what's been done
- `5x run record <step> --run <id> --result '<json>'` — record a step
- `5x run complete --run <id>` — mark run finished
- `5x invoke author <template> --run <id> --var key=val` — invoke author
- `5x invoke reviewer <template> --run <id> --var key=val` — invoke reviewer
- `5x quality run` — run quality gates
- `5x plan phases <path>` — get phase list and status
- `5x diff --since <ref>` — inspect changes
- `5x worktree create --plan <path>` — create isolated worktree
- `5x prompt choose <msg> --options <a,b,c>` — ask the human
- `5x prompt input <msg>` — get human guidance
- `5x prompt confirm <msg>` — yes/no confirmation

## Workflow

### Step 0: Initialize

    5x run init --plan $PLAN_PATH --command phase-execution

If resuming an existing run, call `5x run state --run $RUN` and skip to
the appropriate point based on recorded history. Identify which phases
are complete (steps with `step_name: "phase:complete"`) and which phase
to start with.

Get the phase list: `5x plan phases $PLAN_PATH`
Filter to phases not yet completed. Process them in order.

### For each pending phase ($PHASE):

Track $QUALITY_RETRIES = 0 (max 2).
Track $REVIEW_ITERATIONS = 0 (max 3).
Track $REVIEWER_SESSION = "" (for session reuse within this phase).

#### Step 1: Author implements

Invoke the author to implement the phase:

    5x invoke author author-next-phase --run $RUN \
      --var plan_path=$PLAN_PATH \
      --var phase_number=$PHASE_NUMBER

Check the result:
- `result: "complete"` with a commit hash — record and continue to Step 2.
- `result: "complete"` without a commit — **invariant violation**.
  See Recovery.
- `result: "needs_human"` — present the reason and options:
  `5x prompt choose "Author needs help: $REASON" --options provide-guidance,abort`
  If guidance: collect via `5x prompt input`, re-invoke with
  `--var user_notes="$GUIDANCE"`.
- `result: "failed"` — present to human, abort or retry.

Record: `5x run record "author:implement" --run $RUN --phase $PHASE --result '<result>'`

Capture $COMMIT from the result for the reviewer.

#### Step 2: Quality gates

    5x quality run

Check the result:
- `passed: true` — record and continue to Step 3.
- `passed: false` — go to Step 2a (Quality retry).

Record: `5x run record "quality:check" --run $RUN --phase $PHASE --result '<result>'`

##### Step 2a: Quality retry

Increment $QUALITY_RETRIES.

If $QUALITY_RETRIES > 2:
  Escalate: `5x prompt choose "Quality gates failing after 2 retries" --options retry,skip,abort`
  - retry: reset $QUALITY_RETRIES, go to Step 2a below
  - skip: record human override, go to Step 3
  - abort: `5x run complete --run $RUN --status aborted`

Invoke author to fix quality failures:

    5x invoke author author-process-impl-review --run $RUN \
      --var review_path="" \
      --var plan_path=$PLAN_PATH \
      --var user_notes="Quality gate failures: $FAILURES"

Record: `5x run record "author:fix-quality" --run $RUN --phase $PHASE --result '<result>'`

Loop back to Step 2.

#### Step 3: Code review

Invoke the reviewer:

    5x invoke reviewer reviewer-commit --run $RUN \
      --var commit_hash=$COMMIT \
      --var review_path=$REVIEW_PATH \
      --var plan_path=$PLAN_PATH \
      --var review_template_path=$REVIEW_TEMPLATE_PATH \
      ${REVIEWER_SESSION:+--session $REVIEWER_SESSION}

Capture $REVIEWER_SESSION from the response.

Record: `5x run record "reviewer:review" --run $RUN --phase $PHASE --result '<result>'`

#### Step 4: Route the verdict

**If `readiness: "ready"`:**
  Go to Step 6 (Phase gate).

**If `readiness: "ready_with_corrections"`:**
  Check items. If ALL `auto_fix`: go to Step 5 (Author fix).
  If ANY `human_required`: go to Step 5a (Escalate).

**If `readiness: "not_ready"`:**
  If items exist:
    If any `human_required`: go to Step 5a (Escalate).
    If all `auto_fix`: go to Step 5 (Author fix).
  If no items: go to Step 5a (Escalate).

#### Step 5: Author fixes review items

Increment $REVIEW_ITERATIONS.

If $REVIEW_ITERATIONS > 3:
  Go to Step 5a (Escalate) with "Maximum review iterations reached."

Invoke the author to fix review items:

    5x invoke author author-process-impl-review --run $RUN \
      --var review_path=$REVIEW_PATH \
      --var plan_path=$PLAN_PATH

Check the result:
- `result: "complete"` — record, update $COMMIT, loop back to Step 2
  (quality gates must pass again after changes).
- `result: "needs_human"` — go to Step 5a (Escalate).
- `result: "failed"` — go to Step 5a (Escalate).

Record: `5x run record "author:fix-review" --run $RUN --phase $PHASE --result '<result>'`

#### Step 5a: Escalate

Present the situation to the human:

    5x prompt choose "Phase $PHASE: $REASON" \
      --options continue-with-guidance,approve-override,abort

**"continue-with-guidance":**
  Collect guidance: `5x prompt input "Guidance for the author"`
  Record: `5x run record "human:gate" --run $RUN --phase $PHASE --result '{"choice":"continue","guidance":"..."}'`
  Re-invoke author (Step 5) with `--var user_notes="$GUIDANCE"`.

**"approve-override":**
  Record: `5x run record "human:gate" --run $RUN --phase $PHASE --result '{"choice":"override"}'`
  Go to Step 6 (Phase gate).

**"abort":**
  `5x run complete --run $RUN --status aborted`
  Stop.

#### Step 6: Phase gate

Record phase completion:

    5x run record "phase:complete" --run $RUN --phase $PHASE --result '{"phase":"$PHASE"}'

If this is NOT the last phase, confirm with the human:

    5x prompt choose "Phase $PHASE complete. Continue to next phase?" \
      --options continue,exit,abort

- continue: proceed to next phase
- exit: leave the run active for later resume, stop
- abort: `5x run complete --run $RUN --status aborted`

### After all phases complete:

    5x run complete --run $RUN

Report to the human: all phases implemented and reviewed.

## Invariants

### After author implementation (Step 1):
- AuthorStatus.commit must be present (non-empty string)
- `5x diff --since $COMMIT~1` must show a non-empty diff
- Changed files should relate to the current phase (check against plan)

### After quality gates (Step 2):
- If gates pass, no further check needed
- If gates fail on code that wasn't modified in this phase, flag it —
  may be a pre-existing issue or regression from a prior phase

### After author fixes (Step 5):
- A new commit must exist (different from previous $COMMIT)
- The diff between old and new commit should address the review items
- The author should not have reverted previous work

### Phase boundary:
- `5x plan phases $PLAN_PATH` should show the completed phase's
  checklist items as checked
- Phase count should not have changed since the run started

## Recovery

### Context loss (compaction)

**Symptom:** Author returns `complete` but the diff is empty, trivial,
or doesn't address the task. Or author returns `complete` without a
commit hash.

**Response:**
1. Re-invoke with a fresh session (do NOT pass --session).
2. If the second attempt also fails, escalate to the human with context:
   "Author may be experiencing context issues. Two attempts produced
   inadequate results."

### Quality gate flakiness

**Symptom:** Quality gate passes, then fails on the same code, or fails
on tests unrelated to the current phase.

**Response:**
1. Check if the failing test/check relates to the current phase's changes.
2. If unrelated: flag to the human — "Quality gate failure appears
   unrelated to current phase. Failing test: $TEST. Override?"
3. If related but intermittent: retry once.

### Reviewer contradicts itself

**Symptom:** Reviewer marks items as auto_fix, author fixes them,
reviewer re-reviews and raises the same items again (or new items
of equal severity).

**Response:**
1. After 2 review cycles with no progress toward approval,
   escalate to the human with the full review history.
2. Present the option to override approval if the human judges
   the implementation is adequate.

### Author and reviewer disagree

**Symptom:** Author claims it addressed all items, but the reviewer
still says not_ready on the same issues.

**Response:**
1. Compare the diff against the specific review items.
2. If the diff genuinely addresses the items, present both perspectives
   to the human.
3. If the diff doesn't address the items, re-invoke the author with
   explicit quotes of the review items and the current code.

### Structured output validation failure

**Symptom:** `5x invoke` returns an error with code INVALID_STRUCTURED_OUTPUT.

**Response:**
1. Retry once with a fresh session.
2. If it fails again, escalate to the human — the model may not support
   the structured output format or the prompt may need adjustment.

## Completion

The workflow is complete when:
1. ALL phases have recorded "phase:complete" steps, AND
2. The run is marked complete via `5x run complete`
