# 5x CLI v1 — Agent Skills

**Status:** Draft — Not Implemented
**Date:** March 4, 2026
**Parent:** `100-architecture.md`

---

## 1. What is a Skill

A skill is a markdown document loaded into the orchestrating agent's context (e.g., as a Claude Code skill, OpenCode system prompt, or equivalent). It tells the agent:

- **What workflow to execute** — the general pattern and steps
- **What tools to use** — the `5x` CLI commands (specified in `101-cli-primitives.md`)
- **What invariants to check** — conditions that must hold at each step
- **How to recover** — heuristics for common failures

Skills are **prescriptive at first** — they read like pseudocode in natural language, with explicit steps the agent follows in order. This minimizes non-determinism while preserving the agent's ability to handle edge cases through reasoning.

Skills are standalone markdown files. They carry no code dependencies. A user can modify a skill or write a new one without touching any TypeScript.

---

## 2. Skill Anatomy

Every skill follows this structure:

```markdown
# Skill: <name>

<1-2 sentence description of the workflow>

## Prerequisites
<What must be true before starting>

## Tools
<CLI commands used, with brief descriptions>

## Workflow
<Step-by-step instructions — the core of the skill>

## Invariants
<Conditions to check; violation triggers recovery>

## Recovery
<What to do when things go wrong>

## Completion
<How to know the workflow is done>
```

### Conventions

- Steps use imperative language: "Invoke the author", "Check the verdict", "Record the step".
- CLI commands are shown as inline code: `5x invoke author next-phase --run $RUN --var phase=$PHASE`.
- Variables use `$NAME` notation for values the agent tracks.
- Recovery patterns reference specific invariant violations.
- Iteration limits are stated explicitly — the agent does not decide its own limits.

---

## 3. Skills

### 3.1 `5x-plan`

Generate an implementation plan from a PRD/TDD, then optionally review and refine it.

```markdown
# Skill: 5x-plan

> **Requires:** v1 CLI primitives (not yet implemented). See `101-cli-primitives.md`.

Generate an implementation plan from a requirements document, then run
review/fix cycles until the plan is approved.

## Prerequisites

- A PRD or TDD document exists at a known path
- The project has a 5x config file (5x.config.js) or uses defaults
- A plan template exists (config paths.templates.plan)

## Tools

- `5x run init --plan <path>` — create or resume a run
- `5x run state --run <id>` — check what's been done
- `5x run record <step> --run <id> --result '<json>'` — record a step
- `5x run complete --run <id>` — mark run finished
- `5x invoke author <template> --run <id> --var key=val` — invoke author sub-agent
- `5x invoke reviewer <template> --run <id> --var key=val` — invoke reviewer sub-agent
- `5x prompt choose <msg> --options <a,b,c>` — ask the human a question
- `5x prompt input <msg>` — get freeform guidance from the human

## Workflow

### Step 1: Initialize

Run `5x run init --plan $PLAN_PATH --command plan`.

If a run already exists (returned by init), call `5x run state --run $RUN`
and skip to the appropriate step based on recorded history.

### Step 2: Generate the plan

Invoke the author to generate the plan:

    5x invoke author author-generate-plan --run $RUN \
      --var prd_path=$PRD_PATH \
      --var plan_path=$PLAN_PATH \
      --var plan_template_path=$TEMPLATE_PATH

Check the result:
- If `result: "complete"` — record the step and continue to Step 3.
- If `result: "needs_human"` — present the reason to the human via
  `5x prompt choose` with options: provide-guidance, abort.
  If guidance, collect it via `5x prompt input` and re-invoke with
  `--var user_notes="$GUIDANCE"`.
- If `result: "failed"` — present the reason to the human and abort.

Record: `5x run record "author:generate-plan" --run $RUN --result '<result>'`

### Step 3: Review loop

This is the same pattern as the 5x-plan-review skill (Section 3.2).
Execute the review loop from that skill starting at the "Review"
step, using the same $RUN (do not create a new run).

### Step 4: Complete

After the review loop approves the plan (or the human overrides):

    5x run complete --run $RUN

Report to the human: plan is ready at $PLAN_PATH.

## Invariants

- After author generates the plan, the plan file must exist at $PLAN_PATH.
- The plan must parse successfully (`5x plan phases $PLAN_PATH` returns phases).
- The plan must have at least one phase.
- Author must produce a commit (AuthorStatus.commit is present). All
  author completions — plan generation, plan revision — must result
  in a committed change.

## Recovery

- **Plan file missing after author claims complete**: The author likely
  wrote to the wrong path. Re-invoke with explicit emphasis on the
  output path. If it fails again, ask the human.
- **Plan has no parseable phases**: The author didn't follow the template
  structure. Re-invoke with a fresh session and explicit instructions
  to follow the template format.
- **Author claims complete but no commit**: Invariant violation — treat
  as context loss. Re-invoke with a fresh session. If it fails again,
  escalate to the human.

## Completion

The workflow is complete when:
1. The plan exists and parses successfully, AND
2. The reviewer approves it (verdict: ready), OR
3. The human explicitly overrides approval
```

---

### 3.2 `5x-plan-review`

Review an existing plan with iterative fix cycles.

