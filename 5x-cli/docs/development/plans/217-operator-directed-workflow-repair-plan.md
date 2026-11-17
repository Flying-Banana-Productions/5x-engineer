<!-- 5x:plan-schema:1 -->

**Version:** 1.1
**Created:** November 6, 2026
**Status:** Implemented — pending final review

<!-- 5x:contract:start -->

# Operator-Directed Workflow Repair and Executable Plan Validation

## Executive Summary

Make ordinary workflow defects recoverable without abandoning a run, repeating valid work, or asking an operator to approve the same intent repeatedly. The motivating incident is Player Desk plan 568: an approved plan had no executable checklists, adding checkbox markers caused approved-plan drift, final corrections left an inconsistent approval ledger, and a later review returned a human-gate route with no actionable gate.

The primary success criterion is operator authority: **when the operator says “this is a silly reason to block progress; fix it and move on,” the orchestrator can perform a narrowly scoped repair, record what was authorized, and resume the same run.** Mechanical repair does not require an artificial reviewer finding, an already-open gate, a new plan review, or a new execution run. Checks should help the workflow repair itself. They must not turn presentation mistakes into permanent barriers.

Ship the recovery mechanism before enabling additional enforcement. Preserve implementation evidence for unchanged requirements. Continue to distinguish repairing bookkeeping from asserting that work was performed; the operator's repair instruction is sufficient authority for the former and does not need to be represented as a fictional implementation approval.

## Overview

### Verified incident and current behavior

Verification used the Player Desk committed plan/review/run artifacts, current 5x source, and direct in-memory calls to parsing, ledger comparison, drift detection, and implementation-review validation. Historical CLI error strings and operator-chat exchanges were not independently recovered; keep those attributed to the postmortem.

| ID | Verified finding | Evidence / current seam |
|---|---|---|
| F1 | Approved v1.0 and v1.1 contain no checkboxes; all three phases parse as incomplete with zero items. Execution was bound to v1.1. | Player Desk commits `6efe9844`, `007a61f2`, and execution binding to `2c16d48302effccebb93f828f7e27b2785cc215c`; `src/parsers/plan.ts:140–157`, `src/review-governance/implementation-state.ts:1810–1860`. |
| F2 | The repair changed only 21 bullet prefixes: eight checked in Phase 1, nine unchecked in Phase 2, four unchecked in Phase 3. The parser counts top-level items as 5/6/4. Marker introduction is drift; toggling existing markers is not. | Player Desk `5c2a87b3`; reproduced with schema 1 and the correct governing hash through `detectPlanDrift`, `src/review-governance/implementation-state.ts:246–334`. |
| F3 | Final corrections changed W2's `Addresses` from empty to `P1.1`, but the approving review snapshot retained the earlier ledger. Current ledger identity includes `addresses`, so those ledgers differ. | `run_1ed73f724527/budget.jsonl` snapshot `8e48572d-ce2e-4461-b225-eaaec0ef750a`, commit `007a61f2`; `implementation-state.ts:1084–1100, 1234–1251, 1719–1725, 1871–1891`. Wrong byte capture is not established. |
| F4 | A continued structural `plan_defect` already passes runtime validation without a code hunk and routes to `plan_amendment`. The instructions nevertheless describe new ordinary blockers too broadly, and the prepared code context excludes the plan. | Direct `validateImplementationReview` reproduction; `src/review-governance/code-diff.ts:879–934`; `src/templates/reviewer-commit-continued.md:33, 56–65`. The historical failure to express the defect is recorded in the review addendum, not a reproduced universal protocol prohibition. |
| F5 | Observation `d90937a1-68c0-4245-9dfb-d485088c22cf` records `not_ready`, no findings, `human_gate`, and no gate causes. The durable stream has no corresponding actionable gate. | `run_9d62a2f1fdb9/budget.jsonl`; `src/review-governance/implementation.ts:525–539`, `src/commands/implementation-review-context.ts:721–729, 868–899`, `src/review-governance/store.ts:568–572`. |
| F6 | Checkboxes are already required by the current author prompt and included in the bundled skeleton. Enforcement and configured-template consistency are missing. | `src/templates/author-generate-plan.md:32–34`, `src/templates/default-artifacts.ts:109–132`; the repository's configured `docs/_implementation_plan_template.md` has weaker per-phase guidance. |
| F7 | Execution guidance lacks a nonempty-checklist preflight and its completion example reads the wrong JSON path and identifier. | `src/skills/base/5x-phase-execution/SKILL.tmpl.md:245–248, 714–724` uses `.phases[].number`; `src/commands/plan-v1.handler.ts:463–477` emits `.data.phases[].id`. |

The initial implementation review and quality successes are recorded facts, not a fresh re-execution of Player Desk tests. The execution run was aborted and sealed at `6078d4e4`; this project must not reopen or mutate it as a test fixture. Plan v1.2 and its fresh-execution policy remain that project's decision.

### Prerequisites and scope

Build on the integrated implementations behind [plan 215](./215-implementation-plan-amendment-plan.md) and [plan 216](./216-plan-schema-contracts-and-migration-plan.md). Reuse the canonical effective-plan lineage, expected-schema readers, paired RecordStore append, Git blob verification, and existing gate/decision machinery. Code pointers above describe the inspected tree; re-anchor them during implementation.

In scope: checklist diagnostics and repair; exact final-corrections approval consistency; truthful plan-defect review context; actionable gate routing; workflow guidance; replay and end-to-end regression coverage. The affected external project is evidence, not an implementation target.

