# Review-Budget Advisory Foundation

**Version:** 1.7
**Created:** August 29, 2026
**Status:** Draft — revision 1.7 coordinating origin-writer contract with slice 10 (`212` 1.5 / P0.8)

---

## Executive Summary

Plan review today has no priced scope. Reviewers emit `auto_fix` items with equal weight, continued reviews restart exhaustive discovery, and the only stop is `maxReviewIterations` after growth has already landed. This slice adds the advisory half of area 206: newly generated plans carry a scored `Delivery Budget` table; the CLI parses it, captures an immutable baseline `B0` once before the first reviewer, and records deterministic forecasts (`W`, `R`, `S`, `N`, `D`, `E`, `A`, `P`, bands, alerts, `requiresHuman`) as telemetry.

Advisory mode **does not change v1 routing**. `requiresHuman` is recorded, not acted on. `mode = "enforced"` is a reserved config value treated as advisory until `07-plan-review-governance`. Implementation-review contracts, debt-credit realization, human budget gates, and dashboard UI stay out.

### Scope

**In scope:**

- Required `Delivery Budget` + surface-snapshot sections in newly generated plans, with a fail-closed parser for stable IDs, effort, architecture delta, complete plan-side debt-claim evidence (`targetPhase`, minimal-compliant comparison, non-empty before/after), and `Addresses`.
- `[reviewBudget]` config (`off` | `advisory` | reserved `enforced`), default `advisory`, layered like the rest of `5x.toml`.
- Authoritative persistence of immutable `B0`, governing `B`, original/current ledgers, surface snapshot, assessments, and claims as **RecordStore budget lines** (slice 06 owns line payloads and keys; slice 10 owns the frozen `RecordStore` interface). SQLite holds only a rebuildable derived index/cache of those lines plus CLI-computed forecasts.
- Plan-review protocol emit/validate extensions: per-item deltas, `baselineAssessment`, `creditAssessments`. CLI-owned aggregates are derived, never reviewer-authored.
- Pure arithmetic module for ceilings, bands, alerts, baseline direction, and `Addresses` dedup.
- Decorated recorded reviewer steps and `5x run state` output.
- Existing-plan preflight and mid-review v1-compat / explicit opt-in.

**Out of scope:**

