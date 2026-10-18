# Implementation Plan Amendments — Same-Run Approval Lineage and Revision-Aware Evidence

**Version:** 1.0
**Created:** October 8, 2026
**Status:** Draft — pending review; required follow-up after plan 210 is merged
**Execution order:** Merge completed plan 210, review and approve this plan, then execute this follow-up in a separate implementation branch.

## Executive Summary

Add a supported operation for registering a human-authorized, reviewer-approved semantic plan amendment during an existing implementation run. Preserve the original execution binding, budget baseline, run identity, and code history; append a revision that updates the approved plan and ledger and explicitly governs which earlier evidence remains applicable. Author admission, prompts, review validation, claim reconciliation, gates, and run state must consume the same effective revision.

This is a required follow-up to [plan 210](./210-implementation-review-governance-plan.md), not additional implementation scope for its current branch. The current branch carries this document for review only.

### Scope

**In scope:** same-run amendment registration; explicit human/approval provenance; immutable revision lineage; unchanged baseline and pinned policy; affected-phase invalidation; reviewed evidence carry; amendment-resolved findings; revision-aware text amendments, gates, contexts and claim assessments; dry-run/receipt/state output; recovery and orchestration documentation.

**Out of scope:** arbitrary phase renumbering/reordering; automatic semantic impact detection; implicit rebinding; retrospective inference from freeform approval summaries; baseline resets; a new budget formula; importing approval from unrelated plans; application/provider operations; operational handoffs for existing project runs.

## Overview and Prerequisites

### Observed implementation gap

At inspected branch commit `76938df0d5565ff4b02a72516ecbda3f8c68bf38`:

| Existing seam | Current behavior / required extension |
|---|---|
| `src/commands/review.ts` | `review implementation bind` accepts only execution/source run IDs. No amendment registration command exists. |
| `src/review-governance/implementation-state.ts` | Existing binding admission rejects a different source with `IMPLEMENTATION_BINDING_CONFLICT`; other semantic edits produce `IMPLEMENTATION_PLAN_DRIFT`. The error mentions human-approved amendment provenance without exposing an input for it. |
| `src/control-plane/review-budget-store.ts` | `getImplementationBinding` reads one immutable binding by its run key. Text amendments are separately replayed; semantic successor revisions are absent. |
| `src/review-governance/plan-amendment.ts` | Guarded text-only amendments protect design, structure, budget and debt-claim bytes. They cannot authorize changed campaign routing or withdrawn credit. |
| `src/review-governance/store.ts` | `authorize_amendment` resolves its gate and pauses for amendment; it does not register the reviewed result. |
| `src/review-governance/context.ts`, `implementation.ts`, `implementation-boundary.ts` | Findings and evidence are mostly qualified by binding and phase, not an effective plan revision. |
| `src/review-governance/implementation-state.ts` | Initial source selection requires a completed plan-review run with a finalized commit. A plan review recorded inside an active execution is not that source. |

Changing live configuration to advisory cannot repair lineage: existing bindings pin their mode, and plan-drift admission checks apply to advisory bindings too.

### Mandatory prerequisite

Before any product implementation, verify completed plan 210 is merged into the execution base, including its coupled closure-history, advisory budget, and review-only freshness fixes. Reconcile the actual integrated RecordStore, decision CAS, protocol and review-context interfaces with this design. Approval of plan 210's Markdown alone does not satisfy the prerequisite. Plans 212/214 are not implementation dependencies; their consumers must use the effective revision interface if integrated concurrently.

### Success contract

An active bound run can resume author work against a committed semantic amendment only after a durable registration connects the current revision, operator authorization, exact amended plan, and coupled reviewer approval. Registration does not approve implementation code or complete any affected phase. A restart or index rebuild yields the same effective ledger, pending findings, valid evidence, and readiness.

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

