# Plan input: Implementation-review governance

## Metadata

| Field | Value |
|---|---|
| **Slice ID** | `v2-implementation-review-governance` |
| **Status** | `draft` |
| **Owner** | |
| **Generated plan** | `-` |
| **Last updated** | 2026-08-13 |

---

## One-line goal

Implementation review remains within approved plan intent, converges on diff-causal defects, and reconciles promised architecture simplification before dependent work completes.

---

## In scope

- Add the implementation-review item contract for `implementation_defect`, `plan_defect`, `scope_expansion`, and `pre_existing` findings.
- Require priority, effort/architecture telemetry, approved work-item linkage, conditional plan impact, and continued-review evidence.
- Validate `introducedBy` commit ranges and exact code diff hunks against the reviewed fix range.
- Implement `text_only`, `design`, and `budget` plan-defect routing, including byte-identical protection of the `Delivery Budget` table for text-only amendments.
- Add implementation `ready_with_corrections` with one mechanical P2 defect, no boundary change, mandatory full quality rerun, and reviewer re-entry on failure.
- Reconcile each provisional architecture-debt claim as realized, partial, or not realized before dependent phases or run completion.
- Recompute credit-derived budget state and route material shortfalls to explicit human choices without creating tangential remediation work.
- Record implementation-review telemetry and inject prior deferred/accepted-risk decisions into review prompts.

---

## Out of scope / deferred

- A separate implementation-review effort baseline or ceiling.
- Minting new architecture-debt credit after plan approval.
- Automatic structural plan changes during implementation review.
- Auto-fixing scope expansion or unrelated pre-existing findings.
- Changing advisory/enforced defaults based on telemetry; that requires later calibration.

---

## Primary documents (read in order)

1. `docs/v2/206-review-budget-governance.md` - implementation classifications, convergence, credit realization, telemetry, and acceptance criteria.
2. `docs/v2/200-overview.md` - human ownership and control-plane state constraints.
3. `docs/v1/100-architecture.md` - current phase execution, implementation review, quality gates, and plan authority.
4. `docs/v1/101-cli-primitives.md` - protocol, diff, quality, commit, and run-record primitives.

---

## Dependencies

- [ ] `07-plan-review-governance.plan-input.md` is merged with an approved budget ledger, debt claims, and durable decisions.

**Assumptions** (ok to be wrong, but then spike or revise docs):

- Existing commit/step history can identify the exact fix range supplied to continued implementation review.
- Full configured quality gates are the authoritative post-correction check.
- A phase cannot complete while a target-phase debt claim remains unreconciled.

---

## Constraints

| Constraint | Value |
|---|---|
| Target phase count | <= 12 phases |
| Must touch areas | Implementation reviewer templates/skills, protocol schema/validation, git diff evidence, quality routing, budget store, phase completion gates |
| Forbidden for this slice | No second budget, post-approval debt-credit creation, automatic scope expansion, or structural plan rewrite without human review |

---

## Exit criteria

- Protocol validation selects the correct plan-review or implementation-review contract from recorded phase context and cannot mix their enums.
- Every ordinary new continued-review blocker is tied to a validated introducing code hunk; unrelated pre-existing findings remain follow-up.
- Plan defects route according to impact, and the text-only exemption cannot alter any byte of the delivery-budget table.
- Implementation `ready_with_corrections` proceeds without reviewer re-entry only after the full quality suite passes.
- Every due debt claim is reconciled before dependent phases/final completion, with CLI-derived realized credit and explicit handling of shortfalls.
- Material correctness and implementation defects remain visible regardless of budget status.
- Tests: schema/context validation, git-hunk verification, plan-table snapshots, quality fallback, credit reconciliation, human gates, and phase-completion blocking.
- Docs/skills: implementation author/reviewer loops describe scope classes, convergence, quality fallback, and debt reconciliation.

---

## Handoff

**Leave for the next plan** (questions, spikes, or follow-on slices - do not implement here):

1. Analyze recorded telemetry before considering a distinct implementation-review budget.
2. Finalize all externally visible output changes in the coordinated v2 release slice.

**Suggested next slice** (optional): `09-output-normalization-release.plan-input.md`

---

## Risks / spikes

| Risk | Mitigation |
|---|---|
| Git hunk evidence is fragile across rebases | Bind validation to the exact recorded commit range and diff sent to the reviewer |
| Text-only exemption smuggles budget/design changes | Snapshot and compare the raw table byte-for-byte before accepting the exemption |
| Quality shortcut bypasses review after a semantic correction | Restrict eligibility structurally and force reviewer re-entry on any gate failure |
