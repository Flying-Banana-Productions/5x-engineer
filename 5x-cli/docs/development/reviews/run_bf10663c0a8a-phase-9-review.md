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

---

## Addendum (2026-09-24) — Freshness, seal-path and short-circuit fixes

**Reviewed:** `3128412..a42ee00` (`3eadddb`, `a42ee00`)
**Local verification:** `bun test test/unit/review-governance/implementation-boundary.test.ts test/integration/commands/implementation-completion.test.ts test/unit/commands/run-state-review-budget-wiring.test.ts test/unit/commands/run-v1.handler.test.ts` → 43 pass / 0 fail. `bunx tsc --noEmit` and `bun run lint` are clean. Everything else in this addendum is static.

This revision is two commits: `3eadddb` does the substantive work, `a42ee00` is formatting only (`bun run format`/`biome` output on the same files, no logic change — confirmed by re-diffing `3eadddb..a42ee00`, which touches only whitespace).

### What's addressed (✅)

- **P0.1 — Enforced `phase:complete` denied after review-artifact commit**: Fixed. `equivalentReviewedCommits` (`run-v1.handler.ts`) walks from the phase's `reviewedCommit` (and, separately, its reconciliation's `reviewedCommit`) to `headCommit` with `isCodeAncestor` + `changedCodePaths(..., excludedPaths)`, exactly the primitives `advanceReviewedCommit` uses to build `reviewedCommit` in the first place. A commit only counts as fresh when the range to HEAD is ancestor-reachable and touches nothing outside `excludedPaths`; any git failure drops the commit from the equivalence set rather than defaulting to a match, so enforced mode still fails closed on an unreadable repo. `phaseSettlement`'s `headMatches`/`reconciliationFresh` now call the new `commitMatchesHead(commit, headCommit, equivalent)` instead of the old exact-equality check. New integration test `"a review commit after the reviewed code still allows phase completion"` reproduces the real workflow — author commit, review, **commit the review artifact** (HEAD now differs from `reviewedCommit`), then `phase:complete` succeeds — and separately proves that a real code edit after that point still blocks `run complete` with `IMPLEMENTATION_BOUNDARY_BLOCKED`. New unit test `"review-only commits after reviewedCommit stay fresh..."` isolates the same logic at the predicate level, including the negative case (a code-touching delta still denies). Verified by reading `equivalentReviewedCommits`, `commitMatchesHead`, and running the new tests.

- **P1.1 — `run complete` never checked the final phase's freshness**: Fixed. `freshnessPhaseId` now returns `binding.phaseMap.at(-1)?.id` for `run_complete` (previously `requireHeadMatch` was `phase.id === input.phase`, and `input.phase` is `undefined` for `run_complete`, so no phase was ever checked). `equivalentReviewedCommits` mirrors this by resolving the same last-phase id when `intent === "run_complete"`. New unit test `"run completion checks the last phase for code added after review"` directly exercises this: an `allow` when the last phase's post-review delta is review-only, a `deny` with `reviewed:false` on phase "2" when it is a real code delta. The new integration test above also proves this end-to-end (seal fails after a post-review code commit). Verified.

- **P1.2 — `phase:complete` short-circuit bypassed reopen and altered v1 duplicate semantics**: Fixed. The short-circuit in `recordStepInternal` is now gated on `hasImplementationBinding(recordStore, params.run)`, so unbound/v1 runs fall through to the pre-Phase-9 iteration-increment path unchanged — confirmed by the new unit test `"unbound phase completion still allocates the next iteration"`. For bound runs, a `reopened` flag now checks whether any step with a higher id than the existing `phase:complete` is either a global `run:reopen` or a same-phase `author:*`/`reviewer:*` step; if so, the short-circuit is skipped and the record falls through to admission + boundary evaluation again. The new unit test `"a bound duplicate completion returns the original until reopen or new same-phase work"` exercises all three paths: plain duplicate → returns original; new `author:implement` in the same phase (a same-phase repair without an explicit reopen) → re-checked and recorded as new; explicit `run:reopen` → re-checked and recorded as new. This is a reasonable reading of "new work after reopen must pass current checks again" that also covers same-phase repairs, which the plan explicitly allows. Verified.

- **P2.1 — Unresolved HEAD failed open on enforced completion**: Fixed. `evaluateImplementationBoundary` now computes `headUnresolved = input.intent !== "advance" && input.headCommit === null` and includes it in `blocked`, so a null HEAD denies in enforced mode (and only adds a diagnostic in advisory, per the existing advisory-never-blocks contract) instead of the old `input.headCommit === null` short-circuit inside `phaseSettlement` that treated missing HEAD as an automatic match. `advance` intent is explicitly excluded, consistent with `advance` never having required freshness. New unit test `"unresolved HEAD denies enforced completion and stays advisory"` covers all three cases (enforced deny, advisory allow-with-diagnostic, advance allow). Verified.

