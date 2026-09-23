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

---

## Addendum — Re-review at `64cfe47c5f188ae79d4c5d9e6609b05ad88f0cc7`

**Diff reviewed:** `9d74f18..64cfe47` (`fix: address plan 209 phase 9 review`) — touches `run-v1.handler.ts`, two run-state test files, and the plan's 9.1 checklist.
**Local verification:** `bun run typecheck` (`bunx --bun tsc --noEmit`) passes. `bun test` → 3593 pass / 0 fail (230 files, +1 test vs. the prior round).

### Prior findings

- **P1.1 (Guard `buildReviewGovernanceState` on both run-state paths)** — **Addressed.** A new `tryBuildReviewGovernanceState` wraps the call, warns via the existing `warn` hook with the message `Unable to read review governance records for run <id>; omitting review_governance: <message>`, and returns `undefined` on failure. Both the archived branch (`run-v1.handler.ts` around the `gitRecord` block) and the live branch now call it. Both `archivedBudgetStore.getBaseline(...)` and `reviewStore.getBaseline(...)` are also now wrapped in their own `try {} catch {}` (deferring to the budget wrapper's baseline-decode warning), closing the crash path I originally flagged for a bad baseline record, not just a bad snapshot. A new test (`run-state-review-budget-wiring.test.ts`, "live and archived run state warn and omit governance for a malformed snapshot payload") appends a malformed snapshot payload and asserts both the live and archived envelopes omit `review_governance` and both emit the expected warning. I reran this scenario path manually against the new code and confirmed the throw from `ReviewBudgetStore.listSnapshots` (used by `latestSnapshot()`, which decodes without a per-line catch, unlike `deriveOpenGate`'s defensive per-line catch) is now caught at the `buildReviewGovernanceState` boundary instead of propagating out of `run state`.
- **P2 (`decisions=` count capped at 10)** — **Addressed.** `ReviewGovernanceState` gained `decision_count: listed.decisions.length`, computed from the full ledger rather than the 10-item `latest_decisions` slice. `formatStateText` now prints `decisions=${governance.decision_count}`. The new unit test appends 15 decisions and asserts `state.decision_count === 15`, `state.latest_decisions.length === 10`, and the rendered text contains `decisions=15`.
- **P2 (9.1 scenario traceability)** — **Addressed.** The plan now has a "Covered by (audit map, in checklist order)" list under 9.1 mapping each of the 12 checklist bullets to the concrete spec files that exercise it (e.g. cross-round convergence → `review-governance/routing.test.ts` + `commands/review-decision.test.ts`). I spot-checked a few of the more surprising mappings (item 8's decision-key-wait claim against `store-index.test.ts`, item 3's critical-safety routing against `closure.test.ts`/`routing.test.ts`) and the referenced files do contain matching scenarios.
- **P2 (redundant `deriveGoverningState` fold)** — **Addressed, but see new finding P1.2 below.** Both branches now derive `governingBaseline` from `reviewGovernance?.governing_baseline` instead of a second independent `deriveGoverningState` call, exactly as recommended. This removes the duplicate fold, but it also removes the isolation that made the old `governingBaseline` computation robust to `buildReviewGovernanceState`-internal failures unrelated to the baseline fold itself — see below.

### New issue introduced by this revision

#### P1.2 — `review_budget`'s governing baseline now silently reverts to the stale per-baseline `b` on any governance-read failure, including ones unrelated to the baseline fold

**Where:** `run-v1.handler.ts`, both `runV1State` branches: `const governingBaseline = reviewGovernance?.governing_baseline;` (archived branch) and `governingBaseline = reviewGovernance?.governing_baseline;` (live branch, inside the `if (baseline)` block).

**What changed:** Before this fix, `governingBaseline` was computed by an independent call: `createReviewGovernanceStore(records).deriveGoverningState(runId, b0).governingBaseline`. That call only reads the `decisions` and `steps`/`budget` streams through `foldGoverningReviewState`, which folds defensively. It did not depend on `buildReviewGovernanceState` succeeding. Now `governingBaseline` is read off the same `reviewGovernance` object produced by `tryBuildReviewGovernanceState`, so if `buildReviewGovernanceState` throws for *any* reason, `governingBaseline` is `undefined` too — not just when the baseline fold itself is unreadable.

