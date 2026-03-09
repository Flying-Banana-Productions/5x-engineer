---
name: reviewer-plan-continued
version: 1
variables: [plan_path, review_path]
step_name: "reviewer:review"
---

The plan at `{{plan_path}}` has been revised since your last review. Re-review it now.

## Instructions

1. Read the updated plan at `{{plan_path}}`.
2. Read any new changes in referenced implementation files if the plan mentions them.
3. Check whether previously raised issues have been addressed.
4. Write your updated assessment as a new **Addendum** section appended to `{{review_path}}`. Do not modify existing review content.

Follow the same review perspective, issue classification (`auto_fix` / `human_required`), and readiness assessment (`ready` / `ready_with_corrections` / `not_ready`) from your initial review prompt.

## Non-Interactive Execution

You are running as a subprocess in an automated pipeline. Do NOT use any interactive tools (question, prompt, ask, confirm, etc.). If you need human judgment on an issue, classify it as `human_required` in your review items.

## Completion

Write your updated review to `{{review_path}}` and return your structured verdict (readiness, items, summary).
