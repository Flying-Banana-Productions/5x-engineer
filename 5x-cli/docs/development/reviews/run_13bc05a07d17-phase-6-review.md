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

---

## Addendum (2026-09-17) — Phase 6 hardening fix

**Reviewed:** `558db04` (`fix: harden phase 6 budget persistence`), diffed against `4944120`/`b8e25ab` (prior review baseline)

**Local verification:** `bun test` → 3388 pass / 0 fail (up from 3351); `bunx tsc --noEmit` clean

### What's addressed (✅)

- **P1.1 (missing test files)** — **Addressed.** All five previously-absent/untouched files now exist with focused coverage matching plan §6.5:
  - `test/unit/review-budget/apply.test.ts` grew from 6 to 14 tests, now covering reject-aggregates, Addresses-vs-still-listed-`R`, new/changed-claim-requires-assessment, overlay-reassessment-wins, author-`N`-from-persisted-ledger, `BUDGET_DEBT_CLAIM_EVIDENCE_REQUIRED` on an injected ledger, and idempotent-retry-uses-persisted-`I`.
  - `test/unit/review-budget/persist-record.test.ts` (new, 5 tests): failed-append leaves nothing, unique+retry keeps one snapshot, retry repairs missing SQLite projections, projection failure after durable success is repaired, reindex restores `baselineAssessment`.
  - `test/unit/review-budget/ensure-baseline.test.ts` (new, 3 tests): system origin, agent safety-net origin + enforced warning, missing-section failure with no unattributed line.
  - `test/unit/commands/record-plan-reviewer-step.test.ts` (new, 10 tests): the full admission/duplicate/ceiling/lost-race/origin-sharing/redaction matrix from plan §6.5.
  - `test/unit/commands/finalize-and-write-prepared-step.test.ts` (new, 4 tests): generic vs paired mode, specified-iteration no-retry, and the new bounded-retry behavior.
  - `test/unit/commands/protocol-validate.test.ts` gained a dedicated `"protocol validate reviewer — active review budget"` describe block (8 tests) covering record+decorate, enforced-warning, terminal/at-limit admission-failure-captures-nothing, dry-validate degradation, mode-off skip, and context-failure-to-CliError mapping.
  
  The completion gate's core durability/admission claims now have direct test coverage. Plan checkboxes are truthful.

- **P1.2 (`RecordContextError` / plan-read errors escape unstructured)** — **Addressed.** Both `protocol.handler.ts` and `invoke.handler.ts` now wrap `createReviewBudgetContext` in try/catch: a `RecordContextError` maps to `outputError(code, message, detail)` when `--record` is set, and degrades to `budgetContext = undefined` (skip decoration, keep the v1-compatible envelope) when it is not. `readFileSync` on the plan path is likewise wrapped, mapping to `PLAN_NOT_FOUND` under `--record` and falling back gracefully otherwise. Context creation is now skipped entirely under `mode: "off"` (checked via `loadConfig`/`config.reviewBudget.mode` before ever calling the factory), which also resolves the second half of the original complaint (a missing worktree no longer fails a v1 dry-validate when budgets are off). Confirmed by `"record maps context failures to structured CliError"`, `"dry validation degrades on context and plan read failures"`, and `"mode off skips review-budget context creation"`.

- **P2 (baseline captured before admission)** — **Addressed.** Both handlers now run a side-effect-free `prepareRecordStepAppend` probe before invoking `applyPlanReviewBudget`'s safety-net capture when `params.record && !baseline`; a thrown `RecordError` sets `admissionEligible = false` and skips apply entirely, so a terminal or at-the-ceiling run no longer appends an orphan baseline line before failing. `prepareRecordStepAppend` performs no store mutation (confirmed in `run-v1.handler.ts:1811+`), so calling it once as a probe and again inside the real record path is safe, if slightly redundant. Confirmed by `"terminal admission failure captures no baseline or snapshot"` and `"at-limit admission failure captures no baseline or snapshot"`.