**Integration baseline.** This plan is integrated against main `6982a024`, which includes the issue-resolution merge `3387c4cc`. That merge adds an affected consumer, not a new dependency or policy: the `5x-issue-resolution` skill seals a planning run (Step 2), binds a separate implementation run with `--source-run $PLAN_RUN` (Step 3), and derives delivery identity from the binding's `approvedPlanCommit`, sealed `FINAL`, and settled review/correction evidence through its `accepted-intervals` and `classify-delivery` recipes (Step 5). Issue plans may use compact mode and carry a governing `## Issue Coverage` section pinned to a `Source brief` commit. The repair and finalization behavior in this plan must work through those handoffs and preserve that contract; it does not redesign issue intake, delivery, or GitHub closure policy.

## Design Decisions

### 1. Repair first; enforcement is not the product

Distinguish three conditions:

| Condition | Default workflow behavior | Operator involvement |
|---|---|---|
| Unapproved draft with a deterministic checklist repair | Author repairs inline, then normal review continues. No failed review iteration is consumed. | Existing authorization to author the plan is sufficient. |
| Approved plan with a wording-preserving checklist repair | Orchestrator previews the change, records the operator's repair instruction, applies the mechanical repair, and resumes. | One authorization for the presented repair; already-given explicit authorization is reusable within that scope. |
| Actual requirement/design/budget change or an ambiguous repair | State exactly what would change and route to the existing scoped semantic-amendment process. | A genuine scope decision; do not describe this as an automatic formatting repair. |

Machine-readable diagnostics include the phase/line, whether a deterministic repair is available, and executable next commands with run/path selectors filled in. Do not require users to type hashes, reconstruct journal keys, close a run, change governance mode, or manufacture review findings to fix formatting. The CLI handles identity and concurrency checks. A stale candidate is re-previewed; unchanged intent and unchanged proposed edits do not require asking the same question again.

`plan phases`, run state, and repair previews remain usable on a structurally non-executable plan. Presentation differences that still yield valid executable items are not errors. Plain prose completion gates remain supported; a prose paragraph is not required to become a checkbox. Ordinary explanatory bullets are not lint failures.

### 2. A small, proactive mechanical repair command

Proposed API, not currently shipped:

```bash
5x plan repair-checklists --plan <path> --dry-run
5x plan repair-checklists --plan <path> --apply
5x plan repair-checklists --run <id> --dry-run
5x plan repair-checklists --run <id> --apply --reason "Operator authorized checklist-format repair and continuation"
```

The file form applies to unapproved drafts and writes only the selected plan. The run form resolves the canonical mapped plan and supports active bound execution and completed plan-review sources before binding. It is callable while ordinary admission would report drift or missing checklist structure, and when no review gate exists. An existing binding must be repaired on its execution run; later source repairs cannot silently change that binding. The orchestrator captures chat authorization through the native UI; `--reason` records that instruction, not an invented claim of consent. No separate approval subprocess or mandatory second confirmation is introduced.

Preview reports exact before/after edits, affected phases, preserved evidence, and remaining work. The deterministic candidate converts plain list markers in explicitly identified completion-gate lists to recognized unchecked markers. Support the common gate headings already used in plans, ordered or unordered lists, and nested child bullets while keeping top-level parser counting explicit. An ambiguous section can be selected by explicit phase/line scope rather than guessed; missing requirements or missing phase headings need author work. Recognized existing task markers retain their state. For an already edited candidate, verify the proposed changes against the effective approved anchor, not against its own current text.

The proof allows only the selected list-prefix changes and existing checkbox-state normalization. Preserve requirement text, nesting, list order, phase identity, headings, budget/debt contracts, schema, and unrelated governing bytes. Newly introduced boxes are unchecked. A candidate introducing checked boxes is reported and normalized to unchecked with that change visible in the preview. Existing code review and quality evidence remains applicable to identical obligations; the author can check the new boxes after matching them to that evidence, without rerunning unchanged code review or quality just because markers changed. An interrupted finish resumes at the missing checkpoint.

Use one new versioned `plan-checklist-repair` lineage kind, plus its paired step, rather than forging a text guard, reviewer snapshot, semantic amendment assessment, or legacy frontier recovery. Record the subject run/binding, predecessor, raw before/after blob hashes and commits, governing hash where applicable, selected prefix-edit map, authority/rationale, and deterministic intent identity. Replay rechecks the mechanical proof. Extend existing lineage unions, fold/readers, store decoding, and index hydration; preserve immutable original binding and source approval. A repair updates the authorized plan anchor but does not invalidate unchanged code observations, due-claim evidence, or completed phases. It does not mark a phase complete or resolve an unrelated finding.

The approved-run form prepares a plan-only commit and pairs the receipt/step using existing serialization and atomic append. Re-prove the committed blob after hooks. A crash after the commit but before recording is resumable against that exact commit; identical retry returns the existing receipt. Concurrent substantive edits yield a new preview, not a partial or duplicated authority change. Unrelated dirty files are neither staged nor overwritten. No new database or lock system is needed. Historical readers are unchanged; document that repaired runs require a CLI that understands the new lineage kind.

### 3. One shared executability result, separate from progress inspection

Add a pure validation result over `readAuthoritativePlan` and the existing phase parser. It identifies no phases, ambiguous phase IDs, and phases with no executable checklist items. Report suspicious plain-bullet gate sections as repair candidates; when a phase otherwise has executable items, this is a warning rather than a blanket rejection of prose. Reuse the same result at pre-review preparation/recording, approval finalization, initial implementation admission, and pre-author/resume checks, including non-budgeted paths. Budget mode must not determine whether a phase can be completed mechanically.

