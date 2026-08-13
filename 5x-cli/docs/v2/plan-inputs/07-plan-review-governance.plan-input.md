# Plan input: Plan-review governance

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-plan-review-governance` |
| **Status** | `draft` |
| **Owner** | |
| **Generated plan** | `-` |
| **Last updated** | 2026-08-13 |

---

## One-line goal

Plan-review cycles converge against prior findings and route budget, scope, architecture, and accepted-risk tradeoffs through durable human decisions.

---

## In scope

- Update initial review prompts for exhaustive first-pass findings, independent baseline assessment, scope classification, and lowest-cost correction.
- Turn continued reviews into closure reviews with prior-finding status, exact introducing-hunk evidence, critical-safety exceptions, and nonblocking follow-ups.
- Validate provisional architecture-debt eligibility, coupling, minimal-compliant comparisons, and positive-architecture thresholds.
- Implement enforced routing for budget bands, baseline disputes, semantic `human_required` items, architecture alerts, and validated `ready_with_corrections`.
- Add explicit human choices for budget increase, scope trade, risk deferral, and abort through the control-plane prompt/decision path.
- Persist stable decision IDs, finding fingerprints, rationale, evidence, approved scope, governing baseline changes, and full audit history.
- Inject prior deferred and accepted-risk decisions into every later plan review and require new evidence to re-raise them.
- Add dashboard views/actions for forecast, ceilings, debt claims, alerts, and decision history.

---

## Out of scope / deferred

- Implementation-review item classes, diff validation, quality-gated final corrections, and realized debt credit; owned by `08-implementation-review-governance.plan-input.md`.
- A second implementation budget.
- General-purpose technical-debt discovery or unrelated refactoring.
- Automatic suppression of material correctness, security, data-loss, or acceptance findings.
- Making enforced mode the global default before advisory calibration supports it.

---

## Primary documents (read in order)

1. `docs/v2/200-overview.md` - control-plane decision ownership and compatibility policy.
2. `docs/v2/206-review-budget-governance.md` - debt credit, convergence, readiness, human-gate, and audit requirements.
3. `docs/v2/202-control-plane.md` - prompt/decision queue and dashboard action boundaries.
4. `docs/v1/100-architecture.md` - existing plan-review skills and iteration backstop.

---

## Dependencies

- [ ] `04-control-plane-dashboard.plan-input.md` is merged with authenticated human-action paths.
- [ ] `06-review-budget-advisory.plan-input.md` is merged with calibrated parser, persistence, and deterministic derivation.

**Assumptions** (ok to be wrong, but then spike or revise docs):

- Enforced behavior is opt-in during this slice; advisory remains the default.
- Answered gate prompts plus durable decision records can preserve all required human choices without a generic command bus.
- The CLI validates cited plan hunks against the exact diff supplied to the continued-review prompt.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 12 phases |
| Must touch areas | Reviewer templates/skills, protocol validation, routing, decision persistence, prompt/control-plane UI, audit tests |
| Forbidden for this slice | No implementation-review enforcement, unrelated debt program, hidden budget arithmetic, or reviewer-authored aggregate status |

---

## Exit criteria

- Initial review is the only ordinary exhaustive pass; closure reviews cannot create unrelated blocking work.
- New ordinary blockers cite and validate an exact introducing plan hunk; critical late safety issues route directly to a human.
- Deferred or accepted findings cannot re-enter as blockers without a prior decision ID and new evidence.
- `ready_with_corrections` is accepted only within the documented mechanical, effort, architecture, and budget bounds.
- Enforced runs pause for each computed or semantic human gate and resume from a durable explicit decision.
- Debt credit never hides gross effort or positive architecture burden and never exceeds effective/absolute caps.
- Tests: routing matrix, diff-evidence validation, repeated decisions, CAS races, debt guardrails, readiness normalization, and prompt/dashboard flows.
- Docs/skills: plan-review workflows clearly distinguish initial review, closure review, follow-up, and human gate behavior.

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices - do not implement here):

1. Reconcile provisional debt claims against implementation outcomes.
2. Apply diff-causal convergence and scope classification to implementation review.

**Suggested next slice** (optional): `08-implementation-review-governance.plan-input.md`

---

## Risks / spikes

| Risk | Mitigation |
|---|---|
| Enforcement pauses healthy workflows due to immature estimates | Keep advisory default and require explicit opt-in for enforced mode |
| Reviewer fabricates aggregate budget outcomes | Accept only item-level inputs and derive all routing in the CLI |
| Accepted-risk records suppress materially new evidence | Require fingerprints plus scoped decisions, but preserve critical-safety escalation |
