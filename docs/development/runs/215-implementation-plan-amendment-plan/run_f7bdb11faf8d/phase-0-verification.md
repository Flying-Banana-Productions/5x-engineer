# Phase 0 verification

Recorded for run `run_f7bdb11faf8d` on October 19, 2026. Checklist completion stays in the plan. This file is the interface reconciliation and the causal attribution algorithm. It does not change approved plan structure, scores, or scope.

No product code is implemented in this phase. Later phases implement only against the rulings below. A contradiction that needs a new file, lock, SQLite migration, or persistent schema is a plan revision and stops for review.

## Integrated commit

Execution checkout `HEAD` at verification:

`4af6e2073a51958b6c3a683baad7c43dcd0bea28`

`fix: accept final corrections and approved architecture in plan recovery`

That commit is the pre-author baseline for this phase. It contains the merged plan 210 prerequisite and the later integration commits the plan required Phase 0 to reconcile.

| Commit | Role |
|---|---|
| `f3a8d670e5dc4e1d12d3574129577737c5740940` | Merge of plan 210, PR #33. Ancestor of `HEAD`. |
| `8c3f93d5601ab5bedb9bd5836e2991a04f9377f5` | Coupled closure history and advisory implementation budgets. Ancestor. |
| `a5869183bd1afa6115235f6126e236384cf627e0` | Advisory plan-review sources with nonblocking budget alerts. Ancestor. |
| `6f19ac9698b4266580dcd19ce053760e778afeac` | Advisory runs do not open governance gates. Ancestor. |
| `76938df0d5565ff4b02a72516ecbda3f8c68bf38` | Review-only freshness. The gap inspected before plan 210. Ancestor. |
| `a15d7b98078488a24b0fdfa98b7545c9def6f174` | Repeated unfinished-frontier recovery. Ancestor, included in the PR #33 merge. |
| `aeaabb136d8d7309a57ea996ddc526a249066827` | Documentation-review base named by the plan. Ancestor. |
| `4af6e2073a51958b6c3a683baad7c43dcd0bea28` | Post-merge recovery fix. Final corrections and a same-run architecture approval may satisfy frontier recovery. Optional `architectureApprovalId` on the recovery payload. This is the integrated recovery contract. |

Approval of plan 210's Markdown is not the prerequisite. The contracts below were read from this checkout.

## Surface estimate

Reconciled against the integrated tree. No change to the approved counts.

- Production inventory stays 32. `routing.ts` and `sqlite-index.ts` are present and are the modules the plan names.
- No new persistent projection and no new lock primitive.
- SQLite schema is already at version 12 (`prompts` abandonment reason `superseded`). Version 11 is the implementation binding/observation/gate projection. Amendment work does not take version 13. `amendmentScope` lives in the existing decision `payload_json`. The new revision record is one JSONL kind.
- `src/review-governance/plan-amendment.ts` stays out of the inventory. A guard names its revision by the observation and text-amendment records that carry it (`record-lines.ts`, enforced in `implementation-state.ts`). The guard struct itself does not gain a field. If a later phase must change that struct, stop and revise the inventory first.
- `src/templates/default-artifacts.ts` needs no new section. `amendmentAssessment` is protocol evidence.
- `src/control-plane/record-fs.ts` and `record-memory.ts` already implement the mutation boundary. Registration catches `RECORD_PRECONDITION_FAILED`. Do not add a private lock or a git predicate inside RecordStore.

## Readers that must share one effective revision

`getImplementationBinding` reads one immutable line, `budget:implementation-binding:${runId}`. Keep that identity. Do not retarget it at the latest amendment. Current readers that stop at this binding, or that scan raw budget lines for `kind === "implementation-binding"`, need the effective-revision helper before they authorize completion, gates, or credit.

