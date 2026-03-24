# Review: Universal Harness and Shared Skill Templates

**Review type:** docs/development/028-universal-harness.plan.md
**Scope:** Plan, referenced harness/skill source, invoke/template handlers, and active harness command surface.
**Reviewer:** Staff engineer
**Local verification:** Not run (static review only)

## Summary

The direction is good: a shared skill-template source plus an invoke-only fallback harness fits the current architecture better than cloning another full harness tree. But the plan is not implementation-ready yet. It makes a broad product claim about agentskills.io auto-discovery without a validation/scope decision, and several phase/tasks are internally inconsistent with the current CLI surface and with the existing skill content that must become invoke-safe.

**Readiness:** Not ready — one support-contract decision and one blocking completeness gap remain.

## Strengths

- Good architectural reuse: shared template/base-skill rendering builds on the existing harness plugin and installer model instead of inventing a parallel install path.
- Sound separation of concerns: universal keeps orchestration in the host tool and uses `5x invoke` as the transport-neutral execution primitive.
- Test intent is directionally right: renderer, shared loader, harness plugin, and integration coverage are all called out.

## Production Readiness Blockers

### P0.1 — The plan needs an explicit support/validation contract for the “universal” promise

**Classification:** human_required

**Risk:** The plan currently promises that “any compliant client” will auto-discover and use the installed skills, but the implementation tasks only verify files on disk. That leaves a product-level gap: either 5x is shipping a standards-only best-effort harness with narrow support claims, or it is claiming real interoperability across tools like Claude Code/Windsurf/custom setups without a validation gate.

**Requirement:** Add an explicit pre-implementation or pre-ship decision/gate that answers one of these:
- narrow the product claim to “standards-based/best-effort install only,” with docs saying discovery/orchestration depends on the host client, or
- define a validated client/support matrix and add live verification steps for the clients 5x intends to claim support for.

**Evidence:**
- Broad interoperability claim: `docs/development/028-universal-harness.plan.md:9-29`, `38-42`
- Current verification only checks written files/content, not client discovery/behavior: `docs/development/028-universal-harness.plan.md:353-359`, `464-468`

### P0.2 — The invoke-path conversion inventory is incomplete; “shared” sections still contain native-only instructions

**Classification:** auto_fix

**Risk:** As written, the plan will leave invoke-rendered skills with stale `Task tool`, `task_id`, and `5x protocol validate` guidance in sections it labels “shared.” That would make the universal harness internally contradictory and unreliable for real use.

**Requirement:** Expand the template-conversion tasks to cover every native-only reference in the current skills, not just the main delegation blocks. At minimum, update the plan to explicitly conditionalize the affected Gotchas/Tools/recovery/session-reuse/worktree text in:
- `5x-plan` (`src/harnesses/opencode/skills/5x-plan/SKILL.md:29-47`, `119-129`)
- `5x-plan-review` (`src/harnesses/opencode/skills/5x-plan-review/SKILL.md:27-48`, `217-239`)
- `5x-phase-execution` (`src/harnesses/opencode/skills/5x-phase-execution/SKILL.md:42-90`)

The completion gates/tests should also assert that invoke-rendered output no longer contains those native-only references outside intentionally native branches.

## High Priority (P1)

### P1.1 — Fix the plan’s `harness list` command shape to match the actual CLI

**Classification:** auto_fix

The plan repeatedly says `5x harness list universal`, but the current CLI exposes `5x harness list` with no harness-name argument (`src/commands/harness.ts:58-67`). Either update the plan/tests/docs to inspect the `universal` entry in `5x harness list`, or explicitly add a separate filtering feature if that is truly desired.

### P1.2 — Resolve the phase overlap between Phase 2 invoke assertions and Phase 4 invoke authoring

**Classification:** auto_fix

Phase 2 already expects `renderAllSkillTemplates({ native: false })` to produce valid invoke-oriented output and tests for `5x invoke` references (`docs/development/028-universal-harness.plan.md:255-261`), but Phase 4 is where the invoke-path content is supposedly authored (`367-438`). Tighten the sequencing so the plan has one clear phase that introduces invoke content and a later phase that only verifies/refines it.

## Medium Priority (P2)

- Call out the existing project-scope `5x init` prerequisite in `harnessInstall` (`src/commands/harness.handler.ts:112-120`) when documenting/verifying `5x harness install universal --scope project`, or explicitly plan a handler change if universal installs are meant to work before init. **Classification:** auto_fix

## Readiness Checklist

**P0 blockers**
- [ ] Decide whether universal is a standards-based best-effort install or a validated supported-client product, and add the matching verification/docs gate.
- [ ] Expand the invoke-path template conversion scope so all native-only guidance is conditionalized, not just the main delegation snippets.

**P1 recommended**
- [ ] Align all `harness list` references/tests with the current CLI shape.
- [ ] Remove the Phase 2/Phase 4 overlap so invoke content is introduced and verified in a consistent order.
