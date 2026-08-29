# Review: Review-Budget Advisory Foundation

**Review type:** `docs/development/plans/208-review-budget-advisory-plan.md`  
**Scope:** Advisory delivery-budget parsing, arithmetic, persistence, protocol integration, baseline capture, run-state reporting, and compatibility.  
**Reviewer:** Staff engineer (correctness, durability, protocol integrity, operability)  
**Local verification:** Static review against the plan, plan input, v2 budget design, and current protocol, invoke, template, schema, store, and run-state implementations. Tests not run (plan review).

**Implementation plan:** `docs/development/plans/208-review-budget-advisory-plan.md`  
**Technical design:** `docs/v2/200-overview.md`, `docs/v2/206-review-budget-governance.md`, and `docs/v2/207-state-segmentation.md`

## Summary

The plan establishes a sound advisory-only boundary: parsing is fail-closed, arithmetic is isolated, aggregate reviewer fields are rejected, and baseline capture is explicitly separated from v1-compatible mid-review runs. The phase sequencing and test matrix are unusually complete and retain the current routing contract. Three mechanical corrections are required to prevent orphaned or nondeterministically selected telemetry, unstable debt-credit forecasts, and an internally contradictory canonical fixture.

**Readiness:** Ready with corrections — the required changes are directly derivable from the plan, canonical design, and current command lifecycle; no policy decision is needed.

---

## Strengths

- **Clear advisory boundary:** `requiresHuman` is recorded without changing readiness, loop routing, or human-gate behavior.
- **Fail-closed baseline protection:** Missing or malformed budget tables cannot silently establish a zero baseline, and the INSERT-once baseline contract preserves auditability.
- **Appropriate architecture:** The dedicated parser, pure arithmetic module, and control-plane store align with existing command/store boundaries and keep SQLite out of handlers.
- **Compatibility coverage:** The explicit `off`, `v1_compat`, initial capture, and opt-in matrix makes migration behavior testable.
- **Protocol integrity:** Rejecting CLI-owned aggregates rather than merging them protects deterministic server-owned computation.

---

## Production readiness blockers

None after the deterministic plan corrections below.

---

## High priority (P1)

### P1.1 — Make review-step recording and budget snapshot persistence atomic

**Risk:** Phase 6 appends a budget snapshot before `recordStepInternal`, while the current `protocolValidate` and `invokeAgent` implementations emit their success envelope and record the step afterward (`src/commands/protocol.handler.ts:479–515`, `src/commands/invoke.handler.ts:642–684`). If step recording fails (terminal run, step limit, DB error, or retry race), the budget snapshot remains without its corresponding reviewer record. A retry can append another snapshot for the same verdict, making telemetry and `run state` disagree with the durable run journal.

**Requirement:** Use the same resolved database context and one transaction to append the snapshot and record the decorated reviewer step, or defer snapshot insertion until the step-record transaction succeeds. Ensure a failed record leaves no snapshot, and add failure/retry tests that prove there is exactly one snapshot per successfully recorded reviewer step.

**Action:** `auto_fix`

### P1.2 — Preserve previously assessed debt claims when deriving later snapshots

**Risk:** Phase 6 requires assessments only for claims first seen in a review (plan lines 871–872), but `deriveBudget` receives only the current verdict's `creditAssessments` (lines 405–421, 873). On a later closure review that correctly omits an already-assessed claim, `eligibleN` cannot recover the prior eligibility and its `N`/`D`/`E` result drops to zero. The Phase 9 instruction to re-emit every assessment conflicts with the stated first-seen validation rule rather than solving this persistence gap.

**Requirement:** Define the apply input as the current assessment set merged with persisted assessments for unchanged claims (and use that effective set for derivation), or consistently require and validate a current assessment for every current claim. Align Phase 6, reviewer-skill instructions, and tests; cover an eligible claim retained across a continued review with no new assessment and a newly introduced claim that still requires one.

**Action:** `auto_fix`

### P1.3 — Correct the canonical effort example to match the enforced scale

**Risk:** The parser's “canonical” table uses effort `4` for `W2` (plan line 462), while Phase 1 permits only `{1, 2, 3, 5, 8}` (lines 119, 220–222) and Phase 2 explicitly requires `4` to be rejected in its fixture (line 525). Implementers cannot both accept the documented canonical input and satisfy the planned validation test.

**Requirement:** Replace the canonical example's unsupported score with an allowed score (and adjust any associated narrative if needed), retaining `4` exclusively as an invalid-input test value.

**Action:** `auto_fix`

---

