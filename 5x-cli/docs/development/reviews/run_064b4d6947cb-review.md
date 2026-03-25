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

## Addendum — Phase 3 assessment

**Review type:** commit `5c1c8bc24ba81a3d980aad9244591d23232a2480` (no follow-on commits)
**Scope:** Phase 3 changes for Cursor orchestrator rule, subagent templates, and model-aware template rendering
**Reviewer:** Staff engineer
**Local verification:** file inspection ✅, `bun test test/unit/harnesses/cursor-loader.test.ts test/unit/harnesses/cursor.test.ts` ✅

## Summary

Phase 3 is complete. The Cursor harness now ships a usable orchestrator rule, fully fleshed-out author/reviewer subagent templates, and loader-driven model injection that matches the phase contract.

**Readiness:** Ready — Phase 3 completion gate met; no blocking correctness, architecture, security, or test coverage gaps found.

## Strengths

- `src/harnesses/cursor/5x-orchestrator.mdc` has the required Cursor rule frontmatter (`description`, `alwaysApply: false`) and captures the expected orchestration/worktree guidance from the plan.
- All three subagent templates are now full workflow prompts rather than stubs, including protocol contract text and working-directory authority guidance.
- `src/harnesses/cursor/loader.ts` cleanly centralizes template metadata plus `yamlQuote()` / `injectModel()` behavior, with omission of `model` when unset and quoted YAML-safe injection when configured.
- Loader tests cover the critical rendering cases: omit-when-unset, author/reviewer role routing, and escaping for `:`, `"`, `\\`, `\n`, and `\r`.
- The previously flagged reviewer contract issue remains fixed; the installed Cursor reviewer template now correctly requires `ReviewerVerdict`.

## Production Readiness Blockers

None.

## High Priority (P1)

- None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] `5x-orchestrator.mdc` exists with correct frontmatter
- [x] `5x-plan-author.md`, `5x-code-author.md`, and `5x-reviewer.md` are fully fleshed out
- [x] `loader.ts` implements `renderAgentTemplates()` with `yamlQuote()` and `injectModel()`
- [x] Model injection omits `model` when unset and injects quoted YAML-safe values when set
- [x] Unit tests cover omission and escaping behavior
- [x] Reviewer template uses the correct `ReviewerVerdict` contract

**P1 recommended**
- [x] Proceed to Phase 4

## Addendum — Phase 4 assessment

**Review type:** commit `dc7fa41001d200e86128218bb2e067cb94d5623d` (no follow-on commits)
**Scope:** Phase 4 changes for Cursor skills rendered from shared base templates with terminology adaptation
**Reviewer:** Staff engineer
**Local verification:** file inspection ✅, `bun test test/unit/harnesses/cursor-skills.test.ts test/unit/harnesses/cursor.test.ts test/unit/harnesses/cursor-loader.test.ts` ✅

## Summary

Phase 4 is close, but not complete. The Cursor harness now installs skills from the shared base template pipeline via `renderAllSkillTemplates({ native: true })`, and the substitution pass removes the main OpenCode-only `Task tool` / `task_id` terms. However, one OpenCode-specific sentence still ships in the rendered Cursor skills, so the installed Cursor skill set is not yet fully Cursor-native.

**Readiness:** Ready with corrections — one mechanical wording fix remains before the phase completion gate is met.

## Strengths

- `src/harnesses/cursor/skills/loader.ts` correctly uses the shared base-skill renderer and applies adaptation after native render, avoiding per-harness skill copies.
- `src/harnesses/cursor/plugin.ts` installs Cursor skills through the shared loader output rather than a Cursor-local skill tree.
- `test/unit/harnesses/cursor-skills.test.ts` covers the main Phase 4 goals: shared-template sourcing, Cursor terminology presence, removal of `Task tool` / `subagent_type` / `task_id`, and frontmatter validity after adaptation.
- OpenCode and Universal harness skill renderers were not modified by this change, limiting regression risk outside Cursor.

## Production Readiness Blockers

- The rendered Cursor `5x` foundation skill still contains the sentence `These skills assume an opencode environment with the 5x harness installed.` This is OpenCode-specific wording in shipped Cursor output and violates the Phase 4 requirement that Cursor-rendered skills not retain OpenCode-only wording. The issue is directly in the installed asset path because `adaptCursorTerminology()` does not rewrite or remove this sentence.

## High Priority (P1)

- Remove or neutralize the remaining `opencode environment` sentence in the Cursor-rendered foundation skill and add a regression assertion in `test/unit/harnesses/cursor-skills.test.ts` so Cursor output rejects both `Task tool`/`task_id` wording and other OpenCode-only references.
  - Classification: `auto_fix`
  - Location: `src/skills/base/5x/SKILL.tmpl.md`, rendered via `src/harnesses/cursor/skills/loader.ts`; missing test coverage in `test/unit/harnesses/cursor-skills.test.ts`

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] Cursor plugin skill install path uses shared rendered skills, not harness-local copies
- [x] Cursor terminology substitution is applied to rendered shared skills
- [x] Tests verify shared-template sourcing, terminology substitution, and frontmatter validity
- [x] Skill frontmatter remains valid after render + adaptation
- [x] No code-path regressions found for OpenCode or Universal harness rendering
- [ ] Remaining OpenCode-only wording removed from rendered Cursor skill output