**Why it's a bug:** Inside `buildReviewGovernanceState`, `governing = governanceStore.deriveGoverningState(...)` (the baseline fold) is computed successfully *before* `latestSnapshot = input.reviewBudgetStore.latestSnapshot(input.runId)` is called. `ReviewBudgetStore.listSnapshots` decodes every budget-stream snapshot payload without a per-line try/catch (unlike `deriveOpenGate`, which skips malformed lines defensively). So a single malformed *later* snapshot — one that has nothing to do with the baseline or an `adjust_baseline`/`retain_baseline` decision recorded earlier — makes the whole function throw, discarding the already-computed `governing.governingBaseline` along with everything else.

Downstream, `tryBuildReviewBudgetState` computes `B: input.governingBaseline ?? baseline.b`. `baseline.b` is the value captured *at baseline-capture time* (`BudgetBaselinePayload.b`), which does not reflect any later `adjust_baseline` decision. So the failure mode is: a run has a valid `adjust_baseline` decision that changed the governing `B` in round 1; a later snapshot (round 2+) becomes corrupted or is written by a newer/older CLI version with a payload shape this version can't decode; `run state` now silently reports `review_budget.B` using the stale pre-adjustment baseline instead of either the correct governing value or an explicit omission/diagnostic. Because `review_budget` itself is still emitted (not omitted, since `tryBuildReviewBudgetState` has its own separate try/catch and the raw baseline read still succeeded), there is no diagnostic pointing at the discrepancy — the numbers are just quietly wrong. This is exactly the kind of debt/ceiling visibility the plan requires to "never hide absolute limits ... behind debt credit" and to keep "original baseline, gross effort, positive architecture burden, and debt-credit caps remain visible" (Design Decisions, plan 209) — a wrong governing baseline can under- or over-report budget-band severity.

