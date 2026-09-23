# Review: Plan 209 Phase 9 — End-to-end audit, compatibility, and documentation

**Review type:** `d2c923e0709ba648db3c155fb3e44d0339fe1751` plus follow-ups `5f1a4dc` (run-record checkpoint) and `8e94541` (legacy run-state reads)
**Scope:** Phase 9 of plan 209: end-to-end governance scenarios (9.1), run-state governance read model and CLI presentation (9.2), documentation, exports, and the dashboard handoff (9.3)
**Reviewer:** Staff engineer (correctness, operability of read paths, plan compliance, test strategy)
**Local verification:** `bun run typecheck` passes. `bun test` → 3592 pass / 0 fail (230 files).

**Implementation plan:** `docs/development/plans/209-plan-review-governance-plan.md`
**Technical design:** `docs/v2/206-review-budget-governance.md`

## Summary

Phase 9 adds `buildReviewGovernanceState` and wires `review_governance` into `5x run state` for both the live-DB path and the archived/git-record path. It adds text output, a CLI end-to-end lifecycle test (initial review → author revision → addressed-only closure → pinned enforced mode survives a config change), and an index-rebuild test that restores the budget and governance projections. It also updates the docs: README, CHANGELOG, 101/202/206, the plan-07 input, and a new `10-plan-review-governance-dashboard.plan-input.md` handoff. Follow-up `8e94541` correctly keeps legacy snapshots that have no `derived` budget readable. For those it emits a diagnostic instead of throwing from `routeAfterDecision`, and a test proves the live and archived paths give the same result.

The phase's main contracts are met. I found one operability problem in the new read path. The archived branch calls `buildReviewGovernanceState` without a guard, so a malformed budget snapshot payload can crash `5x run state`. The live branch has the opposite problem: it swallows the same failure without saying anything. Both break 9.2's rule that malformed history must produce an actionable diagnostic.

**Readiness:** Ready with corrections. The remaining items are mechanical.

---

## What shipped

- **Governance read model** (`run-v1.handler.ts` `buildReviewGovernanceState`): normalized route and readiness come from the latest snapshot's reviewer step. When the latest decision targets that snapshot, the route is recomputed with `routeAfterDecision`. It also exposes the active gate (ID, snapshot, causes, `allowed_choices` that respect a pending re-estimate), governing `B`, approved scope, accepted risks, the last 10 decisions with stable IDs, and diagnostics from malformed and audit-only decisions.
- **Run-state wiring**: `review_governance` is added to the JSON output next to the plan-208 `review_budget` fields, which are unchanged. There is also a one-line text summary plus a diagnostics line.
- **CLI help**: `review gate show` and `review decide` now have descriptions, and the help text explains ID-only `--finding` and that `--input-json` is exclusive with the other flags.
- **Tests**: a new integration lifecycle test, a unit test of the read model with a malformed decision version, an index-rebuild dispatch test for `budget.jsonl` and `decisions.jsonl`, and a legacy-snapshot parity test.
- **Docs**: the implementation status, the advisory decode of pre-slice baselines, and the dashboard split are documented. The handoff names `showPlanReviewGate`, `submitPlanReviewDecision`, and `toRedactedPromptView` as the required seams.

---

## Strengths

- The read model is built only from authoritative RecordStore lines and reuses the existing fold and gate derivation (`deriveGoverningState`, `deriveOpenGate`, `allowedChoicesForGate`). The dashboard will not need to redo any of that math.
- `8e94541` handles legacy history without throwing and says so in a diagnostic. It also asserts that the live and archived envelopes are identical, which is the right invariant for a rebuildable index.
- The lifecycle test checks from the outside, through the CLI, that a later `mode = "off"` config edit cannot demote a pinned enforced baseline.
- The docs keep the handoff honest. No dashboard code is claimed, and slice 08 (implementation-review enforcement) stays explicitly out of scope.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — Governance read-model failures crash archived `run state` and are silently dropped on the live path

In the archived/git-record branch (`runV1State`, around `run-v1.handler.ts:2193`), `buildReviewGovernanceState` is called with no guard. It calls `reviewBudgetStore.latestSnapshot()`, which decodes every snapshot payload (`decodeBudgetSnapshotPayload`). `budgetDecodeError` only catches JSONL-level parse failures, not bad payloads. So a single malformed snapshot payload in an archived run makes the whole `5x run state` command throw. Before this phase, the same record fell through to `tryBuildReviewBudgetState`, which warns and omits `review_budget`.

The live branch has the reverse problem: `catch {}` (around `run-v1.handler.ts:2343`) drops any governance read-model error with no output. The comment assumes `tryBuildReviewBudgetState` will warn, but that only happens if the budget read fails the same way. A governance-only failure, such as a snapshot with a derived budget whose post-decision route fails validation, produces a state with no `review_governance` and no diagnostic. Plan 9.2 requires that malformed index/history "reports an actionable diagnostic and does not silently return an empty decision ledger".

**Recommendation:** Guard both call sites the same way `tryBuildReviewBudgetState` does. Catch the error, emit a warning such as `Unable to read review governance records for run <id>; omitting review_governance: <message>` through the existing `warn` hook, and omit the field. Add a unit or wiring test with a malformed snapshot payload on the archived path.

---

## Medium priority (P2)

- **Text `decisions=` count is capped** (`formatStateText`): the value is `latest_decisions.length`, and that list is truncated to 10 by `slice(-10)`. A run with 15 decisions shows `decisions=10`. Either print the total from the full ledger (add a `decision_count` field) or relabel it `recent_decisions=`.
- **9.1 scenario traceability**: the plan marks every 9.1 scenario `[x]` under the heading "new `test/integration/commands/plan-review-governance.test.ts`". That file only covers the first scenario and the pinned-mode part of the advisory/enforced scenario. The rest are covered by earlier-phase suites (`test/unit/review-governance/*`, `test/unit/commands/review-decision.test.ts`, `test/integration/commands/review-decision.test.ts`, `record-plan-reviewer-step.test.ts`, `atomic-append-crash.test.ts`). The suite does cover them, but the plan should say where each scenario lives so the audit trail can be checked. A short "covered by" note under 9.1 is enough.
- **Redundant fold**: both run-state branches call `deriveGoverningState` once for `governingBaseline` and again inside `buildReviewGovernanceState`. Reuse `reviewGovernance.governing_baseline` to avoid a second full decision fold per `run state`.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Guard the governance read model on both run-state paths and emit a diagnostic

**Phase completion**
- [x] 9.1 scenarios exercised across the suite (see P2 traceability note)
- [x] 9.2 run-state JSON/text governance fields, with gross forecast retained
- [ ] 9.2 malformed-history diagnostic on every path (P1.1)
- [x] 9.3 docs, exports, CLI help, config comments, dashboard handoff

This is the final phase of plan 209. After P1.1 is fixed, the plan-review governance slice is ready for production in its documented scope: plan review only, with the dashboard deferred.
