# Review: Review Budget Inspection — Implementation Plan 214

**Review type:** `5x-cli/docs/development/plans/214-review-budget-inspection-plan.md`
**Scope:** `review budget show` / `review budget history` read-only inspection, as-of governance state, renderers, CLI integration, and gated 210 consumer adapter
**Reviewer:** Staff engineer (correctness, architecture reuse, read-only guarantees, delivery budget)
**Local verification:** Not run (static review). Dependency source inspected read-only at `38f348e` in `.5x/worktrees/209-plan-review-governance-plan-68d554`.

**Implementation plan:** `5x-cli/docs/development/plans/214-review-budget-inspection-plan.md`
**Technical design:** `5x-cli/docs/v2/209-review-budget-inspection.md`

## Summary

This is a careful plan. It is grounded in the real 209 seams, separates historical state from current actionability, avoids `showPlanReviewGate` side effects, and has a strong read-only and pagination test strategy. It still has two technical gaps and one scope problem. The plan says to reuse canonical arithmetic, but the helpers it names cannot produce budgets for archived or rebuilt-index snapshots without a new copy of the input assembly. Its linear-fold requirement also conflicts with the existing acceptance helpers, which rescan every stream. Finally, Phase 6 depends on plan 210, which is not implemented. That phase sits in this plan's scored, sequential scope even though the design requirements never ask for it.

**Readiness:** Not ready. The Phase 6 scope/sequencing question needs a human decision. The two technical gaps can be fixed mechanically.

---

## Strengths

- **Accurate seam inventory.** The claims I checked match the code at `38f348e`. `routeAfterDecision` returns only a route. `loadGitRecordForPlan` loads every run for a plan and picks the latest one. `showPlanReviewGate` repairs prompts. Acceptance uses step insertion order.
- **The historical-vs-actionable split is correct.** Latest, enforced, nonterminal, and canonically unresolved must all hold before a gate is actionable. Neither `requiresHuman` nor `deriveOpenGate` alone is enough. This directly meets design §6.2.
- **Honest incompleteness.** Legacy rows stay visible with unavailable evidence, no fingerprints are synthesized, and a missing snapshot never falls back to latest. A corrupt baseline is treated as corruption, not as absence.
- **Strong no-write acceptance.** Byte-identical streams, prompt rows checked before and after (including a gate with missing notifications), and wiped-index parity.
- **Stable cursor design.** Event IDs are opaque, versioned, and built from durable IDs. Ordering comes from paired steps, not timestamps.

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1: Phase 6 (W6) depends on unimplemented plan 210 but sits in this plan's scored, sequential scope

**Risk:** The design requirements (`docs/v2/209-review-budget-inspection.md`) never mention 210 or an implementation domain. Plan 210 is approved but not implemented. Phase 6 says "Block this phase if only approved plan text exists" and "leave Phase 6 unchecked" when 210 is absent. A phase-sequential implementation run would reach Phase 6 after Phase 5 and stall. The run could not complete, or it would need an ad-hoc human gate in the middle of implementation. W6 (effort 3, architecture +1) is also counted in the governing baseline B=22, yet it is estimated against interfaces that do not exist yet (`implementation-state.ts`, `credit-reconciliation.ts`, and the others). That makes both the estimate and the architecture burden unverifiable.

**Requirement:** Every phase in this plan must be completable when the plan runs, or the plan must explicitly exclude it from this run's completion criteria and budget.

**Options (human decision):** (a) Move Phase 6 and W6 to a follow-up plan, or into 210's own consumer work, triggered when 210 integrates. Keep Phase 5's `BUDGET_INSPECTION_UNSUPPORTED` guard as the forward-compatibility contract. (b) Keep Phase 6, but add an explicit, orchestrator-visible deferral/skip condition and state how its budget points are treated if it is not executed.

### P1.2: Reconstructing a snapshot's budget has no canonical helper, and `routeAfterDecision` requires the nullable `snapshot.derived`

**Risk:** `routeAfterDecision` (`routing.ts:366–409`) takes its base `budget` (and so `B0`, `I` and `thresholds`, which `deriveEnforced` reads from it) from `latestBudgetSnapshot.derived`. It throws when that value is null. The plan itself says `derived` is a projection value that is null after a rebuild. `snapshotRecord(payload, derived ?? null)` confirms this, and archived memory-store reads also leave it null. Phase 2 says to "extract a pure effective-state result" with the wrapper keeping parity, but it never says where that base budget comes from.

The per-snapshot `deriveBudget` inputs are already assembled in two places:

- `review-budget/apply.ts:337–351`: governing `B` at review time, `I` from the first `baselineAssessment`, `baseline.configSnapshot`, and `semanticHumanRequired` from the paired verdict's `human_required` items.
- `run-v1.handler.ts:1205–1236`: an approximation of the same, with `semanticHumanRequired` supplied by a callback.

Inspection would become a third copy. That violates the plan's own "no copied formulas" rule. If `semanticHumanRequired` or the as-of governing `B` is missed, `requiresHuman`/alerts will differ from the recorded decoration. Wiped-index or archived output would then disagree with live output, or the call would throw.