```markdown
# Skill: 5x-plan-review

> **Requires:** v1 CLI primitives (not yet implemented). See `101-cli-primitives.md`.

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
- `5x invoke reviewer <template> --run <id> --var key=val` — invoke reviewer
- `5x invoke author <template> --run <id> --var key=val` — invoke author
- `5x prompt choose <msg> --options <a,b,c>` — ask the human
- `5x prompt input <msg>` — get human guidance

## Workflow

Track $ITERATION starting at 1. Maximum 5 review cycles.
Track $REVIEWER_SESSION (initially empty) for reviewer session reuse.

### Step 1: Review

Invoke the reviewer to review the plan:

    5x invoke reviewer reviewer-plan --run $RUN \
      --var plan_path=$PLAN_PATH \
      --var review_path=$REVIEW_PATH \
      --var review_template_path=$REVIEW_TEMPLATE_PATH \
      ${REVIEWER_SESSION:+--session $REVIEWER_SESSION}

Capture $REVIEWER_SESSION from the response for reuse in subsequent reviews.

Record: `5x run record "reviewer:review" --run $RUN --phase plan --result '<result>'`

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
      --var review_path=$REVIEW_PATH \
      --var plan_path=$PLAN_PATH

Check the result:
- `result: "complete"` — record and go to Step 1 (next review cycle).
- `result: "needs_human"` — go to Step 4 (Escalate).
- `result: "failed"` — go to Step 4 (Escalate).

Record: `5x run record "author:revise-plan" --run $RUN --phase plan --result '<result>'`

Increment $ITERATION. If $ITERATION > 5, go to Step 4 (Escalate)
with the message "Maximum review iterations reached."

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

## Completion

The workflow is complete when:
1. The reviewer returns `readiness: "ready"`, OR
2. The human explicitly overrides approval
```

---

### 3.3 `5x-phase-execution`

Execute plan phases with author/quality/reviewer loops.

```markdown
# Skill: 5x-phase-execution

> **Requires:** v1 CLI primitives (not yet implemented). See `101-cli-primitives.md`.

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
```

---

## 4. Shared Recovery Patterns

These patterns appear across all three skills. They are documented here for reference and to avoid duplication in individual skills.

### 4.1 Context Loss Detection

**When to suspect it:** An agent claims success but the output doesn't match the task. Common indicators:
- Empty or trivial diff after claiming `complete`
- Missing commit hash
- Response is generic / doesn't reference specifics from the prompt
- Response addresses a different task entirely

**Standard response:**
1. First attempt: re-invoke with a fresh session (no `--session` flag)
2. Second attempt: if fresh session also fails, escalate to the human

This pattern handles the auto-compaction problem: when a sub-agent's context is compacted mid-session and it loses the original prompt instructions, a fresh session restores full context.

### 4.2 Escalation Pattern

All escalations follow the same structure:

1. Present the situation clearly: what happened, what was expected, what actually occurred
2. Offer choices: continue-with-guidance, approve-override, abort
3. Record the human's decision as a `human:gate` step
4. If guidance was provided, pass it to the next sub-agent invocation via `--var user_notes`

### 4.3 Iteration Limits

Each skill states explicit limits. These are **not negotiable by the agent** — they exist to prevent runaway loops:

| Skill | Limit | Scope |
|---|---|---|
| `5x-plan-review` | 5 review cycles | Total reviewer invocations |
| `5x-phase-execution` | 2 quality retries | Per phase, before escalation |
| `5x-phase-execution` | 3 review iterations | Per phase, before escalation |

When a limit is reached, the agent MUST escalate to the human. It must NOT continue the loop with a "let me try one more time" decision.

### 4.4 Resume Pattern

All skills share the same resume logic:

1. `5x run init` returns an existing active run if one exists for the plan
2. Call `5x run state --run $RUN` to get the full step history
3. Identify the last recorded step and its result
4. Skip to the appropriate workflow step

The agent does not need to re-execute completed steps. The step history in `run state` tells it exactly where to pick up. If the agent is uncertain about the state, it can re-invoke a step — `5x run record` with the same key will not duplicate.

---

## 5. Skill Customization

### User overrides

Users can customize skills by:

1. **Modifying the skill markdown** — skills are standalone files, not code
2. **Adjusting iteration limits** — change the numbers in the skill
3. **Adding recovery patterns** — append new patterns for project-specific failure modes
4. **Changing escalation behavior** — modify what options are presented to the human
5. **Overriding prompt templates** — place custom templates in `.5x/templates/prompts/`

### Writing new skills

New workflow types follow the same anatomy (Section 2). Examples of workflows that could be expressed as skills without any CLI changes:

- **Quick fix:** Author diagnoses and fixes a bug, quality gates, single review pass
- **Refactor:** Author refactors with reviewer checking for regressions
- **Test coverage:** Author writes tests for uncovered code, quality gates verify coverage improvement
- **Migration:** Author executes a migration plan with rollback verification at each phase

Each of these would use the same CLI primitives (`5x invoke`, `5x run record`, `5x quality run`, etc.) with different workflow logic in the skill document.

---

## 6. Skill Distribution

Skills ship with the CLI as reference implementations:

```
.5x/skills/
  5x-plan.md
  5x-plan-review.md
  5x-phase-execution.md
```

The `5x init` command (which already scaffolds `.5x/`, templates, and config) will be updated to also copy the three bundled skills into `.5x/skills/`. Skills can also be referenced directly from the npm package without copying.

Users load a skill into their agent session using the agent's native skill/instruction mechanism:
- **Claude Code:** Add to `.claude/skills/` or reference via CLAUDE.md
- **OpenCode:** Reference in system prompt or instruction file
- **Other agents:** Agent-specific mechanism for loading instructions

**Note:** Skills are not executable until the v1 CLI primitives are implemented. v0 orchestrator commands (`5x plan`, `5x plan-review`, `5x run <plan>`) are removed when v1 ships — skills + v1 primitives are the sole interface.
