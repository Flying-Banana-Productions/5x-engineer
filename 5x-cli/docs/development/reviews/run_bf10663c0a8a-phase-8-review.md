# Review: Phase 8 — Domain-aware human gates, decisions and projection rebuild (W8)

**Review type:** `98f1fa9..f0d61d5` (`0f9f0a7`, `ef74806`, `f0d61d5`)
**Scope:** Implementation gate derivation, implementation decision payload/codec/acceptance, `review gate show --phase` / `review decide` dispatch, typed prompt context, migration v11 and rebuild projections, plus the follow-on workflow-path mapping fix (`f0d61d5`)
**Reviewer:** Staff engineer (correctness, plan compliance, test strategy, operability)
**Local verification:** `bun test test/unit/review-governance test/unit/db test/unit/commands/template-vars.test.ts test/integration/code-review-diff.test.ts` → 337 pass / 0 fail. The rest of this review is static.

**Implementation plan:** `docs/development/plans/210-implementation-review-governance-plan.md` (Phase 8)
**Technical design:** N/A

## Summary

Phase 8 adds a versioned `implementation-review-governance` decision kind. Gate IDs are now domain-qualified, and plan gate IDs are unchanged. Implementation decisions go through the existing paired human step and the `decision:review-gate:<gateId>` CAS. Acceptance is classified per phase, and migration v11 adds the projection columns and tables. The structure follows the plan, and plan-domain behavior is preserved.

The phase is not complete. A human's claim-adjustment decision is stored but never reaches credit reconciliation, so the next review of the same phase raises the same shortfall again. The implementation gate fold can also get stuck: a recorded decision that covers no cause leaves the already-decided gate reported as open, and no further decision can resolve it. The CLI decide path does not check finding references against the gate, although the plan path does. Finally, the tests exercise a store-level `resolveImplementationGate` that production code never calls. The CLI handler that ships (`submitImplementationReviewDecision`) has no tests at all, which is how the other three problems went unnoticed.

**Readiness:** Not ready. There are four P1 correctness and test gaps. Each has a fix that follows from existing code.

---

## What shipped

- **Decision payload** (`decisions.ts`): `ImplementationDecisionPayload` v1 has six choices, a canonical intent hash, and per-choice validation. Claim adjustments are checked against the ledger, the gate's claims and the original magnitude (`assertImplementationDecisionScope`).
- **Acceptance** (`classifyImplementationDecisionAcceptance`): it finds the reviewer step from the observation's step key. A same-phase reviewer step between that step and the human step makes the decision stale; a reviewer step in another phase does not. A later superseding binding also makes it stale.
- **Gates** (`store.ts`): `deriveOpenImplementationGate` folds decisions over the latest same-phase observation's `gateCauses`. There is a typed `implementation_review_gate` prompt context, and prompt repair is extended to it. `answerPrompt` rejects both gate prompt types.
- **CLI**: `review gate show --phase <p>` and `review decide` dispatch by domain through `showReviewGate` / `submitReviewDecision`. The plan wrappers are kept.
- **Migration v11**: domain/phase/binding/observation columns on the decision and gate indexes, plus the `implementation_binding_index` and `implementation_observation_index` tables, filled by `reindexReviewGovernance`.
- **Composition**: `bindingEvidence` now comes from accepted implementation decisions.
- **Follow-on `f0d61d5`**: absolute records and review paths are now expressed relative to the control-plane root when they are outside the mapped worktree. Dirty run records no longer trigger `CODE_DIFF_DIRTY` on the invoke and render paths. It has unit and integration coverage.

---

## Strengths

- Plan gate ID stability is kept by leaving out the domain fields when `domain` is absent, and a test pins this.
- The decision payload kind is separate. `listGovernanceDecisions` and the plan fold ignore implementation records, and a test covers mixed decisions.
- The live write reuses `prepareRecordStepAppend` / `finalizeAndWritePreparedStep` with `paired-all-new` and a `decisions` extra op, which is the same CAS path as plan decisions. No new decision authority was added.
- Acceptance takes phase into account: same-phase late reviews make a decision stale, and cross-phase reviews do not, as required.
- `f0d61d5` is small and well-reasoned. Paths that escape both roots are dropped instead of being guessed, and the integration test reproduces the actual dirty-run-record failure.

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1 — Implementation claim decisions never reach credit reconciliation

