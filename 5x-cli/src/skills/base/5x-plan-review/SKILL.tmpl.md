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

{{#if any_native}}
## Two kinds of session (disambiguation)

The word "session" means two different things, and mixing them up is the
single most common cause of stale re-reviews:

- **Provider session id** — a value persisted in `steps.session_id` that
  identifies a conversation on the AI provider side (populated when the
  invoke path is used). Consumed by `5x template render --session <id>`.
- **Native subtask id** (`$NATIVE_SUBTASK_ID`) — the id returned by the
  harness when spawning a native subagent. The 5x CLI has no knowledge
  of this id. It goes on the native continuation parameter
  (`[[NATIVE_CONTINUE_PARAM]]`) and **must never** be passed as
  `--session`.

When continuing a native subagent reviewer for a re-review, use
`5x template render --continue-native` so the CLI selects the
`-continued` template variant without expecting a provider session id.
Only use `--new-session` for recovery (context loss, empty output).
{{/if}}

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
- The baseline-pinned mode controls a run. Later config edits do not promote,
  disable, or otherwise change an active run.
- In an enforced active run, route only from
  `.data.result.governance.route` after validation/recording. Never infer a
  gate from reviewer prose/readiness and never recompute budget thresholds.
- Advisory/off and mid-review `v1_compat` runs retain v1 readiness/action
  routing. Advisory governance diagnostics and hypothetical routes are
  telemetry only.
- Initial active-budget reviews require `baselineAssessment` and assessments
  for every current author `DCn`. Continued reviews must omit the baseline
  assessment and assess only author claims that are new or changed; unchanged
  assessments are carried forward by the CLI.

## Tools

`--run` is optional on run-scoped commands when `FIVEX_RUN`, a unique
worktree mapping, or `.5x/current-run` already identifies the run. Pass
`--run` explicitly in Recovery or when identity is missing/ambiguous.

- `5x run init --plan <path> [--worktree]` — create or resume a run (use `--worktree` to auto-resolve or create an isolated worktree). Export `FIVEX_RUN` from the envelope (`run_id` or `export_hint`).
- `5x run state` — check what's been done (ambient run identity)
- `5x run record <step> --result '<json>'` — record a step
- `5x run complete` — mark run finished
- `5x run list` — list runs (filter by --plan, --status); marks the ambiently resolved run
- `5x template render <template> [--var key=val ...]` — render a task prompt with run/worktree context
{{#if any_native}}
- `5x protocol validate <author|reviewer> [--record --step <name> ...]` — validate and optionally record structured output (native roles)
{{/if}}
{{#if any_invoke}}
- `5x invoke <author|reviewer> <template> [--var key=val ...]` — invoke role workflow, validate structured output, and optionally record with `--record` (invoke roles)
{{/if}}
- `5x plan phases <path>` — verify plan still parses after revisions
- `5x review gate show` — show the current durable gate, allowed choices,
  eligible finding identities, and `requiredFieldsByChoice`
- `5x review decide --gate <id> ...` — submit a complete gate decision and
  return the CLI-derived post-decision route
{{#if reviewer_native}}
- `5x protocol validate reviewer --opt-in-budget-baseline ...` — after an
  explicit human confirmation, activate budgeting for a mid-review
  `v1_compat` run whose current plan has a valid Delivery Budget
{{/if}}
{{#if reviewer_invoke}}
- `5x invoke reviewer reviewer-plan --opt-in-budget-baseline ...` — after an
  explicit human confirmation, activate budgeting for a mid-review
  `v1_compat` run whose current plan has a valid Delivery Budget
{{/if}}
{{#if any_native}}
- Human gates (legacy v1 escalations only) — use your **native UI** (see `5x` foundation skill). Record with `5x run record "human:gate"` using the JSON shapes below. Enforced review gates use `5x review decide`, never this generic path.
- **`5x prompt` fallback** — only when no chat UI exists; use `--default` if stdin is not a TTY.
{{/if}}
{{#if all_invoke}}
- `5x prompt choose <msg> --options <a,b,c>` — ask the human for legacy v1 escalations only; never answer a typed plan-review gate this way
- `5x prompt input <msg>` — revise orchestrator-drafted guidance when the human modifies it
{{/if}}

{{#if reviewer_native}}
### Delegating sub-agent work (native reviewer)

**Canonical delegation example (reviewer:review):**

```bash
# 1. Render the prompt (output follows standard outputSuccess envelope)
#    review_path is auto-generated — do NOT pass --var review_path.
#    Read the auto-generated path from .data.variables.review_path in the output.
#    Re-reviews: add --continue-native when reusing a native subagent (it
#    selects the -continued template variant without a provider session id).
#    Never pass $NATIVE_SUBTASK_ID as --session — that flag takes a provider
#    session id (persisted in steps.session_id), not a harness task id.
RENDERED=$(5x template render reviewer-plan \
  ${NATIVE_SUBTASK_ID:+--continue-native})
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')
REVIEW_PATH=$(echo "$RENDERED" | jq -r '.data.variables.review_path')

# 2. Launch subagent via Task tool (pass the native continuation parameter to continue the same reviewer)
RESULT=<Task tool: subagent_type="5x-reviewer", prompt=$PROMPT,
        [[NATIVE_CONTINUE_PARAM]]=$NATIVE_SUBTASK_ID (omit if empty)>

# 3. Validate + record
VALIDATED=$(echo "$RESULT" | 5x protocol validate reviewer \
  --record --step $STEP --phase plan --iteration $ITERATION)
GOVERNANCE_ROUTE=$(echo "$VALIDATED" | jq -r \
  '.data.result.governance.route // empty')

# 4. Capture agent id for reuse in subsequent reviews
NATIVE_SUBTASK_ID=<agent id from Task tool result>
```

**Task reuse** is expected when `reviewer.continuePhaseSessions` is
enabled and the reviewer is native. If a prior reviewer step exists for
the current phase, `5x template render` requires a continuation signal.
For native reviewers pass **`--continue-native`** — this selects the
`reviewer-plan-continued` template (which includes the diff since the
prior review) without expecting a provider session id. Pass
**`[[NATIVE_CONTINUE_PARAM]]=$NATIVE_SUBTASK_ID`** on the Task tool for
subagent continuity. Use `--new-session` only for recovery
(context loss, empty output).

The `--session <id>` flag is reserved for the invoke path — it takes a
provider session id, not the native subtask id. Mixing the two is a
common source of stale re-reviews.
{{/if}}
{{#if reviewer_invoke}}
### Delegating review/author work with invoke (invoke reviewer)

**Canonical delegation example (reviewer:review):**

```bash
RESULT=$(5x invoke reviewer reviewer-plan \
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

### Step 0: Resolve delegation mode

Before the first author or reviewer delegation, read resolved config (see
the `5x` foundation skill — **Delegation mode precedence**):

```bash
5x config show --context $PROJECT_DIR
```

Confirm each role's path before delegating:
{{#if author_native}}
- **Author:** native (`5x-plan-author` via Task tool)
{{/if}}
{{#if author_invoke}}
- **Author:** invoke (`5x invoke author ...`)
{{/if}}
{{#if reviewer_native}}
- **Reviewer:** native (`5x-reviewer` via Task tool)
{{/if}}
{{#if reviewer_invoke}}
- **Reviewer:** invoke (`5x invoke reviewer ...`)
{{/if}}

If your chosen delegation path does not match the resolved
`delegationMode` for that role, stop and correct before proceeding.

If you do not already have `FIVEX_RUN` exported for this plan:

```bash
INIT=$(5x run init --plan $PLAN_PATH --worktree)
export FIVEX_RUN=$(echo "$INIT" | jq -r '.data.run_id')
```

If a run already exists, export `FIVEX_RUN` from the init envelope or
from `5x run state --plan $PLAN_PATH`.

Track $ITERATION starting at 1. Read `maxReviewIterations` from `5x config show` for the maximum.
{{#if reviewer_native}}
Track $NATIVE_SUBTASK_ID (initially empty). When `reviewer.continuePhaseSessions`
is enabled, pass **`[[NATIVE_CONTINUE_PARAM]]=$NATIVE_SUBTASK_ID`** on the Task tool on
subsequent reviews AND **`--continue-native`** on `5x template render` so
it emits the `reviewer-plan-continued` variant (with the diff since the
prior review). Never pass the native subtask id as `--session` — that
flag takes a provider session id (a distinct concept used only on the
invoke path).
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

Before the first reviewer invocation, inspect `5x run state`:

- A new run in advisory mode should acquire an active baseline when the first
  `reviewer-plan` template is rendered. If rendering fails with
  `BUDGET_SECTION_MISSING`, `BUDGET_DEBT_CLAIM_EVIDENCE_MISSING`, or another
  budget parse diagnostic, invoke the plan author to add/fix the Delivery
  Budget, Surface Snapshot, and complete `#### DCn` evidence, commit the plan,
  then retry the first render. Read the plan before drafting guidance; do not
  invent scores, target phases, minimal alternatives, or before/after text.
- If `review_budget.status` is `v1_compat`, stay on the v1 path. Offer budget
  opt-in to the human; only after explicit confirmation and after the table is
  valid may the next recorded reviewer validation/invocation use
  `--opt-in-budget-baseline`. Record the confirmation as a `human:gate`.
- `reviewBudget.mode = "off"` remains v1. An active baseline pinned to
  `enforced` validates closure evidence and makes the CLI-derived governance
  route authoritative. A baseline pinned to `advisory` records diagnostics
  while preserving v1 routing.

### Step 1: Review

{{#if reviewer_native}}
Delegate to the reviewer via the Task tool:

```bash
RENDERED=$(5x template render reviewer-plan \
  ${NATIVE_SUBTASK_ID:+--continue-native})
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')
REVIEW_PATH=$(echo "$RENDERED" | jq -r '.data.variables.review_path')

RESULT=<Task tool: subagent_type="5x-reviewer", prompt=$PROMPT,
        [[NATIVE_CONTINUE_PARAM]]=$NATIVE_SUBTASK_ID (omit if empty)>

VALIDATED=$(echo "$RESULT" | 5x protocol validate reviewer \
  --record --step $STEP --phase plan --iteration $ITERATION)
GOVERNANCE_ROUTE=$(echo "$VALIDATED" | jq -r \
  '.data.result.governance.route // empty')
```

`--continue-native` selects the `reviewer-plan-continued` template
variant, which includes the commit range and plan diff since the prior
review so the subagent can rebase its findings against the new state.

Capture `$NATIVE_SUBTASK_ID` from the Task tool result for reuse in
subsequent reviews.
{{else}}
Delegate to the reviewer via `5x invoke`:

```bash
# Extract review_path for reporting/audit
REVIEW_PATH=$(5x template render reviewer-plan \
  ${SESSION_ID:+--session $SESSION_ID} \
  | jq -r '.data.variables.review_path')

RESULT=$(5x invoke reviewer reviewer-plan \
  ${SESSION_ID:+--session $SESSION_ID} \
  --record --record-step reviewer:plan --phase plan --iteration $ITERATION)

READINESS=$(echo "$RESULT" | jq -r '.data.result.readiness')
ITEM_COUNT=$(echo "$RESULT" | jq -r '.data.result.items | length')
GOVERNANCE_ROUTE=$(echo "$RESULT" | jq -r '.data.result.governance.route // empty')
SESSION_ID=$(echo "$RESULT" | jq -r '.data.session_id // empty')
```
{{/if}}

For an active budget, verify the reviewer follows the rendered prompt:

- The first review emits one independent `baselineAssessment` (`I`) and a
  `creditAssessment` for every current author-ledger `DCn`.
- Continued reviews omit `baselineAssessment` and emit credit assessments only
  for new/changed claims. Claim equality includes coupling, work-item
  architecture delta, target phase, both minimal-compliant deltas, before, and
  after. Omission of an unchanged claim is correct.
- Every item carries stable identity and per-item deltas. Reviewers never emit
  totals, ceilings, bands, status, `requiresHuman`, or other CLI-owned budget
  aggregates. `creditClaim` is only for a reviewer-introduced claim, not a copy
  of persisted author `DCn` evidence.

### Step 2: Route the recorded verdict

Read `5x run state`. If `review_budget.enforcement_implemented` is `true`, the
recorded result must contain `.data.result.governance.route`; use that route
and no other signal:

- `complete` → Step 5.
- `author_revision` → Step 3 with reviewer re-entry enabled.
- `final_corrections` → Step 3 with final-correction mode enabled.
- `human_gate` → Step 4A.

Do not use reviewer readiness, item action, prose, budget bands, or
`budget.requiresHuman` to override an enforced route. A missing governance
route on an enforced active run is an invariant failure and must be escalated.

For pinned advisory, mode off, and `v1_compat`, preserve v1 routing: `ready`
completes; actionable `auto_fix` items go to Step 3 with reviewer re-entry;
any `human_required` item or `not_ready` without actionable items goes to the
legacy Step 4 escalation. `ready_with_corrections` remains an ordinary v1
author/re-review cycle on these paths. Ignore advisory hypothetical routes.
Ignore `result.budget.requiresHuman` for routing on these v1-compatible paths.
The legacy structured outcomes remain `readiness: "ready"`,
`readiness: "ready_with_corrections"`, and `readiness: "not_ready"`.

### Step 3: Author revision or final corrections

Before delegation, set `$FINAL_CORRECTIONS=true` only when the enforced route
was `final_corrections`; otherwise set it to false.

{{#if author_native}}
Delegate to the plan author via the Task tool:

```bash
RENDERED=$(5x template render author-process-plan-review)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

RESULT=<Task tool: subagent_type="5x-plan-author", prompt=$PROMPT>

echo "$RESULT" | 5x protocol validate author \
  --record --step $STEP --phase plan \
  --no-phase-checklist-validate
```
{{else}}
Delegate to the plan author via `5x invoke`:

```bash
RESULT=$(5x invoke author author-process-plan-review \
  --record --record-step author:process-plan-review --phase plan)

STATUS=$(echo "$RESULT" | jq -r '.data.result.result')
COMMIT=$(echo "$RESULT" | jq -r '.data.result.commit // empty')
SESSION_ID=$(echo "$RESULT" | jq -r '.data.session_id // empty')
```
{{/if}}

Check the result:
- `result: "complete"` — verify `AuthorStatus.commit` is present and run
  `5x plan phases $PLAN_PATH`. If `$FINAL_CORRECTIONS=true`, record the author
  step through the normal validation/invoke command and go directly to Step 5:
  this is exactly one bounded author pass and must not re-enter the reviewer.
  Otherwise continue to the next review cycle.
- `result: "needs_human"` — go to Step 4 (Escalate).
- `result: "failed"` — go to Step 4 (Escalate).

For ordinary author revisions, increment $ITERATION. If $ITERATION exceeds
`maxReviewIterations` (read from resolved `5x config show`), go to Step 4
(Escalate) with the message "Maximum review iterations reached." Final
corrections do not consume or restart a closure-review cycle.

Only successful review-then-author cycles increment $ITERATION.
Author retries due to timeout, empty output, or transient failures
do not count. The `maxReviewIterations` limit applies to completed
review cycles, not total invocations.

Loop back to Step 1.

### Step 4A: Enforced human gate

Run `5x review gate show`, set `$GATE_ID` from `.data.gateId`, and present its notification, stable gate ID, causes,
`allowedChoices`, eligible finding IDs/fingerprints, and
`requiredFieldsByChoice` to the human. Do not answer the notification with
`5x prompt`, `prompt answer`, or a generic `human:gate` record: the gate-scoped
decision record is the authority.

If this workflow is itself running in a delegated noninteractive context,
return `needs_human` with the gate ID and choices instead of trying to open an
interactive prompt.

After the human chooses, derive required fields from the displayed
`requiredFieldsByChoice` (do not maintain a skill-side choice matrix):

```bash
5x review decide --gate "$GATE_ID" --choice "$CHOICE" \
  --rationale "$RATIONALE" \
  [--evidence "$EVIDENCE"] [--finding "$FINDING_ID"] \
  [--retain "$SCOPE"] [--remove "$SCOPE"] [--baseline "$B"] \
  [--approved-p "$P"] [--approved-item "$ITEM_ID"] \
  [--approved-work-item "$WORK_ITEM_ID"]
```

Simple flag submissions pass only the finding ID shown by `review gate show`;
the CLI resolves its fingerprint. Complex/adapted submissions use
`5x review decide --gate "$GATE_ID" --input-json -` and a JSON payload whose
`findingRefs` contains the exact ID/fingerprint pair returned by gate show.
Never invent or copy a stale fingerprint.

Read the decision command's `.data.route`, which is the durable
`routeAfterDecision` result, and branch explicitly:

- `complete` → Step 5.
- `author_revision` → Step 3 with reviewer re-entry.
- `final_corrections` → Step 3 with `$FINAL_CORRECTIONS=true`, then Step 5.
- `human_gate` → run `5x review gate show` again for the one successor gate and
  repeat Step 4A using its new ID/context.
- `aborted` → stop; terminal handling is already recorded.

Never resume from stale reviewer readiness or prose after a decision. On
restart, first use `5x review gate show`. If it returns an open gate, take the
new `$GATE_ID` from `.data.gateId` and continue Step 4A. If it returns
`{"open":false}` after your decision was durably recorded but before you saved
its route, re-submit the **identical** `5x review decide` command/payload for
that original gate ID. Gate decisions are idempotent: the retry returns the
winning decision's `.data.route`, which is the only recovery routing signal.
Therefore retain the submitted gate ID and exact decision payload until its
route has been acted on. Do not replay a generic prompt answer or reconstruct a
route from reviewer readiness.

### Step 4: Legacy v1 escalation

For each `human_required` review item (and any ambiguous context in
$REASON), draft a concrete recommendation for how the author should resolve
it. Present these recommendations to the human along with the escalation
reason — do not ask the human to write guidance from scratch.

{{#if any_native}}
Present the situation to the human using your **native UI** (multiple choice + freeform where needed). Match the semantics of:

- **Options:** continue-with-guidance, approve-override, abort
- Include your per-item recommendations in the presentation.
- **CLI equivalent (fallback only):**  
  `5x prompt choose "Review requires human input: $REASON" --options continue-with-guidance,approve-override,abort`

**If "continue-with-guidance":**
  Present your recommendations in a structured summary (item id, issue,
  recommendation). Ask the human to **approve as-is** or **modify** before
  sending back to the author. Default posture: your recommendations are the
  draft guidance. If they modify, merge their edits into the final guidance
  text.
  Record:  
  `5x run record "human:gate" --run $RUN --phase plan --result '{"choice":"continue","guidance":"..."}'`  
  Re-invoke the author (Step 3) with `--var user_notes="$GUIDANCE"`.

**If "approve-override":**
  Record: `5x run record "human:gate" --run $RUN --phase plan --result '{"choice":"override"}'`
  Go to Step 5 (Complete).

**If "abort":**
  `5x run complete --run $RUN --status aborted --reason "Human chose to abort"`
  Stop.
{{else}}
Present the situation and your per-item recommendations to the human:

    5x prompt choose "Review requires human input: $REASON" \
      --options continue-with-guidance,approve-override,abort

**If "continue-with-guidance":**
  Ask the human to approve your recommendations as-is or modify them:

    5x prompt choose "Send these recommendations to the author?" \
      --options approve-as-is,modify

  If "approve-as-is", use your drafted recommendations as $GUIDANCE.
  If "modify": `5x prompt input "Revise the guidance for the author" --multiline`
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

    5x run complete

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
- **Missing or ambiguous run identity**: pass `--run` on granular commands, for example
  `5x run record "human:gate" --run $FIVEX_RUN --phase plan --result '...'`,
  `5x commit --run $FIVEX_RUN -m "plan: revise" --all-files`.
{{#if any_native}}
  Native recovery also uses
  `5x protocol validate reviewer --record --run $FIVEX_RUN --step $STEP --phase plan --iteration $ITERATION` and
  `5x protocol validate author --record --run $FIVEX_RUN --step $STEP --phase plan --no-phase-checklist-validate`.
{{/if}}
- **SESSION_REQUIRED error**: `5x template render` requires a
  continuation signal because `continuePhaseSessions` is enabled and
  prior steps exist.
{{#if reviewer_native}}
  For native reviewers pass **`--continue-native`** (and keep reusing
  `[[NATIVE_CONTINUE_PARAM]]=$NATIVE_SUBTASK_ID` on the native
  delegation). Never pass a native subtask id as `--session`.
{{else}}
  For invoke reviewers pass **`--session`** with the provider's
  `session_id`.
{{/if}}
  Use **`--new-session`** only for recovery (context loss, empty
  output).

## Completion

The workflow is complete when:
1. The reviewer returns `readiness: "ready"`, OR
2. The human explicitly overrides approval
