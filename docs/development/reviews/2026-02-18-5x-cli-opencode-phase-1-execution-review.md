# Review: 5x CLI OpenCode Refactor — Phase 1 Execution

**Review type:** `ce61bca62f`  \
**Scope:** Phase 1 of `docs/development/003-impl-5x-cli-opencode.md` (Prune Claude Code harness; SDK install; config + type surface prep)  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, operability, test strategy)  \
**Local verification:** `bun test --concurrent --dots` (301 pass); `bun run typecheck` (pass)

**Implementation plan:** `docs/development/003-impl-5x-cli-opencode.md` (Phase 1)  \
**Technical design:** `docs/development/001-impl-5x-cli.md` (baseline)

## Summary

This commit is a solid mechanical Phase 1 landing: it removes the Claude Code harness + tests, installs `@opencode-ai/sdk`, and reshapes config/types to prepare for an OpenCode adapter + structured output refactor. Test suite remains green.

The main staff-level concern is phase drift vs the Phase 1 checklist: `init` still generates deprecated `adapter` config (and defaults to `claude-code`), and `makeOnEvent()` remains present/used despite the plan stating it was removed. These aren’t fatal for the refactor branch, but they increase user confusion and increase later churn.

**Readiness:** Ready with corrections — proceed to Phase 2, but reconcile Phase 1 checklist drift first.

---

## What shipped

- **Agent harness pruning:** Deleted `5x-cli/src/agents/claude-code.ts` and its tests.
- **Formatter continuity:** Renamed `5x-cli/src/utils/ndjson-formatter.ts` to `5x-cli/src/utils/sse-formatter.ts` and updated imports.
- **OpenCode SDK dependency:** Added `@opencode-ai/sdk` to `5x-cli/package.json` (and lockfile).
- **Config schema update:** Removed adapter selection from config; added `author.model` / `reviewer.model` in `5x-cli/src/config.ts`.
- **Adapter contract scaffolding:** Introduced new `AgentAdapter` interface + structured result types in `5x-cli/src/agents/types.ts`; `5x-cli/src/agents/factory.ts` now throws a clear “not yet implemented” error.

---

## Strengths

- **Tight mechanical change-set:** large deletion with minimal collateral damage; remaining tests updated and still pass.
- **Clear failure mode:** factory throws with an explicit Phase 1/Phase 3 message (better than silent misbehavior).
- **Keeps a formatter module in-place:** rename (vs delete) reduces churn when Phase 3 rewires console streaming.
- **Config surface moves in the right direction:** per-role model config aligns with planned single-adapter architecture.

---

## Production readiness blockers

### P0.1 — Phase 1 checklist drift: init still generates deprecated adapter config

**Risk:** `5x-cli/src/commands/init.ts` still emits `author.adapter` / `reviewer.adapter` (and defaults to `claude-code`). Given `FiveXConfigSchema` no longer recognizes `adapter`, this creates a config file that appears meaningful but is silently ignored, and it advertises a harness that no longer exists.

**Requirement:** `5x init` must generate a config that matches `FiveXConfigSchema` and the OpenCode-only direction (no `adapter` fields).

**Implementation guidance:** Update `5x-cli/src/commands/init.ts` to output `author.model` / `reviewer.model` examples and remove all `claude-code` detection/mentions (or, if you want detection, detect OpenCode presence and still only emit model stubs).

---

## High priority (P1)

### P1.1 — Plan/implementation mismatch: `makeOnEvent()` not actually removed

Plan Phase 1 states `makeOnEvent()` is removed; code still exports it in `5x-cli/src/utils/agent-event-helpers.ts` and orchestrators still import it. Either remove it now (and update imports/callers) or explicitly re-scope the Phase 1 checklist so future reviewers don’t assume it’s gone.

### P1.2 — CLI error UX for the intentional “non-functional window”

With `createAndVerifyAdapter()` throwing, `5x plan`, `5x plan-review`, and `5x run` can fail with stack traces. Prefer a single, user-facing error message that points to the plan/state (“OpenCode adapter not implemented yet; see Phase 3 of 003”), and exit cleanly.

---

## Medium priority (P2)

- **Config safety:** Zod strips unknown keys by default; consider warning on deprecated keys like `author.adapter` / `reviewer.adapter` to fail-loud on typos and reduce confusion.
- **SSE formatter performance guardrails (future):** `safeInputSummary()` still tries `JSON.stringify()` on tool inputs; when adapting to OpenCode SSE events, ensure formatting is bounded to avoid huge transient allocations.

---

## Readiness checklist

**P0 blockers**
- [ ] Update `5x-cli/src/commands/init.ts` to generate a schema-valid, OpenCode-only config (no adapter fields; model examples).

**P1 recommended**
- [ ] Reconcile Phase 1 plan vs code on `makeOnEvent()` (remove it or update the plan checklist).
- [ ] Improve command-level error handling for the temporary “adapter not implemented” state.