- **P2.3 — `runV1Complete` binding shim faked phase "1" and left an unguarded second read**: Fixed. `enforceFirstImplementationAdmission` gained an explicit `force?: boolean` parameter; `runV1Complete` now calls it with `{ stepName: "run:complete" }` and `force: true` instead of fabricating `{ stepName: "phase:complete", phase: "1" }`. The second `budgetStore.getImplementationBinding(runId)` read (used to decide whether to run the boundary check after admission) is now wrapped in its own try/catch that fails closed to `true` on a read error, matching the pattern already used for the first read. Verified by reading the diff; no new test specifically targets the shim's error path, but the change is small and mechanical and the existing integration suite continues to exercise the success path.

### Newly introduced issues

None found. The `codeEquivalentCommits` array is computed once per boundary call and passed uniformly to `phaseSettlement` for every phase in `phasesToCheck`, but it is only consulted when `requireHeadMatch` is true, which `freshnessPhaseId` limits to at most one phase per call — so there's no cross-phase leakage of the wrong equivalence set. The `equivalentReviewedCommits` helper is intentionally conservative (unreachable ancestry or a git error drops the commit from the set, never adds one), which preserves fail-closed behavior in enforced mode. Formatting-only commit `a42ee00` introduces no behavior change.

### Remaining concerns (P2, unchanged from original review)

- **P2.2 — Integration coverage still lags the Phase 9 test list, though materially improved**: Partially addressed. Two targeted integration tests were added (review-commit-after-review-still-completes-then-later-code-blocks-seal; next-phase render blocked while an earlier phase is open), which is exactly the coverage that would have caught P0.1 and P1.1 — a meaningful improvement. Still not covered by an integration test: multiple approved sources (zero/multiple candidates for `IMPLEMENTATION_APPROVAL_REQUIRED`), direct author recording without pre-author capture, run completion after realization, zero-claim runs, last-phase shortfall, and completion after eligible carry-forward. These remain P2 — polish/hardening, not blockers — since the underlying logic for each is already covered by the existing unit-level `implementation-boundary.test.ts` fixtures (e.g., `"carry-forward requires the exact eligible correction proof"`, `"a zero-claim phase completes from the review alone"`); the gap is CLI-path integration coverage, not predicate correctness.

### Updated readiness

- **Phase 9 completion:** ✅ — The P0 blocker and both P1 findings are fixed with direct, verifiable code changes and matching regression tests (unit-level isolating the predicate change, integration-level reproducing the real workflow). Both P2 findings from the original review (unresolved-HEAD fail-open, binding-shim phase fabrication) are also fixed. Full local test suite for the affected files passes (43/43), and typecheck/lint are clean.
- **Ready for next phase:** ✅ — No blocking or human-required items remain. The one open item (P2.2, additional integration coverage) is optional hardening with existing unit-level coverage as a safety net, not a correctness gap.

---

## Addendum (2026-09-24) — Correction carry-forward route fix and full P2.2 integration coverage

**Reviewed:** `a42ee00..2ded60c` (single commit `2ded60c`)
**Local verification:** `bun test test/unit/review-governance/implementation-boundary.test.ts test/integration/commands/implementation-completion.test.ts test/unit/commands/run-state-review-budget-wiring.test.ts test/unit/commands/run-v1.handler.test.ts` → 48 pass / 0 fail (up from 43). `bunx tsc --noEmit` and `bun run lint`/`biome check` are clean. Everything else in this addendum is static.

This revision is one commit that both fixes a real bug found while closing out P2.2 and adds the integration tests the prior addendum asked for.

### What's addressed (✅)

