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

- `B` = initial author effort forecast, captured before the first review.
- `S` = standard ceiling.
- `C` = verified, eligible architecture-debt credit.
- `E` = effective ceiling after bounded debt credit.
- `A` = absolute effort ceiling, which no debt credit can exceed.

Recommended defaults:

```text
S = max(B + 2, ceil(B * 1.25))
C = min(ceil(B * 0.25), verifiedDebtReduction * 1.0)
E = min(A, S + C)
A = ceil(B * 1.50)
```

This gives ordinary review corrections a 25% allowance, with a minimum two-point allowance for small plans. Directly coupled simplification may authorize additional effort up to another 25% of baseline. Gross effort above 150% always requires a human decision regardless of claimed debt reduction.

These are defaults, not universal constants. Projects may configure the percentages and exchange ratio (§7).

### 3.3 Frozen baseline

The CLI records `B` and the derived ceilings in run state before the first reviewer invocation. Agents may update the current forecast but may not rewrite the baseline. A human-approved budget increase is recorded as a decision layered over the baseline, preserving the original estimate and the audit trail.

The first reviewer may declare the estimate unrealistic. If the corrected forecast remains within `S`, correcting the current forecast is ordinary `auto_fix` work. If required scope exceeds `S`, the first review escalates immediately; it does not silently establish a larger baseline.

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

- Credit is based on verified architectural reduction, not on reviewer intent.
- Credit may increase `E`; it never reduces the displayed current effort forecast.
- Credit cannot exceed `maxDebtCreditPercent` or the absolute effort ceiling.
- Positive architecture delta must be reported and justified; it cannot be hidden by unrelated negative items elsewhere in the plan.
- Security, correctness, and acceptance requirements remain findings even when they exceed every ceiling. Budget changes routing, not visibility.

---

## 5. Review convergence policy

Budget governance limits aggregate growth. A convergence policy limits repeated rediscovery.

### 5.1 Initial review

The first review is the one exhaustive pass over all material dimensions. The reviewer must:

- Assess the plan's baseline effort, current forecast, and surface snapshot.
- Surface all known material blockers rather than deliberately saving issues for later rounds.
- Classify each finding by requirement relationship and expected effort/architecture delta.
- Recommend the lowest-complexity adequate correction.
- Escalate immediately if required corrections exceed the approved ceiling.

The reviewer may reject an unrealistic budget, but may not increase it. Only a human decision changes the approved allowance.

### 5.2 Continued reviews

Subsequent reviews are closure reviews, not fresh exhaustive reviews. They primarily:

- Mark prior findings `addressed`, `partially_addressed`, or `still_open`.
- Detect regressions introduced by the revision.
- Verify updated effort and architecture deltas.

A new blocking finding after round one is allowed only when it is:

- Introduced or made relevant by the revision.
- A direct failure of a named requirement or acceptance criterion.
- A material security, data-loss, or correctness risk that cannot responsibly be deferred.

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

If a `ready_with_corrections` item requires reviewer verification, the verdict is contradictory and must be `not_ready`. Any `human_required` item routes to the human regardless of readiness.

The existing iteration limit remains a backstop for unresolved `not_ready` cycles, not the primary cost control.

---

## 6. Contracts and persistence

### 6.1 Plan template

Generated plans add a required section:

```markdown
## Delivery Budget

- Baseline effort: 16 points
- Standard ceiling: 20 points
- Current forecast: 16 points
- Architecture delta: 0 points
- Effective ceiling: 20 points
- Absolute effort ceiling: 24 points
- Confidence: Medium

| Work item | Effort | Architecture delta | Rationale |
|---|---:|---:|---|
| ... | 3 | 0 | ... |

### Surface Snapshot

- Subsystems: 4
- Production files: 12
- Persistent/external boundaries: 1
```

Revision authors update the current forecast and work-item deltas, but not the frozen baseline.

### 6.2 Reviewer protocol

`ReviewerVerdict` gains a budget assessment and item-level impact. Exact schema naming remains an implementation detail, but the semantic shape is:

