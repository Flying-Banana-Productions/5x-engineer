# Review: Implementation-Review Governance Plan (210)

**Review type:** `5x-cli/docs/development/plans/210-implementation-review-governance-plan.md`
**Scope:** Plan v1.0: approved-plan execution binding, implementation finding contract, exact code-range evidence, text-only amendment guard, quality-backed final corrections, credit realization, domain-aware gates, completion guards, skills/docs
**Reviewer:** Staff engineer (correctness, record/CAS integrity, bypass resistance, phasing)
**Local verification:** Not run (static review). Source claims were checked against dependency worktree `.5x/worktrees/209-plan-review-governance-plan-68d554` at `afb1320`.

**Implementation plan:** `5x-cli/docs/development/plans/210-implementation-review-governance-plan.md`
**Technical design:** `docs/v2/206-review-budget-governance.md`, `docs/v2/plan-inputs/08-implementation-review-governance.plan-input.md`

## Summary

The plan builds on the real plan-209 seams rather than the older main-branch proposals. Its line references check out: `composePlanReviewerRecord` at `review-budget-context.ts:164`, `recordPlanReviewerStepWithSnapshot` at `:338`, `classifyDecisionAcceptance` at `decisions.ts:244` with its hard-coded `phase === "plan"` stale predicate, `deriveBudget` at `arithmetic.ts:150`, and kind-filtered snapshot readers. The architecture is sound: paired admission/finalization is reused, implementation data is kept out of plan `FindingDelta[]`, and completion goes through one boundary predicate.

Five internal gaps would let enforcement be bypassed or would block legitimate flows:

- Nothing defines when a separate execution run must bind.
- The diff base misses commits when an author session makes more than one commit.
- Plan-drift detection conflicts with guarded text-only amendments.
- The final-correction shortcut conflicts with the rule that invalidates claim assessments.
- `planImpact` has no defined shape.

The plan also names a migration number that the dependency already uses. Each fix follows from the plan's own intent.

**Readiness:** Ready with corrections. All items are mechanical, and the pinned advisory mode keeps the ordinary v1 author/re-review cycle.

---

## Strengths

- **Reuses the shipped authority seams.** It extends the same prepare/finalize pair, `coupled-key-exists` handling, record-key CAS and steps-order acceptance, and adds no parallel recorder or decision authority. It also keeps `recordPlanReviewerStepWithSnapshot` as the sole writer of plan snapshots.
- **Evidence is anchored before delegation.** Endpoints are recorded before delegation, and the reviewed end is the author commit, not the HEAD after the review artifact. Hunks carry their file header, and the plan validator's whitespace normalization is not reused. This closes the obvious ways to game diff-causal evidence.
- **Implementation telemetry is kept separate from budget math.** Implementation variance never feeds `R`/`W`/`B` and cannot mint `D`. Credit realization is capped at the approved magnitude. This keeps plan-209 arithmetic stable.
- **Pre-review and post-review completion are kept apart.** `phase finish` and the first author `complete` stay unguarded, and reconciliation applies only at the phase/run boundary. This matches how `5x-phase-execution` actually sequences `phase finish` → reviewer → `phase:complete`.
- **Failures fail closed.** A failed quality attempt latches, skipped or empty quality gates disqualify the shortcut, and future-version payloads cannot authorize enforced advancement.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1: No rule makes a separate execution run bind to the approved plan

Mode is pinned only when the baseline is captured (`review-budget-context.ts:178`, `ensure-baseline.ts`), and a fresh execution run has no baseline. The plan says a missing source "in an otherwise enforced execution context" returns `IMPLEMENTATION_APPROVAL_REQUIRED`, but no step defines what makes an unbound execution run enforced. As written, an operator could start a new execution run without calling `review implementation bind`. That run would silently take the off/v1 path and skip every Phase 9 guard.

**Requirement:** Define the trigger in Phase 1. At the first implementation-phase author admission, check the plan and config:

- If the plan has a `## Delivery Budget` and the resolved config mode is not `off`, the run must be bound.
- It auto-resolves the unique approved source run for the canonical plan path through RecordStore/progress resolution.
- If there are zero or several candidates, it returns `IMPLEMENTATION_APPROVAL_REQUIRED`.

Runs whose plan has no budget, or whose mode is `off`, stay v1. Add a Phase 9 bypass test for an unbound execution run.

### P1.2: The initial diff base misses earlier commits from the same author session

Phase 3 sets the initial base to "the parent of the first admitted implementation author commit." An author result records only one `commit` (`protocol.ts` AuthorStatus). Authors can create several `git:commit` steps in one session (`commit.handler.ts`). The parent of the first recorded author-result commit therefore excludes that session's earlier commits, so the reviewed range misses part of the phase. Diff-causal closure then rejects valid blockers in the excluded code.

**Requirement:** Record the pre-delegation HEAD at the phase's first implementation author admission, in the template render or invoke path that Phase 9 already touches. Use it as the initial base, and verify that it is an ancestor of the reviewed commit. For legacy history with no captured base, fall back to the parent of the earliest same-phase `git:commit` record. Otherwise fail with the explicit context error the plan already describes.

