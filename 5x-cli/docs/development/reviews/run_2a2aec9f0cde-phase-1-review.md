# Review: Phase 1 — Operator-authorized mechanical checklist repair (W1)

**Review type:** Initial exhaustive material implementation review, `7c913130e569e3b5f7ec64b3e385c02858cc8673..7039ed14ac69db385acfc34a41c16a1dd9dea7e3`  
**Scope:** Approved plan v1.1, Phase 1 / W1; pinned binding `ff84f50f-2b92-4847-ae70-8768167de44d`, review context `11bfea29-ae2a-4eef-aefd-098b2a4586a6`.  
**Reviewer:** Staff engineer — correctness, authority, recovery, evidence continuity, architecture, security, performance, tests and operability.  
**Local verification:** Independently ran the six focused suites listed below: **101 passed, 0 failed, 1,136 assertions**. Also ran isolated in-memory handler reproductions for both findings. No real completed run was changed.

**Implementation plan:** `5x-cli/docs/development/plans/217-operator-directed-workflow-repair-plan.md` (governing contract only; approved commit `36ec99ddc06d9adcf4797819d8f8fcea283dec9f`)  
**Technical design:** Design Decisions 1–2 and Phase 1 of that plan.

## Summary

This delivers the proactive command, pure prefix proof, paired durable receipt, source-to-binding carry and evidence-preserving execution lineage. The ordinary malformed-plan recovery works without an artificial finding or gate, but two material edge cases violate the same narrowly scoped, evidence-preserving authority contract: an existing text correction becomes unusable after repair, and a hook can silently expand the authorized repair beyond the previewed selection.

**Readiness: Not ready** — R1 and R2 are P1 implementation defects within W1, with derivable corrections; neither requires a new product decision, plan amendment, scope expansion or review/quality gate.

## What shipped

- Pure candidate/proof module with schema-aware governing content, prefix edit maps, checked-introduction resets, preserved existing task state, ordered markers and line-ending preservation.
- `plan repair-checklists` draft and run forms, canonical mapped paths, approved-file-form refusal, preview intent identity and operator-reason recording.
- Versioned `plan-checklist-repair` records, paired append, execution folding, completed-source replay and atomic binding carry while preserving original approval identity.
- Plan-only commit reuse, post-hook blob verification, interrupted append recovery, idempotent retries, recovery commands on drift/checklist errors and index-rebuild coverage.

## Strengths

- Recovery is callable directly; no fictional reviewer finding, existing gate or replacement run is necessary.
- Newly introduced checked markers are visibly reset while recognized existing progress is retained.
- Source approval and binding identity remain immutable; repairs move an explicit authorized anchor instead of masquerading as semantic amendments or review approvals.
- Folding preserves review/claim/correction evidence and unrelated findings, rather than treating formatting as a reason to repeat implementation work.
- Tests exercise actual CLI repair, admission, retry and index rebuild in disposable repositories, alongside pure proof and fold cases.

## Production readiness blockers

No P0 findings.

## High priority (P1)

### R1 — Preserve an unconsumed text guard across mechanical repair

**Action:** `auto_fix`  
**Scope:** `implementation_defect`; `planWorkItemIds: [W1]`; effort delta 1; architecture delta 0; confidence high; `boundaryChanges: []`.

**Risk / concrete failure:** A review can already have authorized a unique text-only correction before the operator repairs a missing checklist elsewhere. The repair fold updates `authorizedBytes`, its hash and lineage parent without invalidating that observation. Nevertheless, `verifyAuthorTextAmendment` compares the old guard's parent/hash directly with the repaired fold and returns blocking `PLAN_AMENDMENT_STALE`: “The text guard does not match the current authorized lineage. A new review is required.” Even submitting unchanged repaired bytes reaches that stale check. Thus the unchanged finding and evidence are nominally retained but the already-authorized next action cannot be consumed without redundant review.

