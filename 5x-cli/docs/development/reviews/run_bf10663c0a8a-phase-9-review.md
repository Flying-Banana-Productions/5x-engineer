# Review: Phase 9 — Phase admission and completion invariants (W9)

**Review type:** `525ca7b..3128412` (`d326ce7`, `3128412`)
**Scope:** New `review-governance/implementation-boundary.ts` predicate; its use in `run record` (`phase:complete`, author admission), `run complete`, `template render` / `invoke` author admission, and `run state`; skill text; unit, integration and run-state tests
**Reviewer:** Staff engineer (correctness, plan compliance, test strategy, operability)
**Local verification:** `bun test test/unit/review-governance/implementation-boundary.test.ts test/integration/commands/implementation-completion.test.ts test/unit/commands/run-state-review-budget-wiring.test.ts` → 23 pass / 0 fail. `bunx tsc --noEmit` passes. Everything else in this review is static.

**Implementation plan:** `docs/development/plans/210-implementation-review-governance-plan.md` (Phase 9)
**Technical design:** N/A

## Summary

Phase 9 adds one read-only boundary predicate, `evaluateImplementationBoundary`, and a store-backed wrapper. It calls them before `phase:complete`, before implementation author admission (native render, invoke and direct record), and before `run complete --status completed`. `run state` gains an `implementation_governance` readiness block. The predicate's structure matches the plan: the pinned binding mode, reviewed-or-exact-correction-proof, due claims reconciled, open material gates, and plan drift measured against the approved bytes plus verified amendment lineage. Advisory mode reports without blocking, and unbound budgeted runs fail with `IMPLEMENTATION_APPROVAL_REQUIRED`.

The phase is not complete. The completion freshness check requires `HEAD === context.reviewedCommit` exactly. `reviewedCommit` is the last *code* commit, and review-artifact commits are deliberately excluded from it. In the normal workflow the reviewer commits its review document, so HEAD has moved past `reviewedCommit` and enforced `phase:complete` is denied. Only the Phase 6 correction-proof path can succeed. No test covers a successful enforced completion after a real review, so this was missed. There are three smaller problems. `run complete` never checks the final phase for code added after review. The new `phase:complete` short-circuit returns the old record after a reopen, although the plan requires new checks, and it also changes v1 duplicate behavior. And a HEAD that cannot be resolved silently turns off the freshness check.

**Readiness:** Not ready. One P0 blocks the normal enforced completion path. Each fix follows from existing code.

---

## What shipped

- **`implementation-boundary.ts`**: `evaluateImplementationBoundary` handles three intents (`phase_complete`, `advance`, `run_complete`). `phasesForIntent` checks earlier phases for `advance`, earlier phases plus the current phase for `phase_complete`, and all phases for `run_complete`. `exactCorrectionCarryProof` requires every Phase 6 eligibility field, and the carried claims must match the source observation field by field. `evaluateStoredImplementationBoundary` loads binding, compatibility, amendments, observations, contexts, reconciliations, correction attempts and open gates. A read failure returns `IMPLEMENTATION_EVIDENCE_MALFORMED`.
- **`run record`**: `phase:complete` now runs first-admission binding through `ensureImplementationAdmission`, then the `phase_complete` boundary. Author admissions run the `advance` boundary. A duplicate `phase:complete` for the same phase returns the existing record.
- **`run complete`**: a completed seal with implementation history and no binding first runs binding admission, then the `run_complete` boundary. Abort is unchanged.
- **Template/invoke**: after `ensureImplementationAdmission` returns `bound`, author templates run the `advance` boundary before pre-author HEAD capture.
- **`run state`**: `implementation_governance` appears only when there is a binding, compatibility record or numeric-phase history. The plan-review budget output does not depend on it (`3128412`).
- **Skill**: `5x-phase-execution` says checked boxes are not enough and points to `implementation_governance`.

---

## Strengths

- The predicate is pure and has no I/O. The store wrapper is thin. This follows the plan's "one read-only predicate threaded through existing paths", and adds no new authority.
- The mode is taken from the binding (`binding?.mode ?? input.mode`), so later config edits cannot weaken an enforced execution.
- `exactCorrectionCarryProof` is strict. It checks the outcome, the invalidation flag, quality skipped/timed-out, architecture/boundary/inventory, binding/observation identity, destination commit and an exact claim match. Generic quality success cannot pass as proof.
- The drift check reuses Phase 5's `detectPlanDrift` with binding-filtered amendments, so checkbox-only and verified-lineage edits are not treated as drift.
- `3128412` fixes a real coupling: plan-only runs no longer have their review-budget output depend on implementation readiness. The new run-state test pins this.

---

## Production readiness blockers

### P0.1 — Enforced `phase:complete` is denied after any review-artifact commit

**Risk:** `phaseSettlement` sets `headMatches` only when `reviewedCommit === input.headCommit`, or when an exact correction proof exists (`implementation-boundary.ts`, `phaseSettlement`). `reconciliationFresh` uses the same equality. `context.reviewedCommit` comes from `advanceReviewedCommit` (`implementation-state.ts:1800–1835`). By design it skips commits that touch only excluded paths: review artifacts, run records and the plan. In the documented flow the reviewer commits its review file with `5x commit`, then the orchestrator records `phase:complete`. `enforceImplementationBoundary` reads the live `HEAD` at that point, which is the review commit. `HEAD !== reviewedCommit`, so `reviewed=false`, and an enforced run cannot complete any phase through the ordinary `complete` route. This branch's own history shows the pattern: `525ca7b review: …` follows each author commit. The same mismatch occurs when checklist ticks are committed after review.

