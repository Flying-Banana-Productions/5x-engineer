# Review: Phase 11 — Run-state presentation, acceptance audit and documentation (W11)

**Review type:** `0e55419da9545ca748bb39ecd51bbce2d26cdadd..8d43a294de41253bcea23e01ac5d1cb57e375e1a`
**Scope:** `implementation_governance` run-state presentation (JSON/text, local and archived git-record paths), public `src/index.ts` exports, canonical docs (206/101/202), README/CHANGELOG, input 08 metadata
**Reviewer:** Staff engineer (correctness, plan compliance, test strategy, docs accuracy)
**Local verification:** `tsc --noEmit` clean; `bun test test/unit/commands/implementation-run-state.test.ts` (3 pass), `test/unit/commands/run-state-review-budget-wiring.test.ts` (12 pass), `test/integration/commands/implementation-completion.test.ts` (9 pass). Full `bun test --concurrent` not re-run by the reviewer.

**Implementation plan:** `docs/development/plans/210-implementation-review-governance-plan.md` (Phase 11, W11)
**Governance:** advisory binding `b6177755-f899-4c4e-b94a-c70431fecf13`, review context `9b24bc7c-d437-4ed1-b374-cd6a54e5b146`. No due claims, deferrals, or waivers.

## Summary

Phase 11 adds a presentation layer over the existing readiness model. `presentImplementationGovernance` reports binding, reviewed range, active gate, latest quality attempt, per-claim status, telemetry, and separate credit fields. Both `run state` paths wire it in, and the handler-safe read/action wrappers are exported. Per-claim spendable credit uses the same `min(|measured|, effectiveApprovedMagnitude)` rule as `reconcileApprovedCredits`. Waived, not_realized, pending, future, and unassessed claims show `realizedCredit: 0` and `physicallyRealized: false`, so the core invariant holds. Plan-only output is unchanged, and an existing test confirms `implementation_governance` is omitted for those runs. The docs match the shipped contracts except for one misleading sentence about when `bind` is required. The new archived git-record presentation path and the text formatter have no tests.

**Readiness:** Ready with corrections. Two mechanical P2 items remain; there are no blockers.

---

## What shipped

- **Run-state read model** (`run-v1.handler.ts`): `ImplementationGovernanceState` extends readiness. It adds domain/phase, binding, reviewedRange, activeGate, qualityAttempt, claims (due/reconciled/measured/effective/realized/physicallyRealized/waiver), telemetry, and credit (W, B, S, E, A, provisional, realized, P). Before the first reconciliation, the credit numbers are derived from the binding.
- **Text output**: extra `Implementation binding/range/gate/quality/credit/claims` lines. Waived and not_realized claims get a `not_physically_realized` tag.
- **Archived path**: `run state --plan` without a local run now evaluates the stored boundary and presents implementation governance from the git record.
- **Exports**: `bindApprovedImplementation`, `finishImplementationCorrections`, `showReviewGate`, `submitReviewDecision`, `presentImplementationGovernance`, reconciliation/eligibility/boundary helpers and types. The SQLite constructors stay internal.
- **Docs**: 206 §5.5/§6.4/§6.5/§7 (planImpact object, text guard lineage, quality shortcut, realization semantics, pinned-mode matrix), 101 (run-state fields, implementation commands, protocol items), 202 (handoff seams, migrations v10/v11), README/CHANGELOG, input 08 marked implemented. The global advisory default is unchanged.

## Strengths

- Per-claim spendable credit follows the reconciliation arithmetic, including waivers that shrink `effectiveApprovedMagnitude`. Credit totals come from the persisted reconciliation budget snapshot rather than being recomputed.
- Presentation failure only drops the new field and warns (`tryPresentImplementationGovernance`). A read-model bug cannot break `run state` or readiness.
- The presenter is a pure function over payload arrays. It is exported, so the dashboard follow-up can reuse it without SQLite.
- Scope is disciplined: no HTTP/UI and no output normalization, and the 10/09 follow-ups are linked rather than implemented.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

### P2.1 — The 101 doc says the explicit `bind` command is required before the first admission

`docs/v1/101-cli-primitives.md` says "`bind` is required before the first implementation admission when the plan has a Delivery Budget…". But `ensureImplementationAdmission` (`src/review-governance/implementation-state.ts` ~L500–525) binds automatically when there is exactly one approved candidate. The explicit `5x review implementation bind --source-run` is only needed when there are zero or several candidates. The next clause ("a unique approved source can bind without the explicit flag") contradicts the first. An operator following the first sentence would run a redundant bind. An automation author could wrongly assume admission never binds implicitly. **Fix:** reword so that a *binding* (not the command) is required before admission, admission auto-binds a unique approved source, and `bind --source-run` resolves the zero/multiple `IMPLEMENTATION_APPROVAL_REQUIRED` case.

### P2.2 — The archived git-record presentation path and the text formatter are untested

The new ~60-line block in `runV1State` handles `--plan` with no local run. It builds evidence detection, the stored-boundary evaluation, and the presentation from `archivedBudgetStore` and the git record, and no unit or integration test runs it. The new `formatStateText` lines, including the `not_physically_realized` tag the plan requires ("never describe waived/not-realized credit as physically realized"), are also unasserted. The only text check is the absence of that tag in one integration case. A regression in either (for example a wrong store or runId, or losing the waived tag) would ship unnoticed. **Fix:** add a unit case that calls `formatStateText` with waived and not_realized claims and checks the tag and separate credit fields. Add an integration or wiring case for `run state --plan` against an archived bound run that checks `implementation_governance.domain`/`binding` is present. Follow the existing `run-state-review-budget-wiring` pattern.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [x] None

**P2**
- [ ] P2.1 Correct the `bind` requirement sentence in 101
- [ ] P2.2 Tests for the archived presentation path and text formatter

## Phase readiness

Phase 11 is the final phase. The run-state presentation, exports, and docs meet the W11 completion gate. The lifecycle acceptance coverage comes from the suites built in phases 1–10, which the W11 row explicitly relies on. The implementation is ready for production use in the default advisory mode once the two P2 corrections land.

## Nonblocking follow-ups

- The archived path evaluates `headCommit` from `projectRoot`, while the local path uses the run's effective working directory. For worktree-hosted archived runs, plan-drift readiness can differ from the local view. This is read-only and does not affect advancement; consider resolving the HEAD of the recorded worktree when it is available.
- `openImplementationGate` runs one gate derivation per phase in the phase map. That is fine at current plan sizes, but a single-pass derivation would scale better for dashboard polling.
