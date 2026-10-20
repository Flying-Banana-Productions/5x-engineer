# Review: Plan 215 Phase 4 — State, Guidance and End-to-End Acceptance (W6)

**Review type:** `a5d1e066aec137fc0bf9d4dee68c7ab172b2b878` (governance range `a5c59623..a5d1e066`, review context `4a732fdd-39f1-4825-b622-b2854147d98d`)  
**Scope:** Phase 4 (W6) for run `run_f7bdb11faf8d`. This covers revision provenance in `run state` and in registration output, legacy-recovery discovery in `5x upgrade`, updated bind/drift remediation, author/reviewer templates, and the phase-execution, plan and plan-review skills. It also covers the canonical docs (`101`, `206`, `unfinished-frontier-recovery.md`) and the new Player Desk and legacy-to-new acceptance tests.  
**Reviewer:** Staff engineer (correctness, plan compliance, fail-closed behavior, operator output, test strategy)  
**Local verification:**
- Focused asset suite plus the new acceptance file: `bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts test/unit/review-governance/implementation-amendment-acceptance.test.ts` gives 33 pass, 0 fail.
- `bun run typecheck` is clean. `bun run lint` is clean (454 files, no fixes).
- Full suite: `bun run test` gives 3949 pass, 0 fail across 257 files (finished after the first commit of this review).
- Probe 1 (P1.1): I made a temporary copy of the Player Desk acceptance test that logs output after the second amendment. `repeated.provenance.unchangedClaimIds` was `["DC0","DC1"]`. `presentImplementationGovernance(...).revision` gave `creditDifferences: []` and `unchangedClaimIds: ["DC0","DC1"]`, even though DC1 was withdrawn by the first amendment. I deleted the copy afterwards.
- Probe 2 (P1.2): I made a temporary copy of the git-history discovery test that commits a malformed `steps.jsonl` next to a valid recovery. `discoverLegacyRecoveryLineage` reported `lineageValid: true`, `resumeCompatible: true`, `diagnostic: null`. I deleted the copy afterwards.

**Implementation plan:** `5x-cli/docs/development/plans/215-implementation-plan-amendment-plan.md` (approved commit `a5b3b69`, binding `ffa8a3af-0d29-4645-86c3-e55806f1b1ff`, advisory mode)  
**Technical design:** N/A

## Summary

Phase 4 delivers most of W6. State and registration output now separate original binding provenance from the effective revision. `5x upgrade` reports historical recoveries from the working-copy record root and from committed git records, and it does not write anything. Remediation text, templates, skills and the canonical docs describe authorize → amend → assess → register → resume, structured `amendmentScope`, the retired `recover-plan`, and the minimum toolchain. The new acceptance tests cover the Player Desk scenario and a legacy-to-new chain.

Two defects remain in the new code:

1. After more than one amendment, the provenance view reports only the selected revision's claim edits. A claim withdrawn by an earlier amendment then shows as "unchanged". Every other effective reader flattens all dispositions, so state disagrees with the boundary, credit and context readers. The Phase 4 completion gate requires those readers to agree.
2. Git-history discovery silently drops a `steps.jsonl` or `decisions.jsonl` it cannot decode. A malformed committed history is then reported as valid and resume-compatible, with no diagnostic. The working-copy path, and the documented contract, fail closed.

**Readiness:** Not ready. Two P1 items remain; both are mechanical (`auto_fix`). This is the final phase, so they block production readiness.

---

## What shipped

- **Revision provenance** (`implementation-amendment.ts`): `RevisionProvenance` / `RevisionProvenanceFailure`, `presentRevisionProvenance`, `readRevisionProvenance`, and `presentRegistrationProvenance`. `completionAuthorized: false` is always set. Registration results (dry-run, recorded and replay) carry `provenance`.
- **State** (`run-v1.handler.ts`): `implementation_governance.revision` is filled for both callers (active and archived) when a record store is available. Text output prints original vs effective provenance, history, affected phases, retained evidence count, pending/resolved findings, and credit differences. A fold failure prints `lineage=invalid` with the diagnostic.
- **Upgrade discovery** (`upgrade.handler.ts`): `discoverLegacyRecoveryLineage` scans the configured record root and, for runs missing from the working copy, committed records at HEAD. For each run it reports recovery IDs, lineage validity, resume compatibility, history, and a diagnostic. `runUpgrade` adds a read-only "Legacy recoveries:" section that includes the minimum-toolchain notice.
- **Remediation** (`implementation-state.ts`): the bind-conflict and drift messages now name the supported workflow, say that bind only attaches the initial source, and give the toolchain requirement.
- **Assets**: `reviewer-plan.md`, `reviewer-plan-continued.md`, `author-process-plan-review.md`, `author-process-impl-review.md`, `protocol-help.ts`, and the `5x-phase-execution`, `5x-plan` and `5x-plan-review` skills. Recover-plan instructions are removed. Exact-hash reassessment after final corrections and "rationale is not scope" are stated.
- **Docs**: `101-cli-primitives.md`, `206-review-budget-governance.md` §8.2, and a rewritten `unfinished-frontier-recovery.md`.
- **Tests**: `implementation-amendment-acceptance.test.ts`. Its three scenarios are the Player Desk scenario plus a repeated amendment; a legacy chain with interleaved text, discovery, replay and a new-format amendment; and git-history discovery after the working-copy records are removed plus an index rebuild. Asset assertions in `upgrade.test.ts` and in the skill-branch unit test cover every delegation mode.