## Medium priority (P2)

- **Deterministic snapshot order:** `created_at` uses SQLite's second-resolution `datetime('now')` (planned schema lines 626–639), so multiple snapshots in one second cannot be reliably ordered by the proposed `(run_id, created_at)` index. Specify `latestSnapshot`/`listSnapshots` ordering with an insertion-order tie-breaker (for example, SQLite `rowid` or a persisted sequence) and add same-timestamp coverage. (`action: auto_fix`)
- **Enforced-mode warning path:** Direct `protocol validate --record` capture can use the Phase 6 safety-net path without the Phase 7 render hook, while Phase 6 only says a caller “should already have a warning channel.” Require the shared capture helper to issue the reserved-mode warning on every first capture path and add a direct-record test. (`action: auto_fix`)

---

## Readiness checklist

**P0 blockers**
- [x] Advisory mode preserves v1 routing and does not create unapproved human-gate behavior.
- [x] Baseline capture and plan parsing fail closed and are explicitly compatible with mid-review v1 runs.

**P1 required corrections**
- [ ] Persist a budget snapshot atomically with its decorated recorded reviewer step (`auto_fix`)
- [ ] Carry forward valid debt-claim assessments, or uniformly require current assessments, for continued derivation (`auto_fix`)
- [ ] Make the canonical parser example use an allowed effort score (`auto_fix`)
- [ ] Define deterministic same-timestamp snapshot ordering and cover the direct-record enforced warning path (`auto_fix`)

---

## Addendum (2026-08-29) — Revision 1.1 re-review

**Reviewed:** `36ceada76b27e5647654cbf454c6127bd2463722` | plan version 1.1

### What's addressed (✅)
- **P1.1 — Atomic snapshot + reviewer step:** Resolved. `applyPlanReviewBudget` now returns an unpersisted pending snapshot, and Phase 6 requires `recordStepInternal` to run the unique step insert and `appendSnapshot` hook in one transaction on the same resolved database. The specified failure, duplicate, and rollback tests establish the required 1:1 durable relationship.
- **P1.2 — Carry forward debt-claim assessments:** Resolved. The plan defines an effective assessment overlay from the prior snapshot, requires new or changed author claims to be assessed again, persists the merged set, and aligns the continued-review prompt and skill with that rule.
- **P1.3 — Canonical effort scale:** Resolved. The canonical `W2` fixture now uses effort `5`; effort `4` is retained solely as the invalid-input case.
- **P2 — Deterministic snapshot ordering:** Resolved. SQLite reads order by `(created_at, rowid)` and the memory store supplies an insertion sequence; the store contract test explicitly covers equal timestamps.
- **P2 — Enforced-mode direct-record warning:** Resolved. `ensurePlanReviewBaseline` owns the warning for every successful first capture, including the validate/invoke safety-net path, with direct-record coverage required.

### Remaining concerns
- **P1.4 — Persist and validate complete plan-side debt-credit evidence:** The revised plan accepts a negative author work item with only `debtClaimId` and `coupling` (`208-review-budget-advisory-plan.md:308-317`, `527-536`). It does not parse or persist the required target implementation phase, minimal-compliant comparison, or concrete before/after evidence. Those fields exist only on an optional reviewer-item `creditClaim` (`753-806`) and therefore cannot establish eligibility for a negative architecture claim already present in the author ledger. This conflicts with the canonical debt-credit contract (`docs/v2/206-review-budget-governance.md:193-210`, `365-388`) and leaves provisional `N`/`D` based on an unverified claim that later implementation review cannot reconcile. **Action: `auto_fix`.** Extend the Delivery Budget debt-claim syntax/table (or a required structured subsection), `ParsedWorkItem`, baseline/current-ledger snapshots, and parser diagnostics to require and retain `targetPhase`, minimal-alternative effort/architecture deltas, and non-empty before/after evidence for every negative claim. Require the credit assessment to reference that persisted claim and add parser, apply, store, and round-trip tests.

### Updated readiness
- **Plan completion:** ⚠️ — the five prior P1/P2 corrections are fully specified, but the plan-side debt-credit contract remains incomplete.
- **Ready for implementation:** ⚠️ — ready with the mechanical P1.4 correction above; no human policy or architecture decision is required.

---

## Addendum (2026-08-29) — Revision 1.2 final re-review

**Reviewed:** `9ab43e5ecec363bb8f54860cf4a24355f810789f` | plan version 1.2

