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
- [x] P1.1 Invalid amendment chain disables text-only span authorization
- [x] P1.2 Plan-contract fields rejected in bound implementation phases
- [x] P1.3 Standalone validate accepts structurally valid implementation verdicts without a phase

---

## Addendum (2026-09-23) — Fail-open fixes verified

**Reviewed:** `3e9c08d1212779e6b9f4407b8c244bb9f23cbea3` (one commit since `dd592d5b`)

**Local verification:** `bun test` in `5x-cli/`: 3664 pass, 0 fail (up from 3650). `bun run typecheck`: clean. `bun run lint`: clean. I re-ran my original three probes directly against `validateImplementationReview` and, for P1.3, against the CLI binary; all three now behave as required (see below).

### What's addressed (✅)

- **P1.1 — Malformed amendment chain no longer authorizes text-only spans**: `implementation.ts` now checks `amendments.length > 0 && !drift.chainValid` *before* calling `resolvePlanImpactSpans`, and skips span resolution entirely in that case, pushing an `error`-severity `PLAN_IMPACT_NOT_AUTHORIZED` diagnostic instead of the prior `info`. Re-probe with a malformed chain (bad `parentLineageId`) against a real `plan_defect`/`text_only` item: `exemptionAuthorized: false`, `spans: []`, route `human_gate`, diagnostic `PLAN_IMPACT_NOT_AUTHORIZED:error`. New unit tests cover both the malformed-chain rejection and a valid chain moving the authorized anchor so `staleText` resolves only in the amended bytes. Fully addressed.

- **P1.2 — Plan-contract fields rejected in bound implementation phases**: the `certifying && planContract` check moved ahead of the `!implementationContract` early-return, so it is now reachable. `protocol.handler.ts` also now runs contextual validation whenever `verdictUsesPlanContract(verdict)` is true and the phase is a known non-plan phase, not only when an implementation contract is present — closing the path where the handler never called the validator at all. Re-probe with an enforced binding and a pure `polish`-scoped item at phase 1: `valid: false`, `fatalCode: "PLAN_CONTRACT_IN_IMPLEMENTATION_PHASE"`. New unit tests exercise `polish` scopeClass, `baselineAssessment`, `creditAssessments`, and a plan `creditClaim`, each correctly rejected when a binding exists (`certifying`), and correctly left permissive for `off`, `compatibility`, and no-binding (`standalone`) cases — matching the exact remediation this review requested ("reject before the early return when a binding exists ... keep v1/off acceptance"). Fully addressed. I also traced the one remaining permissive edge (plan-contract verdict at a known numeric phase with config mode `enforced` but no binding yet resolvable, i.e. `certifying === false`): the code still accepts it via the `!implementationContract` standalone branch. This is intentional per the fix's own doc comment and matches what I asked for — it is not a new gap, since certifying is exactly the signal that a binding truly ties this phase to implementation governance.

- **P1.3 — Standalone validate no longer rejects a phase-less implementation verdict**: a new `hasRun` input flag lets `validateImplementationReview` distinguish "genuinely standalone" (`hasRun === false`) from "run-aware but the phase resolution failed" (`hasRun` true/omitted, still fatal `UNKNOWN_PHASE` — correctly fail-closed by default). `protocol.handler.ts` passes `hasRun: Boolean(params.run)`. Direct CLI re-probe: `5x protocol validate reviewer --input v.json` (no `--run`, no `--phase`) now returns `{"ok":true,...}` with an `IMPLEMENTATION_CONTEXT_MISSING` info warning, instead of the prior `UNKNOWN_PHASE` fatal. Fully addressed.

### Bonus fixes beyond the three P1 items

- **P2.1 (handler test coverage)**: the revision adds CLI/handler-level tests for the binding-pinned-mode-overrides-config case, an advisory binding overriding enforced config, the compatibility→v1 path, advisory/enforced with no binding, `PHASE_MISMATCH`, and `RecordContextError` with and without `--record` — the exact gaps this review flagged as P2.1. Addressed.
- **P2.2 (duplicated phase-conflict check)**: the handler's standalone `params.phase`/`envelopePhase` mismatch check was removed; `PHASE_MISMATCH` is now raised solely inside `validateImplementationReview` (confirmed by the retained "a phase flag that conflicts with the envelope phase is rejected once" test). Addressed.

### Remaining concerns

None from the prior review. No new issues were introduced by this revision — the diff is scoped to the three validator paths and their tests, and the full suite (3664 tests, up from 3650) is green with no regressions in plan-phase or v1-compatibility behavior.

### Updated readiness

