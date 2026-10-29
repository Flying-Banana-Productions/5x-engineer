# Versioned Plan Contracts and Legacy Migration

**Version:** 1.1
**Created:** October 29, 2026
**Status:** Draft — revised after staff engineer review

---

## Executive Summary

Approved implementation runs reject any plan edit that is not a checkbox toggle. Authors still need to update a status line or add execution context, including context the plan itself asks for, and those edits block the run. This plan adds an explicit schema 1 execution contract so informational text can change, while approved obligations stay bound to a governing projection and to the existing amendment lineage.

Schema 0 remains the behavior of every unversioned plan and every historical approval. A migrated or newly approved schema 1 plan is never read as schema 0 when its markers are missing. Migration is a recorded transition with equivalent and selective paths. It is not an accept-current-plan rebaseline, and it does not reset budgets, discard decisions, or restart the run.

### Scope

**In scope:**
- A shared plan-document reader that distinguishes schema 0, schema 1, and malformed declarations.
- A governing projection used by phase parsing, budget parsing, structural checks, approval, drift, author admission, review span resolution, text-amendment guard verification, frontier recovery's earlier-phase check, reconciliation, phase finish, resume, and run completion.
- Optional schema identity and governing hash on new implementation bindings, plus one new lineage record for schema 0 to schema 1.
- Pre-approval file conversion and a drift-blocked recovery command for already approved runs.
- A shipped `5x-plan-migration` skill, schema 1 skeletons, and the same authority instruction on native and invoke prompts.

**Out of scope:**
- Retiring schema 0 in this feature.
- A CLI classifier for whether prose inside a note or outside the contract is a requirement.
- Semantic plan amendments, budget re-estimation, or replacement of `5x review implementation recover-plan`.
- Speculative migrations other than schema 0 to schema 1.
- Rewriting historical journals or reinterpreting an old approval because markers were inserted later.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Recorded schema wins over the file** | A historical binding with no schema field stays schema 0. Markers added later are byte drift, not a new interpretation. |
| **Raw hashes stay raw** | Git commits, blob checks, and `approvedPlanHash` keep the document bytes. Schema and governing hash are additional approval fields. |
| **Migration is a lineage record** | The implementation binding stays immutable. Equivalent migration does not reopen phases or replace the baseline. |
| **Selective authority is an operator digest** | Selective exclusion is confirmed only by the operator passing the exact proposal digest. Equivalent migration is a mechanical proof. The CLI does not decide that a sentence is non-semantic, and this feature does not accept a reviewer snapshot as migration authority. |
| **One instruction, no prose classifier** | Agents warn the operator about conflicting context. Durable gates still come only from records and the governing projection. |

### References