### What's addressed (✅)
- **P1.4 — Complete plan-side debt-credit evidence:** Resolved. Negative author rows now join to a required `### Debt Claims` / `#### DCn` block, and `DebtClaimEvidence` retains target phase, minimal-compliant effort/architecture deltas, and non-empty before/after evidence in both baseline and current ledgers. The plan binds assessments to those persisted claims, rejects unknown/colliding IDs, treats evidence changes as reassessment triggers, and specifies parser, arithmetic, apply, store round-trip, template, skill, and integration coverage. This closes the prior gap in which a reviewer-side claim could stand in for author-ledger evidence.
- **Prior P1/P2 corrections:** Remain resolved. The plan still specifies atomic snapshot/step persistence, carried-forward effective assessments, an allowed canonical effort value, deterministic same-second snapshot ordering, and a warning on every enforced-mode first-capture path.

### Remaining concerns
- **P0 — Record-tier persistence conflicts with the canonical v2 state-segmentation contract:** The plan explicitly chooses SQLite-only `ReviewBudgetStore` materialization and says that defining `RecordStore` is out of scope (`208-review-budget-advisory-plan.md:33, 42-43, 128-130, 1379-1380`). Canonical `207-state-segmentation.md:85-86, 136-143` instead classifies the baseline, governing budget, ledgers, and decisions as repository **Record** tier and requires slice 06 to code against the frozen `RecordStore` interface. The slice-10 input makes that dependency explicit: its phase 1 freezes `RecordStore` and its in-memory implementation before slice 06 proceeds, and says slice 06 persistence must never target SQLite-only rows (`plan-inputs/10-git-native-run-records.plan-input.md:21-25, 70, 106-109`). Implementing this plan as written would strand authoritative budget history in `.5x/5x.db`, violate the rebuildability/audit requirement, and require a later migration/rewrite that the canonical design specifically avoids. **Action: `human_required`.** First publish/freeze the slice-10 `RecordStore` contract (including the needed budget-line append/read semantics), then revise this plan to depend on and persist its baseline/ledger/assessment record through that interface, with SQLite only as the rebuildable index/cache. Reconcile the snapshot/step atomicity requirement with record writes in that shared contract before implementation begins.

### Updated readiness
- **Plan completion:** ❌ — P1.4 and all earlier review corrections are complete, but the persistence architecture contradicts the newer canonical record-tier design and an unavailable cross-slice interface.
- **Ready for implementation:** ❌ — not ready pending a human-coordinated slice-10 interface freeze and a corresponding persistence/phasing revision.

---

## Addendum (2026-08-29) — Revision 1.3 staff re-review

**Reviewed:** `15849d3ffd26484609b99a6aedd9e3c5aa301d02` | plan version 1.3

### What's addressed (✅)
- **P0 — Record-tier persistence:** Resolved. Phase 4 is now explicitly blocked on slice 10 Phase 1 freezing the `RecordStore` interface and its in-memory implementation, including budget-stream read/write, insertion ordering, and atomic multi-append semantics. Baselines and snapshots are authoritative budget record lines; the v8 SQLite tables are expressly rebuildable projections/cache only. The plan neither implements nor forks slice 10's interface, working-tree layout, or records commands.
- **P1.1 atomicity remapping:** Substantively resolved. The plan binds the budget-snapshot key to the reviewer-step tuple and requires a single `RecordStore.atomicAppend` for both lines. It correctly makes the record durable when a subsequent SQLite projection fails, with reindexing as cache repair.
- **Prior P1/P2 corrections:** Remain specified: full debt-claim evidence, effective carried-forward assessments, valid effort fixtures, stable insertion ordering, and enforced-mode warnings on every capture path.

### Remaining directly derivable corrections
- **P1.5 — Preserve the first-review baseline assessment through the facade and index rebuild:** `BudgetSnapshotPayload` correctly records `baselineAssessment` (`208-review-budget-advisory-plan.md:731-742`), but `ReviewBudgetSnapshotRecord` omits it (`:769-780`) and the v8 snapshot index has no corresponding column (`:844-859`). Consequently, an index rebuild/read-through cannot expose the authoritative initial `I` or recompute `baselineDirection` from record data, despite Phase 8 requiring recomputation when the derived cache is absent (`:1244`). **Action: `auto_fix`.** Add the optional initial-only baseline assessment to the facade record type, index projection/schema, encode/decode/reindex path, and store/index/run-state tests; after an index wipe, assert that `I` and baseline direction recompute identically from the record line.
- **P1.6 — Repair projections on an idempotent record retry:** The plan says a successful `atomicAppend` followed by a SQLite projection failure leaves the record authoritative (`:1109-1111`), but then directs every duplicate response to skip projection (`:1101-1103`). A normal retry therefore cannot restore the missing v1 `steps` row or budget index row; it requires a later, separately implemented slice-10 index command. **Action: `auto_fix`.** On `created: false`, load the existing step/snapshot record lines and perform idempotent SQLite projection/upsert (without appending any line); retain the record-first rule and add a retry test proving the original record is not duplicated while both projections are repaired.

