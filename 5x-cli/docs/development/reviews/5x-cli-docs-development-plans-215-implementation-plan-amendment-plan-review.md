# Review: Implementation Plan Amendments — Same-Run Approval Lineage and Revision-Aware Evidence

**Review type:** `docs/development/plans/215-implementation-plan-amendment-plan.md` (v1.1 at `354f61a`)
**Scope:** Same-run semantic amendment registration, effective revision fold, legacy frontier-recovery retirement, revision-aware evidence/gates/claims, upgrade reporting, workflow assets
**Reviewer:** Staff engineer (correctness, authority/provenance, durability, operability)
**Local verification:** Not run (static review against `main` at `354f61a`)

**Implementation plan:** `5x-cli/docs/development/plans/215-implementation-plan-amendment-plan.md`
**Technical design:** `5x-cli/docs/v2/206-review-budget-governance.md`, `5x-cli/docs/development/plans/210-implementation-review-governance-plan.md`, `5x-cli/docs/development/unfinished-frontier-recovery.md`

## Summary

The plan correctly sees that neither an alternate binding nor the narrow `recover-plan` path can carry a semantic amendment through an active run. It proposes the right shape: an immutable initial binding, an appended revision chain, one canonical effective-state reader, reviewer-assessed carry, and retirement of the second mutation authority while keeping historical decoding. Its claims match the integrated code. Recovery (`src/review-governance/implementation-recovery.ts`) already uses `atomicAppendIfAllNew` with per-stream expected keys, which is the CAS boundary Decision 7 relies on. Legacy recoveries record explicit `invalidatedContextIds`/`invalidatedObservationIds` sets, and the boundary, context and drift readers consume those sets today. One policy gap blocks implementation. The plan says registration must reject "effects outside authorized scope". It also lets an amendment invalidate earlier and completed phases, withdraw claims, and resolve findings across phases. But the existing `authorize_amendment` decision only carries `rationale` plus `findingRefs` for one phase/observation, and the plan never defines what that decision authorizes. The file inventory also omits two modules that the stated behavior requires.

**Readiness:** Not ready. The scope of a typed amendment authorization needs a human policy decision before the registration validator can be specified and tested.

---

## Strengths

- **Single authority with historical support.** Decision 9 removes the independent `recover-plan` mutation while keeping strict decoding of committed `implementation-plan-recovery` receipts. A `legacy_frontier_recovery` revision is folded into one effective reader, with no journal rewrites and no synthetic approvals. This removes the current split where recovery branches are scattered across `implementation-boundary.ts:360-410`, `implementation-state.ts:2010,2120` and `context.ts:415-480`.
- **The plan points to the right code seams.** Raw binding scans in `decisions.ts:906-918` (superseded binding), `store.ts:609` (`bindingFingerprint`) and `implementation.ts:642` (closure) are real. Decision 8 is right that changing only `getImplementationBinding` would leave inconsistent authority.
- **Conservative carry.** Earlier phases are preserved only through a reviewed assessment plus structural identity checks. Byte equality is treated as necessary, not sufficient. Uncertainty moves the boundary earlier. Old `phase:complete`, contexts with matching patch hashes, and shortcut proofs cannot certify affected phases.
- **Budget continuity.** Pinned `B0`/`B`/mode/thresholds stay as they are. The reviewer estimate is evidence, not a new baseline. The plan forbids minting new credit (no new negative-architecture IDs, no larger magnitudes, no ID reuse). Withdrawn IDs stay reserved.
- **The final-correction trap is called out explicitly.** Decision 4 requires a continued scoped reassessment after an amendment `final_corrections` pass, rather than letting the ordinary enforced shortcut skip review of changed bytes.
- **Older binaries fail closed.** An older binary ignores the new kind in `listImplementationTextAmendments` (`review-budget-store.ts:472`). It therefore detects plan drift and rejects admission, rather than accepting stale evidence. This supports Decision 8's toolchain-requirement framing.

---

## Production readiness blockers

### P1.1 — "Authorized scope" of an `authorize_amendment` decision is undefined and cannot be verified

**Risk:** Decision 2 and Phase 2 require registration to "verify … authorized scope against the proposed amendment" and to "reject … effects outside authorized scope". The only authorization the plan accepts is the existing typed `authorize_amendment` decision. Its required fields are `rationale` and `findingRefs` (`store.ts:640`). It is bound to one `bindingId`, `phase` and `observationId`, and it is offered only for `plan_amendment` gate causes (`store.ts:678-683`). The plan, however, lets an amendment:

- invalidate phases earlier than the authorizing phase, including completed ones (Decision 6);
- withdraw or edit approved claims (Decision 5);
- record amendment-resolved findings as "phase/observation/ID/fingerprint references", which may sit in other phases (Decision 3).

At the same time, Decision 2 says `--resolves` IDs are "resolved against the source phase/observation, never globally". Nothing records which of these effects the operator approved. As written:

- the scope check cannot be implemented without inventing policy;
- the `--resolves` selector cannot express a cross-phase resolution that the assessment is allowed to list, so such a registration could never match;
- the plan doesn't say whether one authorization may be reused for a second amendment after the predecessor advances. The legacy path rejected reuse explicitly (`implementation-recovery.ts:103-112`).

So an authorization given for a Phase 3 finding could, through reviewer assessment alone, reopen completed Phases 1–2 and withdraw credit, with no operator consent to those effects.

