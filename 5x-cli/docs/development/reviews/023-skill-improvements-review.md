# Review: 023-skill-improvements

**Review type:** /home/spalmer/dev/5x-engineer/5x-cli/docs/development/023-skill-improvements.plan.md
**Scope:** Plan for `5x config show`, new shared `5x` skill, process-skill slimming, and description trigger updates
**Reviewer:** Staff engineer
**Local verification:** Not run

## Summary

Strong direction overall: extracting shared skill content and removing hardcoded retry limits addresses real drift. But the plan currently misses the repo's layered-config model and proposes trigger strings broad enough to cause false-positive skill loads, so it is not ready as written.

**Readiness:** Not ready — command shape and trigger design need correction before implementation.

## Strengths

- Correctly identifies current drift between skill prose and runtime config defaults.
- Shared-foundation skill + gotchas sections should reduce duplication and improve first-pass reliability.
- Phase ordering is mostly sensible: runtime primitive first, then shared skill, then slim process skills, then copy tweaks.

## Production Readiness Blockers

### P0.1 — `config show` ignores layered config context

**Risk:** In sub-project / monorepo flows, the new command can still report the wrong `maxReviewIterations` / `maxQualityRetries`, which defeats the main reason for adding it. Current workflow code already resolves layered config from the plan's directory, not just repo root.

**Requirement:** Redesign `5x config show` so it can resolve config in the same context as plan/run workflows (for example via plan path, run id, or explicit context dir), and add tests covering nearest-config overrides plus root fallback.

**Action:** `human_required`

## High Priority (P1)

### P1.1 — Trigger descriptions are too generic

The proposed `5x` description triggers on words like `plan`, `review`, `implement`, and `execute`. Those are common across unrelated coding work, so automatic skill loading will likely over-fire and inject 5x workflow instructions when the user is not doing 5x work. Tighten descriptions toward 5x-specific phrases/signals instead of broad verbs.

**Action:** `human_required`

## Medium Priority (P2)

- **P2.1 — Unit-test strategy conflicts with repo test guidance.** Phase 1d proposes asserting handler stdout in a unit test, but `AGENTS.md` says unit tests should avoid console-output capture. Keep stdout/envelope assertions in integration tests; unit-test pure config-resolution / text-formatting helpers instead. **Action:** `auto_fix`

## Readiness Checklist

**P0 blockers**
- [ ] Add context-aware config resolution to `5x config show` and test layered overrides.

**P1 recommended**
- [ ] Narrow skill trigger descriptions to 5x-specific phrases.
- [ ] Rework Phase 1 unit tests to avoid stdout-capture assertions.
