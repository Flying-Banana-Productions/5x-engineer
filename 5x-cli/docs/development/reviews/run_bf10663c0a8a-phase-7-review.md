# Review: Phase 7 — Approved-credit reconciliation and inherited budget derivation (W7)

**Review type:** `b0ec494a72095460216a196bbc35766b8473e8d9`
**Scope:** `src/review-governance/credit-reconciliation.ts` (new), `deriveBudget` approved-claim contribution, reconciliation record line/store, implementation reviewer composition/recording (native invoke and protocol validate), unit tests
**Reviewer:** Staff engineer (correctness, plan compliance, test strategy, operability)
**Local verification:** `bunx tsc --noEmit` clean; `bun test test/unit/review-governance test/unit/review-budget test/unit/commands` → 931 pass / 0 fail; `biome check src/ test/` clean. I also ran a throwaway probe against `reconcileApprovedCredits` (not committed) to confirm the P0 below.

**Implementation plan:** `docs/development/plans/210-implementation-review-governance-plan.md` (Phase 7)
**Technical design:** N/A

## Summary

Phase 7 adds a pure reconciliation function that bounds per-claim realizations. It keeps future claims provisional, marks due claims as realized, partial, pending or waived, and feeds the result into `deriveBudget` through a new contribution override that leaves plan-review callers unchanged. The reconciliation record is appended atomically with the implementation observation in the existing paired finalizer. The arithmetic, bounds and carry-forward proof checks look correct in isolation, and the unit tests are good.

One composition bug blocks the phase. Past-phase claims are treated as due in every later phase, but their earlier assessments are always considered invalidated because they were recorded at a different commit. A fresh realization for them is rejected as `CREDIT_CLAIM_WRONG_PHASE`. If a plan has a debt claim in any phase except the last, every later phase that proposes readiness gets a permanent `credit_unreconciled` human gate.

**Readiness:** Not ready. The P0 multi-phase deadlock must be fixed, and the P1 test gap (which is why the P0 went unnoticed) closed. Everything except one waiver-semantics question is mechanical.

---

## What shipped

- **Reconciliation core** (`credit-reconciliation.ts`) covers:
  - Approved intrinsic claims from the binding's ledger and normalized debt targets.
  - Rejection of duplicate, unknown, future and wrong-phase claims, stale binding evidence, and positive or overclaimed realizations.
  - Waivers and restorations.
  - Carry-forward only through a passing, non-invalidated Phase 6 correction attempt whose source and destination match exactly.
  - Split between the informational `credit_unrealized` alert and a material `credit_shortfall` gate cause.
  - A `credit_unreconciled` gate cause when completion is proposed with pending claims.
- **Budget arithmetic:** `deriveBudget` accepts an optional `approvedClaimContribution`. When it is present, finding credit is ignored, `N = spendableN`, `provisionalCredit`/`realizedCredit` are exposed, and `credit_unrealized` alone does not force `requiresHuman`.
- **Persistence:** a versioned `implementation-credit-reconciliation` budget line, keyed by step key. It is written as an extra op in the same paired append as the observation, from both the invoke and protocol-validate paths. The store has list/save functions.
- **Composition:** the reconciliation's gate causes are merged in before the `complete → human_gate` downgrade.

---

## Strengths

- Realization bounds follow the plan exactly: `realized` = full delta, `partial` = strictly smaller negative, `not_realized` = 0, and no overclaim or positive value is accepted. Implementation-finding architecture deltas never reach `N`.
- The `proofCarries` predicate checks every field the plan requires: outcome, invalidation, quality pass/skip/timeout, zero architecture delta, empty boundary changes, clean inventory, boundary certainty, binding, source observation, assessed commit, destination commit, and byte-identical carried claims. It cannot invent or modify assessments.
- Plan callers of `deriveBudget` are unaffected. The override is opt-in, and the plan path's `N`, alerts and `requiresHuman` behave as before (the existing arithmetic tests still pass).
- The reconciliation record is written in the same atomic append as the observation. It reuses `paired-all-new`, so there is no second writer or authority.
- `corrections.ts:605` already requires `gateCauses.length === 0` for shortcut eligibility. As a result, a `final_corrections` route that carries a reconciliation gate cause correctly cannot use the Phase 6 shortcut.

---

## Production readiness blockers

### P0.1 — Claims from earlier phases deadlock every later phase's completion

**Risk:** In `composeImplementationReviewerRecord` (`src/commands/implementation-review-context.ts`, the `priorAssessments` mapping), `laterCodeChanged` is `contextCommit !== stored.reviewedCommit`. In `reconcileApprovedCredits`, every approved claim with `targetIndex <= currentIndex` is treated as due. A phase-1 claim reviewed during phase 2 therefore:

- can't be carried forward, because its phase-1 assessment is at an earlier commit, so `laterCodeChanged` is true and no correction proof applies;
- can't be re-assessed, because a fresh realization returns `CREDIT_CLAIM_WRONG_PHASE`.

I confirmed this by calling `reconcileApprovedCredits` with `phase: "2"`, a phase-1 claim `DC1` and its realized phase-1 prior assessment:

- The claim comes back `status: "pending"` with `gateCauses: [{kind: "credit_unreconciled", claimIds: ["DC1"]}]`.
- Supplying `realized("DC1", -3)` instead is rejected with `CREDIT_CLAIM_WRONG_PHASE`.

Every phase after the first debt-claim target is forced into a `human_gate` that no one can resolve. Only a Phase 8 waiver would get past it, and that would erase realized credit that was legitimately earned.