- **P2.2 — Integration coverage lagged the Phase 9 test list**: Fully addressed. Six new integration tests were added to `implementation-completion.test.ts`, closing every scenario named in the original review and the prior addendum:
  - `"multiple approved sources block completion until one source is selected"` — zero/multiple approved candidates, `IMPLEMENTATION_APPROVAL_REQUIRED` on both `phase:complete` and direct author admission, then successful `review implementation bind --source-run`, then still-blocked completion until the phase is actually reviewed.
  - `"a direct author record keeps the legacy commit parent and still blocks the next phase"` — direct author recording with no `implementation:pre-author` step (`preAuthorSteps(...) === []` asserted), confirming the legacy git-commit-parent fallback from Phase 3, plus next-phase admission still blocked.
  - `"a zero-claim review seals, and a realized claim seals only after the realization"` — a zero-claim phase completes from the review alone; a phase with a due claim is blocked (`completionAuthorized: false`, `IMPLEMENTATION_BOUNDARY_BLOCKED`) until a `creditRealizations` verdict realizes it, then completes and seals.
  - `"a material shortfall in the last phase blocks phase and run completion"` — a `not_realized` claim at the last phase blocks both `phase:complete` and `run complete`, and `run state`'s `implementation_governance.phases` correctly reports `ready: false` for that phase.
  - `"an eligible correction proof carries the realized claim through phase completion"` — the end-to-end shortcut path: a `ready_with_corrections` verdict with exactly one mechanical P2 `auto_fix` `implementation_defect` and a realized claim, then `review corrections finish` producing a `status: "complete"` attempt, then `phase:complete` succeeds via the carry-forward proof, then a further code commit after the correction still blocks `run complete`.
  All five were verified by reading each test body; they exercise real CLI subprocess paths end-to-end (`protocol validate`, `template render`, `run record`, `review corrections finish`, `run complete`, `run state`), not just the pure predicate. Verified.

- **A previously undiscovered bug in `implementation-boundary.ts`, found and fixed while adding this coverage**: `phaseSettlement`'s `correctedComplete` branch previously required `observation?.route === "final_corrections"` for the carry-forward exemption. Reading `src/review-governance/implementation.ts` (the function that actually derives and stores `governance.route` on real observations) shows the enforced/advisory route derivation only ever produces `"human_gate"`, `"author_revision"`, or `"complete"` — `"final_corrections"` is a value the pure `evaluateImplementationCorrectionEligibility` helper in `corrections.ts` returns internally but which is never persisted onto a real `ImplementationReviewObservationPayload.route`. That means the pre-existing `correctedComplete` branch was **unreachable for any real observation** — the entire Phase 6 CLI-shortcut carry-forward completion path was dead code before this commit, even though `finishImplementationCorrection` had been faithfully recording eligible correction attempts all along. The fix changes the route check to `observation?.route === "final_corrections" || observation?.route === "author_revision"`, which matches the actual value (`"author_revision"`) that `implementation.ts` stores for the eligible-shortcut case. This is safe because `finishImplementationCorrection` (the sole production writer of `ImplementationCorrectionAttemptPayload`) only ever creates an attempt capable of satisfying `exactCorrectionCarryProof` when `evaluateImplementationCorrectionEligibility(observation.originalVerdict).status === "eligible"` **and** `observation.route === "author_revision"` with no gate causes/error diagnostics in enforced mode (`durableShortcut` in `corrections.ts`) — so broadening the route match does not let an ordinary (non-eligible) `author_revision` observation slip through; the `proof` check remains the actual gate, and only genuinely eligible attempts can ever produce it. Verified by tracing the full call graph (`implementation.ts` → `governance.route`; `corrections.ts` → `finishImplementationCorrection` → `durableShortcut` gate → `recordCorrectionAttempt`) and confirming no other code path writes a correction attempt. New unit test in `implementation-boundary.test.ts` (extending `"carry-forward requires the exact eligible correction proof"`) directly asserts `allow` for an `author_revision`-routed observation with a matching proof. The new integration test `"an eligible correction proof carries the realized claim through phase completion"` is the regression test that would have failed before this fix, since it exercises the real `implementation.ts` → `finishImplementationCorrection` → `evaluateStoredImplementationBoundary` path.

### Newly introduced issues

None found. This is a one-line logic fix (route-check broadening) plus test additions; no new code paths, no new I/O, no new failure modes. The change is strictly a bugfix that makes an already-written, already-gated code path (correction-attempt carry-forward) reachable — it does not weaken any existing check, since the `proof` computation (`exactCorrectionCarryProof`) is unchanged and remains the actual authorization gate.

### Remaining concerns

None at P0/P1/P2. All items from the original review and the first addendum are now resolved.

### Updated readiness

- **Phase 9 completion:** ✅ — All P0/P1/P2 items from both the original review and the first addendum are closed. This revision additionally found and fixed a genuine dead-code bug (the Phase 6 CLI-shortcut carry-forward path was unreachable) while closing out the integration-coverage gap, and added direct regression coverage for it at both the unit and integration level. 48/48 targeted tests pass; typecheck and lint are clean.
- **Ready for next phase:** ✅ — No blocking, human-required, or open P2 items remain for Phase 9.
