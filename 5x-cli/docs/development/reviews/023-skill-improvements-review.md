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

## Addendum (2026-03-18) — Iteration 2 assessment

### What's Addressed

- **P0.1 fixed.** The plan now switches `config show` to `resolveLayeredConfig(...)` and adds `--context`, so nearest-config overrides are covered instead of root-only config.
- **P1.1 fixed.** Phase 4a correctly removes the broad `Triggers on:` line from the shared `5x` skill and repositions it as a co-loaded dependency.
- **P2.1 fixed.** Phase 1 now keeps stdout/envelope assertions in integration scope and limits unit coverage to pure helpers + config resolution.

### Readiness

**Readiness:** Ready with corrections — prior review items are addressed, but the revised plan still needs a control-plane-root correction for `config show` plus a couple of internal consistency cleanups.

### Review Items

- **P1.2 — `config show` root resolution is still underspecified for managed worktrees.**
  - **Action:** `auto_fix`
  - **Reason:** Phase 1 now says to call `resolveLayeredConfig(projectRoot, contextDir)`, but it never requires `projectRoot` to come from `resolveControlPlaneRoot(startDir)`. If implemented from `resolveProjectRoot()` / cwd inside a linked worktree, root-anchored values like `db.path` can still resolve relative to the checkout instead of the control-plane root, so `5x config show` can disagree with `template` / `invoke` / `quality` runtime behavior. The plan should explicitly anchor root resolution to the control-plane root and add a worktree-context test.

- **P2.2 — The plan still contradicts itself on whether the new `5x` skill should self-trigger.**
  - **Action:** `auto_fix`
  - **Reason:** Phase 4a correctly says the shared `5x` skill should never fire on its own, but Phase 2a still asks for a description “optimized for triggering on any 5x-related work,” and the Phase 4 completion gate still says all four descriptions include trigger words. Those sections should be normalized so implementation does not regress the fix.

- **P2.3 — Test/file update scope is incomplete for adding a fourth bundled skill.**
  - **Action:** `auto_fix`
  - **Reason:** The plan updates `test/unit/skills/skill-content.test.ts`, but repo tests such as `test/unit/commands/init-skills.test.ts` still assert exactly three bundled skills. Expand the touched-files/tests lists so the implementation plan covers all known exact-count assertions likely to fail.

### Summary

Iteration 2 resolves the three issues from the first review. Remaining gaps are mechanical: make `config show` explicitly control-plane-aware in worktree contexts, and clean up the plan's own inconsistencies around the new shared skill and test scope.

## Addendum (2026-03-18) — Iteration 3 assessment

### What's Addressed

- **P1.2 mostly fixed.** Phase 1a now explicitly requires `resolveControlPlaneRoot(startDir)` and uses `controlPlane.controlPlaneRoot` for `resolveLayeredConfig`, which aligns the planned command behavior with `template` / `invoke` / `quality` in linked worktrees.
- **P2.2 fixed.** Phase 2a and the Phase 4 completion gate now consistently describe the shared `5x` skill as a co-loaded dependency, not a trigger-optimized standalone skill.
- **P2.3 fixed.** The plan now calls out `test/unit/commands/init-skills.test.ts` and the exact-count assertion updates needed for the fourth bundled skill.

### Readiness

**Readiness:** Ready with corrections — the plan revisions are directionally correct and introduced no new design problems, but one mechanical test gap remains.

### Review Items

- **P2.4 — Worktree-specific test coverage for `config show` is still missing.**
  - **Action:** `auto_fix`
  - **Reason:** The plan now fixes the implementation approach for managed worktrees, but Phase 1e still only covers root config, `--context` nearest-config layering, and defaults. Add an integration test case that invokes `5x config show` from a linked/managed worktree context and verifies root-anchored values resolve from the control-plane root rather than the checkout.

### Summary

Iteration 3 resolves the architecture/copy issues from the previous addendum, and I do not see any new design regressions. The remaining gap is narrow: add one worktree-context test so the newly specified control-plane-root behavior is explicitly protected.
