# Review: 023-skill-improvements Phase 1

**Review type:** commit `9795337a404a89a7dd5534aaa386199a79694c42`
**Scope:** Phase 1 implementation of `5x config show` and follow-on commits
**Reviewer:** Staff engineer
**Local verification:** `bun test` - passed (1629 pass, 1 skip); `bun test test/unit/commands/config-show.test.ts test/integration/commands/config-show.test.ts` - passed (9 tests)

## Summary

Phase 1 lands the new command in the right places, uses layered config resolution, and covers the managed-worktree path. Main gap: `5x config show` does not actually emit the full resolved config object promised by the plan; it hand-maps a subset and drops passthrough/plugin config, which recreates drift risk.

**Readiness:** Ready with corrections - core behavior is in place, but the command contract and one test gap still need mechanical fixes.

## Strengths

- Correct architecture: `configShow()` anchors root resolution through `resolveControlPlaneRoot()` and then calls `resolveLayeredConfig()`, matching the runtime pattern used elsewhere.
- Test strategy includes the important linked-worktree integration case, and the full suite still passes after command registration in `src/bin.ts`.

## Production Readiness Blockers

None.

## High Priority (P1)

### P1.1 — `config show` is not a full resolved-config dump

**Risk:** The plan explicitly positions this command as the single runtime source of truth for resolved config. The implementation in `src/commands/config.handler.ts` manually rebuilds a narrowed `ConfigShowOutput`, so any passthrough/provider-specific top-level config and any future schema additions are silently omitted. That means `5x config show` can drift from the actual resolved config even when config loading is correct.

**Requirement:** Emit the resolved config object directly (or derive output from the parsed config type without narrowing away unknown keys), while keeping text-mode formatting as a presentation concern. Add coverage that proves passthrough/plugin config survives the command output.

**Action:** `auto_fix`

## Medium Priority (P2)

- **P2.1 — Unit tests do not verify the text formatter contract.** The Phase 1 plan calls for asserting human-readable key/value rendering, but `test/unit/commands/config-show.test.ts` only checks that `formatConfigText()` does not throw. That leaves the new text output effectively untested. Add a pure formatter test that captures/inspects rendered lines without relying on CLI subprocess behavior. **Action:** `auto_fix`

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Stop hand-mapping the config payload; preserve passthrough/future config fields in `5x config show` output.
- [ ] Add tests that verify plugin/passthrough config is emitted and text formatting renders expected key/value content.

## Addendum (2026-03-18) — Re-review after R1/R2 fixes

### What's Addressed

- **R1 resolved.** `src/commands/config.handler.ts` now emits the resolved `FiveXConfig` object directly via `outputSuccess(config, ...)`, so passthrough/plugin config and future schema additions are no longer dropped by a hand-maintained DTO.
- **R2 resolved.** `formatConfigText()` is now a pure formatter returning a string, and `test/unit/commands/config-show.test.ts` now asserts actual rendered sections/values plus optional-field omission instead of only checking that formatting does not throw.
- **Coverage added at the command boundary.** `test/integration/commands/config-show.test.ts` now verifies passthrough/plugin config survives the CLI JSON envelope, which closes the contract gap called out in the prior review.
- **Local verification:** `bun test test/unit/commands/config-show.test.ts test/integration/commands/config-show.test.ts` passed (12 tests); `bun test` passed (1632 pass, 1 skip).

### Remaining Concerns

- None. The fix commit closes the prior review items and does not introduce new Staff-level concerns in Phase 1 scope.

## Addendum (2026-03-18) — Phase 2 review of commit `be6861eb236dd32a157f47e3e06c0eafa8ba5820`

### What's Addressed

- `src/skills/5x/SKILL.md` lands the required Phase 2 foundation sections: Human Interaction Model, Delegating Sub-Agent Work, Session Reuse, Fallback, Timeout Layers, and Gotchas.
- Loader wiring is correct: `src/skills/loader.ts` imports the new skill and exposes it through the bundled `SKILLS` registry, so installer flows that enumerate bundled skills pick it up automatically.
- Exact-count assertions were updated for the fourth bundled skill in `test/unit/commands/init-skills.test.ts` and `test/unit/commands/harness.test.ts`.
- Local verification: `bun test test/unit/commands/harness.test.ts test/unit/commands/init-skills.test.ts test/unit/skills/skill-content.test.ts` passed (114 tests).

### Remaining Concerns

- **Major — test coverage does not pin all required Phase 2 sections.** The new `describe("5x foundational skill")` block checks Human Interaction, Delegating, Timeout, Gotchas, agent names, `5x config show`, and detection order, but it does not assert that the required `## Session Reuse` and `## Fallback: 5x invoke` sections exist. That leaves two plan-required sections free to regress without a failing test. **Action:** `auto_fix`.

**Readiness:** Ready with corrections — implementation is structurally correct, but the Phase 2 skill-content contract test is still incomplete.

