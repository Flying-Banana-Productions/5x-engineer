# Review: Plan 209 Phase 6 — Recording integration and workflow context

**Review type:** `971fe2980e280f384f88506f0b109de3e8313b87`
**Scope:** Phase 6 of plan 209: governance composition around plan-208 budget apply (6.1), wiring both reviewer writers (6.2), and the review-context projection for reviewer/author renders (6.3)
**Reviewer:** Staff engineer (correctness, record/replay integrity, plan compliance, test strategy)
**Local verification:** `bun run typecheck` clean. `bun run lint` clean. `bun test` → 3562 pass / 0 fail (226 files).

**Implementation plan:** `docs/development/plans/209-plan-review-governance-plan.md`
**Technical design:** N/A

## Summary

Phase 6 covers the plan's main structural requirements. The baseline now pins mode and config. Snapshot identity is allocated once in `applyPlanReviewBudget` and reused on retry. Governance evidence (prior findings, effective and suppressed causes, diagnostics) is persisted authoritatively and projected through additive migration v10. Enforced records open or repair gate prompts after the write. Reviewer and author renders get a governance block built from the authoritative streams.

The weak point is the test surface. Almost every Phase 6.2 and 6.3 test obligation is checked `[x]` but has no test. That includes the completion gate's explicit protocol/invoke parity assertion. The new modules `review-governance/apply.ts` and `review-governance/context.ts` have no direct tests. I also found one correctness bug in the prior-finding fold: a finding that was addressed and is later reintroduced keeps its stale status. This is exactly the "removed/reintroduced finding IDs" case the plan asks to test. All the fixes are mechanical.

**Readiness:** Ready with corrections. There are no design decisions outstanding. The P1 items need a bug fix, a small refactor to one shared composition helper, and the promised tests.

---

## What shipped

- **Pinned mode and config (6.1)**: `BudgetBaselinePayload`, `ReviewBudgetBaseline`, and `CaptureBaselineInput` carry `mode`. The decode defaults to `advisory`. `applyPlanReviewBudget` checks for an existing baseline before honoring `mode = "off"`, and uses `baseline.configSnapshot` plus the folded `governingBaseline`.
- **Snapshot identity**: `PendingBudgetSnapshot.id` is allocated in apply and reuses `matchingSnapshot.id` on retry. The paired writer persists `pending.id`.
- **Governance composition**: the new `applyPlanReviewGovernance` runs `validateClosureReview`, then `derivePlanReviewGovernance`, then decorates the pending snapshot with `priorFindings`, effective and suppressed gate causes, and diagnostics.
- **Persistence**: the snapshot codec, facade, and index carry `priorFindings` and `diagnostics`. Additive migration v10 adds `prior_findings_json` and `diagnostics_json`.
- **Gate projection**: `repairGovernanceProjection` runs after both the fresh and the duplicate reviewer-record paths. It is enforced-only, runs only when effective causes are non-empty, and targets only the current snapshot's gate.
- **Writers (6.2)**: `protocol validate` and `invoke` both drop the current-config-only `mode !== "off"` guards and resolve `baseline?.mode ?? config.mode`.
- **Context (6.3)**: the new `buildPlanReviewPromptContext` and the two formatters are appended in `template render` and `invoke` for plan-review templates.
- **Run state**: `enforcement_implemented` is now `pinnedMode === "enforced"`. The state reports the pinned mode and the governing `B`. `ENFORCED_REVIEW_BUDGET_WARNING` is removed, and the config and TOML docs are updated.

---

## Strengths

