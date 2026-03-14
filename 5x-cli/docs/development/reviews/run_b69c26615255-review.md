# Review: 019 Orchestrator Improvements - Phase 1

**Review type:** Implementation review
**Scope:** Commit `d66780b87e44fea08269f23b2a3a1f38607574d0` (and follow-on commits, none present) against `docs/development/019-orchestrator-improvements.md` Phase 1
**Reviewer:** Staff engineer
**Local verification:** Read plan/diff; ran `bun test test/unit/config-layering.test.ts test/unit/config.test.ts test/unit/commands/invoke.test.ts` and `bun test test/integration/commands/run-init-subproject.test.ts test/integration/commands/config-layering-integration.test.ts`

## Summary

Phase 1 is implemented cleanly and matches the plan intent. Config loading now normalizes `paths.*` to absolute values across both single-source and layered entry points, downstream callers were updated to rely on that contract, and the unit/integration coverage exercises the key repo-root and sub-project cases.

**Readiness:** Ready - Phase 1 acceptance criteria met; no blocking issues found.

## Strengths

- `src/config.ts` applies the absolute-path contract at the right architectural seam, keeping callers simple and consistent.
- The change correctly distinguishes raw config resolution against each config file directory from post-parse default resolution against workspace/project root.
- Test coverage is appropriately layered: schema/unit expectations updated, `loadConfig()` normalization added, and the sub-project `run init` flow is covered end to end.

## Production Readiness Blockers

None.

## High Priority (P1)

None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] No blocking correctness, architecture, security, performance, operability, or test-strategy issues found for Phase 1.

**P1 recommended**
- [x] Phase 1 is ready to advance to the next phase.

## Addendum (2026-03-14) - Phase 2 review

### What's Addressed

- `src/templates/loader.ts` cleanly adds `variable_defaults` parsing/rendering, validates frontmatter shape, and keeps explicit vars authoritative.
- Bundled author templates now declare `user_notes: ""`, and the new loader tests cover parse, override, and missing-var behavior well for bundled templates.
- Docs in `docs/development/016-review-artifacts-and-phase-checks.md` explain syntax, validation, and precedence clearly.

### Remaining Concerns

- **P1.1 - Stale prompt overrides bypass the new defaults**  
  **Action:** `auto_fix`  
  **Why it matters:** normal `template render` / `invoke` flows are disk-first and prefer `.5x/templates/prompts/*`. Existing initialized repos with pre-Phase-2 prompt copies still require `user_notes`, so the new optional-default behavior does not actually reach those users unless they manually resync templates. I reproduced this with an override copy of `author-next-phase.md` that omits `variable_defaults`; `renderTemplate("author-next-phase", { plan_path: "p", phase_number: "1" })` still throws `missing required variables: user_notes`. Add a compatibility path for known bundled templates (similar to the existing `step_name` fallback) or otherwise ensure stale scaffolded prompts inherit the new defaults.  
  **Location:** `src/templates/loader.ts` / prompt override path used by `src/commands/template.handler.ts` and `src/commands/invoke.handler.ts`

### Assessment

- **Readiness:** Ready with corrections - core implementation is sound, but rollout is incomplete for existing disk-overridden prompt templates.

## Addendum (2026-03-14) - R1 resolution review

### What's Addressed

- R1 is resolved. `5x upgrade` now distinguishes stale stock prompt templates from customized ones by comparing template bodies, auto-updates stock copies with outdated frontmatter, and preserves customized copies with an explicit warning telling operators how to refresh safely.
- The fix is applied at the upgrade seam (`src/commands/init.handler.ts` + `src/commands/upgrade.handler.ts`), which matches the rollout problem identified in the prior review instead of adding more loader-side fallback complexity.
- Coverage is sufficient: unit tests exercise create/skip/update/customized/force paths, and integration tests verify both the auto-update path and the warning-only path in the CLI workflow.

### Remaining Concerns

- None.

### Assessment

- **Readiness:** Ready - the previous rollout gap for existing scaffolded prompt overrides is adequately addressed.

## Addendum (2026-03-14) - Phase 3 review

### What's Addressed