## Addendum (2026-03-18) — Phase 2 re-review of commit `34acf7348b22808b9d405e4675e3b714dc2fec81`

### What's Addressed

- **Prior R1 resolved.** `test/unit/skills/skill-content.test.ts` now asserts both missing Phase 2 sections explicitly: `## Session Reuse` and `## Fallback: 5x invoke`.
- The fix is scoped correctly to the reported gap; no production skill content changed, only the contract test coverage.
- Local verification: `bun test test/unit/skills/skill-content.test.ts` passed (73 tests).

### Remaining Concerns

- None in Phase 2 scope. I did not find new Staff-level issues in the fix commit.

**Readiness:** Ready.

## Addendum (2026-03-18) — Phase 3 review of commit `5db412ab068a56045ec1c1045ed8bcdcb44b7d46`

### What's Addressed

- Shared boilerplate was removed from the three process skills and centralized in `src/skills/5x/SKILL.md`: human interaction guidance, generic delegation intro / names / detection order, fallback section, and timeout layers no longer remain in the process skills.
- Skill-specific content was preserved where the plan required it: the process skills still keep their concrete delegation examples, workflow steps, invariants, recovery guidance, and phase-execution keeps its worktree/session details.
- `src/skills/5x-phase-execution/SKILL.md` no longer contains the duplicate native-agent detection-order block.
- All three process skills now include `## Prerequisite Skill` and `## Gotchas` sections pointing back to the `5x` foundational skill.
- `test/unit/skills/skill-content.test.ts` was updated in the right direction: detection-order/fallback section assertions moved to the `5x` skill, prerequisite/gotchas assertions were added for each process skill, and existing contract checks (`AuthorStatus`, `ReviewerVerdict`, checklist-mismatch guidance) were preserved.
- Local verification: `bun test test/unit/skills/skill-content.test.ts` passed (72 tests).

### Remaining Concerns

- **Major — config-driven iteration/retry limits are still hardcoded in workflow prose.** Phase 3 adds gotchas telling the agent to read `maxReviewIterations` / `maxQualityRetries` from `5x config show`, and the foundational `5x` skill explicitly says never hardcode limits. But `src/skills/5x-plan-review/SKILL.md` still says `Maximum 5 review cycles` and `If $ITERATION > 5`, while `src/skills/5x-phase-execution/SKILL.md` still says `Track $QUALITY_RETRIES = 0 (max 2)`, `Track $REVIEW_ITERATIONS = 0 (max 3)`, `Quality gates failing after 2 retries`, and `If $REVIEW_ITERATIONS > 3`. That recreates the exact config-drift problem this skill refactor is meant to remove and leaves the skills internally contradictory. These workflow limits should be referenced by config key / runtime lookup, not fixed numbers.

**Readiness:** Not ready — the structural Phase 3 refactor landed, but the process skills still hardcode runtime limits in contradiction to the new shared guidance and overall design.

## Addendum (2026-03-18) — Phase 3 re-review after R1 fix

### What's Addressed

- **R1 resolved.** All hardcoded iteration/retry limits in process skill workflow prose now reference config keys via `5x config show` instead of fixed numbers:
  - `src/skills/5x-plan-review/SKILL.md`: "Maximum 5 review cycles" → "Read `maxReviewIterations` from `5x config show` for the maximum"; "If $ITERATION > 5" → "If $ITERATION exceeds `maxReviewIterations` (from `5x config show`)"; "The max 5 limit" → "The `maxReviewIterations` limit".
  - `src/skills/5x-phase-execution/SKILL.md`: "max 2" / "max 3" tracking lines → reference `maxQualityRetries` / `maxReviewIterations` from `5x config show`; "If $QUALITY_RETRIES > 2" → "If $QUALITY_RETRIES exceeds `maxQualityRetries` (from `5x config show`)"; "after 2 retries" → "after $maxQualityRetries retries"; "If $REVIEW_ITERATIONS > 3" → "If $REVIEW_ITERATIONS exceeds `maxReviewIterations` (from `5x config show`)".
- The process skills are now internally consistent with their own Gotchas sections and with the `5x` foundational skill's guidance to never hardcode limits.
- Local verification: `bun test` passed (1641 pass, 1 skip).

### Remaining Concerns

- None in Phase 3 scope. All workflow prose now references config keys by name, consistent with the plan's design decision.

**Readiness:** Ready.

## Addendum (2026-03-18) — Staff re-review of commit `6b129ab0d890793d2648ca743c714b3159fc9686`

### What's Addressed

- **R1 resolved.** The Phase 3 process skills no longer hardcode numeric review/retry caps in workflow prose. `src/skills/5x-plan-review/SKILL.md` now points to `maxReviewIterations` from `5x config show`, and `src/skills/5x-phase-execution/SKILL.md` now points to `maxReviewIterations` / `maxQualityRetries` from `5x config show`.
- I did not find any remaining fixed numeric loop limits in the changed Phase 3 workflow sections.
- Local verification: `bun test test/unit/skills/skill-content.test.ts` passed (72 tests).

