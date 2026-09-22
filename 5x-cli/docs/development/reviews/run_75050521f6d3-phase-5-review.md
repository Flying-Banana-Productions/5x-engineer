# Review: Plan 209 Phase 5 — Human gate prompt and decision actions

**Review type:** `c7c58e5d754581d4780bac6445f8972cd140d430`
**Scope:** `src/commands/review-decision.handler.ts` (new), `src/commands/review.ts` (new), `src/review-governance/store.ts` (gate prompt context/allowed choices/repair), prompt store context + `resolveReviewGatePrompt` (memory and SQLite), `waitForReviewGateDecision`, `finalizeAndWritePreparedStep` `coupled-key-exists` outcome, `recordPlanReviewerStepWithSnapshot`/`recordStepInternal` mapping, `getDb` busy-timeout ordering, tests, plan checkboxes
**Reviewer:** Staff engineer (correctness, idempotency/concurrency, plan compliance, operability)
**Local verification:** `bun test` on the four touched test files → 34 pass / 0 fail. `bun run typecheck` is clean. `bun run lint` is clean. I also ran two scratch probes, which were not committed. They confirmed P1.1 and P1.2.

**Implementation plan:** `docs/development/plans/209-plan-review-governance-plan.md` (Phase 5)
**Technical design:** N/A

## Summary

Phase 5 adds:

- The typed `plan_review_gate` notification.
- Rejection of generic prompt answers in both stores.
- An internal prompt-resolution projection.
- The `5x review gate show` / `5x review decide` CLI, including flag, inline-JSON and stdin forms.
- The exported `submitPlanReviewDecision` action, which writes through the plan-208 paired finalize seam with a gate-scoped extra op.
- The `coupled-key-exists` finalize outcome.
- A wait helper keyed on the decision key.

The core write path is sound. The spawned two-process race produced exactly one decision.

The **idempotent-winner path has two correctness gaps:**

1. An identical retry of `request_author_reestimate` is rejected instead of returning the winner.
2. A crash between the durable `abort` decision and the run-abort side effect is never repaired: retries report `route: "aborted"` while the run stays active.

Several Phase 5.3 test obligations are marked `[x]` but aren't present.

**Readiness:** Ready with corrections. The fixes are mechanical, but P1.1 and P1.2 should land before Phase 6 wires governance into the reviewer writers.

---

## What shipped

- **Prompt context seam**: nullable `contextVersion`/`context` on `PromptRecord`, round-tripped by both stores. `toRedactedPromptView` is exported. `answerPrompt` throws `REVIEW_GATE_DECISION_REQUIRED` naming `5x review decide --gate <id>`. `prompt.handler` maps that error to structured output.
- **Internal projection**: `resolveReviewGatePrompt` only accepts `plan_review_gate` prompts and CAS-closes them with the decision ID. `repairReviewGatePrompts` closes open notifications whose accepted decision already exists. `ensureReviewGatePrompt` recreates a notification when a derived gate has none.
- **Allowed choices / required fields**: cause-driven `allowedChoicesForGate`. A pending re-estimate narrows a baseline dispute to adjust/retain/abort. `REVIEW_DECISION_REQUIRED_FIELDS` provides `requiredFieldsByChoice`.
- **Decision action**:
  - Pre-reads the gate key before admission, so it works even at the step limit.
  - Runs full payload validation: choice, rationale, finding IDs resolved to authoritative fingerprints, JSON fingerprint pairs, scalar and choice-inapplicable fields, and exact architecture IDs.
  - Writes through `finalizeAndWritePreparedStep(..., { mode: "paired-all-new", extraOps })`.
  - Classifies acceptance after the append, then applies route-derived side effects: prompt resolve, successor notification, abort.
