# Review: Phase 5 — workflow assets and lifecycle acceptance

**Review type:** `2110de51ff5e07faa1fab709479e84e6d6a36ed7`  
**Scope:** Initial exhaustive material W5 review; authoritative range `5df9b1a448f3e277bb43a3d95fde050517b4efaa..2110de51ff5e07faa1fab709479e84e6d6a36ed7`, with the supplied exclusions. Earlier approved phases are dependencies, not reopened reviews.  
**Reviewer:** Staff engineer — correctness, workflow operability, acceptance coverage  
**Implementation plan:** `5x-cli/docs/development/plans/217-operator-directed-workflow-repair-plan.md`, approved v1.1  
**Local verification:** Focused asset, issue-consumer, compact-plan, file-repair, combined-lifecycle, real-CLI lifecycle, and skeleton suites: **131 passed, 0 failed, 1,787 assertions**, 77.70 seconds. No live GitHub or external-project mutations.

## Summary

W5 delivers the intended repair-first asset updates and substantial isolated regression coverage. Runtime evidence ownership, issue-delivery exclusions, and the existing approval policy remain intact. Two newly shipped instruction defects still prevent unqualified final readiness: a review-before-checkbox dependency for newly implemented repaired obligations, and loss of scoped repair selectors in the prescribed apply command. Both corrections are derivable within W5; neither requires a policy decision or plan amendment.

**Readiness:** Not ready — R1 introduces a circular prerequisite in the ordinary author-to-review workflow; R2 breaks the documented scoped recovery command.

## What shipped

- Executable checklist guidance in bundled/configured skeletons and all eight affected prompt variants.
- Draft repair, one-pass finalization, same-run approved repair, and corrected CLI-envelope guidance across four workflow skills.
- Issue-resolution planning/binding handoff guidance without new approvals or changes to delivery recipes.
- Compact-plan preservation, codec-valid receipt delivery tests, combined journal/restart tests, and a real-Git/CLI incident lifecycle.

## Strengths

- Mechanical receipts remain evidence rather than acceptance. The shipped `accepted-intervals` and `classify-delivery` recipes are exercised unchanged, including exact correction commits, mixed plan/code receipt commits, unsettled/prepared-only code, and uncovered pre-admission code.
- Stub-`gh` publication succeeds only after delivery succeeds; negative companion cases produce no success comment or closure.
- The compact fixture is unchanged and passes as one phase with a prose gate. Prefix repair restores exact fixture bytes; Issue Coverage, pinned brief identity, mappings, assumptions, and separate source files remain unchanged.
- Runtime native/invoke context parity includes fresh/continued reviewers and a stale local override. No installer mechanism, new gate, parser, or approval boundary was added.

## Production readiness blockers

None at P0.

## High priority (P1)

### R1 — Keep ordinary implementation possible after proactive checklist repair

**Locations:** `5x-cli/src/templates/author-next-phase.md:37` and the identical new rule in `5x-cli/src/templates/author-process-impl-review.md:45`.

The new rule says that, after a recorded repair, a newly introduced box may be checked **only** for work already implemented and evidenced by recorded review and quality results. That is appropriate when discharging previously reviewed work without repeating it, but it also applies to proactive repairs before implementation and to untouched remaining phases repaired in the same receipt. Those requirements have no recorded review yet.

The normal author prompt requires checking completed items before returning complete. `protocol.handler.ts` rejects an unchecked complete author result (`PHASE_CHECKLIST_INCOMPLETE`); execution Step 2 requires author protocol/checklist success before Step 3 reviews the code. Following the new restriction therefore prevents the first review needed to satisfy the restriction. It also conflicts with the approved requirement that remaining unfinished work continue normally after repair.

**Lowest-cost correction:** Limit the recorded-review/quality condition to checking boxes solely from carried historical evidence. Explicitly preserve normal implementation, testing, and check-off of newly performed work before its first review, in both author prompts. Add effective-render assertions distinguishing the two cases and extend lifecycle acceptance past rendering the next phase to the ordinary newly implemented/check-off path. No new approval or gate is needed.

**Classification:** `implementation_defect`, W5, `auto_fix`; effort 1, architecture delta 0, no boundary changes.

## Medium priority (P2)

### R2 — Preserve phase/line selection when applying a scoped repair

