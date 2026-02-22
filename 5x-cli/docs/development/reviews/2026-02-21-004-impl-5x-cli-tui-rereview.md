# Review: 5x CLI — TUI Integration (Re-review)

**Review type:** Implementation re-review vs `docs/development/004-impl-5x-cli-tui.md` (v1.7)
**Reviewed:** `ae6e28362163b77b4076cd43d82e02f6bf83ac25`
**Scope:** TUI integration for `5x run` / `5x plan-review` / `5x plan` (Phases 1-5) + Phase 6 readiness
**Reviewer:** Staff engineer (correctness, reliability, security/tenancy, UX/DX, operability, test strategy)
**Local verification:** `bun test` PASS (525 pass, 6 skip); `bun run typecheck` PASS

**Implementation plan:** `docs/development/004-impl-5x-cli-tui.md`
**Related reviews (reference only):** `docs/development/reviews/2026-02-20-004-impl-5x-cli-tui-review.md`

## Summary

Phases 1-4 are mostly in good shape (ephemeral ports, stdout quiet-gating while TUI owns the terminal, cooperative cancellation plumbing, session focus via `onSessionCreated`). The current Phase 5 implementation is not actually a human gate in TUI mode: it uses `client.session.prompt()` which requests a model response, so non-auto mode can silently behave like auto and proceed without a person. Separately, the “continue headless”/fallback story for TUI spawn failure and early exit is not consistent: policy/gate selection is based on `isTuiMode` (detection) rather than whether a TUI is actually running, which can create hangs (permissions) or spurious aborts (gates).

**Readiness:** Not ready to treat Phase 5+6 as complete; fix P0s first.

---

## Strengths

- Ephemeral OpenCode server port + `serverUrl` surfacing is correct (`src/agents/opencode.ts`).
- Output ownership is largely enforced via `quiet: () => effectiveQuiet || tui.active` + loop-level log gating (`src/orchestrator/phase-execution-loop.ts`, `src/orchestrator/plan-review-loop.ts`).
- Cooperative cancellation is end-to-end (command `AbortController` -> loop checks -> adapter aborts prompt + SSE) (`src/agents/opencode.ts`, both orchestrators).
- Session focus hook is the right abstraction (`InvokeOptions.onSessionCreated`) and is wired consistently in the orchestrators.

---

## Production readiness blockers

### P0.1 - Phase 5 “human gates” in TUI mode are model-driven, not human-driven

**Risk (correctness/UX):** In TUI mode, gates are supposed to block on a human decision. Current `src/tui/gates.ts` uses `client.session.prompt()` + JSON schema to obtain the gate “decision”, which is a model response (same primitive used for author/reviewer work in `src/agents/opencode.ts`). This can allow non-auto runs to proceed without any human confirmation and undermines the contract of `--auto` vs non-auto.

**Requirement:** TUI gates must wait for explicit user input (via a real TUI control channel or a deterministic user-message subscription) and must be impossible for the model to satisfy on the user’s behalf.

**Where:** `src/tui/gates.ts`, `src/commands/run.ts`, `src/commands/plan-review.ts`.

### P0.2 - TUI spawn failure does not safely fall back (permissions + gates can hang/abort)

**Risk (operability):** `createTuiController()` can fall back to a no-op controller on spawn failure (`src/tui/controller.ts`), but commands still treat `isTuiMode` as “TUI exists” when selecting:

- permission policy (`tui-native` becomes a no-op handler) (`src/commands/run.ts`, `src/commands/plan-review.ts`, `src/commands/plan.ts`)
- gate overrides (no-op TUI controller causes gates to resolve `abort`) (`src/commands/run.ts`, `src/commands/plan-review.ts`)

This can lead to a headless run that hangs on permissions (no handler) or aborts immediately at the first gate.

**Requirement:** After attempting spawn, compute an “effective TUI mode” based on actual runtime state (e.g. `tui.active` + exit-code-aware spawn result) and use that for permission policy + gate selection.

### P0.3 - Headless interactive permission policy can hang indefinitely on out-of-scope requests

**Risk (correctness/operability):** `workdir-scoped` currently auto-approves in-scope paths and does nothing for out-of-scope/unknown (`src/tui/permissions.ts`). In headless mode (`--no-tui`), there is no separate UI to answer the pending request, so a single out-of-scope permission request can deadlock the run.

