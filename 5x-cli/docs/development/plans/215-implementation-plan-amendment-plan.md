# Implementation Plan Amendments — Same-Run Approval Lineage and Revision-Aware Evidence

**Version:** 1.2
**Created:** October 8, 2026
**Status:** Approved — v1.2 closure review ready on October 18, 2026 (run `run_8e69ccbe08a9`)
**Execution order:** Execute this approved follow-up against merged plan 210 in a separate implementation branch.

## Executive Summary

Add a supported operation for registering a human-authorized, reviewer-approved semantic plan amendment during an existing implementation run. Preserve the original execution binding, budget baseline, run identity, and code history; append a revision that updates the approved plan and ledger and explicitly governs which earlier evidence remains applicable. Author admission, prompts, review validation, claim reconciliation, gates, and run state must consume the same effective revision.

This is a required follow-up to merged [plan 210](./210-implementation-review-governance-plan.md). Documentation revision/review may occur on main; product implementation belongs in a separate implementation branch.

### Scope

**In scope:** same-run amendment registration; explicit human/approval provenance; immutable revision lineage; unchanged baseline and pinned policy; affected-phase invalidation; reviewed evidence carry; amendment-resolved findings; revision-aware text amendments, gates, contexts and claim assessments; retirement of the frontier recovery mutation command with historical record support; upgrade discovery/validation/reporting; dry-run/receipt/state output; recovery and orchestration documentation.

**Out of scope:** arbitrary phase renumbering/reordering; automatic semantic impact detection; implicit rebinding; retrospective inference from freeform approval summaries; baseline resets; a new budget formula; importing approval from unrelated plans; application/provider operations; operational handoffs for existing project runs.

## Overview and Prerequisites

### Observed implementation gap

