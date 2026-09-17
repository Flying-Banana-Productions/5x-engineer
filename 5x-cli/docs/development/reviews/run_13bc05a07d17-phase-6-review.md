# Review: 208 Review Budget — Phase 6 (Validate, derive, persist, decorate)

**Review type:** `6e603d7` (feat) + `4944120` (run bookkeeping)  
**Scope:** `applyPlanReviewBudget`, `ensurePlanReviewBaseline`, `createReviewBudgetContext` / `recordPlanReviewerStepWithSnapshot`, `finalizeAndWritePreparedStep` extraction, protocol validate + invoke wiring, `--opt-in-budget-baseline`  
**Reviewer:** Staff engineer (correctness, record durability, test strategy, plan compliance)  
**Local verification:** `bun test` → 3351 pass / 0 fail; `bunx tsc --noEmit` clean

**Implementation plan:** `docs/development/plans/208-review-budget-advisory-plan.md` (Phase 6)  
**Technical design:** N/A

## Summary

The production code is a faithful, well-shaped implementation of Phase 6: apply is pure computation plus safety-net capture, the paired write goes through `prepareRecordStepAppend` → `finalizeAndWritePreparedStep(mode: "paired-all-new")` → `atomicAppendIfAllNew`, both ops share one `originFor` envelope, and generic recording was moved onto the same seam without behavior drift (full suite green). However, the commit ticks **all seven** 6.5 test checklist items while only one of the named test files (`apply.test.ts`) was added, and that one covers roughly a third of its enumerated cases. Four required test files do not exist and `protocol-validate.test.ts` was not touched. The phase completion gate's durability/admission guarantees are therefore unverified, and the plan checklist misreports state. There are also two error-handling gaps in the handlers.

**Readiness:** Ready with corrections — code is sound on inspection; missing tests and handler error handling are mechanical and fully specified by the plan.

---

## What shipped

- **`src/review-budget/apply.ts`**: 13-step apply algorithm (reject CLI-owned fields, off/v1_compat skip, ensure baseline, fail-closed parse, `I` rules, item field validation, claim collision, assessment binding, effective assessment merge, derive, pending snapshot; no append).
- **`src/review-budget/ensure-baseline.ts`**: CAS baseline capture with caller-supplied origin and reserved-mode warning (pulled forward from Phase 7 as apply depends on it).
- **`src/commands/review-budget-context.ts`**: factory over merged `createRecordContext`; `recordPlanReviewerStepWithSnapshot` with duplicate/repair and admit paths.
- **`src/commands/run-v1.handler.ts`**: `finalizeAndWritePreparedStep` seam (generic + paired-all-new, omitted-iteration lost-race retry); `recordStepInternal` now delegates to it.
- **Store**: `ReviewBudgetStore.projectSnapshot` — rebuild one index row from its authoritative line.
- **Handlers/CLI**: protocol validate + invoke decorate/record wiring; `--opt-in-budget-baseline` on both.

---

## Strengths

- Record-line authority is respected: the index is only ever projected from the durable line (`projectSnapshot` reads `getLine` first), and `projectDurableSnapshot` only caches `derived` when the pending content matches the durable line — a careful guard against poisoning the cache on a retry with a different payload.
- The orphan-step rule holds by construction: the duplicate branch never appends, and `atomicAppendIfAllNew` `created: false` with a specified iteration never attaches a snapshot.
- `RECORD_PAIR_CORRUPT` fail-closed path for snapshot-key-without-step matches the plan.
- No `bun:sqlite` in `src/review-budget/`, no inline `RecordOrigin`, no second `createRecordContext`; boundary test extended.
- Dry validate does not capture baselines (`params.record || baseline` gate).

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1 — Plan checklist marks tests complete that were not written

`6e603d7` flips every 6.5 item to `[x]`, but:

- `test/unit/review-budget/persist-record.test.ts` — **does not exist**
- `test/unit/commands/record-plan-reviewer-step.test.ts` — **does not exist**
- `test/unit/commands/finalize-and-write-prepared-step.test.ts` — **does not exist**
- `test/unit/review-budget/ensure-baseline.test.ts` — **does not exist** (and origin stamping is not covered elsewhere)
- `test/unit/commands/protocol-validate.test.ts` — unchanged by this commit; no `result.budget`, enforced-warning, or failed-record-no-snapshot-line cases
- `test/unit/review-budget/apply.test.ts` — 6 tests. Missing enumerated cases: reject aggregates (`rejectCliOwnedBudgetFields` path), Addresses vs still-listed `R`, new claim on later ledger → `CREDIT_ASSESSMENT_REQUIRED`, changed `before`/`targetPhase` → required, overlay re-assessment wins, author `N` from persisted `debtClaim`, `BUDGET_DEBT_CLAIM_EVIDENCE_REQUIRED` on injected ledger, `requiresHuman` readiness-unchanged.

