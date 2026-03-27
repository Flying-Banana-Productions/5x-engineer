# Agent prompt: generate initial plan-input files from a PRD/TDD tree

Use this as the **system or user prompt** for an agent tasked with producing an initial set of `*.plan-input.md` files. Adjust bracketed placeholders to match your repository.

---

## Objective

You are assisting with **5x** workflow setup. The project has a **technical design document tree** (master index plus linked chapters). Your job is **not** to write implementation plans or change the TDD content. Your job is to **analyze that tree** and produce **several slice files** under `docs/development/plan-inputs/` that follow the structure of `docs/development/plan-inputs/TEMPLATE.plan-input.md`.

Each slice file is a **bounded input** to a future `5x` plan-generation run (`prd_path` → implementation plan). Slices should be **small enough to review**, **ordered by dependency**, and **explicit about what is deferred** so the design can evolve without regenerating everything.

---

## Inputs you must use

1. **Master index** (start here): `[e.g. docs/00-technical-design-overview.md]`
2. **Full tree**: Follow every linked path from the index until you have a complete map of chapters and how they relate (dependencies, shared foundations vs feature areas).
3. **Template**: `docs/development/plan-inputs/TEMPLATE.plan-input.md` — every output file must include **all sections** from this template (same headings). Replace placeholder text with concrete content.

Optional context to read if present: `5x.toml` (paths, quality expectations), `AGENTS.md` or project implementation guide for repo conventions.

---

## Analysis steps

1. **Build a mental map** of the doc tree: major subsystems, shared primitives (schema, tenancy, auth, time, API shape), and vertical features.
2. **Identify coupling**: what must exist before what (e.g. tenant model before feature APIs; core booking before SMS polish).
3. **Propose slices** so that:
   - Each slice has a **single clear theme** and a **one-line goal** that is verifiable.
   - **Foundational / horizontal** work is ordered **before** features that depend on it.
   - Prefer at least one **early vertical slice** if the docs support it (thin end-to-end path) to reduce integration risk — only when it does not fight the documented dependency order.
   - No slice tries to implement “the whole product”; **out of scope** must name the next slice or backlog item.
4. **Estimate phase pressure**: if a slice would plausibly exceed **~8–12 phases** in a typical implementation plan, **split** it into two plan-input files with a clean interface between them.
5. **Record risks** where the docs are ambiguous; prefer **handoff notes and spikes** over guessing scope.

---

## Output rules

- **Create one Markdown file per slice** under `docs/development/plan-inputs/`.
- **Filename**: kebab-case, descriptive, suffix `.plan-input.md` (e.g. `tenancy-and-db-foundation.plan-input.md`). Optional: prefix with `draft-` if the team will rename after review.
- **Status** in Metadata: use `draft` for the initial agent pass; humans change to `ready` after review.
- **Primary documents**: For each slice, list **only** the docs needed for that slice, **in reading order**, with a **one-line note** per link explaining why it is included.
- **Dependencies**: Use checkboxes for prior slices or external prerequisites. Order files so dependencies point **backward** to already-listed work (no cycles).
- **Suggested next slice**: Where obvious, set this to the **filename** of the following plan-input file to encode execution order.
- **Do not** paste large excerpts from the TDD into plan-input files; **link** to chapters instead.
- After writing files, output a **short summary table**: slice filename, one-line goal, depends on, suggested order index (1, 2, 3, …).

---

## Quality bar

- A developer who has **not** read the full TDD tree should be able to pick slice *N* and understand **goal, boundaries, doc list, and exit criteria** from that file alone.
- If two slices would duplicate the same **in scope** bullets, **merge** them or **split responsibility** so overlap is explicit in **Out of scope / deferred**.

---

## What you must not do

- Do not generate the actual **5x implementation plan** (phases/tasks) — only **plan-input** slices.
- Do not modify existing PRD/TDD source files unless the user explicitly asks.
- Do not invent product requirements absent from the docs; if something is missing, put it under **Assumptions**, **Handoff**, or **Risks**.

---

## End state

Deliver:

1. The set of new `*.plan-input.md` files (full contents).
2. The summary table and a **recommended execution order** for the slices.
3. **Open questions** for the human (max 5) where the doc tree left gaps.