The original gap was inspected at `76938df0d5565ff4b02a72516ecbda3f8c68bf38`. Plan 210 subsequently merged through `f3a8d67` (PR #33), including repeated frontier recovery (`a15d7b9`). The integrated documentation-review base is `aeaabb1`; Phase 0 must reconcile any later integration changes. Current seams:

| Existing seam | Current behavior / required extension |
|---|---|
| `src/commands/review.ts`, `implementation-recovery.handler.ts` | Initial `bind` remains source-run based. Operator-driven `recover-plan` now admits a constrained semantic amendment; replace that mutation path with unified `amend`. |
| `src/review-governance/implementation-state.ts` | Existing binding admission rejects a different source with `IMPLEMENTATION_BINDING_CONFLICT`; unregistered semantic edits produce `IMPLEMENTATION_PLAN_DRIFT`. Remediation now points to narrow frontier recovery, which cannot handle general revision/carry/claim changes. |
| `src/control-plane/review-budget-store.ts` | `getImplementationBinding` reads one immutable binding. `listImplementationTextAmendments` also folds `implementation-plan-recovery` records into authorized byte lineage; no general effective revision abstraction exists. |
| `src/review-governance/plan-amendment.ts` | Guarded text-only amendments protect design, structure, budget and debt-claim bytes. They cannot authorize changed campaign routing or withdrawn credit. |
| `src/review-governance/store.ts` | `authorize_amendment` resolves its gate and pauses for amendment. The version-1 payload requires `rationale` and source-observation `findingRefs`, rejects `claimAdjustments`, and has no structured amendment scope. It does not register the reviewed result. |
| `src/review-governance/context.ts`, `implementation.ts`, `implementation-boundary.ts` | Findings and evidence are mostly qualified by binding and phase, not an effective plan revision. |
| `src/review-governance/implementation-state.ts` | Initial source selection requires a completed plan-review run with a finalized commit. A plan review recorded inside an active execution is not that source. |
| `src/review-governance/implementation-recovery.ts`, `context.ts`, `implementation-boundary.ts` | Repeated frontier recoveries preserve the ledger/baseline and findings, invalidate affected contexts/observations, and change routing/state. Historical committed receipts must remain readable without retaining a second amendment authority. |

Changing live configuration to advisory cannot repair lineage: existing bindings pin their mode, and plan-drift admission checks apply to advisory bindings too.

### Mandatory prerequisite

Before any product implementation, verify completed plan 210 is merged into the execution base, including its coupled closure-history, advisory budget, and review-only freshness fixes. Reconcile the actual integrated RecordStore, decision CAS, protocol and review-context interfaces with this design. Approval of plan 210's Markdown alone does not satisfy the prerequisite. Plans 212/214 are not implementation dependencies; their consumers must use the effective revision interface if integrated concurrently.

### Success contract

An active bound run can resume author work against a committed semantic amendment only after a durable registration connects the current revision, operator authorization, exact amended plan, and coupled reviewer approval. Every registered effect must lie in the intersection of the authorization's structured scope and the reviewer assessment. Registration does not approve implementation code or complete any affected phase. A restart or index rebuild yields the same effective ledger, pending findings, valid evidence, gate identities, and readiness.

## Design Decisions

### 1. Append revisions; preserve binding identity

Keep the original `implementation-binding` line immutable and its `id` stable. Introduce an initial revision identity derived from that binding and append `implementation-plan-amendment` records with explicit predecessor revision IDs. This avoids changing the identity captured by existing `implementation:pre-author` records while preventing old evidence from certifying new scope.

Provide a canonical effective-execution reader that returns original binding provenance, current revision, approved plan bytes/hash/commit, revised ledger/phase map/debt targets, pinned baseline/policy, and evidence dispositions. Historical readers can select a revision/prefix. Current readers must not independently search for the latest amendment or treat an amendment as a plan budget snapshot.

### 2. Explicit command and portable provenance

Proposed command, not a shipped API:

```bash
5x review implementation amend \
  --run <execution-run> \
  --human-step <recorded-human-step> \
  --approval-step <recorded-plan-review-step> \
  --from-phase <earliest-affected-phase> \
  --resolves <finding-id> \
  --dry-run
```

`--resolves` is optional and repeatable. A plain `--resolves <finding-id>` is source-only convenience: it selects that finding only on the authorization's source phase and source observation, using the fingerprint recorded there. It never searches other phases, so the same ID on another phase is not selected. A cross-phase or explicit reference uses `--resolves <phase>/<observation-id>/<finding-id>`. The CLI resolves that observation's recorded fingerprint; the operator does not type it. Both forms must name one `amendmentScope.resolutionRefs` entry and the same phase/observation/ID/fingerprint reference in the reviewer assessment. `--from-phase` is required and must equal the assessment's earliest affected phase. Removing `--dry-run` records registration. Accept numeric step IDs as local convenience and a portable run-qualified step-key selector for rebuild/no-index use; persist only authoritative journal identities, not SQLite IDs, line offsets or timestamps. Human and approval records must belong to the execution run in the first release.

For the first release, accept only an accepted, unsuperseded typed `authorize_amendment` decision plus its coupled human step. `--human-step` selects that coupled step, from which the exact decision is resolved. The decision remains bound to its `bindingId` and source `observationId` (and that observation's phase). A generic `human:gate`, including `continue` or `override`, does not qualify. Proactive amendments without an eligible typed authorization are unsupported in this release; do not manufacture an implementation finding to obtain one. Orchestration guidance must require the operator to record the structured scope below and must expose authorized scope, assessed scope, and their intersection in dry-run output.

Newly recorded `authorize_amendment` decisions carry an explicit `amendmentScope` object on the existing version-1 `implementation-review-governance` payload. When the object is present it is included in the decision intent hash. When it is absent, intent-hash canonicalization keeps today's field set, so committed historical hashes still verify; do not insert a null or empty placeholder. Any other decision choice that carries `amendmentScope` is rejected. `rationale` stays a required explanation and is never parsed for phases, claims, or findings. Gate-cause prose is not scope. `5x review decide` accepts the object only as structured input. The machine payload requires every `amendmentScope` key. `claimEdits` and `resolutionRefs` may be empty arrays; omitting either key, or omitting `reopenCompletedPhases`, fails recording. Do not default the boolean or either list from gate text. Flags map one-to-one onto those fields and are the only recording syntax:

- `--predecessor-revision <revision-id>`
- `--earliest-affected-phase <phase-id>`
- `--reopen-completed-phases true|false` (the token is required; a bare flag is not false)
- repeatable `--claim-edit <creditClaimId>:<effect>` (zero repetitions record `[]`)
- repeatable `--resolution-ref <phase>/<observation-id>/<finding-id>` (zero repetitions record `[]`)

Recording rejects an unknown phase, a predecessor that is not current, a resolution ref whose finding is not on that observation for this binding, a source-observation ref outside `findingRefs` or outside a `plan_amendment` cause, and a claim id that is not on the bound ledger. The CLI fills fingerprints from the cited observations' recorded finding identities. The operator does not type fingerprints.

`amendmentScope` contains only these fields:

- `predecessorRevisionId`: the one predecessor this authorization may advance, including the initial revision id when no amendment or legacy recovery exists yet. Recording and registration both require it to be the current predecessor. It is not retargeted when the chain advances.
- `earliestAffectedPhase`: an existing phase id. In plan phase order, not lexicographic order, the assessed boundary and `--from-phase` must be this phase or a later phase.
- `reopenCompletedPhases`: a required boolean. Completed phases at or after the assessed boundary may be invalidated only when this is true. The assessed boundary is already required to be `earliestAffectedPhase` or later, so this consent covers every completed phase the amendment reopens. True is explicit operator consent. Do not infer it because a phase is already complete.
- `claimEdits`: an exhaustive list of `{creditClaimId, effect}` where `effect` is `withdraw`, `reduce_magnitude`, or `edit_contract`. `withdraw` removes the claim's credit. `reduce_magnitude` keeps the claim and lowers its approved architecture delta. `edit_contract` changes the claim contract. A change that both edits the contract and reduces magnitude must list both effects. The entry names the effect and does not carry a new magnitude; the approved plan bytes are that magnitude and contract. An empty list authorizes no claim withdrawal, magnitude reduction, or contract edit. These entries are permissions. `claimAdjustments` stays empty on `authorize_amendment`; approved credit still changes only at registration under Decision 5. A permitted effect still rejects a larger magnitude, a new claim id, or a different effect.
- `resolutionRefs`: an exhaustive list of `{phase, observationId, findingId, fingerprint}`. Only these findings may be marked amendment-resolved. Entries for the source observation must also match the decision's `findingRefs` and a `plan_amendment` cause on that observation. Cross-phase entries cite the observation that contains the finding. `findingRefs` remain the non-empty source-observation eligibility set; they do not authorize resolution outside that observation. `resolutionRefs` may be empty when the amendment resolves nothing.

`--from-phase` may precede the authorizing decision's `phase` only when `earliestAffectedPhase` is that early or earlier in plan phase order. That earlier floor is typed operator consent. It is not implied by the source observation. Completed phases at or after the assessed boundary reopen only when `reopenCompletedPhases` is true. A false value rejects those invalidations even when the assessment names them. A narrower assessment that starts later remains valid.

Registration accepts an effect only when it is inside both this scope and the reviewer `amendmentAssessment`. The assessment may be narrower than the authorization and must not be broader. Do not clamp a broader assessment or command request down to the authorization. Registration fails, and a new structured authorization is required before a wider effect can register. Reject a different predecessor, a `--from-phase` that differs from the assessment, an assessed boundary earlier than `earliestAffectedPhase`, invalidation of a completed phase when `reopenCompletedPhases` is false, a claim effect absent from `claimEdits` or from the assessment, or a resolved finding absent from `resolutionRefs` or from the assessment. Fingerprints must still match the cited observations.

An authorization is single-use for its predecessor. The first successful registration consumes it. An identical retry of the same registration intent returns the recorded winner and does not consume it again. A changed intent, a later predecessor, or a second amendment cannot reuse it. Superseded authorizations are rejected.

Historical `implementation-plan-recovery` receipts, and the `authorize_amendment` decisions they cite, stay valid under the former contract: binding, phase, source observation, `findingRefs`, rationale, no claim adjustments, and one recovery per authorization. Those decisions omit `amendmentScope`. The legacy fold does not require the new fields and does not reinterpret rationale as scope. A historical decision without `amendmentScope` cannot authorize `amend`. Do not rewrite historical decisions or receipts.

Strict decode still accepts version-1 decisions that omit `amendmentScope`. A present `amendmentScope` must match this structure exactly. Every new `authorize_amendment` recording must include it. This extends the existing decision payload. It is not a new record kind or a SQLite migration. Older binaries that do not understand the field must not execute a new-format amendment; Decision 8's toolchain requirement covers that.

The approval may be a coupled plan review within the active execution run. That path validates its committed blob and snapshot directly; it does not relax the finalized-source requirements for initial `bind`.

### 3. Reviewed amendment assessment, not inferred carry

Extend the plan-review contract with an optional `amendmentAssessment`, required for semantic amendment registration. It identifies the predecessor revision, reviewed plan hash, earliest affected phase, preserved earlier phases with reasons, and amendment-resolved findings as phase/observation/ID/fingerprint references with reasons. The CLI supplies the trusted revision/hash/diff in the reviewer prompt and verifies returned references. Implementation verdicts cannot supply this plan-domain assessment.

The requested `--from-phase` and `--resolves` must match this assessment. Plain and phase-qualified `--resolves` forms are defined in Decision 2, and the assessment's amendment-resolved findings use that same phase/observation/ID/fingerprint shape. The command cannot enlarge carry or resolution beyond what was reviewed, and the assessment cannot exceed `amendmentScope`. A plain historical `ready` summary does not authorize carry or finding resolution. Obtain a new, explicitly scoped amendment assessment when missing; never rewrite the old approval. This first release need not retrofit the triggering Player Desk approval.

Before preserving an earlier phase, verify its phase section/checklist identities (ignoring checkbox state), linked work-item contracts and due claim contracts remain unchanged. Also require reviewer assessment of changes outside that section, such as shared design/acceptance obligations. Byte equality is necessary for local structure but insufficient to prove global semantic non-impact. When impact is uncertain, move the affected boundary earlier and require review; do not guess. If that earlier boundary would precede `earliestAffectedPhase`, or would invalidate a completed phase while `reopenCompletedPhases` is false, the assessment is broader than the authorization. Do not clamp it. Registration fails until a new structured authorization covers the wider effect. Every changed ledger item must have a reviewed phase impact disposition. Reject deletion, reuse, reordering or renumbering of phase IDs in this release; phases already admitted remain addressable.

### 4. Validate an exact approved revision

Registration requires an active run, a valid binding/revision chain, accepted human provenance, and a successful coupled plan reviewer/snapshot pair with normalized approval route `complete` and no unresolved approval gate. Bind approval to committed plan bytes at the recorded review boundary; verify canonical plan identity, ancestor reachability, parsed ledger equality, amendment assessment hash, and the current worktree plan against those bytes. A later review/run-artifact commit is acceptable only through existing excluded-path equivalence. Uncommitted plan differences and stale approval evidence reject registration.

Baseline/threshold/mode discrepancies in the execution run's separate plan-review snapshot cannot replace execution policy. Validate registration under the original pinned policy; in enforced mode unresolved new budget/semantic gates require existing typed decisions, while advisory diagnostics remain nonblocking. Proposed lineage must not imply that approval of a document certifies the changed implementation.

Amendment review must explicitly override the ordinary final-correction shortcut. That route is derived in `src/review-governance/routing.ts`; `run-v1.handler.ts` only reads the persisted route, so the override is implemented in `routing.ts`. A handler that only reads the persisted route cannot supply it. A `final_corrections` author pass that changes assessed bytes cannot register using the preceding assessment. Within the still-active execution run, record the corrected author commit, render a continued scoped amendment review against that exact hash and unchanged predecessor, and obtain a new coupled assessment/approval before registration. Do not seal the execution run as a plan-only review. Amendment-specific CLI routing and native/invoke guidance must require this reassessment rather than telling the orchestrator to stop after final corrections; initial plan-review behavior remains unchanged. Cover correction → reassessment → registration in acceptance tests.

### 5. Budget continuity and claim identity

Preserve original source/baseline provenance, `B0`, governing `B`, pinned mode and thresholds. Recompute the effective ledger's budget using canonical arithmetic. The amendment review's independent estimate is evidence, not a replacement baseline. Any baseline change must occur through an explicit existing budget decision and be independently referenced, not through this command's flags.

The first release allows withdrawing approved claims, reducing their magnitude, or editing their contract with fresh eligibility/evidence review. Each of those effects is permitted only when `amendmentScope.claimEdits` and the reviewer assessment both enumerate that claim and effect. Rationale text cannot add one. Withdrawn IDs remain reserved in lineage and contribute no current provisional/realized credit. Existing claim assessments carry only for exactly unchanged contracts and fresh applicable code evidence. Changed claims invalidate realization/correction carry. Reject new negative-architecture claim IDs, increased approved credit magnitudes, and ID reuse; do not mint additional post-approval credit through an amendment. Positive burden and effort changes remain visible under the inherited budget.

For the triggering scenario, DC1 is withdrawn without credit; DC0 remains only to the extent its contract/evidence remains unchanged. No aggregate negative telemetry can substitute for a claim assessment.

### 6. Preserve work; requalify authority

Retain run ID, worktree mapping, code commits, exact pre-author baselines, review-cycle history and audit records. Existing evidence lacking a revision field belongs to the initial revision only when no legacy recovery boundary intervenes; for recovered runs use the deterministic attribution rules in Decision 9. Never relabel evidence as the latest revision merely because it lacks a field.

For phases at or after the affected boundary, old completion reviews, correction shortcuts, contexts and claim reconciliations cannot authorize completion under the new revision. Earlier approvals carry only through the explicit validated assessment. Carry records reference source evidence; they do not rewrite it or fabricate new reviews. Every affected phase requires ordinary quality and reviewer re-entry before completion, including phases that previously had `phase:complete` records. Admission/progress and final sealing must honor the new evidence disposition, not checked boxes or old progress shortcuts.

Unresolved implementation findings carry into the new revision, with their original phase, observation, identity and evidence. Amendment-resolved findings are classified as resolved by approved scope change, not fixed in code. `--resolves R7` must not erase R1-R6/R8 or require their reintroduction as new findings. Closure validation and author/reviewer prompts consume one canonical effective finding register; its lineage is distinct from the latest current-revision observation. Preserve reviewer-round counts across amendments.

Keep the original code review baseline/endpoints available for continued diff selection. Generate a fresh revision-qualified context after registration even when code endpoints are unchanged; never reuse a context merely because its patch hash matches. A review spanning several author commits remains anchored to the captured history. Revise decision/gate fingerprints to include revision, and invalidate superseded revision gate authority without reviving old prompts. Existing accepted-risk/waiver decisions carry only for unchanged referenced contracts, with explicit disposition. Text-only guards must name a revision; completed historical text amendments remain audit evidence, while unconsumed old guards cannot mutate the new anchor.

### 7. Atomic registration and concurrent revalidation

Pair `implementation:amendment` and its budget record using the existing admission/finalization and RecordStore atomic append seams. A registration has a deterministic intent digest covering the authorization identity, predecessor, evidence references, approved hash, affected boundary and reviewed dispositions. Identical retry returns the recorded winner; a changed intent, including a different authorization, competing for the same predecessor returns a conflict. Do not publish success or a new revision before durable append/readback.

Revalidate the predecessor, referenced reviewer/human ordering and plan/head evidence at finalization using the project's existing per-run mutation serialization. A per-predecessor idempotency key alone prevents competing amendment winners but does not prevent concurrent reviewer/decision appends from making approval stale. Phase 0 must verify the existing lock/CAS boundary supports this full check-and-append; extend that same boundary if needed, not a private lock system. Dry-run performs validation and derived reporting only, without steps, budget, prompt or attribution writes; local existing index hydration is not amendment registration.

### 8. Read/state compatibility and operator output

Show original binding/source provenance separately from effective revision/plan approval provenance. Registration/dry-run output includes budget/claim differences, affected phases, preserved evidence, invalidated authority, retained pending findings, amendment-resolved findings, and the required next action. It must never return implementation `completionAuthorized: true` merely because registration succeeded.

All current admission, template render, invoke, protocol validation, correction finish, decision acceptance, phase/run completion and active/archived state use the effective revision helpers. Fix raw binding scans in gate fingerprinting and closure readers; changing only `getImplementationBinding` would leave inconsistent authority. `src/review-governance/sqlite-index.ts` has its own implementation gate-chain derivation: it calls `deriveGateId` with binding and observation inputs, builds `advisoryBindings` from a raw `implementation-binding` scan, and projects `implementation_observation_index`. Revision-qualified gate and decision fingerprints must be derived there with the same inputs as `store.ts`. A rebuild that projects different gate IDs fails the success contract. Decision listing stays on the shared decision codec so a scope-bearing `authorize_amendment` is not diagnosed as malformed by a second parser. Rebuilds decode the new amendment kind without projecting it as a plan baseline/snapshot. No SQLite schema migration is expected, including for `amendmentScope` inside the existing decision JSON payload; verify this assumption against integrated 210. `sqlite-index.ts` continues to reject `version !== 1` on implementation binding and review records. Phase 0 confirms that version-1 decisions both with and without `amendmentScope` still decode. Document the minimum toolchain requirement for amended runs. The new reader rejects unsupported revision versions; do not claim an already-released older CLI can be retrofitted by a new record. Older binaries may continue reporting drift or ignore unfamiliar records and must not be used to execute amended runs.

### 9. Retire recovery mutation; preserve historical recovery authority

Remove `review implementation recover-plan` and its independent registration handler once `amend` supports its scenarios. Retain strict decoding of committed `implementation-plan-recovery` receipts, including the original single-recovery key and later authorization-scoped keys. The canonical effective fold interprets each receipt as a deterministic `legacy_frontier_recovery` revision, using the durable receipt identity and parent/hash/commit chain. Preserve its original authorization, operator attestations, immutable ledger/baseline/policy, invalidated contexts/observations, pending findings and code-review history. Historical recovery acceptance is grandfathered under its original contract; it is not a new amendment approval and has no synthetic `amendmentAssessment`. The cited `authorize_amendment` decisions remain valid without `amendmentScope` and cannot be reused as new-format amendment authorizations.

Consolidate recovery-specific admission, context, routing and boundary branches into this fold. Attribute revision-less historical evidence using authoritative journal ordering, causal references and recorded invalidation sets at each recovery boundary. Compare the resulting evidence applicability with the former recovery behavior, including carried earlier phases and reviews recorded between repeated recoveries. Do not compare timestamps or invent a total order across independent streams. Phase 0 must establish the exact causal attribution algorithm from existing record identities; if those records cannot unambiguously establish authority, fail closed for the affected run with a diagnostic identifying the evidence and required explicit repair/review. Do not silently assign everything to the initial or latest revision.

The final legacy recovery is a valid predecessor for a new-format amendment. All newly registered semantic amendments require the new authorization/assessment contract; legacy attestations cannot authorize additional changes. Guarded text amendments may precede, follow or occur between legacy recoveries and semantic revisions, with their original anchor checks preserved.

`5x upgrade` discovers affected runs from authoritative configured record roots, including completed/archived runs without requiring source worktrees or an existing index. Report recovery identities, lineage validity, compatibility/readiness to resume, actionable malformed/ambiguous-history diagnostics, and minimum CLI/workflow-asset requirements. Readiness here is compatibility to resume, never implementation completion approval. Discovery does not resume runs, rewrite/replace committed journal lines, append synthetic approvals, or auto-commit project history. No durable bridge/import record is planned: historical decoding supplies the transition. If implementation demonstrates a bridge is necessary, revise this plan and its schema/surface estimates first; any future bridge must reference original receipts idempotently and preserve only their historical authority.

Reuse the existing recovery validation and regression scenarios under unified amendment registration; remove recovery-specific output/guidance in favor of effective revision history with explicit legacy provenance. Do not operate on a real project's run as a migration test.

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Versioned amendment records and canonical effective revision fold | 8 | 2 | - | P1.1 | Adds durable lineage and an execution-state abstraction over existing RecordStore streams, including historical recovery attribution and rebuild/compatibility tests. The fold keeps former-contract recovery decisions readable when they omit `amendmentScope`. Effort and architecture delta are unchanged; that compatibility rule is part of the existing fold. |
| W2 | Exact approval provenance and atomic registration command | 5 | 1 | - | P1.1 | Extends paired mutation/CAS across human, reviewer, Git and revision evidence, and validates registration against the structured `amendmentScope` intersection. Includes dry-run, identical-retry, reuse-rejection and out-of-scope tests. Effort and architecture delta are unchanged; the scope object refines the authorization contract already charged here. |
| W3 | Reviewed impact assessment and effective finding continuity | 5 | 1 | - | P1.1, P2.1 | Adds a plan-domain protocol contract, phase-qualified resolution refs, and the `routing.ts` override that withholds the final-correction shortcut from a changed amendment assessment. Effort and architecture delta are unchanged; `routing.ts` is the concrete home for routing this item already required. |
| W4 | Revision-aware admission, contexts, gates and completion | 5 | 1 | - | P2.1 | Threads one effective state through execution boundaries without replacing history or resetting pre-author ranges, and projects the same revision-qualified gate identities from `sqlite-index.ts`. Effort and architecture delta are unchanged; the index module is the missing projection of gate work already charged here. |
| W5 | Claim withdrawal and conservative evidence carry | 3 | 0 | - | P1.1 | Extends existing reconciliation so a claim withdrawal, magnitude reduction, or contract edit is applied only when both `amendmentScope.claimEdits` and the assessment enumerate it. Effort and architecture delta are unchanged; no new scoring model or authority is added. |
| W6 | State, upgrade transition, orchestration guidance and integrated acceptance | 5 | 0 | - | P1.1 | Publishes effective/history provenance, authoritative legacy discovery, command retirement and the complete workflow in all delegation variants, with installed-asset and end-to-end transition tests. Skills tell the operator to record structured `amendmentScope` and not to treat rationale as scope. Effort and architecture delta are unchanged; that guidance is part of the workflow publication already charged here. |

Tests belong to their implementation item. No debt credit is claimed for this additional governance machinery.

### Surface Snapshot

- Subsystems: 6
- Production files: 32
- Persistent/external boundaries: 2
- New shared abstractions: 2
- New persistent schemas: 1

Subsystems are protocol, command/workflow integration, effective governance, budget/credit, record storage, and bundled assets. The two existing boundaries are RecordStore streams and Git evidence; there is no new external service. The production inventory below counts TypeScript modules plus bundled prompt/skill assets, including `routing.ts` and `sqlite-index.ts`. The new abstractions are approved execution revision lineage and the reviewed impact/evidence disposition manifest. The persistent schema is one new versioned JSONL record kind, not a new SQLite table or migration. These are extensions of existing schemas, not additional persistent schemas and not SQLite migrations: optional revision fields on observation, context, correction, and guard records; the `implementation:amendment` step result; the persisted `amendmentAssessment` verdict field; and optional `amendmentScope` on the version-1 implementation decision payload. `sqlite-index.ts` keeps rejecting `version !== 1`. Phase 0 confirms the strict-decoder policy for each extension, including version-1 decisions that omit `amendmentScope`. Reconcile these estimates during prerequisite verification; any new persistent projection or locking primitive requires plan revision.

## Architecture Overview

```text
immutable initial binding + registered revision chain
                   |
       canonical effective execution state
                   |
human authorization -> committed amendment -> scoped plan reviewer assessment
                   |                                |
                   +----- registration validation --+
                                 |
               atomic amendment receipt + lineage record
                                 |
      revised plan/ledger + explicit evidence/finding dispositions
                                 |
       fresh author prompt -> quality -> revision-qualified review
                                 |
           shared phase/run boundary and state presentation
```

## Phase 0: Verify Merged Prerequisite and Mutation Boundary

**Completion gate:** Actual integrated plan-210 interfaces, paired append semantics and serialization permit this design; implementation begins only after this plan is reviewed and approved.

- [x] Verify plan 210 is completed and merged; record the integrated commit and interface reconciliation in run records, not unapproved structural plan edits.
- [x] Confirm binding, closure, gate, text-lineage, credit and archived-state readers; inventory raw record scans that need effective-revision semantics, including the `sqlite-index.ts` gate-chain copy and the `routing.ts` final-correction branch.
- [x] Reconcile legacy recovery codecs/keys, repeated recovery and text-lineage ordering; specify deterministic cross-stream causal evidence attribution and fail-closed ambiguity diagnostics before implementing the fold.
- [x] Confirm upgrade can discover active/completed/archived authoritative records without SQLite or source worktrees; inventory retirement of recovery-only command/handler/state branches while retaining historical decoding.
- [x] Verify atomic append plus existing mutation lock/CAS covers approval/predecessor revalidation; resolve any gap by revising this plan before implementation.
- [x] Verify the reviewed impact assessment contract, phase-qualified resolution selectors, and version-1 `amendmentScope` codec fit existing protocol/parser conventions. Confirm historical decisions that omit `amendmentScope` still decode and that no SQLite migration is needed.

## Phase 1: Revision Records and Reviewed Impact Contract (W1, W3)

**Completion gate:** Pure record/assessment codecs and effective revision fold reconstruct valid lineage and reject ambiguous or corrupt authority without changing existing runs.

- [ ] Define amendment payload, initial/current revision identities, portable evidence references, strict codecs, and rebuild kind handling.
- [ ] Add optional revision qualification to implementation evidence; omitted fields use initial-revision fallback only absent intervening legacy recovery, otherwise use Decision 9's causal attribution.
- [ ] Add plan-only `amendmentAssessment` schema/help/normalization and reviewer prompt context containing trusted predecessor/hash/diff.
- [ ] Implement effective execution/finding/evidence fold with explicit carry, invalidation and amendment-resolution dispositions.
- [ ] Fold original-format and repeated frontier recovery receipts as explicitly legacy revisions; reconstruct evidence between boundaries without synthetic reviewer assessments or history rewrites.
- [ ] Cover unknown versions, missing causal pairs, forked predecessor chains, wrong hashes, phase identity changes, and old-run compatibility, including former-contract recovery decisions that omit `amendmentScope`. Omitted `amendmentScope` leaves historical decision intent hashes unchanged.

## Phase 2: Provenance Validation and Registration (W2)

**Completion gate:** Dry-run and record validate identical intent; durable registration is paired, idempotent, and stale/concurrent evidence cannot win.

- [ ] Add `review implementation amend` options/help and framework-independent handler using existing command context and canonical plan identity.
- [ ] Validate active run, accepted human reference, coupled scoped plan approval, exact committed blob/ledger and current revision/hash.
- [ ] Require a new typed `authorize_amendment` with `amendmentScope` and its coupled human step. Reject generic continue/override, unrelated or superseded authorizations, historical decisions that omit the scope, and any effect outside the intersection of that scope and the assessment.
- [ ] Record `amendmentScope` only from the structured decision input and the one-to-one flags in Decision 2. Reject scope inferred from rationale or gate prose, a missing boolean or list key, a bare reopen flag, the object on any other choice, an unknown phase, and a predecessor that is not current. Empty claim and resolution lists are explicit empty arrays.
- [ ] Require the requested `--resolves` set to equal the assessment's amendment-resolved findings, and require that set to be covered by `resolutionRefs`. The assessment may name fewer resolutions than the authorization and must not name more. Plain `--resolves` selects only the source observation; cross-phase refs require the phase/observation/finding selector. Reject unresolved approval gates and unsupported credit/phase changes.
- [ ] Derive preview output without authoritative writes; pair receipt/record through shared admission/finalization and read back the winner.
- [ ] Test retry after partial local projection, identical-intent retry, changed-intent conflicts, authorization reuse against a later predecessor, competing amendments, concurrent reviewers/decisions, stale plan/head and missing authorization.
- [ ] Add negative registration tests for an assessed boundary earlier than `earliestAffectedPhase`, completed-phase reopening when `reopenCompletedPhases` is false, a claim effect that is not enumerated, a resolved finding outside `resolutionRefs`, a plain `--resolves` ID that exists only on another phase, a rationale that names an effect the structured scope does not, a broader assessment accepted or clamped, and `amendmentScope` on a non-`authorize_amendment` choice.

## Phase 3: Revision-Aware Execution and Claim Continuity (W4, W5)

**Completion gate:** A registered amendment permits correctly scoped author admission but cannot reuse affected completion authority or obsolete credit.

- [ ] Route author admission, render/invoke/protocol paths and text-lineage replay through effective state without resetting binding/pre-author identities.
- [ ] Replace recovery-specific authority/routing branches with the canonical fold and remove the independent `recover-plan` mutation path; preserve historical acceptance and allow legacy-to-new revision predecessors.
- [ ] In `routing.ts`, withhold `final_corrections` when an amendment review's assessed bytes changed, and require continued scoped reassessment on native and invoke paths. Initial plan reviews retain the existing shortcut. `run-v1.handler.ts` only reads the persisted route.
- [ ] Refresh revision-qualified code contexts even for unchanged endpoints; retain original continued-review range history and round counts.
- [ ] Carry unresolved findings; suppress only explicitly amendment-resolved identities; preserve unchanged accepted decisions with recorded applicability.
- [ ] Include revision in gate/decision/shortcut authority in both `store.ts` and `sqlite-index.ts`, using the same derivation inputs, and prevent stale guards, contexts, decisions and correction attempts from certifying affected phases. A rebuild must project the same gate identities and readiness.
- [ ] Recompute approved budget under pinned B0/B/mode/thresholds; withdraw or edit a reserved claim only when both the authorization and the assessment enumerate that effect, and invalidate changed claim contracts without minting credit.
- [ ] Apply carry/invalidation to phase advancement, completed-phase progress, phase completion and final run sealing; no bypass through old checklist/progress records.

## Phase 4: State, Guidance and End-to-End Acceptance (W6)

**Completion gate:** Every orchestration path and current/archived reader agrees on effective revision, pending fixes and readiness; documented workflow is executable after a restart/rebuild.

- [ ] Present original/effective provenance and amendment history, affected phases, retained evidence, resolved/pending findings and credit differences in state and registration output.
- [ ] Add upgrade discovery/validation/reporting for legacy recoveries across active/completed/archived authoritative records; repeat safely without journal conversion, synthetic approval, run resumption or automatic project commits.
- [ ] Update author/reviewer templates and phase-execution/plan-review skills across supported delegation modes with authorize → amend → assess → register → resume, including structured `amendmentScope` recording. Rationale prose is not scope.
- [ ] Replace misleading bind/drift remediation with actual supported commands and amendment-assessment requirements; document toolchain compatibility and initial binding distinction.
- [ ] Add deterministic Player Desk-shaped acceptance: unchanged Phase 1, affected Phase 2+, R7 scope-resolution, seven retained fixes, DC1 withdrawal, DC0 conservative carry, and unchanged baseline.
- [ ] Verify read-only dry-run/state against recorded fixtures, index rebuild/source-worktree removal, repeated amendments and interleaved guarded text amendments.
- [ ] Exercise a deterministic legacy-to-new lifecycle: repeated frontier recoveries, intervening reviews, earlier phase completion and text amendments → upgrade/rebuild with identical historical authority → resume → register a new-format amendment against the final legacy predecessor; malformed/ambiguous histories fail closed.
- [ ] Verify the effective installed/rendered asset contract, including retired recovery guidance and amendment reassessment, using `bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts`.
- [ ] Run focused suites, `bun run typecheck`, `bun run lint`, and the full configured quality gates before final review; complete only after all work items and acceptance cases pass.

## Files Touched

Paths are relative to `5x-cli/`. Proposed new modules are named explicitly; the prerequisite gate must reconcile exact interfaces rather than treating these as already shipped.

| Production file / asset | Change |
|---|---|
| `src/review-budget/record-lines.ts` | Amendment codecs, revision fields and portable provenance. |
| `src/control-plane/review-budget-store.ts` | Immutable initial binding plus effective revision/history access. |
| `src/control-plane/review-budget-index.ts` | Validate/skip amendment kind as non-plan lineage during rebuild. |
| `src/review-governance/implementation-amendment.ts` (new) | Canonical revision, impact, finding/evidence fold and registration validation. |
| `src/review-governance/implementation-state.ts` | Admission, text-lineage and code context revision handling. |
| `src/review-governance/implementation.ts` | Effective closure history and contextual validation. |
| `src/review-governance/implementation-boundary.ts` | Preserved/invalidated phase authority and completion. |
| `src/review-governance/context.ts` | Updated scope, pending findings and amendment evidence prompts. |
| `src/review-governance/decisions.ts` | Revision acceptance, supersession, decision carry, and the `amendmentScope` codec and intent hash. Historical omission stays valid. |
| `src/review-governance/store.ts` | Require `amendmentScope` for new authorizations; effective revision gate fingerprints and stale gate disposition. |
| `src/review-governance/sqlite-index.ts` | Rebuild the implementation gate chain with the same revision-qualified `deriveGateId` inputs as `store.ts`, including the raw advisory-binding scan and observation projection. Decode scope-bearing decisions through the shared decision codec. |
| `src/review-governance/credit-reconciliation.ts` | Withdrawn/changed claim and evidence applicability. |
| `src/review-governance/corrections.ts` | Revision-bound proof and shortcut invalidation. |
| `src/review-governance/routing.ts` | Withhold the `final_corrections` shortcut when an amendment review's assessed bytes changed. Leave the initial plan-review shortcut in place. |
| `src/commands/review.ts` | Amend and decision options, source-only and phase-qualified resolution selectors, structured scope input, and help. |
| `src/commands/implementation-recovery.handler.ts` (remove) | Retire independent recovery mutation command; historical receipts remain readable. |
| `src/review-governance/implementation-recovery.ts` (remove/consolidate) | Move reusable checks to canonical registration and legacy fold, removing the second authority path. |
| `src/commands/upgrade.handler.ts` | Discover and validate historical recovery lineage; report compatibility and repair diagnostics without rewriting journals. |
| `src/commands/review-decision.handler.ts` | Record structured `amendmentScope` on `authorize_amendment`, then perform framework-independent registration and the atomic receipt. |
| `src/commands/implementation-review-context.ts` | Revision-qualified composition and durable observations. |
| `src/commands/protocol.handler.ts` | Shared scoped amendment assessment and revision validation. |
| `src/commands/invoke.handler.ts` | Same composition/admission semantics as native recording. |
| `src/commands/run-v1.handler.ts` | Mutation boundary, effective progress and active/archived state. |
| `src/commands/template-vars.ts` | Trusted amendment review inputs and scope/diff context. |
| `src/protocol.ts` | Plan-domain amendment assessment types/schema. |
| `src/protocol-help.ts` | Concrete amendment contract and diagnostics. |
| `src/templates/reviewer-plan.md` | Scoped assessment and carry/resolution requirements. |
| `src/templates/reviewer-plan-continued.md` | Continued amendment approval and exact predecessor evidence. |
| `src/templates/author-process-plan-review.md` | Amendment-specific corrected-commit handoff for fresh scoped assessment. |
| `src/skills/base/5x-phase-execution/SKILL.tmpl.md` | Registration/resume workflow and restart handling. |
| `src/skills/base/5x-plan/SKILL.tmpl.md` | Authoring handoff for semantic amendments and required assessment. |
| `src/skills/base/5x-plan-review/SKILL.tmpl.md` | Scoped amendment review, registration handoff and missing-assessment recovery. |

Update canonical `docs/v1/101-cli-primitives.md` and `docs/v2/206-review-budget-governance.md`. Existing protocol emitter/schema export, skill loader/render fixtures and rebuild dispatch must be inspected in Phase 0; if changes outside this inventory are required, revise the inventory/estimate rather than hiding scope.

Also revise `docs/development/unfinished-frontier-recovery.md` to describe historical support, the retired command and unified amendment registration; it must no longer instruct operators to produce new legacy receipts.

### Workflow Asset-Impact Check

- **Document skeletons (`src/templates/default-artifacts.ts`):** no new static plan/review section is required; `amendmentAssessment` is structured protocol evidence. Confirm this remains true during Phase 0; revise inventory if a skeleton change is needed.
- **Agent prompts:** update initial/continued plan reviewers, plan-review correction author and concrete protocol-emitter examples for exact-hash assessment, typed authorization and post-correction reassessment. Dynamic legacy/revision facts belong in appended runtime context, not copied into static assets.
- **Runtime-appended context:** use one trusted composition/validation path for native/invoke, including predecessor, exact hash/diff, pending/resolved findings, legacy provenance and required next action. Test parity and rejection of stale assessments.
- **Workflow skills:** render plan, plan-review and phase-execution guidance in all supported delegation modes. Remove instructions to create new frontier recoveries; explain historical acceptance, upgrade reporting and continued review after amendment final corrections. Tell the operator to record structured `amendmentScope`. Do not describe rationale prose as authorization for an earlier phase, a completed-phase reopen, a claim edit, or a cross-phase resolution.
- **Installation, overrides, upgrade and harness synchronization:** reuse existing installation/override/upgrade/sync machinery, preserve customized overrides, and surface stale installed guidance with the actual refresh procedure. Do not assume changing bundled Markdown refreshes installed assets. Confirm runtime authority remains correct with overrides and inspect effective installed/rendered guidance after upgrade/sync. No new installation or synchronization authority is introduced.
- **Required acceptance:** run `bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts`; extend consequential assertions for compatibility reporting, installed guidance, command retirement and amendment reassessment rather than prose snapshots.

## Tests

| Type | Scope | Required proof |
|---|---|---|
| Unit | Amendment codecs/fold/assessment | Exact predecessor/hash, phase-qualified findings, no inferred carry, no malformed authority. |
| Unit | Historical recovery compatibility | Original/repeated receipt keys, causal revision attribution between recoveries, preserved historical invalidations/findings/phase authority, interleaved text anchors, ambiguous/corrupt lineage rejection. Omitted `amendmentScope` leaves historical decision intent hashes unchanged. |
| Unit | Registration/record store | Dry-run purity, identical intent replay, single-use consumption, atomic failure, concurrent stale evidence and competing-winner conflicts. Negative cases: earlier boundary, completed-phase reopen without consent, unenumerated claim effect, finding outside `resolutionRefs`, cross-phase plain `--resolves`, rationale-only scope, a broader assessment accepted or clamped, `amendmentScope` on a non-`authorize_amendment` choice, and a former-contract authorization presented to `amend`. |
| Unit | Protocol, prompt, decision and closure | Plan-only contract; `amendmentScope` intent hash with historical omission preserving the old hash; native/invoke parity; retained seven fixes; R7 resolved by amendment only through a qualified ref; stale context/guard/decision rejection; `routing.ts` withholds `final_corrections` after changed amendment bytes. |
| Unit | Budget/credit/boundary | B0/B/policy invariance, DC1 withdrawal only when authorized and assessed, no new credit, DC0 contract/code freshness, affected-phase invalidation and prefix carry. `sqlite-index.ts` rebuild gate identities match live derivation. |
| Integration | `test/integration/commands/implementation-amendment.test.ts` (new) | Full authorization/amend/review/register/resume/quality/closure lifecycle in a mapped worktree; canonical path and excluded-artifact behavior. |
| Integration | Existing completion/code-diff suites | Old phase-complete records cannot skip affected review; unchanged contexts cannot cross revisions; ordinary no-amendment behavior unchanged. |
| Integration | Rebuild/archive/skills | Record-only reconstruction, source removal, portable selectors, two semantic revisions interleaved with text-only amendments, rendered delegation variants. |
| Integration | Upgrade and legacy-to-new transition | Active/completed/archived discovery without index/source worktree; no journal rewrites or invented approvals; repeatable reports; historical authority unchanged after rebuild; final legacy predecessor admits new-contract amendments. |
| Integration | Amendment final corrections | Corrected bytes reject the old assessment; continued scoped review in the active execution run produces fresh exact-hash approval; registration then succeeds with native/invoke parity. |

Use deterministic fake approval/quality/provider fixtures; no network or Player Desk database is necessary. Respect `AGENTS.md` test tiers: direct-call/side-effect assertions in unit tests; subprocess/output assertions in integration tests, with `cleanGitEnv()`, `stdin: "ignore"` unless intentional input, and appropriate timeout. Do not treat a real historical run mutation as test verification.

## Not In Scope

- Arbitrary phase deletion, renumbering or reordering, automatic semantic impact analysis, or importing evidence from another execution.
- Rewriting original bindings, approvals, decisions, findings, pre-author commits or completed phase receipts.
- Treating generic `human:gate`, freeform `ready`, rationale prose, gate-cause text, checked boxes, config changes or document-only file inventory as amendment authorization/registration; proactive amendments without an eligible scoped `authorize_amendment` in this release.
- Reinterpreting historical recovery receipts or their former-contract `authorize_amendment` decisions under `amendmentScope`, or reusing those decisions to register a new-format amendment.
- Rewriting committed historical recovery records, synthesizing missing reviewer assessments, retaining a second recovery mutation API, or introducing a durable migration/bridge record without revising this plan.
- Baseline recapture/reset, new credit IDs, increased credit magnitude, implementation effort added to plan R, or a second arithmetic engine.
- New prompt/lock authority, new external service, dashboard mutation UI, or an unrelated output normalization project.
- Operational handoffs or lifecycle changes to existing project runs.

## Estimated Timeline

This is a moderate cross-cutting feature, not an inline error-message fix. Estimate three implementation slices: (1) records/assessment/fold, (2) registration plus execution/credit continuity, (3) state/assets and integrated acceptance. Phase 0 may expose integration or serialization changes requiring re-estimation. Review approval and the merged prerequisite are required before scheduling execution; there is no independently releasable command-only slice.

## Provenance

The operator requested this required follow-up after investigating Player Desk run `run_cb28fdaefe1a`, canonical plan `539-follow-up-sms-verify-existing-member-qr-claim.md`. Read-only inspection found initial source `run_a3132582022d`, binding `2c67af34-570d-4354-a025-6a147aa25576`, human authorization step 1041, amended plan author step 1043 at `d6c0f56451793cd4bec2710f491bc72b8c1369c9`, and successful plan reviewer step 1045. The amendment retained authentication-campaign invitation-link SMS and withdrew DC1; existing code fixes remained pending. Admission still rejected plan drift and alternate binding conflicted. These references explain requirements, not approval to modify that project.

After further review, the operator reported reversing that scope-change decision and instructing the Player Desk orchestrator to continue under the existing approved scope binding instead. This is an operator-reported disposition, not independent verification that the plan was restored or execution resumed. The historical amendment remains a motivating example and a synthetic acceptance scenario: its reversal does not remove the missing same-run semantic-amendment capability addressed by this plan. No run replacement or application scope change is prescribed here.

During this plan's revision, the operator confirmed at least one local project has used frontier recovery and committed its receipts. The agreed transition retires the mutation command while preserving historical decoding/authority through the canonical effective fold, with `5x upgrade` discovery/validation/reporting rather than automatic journal conversion. Actual project records are not authorized for mutation by this plan or its tests.

## Revision History

### v1.2 (October 18, 2026) — Define amendment authorization scope

Addresses **P1.1** and **P2.1** in [the v1.1 plan review](../reviews/5x-cli-docs-development-plans-215-implementation-plan-amendment-plan-review.md). That review has no addendum.

- **P1.1:** Extend typed `authorize_amendment` with explicit `amendmentScope`: one predecessor revision, the earliest permitted affected phase, completed-phase reopening, enumerated claim withdrawals and contract edits, and phase-qualified finding resolution references. Bind the decision to its binding and source observation. `--from-phase` may precede that decision's phase only inside the authorized floor, and completed phases reopen only with the boolean. Record scope through one-to-one flags; do not default the boolean or the lists, and do not infer scope from rationale. Consume the authorization once, while an identical registration retry returns the recorded winner. Register only the intersection with the reviewer assessment, without clamping a broader assessment. Plain `--resolves` IDs stay source-only; cross-phase refs use `<phase>/<observation-id>/<finding-id>`. Historical recovery receipts and the decisions they cite remain on the former contract, and an omitted `amendmentScope` does not change their intent hashes.
- **P2.1:** Add `routing.ts` and `sqlite-index.ts` to the production inventory, raise the production-file count from 30 to 32, and attribute those modules to W3 and W4. List the related existing-schema extensions, including `amendmentScope`, without adding a persistent schema.

Stable work-item IDs and scores are retained. No re-estimate was applied. `amendmentScope` extends the existing version-1 decision payload, so the new persistent schema count stays 1. Nonblocking follow-ups other than that schema-extension inventory are unchanged. This is a documentation-only revision: no product code, tests, or quality gates were run.
