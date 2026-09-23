# Review: Plan 210 Phase 2 — Context-specific protocol and classification policy

**Review type:** `5daa9c29fa5b6d3130977f09ce5a03c3252a4b0f`
**Scope:** Phase 2 (W2): implementation scope classes and item fields in `protocol.ts`, the provider schema union, `--credit-realization` emit parsing, run-aware contextual validation in `protocol validate`, pure classification and span resolution in `review-governance/implementation.ts`, and domain-qualified fingerprints
**Reviewer:** Staff engineer (correctness, fail-closed semantics, plan compliance, test strategy)
**Local verification:** `bun test` in `5x-cli/`: 3650 pass, 0 fail. `bun run typecheck`: clean. `bun run lint`: clean. I also probed `validateImplementationReview` directly and ran the CLI `protocol validate reviewer` with an implementation verdict (see P1.1–P1.3).

**Implementation plan:** `5x-cli/docs/development/plans/210-implementation-review-governance-plan.md`
**Technical design:** N/A

## Summary

The structural contract is thorough and matches the plan closely. It covers the four-class enum, conditional `planWorkItemIds` and `planImpact`, a strict `PlanImpact` object shape, strict credit realizations, recursive rejection of aggregate keys, rejection of mixed contracts, and explicit-but-unknown `boundaryChanges`. Plan-review behavior and plan fingerprints are unchanged. The contextual layer has three fail-open or over-strict edges. A malformed text-amendment lineage still authorizes the text-only exemption. A pure plan-contract verdict in a bound implementation phase is accepted. Standalone `protocol validate` rejects every implementation verdict that has no `--phase`. All three fixes follow directly from the plan, and none needs a design decision.

**Readiness:** Ready with corrections. Three mechanical P1 correctness fixes are needed before Phase 3/4 build on this validator.

---

## What shipped

- **Protocol (`src/protocol.ts`)**: `IMPLEMENTATION_SCOPE_CLASSES`, `PlanImpact`, `BoundaryChangeLabel`, `CreditRealization` and `NonblockingObservation` types. The provider schema union and `assertReviewerVerdict` now branch by domain: implementation items require priority, a nonnegative integer effort and any integer architecture delta. The PlanImpact validator rejects strings, unknown fields and blank or duplicate locations. It also rejects mixed plan/implementation verdicts and plan-only fields on implementation verdicts.
- **Emit (`protocol-emit.handler.ts`, `protocol.ts`)**: pass-through of the new item fields and a repeatable `--credit-realization`, with CLI-owned field rejection.
- **Contextual validation (`review-governance/implementation.ts`, `protocol.handler.ts`)**: domain comes from the command/envelope phase and the persisted binding or compatibility record, never from the agent's `reviewKind`. The validator checks work items and credit claims against the bound ledger and resolves text-only spans CLI-side, returning byte offsets. It checks protected-structure and overlap rules, classifies findings by source of correction, excludes pre-existing findings from actionable items, and routes advisory results with a hypothetical enforced route. The review round is counted from persisted steps, not the session.
- **Fingerprints (`fingerprint.ts`)**: implementation identities include phase and sorted work-item IDs. Plan hashes are byte-stable (covered by test).
- **Plan budget (`review-budget/apply.ts`)**: guards against implementation scope classes leaking into plan snapshots.

---

## Strengths

- The domain comes from trusted context. `envelopeDomain` is only compared for conflicts and never used to select a domain, as the plan requires.
- Text-only span resolution is conservative. Headings must match exactly and uniquely, `staleText` must be literal and occur exactly once, spans cannot overlap, and offsets are resolved CLI-side. Phase headings, checklist lines, Delivery Budget table rows and the design/scope/acceptance sections are protected. Ambiguity downgrades to a human route rather than a best-effort replacement.
- Unknown boundary impact (a missing `boundaryChanges`) keeps the item on normal review. It is never treated as an empty array.
- Plan-review regression risk is low. The plan branch of `assertReviewerVerdict` keeps the prior `ARCHITECTURE_DELTAS` and coupling rules, and a test pins plan fingerprint stability.
- The pure core (`validateImplementationReview` / `classify`) is separate from I/O, which lets Phase 4 reuse it for render/invoke/record parity.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — A malformed amendment lineage still authorizes the text-only exemption

