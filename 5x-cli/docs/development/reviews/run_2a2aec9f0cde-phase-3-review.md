# Review: Phase 3 — committed approval finalization (W3)

**Review type:** `5da6e5ce1dcbecc02b3f7ecd28a8543cd6e66520`  
**Scope:** Initial exhaustive material review of `7280f994dba8232d29bc3dcd416d5c7b48e904b8..5da6e5ce1dcbecc02b3f7ecd28a8543cd6e66520`, using the supplied exact full-diff command and exclusions. Bound run `run_2a2aec9f0cde`, Phase 3, W3; review context `24c3d8c7-4f48-4c4b-9e01-1bff698ea89a`.  
**Reviewer:** Staff engineering review — correctness, security, architecture, performance, operability, tests and approved phase contract.  
**Implementation plan:** `5x-cli/docs/development/plans/217-operator-directed-workflow-repair-plan.md`, approved v1.1.  
**Local verification:** Focused command below: **112 passed, 0 failed, 1,232 assertions**. Additional isolated in-memory probes reproduced both findings. No external project, sealed run or live run journal was used as a test fixture.

## Summary

The incident's zero-effort stale-Addresses lifecycle now works: finalization preserves the reviewer snapshot, pairs a committed ledger anchor with completion, and carries explicit provenance into binding. Legacy derivation and execution-amendment exact-hash protection are also covered. Two W3 contract gaps remain: the implementation rejects an effort increase already authorized by the existing final-correction route, and it can finalize non-executable committed bytes without running the shared executability check on that anchor.

**Readiness: Not ready** — two P1 implementation defects; both fixes are derivable from the approved contract and existing runtime policy, not human policy decisions.

## What shipped

- A pure ledger reconciliation helper and field-specific same-run recovery diagnostics.
- Versioned `plan-approval-finalization` records, codec/store support, and atomic completion-step pairing.
- Recorded and legacy-stale-Addresses binding provenance without rewriting the original reviewer snapshot or sealed source journal.
- Lifecycle, codec, retry/restart, committed-blob and execution-amendment isolation tests.

## Strengths

- Raw committed blob hashes, rather than working-tree contents, own the new approval anchor.
- Ordinary admitted Addresses bookkeeping binds without a second review in the integration lifecycle.
- Unsupported ledger changes leave the source run active and provide same-run review instructions.
- Original reviewer snapshots remain immutable; historical reconciliation records provenance on the new binding.
- Execution semantic amendments retain exact reviewed-hash requirements rather than inheriting the source-finalization shortcut.

## Production readiness blockers

No separate P0 finding.

## High priority (P1)

### R1 — Preserve the existing final-correction effort allowance

**Locations:** `src/review-governance/plan-approval-finalization.ts:92–99`; `src/review-governance/implementation-state.ts:1534–1553, 2640–2650` (paths relative to `5x-cli/`).

`validateFinalCorrections` in `routing.ts:180–213` explicitly admits up to one point of correction effort, adds that effort exactly once to the committed-plan forecast, and checks the effective ceiling. The new terminal detail retains only admitted IDs, and reconciliation rejects every work-item effort change, including one funded by that recorded route. The author's stated lack of item attribution does not justify imposing a new zero-effort policy: final Addresses additions and the recorded finding evidence are available to constrain reconciliation.

**Reproduction:** An isolated memory-store source has a recorded final-corrections route for auto-fix `R1`, `effortDelta: 1`, `architectureDelta: 0`. Existing eligibility with projected effort 2 and ceiling 4 returns `{ valid: true }`. Its final W1 row changes effort 2 to 3 and adds `R1` to Addresses. `prepareSourceApprovalFinalization` instead returns `PLAN_APPROVAL_FINALIZATION_DELTA`: “W1 effort changed; final corrections do not re-score work.” The existing suite exercises only zero-effort successful corrections and therefore passes.

**Failure:** A correction already admitted for the normal one-pass route is forced through a second review. This directly contradicts Design Decision 4's requirement to reuse the existing correction/budget policy, not invent a stricter general review requirement.

**Required correction:** Carry the recorded admitted correction effort and applicable effective budget into reconciliation. Permit only the supported, attributable effort delta within that allowance, counted once; retain rejection of unrelated rescoring, claim/scope/architecture changes and over-ceiling changes. Add a positive one-point correction lifecycle and negative unauthorized/over-allowance companions. Do not change execution-amendment exact-hash rules.

**Classification:** `implementation_defect`, W3, `auto_fix`, effort delta 2, architecture delta 0, boundary changes `[]`. No amendment to approved behavior is needed.

### R2 — Validate executability of the exact committed finalization blob

**Locations:** `src/commands/run-v1.handler.ts:4482–4493`; `src/review-governance/implementation-state.ts:2620–2698`.

Completion calls `planRunExecutability` on the working-tree file and merely returns its diagnostic as nonblocking output. The new finalization preparer separately reads the committed blob, parses its budget, and constructs an approval record without calling the shared executable-plan validator. Consequently neither the inspection nor the approval result proves executability of the bytes being approved.

