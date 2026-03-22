---
name: author-next-phase
description: Implement the next phase of a plan
version: 2
variables: [plan_path, phase_number, user_notes, run_id]
step_name: "author:implement"
variable_defaults:
  user_notes: ""
  run_id: ""
---

You are implementing phase {{phase_number}} of the implementation plan at `{{plan_path}}`.

## Instructions

1. Read the implementation plan at `{{plan_path}}` thoroughly.
2. Identify phase {{phase_number}} and understand its completion gate.
3. Review any prior phases to understand the current state of the codebase.
4. Implement all checklist items for this phase.
5. Ensure all tests pass (unit, integration, and any configured quality gates).
6. Update the implementation plan: mark completed checklist items with `[x]`.
7. Commit your changes with a message referencing the implementation plan and phase number.

### Implementation Guidelines

- Follow existing code patterns and conventions in the codebase.
- Write tests for new functionality before or alongside the implementation.
- Keep commits focused — one logical change per commit where practical.
- If a checklist item is ambiguous, implement the most reasonable interpretation.
- If you encounter a design decision not covered by the plan, choose the simplest approach that satisfies the requirements and note your decision.

### Branch Management

- Validate you are on an appropriate branch for this work.
- If no suitable branch exists, create one (e.g., `impl/NNN-feature-name` or similar).
- Do NOT force-push or rewrite history on shared branches.

### Quality Checks

- Run all tests and ensure they pass before committing.
- Fix any linting or type errors introduced by your changes.
- If tests fail and the fix is non-trivial, note it in your status output.

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