**Code:** `src/review-governance/implementation-amendment.ts:1119–1168` introduces the anchor move; `src/review-governance/implementation-state.ts:2538–2547` rejects the prior guard. The new exclusion at `implementation-state.ts:2531–2533` only avoids treating a repair as a consumed guard; it does not preserve applicability.

**Requirement:** Phase 1 explicitly says “Bind and later semantic/text amendments accept the repaired anchor” and requires unchanged evidence and unrelated findings to remain usable. Design Decision 2 says repair must not invalidate unchanged observations or force a redundant review.

**Lowest-cost correction / mechanical explanation:** Recognize the verified intervening checklist-repair chain when consuming an otherwise applicable guard. Re-prove and rebase its uniquely authorized literal spans onto the effective repaired anchor, retaining immutable original review evidence and the original allowed correction scope. Do not weaken stale checks for semantic lineage or create a fresh reviewer snapshot. Add schema 0/1 regressions for review → repair elsewhere in the plan → consumption of the original guarded correction, plus a substantive intervening-change rejection. This stays inside the approved Git/RecordStore lineage and existing amendment boundaries.

**Verification:** In-memory execution binding and repair followed by an old-parent/hash text guard produces `{status:"failed", code:"PLAN_AMENDMENT_STALE", blocking:true}`. Static tracing confirms a real prepared guard follows the same unconditional parent/hash rejection before its spans are verified.

### R2 — Refuse post-hook repair expansion outside the previewed edit scope

**Action:** `auto_fix`  
**Scope:** `implementation_defect`; `planWorkItemIds: [W1]`; effort delta 1; architecture delta 0; confidence high; `boundaryChanges: []`.

**Risk / concrete failure:** `repairChecklistsForRun` checks the preview digest, but its post-commit path replaces the selected candidate with any globally prefix-valid committed blob. `proveChecklistRepair` has no selection argument. If the operator previews and authorizes only Phase 1, a commit hook adding an unchecked marker to Phase 2 passes the proof and is recorded under a different digest without a refreshed preview or scope authorization. The durable receipt therefore silently grants authority beyond the presented repair. The same path can also change existing checkbox states beyond the presented candidate.

**Code:** `src/commands/plan-checklist-repair.handler.ts:506–541` (committed-blob fallback) and `:542–559` (new digest and receipt). The exact complete new-file diff hunk is supplied in the structured verdict.

**Requirement:** Design Decision 1 requires one authorization **for the presented repair**, and re-preview when the proposed edits change; Decision 2 limits the proof to the **selected list-prefix changes**. Phase 1 requires hook-changed-byte and concurrent-edit protection without partial authority or overwritten user work. Prefix equivalence alone is not selection equivalence.

**Lowest-cost correction / mechanical explanation:** After re-proving the committed blob, compare its effective edit map and preserved checkbox states with the authorized preview. Refuse any newly added or changed edit outside that proposal, expose the refreshed candidate, and append no receipt/step. Preserve the committed/user bytes for recovery. Narrowing may remain supported if the returned preview and remaining-work report reflect the actual committed result. Add a hook regression with `--phase 1` and/or `--lines` where the hook introduces a valid marker outside that scope; unchanged retry must remain idempotent. This changes neither API nor persistence boundaries beyond the already-approved repair contract.

**Verification:** Isolated in-memory run handler, two phases, preview and apply both selecting only Phase 1, hook converting Phase 2's plain task: output was `{"previewPhases":["1"],"recordedPhases":["1","2"],"intentChanged":true}`. Apply succeeded and recorded both edits rather than returning a refreshed preview.

## Medium priority (P2) / nonblocking observations

