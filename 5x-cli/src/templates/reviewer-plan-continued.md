---
name: reviewer-plan-continued
description: Re-review a revised implementation plan
version: 4
variables: [plan_path, review_path, run_id, previous_review_commit, current_commit]
step_name: "reviewer:review"
variable_defaults:
  run_id: ""
  previous_review_commit: ""
  current_commit: ""
---

The plan at `{{plan_path}}` has been revised since your last review. Re-review it now.

## Context Since Last Review

- Previous review commit: `{{previous_review_commit}}`
- Current commit: `{{current_commit}}`

A `## Plan Diff Since Last Review` section is appended to this prompt with the actual diff of the plan file across that commit range. Read it first.

Treat line numbers from your prior findings as potentially stale — re-anchor them against the current plan. For each previously raised issue, decide whether it is **addressed**, **partially addressed**, or **still open**, and say so explicitly in the addendum below.

## Instructions

1. Read the updated plan at `{{plan_path}}` in full.
2. Read any new changes in referenced implementation files if the plan mentions them.
3. Walk through your prior findings and classify each one against the new state.
4. Surface any new issues introduced by the revision.
5. Write your updated assessment as a new **Addendum** section appended to `{{review_path}}`. Do not modify existing review content.

Follow the same review perspective, issue classification (`auto_fix` / `human_required`), and readiness assessment (`ready` / `ready_with_corrections` / `not_ready`) from your initial review prompt.

## Non-Interactive Execution

You are running as a delegated non-interactive workflow. Do NOT use any interactive tools (question, prompt, ask, confirm, etc.). If you need human judgment on an issue, classify it as `human_required` in your review items.


## Completion

CRITICAL: You MUST use `5x commit` (not `git commit`) to commit your review. The pipeline tracks commits via `5x commit` — using raw git commands will leave the commit unrecorded.

Write your updated review to `{{review_path}}` and commit the file:

    5x commit --run {{run_id}} --phase plan --files {{review_path}} -m "docs: update plan review for <plan name>"

Produce your structured verdict by running `5x protocol emit reviewer` with `--ready` or `--no-ready` and `--item` flags. Include the command's JSON output verbatim as your structured result. Do not wrap it in markdown fences.