### Updated readiness
- **Plan completion:** ⚠️ — the P0 architecture correction and explicit prerequisite are complete, but two mechanical record-to-projection/rebuild gaps remain.
- **Ready for implementation:** ⚠️ — `ready_with_corrections`. Phases 1–3 may begin now; Phase 4 and all later persistence work remain blocked by the explicit slice-10 Phase-1 freeze and should incorporate P1.5/P1.6 before implementation.

---

## Addendum (2026-08-29) — Revision 1.4 final staff re-review

**Reviewed:** `bf54c4580112f17ad368369eebc1dcddf0c20604` | plan version 1.4

### What's addressed (✅)
- **P1.5 — Baseline-assessment reconstruction:** Resolved. The initial-only assessment now travels through the snapshot payload codec, facade type/input, nullable v8 index column, read-through, and reindex. The run-state reconstruction rule obtains `I` from the first snapshot record rather than `derived_json`, and the plan requires index-wipe coverage for identical `I` and `baselineDirection`.
- **P1.6 — Idempotent projection repair:** Resolved. The `created: false` path now reloads the durable step and snapshot lines and idempotently upserts both SQLite projections without appending a record. The required failure/retry test proves both projections recover while the record remains single-copy.
- **Prior findings:** The record-tier prerequisite, atomic record pairing, complete debt-claim evidence, carried-forward assessments, deterministic ordering, and advisory-only routing remain correctly specified.

### Remaining directly derivable correction
- **P1.7 — Make Phase 4 independently type-complete:** Phase 4 declares and tests `BudgetSnapshotPayload.baselineAssessment`, `ReviewBudgetSnapshotRecord.baselineAssessment`, and `appendSnapshot(...baselineAssessment)` (`208-review-budget-advisory-plan.md:734-823`), but `BaselineAssessment` is first declared only in Phase 5's `src/protocol.ts` changes (`:955-959`). The current repository has no such type (`src/protocol.ts:16-28`). Consequently, Phase 4 cannot meet its stated completion gate after its slice-10 prerequisite but before Phase 5 without either a missing import/type declaration or an unplanned out-of-phase protocol edit. **Action: `auto_fix`.** Define the shared structural `BaselineAssessment` type in Phase 1's review-budget domain types and have Phase 5's protocol contract import/re-export it (or move the protocol type declaration ahead of Phase 4). Update Phase 1/4 completion gates and type-level tests so the facade, record codec, and index rebuild compile and test at the end of Phase 4 without waiting for Phase 5.

### Updated readiness
- **Plan completion:** ⚠️ — P1.5 and P1.6 are fully resolved. P1.7 is a small phasing/type-ownership correction.
- **Ready for implementation:** ⚠️ — `ready_with_corrections`. Phases 1–3 may begin; Phase 4 remains subject to the explicit slice-10 Phase-1 freeze and must receive P1.7 before its completion gate can be satisfied.

---

## Addendum (2026-08-29) — Revision 1.5 post-limit staff re-review

**Reviewed:** `dc659fd` | plan version 1.5

### What's addressed (✅)
- **P1.7 — Phase 4 independent type completeness:** Resolved. `BaselineAssessment` is now declared once in Phase 1's `src/review-budget/types.ts` (`208-review-budget-advisory-plan.md:300-306`). Phase 4 explicitly imports that domain type for its record payload, facade, codec, index, and tests (`:713-932`), and its completion gate requires those units to compile without `src/protocol.ts` (`:703-707`). Phase 5 imports and re-exports the same type rather than declaring another protocol-local shape (`:937-948`). The dependency/overlap statement and type-level coverage are consistent with that ownership (`:1569`, `:1575-1579`).
- **Earlier P0/P1.1–P1.6/P2 findings:** Remain resolved in the current plan: record-tier authority and the slice-10 prerequisite, atomic snapshot/step records, projection repair after retries, complete debt evidence, carried-forward assessments, deterministic ordering, cache reconstruction, and advisory-only routing are all retained with explicit tests.

