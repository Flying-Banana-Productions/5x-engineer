# Review: Plan 215 Phase 3 — Revision-Aware Execution and Claim Continuity (W4, W5)

**Review type:** `b4d5f63c08122065f9e59d93a19f205695d1fe5f` (governance range `15bb5e5e..b4d5f63c`, review context `be59cd2a-a47e-4656-8d43-78cce842195c`)  
**Scope:** Phase 3 (W4, W5) for run `run_f7bdb11faf8d`. This covers the effective-revision threading through admission, reviewer recording, author/reviewer prompt context, review contexts, correction finish, text-lineage replay, gate identity (`store.ts` and `sqlite-index.ts`), plan-review routing, credit reconciliation, the boundary evaluator and `phase:complete` idempotency, plus retirement of `review implementation recover-plan`.  
**Reviewer:** Staff engineer (correctness, plan compliance, credit integrity, test strategy)  
**Local verification:**
- Full suite: `bun run test` (`bun test --concurrent --dots --timeout 15000`) gives 3934 pass, 0 fail across 256 files.
- `bun run typecheck` is clean. `bun run lint` is clean (453 files, no fixes).
- Probe: I seeded a bound run with no amendment and a valid binding hash. Its latest observation carried a `plan_defect` with `planImpact.kind: "design"` and an `implementation_defect`. `buildImplementationReviewPromptContext(...).actionableFindings` returned `["D1", "I1"]`. The base code's filter excludes `D1` (I read the code; the probe was not run against the base commit). The probe file was deleted afterwards (P1.1).

**Implementation plan:** `5x-cli/docs/development/plans/215-implementation-plan-amendment-plan.md` (approved commit `a5b3b69`, binding `ffa8a3af-0d29-4645-86c3-e55806f1b1ff`, advisory mode)  
**Technical design:** N/A

## Summary

Phase 3 routes most current readers through the canonical fold. The fold now exposes `approvedPlanBytes`/`approvedPlanHash`, `lineageParentId` and the invalidated context/observation sets. Gate IDs include the stored `revisionId` in both live and rebuilt derivation. Review contexts are refreshed per revision even when the endpoints match. Text guards anchor to the effective lineage tail. `routing.ts` withholds `final_corrections` for an amendment review. The recovery mutation command and its handler are gone, while legacy receipts still fold.

Two defects in the new wiring need fixing before Phase 4:

1. The author prompt now admits design and budget `plan_defect` findings as author work on every bound run, not only on amended ones.
2. Credit reconciliation still applies human waivers that the amendment invalidated, or that target claims the amendment edited. A pre-amendment waiver can raise a reduced claim back above its amended magnitude. It also contradicts the magnitude shown in the reviewer prompt, which leads to rejected realizations.

There are also four P2 items: `phase:complete` replay idempotency, over-broad suppression of claim carry, remaining raw-binding readers, and test coverage.

**Readiness:** Not ready. Two P1 items remain; both are mechanical (`auto_fix`).

---

## What shipped

- **Effective plan state in the fold** (`implementation-amendment.ts`): `approvedPlanBytes`/`approvedPlanHash` at the selected prefix, including text amendments; `lineageParentId`; `invalidatedContextIds`/`invalidatedObservationIds`; `legacy` attestations on legacy recovery revisions. New helpers: `revisionStamp`, `planBytesDifferFromEffectiveRevision` and `phaseReopenedByRevision`.
- **Admission and drift** (`implementation-state.ts`): `admitExistingBinding` checks drift against the effective revision and fails closed on a fold error. Bind-conflict and drift help now point at `amend`.
- **Text lineage**: `recordVerifiedTextAmendment` and `verifyAuthorTextAmendment` anchor to the fold's hash and lineage parent. They reject guards from invalidated observations (`PLAN_AMENDMENT_STALE`). New text amendments carry `revisionId`.
- **Review contexts**: `prepareImplementationReviewContext` reuses a same-range context only when it belongs to the current revision. `verifyImplementationReviewContext` rejects contexts from older revisions. `previousReviewId` keeps the chain across a same-commit refresh.
- **Reviewer recording** (`implementation-review-context.ts`): validation, budget and reconciliation use the effective ledger and bytes. Observations are stamped with `revisionId` when it is not the initial revision.
- **Prompt context** (`context.ts`): the fold drives decisions, pending and resolved findings, `requiredOutcomeIds`, due claims and the legacy `planRecovery` block. Decisions that the fold invalidated, or that target edited claims, are excluded.
- **Closure** (`implementation.ts`): `priorCodeFindings` come from the fold's pending findings for the phase.
- **Gate identity**: `implementationObservationGateId` is shared by `store.ts` and `sqlite-index.ts` and includes `revisionId` only when it is stored. The live open gate skips invalidated observations.
- **Routing**: `amendmentReassessment` flows from `composePlanReviewerRecord` through `applyPlanReviewGovernance` into `deriveEnforced`, where `ready_with_corrections` becomes `author_revision`. The flag persists on the result so that a recompute keeps the requirement.
- **Credit** (`credit-reconciliation.ts`): realizations of withdrawn claims are rejected. Carry skips invalidated observations and edited claims. Budget uses the effective ledger.
- **Boundary** (`implementation-boundary.ts`): drift, invalidation sets and legacy `acceptedPlanRecovery` come from the fold. Reconciliations and correction attempts that cite invalidated observations are filtered out. A fold failure is reported as malformed evidence.
- **Corrections**: finishing against an invalidated observation fails with `CORRECTION_OBSERVATION_STALE`. Attempts are stamped with `revisionId`.
- **Retirement**: `implementation-recovery.handler.ts`, `implementation-recovery.ts`, the `recover-plan` command and its unit tests are removed. The completion integration test now drives `amend`.