- **Durable identity before serialization.** Moving UUID allocation into apply and reusing `matchingSnapshot.id` means `snapshotId` and `gateId` are stable across retries. `projectDurableSnapshot` also compares the new governance fields before projecting the cache, so a divergent retry can't overwrite the index with a different `derived` result.
- **Pinned mode is honored everywhere.** Protocol, invoke, render, and run-state all switched from `config.mode` to `baseline?.mode ?? config.mode`. The pre-baseline `off` short-circuit is preserved, so a config flip can no longer disable or promote an active run.
- **Additive migration v10** instead of mutating an already-exercised v9. The plan text was amended to say so.
- **Gate prompt repair is scoped correctly.** It is enforced-only, runs only when effective causes are non-empty, and only fires when `deriveOpenGate(...).snapshotId === pending.id`. Advisory runs never open a gate, and a retry after a resolved gate won't resurrect the old one.
- **Consolidation.** `persistedFindingsFromSnapshots` now builds prior findings from authoritative snapshot lines rather than re-parsing `result_json` in each handler, as 6.3 asks.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — A reintroduced finding keeps the stale `addressed` status and silently drops out of closure

`persistedFindingsFromSnapshots` (`src/review-governance/apply.ts:34–63`) sets each finding with `...(prior?.status ? { status: prior.status } : {})`. Suppose round 2 reports `P1: addressed`, and round 3's `items[]` contains `P1` again, for example as a new blocker with a validated `introducedBy`. The round-3 entry inherits `status: "addressed"`. `validateClosureReview` then filters `status !== "addressed"` out of `requiredFindings` (`closure.ts:397–401`). So in round 4 the reviewer is not required to report on P1 and can omit it without a diagnostic. The same fold feeds `buildPlanReviewPromptContext.priorFindings`.

This is the "removed/reintroduced finding IDs" case that 6.3 lists as a test obligation. The logic came from the deleted `persistedFindingsFromSteps` without change, but it now sits in the shared, exported fold.

**Requirement:** When a finding appears in a later snapshot's `findings`, it is active again. Do not carry forward a prior `status`; outcomes in later snapshots still apply. Add unit tests for these cases:
- addressed, then reintroduced, then required again
- same ID with a changed fingerprint, which produces a new fingerprint and is not covered by a prior deferral
- equal-timestamp insertion order

### P1.2 — The protocol and invoke paths duplicate governance composition, and nothing tests their parity

6.2 requires "one writer function between native validation and invoke; assert equal idempotency tuple, performer metadata, and decorated `result_json`". The Phase 6 completion gate requires that `protocol validate --record` and `invoke reviewer --record` "produce identical reviewer step, budget snapshot, governance decoration, and route".

The final writer (`recordPlanReviewerStepWithSnapshot`) is shared. The composition that decides the decorated `result_json` is not. It is copied in `protocol.handler.ts:517–690` and `invoke.handler.ts:765–930` (about 150 lines each), and the copies already diverge on how they pick the previous review commit for the plan diff:
- **protocol** takes `head_commit` from the last prior plan `reviewer:*` step line (`priorPlanReviewerSteps(...).at(-1)`). It only computes the diff when prior steps exist.
- **invoke** takes the step line matching the last prior **snapshot** (`listLines(...).find(...)` on name/phase/iteration).

The two agree today in the common case. They can disagree whenever a plan reviewer step has no paired snapshot, for example steps recorded before an opt-in baseline or while a plan read failed. When they disagree, the two paths validate `introducedBy` against different patches.

No test compares the two paths at all. `grep` finds no test that references `applyPlanReviewGovernance`, `buildPlanReviewPromptContext`, `formatAuthorGoverningDecisions`, or the gate-prompt repair.

**Requirement:**
- Extract one helper, for example `composePlanReviewerRecord(ctx, {verdict, stepName, iteration, performer, optIn})`, in `review-budget-context.ts` or `review-governance/apply.ts`. It should cover:
  - governing-state resolution
  - `applyPlanReviewBudget`
  - previous-review-commit resolution, using the prior snapshot's step since snapshots define closure `reviewKind`
  - diff build
  - `applyPlanReviewGovernance`
- Call it from both handlers.
- Add the parity test the plan promises: the same verdict through both paths yields an equal step idempotency key, performer origin, decorated `result_json`, and snapshot payload.

### P1.3 — Phase 6.1 and 6.3 test obligations are checked but missing