**Requirement:** Completion freshness must accept HEAD when `reviewedCommit` is an ancestor of HEAD and `reviewedCommit..HEAD` changes only the context's `excludedPaths`, which covers the review artifacts, run records and plan. Plan-byte changes are already covered by the drift check. Any code change after `reviewedCommit` must still deny unless the exact correction proof applies. Apply the same rule to `reconciliationFresh`.

**Implementation guidance:** In `enforceImplementationBoundary`, resolve an "effective code head" before calling the pure predicate. Use `isCodeAncestor` and `changedCodePaths(git, reviewedCommit, head, context.excludedPaths)`, the same primitives `advanceReviewedCommit` uses. Pass `reviewedCommit` as `headCommit` when only excluded paths changed. Alternatively, pass a per-phase `codeHeadMatches` flag into the predicate. Add a unit case where HEAD ≠ reviewedCommit with a review-only delta, which should allow, and a code delta, which should deny. Add an integration test that records a real implementation review, commits a review file, and then completes the phase.

---

## High priority (P1)

### P1.1 — `run complete` never checks code freshness for any phase

`requireHeadMatch` is `input.intent !== "advance" && phase.id === input.phase`. For `run_complete`, `input.phase` is undefined, so no phase is checked against HEAD. `run complete` also does not require a recorded `phase:complete`. An author can therefore commit code after the final phase's approving review, skip `phase:complete`, and seal an enforced run. The plan says "all other post-assessment code changes invalidate assessments" and asks for the predicate before any completed `runV1Complete` seal. For `run_complete`, apply the freshness rule to the last phase in `phaseMap`, using the excluded-path-aware comparison from P0.1. Add a unit case where `run_complete` has code after the last review, which must deny.

### P1.2 — `phase:complete` short-circuit ignores reopen and changes v1 duplicate semantics

`recordStepInternal` now returns any existing same-phase `phase:complete` with `recorded:false`, before admission or boundary checks. It does this for every run, including `off`/v1 runs and calls without `--iteration`. Before this change, duplicates were detected only with an explicit `--iteration` (`prepareRecordStepAppend`, `lookupExisting`), and otherwise the iteration was incremented. The plan says: "Duplicate already-admitted completion returns the original record; new work after reopen must pass current checks again." Because the lookup does not consider `run:reopen` or later same-phase steps, a phase reopened with new code gets the stale completion and bypasses the boundary. Limit the short-circuit to runs with an implementation binding. Do not short-circuit when a `run:reopen` or a same-phase author/reviewer step was recorded after the existing `phase:complete`. In those cases, fall through to admission and boundary evaluation. Add tests for duplicate-returns-original and for completion after reopen with new work being re-checked.

---

## Medium priority (P2)

- **An unresolved HEAD turns off the freshness check in enforced mode**: `enforceImplementationBoundary` sets `headCommit = null` when `controlPlane` is absent or `getLatestCommit` throws. The predicate then treats `headCommit === null` as a match. The plan says missing evidence denies enforced completion. For `phase_complete`/`run_complete` with a pinned `enforced` binding, deny when HEAD cannot be resolved. Advisory mode should keep only a diagnostic. `advance` can still pass `null`, because it does not check freshness.
- **Integration coverage lags the Phase 9 test list**: `implementation-completion.test.ts` covers only the deny paths: unbound, checked boxes, skipped checklist, seal before review, and abort/reopen. The plan also lists: multiple approved sources; first/next-phase native and invoke rendering with a blocked earlier phase; direct author recording without pre-author capture; run completion after realization; zero-claim runs; last-phase shortfall; and successful completion after guard-verified text lineage and after eligible carry-forward. Those allow paths are covered only by pure unit fixtures where HEAD equals `reviewedCommit`, which is why P0.1 was missed. At minimum, add one integration test for a successful enforced lifecycle and one for a blocked next-phase render.
- **`run complete` binding shim uses a fake phase**: `runV1Complete` calls `enforceFirstImplementationAdmission` with `{ stepName: "phase:complete", phase: "1" }` only so that it passes the `admitsGovernance` gate. Add an explicit `force`/`intent` parameter so later changes that make admission phase-sensitive cannot misattribute it to Phase 1. Also, a non-`RecordError` thrown by `budgetStore.getImplementationBinding` in the second condition escapes as an unformatted error. Handle it the same way as the first read.

---

## Readiness checklist

**P0 blockers**
- [ ] Completion freshness accepts HEAD whose only changes after `reviewedCommit` are in excluded paths (review/run-record/plan), for both review and reconciliation freshness, with unit and integration coverage of the normal review → review-commit → `phase:complete` flow.

**P1 recommended**
- [ ] `run_complete` checks the final phase for code changed after review.
- [ ] `phase:complete` short-circuit is limited to bound runs and re-evaluates after reopen or new same-phase work. v1 duplicate semantics are unchanged.
