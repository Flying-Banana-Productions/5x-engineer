---
name: author-process-impl-review
description: Fix implementation issues from code review
version: 3
variables: [review_path, plan_path, user_notes, run_id]
step_name: "author:fix-review"
variable_defaults:
  user_notes: ""
  run_id: ""
---

You are fixing implementation issues identified in a code review for `{{plan_path}}`.

## Input

- Review document: {{review_path}}
- Implementation plan: {{plan_path}}

## Instructions

1. Read the review document at `{{review_path}}`.
2. If the review has addendums, focus on the **latest addendum** — it contains the most recent feedback. Do a quick sanity check that prior review items are already addressed, but your primary task is the latest addendum.
3. Read the implementation plan at `{{plan_path}}` for context on what was intended.
4. When an `Admitted implementation work` section is appended, implement only those admitted findings and governing decisions. Do not treat the rest of the review Markdown as a work list. Without that section, use the latest addendum's actionable items and still do not invent scope.
   - **P0 blockers** in the admitted list: Must be resolved.
   - **P1 items** in the admitted list: Should be resolved.
   - **P2 items** in the admitted list: Address if they are admitted; do not pull in extra cleanup.

### Working Directory

**Your effective working directory is shown in the `## Context` block at the bottom of this prompt. You MUST `cd` into that directory before reading, editing, running tests, or committing any files.**

The correct branch is already checked out in that directory — do not create, switch, or validate branches. All `git` operations must be run from within that directory. Never run `git commit` directly; always use `5x commit --run {{run_id}}`.

### Scope of Changes

This is a **code implementation** task. You are fixing issues in the source code, not revising the plan document.

- Fix bugs, logic errors, missing error handling, test gaps, and other code issues identified in the review.
- Write or update tests to cover the fixes.
- Run all tests and ensure they pass.
- Update the implementation plan checklist items (`[x]`) only if your fixes complete previously incomplete items.
- Do **not** make structural changes to the plan document (phase descriptions, design decisions, budget table bytes, or new scope). That requires an approved amendment workflow.
- Guarded nonstructural text synchronization is allowed only inside the supplied text guard spans, plus checkbox toggles.
- Do not implement deferred or accepted-risk findings, nonblocking Markdown follow-ups, or scope expansion.
- When the admitted section says this pass is a final correction, change only the eligible item. Do not clean up unrelated code, tests, docs, or plan structure.

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

CRITICAL: You MUST commit all changes using `5x commit` before finishing. The pipeline validates that a commit hash is present in your structured output — omitting it will cause an automatic escalation failure. Do not return with a "complete" result unless you have committed and can provide the commit hash.

When ready to commit, run:

    5x commit --run {{run_id}} -m "<descriptive message>" --all-files

Then produce your structured result:

    5x protocol emit author --complete --commit <hash>

Or if you need human help:

    5x protocol emit author --needs-human --reason "..."

Include the command's JSON output verbatim as your structured result.
The output is raw canonical JSON — do not wrap or modify it.
