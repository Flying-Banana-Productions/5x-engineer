# Implementation-Review Governance — Approved Scope, Diff-Causal Closure, and Realized Credit

**Version:** 1.0
**Created:** September 23, 2026
**Status:** Draft — dependency inspected; implementation requires integration of completed plan 209

---

## Executive Summary

Implementation review will inherit the approved plan ledger rather than establish another delivery budget. The CLI will select a context-specific finding contract, validate continued-review blockers against the exact reviewed code range, protect mechanical plan amendments, and allow a narrowly qualified final correction to finish only after a fresh full quality run. Promised architecture simplifications will be reconciled individually before phase advancement or implementation-run completion; credit shortfalls will change the inherited budget's derived state, not silently authorize new work.

This plan extends the actual plan-209 implementation inspected read-only at `afb132046701a9b3ba6e7190283c0516dbc4391d`. It preserves RecordStore authority, paired admission/finalization, insertion-order decision acceptance, run-pinned modes, and typed human gate actions. Main currently contains plan 208, not those implemented governance seams. The prerequisite gate below is mandatory; this planning change neither merges the dependency nor modifies its worktree. Dashboard delivery stays separate.

### Scope

**In scope:** four implementation finding classes; approved work-item linkage; exact fix-range evidence; durable implementation review context; text-only/design/budget plan-defect routing; quality-backed final corrections; provisional-credit reconciliation; inherited decisions; completion guards; and auditable telemetry.

**Out of scope:** another effort baseline/ceiling, new post-approval debt credit, automatic structural plan rewriting, unsolicited pre-existing repairs, global mode changes, dashboard UI/HTTP actions, and coordinated v2 output normalization.

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Extend shipped record/finalize and gate CAS seams | A parallel recorder or decision authority would lose plan-209 retry and stale-at-acceptance guarantees. |
| Pin an approved-plan reference, not a new baseline | Execution may occur in a different run from plan review; editable Markdown alone cannot supply approval. |
| Record exact reviewed endpoints before delegation | A review-artifact commit, new session, or later HEAD must not change the evidence domain. |
| Keep implementation telemetry out of plan finding arithmetic | Ordinary defects remain fixable irrespective of variance; negative telemetry cannot mint credit. |
| Separate author completion from phase approval | `phase finish` currently runs before review; debt reconciliation cannot be required at that earlier boundary. |
| Advisory diagnoses; enforced routes and blocks | Preserves plan 209's pinned-mode rollout without weakening structural enum separation. |

### References

Primary documents were read in the requested order: [slice 08 input](../../v2/plan-inputs/08-implementation-review-governance.plan-input.md), [206 governance](../../v2/206-review-budget-governance.md), [200 overview](../../v2/200-overview.md), [100 architecture](../../v1/100-architecture.md), and [101 primitives](../../v1/101-cli-primitives.md). Also inspected the [plan template](../../../../docs/_implementation_plan_template.md), `5x-cli/AGENTS.md`, the dependency's completed [plan 209](./209-plan-review-governance-plan.md), implemented source/tests, and its updated 206/101/202 canonical documentation.

## Table of Contents

