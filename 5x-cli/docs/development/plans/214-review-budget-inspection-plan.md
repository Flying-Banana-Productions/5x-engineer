# Review Budget Inspection — Recorded State, Evidence, and Decision History

**Version:** 1.0
**Created:** September 23, 2026
**Status:** Draft — pending review

## Executive Summary

Add `review budget show` and `review budget history` as read-only explanations of recorded budgets. A shared, typed model joins baseline/snapshot records with reviewer steps and accepted governance decisions, preserves exact as-of boundaries, and feeds both JSON and dedicated terminal renderers. Inspection never reads today's plan to score yesterday's work and never turns an advisory prediction into an actionable gate.

The immediate delivery target is the **completed plan-209 implementation at `38f348eb4657c1af1daa17f9fa564b0135bd6234`**, not main's older advisory surface. Approved plan 210 is a separate, **unimplemented** dependency for implementation-domain inspection. This plan defines a plan-209 release milestone and a later, explicitly gated 210 consumer adapter. Neither milestone implements binding, realization policy, decision acceptance, or execution approval on behalf of 210.

### Scope

**In scope:** latest/exact snapshot inspection; baseline-only and uninitialized states; decision-aware history; stable cursor pagination; structured differences; full JSON evidence; safe, width-aware concise/verbose text; archived-run lookup; a compact `run state --text` hint; compatibility with 210's inherited execution state once its implementation is available.

**Out of scope:** mutation commands, baseline capture, prompts/notification repair, new budget formulas, new persistent summaries, TUI/charts, live forecasts, arbitrary pairwise comparison, export formats, implementation governance itself, or a global output migration.

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Read authoritative streams through existing facades | SQLite projections can be absent or stale; snapshot `derived` is not a durable payload field. |
| Join on exact durable identities, order by paired steps | Timestamp ordering cannot implement decision acceptance or stable pagination. |
| Extend canonical pure effective-state helpers | Current route helpers compute budget internally; copying their filtering would create a second policy engine. |
| Separate historical state from current actionability | An explicit snapshot is evidence, not permission to answer an old gate. |
| Ship plan inspection independently of 210 | Plan-209 runs already have useful records; implementation state must come from 210, never guesses from an absent baseline. |

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
| `src/review-governance/decisions.ts:244–413,472–490` | Canonical acceptance uses reviewer/human **steps insertion order**, including intervening plan reviewers; fold handles supersession and audit-only decisions. List decoder provides diagnostics. As-of input slicing is new work. |
| `src/review-governance/routing.ts:308–321,343–409` | Pinned advisory route versus hypothetical enforced route; accepted-risk filtering and post-decision budget recomputation exist, but post-decision helper returns only a route. Expose its calculated state rather than clone its formulas. |
| `src/review-governance/apply.ts:37–66` | Persisted finding carry-forward is reusable but omits legacy findings lacking evidence. Inspection must retain visible partial rows with unavailable fields, not erase them or manufacture evidence. |
| `src/review-governance/store.ts:239–325` | Pure gate derivation exists, but gate-shaped causes alone do not check pinned mode/run terminal status. They are not sufficient actionability authority. |
| `src/commands/review-decision.handler.ts:85–139` | `showPlanReviewGate` repairs and creates prompt notifications. **Do not call it from inspection.** Its typed mutation interfaces remain unchanged. |
| `src/commands/review-budget-context.ts:120–140,181–207,223–350,397–525` | Latest plan-scoped configuration, durable reviewer identity, contextual assessment contract, and paired writer. Only reading/config patterns are reusable; composition/capture/finalization are forbidden inspection paths. |
| `src/commands/run-v1.handler.ts:1173–1272,1359–1475,2137–2350` | Compact budget/text; archived `--plan` path loads Git-backed streams through a memory store. Existing budget builder optionally parses current Markdown and has best-effort fallbacks; it is not an exact inspection model. Existing explicit `--run` does not supply the archived `--plan` fallback automatically. |
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

