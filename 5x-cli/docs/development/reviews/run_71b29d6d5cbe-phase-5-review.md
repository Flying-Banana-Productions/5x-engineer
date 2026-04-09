# Review: Mixed-Mode Delegation Phase 5

**Review type:** commit 749663be58485c82dc2a9d7fb21ba783274db0a6
**Scope:** Phase 5 harness skill loader integration and follow-on state at HEAD
**Reviewer:** Staff engineer
**Local verification:** `bun test test/integration/commands/harness.test.ts -t 'mixed-mode skill rendering'` ✅ (5/5). Manual repro also confirmed `5x harness install opencode --scope project` does not refresh existing skill files after a delegation-mode config change unless `--force` is passed.

## Summary

Phase 5 wires mixed-mode render context into both bundled native harnesses, and fresh installs render the expected mixed author/reviewer delegation patterns. However, the implementation does not satisfy the plan's lifecycle-transition requirement for skills: after `5x.toml` changes, a normal reinstall leaves existing skill files stale because skill installs are still skip-on-exists unless `--force` is supplied.

**Readiness:** Not ready — mixed-mode skill transitions are incomplete without implicit skill refresh on reinstall.

## Strengths

- Plugin integration is minimal and consistent: both OpenCode and Cursor now derive a `SkillRenderContext` from resolved delegation config before skill install.
- Backward compatibility is preserved for fresh installs because loader APIs still default to all-native rendering when no context is provided.
- Integration coverage now exercises mixed-mode rendering for both bundled native harnesses.

## Production Readiness Blockers

None.

## High Priority (P1)

### P1.1 — Reinstall leaves skill content stale after delegation-mode changes

The plan explicitly calls for lifecycle-transition coverage where a native/native install is followed by a config change and a plain reinstall, after which installed skills must reflect the new mixed-mode delegation. That does not happen today. `opencodePlugin.install()` and `cursorPlugin.install()` pass the right render context into `listSkills(...)`, but `installSkillFiles()` still skips any existing `SKILL.md` when `force` is false, so a second `5x harness install` keeps the old content in place. The new integration test masks this by adding `--force` during the transition scenario instead of validating the required default reinstall behavior.

**Risk:** Harness assets drift from `5x.toml`; orchestrators keep following outdated delegation instructions after mode changes, causing the wrong delegation mechanism to run for a role.

**Requirement:** Reinstall must refresh managed skill files when rendered content changes due to delegation-mode config updates, without requiring `--force`; add an integration test that performs the config transition with a plain reinstall and verifies the installed skill content changes accordingly.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Refresh managed skill files on reinstall after delegation-mode config changes, and cover that default path with an integration test.

## Addendum (2026-04-09) — Follow-up on skill refresh fix

### What's Addressed

- The prior P1.1 issue is fixed: skill reinstall now refreshes changed `SKILL.md` content without requiring `--force`, and the lifecycle integration test now exercises the plain reinstall path.

### Remaining Concerns

- The fix broadened content-diff overwrite semantics from skills to the shared `installFiles()` helper, so a plain `5x harness install` now overwrites modified agent/rule files whenever bundled content differs. This regresses the existing force contract (`--force` required to overwrite existing files) and can silently discard local edits to managed harness assets outside the phase-5 skill-refresh scope.
