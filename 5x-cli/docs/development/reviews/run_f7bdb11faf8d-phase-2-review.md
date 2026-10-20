# Review: Plan 215 Phase 2 — Provenance Validation and Registration (W2)

**Review type:** `ba5ead07d954440596de147028c7aef8d3c0ee38` (governance range `490f6f1..ba5ead0`, review context `ddb30c3f-c39a-47ce-944e-b84dc0091a84`)  
**Scope:** Phase 2 (W2) for run `run_f7bdb11faf8d`. This covers the `review implementation amend` command and handler, the `amendmentScope` recording flags and validation on `review decide`, `registerImplementationAmendment` (validation, dry-run, intent digest, paired receipt, readback), and the new fold check that ties each registered amendment to its human, approval and paired step evidence.  
**Reviewer:** Staff engineer (correctness, plan compliance, concurrency and idempotency, test strategy)  
**Local verification:**
- Focused suites pass: `bun test --timeout 30000 test/unit/review-governance/implementation-amendment-registration.test.ts test/unit/review-governance/implementation-amendment.test.ts test/unit/commands/implementation-recovery.test.ts test/integration/commands/implementation-completion.test.ts` gives 66 pass, 0 fail.
- `bun run typecheck` is clean. `bun run lint` exits 0 but reports 7 new `useOptionalChain` warnings, all in `implementation-amendment.ts` (P2.3).
- Full suite: `bun test --concurrent --dots --timeout 30000` gives 3951 pass, 0 fail across 256 files.

**Implementation plan:** `5x-cli/docs/development/plans/215-implementation-plan-amendment-plan.md` (approved commit `a5b3b69`, binding `ffa8a3af-0d29-4645-86c3-e55806f1b1ff`, advisory mode)  
**Technical design:** N/A

## Summary

Phase 2 adds most of what Decision 2 asks for. Recording validates `amendmentScope` strictly and never reads it from rationale. Each flag maps to one field, and the reopen flag needs an explicit `true` or `false`. Registration checks the intersection of the authorization and the assessment without clamping. Plain and qualified `--resolves` selectors are handled correctly. The intent digest is deterministic, the receipt is paired with its step, and the fold re-checks that evidence on every read. The pure registration function has good negative tests.

The command layer around it has problems:

1. In the standard workflow, `amend` rejects every amendment. The handler takes the last `git:commit` before the approval step as the approved plan commit. The plan reviewer always records its own review-document commit just before its verdict, so that commit is the one picked. The author-commit check then fails.
2. The CAS precondition is built partly from history read at append time, not from the history that was validated.
3. Registration skips the shared admission and finalization seam. On an idempotent retry it never projects the step into SQLite.
4. The handler has no tests at all. That is how (1) shipped.

**Readiness:** Not ready. There are four P1 items. All are mechanical (`auto_fix`) and follow existing patterns in `implementation-recovery.handler.ts` and `finalizeAndWritePreparedStep`.

---

## What shipped

- **`review implementation amend`** (`review.ts`): `--run`, `--human-step`, `--approval-step`, `--from-phase`, repeatable `--resolves`, and `--dry-run`. Help text says that generic gates do not qualify and that registration does not authorize completion.
- **`amendmentScope` recording** (`review.ts`, `review-decision.handler.ts`): the `--predecessor-revision`, `--earliest-affected-phase`, `--reopen-completed-phases true|false`, `--claim-edit` and `--resolution-ref` flags, plus structured `--input-json`. Scope flags are rejected on any other choice. `prepareAuthorizeAmendmentScope` fills fingerprints from the cited observations. It rejects a predecessor that is not current, an unknown phase, a claim that is not on the ledger, and a source ref outside `findingRefs` or outside a `plan_amendment` cause. `authorize_amendment` now lists `amendmentScope` as a required field.
- **`registerImplementationAmendment`** (`implementation-amendment.ts`): the core validation and registration function.
  - Run, binding and revision checks: the run must be active, and the binding, `B0`, `B`, mode and source must match the fold. The predecessor hash must match.
  - Provenance: the human step must be a coupled `human:review-governance` step whose decision is an accepted, unsuperseded, scope-bearing `authorize_amendment`. The approval must be a plan reviewer step after it, with `ready`, no items and no `final_corrections` route. The latest snapshot must be paired with it.
  - Plan shape: phase IDs must stay the same and in the same order. Each preserved phase must keep the same section, the same linked work-item contracts and the same claim contracts.
  - Scope intersection: `from-phase` must equal the assessed boundary, and the boundary may not precede `earliestAffectedPhase`. Reopening a completed phase needs consent. Assessment claim effects must exactly equal the effects derived from the ledgers and be inside `claimEdits`. The `--resolves` set must equal the assessment, which must be covered by `resolutionRefs`.
  - Recording: a deterministic intent digest and amendment ID, a per-predecessor budget key, and a paired `atomicAppendIfAllNew` with readback. Identical retries return the winner, and a changed intent conflicts.
- **Fold hardening**: `verifyRegisteredAmendmentEvidence` recomputes the digest. It requires the coupled human step, a matching approval assessment and exactly one paired `implementation:amendment` step.
- **Tests**: `implementation-amendment-registration.test.ts` (10 tests on the pure function). The recovery and completion fixtures were updated to record `amendmentScope`.