Read only governing content under the recorded schema. Fence examples, notes, comments, and content outside a schema 1 contract cannot satisfy the check. Share any necessary fence/comment filtering with phase parsing rather than introducing a second parser with different counts. Preserve supported list/subheading syntax and legacy display behavior; zero items must not become executable merely because a heading says COMPLETE.

Expose additive validity/diagnostic information from `plan phases`; do not make normal inspection fail solely because a checklist is empty. Approval or author delegation returns the existing repair-required style of result with a ready-to-use repair path. Draft defects route to the author before spending a reviewer invocation. Later detections use the approved repair command. Repair commands and state inspection bypass the new admission precondition so the check cannot block its own recovery. Ship this enforcement only after Phase 1's recovery works.

### 4. Final-corrections approval must describe the final committed ledger

The normal one-pass `final_corrections` route remains one pass. At plan-run finalization, resolve the actual final plan commit, validate executability, parse its authoritative ledger, and reconcile that ledger against the recorded reviewer route, admitted corrections, and decisions. Specifically allow correction bookkeeping that adds an admitted finding ID to `Addresses`; source line numbers, titles, and rationale are not ledger identity. Reuse the existing route's permitted correction/budget policy instead of inventing a stricter general review requirement.

Persist one `plan-approval-finalization` budget-stream record paired with the completion boundary, binding the source snapshot, recorded author correction, decisions, final commit/raw hash, schema/governing hash, and effective ledger. Bind consumes this anchor; it does not combine a corrected commit with the stale pre-correction ledger. Keep the original reviewer snapshot immutable and do not label this mechanical finalization as a new reviewer verdict. Ordinary ready approvals can use the same anchor.

If a correction changes budget/claim/scope beyond the already authorized route, leave the run open and return the existing same-run review/amendment next action with the exact changed fields. Do not seal an unusable approval or demand a new run. A working-tree blob or a later HEAD cannot substitute for the recorded committed blob. Source-level finalization must not relax exact-hash reassessment for semantic amendments inside an execution run.

Legacy completed sources without this record keep the old path when consistent. For the specific stale-Addresses case, derive the corrected effective ledger from the sealed commit only when recorded final-corrections/author evidence and the same reconciliation proof establish it; include the derivation provenance on the new binding. Do not mutate or reopen the sealed source. Unsupported historical deltas get an actionable exact-plan re-review path rather than silent acceptance.

### 5. A gate is a decision the user can actually take

For enforced plan and implementation governance, an emitted `human_gate` must be backed by durable actionable causes, a stable gate identity, and choices discoverable by `review gate show`. Validate that relationship at composition/persistence and returned-state boundaries; derive gates through the shared store rather than adding a second gate database. Preserve advisory/off compatibility routing, explicitly distinguish it from enforced durable-gate instructions, and do not add mandatory human gates there.

An unexplained negative verdict with no findings and no independent gate cause is a response-repair problem. Return a precise diagnostic to the reviewer/orchestrator before recording an actionable observation, asking for either a real finding or corrected readiness. Do not turn it into a fabricated issue or an empty human gate. Use the existing bounded output-correction retry policy; a formatting retry does not restart implementation or rerun quality.

For historical gate-less observations, state/gate inspection reports the inconsistency and supplies the commands to repair any plan drift first and then record a corrected review in the same run. The recovery must be callable without a nonexistent gate decision. Preserve the old observation as audit history; a valid later observation supersedes its routing through existing review semantics. Re-review is required only to resolve that unexplained verdict, not by the checklist repair itself. Every genuine human-gate branch is tested through display, decision, successor routing, and replay. If an internal invariant still fails, return a workflow-repair diagnostic with a viable next action rather than claiming the operator can approve an absent gate.

### 6. Plan evidence is not code-hunk evidence

Keep the existing `plan_defect` class and `plan-structure` boundary; do not add a duplicate classification. Clarify that the ordinary-code hunk requirement applies to implementation defects. Provide runtime-owned plan evidence alongside the code range: effective approved plan identity/hash, relevant governing phase/gate text and locations, and a plan-only diff when present. A defect present in the approved plan can cite that anchored text and the shared structural diagnostic; it need not pretend to have been introduced by the latest code commit. Preserve existing accepted plan-impact representations; add evidence validation without making every old valid finding use a new mandatory field.

Both native template rendering and invoke use the same context. Continued and fresh sessions receive the same plan authority. Keep plan-only changes out of code-diff freshness and code evidence; do not broaden the code review range simply to make a plan hunk available. A mechanical repair may start directly from operator intent or a structural diagnostic without first obtaining a reviewer finding. Real semantic plan defects retain the existing scoped amendment process.

### 7. Issue-resolution consumers see repairs as evidence, not new approvals

The `plan-checklist-repair` and `plan-approval-finalization` records, and their plan/record-only commits, are evidence for the issue workflow's delivery recipes, not reviewed endpoints. A repair receipt does not replace a settled review observation or an exact proof-bound correction, does not change the binding's `approvedPlanCommit` used as delivery `BASE`, and is not phase acceptance, acceptance-criterion evidence, or authority to publish or close an issue. Finalization feeds the binding through the existing explicit `--source-run` handoff. Source repairs before binding happen on the completed planning run; repairs after binding happen on the implementation run; neither reopens the sealed planning run or moves a binding back to it. Already-given operator authorization and settled evidence carry across that handoff without another issue-level approval, intake, association, or review.

