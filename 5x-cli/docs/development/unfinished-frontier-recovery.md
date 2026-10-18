# Narrow unfinished-frontier plan recovery

## Scope and rationale

This is a time-sensitive recovery path for an already-authorized amendment at an
unfinished implementation frontier. Plan 215 remains intact: this does not
deliver general revision-aware amendments, claim withdrawal, finding resolution
by scope change, or invalidation of completed phases.

The original binding, source approval, B0/B, policy, ledger and phase map remain
immutable. Each distinct `implementation-plan-recovery` journal record extends
the authorized plan-byte chain. It references the exact authorization, source
observation, amended author commit, latest same-run ready plan-review snapshot,
and explicit operator confirmations of bounded scope and earlier-phase non-impact.
These confirmations cover shared/design changes; a generic ready summary is not
automatically interpreted as proof of non-impact. The command is deliberately
operator-driven and is never called automatically by render/invoke.

Eligibility requires unchanged phase IDs/order/titles and earlier phase sections
(ignoring checkboxes); unchanged work-item IDs/titles/scores/surface; no debt
claims; no completion receipts or completion-authorized observations at/after
the frontier; accepted finding-fingerprint-scoped authorization; a recorded
author after authorization and before the coupled ready/empty plan review; no
later plan author/reviewer or unresolved plan gate; reachable committed bytes;
and no non-workflow changes since the amendment commit. Addresses/rationale may
document the amendment. The separate amendment review's baseline never replaces
the implementation baseline.

Existing affected review contexts/observations are explicitly invalidated for
completion, but retained for code endpoints, findings and review-round history.
A fresh context is required even for an unchanged diff. All findings remain
pending until a fresh implementation review accounts for them. Text guards
anchored before recovery fail their existing parent-lineage check. No phase
completion, operator prerequisite, external operation or expanded scope is authorized.

## Operator procedure

Stop the orchestrator while accepting recovery. Use the new toolchain commit
for subsequent execution; older binaries do not understand recovery lineage.
From the established project/worktree context, substitute the actual durable
identities into this example:

```sh
5x review implementation recover-plan \
  --run "$RUN_ID" --phase "$EARLIEST_AFFECTED_PHASE" \
  --authorization "$AUTHORIZATION_DECISION_ID" \
  --snapshot "$PLAN_REVIEW_SNAPSHOT_ID" \
  --commit "$AMENDMENT_AUTHOR_COMMIT" \
  --confirm-scope 'The exact committed/reviewed amendment implements only the authorized policy corrections. Existing operating restrictions remain in force.' \
  --confirm-preserved-phases 'Earlier phase contracts remain valid. Shared design changes do not invalidate their implementation approvals.' \
  --dry-run
```

The confirmation arguments are actual operator attestations: inspect the
amendment and its shared-design effects before accepting them. Replace the
example prose with the specific authorized scope and restrictions. Review the
preview, then repeat the same command without `--dry-run`. Identical acceptance
is idempotent, including receipts written by the original single-recovery version.
Further amendments may repeat this procedure without a per-binding limit, each
with a new authorization and coupled ready plan review. Reusing an accepted
authorization with changed intent is rejected. Earlier-phase preservation is
checked against the latest admitted plan bytes. A concurrent
journal append fails the optimistic precondition under the existing writer lock.

Check `5x run state --run "$RUN_ID" --json`: plan drift should be false,
`acceptedPlanRecovery` should identify the amended commit, original binding and
implementation baseline should be preserved, and the affected phase should
remain unready. Render a fresh `author-process-impl-review` prompt, implement all
admitted corrections, run ordinary quality gates, then render a fresh
implementation reviewer context and record at the next unused iteration.
The original review context is stale for recording. Outstanding operator
prerequisites remain pending; recovery does not authorize phase completion.

## Asset-impact check

- Document skeletons (`default-artifacts.ts`): unaffected. Recovery is runtime
  provenance, not a new implementation-plan or review-document section.
- Agent prompts: initial/continued plan reviewers explain approval versus
  attachment; implementation-fix author consumes accepted runtime recovery.
- Appended context: one shared native/invoke builder provides effective commit,
  authorization, scope restrictions, and admitted design findings. Durable
  records own those facts; prompts contain no incident-specific identities.
  It selects the latest accepted recovery for the phase after repeated amendments.
- Skills: phase execution and plan review explain the explicit operator handoff
  across delegation modes. General plan authoring is unaffected: recovery takes
  an already-recorded amendment author result and does not change authoring.
  Phase execution now explains repeatable recovery with fresh authorization and
  review in every rendered delegation mode; plan-review guidance already applies
  independently to each amendment and needs no change.
- Installation/override/upgrade/sync: existing versioned template upgrade and
  skill rendering/sync paths apply. Existing customized overrides are preserved;
  runtime recovery context still supplies authority. Acceptance checks cover
  installed/synced phase-execution guidance, not only bundled Markdown.
  No schema migration is needed: new receipts use authorization-scoped keys,
  while replay finds existing receipts by payload ID regardless of their key.

## Verification

Focused unit tests cover pure dry-run, authoritative replay, unchanged binding,
admission, pending findings, stale-context rejection, invalidated completion,
unauthorized drift, wrong/missing authorization, wrong phase/snapshot, dirty
bytes, changed score/earlier phase, completed frontier, missing confirmation,
later review, and a concurrent journal append. Integration tests exercise the
CLI through completed Phase 1, failed Phase 2, human authorization, committed
amendment, same-run review, acceptance/retry, fresh author/reviewer contexts,
preserved progress and blocked stale completion. The asset acceptance suite
verifies effective installed/rendered guidance.
Repeated-recovery coverage extends an original-format receipt through multiple
same-phase amendments and a later frontier after phase completion, verifies
hash/commit/parent lineage and latest runtime context, rejects authorization
reuse and earlier-phase reversion, and checks dry-run and idempotent replay.