```json
{
  "readiness": "not_ready",
  "budget": {
    "baselineEffort": 16,
    "currentEffort": 23,
    "standardCeiling": 20,
    "effectiveCeiling": 24,
    "absoluteCeiling": 24,
    "architectureDelta": -4,
    "status": "within_debt_allowance",
    "confidence": "medium"
  },
  "items": [
    {
      "id": "P1.1",
      "title": "Consolidate proposal construction",
      "action": "auto_fix",
      "scopeClass": "acceptance_required",
      "effortDelta": 4,
      "architectureDelta": -3,
      "coupling": "intrinsic",
      "reason": "..."
    }
  ]
}
```

`human_required` expands beyond solution ambiguity. It also applies when the fix is mechanically known but requires exceeding an approved ceiling, trading scope, or accepting risk. This is a deliberate change from the v1 definition in `src/protocol.ts`.

Nonblocking follow-up observations remain in the review document and are excluded from `items`, so they do not accidentally drive another workflow cycle.

### 6.3 Run-state records

The control plane stores:

- Immutable initial budget baseline and surface snapshot.
- Each reviewer budget assessment.
- Author forecast updates.
- Human budget/scope/risk decisions.
- Cumulative gross effort and architecture delta.

The baseline is control-plane state, not merely editable plan prose. Local SQLite is its v2 materialization (`200-overview.md` §3a).

### 6.4 Human gate

An over-budget finding presents explicit choices:

1. Increase the approved budget.
2. Trade or remove scope.
3. Defer the finding and accept the documented risk.
4. Abort the run.

The existing generic `continue-with-guidance` / `approve-override` choices may remain as CLI compatibility aliases, but the control-plane UI and recorded decision should preserve the specific tradeoff.

---

## 7. Configuration

Proposed project-level defaults:

```toml
[reviewBudget]
enabled = true
growthPercent = 25
minimumGrowthPoints = 2
debtTradeoffRatio = 1.0
maxDebtCreditPercent = 25
absoluteGrowthPercent = 50
```

- `enabled = false` retains the v1 iteration-only behavior.
- Personal/local overlays may tighten or relax defaults, following normal layered config rules.
- Human decisions recorded on a run override configured ceilings for that run only.
- _TODO:_ decide whether the first release is advisory by default before enforcement becomes the default.

---

## 8. Migration and rollout

### 8.1 Existing plans

- Newly generated plans require `Delivery Budget`.
- An existing plan entering a new review run gets an author preflight that adds an estimate before the baseline is captured.
- A run already mid-review has no trustworthy original baseline. It remains on v1 routing unless the human explicitly opts in and approves a baseline; the CLI must not infer one from an already-expanded plan.

### 8.2 Staged rollout

1. **Advisory:** add template and prompt fields; record forecasts and deltas without changing routing.
2. **Measured:** compare forecast growth, iteration count, human escalations, and approved-plan outcomes across real plans.
3. **Enforced:** validate immutable baselines, ceiling arithmetic, budget-aware actions, and convergence routing in the protocol/skill layer.

Historical plan replay can calibrate the point rubric and defaults, but line-count reduction is not a success metric. The desired outcomes are fewer late review expansions, earlier human tradeoffs, and no increase in escaped material defects.

---

## 9. Acceptance criteria

- A plan review run records an immutable baseline before its first reviewer call.
- Author revisions cannot reset the baseline or erase prior budget decisions.
- Every blocking finding reports delivery and architecture impact.
- Mechanically derivable work that exceeds the effective ceiling routes `human_required`.
- Debt credit is available only for `intrinsic` simplification with a minimal-compliant comparison.
- Gross effort and the absolute ceiling remain visible and enforceable regardless of debt credit.
- Continued reviews cannot block on unrelated or merely adjacent debt observations.
- `ready_with_corrections` performs at most one final author pass and no reviewer re-entry.
- Human budget increases, scope trades, and accepted risks are durable run decisions.
- Budget governance never suppresses a material security, data-loss, correctness, or acceptance-criterion finding.

---

## 10. Open questions

- _TODO:_ calibrate point examples against a larger sample of completed plans and implementation actuals.
- _TODO:_ decide whether debt credit is advisory or automatically expands `E` in the first enforced release.
- _TODO:_ finalize `ReviewerVerdict` field names and whether budget fields are required globally or only for plan review.
- _TODO:_ decide whether nonblocking follow-up observations need a structured protocol field or remain review-artifact prose.
- _TODO:_ define the control-plane visualization for gross effort, approved ceiling, debt credit, and review-round growth.
