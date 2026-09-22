# Plan-Review Governance — Closure Reviews, Enforced Routing, and Durable Decisions

**Version:** 1.4
**Created:** September 21, 2026
**Status:** Draft — revised after initial staff review; blocked only on review-budget advisory plan 208

---

## Executive Summary

This slice turns review-budget telemetry into enforceable plan-review governance. Initial review remains the one exhaustive pass; later reviews become closure reviews that resolve prior findings, accept only diff-causal new blockers, preserve nonblocking follow-ups, and require new evidence before a deferred or accepted-risk finding can block again. The CLI—not the reviewer—validates evidence, normalizes readiness, derives the route, opens durable human gates, and folds immutable decisions into the governing baseline and approved scope.

The implementation extends the advisory budget record model from plan 208 and the already-merged prompt queue. It adds pure convergence/routing policy, append-only review-decision records, a RecordStore-authoritative gate CAS, typed prompt metadata, protocol validation for closure evidence, and workflow skill branches. Dashboard views/actions are deferred to a follow-up generated after slice 04 merges; this slice exports dashboard-ready read/action seams without inventing an HTTP contract.

The review-budget mode is pinned into the baseline record when the run activates budgeting. Advisory runs record closure/convergence diagnostics and a hypothetical enforced route, but do not reject verdicts or change v1 routing; enforced runs validate closure evidence and apply deterministic routes. Later config edits affect new runs only.

### Scope

**In scope:**

- Exhaustive initial-review and constrained closure-review contracts, including prior-finding status and lowest-cost correction evidence.
- Exact plan-diff validation for new ordinary blockers, direct human routing for critical late safety findings, and nonblocking follow-up documentation in review Markdown.
- Debt-claim eligibility validation and deterministic enforcement of budget, baseline, semantic-human, architecture, and final-correction gates.
- Append-only review decisions with UUIDs, finding fingerprints, rationale, evidence, approved scope, governing-baseline changes, and supersession history.
- Explicit budget-increase, scope-trade, risk-deferral, retain/adjust-baseline, request-re-estimate, and abort choices through the prompt/control-plane path.
- Injection of governing decisions into every later reviewer **and author** plan-review prompt, with new-evidence checks on re-raise.
- Dashboard-ready exported action/read-model seams and typed prompt context, without dashboard transport or UI work.

**Out of scope:**

- Implementation-review classification, code-diff validation, final quality-gated implementation corrections, or realized debt credit (slice 08).
- A second implementation budget or general technical-debt discovery.
- Automatic suppression of material correctness, security, data-loss, or acceptance findings.
- Changing the global default from advisory to enforced.
- Dashboard HTTP/WebSocket routes, authenticated actions, browser UI, and dashboard parity tests; these move to a post-slice-04 follow-up.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **The CLI derives one `PlanReviewRoute`; reviewers never emit routing or aggregates** | Prevents agents from authoring budget outcomes and gives native and invoke workflows the same deterministic result. |
| **Closure evidence is validated against a recomputed plan-only diff** | A cited hunk must be part of the exact plan delta shown to the reviewer; a review-artifact commit after rendering cannot invalidate the comparison. |
| **Review decisions are immutable record lines; governing state is a fold** | Preserves the full audit trail, keeps SQLite rebuildable, and avoids mutating the frozen baseline from plan 208. |
| **Gate resolution CAS extends plan 208's finalize seam; prompts are notification projections** | `finalizeAndWritePreparedStep(mode: "paired-all-new")` appends `decision:review-gate:<gateId>` as an extra op with the human step. An existing extra key is a first-class loser outcome, not an iteration collision. |
| **Finding identity combines stable item ID with a canonical fingerprint** | IDs support author `Addresses` accounting; fingerprints prevent a renamed deferred finding from silently becoming a fresh blocker. |
| **Valid `ready_with_corrections` produces a final-author route, not review re-entry** | Implements the bounded mechanical shortcut while preserving the existing iteration limit for real `not_ready` closure cycles. |
| **Mode is pinned at baseline activation** | Advisory records diagnostics without rejecting or rerouting; enforced validates/routes. Later config changes affect only new runs, making one run deterministic. |
| **Gate identity uses persisted snapshot causes and an explicit successor chain** | The first ID hashes causes persisted at reviewer-record time. A decision resolves that exact key; uncovered causes create one successor ID containing the predecessor. A resolved gate never changes identity or reopens. |

### References

