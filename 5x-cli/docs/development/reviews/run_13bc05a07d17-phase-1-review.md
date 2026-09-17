# Review: Plan 208 Phase 1 — Review-budget domain types and pure arithmetic

**Review type:** `f35de93c056d017e77e61e53b21f01ec11c9e017`
**Scope:** `src/review-budget/types.ts`, `src/review-budget/arithmetic.ts`, and their unit tests (Phase 1 of plan 208). No follow-on commits.
**Reviewer:** Staff engineer (correctness, plan compliance, test strategy)
**Local verification:** `bun test test/unit/review-budget/` — 13 pass, 0 fail. `bun run typecheck` — clean. `biome check src/review-budget test/unit/review-budget` — clean.

**Implementation plan:** `docs/development/plans/208-review-budget-advisory-plan.md` (Phase 1)
**Technical design:** `docs/v2/206-review-budget-governance.md`

## Summary

Phase 1 delivers the domain types, three type guards, and a pure arithmetic module with no I/O, handler, SQLite, or `src/protocol.ts` imports. The ceiling formulas, `D` caps, band selection, baseline direction, and the `B = 4` worked example all match the plan. Three behaviours diverge from the plan's own definitions and should be corrected before Phase 2 and Phase 4 start consuming these contracts. Polish findings leak into `P` and can raise `requiresHuman`. Reviewer-introduced credit claims with a non-`DCn` id silently earn zero `N`. `deriveBudget` fabricates `thresholds.mode = "advisory"`.

**Readiness:** Ready with corrections — all items are mechanical and derivable from the plan; no human decisions needed.

---

## What shipped

- **Types (`types.ts`)**: all plan §1.1 types verbatim, including the shared structural `BaselineAssessment`, plus `isEffortPoints`, `isArchitectureDelta`, `isCompleteDebtClaimEvidence`.
- **Arithmetic (`arithmetic.ts`)**: `sumEffort`, `computeCeilings`, `computeProvisionalD`, `computeEffectiveCeiling`, `computeBaselineDirection`, `computePendingR`, `computeGrossP`, `eligibleN`, `deriveBudget`, with signatures matching plan §1.2.
- **Tests**: 13 unit tests covering the worked example, `B = 0` / `B < 0`, both `D` caps, direction boundaries, `R` polish exclusion, `P` non-netting, `N` eligibility and incomplete-evidence exclusion, and one end-to-end `deriveBudget` case.
- **Plan**: Phase 1 checkboxes ticked.

---

## Strengths

- The module is genuinely pure. No I/O and no imports outside `./types.js`, which keeps Phase 4 independently type-complete as the plan requires.
- Integer discipline is kept: `Math.ceil` / `Math.floor` wrap every multiplication and non-finite or negative `B`, `B0`, `I`, `N` throw `RangeError`.
- `eligibleN` reads the reduction from the ledger row or the finding, never from assessment metadata, and requires both the finding and its claim to be `intrinsic`.
- `computeBaselineDirection` handles a zero threshold (`I === B0` stays `aligned`), an edge the plan did not call out.
- `credit_unrealized` is never emitted and the test asserts it.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — Polish findings count toward `P` and the single-item architecture alert

`deriveBudget` passes `input.findings` unfiltered to `computeGrossP` and to the `singleArchitectureReviewPoints` scan (`arithmetic.ts:177`, `:201-207`). The plan names that parameter `pendingFindings` and defines pending as `scopeClass !== "polish"`. Design 206 §3.2 defines `P` over "current work items and pending findings", and §4 makes polish nonblocking. Verified locally: a single polish finding with `architectureDelta: 5` and `effortDelta: 0` yields `P = 5`, `positive_architecture_exceeded`, and `requiresHuman: true`. Slice 07 will route on that flag, so a nonblocking note would force a human gate.

**Recommendation:** compute `pending = findings.filter(f => f.scopeClass !== "polish")` once in `deriveBudget` and use it for `computeGrossP` and the single-item scan. Add a test that a polish finding with `architectureDelta: 5` raises neither `P` nor the alert.

