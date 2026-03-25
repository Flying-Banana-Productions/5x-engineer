# Phase 2 Review — extract base skill templates

## Verdict

- **Readiness:** ready_with_corrections

## Summary

- Architecture is directionally right: shared frontmatter parsing, shared base templates, and the OpenCode loader now consuming rendered base skills all match the Phase 2 design.
- Test coverage is reasonable for the new shared loader, and the targeted skill/harness unit suites pass.
- One blocking plan-compliance gap remains: native rendering is not byte-identical to the previous OpenCode `SKILL.md` content for `5x` and `5x-plan`, so Phase 2's completion gate is not yet met.

## What I checked

- Reviewed commit `8ce03018c2753c31d4e56d161ac8abde62a8b508`
- Reviewed Phase 2 in `docs/development/028-universal-harness.plan.md`
- Ran:
  - `bun test test/unit/skills/loader.test.ts`
  - `bun test test/unit/harnesses`
- Compared rendered native skill output against the pre-refactor OpenCode skill files

## Findings

### 1. Native skill output changed vs. legacy OpenCode content

- **Classification:** auto_fix
- **Severity:** major
- **Location:** `src/skills/base/5x/SKILL.tmpl.md:130`, `src/skills/base/5x/SKILL.tmpl.md:136`, `src/skills/base/5x/SKILL.tmpl.md:145`, `src/skills/base/5x-plan/SKILL.tmpl.md:137`, `src/skills/base/5x-plan/SKILL.tmpl.md:146`, `src/skills/base/5x-plan/SKILL.tmpl.md:154`

Phase 2 explicitly requires the `{ native: true }` render to be byte-identical to the existing OpenCode `SKILL.md` files. That is not true today.

Observed diffs:

- `5x`: native output changed wording/formatting from `Start a fresh task (omit \`task_id\`) and move on.` to `Start a fresh task_id and move on.` and also reflowed two native gotcha bullets.
- `5x-plan`: native output reflowed three recovery bullets relative to the legacy OpenCode file.

These are mechanical edits, but they break the phase completion gate and weaken confidence that the OpenCode harness is still consuming unchanged skill content after the extraction.

## Recommendation

- Restore byte-identical native output for `5x` and `5x-plan`, then rerun the same tests plus the native-render comparison before moving to Phase 3.

## Addendum — re-review after `0573fd0b591e02245b488d8634e40225c6e64a91`

### Updated verdict

- **Readiness:** ready

### What I re-checked

- Reviewed commit `0573fd0b591e02245b488d8634e40225c6e64a91`
- Re-ran:
  - `bun test test/unit/skills/loader.test.ts`
  - `bun test test/unit/harnesses`
- Re-compared current `{ native: true }` renders against the original deleted OpenCode skills from `8ce03018c2753c31d4e56d161ac8abde62a8b508^`

### Results

- `5x`: byte-identical parity restored
- `5x-plan`: byte-identical parity restored
- `5x-plan-review`: still byte-identical
- `5x-phase-execution`: still byte-identical

### R1 status

- **Resolved.** Native-render parity now holds for all four extracted base skills, satisfying the Phase 2 completion gate.

### New issues introduced by the fix

- No new blocking issues found.
- I did notice a minor invoke-branch wording duplication in `src/skills/base/5x-plan/SKILL.tmpl.md` (`"instructions to follow the instructions to follow the template format"`), but this does not affect native parity, OpenCode behavior, or the stated Phase 2 completion gate.

### Assessment

- Phase 2 is now complete and ready for Phase 3.
