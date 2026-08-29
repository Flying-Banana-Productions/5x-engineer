# Review-Budget Advisory Foundation

**Version:** 1.2
**Created:** August 29, 2026
**Status:** Draft — revision 1.2 addressing staff review addendum (P1.4)

---

## Executive Summary

Plan review today has no priced scope. Reviewers emit `auto_fix` items with equal weight, continued reviews restart exhaustive discovery, and the only stop is `maxReviewIterations` after growth has already landed. This slice adds the advisory half of area 206: newly generated plans carry a scored `Delivery Budget` table; the CLI parses it, captures an immutable baseline `B0` once before the first reviewer, and records deterministic forecasts (`W`, `R`, `S`, `N`, `D`, `E`, `A`, `P`, bands, alerts, `requiresHuman`) as telemetry.

Advisory mode **does not change v1 routing**. `requiresHuman` is recorded, not acted on. `mode = "enforced"` is a reserved config value treated as advisory until `07-plan-review-governance`. Implementation-review contracts, debt-credit realization, human budget gates, and dashboard UI stay out.

### Scope

**In scope:**

- Required `Delivery Budget` + surface-snapshot sections in newly generated plans, with a fail-closed parser for stable IDs, effort, architecture delta, complete plan-side debt-claim evidence (`targetPhase`, minimal-compliant comparison, non-empty before/after), and `Addresses`.
- `[reviewBudget]` config (`off` | `advisory` | reserved `enforced`), default `advisory`, layered like the rest of `5x.toml`.
- `ReviewBudgetStore` (SQLite + memory) with UUID ids: immutable `B0`, original/current ledgers, surface snapshot, assessments, claims, and derived results.
- Plan-review protocol emit/validate extensions: per-item deltas, `baselineAssessment`, `creditAssessments`. CLI-owned aggregates are derived, never reviewer-authored.
- Pure arithmetic module for ceilings, bands, alerts, baseline direction, and `Addresses` dedup.
- Decorated recorded reviewer steps and `5x run state` output.
- Existing-plan preflight and mid-review v1-compat / explicit opt-in.

**Out of scope:**