Repair and executability checks keep the issue-plan contract intact. A valid compact plan (one phase, prose completion gate, executable checklist, stable `W1`, valid budget) passes as written, with no filler phases, timeline, or full-skeleton expansion. The prefix proof already protects unrelated governing bytes. Acceptance makes the issue-specific invariants explicit: the `Source brief` line, verbatim `ACn` rows and their mappings, carried assumptions, and the brief's `source/` snapshots survive repair and finalization, and `ACn` IDs never enter `Addresses`. No Issue Coverage parser or runtime gate is added. Change the delivery recipes only if the regressions below expose a concrete incompatibility, and never widen accepted ranges or evidence exclusions to make a repair pass.

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Proactive mechanical checklist repair and replayable evidence-preserving lineage | 5 | 2 | - | - | One command and one narrow durable lineage kind extending existing Git/RecordStore seams; includes preview, proof, authorization, interrupted-commit recovery, concurrency, and evidence-carry tests. |
| W2 | Shared executability diagnostics and repair-first boundary integration | 3 | 1 | - | - | One shared validation result across parser/authority, CLI inspection, review, admission and completion callers; includes compatibility and false-positive tests. |
| W3 | Final committed approval/ledger reconciliation | 5 | 1 | - | - | One finalization record extending existing completion/binding provenance, including sealed-source compatibility, final-corrections lifecycle and exact-blob tests. |
| W4 | Actionable gate invariant and truthful plan-defect evidence | 3 | 0 | - | - | Repairs existing routing/composition/projection and review context; preserves current finding taxonomy and includes historical-recovery and native/invoke parity tests. |
| W5 | Effective workflow assets and integrated low-friction acceptance | 5 | 0 | - | R1, R2 | Updates shipped/configured skeletons, prompt variants and skills, then verifies installation/override behavior and the complete incident lifecycle; tests are included here and in W1–W4, not scored separately. Effort rises 3 → 5 for the post-merge integration only: +1 (R1) corrects the asset inventory to the real revision and continued plan-review prompts plus the issue-resolution skill's Steps 2/3 handoff, with compact-plan and Issue Coverage preservation acceptance; +1 (R2) adds issue delivery-recipe and closure regressions for the new receipts. Architecture stays 0: no new boundary, record kind, parser, gate, or recipe redesign. |

No debt credit is claimed. The new durable kinds are deliberately limited to mechanical repair and final approval provenance; they reuse the existing journal and index boundaries.

### Surface Snapshot

- Subsystems: 5
- Production files: 40
- Persistent/external boundaries: 2

The subsystems are plan parsing/authority, CLI boundaries, review/approval governance, record projection, and workflow assets (which include the issue-resolution skill). The boundaries are the existing Git object/history boundary and RecordStore JSONL persistence with its derived SQLite index; the issue workflow's GitHub publication path is exercised only through its existing stub-`gh` tests and is not changed. The production inventory below counts 25 existing TypeScript modules, 3 proposed focused modules, and 12 shipped Markdown prompt/skill assets (8 prompts, 4 skills). The integration revision removed the nonexistent `author-revise-plan.md` and added `author-process-plan-review.md`, `reviewer-plan-continued.md`, and `5x-issue-resolution/SKILL.tmpl.md`, a net change of +2. The configured repository skeleton and tests are additional. No external service, new SQLite table, parallel workflow engine, or generic override framework is planned.

## Phase 1: Operator-authorized mechanical repair (W1)

**Completion gate:** An already admitted malformed plan can be repaired on the same run after one operator instruction, with no reviewer invocation or preexisting gate required, and unchanged evidence remains usable.

- [x] Implement a pure candidate/proof module for selected completion-gate list prefixes, preserving wording, phase identity, budget, schema and unrelated governing content; cover nested lists, ordered markers, mixed valid/invalid lists, ambiguous selections, non-ASCII text and line endings.
- [x] Add `plan repair-checklists` preview/apply forms for unapproved files, completed approval sources and active bound runs. Resolve canonical worktree paths; detect an approved subject when the file form is used and return its run-aware command rather than bypassing authority.
- [x] Add `plan-checklist-repair` decoding, paired receipt, idempotency and effective-lineage integration. Bind and later semantic/text amendments accept the repaired anchor while retaining the original source, policy, ledger and run identity.
- [x] Make the command accessible through missing-checklist and ordinary drift failures. Preview a manually introduced checked marker as a proposed reset to unchecked; do not erase existing recognized checkbox progress or unrelated edits.
- [x] Reuse plan-only commit and atomic-append seams, including hook-changed bytes, interrupted prepare/record, identical retry, concurrent edit and index-rebuild coverage. A failed proof has no new authority or overwritten user work.
- [x] Demonstrate that a pure prefix repair preserves valid quality/review/debt evidence and completed phases, leaves unrelated open findings intact, and permits checking newly introduced boxes against already-recorded evidence without a redundant review or quality cycle.

## Phase 2: Early diagnostics that lead directly to repair (W2)

**Completion gate:** The zero-checklist plan is detected before review/delegation, but inspection and its repair remain usable and ordinary valid prose/list formatting is accepted.

- [x] Add shared executability diagnostics over authoritative phase parsing, including no phases, duplicate IDs and zero-item phases, with precise locations and deterministic-repair availability.
- [x] Ensure fences, notes, comments and outside-contract examples cannot satisfy executability; keep parser counts and validation aligned and preserve currently supported executable marker forms.
- [x] Add nonblocking validity/repair information to `plan phases` and correct its help example's field names. Do not break inspection or historical progress reporting simply because a phase has zero items.
- [x] Integrate repair-first checks before plan reviewer preparation/recording and implementation author admission/resume, and reuse them at finalization/completion. Cover enforced, advisory, off and non-budgeted flows without making recovery depend on budget mode.
- [x] Automatically route deterministic unapproved-draft repairs to the author without a human gate or consumed reviewer iteration. For approved plans, return the exact Phase 1 repair command and preserve the active run.
- [x] Test the original three-phase fixture, a zero-item COMPLETE heading, nested-only items, ordinary explanatory bullets, prose completion gates, valid checkboxes, and schema 0/1 authority. Every new blocking diagnostic has a tested successful recovery path.

