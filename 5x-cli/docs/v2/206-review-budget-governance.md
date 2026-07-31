# 5x CLI v2 — Review Budget Governance

**Status:** Draft — Not Implemented
**Date:** July 31, 2026
**Part of:** v2 (`200-overview.md`, area #6)
**Shared core used:** Run-state surface (`200-overview.md` §3.2) and human decisions through the control plane (`202-control-plane.md`)
**Extends:** Plan templates, plan-review skills, reviewer prompts, and `ReviewerVerdict`

---

## 1. Problem (delta from v1)

Increasing reviewer capability has made plan review more accurate locally but less bounded globally. A reviewer can repeatedly discover another adjacent execution path, edge case, or hardening opportunity after each author revision. Every finding may be valid while the aggregate plan becomes disproportionately expensive and complex.

Recent plans in an active project illustrate the pattern. Line count is only a proxy for scope, but the revisions also added implementation surfaces, abstractions, context threading, and test obligations:

| Plan | Initial plan | Approved plan | Revision cycles |
|---|---:|---:|---:|
| 430 | 113 lines | 238 lines | 3 |
| 440 | 96 lines | 252 lines | 5 |
| 450 | 360 lines | 652 lines | 3 |

The behavior follows from the current workflow rather than from one bad reviewer:

- `src/templates/reviewer-plan.md` gives correctness, architecture, completeness, risks, and scope equal weight, with no marginal-value or cost threshold.
- `src/templates/reviewer-plan-continued.md` explicitly asks the reviewer to surface new issues after every revision.
- `VerdictItem.action` classifies only whether a fix is mechanically derivable. A deterministic but expensive expansion remains `auto_fix`.
- Every `auto_fix` routes through another author/reviewer cycle, including `ready_with_corrections`.
- The only hard stop is `maxReviewIterations`, which escalates after the expansion has already occurred.

The result is an unpriced scope ratchet. v2 needs a stopping rule that preserves strong review while making cost and architecture tradeoffs explicit and human-owned.

---

## 2. Goals and principles

### 2.1 Goals

- Keep review-driven implementation growth within an explicit delivery budget.
- Escalate cost and scope tradeoffs before they are automatically incorporated.
- Make continued reviews converge on prior findings instead of restarting exhaustive review.
- Preserve the reviewer's ability to identify correctness, security, data-loss, and acceptance-criterion failures.
- Prefer feature-local simplification and debt reduction when it produces a demonstrably simpler post-state.
- Keep gross delivery effort visible even when architecture debt is reduced.

### 2.2 Non-goals

- Produce precise time estimates. Complexity points are governance signals, not scheduling commitments.
- Suppress material findings to make a plan fit its budget. Over-budget required work is escalated, not hidden.
- Turn plan review into a general technical-debt program.
- Reward broad rewrites, speculative abstractions, dependency upgrades, or nearby cleanup unrelated to the requested outcome.
- Replace `maxReviewIterations`; it remains a final safety stop.

### 2.3 Governing principle

> The reviewer identifies risk; the approved budget determines whether remediation is automatic; the human owns any tradeoff between scope, cost, and accepted risk.

---

## 3. Two-axis budget model

Implementation effort and long-term architecture burden are related but not interchangeable. A simplifying refactor can cost more now while reducing future maintenance cost. v2 tracks them separately.

| Measure | Meaning | Direction |
|---|---|---|
| **Delivery effort** | Estimated implementation work, including tests and migration work | Nonnegative |
| **Architecture delta** | Change in ongoing maintenance burden after implementation | Signed: negative simplifies, positive adds burden |

Negative architecture delta never makes gross delivery effort disappear. Both values remain visible in every assessment.

The CLI owns all aggregation and ceiling arithmetic. Agents estimate individual work items and finding deltas; they never emit totals, ceilings, or budget status. The sole aggregate estimate from an agent is the first reviewer's independent baseline estimate used to detect baseline inflation or understatement; it is an input to CLI comparison, not a computed budget result.

### 3.1 Delivery effort points

The plan author scores each implementation work item with a small relative scale:

| Points | Work shape |
|---:|---|
| 1 | Localized change following an existing pattern |
| 2 | Multi-file change within one subsystem |
| 3 | Cross-subsystem contract, API, or context threading |
| 5 | New abstraction, persistence change, external platform, or concurrency boundary |
| 8 | Major migration or unresolved technical uncertainty |

Tests belong to the work item they validate. They are not scored separately, because separate scoring would incentivize omitting tests to make a plan appear cheaper.

The point total is intentionally coarse. The durable value is the explicit comparison between the initial plan, reviewer-requested deltas, and the current forecast.

### 3.2 Baseline and ceilings

Let:

- `B0` = immutable initial effort baseline, computed by summing the initial plan work items.
- `B` = governing baseline, initialized to `B0` and changeable only by a recorded human decision.
- `I` = first reviewer's independent estimate of the same initial scope.
- `W` = current effort, computed by summing the current plan work items.
- `R` = pending required effort, computed by summing reviewer item deltas not yet reflected in the plan.
- `S` = standard ceiling.
- `N` = sum of the absolute values of individually eligible negative architecture claims.
- `D` = eligible architecture-debt credit: provisional during plan review, realized after implementation review.
- `E` = effective ceiling after bounded debt credit.
- `A` = absolute effort ceiling, which no debt credit can exceed.
- `P` = gross positive architecture delta across current work items and pending findings; negative items never offset it for threshold purposes.

The CLI computes `projectedEffort = W + R`. Stable work-item and review-item IDs prevent a correction already incorporated into `W` from also remaining in `R`.

Recommended defaults:

```text
M = minimumGrowthPoints
S = max(B + M, ceil(B * (1 + growthPercent / 100)))
D = min(ceil(B * maxDebtCreditPercent / 100),
        floor(N * debtTradeoffRatio))
A = max(S + M, ceil(B * (1 + absoluteGrowthPercent / 100)))
E = min(A, S + D)
positiveArchitectureLimit = max(minimumPositiveArchitecturePoints,
                                ceil(B * maxPositiveArchitecturePercent / 100))
baselineDisagreementThreshold = max(minimumBaselineDisagreementPoints,
                                    ceil(B0 * baselineDisagreementPercent / 100))
```

This gives ordinary review corrections a 25% allowance, with a minimum two-point allowance for small plans. Directly coupled simplification may authorize additional effort up to another 25% of baseline. `A` repeats the minimum-point floor above `S`, so small plans retain usable debt credit: for `B = 4`, `S = 6`, `D <= 1`, `A = 8`, and `E` may reach 7. Gross effort above `A` always requires a human decision regardless of claimed debt reduction.

These are defaults, not universal constants. Projects may configure the percentages and exchange ratio (§7).

### 3.3 Frozen baseline and baseline disputes

Before the first reviewer invocation, the CLI parses the plan work-item table, computes `B0`, and records it in run state. Agents may revise work items but may not rewrite `B0`. A human-approved baseline change updates governing `B` while preserving `B0` and the decision history.

The first reviewer provides `I`, confidence, and evidence. The reviewer does not classify the disagreement or calculate percentages or ceilings. The CLI raises `baseline_disputed` when `abs(I - B0) >= baselineDisagreementThreshold` and deterministically labels the direction `understated` when `I > B0` or `inflated` when `I < B0`; otherwise it records `aligned`.

Material disagreement in either direction routes to a human:

- **Understated:** increase `B`, narrow scope, or retain `B` and accept that required findings may immediately exceed `S`.
- **Inflated:** lower governing `B`, retain the original estimate with justification, or request a new author estimate.

This prevents both accidental underestimation and deliberate baseline inflation from silently creating scope headroom. The reviewer may contest the baseline but may never modify it.

### 3.4 Surface snapshot

Each initial plan also records a non-scoring audit snapshot:

- Number of affected subsystems.
- Expected production files changed or added.
- New persistent schemas or migrations.
- New external/platform boundaries.
- New shared abstractions or public contracts.

These counters expose obvious score manipulation but do not mechanically determine points. File count and line count are poor cost measures and can penalize good decomposition.

---

## 4. Architecture-debt credits

### 4.1 Eligible simplification

A negative architecture delta is eligible for budget credit only when all of the following hold:

- The work is directly coupled to a required plan change.
- It operates on the same subsystem, execution paths, or contracts already being changed.
- It removes or consolidates existing implementations, states, abstractions, or change points.
- The reviewer describes a concrete simpler post-state.
- Product scope does not expand.
- A cheaper minimal-compliant alternative is documented for comparison.

Good evidence includes fewer independent write paths, one source of truth replacing several copies, deletion of an obsolete abstraction, or one invariant-enforcing seam replacing repeated path-specific checks.

Adding a new abstraction is not inherently debt reduction. It earns credit only when the resulting system has fewer independent concepts or future change points.

Architecture points use the same coarse magnitude as effort, but describe maintenance impact rather than work:

| Delta | Typical evidence |
|---:|---|
| -1 | Remove a local duplicate, dead branch, or redundant state |
| -2 | Consolidate parallel implementations within one subsystem |
| -3 | Replace cross-path logic with one authoritative contract or invariant |
| -5 | Retire a major persisted, external, or subsystem-level burden; exceptional and normally human-reviewed |

Positive values use the same magnitudes for newly introduced maintenance burden. The score is based on concrete before/after change points, not lines deleted or an assertion that the result is "cleaner."

### 4.2 Coupling classes

Every proposed debt-reducing change is classified:

| Coupling | Meaning | Routing |
|---|---|---|
| `intrinsic` | Inseparable from the feature or consolidates the exact paths already being modified | Eligible for bounded credit |
| `adjacent` | Nearby improvement with independent value | Human approval or defer |
| `unrelated` | Standalone debt work outside the requested outcome | Defer; cannot block plan readiness |

The reviewer may not create standalone blocking debt findings. Adjacent and unrelated observations belong in a nonblocking follow-up section of the review artifact.

### 4.3 Required comparison

Any proposal claiming debt credit must show the trade explicitly:

```yaml
minimal_compliant_fix:
  effort_delta: 2
  architecture_delta: 0

proposed_consolidation:
  effort_delta: 4
  architecture_delta: -3
  coupling: intrinsic
  before: five independent proposal construction paths
  after: one invariant-enforcing proposal constructor
```

This prevents the reviewer from presenting a broad refactor as the only valid implementation. The human or configured policy can see that two extra effort points buy three points of maintenance simplification.

### 4.4 Credit guardrails

- Plan-time credit requires evidence-supported architectural reduction and remains provisional until §4.5 reconciliation; reviewer intent alone earns no credit.
- Credit may increase `E`; it never reduces the displayed current effort forecast.
- Credit cannot exceed `maxDebtCreditPercent` or the absolute effort ceiling.
- Negative architecture items are tracked separately from `P`; they cannot hide gross positive burden elsewhere in the plan.
- A single positive architecture item at or above `singleArchitectureReviewPoints`, or cumulative `P` above `positiveArchitectureLimit`, routes to a human even when delivery effort is within budget.
- Security, correctness, and acceptance requirements remain findings even when they exceed every ceiling. Budget changes routing, not visibility.

### 4.5 Post-implementation credit reconciliation

Plan-time debt credit is provisional. Each credited item gets a stable `creditClaimId`, claimed architecture delta, target phase, and before/after evidence. The CLI provides the claims relevant to the reviewed phase to `src/templates/reviewer-commit.md` and `reviewer-commit-continued.md`.

The implementation reviewer classifies each claim:

| Realization | Meaning |
|---|---|
| `realized` | The promised simpler post-state exists; the full planned credit is retained |
| `partial` | Some simplification landed; reviewer emits the realized per-claim architecture delta and evidence |
| `not_realized` | The credited consolidation/removal did not land; credit becomes zero |

The reviewer evaluates claims individually and does not aggregate credit or recompute ceilings. The CLI derives realized credit and budget status. If a shortfall would put completed or remaining work above `E`, the run pauses before the next phase or final completion and asks the human to restore the promised simplification, approve the higher burden/budget, reduce remaining scope, or abort. Reconciliation must not automatically create tangential remediation work.

Commit-review prompts also receive the prior human debt decisions so an explicitly waived or reduced claim is evaluated against the approved post-state rather than its superseded original wording.

---

## 5. Review convergence policy

Budget governance limits aggregate growth. A convergence policy limits repeated rediscovery.

### 5.1 Initial review

The first review is the one exhaustive pass over all material dimensions. The reviewer must:

- Assess the plan's baseline effort, current forecast, and surface snapshot.
- Surface all known material blockers rather than deliberately saving issues for later rounds.
- Classify each finding by requirement relationship and expected effort/architecture delta.
- Recommend the lowest-complexity adequate correction.
- Supply complete item deltas so the CLI can route immediately when required corrections exceed the approved ceiling.

The reviewer may contest an unrealistic baseline, but may not increase or decrease it. Only a human decision changes the approved allowance.

### 5.2 Continued reviews

Subsequent reviews are closure reviews, not fresh exhaustive reviews. They primarily:

- Mark prior findings `addressed`, `partially_addressed`, or `still_open`.
- Detect regressions introduced by the revision.
- Verify updated effort and architecture deltas.
- Honor the deferred-finding and accepted-risk ledger supplied in the continued-review prompt.

A new blocking finding after round one is allowed only when it is:

- Introduced by a specific changed plan hunk and directly causes a named requirement, acceptance, security, data-loss, correctness, reliability, or operability failure.
- A critical late-discovered security, data-loss, or correctness issue that cannot responsibly be deferred, even though it predates the revision. This exception always routes directly to the human; it cannot silently restart the automatic loop.

For the first case, the verdict item must include `introducedBy` with the reviewed commit range, exact plan diff hunk, and a causal explanation. "Made relevant by the revision" without a cited changed contract is not sufficient. The CLI validates that the cited hunk belongs to the plan diff already appended to `reviewer-plan-continued.md`.

For the critical exception, the item must include `lateDiscovery: "critical_safety"` and evidence. A pre-existing ordinary completeness gap missed in round one is nonblocking follow-up, not a new automatic correction cycle.

Deferred findings and accepted risks have stable decision IDs and finding fingerprints. The continued-review prompt includes their title, rationale, decision, and scope. Re-raising one as blocking is prohibited unless the reviewer supplies `newEvidence`, identifies the prior decision ID, and explains why the approved tradeoff no longer applies.

Newly noticed adjacent hardening, polish, speculative risk, or unrelated debt is recorded as nonblocking follow-up. It does not cause another plan revision.

### 5.3 Materiality and lowest-cost correction

Review findings must state the user-visible or system-level failure they prevent. "Completeness" by itself is not sufficient justification.

When several corrections satisfy the requirement, the reviewer recommends the lowest-effort adequate option first. A more expensive debt-reducing alternative may be offered with the comparison required by §4.3.

### 5.4 Readiness routing

Plan-review readiness becomes operationally distinct:

| Readiness | Meaning | Route |
|---|---|---|
| `ready` | No required corrections | Complete review |
| `ready_with_corrections` | Only low-risk mechanical corrections remain; reviewer verification is unnecessary | One final author correction pass, then complete without re-review |
| `not_ready` | Material correction requires reviewer verification | Author correction, then closure review |

`ready_with_corrections` is valid only when all items are `auto_fix`, their combined `effortDelta <= 1`, every `architectureDelta = 0`, and projected effort remains within the effective ceiling `E`. The CLI validates these conditions and includes that final point in cumulative gross effort. If any condition fails, the verdict is normalized to `not_ready` or routed to the human according to the computed budget result.

If a `ready_with_corrections` item requires reviewer verification, the verdict is contradictory and must be `not_ready`. Any semantic `human_required` item routes to the human regardless of readiness.

The existing iteration limit remains a backstop for unresolved `not_ready` cycles, not the primary cost control.

### 5.5 Application to implementation review

Implementation review does not get a second effort baseline or independent budget. It inherits the approved plan work-item ledger and governing budget. The implementation author/reviewer loop is already more naturally bounded than plan review: it operates on a concrete diff, quality gates provide objective feedback, and `src/templates/author-process-impl-review.md` forbids structural plan changes.

Implementation findings are classified by their relationship to approved scope:

| Finding class | Meaning | Route |
|---|---|---|
| `implementation_defect` | Bug, regression, missing test/error handling, or failure to implement an approved work item | Fix normally; record effort variance but never suppress correctness to fit budget |
| `plan_defect` | The approved design itself is incomplete or incorrect | Human gate; amend/re-review the plan when the correction changes its design or budget |
| `scope_expansion` | New requirement, architecture enhancement, or subsystem not approved by the current phase | Human scope decision; never automatic implementation-review work |
| `pre_existing` | Unrelated issue that existed before the phase diff | Nonblocking follow-up unless it is a critical safety issue |

For implementation review, `scopeClass` uses this four-value enum instead of the plan-review enum in §6.2. `protocol validate` applies the appropriate enum from the recorded phase context; generic `ReviewerVerdict` consumers may accept the union but must not mix the two classifications in one review.

The implementation reviewer must choose the first applicable class and cite the plan work-item ID or code diff supporting it. A review fix that introduces a new public API, persistence schema, external dependency, subsystem, or structural plan change is presumptively `plan_defect` or `scope_expansion`, not ordinary `auto_fix` work.

Continued implementation reviews use the same convergence protections as §5.2:

- Re-evaluate prior findings against the fix diff.
- Require an exact introducing code hunk for any new ordinary blocker.
- Inject and honor deferred / accepted-risk decisions.
- Route critical late safety discoveries directly to a human.
- Record unrelated pre-existing observations as follow-up rather than extending the phase.

Implementation `ready_with_corrections` is intentionally lighter than plan budgeting: it permits one final author pass without reviewer re-entry only when there is at most one P2 `implementation_defect`, the fix is mechanical, it changes no API/schema/dependency/architecture boundary, and all quality gates pass afterward. Otherwise the verdict follows the normal fix/re-review route.

Plan-time architecture credit remains reconciled through §4.5. Implementation review may report additional simplification as telemetry, but it cannot mint new debt credit after plan approval; a material refactor first requires a plan/budget decision.

v2 initially records implementation-review telemetry without effort enforcement:

- Review/fix cycles per phase.
- Review-originated commits and quality-gate reruns.
- Files, subsystems, APIs, schemas, and dependencies added after the first review.
- Finding counts by the four classes above.
- Plan amendments originating from implementation review.

A separate implementation-review budget is reconsidered only if this telemetry shows recurring scope ratcheting. Until then, approved-plan scope plus diff-causal convergence is the governing model.

---

## 6. Contracts and persistence

### 6.1 Plan template

Generated plans add a required section:

```markdown
## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | ... | 3 | 0 | - | - | ... |
| W2 | Consolidate ... | 4 | -3 | DC0 (`intrinsic`) | - | ... |

### Surface Snapshot

- Subsystems: 4
- Production files: 12
- Persistent/external boundaries: 1
```

Work-item IDs are stable across revisions. The CLI sums the table to establish `B0` and later `W`; the author does not write totals, ceilings, or status into the plan. A negative architecture row requires a debt claim, coupling class, minimal-compliant comparison, and target implementation phase. Revision authors add, remove, or rescore rows with rationale, while run state preserves the original parsed table and baseline.

`Addresses` is a comma-separated list of stable review-item IDs incorporated into that row. When revising existing work, the author adds the finding ID to the affected row; when adding work, the new row carries it. The CLI removes a finding from pending `R` once its ID appears in at least one current `Addresses` cell, preventing the same effort from being counted in both `W` and `R`. This accounting linkage does not declare the finding resolved: the closure reviewer still marks it `addressed`, `partially_addressed`, or `still_open`. At verdict-recording time, any finding marked `partially_addressed` or `still_open` re-enters `R` for its remaining effort delta regardless of `Addresses`, preventing an unscored or incomplete author claim from suppressing projected effort.

### 6.2 Reviewer protocol

Apart from the independent baseline assessment in the first review, the reviewer emits only per-item estimates and classifications. It never emits aggregate budget values:

```json
{
  "readiness": "not_ready",
  "baselineAssessment": {
    "independentEffortEstimate": 16,
    "confidence": "medium",
    "reason": "Initial work items match the observed implementation surfaces"
  },
  "creditAssessments": [
    {
      "creditClaimId": "DC0",
      "eligibility": "eligible",
      "coupling": "intrinsic",
      "reason": "Consolidates the paths already modified by W2"
    }
  ],
  "items": [
    {
      "id": "P1.1",
      "title": "Consolidate proposal construction",
      "action": "auto_fix",
      "scopeClass": "acceptance_required",
      "effortDelta": 4,
      "architectureDelta": -3,
      "coupling": "intrinsic",
      "estimateConfidence": "medium",
      "creditClaim": {
        "creditClaimId": "DC1",
        "targetPhase": "phase-2",
        "minimalAlternativeEffortDelta": 2,
        "minimalAlternativeArchitectureDelta": 0,
        "before": "five independent proposal construction paths",
        "after": "one invariant-enforcing proposal constructor"
      },
      "reason": "..."
    }
  ]
}
```

For plan review, the item contracts are:

| Field | Values / rule |
|---|---|
| `scopeClass` | `acceptance_required` \| `risk_reduction` \| `polish` |
| `effortDelta` | Integer `>= 0`; incremental delivery work requested by this finding |
| `architectureDelta` | Signed integer maintenance impact |
| `coupling` | `intrinsic` \| `adjacent` \| `unrelated`; required when architecture delta is negative |
| `estimateConfidence` | `low` \| `medium` \| `high`; calibration/display only, never changes a ceiling |

The initial-only `baselineAssessment` contract is:

| Field | Values / rule |
|---|---|
| `independentEffortEstimate` | Integer `>= 0`; an independent estimate of the initial stated scope, not a recomputation of ceilings |
| `confidence` | `low` \| `medium` \| `high`; display/calibration only |
| `reason` | Required; cites the work items or surfaces supporting the estimate |

The CLI records derived `baselineDirection` as `aligned`, `understated`, or `inflated`; it is not reviewer output.

`scopeClass` semantics and routing:

| Class | Meaning | Blocking behavior |
|---|---|---|
| `acceptance_required` | Direct failure of a stated requirement or acceptance criterion | May block in the initial review; continued reviews require the §5.2 diff/critical evidence |
| `risk_reduction` | Prevents a concrete, material correctness, security, data-loss, reliability, or operability risk | May block when material; speculative hardening is follow-up |
| `polish` | Readability, ergonomics, cosmetic consistency, or low-risk quality improvement | Nonblocking, except a qualifying §5.4 final correction |

`action` retains its semantic v1 meaning: `auto_fix` means the correction is mechanically derivable; `human_required` means the solution itself needs judgment. Budget routing is independent and takes precedence, so the CLI may require a human for an aggregate of otherwise `auto_fix` items without asking the reviewer to predict the arithmetic.

Confidence is never an enforcement multiplier. A low-confidence estimate remains subject to the same ceiling; it is retained for human interpretation and later calibration.

Continued-review-only evidence fields are also structural:

| Field | Rule |
|---|---|
| `introducedBy` | Required for a new ordinary blocking item: `{ commitRange, diffHunk, explanation }` |
| `lateDiscovery` | Only `critical_safety`; substitutes for `introducedBy` and forces a human route |
| `priorDecisionId` + `newEvidence` | Required when re-raising a deferred or accepted-risk finding |

Nonblocking follow-up observations remain in the review document and are excluded from `items`, so they do not accidentally drive another workflow cycle.

### 6.3 Deterministic derivation and `protocol emit`

`5x protocol emit reviewer` keeps repeated flat `--item '<json>'` flags; the item JSON accepts the fields above. Initial plan review adds:

```text
--baseline-assessment '{"independentEffortEstimate":16,"confidence":"medium","reason":"..."}'
```

Every author-proposed debt claim in the current plan also gets an individual plan-time assessment:

```text
--credit-assessment '{"creditClaimId":"DC0","eligibility":"eligible","coupling":"intrinsic","reason":"Consolidates the paths already modified by W2"}'
```

`eligibility` is `eligible` or `ineligible`. No provisional credit is counted until the reviewer marks that specific claim eligible. A debt claim introduced directly by a reviewer item is provisionally eligible by construction, subject to the same coupling and evidence validation; a claim introduced or changed by the author in a later revision requires assessment in the next closure review.

Implementation review adds one repeated flag per credited claim:

```text
--credit-realization '{"creditClaimId":"DC1","realization":"partial","realizedArchitectureDelta":-2,"evidence":"..."}'
```

No `--budget`, total, ceiling, or status flag exists. `5x protocol validate reviewer --run <id> --phase plan` loads run state, parses the current plan work-item table, de-duplicates incorporated finding IDs, and computes the budget result before recording. Commit-review validation similarly derives realized credit from claim realizations.

The recorded step is decorated by the CLI with deterministic output:

| Derived field | Values |
|---|---|
| `budgetBand` | `within_standard` \| `within_debt_allowance` \| `over_effective` \| `over_absolute` |
| `budgetAlerts[]` | `baseline_disputed` \| `positive_architecture_exceeded` \| `credit_unrealized` |
| `requiresHuman` | Boolean; true for `over_effective`, `over_absolute`, `baseline_disputed`, `positive_architecture_exceeded`, or any semantic `human_required` item. `credit_unrealized` alone is informational unless its recalculated budget band exceeds a ceiling or the unrealized claim magnitude is at least `singleArchitectureReviewPoints` |

The decorated record includes `B0`, governing `B`, `I`, `W`, `R`, `S`, `N`, provisional/realized `D`, `E`, `A`, `P`, baseline direction, and both configured thresholds. These values are CLI output, never reviewer-authored fields.

### 6.4 Run-state records

The control plane stores:

- Immutable initial budget baseline and surface snapshot.
- Original and current parsed work-item ledgers.
- Independent first-review baseline assessment and any human-adjusted governing baseline.
- Reviewer item deltas and CLI-derived budget results.
- Provisional debt claims and implementation-review realizations.
- Deferred-finding / accepted-risk decisions with stable IDs and fingerprints.
- Implementation-review scope classifications and telemetry from §5.5.
- Human budget/scope/risk decisions.
- Cumulative gross effort, gross positive architecture burden, and eligible debt reduction.

The baseline is control-plane state, not merely editable plan prose. Local SQLite is its v2 materialization (`200-overview.md` §3a).

### 6.5 Human gate

A budget, baseline, architecture-burden, or unrealized-credit gate presents explicit choices appropriate to the alert:

1. Increase the approved budget.
2. Trade or remove scope.
3. Defer the finding and accept the documented risk.
4. Abort the run.

The existing generic `continue-with-guidance` / `approve-override` choices may remain as CLI compatibility aliases, but the control-plane UI and recorded decision should preserve the specific tradeoff.

Deferral and accepted-risk decisions record a stable decision ID, finding fingerprint, approved scope, rationale, and evidence available at the time. Those records are injected into every later plan and implementation review prompt for the run.

---

## 7. Configuration

Proposed project-level defaults:

```toml
[reviewBudget]
mode = "advisory" # off | advisory | enforced
growthPercent = 25
minimumGrowthPoints = 2
debtTradeoffRatio = 1.0
maxDebtCreditPercent = 25
absoluteGrowthPercent = 50
baselineDisagreementPercent = 25
minimumBaselineDisagreementPoints = 2
maxPositiveArchitecturePercent = 25
minimumPositiveArchitecturePoints = 2
singleArchitectureReviewPoints = 5
```

- `mode = "off"` retains the v1 iteration-only behavior.
- `mode = "advisory"` is the initial default. The CLI computes and records every result but does not change routing, giving the point rubric a measured calibration period.
- `mode = "enforced"` applies deterministic budget and architecture gates. Eligible intrinsic debt credit expands `E` automatically within its configured cap; all larger tradeoffs remain human-owned.
- Personal/local overlays may tighten or relax defaults, following normal layered config rules.
- Human decisions recorded on a run override configured ceilings for that run only.

---

## 8. Migration and rollout

### 8.1 Existing plans

- Newly generated plans require `Delivery Budget`.
- An existing plan entering a new review run gets an author preflight that adds an estimate before the baseline is captured.
- A run already mid-review has no trustworthy original baseline. It remains on v1 routing unless the human explicitly opts in and approves a baseline; the CLI must not infer one from an already-expanded plan.

### 8.2 Staged rollout

1. **Advisory (initial default):** add template and prompt fields; deterministically record forecasts and deltas without changing routing.
2. **Measured:** compare forecast growth, iteration count, human escalations, and approved-plan outcomes across real plans.
3. **Enforced:** validate immutable baselines, ceiling arithmetic, budget-aware actions, and convergence routing in the protocol/skill layer.

Historical plan replay can calibrate the point rubric and defaults, but line-count reduction is not a success metric. The desired outcomes are fewer late review expansions, earlier human tradeoffs, and no increase in escaped material defects.

---

## 9. Acceptance criteria

- A plan review run records an immutable baseline before its first reviewer call.
- Author revisions cannot reset the baseline or erase prior budget decisions.
- Revised work items carry the review IDs they address, so incorporated effort moves from pending `R` into current `W` exactly once.
- Except for independent first-review estimate `I`, the reviewer never emits aggregate effort, ceilings, architecture totals, or budget status; the CLI derives them from stored state and item deltas.
- Small-plan absolute ceilings preserve nonzero room for eligible debt credit above `S`.
- Material first-review baseline disagreement in either direction routes to a human and cannot silently change governing `B`.
- Every blocking finding reports delivery and architecture impact.
- Mechanically derivable work that exceeds the effective ceiling routes to a human regardless of the reviewer's `auto_fix` action.
- Debt credit is available only for `intrinsic` simplification with a minimal-compliant comparison.
- Every provisional debt credit is reconciled by implementation review before dependent phases or run completion.
- Gross effort and the absolute ceiling remain visible and enforceable regardless of debt credit.
- Gross positive architecture burden has its own human threshold and cannot be netted against debt reduction.
- Implementation review inherits the approved plan budget and classifies findings as defects, plan defects, scope expansion, or pre-existing work rather than creating a second baseline.
- New implementation-review blockers are diff-causal; unrelated pre-existing findings remain nonblocking follow-up.
- Implementation `ready_with_corrections` permits only one mechanical P2 defect, no boundary change, passing quality gates, and no reviewer re-entry.
- Continued reviews cannot block on unrelated or merely adjacent debt observations.
- Continued-review prompts include deferred and accepted-risk decisions; re-raising one requires new evidence.
- Every new continued-review blocker cites the exact introducing diff hunk, except a critical late safety issue that routes directly to a human.
- `ready_with_corrections` is limited to at most one effort point, zero architecture delta, projected effort within `E`, one final author pass, and no reviewer re-entry.
- Human budget increases, scope trades, and accepted risks are durable run decisions.
- Budget governance never suppresses a material security, data-loss, correctness, or acceptance-criterion finding.

---

## 10. Open questions

- _TODO:_ calibrate point examples against a larger sample of completed plans and implementation actuals.
- _TODO:_ finalize the run-state table/step schema for work-item ledgers, debt claims, and deferred-finding fingerprints.
- _TODO:_ decide when measured advisory data is sufficient to recommend `mode = "enforced"` for new projects.
- _TODO:_ define the control-plane visualization for gross effort, approved ceiling, debt credit, and review-round growth.