**Reproduction sketch:** capture a baseline, record a snapshot with `adjust_baseline` decided against it (governing `B` changes), then append one more snapshot with a payload that fails `decodeBudgetSnapshotPayload` (e.g. missing a required field, or a future schema `kind`/version this build doesn't know). `5x run state` will now show the pre-adjustment `B` in `review_budget` with no warning that the governing fold was skipped, whereas before this fix it would have still shown the correctly adjusted `B` (independent of the corrupted trailing snapshot).

**Recommendation:** Don't derive `governingBaseline` from the governance read model's success/failure. Either (a) keep a small independent call to `deriveGoverningState` (as before) purely for `governingBaseline`, decoupled from `buildReviewGovernanceState`, or (b) have `buildReviewGovernanceState` compute and return `governing.governingBaseline` from a locally-scoped try/catch around only the parts that can fail (snapshot/gate/route derivation), so a failure there doesn't discard the already-successful baseline fold. Add a test with a valid `adjust_baseline` decision *and* a subsequent malformed snapshot, asserting `review_budget.B` still reflects the adjusted governing baseline (not `baseline.b`) even though `review_governance` is correctly omitted with a diagnostic.

### Updated readiness

**Readiness:** Ready with corrections — the four items from the initial review are resolved, but this revision introduces one new P1 (governing-baseline coupling regression, P1.2) that should be fixed before this is production-ready. No `human_required` items; the fix is mechanical (decouple or locally isolate the baseline fold from the rest of the governance read model, matching the pattern already used elsewhere in this file for `try {} catch {}` isolation).

---

## Addendum 2 — Re-review at `3a403f68d4c69e56b1e619191e390fdfebb94c44`

**Diff reviewed:** `042a4e3..3a403f6` (`fix: preserve governing baseline through snapshot errors`) — touches `run-v1.handler.ts` and the run-state wiring test file.
**Local verification:** `bun run typecheck` (`bunx --bun tsc --noEmit`) passes. `bun test` → 3594 pass / 0 fail (230 files, +1 test vs. the prior round).

### Prior findings

- **P1.2 (governing baseline silently reverts to stale `baseline.b` on any governance-read failure)** — **Addressed.** The fix does exactly what I recommended: `governingBaseline` is no longer read off `reviewGovernance?.governing_baseline`. A new `tryDeriveGoverningReviewState(recordStore, runId, b0, warn)` calls `deriveGoverningState` in its own isolated `try {} catch {}`, independent of snapshot/gate/route derivation, and warns (`Unable to fold review governance records for run <id>; using the captured baseline: <message>`) only if the *fold itself* fails. `governingBaseline` is now set from this independent result (`governingState?.governingBaseline`) in both the live and archived branches, and `buildReviewGovernanceState` gained an optional `governingState` parameter so the already-computed fold is reused rather than re-derived (`input.governingState ?? governanceStore.deriveGoverningState(...)`) — this also keeps my earlier "redundant fold" fix (R4/P2 from the first addendum) intact; there is still only one fold per `run state` call. A new test, "malformed later snapshot preserves adjusted governing B in live and archived state," reproduces exactly the scenario from my P1.2 write-up: an `adjust_baseline` decision changes governing `B` to 8, then a malformed trailing snapshot is appended. Both the live and archived envelopes assert `review_budget.B === 8` (the adjusted value, not the stale `baseline.b`) while `review_governance` is correctly omitted with the expected warning. I traced the code path by hand and the fix holds: `buildReviewGovernanceState` still calls `reviewBudgetStore.latestSnapshot()` unconditionally and still throws on the same malformed payload, but that throw no longer touches `governingBaseline` because it is computed and captured before `buildReviewGovernanceState` is even invoked.

### New issue introduced by this revision

#### P2 — `buildReviewBudgetState` now silently discards the entire snapshot history (not just the malformed line) on any single decode failure, with no `review_budget`-specific diagnostic

**Where:** `run-v1.handler.ts`, `buildReviewBudgetState`:
```ts
let snapshots: ReturnType<ReviewBudgetStore["listSnapshots"]> = [];
try {
	snapshots = input.store.listSnapshots(input.runId);
} catch {
	// Run-state governance reports the malformed history. Preserve baseline-only
	// budget telemetry here so a valid governing B never reverts to baseline.b.
}
```

**What changed:** Before this fix, an unhandled `listSnapshots` throw propagated out of `buildReviewBudgetState` and was caught by the existing outer wrapper `tryBuildReviewBudgetState`, which omits `review_budget` entirely and emits `Unable to read review budget records for run <id>; omitting review_budget: <message>`. Now the throw is swallowed one level in, and `review_budget` is always emitted using `snapshots = []`.

**Why it's worth flagging:** `ReviewBudgetStore.listSnapshots` decodes every budget-stream line with no per-line try/catch (unlike `deriveOpenGate`'s defensive skip-and-continue), so one malformed snapshot — even the very last one — discards every prior, perfectly valid snapshot too. With `snapshots = []`, `buildReviewBudgetState` falls into its `if (!latest)` branch and recomputes `derived` from the *current on-disk plan markdown* (or the original baseline ledger) with `findings: []` and `assessments: []`, discarding every finding/assessment/architecture-delta a real reviewer recorded across the run. `review_budget.status`/alerts/bands are then computed as if no review had ever happened, with no field-level indication that real (and possibly overage-triggering) history was dropped. The `B` value is correctly preserved via the independently-derived `governingBaseline` (per the P1.2 fix above), but `W`/`R`/`E`/`status`/alerts are not — they silently reset to a from-scratch computation.

The comment's assumption — "Run-state governance reports the malformed history" — does hold whenever a baseline exists (both call sites only reach this code path `if (baseline)`, and `buildReviewGovernanceState`'s own unconditional `latestSnapshot()` call will hit the same decode failure and produce the `omitting review_governance` diagnostic). So a caller who reads `diagnostics`/warnings will see *something* wrong. But a caller who reads only `review_budget` (a real, non-hypothetical consumer: this is precisely the field CI/enforcement tooling is meant to gate on) sees a clean, plausible-looking budget object with no marker that its `W`/`R`/`E`/status are computed from zero real findings rather than the run's actual review history. This is a smaller version of the same "silently wrong, not silently absent" failure mode P1.2 called out, now shifted from `B` (fixed) to the rest of the ledger (`W`/`R`/`E`/status/alerts).