`--resolves` is optional and repeatable; IDs are resolved against the source phase/observation, never globally. `--from-phase` is required. Removing `--dry-run` records registration. Accept numeric step IDs as local convenience and a portable run-qualified step-key selector for rebuild/no-index use; persist only authoritative journal identities, not SQLite IDs, line offsets or timestamps. Human and approval records must belong to the execution run in the first release.

Accept affirmative recorded `human:gate` authorization or an accepted typed `authorize_amendment` decision plus its coupled human step. Verify record identity, acceptance/disposition and referenced scope; do not infer permission from keywords in freeform prose. Referencing a generic authorization is an explicit operator-directed registration action, not autonomous interpretation of an arbitrary `continue` record. Orchestration guidance must require actual operator authorization and expose all claimed effects in dry-run output.

The approval may be a coupled plan review within the active execution run. That path validates its committed blob and snapshot directly; it does not relax the finalized-source requirements for initial `bind`.

### 3. Reviewed amendment assessment, not inferred carry

Extend the plan-review contract with an optional `amendmentAssessment`, required for semantic amendment registration. It identifies the predecessor revision, reviewed plan hash, earliest affected phase, preserved earlier phases with reasons, and amendment-resolved findings as phase/observation/ID/fingerprint references with reasons. The CLI supplies the trusted revision/hash/diff in the reviewer prompt and verifies returned references. Implementation verdicts cannot supply this plan-domain assessment.

The requested `--from-phase` and `--resolves` must match this assessment; the command cannot enlarge carry or resolution beyond what was reviewed. A plain historical `ready` summary does not authorize carry or finding resolution. Obtain a new, explicitly scoped amendment assessment when missing; never rewrite the old approval. This first release need not retrofit the triggering Player Desk approval.

Before preserving an earlier phase, verify its phase section/checklist identities (ignoring checkbox state), linked work-item contracts and due claim contracts remain unchanged. Also require reviewer assessment of changes outside that section, such as shared design/acceptance obligations. Byte equality is necessary for local structure but insufficient to prove global semantic non-impact. When impact is uncertain, move the affected boundary earlier and require review; do not guess. Every changed ledger item must have a reviewed phase impact disposition. Reject deletion, reuse, reordering or renumbering of phase IDs in this release; phases already admitted remain addressable.

### 4. Validate an exact approved revision

Registration requires an active run, a valid binding/revision chain, accepted human provenance, and a successful coupled plan reviewer/snapshot pair with normalized approval route `complete` and no unresolved approval gate. Bind approval to committed plan bytes at the recorded review boundary; verify canonical plan identity, ancestor reachability, parsed ledger equality, amendment assessment hash, and the current worktree plan against those bytes. A later review/run-artifact commit is acceptable only through existing excluded-path equivalence. Uncommitted plan differences and stale approval evidence reject registration.

Baseline/threshold/mode discrepancies in the execution run's separate plan-review snapshot cannot replace execution policy. Validate registration under the original pinned policy; in enforced mode unresolved new budget/semantic gates require existing typed decisions, while advisory diagnostics remain nonblocking. Proposed lineage must not imply that approval of a document certifies the changed implementation.

### 5. Budget continuity and claim identity

Preserve original source/baseline provenance, `B0`, governing `B`, pinned mode and thresholds. Recompute the effective ledger's budget using canonical arithmetic. The amendment review's independent estimate is evidence, not a replacement baseline. Any baseline change must occur through an explicit existing budget decision and be independently referenced, not through this command's flags.

The first release allows withdrawing approved claims, reducing their magnitude, or editing their contract with fresh eligibility/evidence review. Withdrawn IDs remain reserved in lineage and contribute no current provisional/realized credit. Existing claim assessments carry only for exactly unchanged contracts and fresh applicable code evidence. Changed claims invalidate realization/correction carry. Reject new negative-architecture claim IDs, increased approved credit magnitudes, and ID reuse; do not mint additional post-approval credit through an amendment. Positive burden and effort changes remain visible under the inherited budget.

