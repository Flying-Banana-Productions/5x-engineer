# Review: Cursor Agent Provider Plugin

**Review type:** `docs/development/plans/022-cursor-agent-provider.md`
**Scope:** Plan review for the external Cursor Agent provider plugin, provider/session design, config surface, and test strategy.
**Reviewer:** Staff engineer
**Local verification:** Static review of the plan plus related provider architecture/docs (`src/providers/types.ts`, `src/providers/factory.ts`, `packages/provider-claude-code/`, `packages/provider-sample/`). `5x plan phases docs/development/plans/022-cursor-agent-provider.md` parses successfully. No live Cursor invocation run.

## Summary

The overall direction is sound: a `cursor-agent` plugin fits the existing external-provider factory and the plan does a good job separating pure mapping logic from subprocess/session lifecycle. But the plan is not ready as written. One reviewer-safety decision is still unresolved even though the design already hard-codes `--force` by default, and the package scaffold omits the peer dependency shape already used by the repo's other provider plugins.

**Readiness:** not_ready - unresolved reviewer mutation policy and an incomplete plugin package contract should be fixed before implementation starts.

## Strengths

- Reuses the current `ProviderPlugin` / `AgentProvider` contract cleanly instead of inventing a Cursor-specific execution path.
- Separates config parsing, argv building, env shaping, prompt wrapping, event mapping, and session lifecycle into testable modules; that matches the existing Claude provider structure.
- Adds both a mock integration path and an opt-in live probe, which is the right shape for a brittle CLI contract.

## Production Readiness Blockers

### P0.1 - Reviewer `--force` policy is unresolved while the design already defaults it on

**Action:** `human_required`

**Risk:** DD2 makes `--force` the default for all Cursor runs, which explicitly enables direct file changes and command execution in headless mode. The same plan then leaves the reviewer case open as an unresolved question. A literal implementation could therefore ship `5x invoke reviewer ... --reviewer-provider cursor-agent` with mutation authority by default, without an explicit product decision on whether reviewer safety is behavioral-only or role-enforced.

**Requirement:** Resolve this in the plan before implementation. Either make the default role-aware (for example author-on, reviewer-off), or explicitly document that reviewer non-edit behavior is prompt/policy only and update the goals/tests to match that weaker contract.

**Evidence:**
- Default `--force` in DD2: `docs/development/plans/022-cursor-agent-provider.md:121-127`
- Reviewer default still open: `docs/development/plans/022-cursor-agent-provider.md:527-534`
- Prior repo review required an explicit product call when reviewer mutation policy was ambiguous: `docs/development/reviews/014-harness-native-subagent-orchestration.review.md:796-818`

## High Priority (P1)

### P1.1 - Package scaffold misses the peer dependency contract used by every existing provider plugin

**Action:** `auto_fix`

Phase 1 only specifies package name, module type, exports, and a root workspace devDependency. But provider packages in this repo also declare a peer dependency on `@5x-ai/5x-cli`, which is the host contract they import types/runtime from. Leaving that out makes the package scaffold incomplete and blurs the difference between the root test-only workspace install and the plugin's own published/runtime dependency shape.

**Recommendation:** Add the peer dependency stanza to the package scaffold (and note separately that the root `workspace:*` devDependency is only for local dynamic-import resolution/tests).

**Evidence:**
- New scaffold omits peer dependency details: `docs/development/plans/022-cursor-agent-provider.md:294-299`
- Existing provider plugins include the host peer dependency: `packages/provider-sample/package.json:1-12`, `packages/provider-claude-code/package.json:1-12`

## Medium Priority (P2)

- **Action:** `auto_fix` - Resolve the naming question before implementation or remove it from “Open Questions.” The design already commits to `cursor-agent` / `[cursor-agent]`, so leaving `cursor` vs `cursor-agent` open adds avoidable ambiguity for package/config names (`docs/development/plans/022-cursor-agent-provider.md:96-110`, `:527-531`).

## Readiness Checklist

**P0 blockers**
- [ ] Make one explicit reviewer mutation-policy decision for Cursor (`--force` default and expected safety contract).

**P1 recommended**
- [ ] Add the provider package's `peerDependencies` contract to the Phase 1 scaffold.
- [ ] Remove or resolve the remaining provider-name ambiguity before implementation.

## Addendum — 2026-05-24

The updated plan fixes the two issues from the initial review:

- Reviewer safety policy is now explicit: default `--force` is author-on / reviewer-off, with `[cursor-agent].force` as an override.
- Phase 1 now includes the provider package `peerDependencies` contract.

However, the revised plan still is not implementation-ready because the new role-aware default depends on information the current external-plugin contract does not provide.

### P0.2 - Role-aware `--force` default cannot be implemented via the current plugin contract

**Action:** `human_required`

**Risk:** The plan now requires `force` to default differently for author vs reviewer runs when config leaves it unset. But external provider plugins are instantiated through `ProviderPlugin.create(config?)`, and the factory only passes the top-level `[cursor-agent]` object into that call. Neither the plugin config parser nor `SessionOptions` / `ResumeOptions` carry the invocation role. As written, the implementation cannot tell whether an unset `force` value should resolve to author `true` or reviewer `false` without first changing the provider contract or the config passed into plugins.

**Requirement:** Update the plan to explicitly choose one of these approaches before implementation:

1. Extend plugin creation/input shape so external plugins receive the role (or a pre-resolved `force` default) from `createProvider(role, config)`.
2. Move the role-aware defaulting into core config/factory code and pass only a concrete boolean into the plugin.
3. Drop role-aware defaulting from the plugin contract and require an explicit `[cursor-agent].force` decision.

**Evidence:**
- Role-aware default now required by the plan: `docs/development/plans/022-cursor-agent-provider.md:121-127`, `:318-326`, `:331-346`
- External plugin contract only exposes `create(config?)`: `src/providers/types.ts:97-104`
- Factory only passes top-level plugin config, not role metadata: `src/providers/factory.ts:116-130`, `:154-172`

## Updated Readiness

**Readiness:** not_ready - previous blockers are fixed, but the plan still depends on a role-aware defaulting mechanism that the current external-provider contract cannot express.

## Updated Checklist

**P0 blockers**
- [ ] Resolve where role-aware `force` defaulting lives (plugin contract vs core factory/config) so the design is implementable.

## Addendum — 2026-05-24 (rereview)

The latest plan revision addresses the remaining implementation blocker.

- The role-aware `force` default has been removed; the design is back to one provider-wide default (`true`) with an explicit `force=false` escape hatch.
- That behavior now matches the current external plugin contract, which only passes top-level plugin config into `ProviderPlugin.create(config?)`.
- The earlier package-contract omission also remains fixed via the explicit `peerDependencies` scaffold item.

## Final Readiness

**Readiness:** ready - the plan is now internally consistent with the current provider factory/plugin contract and is specific enough to implement.

## Final Checklist

- [x] Provider package scaffold includes the host `peerDependencies` contract.
- [x] `--force` default semantics are explicit and implementable with today's plugin API.