### P1.3: Plan-drift detection conflicts with guarded text-only amendments

Phase 1 treats any change to the approved plan other than checkbox state as drift that needs an amendment, and Phase 9 requires the plan's "current committed scope" at the boundary. Phase 5, however, lets authors make guard-verified wording edits to the plan without a plan decision. After one legitimate `text_only` pass, the plan hash no longer matches the approval. The boundary would then deny completion, or re-binding would require an amendment workflow.

**Requirement:** Treat a successful Phase 5 guard verification as authorized drift lineage. Drift is measured against the approved bytes plus the chain of guard-verified amendment commits, with checkbox-only changes also ignored. Any other change is still drift. Add a test that runs a text-only pass through to `phase:complete`.

### P1.4: The final-correction shortcut conflicts with claim-assessment invalidation

Phase 7 says "Changed target-phase code after assessment invalidates its completion authority until reviewed again." The Phase 6 shortcut, by definition, lands a code commit after the reviewer's assessment and then completes without re-review. In any phase that has due claims, the two rules conflict: either the shortcut never works there, or reconciliation is bypassed.

**Requirement:** State the carry-forward rule. The originating observation's per-claim assessments carry forward to the correction commit only through a CLI-recorded passing correction attempt. That attempt must also show zero architecture delta, empty boundary changes, and clean changed-path inventory. Any other code change still invalidates the assessments. Add a Phase 11 lifecycle case: a single P2 shortcut in a phase with a realized claim.

### P1.5: `planImpact` has no defined shape, but the text-only guard needs it

Phase 2 adds a conditional `planImpact` field, and Phase 5 routes on `design` / `budget` / `text_only`. Phase 5 also permits only "authorized factual wording edits" at "allowed text locations." The plan never gives `planImpact` a concrete shape, so the guard has no machine-checkable way to know which spans may change. The protocol examples that Phase 10 requires to "match Phase 2's concrete fields" cannot be written either.

**Requirement:** Define `planImpact` as `{ kind: "text_only" | "design" | "budget", locations: [{ heading, staleText }] }`, with strict validation:

- `locations` is non-empty for `text_only`.
- Every `staleText` must occur exactly once under its heading at the approved commit.

The guard then allows byte changes only inside those spans, plus checkbox toggles. If `staleText` is missing or ambiguous, the finding routes to a human, consistent with the plan's rule on ambiguous wording.

---

## Medium priority (P2)

### P2.1: Migration v10 is already used by plan 209

The dependency already ships `version: 10`, "Persist plan-review closure context in the budget index" (`src/db/schema.ts:589`), yet the plan names this work v10 in three places:

- the Architecture diagram ("SQLite v10 projections"),
- Phase 8 ("Add additive migration v10"),
- the Files Touched test `schema-v10.test.ts`.

The Overview also cites only v9. Phase 0's "next available" hedge prevents actual damage, but the concrete references are wrong. Change them to v11 (`schema-v11.test.ts`) and list v10 among the dependency seams in Phase 0.

---

## Delivery budget assessment

- The ledger has W1–W11 with stable IDs. The effort sum is 47, which equals the governing B. No debt claims are made, so there are no credits to assess, and the statement that no credit is taken for the new governance concepts is appropriate.
- My independent estimate is **52**. W1 (cross-run binding and rebuild), W3 (git range edge cases: renames, CRLF, rebase drift), and W8 (domain-generalized CAS/acceptance plus migration and rebuild parity) each look about one point light. P1.1, P1.3 and P1.5 each add a little specification work but no new architecture.

---

## Nonblocking follow-ups

- **Surface snapshot count.** "New persistent schemas: 1" undercounts. The plan adds several new versioned record kinds (binding, review context, implementation observation, correction attempt, reconciliation observation, implementation decision) across existing streams. Consider listing them for the audit.
- **Dependencies between Phases 4/5 and 8.** Phases 4 and 5 produce `human_gate` routes and `nextAction: plan_amendment`, but those only become actionable gates in Phase 8. The plan's warning not to advertise enforced mode covers this. Stating explicitly that Phases 4 and 5 persist gate *causes* only would make each phase gate cleaner to test.
- **Forward compatibility.** Older CLIs that read runs with the new budget-stream kinds skip them during index projection (`review-budget-index.ts:206–228`). Consider adding an explicit regression test so this stays true.
- **Size.** 12 phases and roughly 31 days is large for one slice. If the budget becomes tight, split the text-only guard (W5) or the correction shortcut (W6) into a follow-up; both can be separated cleanly.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1: Define when an execution run must bind; auto-resolve a unique source or return `IMPLEMENTATION_APPROVAL_REQUIRED`
- [ ] P1.2: Capture the pre-author HEAD as the initial diff base
- [ ] P1.3: Treat guard-verified text-only amendments as authorized drift lineage
- [ ] P1.4: Carry claim assessments forward only through a passing, eligible correction attempt
- [ ] P1.5: Define the `planImpact` schema, including text locations

**P2**
- [ ] P2.1: Renumber the migration to v11