**P1 recommended**
- [ ] Add regression coverage for OpenCode-specific wording beyond `Task tool` / `task_id`

## Addendum — Phase 4 wording fix confirmation

**Review type:** commit `9486d3492ee46fed59c39ea37bcb67fa17119fb8`
**Scope:** Confirmation of the remaining OpenCode-wording fix in Cursor-rendered skills
**Reviewer:** Staff engineer
**Local verification:** file inspection ✅, `bun test test/unit/harnesses/cursor-skills.test.ts test/unit/harnesses/opencode.test.ts test/unit/harnesses/universal.test.ts` ✅

## Summary

Confirmed fixed. Cursor-rendered skills no longer ship the prior OpenCode-specific sentence, and the rendered Cursor `5x` foundation skill now uses neutral wording: `These skills assume your project has the 5x harness installed.` Regression coverage was added to assert Cursor-rendered skills do not contain `opencode`, and OpenCode/Universal harness tests still pass.

**Readiness:** Ready — the prior Phase 4 blocker is resolved.

## Fix validation

- `src/harnesses/cursor/skills/loader.ts` now rewrites the remaining OpenCode-specific sentence during Cursor terminology adaptation, producing neutral Cursor-appropriate rendered output.
- The rendered Cursor `5x` foundation skill no longer contains `opencode` and still preserves the expected native-subagent workflow wording.
- `test/unit/harnesses/cursor-skills.test.ts` now includes an explicit `not.toMatch(/opencode/i)` regression assertion across the combined rendered Cursor skills.
- `bun test test/unit/harnesses/opencode.test.ts test/unit/harnesses/universal.test.ts` passed, with no regression signal for the existing OpenCode or Universal render/install paths.

## Remaining notes

- The fix lands in the Cursor adaptation layer rather than the base template itself. That is still sufficient for the Phase 4 requirement because the shipped Cursor-rendered skills are now correct and covered by regression tests.

## Addendum — Phase 5 assessment

**Review type:** commit `b343b78d24c0af9fc4e42ed2837f3aeb200c6f25` (no follow-on commits)
**Scope:** Phase 5 changes for Cursor docs, install UX polish, and integration coverage
**Reviewer:** Staff engineer
**Local verification:** file inspection ✅, `bun test test/integration/commands/harness.test.ts` ✅

## Summary

Phase 5 is not complete. README coverage, Cursor install summary polish, rule-file detection, and project/user integration coverage all landed. But the phase still misses the required readable `harness list` UX: the command only emits the JSON envelope and does not print the human-readable skills/agents/rules summary or the required `rules: unsupported (Cursor user rules are settings-managed)` line.

**Readiness:** not_ready — final-phase acceptance is not met, so the Cursor harness should not yet be treated as production-ready.

## Strengths

- `README.md` now documents Cursor as a supported harness, both `--scope project` and `--scope user`, the need to run `5x init` before project-scope install, and a clear "start a 5x workflow in Cursor" path.
- `printInstallSummary()` now reports rules and warning strings, and the Cursor user-scope note is explicit and user-friendly.
- `buildHarnessListData()` now detects `.mdc` rules and surfaces `unsupported.rules` metadata for user scope.
- Integration coverage now exercises Cursor install/list/uninstall flows for both scopes, including the user-scope no-rules case.

## Production Readiness Blockers

- The Phase 5 plan explicitly requires readable `harness list` output that shows installed skills, agents, project-scope rules, and a user-scope unsupported-rules message. That output path was not implemented. `src/commands/harness.handler.ts` only builds data and emits the JSON envelope via `outputSuccess(output)`, and `src/commands/harness.ts` exposes no text-mode or readable summary branch for `harness list`. As shipped, users cannot get the required readable Cursor state summary from the CLI.
  - Classification: `auto_fix`
  - Location: `src/commands/harness.handler.ts`, `src/commands/harness.ts`

## High Priority (P1)

- Add the missing human-readable `harness list` summary and cover it with integration assertions for Cursor project/user scopes. The text output should show installed skills/agents/rules for project scope and the explicit unsupported-rules message for user scope.
  - Classification: `auto_fix`
  - Location: `src/commands/harness.handler.ts`, `test/integration/commands/harness.test.ts`

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] `README.md` documents Cursor project/user install commands
- [x] `README.md` includes how to start a 5x workflow in Cursor
- [x] `README.md` documents the user-scope rules limitation
- [x] `printInstallSummary()` prints rule results and warning strings
- [x] `buildHarnessListData()` checks `.mdc` files and includes `unsupported`
- [x] Integration tests cover Cursor project/user install state and uninstall cleanup
- [ ] `harness list` readable output shows skills, agents, rules, and user-scope unsupported-rules messaging

**P1 recommended**
- [ ] After the readable-output path lands, rerun Cursor harness integration coverage with explicit text-output assertions before final approval