`composeImplementationReviewerRecord` still passes `humanDebtDecisions: humanDebtDecisionsFromBinding(binding)` (`implementation-review-context.ts:643`). That function only reads the binding's frozen `effectiveDecisions`. Accepted `approve_higher_burden`, `reduce_scope` and `restore_simplification` decisions carry `claimAdjustments`, including `supersedesObservationId` for restoration, but nothing converts them into `HumanDebtWaiver` or `HumanDebtRestoration` inputs.

**Effect:** the approval only removes the cause from the current gate fold. On the next review of the same phase, `reconcileApprovedCredits` sees the original magnitude again and raises the same `credit_shortfall`, so the human has to decide again. A restoration decision never marks the superseded observation as restored, so the claim can't be re-assessed as the plan intends. This does not meet the Phase 8 checklist item "Store claim-specific approved post-state/delta reductions … Budget/burden approval recomputes credit and remaining causes."

**Requirement:** Build the reconciliation's `humanDebtDecisions` from the binding's decisions plus the **accepted** implementation decisions for this binding (`listImplementationDecisions` + `classifyDecisionAcceptance`):
- `approve_higher_burden` / `reduce_scope` → `waiver` with `approvedMagnitude = -approvedArchitectureDelta`.
- `restore_simplification` → `restoration` with the adjustment's `supersedesObservationId`.

Add a regression test: gate on a shortfall → approve the higher burden → re-review the same phase → no shortfall cause.

### P1.2 — The implementation gate fold returns a gate that is already decided

In `deriveOpenImplementationGate` (`store.ts`), when `applyImplementationDecisionCauseCoverage` removes nothing (`next.length === causes.length`), the function returns the **same** `gateId` with `resolved: false`. That gate already has a decision under `decision:review-gate:<gateId>`, so any new `review decide` either replays the stored decision or fails with `REVIEW_GATE_ALREADY_RESOLVED`. The gate stays shown as open and can never be resolved. The plan-domain fold (`deriveOpenGate`) never re-reports a decided gate; it moves to a successor gate that has a predecessor.

Choices that validation accepts can reach this state:
- `reduce_scope` on a gate whose only cause is `credit_unreconciled`. `allowedImplementationChoices` offers it and `assertImplementationDecisionScope` accepts it, but coverage always keeps `credit_unreconciled`.
- A `defer_accept_risk` whose `findingRefs` match no cause (see P1.3).

A related inconsistency: a gate whose only cause is `inherited_budget` is offered `restore_simplification`, `approve_higher_burden` and `reduce_scope`. `gateClaimIds` is empty for that gate, so all three always fail with "claim … is not a cause of this gate", and only `abort` can succeed.

**Requirement:**
- Follow the plan fold: never return a decided gate ID as open. Continue to a successor gate with a predecessor, or treat a scope/amendment decision as a paused `plan_amendment` with no open gate.
- Offer only the choices that `assertImplementationDecisionScope` and coverage can satisfy for the gate's causes.
- Apply the same change to the rebuild loop in `sqlite-index.ts`, which currently stops on `next.length === causes.length`, so live and rebuilt state stay the same.

### P1.3 — The implementation decide path accepts unverified finding refs

`submitImplementationReviewDecision` uses `input.payload.findingRefs` exactly as supplied. When refs are absent, it maps `--finding` IDs to causes and **silently drops** IDs that match nothing. It never checks that a ref is one of the gate's eligible findings or that the fingerprint matches. The plan path rejects both (`REVIEW_DECISION_FINDING_INVALID`, `review-decision.handler.ts:330–350`).

**Effect:** an `--input-json` decision can record a deferral or amendment for findings that aren't on the gate. This is "unrelated scope", which the plan says must be rejected. The decision then covers nothing and gets stuck as described in P1.2. A mistyped `--finding` alongside a valid one is dropped without any warning.

**Requirement:** Reuse the plan path's validation against the gate's `eligibleFindings`: reject unknown IDs, mismatched fingerprints and duplicates. Reject an explicit `findingRefs` that is combined with `--finding`, or merge the two as the plan path does.

