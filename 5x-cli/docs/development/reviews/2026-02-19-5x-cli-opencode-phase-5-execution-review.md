# Review: 5x CLI OpenCode Refactor — Phase 5 Execution (Command Layer + Templates)

**Review type:** `e527330c372`  
**Scope:** Phase 5 of `5x-cli/docs/development/003-impl-5x-cli-opencode.md` (command layer wiring, adapter lifecycle, factory enablement, template protocol updates, legacy type removal)  
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, performance, operability, test strategy)  
**Local verification:** `bun test --concurrent --dots` in `5x-cli/` (359 pass, 1 skip)

**Implementation plan:** `5x-cli/docs/development/003-impl-5x-cli-opencode.md` (Phase 5)  
**Technical design:** `5x-cli/docs/development/001-impl-5x-cli.md` (baseline)

## Summary

This lands the Phase 5 “bridge completion”: commands now use the OpenCode structured adapter directly, the factory returns a real managed `OpenCodeAdapter`, legacy signal parsing/types are removed, and templates are updated to stop instructing agents to emit `5x:status`/`5x:verdict` blocks. Overall direction is correct and the test suite is green.

The primary staff-level risk is lifecycle correctness: several post-adapter `process.exit()` paths can bypass `finally` and leak the managed server. Secondary risk is log privacy/tenancy: log directory permissions are not consistently `0700` for all commands.

**Readiness:** Ready with corrections — fix P0 lifecycle + log-perms issues before moving on to Phase 6.

---

## What shipped

- **Factory enabled:** `5x-cli/src/agents/factory.ts` now spawns/verifies a managed `OpenCodeAdapter`.
- **Command wiring:** `5x-cli/src/commands/run.ts`, `5x-cli/src/commands/plan-review.ts`, `5x-cli/src/commands/plan.ts` create one adapter and pass it through.
- **Adapter lifecycle hooks:** `adapter.close()` added to `finally` blocks (but see P0.1).
- **Legacy removal:** `5x-cli/src/utils/legacy-signals.ts` deleted; legacy adapter/result types removed from `5x-cli/src/agents/types.ts`.
- **Template protocol update:** `5x-cli/src/templates/*.md` no longer reference `5x:status` / `5x:verdict` instructions; tests updated.

---

## Strengths

- Structured output protocol is now consistent end-to-end (templates → adapter → orchestrator; no free-text parsing).
- Adapter lifetime is now explicit at the command layer (single managed server per command invocation).
- Legacy surface area is actually deleted (reduces “dual interface” complexity and runtime type-lie risk).
- Tests cover the key regressions from earlier phases and remain fast.

---

## Production readiness blockers

### P0.1 — `process.exit()` can bypass `adapter.close()` (managed server leak)

**Risk:** After the adapter is created, `process.exit()` can skip async `finally` cleanup. This leaks the managed OpenCode server and can leave ports/processes dangling (non-deterministic behavior across repeated runs; worse Ctrl-C story).

**Requirement:** Once the adapter is initialized, commands must not call `process.exit()`; use `process.exitCode = 1` and `return` so `finally { await adapter.close() }` runs.

**Implementation guidance:** Replace post-adapter `process.exit(1)` in `5x-cli/src/commands/run.ts`, `5x-cli/src/commands/plan-review.ts`, `5x-cli/src/commands/plan.ts`.

### P0.2 — Log directory permissions inconsistent (tenancy/privacy)

**Risk:** `.5x/logs/<runId>` can end up group/world-readable depending on umask if created implicitly by the adapter (`mkdirSync(..., { recursive: true })` without `mode`). Logs may contain sensitive content.

**Requirement:** Ensure log directories are created with `0700` for all commands/paths (including `plan` which computes `logPath` but does not create `logDir` itself).

**Implementation guidance:** Either (a) create the run log dir explicitly in `5x-cli/src/commands/plan.ts` with `mode: 0o700`, or (b) enforce `0o700` inside `writeEventsToLog()` when creating directories.

---

## High priority (P1)

### P1.1 — Environment-dependent test can be flaky

`5x-cli/test/agents/opencode.test.ts` asserts `createAndVerifyAdapter({})` rejects when server unavailable. On machines where OpenCode is installed/available, this can fail.