- **Finalize seam**: a discriminated `outcome: "written" | "coupled-key-exists"` result. The coupled outcome returns before the omitted-iteration retry. The snapshot writer and generic writer map it back to `RECORD_PAIR_CORRUPT`.
- **CLI**: repeatable flags with duplicate-scalar rejection. `--input-json` is mutually exclusive with the decision flags and rejects unknown or CLI-owned fields. Ambient run resolution works.
- **Wait helper**: `waitForReviewGateDecision` polls `decisions`/`decision:review-gate:<gateId>` with the existing timeout and abort model.
- **Ops fix**: `busy_timeout` is set before WAL negotiation, so independently started CLI processes don't fail immediately.

---

## Strengths

- The records-first ordering is correct. The prompt is a pure projection: it is resolved only after the durable append and acceptance classification, and it can be repaired from the decision line.
- Pre-reading the gate key before `prepareRecordStepAppend` means a loser at `max_steps` still observes the winner. A unit test covers this (`maxSteps: 2`).
- `coupled-key-exists` is checked before omitted-iteration retry and pair-corruption handling. A loser therefore never allocates step N+1, and existing writers keep their corruption contract.
- The acceptance classification after the append uses the shared `classifyDecisionAcceptance` and never compares against the live gate. A stale `abort` has no side effects, and a test covers this.
- The CLI never accepts a caller-authored fingerprint in the ID form. The JSON form validates every `(findingId, fingerprint)` pair against the gate snapshot. An integration test shows the flag, inline and stdin forms produce identical decisions.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — An identical retry of `request_author_reestimate` fails with `REVIEW_DECISION_CHOICE_NOT_ALLOWED`

In the `alreadyResolved` branch of `submitPlanReviewDecision`, the retry is validated with `allowedChoicesForGate({ causes: snapshot.effectiveGateCauses, baselineReestimatePending: state.baselineReestimatePending })`. `state` is the **current** fold, which already includes the winner. When the winner is `request_author_reestimate`, the fold sets `baselineReestimatePending`. The allowed set for the baseline dispute then narrows to adjust/retain/abort, so an identical retry fails before its intent hash is compared.

I confirmed this with a scratch probe:
- The first submit returned `created: true, route: author_revision`.
- The identical second submit threw `REVIEW_DECISION_CHOICE_NOT_ALLOWED`.

This violates the Phase 5 completion gate ("repeated-identical … observe the winner"). Two CLI processes racing the same re-estimate would also disagree: the pre-append loser path would succeed, but a later retry would fail.

The same hazard applies to any field derived from the post-winner fold. `governingBaseline` is already special-cased through `winner.governingBaselineChange?.from`.

**Recommendation:** Validate the retry against the governing state *as of the winner*. Fold decisions excluding `winner.decisionId`, or fold up to the winner's position in the stream. Then compare the intent hashes. Add a unit test that submits an identical re-estimate twice and expects `created: false`.

### P1.2 — An `abort` decision whose side effect failed is never repaired, and retries report `aborted` while the run is still active

The decision line and the human step are appended first. `defaultAbort` / `deps.abortRun` runs afterwards. If the process dies or the abort throws in between, the gate is durably resolved as `abort` but the run stays `active`.

Every later path returns early:
- The `alreadyResolved` pre-read.
- The second pre-read.
- `coupled-key-exists`.

Each returns `{ created: false, route: routeForStoredDecision(...) === "aborted" }` without applying the abort. I confirmed this with a scratch probe: the first call's `abortRun` threw, and the identical retry returned `created:false route:aborted` with `abortCalls 0`.

`repairReviewGatePrompts` only repairs the prompt projection, not the terminal run transition. The plan specifies records-first writes plus repair of projections derived from the decision record. The run-status transition is one of those projections and currently has no repair path. The same idempotent-winner paths also never call `resolveGatePromptProjection`. Only `show` repairs the prompt.

**Recommendation:** Factor the post-acceptance side-effect application into a helper. Call it from all three winner-return paths when the winner is accepted:
- Resolve the prompt projection.
- If the route is `aborted` and the run is still `active`, invoke the abort handler.

