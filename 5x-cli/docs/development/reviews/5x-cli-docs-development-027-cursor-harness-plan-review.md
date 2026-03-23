# Review: Cursor Harness for Native 5x Workflows

**Review type:** `docs/development/027-cursor-harness/plan.md`
**Scope:** Cursor harness implementation plan, shared harness rule support, Cursor assets, tests, and rollout gates
**Reviewer:** Staff engineer
**Local verification:** Not run (static review: plan, PRD, current harness implementation)

## Summary

The plan is directionally strong and tracks the PRD well on asset shape, shared-rule support, and test coverage. But it is not implementation-ready yet: it drops the PRD's upfront verification gate for Cursor discovery/worktree assumptions, and it does not define a scope-aware contract that lets `harness list` represent `rules: unsupported` without guessing from install results.

**Readiness:** Not ready — one missing release-gate phase and one unresolved handler/plugin contract gap require plan changes before implementation.

## Strengths

- Good architectural reuse of the existing harness model (`plugin.ts`, loaders, installer helpers) instead of inventing a Cursor-only path.
- Clear asset inventory and good test intent around model injection, list/install/uninstall parity, and worktree-specific manual verification.

## Production Readiness Blockers

### P0.1 — Restore the PRD's Phase 0 verification gate before broad implementation

**Risk:** The PRD treats Cursor path discovery, rule behavior, omitted-`model` semantics, and worktree editing as ship-blocking assumptions. This plan moves those checks to the end as manual verification, so implementation could proceed on dead assumptions and require expensive rework late.

**Requirement:** Add an explicit first phase/gate that verifies live Cursor discovery behavior and worktree execution assumptions before Phases 1-5 proceed, matching the PRD's Phase 0 intent.

**Action:** `human_required` — this is a phasing/scope decision, not just a wording fix.

### P0.2 — Define a scope-aware contract for `rules: unsupported` in `harness list`

**Risk:** The current handler model derives list state from `plugin.describe()` plus filesystem checks. In the proposed design, `describe()` is global while Cursor rule support is scope-dependent. As written, the plan says list output should show `rules: unsupported` “when harness reports it,” but does not specify how list obtains that data without abusing install-time results or hard-coding Cursor special cases.

**Requirement:** Extend the plan with a concrete, typed, scope-aware mechanism for list/status reporting (for example, per-scope asset capabilities/unsupported metadata from the plugin) and reflect that in handler types, JSON shape, and tests.

**Action:** `human_required` — this needs an API/contract choice.

## High Priority (P1)

### P1.1 — Re-add Windows verification to match the PRD release bar

The PRD explicitly keeps Windows user/project discovery as a pre-ship verification item, but this plan's verification checklist only calls out macOS/Linux. If Windows remains in product scope, the plan should preserve that release gate so docs and support expectations do not outrun validation.

**Action:** `auto_fix` — update the checklist/phase text to match the PRD.

## Medium Priority (P2)

- The plan should explicitly tie `test/unit/commands/harness.test.ts` assertions to the new scope-aware unsupported/rules JSON shape so handler regressions are caught at the unit layer, not only via integration coverage. **Action:** `auto_fix`

## Readiness Checklist

**P0 blockers**
- [ ] Add a true Phase 0/live-verification gate before implementation phases begin
- [ ] Specify a scope-aware plugin/handler contract for `rules: unsupported` in `harness list`

**P1 recommended**
- [ ] Restore Windows verification requirements from the PRD
- [ ] Add explicit unit-test expectations for the new unsupported/rules list schema
