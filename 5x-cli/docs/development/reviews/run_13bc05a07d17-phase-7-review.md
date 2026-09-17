# Review: 208 Review Budget — Phase 7 (Baseline capture, preflight, mid-review opt-in)

**Review type:** `927cddb` (feat: capture plan review budget baselines)  
**Scope:** `ensurePlanReviewBaseline` status-union rewrite, `template render` capture hook, `invoke` pre-provider capture hook, opt-in validity guards on `invoke` / `protocol validate`, shared `hasPriorPlanReviewerStep` / `ensurePlanReviewBaselineForContext` helpers, apply safety-net rewiring  
**Reviewer:** Staff engineer (correctness, fail-closed behaviour, v1 compatibility, test strategy, plan compliance)  
**Local verification:** `bun test test/unit/review-budget test/unit/commands/invoke.test.ts test/integration/commands/template-render.test.ts test/unit/commands/protocol*` → 258 pass / 0 fail; `bunx tsc --noEmit` clean

**Implementation plan:** `docs/development/plans/208-review-budget-advisory-plan.md` (Phase 7)  
**Technical design:** N/A

## Summary

Phase 7 lands the plan's capture topology: `ensurePlanReviewBaseline` now owns the full decision (off / already / v1_compat / opt-in validity / parse / CAS capture / reserved-mode warning), and all three entry points — `template render reviewer-plan`, `invoke` before provider creation, and apply's record-time safety net — route through it via one context-bound wrapper. The completion gate is met and demonstrated end-to-end by spawn tests (baseline line written with `captureKind: "initial"`, `BUDGET_SECTION_MISSING` with preflight wording, v1-compat render writes no `budget.jsonl`). Two gaps remain: the prior-reviewer-step detector was narrowed from the plan's `reviewer:` prefix to two literal step names, which can misclassify a mid-review v1 run as new; and the opt-in path at the command layer (the fourth clause of the completion gate) has no handler-level test.

**Readiness:** Ready with corrections — no design issues; the remaining items are mechanical and fully determined by the plan and existing test patterns.

---

## What shipped

- **`src/review-budget/ensure-baseline.ts`**: plan §7.1 signature and status union; opt-in validity (`BUDGET_BASELINE_OPT_IN_INVALID` when a baseline exists or no prior plan-reviewer step); preflight-worded `BUDGET_SECTION_MISSING`; enforced warning only when this call wins the CAS (`result.created`).
- **`src/commands/review-budget-context.ts`**: `hasPriorPlanReviewerStep` (SQLite index **or** authoritative step record lines) and `ensurePlanReviewBaselineForContext` (single place that binds config/store/origin).
- **`src/commands/template.handler.ts`**: capture hook for initial `reviewer-plan` only, `system/cli` origin, fail-closed `outputError`; `TemplateRenderDeps` seam.
- **`src/commands/invoke.handler.ts`**: same ensure before provider/session creation; context reused post-invoke (`??=`); opt-in captured pre-invoke is not re-asserted at record time (`optInCapturedBeforeInvoke`); `warn` dep.
- **`src/commands/protocol.handler.ts`**: opt-in requires a recorded plan-reviewer verdict.
- **`src/review-budget/apply.ts`**: safety net delegates entirely to ensure; explicit `BUDGET_BASELINE_MISSING` guard replaces an implicit non-null assumption.
- **Tests**: ensure unit matrix (off, v1_compat/opt_in, invalid opt-in, incomplete debt evidence, enforced warn-once under CAS); two spawn tests on `template render`; invoke test asserting the provider is never created when preflight fails.

---

## Strengths

- One decision function, three callers. Apply no longer duplicates the v1_compat branch, so render-time, invoke-time and record-time capture cannot drift.
- Fail-closed ordering in `invoke` is right and tested: the ensure runs before `createProvider`, so a missing section spends no tokens.
- Warning is tied to `result.created`, not to "no existing baseline at read time" — a lost CAS race correctly stays silent. The previous implementation warned before the capture result was known.
- `hasPriorPlanReviewerStep` consults record lines as well as the SQLite index, honouring the "deleting `.5x/` must not lose facts" rule: a rebuilt/empty index cannot turn a mid-review run into a "new" one.
- Origins follow the plan exactly (`system/cli` on render, agent reviewer on invoke/record); no local origin factory.
- Hook placement in `invoke` uses `resolveAndRenderTemplate`, not `templateRender`, so there is no double ensure per invocation.
- Test fixture default flipped to `mode = "off"` keeps the pre-existing render tests about what they were about.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — `hasPriorPlanReviewerStep` narrowed to two literal step names (plan says `reviewer:` prefix)

