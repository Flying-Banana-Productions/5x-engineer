# Review: Cursor Harness Phase 1 — optional harness rule support

**Review type:** commit `d678d275b90fcefd69f99a7c5c7583614f560ce1`
**Scope:** Phase 1 changes for optional harness rule support in shared harness framework
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/harnesses/installer.test.ts test/unit/commands/harness.test.ts` ✅, `bun test test/integration/commands/harness.test.ts test/integration/commands/harness-universal.test.ts test/integration/commands/text-output.test.ts` ✅

## Summary

Phase 1 is complete. The change cleanly extends the harness contract with optional rule support, keeps existing harnesses source-compatible, and adds solid unit/integration coverage around the new list/install surface.

**Readiness:** Ready — Phase 1 completion gate met; no blocking correctness, architecture, or operability gaps found.

## Strengths

- Rule support is added as optional contract surface (`rulesDir`, `ruleNames`, `capabilities`, `unsupported`, `warnings`) without forcing churn through existing harness implementations.
- The list path now uses scope-aware `describe(scope)` metadata, which matches the plan and sets up Cursor's project-vs-user rule behavior cleanly.
- Installer helper coverage is good: create/overwrite/skip semantics and empty-directory cleanup are all exercised.
- Regression coverage hits both unit and integration layers, including JSON/text list output paths and existing OpenCode behavior.

## Production Readiness Blockers

None.

## High Priority (P1)

None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] Optional harness rule contract added without breaking existing bundled harnesses
- [x] Rule install/uninstall helpers implemented and tested
- [x] `harness list` updated for scope-aware rule metadata and file detection
- [x] Install summary updated for rules and warnings

**P1 recommended**
- [x] Proceed to Phase 2

## Addendum — Phase 2 assessment

**Review type:** commit `ce035bfb4b582af4dea2eab9fd4921d9d87494ca`
**Scope:** Phase 2 changes for Cursor resolver, bundled plugin registration, and initial Cursor harness shell
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/harnesses/cursor.test.ts` ✅

## Summary

Phase 2 mostly lands cleanly. The Cursor resolver is correct for both scopes, the plugin is bundled and loadable, and scope-aware `describe()`/install behavior matches the plan's project-vs-user rule split.

**Readiness:** Ready with corrections — Phase 2 completion gate is effectively met, but the newly installed Cursor reviewer asset currently points agents at the wrong verdict contract and should be corrected before treating the harness shell as a safe base for Phase 3.

## Strengths

- `cursorLocationResolver` matches the documented `.cursor/` / `~/.cursor/` layout and correctly omits `rulesDir` for user scope.
- Bundled harness registration is minimal and consistent with the existing factory pattern.
- `cursorPlugin.describe(scope)` exposes the right scope-aware rule capability metadata for downstream list/install flows.
- Unit coverage exercises resolver behavior, bundle loading, project/user install behavior, and list data shape.

## Production Readiness Blockers

- The installed reviewer template tells Cursor to return a `ReviewVerdict` object, but the 5x contract is `ReviewerVerdict` (or normalized `verdict/issues` shape). Shipping this template would mis-specify the protocol for the reviewer subagent and create avoidable validation failures once Phase 3 starts exercising the installed assets.

## High Priority (P1)

- Fix the Cursor reviewer template contract text to reference `ReviewerVerdict`, not `ReviewVerdict`, and keep the naming aligned with the existing OpenCode reviewer template and protocol normalization rules.

## Medium Priority (P2)

- The Cursor agent/rule prompt files are currently very skeletal relative to the Phase 3 plan (no commit requirement, no worktree-authority guidance, no reviewer non-edit constraint copyover). That's acceptable for a Phase 2 shell, but it means the currently installable harness should still be treated as incomplete until Phase 3 lands.

## Readiness Checklist

**P0 blockers**
- [x] `loadHarnessPlugin("cursor")` resolves the bundled plugin
- [x] Project scope resolves `.cursor/{skills,agents,rules}`
- [x] User scope resolves `~/.cursor/{skills,agents}` with rules unsupported
- [x] Plugin describes scope-aware assets and rule capability metadata
- [ ] Reviewer asset contract text corrected before using installed assets as a Phase 3 baseline

**P1 recommended**
- [x] Proceed to Phase 3 after the template contract typo is fixed

## Addendum — Phase 2 fix confirmation

**Review type:** commit `36ff6c9d78b73f5e34447c88447b3640be9bbf16`
**Scope:** Confirmation of the Cursor reviewer template contract fix
**Reviewer:** Staff engineer
**Local verification:** template diff + file inspection ✅

## Summary

Confirmed fixed. `src/harnesses/cursor/5x-reviewer.md` now matches the OpenCode reviewer contract, names `ReviewerVerdict` correctly, and restores the missing reviewer guidance that was required for the installed Cursor asset.

**Readiness:** Ready — the prior Phase 2 blocker is resolved.

## Fix validation

- The incorrect `ReviewVerdict` reference has been replaced with `ReviewerVerdict`.
- The file now aligns with the OpenCode reviewer template's protocol wording and schema guidance.
- This removes the previously identified protocol mismatch for installed Cursor reviewer assets.

## Remaining notes

- No new issues found in this fix.