### P1.2 — `isCompleteDebtClaimEvidence` rejects reviewer-introduced claim ids that are not `DCn`

The guard enforces `/^DC\d+$/` on `debtClaimId` (`types.ts:168`). The plan bullet for the guard lists only presence of `debtClaimId`; the `DCn` format is an author-ledger rule that the Phase 2 parser enforces from the table cell. The same guard is applied to `FindingDelta.creditClaim`, whose `debtClaimId` is the reviewer's `creditClaimId`. Plan Phase 5/6 put no format constraint on `creditClaimId` and require that it not collide with an author `DCn`, which pushes reviewers away from the `DC` namespace. Verified locally: a complete intrinsic reviewer claim with id `RC1` returns `N = 0` with no error. That is a silent zero-credit default, which the plan explicitly rejects for incomplete evidence.

**Recommendation:** have the guard require a non-empty trimmed string id and leave `DCn` format enforcement to the parser. Add a test that a complete reviewer claim with a non-`DC` id contributes to `N`.

### P1.3 — `deriveBudget` fabricates `thresholds.mode = "advisory"`

`deriveBudget` takes `Omit<ReviewBudgetConfig, "mode">` but returns `thresholds: ReviewBudgetConfig`, so the implementation hardcodes `mode: "advisory"` and redundantly spreads the defaults under `input.config` (`arithmetic.ts:237-241`). A project configured as `enforced` would see `advisory` in every cached `derived` payload and in `run state`. The root cause is a plan type inconsistency, and the plan already shows the intended shape: `configSnapshot: Omit<ReviewBudgetConfig, "mode">` on the baseline payload and facade.

**Recommendation:** change `DerivedBudgetResult.thresholds` to `Omit<ReviewBudgetConfig, "mode">`, return `input.config` unchanged, drop the now-unused `DEFAULT_REVIEW_BUDGET_CONFIG` import, and update the type block in plan §1.1 to match. Fix this before Phase 4 persists `derived` JSON.

---

## Medium priority (P2)

- **Dead branch in `computePendingR`**: `stillListedIds` is built from the same `findings` being iterated, so `stillListedIds.has(finding.id)` is always true and `incorporatedIds` never changes the result (`arithmetic.ts:85-95`). The output is correct, because the plan's `R` definition reduces to "sum of all non-polish current items". Collapse the loop to that sum, keep the parameter for the planned signature, and say in a comment why it does not affect the total.
- **Missing band and flag coverage**: the plan's test matrix lists "bands" and "`requiresHuman` flags". Only `over_effective` is asserted. Add cases for `within_standard`, `within_debt_allowance` (needs eligible `N`), `over_absolute`, `semanticHumanRequired: true` alone, `I: null` giving `baselineDirection: null`, and `P` exactly equal to the limit.
- **`DEFAULT_REVIEW_BUDGET_CONFIG` is mutable and shared**: add `Object.freeze` or `as const satisfies` so a caller cannot mutate defaults used by every derivation.
- **Note, no action in this phase**: the plan uses `P >= positiveArchitectureLimit` while design 206 §5 says "above". The code follows the plan. Worth reconciling in the docs phase.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Exclude polish findings from `P` and the single-item architecture scan; add test
- [ ] P1.2 Remove the `DCn` regex from `isCompleteDebtClaimEvidence`; add non-`DC` reviewer-claim test
- [ ] P1.3 Narrow `thresholds` to `Omit<ReviewBudgetConfig, "mode">` and stop hardcoding `advisory`

**Phase readiness:** Phase 1 completion gate is met (tests pass, fixture matches, no handler or SQLite imports, `BaselineAssessment` type-tested). Proceed to Phase 2 after the P1 corrections land; they change contracts that Phases 2, 4, and 6 consume.

---

## Addendum (2026-09-17) — Corrections verified

**Reviewed:** `6550b220f3ddc5692a472adb933d2c6649df2e02` (one commit on top of `f35de93c056d017e77e61e53b21f01ec11c9e017`, "fix: address phase 1 review budget corrections")

