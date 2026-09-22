# Review: Plan 209 Phase 4 — Deterministic enforced routing and readiness normalization

**Review type:** `7c208a41a6044e0d19c8d84530453dbfb61f3882`
**Scope:** `src/review-governance/routing.ts` (new), `types.ts` additions, `src/index.ts` exports, `test/unit/review-governance/routing.test.ts` (new), plan checkbox updates
**Reviewer:** Staff engineer (correctness, plan compliance, budget/governance invariants)
**Local verification:** `bun test test/unit/review-governance/` → 67 pass / 0 fail; `bunx tsc --noEmit` clean; biome clean on touched dirs. Ran a scratch probe (not committed) to confirm P1.1.

**Implementation plan:** `docs/development/plans/209-plan-review-governance-plan.md` (Phase 4)
**Technical design:** N/A

## Summary

Phase 4 adds a pure router (`derivePlanReviewGovernance`), the strict `ready_with_corrections` validator (`validateFinalCorrections`), and the post-decision route (`routeAfterDecision`). Enforced routing follows the plan's precedence order. Causes are typed enums with `resolvedBy`. Reviewer readiness can't override the CLI route. `routeAfterDecision` correctly reruns plan-208's `deriveBudget` against filtered findings and the folded `B`.

The main path (`derivePlanReviewGovernance` without a caller-supplied `architectureContext`) doesn't rerun the budget. It patches the budget by subtraction and re-derives the architecture alert from an incomplete context, which can drop a real architecture gate. The advisory "v1 route" also doesn't match the v1 skill's routing for `human_required` items. Both fixes are mechanical.

**Readiness:** Ready with corrections — the fixes are mechanical and don't need a human decision, but P1.1 should be fixed before Phase 6 wires the router into recording.

---

## What shipped

- **Pure enforced router**: accepted-risk filtering → governing-`B` band recompute → cause derivation with `resolvedBy` (baseline resolution, architecture approval envelope) → `human_gate` / `complete` / `final_corrections` / `author_revision`.
- **Advisory mode**: runs the enforced derivation and records it as `hypotheticalEnforcedRoute`, while returning a v1-style route.
- **`validateFinalCorrections`**: all-auto-fix, effort ≤ 1, zero architecture delta, no reviewer verification, no critical/prior-decision exception, and `W + correction effort ≤ E`. Every failure reason is reported.
- **`routeAfterDecision`**: returns overrides for `abort` / `trade_scope` / `request_author_reestimate` without computing a successor. For every other choice it filters deferred findings, reruns `deriveBudget` with the folded `B`, and reruns the router.
- **Types/exports**: `FinalCorrectionFailure`; `itemIds` / `workItemIds` on architecture `budget_alert` causes; public exports in `src/index.ts`.

---

## Strengths

- The router is pure and deterministic. It doesn't mutate the input (a test checks this with `structuredClone`), and it never reads reviewer-authored aggregate fields.
- `routeAfterDecision` reuses `deriveBudget` directly instead of re-implementing it. This matches the plan's "pure rerun is authoritative" requirement.
- Cause output is structured: stable `kind`, finding identities, sorted item/work-item IDs, and `resolvedBy`. Skills and future adapters won't need to parse prose.
- `validateFinalCorrections` reports all failure reasons instead of stopping at the first. That will help with diagnostics and prompt context later.
- The re-estimate test is correct: a pending re-estimate doesn't suppress `baseline_disputed` in either direction.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — Architecture gate can be silently dropped when `architectureContext` is omitted

`derivePlanReviewGovernance` makes `architectureContext` optional. When it's missing, `deriveEnforced` builds a default from **verdict items only**, with `workItemIds: []` (`routing.ts:332–341`). Two helpers then rebuild `positive_architecture_exceeded` from that context instead of trusting plan 208:

