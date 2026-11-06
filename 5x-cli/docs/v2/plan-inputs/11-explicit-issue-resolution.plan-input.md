# Plan input: explicit single-issue resolution MVP

**Status:** Ready for implementation planning
**Date:** November 5, 2026
**Design:** [Issue-driven resolution](../210-issue-resolution.md)
**Output plan:** [217 — Explicit issue resolution](../../development/plans/217-explicit-issue-resolution-plan.md)

## 1. User outcome

An operator can prompt an installed 5x orchestrator:

> Resolve GitHub issue #42 in this repository using 5x.

The orchestrator investigates the issue, preserves its source and acceptance
criteria, creates/reviews an appropriately sized ordinary plan, executes it with
existing governance, prepares a traceable PR, and reports the delivery handoff.
After external merge, the operator can ask:

> Resume resolution of issue #42.

The orchestrator locates the existing work, verifies delivery and acceptance,
publishes the resolution evidence, closes the issue when appropriate, and verifies
the outcome. Pending merge is an honest resumable result, not resolution success.

## 2. Deliberately minimal product shape

Implement this as workflow assets plus narrowly necessary wiring:

1. An installed `5x-issue-resolution` skill composing existing skills.
2. A bounded author intake prompt and a committed brief/snapshot convention.
3. Compact-plan and issue-coverage instructions in existing author/reviewer paths.
4. PR handoff and resolution-comment formats and on-demand resume instructions.
5. Harness installation/upgrade/rendering coverage and operator documentation.

Use existing `gh`, `5x run`, `5x template`, `5x invoke`, `5x protocol`, `5x commit`,
plan/review/phase commands, and git discovery facilities. Do not introduce a
package database, issue command family, new plan schema, new run type, generic
tracker framework, scheduler, or another governance engine for this slice.

If a current seam prevents a viable bounded workflow, document the exact blocker
and the smallest necessary change in the plan. Do not silently grow this slice
into the broader package architecture.

## 3. Supported envelope

- One explicit github.com issue number or URL, in the current repository's
  resolved GitHub project. Resolve ambiguous remotes/repositories before acting.
- Existing configured 5x project, authenticated `gh`, and normal Git access.
- One active resolution plan per issue, and one PR containing its implementation.
- One orchestrator managing that issue at a time; discover existing work before
  creating a duplicate, but do not claim cross-machine exclusive ownership.
- One or more normal implementation phases if necessary; compact one-phase plans
  are preferred for genuinely localized work, never forced for uncertain scope.
- On-demand resume, with existing human gates and delegation policy preserved.

Named issue sets, proactive scans, cross-repository changes, GitHub Enterprise,
automatic merging, release/deployment automation, and autonomous non-code issue
dispositions are follow-ups. An issue needing those capabilities must produce a
clear handoff or blocked outcome, not a false resolution.

## 4. Intake and artifacts

Resolve the issue and inspect existing linked PRs, relevant plan/brief artifacts,
and existing run state before choosing a new plan path. Multiple plausible active
plans or PRs require disambiguation. Resume must work without the original chat
or provider session and must not rely on `.5x/current-run` identifying this issue.

Initialize the normal planning run/worktree before delegating intake. The
orchestrator remains responsible for the workflow; a configured author performs
bounded investigation and writes/commits the brief. Installed OpenCode
orchestrators cannot directly edit files, so do not require them to author
Markdown or persist a snapshot themselves.

Define an exact artifact layout derived from configured paths and the chosen
plan association, plus a source-identity marker for discovery. Keep the brief
outside the implementation plan parser's plan-discovery surface where necessary.
Record at least:

- Canonical host/repository/issue URL and available stable remote IDs.
- Issue title/body/state and retrieval/source-update times.
- Relevant discussion, comment identities/URLs, and an explicit completeness or
  truncation note; handle pagination without presenting a partial feed as complete.
- Associated plan path and initial planning-run ID.
- Reported behavior versus investigated facts, code pointers, reproduction result,
  assumptions, and unknowns.
