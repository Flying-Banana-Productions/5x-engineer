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

---

## Addendum (September 22, 2026) — Follow-up commit review

**Reviewed:** `bf7f7d664988f0f8d9731c7d6d92f41f6eb53c53` (parent `d40fb34540e21554e25ea8b3d4769e9a0df4683b`)

**Local verification:** `bun test test/unit/review-governance` → 20 pass / 0 fail (was 12); `bunx --bun tsc --noEmit` → clean; `biome check` on changed files → clean. I re-ran my prior probe scenarios plus new ones against the fixed code (`assessDebtEligibility`, `validateDebtPolicy`, `validateClosureReview` called directly) to confirm behavior rather than trusting the new tests alone.

### What's addressed (✅)

- **P1.1 — Fingerprint change on a remaining finding no longer rejects.** `closure.ts:507–513` now emits `PRIOR_FINDING_FINGERPRINT_CHANGED` with `severity: "info"`, and `valid`/`accepted` are computed from `hasErrors = diagnostics.some(d => d.severity === "error")` (`closure.ts:575–578`). `ClosureDiagnostic` gained a required `severity` field (`types.ts`), and the `findingOutcomes` entry now carries the *current* recomputed fingerprint instead of the stale persisted one (`closure.ts:561–564`), so the identity drift is visible in the outcome record rather than silently discarded — this satisfies the plan's "changed evidence, not silently the same risk" without rejecting ordinary narrowing/rewording. My probe (a `partially_addressed` item with a narrowed `lowestCostCorrection`) now returns `valid: true`, `accepted: true`, with the info diagnostic and an updated `findingOutcomes` fingerprint, matching the new `"tracks a same-ID fingerprint change as informational changed evidence"` test. The revision goes further than the minimum fix: when a *required* item also carries `priorDecisionId` (`closure.ts:514–516`), it now routes through `validateReraise` against the live finding, so a required finding can't quietly piggyback on a stale decision reference while also drifting its identity. I confirmed this path with a constructed case (mismatched decision) and got `PRIOR_DECISION_FINDING_MISMATCH`/`PRIOR_DECISION_STALE` as expected. **Addressed.**

- **P1.2 — Adjacent + `human_required` debt with a credit claim no longer rejects.** `validateDebtPolicy` now does `if (item.coupling === "adjacent") continue;` immediately after the `ADJACENT_DEBT_REQUIRES_HUMAN` check (`closure.ts:192–201`), so `assessDebtEligibility` (and any coupling-ineligibility diagnostic) never runs for adjacent items. Probe: adjacent + `human_required` + complete `creditClaim` → `validateDebtPolicy` returns `[]`. New test `"handles adjacent and unrelated debt only through the coupling rule"` asserts the same, and separately confirms `adjacent + auto_fix` still yields exactly `["ADJACENT_DEBT_REQUIRES_HUMAN"]` (no more paired `DEBT_COUPLING_INELIGIBLE`). **Addressed.**

- **P1.3 — Debt eligibility now reuses plan-208 arithmetic instead of diverging.** `src/review-budget/arithmetic.ts` extracts the exact plan-208 reviewer-credit predicate into an exported `isReviewerFindingCreditEligible` (architectureDelta < 0, intrinsic coupling, complete evidence, intrinsic claim coupling — no self-assessment lookup), and `eligibleN` now calls it instead of restating the condition (`arithmetic.ts:101–147`). `assessDebtEligibility` in `closure.ts:119–184` drops the `creditAssessments` self-assessment requirement entirely (`_verdict` is now unused, prefixed accordingly) and calls the shared predicate directly, and the "not simpler" check drops the invented `architectureDelta >= minimalAlternativeArchitectureDelta` comparison, leaving only the `before === after` text check the plan actually specifies. `targetPhase` validation moved to a shared `isValidDebtTargetPhase` (any non-empty string, matching plan 208 — the invented `/^phase.../` format regex is gone). Probes confirm both directions that previously diverged: `architectureDelta: -1` vs. `minimalAlternativeArchitectureDelta: -2` (previously wrongly rejected) is now eligible; `architectureDelta: +1` (previously wrongly accepted) is now correctly ineligible with **no diagnostic emitted** — `validateDebtPolicy` returns `[]` for it, i.e. it silently earns zero credit rather than rejecting the verdict. This resolves the human-required policy question in the affirmative direction I flagged as the coherent choice ("ineligible claim earns zero credit, not a violation"), and it's now covered by three new tests (`"reuses plan-208 reviewer-finding credit without a self-assessment"`, `"uses plan-208 architecture semantics without comparing the alternative delta"`, `"accepts any non-empty plan-208 target label"`) plus a fourth confirming a reviewer-ineligible self-assessment no longer produces a diagnostic. **Addressed.** One residual, non-blocking observation: inside `assessDebtEligibility`, the `non_intrinsic` reason branch (`closure.ts:149–155`) checks `item.coupling !== "intrinsic" || claim.coupling !== "intrinsic"`, but `claim.coupling` is constructed as `coupling: item.coupling` two lines above, so the second half of that condition can never differ from the first, and both `ClosureDiagnosticCode` entries that used to report it (`DEBT_REVIEWER_INELIGIBLE`, `DEBT_COUPLING_INELIGIBLE`) were removed — so within `validateDebtPolicy`'s call path (which already filters out non-intrinsic coupling before reaching this function) this branch is dead code. It's harmless (the function is still correct when called directly, as the tests do), so I'm not raising it as an action item, just noting it for a future cleanup pass.

