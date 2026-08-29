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