## Phase 3: Consistent final-corrections approval (W3)

**Completion gate:** The incident's final-corrections change to W2's `Addresses` binds successfully from the completed approval without an extra review, while unapproved substantive changes remain visible and recoverable in the same run.

- [x] Add final committed-plan reconciliation using existing final-corrections eligibility and decisions. Accept admitted `Addresses` bookkeeping and ignore nonidentity parse positions/rationale without accepting unrelated ledger or claim changes.
- [x] Pair a `plan-approval-finalization` record with plan-run completion, anchored to committed bytes and the effective ledger; consume it in source selection/binding and preserve the original snapshot.
- [x] Keep unsupported substantive corrections in the active plan run with concrete same-run review instructions; do not seal a source that admission will reject for a known mismatch.
- [x] Preserve exact-hash reassessment for semantic amendments in active executions. Cover working-tree/commit mismatch, hook rewrites, later unrelated HEAD, status/note edits, retries and restart.
- [x] Support consistent legacy sources unchanged and deterministically reconcile the documented stale-Addresses legacy case from sealed evidence, recording provenance in the new binding without rewriting the source journal.
- [x] Add a lifecycle regression from initial `ready_with_corrections` through author correction, completion and admission; assert the final committed blob/hash and ledger agree and that ordinary authorized corrections invoke no second reviewer.

## Phase 4: Truthful review evidence and actionable routing (W4)

**Completion gate:** A structural plan defect can be stated truthfully, and no enforced `human_gate` response leaves the operator without an actual gate and supported decision.

- [x] Validate route/cause/gate consistency at composition, paired persistence and readback in plan and implementation review. Keep store and SQLite projection behavior aligned, including successor decisions and restart.
- [x] Treat empty unexplained negative verdicts as correctable structured-output failures, not implementation failure or fictional human decisions. Supply actionable reviewer retry guidance and test that no empty gate/approval observation is appended.
- [x] Detect historical gate-less observations in state/gate display and expose a same-run corrective-review path, accessible without a nonexistent decision and after the direct mechanical repair when drift also exists.
- [x] Append anchored governing plan sections/diagnostics and optional plan-only diffs to implementation review context, using the same runtime builder for native/invoke and initial/continued sessions.
- [x] Preserve acceptance of structural `plan_defect` findings without code hunks; test unchanged-approved-plan defects, plan-only changes, incorrect anchors, existing finding formats and ordinary code blockers that still need code evidence.
- [x] Exercise every enforced human route through `review gate show`, an eligible decision, returned next action and journal replay; verify advisory/off routing does not gain mandatory durable approvals.

## Phase 5: Workflow assets and low-friction lifecycle acceptance (W5)

**Completion gate:** Installed workflows, including the issue-resolution workflow, can honor “fix the checklist and continue,” with one operator authorization, the same run, no unnecessary reviewer/quality loop and truthful remaining-work reporting. Mechanical repair and finalization records preserve the issue-plan contract and issue delivery identity without becoming approvals.

- [x] Update bundled and configured skeleton guidance, `author-generate-plan.md`, the revision/final-corrections prompt `author-process-plan-review.md`, and the plan reviewer prompts `reviewer-plan.md` and `reviewer-plan-continued.md`, plus the implementation prompts in the asset matrix, to use executable checklists, early repair and correctly scoped plan/code evidence rules. Make only the guidance changes these surfaces need; record any surface left unchanged as unaffected, with the reason.
- [x] Update planning/review/execution skills for author-side draft repair and operator-authorized approved repair. Fix completion queries to `.data.phases[] | select(.id == ...)`; treat a missing selection as a diagnostic rather than proof of completion.
- [x] Assess `5x-issue-resolution` Steps 2 and 3. Add guidance only where the delegated `5x-plan`/`5x-plan-review`/`5x-phase-execution` behavior does not already carry repair through. Exercise finalization or source repair on the completed `$PLAN_RUN`, followed by an explicit `bind --source-run $PLAN_RUN`, and an active execution repair on the same `$IMPL_RUN`. Reuse the already-given authorization and evidence. Do not repeat planning, intake, or association, reopen the sealed planning run, move the binding, or add an issue-level approval.
- [x] Add compact issue-plan acceptance using `test/fixtures/issue-resolution/compact-plan.md` unchanged and effective renders of the generation and revision prompts. Executability accepts the fixture's one phase, prose gate and executable items without filler phases, a timeline, or skeleton expansion. If the fixture's task markers are removed, the existing draft repair still applies. Repair and finalization preserve the pinned `Source brief` line, verbatim `ACn` rows and mappings, carried assumptions and `source/` snapshots, and keep review-finding IDs alone in `Addresses`.
- [x] Add issue delivery-identity regressions in `test/integration/issue-resolution-recipes.test.ts`, extending `test/helpers/issue-delivery-fixtures.ts` only as needed. Run the shipped `accepted-intervals` and `classify-delivery` recipes over codec-valid `plan-checklist-repair` and `plan-approval-finalization` records and their plan/record-only commits. Cover three cases: an ordinary settled review carried across a mechanical repair, an exact proof-bound correction carried across a repair, and finalization-to-binding provenance where `BASE` is the binding's `approvedPlanCommit`. Assert that the original accepted code endpoints are unchanged, receipt commits classify as evidence only, no extra reviewer/quality invocation or replacement run occurs, and `delivery: ok` proceeds to the existing stub-`gh` reconciliation path.
- [x] Add a negative companion in the same suite. Unsettled or uncovered code beside a valid repair receipt still fails delivery and produces no success comment or close. Existing pre-admission, inter-phase, revert, prepared-only, malformed, missing-endpoint and divergent-ancestry rejections still pass. Change recipe text only if these cases expose a concrete incompatibility, and never widen ranges or exclusions or add a receipt-based approval or closure rule.
- [x] Carry an already-explicit operator repair instruction into the command; ask only when scope is genuinely ambiguous or expands. After successful repair, resume the interrupted checkpoint rather than requesting the same permission again.
- [x] Implement the asset-impact matrix below across native/invoke, fresh/continued sessions and configured template overrides. Inspect effective installed/rendered content and run the required upgrade/skill acceptance suite.
- [x] Add an isolated end-to-end fixture modeled on plan 568: approved malformed plan, existing ready code review/quality, one repair instruction, preserved evidence, checklist verification, phase completion and remaining-phase continuation. Assert run/source/budget continuity and reviewer/quality invocation counts.
- [x] Add combined lifecycle cases for stale final-corrections ledger, prefix-only drift, empty negative verdict, historical gate-less state and restart. Use fixture journals, not the external project's live database or worktree.
- [x] Run the configured quality gates plus typecheck. Review every new blocker against the operator-recovery table: implementation is incomplete if a validation merely replaces the old dead end with a different dead end.

