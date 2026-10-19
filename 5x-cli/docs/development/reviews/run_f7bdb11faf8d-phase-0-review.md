# Review: Plan 215 Phase 0 — Verify Merged Prerequisite and Mutation Boundary

**Review type:** `a396e35544dd63602b98b4aa65a95e10569e0583` (governance range `4af6e20..4af6e20`, review context `44eeafae-bb48-4750-9a9f-ca6fde8b8395`)  
**Scope:** Phase 0 verification for run `run_f7bdb11faf8d`: prerequisite ancestry, reader inventory, legacy recovery codec and attribution algorithm, upgrade discovery, mutation boundary, and the protocol and `amendmentScope` codec fit  
**Reviewer:** Staff engineer (correctness, plan compliance, operability)  
**Local verification:** `bun test test/unit/commands/implementation-recovery.test.ts`: 26 pass, 0 fail at baseline `4af6e20`. Every code claim in the verification record was also checked by hand against the baseline tree.

**Implementation plan:** `5x-cli/docs/development/plans/215-implementation-plan-amendment-plan.md` (approved commit `a5b3b69`, binding `ffa8a3af-0d29-4645-86c3-e55806f1b1ff`, advisory mode)  
**Technical design:** N/A

## Summary

Phase 0 changes no product code. The commit adds a verification record at `docs/development/runs/215-implementation-plan-amendment-plan/run_f7bdb11faf8d/phase-0-verification.md`, ticks the six Phase 0 checkboxes in the plan, and adds the run's binding and pre-author records. Everything the governance diff covers falls under excluded paths, so the reviewed range has no code changes. This is expected for a verification-only phase.

I checked the record's factual claims against the baseline source, and they hold. The record also keeps the approved surface and design unchanged. One ambiguity in the causal attribution algorithm should be fixed before Phase 1 builds the effective revision fold from it.

**Readiness:** Ready with corrections. There is one P2 wording correction to the attribution rule. Nothing blocks Phase 1.

---

## What shipped

- **Prerequisite ancestry**: names the integrated commit `4af6e20`. It lists the plan 210 merge (`f3a8d67`), the coupled fixes (`8c3f93d`, `a586918`, `6f19ac9`, `76938df`), repeated recovery (`a15d7b9`) and the documentation base (`aeaabb1`). All are confirmed ancestors of `4af6e20`. The post-approval commit `4af6e20` (optional `architectureApprovalId`, final corrections in recovery) is reconciled as the integrated recovery contract.
- **Effective-revision reader inventory**: covers the binding, closure, boundary, context, gate (`store.ts` and `sqlite-index.ts`), decision, credit, corrections, `routing.ts` `deriveEnforced`, run and state readers, and the native and invoke paths. `listImplementationTextAmendments` has exactly the consumers the record names.
- **Gate identity ruling**: `revision` goes into `deriveGateId` only when it is stored, so historical gate IDs stay unchanged. This matches `canonical` in `decisions.ts:85-95`, which drops `undefined`.
- **Legacy recovery codec and keys**: both key shapes are confirmed from history. `81eddb4` wrote `…:${bindingId}`, and `a15d7b9` changed it to `…:${bindingId}:${authorizationId}`. Optional `architectureApprovalId` decoding is confirmed (`record-lines.ts:359-403`). The fold uses the payload `id` as identity.
- **Causal attribution algorithm**: works per stream in journal order and never compares timestamps. Cross-stream references follow stored IDs, and missing or ambiguous references fail closed with a named diagnostic.
- **Upgrade and retirement inventory**: discovery uses `FileRecordStore.listRuns`, `listLines` and `loadGitRecordForPlan`, without SQLite or a worktree. The retirement list matches every non-test `recover-plan` reference: `review.ts`, `implementation-state.ts`, both skills, and `unfinished-frontier-recovery.md`.
- **Mutation boundary**: confirms `atomicAppendIfAllNew` checks for duplicates first, then compares the exact `expectedKeys` lists (`record-fs.ts:839-861`). Identical retry therefore returns `duplicates` and is not reported as `RECORD_PRECONDITION_FAILED`.
- **Protocol and codec fit**: `normalizeReviewerVerdict` passes unknown keys through. `sqlite-index.ts` lists decisions through `listImplementationDecisions`. The intent hash drops `undefined`. SQLite is at schema v12 (`db/schema.ts:649`), and v13 stays unused.

---

## Strengths

- Every ruling is tied to a named function and line-level behavior in the integrated tree, not to the plan text alone. Each one is falsifiable against the code.
- The gate identity ruling heads off a quiet regression. Substituting an attributed revision into historical gate hashes would orphan existing `authorize_amendment` decisions.
- The record states which `phase:complete` and git steps are not revision authority, and explains why: the CAS key set is not persisted on the receipt. That closes off a tempting but unsound ordering shortcut.
- The scope discipline is good. The record makes no structural plan edits. Surface counts are reconciled with no changes, and it states that any new lock, migration or schema needs a plan revision.
- Upgrade discovery is shown to work from authoritative JSONL and git history. There is no separate archived-run root to miss.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

### P2.1: The "between repeated recoveries" rule is ambiguous about cumulative invalidation sets

The verification record, under *Causal attribution algorithm → Budget-stream evidence*, says:

> Between repeated recoveries, an observation or context on a phase at or after the next recovery's frontier must appear in that next recovery's invalidation set. A preserved earlier phase must not appear in the set. A missing or extra id fails closed.

Every historical recovery writer computes its sets cumulatively. This is true of `81eddb4`, `a15d7b9`, and `implementation-recovery.ts:412-418` at `4af6e20`. The context set is every context for the binding on an affected phase. The observation set is every observation on an affected phase. Both are taken over the whole run history, not just the segment since the previous recovery. Affected phases are the frontier and later phases, taken from the predecessor plan's authorized bytes.

For a second recovery at the same frontier, which is the `a15d7b9` scenario, the set legitimately repeats IDs that the first recovery already invalidated. Read as "any ID not recorded in the between-segment", the phrase "extra id" would make the Phase 1 fold fail closed on valid repeated-recovery history. That would contradict Decision 9's requirement to reproduce the former recovery behavior.

**Correction:** Restate the rule as the deterministic equality the writers actually used. Each recovery R's invalidation sets must equal the IDs, in the budget prefix before R, of:

- contexts for the binding on phases at or after R's frontier, ordered from R's predecessor authorized bytes;
- observations on those same phases.

"Extra" then means an ID outside that set, such as a preserved earlier phase or an unknown or dangling ID. This also gives Phase 1 a single exact check instead of a segment-only check.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [x] None

**P2**
- [ ] P2.1: Restate the repeated-recovery invalidation rule as cumulative prefix equality in `phase-0-verification.md`.

---

## Phase readiness

- **Phase 0 completion:** ✅ All six checklist items are backed by verifiable run-record content. No unapproved structural plan edits.
- **Ready for Phase 1:** ⚠️ Yes, once P2.1 is clarified. Phase 1 should implement the fold against the corrected cumulative rule and add a repeated same-frontier recovery fixture as a regression.

## Nonblocking follow-ups

- The governance range is `4af6e20..4af6e20`, and its exclusions cover every path this commit touches. As a result, the reviewed-diff evidence for a verification-only phase is empty by construction. Later phases should check that the range endpoint advances to their implementation commits.
- The retirement inventory lists production and guidance files only. `test/unit/commands/implementation-recovery.test.ts` and `implementation-completion.test.ts` hold the recovery regression scenarios that Decision 9 says to reuse under `amend`. Phase 2 and Phase 4 should port them, not delete them.