- **P1.4 — New closure-round items now require full identity fields.** `closure.ts:519–521` now calls `validateInitialItem(item)` for every item not in `requiredIds` (i.e., every new closure-round item), before branching into introduced/critical-safety/re-raise evidence checks. Probe: a closure-round critical-safety item without `failure`/`lowestCostCorrection` now returns `valid: false` (previously `true`). New test `"requires complete identity and hunk evidence on new closure blockers"` confirms `INITIAL_ITEM_FIELDS_REQUIRED` and `INITIAL_ITEM_FAILURE_NOT_MATERIAL` fire alongside the evidence-specific code. **Addressed.**

- **P2.1 — Critical-safety evidence regex now tests `lateDiscoveryEvidence` alone.** `closure.ts:250–254` no longer concatenates `failure` into the tested string. New `"contentless"` test (evidence = `"See the failure above."`, failure contains a safety keyword) confirms `CRITICAL_SAFETY_EVIDENCE_REQUIRED` still fires. **Addressed.**

- **P2.2 — New tests for previously untested diagnostic codes.** `PRIOR_FINDING_FINGERPRINT_CHANGED`, `PRIOR_FINDING_ITEM_MISSING`, `PRIOR_FINDING_ITEM_UNEXPECTED`, `INTRODUCED_AND_CRITICAL_CONFLICT`, `INTRODUCED_HUNK_EVIDENCE_INCOMPLETE`, `CRITICAL_SAFETY_SCOPE_INVALID`, and `PRIOR_DECISION_NEW_EVIDENCE_REQUIRED` (evidence identical to the decision's prior rationale) are all now exercised. Stale-decision variants (inactive, superseded, non-risk choice) are covered by a parameterized test that checks all three independently rather than one hand-picked case. The debt-policy tests switched from order-dependent `[0]?.code` assertions to `toContainEqual`/exact-array assertions. **Addressed.**

- **P2.3 — `isRiskDecision` restricted to `defer_accept_risk`.** `closure.ts:78–80` now checks only `decision.choice === "defer_accept_risk"`, and `ReviewDecision.choice` is typed as the new exported `ReviewDecisionChoice` union (`types.ts`) covering all eight plan-defined choices instead of an untyped `string`. **Addressed.**

### Remaining concerns

None at P0/P1. The one dead-branch nit noted under P1.3 is cosmetic and optional; I'm not blocking on it.

### New issues introduced by this revision

None found. I checked for stray references to the removed `DEBT_REVIEWER_INELIGIBLE`/`DEBT_COUPLING_INELIGIBLE` codes and the old `reviewer_ineligible` reason elsewhere in `src`/`test` — none remain. `ClosureDiagnostic` gained a required `severity` field; the only production construction site is the local `diagnostic()` helper, which was updated consistently, so this isn't a breaking change for any other module. Public function signatures (`assessDebtEligibility(item, verdict?)`) stayed backward compatible despite `verdict` becoming unused.

### Updated readiness

- **Phase 1 completion:** ✅ — All four P1 findings and all three P2 findings from the original review are resolved and covered by new, non-order-dependent tests. Tests (20/20), typecheck, and lint are clean. The module remains pure (no command/SQLite/git imports).
- **Ready for next phase:** ✅ — Phase 2 (decisions/fold) and Phase 3/4 (protocol integration, enforced routing) can now safely consume `validateClosureReview`/`validateDebtPolicy`/`assessDebtEligibility` in enforced mode.