- **P2 (unbounded retry loop)** — **Addressed.** `finalizeAndWritePreparedStep` now computes `maxAttempts = Math.max(1, prepared.maxSteps - initialSummary.total_steps)` up front and throws `RECORD_ITERATION_RETRY_EXHAUSTED` once `attempts >= maxAttempts` on an omitted-iteration lost race, rather than looping unconditionally. Covered by `"omitted-iteration retry is bounded by remaining room"`.

- **P2 (retry uses caller's `I` instead of persisted)** — **Addressed.** `apply.ts` now reads `snapshots` once, derives `firstSnapshot = snapshots[0]`, and computes `firstAssessment = firstSnapshot?.baselineAssessment ?? input.verdict.baselineAssessment` — persisted wins whenever a first snapshot exists. A new `isInitialRetry` guard also tightens the old `BASELINE_ASSESSMENT_UNEXPECTED` check: it now only tolerates a caller resending `baselineAssessment` when the matching snapshot **is** the run's first snapshot (previously any snapshot matching the same step/phase/iteration key sufficed, which could coincidentally accept a resent `baselineAssessment` on a non-initial key). Covered by `"idempotent retry uses persisted first assessment"`.

- **P2 (`listSnapshots` called twice)** — **Addressed.** `apply.ts` now calls `input.store.listSnapshots(input.runId)` exactly once and derives `firstSnapshot`, `latest` (`.at(-1)`), and `matchingSnapshot` from that single array.

### New issue introduced by this revision

- **P2 (new) — Empty-but-present plan file is silently treated as "context vanished," even under `--record`.** In both `protocol.handler.ts:528-548` and `invoke.handler.ts:708-722`, the plan-read failure handling uses a truthiness check on the string:
  ```ts
  try {
    planMarkdown = readFileSync(path, "utf-8");
  } catch (err) {
    if (!params.record) planMarkdown = "";
    else outputError("PLAN_NOT_FOUND", ...);
  }
  if (!planMarkdown) {
    // dry-validation stays v1-compatible
  } else {
    ... applyPlanReviewBudget(...) ...
  }
  ```
  `readFileSync` succeeding with an empty string (`""`) is indistinguishable from the caught-and-defaulted `""` used for the *read failure* path, because both are falsy. So a plan file that exists but is empty (or was truncated) silently skips `applyPlanReviewBudget` even when `--record` is set — no `PLAN_NOT_FOUND`, no parse error, no budget decoration, and the step still gets recorded via `recordStepInternal`/`recordPlanReviewerStepWithSnapshot` with no budget line. Before this revision, an empty plan would have reached `parseDeliveryBudget("")` inside `applyPlanReviewBudget` and surfaced a structured parse-failure code. This is a narrow edge case (a real plan.md is essentially never empty in practice) but it is a genuine regression in fail-closed behavior for `--record`, and it is untested — the two new tests that exercise this branch (`"dry validation degrades on context and plan read failures"`, `"record maps context failures to structured CliError"`) only assert "does not throw" / "throws mapped CliError," not the empty-content case.

  **Fix:** track read success/failure with an explicit boolean instead of relying on string truthiness, e.g. `let planReadFailed = false;` set in the `catch`, and branch on `if (planReadFailed) { ... } else { applyPlanReviewBudget(...) }` so a successfully-read empty file still reaches (and fails through) the parser.

### Remaining concerns

- None at P0/P1. The one new item above is P2 and narrow in practical impact.
- Minor, not worth a line item: `prepareRecordStepAppend` is now invoked twice per `--record` review call (once as the admission probe, once inside the real record path) — cheap (in-memory checks + a best-effort git call) but slightly redundant; not worth restructuring given the clarity of the current split between "check eligibility" and "actually record."

### Updated readiness

- **Phase 6 completion:** ✅ — all P1/P0 items from the initial review are resolved and independently verified in the current source and test suite; one narrow new P2 remains.
- **Ready for next phase:** ✅ — the one new finding (empty-plan-file truthiness bug) is mechanical and does not block moving to Phase 7; it can be fixed alongside or after that work.
