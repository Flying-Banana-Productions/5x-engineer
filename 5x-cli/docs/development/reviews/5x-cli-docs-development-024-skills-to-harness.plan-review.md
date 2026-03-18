# Review: Move Skills from Core to Harness Modules

**Review type:** docs/development/024-skills-to-harness.plan.md
**Scope:** Plan, referenced source, active tests, and active user/developer docs tied to skills ownership and harness install flow.
**Reviewer:** Staff engineer
**Local verification:** Not run

## Summary

Architecture direction is mostly right: OpenCode-specific skill content should live with the OpenCode harness, and the phase order (move first, delete later) is sound. But the plan is not yet executable as written because it removes an advertised CLI surface without resolving the product/migration decision, and it misses several active code/doc/test references that will break or go stale once `src/skills/loader.ts` and `5x skills` are deleted.

**Readiness:** not_ready — blocking product-surface and completeness gaps remain.

## Strengths

- Correct ownership shift: OpenCode-specific skill discovery paths belong with the OpenCode harness, not `src/skills/`.
- Good phase ordering: move assets/loader into the harness before deleting shared code.
- Test intent is directionally good: move loader/content tests with the loader and keep harness install coverage.

## Production Readiness Blockers

### P0.1 — Removing `5x skills` is a user-facing product break with no explicit migration decision

**Classification:** human_required

**Risk:** The plan treats `5x skills` removal as cleanup, but current product docs still advertise generic skill-only installs for non-OpenCode / agentskills.io-style consumers. Shipping this plan as-is would silently remove documented functionality and strand users who are not using the OpenCode harness.

**Requirement:** Make an explicit product decision before implementation:
- either keep a generic/manual skill-install path,
- or explicitly de-support it and add migration/breaking-change updates to README/help/init guidance.

**Evidence:**
- Plan removes the command outright: `docs/development/024-skills-to-harness.plan.md:24-27`, `99-109`
- README still documents generic installs: `README.md:121-127`, `241-264`, `390`

### P0.2 — The plan's change inventory is incomplete; active references will break or go stale

**Classification:** auto_fix

**Risk:** Phase 2 deletes `src/skills/loader.ts` and the `skills` command, but the plan does not enumerate several active references that must change. That leaves likely broken imports/tests plus stale user/developer instructions after the refactor.

**Requirement:** Add explicit tasks for at least:
- `test/integration/commands/harness.test.ts` import updates (`listSkillNames` still comes from `src/skills/loader.js`)
- `src/commands/init.handler.ts` post-init guidance
- active docs describing the old command/old plugin contract: `README.md`, `src/harnesses/README.md`, `src/harnesses/opencode/README.md`

Also tighten the regression gate from “no `5x skills` references remain” to “no active/runtime/user-facing references remain” so archived historical docs are not confused with live surfaces.

**Evidence:**
- Missing integration-test update: `test/integration/commands/harness.test.ts:28-30`
- Stale init guidance: `src/commands/init.handler.ts:319-326`
- Stale active docs: `README.md:121-127`, `217-264`; `src/harnesses/README.md:39-52`; `src/harnesses/opencode/README.md:25-29`, `89-93`

## High Priority (P1)

### P1.1 — Phase 3 should name the surviving regression coverage more concretely

**Classification:** auto_fix

The plan says existing harness tests cover skill installation after deleting `skills-install.test.ts`, but it does not explicitly call out the integration assertions that should remain for project/user installs, overwrite/idempotency, and harness list visibility. Naming those expectations would make the completion gate much less ambiguous.

## Medium Priority (P2)

- Clarify `SkillMetadata` ownership: if it moves to `installer.ts` only for typing ergonomics, say whether harness-local loaders should import that shared type or define local structural types to avoid reintroducing cross-layer coupling.

## Readiness Checklist

**P0 blockers**
- [ ] Resolve whether generic `5x skills` support is intentionally being removed and document the migration/breaking-change path.
- [ ] Expand the plan's touched-files/tasks list to include active docs, init messaging, and integration test imports that still reference the deleted loader/command.

**P1 recommended**
- [ ] Make the surviving regression coverage for `5x harness install/list/uninstall` explicit in Phase 3.

## Addendum — 2026-03-18 (re-review @ `46eaf2fcbe375f532ebf6bda21800661e48d1da9`)

**Assessment:** R1 and R2 are resolved.

- **R1 (migration guidance):** resolved. The plan now makes the product decision explicit: `5x skills` is intentionally removed, maps users to `5x harness install opencode`, documents the breaking-change behavior for existing installs, and calls out init/README updates needed to keep user guidance aligned.
- **R2 (complete change inventory):** resolved. The revision now names the previously missing active references: `test/integration/commands/harness.test.ts`, `src/commands/init.handler.ts`, `README.md`, `src/harnesses/README.md`, and `src/harnesses/opencode/README.md`. Phase 3 also names surviving regression coverage more concretely, and the regression gate is correctly narrowed to active/runtime/test/user-facing references.

### New issue introduced by the revision

- **Minor:** `docs/development/024-skills-to-harness.plan.md:47-49` says the old-command error is handled by "citty" unknown-command behavior. This repo's CLI is on Commander (`src/bin.ts`), so that framework reference is stale/inaccurate. Replace it with Commander-specific or framework-agnostic wording.

**Readiness:** ready_with_corrections