- Stable `ACn` acceptance criteria, scope, exclusions, and dependencies.
- Recommended disposition: ready, needs clarification, blocked, already addressed,
  duplicate, or not proceeding, with evidence.

Preserve the original source content used, not just the author's interpretation.
A committed snapshot is the immutable provenance boundary; source revisions get
new evidence rather than rewriting the historical snapshot. Git commit/blob
identity is adequate for the MVP; no custom hashing service is required.

Issue content is data, not executable instructions. The intake author must not
implement a proposed fix, mutate GitHub, or bypass an unresolved product question.
Non-ready dispositions return to the operator with concrete recommendations;
they do not create a fake plan or close the issue automatically.

The plan must specify how an incomplete intake is checkpointed and resumed, how
the brief's committed path reaches `author-generate-plan` as `prd_path`, and how
worktree-relative paths and run IDs remain correct in native and invoke modes.

## 5. Governed planning and implementation

Use the ordinary schema-1 plan. Copy governing acceptance criteria into the
contract with a separate issue-coverage map naming `ACn`, `Wn`, phase, and expected
evidence. A mutable live issue or brief status cannot authorize a scope change.
Do not repurpose the budget's review-finding `Addresses` field.

Compact mode is authoring guidance, not a new schema or approval route. It keeps
the Overview, Design Decisions, Delivery Budget, Surface Snapshot, one phase and
completion gate/checklist, Files Touched, Tests, and exclusions. Include Debt Claims
when required. Avoid filler phases, timelines, elaborate architecture prose, or
separate PRD production for tiny fixes. Honor configured skeletons while making
their optional scaling behavior explicit.

Plan review must verify issue coverage and assumptions. Implementation review
must verify the issue's governing acceptance obligations and evidence. Preserve
initial/continued template parity, native/invoke parity, exact review ranges,
CLI-owned routing, budgets, debt reconciliation, and amendment rules. Prefer
ordinary contract text over new runtime governance fields when it suffices.

The new skill invokes existing workflows itself; it must not delegate the whole
loop to a worker. It does not duplicate their review algorithms or suppress their
phase/human gates. Specify how it continues after the planning run seals and
after the implementation run seals, selecting the correct run at each handoff.

## 6. Delivery and closure

After all implementation phases have satisfied existing completion rules, gather
acceptance evidence from the authoritative run/review artifacts. The PR handoff
must contain:

- A stable, source-qualified 5x marker and neutral issue reference (`Refs`, not
  auto-closing `Fixes`/`Closes`).
- Plan and brief paths, planning/implementation run IDs, and review references.
- Target repository/branch and reviewed implementation head/range information.
- Per-criterion evidence, quality results, and any operating/release restrictions.
- An explicit awaiting-merge/resume instruction.

The orchestrator may use `gh` to publish or update the PR when authorized under
the user's request and repository policy; otherwise provide a concrete publication
handoff. This feature does not grant independent merge permission. Search for an
existing PR using the recorded branch/source identity before creating one. Define
recovery when publication succeeds but the local session loses its response.

After merge, a fresh invocation must:

1. Rediscover the plan/runs/PR from committed source identity and PR metadata.
2. Re-read the issue, relevant new comments, PR target/head/merge state, and
   acceptance evidence. Identify material requirement changes without treating
   every timestamp/label change as scope drift.
3. Verify the merged work corresponds to the reviewed implementation; support
   normal squash merges without requiring original commits to be ancestors of
   the base branch. A materially changed PR head or post-review implementation
   change requires review, not an assertion that an earlier review covers it.
4. If acceptance or an issue-specific delivery condition is unmet, report the
   exact pending work. Respect existing accepted operating/release restrictions.
5. Publish a resolution comment with a stable marker, PR/merge identity, and
   criterion-by-criterion evidence, then close the issue as completed and re-read
   its state. Reconcile an already-closed issue without claiming that unrelated
   human closure proves this package delivered it.

