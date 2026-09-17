# Review: Review Budget Advisory — Phase 5 (Protocol types, emit, normalize)

**Review type:** `334bdf2` + `eec0760` (format follow-up)  
**Scope:** `src/protocol.ts`, `src/commands/protocol-emit.handler.ts`, `src/commands/protocol-helpers.ts`, `src/commands/protocol.ts`, and unit tests for protocol / normalize / emit / helpers  
**Reviewer:** Staff engineer (correctness, protocol compatibility, operability)  
**Local verification:** `bun test test/unit/protocol.test.ts test/unit/protocol-normalize.test.ts test/unit/commands/protocol-emit.test.ts test/unit/commands/protocol-helpers.test.ts` — 84 pass / 0 fail; `tsc --noEmit` clean; manual `5x protocol emit reviewer` edge-case probing (results below)

**Implementation plan:** `docs/development/plans/208-review-budget-advisory-plan.md` (Phase 5)  
**Technical design:** `docs/v2/206-review-budget-governance.md`

## Summary

Phase 5 extends `VerdictItem` / `ReviewerVerdict` and the JSON schema with the optional plan-review budget fields, adds `--baseline-assessment` / `--credit-assessment` to `protocol emit reviewer`, and fails closed on CLI-owned aggregate keys in emit (stdin and flags) and `validateStructuredOutput`. The work matches the plan closely, v1 fixtures still pass, and `BaselineAssessment` is imported/re-exported rather than redeclared. The one real gap is operability of the new validation: invalid or `null` values for the new fields surface as `INTERNAL_ERROR` (sometimes a raw `TypeError` message) instead of an actionable `INVALID_STRUCTURED_OUTPUT`.

**Readiness:** Ready with corrections — one mechanical P1 (error handling for the new present-field validation) and one P2; no design decisions outstanding.

---

## What shipped