1. Before Phase 1 product work, the implementation checkout must contain completed 209 through 38f348e (ancestry or documented source/test equivalence). Integrating it is an external prerequisite, not work authorized by this plan-authoring task. Stop if the functional prerequisite is absent.
2. Verify global `--text`/`--json`, `FIVEX_OUTPUT_FORMAT`, custom `outputSuccess` rendering and error behavior in that integrated checkout. Existing normalization primitives suffice; design 205's setup-command migration is **not** a dependency. If those primitives were changed by coordinated normalization, consume its final contract before Phase 5; do not introduce private precedence or alter other commands.
3. Phases 1–5 deliver the complete first release for plan-209 runs. Off/v1 runs are explicit compatibility views, not opt-in opportunities. Unrecognized implementation record kinds cannot masquerade as uninitialized plan budgets.
4. Phase 6 requires **implemented and integrated 210**, including binding/state readers, realization derivation, domain-specific decisions and completion predicates, with its tests passing. The approved Markdown alone is not sufficient. Phase 6 is required before advertising implementation-run support or shipping inspection together with 210. If 210 is absent, release only the clearly documented plan milestone; leave Phase 6 unchecked. If 210 is already integrated, complete Phase 6 before the combined release.

## Design Decisions

**One immutable read set per request.** Resolve one run/source and freeze its baseline, budget, steps and decision streams in memory. Use a read-only interface and no prompt store/writer capability. Local index repair may remain available through existing infrastructure, but inspection must not create installation attribution, run records, steps, prompts, locks, configuration, or decisions. Detect missing causal pairs under concurrent reads and retry a bounded number of times; persistent inconsistency is a structured error/incomplete history, not a fabricated ordering.

**Stable identity/order with causal boundaries.** Public event IDs are versioned opaque encodings of run ID, event kind and the durable baseline/snapshot/decision ID (not offsets, line numbers, timestamps or SQLite IDs). `show --snapshot` takes the underlying snapshot UUID. Baseline precedes budgeted review events; reviews and decisions use the positions of their paired reviewer/human steps in the authoritative steps stream. Within an equal boundary use persisted stream order then durable ID; inconsistent duplicate pairs fail selected-state resolution. Fold only prefixes effective at the selected boundary, including supersession only when its human step is in that prefix. Stale/audit-only decisions remain visible with disposition and no effective-state delta. Missing-boundary decisions are diagnosed audit-only entries at a deterministic trailing position in incomplete history, never applied or shown as preceding their referenced review.

**Bounded page, run-scoped scan.** Decode the selected run's streams once, build identity maps, and fold chronologically once rather than repeatedly calling whole-store readers per event. Memory/time may scale with that run's history because the shipped facade lists streams; no claim of constant-time seeking. Retain full evidence only for selected show state or page events, plus register/state needed for comparison. History returns 20 events by default, accepts integer limits 1–100, orders each page oldest-to-newest and provides `next_before` equal to the oldest returned event ID only when older events exist. Exclude the cursor event; unknown/foreign-run/invalid cursors fail. New appends do not change prefix ordering or earlier deltas. An unrelated-run scan may discover **identities/paths** for an archived ID, but may not decode unrelated streams.

**Reuse canonical arithmetic and decisions, preserve provenance.** Introduce a pure canonical effective-state helper by extracting existing `filteredFindings`/post-decision calculation in routing; keep `routeAfterDecision` as its compatibility wrapper. Reuse `deriveBudget`, pinned thresholds, `foldGoverningReviewState`, and recorded closure outcomes. No revalidation of old Git hunks, rescoring of current plans, or recomputation of old verdicts from today's policy. Compare reconstructed budget with the reviewer step's recorded `budget` decoration when present; expose both source identities and a mismatch diagnostic. The recorded review route remains recorded even if a reconstructed projection disagrees. Missing authoritative inputs to a selected forecast are fatal; missing optional provenance/evidence is nullable and diagnosed.

**Snapshot state and current actionability are different.** Latest selection includes subsequent accepted decisions and shows `effective_through_event_id` separately from `snapshot_id`. Exact snapshot selection ends at its paired review step and never offers an actionable gate, even if that gate was open then. `governance` separates recorded review route, effective route, hypothetical enforced route and historical gate details. Only latest, enforced, nonterminal, canonically unresolved state may expose an actionable gate. Completed/aborted runs always explain terminal status; advisory alerts are labeled predictions that did not block completion. Neither `requiresHuman` nor `deriveOpenGate` alone grants actionability.