**Reproduction:** Starting from an approved source with an executable Phase 1, replace the committed phase's sole `- [ ] Work` with prose `Work`, leaving its Delivery Budget unchanged. The shared `diagnosePlanExecutability` reports `executable: false`, `PLAN_PHASE_NO_CHECKLIST`, repair `author`. For those identical committed bytes, `prepareSourceApprovalFinalization` returns `status: ready` and a finalization payload. The working tree can independently retain the valid checkbox, so completion's existing file inspection cannot cover this case.

**Failure:** The new approval can be sealed despite a known non-executable committed contract, contrary to Design Decisions 3/4 and the W3 committed-plan finalization gate. A zero-phase or duplicate-ID correction can similarly escape this budget-only preparation. Author-required structural damage is especially problematic after sealing because it is not a deterministic checklist-prefix repair.

**Required correction:** Run the existing shared authoritative executability validation on the exact committed bytes before returning a ready finalization. Return the existing actionable author/repair next action and leave the run open when invalid. Test committed-invalid/working-valid and committed-valid/working-invalid separately, plus no-phase and duplicate-ID cases, without broadening the check to ordinary valid prose or treating progress inspection as failure.

**Classification:** `implementation_defect`, W3, `auto_fix`, effort delta 1, architecture delta 0, boundary changes `[]`. This reuses W2's shared result at W3's approved boundary, not a new tripwire.

## Medium priority (P2)

No additional actionable P2 findings.

## Verification and coverage assessment

Executed from `5x-cli/`:

```sh
bun test test/unit/review-governance/plan-approval-finalization.test.ts test/unit/review-governance/implementation-state.test.ts test/unit/review-governance/implementation-amendment-registration.test.ts test/integration/commands/plan-approval-finalization.test.ts test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts
```

- **Correctness/phase contract:** Reviewed final anchor selection, ledger identity exclusions, correction admission, source selection/binding, finalization pairing/retry, legacy provenance and amendment isolation. R1/R2 are the material gaps found.
- **Security:** No new external invocation surface, auth policy or dependency. No additional injection, exposure or destructive-operation defect identified in this range.
- **Architecture/performance:** The helper, existing RecordStore streams and Git reads fit the approved design. No new database, parallel authority store or obvious material performance regression identified. Store readers consume the new record directly; no new independently authoritative SQLite state is introduced.
- **Operability:** Unsupported substantive ledger changes have an active-run recovery path, tested by a closure review and successful subsequent bind. The positive zero-effort lifecycle checks one reviewer invocation and no execution reviewer invocation. R1 would unnecessarily add another review; R2 omits the approved pre-seal structural boundary.
- **Exact bytes/legacy:** Existing focused tests cover hook-rewritten blob hashes, rejected substituted blobs/later sealed HEAD, status edits, restarted stores, idempotent preparation and unchanged legacy sources. Legacy stale-Addresses reconciliation does not mutate the source journal. Semantic execution amendments continue to reject bookkeeping/status/hook changes after exact-hash assessment.
- **Testing limitations:** Author/orchestrator report full quality and checklist success, including 4,330 full-suite tests; this review independently reran the focused 112-test selection, not that entire suite. The initial probe used a wrong module path, was corrected, and then completed successfully with the reproduced results above.

## Workflow asset-impact check

- **Document skeletons:** Unchanged in this W3 range; W5 owns the approved skeleton/compact-plan acceptance work.
- **Agent prompts, initial/continued variants:** Unchanged here; final-correction guidance remains a W5 deliverable. R1 is a runtime-policy inconsistency, not a request to narrow that guidance.
- **Runtime-appended context/native-invoke parity:** No prompt-builder branch is changed. Binding exposes shared additive finalization provenance; completion uses the common handler. W4/W5 own the later plan-evidence/rendered-context work.
- **Workflow skills:** Unchanged; approved W5 handoff and delivery-recipe regressions remain later-phase work, not missing W3 scope.
- **Installation/override/upgrade/harness synchronization:** No installer mechanics changed. Required upgrade and implementation-review-governance acceptance suites ran successfully as part of the focused command, including effective asset checks. Full W5 workflow acceptance is not claimed by this review.

## Nonblocking follow-ups

- The plan's pre-contract “Draft — pending review” status is informational and stale relative to the supplied approved v1.1 binding; it does not override that approval. No plan edit or approval inference was made.
- Later W4/W5 work is deliberately not treated as missing Phase 3 implementation.

## Readiness checklist

- [ ] R1: One-point, already-admitted final correction completes and binds without a second reviewer; unauthorized effort still fails.
- [ ] R2: Exact committed non-executable bytes cannot produce a ready finalization; the active source has the existing actionable recovery path.
- [x] Incident's zero-effort Addresses lifecycle, immutable snapshots, legacy provenance and execution-amendment hash isolation have passing focused tests.
- [x] Required focused asset acceptance command included in local verification.
