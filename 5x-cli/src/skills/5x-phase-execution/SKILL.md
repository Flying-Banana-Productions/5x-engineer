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

- An approved implementation plan exists at a known path (under the repository root)
- The plan parses into phases (`5x plan phases` returns phases)
- Quality gates are configured (if any)
- Git working tree is clean, or a worktree will be created via `run init --worktree`

## Prerequisite Skill

Load the `5x` skill for delegation patterns, interaction model, and
timeout handling.

## Gotchas

- NEVER record `phase:complete` if checklist shows `done: false` —
  record `phase:checklist_mismatch` and escalate instead
- `5x plan phases` is the authoritative signal for phase completion,
  not step records
- After author fix, re-run quality gates (Step 2), don't skip to
  review (Step 3)
- Read `maxReviewIterations` and `maxQualityRetries` from
  `5x config show` — never hardcode limits
- Phase count should not change during a run — if it does, flag to human

## Tools

- `5x run init --plan <path> [--worktree]` — create or resume a run (use `--worktree` to auto-resolve or create an isolated worktree)
- `5x run state --run <id>` — check what's been done
- `5x run record <step> --run <id> --result '<json>'` — record a step
- `5x run complete --run <id>` — mark run finished
- `5x run list` — list runs (filter by --plan, --status)
- `5x run reopen --run <id>` — reopen a completed/aborted run
- `5x template render <template> --run <id> [--var key=val ...]` — render a task prompt with run/worktree context
- `5x protocol validate <author|reviewer> [--run <id> --record --step <name> ...]` — validate and optionally record structured output
- `5x invoke author <template> --run <id> --var key=val` — invoke author (fallback transport, auto-resolves worktree when `--run` is mapped)
- `5x invoke reviewer <template> --run <id> --var key=val` — invoke reviewer (fallback transport, auto-resolves worktree when `--run` is mapped)
- `5x quality run --run <id>` — run quality gates (auto-resolves worktree when `--run` is mapped)
- `5x plan phases <path>` — get phase list and status
- `5x diff --run <id>` — inspect changes in mapped worktree
- `5x diff --since <ref>` — inspect changes (without run context)
- `5x worktree create --plan <path>` — create isolated worktree (prefer `run init --worktree` instead)
- `5x prompt choose <msg> --options <a,b,c>` — ask the human
- `5x prompt input <msg>` — get human guidance

### Session reuse

Session reuse is optional and best-effort. Capture the session identifier
from the first reviewer invocation as `$REVIEWER_SESSION`. Pass it when
resuming the reviewer for re-reviews within the same phase — this gives
the reviewer conversational continuity with its prior findings. Pass
`--session $REVIEWER_SESSION` to `5x template render` to auto-select a
shorter continued-template variant if one exists. Omit to start fresh.

The `## Context` block in the rendered prompt (appended by
`5x template render` when `--run` resolves a worktree) informs native
subagents of the effective working directory.

### Worktree-aware execution

When a run is mapped to a worktree (via `run init --worktree`), all
`--run`-scoped commands automatically resolve the mapped worktree as
their execution context. You do **not** need to `cd` into the worktree
or pass `--workdir` — the CLI resolves the correct working directory
from the run's worktree mapping.

- `invoke --run` executes the sub-agent in the mapped worktree
- `quality run --run` runs quality gates in the mapped worktree
- `diff --run` diffs the mapped worktree
- All state (run records, logs, locks) stays in the root control-plane DB

For native subagents, the effective working directory is communicated
via the `## Context` block in the rendered prompt (produced by
`5x template render --run`). No additional `cd` or worktree setup is
needed in skill prose.

Explicit `--workdir` still overrides the automatic resolution if needed.
No `.5x/` directory is required in worktree checkouts.

## Workflow

### Step 0: Initialize

    5x run init --plan $PLAN_PATH --worktree

The `--worktree` flag ensures an isolated git worktree is resolved or
created for this plan. The worktree mapping is stored in the root DB,
and all subsequent `--run`-scoped commands automatically execute in
that worktree.

**Timeout note:** `run init --worktree` may take 30+ seconds for large
repositories (git checkout + file operations). Set your shell tool
timeout to at least 120 seconds for this command. If it times out,
retry with a longer timeout — the command is idempotent and will resume
the existing run.

If resuming an existing run (including runs migrated from v0), call
`5x run state --run $RUN` to review recorded history.

