# Review Budget Inspection — Recorded State, Evidence, and Decision History

**Version:** 1.1
**Created:** September 23, 2026
**Status:** Reviewed — approved by closure review and human architecture approval on September 23, 2026; implementation requires completed and integrated plan 210

## Executive Summary

Add `review budget show` and `review budget history` as read-only explanations of recorded budgets. A shared, typed model joins baseline/snapshot records with reviewer steps and accepted governance decisions, preserves exact as-of boundaries, and feeds both JSON and dedicated terminal renderers. Inspection never reads today's plan to score yesterday's work and never turns an advisory prediction into an actionable gate.

The dependency baseline is the **completed plan-209 implementation at `38f348eb4657c1af1daa17f9fa564b0135bd6234`**, not main's older advisory surface. Plan 210 is **approved but not yet implemented**. Per human scope decision `3fe3acb7-ec66-47e0-8e28-4420242c2ccb`, completed and integrated 210 is a mandatory prerequisite **before any plan-214 implementation**: execution order is **210, then 214**. All W1–W6 and all six phases are required for one release/completion gate; there is no independent plan-only release, skipped adapter, or deferred W6. Technical verification must reconcile actual integrated 210 interfaces with the newer 209 seams before product work. Inspection consumes, never implements, binding, realization policy, typed decision authority or execution approval on behalf of 210.

### Scope

**In scope:** latest/exact snapshot inspection; baseline-only and uninitialized states; decision-aware history; stable cursor pagination; structured differences; full JSON evidence; safe, width-aware concise/verbose text; archived-run lookup; a compact `run state --text` hint; required compatibility with 210's inherited execution state. All six work items are retained by the human decision; 210 must be implemented and integrated first.

**Out of scope:** mutation commands, baseline capture, prompts/notification repair, new budget formulas, new persistent summaries, TUI/charts, live forecasts, arbitrary pairwise comparison, export formats, implementation governance itself, or a global output migration.

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Read authoritative streams through existing facades | SQLite projections can be absent or stale; snapshot `derived` is not a durable payload field. |
| Join on exact durable identities, order by paired steps | Timestamp ordering cannot implement decision acceptance or stable pagination. |
| Extend canonical pure effective-state helpers | Current route helpers compute budget internally; copying their filtering would create a second policy engine. |
| Separate historical state from current actionability | An explicit snapshot is evidence, not permission to answer an old gate. |
| Complete/integrate 210 before starting 214; deliver both domains together | Avoids a mid-run dependency stall while retaining W6; implementation state comes from verified 210 contracts, never guesses from an absent baseline. |

### References

- [Requirements: review budget inspection](../../v2/209-review-budget-inspection.md)
- [Completed dependency plan 209](./209-plan-review-governance-plan.md), inspected with its source/tests/docs at the SHA above.
- [Approved implementation governance plan 210](./210-implementation-review-governance-plan.md), read in full, including its binding, lineage, realization, typed decision and compatibility contracts.
- [Output normalization](../../v2/205-output-normalization.md), [governance](../../v2/206-review-budget-governance.md), [implementation plan template](../../../../docs/_implementation_plan_template.md), and `5x-cli/AGENTS.md`.

## Table of Contents

