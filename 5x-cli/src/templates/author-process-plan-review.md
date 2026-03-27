---
name: author-process-plan-review
description: Revise a plan based on review feedback
version: 2
variables: [review_path, plan_path, user_notes, run_id]
step_name: "author:fix-review"
variable_defaults:
  user_notes: ""
  run_id: ""
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

### Working Directory

**Your effective working directory is shown in the `## Context` block at the bottom of this prompt. You MUST `cd` into that directory before reading, editing, or committing any files.**

The correct branch is already checked out in that directory — do not create, switch, or validate branches. All `git` operations must be run from within that directory. Never run `git commit` directly; always use `5x commit --run {{run_id}}`.

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

## Non-Interactive Execution

You are running as a delegated non-interactive workflow. There is no human operator available during this invocation. Do NOT use any interactive tools (question, prompt, ask, confirm, etc.) — they will hang indefinitely. If you need human input, return with `result: "needs_human"` and explain what you need in the `reason` field.

## Completion

CRITICAL: You MUST commit all changes using `5x commit` before finishing. The pipeline validates that a commit hash is present in your structured output — omitting it will cause an automatic escalation failure. Do not return with a "complete" result unless you have committed and can provide the commit hash.

When ready to commit, run:

    5x commit --run {{run_id}} --phase plan -m "<descriptive message>" --all-files

Then produce your structured result:

    5x protocol emit author --complete --commit <hash>

Or if you need human help:

    5x protocol emit author --needs-human --reason "..."

Include the command's JSON output verbatim as your structured result.
The output is raw canonical JSON — do not wrap or modify it.
