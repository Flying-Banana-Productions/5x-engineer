# Issue-driven resolution through 5x

**Status:** Proposed design; initial implementation scoped separately
**Date:** November 5, 2026
**MVP requirements:** [Explicit issue resolution](plan-inputs/11-explicit-issue-resolution.plan-input.md)
**MVP implementation plan:** [217 — Explicit issue resolution](../development/plans/217-explicit-issue-resolution-plan.md)

## 1. Goal

A user should be able to ask an orchestrator to resolve a GitHub issue, a named
set of issues, or eventually a useful batch discovered in the backlog. The work
should enter the existing implementation-plan, plan-review, and phase-execution
process, retain its budgets and durable decisions, and finish with evidence that
the issues were actually resolved.

Issues describe reported needs. Approved plans authorize work. Verification and
delivery evidence establish resolution. These are distinct responsibilities.

```text
Explicit issue / issue set / backlog scan
  -> investigate and scope
  -> form work package(s)
  -> plan -> plan review -> phase execution and implementation review
  -> verify issue acceptance -> PR -> merge/delivery -> reconcile issues
```

This document records the broader direction. Only the linked MVP requirements
are admission scope for the first implementation plan; future sections here do
not authorize additional implementation.

## 2. Preserve the existing governance core

The current toolchain already provides requirements-to-plan generation,
parseable delivery budgets and surface snapshots, stable work/debt identities,
independent review, approved-source implementation binding, quality gates,
durable decisions, plan amendments, and git-native run history.

Issue resolution composes these facilities. It does not create a second review
loop, budget, approval system, or definition of phase completion. Configured
native/invoke delegation and advisory/enforced/off governance behavior continue
to apply. Delivery budgets measure implementation effort and maintenance burden,
not model token spend or currency.

The new responsibilities are intake before planning, traceability across existing
workflows, and delivery reconciliation after implementation. A sealed successful
implementation run establishes reviewed implementation, not remote delivery or
issue closure.

## 3. Work packages

A work package is a bounded body of work connecting source issues to:

- A durable intake brief and source snapshots.
- One implementation plan and its approved revisions.
- Planning/review and implementation runs.
- Pull requests and delivery observations.
- Acceptance criteria and resolution evidence for each source issue.

Its identity must survive individual runs and sessions. The eventual model can
support multiple issues per package and multiple packages contributing to a
large issue. An input set is not automatically one package; the orchestrator
should split unrelated work. A package initially stays in one repository.

For the MVP, one issue, one plan, and one PR are sufficient. The plan path plus
canonical source issue identity serves as the package association. A committed
brief and existing run records provide local history; no new package entity,
database table, or state-machine command family is required initially.

## 4. Intake and source authority

Intake resolves the repository and issue, reads its description and relevant
discussion, checks existing work, investigates the code, and attempts reproduction
when appropriate. It distinguishes reporter claims, established facts, assumptions,
and unresolved questions.

Record the source identity (host/repository/issue and available stable remote
IDs), source URLs, retrieval time, and the issue/comment content used. Explicitly
identify any unavailable, truncated, or intentionally excluded context. A committed
snapshot has immutable Git provenance; a later structured importer can also add
canonical content digests.

The brief defines proposed acceptance criteria with stable local IDs, exclusions,
dependencies, and a recommended disposition:

- Ready to plan.
- Needs clarification or investigation.
- Blocked by other work.
- Already addressed.
- Duplicate.
- Not proceeding, with rationale.

An inability to reproduce is not proof of resolution. Non-implementation
dispositions should not require a fictitious implementation plan.

Issue text and discussion are source data, not instructions to the orchestrator
or permission to change repositories, execute supplied commands, or bypass
governance. Approval must cover the acceptance obligations inside the plan's
execution contract, or references bound to immutable versions. A live GitHub
description cannot silently change approved scope.

Refresh source context before delivery and when resuming. Material changes lead
to clarification or the existing amendment process. Routine label changes and
status chatter need not invalidate approved work.

## 5. Compact plans for small work

Small issues take a compact form of the ordinary governed plan:

- Source and acceptance obligations.
- Brief current/desired behavior and approach.
- Material design decisions and exclusions.
- Delivery Budget and Surface Snapshot.
- One implementation phase with observable completion gate and checklist.
- Files touched and appropriate verification.
- Debt Claims only when a negative architecture row requires them.

A phase is a delivery unit, not a minimum duration. A small fix can occupy one
phase without being inflated into a multi-day project. Compactness depends on
uncertainty and risk as well as size. More investigation can be necessary for a
small persistence or authorization change.

Compact plans use the same schema, parser, reviewer, baseline, and amendment
rules. Save prose and repeated investigation; do not bypass planning or review.

## 6. Acceptance traceability

The governing plan maps source acceptance criteria to work items, phases, and
required evidence. The plan reviewer checks coverage and adequacy; implementation
review checks the resulting behavior against those obligations.

| Source | Criterion | Work / phase | Evidence required |
|---|---|---|---|
| owner/repo#42 | AC1: project override wins | W1 / Phase 1 | Precedence regression |
| owner/repo#47 | AC2: output shows effective value | W1, W2 / Phase 1 | CLI verification |

