# Phase 4 Review — invoke-path skill content

## Verdict

- **Readiness:** ready_with_corrections

## Summary

- Phase 4 substantially fills in the invoke-path skill branches and adds focused unit coverage.
- The main blocker is in `5x-phase-execution`: the separate `5x template render reviewer-commit` call used to extract `review_path` does not propagate `--session $SESSION_ID`, so continued reviewer sessions can fail with `SESSION_REQUIRED` before the reviewer invoke runs.
- There is also a smaller plan-compliance/content-quality gap: the invoke-rendered `5x-plan-review` skill still tells users to "start fresh task," leaving native-path terminology in universal-harness output.

## What I checked

- Reviewed commit `b4a133a95642b7066ccbb1886cbd1946a5aeb733`
- Reviewed Phase 4 in `docs/development/028-universal-harness.plan.md`
- Inspected:
  - `src/skills/base/5x/SKILL.tmpl.md`
  - `src/skills/base/5x-plan/SKILL.tmpl.md`
  - `src/skills/base/5x-plan-review/SKILL.tmpl.md`
  - `src/skills/base/5x-phase-execution/SKILL.tmpl.md`
  - `test/unit/skills/invoke-content.test.ts`
- Ran:
  - `bun test test/unit/skills/invoke-content.test.ts`
  - `bun test test/unit/skills/loader.test.ts test/unit/harnesses/opencode-skills.test.ts`

## Findings

### 1. Missing session propagation in Phase 4b review-path extraction

- **Action:** auto_fix
- **Severity:** major
- **Location:** `src/skills/base/5x-phase-execution/SKILL.tmpl.md:274`

The invoke-path reviewer flow in `5x-phase-execution` does a separate `5x template render reviewer-commit` to extract `review_path`, but unlike the native branch and unlike `5x-plan-review`, it does not pass `${SESSION_ID:+--session $SESSION_ID}` to that render call.

That breaks the stated session-reuse model for re-reviews: when reviewer continuation is enabled, the render step itself can require `--session`/`--new-session` and fail with `SESSION_REQUIRED` before `5x invoke reviewer ... --session $SESSION_ID` is reached. This makes the documented invoke flow incomplete for multi-iteration review phases.

### 2. Invoke-rendered plan-review skill still uses native-path "task" wording

- **Action:** auto_fix
- **Severity:** minor
- **Location:** `src/skills/base/5x-plan-review/SKILL.tmpl.md:31`

The invoke-rendered `5x-plan-review` content still says `Empty diff after author "completes" = context loss → start fresh task`.

Phase 4's goal was usable invoke-path content with session-oriented delegation language. Leaving "task" wording in universal-harness output is misleading and suggests the conversion is not fully complete.

## Assessment

- Not ready to call Phase 4 fully complete as written, but issues are mechanical.
- Fix the missing `--session` propagation in the phase-execution review-path render and clean the leftover invoke-path wording, then proceed to Phase 5.
