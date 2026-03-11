# Review: Provider Process Lifecycle Cleanup

**Review type:** `docs/development/011-provider-process-lifecycle.md`
**Scope:** Plan correctness, architecture fit, phasing, risks, and testability against current provider lifecycle code in `src/commands/invoke.handler.ts`, `src/providers/opencode.ts`, `src/providers/factory.ts`, `src/db/connection.ts`, `src/lock.ts`, `src/bin.ts`, and contract/docs in `src/providers/types.ts`, `docs/v1/101-cli-primitives.md`
**Reviewer:** Staff engineer
**Local verification:** Not run

## Summary

The plan identifies a real leak path in `invoke.handler.ts` and is directionally right about consolidating provider cleanup. But the proposed cleanup mechanism is not yet technically sound: both the `process.on("exit")` hook and the suggested SIGINT/SIGTERM handling rely on an async `provider.close()`, which Node/Bun will not wait for during process exit. As written, the plan would still leak managed OpenCode children in the exact termination paths it claims to fix.

**Readiness:** Not ready — core cleanup semantics and termination ownership need design corrections before implementation.

## Strengths

- Correctly spots the immediate leak window in `src/commands/invoke.handler.ts` after provider creation and before the streaming try/catch.
- Pushes cleanup toward a single lifecycle owner instead of the current scattered `provider.close()` calls.
- Calls out the existing signal-handler landscape in `src/db/connection.ts` and `src/lock.ts`, which is necessary context for any global cleanup change.

## Production Readiness Blockers

### P0.1 — Exit and signal cleanup strategy is async-only, so it will not reliably clean up children

**Risk:** Managed `opencode` processes still leak on `process.exit()`, SIGINT, and SIGTERM because `activeProvider?.close()` returns a promise that exit handlers do not await.

**Requirement:** Revise the plan so termination cleanup is guaranteed under the runtime's actual semantics. That means either (a) make provider termination available through a synchronous/best-effort kill path that can run safely inside exit/signal handlers, or (b) define an async signal-handling flow that delays process exit until provider shutdown completes and clearly composes with the existing handlers in `src/db/connection.ts` and `src/lock.ts`. The plan must stop relying on `process.on("exit")` awaiting async cleanup.

**Action:** `human_required` — this is an architecture decision, not a mechanical doc fix.

## High Priority (P1)

### P1.1 — The plan's stated failure modes exceed what the proposed mitigations can actually solve

The problem statement includes parent death via SIGKILL/OOM and explicitly calls out missing process-group management, but the mitigation phases do not include a concrete answer for that class of orphaning. `process.on("exit")` and SIGINT/SIGTERM hooks cannot help when the parent is hard-killed. If the plan wants to claim coverage there, it needs a real mechanism and trade-off decision: process-group strategy, parent-death detection, SDK change, or an explicit scope reduction that says SIGKILL/OOM orphaning is out of scope for this iteration.

**Action:** `human_required`

### P1.2 — SDK escalation path is underspecified and blocks phase completion

`src/providers/opencode.ts` only holds the SDK's `{ url, close() }` server handle today; it has no exposed process handle or force-kill API. Phase 2 says "or SDK contribution" but does not decide which layer owns that work, what the fallback is if upstream support is absent, or how completion will be judged in-repo. That leaves a major dependency unresolved in the middle of the plan.

**Action:** `human_required`

### P1.3 — Test strategy is missing for the exact regressions this plan is meant to prevent

The plan names files to touch, but not the verification needed to prove cleanup works. Add explicit completion gates and tests for: provider closes on pre-stream failures in `invoke.handler.ts`; signal-driven cleanup executes once and composes with existing lock/DB handlers; managed-provider close escalates when graceful shutdown stalls; external-provider mode is unaffected; and no duplicate/stacked signal registrations occur across repeated invocations in one process.

**Action:** `auto_fix`

## Medium Priority (P2)

- Scope the cleanup registry at the provider-lifecycle layer, not as an `invoke.handler.ts` module global, unless the plan explicitly intends provider cleanup to remain command-local. The current proposal fixes today's caller but bakes lifecycle policy into one command file.

## Readiness Checklist

**P0 blockers**
- [ ] Replace the async-only exit/signal cleanup design with a termination strategy that is valid under process-exit semantics.

**P1 recommended**
- [ ] Decide whether SIGKILL/OOM orphan prevention is in scope and document the concrete mechanism or explicit non-goal.
- [ ] Decide where SIGKILL escalation is implemented when the SDK does not expose a force-kill primitive.
- [ ] Add concrete tests and completion gates for pre-stream failures, signal cleanup, escalation, and external-provider behavior.

## Addendum (2026-03-09) — v2 plan follow-up

### What's Addressed