- `skipQualityGates` is wired into schema parsing and the unknown-key allowlist in `src/config.ts`.
- `runQuality()` now accepts an injected `warn` sink, and the empty-gates warning path is covered at both unit and integration levels.
- The new integration test exercises stderr/stdout behavior for the empty-gates paths, which matches the plan's test-tier guidance.

### Remaining Concerns

- **P0.1 - `skipQualityGates` disables real gates, not just the no-op case**  
  **Action:** `auto_fix`  
  **Why it matters:** Phase 3 is explicitly about disambiguating the empty-gates no-op case. The plan says non-empty `qualityGates` must execute normally, unchanged. Current logic returns early whenever `skipQualityGates` is true, so a repo with configured gates silently skips them and reports `{ passed: true, results: [], skipped: true }`. That is a correctness and safety regression, and the docs now codify the wrong behavior for the `true + non-empty` case.  
  **Location:** `src/commands/quality-v1.handler.ts:180`, `docs/development/016-review-artifacts-and-phase-checks.md:274`

### Assessment

- **Readiness:** Not ready - the implementation changes runtime semantics beyond the approved phase and can silently bypass configured quality gates.

## Addendum (2026-03-14) - Phase 3 R1 resolution review

### What's Addressed

- R1 is resolved. `runQuality()` now limits the `skipQualityGates` early-return to the empty-gates case, so configured quality gates always execute normally.
- The docs table now matches the intended semantics for `skipQualityGates = true` with non-empty `qualityGates`.
- Verification is adequate: the new unit test covers the non-empty-plus-skip path, and the Phase 3 test suite passes locally.

### Remaining Concerns

- None.

### Assessment

- **Readiness:** Ready - Phase 3 now matches the approved plan and no blocking issues remain.

## Addendum (2026-03-14) - Phase 4 review

### What's Addressed

- `protocol validate author` now has the right surface area: `--plan` and `--no-phase-checklist-validate` are wired into `authorCmd`, and the checklist gate runs only for author `result: "complete"`.
- The implementation correctly handles explicit-plan missing-file errors and the incomplete-checklist path, and the unit/integration coverage is broad overall.
- Docs in `docs/development/016-review-artifacts-and-phase-checks.md` explain the new flags and error codes clearly.

### Remaining Concerns

- **P1.1 - Explicit `--phase` still fails open when plan comes from `--run`**  
  **Action:** `auto_fix`  
  **Why it matters:** the approved Phase 4 contract says explicit `--phase` should fail closed with `PHASE_NOT_FOUND` when the phase is absent in the parsed plan. Current logic only treats `--plan` as explicit input. If the user passes `--run <id> --phase <bad-phase>` and the run maps to a valid plan, missing phase lookup silently skips instead of raising `PHASE_NOT_FOUND`. That violates the plan's explicit-input behavior and leaves a real validation gap. Tests also miss this exact scenario.  
  **Location:** `src/commands/protocol.handler.ts:180`

### Assessment

- **Readiness:** Ready with corrections - the core checklist gate is solid, but explicit `--phase` semantics do not fully match the approved fail-closed contract.

## Addendum (2026-03-14) - Phase 4 R1 resolution review

### What's Addressed

- R1 is resolved. Once a plan is resolved, an explicit `--phase` now fails closed with `PHASE_NOT_FOUND` regardless of whether the plan came from `--plan` or `--run` auto-discovery.
- The added integration coverage closes the exact gap from the previous review, and the repaired E2E test removes a false-positive path that had been masking the bug.
- Local verification passed for the protocol checklist unit and integration suites.

### Remaining Concerns

- None.

### Assessment

- **Readiness:** Ready - Phase 4 now matches the approved checklist-gate contract and no blocking issues remain.

## Addendum (2026-03-14) - Phase 5 review

### What's Addressed

- Step 3 now relies on the CLI-derived `review_path` contract correctly: the explicit `--var review_path=...` is removed, and `REVIEW_PATH` is recovered from the render output before later reuse.
- Step 5 likewise stops redundantly passing `review_path` into `author-process-impl-review`, which matches the Phase 2 auto-default behavior.
- Step 2 now documents the `skipped: true` quality outcome and routes it forward as an intentional skip rather than an implicit failure.

### Remaining Concerns

- None.

### Assessment

- **Readiness:** Ready - the skill updates match the approved Phase 5 changes, and the existing skill-content suite still passes.
