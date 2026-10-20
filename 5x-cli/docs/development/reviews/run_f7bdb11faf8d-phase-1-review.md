# Review: Plan 215 Phase 1 — Revision Records and Reviewed Impact Contract

**Review type:** `c61692be058253e03aad982c725c3def7c97cd1d` (governance range `c6620b9..c61692b`, review context `9abbef63-d8a6-4982-bd87-c950ad530408`)  
**Scope:** Phase 1 (W1, W3) for run `run_f7bdb11faf8d`. This covers the semantic amendment record and codecs, the optional revision fields, the `amendmentAssessment` and `amendmentScope` protocol contracts, and the effective revision fold. It also covers the quality-remediation commit (`NdjsonTailer` drain on abort, `--timeout 15000`).  
**Reviewer:** Staff engineer (correctness, plan compliance, lineage safety, test strategy)  
**Local verification:**
- Focused suites pass: `bun test --timeout 15000 test/unit/review-governance/ test/unit/protocol.test.ts test/unit/protocol-normalize.test.ts test/unit/control-plane/review-budget-index.test.ts test/unit/utils/ndjson-tailer.test.ts` gives 254 pass, 0 fail.
- `bun run typecheck` and `bun run lint` are clean.
- I ran `foldEffectiveExecution` read-only against the two committed bound runs in this repo, `run_bf10663c0a8a` (plan 210) and `run_f7bdb11faf8d`. Both fold `ok`, so their historical decisions still validate.
- I ran temporary probe tests, since deleted, against the fold. Their results are cited below.

**Implementation plan:** `5x-cli/docs/development/plans/215-implementation-plan-amendment-plan.md` (approved commit `a5b3b69`, binding `ffa8a3af-0d29-4645-86c3-e55806f1b1ff`, advisory mode)  
**Technical design:** N/A

## Summary

Phase 1 adds a strict `implementation-plan-amendment` codec and optional `revisionId` on contexts, observations, correction attempts and text guards. Encoders leave `revisionId` out when it is absent. The phase also adds the plan-only `amendmentAssessment` contract and an `amendmentScope` codec whose hash leaves historical decisions unchanged. The new module `implementation-amendment.ts` folds the binding, legacy recoveries and semantic amendments into one effective revision with evidence dispositions. The lineage checks are good and follow the Phase 0 rules closely. That includes the cumulative-prefix invalidation equality and a regression for repeated recovery at the same frontier.

Two defects in the fold's semantics need fixing before Phase 3 builds on it:

1. The effective finding register reports every finding ever raised as `pending`, including findings that later reviews addressed.
2. Any edit to a Design Decisions, Scope, Acceptance or Not In Scope section makes it impossible to preserve an earlier phase. The plan leaves that judgment to the reviewer's assessment.

**Readiness:** Not ready. There are two P1 corrections to the fold, and both are mechanical. The remaining P2 items are hardening and test gaps.

---

## What shipped

- **Semantic amendment record** (`record-lines.ts`): `ImplementationSemanticAmendmentPayload` with a strict decoder. It rejects unknown keys and checks the version, the SHA-256 format on hashes and `intentDigest`, the claim effect enum, and portable `{idempotencyKey}` step references. A keyed `implementationSemanticAmendmentKey` is added.
- **Optional revision qualification**: `revisionId?` on context, observation, correction-attempt and text-amendment payloads. The `withoutEmptyRevision` encoders mean historical lines round-trip byte-identically.
- **Protocol** (`protocol.ts`, `protocol-help.ts`, `protocol-normalize.ts`): the `AmendmentAssessment`, `AmendmentScope`, `parseAmendmentAssessment` and `parseAmendmentScope` types. All keys are required, duplicates are rejected, and lists are never defaulted. The schema property is stripped from the implementation-domain schema, and `assertReviewerVerdict` rejects the assessment on implementation verdicts. `verdictUsesPlanContract` recognizes it.
- **Decisions** (`decisions.ts`): `amendmentScope` is accepted only on `authorize_amendment`. It enters the intent hash only when present.
- **Fold** (`implementation-amendment.ts`):
  - It verifies the binding, decisions, the lineage parent and hash chain, consumption of each authorization exactly once, cumulative invalidation-set equality, and phase-identity stability. It also checks preserved-phase section and claim equality, and resolved-finding fingerprints.
  - It attributes cross-stream evidence: reviewer steps by step key, decisions by observation, `human:review-governance` by decision, and pre-author records to the initial revision.
  - Earlier revisions can be selected.
  - `formatAmendmentReviewPromptContext` and `verifyAmendmentAssessment` are provided.