| Reader | Current behavior | Required change |
|---|---|---|
| `review-budget-store.ts` `getImplementationBinding` | Single binding key. | Remains the immutable binding read. Add effective revision/history beside it. |
| `review-budget-store.ts` `listImplementationTextAmendments` | Budget journal order. Folds `implementation-plan-recovery` into the text-amendment list. | Byte-lineage input only. Not an independent search for the current revision. |
| `implementation-state.ts` `detectPlanDrift` / `replayTextAmendments` | Parent-linked byte chain. Checkbox-insensitive drift. | Keep parent/hash checks. Revision fold must not invent a second byte chain. |
| `implementation-state.ts` context prepare/verify | Union of every recovery `invalidatedContextIds`. Remediation text points at `recover-plan`. | Effective disposition. Same-range patch hash must not reuse a context across revisions. |
| `implementation.ts` `readImplementationCodeClosure` | Raw budget scan for the binding, then observations. | Closure history follows the effective finding register and invalidation sets. |
| `implementation-boundary.ts` | Union of all recovery invalidation sets. `acceptedPlanRecovery` is the last recovery in list order. Advisory mode reports and does not block. | Same union for the current prefix. Historical prefixes use only recoveries up to that prefix. |
| `context.ts` | `findLast` recovery for the phase. Recovered finding ids become `auto_fix`. | One effective finding register. Do not treat the latest recovery as every phase's authority. |
| `store.ts` `deriveOpenImplementationGate` / `bindingFingerprint` | Recomputes `deriveGateId` from the latest observation. Binding fingerprint is a raw budget scan. | Same derivation inputs as `sqlite-index.ts`, including revision only when the observation stores one. |
| `sqlite-index.ts` | Second gate-chain copy. `advisoryBindings` is a raw `implementation-binding` scan. Projects observations. Rejects `version !== 1`. | Same `deriveGateId` inputs as `store.ts`. Decode scope-bearing decisions only through `listImplementationDecisions`. |
| `decisions.ts` `classifyImplementationDecisionAcceptance` | Observation id, coupled reviewer step, human step after that reviewer, no later binding line with a different id. | Unchanged for historical decisions. A later semantic revision does not rewrite the decision. |
| `credit-reconciliation.ts` | Fold is coupled to an observation and binding ledger passed in. Payload has `observationId` and `stepKey`. | Applicability follows the observation's revision disposition. No second arithmetic. |
| `corrections.ts` | Proof is coupled to an observation id. | Shortcut authority dies with the invalidated observation. |
| `routing.ts` `deriveEnforced` | Plan-domain `final_corrections` when `validateFinalCorrections` passes. `apply.ts` and `routeAfterDecision` only call this. | Withhold that shortcut when an amendment review's assessed bytes changed. Initial plan reviews stay. |
| `run-v1.handler.ts` | Reads the persisted route and binding. Archived/git state rebuilds a memory store from record lines and calls `getImplementationBinding`. | Consume effective state. Do not derive the shortcut here. |
| `protocol.handler.ts`, `invoke.handler.ts`, `implementation-review-context.ts` | Load the binding plus `listImplementationTextAmendments` for drift and guards. | Same effective helper on native and invoke paths. |

`implementation-credit-reconciliation` is already absent from the `review-budget-index.ts` skip list. Unknown kinds fall through the baseline/snapshot branches and are not projected. A new `implementation-plan-amendment` kind must be decoded and skipped explicitly, which is the same safe outcome.

## Gate identity ruling

`deriveGateId` canonicalizes its object and drops `undefined` keys. Historical observations have no revision field. Both `store.ts` and `sqlite-index.ts` must keep today's inputs for those observations: `runId`, `snapshotId` (the observation id), sorted causes, optional predecessor, and the implementation tuple `domain`, `phase`, `bindingId`, `observationId`.

Pass `revision` only when the stored observation has that field. Do not substitute the attributed initial or legacy revision into the hash. Doing so would change recorded gate ids, so existing `authorize_amendment` decisions would no longer resolve and ordinary no-amendment runs would change.

New observations store the revision they were recorded under. Live derivation and index rebuild pass that same stored value. Authority of an old observation after a later recovery is the invalidation disposition, not a rehash.

## Legacy recovery codec and keys

`decodeImplementationPlanRecoveryPayload` accepts version 1, `guardId: null`, and optional `architectureApprovalId`. Omission of `architectureApprovalId` is the original shape. Presence decodes a string. Both shapes remain valid.

Idempotency keys, from history:

- Original single-recovery key: `budget:implementation-plan-recovery:${bindingId}`. At most one per binding.
- Later authorization-scoped key: `budget:implementation-plan-recovery:${bindingId}:${authorizationId}`. This is what `recoverImplementationPlan` writes now.

The fold's identity is the payload `id` (`recovery:` plus the SHA-256 of the registration intent), not the key shape. A valid payload under either key decodes. Two lines with the same payload id, or two recoveries with the same `authorizationId`, fail closed.

`replayTextAmendments` walks `listImplementationTextAmendments`, which is budget journal order of text amendments and recoveries for the binding. Each line's `parentLineageId` must equal the previous line's `id` (`null` for the first), and `beforeBlobHash` must equal the previous authorized hash. That parent chain is the byte lineage. Journal order and the parent chain are the same sequence when the chain is valid. A parent that skips, forks, or disagrees with journal order is an invalid chain today (`chainValid: false`) and a fail-closed revision history for the fold.

Text amendments do not start revisions. They extend the authorized bytes of the revision already open at their journal position. Their anchor checks stay as they are.

The final recovery in that chain is the predecessor a new-format amendment may name. Historical `authorize_amendment` decisions cited by `authorizationId` stay on the former contract: no `amendmentScope`, one recovery each, not reusable as a new-format authorization.

## Causal attribution algorithm

