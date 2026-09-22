# Review: Plan 209 Phase 1 — Governance domain and convergence policy

**Review type:** `d40fb34540e21554e25ea8b3d4769e9a0df4683b`
**Scope:** `src/review-governance/{types,fingerprint,closure}.ts`, public exports in `src/index.ts`, `test/unit/review-governance/*`, Phase 1 plan checkboxes
**Reviewer:** Staff engineer (correctness, policy fidelity, test strategy)
**Local verification:** `bun test test/unit/review-governance` → 12 pass / 0 fail; `bunx --bun tsc --noEmit` → clean; `biome check` on changed files → clean. I also ran an ad-hoc probe script against `validateClosureReview` / `validateDebtPolicy`; its results are cited below.

**Implementation plan:** `docs/development/plans/209-plan-review-governance-plan.md` (v1.7), Phase 1
**Technical design:** N/A

## Summary

Phase 1 adds the pure governance vocabulary, a canonical finding fingerprint, and a closure/debt validator. None of it depends on command handlers, SQLite, or git, which matches the completion gate. The module is well factored. The diagnostic codes are stable enums, and advisory vs. enforced behavior is a single `accepted` flag. However, three policy rules reject legitimate verdicts in enforced mode, and the debt-eligibility rule has drifted from plan 208's arithmetic. Phases 2–4 build directly on this module, so these rules need fixing now.

**Readiness:** Not ready. Three P1 policy defects need fixing: one requires a human decision, and a second is partly a policy question (P1.3). Everything else is mechanical.

---

## What shipped

- **Domain types** (`types.ts`): prior-finding status, introduced-hunk / critical-safety / decision-re-raise evidence union, `PlanReviewRoute`, `ReviewDecisionRoute`, `FindingIdentity`, `PersistedFinding`, phase-one `ReviewDecision` view, `PlanDiffContext`, `DebtEligibility`, `ReviewGateCause` with optional `resolvedBy`, `ClosureDiagnosticCode`, `ClosureValidationResult`, `PlanReviewGovernanceResult`, and interim `GovernanceVerdictItem`/`GovernanceReviewerVerdict` protocol extensions.
- **Fingerprint** (`fingerprint.ts`): NFKC and line-ending/whitespace normalization, case folding for title and scope, sorted-key JSON, then `sha256:<hex>`.
- **Closure validation** (`closure.ts`): initial-review field/baseline checks; the required-outcome set (latest status ≠ addressed and not covered by an active matching risk decision); unknown/duplicate/omitted outcomes; item presence rules for partial, open, and addressed findings; evidence for new blockers (introduced hunk, critical safety, or decision re-raise); adjacent/unrelated debt rules; the debt-eligibility assessor.
- **Exports**: structural types plus `validateClosureReview`, `validateDebtPolicy`, `assessDebtEligibility`, `canonicalFindingFingerprint` from `src/index.ts`.
- **Tests**: fingerprint stability and sensitivity, closure scenarios, debt policy.

---

## Strengths

- Clean dependency boundary. The module imports only `protocol.ts` types and `review-budget/types.ts`, both of which are pure. This satisfies "no handler/SQLite dependency" before the exports were added.
- Diagnostics are enumerated codes that carry `itemId`/`findingId`/`decisionId`. Later protocol envelopes and advisory telemetry can surface them without parsing prose.
- Advisory and enforced modes compute the exact same diagnostic set. Only `accepted` differs, which matches the plan's "same violations as diagnostics" requirement.
- The required-outcome set correctly treats a decision as covering a finding only when the fingerprint (and scope, when recorded) matches. A changed finding therefore becomes required again instead of being silently suppressed.
- The fingerprint excludes estimates, priority, and closure status, and its tests cover key order, NFC/NFD, CRLF, and whitespace.

---

## Production readiness blockers

None at P0. Phase 1 is not wired into any command path yet, so no runtime behavior changes.

---

## High priority (P1)

### P1.1 — A changed fingerprint on a remaining prior finding is a hard violation, which conflicts with `partially_addressed`

