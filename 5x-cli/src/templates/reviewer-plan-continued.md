---
name: reviewer-plan-continued
description: Re-review a revised implementation plan
version: 7
variables: [plan_path, review_path, run_id, previous_review_commit, current_commit]
step_name: "reviewer:review"
variable_defaults:
  run_id: ""
  previous_review_commit: ""
  current_commit: ""
---

The plan at `{{plan_path}}` has been revised since your last review. Perform a
closure review of the prior findings; do not repeat the initial broad review.

## Context Since Last Review

- Previous review commit: `{{previous_review_commit}}`
- Current commit: `{{current_commit}}`

A `## Plan Diff Since Last Review` section is appended to this prompt with the actual diff of the plan file across that commit range. Read it first.

First check whether this prompt includes an appended
`## Plan-review governance context` block:

- **Context present:** use the closure-only governance rules below. Emit
  outcomes for exactly the IDs on its `Required prior-finding outcome IDs`
  line—no addressed, deferred, accepted-risk, unknown, or other IDs.
- **No context present:** this is the broad v1 fallback for mode off,
  `v1_compat`, or a plan without an active Delivery Budget. Re-review the plan
  broadly, surface both prior and newly discovered blocking issues in
  `items[]`, and omit `priorFindings[]`, `--prior-finding`, and `introducedBy`.
  The closure-only new-blocker and nonblocking-follow-up restrictions below do
  not apply on this fallback path.

When governance context is present, treat line numbers from prior findings as
potentially stale and re-anchor them against the current plan. Before
considering any new issue, emit exactly one top-level `priorFindings[]` outcome
for every listed required ID: **addressed**, **partially_addressed**, or
**still_open**. Only partially addressed or still-open required findings may be
repeated in `items[]`, exactly once and under the same stable ID; addressed
findings must be absent from `items[]`.

## Instructions

1. Read the updated plan at `{{plan_path}}` in full.
2. Read any new changes in referenced implementation files if the plan mentions them.
3. Walk through every prior finding and classify it against the new state before
   considering revision-causal issues.
4. Add a new ordinary blocker only when the appended plan-only diff proves the
   revision introduced it. The item must include `introducedBy` with the exact
   displayed commit range, one complete diff hunk (header plus changed lines),
   and an explanation of causality. If the displayed patch is truncated, use
   its omitted hunk headers and exact `git diff` command to inspect the same
   complete diff that CLI validation uses; never assemble a citation across
   hunks.
5. Write your updated assessment as a new **Addendum** section appended to `{{review_path}}`. Do not modify existing review content.
6. Re-check every plan-row `Addresses` value against still-open findings. Reuse each prior finding's stable ID when it remains partially addressed or open; assign a new ID only to a revision-causal finding, and never recycle or renumber IDs.

Follow the same issue classification and strict final-correction definition from
the initial prompt. Every repeated or new item still requires its item-level
scope/effort/architecture/confidence, concrete `failure`, and
`lowestCostCorrection`.

### Late findings and governing decisions

- A material pre-existing issue ordinarily missed by the initial review is not
  a new blocker. Put it in the review Markdown's **Nonblocking follow-ups**
  section, excluded from `items[]`.
- The only pre-existing late blocker exception is a correctness, security, or
  data-loss threat with `scopeClass` `acceptance_required` or `risk_reduction`.
  Mark it `lateDiscovery: "critical_safety"`, provide concrete
  `lateDiscoveryEvidence`, and classify it `human_required`; the CLI routes it
  directly to a human.
- Read every active deferred or accepted-risk entry in the appended governance
  context. Do not re-raise it unless the item cites the exact `priorDecisionId`
  and supplies material `newEvidence`; retain its finding ID and fingerprinted
  scope.
- Put adjacent hardening, polish, speculative risk, unrelated debt, and other
  ordinary missed issues in **Nonblocking follow-ups**, never `items[]`.

When present, the appended context states the pinned mode. In `enforced` mode
every closure rule above is a strict must and validation fails closed. In
`advisory` mode provide the same evidence for calibration, but violations are
diagnostics and v1 routing is preserved. Without the block, use the broad v1
fallback defined above.

### Continued Delivery Budget Assessment

- Do **not** emit `baselineAssessment` or `--baseline-assessment`; the independent baseline assessment is initial-review only.
- Emit complete per-item `scopeClass`, `effortDelta`, `architectureDelta`, `estimateConfidence`, `failure`, `lowestCostCorrection`, and negative-delta `coupling` for every remaining or valid new item.
- Emit `--credit-assessment` only for an author-ledger `DCn` that is new or changed since the last recorded review. A claim is unchanged only when its coupling, work-item architecture delta, target phase, minimal-compliant effort/architecture deltas, before, and after all match the previous ledger. The CLI carries unchanged assessments forward; do not re-emit every claim as a ritual.
- A credit assessment must name a persisted author `DCn` or a reviewer `creditClaim` introduced by this verdict. Do not invent author-side evidence. Item `creditClaim` remains reserved for claims introduced by that finding and must include the complete minimal-compliant comparison and non-empty before/after.
- Never emit reviewer-authored totals, routes, ceilings, status, or CLI-owned fields (`governance`, `reviewRoute`, `normalizedReadiness`, `gateCauses`, `budget`, `budgetBand`, `requiresHuman`, `B0`, `W`, `R`, `S`, `N`, `D`, `E`, `A`, `P`, `projectedEffort`, `baselineDirection`). The CLI derives aggregates and routes.

## Non-Interactive Execution

You are running as a delegated non-interactive workflow. Do NOT use any interactive tools (question, prompt, ask, confirm, etc.). If you need human judgment on an issue, classify it as `human_required` in your review items.


## Completion

CRITICAL: You MUST use `5x commit` (not `git commit`) to commit your review. The pipeline tracks commits via `5x commit` — using raw git commands will leave the commit unrecorded.

Write your updated review to `{{review_path}}` and commit the file:

    5x commit --run {{run_id}} --phase plan --files {{review_path}} -m "docs: update plan review for <plan name>"

Produce your structured verdict by running `5x protocol emit reviewer` with `--ready` or `--no-ready`, complete `--item` flags, and `--credit-assessment` only for new/changed claims. When governance context is present, add one repeatable `--prior-finding '{"id":"P1.1","status":"addressed"}'` for each ID in `Required prior-finding outcome IDs`, and limit `--item` flags to partial/open or valid new blockers. Without governance context, omit every `--prior-finding` and use the broad v1 item contract. Never pass `--baseline-assessment` on a continued review. Include the command's JSON output verbatim as your structured result. Do not wrap it in markdown fences.