- [`docs/v2/plan-inputs/07-plan-review-governance.plan-input.md`](../../v2/plan-inputs/07-plan-review-governance.plan-input.md) — slice requirements and exit criteria.
- [`docs/v2/206-review-budget-governance.md`](../../v2/206-review-budget-governance.md) — canonical convergence, routing, debt-credit, and decision policy.
- [`208-review-budget-advisory-plan.md`](./208-review-budget-advisory-plan.md) — required budget parser, arithmetic, record facade, and decorated snapshots.
- [`docs/v2/plan-inputs/04-control-plane-dashboard.plan-input.md`](../../v2/plan-inputs/04-control-plane-dashboard.plan-input.md) — deferred consumer of the exported governance seams.
- [`docs/v2/202-control-plane.md`](../../v2/202-control-plane.md) — prompt queue and allowed control-plane mutation paths.
- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — record/control-plane ownership and compatibility constraints.
- [`docs/v1/100-architecture.md`](../../v1/100-architecture.md) — CLI primitives, idempotent recording, and skill-owned orchestration.

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Architecture Overview](#architecture-overview)
4. [Delivery Budget](#delivery-budget)
5. [Phase 0: Prerequisite reconciliation](#phase-0-prerequisite-reconciliation)
6. [Phase 1: Governance domain and convergence policy](#phase-1-governance-domain-and-convergence-policy)
7. [Phase 2: Durable decisions and governing-state fold](#phase-2-durable-decisions-and-governing-state-fold)
8. [Phase 3: Closure protocol and plan-diff evidence validation](#phase-3-closure-protocol-and-plan-diff-evidence-validation)
9. [Phase 4: Deterministic enforced routing and readiness normalization](#phase-4-deterministic-enforced-routing-and-readiness-normalization)
10. [Phase 5: Human gate prompt and decision actions](#phase-5-human-gate-prompt-and-decision-actions)
11. [Phase 6: Recording integration and workflow context](#phase-6-recording-integration-and-workflow-context)
12. [Phase 7: Reviewer templates and workflow skills](#phase-7-reviewer-templates-and-workflow-skills)
13. [Phase 9: End-to-end audit, compatibility, and documentation](#phase-9-end-to-end-audit-compatibility-and-documentation)
14. [Files Touched](#files-touched)
15. [Tests](#tests)
16. [Not In Scope](#not-in-scope)
17. [Estimated Timeline](#estimated-timeline)
18. [Revision History](#revision-history)
19. [Provenance](#provenance)

> **Intentional numbering gap:** Phase 8 and work item W8 were moved to the post-slice-04 dashboard follow-up in v1.1. Their IDs remain vacant and will not be reused.

---

## Overview

The current branch does not yet contain plan 208, but that plan's implementation branch is code-complete and exposes concrete seams: `ReviewBudgetCommandContext` in `src/commands/review-budget-context.ts`, `applyPlanReviewBudget`, and `recordPlanReviewerStepWithSnapshot`. Phase 0 reconciles those symbols on the actual merge base. Slice 04 is no longer a prerequisite: dashboard delivery is explicitly deferred.

**Current behavior:**

- On plan 208's branch, `VerdictItem` already has plan-budget scope/delta/coupling/confidence/credit fields; `ReviewerVerdict` still has no closure outcome/evidence fields (`src/protocol.ts`, reconciled in Phase 0).
- `protocol emit reviewer` copies only those v1 item fields (`src/commands/protocol-emit.handler.ts:67–160`), and `protocol validate --record` records the validated result directly (`src/commands/protocol.handler.ts:378–517`).
- Initial review asks for broad correctness/architecture/completeness/scope analysis (`src/templates/reviewer-plan.md:19–89`). Continued review asks for prior status but also broadly allows newly introduced issues without structural evidence (`src/templates/reviewer-plan-continued.md:13–32`).
- Continued prompt rendering computes a plan-file diff from the prior reviewer step to current HEAD (`src/commands/template-vars.ts:329–425`) but does not retain a machine-checkable diff context.
- Human steps and answered prompts are copied into the append-only `decisions` stream (`src/commands/run-v1.handler.ts:2151–2164`, `src/commands/prompt.handler.ts:225–257`) without a review-governance payload or governing-state fold.
- `RecordStore` exposes insertion-ordered streams and atomic append (`src/control-plane/record-store.ts:17–39`); command handlers need not know the working-tree JSONL layout.
- No dashboard command/server is present, so this plan does not promise dashboard routes or UI.

**New behavior:**

- Initial verdicts are exhaustive, independently assess the baseline, classify scope, and state the lowest-cost adequate correction.
- Continued verdicts carry outcomes in top-level `priorFindings[]`; `items[]` contains only still-blocking work. New blockers require a validated introducing plan hunk, a critical-safety exception, or new evidence tied to a prior decision.
- The CLI derives a governance result from the run-pinned mode, plan-208 forecast, prior decisions, and review round. Advisory records diagnostics only; enforced rejects invalid closure evidence and routes.
- Enforced runs pause on computed or semantic gates. A typed prompt projects a deterministic derived gate; the first gate-scoped RecordStore append wins.
- Governing baseline and approved scope are folded from immutable decisions; original baseline, gross effort, positive architecture burden, and debt-credit caps remain visible.
- Later review prompts contain the full applicable deferred/accepted-risk ledger. Re-raising requires the exact prior decision ID plus material new evidence.
- Exported read-model and decision handlers are ready for the future authenticated dashboard without making it part of this slice.

**Prerequisites:**

- [`208-review-budget-advisory-plan.md`](./208-review-budget-advisory-plan.md) implemented and merged, including `ReviewBudgetStore`, `ReviewBudgetCommandContext`, `applyPlanReviewBudget`, `recordPlanReviewerStepWithSnapshot`, and `atomicAppendIfAllNew`.
- If plan 208 lands with materially different APIs, complete Phase 0 before implementation; do not create parallel budget arithmetic or a second paired writer.

---

## Design Decisions

**Separate validation, derivation, and orchestration.** `validateClosureReview` validates reviewer claims; `derivePlanReviewGovernance` computes normalized readiness and route; skills execute that route. Protocol handlers may call the first two but must not encode workflow loops.

**Use the full plan delta for validation, independently of prompt truncation.** Extract a shared `buildPlanReviewDiffContext` that always returns the complete plan-only patch and hunk hashes. Rendering may truncate patch bodies, but must list the commit range, omitted hunk headers, and exact `git diff` command. Validation matches against the complete patch. The ending commit may precede a review-artifact-only commit when both yield the same plan patch.

**Late safety is visible and always human-owned.** `lateDiscovery: "critical_safety"` is accepted only for `acceptance_required` or `risk_reduction`, with non-empty evidence naming a security, data-loss, or correctness failure. It never silently becomes an automatic author loop.

**Ordinary missed issues are follow-ups, not verdict items.** The review artifact gains a nonblocking follow-up section. Structured `items[]` remains routing input; therefore an ordinary pre-existing issue discovered after round one fails validation rather than being retained as a blocking item. This does not suppress critical-safety findings.

**A decision never edits a prior record.** Decision lines live in the existing `decisions` record stream and carry a UUID `decisionId`, `gateId`, `forecastId`, actor/origin, finding fingerprints, rationale, evidence, approved scope, and optional governing-baseline change. The latest governing state is a deterministic insertion-order fold. SQLite stores only a rebuildable projection.

**RecordStore is the only gate CAS authority.** Derive the first `gateId` from persisted snapshot causes and each successor from remaining causes plus its predecessor. Resolve the exact key through plan 208's paired finalize seam with the human step and decision as one `atomicAppendIfAllNew` batch. Records are written first; prompt closure is a best-effort projection. Same-intent losers return the winner; different intents return `REVIEW_GATE_ALREADY_RESOLVED`.

**Decision scope is explicit.** Risk deferral and accepted-risk choices must name finding IDs/fingerprints and approved scope. Scope trade records retained/removed scope text and returns to author revision. Budget/baseline choices record old and new governing values plus rationale. Abort uses the existing run-abort handler after the decision append; handler parity tests assert the same terminal record as CLI abort.

**Resolved causes do not re-gate unchanged state.** Persist each review snapshot's effective causes after folding decisions that already existed for that round; retain suppressed causes separately with `resolvedBy` for audit. Keep plan-208 budget alerts visible, but remove a gate cause when an active decision covers it. An active, unsuperseded `retain_baseline` or `adjust_baseline` resolves the immutable `baseline_disputed` cause at run scope for every later snapshot; adjustment also folds the new governing `B` into budget bands. `request_author_reestimate` deliberately does not resolve the dispute: it closes the current gate, marks re-estimate pending, and the next baseline-dispute gate offers only retain, adjust, or abort so re-estimate cannot loop. Architecture approval records `approvedP` and approved threshold-crossing item/work-item IDs, and applies only while current burden stays within that envelope. Other baseline/budget changes and finding deferrals are recomputed rather than blindly suppressed. Scope trade closes the current snapshot's gate and requires a new review snapshot instead of creating a successor from stale causes.

**Fingerprinting is deterministic but does not replace stable IDs.** Hash canonical JSON containing normalized title, scope class, named requirement/failure, and lowest-cost correction—not volatile priority, estimate, or prose formatting. Persist both `findingId` and `fingerprint`. A later item with the same ID but different fingerprint is changed evidence, not silently the same risk.

**Debt policy reuses advisory evidence.** Do not recalculate debt eligibility in handlers. The governance validator checks that every credited claim has plan-208 complete evidence, reviewer eligibility, `intrinsic` coupling, a valid target phase, and a genuinely simpler `After` state. `adjacent` and `unrelated` claims receive no credit and become follow-up/human-scope observations; gross effort and gross positive burden are never netted away.

**Readiness normalization is deterministic.** In enforced mode, `ready_with_corrections` is valid only when all items are `auto_fix`, combined remaining effort is at most one point, every architecture delta is zero, no item requires reviewer verification, and projected effort is within the effective ceiling. A valid result routes to one final author pass and then completion without another reviewer. A budget/semantic alert routes to a gate; other invalid uses normalize to `not_ready` and a closure cycle. Advisory mode records the hypothetical result while preserving v1 route behavior.

**Advisory convergence is diagnostic, not rejecting.** The run-pinned mode controls validation behavior. Advisory templates request closure evidence and validation records diagnostics/hypothetical outcomes, but malformed/missing closure evidence does not reject the verdict or alter v1 routing. Enforced mode fails closed. `off` and v1-compatible runs retain their existing contracts.

---

## Architecture Overview

```text
reviewer-plan (round 1)                reviewer-plan-continued (round N)
  exhaustive + independent estimate      prior findings + decisions + exact plan diff
                    │                                      │
                    └──────────── ReviewerVerdict ──────────┘
                                      │
                         protocol validate / invoke --record
                                      │
                 ┌────────────────────┴─────────────────────┐
                 │ validate protocol/item/debt contracts     │
                 │ validateClosureReview(diff, prior, ledger)│
                 │ applyPlanReviewBudget (plan 208)           │
                 │ derivePlanReviewGovernance (pure)          │
                 └────────────────────┬─────────────────────┘
                                      │
            decorated reviewer step + budget snapshot + governance result
                                      │
               advisory: v1 route     │      enforced: deterministic route
                                      ▼
             complete | author_revision | final_corrections | human_gate
                                                               │
                                       typed prompt / exported action (CAS)
                                                               │
                                         append decision + human step atomically
                                                               │
                                     fold governing B/scope/risk ledger; resume

RecordStore: steps.jsonl + budget.jsonl + decisions.jsonl (authority)
SQLite: reviewer/budget/decision/gate projections (rebuildable local index)
```

`PlanReviewGovernanceResult` is placed beside plan 208's `budget` decoration in the recorded reviewer result. It contains CLI-derived route, normalized readiness, gate causes, prior-finding outcomes, and advisory diagnostics; it never accepts reviewer-authored aggregate fields. Follow-ups remain Markdown-only and are not routing input.

---

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Define governance types, finding fingerprints, and pure closure validation | 5 | 1 | - | P0.4, P1.7, P2.1 | Adds a shared policy subsystem and canonical identity abstraction; +1 reflects that maintenance surface. Tests are included. |
| W2 | Add immutable review decisions, derived gates, governing-state fold, codecs, and index rebuild | 8 | 2 | - | P0.2, P0.3, P1.4, P1.5, P1.6, P2.1 | Adds an authoritative record kind, deterministic fold, run-level baseline resolution, explicit choice/cause coverage, successor-gate projection, and migration; +2 reflects persistent change points. The row remains 8 because run-level resolution clarifies the already-scoped fold/gate lifecycle. |
| W3 | Extend reviewer protocol and validate exact introducing plan hunks | 5 | 0 | - | P0.4, P1.3, P1.6 | Adds top-level prior outcomes and full-patch validation while reusing plan-208 item fields; tests cover truncation and exact evidence. |
| W4 | Derive mode-aware routes, suppress resolved causes, and normalize `ready_with_corrections` | 5 | 0 | - | P0.3, P1.1, P1.4, P1.7, P1.9 | One pure matrix handles pinned advisory diagnostics, enforced routing, cause approvals, deferral-before-budget filtering, and post-decision precedence. The clarified matrix does not add a new implementation surface, so effort stays 5. |
| W5 | Implement gate-scoped decision CAS, terminal input, and post-decision orchestration | 8 | 2 | - | P0.1, P0.2, P1.4, P1.5, P1.9, P2.1, P2.3, P2.4, P2.5, P2.6 | Adds the cross-process CAS, finalize-seam extension, choice/cause routing, CLI-resolved finding IDs, complete payload contract, and stale-safe decision handler; +2 reflects that persistent concurrency boundary. It remains 8 after notification work moves to W10 because the rubric tops out while the CAS/handler work remains independently maximum-sized. |
| W6 | Integrate governance with plan-208 recording and author/reviewer prompt context | 5 | 0 | - | P0.4, P1.2, P1.6 | Wraps `recordPlanReviewerStepWithSnapshot`, folds governing `B`, and injects decisions into both author and reviewer prompts. |
| W7 | Rewrite reviewer/author templates and plan-review skills for closure routing | 3 | 0 | - | P0.4, P1.1, P1.2, P1.3, P1.9, P2.4, P2.6 | Adds mode-conditional instructions, prior outcomes, governing-author context, full-diff retrieval, durable post-decision branching, and commands using CLI-resolved finding IDs. The input clarification fits the existing skill rewrite, so effort stays 3. |
| W9 | Complete end-to-end compatibility, audit, follow-up handoff, and documentation coverage | 5 | 0 | - | P0.1, P1.6, P2.2, P2.4, P2.6 | Removes dashboard parity scope, validates CLI/process races, documents the intentional ID gap and decision-input syntax/identity resolution, and records the dashboard follow-up. The added syntax documentation is part of the existing CLI-doc pass, so effort stays 5. |
| W10 | Add review-gate notification, decision-key wait, and PromptStore safeguards | 3 | 0 | - | P1.8, P2.5, P2.6 | Split from saturated W5 in response to Addendum 2. Covers typed notification metadata (including display-safe finding identities), rejection in both prompt stores, internal projection repair, and decision-key waiting without adding another authority. The added identity list uses existing snapshot data, so effort stays 3. |

### Surface Snapshot

- Subsystems: 6
- Production files: 24
- Persistent/external boundaries: 2
- New shared abstractions: 3
- New persistent schemas: 1

Phase 8 and W8 are intentionally vacant after the dashboard split; stable IDs are not renumbered or reused.

---

## Phase 0: Prerequisite reconciliation

**Completion gate:** On the post-208 merge base, every `src/...:line` reference and imported symbol in this plan resolves, and no planned module duplicates plan 208's arithmetic, context, or paired writer.

- [ ] Confirm `ReviewBudgetCommandContext` and `createReviewBudgetContext` in `src/commands/review-budget-context.ts`.
- [ ] Confirm `applyPlanReviewBudget` and add its `governingBaseline` input; do not mutate/re-append the immutable baseline.
- [ ] Confirm `recordPlanReviewerStepWithSnapshot` is the sole reviewer step/snapshot writer and compose governance inside/around it rather than creating `PreparedPlanReviewRecord`.
- [ ] Confirm `finalizeAndWritePreparedStep` owns iteration allocation; extend its paired mode with a typed `coupled-key-exists` result for existing extra-op keys before omitted-iteration retry/pair-corruption checks.
- [ ] Confirm `VerdictItem` already owns `scopeClass`, deltas, coupling, confidence, and `creditClaim`; add only closure-specific protocol fields.
- [ ] Identify and update `ENFORCED_REVIEW_BUDGET_WARNING`, run-state/config “enforced not implemented” text, and their tests when enforcement lands.
- [ ] Pin `governanceMode: "advisory" | "enforced"` in the baseline payload at activation; existing baseline records without it decode as `advisory`. Mode `off` creates no baseline. Later config changes do not alter active runs.

---

## Phase 1: Governance domain and convergence policy

**Completion gate:** Pure governance tests pass without importing command handlers, SQLite, dashboard modules, or git subprocesses. Initial/continued contracts, fingerprint stability, prior-finding closure, re-raise rules, critical-safety exceptions, and debt guardrails are deterministic.

### 1.1 Domain types — new `src/review-governance/types.ts`

Define the shared vocabulary once and import plan-208 types rather than restating budget arithmetic.

```typescript
export type PriorFindingStatus =
  | "addressed"
  | "partially_addressed"
  | "still_open";

export interface IntroducedByPlanHunk {
  commitRange: string;
  diffHunk: string;
  explanation: string;
}

export interface PriorDecisionEvidence {
  priorDecisionId: string;
  newEvidence: string;
}

export type PlanReviewRoute =
  | "complete"
  | "author_revision"
  | "final_corrections"
  | "human_gate";

export type ReviewDecisionRoute = PlanReviewRoute | "aborted";

export interface FindingIdentity {
  findingId: string;
  fingerprint: string;
}

export interface PriorFindingOutcome {
  id: string;
  status: PriorFindingStatus;
}

export interface PlanReviewGovernanceResult {
  reviewKind: "initial" | "closure";
  normalizedReadiness: ReviewerVerdict["readiness"];
  route: PlanReviewRoute;
  gateCauses: ReviewGateCause[];
  findingOutcomes: Array<FindingIdentity & { status: PriorFindingStatus }>;
  diagnostics: ClosureDiagnostic[];
  hypotheticalEnforcedRoute?: PlanReviewRoute; // advisory telemetry only
}
```

- [ ] Add discriminated types for critical-safety, introduced-hunk, prior-decision/new-evidence, debt eligibility, route cause (including optional `resolvedBy`), and validation diagnostics. Follow-ups remain review-Markdown prose.
- [ ] Keep implementation-review enums out of this module.
- [ ] Export the public structural types from `src/index.ts` only after the module has no handler/SQLite dependency.

### 1.2 Canonical finding fingerprints — new `src/review-governance/fingerprint.ts`

```typescript
export function canonicalFindingFingerprint(input: {
  title: string;
  scopeClass: PlanScopeClass;
  failure: string;
  lowestCostCorrection: string;
}): string; // `sha256:<lowercase hex>`
```

- [ ] Normalize Unicode, line endings, whitespace, and case only where semantics are case-insensitive; sort object keys before SHA-256.
- [ ] Exclude estimates, priority, reviewer prose formatting, and mutable closure status.
- [ ] Test stable hashes across key order/line endings and changed hashes when failure, scope class, or correction changes.

### 1.3 Closure validation — new `src/review-governance/closure.ts`

```typescript
export function validateClosureReview(input: {
  reviewKind: "initial" | "closure";
  mode: "advisory" | "enforced";
  verdict: ReviewerVerdict;
  priorFindings: readonly PersistedFinding[];
  priorDecisions: readonly ReviewDecision[];
  diffContext?: PlanDiffContext;
}): ClosureValidationResult;
```

- [ ] Initial review: require material failure, `scopeClass`, deltas/confidence, and `lowestCostCorrection` on every routing item; preserve plan-208 initial baseline/debt requirements.
- [ ] Define the required-outcome set as prior recorded plan-review items whose latest outcome is not `addressed` and that are not covered by an active defer/accept decision. Require exactly one top-level `priorFindings[]` outcome for each; reject unknown/duplicate/omitted IDs in enforced mode.
- [ ] Require `partially_addressed` and `still_open` IDs to also appear once in `items[]` with remaining `effortDelta`; require `addressed` IDs to be absent from `items[]`. Thus only still-blocking work enters plan-208 `R`, `P`, and author routing.
- [ ] New ordinary blocking item: require `introducedBy`; critical late issue: require `lateDiscovery: "critical_safety"` and concrete safety evidence; prohibit both fields together.
- [ ] Re-raised deferred/accepted-risk item: require the matching `priorDecisionId`, matching fingerprint/scope, and non-empty materially new evidence.
- [ ] Permit `adjacent` debt in `items[]` only with `action: "human_required"` (no credit; routes to scope gate). Reject `unrelated` debt from `items[]`; it is Markdown-only follow-up. Reference this single rule from routing.
- [ ] In advisory mode, return the same closure violations as diagnostics and continue with unmodified verdict/v1 routing; only enforced mode rejects. Off/v1-compatible runs skip this validator.
- [ ] Add `test/unit/review-governance/{fingerprint,closure,debt-policy}.test.ts` with ordinary missed issue, critical exception, changed fingerprint, stale decision, and complete/incomplete debt evidence cases.

---

## Phase 2: Durable decisions and governing-state fold

**Completion gate:** Memory and working-tree store contract tests append and fold identical decision history; repeated keys do not overwrite; SQLite index deletion/rebuild reproduces governing baseline, run-level baseline-dispute resolution/re-estimate state, approved scope, accepted risks, and decision order.

### 2.1 Decision records — new `src/review-governance/decisions.ts`

Store authoritative decisions in the existing `decisions` stream. Do not add a second authoritative SQLite repository.

```typescript
export type ReviewDecisionChoice =
  | "increase_budget"
  | "adjust_baseline"
  | "retain_baseline"
  | "request_author_reestimate"
  | "trade_scope"
  | "defer_accept_risk"
  | "approve_architecture_burden"
  | "abort";

export interface ReviewDecisionPayload {
  kind: "plan-review-governance";
  decisionId: string; // UUID
  gateId: string;     // deterministic SHA-256/UUIDv5-derived identity
  forecastId: string; // immutable budget snapshot/forecast identity
  choice: ReviewDecisionChoice;
  decisionIntentHash: string; // canonical choice + human-supplied fields
  findingRefs: FindingIdentity[];
  rationale: string;
  evidence: string[];
  approvedScope: { retained: string[]; removed: string[] };
  governingBaselineChange?: { from: number; to: number };
  architectureApproval?: {
    approvedP: number;
    approvedItemIds: string[];
    approvedWorkItemIds: string[];
  };
  supersedesDecisionId?: string;
  createdAt: string;
}

export interface GoverningReviewState {
  governingBaseline: number;
  baselineDisputeResolution?: {
    decisionId: string;
    choice: "retain_baseline" | "adjust_baseline";
  };
  baselineReestimatePending?: { decisionId: string };
  approvedScope: ApprovedScope;
  acceptedRisks: AcceptedRisk[];
  architectureApprovals: ArchitectureApproval[];
  aborted: boolean;
  history: ReviewDecisionPayload[];
}
```

- [ ] Validate choice-specific fields: positive integer baseline, non-empty rationale, scope delta for `trade_scope`, finding refs/evidence for risk deferral, and no baseline mutation for `abort`.
- [ ] Compute `decisionIntentHash` without generated `decisionId`/`createdAt`; use it to recognize a semantic retry of the winning gate decision.
- [ ] Gate resolution uses `decision:review-gate:<gateId>`; later corrections use `decision:review:<decisionId>` plus `supersedesDecisionId`. Retain insertion order and never update a line.
- [ ] Fold from plan-208 immutable `B0` plus insertion-ordered decisions; only payloads with `kind: "plan-review-governance"` participate. Silently ignore existing `human-step` and `answered-prompt` kinds; diagnose only malformed/unknown governance versions.
- [ ] Distinguish acceptance-time staleness from normal later rounds. A decision appended after its `forecastId` ceased to be current remains audit-only and never enters the fold. A decision accepted while its forecast was current remains active across later snapshots according to its choice semantics until superseded: in particular retain/adjust baseline resolution, governing `B`, approved scope, and accepted risks persist. Folded governing `B` is passed to pure `deriveBudget`; post-decision recompute never appends a snapshot (snapshot ↔ reviewer step remains 1:1).
- [ ] Fold `retain_baseline`/`adjust_baseline` into `baselineDisputeResolution` at run scope and clear any pending re-estimate marker. Fold `request_author_reestimate` into `baselineReestimatePending` without resolving `baseline_disputed`; a later retain/adjust supersedes and clears it.

### 2.2 Derived gates and review facade — new `src/review-governance/store.ts`, `codec.ts`

```typescript
export interface ReviewGovernanceStore {
  getDecision(runId: string, decisionId: string): ReviewDecisionPayload | null;
  listDecisions(runId: string): ReviewDecisionPayload[];
  deriveOpenGate(runId: string): DerivedReviewGate | null;
  resolveGate(input: ResolveReviewGateInput): ResolveReviewGateResult;
  deriveGoverningState(runId: string, b0: number): GoverningReviewState;
}
```

- [ ] Implement as a facade over `RecordStore`, `PromptStore`, and `ReviewBudgetCommandContext`; command logic must not import `bun:sqlite`.
- [ ] At reviewer-record time, fold every decision that predates that round and persist the resulting **effective unresolved causes** on the snapshot. Persist causes suppressed by that pre-existing fold separately with `resolvedBy` for audit; do not put them back into the first gate. Derive the first `gateId` from `(runId, snapshotId/forecastId, sorted effective causes)`—never from causes recomputed after a later decision.
- [ ] A gate is resolved iff `decision:review-gate:<gateId>` exists. Apply the choice/cause rules below, recompute uncovered causes from the same snapshot where applicable, and derive at most one successor from `(runId, snapshotId, sorted remaining causes, predecessorGateId)`. A resolved predecessor never reopens; a newer reviewer snapshot supersedes the chain.
- [ ] Treat typed prompts and `review_gate_index` as projections keyed by deterministic `gateId`; after record-first resolution, close/answer an open prompt best-effort. Repair recreates missing prompts for unresolved gates and closes prompts for resolved gates.
- [ ] Codec only the governance decision payload; there is no authoritative gate record/codec. Preserve unknown governance versions as diagnostics.

#### Choice-to-cause coverage and gate lifecycle

| Choice | Cause effect | Successor behavior |
|---|---|---|
| `increase_budget` | Fold the new governing `B`; filter active deferrals, rerun `deriveBudget`, and use the newly derived band/other causes. It does not blindly mark an old band covered. | Create one successor only if the authoritative rerun still returns `human_gate`. |
| `adjust_baseline` | Persist run-level baseline resolution with `resolvedBy`, fold the new governing `B`, and recompute budget bands and all remaining causes. Every later snapshot suppresses immutable `baseline_disputed` while this decision is active. | Create one successor only if the authoritative rerun still returns `human_gate`. |
| `retain_baseline` | Persist run-level baseline resolution with `resolvedBy`; keep `B` unchanged and recompute all other causes. Every later snapshot suppresses immutable `baseline_disputed` while this decision is active. | Create one successor only if the authoritative rerun still returns `human_gate`. |
| `defer_accept_risk` | Cover only causes tied to the exact approved finding IDs/fingerprints. Remove those findings before both `deriveBudget` and readiness routing. | Create one successor only for causes remaining after the authoritative rerun. |
| `approve_architecture_burden` | Cover the architecture cause only while `P` and the threshold-crossing item/work-item set remain inside the recorded approval envelope. | Create one successor only for other uncovered causes; growth outside the envelope re-gates on the next applicable derivation. |
| `trade_scope` | Record retained/removed scope, but do not pretend the old snapshot's budget causes were covered. | Close this snapshot's gate with `author_revision`; skip successor derivation. The next reviewer snapshot recomputes causes for the changed scope. |
| `request_author_reestimate` | Record a pending re-estimate without covering run-level `baseline_disputed`. | Close this snapshot's gate with `author_revision`; skip successor derivation. If the next snapshot still disputes the baseline, its gate offers only `retain_baseline`, `adjust_baseline`, and `abort`; another re-estimate is invalid until retain/adjust clears the marker. |
| `abort` | Record the terminal choice; it covers no individual cause. | Close the gate with `aborted`, skip successor derivation, then run terminal handling as the post-append side effect. |

### 2.3 Rebuildable index — `src/db/schema.ts` after plan 208's migration; new `src/review-governance/sqlite-index.ts`

- [ ] Add the next available migration after prerequisites for `review_decision_index`, derived `review_gate_index`, and optional versioned prompt context; use stable TEXT keys, `record_seq`, and run/forecast indexes.
- [ ] Implement write-through upserts and `reindexReviewGovernance(recordStore, db, runId?)` using record insertion order, not second-resolution timestamps.
- [ ] Extend the prerequisite records-index/backfill dispatch only to project existing decision lines; do not backfill invented governance decisions from generic historical human steps.
- [ ] Add fresh/upgrade schema tests, equal-timestamp ordering, wiped-index/gate rebuild, malformed-governance diagnostics, no-decision compatibility, a three-kind decision fixture, and a two-cause chain where the first decision leaves one successor and the predecessor never reopens. Assert the next reviewer snapshot persists only effective unresolved causes while retaining earlier suppressed causes as `resolvedBy` audit entries, including run-level retained/adjusted baseline resolution.

---

## Phase 3: Closure protocol and plan-diff evidence validation

**Completion gate:** Protocol emit/validate accepts all initial and closure fields, rejects reviewer-authored routing/aggregates, and validates cited introducing hunks against the exact plan-only diff. Unit and integration tests cover changed HEAD caused solely by the review artifact.

### 3.1 Extend reviewer contract — `src/protocol.ts:16–100`, `src/protocol-normalize.ts`

Plan 208 already adds budget item fields. Add only closure-specific item fields plus a separate top-level prior-outcome array; active, run-pinned mode determines whether closure violations reject or become diagnostics.

```typescript
export type VerdictItem = {
  // existing fields
  lowestCostCorrection?: string;
  failure?: string;
  introducedBy?: IntroducedByPlanHunk;
  lateDiscovery?: "critical_safety";
  lateDiscoveryEvidence?: string;
  priorDecisionId?: string;
  newEvidence?: string;
  requiresReviewerVerification?: boolean;
};

export type ReviewerVerdict = {
  // existing fields from plan 208
  priorFindings?: PriorFindingOutcome[]; // closure-only, not routing items
};
```

- [ ] Preserve v1/off and mid-review compatibility rules from plan 208; do not require plan fields for implementation-phase verdicts.
- [ ] Reject top-level `reviewRoute`, `normalizedReadiness`, `gateCauses`, budget totals/status, or decision outcomes as CLI-owned keys.
- [ ] Extend `protocol emit reviewer` with repeatable `--prior-finding '<json>'`; prior outcomes do not imply corrections. `--ready` plus only `addressed` outcomes emits `ready` with empty `items[]`.
- [ ] Preserve plan-208 item fields; complex blocker evidence remains in repeated `--item` JSON. Follow-ups stay in review Markdown and have no protocol flag/count.

### 3.2 Shared diff context — refactor `src/commands/template-vars.ts:329–425`; new `src/review-governance/plan-diff.ts`

```typescript
export interface PlanDiffContext {
  previousReviewCommit: string;
  currentPlanCommit: string;
  planPath: string;
  patch: string;
  hunks: Array<{ header: string; text: string; hash: string }>;
}

export async function buildPlanReviewDiffContext(input: {
  workdir: string;
  planPath: string;
  previousReviewCommit: string;
  currentCommit?: string;
}): Promise<PlanDiffContext>;

export function validateIntroducedBy(
  evidence: IntroducedByPlanHunk,
  context: PlanDiffContext,
): EvidenceValidation;
```

- [ ] Make both prompt rendering and validation call the shared builder; it always computes the full patch/hunks. Keep truncation and Markdown formatting outside the validator.
- [ ] Normalize only diff transport artifacts (line endings and trailing whitespace), then require a complete hunk header and changed lines to match one computed hunk; reject snippets assembled across hunks.
- [ ] Require `commitRange` start to equal the prior reviewer step head. Accept an end commit only when its plan-only patch is byte-equivalent to the rendered context, allowing a later review-document-only commit.
- [ ] If Markdown truncates the body (currently `getFileDiffSummary` caps at 200 lines), append the commit range, every omitted hunk header, and an exact `git diff <range> -- <plan>` command so the reviewer can retrieve the rest.
- [ ] Fail enforced mode with `PLAN_DIFF_CONTEXT_MISSING`, `INTRODUCED_RANGE_MISMATCH`, or `INTRODUCED_HUNK_NOT_FOUND`; include the closest hunk header in hunk-not-found diagnostics. Advisory records these diagnostics without rejection.
- [ ] Test renamed plan paths, no plan change, binary rejection, a cited hunk after rendered line 200, abbreviated SHA ambiguity, stale ranges, and exact hunk matching.

### 3.3 Protocol command integration — `src/commands/protocol.handler.ts:378–517`, `src/commands/protocol.ts:102–184`

- [ ] Resolve review kind and prior reviewer step only after ambient run/phase identity is known; standalone structural validation remains available without governance application.
- [ ] For `reviewer --phase plan --record` on active budget runs, load the pinned baseline mode, prior findings/decisions, rebuild diff context, and call `validateClosureReview` before writing the success envelope.
- [ ] In enforced mode, surface line/item-specific errors in one envelope and write nothing on failure. In advisory mode, attach diagnostics and continue through unchanged v1 recording/routing.
- [ ] Add tests for first review, separate prior outcomes, `--ready` + addressed-only, remaining-item matching, exact hunk, critical safety, prior-decision re-raise, malformed aggregates, advisory diagnostics, and no-record validation.

---

## Phase 4: Deterministic enforced routing and readiness normalization

**Completion gate:** A table-driven routing matrix covers every budget band, alert, semantic action, choice-to-cause transition, review kind, readiness, and mode. Filtered-budget reruns are authoritative except for explicit scope/re-estimate/abort closures. Enforced output is deterministic; advisory/off preserve their documented routes.

### 4.1 Pure router — new `src/review-governance/routing.ts`

```typescript
export function derivePlanReviewGovernance(input: {
  mode: "advisory" | "enforced"; // pinned baseline mode
  reviewKind: "initial" | "closure";
  verdict: ReviewerVerdict;
  budget: DerivedBudgetResult;
  closure: ClosureValidationResult;
  governingState: GoverningReviewState;
}): PlanReviewGovernanceResult;
```

Routing precedence in enforced mode:

1. Existing accepted-risk decision without valid new evidence removes that finding from blocking input; invalid re-raise has already failed validation.
2. Remove causes covered by active unsuperseded decisions, recording `resolvedBy`: run-level retain/adjust resolution suppresses immutable `baseline_disputed` on every later snapshot (adjust also changes `B` for band recomputation); architecture approval covers only `P <= approvedP` and the recorded threshold-crossing IDs. Growth beyond the architecture envelope re-gates. A pending author re-estimate does not suppress the dispute.
3. Remove findings covered by active deferral from the budget and readiness inputs, then recompute plan-208 budget from the latest snapshot with folded governing `B`; do not append a snapshot.
4. `lateDiscovery: critical_safety`, any semantic `human_required` (including allowed adjacent debt), uncovered baseline/architecture alert, or over-effective/absolute band → `human_gate`.
5. `ready` with no required items → `complete`.
6. Strictly valid `ready_with_corrections` → `final_corrections`.
7. Remaining required corrections → normalize to `not_ready` and `author_revision` (followed by closure review).

- [ ] Keep gross forecast, effective/absolute limits, positive burden, and provisional debt fields unchanged from plan 208 in output; the router selects a route only.
- [ ] Derive gate causes as stable enums with item/claim references and optional `resolvedBy`; no prose parsing in skills or future adapters.
- [ ] In advisory mode record closure diagnostics plus the hypothetical enforced route, but return the existing v1 route and never reject. In off/v1-compat mode omit governance routing decoration.

### 4.2 `ready_with_corrections` validator — same module

```typescript
export function validateFinalCorrections(input: {
  items: readonly VerdictItem[];
  projectedEffort: number;
  effectiveCeiling: number;
}): { valid: true } | { valid: false; reasons: FinalCorrectionFailure[] };
```

- [ ] Require all-auto-fix, combined effort `<= 1`, zero architecture delta, no reviewer-verification flag, no critical/prior-decision exception, and forecast within the effective limit.
- [ ] Count the correction effort in the forecast before accepting the shortcut.
- [ ] If a budget/semantic cause exists, route human rather than normalize; otherwise normalize to `not_ready`.

### 4.3 Post-decision route — same module

```typescript
export function routeAfterDecision(input: {
  latestVerdict: ReviewerVerdict;
  latestBudgetSnapshot: ReviewBudgetSnapshotRecord;
  newGoverningState: GoverningReviewState;
  decision: ReviewDecisionPayload;
}): ReviewDecisionRoute;
```

- [ ] Build filtered inputs first: remove every finding covered by an active deferral before both `deriveBudget` and readiness routing, fold governing `B`, then rerun `derivePlanReviewGovernance` against the latest snapshot. That pure rerun is authoritative for every fold-changing/covering choice; never trust a route supplied by the caller.
- [ ] For `increase_budget`, `adjust_baseline`, `retain_baseline`, `defer_accept_risk`, and `approve_architecture_burden`, return the authoritative recomputed route unchanged: `complete` when no required work/cause remains, `final_corrections` when the strict shortcut qualifies, `author_revision` for remaining ordinary corrections, or one deterministic successor `human_gate` for uncovered causes.
- [ ] Apply choice-specific overrides only to choices that deliberately close the current snapshot rather than using a fold change to cover its causes: `trade_scope` and `request_author_reestimate` return `author_revision`, and `abort` returns `aborted`. These three skip successor derivation; abort terminal handling runs afterward as a side effect, never before route derivation.
- [ ] `5x review gate show` and `5x review decide` expose this durable derived route for skill branching.

### 4.4 Routing tests — new `test/unit/review-governance/routing.test.ts`

- [ ] Cover each band, baseline direction, cumulative/single architecture alert, action, valid/invalid final correction, initial/closure, and pinned advisory/enforced mode.
- [ ] Add post-decision rows: retain or adjust in round 1 records `resolvedBy` and keeps `baseline_disputed` out of round 2's first-gate causes; adjust still recomputes bands against folded `B`; a re-estimate leaves the next round's dispute active but limits that gate to retain/adjust/abort. Approved architecture does not re-gate unchanged burden; larger `P` or a new threshold-crossing ID re-gates.
- [ ] Add post-decision route rows: deferral filters findings before budget and readiness and completes when it removes the only blockers; increase/adjust/retain return the authoritative complete/final-correction/revision/successor route; scope trade/re-estimate revise without a successor even when the old snapshot was over budget; abort derives `aborted` before terminal handling.
- [ ] Cover every row in the choice-to-cause table, including unrelated remaining causes, a deferred finding that previously caused `over_effective`, and a pre-existing resolved cause that must not enter a later snapshot's first gate.
- [ ] Assert reviewer readiness and authored aggregate-like fields cannot override the CLI route.
- [ ] Assert eligible intrinsic debt expands only the effective limit supplied by plan 208 and never changes displayed gross effort/positive burden.

---

## Phase 5: Human gate prompt and decision actions

**Completion gate:** Enforced human routes derive one typed notification/wait gate; equivalent flag, JSON, and stdin submissions reach one validated handler. Two independent CLI processes race through the plan-208 finalize seam and one gate-scoped RecordStore CAS. Simultaneous and after-winner losers observe the winner without iteration retry/corruption errors. Generic prompt answers are rejected, the wait follows the decision key, and stale decisions trigger no side effect.

### 5.1 Typed gate coordination — extend merged prompt types/store and migration

Extend the merged prompt queue with optional structured metadata rather than encoding JSON in the message. This is a CLI/control-plane seam, not dashboard implementation.

```typescript
export interface ReviewGatePromptContext {
  type: "plan_review_gate";
  gateId: string;
  forecastId: string;
  causes: ReviewGateCause[];
  eligibleFindings: FindingIdentity[]; // display/read model; flags still accept IDs only
  allowedChoices: ReviewDecisionChoice[];
  requiredFieldsByChoice: Record<ReviewDecisionChoice, string[]>;
}
```

- [ ] Add nullable, versioned prompt context to `PromptRecord`/stores; existing prompts remain unchanged. Export a redacted view DTO for later authenticated adapters.
- [ ] Treat `plan_review_gate` prompts as notifications and wait handles only. They cannot encode rationale/evidence/scope/baseline fields in `answer: string` and are never the decision authority.
- [ ] Make both PromptStore implementations' generic `answerPrompt` (and therefore every command/action adapter) reject this context with `REVIEW_GATE_DECISION_REQUIRED` and remediation naming `5x review decide --gate <id>`; do not append an `answered-prompt` line.
- [ ] Add an internal `resolveReviewGatePrompt(promptId, decisionId)` projection method valid only for `plan_review_gate`; it closes the notification with the winning decision ID after the record append and does not snapshot a second human decision.
- [ ] Render explicit allowed choices based on causes: baseline disputes include adjust/retain/re-estimate/scope/abort, except a pending re-estimate narrows the next baseline-dispute gate to adjust/retain/abort; budget excess includes increase/scope/defer/abort; architecture alerts include approve/scope/defer/abort; semantic items include scope/defer/abort only where deferral is safe.
- [ ] Never offer risk deferral for an unscoped critical safety issue without an explicit accepted-risk payload and evidence; the final action is still human-owned.

### 5.2 Decision action — new `src/commands/review-decision.handler.ts`, `src/commands/review.ts`

```typescript
export async function submitPlanReviewDecision(
  input: SubmitPlanReviewDecisionInput,
  deps?: ReviewDecisionDeps,
): Promise<{ decision: ReviewDecisionPayload; created: boolean; route: ReviewDecisionRoute }>;
```

- [ ] Register `5x review gate show` and `5x review decide`; resolve ambient run using normal command rules. Export the actor/origin-aware handler for a later authenticated adapter.
- [ ] Define the terminal contract as `5x review decide --gate <id> --choice <choice> --rationale <text>` plus repeatable `--evidence <text>`, `--finding <findingId>`, `--retain <scope>`, `--remove <scope>`, `--approved-item <id>`, and `--approved-work-item <id>`, with integer `--baseline <B>` and `--approved-p <P>` where required. For each `--finding` ID, the CLI loads the latest gate snapshot and resolves the authoritative fingerprint; reject unknown, duplicate, stale, or non-gate finding IDs rather than accepting a caller-authored hash. Reject duplicate-scalar and choice-inapplicable fields.
- [ ] Also accept `--gate <id> --input-json '<SubmitPlanReviewDecisionPayload JSON>'` or `--input-json -` from stdin. Only this machine-oriented JSON form accepts full `findingRefs`; validate every supplied ID/fingerprint pair against the latest gate snapshot. JSON input is mutually exclusive with `--choice` and all choice-specific flags, uses the same validator, and excludes CLI-owned actor/origin/generated IDs. `review gate show` prints `requiredFieldsByChoice`, JSON field names, every eligible finding's ID plus fingerprint, and a redacted example command in text and structured output.
- [ ] Validate choice/payload against the gate, expected forecast, current run status, plan-208 limits, and current decision fold before any write.
- [ ] Pre-read `decision:review-gate:<gateId>` **before `prepareRecordStepAppend` and finalization**; return/compare the winner immediately when present, including when the run is already at its step limit.
- [ ] Route a new write through `finalizeAndWritePreparedStep({ mode: "paired-all-new", extraOps })`, supplying the gate decision op and suppressing the generic `human-step` mirror. Extend that shared seam so `created:false` checks existing `extraOps` keys before iteration-collision logic and returns `{ outcome: "coupled-key-exists", key, line }` instead of retrying or throwing.
- [ ] On the coupled-key outcome, load the winner: matching `decisionIntentHash` returns `created:false`; a different intent returns `REVIEW_GATE_ALREADY_RESOLVED`. Only true step-key races retain plan 208's omitted-iteration retry; unrelated missing-step/existing-snapshot remains corruption.
- [ ] Preserve plan 208 behavior by having `recordPlanReviewerStepWithSnapshot` map a snapshot-only coupled-key outcome back to `RECORD_PAIR_CORRUPT`; only the governance decision caller treats its gate-key outcome as an idempotent winner.
- [ ] Write records first, but defer `resolveReviewGatePrompt` until the post-append current-gate check below. The repair pass can later close an old prompt from its decision record and recreates a notification when a current unresolved derived gate lacks one.
- [ ] Immediately after the durable append, re-read the latest snapshot/derived current gate **before** folding this decision, deriving a route, or running any abort/baseline/scope/prompt side effect. If stale, skip all of them and return `REVIEW_GATE_STALE`; retain the line as non-governing audit history.
- [ ] Only when still current, fold the decision, call `routeAfterDecision`, then apply side effects from that derived route: resolve the notification prompt, pure-recompute forecast for baseline changes (no snapshot), project scope/risk/re-estimate context, or call existing abort handling. Never use a pre-append route.

### 5.3 Prompt wait and cross-process concurrency tests

- [ ] Add a review-gate wait helper that polls `RecordStore.getLine(..., "decisions", gateKey)` with the existing timeout/lifecycle cancellation model; it does not wait for `PromptRecord.answer`.
- [ ] Add terminal flag/JSON/stdin parsing and structured-input validation plus an exported action contract; all callers must use `submitPlanReviewDecision`. Generic prompt answer attempts return the structured remediation error.
- [ ] In `store-contract.test.ts`, race two independently constructed facades over one working-tree records root; assert exactly one gate decision and one human step for same and conflicting payloads. A spawned CLI integration test covers the real process boundary.
- [ ] Test simultaneous loser, after-winner loser allocated at step iteration N+1, repeated-identical/conflicting intent, generic-answer rejection, decision-key wait completion, newer-snapshot stale result with no side effects (including abort), lost-index-write, record-first/prompt-second crash, and prompt repair. Cover equivalent ID-flag/inline-JSON/stdin payloads, CLI fingerprint resolution, mismatched JSON fingerprints, and mutually exclusive or choice-inapplicable input errors.

---

## Phase 6: Recording integration and workflow context

**Completion gate:** `protocol validate --record` and `invoke reviewer --record` produce identical reviewer step, budget snapshot, governance decoration, and route. A later render sees all prior applicable decisions. Duplicate writes repair projections without duplicating any authoritative line.

### 6.1 Governance composition around plan 208 — new `src/review-governance/apply.ts`; extend `src/commands/review-budget-context.ts`

```typescript
export function applyPlanReviewGovernance(input: {
  verdict: ReviewerVerdict;
  budgetResult: Extract<ApplyPlanReviewBudgetResult, { status: "applied" }>;
  context: ReviewBudgetCommandContext;
  governingState: GoverningReviewState;
  mode: "advisory" | "enforced";
}): AppliedPlanReviewGovernance;
```

- [ ] Add optional `governingBaseline` to `applyPlanReviewBudget`; pass folded `B` into `deriveBudget` instead of `baseline.b`. The baseline line remains immutable.
- [ ] Compose governance around `applyPlanReviewBudget` and feed its decorated verdict/pending snapshot to the existing `recordPlanReviewerStepWithSnapshot`; never create a parallel prepared/writer path or duplicate origin construction.
- [ ] Extend plan 208's `FindingDelta` and snapshot payload with `failure`, `lowestCostCorrection`, fingerprint, `priorFindings`, route causes/resolutions, and diagnostics so index deletion can rebuild identity/outcomes. Keep one snapshot per reviewer step.
- [ ] Ensure admission happens before any reviewer snapshot/gate append. A terminal run, missing worktree, invalid diff, invalid verdict, or max-step failure writes nothing.
- [ ] After a unique enforced reviewer record, derive/project a gate only when route is `human_gate`; retries derive the same ID and repair prompt/index projections. Advisory never opens a gate.
- [ ] Remove `ENFORCED_REVIEW_BUDGET_WARNING` and update config/run-state copy and tests from “reserved/advisory telemetry” to implemented pinned-mode behavior.

### 6.2 Wire both reviewer writers — `src/commands/protocol.handler.ts:476–517`, `src/commands/invoke.handler.ts:627–695`

- [ ] Route only recorded `role=reviewer`, `phase=plan`, active budget runs through the composed budget/governance path; all other roles/phases retain existing paths.
- [ ] Keep one success envelope. Post-envelope record failures remain stderr plus nonzero exit, matching current behavior.
- [ ] Share one writer function between native validation and invoke; assert equal idempotency tuple, performer metadata, and decorated `result_json`.
- [ ] Do not open human prompts during structural validation without `--record`.

### 6.3 Review context projection — new `src/review-governance/context.ts`; extend template handler

```typescript
export interface PlanReviewPromptContext {
  reviewKind: "initial" | "closure";
  priorFindings: PersistedFinding[];
  deferredOrAcceptedRisks: Array<{
    decisionId: string;
    finding: FindingIdentity;
    decision: ReviewDecisionChoice;
    rationale: string;
    evidence: string[];
    approvedScope: ApprovedScope;
  }>;
  approvedScope: ApprovedScope;
  governingBaseline: number;
  requestAuthorReestimate: boolean;
}
```

- [ ] Build context from authoritative snapshots/decision lines, not mutable review Markdown or only the SQLite index.
- [ ] Inject every applicable deferred/accepted-risk decision into every later reviewer plan review, including fresh provider sessions; native/invoke continuation must receive the same block.
- [ ] Append a “Governing decisions” block to every `author-process-plan-review` render: finding IDs to skip, retained/removed scope, re-estimate request, and governing `B`. Do not tunnel these facts through `user_notes`.
- [ ] Preserve decisions across author revisions and governing-baseline changes; superseded decisions remain in history but only the active decision governs.
- [ ] Test index wipe, equal timestamps, removed/reintroduced finding IDs, changed fingerprints, and new-evidence re-raise.

---

## Phase 7: Reviewer templates and workflow skills

**Completion gate:** Bundled and installed template/skill tests show initial review is exhaustive, continued review is closure-only, every derived route has an explicit skill branch, and no skill asks a reviewer to compute aggregates or silently bypass a gate.

### 7.1 Initial prompt — `src/templates/reviewer-plan.md:19–112`

- [ ] Require one exhaustive pass across material requirements and known failure paths; prohibit intentionally deferred findings.
- [ ] Require independent baseline assessment, item-level scope/effort/architecture/confidence, concrete prevented failure, and lowest-cost adequate correction.
- [ ] Require debt assessment against coupling and minimal-compliant comparison, while reminding the reviewer that the CLI derives totals/routes.
- [ ] Define nonblocking follow-up placement and strict final-correction meaning.

### 7.2 Closure prompt — `src/templates/reviewer-plan-continued.md:13–47`

- [ ] Replace broad re-review language with top-level `priorFindings[]` closure outcomes first; tell the reviewer that only partial/open findings are repeated in `items[]` under the same ID.
- [ ] Permit a new ordinary blocker only with exact `introducedBy` range/hunk/explanation from the appended plan diff.
- [ ] If the rendered patch is truncated, include omitted hunk headers and the exact command to inspect the full plan-only diff used by validation.
- [ ] Permit pre-existing critical safety only with structured late-discovery evidence and direct human route.
- [ ] Include active deferred/accepted-risk decisions; require `priorDecisionId` and material `newEvidence` to re-raise.
- [ ] Direct adjacent hardening, polish, speculative risk, unrelated debt, and ordinary missed issues to a nonblocking follow-up section, excluded from `items[]`.
- [ ] Render strict “must”/fail-closed prose only for pinned enforced runs. Advisory asks for the same evidence for calibration but states violations become diagnostics and preserve v1 routing.

### 7.3 Author correction prompt — `src/templates/author-process-plan-review.md`

- [ ] Add the generated “Governing decisions” block from Phase 6: deferred IDs not to implement, retained/removed scope, re-estimate request, and governing baseline.
- [ ] Instruct the author to update `Addresses` only for incorporated findings and never silently reintroduce removed/deferred scope.
- [ ] Add render tests for fresh/continued native and invoke paths; free-text `user_notes` is not the source of governing decisions.

### 7.4 Skills — `src/skills/base/5x-plan-review/SKILL.tmpl.md`, `5x-plan/SKILL.tmpl.md`

- [ ] Read `data.result.governance.route` after validation/recording in enforced active runs; never infer gates from reviewer prose or recompute thresholds.
- [ ] Branch `complete`, `author_revision`, `final_corrections`, and `human_gate`. Final corrections invoke one author pass, verify commit/plan parse, record completion, and skip reviewer re-entry.
- [ ] For `human_gate`, present the notification plus `5x review decide` choices; never answer it through generic `5x prompt`. Resume from `routeAfterDecision` returned by `review gate show/decide`, not from stale reviewer readiness or prose.
- [ ] Render commands using the Phase 5 contract: simple decisions use `--gate`, `--choice`, `--rationale`, and choice-required repeatable flags, passing only the displayed finding ID to `--finding`; the CLI resolves its fingerprint. Complex/adapted payloads use `--gate ... --input-json -` with the ID/fingerprint pair returned by `review gate show`. Derive required fields from `requiredFieldsByChoice`, not a duplicated skill-side matrix.
- [ ] Branch post-decision `complete`, `author_revision`, `final_corrections`, successor `human_gate`, and `aborted` explicitly. In delegated noninteractive contexts return `needs_human` instead of opening an interactive prompt.
- [ ] Keep `maxReviewIterations` as backstop for unresolved closure cycles and read it from resolved config.
- [ ] Preserve advisory/off behavior and mid-review v1 compatibility.
- [ ] Update skill/template snapshots and harness freshness content hashes through the existing generator; do not hand-edit installed user assets.

---

## Phase 9: End-to-end audit, compatibility, and documentation

**Completion gate:** Full test suite and typecheck pass. Multi-round enforced fixtures meet the CLI/workflow exit criteria; advisory/off fixtures retain previous routing; documentation records the dashboard split and does not claim implementation-review enforcement.

### 9.1 End-to-end governance scenarios — new `test/integration/commands/plan-review-governance.test.ts`

- [ ] Initial exhaustive review → author revision → top-level closure outcomes → `--ready` with only addressed outcomes and empty routing `items[]`.
- [ ] New ordinary blocker with exact introducing hunk succeeds; stale/fabricated hunk fails without records.
- [ ] Critical late safety issue opens a human gate even when within limits.
- [ ] Deferred/accepted finding stays nonblocking; re-raise without decision/new evidence fails; re-raise with both routes correctly.
- [ ] Baseline dispute, each budget band, architecture threshold, semantic human item, valid/invalid final corrections, and intrinsic/adjacent/unrelated debt claims.
- [ ] Cross-round baseline convergence: retain and adjust in round 1 suppress immutable `baseline_disputed` in round 2 while adjust's `B` still changes bands; re-estimate routes to author once and the next disputed gate exposes only retain/adjust/abort.
- [ ] Every human choice, repeated/conflicting gate-scoped choice, two-process working-tree CAS race, newer-snapshot race, index deletion/rebuild, prompt repair, restart/resume, and full audit history.
- [ ] Simultaneous and after-winner decision losers return the winner (no iteration exhaustion/pair corruption); a two-cause decision creates one successor; generic prompt answer is rejected while decision-key wait resumes.
- [ ] `review gate show` exposes eligible finding IDs/fingerprints; ID-only `--finding` persists the resolved pair, while unknown IDs and mismatched JSON identity pairs write nothing.
- [ ] Stale decisions remain audit-only: baseline/scope/prompt/abort side effects are skipped and `REVIEW_GATE_STALE` is returned.
- [ ] Advisory-pinned runs record diagnostics/hypothetical governance without rejecting or rerouting; enforced-pinned runs fail closed and route; config mode changes affect only later baseline captures; off/v1-compat do not demand new fields.
- [ ] A fixture with `human-step`, `answered-prompt`, and governance decision lines folds/indexes only governance decisions without diagnostics for known unrelated kinds.

### 9.2 Run state and CLI presentation — plan-208 run-state formatter; new review command formatter

- [ ] Extend `5x run state` with active gate summary, normalized route, latest decisions, governing scope/baseline, and stable IDs while retaining plan-208 gross forecast fields.
- [ ] Provide concise text output and complete JSON fields; never hide absolute limits or positive architecture burden behind debt credit.
- [ ] Ensure malformed index/history reports an actionable diagnostic and does not silently return an empty decision ledger.

### 9.3 Documentation and exports

- [ ] Update `docs/v2/206-review-budget-governance.md` implementation status/contracts and `docs/v2/202-control-plane.md` budget-specific action mapping.
- [ ] Update `docs/v1/101-cli-primitives.md` for review gate/decision commands, ID-only `--finding` with CLI fingerprint resolution, machine JSON/stdin identity pairs, `requiredFieldsByChoice`, and structured errors; keep skill examples identical to this canonical syntax.
- [ ] Update `README.md`, `CHANGELOG.md`, default config comments, public `src/index.ts` exports, and CLI help.
- [ ] Document that baselines captured before this slice decode as advisory and cannot be promoted to enforced in place; enforcement requires a new run/baseline.
- [ ] Mark `docs/v2/plan-inputs/07-plan-review-governance.plan-input.md` generated/implemented only after all gates pass; leave slice-08 handoff explicit.
- [ ] Create a follow-up plan input/handoff for dashboard forecast/ceiling/debt/alert/history views and authenticated decision actions after slice 04 merges; reference the exported read/action seams from this slice.

---

## Files Touched

Phase 0 must reconcile these paths against the merged plan-208 names before implementation.

| File | Change |
|------|--------|
| `src/review-governance/types.ts` | Shared closure outcomes, derived gate, decision, route, and governing-state contracts. |
| `src/review-governance/fingerprint.ts` | Canonical finding fingerprint derivation. |
| `src/review-governance/closure.ts` | Initial/closure review and prior-decision validation. |
| `src/review-governance/plan-diff.ts` | Shared plan-only diff context and hunk validation. |
| `src/review-governance/routing.ts` | Pure enforced/advisory routing and final-correction validation. |
| `src/review-governance/decisions.ts` | Decision payload validation and governing-state fold. |
| `src/review-governance/store.ts` | Record/prompt facade and gate-resolution contract. |
| `src/review-governance/codec.ts` | Versioned governance-decision codec (no gate record codec). |
| `src/review-governance/sqlite-index.ts` | Rebuildable decision/gate projection. |
| `src/review-governance/apply.ts` | Governance composition around plan 208 budget apply/writer. |
| `src/review-governance/context.ts` | Prior finding/decision prompt projection. |
| `src/review-budget/ensure-baseline.ts` | Pin governance mode at capture and remove reserved-enforcement warning. |
| `src/review-budget/apply.ts` | Accept folded governing baseline and preserve one-snapshot-per-reviewer invariant. |
| `src/review-budget/record-lines.ts` | Persist/decode pinned mode and governance snapshot extensions. |
| `src/control-plane/review-budget-store.ts` | Round-trip pinned mode and extended snapshot fields. |
| `src/protocol.ts` | Add closure blocker fields and top-level `priorFindings[]`. |
| `src/protocol-normalize.ts` | Preserve and normalize new structured fields without deriving routes. |
| `src/commands/protocol-emit.handler.ts` | Emit blocker items and repeatable prior-finding outcomes. |
| `src/commands/protocol.handler.ts` | Apply closure/diff/governance validation before recorded plan reviews. |
| `src/commands/protocol.ts` | Reviewer help/flags and review decision command references. |
| `src/commands/invoke.handler.ts` | Use shared governance writer for recorded plan reviews. |
| `src/commands/template-vars.ts` | Consume shared diff builder and inject decision context. |
| `src/commands/review-budget-context.ts` | Extend `ReviewBudgetCommandContext` composition and paired reviewer writer. |
| `src/commands/review.ts` | Register review gate/decision commands. |
| `src/commands/review-decision.handler.ts` | Validate, finalize, durably submit, stale-check, and derive post-decision routes. |
| `src/commands/prompt.handler.ts` | Reject generic review-gate answers and keep gate notifications out of answered-prompt decisions. |
| `src/commands/run-v1.handler.ts` | Add coupled-extra-key outcome to shared paired finalization; run-state governance projection. |
| `src/config.ts`, `src/templates/5x.default.toml` | Replace reserved-enforcement copy with pinned advisory/enforced behavior. |
| `src/control-plane/types.ts` | Optional typed prompt context and redacted adapter view. |
| `src/control-plane/store.ts` | Typed prompt query/repair support and gate-answer rejection contract. |
| `src/control-plane/{sqlite-store,memory-store}.ts` | Persist prompt context and reject generic answers for review-gate notifications. |
| `src/db/schema.ts` | Next migration for prompt context and governance indexes. |
| `src/templates/reviewer-plan.md` | Exhaustive initial review and lowest-cost correction contract. |
| `src/templates/reviewer-plan-continued.md` | Closure-only review, exact hunk, critical safety, and decision ledger contract. |
| `src/templates/author-process-plan-review.md` | Inject authoritative governing decisions into author revisions. |
| `src/skills/base/5x-plan-review/SKILL.tmpl.md` | Route execution, human gate, and final-correction branches. |
| `src/skills/base/5x-plan/SKILL.tmpl.md` | Generated-plan workflow integration. |
| `src/index.ts` | Public governance types and handler-safe action exports. |
| `test/unit/review-governance/*.test.ts` | Pure policy, fingerprint, diff, route, codec, fold, and store tests. |
| `test/unit/commands/{protocol-emit,protocol-validate,review-decision}.test.ts` | Command-level validation and action tests. |
| `test/unit/commands/finalize-and-write-prepared-step.test.ts` | Existing extra-op key returns coupled-key outcome before iteration retry/corruption. |
| `test/unit/db/schema*.test.ts` | Migration/index constraints and upgrades. |
| `test/integration/commands/{protocol-emit,protocol-validate,plan-review-governance}.test.ts` | CLI contracts and end-to-end review rounds. |
| `docs/v2/{202-control-plane,206-review-budget-governance}.md` | Implemented governance/control-plane contracts. |
| `docs/v1/101-cli-primitives.md` | Review gate/decision CLI documentation. |
| `README.md`, `CHANGELOG.md` | User-facing pinned-mode, enforced-mode, compatibility, and dashboard-follow-up notes. |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/review-governance/fingerprint.test.ts` | Canonical identity stability and material-change detection. |
| Unit | `test/unit/review-governance/closure.test.ts` | Separate prior outcomes, remaining blockers, new blocker rules, critical safety, and decision re-raise. |
| Unit | `test/unit/review-governance/debt-policy.test.ts` | Complete evidence, coupling, minimal-compliant comparison, and no false credit. |
| Unit | `test/unit/review-governance/plan-diff.test.ts` | Exact hunk/range matching and review-artifact-only HEAD changes. |
| Unit | `test/unit/review-governance/routing.test.ts` | Enforced/advisory matrix, successor causes, readiness normalization, and post-decision routes. |
| Unit | `test/unit/review-governance/decisions.test.ts` | Choice validation, immutable history, supersession, and governing-state fold. |
| Contract | `test/unit/review-governance/store-contract.test.ts` | Memory/working-tree ordering plus two-facade gate-scoped CAS and prompt repair. |
| Unit | `test/unit/db/schema-review-governance.test.ts` | Fresh/upgrade schema, indexes, constraints, and wiped-index rebuild. |
| Unit | `test/unit/commands/protocol-{emit,validate}.test.ts` | Prior-outcome flag, addressed-only ready, blocker matching, CLI-owned keys, pinned-mode compatibility. |
| Unit | `test/unit/commands/review-decision.test.ts` | Choice/cause payloads, ID-to-fingerprint resolution, flag/JSON/stdin parsing, coupled-key losers, stale no-side-effect gates, prompt rejection/wait, and abort parity. |
| Unit | `test/unit/commands/finalize-and-write-prepared-step.test.ts` | Decision-key collision bypasses retry/corruption; snapshot-only collision still maps to plan-208 pair corruption. |
| Integration | `test/integration/commands/protocol-validate.test.ts` | Recorded plan-review evidence and no-write-on-failure behavior. |
| Integration | `test/integration/commands/plan-review-governance.test.ts` | Multi-round review, two-process CAS, prompts, decisions, restart, audit history, and pinned modes. |
| Regression | full `bun test` and `bunx tsc --noEmit` | Existing prompt, records, protocol, invoke, skills, and run-state behavior remains valid. |

---

## Not In Scope

- **Implementation-review governance** — item classes, code-diff evidence, plan impact, realized credit, and post-correction quality gates belong to slice 08.
- **A second implementation budget** — implementation inherits approved plan scope; this slice governs plan review only.
- **General debt discovery/refactoring** — only directly coupled plan work can receive provisional credit.
- **Automatic safety suppression** — material correctness, security, data-loss, and acceptance findings stay visible and route to a human where required.
- **Enforced as global default** — advisory remains the default until calibration supports a separate policy change.
- **Dashboard governance delivery** — HTTP/WS routes, authentication, browser forecast/debt/history panels, actions, and dashboard parity tests are deferred to a follow-up generated after slice 04 merges. This slice supplies only typed prompt/read/action seams needed by CLI governance.
- **Advisory parser/arithmetic/store foundation** — plan 208 owns delivery-budget parsing, formulas, baseline capture, snapshot pairing, and budget index.

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 0 | Reconcile merged plan-208 symbols and enforcement copy | 1 day |
| 1 | Governance domain and convergence policy | 2 days |
| 2 | Durable decisions and governing-state fold | 3 days |
| 3 | Closure protocol and plan-diff validation | 3 days |
| 4 | Enforced routing and readiness normalization | 2 days |
| 5 | Human gate prompt and decision actions | 3 days |
| 6 | Recording integration and workflow context | 3 days |
| 7 | Reviewer templates and workflow skills | 2 days |
| 9 | End-to-end audit, compatibility, and docs | 3 days |
| **Total** | | **22 working days** |

---

## Revision History

### v1.4 (September 21, 2026) — Addendum 3 baseline convergence and finding input

Addresses Addendum 3 in [`5x-cli-docs-development-plans-209-plan-review-governance-plan-review.md`](../reviews/5x-cli-docs-development-plans-209-plan-review-governance-plan-review.md):

- **P0.3 residual:** Made active retain/adjust decisions resolve immutable `baseline_disputed` at run scope across later snapshots, while adjustment still changes governing `B` for band recomputation.
- Chose the recommended re-estimate policy: it does not cover the dispute, closes the current gate, and limits the next disputed-baseline gate to retain/adjust/abort until finalized.
- **P2.6:** Changed terminal `--finding` to accept a stable finding ID and resolve its fingerprint from the current gate snapshot; full ID/fingerprint pairs remain machine-only JSON input and are validated against that snapshot.
- Added cross-round baseline convergence, re-estimate-loop prevention, finding-resolution, and mismatched-fingerprint coverage; preserved prior addendum fixes.

### v1.3 (September 21, 2026) — Addendum 2 routing and input-contract corrections

Addresses Addendum 2 in [`5x-cli-docs-development-plans-209-plan-review-governance-plan-review.md`](../reviews/5x-cli-docs-development-plans-209-plan-review-governance-plan-review.md):

- **P1.4 residual:** Persisted record-time effective causes rather than unsuppressed causes, retained `resolvedBy` audit entries, and added an explicit choice-to-cause/successor table.
- **P1.9 residual:** Made the filtered-budget governance rerun authoritative, limited route overrides to scope/re-estimate/abort closures, and reconciled completion, correction, and successor precedence.
- **P2.4:** Specified equivalent individual-flag, inline-JSON, and stdin contracts for `5x review decide`, plus `requiredFieldsByChoice` discovery.
- **P2.5:** Split notification/wait/PromptStore work from saturated W5 into new W10 without reusing intentionally vacant W8.
- Clarified that the gate-key pre-read precedes `prepareRecordStepAppend` and that abort routing is derived before terminal side effects.

### v1.2 (September 21, 2026) — Closure-review residuals

Addresses the latest addendum in [`5x-cli-docs-development-plans-209-plan-review-governance-plan-review.md`](../reviews/5x-cli-docs-development-plans-209-plan-review-governance-plan-review.md):

- **P0.2 residual:** Routed decisions through `finalizeAndWritePreparedStep` and added a coupled-extra-key loser outcome before iteration retry/corruption logic, including simultaneous and after-winner coverage.
- **P1.4 residual:** Based the original gate on persisted snapshot causes and defined deterministic predecessor-linked successor gates for remaining causes.
- **P1.8:** Made gate prompts notification/wait handles, rejected generic answers, and waited on the authoritative decision key.
- **P1.9:** Defined pure post-decision route recomputation and complete/revise/final-correction/abort skill branches.
- **P2.2/P2.3:** Documented intentionally vacant Phase 8/W8 IDs and required a post-append current-gate check before every side effect.

### v1.1 (September 21, 2026) — Initial review corrections

Addresses [`5x-cli-docs-development-plans-209-plan-review-governance-plan-review.md`](../reviews/5x-cli-docs-development-plans-209-plan-review-governance-plan-review.md):

**P0 blockers resolved:**
- **P0.1:** Removed Phase/W8 and all dashboard parity work; retained exported CLI seams and a post-slice-04 follow-up handoff.
- **P0.2:** Made gate-scoped `atomicAppendIfAllNew` the sole CAS, records-first and prompt-projection-second.
- **P0.3:** Added active-decision suppression envelopes for baseline/architecture causes without hiding budget alerts or bands.
- **P0.4:** Added top-level `priorFindings[]`; `items[]` now contains only remaining blockers.

**P1/P2 items resolved:**
- Pinned mode at baseline activation; advisory diagnoses without rejection/rerouting and enforced validates/routes.
- Injected governing decisions into the author prompt, validated against full patches, made gates deterministic/derived, filtered decision kinds, reconciled plan-208 seams, clarified follow-up/debt representation, and rescored W1/W2/W5 architecture burden.

---

## Provenance

This plan implements the CLI/workflow portion of `v2-plan-review-governance` from [`07-plan-review-governance.plan-input.md`](../../v2/plan-inputs/07-plan-review-governance.plan-input.md). It follows plan 208's advisory budget foundation. Dashboard governance views/actions move to a follow-up after slice 04 merges; implementation-review governance and realized debt reconciliation remain in `08-implementation-review-governance.plan-input.md`.