- **Phase 2 completion:** ✅ — all three P1 blockers are verified fixed by direct re-probe, not just by trusting the new tests.
- **Ready for next phase:** ✅ — no outstanding P0/P1 items. Only the pre-existing P2 polish items from the original review (fingerprint `linkage.phase` threading, deferred to Phase 4; provider schema no longer constraining plan `architectureDelta` magnitudes client-side) remain, and both are unchanged by this revision.

---

## Addendum (2026-09-23, later same day) — Remaining P2 items verified

**Reviewed:** `4e59d55c2d36ca649e7d24ad8eff6e89d35fc95a` (one commit since `63ccbe96`)

**Local verification:** `bun test` in `5x-cli/`: 3667 pass, 0 fail (up from 3664). `bun run typecheck`: clean. `bun run lint`: clean. I re-ran independent probes against `reviewerProviderSchema`, `canonicalFindingFingerprint`, and `validateImplementationReview` rather than relying solely on the new tests; both P2 items behave as required (see below).

### What's addressed (✅)

- **P2.1 — Fingerprint `linkage.phase` threading**: a new `fingerprintImplementationVerdictItem(item, admittedPhase, fallback?)` helper wraps `fingerprintVerdictItem` and requires a numeric admitted phase (matching `canonicalPhaseId`'s own numeric/`phase-N` grammar), throwing `TypeError` otherwise. `canonicalFindingFingerprint` now throws the same way for any implementation-scoped item with no admitted phase, closing the silent-empty-phase gap. `classify()` in `review-governance/implementation.ts` now populates `governance.findingIdentities` — one `{ findingId, phase, planWorkItemIds, fingerprint }` entry per implementation-scoped item, computed with the admitted phase that already flows through `validateImplementationReview`. Re-probe: `validateImplementationReview({ verdict, phase: "2", mode: "advisory" })` returns `governance.findingIdentities` with `phase: "2"` and a real SHA-256 fingerprint; calling `canonicalFindingFingerprint` directly with an implementation scope class and no phase throws `"Implementation fingerprints require an admitted numeric phase."` New unit tests confirm phase 2 vs. phase 3 fingerprints differ for an otherwise-identical item, and that the two throwing paths are covered. `review-budget/apply.ts` also gained a defensive `BUDGET_ITEM_FIELDS_REQUIRED` rejection of implementation-scoped items before they could ever reach the plan-only `fingerprintVerdictItem` call sites (`routing.ts`, `closure.ts`, `review-decision.handler.ts`), so none of the pre-existing plan-fingerprint call sites can be reached with an implementation item today. This is a reasonable, minimal Phase-2-scoped fix; Phase 4's observation writer still needs to consume `governance.findingIdentities` (or call the new helper directly) when it starts persisting implementation findings — that wiring is out of Phase 2's scope and not a gap in this revision. Fully addressed.

- **P2.2 — Provider schema no longer constraining plan `architectureDelta`**: `reviewerVerdictSchemaFor` now takes an explicit `domain: "plan" | "implementation"` (defaulting to `"plan"` for backward compatibility) and re-adds the `ARCHITECTURE_DELTAS` enum for plan schemas while leaving implementation schemas as an unrestricted signed integer. A new `reviewerProviderSchema({ phaseId, baselineAssessment, planReviewTemplate })` selects the domain from the admitted phase (falling back to the union `ReviewerVerdictSchema` when the phase is unresolved), and `invoke.handler.ts` now calls it with `admittedPhase = canonicalPhaseId(recordPhase)` instead of unconditionally using `reviewerVerdictSchemaFor(baselineContract)` (which previously always got the union schema regardless of domain). Re-probe: `reviewerProviderSchema({ phaseId: "plan", baselineAssessment: "required" })` restores the `enum: [-5,-3,-2,-1,0,1,2,3,5]` constraint; `reviewerProviderSchema({ phaseId: "2" })` stays an unconstrained integer. The implementation-domain branch of `reviewerVerdictSchemaFor` also correctly ignores the `baselineAssessment: "required"` contract (no `baselineAssessment` added to `required`), matching the rule that implementation reviews prohibit that field. Fully addressed.

### Remaining concerns

None new. No regressions were introduced — the diff is scoped to the two flagged P2 items plus their tests and one defensive guard in `apply.ts`; the full suite (3667 tests, up from 3664) is green.

### Updated readiness

- **Phase 2 completion:** ✅ — both prior-addendum P2 items are verified fixed by direct re-probe. No open P0/P1/P2 items remain from either the original review or its first addendum.
- **Ready for next phase:** ✅ — Phase 2 is complete. The one forward-looking note (Phase 4 must consume `governance.findingIdentities` or `fingerprintImplementationVerdictItem` when it persists implementation observations, rather than reintroducing a bare `fingerprintVerdictItem` call) is scope for Phase 4, not a Phase 2 defect.
