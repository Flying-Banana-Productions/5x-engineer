---
name: author-generate-plan
version: 1
variables: [prd_path, plan_path, plan_template_path]
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

## Completion

Write the plan to `{{plan_path}}` and return when done. You will be asked to report the outcome of your work in a structured format when you complete.
