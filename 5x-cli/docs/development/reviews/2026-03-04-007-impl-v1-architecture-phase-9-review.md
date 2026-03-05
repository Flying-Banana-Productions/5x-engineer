# Review: v1 Architecture Phase 9 (Skills Bundling)

**Review type:** commit `14383be`
**Scope:** Phase 9: bundled skills, skill loader, `5x init` scaffolding, tests
**Reviewer:** Staff engineer
**Local verification:** `bun test test/commands/init-skills.test.ts` (pass)

## Summary

Phase 9 is implemented as planned: three skills are bundled as Markdown, imported as text via Bun, and scaffolded into `.5x/skills/` by `5x init` without overwriting user edits unless `--force` is used. Tests cover first-run creation, idempotency, force overwrite, and content parity.

**Readiness:** Ready — completion gate met; targeted tests pass.

## Strengths

- Mirrors the existing bundled-template pattern (`src/templates/loader.ts`) for skill bundling (`src/skills/loader.ts`).
- `ensureSkills()` behavior is clear and matches CLI expectations (created/overwritten/skipped).
- Good test coverage for both direct helper behavior and CLI-level integration.
- Skill content appears copied verbatim from `docs/v1/102-agent-skills.md`.

## Production Readiness Blockers

- None.

## High Priority (P1)

- None.

## Medium Priority (P2)

- P2.1 — Consider setting explicit permissions on `.5x/skills/` (and/or written files) for consistency with other `.5x/` artifacts (e.g. logs). Low risk today (skills are non-secret), but this prevents surprises if future skills embed sensitive operational details.
- P2.2 — The tests assert an exact count of bundled skills (`names.length === 3`). This is fine for Phase 9 gating, but will become friction when new bundled skills are added; prefer asserting the expected names are present without pinning the total.

## Readiness Checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [x] None
