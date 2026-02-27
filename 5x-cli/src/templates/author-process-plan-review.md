---
name: author-process-plan-review
version: 1
variables: [review_path, plan_path, user_notes]
---

You are revising the implementation plan at `{{plan_path}}` based on review feedback.

## Input

- Review document: {{review_path}}
- Implementation plan: {{plan_path}}

## Instructions

1. Read the review document at `{{review_path}}`.
2. If the review has addendums, focus on the **latest addendum** — it contains the most recent feedback. Do a quick sanity check that prior review items are already addressed, but your primary task is the latest addendum.
3. Read the implementation plan at `{{plan_path}}` thoroughly.
4. Address all actionable feedback items:
   - **P0 blockers**: Must be resolved.
   - **P1 items**: Should be resolved.
   - **P2 items**: Address if straightforward; note any deferred items.

### Scope of Changes

This is a **document-only** task. You are revising the implementation plan, not writing code.

- Edit the plan document at `{{plan_path}}` to address review feedback.
- Update phase descriptions, completion gates, checklist items, design decisions, and file tables as needed.
- Add a revision history entry documenting what changed.
- Do **not** create, modify, or delete any source code, test files, or configuration files.
- Do **not** run tests or quality gates.

### Quality Checks

- Re-read the review document after making changes to verify all concerns are addressed.
- Ensure the plan remains internally consistent (phases reference correct dependencies, file tables match described changes, etc.).
- Commit your plan changes with a message referencing the review document and (if applicable) which addendum was addressed.

## User Notes

{{user_notes}}

## Completion

Address the review items in the plan document and return when done. The structured outcome is captured separately via structured output — you do not need to emit any special blocks.