`defaultAbort` already tolerates `MAX_STEPS_EXCEEDED`. Add a test: the first `abortRun` throws, an identical retry calls it once, and the run ends `aborted`.

---

## Medium priority (P2)

- **Phase 5.3 test obligations are marked `[x]` but are missing.** None of these exist:
  - (a) A race in `store-contract.test.ts` between two independently constructed facades over one records root, for both same and conflicting payloads. `store-contract.test.ts` only gained a prompt-context round-trip test. The process-boundary race exists only in the integration test.
  - (b) Wiped-index rebuild equality for the stale (reviewer-before-human) and accepted (reviewer-after-human) cases.
  - (c) A lost-index-write case.
  - (d) A test for a loser allocated at N+1 after the winner, at the handler level. The finalize unit test covers the seam, not `submitPlanReviewDecision`.

  Add these tests following the existing fixtures in `test/unit/commands/review-decision.test.ts`, or uncheck the boxes.
- **Gate-derivation behavior change in `deriveOpenGate`.** Removing `next.length === causes.length` from the successor loop means a decision that covers no cause now yields a successor gate with identical causes. Previously it yielded no gate. This is probably the intended fix, since an uncovered gate should not disappear. But it changes Phase 2 semantics silently. Add a focused unit test that pins the new behavior.
- **Redundant second gate-key pre-read.** After `validateAndCreate`, the handler reads `decision:review-gate:<gateId>` again. The first pre-read already returned in that case, and the write path's `coupled-key-exists` handles the true race. Remove it, or merge it into the shared winner helper from P1.2, to reduce duplicated winner-handling code.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1: validate an idempotent retry against the governing state as of the winner, and add a re-estimate retry test
- [ ] P1.2: apply accepted-winner side effects (prompt resolve, abort) on every idempotent-winner path, and add an abort-crash retry test

**P2**
- [ ] Add the missing Phase 5.3 tests (store-contract facade race, rebuild equality, lost-index-write, handler-level N+1 loser)
- [ ] Pin the `deriveOpenGate` successor-with-unchanged-causes behavior with a test
- [ ] Remove the redundant second pre-read

---

## Addendum (2026-09-22) — Follow-up fix review

**Reviewed:** `fc086adc2cefa169529e8057d8436019ee31b1c1` (parent: `a2786b0`, the commit that carried this review)

**Local verification:** `bun test` on the five touched/relevant test files (`test/unit/commands/review-decision.test.ts`, `test/integration/commands/review-decision.test.ts`, `test/unit/control-plane/store-contract.test.ts`, `test/unit/commands/finalize-and-write-prepared-step.test.ts`, `test/unit/review-governance/store-index.test.ts`) → 49 pass / 0 fail. `bun run typecheck` clean. `bun run lint` clean. I re-read the full rewritten `submitPlanReviewDecision`/`acceptedWinnerResult`/`governingStateBeforeWinner` control flow against the plan text rather than re-running scratch probes, since the new dedicated unit tests exercise exactly the scenarios my prior probes constructed.

### What's addressed (✅)