`closure.ts:509–522` emits `PRIOR_FINDING_FINGERPRINT_CHANGED` whenever a still-open or partially-addressed item's `title`, `failure`, or `lowestCostCorrection` differs from the persisted identity. In enforced mode this rejects the verdict.

A `partially_addressed` finding almost always comes with a narrower remaining correction. Probe: prior `lowestCostCorrection: "Make the write idempotent."`, closure item `partially_addressed` with `lowestCostCorrection: "Add the idempotency key to the retry path only."` → `["PRIOR_FINDING_FINGERPRINT_CHANGED"]`, rejected. Retitling or rewording the failure is rejected the same way.

The plan says "A later item with the same ID but different fingerprint is changed evidence, not silently the same risk." That describes tracking and decision coverage, which the covered-set logic already handles. It does not say the closure verdict should be rejected. The existing "partially addressed is valid" test passes only because it reuses the identical identity text.

The fix needs a policy choice:
- (a) Make the fingerprint change informational: add a diagnostic severity, or record the new fingerprint in `findingOutcomes` without affecting `valid`.
- (b) Keep it rejecting, but add a separate "remaining work" field so the identity fields stay stable across rounds.

Either option affects the Phase 3 protocol and the Phase 7 templates. **Action: human_required.**

### P1.2 — Adjacent debt with `action: "human_required"` is still rejected if it has a credit claim

The plan says: "Permit `adjacent` debt in `items[]` only with `action: "human_required"` (no credit; routes to scope gate)." The code gives that item no credit, as intended. But `validateDebtPolicy` also runs `assessDebtEligibility`, which returns `non_intrinsic` → `DEBT_COUPLING_INELIGIBLE`. That is a violation, so enforced mode rejects the verdict. Probe: adjacent + human_required + a complete `creditClaim` → `["DEBT_COUPLING_INELIGIBLE"]`.

"No credit" should mean zero credit, not rejection. The `adjacent` test asserts both codes together, which hides the problem. Fix:
- Coupling violations should come only from the single adjacent/unrelated rule. `non_intrinsic` eligibility should not also produce a diagnostic.
- Add a test showing that adjacent + human_required with a claim is valid.

**Action: auto_fix.**

### P1.3 — Debt eligibility recomputes plan-208 rules and diverges from them

The plan says "Debt policy reuses advisory evidence. Do not recalculate debt eligibility." But `assessDebtEligibility` applies criteria that disagree with `eligibleN` in `src/review-budget/arithmetic.ts:101–138`:
- **Reviewer-authored claims:** plan 208 credits a reviewer finding's intrinsic claim when `architectureDelta < 0` and the evidence is complete. It does not consult `creditAssessments`. Governance requires the reviewer to also self-assess its own claim as eligible. Probe: intrinsic claim, `architectureDelta: -1`, no assessment → `DEBT_REVIEWER_INELIGIBLE`, rejected in enforced mode, even though plan 208 credits it.
- **"Not simpler" test:** governance uses `item.architectureDelta >= minimalAlternativeArchitectureDelta`, while plan 208 uses `architectureDelta < 0`. Probe: `architectureDelta: -1`, minimal alternative `-2` → `DEBT_AFTER_NOT_SIMPLER`, yet plan 208 credits it. The reverse also happens: `+1` vs. `+2` passes governance but gets no plan-208 credit.
- **Violation vs. zero credit:** every ineligible claim is a violation. The plan's wording ("checks that every *credited* claim has…") suggests the guardrail should apply to claims plan 208 would actually credit. An ineligible claim would then simply earn zero credit.
- **`targetPhase`:** accepted only if it matches `/^phase…/`. Plan 208 accepts any non-empty string, and this new format rule is not documented in the plan.

Someone has to decide which source of truth governs reviewer-authored claims, and whether ineligibility rejects the verdict or only withholds credit. Either way, the chosen semantics should be derived from or shared with plan-208 arithmetic, not restated a second time. **Action: human_required.**