1. [Overview and prerequisite](#overview)
2. [Design Decisions](#design-decisions)
3. [Delivery Budget](#delivery-budget)
4. [Architecture Overview](#architecture-overview)
5. [Implementation phases](#phase-0-prerequisite-integration-verification)
6. [Files Touched](#files-touched)
7. [Tests](#tests)
8. [Not In Scope](#not-in-scope)
9. [Estimated Timeline](#estimated-timeline)
10. [Provenance](#provenance)

## Overview

### Inspected main versus post-dependency state

Main was `43b08e3289baefb608d7a942d3b6220ca8a24092` during authoring. Dependency branch `5x/209-plan-review-governance-plan` was clean at `afb132046701a9b3ba6e7190283c0516dbc4391d` in `/Users/spalmer/dev/5x-engineer/.5x/worktrees/209-plan-review-governance-plan-68d554`. All source line references below are relative to `5x-cli/` **at that dependency commit**, unless explicitly labeled main. The completed checklist/source are authoritative evidence; plan 209's historical top-level "Approved" header is not a claim that implementation is absent.

| Surface | Main today | Inspected post-209 seam to extend |
|---|---|---|
| Governance application | Advisory plan budget from 208 | `src/commands/review-budget-context.ts:164–292`, `composePlanReviewerRecord`, combines budget, closure, pinned mode and decisions. |
| Record persistence | Paired budget writer | Same file `:338–466`, `recordPlanReviewerStepWithSnapshot`; `run-v1.handler.ts:2516,2701` admission/finalize with `paired-all-new`, `extraOps`, and `coupled-key-exists`. |
| Reviewer contract | Plan scoring fields | `src/protocol.ts:25–75,156–249` adds prior outcomes and hunk/decision evidence, but `scopeClass` is still plan-only. |
| Evidence | Bounded review delta | `src/review-governance/plan-diff.ts:129–197,225–273` builds full **plan-only** patches and accepts equivalent plan commits; this is not an exact code-range implementation context. |
| Decisions | Generic human records | `review-governance/decisions.ts:244–325` classifies acceptance by steps order; predicate explicitly requires `phase === "plan"`. `review-decision.handler.ts:501–701` writes a paired human step with hard-coded plan phase. |
| Gates and prompt protection | No enforced review gate | `review-governance/store.ts`, `commands/review.ts`, `showPlanReviewGate` (`review-decision.handler.ts:85`) and `submitPlanReviewDecision` (`:501`) ship typed read/action seams. Prompt notifications are not generic answer forms. |
| Budget/credit | Provisional only | `control-plane/review-budget-store.ts:31–107` stores baseline and plan snapshots; `review-budget/arithmetic.ts:150–241` derives provisional `N/D/E`. No realization input exists. |
| Rebuild | Budget projections | Migration v9 and `review-governance/sqlite-index.ts` extend rebuilding to decisions/gates; `records/index-rebuild.ts` already dispatches budget/decision projection. Do not reimplement it as steps-only. |
| Prompt context | Plan scoring context | `review-governance/context.ts:32–123` loads prior plan findings/decisions and shares render/invoke append behavior; `template-vars.ts:380–428` still resolves plan deltas from prior step HEAD. |
| Completion/quality | Existing v1 primitives | `phase.handler.ts:165–383` resumes successful quality by step key, treats skipped gates as success, and checks author checklist **before review**. `quality-v1.handler.ts:116–240` resolves full layered quality config. `run-v1.handler.ts:3148` seals completed runs. |

Inspected regression fixtures include `test/unit/commands/review-budget-context.test.ts:283–390` (no baseline on invalid initial evidence, persisted prior findings, shared composition), `test/unit/review-governance/store-index.test.ts:35–150` (snapshot/step identity and gate winners), and `test/integration/commands/plan-review-governance.test.ts:67–191` (closure lifecycle and pinned enforcement). Keep these tests passing rather than substituting proposed APIs from the older main-branch plan.

**New behavior:** both native and invoke implementation reviewers receive the same durable scope/range/decision context. Recorded results have a CLI-owned implementation-governance decoration. Only this decoration and durable quality/reconciliation state authorize enforced advancement. Standalone protocol emit/validate remains usable without a run but never claims contextual approval.

**Prerequisite:** integrate completed 209 before executing Phase 1; dashboard slice 04 or its governance follow-up is not a prerequisite.

## Design Decisions

**Keep contracts discriminated by trusted phase context.** The generic schema may describe the union for providers, but a contextual validator selects plan or implementation from a valid recorded plan phase/review context, never from an item enum or an agent's `reviewKind`. Reject mixed enums, unknown phase IDs, conflicting flags/envelopes, plan baseline/eligibility fields in implementation verdicts, and realization fields in plan verdicts. Retain v1 compatibility for runs that never activated governance; do not infer a new baseline from their expanded plans.

**Approval must survive a separate execution run.** Add an immutable execution binding to a source plan-review run/snapshot and approved plan commit. Same-run execution can bind automatically once the plan route is terminal; a different run uses explicit `review implementation bind --source-run`. Carry the source baseline identity, pinned mode/thresholds, approved ledger, effective decisions and evidence hashes into a self-contained record. This is inherited state, not baseline capture or a rescore. Resolve source records through RecordStore/progress resolution, not SQLite-only discovery. Refuse ambiguous source selection or an unapproved/drifted plan. Approval after a plan final-correction pass must include the recorded final author commit and the source's completed plan-review lifecycle, not merely its last `final_corrections` route.

**Do not loosen plan 209's hunk validator to implement code review.** Add a sibling code-diff context. It records exact full SHAs, per-file complete hunks, the canonical patch hash and excluded workflow artifacts before delegation. The reviewed end is the recorded author commit, not HEAD after a reviewer writes documentation. Continued start is the previous review context's reviewed end, not its review-artifact commit. Exclude only configured run-record paths, the exact plan, and registered review artifacts; documentation/config/tests elsewhere remain implementation changes. A hunk citation includes its `diff --git` file header and complete `@@` hunk to disambiguate identical hunks in different files. Preserve source whitespace; do not reuse the plan validator's trailing-whitespace stripping for whitespace-sensitive code.

**Classification follows the source of the correction.** A code symptom requiring changed approved behavior is `plan_defect`, even if also a bug. New APIs, schemas, dependencies, subsystems or structural plan changes are presumptive plan/scope decisions. Ordinary `implementation_defect` always links approved W IDs. Noncritical `pre_existing` findings belong in the review artifact's nonblocking section, not actionable `items[]`; critical pre-existing safety items remain visible and go to a human. Effort is nonnegative integer telemetry; architecture is signed integer telemetry, without plan-rubric magnitude restrictions or credit generation.

**Text-only is a restricted amendment, not a design exemption.** Snapshot the exact raw table byte span and approved structural signature before the author pass. Compare committed bytes afterward, including whitespace, line endings, row order, debt cells and `Addresses`. Separately compare phase identities/headings/checklist identities, debt evidence, acceptance/design sections and scope; only explicitly identified stale wording may change, plus normal checklist checkmarks. Byte equality alone cannot prove semantic equivalence: ambiguous wording or a reviewer verification requirement excludes the exemption and goes to a human. Deletion, duplicate budget sections, invalid UTF-8, structural drift or unavailable before bytes fail closed in enforced mode. No parsed-table round-trip may substitute for raw comparison.

**The implementation shortcut is not plan final-correction arithmetic.** Eligibility is exactly one mechanical P2 `implementation_defect`, `auto_fix`, zero architecture change, no boundary change, and no reviewer-verification/exception requirement. Empty items normalize to ordinary ready. Do not impose plan review's one-effort-point limit as a second implementation budget. The reviewer must explicitly describe boundary impact; unknown impact disqualifies. CLI completion rechecks available boundary signals and runs every configured gate at the corrected commit; skipped/empty gates cannot earn a no-review shortcut. Any failure, quality skip, code drift or boundary uncertainty permanently invalidates that attempt, even if a later retry passes. Normal quality retry then reviewer re-entry is mandatory.

**Realization affects only approved credit.** A per-claim assessment is bounded by the approved negative magnitude. Future claims remain provisional until due; completed claims use realized amounts. `realized` requires the full approved delta, `partial` a strictly smaller negative integer, `not_realized` zero; reject unknown, duplicate, positive, overclaimed or off-phase IDs. Additional simplification is telemetry only. Preserve gross effort and positive architecture burden; never add implementation effort variance to plan `R`. Human waiver changes the approved post-state/credit envelope, not historical evidence or observed realization.

**Extend mode behavior without changing defaults.** Baseline-pinned enforced runs enforce scope/convergence, gates and reconciliation. Advisory runs use the same observations and hypothetical routes but retain ordinary reviewer re-entry and do not gain the shortcut or new debt-based completion blocks. Off/v1-compatible paths retain existing behavior. Structural type/enum errors still reject supplied invalid contracts in every mode; missing semantic evidence becomes advisory diagnostics. New execution bindings inherit the source mode, including historical advisory decode. Credit promises are always displayed as unreconciled until assessed, even where advisory does not block.

**Human gate authority stays with records.** Extend the existing gate/decision machinery with review domain, phase and binding identity. Plan wrappers retain their exported names and semantics. Store implementation decisions in a distinct versioned payload kind so old plan folds cannot accidentally apply implementation findings. Shared record-key CAS, successor handling, intent comparison, prompt notification repair and steps-order acceptance remain the only mechanisms. A plan amendment approval pauses execution for author amendment and plan re-review; it is not permission to immediately implement new scope.

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Bind execution to approved plan provenance and inherited ledger | 5 | 2 | - | - | Adds a versioned durable approval reference and cross-run read boundary with compatibility tests. |
| W2 | Add phase-selected implementation protocol and pure classification rules | 3 | 1 | - | - | Threads a distinct public item/realization contract through schema, emitter and contextual validation. |
| W3 | Capture exact implementation review ranges and validate code hunks | 5 | 1 | - | - | Adds persisted review context plus git evidence boundary; includes rename, restart and drift tests. |
| W4 | Compose and atomically record implementation reviews and telemetry | 5 | 1 | - | - | Adds a versioned review observation using the existing finalizer, plus render/invoke/protocol parity. |
| W5 | Validate plan impacts and protect text-only amendment bytes | 5 | 1 | - | - | Adds durable amendment guards and verification against committed plan structure and bytes. |
| W6 | Complete eligible corrections through fresh full quality evidence | 5 | 1 | - | - | Adds a commit/config-bound correction attempt and quality result contract; failure/retry tests included. |
| W7 | Reconcile approved debt claims and derive realized budget state | 5 | 1 | - | - | Extends inherited budget derivation and durable claim observations without a new effort ledger. |
| W8 | Extend typed gates, decision folds and rebuild for implementation | 5 | 1 | - | - | Extends shipped CAS and projections across domain/phase, including stale decision and successor tests. |
| W9 | Enforce phase admission/completion and final-run guards | 3 | 0 | - | - | Threads one boundary predicate through existing primitive/composite paths and bypass regressions. |
| W10 | Update implementation prompts and all delegation-mode skills | 3 | 0 | - | - | Multi-path workflow contracts, actionable-only authors, context injection and rendered asset tests. |
| W11 | Publish run-state telemetry, integrated acceptance and canonical docs | 3 | 0 | - | - | Exposes existing derived state and exercises full lifecycles; no new UI or workflow authority. |

Tests are included in each scored implementation item. Phase 0 is prerequisite verification, not scored product work. No debt credit is claimed for adding these governance concepts.

### Surface Snapshot

- Subsystems: 6
- Production files: 41
- Persistent/external boundaries: 2
- New shared abstractions: 4
- New persistent schemas: 1

Subsystems are protocol, command/workflow integration, review governance, budget arithmetic, record/index storage, and bundled assets. The persistent/external boundaries are the existing RecordStore stream format extensions and the existing Git/quality subprocess evidence boundary (no new external service). Production-file inventory is enumerated below; schema count is one additive migration with several rebuildable projections. New abstractions are the approved execution binding, code-review context, implementation observation, and correction-attempt evidence. Counts are audit expectations, not scores.

## Architecture Overview

```text
approved plan review (209): baseline + snapshot + final author/decision history
                 |
       execution binding (same run or explicit source run; immutable lineage)
                 |
author commit -> captured code-review context -> reviewer verdict
                 |                              |
                 +-> phase-selected validation -+
                     closure / scope / claim observations
                                  |
                    shared prepare/finalize paired append
                                  |
                implementation observation + decorated reviewer step
                                  |
               complete | author_revision | final_corrections | human_gate
                       |              |                    |
           text-only guard check     fresh full quality    existing gate CAS
                       |              |                    |
                       +-------- phase boundary predicate -+
                                    |
                  phase:complete / next-phase admission / run complete

RecordStore steps/budget/decisions streams = durable facts
SQLite v10 projections = rebuildable view; no second budget or decision authority
```

New implementation records use discriminated `kind` values in existing streams; plan snapshot readers filter by kind. `recordPlanReviewerStepWithSnapshot` remains the sole plan snapshot writer. Implementation composition uses the **same** `prepareRecordStepAppend` / `finalizeAndWritePreparedStep` pair with implementation observation extra ops, not `applyPlanReviewBudget` with implementation findings. `snapshotId` remains an observation identity, not a fresh baseline. All persisted origins are constructed by `originFor`; no agent-authored attribution or totals are accepted.

### Proposed interfaces (new names, not claims about shipped APIs)

```typescript
type ReviewDomain = "plan" | "implementation";
type ImplementationScopeClass =
  | "implementation_defect" | "plan_defect" | "scope_expansion" | "pre_existing";

interface ApprovedPlanBinding {
  kind: "implementation-binding";
  id: string; // UUID; immutable revision, superseded only after human amendment flow
  sourceRunId: string;
  sourceSnapshotId: string;
  sourceBaselineId: string;
  approvedPlanCommit: string;
  approvedPlanHash: string;
  // Embedded source payloads/decisions and hashes make fresh-clone rebuild independent
  // of the original worktree or local SQLite. Baseline values are copied, not estimated.
}

interface ImplementationReviewContext {
  kind: "implementation-review-context";
  id: string;
  bindingId: string;
  phase: string; // exact parsed numeric ID
  previousReviewId?: string;
  baseCommit: string;
  reviewedCommit: string;
  patchHash: string;
  excludedPaths: string[];
  hunks: Array<{ oldPath: string; newPath: string; header: string; text: string; hash: string }>;
}

interface CreditRealization {
  creditClaimId: string;
  realization: "realized" | "partial" | "not_realized";
  realizedArchitectureDelta: number;
  evidence: string;
}

// Core functions receive resolved durable context, not caller-authored route fields.
function validateImplementationReview(input: ImplementationValidationInput): ImplementationValidationResult;
function deriveImplementationGovernance(input: ImplementationGovernanceInput): ImplementationGovernanceResult;
function reconcileApprovedCredits(input: CreditReconciliationInput): CreditReconciliationResult;
function evaluateImplementationBoundary(input: ImplementationBoundaryInput): ImplementationBoundaryResult;
```

Use `PlanReviewRoute`'s existing four route names for review results; post-decision output may additionally identify a required plan-amendment workflow. A discriminant and `nextAction` carry that distinction rather than interpreting prose. Shared fingerprinting accepts a domain-qualified scope union; plan fingerprints remain byte-stable, implementation identities also include phase/work-item linkage to prevent same-ID collisions across phases. Imported risk references retain source run/decision identities.

## Phase 0: Prerequisite integration verification

**Completion gate:** The implementation checkout contains completed plan 209 and its exact shipped contracts/tests, or a documented equivalent integration; no dependency worktree is modified by verification.

- [ ] Verify `git merge-base --is-ancestor afb132046701a9b3ba6e7190283c0516dbc4391d HEAD`. If integration used squash/cherry-pick, compare the concrete source/test/doc paths in Overview against that SHA and record equivalence before proceeding. Stop for missing functionality; do not implement against main's advisory-only state.
- [ ] Confirm v9 migration, `composePlanReviewerRecord`, paired snapshot writer/finalizer, `coupled-key-exists`, source mode pinning, gate actions, typed notifications, and steps-order acceptance are present. Reserve v10 only if still free; otherwise use the next migration number without renumbering shipped migrations.
- [ ] Run the focused plan-209 protocol/composition, gate-decision, plan-diff, record-rebuild and pinned-mode regressions from Overview in the implementation checkout. Record any integration drift in this plan; no speculative replacement APIs or dashboard prerequisites.

## Phase 1: Approved execution binding and compatibility (W1)

**Completion gate:** Execution can resolve the same approved ledger/decisions from the same run, a separate sealed source run, and a rebuilt clone; an edited/unapproved plan cannot silently establish an execution budget.

**Files:** new `src/review-governance/implementation-state.ts`; extend `review-budget/record-lines.ts`, `control-plane/review-budget-store.ts`, `commands/review.ts`, `commands/review-decision.handler.ts` and `records/index-rebuild.ts`.

- [ ] Add versioned binding encode/decode/read methods; persist copied source lineage, ledger, thresholds, effective human decisions, approved plan bytes/hash and phase map. Preserve B0 and source governing B; never call baseline capture to bind execution. Existing plan readers must ignore the new kind without treating it as a plan snapshot.
- [ ] Add `5x review implementation bind --run <execution> --source-run <plan-review>` using shared command context. Validate canonical plan identity, terminal approval/final-correction evidence, no open gate, and the approved commit. Same-run automatic binding uses the identical validator. Repeated identical binding is a no-op; conflicting binding needs explicit human-approved amendment provenance.
- [ ] Detect plan drift against approval while ignoring checkbox-state changes only. New work items/claims, changed scores, acceptance/design or phase structure require amendment. Map `phase-N` debt targets to numeric parsed IDs; accept exact numeric targets; reject unmatched/ambiguous arbitrary labels before activation instead of assuming numeric sort identifies the dependency.
- [ ] Keep off/v1-compatible runs unbound unless explicitly opted into an approved source through the existing human-owned approval workflow. Missing source in an otherwise enforced execution context returns an actionable `IMPLEMENTATION_APPROVAL_REQUIRED`, not automatic baseline inference. No new global configuration switch.
- [ ] Unit tests cover immutable lineage, final-correction approval, imported decisions, duplicate/conflicting bind, unknown phases and kind filtering. Integration tests cover separate plan/execution runs, source worktree removal, source record rebuild, and changed-plan refusal.

## Phase 2: Context-specific protocol and classification policy (W2)

**Completion gate:** Structural emit/validate and provider schemas preserve implementation fields; run-aware validation rejects mixed contracts and invalid work-item references without altering plan-review behavior.

**Files:** `src/protocol.ts:25–75,156–249`, `protocol-normalize.ts`, `commands/protocol{,-emit.handler,.handler}.ts`; new `review-governance/implementation.ts`; extend `review-governance/{types,fingerprint}.ts`.

- [ ] Add the implementation enum and required priority/deltas; conditional nonempty unique `planWorkItemIds` and `planImpact`. Validate IDs against the bound approved ledger; prohibit `planImpact` on other classes and prohibit implementation `creditClaim`, `creditAssessments` and `baselineAssessment`. Extend `--item` parsing and repeated `--credit-realization '<json>'` with nonempty evidence and strict shapes; keep aggregate-key rejection recursive.
- [ ] Require explicit `boundaryChanges` (array of API/schema/dependency/subsystem/architecture/plan-structure labels) and mechanical explanation for shortcut candidates; absent/unknown evidence means normal review, not a guessed empty array. Reuse `requiresReviewerVerification`, `failure`, `lowestCostCorrection`, `priorFindings`, `introducedBy`, critical and prior-decision fields already shipped by 209.
- [ ] Resolve domain from the admitted phase and persisted context/binding. Unknown numeric phase, missing context in enforced mode, phase flag/envelope conflict, and implementation scope in plan phase fail closed. Fresh sessions do not reset the phase's review round. Standalone validation only validates the structural union and rejects mixed enums; it cannot certify work-item linkage or code evidence.
- [ ] Implement source-of-correction precedence and pure classification diagnostics. Ordinary pre-existing observations are excluded from actionable structured items and retained in Markdown; critical pre-existing items require `lateDiscoveryEvidence` and always route human in enforced mode. Scope expansion is never automatically implemented even when `action` says auto-fix.
- [ ] Test each field's missing/invalid/duplicate case, arbitrary signed integer telemetry versus plan allowed magnitudes, cross-domain fields, unknown W IDs, plan-defect priority over bug symptom, critical safety, and legacy off/advisory/enforced compatibility.

## Phase 3: Exact code-review context and convergence evidence (W3)

**Completion gate:** The prompt and recorded verdict reference one durable, exact fix range; wrong-range, wrong-file or assembled hunk evidence cannot create an ordinary enforced blocker.

**Files:** new `src/review-governance/code-diff.ts`; extend `implementation-state.ts`, `commands/{template-vars,template.handler,invoke.handler}.ts`. Keep `plan-diff.ts:129–273` semantics unchanged.

- [ ] Capture a context UUID idempotently before native/invoke delegation, return it in render/invoke output, and accept `--review-context <id>` in recorded reviewer validation. Native skills pass it back; invoke retains it internally. Reject cross-run/phase reuse and conflicting context. Direct granular callers prepare through template render rather than manufacture endpoints.
- [ ] Initial base is the parent of the first admitted implementation author commit for the phase, not the parent of the latest fix; include all phase author commits up to the reviewed author commit. Resolve from record history and verify ancestry. Refuse ambiguous merge/root/missing-base histories with an explicit context error instead of silently reviewing a partial phase. Continued base is the previous observation's reviewedCommit, and end is the latest admitted correction commit.
- [ ] Build the complete deterministic diff with rename paths, fixed diff options, literal pathspecs and external diff/textconv disabled. Record endpoints/hash and hunk identities; verify object availability and recomputed patch at recording. A later review-document-only commit does not change endpoints. Rebase/missing objects or intervening code commits require a newly prepared context/review, not permissive equivalent-end matching.
- [ ] Render bounded diff text plus omitted file/hunk headers and an exact full-diff retrieval command. Require complete file-qualified hunks with changed lines; reject context-only, binary-only, combined-hunk, wrong-file, whitespace-modified and stale-range evidence. Binary changes can still produce initial findings or human safety escalation, not invented text evidence.
- [ ] Close prior findings with exactly one outcome each and remaining items for partial/open outcomes. New ordinary continued blockers require exact introducing code evidence and causal explanation; critical late issues bypass only the hunk requirement and route human. A deferred re-raise additionally needs matching decision identity and materially new evidence; it does not waive ordinary diff causality.
- [ ] Unit tests use injected git adapters/pure patches. Integration tests use temp repos for multiple author commits, review-only commits, renamed/deleted files, identical hunks in two paths, CRLF/whitespace-sensitive code, truncation, empty ranges, bad refs, dirty worktrees, fresh sessions and record/rebase drift.

## Phase 4: Paired implementation observations and telemetry (W4)

**Completion gate:** Native, invoke and direct validated recording yield the same observation/route; retries and index loss cannot double-count findings or create implementation budget baselines.

**Files:** new `src/commands/implementation-review-context.ts`; extend `review-governance/implementation-state.ts`, `commands/{protocol.handler,invoke.handler,run-v1.handler}.ts`, `review-budget/record-lines.ts`.

- [ ] Add `composeImplementationReviewerRecord` using bound scope, exact context, prior phase observations and decisions. Keep `composePlanReviewerRecord` and `recordPlanReviewerStepWithSnapshot` intact. Add an implementation writer around the existing admitted prepared step and paired finalizer; append a versioned `implementation-review` observation in the budget stream atomically with its reviewer step.
- [ ] Persist snapshot UUID, finalized step tuple, binding/context IDs, original verdict, outcomes, CLI route/diagnostics, per-claim observations and scoped gate causes. Plan-budget snapshots remain one-to-one with plan reviewer steps; implementation observations never become `FindingDelta[]` for `applyPlanReviewBudget`.
- [ ] Route valid ordinary defects to author revision regardless of effort; preserve material findings even if credit-derived inherited budget requires a separate human gate. Use existing four route values plus domain/phase and typed `nextAction`. Return no completion authorization until the durable write succeeds; on paired collision return the actual winner or corruption error, not a newly computed nonpersisted route.
- [ ] Derive review/fix cycles, review-originated commits, quality reruns, class counts and implementation-originated plan amendments from stable record identities. Record path additions exactly from git; APIs/schemas/dependencies/subsystems use per-item evidence inventories and mark unknowns explicitly (no language-wide semantic detector). Exclude workflow record artifacts from code-growth metrics.
- [ ] Test duplicate explicit iteration, auto-iteration races, coupled-key corruption, max-step admission, interrupted projection repair, origin redaction, no partial writes, fresh-clone state and protocol/invoke parity. Assert variance never changes W/R/B or mints D.

## Phase 5: Plan-defect routing and guarded text amendments (W5)

**Completion gate:** Only narrowly specified text synchronization can proceed without a plan decision; every budget-table byte change or structural/ambiguous amendment invalidates that exemption.

**Files:** new `src/review-governance/plan-amendment.ts`; extend `implementation.ts`, `implementation-state.ts`, `commands/implementation-review-context.ts` and author result admission in `commands/protocol.handler.ts` / `invoke.handler.ts`.

- [ ] Derive `text_only` as ordinary author correction with a durable guard attached to the originating observation. Save exact table bytes, plan commit, allowed text locations and structural signature **before** delegation. Reject duplicate/missing tables and ambiguous section bounds; do not use `originalSection` or parsed ledger equality as a byte-preservation proxy.
- [ ] On the author's recorded commit verify the guard against the committed plan blob and current mapped worktree; ensure no uncommitted plan changes are being used as evidence. Compare Buffer bytes including CRLF/trailing spaces; also validate unchanged phase/debt/design/acceptance structure. Allow only checkbox toggles and the authorized factual wording edits. Missing guard or mismatch emits typed amendment failure and blocks exemption consumption.
- [ ] Derive `design`/`budget` impacts (and uncertain text-only classification) as human gates with `nextAction: plan_amendment`. A changed table always requires budget impact review, even if parsed values are equal. Never automatically edit the ledger, add Addresses links for implementation telemetry, or silently downgrade a design defect to implementation work.
- [ ] After human authorization, a separate author-plan amendment/re-review workflow produces a new approved source snapshot and explicit superseding binding. Preserve old lineage; do not auto-update active approval from current Markdown. Existing credit IDs can be reduced/waived but no new post-approval claim/credit increase is accepted in this execution lineage. Additional scope requires the explicit approved amendment, not action prose.
- [ ] Test same-code-plus-text pass, one whitespace/table/Addresses/debt-cell change, removal/duplicate tables, changed phase heading/checklist identity, design edits outside table, invalid bytes, dirty plan, amendment restart, and attempted post-approval claim creation. Final correction shortcut remains ineligible for every plan defect.

## Phase 6: Quality-backed final implementation corrections (W6)

**Completion gate:** Only an eligible, unchanged-boundary correction with a fresh passing full suite reaches phase gate without reviewer re-entry; a failed attempt cannot regain the shortcut by retrying.

**Files:** new `src/review-governance/corrections.ts`; extend `commands/{review,review-decision.handler,quality-v1.handler,phase.handler}.ts`, `implementation-state.ts`.

- [ ] Add a pure eligibility predicate distinct from `routing.ts`'s plan final-correction validator. Require exactly one P2 implementation defect, mechanical evidence, zero architecture delta, explicit empty boundary changes, no exceptions or reviewer verification. Two P2s, a P1, human item, plan defect or unknown boundary impact returns ordinary author revision/human route as appropriate.
- [ ] Add `5x review corrections finish --run <id> --phase <p> --review <observation-id> --commit <sha>` and a handler core. It validates the recorded author result/commit and originating correction eligibility, then runs `runQualityCore` for the full layered configuration in the mapped execution directory. No selected-gate override or caller-authored passed flag is accepted.
- [ ] Bind an attempt to observation ID, author commit/tree, full quality command/config digest and execution directory. Require a clean code/config tree before and after checks. Resume only a CLI-generated successful attempt with that exact identity; pre-review `quality:check` and `phase finish` cached keys are not proof. Empty or skipped quality configuration invalidates the no-review shortcut and returns reviewer re-entry, while preserving legacy quality behavior outside this path.
- [ ] Persist failed as well as passed attempts and quality rerun telemetry. Any gate failure/timeout or skipped gate durably invalidates the shortcut for that observation; normal configured quality retries may continue but a later pass still routes to reviewer re-entry. Missing results or crash during execution reruns the full suite; it never guesses success. A code/config change creates new evidence and requires re-entry.
- [ ] Compare observed changed-path/boundary inventory with the eligible finding and approved scope. Detect obvious public/schema/manifest/plan changes; unresolved semantic boundary uncertainty forces re-review, not a claimed automated proof. CLI quality success is necessary but does not authorize undisclosed semantic correction.
- [ ] Test pass, stale pre-review quality, same-key/different-commit, failure-then-pass, timeout, empty/skip config, subproject layering, wrong workdir, dirty tree, restart at each substep and boundary drift. Assert ordinary `phase finish` behavior remains unchanged for pre-review author completion.

## Phase 7: Approved-credit reconciliation and inherited budget derivation (W7)

**Completion gate:** Every due approved claim has a bounded observation or explicit governing waiver; derived credit/alerts reflect realizations while implementation variance remains telemetry only.

**Files:** new `src/review-governance/credit-reconciliation.ts`; extend `review-budget/{arithmetic,types,record-lines}.ts`, `control-plane/review-budget-store.ts`, `implementation-state.ts` and implementation composition.

- [ ] Determine due claims from the binding's eligible intrinsic claims and normalized target phases, adjusted by active human debt decisions. Require all target-phase claims when a review proposes readiness or final corrections; missing observations on not-ready rounds remain visibly pending but cannot satisfy completion. Reject duplicate/unknown/future/wrong-phase claim IDs and stale binding evidence.
- [ ] Validate per-claim realization and concrete evidence referencing the implemented post-state/commit. Retain full claimed negative delta for realized; strict smaller negative magnitude for partial; zero for not realized. Never allow an implementation finding's negative architecture delta or an unknown claim to affect credit. Changed target-phase code after assessment invalidates its completion authority until reviewed again.
- [ ] Add an optional approved-claim contribution override to `deriveBudget` (or a shared lower-level contribution helper), supplied only by reconciliation, leaving the plan caller's provisional behavior unchanged. Use approved W/R and folded governing B/thresholds; future credit is provisional, due reconciled credit is realized, missing due credit is not spendable. Expose provisional/realized components alongside CLI-derived D/E without netting P or reducing gross effort.
- [ ] Emit `credit_unrealized` for a shortfall. It is informational unless the inherited forecast exceeds the recomputed effective/absolute limit or a claim's unrealized magnitude reaches `singleArchitectureReviewPoints`; those cases produce material gate causes with claim IDs and original/realized evidence. Correctness findings remain visible independently.
- [ ] Reconciliation records are immutable observations coupled to reviewer steps; later approved restoration can supersede an observation, never erase it. A waiver affects approved target/effective credit and human burden acceptance, not the historical measured post-state. Plan-only run completion has no implementation due-claim obligation.
- [ ] Test no claims, future-only claims, all realized, partial/not-realized, multiple contributions and caps/rounding, no credit creation, ordinary variance invariance, restored claims, accepted waiver, large shortfall within budget, small shortfall above E and drift after realization.

## Phase 8: Domain-aware human gates, decisions and projection rebuild (W8)

**Completion gate:** Implementation scope/plan/credit choices are durable, typed and race-safe; live handling and wiped-index rebuild produce the same governing state and successor gate.

**Files:** `review-governance/{types,decisions,store,codec,sqlite-index}.ts`, `commands/{review,review-decision.handler}.ts`, `control-plane/types.ts`, `db/schema.ts`, `records/index-rebuild.ts`.

- [ ] Extend derived gate identity with domain, phase, binding and implementation observation ID while leaving existing plan gate IDs unchanged. `review gate show --phase <p>` and `review decide` use the same exported read/action machinery; retain `showPlanReviewGate` / `submitPlanReviewDecision` compatibility wrappers. No new generic prompt-answer route.
- [ ] Add a versioned implementation decision payload kind. Reuse rationale/evidence/finding ID resolution, intent hashing, successor chain and RecordStore `decision:review-gate:<gateId>` CAS via paired human step. Generalize `classifyDecisionAcceptance` to domain/phase-scoped reviewer boundaries; same-phase review before the human step makes it stale, review afterward does not. Plan decisions preserve the existing plan-only predicate. New binding approval also invalidates old execution gate authority.
- [ ] Offer explicit scope/plan decisions: authorize amendment/re-review, defer exact finding with accepted risk, or abort. Debt shortfalls offer restore promised simplification, approve higher burden/budget, reduce remaining scope via amendment, or abort. Restoration authorizes only the original claim's scoped work and requires new review; it does not mark the claim realized. Budget/burden approval recomputes credit and remaining causes; it cannot conceal unresolved correctness or unreconciled claims.
- [ ] Store claim-specific approved post-state/delta reductions with source binding and supersession IDs. Validate choice-specific fields and reject unrelated scope, arbitrary claim IDs or broader credit. Scope/amendment choices pause with typed `nextAction`; approval/deferral reruns pure routing and creates at most one successor for uncovered causes. Abort calls existing terminal handling only after decision acceptance.
- [ ] Add additive migration v10 (next available after integration) for implementation binding/observation projections; extend existing gate/decision projection payloads. UUID/text identities, per-stream order, and standard redacted origins only. Existing PromptStore typed notification protection is reused; no new authoritative gate table. Extend `records index` dispatch for implementation kinds and preserve unknown-version diagnostics/fail-closed enforcement.
- [ ] Test same/different-intent two-process CAS, late reviewer acceptance order, cross-phase review isolation, superseding binding, imported risk identity, mixed plan/implementation decisions, malformed boundaries, equal timestamps, prompt closure failure/repair, multi-cause successors, abort parity, migration upgrade and full index wipe/rebuild parity.

## Phase 9: Phase admission and completion invariants (W9)

**Completion gate:** Enforced execution cannot bypass due reconciliation, unresolved gates or correction-quality requirements through manual checklist edits, generic record calls, alternate templates, composites or run sealing.

**Files:** new `src/review-governance/implementation-boundary.ts`; `commands/{run-v1.handler,template.handler,invoke.handler,phase.handler}.ts`.

- [ ] Implement one read-only `evaluateImplementationBoundary` over binding, parsed phases and durable observations/decisions/quality proofs. Completion requires current phase approved/reviewed (or valid corrected completion), all target claims reconciled, no active material gate and current committed scope. Missing/malformed evidence produces diagnostics and denies enforced completion.
- [ ] Call it before admitting `phase:complete` in the shared record preparation path and before any completed `runV1Complete` mutation/seal/pointer/lock release. Aborting remains allowed and records why work is unfinished. Duplicate already-admitted completion returns the original record; new work after reopen must pass current checks again.
- [ ] Call its prior-phase admission form from both template and invoke for next-phase author work and from record admission for manually recorded author steps. Existing parser has no dependency DAG; use ordered phases conservatively: any unreconciled claim due in an earlier phase blocks advancement. Do not invent a generic phase dependency framework. Same-phase repairs remain allowed.
- [ ] Do **not** impose reconciliation on first author `complete` or pre-review `phase finish`, which occur before the reviewer can assess claims. Add final-correction proof handling where the composite is explicitly used post-review; granular correction completion and composite paths consult the same evidence. `--no-phase-checklist-validate` cannot disable governance boundaries.
- [ ] Keep `plan phases` a checklist report; expose separate governance readiness in `run state` and teach skills that checked boxes alone are insufficient for enforced advancement. Plan-only runs may seal with provisional claims; the implementation binding marks which runs have execution obligations.
- [ ] Integration tests exercise raw `run record phase:complete`, manual checked boxes, next-phase native/invoke rendering, direct author recording, skipped checklist validation, run completion before/after realization, zero-claim runs, last-phase shortfall, abort/reopen, advisory diagnostics and unchanged v1 completion.

## Phase 10: Implementation prompts and workflow skills (W10)

**Completion gate:** All native/invoke author/reviewer combinations execute the same context, routing, amendment, quality and reconciliation rules; follow-ups never become automatic author work.

**Files:** `review-governance/context.ts`; `commands/{template.handler,template-vars,invoke.handler}.ts`; `templates/{reviewer-commit,reviewer-commit-continued,author-process-impl-review,author-next-phase}.md`; `skills/base/5x-phase-execution/SKILL.tmpl.md`.

- [ ] Append shared implementation context to both reviewer templates, even when using a fresh session: binding/source, approved W IDs and phase scope, full-diff retrieval, required prior outcomes, due claims, and active deferred/accepted-risk decisions with titles, rationale, decision ID and approved scope. Include human debt waivers/reductions so reviewers assess the effective approved post-state.
- [ ] Rewrite initial review as the exhaustive material pass and subsequent reviews as closure. Document four classes, source-of-correction precedence, exact new-blocker evidence, safety exception, work-item linkage, planImpact, no new credit and nonblocking Markdown follow-ups. Providers and protocol emit examples must match Phase 2's concrete fields/flags.
- [ ] Make implementation author prompts consume only admitted actionable findings and governing decisions, not "all actionable feedback" inferred from the entire Markdown. Allow guarded nonstructural text synchronization only with the supplied guard; prohibit structural amendments and scope expansion without an approved amendment workflow. Final correction prompt explicitly limits work to the eligible item and forbids opportunistic cleanup.
- [ ] Update execution skill to bind approved scope, retain review context ID, record/consume CLI route, call `review corrections finish`, return to quality retry then reviewer on invalidation, and resolve typed review gates through `review decide`. Do not treat generic `human:gate`/approve-override as an enforced bypass. Resume from durable route, not local counters or reviewer prose. Read retry limits/config, preserve freshness warnings and delegation-mode precedence.
- [ ] Test rendered skill branches for all four role-mode combinations, asset freshness/content loading, context byte parity, invocation/native continuation versus new sessions, imported risk/claim context and absence of plan score formulas in implementation instructions. Do not manually edit installed `.opencode` assets.

## Phase 11: Run-state presentation, acceptance audit and documentation (W11)

**Completion gate:** End-to-end fixtures prove scope-bounded review and debt-safe completion on the integrated dependency base; canonical docs describe shipped implementation behavior and separate follow-ups accurately.

**Files:** `commands/run-v1.handler.ts:1015–1468`, `src/index.ts`, canonical docs, README/CHANGELOG and slice-08 input.

- [ ] Add implementation governance domain/phase, binding/source, reviewed range, active gate, quality-attempt status, due/reconciled claims and telemetry to `run state` JSON/text. Display gross effort, inherited ceilings, provisional versus realized credit and positive burden separately; never describe waived/not-realized credit as physically realized. Preserve plan-only output and existing exported wrappers.
- [ ] Exercise full lifecycles: separate plan/execution runs; initial defects to diff-causal closure; text-only pass versus raw-byte violation; one P2 quality pass without reviewer; failed quality followed by successful retry **with** reviewer; partial debt shortfall and human successor decisions; last-phase sealing guard; fresh-process resume and wiped-index rebuild.
- [ ] Run focused new suites plus existing plan-209 governance, plan-208 budget, protocol, invoke, records, prompt protection and phase/quality regressions. Run full configured quality gates and `bun test --concurrent` in the implementation checkout. Unit tests must not spawn processes or mutate process-wide environment; integration git/CLI spawns use `cleanGitEnv()`, `stdin: "ignore"` unless intentionally piping, and explicit timeouts per AGENTS.md.
- [ ] Update `docs/v2/206-review-budget-governance.md`, `docs/v1/101-cli-primitives.md`, and `docs/v2/202-control-plane.md` with new CLI fields/actions, pinned-mode matrix, inheritance, text guard, quality fallback, realization and decision/rebuild semantics. Update README/CHANGELOG and input 08 metadata/checklists only after acceptance passes. Do not promote the global advisory default.
- [ ] Export handler-safe implementation read/action/core types through `src/index.ts`; retain SQLite constructors as internal. Link the existing `10-plan-review-governance-dashboard.plan-input.md` follow-up rather than implementing UI or HTTP. Leave coordinated output normalization to input 09 and separate implementation-budget calibration to later telemetry analysis.

## Files Touched

Paths below are relative to `5x-cli/`. This is the expected 41-production-file inventory; tests/docs are separately listed and included in their owning work item's effort. New files are explicit, existing paths were verified in the dependency tree.

| File(s) | Change / owner |
|---|---|
| `src/review-governance/implementation-state.ts` (new) | Binding, review context/observation and attempt record facade/codecs; W1/W3/W4/W6/W7. |
| `src/review-governance/implementation.ts` (new) | Contextual validation and implementation routing; W2/W4/W5. |
| `src/review-governance/code-diff.ts` (new) | Exact code patch/range/hunk evidence; W3. |
| `src/review-governance/plan-amendment.ts` (new) | Raw table and structural guard; W5. |
| `src/review-governance/corrections.ts` (new) | Shortcut eligibility/proof and invalidation; W6. |
| `src/review-governance/credit-reconciliation.ts` (new) | Approved per-claim contribution fold; W7. |
| `src/review-governance/implementation-boundary.ts` (new) | Single phase/run boundary predicate; W9. |
| `src/review-governance/{types,fingerprint,decisions,store,codec,sqlite-index,context}.ts` | Domain-aware identity, gates, immutable decisions, rebuild and prompt context; W2/W8/W10. |
| `src/review-budget/{types,arithmetic,record-lines}.ts` | Realized contribution input and discriminated record extensions; W1/W4/W7. |
| `src/control-plane/{review-budget-store,types}.ts` | Implementation record access and typed notification context; W1/W7/W8. |
| `src/protocol.ts`, `src/protocol-normalize.ts` | Schema/union, strict per-phase validation preservation; W2. |
| `src/commands/implementation-review-context.ts` (new) | Shared validated composition and paired observation writer; W4/W5. |
| `src/commands/{protocol,protocol-emit.handler,protocol.handler}.ts` | Context identity/realization flags, validation and result admission; W2/W4/W5. |
| `src/commands/{template-vars,template.handler,invoke.handler}.ts` | Durable context capture, propagation and admission; W3/W4/W9/W10. |
| `src/commands/{review,review-decision.handler}.ts` | Binding, domain-aware decisions and corrections-finish adapter/core; W1/W6/W8. |
| `src/commands/{run-v1.handler,quality-v1.handler,phase.handler}.ts` | Telemetry, full quality evidence, completion guards; W4/W6/W9/W11. |
| `src/db/schema.ts`, `src/records/index-rebuild.ts` | Next additive migration and implementation projection dispatch; W1/W8. |
| `src/index.ts` | Public handler-safe contracts/wrappers; W11. |
| `src/templates/{reviewer-commit,reviewer-commit-continued,author-process-impl-review,author-next-phase}.md` | Context-selected instructions and bounded authors; W10. |
| `src/skills/base/5x-phase-execution/SKILL.tmpl.md` | Derived route execution and durable resume; W10. |
| `test/unit/review-governance/{implementation-state,implementation,code-diff,plan-amendment,corrections,credit-reconciliation,implementation-boundary}.test.ts` (new) | Pure policy/record contracts, owning W1–W9. |
| `test/unit/commands/implementation-review-context.test.ts` (new); existing protocol/invoke/template/review-decision/phase/quality tests | Handler parity, admission and atomic persistence. |
| `test/unit/review-governance/{decisions,store-index}.test.ts`; `test/unit/records/index-rebuild.test.ts`; `test/unit/db/schema-v10.test.ts` (new, adjust number if needed) | Decision ordering, projection and migration parity. |
| `test/unit/review-budget/{arithmetic,record-lines}.test.ts`; `test/unit/control-plane/review-budget-store-contract.test.ts` | Provisional behavior preserved and no implementation variance/credit leakage. |
| `test/unit/skills/implementation-review-governance.test.ts` (new); `test/unit/templates/loader.test.ts` | Workflow asset contracts and rendering parity. |
| `test/integration/commands/implementation-review-governance.test.ts`, `implementation-completion.test.ts` (new); `test/integration/code-review-diff.test.ts` (new) | CLI lifecycles, git evidence, quality and bypass tests. |
| `docs/v2/{206-review-budget-governance,202-control-plane}.md`; `docs/v1/101-cli-primitives.md`; `docs/v2/plan-inputs/08-implementation-review-governance.plan-input.md`; `README.md`; `CHANGELOG.md` | Implemented status, contracts and deferred release/dashboard handoff. |

`review-budget-context.ts`, `plan-diff.ts`, plan routing, existing PromptStore rejection and RecordStore finalizer are reuse/regression anchors, not parallel implementations or scheduled cleanup targets.

## Tests

| Type | Scope | Validates |
|---|---|---|
| Unit/contract | Binding and record facade | Same/separate run inheritance, immutable source, compatibility, approval drift, no recapture, kind isolation. |
| Unit | Protocol + implementation policy | Four classes, enum separation, conditional fields, W IDs, human precedence, prior closure, critical exception and re-raise evidence. |
| Unit + integration | Code diff | Exact recorded endpoints, full file-qualified hunks, whitespace, rename/deletion, truncation, artifact-only commits, rebase and stale context. |
| Unit/handler | Paired observation recording | Native/invoke parity, retry winner, max steps, no orphan snapshot or inflated telemetry. |
| Unit + integration | Amendment guard | Raw Buffer identity including line endings, allowed wording versus structural change, non-table semantic drift, invalid exemption routes. |
| Unit + integration | Final corrections | One P2 eligibility, no boundary change, fresh full suite, empty/skipped configuration, failure latch, config/commit identity and mandatory re-entry. |
| Unit | Credit derivation | Per-claim realization bounds, future versus due claims, caps/rounding, material shortfalls, no new credit, invariant gross effort/P. |
| Contract + integration | Gates/decisions/rebuild | Domain-specific stale ordering, CAS winners, source/binding supersession, successor gates, typed prompt protection, origin privacy and rebuild equals live. |
| Integration | Completion guards | Raw record/complete calls, native/invoke next-phase admission, checked-box bypass, early author completion allowed, final phase debt block, abort and compatibility. |
| Unit/render + integrated | Assets and telemetry | All delegation modes, decision/claim context, no follow-up auto-fixes, CLI-derived routes and documented telemetry provenance. |

No subprocesses, console capture or global-env mutation in unit suites. Reuse dependency fixtures rather than copying a second gate/budget implementation into tests. Run focused tests at each phase gate; final acceptance includes full configured quality and concurrent suites. Future-version record payloads must be diagnosed and must not authorize enforced advancement.

## Not In Scope

- **Separate implementation budget or revised advisory default:** telemetry is gathered for later calibration only.
- **Post-approval debt-credit creation:** a new execution lineage/approved plan is needed for new claims; this slice only reconciles existing approved promises.
- **Automatic design amendments or scope expansion:** explicit human decision plus plan amendment/re-review is required.
- **Generic semantic API-diff engine:** boundary inventories and conservative re-entry are sufficient here; unknowns are not reported as measured zeros.
- **Debt cleanup beyond approved claims:** restore only promised simplification; tangential remediation stays follow-up.
- **Dashboard and remote decision transport:** preserve exported action seams and typed notifications; existing dashboard follow-up owns presentation/authentication.
- **Dependency merge, branch/worktree operations during plan authoring:** plan/review documentation on main is authorized; integration is a later prerequisite.
- **Output normalization/release:** this slice adds fields/commands in existing conventions; input 09 coordinates externally visible v2 normalization.

## Estimated Timeline

| Phase | Deliverable | Time |
|---|---|---|
| 0 | Verify integrated dependency and regressions | 1 day |
| 1 | Approved execution binding | 3 days |
| 2 | Contextual protocol/policy | 2 days |
| 3 | Exact code evidence | 3 days |
| 4 | Paired implementation observations | 3 days |
| 5 | Plan-impact guard | 2 days |
| 6 | Quality-backed corrections | 3 days |
| 7 | Credit realization | 3 days |
| 8 | Typed decisions and rebuild | 3 days |
| 9 | Completion/admission invariants | 2 days |
| 10 | Prompts and skills | 2 days |
| 11 | Run-state, acceptance and docs | 2 days |

Phases are dependency-ordered and individually testable. Intermediate phases expose tested cores but must not advertise enforced implementation governance until Phase 9's boundary wiring and Phase 10's workflow assets are present. If a phase cannot fit its bounded delivery window because the integrated dependency drifted, revise the affected work item explicitly rather than inventing a parallel governance stack.

## Provenance

This is slice `v2-implementation-review-governance`, generated from input 08 after main's plan-208 merge and read-only inspection of completed branch `5x/209-plan-review-governance-plan` at full SHA `afb132046701a9b3ba6e7190283c0516dbc4391d`. The dependency's updated canonical governance document explicitly leaves implementation classification, realized debt and post-correction quality to this slice; its source still hard-codes plan-only decision acceptance and provisional arithmetic. Those concrete remaining seams, not the older main-branch proposed plan, determine this implementation sequence. The separate dashboard input remains a consumer of the exported gate/read/action contracts, not part of this delivery.