Get the phase list: `5x plan phases $PLAN_PATH`

**`plan phases` is the authoritative signal for phase completion** — it
reports `done: true` when all checklist items are checked. Step records
(`phase:complete`) are for auditing but may be incomplete for migrated
v0 runs. Filter to phases where `done` is `false`. Process them in order.

### For each pending phase ($PHASE):

Track $QUALITY_RETRIES = 0 (max 2).
Track $REVIEW_ITERATIONS = 0 (max 3).
Track $REVIEWER_SESSION = "" (for optional session reuse within this phase).

#### Step 1: Author implements

Delegate to the code author using the native-first pattern:

```bash
RENDERED=$(5x template render author-next-phase --run $RUN \
  --var plan_path=$PLAN_PATH --var phase_number=$PHASE_NUMBER)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

if [[ -f ".opencode/agents/5x-code-author.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-code-author.md" ]]; then
  RESULT=<launch native 5x-code-author subagent with PROMPT>
else
  RESULT=$(5x invoke author author-next-phase --run $RUN \
    --var plan_path=$PLAN_PATH --var phase_number=$PHASE_NUMBER 2>/dev/null)
fi

echo "$RESULT" | 5x protocol validate author \
  --run $RUN --record --step $STEP --phase $PHASE
```

Check the result:
- `result: "complete"` with a commit hash — continue to Step 2.
- `result: "complete"` without a commit — **invariant violation**.
  See Recovery.
- `result: "needs_human"` — present the reason and options:
  `5x prompt choose "Author needs help: $REASON" --options provide-guidance,abort`
  If guidance: collect via `5x prompt input`, re-invoke with
  `--var user_notes="$GUIDANCE"`.
- `result: "failed"` — present to human, abort or retry.

Capture $COMMIT from the result for the reviewer.

#### Step 2: Quality gates

    5x quality run --record --run $RUN --phase $PHASE

`--record` auto-records as `quality:check`. When `--run` is mapped to
a worktree, quality gates execute in the mapped worktree automatically.

Check the result:
- `passed: true` — continue to Step 3.
- `skipped: true` — quality gates are intentionally disabled (`skipQualityGates: true` in config). Proceed to Step 3.
- `passed: false` — go to Step 2a (Quality retry).

##### Step 2a: Quality retry

Increment $QUALITY_RETRIES.

If $QUALITY_RETRIES > 2:
  Escalate: `5x prompt choose "Quality gates failing after 2 retries" --options retry,skip,abort`
  - retry: reset $QUALITY_RETRIES, go to Step 2a below
  - skip: record human override, go to Step 3
  - abort: `5x run complete --run $RUN --status aborted`

Delegate fix to the code author using the native-first pattern:

```bash
RENDERED=$(5x template render author-fix-quality --run $RUN \
  --var plan_path=$PLAN_PATH --var phase_number=$PHASE \
  --var user_notes="Quality gate failures: $FAILURES")
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

if [[ -f ".opencode/agents/5x-code-author.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-code-author.md" ]]; then
  RESULT=<launch native 5x-code-author subagent with PROMPT>
else
  RESULT=$(5x invoke author author-fix-quality --run $RUN \
    --var plan_path=$PLAN_PATH --var phase_number=$PHASE \
    --var user_notes="Quality gate failures: $FAILURES" 2>/dev/null)
fi

echo "$RESULT" | 5x protocol validate author \
  --run $RUN --record --step $STEP --phase $PHASE
```

Loop back to Step 2.

#### Step 3: Code review

Delegate to the reviewer using the native-first pattern:

```bash
RENDERED=$(5x template render reviewer-commit --run $RUN \
  --var commit_hash=$COMMIT \
  --var plan_path=$PLAN_PATH \
  ${REVIEWER_SESSION:+--session $REVIEWER_SESSION})
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')
REVIEW_PATH=$(echo "$RENDERED" | jq -r '.data.variables.review_path')

if [[ -f ".opencode/agents/5x-reviewer.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-reviewer.md" ]]; then
  RESULT=<launch native 5x-reviewer subagent with PROMPT>
else
  RESULT=$(5x invoke reviewer reviewer-commit --run $RUN \
    --var commit_hash=$COMMIT \
    --var plan_path=$PLAN_PATH \
    ${REVIEWER_SESSION:+--session $REVIEWER_SESSION} 2>/dev/null)
fi

echo "$RESULT" | 5x protocol validate reviewer \
  --run $RUN --record --step $STEP --phase $PHASE \
  --iteration $REVIEW_ITERATIONS
```