### P1.4 — New closure-round blockers are not required to carry identity fields

`validateInitialItem` runs only when `reviewKind === "initial"`. In a closure review, new blockers are checked only for their evidence field:
- an introduced-hunk item needs only `introducedBy`;
- a critical-safety item needs only `lateDiscovery` plus evidence;
- a re-raised item needs only the decision ID plus new evidence.

None of them is required to have `failure`, `lowestCostCorrection`, deltas, or confidence. Probe: a closure critical-safety item with no `failure` or `lowestCostCorrection` → `valid: true`.

Such an item cannot be fingerprinted, because `fingerprintItem` returns `null`. It therefore cannot be persisted as a `PersistedFinding { findingId, fingerprint }` in Phase 2, deferred by fingerprint, or re-raise-matched later. It also breaks the design rule that every routing item states a lowest-cost adequate correction. Fix: apply the `validateInitialItem` field and material-failure checks to every new closure item (everything not in `requiredIds`), and add tests. **Action: auto_fix.**

---

## Medium priority (P2)

- **Critical-safety evidence check is too loose** (`closure.ts:259–264`): the keyword regex is tested against `failure + lateDiscoveryEvidence`. A safety word in `failure` therefore satisfies the "concrete evidence" requirement even when `lateDiscoveryEvidence` is contentless (e.g. `"see above"`). Test the regex against `lateDiscoveryEvidence` alone. *auto_fix*
- **Missing test cases for emitted codes:** `PRIOR_FINDING_FINGERPRINT_CHANGED`, `PRIOR_FINDING_ITEM_MISSING`, `PRIOR_FINDING_ITEM_UNEXPECTED`, `INTRODUCED_AND_CRITICAL_CONFLICT`, `INTRODUCED_HUNK_EVIDENCE_INCOMPLETE`, `CRITICAL_SAFETY_SCOPE_INVALID`, `PRIOR_DECISION_NEW_EVIDENCE_REQUIRED` (evidence identical to decision rationale). The plan's "stale decision" case is covered only for a missing ID, not for superseded, `active: false`, or non-risk decisions. The debt test's `[0]?.code` assertions depend on diagnostic order. Add these cases, following the existing fixture pattern. *auto_fix*
- **Invented decision-choice aliases** (`closure.ts:75–81`): `isRiskDecision` accepts `defer` and `accept_risk` in addition to the plan's only risk choice, `defer_accept_risk`. `ReviewDecision.choice` is an untyped `string`. Restrict the check to `defer_accept_risk` now, and type `choice` when Phase 2 introduces the payload union. *auto_fix*
- **Informational, no action for Phase 1:**
  - The `diffContext` input is accepted but unused. Exact-hunk matching is Phase 3.2 scope, but Phase 3 must switch it from structural presence checks to real diff validation.
  - Duplicate IDs among *new* items are not detected. Only duplicates of prior findings are.
  - `materialFailure` rejects only a handful of placeholder words. It is a weak heuristic, and it is fine as a floor.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Decide how a changed fingerprint on a remaining finding is handled (informational vs. a separate stable identity/remaining-work split) *(human)*
- [ ] P1.2 Stop rejecting adjacent + human_required items that have a credit claim *(auto_fix)*
- [ ] P1.3 Align debt eligibility with plan-208 arithmetic and decide rejection vs. zero credit *(human)*
- [ ] P1.4 Require identity/correction fields on new closure-round items *(auto_fix)*

**Phase gate**
- ✅ No command, SQLite, dashboard, or git imports; the tests are pure.
- ⚠️ "Initial/continued contracts, prior-finding closure … and debt guardrails are deterministic": the rules are deterministic, but P1.1–P1.4 must be fixed before Phase 3 wires enforced rejection onto them.
- **Ready for next phase:** ⚠️ Phase 2 (decisions/fold) can start in parallel. Resolve P1.1 and P1.3 before Phase 3/4 consume `validateClosureReview` in enforced mode.
