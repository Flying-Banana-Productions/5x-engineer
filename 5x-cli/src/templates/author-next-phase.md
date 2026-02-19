---
name: author-next-phase
version: 1
variables: [plan_path, phase_number, user_notes]
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

## Completion

Commit your work and return when the phase is implemented. The structured outcome (complete/needs_human/failed + commit hash) is captured separately via structured output — you do not need to emit any special blocks.