This matters beyond bookkeeping: the completion gate's core claims (no append on admission failure, exactly one snapshot line, projection repair on retry, shared origin + redaction, omitted-iteration lost race) have **zero** direct test coverage. The new retry loop in the shared seam also changes generic-writer behavior with no test.

**Requirement:** Write the test files exactly as enumerated in plan §6.5 (one focused test per listed condition). The plan text is the spec; `MemoryRecordStore` and existing command tests provide the patterns. If any item is genuinely deferred, un-tick it rather than leaving a false `[x]`.

### P1.2 — `RecordContextError` and plan-read failures escape the handlers unstructured

`createReviewBudgetContext` throws `RecordContextError` (`RUN_NOT_FOUND`, `WORKTREE_MISSING`, …), which is **not** a `RecordError`. `protocol.handler.ts` catches only `RecordError` and rethrows; `invoke.handler.ts` has no catch at all around the block. `readFileSync(effectivePlanPath)` can also throw raw `ENOENT`. Every other caller (`run-v1.handler.ts:407/521/2476`, `commit.handler.ts:162`) maps `RecordContextError` to `outputError(code, message)`.

Additionally, the context is built whenever `role === reviewer && phase === plan && run`, even for dry validate with no baseline and for `mode = off`. A missing worktree now fails a v1 dry-validate that previously succeeded, contradicting "Dry validate (no `--record`, no baseline): v1 rules only".

**Requirement:** Map `RecordContextError` (and plan read failure) to `outputError` in both handlers, following the existing pattern. For the no-`--record` path, a context-resolution failure must degrade to the undecorated v1 envelope rather than fail. In invoke this happens after the provider run, so the failure must be a structured error, not an uncaught throw.

---

## Medium priority (P2)

- **Baseline captured before admission**: apply's safety-net capture runs before `prepareRecordStepAppend`, so `--record` against a terminal run (or at `maxStepsPerRun`) with no baseline appends a baseline line and then fails with `RUN_NOT_ACTIVE`. The completion gate says admission failures leave "both record streams unchanged". Add a cheap `run.status === "active"` guard in the handlers before invoking apply with capture enabled (the run row is already on `budgetContext.executionContext.run`), and cover it in the wrapper tests.
- **Unbounded retry loop**: `finalizeAndWritePreparedStep` uses `for (;;)`; the plan specifies "a small bound (remaining room under `maxSteps`)". The ceiling check reads SQLite `total_steps`, which does not advance when the race winner has not projected, so a `maxStoreIteration` mismatch would spin forever. Add an explicit attempt cap (`maxSteps - total_steps`, min 1) and throw a `RecordError` on exhaustion.
- **Retry uses caller's `I`**: on an idempotent complete-tuple retry, `firstAssessment` prefers `verdict.baselineAssessment` over the persisted first-snapshot value. Prefer the persisted one whenever a first snapshot exists so the decorated envelope cannot disagree with recompute.
- **`listSnapshots` called up to twice per apply** plus `latestSnapshot`; read once and derive `latest`/`first`/`matching` from the one list.
- **Protocol performer lacks `provider`** while invoke supplies it — consistent with prior behavior, fine; note only.

---

## Readiness checklist

**P0 blockers**
- (none)

**P1 recommended**
- [x] P1.1 Write the five missing/unchanged test files and the missing `apply.test.ts` cases; make plan checkboxes truthful
- [x] P1.2 Structured handling of `RecordContextError` / plan read errors; dry-validate degrades instead of failing

**P2**
- [x] Active-run guard before safety-net baseline capture
- [x] Bound the omitted-iteration retry loop
- [x] Persisted `I` wins on retry; single `listSnapshots` read

---

## Phase readiness

- **Phase 6 completion:** ⚠️ — implementation matches the design; verification does not yet exist for the completion gate.
- **Ready for Phase 7:** ⚠️ — after P1.1 and P1.2. Phase 7 builds directly on `ensurePlanReviewBaseline` and the capture ordering, so the ensure-baseline tests and the active-run guard should land first.