- The revised plan fixes the main v1 flaw by separating async signal-path cleanup from a synchronous `process.on("exit")` last-resort kill path instead of assuming exit hooks await `provider.close()`.
- Cleanup ownership now sits in a dedicated `src/providers/lifecycle.ts` module rather than an `invoke.handler.ts` global, which is a better architectural fit.
- The plan now includes explicit completion gates and a concrete test matrix for pre-stream failures, duplicate handler registration, escalation, and external-provider behavior.

### Remaining Concerns

- `P0.1` remains open: Phase 1 still claims signal cleanup before PID tracking exists, but its own design registers `registerProvider(provider, null)`. If `src/db/connection.ts` or `src/lock.ts` handles SIGINT/SIGTERM first and immediately calls `process.exit()`, the lifecycle module's async handler never gets to await `provider.close()`, and the exit handler has no PID to kill in Phase 1. The plan therefore does not yet guarantee signal-path cleanup until Phase 2, so the phase boundaries and acceptance criteria are overstated.
- `P1.1` remains open in a different form: DD2's process-group reasoning is not technically solid. Keeping the child in the default process group does not mean the kernel will reliably kill it when the parent dies in automated/non-terminal contexts, and the plan itself acknowledges gaps immediately after claiming coverage. Tighten this to an explicit non-goal for hard-kill orphan prevention, or specify a mechanism that actually provides it.
- `P1.2` is replaced by a new design concern: PID discovery via before/after `opencode` process-list diffing is too heuristic for a lifecycle primitive. It can misidentify the wrong process when multiple `opencode` instances start concurrently, when unrelated `opencode` processes already exist, or when the child exits/restarts during sampling. Because a false positive could `SIGKILL` the wrong process, this needs a safer ownership mechanism or an explicit constraint proving the heuristic is safe in this environment.
- `P2.1`: the plan mixes `createOpencode()` and `createOpencodeServer()` naming even though current code uses `createOpencode()` from `@opencode-ai/sdk/v2` in `src/providers/opencode.ts`. Align the plan with the real API surface so implementation scope is unambiguous.

## Addendum (2026-03-09) — v3 plan follow-up

### What's Addressed

- The revised plan fully resolves the earlier hard blockers: Phase 1 now explicitly limits itself to try/finally and normal-exit cleanup, so the phase no longer over-claims signal-path guarantees before PID tracking exists.
- SIGKILL/OOM orphan prevention is now correctly treated as an explicit non-goal, with the misleading process-group coverage claim removed.
- PID ownership now comes from a direct SDK patch exposing `pid` on the managed server handle, which is materially safer than process-list diffing and fits the existing `src/providers/opencode.ts` abstraction.
- API naming is aligned with the current implementation: the plan now consistently references `createOpencode()` from `@opencode-ai/sdk/v2`.

### Remaining Concerns

- `P2.1`: the plan assumes a local SDK patch mechanism (`patch-package` or equivalent), but the repo does not currently show any patch-management setup in `package.json`. Add the concrete patch workflow, touched files, and validation gates needed to ensure the patch is applied in local dev, CI, and release builds. This is mechanical, but the plan should make it explicit.
- `P2.2`: the Phase 2 completion gates should explicitly verify the unpatched/upgrade-failure mode. If the SDK patch is missing or no longer applies after a dependency bump, provider startup should fail loudly or tests should catch it immediately, rather than silently dropping back to no PID and weaker cleanup semantics.

## Addendum (2026-03-09) — v4 plan follow-up

### What's Addressed

- The plan now specifies the patch workflow concretely: `patch-package` setup, `postinstall`, exact SDK pinning, CI/install validation, and a runtime startup assertion when `server.pid` is missing.
- The previous patch-drift concern is now covered by both completion gates and test strategy, so the core lifecycle plan is implementation-ready.

### Remaining Concerns

- `P2.3`: the patch-distribution story is still incomplete for published installs. `package.json` currently ships only `src` via the `files` whitelist, so a future implementation that adds `postinstall` plus `patches/@opencode-ai+sdk+*.patch` must also ensure the `patches/` directory is included in the published package (or use an equivalent release-time mechanism). Otherwise local dev/CI may work while npm consumers miss the patch entirely. This is a mechanical packaging correction, not a design blocker.

## Addendum (2026-03-09) — v5 plan follow-up

### What's Addressed

- The plan now closes the packaging gap by explicitly adding `patches/` to the `package.json` `files` array, updating the patch-workflow section, and adding tarball-level verification via `bun pack`.
- Completion gates, files-touched, and test strategy now cover the full lifecycle of the SDK patch: local install, CI install, runtime assertion, and published-package contents.

### Remaining Concerns

- No further plan-level issues found. The remaining work is implementation and verification against the stated completion gates.