**Requirement:** For headless mode, out-of-scope permission requests must be handled deterministically (either reject + escalate with an actionable message, or prompt on stdin explicitly). “Do nothing” is not viable.

### P0.4 - TUI early-exit semantics conflict with the design (“continue headless” vs “abort”) and Phase 6 checklist

**Risk (UX/operability):** Commands currently treat any TUI exit as cancellation (`cancelController.abort()`), yet print “TUI exited — continuing headless” (`src/commands/run.ts`, `src/commands/plan-review.ts`, `src/commands/plan.ts`). This neither continues headless nor distinguishes Ctrl-C (user intent to cancel) from a crash/close.

**Requirement:** Implement the Phase 6 behavior explicitly:

- TUI crash/close: continue orchestration headless (re-enable output since `quiet` is dynamic)
- user cancellation: abort orchestration cleanly

This likely requires capturing the child exit code / termination reason in `TuiController`.

---

## High priority (P1)

### P1.1 - Gate exit/abort watchers accumulate listeners

`watchTuiExit()` registers an `onExit` handler per gate invocation and never unregisters (`src/tui/gates.ts`). For long runs with repeated gates, this grows linearly until the TUI exits. Similarly, abort listeners on a long-lived `AbortSignal` can accumulate.

Fix: provide a one-shot subscription that can be removed, or extend `TuiController.onExit` to return an unsubscribe.

### P1.2 - Adapter-specific cancellation error leaks into orchestrators

Both orchestrators import `AgentCancellationError` from `src/agents/opencode.ts`. This couples orchestration logic to a specific adapter implementation. Prefer a shared `src/agents/errors.ts` contract (or `AgentAdapter.isCancellationError(err)`), keeping loops adapter-agnostic.

### P1.3 - Spec drift vs `004-impl-5x-cli-tui.md` (Phase 5 + detection)

- The doc claims “no gate session is created” and discourages creating/deleting gate sessions, but current gates create and delete sessions (`src/tui/gates.ts`).
- The doc’s Phase 5 section describes “TUI-native dialogs”/control-channel behavior; implementation does not use `client.tui.control.*`.

Decide the intended contract and update either docs or implementation so future changes don’t re-break the same surface.

---

## Medium priority (P2)

- `5x init` should mention TUI mode + `--no-tui` (`src/commands/init.ts`).
- Permission scoping still allows symlink escape (resolved path under workdir can point outside at FS layer); decide whether to mitigate (realpath) or explicitly accept.
- Add an integration-ish test that proves “TUI gate blocks on user input” (not a mocked `session.prompt`), otherwise Phase 5 will keep regressing silently.

---

## Readiness checklist

**P0 blockers**
- [ ] Implement real human-driven TUI gates (no model-decided gate path) (`src/tui/gates.ts`)
- [ ] Make TUI fallback deterministic: permissions + gates based on actual TUI runtime state, not just detection (`src/commands/*.ts`)
- [ ] Handle out-of-scope permissions in headless mode deterministically (reject+escalate or prompt) (`src/tui/permissions.ts`)
- [ ] Implement Phase 6 TUI early-exit behavior (continue headless vs cancel) (`src/tui/controller.ts`, `src/commands/*.ts`)

**P1 recommended**
- [ ] Add unsubscribe/one-shot semantics to gate exit/abort watchers (`src/tui/gates.ts`, `src/tui/controller.ts`)
- [ ] Decouple orchestrators from OpenCode adapter error types (`src/orchestrator/*.ts`)
- [ ] Reconcile doc vs implementation for Phase 5 + detection (`docs/development/004-impl-5x-cli-tui.md`)

---

## Readiness assessment vs implementation plan

- **Phase 1:** ✅
- **Phase 2:** ✅ (spawn + lifecycle exists), but see P0.2/P0.4 for fallback/exit behavior
- **Phase 3:** ⚠️ (policy exists; P0.3 remains for headless out-of-scope requests)
- **Phase 4:** ✅ core session titles + focus hook are present; toast coverage is reasonable for `run`
- **Phase 5:** ❌ as implemented today it does not satisfy “human gate” semantics in TUI mode (P0.1)
- **Phase 6:** Blocked on P0.2/P0.4; remaining polish items are mostly P2