These checked items have no corresponding tests in the commit:
- **After an enforced `human_gate` record:** a gate prompt is created, and a duplicate record repairs the prompt or index without appending a second snapshot or step line. An advisory run with the same verdict opens no prompt.
- **Pinned mode:** a run captured under `enforced` stays enforced after config changes to `advisory` or `off`, and vice versa. This should be covered in protocol, invoke, render, and `run state`, including `enforcement_implemented: true` for enforced-pinned runs.
- **`governingBaseline`:** after an `adjust_baseline` or `increase_budget` decision, `derived.B` and the run-state `B` use the folded value.
- **Context projection (6.3):**
  - `template render` of `reviewer-plan-continued` includes every active `defer_accept_risk` entry.
  - `author-process-plan-review` renders the "Governing decisions" block.
  - Superseded decisions are excluded.
  - Rebuild after an index wipe gives the same context, because the context reads from the record streams.
- **Admission:** a terminal run or a max-steps failure writes no snapshot.

Add these using the existing fixtures in `test/unit/commands/review-decision.test.ts`, `test/integration/commands/review-budget.test.ts`, and `test/unit/commands/protocol-validate.test.ts`. The alternative is to uncheck the boxes.

---

## Medium priority (P2)

- **Closure validation now runs after baseline capture.** Phase 3 validated closure before `applyPlanReviewBudget`. Now `applyPlanReviewGovernance` runs after it. An enforced initial review with an invalid item (for example, missing `lowestCostCorrection`, rejected by `validateInitialItem`) therefore appends the budget baseline and then fails. That conflicts with 6.1's "invalid verdict … writes nothing". Plan-208 budget-shape errors already capture before rejecting, so this matches existing behavior. Still, the closure check was deliberately earlier before.
  - **Fix:** run `validateClosureReview` (initial kind, config mode) as a pre-check when no baseline exists, before `applyPlanReviewBudget`. Or fold this into the P1.2 helper.
- **Archived/git-record run state ignores the governing `B`.** The `gitRecord` branch of `runV1State` (`run-v1.handler.ts:~1966–2007`) calls `tryBuildReviewBudgetState` without `governingBaseline`. Archived runs therefore report `baseline.b` while active runs report the folded value.
  - **Fix:** load the decisions and steps lines into the memory store and fold them as the live path does.
- **Render and invoke order the appended blocks differently.** `template render` appends the governance block before the review-diff block. `invoke` appends the diff first, then governance. Native continuation and invoke therefore get different prompts for the same state.
  - **Fix:** use one order, ideally through a shared `appendPlanReviewContext(prompt, diff, governance)` helper.
- **The reviewer context block omits `priorFindings`.** `PlanReviewPromptContext.priorFindings` is computed, but `formatReviewerGovernanceContext` never renders it. Either render the required prior-finding IDs and fingerprints, so a fresh provider session knows what closure it owes, or drop the field.
- **Small dead code:**
  - `activeDecisionIds` in `buildPlanReviewPromptContext` is built from `state.history` and then used to filter `state.history`, so it filters nothing.
  - `warnForReviewBudgetRunState` is now a no-op with unused parameters.
  - The governing state is folded twice per record in both handlers: once before apply, once after.
  - `applyPlanReviewGovernance` mutates `input.budgetResult.pendingSnapshot` in place while also returning it.

  Remove or tighten these, preferably as part of the P1.2 extraction.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1: clear the carried-forward status for a reintroduced finding in `persistedFindingsFromSnapshots`, and add tests for reintroduced IDs, changed fingerprints, and equal timestamps
- [ ] P1.2: extract one shared governance-composition helper for protocol and invoke, and add the parity test
- [ ] P1.3: add the missing 6.1 and 6.3 tests (gate open/repair, pinned mode across config change, governing `B`, context/author block rendering, superseded exclusion, index-wipe equality, admission writes nothing)

**P2**
- [ ] Pre-validate an initial closure before baseline capture
- [ ] Pass the governing `B` in the git-record run-state path
- [ ] Unify the order of the render and invoke appended blocks
- [ ] Render or drop `priorFindings` in the reviewer context
- [ ] Remove the redundant filter, the no-op warn function, and the double fold

---

## Addendum (2026-09-22) — Follow-up fix review