For the triggering scenario, DC1 is withdrawn without credit; DC0 remains only to the extent its contract/evidence remains unchanged. No aggregate negative telemetry can substitute for a claim assessment.

### 6. Preserve work; requalify authority

Retain run ID, worktree mapping, code commits, exact pre-author baselines, review-cycle history and audit records. Existing evidence lacking a revision field belongs to the initial revision; never relabel it as current on decode.

For phases at or after the affected boundary, old completion reviews, correction shortcuts, contexts and claim reconciliations cannot authorize completion under the new revision. Earlier approvals carry only through the explicit validated assessment. Carry records reference source evidence; they do not rewrite it or fabricate new reviews. Every affected phase requires ordinary quality and reviewer re-entry before completion, including phases that previously had `phase:complete` records. Admission/progress and final sealing must honor the new evidence disposition, not checked boxes or old progress shortcuts.

Unresolved implementation findings carry into the new revision, with their original phase, observation, identity and evidence. Amendment-resolved findings are classified as resolved by approved scope change, not fixed in code. `--resolves R7` must not erase R1-R6/R8 or require their reintroduction as new findings. Closure validation and author/reviewer prompts consume one canonical effective finding register; its lineage is distinct from the latest current-revision observation. Preserve reviewer-round counts across amendments.

Keep the original code review baseline/endpoints available for continued diff selection. Generate a fresh revision-qualified context after registration even when code endpoints are unchanged; never reuse a context merely because its patch hash matches. A review spanning several author commits remains anchored to the captured history. Revise decision/gate fingerprints to include revision, and invalidate superseded revision gate authority without reviving old prompts. Existing accepted-risk/waiver decisions carry only for unchanged referenced contracts, with explicit disposition. Text-only guards must name a revision; completed historical text amendments remain audit evidence, while unconsumed old guards cannot mutate the new anchor.

### 7. Atomic registration and concurrent revalidation

Pair `implementation:amendment` and its budget record using the existing admission/finalization and RecordStore atomic append seams. A registration has a deterministic intent digest covering predecessor, evidence references, approved hash, affected boundary and reviewed dispositions. Identical retry returns the recorded winner; changed intent competing for the same predecessor returns a conflict. Do not publish success or a new revision before durable append/readback.

Revalidate the predecessor, referenced reviewer/human ordering and plan/head evidence at finalization using the project's existing per-run mutation serialization. A per-predecessor idempotency key alone prevents competing amendment winners but does not prevent concurrent reviewer/decision appends from making approval stale. Phase 0 must verify the existing lock/CAS boundary supports this full check-and-append; extend that same boundary if needed, not a private lock system. Dry-run performs validation and derived reporting only, without steps, budget, prompt or attribution writes; local existing index hydration is not amendment registration.

### 8. Read/state compatibility and operator output

Show original binding/source provenance separately from effective revision/plan approval provenance. Registration/dry-run output includes budget/claim differences, affected phases, preserved evidence, invalidated authority, retained pending findings, amendment-resolved findings, and the required next action. It must never return implementation `completionAuthorized: true` merely because registration succeeded.

