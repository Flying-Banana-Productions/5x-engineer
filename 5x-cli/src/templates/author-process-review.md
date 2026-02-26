---
name: author-process-review
version: 1
variables: [review_path, plan_path, user_notes]
---

You are addressing review feedback for the implementation plan at `{{plan_path}}`.

## Input

- Review document: {{review_path}}
- Implementation plan: {{plan_path}}

## Instructions

1. Read the review document at `{{review_path}}`.
2. If the review has addendums, focus on the **latest addendum** — it contains the most recent feedback. Do a quick sanity check that prior review items are already addressed, but your primary task is the latest addendum.
3. Read the implementation plan at `{{plan_path}}` for context.
4. Address all actionable feedback items:
   - **P0 blockers**: Must be resolved.
   - **P1 items**: Should be resolved.
   - **P2 items**: Address if straightforward; note any deferred items.

### Scope of Changes

- If the task is to revise a **design or implementation plan document only**, make document changes and skip code/test modifications.
- If the task involves **code changes**, implement the fixes, run tests, and ensure they pass.
- Update the implementation plan as needed to maintain consistency with any changes.

### Quality Checks

- Re-read the review document after making changes to verify all concerns are addressed.
- If code was changed, run all tests and ensure they pass.
- Commit your changes with a message referencing the review document and (if applicable) which addendum was addressed.

## User Notes

{{user_notes}}

## Completion

Address the review items and return when done. The structured outcome is captured separately via structured output — you do not need to emit any special blocks.
