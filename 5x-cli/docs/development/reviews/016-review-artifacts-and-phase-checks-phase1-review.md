# Review: 016 Review Artifacts and Phase-Check Hardening - Phase 1

**Review type:** Implementation review
**Phase:** Phase 1 - Auto-Persist Review Artifacts
**Commit:** `adca23f5fa3776512ab240d84adeda4704768f20`
**Reviewer:** 5x reviewer
**Local verification:** Read plan/diff; ran `bun test 5x-cli/test/integration/commands/template-render.test.ts` and `bun test 5x-cli/test/integration/commands/invoke.test.ts`

## Summary

Most of Phase 1 is in place: `template render` and `invoke` now thread run context into the shared resolver, plan-review and implementation-review templates are distinguished, explicit `review_path` overrides still win, and the new integration coverage exercises the main happy paths.

**Readiness:** Not ready - one blocking correctness issue remains in plan-review filename generation.

## Blocking Issues

### P1 - Plan-review filenames are derived from absolute paths, not stable repo-relative identity

`generateReviewPath()` builds the plan-review basename with `planPath.replace(/[/\\]/g, "-")`, but `plan_path` is normally canonicalized to an absolute path for run-backed flows and is often passed as an absolute path in direct renders. That produces filenames like `-home-spalmer-dev-5x-engineer-5x-cli-docs-development-016-review-artifacts-and-phase-checks-review.md` instead of the planned repo-relative identity.

This violates the Phase 1 requirement for stable filenames based on the full plan basename relative to the repository. The generated path changes if the repo is moved, leaks machine-specific directory structure into artifact names, and does not match the documented `<plan-basename>-review.md` shape.

**Required correction:** Derive the plan-review basename from the plan path relative to `projectRoot` (or equivalent repository-root canonical form) before replacing separators, and add a test that passes an absolute `plan_path` and asserts the generated filename stays repo-relative.

## Assessment

- `src/commands/template-vars.ts` is the right seam for this feature and keeps `review_template_path` behavior unchanged.
- `src/commands/invoke.handler.ts` and `src/commands/template.handler.ts` correctly pass run/phase context into the shared resolver.
- Coverage is decent for render-time behavior and override precedence, but it currently misses the absolute-plan-path stability case that exposed the bug above.

## Addendum 2 - Re-review after fix commit `d1fe26cd0bbda8e64bb6850c65bbb1d5f9b9d9ff`

**Re-review type:** Fix verification
**Commit reviewed:** `d1fe26cd0bbda8e64bb6850c65bbb1d5f9b9d9ff`
**Local verification:** Read diff in `src/commands/template-vars.ts`; ran `bun test 5x-cli/test/integration/commands/template-render.test.ts --filter "auto-generates review_path for plan-review template when not explicitly provided|auto-generates review_path for implementation-review template with run context|fallback review_path uses run_id when phase is unavailable|explicit --var review_path overrides auto-generated value"`

The blocking filename issue is fixed. Plan-review filenames now derive from `relative(projectRoot, planPath)` before separator normalization, so absolute plan paths no longer leak machine-specific prefixes into generated artifact names and now collapse to stable repo-relative identities like `docs-development-...-review.md`.

No new blocking correctness issues found in the fix itself. Existing review-path generation behavior for implementation reviews and explicit `review_path` overrides remains unchanged.

One non-blocking gap remains: the integration coverage still does not assert the absence of an absolute-path prefix for the plan-review case, so this exact regression is now fixed in code but still under-specified in tests.

**Updated readiness:** Ready with corrections.

### Remaining Items

- **Minor:** Add a regression assertion or dedicated test that passes an absolute `plan_path` and verifies the generated plan-review filename is repo-relative rather than merely containing the relative suffix. Location: `test/integration/commands/template-render.test.ts`