---

## Strengths

- **Fail-closed scope intersection.** A broader assessment is rejected, never clamped, at the boundary, claim and resolution levels. Claim effects are derived from the ledgers and compared to the assessment as an exact set, so an unlisted `reduce_magnitude` cannot ride along with an `edit_contract`.
- **Recording never infers scope.** No field is defaulted or read from rationale. The flag parser and `parseAmendmentScope` both reject a missing reopen token and a non-boolean value. A test pins down that rationale naming an effect gives that effect no authority.
- **Plain `--resolves` matches only the source observation**, as Decision 2 requires. A test confirms that the same ID on another phase is not selected.
- **Registered amendments are re-checked on read.** The fold now verifies each registered amendment's digest, human and approval coupling, and paired step every time it runs. A forged or unpaired receipt cannot become authority even if the registration code is bypassed.
- **Output keeps the boundaries clear.** `completionAuthorized: false`, the preserved binding provenance, and separate `authorizedScope`, `assessedScope` and `intersection` match Decisions 2 and 8.

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1 — `amend` picks the reviewer's review-document commit as the approved plan commit, so real registrations always fail

`amendImplementationPlanCommand` (`src/commands/review-decision.handler.ts:1415`) takes the last `git:commit` step before the approval step as `commit`. It passes that value as both `approvedPlanCommit` and `boundaryCommit` (`:1482-1483`). `src/templates/reviewer-plan.md:133` and `reviewer-plan-continued.md:116` require the plan reviewer to run `5x commit --run {{run_id}} --phase plan --files {{review_path}}` before its verdict is recorded. So in every orchestrated amendment review, that last `git:commit` is the review-document commit, not the author's plan commit. Registration then needs a completed plan `author:*` step between the human and approval steps whose `result.commit` or `head_commit` equals this commit (`implementation-amendment.ts:2384`). The author step records the author commit, so registration is rejected with "The approved plan commit must be the completed author commit at the review boundary." If that check were relaxed, the receipt would instead store the review commit as `afterCommit` and `approvedPlanCommit`.

Passing the same value as both fields also makes the `approvedPlanCommit !== boundaryCommit` guard a no-op.

The unit tests never hit this. They call the pure function directly with `approvedPlanCommit` set to the author commit, and the fixture has no `git:commit` steps.

**Requirement:** Resolve `approvedPlanCommit` from the completed plan author step between the human and approval steps (`result.commit`). Keep the review boundary as the last `git:commit` before the approval. Require the approved commit to be an ancestor of the boundary and the boundary an ancestor of HEAD. Plan bytes must be equal at the approved commit, the boundary and HEAD, and only excluded paths may differ. `implementation-recovery.handler.ts:96-153` already does this, and Decision 4 asks for it ("A later review/run-artifact commit is acceptable only through existing excluded-path equivalence"). Pass the two commits separately so the guard means something. Add a handler-level test with an author commit followed by a reviewer `git:commit` (see P1.4).

### P1.2 — The CAS precondition does not use the history that registration validated

In `registerImplementationAmendment`, the `steps` keys come from a snapshot taken during validation (`:2055`). The `budget` and `decisions` keys are read again inside the `atomicAppendIfAllNew` call (`:2736-2741`). Everything that was validated was read earlier: the fold, `lineageTail`, observations, contexts, snapshots, the consumption scan, and `listImplementationDecisions` at `:2098`. Suppose another process appends a budget line with no paired step after those reads and before the append. Examples are a `recover-plan` receipt (still shipped until Phase 4, written alone with its own CAS), a review context, or a text amendment. The precondition passes, and the amendment is appended on the same predecessor. The result is a forked chain, which the Phase 1 fold rejects, so the run becomes unreadable. A budget-only line can arrive at any point after those earlier reads. The steps snapshot catches it only if it carries a paired step. This breaks the Phase 2 completion gate ("stale/concurrent evidence cannot win") and Decision 7.

The test "a concurrent step makes the captured history stale" injects its write inside the `atomicAppendIfAllNew` wrapper, after the key arrays have been evaluated. So it passes for any stream and does not cover this window.

**Requirement:** Read all three streams' keys once, before the first validation read, and pass those snapshots as `expectedKeys`. `implementation-recovery.ts:433-437` does exactly this. Add a test that appends a budget-only line (for example a recovery receipt or a context) between validation and append, for instance by hooking `listLines` after the first call. Assert `RECORD_PRECONDITION_FAILED` and that the chain is not forked.

### P1.3 — Registration skips the shared admission and finalization seam, and a retry never projects the step locally