- **Store and index**: `listImplementationSemanticAmendments` and `readEffectiveImplementationRevision` are added. The rebuild decodes and skips the new kind and never treats it as a plan snapshot.
- **Quality remediation** (`c61692b`): `NdjsonTailer.cleanup` drains on-disk lines before it aborts, and the iterator yields them. The bootstrap watch helper now stops on observation, not on a fixed timer. `package.json` passes `--timeout 15000`, because Bun ignores the bunfig key. The `bunfig.toml` comment and `AGENTS.md` are corrected.

---

## Strengths

- **Fail-closed lineage.** The fold refuses every case the Phase 0 record named:
  - a forked parent chain, a wrong before/after hash, or a duplicate revision or evidence id;
  - two observations claiming one step key;
  - a decision that cites zero observations or more than one;
  - a second pre-author record;
  - a reused authorization, or a former-contract decision presented for a semantic amendment;
  - a version other than 1.

  Each refusal names the run, stream, record and recovery ids.
- **Cumulative invalidation equality** implements the corrected Phase 0 P2.1 rule exactly. The repeated same-frontier fixture (`recovery-1` then `recovery-2`, both at phase 2) covers it, as the Phase 0 review requested.
- **No relabeling.** Revision-less evidence keeps the revision of its journal segment. Earlier-revision selection reproduces former applicability (`obs-2b` is applicable at `recovery-1` and invalidated at `recovery-2`).
- **Historical compatibility is real, not only asserted.** Both committed bound runs fold `ok` with one revision. The real committed `authorize_amendment`-era decisions still validate their intent hashes.
- **The tailer fix is correct and narrow.** It drains before setting `aborted`, wakes a waiting iterator with the drained line, and adds a deterministic abort-before-poll unit test.

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1 — The effective finding register marks addressed findings as `pending`

`foldEffectiveExecution` builds `findings` from every item of every observation. Each one is `pending` unless an amendment resolved it (`implementation-amendment.ts`, the final `findings` loop). It ignores `priorFindings` outcomes in later rounds, and it lists a finding id once per round that raised it.

Evidence:
- `run_bf10663c0a8a`, a completed plan 210 run, folds to 21 `pending` findings across phases 8–11. These include findings later reviews closed, and `9/P2.2` appears twice.
- This run's Phase 0 `P2.1` was addressed in the Phase 0 addendum, yet it reports `pending`.
- A probe with round 1 raising `R1` and round 2 reporting `{id: "R1", status: "addressed"}` returns `R1: pending`.

Decision 6 says closure validation and prompts consume "one canonical effective finding register". Phase 3 says "carry unresolved findings". Built on this register, Phase 3 would re-carry fixed findings, and the Phase 4 "seven retained fixes" acceptance would count wrongly.

**Requirement:** For each phase, derive the open set from the latest observation using the same rule as `openCodeFindings` in `implementation.ts`:
- the latest round's items;
- plus `priorFindings` entries marked `still_open` or `partially_addressed`;
- minus entries marked `addressed`.

Keep the original phase, observation and fingerprint identity, apply amendment resolutions on top, and report each identity once. Invalidation must not drop findings. Add a multi-round test.

### P1.2 — Any change to a shared protected section prevents preserving earlier phases

When `preservedPhases` is non-empty, the fold rejects the amendment if `protectedText()` differs. That text is the Design Decisions, Acceptance, Scope and Not In Scope sections. Because preserved phases must also equal *exactly* the phases before the boundary, any amendment that edits one of those sections must set its boundary at the first phase and reopen everything.

A probe that changed only a Design Decisions sentence and a Phase 2 item returned: "A shared design, acceptance, or scope section changed, so earlier phases cannot be preserved."

Decision 3 assigns this judgment to the reviewer. The mechanical checks are the phase section, ignoring checkboxes, plus linked work-item and claim contracts. The plan then says to "also require reviewer assessment of changes outside that section, such as shared design/acceptance obligations." A semantic amendment almost always changes Design Decisions or Scope. As written, the fold would also block the Phase 4 Player Desk acceptance: unchanged Phase 1, affected Phase 2+, a scope change. The fold reads durable records, so it is a hazard: an amendment that registration accepted would make the whole run fail closed on its next read.

**Requirement:** Remove the `protectedText` rejection from the fold. Preserved phases rest on the mechanical phase, work-item and claim checks plus the reviewer's `preservedPhases` reasons. Phase 2 registration enforces those reasons. Add a positive test: a Design Decisions edit with Phase 1 preserved.

---

## Medium priority (P2)