- **Types + schema (`src/protocol.ts`)**: `PlanReviewScopeClass`, `CreditClaim`, `CreditAssessment`, extended `VerdictItem` / `ReviewerVerdict`, matching optional `ReviewerVerdictSchema` properties built from `ARCHITECTURE_DELTAS` / `EFFORT_POINTS`; item `required` unchanged.
- **Present-field validation**: `assertReviewerVerdict` validates enums, integer/allowed-set deltas, negative `architectureDelta` ⇒ `coupling`, full `creditClaim` evidence, `baselineAssessment`, `creditAssessments`. Nothing is required when absent.
- **CLI-owned key rejection**: `CLI_OWNED_VERDICT_KEYS` + `rejectCliOwnedBudgetFields`, called in emit stdin path, per `--item`, per assessment flag, and in `validateStructuredOutput` (reviewer role only). `assertReviewerVerdict` deliberately does not call it (plan's preferred option).
- **Emit flags**: `--baseline-assessment <json>`, repeatable `--credit-assessment <json>`; help text states aggregates are CLI-derived. No `--budget`, no `--credit-realization`.
- **Tests**: present-field validation, v1 compatibility, type-level assignability of the Phase 1 `BaselineAssessment`, emit round-trips, aggregate-key rejection, normalize pass-through.

---

## Strengths

- Single source for scales: schema enums and assert checks both derive from `review-budget/types.ts` constants, so they cannot drift from the parser/arithmetic.
- Rejection is placed at the trust boundary (emit + validate) and kept out of `assertReviewerVerdict`, preserving in-memory v1 callers.
- Normalizer needed no change (spread pass-through) and the phase added tests proving it rather than adding code.
- Reject walk is iterative with a visited set — no recursion-depth or cycle hazard on hostile input.
- Scope discipline: no implementation-review fields or Phase 6 context-sensitive requirements leaked in.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — New-field validation failures surface as `INTERNAL_ERROR`; `null` values crash with a raw `TypeError`

Observed with `5x protocol emit reviewer`:

| Input | Result |
|---|---|
| `--item '{…,"effortDelta":"3"}'` | `INTERNAL_ERROR` (exit 1), invariant message |
| `--item '{…,"architectureDelta":-2}'` (no coupling) | `INTERNAL_ERROR` (exit 1) |
| `--baseline-assessment '[1]'` / `'7'` | `INTERNAL_ERROR` (exit 1) |
| `--item '{…,"creditClaim":null}'` | `INTERNAL_ERROR`: `null is not an object (evaluating 'claim.creditClaimId')` |
| `--credit-assessment 'null'` | `INTERNAL_ERROR`: `null is not an object (evaluating 'assessment.creditClaimId')` |
| stdin `"baselineAssessment":null` / `"creditAssessments":[null]` | same raw `TypeError` |
| `--baseline-assessment 'null'` | silently dropped, exit 0 |

Before this phase `assertReviewerVerdict` was effectively unreachable as a throw from emit (action is defaulted), so the uncaught path did not matter. Phase 5 makes it the primary validator for a dozen agent-authored fields, and the consumer is an LLM reviewer that must self-correct from the error. `INTERNAL_ERROR` reads as "CLI bug, give up"; the plan's contract for bad flag JSON is `INVALID_JSON` / `INVALID_STRUCTURED_OUTPUT`. On the validate path the `TypeError` is caught and mapped to `INVALID_STRUCTURED_OUTPUT`, but the message is still the engine's, not an actionable one.

**Recommendation (mechanical):**
- In `assertReviewerVerdict`, guard shapes before dereferencing: `creditClaim`, `baselineAssessment`, and each `creditAssessments` entry must be non-null, non-array objects, else `fail("… must be an object.")`. Treat present-but-`null` as invalid, not absent.
- In `protocolEmitReviewer`, wrap both `assertReviewerVerdict` calls (stdin and flag paths) in try/catch → `outputError("INVALID_STRUCTURED_OUTPUT", message)`, mirroring the existing `rejectCliOwnedBudgetFields` handling in the same file.
- In emit, reject a parsed `--baseline-assessment` / `--credit-assessment` that is not a plain object (so `null` is not silently discarded).
- Add tests: `creditClaim: null`, `--credit-assessment null`, `--baseline-assessment null`, and one invalid-enum case asserting the `INVALID_STRUCTURED_OUTPUT` code from emit.

---

## Medium priority (P2)

- **Reject walk is deeper than the design decision states.** The Design Decisions section says top-level `budget` / aggregate keys; the implementation walks every nested object and array, and it runs for *all* reviewer verdicts in `validateStructuredOutput` (implementation reviews too). With single-letter keys (`A`, `B`, `E`, `P`, …) this is a slightly wider false-positive surface than specified. It is the safer direction and Phase 5.1 wording ("any key exists on the verdict object") tolerates it, so no code change is requested — but add one test pinning the behaviour (e.g. `items[0].creditClaim.W` rejected) so Phase 6 does not accidentally narrow or rely on the opposite.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [x] P1.1 — shape guards + `INVALID_STRUCTURED_OUTPUT` mapping for new-field validation in emit/assert, with tests

**P2**
- [x] Pin nested-key rejection behaviour with a test

---

## Plan compliance

| Plan item | Status |
|---|---|
| 5.1 types, schema, present-field assert, `CLI_OWNED_VERDICT_KEYS` | Done |
| 5.1 `BaselineAssessment` import/re-export only | Done (type-level test present) |
| 5.2 normalize pass-through, no invented `effortDelta`, unknown `scopeClass` preserved | Done (tests; no source change needed) |
| 5.3 flags, `collect` reuse, help text, reject CLI-owned keys | Done |
| 5.4 tests | Done; gaps noted in P1.1 |
| No `--credit-realization` / implementation `scopeClass` | Confirmed |

## Phase readiness

Phase 6 (validate/derive/persist) can start once P1.1 lands; it builds directly on `assertReviewerVerdict` as the shape gate before arithmetic, so the null-shape guards should be in place first to avoid `TypeError`s propagating into `applyPlanReviewBudget`.

---

## Addendum — 6b82578 (fix: harden reviewer budget protocol validation)

**Diff reviewed:** `b545c14..6b82578` (`src/commands/protocol-emit.handler.ts`, `src/protocol.ts`, and matching tests in `protocol.test.ts`, `protocol-emit.test.ts`, `protocol-helpers.test.ts`)
**Local verification:** `bun test test/unit/protocol.test.ts test/unit/protocol-normalize.test.ts test/unit/commands/protocol-emit.test.ts test/unit/commands/protocol-helpers.test.ts` — 88 pass / 0 fail (up from 84); `tsc --noEmit` clean; `biome check src test` clean; manual re-probe of every case from P1.1's table plus the happy path (all below).

### Prior findings — disposition

**P1.1 — New-field validation failures surface as `INTERNAL_ERROR`; `null` values crash with a raw `TypeError` → Addressed.**

All four recommended changes landed:
- `assertReviewerVerdict` (`src/protocol.ts`) now guards `creditClaim`, `baselineAssessment`, and each `creditAssessments` entry with an `objectShape` check before dereferencing, failing with `"… must be an object."` instead of throwing a raw `TypeError` on `null`/non-object values. `independentEffortEstimate` is also now checked for `typeof === "number"` before `Number.isInteger`, closing a latent `NaN`/string coercion gap in the same spot.
- `protocolEmitReviewer` (`src/commands/protocol-emit.handler.ts`) wraps both `assertReviewerVerdict` call sites (stdin path and flag path) via a new `assertReviewerVerdictForEmit` helper that catches and maps to `outputError("INVALID_STRUCTURED_OUTPUT", …)`, mirroring the existing `rejectCliOwnedBudgetFields` handling.
- `--baseline-assessment` and `--credit-assessment` flag JSON is now checked with `isObjectShape` after `JSON.parse`; a non-object (including `null`, arrays, and bare scalars) now fails closed with `INVALID_STRUCTURED_OUTPUT` instead of being silently dropped or crashing.
- Tests were added at all three levels: `protocol.test.ts` (`rejects null object-shaped budget fields with actionable messages` — covers item `creditClaim: null`, top-level `baselineAssessment: null`, and `creditAssessments: [null]`), `protocol-emit.test.ts` (`rejects null assessment flags as invalid structured output` for both flags; `maps assertion failures to INVALID_STRUCTURED_OUTPUT` for an invalid-enum item and a stdin `baselineAssessment: null`).

Re-verified live against the exact table from the original finding — every row that previously returned `INTERNAL_ERROR` or a raw `TypeError` message, or silently dropped input, now returns `{"ok":false,"error":{"code":"INVALID_STRUCTURED_OUTPUT", …}}` with an actionable message (exit 7, the pre-existing convention for that code):

| Input | Before | After |
|---|---|---|
| `--item '{…,"effortDelta":"3"}'` | `INTERNAL_ERROR` | `INVALID_STRUCTURED_OUTPUT`: invalid 'effortDelta' |
| `--item '{…,"architectureDelta":-2}'` (no coupling) | `INTERNAL_ERROR` | `INVALID_STRUCTURED_OUTPUT`: requires 'coupling' |
| `--item '{…,"creditClaim":"x"}'` | `INTERNAL_ERROR` (validation msg, but only by luck of key ordering) | `INVALID_STRUCTURED_OUTPUT`: creditClaim must be an object |
| `--item '{…,"creditClaim":null}'` | `INTERNAL_ERROR`: raw `TypeError` | `INVALID_STRUCTURED_OUTPUT`: creditClaim must be an object |
| `--baseline-assessment 'null'` | silently dropped, exit 0 | `INVALID_STRUCTURED_OUTPUT`: must be a JSON object |
| `--baseline-assessment '[1]'` / `'7'` | `INTERNAL_ERROR` | `INVALID_STRUCTURED_OUTPUT`: must be a JSON object |
| `--credit-assessment 'null'` | `INTERNAL_ERROR`: raw `TypeError` | `INVALID_STRUCTURED_OUTPUT`: must be a JSON object |
| stdin `"baselineAssessment":null` | raw `TypeError` | `INVALID_STRUCTURED_OUTPUT`: baselineAssessment must be an object |
| stdin `"creditAssessments":[null]` | raw `TypeError` | `INVALID_STRUCTURED_OUTPUT`: each creditAssessment must be an object |

The happy-path item (`effortDelta:3, architectureDelta:-2, coupling:"intrinsic"`) still emits successfully with exit 0, confirming no regression to the valid-input path.

**P2 — Reject walk is deeper than the Design Decision states (pin with a test) → Addressed.**

`protocol-helpers.test.ts` gained `rejects nested reviewer-authored CLI aggregate keys`, asserting `validateStructuredOutput` fails closed on `items[0].creditClaim.W` with `INVALID_STRUCTURED_OUTPUT` and a message containing `'W'` — exactly the pinning test recommended. Re-verified live: `--credit-assessment '{…,"W":3}'` still correctly rejects with `"Reviewer verdict must not provide CLI-derived budget field 'W'."`.

### New issues from this revision

None found. The diff is narrowly scoped to the two prior findings, does not touch parsing/normalization logic, does not add new fields, and does not regress the CLI-owned-key rejection path. `assertReviewerVerdictForEmit`'s return type is inferred as `ReviewerVerdictAssertionResult | undefined` (since `outputError` doesn't return `never` from TS's perspective in this codebase's existing pattern — same shape as `rejectCliOwnedBudgetFields`'s call sites elsewhere in the same file), and the call sites destructure `.warnings` off it unconditionally; this only matters if `outputError` doesn't actually terminate the process, which the passing tests and the manual re-probe above disprove (every rejected case returns before reaching the `.warnings` loop). Not flagged as an issue — this is the same pattern already used for `rejectCliOwnedBudgetFields` throughout the file.

### Updated readiness

**Readiness:** Ready — both P1 and P2 items from the initial review are addressed, verified by tests and live CLI probing, with no regressions and no new findings. Phase 5 is complete; Phase 6 can proceed without the null-shape-guard prerequisite noted in the original Phase readiness section.
