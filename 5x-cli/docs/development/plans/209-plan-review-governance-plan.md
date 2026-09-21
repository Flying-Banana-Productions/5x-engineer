# Plan-Review Governance — Closure Reviews, Enforced Routing, and Durable Decisions

**Version:** 1.0
**Created:** September 21, 2026
**Status:** Draft — blocked on the control-plane dashboard and review-budget advisory prerequisites

---

## Executive Summary

This slice turns review-budget telemetry into enforceable plan-review governance. Initial review remains the one exhaustive pass; later reviews become closure reviews that resolve prior findings, accept only diff-causal new blockers, preserve nonblocking follow-ups, and require new evidence before a deferred or accepted-risk finding can block again. The CLI—not the reviewer—validates evidence, normalizes readiness, derives the route, opens durable human gates, and folds immutable decisions into the governing baseline and approved scope.

The implementation extends the advisory budget record model from plan 208 and the authenticated dashboard from slice 04. It adds pure convergence/routing policy, append-only review-decision records, CAS-protected gate resolution, typed prompt metadata, protocol validation for closure evidence, workflow skill branches, and budget/decision dashboard panels. Advisory remains the default and retains existing routing; enforcement is activated only when `[reviewBudget].mode = "enforced"`.

### Scope

**In scope:**

- Exhaustive initial-review and constrained closure-review contracts, including prior-finding status and lowest-cost correction evidence.
- Exact plan-diff validation for new ordinary blockers, direct human routing for critical late safety findings, and nonblocking follow-up recording.
- Debt-claim eligibility validation and deterministic enforcement of budget, baseline, semantic-human, architecture, and final-correction gates.
- Append-only review decisions with UUIDs, finding fingerprints, rationale, evidence, approved scope, governing-baseline changes, and supersession history.
- Explicit budget-increase, scope-trade, risk-deferral, retain/adjust-baseline, request-re-estimate, and abort choices through the prompt/control-plane path.
- Injection of prior deferred/accepted-risk decisions into every later plan review, with new-evidence checks on re-raise.
- Authenticated dashboard forecast, ceiling, debt-claim, alert, open-gate, and decision-history views/actions.

**Out of scope:**

- Implementation-review classification, code-diff validation, final quality-gated implementation corrections, or realized debt credit (slice 08).
- A second implementation budget or general technical-debt discovery.
- Automatic suppression of material correctness, security, data-loss, or acceptance findings.
- Changing the global default from advisory to enforced.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **The CLI derives one `PlanReviewRoute`; reviewers never emit routing or aggregates** | Prevents agents from authoring budget outcomes and gives native and invoke workflows the same deterministic result. |
| **Closure evidence is validated against a recomputed plan-only diff** | A cited hunk must be part of the exact plan delta shown to the reviewer; a review-artifact commit after rendering cannot invalidate the comparison. |
| **Review decisions are immutable record lines; governing state is a fold** | Preserves the full audit trail, keeps SQLite rebuildable, and avoids mutating the frozen baseline from plan 208. |
| **Gate resolution is compare-and-swap against forecast and prompt identity** | Stale dashboard tabs, repeated submissions, and terminal/browser races cannot overwrite the first durable decision. |
| **Finding identity combines stable item ID with a canonical fingerprint** | IDs support author `Addresses` accounting; fingerprints prevent a renamed deferred finding from silently becoming a fresh blocker. |
| **Valid `ready_with_corrections` produces a final-author route, not review re-entry** | Implements the bounded mechanical shortcut while preserving the existing iteration limit for real `not_ready` closure cycles. |
| **Advisory mode computes governance but does not route on it** | Existing runs retain compatibility while the same result is observable for calibration. |

### References