**Historical evidence is incomplete by design, not reconstructed.** Preserve work-item rationale and raw recorded associations; carry finding titles, fingerprints, failure/correction evidence, outcomes and decision references forward. An empty final `items[]` does not erase addressed findings. Use canonical finding identity/status where available; retain legacy rows with unknown fingerprint/status/evidence and diagnostics rather than synthesize a fingerprint. Disappearance alone is not proof of closure. Assessment carry-forward must match the recorded claim evidence; changed claims do not inherit stale eligibility. Allowed credit is the aggregate canonical value, not a fictional per-claim allocation of a global cap.

**Implementation is a distinct consumer domain.** For 210, select the binding and its inherited self-contained approved source state, not a newly captured execution baseline. Preserve original/source governing baseline, source run/snapshot/baseline IDs, pinned policy, approved W IDs and authorized amendment lineage. Plan findings and implementation telemetry are separate discriminated arrays/registers; phase-qualified implementation identity cannot collide with a plan finding ID. Never feed implementation deltas into plan `R`, create debt claims, or infer credit from negative telemetry. Realized/partial/not-realized, provisional/not-due, missing/unreconciled and waived states come only from 210's reconciliation and verified correction-proof readers. Typed decision `nextAction` and domain/phase/binding provenance pass through unchanged. Inspection cannot bind, authorize amendments, verify corrections or advance phases.

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Read-only live/archived input resolution and diagnostics | 3 | 1 | - | - | Crosses command context, record/progress and mapped config seams; adds one read-only resolver including archived ID lookup and side-effect tests. |
| W2 | Canonical as-of effective state, ordering and event identity | 5 | 1 | - | - | New cross-stream boundary abstraction with shared routing extraction; acceptance, supersession, corruption and concurrency tests included. |
| W3 | Inspection model, evidence register, differences and pagination | 5 | 2 | - | - | New exported view contract and historical projection spanning ledger/findings/claims; carries missing-data provenance and stable page semantics. |
| W4 | Dedicated safe terminal renderers | 3 | 1 | - | - | Show/history and verbose evidence presentation with Unicode width/control safety, tested as pure string functions. |
| W5 | CLI adapters, discovery and plan-domain release integration | 3 | 0 | - | - | Existing command/output/export/docs seams; subprocess acceptance and no-write regressions belong to this item. |
| W6 | Read-only adapter to implemented 210 domain contracts | 3 | 1 | - | - | Cross-domain consumer mapping and combined-release tests; depends on 210 supplying binding/realization/decision authority, not a new policy engine here. |

No negative architecture deltas or debt claims are proposed. Tests are part of their owning implementation work item; prerequisite verification and documentation are included in the corresponding phase, not separate scored items.

### Surface Snapshot

- Subsystems: 4
- Production files: 13
- Persistent/external boundaries: 2
- New shared abstractions: 2
- New persistent schemas: 0

Subsystems: command integration, record/progress resolution, governance projection, and inspection model/presentation. Boundaries: existing run record streams (read-only) and existing Git-backed archived reads. Abstractions: immutable ordered read set and shared inspection view model. Thirteen production files are enumerated below; no source changes to 210's binding/realization writers are counted or authorized.

## Architecture Overview