---

## Strengths

- **One source for effective bytes.** Drift, text-guard anchors, reviewer validation and lineage parents all read the same fold output. They no longer replay text amendments separately.
- **Gate identity cannot fork.** Live and rebuild derivation share a single function. `revisionId` is added only when stored, so historical gate IDs stay stable. A new test confirms that the rebuilt `review_gate_index` matches the live gate.
- **Contexts are revision-qualified, not hash-reused.** A same-range context from an earlier revision is never reused, as Decision 6 requires.
- **Most new readers fail closed.** Admission, context preparation and verification, correction finish, text lineage and the boundary all refuse to proceed on a fold diagnostic.
- **Routing override sits where the plan says.** It is in `routing.ts`, and `run-v1.handler.ts` still only reads the persisted route. The unit test covers the live flag, the verdict-borne assessment, the recorded flag, and the unchanged initial-review shortcut.

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1 — Author prompt admits design/budget `plan_defect` findings on every bound run

`context.ts` (hunk `@@ -446,14 +472,16 @@`) used to exclude non-`text_only` `plan_defect` items unless a legacy recovery had authorized them. The new exception is `!pendingFindingIds.has(item.id)`. For any bound run whose fold succeeds, the fold's `pending` set is every open item on the latest observation for that phase (`openFindingIds`), so the exclusion never fires. On ordinary runs with no amendment, a design or budget plan defect that should go to a human is now listed under "Implement only the admitted findings below". The probe above reproduces this. Existing fixtures did not catch it because they used an invalid binding hash (`sha256:plan`), which made the fold fail and fall back to the old path.

**Requirement:** For a non-`text_only` `plan_defect`, admit the item only when the finding is carried across a registered revision boundary, meaning its source observation is in `execution.invalidatedObservationIds`, and it is still pending. Also keep legacy recovery's authorized `findingRefs` behavior. Otherwise exclude it, as the base code did. Add a unit test with a valid binding hash covering an ordinary run (design `plan_defect` excluded) and an amended run (carried pending finding admitted).

### P1.2 — Reconciliation still applies invalidated or edited-claim waivers; decision acceptance validates against the original ledger

`context.ts` now filters out decisions the fold invalidated and decisions whose `claimAdjustments` touch an edited claim. The reconciliation path does not. `composeImplementationReviewerRecord` passes `effectiveLedger`, `claimEdits` and `invalidatedObservationIds` into `reconcileApprovedCredits` (hunk `@@ -707,6 +750,13 @@`). However, its `humanDebtDecisions` still come from the unfiltered `humanDebtDecisionsForReconciliation`, and `effectiveMagnitude = waiver ? waiver.approvedMagnitude : claim.magnitude`.

Concrete failure: DC0 is approved at −5. A pre-amendment `approve_higher_burden` sets −4. An amendment then registers `reduce_magnitude` to −3. The reviewer prompt shows a due magnitude of 3, but reconciliation computes 4. Either the reviewer's realized −3 is rejected ("realized requires the full approved delta −4"), or credit 4 is granted against an amended approval of 3. The second outcome is credit the amendment never approved.

In the same way, `review-decision.handler.ts` builds `allowedClaimIds` and `originalDeltas` for `assertImplementationDecisionScope` from `binding.debtTargets` and `binding.ledger`. A post-amendment `restore_simplification` on a reduced claim must therefore equal the pre-amendment −5, which restores credit the amendment removed.

