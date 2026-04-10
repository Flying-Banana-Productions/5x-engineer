# Review: Mixed-Mode Delegation for Native Harnesses

**Review type:** /home/spalmer/dev/5x-engineer/5x-cli/docs/development/plans/019-mixed-mode-delegation.md
**Scope:** Plan correctness, architecture, completeness, phasing, testability, and risk coverage for per-role native vs invoke delegation.
**Reviewer:** Staff engineer
**Local verification:** Not run

## Summary

Strong direction: per-role delegation fits the product need, most code touchpoints are identified, and the phasing is broadly sensible. But the plan is not implementation-ready because it defines contradictory semantics for the legacy `native` / `invoke` flags in mixed mode, and its proposed dynamic agent inventory conflicts with the current harness plugin contract and uninstall model.

**Readiness:** Not ready — requires design corrections on mixed-mode render semantics and harness asset ownership before implementation.

## Strengths

- Correctly centers the change on config, render context, skill rendering, harness install, and orchestrator guidance rather than touching `5x invoke` itself.
- Preserves the default all-native and all-invoke paths as explicit compatibility goals.
- Identifies the real mixed-mode pain point: native orchestrators need per-step delegation instructions while still remaining orchestrators.

## Production Readiness Blockers

### P0.1 — Legacy render flag semantics are internally contradictory

**Risk:** Authors implement incompatible truth tables for `native` / `invoke`, causing wrong skill output in mixed mode and likely broken orchestration guidance.

**Requirement:** Pick and document one exact semantic model for legacy flags in mixed mode, then align all phases and examples to that model. Specifically resolve the conflict between Phase 1 (`native` only when both roles are native; `invoke` only when both are invoke) and Phase 3 text that wants `native` / `invoke` to act like “any native” / “any invoke” for cross-cutting sections.

## High Priority (P1)

### P1.1 — Dynamic agent inventory conflicts with current describe/uninstall architecture

The plan says plugin `describe()` should reflect which agents are installed based on delegation mode so `5x harness show` and uninstall stay accurate. That does not fit the current contract: `describe(scope?)` has no config input, `harness list` uses it without loading install-time state, and uninstall currently removes files by the static names returned from `describe()`. If config changes after install, a config-driven `describe()` can hide previously installed agent files and leave stale assets behind. This needs an explicit ownership model first: either keep `describe()` static and make install conditional only, or add persisted install metadata / config-aware uninstall semantics.

### P1.2 — Phase 1 misses required call-site updates for the expanded render context

The plan expands `SkillRenderContext` beyond `{ native: boolean }`, but it only schedules native harness loader changes later. Existing non-native call sites like `src/harnesses/universal/plugin.ts` and current `{ native: true/false }` renderer tests will stop type-checking unless the context shape stays constructible via defaults or every caller is updated in the same phase. This is mechanical, but it should be planned explicitly to keep Phase 1's completion gate honest.

## Medium Priority (P2)

- The proposed “integration-level” template rendering tests are better framed as unit tests in this repo: they call render functions directly and do not spawn the CLI.
- If `delegationMode` becomes part of resolved runtime config, consider whether `5x config show` text output should surface it for operator debugging; the plan currently leaves that implicit.

## Readiness Checklist

**P0 blockers**
- [ ] Resolve and document one unambiguous mixed-mode truth table for `native`, `invoke`, `author_*`, and `reviewer_*` template conditionals.

**P1 recommended**
- [ ] Redesign or narrow the `describe()` / uninstall changes so asset discovery remains correct even after config changes.
- [ ] Add explicit Phase 1 work for all `SkillRenderContext` call sites, including the universal harness and renderer test fixtures.
- [ ] Reclassify direct renderer/template coverage as unit tests.

## Addendum (2026-04-04) — Re-review after v1.1 revision

### What's Addressed

- Previous P0 is fixed: the plan now defines strict all-native/all-invoke semantics for legacy `native` / `invoke`, and introduces `any_native` / `any_invoke` for mixed-mode cross-cutting blocks.
- Previous P1 on dynamic agent inventory is fixed: the plan now keeps `describe()` static and defines install-time filtering plus config-independent uninstall behavior.
- Previous P1 on render-context call sites is fixed: Phase 1 now explicitly includes universal-harness, native-loader, and test-fixture updates.
- Prior P2 on test tiering is fixed: direct template rendering coverage is now correctly classified as unit testing.

### Remaining Concerns

- The plan now requires uninstall to remove managed assets by filesystem enumeration rather than static `describe()` names, but the phase checklist still does not name the concrete code changes needed in `src/harnesses/installer.ts` and plugin uninstall paths to implement that behavior. The design is sound; the implementation steps are just underspecified.