`review-budget-context.ts` matches only `reviewer:review` and `reviewer:plan`. Plan §6.1 defines the predicate as plan-phase steps whose `step_name` **starts with `reviewer:`**, which is what Phase 6 shipped and what this commit replaced. `--record-step` is free-form, and user-overridden templates can declare any `step_name` in frontmatter, so a v1 run whose plan reviews were recorded as e.g. `reviewer:plan-review` is now seen as having no prior review. Consequences on upgrade: initial `reviewer-plan` render/invoke fails closed with `BUDGET_SECTION_MISSING` on a run that must stay v1-compatible (or silently captures an `initial` baseline mid-review if the table happens to exist), and a legitimate `--opt-in-budget-baseline` is rejected as "no plan-reviewer step recorded". Phase is already constrained to `plan`, so the prefix cannot over-match.

**Fix:** restore `typeof stepName === "string" && stepName.startsWith("reviewer:")` for both the index and record-line branches; add a unit test for the helper covering (a) index hit, (b) record-line-only hit with empty index, (c) custom `reviewer:*` name, (d) non-plan phase / `author:*` not matching.

### P1.2 — No command-level coverage of the opt-in path

The completion gate's fourth clause ("`--opt-in-budget-baseline` captures `capture_kind = opt_in`") is only exercised at the pure-helper level. Untested handler logic added in this commit:

- `invoke`: the widened pre-provider condition (`optIn && isPlanReviewTemplate`) that captures on a **continued** template, and `optInCapturedBeforeInvoke` suppressing the second opt-in assertion in apply. If that suppression regresses, every successful opt-in invoke fails at record time with `BUDGET_BASELINE_OPT_IN_INVALID` *after* tokens were spent — exactly the failure class this phase exists to prevent.
- `invoke`: `BUDGET_BASELINE_OPT_IN_INVALID` for non-reviewer / non-plan templates.
- `protocol validate`: `BUDGET_BASELINE_OPT_IN_INVALID` without `--record`, with a non-plan phase, or for `author`.

**Fix:** extend `test/unit/commands/invoke.test.ts` (the `invokeWithBudgetContext` harness already injects context, provider and `warn`) with: prior step + no baseline + opt-in → baseline `captureKind: "opt_in"`, step + snapshot recorded, no error; and the invalid-flag rejection before provider creation. Add the three rejection cases to the protocol validate tests.

---

## Medium priority (P2)

- **Opt-in retry message is a dead end.** Capture and step persist are separate writes, so a run can end up with an `opt_in` baseline and no recorded step (provider failure after the invoke pre-capture; persist failure after apply's capture). Retrying the same command then fails with "valid only for a mid-review run without a baseline", which does not tell the orchestrator that the correct recovery is to re-run **without** the flag. Rejecting is per plan ("valid only when a baseline is absent"); only the message needs to say a baseline already exists and the flag should be dropped. Add the assertion to the existing invalid-opt-in unit test.
- **`TemplateRenderDeps` is an unused seam.** `createReviewBudgetContext` / `readPlan` / `warn` deps are never injected by any test (coverage is via spawn, which the plan permits). Either add one in-process `templateRender` test that uses them (e.g. unreadable plan → `PLAN_NOT_FOUND`, which is currently uncovered) or drop `readPlan`. Prefer the test.
- **Capture precedes later render failures.** The render hook runs before session-continuity validation, so a render that subsequently errors still leaves a baseline. Harmless (capture is idempotent and the baseline is correct for the run) — noting only so nobody "fixes" it by reordering into a position after prompt output.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 — restore `reviewer:` prefix match in `hasPriorPlanReviewerStep`; add helper unit tests
- [ ] P1.2 — invoke opt-in happy path + invalid-flag tests; protocol validate invalid-flag tests

**P2**
- [ ] Actionable message when opt-in is passed and a baseline already exists
- [ ] Exercise (or trim) `TemplateRenderDeps`

**Phase 7 completion:** ⚠️ — gate behaviour is implemented and the initial-capture / fail-closed / v1-compat clauses are proven; opt-in clause needs handler coverage and the prior-step predicate needs to match the plan.  
**Ready for Phase 8:** ✅ after the mechanical corrections above; nothing here changes the store or snapshot shapes Phase 8 reads.
