# Review: Plan-Review Governance — Closure Reviews, Enforced Routing, and Durable Decisions

**Review type:** `docs/development/plans/209-plan-review-governance-plan.md` (v1.0)
**Scope:** Initial (exhaustive) plan review of slice 07 — closure-review protocol, plan-diff evidence validation, enforced routing, durable human decisions/gates, prompt context injection, skills/templates, and dashboard governance surfaces.
**Reviewer:** Staff engineer (correctness, concurrency/durability, protocol compatibility, phasing, delivery budget)
**Local verification:** Not run (static review). Claims checked against `main` @ `35e2ef8` and the code-complete, unmerged plan-208 branch `5x/208-review-budget-advisory-plan` @ `cd7ee88`.

**Implementation plan:** `docs/development/plans/209-plan-review-governance-plan.md`
**Technical design:** `docs/v2/206-review-budget-governance.md`, `docs/v2/202-control-plane.md`, `docs/v2/plan-inputs/07-plan-review-governance.plan-input.md`

## Summary

The plan is a faithful, well-layered translation of `206` §5–§6.5 into a pure policy core (`validateClosureReview` → `derivePlanReviewGovernance`), an append-only decision fold, and thin command/skill/dashboard adapters. The separation of validation, derivation, and orchestration is right, and the "CLI derives one route" rule is preserved throughout.

It is not ready. Four gaps break the central enforced path rather than edge cases: (1) Phase 8 is specified against a dashboard slice that has no plan, no code, and no contracts; (2) the gate CAS is keyed by a per-submission `decisionId`, so two racing submitters both win; (3) gate causes that a human has already resolved (baseline dispute, approved architecture burden) are re-derived on every later snapshot and will re-gate every round; (4) prior-finding outcomes have no wire representation that is compatible with plan 208's `R` arithmetic or with `protocol emit`'s "items imply corrections" rule, so an all-addressed closure review cannot be `ready`. Two items need a human decision; the rest have a single derivable fix.

**Readiness:** Not ready — two human scope/policy decisions (P0.1, P1.1) plus three mechanical P0 contract corrections.

---

## Strengths

- **Correct ownership boundary.** Reviewers emit item-level evidence only; route, normalized readiness, and gate causes are CLI-derived and rejected as reviewer-authored keys, extending plan 208's `CLI_OWNED_VERDICT_KEYS` pattern rather than inventing a second one.
- **Records stay authoritative.** Decisions as immutable lines in the existing `decisions` stream with a deterministic insertion-order fold and a rebuildable SQLite projection matches `207`/plan-208 conventions (`record_seq` ordering, no SQLite-only authority, handlers never import `bun:sqlite`).
- **Pure core first.** Phases 1 and 4 are pure and gate on "no handler/SQLite/git imports", which makes the routing matrix cheaply and exhaustively testable before any I/O is wired.
- **Plan-only diff as the evidence domain.** Reusing the `resolveReviewDelta` plan-file diff (not the repo diff) and tolerating a later review-artifact-only commit is the right call; the prior reviewer step's `head_commit` already includes the review-doc commit.
- **Fail-closed, no-write-on-failure discipline** is stated consistently for validation, admission, and gate creation, and mirrors plan 208's paired-write seam.
- **Scope fences are explicit.** Implementation-review governance, realized credit, and default-mode change are cleanly excluded.

---

## Production readiness blockers

### P0.1 — Phase 8 (W8) is planned against a prerequisite that has no plan or contracts *(human_required)*

**Risk:** `docs/v2/plan-inputs/04-control-plane-dashboard.plan-input.md` is `draft` with `Generated plan: -`; there is no `src/dashboard/`, no server, no auth middleware, no WS protocol, no browser test harness. Phase 8 therefore has no concrete file paths, no verifiable completion gate ("prerequisite server/browser test suites"), and its 8-point W8 estimate is frozen into `B0 = 52` as pure uncertainty. Phases 5.3 and 9.1 also assert dashboard/terminal parity that cannot be built or tested. Approving this plan approves a phase nobody can review for correctness, and the plan itself says it must be revised once slice 04 lands.