## Workflow Asset Impact

| Surface | Required change / acceptance |
|---|---|
| `src/templates/default-artifacts.ts` and configured repository plan skeleton | Require parser-recognized items in each phase; retain prose gate support. A custom skeleton's cosmetic differences are not grounds for refusal. |
| `author-generate-plan.md`, `author-process-plan-review.md`, `author-next-phase.md`, `author-process-impl-review.md` | Author owns draft repair; approved structural repairs use the operator-authorized command. Existing evidence can discharge unchanged requirements. `author-process-plan-review.md` is the revision and final-corrections consumer for W3. Generation and revision keep compact mode and preserve the existing Issue Coverage instructions: the pinned `Source brief`, verbatim `ACn` text and mappings, assumptions, untouched `source/` snapshots, and no `ACn` in `Addresses`. |
| `reviewer-plan.md`, `reviewer-plan-continued.md`, `reviewer-commit.md`, `reviewer-commit-continued.md` | Executability preflight is deterministic; plan defects do not require fictitious code hunks. No invented findings to obtain repair authority. The initial and continued plan-review variants keep their pinned-brief Issue Coverage check unchanged and do not treat a mechanical repair as a coverage gap. |
| Runtime-appended context | Shared native/invoke data supplies authoritative plan anchors, diagnostics and supported recovery commands even with older local prompt overrides. |
| `src/skills/base/5x-plan/`, `5x-plan-review/`, `5x-phase-execution/` | Repair-before-refuse, one-pass finalization, exact CLI envelope fields, same-run recovery and no duplicate operator confirmations across relevant delegation modes. |
| `src/skills/base/5x-issue-resolution/` | Steps 2/3: finalization or source repair on the sealed planning source, then an explicit `--source-run` bind and repair on the same implementation run, without repeated planning, intake, association or approval. Step 5 delivery recipes treat repair/finalization receipts as evidence only and keep `BASE`, accepted intervals and closure preconditions unchanged unless a regression shows a concrete incompatibility. Change only the guidance not already delegated to the planning, review and execution skills, and record any unaffected step. |
| `author-issue-intake.md`, `author-fix-quality.md`; `5x`, `5x-config`, `5x-plan-migration`, `5x-windows` skills | Unaffected: intake, identity markers, discovery, quality-fix and schema-migration flows do not create, validate or repair phase checklists. Confirm this during the asset check rather than editing them. |
| Installation, override resolution, upgrade, harness sync | Reuse existing asset ownership/freshness behavior. Preserve local edits, report stale assets, and test effective rendered behavior. Change installer mechanics only if focused acceptance exposes a concrete incompatibility. No new mandatory sync gate. |

## Files Touched

Paths below are relative to `5x-cli/` except the explicitly named repository skeleton. Tests mirror their owning implementation work.