### P1.4 — The shipped CLI decision path is untested; the tested store method is unused

All implementation-decision tests call `createReviewGovernanceStore(...).resolveImplementationGate` or append records directly. Production calls `submitImplementationReviewDecision` → `prepareRecordStepAppend` / `finalizeAndWritePreparedStep`, and nothing in `src/` calls `resolveImplementationGate`. No test calls `showReviewGate`, `submitReviewDecision` or the `--phase` CLI option.

Several checklist items in the plan are therefore only covered through a code path that doesn't ship:
- two-process CAS
- abort parity with terminal handling
- prompt closure after decide
- successor prompt creation

The "wiped index rebuild matches the live implementation projection" test runs `reindexReviewGovernance` twice. It compares one rebuild with another, not live handling with a rebuild.

**Requirement:**
- Add handler-level tests covering the following, following the existing plan-review-governance command tests:
  - `gate show --phase`
  - same-intent and different-intent `decide`
  - the stale-after-late-review error
  - abort calling `abortRun` only after acceptance
  - successor gate and prompt creation
  - claim decisions changing the next reconciliation (P1.1)
- Delete `resolveImplementationGate`, or make the handler delegate to it, so that only one write path exists and the tests cover it.

---

## Medium priority (P2)

- **`bindingEvidence` is still tautological.** `bindingEvidenceFromImplementationDecisions` filters decisions by `bindingId === binding.id`, and each decision's hashes were copied from that same binding when it was written (`ledgerHash: binding.ledgerHash`). Binding IDs are immutable, so the check can never fail. The docstring "never copied from the binding" is misleading. Either compare against a record that can actually differ, or document that this is a consistency assertion and not staleness detection.
- **`requiredFieldsByChoice` misplaces `supersedesObservationId`.** The prompt context lists it as a top-level field for `restore_simplification`, but it belongs inside each `claimAdjustments[]` entry. `claimAdjustments` can only be supplied through `--input-json`, so the `exampleCommand` shown for claim choices can't produce a valid decision.
- **Derived gates carry empty `ledgerHash` / `decisionsHash`.** `DerivedImplementationGate` fills these with `""`. Fill them from the observation's binding, or remove the fields.
- **Gate `record_seq`** in `sqlite-index.ts` is `seq + chainDepth`, which can collide with a later budget line's seq. This only affects ordering.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Feed accepted implementation claim decisions into reconciliation `humanDebtDecisions`
- [ ] P1.2 Stop the implementation gate fold from re-reporting a decided gate; align offered choices with scope validation and coverage; keep rebuild parity
- [ ] P1.3 Validate implementation `findingRefs` / `--finding` against the gate's eligible findings
- [ ] P1.4 Add handler-level tests for the shipped decide/show path; remove or reuse `resolveImplementationGate`

---

## Addendum (2026-09-24) — Claim-decision feedback, gate-fold fix, finding validation, handler tests

**Reviewed:** `0fafeb15d09597e527fff8d1fed767e5b07da72e` (single commit on top of `2e57f8b`: "Fix implementation gate decisions so claim approvals, coverage, and finding checks match the shipped decide path.")
**Local verification:** `bun test test/unit/review-governance test/unit/commands/implementation-review-context.test.ts test/unit/commands/implementation-review-decision.test.ts test/unit/db test/integration/code-review-diff.test.ts test/integration/commands/implementation-review-governance.test.ts` → 337 pass / 0 fail; `bunx tsc --noEmit` clean; `bunx --bun @biomejs/biome check` on the touched files clean.

### What's addressed (✅)