**Requirement:** A human chooses one of:
1. **Split (recommended, lowest cost):** move Phase 8, the dashboard rows of §5.3/§9.1, W8, and `src/dashboard/**`/`test/integration/dashboard/**` into a follow-on plan generated after slice 04 merges. Keep in this plan only the dashboard-ready seams that are already required for CLI use: `submitPlanReviewDecision` as an exported handler with actor/origin input, the read-model projection, and the typed prompt context on the (already merged, slice 205) `PromptStore`. Slice 07's plan-input exit criteria would then be met across two plans.
2. **Hold:** keep the plan whole and blocked until slice 04 has a merged plan and implementation, then re-plan Phase 8 with real paths and gates before approval.

**Implementation guidance:** Everything except Phase 8 depends only on plan 208 (code-complete on its branch) and slice 205's prompt queue (merged). Option 1 unblocks ~44 of 52 points as soon as 208 merges.

### P0.2 — Gate resolution CAS is keyed per submission, so concurrent submitters both append a decision *(auto_fix)*

**Risk:** §2.1 uses idempotency key `decision:review:<decisionId>` with a fresh UUID per submission. A terminal process and the dashboard server are separate processes; "verify the prompt is open, the gate is unresolved, the forecast is current, then append" (§Design, §5.2) is check-then-act across two stores (SQLite `PromptStore` and JSONL `RecordStore`) with no shared lock. Two racers generate different `decisionId`s, both pass the checks, and both appends succeed — two unsuperseded, possibly contradictory decisions for one gate. This violates the Phase 5 gate ("the winner appends one decision/human step, losers observe it") and the plan's own "reject contradictory unsuperseded changes" rule. The plan also leaves the write order and the "dedicated all-new gate resolution operation" conditional ("if the merged store cannot couple…"). It cannot: `PromptStore.answerPrompt` and `RecordStore` are different stores, and `PromptRecord.answer` is a single string with no structured payload to replay from.