- Changing author/reviewer loop routing, `ready_with_corrections` normalization, or budget-specific human gates (`07-plan-review-governance.plan-input.md`).
- Implementation-review `scopeClass` enum, `--credit-realization`, `planImpact`, or quality-gated final corrections (`08-implementation-review-governance.plan-input.md`).
- Dashboard / browser visualization.
- Calibration of default percentages.
- Defining `RecordStore` (owned by slice 10). This slice’s store interface is budget-specific and append-only so it can later index record lines.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Pure arithmetic in `src/review-budget/`, not handlers** | Area 206 risk: “budget arithmetic is spread across handlers.” One module, integer `Math.ceil` / `Math.floor` / `Math.max` / `Math.min`, exhaustive fixtures including the documented `B = 4` example. |
| **Fail-closed plan parse; never silent `B0 = 0`** | Plan-input assumption. Missing/malformed tables **or incomplete debt-claim evidence** error with line-numbered diagnostics. Empty tables are not a zero baseline. Negative rows without `targetPhase` / comparison / before/after cannot establish a ledger claim. |
| **`ReviewBudgetStore` behind `src/control-plane/`, not `operations-v1.ts`** | Same boundary as `PromptStore` / `InvocationStore`. Handlers never import `bun:sqlite`. UUID PKs (`200` §3a #2). |
| **Append-only snapshots; `B0` INSERT-once** | Editing plan prose must not rewrite the baseline. `captureBaseline` is CAS on `run_id`. Governing `B` is initialized to `B0`; human `B` changes are slice 07. |
| **SQLite materialization now; RecordStore later** | Slice 10’s `RecordStore` is not frozen in-tree. Plan input 06 depends on slice 3 and must touch DB/store. Rows are immutable events so they can become a RecordStore index without a rewrite. |
| **Advisory never changes routing** | `budget.requiresHuman` is telemetry. Do not rewrite `readiness`, skip author cycles, or call `5x prompt`. `enforced` is accepted in config and recorded, then treated as advisory with a warning. |
| **v1 verdicts remain valid** | New item fields are optional at the protocol schema layer. They become required only when the run has an active baseline (`status = active`). Mid-review runs without a baseline stay `v1_compat`. |
| **Reject reviewer-authored aggregates** | If input contains `budget`, `budgetBand`, `B0`, `W`, `R`, `S`, `E`, `A`, `P`, `baselineDirection`, or similar CLI-owned keys, fail `INVALID_STRUCTURED_OUTPUT`. Do not strip-and-continue. |
| **`Addresses` + still-listed items define `R`** | Incorporated finding IDs drop out of `R` unless they still appear in the current verdict `items` (incomplete author claim). Explicit `addressed` / `still_open` enums are slice 07. |
| **No implementation-review fields** | Do not add `--credit-realization`, four-class `scopeClass`, `planImpact`, or `priority` requirements. Plan-review `scopeClass` is `acceptance_required` \| `risk_reduction` \| `polish` only. |
| **Snapshot + reviewer step are one SQLite transaction** | Appending a snapshot before `recordStepInternal` orphans telemetry when the step insert fails or a retry races. `apply` returns a pending snapshot; persist it in the same transaction as the unique `steps` insert on the same resolved Database. Failed or idempotent records insert no snapshot. |
| **Carry forward unchanged debt-claim assessments** | First-seen (or changed) claims require a current `--credit-assessment`. Unchanged includes evidence fields (`targetPhase`, minimal deltas, before/after), not only coupling and architectureDelta. Current assessments overlay by `creditClaimId` and must name a persisted claim. |
| **Snapshot order is insertion-stable** | `datetime('now')` is second-resolution. `latestSnapshot` / `listSnapshots` order by `(created_at, rowid)` (memory: insertion sequence), not `created_at` alone. |
| **Plan-side debt claims persist full §4.3 evidence** | A negative author row cannot earn `N`/`D` from `DCn` + coupling alone. The parser requires `targetPhase`, minimal-compliant effort/architecture deltas, and non-empty before/after on every negative claim; ledger JSON is what later implementation review reconciles. `--credit-assessment` names that persisted id; reviewer-item `creditClaim` is only for claims the reviewer introduces. |

### References

- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — §3.2 budget run-state; §3a store / UUID constraints; §4 advisory rollout.
- [`docs/v2/206-review-budget-governance.md`](../../v2/206-review-budget-governance.md) — canonical model, contracts, persistence, config, staged rollout.
- [`docs/v2/207-state-segmentation.md`](../../v2/207-state-segmentation.md) — §2.6 budget rows are record-tier; forecasts are derived.
- [`docs/v1/100-architecture.md`](../../v1/100-architecture.md) — CLI as toolbelt; protocol validate/record.
- [`docs/v1/101-cli-primitives.md`](../../v1/101-cli-primitives.md) — `run state`, `protocol emit` / `validate`.
- Plan input: [`docs/v2/plan-inputs/06-review-budget-advisory.plan-input.md`](../../v2/plan-inputs/06-review-budget-advisory.plan-input.md).
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
7. [Phase 4: Schema v8 and ReviewBudgetStore](#phase-4-schema-v8-and-reviewbudgetstore)
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
- Control-plane stores exist for prompts and invocations only (`src/control-plane/store.ts`, `invocation-store.ts`).
- Config has no `[reviewBudget]` table (`src/config.ts:166–237`, `src/templates/5x.default.toml`).

**New behavior:**

- New plans include `## Delivery Budget`, a `### Debt Claims` subsection for every negative architecture row, and `### Surface Snapshot`. Parser failures are explicit; incomplete debt evidence cannot become a baseline.
- Before the first plan-reviewer invocation (when mode is not `off` and the run is not mid-review v1-compat), the CLI parses the table, sums effort into `B0`, and CAS-inserts an immutable baseline.
- Reviewers may emit per-item deltas, first-review `baselineAssessment`, and per-claim `creditAssessments`. They must not emit totals or status.
- On `protocol validate reviewer --phase plan --record` and `invoke reviewer --record` for plan phase, the CLI recomputes `W`/`R`/ceilings/bands, **atomically** persists a snapshot with the unique reviewer step, and decorates `result_json` with a `budget` object. Unchanged debt-claim assessments carry forward.
- `5x run state` includes `review_budget` when a baseline exists.
- Workflow routing, `maxReviewIterations`, and `human_required` semantics are unchanged.

**Prerequisites:**

- [`205-prompt-queue-foundation-plan.md`](./205-prompt-queue-foundation-plan.md) — `src/control-plane/` store boundary, UUID ids, SQLite vs memory split. **Merged** (schema v6).
- [`207-invocation-registry-plan.md`](./207-invocation-registry-plan.md) — schema currently v7; this slice adds v8. **Merged**.
- Slice 10 `RecordStore` is **not** required. See Design Decisions.

---

## Design Decisions

**All derivation lives in one pure module.** `src/review-budget/arithmetic.ts` takes parsed ledgers, verdict items, credit assessments, governing `B`/`B0`, and `ReviewBudgetConfig`, and returns `DerivedBudgetResult`. Handlers must not re-implement `S`/`E`/`A`/`D` or baseline direction. Tests of handlers mock or call this module; they do not duplicate formula strings.

**Integer effort points; documented scales only.** Effort cells and `effortDelta` must be in `{1, 2, 3, 5, 8}` for plan rows and `effortDelta >= 0` integer for findings (0 allowed for findings that request no extra delivery work). Architecture cells and `architectureDelta` must be in `{0, ±1, ±2, ±3, ±5}`. Reject other integers with an actionable error naming the allowed set. Tests belong to the work item they validate and are not separate rows (`206` §3.1). A debt claim’s **minimal-compliant effort delta** may be `0` (the cheaper alternative adds no delivery work); if `> 0` it must be in `{1, 2, 3, 5, 8}`. Minimal-compliant architecture delta uses the architecture set.

**Missing Delivery Budget cannot become `B0 = 0`.** `parseDeliveryBudget` returns a `Result` (`ok` + value, or `ok: false` + `code` + `message` + `line`). Callers that would capture a baseline must not catch-and-default. `mode = "off"` skips parse entirely.

**`ReviewBudgetStore` is the persistence seam; SQLite is the v2 materialization.** Command logic receives the store from a factory that uses one `resolveDbContext` Database, matching `PromptCommandContext`. Do not add budget functions to `src/db/operations-v1.ts` for handlers to call. Unit tests inject `MemoryReviewBudgetStore`.

**Why not wait for `RecordStore`?** `207` §2.6 asks slice 06 to code against slice 10’s frozen interface. That interface is not in the tree, and plan input 06’s dependency is slice 3 with an explicit “must touch DB/store” constraint. Forking `RecordStore` here would steal slice 10’s opening phase (`10-git-native-run-records.plan-input.md` forbids 06 from defining that contract). Append-only UUID events are the compatible subset: when RecordStore lands, the SQLite impl becomes an index of the same payloads.

**Advisory `requiresHuman` is telemetry.** Compute it exactly as `206` §6.3 (`over_effective`, `over_absolute`, `baseline_disputed`, `positive_architecture_exceeded`, or any item `action === "human_required"`). Write it on the decorated record. Do **not** change `readiness`, skip re-review, or open a prompt. Slice 07 reads the same field and starts routing.

**`mode = "enforced"` is reserved.** Config accepts it. Capture and derivation run (same as advisory) so projects can pre-set the key. On first baseline capture and on `run state`, emit a warning: enforcement is not implemented; recording advisory telemetry only. Never apply `206` §5.4 readiness rewriting in this slice.

**Compatibility is keyed off baseline presence, not CLI version.**

| Run state | Meaning | Protocol extra fields | Capture |
|-----------|---------|----------------------|---------|
| `mode = "off"` | v1 | optional, ignored | never |
| No baseline, existing `reviewer:review` / `reviewer:plan` steps with `phase = plan` | `v1_compat` | optional | never, unless `--opt-in-budget-baseline` |
| No baseline, no prior plan-reviewer step, plan has valid table | capture then `active` | required on the first recorded plan-review verdict | yes, before first reviewer when possible |
| Baseline row exists | `active` | required for plan-review items | no (idempotent get) |

**First-review `baselineAssessment` is required only on the first `active` plan-review record** (the iteration that creates or immediately follows `B0`). Continued reviews must omit it; if present, fail `INVALID_STRUCTURED_OUTPUT` (“baselineAssessment is initial-review only”).

**`R` accounting.** Let `incorporated` = union of finding IDs in current `Addresses` cells (ignore `-` / empty). Let `pending` = current verdict items with `scopeClass !== "polish"` (missing `scopeClass` counts as required). `R` = sum of `effortDelta` (default 0 when v1-compat) for pending items whose `id` is **not** in `incorporated`, **plus** pending items that **are** in `incorporated` but still listed (author claimed Addresses while the reviewer still raised the id). Polish items never contribute to `R`. This implements `206` §6.1 without slice 07’s resolution enum.

**Provisional `D` only from eligible intrinsic claims with persisted evidence.** Author plan claims contribute to `N`/`D` only when (1) the current-ledger row has complete `DebtClaimEvidence` (`targetPhase`, minimal-compliant effort/architecture deltas, non-empty `before`/`after`) and (2) the **effective** assessment set (current overlay ∪ persisted unchanged claims) has `eligibility: "eligible"` and `coupling: "intrinsic"` for that `debtClaimId`. A `--credit-assessment` whose `creditClaimId` does not match a current-ledger author claim or a current-verdict reviewer `creditClaim` fails `CREDIT_ASSESSMENT_UNKNOWN_CLAIM`. Reviewer-item `creditClaim` is provisionally eligible by construction if `coupling === "intrinsic"` and the same comparison fields are present and non-empty; it cannot backfill evidence for an author `DCn` already on the ledger. `ineligible` / `adjacent` / `unrelated` add 0 to `N`. Incomplete author evidence is a parse/apply failure, not a zero-credit default. Do not realize credit; do not persist implementation-review realizations.

**CLI-owned keys are rejected, not merged.** Reviewer JSON that includes a `budget` object or top-level `budgetBand` / `B0` / `W` / `projectedEffort` / `baselineDirection` / `requiresHuman` (boolean at verdict top-level — item `action: human_required` is fine) fails closed. Prevents an agent from impersonating CLI arithmetic.

**Baseline capture hooks at template render *and* record.** `206` §3.3: capture before the first reviewer invocation. Primary hook: `template render` / `invoke` template resolution when the selected template base name is `reviewer-plan` (not `-continued`), mode ≠ `off`, run is not `v1_compat`. Safety net: `applyPlanReviewBudget` at validate/invoke record time captures if still missing and the run is eligible. Capture is CAS; a race cannot double-write `B0`.

**Opt-in is explicit.** `--opt-in-budget-baseline` on `protocol validate reviewer` (and the same flag on `invoke reviewer` if flags are plumbed; otherwise document that opt-in goes through `protocol validate --record`). It is valid only when a baseline is absent and prior plan-reviewer steps exist. It captures `B0` from the **current** plan (human-approved, possibly already expanded) and sets `captureKind: "opt_in"`. Skills must not pass this flag without a human `human:gate` / prompt confirmation. This slice does not add a new prompt kind.

**Snapshot persistence is atomic with the decorated reviewer step.** `protocolValidate` and `invokeAgent` emit the success envelope and call `recordStepInternal` afterward (`src/commands/protocol.handler.ts:479–515`, `src/commands/invoke.handler.ts:642–684`). If `apply` appended a snapshot first, a failed record (terminal run, step limit, DB error, or retry race) would leave telemetry without a journal row, and a retry could append a second snapshot for the same verdict. Therefore:

- `applyPlanReviewBudget` **computes** (and may CAS-capture a baseline) but **does not** `appendSnapshot`.
- Handlers resolve **one** `resolveDbContext` Database, construct `ReviewBudgetStore` from it, and pass that same `{ db, config, controlPlane }` into `recordStepInternal`.
- Snapshot insert and the unique `steps` insert run in **one** `db.transaction(...)`. If the step insert throws or is a duplicate (`recorded: false`), the transaction inserts no new snapshot. If `appendSnapshot` throws, the step insert rolls back.
- Envelope-before-record stays the v1 contract (record failure is stderr + exit 1). The invariant is journal ↔ snapshot, not envelope ↔ journal.
- Exactly one snapshot exists per successfully recorded unique reviewer step. Idempotent re-records do not add another.

**Effective assessments = current overlay ∪ persisted unchanged claims.** `deriveBudget` must not receive only the current verdict’s `creditAssessments`. A continued review that correctly omits an already-assessed unchanged claim would otherwise drop `N`/`D`/`E` to zero. Apply builds an **effective** assessment set:

1. Load persisted assessments from `latestSnapshot.assessments` (empty on the first snapshot).
2. Overlay any current-verdict assessments by `creditClaimId` (explicit re-assessment wins).
3. For each author `debtClaimId` on the **current** ledger: if it is new or **changed** relative to the previous snapshot’s ledger, a current assessment is required (`CREDIT_ASSESSMENT_REQUIRED` listing missing ids). Unchanged claims reuse the persisted assessment and do not require re-emit.
4. A claim is **unchanged** when the same `debtClaimId` is still on the current ledger with the same `coupling`, work-item `architectureDelta`, `targetPhase`, `minimalAlternativeEffortDelta`, `minimalAlternativeArchitectureDelta`, `before`, and `after` as in the previous snapshot’s `currentLedger`. Any evidence or score change is **changed**. Removed claims drop out of `N`. Reviewer-item `creditClaim` stays provisionally eligible by construction (no duplicate `--credit-assessment`); its id must not collide with an author `debtClaimId` (`CREDIT_CLAIM_ID_COLLISION`).
5. Every current `--credit-assessment` `creditClaimId` must equal a current-ledger author `debtClaim.debtClaimId` or a current-item `creditClaim.creditClaimId`. Unknown ids fail `CREDIT_ASSESSMENT_UNKNOWN_CLAIM`.
6. Persist the **effective** (merged) set on the new snapshot so the next review can merge again. Call `deriveBudget` with that effective set, not the raw verdict array. `eligibleN` reads architecture reduction from the **persisted ledger claim** (and reviewer-item `creditClaim`), never from assessment-only metadata.

Do **not** instruct continued-review skills to re-emit every assessment. That would conflict with the first-seen / changed-only validation rule.

**Snapshot listing is deterministic at equal timestamps.** Schema `created_at` uses SQLite `datetime('now')` (second resolution). `listSnapshots` orders `ORDER BY created_at ASC, rowid ASC`. `latestSnapshot` uses `ORDER BY created_at DESC, rowid DESC LIMIT 1`. The memory store keeps a monotonic insertion sequence and uses it as the `rowid` tie-breaker. Contract tests insert two snapshots with the same `created_at` and assert insertion order.

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
           └─ --record: appendSnapshot + steps insert in one transaction
              (no snapshot if the step insert fails or is a duplicate)
           │
           ▼
  steps.result_json + ReviewBudgetStore
  5x run state → data.review_budget

  mode=off or v1_compat: skip capture/derive/decorate; v1 path unchanged
```

State per run:

```
  (no row) ──mode=off──────────────────────────────────────► never captured

  (no row) ──prior plan-reviewer steps─────────────────────► v1_compat
                 │
                 └── --opt-in-budget-baseline + valid table ─► active (opt_in)

  (no row) ──no prior reviewer, valid table── captureBaseline ─► active
                 │
                 └── missing/malformed table ──► BUDGET_SECTION_MISSING
                                                 (preflight; no B0)
```

`B0` row is immutable. Snapshots append, each 1:1 with a successfully recorded unique reviewer step. Derived numbers on a snapshot are a point-in-time record; `run state` prefers the latest snapshot (insertion-order tie-break at equal `created_at`) and may recompute from current plan + latest verdict for display (recompute must match the pure module; if they disagree, that is a bug).

---

## Phase 1: Domain types and pure arithmetic

**Completion gate:** `bun test test/unit/review-budget/` passes. The `B = 4` worked example from `206` §3.2 is a fixture: `S = 6`, `D <= 1`, `A = 8`, `E` may reach `7`. No handler or SQLite imports in this module.

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

- [ ] Create `src/review-budget/types.ts` with the types above.
- [ ] Export `isEffortPoints` / `isArchitectureDelta` / `isCompleteDebtClaimEvidence` type guards used by the parser and protocol layer. `isCompleteDebtClaimEvidence` is true only when `debtClaimId`, `coupling`, non-empty `targetPhase`, valid minimal deltas, and non-empty `before`/`after` are all present.

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

## Phase 4: Schema v8 and ReviewBudgetStore

**Completion gate:** Fresh DB migrates to v8. v7 → v8 keeps `invocations`. `captureBaseline` is INSERT-once (second call returns existing, does not change `b0`). Memory and SQLite pass the same contract tests. Handlers are not wired yet.

### 4.1 IDs — `src/control-plane/ids.ts`

Add `createReviewBudgetId(): string` (`randomUUID`), same file as `createPromptId` (`:8–16`).

### 4.2 Migration v8 — `src/db/schema.ts`

Append after v7 (`:450–505`). Bump tests that hardcode `getMaxKnownSchemaVersion() === 7` (`test/unit/db/schema.test.ts:28–40`, `:166`; `schema-v6.test.ts`; `schema-v7.test.ts:71`).

```sql
CREATE TABLE review_budget_baselines (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  capture_kind TEXT NOT NULL CHECK (capture_kind IN ('initial', 'opt_in')),
  b0 INTEGER NOT NULL CHECK (b0 > 0),
  b INTEGER NOT NULL CHECK (b > 0),
  original_ledger_json TEXT NOT NULL, -- ParsedDeliveryBudget JSON including debtClaim evidence
  surface_snapshot_json TEXT NOT NULL,
  original_section TEXT,
  config_snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (b0 > 0)
);

CREATE TABLE review_budget_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase TEXT,
  iteration INTEGER,
  current_ledger_json TEXT NOT NULL, -- ParsedDeliveryBudget JSON including debtClaim evidence
  findings_json TEXT NOT NULL,
  assessments_json TEXT NOT NULL, -- effective merged set (current overlay ∪ persisted unchanged)
  derived_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_review_budget_snapshots_run
  ON review_budget_snapshots(run_id, created_at);
```

`created_at` is SQLite `datetime('now')` (second resolution). Do **not** order snapshots by `created_at` alone. `listSnapshots` uses `ORDER BY created_at ASC, rowid ASC`. `latestSnapshot` uses `ORDER BY created_at DESC, rowid DESC LIMIT 1`. The implicit `rowid` is the insertion-order tie-breaker (UUID `id` is the PK, so `rowid` remains available). The memory store assigns a monotonic `seq` per insert and sorts `(createdAt, seq)` the same way.

No `UPDATE` of `review_budget_baselines.b0`. This slice never `UPDATE`s the baselines row. Slice 07 may add a decisions table for governing `B`; until then `b` stays equal to `b0`.

`b0 > 0` enforces the empty-table ban at the DB layer.

### 4.3 Store contract — `src/control-plane/review-budget-store.ts` (new)

```typescript
export type CaptureKind = "initial" | "opt_in";

export interface ReviewBudgetBaseline {
	id: string;
	runId: string;
	captureKind: CaptureKind;
	b0: number;
	b: number;
	originalLedger: ParsedDeliveryBudget; // full work items including debtClaim evidence
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
	currentLedger: ParsedDeliveryBudget; // full work items including debtClaim evidence
	findings: FindingDelta[];
	assessments: CreditAssessmentInput[]; // effective merged set persisted for the next apply
	derived: DerivedBudgetResult;
	createdAt: string;
}

export interface CaptureBaselineInput {
	runId: string;
	captureKind: CaptureKind;
	parsed: ParsedDeliveryBudget;
	originalSection?: string;
	configSnapshot: Omit<ReviewBudgetConfig, "mode">;
}

export type CaptureBaselineResult =
	| { ok: true; created: true; baseline: ReviewBudgetBaseline }
	| { ok: true; created: false; baseline: ReviewBudgetBaseline };

export interface ReviewBudgetStore {
	getBaseline(runId: string): ReviewBudgetBaseline | null;
	/** CAS insert. Duplicate run_id returns created: false with the stored row. */
	captureBaseline(input: CaptureBaselineInput): CaptureBaselineResult;
	appendSnapshot(input: {
		runId: string;
		phase?: string;
		iteration?: number;
		currentLedger: ParsedDeliveryBudget;
		findings: FindingDelta[];
		assessments: CreditAssessmentInput[]; // effective merged set
		derived: DerivedBudgetResult;
	}): ReviewBudgetSnapshotRecord;
	latestSnapshot(runId: string): ReviewBudgetSnapshotRecord | null;
	listSnapshots(runId: string): ReviewBudgetSnapshotRecord[];
}
```

`latestSnapshot` / `listSnapshots` **must** use the insertion-order tie-breaker above. Do not `ORDER BY created_at` without `rowid` (SQLite) or insertion `seq` (memory).

SQL only in `src/control-plane/review-budget-sqlite.ts`. Memory in `src/control-plane/review-budget-memory.ts`. Re-export from `src/control-plane/index.ts`.

`captureBaseline` computes `b0 = sumEffort(parsed.workItems)` and rejects `b0 <= 0` before insert (defense in depth).

- [ ] Migration v8 + `test/unit/db/schema-v8.test.ts` (fresh, v7→v8, unique `run_id`, `b0 > 0` CHECK, FK to `runs`).
- [ ] Update version assertions from 7 → 8.
- [ ] SQLite + memory implementations.
- [ ] `test/unit/control-plane/review-budget-store-contract.test.ts` run against both impls: capture once; second capture is no-op on `b0`; append snapshots ordered; **same-`created_at` pair returns in insertion order** (`latestSnapshot` is the second insert); missing run FK fails on SQLite; **round-trip**: captured `originalLedger.workItems[].debtClaim` retains `targetPhase`, minimal deltas, and non-empty `before`/`after`; appended `currentLedger` does the same.
- [ ] Do not import `bun:sqlite` from the interface file or from command handlers (handlers land in Phase 6–8).

---

## Phase 5: Protocol types, emit, and normalize

**Completion gate:** v1 emit/validate fixtures still pass. New flags round-trip. Aggregate keys on emit stdin/flags are rejected. Implementation-review fields are **not** added.

### 5.1 Types and JSON schema — `src/protocol.ts`

Extend `VerdictItem` (`:16–22`) and `ReviewerVerdict` (`:24–28`):

```typescript
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

export interface BaselineAssessment {
	independentEffortEstimate: number;
	confidence: "low" | "medium" | "high";
	reason: string;
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
- [ ] `test/unit/commands/protocol-emit.test.ts`: item extras round-trip including full `creditClaim`; `--baseline-assessment`; repeated `--credit-assessment`; reject `--item` containing `budgetBand`.
- [ ] `test/unit/commands/protocol-helpers.test.ts`: v1 reviewer payload still `ok`.
- [ ] Do not add `--credit-realization` or implementation `scopeClass` enums.

---

## Phase 6: Validate, derive, persist, decorate

**Completion gate:** Recording a plan-review verdict on an `active` run writes **exactly one** snapshot **in the same transaction** as the unique `steps` insert, and a `budget` object on `result_json` / validate envelope. A failed or duplicate record writes no snapshot. Recording the same v1 verdict on a `v1_compat` or `mode=off` run is byte-compatible aside from existing fields. Readiness is never rewritten. Direct `--record` capture in `mode=enforced` emits the reserved-mode warning.

### 6.1 Shared apply function — `src/review-budget/apply.ts` (new)

This is the only place handlers call for budget **computation** and baseline safety-net capture. It does **not** persist a snapshot (see 6.2).

```typescript
export interface PendingBudgetSnapshot {
	runId: string;
	phase: string | undefined;
	iteration: number | undefined;
	currentLedger: ParsedDeliveryBudget;
	findings: FindingDelta[];
	assessments: CreditAssessmentInput[]; // effective merged set
	derived: DerivedBudgetResult;
}

export interface ApplyPlanReviewBudgetInput {
	runId: string;
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
5. If no baseline and (no prior steps or opt-in): call `ensurePlanReviewBaseline` (Phase 7) with the same `warn` callback — **do not** capture inline. That helper parses, CAS-inserts, and emits the reserved-mode warning on every first capture including this safety-net path. On ensure error, return the parse/capture code. Do not invent `B0 = 0`.
6. If baseline exists: parse **current** plan (fail closed — do not keep a stale `W` from a broken table). Parser already required complete `debtClaim` evidence on every negative row; if a stored/injected ledger nevertheless has `architectureDelta < 0` without `isCompleteDebtClaimEvidence(item.debtClaim)`, fail `BUDGET_DEBT_CLAIM_EVIDENCE_REQUIRED` (do not derive provisional `N` from id+coupling alone).
7. If this is the first snapshot for the run (`latestSnapshot == null`): require `verdict.baselineAssessment`; map `I`. If later snapshots: if `baselineAssessment` present → error `BASELINE_ASSESSMENT_UNEXPECTED`.
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
12. **Do not** `appendSnapshot` here.
13. Return `{ status: "applied", verdict: decorated, pendingSnapshot }`. Do not mutate `readiness` or `items`.

`hasPriorPlanReviewerStep`: injected boolean. Callers compute it from `getStepsByPhase(db, runId, "plan")` filtering `step_name` starting with `reviewer:` (`src/db/operations-v1.ts:250–254`). Do not pass `Database` into `apply.ts`.

### 6.2 Atomic snapshot + step persist

`recordStepInternal` already accepts an optional `dbContext` (`src/commands/run-v1.handler.ts:1193–1201`). Budget-recording handlers **must not** let it re-resolve a second Database.

**Context factory** (same seam as `PromptCommandContext` / `src/commands/prompt-context.ts`): `src/commands/review-budget-context.ts` runs **one** `resolveDbContext`, constructs `ReviewBudgetStore` from that Database, and returns `{ db, config, controlPlane, store }`. Protocol/invoke handlers call the factory (or accept an injected one in tests). They do **not** import `bun:sqlite`.

Extend `recordStepInternal` with optional `onUniqueInsert?: () => void`. After pre-checks, wrap `recordStep` + the hook in `db.transaction(() => { ... })()` on the **same** Database:

- Unique insert (`recorded: true`): run `onUniqueInsert` inside the transaction (production: `store.appendSnapshot(pendingSnapshot)`). The SQLite store **must** use this same `Database` instance — do not open a second connection inside `appendSnapshot`.
- Duplicate (`recorded: false`): skip the hook.
- If `recordStep` or `onUniqueInsert` throws, the transaction aborts — neither row remains.

Optional thin wrapper `recordPlanReviewerStepWithSnapshot` beside the context factory is sugar that passes that hook. Prefer the hook on `recordStepInternal` so `src/review-budget/` stays free of `bun:sqlite`.

Failed record leaves no snapshot. A retry of a failed unique insert may snapshot once, when the step actually lands. A retry of a successful unique insert snapshots zero additional times. Exactly one snapshot exists per successfully recorded unique reviewer step.

### 6.3 Protocol validate — `src/commands/protocol.handler.ts`

After `protocolValidateCore` and before `outputSuccess` (`:378–483`):

- When `role === "reviewer"` and resolved phase is `plan` (string `plan`, not numeric phase refs — `isNumericPhaseRef` is false for `"plan"`, `:131–140`): resolve **one** review-budget context (factory above), load plan markdown from `resolveRunExecutionContext` effective plan path, compute `hasPriorPlanReviewerStep`, read `optInBaseline` from new param, `loadConfig` `reviewBudget`, pass `warn` (stderr / injected sink — do not monkey-patch `console.warn`), call `applyPlanReviewBudget`.
- On `status === "error"`, `outputError(code, message)` **before** `outputSuccess` (same fail-closed rule as `--record` prerequisites, `:426–432`).
- On `applied`, replace `validated` with the decorated verdict so the envelope includes `budget`.
- On `skipped`, leave `validated` unchanged.

`--record` persist path (`:492–515`): when `applied` and `pendingSnapshot` is set, call `recordStepInternal` with the context factory’s `dbContext` and `onUniqueInsert: () => store.appendSnapshot(pendingSnapshot)`. Keep the existing stderr-on-record-failure contract (no second stdout envelope). When not `applied`, keep today’s `recordStepInternal` call (no hook).

New params on `ProtocolValidateParams` (`:37–50`): `optInBudgetBaseline?: boolean`. Wire `--opt-in-budget-baseline` on `validate reviewer` only (`protocol.ts:102–137`).

`--record` is not required to compute (validate-only can still decorate the envelope) but snapshots append **only** with `--record`, inside the step transaction. Validate-without-record still **computes and returns** `budget` in the envelope when a baseline exists. Capture-on-validate-without-record would create baselines during dry runs — **do not**. If no baseline and no `--record`, skip capture; if extra fields are missing, do not fail v1 dry-validate unless `--record` or an existing baseline makes the run `active`.

Tighten:

- Dry validate (no `--record`, no baseline): v1 rules only (optional new fields).
- `--record` or existing baseline: full apply (may capture via ensure, may require fields). Snapshot write still only with `--record`.

Direct `protocol validate --record` with no prior template render is a first-capture path: `ensurePlanReviewBaseline` must emit the enforced-mode warning here too.

### 6.4 Invoke record path — `src/commands/invoke.handler.ts`

After successful `validateStructuredOutput` (`:552–615`) and before `outputSuccess` (`:642`): if `role === "reviewer"` and phase is `plan`, same apply (decorate output). Honor `params.record`: if invoke without `--record`, decorate stdout only if baseline already exists; do not capture. If `--record`, full apply, then `recordStepInternal` with the same context-factory `dbContext` and `onUniqueInsert` snapshot hook in the existing post-envelope record block (`:648–684`).

Plumb `optInBudgetBaseline` onto invoke reviewer flags if the commander module already has a parallel option surface; if that is noisy, document opt-in via `protocol validate --record --opt-in-budget-baseline` only and skip the invoke flag. Prefer **one** opt-in flag on both commands for skill simplicity.

`ReviewerVerdictSchema` extra optional properties (Phase 5) allow providers to emit new fields.

### 6.5 Tests

- [ ] `test/unit/review-budget/apply.test.ts`: skip off; skip v1_compat; capture+derive (no snapshot written by apply); Addresses vs still-listed `R`; reject aggregates; require `I` on first record; reject `I` on second; missing item deltas on active run; `readiness` unchanged when `requiresHuman` true; `enforced` still does not rewrite readiness; **enforced first-capture calls `warn`** (injected sink); **eligible claim carried forward** on a second apply with no current assessment for that `DCn` (`N`/`D`/`E` unchanged) **when evidence fields are unchanged**; **new claim on a later ledger requires** `--credit-assessment`; overlay re-assessment of an existing claim wins; **`--credit-assessment` for an unknown `DCn` fails `CREDIT_ASSESSMENT_UNKNOWN_CLAIM`**; **changed `before`/`targetPhase` on an existing `DCn` requires a current assessment**; **author `N` uses persisted `debtClaim` architecture, not a reviewer `creditClaim` on a different id**; **reviewer `creditClaim` colliding with author `DC0` fails `CREDIT_CLAIM_ID_COLLISION`**; injected ledger with negative row and only id+coupling (no evidence) fails `BUDGET_DEBT_CLAIM_EVIDENCE_REQUIRED`.
- [ ] `test/unit/review-budget/persist-record.test.ts` (or store + handler): step-insert failure (terminal run / `MAX_STEPS_EXCEEDED` / thrown `RecordError`) leaves **zero** snapshots; unique success leaves **exactly one**; idempotent retry (`recorded: false`) leaves still **one**; injected `appendSnapshot` throw rolls back the step row (SQLite).
- [ ] `test/unit/commands/protocol-validate.test.ts`: envelope includes `result.budget` when recorded with a fixture plan; v1 verdict without budget fields still validates without `--record`; **direct `--record` with `mode=enforced` and no prior render emits the reserved-mode warning**; failed record does not leave a snapshot.
- [ ] Do not assert any prompt/choose routing.

---

## Phase 7: Baseline capture, preflight, mid-review opt-in

**Completion gate:** Rendering `reviewer-plan` (not continued) on a new run with a valid table captures `B0` before the reviewer runs. Missing table returns `BUDGET_SECTION_MISSING` with a preflight message. A run that already has a plan-reviewer step and no baseline does not capture. `--opt-in-budget-baseline` captures `capture_kind = opt_in` from the current table.

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
}): 
	| { status: "skipped"; reason: "off" | "v1_compat" | "already" }
	| { status: "captured"; baseline: ReviewBudgetBaseline }
	| { status: "error"; code: string; message: string };
```

If `mode === "enforced"` **and this call creates a baseline** (`status: "captured"`), `warn("reviewBudget.mode is enforced but enforcement is not implemented; recording advisory telemetry only")`. Emit once per successful first capture, not on `already` / skip. Apply’s safety-net (direct `protocol validate --record` / invoke `--record` with no prior render) **must** call this helper so the warning is not render-hook-only.

Error message for missing section must tell the orchestrator to run an author preflight that adds `## Delivery Budget` **before** the first reviewer, and must not mention inventing `B0 = 0`.

### 7.2 Template render hook — `src/commands/template.handler.ts`

After run context is resolved and the template is selected (`template.handler.ts:75+`, using `resolveAndRenderTemplate` in `template-vars.ts`): if `loadTemplate` selected name base is `reviewer-plan` **without** `-continued`, and a `run_id` is present, load plan markdown from the effective plan path, open `ReviewBudgetStore`, call `ensurePlanReviewBaseline` with `optIn: false`. On error, `outputError` (fail closed) so the reviewer is not invoked against an unbudgeted new run.

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

**Completion gate:** `5x run state` JSON includes `review_budget` when a baseline exists; omitted when not. Text mode prints a short forecast block. Step `result_json` already contains `budget` from Phase 6; do not duplicate per-step in the header.

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

Prefer latest snapshot’s `derived` over live recompute for the header so `run state` matches the last recorded review. If the plan file changed since the last snapshot, still show snapshot numbers and add `stale_plan: true` when `sumEffort(currentParse) !== snapshot.W` so operators see drift without silently mixing sources.

### 8.2 Text — `formatStateText` (`:635–675`)

After the `Steps: used / max` line, if `review_budget` is present:

```text
Budget:  W+R=12  E=10  band=over_effective  alerts=baseline_disputed  (advisory)
```

Keep it one or two lines. Do not dump the ledger.

### 8.3 Tests

- [ ] `test/unit/commands/run-state` (or existing run-v1 handler tests): fixture DB with baseline + snapshot; omit object when mode off; `v1_compat` shape; text formatter includes `Budget:`.

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

Export parse function/types (`ParsedWorkItem`, `DebtClaimEvidence`), `ReviewBudgetStore` types, `createMemoryReviewBudgetStore`, `createSqliteReviewBudgetStore`, `createReviewBudgetId`, arithmetic `deriveBudget` if useful for plugins. Do not export SQL helpers.

### 10.2 Compatibility matrix

| Case | Expected |
|------|----------|
| v1 `protocol emit reviewer --ready` | unchanged JSON |
| v1 `protocol validate reviewer` without run | unchanged |
| `mode=off`, new plan, full plan-review loop | no baseline row; no `budget` on steps |
| `advisory`, new plan with table | `B0` captured at `reviewer-plan` render; first record has `I` + `budget` |
| `advisory`, new plan without table | `BUDGET_SECTION_MISSING` at render; no baseline |
| `advisory`, negative row without Debt Claims evidence | parse/capture fails (`BUDGET_DEBT_CLAIM_EVIDENCE_MISSING`); no baseline |
| Mid-review run (reviewer steps exist, no baseline) | v1_compat; v1 verdict records; no capture |
| Opt-in flag + table on mid-review run | `capture_kind=opt_in`; subsequent records decorate |
| Reviewer JSON with `"budgetBand":"within_standard"` | `INVALID_STRUCTURED_OUTPUT` |
| Malformed table after baseline exists | record fails; `B0` row untouched |
| `enforced` mode | warning on **every** first capture (render **and** direct `--record`); same as advisory routing |
| Implementation-review `protocol validate reviewer --phase phase-1` | no plan-budget apply; v1 item contract |

### 10.3 Integration tests — `test/integration/commands/`

New `review-budget.test.ts` (spawn CLI, `cleanGitEnv()`, `stdin: "ignore"`, `timeout: 15000`+):

- Temp repo + `5x init` + plan with budget table + `run init` + `template render reviewer-plan` creates baseline (query via `run state` JSON).
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
| `src/review-budget/types.ts` | **New.** Domain types, defaults, guards (`DebtClaimEvidence`, `isCompleteDebtClaimEvidence`). |
| `src/review-budget/arithmetic.ts` | **New.** Pure derivation; `eligibleN` requires complete persisted evidence. |
| `src/review-budget/apply.ts` | **New.** Validate/compute orchestration; bind assessments to persisted claims; returns `pendingSnapshot`; no snapshot write. |
| `src/review-budget/ensure-baseline.ts` | **New.** Capture / skip / preflight; enforced-mode warning on every first capture. |
| `src/commands/review-budget-context.ts` | **New.** One `resolveDbContext` + store factory for protocol/invoke (handlers do not import `bun:sqlite`). |
| `src/parsers/delivery-budget.ts` | **New.** Fail-closed markdown parser including `### Debt Claims` evidence. |
| `src/parsers/plan.ts` | No logic change; add regression tests only. |
| `src/config.ts` | `ReviewBudgetConfigSchema`; `KNOWN_ROOT_CONFIG_KEYS`. |
| `src/templates/5x.default.toml` | `[reviewBudget]` table. |
| `src/db/schema.ts` | Migration v8; max version 8; snapshot index `(run_id, created_at)` plus `rowid` order. |
| `src/control-plane/ids.ts` | `createReviewBudgetId`. |
| `src/control-plane/review-budget-store.ts` | **New.** Store interface. |
| `src/control-plane/review-budget-sqlite.ts` | **New.** SQLite impl; `listSnapshots`/`latestSnapshot` order by `(created_at, rowid)`. |
| `src/control-plane/review-budget-memory.ts` | **New.** Memory impl; insertion-seq tie-breaker. |
| `src/control-plane/index.ts` | Re-exports. |
| `src/protocol.ts` | Item/verdict extensions; schema; CLI-owned key reject helper; `CreditClaim` evidence fields remain reviewer-introduced only. |
| `src/protocol-normalize.ts` | Pass through new fields. |
| `src/commands/protocol.ts` | Emit/validate flags. |
| `src/commands/protocol-emit.handler.ts` | Parse assessment flags and item extras. |
| `src/commands/protocol.handler.ts` | Apply budget on plan-review validate; atomic snapshot+step persist on `--record`; pass `warn` into apply/ensure. |
| `src/commands/protocol-helpers.ts` | Only if reject helper is called from shared validate. |
| `src/commands/invoke.ts` / `invoke.handler.ts` | Ensure baseline; apply on plan-review; atomic snapshot+step persist on `--record`; optional opt-in flag. |
| `src/commands/template.handler.ts` | Ensure baseline on initial `reviewer-plan` render. |
| `src/commands/run-v1.handler.ts` | `review_budget` on state JSON/text; optional `onUniqueInsert` inside the `recordStep` transaction. |
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
| `test/unit/review-budget/*.test.ts` | **New** (apply, arithmetic, persist-record, ensure-baseline). |
| `test/unit/parsers/delivery-budget.test.ts` | **New.** |
| `test/unit/parsers/plan.test.ts` | Placement regressions. |
| `test/unit/control-plane/review-budget-store-contract.test.ts` | **New.** |
| `test/unit/config.test.ts`, `config-v1.test.ts`, `config-registry.test.ts` | Defaults and layering. |
| `test/unit/protocol.test.ts`, `protocol-emit.test.ts`, `protocol-validate.test.ts`, `protocol-helpers.test.ts` | New fields; v1 compat. |
| `test/unit/harnesses/opencode-skills.test.ts`, `cursor-skills.test.ts` | Skill string updates. |
| `test/integration/commands/review-budget.test.ts` | **New.** CLI round trips. |

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `review-budget/arithmetic.test.ts` | `B=4` ceilings; bands; both disagreement directions; `P` not netted; `R` dedup + re-entry; polish excluded; `D` caps; `requiresHuman` flags; incomplete debt evidence excluded from `N` |
| Unit | `parsers/delivery-budget.test.ts` | Canonical table (W2 effort `5` + complete `#### DC0` evidence); every `DeliveryBudgetParseCode`; empty ≠ zero; effort `4` rejected; negative row without evidence rejected |
| Unit | `parsers/plan.test.ts` | Budget section does not break phase/checklist parse |
| Unit | `config*.test.ts` | Defaults, overlay `off`, reject bad mode/percent, registry keys |
| Unit | `schema-v8.test.ts` | v8 tables, v7→v8, CHECKs, unique `run_id` |
| Unit | `review-budget-store-contract.test.ts` | Capture CAS on SQLite **and** memory; append order; **same-timestamp insertion-order tie-break**; **ledger round-trip of `debtClaim` evidence** |
| Unit | `protocol-emit.test.ts` | Flags round-trip; reject CLI-owned keys |
| Unit | `protocol-validate.test.ts` / `apply.test.ts` | Decorate on record; skip off/compat; fail malformed current table without mutating `B0`; apply does not write snapshots; assessments bind to persisted claims; incomplete author evidence fails closed |
| Unit | `persist-record.test.ts` | Failed/idempotent step record leaves no extra snapshot; unique success is 1:1; SQLite rollback if snapshot insert throws |
| Unit | `ensure-baseline` + template/invoke unit if injectable | Capture before invoke; missing section; **enforced warn on every first-capture path including direct `--record`** |
| Unit | run-state handler | `review_budget` shapes; text line |
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
- Step record failure after apply: zero snapshots.
- Duplicate step re-record: still exactly one snapshot.
- Two snapshots in the same `created_at` second: `latestSnapshot` is the later insert.
- Direct `protocol validate --record` with `mode=enforced` and no prior render: reserved-mode warning emitted.

---

## Not In Scope

- **Routing / human budget gates / `ready_with_corrections` rewriting** — `07-plan-review-governance.plan-input.md`. Advisory records `requiresHuman` only.
- **Deferred findings, accepted-risk ledger, continued-review hunk validation, `lateDiscovery`** — slice 07.
- **Implementation-review four-class `scopeClass`, `planImpact`, `--credit-realization`, quality-gated shortcut** — `08-implementation-review-governance.plan-input.md`.
- **Dashboard / browser budget UI** — `04-control-plane-dashboard.plan-input.md`.
- **`RecordStore` / git-native JSONL records** — slice 10. Do not invent that interface here.
- **Changing default percentages after calibration** — open question in `206` §10.
- **Rewriting `maxReviewIterations` or step-count `maxStepsPerRun`** — unchanged backstops.
- **Auto-overwriting existing project `implementation-plan-template.md` on upgrade.**
- **Emitting `credit_unrealized` or reconciling provisional `D` after implementation.**

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Types + pure arithmetic + `B=4` fixtures | 1 day |
| 2 | Delivery Budget parser + plan-parse regressions | 1–2 days |
| 3 | `reviewBudget` config, registry, default TOML | 0.5–1 day |
| 4 | Schema v8 + ReviewBudgetStore (SQLite + memory) | 1–2 days |
| 5 | Protocol types, emit flags, normalize, reject aggregates | 1 day |
| 6 | apply() + validate/invoke decorate/record | 2 days |
| 7 | ensureBaseline, template/invoke hooks, opt-in | 1–2 days |
| 8 | `run state` JSON/text | 0.5–1 day |
| 9 | Templates, skills, 101 docs | 1–2 days |
| 10 | Integration matrix, exports, `bun test` | 1–2 days |
| **Total** | | **10.5–16 days** |

Phase 1 is a hard prerequisite to 2 and 6. Phase 4 is a hard prerequisite to 6–8. Phase 5 can overlap 4. Phase 9 can overlap 6–8 once flag names are frozen in Phase 5. If slice 10’s `RecordStore` appears mid-implementation, do **not** retarget persistence in this slice; keep `ReviewBudgetStore` and file a follow-up to dual-write.

---

## Revision History

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

v2 area 6 (`docs/v2/206-review-budget-governance.md`) addresses unbounded plan-review growth described in `docs/v2/200-overview.md` §1.4. This plan implements the **advisory** rollout step (`206` §8.2.1) from `docs/v2/plan-inputs/06-review-budget-advisory.plan-input.md`. Persistence follows the slice-3 control-plane store boundary (`205-prompt-queue-foundation-plan.md`). Enforcement, convergence routing, and human tradeoff gates are explicitly left to `07-plan-review-governance.plan-input.md`. Implementation-review budget inheritance is left to `08-implementation-review-governance.plan-input.md`.
