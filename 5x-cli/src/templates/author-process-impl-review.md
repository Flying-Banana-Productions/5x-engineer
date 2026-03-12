---
name: author-process-impl-review
version: 1
variables: [review_path, plan_path, user_notes]
step_name: "author:fix-review"
---

You are fixing implementation issues identified in a code review for `{{plan_path}}`.

## Input

- Review document: {{review_path}}
- Implementation plan: {{plan_path}}

## Instructions

1. Read the review document at `{{review_path}}`.
2. If the review has addendums, focus on the **latest addendum** — it contains the most recent feedback. Do a quick sanity check that prior review items are already addressed, but your primary task is the latest addendum.
3. Read the implementation plan at `{{plan_path}}` for context on what was intended.
4. Address all actionable feedback items:
   - **P0 blockers**: Must be resolved.
   - **P1 items**: Should be resolved.
   - **P2 items**: Address if straightforward; note any deferred items.

### Scope of Changes

This is a **code implementation** task. You are fixing issues in the source code, not revising the plan document.

- Fix bugs, logic errors, missing error handling, test gaps, and other code issues identified in the review.
- Write or update tests to cover the fixes.
- Run all tests and ensure they pass.
- Update the implementation plan checklist items (`[x]`) only if your fixes complete previously incomplete items.
- Do **not** make structural changes to the plan document (phase descriptions, design decisions, etc.) — that is a separate workflow.

### Quality Checks

- Re-read the review document after making changes to verify all concerns are addressed.
- Run all tests and ensure they pass before committing.
- Fix any linting or type errors introduced by your changes.
- Commit your changes with a message referencing the review document and (if applicable) which addendum was addressed.

## User Notes

{{user_notes}}

## Non-Interactive Execution

You are running as a delegated non-interactive workflow. There is no human operator available during this invocation. Do NOT use any interactive tools (question, prompt, ask, confirm, etc.) — they will hang indefinitely. If you need human input, return with `result: "needs_human"` and explain what you need in the `reason` field.

## Completion

CRITICAL: You MUST commit all changes to git before finishing. The pipeline validates that a commit hash is present in your structured output — omitting it will cause an automatic escalation failure. Do not return with a "complete" result unless you have committed and can provide the commit hash.

Fix the review items in the codebase and return when done. The structured outcome is captured separately via structured output — you do not need to emit any special blocks.