The map is separate from the Delivery Budget `Addresses` column, which names
review findings. Score deliverables, not issue count: one fix can satisfy multiple
issues, and one issue can require multiple work items. Tests remain part of the
work item they validate.

Checked boxes, author assertions, and a closing keyword in a PR do not constitute
acceptance evidence. New unrelated findings become follow-ups rather than
silently entering approved scope.

## 7. Assisted batching and later scanning

Explicit sets and proactive scans both feed intake. Candidate grouping uses
shared root causes, implementation surfaces, verification setup, dependencies,
and coherent delivery/rollback boundaries. Labels and similar filenames are
discovery signals, not sufficient evidence to batch work.

Each recommendation should explain the shared work, the expected saving versus
separate fixes, the acceptance obligations retained for each issue, and why nearby
issues were excluded. Bound package size and review surface; avoid holding a
simple fix behind uncertain unrelated work. Urgent work need not wait for a batch.

Do not append an issue to an approved package without scope review. Splitting,
rebatching, or resuming must retain decisions and stable work-item history rather
than manufacture a new budget baseline for the same work.

Start with ranked recommendations and operator selection. Scheduled scans and
bounded automatic admission are later policy features. Cross-repository discovery
can rank separate packages without requiring distributed execution.

## 8. Delivery and resolution

Conceptual milestones are triaged, planned, approved, implemented, awaiting merge,
delivered, and resolved. Waiting, blocked, aborted, and superseded outcomes remain
visible. These labels summarize evidence rather than granting authority.

Default code-resolution criteria are:

1. The issue's acceptance obligations are satisfied with evidence.
2. Applicable quality and review requirements are complete.
3. The reviewed work is merged into the recorded target branch.
4. Any issue-specific release or deployment condition is satisfied.

Partial implementations only reference their source issues. Closing references
are appropriate only when the entire issue is satisfied and the repository's
delivery policy permits merge-triggered closure. The MVP uses neutral references
and explicitly reconciles after merge, so refreshed issue context can be assessed
before closure.

Delivery reconciliation observes actual PR state, including squash merges, verifies
that the merged change corresponds to reviewed work, publishes acceptance evidence,
and verifies the final issue state. A human closing an issue independently does not
prove that this package delivered it. Closed-unmerged PRs, changed PR heads, reopened
issues, and accepted operating restrictions require explicit treatment.

Remote retries should discover existing objects before creating another PR or
resolution comment. Preserve remote identifiers and operation receipts. Report
`delivered; issue synchronization pending` when delivery succeeded but the remote
update did not. A timeout is an unknown outcome to reconcile, not automatic
permission to repeat a write.

### MVP durability boundary

Before delivery, Git owns the brief, plan, reviews, and sealed run history. The PR
contains a stable 5x marker, plan/run/review references, reviewed head information,
and criterion-by-criterion evidence. GitHub owns the observed merge/issue state and
a marked resolution comment. A later resume reconstructs delivery from those
remote facts and the linked Git evidence. Local absence of an active run is not
absence of a package.

This intentionally avoids appending to sealed implementation records or making a
post-merge documentation commit mandatory just to acknowledge closure. The MVP
offers single-orchestrator, check-before-write recovery, not distributed exactly-once
operations. A future package journal/CLI can bring remote receipts into git-native
history and add stronger coordination once operational experience justifies it.

## 9. Architecture and rollout

### Initial slice: explicit single issue

Ship an installed `5x-issue-resolution` skill, a bounded issue-intake author prompt,
brief/PR/closure formats, compact-plan guidance, and acceptance-coverage instructions
in relevant plan/implementation prompts. Compose existing skills and use `gh` for
GitHub. Include harness discovery, upgrades, overrides, mixed delegation, and
effective-rendered-asset acceptance.

### Follow-up: explicit sets and assisted batches

Add many-to-many issue coverage and package grouping after the single-issue path
has been exercised. Introduce structured package/issue commands only where they
remove demonstrated ambiguity or repetitive orchestration. Preserve existing
evidence when migrating the initial artifact convention.

### Later: unattended operation

Consider structured import/status/reconciliation commands, a narrow provider
adapter, package-level journals, ownership coordination, scheduled scanning, and
delivery monitoring. GitHub is the first provider; general adapters and additional
trackers are not prerequisites for the MVP.

Evaluate lead time, planning overhead for small work, review rework, blocked time,
reopened issues, and realized batching savings. Issue closure count alone is not
a useful success measure.

## 10. Defaults selected for the MVP

- One explicit GitHub issue in the current repository; one plan and one PR.
- Skill-first composition; existing 5x governance stays authoritative.
- Committed intake snapshot and brief, with acceptance copied into the plan contract.
- Compact ordinary plans; normal multi-phase planning if the issue needs it.
- Existing human and governance gates; no new unconditional approval ceremony.
- PR preparation/publication follows the user's authorization and repository policy;
  merge remains an external/operator action unless separately requested.
- Neutral issue references; fresh merge-aware verification before explicit closure.
- Pre-delivery history in Git; post-delivery observation/receipt in GitHub initially.
- Resume on demand; no scheduler, automatic merging, batches, or new package store.
