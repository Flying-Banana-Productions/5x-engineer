# Review: Plan 209 Phase 9 — review-budget policy resolved from plan context

**Review type:** `d60d6969f74d623e1523b946137508eba4584111` (no follow-on commits)
**Scope:** `createReviewBudgetContext` resolves `reviewBudget` from the run's plan context; `run state` (active-run path) routes through the shared budget context; integration coverage for subproject and mapped-worktree policy resolution.
**Reviewer:** Staff engineer (correctness, architecture, operability, test strategy)
**Local verification:** `bun test` — 3604 pass / 0 fail (230 files); `bun test test/integration/commands/review-budget.test.ts` — 10 pass; `tsc --noEmit` clean.

**Implementation plan:** `docs/development/plans/209-plan-review-governance-plan.md`
**Technical design:** N/A

## Summary

This commit closes a real policy-resolution gap: `protocol validate --record`, `invoke`, and `run state` previously read `reviewBudget` from whatever config the caller's CWD resolved to. So a run could capture or report a different mode or thresholds depending on where the command was launched. After this change, the review-budget context layers the control-plane root config with the plan directory's nearest config. That matches how `template render` and `invoke` already resolve provider/template config, and it is plan-directory-anchored in mapped worktrees too. The change is small and correct, and the tests exercise the right scenarios. One read-only path in `run state` (the archived-run/git-record fallback) still uses the CWD-resolved mode.

**Readiness:** Ready with corrections — one mechanical P2 consistency gap remains; no blockers.

---

## What shipped

- **`review-budget-context.ts`**: `createReviewBudgetContext` calls `resolveLayeredConfig(controlPlaneRoot, dirname(effectivePlanPath))` and overrides only `config.reviewBudget`. Infrastructure config such as records paths and step limits stays on the record context's resolution.
- **`run-v1.handler.ts` (`runV1State`, active run)**: Replaces the hand-built `createRecordContext` + `createReviewBudgetStore` pair with `createReviewBudgetContext`. It uses the plan-anchored `configuredMode` for `tryBuildReviewBudgetState` and the `uninitialized`/`v1_compat` fallback. This also removes a duplicate construction site of the budget store.
- **Tests**: The mapped-worktree subproject test proves policy comes from the worktree's plan-local config. It does not come from the main checkout's subproject or the root, and the test covers three CWDs. The root and subproject CWD variants cover the full sequence: `run state` → `render` (captures B0 with plan-local thresholds) → `protocol validate --record` after the local config is flipped to `off` (pinned baseline wins, human gate opens) → `run state` from both CWDs.

---

## Strengths

- **Single chokepoint.** Every consumer of `budgetContext.config.reviewBudget` inherits the fix from one factory: protocol validate, invoke, render baseline capture, `ensurePlanReviewBaselineForContext`, and `composePlanReviewerRecord`. No per-call-site patches were needed.
- **Narrow override.** Replacing only `reviewBudget` avoids silently changing records-root or max-steps resolution for record writers. The inline comment states the governance-vs-infrastructure boundary explicitly.
- **Pinning semantics verified end-to-end.** The test flips the plan-local config to `mode = "off"` after capture. It asserts that recording still enforces thresholds from the pinned baseline and that `run state` keeps reporting `enforced`. This is the core plan invariant: an active baseline cannot be demoted by later config.
- **Negative assertion on the main-checkout records root** in the mapped test guards against records leaking into the wrong tree.
- **Consistency with existing layering.** `template.handler.ts:166-173` and `invoke.handler.ts:341-351` already anchor config to `dirname(resolvedPlanPath)`. The budget context now agrees with them, so the render-time mode gate and the record-time mode can no longer diverge.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

- **Archived-run `run state` path still uses CWD policy** (`src/commands/run-v1.handler.ts:2200-2203`, `:2269`). When `run state --plan` falls back to `loadGitRecordForPlan` because the run is not in the DB, it still does two things with the `dbContext` config:
  - It gates on `config.reviewBudget.mode`.
  - It passes that same mode to `tryBuildReviewBudgetState`.

  `planPath` is already known in that branch. The impact is limited: runs with a baseline have `budgetLines`, and the pinned baseline mode dominates the reported state. However, archived runs without a baseline will report `review_budget` differently depending on CWD. For example, a subproject plan with `mode = "advisory"` shows `uninitialized` from the subproject and nothing from a root configured `off`. This is the same class of bug the commit fixes. Fix: resolve `resolveLayeredConfig(projectRoot, dirname(planPath)).config.reviewBudget.mode` in that branch. Add a matching test that runs from root and subproject CWDs.
- **Observation (no action required):** `createReviewBudgetContext` now calls `resolveLayeredConfig` with the default `warn = console.error`. In render and invoke, the same layered config was already resolved once, so any config deprecation warnings may print twice to stderr. This is cosmetic. Consider passing `onDiagnostic`, or a no-op, as the `warn` argument if duplicate warnings show up in practice.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [x] None

**P2**
- [ ] Anchor archived-run `run state` review-budget mode to the plan directory config
