---
name: author-fix-quality
version: 1
variables: [plan_path, phase_number, user_notes]
step_name: "author:fix-quality"
---

You are fixing quality gate failures for Phase {{phase_number}} of `{{plan_path}}`.

## Input

- Implementation plan: {{plan_path}}
- Phase: {{phase_number}}
- Quality failures: see User Notes below for specific failures

## Instructions

1. Read the implementation plan at `{{plan_path}}` to understand what Phase {{phase_number}} was intended to accomplish.
2. Identify the quality gate failures listed in the User Notes below.
3. Fix the failing tests, lint errors, type check failures, or other quality issues.
4. Run the quality gates locally to verify the fixes:
   - Run tests and ensure they pass
   - Run linting and fix any errors
   - Run type checking and fix any errors
5. Update the implementation plan checklist items (`[x]`) only if your fixes complete previously incomplete items.
6. Commit your changes with a message referencing the quality fixes.

### Scope of Changes

This is a **quality remediation** task. You are fixing code to pass quality gates, not addressing code review feedback (that uses a separate workflow).

- Fix failing tests by correcting the underlying code or updating tests if they are outdated
- Fix lint errors by correcting code style issues
- Fix type errors by adding proper types or correcting type mismatches
- Do **not** make structural changes to the plan document
- Do **not** change the phase scope or design decisions

### Quality Checks

- Run all tests and ensure they pass before committing
- Fix any linting or type errors introduced by your changes
- Re-run quality gates to confirm everything passes
- If a failure seems unrelated to your changes, note it in your response

## User Notes

{{user_notes}}

## Non-Interactive Execution

You are running as a delegated non-interactive workflow. There is no human operator available during this invocation. Do NOT use any interactive tools (question, prompt, ask, confirm, etc.) — they will hang indefinitely. If you need human input, return with `result: "needs_human"` and explain what you need in the `reason` field.

## Completion

CRITICAL: You MUST commit all changes to git before finishing. The pipeline validates that a commit hash is present in your structured output — omitting it will cause an automatic escalation failure. Do not return with a "complete" result unless you have committed and can provide the commit hash.

Fix the quality failures and return when done. The structured outcome is captured separately via structured output — you do not need to emit any special blocks.