- **Nested children:** Preserving plain nested child bullets by default is reasonable where the top-level item carries the obligation and parser count is explicit. Already manually introduced nested markers are proven and retained. This is not a demand to convert every child into independently counted work or redesign the parser in W1.
- **Source migration after repair:** The new `PLAN_MIGRATION_CONFLICT` refusal is real (`implementation-state.ts:1537–1547`), not inferred from the author's report. It supplies a viable migration path after binding on the execution run. The governing W1 contract does not require every ordering of source repair and source migration, so this is not independently raised as a blocker. Preserve that recovery path; do not present the source refusal as evidence of completed migration.
- **Informational status:** The file's outside-contract “Draft — pending review” metadata conflicts with the pinned approved authority. It is not approval, migration/amendment authority or a phase-completion signal; the binding and approved governing contract controlled this review. No product or plan edit was made.

## Phase compliance and asset-impact assessment

| Phase 1 checklist | Assessment |
|---|---|
| Pure candidate/proof, ordered/nested/mixed lists, ambiguity, Unicode/EOL | Covered by focused pure tests; selected-scope proof gap is R2. |
| Draft/completed-source/active-bound forms and canonical authority | CLI tests cover all three and the approved-file-form refusal. |
| Decoding, paired receipt, retry, lineage, later amendments | Fold and semantic-amendment tests pass; prior unconsumed text-guard continuation is R1. |
| Recovery through missing checklist/drift; checked resets/progress | Independently passing CLI and handler tests cover these paths. |
| Plan-only commit, hooks, interruption, concurrency, index rebuild | Existing focused tests pass; hook expansion is not covered and fails the independent reproduction (R2). |
| Review/quality/debt evidence, completed phases and findings remain usable | Fold equality and CLI continuation tests pass; usable text-correction evidence still fails (R1). Full integrated invocation-count acceptance belongs to W5. |

Asset surfaces assessed under `AGENTS.md`:

- **Document skeletons:** Unchanged in W1; executable guidance/compact-plan acceptance belongs to W2/W5.
- **Agent prompt initial/continued variants:** Unchanged in W1; shared plan/code-evidence and repair guidance is explicitly W4/W5 work, not a missing W1 deliverable.
- **Runtime-appended context / native-invoke parity:** No new prompt-owned dynamic authority. This phase adds command diagnostics and repair-aware lineage; broader context changes/parity are W4/W5.
- **Workflow skills / delegation modes:** Unchanged in W1, with planned guidance work in W5. No new artificial workflow gate is needed to resolve this review.
- **Installation, overrides, upgrade and harness sync:** No mechanics changed. Independently ran the required focused effective asset acceptance suites (upgrade and implementation-review-governance), both included in the 101 passing tests. This is not a claim that W5's new rendered repair guidance has shipped.

No new subsystem, database, lock, external dependency or material performance concern was identified. Security review focused on preserving operator scope and avoiding unauthorized anchor changes; R2 is the concrete authority gap. Later-phase executability, finalization, gate-invariant and issue-delivery regressions were not treated as missing W1 work.

## Verification commands and evidence limits

From `5x-cli/`:

```sh
bun test test/unit/plan-schema/checklist-repair.test.ts test/unit/commands/plan-checklist-repair.test.ts test/unit/review-governance/implementation-amendment.test.ts test/integration/commands/plan-repair-checklists.test.ts test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts
```

Result: 101 pass, 0 fail, 1,136 assertions, six files. Additional `bun -e` reproductions used only in-memory records and simulated commit dependencies, with no fixture or product files written. Retrieved and inspected the complete mandated authoritative diff, including its truncated-output continuation, never substituting HEAD. The author's reported 4,266 tests/typecheck/asset results and orchestrator's phase-finish lint/full-test/checklist pass are attributed reports, not my own execution.

## Readiness checklist

**P0 blockers:** None.

**P1 required before accepting W1:**
- [ ] R1: Consume a still-applicable pre-repair text guard without a new review; retain substantive-drift protection.
- [ ] R2: Do not record post-hook edits outside the authorized preview; return truthful refreshed scope/remaining work.

Both corrections are derivable inside approved W1. The operator-directed same-run repair remains the acceptance criterion; no new finding prerequisite, human gate, redundant quality cycle or replacement run is requested.