**Local verification:** `bun test test/unit/review-budget/` — 20 pass, 0 fail (up from 13). `bun run typecheck` — clean. `biome check src/review-budget test/unit/review-budget` — clean.

### What's addressed (✅)

- **P1.1 — Polish findings leaking into `P`**: `deriveBudget` now derives `pendingFindings = input.findings.filter(f => f.scopeClass !== "polish")` (`src/review-budget/arithmetic.ts:165-168`) and passes it to both `computeGrossP` and the single-item architecture scan (`:189-191`). New test "excludes polish findings from P and architecture alerts" confirms a polish finding with `architectureDelta: 5` now yields `P: 0`, no alerts, `requiresHuman: false`. Fully resolved.
- **P1.2 — `DCn` regex rejecting reviewer-introduced claim ids**: `isCompleteDebtClaimEvidence` now checks `claim.debtClaimId.trim().length > 0` instead of `/^DC\d+$/` (`src/review-budget/types.ts:164`). New tests confirm a claim id of `review-credit-1` is treated as complete and a whitespace-only id is rejected. The arithmetic test for reviewer-provisional `N` was updated to use `review-credit-1` rather than a borrowed `DC0`, which now actually exercises the non-`DC` path. Fully resolved.
- **P1.3 — Hardcoded `thresholds.mode: "advisory"`**: introduced `ReviewBudgetThresholds = Omit<ReviewBudgetConfig, "mode">`, retyped `DerivedBudgetResult.thresholds` to that alias, and `deriveBudget` now returns `thresholds: input.config` directly with no mode fabrication or default-spreading (`arithmetic.ts:145`, `:230`; `types.ts:53`, `139`). The plan's type block was updated in the same commit (`docs/development/plans/208-review-budget-advisory-plan.md:346`, `:431`) so the doc and code agree. New test asserts `result.thresholds` is referentially the input config and has no `mode` property. Fully resolved.
- **P2.1 — Tautological still-listed branch in `computePendingR`**: collapsed to a single non-polish sum over the input findings, with a comment explaining that every finding in the array is by construction still listed, so the `incorporatedIds` parameter (now `_incorporatedIds`) cannot change the result for this call shape. The parameter is kept only to match the plan's declared signature. This is a correct simplification, not a behavior change — confirmed by re-reading the plan's `R` definition: an item can only leave the `findings` array by being resolved and dropped from the current verdict, so "in incorporated but no longer listed" is structurally impossible for this input. Fully resolved.
- **P2.2 — Missing band/flag test coverage**: added a `describe("budget bands and human flags")` block covering `within_standard` with a null baseline direction, `within_debt_allowance` via an eligible intrinsic debt claim, `over_absolute`, `semanticHumanRequired` alone (with no alerts), `P` exactly equal to `positiveArchitectureLimit`, and the polish-exclusion case from P1.1. Fully resolved.
- **P2.3 — Mutable shared defaults**: `DEFAULT_REVIEW_BUDGET_CONFIG` is now `Object.freeze`d and typed `Readonly<ReviewBudgetThresholds>`; a new test asserts `Object.isFrozen(...)`. Fully resolved.

### Remaining concerns

None. All six items from the original review (three P1, three P2) are addressed with corresponding test coverage, and no new issues were introduced by the revision. `eligibleN` and `computeCeilings`/`computeProvisionalD` were re-read in full and remain unchanged from the version already reviewed as correct.

### Updated readiness

- **Phase 1 completion:** ✅ — all arithmetic and type contract issues resolved; 20/20 tests pass; typecheck and lint clean; no I/O, handler, or SQLite imports introduced.
- **Ready for next phase:** ✅ — Phase 2 (Delivery Budget parser) and later phases can now consume `ReviewBudgetThresholds`, `isCompleteDebtClaimEvidence`, and `deriveBudget`'s corrected `P`/`thresholds` behavior without inheriting the prior contract bugs.
