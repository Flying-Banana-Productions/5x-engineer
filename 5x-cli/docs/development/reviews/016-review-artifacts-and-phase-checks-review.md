# Review: Review Artifacts and Phase-Check Hardening

**Review type:** `docs/development/016-review-artifacts-and-phase-checks.md`
**Scope:** Plan review for review-path defaults, quality-fix template split, author-status normalization, and phase-gate hardening
**Reviewer:** Staff engineer
**Local verification:** Repo read only; no code executed

## Summary

Solid direction overall: the plan targets real workflow friction and mostly fits the current architecture, especially by reusing shared template-variable resolution and protocol validation boundaries.

**Readiness:** Not ready - two design gaps need correction before implementation starts.

## Strengths

- Keeps changes close to existing seams: `template-vars.ts`, `protocol-helpers.ts`, bundled templates, and skill docs.
- Separates quality-fix prompting from review-fix prompting, which removes an obvious prompt/mental-model mismatch.
- Places legacy author-status normalization at the validation boundary, which minimizes downstream churn.
- Calls out concrete tests across unit and integration layers instead of relying only on skill-doc edits.

## Production Readiness Blockers

### P0.1 - Implementation review path generation is underspecified

**Risk:** Phase 1 says `src/commands/template-vars.ts` will auto-generate implementation review paths from `run-id + phase`, but the shared resolver currently receives neither run id nor phase. `reviewer-commit` also does not declare a `phase_number` variable, and `5x template render` has no `--phase` input. As written, the plan does not specify how the resolver can actually compute the proposed filename, or what should happen when `reviewer-commit` is rendered without `--run`.

**Requirement:** Update the plan to define the source of truth for phase identity in review-path generation, the required handler/API plumbing (`template render` and `invoke` inputs plus `ResolveAndRenderOptions`), and the fallback/error behavior when the needed context is unavailable.

### P1.1 - "Deterministic" plan-review filenames are not actually stable

**Risk:** The recommended plan-review shape includes `<date>-<full-plan-basename>-review.md`. That creates a different path when the same plan is reviewed on another day, which conflicts with the stated goals of persistence, stable filenames, and accumulating addenda in one document.

**Requirement:** Pick one stable identity for plan reviews and use it consistently. Either remove the date from the default filename or define a fixed, reproducible date source that does not change between review passes.

## High Priority (P1)

### P1.2 - Checklist verification should happen before recording `phase:complete`

The Phase 4 bullets say to run `5x plan phases` after recording `phase:complete`. If the checklist is still incomplete, the workflow has already written a misleading completion record. Reorder the gate so checklist verification happens before the completion record, or explicitly define a different audit event for "review passed but checklist mismatch".

## Addendum - Iteration 2 (2026-03-13)

Re-review complete. The three prior blockers are addressed in the revised plan.

**Readiness:** Ready

### Resolved in this revision

- **P0.1 closed:** Phase 1 now explicitly adds implicit `run_id` and `phase` injection during phase execution, and the design section defines the no-phase fallback to `<run-id>-review.md`. That gives the shared resolver a concrete source for implementation review-path generation.
- **P1.1 closed:** Plan-review filenames no longer depend on a date prefix. The plan now uses stable basename-derived identity and calls out collision handling for similarly named plans.
- **P1.2 closed:** Phase 4 now requires `5x plan phases` verification before recording `phase:complete`, and introduces `phase:checklist_mismatch` as the fail-closed audit event.

### Remaining assessment

No blocking design gaps remain. Scope, file touch list, and test plan are aligned with the stated behavior changes. This is ready for implementation.