- **P1.1 — Claim decisions now feed reconciliation.** New `humanDebtDecisionsFromImplementationDecisions` (`credit-reconciliation.ts`) maps accepted `approve_higher_burden` / `reduce_scope` claim adjustments to `waiver` and `restore_simplification` to `restoration`. `composeImplementationReviewerRecord` now builds `humanDebtDecisions` from `[...humanDebtDecisionsFromBinding(binding), ...humanDebtDecisionsFromImplementationDecisions(accepted)]`, where `accepted` is filtered to this binding and to decisions `classifyDecisionAcceptance` reports as accepted. Ordering is correct: `activeWaiver` takes the last matching entry, and implementation decisions are appended after the binding's frozen `effectiveDecisions`, so a later approval wins over an older inherited one. A new end-to-end test (`implementation-review-context.test.ts`, "an accepted higher-burden decision clears the same-phase shortfall") drives a real `credit_shortfall` gate, records the human decision through the normal step/decision append path, and asserts the second composition no longer raises the shortfall and reports the waived magnitude. **Addressed.**
- **P1.2 — The gate fold no longer gets stuck on a decided gate.** `deriveOpenImplementationGate` now always advances `predecessorGateId` after a decided gate, even when `applyImplementationDecisionCauseCoverage` removes nothing, so the next loop iteration computes a genuinely new, undecided `gateId` instead of re-emitting the just-decided one. `authorize_amendment` and `reduce_scope` decisions now return `null` directly (paused for a plan change, no successor), matching the updated comment. `allowedImplementationChoices` was also tightened: claim choices (`restore_simplification`/`approve_higher_burden`/`reduce_scope`) are only offered when a `credit_shortfall` cause has a non-empty `claimIds`, and `credit_unreconciled`-only or `inherited_budget`-only gates now correctly fall back to `abort` only, which is consistent with `applyImplementationDecisionCauseCoverage` never being able to clear those causes on their own. The `sqlite-index.ts` rebuild loop was updated in parallel (same break-on-amendment/reduce_scope, same "advance on no-op coverage" behavior), and the rebuild-parity test still passes. Two new store-level tests ("a decision that covers nothing advances to a successor gate", "scope and amendment decisions leave no open gate") pin this directly. **Addressed.**
- **P1.3 — Finding refs are now validated on the real path.** A shared `implementationFindingRefs` helper (duplicate rejection, `--finding` → eligible-map lookup, explicit `findingRefs` fingerprint check) is now used by both `submitImplementationReviewDecision` (new decisions) and the new `acceptStoredImplementationDecision` (retries), mirroring the plan path's `REVIEW_DECISION_FINDING_INVALID` behavior instead of silently dropping unmatched IDs. Covered by the new "unknown and mismatched findings are rejected" handler test. **Addressed.**
- **P1.4 — The shipped CLI path is now tested; the untested store method is gone.** `resolveImplementationGate` and its interface member were deleted outright (confirmed: no remaining references in `src/` or `test/`). A new `test/unit/commands/implementation-review-decision.test.ts` (5 tests) exercises `showReviewGate`/`submitReviewDecision` directly: `gate show --phase`, same-intent retry vs. different-intent conflict (`REVIEW_GATE_ALREADY_RESOLVED`), late-same-phase staleness, abort calling `abortRun` only after acceptance, and finding-ref validation. To make retries work on the real path, `submitReviewDecision` now looks up a stored decision line for the gate ID first and, if it decodes as an implementation decision, routes to a new `acceptStoredImplementationDecision` that recomputes the intent hash and either returns the accepted decision idempotently or fails `REVIEW_GATE_ALREADY_RESOLVED`. This is a reasonable, minimal way to get CAS-retry semantics onto the shipped path without resurrecting the old store method. **Addressed.**
- **P2 items from the prior review** are all resolved: `IMPLEMENTATION_DECISION_REQUIRED_FIELDS.restore_simplification` no longer lists the misplaced top-level `supersedesObservationId`; `DerivedImplementationGate.ledgerHash`/`decisionsHash` are now populated from a new `bindingFingerprint` lookup instead of `""`; the `bindingEvidenceFromImplementationDecisions` docstring now accurately describes the check as a consistency assertion rather than independent evidence; and the gate `record_seq` collision risk is fixed (`seq * 1024 + chainDepth` instead of `seq + chainDepth`). `showImplementationReviewGate`'s `exampleCommand` also now emits a working `--input-json` example for claim-adjustment choices instead of the old `--choice`/`--rationale` form that can't carry `claimAdjustments`.

### Remaining concerns