- `budgetForGoverningBaseline` (`routing.ts:188–196`) re-derives the alert as `P >= newLimit || itemIds.length || workItemIds.length`.
- `budgetForActiveItems` (`routing.ts:143–149`) keeps the alert only when `P >= limit || remainingSingleArchitecture || workItemIds.length > 0`.

Verified with a probe:

- Setup: `deriveBudget` with `B = 40`, one work item with `architectureDelta: 5` (at the single-item threshold), and `P = 5` below the limit of 10. Plan 208 raises `positive_architecture_exceeded`.
- With the unchanged governing `B`, the route is `human_gate`, but the cause carries `workItemIds: []`.
- With `governingBaseline: 44` (an unrelated `adjust_baseline` / `increase_budget`), the route becomes **`complete` with no causes**. The single-item architecture alert is lost.

The empty `workItemIds` also weakens the approval check. `architectureApproval` uses `every(...)` over an empty list, so any approval with `approvedP >= P` covers a new work-item threshold crossing. That breaks the rule that "a new threshold-crossing ID re-gates."

Phase 6 is the phase that calls this entry point from recording, so the defect lands there unless it's fixed now. `routeAfterDecision` isn't affected because it supplies the full context.

**Recommendation:**

- Make `architectureContext` required. Callers have the snapshot's `currentLedger.workItems`, and the `architectureContext()` helper at `routing.ts:451` already computes it.
- Or, as a fallback when the context is missing: never remove an architecture alert that plan 208 raised.
- Also make `remainingSingleArchitecture` exclude `polish` items so it matches `deriveBudget`.
- Add regression rows:
  - a work-item single-threshold alert under an adjusted `B`
  - a work-item single-threshold alert under a deferral
  - an approval with no work-item IDs, followed by a new work-item crossing

### P1.2 — Advisory "v1 route" diverges from the actual v1 skill routing

The plan (4.1) says advisory mode must "return the existing v1 route." `v1Route` (`routing.ts:324–326`) maps anything other than `ready` to `author_revision`. The v1 plan-review skill (`src/skills/base/5x-plan-review/SKILL.tmpl.md:320–335`) escalates to a human (Step 4) in two cases:

- when any item is `human_required`
- when a `not_ready` verdict has no actionable items

For those verdicts, advisory runs will record `route: "author_revision"` while v1 actually escalates. The recorded advisory route becomes misleading audit data, and any later consumer that branches on `route` will make the wrong call.

**Recommendation:** Mirror the skill table:

- `ready` → `complete`
- any `human_required` → `human_gate`
- `not_ready` with no items → `human_gate`
- otherwise → `author_revision`

Extend the advisory test with these rows.

---

## Medium priority (P2)

- **Deferral N/D/E recompute uses a different credit predicate than plan 208**: `budgetForActiveItems` subtracts `removedN` only when `verdict.creditAssessments` has an eligible intrinsic assessment (`routing.ts:106–123`). Plan 208 counts reviewer-finding credit with `isReviewerFindingCreditEligible` (complete claim evidence plus intrinsic coupling on the claim), not assessments. If a deferred finding's credit was counted by plan 208 but has no matching assessment, `E` stays inflated after deferral, and the reverse case deflates it. This also goes against "do not recalculate debt eligibility." **Fix:** in the main path, rerun `deriveBudget` from the snapshot inputs, as `routeAfterDecision` already does. At minimum, reuse `isReviewerFindingCreditEligible`. This also removes the duplicated band/ceiling logic.
- **Two fingerprint derivations for the same finding**: `routing.ts` `findingIdentity` falls back to `item.reason` and defaults `scopeClass` to `acceptance_required`. `closure.ts` `fingerprintItem` falls back to the persisted finding or returns `null`. When a closure-round item omits `failure` / `lowestCostCorrection`, the router's fingerprint won't match the persisted/decision fingerprint, and a deferred risk will stop filtering. **Fix:** extract one shared item → identity helper (with the persisted-finding fallback) and use it in both modules.
- **Premature plan checkbox**: 4.3's "`5x review gate show` and `5x review decide` expose this durable derived route" is ticked, but neither command exists yet (Phase 5.2). Untick it or annotate it as delivered in Phase 5.
- **Post-decision test gaps**: the `increase_budget` / `adjust_baseline` / `retain_baseline` rows all use an unchanged governing `B = 5` and a within-budget snapshot, so they never exercise a fold change that clears an over-effective gate or leaves a successor gate. The `trade_scope` / `request_author_reestimate` rows don't use an over-budget snapshot, although 4.4 asks for that. Add those rows.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Require (or derive from the snapshot) the full `architectureContext`, never drop a plan-208 architecture alert, and add regression rows
- [ ] P1.2 Make advisory `v1Route` match the v1 skill's escalation rules

