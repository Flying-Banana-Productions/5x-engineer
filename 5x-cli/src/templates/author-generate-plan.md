---
name: author-generate-plan
description: Generate an implementation plan from requirements
version: 2
variables: [prd_path, plan_path, plan_template_path, run_id]
step_name: "author:generate-plan"
variable_defaults:
  run_id: ""
---

You are implementing the 5x workflow. Generate an implementation plan from the provided requirements document.

## Input

- Requirements document: {{prd_path}}
- Target plan output path: {{plan_path}}
- Plan template to follow: {{plan_template_path}}

## Instructions

1. Read the requirements document at `{{prd_path}}` thoroughly.
2. Read the plan template at `{{plan_template_path}}` to understand the expected structure.
3. Analyze the codebase to understand existing architecture, patterns, and conventions.
4. Generate a comprehensive implementation plan and write it to `{{plan_path}}`.

### Plan Requirements

- Follow the structure and conventions of the plan template exactly.
- Break the work into phases with clear completion gates.
- Each phase should be independently testable and deliverable.
- Include checklist items (`- [ ]`) for trackable work items within each phase.
- Include code snippets for non-trivial interfaces, types, and function signatures.
- Reference specific files and line numbers where changes will be made.
- Include a Files Touched table and Tests table.
- Include an Estimated Timeline.
- Be specific about what changes — avoid vague descriptions.

### Quality Criteria

- Phases should be ordered by dependency (prerequisites first).
- Each phase should be completable in 1-3 days.
- The plan should be implementable by an agent following it step-by-step.
- Design decisions should be documented with rationale.
- Test strategy should cover unit, integration, and edge cases.

## Non-Interactive Execution

You are running as a delegated non-interactive workflow. There is no human operator available during this invocation. Do NOT use any interactive tools (question, prompt, ask, confirm, etc.) — they will hang indefinitely. If you need human input, return with `result: "needs_human"` and explain what you need in the `reason` field.

## Completion

CRITICAL: You MUST commit all changes using `5x commit` before finishing. The pipeline validates that a commit hash is present in your structured output — omitting it will cause an automatic escalation failure. Do not return with a "complete" result unless you have committed and can provide the commit hash.

When ready to commit, run:

    5x commit --run {{run_id}} --phase plan --files {{plan_path}} -m "<descriptive message>"

Then produce your structured result:

    5x protocol emit author --complete --commit <hash>

Or if you need human help:

    5x protocol emit author --needs-human --reason "..."

Include the command's JSON output verbatim as your structured result.
Do not wrap it in markdown fences.
The output is raw canonical JSON — do not wrap or modify it.