| File(s) | Change |
|---|---|
| `src/parsers/plan.ts`, `src/plan-schema/authority.ts` | Shared governing checklist semantics and executable validation input. |
| `src/plan-schema/checklist-repair.ts` (new) | Pure diagnostics, deterministic prefix candidate and proof. |
| `src/commands/plan-v1.ts`, `src/commands/plan-v1.handler.ts`, `src/commands/plan-checklist-repair.handler.ts` (new) | Repair command and additive phase diagnostics/help. |
| `src/review-governance/implementation-state.ts`, `implementation-amendment.ts`, `implementation-boundary.ts` | Repair-aware lineage, source binding, admission and evidence-preserving completion. |
| `src/review-budget/record-lines.ts`, `src/control-plane/review-budget-store.ts`, `src/review-governance/sqlite-index.ts` | Two new narrow record kinds and shared replay/projection. |
| `src/review-governance/plan-approval-finalization.ts` (new), `src/commands/run-v1.handler.ts` | Final committed approval reconciliation, legacy source compatibility, state/complete integration. |
| `src/review-budget/plan-repair.ts`, `src/commands/review-budget-context.ts` | Early structural repair and plan-review consistency. |
| `src/commands/template.handler.ts`, `invoke.handler.ts`, `protocol.handler.ts`, `phase.handler.ts` | Shared boundary checks and actionable resume/retry behavior. |
| `src/review-governance/implementation.ts`, `routing.ts`, `store.ts`, `src/commands/implementation-review-context.ts`, `review-decision.handler.ts` | Gate invariant and historical corrective-review entry path. |
| `src/review-governance/context.ts`, `code-diff.ts` | Runtime plan evidence alongside, rather than inside, code-hunk evidence. |
| `src/templates/default-artifacts.ts`; repository `docs/_implementation_plan_template.md` | Executable and repair-friendly plan skeletons. |
| `src/templates/author-generate-plan.md`, `author-process-plan-review.md`, `author-next-phase.md`, `author-process-impl-review.md`, `reviewer-plan.md`, `reviewer-plan-continued.md`, `reviewer-commit.md`, `reviewer-commit-continued.md` | Initial/continued author/reviewer guidance, including final corrections and Issue Coverage preservation; these are 8 prompt assets. |
| `src/skills/base/5x-plan/SKILL.tmpl.md`, `5x-plan-review/SKILL.tmpl.md`, `5x-phase-execution/SKILL.tmpl.md`, `5x-issue-resolution/SKILL.tmpl.md` | Planning, review, execution and issue-handoff recovery; these are 4 skill assets. Change the issue skill only where its delegated behavior is not already enough. |
| `test/unit/parsers/` (including `issue-plan-fixture.test.ts`), `test/unit/review-governance/`, `test/unit/commands/` | Pure proof/validation, compact issue-plan executability and preservation, admission/finalization/gate replay and command-handler regressions. `test/fixtures/issue-resolution/compact-plan.md` is used unchanged. |
| `test/integration/commands/`, `test/unit/skills/implementation-review-governance.test.ts` | CLI lifecycle and effective workflow acceptance. |
| `test/integration/issue-resolution-recipes.test.ts`, `test/helpers/issue-delivery-fixtures.ts` | Receipt and finalization delivery-identity, evidence-carry, negative-delivery and reconciliation regressions against the shipped recipes. |

## Tests and Acceptance

| Type / owner | Required proof |
|---|---|
| Unit — W1 | Prefix-only equivalence, unchanged obligations/budget/schema, no accidental check-off, user-work preservation, replay and identical retries. |
| Integration — W1/W2 | Direct repair while admission is blocked, no open gate required, zero reviewer calls for pure repair, one operator instruction, same run after restart. |
| Unit/integration — W2 | Executability catches real empty phases without treating ordinary prose, supported task syntax or examples as new blockers. All error paths expose working repair/author actions. |
| Unit/integration — W3 | Authorized final corrections bind exact committed bytes and the corrected ledger; substantive unsupported deltas return an in-run remedy; legacy stale-Addresses case is deterministic. |
| Unit/integration — W4 | Structural plan defect accepted without code hunk; empty negative response repair; enforced route implies discoverable actionable gate; replay/index parity. |
| Installed/rendered assets — W5 | Configured and bundled skeletons, overrides, initial/continued prompts, native/invoke, corrected JSON examples and one-authorization orchestration. |
| End-to-end — W5 | The original failure lifecycle becomes a bounded detour: diagnose, authorize repair once, preserve valid evidence, verify checklist, resume and complete. Count actual additional reviewer/quality invocations. |
| Issue-plan contract — W5 | The compact fixture passes executability unchanged. Effective generation/revision and initial/continued plan-review renders keep compact and Issue Coverage guidance. Repair and finalization preserve the `Source brief`, verbatim `ACn` rows/mappings, assumptions and `source/` snapshots, with no `ACn` in `Addresses`. Issue skill Steps 2/3 take the source through finalization or repair, then an explicit bind, then same-run execution repair. |
| Issue delivery identity — W5 | The shipped `accepted-intervals` and `classify-delivery` recipes carry settled review and proof-bound correction evidence across repair and finalization receipts. `BASE` and the accepted code endpoints stay unchanged, receipt commits are evidence only, and `delivery: ok` reaches the existing reconciliation path. Unsettled or uncovered code still fails delivery, with no success publication or close. |

Required focused asset command (from `5x-cli/`):

```bash
bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts
```

Required focused issue-consumer command (from `5x-cli/`):

```bash
bun test test/integration/issue-resolution-recipes.test.ts test/unit/parsers/issue-plan-fixture.test.ts
```

Final implementation checks from the same directory: `bun run lint`, `bun run typecheck`, and `bun run test`. Follow `AGENTS.md` test-tier, Git fixture, subprocess environment and timeout conventions. Validation of this planning document requires schema/phase/budget parsing; it does not require running unrelated product tests.

### Blocking-condition exit criteria