`validateImplementationReview` (`implementation.ts:818–855`) calls `detectPlanDrift`. When the chain is invalid, `detectPlanDrift` falls back to the approved bytes. The validator then resolves spans against those bytes and still sets `spansAuthorized = true`. It adds only an `info` diagnostic. Probe: with an enforced binding, one amendment with a bad version or parent, and a `text_only` plan_defect whose `staleText` exists in the approved bytes, the result is `exemptionAuthorized: true` and route `author_revision`. The plan says "an unverified/malformed chain never authorizes drift" and "contextual ambiguity disables the exemption". The approved bytes are also the wrong anchor once any amendment has been applied.

**Requirement:** When `amendments.length > 0 && !drift.chainValid`, do not resolve or authorize spans. Emit `PLAN_IMPACT_NOT_AUTHORIZED` with severity `error` so the finding routes human/plan_amendment. Add a unit test with a malformed chain, and a positive test in which a valid chain moves the anchor so that `staleText` is found only in the amended bytes.

### P1.2 — Plan-contract verdicts pass unchecked in a bound implementation phase

`protocol.handler.ts:546` runs contextual validation only when `verdictUsesImplementationContract` is true. Inside the validator, `implementation.ts:705` returns `valid/standalone` for any non-plan phase without an implementation contract. As a result, a verdict with `baselineAssessment`, `creditAssessments`, `creditClaim` or plan scope classes (`polish`, …) in phase `2` of an enforced binding is accepted. Probe: `valid: true, domain: "standalone"`. The `PLAN_CONTRACT_IN_IMPLEMENTATION_PHASE` code is unreachable from the CLI. The plan requires rejecting "plan baseline/eligibility fields in implementation verdicts". Legacy v1 items with no `scopeClass` are not a plan contract under `verdictUsesPlanContract`, so they stay compatible.

**Requirement:** In the handler, also run contextual validation for reviewer verdicts in a non-plan phase when `verdictUsesPlanContract` is true. In the validator, move the `planContract` rejection ahead of the early return for runs with a binding (certifying). Off/compatibility runs keep v1 acceptance. Add handler and unit tests.

### P1.3 — Standalone `protocol validate` rejects every implementation verdict without `--phase`

Probe: `5x protocol validate reviewer --input v.json` with a well-formed `implementation_defect` item returns `UNKNOWN_PHASE: Phase '' is not a known plan or implementation phase.` The validator treats a missing phase as fatal before it considers that no run exists. The plan says "Standalone protocol emit/validate remains usable without a run but never claims contextual approval" and "Standalone validation only validates the structural union and rejects mixed enums". `emit` works, but validating its own output does not.

**Requirement:** When there is no `--run` and no phase (standalone), return structural acceptance with domain `standalone`, no governance, and an `IMPLEMENTATION_CONTEXT_MISSING` info diagnostic. Keep `UNKNOWN_PHASE` for run-aware calls, where the phase is missing or not in the binding's phase map. Add a CLI/handler test.

---

## Medium priority (P2)

- **Handler-level test coverage**: `protocol-validate.test.ts` covers only plan-phase rejection and unknown work items. Add handler tests for these paths: the binding-pinned mode overriding config, compatibility → v1 acceptance, advisory with no binding (info diagnostic plus warn), enforced with no binding (`IMPLEMENTATION_CONTEXT_MISSING`), `PHASE_MISMATCH`, and `RecordContextError` with and without `--record`. These are the paths Phase 4 will depend on.
- **Fingerprint linkage not yet threaded**: no production caller passes `linkage.phase` to `fingerprintVerdictItem`, so implementation fingerprints currently use an empty phase. This is harmless until Phase 4 persists implementation findings. Phase 4 must pass the admitted phase, or cross-phase collisions will return.
- **Provider schema loosened for plan reviewers**: the union schema drops the `ARCHITECTURE_DELTAS` enum, so structured-output providers no longer constrain plan magnitudes and invalid plan values are rejected only after the model responds. This follows from the plan's union decision. Consider a phase-specific schema when rendering plan-review prompts.
- **Duplicated phase-conflict check**: `protocol.handler.ts` repeats the conflict check between the phase flag and the envelope phase that `validateImplementationReview` already performs. Keep one of them.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Invalid amendment chain disables text-only span authorization
- [ ] P1.2 Plan-contract fields rejected in bound implementation phases
- [ ] P1.3 Standalone validate accepts structurally valid implementation verdicts without a phase