All current admission, template render, invoke, protocol validation, correction finish, decision acceptance, phase/run completion and active/archived state use the effective revision helpers. Fix raw binding scans in gate fingerprinting and closure readers; changing only `getImplementationBinding` would leave inconsistent authority. Rebuilds decode the new kind without projecting it as a plan baseline/snapshot. No SQLite schema migration is expected; verify this assumption against integrated 210. Document the minimum toolchain requirement for amended runs. The new reader rejects unsupported revision versions; do not claim an already-released older CLI can be retrofitted by a new record. Older binaries may continue reporting drift or ignore unfamiliar records and must not be used to execute amended runs.

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Versioned amendment records and canonical effective revision fold | 5 | 2 | - | - | Adds durable lineage and an execution-state abstraction over existing RecordStore streams, including rebuild/compatibility tests. |
| W2 | Exact approval provenance and atomic registration command | 5 | 1 | - | - | Extends paired mutation/CAS across human, reviewer, Git and revision evidence; includes dry-run, duplicate and concurrent tests. |
| W3 | Reviewed impact assessment and effective finding continuity | 5 | 1 | - | - | Adds a plan-domain protocol contract and revision-aware finding/carry semantics across prompts and closure. |
| W4 | Revision-aware admission, contexts, gates and completion | 5 | 1 | - | - | Threads one effective state through execution boundaries without replacing history or resetting pre-author ranges. |
| W5 | Claim withdrawal and conservative evidence carry | 3 | 0 | - | - | Extends existing reconciliation/contract comparisons without another scoring model or authority. |
| W6 | State, orchestration guidance and integrated acceptance | 3 | 0 | - | - | Publishes effective/history provenance and the complete workflow in all delegation variants, with end-to-end recovery tests. |

Tests belong to their implementation item. No debt credit is claimed for this additional governance machinery.

### Surface Snapshot

- Subsystems: 6
- Production files: 26
- Persistent/external boundaries: 2
- New shared abstractions: 2
- New persistent schemas: 1

Subsystems are protocol, command/workflow integration, effective governance, budget/credit, record storage, and bundled assets. The two existing boundaries are RecordStore streams and Git evidence; there is no new external service. The production inventory below counts TypeScript modules plus bundled prompt/skill assets. The new abstractions are approved execution revision lineage and the reviewed impact/evidence disposition manifest. The persistent schema is one new versioned JSONL record kind, not a new SQLite table or migration. Reconcile these estimates during prerequisite verification; any new persistent projection or locking primitive requires plan revision.

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

- [ ] Verify plan 210 is completed and merged; record the integrated commit and interface reconciliation in run records, not unapproved structural plan edits.
- [ ] Confirm binding, closure, gate, text-lineage, credit and archived-state readers; inventory raw record scans that need effective-revision semantics.
- [ ] Verify atomic append plus existing mutation lock/CAS covers approval/predecessor revalidation; resolve any gap by revising this plan before implementation.
- [ ] Verify reviewed impact assessment contract and portable step selector fit existing protocol/parser conventions; confirm no SQLite migration is needed.

## Phase 1: Revision Records and Reviewed Impact Contract (W1, W3)

**Completion gate:** Pure record/assessment codecs and effective revision fold reconstruct valid lineage and reject ambiguous or corrupt authority without changing existing runs.

- [ ] Define amendment payload, initial/current revision identities, portable evidence references, strict codecs, and rebuild kind handling.
- [ ] Add optional revision qualification to implementation evidence; omitted fields map only to the initial revision.
- [ ] Add plan-only `amendmentAssessment` schema/help/normalization and reviewer prompt context containing trusted predecessor/hash/diff.
- [ ] Implement effective execution/finding/evidence fold with explicit carry, invalidation and amendment-resolution dispositions.
- [ ] Cover unknown versions, missing causal pairs, forked predecessor chains, wrong hashes, phase identity changes, and old-run compatibility.

## Phase 2: Provenance Validation and Registration (W2)

**Completion gate:** Dry-run and record validate identical intent; durable registration is paired, idempotent, and stale/concurrent evidence cannot win.

- [ ] Add `review implementation amend` options/help and framework-independent handler using existing command context and canonical plan identity.
- [ ] Validate active run, accepted human reference, coupled scoped plan approval, exact committed blob/ledger and current revision/hash.
- [ ] Require requested phase/finding dispositions to match the reviewer assessment; reject unresolved approval gates and unsupported credit/phase changes.
- [ ] Derive preview output without authoritative writes; pair receipt/record through shared admission/finalization and read back the winner.
- [ ] Test retry after partial local projection, changed-intent conflicts, competing amendments, concurrent reviewers/decisions, stale plan/head and missing authorization.

