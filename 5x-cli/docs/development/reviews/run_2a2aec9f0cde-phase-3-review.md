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

## Addendum (2026-11-06) — Close Phase 3 approval findings

**Reviewed:** Authoritative closure range `5da6e5ce1dcbecc02b3f7ecd28a8543cd6e66520..7ca832fb36011dfab346bdcaead5536538ace3dd`, including author correction `b4a09f94711d93ed7f67d6620fff1146ef42b861` and operator-authored quality-performance correction `7ca832fb36011dfab346bdcaead5536538ace3dd`. Review context `230832df-ab18-4a8e-a463-b4e2f4923516`; same bound run, Phase 3/W3. This is closure of R1/R2 and review of revision-caused changes, not another exhaustive review.

### What's addressed (✅)

- **R1 — addressed: Preserve the existing final-correction effort allowance.** Re-anchored to `src/review-governance/implementation-state.ts` (`finalCorrectionBudget`, `terminalRoute`, `recordedFinalization`, and finalization preparation) and `src/review-governance/plan-approval-finalization.ts:179–327`. Recorded admitted findings now retain their effort evidence and effective ceiling. A work-item effort increase must be funded by a newly added admitted finding in its Addresses; funding is spent once, total added effort is bounded by the same `FINAL_CORRECTION_EFFORT_LIMIT` used by routing, and the effective ceiling is enforced. The record persists `correctionBudget`/`effortCorrections`, and source consumption re-proves them against the route and ledger. The positive one-point integration lifecycle completes and binds with one reviewer; negative tests reject zero-effort funding, unattributed or excessive increases, decreases, reused funding, over-ceiling changes and forged correction budgets. Original reviewer ledger immutability and execution-amendment exact-hash protections remain covered.

- **R2 — addressed: Validate executability of the exact committed finalization blob.** Re-anchored to `src/review-governance/implementation-state.ts:2703–2722, 2817–2878` and completion's `committed_plan_executability` output. The shared validator now inspects the actual committed bytes before approval preparation. Missing phase structure, duplicate phase IDs and a checklist replaced by author-required prose return `PLAN_REPAIR_REQUIRED` before any finalization/completion record or seal; the run stays active with same-run recovery. Tests distinguish committed-invalid/working-valid from committed-valid/working-invalid and demonstrate successful completion after restoring the committed structure.

### R2 contract reconciliation — mechanical repair remains supported

The correction intentionally does **not** turn every empty checklist into a pre-seal refusal. For a mechanical or explicitly line-selected checklist repair, it validates the committed blob, returns its anchored diagnostics and concrete run-form repair command, and preserves completed-source repair before binding. I accept this as addressing R2 rather than partial completion: Design Decision 2, Phase 1 and the issue-workflow handoff explicitly support repair on a completed approval source. Design Decisions 3/4 require shared committed-byte validation and actionable recovery, not elimination of that approved repair path. The initial review's blanket wording that no non-executable bytes may produce a ready finalization was broader than necessary; its reproduced author-required structural failure is now blocked correctly.

This is not an invented exception or a new approval. The finalized ledger/raw blob remains the source anchor, a repair receipt changes only authorized prefixes through the existing proof, and implementation author delegation still requires executable structure. The passing existing integration case “repairs a completed source before binding; the binding keeps its approval” exercises completion, source repair, evidence carry and unchanged binding approval identity with no extra reviewer. The new committed-blob unit case explicitly verifies the mechanical diagnostic and repair command. Requiring another approval or forcing source reopening here would contradict the approved low-friction recovery behavior.

### Revision and operator quality fix

The operator-authored performance work is preserved and reviewed as such, consistent with the supplied `author:operator-quality-fix` Phase 3 iteration 3 endpoint. The delta parallelizes test files with `--parallel=2`, pins Bun 1.4.4 in CI/release workflows, and reuses isolated copied Git/scaffold/DB fixtures instead of repeated initialization. Assertions and recovery paths are retained; the per-test timeout remains 15 seconds and the configured 300-second quality timeout was not increased. No product behavior, approval boundary or plan contract change is introduced by those test-runner/fixture changes. No revision-caused material blocker was found.

The supplied independent current-endpoint quality result reports lint, the full suite in **176,297 ms** (below the unchanged 300-second limit), and checklist success after the operator-authorized retry. That is distinct from reviewer-local verification below; the two earlier quality timeouts are not represented as successful tests or attributed to an automated author's work.

### Local verification

From `5x-cli/`, ran:

```sh
bun test --concurrent --parallel=2 --timeout 15000 test/unit/review-governance/plan-approval-finalization.test.ts test/unit/review-governance/implementation-state.test.ts test/unit/review-governance/implementation-amendment-registration.test.ts test/integration/commands/plan-approval-finalization.test.ts test/integration/commands/plan-repair-checklists.test.ts test/integration/commands/implementation-completion.test.ts test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts
# 142 pass, 0 fail; 1,617 assertions; 37.49 seconds

bun test --concurrent --parallel=2 --timeout 15000 test/integration/commands/prompt-queue.test.ts test/integration/commands/prompt.test.ts test/integration/commands/run-control-plane-bootstrap.test.ts test/integration/records/progress-resolution.test.ts
# 88 pass, 0 fail; 573 assertions; 15.93 seconds

bun run typecheck
# passed
```

Total reviewer-local focused verification: **230 tests passed, 0 failed, 2,190 assertions**, plus typecheck. Tests use isolated fixtures; no live sealed source or external project was mutated. The focused upgrade/skill acceptance suites were rerun. Skeletons, shipped prompts, runtime prompt builders and skills are unchanged in this correction range; their previously identified W4/W5 obligations remain later-phase work. No installer/override/synchronization mechanism change is needed for this correction.

### Remaining concerns

No remaining actionable R1/R2 issue and no new material blocker caused by this revision. No human policy decision is required. Ordinary previously missed issues were not reopened, and this addendum does not approve or execute later phases.

### Updated readiness

- [x] **R1 addressed:** An attributable, already-admitted one-point correction completes and binds without another reviewer; unauthorized effort remains rejected.
- [x] **R2 addressed:** Exact committed bytes are diagnosed; author-required structural failures remain active and recoverable, while approved mechanical completed-source repair remains available.
- **Phase 3/W3 completion:** ✅ Ready.
- **Ready for next phase:** ✅ No remaining material blocker in this closure scope.