**Location:** `5x-cli/src/skills/base/5x-phase-execution/SKILL.tmpl.md:821–855`, especially step 3 at lines 837–838.

Step 2 explicitly supports an operator-selected `--phase`/`--lines` scope, but step 3 reconstructs the apply command with only run, intent, and reason. Selection is not stored in the intent token: `repairChecklistsForRun` parses selectors again and recomputes the candidate before checking the digest (`plan-checklist-repair.handler.ts:405–465`). An apply without the selected scope can therefore fail as stale even though the file did not change, or compute the unselected candidate. Re-previewing without retaining the scope does not resolve this. The CLI already returns the correct selector-preserving command in the preview's `.data.next` (lines 468–475, 495–500).

**Lowest-cost correction:** Instruct the orchestrator to use that returned apply command with the recorded operator reason, or explicitly retain the exact selected phase/line flags in every apply and retry. Add a scoped preview/apply regression for the documented recipe. Preserve authorization when the selected edits remain unchanged; do not ask for another approval.

**Classification:** `implementation_defect`, W5, `auto_fix`; effort 1, architecture delta 0, no boundary changes.

## Asset-impact assessment

| Surface | Assessment |
|---|---|
| Bundled and configured skeletons | Both now explain parser-recognized executable items while retaining prose gates; configured Phase 2 gains an actual item. Pure executability tests cover both. |
| Generation/revision prompts | Draft repair, compact mode, pinned brief/Issue Coverage and finding-only Addresses are retained. Final-corrections guidance follows the existing reconciliation route. |
| Initial/continued plan reviewers | Same deterministic preflight rule; pinned-brief coverage check remains unchanged. |
| Initial/continued implementation reviewers | Hunk rule correctly limited to implementation defects; anchored runtime plan evidence remains separate. |
| Implementation authors | Correct approved-repair routing and evidence carry, subject to R1's overbroad check-off restriction. |
| Runtime context | Existing shared native/invoke builder carries authoritative evidence even through stale overrides. This phase adds parity acceptance rather than another context authority. |
| Planning/review/execution skills | All delegation-mode renders inspected by acceptance; completion query uses `.data.phases[].id` and diagnoses a missing selection. Scoped recovery needs R2. |
| Issue-resolution skill | Steps 2/3 name completed source repair/finalization, explicit source bind, and execution-owned repair. Step 5 recipes remain unchanged; receipts do not change BASE or accepted endpoints. Intake, association, and closure policy are unaffected. |
| Installation/upgrade/sync/overrides | Existing integration suite exercises installed content, mixed delegation, upgrade freshness, override preservation, and lossless sync. No new mandatory sync gate. |
| Unaffected prompts/skills | Intake and quality-fix prompts, foundation/config/migration/Windows skills do not own phase checklist repair; leaving them unchanged is appropriate. |

## Verification and coverage limits

Command run from `5x-cli/`:

```bash
bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts test/integration/issue-resolution-recipes.test.ts test/unit/parsers/issue-plan-fixture.test.ts test/unit/commands/plan-checklist-repair-issue-plan.test.ts test/unit/review-governance/workflow-repair-lifecycle.test.ts test/integration/commands/workflow-repair-e2e.test.ts test/unit/templates/default-artifacts.test.ts
```

- The combined stale-Addresses/drift/empty-negative/historical-gateless/restart test uses an in-memory record store and injected commit map, plus a temporary file and rebuilt SQLite projection. It is valuable composition coverage, not a real-Git end-to-end test.
- The separate incident lifecycle does use real CLI processes and Git. Its malformed historical approval is deliberately seeded by temporarily executable working bytes. A real shell quality counter and durable reviewer steps verify no additional review/quality loop during repair. It completes Phase 1 and renders Phase 2; it does not actually execute an agent or implement/check off Phase 2. That distinction is why passing tests do not cover R1.
- Receipt recipe fixtures round-trip through the production codecs but are synthetic records, not independently generated valid lineage proofs. Their no-extra-invocation helper counts supplied observations; it is not an independent agent/quality invocation counter. Actual CLI lifecycle coverage supplies the stronger count evidence separately.
- The finalization delivery test derives BASE with real `jq` from a supplied binding; it does not itself perform binding. Existing Phase 3 integration coverage performs explicit `--source-run` binding after actual finalization. Earlier source-repair integration coverage proves carry into a binding. These are complementary proofs, not one combined issue-agent execution.
- Full lint/typecheck/full-suite success is supplied by the independent orchestrator/author, not re-executed here. The user's parallel-2 performance fix is unchanged.