- Changing author/reviewer loop routing, `ready_with_corrections` normalization, or budget-specific human gates (`07-plan-review-governance.plan-input.md`).
- Implementation-review `scopeClass` enum, `--credit-realization`, `planImpact`, or quality-gated final corrections (`08-implementation-review-governance.plan-input.md`).
- Dashboard / browser visualization.
- Calibration of default percentages.
- Implementing `RecordStore`, its working-tree JSONL layout, `records index` / `records backfill` CLI, `.gitattributes`, or progress resolution (owned by slice 10). This slice **consumes** the frozen Phase-1 interface and defines only budget-line payloads, idempotency keys, and the SQLite index projection.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Pure arithmetic in `src/review-budget/`, not handlers** | Area 206 risk: “budget arithmetic is spread across handlers.” One module, integer `Math.ceil` / `Math.floor` / `Math.max` / `Math.min`, exhaustive fixtures including the documented `B = 4` example. |
| **Fail-closed plan parse; never silent `B0 = 0`** | Plan-input assumption. Missing/malformed tables **or incomplete debt-claim evidence** error with line-numbered diagnostics. Empty tables are not a zero baseline. Negative rows without `targetPhase` / comparison / before/after cannot establish a ledger claim. |
| **`ReviewBudgetStore` is a RecordStore facade, not a SQLite authority** | Same `src/control-plane/` boundary as `PromptStore`. Handlers never import `bun:sqlite`. UUID ids on record payloads (`200` §3a #2). The facade appends/reads budget lines through frozen `RecordStore`; SQLite is a rebuildable index of those lines plus derived forecasts (`207` §2.5–2.6). |
| **Append-only snapshots; `B0` INSERT-once** | Editing plan prose must not rewrite the baseline. `captureBaseline` is CAS on the baseline budget-line idempotency key (`budget:baseline:<runId>`). Governing `B` is initialized to `B0`; human `B` changes are slice 07. |
| **Slice 10 Phase 1 is a hard prerequisite to persistence** | Canonical `207` §2.6 and plan-input 10 require slice 06 to code against the frozen `RecordStore` + in-memory impl, never SQLite-only rows. This slice does **not** define or fork `RecordStore`. Persistence phases wait for that freeze (including budget-stream append/read and atomic multi-append). |
| **Advisory never changes routing** | `budget.requiresHuman` is telemetry. Do not rewrite `readiness`, skip author cycles, or call `5x prompt`. `enforced` is accepted in config and recorded, then treated as advisory with a warning. |
| **v1 verdicts remain valid** | New item fields are optional at the protocol schema layer. They become required only when the run has an active baseline (`status = active`). Mid-review runs without a baseline stay `v1_compat`. |
| **Reject reviewer-authored aggregates** | If input contains `budget`, `budgetBand`, `B0`, `W`, `R`, `S`, `E`, `A`, `P`, `baselineDirection`, or similar CLI-owned keys, fail `INVALID_STRUCTURED_OUTPUT`. Do not strip-and-continue. |
| **`Addresses` + still-listed items define `R`** | Incorporated finding IDs drop out of `R` unless they still appear in the current verdict `items` (incomplete author claim). Explicit `addressed` / `still_open` enums are slice 07. |
| **No implementation-review fields** | Do not add `--credit-realization`, four-class `scopeClass`, `planImpact`, or `priority` requirements. Plan-review `scopeClass` is `acceptance_required` \| `risk_reduction` \| `polish` only. |
| **Shared pre-append admission before any RecordStore write** | `RecordStore.atomicAppend` cannot un-append a terminal-run or over-limit step. Extract `prepareRecordStepAppend` from today’s `recordStepInternal` body (`src/commands/run-v1.handler.ts:1201–1299`) and call it from **both** `recordStepInternal` and `recordPlanReviewerStepWithSnapshot` **before** constructing or sending an append. Admission preserves active-run, fail-closed execution-context/worktree, JSON, `maxStepsPerRun`, idempotency, complete metadata assembly, and duplicate-at-limit as a no-op/repair. Terminal-run, missing-worktree, invalid-result, and new-at-limit failures call no `atomicAppend` and leave both record streams and index projections unchanged. The admit result is slice 10’s `PreparedRecordStep` **including `performer`** — do not redeclare a local `{ stepInput, maxSteps }` shape that drops it. |
| **Budget writers consume slice 10’s origin factory** | `review-budget-context.ts` embeds `createRecordContext` (`originFor` / `redactedRecorder` / `recordStore`). Paired step+snapshot ops stamp `recordedEnvelope(ctx.originFor(prepared.performer))`. Baseline-only `captureBaseline` requires `origin` from `ctx.originFor(performer)`. This slice does not construct `RecordOrigin` inline (`212` §1.5). |
| **Snapshot + reviewer step are one RecordStore atomic append** | Appending a budget snapshot before the unique step record orphans telemetry when the step insert fails or a retry races. `apply` returns a pending snapshot; persist it in the **same** `RecordStore.atomicAppend` as the unique step line **only after** `prepareRecordStepAppend` admits the step, then project both into the SQLite index. Failed unique appends insert no budget line and no index row. Idempotent retries (`created: false`) append no second line, but load the existing step/snapshot lines and idempotently upsert both SQLite projections (repair after a projection failure). Duplicate-at-limit is the same repair path: admission returns duplicate, so the wrapper never appends. |
| **First-review `baselineAssessment` is a record field, not cache-only** | `BudgetSnapshotPayload.baselineAssessment` is the authoritative initial `I`. The facade record, v8 snapshot index, encode/decode, and reindex all carry that optional field. After an index wipe, `deriveBudget` recomputes identical `I` and `baselineDirection` from the record line. Do not reconstruct `I` from `derived_json`. |
| **`BaselineAssessment` is a Phase 1 domain type** | Snapshot payload, facade, codec, and index rebuild (Phase 4) must compile before protocol emit/validate (Phase 5). Declare the shared structural type in `src/review-budget/types.ts`. `src/protocol.ts` imports and re-exports it; it does not declare a second copy. |
| **Carry forward unchanged debt-claim assessments** | First-seen (or changed) claims require a current `--credit-assessment`. Unchanged includes evidence fields (`targetPhase`, minimal deltas, before/after), not only coupling and architectureDelta. Current assessments overlay by `creditClaimId` and must name a persisted claim. |
| **Snapshot order is insertion-stable** | Record lines are append-only; `latestSnapshot` / `listSnapshots` follow `RecordStore` insertion order (memory: sequence; working-tree JSONL: file order). The SQLite index stores that sequence and must not order by `created_at` alone (`datetime('now')` is second-resolution). |
| **Plan-side debt claims persist full §4.3 evidence** | A negative author row cannot earn `N`/`D` from `DCn` + coupling alone. The parser requires `targetPhase`, minimal-compliant effort/architecture deltas, and non-empty before/after on every negative claim; ledger JSON is what later implementation review reconciles. `--credit-assessment` names that persisted id; reviewer-item `creditClaim` is only for claims the reviewer introduces. |

### References

- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — §3.2 budget run-state; §3a store / UUID constraints; §4 advisory rollout.
- [`docs/v2/206-review-budget-governance.md`](../../v2/206-review-budget-governance.md) — canonical model, contracts, persistence, config, staged rollout.
- [`docs/v2/207-state-segmentation.md`](../../v2/207-state-segmentation.md) — §2.6 budget baselines/ledgers/decisions are **record** tier; forecasts are derived cache; slice 06 codes against frozen `RecordStore`.
- [`docs/v2/plan-inputs/10-git-native-run-records.plan-input.md`](../../v2/plan-inputs/10-git-native-run-records.plan-input.md) — Phase 1 freezes `RecordStore` + in-memory impl; slice 06 defines budget lines and must never target SQLite-only rows.
- [`docs/v1/100-architecture.md`](../../v1/100-architecture.md) — CLI as toolbelt; protocol validate/record.
- [`docs/v1/101-cli-primitives.md`](../../v1/101-cli-primitives.md) — `run state`, `protocol emit` / `validate`.
- Plan input: [`docs/v2/plan-inputs/06-review-budget-advisory.plan-input.md`](../../v2/plan-inputs/06-review-budget-advisory.plan-input.md).
- [`212-git-native-run-records-plan.md`](./212-git-native-run-records-plan.md) — Phase 1 freezes `RecordStore` + in-memory impl **and** the origin-writer context (`RecordCommandContext.originFor`, `PreparedRecordStep.performer`). This slice consumes that freeze; it does not fork origin construction.
- Predecessor store pattern: [`205-prompt-queue-foundation-plan.md`](./205-prompt-queue-foundation-plan.md).
- Follow-on: [`docs/v2/plan-inputs/07-plan-review-governance.plan-input.md`](../../v2/plan-inputs/07-plan-review-governance.plan-input.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Architecture Overview](#architecture-overview)
4. [Phase 1: Domain types and pure arithmetic](#phase-1-domain-types-and-pure-arithmetic)
5. [Phase 2: Delivery Budget parser](#phase-2-delivery-budget-parser)
6. [Phase 3: `reviewBudget` configuration](#phase-3-reviewbudget-configuration)
7. [Phase 4: Budget record lines, RecordStore facade, and rebuildable index](#phase-4-budget-record-lines-recordstore-facade-and-rebuildable-index)
8. [Phase 5: Protocol types, emit, and normalize](#phase-5-protocol-types-emit-and-normalize)
9. [Phase 6: Validate, derive, persist, decorate](#phase-6-validate-derive-persist-decorate)
10. [Phase 7: Baseline capture, preflight, mid-review opt-in](#phase-7-baseline-capture-preflight-mid-review-opt-in)
11. [Phase 8: Run-state output](#phase-8-run-state-output)
12. [Phase 9: Templates, skills, and docs](#phase-9-templates-skills-and-docs)
13. [Phase 10: Integration, compatibility, and exports](#phase-10-integration-compatibility-and-exports)
14. [Files Touched](#files-touched)
15. [Tests](#tests)
16. [Not In Scope](#not-in-scope)
17. [Estimated Timeline](#estimated-timeline)
18. [Revision History](#revision-history)
19. [Provenance](#provenance)

---

## Overview

v1 plan review classifies items as `auto_fix` or `human_required` and routes solely on `readiness`. There is no work-item ledger, no baseline, and no CLI-owned forecast. `parsePlan` (`src/parsers/plan.ts:34–167`) reads phases and checklists only. `ReviewerVerdict` (`src/protocol.ts:16–28`) has `readiness`, `items[]` (`id`, `title`, `action`, `reason`, optional `priority`), and optional `summary`. `protocol emit reviewer` (`src/commands/protocol-emit.handler.ts:67–161`) copies those item fields and ignores anything else. `protocol validate` (`src/commands/protocol.handler.ts:378–517`) validates and optionally `recordStepInternal`s the verdict unchanged. `run state` (`src/commands/run-v1.handler.ts:1163–1180`) returns run metadata, steps, and step-count budget — not delivery budget.

**Current behavior:**

- Generated plans follow `DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE` (`src/templates/default-artifacts.ts:1–51`) with no scored work items.
- Reviewer prompts (`src/templates/reviewer-plan.md`, `reviewer-plan-continued.md`) ask for exhaustive findings with no effort/architecture fields and no independent baseline estimate.
- Schema max is v7 (`src/db/schema.ts:450–505`; `test/unit/db/schema.test.ts` asserts version `7`).
- Control-plane stores exist for prompts and invocations only (`src/control-plane/store.ts`, `invocation-store.ts`). Slice 10 Phase 1 will add `RecordStore`; this slice’s persistence work (Phase 4+) must not start until that freeze is in-tree.
- Config has no `[reviewBudget]` table (`src/config.ts:166–237`, `src/templates/5x.default.toml`).

**New behavior:**

- New plans include `## Delivery Budget`, a `### Debt Claims` subsection for every negative architecture row, and `### Surface Snapshot`. Parser failures are explicit; incomplete debt evidence cannot become a baseline.
- Before the first plan-reviewer invocation (when mode is not `off` and the run is not mid-review v1-compat), the CLI parses the table, sums effort into `B0`, and CAS-appends an immutable baseline **record line**.
- Reviewers may emit per-item deltas, first-review `baselineAssessment`, and per-claim `creditAssessments`. They must not emit totals or status.
- On `protocol validate reviewer --phase plan --record` and `invoke reviewer --record` for plan phase, the CLI recomputes `W`/`R`/ceilings/bands, **admits** the reviewer step with the shared pre-append operation, **atomically** appends a budget snapshot line with the unique reviewer step via `RecordStore` only when admitted, projects both into the SQLite index, and decorates `result_json` with a `budget` object. Unchanged debt-claim assessments carry forward. Admission failure writes nothing.
- `5x run state` includes `review_budget` when a baseline exists.
- Workflow routing, `maxReviewIterations`, and `human_required` semantics are unchanged.

**Prerequisites:**

- [`205-prompt-queue-foundation-plan.md`](./205-prompt-queue-foundation-plan.md) — `src/control-plane/` store boundary, UUID ids, SQLite vs memory split. **Merged** (schema v6).
- [`207-invocation-registry-plan.md`](./207-invocation-registry-plan.md) — schema currently v7; this slice adds v8 **index** tables. **Merged**.
- **Slice 10 Phase 1 (`RecordStore` interface + in-memory implementation) must be merged and frozen before this slice’s persistence work (Phase 4 and every later phase that writes baselines or snapshots).** Arithmetic, parser, and config (Phases 1–3) may proceed in parallel. This slice does not implement `RecordStore`, working-tree JSONL, or `records index`. If the freeze lacks budget-stream append/read or atomic multi-append, those are a coordinated slice-10 contract revision — not a 06 fork. See Design Decisions.

---

## Design Decisions

**All derivation lives in one pure module.** `src/review-budget/arithmetic.ts` takes parsed ledgers, verdict items, credit assessments, governing `B`/`B0`, and `ReviewBudgetConfig`, and returns `DerivedBudgetResult`. Handlers must not re-implement `S`/`E`/`A`/`D` or baseline direction. Tests of handlers mock or call this module; they do not duplicate formula strings.

**Integer effort points; documented scales only.** Effort cells and `effortDelta` must be in `{1, 2, 3, 5, 8}` for plan rows and `effortDelta >= 0` integer for findings (0 allowed for findings that request no extra delivery work). Architecture cells and `architectureDelta` must be in `{0, ±1, ±2, ±3, ±5}`. Reject other integers with an actionable error naming the allowed set. Tests belong to the work item they validate and are not separate rows (`206` §3.1). A debt claim’s **minimal-compliant effort delta** may be `0` (the cheaper alternative adds no delivery work); if `> 0` it must be in `{1, 2, 3, 5, 8}`. Minimal-compliant architecture delta uses the architecture set.

**Missing Delivery Budget cannot become `B0 = 0`.** `parseDeliveryBudget` returns a `Result` (`ok` + value, or `ok: false` + `code` + `message` + `line`). Callers that would capture a baseline must not catch-and-default. `mode = "off"` skips parse entirely.

**`ReviewBudgetStore` is a domain facade over `RecordStore`; SQLite is a rebuildable index.** Command logic receives the facade from a factory that holds one `RecordStore` (slice 10) plus an optional SQLite index on one `resolveDbContext` Database, matching `PromptCommandContext`. Do not add budget functions to `src/db/operations-v1.ts` for handlers to call. Do not implement a SQLite-only `ReviewBudgetStore` that is authoritative in the absence of record lines. Unit tests inject the facade over slice 10’s `MemoryRecordStore`.

**Record vs cache (`207` §2.2, §2.6).** Authoritative **record** facts: immutable `B0`, governing `B` (equals `B0` until slice 07), original and current parsed ledgers (including complete `DebtClaimEvidence`), surface snapshot, capture kind, first-review `I` / `baselineAssessment`, reviewer deltas, and the effective credit-assessment set. **Derived cache** (never authoritative): `W`, `R`, `S`, `N`, `D`, `E`, `A`, `P`, bands, alerts, `requiresHuman`. Those numbers are recomputed by the pure arithmetic module from the record + current plan; the SQLite index and `result_json` may store them for display. Deleting `.5x/` must not lose baselines, ledgers, assessments, or claims.

**Consumed `RecordStore` surface (slice 10 Phase 1 freeze; 06 does not declare this file).** Persistence phases require these capabilities to already exist on the frozen interface. If any is missing, slice 10 revises the freeze with 06’s agreement:

- Step append / get / list with the existing idempotency key `(run_id, step_name, phase, iteration)`. Re-recording a recorded step appends no duplicate step line. Slice 06’s `prepareRecordStepAppend` uses **get** (not append) for duplicate detection before `atomicAppend`.
- Budget-stream append / get / list that does **not** assume a working-tree path. Slice 06 supplies `idempotencyKey` + JSON payload; slice 10 stores an opaque line (working-tree impl will likely use `budget.jsonl` under the run record dir — 06 does not write that layout).
- Insertion-ordered reads (`listLines` / equivalent). Equal timestamps must not reorder.
- **`atomicAppend(ops)`** (name may differ; semantics must not): all-or-nothing list of step and/or budget appends. Duplicate keys return `created: false` and add no lines. A throw leaves none of the ops durable. This is how P1.1 atomicity maps onto the shared contract without 06 forking `RecordStore` or opening a second connection.

**Budget-line payloads and keys this slice owns:**

| Kind | Idempotency key | Payload (authoritative fields) |
|------|-----------------|--------------------------------|
| `baseline` | `budget:baseline:<runId>` | `captureKind`, `b0`, `b` (initially `= b0`), `originalLedger`, `surface`, `originalSection?`, `configSnapshot`, `id` (UUID), `createdAt` |
| `snapshot` | `budget:snapshot:<runId>:<stepName>:<phase>:<iteration>` | `stepKey` (same tuple as the reviewer step), `currentLedger`, `findings`, `assessments` (effective merged set), `baselineAssessment?` (first snapshot only), `id` (UUID), `createdAt` |

Do **not** treat derived forecasts as record payload. Snapshot lines may omit `derived` or carry a denormalized copy marked non-authoritative; `run state` and the index recompute or cache it. Slice 07/08 may add decision / realization line kinds; this slice does not.

**Why not a SQLite-only `ReviewBudgetStore` now?** `207` §2.6 and plan-input 10 forbid stranding budget history in `.5x/5x.db` and then migrating. Plan-input 06’s older “must touch DB/store” constraint is satisfied by the **index** (schema v8 + write-through + `reindexReviewBudget`), not by making SQLite the system of record. Forking `RecordStore` here would steal slice 10’s opening phase. Waiting until slice 10’s **working-tree** impl merges is allowed for process-durable CLI integration tests; the **interface + memory impl** must be in-tree before Phase 4 code is written. This slice never implements a competing store.

**Advisory `requiresHuman` is telemetry.** Compute it exactly as `206` §6.3 (`over_effective`, `over_absolute`, `baseline_disputed`, `positive_architecture_exceeded`, or any item `action === "human_required"`). Write it on the decorated record. Do **not** change `readiness`, skip re-review, or open a prompt. Slice 07 reads the same field and starts routing.

**`mode = "enforced"` is reserved.** Config accepts it. Capture and derivation run (same as advisory) so projects can pre-set the key. On first baseline capture and on `run state`, emit a warning: enforcement is not implemented; recording advisory telemetry only. Never apply `206` §5.4 readiness rewriting in this slice.

**Compatibility is keyed off baseline presence, not CLI version.**

| Run state | Meaning | Protocol extra fields | Capture |
|-----------|---------|----------------------|---------|
| `mode = "off"` | v1 | optional, ignored | never |
| No baseline, existing `reviewer:review` / `reviewer:plan` steps with `phase = plan` | `v1_compat` | optional | never, unless `--opt-in-budget-baseline` |
| No baseline, no prior plan-reviewer step, plan has valid table | capture then `active` | required on the first recorded plan-review verdict | yes, before first reviewer when possible |
| Baseline row exists | `active` | required for plan-review items | no (idempotent get) |

**First-review `baselineAssessment` is required only on the first `active` plan-review record** (the iteration that creates or immediately follows `B0`). Continued reviews must omit it; if present, fail `INVALID_STRUCTURED_OUTPUT` (“baselineAssessment is initial-review only”). The structural type is declared once in `src/review-budget/types.ts` (Phase 1). Phase 4 record lines, facade, codec, and index import it so they compile before protocol emit exists. Phase 5 `src/protocol.ts` imports and re-exports that type for `ReviewerVerdict`; it does not declare a second `interface BaselineAssessment`.

**`R` accounting.** Let `incorporated` = union of finding IDs in current `Addresses` cells (ignore `-` / empty). Let `pending` = current verdict items with `scopeClass !== "polish"` (missing `scopeClass` counts as required). `R` = sum of `effortDelta` (default 0 when v1-compat) for pending items whose `id` is **not** in `incorporated`, **plus** pending items that **are** in `incorporated` but still listed (author claimed Addresses while the reviewer still raised the id). Polish items never contribute to `R`. This implements `206` §6.1 without slice 07’s resolution enum.

**Provisional `D` only from eligible intrinsic claims with persisted evidence.** Author plan claims contribute to `N`/`D` only when (1) the current-ledger row has complete `DebtClaimEvidence` (`targetPhase`, minimal-compliant effort/architecture deltas, non-empty `before`/`after`) and (2) the **effective** assessment set (current overlay ∪ persisted unchanged claims) has `eligibility: "eligible"` and `coupling: "intrinsic"` for that `debtClaimId`. A `--credit-assessment` whose `creditClaimId` does not match a current-ledger author claim or a current-verdict reviewer `creditClaim` fails `CREDIT_ASSESSMENT_UNKNOWN_CLAIM`. Reviewer-item `creditClaim` is provisionally eligible by construction if `coupling === "intrinsic"` and the same comparison fields are present and non-empty; it cannot backfill evidence for an author `DCn` already on the ledger. `ineligible` / `adjacent` / `unrelated` add 0 to `N`. Incomplete author evidence is a parse/apply failure, not a zero-credit default. Do not realize credit; do not persist implementation-review realizations.

**CLI-owned keys are rejected, not merged.** Reviewer JSON that includes a `budget` object or top-level `budgetBand` / `B0` / `W` / `projectedEffort` / `baselineDirection` / `requiresHuman` (boolean at verdict top-level — item `action: human_required` is fine) fails closed. Prevents an agent from impersonating CLI arithmetic.

**Baseline capture hooks at template render *and* record.** `206` §3.3: capture before the first reviewer invocation. Primary hook: `template render` / `invoke` template resolution when the selected template base name is `reviewer-plan` (not `-continued`), mode ≠ `off`, run is not `v1_compat`. Safety net: `applyPlanReviewBudget` at validate/invoke record time captures if still missing and the run is eligible. Capture is CAS; a race cannot double-write `B0`.

**Opt-in is explicit.** `--opt-in-budget-baseline` on `protocol validate reviewer` (and the same flag on `invoke reviewer` if flags are plumbed; otherwise document that opt-in goes through `protocol validate --record`). It is valid only when a baseline is absent and prior plan-reviewer steps exist. It captures `B0` from the **current** plan (human-approved, possibly already expanded) and sets `captureKind: "opt_in"`. Skills must not pass this flag without a human `human:gate` / prompt confirmation. This slice does not add a new prompt kind.

**Snapshot persistence is atomic with the decorated reviewer step.** `protocolValidate` and `invokeAgent` emit the success envelope and call `recordStepInternal` afterward (`src/commands/protocol.handler.ts:479–515`, `src/commands/invoke.handler.ts:642–684`). If `apply` appended a snapshot first, a failed record (terminal run, step limit, DB error, or retry race) would leave telemetry without a journal row, and a retry could append a second snapshot for the same verdict. Therefore:

- `applyPlanReviewBudget` **computes** (and may CAS-capture a baseline via RecordStore) but **does not** append a snapshot line.
- Handlers resolve **one** review-budget context: slice 10’s `createRecordContext` (`RecordStore`, `originFor`, `redactedRecorder`) plus one `ReviewBudgetStore` facade and one `resolveDbContext` Database for the SQLite index and v1 `steps` projection. They do **not** import `bun:sqlite` and do **not** construct a context without `originFor`.
- Shared `prepareRecordStepAppend` runs **before** any `RecordStore.atomicAppend`. It performs the current `recordStepInternal` admission checks and assembles the complete step record **including `prepared.performer`**. Terminal-run, missing-worktree, invalid-result, and new-at-limit failures throw `RecordError` with **no** append. Duplicate-at-limit returns `outcome: "duplicate"` (no append; projection repair).
- Unique reviewer-step persist uses `RecordStore.atomicAppend([stepOp, budgetSnapshotOp])` **only on** `outcome: "admit"`, with the snapshot’s idempotency key bound to the prepared step key and **both** ops stamped `recordedEnvelope(ctx.originFor(prepared.performer))`. If the step is a duplicate (`created: false` from the store, or `outcome: "duplicate"` from admission), the batch adds no budget line. If either op throws, neither line is durable.
- After a successful unique append (`created: true`), project the step into SQLite `steps` (today’s `recordStep` row, so v1 readers keep working) and the budget snapshot into the v8 index. Index failure after a successful record append does **not** roll back the record — the record is source of truth.
- On `created: false` **or** admission `outcome: "duplicate"` (true duplicate, duplicate-at-limit, or retry after a successful append whose SQLite projection failed), **do not skip projection**. Load the existing step line and matching budget snapshot line by the same idempotency keys and idempotently upsert both SQLite projections. Append no line. A retry must restore a missing `steps` row and missing budget index row without duplicating the record. `reindexReviewBudget` remains the bulk/offline repair; command retry must not wait for a later slice-10 `records index`.
- Envelope-before-record stays the v1 contract (record failure is stderr + exit 1). The invariant is **record step line ↔ record budget snapshot line**, with the SQLite index as a projection.
- Exactly one budget snapshot line exists per successfully recorded unique reviewer step. Idempotent re-records add neither a second step line nor a second snapshot line; they may repair projections.

This slice does **not** implement `atomicAppend` or step-record JSONL. Shared `prepareRecordStepAppend` still runs first on both write paths. If slice 10 has not yet routed generic `recordStepInternal` through `RecordStore`, 06 still makes the uniqueness decision on `RecordStore` for the budget wrapper (budget line + step line in the batch) **after** admission. The SQLite `steps` insert is a projection of the successful batch, not a second authority. Do not wrap “SQLite step insert + SQLite budget insert” as the 1:1 mechanism. Do not call `atomicAppend` for a step that admission rejected.

**Effective assessments = current overlay ∪ persisted unchanged claims.** `deriveBudget` must not receive only the current verdict’s `creditAssessments`. A continued review that correctly omits an already-assessed unchanged claim would otherwise drop `N`/`D`/`E` to zero. Apply builds an **effective** assessment set:

1. Load persisted assessments from `latestSnapshot.assessments` (empty on the first snapshot).
2. Overlay any current-verdict assessments by `creditClaimId` (explicit re-assessment wins).
3. For each author `debtClaimId` on the **current** ledger: if it is new or **changed** relative to the previous snapshot’s ledger, a current assessment is required (`CREDIT_ASSESSMENT_REQUIRED` listing missing ids). Unchanged claims reuse the persisted assessment and do not require re-emit.
4. A claim is **unchanged** when the same `debtClaimId` is still on the current ledger with the same `coupling`, work-item `architectureDelta`, `targetPhase`, `minimalAlternativeEffortDelta`, `minimalAlternativeArchitectureDelta`, `before`, and `after` as in the previous snapshot’s `currentLedger`. Any evidence or score change is **changed**. Removed claims drop out of `N`. Reviewer-item `creditClaim` stays provisionally eligible by construction (no duplicate `--credit-assessment`); its id must not collide with an author `debtClaimId` (`CREDIT_CLAIM_ID_COLLISION`).
5. Every current `--credit-assessment` `creditClaimId` must equal a current-ledger author `debtClaim.debtClaimId` or a current-item `creditClaim.creditClaimId`. Unknown ids fail `CREDIT_ASSESSMENT_UNKNOWN_CLAIM`.
6. Persist the **effective** (merged) set on the new snapshot so the next review can merge again. Call `deriveBudget` with that effective set, not the raw verdict array. `eligibleN` reads architecture reduction from the **persisted ledger claim** (and reviewer-item `creditClaim`), never from assessment-only metadata.

Do **not** instruct continued-review skills to re-emit every assessment. That would conflict with the first-seen / changed-only validation rule.

**Snapshot listing is deterministic at equal timestamps.** RecordStore `listLines("budget")` returns insertion order. `listSnapshots` follows that order (filter `kind === "snapshot"`). `latestSnapshot` is the last snapshot line. The SQLite index stores `record_seq` from that order and uses `ORDER BY record_seq ASC` (not `created_at` alone). The memory RecordStore already supplies insertion sequence. Contract tests append two snapshot lines with the same `createdAt` and assert insertion order.

**Enforced-mode warning is on every first-capture path.** `ensurePlanReviewBaseline` owns the reserved-mode warning and runs on template-render, invoke-before-stream, **and** apply’s safety-net capture (direct `protocol validate --record` with no prior render). Apply takes the same `warn` callback. Do not rely on Phase 7/8 having already warned.

---

## Architecture Overview

```
  author-generate-plan / existing-plan preflight
           │
           ▼
  plan.md  ## Delivery Budget table + ### Debt Claims + ### Surface Snapshot
           │
           │  parseDeliveryBudget(markdown)     // fail-closed; negative rows need full §4.3 evidence
           │
  template render reviewer-plan  ──► ensureBaseline(run)
  invoke reviewer (same template)    CAS captureBaseline
                                     B0 = sum(effort), ledger snapshot
           │
           ▼
  5x protocol emit reviewer
       --item '{...,"effortDelta":4,"architectureDelta":-3,...}'
       --baseline-assessment '{...}'          // first review only
       --credit-assessment '{...}'            // repeatable
           │
           ▼
  5x protocol validate reviewer --phase plan [--record]
  5x invoke reviewer ... --record
           │
           ├─ reject CLI-owned aggregate keys
           ├─ v1 schema (always)
           ├─ if baseline active: require item deltas + first-review I
           ├─ parse current plan → W, Addresses, debt-claim evidence
           ├─ bind creditAssessments to persisted claims (unknown id fails)
           ├─ merge assessments (current overlay ∪ persisted unchanged)
           ├─ deriveBudget(effectiveAssessments) // pure
           ├─ decorate result.budget            // CLI output only
           └─ --record: prepareRecordStepAppend (shared admission)
              then, only if admitted: RecordStore.atomicAppend(step line + budget snapshot line)
              then project both into the SQLite index
              (admission failure or failed unique append: no lines;
               duplicate / created: false: no new line, upsert projections
               from the existing lines)
           │
           ▼
  steps.result_json + RecordStore budget lines (SQLite index is derived)
  5x run state → data.review_budget

  mode=off or v1_compat: skip capture/derive/decorate; v1 path unchanged
```

State per run:

```
  (no baseline line) ──mode=off──────────────────────────────────────► never captured

  (no baseline line) ──prior plan-reviewer steps─────────────────────► v1_compat
                 │
                 └── --opt-in-budget-baseline + valid table ─► active (opt_in)

  (no baseline line) ──no prior reviewer, valid table── captureBaseline ─► active
                 │
                 └── missing/malformed table ──► BUDGET_SECTION_MISSING
                                                 (preflight; no B0)
```

`B0` budget line is immutable. Snapshot lines append, each 1:1 with a successfully recorded unique reviewer step (same idempotency tuple). Derived numbers on the SQLite index / `result_json` are a point-in-time **cache**; `run state` prefers the latest snapshot’s cached derived values (insertion-order tie-break) and may recompute from the snapshot record (ledger + findings + assessments + first-review `baselineAssessment` for `I`) via `deriveBudget` (recompute must match the pure module; if they disagree, that is a bug). The record always wins over the index. Do not reconstruct `I` from wiped `derived_json`.

---

## Phase 1: Domain types and pure arithmetic

**Completion gate:** `bun test test/unit/review-budget/` passes. The `B = 4` worked example from `206` §3.2 is a fixture: `S = 6`, `D <= 1`, `A = 8`, `E` may reach `7`. No handler or SQLite imports in this module. `BaselineAssessment` is defined and type-tested in `src/review-budget/types.ts` so Phase 4 payload, facade, codec, and index rebuild are independently type-complete without Phase 5 or `src/protocol.ts` extensions.

### 1.1 Types — `src/review-budget/types.ts`

New directory `src/review-budget/` (domain, not control-plane SQL).

```typescript
export const EFFORT_POINTS = [1, 2, 3, 5, 8] as const;
export type EffortPoints = (typeof EFFORT_POINTS)[number];

export const ARCHITECTURE_DELTAS = [-5, -3, -2, -1, 0, 1, 2, 3, 5] as const;
export type ArchitectureDelta = (typeof ARCHITECTURE_DELTAS)[number];

export type ReviewBudgetMode = "off" | "advisory" | "enforced";

export type BaselineDirection = "aligned" | "understated" | "inflated";

export type BudgetBand =
	| "within_standard"
	| "within_debt_allowance"
	| "over_effective"
	| "over_absolute";

export type BudgetAlert =
	| "baseline_disputed"
	| "positive_architecture_exceeded"
	| "credit_unrealized"; // recorded for forward-compat; this slice never emits it

export type EstimateConfidence = "low" | "medium" | "high";

export interface BaselineAssessment {
	independentEffortEstimate: number; // integer >= 0
	confidence: EstimateConfidence;
	reason: string;
}

export type PlanScopeClass =
	| "acceptance_required"
	| "risk_reduction"
	| "polish";

export type CouplingClass = "intrinsic" | "adjacent" | "unrelated";

export type CreditEligibility = "eligible" | "ineligible";

export interface ReviewBudgetConfig {
	mode: ReviewBudgetMode;
	growthPercent: number;
	minimumGrowthPoints: number;
	debtTradeoffRatio: number;
	maxDebtCreditPercent: number;
	absoluteGrowthPercent: number;
	baselineDisagreementPercent: number;
	minimumBaselineDisagreementPoints: number;
	maxPositiveArchitecturePercent: number;
	minimumPositiveArchitecturePoints: number;
	singleArchitectureReviewPoints: number;
}

export const DEFAULT_REVIEW_BUDGET_CONFIG: Omit<ReviewBudgetConfig, "mode"> = {
	growthPercent: 25,
	minimumGrowthPoints: 2,
	debtTradeoffRatio: 1.0,
	maxDebtCreditPercent: 25,
	absoluteGrowthPercent: 50,
	baselineDisagreementPercent: 25,
	minimumBaselineDisagreementPoints: 2,
	maxPositiveArchitecturePercent: 25,
	minimumPositiveArchitecturePoints: 2,
	singleArchitectureReviewPoints: 5,
};

export interface DebtClaimEvidence {
	debtClaimId: string; // e.g. "DC0"; /^DC\d+$/
	coupling: CouplingClass;
	targetPhase: string; // numeric phase ref: "phase-2", "Phase 2", "2"
	minimalAlternativeEffortDelta: number; // integer >= 0; if > 0 must be in EFFORT_POINTS
	minimalAlternativeArchitectureDelta: ArchitectureDelta;
	before: string; // trimmed non-empty concrete pre-state
	after: string; // trimmed non-empty concrete post-state
}

export interface ParsedWorkItem {
	id: string;
	title: string;
	effort: EffortPoints;
	architectureDelta: ArchitectureDelta;
	debtClaim: DebtClaimEvidence | null; // required when architectureDelta < 0; null otherwise
	addresses: string[]; // finding ids; empty if "-"
	rationale: string;
	line: number;
}

export interface SurfaceSnapshot {
	subsystems: number;
	productionFiles: number;
	persistentOrExternalBoundaries: number;
	newSharedAbstractions?: number;
	newPersistentSchemas?: number;
}

export interface ParsedDeliveryBudget {
	estimateConfidence: EstimateConfidence;
	workItems: ParsedWorkItem[];
	surface: SurfaceSnapshot;
}

export interface FindingDelta {
	id: string;
	effortDelta: number; // integer >= 0
	architectureDelta: number;
	scopeClass: PlanScopeClass | undefined;
	coupling: CouplingClass | undefined;
	creditClaim?: DebtClaimEvidence; // reviewer-introduced claim; debtClaimId is the creditClaimId
	creditNContribution?: number; // abs(architectureDelta) when eligible intrinsic
}

export interface CreditAssessmentInput {
	creditClaimId: string; // must name a ledger debtClaim.debtClaimId or a finding creditClaim.debtClaimId
	eligibility: CreditEligibility;
	coupling: CouplingClass;
}

export interface DerivedBudgetResult {
	B0: number;
	B: number;
	I: number | null;
	W: number;
	R: number;
	projectedEffort: number; // W + R
	S: number;
	N: number;
	D: number; // provisional
	E: number;
	A: number;
	P: number;
	baselineDirection: BaselineDirection | null; // null when I is null
	budgetBand: BudgetBand;
	budgetAlerts: BudgetAlert[];
	requiresHuman: boolean;
	positiveArchitectureLimit: number;
	baselineDisagreementThreshold: number;
	thresholds: ReviewBudgetConfig;
}
```

- [ ] Create `src/review-budget/types.ts` with the types above, including shared structural `BaselineAssessment`. Do **not** declare this type in `src/protocol.ts` in this phase (or any later persistence phase).
- [ ] Export `isEffortPoints` / `isArchitectureDelta` / `isCompleteDebtClaimEvidence` type guards used by the parser and protocol layer. `isCompleteDebtClaimEvidence` is true only when `debtClaimId`, `coupling`, non-empty `targetPhase`, valid minimal deltas, and non-empty `before`/`after` are all present.
- [ ] Type-level test `test/unit/review-budget/types.test.ts`: a value satisfying `{ independentEffortEstimate, confidence, reason }` is assignable to `BaselineAssessment` exported from `src/review-budget/types.ts`. This test (and all Phase 1 tests) must not import `src/protocol.ts`.

### 1.2 Arithmetic — `src/review-budget/arithmetic.ts`

Formulas (`206` §3.2), with `M = minimumGrowthPoints`:

```text
S = max(B + M, ceil(B * (1 + growthPercent / 100)))
D = min(ceil(B * maxDebtCreditPercent / 100), floor(N * debtTradeoffRatio))
A = max(S + M, ceil(B * (1 + absoluteGrowthPercent / 100)))
E = min(A, S + D)
positiveArchitectureLimit = max(minimumPositiveArchitecturePoints,
                                ceil(B * maxPositiveArchitecturePercent / 100))
baselineDisagreementThreshold = max(minimumBaselineDisagreementPoints,
                                    ceil(B0 * baselineDisagreementPercent / 100))
```

Use `Math.ceil` / `Math.floor` on the multiplications; do not use floating effort totals. `debtTradeoffRatio` is a number (default `1.0`).

```typescript
export function sumEffort(items: readonly { effort: number }[]): number;

export function computeCeilings(
	B: number,
	config: Omit<ReviewBudgetConfig, "mode">,
): {
	S: number;
	A: number;
	positiveArchitectureLimit: number;
};

export function computeProvisionalD(
	B: number,
	N: number,
	config: Omit<ReviewBudgetConfig, "mode">,
): number;

export function computeEffectiveCeiling(S: number, D: number, A: number): number;

export function computeBaselineDirection(
	I: number,
	B0: number,
	threshold: number,
): BaselineDirection;
// aligned when abs(I - B0) < threshold
// understated when I > B0 (reviewer thinks plan is cheap)
// inflated when I < B0

export function computePendingR(
	findings: readonly FindingDelta[],
	incorporatedIds: ReadonlySet<string>,
): number;

export function computeGrossP(
	workItems: readonly { architectureDelta: number }[],
	pendingFindings: readonly FindingDelta[],
): number;
// sum of architectureDelta where value > 0; negatives never offset

export function eligibleN(
	workItems: readonly ParsedWorkItem[],
	findings: readonly FindingDelta[],
	assessments: readonly CreditAssessmentInput[],
): number;
// Author items: abs(architectureDelta) when debtClaim is complete AND the
// assessment for debtClaim.debtClaimId is eligible + intrinsic.
// Findings: abs(architectureDelta) when item creditClaim is complete and
// coupling is intrinsic (provisionally eligible; no separate assessment).
// Incomplete evidence contributes 0 (defensive; parser/apply fail closed first).
// Assessments cannot invent N for a claim that is missing ledger evidence.

export function deriveBudget(input: {
	B0: number;
	B: number;
	I: number | null;
	workItems: readonly ParsedWorkItem[];
	findings: readonly FindingDelta[];
	assessments: readonly CreditAssessmentInput[]; // effective set from apply (merged), not raw verdict-only
	config: Omit<ReviewBudgetConfig, "mode">;
	semanticHumanRequired: boolean; // any item.action === "human_required"
}): DerivedBudgetResult;
```

`budgetBand`:

- `projectedEffort <= S` → `within_standard`
- `S < projectedEffort <= E` → `within_debt_allowance`
- `E < projectedEffort <= A` → `over_effective`
- `projectedEffort > A` → `over_absolute`

`budgetAlerts`:

- `baseline_disputed` when `I !== null` and direction is not `aligned`
- `positive_architecture_exceeded` when `P >= positiveArchitectureLimit` **or** any single work-item/finding `architectureDelta >= singleArchitectureReviewPoints`
- Do **not** emit `credit_unrealized` in this slice (no implementation-review realizations)

`requiresHuman`: true if band is `over_effective` or `over_absolute`, or alerts include `baseline_disputed` or `positive_architecture_exceeded`, or `semanticHumanRequired`. Advisory callers record this and do not route.

- [ ] Implement `arithmetic.ts` with no I/O.
- [ ] `test/unit/review-budget/arithmetic.test.ts`: `B = 4` (`S = 6`, `A = 8`, `D = 1` → `E = 7`); `B = 0` guard (`B0` capture already forbids empty tables; arithmetic should still be defined — treat `B < 0` as throw); disagreement threshold for `B0 = 4` is `max(2, ceil(1)) = 2`; `I = 6` → `understated`; `I = 1` → `inflated`; `I = 5` with threshold 2 → `aligned`; `P` ignores negatives; `Addresses` dedup + still-listed re-entry; polish excluded from `R`; ineligible claims excluded from `N`; **incomplete `debtClaim` (missing before/after or targetPhase) excluded from `N` even if an assessment says eligible**; `D` capped by percent and by `floor(N * ratio)`.

---

## Phase 2: Delivery Budget parser

**Completion gate:** Fixture tests cover happy path (including complete debt-claim evidence), every diagnostic code, and `parsePlan` phase extraction unchanged when the budget section sits before Phase 1 or after the last phase.

### 2.1 Parser — `src/parsers/delivery-budget.ts` (new)

Do **not** fold this into `parsePlan`. Phase checklist parsing must stay independent (`src/parsers/plan.ts:26–27`, `34–167`). A `## Delivery Budget` heading already closes an open phase (`plan.ts:132–137`); document placement **before Phase 1 or after all phases**.

Canonical table (allowed effort scores only; `206` §6.1’s published `W2` effort `4` is **not** in `{1, 2, 3, 5, 8}` — this fixture uses `5`. Keep `4` exclusively as the invalid-effort test value). Negative architecture rows require a `### Debt Claims` subsection with the full `206` §4.3 comparison — the seven-column work-item table still holds `DCn (\`coupling\`)` only:

```markdown
## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | ... | 3 | 0 | - | - | ... |
| W2 | Consolidate ... | 5 | -3 | DC0 (`intrinsic`) | - | ... |

### Debt Claims

#### DC0

- Target phase: phase-2
- Minimal-compliant effort delta: 2
- Minimal-compliant architecture delta: 0
- Before: five independent proposal construction paths
- After: one invariant-enforcing proposal constructor

### Surface Snapshot

- Subsystems: 4
- Production files: 12
- Persistent/external boundaries: 1
```

```typescript
export type DeliveryBudgetParseCode =
	| "BUDGET_SECTION_MISSING"
	| "BUDGET_TABLE_MISSING"
	| "BUDGET_TABLE_EMPTY"
	| "BUDGET_TABLE_MALFORMED"
	| "BUDGET_DUPLICATE_ID"
	| "BUDGET_INVALID_ID"
	| "BUDGET_INVALID_EFFORT"
	| "BUDGET_INVALID_ARCHITECTURE"
	| "BUDGET_DEBT_CLAIM_REQUIRED"
	| "BUDGET_INVALID_DEBT_CLAIM"
	| "BUDGET_DEBT_CLAIM_EVIDENCE_MISSING"
	| "BUDGET_DEBT_CLAIM_ORPHAN"
	| "BUDGET_DUPLICATE_DEBT_CLAIM"
	| "BUDGET_INVALID_TARGET_PHASE"
	| "BUDGET_INVALID_MINIMAL_ALTERNATIVE"
	| "BUDGET_DEBT_EVIDENCE_EMPTY"
	| "BUDGET_INVALID_CONFIDENCE"
	| "BUDGET_SNAPSHOT_MISSING"
	| "BUDGET_SNAPSHOT_INVALID";

export type DeliveryBudgetParseResult =
	| { ok: true; value: ParsedDeliveryBudget }
	| {
			ok: false;
			code: DeliveryBudgetParseCode;
			message: string;
			line?: number;
	  };

export function parseDeliveryBudget(markdown: string): DeliveryBudgetParseResult;
```

Rules:

- Heading: `/^##\s+Delivery Budget\s*$/m` (exact section title).
- Estimate confidence line required: `- Estimate confidence: low|medium|high` (case-insensitive values).
- GFM table: header row must contain the seven columns in order (allow minor whitespace / case-insensitive headers). Separator row required. One work-item per subsequent row until a blank line or next heading.
- Work-item ID: `/^W\d+$/` (stable, unique within the table). Duplicate → `BUDGET_DUPLICATE_ID`.
- Effort / architecture: type guards from Phase 1.
- `Debt claim` (table cell): `-` when `architectureDelta >= 0`; when negative, require `DC<digits> (\`<coupling>\`)` (example `DC0 (\`intrinsic\`)`). Coupling required. `adjacent` / `unrelated` are parseable (credit eligibility is a reviewer assessment, not a parse failure). Duplicate `DCn` across rows → `BUDGET_DUPLICATE_DEBT_CLAIM`. A positive row with a non-`-` claim → `BUDGET_INVALID_DEBT_CLAIM`.
- `### Debt Claims` subsection: **required** when any work-item row has `architectureDelta < 0`; omit when every row is non-negative. Place it after the work-item table and **before** `### Surface Snapshot`. Heading: `/^###\s+Debt Claims\s*$/m`. Missing heading or missing `#### DCn` block for a table id → `BUDGET_DEBT_CLAIM_EVIDENCE_MISSING` (include the id).
- Each claim block: `/^####\s+(DC\d+)\s*$/m` with required bullets (case-insensitive labels, colon-separated values):
  - `Target phase:` non-empty numeric phase ref in the same family as `isNumericPhaseRef` (`phase-2`, `Phase 2`, `2`, `2.1`). Empty or non-phase-ref → `BUDGET_INVALID_TARGET_PHASE`. The parser does **not** require a matching `## Phase` heading in `parsePlan` (independent parser); slice 08 consumes the persisted string.
  - `Minimal-compliant effort delta:` integer `>= 0`; if `> 0` must be in `{1, 2, 3, 5, 8}` (0 means the minimal alternative adds no delivery work). Invalid → `BUDGET_INVALID_MINIMAL_ALTERNATIVE`.
  - `Minimal-compliant architecture delta:` must be in `{0, ±1, ±2, ±3, ±5}`. Invalid → `BUDGET_INVALID_MINIMAL_ALTERNATIVE`.
  - `Before:` and `After:` trimmed non-empty concrete evidence (not “cleaner” / empty / `-`). Empty → `BUDGET_DEBT_EVIDENCE_EMPTY`.
- Join is 1:1: every table `DCn` has exactly one `#### DCn` block; every `#### DCn` is referenced by exactly one negative work-item row. Orphan block → `BUDGET_DEBT_CLAIM_ORPHAN`. Duplicate `####` ids → `BUDGET_DUPLICATE_DEBT_CLAIM`.
- Populate `ParsedWorkItem.debtClaim` with the joined evidence object. Do **not** accept a negative row that only has `debtClaimId` + `coupling` in the table cell.
- `Addresses`: `-` → `[]`; otherwise split on commas, trim, reject empty tokens. Finding IDs are non-empty strings (`/^[A-Za-z0-9._-]+$/`).
- Surface snapshot: require `### Surface Snapshot` under the budget section (before the next `##`). Require integer bullets for `Subsystems`, `Production files`, and `Persistent/external boundaries` (aliases: `Persistent schemas or migrations` + `External/platform boundaries` may sum into the third counter if both present; prefer the single combined bullet from §6.1). Optional bullets: `New shared abstractions or public contracts`. Missing required bullets → `BUDGET_SNAPSHOT_MISSING`. Non-integer → `BUDGET_SNAPSHOT_INVALID`.
- Zero work-item rows → `BUDGET_TABLE_EMPTY` (not `B0 = 0`).
- Messages must include the line number and the allowed value set where relevant.

### 2.2 Helpers

```typescript
export function incorporatedFindingIds(
	items: readonly ParsedWorkItem[],
): Set<string>;

export function rawDeliveryBudgetSection(markdown: string): string | null;
```

`rawDeliveryBudgetSection` returns the exact substring from `## Delivery Budget` through the last snapshot bullet (exclusive of the next `##`), **including** `### Debt Claims` when present. Slice 08 will byte-compare this for `text_only`; this slice only needs it for tests and for storing `original_section` on the baseline if cheap. Store the parsed ledger JSON (**including `debtClaim` evidence on each work item**) as source of truth; optionally also store `original_section` text on capture for audit.

- [ ] Implement parser + helpers.
- [ ] `test/unit/parsers/delivery-budget.test.ts` fixtures: canonical table (W2 effort `5` **and** complete `### Debt Claims` / `#### DC0` evidence); missing section; empty table; bad effort `4` (invalid — not in `{1, 2, 3, 5, 8}`); duplicate `W1`; negative arch without claim; negative arch with table `DCn` but **no** Debt Claims subsection; negative arch with empty `Before`; invalid `targetPhase` (`review`); orphan `#### DC9`; duplicate `DC0`; Addresses split; snapshot missing; `parsePlan` regression fixtures with budget before Phase 1 and after Phase 2 (`test/unit/parsers/plan.test.ts` add two cases).
- [ ] Round-trip: `parseDeliveryBudget(canonical).value.workItems[1].debtClaim` equals `{ debtClaimId: "DC0", coupling: "intrinsic", targetPhase: "phase-2", minimalAlternativeEffortDelta: 2, minimalAlternativeArchitectureDelta: 0, before: "five independent proposal construction paths", after: "one invariant-enforcing proposal constructor" }`.
- [ ] Re-export parse types from `src/index.ts` in Phase 10 (not required to compile Phase 2).

---

## Phase 3: `reviewBudget` configuration

**Completion gate:** `FiveXConfigSchema.parse({})` yields `reviewBudget.mode === "advisory"` and the `206` §7 defaults. Layered overlay can set `mode = "off"`. Invalid mode/percent fails Zod parse. Registry lists dotted keys. `KNOWN_ROOT_CONFIG_KEYS` includes `reviewBudget`.

### 3.1 Schema — `src/config.ts`

Insert `ReviewBudgetConfigSchema` next to `HarnessConfigSchema` (`src/config.ts:142–155`) and add `reviewBudget` to `FiveXConfigSchema` (`:166–237`):

```typescript
const ReviewBudgetConfigSchema = z.object({
	mode: z.enum(["off", "advisory", "enforced"]).default("advisory")
		.describe("off: v1 iteration-only. advisory: record forecasts, do not change routing. enforced: reserved; treated as advisory until plan-review governance ships."),
	growthPercent: z.number().int().min(0).max(100).default(25)
		.describe("Percent growth from governing B used to compute standard ceiling S."),
	minimumGrowthPoints: z.number().int().min(0).default(2)
		.describe("Minimum point allowance added to B (and to S when computing A)."),
	debtTradeoffRatio: z.number().min(0).default(1)
		.describe("Exchange ratio: floor(N * ratio) caps provisional debt credit D."),
	maxDebtCreditPercent: z.number().int().min(0).max(100).default(25)
		.describe("Percent of B that caps provisional debt credit D."),
	absoluteGrowthPercent: z.number().int().min(0).max(500).default(50)
		.describe("Percent growth from B used to compute absolute ceiling A."),
	baselineDisagreementPercent: z.number().int().min(0).max(100).default(25)
		.describe("Percent of B0 for first-reviewer disagreement threshold."),
	minimumBaselineDisagreementPoints: z.number().int().min(0).default(2)
		.describe("Minimum points of |I - B0| that count as a baseline dispute."),
	maxPositiveArchitecturePercent: z.number().int().min(0).max(100).default(25)
		.describe("Percent of B for gross positive architecture human threshold."),
	minimumPositiveArchitecturePoints: z.number().int().min(0).default(2)
		.describe("Minimum P that raises positive_architecture_exceeded."),
	singleArchitectureReviewPoints: z.number().int().min(0).default(5)
		.describe("A single architectureDelta at or above this value raises an alert."),
});
```

Add `reviewBudget: ReviewBudgetConfigSchema.default({}).describe(...)` to the root object.

Add `"reviewBudget"` to `KNOWN_ROOT_CONFIG_KEYS` (`src/config.ts:498–512`) so overlays do not warn as unknown plugin keys.

### 3.2 Default TOML — `src/templates/5x.default.toml`

Append after `[db]` (`:71–73`):

```toml
# Delivery-budget forecasts during plan review (v2 area 206).
# mode: off | advisory | enforced (enforced is reserved; behaves as advisory)
[reviewBudget]
mode = "advisory"
# growthPercent = 25
# minimumGrowthPoints = 2
# debtTradeoffRatio = 1.0
# maxDebtCreditPercent = 25
# absoluteGrowthPercent = 50
# baselineDisagreementPercent = 25
# minimumBaselineDisagreementPoints = 2
# maxPositiveArchitecturePercent = 25
# minimumPositiveArchitecturePoints = 2
# singleArchitectureReviewPoints = 5
```

Layering: existing `deepMerge` (`src/config.ts:695`) already merges nested tables. Personal/local overlays may tighten percents. No new merge rules.

- [ ] Schema + defaults + `KNOWN_ROOT_CONFIG_KEYS`.
- [ ] `test/unit/config.test.ts` / `config-v1.test.ts`: parse `{}`, overlay `mode = "off"`, reject `mode = "strict"`, reject negative percent.
- [ ] `test/unit/config-registry.test.ts`: `reviewBudget.mode` default `"advisory"`; `allowedValues` includes `enforced`.
- [ ] Update any snapshot of `5x config show` keys if tests enumerate them.

---

## Phase 4: Budget record lines, RecordStore facade, and rebuildable index

**Prerequisite:** Slice 10 Phase 1 is merged: frozen `RecordStore` (no working-tree path assumption) + in-memory implementation + contract tests. That freeze must include budget-stream append/get/list, insertion-ordered reads, and `atomicAppend` (or equivalent all-or-nothing multi-append) as specified in Design Decisions. This phase does **not** add `src/control-plane/record-store.ts` or a working-tree JSONL writer.

**Completion gate:** `captureBaseline` appends one `baseline` budget line (INSERT-once; second call returns existing, does not change `b0`). Snapshots append as budget lines keyed to a step tuple. Fresh DB migrates to v8 **index** tables. v7 → v8 keeps `invocations`. Facade tests against `MemoryRecordStore` (with and without a SQLite index) pass the same contract. Wiping the index and calling `reindexReviewBudget` restores baseline + snapshots from record lines, including first-snapshot `baselineAssessment`, so `I` and `baselineDirection` recompute identically from the record. Facade, snapshot payload codec (`encodeBudgetSnapshotPayload` / `decodeBudgetSnapshotPayload`), and index rebuild compile and pass using `BaselineAssessment` imported from `src/review-budget/types.ts` — Phase 4 tests must not import that type from `src/protocol.ts`. This phase is independently type-complete before Phase 5. Handlers are not wired yet. No test treats a SQLite row as authoritative when the corresponding record line is absent.

### 4.1 IDs — `src/control-plane/ids.ts`

Add `createReviewBudgetId(): string` (`randomUUID`), same file as `createPromptId` (`:8–16`). Payload `id` is the line’s UUID; the **idempotency key** is the CAS identity (`budget:baseline:<runId>` / `budget:snapshot:<runId>:<stepName>:<phase>:<iteration>`).

### 4.2 Budget line types — `src/review-budget/record-lines.ts` (new)

This slice owns payloads. Encode/decode helpers live here; they import `RecordStore` **types** from slice 10, not a 06 copy of the interface. They import `BaselineAssessment` (and ledger/finding/assessment types) from `./types.js` — **not** from `src/protocol.ts`. Phase 4 must type-check before Phase 5 protocol extensions exist.

```typescript
import type {
	BaselineAssessment,
	CreditAssessmentInput,
	FindingDelta,
	ParsedDeliveryBudget,
	ReviewBudgetConfig,
	SurfaceSnapshot,
} from "./types.js";

export type BudgetRecordKind = "baseline" | "snapshot";

export type CaptureKind = "initial" | "opt_in";

export interface BudgetBaselinePayload {
	kind: "baseline";
	id: string;
	runId: string;
	captureKind: CaptureKind;
	b0: number;
	b: number; // governing B; equals b0 until slice 07
	originalLedger: ParsedDeliveryBudget;
	surface: SurfaceSnapshot;
	originalSection: string | null;
	configSnapshot: Omit<ReviewBudgetConfig, "mode">;
	createdAt: string;
}

export interface BudgetSnapshotStepKey {
	stepName: string;
	phase: string | null;
	iteration: number | null;
}

export interface BudgetSnapshotPayload {
	kind: "snapshot";
	id: string;
	runId: string;
	stepKey: BudgetSnapshotStepKey;
	currentLedger: ParsedDeliveryBudget;
	findings: FindingDelta[];
	assessments: CreditAssessmentInput[]; // effective merged set
	baselineAssessment?: BaselineAssessment; // first snapshot only; omit later
	createdAt: string;
	// derived forecasts are NOT authoritative on this line
}

export function baselineIdempotencyKey(runId: string): string;
export function snapshotIdempotencyKey(
	runId: string,
	stepKey: BudgetSnapshotStepKey,
): string;
export function encodeBudgetSnapshotPayload(
	payload: BudgetSnapshotPayload,
): unknown;
export function decodeBudgetSnapshotPayload(
	raw: unknown,
): BudgetSnapshotPayload;
```

Encode/decode **must** round-trip `baselineAssessment` when present and omit the key when absent (first snapshot only). Reindex and facade read-through call decode; they must not drop the field or substitute `derived.I`. A snapshot line without the field decodes to `baselineAssessment: undefined`.

`appendSnapshot` on the facade may still accept a `derived` object to write into the **index cache** after a successful record append; that object is not required on the record payload. `derived` is never the authority for `I`.

### 4.3 Facade — `src/control-plane/review-budget-store.ts` (new)

Import `BaselineAssessment` from `src/review-budget/types.ts` (same Phase 1 export used by `record-lines.ts`). Do **not** import it from `src/protocol.ts`.

```typescript
export interface ReviewBudgetBaseline {
	id: string;
	runId: string;
	captureKind: CaptureKind;
	b0: number;
	b: number;
	originalLedger: ParsedDeliveryBudget;
	surface: SurfaceSnapshot;
	originalSection: string | null;
	configSnapshot: Omit<ReviewBudgetConfig, "mode">;
	createdAt: string;
}

export interface ReviewBudgetSnapshotRecord {
	id: string;
	runId: string;
	phase: string | null;
	iteration: number | null;
	stepName?: string;
	currentLedger: ParsedDeliveryBudget;
	findings: FindingDelta[];
	assessments: CreditAssessmentInput[];
	baselineAssessment?: BaselineAssessment; // first snapshot only; authoritative I; omit later
	derived: DerivedBudgetResult | null; // index cache; recompute if null — never the source of I
	createdAt: string;
}

export interface CaptureBaselineInput {
	runId: string;
	captureKind: CaptureKind;
	parsed: ParsedDeliveryBudget;
	originalSection?: string;
	configSnapshot: Omit<ReviewBudgetConfig, "mode">;
	/**
	 * Already-redacted origin from `ctx.originFor(performer)`. Required on live writes.
	 * Tests may pass a fixture origin. The facade does not call `originFor` and must not omit origin.
	 */
	origin: RecordOrigin;
}

export type CaptureBaselineResult =
	| { ok: true; created: true; baseline: ReviewBudgetBaseline }
	| { ok: true; created: false; baseline: ReviewBudgetBaseline };

export interface ReviewBudgetStore {
	getBaseline(runId: string): ReviewBudgetBaseline | null;
	/** CAS: RecordStore append of kind baseline. Duplicate key returns created: false. */
	captureBaseline(input: CaptureBaselineInput): CaptureBaselineResult;
	appendSnapshot(input: {
		runId: string;
		stepName: string;
		phase?: string;
		iteration?: number;
		currentLedger: ParsedDeliveryBudget;
		findings: FindingDelta[];
		assessments: CreditAssessmentInput[];
		baselineAssessment?: BaselineAssessment; // first snapshot only; persist on the record line
		derived?: DerivedBudgetResult; // cache only
	}): ReviewBudgetSnapshotRecord;
	latestSnapshot(runId: string): ReviewBudgetSnapshotRecord | null;
	listSnapshots(runId: string): ReviewBudgetSnapshotRecord[];
}

export function createReviewBudgetStore(
	recordStore: RecordStore,
	index?: ReviewBudgetIndex,
): ReviewBudgetStore;
```

Reads prefer the index when present and complete; on miss they reconstruct from `recordStore.listLines(runId, "budget")` (or the frozen equivalent) in **insertion order**. Reconstruction **must** map `payload.baselineAssessment` onto `ReviewBudgetSnapshotRecord.baselineAssessment`. An index row is incomplete if the matching record line has `baselineAssessment` and the index column is null — prefer the record (or treat as a miss and read through). Writes always append the record line first (or `created: false`), then upsert the index. `captureBaseline` computes `b0 = sumEffort(parsed.workItems)` and rejects `b0 <= 0` before append. Live `captureBaseline` stamps `...recordedEnvelope(input.origin)` on the baseline `AppendOp`; callers pass `ctx.originFor(performer)` (`{ kind: "system", role: "cli" }` from template render; the same agent performer as the reviewer step when capture is an invoke/protocol `--record` safety-net). Missing `origin` on a production write is a programming error, not a silent unattributed line.

`latestSnapshot` / `listSnapshots` follow record insertion order. Do not `ORDER BY created_at` without `record_seq`.

**Do not** ship `review-budget-memory.ts` as a second source of truth. Tests construct `createReviewBudgetStore(memoryRecordStore)` (optionally with a SQLite index). **Do not** ship `createSqliteReviewBudgetStore` that writes SQLite without going through `RecordStore`.

### 4.4 Rebuildable SQLite index — `src/db/schema.ts` + `src/control-plane/review-budget-index.ts` (new)

Append after v7 (`:450–505`). Bump tests that hardcode `getMaxKnownSchemaVersion() === 7` (`test/unit/db/schema.test.ts:28–40`, `:166`; `schema-v6.test.ts`; `schema-v7.test.ts:71`). These tables are an **index**, not the record.

```sql
CREATE TABLE review_budget_baselines (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  record_idempotency_key TEXT NOT NULL UNIQUE,
  capture_kind TEXT NOT NULL CHECK (capture_kind IN ('initial', 'opt_in')),
  b0 INTEGER NOT NULL CHECK (b0 > 0),
  b INTEGER NOT NULL CHECK (b > 0),
  original_ledger_json TEXT NOT NULL, -- ParsedDeliveryBudget JSON including debtClaim evidence
  surface_snapshot_json TEXT NOT NULL,
  original_section TEXT,
  config_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (b0 > 0)
);

CREATE TABLE review_budget_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  record_idempotency_key TEXT NOT NULL UNIQUE,
  record_seq INTEGER NOT NULL,
  step_name TEXT,
  phase TEXT,
  iteration INTEGER,
  current_ledger_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  assessments_json TEXT NOT NULL,
  baseline_assessment_json TEXT, -- first snapshot only; NULL later; authoritative I, not derived cache
  derived_json TEXT, -- cache of DerivedBudgetResult; nullable; recompute from record if null
  created_at TEXT NOT NULL
);
CREATE INDEX idx_review_budget_snapshots_run
  ON review_budget_snapshots(run_id, record_seq);
```

Index `listSnapshots` uses `ORDER BY record_seq ASC`. `latestSnapshot` uses `ORDER BY record_seq DESC LIMIT 1`. `record_seq` is the RecordStore insertion ordinal for that run’s budget stream (not SQLite `rowid`, which can diverge after a rebuild). Index `get`/`list` decode `baseline_assessment_json` onto `ReviewBudgetSnapshotRecord.baselineAssessment` (undefined when NULL).

No `UPDATE` of `review_budget_baselines.b0`. This slice never `UPDATE`s the baselines index row except as a reindex upsert of the same record line. Slice 07 may append **decision** record lines for governing `B`; until then `b` stays equal to `b0`.

`b0 > 0` enforces the empty-table ban at the index layer.

SQL only in `src/control-plane/review-budget-index.ts`. Re-export facade + index helpers from `src/control-plane/index.ts`.

```typescript
export interface ReviewBudgetIndex {
	upsertBaseline(baseline: ReviewBudgetBaseline, idempotencyKey: string): void;
	upsertSnapshot(
		snapshot: ReviewBudgetSnapshotRecord,
		idempotencyKey: string,
		recordSeq: number,
	): void;
	getBaseline(runId: string): ReviewBudgetBaseline | null;
	latestSnapshot(runId: string): ReviewBudgetSnapshotRecord | null;
	listSnapshots(runId: string): ReviewBudgetSnapshotRecord[];
}

export function reindexReviewBudget(
	recordStore: RecordStore,
	index: ReviewBudgetIndex,
	runId: string,
): void;
```

`reindexReviewBudget` walks budget lines in insertion order and upserts by `record_idempotency_key`. It never invents a baseline or snapshot that has no record line. Snapshot upserts copy `decodeBudgetSnapshotPayload(...).baselineAssessment` onto the facade record and into `baseline_assessment_json` (NULL when the payload omits it). Reindex must not drop a first-snapshot assessment or fill `I` from `derived_json`. Slice 10’s later `5x records index` should call this helper; this slice does not add that CLI.

- [ ] Migration v8 + `test/unit/db/schema-v8.test.ts` (fresh, v7→v8, unique `run_id`, unique `record_idempotency_key`, `b0 > 0` CHECK, FK to `runs`, nullable `baseline_assessment_json`).
- [ ] Update version assertions from 7 → 8.
- [ ] Facade over `MemoryRecordStore` (no SQLite) + facade over `MemoryRecordStore` + SQLite index.
- [ ] `test/unit/review-budget/record-lines.test.ts`: encode/decode round-trips `baselineAssessment` when present and omits it when absent. Imports `BaselineAssessment` from `src/review-budget/types.ts` only — **not** from `src/protocol.ts`.
- [ ] `test/unit/control-plane/review-budget-store-contract.test.ts`: capture once **with a fixture `origin`** (`recordedEnvelope` round-trip on the baseline line); second capture is no-op on `b0` **and** appends no second baseline line; append snapshots ordered; **same-`createdAt` pair returns in insertion order** (`latestSnapshot` is the second append); **round-trip**: captured `originalLedger.workItems[].debtClaim` retains `targetPhase`, minimal deltas, and non-empty `before`/`after`; appended `currentLedger` does the same; **first snapshot round-trips `baselineAssessment`; a later snapshot omits it**. Facade `appendSnapshot` / read-through compile against the Phase 1 domain type (import from `src/review-budget/types.ts`, not `src/protocol.ts`). Live writers still obtain `origin` from `originFor`; this suite may construct a fixture `RecordOrigin`.
- [ ] `test/unit/control-plane/review-budget-index.test.ts`: after two captures/snapshots, delete index rows (or use a fresh DB), `reindexReviewBudget` restores identical baselines/ledgers/assessments **including first-snapshot `baselineAssessment`**; **after the wipe, `deriveBudget` using reconstructed `I` (`baselineAssessment.independentEffortEstimate`) and the restored ledger/findings/assessments yields the same `I` and `baselineDirection` as before the wipe**; derived cache may be recomputed; **no index row appears for a run with zero budget lines**. Reindex tests import `BaselineAssessment` from `src/review-budget/types.ts`, not `src/protocol.ts`.
- [ ] Do not import `bun:sqlite` from the facade file, `record-lines.ts`, or command handlers (handlers land in Phase 6–8).
- [ ] Do not import `src/protocol.ts` from `record-lines.ts`, the facade, the index, or Phase 4 tests. Those units type-check against `src/review-budget/types.ts` only.
- [ ] Do not add a SQLite-backed `RecordStore` implementation in this slice.

---

## Phase 5: Protocol types, emit, and normalize

**Completion gate:** v1 emit/validate fixtures still pass. New flags round-trip. Aggregate keys on emit stdin/flags are rejected. Implementation-review fields are **not** added. `BaselineAssessment` on `ReviewerVerdict` is the Phase 1 domain type, imported and re-exported — not a second declaration.

### 5.1 Types and JSON schema — `src/protocol.ts`

Extend `VerdictItem` (`:16–22`) and `ReviewerVerdict` (`:24–28`). Import and re-export `BaselineAssessment` from `src/review-budget/types.ts`; do **not** declare a second copy here. Phase 4 already compiled against that type.

```typescript
import type { BaselineAssessment } from "./review-budget/types.js";
export type { BaselineAssessment };

export type PlanReviewScopeClass =
	| "acceptance_required"
	| "risk_reduction"
	| "polish";

export interface CreditClaim {
	creditClaimId: string;
	targetPhase: string;
	minimalAlternativeEffortDelta: number;
	minimalAlternativeArchitectureDelta: number;
	before: string;
	after: string;
}
// Reviewer-introduced claims only. Author DCn evidence lives on the plan ledger
// (ParsedWorkItem.debtClaim); do not use creditClaim to backfill an author row.

export interface VerdictItem {
	id: string;
	title: string;
	action: "auto_fix" | "human_required";
	reason: string;
	priority?: "P0" | "P1" | "P2";
	scopeClass?: PlanReviewScopeClass;
	effortDelta?: number;
	architectureDelta?: number;
	coupling?: "intrinsic" | "adjacent" | "unrelated";
	estimateConfidence?: "low" | "medium" | "high";
	creditClaim?: CreditClaim;
}

export interface CreditAssessment {
	creditClaimId: string;
	eligibility: "eligible" | "ineligible";
	coupling: "intrinsic" | "adjacent" | "unrelated";
	reason: string;
}

export interface ReviewerVerdict {
	readiness: "ready" | "ready_with_corrections" | "not_ready";
	items: VerdictItem[];
	summary?: string;
	baselineAssessment?: BaselineAssessment;
	creditAssessments?: CreditAssessment[];
}
```

Extend `ReviewerVerdictSchema` (`:56–100`) with optional properties matching the above (for `invoke` structured output). Item `required` stays `["id", "title", "action", "reason"]`.

`assertReviewerVerdict` (`:157–180`): when fields **are** present, validate types and conditional coupling (`architectureDelta < 0` ⇒ `coupling` required; `creditClaim` requires non-empty `targetPhase`, non-empty `before`/`after`, and integer minimal deltas in the allowed sets; `independentEffortEstimate >= 0` integer). Do **not** require the new fields here — that is context-sensitive (Phase 6). A present `creditClaim` is the reviewer-introduced claim contract (`206` §4.3), not a substitute for author-ledger evidence.

Add `CLI_OWNED_VERDICT_KEYS` and `rejectCliOwnedBudgetFields(value)` used by emit and validate:

```typescript
export const CLI_OWNED_VERDICT_KEYS = [
	"budget",
	"budgetBand",
	"budgetAlerts",
	"requiresHuman",
	"B0",
	"B",
	"W",
	"R",
	"S",
	"N",
	"D",
	"E",
	"A",
	"P",
	"projectedEffort",
	"baselineDirection",
] as const;
```

Reject if any key exists on the verdict object (including inside a nested `budget` — the presence of `budget` is enough).

### 5.2 Normalize — `src/protocol-normalize.ts`

`normalizeReviewerVerdict` (`:60–138`): pass through the new item and top-level fields when already canonical. Do not invent `effortDelta`. Do not map implementation-review `scopeClass` values; unknown `scopeClass` stays as-is so assert can fail.

### 5.3 Emit — `src/commands/protocol-emit.handler.ts`, `src/commands/protocol.ts`

`ProtocolEmitReviewerParams` (`protocol-emit.handler.ts:30–35`): add `baselineAssessment?: string` and `creditAssessment?: string[]`.

Parse `--item` JSON for the new optional fields (`:119–128`). Parse `--baseline-assessment` once and `--credit-assessment` repeatable (same `collect` helper as `--item`, `protocol.ts:20–22`).

Flags on `emit reviewer` (`protocol.ts:152–184`):

```text
--baseline-assessment <json>
--credit-assessment <json>   (repeatable)
```

No `--budget` flag. Help text must say aggregates are CLI-derived.

If flag JSON includes CLI-owned keys, `INVALID_JSON` / `INVALID_STRUCTURED_OUTPUT`.

### 5.4 Tests

- [ ] `test/unit/protocol.test.ts`: present-field validation; v1 verdict still asserts; `creditClaim` present-fields require `targetPhase` + non-empty `before`/`after`; reject `budgetBand` on the object if `assert` is taught to call `rejectCliOwnedBudgetFields` — prefer calling reject in emit/validate only so `assertReviewerVerdict` stays backward compatible for in-memory v1 objects.
- [ ] Type-level: `BaselineAssessment` re-exported from `src/protocol.ts` is the same type as `src/review-budget/types.ts` (import/re-export, not a second `interface` declaration). A Phase 1 `BaselineAssessment` value is assignable to `ReviewerVerdict["baselineAssessment"]`.
- [ ] `test/unit/commands/protocol-emit.test.ts`: item extras round-trip including full `creditClaim`; `--baseline-assessment`; repeated `--credit-assessment`; reject `--item` containing `budgetBand`.
- [ ] `test/unit/commands/protocol-helpers.test.ts`: v1 reviewer payload still `ok`.
- [ ] Do not add `--credit-realization` or implementation `scopeClass` enums.

---

## Phase 6: Validate, derive, persist, decorate

**Completion gate:** Recording a plan-review verdict on an `active` run writes **exactly one** budget snapshot **line** in the same `RecordStore.atomicAppend` as the unique reviewer step line, projects both into the SQLite index (including first-snapshot `baselineAssessment`), and a `budget` object on `result_json` / validate envelope. Shared `prepareRecordStepAppend` runs before that append on both `recordStepInternal` and `recordPlanReviewerStepWithSnapshot`. Terminal-run, missing-worktree, invalid-result, and new-at-limit failures call **no** `atomicAppend` and leave both record streams and SQLite projections unchanged. A failed unique append writes no snapshot line. A duplicate (`created: false` or admission `outcome: "duplicate"`, including duplicate-at-limit) writes no second snapshot line but idempotently repairs SQLite `steps` and budget-index projections from the existing record lines. Recording the same v1 verdict on a `v1_compat` or `mode=off` run is byte-compatible aside from existing fields. Readiness is never rewritten. Direct `--record` capture in `mode=enforced` emits the reserved-mode warning.

### 6.1 Shared apply function — `src/review-budget/apply.ts` (new)

This is the only place handlers call for budget **computation** and baseline safety-net capture. It does **not** persist a snapshot (see 6.2). `PendingBudgetSnapshot.baselineAssessment` uses the Phase 1 domain type (`src/review-budget/types.ts`); the same type Phase 5 re-exports on `ReviewerVerdict`.

```typescript
export interface PendingBudgetSnapshot {
	runId: string;
	stepName: string; // reviewer step_name used in snapshotIdempotencyKey
	phase: string | undefined;
	iteration: number | undefined;
	currentLedger: ParsedDeliveryBudget;
	findings: FindingDelta[];
	assessments: CreditAssessmentInput[]; // effective merged set
	baselineAssessment?: BaselineAssessment; // first snapshot only; persist on the record line
	derived: DerivedBudgetResult;
}

export interface ApplyPlanReviewBudgetInput {
	runId: string;
	stepName: string; // reviewer step_name; stamped onto pendingSnapshot for the snapshot idempotency key
	phase: string | undefined;
	iteration: number | undefined;
	planMarkdown: string;
	verdict: ReviewerVerdict;
	config: ReviewBudgetConfig;
	store: ReviewBudgetStore;
	hasPriorPlanReviewerStep: boolean;
	optInBaseline: boolean;
	warn: (message: string) => void; // required; used on enforced first-capture
}

export type ApplyPlanReviewBudgetResult =
	| { status: "skipped"; reason: "off" | "v1_compat" }
	| {
			status: "applied";
			verdict: ReviewerVerdict & { budget: DerivedBudgetResult };
			pendingSnapshot: PendingBudgetSnapshot;
	  }
	| { status: "error"; code: string; message: string };
```

Algorithm:

1. `rejectCliOwnedBudgetFields(verdict)` → error.
2. If `config.mode === "off"` → `skipped: off`.
3. `baseline = store.getBaseline(runId)`.
4. If no baseline and `hasPriorPlanReviewerStep` and not `optInBaseline` → `skipped: v1_compat`.
5. If no baseline and (no prior steps or opt-in): call `ensurePlanReviewBaseline` (Phase 7) with the same `warn` callback — **do not** capture inline. That helper parses, CAS-appends the baseline **record line**, and emits the reserved-mode warning on every first capture including this safety-net path. On ensure error, return the parse/capture code. Do not invent `B0 = 0`.
6. If baseline exists: parse **current** plan (fail closed — do not keep a stale `W` from a broken table). Parser already required complete `debtClaim` evidence on every negative row; if a stored/injected ledger nevertheless has `architectureDelta < 0` without `isCompleteDebtClaimEvidence(item.debtClaim)`, fail `BUDGET_DEBT_CLAIM_EVIDENCE_REQUIRED` (do not derive provisional `N` from id+coupling alone).
7. If this is the first snapshot for the run (`latestSnapshot == null`): require `verdict.baselineAssessment`; map `I` from `independentEffortEstimate`; copy the assessment onto `pendingSnapshot.baselineAssessment` so the record line retains authoritative `I`. If later snapshots: if `baselineAssessment` present → error `BASELINE_ASSESSMENT_UNEXPECTED`; omit the field on `pendingSnapshot` (recompute loads `I` from the first snapshot line).
8. For `active` runs, every `items[]` entry must include integer `effortDelta >= 0` and `architectureDelta` in the allowed set; `architectureDelta < 0` requires `coupling`. Missing fields → `BUDGET_ITEM_FIELDS_REQUIRED` with item id. Present `creditClaim` must include non-empty `targetPhase`, non-empty `before`/`after`, and valid minimal deltas (same sets as the parser). `creditClaim.creditClaimId` must not equal any current-ledger author `debtClaim.debtClaimId` (`CREDIT_CLAIM_ID_COLLISION`). Map each present `item.creditClaim` onto `FindingDelta.creditClaim`: `debtClaimId` = `creditClaim.creditClaimId`, `coupling` = item `coupling`, plus `targetPhase`, minimal deltas, `before`, and `after`.
9. Bind credit assessments to persisted claims:
   - Every `verdict.creditAssessments[].creditClaimId` must equal a current-ledger author `debtClaim.debtClaimId` **or** a current-item `creditClaim.creditClaimId`. Else `CREDIT_ASSESSMENT_UNKNOWN_CLAIM` listing the unknown ids.
   - Assessments do not carry evidence; `eligibleN` uses the ledger/`creditClaim` comparison fields.
10. Build the **effective** assessment set (Design Decisions):
   - `persisted` = `latestSnapshot?.assessments ?? []`.
   - Overlay current `verdict.creditAssessments` by `creditClaimId`.
   - For each author `debtClaim.debtClaimId` on the current ledger: if the claim is **new or changed** vs the previous snapshot’s `currentLedger` (different `coupling`, work-item `architectureDelta`, `targetPhase`, minimal deltas, `before`, or `after`, or absent from persisted), require a **current** assessment (`CREDIT_ASSESSMENT_REQUIRED` listing missing ids). Unchanged claims reuse the persisted assessment and do not require re-emit.
   - Reviewer-item `creditClaim` does not need a duplicate `--credit-assessment`.
   - Persist this merged set on `pendingSnapshot.assessments`.
11. `deriveBudget({ ..., assessments: effectiveAssessments })` — never the raw verdict array alone. Author `N` comes from complete persisted `debtClaim` + eligible intrinsic assessment.
12. **Do not** append a snapshot record line here (no `appendSnapshot` / `atomicAppend`).
13. Return `{ status: "applied", verdict: decorated, pendingSnapshot }` with `stepName` from the input. Do not mutate `readiness` or `items`.

`hasPriorPlanReviewerStep`: injected boolean. Callers compute it from `getStepsByPhase(db, runId, "plan")` filtering `step_name` starting with `reviewer:` (`src/db/operations-v1.ts:250–254`). Do not pass `Database` into `apply.ts`.

### 6.2 Shared record admission, then atomic snapshot + step persist

`recordStepInternal` already accepts an optional `dbContext` (`src/commands/run-v1.handler.ts:1193–1201`). Budget-recording handlers **must not** let it re-resolve a second Database **or** a second `RecordStore` **or** a second origin factory.

**Context factory** (same seam as `PromptCommandContext` / `src/commands/prompt-context.ts`): `src/commands/review-budget-context.ts` calls slice 10’s `createRecordContext` (`212` Phase 4 / §1.5) so it receives **one** worktree-re-rooted `RecordStore`, **one** `resolveDbContext` Database, and the sole already-redacted **`originFor` / `redactedRecorder`**. It then constructs `createReviewBudgetStore(recordStore, index)` and returns:

```typescript
export interface ReviewBudgetCommandContext extends RecordCommandContext {
	store: ReviewBudgetStore;
}

export function createReviewBudgetContext(
	...args: Parameters<typeof createRecordContext>
): ReviewBudgetCommandContext {
	const record = createRecordContext(...args);
	return {
		...record,
		store: createReviewBudgetStore(record.recordStore, createReviewBudgetIndex(record.db)),
	};
}
```

Do **not** return `{ db, config, controlPlane, recordStore, store }` without `originFor`. Protocol/invoke handlers call this factory (or accept an injected `ReviewBudgetCommandContext` in tests). They do **not** import `bun:sqlite`, do **not** construct a SQLite-only budget store, and do **not** assemble `RecordOrigin` inline.

#### 6.2.1 Shared pre-append admission — `prepareRecordStepAppend`

Factor the current `recordStepInternal` checks (`src/commands/run-v1.handler.ts:1201–1299`, everything **before** the `recordStep(...)` write) into slice 10’s exported `prepareRecordStepAppend` (`212` §4.2). **Both** `recordStepInternal` and `recordPlanReviewerStepWithSnapshot` call this function **before** any `RecordStore.atomicAppend` and before any SQLite `recordStep` / budget-index upsert. The helper itself performs **no** RecordStore append and **no** SQLite mutation.

**Do not redeclare a competing admit type.** This slice consumes slice 10’s `PrepareRecordStepOutcome` / `PreparedRecordStep`, which **includes `performer`**. A local shape of only `{ stepInput, maxSteps }` is forbidden — it has no compatible way to call `ctx.originFor`. Mapping `prepared` to a step-append op does not recapture metadata and does not drop `performer`.

```typescript
// Owned by slice 10 (`212` §4.2). Shown here so 06 implementers do not invent a fork.
export type PrepareRecordStepOutcome =
	| { outcome: "admit"; prepared: PreparedRecordStep }
	| { outcome: "duplicate"; prepared: PreparedRecordStep };

export interface PreparedRecordStep {
	runId: string;
	stepName: string;
	phase: string | undefined;
	iteration: number | undefined;
	resultJson: string;
	headCommit: string | undefined;
	sessionId?: string;
	model?: string;
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
	durationMs?: number;
	logPath?: string;
	effectiveWorkdir: string | undefined;
	maxSteps: number;
	/** Resolved performer. Never omitted after prepare; used by `originFor` only. */
	performer: RecordPerformer;
}

export async function prepareRecordStepAppend(
	params: RunRecordParams & { run: string; stepName: string; result: string },
	ctx: {
		db: Database;
		config: FiveXConfig;
		controlPlane?: ControlPlaneResult;
		recordStore: RecordStore;
	},
): Promise<PrepareRecordStepOutcome>;
```

`prepareRecordStepAppend` lives next to `recordStepInternal` in `src/commands/run-v1.handler.ts` (extract, do not duplicate the checks). Invoke/protocol **must** set `params.performer` (`{ kind: "agent", role: "reviewer", provider? }`) so it copies onto `prepared.performer`. The admit result is the **complete assembled step record**; callers map `prepared` to slice 10’s step-append op **without** capturing further metadata (`head_commit`, iteration, tokens, etc.) after admission. Do not invent a parallel step payload.

**Algorithm** (preserve today’s order and fail-closed codes; do not reorder so that an over-limit or terminal run can reach `atomicAppend`):

1. Resolve `{ config, db, controlPlane }` from `opts.dbContext` or `resolveDbContext()`. Same as `recordStepInternal` today.
2. **Active-run.** `getRunV1(db, params.run)`: missing → `RecordError("RUN_NOT_FOUND", ...)`. `run.status !== "active"` → `RecordError("RUN_NOT_ACTIVE", ...)` (terminal run: completed / aborted / failed). **Stop. No append.**
3. **Fail-closed execution context / worktree.** When `controlPlane?.controlPlaneRoot` is set, `resolveRunExecutionContext(db, params.run, { controlPlaneRoot })`. If `!ctxResult.ok`, throw `RecordError` with that `code` / `message` / `detail` (including `WORKTREE_MISSING`). **Stop. No append.** On success, keep `effectiveWorkingDirectory`.
4. **Metadata — `head_commit`.** Best-effort `getLatestCommit(effectiveWorkdir)` as today; git failures leave it unset. This is part of complete metadata assembly, not a failure.
5. **`maxStepsPerRun` + idempotency.** `maxSteps = getMaxStepsPerRun(live config)` (not `config_json`). `summary = computeRunSummary(db, params.run)`.
   - **Duplicate key** uses the existing `findExistingStep` contract: omitted `iteration`, or omitted/`null` `phase`, is **never** a duplicate (auto-increment / NULL-phase inserts are unique). A complete `(run_id, step_name, phase, iteration)` tuple is a duplicate when:
     - `opts.recordStore` is present **and** that store already has the step line for the tuple, **or**
     - `findExistingStep(db, ...)` returns a row.
   - RecordStore-first duplicate is required so a retry after unique `atomicAppend` + failed SQLite projection still counts as duplicate **at the ceiling** (P1.6 repair). Do **not** throw `MAX_STEPS_EXCEEDED` when the record already holds that step.
   - If `summary.total_steps >= maxSteps` **and** the key is **not** a duplicate → `RecordError("MAX_STEPS_EXCEEDED", ...)` with today’s `current_steps` / `max_steps` / `remediation` detail. **New-at-limit. Stop. No append.**
   - If at the ceiling **and** duplicate → continue (duplicate-at-limit is a no-op/repair, not a failure).
6. **JSON / invalid result.** `JSON.parse(params.result)`; on throw → `RecordError("INVALID_JSON", "--result must be valid JSON", { raw })`. Runs even on a would-be duplicate (today’s order). **Stop. No append.**
7. **Complete metadata assembly + performer.** If duplicate: return `{ outcome: "duplicate", prepared }` with `prepared.performer` set (copy `params.performer` or `resolveRecordPerformer` fallback per `212` §4.2) — do not resolve a new iteration, do not build a new step append. If admit: resolve `iteration` via `nextIteration` only when omitted (after the max-step check, so omitted iteration at the ceiling stays **new-at-limit**, not a false duplicate of the last row). Assemble the full prepared step (`runId`, `stepName`, `phase`, resolved `iteration`, `resultJson`, session/model/tokens/cost/duration/log, `headCommit`, `maxSteps`, **`performer`**). Return `{ outcome: "admit", prepared }`. Callers map `prepared` to the RecordStore step-append op from this assembled record only and pass `prepared.performer` to `ctx.originFor`.

Admission failures (steps 2, 3, 5 new-at-limit, 6) **must not** call `RecordStore.atomicAppend`, `recordStep`, or any budget-index upsert. Both record streams (step and budget) and both SQLite projections (`steps` and v8 snapshot index) remain unchanged. Tests spy/inject `atomicAppend` and assert it was not invoked.

#### 6.2.2 `recordStepInternal` uses the shared prepare

Refactor `recordStepInternal` to call `prepareRecordStepAppend(params, { dbContext })` (pass `recordStore` when the caller already has one; generic v1 callers may omit it).

- `outcome: "duplicate"`: return today’s no-op `RecordStepResult` (`recorded: false`, current totals). Do not append. If a `recordStore` was supplied and SQLite `steps` is missing the row, idempotently project that existing step line (same repair idea as P1.6, without a budget snapshot).
- `outcome: "admit"`: persist the **assembled** `prepared` record. If slice 10 has not yet switched the generic body to RecordStore, that persist remains today’s SQLite `recordStep` from `prepared` — **not** a second ad-hoc metadata capture after admission. If slice 10 already routes generic record through RecordStore, persist is `atomicAppend([stepAppendFrom(prepared)])` with `recordedEnvelope(ctx.originFor(prepared.performer))` then SQLite projection. Do not re-run admission inside the write.

This slice does **not** retarget every v1 `recordStepInternal` caller onto budget snapshots. Non-applied validate/invoke keep calling `recordStepInternal` with no budget line.

#### 6.2.3 Unique insert path — `recordPlanReviewerStepWithSnapshot`

`recordPlanReviewerStepWithSnapshot` (beside the context factory) is the production hook for applied plan-review `--record`. It **must not** skip `prepareRecordStepAppend` and must **not** call `atomicAppend` first.

1. Call `prepareRecordStepAppend(params, { db: ctx.db, config: ctx.config, controlPlane: ctx.controlPlane, recordStore: ctx.recordStore })` on the context factory’s **same** `ReviewBudgetCommandContext`. Invoke/protocol pass `params.performer` (`{ kind: "agent", role: "reviewer", provider? }`).
2. On thrown `RecordError` (terminal run, missing worktree / other execution-context failure, `INVALID_JSON`, new-at-limit `MAX_STEPS_EXCEEDED`, `RUN_NOT_FOUND`): **do not** call `atomicAppend`. Do not upsert SQLite `steps` or the budget index. Return/throw to the existing stderr-on-record-failure contract. Both record streams and both projections are unchanged.
3. On `outcome: "duplicate"` (including duplicate-at-limit): **do not** call `atomicAppend` and **do not** append any line. Load the existing step line and matching budget snapshot line by the same idempotency keys. Idempotently upsert SQLite `steps` (same row shape as `recordStep`, including decorated `result_json`) and the v8 snapshot index from those lines. Return the existing step (`recorded: false`). No second budget line, no second index row from a new append. This is P1.6 repair **and** the duplicate-at-limit no-op.
4. On `outcome: "admit"`: `origin = ctx.originFor(prepared.performer)` (sole constructor; already redacted). Map `prepared` to the slice-10 step-append op (no further metadata capture) with `...recordedEnvelope(origin)`. Build the pending snapshot’s RecordStore op with `snapshotIdempotencyKey(runId, { stepName, phase, iteration })` using the **prepared** step key (resolved iteration, not the possibly-omitted caller iteration), **the same `recordedEnvelope(origin)`**, and `pendingSnapshot.baselineAssessment` when this is the first snapshot. Call `ctx.recordStore.atomicAppend([stepAppend, budgetSnapshotAppend])` on that **same** `RecordStore`. Both lines **must** share that origin. Do not construct `RecordOrigin` inline. Do not stamp origin on the step and omit it on the budget line.
5. Unique success (`created: true`): project the assembled step into SQLite `steps` (existing `recordStep` row shape, including decorated `result_json`) and upsert the budget snapshot into the v8 index (including optional `derived` cache **and** `baseline_assessment_json`). Do not open a second RecordStore or Database inside the append.
6. Store-level duplicate (`created: false` after admit — race with another writer, or retry that admission treated as unique because SQLite count lagged): **do not skip projection and do not append any line.** Same load-and-upsert repair as step 3.
7. Throw from `atomicAppend`: neither record line is durable; SQLite index and `steps` are unchanged.

If slice 10 has not yet switched the generic `recordStepInternal` body to RecordStore, this wrapper **still** uses `atomicAppend` as the uniqueness decision **after** shared admission and treats SQLite `recordStep` as a projection of the successful batch. Do **not** restore P1.1 as a SQLite-only `db.transaction` around `steps` + budget tables — that would re-introduce SQLite-only authority. Do **not** call `recordStepInternal` for the unique budget write (that would SQLite-insert before RecordStore and skip admission-before-append on the snapshot).

Optional: keep `onUniqueInsert` on `recordStepInternal` only as a compatibility shim that **must not** be the budget-authority write. Prefer the wrapper so `src/review-budget/` stays free of `bun:sqlite` and of RecordStore layout.

Failed unique append leaves no snapshot line. A retry of a failed unique append may snapshot once, when the step actually lands. A retry of a successful unique append snapshots zero additional times and **must** still project: if the first attempt’s SQLite upsert threw, the retry’s admission-duplicate / `created: false` path restores both projections from the original lines. Exactly one snapshot line exists per successfully recorded unique reviewer step.

Index write after a successful `atomicAppend`: if the index upsert throws, the record lines remain; the command may fail the process. The **next command retry** repairs the cache via the duplicate / `created: false` upsert above. `reindexReviewBudget` (and slice 10 `records index`) remain bulk/offline repair. Never delete a successful budget line because the index failed. Never require a separately implemented slice-10 index command before a normal retry can restore v1 `steps` or the budget index.

**Baseline CAS** uses `captureBaseline` (single budget-line append, not `atomicAppend` with a step). Safety-net capture in apply still goes through `ensurePlanReviewBaseline` → facade → RecordStore. Baseline capture is not a reviewer-step record and does not go through `prepareRecordStepAppend`. Callers **must** pass `origin: ctx.originFor(performer)`:

- Template render / other non-agent callers: `performer = { kind: "system", role: "cli" }`.
- Invoke/protocol `--record` safety-net (first capture in the same command as the reviewer step): the **same** agent `performer` as `params.performer` / `prepared.performer`.

The facade does not call `originFor` itself. Missing origin is a programming error.

### 6.3 Protocol validate — `src/commands/protocol.handler.ts`

After `protocolValidateCore` and before `outputSuccess` (`:378–483`):

- When `role === "reviewer"` and resolved phase is `plan` (string `plan`, not numeric phase refs — `isNumericPhaseRef` is false for `"plan"`, `:131–140`): resolve **one** review-budget context (factory above), load plan markdown from `resolveRunExecutionContext` effective plan path, compute `hasPriorPlanReviewerStep`, read `optInBaseline` from new param, `loadConfig` `reviewBudget`, pass `warn` (stderr / injected sink — do not monkey-patch `console.warn`), call `applyPlanReviewBudget`.
- On `status === "error"`, `outputError(code, message)` **before** `outputSuccess` (same fail-closed rule as `--record` prerequisites, `:426–432`).
- On `applied`, replace `validated` with the decorated verdict so the envelope includes `budget`.
- On `skipped`, leave `validated` unchanged.

`--record` persist path (`:492–515`): when `applied` and `pendingSnapshot` is set, call `recordPlanReviewerStepWithSnapshot` with the context factory’s `ReviewBudgetCommandContext` (shared `prepareRecordStepAppend`, then `originFor(prepared.performer)` on both ops, then atomicAppend of step + snapshot only if admitted, then index projection). Keep the existing stderr-on-record-failure contract (no second stdout envelope). When not `applied`, keep today’s `recordStepInternal` call (no budget line; still goes through the same prepare; still pass `params.performer`).

New params on `ProtocolValidateParams` (`:37–50`): `optInBudgetBaseline?: boolean`. Wire `--opt-in-budget-baseline` on `validate reviewer` only (`protocol.ts:102–137`).

`--record` is not required to compute (validate-only can still decorate the envelope) but snapshot **lines** append **only** with `--record`, via `atomicAppend` with the unique step line. Validate-without-record still **computes and returns** `budget` in the envelope when a baseline exists. Capture-on-validate-without-record would create baselines during dry runs — **do not**. If no baseline and no `--record`, skip capture; if extra fields are missing, do not fail v1 dry-validate unless `--record` or an existing baseline makes the run `active`.

Tighten:

- Dry validate (no `--record`, no baseline): v1 rules only (optional new fields).
- `--record` or existing baseline: full apply (may capture via ensure, may require fields). Snapshot write still only with `--record`.

Direct `protocol validate --record` with no prior template render is a first-capture path: `ensurePlanReviewBaseline` must emit the enforced-mode warning here too.

### 6.4 Invoke record path — `src/commands/invoke.handler.ts`

After successful `validateStructuredOutput` (`:552–615`) and before `outputSuccess` (`:642`): if `role === "reviewer"` and phase is `plan`, same apply (decorate output). Honor `params.record`: if invoke without `--record`, decorate stdout only if baseline already exists; do not capture. If `--record`, full apply, then `recordPlanReviewerStepWithSnapshot` with the same `ReviewBudgetCommandContext` in the existing post-envelope record block (`:648–684`) (prepare, `originFor(prepared.performer)` on both ops, then atomicAppend only if admitted). Invoke **must** set `params.performer = { kind: "agent", role: "reviewer", provider: providerName }`.

Plumb `optInBudgetBaseline` onto invoke reviewer flags if the commander module already has a parallel option surface; if that is noisy, document opt-in via `protocol validate --record --opt-in-budget-baseline` only and skip the invoke flag. Prefer **one** opt-in flag on both commands for skill simplicity.

`ReviewerVerdictSchema` extra optional properties (Phase 5) allow providers to emit new fields.

### 6.5 Tests

- [ ] `test/unit/review-budget/apply.test.ts`: skip off; skip v1_compat; capture+derive (no snapshot written by apply); Addresses vs still-listed `R`; reject aggregates; require `I` on first record; reject `I` on second; missing item deltas on active run; `readiness` unchanged when `requiresHuman` true; `enforced` still does not rewrite readiness; **enforced first-capture calls `warn`** (injected sink); **eligible claim carried forward** on a second apply with no current assessment for that `DCn` (`N`/`D`/`E` unchanged) **when evidence fields are unchanged**; **new claim on a later ledger requires** `--credit-assessment`; overlay re-assessment of an existing claim wins; **`--credit-assessment` for an unknown `DCn` fails `CREDIT_ASSESSMENT_UNKNOWN_CLAIM`**; **changed `before`/`targetPhase` on an existing `DCn` requires a current assessment**; **author `N` uses persisted `debtClaim` architecture, not a reviewer `creditClaim` on a different id**; **reviewer `creditClaim` colliding with author `DC0` fails `CREDIT_CLAIM_ID_COLLISION`**; injected ledger with negative row and only id+coupling (no evidence) fails `BUDGET_DEBT_CLAIM_EVIDENCE_REQUIRED`.
- [ ] `test/unit/review-budget/persist-record.test.ts` (facade + `MemoryRecordStore`, and SQLite index projection): unique-append failure (injected `atomicAppend` throw) leaves **zero** snapshot lines and **zero** index snapshot rows; unique success leaves **exactly one** line and matching index row **with first-snapshot `baselineAssessment` on the record, facade, and index**; idempotent retry (`created: false`) leaves still **one** record line; **SQLite `steps` and/or budget-index projection failure after successful atomicAppend, then retry: `created: false`, still exactly one snapshot line, and both SQLite projections are present (repaired) after the retry**; wiping the index and reindexing still shows one snapshot **and the same `baselineAssessment`**. Admission failures are **not** covered only by this lump; they have focused wrapper tests below.
- [ ] `test/unit/commands/record-plan-reviewer-step.test.ts` (wrapper + injected `ReviewBudgetCommandContext` with `originFor` spy): **focused tests, one condition each**, asserting `atomicAppend` was **not** called and that step stream, budget stream, SQLite `steps`, and v8 snapshot index are unchanged:
  - terminal run (`status !== "active"`) → `RUN_NOT_ACTIVE`
  - missing worktree (`resolveRunExecutionContext` → `WORKTREE_MISSING`) → `WORKTREE_MISSING`
  - invalid result (`params.result` is not JSON) → `INVALID_JSON`
  - new unique step at `maxStepsPerRun` (omitted iteration or a new tuple) → `MAX_STEPS_EXCEEDED`
  - **duplicate-at-limit** with a complete key: (a) SQLite already has the row → `recorded: false`, `atomicAppend` not called, counts unchanged; (b) RecordStore already has the step+snapshot lines and SQLite `steps` / budget index are missing → `atomicAppend` not called; both projections repaired; still exactly one step line and one snapshot line
  - **admit with `params.performer = { kind: "agent", role: "reviewer", provider: "cursor" }`:** `atomicAppend` receives two ops whose `origin` is identical and equals `originFor`’s return value; `originFor` was called with that performer; neither op omits origin
  - **`records.redact = ["origin.actor"]`:** both ops omit `recorder.actor` while `installation_id` and `performer.kind` remain
- [ ] `test/unit/review-budget/ensure-baseline.test.ts` (or persist-record): baseline-only `captureBaseline` / `ensurePlanReviewBaseline` stamps `origin` from `originFor({ kind: "system", role: "cli" })`; safety-net path with an agent performer stamps that agent origin; missing origin is not a silent unattributed line
- [ ] `test/unit/commands/protocol-validate.test.ts`: envelope includes `result.budget` when recorded with a fixture plan; v1 verdict without budget fields still validates without `--record`; **direct `--record` with `mode=enforced` and no prior render emits the reserved-mode warning**; failed record does not leave a snapshot **line**.
- [ ] Do not assert any prompt/choose routing.

---

## Phase 7: Baseline capture, preflight, mid-review opt-in

**Completion gate:** Rendering `reviewer-plan` (not continued) on a new run with a valid table appends a baseline **record line** (`B0`) before the reviewer runs. Missing table returns `BUDGET_SECTION_MISSING` with a preflight message. A run that already has a plan-reviewer step and no baseline line does not capture. `--opt-in-budget-baseline` captures `capture_kind = opt_in` from the current table.

### 7.1 Ensure helper — `src/review-budget/ensure-baseline.ts` (new)

```typescript
export function ensurePlanReviewBaseline(input: {
	runId: string;
	planMarkdown: string;
	config: ReviewBudgetConfig;
	store: ReviewBudgetStore;
	hasPriorPlanReviewerStep: boolean;
	optIn: boolean;
	warn: (message: string) => void;
	/** Already-redacted origin from `ctx.originFor(performer)`. Required when this call captures. */
	origin: RecordOrigin;
}): 
	| { status: "skipped"; reason: "off" | "v1_compat" | "already" }
	| { status: "captured"; baseline: ReviewBudgetBaseline }
	| { status: "error"; code: string; message: string };
```

On capture, pass `origin` through to `store.captureBaseline({ ..., origin: input.origin })`. Do not construct origin here. Template render passes `ctx.originFor({ kind: "system", role: "cli" })`. Invoke/protocol `--record` safety-net passes `ctx.originFor(params.performer)` (agent reviewer).

If `mode === "enforced"` **and this call creates a baseline** (`status: "captured"`), `warn("reviewBudget.mode is enforced but enforcement is not implemented; recording advisory telemetry only")`. Emit once per successful first capture, not on `already` / skip. Apply’s safety-net (direct `protocol validate --record` / invoke `--record` with no prior render) **must** call this helper so the warning is not render-hook-only.

Error message for missing section must tell the orchestrator to run an author preflight that adds `## Delivery Budget` **before** the first reviewer, and must not mention inventing `B0 = 0`.

### 7.2 Template render hook — `src/commands/template.handler.ts`

After run context is resolved and the template is selected (`template.handler.ts:75+`, using `resolveAndRenderTemplate` in `template-vars.ts`): if `loadTemplate` selected name base is `reviewer-plan` **without** `-continued`, and a `run_id` is present, load plan markdown from the effective plan path, open the review-budget context (`createReviewBudgetContext` — includes `originFor`), call `ensurePlanReviewBaseline` with `optIn: false` and `origin: ctx.originFor({ kind: "system", role: "cli" })`. On error, `outputError` (fail closed) so the reviewer is not invoked against an unbudgeted new run.

Do **not** hook `reviewer-plan-continued` (baseline must already exist or the run is v1_compat).

Do **not** hook `author-generate-plan` (plan may not exist yet).

### 7.3 Invoke hook

`invoke.handler.ts` already renders the template before `session.run` (`:541–550`). Call the same ensure when the selected template is initial `reviewer-plan`, **before** `invokeStreamed`, so a missing section fails before tokens are spent.

### 7.4 Preflight skill behavior (docs in Phase 9; this phase is CLI)

CLI is the source of truth: skills cannot silently skip a missing section on a new run. Existing plans without a section fail at first `reviewer-plan` render with `BUDGET_SECTION_MISSING`. Plans with a negative architecture row but incomplete `### Debt Claims` evidence fail with `BUDGET_DEBT_CLAIM_EVIDENCE_MISSING` (or the more specific evidence codes). The skill (Phase 9) then delegates `author-process-plan-review` or a short author pass to add the table and evidence, then retries render.

### 7.5 Opt-in

`--opt-in-budget-baseline` (Phase 6) is the only capture path for `v1_compat` runs. Template render must **not** treat continued reviews as opt-in.

- [ ] Unit tests for `ensurePlanReviewBaseline` (off, already, v1_compat, missing section, **missing Debt Claims evidence**, happy capture, opt_in, **enforced warn on capture**, **no warn on skip/already**).
- [ ] Unit tests on `templateRender` with `startDir` / injected store if the handler can take a store factory; otherwise integration spawn in Phase 10.
- [ ] Warning sink for `enforced` (do not monkey-patch `console.warn`; pass `warn` callback — matches `test/setup.ts` guidance in `5x-cli/AGENTS.md`). Direct `protocol validate --record` coverage is in Phase 6.5 (same helper, same sink).

---

## Phase 8: Run-state output

**Completion gate:** `5x run state` JSON includes `review_budget` when a baseline exists; omitted when not. Text mode prints a short forecast block. Step `result_json` already contains `budget` from Phase 6; do not duplicate per-step in the header. After an index wipe, `I` and `baseline_direction` match the first snapshot’s persisted `baselineAssessment`.

### 8.1 JSON — `src/commands/run-v1.handler.ts`

In the `runV1State` success payload (`:1163–1178`), after loading steps, if `reviewBudget.mode !== "off"`:

```typescript
review_budget?: {
	status: "active" | "v1_compat" | "uninitialized";
	mode: ReviewBudgetMode;
	capture_kind?: "initial" | "opt_in";
	B0?: number;
	B?: number;
	W?: number;
	R?: number;
	projected_effort?: number;
	S?: number;
	N?: number;
	D?: number;
	E?: number;
	A?: number;
	P?: number;
	I?: number | null;
	baseline_direction?: BaselineDirection | null;
	budget_band?: BudgetBand;
	budget_alerts?: BudgetAlert[];
	requires_human?: boolean; // telemetry
	enforcement_implemented: false;
}
```

`status: uninitialized` — no baseline, no prior reviewer (or mode off → omit the object entirely when `off`).
`v1_compat` — no baseline, prior reviewer steps.
`active` — baseline present; fill numbers from `latestSnapshot` if any, else `W` from current plan parse + ceilings from `B0` with `R = 0` (pre-first-record).

If `mode === "enforced"`, still `enforcement_implemented: false`.

Prefer latest snapshot’s cached `derived` over live recompute for the header so `run state` matches the last recorded review. If `derived` is missing on the index (wiped cache, null `derived_json`), recompute via `deriveBudget` from the snapshot record: ledger + findings + **effective** assessments, and `I` from `baselineAssessment.independentEffortEstimate` when the latest snapshot has that field, otherwise from the run’s first snapshot line that includes `baselineAssessment` (later payloads omit it by contract). `baselineDirection` must come from that same `I` + `B0` + threshold — never from a missing `derived_json`. After an index wipe, `I` and `baselineDirection` must match the values computed at record time. If the plan file changed since the last snapshot, still show snapshot numbers and add `stale_plan: true` when `sumEffort(currentParse) !== snapshot.W` so operators see drift without silently mixing sources. If the index is empty but RecordStore has budget lines, reconstruct via `reindexReviewBudget` or a read-through from the facade — never report `uninitialized` when a baseline line exists. Do not report `I: null` / `baseline_direction: null` on an active first-review run whose record line still has `baselineAssessment`.

### 8.2 Text — `formatStateText` (`:635–675`)

After the `Steps: used / max` line, if `review_budget` is present:

```text
Budget:  W+R=12  E=10  band=over_effective  alerts=baseline_disputed  (advisory)
```

Keep it one or two lines. Do not dump the ledger.

### 8.3 Tests

- [ ] `test/unit/commands/run-state` (or existing run-v1 handler tests): fixture **RecordStore** with baseline + snapshot lines (index may be empty — facade must reconstruct); omit object when mode off; `v1_compat` shape; text formatter includes `Budget:`; **after wiping the index, `review_budget.I` and `baseline_direction` match the first snapshot’s `baselineAssessment` (identical to pre-wipe derived values)**.

---

## Phase 9: Templates, skills, and docs

**Completion gate:** Generated-plan template contains the budget table and Debt Claims subsection. Author/reviewer prompts explain stable IDs, `Addresses`, complete §4.3 evidence on author `DCn`, “do not emit totals,” and first-review `I`. Plan-review skill documents preflight and “do not route on `budget.requiresHuman`.” No implementation-review template (`reviewer-commit.md`) changes.

### 9.1 Plan template — `src/templates/default-artifacts.ts`

Insert after Design Decisions / before Phase 1 in `DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE` (`:1–51`):

```markdown
## Delivery Budget

- Estimate confidence: {low | medium | high}

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | {Work item} | {1\|2\|3\|5\|8} | {0 or ±1/2/3/5} | - | - | {Why this score} |

Scoring: effort 1 localized, 2 multi-file one subsystem, 3 cross-subsystem, 5 new abstraction/persistence/platform, 8 major migration/uncertainty. Tests belong to the item they validate. Architecture delta is maintenance burden (negative = simpler post-state). Negative architecture requires a debt claim `DCn (\`intrinsic\`|\`adjacent\`|\`unrelated\`)` **and** a `### Debt Claims` / `#### DCn` block with target implementation phase, minimal-compliant effort/architecture deltas, and concrete before/after evidence (`206` §4.3). `Addresses` lists review-item IDs incorporated into this row (`-` if none). Do not write totals, ceilings, or budget status — the CLI derives them.

Work-item IDs (`W1`, `W2`, …) are stable across revisions. Add rows or rescore with rationale; never reuse an ID for a different item. Debt-claim IDs (`DC0`, `DC1`, …) are stable; changing evidence on an existing `DCn` is a changed claim the next reviewer must re-assess.

### Debt Claims

#### DC0

- Target phase: {phase-N}
- Minimal-compliant effort delta: {0 or 1\|2\|3\|5\|8}
- Minimal-compliant architecture delta: {0 or ±1/2/3/5}
- Before: {concrete pre-state}
- After: {concrete simpler post-state}

Omit this subsection when every work-item architecture delta is ≥ 0.

### Surface Snapshot

- Subsystems: {n}
- Production files: {n}
- Persistent/external boundaries: {n}
```

Also add the same section to repo `docs/_implementation_plan_template.md` (this project’s `paths.templates.plan` source) so in-repo plans match shipped defaults. `5x init` does not overwrite existing `.5x/templates/implementation-plan-template.md` unless `--force`; existing projects use the Phase 7 preflight. Do not add an upgrade rewrite of customized templates.

### 9.2 Author prompts

`src/templates/author-generate-plan.md` (`:26–36`): require the Delivery Budget section; stable IDs; no totals; tests not scored separately; every negative architecture row must include a matching `### Debt Claims` / `#### DCn` block with target phase, minimal-compliant comparison, and non-empty before/after.

`src/templates/author-process-plan-review.md` (`:34–43`): when revising, keep IDs stable; put finding IDs in `Addresses` on the affected or new row; rescore with rationale; keep `#### DCn` evidence in sync (changing before/after, target phase, or minimal deltas is a **changed** claim); do not edit a “baseline” number in prose (there is none); do not delete the section.

### 9.3 Reviewer prompts

`src/templates/reviewer-plan.md`:

- Add a **Delivery budget** dimension: independently estimate initial-scope effort `I` (do not copy a total from the plan — the plan has no total); emit `--baseline-assessment`.
- Per item: `scopeClass`, `effortDelta`, `architectureDelta`, `coupling` when negative, optional `creditClaim` comparison (`206` §4.3 YAML fields as JSON) **only for claims this finding introduces**. Do **not** put author-ledger `DCn` evidence on `creditClaim`; assess those with `--credit-assessment` against the persisted claim.
- **Forbidden:** totals, ceilings, `budgetBand`, `requiresHuman` as a computed flag, changing `B0`.
- Keep v1 `action` semantics (`auto_fix` vs `human_required` as mechanical vs judgment — not budget routing).
- Emit example including `--baseline-assessment` and richer `--item` JSON (`:105–114`).

`src/templates/reviewer-plan-continued.md`:

- Do not emit `baselineAssessment`.
- Re-check `Addresses` vs still-open items; emit deltas for remaining items.
- Emit `--credit-assessment` **only** for author `DCn` that are **new or changed** since the last recorded review (same coupling, architectureDelta, targetPhase, minimal deltas, before, and after as the previous ledger → omit; CLI carries the persisted assessment). Do **not** re-emit every claim on every continued review. `creditClaimId` must match a persisted author `DCn` (or a reviewer-item `creditClaim` id this verdict introduces).
- Do not restart exhaustive review **as a hard CLI rule** (that is slice 07). Advisory text may say “prefer closure of prior findings” without changing routing.

Do **not** edit `reviewer-commit.md` / `reviewer-commit-continued.md`.

### 9.4 Skills

`src/skills/base/5x-plan/SKILL.tmpl.md`: generated plan must include Delivery Budget and, for every negative architecture row, a complete `### Debt Claims` block.

`src/skills/base/5x-plan-review/SKILL.tmpl.md`:

- After `run init`, if first reviewer render fails `BUDGET_SECTION_MISSING` or `BUDGET_DEBT_CLAIM_EVIDENCE_MISSING` (or other parse codes), invoke author to add the table and complete `#### DCn` evidence, commit, retry. Do not invent scores or before/after strings without reading the plan.
- Pass `--baseline-assessment` on first `protocol emit reviewer`.
- Pass `--credit-assessment` for each author `DCn` that is **new or changed** on the current table (first review: every current `DCn`; continued reviews: only new/changed ids, including evidence-field changes). Unchanged claims are carried forward by the CLI — do not re-emit them as a required ritual, and do not treat omission of an unchanged claim as a protocol error. Each `--credit-assessment` `creditClaimId` must name a claim already on the plan ledger (or a reviewer-introduced `creditClaim` in this verdict). Do not invent plan-side evidence in the assessment JSON.
- **Do not** treat `result.budget.requiresHuman` as a stop or human gate in this slice. Continue v1 routing (`readiness`, `human_required` items, `maxReviewIterations`).
- Mid-review resume: if `run state` shows `review_budget.status = v1_compat`, stay on v1 unless the human confirms opt-in; only then `protocol validate --opt-in-budget-baseline` after the table exists.
- `enforced` in `5x config show` does not change this skill yet.

Update `test/unit/harnesses/opencode-skills.test.ts` / `cursor-skills.test.ts` if they snapshot skill strings that must now mention budget flags.

### 9.5 CLI docs

`docs/v1/101-cli-primitives.md`: document `--baseline-assessment`, `--credit-assessment`, `--opt-in-budget-baseline`, and that `run state` may include `review_budget`. State clearly that advisory mode does not change command exit codes or readiness. Note that `--credit-assessment` names a persisted plan-side `DCn` (complete evidence already on the ledger) or a reviewer-introduced `creditClaim`.

Do not flip `docs/v2/206-review-budget-governance.md` status to Implemented until the slice ships; a one-line “advisory persistence: plan 208” note is optional.

- [ ] Templates, skills, 101 primitives, default artifact, repo plan template.
- [ ] Harness skill unit tests still pass (update expected substrings).

---

## Phase 10: Integration, compatibility, and exports

**Completion gate:** `bun test` green. Public exports updated. Compatibility matrix below covered by tests.

### 10.1 Public API — `src/index.ts`

Export parse function/types (`ParsedWorkItem`, `DebtClaimEvidence`, `BaselineAssessment` from review-budget domain types), budget record-line types, `ReviewBudgetStore` types, `createReviewBudgetStore`, `reindexReviewBudget`, `createReviewBudgetId`, arithmetic `deriveBudget` if useful for plugins. Do not export SQL helpers. Do not export a SQLite-only budget store or a 06-defined `RecordStore`. Protocol’s `BaselineAssessment` re-export may remain for existing protocol consumers; it must be the same type.

### 10.2 Compatibility matrix

| Case | Expected |
|------|----------|
| v1 `protocol emit reviewer --ready` | unchanged JSON |
| v1 `protocol validate reviewer` without run | unchanged |
| `mode=off`, new plan, full plan-review loop | no baseline **line**; no `budget` on steps |
| `advisory`, new plan with table | `B0` **record line** at `reviewer-plan` render; first record has `I` + `budget` |
| `advisory`, new plan without table | `BUDGET_SECTION_MISSING` at render; no baseline line |
| `advisory`, negative row without Debt Claims evidence | parse/capture fails (`BUDGET_DEBT_CLAIM_EVIDENCE_MISSING`); no baseline line |
| Mid-review run (reviewer steps exist, no baseline) | v1_compat; v1 verdict records; no capture |
| Opt-in flag + table on mid-review run | `capture_kind=opt_in`; subsequent records decorate |
| Reviewer JSON with `"budgetBand":"within_standard"` | `INVALID_STRUCTURED_OUTPUT` |
| Malformed table after baseline exists | record fails; `B0` **line** untouched |
| `enforced` mode | warning on **every** first capture (render **and** direct `--record`); same as advisory routing |
| Implementation-review `protocol validate reviewer --phase phase-1` | no plan-budget apply; v1 item contract |

### 10.3 Integration tests — `test/integration/commands/`

New `review-budget.test.ts` (spawn CLI, `cleanGitEnv()`, `stdin: "ignore"`, `timeout: 15000`+):

- Temp repo + `5x init` + plan with budget table + `run init` + `template render reviewer-plan` creates baseline (query via `run state` JSON **and** RecordStore/facade — not SQLite-only). Process-durable CLI tests require a process-durable `RecordStore` impl (slice 10 working-tree). Until that impl merges, cover the same path with `MemoryRecordStore` in unit/integration-harness tests; do not green the matrix by writing SQLite-only baselines.
- `protocol emit` + `protocol validate --record --phase plan` decorates and persists.
- Existing plan without section: render fails with `BUDGET_SECTION_MISSING`.
- Plan with negative row and no Debt Claims subsection: render/capture fails with `BUDGET_DEBT_CLAIM_EVIDENCE_MISSING`.
- Seed a reviewer step then render: no baseline (`v1_compat`).
- Opt-in path.

### 10.4 Config layering integration

Overlay `5x.toml.local` `[reviewBudget] mode = "off"` disables capture in the temp project.

- [ ] Exports + integration tests + full `bun test`.
- [ ] Update plan-input metadata `Generated plan` to this file path if the docs owner wants it; not required for the slice to compile.

---

## Files Touched

| File | Change |
|------|--------|
| `src/review-budget/types.ts` | **New.** Domain types, defaults, guards (`DebtClaimEvidence`, `isCompleteDebtClaimEvidence`). Owns shared structural `BaselineAssessment` used by Phase 4 payload/facade/index and re-exported by Phase 5 protocol. |
| `src/review-budget/arithmetic.ts` | **New.** Pure derivation; `eligibleN` requires complete persisted evidence. |
| `src/review-budget/apply.ts` | **New.** Validate/compute orchestration; bind assessments to persisted claims; returns `pendingSnapshot` (includes first-review `baselineAssessment`); no snapshot write. |
| `src/review-budget/ensure-baseline.ts` | **New.** Capture / skip / preflight; enforced-mode warning on every first capture; passes `origin` from `ctx.originFor` into `captureBaseline`. |
| `src/review-budget/record-lines.ts` | **New.** Budget-line payloads, idempotency keys, encode/decode (snapshot decode round-trips `baselineAssessment` from Phase 1 domain types). Consumes slice-10 `RecordStore` types. Does not import `src/protocol.ts`. |
| `src/commands/review-budget-context.ts` | **New.** Embeds slice 10 `createRecordContext` (`originFor` / `redactedRecorder` / `recordStore`) + facade/index factory (handlers do not import `bun:sqlite`). Returns `ReviewBudgetCommandContext`. `recordPlanReviewerStepWithSnapshot` calls `prepareRecordStepAppend` (retains `prepared.performer`) then `originFor` on both ops then `atomicAppend` only on admit. |
| `src/parsers/delivery-budget.ts` | **New.** Fail-closed markdown parser including `### Debt Claims` evidence. |
| `src/parsers/plan.ts` | No logic change; add regression tests only. |
| `src/config.ts` | `ReviewBudgetConfigSchema`; `KNOWN_ROOT_CONFIG_KEYS`. |
| `src/templates/5x.default.toml` | `[reviewBudget]` table. |
| `src/db/schema.ts` | Migration v8 **index** tables; max version 8; `record_idempotency_key` + `record_seq` order; `baseline_assessment_json` on snapshots. |
| `src/control-plane/ids.ts` | `createReviewBudgetId`. |
| `src/control-plane/review-budget-store.ts` | **New.** Facade over `RecordStore`; optional SQLite index. `appendSnapshot` / snapshot record type use Phase 1 `BaselineAssessment`. `captureBaseline` requires `origin` from `originFor`. |
| `src/control-plane/review-budget-index.ts` | **New.** Rebuildable SQLite index + `reindexReviewBudget`. |
| `src/control-plane/index.ts` | Re-exports. Do **not** add `record-store.ts` in this slice. |
| `src/protocol.ts` | Item/verdict extensions; schema; CLI-owned key reject helper; import and re-export `BaselineAssessment` from review-budget domain types (do not redeclare); `CreditClaim` evidence fields remain reviewer-introduced only. |
| `src/protocol-normalize.ts` | Pass through new fields. |
| `src/commands/protocol.ts` | Emit/validate flags. |
| `src/commands/protocol-emit.handler.ts` | Parse assessment flags and item extras. |
| `src/commands/protocol.handler.ts` | Apply budget on plan-review validate; `prepareRecordStepAppend` then `originFor(prepared.performer)` then `atomicAppend` step+snapshot on `--record`; pass `warn` into apply/ensure; pass agent `params.performer`. |
| `src/commands/protocol-helpers.ts` | Only if reject helper is called from shared validate. |
| `src/commands/invoke.ts` / `invoke.handler.ts` | Ensure baseline; apply on plan-review; `params.performer` agent/reviewer/provider; `prepareRecordStepAppend` then `originFor` then `atomicAppend` step+snapshot on `--record`; optional opt-in flag. |
| `src/commands/template.handler.ts` | Ensure baseline on initial `reviewer-plan` render via RecordStore facade; `originFor({ kind: "system", role: "cli" })`. |
| `src/commands/run-v1.handler.ts` | Extract `prepareRecordStepAppend`; `recordStepInternal` calls it before persist; `review_budget` on state JSON/text (facade/index; reconstruct from record lines if index empty). |
| `src/templates/default-artifacts.ts` | Delivery Budget section plus Debt Claims subsection. |
| `src/templates/author-generate-plan.md` | Require scored table and complete debt-claim evidence. |
| `src/templates/author-process-plan-review.md` | Stable IDs + Addresses + keep `#### DCn` evidence in sync. |
| `src/templates/reviewer-plan.md` | `I`, per-item deltas, no totals; assess persisted author claims. |
| `src/templates/reviewer-plan-continued.md` | No `I`; Addresses / remaining deltas; new-or-changed credit assessments only (including evidence changes). |
| `src/skills/base/5x-plan/SKILL.tmpl.md` | Budget section + Debt Claims requirement. |
| `src/skills/base/5x-plan-review/SKILL.tmpl.md` | Preflight, flags, carried-forward assessments, v1 routing preserved. |
| `src/index.ts` | Public exports. |
| `docs/_implementation_plan_template.md` | Same budget section and Debt Claims subsection as shipped template. |
| `docs/v1/101-cli-primitives.md` | New flags and `run state` field. |
| `test/unit/db/schema.test.ts` and `schema-v6`/`v7` | Expect version 8. |
| `test/unit/db/schema-v8.test.ts` | **New.** |
| `test/unit/review-budget/*.test.ts` | **New** (types, record-lines codec, apply, arithmetic, persist-record, ensure-baseline). |
| `test/unit/commands/record-plan-reviewer-step.test.ts` | **New.** Focused wrapper admission tests (terminal run, missing worktree, invalid result, new-at-limit, duplicate-at-limit repair) plus origin equality / `originFor` spy / actor redaction. |
| `test/unit/parsers/delivery-budget.test.ts` | **New.** |
| `test/unit/parsers/plan.test.ts` | Placement regressions. |
| `test/unit/control-plane/review-budget-store-contract.test.ts` | **New.** Facade over `MemoryRecordStore` ± SQLite index; imports `BaselineAssessment` from domain types, not protocol. |
| `test/unit/control-plane/review-budget-index.test.ts` | **New.** Reindex from record lines using Phase 1 `BaselineAssessment`. |
| `test/unit/config.test.ts`, `config-v1.test.ts`, `config-registry.test.ts` | Defaults and layering. |
| `test/unit/protocol.test.ts`, `protocol-emit.test.ts`, `protocol-validate.test.ts`, `protocol-helpers.test.ts` | New fields; v1 compat. |
| `test/unit/harnesses/opencode-skills.test.ts`, `cursor-skills.test.ts` | Skill string updates. |
| `test/integration/commands/review-budget.test.ts` | **New.** CLI round trips. |

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `review-budget/types.test.ts` | Structural `BaselineAssessment` is exported from domain types; Phase 1–4 consumers type-check against it without `src/protocol.ts` |
| Unit | `review-budget/arithmetic.test.ts` | `B=4` ceilings; bands; both disagreement directions; `P` not netted; `R` dedup + re-entry; polish excluded; `D` caps; `requiresHuman` flags; incomplete debt evidence excluded from `N` |
| Unit | `parsers/delivery-budget.test.ts` | Canonical table (W2 effort `5` + complete `#### DC0` evidence); every `DeliveryBudgetParseCode`; empty ≠ zero; effort `4` rejected; negative row without evidence rejected |
| Unit | `parsers/plan.test.ts` | Budget section does not break phase/checklist parse |
| Unit | `config*.test.ts` | Defaults, overlay `off`, reject bad mode/percent, registry keys |
| Unit | `schema-v8.test.ts` | v8 **index** tables, v7→v8, CHECKs, unique `run_id` + `record_idempotency_key`, nullable `baseline_assessment_json` |
| Unit | `review-budget/record-lines.test.ts` | Snapshot codec round-trips `baselineAssessment` from Phase 1 domain types; omit-when-absent; no `src/protocol.ts` import |
| Unit | `review-budget-store-contract.test.ts` | Capture CAS via `MemoryRecordStore` ± SQLite index **with fixture origin**; append order; **same-timestamp insertion-order tie-break**; **ledger round-trip of `debtClaim` evidence**; **first-snapshot `baselineAssessment` round-trip** (domain type, not protocol); no SQLite-only authority |
| Unit | `review-budget-index.test.ts` | Wipe index, `reindexReviewBudget` restores baselines/ledgers/assessments **and first-snapshot `baselineAssessment`** (domain type); **`I` / `baselineDirection` recompute identically from the record line** |
| Unit | `protocol.test.ts` / `protocol-emit.test.ts` | Flags round-trip; reject CLI-owned keys; `BaselineAssessment` is a re-export of the Phase 1 domain type (not a second declaration) |
| Unit | `protocol-validate.test.ts` / `apply.test.ts` | Decorate on record; skip off/compat; fail malformed current table without mutating `B0`; apply does not write snapshots; assessments bind to persisted claims; incomplete author evidence fails closed |
| Unit | `persist-record.test.ts` | Failed `atomicAppend` leaves no snapshot **line**; unique success is 1:1 with the step line; **`created: false` retry after projection failure does not duplicate the record and repairs both SQLite projections**; first-snapshot `baselineAssessment` survives index wipe |
| Unit | `record-plan-reviewer-step.test.ts` | Wrapper calls `prepareRecordStepAppend` before `atomicAppend`; **terminal run / missing worktree / invalid JSON / new-at-limit: `atomicAppend` not called, both record streams and both projections unchanged**; **duplicate-at-limit: no append, projections repaired** |
| Unit | `ensure-baseline` + template/invoke unit if injectable | Capture before invoke; missing section; **enforced warn on every first-capture path including direct `--record`** |
| Unit | run-state handler | `review_budget` shapes; text line; **`I` / `baseline_direction` after index wipe match first-snapshot `baselineAssessment`** |
| Unit | harness skill tests | Mentions of emit flags / preflight / new-or-changed credit assessments |
| Integration | `review-budget.test.ts` | Init → plan → render capture → emit/validate record → `run state`; missing section; missing debt-claim evidence; v1_compat; opt-in; `mode=off` overlay |

Edge cases (must appear in unit tests):

- Duplicate `W1`.
- Effort `4` rejected (canonical happy-path table uses `5` for W2).
- Negative architecture without `DCn`.
- Negative architecture with table `DCn` but missing `### Debt Claims` / empty `Before` / invalid `targetPhase`.
- Orphan `#### DC` block with no matching work-item row.
- Finding in `Addresses` and still in `items` counts in `R`.
- First review missing `baselineAssessment`.
- Second review including `baselineAssessment`.
- Author adds `DC1` in revision without `--credit-assessment`.
- Eligible `DC0` retained across a continued review with **no** current assessment for `DC0` (`N`/`D`/`E` do not drop to zero) when evidence fields are unchanged.
- Changed `before` (or `targetPhase` / minimal deltas) on existing `DC0` requires a current `--credit-assessment`.
- `--credit-assessment` for a `DCn` not on the current ledger and not a reviewer `creditClaim` fails.
- Reviewer `creditClaim` id colliding with an author `DCn` fails.
- Author `N` is computed from persisted ledger evidence, not from a reviewer `creditClaim` attached to a different finding.
- Reviewer-emitted `budget` object.
- `b0 > 0` CHECK: cannot insert 0 even if a test bypasses the parser.
- Store round-trip: `originalLedger` / `currentLedger` retain `targetPhase`, minimal deltas, `before`, `after`.
- Record line is present after capture even if the SQLite index is wiped and rebuilt.
- First-snapshot `baselineAssessment` is present on the facade record and index after reindex; `I` and `baselineDirection` recompute identically from the record line (not from `derived_json`).
- Phase 4 codec, facade, and index tests import `BaselineAssessment` from `src/review-budget/types.ts` and compile without `src/protocol.ts` (Phase 4 is independently type-complete before Phase 5).
- No baseline index row when RecordStore has no baseline line.
- Step/`atomicAppend` failure after apply: zero snapshot lines.
- Admission failure **before** append: terminal run (`RUN_NOT_ACTIVE`), missing worktree (`WORKTREE_MISSING`), invalid result (`INVALID_JSON`), new step at `maxStepsPerRun` (`MAX_STEPS_EXCEEDED`) — `atomicAppend` not called; step stream, budget stream, SQLite `steps`, and budget index unchanged.
- Duplicate-at-limit (record already has the step; SQLite projection missing): no `atomicAppend`; both projections repaired; no second line.
- Duplicate step re-record: still exactly one snapshot line.
- Successful `atomicAppend` then SQLite projection failure, then retry (`created: false`): original record is not duplicated; both `steps` and budget-index projections are repaired.
- Two snapshots in the same `createdAt` second: `latestSnapshot` is the later append (record insertion order).
- Direct `protocol validate --record` with `mode=enforced` and no prior render: reserved-mode warning emitted.

---

## Not In Scope

- **Routing / human budget gates / `ready_with_corrections` rewriting** — `07-plan-review-governance.plan-input.md`. Advisory records `requiresHuman` only.
- **Deferred findings, accepted-risk ledger, continued-review hunk validation, `lateDiscovery`** — slice 07.
- **Implementation-review four-class `scopeClass`, `planImpact`, `--credit-realization`, quality-gated shortcut** — `08-implementation-review-governance.plan-input.md`.
- **Dashboard / browser budget UI** — `04-control-plane-dashboard.plan-input.md`.
- **`RecordStore` implementation, working-tree JSONL layout, `records index` / `records backfill` CLI, `.gitattributes`, progress resolution, doctor `records` check** — slice 10. This slice consumes the frozen Phase-1 interface (including budget-stream append/read and `atomicAppend`) and defines budget-line payloads/keys plus the SQLite index projection. Do not fork or re-declare `RecordStore` here. Do not ship a SQLite-backed `RecordStore`.
- **SQLite-only `ReviewBudgetStore` as the system of record, or a later migration off SQLite-authored budget rows.** Forbidden by `207` §2.6.
- **Changing default percentages after calibration** — open question in `206` §10.
- **Rewriting `maxReviewIterations` or step-count `maxStepsPerRun`** — unchanged backstops.
- **Auto-overwriting existing project `implementation-plan-template.md` on upgrade.**
- **Emitting `credit_unrealized` or reconciling provisional `D` after implementation.**

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Types (incl. `BaselineAssessment`) + pure arithmetic + `B=4` fixtures | 1 day |
| 2 | Delivery Budget parser + plan-parse regressions | 1–2 days |
| 3 | `reviewBudget` config, registry, default TOML | 0.5–1 day |
| 4 | Budget record lines + RecordStore facade + v8 index | 1–2 days |
| 5 | Protocol types, emit flags, normalize, reject aggregates | 1 day |
| 6 | apply() + shared `prepareRecordStepAppend` + validate/invoke decorate/record | 2 days |
| 7 | ensureBaseline, template/invoke hooks, opt-in | 1–2 days |
| 8 | `run state` JSON/text | 0.5–1 day |
| 9 | Templates, skills, 101 docs | 1–2 days |
| 10 | Integration matrix, exports, `bun test` | 1–2 days |
| **Total** | | **10.5–16 days** |

Phases 1–3 (types, parser, config) may proceed without slice 10. **Phase 4 and every later persistence/record path are blocked on slice 10 Phase 1** (frozen `RecordStore` + in-memory impl, including budget-stream append/read and atomic multi-append). Phase 4 is independently type-complete: `BaselineAssessment` lives in Phase 1 domain types, so facade, codec, and index rebuild compile and test before Phase 5. Phase 4 is a hard prerequisite to 6–8. Phase 6 record wiring includes P1.8 (`prepareRecordStepAppend` before `atomicAppend`). Phase 5 imports/re-exports that type and can overlap 4 once the freeze exists; it is not a type prerequisite for Phase 4. Phase 9 can overlap 6–8 once flag names are frozen in Phase 5. Process-durable CLI integration tests wait for slice 10’s working-tree `RecordStore` impl; until then, persist tests use `MemoryRecordStore`. Do **not** retarget authority back to SQLite if the working-tree impl lags.

---

## Revision History

### 1.7 — September 1, 2026

Addresses **P0.8** in the September 1 addendum of [`docs/development/reviews/5x-cli-docs-development-plans-212-git-native-run-records-plan-review.md`](../reviews/5x-cli-docs-development-plans-212-git-native-run-records-plan-review.md) (Revision 1.6 origin-attribution re-review of slice 10). Coordinated with [`212-git-native-run-records-plan.md`](./212-git-native-run-records-plan.md) §1.5. Prior 208 P0/P1.1–P1.8 remain in force.

1. **P0.8 — Consume slice 10’s origin factory.** `review-budget-context.ts` embeds `createRecordContext` and returns `ReviewBudgetCommandContext` (`originFor` / `redactedRecorder` / `recordStore` + facade). The wrapper no longer returns `{ db, config, controlPlane, recordStore, store }` without `originFor`. `prepareRecordStepAppend` is slice 10’s type (`PreparedRecordStep.performer` retained); this slice does not redeclare `{ stepInput, maxSteps }`. `recordPlanReviewerStepWithSnapshot` stamps `ctx.originFor(prepared.performer)` on both the step and budget snapshot ops. `CaptureBaselineInput.origin` and `ensurePlanReviewBaseline.origin` are required from `originFor`. Tests cover invoke-reviewer origin equality, baseline-only `originFor`, and actor redaction.

### 1.6 — August 29, 2026

Addresses **P1.8** in the **Addendum (2026-08-29) — Revision 1.5 post-limit staff re-review** of [`docs/development/reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md`](../reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md). Prior P0/P1.1–P1.7 and P2 items remain in force.

1. **P1.8 — Preserve existing record admission checks before the RecordStore atomic append.** Factor `prepareRecordStepAppend` from the current `recordStepInternal` body (`src/commands/run-v1.handler.ts:1201–1299`) and require **both** `recordStepInternal` and `recordPlanReviewerStepWithSnapshot` to call it **before** `RecordStore.atomicAppend`. Admission preserves active-run, fail-closed execution-context/worktree, JSON, `maxStepsPerRun`, idempotency, complete metadata assembly, and duplicate-at-limit as a no-op/repair (RecordStore-first so P1.6 projection repair still works at the ceiling). Terminal-run, missing-worktree, invalid-result, and new-at-limit failures call no append and leave both record streams and index projections unchanged. Focused wrapper tests cover each condition with an `atomicAppend` spy.

### 1.5 — August 29, 2026

Addresses **P1.7** in the **Addendum (2026-08-29) — Revision 1.4 final staff re-review** of [`docs/development/reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md`](../reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md). Prior P0/P1.1–P1.6 and P2 items remain in force.

1. **P1.7 — Make Phase 4 independently type-complete.** Shared structural `BaselineAssessment` (`independentEffortEstimate`, `confidence`, `reason`) is declared in Phase 1 `src/review-budget/types.ts`, not in Phase 5 `src/protocol.ts`. Phase 4 payload codec, facade, and index rebuild import that type and type-test against it (no `src/protocol.ts` import). Phase 5 protocol changes import and re-export the same type; they do not declare a second copy. Phase 1 and Phase 4 completion gates require facade, codec, and reindex to compile and pass before Phase 5.

### 1.4 — August 29, 2026

Addresses **P1.5** and **P1.6** in the **Addendum (2026-08-29) — Revision 1.3 staff re-review** of [`docs/development/reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md`](../reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md). Prior P0/P1.1–P1.4 and P2 items remain in force.

1. **P1.5 — Preserve first-review `baselineAssessment` through facade and index rebuild.** `ReviewBudgetSnapshotRecord`, `appendSnapshot` / `PendingBudgetSnapshot` inputs, encode/decode, and the v8 `baseline_assessment_json` column now carry the optional initial-only assessment already on `BudgetSnapshotPayload`. Reindex and read-through copy it from the record line; they do not reconstruct `I` from `derived_json`. After an index wipe, `deriveBudget` / `run state` recompute identical `I` and `baselineDirection` from that field (later snapshots load `I` from the first snapshot line). Store, index, persist, and run-state tests require the round-trip.
2. **P1.6 — Repair projections on an idempotent record retry.** `created: false` no longer skips SQLite projection. The persist wrapper loads the existing step and snapshot record lines and idempotently upserts `steps` plus the budget index without appending a line. A retry after unique `atomicAppend` success + projection failure restores both projections and does not duplicate the record. Command retry is the repair path; `reindexReviewBudget` remains bulk/offline.

### 1.3 — August 29, 2026

Addresses **P0** in the **Addendum (2026-08-29) — Revision 1.2 final re-review** of [`docs/development/reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md`](../reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md). Prior P1.1–P1.4 and P2 items remain in force, with P1.1 atomicity remapped onto the shared `RecordStore` contract.

1. **P0 — Canonical record-tier persistence.** Slice 10 Phase 1 (`RecordStore` interface + in-memory implementation, including budget-stream append/read and `atomicAppend`) is an explicit prerequisite before this slice’s persistence work. Authoritative `B0`, governing `B`, ledgers, assessments, and claims persist as RecordStore budget lines this slice defines (payloads and idempotency keys only). SQLite v8 tables are a rebuildable derived index/cache of those lines plus CLI-computed forecasts. `ReviewBudgetStore` is a facade over `RecordStore`, not a SQLite-only authority. This slice does not implement `RecordStore`, working-tree JSONL, or `records index`. P1.1 1:1 snapshot↔step is `atomicAppend` of the step line and a snapshot line keyed to the same idempotency tuple; idempotent retries add neither line; SQLite `steps`/budget rows are projections.

### 1.2 — August 29, 2026

Addresses **P1.4** in the **Addendum (2026-08-29) — Revision 1.1 re-review** of [`docs/development/reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md`](../reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md). Prior P1.1–P1.3 and P2 items remain as in 1.1.

1. **P1.4 — Persist and validate complete plan-side debt-credit evidence.** Negative author work items no longer parse with only `debtClaimId` + `coupling`. `ParsedWorkItem.debtClaim` is a `DebtClaimEvidence` object requiring `targetPhase`, minimal-compliant effort/architecture deltas, and non-empty before/after. The parser joins the seven-column table to a required `### Debt Claims` / `#### DCn` subsection. Baseline and snapshot ledger JSON round-trip that object. `--credit-assessment` must name a persisted author claim or a reviewer-introduced `creditClaim`; unknown ids fail. `eligibleN` reads architecture reduction from that persisted claim, not from assessment-only metadata. Reviewer-item `creditClaim` cannot backfill author-ledger evidence or collide with an author `DCn`. Unchanged-claim detection includes the evidence fields. Parser, arithmetic, apply, store, template, and skill tests cover the contract.

### 1.1 — August 29, 2026

Addresses all **P1** and **P2** items in [`docs/development/reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md`](../reviews/5x-cli-docs-development-plans-208-review-budget-advisory-plan-review.md) (no addendum; original review).

1. **P1.1 — Atomic snapshot + reviewer step.** `applyPlanReviewBudget` no longer `appendSnapshot`s. A review-budget context factory shares one `resolveDbContext` Database with the store. `recordStepInternal` gains `onUniqueInsert` inside `db.transaction` with the `steps` insert; failed records and idempotent retries (`recorded: false`) insert no snapshot. Tests require exactly one snapshot per successfully recorded unique reviewer step.
2. **P1.2 — Carry forward unchanged debt-claim assessments.** Apply merges current `creditAssessments` over persisted snapshot assessments. Unchanged claims (same `debtClaimId`, `coupling`, and work-item `architectureDelta`) do not require re-emit and still contribute to `N`/`D`/`E`. New or changed claims still require a current assessment. Phase 9 continued-review prompts and the plan-review skill match this rule (no “re-emit every assessment”).
3. **P1.3 — Canonical effort example.** Parser fixture `W2` uses allowed effort `5`. Effort `4` remains the invalid-input test only (`206` §6.1’s published `4` is noted as out of scale).
4. **P2 — Deterministic snapshot order.** `listSnapshots` / `latestSnapshot` order by `(created_at, rowid)` (memory: insertion seq). Same-timestamp contract tests required.
5. **P2 — Enforced-mode warning on every first capture.** `ensurePlanReviewBaseline` owns the warning and is the capture path for template render, invoke, **and** apply’s safety-net (direct `protocol validate --record`). Apply takes `warn`. Direct-record test required.

### 1.0 — August 29, 2026

Initial draft.

---

## Provenance

v2 area 6 (`docs/v2/206-review-budget-governance.md`) addresses unbounded plan-review growth described in `docs/v2/200-overview.md` §1.4. This plan implements the **advisory** rollout step (`206` §8.2.1) from `docs/v2/plan-inputs/06-review-budget-advisory.plan-input.md`. Persistence follows `207-state-segmentation.md` §2.6: budget baselines/ledgers/claims are repository **Record** tier via slice 10’s frozen `RecordStore`; SQLite is a rebuildable index (`docs/v2/plan-inputs/10-git-native-run-records.plan-input.md`). The control-plane facade lives beside the slice-3 store boundary (`205-prompt-queue-foundation-plan.md`). Enforcement, convergence routing, and human tradeoff gates are explicitly left to `07-plan-review-governance.plan-input.md`. Implementation-review budget inheritance is left to `08-implementation-review-governance.plan-input.md`.
