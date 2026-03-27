# Plan inputs (5x)

This folder holds **slice documents** that feed `5x` plan generation. Each file is a single, bounded **plan slot**: scope, doc pointers, assumptions, and exit criteria.

- **Not** a replacement for your TDD/PRD tree — those stay the SSOT for product intent.
- **Not** the generated implementation plan — that still lives under `docs/development/` (or your configured `paths.plans`) as the output of the plan author.

**Workflow**

1. Copy `TEMPLATE.plan-input.md` to a new name, e.g. `2026-q1-booking-core.plan-input.md`.
2. Fill every section; keep “In scope” small enough for one reviewable plan.
3. Point `prd_path` (or your harness variable) at this file when running `5x template render author-generate-plan --var prd_path=...`.
4. After the plan is approved and merged, add a line in **Plan linkage** pointing at the generated plan filename.

**Naming**

- `*.plan-input.md` — input slice for one plan generation run.
- Optional: prefix with date or theme (`2026-03-tenancy.plan-input.md`) so files sort sensibly.

**Bootstrapping many slices**

- See [`agent-generate-plan-inputs.prompt.md`](agent-generate-plan-inputs.prompt.md) for an example agent prompt that analyzes the PRD/TDD tree and drafts an initial set of plan-input files.
