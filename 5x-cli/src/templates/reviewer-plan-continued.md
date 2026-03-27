---
name: reviewer-plan-continued
description: Re-review a revised implementation plan
version: 2
variables: [plan_path, review_path, run_id]
step_name: "reviewer:review"
variable_defaults:
  run_id: ""
---

The plan at `{{plan_path}}` has been revised since your last review. Re-review it now.

## Instructions

1. Read the updated plan at `{{plan_path}}`.
2. Read any new changes in referenced implementation files if the plan mentions them.
3. Check whether previously raised issues have been addressed.
4. Write your updated assessment as a new **Addendum** section appended to `{{review_path}}`. Do not modify existing review content.

Follow the same review perspective, issue classification (`auto_fix` / `human_required`), and readiness assessment (`ready` / `ready_with_corrections` / `not_ready`) from your initial review prompt.

## Non-Interactive Execution

You are running as a delegated non-interactive workflow. Do NOT use any interactive tools (question, prompt, ask, confirm, etc.). If you need human judgment on an issue, classify it as `human_required` in your review items.


## Completion

CRITICAL: You MUST use `5x commit` (not `git commit`) to commit your review. The pipeline tracks commits via `5x commit` — using raw git commands will leave the commit unrecorded.

Write your updated review to `{{review_path}}` and commit the file:

    5x commit --run {{run_id}} --phase plan --files {{review_path}} -m "docs: update plan review for <plan name>"

Produce your structured verdict by running `5x protocol emit reviewer` with `--ready` or `--no-ready` and `--item` flags. Include the command's JSON output verbatim as your structured result. Do not wrap it in markdown fences.