---

## Strengths

- **Completion is never implied.** Provenance, registration and upgrade reports all hard-code `completionAuthorized: false`, and both the text state and the upgrade report print `completion_authorized=no`.
- **Discovery is read-only.** It writes nothing. The test runs discovery twice, compares the two reports, and confirms the journal keys are unchanged.
- **Player Desk acceptance asserts the substantive invariants.** It checks that Phase 1 evidence still certifies, that the DC0 reconciliation is invalidated by the affected boundary, that DC1 is withdrawn, that R7 is amendment-resolved while R1–R6 and R8 stay pending, that B0/B/mode are unchanged, and that dry-run is pure.
- **Legacy-to-new transition goes through the real registration path.** The test registers against `recovery-2` and checks that historical revisions and pins are unchanged. It also confirms the authority replayed from a fresh store matches the original.
- **Asset checks are consequential.** They assert the workflow invariants (`amendmentScope`, exact hash, retirement, "Registration does not complete a phase") in every rendered delegation mode and in the installed/upgraded skill and prompt, rather than snapshotting prose.

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1 — Provenance reports withdrawn claims as unchanged after a later amendment

`presentRevisionProvenance` (`src/review-governance/implementation-amendment.ts:2278`) takes `creditDifferences` from `creditEditsFor(execution, selected.id)`, which reads only the selected revision's disposition. It then computes `unchangedClaimIds` (`:2319`) as every claim on the original ledger minus those edits. `presentRegistrationProvenance` (`:2381`, `:2451`) does the same using only the claim edits of the registration being made.

After amendment A withdraws DC1 and amendment B changes no claims, `run state` prints `Implementation credit differences: none unchanged=DC0,DC1 baseline_unchanged=yes`. Registration output for B returns `unchangedClaimIds: ["DC0","DC1"]` (Probe 1).

Every other effective reader flattens all dispositions to decide which claims are edited or withdrawn: `implementation-boundary.ts:377`, `credit-reconciliation.ts:270`/`:572`, `context.ts:395`, `implementation-review-context.ts:398`/`:443`/`:834`, and `review-decision.handler.ts:1288`. State therefore disagrees with the readers that govern credit. This breaks the Phase 4 completion gate ("every … current/archived reader agrees on effective revision") and Decision 5 ("Withdrawn IDs remain reserved in lineage and contribute no current … credit").

**Recommendation:** Compute claim differences against the original binding by accumulating every disposition in the lineage, plus the pending registration's edits in the preview/registration path. Derive `unchangedClaimIds` from that cumulative set. If the per-registration edits are still useful in registration output, expose them in a separately named field. Extend the Player Desk test so that after the second amendment it asserts DC1 is still reported as withdrawn and is absent from `unchangedClaimIds`, in both state and registration output.

### P1.2 — Git-history discovery fails open on undecodable steps/decisions journals

In `gitRunsMissingFrom` (`src/commands/upgrade.handler.ts:660`), a `decodeJsonlFile` failure on a journal file marks the run unreadable only when the file is `budget.jsonl` and contains `implementation-plan-recovery` (`:690`–`:705`). A decode failure on `steps.jsonl` or `decisions.jsonl` is swallowed, and the run is folded without those lines. With a malformed committed `steps.jsonl` beside a valid recovery, the report says `lineage=valid resume_compatible=yes` with no diagnostic (Probe 2). A malformed `decisions.jsonl` does fail, but with a misleading "Authorization … is missing" diagnostic instead of the decode error.

The working-copy path fails closed for the same history: the fold's `listLines` throws, and `reportRecoveredRun` turns that into `lineageValid: false`. The two discovery sources therefore disagree. This contradicts the Phase 4 item ("malformed/ambiguous histories fail closed"), Decision 9 ("actionable malformed/ambiguous-history diagnostics"), and the new `unfinished-frontier-recovery.md` ("Malformed or ambiguous history fails closed with a diagnostic").

