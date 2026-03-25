# Review: 028 universal harness — Phase 1

**Review type:** commit `8a696fd37583453ee5637537a60812db58700aae`
**Scope:** Phase 1 skill template engine work and follow-on commits on `5x/028-universal-harness.plan`
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/skills/renderer.test.ts` ✅ (12/12); `bun test test/unit/skills` ✅ (12/12); `bun -e 'import { renderAllSkillTemplates } from "./src/skills/loader.ts"; ...'` ✅ loader smoke test

## Summary

`renderSkillTemplate()` is small, readable, and behaves correctly for the covered happy paths and parser failures. Main gap: the new shared loader currently publishes placeholder base skills, so the public API exists in a misleading half-implemented state and lacks direct regression coverage.

**Readiness:** Ready with corrections — Phase 1 can proceed, but tighten the shared loader before other code starts depending on it.

## Strengths

- Renderer implementation matches the phase design: line-oriented, explicit state machine, clear error cases.
- Tests cover the Phase 1 rendering gate well, including invoke/native branches, code fences, unmatched directives, and multi-block templates.

## Production Readiness Blockers

None.

## High Priority (P1)

### P1.1 — Shared loader exposes placeholder skill content

`src/skills/loader.ts` is now a public shared API, but every base template it returns is placeholder text (`"Shared foundation content."`, `"Plan workflow content."`, etc.) rather than the real skill bodies described by the plan. That is safe only as long as nothing consumes the loader; once Phase 2 wiring starts, this API will silently serve unusable skills.

Recommendation: either gate the loader behind Phase 2 completion, or add an explicit TODO/failure mode so callers cannot accidentally treat placeholder output as production-ready content.

### P1.2 — No direct tests for the new loader contract

Phase 1 introduced `listBaseSkillNames()`, `renderSkillByName()`, and `renderAllSkillTemplates()`, but verification only exercises the renderer. Add focused unit coverage now for name listing, unknown-template failure, frontmatter parsing, and native/invoke rendering smoke checks so Phase 2 changes do not break the new shared API unnoticed.

## Medium Priority (P2)

- `src/skills/loader.ts` currently depends on `parseSkillFrontmatter()` from the OpenCode loader, which keeps the new shared path coupled to harness-specific code until Phase 2 extracts the parser. Acceptable temporarily, but worth unwinding quickly.

## Readiness Checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] Prevent accidental production use of placeholder base templates, or make the temporary state explicit.
- [ ] Add unit tests for the shared loader API before Phase 2 rewires harness code to depend on it.
