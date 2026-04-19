---
name: reviewer-commit-continued
description: Re-review revised implementation commits
version: 1
variables: [commit_hash, review_path, plan_path, review_template_path, run_id, previous_review_commit, current_commit]
step_name: "reviewer:review"
variable_defaults:
  run_id: ""
  previous_review_commit: ""
  current_commit: ""
---

The implementation at commit `{{commit_hash}}` has been revised since your last review. Re-review it now.

## Context Since Last Review

- Previous review commit: `{{previous_review_commit}}`
- Current commit: `{{current_commit}}`

Examine `git log --oneline {{previous_review_commit}}..{{current_commit}}` and the corresponding diffs to understand what changed. Focus your review on the new and modified code.

Treat line numbers from your prior findings as potentially stale — re-anchor them against the current source. For each previously raised issue, decide whether it is **addressed**, **partially addressed**, or **still open**, and say so explicitly in the addendum below.

## Input

- Commit to review: {{commit_hash}}
- Review output path: {{review_path}}
- Implementation plan: {{plan_path}}
- Review template path: {{review_template_path}}

## Instructions

1. Examine the changes between `{{previous_review_commit}}` and `{{current_commit}}`.
2. Read the implementation plan at `{{plan_path}}` for context on what was intended.
3. Walk through your prior findings and classify each one against the current state.
4. Surface any new issues introduced by the revision.
5. Write your updated assessment as a new **Addendum** section appended to `{{review_path}}`. Do not modify existing review content.

### Review Perspective

Evaluate the implementation across these dimensions:

- **Correctness**: Does the code do what the plan specifies? Are there bugs or logic errors?
- **Architecture**: Does the implementation fit the existing architecture? Are patterns consistent?
- **Security**: Are there injection risks, auth gaps, data exposure, or unsafe operations?
- **Performance**: Are there obvious performance issues? N+1 queries, unbounded loops, missing indexes?
- **Operability**: Error handling, logging, monitoring hooks, graceful degradation?
- **Test strategy**: Are the tests sufficient? Do they test the right things? Edge cases covered?
- **Plan compliance**: Does the work match the phase requirements in the implementation plan?

### Issue Classification

For each issue, you MUST classify its `action` for the 5x orchestrator:

- **`auto_fix`**: The correct fix is directly derivable from the codebase, plan, or git history
  without judgment calls. Ask: *could a competent engineer look at the existing code and arrive
  at the fix with high confidence, without asking anyone?* If yes, it's `auto_fix`. Examples:
  missing null check, incorrect type, missing test case, off-by-one error, missing error handling
  for a documented edge case, restoring content from git history, adding a flag already used
  elsewhere in the same file, correcting a doc claim that contradicts what the code actually does,
  replacing wording that has an obvious canonical form in the codebase.

- **`human_required`**: The correct fix requires choosing between legitimate alternatives, a policy
  or scope decision, or information not present in the codebase. Examples: API design choices,
  architectural trade-offs, scope decisions, business logic ambiguity, security policy, UX
  decisions, anything where two reasonable engineers could disagree.

Classify as `human_required` only when the fix genuinely requires a choice that cannot be derived
from what already exists. The "when in doubt" fallback is for true ambiguity — not for fixes that
feel uncertain but have an objectively correct answer in context.

### Readiness Assessment

Provide an overall readiness assessment:

- **ready**: Implementation is production-ready and phase can be considered complete.
- **ready_with_corrections**: Implementation needs corrections but they are all mechanical (auto_fix). Use this when only P2/cosmetic `auto_fix` items remain — if there are no blockers and no `human_required` items, the implementation is ready with corrections, not "not ready".
- **not_ready**: Implementation has fundamental issues requiring human decisions or significant rework. Reserve this for P0/P1 blockers or items that require `human_required` action. Do not use `not_ready` when the only remaining items are low-priority cosmetic fixes.

## Non-Interactive Execution

You are running as a delegated non-interactive workflow. Do NOT use any interactive tools (question, prompt, ask, confirm, etc.). If you need human judgment on an issue, classify it as `human_required` in your review items.

## Completion

Write your updated review to `{{review_path}}` and commit it:

    5x commit --run {{run_id}} --files {{review_path}} -m "review: update implementation review for <phase or context summary>"

Produce your structured verdict by running `5x protocol emit reviewer` with `--ready` or `--no-ready` and `--item` flags. Include the command's JSON output verbatim as your structured result. Do not wrap it in markdown fences.