- [`docs/v2/plan-inputs/07-plan-review-governance.plan-input.md`](../../v2/plan-inputs/07-plan-review-governance.plan-input.md) — slice requirements and exit criteria.
- [`docs/v2/206-review-budget-governance.md`](../../v2/206-review-budget-governance.md) — canonical convergence, routing, debt-credit, and decision policy.
- [`208-review-budget-advisory-plan.md`](./208-review-budget-advisory-plan.md) — required budget parser, arithmetic, record facade, and decorated snapshots.
- [`docs/v2/plan-inputs/04-control-plane-dashboard.plan-input.md`](../../v2/plan-inputs/04-control-plane-dashboard.plan-input.md) — required authenticated server/action infrastructure.
- [`docs/v2/202-control-plane.md`](../../v2/202-control-plane.md) — prompt queue and allowed control-plane mutation paths.
- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — record/control-plane ownership and compatibility constraints.
- [`docs/v1/100-architecture.md`](../../v1/100-architecture.md) — CLI primitives, idempotent recording, and skill-owned orchestration.

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Architecture Overview](#architecture-overview)
4. [Delivery Budget](#delivery-budget)
5. [Phase 1: Governance domain and convergence policy](#phase-1-governance-domain-and-convergence-policy)
6. [Phase 2: Durable decisions and governing-state fold](#phase-2-durable-decisions-and-governing-state-fold)
7. [Phase 3: Closure protocol and plan-diff evidence validation](#phase-3-closure-protocol-and-plan-diff-evidence-validation)
8. [Phase 4: Deterministic enforced routing and readiness normalization](#phase-4-deterministic-enforced-routing-and-readiness-normalization)
9. [Phase 5: Human gate prompt and decision actions](#phase-5-human-gate-prompt-and-decision-actions)
10. [Phase 6: Recording integration and workflow context](#phase-6-recording-integration-and-workflow-context)
11. [Phase 7: Reviewer templates and workflow skills](#phase-7-reviewer-templates-and-workflow-skills)
12. [Phase 8: Dashboard governance surfaces](#phase-8-dashboard-governance-surfaces)
13. [Phase 9: End-to-end audit, compatibility, and documentation](#phase-9-end-to-end-audit-compatibility-and-documentation)
14. [Files Touched](#files-touched)
15. [Tests](#tests)
16. [Not In Scope](#not-in-scope)
17. [Estimated Timeline](#estimated-timeline)
18. [Provenance](#provenance)

---

## Overview

The current checkout contains the v1 reviewer contract and git-native record streams, but neither prerequisite for this slice is implemented yet: `src/review-budget/` and `src/dashboard/` do not exist. Plan 208 defines the advisory budget APIs this slice consumes; slice 04 must define the authenticated dashboard extension points. Implementation must not begin until both are merged, and Phase 0 of execution must reconcile the line references and exported names below with those merged contracts rather than creating parallel stores or arithmetic.

**Current behavior:**

- `VerdictItem` has only `id`, `title`, `action`, `reason`, and optional `priority`; `ReviewerVerdict` has no closure evidence (`src/protocol.ts:16–28`).
- `protocol emit reviewer` copies only those v1 item fields (`src/commands/protocol-emit.handler.ts:67–160`), and `protocol validate --record` records the validated result directly (`src/commands/protocol.handler.ts:378–517`).
- Initial review asks for broad correctness/architecture/completeness/scope analysis (`src/templates/reviewer-plan.md:19–89`). Continued review asks for prior status but also broadly allows newly introduced issues without structural evidence (`src/templates/reviewer-plan-continued.md:13–32`).
- Continued prompt rendering computes a plan-file diff from the prior reviewer step to current HEAD (`src/commands/template-vars.ts:329–425`) but does not retain a machine-checkable diff context.
- Human steps and answered prompts are copied into the append-only `decisions` stream (`src/commands/run-v1.handler.ts:2151–2164`, `src/commands/prompt.handler.ts:225–257`) without a review-governance payload or governing-state fold.
- `RecordStore` exposes insertion-ordered streams and atomic append (`src/control-plane/record-store.ts:17–39`); command handlers need not know the working-tree JSONL layout.
- No dashboard command/server is present. Slice 04 is a hard prerequisite, not work to recreate here.

**New behavior:**

- Initial verdicts are exhaustive, independently assess the baseline, classify scope, and state the lowest-cost adequate correction.
- Continued verdicts classify every prior finding and can add a new blocker only with a validated introducing plan hunk, a critical-safety exception, or new evidence tied to a prior decision.
- The CLI derives a governance result and route from validated item-level data, the plan-208 forecast, current mode, prior decisions, and review round.
- Enforced runs pause on computed or semantic gates. A typed prompt and review-gate record expose allowed choices; the first valid decision wins and resumes from durable state.
- Governing baseline and approved scope are folded from immutable decisions; original baseline, gross effort, positive architecture burden, and debt-credit caps remain visible.
- Later review prompts contain the full applicable deferred/accepted-risk ledger. Re-raising requires the exact prior decision ID plus material new evidence.
- The dashboard reads the same derived index and invokes the same decision handler after authentication; it never mutates SQLite or record files directly.

**Prerequisites:**

- [`208-review-budget-advisory-plan.md`](./208-review-budget-advisory-plan.md) implemented and merged, including `ReviewBudgetStore`, budget record codecs/index, `applyPlanReviewBudget`, `finalizeAndWritePreparedStep`, and `PlanReviewBudgetContext`.
- [`04-control-plane-dashboard.plan-input.md`](../../v2/plan-inputs/04-control-plane-dashboard.plan-input.md) implemented and merged, including token middleware, versioned HTTP/WebSocket contracts, prompt actions, handler invocation boundary, and static component conventions.
- If either prerequisite lands with materially different APIs, revise this plan before Phase 1; do not shim a second budget store or dashboard server.

---

## Design Decisions

**Separate validation, derivation, and orchestration.** `validateClosureReview` validates reviewer claims; `derivePlanReviewGovernance` computes normalized readiness and route; skills execute that route. Protocol handlers may call the first two but must not encode workflow loops.

**Use the plan delta, not the whole repository diff.** `resolveReviewDelta` already appends only the plan-file diff. Extract a shared `buildPlanReviewDiffContext` that returns commits, canonical patch, and hunk hashes. Rendering consumes its Markdown form; validation recomputes it from the recorded prior reviewer head and the cited commit range. A citation is valid only if the range starts at the expected prior review commit and its normalized hunk is present in that plan-only patch. The ending commit may precede the reviewer-artifact commit if both produce the identical plan patch.

**Late safety is visible and always human-owned.** `lateDiscovery: "critical_safety"` is accepted only for `acceptance_required` or `risk_reduction`, with non-empty evidence naming a security, data-loss, or correctness failure. It never silently becomes an automatic author loop.

**Ordinary missed issues are follow-ups, not verdict items.** The review artifact gains a nonblocking follow-up section. Structured `items[]` remains routing input; therefore an ordinary pre-existing issue discovered after round one fails validation rather than being retained as a blocking item. This does not suppress critical-safety findings.

**A decision never edits a prior record.** Decision lines live in the existing `decisions` record stream and carry a UUID `decisionId`, `gateId`, `forecastId`, actor/origin, finding fingerprints, rationale, evidence, approved scope, and optional governing-baseline change. The latest governing state is a deterministic insertion-order fold. SQLite stores only a rebuildable projection.

**CAS protects both coordination and record state.** A gate is keyed by the budget snapshot/forecast plus route causes. Decision submission verifies the prompt is still open/answered by this submission, the gate is unresolved, and the expected forecast is still current. One atomic record append writes the decision and `human:review-governance` step. Losing retries return the winning decision; stale forecasts return `REVIEW_GATE_STALE` and open/reuse a newly derived gate.

**Decision scope is explicit.** Risk deferral and accepted-risk choices must name finding IDs/fingerprints and approved scope. Scope trade records retained/removed scope text and returns to author revision. Budget/baseline choices record old and new governing values plus rationale. Abort uses the existing run-abort handler after the decision append; handler parity tests assert the same terminal record as CLI abort.

**Fingerprinting is deterministic but does not replace stable IDs.** Hash canonical JSON containing normalized title, scope class, named requirement/failure, and lowest-cost correction—not volatile priority, estimate, or prose formatting. Persist both `findingId` and `fingerprint`. A later item with the same ID but different fingerprint is changed evidence, not silently the same risk.

**Debt policy reuses advisory evidence.** Do not recalculate debt eligibility in handlers. The governance validator checks that every credited claim has plan-208 complete evidence, reviewer eligibility, `intrinsic` coupling, a valid target phase, and a genuinely simpler `After` state. `adjacent` and `unrelated` claims receive no credit and become follow-up/human-scope observations; gross effort and gross positive burden are never netted away.

**Readiness normalization is deterministic.** In enforced mode, `ready_with_corrections` is valid only when all items are `auto_fix`, combined remaining effort is at most one point, every architecture delta is zero, no item requires reviewer verification, and projected effort is within the effective ceiling. A valid result routes to one final author pass and then completion without another reviewer. A budget/semantic alert routes to a gate; other invalid uses normalize to `not_ready` and a closure cycle. Advisory mode records the hypothetical result while preserving v1 route behavior.

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
                                       typed prompt / dashboard action (CAS)
                                                               │
                                         append decision + human step atomically
                                                               │
                                     fold governing B/scope/risk ledger; resume

RecordStore: steps.jsonl + budget.jsonl + decisions.jsonl (authority)
SQLite: reviewer/budget/decision/gate projections (rebuildable dashboard index)
```

`PlanReviewGovernanceResult` is placed beside plan 208's `budget` decoration in the recorded reviewer result. It contains CLI-derived route, normalized readiness, gate causes, prior-finding outcomes, and follow-up counts; it never accepts reviewer-authored aggregate fields.

---

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Define governance types, finding fingerprints, and pure closure validation | 5 | 0 | - | - | New cross-cutting policy contract shared by protocol, persistence, skills, and UI; includes unit fixtures. |
| W2 | Add immutable review decisions, gate records, governing-state fold, codecs, and index rebuild | 8 | 0 | - | - | Extends record persistence and CAS semantics across authoritative records and rebuildable projections; includes store/reindex tests. |
| W3 | Extend reviewer protocol and validate exact introducing plan hunks | 5 | 0 | - | - | Changes public structured output and threads git diff context through emit/validate paths; includes protocol and diff edge-case tests. |
| W4 | Derive enforced routes and normalize `ready_with_corrections` | 5 | 0 | - | - | Central policy matrix combines budget, architecture, semantic action, closure evidence, and compatibility mode; includes exhaustive matrix tests. |
| W5 | Implement typed human-gate prompt flow and idempotent decision actions | 8 | 0 | - | - | Adds a concurrency-sensitive prompt/decision boundary and explicit tradeoff payloads; includes CAS, stale-gate, and repeated-decision tests. |
| W6 | Integrate governance with reviewer recording and later prompt context | 5 | 0 | - | - | Coordinates protocol/invoke writers, atomic records, decision folding, and prompt rendering without duplicating plan-208 seams; includes writer parity tests. |
| W7 | Rewrite reviewer templates and plan-review skills for closure routing | 3 | 0 | - | - | Updates bundled workflow contracts and route handling across native/invoke modes; includes rendered-asset tests. |
| W8 | Add authenticated dashboard forecast, debt, gate, and decision surfaces | 8 | 0 | - | - | Extends the prerequisite server, versioned API/WS messages, and browser components/actions; includes auth and browser smoke tests. |
| W9 | Complete end-to-end compatibility, race, audit, and documentation coverage | 5 | 0 | - | - | Validates multi-round behavior and advisory/off compatibility across CLI and dashboard; includes integration fixtures and docs. |

### Surface Snapshot

- Subsystems: 7
- Production files: 28
- Persistent/external boundaries: 3
- New shared abstractions: 3
- New persistent schemas: 1

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

export interface FindingIdentity {
  findingId: string;
  fingerprint: string;
}

export interface PlanReviewGovernanceResult {
  reviewKind: "initial" | "closure";
  normalizedReadiness: ReviewerVerdict["readiness"];
  route: PlanReviewRoute;
  gateCauses: ReviewGateCause[];
  findingOutcomes: Array<FindingIdentity & { status: PriorFindingStatus }>;
  followUpCount: number;
  hypotheticalEnforcedRoute?: PlanReviewRoute; // advisory telemetry only
}
```

- [ ] Add discriminated types for critical-safety, introduced-hunk, prior-decision/new-evidence, follow-up, debt eligibility, route cause, and validation diagnostics.
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
  verdict: ReviewerVerdict;
  priorFindings: readonly PersistedFinding[];
  priorDecisions: readonly ReviewDecision[];
  diffContext?: PlanDiffContext;
}): ClosureValidationResult;
```

- [ ] Initial review: require material failure, `scopeClass`, deltas/confidence, and `lowestCostCorrection` on every routing item; preserve plan-208 initial baseline/debt requirements.
- [ ] Closure review: require one outcome for every prior unresolved finding; reject unknown/duplicate prior IDs and omitted prior findings.
- [ ] New ordinary blocking item: require `introducedBy`; critical late issue: require `lateDiscovery: "critical_safety"` and concrete safety evidence; prohibit both fields together.
- [ ] Re-raised deferred/accepted-risk item: require the matching `priorDecisionId`, matching fingerprint/scope, and non-empty materially new evidence.
- [ ] Reject adjacent/unrelated debt as a blocking item; represent it only in nonblocking follow-ups or a human scope decision.
- [ ] Add `test/unit/review-governance/{fingerprint,closure,debt-policy}.test.ts` with ordinary missed issue, critical exception, changed fingerprint, stale decision, and complete/incomplete debt evidence cases.

---

## Phase 2: Durable decisions and governing-state fold

**Completion gate:** Memory and working-tree store contract tests append and fold identical decision history; repeated keys do not overwrite; SQLite index deletion/rebuild reproduces governing baseline, approved scope, accepted risks, and decision order.

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
  gateId: string;     // UUID
  forecastId: string; // immutable budget snapshot/forecast identity
  choice: ReviewDecisionChoice;
  findingRefs: FindingIdentity[];
  rationale: string;
  evidence: string[];
  approvedScope: { retained: string[]; removed: string[] };
  governingBaselineChange?: { from: number; to: number };
  supersedesDecisionId?: string;
  createdAt: string;
}

export interface GoverningReviewState {
  governingBaseline: number;
  approvedScope: ApprovedScope;
  acceptedRisks: AcceptedRisk[];
  architectureApprovals: ArchitectureApproval[];
  aborted: boolean;
  history: ReviewDecisionPayload[];
}
```

- [ ] Validate choice-specific fields: positive integer baseline, non-empty rationale, scope delta for `trade_scope`, finding refs/evidence for risk deferral, and no baseline mutation for `abort`.
- [ ] Use `decision:review:<decisionId>` idempotency keys and retain insertion order. A correction is a new decision with `supersedesDecisionId`, never an update.
- [ ] Fold from plan-208 immutable `B0` plus insertion-ordered decisions; reject contradictory unsuperseded changes during submission and fail closed on malformed authoritative lines during rebuild.

### 2.2 Gate records and review facade — new `src/review-governance/store.ts`, `codec.ts`

```typescript
export interface ReviewGovernanceStore {
  getDecision(runId: string, decisionId: string): ReviewDecisionPayload | null;
  listDecisions(runId: string): ReviewDecisionPayload[];
  getOpenGate(runId: string): ReviewGateRecord | null;
  resolveGate(input: ResolveReviewGateInput): ResolveReviewGateResult;
  deriveGoverningState(runId: string, b0: number): GoverningReviewState;
}
```

- [ ] Implement as a facade over the prerequisite `RecordStore`, `PromptStore`, and review-budget store/context; command logic must not import `bun:sqlite`.
- [ ] Give each gate a UUID, forecast ID, causes, allowed choices, prompt IDs, state (`open|resolved|superseded`), and expected latest decision sequence.
- [ ] Keep open/waiting prompt state in the coordination store; keep resolved decision facts in record lines. A crash before decision append leaves a repairable answered prompt, not a fabricated decision.
- [ ] Add codec rejection tests for unknown versions/kinds and preserve unknown future decision records as unreadable diagnostics rather than dropping them.

### 2.3 Rebuildable index — `src/db/schema.ts` after plan 208's migration; new `src/review-governance/sqlite-index.ts`

- [ ] Add the next available migration after prerequisites for `review_decision_index` and `review_gate_index`; use UUID TEXT keys, `record_seq`, run/forecast indexes, and no authority-only fields omitted from record payloads.
- [ ] Implement write-through upserts and `reindexReviewGovernance(recordStore, db, runId?)` using record insertion order, not second-resolution timestamps.
- [ ] Extend the prerequisite records-index/backfill dispatch only to project existing decision lines; do not backfill invented governance decisions from generic historical human steps.
- [ ] Add fresh/upgrade schema tests, equal-timestamp ordering, wiped-index rebuild, malformed-line diagnostics, and no-decision historical compatibility.

---

## Phase 3: Closure protocol and plan-diff evidence validation

**Completion gate:** Protocol emit/validate accepts all initial and closure fields, rejects reviewer-authored routing/aggregates, and validates cited introducing hunks against the exact plan-only diff. Unit and integration tests cover changed HEAD caused solely by the review artifact.

### 3.1 Extend reviewer contract — `src/protocol.ts:16–100`, `src/protocol-normalize.ts`

Extend plan-review items with optional structural fields at the generic schema layer; active plan-budget validation makes the appropriate fields required by review round.

```typescript
export type VerdictItem = {
  // existing fields
  scopeClass?: PlanScopeClass;
  effortDelta?: number;
  architectureDelta?: number;
  estimateConfidence?: EstimateConfidence;
  coupling?: CouplingClass;
  lowestCostCorrection?: string;
  failure?: string;
  priorFindingStatus?: PriorFindingStatus;
  introducedBy?: IntroducedByPlanHunk;
  lateDiscovery?: "critical_safety";
  lateDiscoveryEvidence?: string;
  priorDecisionId?: string;
  newEvidence?: string;
  requiresReviewerVerification?: boolean;
};
```

- [ ] Preserve v1/off and mid-review compatibility rules from plan 208; do not require plan fields for implementation-phase verdicts.
- [ ] Reject top-level `reviewRoute`, `normalizedReadiness`, `gateCauses`, budget totals/status, or decision outcomes as CLI-owned keys.
- [ ] Extend `protocol emit reviewer` (`src/commands/protocol-emit.handler.ts:30–160`) to preserve validated item fields and repeatable follow-up records without computing status.
- [ ] Add CLI flags only for top-level initial assessment/credit assessments already owned by plan 208; complex closure evidence remains in repeated `--item` JSON.

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

- [ ] Make both prompt rendering and validation call the shared builder; keep Markdown formatting outside the validator.
- [ ] Normalize only diff transport artifacts (line endings and trailing whitespace), then require a complete hunk header and changed lines to match one computed hunk; reject snippets assembled across hunks.
- [ ] Require `commitRange` start to equal the prior reviewer step head. Accept an end commit only when its plan-only patch is byte-equivalent to the rendered context, allowing a later review-document-only commit.
- [ ] Fail closed with `PLAN_DIFF_CONTEXT_MISSING`, `INTRODUCED_RANGE_MISMATCH`, or `INTRODUCED_HUNK_NOT_FOUND`; do not downgrade invalid blocking evidence to a follow-up automatically.
- [ ] Test renamed plan paths, no plan change, binary/oversized diff rejection, abbreviated SHA ambiguity, stale ranges, and exact hunk matching.

### 3.3 Protocol command integration — `src/commands/protocol.handler.ts:378–517`, `src/commands/protocol.ts:102–184`

- [ ] Resolve review kind and prior reviewer step only after ambient run/phase identity is known; standalone structural validation remains available without governance application.
- [ ] For `reviewer --phase plan --record` on active budget runs, load prior findings/decisions, rebuild diff context, and call `validateClosureReview` before writing the success envelope.
- [ ] Surface line/item-specific validation errors in one standard error envelope; ensure no step, snapshot, prompt, or decision append occurs on failure.
- [ ] Add protocol unit/integration tests for first review, closure statuses, exact hunk, critical safety, prior-decision re-raise, malformed aggregates, and no-record validation.

---

## Phase 4: Deterministic enforced routing and readiness normalization

**Completion gate:** A table-driven routing matrix covers every budget band, alert, semantic action, review kind, readiness, and mode. Enforced output is deterministic; advisory/off preserve their documented routes.

### 4.1 Pure router — new `src/review-governance/routing.ts`

```typescript
export function derivePlanReviewGovernance(input: {
  mode: ReviewBudgetMode;
  reviewKind: "initial" | "closure";
  verdict: ReviewerVerdict;
  budget: DerivedBudgetResult;
  closure: ClosureValidationResult;
  governingState: GoverningReviewState;
}): PlanReviewGovernanceResult;
```

Routing precedence in enforced mode:

1. Existing accepted-risk decision without valid new evidence removes that finding from blocking input; invalid re-raise has already failed validation.
2. `lateDiscovery: critical_safety`, any semantic `human_required`, baseline dispute, positive-architecture alert, over-effective/absolute band, or unresolved adjacent-debt scope request → `human_gate`.
3. `ready` with no required items → `complete`.
4. Strictly valid `ready_with_corrections` → `final_corrections`.
5. Remaining required corrections → normalize to `not_ready` and `author_revision` (followed by closure review).

- [ ] Keep gross forecast, effective/absolute limits, positive burden, and provisional debt fields unchanged from plan 208 in output; the router selects a route only.
- [ ] Derive gate causes as stable enums with item/claim references; no prose parsing in skills or dashboard.
- [ ] In advisory mode return the existing v1 route and an optional hypothetical enforced route; in off/v1-compat mode omit governance routing decoration entirely.

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

### 4.3 Routing tests — new `test/unit/review-governance/routing.test.ts`

- [ ] Cover the complete cross-product with focused fixtures: each band, baseline direction, cumulative/single architecture alert, action, valid/invalid final correction, initial/closure, advisory/enforced/off.
- [ ] Assert reviewer readiness and authored aggregate-like fields cannot override the CLI route.
- [ ] Assert eligible intrinsic debt expands only the effective limit supplied by plan 208 and never changes displayed gross effort/positive burden.

---

## Phase 5: Human gate prompt and decision actions

**Completion gate:** Enforced human routes create one typed open gate; terminal and dashboard submissions race through one CAS path; the winner appends one decision/human step, losers observe it, stale forecasts cannot be approved, and every explicit choice has validated payload requirements.

### 5.1 Typed gate coordination — extend prerequisite prompt types/store and migration

After slice 04 merges, extend its prompt DTO with optional structured metadata rather than encoding JSON in the message.

```typescript
export interface ReviewGatePromptContext {
  type: "plan_review_gate";
  gateId: string;
  forecastId: string;
  causes: ReviewGateCause[];
  allowedChoices: ReviewDecisionChoice[];
  requiredFieldsByChoice: Record<ReviewDecisionChoice, string[]>;
}
```

- [ ] Add nullable, versioned prompt context to the prerequisite prompt schema/store and public dashboard view; existing prompts remain unchanged.
- [ ] Render explicit allowed choices based on causes: baseline disputes include adjust/retain/re-estimate/scope/abort; budget excess includes increase/scope/defer/abort; architecture alerts include approve/scope/defer/abort; semantic items include scope/defer/abort only where deferral is safe.
- [ ] Never offer risk deferral for an unscoped critical safety issue without an explicit accepted-risk payload and evidence; the final action is still human-owned.

### 5.2 Decision action — new `src/commands/review-decision.handler.ts`, `src/commands/review.ts`

```typescript
export async function submitPlanReviewDecision(
  input: SubmitPlanReviewDecisionInput,
  deps?: ReviewDecisionDeps,
): Promise<{ decision: ReviewDecisionPayload; created: boolean; route: PlanReviewRoute }>;
```

- [ ] Register `5x review gate show` and `5x review decide`; resolve ambient run using normal command rules, but require explicit run IDs in dashboard workers.
- [ ] Validate choice/payload against the gate, expected forecast, current run status, plan-208 limits, and current decision fold before any write.
- [ ] Use the prerequisite shared record finalization seam to atomically append `human:review-governance` and the decision line. Add a dedicated all-new gate resolution operation if the merged store cannot couple prompt CAS and records; document/repair the narrow crash window with idempotent replay.
- [ ] Apply side effects only after durable decision append: recalculate forecast for baseline changes, return author revision for scope trade/re-estimate, mark risk decisions for future prompt injection, or call the existing abort handler.
- [ ] Return the winning existing decision for same-payload retries; reject different-payload reuse as `REVIEW_GATE_ALREADY_RESOLVED`; reject outdated forecast as `REVIEW_GATE_STALE`.

### 5.3 Prompt path and concurrency tests

- [ ] Refactor prerequisite prompt waiting into a reusable internal function that returns the winning `PromptRecord` while preserving public `{ choice|confirmed|input }` envelopes.
- [ ] Add terminal structured-input validation and dashboard action parity; both call `submitPlanReviewDecision` rather than writing records directly.
- [ ] Test browser/browser, browser/terminal, repeated-identical, repeated-conflicting, stale-forecast, run-abort, lost-index-write, and crash-repair races.

---

## Phase 6: Recording integration and workflow context

**Completion gate:** `protocol validate --record` and `invoke reviewer --record` produce identical reviewer step, budget snapshot, governance decoration, and route. A later render sees all prior applicable decisions. Duplicate writes repair projections without duplicating any authoritative line.

### 6.1 One plan-review apply pipeline — new `src/review-governance/apply.ts`

```typescript
export async function applyPlanReviewGovernance(input: {
  runId: string;
  stepName: string;
  phase: "plan";
  iteration?: number;
  verdict: ReviewerVerdict;
  performer: RecordPerformer;
  context: PlanReviewBudgetContext;
}): Promise<PreparedPlanReviewRecord>;
```

- [ ] Compose plan 208's budget apply result with closure validation, governing-state fold, and routing; never duplicate budget arithmetic or `RecordStore` origin construction.
- [ ] Decorate the exact validated result with `budget` and `governance` before the shared paired write. Extend the plan-208 paired snapshot payload with validated finding identities/outcomes and route causes needed for rebuild.
- [ ] Ensure admission happens before any reviewer snapshot/gate append. A terminal run, missing worktree, invalid diff, invalid verdict, or max-step failure writes nothing.
- [ ] After a unique reviewer record, create/reuse a gate only when route is `human_gate`; retries load existing step/snapshot/gate and repair projections without opening another prompt.

### 6.2 Wire both reviewer writers — `src/commands/protocol.handler.ts:476–517`, `src/commands/invoke.handler.ts:627–695`

- [ ] Route only recorded `role=reviewer`, `phase=plan`, active budget runs through `applyPlanReviewGovernance`; all other roles/phases retain existing paths.
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
}
```

- [ ] Build context from authoritative snapshots/decision lines, not mutable review Markdown or only the SQLite index.
- [ ] Inject every applicable deferred/accepted-risk decision into every later plan review, including fresh provider sessions; native/invoke continuation must receive the same block.
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

- [ ] Replace broad re-review language with prior-finding closure first: `addressed`, `partially_addressed`, or `still_open` for every prior finding.
- [ ] Permit a new ordinary blocker only with exact `introducedBy` range/hunk/explanation from the appended plan diff.
- [ ] Permit pre-existing critical safety only with structured late-discovery evidence and direct human route.
- [ ] Include active deferred/accepted-risk decisions; require `priorDecisionId` and material `newEvidence` to re-raise.
- [ ] Direct adjacent hardening, polish, speculative risk, unrelated debt, and ordinary missed issues to a nonblocking follow-up section, excluded from `items[]`.

### 7.3 Skills — `src/skills/base/5x-plan-review/SKILL.tmpl.md`, `5x-plan/SKILL.tmpl.md`

- [ ] Read `data.result.governance.route` after validation/recording in enforced active runs; never infer gates from reviewer prose or recompute thresholds.
- [ ] Branch `complete`, `author_revision`, `final_corrections`, and `human_gate`. Final corrections invoke one author pass, verify commit/plan parse, record completion, and skip reviewer re-entry.
- [ ] For `human_gate`, surface/open the typed prompt and resume from the durable decision; in delegated noninteractive contexts return `needs_human` instead of invoking an interactive prompt.
- [ ] Keep `maxReviewIterations` as backstop for unresolved closure cycles and read it from resolved config.
- [ ] Preserve advisory/off behavior and mid-review v1 compatibility.
- [ ] Update skill/template snapshots and harness freshness content hashes through the existing generator; do not hand-edit installed user assets.

---

## Phase 8: Dashboard governance surfaces

**Completion gate:** Authenticated clients can inspect forecasts/history and resolve open review gates through the shared handler; unauthorized/stale actions cannot read or mutate state; browser smoke tests cover responsive forecast, debt, alert, and decision views.

All paths in this phase are new extensions under the merged slice-04 `src/dashboard/` layout; reconcile exact module names after that prerequisite lands.

### 8.1 Read model and versioned API — prerequisite dashboard data/routes modules; new governance adapter

```typescript
export interface ReviewGovernanceView {
  run_id: string;
  forecast: BudgetForecastView;
  ceilings: BudgetCeilingView;
  debt_claims: DebtClaimView[];
  alerts: ReviewGateCause[];
  open_gate: ReviewGateView | null;
  decisions: ReviewDecisionView[];
}
```

- [ ] Add authenticated `GET /api/runs/:runId/review-governance`; read the SQLite projection with record-backed repair/freshness semantics established by prerequisites.
- [ ] Add `POST /api/review-gates/:gateId/decisions`; verify token/cookie before parsing sensitive project data, validate API protocol version, then call `submitPlanReviewDecision` with actor `control-plane`.
- [ ] Return conflict/stale errors without side effects; never expose record origin internals, prompt tokens, or unrestricted file paths.
- [ ] Extend WebSocket snapshots/events with versioned `review_governance_updated` and `review_gate_updated`; stale clients must refresh rather than apply an unknown event shape.

### 8.2 UI components — prerequisite dashboard static component directory

- [ ] Forecast panel: gross current/pending effort, governing/original baseline, standard/effective/absolute limits, mode, and baseline direction without netting debt against gross effort.
- [ ] Debt panel: each claim's coupling, eligibility, target phase, minimal-compliant comparison, before/after evidence, provisional credit, and why ineligible claims earn no credit.
- [ ] Alerts/gate panel: causes, affected findings/claims, choice-specific forms, rationale/evidence, scope retained/removed, and explicit irreversible abort confirmation.
- [ ] Decision timeline: stable ID, actor, timestamp, rationale, evidence, approved scope, baseline change, and supersession link; no destructive edit action.
- [ ] Add accessible keyboard/focus/error states and narrow-screen layout consistent with slice 04.

### 8.3 Dashboard tests — prerequisite server/browser test suites

- [ ] Unauthorized HTTP/WS cannot inspect budget or submit a decision; authenticated submission uses the same handler/result as CLI.
- [ ] Stale gate/forecast returns conflict and refresh payload; double-click/retry produces one decision.
- [ ] WebSocket reconnect/backfill returns complete current gate and decision history.
- [ ] Browser smoke: forecast/limits/debt visible, each choice form validates required fields, successful action updates timeline and closes gate, abort confirmation is explicit.

---

## Phase 9: End-to-end audit, compatibility, and documentation

**Completion gate:** Full test suite and typecheck pass. Multi-round enforced fixtures meet every slice exit criterion; advisory/off fixtures retain previous routing; documentation and CLI help describe governance without claiming implementation-review enforcement.

### 9.1 End-to-end governance scenarios — new `test/integration/commands/plan-review-governance.test.ts`

- [ ] Initial exhaustive review → author revision → closure statuses → ready completion.
- [ ] New ordinary blocker with exact introducing hunk succeeds; stale/fabricated hunk fails without records.
- [ ] Critical late safety issue opens a human gate even when within limits.
- [ ] Deferred/accepted finding stays nonblocking; re-raise without decision/new evidence fails; re-raise with both routes correctly.
- [ ] Baseline dispute, each budget band, architecture threshold, semantic human item, valid/invalid final corrections, and intrinsic/adjacent/unrelated debt claims.
- [ ] Every human choice, repeated choice, conflicting choice, CAS race, index deletion/rebuild, process restart/resume, and full audit-history retention.
- [ ] Advisory default records hypothetical governance but follows old route; off and v1-compat do not demand new fields.

### 9.2 Run state and CLI presentation — plan-208 run-state formatter; new review command formatter

- [ ] Extend `5x run state` with active gate summary, normalized route, latest decisions, governing scope/baseline, and stable IDs while retaining plan-208 gross forecast fields.
- [ ] Provide concise text output and complete JSON fields; never hide absolute limits or positive architecture burden behind debt credit.
- [ ] Ensure malformed index/history reports an actionable diagnostic and does not silently return an empty decision ledger.

### 9.3 Documentation and exports

- [ ] Update `docs/v2/206-review-budget-governance.md` implementation status/contracts and `docs/v2/202-control-plane.md` budget-specific action mapping.
- [ ] Update `docs/v1/101-cli-primitives.md` for review gate/decision commands and structured errors.
- [ ] Update `README.md`, `CHANGELOG.md`, default config comments, public `src/index.ts` exports, and CLI help.
- [ ] Mark `docs/v2/plan-inputs/07-plan-review-governance.plan-input.md` generated/implemented only after all gates pass; leave slice-08 handoff explicit.

---

## Files Touched

Paths marked “prerequisite extension” must be reconciled against the merged plan-208/slice-04 names before implementation.

| File | Change |
|------|--------|
| `src/review-governance/types.ts` | Shared closure, gate, decision, route, and governing-state contracts. |
| `src/review-governance/fingerprint.ts` | Canonical finding fingerprint derivation. |
| `src/review-governance/closure.ts` | Initial/closure review and prior-decision validation. |
| `src/review-governance/plan-diff.ts` | Shared plan-only diff context and hunk validation. |
| `src/review-governance/routing.ts` | Pure enforced/advisory routing and final-correction validation. |
| `src/review-governance/decisions.ts` | Decision payload validation and governing-state fold. |
| `src/review-governance/store.ts` | Record/prompt facade and gate-resolution contract. |
| `src/review-governance/codec.ts` | Versioned record-line codecs. |
| `src/review-governance/sqlite-index.ts` | Rebuildable decision/gate projection. |
| `src/review-governance/apply.ts` | Shared reviewer apply/decorate/persist pipeline. |
| `src/review-governance/context.ts` | Prior finding/decision prompt projection. |
| `src/protocol.ts` | Add plan-review closure item fields/schema. |
| `src/protocol-normalize.ts` | Preserve and normalize new structured fields without deriving routes. |
| `src/commands/protocol-emit.handler.ts` | Emit complete item/follow-up payloads. |
| `src/commands/protocol.handler.ts` | Apply closure/diff/governance validation before recorded plan reviews. |
| `src/commands/protocol.ts` | Reviewer help/flags and review decision command references. |
| `src/commands/invoke.handler.ts` | Use shared governance writer for recorded plan reviews. |
| `src/commands/template-vars.ts` | Consume shared diff builder and inject decision context. |
| `src/commands/review.ts` | Register review gate/decision commands. |
| `src/commands/review-decision.handler.ts` | Validate and durably submit human decisions. |
| `src/commands/run-v1.handler.ts` | Shared paired write integration and run-state governance projection. |
| `src/control-plane/types.ts` | Optional typed prompt context (prerequisite extension). |
| `src/control-plane/store.ts` | Typed prompt/gate query support without direct SQL (prerequisite extension). |
| `src/control-plane/{sqlite-store,memory-store}.ts` | Persist optional prompt context and preserve CAS. |
| `src/db/schema.ts` | Next migration for prompt context and governance indexes. |
| `src/templates/reviewer-plan.md` | Exhaustive initial review and lowest-cost correction contract. |
| `src/templates/reviewer-plan-continued.md` | Closure-only review, exact hunk, critical safety, and decision ledger contract. |
| `src/skills/base/5x-plan-review/SKILL.tmpl.md` | Route execution, human gate, and final-correction branches. |
| `src/skills/base/5x-plan/SKILL.tmpl.md` | Generated-plan workflow integration. |
| `src/dashboard/**` | Forecast/debt/alert/decision API, WS, and UI extensions after slice 04 merges. |
| `src/index.ts` | Public governance types and handler-safe action exports. |
| `test/unit/review-governance/*.test.ts` | Pure policy, fingerprint, diff, route, codec, fold, and store tests. |
| `test/unit/commands/{protocol-emit,protocol-validate,review-decision}.test.ts` | Command-level validation and action tests. |
| `test/unit/db/schema*.test.ts` | Migration/index constraints and upgrades. |
| `test/integration/commands/{protocol-emit,protocol-validate,plan-review-governance}.test.ts` | CLI contracts and end-to-end review rounds. |
| `test/integration/dashboard/**` | Auth, API/WS, CAS, and browser smoke tests (prerequisite extension). |
| `docs/v2/{202-control-plane,206-review-budget-governance}.md` | Implemented governance/control-plane contracts. |
| `docs/v1/101-cli-primitives.md` | Review gate/decision CLI documentation. |
| `README.md`, `CHANGELOG.md` | User-facing enforced-mode and compatibility notes. |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/review-governance/fingerprint.test.ts` | Canonical identity stability and material-change detection. |
| Unit | `test/unit/review-governance/closure.test.ts` | Prior statuses, new blocker rules, critical safety, decision re-raise, follow-ups. |
| Unit | `test/unit/review-governance/debt-policy.test.ts` | Complete evidence, coupling, minimal-compliant comparison, and no false credit. |
| Unit | `test/unit/review-governance/plan-diff.test.ts` | Exact hunk/range matching and review-artifact-only HEAD changes. |
| Unit | `test/unit/review-governance/routing.test.ts` | Full enforced/advisory routing matrix and readiness normalization. |
| Unit | `test/unit/review-governance/decisions.test.ts` | Choice validation, immutable history, supersession, and governing-state fold. |
| Contract | `test/unit/review-governance/store-contract.test.ts` | Memory/working-tree decision ordering, idempotency, CAS, and repair behavior. |
| Unit | `test/unit/db/schema-review-governance.test.ts` | Fresh/upgrade schema, indexes, constraints, and wiped-index rebuild. |
| Unit | `test/unit/commands/protocol-{emit,validate}.test.ts` | New item fields, CLI-owned-key rejection, active/v1 compatibility. |
| Unit | `test/unit/commands/review-decision.test.ts` | Choice-specific payloads, stale gates, repeated/conflicting submissions, abort parity. |
| Integration | `test/integration/commands/protocol-validate.test.ts` | Recorded plan-review evidence and no-write-on-failure behavior. |
| Integration | `test/integration/commands/plan-review-governance.test.ts` | Multi-round review, prompts, decisions, restart, audit history, and mode compatibility. |
| Integration | prerequisite dashboard server tests | Token auth, handler parity, API/WS versions, stale gate, and CAS races. |
| Browser | prerequisite dashboard smoke suite | Responsive forecast/debt/history rendering and all gate-action forms. |
| Regression | full `bun test` and `bunx tsc --noEmit` | Existing prompt, records, protocol, invoke, skills, and run-state behavior remains valid. |

---

## Not In Scope

- **Implementation-review governance** — item classes, code-diff evidence, plan impact, realized credit, and post-correction quality gates belong to slice 08.
- **A second implementation budget** — implementation inherits approved plan scope; this slice governs plan review only.
- **General debt discovery/refactoring** — only directly coupled plan work can receive provisional credit.
- **Automatic safety suppression** — material correctness, security, data-loss, and acceptance findings stay visible and route to a human where required.
- **Enforced as global default** — advisory remains the default until calibration supports a separate policy change.
- **Dashboard/server foundation** — authentication, base HTTP/WS server, prompt delivery, run/log read model, and generic actions are prerequisites from slice 04, not reimplemented here.
- **Advisory parser/arithmetic/store foundation** — plan 208 owns delivery-budget parsing, formulas, baseline capture, snapshot pairing, and budget index.

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Governance domain and convergence policy | 2 days |
| 2 | Durable decisions and governing-state fold | 3 days |
| 3 | Closure protocol and plan-diff validation | 3 days |
| 4 | Enforced routing and readiness normalization | 2 days |
| 5 | Human gate prompt and decision actions | 3 days |
| 6 | Recording integration and workflow context | 3 days |
| 7 | Reviewer templates and workflow skills | 2 days |
| 8 | Dashboard governance surfaces | 3 days |
| 9 | End-to-end audit, compatibility, and docs | 3 days |
| **Total** | | **24 working days** |

---

## Provenance

This plan implements `v2-plan-review-governance` from [`07-plan-review-governance.plan-input.md`](../../v2/plan-inputs/07-plan-review-governance.plan-input.md). It is the enforced-routing follow-on to plan 208's advisory budget foundation and consumes slice 04's authenticated control-plane dashboard. It intentionally leaves implementation-review governance and realized debt reconciliation to `08-implementation-review-governance.plan-input.md`.
