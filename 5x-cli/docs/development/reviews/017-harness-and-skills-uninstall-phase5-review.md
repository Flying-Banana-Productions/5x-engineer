# Review: Harness & Skills Uninstall Phase 5

**Review type:** commit `50f46e3682f9f353de4cde73de140f84b051c057`
**Scope:** Phase 5 `5x skills uninstall` changes in `src/commands/skills.handler.ts`, `src/commands/skills.ts`, `test/unit/commands/skills-uninstall.test.ts`, and `test/integration/commands/skills-install.test.ts`
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/commands/skills-uninstall.test.ts` - 11 passed; `bun test test/integration/commands/skills-install.test.ts` - 15 passed

## Summary

This phase is ready. The implementation matches the plan: `skills uninstall` supports `user`, `project`, and `all`, removes only known bundled skill files, preserves user-created content, cleans up empty directories, and exposes the expected JSON envelope and stderr progress output.

**Readiness:** Ready - Phase 5 behavior and coverage meet the plan without blocking gaps.

## Strengths

- `src/commands/skills.handler.ts` keeps the install and uninstall logic aligned by adding the same `startDir` / `homeDir` test seams to both paths, which fits the handler patterns already used elsewhere in the CLI.
- The uninstall flow deletes only known `SKILL.md` targets derived from `listSkillNames()`, then performs best-effort empty-directory cleanup, which matches the safety model in the implementation plan.
- Unit coverage exercises the important edge cases called out in the phase plan: mixed installed/not-installed state, custom install roots, empty-directory cleanup, invalid scope validation, and preservation of user-created files.
- Integration coverage verifies the externally visible contract end to end, including stderr summaries, `all` scope behavior, and JSON envelope shape for both compact and pretty output.

## Production Readiness Blockers

- None.

## High Priority (P1)

- None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [x] None.