| Blocking condition | Tested way forward |
|---|---|
| Empty checklist in draft | Automatic author repair followed by the original review. |
| Empty checklist or prefix-only drift after approval | Direct operator-authorized mechanical repair; preserve evidence; retry interrupted checkpoint. |
| Ambiguous formatting selection | Show candidate lines; obtain scope selection once; perform the same proof/repair. |
| Candidate includes real requirement changes | Show exact disallowed changes and existing semantic-amendment next steps; preserve repair preview and run. |
| Stale preview / concurrent write | Refresh candidate under the same run; preserve authorization if proposed scope is unchanged. |
| Final-corrections ledger bookkeeping differs | Finalize the corrected committed ledger from admitted correction evidence; no second review. |
| Correction exceeds admitted scope | Same-run review/amendment with concrete delta, not an unusable sealed approval. |
| Empty unexplained negative verdict | Correct the structured response using existing retry limits; do not create a human gate. |
| Historical gate-less observation | Inspect despite the inconsistency, repair drift directly if needed, then record a truthful corrective review on the same run. |
| Issue workflow reaches a repairable checklist defect at the planning/binding handoff | Repair or finalize the completed planning source, bind explicitly from it, and continue on the same implementation run; no repeated planning, intake or approval. |
| Issue delivery reports a repair receipt beside unsettled or uncovered code | Delivery fails as it does today; settle the code through the ordinary review path. The receipt neither blocks a settled chain nor substitutes for one. |

## Issue Traceability

| Postmortem proposal / user requirement | Planned resolution |
|---|---|
| T1: early zero-checklist detection | W2 / Phase 2, with repair-first behavior rather than hard-failing inspection. |
| T2: template/checklist guidance | W2/W5 / Phases 2 and 5; existing guidance is strengthened and enforced, not claimed absent. |
| T3: final-corrections ledger/byte tests | W3 / Phase 3; fixes the verified stale-ledger cause and checks exact bytes. |
| T4: distinguish introduction and toggles; actionable repair | W1 / Phase 1; direct operator authority replaces a full semantic review for proven prefix-only edits. |
| T5: plan-structure review blockers | W4/W5 / Phases 4 and 5; preserve runtime support, fix misleading instructions and missing anchored plan evidence. |
| T6: durable human gates | W4 / Phase 4; validate real causes/choices and repair unsupported responses. |
| T7: lifecycle regressions | Tests within W1–W5 and Phase 5 integrated acceptance. |
| T8: preflight and honest recovery | W2/W5 / Phases 2 and 5, including the discovered CLI-envelope example bug. |
| Operator can say “fix it and move on” | W1 is implemented first; Phase 5 verifies one authorization, no artificial review/gate prerequisite, no run restart and preserved valid work. |
| Avoid new tripwires | Recovery must ship with each enforcing boundary; inspection remains available; cosmetics remain nonblocking; invocation counts are acceptance assertions. |
| Integrated issue-resolution consumer (review R1, R2) | W5 / Phase 5: corrected prompt/skill inventory, issue-skill planning-to-binding handoff, compact and Issue Coverage preservation, and delivery-identity and closure regressions for repair/finalization receipts. |

## Not In Scope

- A generic “ignore all checks” mode, automatic assertion that unfinished requirements are complete, or a new governance engine.
- Reopening the sealed Player Desk execution, changing its v1.2 fresh-execution decision, or modifying its application code, records or configuration.
- General Markdown reformatting, phase renumbering, automatic semantic equivalence judgments, or broadening mechanical repair to real requirement/budget changes.
- New provider integrations, external services, SQLite tables, lock implementations or mandatory asset-update approval flows.
- Redesigning issue intake, association, delivery recipes, or GitHub closure policy; adding an Issue Coverage parser or gate; or requiring new review merely because a mechanical receipt exists.

## Estimated Timeline

| Phase | Estimated implementation time |
|---|---|
| 1 — Operator-authorized repair | 2–3 days |
| 2 — Executability diagnostics and integration | 1–2 days |
| 3 — Final-corrections approval consistency | 2–3 days |
| 4 — Routing and plan evidence | 1–2 days |
| 5 — Workflow assets, issue-consumer and lifecycle acceptance | 2–3 days |

## Provenance

Source postmortem: `~/dev/player_desk/.5x/worktrees/568-impl-booking-modal-member-preview-9ce163/docs/development/reviews/568-checklist-workflow-postmortem.md`, authored November 5, 2026. Incident artifacts are under that worktree's `docs/development/runs/568-impl-booking-modal-member-preview/`, particularly `run_1ed73f724527`, `run_f2b20d71c005`, and `run_9d62a2f1fdb9`; the closure explanation is in `docs/development/reviews/run_9d62a2f1fdb9-phase-1-review.md`. The verified claims and reproducing fixture requirements are captured in this document so execution does not depend on access to the external checkout.

The operator reviewed the proposed scope on November 6, 2026 and emphasized that trivial workflow defects must be repairable at their direction without creating more tripwires. That requirement governs the repair-first ordering, direct operator authority, evidence preservation and invocation-count acceptance criteria above.

<!-- 5x:contract:end -->

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0 | November 6, 2026 | Initial plan. |
| 1.1 | November 6, 2026 | Focused post-merge integration revision for the review addendum “Integrated issue-resolution consumer”. Records the integration baseline as main `6982a024`, which includes issue merge `3387c4cc`, and adds Design Decision 7. **R1:** the asset inventory now names the real `author-process-plan-review.md` and `reviewer-plan-continued.md` in place of the nonexistent `author-revise-plan.md`, and adds the `5x-issue-resolution` Steps 2/3 handoff, compact-plan and Issue Coverage preservation acceptance, and unaffected-surface notes. **R2:** adds delivery-identity, evidence-carry, negative-delivery and reconciliation regressions for repair/finalization receipts against the shipped recipes. W5 effort changes 3 → 5 (+1 per finding, architecture 0), W5 `Addresses` is R1, R2, and production files change 38 → 40. W1–W5 IDs, phase order and the repair-first operator-authority requirements are unchanged. The orchestrator reported that the existing focused integrated tests passed 192/192 after a frozen-lockfile install. Those are baseline results, not evidence for the future repair implementation. |
