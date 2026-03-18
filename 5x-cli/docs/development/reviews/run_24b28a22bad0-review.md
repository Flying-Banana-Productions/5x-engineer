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
