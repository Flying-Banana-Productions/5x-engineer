# Review: Mixed-mode delegation phase 2

**Review type:** commit `d06d2717c5b693f846188d8d81efc5394817e560`
**Scope:** Phase 2 renderer directive support and follow-on test coverage
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/skills/renderer.test.ts test/unit/skills/loader.test.ts test/unit/skills/invoke-content.test.ts` ✅ (38 pass); targeted `bun -e` probe against `renderSkillTemplate()` ❌ confirms legacy `{{#if invoke}}` renders in mixed mode when callers provide only per-role flags

## Summary

Phase 2 is close, but not complete. The renderer recognizes the new role-scoped directives, and the tests cover the happy-path combinations well, but the legacy `{{#if invoke}}` fallback is derived from `!ctx.native` instead of `!authorNative && !reviewerNative`. That makes mixed-mode contexts behave like full invoke mode whenever callers omit `ctx.invoke`, which violates the phase contract and will break future mixed-mode integrations.

**Readiness:** Not ready — phase 2 still has a correctness bug in legacy directive handling.

## Strengths

- Renderer support for `author_*`, `reviewer_*`, `any_*`, and legacy directives is otherwise straightforward and consistent with the existing parser model.
- Unit coverage is materially better than before and exercises the new directive family across all four role combinations.

## Production Readiness Blockers

None.

## High Priority (P1)

### P1.1 — Legacy `invoke` fallback is wrong for mixed-mode contexts

**Risk:** Mixed-mode callers that pass per-role flags without redundantly supplying `ctx.invoke` will render `{{#if invoke}}` blocks even when only one role uses invoke. That contradicts the documented compatibility rule that legacy `invoke` is true only when both roles are invoke, and it will surface incorrect skill content once install paths start constructing mixed contexts directly.

**Requirement:** Derive legacy `invoke` from the per-role flags (`!authorNative && !reviewerNative`) when `ctx.invoke` is absent, and add a regression test that passes a mixed per-role context without `invoke` to verify `{{#if invoke}}` stays inactive.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Correct legacy `invoke` fallback derivation and add regression coverage for partial mixed contexts.

## Addendum (2026-04-09) — Follow-up on legacy invoke fallback fix

### What's Addressed

- `renderSkillTemplate()` now derives legacy `invoke` from the per-role flags when `ctx.invoke` is omitted, restoring the documented “both roles invoke” compatibility behavior.
- Regression coverage was added for all omitted-`ctx.invoke` permutations, including both mixed-mode cases, both-invoke, both-native, and explicit override behavior.
- Local verification passed: `bun test test/unit/skills/renderer.test.ts test/unit/skills/loader.test.ts test/unit/skills/invoke-content.test.ts`.

### Remaining Concerns

- None. The prior P1 issue is resolved, and Phase 2 now meets its renderer correctness and test coverage gate.