**Requirement:** Apply the same invalidated-decision and edited-claim filters to `humanDebtDecisionsForReconciliation` that `buildImplementationReviewPromptContext` uses. Validate decision claim adjustments against the effective ledger, and exclude withdrawn claim IDs. Add tests for a pre-amendment waiver on a reduced claim and for a post-amendment `restore_simplification`.

---

## Medium priority (P2)

- **P2.1 — `phase:complete` replay is no longer idempotent at or after the revision boundary.** `phaseReopenedByRevision` returns true for every phase at or after the current revision's `earliestAffectedPhase`, regardless of when the existing `phase:complete` was recorded (`run-v1.handler.ts` hunk `@@ -3879,7 +3883,22 @@`). Suppose phase 2 is re-completed under the new revision and then replayed. In enforced mode, if HEAD has moved on (`freshnessPhaseId` requires a head match for `phase_complete`), the replay is denied. In advisory mode it appends a duplicate `phase:complete`. This applies to legacy-recovered runs too, because their frontier becomes `earliestAffectedPhase`. Treat a phase as revision-reopened only when its latest `phase:complete` step precedes the current revision's paired `implementation:amendment` step in the steps stream. Legacy revisions are already handled by the existing "later author/reviewer step" rule.
- **P2.2 — Carry is suppressed for edited claims even after re-assessment.** `carriedAssessment` skips any prior assessment of a claim that appears in `claimEdits` (hunk `@@ -225,8 +234,17 @@`), including assessments recorded under the new revision. Pre-amendment assessments in affected phases are already excluded through `invalidatedObservationIds`. The extra check means a fresh post-amendment assessment of an edited claim can never carry, including through a final-correction proof. Restrict the edited-claim exclusion to assessments whose observation predates the revision that recorded the edit.
- **P2.3 — Raw binding readers remain on current paths.**
  - The `protocol.handler.ts` and `invoke.handler.ts` validation fallbacks (used in advisory mode or without `--review-context`) still pass `binding.ledger`, `binding.approvedPlanBytes` and the raw text-amendment list to `validateImplementationReview`.
  - The boundary's `dueClaims` in `implementation-boundary.ts` still reads `binding.ledger`, so a withdrawn claim's phase still requires a reconciliation.
  - `composeImplementationReviewerRecord` and `buildImplementationReviewPromptContext` silently fall back to the raw binding when the fold fails. Admission, contexts and corrections fail closed in that case.

  Phase 3's first checklist item routes the render, invoke and protocol paths through effective state. Use the fold's bytes, hash and effective ledger on these paths, and fail closed on a fold diagnostic.
- **P2.4 — Test coverage for the new execution semantics.** No test exercises:
  - `phaseReopenedByRevision` (an amendment with `reopenCompletedPhases: true` reopening a completed phase), or `phase:complete` replay after re-completion.
  - Successful completion of an affected phase under the new revision.
  - A withdrawn claim at the boundary.
  - The author-prompt `plan_defect` filter on a bound run with a valid hash.
  - Correction → reassessment → registration (Decision 4). The deleted `final corrections` and `approved architecture` integration variants were not ported to `amend`.

  Several fixtures needed `hashPlanBytes` fixes, which shows how little of the new fold path the older suites reached.

---

## Nonblocking follow-ups

- `deriveOpenImplementationGate` detects an unbound run by substring-matching the fold diagnostic text ("No implementation binding is recorded"). A structured check, such as the store's `getLine(implementationBindingKey)`, would be sturdier.
- `reindexReviewGovernance` still projects unresolved gate rows for invalidated observations, while the live open-gate derivation skips them. Nothing in `src/` reads `review_gate_index` today. Align them before any reader is added.
- `presentImplementationGovernance` in `run-v1.handler.ts` (run state) still derives budget and claims from `binding.ledger`. This is Phase 4 (W6) presentation work.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Restrict non-`text_only` `plan_defect` admission to carried findings across a registered revision (plus legacy authorized refs), with tests
- [ ] P1.2 Filter invalidated and edited-claim waivers out of reconciliation; validate decision claim adjustments against the effective ledger, with tests

**P2**
- [ ] P2.1 Order-aware `phase:complete` revision reopen
- [ ] P2.2 Revision-scoped edited-claim carry suppression
- [ ] P2.3 Effective state, and fail-closed handling, on the remaining raw-binding readers
- [ ] P2.4 Coverage for reopen, re-completion, withdrawal at the boundary, and correction → reassessment → registration

**Phase readiness:** ❌ Not ready for Phase 4 until P1.1 and P1.2 are fixed. Both are mechanical.