**P2**
- [ ] Recompute the deferral budget with `deriveBudget` / the plan-208 credit predicate
- [ ] Share one finding-identity helper between routing and closure
- [ ] Fix the premature 4.3 CLI-exposure checkbox
- [ ] Add fold-change and over-budget post-decision test rows

**Phase readiness:** The Phase 4 core is in place and well structured. Fix P1.1 and P1.2 before Phase 5/6 build on the router. No human decisions are required.

---

## Addendum (2026-09-22) — Follow-up fix review

**Reviewed:** `7be90a9e0f35c3f8a287ad398be8bcf0733108da` (`fix: address plan 209 phase 4 routing review`), diffed against `7c208a41a6044e0d19c8d84530453dbfb61f3882`.

**Local verification:** `bun test test/unit/review-governance/` → 67 pass / 0 fail (172 assertions, up from 158); `bun test test/unit/` → 2796 pass / 0 fail; `bunx tsc --noEmit` clean; `bunx biome check src/review-governance test/unit/review-governance` clean.

### What changed

- `derivePlanReviewGovernance` no longer patches the input `DerivedBudgetResult` by subtraction. It now takes a required `budgetContext: { workItems, findings, assessments }` and reruns plan-208's `deriveBudget` directly against the active (non-deferred) findings and the folded governing `B` (`routing.ts:210–262`). The old `budgetForGoverningBaseline` / `budgetForActiveItems` patch functions are gone entirely.
- `architectureContext` (item/work-item IDs at or above the single-architecture threshold) is now derived from the same active-findings/work-items data used for the `deriveBudget` rerun, excluding `polish` findings, instead of from an optional caller-supplied context that defaulted to `workItemIds: []` (`routing.ts:222–238`).
- `v1Route` now branches on `human_required` items and on an itemless `not_ready` verdict before falling back to `author_revision`, matching the `5x-plan-review` skill's Step 4 escalation table (`routing.ts:200–208`).
- `findingIdentity` / `fingerprintById` now prefer `closure.findingOutcomes`, then an accepted-risk's persisted fingerprint (when the item omits `failure`/`lowestCostCorrection`), then a freshly computed fingerprint — all routed through one new shared helper, `fingerprintVerdictItem` in `fingerprint.ts`, which `closure.ts` also now imports instead of its own local `fingerprintItem` (`routing.ts:47–62`, `fingerprint.ts:44–60`, `closure.ts` diff).
- The plan's 4.3 checkbox wording was corrected to state that CLI exposure (`5x review gate show` / `5x review decide`) is tracked in Phase 5.2, not implemented here.
- Test file adds a dedicated architecture-preservation test reproducing the exact prior-review probe (B 40→44 adjustment, deferral, and an unscoped architecture approval, each keeping the work-item alert and `workItemIds: ["W1"]` visible), an advisory-mode test for both new `v1Route` branches, a debt-credit rerun test, a closure-identity-fallback test, and a `routeAfterDecision` test that folds a budget change to clear a gate while an unrelated semantic cause keeps it open.

### Prior findings — status