After the reviewer completes and the result is validated, verify the
review document was committed:

    git -C $WORKTREE_PATH log -1 --name-only | grep -q "$REVIEW_PATH"

If the review file was not committed, commit it on behalf of the
reviewer before proceeding:

    git -C $WORKTREE_PATH add $REVIEW_PATH
    git -C $WORKTREE_PATH commit -m "review: phase $PHASE"

When `--session` is passed to `5x template render`, the command
automatically selects an abbreviated continued-template variant if one
exists. Capture $REVIEWER_SESSION for optional reuse in subsequent
reviews.

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

Delegate to the code author using the native-first pattern:

```bash
RENDERED=$(5x template render author-process-impl-review --run $RUN \
  --var plan_path=$PLAN_PATH)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

if [[ -f ".opencode/agents/5x-code-author.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-code-author.md" ]]; then
  RESULT=<launch native 5x-code-author subagent with PROMPT>
else
  RESULT=$(5x invoke author author-process-impl-review --run $RUN \
    --var plan_path=$PLAN_PATH 2>/dev/null)
fi

echo "$RESULT" | 5x protocol validate author \
  --run $RUN --record --step $STEP --phase $PHASE \
  --iteration $REVIEW_ITERATIONS
```

Check the result:
- `result: "complete"` — update $COMMIT, loop back to Step 2
  (quality gates must pass again after changes).
- `result: "needs_human"` — go to Step 5a (Escalate).
- `result: "failed"` — go to Step 5a (Escalate).

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

Before recording phase completion, verify the checklist was updated:

```bash
# Verify checklist completion via the authoritative source
PHASE_STATUS=$(5x plan phases $PLAN_PATH | jq -r ".phases[] | select(.number == $PHASE_NUMBER) | .done")
```

If `PHASE_STATUS` is not `true`:
1. Record the mismatch: `5x run record "phase:checklist_mismatch" --run $RUN --phase $PHASE --result '{"phase":"$PHASE","reason":"checklist_not_updated"}'`
2. Escalate to the human immediately — do NOT proceed with phase:complete

If `PHASE_STATUS` is `true`, record phase completion:

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
- `5x diff --run $RUN --since $COMMIT~1` must show a non-empty diff (auto-resolves worktree)
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
- BEFORE recording `phase:complete`, run `5x plan phases $PLAN_PATH` and confirm current phase shows `done: true`
- If checklist is not updated, record `phase:checklist_mismatch` and escalate to human — do NOT record `phase:complete`
- Phase count should not have changed since the run started

## Recovery

### Checklist mismatch (verification failure)

**Symptom:** Phase completes review/quality but `5x plan phases` shows `done: false` for the current phase.

**Response:**
1. Record `phase:checklist_mismatch` with phase number and reason
2. Stop immediately — do NOT record `phase:complete`
3. Escalate to the human with clear explanation:
   "Phase $PHASE passed review and quality gates, but the plan checklist was not updated. The author must mark completed items with `[x]` in the plan before the phase can be recorded as complete."
4. Wait for human guidance — do NOT auto-reinvoke the author

This is an explicit failure mode. The audit trail must show `phase:checklist_mismatch` rather than a misleading `phase:complete`.

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

### Native subagent returns empty or invalid output

**Symptom:** Native subagent returns no output or output that fails
`5x protocol validate`.

**Response:**
1. Retry once with a fresh session (omit session reuse).
2. If the second attempt fails, fall back to `5x invoke` as the
   transport for this step.
3. If both approaches fail, escalate to the human.

### Subprocess returns empty output

**Symptom:** The `5x invoke` subprocess returns no output.

**Response:**
1. The agent process was likely killed by the shell tool's wall-clock
   timeout before completing. Retry with a longer timeout and a fresh
   session (omit --session).
2. If empty output persists after retry, escalate to the human.

### Structured output validation failure

**Symptom:** `5x protocol validate` returns an error with code
`INVALID_STRUCTURED_OUTPUT`.

**Response:**
1. Retry once with a fresh session.
2. If it fails again, escalate to the human — the model may not support
   the structured output format or the prompt may need adjustment.

## Completion

The workflow is complete when:
1. ALL phases have recorded "phase:complete" steps, AND
2. The run is marked complete via `5x run complete`