## Phase 3: Revision-Aware Execution and Claim Continuity (W4, W5)

**Completion gate:** A registered amendment permits correctly scoped author admission but cannot reuse affected completion authority or obsolete credit.

- [ ] Route author admission, render/invoke/protocol paths and text-lineage replay through effective state without resetting binding/pre-author identities.
- [ ] Refresh revision-qualified code contexts even for unchanged endpoints; retain original continued-review range history and round counts.
- [ ] Carry unresolved findings; suppress only explicitly amendment-resolved identities; preserve unchanged accepted decisions with recorded applicability.
- [ ] Include revision in gate/decision/shortcut authority and prevent stale guards, contexts, decisions and correction attempts from certifying affected phases.
- [ ] Recompute approved budget under pinned B0/B/mode/thresholds; withdraw reserved claims and invalidate changed claim contracts without minting credit.
- [ ] Apply carry/invalidation to phase advancement, completed-phase progress, phase completion and final run sealing; no bypass through old checklist/progress records.

## Phase 4: State, Guidance and End-to-End Acceptance (W6)

**Completion gate:** Every orchestration path and current/archived reader agrees on effective revision, pending fixes and readiness; documented workflow is executable after a restart/rebuild.

- [ ] Present original/effective provenance and amendment history, affected phases, retained evidence, resolved/pending findings and credit differences in state and registration output.
- [ ] Update author/reviewer templates and phase-execution/plan-review skills across supported delegation modes with authorize → amend → assess → register → resume.
- [ ] Replace misleading bind/drift remediation with actual supported commands and amendment-assessment requirements; document toolchain compatibility and initial binding distinction.
- [ ] Add deterministic Player Desk-shaped acceptance: unchanged Phase 1, affected Phase 2+, R7 scope-resolution, seven retained fixes, DC1 withdrawal, DC0 conservative carry, and unchanged baseline.
- [ ] Verify read-only dry-run/state against recorded fixtures, index rebuild/source-worktree removal, repeated amendments and interleaved guarded text amendments.
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
| `src/review-governance/decisions.ts` | Revision acceptance, supersession and decision carry. |
| `src/review-governance/store.ts` | Effective revision gate fingerprints and stale gate disposition. |
| `src/review-governance/credit-reconciliation.ts` | Withdrawn/changed claim and evidence applicability. |
| `src/review-governance/corrections.ts` | Revision-bound proof and shortcut invalidation. |
| `src/commands/review.ts` | Command options, selectors and help. |
| `src/commands/review-decision.handler.ts` | Framework-independent registration and atomic receipt. |
| `src/commands/implementation-review-context.ts` | Revision-qualified composition and durable observations. |
| `src/commands/protocol.handler.ts` | Shared scoped amendment assessment and revision validation. |
| `src/commands/invoke.handler.ts` | Same composition/admission semantics as native recording. |
| `src/commands/run-v1.handler.ts` | Mutation boundary, effective progress and active/archived state. |
| `src/commands/template-vars.ts` | Trusted amendment review inputs and scope/diff context. |
| `src/protocol.ts` | Plan-domain amendment assessment types/schema. |
| `src/protocol-help.ts` | Concrete amendment contract and diagnostics. |
| `src/templates/reviewer-plan.md` | Scoped assessment and carry/resolution requirements. |
| `src/templates/reviewer-plan-continued.md` | Continued amendment approval and exact predecessor evidence. |
| `src/skills/base/5x-phase-execution/SKILL.tmpl.md` | Registration/resume workflow and restart handling. |
| `src/skills/base/5x-plan/SKILL.tmpl.md` | Authoring handoff for semantic amendments and required assessment. |
| `src/skills/base/5x-plan-review/SKILL.tmpl.md` | Scoped amendment review, registration handoff and missing-assessment recovery. |

