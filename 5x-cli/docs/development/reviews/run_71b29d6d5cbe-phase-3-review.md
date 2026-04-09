# Review: Mixed-mode delegation phase 3

**Review type:** commit `174a3b89d8c1f5dbe91c393b45b49289dfec51c5`
**Scope:** Phase 3 skill template refactor and follow-on tests
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/skills/renderer.test.ts test/unit/skills/loader.test.ts` ✅ (48 pass); targeted `grep`/render probes ❌ found one leftover legacy `{{#if native}}` branch in `5x-phase-execution` and invoke/invoke output drift in the foundation skill

## Summary

The refactor is mostly on-plan: role-scoped conditionals landed across the shared skill templates, mixed-mode render coverage improved substantially, and the new `all_native` / `all_invoke` directives close the backward-compatibility gap called out in Phase 2. Two issues still block a clean Phase 3 sign-off, though: the foundation skill no longer preserves the legacy invoke/invoke output shape, and `5x-phase-execution` still has one mixed-mode gate wired to the old all-native conditional.

**Readiness:** Ready with corrections — the remaining issues are mechanical template fixes plus regression coverage.

## Strengths

- The renderer and templates now express author vs reviewer delegation explicitly, which fits the architecture much better than the prior harness-wide binary.
- Test coverage is materially stronger: all four delegation combinations are rendered and checked across the shared skill set.

## Production Readiness Blockers

None.

## High Priority (P1)

### P1.1 — Foundation skill regressed invoke/invoke backward compatibility

**Risk:** Rendering `5x` with `createRenderContext(false)` now includes the “Native harness” section alongside invoke guidance. That contradicts the Phase 3 requirement that invoke/invoke output match the legacy `{ native: false }` render, and it will give universal-harness users native-only operating instructions they cannot follow.

**Requirement:** Restore the prior invoke/invoke output shape for `src/skills/base/5x/SKILL.tmpl.md` by gating the native-harness section so it only renders when native delegation is actually present, while still keeping the mixed-mode dual-pattern guidance required by the plan. Add a regression test that compares the rendered invoke/invoke foundation skill against the legacy output contract.

## Medium Priority (P2)

- `src/skills/base/5x-phase-execution/SKILL.tmpl.md:230` still uses `{{#if native}}` for the quality-retry escalation branch. In mixed mode that falls into the CLI prompt path unless both roles are native, even though the orchestrator is still running in a native harness. Replace it with the correct mixed-mode-safe conditional and add a regression assertion for the affected render.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Re-gate the foundation skill so invoke/invoke rendering matches the legacy non-native output.
- [ ] Replace the leftover legacy `{{#if native}}` branch in phase execution and cover it with a mixed-mode render test.
