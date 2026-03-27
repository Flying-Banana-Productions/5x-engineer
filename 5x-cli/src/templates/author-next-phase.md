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

### Working Directory

**Your effective working directory is shown in the `## Context` block at the bottom of this prompt. You MUST `cd` into that directory before reading, editing, running tests, or committing any files.**

The correct branch is already checked out in that directory — do not create, switch, or validate branches. All `git` operations (status, add, commit, log) must be run from within that directory. Never run `git commit` directly; always use `5x commit --run {{run_id}}` which handles staging and recording automatically.

### Implementation Guidelines

- Follow existing code patterns and conventions in the codebase.
- Write tests for new functionality before or alongside the implementation.
- Keep commits focused — one logical change per commit where practical.
- If a checklist item is ambiguous, implement the most reasonable interpretation.
- If you encounter a design decision not covered by the plan, choose the simplest approach that satisfies the requirements and note your decision.

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

    5x commit --run {{run_id}} --phase {{phase_number}} -m "<descriptive message>" --all-files

Then produce your structured result:

    5x protocol emit author --complete --commit <hash>

Or if you need human help:

    5x protocol emit author --needs-human --reason "..."

Include the command's JSON output verbatim as your structured result.
Do not wrap it in markdown fences.
The output is raw canonical JSON — do not wrap or modify it.