1. [Overview and prerequisites](#overview)
2. [Design Decisions](#design-decisions)
3. [Delivery Budget](#delivery-budget)
4. [Architecture Overview](#architecture-overview)
5. [Phases](#phase-1-verify-dependencies-and-resolve-read-only-record-inputs-w1)
6. [Files Touched](#files-touched)
7. [Tests](#tests)
8. [Estimated Timeline](#estimated-timeline)

## Overview

### Inspected state and concrete seams

Authoring checkout is main at `0bb3b7a0943ac0b04d83bdfb75dc11234535905d`. Dependency inspection was read-only in `.5x/worktrees/209-plan-review-governance-plan-68d554`; no branch/worktree changes or integration are part of this planning task. All source references below are relative to `5x-cli/` at **38f348e**, unless marked main. Proposed files/interfaces are explicitly new, not claims about shipped APIs.

| Existing seam | What actually exists / implication |
|---|---|
| `src/control-plane/review-budget-store.ts:31–107,126–149,294–343` | Baseline, snapshot, list readers and diagnostic sink. Snapshot payload carries findings/assessments/prior outcomes; cached derived aggregates may be null after rebuild. Reads can repair the local index, not authoritative records. |
| `src/review-governance/decisions.ts:244–413,472–490` | Canonical acceptance uses reviewer/human **steps insertion order**, including intervening plan reviewers; fold handles supersession and audit-only decisions but scans streams per decision. Extract indexed acceptance and incremental fold inside this canonical module, retaining wrappers; do not repeatedly fold sliced prefixes. |
| `src/review-budget/apply.ts:335–375` | Assembles B0, governing B, first assessment I, recorded ledger/findings/effective assessments, pinned config and verdict-derived semanticHumanRequired. Share this pure reconstruction assembly with inspection and run-state reconstruction, rather than add a third copy. |
| `src/review-governance/routing.ts:308–321,343–409` | Pinned advisory route versus hypothetical enforced route; accepted-risk filtering and post-decision budget recomputation exist, but post-decision helper returns only a route. Expose its calculated state rather than clone its formulas. |
| `src/review-governance/apply.ts:37–66` | Persisted finding carry-forward is reusable but omits legacy findings lacking evidence. Inspection must retain visible partial rows with unavailable fields, not erase them or manufacture evidence. |
| `src/review-governance/store.ts:239–325` | Pure gate derivation exists, but gate-shaped causes alone do not check pinned mode/run terminal status. They are not sufficient actionability authority. |
| `src/commands/review-decision.handler.ts:85–139` | `showPlanReviewGate` repairs and creates prompt notifications. **Do not call it from inspection.** Its typed mutation interfaces remain unchanged. |
| `src/commands/review-budget-context.ts:120–140,181–207,223–350,397–525` | Latest plan-scoped configuration, durable reviewer identity, contextual assessment contract, and paired writer. Only reading/config patterns are reusable; composition/capture/finalization are forbidden inspection paths. |
| `src/commands/run-v1.handler.ts:1173–1272,1359–1475,1963–2103,2137–2350` | Compact budget/text; `loadGitRecordForPlan` at 1963 loads candidate runs before choosing the latest; archived `--plan` caller is at 2137. Extract a selector-before-stream-read core. Existing budget builder optionally parses current Markdown and has best-effort fallbacks; it is not an exact inspection model. Existing explicit `--run` does not supply the archived `--plan` fallback automatically. |
| `src/commands/record-context.ts:123–192` | Write-oriented context creates installation identity and requires live DB execution context. Extract/reuse resolution primitives for a read context instead of calling this blindly for archived runs. |
| `src/commands/review.ts:26–75` | Commander family registration, ambient run resolution and existing output helpers; not citty. |
| Main `src/output.ts:161–173,192–288` | Global format state and custom formatter callback already exist. New commands can honor global flags/environment without waiting for all of design 205. |

### Newer dependency changes versus approved plan 210's cited base

Plan 210 cites `afb132046701a9b3ba6e7190283c0516dbc4391d`. The required 38f348e adds `886feff` (generation/recovery and durable review-step identity), `d60d696` (plan-context policy), and `aa66753` (archived plan-context policy), followed by verification/sealing. Inspection must therefore:

- Join snapshots by `(stepName, phase, iteration)`, including `reviewer:plan`, not assume `reviewer:review` or session identity. Recovery retains invocation provenance; rejected, unrecorded verdicts are not history events.
- Carry the first persisted `baselineAssessment` forward without requiring closure reviews to repeat it. Use snapshot/step identity, not a guessed iteration counter.
- Resolve unpinned config at the mapped effective plan directory, and archived policy at the known plan directory, independent of caller CWD. Baseline mode/thresholds always win.
- Preserve the already-shipped v9/v10 projections and paired admission/finalization; this feature needs no migration or new writer.

Evidence: dependency `test/integration/commands/review-budget.test.ts:194–363` covers archived/mapped/plan-local policy and `:817–985` covers `reviewer:plan` continuation/recovery. `docs/v2/206-review-budget-governance.md:3–16` explicitly says plan governance shipped and implementation reconciliation remains slice 08. Updated `docs/v1/101-cli-primitives.md` documents the current recovery/record contract. These latest seams supersede the older line references in 210, not its approved design authority.

### Prerequisites and delivery order

1. **Orchestrator start gate, before ANY plan-214 implementation:** complete and integrate approved plan 210, on completed 209 through 38f348e (ancestry or documented source/test equivalence). Verify completed 210 source/tests, binding/state readers, realization derivation, domain-specific decisions and completion predicates; reconcile actual signatures and changes since its afb1320 reference before product work. Approval of 210's Markdown alone does not pass. If functionality is absent or the read-only handoff cannot be reconciled, do not begin Phase 1; return a prerequisite block, not a mid-run W6 skip. Integration is external to this plan's work and is not authorized during plan authoring.
2. Verify global `--text`/`--json`, `FIVEX_OUTPUT_FORMAT`, custom `outputSuccess` rendering and error behavior in that integrated checkout. Existing normalization primitives suffice; design 205's setup-command migration is **not** a dependency. If those primitives were changed by coordinated normalization, consume its final contract before Phase 5; do not introduce private precedence or alter other commands.
3. All six phases execute sequentially after that start gate. Phase 5 is internal CLI/plan-domain acceptance, not a release or completion boundary. Phase 6 consumes interfaces already verified before Phase 1 and completes the required combined-domain release. No W6 deferral, skip, split or budget removal is permitted under the retained-scope decision.
4. Existing plan-209 runs remain fully supported in the combined release. Off/v1 runs are explicit compatibility views, not opt-in opportunities. Unknown domain/version records cannot masquerade as uninitialized plan budgets; valid integrated-210 records must be supported, not rejected as a planned future capability.

## Design Decisions

**One immutable read set per request.** Resolve one run/source and freeze its baseline, budget, steps and decision streams in memory. Use a read-only interface and no prompt store/writer capability. Local index repair may remain available through existing infrastructure, but inspection must not create installation attribution, run records, steps, prompts, locks, configuration, or decisions. Detect missing causal pairs under concurrent reads and retry a bounded number of times; persistent inconsistency is a structured error/incomplete history, not a fabricated ordering.

**Stable identity/order with causal boundaries.** Public event IDs are versioned opaque encodings of run ID, event kind and the durable baseline/snapshot/decision ID (not offsets, line numbers, timestamps or SQLite IDs). `show --snapshot` takes the underlying snapshot UUID. Baseline precedes budgeted review events; reviews and decisions use the positions of their paired reviewer/human steps in the authoritative steps stream. Within an equal boundary use persisted stream order then durable ID; inconsistent duplicate pairs fail selected-state resolution. Fold only prefixes effective at the selected boundary, including supersession only when its human step is in that prefix. Stale/audit-only decisions remain visible with disposition and no effective-state delta. Missing-boundary decisions are diagnosed audit-only entries at a deterministic trailing position in incomplete history, never applied or shown as preceding their referenced review.

**Bounded page, run-scoped scan.** Decode the selected run's streams once, build canonical acceptance indexes, and advance a canonical incremental fold chronologically rather than repeatedly calling whole-store readers or folding complete prefixes per event. Acceptance is fixed at the paired human boundary; only decision inclusion/supersession changes at later boundaries. Linear decode/position-scan counts are required, not constant-time seeking or linear total rendering of arbitrarily large ledgers. Indexed supersession maintenance may cost logarithmic updates; materialization scales with emitted state/evidence. Retain full evidence only for selected show state or page events, plus register/state needed for comparison. History returns 20 events by default, accepts integer limits 1–100, orders each page oldest-to-newest and provides `next_before` equal to the oldest returned event ID only when older events exist. Exclude the cursor event; unknown/foreign-run/invalid cursors fail. New appends do not change valid prefix ordering or earlier deltas. An unrelated-run scan may discover **identities/paths** for an archived ID, but may not decode unrelated streams.

**One canonical recorded-budget reconstruction, explicit base budget.** Extract `deriveRecordedReviewBudget` in `review-budget/apply.ts` from its current input assembly. It consumes baseline, a bounded snapshot-prefix view, selected snapshot facts, paired verdict semantics and governing B at the review boundary, and calls `deriveBudget`. The prefix view carries the first recorded baseline assessment (or null) without rescanning prior snapshots. Recording's already-validated pending facts, run-state's recorded-snapshot reconstruction and inspection all use that assembly. Inspection ignores cached `snapshot.derived` as authority: it reconstructs a base at the review boundary, then passes `baseBudget` explicitly to the extracted effective-state helper in routing for later accepted decisions. `routeAfterDecision` remains a compatibility wrapper, including its existing null-derived error and early abort/scope/reestimate routes; inspection does not call that nullable-cache wrapper. No revalidation of old Git hunks, current-plan rescoring or today's policy. Compare reconstruction with the paired step's recorded budget decoration, preserve recorded review route, and diagnose disagreement. Missing authoritative forecast inputs fail; missing optional evidence is nullable.

**Canonical indexed acceptance and incremental fold, not private inspection policy.** Extract `buildDecisionAcceptanceIndex` / `classifyDecisionAcceptanceIndexed` and an incremental governing-state fold in `review-governance/decisions.ts`. Predecode snapshot identity multiplicities, exact step-key positions, human `(decisionId, gateId)` positions and per-domain reviewer prefix counts once. Existing `classifyDecisionAcceptance` and `foldGoverningReviewState` delegate as wrappers with parity tests. Feed accepted/audit decisions into the accumulator at their human boundaries, retaining original decision-stream order for fold precedence. Indexed active contributions support supersession removal and recomputation of only affected state components, not replay of all prior decisions. The canonical module owns both semantics and this optimization; inspection only consumes it. Integrated 210's domain/phase/binding discriminator and stale-boundary rules remain authoritative.

**Original, captured and governing baselines are distinct provenance.** Original means `baseline.b0` / B0. Preserve capture's `baseline.b` as `captured_baseline`, even if it differs. The shipped governing fold seeds from b0; do not silently change that rule to b. Reconstruction requires an explicit boundary governing B when governed, with baseline.b fallback only in existing non-governed caller paths. Test divergent b0/b records and label/diagnose any disagreement instead of relabeling B0 or overwriting the canonical fold. Execution bindings use 210's inherited source governing state, not either number guessed from an execution baseline.

**Snapshot state and current actionability are different.** Latest selection includes subsequent accepted decisions and shows `effective_through_event_id` separately from `snapshot_id`. Exact snapshot selection ends at its paired review step and never offers an actionable gate, even if that gate was open then. `governance` separates recorded review route, effective route, hypothetical enforced route and historical gate details. Only latest, enforced, nonterminal, canonically unresolved state may expose an actionable gate. Completed/aborted runs always explain terminal status; advisory alerts are labeled predictions that did not block completion. Neither `requiresHuman` nor `deriveOpenGate` alone grants actionability.

**Historical evidence is incomplete by design, not reconstructed.** Preserve work-item rationale and raw recorded associations; carry finding titles, fingerprints, failure/correction evidence, outcomes and decision references forward. An empty final `items[]` does not erase addressed findings. Use canonical finding identity/status where available; retain legacy rows with unknown fingerprint/status/evidence and diagnostics rather than synthesize a fingerprint. Disappearance alone is not proof of closure. Assessment carry-forward must match the recorded claim evidence; changed claims do not inherit stale eligibility. Allowed credit is the aggregate canonical value, not a fictional per-claim allocation of a global cap.

**Implementation is a distinct consumer domain.** For 210, select the binding and its inherited self-contained approved source state, not a newly captured execution baseline. Preserve original/source governing baseline, source run/snapshot/baseline IDs, pinned policy, approved W IDs and authorized amendment lineage. Plan findings and implementation telemetry are separate discriminated arrays/registers; phase-qualified implementation identity cannot collide with a plan finding ID. Never feed implementation deltas into plan `R`, create debt claims, or infer credit from negative telemetry. Realized/partial/not-realized, provisional/not-due, missing/unreconciled and waived states come only from 210's reconciliation and verified correction-proof readers. Typed decision `nextAction` and domain/phase/binding provenance pass through unchanged. Inspection cannot bind, authorize amendments, verify corrections or advance phases.

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Read-only live/archived input resolution and diagnostics | 3 | 1 | - | P1.1 | Retains cross-subsystem estimate: front-loads completed-210 verification and clarifies the already-scored archive locator/no-DB/ref-selection tests, without adding an authority or boundary. |
| W2 | Canonical as-of effective state, ordering and event identity | 5 | 1 | - | P1.2, P1.3 | Retains new-abstraction effort: makes the existing shared reconstruction/fold obligation concrete in apply.ts and decisions.ts, including explicit-base, indexed supersession and wrapper parity tests. Two additional existing files, no new policy/schema; estimate assumes bounded extraction, not a second engine. |
| W3 | Inspection model, evidence register, differences and pagination | 5 | 2 | - | - | New exported view contract and historical projection spanning ledger/findings/claims; carries missing-data provenance and stable page semantics. |
| W4 | Dedicated safe terminal renderers | 3 | 1 | - | - | Show/history and verbose evidence presentation with Unicode width/control safety, tested as pure string functions. |
| W5 | CLI adapters, discovery and plan-domain acceptance | 3 | 0 | - | P1.1 | Same existing command/output/export/docs work and subprocess tests; Phase 5 is internal acceptance only, with release blocked until required W6 completes. |
| W6 | Read-only adapter to implemented 210 domain contracts | 3 | 1 | - | P1.1 | Retains cross-domain consumer estimate and all scope; completed/integrated 210 interfaces must be verified before any 214 implementation, not discovered missing here. Mapping/tests only; any authority gap blocks startup and requires revised handoff. |

No negative architecture deltas or debt claims are proposed. Tests are part of their owning implementation work item; prerequisite verification and documentation are included in the corresponding phase, not separate scored items.

### Surface Snapshot

- Subsystems: 4
- Production files: 15
- Persistent/external boundaries: 2
- New shared abstractions: 2
- New persistent schemas: 0

Subsystems: command integration, record/progress resolution, governance projection, and inspection model/presentation. Boundaries: existing run record streams (read-only) and existing Git-backed archived reads. Abstractions: immutable ordered read set and shared inspection view model. Fifteen production files are enumerated below, now including shared-helper extraction in existing apply.ts and decisions.ts; no source changes to 210's binding/realization writers are counted or authorized. Individual scores are unchanged: the revision specifies missing reuse mechanisms within W2, not additional functionality. The pre-start interface verification must confirm these bounded estimates against actual integrated 210; unexpected authority work requires a plan revision, not hidden consumer scope.

## Architecture Overview

```text
Commander review budget show/history
  -> ambient/explicit identity + validated selectors
  -> read-only run resolver (live mapped records OR exact archived run)
  -> immutable run-scoped read set + diagnostics
  -> paired-step event order + as-of prefix
  -> canonical decision fold / budget derivation / effective governance
     (required 210 domain adapter consumes already-integrated binding/reconciliation)
  -> inspection model + evidence register + structured deltas
  -> JSON envelope OR dedicated safe text
```

### Proposed interfaces (new)

```typescript
type InspectionSelection =
  | { kind: "latest" }
  | { kind: "snapshot"; snapshotId: string };
type BudgetInspectionStatus = "active" | "baseline_only" | "uninitialized"
  | "off" | "v1_compat";
type InspectionEventId = string; // opaque, versioned, run-qualified durable identity
type InspectionDomain = "plan" | "implementation";

interface InspectionDiagnostic {
  code: string;
  message: string;
  event_id: InspectionEventId | null;
  affects: "evidence" | "ordering" | "state";
}
interface InspectionReadSet {
  run: RunRecord; // imported existing run-summary type, not a second run schema
  source: { kind: string; ref: string | null };
  steps: readonly RecordLine[];
  budget: readonly RecordLine[];
  decisions: readonly RecordLine[];
  unpinnedPolicy: ReviewBudgetConfig | null;
  diagnostics: readonly InspectionDiagnostic[];
}
interface InspectionChanges {
  comparison_event_id: InspectionEventId | null;
  aggregates: Partial<Record<keyof DerivedBudgetResult,
    { before: unknown; after: unknown }>>;
  work_items: Array<{ id: string; kind: "added" | "removed" | "changed";
    before: ParsedWorkItem | null; after: ParsedWorkItem | null }>;
  findings: FindingStateChange[];
  alerts: { added: BudgetAlert[]; removed: BudgetAlert[] };
}
interface BudgetInspection {
  run_id: string;
  plan_path: string;
  run_status: string;
  domain: InspectionDomain;
  budget_status: BudgetInspectionStatus;
  selection: { kind: "latest" | "snapshot"; snapshot_id: string | null;
    effective_through_event_id: InspectionEventId | null };
  baseline: BaselineInspection | null; // original ledger/policy/capture/provenance
  snapshot: SnapshotInspection | null; // exact tuple, review kind, time/commit
  budget: DerivedBudgetResult | null; // existing names B0/B/I/W/R/S/N/D/E/A/P
  governance: GovernanceInspection | null;
  work_items: ParsedWorkItem[];
  findings: FindingInspection[]; // domain discriminated, evidence is nullable
  debt_claims: DebtClaimInspection[];
  decisions: EffectiveDecisionInspection[];
  changes_since_previous: InspectionChanges | null;
  completeness: { complete: boolean };
  diagnostics: InspectionDiagnostic[];
}
interface InspectionHistory {
  run_id: string;
  events: Array<{ id: InspectionEventId; kind: "baseline" | "review" | "decision";
    domain: InspectionDomain; timestamp: string | null;
    snapshot_id: string | null; decision_id: string | null;
    state: InspectionEventSummary; changes: InspectionChanges | null }>;
  pagination: { limit: number; has_more: boolean; next_before: InspectionEventId | null };
  completeness: { complete: boolean };
  diagnostics: InspectionDiagnostic[];
}
async function resolveBudgetInspectionInput(input: {
  runId: string; startDir?: string;
}, deps: InspectionReadDeps): Promise<InspectionReadSet>;
function buildBudgetInspection(input: InspectionReadSet,
  selection: InspectionSelection): BudgetInspection;
function buildBudgetHistory(input: InspectionReadSet,
  page: { limit: number; before?: InspectionEventId }): InspectionHistory;
function renderBudgetInspection(view: BudgetInspection,
  options: { width: number; verbose: boolean }): string;
function renderBudgetHistory(view: InspectionHistory,
  options: { width: number }): string;
```

The named nested `*Inspection` types are defined in Phase 3 using imported budget/governance types, not `any` payload passthrough. Every evidence field gets event/source identity and nullable unavailable state. `GovernanceInspection` includes `recorded_review`, `effective_route`, `hypothetical_enforced_route`, `historical_gate`, and nullable `actionable_gate`; `recorded_review` retains the original decoration. Phase 6 adds a discriminated implementation context containing inherited binding/source and typed realization/decision details without changing plan field meaning. Unknown authoritative domain/version returns `BUDGET_INSPECTION_UNSUPPORTED`, not a successful zero budget.

### Shared canonical helper contracts (W2; proposed names)

```typescript
// apply.ts: prefix is prepared once while visiting snapshots in recorded order.
interface RecordedBudgetPrefix {
  throughSnapshotId: string;
  firstAssessment: BaselineAssessment | null;
}
type RecordedBudgetFacts = Pick<ReviewBudgetSnapshotRecord,
  "currentLedger" | "findings" | "assessments">;
function deriveRecordedReviewBudget(input: {
  baseline: ReviewBudgetBaseline;
  prefix: RecordedBudgetPrefix;
  snapshot: RecordedBudgetFacts; // never reads .derived
  pairedVerdict: Pick<ReviewerVerdict, "items">;
  governingBaseline: number; // at the selected review's boundary
}): DerivedBudgetResult;
// The one input assembler also serves run state's existing semantic callback.
function buildRecordedReviewBudgetInput(input: {
  baseline: ReviewBudgetBaseline;
  prefix: RecordedBudgetPrefix;
  snapshot: RecordedBudgetFacts;
  governingBaseline: number;
  semanticHumanRequired: boolean;
}): Parameters<typeof deriveBudget>[0];
// deriveRecordedReviewBudget computes the semantic flag from pairedVerdict,
// then calls this assembler and deriveBudget; no duplicate input mapping.

// routing.ts: independent of SQLite projection availability.
function deriveEffectivePlanReviewState(input: {
  baseBudget: DerivedBudgetResult;
  snapshot: RecordedBudgetFacts;
  verdict: ReviewerVerdict;
  mode: "advisory" | "enforced";
  governingState: GoverningReviewState;
  decision?: ReviewDecisionPayload;
}): { budget: DerivedBudgetResult; governance: PlanReviewGovernanceResult;
  route: ReviewDecisionRoute };

// decisions.ts: these are canonical helpers, not inspection-local equivalents.
function buildDecisionAcceptanceIndex(input: {
  steps: readonly RecordLine[]; budget: readonly RecordLine[];
}): DecisionAcceptanceIndex;
function classifyDecisionAcceptanceIndexed(input: {
  decision: ReviewDecisionPayload; index: DecisionAcceptanceIndex;
}): DecisionAcceptance;
function createGoverningReviewFold(input: {
  b0: number; index: DecisionAcceptanceIndex;
}): {
  include(decision: ReviewDecisionPayload, decisionStreamPosition: number): void;
  summary(): GoverningReviewSummary;
  materialize(): GoverningReviewState;
};
```

The integrated 210 types/domain selectors may refine these signatures at the mandatory pre-start verification, without weakening plan wrapper behavior or merging plan/implementation findings. `summary()` avoids copying complete history/risk arrays at every event; `materialize()` is for requested show/page evidence and compatibility wrappers. Prefix summaries and acceptance indexes carry missing/duplicate diagnostics, not fabricated validity. The lower-level budget assembler owns **all** B0/B/I/ledger/findings/assessments/threshold input mapping; `deriveRecordedReviewBudget` adds paired-verdict semantics and calls it, while the existing run-state callback supplies that same semantic input without fake verdict items.

## Phase 1: Verify dependencies and resolve read-only record inputs (W1)

**Completion gate:** The pre-start gate has verified completed/integrated 210 on latest 209 and reconciled its actual read contracts before any product edits. One run is then resolved from live mapped or archived storage without authoritative writes, regardless of caller directory; output prerequisites are also satisfied.

**Files:** new `src/commands/review-budget-read-context.ts`; extend `src/records/resolve.ts`; extract the existing `loadGitRecordForPlan` reading primitive at `src/commands/run-v1.handler.ts:1963–2103` into new `src/records/run-reader.ts` while preserving its existing caller at `:2137–2350`. Ref discovery is `records/resolve.ts:253–358`; mapped config is `review-budget-context.ts:120–140`.

- [ ] **Before any implementation**, verify completed/integrated 210 and 38f348e ancestry/equivalence, passing dependency tests and actual binding/as-of-state/realization/domain-decision read seams. Record signatures and any drift from the approved 210 design and this plan; confirm the required W6 adapter can consume them without new authority. Missing functionality blocks starting 214, not just Phase 6. At execution run dependency policy, continuation/recovery, decision/store, realization and rebuild regressions; no merge or dependency edits are implicit. This documentation revision does not run those tests.
- [ ] Add injected read dependencies and immutable read-set types. Reuse ambient precedence (`FIVEX_RUN`, unique mapped worktree, pointer) in the adapter; explicit run wins. Preserve active mapped-worktree fail-closed errors instead of falling back to unrelated main records.
- [ ] Implement exact archived **run ID** resolution: use indexed plan/run locator when available; otherwise discover only `<records>/<slug>/<requested-run>/run.json` paths/identities before reading streams. Search the current configured records working tree and known mapped worktree (if any), plus the same local candidate refs as `collectCandidateTips`: local `5x/*`, already-present remote-tracking `*/5x/*`, configured `plans.branch`, and HEAD. Batch/deduplicate tips; no arbitrary refs or automatic fetch/network. This discovery does not require the slug first. Once found, resolve the canonical plan and use existing progress topology/working-tree precedence and divergence handling, restricted to the requested identity; never choose a newer run for that plan. Divergent same-ID authoritative copies fail explicitly. Refactor selector-before-stream-read so unrelated run streams are neither read nor decoded, preserving the old plan-latest wrapper's selection behavior.
- [ ] Do not reuse `review.ts`'s write-oriented `contextFor`, which requires a control plane. With explicit `--run` and no DB, discover repository/config read-only and resolve archived records through the above candidates; missing record is `RUN_NOT_FOUND`. Without explicit identity and without a usable ambient resolver, return `RUN_CONTEXT_REQUIRED` with explicit-`--run` remediation. Do not initialize a DB/control plane or create identity files to inspect an archive.
- [ ] For archived records with no live run row, use the archived run's canonical plan identity and known plan directory; no requirement that today's plan exists. Resolve unpinned policy with mapped plan context only when no authoritative baseline/binding exists; label it unpinned. Missing original evidence does not trigger a plan read or capture.
- [ ] Capture decoder diagnostics through sinks. A corrupt baseline is not absence; distinguish `RUN_NOT_FOUND`, unsupported version, unreadable authoritative data and optional missing metadata. Do not swallow malformed selected state under current run-state's best-effort warning convention.
- [ ] Unit tests use injected stores/Git readers/config and assert capability boundaries; integration tests cover live/completed/aborted/archived, missing DB row and absent DB, explicit versus unavailable ambient identity, exact old run among several for one plan, each documented ref source/divergence, unavailable mapped worktree, root/subproject CWD parity, changed config after pinning and empty streams. Assert unrelated streams are not loaded; snapshot hashes/content of authoritative files and prompt rows before/after repeated resolution.

## Phase 2: Ordered events and canonical as-of effective state (W2)

**Completion gate:** Null-derived archived/rebuilt snapshots reconstruct identically to recorded budgets; indexed acceptance and incremental prefix state match canonical wrapper behavior without repeated stream scans. Historical decisions cannot leak backward, and inspection cannot create notifications.

**Files:** new `src/review-budget/inspection-events.ts`; extend `src/review-budget/apply.ts:335–375`, `src/review-governance/routing.ts:343–409`, `src/review-governance/decisions.ts:244–413` and recorded-budget reconstruction in `src/commands/run-v1.handler.ts:1205–1236`. Reuse `store.ts:273–325` and `arithmetic.ts`; no decision writer or acceptance-policy changes.

- [ ] Build one run-scoped identity map from baseline/snapshot/decision records and exact paired steps. Handle `reviewer:plan`, recovered records, arbitrary legal reviewer step names and reused iteration values in different phases. Verify duplicate UUIDs/tuples and causal order; a review with no valid paired step cannot become a complete selected snapshot.
- [ ] Encode/decode opaque event IDs with run/kind/durable identity and a version. Keep snapshot UUID distinct from history event ID. Order valid entries by paired-step boundaries, not timestamps. Preserve baseline/snapshot stream causality. Build the canonical `DecisionAcceptanceIndex` once: predecoded snapshot ID multiplicities/step keys, exact reviewer tuple positions, human decision/gate positions and reviewer prefix counts. Indexed acceptance tests whether an intervening domain-relevant reviewer exists via counts at the two boundaries; preserve the plan-only predicate and integrated 210's domain/phase/binding rules. Missing/duplicate pairs retain existing diagnostics, never choose an arbitrary winner.
- [ ] Refactor `classifyDecisionAcceptance` to build an index and delegate to `classifyDecisionAcceptanceIndexed`; refactor `foldGoverningReviewState` to build one index and use the shared accumulator instead of calling the scan wrapper per decision. Preserve exact wrapper return shapes, default b0 seed, decision-stream precedence, stale/audit-only classification and supersession behavior. Acceptance for a well-formed decision is computed once at its human boundary, not for every later event prefix; corrupt duplicate identities remain diagnosed/fail-closed.
- [ ] Advance `createGoverningReviewFold` once through ordered event boundaries. Include a decision only when its human step is effective, while keeping its original decision-stream position as the fold precedence key. Maintain indexed active contributions for baseline, scope, dispute/reestimate, risks, architecture approvals and abort, plus accepted supersession references. When a target is superseded, deactivate its contribution and update affected component summaries (ordered keyed winners/collections), not replay all preceding decisions. Preserve the existing rule that an accepted superseder's reference suppresses its target even if that superseder is itself later superseded; do not accidentally reactivate older targets. Handle references to targets not yet included by keeping the suppression reference. Materialize history/audit lists only for requested state/page or wrapper output. Later decisions cannot mutate an earlier saved summary. Include audit-only events with no effective-state delta.
- [ ] Extract `deriveRecordedReviewBudget` and its shared lower-level input assembler in `apply.ts`. For each review boundary supply B0 from baseline.b0, explicit governing B from that boundary's canonical fold (existing non-governed callers retain baseline.b fallback), I from the first recorded assessment in the bounded prefix, selected recorded ledger/findings/effective assessments, baseline.configSnapshot and semanticHumanRequired from the **paired verdict's human_required items**. Recording passes its already-validated pending facts through the same assembly; no capture/composition is called on reads. Replace the run-state recorded-snapshot reconstruction assembly with the same helper core, retaining its callback, optional live-plan baseline-only behavior and public output contract. Maintain the first-assessment prefix accumulator once rather than searching snapshots per event.
- [ ] Extract `deriveEffectivePlanReviewState` with required `baseBudget` as above; it never dereferences `snapshot.derived`. At snapshot selection use the reconstructed review-boundary base; at later decision boundaries reuse that base plus new canonical governing state and existing accepted-risk filtering/routing. Keep `routeAfterDecision` as a compatibility wrapper: retain early abort/trade_scope/request_author_reestimate returns, retain the current null-derived TypeError for other choices, and otherwise pass the existing derived value as explicit base to the shared helper. Do not turn `trade_scope` into an immediate edited ledger; approved scope remains pending author revision.
- [ ] Compare reconstructed review-boundary aggregates with the paired recorded decoration **before** applying later decisions; preserve recorded provenance and report mismatch. Never substitute an unrelated cache or today's plan/config. Selected missing baseline/ledger/policy/paired semantics yields `BUDGET_INSPECTION_INCOMPLETE`. Tests use `derived: null` and assert all values equal recorded decoration including I, B, thresholds and semanticHumanRequired-driven requiresHuman; repeat with empty/wiped index, archive memory store, current config changes and a decision after the selected review. Cover b0 differing from captured b without altering governing-fold semantics.
- [ ] Derive read-only gate context from canonical accepted state and successor identities, never `showPlanReviewGate`, `repairReviewGatePrompts`, capture or composition. Guard actionability by enforced/latest/nonterminal state; historical/advisory/terminal gates are explanatory only. Reuse typed allowed-choice contracts if present; do not create an inspection decision API.
- [ ] Test equal/reversed timestamps, append stability, stale decisions, supersession before/after selection (including superseded superseders, scalar rollback and collection removal), budget increases, accepted risk, architecture approvals, abort and multi-cause successors. Preserve pre-refactor canonical expected-result fixtures and compare scan-wrapper/indexed acceptance and wrapper/incremental fold for every event prefix; include decision-stream order differing from human-step order and malformed boundaries. Long-history counters assert one budget decode/step-position scan and one acceptance classification per decision, no per-event prefix replay, and indexed affected-key updates. Account separately for ledger derivation and requested evidence output size; do not claim constant-time materialization. Test missing pairs/concurrent partial reads, corrupt decisions and JSONL diagnostics.

## Phase 3: Shared model, evidence, differences and paging (W3)

**Completion gate:** Both views have complete typed models, exact selection, full carried evidence and stable cross-page deltas; baseline-only/off/legacy/unknown states are honest.

**Files:** new `src/review-budget/inspection-types.ts` and `src/review-budget/inspection.ts`; reuse `types.ts:69–144`, `apply.ts` assessment behavior and `review-governance/apply.ts:37–66` finding register semantics.

- [ ] Finalize nested exported types and nullability: unknown scalar/evidence is null, unavailable collections have completeness diagnostics rather than implying known empty state. Preserve established aggregate symbols and thresholds; expose original baseline ledger/config/mode/confidence/capture time and governing decision lineage separately. Carry commit provenance from durable paired steps only.
- [ ] Implement latest/exact snapshot selection. Missing snapshot is `BUDGET_SNAPSHOT_NOT_FOUND`, never latest fallback. Baseline-only derives from original recorded ledger and explicitly has no reviewer estimate/review route; no baseline yields off/v1_compat/uninitialized based on supported run/config/history resolution, never inferred execution approval. Empty history is valid for an existing uninitialized run.
- [ ] Build the finding register from prefix snapshots/outcomes and paired verdict evidence. Preserve addressed titles when final items are empty, pending effort/architecture deltas, IDs/fingerprints and `Addresses` associations. Integrate accepted risks by exact canonical identity and retain decision provenance. Legacy missing evidence remains a row marked unavailable; ambiguous reuse is diagnosed, not merged by title.
- [ ] Include claims' author before/after/minimal alternative/coupling/target evidence, reviewer eligibility and available rationale from recorded verdicts. Keep assessment source event and evidence identity through carry-forward; changed claims require their own assessment. Show claimed/eligible reduction and aggregate allowed credit separately. Plan-209 credit is provisional only; do not call it realized because a run is completed.
- [ ] Build structured changes against the immediately preceding relevant event, including decisions, with its event identity even outside a page. Compare aggregates, W additions/removals/scores/associations, finding statuses and alert sets. Show's `changes_since_previous` uses the predecessor of its effective-through event; preserve a separate prior-review reference where a compact review-to-review explanation is useful. Neither projection delta nor closure claims measured engineering effort was reduced.
- [ ] Implement limit/cursor semantics and history summaries, including baseline capture and durable audit decisions. Return `has_more`/`next_before`; validate full integer strings, no coercion of fractions, infinity, zero, negatives or oversized limits. Preserve all supported JSON evidence regardless of verbose text flag.
- [ ] Unit fixtures cover W=28 with pending R 4→0 and projected 32→28, initial/empty closure, added/rescored items, original versus governing baseline, incomplete evidence, changed assessments, baseline-only/off/legacy, missing/foreign IDs, cross-page predecessors, later appends and long histories. Assert projections agree with canonical functions, not copied formulas.

## Phase 4: Dedicated terminal renderers (W4)

**Completion gate:** Text explains the ledger and decisions at narrow/normal widths, safely and without changing model contents or hiding rows.

**Files:** new `src/review-budget/inspection-text.ts`; use existing ANSI/width utilities where applicable, with local pure sanitization/wrapping helpers in this module rather than another general terminal framework.

- [ ] Implement pure string renderers with injected width and verbose option. Headers include run/plan/status, selected snapshot/review kind/step tuple, effective-through identity, pinned/unpinned mode and recorded/effective outcomes.
- [ ] Render descriptive effort/architecture labels, standard/effective/absolute ceilings, exceptions and credit explanations. Default show includes **all** work-item rows with stable IDs, signed deltas, Addresses, all finding dispositions/pending deltas, and compact claim summaries. Advisory/completed/aborted language cannot invite an inapplicable decision.
- [ ] Verbose expands work rationale, failure/lowest-cost correction, claim before/after/minimal alternative, available reviewer assessments and decision rationale. Explicitly mark unavailable historic evidence. JSON is always complete; compact evidence excerpts say that verbose/JSON contains the rest.
- [ ] Render chronological history table plus deterministic change summaries and event/snapshot IDs suitable for copy/paste. Identify the predecessor for first-page deltas and print the next older-page command. No cursor inference from timestamps.
- [ ] Escape/remove untrusted C0/C1/ANSI/OSC control sequences and terminal-affecting content, normalize line breaks, preserve safe Unicode and stable IDs. Wrap using display width; on very narrow terminals use labeled blocks rather than truncating IDs. No color dependency. Never silently omit rows; only explicit evidence excerpts are shortened.
- [ ] Pure unit tests assert returned strings, not captured console output: widths 20/40/80, long IDs/unbroken tokens, wide/combining Unicode, multiline evidence, ANSI/OSC injection, null fields, no-color output, terminal/advisory language and verbose expansion.

## Phase 5: CLI integration and plan-domain acceptance (W5)

**Completion gate:** Both commands, discovery hint and documented plan-domain semantics pass internal CLI acceptance and authoritative no-write tests with global output precedence unchanged. This is not a release/completion gate: required Phase 6 follows on the already-integrated 210 dependency.

**Files:** `src/commands/review.ts:59–75`; new `src/commands/review-budget.handler.ts`; `src/commands/run-v1.handler.ts:1359–1475`; `src/index.ts`; canonical documentation.

- [ ] Register `review budget show [--run] [--snapshot] [--verbose]` and `history [--run] [--limit] [--before]` under Commander. Adapters validate selection/paging and call injected core handlers; no arithmetic in commands. `outputSuccess(model, formatter)` respects JSON default/global flags/environment, including flag conflict and error behavior from the existing bin layer. History has no streaming exception.
- [ ] Add `Details: 5x review budget show --run <id> --text` to compact run-state text before the empty-steps early return where budget/governance context is shown. Do not add inspection data or alter existing run-state JSON or gate-show contracts.
- [ ] Export safe read/model/renderer types from `src/index.ts`, not mutation/context constructors. Document event IDs, nullability, effective-through selection, pagination, baseline-only/off/legacy states, corruption behavior and optional historical evidence; prepare combined-domain docs for the Phase 6 release gate, not an independent plan-only release.
- [ ] Unknown domain/version kinds return `BUDGET_INSPECTION_UNSUPPORTED` with remediation to use a compatible CLI; do not silently select an earlier plan snapshot or interpret missing execution baseline as v1. Valid integrated-210 records are required Phase 6 support, not permanent unsupported cases. True legacy plan-209 implementation phases follow 210's recorded compatibility disposition; their available plan budget can be inspected as **plan domain**, without invented implementation credit/readiness claims.
- [ ] CLI integration tests cover envelopes/exit codes, default JSON, text/env/explicit override, verbose JSON equality, exact snapshot errors, cursor pages, archived IDs/subprojects/config pinning, terminal runs and the state hint. Tests use deterministic record fixtures and no live provider.
- [ ] Repeat show/history against an enforced unresolved gate with notifications missing and against completed advisory runs. Compare every authoritative stream, run summary, config and prompt/decision row before/after, including error paths; verify no prompt repaired/created. Wiped-index output equals live output modulo explicitly labeled local source metadata.
- [ ] At implementation time run focused new and dependency regressions, configured quality gates and concurrent tests. Prepare `docs/v2/209-review-budget-inspection.md`, `docs/v1/101-cli-primitives.md`, README and CHANGELOG for both domains; do not mark delivery complete or release until Phase 6 passes. No tests or quality gates are run for this document-only revision.

## Phase 6: Consume implemented 210 without assuming its authority (W6)

**Completion gate:** All six required phases pass for one combined release: same-run and separate execution-run inspection preserves inherited binding, domain separation, canonical realization and typed decisions; plan-209 inspection remains compatible and no inspection code establishes or changes governance authority. 210 implementation/integration was verified before starting Phase 1, not deferred until this gate.

**Files:** new `src/review-budget/inspection-implementation.ts`; extend this plan's `inspection-types.ts`, `inspection-events.ts`, `inspection.ts`; export adapter through `src/index.ts`. These changes consume, not implement, 210's planned `review-governance/implementation-state.ts`, `credit-reconciliation.ts`, `implementation-boundary.ts` and domain-aware decision/store readers.

- [ ] Consume the actual 210 signatures and compatibility rules documented by pre-start verification; reconfirm no dependency drift since Phase 1. Do not add placeholder persistence, binding selection or realization algorithms. An unexpected integration regression requires repair/revised handoff, never a W6 skip, reduced-scope completion or independent plan-only release.
- [ ] Add explicit implementation-domain dispatch from durable binding/observation kinds. Select latest implementation observation by canonical paired-step order across phases, with exact observation UUID selection for `--snapshot`; historical plan snapshots remain explicitly plan domain. Phase/domain/binding are carried on every event and finding. Unknown versions fail selected state and mark history incomplete.
- [ ] Project embedded approved source baseline/ledger/policy/decisions from the immutable binding, even with source worktree/DB absent. In execution history represent inherited baseline as a `baseline` event with `capture_kind: inherited`, original source identity/time and execution binding acceptance boundary; do not claim a second capture. Binding amendments/supersession and authorization outcomes are decision events referencing 210's durable authority. Source plan-review events are linked provenance, not falsely appended execution reviews.
- [ ] Delegate as-of execution state to 210 readers using bounded observation/decision/proof prefixes; preserve source governing changes versus execution changes. Expose approved W associations, distinct implementation telemetry, authorized text lineage, review context/commit range and typed `nextAction` when available. Never run current Git diff, quality gates or drift verification to fabricate historical evidence.
- [ ] Present per-claim realization from canonical reconciliation, including pending future claims, missing due assessments, partial/not-realized, waiver versus observed result, stale assessments and eligible correction-proof carry-forward. Retain gross effort/P and source budget arithmetic; implementation variance does not enter R or create credit. A waiver is not physical realization and a quality success alone is not carry-forward proof.
- [ ] Use 210's domain/phase/binding-aware acceptance and boundary readers for current actionability. Imported accepted risks retain source decision identity. An amendment choice remains typed amendment/re-review work, not immediate execution permission. Never call bind/decide/corrections-finish/phase-complete/seal.
- [ ] Add fixtures/integration tests for same/separate-run binding, absent source tree, source advisory/enforced pinning, phase-qualified finding IDs, implementation defects with large telemetry and unchanged R, realized/partial/missing claims, waivers, stale assessments, exact eligible correction proof versus ordinary quality, amended/superseded binding and post-observation decisions. Rerun all plan-domain fixtures unchanged, authoritative no-write tests, configured quality gates and concurrent suites. Only after all six phases pass publish combined support and permit plan-214 completion.

## Files Touched

All paths relative to `5x-cli/`. Tests/docs are not counted as production files.

| Production file | Change / owner |
|---|---|
| `src/commands/review-budget-read-context.ts` (new) | Read-only input resolution and dependency injection; W1. |
| `src/records/run-reader.ts` (new) | Extract archived record loading; exact run lookup; W1. |
| `src/records/resolve.ts` | Reuse/extend archived identity location without unrelated stream loads; W1. |
| `src/commands/run-v1.handler.ts` | Preserve extracted archived reader caller; shared recorded-budget assembly for reconstruction; text-only discovery hint; W1/W2/W5. |
| `src/review-budget/apply.ts` | Shared pure recorded-budget reconstruction/input assembly used by recording, run state and inspection; W2. |
| `src/review-governance/decisions.ts` | Canonical acceptance index, incremental governing fold and compatibility wrappers; W2. |
| `src/review-governance/routing.ts` | Explicit-base canonical effective budget/route; preserve route wrapper including null-derived behavior; W2. |
| `src/review-budget/inspection-events.ts` (new) | Ordered read set, event IDs and prefix boundaries; W2/W6. |
| `src/review-budget/inspection-types.ts` (new) | Typed shared model and diagnostics; W3/W6. |
| `src/review-budget/inspection.ts` (new) | Selection, evidence, differences and history paging; W3/W6. |
| `src/review-budget/inspection-text.ts` (new) | Pure safe show/history renderers; W4. |
| `src/commands/review-budget.handler.ts` (new) | Handler cores, argument validation and output adaptation; W5. |
| `src/commands/review.ts` | Nested Commander commands; W5. |
| `src/index.ts` | Public read/model contracts; W5/W6. |
| `src/review-budget/inspection-implementation.ts` (new) | Required consumer-only execution state adapter to pre-integrated 210; W6. |

| Tests/documentation | Change |
|---|---|
| `test/unit/commands/review-budget-read-context.test.ts` (new) | Injected live/archive/config/no-write resolver tests; W1. |
| `test/unit/records/run-reader.test.ts` (new) | Pure/injected record decoding and exact-run selection; W1. |
| `test/unit/review-governance/routing.test.ts` | Extracted helper/wrapper parity; W2. |
| `test/unit/review-budget/apply.test.ts`; existing run-state budget tests in `test/unit/commands/` | Recorded/null-derived reconstruction parity, semantic human requirement, pinned inputs and unchanged callback behavior; W2. |
| `test/unit/review-governance/decisions.test.ts` | Indexed acceptance and incremental fold versus canonical fixtures/wrappers for every boundary, supersession and operation-count regression; W2. |
| `test/unit/review-budget/{inspection-events,inspection,inspection-text,inspection-implementation}.test.ts` (new) | Ordering/model/delta/page/render/domain contracts; W2/W3/W4/W6. |
| `test/unit/commands/review-budget-inspection.test.ts` (new) | Direct handler validation with injected readers; W5. |
| `test/integration/commands/review-budget-inspection.test.ts` (new) | CLI output, archives, cursors, no writes and error behavior; W1/W5. |
| `test/integration/commands/review-budget-inspection-implementation.test.ts` (new) | Required combined-domain acceptance and no writes on pre-integrated 210; W6. |
| `docs/v2/209-review-budget-inspection.md`, `docs/v1/101-cli-primitives.md`, `README.md`, `CHANGELOG.md` | Delivered capability/status and stable public contract; W5/W6. |

Existing budget arithmetic/store/codecs, decision CAS/writers, paired record writer, global output implementation, DB migrations and 210 authority modules are reuse/regression anchors, not cleanup targets. The explicitly listed apply/decisions/routing extractions share existing semantics; they do not authorize new policy or writes.

## Tests

| Tier | Scope | Required assertions |
|---|---|---|
| Unit | Input and event resolution | Pure/injected reads, exact tuples, diagnostic classification, equal timestamps, causal pairs, stable IDs and prefix supersession. |
| Unit | Canonical state/model | Explicit-base and null-derived parity with recorded decoration (including semanticHumanRequired), b0/b distinction, decision-aware aggregates, missing evidence, closure/credit identity, pinned inputs, historical routes and wrapper parity. |
| Unit | Paging/differences | Limits/cursor failures, cross-page predecessors, append stability, audit-only decisions, indexed acceptance once per decision, incremental supersession/component rollback and no repeated stream scans/prefix replay. |
| Unit | Renderers | Pure string outputs, narrow width, Unicode/control safety, no omitted rows, unavailable evidence, verbose expansion and advisory/terminal wording. |
| Integration | CLI contracts | JSON/text/environment precedence, error envelope/exit, ambient identity, exact archived run, mapped policy, hint and verbose-independent JSON. |
| Integration | Read-only and recovery | Byte-identical authoritative streams/config and unchanged prompt rows, missing-notification gate, index wipe parity, corruption and no captures on empty state. |
| Unit + integration, required | Execution compatibility | On pre-integrated 210: inheritance rather than recapture, separate domains, typed decisions, canonical realization/proof boundaries and no governance mutation. |

Follow `AGENTS.md`: unit tests call functions directly, no subprocess/network, console capture or process-wide environment mutation, and must be deterministic under `--concurrent`. Integration tests spawn the CLI with `Bun.spawn`/`Bun.spawnSync`; all git-capable spawns use `cleanGitEnv()`, use `stdin: "ignore"` unless intentionally piping, and explicit per-test timeouts (15s ordinary, 30s or justified longer for multi-spawn cases). Use deterministic timestamps/IDs and temporary records; no live provider. During implementation run focused suites at each gate, `bun test test/unit/`, `bun test test/integration/`, configured quality gates and `bun test --concurrent` before the single combined release after all six phases. This document-only revision runs only plan-parser validation, no product tests or quality gates.

## Not In Scope

- **Governance mutations or alternate authority:** binding, baseline capture, decision submission, gate creation/notification repair, realization verification and completion remain in 209/210.
- **A new budget engine:** inspection consumes recorded facts and shared pure folds; no independent thresholds, policy fallback for historical records, or credits from execution telemetry.
- **Live rescoring or historic evidence repair:** edited plans/current Git objects are not substitutes for recorded evidence.
- **New persistent index/schema or remote service:** use existing record/Git readers and permitted local projections; no summary stream or cursor table.
- **Global output normalization:** unrelated setup commands/flag migration belong to design 205; inspection uses existing standard output primitives.
- **Branch/worktree integration during planning:** only this plan is changed on main. Dependency integration is a later prerequisite.

## Estimated Timeline

| Phase | Deliverable | Time |
|---|---|---|
| 1 | Confirm passed pre-start 210/209 gate; read-only resolution | 2–3 days |
| 2 | Ordered events and canonical as-of state | 3 days |
| 3 | Model, evidence, differences and paging | 3 days |
| 4 | Safe terminal rendering | 2 days |
| 5 | CLI and internal plan-domain/no-write acceptance | 2–3 days |
| 6 | Required 210 consumer adapter and combined release acceptance | 2–3 days |

Execution order is completed/integrated **210 first, then all six phases of 214**. Pre-start technical verification reconciles actual integrated 210 interfaces before product work; waiting/integration is outside these windows. Each required phase includes its owning tests and has an independently verifiable gate, but Phase 5 cannot release/complete this plan and W6 cannot be skipped or deferred. If actual 210 contracts need new governance capabilities to support reads, block startup and revise the dependency handoff rather than expand inspection into a second authority.

## Provenance

Generated from design 209 (inspection, distinct from implementation plan 209) with complete review of approved plan 210 and read-only inspection of completed governance source/tests/docs at 38f348e. Those source references describe the inspected dependency, not a claim that 210 has shipped. Human scope decision `3fe3acb7-ec66-47e0-8e28-4420242c2ccb` retains W1–W6 and resolves review P1.1 by requiring completed/integrated 210 before any 214 implementation; all six phases then deliver plan and implementation inspection together. No product implementation, dependency modifications, tests, quality gates or orchestration loops were performed in this document-only revision.

## Revision History

### v1.1 (September 23, 2026) — Resolve review prerequisites and canonical reconstruction gaps

Addresses [the initial plan review](../reviews/5x-cli-docs-development-plans-214-review-budget-inspection-plan-review.md) and the retained-scope human decision above. This revision was submitted for closure review before the approval recorded below.

- **P1.1:** Retain every W ID, including W6. Front-load completed/integrated 210 plus actual-interface verification before any 214 product work; remove the split release, deferred/unchecked W6 and independent plan-only completion path. Summary, scope, prerequisite/checklist gates, phases, timeline and provenance consistently require all six phases.
- **P1.2:** Name the shared recorded-budget reconstruction/input assembly in `apply.ts`; recording, run-state reconstruction and inspection reuse it. Explicitly carry bounded first assessment, paired-verdict semantic human requirement, pinned config and boundary governing B. Effective routing accepts an explicit base rather than nullable projection state; preserve wrapper behavior and require null-derived/recorded-decoration parity tests.
- **P1.3:** Name canonical predecoded acceptance indexes and an incremental fold in `decisions.ts`, including supersession contribution removal and wrapper parity. Replace repeated prefix-fold instructions with one boundary pass; measure linear decodes/position scans and one classification per decision separately from indexed update/materialization costs.
- **Straightforward follow-ups:** Correct `loadGitRecordForPlan` extraction to line 1963; specify explicit archived-run access without a DB and ref candidates before slug discovery; distinguish B0, captured b and the governing fold's b0 seed without changing policy.
- **Budget/surface accounting:** Preserve individual W1–W6 effort/architecture scores with explicit rationale for the bounded refinements and incorporated Addresses; add apply.ts and decisions.ts to the production inventory and their tests to W2. No debt claims, new policy authority or dependency-plan changes. Actual integrated-interface verification remains a pre-start condition, not a claim that unimplemented 210 APIs have been verified today.
- **Validation:** Plan parser only; no source/test/config edits or test/quality execution in this revision.

### Approval (September 23, 2026)

Closure review returned `ready`, with P1.1–P1.3 addressed and no new blockers. Human architecture approval `15e2ce2c-2bec-4772-93c4-f5063236291d` resolved the remaining gate in planning run `run_ab5add0a5102`; the CLI returned `complete`. All W1–W6 remain required, with completed and integrated plan 210 a prerequisite before execution.

This planning run exposed an aggregate-only architecture-approval validation defect in dependency branch `5x/209-plan-review-governance-plan`. The separately committed fix is `6165dc141fb1d6c448ba7bdfc289debbcd818fa9`; approval was recorded successfully after the global CLI was updated to that commit. The inspected source references above remain anchored to 38f348e.