- **P1.1 (identical re-estimate retry rejected)** — ✅ **Addressed.** The `alreadyResolved` branch now computes governing state via the new `governingStateBeforeWinner` helper, which folds `listDecisions(...).slice(0, winnerIndex)` — i.e. the state *before* the winner is applied — instead of the current (post-winner) fold. This means `baselineReestimatePending` is no longer wrongly set by the winner itself when validating the winner's own retry. New test `request-author-reestimate retry validates against the pre-winner fold` submits the same `request_author_reestimate` payload twice and asserts the retry returns `created: false` with the same `decisionId` and route. I traced the logic by hand and it matches the fix I recommended (fold excluding the winner, compare intent hashes).
- **P1.2 (abort side effect never repaired on retry)** — ✅ **Addressed.** All winner-return paths (`alreadyResolved` pre-read, `coupled-key-exists`, and the newly-created path) now funnel through one `acceptedWinnerResult` helper. That helper always calls `resolveGatePromptProjection` and, when `route === "aborted"`, re-checks the *live* run status (`getRunV1(ctx.db, runId)?.status === "active"`) before invoking `abortRun`/`defaultAbort`. A retry after a crashed abort will therefore re-run the abort side effect exactly when the run is still active. New test `accepted abort winner repairs a failed terminal side effect on retry` reproduces the crash-then-retry sequence and asserts the run ends `aborted` and the prompt is resolved. Consolidating prompt-resolution and abort into one helper also closes the secondary gap I flagged (prompt never resolved on idempotent-winner paths).
- **P2.1 (missing Phase 5.3 tests)** — ✅ **Addressed**, all four sub-items:
  - (a) store-contract facade race: new `describe("review-governance working-tree facade race", ...)` in `store-contract.test.ts` races two independently constructed `createWorkingTreeRecordStore` facades over one records root, for both identical and conflicting payloads, and asserts exactly one decision/human-step pair plus (for the identical case) that the loser's `resolveGate` result reports `semanticRetry: true`.
  - (b) wiped-index rebuild equality for stale/accepted cases: the `rebuiltAcceptance` helper (deletes `review_decision_index`/`review_gate_index`, calls `reindexReviewGovernance`, and diffs the rebuilt fold against the live fold) is now asserted in the stale (`reviewer-before-human is stale...`), accepted (`reviewer-after-human remains accepted...`), and prompt-crash-retry (`accepted-winner retry repairs a record-first prompt-second crash`) tests.
  - (c) lost-index-write case: new test `authoritative records survive a lost SQLite index write and rebuild` deletes the index tables after the winner is durably recorded, retries, and confirms the retry still resolves to the winner and the rebuilt fold matches.
  - (d) handler-level N+1 loser: new test `after-winner loser allocated at N+1 observes the coupled winner` hides the gate-key pre-read for two reads (forcing the write path), captures the iteration `atomicAppendIfAllNew` actually attempts, and asserts it's `2` (i.e. genuinely allocated at N+1) while still resolving to the winner.
- **P2.2 (`deriveOpenGate` successor behavior untested)** — ✅ **Addressed.** New test `a resolved decision that covers no cause creates an unchanged-cause successor` in `store-index.test.ts` pins exactly the behavior change: an `increase_budget` decision that doesn't cover the open cause produces a new gate with `causes` equal to the original gate's causes.
- **P2.3 (redundant second gate-key pre-read)** — ✅ **Addressed.** The block that re-read `decision:review-gate:<gateId>` after `validateAndCreate` and before `prepareRecordStepAppend` has been deleted entirely (visible as a straight removal in the diff). The `coupled-key-exists` outcome from `finalizeAndWritePreparedStep` is the sole remaining race-detection point on the write path, exactly as recommended.

### Remaining concerns

None from the prior review. I looked for regressions introduced by the refactor and found one minor, non-blocking observation, not worth a checklist item:

- **Best-effort double-abort on true concurrency.** Two processes that both lose to `coupled-key-exists` for the same `abort` decision, racing each other (not a sequential retry), could both pass the `status === "active"` guard before either one's `defaultAbort` updates `run_v1`/`recordStore.putRun`, and both invoke `abortRun`. This is self-healing: `defaultAbort`'s `recordStepInternal` call is keyed on the step identity (idempotent), it already tolerates `MAX_STEPS_EXCEEDED`, and `completeRun`/`putRun` are idempotent no-ops on a second call. This is strictly better than the pre-fix behavior (which never retried the abort at all), so I'm not raising it as a new finding — flagging only for awareness if a future custom `abortRun` deps override ever has non-idempotent side effects.

### Updated readiness

- **Phase 5 completion:** ✅ — Both P1 blockers and all P2 polish items from the prior review are fixed and covered by targeted regression tests. Typecheck and lint are clean; the full phase-5 test surface (49 tests) passes.
- **Ready for next phase:** ✅ — No conditions remain. Phase 6 (recording integration and workflow context) can proceed.