## Nonblocking follow-ups

No unrelated prior-phase defects are reopened. The coverage limitations above should not be represented as live-agent or live-GitHub acceptance claims.

## Readiness checklist

- [x] Full authoritative W5 diff examined; full approved plan and changed review instructions read.
- [x] Required focused asset and issue-consumer suites pass independently.
- [x] No new approval policy or delivery-range widening introduced.
- [ ] R1: distinguish historical-evidence check-off from normal newly performed implementation.
- [ ] R2: retain scoped selectors through apply and retry.

After these mechanical W5 corrections and focused verification, no further plan or architectural decision is identified by this review.

## Addendum (November 6, 2026) — R1/R2 closure

**Reviewed:** `43fae815af285ef94f22e366ee02c9fa77f44f81`  
**Authoritative closure range:** `2110de51ff5e07faa1fab709479e84e6d6a36ed7..43fae815af285ef94f22e366ee02c9fa77f44f81`, with the supplied plan/review/run-record exclusions.  
**Governance context:** `55451bf1-7a2f-4cff-8832-0569f1dbfcb9`, enforced; required prior outcomes R1 and R2 only.

### What's addressed

- **R1 — addressed.** Both `src/templates/author-next-phase.md:37` and `src/templates/author-process-impl-review.md:45` now explicitly allow ordinary implementation, testing, and check-off of newly performed work before returning complete and before its first review. Recorded review/quality evidence is required only when checking off solely from carried historical evidence. The execution recovery recipe also expressly continues unimplemented remaining phases normally. Effective-render assertions cover both cases. The real CLI/Git lifecycle now goes beyond rendering Phase 2: it writes new implementation, checks repaired boxes, commits, and successfully records the Phase 2 complete author result while the only recorded reviewer step is still Phase 1's. Phase 2's quality run and first review then occur, followed by phase completion. The existing binding and single repair receipt remain unchanged.
- **R2 — addressed.** Execution recovery now uses the preview's `.data.next[0]`, replacing only the operator-reason placeholder, and explicitly retains the exact phase/line selectors through apply, re-preview, and retry. A new real-CLI `--phase 1` regression first drops the selector and verifies stale refusal with unchanged plan bytes, HEAD, and receipt count. Applying the returned command then records the original instruction and intent, repairs Phase 1 only, and leaves later phase bullets untouched. Repeating that identical selector-preserving command returns the existing receipt without a new commit or receipt. Rendered-skill assertions cover selector retention in every delegation-mode case.

### Local verification

From `5x-cli/`:

```bash
bun test test/integration/commands/workflow-repair-e2e.test.ts test/unit/skills/implementation-review-governance.test.ts
```

**Result:** 34 passed, 0 failed, 828 assertions, 10.99 seconds. These are actual CLI/Git fixture and effective-render checks, not live agent or GitHub execution. The new scoped regression exercises phase selection; line-selection retention is explicit in the recipe, rather than a separate new CLI case.

The full mandatory closure diff contains only the two author-prompt corrections, execution-skill correction, and their targeted regression additions. The governing plan, quality scripts, parallelism configuration, issue-delivery recipes, and approval/gate policy are unchanged. Independent current-commit lint/full-test/checklist success and the author's typecheck results were supplied by the orchestrator; those broader checks were not redundantly re-run in this closure review. Earlier coverage qualifications remain applicable except that the real lifecycle now also implements/checks off Phase 2 as described above.

### Remaining concerns

No remaining R1/R2 work and no new revision-caused material blocker identified. No unrelated missed or pre-existing issue is reopened.

### Updated readiness

- [x] R1 addressed: normal new-work check-off precedes first review; historical evidence-only check-off retains its evidence requirement.
- [x] R2 addressed: scoped apply and retry retain the authorized selectors and operator reason.
- **Phase 5 / W5 completion:** Ready.
- **Overall approved plan readiness:** Ready on the previously approved W1–W4 dependencies and this W5 closure assessment; no new gate, amendment, or repeat authorization is required by this review.