**Requirement:** State mechanically what one accepted, unsuperseded authorization covers and how the validator checks it. At minimum:

- which findings may be marked amendment-resolved: only the authorization's `findingRefs` / source observation, or any reviewed pending finding;
- whether `--from-phase` may precede `authorization.phase` (and reopen completed phases) without further typed operator consent;
- whether claim withdrawal or contract edits need explicit consent beyond the reviewer assessment;
- that an authorization is single-use per predecessor revision.

Then align the `--resolves` selector form (phase-qualified or source-only) with the `amendmentAssessment` reference shape. Add negative tests for each out-of-scope effect.

**Implementation guidance:** The lowest-cost option needs no decision-schema change:

- scope = binding, predecessor revision, source observation and `findingRefs`;
- `--resolves` ⊆ those `findingRefs`;
- the boundary and claim effects are governed by the reviewed assessment and are disclosed in dry-run output;
- an earlier `--from-phase` or any claim withdrawal is allowed only when the authorization's rationale was recorded against a gate that names them.

Alternatively, extend `authorize_amendment` with explicit scope fields, which adds a schema change. Choosing between these is a policy decision.

---

## High priority (P1)

None beyond P1.1.

## Medium priority (P2)

### P2.1 — Files Touched omits `routing.ts` and `sqlite-index.ts`

Two behaviors the plan requires live in modules that aren't in the inventory.

- **`src/review-governance/routing.ts`:** The amendment-specific override of the final-correction shortcut (Decision 4, Phase 3 bullet 3) belongs here, or in an explicitly documented post-routing step. The `final_corrections` route is derived at `routing.ts:274-290`. `run-v1.handler.ts:1075` only reads the persisted route.
- **`src/review-governance/sqlite-index.ts`:** This module has its own copy of the implementation gate-chain derivation (`sqlite-index.ts:251-370`). It calls `deriveGateId` with binding/observation inputs, builds `advisoryBindings` from a raw `implementation-binding` scan, and projects `implementation_observation_index`. Decision 6 makes gate/decision fingerprints revision-qualified. Without changes here, a rebuild projects gate IDs that differ from the live `store.ts` derivation. That contradicts the success contract, which says an index rebuild yields the same readiness.

The plan already says to revise the inventory when work falls outside it. These are known now, so add both rows, raise the production-file count from 30 to 32, and attribute them to W3/W4.

---

## Nonblocking follow-ups

- **`phase:complete` replay shortcut:** `recordStepInternal` (`run-v1.handler.ts:3853-3884`) returns an existing `phase:complete` as `recorded: false` before any boundary check, unless a later author/reviewer step or `run:reopen` exists. After an amendment that invalidates a completed phase, an orchestrator that calls `phase:complete` first gets an apparent success. Name this path in the Phase 3 "no bypass through old progress records" test. Also make `phases_completed` (`run-v1.handler.ts:2389`) honor the effective revision.
- **Fail fast on a missing assessment:** When the CLI knows a plan review in a bound execution run is an amendment review, protocol validation could require `amendmentAssessment` up front. Otherwise registration discovers the gap later and a fresh reviewer step is needed.
- **In-flight legacy recoveries at upgrade:** A run that has an authorization and a ready plan review but no recovery receipt yet loses `recover-plan`, and its old review lacks an `amendmentAssessment`. `5x upgrade` reporting could identify this state and name the re-review requirement.
- **Legacy attribution is mostly set-based:** Recovery receipts, contexts, observations and correction attempts all live on the single, totally ordered budget stream. Recovery also refuses to invalidate completed phases. Phase 0 will probably find that cross-stream causal attribution is needed only for steps-stream progress. Recording that conclusion explicitly would simplify the fold.
- **Surface accounting:** "New persistent schemas: 1" counts only the new budget kind. Optional revision fields on existing observation/context/correction/guard records, the `implementation:amendment` step result, and the persisted `amendmentAssessment` verdict field are extensions to existing schemas. They are worth listing so Phase 0 can confirm the version/strict-decoder policy for each (`sqlite-index.ts:259` rejects `version !== 1`).
- **Phase titles/additions:** The plan rejects deletion, reordering and renumbering. It doesn't say whether appending new phases or renaming phase titles is allowed. Legacy recovery rejected renames.

---

## Delivery budget assessment

The author ledger totals 31 (W1–W6) and claims no debt credit, so there are no `DCn` claims to assess. My independent estimate is about **36**. W4, which threads the effective revision through admission, contexts, gates, decisions, corrections, routing, the SQLite projection and completion, is closer to 8 than 5. W6, which covers upgrade discovery across active/completed/archived records, all-delegation-mode assets and two end-to-end lifecycles (Player Desk-shaped and legacy-to-new), is also closer to 8. W1–W3 and W5 look reasonable. Confidence: medium. Phase 0 may change the serialization or attribution scope.

## Readiness checklist

- [x] Prerequisite (plan 210 merged at `f3a8d67`, integrated base `aeaabb1`) correctly stated
- [x] Atomic append / CAS seam exists (`RecordStore.atomicAppendIfAllNew` with per-stream expected keys)
- [x] Legacy recovery decoding and invalidation sets identified for the fold
- [ ] Authorization scope defined mechanically (P1.1)
- [ ] File inventory includes routing and SQLite projection modules (P2.1)
- [x] Test tiers and asset acceptance suite follow `AGENTS.md`