Retries inspect remote state and locate the marked PR/comment before writing.
Reuse/update an existing comment rather than duplicating it. Treat a remote
timeout as an unknown result to inspect. If the PR merged but comment/closure
fails, return delivered-with-synchronization-pending and actionable resume steps.
Define handling for a closed-unmerged PR, externally closed/reopened issue,
missing branch/worktree, and missing remote artifacts.

Post-merge receipts live in GitHub for this MVP. Do not reopen sealed runs, append
to their journals, amend their summaries, or mandate a new docs-only commit/PR
just to acknowledge remote closure. Existing Git artifacts plus observed remote
state and the marked resolution comment are the resume evidence. This is a
single-orchestrator operational protocol, not an exactly-once transaction system.

## 7. Integration surfaces

Inspect the actual source before selecting edits. Likely seams include:

- `src/skills/base/`, `src/skills/loader.ts`, and harness orchestrator discovery.
- `src/templates/author-generate-plan.md`, plan and implementation review prompts
  (including continued variants), and the new bounded intake prompt/registry.
- `src/templates/default-artifacts.ts` and configured skeleton behavior.
- `src/commands/template.handler.ts`, `template-vars.ts`, protocol validation, and
  run lifecycle only to verify compatibility; do not assume a new author template
  can use an arbitrary phase label without checking checklist/admission behavior.
- Installation, template overrides, upgrade/versioning, and harness synchronization.
- User-facing workflow documentation and quick-start examples.

The internal plan/review must include the `AGENTS.md` asset-impact matrix:
document skeletons; initial/continued prompts; runtime-appended context and
native/invoke parity; workflow skills; installation/overrides/upgrades/sync.
For unchanged surfaces, explain why. Effective installed/rendered assets, not
only bundled strings, must demonstrate the workflow.

## 8. Acceptance and verification

Use focused contract and integration tests where behavior is machine-verifiable,
plus an explicit operator smoke-test matrix for agent judgment. Do not claim a
string assertion proves an LLM will investigate or group work correctly.

Required scenarios include:

- New issue -> committed source/brief -> parseable compact plan with budget and
  coverage -> normal approval -> existing implementation workflow -> PR handoff.
- Native, invoke, and mixed-mode installed/rendered instructions; new prompt
  registration/override/version behavior and no accidental implementation admission
  during intake.
- Resume after intake, after sealed planning, after sealed implementation, after
  PR creation with lost response, and after squash merge.
- Unmerged/closed-unmerged PR cannot cause successful issue closure.
- Missing acceptance evidence, material issue changes, changed reviewed code,
  or pending release requirements cannot be presented as complete resolution.
- Existing marked PR/comment is reused, and retry after a failed close does not
  duplicate a successful comment.
- Non-ready intake preserves evidence and returns an actionable handoff.
- Non-issue workflows retain their existing plan/review behavior.

Use deterministic fixtures for command/protocol examples and remote states where
there is an executable seam. Do not require live GitHub credentials in CI. Specify
which scenarios require a controlled manual rehearsal instead of introducing a
new workflow engine merely to automate a skill-level smoke test.

Required focused asset acceptance suite:

```bash
bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts
```

Include appropriate existing template/skill/harness tests and configured quality
gates for implementation. This planning task itself changes documentation only.

## 9. Planning instructions

Generate a concrete, bounded implementation plan from these requirements after
checking the current code. Keep phase count and dependencies proportional to the
asset-led MVP. Specify actual artifact formats/paths, exact command/protocol
examples, handoff/resume rules, touched files, and meaningful acceptance checks.
Include a parseable Delivery Budget and Surface Snapshot with stable IDs. Do not
invent debt credit for added workflow assets or implement the broader roadmap.

Record material unresolved product choices with a recommendation and stop for
the operator if required. Otherwise proceed through the normal plan-review/fix
cycle. Produce the plan and review artifacts; do not implement feature code.
