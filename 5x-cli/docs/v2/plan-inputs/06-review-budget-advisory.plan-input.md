# Plan input: Review-budget advisory foundation

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-review-budget-advisory` |
| **Status** | `draft` |
| **Owner** | |
| **Generated plan** | `-` |
| **Last updated** | 2026-08-13 |

---

## One-line goal

New plan-review runs record immutable work-item baselines and deterministic budget forecasts as advisory telemetry without changing workflow routing.

---

## In scope

- Add and validate the required `Delivery Budget` and surface-snapshot sections in newly generated plans.
- Parse stable work-item IDs, effort, architecture delta, debt-claim metadata, and `Addresses` linkage.
- Add `reviewBudget` configuration with `off`, `advisory`, and reserved `enforced` modes; default to advisory.
- Persist immutable `B0`, governing `B`, current work-item ledger, surface snapshot, reviewer deltas, assessments, claims, and derived results behind store operations.
- Extend plan-review protocol emit/validate contracts with baseline assessment, classifications, effort/architecture deltas, evidence, and credit assessments.
- Implement deterministic arithmetic for `W`, `R`, `S`, `N`, provisional `D`, `E`, `A`, `P`, baseline direction, alerts, and human-required signals.
- Decorate recorded review steps and run-state output with advisory budget results while preserving v1 routing.
- Add existing-plan preflight and mid-review opt-in safeguards from the rollout design.

---

## Out of scope / deferred

- Changing author/reviewer loop routing based on budget results.
- Enforced convergence, accepted-risk decisions, and budget-specific human gates; owned by `07-plan-review-governance.plan-input.md`.
- Implementation-review classification and debt-credit realization; owned by `08-implementation-review-governance.plan-input.md`.
- Dashboard visualization beyond making persisted data queryable.
- Calibration-based changes to documented default percentages.

---

## Primary documents (read in order)

1. `docs/v2/200-overview.md` - run-state and human-decision boundaries.
2. `docs/v2/206-review-budget-governance.md` - canonical model, contracts, persistence, configuration, and staged rollout.
3. `docs/v1/100-architecture.md` - current plan-review workflow and protocol invariants.
4. `docs/v1/101-cli-primitives.md` - current run/protocol command behavior.

---

## Dependencies

- [ ] `03-prompt-queue-foundation.plan-input.md` is merged so new durable control-plane records follow the established store boundary.

**Assumptions** (ok to be wrong, but then spike or revise docs):

- Advisory mode records `requiresHuman` as telemetry but does not alter v1 routing.
- The Markdown table in area 206 is the canonical plan-side work-item format.
- New budget records use globally unique IDs where synchronization could matter.
- Plan parsing failures are explicit and cannot silently establish a zero baseline.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 12 phases |
| Must touch areas | Plan templates/parser, config, DB/store, protocol schemas/emit/validate, run-state output, arithmetic tests |
| Forbidden for this slice | No enforced routing, automatic scope decisions, implementation-review contract, or browser budget UI |

---

## Exit criteria

- A baseline is captured exactly once before the first reviewer and cannot be changed by editing plan prose.
- Revised work-item tables update `W` while stable `Addresses` IDs prevent incorporated findings from remaining double-counted in `R`.
- All aggregate values and alerts are CLI-derived; reviewer input cannot supply or override totals and ceilings.
- Baseline disagreement is detected in both directions and recorded without changing advisory routing.
- Invalid scores, IDs, claims, or malformed tables fail with actionable diagnostics rather than partial records.
- Existing mid-review runs stay on v1 semantics unless explicitly opted in with an approved baseline.
- Tests: parser fixtures, migration/store history, arithmetic boundaries, deduplication, protocol round trips, configuration layering, and compatibility behavior.
- Docs/templates: plan and reviewer templates explain advisory fields and stable-ID rules.

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices - do not implement here):

1. Route computed alerts through explicit human budget/scope/risk decisions.
2. Measure advisory results before changing defaults or recommending enforcement globally.

**Suggested next slice** (optional): `07-plan-review-governance.plan-input.md`

---

## Risks / spikes

| Risk | Mitigation |
|---|---|
| Markdown edits destabilize work-item identity | Enforce stable IDs and preserve immutable snapshots in control-plane state |
| Budget arithmetic is spread across handlers | Put all derivation in one pure, exhaustively tested module |
| Protocol extension breaks existing review runs | Gate by run mode/context and preserve v1 routing for uninitialized runs |