Update canonical `docs/v1/101-cli-primitives.md` and `docs/v2/206-review-budget-governance.md`. Existing protocol emitter/schema export, skill loader/render fixtures and rebuild dispatch must be inspected in Phase 0; if changes outside this inventory are required, revise the inventory/estimate rather than hiding scope.

## Tests

| Type | Scope | Required proof |
|---|---|---|
| Unit | Amendment codecs/fold/assessment | Exact predecessor/hash, phase-qualified findings, no inferred carry, no malformed authority. |
| Unit | Registration/record store | Dry-run purity, identical intent replay, atomic failure, concurrent stale evidence and competing-winner conflicts. |
| Unit | Protocol, prompt, decision and closure | Plan-only contract; native/invoke parity; retained seven fixes; R7 resolved by amendment; stale context/guard/decision rejection. |
| Unit | Budget/credit/boundary | B0/B/policy invariance, DC1 withdrawal, no new credit, DC0 contract/code freshness, affected-phase invalidation and prefix carry. |
| Integration | `test/integration/commands/implementation-amendment.test.ts` (new) | Full authorization/amend/review/register/resume/quality/closure lifecycle in a mapped worktree; canonical path and excluded-artifact behavior. |
| Integration | Existing completion/code-diff suites | Old phase-complete records cannot skip affected review; unchanged contexts cannot cross revisions; ordinary no-amendment behavior unchanged. |
| Integration | Rebuild/archive/skills | Record-only reconstruction, source removal, portable selectors, two semantic revisions interleaved with text-only amendments, rendered delegation variants. |

Use deterministic fake approval/quality/provider fixtures; no network or Player Desk database is necessary. Respect `AGENTS.md` test tiers: direct-call/side-effect assertions in unit tests; subprocess/output assertions in integration tests, with `cleanGitEnv()`, `stdin: "ignore"` unless intentional input, and appropriate timeout. Do not treat a real historical run mutation as test verification.

## Not In Scope

- Arbitrary phase deletion, renumbering or reordering, automatic semantic impact analysis, or importing evidence from another execution.
- Rewriting original bindings, approvals, decisions, findings, pre-author commits or completed phase receipts.
- Treating generic `human:gate`, freeform `ready`, checked boxes, config changes or document-only file inventory as automatic amendment registration.
- Baseline recapture/reset, new credit IDs, increased credit magnitude, implementation effort added to plan R, or a second arithmetic engine.
- New prompt/lock authority, new external service, dashboard mutation UI, or an unrelated output normalization project.
- Operational handoffs or lifecycle changes to existing project runs.

## Estimated Timeline

This is a moderate cross-cutting feature, not an inline error-message fix. Estimate three implementation slices: (1) records/assessment/fold, (2) registration plus execution/credit continuity, (3) state/assets and integrated acceptance. Phase 0 may expose integration or serialization changes requiring re-estimation. Review approval and the merged prerequisite are required before scheduling execution; there is no independently releasable command-only slice.

## Provenance

The operator requested this required follow-up after investigating Player Desk run `run_cb28fdaefe1a`, canonical plan `539-follow-up-sms-verify-existing-member-qr-claim.md`. Read-only inspection found initial source `run_a3132582022d`, binding `2c67af34-570d-4354-a025-6a147aa25576`, human authorization step 1041, amended plan author step 1043 at `d6c0f56451793cd4bec2710f491bc72b8c1369c9`, and successful plan reviewer step 1045. The amendment retained authentication-campaign invitation-link SMS and withdrew DC1; existing code fixes remained pending. Admission still rejected plan drift and alternate binding conflicted. These references explain requirements, not approval to modify that project.

After further review, the operator reported reversing that scope-change decision and instructing the Player Desk orchestrator to continue under the existing approved scope binding instead. This is an operator-reported disposition, not independent verification that the plan was restored or execution resumed. The historical amendment remains a motivating example and a synthetic acceptance scenario: its reversal does not remove the missing same-run semantic-amendment capability addressed by this plan. No run replacement or application scope change is prescribed here.
