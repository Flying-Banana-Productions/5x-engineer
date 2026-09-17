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
- [ ] P1.1 — shape guards + `INVALID_STRUCTURED_OUTPUT` mapping for new-field validation in emit/assert, with tests

**P2**
- [ ] Pin nested-key rejection behaviour with a test

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