**Requirement:** Phase 2 should name one shared pure helper that builds the recorded review's budget inputs from baseline, the snapshot prefix, the paired verdict, and the governing baseline at the boundary. The effective-state helper should accept that base budget explicitly, not read `snapshot.derived`. `routeAfterDecision` should stay a wrapper that keeps its current behavior. Add a unit test in which a snapshot with `derived: null` reconstructs to the same values as the recorded step's `budget` decoration, including `semanticHumanRequired`. Update Files Touched and the Surface Snapshot if the helper lands in an existing module such as `review-budget/apply.ts`.

### P1.3: The "fold each stream once / linear operation-count" gate conflicts with reusing the existing acceptance and fold helpers

**Risk:** `classifyDecisionAcceptance` (`decisions.ts:244–331`) decodes the whole `budget` stream and scans the whole `steps` stream for every decision. `foldGoverningReviewState` calls it for each decision. Phase 2 requires "slice ... at each requested boundary before the canonical fold" and reuse of the existing acceptance helpers. It also requires "read/fold each stream once per request" and a long-history operation-count regression. Folding every history event's prefix with the current helpers costs O(events × decisions × (steps + budget)). An implementer must either fail the regression gate or rewrite acceptance and fold logic privately, which violates "no second policy engine".

**Requirement:** State the mechanism. Acceptance depends only on steps up to the human step, so it is the same for every prefix that contains the decision. Extract variants of the classify and fold helpers that take a pre-decoded snapshot index and precomputed step positions. Keep the existing exported functions as wrappers with parity tests. Then fold prefixes incrementally in one ordered pass. List `decisions.ts` as a touched production file.

---

## Medium priority (P2)

None blocking. See the non-blocking follow-ups.

---

## Nonblocking follow-ups

- **Line-reference drift:** `loadGitRecordForPlan` is at `run-v1.handler.ts:1963`. The cited `2137–2350` range is the `runV1State` `--plan` archived caller. Update the reference so extraction targets the right function.
- **Archived lookup without a control plane:** The existing `review.ts` `contextFor` and `requireAmbientRunId` require a control-plane DB (`NO_CONTROL_PLANE`). The new handlers should not reuse `contextFor`. When there is no DB, explicit `--run` should still resolve archived records, or fail with a documented error.
- **Run-ID-only archived discovery ref selection:** `resolvePlanProgress` chooses the commit/ref per plan. When only a run ID is given, spell out which refs are searched (working tree, plans branch, HEAD) before the plan slug is known, and how that matches the existing divergence rules.
- **`foldGoverningReviewState` seeds `governingBaseline` from `b0`:** Keep the display of "original baseline" (B0) consistent with the capture's `b` where the two can differ.

---

## Delivery budget assessment

- Independent estimate: **24** (medium confidence). W1–W5 look plausible at 19 as scored. W1 is somewhat light, because `loadGitRecordForPlan` must be restructured to select by path before decoding and archived run-ID discovery across plans is new. P1.2 and P1.3 each add about 1 point of shared-helper extraction and parity tests. W6's 3 points are unverifiable until 210 exists and are probably light for the cross-domain realization and decision mapping described.
- The ledger IDs (W1–W6) are stable. The `Addresses` column is empty (this is an initial plan). There are no debt claims or negative architecture rows, so no credit assessments are required.

---

## Readiness checklist

**P1 recommended**
- [x] P1.1: Decide Phase 6 / W6 placement (split out, or add an explicit deferral mechanism and budget treatment).
- [x] P1.2: Name a shared per-snapshot budget-input helper; the effective-state helper takes an explicit base budget; add a null-`derived` parity test.
- [x] P1.3: Specify extracted acceptance/fold variants that allow a single-pass incremental fold; add `decisions.ts` to Files Touched.

---

## Addendum (2026-09-23) — Closure review of v1.1

**Reviewed:** `536e912e0838fa3c79280eeebe574f649245c7f7` (plan v1.1), against prior review commit `d04d85cb302b3ed3565b736e17ae7bc55ee340e0`.

### What's addressed (✅)