**Recommendation:** Decode snapshots defensively and per-line inside `ReviewBudgetStore.listSnapshots` (skip a malformed line and keep the rest, mirroring `deriveOpenGate`'s pattern) so a single corrupted trailing record doesn't erase valid prior history; keep the last *decodable* snapshot as `latest` rather than falling back to a zero-snapshot state. Independently, `buildReviewBudgetState`'s catch block could emit its own diagnostic (via a return field or by having the caller compare `snapshots.length` against a raw line count) rather than relying solely on the co-located `review_governance` diagnostic to carry the signal. Add a test asserting that when a *trailing* snapshot is malformed but earlier snapshots are valid, `review_budget` still reflects the last valid snapshot's `W`/`R`/`E`/status rather than resetting to zero findings.

### Updated readiness

**Readiness:** Ready with corrections. P1.2 — the blocking issue from the previous round — is fully and correctly resolved, confirmed by a targeted regression test, with typecheck and the full suite (3594/0) passing. The one new item (silent snapshot-history loss beyond `B`) is P2: it requires the same kind of data corruption as P1.2 to trigger, `B` itself (the field the plan explicitly calls a hard limit) is now correctly preserved, and a parallel diagnostic already fires in the common case. It does not block sign-off for this phase but should be tracked as a follow-up hardening item. No `human_required` items; the fix (defensive per-line snapshot decoding, matching the existing `deriveOpenGate` pattern in the same module) is derivable from the codebase.

---

## Addendum 3 — Re-review at `967ddeea6974c665cb15a71c95478475ce3e74f8`

**Diff reviewed:** `a594742..967ddee` (`fix: preserve valid review budget snapshots`) — touches `run-v1.handler.ts`, `control-plane/review-budget-store.ts`, and the run-state wiring test file.
**Local verification:** `bun run typecheck` (`bunx --bun tsc --noEmit`) passes. `bun test` → 3595 pass / 0 fail (230 files, +1 test vs. the prior round).

### Prior findings

- **Addendum 2's P2 (`buildReviewBudgetState` discards the entire snapshot history, not just the malformed line, on any single decode failure)** — **Addressed, and more thoroughly than requested.** Rather than patching `buildReviewBudgetState`'s local catch, the fix moves the defensive handling into `ReviewBudgetStore.listSnapshots` itself (`control-plane/review-budget-store.ts`): each budget-stream line is now decoded in its own `try {}` inside a `for` loop, and a line that fails `snapshotRecord(...)` is skipped individually via `reportCorruptSnapshot(...)` rather than aborting the whole scan — exactly the `deriveOpenGate`-style per-line pattern I recommended. Because the fix lives in the shared store rather than only in the `run state` presentation layer, `buildReviewBudgetState`'s own local `try/catch` (which caused the P2) could be, and was, removed entirely — `listSnapshots` no longer throws for a single bad record, so there is nothing left for that call site to catch. `reportCorruptSnapshot` also emits an actionable diagnostic exactly once per malformed `idempotencyKey` (deduped via a `Set` closed over the store instance): `Skipping malformed review budget snapshot record <key> for run <id>; repair or remove this record. Earlier valid snapshots remain in use. Cause: <message>`. Both `run-v1.handler.ts` call sites (`archivedBudgetStore`, `reviewStore`) now pass `warn` as the store's `onDiagnostic` callback, so this diagnostic surfaces through the existing warning channel on both the live and archived `run state` paths. I confirmed the caching logic in `listSnapshots` was updated consistently: the cache-validity comparison now reuses the already-decoded `record` from the same per-line loop instead of re-decoding `snapshots[position]?.line.payload` unconditionally (which is what previously made even the cache-hit path throw on a corrupt line) — so a corrupt trailing record can no longer poison either the fresh-scan path or the cached-read path.

  Three of the tests updated for this fix now assert the *positive* outcome directly: the two previously-passing "malformed snapshot" tests were rewritten from "review_governance is omitted" to "review_governance is preserved with the correct `governing_baseline`," and a new test, "malformed trailing snapshot preserves the last valid findings ledger," appends a real finding-bearing snapshot, captures `review_budget` (`R: 2`, `P: 1`), appends a corrupt trailing snapshot, and asserts `review_budget` is byte-for-byte unchanged (`toEqual`) in both the live and archived paths, with the new "repair or remove this record" diagnostic present. This is precisely the regression test I asked for, and it passes.

### New issue found in this revision

#### P2 — The enforcement path (`protocol validate --record`, `review decide`, and other `composePlanReviewerRecord` callers) does not wire the new corrupt-snapshot diagnostic, unlike `run state`

**Where:** `src/commands/review-budget-context.ts`, `createReviewBudgetContext`:
```ts
store: createReviewBudgetStore(
	record.recordStore,
	createReviewBudgetIndex(record.db),
),
```
This is the only production call site of `createReviewBudgetContext` (`src/commands/review.ts:38`, backing `review gate show` / `review decide`), and it is also the context type (`ReviewBudgetCommandContext`) that `protocol.handler.ts` and `invoke.handler.ts` build via the same `contextFactory` before calling `composePlanReviewerRecord` — the actual enforcement path that applies the plan-208 budget and plan-209 governance routing on every recorded reviewer step.

**What's missing:** `createReviewBudgetStore` gained a third, optional `onDiagnostic` parameter in this commit, and both `run-v1.handler.ts` call sites (used only by the read-only `run state` presentation layer) now pass `warn`. `createReviewBudgetContext` was not updated to accept or forward a diagnostic callback, so its `store` is built with `onDiagnostic` left `undefined` — meaning `reportCorruptSnapshot`'s early `if (!onDiagnostic ...) return;` guard silently discards the diagnostic for every caller that goes through `createReviewBudgetContext`. Concretely: `protocol.handler.ts` already has a `warn` function in scope at the exact call site that constructs this context (`params.warn ?? ((message) => console.error(...))`, used a few lines later for `composePlanReviewerRecord`'s own `warn` field) — it is simply not threaded into `contextFactory({...})`. The underlying correctness fix (a corrupt trailing snapshot no longer throws or discards valid history) still applies here too, since it lives in the shared `ReviewBudgetStore.listSnapshots` implementation — so `protocol validate --record` and `review decide` will not crash or silently lose ledger data on a corrupt record. What's missing is only the operator-facing signal: an operator running the actual enforcement commands against a run with a corrupted snapshot gets no indication that a record needs repair, while an operator running `run state` on the same run does.

**Recommendation:** Add an optional `warn`/`onDiagnostic` parameter to `createReviewBudgetContext` (and to `ReviewBudgetCommandContext` if diagnostics need to flow further, matching the existing `warn: (message: string) => void` field already present on sibling input types in this same file, e.g. `composePlanReviewerRecord`'s `warn` parameter) and pass it through to `createReviewBudgetStore(...)`. Wire the existing `params.warn ?? ((message) => console.error(...))` fallback already computed in `protocol.handler.ts` (and the equivalent in `invoke.handler.ts`) into the `contextFactory({...})` call. Add a test mirroring the new `run-state-review-budget-wiring.test.ts` corrupt-snapshot cases, but through `createReviewBudgetContext`/`composePlanReviewerRecord`, asserting the same diagnostic fires.

### Updated readiness

**Readiness:** Ready with corrections. All prior blocking and P2 findings through Addendum 2 are now fully resolved, with regression tests that reproduce each originally-reported scenario and typecheck/full suite passing (3595/0). The one new item is a P2 operability gap (incomplete diagnostic wiring outside `run state`), not a correctness regression — the shared decode fix already protects the enforcement path from crashing or losing data; only the diagnostic surfacing is missing there. No `human_required` items; the fix is a mechanical, same-pattern extension of what this commit already did for `run-v1.handler.ts`.