**Requirement:** Make the record store the single CAS authority:
- The gate-resolving decision line uses a **gate-scoped** key, `decision:review-gate:<gateId>`, and is written with the human step in one `RecordStore.atomicAppendIfAllNew([humanStep, decision])` (plan 208's all-new-or-no-op primitive, which already serializes under the per-run store lock). `created: false` ⇒ load and return the winner; compare payload to return `created:false` (same payload) or `REVIEW_GATE_ALREADY_RESOLVED` (different payload).
- Records first, prompt second: after a durable append, answer/close the typed prompt as a best-effort projection. A crash between the two leaves a decision with an open prompt; repair closes the prompt from the record. Delete the "repairable answered prompt" direction and the `expected latest decision sequence` field — neither is needed.
- Later corrections keep `decision:review:<decisionId>` + `supersedesDecisionId`.
- Add the cross-process race test to `store-contract.test.ts` (two facades over one working-tree store) rather than only in-process.

### P0.3 — Human-resolved gate causes are re-derived every round and will re-open the gate indefinitely *(auto_fix)*

**Risk:** In plan 208's `deriveBudget`, `baseline_disputed` is computed on **every** snapshot from immutable `I` vs immutable `B0`, and `positive_architecture_exceeded` from cumulative `P`; both set `requiresHuman`. §4.1 precedence step 2 routes any such alert to `human_gate`, and step 1 only removes accepted-risk *findings*. After a human answers `retain_baseline`/`adjust_baseline`/`request_author_reestimate` or `approve_architecture_burden`, the very next closure review re-derives the same alert and opens a new gate (new `forecastId` ⇒ new gate key). Enforced runs with a baseline dispute can never converge without a human click per round.

**Requirement:** Add an explicit precedence step and matrix rows: *drop gate causes covered by an active, unsuperseded decision in `GoverningReviewState`*.
- `baseline_disputed`: resolved for the run once any retain/adjust/re-estimate decision exists (`I` and `B0` never change).
- `positive_architecture_exceeded`: suppressed while current `P` and the set of single items ≥ `singleArchitectureReviewPoints` are within what `architectureApprovals` recorded (`approvedP`, approved item/work-item IDs); re-gate only on growth beyond the approval.
- Budget bands: always evaluated against folded governing `B` (see P1.6), never suppressed.
- The reported `budget` decoration stays unmodified (alerts remain visible); only `gateCauses`/`route` honor the decision. Record `resolvedBy: decisionId` on suppressed causes for audit.

### P0.4 — Prior-finding outcomes have no workable wire representation *(auto_fix)*

**Risk:** §3.1 puts `priorFindingStatus` on `VerdictItem` and §3.1's last bullet forbids new emit flags, so closure outcomes must travel inside `items[]`. That collides with three existing contracts:
- `protocol emit reviewer`: `--ready` with any item becomes `ready_with_corrections` (`src/commands/protocol-emit.handler.ts:135–140`), so a closure review that marks every prior finding `addressed` can never emit `ready`; §9.1's "closure statuses → ready completion" is unreachable.
- Plan 208 arithmetic: `computePendingR` sums `effortDelta` of **every item in the current verdict** ("Every input finding is still listed in the current verdict"). `addressed` entries in `items[]` re-enter `R` and `P`.
- Advisory/v1 routing reads `items[]` actions; addressed entries would be handed to the author as fresh `auto_fix` work.

It is also unspecified which prior findings require an outcome (every prior item ever, or only unresolved ones, and whether deferred/accepted findings count).

**Requirement:** Define a separate top-level closure array and keep `items[]` strictly "still-blocking routing input":
- `ReviewerVerdict.priorFindings?: Array<{ id: string; status: PriorFindingStatus }>` with a repeatable `--prior-finding '<json>'` emit flag; remove `priorFindingStatus` from `VerdictItem`.
- Required-outcome set = items from earlier recorded plan-review verdicts whose last status is not `addressed` and that are not covered by an active defer/accept decision.
- `partially_addressed` / `still_open` findings must also appear in `items[]` under the **same ID** with their remaining `effortDelta` (this is what `206` §6.1 means by "re-enters `R`"); `addressed` must not. Validation rejects mismatches in either direction.
- `items[]` entries that are neither carried prior IDs nor prior-decision re-raises are "new" and need `introducedBy` or `lateDiscovery`.
- Add `priorFindings` to the closure template, the snapshot payload extension (§6.1), and the emit/validate tests; assert `--ready` + only-`addressed` outcomes ⇒ `ready`.

---

## High priority (P1)

### P1.1 — Decide whether closure convergence is enforced in advisory mode *(human_required)*

§3.3 runs fail-closed `validateClosureReview` on all "active budget runs", which includes the **default** advisory mode, and Phase 7 rewrites the single continued-review template for everyone. In effect, default-mode users get the convergence policy enforced (ordinary missed issues rejected from `items[]`, verdicts refused without `introducedBy`) even though only *routing* is nominally unchanged. `206` §7 says advisory "does not change routing" and §8.2 lists "convergence routing in the protocol/skill layer" under the *Enforced* stage; the plan-input assumes "enforced behavior is opt-in during this slice". The plan's own Key Decision ("Advisory mode computes governance but does not route on it") and §9.1 ("advisory … follows old route") do not settle whether rejecting a verdict counts.

Options: **(a)** advisory validates structure but downgrades closure-evidence violations to recorded diagnostics/hypothetical outcomes, with mode-conditional template prose (recommended; preserves the calibration purpose of advisory); **(b)** closure convergence applies in advisory as written, and the docs/CHANGELOG say so explicitly as a default-behavior change. Either way, state what happens when `mode` changes between rounds of one run (mode is live config today; plan 208's baseline `configSnapshot` deliberately omits it).

### P1.2 — Human decisions never reach the plan author *(auto_fix)*

`trade_scope`, `defer_accept_risk`, and `request_author_reestimate` all "return to author revision", but `author-process-plan-review.md` receives only `review_path`, `plan_path`, `user_notes`, `run_id` and instructs the author to address the review document's items. Nothing tells the author that P1.2 was deferred (do **not** implement it), which scope was removed, or that a re-estimate was requested. The decision would be durable and ignored; the deferred effort lands in `W` anyway. Phase 7 and Files Touched omit the author template.

Fix: reuse the §6.3 projection to append a "Governing decisions" block (deferred/accepted finding IDs to skip, retained/removed scope, re-estimate request, governing `B`) to `author-process-plan-review` renders in both native and invoke paths; add the template to Phase 7/Files Touched and a render test. Do not tunnel this through free-text `user_notes`.

### P1.3 — The rendered plan diff is truncated at 200 lines; "exact diff shown" validation breaks on real revisions *(auto_fix)*

`getFileDiffSummary` (`src/git.ts:205–224`) caps the appended diff at 200 lines. Revisions of plans this size routinely exceed that. §3.2 validates against "the rendered context" and lists "oversized diff rejection", which means a genuine regression introduced at diff line 250 can never be cited: the verdict fails closed, nothing is recorded, and the reviewer has no legal way to block on it.

Fix: `buildPlanReviewDiffContext` always computes the **full** plan-only patch and hunk hashes; validation matches against that. Truncation becomes a Markdown-rendering concern only, and a truncated render must list the commit range plus remaining hunk headers (or the exact `git diff` command) so the reviewer can read the rest. Replace "oversized diff rejection" with this behavior; keep binary rejection. Because hunks are LLM-transcribed through shell-quoted `--item` JSON, make `INTRODUCED_HUNK_NOT_FOUND` diagnostics name the closest hunk header so a retry is cheap.

### P1.4 — Gate identity and authority are ambiguous; gates are not rebuildable as written *(auto_fix)*

§2.2 gives each gate a random UUID and a mutable `state (open|resolved|superseded)`, says open state lives in the coordination store, yet §2.3 calls `review_gate_index` rebuildable from records and the architecture diagram lists no gate stream. If `.5x/` is wiped while a gate is open, the gate (and the `gateId` later decisions must reference) is gone; §6.1 creates the gate *after* the reviewer record, so a crash in between also relies on an unspecified retry.

Fix (lowest cost): make the gate a **pure derivation** — a gate exists iff the latest recorded plan-reviewer step has `governance.route = "human_gate"` and no decision line carries its gate key. Derive `gateId` deterministically from `(runId, forecastId = snapshot id, sorted causes)` (e.g. `sha256`/UUIDv5), so retries, rebuilds, and both processes compute the same ID. "Superseded" = a newer reviewer snapshot exists. The typed prompt and `review_gate_index` are projections keyed by that ID. This also removes the need for gate record-line codecs in §2.2.

### P1.5 — The `decisions` stream already has two other payload kinds; one human choice will produce three lines *(auto_fix)*

`recordStepInternal` mirrors every `human:*` step into `decisions` as `kind: "human-step"` (`src/commands/run-v1.handler.ts:2151–2164`), and answered prompts append `kind: "answered-prompt"` (`src/commands/prompt.handler.ts:225–257`). With §5.2, one gate resolution yields `human-step` + `answered-prompt` + `plan-review-governance` lines. §2.1/§2.2 say to "fail closed on malformed authoritative lines" and to report unknown kinds as diagnostics, which as written would flag every existing run with a human step.

Fix: state that the fold, index, run-state ledger, and timeline select **only** `kind: "plan-review-governance"`; existing kinds are ignored silently, unknown *governance versions* are diagnostics. Write the `human:review-governance` step through the shared finalize seam in the `atomicAppendIfAllNew` batch from P0.2 without the generic `human-step` mirror (the governance line is the mirror). Add a fixture containing all three kinds to the fold/reindex tests.

### P1.6 — Reconcile with the code-complete plan-208 branch now, and make "Phase 0" real *(auto_fix)*

The Overview defers name/line reconciliation to a "Phase 0 of execution" that does not exist in the phase list or Delivery Budget. Plan 208 is sealed on `5x/208-review-budget-advisory-plan`, so most of this can be corrected today:

- `PlanReviewBudgetContext` does not exist; the context is `ReviewBudgetCommandContext` from `src/commands/review-budget-context.ts`, and the paired writer is `recordPlanReviewerStepWithSnapshot` (never mentioned in 209). `applyPlanReviewGovernance` must compose **inside/around that writer**, not return a parallel `PreparedPlanReviewRecord` path.
- `VerdictItem` already carries `scopeClass`, `effortDelta`, `architectureDelta`, `coupling`, `estimateConfidence`, `creditClaim` on the 208 branch; §3.1 should list only the new closure fields.
- `mode = "enforced"` is currently *reserved*: `ENFORCED_REVIEW_BUDGET_WARNING` (`src/review-budget/ensure-baseline.ts`), the run-state string "enforced: not implemented; advisory telemetry" (`run-v1.handler.ts`), the config description (`src/config.ts`), and their tests must be removed/updated. No phase does this.
- Governing `B`: `applyPlanReviewBudget` reads `baseline.b` from the immutable baseline line. Specify an additive `governingBaseline` input (folded from decisions) rather than mutating or re-appending a baseline.
- Post-decision forecasts must be a pure `deriveBudget` recompute from the latest snapshot record + folded state. Do **not** append a new snapshot line: 208's invariant is snapshot ↔ reviewer step 1:1.
- Add a short explicit "Phase 0: prerequisite reconciliation" checklist (no budget row needed; it is plan-text work) whose gate is "every `src/…:line` reference and imported symbol in this plan resolves on the merge base".

### P1.7 — Follow-ups and adjacent-debt requests have contradictory or missing representations *(auto_fix)*

- `followUpCount` and "repeatable follow-up records" in emit have no source: `ReviewerVerdict` gains no `followUps` field, §3.1 forbids new flags, and `206` §6.2 says follow-ups live only in the review document. Lowest-cost fix: follow-ups stay in the review Markdown; drop `followUpCount` and the emit bullet (or, if a count is wanted for telemetry, add a single optional integer — not records).
- §1.3 rejects adjacent/unrelated debt as a blocking item, while §4.1 step 2 routes an "unresolved adjacent-debt scope request" to a gate. Per `206` §4.2: `adjacent` ⇒ allowed only as an `action: "human_required"` item (routes to gate, earns no credit); `unrelated` ⇒ rejected from `items[]`, follow-up only. State that rule once in §1.3 and reference it from §4.1.

---

## Medium priority (P2)

- **P2.1 — All-zero architecture deltas understate `P`** *(auto_fix)*: the plan adds a new subsystem (`src/review-governance/`, 11 files), a new authoritative record kind with a fold and index migration (W2), and a new cross-process gate/decision boundary plus CLI command group (W5), and its own Surface Snapshot reports 3 new shared abstractions and 1 schema. `206` §4.1 scores newly introduced maintenance burden with positive deltas. Rescore at least W2 and W5 (suggest +2 each) and W1 (+1) with rationale. This stays well under the positive-architecture limit for `B0 = 52`; it is an honesty correction, not a gate.
- **Fingerprint inputs vs. persisted data:** `canonicalFindingFingerprint` hashes `failure` and `lowestCostCorrection`, which plan 208's `FindingDelta` snapshot does not persist. §6.1 covers this generically ("extend the snapshot payload"); name the added fields so rebuild-from-records can recompute fingerprints. (Covered by P0.4's snapshot bullet; no separate item.)
- **Stale-forecast race:** a decision on gate *G* racing a new reviewer snapshot is not covered by a store-level precondition. With deterministic gate IDs (P1.4) the fold can simply ignore a decision whose `forecastId` is not the latest snapshot at read time; note this in §2.1 rather than adding a new store primitive.

---

## Delivery budget assessment

- **Ledger hygiene:** stable `W1`–`W9`, empty `Addresses`, on-scale scores, no negative rows and therefore no `DCn` claims to assess. Surface snapshot is plausible (production-file count is ~31 by the Files Touched table vs. 28 stated; immaterial).
- **Independent estimate `I` = 48** (medium confidence): protocol + diff validation 5; pure domain/closure/fingerprint 5; decisions/fold/index/migration 8; routing 3 (pure table logic over existing 208 outputs); gate prompt + decision command + CAS 8; recording integration + context injection 5; templates/skills 3; dashboard 8 (uncertainty-priced, see P0.1); run-state/docs 3 (tests belong to the items they validate, so W9 is lighter than scored). This is aligned with the author's ledger.
- Review-item deltas are small because most corrections are contract clarifications; P0.2 and P1.4 remove machinery (prompt-side CAS, gate records/codecs) and should net close to zero.

---

## Readiness checklist

**P0 blockers**
- [ ] P0.1 — Human decision: split Phase 8/W8 into a post-slice-04 plan, or hold the whole plan until slice 04 is planned and merged.
- [ ] P0.2 — Gate-scoped idempotency key + single `atomicAppendIfAllNew` as the CAS; records first, prompt as projection.
- [ ] P0.3 — Router suppresses gate causes covered by an active decision; matrix rows for post-decision rounds.
- [ ] P0.4 — Top-level `priorFindings[]` (+ emit flag); `items[]` holds only still-blocking work; required-outcome set defined.

**P1 recommended**
- [ ] P1.1 — Human decision: closure convergence strictness in advisory mode; mid-run mode change rule.
- [ ] P1.2 — Inject governing decisions into `author-process-plan-review`.
- [ ] P1.3 — Validate against the full plan-only patch; truncation is render-only.
- [ ] P1.4 — Deterministic, derived gate identity; no mutable gate state.
- [ ] P1.5 — Fold/index filter on `kind`; no triple decision lines.
- [ ] P1.6 — Reconcile names/seams with the 208 branch; remove reserved-`enforced` warning; governing-`B` input; explicit Phase 0.
- [ ] P1.7 — Follow-up and adjacent-debt representation.

**P2**
- [ ] P2.1 — Rescore positive architecture deltas.

---

## Addendum (2026-09-21) — Re-review of plan v1.1 (closure review)

**Reviewed:** `docs/development/plans/209-plan-review-governance-plan.md` v1.1 @ `0248b10` (prior review commit `d92b809`). The prompt's appended diff and commit range were empty, so I recomputed the plan delta with `git diff d92b809 HEAD -- <plan>` and re-read the full revised plan.
**Local verification:** Not run (static review). Re-checked against `main` and the plan-208 branch `5x/208-review-budget-advisory-plan` @ `cd7ee88` (`finalizeAndWritePreparedStep`, `applyPlanReviewBudget`, `recordPlanReviewerStepWithSnapshot`, `deriveBudget`).

### What's addressed (✅)

- **P0.1 — ✅ Addressed.** Phase 8/W8 and all dashboard parity work are removed. Slice 04 is no longer a prerequisite, and the plan keeps only CLI-side seams (exported `submitPlanReviewDecision`, redacted prompt view DTO) plus a follow-up handoff in §9.3. Phase 0 and the timeline are consistent.
- **P0.2 — ⚠️ Partially addressed.** The design is now correct: `decision:review-gate:<gateId>` plus the human step in one `atomicAppendIfAllNew`, records first, prompt as projection, `decisionIntentHash` for semantic retries, and a two-facade cross-process test. The write path has a hole, though (see the P0.2 residual below).
- **P0.3 — ✅ Addressed.** Routing step 2 suppresses causes covered by an active decision and records `resolvedBy`. Baseline dispute is covered by retain/adjust/re-estimate. Architecture is covered only within `approvedP` and the approved threshold-crossing IDs. Budget bands are never suppressed and use folded `B`. Post-decision matrix rows are added in §4.3.
- **P0.4 — ✅ Addressed.** `priorFindings[]` is now a separate top-level array and `--prior-finding` is a repeatable flag. Only still-blocking IDs stay in `items[]`. The required-outcome set is defined, `--ready` with addressed-only outcomes emits `ready`, and the snapshot extension persists outcomes. This is consistent with plan 208's `computePendingR`, which sums only listed items.
- **P1.1 — ✅ Addressed.** Mode is pinned into the baseline record, so advisory records diagnostics and a hypothetical route without rejecting, and enforced fails closed. This is the option I recommended, and it also settles the mid-run mode-change question. Note that runs captured before this ships decode as advisory, and there is no path to move an already-captured run to enforced; document that in §9.3.
- **P1.2 — ✅ Addressed.** §6.3 and §7.3 inject a "Governing decisions" block into `author-process-plan-review` renders, and the author template is in Files Touched. Keep the block post-render, like `diffAppend`, because declared template variables must be single-line scalars.
- **P1.3 — ✅ Addressed.** `buildPlanReviewDiffContext` always builds the full patch. Truncation is render-only and lists omitted hunk headers and the exact `git diff` command. `INTRODUCED_HUNK_NOT_FOUND` names the closest hunk, and a cited-hunk-after-line-200 test is added.
- **P1.4 — ⚠️ Partially addressed.** The gate is now a pure derivation with a deterministic ID and no gate codec. The ID inputs are not stable across the decision itself (see the P1.4 residual below).
- **P1.5 — ✅ Addressed.** The fold, index, and codec select only `kind: "plan-review-governance"`. Existing `human-step` and `answered-prompt` lines are ignored silently. The human step skips the generic mirror, and a three-kind fixture is planned.
- **P1.6 — ✅ Addressed.** Phase 0 exists. `ReviewBudgetCommandContext` and `recordPlanReviewerStepWithSnapshot` replace the fictional `PlanReviewBudgetContext`. `governingBaseline` is an additive `applyPlanReviewBudget` input, and post-decision forecasts are pure recomputes with no extra snapshot. Removal of the reserved-`enforced` warning and copy is scheduled, and the cross-plan touches (`record-lines.ts`, `ensure-baseline.ts`, `review-budget-store.ts`) are in Files Touched.
- **P1.7 — ✅ Addressed.** `followUpCount` and the follow-up emit bullet are gone, and follow-ups are Markdown-only. `adjacent` debt is allowed only as `human_required`, and `unrelated` is rejected from `items[]`, stated once in §1.3.
- **P2.1 — ✅ Addressed.** Rescored: W1 +1, W2 +2, W5 +2, each with rationale.

**Delivery-budget hygiene:** The ledger has stable IDs. W8 is removed and W9 keeps its ID, which is fine. There are no negative rows and no `DCn` claims, so there are no credit assessments to emit. The current ledger sums to 44 against the frozen `B0 = 52` baseline. I'm not emitting a new baseline assessment.

**`Addresses` re-check:** The cells for W1, W3, W4, W6, W7 and W9 match findings that are now closed. W2 and W5 cite P0.2 and P1.4, which stay open below. Those cells are accurate accounting, since the effort is incorporated into W2/W5. Under 206 §6.1, partially-addressed findings re-enter pending `R` regardless, so I have scored their residual effort on the items below. Do not treat them as resolved until the fixes land.

### Remaining concerns

**P0.2 (residual; severity now P1) — the gate-key loser path breaks the plan-208 finalize seam.** §5.2 says to "build the finalized `human:review-governance` step … then call `atomicAppendIfAllNew` once" and, on `created:false`, load the gate-key winner. Two problems follow.
- The step iteration is allocated inside `finalizeAndWritePreparedStep` (`src/commands/run-v1.handler.ts`, plan-208 branch), and the plan does not say to use it.
- That seam treats every `!created` result as either an iteration collision or a pair-corruption case. A loser that runs after the winner committed builds step key N+1 (new) plus the gate key (existing), so the batch returns `created:false` and the step line does not exist. With an omitted iteration, the seam retries up to `maxSteps − total` times and throws `RECORD_ITERATION_RETRY_EXHAUSTED`. With an explicit iteration it throws `RECORD_PAIR_CORRUPT`. Every duplicate or losing submission would therefore error instead of "observing the winner".

Fix, without a new primitive:
- Route the write through `finalizeAndWritePreparedStep` with `mode: "paired-all-new"` and `extraOps` supplying the decision op.
- Pre-read `getLine(runId, "decisions", "decision:review-gate:<gateId>")` before finalizing.
- Extend the seam so that on `!created` it checks the extra ops' keys first and returns a "coupled key exists" outcome to the caller, instead of retrying or throwing.
- Add contract tests for a loser that arrives simultaneously and for a loser that arrives after the winner (step iteration N+1).

**P1.4 (residual) — `gateId` is derived from inputs that change when the gate is resolved.** The ID hashes `sorted causes`, but §2.2 and §4.1 define causes as the post-suppression result of the fold. After `retain_baseline` or `approve_architecture_burden`, recomputing causes drops the covered cause, so the recomputed `gateId` differs from `decision:review-gate:<gateId>`. The resolved gate then looks unresolved, or a different gate appears. Multi-cause gates are also unspecified: a baseline dispute plus `over_effective` is resolved by one decision that covers only one cause.

Fix:
- Hash `gateId` from the causes persisted in the reviewer snapshot at record time.
- Make "resolved" mean the key exists.
- After each decision, recompute the remaining uncovered causes from the fold. If any remain, derive one deterministic successor gate `sha256(runId, snapshotId, remainingCauses, predecessorGateId)`.
- Add a two-cause test: the first decision leaves exactly one successor gate, and the resolved gate never reopens.

**P1.8 (new) — a typed gate prompt cannot carry a decision payload.** `PromptStore.answerPrompt(id, answer: string, answeredBy)` accepts a single string, but decisions need rationale, evidence, scope and baseline fields. The plan removed the "answered prompt awaiting repair" direction. It does not say what happens when a human answers a `plan_review_gate` prompt through the generic prompt path (`5x prompt` answer or a later adapter) instead of `5x review decide`. The result would be an answered prompt, an `answered-prompt` line, and no decision.

Fix:
- Make the gate prompt a notification and wait handle only.
- Have the generic answer path reject `plan_review_gate` prompts with a structured error pointing at `5x review decide`.
- Have the prompt-wait function poll the gate-key decision, not the prompt answer.
- Add the rejection and the wait behavior to the §5.3 tests.

**P1.9 (new) — post-decision routing and skill resume are unspecified.** `submitPlanReviewDecision` returns a `route`, and §7.4 says to "resume from the durable decision", but nothing defines how that route is derived. Routing step 5 requires `ready`. A `not_ready` verdict whose only blocking items were deferred by `defer_accept_risk` matches neither step 5 nor step 7.

Fix: define `routeAfterDecision` as a re-run of the pure `derivePlanReviewGovernance` on the latest recorded verdict with the new fold. Add matrix rows:
- Deferral leaves zero required items → `complete`. The human explicitly accepted the risk and the reviewer raised nothing else.
- `increase_budget` or `retain_baseline` → `author_revision`, or `final_corrections` if it qualifies.
- `trade_scope` or `request_author_reestimate` → `author_revision`.
- `abort` → terminal.

Have `5x review gate show` and `5x review decide` return this route for the skill's branch.

**P2.2 (new) — phase and work-item numbering skips 8.** The table of contents, headings, timeline and W-rows go from Phase 7 to Phase 9. Either renumber or add a one-line note that Phase 8/W8 is intentionally vacant, so a reader is not left wondering whether a phase is missing.

**P2.3 (new) — side effects on a stale gate.** §5.2 validates the expected forecast before the append, then applies side effects after it. A newer reviewer snapshot landing between the two leaves a decision that is retained for audit but no longer governs, while an `abort` or baseline-change side effect would still run. Re-check that the gate is still the current derived gate after the append. If it is stale, skip side effects and return `REVIEW_GATE_STALE`, keeping the decision line as audit only.

### Updated readiness

- **Plan-review governance plan completion:** ⚠️ Materially improved. All four original P0 blockers are resolved or reduced to a mechanical write-path correction. The two human decisions (P0.1 scope split, P1.1 advisory strictness) were resolved as I recommended.
- **Ready for implementation:** ⚠️ After the corrections above. All remaining items are `auto_fix` with a single derivable fix, and none needs a human decision.

**Readiness:** Ready with corrections — fix the gate-key loser path (P0.2 residual) and the gate identity across decisions (P1.4 residual) before Phases 2 and 5. Fix the prompt payload path, post-decision routing and the stale-gate side effects (P1.8, P1.9, P2.3) in the same revision.