Streams are `steps`, `decisions`, and `budget`. Order is journal order inside one stream: `listLines`, first idempotency key wins. Do not compare `created_at`. Do not interleave streams by line number, file offset, or timestamp. Do not use git commit timestamps.

### Revision labels

These labels are pure functions of existing ids. They are not written back into historical lines.

- Initial revision: the binding id. No recovery precedes it.
- Each `implementation-plan-recovery` opens one `legacy_frontier_recovery` revision. The revision id is that receipt's payload `id`. Its predecessor is the previous recovery's id, or the initial revision when it is the first recovery.
- A new-format amendment, when Phase 1 defines it, appends after the current predecessor. Its predecessor is the last legacy receipt id when the chain ends in a recovery, otherwise the initial revision.

### Budget-stream evidence

Kinds without a stored revision: `implementation-review-context`, `implementation-review`, `implementation-correction-attempt`, `implementation-credit-reconciliation`, `implementation-text-amendment`.

Partition by budget journal position relative to recovery lines for the binding:

- Before the first recovery: initial revision.
- After recovery R and before the next recovery: R's revision.
- After the last recovery: that recovery's revision.

Applicability at a prefix ending at recovery R (the initial prefix ends before any recovery):

- An observation or context is invalidated when its id is in the union of `invalidatedObservationIds` or `invalidatedContextIds` on recoveries up to and including R.
- The current effective prefix uses every recovery. That matches `implementation-boundary.ts` and context verification today.
- An earlier prefix does not apply a later recovery's invalidation set.
- Evidence that is not in the set remains applicable. Preserved earlier-phase reviews stay applicable across later legacy revisions. They keep the revision of the segment that recorded them. They are not relabeled as the latest revision.
- A correction attempt or credit reconciliation cites `observationId` (corrections also cite `sourceObservationId`). It takes its own journal segment as its revision. It can certify only while the cited observation is applicable in that same prefix. A missing cited observation fails closed.
- Each recovery R's `invalidatedContextIds` and `invalidatedObservationIds` are cumulative prefix equality, not the ids recorded only since the previous recovery. They equal the ids in the budget prefix before R of: contexts for the binding on phases at or after R's frontier, and observations on those same phases. The frontier and later phases are taken, in order, from R's predecessor authorized bytes. `81eddb4`, `a15d7b9`, and `implementation-recovery.ts:412-418` all compute the sets that way over the whole prefix. A later recovery at the same frontier therefore repeats ids an earlier recovery already invalidated. That repetition is the prefix set, not an extra id. Missing means an id in the prefix set that R omits. Extra means an id on R outside that set: a preserved earlier phase, or an unknown or dangling id. A missing or extra id fails closed. The diagnostic names the run, the evidence id, and the recovery id. Phase 1 checks this one equality. It does not diff the segment between recoveries.

### Cross-stream evidence

Attribute only through a stored reference. If the reference is missing or duplicated, fail closed. Do not assign the line to the initial revision or the latest revision as a fallback.

- A reviewer step inherits the revision of the observation whose `stepKey` produces that step's idempotency key. Two observations claiming one step key fail closed.
- An implementation decision inherits the revision of the single observation named by `observationId`. Zero or several matches fail closed. This is the same boundary `classifyImplementationDecisionAcceptance` already requires.
- A `human:review-governance` step whose `result_json.decisionId` matches a decision inherits that decision's revision.
- Plan snapshots and plan-review decisions are not implementation revisions. A recovery's `snapshotId` is provenance of that receipt.
- `implementation:pre-author` stays the original baseline for its binding and phase. It is not moved onto a later revision. A second pre-author for the same binding and phase fails closed.
- `phase:complete`, `git:commit`, and quality steps are not completion authority. The boundary uses observations, correction proofs, reconciliations, and drift. Do not order these steps against a recovery, and do not treat them as certifying a revision. Progress and sealing use the evidence disposition.
- `authorize_amendment` is consumed by the recovery whose `authorizationId` names it. It does not authorize a later revision. Accepted-risk and waiver decisions carry only when the referenced contract is unchanged, as an explicit disposition on top of the original decision.

### Fail-closed diagnostic

When a rule above fails, the fold returns a diagnostic and no effective authority. The diagnostic includes the run id, stream, idempotency key or record id, the recovery ids involved, and the requirement for explicit repair or review. Upgrade reporting surfaces that diagnostic. It does not rewrite the journal, synthesize an assessment, or resume the run.

The registration CAS expected-key set is not stored on the receipt. Git ancestry of a `phase:complete` commit is not a substitute, because a completion can sit between the amendment commit and the receipt without a durable key set. That is why those steps are not revision authority.

## Upgrade discovery and retirement inventory

Discovery does not need SQLite or the execution worktree.