Recommendation: make the assertion hermetic (accept success-or-actionable-error like `factory.test.ts`), or gate live server expectations behind an env flag.

### P1.2 — Factory config typing is overly loose

`createAndVerifyAdapter()` accepts `Record<string, unknown>` but the project defines `AdapterConfig` in `5x-cli/src/agents/types.ts`. This is a correctness/maintainability footgun (harder to validate config shape, harder to refactor).

Recommendation: type the parameter as `AdapterConfig` and validate unknown inputs at the config boundary.

---

## Medium priority (P2)

- **Signals/exit handling:** `registerLockCleanup()` uses `process.exit()` in signal handlers; consider a command-owned shutdown path that can also close the adapter on SIGINT/SIGTERM.
- **Model selection semantics:** `createAndVerifyAdapter(config.author)` uses author model as default model for the adapter; this is fine, but worth documenting that reviewer model is per-invoke override (already implemented).

---

## Readiness checklist

**P0 blockers**
- [ ] Remove post-adapter `process.exit()` so `adapter.close()` always runs.
- [ ] Enforce `0700` permissions for `.5x/logs/<runId>` across commands.

**P1 recommended**
- [ ] Make adapter factory tests hermetic (avoid environment-dependent pass/fail).
- [ ] Tighten `createAndVerifyAdapter()` typing to `AdapterConfig`.

---

## Phase alignment / next-phase readiness

**Implementation plan phase(s):** `5x-cli/docs/development/003-impl-5x-cli-opencode.md` Phase 5

- **Phase 5 completion:** ⚠️ — feature-complete, but P0 lifecycle/privacy items must be fixed.
- **Ready for Phase 6:** ⚠️ — proceed after P0s are addressed.

---

## Addendum (2026-02-19) — Feedback Closure Review

**Reviewed:** `4fa5d32cdc7`

**Local verification:** `bun test --concurrent --dots` in `5x-cli/` (359 pass, 1 skip)

### Updated assessment

- **Correctness:** P0 lifecycle issue is resolved: post-adapter error paths now use `process.exitCode` + `return`, preserving `finally { await adapter.close() }` in `5x-cli/src/commands/run.ts`, `5x-cli/src/commands/plan-review.ts`, `5x-cli/src/commands/plan.ts`.
- **Tenancy/security:** Log directory creation is now forced to `0700` at the actual creation site used by all commands (`writeEventsToLog()` in `5x-cli/src/agents/opencode.ts`). This closes the “umask could make logs world-readable” gap for new runs.
- **Architecture:** `createAndVerifyAdapter()` is now typed to `AdapterConfig` (reduces config shape drift). Model override semantics are documented in `5x-cli/src/agents/factory.ts`.
- **Operability:** Signal-safe cleanup added via `registerAdapterShutdown()` in `5x-cli/src/agents/factory.ts`, used by commands, ensuring managed server teardown on SIGINT/SIGTERM by routing termination through `process.exit()`.
- **Test strategy:** Factory test made hermetic (success-or-actionable-error) in `5x-cli/test/agents/opencode.test.ts`.

### Items closed

- **P0.1 (`process.exit()` bypasses adapter close):** ✅ closed
- **P0.2 log perms not consistently `0700`:** ✅ closed for newly-created log dirs
- **P1.1 environment-dependent factory test:** ✅ closed
- **P1.2 factory config typing:** ✅ closed
- **P2 signal shutdown gap:** ✅ closed (new `registerAdapterShutdown()`)

### Remaining concerns / follow-ups

- **P2 log dir hardening for pre-existing directories:** `mkdirSync(..., { mode: 0o700 })` does not change permissions if `.5x/logs` already exists with broader perms from older versions. Consider best-effort `chmod` or a one-time warning if existing perms are not `0700`.
- **P2 handler idempotency:** `registerAdapterShutdown()` uses `process.on` (not `once`) and does not guard against double-registration. Fine for CLI, but could bite in long-lived embedding/tests.

### Updated readiness

- **Phase 5 completion:** ✅ — review items addressed; safe to treat Phase 5 as complete.
- **Ready for Phase 6:** ✅