**Reviewed:** `c3c3c127591adb51f6d05f5860efd956217ec5db` (parent: `7f54db0`, the commit that carried the prior review)

**Local verification:** `bun run typecheck` clean. `bun run lint` clean. `bun test` → 3568 pass / 1 fail / 227 files. The one failure (`review decision CLI > two independent processes converge on one gate decision and human step`, a `.txn.lock` ENOENT under concurrent spawn) reproduced only under full-suite concurrent load; it passed 3/3 times in isolated reruns and touches no file changed in this diff. Not attributable to this commit.

### Disposition of prior findings

- **R1 (P1) — Reintroduced finding keeps stale `addressed` status** — ✅ **Addressed.** `persistedFindingsFromSnapshots` (`src/review-governance/apply.ts:54-62`) no longer carries `prior?.status` forward when a finding reappears in `findings`; the `...(prior?.status ? { status: prior.status } : {})` spread was deleted outright. New test `plan review finding history > reintroduced findings clear stale prior outcomes` (`test/unit/review-governance/apply-context.test.ts`) pins exactly the scenario I raised: addressed in round 2, reintroduced in round 3, and asserts the fold has no `status` property. I traced the fix by hand against `closure.ts`'s `requiredFindings` filter and confirmed a reintroduced finding is now correctly required again.
- **R2 (P1) — Duplicate protocol/invoke composition, no parity test** — ✅ **Addressed.** Both handlers now call one shared `composePlanReviewerRecord` (`src/commands/review-budget-context.ts:162-290`), which owns governing-state resolution, the initial-enforced pre-check, `applyPlanReviewBudget`, previous-review-commit resolution (now uniformly from the prior *snapshot's* step, resolving the exact divergence I flagged), the diff build, and `applyPlanReviewGovernance`. `protocol.handler.ts` and `invoke.handler.ts` lost ~120 and ~90 lines respectively and now just call the shared function. New test `composePlanReviewerRecord > keeps protocol and invoke composition byte-for-byte equivalent` builds two independent contexts, runs the same verdict through both, and asserts equal `JSON.stringify(verdict)`, equal pending-snapshot fields (excluding the UUID), and equal baseline fields (excluding the UUID). This is exactly the parity assertion the plan's 6.2 and completion gate ask for.
- **R3 (P1) — Missing Phase 6.1/6.3 tests** — 🟡 **Partially addressed.** New coverage added: the composition parity test above; `rejects invalid initial evidence before writing a baseline` (covers R4 below); `consumes persisted prior findings after reconstructing closure state`; `projects the same deterministic diff fallback through the shared seam`; `archived run state folds decisions into governing B` (covers R5); and the reintroduced-finding/prior-findings-rendering tests in `apply-context.test.ts` (covers part of R7). Still missing, unchanged from the original review:
  - No test exercises `repairGovernanceProjection`/`ensureReviewGatePrompt`/`repairReviewGatePrompts` through the actual record path (`recordPlanReviewerStepWithSnapshot` or `composePlanReviewerRecord`) to confirm an enforced `human_gate` verdict opens a prompt and a duplicate record repairs it without duplicating the prompt. The underlying primitives are unit-tested from Phase 5, and the integration test asserts `verdict.governance.route === "human_gate"`, but the prompt-store side effect itself is unverified at this new wiring layer.
  - No test asserts a run stays pinned to its captured mode after a **live config change** post-capture (e.g., capture under `enforced`, then flip config to `advisory` mid-run, then confirm a later `protocol validate`/`invoke`/`run state` call still reports `enforced` and still gates). The existing "mode off inspects context for a previously pinned baseline" and "enforced mode is pinned" tests don't flip config after baseline capture within the same test.
  - `buildPlanReviewPromptContext` itself (as opposed to the formatters it feeds) still has zero direct tests anywhere in the repo — no coverage for superseded-decision exclusion from `deferredOrAcceptedRisks`, or for context equality after an index wipe/rebuild.
  I no longer treat this as P1: the highest-value gaps (fold-order bug, protocol/invoke parity, archived-run baseline) are now covered by targeted regression tests, and what's left is defense-in-depth for wiring built from already-tested primitives. Downgraded to P2.
- **R4 (P2) — Closure validation runs after baseline capture** — ✅ **Addressed.** `composePlanReviewerRecord` now runs a `validateClosureReview({ reviewKind: "initial", ... })` precheck before `applyPlanReviewBudget` when no baseline exists and mode is `enforced` (`review-budget-context.ts:186-206`). New test `rejects invalid initial evidence before writing a baseline` asserts both that the call fails with `INITIAL_BASELINE_ASSESSMENT_REQUIRED` and that no baseline or budget record line was written.
- **R5 (P2) — Git-record run-state path ignores governing B** — ✅ **Addressed.** `loadGitRecordForPlan` now also loads `stepLines` and `decisionLines` (not just `budgetLines`); `runV1State`'s archived branch appends all three streams into the memory `RecordStore`, folds `deriveGoverningState` from them, and passes the resulting `governingBaseline` into `tryBuildReviewBudgetState`. New test `archived run state folds decisions into governing B` records an `adjust_baseline` decision live, deletes the run row to force the archived path, and asserts the archived state's `B` equals the live state's `B` (8, not the original baseline).
- **R6 (P2) — Inconsistent append order between render and invoke** — ✅ **Addressed.** Both `template.handler.ts` and `invoke.handler.ts` now build their prompt through the same `appendPlanReviewPromptContext({ prompt, diffAppend, governanceAppend })` helper (diff first, then governance, matching the invoke order from before — render was reordered to match). New test `renders prior findings and appends diff before governance identically` in `apply-context.test.ts` pins the exact byte sequence.
- **R7 (P2) — Reviewer context omits `priorFindings`; minor dead code** — 🟡 **Partially addressed.** `formatReviewerGovernanceContext` now renders a `### Prior findings` section listing each finding's ID, fingerprint, status, title, scope, failure, and lowest-cost correction (`context.ts:81-88, 97`), and the new test asserts the rendered line. The dead-code half is unchanged: `activeDecisionIds` in `buildPlanReviewPromptContext` (`context.ts:47-52`) is still built from `state.history` and then used to filter `state.history`, so the filter still can't ever be false. `warnForReviewBudgetRunState` (`run-v1.handler.ts:973-978`) is still a documented no-op with unused parameters. `applyPlanReviewGovernance` still mutates `pending` in place while also returning it. None of these affect behavior; they're cosmetic. The double-fold issue is now better than before — `composePlanReviewerRecord` only recomputes `governingState` when it was `undefined` going in (i.e., only on first-ever capture), not unconditionally.

### New issues introduced by this revision

None found. The refactor is a straightforward extraction; behavior at the call sites is preserved and the new parity test would have caught a divergence.

### Updated readiness

- **P0/P1 blockers:** none remain. Both P1 items (R1, R2) are fixed and regression-tested. R3 is downgraded to P2 since its highest-risk gaps are now covered; what's left is additional test depth on already-low-risk wiring.
- **P2 remaining (all mechanical, `auto_fix`):**
  - Add a test exercising `repairGovernanceProjection` through `recordPlanReviewerStepWithSnapshot`/`composePlanReviewerRecord` (enforced `human_gate` opens a prompt; a duplicate record repairs it without a second prompt or duplicate append; advisory opens none).
  - Add a test that flips config mode after baseline capture and confirms the run stays pinned across `protocol validate`, `invoke`, and `run state`.
  - Add direct tests for `buildPlanReviewPromptContext`: superseded-decision exclusion and index-wipe/rebuild context equality.
  - Remove the no-op `activeDecisionIds` filter in `context.ts`.
  - Remove the no-op `warnForReviewBudgetRunState` function and its call site, or repurpose it now that there's nothing to warn about.
  - Stop mutating `pending` in place inside `applyPlanReviewGovernance`, or document why the mutation is intentional (the paired writer reads the same object afterward).
- **Ready for next phase:** ✅ — no P0/P1 items and nothing requires a human decision. Phase 7 (reviewer templates and workflow skills) can proceed with the above P2 items tracked as follow-up polish.
