# Architecture approval carryover fix

## Contract and scope

Implementation consumes applicable architecture approvals already sealed into
`effectiveDecisions` on its binding. Plan and implementation share the P ceiling
and individual-threshold ID coverage rules. An earlier-snapshot aggregate approval
with empty ID lists remains applicable when no individual IDs require coverage.
Raw arithmetic remains unchanged; effective inherited governance records the
bound source run/snapshot and the suppressing decision ID separately.

The implementation review and credit reconciliation expose that distinction.
Implementation variance does not alter the approved ledger or mint credit.
Uncovered budget bands, burden, findings, and credit obligations remain enforced.

`revise_plan` is a gate-scoped, rationale-required implementation decision offered
for unresolved inherited budgets. It pauses for plan revision/review; it neither
changes the binding nor authorizes completion. It accepts no finding references
or claim adjustments. It does not implement the separate structural amendment
and rebinding lifecycle.

## Existing-run recovery

The original binding and unauthorized observation remain immutable. Prepare a
fresh review context and record the current verdict at the next unused iteration,
using the runtime context's required prior outcomes. The clean durable observation
can authorize normal completion; retrying the old iteration returns its old
stored result. Normal checklist, code freshness, and credit checks still apply.

Gate derivation uses the latest phase observation. Prompt projection repair
abandons a superseded notification without fabricating a decision. Schema v12
preserves prompt rows/context and adds the `superseded` abandonment reason.
An existing abort-only prompt for a still-open gate is superseded and refreshed
with the current actionable choices, preserving the original notification.
Recovery and retries must not create decisions or completion records implicitly.

## Asset-impact check

- **Document skeletons (`default-artifacts.ts`):** unaffected. Existing review
  sections describe findings/ranges/claims; approval provenance belongs to durable
  runtime context. No external-project plan-template maintenance checklist added.
- **Agent prompts:** update initial and continued implementation-review prompts
  and the review-fix author prompt to consume effective inherited governance.
  Next-phase author prompts already consume the shared runtime context. Plan and
  quality prompts do not decide implementation approval applicability.
- **Runtime context and native/invoke parity:** shared implementation context
  computes bound approval applicability and exposes suppressed-alert decision
  references on initial and continued sessions. Verify actual render/invoke
  handler parity, including author context.
- **Workflow skills:** phase-execution guidance covers raw/effective alerts,
  `revise_plan`, and fresh-review recovery in all delegation modes. Foundation,
  plan-authoring, and plan-review skills do not own this implementation route.
- **Installation/overrides/upgrade/harness synchronization:** bump modified prompt
  versions; preserve custom override behavior. Verify bundled fallback and
  force-refreshed installed prompts, plus harness-installed/synchronized skills.
  Operators must refresh effective workflow assets before recovery and surface
  any harness freshness warning.

## Verification

Regression coverage includes earlier approval through final-corrections binding,
P32 aggregate approval, raw-alert retention, approval growth/identity limits,
malformed approval rejection, unrelated effort enforcement, existing-gate
append-only recovery/replay, idempotent prompt cleanup, actionable revision
decisions, and migration preservation. Required acceptance checks:

```sh
bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts
bun run typecheck
bun run lint
bun test --concurrent --dots
```

Results:

- Lint and typecheck pass.
- Focused governance/schema/unit coverage: 359 pass.
- Implementation completion/governance integration coverage: 17 pass.
- Required installed/rendered asset acceptance suite: 28 pass.
- Full concurrent suite: 3,889 pass, one pre-existing failure at
  `test/integration/records/progress-resolution.test.ts:774`. That assertion
  expects `alpha.md (clean)` although the current plan-list display uses
  `local (clean)`. Reproduced independently on unchanged baseline `45375b9`.
- Read-only evaluation of the actual incident binding suppresses its P32 alert
  through decision `aaad78d4-0ecd-498b-83e6-f7a6483b8768`, preserving source
  snapshot `f3fb9d08-2353-443f-ac17-4b45b2772f22` and effective
  `requiresHuman: false`. The incident database and records were not modified.