**Recommendation:** Record a decode failure for any of the three journals. When the run's committed budget contains a recovery, report it unreadable with that file's error, as the budget branch already does. Add a case to the git-history discovery test with a malformed committed `steps.jsonl` (and/or `decisions.jsonl`) that asserts `lineageValid: false`, `resumeCompatible: false`, and a diagnostic naming the decode failure.

---

## Medium priority (P2)

None that require author work. See the nonblocking follow-ups.

---

## Nonblocking follow-ups

- **Scope of "git history" wording:** `unfinished-frontier-recovery.md` says committed journals are read "from git history". Discovery actually reads the tree at HEAD (`getLatestCommit`). A run whose records were deleted in a committed change is not found. Consider saying "the committed tree at HEAD".
- **Index rebuild assertion depth:** the git-history test runs `rebuildRecordsIndex` but then checks only discovery output and the git blob. It could also check that the rebuilt index projects the same gate identities and state as the live derivation. The fold-replay equality in the legacy test covers the authority invariant.
- **Double fold in `run state`:** `presentImplementationGovernance` now runs `foldEffectiveExecution` again on top of the readers that already fold. This is acceptable at current journal sizes. Consider threading one fold result through if state latency grows.
- **Stale-registration display edge:** in `presentRegistrationProvenance`, the branch where the amendment is recorded but no longer current reports that amendment as effective without the later history. Registration replay against a stale predecessor is already rejected upstream, so this is cosmetic.

---

## Readiness checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] P1.1 — Report cumulative claim differences and `unchangedClaimIds` across all revisions in state and registration provenance, with a repeated-amendment assertion.
- [ ] P1.2 — Fail closed on an undecodable committed `steps.jsonl`/`decisions.jsonl` in git-history discovery, with a malformed-history test.

**Plan compliance (Phase 4 checklist)**
- [~] Present original/effective provenance … credit differences in state and registration output (P1.1 for repeated amendments).
- [~] Upgrade discovery/validation/reporting across active/completed/archived records, safe to repeat (P1.2 for fail-closed behavior).
- [x] Templates and skills across delegation modes, with structured `amendmentScope` and "rationale is not scope".
- [x] Bind/drift remediation and toolchain/initial-binding docs.
- [x] Player Desk-shaped acceptance.
- [x] Read-only dry-run/state, source-worktree removal, repeated amendments, interleaved text amendments (index-rebuild depth noted above).
- [x] Legacy-to-new lifecycle with malformed history failing closed (records path; git path is P1.2).
- [x] Installed/rendered asset contract via the focused suite.
- [x] Typecheck, lint, and focused suites.

---

## Addendum (2026-10-20) — Closure of P1.1 and P1.2

**Reviewed:** `5de384a6eba18a4dc563d5bfbeb0c0a90ac57039` (range `a5d1e066..5de384a6`, review context `35dce24a-2c49-4e23-8377-b50b9f5b4a02`)

**Local verification:** `bun test test/unit/review-governance/implementation-amendment-acceptance.test.ts test/integration/commands/upgrade.test.ts` gives 23 pass, 0 fail. `bun run typecheck` and `bun run lint` are clean. I did not re-run the full suite; the range touches only `upgrade.handler.ts`, `implementation-amendment.ts` and the acceptance test.

### What's addressed (✅)

- **P1.1 — addressed.** `creditEditsFor` is replaced by `prefixClaimEdits`, which flattens claim edits across every revision up to the selected one, in lineage order. `presentRevisionProvenance` now selects by `selectedRevisionId` first, so historical prefixes work. `presentRegistrationProvenance` uses the predecessor prefix plus the registering edits for a preview and the amendment's own prefix once recorded. `unchangedClaimIds` comes from `claimsWithoutEdits` over that cumulative set. The new test confirms that after a second amendment with no claim edits, DC1 stays withdrawn and `unchangedClaimIds` is `["DC0"]` in preview, registration, replay, historical-prefix and state output. The initial prefix still reports `["DC0","DC1"]`.
- **P1.2 — addressed.** `gitRunsMissingFrom` now records the first decode failure from any of `steps.jsonl`, `budget.jsonl` and `decisions.jsonl`, naming the file and stream. A recovery counts as present if any decodable line carries it, or if a budget line naming a recovery fails to decode (`knownRecoveryIds`). In that case the run is reported `lineageValid: false`, `resumeCompatible: false`, with the decode message and recovery IDs. A run with no recovery still degrades to an empty store, as before. New tests cover malformed `steps.jsonl` and `decisions.jsonl` and assert the file name and "invalid JSON" in the diagnostic.

### Remaining concerns

None blocking. The earlier nonblocking follow-ups still stand and are unchanged.

### Updated readiness

- **Phase 4 completion:** ✅ — both P1 items are fixed with regression coverage.
- **Ready for next phase / production:** ✅ — Phase 4 is the final phase, and no open items remain.