**Requirement:** A claim whose target phase is earlier than the current phase must keep its last settled reconciliation from its own phase. That can be realized, partial, not_realized or waived, and it is subject only to explicit human restoration or waiver. Later-phase code changes must not invalidate it and must not return it to `pending`. The plan limits invalidation to "changed **target-phase** code after assessment". `laterCodeChanged` / carry-forward invalidation should apply only to assessments whose phase equals the current phase. Past-phase claims whose target phase had no settled assessment should stay visible as unreconciled; that is a Phase 9 admission concern.

**Implementation guidance:** In composition, source past-phase claim states from the latest `implementation-credit-reconciliation` record for that claim's target phase (`listImplementationCreditReconciliations`). Alternatively, compute `laterCodeChanged` only for observations whose `phase === phaseId`, and have `carriedAssessment` accept a past-phase prior assessment without a proof. Add unit and composition tests for a two-phase binding where phase 1 realizes its claim and phase 2 reaches `complete` with no `credit_unreconciled` cause, with realized credit still counted.

---

## High priority (P1)

### P1.1 — No composition-level test exercises reconciliation end to end

All new tests call `reconcileApprovedCredits` directly with hand-built `priorAssessments`. That is exactly how P0.1 went unnoticed, because the `laterCodeChanged` derivation lives in composition. No test covers any of the following:

- `composeImplementationReviewerRecord` returning a `reconciliation`;
- the paired append persisting both the observation and the reconciliation line under the step key, and replaying idempotently;
- a reconciliation gate cause downgrading `complete` to `human_gate`;
- an invalid realization surfacing its rejection code through protocol validate / invoke;
- `invoke`/`protocol` parity for the new record.

Add these alongside the existing fixtures in `test/unit/commands/implementation-review-context.test.ts`. Include the two-phase regression from P0.1 and a correction-attempt carry-forward case through real stored contexts and attempts. (auto_fix)

### P1.2 — Semantic evidence failures hard-reject recording in advisory mode; evidence must contain the full 40-char SHA

`validateRealization` requires `claim.evidence.includes(reviewedCommit)`, where `reviewedCommit` is the full SHA. Composition turns any rejection into an error in every mode, and `protocolValidate`/`invokeAgent` then abort the record. Reviewers normally cite short SHAs, so an otherwise valid advisory review would fail to record at all. The plan says: "Structural type/enum errors still reject supplied invalid contracts in every mode; missing semantic evidence becomes advisory diagnostics."

Fix:

- Accept an unambiguous prefix of the reviewed commit, at least 7 hex characters.
- In non-enforced mode, turn the evidence-reference failure into a diagnostic that leaves the claim unrealized (pending) instead of rejecting the record.
- Keep structural failures (unknown, duplicate, positive, overclaim) as errors.

(auto_fix)

---

## Medium priority (P2)

- **P2.1 — Human debt decisions and binding evidence aren't wired in production:** Composition never passes `humanDebtDecisions` or `bindingEvidence`. The waiver, restoration and stale-binding paths therefore run only in unit tests, yet the checklist item "adjusted by active human debt decisions … reject stale binding evidence" is marked done. Implementation debt decisions arrive with Phase 8, so either wire these inputs now from the binding's own hashes, or add an explicit Phase 8 hand-off note to the plan checklist. (auto_fix)
- **P2.2 — A waiver with no observation mints realized credit without evidence:** When a waiver is active and the claim has no observation, the claim becomes `waived` and `realizedN += approvedMagnitude`. For example, waiving DC1 from 3 to 2 without any assessment yields `realizedCredit: 2`, no gate, and `completionSatisfied`. The plan says missing due credit is not spendable and a waiver changes the credit envelope, not the measured post-state. Crediting a nonzero waived magnitude with no measurement needs a policy decision: either the waiver's magnitude is human-accepted credit, or waived-but-unmeasured claims get 0 realized credit while the waiver only satisfies the completion obligation. (human_required)
- **P2.3 — Ineligible ledger claim IDs are silently accepted:** `known` contains every ledger `debtClaimId`, including adjacent, unrelated or non-negative claims. A realization for such an ID passes validation (`if (!claim) continue;`) and is silently dropped, even though the error text says "not an approved intrinsic claim". Reject it with `CREDIT_CLAIM_UNKNOWN`, matching the plan's "reject unknown … IDs". (auto_fix)
- **P2.4 — Smaller cleanups** (auto_fix):
  - In composition, `reviewedCommit: contextCommit.get(...) ?? observation.createdAt` falls back to a timestamp as a commit. Skip observations whose context is missing instead.
  - `supersedesId` is populated from a restoration's `supersedesObservationId` (an observation ID), but callers also pass reconciliation record IDs (`rec-1` in tests). Decide on one identity type, or add a separate `supersedesObservationId` field.
  - `findingArchitectureDeltas` is accepted and then discarded with `void`. Drop it, or assert on it in the variance-invariance test.
  - In `carriedAssessment`, the first `!laterCodeChanged && same commit` branch duplicates the final `!laterCodeChanged` branch.

---

## Readiness checklist

**P0 blockers**
- [ ] P0.1 Past-phase claims keep their settled reconciliation in later phases; a two-phase run reaches `complete` without `credit_unreconciled`.

**P1 recommended**
- [ ] P1.1 Composition/record tests for reconciliation persistence, gate downgrade, rejection propagation and the two-phase regression.
- [ ] P1.2 Advisory-mode evidence failures become diagnostics; short-SHA evidence is accepted.

**P2**
- [ ] P2.1 Wire, or explicitly defer to Phase 8, the human debt decisions and binding-evidence inputs.
- [ ] P2.2 Decide waiver-without-observation credit semantics.
- [ ] P2.3 Reject ineligible known claim IDs.
- [ ] P2.4 Cleanups (commit fallback, `supersedesId` identity, dead parameter, redundant branch).