- `FileRecordStore.listRuns` walks the configured records root and reads each `run.json`. Statuses are `active`, `completed`, and `aborted`. Sealed runs stay in that root. There is no separate archived-run directory.
- `listLines` reads the JSONL files. The SQLite index is a projection.
- `loadGitRecordForPlan` reads `run.json`, `steps.jsonl`, `budget.jsonl`, and `decisions.jsonl` from a commit via `git ls-tree` / `git show`. `worktreePath` is optional. The control-plane checkout is enough when the files exist only in git history.

`runUpgrade` does not walk recovery lineage yet. Phase 4 adds the report on top of this walk. It must not resume runs or rewrite journals.

Retire as mutation authority, after `amend` covers the scenarios:

- `review.ts` `recover-plan` command.
- `implementation-recovery.handler.ts`.
- The registration path in `implementation-recovery.ts`. Keep the reusable validation checks only by moving them into the canonical fold, not by leaving a second writer.
- Operator guidance in `5x-phase-execution` and `5x-plan-review`, and `docs/development/unfinished-frontier-recovery.md`.
- State branches that present recovery as the current remediation: `context.ts` `planRecovery`, `implementation-boundary.ts` `acceptedPlanRecovery`, and the `recover-plan` strings in `implementation-state.ts`.

Keep:

- `decodeImplementationPlanRecoveryPayload`.
- Both idempotency key shapes.
- Optional `architectureApprovalId`.
- Historical `authorize_amendment` lines that omit `amendmentScope`.
- Index skip/decode of the recovery kind so it is never a plan snapshot.

## Mutation boundary

`atomicAppendIfAllNew` is the check-and-append.

- One run per batch. Duplicate keys inside the batch throw `INVALID_ATOMIC_APPEND`.
- The file and memory stores take a per-run exclusive writer lock, recover an abandoned transaction, then compare streams.
- Existing keys return `{ created: false, duplicates }` and write nothing.
- `expectedKeys` is an exact list compare against Map insertion order. That order matches `listLines`, because both follow first-seen journal order and skip duplicate keys. Callers pass `listLines(...).map((line) => line.idempotencyKey)` for `steps`, `budget`, and `decisions`.
- A concurrent reviewer step, decision, or budget append changes a key list and throws `RECORD_PRECONDITION_FAILED` before the new line is committed. The current message says to repeat the recovery dry-run. Registration maps that code to its own diagnostic. The RecordStore message can stay.
- Identical retry is the duplicate-key result. The caller returns the stored winner when the payload id matches, and conflicts when it does not. Recovery already does this. Amendment registration uses the same pair: receipt line plus readback.
- The lock does not cover git. Registration validates the committed blob, worktree bytes, and `HEAD`, then appends under the record CAS. The receipt stores those bytes and the commit. A later `HEAD` that differs is drift on the next admission, not a second authorized plan. That is the same boundary frontier recovery uses. No RecordStore git hook is required.

Dry-run stays outside `atomicAppendIfAllNew`. It must not append steps, budget, prompts, or attribution.

## Protocol, selectors, and `amendmentScope`

`ReviewerVerdict` is an object with optional fields. `ReviewerVerdictSchema` lists properties and requires `readiness` and `items`. `normalizeReviewerVerdict` copies unknown keys through. `amendmentAssessment` fits as an optional property on that schema, documented in `protocol-help.ts`, and rejected by the contextual validator unless the review is a plan-domain amendment review. Implementation verdicts cannot supply it. No document-skeleton change.

`5x review decide` already collects repeatable flags and accepts `--input-json` for a structured payload. `implementationFindingRefs` resolves finding ids to recorded fingerprints. The new flags map one-to-one onto `amendmentScope` and join that pattern:

- `--predecessor-revision`
- `--earliest-affected-phase`
- `--reopen-completed-phases true|false` with the token required
- repeatable `--claim-edit`
- repeatable `--resolution-ref <phase>/<observation-id>/<finding-id>`

Plain `--resolves <finding-id>` stays a command selector for the authorization's source observation. It is not a decision-recording flag. The phase-qualified form is the same three-part selector.

`computeImplementationDecisionIntentHash` hashes an explicit field object. `canonical` drops `undefined`. Historical decisions omit `amendmentScope`, so their hash input stays the current field set. Do not write null or an empty object for them. A present `amendmentScope` is part of the hash and must match the structure in Decision 2. `validateImplementationDecision` today accepts version 1 without that field and rejects claim adjustments on `authorize_amendment`. Strict decode keeps that acceptance. Every new `authorize_amendment` recording must include the object. Any other choice that carries it is rejected.

`listImplementationDecisions` and `decodeImplementationDecisionPayload` are the only decision parsers. `sqlite-index.ts` lists decisions through them and stores `payload_json`. A scope-bearing line is not a second schema and is not a malformed version. `sqlite-index.ts` still rejects implementation binding and review records whose `version !== 1`.

No SQLite migration. Next schema version remains 13 and is unused.