- **P2.1 — Linked work-item contracts are not compared for preserved phases.** `claimContract` compares only ledger rows whose debt claim targets the phase. Decision 3 also requires "linked work-item contracts" to be unchanged. A probe preserved `## Phase 1: Foundation (W1)` while W1's row changed from effort 2 / delta 0 to 8 / 3 with a new rationale, and the fold returned `ok`. Compare the ledger rows for every work-item id the preserved phase heading or section names, alongside the debt-claim rows.
- **P2.2 — The fold does not check a semantic amendment against the authorization it consumes.** It requires only that `amendmentScope` be present. A probe used a decision scoped to `predecessorRevisionId: "some-other-revision"` and `earliestAffectedPhase: "3"`. It consumed that decision for an amendment from predecessor `binding-1` at boundary 2, and the fold returned `ok`. Registration is the primary gate in Phase 2, but the Phase 1 gate is to reject corrupt authority in durable records. Check these when the fold consumes the authorization:
  - `scope.predecessorRevisionId === lineage.predecessorRevisionId`;
  - the boundary is not earlier than `scope.earliestAffectedPhase` in plan order;
  - `claimEdits` ⊆ `scope.claimEdits`;
  - `resolvedFindings` ⊆ `scope.resolutionRefs`, by phase, observation, id and fingerprint.
- **P2.3 — Dependent evidence on an invalidated observation is still labeled `applicable`.** Correction attempts and credit reconciliations that cite an invalidated observation keep `applicability: "applicable"`, though `certifies` is false. Decisions that cite the same observation become `"invalidated"`. Label corrections and credits `invalidated` when their cited observation is invalidated, so that Phase 3 consumers cannot read the label as carry.
- **P2.4 — The semantic amendment decoder accepts duplicate list entries.** `decodeImplementationSemanticAmendmentPayload` does not reject repeated `preservedPhases`, `resolvedFindings` or `claimEdits` entries. `parseAmendmentAssessment` does reject them, and the fold compares preserved phases as a `Set`, which hides duplicates. Apply the same duplicate checks in the strict codec.
- **P2.5 — The help text tells reviewers to copy a plan diff into the assessment.** `protocol-help.ts` says "Copy the predecessor revision, reviewed plan hash, and plan diff from the trusted amendment review context". `amendmentAssessment` has no diff field. Say to copy the predecessor and hash, and to review the diff.
- **P2.6 — Test gaps.**
  - There are no negative tests for "preserved phase changed beyond checkbox state" or "changed linked claim contract".
  - The historical-hash test recomputes the expected hash with the same `computeImplementationDecisionIntentHash` call. Pin it to a committed historical decision line or a fixed constant from before this change.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1: Derive the effective finding register from the latest-round open set, with no duplicates, and apply amendment resolutions on top.
- [ ] P1.2: Remove the protected-section rejection. Preservation rests on the mechanical phase, work-item and claim checks plus the reviewed `preservedPhases`.

**P2**
- [ ] P2.1 Compare linked work-item rows for preserved phases.
- [ ] P2.2 Cross-check the consumed `amendmentScope` in the fold.
- [ ] P2.3 Label dependent corrections and credits `invalidated` when their cited observation is invalidated.
- [ ] P2.4 Reject duplicate list entries in the amendment codec.
- [ ] P2.5 Correct the help wording about copying the plan diff.
- [ ] P2.6 Add the missing negative tests and a pinned historical hash.

---

## Phase readiness

- **Phase 1 completion:** ⚠️ The codecs, protocol contract, lineage verification and legacy recovery fold meet the gate. The finding register (P1.1) and the preservation rule (P1.2) do not yet match Decisions 3 and 6.
- **Ready for Phase 2:** ⚠️ Yes, after P1.1 and P1.2. Registration should share the fold's preservation and scope checks so that the two cannot disagree.

## Nonblocking follow-ups

- `formatAmendmentReviewPromptContext` and `verifyAmendmentAssessment` have no production caller yet. Wiring them into `template-vars.ts` and `protocol.handler.ts` belongs to the review and registration flow in Phases 2–4. Use one composition path for native and invoke.
- The fold does not yet verify `intentDigest`, `humanStep` or `approvalStep` against the steps journal, or the paired `implementation:amendment` step. Phase 2 defines the digest and pairing, and should add these checks to the fold once they exist.
- `listImplementationTextAmendments` still excludes semantic amendments. A text amendment after a semantic amendment would compute the wrong `parentLineageId` until Phase 3 routes text-lineage replay through the fold, as planned.
- The quality commit touches `src/utils/ndjson-tailer.ts` and the test script, which are outside the plan's inventory. It is quality-gate remediation with its own tests and a diagnosis in `phase-1-quality.md`, not plan scope. It changes `run watch` shutdown behavior only by delivering lines that were already on disk.