- **P1.1 — Phase 6/W6 vs. unimplemented 210.** The revision resolves this through a documented human scope decision (`3fe3acb7-ec66-47e0-8e28-4420242c2ccb`): completed and integrated 210 is now a mandatory **pre-start gate**, before Phase 1 begins, not a mid-run condition reached after Phase 5. The Executive Summary, Scope, Key Design Decisions, Prerequisites, every phase's completion gate, Timeline, and Provenance were all updated consistently to "210, then 214; all six phases required for one release." This eliminates the original failure mode (a phase-sequential run stalling mid-execution at Phase 6) by moving the blocking check to before any implementation starts, which is a different but equally valid resolution than my suggested "split Phase 6 into a follow-up plan." W6's effort/architecture score is unchanged (3/1) with a rationale explaining the estimate still stands because pre-start verification, not Phase 6 itself, absorbs the discovery risk. This is a legitimate scope decision, consistently threaded through the document. **Addressed.**
- **P1.2 — No canonical per-snapshot budget reconstruction.** The revision adds a new design decision ("One canonical recorded-budget reconstruction, explicit base budget") naming `deriveRecordedReviewBudget` and its lower-level input assembler `buildRecordedReviewBudgetInput` in `review-budget/apply.ts`, extracted from the existing assembly I verified at `apply.ts:335–375`. It explicitly states inspection "ignores cached `snapshot.derived` as authority" and passes a reconstructed `baseBudget` explicitly into the extracted `deriveEffectivePlanReviewState` helper in routing, while `routeAfterDecision` remains an unchanged compatibility wrapper (including its existing null-derived `TypeError`) that inspection never calls. The new "Shared canonical helper contracts (W2)" section gives concrete signatures, and Phase 2's checklist adds a bullet requiring tests with `derived: null` that assert parity with recorded decoration, including `I`, `B`, thresholds, and `semanticHumanRequired`-driven `requiresHuman`. Files Touched now lists `apply.ts`, `decisions.ts`, and the run-state reconstruction range (`run-v1.handler.ts:1205–1236`, which I confirmed is the actual `deriveBudget` reconstruction block) under W2, and a new test row covers reconstruction parity. I independently verified `buildRecordedReviewBudgetInput`'s explicit `semanticHumanRequired: boolean` parameter correctly lets the existing run-state callback (which has no `ReviewerVerdict`, only a boolean-producing callback) reuse the same assembler without fabricating verdict items — this closes a gap I would otherwise have raised. **Addressed.**
- **P1.3 — Linear-fold gate vs. rescanning acceptance/fold helpers.** The revision adds a new design decision ("Canonical indexed acceptance and incremental fold") naming `buildDecisionAcceptanceIndex`, `classifyDecisionAcceptanceIndexed`, and an incremental `createGoverningReviewFold` accumulator, all inside `review-governance/decisions.ts` — the canonical module, not an inspection-local copy. The existing `classifyDecisionAcceptance` and `foldGoverningReviewState` (which I confirmed at `decisions.ts:244–331` and `333–409` compute the superseded-set and per-decision acceptance by rescanning the full steps/budget streams) become parity-tested wrappers over the indexed versions. The plan correctly identifies and specifies the two tricky invariants in the current `foldGoverningReviewState` that an incremental version must preserve: (a) an accepted superseder's suppression of its target holds even if that superseder is itself later superseded, and (b) a superseding reference to a not-yet-included target must be retained rather than dropped. Phase 2's checklist and test bullets require measuring "one budget decode/step-position scan and one acceptance classification per decision, no per-event prefix replay," separately from materialization cost, plus a decision-stream-order-vs-human-step-order test. Files Touched adds `decisions.ts` under W2 with a corresponding test row. **Addressed.**

### Verification notes

I independently re-read the current dependency source at `38f348e` (`.5x/worktrees/209-plan-review-governance-plan-68d554`) to check the revision's new citations rather than taking them at face value:
- `collectCandidateTips` exists at `src/records/resolve.ts:253`, matching the plan's new `records/resolve.ts:253–358` citation for ref discovery (local `5x/*`, remote-tracking `*/5x/*`, `plansBranch`, `HEAD`).
- `run-v1.handler.ts:1205–1236` is indeed the `deriveBudget` reconstruction block inside `buildReviewBudgetState`, confirming the plan's new W2 file citation.
- `review.ts`'s `contextFor` does require a control-plane DB (`resolveDbContext` + `NO_CONTROL_PLANE`), confirming the new Phase 1 bullet's premise that it must not be reused for archived-only inspection.
- `foldGoverningReviewState`'s current supersession handling (`superseded` computed once over the full decision list before folding in list order) matches the plan's description and the incremental design's stated invariants are consistent with preserving that behavior per-prefix.

No revision-introduced blocker was found. The diff is entirely consistent, self-referential (every touched section — summary, scope, key decisions, prerequisites, phases, timeline, provenance, files touched, tests — was updated in lockstep), and grounded in verified line numbers and function names rather than aspirational reuse claims.

### Nonblocking follow-ups carried over (not required for closure)

The revision also incidentally resolved three of my four prior nonblocking notes: the `loadGitRecordForPlan` line-reference drift is corrected to `1963–2103`; the no-control-plane archived lookup gap now has an explicit Phase 1 bullet (`RUN_NOT_FOUND` / `RUN_CONTEXT_REQUIRED`); and ref-selection specifics are now spelled out via `collectCandidateTips`. A new design decision ("Original, captured and governing baselines are distinct provenance") also addresses the `b0`/`b` seeding note. None of this was required for closure since these were nonblocking in the initial review, but it is worth recording that the revision's scope exceeded the strict minimum needed to close P1.1–P1.3.

### Updated readiness

- **Plan v1.1 completion:** ✅ — all three required prior findings (P1.1, P1.2, P1.3) are addressed with concrete, code-verified mechanisms; no new blocking issue was introduced by this revision.
- **Ready for next phase:** ✅ — ready for implementation as revised.