### Remaining directly derivable correction
- **P1.8 — Preserve existing record admission checks before the RecordStore atomic append:** The Phase 6 wrapper makes `RecordStore.atomicAppend([stepAppend, budgetSnapshotAppend])` the unique write (`:1131-1139`) and then treats SQLite `recordStep` as a projection. It does not specify how the current `recordStepInternal` admission checks—active-run validation, fail-closed execution-context validation, JSON validation, max-step enforcement with duplicate-at-limit behavior, and capture of record-step metadata—run before constructing that record append (`src/commands/run-v1.handler.ts:1201-1299`). Without an explicit shared prepare/admission path, an implementation can atomically append a durable reviewer step and budget snapshot for a terminal run or a new step beyond `maxStepsPerRun`; projecting it afterward cannot undo the record. The stated failure tests (`:1181-1183`, `:1530-1532`) identify the desired result but do not make the required admission ordering or reuse seam executable. **Action: `auto_fix`.** Factor/specify a shared pre-append record-admission/preparation operation used by both `recordStepInternal` and `recordPlanReviewerStepWithSnapshot`. It must perform the existing run/context/JSON/max-step/idempotency checks and assemble the complete step record before `atomicAppend`; it must preserve duplicate-at-limit as a no-op/repair path; and terminal-run, missing-worktree, invalid-result, and new-at-limit failures must call no RecordStore append and leave both record streams/index projections unchanged. Add focused wrapper tests for each condition.

### Updated readiness
- **Plan completion:** ⚠️ — P1.7 is fully resolved, but P1.8 is required to prevent the new record-authoritative path from bypassing v1 recording invariants.
- **Ready for implementation:** ⚠️ — `ready_with_corrections`. Phases 1–3 can begin under the existing slice-10 prerequisite; Phase 6 record wiring must incorporate P1.8 before implementation proceeds.

---

## Addendum (2026-08-29) — Revision 1.6 final staff re-review

**Reviewed:** `925f127dcdc2f72371773421917ae40c3242a1d0` | plan version 1.6

### What's addressed (✅)
- **P1.8 — Pre-append record admission:** Resolved. Phase 6 now defines one exported `prepareRecordStepAppend` seam in `run-v1.handler.ts` and requires both generic `recordStepInternal` and the applied reviewer snapshot wrapper to call it before any `RecordStore.atomicAppend`, SQLite step write, or budget-index upsert (`208-review-budget-advisory-plan.md:1135-1213`). Its ordered algorithm retains the current active-run and fail-closed worktree checks, best-effort `head_commit` capture, live-config max-step enforcement, JSON validation, and full record-step metadata assembly.
- **Idempotency and ceiling behavior:** Resolved. The prepare contract preserves the current rule that omitted iteration or null phase is a new record, gives a complete tuple a RecordStore-first lookup (with SQLite fallback), rejects a new record at the limit, and returns an admission duplicate at the limit for projection repair rather than appending (`:1180-1188`). The snapshot key is derived from the prepared, resolved tuple, avoiding a mismatch when iteration was omitted (`:1207-1210`).
- **No-write rejection and repair coverage:** Resolved. The wrapper explicitly performs no record append or projection mutation for terminal runs, missing worktrees, invalid JSON, unknown runs, or new-at-limit requests; it repairs projections from existing durable step/snapshot lines only for duplicate outcomes (`:1203-1211`). Focused tests require an `atomicAppend` spy and unchanged step stream, budget stream, and both projections for every rejected condition, plus both SQLite-first and RecordStore-first duplicate-at-limit cases (`:1255-1263`, `:1612-1616`).
- **Earlier findings:** P0 and P1.1–P1.7/P2 remain addressed: record-tier authority under the explicit slice-10 freeze, atomic step/snapshot persistence, projection repair, durable first-review assessment reconstruction, type ownership, complete debt evidence, carried-forward assessments, deterministic order, advisory-only routing, canonical fixtures, and enforced-mode warnings are all retained and internally consistent.

### Final assessment

No new blocking correctness, architecture, phasing, testability, risk, or scope issue was found. The plan is implementation-ready subject to its explicit prerequisite: slice 10 Phase 1 must first merge and freeze the `RecordStore` interface plus in-memory implementation with budget-stream get/list/append, insertion ordering, and all-or-nothing multi-append semantics. Phases 1–3 may start independently; Phase 4 and later remain blocked until that prerequisite is satisfied.

### Updated readiness
- **Plan completion:** ✅ — all previously raised directly derivable corrections are specified and testable.
- **Ready for implementation:** ✅ — `ready`, subject to the documented slice-10 Phase-1 prerequisite for persistence phases.