### Remaining Concerns

- **Minor — undefined placeholder in escalation prompt.** `src/skills/5x-phase-execution/SKILL.md:179` now says `Quality gates failing after $maxQualityRetries retries`, but the workflow never defines `$maxQualityRetries` as a shell variable. Either reference the config key name directly in prose or explicitly define the variable before using it. Non-blocking, but still one inconsistent placeholder in the updated text.

**Readiness:** Ready with corrections.

## Addendum (2026-03-18) — Phase 4 review of commit `6fb1a0e27b915d17d16126c0d4cfaf334bd4a151`

### What's Addressed

- All three process skill descriptions now include both required pieces from Phase 4: the co-loading instruction (`Load the `5x` skill first.`) and the trigger-word list from the plan.
- The trigger text in `src/skills/5x-plan/SKILL.md`, `src/skills/5x-plan-review/SKILL.md`, and `src/skills/5x-phase-execution/SKILL.md` matches the Phase 4 plan wording exactly.
- `src/skills/5x/SKILL.md` remains correctly scoped as a co-loaded dependency: its description focuses on loading alongside the process skills and does not include a `Triggers on:` line.
- Local verification: `bun test` passed (1641 pass, 1 skip).

### Remaining Concerns

- None in Phase 4 scope. The description fields now align with the plan and the suite remains green.

**Readiness:** Ready.

## Addendum (2026-03-18) — Phase 5 review of commit `1b6c34ec67eb18da1208efc088035845621b35a2`

### What's Addressed

- `src/commands/quality-v1.handler.ts` now uses `dirname(result.nearestConfigPath)` when layered config resolution selects a sub-project `5x.toml`, so run-scoped quality gates execute from the sub-project directory instead of the control-plane root.
- Precedence is preserved in the handler: `projectRoot = effectiveWorkdir ?? layeredCwd`, so explicit `--workdir` and mapped worktree paths still win, while non-layered config still falls back to `controlPlaneRoot`.
- The new integration coverage is meaningful: `test/integration/commands/quality-v1.test.ts` creates a root repo plus sub-project config/plan, runs `5x quality run --run <id>`, and verifies `pwd` reports the sub-project path. It also follows the repo's subprocess rules (`cleanGitEnv()`, `stdin: "ignore"`, timeout).
- Local verification: `bun test test/unit/commands/quality-handler.test.ts` passed (7 tests); `bun test test/integration/commands/quality-v1.test.ts` passed (6 tests).

### Remaining Concerns

- **Minor — the new unit tests do not actually pin the fixed Phase 5 handler path.** One test only re-checks `resolveLayeredConfig()` metadata, not `runQuality()` behavior. The other calls `runQuality({ workdir: subDir })`, which exercises the non-`--run` branch (`else if (effectiveWorkdir)`) rather than the Phase 5 layered run-scoped branch called out in the plan. Neither unit test asserts the gate output/cwd directly. The integration test covers the real bug, so this is not blocking, but the unit tests should be tightened or renamed to match what they actually verify.

**Readiness:** Ready with corrections.

## Addendum (2026-03-18) — Phase 6 review of commit `f484054951502cc9c675aba2e6dd6e182d1296d1`

### What's Addressed

- `src/templates/loader.ts` now performs the intended stale-override comparison in `loadTemplate()`: it parses the loaded override, looks up the bundled template from `TEMPLATES`, and warns only when `overrideVersion < bundledVersion`. Equal versions do not warn, and user-only templates with no bundled equivalent correctly skip the version check.
- The new warning text is actionable and consistent with the existing template warning pattern: same `Warning: Template ...` prefix, same `.5x/templates/prompts/<name>.md` removal guidance, and the same `5x init --install-templates --force` remediation path.
- All 8 bundled templates are now at `version: 2`, and `src/templates/author-generate-plan.md` now includes the same `5x protocol emit author --complete --commit <hash>` / `--needs-human` completion pattern already used by the other author templates.
- Test updates are meaningful for the Phase 6 scope: `test/unit/templates/stale-override.test.ts` covers stale override, equal-version override, and user-only override cases; existing version assertions were updated in `test/unit/templates/loader.test.ts` and `test/integration/commands/template-list.test.ts` to reflect the v2 bump.
- Local verification: `bun test test/unit/templates/loader.test.ts test/unit/templates/stale-override.test.ts test/integration/commands/template-list.test.ts` passed (90 tests); `bun test` passed (1647 pass, 1 skip).

### Remaining Concerns

- None in Phase 6 scope. I did not find new Staff-level issues in the stale-template detection, protocol-emit update, or test/version-bump follow-through.

**Readiness:** Ready.
