# Review: Review Budget Advisory — Phase 9 (Templates, skills, and docs)

**Review type:** `e2502542c1a1143699090d50fb5ea0d005bbd5e6`  
**Scope:** Plan template scaffold (shipped default + repo template), author/reviewer plan prompts, `5x-plan` / `5x-plan-review` skills, `docs/v1/101-cli-primitives.md`, template/harness unit tests. No follow-on commits.  
**Reviewer:** Staff engineer (correctness of agent-facing contracts, plan compliance, operability)  
**Local verification:** `bun test test/unit/templates test/unit/harnesses` — 511 pass, 0 fail

**Implementation plan:** `docs/development/plans/208-review-budget-advisory-plan.md` (Phase 9)  
**Technical design:** `docs/v2/206-review-budget-governance.md`

## Summary

Phase 9 delivers the prompt, skill, and documentation surface for the advisory review budget. Coverage against §9.1–§9.5 is complete and the doc claims I spot-checked match the code (first-review `baselineAssessment` required / continued forbidden in `apply.ts:159–168`, `INVALID_STRUCTURED_OUTPUT` for CLI-owned fields, `--opt-in-budget-baseline` on both `protocol validate` and `invoke`, `off`/`v1_compat` skip paths). One real defect: the shipped default plan template describes the debt-claim cell in a form the parser rejects, so an author following the scaffold literally produces a plan that fails baseline capture.

**Readiness:** Ready with corrections — one mechanical P1 wording/contract fix plus small P2s; no human decisions needed.

---

## What shipped

- **Plan scaffold**: `## Delivery Budget`, `### Debt Claims` / `#### DC0`, `### Surface Snapshot` added before Phase 1 in `DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE` and in `docs/_implementation_plan_template.md`.
- **Author prompts** (v3): stable `Wn`/`DCn`, `Addresses`, no totals, tests not scored separately, complete debt evidence, changed-claim semantics.
- **Reviewer prompts** (`reviewer-plan` v4, `reviewer-plan-continued` v5): Delivery budget dimension, independent `I`, per-item deltas, credit-assessment rules, forbidden CLI-owned fields, richer emit example.
- **Skills**: `5x-plan` invariants; `5x-plan-review` preflight recovery, `v1_compat` opt-in with human gate, new/changed-only credit assessments, explicit "ignore `result.budget.requiresHuman`".
- **CLI docs**: protocol emit/validate section, `review_budget` in `run state`, advisory/exit-code statement.
- **Tests**: substring assertions in loader, stale-override, opencode and cursor skill tests.

---

## Strengths

- Advisory-only routing is stated at every point an orchestrator could be tempted to act on it (skill invariants, Step 2 routing, both reviewer prompts, 101 doc), including the reserved `enforced` mode.
- Changed-claim equality is enumerated identically across author prompt, continued reviewer prompt, skill, and 101 doc, matching the persisted-claim comparison.
- `reviewer-commit*.md` and `docs/v2/206` status untouched, as the plan requires.
- Template version bumps are paired with stale-override test updates so existing overrides get the warning.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — Shipped default template documents a debt-claim cell format the parser rejects

`src/parsers/delivery-budget.ts:68` requires the cell to match ``^DC\d+\s+\(`(intrinsic|adjacent|unrelated)`\)$`` — the coupling **must** be backticked and `DCn` must not be. The plan's §9.1 text preserves this (``DCn (\`intrinsic\`|\`adjacent\`|\`unrelated\`)``). The implementation dropped the backticks in `src/templates/default-artifacts.ts` ("debt claim DCn (intrinsic|adjacent|unrelated)"), so an author following the scaffold writes `DC0 (intrinsic)` and first `reviewer-plan` render fails with `BUDGET_INVALID_DEBT_CLAIM`. The repo template's variant (`` `DCn` (`intrinsic` | …) ``) is closer but implies a backticked `DCn`, which also fails. Neither author prompt states the literal cell syntax. The preflight loop recovers eventually via the parser message, but that is an avoidable author round-trip on every plan with a negative row.

Recommendation: restore the exact parser-accepted form in the default artifact (escaped backticks inside the TS template literal, as the plan shows), make the repo template show a literal example such as ``DC0 (`intrinsic`)``, add one sentence with that literal example to `author-generate-plan.md` / `author-process-plan-review.md`, and add a unit test that fills the default scaffold with a negative row written exactly as documented and asserts `parseDeliveryBudget` returns `ok`. That test would have caught this and guards future drift between scaffold and parser.

---

## Medium priority (P2)

- **Unconditional "This is the initial review. Emit exactly one `--baseline-assessment`"** in `reviewer-plan.md`: rendered the same when `reviewBudget.mode = "off"` or the plan predates the section. The CLI tolerates the extra fields (skipped in `apply.ts`), so this is harmless, but the reviewer is also told to check a Delivery Budget that may not exist. Add a one-line qualifier ("when the plan has a `## Delivery Budget` / budgeting is active; otherwise omit budget fields").
- **Tests are substring-only**: acceptable for prompts, but none ties the scaffold to the parser (see P1.1). The cursor test duplicates opencode assertions without asserting the conditional `reviewer_native` / `reviewer_invoke` opt-in tool line renders for the matching harness.
- **101 doc `run state` example** does not show `stale_plan`, which Phase 8 emits on drift; mention it in the behaviour bullet.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 — Align scaffold/prompt debt-claim cell syntax with `CLAIM_CELL_RE`; add scaffold→parser round-trip test

**P2**
- [ ] Qualify first-review budget instructions for off / no-section plans
- [ ] Harness-conditional opt-in line assertion
- [ ] Document `stale_plan` in 101

---

## Phase readiness

Plan compliance for §9.1–§9.5 is otherwise complete and the completion gate is met in substance. After P1.1 is corrected, proceed to Phase 10 (integration, compatibility, exports); the round-trip test requested above complements the Phase 10 integration spawn rather than replacing it.