- **P2 (new) — `restore_simplification`'s reconciliation mapping is untested end-to-end.** `humanDebtDecisionsFromImplementationDecisions`'s `restoration` branch (and the `approve_higher_burden`/`reduce_scope` → `waiver` branch in isolation) has no direct unit test, and no test drives `restore_simplification` through `composeImplementationReviewerRecord` the way the new `approve_higher_burden` test does. The only coverage of `restore_simplification` is at the gate-cause-coverage level (`applyImplementationDecisionCauseCoverage`), which doesn't exercise the reconciliation-input mapping or the `restored()` lookup in `credit-reconciliation.ts` for this production wiring path. Given restoration is the one choice that reopens a claim for re-assessment rather than just waiving it, a gap here is more likely to hide a real bug than the already-tested waiver path. Add a test mirroring the new `approve_higher_burden` one, but for `restore_simplification`, asserting the superseded observation's claim is no longer treated as settled and can be freshly assessed.

This is a test-coverage gap, not a defect I can point to a concrete wrong behavior for — the mapping code itself looks correct by inspection (same pattern as the tested waiver branch, and `credit-reconciliation.ts`'s `restored()`/`settledPastClaim()` consumers are independently tested against hand-built `HumanDebtDecision` objects, just not through this exact production assembly function for this one choice).

### Updated readiness

- **Phase 8 completion:** ✅ — All four P1 blockers from the prior review are fixed with direct regression coverage on the real production path, and every P2 item raised previously is also resolved. `tsc`, lint, and the full scoped test set are clean.
- **Ready for next phase:** ✅ — with one new P2 (test-coverage only, `auto_fix`) noted above. Nothing here requires a design decision or blocks moving on.

---

## Addendum (2026-09-24, second) — restore_simplification test coverage closed

**Reviewed:** `1b3cdbe348c4dd05b977a8011e10cf477f115bad` (single commit on top of `8a6f814`: "Test restore_simplification reconciliation mapping and waiver isolation.")
**Local verification:** `bun test test/unit/review-governance test/unit/commands/implementation-review-context.test.ts test/unit/commands/implementation-review-decision.test.ts test/unit/db test/integration/code-review-diff.test.ts test/integration/commands/implementation-review-governance.test.ts` → 339 pass / 0 fail (up from 337); `bunx tsc --noEmit` clean; `bunx --bun @biomejs/biome check` on the touched files clean. This revision is test-only — no `src/` file changed.

### What's addressed (✅)

- **P2.2 — `restore_simplification` reconciliation mapping now has both unit and end-to-end coverage.** Two tests were added:
  - `credit-reconciliation.test.ts`, "claim decisions map to waivers or restorations in isolation": drives `humanDebtDecisionsFromImplementationDecisions` directly with `approve_higher_burden`, `reduce_scope`, `restore_simplification` (with and without `supersedesObservationId`), and `abort` inputs, and asserts the exact mapped output — confirming `approve_higher_burden`/`reduce_scope` become `waiver`s, `restore_simplification` becomes a `restoration` only when `supersedesObservationId` is present, and `abort` (and a restoration missing `supersedesObservationId`) map to nothing.
  - `implementation-review-context.test.ts`, "an accepted restoration reopens the superseded claim without waiving it": a full four-iteration `composeImplementationReviewerRecord` scenario — realize a claim, settle it (`carried: true`), record a `restore_simplification` decision through the real step/decision append path, and confirm the next composition reopens the claim (`status: "pending"`, `carried: false`, `effectiveApprovedMagnitude` back to the full original magnitude, `waiverDecisionId: null`, `credit_unreconciled` gate cause reappears), then confirms a fresh partial realization is accepted afterward. This is a meaningful, non-vacuous test: it would catch a regression in either the `restoration` mapping or the `restored()`/`settledPastClaim()` consumption in `credit-reconciliation.ts`, and it explicitly distinguishes restoration (full magnitude reopened) from waiver (reduced magnitude, no reopening) — the exact distinction the prior review's gap was about.

  **Addressed.** This closes the last open item from the prior review.

### Remaining concerns

None. All P1 items from the original review and all P2 items (including the one raised in the previous addendum) are now resolved with direct regression coverage.

### Updated readiness

- **Phase 8 completion:** ✅ — Every item raised across both prior review passes is now addressed. `tsc`, lint, and the full scoped test set are clean, and test count increased (337 → 339) without any regressions.
- **Ready for next phase:** ✅ — No corrections remain outstanding for this phase.