```text
Commander review budget show/history
  -> ambient/explicit identity + validated selectors
  -> read-only run resolver (live mapped records OR exact archived run)
  -> immutable run-scoped read set + diagnostics
  -> paired-step event order + as-of prefix
  -> canonical decision fold / budget derivation / effective governance
     (210 domain adapter consumes binding and reconciliation only when available)
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

## Phase 1: Verify dependencies and resolve read-only record inputs (W1)

**Completion gate:** One run is resolved from live mapped or archived storage without authoritative writes, regardless of caller directory; latest 209 and output prerequisites are documented as satisfied.

**Files:** new `src/commands/review-budget-read-context.ts`; extend `src/records/resolve.ts`; extract the existing `loadGitRecordForPlan` reading primitive from `src/commands/run-v1.handler.ts` into new `src/records/run-reader.ts` while preserving its existing caller. Reference archived logic at `run-v1.handler.ts:2137–2350` and mapped config at `review-budget-context.ts:120–140`.

- [ ] Verify 38f348e integration/equivalence and run dependency policy, continuation/recovery, decision/store and rebuild tests. Record concrete integrated line/API drift before continuing; no merge or dependency edits are implicit.
- [ ] Add injected read dependencies and immutable read-set types. Reuse ambient precedence (`FIVEX_RUN`, unique mapped worktree, pointer) in the adapter; explicit run wins. Preserve active mapped-worktree fail-closed errors instead of falling back to unrelated main records.
- [ ] Implement exact archived **run ID** resolution: use indexed plan/run locator when available, otherwise existing record tree/Git path discovery to locate matching run-summary identity under configured records paths, then decode only that run's streams. Reuse `resolvePlanProgress`/Git read primitives and existing source precedence; do not select the latest run for a plan when a different ID was requested. Conflicting same-ID sources follow existing divergence rules or fail explicitly, not silent preference. Do not fetch refs/network automatically.
- [ ] For archived records with no live run row, use the archived run's canonical plan identity and known plan directory; no requirement that today's plan exists. Resolve unpinned policy with mapped plan context only when no authoritative baseline/binding exists; label it unpinned. Missing original evidence does not trigger a plan read or capture.
- [ ] Capture decoder diagnostics through sinks. A corrupt baseline is not absence; distinguish `RUN_NOT_FOUND`, unsupported version, unreadable authoritative data and optional missing metadata. Do not swallow malformed selected state under current run-state's best-effort warning convention.
- [ ] Unit tests use injected stores/Git readers/config and assert capability boundaries; integration tests cover live/completed/aborted/archived, missing DB row, exact old run among several for one plan, unavailable mapped worktree, root/subproject CWD parity, changed config after pinning and empty streams. Snapshot hashes/content of authoritative files and prompt rows before/after repeated resolution.

## Phase 2: Ordered events and canonical as-of effective state (W2)

**Completion gate:** Historical decisions cannot leak backward; latest accepted decisions change effective state consistently with canonical routing, and inspection cannot create notifications.

**Files:** new `src/review-budget/inspection-events.ts`; extend `src/review-governance/routing.ts:343–409`. Reuse `decisions.ts:244–413`, `store.ts:273–325` and `arithmetic.ts` without changing decision writers or acceptance semantics.

- [ ] Build one run-scoped identity map from baseline/snapshot/decision records and exact paired steps. Handle `reviewer:plan`, recovered records, arbitrary legal reviewer step names and reused iteration values in different phases. Verify duplicate UUIDs/tuples and causal order; a review with no valid paired step cannot become a complete selected snapshot.
- [ ] Encode/decode opaque event IDs with run/kind/durable identity and a version. Keep snapshot UUID distinct from history event ID. Order valid entries by paired-step boundaries, not timestamps. Preserve baseline/snapshot stream causality and classify stale/superseded decisions with existing acceptance helpers over the appropriate prefix.
- [ ] Slice steps, budget and decisions at each requested boundary before the canonical fold. Later supersession must not remove an earlier decision in an earlier snapshot. Include audit-only decisions in history with explicit diagnostics; exclude them from `decisions` governing a show view.
- [ ] Extract a pure effective-state result from existing post-decision routing, e.g. `deriveEffectivePlanReviewState(input): { budget: DerivedBudgetResult; governance: PlanReviewGovernanceResult; route: ReviewDecisionRoute }`. `routeAfterDecision` continues returning the same route via this helper, including abort/scope/reestimate special cases. Test wrapper parity on every existing choice. Do not turn `trade_scope` into an immediate edited ledger; approved scope is a decision pending author revision.
- [ ] Reconstruct aggregates from pinned baseline, current **recorded** ledger, carried initial estimate, recorded assessments and canonical accepted-risk filtering. Compare with recorded reviewer decoration; report mismatch without rewriting records or labeling a recomputed route as recorded. Selected missing baseline/ledger/policy/causal boundary yields `BUDGET_INSPECTION_INCOMPLETE`.
- [ ] Derive read-only gate context from canonical accepted state and successor identities, never `showPlanReviewGate`, `repairReviewGatePrompts`, capture or composition. Guard actionability by enforced/latest/nonterminal state; historical/advisory/terminal gates are explanatory only. Reuse typed allowed-choice contracts if present; do not create an inspection decision API.
- [ ] Test equal/reversed timestamps, append stability, stale decisions, supersession before/after selection, budget increases, accepted risk, architecture approvals, abort and multi-cause successors. Test missing pairs/concurrent partial reads, corrupted decision payloads and JSONL diagnostics. Read/fold each stream once per request; add a long-history operation-count regression to prevent quadratic rescans.

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

## Phase 5: CLI integration and plan-domain release (W5)

**Completion gate:** Both commands, discovery hint and documented plan-domain semantics pass CLI acceptance and authoritative no-write tests with global output precedence unchanged.

**Files:** `src/commands/review.ts:59–75`; new `src/commands/review-budget.handler.ts`; `src/commands/run-v1.handler.ts:1359–1475`; `src/index.ts`; canonical documentation.

- [ ] Register `review budget show [--run] [--snapshot] [--verbose]` and `history [--run] [--limit] [--before]` under Commander. Adapters validate selection/paging and call injected core handlers; no arithmetic in commands. `outputSuccess(model, formatter)` respects JSON default/global flags/environment, including flag conflict and error behavior from the existing bin layer. History has no streaming exception.
- [ ] Add `Details: 5x review budget show --run <id> --text` to compact run-state text before the empty-steps early return where budget/governance context is shown. Do not add inspection data or alter existing run-state JSON or gate-show contracts.
- [ ] Export safe read/model/renderer types from `src/index.ts`, not mutation/context constructors. Document event IDs, nullability, effective-through selection, pagination, baseline-only/off/legacy states, corruption behavior, optional historical evidence, and first-release plan-only domain support.
- [ ] Unknown recognized future implementation kinds return `BUDGET_INSPECTION_UNSUPPORTED` with remediation to use a compatible CLI; do not silently select an earlier plan snapshot or interpret missing execution baseline as v1. True plan-209 implementation phases remain v1 because no 210 binding/observation exists; their plan budget can be inspected as **plan domain**, without implementation credit/readiness claims.
- [ ] CLI integration tests cover envelopes/exit codes, default JSON, text/env/explicit override, verbose JSON equality, exact snapshot errors, cursor pages, archived IDs/subprojects/config pinning, terminal runs and the state hint. Tests use deterministic record fixtures and no live provider.
- [ ] Repeat show/history against an enforced unresolved gate with notifications missing and against completed advisory runs. Compare every authoritative stream, run summary, config and prompt/decision row before/after, including error paths; verify no prompt repaired/created. Wiped-index output equals live output modulo explicitly labeled local source metadata.
- [ ] Run focused new and dependency regressions, configured quality gates and concurrent tests; update `docs/v2/209-review-budget-inspection.md`, `docs/v1/101-cli-primitives.md`, README and CHANGELOG only to the delivered plan milestone. Keep 210 support explicitly pending until Phase 6.

## Phase 6: Consume implemented 210 without assuming its authority (W6)

**Completion gate:** After 210 is implemented/integrated, same-run and separate execution-run inspection preserves inherited binding, domain separation, canonical realization and typed decisions; no inspection code establishes or changes governance authority.

**Files:** new `src/review-budget/inspection-implementation.ts`; extend this plan's `inspection-types.ts`, `inspection-events.ts`, `inspection.ts`; export adapter through `src/index.ts`. These changes consume, not implement, 210's planned `review-governance/implementation-state.ts`, `credit-reconciliation.ts`, `implementation-boundary.ts` and domain-aware decision/store readers.

- [ ] Verify 210's completed source/tests, reconcile its older afb1320 assumptions with 38f348e, and record actual imported signatures. Block this phase if only approved plan text exists. Do not add placeholder persistence, binding selection or realization algorithms to inspection to bypass this dependency.
- [ ] Add explicit implementation-domain dispatch from durable binding/observation kinds. Select latest implementation observation by canonical paired-step order across phases, with exact observation UUID selection for `--snapshot`; historical plan snapshots remain explicitly plan domain. Phase/domain/binding are carried on every event and finding. Unknown versions fail selected state and mark history incomplete.
- [ ] Project embedded approved source baseline/ledger/policy/decisions from the immutable binding, even with source worktree/DB absent. In execution history represent inherited baseline as a `baseline` event with `capture_kind: inherited`, original source identity/time and execution binding acceptance boundary; do not claim a second capture. Binding amendments/supersession and authorization outcomes are decision events referencing 210's durable authority. Source plan-review events are linked provenance, not falsely appended execution reviews.
- [ ] Delegate as-of execution state to 210 readers using bounded observation/decision/proof prefixes; preserve source governing changes versus execution changes. Expose approved W associations, distinct implementation telemetry, authorized text lineage, review context/commit range and typed `nextAction` when available. Never run current Git diff, quality gates or drift verification to fabricate historical evidence.
- [ ] Present per-claim realization from canonical reconciliation, including pending future claims, missing due assessments, partial/not-realized, waiver versus observed result, stale assessments and eligible correction-proof carry-forward. Retain gross effort/P and source budget arithmetic; implementation variance does not enter R or create credit. A waiver is not physical realization and a quality success alone is not carry-forward proof.
- [ ] Use 210's domain/phase/binding-aware acceptance and boundary readers for current actionability. Imported accepted risks retain source decision identity. An amendment choice remains typed amendment/re-review work, not immediate execution permission. Never call bind/decide/corrections-finish/phase-complete/seal.
- [ ] Add fixtures/integration tests for same/separate-run binding, absent source tree, source advisory/enforced pinning, phase-qualified finding IDs, implementation defects with large telemetry and unchanged R, realized/partial/missing claims, waivers, stale assessments, exact eligible correction proof versus ordinary quality, amended/superseded binding and post-observation decisions. Rerun all plan-domain fixtures unchanged and authoritative no-write tests. Only then publish combined implementation support in docs.

## Files Touched

All paths relative to `5x-cli/`. Tests/docs are not counted as production files.

| Production file | Change / owner |
|---|---|
| `src/commands/review-budget-read-context.ts` (new) | Read-only input resolution and dependency injection; W1. |
| `src/records/run-reader.ts` (new) | Extract archived record loading; exact run lookup; W1. |
| `src/records/resolve.ts` | Reuse/extend archived identity location without unrelated stream loads; W1. |
| `src/commands/run-v1.handler.ts` | Preserve extracted archived reader caller; text-only discovery hint; W1/W5. |
| `src/review-governance/routing.ts` | Expose canonical pure effective budget/route, retain route wrapper; W2. |
| `src/review-budget/inspection-events.ts` (new) | Ordered read set, event IDs and prefix boundaries; W2/W6. |
| `src/review-budget/inspection-types.ts` (new) | Typed shared model and diagnostics; W3/W6. |
| `src/review-budget/inspection.ts` (new) | Selection, evidence, differences and history paging; W3/W6. |
| `src/review-budget/inspection-text.ts` (new) | Pure safe show/history renderers; W4. |
| `src/commands/review-budget.handler.ts` (new) | Handler cores, argument validation and output adaptation; W5. |
| `src/commands/review.ts` | Nested Commander commands; W5. |
| `src/index.ts` | Public read/model contracts; W5/W6. |
| `src/review-budget/inspection-implementation.ts` (new, gated on 210) | Consumer-only execution state adapter; W6. |

| Tests/documentation | Change |
|---|---|
| `test/unit/commands/review-budget-read-context.test.ts` (new) | Injected live/archive/config/no-write resolver tests; W1. |
| `test/unit/records/run-reader.test.ts` (new) | Pure/injected record decoding and exact-run selection; W1. |
| `test/unit/review-governance/routing.test.ts` | Extracted helper/wrapper parity; W2. |
| `test/unit/review-budget/{inspection-events,inspection,inspection-text,inspection-implementation}.test.ts` (new) | Ordering/model/delta/page/render/domain contracts; W2/W3/W4/W6. |
| `test/unit/commands/review-budget-inspection.test.ts` (new) | Direct handler validation with injected readers; W5. |
| `test/integration/commands/review-budget-inspection.test.ts` (new) | CLI output, archives, cursors, no writes and error behavior; W1/W5. |
| `test/integration/commands/review-budget-inspection-implementation.test.ts` (new after 210) | Combined-domain acceptance and no writes; W6. |
| `docs/v2/209-review-budget-inspection.md`, `docs/v1/101-cli-primitives.md`, `README.md`, `CHANGELOG.md` | Delivered capability/status and stable public contract; W5/W6. |

Existing budget arithmetic/store/codecs, decision acceptance/CAS, paired record writer, global output implementation, DB migrations and 210 authority modules are reuse/regression anchors, not cleanup targets.

## Tests

| Tier | Scope | Required assertions |
|---|---|---|
| Unit | Input and event resolution | Pure/injected reads, exact tuples, diagnostic classification, equal timestamps, causal pairs, stable IDs and prefix supersession. |
| Unit | Canonical state/model | Decision-aware aggregates, original/governing baseline, missing optional evidence, closure carry-forward, credit identity, no current-plan/config contamination, historical routes preserved. |
| Unit | Paging/differences | Limits/cursor failures, cross-page predecessor identity, stable append pagination, audit-only decisions and linear-fold work bound. |
| Unit | Renderers | Pure string outputs, narrow width, Unicode/control safety, no omitted rows, unavailable evidence, verbose expansion and advisory/terminal wording. |
| Integration | CLI contracts | JSON/text/environment precedence, error envelope/exit, ambient identity, exact archived run, mapped policy, hint and verbose-independent JSON. |
| Integration | Read-only and recovery | Byte-identical authoritative streams/config and unchanged prompt rows, missing-notification gate, index wipe parity, corruption and no captures on empty state. |
| Unit + integration, after 210 | Execution compatibility | Inheritance rather than recapture, separate domains, typed decisions, canonical realization/proof boundaries and no governance mutation. |

Follow `AGENTS.md`: unit tests call functions directly, no subprocess/network, console capture or process-wide environment mutation, and must be deterministic under `--concurrent`. Integration tests spawn the CLI with `Bun.spawn`/`Bun.spawnSync`; all git-capable spawns use `cleanGitEnv()`, use `stdin: "ignore"` unless intentionally piping, and explicit per-test timeouts (15s ordinary, 30s or justified longer for multi-spawn cases). Use deterministic timestamps/IDs and temporary records; no live provider. Run focused suites at each completion gate, `bun test test/unit/`, `bun test test/integration/`, configured quality gates and `bun test --concurrent` before each advertised release milestone. Plan authoring itself runs only plan-parser validation, not product tests.

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
| 1 | Dependency verification and read-only resolution | 2–3 days |
| 2 | Ordered events and canonical as-of state | 3 days |
| 3 | Model, evidence, differences and paging | 3 days |
| 4 | Safe terminal rendering | 2 days |
| 5 | CLI, no-write acceptance and plan-domain release | 2–3 days |
| 6 | 210 consumer compatibility and combined acceptance | 2–3 days after 210 integration |

Each phase includes its owning tests and has an independently verifiable gate. Dependency waiting/integration is not implementation effort inside these windows. If actual 210 contracts need new governance capabilities to support reads, stop and revise the dependency handoff rather than expanding this consumer into a second authority.

## Provenance

Generated from design 209 (inspection, distinct from implementation plan 209) with complete review of approved plan 210 and read-only inspection of completed governance source/tests/docs at 38f348e. Main does not yet contain that completed dependency. The first milestone deliberately explains already-shipped plan records; the second consumes the separate approved implementation-governance work only after it ships. No product implementation, dependency modifications or orchestration loops were performed in authoring this plan.