Phase 2 requires the receipt and record to be paired "through shared admission/finalization", and requires a test of "retry after partial local projection". `registerImplementationAmendment` calls `recordStore.atomicAppendIfAllNew` directly. The handler projects into SQLite only when `result.created` is true (`review-decision.handler.ts:1496`). Suppose the journal pair is durable but the process dies before `recordStep` runs. Every later retry gets `created: false` and never inserts the `implementation:amendment` row, so the local index stays missing that step. The direct append also skips what `prepareRecordStepAppend` and `finalizeAndWritePreparedStep` (`run-v1.handler.ts:3299`) do: max-steps admission, `ensureRunRecord`, payload redaction, and projecting the durable step line whether it was created or a duplicate. The `human:review-governance` decision path uses that seam (`review-decision.handler.ts:1637-1684`). There is no test for retry after partial local projection. The "failed precondition" test is a different case.

**Requirement:** Route the paired write through `prepareRecordStepAppend` and `finalizeAndWritePreparedStep` in `paired-all-new` mode, with the budget receipt as `extraOps`. Extend that seam to forward `expectedKeys`, as Decision 7 allows. At minimum, project the durable step line on both the created path and the winner-readback path; `recordStep` is `INSERT OR IGNORE`, so this is safe. Add a test where the journal pair exists and the SQLite row does not, and assert that a retry projects it.

### P1.4 — The `amend` command handler is untested

Nothing in `test/` calls `amendImplementationPlanCommand` or the `review implementation amend` CLI. The Phase 2 test list ("stale plan/head", "missing authorization", step selectors) is covered only for the pure function, with `headAccepted` and `committedPlanBytes` passed in by hand. These are all untested:
- the Git logic: boundary resolution (P1.1), plan-at-commit equality, ancestry, `assertCleanCodeWorktree`, and excluded-path equivalence
- `resolveJournalStep`: numeric IDs, run-qualified keys, and rejection of other runs
- `unresolvedApprovalGate` mode handling
- the SQLite projection (P1.3)

**Requirement:** Add handler tests using the existing Git fixture pattern in `test/unit/commands/implementation-recovery.test.ts`. Cover at least: a successful dry-run and record through the real author commit → reviewer `git:commit` → verdict sequence; a code change after approval; a dirty worktree plan; a numeric step selector and a run-qualified one; a step key from another run; and an identical retry.

---

## Medium priority (P2)

- **P2.1 — The registration output does not use the canonical finding register.** `pendingFindings` (`implementation-amendment.ts:2578`) lists every item in every observation on the binding, minus the newly resolved ones. That includes findings later rounds closed, repeats across rounds, and observations a prior revision invalidated. Decisions 6 and 8 say there is one canonical effective finding register, and the fold exposes it as `findings`. This brings back, in operator output, the defect Phase 1 fixed in the fold (Phase 1 review, item 1). Build the list from `folded.findings` with status `pending`, excluding the findings this registration resolves.
- **P2.2 — Retrying the same `authorize_amendment` decision fails after its amendment registers.** `acceptStoredImplementationDecision` (`review-decision.handler.ts:1178`) rebuilds the scope through `recordedAmendmentScope`, which requires `predecessorRevisionId` to be the current revision. Once the amendment registers, the revision has moved on. Re-running the same `review decide` then fails with `REVIEW_DECISION_INVALID` instead of returning the stored decision. On the stored-decision path, compare the supplied scope with the stored decision's `amendmentScope` (with fingerprints filled from the cited observations) and skip the current-predecessor check, which belongs to new recordings.
- **P2.3 — Seven new Biome `useOptionalChain` warnings** in `implementation-amendment.ts` (lines 1570, 2007, 2062, 2087, 2106, 2177, 2356). Apply the fixable rewrite.

---

## Nonblocking follow-ups

- The approval check accepts a reviewer result with no `governance.route` (`verdict.governance?.route !== undefined && …`). `ready` with no items makes that safe in practice. Requiring a persisted `complete` route, or deriving it via `routeAfterDecision` as `run-v1.handler.ts:1069-1100` does, would match Decision 4's "normalized approval route `complete`" exactly.
- The `consumed` scan cannot reach its semantic-amendment branch. An authorization's predecessor is fixed in its scope, so the same authorization cannot appear under a different predecessor. The recovery branch is reachable only through legacy decisions, which are rejected earlier for omitting `amendmentScope`. Remove it or make it an assertion.
- The record lock does not cover the Git HEAD and worktree checks, which run in the handler before registration. This matches the recovery handler and is inherent to the RecordStore boundary. Note it in the Phase 4 operator guidance.
- `canonicalIntent` duplicates `decisions.ts` `canonical()` and, like it, sorts keys with `localeCompare`. Consider sharing one canonical encoder that sorts by code unit for digests.
- `recordedAmendmentScope` checks claim IDs against the original binding ledger, not the current revision's ledger. After a withdrawal, an authorization can still name the withdrawn claim. Registration rejects it later, because the derived effects will not include it, so this is fail-closed.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Resolve the approved plan commit from the author step, and check the review boundary through ancestry and excluded-path equivalence
- [ ] P1.2 Build the CAS `expectedKeys` from the snapshot taken before validation, for all three streams
- [ ] P1.3 Pair the write through the shared finalization seam, and project the step on retry
- [ ] P1.4 Add handler and CLI tests for `amend`

**Phase readiness:** ❌ Phase 3 should not start until P1.1–P1.4 are fixed. Phase 3 threads the effective revision through execution, which assumes registration can succeed in the real workflow and cannot fork the chain.