- **P1.1** (architecture gate silently dropped when `architectureContext` is omitted) — **addressed**. The optional-context/subtraction approach is gone; the router now always rebuilds the architecture context from the same real work-item/finding data it feeds into `deriveBudget`, so there is no code path left where the alert can be recomputed from an empty `workItemIds`. Re-ran the original repro (`B0=40, B=40→44`, one work item at `architectureDelta: 5`) via the new test at `routing.test.ts:420–441` — the alert and `workItemIds: ["W1"]` now survive the baseline adjustment. The fix goes further than my suggested minimum (required field) by removing the standalone patch functions rather than just closing the gap.
- **P1.2** (advisory `v1Route` diverges from v1 skill escalation) — **addressed**. `v1Route` now matches the skill table exactly, and the advisory test exercises both the `human_required`-item branch and the itemless-`not_ready` branch (`routing.test.ts:365–380`).
- **P2.1** (deferral N/D/E recompute used a non-plan-208 credit predicate) — **addressed**, and more thoroughly than requested: rather than reusing `isReviewerFindingCreditEligible` inside a patch function, the router now calls `deriveBudget` itself, so `N`/`D`/`E` after a deferral are computed by the exact same code path plan 208 uses everywhere else. The new "reruns plan-208 debt credit after deferring an intrinsic-credit finding" test confirms a deferred credit-bearing finding's `N` contribution is removed and the budget correctly moves to `over_effective`.
- **P2.2** (duplicate fingerprint derivation between routing and closure) — **addressed**. Both modules now call the single `fingerprintVerdictItem` helper in `fingerprint.ts`. Note the shared helper always returns a string (never `null`), where `closure.ts`'s old private `fingerprintItem` returned `null` when required fields were missing; the two call sites in `closure.ts` that previously gated on a non-null fingerprint (`currentFingerprint &&` prior-finding-changed check, and the `?? finding.fingerprint` fallback in `findingOutcomes`) are technically now always-true/dead-fallback, but this doesn't change behavior: the helper's own fallback chain (item's own value → prior finding → `item.reason`) means a diagnosable fingerprint is now available in the same cases where it previously would have been `null`, and the comparison still isn't reached for finding IDs that don't have a matching item. Not a regression; a defensible simplification.
- **P2.3** (premature 4.3 checkbox for `review gate show`/`review decide` CLI exposure) — **addressed**. The checkbox text was rewritten to `"Export the durable derived-route seam for skill branching; \`5x review gate show\` and \`5x review decide\` command exposure remains tracked in Phase 5.2."`
- **P2.4** (post-decision tests lacked fold-change and over-budget rows) — **addressed**. The new `"fold changes clear budget gates or leave deterministic successors"` test covers an `increase_budget`/`adjust_baseline` fold that clears an over-absolute band, a `retain_baseline` (no fold) that leaves it gated, and a fold that clears the budget cause while an unrelated `human_required` item keeps the gate open. The explicit-closure `test.each` (`trade_scope`/`request_author_reestimate`/`abort`) now uses `effortDelta: 4`, which pushes the default snapshot into `over_absolute`, so those rows now exercise "revises without a successor even when the old snapshot was over budget" as 4.4 requires.

### New issues introduced by this revision

- **Vestigial `FindingIdentity | null` return type** (P2, cosmetic): `findingIdentity` (`routing.ts:47–62`) has no code path that returns `null` — every branch produces a `FindingIdentity`. The two call sites that guard on it (`routing.ts:75` `if (!identity) return true;` and `routing.ts:149` `if (!finding) continue;`) are dead code, and the `| null` in the signature overstates what the function can do. **Fix:** drop `| null` from the return type and delete the two now-unreachable guards (or, if the intent was to leave room for a future "no identity available" case, add a comment explaining why the type is wider than the implementation).

### Updated readiness

- **Phase 4 completion:** ✅ — all P1/P2 items from the initial review are resolved with direct regression coverage; no plan-compliance gaps remain in `routing.ts`.
- **Ready for next phase:** ✅ — no human decisions outstanding. The one new item (vestigial null type) is cosmetic and does not block Phase 5/6 wiring.