- Requirements document `5x-cli/docs/development/plan-schema-contract-requirements.md` — agreed behavior this plan implements, including the operator decisions on projected schema 1 guards and operator-only selective confirmation. The file is in this branch at that path.
- [Plan 210](./210-implementation-review-governance-plan.md) — approval binding, drift, and text-amendment guards this feature extends.
- [Plan 215](./215-implementation-plan-amendment-plan.md) — immutable binding and amendment lineage this feature must not reset.
- [5x-cli agent guide](../../../AGENTS.md) — workflow-asset surfaces required for a shipped contract change.

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Unresolved Product Decisions](#unresolved-product-decisions)
4. [Delivery Budget](#delivery-budget)
5. [Architecture Overview](#architecture-overview)
6. [Phase 0: Confirm the seams](#phase-0-confirm-the-seams)
7. [Phase 1: Plan document projection](#phase-1-plan-document-projection)
8. [Phase 2: Authority readers](#phase-2-authority-readers)
9. [Phase 3: Migration commands and records](#phase-3-migration-commands-and-records)
10. [Phase 4: Workflow assets](#phase-4-workflow-assets)
11. [Files Touched](#files-touched)
12. [Tests](#tests)
13. [Not In Scope](#not-in-scope)
14. [Estimated Timeline](#estimated-timeline)
15. [Provenance](#provenance)
16. [Revision History](#revision-history)

---

## Overview

Today `detectPlanDrift` (`src/review-governance/implementation-state.ts`, lines 192–216) compares the current plan with the approved bytes plus verified text amendments and frontier recoveries. The only ignored difference is checkbox state, via `normalizeCheckboxMarkers` (`src/review-governance/plan-amendment.ts`, lines 172–180). A status sentence, a revision-history paragraph, or an execution note changes the raw bytes and admission returns `IMPLEMENTATION_PLAN_DRIFT` (lines 634–647). Bind performs the same comparison before it copies the approved blob (lines 1094–1108).

`parsePlan` (`src/parsers/plan.ts`, line 34) and `parseDeliveryBudget` (`src/parsers/delivery-budget.ts`, line 438) read the whole Markdown string. `parsePlan` does not ignore fenced examples. Phase finish, resume, protocol rendering, and plan inspection call those parsers on the raw file (`src/commands/plan-v1.handler.ts` line 398, `src/commands/protocol.handler.ts` line 298, `src/commands/run-v1.handler.ts` lines 1605, 2789, 3060, 3722, and 4620). Text-amendment spans are raw UTF-8 offsets (`resolvePlanImpactSpans` in `src/review-governance/implementation.ts`, line 192). The binding payload (`src/review-budget/record-lines.ts`, lines 281–303) stores `approvedPlanHash` and `approvedPlanBytes` and has no schema field. `IMPLEMENTATION_STATE_VERSION` is 1 (line 23). The decoder copies known fields, so historical records that omit new optional fields still decode. Unknown budget kinds are skipped by `listImplementationTextAmendments` (`src/control-plane/review-budget-store.ts`, lines 472–495) and by the SQLite index (`src/review-governance/sqlite-index.ts`, lines 255–259).

**Current behavior:**
- Checkbox toggles do not drift. Every other byte change does.
- There is no plan schema. Inserting comments cannot change what is authoritative, because the entire file is authoritative.
- `5x review implementation recover-plan` (`src/commands/review.ts`, lines 237–282) is a semantic frontier amendment. It is the only drift remediation named by admission (implementation-state.ts line 645). It is the wrong tool for a status-line edit.
- New plans are generated from `DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE` (`src/templates/default-artifacts.ts`, line 1) with no contract markers.
- Author prompts allow checkbox updates and forbid structural edits (`src/templates/author-next-phase.md` line 37, `src/templates/author-process-impl-review.md` lines 43–44). They do not say which surrounding text is allowed to change.

**New behavior:**
- An unversioned plan, and any bound run whose records say schema 0, keeps today's full-file comparison.
- A schema 1 plan has one declaration and one contract. Drift, text-amendment guard verification, and the unchanged check compare the governing projection, not the raw file. Status text outside the contract, and note blocks inside it, can change without a new approval and without invalidating an authorized amendment. Raw amendment snapshots and raw before/after hashes stay provenance. Schema 0 amendment checks stay on raw bytes.
- Wrapping, deleting, or editing a governing requirement still fails closed until an amendment or an explicitly authorized selective migration.
- New skeletons and planning skills emit schema 1. Existing schema 0 approvals remain valid without migration.
- Drift diagnostics name `5x review migrate-schema` and the `5x-plan-migration` skill. Semantic amendments still use the existing amendment and `recover-plan` commands.

**Prerequisites:**
- [Plan 210](./210-implementation-review-governance-plan.md) — merged behavior this worktree already contains: binding, drift, text guards, and budget snapshots.
- [Plan 215](./215-implementation-plan-amendment-plan.md) — follow its rule that the original implementation binding is not rewritten. If 215's `amend` command has landed by implementation time, Phase 0 must fold migration records into that command's lineage reader instead of inventing a second chain. This plan does not depend on 215 being present.

---

## Design Decisions

**Schema identity is recorded, not inferred from a missing marker.** File mode, used before approval, treats a missing declaration as schema 0 and a valid `plan-schema:1` declaration as schema 1. A bound or approved run uses the schema stored on its binding or migration record. Expected schema 0 never extracts a contract. Expected schema 1 with missing, duplicate, or malformed markers is `PLAN_SCHEMA_INVALID`, including after a crash mid-migration. That failure is not a fallback to schema 0.

**Human document version stays the `**Version:**` line.** The HTML schema declaration is the only structural schema. Skills call the metadata line the document revision. Parsers must not treat a change to that line as a schema change.

**The governing projection has two views of one classification.** `authorityMarkdown` is a line-aligned mask of the raw document. Every governing line keeps its original text. Every non-governing line, including marker lines, note interiors, and bytes outside the contract, is blanked in place by replacing each non-newline UTF-16 code unit with a space and keeping `\r` and `\n`. The mask has the same line count and the same UTF-16 length as the raw string, so a character offset in the mask is that offset in the raw file. Replacing a non-governing line with an empty line would keep the line count and still shift every later character offset. That is not the mask. Parsers, heading spans, and protected ranges run on the mask. Character-to-byte conversion always slices the raw string with the mask's character ranges (`Buffer.byteLength(raw.slice(0, index), "utf8")`). It never measures the mask. A space is one byte, so a mask measurement is wrong wherever a blanked line contained non-ASCII text. `comparisonBytes` for schema 1 is `governingLines.join("\n")`. `governingLines` is the governing line texts only, with line endings removed, notes and their delimiters omitted, checkbox-normalized by the existing `normalizeCheckboxMarkers`, after the note-splice rule below. An empty governing-line list is an empty array, not one empty string. Schema 0 does not rejoin lines: its `comparisonBytes` is `normalizeCheckboxMarkers(raw)`, which is today's drift input, and its `governingLines` is only the line split of that string used by the migration diff. `hashPlanBytes` (`implementation-state.ts`, lines 100–102) hashes schema 1 `comparisonBytes` when the caller asks for `governingHash`. The projection module returns the lines and the bytes and does not hash them, so there is one hash implementation.

**Note removal may drop one separator blank line and nothing else.** After a note block is removed, if the line immediately before the note start and the line immediately after the note end are both blank, `comparisonBytes` omits the blank line that immediately preceded the note. It does not trim other blank lines, collapse spaces, or rewrite prose. Equivalent wrapping also allows the governed interior to differ from the approved bytes by a single trailing newline when that newline is required to put the contract end marker on its own line. Checkbox normalization remains the only other comparison allowance.

**Markers are recognized only as standalone lines outside fences.** A line matches only when it has at most three leading spaces, no trailing content other than horizontal whitespace, and one of these exact bodies. The note id is one letter or digit followed by at most 63 characters from `[A-Za-z0-9_-]`.

```text
<!-- 5x:plan-schema:1 -->
<!-- 5x:contract:start -->
<!-- 5x:contract:end -->
<!-- 5x:note:start id="concurrency-context" -->
<!-- 5x:note:end id="concurrency-context" -->
```

A version token other than `1` is `PLAN_SCHEMA_UNSUPPORTED`. A reserved `5x:` marker line that does not match the grammar is `PLAN_SCHEMA_INVALID` in file mode and in expected schema 1. The same bytes are ordinary text under expected schema 0. Marker lines inside a fence, including the examples in this plan, are literal and do not open or close structure. Note blocks are valid only inside the single contract, only as pairs with the same id, with unique ids, and without nesting. A note delimiter must be a block boundary: the line before a start marker is the contract start or a blank line, and the line after an end marker is the contract end or a blank line. A note must not sit inside a table. The immediately previous and immediately next non-blank governing lines must not both be table rows. Copying a requirement into a note while leaving the original in place does not change `comparisonBytes`. Moving a requirement into a note, or moving a contract boundary so the requirement falls outside, removes it from `comparisonBytes` and is drift unless a selective migration authorizes that exact exclusion.

**Schema 1 skeletons put bookkeeping outside the contract and obligations inside it.** Outside: the schema declaration, the human `**Version:**` and `**Status:**` lines, generator how-to comments, and `## Revision History`. Inside: the H1 title, overview, design decisions, delivery budget, debt claims, phase sections, checklist items, completion gates, acceptance text, exclusions, files touched, and tests. `parsePlan` reads the display status and human version from the raw preamble. It reads the title, phases, gates, and checklist items only from `authorityMarkdown`. A phase heading or budget table outside the contract or inside a note does not create a phase, a gate, or a ledger row. Informational sentences, including a note that says review passed, do not satisfy phase finish or run completion.

**Schema 1 text-amendment guards resolve and verify on the governing projection.** `resolvePlanImpactSpans` searches `authorityMarkdown`, so a `staleText` hit inside a note or outside the contract is not found. Character offsets of a governing hit match the raw document. Byte offsets stored on the guard are computed from the raw anchor with those character indexes. `fixedSegmentsMatch` (`plan-amendment.ts`, line 242) does not compare the raw buffers on schema 1. Verification maps each stored raw span into `comparisonBytes` coordinates with the same line classification, note-splice rule, and raw-string byte lengths, then compares the anchor projection with the committed projection. The comparison is literal fixed segments. It does not classify status sentences or note prose. A governing byte outside the mapped spans still returns `PLAN_AMENDMENT_OUT_OF_SPAN`. A span that covers a non-governing byte is not an authorized governing span and fails the same way.

A status edit or a valid note edit does not change `governingLines` beyond the one blank-line splice, and that splice is applied to both sides by the same rule. Those edits do not fail verification and do not make the guard stale, whether they were already in the committed blob when the guard was snapshotted or were added before verification. `PLAN_AMENDMENT_STALE` stays a raw lineage mismatch only: the guard's `anchorBlobHash` differs from the replayed raw authorized hash, or the stored raw anchor does not hash to the recorded value. Do not report staleness because a note or status line differs from the raw anchor.

Budget-table equality and `structuralSignature` stay in force. On schema 1, `prepareTextAmendmentGuard` and `verifyGuardedPlanBytes` compute both from the governing projection, so a status line or a note cannot change them, and a real budget or structural edit still fails `PLAN_AMENDMENT_TABLE` or `PLAN_AMENDMENT_STRUCTURE`. Protected-range overlap is checked in mask character coordinates and converted to bytes with the raw string, before the span is mapped. Schema 0 keeps today's raw checkbox-normalized `fixedSegmentsMatch`, raw budget table, and raw structural signature. This feature does not rebase schema 0 offsets. Completed amendment records keep their raw before and after hashes.

**Projected checks and raw registration use different bytes.** The guard stores the raw anchor and `anchorBlobHash = hashPlanBytes(rawAnchor)`. Replay, parent linkage, and that hash stay raw. Ordinary author admission runs `verifyGuardedPlanBytes` before the unchanged check (`implementation-state.ts`, lines 1423–1434). On schema 1 that verification uses the projection, so a committed blob that differs from the raw anchor only by status, notes, or checkbox state is not `PLAN_AMENDMENT_OUT_OF_SPAN`. The unchanged check then compares schema 1 `comparisonBytes` of the committed blob and the guard anchor. Equality returns `unchanged` and writes no amendment. Inequality inside the authorized spans continues to `recordVerifiedTextAmendment`. `verifyGuardedPlanBytes` still returns the committed raw blob as `authorizedPlanBytes`. The recorded before and after hashes are raw hashes. Later replay derives the next projection from those raw bytes. Informational bytes stay in the raw snapshot and drop out of the next projection. When no text guard applies, schema 1 admission uses governing drift only. An informational edit is not `IMPLEMENTATION_PLAN_DRIFT` and does not require an amendment record. Replacing the raw parent hash with a governing hash, or storing the projection in place of `authorizedPlanBytes`, would break that admission and registration path. Do not do either.

**New bindings may store schema; old bindings are not rewritten.** `ImplementationBindingPayload` gains optional `planSchema`, `governingHash`, `schemaMigrationId`, and `predecessorPlanCommit`. All four are omitted on schema 0 bindings. When `planSchema` is `1`, `governingHash` is required and must equal `hashPlanBytes` of the approved document's `comparisonBytes`. The decoder accepts records that omit the fields. It rejects a present `planSchema` other than `0` or `1`, and it rejects schema 1 without `governingHash`. Do not bump `IMPLEMENTATION_STATE_VERSION`. Older binaries that ignore the extra fields keep comparing raw bytes, so informational edits look like drift. That fail-closed result is acceptable. Migrated runs and schema 1 bindings must be executed with a CLI that understands the fields. Phase 4 states that toolchain requirement in the migration skill and in the drift diagnostic. No SQLite migration is required.

**Migration appends one lineage record and reuses the record-store transaction.** The kind is `plan-schema-migration` on the budget stream. `atomicAppendIfAllNew` (`src/control-plane/record-fs.ts`, lines 747–860) writes that record and its step together. The idempotency key contains the proposal digest. `expectedKeys` is the full current key list of the budget, steps, and decisions streams, matching `recover-plan` (`implementation-recovery.ts`, lines 422–437), so a concurrent review decision invalidates the attempt. An identical completed retry returns the stored winner before any schema 1 refusal. A different proposal after a recorded migration is `PLAN_MIGRATION_CONFLICT` and writes nothing. A different digest competing for the same parent fails with `RECORD_PRECONDITION_FAILED` or a payload mismatch. The command never applies twice.

**Equivalent migration is a mechanical proof. Selective migration is an operator-confirmed exclusion list.** Equivalent mode accepts a target whose `governingLines` match the checkbox-normalized approved governing lines, including the one trailing-newline allowance, with no exclusions. Authority is `verified_equivalent`. No operator digest is required. Selective mode requires a non-empty exclusion list and `--confirm-exclusions` equal to the proposal digest. There is no `--snapshot` flag and no reviewer authority. The payload's `authority` is `verified_equivalent` or `operator`.

Exclusions come from a deterministic line diff, not from pairing each removed line with a current sentence. The approved sequence is every line of the replayed authorized raw document, checkbox-normalized, without line endings. For a schema 0 source that sequence is the whole file. The target sequence is the target document's `governingLines`. In equivalent mode, apply the trailing-newline allowance before the diff, so that one extra empty target line does not itself become an insertion. Selective mode does not apply that allowance. Compute a longest common subsequence with earliest-match reconstruction. Let `dp[i][j]` be the LCS length of the first `i` approved lines and the first `j` target lines. Walk from `(0, 0)` while either sequence still has lines. If both sides remain and the current lines are equal, emit a match and advance both. That match is always on some longest common subsequence, because equal lines raise the LCS length by one. Otherwise, if an approved line remains and `dp` at the cell after deleting it equals `dp` at the current cell, emit a deletion and advance the approved side. Otherwise, if a target line remains, emit an insertion and advance the target side. Repeated blanks, `---`, and table separators therefore have one alignment.

Each deletion is one exclusion. Its id is `L` plus the 1-based line number in the approved raw document, and its text is that checkbox-normalized line. An insertion is an added governing line. A changed retained line does not match, so it is a deletion plus an insertion. In equivalent mode, any exclusion or insertion is `PLAN_MIGRATION_NOT_EQUIVALENT`. In selective mode, an insertion is `PLAN_MIGRATION_GOVERNING_CHANGE` and points at `5x review implementation recover-plan`. Deletions are the exclusion list. The command does not store a per-exclusion `currentText`. It stores one `nonGoverningText` array: every target raw line the projection classifies as non-governing, including the schema declaration, contract markers, note delimiters, note interiors, and other lines outside the contract, as `{ line, text }` in ascending 1-based raw line order, with line endings removed. Dry-run prints the exclusions and that block. The proposal digest is `hashPlanBytes` of canonical JSON containing `runId`, `beforeBlobHash`, `afterBlobHash`, `parentLineageId`, the exclusions in id order as `{ id, approvedTextHash }`, and `nonGoverningTextHash`. Object keys are sorted. Array order is kept. `nonGoverningTextHash` is `hashPlanBytes` of the canonical JSON of the `nonGoverningText` array. A changed file, a different run, or a different non-governing block makes the digest stale (`PLAN_MIGRATION_STALE`).

**Selective and equivalent migration do not reopen the run.** Registration checks that the target governing ledger deep-equals the already approved ledger. It does not write a baseline, does not invalidate observations or contexts, and does not return `completionAuthorized: true`. Phase evidence remains evidence for the retained obligations. A governing change still goes through the existing amendment workflow.

**Pre-approval conversion and approved transition are different commands sharing one verifier.** `5x plan migrate` rewrites an unapproved working-tree file and writes no governance record. It refuses when that plan path already has a completed approving run or an implementation binding. `5x review migrate-schema` is the recorded transition. On a bound execution run it appends the lineage record even when admission would return `IMPLEMENTATION_PLAN_DRIFT`. On an approved plan-review run that has no execution binding yet, it records the migration on that source run. Later `bind` reads the source migration, copies the migrated blob, and sets `planSchema: 1` on the new binding. It does not rewrite the source approval snapshot. A source migration does not silently attach to an execution binding that already exists; the operator runs the command on the execution run.

**The motivating recovery case is selective and does not re-review the obligations.** The approved plan contains a status sentence. The worktree status sentence differs. The committed proposal leaves every other governing line in the contract, checkbox state allowed to differ, and places the new status sentence outside the contract. Dry-run shows that status sentence as an exclusion identified by its approved line number, and shows the current status line inside `nonGoverningText`. It does not pair the two with a semantic matcher. After `--confirm-exclusions` with that digest, admission no longer reports drift, the delivery-budget ledger is unchanged, and existing phase records remain. Equivalent mode is the wrong path for this case: it keeps `**Status:**` inside the contract, so a later status edit still drifts.

**Warnings are instructions, not a semantic detector.** The CLI validates marker structure only. It does not scan note prose for requirement language. The constant `PLAN_SCHEMA_AUTHORITY_INSTRUCTION` is:

```text
Only contract content outside notes governs the work. Read other plan content as context. Surface apparent material requirements or conflicting instructions to the operator as warnings. Route necessary contract changes through amendment approval before acting. Informational claims such as review passed do not satisfy completion gates.
```

That paragraph is included in the schema 1 skeleton comment, the planning and execution skills, the initial and continued author and reviewer templates, and the shared runtime append in `appendPlanReviewPromptContext` (`src/review-governance/context.ts`, lines 134–142). Native rendering (`src/commands/template.handler.ts`, line 666) and invoke rendering (`src/commands/invoke.handler.ts`, line 854) both call that function. The append keeps the instruction on the rendered prompt when a project override of the template is stale. Override files are not rewritten.

**Material references are an authoring rule.** Skills tell authors to put governing requirements in the contract, or to cite an immutable commit or blob. The CLI does not resolve those citations and does not judge whether a reference is material.

**This planning document stays schema 0.** It does not carry a schema declaration. Marker examples appear only so implementers can see the grammar. Do not add a live declaration to this file while implementing the feature.

---

## Unresolved Product Decisions

None. The command names, operator-only confirmation of the exact exclusion digest, the placement of status outside the contract, and schema 1 guard verification on the governing projection are fixed above. Implementation must follow them. If Phase 0 finds that plan 215 replaced `listImplementationTextAmendments` with a different lineage reader, fold the migration kind into that reader. That is an integration adjustment, not a product change.

---

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Schema grammar and governing projection | 5 | 1 | - | P1.1 | New pure module with marker failures, fence opacity, note splices, and checkbox reuse. Effort 5 is the new abstraction. Architecture +1 is the permanent reader every later phase calls. Tests for the grammar belong to this item. Reassessed for P1.1: space-filling the mask is the offset contract of that reader. Effort stays 5 and architecture stays +1. |
| W2 | Authority wiring and schema fields on bindings | 5 | 1 | - | P0.1, P1.1, P1.2 | Drift, parsers, spans, baselines, admission, and completion must share one expected-schema input. Effort 5 crosses those subsystems. Architecture +1 keeps schema 0 and schema 1 as concurrent record contracts without a version bump. Reassessed for P0.1, P1.1, and P1.2: projected guard verification, raw-string byte conversion at span and protected-range sites, the projected unchanged check, and the earlier-phase projection comparison replace raw comparisons inside this wiring. P1.1 is shared with W1 and is not scored again. Effort stays 5 and architecture stays +1. |
| W3 | Recorded schema migration and recovery commands | 8 | 2 | - | P1.3, P1.4, P1.5, P2.1 | Adds a lineage kind, digest-bound operator confirmation, and idempotent registration for both unbound approvals and drift-blocked runs. Effort 8 is that migration. Architecture +2 is the lasting record kind and the digest-bound operator authority on top of the existing store. Reassessed for P1.3, P1.4, P1.5, and P2.1: reviewer snapshot authority is removed and is not scored. The deterministic exclusion diff, identical-retry-before-conflict order, and decisions precondition stay inside this migration. Effort stays 8 and architecture stays +2. |
| W4 | Schema 1 workflow assets and rendered instruction | 5 | 1 | - | P1.3 | Publishes the skeleton, skills, templates, diagnostics, and override behavior across harness install and both delegation modes. Effort 5 matches that asset surface, including the required upgrade and skill acceptance suite. Architecture +1 is the new supported migration skill. Reassessed for P1.3: the migration skill and its examples state operator-only digest confirmation and do not describe a reviewer snapshot. The shared finding adds no second score. Effort stays 5 and architecture stays +1. |

Tests belong to the work item they validate. No negative architecture delta is claimed. Schema 0 support is retained on purpose, so this feature does not simplify away an existing path.

### Surface Snapshot

- Subsystems: 4
- Production files: 42
- Persistent/external boundaries: 2
- New shared abstractions or public contracts: 1
- New persistent schemas: 1

Subsystems are the plan-document projection, review governance and records, the migration commands, and shipped workflow assets. The production-file count is the Files Touched table. The two boundaries are the existing RecordStore streams and Git commit blobs. There is no new external service. The new abstraction is `loadPlanDocument`. The new persistent schema is the `plan-schema-migration` budget payload. Optional binding fields extend the version-1 payload and are not a second schema and not a SQLite migration. Phase 0 reconciles the file count if a cited module has moved. A new lock, a new stream, or a binding version bump requires this plan to be revised before that work is coded.

---

## Architecture Overview

```text
raw plan bytes (git blob / worktree file)
        |
        +-- recorded schema 0 --> checkbox-normalized raw bytes
        |
        +-- recorded or declared schema 1
                |
                loadPlanDocument
                |-- authorityMarkdown (space-filled non-governing lines, UTF-16 offsets preserved)
                |-- governingLines / comparisonBytes (notes removed, one-blank splice, checkbox-normalized)
                |-- structural errors (unsupported, malformed, duplicate, nested)
                |
     parsers, spans, budget, phases     drift and governingHash
                |
     approved binding (raw hash + optional schema 1 governing hash)
                |
     lineage: text amendments, frontier recoveries, plan-schema-migration
                |
     admission / phase finish / resume / run completion
```

Schema 0 lineage replay stays the current raw-byte replay. A `plan-schema-migration` record replaces the authorized raw bytes with its target and switches later comparison to schema 1. Text amendments after that record still store raw before and after hashes. Drift and schema 1 guard verification then compare `comparisonBytes` of the replayed raw document with `comparisonBytes` of the committed blob. The raw hashes remain the lineage identity.

```text
unapproved file -- 5x plan migrate --> ordinary plan review --> bind
approved source, no binding -- 5x review migrate-schema --> bind copies schema 1
bound execution, drifted or not -- 5x review migrate-schema --> lineage record
governing line added or edited -- refuse --> existing amend / recover-plan
```

---

## Phase 0: Confirm the seams

**Completion gate:** A short note in the implementation run records cites the current commit and confirms the line references in this plan, or lists the moved symbols. No product behavior changes in this phase.

- [ ] Confirm `detectPlanDrift`, `normalizeCheckboxMarkers`, `listImplementationTextAmendments`, `decodeImplementationBindingPayload`, and `atomicAppendIfAllNew` still match the citations in Overview. If plan 215 landed a different lineage reader, name it and use it in Phase 3.
- [ ] Confirm the binding decoder accepts unknown fields by ignoring them, and that omitting `planSchema` still decodes. Confirm the SQLite index skips unknown budget kinds.
- [ ] Confirm `template.handler.ts` and `invoke.handler.ts` both call `appendPlanReviewPromptContext`, and that both set the template override directory from `{stateDir}/templates/prompts`.
- [ ] Confirm a step named `schema-migration`, with `phase: null`, `iteration: 0`, and a `step_name` that does not start with `reviewer:`, `author:`, or equal `run:complete` or `phase:complete`, can be appended after `run:complete` on a completed source run without changing `terminalRoute`, `resolveFinalizedPlanCommit`, or `foldGoverningReviewState`. Phase 3 uses that shape.
- [ ] If any confirmation fails, revise this plan before Phase 1. Do not code around a different record or lock model.

---

## Phase 1: Plan document projection

**Completion gate:** Unit tests pass for schema 0, valid schema 1, notes, fences, splices, and malformed declarations. No caller outside the new module changes behavior yet.

### 1.1 `src/plan-schema/document.ts` — marker grammar and projection

**File:** `src/plan-schema/document.ts` (new)

Move `normalizeCheckboxMarkers` from `src/review-governance/plan-amendment.ts` lines 172–180 into `src/review-governance/plan-markdown.ts` and re-export it from `plan-amendment.ts`. The regex and the replacement stay the same. `document.ts` imports that function and does not import `implementation-state.ts`.

```typescript
export type PlanSchema = 0 | 1;
export type ExpectedPlanSchema = PlanSchema | "file";

export interface PlanNoteSpan {
	id: string;
	startLine: number;
	endLine: number;
}

export interface LoadedPlanDocument {
	raw: string;
	schema: PlanSchema;
	/** Schema 1: governing lines unchanged; every other line space-filled. Same line count and UTF-16 length as raw. Schema 0: the raw string. */
	authorityMarkdown: string;
	/** Post-splice checkbox-normalized governing line texts. Empty when none exist. */
	governingLines: readonly string[];
	/** Schema 1: `governingLines.join("\n")`. Schema 0: checkbox-normalized raw bytes. */
	comparisonBytes: string;
	notes: PlanNoteSpan[];
}

export type LoadPlanDocumentResult =
	| { ok: true; document: LoadedPlanDocument }
	| { ok: false; code: PlanSchemaErrorCode; message: string };

export type PlanSchemaErrorCode =
	| "PLAN_SCHEMA_INVALID"
	| "PLAN_SCHEMA_UNSUPPORTED";

export function loadPlanDocument(
	raw: string,
	expected: ExpectedPlanSchema,
): LoadPlanDocumentResult;
```

Expected schema 0 returns the raw string as `authorityMarkdown` and `normalizeCheckboxMarkers(raw)` as `comparisonBytes`, with `governingLines` split from that normalized string on `\r\n`, `\n`, or `\r` and with a trailing empty line removed only when the raw string ended in a newline. It does not read contract or note markers. Expected `"file"` uses schema 0 when no schema declaration line exists outside a fence. A single exact schema 1 declaration selects schema 1. Duplicate declarations, a declaration inside the contract, an unsupported version, a missing or extra contract marker, a mismatched note, a nested note, a note outside the contract, or a note that is not on a block boundary return `ok: false`. Expected schema 1 uses those same schema 1 rules and does not fall back when the declaration is absent.

`governingLines` for schema 1 are the raw texts of governing lines with line endings removed. The list omits note delimiter lines and note interiors. It applies the single blank-line splice from Design Decisions. It then runs `normalizeCheckboxMarkers` on each line. Schema 1 `comparisonBytes` is that list joined with `\n` and nothing else. Schema 0 `comparisonBytes` stays `normalizeCheckboxMarkers(raw)` and is not rebuilt from `governingLines`. Schema 0 `governingLines` is the split of that normalized string on `\r\n`, `\n`, or `\r`, dropping one trailing empty entry when the normalized string ends in a newline, so the migration diff does not invent a line from the terminator.

Export `PLAN_SCHEMA_AUTHORITY_INSTRUCTION` as the exact paragraph in Design Decisions.

- [ ] Add `loadPlanDocument` and the error codes above.
- [ ] Move checkbox normalization without changing its pattern, and re-export it.
- [ ] Reject note ids that are duplicated, empty, quoted with single quotes, or longer than 64 characters.
- [ ] Treat fenced marker examples as literal text. A schema 1 document may document the grammar inside a fence and still have one real contract.
- [ ] Space-fill non-governing lines. A non-ASCII status line above a governing line must leave that governing line's UTF-16 offset unchanged, and byte conversion of that offset must use the raw string.
- [ ] Cover the cases in the Tests table for W1, including a requirement copied into a note, a requirement moved into a note, and a contract end marker shifted to leave a requirement outside.

---

## Phase 2: Authority readers

**Completion gate:** Schema 0 fixtures keep today's drift, parse, span, and raw guard results. Schema 1 fixtures agree across `parsePlan`, `parseDeliveryBudget`, structural signature, and drift. A status edit outside the contract does not drift and does not invalidate an authorized amendment. A note in an earlier phase does not fail frontier recovery. A governing edit outside an authorized span does. Historical bindings still decode.

### 2.1 Expected schema and drift

**File:** `src/review-governance/implementation-state.ts`, `detectPlanDrift` at lines 192–216 and admission at lines 623–647

Add a helper that resolves the expected schema for a run: binding `planSchema` when present, otherwise schema 1 after a replayed migration record, otherwise schema 0. Pass that expected schema into `loadPlanDocument` for the approved lineage bytes and the current bytes. Drift is inequality of the two `comparisonBytes` values. Keep the existing chain-validity rules and the raw `approvedPlanHash` check. When the chain is invalid, do not use the migration target.

```typescript
export function detectPlanDrift(input: {
	approvedPlanBytes: string;
	approvedPlanHash: string;
	amendments: readonly ImplementationPlanAmendmentPayload[];
	currentPlanBytes: string;
	recordedSchema: 0 | 1;
	governingHash?: string;
}): PlanDriftResult;
```

For recorded schema 0, ignore `governingHash` and compare checkbox-normalized raw bytes, which is today's result. For recorded schema 1, require `governingHash` to match the approved document's comparison hash, and compare comparison bytes. A schema 1 current file that fails `loadPlanDocument` is drift with `PLAN_SCHEMA_INVALID` or `PLAN_SCHEMA_UNSUPPORTED` in the reason. The reason must say this is not a legacy fallback. Update `recoveryHelp` so schema 0 drift mentions `5x review migrate-schema --help` and `5x-plan-migration`, and still mentions `recover-plan` for semantic amendments.

Extend replay so a later Phase 3 migration record can appear in `amendments`. Until Phase 3 writes those records, replay behavior for existing kinds stays unchanged. Teach the replay function to accept the kind once the payload type exists; Phase 3 fills the writer.

- [ ] Thread `recordedSchema` through `detectPlanDrift` callers in `implementation-state.ts`, `implementation.ts` (about line 911), `implementation-boundary.ts` (about line 343), `implementation-recovery.ts` (about line 256), and `src/commands/implementation-review-context.ts` (about line 531).
- [ ] Schema 0 callers that have no field pass `recordedSchema: 0`.
- [ ] On bind (lines 1066–1120), parse the approved blob with file mode. A schema 1 blob stores `planSchema: 1` and `governingHash`. A schema 0 blob omits both. Ledger parsing uses `authorityMarkdown`.

### 2.2 Parsers and spans

**Files:** `src/parsers/plan.ts`, `src/parsers/delivery-budget.ts`, `src/review-governance/plan-markdown.ts`, `src/review-governance/plan-amendment.ts`

`parsePlan` and `parseDeliveryBudget` keep their current signatures and parse whatever string they are given. Callers that enforce authority pass `authorityMarkdown` instead of the raw file. Do not teach `parsePlan` a second Markdown dialect.

Display status and human version for schema 1 are read from the raw preamble by a small helper in `document.ts`, not from the mask. `parsePlan`'s `version` and `status` fields for schema 1 plans come from that helper. Phases, gates, and checklist items come from the mask. A checklist outside the contract contributes nothing to `completionPercentage`.

`resolvePlanImpactSpans` (`implementation.ts`, line 192) searches `authorityMarkdown`. Its stored byte offsets are raw offsets, using the raw anchor string and the mask's character indexes. `implementation.ts` around line 926 and `implementation-review-context.ts` around line 550 pass that mask as the search text and the replayed raw lineage as the byte source. On schema 1, `prepareTextAmendmentGuard` and `verifyGuardedPlanBytes` follow the projected-guard rules in Design Decisions. The guard record still stores the raw anchor. Schema 0 guards keep the current raw path. The unchanged check at `implementation-state.ts` lines 1430–1434 uses schema 1 `comparisonBytes` and stays checkbox-normalized raw bytes for schema 0.

Call sites that must pass the mask, using the run's expected schema or `"file"` when no approval exists:

- `implementation-state.ts` budget and phase reads at lines 469, 1076, and 1169
- `implementation-recovery.ts` lines 266, 327, and 329 for `parsePlan` and `parseDeliveryBudget`
- `src/review-budget/plan-repair.ts`, `ensure-baseline.ts`, and `apply.ts`
- `src/commands/plan-v1.handler.ts` line 398 and line 615, except the active-run rule below
- `src/commands/protocol.handler.ts` line 298
- `src/commands/run-v1.handler.ts` lines 1605, 2789, 3060, 3722, and 4620
- `src/commands/template.handler.ts` and `src/commands/invoke.handler.ts` budget parses used for admission

On schema 1, the earlier-phase loop in `implementation-recovery.ts` lines 299–320 does not compare raw slices and does not compare the mask. Blanked note lines would still be lines. Compare the `governingLines` of each earlier phase section, using the phase line bounds from the mask and the note-splice rule on the raw section. A note added in a completed earlier phase must not produce "Earlier phase … changed". Schema 0 keeps the current checkbox-normalized raw section comparison.

`5x plan phases` (`plan-v1.handler.ts`, line 398) uses file mode when the progress envelope has no `active_run`, or that run has no implementation binding. When `active_run` has a binding, it parses with that binding's expected schema. Expected schema 1 with missing or malformed markers exits `PLAN_SCHEMA_INVALID` or `PLAN_SCHEMA_UNSUPPORTED`, names the skill `5x-plan-migration`, and does not return a partial phase list. This command does not admit or migrate. A schema 0 binding still parses the raw file.

- [ ] Add one internal helper, `authoritativePlan(raw, expected)`, that returns the loaded document or a typed error, and use it at the call sites above.
- [ ] Keep schema 0 parse results identical for the existing parser fixtures.
- [ ] Add schema 1 fixtures where a phase heading, a checklist, and a delivery-budget table outside the contract or inside a note do not affect phases, completion, or the ledger.
- [ ] Add a span fixture whose `staleText` occurs only inside a note and is rejected, and a fixture whose governing `staleText` still resolves to the raw offset.
- [ ] Add a non-ASCII status line above a governing span. The span's raw byte offset must ignore the mask's spaces and use the raw string. Verification of that span still succeeds when only the status line differs.
- [ ] Add `plan-amendment.test.ts` and `implementation-state.test.ts` fixtures: a status edit followed by a span amendment verifies; a note followed by a span amendment verifies; a governing edit outside the span returns `PLAN_AMENDMENT_OUT_OF_SPAN`; a status-only committed blob on a live guard returns `unchanged` and writes no record; a budget-table or structural governing edit still fails; schema 0 guards stay on raw bytes.
- [ ] Add a recover-plan fixture in `test/unit/commands/implementation-recovery.test.ts` with a note in an earlier completed phase. Schema 1 recovery proceeds. Schema 0 still rejects a raw earlier-phase edit.

### 2.3 Binding codec

**File:** `src/review-budget/record-lines.ts`, lines 281–303 and the decoder at lines 442–512

Add the optional fields from Design Decisions. Encode them only when present. Decode accepts absence. Schema 1 without `governingHash` throws. `src/review-governance/sqlite-index.ts` must keep skipping unknown kinds and must still decode a schema 1 binding. If the index rejects extra JSON fields, stop and fix the decoder. Do not add a SQLite column.

- [ ] Round-trip a schema 0 binding and a schema 1 binding.
- [ ] Decode a historical fixture that has no schema fields.
- [ ] Reject `planSchema: 2` and schema 1 with an empty governing hash.

---

## Phase 3: Migration commands and records

**Completion gate:** The motivating status-sentence case is drift-blocked before the command and admitted after it, with the same ledger and the same phase records. An identical completed retry returns the stored payload and does not write a second record, including when that success has already made the expected schema 1. A distinct second migration is refused with `PLAN_MIGRATION_CONFLICT` and writes nothing. A changed target rejects the old digest. Schema 0 runs that do not migrate still drift on non-checkbox edits.

### 3.1 Payload and fold

**File:** `src/review-governance/schema-migration.ts` (new), plus `src/review-budget/record-lines.ts` and `src/control-plane/review-budget-store.ts`

```typescript
export interface PlanSchemaExclusion {
	id: string;
	approvedLine: number;
	approvedText: string;
	approvedTextHash: string;
}

export interface PlanSchemaNonGoverningLine {
	line: number;
	text: string;
}

export interface PlanSchemaMigrationPayload {
	kind: "plan-schema-migration";
	version: 1;
	id: string;
	runId: string;
	bindingId: string | null;
	fromSchema: 0;
	toSchema: 1;
	authority: "verified_equivalent" | "operator";
	parentLineageId: string | null;
	priorApprovalCommit: string;
	beforeCommit: string;
	afterCommit: string;
	beforeBlobHash: string;
	afterBlobHash: string;
	authorizedPlanBytes: string;
	governingHash: string;
	proposalDigest: string;
	exclusions: PlanSchemaExclusion[];
	nonGoverningText: PlanSchemaNonGoverningLine[];
	createdAt: string;
}
```

Idempotency key: `budget:plan-schema-migration:${runId}:${proposalDigest}`.

`proposalDigest` is the digest defined in Design Decisions. It binds `runId` and `nonGoverningTextHash`. It does not bind a reviewer snapshot, a per-exclusion `currentText`, `bindingId`, or `mode`. The command computes it. The operator does not invent it.

Extend the lineage list so replay order is journal order and includes text amendments, frontier recoveries, and this kind. Unknown kinds stay skipped. A migration is valid in the chain only when `fromSchema` is 0, `toSchema` is 1, `parentLineageId` matches the previous lineage id, `beforeBlobHash` matches the previous authorized raw hash, `afterBlobHash` equals `hashPlanBytes(authorizedPlanBytes)`, and the chain does not already contain a valid migration. After a valid migration, replay's schema is 1 and its authorized bytes are `authorizedPlanBytes`. A second migration in one chain fails closed.

`bind` (`implementation-state.ts`, lines 1066–1120) looks for one valid source-run migration when the execution run has no binding yet. Two source-run migrations are `PLAN_MIGRATION_CONFLICT` at migration time, so bind does not have to choose between them. It reads the plan at `afterCommit`, checks `governingHash`, checks ledger equality against the source baseline, and stores `planSchema: 1`, `governingHash`, `schemaMigrationId`, and `predecessorPlanCommit` equal to the original approval commit. `approvedPlanCommit` on that new binding is `afterCommit`. The source snapshot and baseline ids stay the original approval ids. If an execution binding already exists, bind does not apply the source migration.

- [ ] Add the codec and the lineage fold. Do not include `currentText`, `currentTextHash`, `snapshotId`, or `authority: "reviewer"`.
- [ ] Reject a migration record whose target is not valid schema 1.
- [ ] Add a store test that an unknown budget kind is still skipped and that this kind is folded once.

### 3.2 `5x plan migrate`

**Files:** `src/commands/plan-migrate.handler.ts` (new), `src/commands/plan-v1.ts`

```text
5x plan migrate --plan <path> --mode equivalent|selective [--write] [--dry-run]
```

The command refuses, without writing, when any run for that plan path has an implementation binding or a completed plan-review approval. The error tells the operator to use `5x review migrate-schema`. Otherwise it builds a schema 1 document with the skeleton layout from Design Decisions. Equivalent mode wraps the entire current file as the contract interior and preserves bytes except the one allowed trailing newline. Selective mode is an explicit file edit the operator already made; the command only checks that the file is valid schema 1, prints every original line that is no longer governing, and writes nothing unless `--write` is set and `--dry-run` is absent. It appends no record and it does not approve the plan. The success text says to submit the file through ordinary plan review.

- [ ] Register the command on the existing `plan` parent in `plan-v1.ts`.
- [ ] Refuse governed plans.
- [ ] Equivalent `--write` is idempotent on an already wrapped schema 1 file whose interior matches.

### 3.3 `5x review migrate-schema`

**Files:** `src/commands/review.ts`, `src/review-governance/schema-migration.ts`

```text
5x review migrate-schema \
  --run <id> \
  --commit <sha> \
  --mode equivalent|selective \
  [--dry-run] \
  [--confirm-exclusions <digest>]
```

The run is either a bound execution run or an approved plan-review run with no execution binding. Any other run is refused with a pointer to `5x plan migrate`. The command does not call admission and therefore runs while admission would return `IMPLEMENTATION_PLAN_DRIFT`. It has no `--snapshot` argument.

`--commit` must be a full sha. The target must load as schema 1. The source bytes are the replayed authorized lineage, or the approved commit when no binding exists.

On a bound execution run, the mapped worktree plan blob must equal that commit, including checkbox bytes, using the same exact-match rule as recover-plan (`implementation-recovery.ts`, line 170). On an approved source plan-review run, resolve the plan path from the run record. If a linked worktree still exists, require that same exact match. If no worktree exists, read the blob with `git show <commit>:<plan path>` and do not require a worktree. Do not treat a missing worktree as an empty file.

Before dry-run output that offers a new migration, and before any write, resolve an existing `plan-schema-migration` on this run whose `proposalDigest` and `afterBlobHash` equal this attempt. If that record exists, return it with `created: false` and `completionAuthorized: false`. Do this even when the binding now has `planSchema: 1` or the lineage already contains that migration. Do not return `PLAN_MIGRATION_CONFLICT` for this identical retry.

If no identical record exists, refuse with `PLAN_MIGRATION_CONFLICT` and write nothing when any of these is true: the execution binding has `planSchema: 1`, replay of the lineage already contains a valid migration, or the source run already has a migration record. A distinct target or digest is not an identical retry. This refusal runs before `atomicAppendIfAllNew`, so a second migration cannot append under a new idempotency key.

Otherwise build the exclusion list and `nonGoverningText` with the diff in Design Decisions. Equivalent mode requires an empty exclusion list and `governingLines` equality, including the trailing-newline allowance, and records `authority: "verified_equivalent"`. Selective mode requires a non-empty exclusion list, no added governing lines, and `--confirm-exclusions` equal to the digest. It records `authority: "operator"`. The dry-run prints each exclusion's id, approved line, and approved text, the `nonGoverningText` block, the digest, `authority` left unset, `completionAuthorized: false`, and the unchanged ledger summary. Dry-run writes nothing.

Recording requires `--mode equivalent`, or `--confirm-exclusions` equal to the digest. The target ledger must deep-equal the approved ledger. Failure codes are `PLAN_MIGRATION_NOT_EQUIVALENT`, `PLAN_MIGRATION_GOVERNING_CHANGE`, `PLAN_MIGRATION_STALE`, and `PLAN_MIGRATION_CONFLICT`.

The successful write is one `atomicAppendIfAllNew` batch: the budget payload and a step named `schema-migration`. The step has `phase: null`, `iteration: 0`, and `step_name: "schema-migration"`. Its name does not start with `reviewer:` or `author:` and it is not `run:complete` or `phase:complete`. Its idempotency key also contains the digest. Pass `expectedKeys` as the full budget, steps, and decisions key lists captured for that attempt. On `created: false`, return the stored payload only when its digest and target hash match; otherwise `PLAN_MIGRATION_CONFLICT`. On `RECORD_PRECONDITION_FAILED`, tell the operator to repeat the dry-run. Do not invalidate phase evidence. The result always includes `completionAuthorized: false`.

- [ ] Implement equivalent migration and selective operator confirmation. Do not implement a reviewer or snapshot path.
- [ ] Implement the motivating status-sentence fixture end to end through admission.
- [ ] Prove an identical completed retry returns the stored winner before the schema 1 refusal, a distinct second migration on a schema 1 binding or an already migrated lineage or source run is `PLAN_MIGRATION_CONFLICT` and writes nothing, and a stale confirmation writes nothing.
- [ ] Prove repeated blank governing lines always produce the same exclusion ids, and that `nonGoverningText` is what dry-run shows as the current text.
- [ ] Prove a retained governing edit is rejected and the existing recover-plan help is included in that error.
- [ ] Prove `expectedKeys` includes the decisions stream.
- [ ] Prove a schema 0 run that never migrates still drifts on a status edit, and a migrated run with the markers deleted fails `PLAN_SCHEMA_INVALID` rather than reading as schema 0.
- [ ] Prove the `schema-migration` step appended after `run:complete` leaves `terminalRoute`, `resolveFinalizedPlanCommit`, and `foldGoverningReviewState` unchanged.

---

## Phase 4: Workflow assets

**Completion gate:** The focused acceptance suite passes, the authority paragraph is present on bundled and override-rendered native and invoke prompts, and a fresh harness install contains `5x-plan-migration`. Schema 0 diagnostics still describe legacy plans as supported.

### 4.1 Skeleton and skills

**Files:** `src/templates/default-artifacts.ts`; `src/skills/loader.ts` lines 20–26; `src/skills/base/5x/SKILL.tmpl.md`; `src/skills/base/5x-plan/SKILL.tmpl.md`; `src/skills/base/5x-plan-review/SKILL.tmpl.md`; `src/skills/base/5x-phase-execution/SKILL.tmpl.md`; `src/skills/base/5x-plan-migration/SKILL.tmpl.md` (new)

Change the default implementation-plan skeleton to schema 1 using the inside/outside split in Design Decisions. Keep the visible budget columns and checklist syntax. Put generator examples outside the contract or label them so they cannot become real headings or rows. Do not put a schema declaration on already-shipped historical plan documents in the repo.

`5x-plan` and `5x-phase-execution` teach schema 1: where status and revision history go, how to add a note block, and that governing edits need an amendment. A status or note edit does not require a new text-amendment guard and does not invalidate one that already exists. `5x-plan-review` tells the reviewer to judge the contract outside notes, to treat other text as context, and to warn the operator about apparent requirements in that context. A review note is not an approval record. Reviewer templates do not grant authority to approve a schema migration.

`5x-plan-migration` is a separate skill. It covers how to read recorded schema from the binding or from `5x review migrate-schema --dry-run`, how to find the approved baseline and amendment lineage, how to propose a contract boundary, how equivalent and selective modes differ, how the operator confirms the exclusion digest, what the CLI error codes mean, and how to resume after a successful migration. It does not describe a reviewer snapshot, a `--snapshot` flag, or reviewer authority for migration. It says equivalent mode leaves `**Status:**` inside the contract, so later status edits still drift, and that selective mode is the path for the motivating status-line case. It tells the operator not to treat a missing marker as migration eligibility. Schema 0 without a migration record is legacy and remains valid. Schema 1 with missing markers is malformed. The skill documents only the 0 to 1 transition. It states that future removal of this skill must not be required to decode historical `plan-schema-migration` records; the record codec remains the interpreter.

The foundation `5x` skill only points at `5x-plan-migration` for schema transitions. It does not inline the procedure. Register the new template in `BASE_SKILL_TEMPLATES`. Harness install already iterates `listBaseSkillNames()` (`src/harnesses/universal/plugin.ts`, `src/harnesses/opencode/skills/loader.ts`, `src/harnesses/cursor/skills/loader.ts`), so a registered skill is installed and uninstalled with the others. Do not special-case the name in each harness.

- [ ] Update the skeleton and the four existing skills.
- [ ] Add and register `5x-plan-migration`.
- [ ] Keep the foundation skill to a pointer.

### 4.2 Templates, runtime append, and overrides

Bump the `version` frontmatter on every template edited below so `loadTemplate` (`src/templates/loader.ts`, lines 329–336) warns when an on-disk override is older than the bundle.

Add `PLAN_SCHEMA_AUTHORITY_INSTRUCTION` to:

- `src/templates/author-generate-plan.md`
- `src/templates/author-next-phase.md` (near line 37)
- `src/templates/author-process-plan-review.md` (near line 41)
- `src/templates/author-process-impl-review.md` (near lines 43–44)
- `src/templates/author-fix-quality.md` (near lines 45–46)
- `src/templates/reviewer-plan.md`
- `src/templates/reviewer-plan-continued.md`
- `src/templates/reviewer-commit.md`
- `src/templates/reviewer-commit-continued.md`

Also append that same constant from `appendPlanReviewPromptContext` so native and invoke renders include it once, even when the selected template source is `"override"` (`getTemplateSource` in `loader.ts`, lines 109–113). Do not duplicate the paragraph if the template body already contains it. Author templates may allow checkbox toggles, note edits, and edits outside the contract on schema 1 plans. Those edits do not invalidate an authorized text-amendment span. Templates still forbid governing edits except inside an authorized span. Schema 0 plans keep the current instruction that any non-checkbox edit drifts.

Configured resolution stays the existing override directory used by both handlers. Tests must render a bundled template and an override fixture that omits the paragraph, for both the template command path and the invoke path, and assert the rendered prompt contains the paragraph exactly once.

- [ ] Update the nine templates and the shared append.
- [ ] Assert native and invoke parity, including a stale override.
- [ ] Leave project override files on disk untouched.

### 4.3 Diagnostics and acceptance

Drift and schema errors that mention recovery include the command `5x review migrate-schema --help` and the skill name `5x-plan-migration`. Schema 0 wording says legacy behavior is still supported. Schema 1 wording says missing markers are malformed input.

Run and extend:

```bash
bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts
```

Upgrade coverage must show a new install receives `5x-plan-migration`, an existing install gains it through harness sync, and an overridden `5x-plan` or `5x-phase-execution` is not silently rewritten. The governance skill test must keep its current assertions and also require the authority paragraph in `5x-phase-execution` and in the rendered `author-next-phase` prompt.

- [ ] Point recovery diagnostics at the migration command and skill.
- [ ] Pass the focused acceptance suite and the new render tests.
- [ ] Document in the migration skill that schema 1 runs and migrated runs need a CLI that records `planSchema`. Older CLIs fail closed by treating informational edits as raw drift.

---

## Files Touched

| File | Change |
|------|--------|
| `src/plan-schema/document.ts` | New projection, space-filled mask, `governingLines`, and authority instruction constant |
| `src/review-governance/plan-markdown.ts` | Host `normalizeCheckboxMarkers` so projection and guards share it |
| `src/review-governance/plan-amendment.ts` | Re-export checkbox normalization. Schema 1 guards verify projected spans. Schema 0 stays raw |
| `src/parsers/plan.ts` | No dialect change; callers supply the mask |
| `src/parsers/delivery-budget.ts` | No dialect change; callers supply the mask |
| `src/review-governance/implementation-state.ts` | Expected schema, governing drift, bind fields, migration-aware replay, schema 1 unchanged check |
| `src/review-governance/implementation.ts` | Span resolution on the mask with raw byte offsets; drift caller passes recorded schema |
| `src/review-governance/implementation-boundary.ts` | Drift caller passes recorded schema |
| `src/review-governance/implementation-recovery.ts` | Ledger parses use the mask. Schema 1 earlier-phase sections compare `governingLines`. Exact commit check stays raw |
| `src/commands/implementation-review-context.ts` | Guard snapshot searches the mask, stores the raw anchor, and passes recorded schema |
| `src/review-governance/schema-migration.ts` | Migration validation, deterministic exclusion diff, digest, and atomic registration |
| `src/review-governance/context.ts` | Append the authority instruction once for native and invoke |
| `src/review-governance/sqlite-index.ts` | Keep skipping unknown kinds; decode schema 1 bindings |
| `src/review-budget/record-lines.ts` | Optional binding fields and migration payload codec |
| `src/review-budget/plan-repair.ts` | Repair against the authority mask |
| `src/review-budget/ensure-baseline.ts` | Baseline ledger from the authority mask |
| `src/review-budget/apply.ts` | Snapshot ledger from the authority mask |
| `src/control-plane/review-budget-store.ts` | Fold migration records into lineage order |
| `src/commands/plan-v1.ts` | Register `plan migrate` |
| `src/commands/plan-migrate.handler.ts` | Pre-approval wrap and selective report |
| `src/commands/plan-v1.handler.ts` | File mode when unbound; expected schema for the active run's binding. Schema errors name the migration skill |
| `src/commands/review.ts` | Register `review migrate-schema` without a snapshot flag |
| `src/commands/run-v1.handler.ts` | Phase finish, resume, and relink use expected schema |
| `src/commands/protocol.handler.ts` | Protocol plan reads use expected schema |
| `src/commands/template.handler.ts` | Admission parse uses expected schema |
| `src/commands/invoke.handler.ts` | Same admission parse and the shared prompt append |
| `src/skills/loader.ts` | Register `5x-plan-migration` |
| `src/skills/base/5x/SKILL.tmpl.md` | Pointer to the migration skill only |
| `src/skills/base/5x-plan/SKILL.tmpl.md` | Schema 1 authoring rules |
| `src/skills/base/5x-plan-review/SKILL.tmpl.md` | Review the contract; warn on conflicting context |
| `src/skills/base/5x-phase-execution/SKILL.tmpl.md` | Notes and outside-contract edits; governing edits still need amendment |
| `src/skills/base/5x-plan-migration/SKILL.tmpl.md` | New skill for the 0 to 1 transition, operator digest confirmation, and resume steps |
| `src/templates/default-artifacts.ts` | Schema 1 skeleton with bookkeeping outside the contract |
| `src/templates/author-generate-plan.md` | Authority instruction and schema 1 output rules |
| `src/templates/author-next-phase.md` | Schema 1 edit rules next to the checkbox rule |
| `src/templates/author-process-plan-review.md` | Authority instruction for plan revisions |
| `src/templates/author-process-impl-review.md` | Note and preamble edits; governing bytes stay guarded |
| `src/templates/author-fix-quality.md` | Same plan-edit boundary |
| `src/templates/reviewer-plan.md` | Governing contract is the review scope |
| `src/templates/reviewer-plan-continued.md` | Same scope on continued review |
| `src/templates/reviewer-commit.md` | Plan-impact spans refer to governing text |
| `src/templates/reviewer-commit-continued.md` | Same span rule on continued commit review |

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/plan-schema/document.test.ts` | Valid schema 1; duplicate and unsupported versions; markers inside fences stay literal; nested, mismatched, and mid-paragraph notes fail; note insertion between paragraphs and checklist items does not change comparison bytes; wrapping or deleting a governing line does; copying a line into a note does not; schema 0 ignores contract markers; a non-ASCII status line does not move the following governing line's UTF-16 offset; schema 0 `comparisonBytes` stays checkbox-normalized raw bytes |
| Unit | `test/unit/parsers/plan.test.ts` | Existing schema 0 fixtures stay stable. Schema 1 ignores outside and note phases, gates, and checklist items. Status outside the contract does not change phase completion |
| Unit | `test/unit/parsers/delivery-budget.test.ts` | A budget table outside the contract or inside a note is not the ledger. The in-contract table still parses, including debt claims |
| Unit | `test/unit/review-governance/plan-amendment.test.ts` | Governing `staleText` keeps raw offsets computed from the raw string. Note-only `staleText` does not match. A status edit, including one already present before the guard, followed by a span amendment verifies. A note followed by a span amendment verifies. A governing edit outside the span is `PLAN_AMENDMENT_OUT_OF_SPAN`. A note or status difference is not `PLAN_AMENDMENT_STALE`. Budget and structural protections still fail closed. Schema 0 guards stay raw. Checkbox normalization stays byte-length preserving |
| Unit | `test/unit/review-governance/implementation-state.test.ts` | Schema 0 drift matches current checkbox-only behavior. Schema 1 allows status and note edits and rejects governing edits. A status-only blob on a live guard returns `unchanged` and writes no amendment, while a span change records the raw blob and raw hashes. Missing markers on schema 1 are invalid, not schema 0. Historical bindings without schema fields decode |
| Unit | `test/unit/commands/implementation-recovery.test.ts` | A note in an earlier completed phase does not make schema 1 frontier recovery reject. Schema 0 still rejects a raw earlier-phase edit |
| Unit | `test/unit/review-governance/schema-migration.test.ts` | Equivalent proof; selective manifest with stable exclusion ids for repeated blanks; `nonGoverningText` in the digest; stale digest; ledger mismatch; identical completed retry returns the stored record before a schema 1 refusal; a distinct second migration and a migration on an already schema 1 binding do not append; decisions are in `expectedKeys`; precondition failure writes nothing. No reviewer or snapshot path. Uses the `atomicAppendIfAllNew` behavior covered by `test/unit/control-plane/record-store-contract.test.ts` |
| Unit | `test/unit/skills/implementation-review-governance.test.ts` | Existing governance assertions hold. Rendered phase-execution skill and author-next-phase prompt contain the authority paragraph once |
| Integration | `test/integration/commands/plan-migrate.test.ts` | Pre-approval equivalent wrap, refusal when an approval or binding exists, no record written |
| Integration | `test/integration/commands/migrate-schema.test.ts` | Motivating status-sentence recovery on a drift-blocked run; admission succeeds afterward; phase records and ledger stay; identical retry returns the prior result; a distinct second migration is refused; deleted markers on the migrated run fail closed; a never-migrated schema 0 status edit still drifts. No reviewer snapshot |
| Integration | `test/integration/commands/upgrade.test.ts` | Fresh install and harness sync include `5x-plan-migration`. Overridden planning skills are not rewritten. Native and invoke renders of an override template still contain the authority instruction |

Parser agreement is the schema 1 fixture shared by the plan, budget, signature, and drift tests: each must report the same phase ids, the same ledger work-item ids, and the same comparison hash. Do not add tests that require an LLM to classify note prose. Assert the instruction string is rendered.

---

## Not In Scope

- **Retiring schema 0** — legacy plans and historical approvals stay valid. A later feature can stop accepting new schema 0 approvals.
- **Migrations other than 0 to 1** — no registry of future schemas and no schema 2 parser.
- **Semantic classification of notes** — operators and agents do that. The CLI checks structure, digests, and bytes. Text-amendment verification is literal fixed segments on the governing projection.
- **Replacing `recover-plan` or plan 215 `amend`** — governing changes still use those paths. Migration rejects them.
- **Rebasing schema 0 text-amendment offsets** — schema 0 guards stay on raw bytes. Schema 1 maps spans at verification time and does not treat a note or status edit as a stale guard.
- **Reviewer approval of selective migration** — this feature confirms selective exclusions only with the operator digest. The payload has no reviewer authority and no snapshot id.
- **Resetting budgets, decisions, phase evidence, or run identity** — migration does not do this even for selective exclusions of bookkeeping text.
- **Rewriting project template or skill overrides** — stale overrides warn, and the runtime append supplies the authority paragraph.
- **Doctor repairs for plan drift** — drift stays an admission error with a migration diagnostic. `5x doctor` does not rewrite plans.
- **Activating schema 1 on this plan file** — this document remains an unversioned plan until the feature exists.

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 0 | Confirm cited seams | 1 day |
| 1 | Projection and grammar tests | 2 days |
| 2 | Authority readers and binding fields | 3 days |
| 3 | Migration records, commands, and recovery tests | 3 days |
| 4 | Skills, templates, diagnostics, and asset acceptance | 2 days |
| **Total** | | **11 days** |

---

## Provenance

Approved runs currently block ordinary living-plan edits because drift ignores checkbox state and nothing else (`implementation-state.ts`, lines 202–214). The agreed requirements in `5x-cli/docs/development/plan-schema-contract-requirements.md` call for a versioned execution contract, a shared governing projection, and a recorded schema 0 to schema 1 migration that preserves approval lineage. This plan is that implementation plan. It follows the binding and lineage rules already shipped by plans 210 and 215, and it does not implement those features again.

---

## Revision History

### v1.1 (October 29, 2026) — Projected guards and operator-only migration

Addresses the staff review of commit `5076f83b` in `5x-cli/docs/development/reviews/.5x-worktrees-216-plan-schema-contracts-and-migration-plan-768a25-5x-cli-docs-development-plans-216-plan-schema-contracts-and-migration-plan-review.md`. That review has no addendum.

- **P0.1:** Schema 1 text-amendment guards resolve spans on the space-filled mask and verify them with literal `fixedSegmentsMatch` on the governing projection. Status and note edits do not invalidate a guard before or during verification. Raw anchors, raw `authorizedPlanBytes`, and raw before/after hashes stay the lineage identity, so ordinary admission can return `unchanged` without writing a record and registration still stores the committed raw blob. Schema 0 guards and budget and structural protections stay in force. The plan no longer says a note insertion makes a schema 1 guard stale.
- **P1.1:** Non-governing lines are space-filled so UTF-16 offsets match the raw file. Byte conversion slices the raw string.
- **P1.2:** Schema 1 frontier recovery compares earlier-phase `governingLines`, not raw slices and not the mask.
- **P1.3:** Selective migration is operator digest confirmation only. Reviewer snapshot authority is removed from the payload, command, tests, skills, and scores. Equivalent migration stays a mechanical proof.
- **P1.4:** An identical completed migration returns the stored result before any schema 1 refusal. A distinct second migration is `PLAN_MIGRATION_CONFLICT` and does not append.
- **P1.5:** Exclusions use earliest-match LCS over governing lines, with ids from approved line numbers. Current text is one `nonGoverningText` block, not a per-exclusion pairing.
- **P2.1:** `expectedKeys` includes the decisions stream.

The same revision records the nonblocking seams that were already mechanical: the digest binds `runId`; the migration step uses `phase: null` and `iteration: 0`; source-run migration checks a linked worktree when one exists and otherwise checks the commit blob; `5x plan phases` uses the active run's expected schema when that run has a binding; the migration skill says selective mode is the status-line path. Work-item IDs W1–W4 and their effort and architecture scores are unchanged. No re-estimate was applied. The requirements file is now in this branch and states the same operator decisions. This plan stays an unversioned schema 0 document. This is a documentation-only revision: no product code, tests, or quality gates were run.
