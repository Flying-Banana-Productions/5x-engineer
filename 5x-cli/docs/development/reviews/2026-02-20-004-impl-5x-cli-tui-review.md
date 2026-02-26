
<!-- 5x:structured:v1 eyJzY2hlbWEiOjEsInR5cGUiOiJzdGF0dXMiLCJwaGFzZSI6IjMiLCJpdGVyYXRpb24iOjAsImRhdGEiOnsicmVzdWx0IjoiY29tcGxldGUiLCJjb21taXQiOiI3YzZiZTQzYWQwNTFlYzk0YTM5N2VlYzU3NzA5MDcxZTc5YjIwNzVjIiwibm90ZXMiOiJQaGFzZSAzIGltcGxlbWVudGF0aW9uIGNvbXBsZXRlLiBBbGwgY2hlY2tsaXN0IGl0ZW1zIGZyb20gdGhlIGltcGxlbWVudGF0aW9uIHBsYW4gaGF2ZSBiZWVuIGltcGxlbWVudGVkOlxuXG4xLiBDcmVhdGVkIHNyYy90dWkvcGVybWlzc2lvbnMudHMgd2l0aCBQZXJtaXNzaW9uUG9saWN5IHR5cGVzIGFuZCBjcmVhdGVQZXJtaXNzaW9uSGFuZGxlclxuMi4gQWRkZWQgLS1jaSBmbGFnIHRvIHJ1biwgcGxhbi1yZXZpZXcsIHBsYW4gY29tbWFuZHNcbjMuIEltcGxlbWVudGVkIGZhaWwtY2xvc2VkIGNoZWNrIGZvciBub24tVFRZIHdpdGhvdXQgLS1hdXRvLy0tY2lcbjQuIFVwZGF0ZWQgcmVnaXN0ZXJBZGFwdGVyU2h1dGRvd24oKSBmb3IgVFVJIG1vZGUgY29vcGVyYXRpdmUgY2FuY2VsbGF0aW9uXG41LiBDcmVhdGVkIGNhbmNlbENvbnRyb2xsZXIgaW4gY29tbWFuZCBoYW5kbGVycyBhbmQgcGFzc2VkIHRvIG9yY2hlc3RyYXRvclxuNi4gV2lyZWQgVFVJIGV4aXQgdG8gY2FuY2VsQ29udHJvbGxlci5hYm9ydCgpIGluIG9uRXhpdCBjYWxsYmFja1xuNy4gQWRkZWQgc2lnbmFsIG9wdGlvbiB0byBQaGFzZUV4ZWN1dGlvbk9wdGlvbnMgYW5kIFBsYW5SZXZpZXdMb29wT3B0aW9uc1xuOC4gV3JvdGUgY29tcHJlaGVuc2l2ZSB0ZXN0cyBpbiB0ZXN0L3R1aS9wZXJtaXNzaW9ucy50ZXN0LnRzXG5cbkFsbCA0ODEgdGVzdHMgcGFzcyAoNDc1IHBhc3MsIDYgc2tpcCwgMCBmYWlsKS4ifX0 -->

---

## Addendum (2026-02-20) — Implementation review (Phase 3)

**Reviewed:** `7c6be43ad051ec94a397eec57709071e79b2075c` (no follow-on commits)

### What shipped

- **Permission policy plumbing**: new `src/tui/permissions.ts` and wiring in `src/commands/run.ts`, `src/commands/plan-review.ts`, `src/commands/plan.ts` (+ `--ci` flag).
- **Non-interactive fail-closed**: emits `NON_INTERACTIVE_NO_FLAG_ERROR` when `!stdin.isTTY` without `--auto`/`--ci`.
- **Signal plumbing**: `AbortController` created in commands; `signal?: AbortSignal` added to orchestrator option types; `registerAdapterShutdown()` updated for “TUI mode” (sets `exitCode` + aborts controller).
- **Tests**: `test/tui/permissions.test.ts` covers policy handler behavior.

### Assessment

- **Correctness**: partially meets Phase 3 intent, but cooperative cancellation is not implemented end-to-end: `options.signal` is plumbed but unused in `src/orchestrator/phase-execution-loop.ts` and `src/orchestrator/plan-review-loop.ts`, so TUI exit / Ctrl-C won’t actually stop orchestration.
- **Architecture**: policy object + command-layer resolution is the right shape; however `OpenCodeAdapter` casting (`._clientForTui`) remains a coupling hot-spot.
- **Security**: `workdir-scoped` path checks are unsafe; relative paths and `..` traversal can escape workdir yet still auto-approve.
- **Operability**: fail-closed checks are inconsistent with the plan’s “before adapter creation” requirement (notably `src/commands/plan-review.ts`), which can spin up a server/process before refusing to run.
- **Test strategy**: permission handler tests exist, but Phase 3 acceptance tests for signal handling/cooperative cancellation are missing.

### Issues

#### P0 — Cancellation does not work (plan compliance + cleanup risk)

`signal?: AbortSignal` is declared but never consulted; aborting the controller (TUI exit, SIGINT/SIGTERM in TUI mode) won’t stop the loops. This breaks the core Phase 3 contract (“cooperative cancellation so finally cleanup runs”).

Files: `src/orchestrator/phase-execution-loop.ts`, `src/orchestrator/plan-review-loop.ts`, `src/commands/run.ts`, `src/commands/plan-review.ts`, `src/commands/plan.ts`.

#### P0 — workdir-scoped approval is vulnerable to path traversal

`isPathInWorkdir()` returns `true` for any relative path (including `../..`), and string-prefix checks on absolute paths do not resolve `..` segments (e.g. `/project/../etc/passwd`). This can incorrectly auto-approve out-of-workdir file operations.

File: `src/tui/permissions.ts`.

#### P0 — Non-interactive fail-closed runs after adapter creation in plan-review

In `src/commands/plan-review.ts`, the non-interactive fail-closed check happens after `createAndVerifyAdapter()`. The plan explicitly calls for failing closed “before adapter creation” (avoid side effects / orphan server processes).

File: `src/commands/plan-review.ts`.

#### P1 — registerAdapterShutdown TUI path can register duplicate signal handlers

The TUI-mode path uses `process.once(...)` but does not participate in `_signalHandlersRegistered`. Calling `registerAdapterShutdown(..., { tuiMode: true })` multiple times registers multiple handlers (each will fire once).

File: `src/agents/factory.ts`.

#### P1 — Permission policy deviates from the plan for exec

The plan’s table includes auto-approving “exec within workdir” for headless interactive mode; implementation intentionally does not auto-approve `bash` (path extraction is skipped). This is probably the safer default, but it is a policy deviation that should be explicitly decided and documented.

File: `src/tui/permissions.ts`.

#### P2 — Error message suggests unsupported flags for some commands

`NON_INTERACTIVE_NO_FLAG_ERROR` suggests `--auto`, but `5x plan` does not accept `--auto`. This is minor UX drift but easy to fix (command-specific message or wording).

Files: `src/tui/permissions.ts`, `src/commands/plan.ts`.

### Local verification

- `bun test`: 475 pass, 6 skip, 0 fail

### Phase readiness

- **Phase 3 completion:** ❌ — cooperative cancellation + workdir-scoped security checks need fixes before treating Phase 3 as complete.
- **Ready for Phase 4:** ⚠️ — proceed only after P0 cancellation + P0 path traversal are corrected, otherwise TUI exit/Ctrl-C semantics remain unreliable and the permission policy is unsafe.

<!-- 5x:structured:v1 eyJzY2hlbWEiOjEsInR5cGUiOiJ2ZXJkaWN0IiwicGhhc2UiOiIzIiwiaXRlcmF0aW9uIjoxLCJkYXRhIjp7InJlYWRpbmVzcyI6Im5vdF9yZWFkeSIsIml0ZW1zIjpbeyJpZCI6IlAwLjEiLCJ0aXRsZSI6IkFib3J0U2lnbmFsIHBsdW1iZWQgYnV0IG5vdCBob25vcmVkIGluIG9yY2hlc3RyYXRvciBsb29wcyIsImFjdGlvbiI6ImF1dG9fZml4IiwicmVhc29uIjoiYHNpZ25hbD86IEFib3J0U2lnbmFsYCBpcyBhZGRlZCB0byBvcHRpb24gdHlwZXMgYW5kIGNvbW1hbmRzIHBhc3MgYGNhbmNlbENvbnRyb2xsZXIuc2lnbmFsYCwgYnV0IG5laXRoZXIgYHNyYy9vcmNoZXN0cmF0b3IvcGhhc2UtZXhlY3V0aW9uLWxvb3AudHNgIG5vciBgc3JjL29yY2hlc3RyYXRvci9wbGFuLXJldmlldy1sb29wLnRzYCBldmVyIGNoZWNrcyBpdC4gVFVJIGV4aXQgLyBTSUdJTlQgY29vcGVyYXRpdmUgY2FuY2VsbGF0aW9uIHRoZXJlZm9yZSB3b27igJl0IHN0b3Agd29yaywgdmlvbGF0aW5nIFBoYXNlIDMgYWNjZXB0YW5jZSBjcml0ZXJpYSBhbmQgcmlza2luZyBsZWFrZWQgbG9ja3Mvd29ya3RyZWVzL3NlcnZlcnMuIiwicHJpb3JpdHkiOiJQMCJ9LHsiaWQiOiJQMC4yIiwidGl0bGUiOiJ3b3JrZGlyLXNjb3BlZCBwZXJtaXNzaW9uIGF1dG8tYXBwcm92YWwgaXMgdnVsbmVyYWJsZSB0byBwYXRoIHRyYXZlcnNhbCIsImFjdGlvbiI6ImF1dG9fZml4IiwicmVhc29uIjoiYGlzUGF0aEluV29ya2RpcigpYCByZXR1cm5zIHRydWUgZm9yIGFueSByZWxhdGl2ZSBwYXRoIChpbmNsdWRpbmcgYC4uLy4uYCkgYW5kIHVzZXMgc3RyaW5nLXByZWZpeCBjaGVja3Mgd2l0aG91dCByZXNvbHZpbmcgYC4uYCBzZWdtZW50cywgc28gb3V0LW9mLXdvcmtkaXIgcGF0aHMgbGlrZSBgL3Byb2plY3QvLi4vZXRjL3Bhc3N3ZGAgb3IgYC4uLy4uL2V0Yy9wYXNzd2RgIGNhbiBiZSBpbmNvcnJlY3RseSBhdXRvLWFwcHJvdmVkLiIsInByaW9yaXR5IjoiUDAifSx7ImlkIjoiUDAuMyIsInRpdGxlIjoiTm9uLWludGVyYWN0aXZlIGZhaWwtY2xvc2VkIGNoZWNrIHJ1bnMgYWZ0ZXIgYWRhcHRlciBjcmVhdGlvbiBpbiBwbGFuLXJldmlldyIsImFjdGlvbiI6ImF1dG9fZml4IiwicmVhc29uIjoiSW4gYHNyYy9jb21tYW5kcy9wbGFuLXJldmlldy50c2AsIHRoZSBgIXN0ZGluLmlzVFRZICYmICEtLWF1dG8vLS1jaWAgZWFybHktZXhpdCBoYXBwZW5zIGFmdGVyIGBjcmVhdGVBbmRWZXJpZnlBZGFwdGVyKClgLiBUaGUgcGxhbiByZXF1aXJlcyBmYWlsaW5nIGNsb3NlZCBiZWZvcmUgYWRhcHRlciBjcmVhdGlvbiB0byBhdm9pZCBzaWRlIGVmZmVjdHMgKHN0YXJ0aW5nIHNlcnZlcnMvcHJvY2Vzc2VzKSBpbiBkaXNhbGxvd2VkIG1vZGVzLiIsInByaW9yaXR5IjoiUDAifSx7ImlkIjoiUDEuMSIsInRpdGxlIjoiVFVJLW1vZGUgc2lnbmFsIGhhbmRsZXJzIGNhbiBiZSByZWdpc3RlcmVkIG11bHRpcGxlIHRpbWVzIiwiYWN0aW9uIjoiYXV0b19maXgiLCJyZWFzb24iOiJgcmVnaXN0ZXJBZGFwdGVyU2h1dGRvd24oKWAgdXNlcyBgcHJvY2Vzcy5vbmNlKClgIGluIFRVSSBtb2RlIGJ1dCBkb2VzIG5vdCBwYXJ0aWNpcGF0ZSBpbiBgX3NpZ25hbEhhbmRsZXJzUmVnaXN0ZXJlZGAsIHNvIHJlcGVhdGVkIGNhbGxzIGNhbiByZWdpc3RlciBtdWx0aXBsZSBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyBkZXNwaXRlIHRoZSBjb21tZW50IGNsYWltaW5nIGR1cGxpY2F0ZXMgYXJlIGF2b2lkZWQuIiwicHJpb3JpdHkiOiJQMSJ9LHsiaWQiOiJQMS4yIiwidGl0bGUiOiJEZWNpZGUgZXhlYyAoYmFzaCkgcGVybWlzc2lvbiBiZWhhdmlvciBmb3Igd29ya2Rpci1zY29wZWQgcG9saWN5IiwiYWN0aW9uIjoiaHVtYW5fcmVxdWlyZWQiLCJyZWFzb24iOiJQbGFuIHRleHQgaW1wbGllcyBhdXRvLWFwcHJvdmluZyDigJxleGVjIHdpdGhpbiB3b3JrZGly4oCdIGluIGhlYWRsZXNzIGludGVyYWN0aXZlIG1vZGUsIGJ1dCBpbXBsZW1lbnRhdGlvbiBpbnRlbnRpb25hbGx5IG5ldmVyIGF1dG8tYXBwcm92ZXMgYGJhc2hgIChjYW7igJl0IGV4dHJhY3QgcGF0aCkuIFRoaXMgaXMgYSBzZWN1cml0eS9VWCBwb2xpY3kgY2hvaWNlIHRoYXQgc2hvdWxkIGJlIG1hZGUgZXhwbGljaXRseSAoYW5kIHBsYW4vY29kZSBhbGlnbmVkKSByYXRoZXIgdGhhbiBhY2NpZGVudGFsIGRyaWZ0LiIsInByaW9yaXR5IjoiUDEifSx7ImlkIjoiUDIuMSIsInRpdGxlIjoiTm9uLWludGVyYWN0aXZlIGVycm9yIG1lc3NhZ2Ugc3VnZ2VzdHMgdW5zdXBwb3J0ZWQgZmxhZ3MgZm9yIGBwbGFuYCIsImFjdGlvbiI6ImF1dG9fZml4IiwicmVhc29uIjoiYE5PTl9JTlRFUkFDVElWRV9OT19GTEFHX0VSUk9SYCByZWNvbW1lbmRzIGAtLWF1dG9gLCBidXQgYDV4IHBsYW5gIGRvZXMgbm90IGFjY2VwdCBgLS1hdXRvYDsgbWlub3IgVVggZHJpZnQgdGhhdOKAmXMgZWFzeSB0byBjb3JyZWN0IHZpYSBjb21tYW5kLXNwZWNpZmljIG1lc3NhZ2luZyBvciB3b3JkaW5nLiIsInByaW9yaXR5IjoiUDIifV0sInN1bW1hcnkiOiJQaGFzZSAzIGlzIGNsb3NlIHN0cnVjdHVyYWxseSAocG9saWN5IGFic3RyYWN0aW9uICsgd2lyaW5nKSwgYnV0IGNvb3BlcmF0aXZlIGNhbmNlbGxhdGlvbiBpcyBub3QgaW1wbGVtZW50ZWQgZW5kLXRvLWVuZCBhbmQgdGhlIHdvcmtkaXItc2NvcGVkIHBhdGggY2hlY2sgaXMgdW5zYWZlLiBBbHNvIG5lZWRzIGFuIGV4cGxpY2l0IHBvbGljeSBkZWNpc2lvbiBvbiB3aGV0aGVyL2hvdyB0byBhdXRvLWFwcHJvdmUgZXhlYyBpbiB3b3JrZGlyLXNjb3BlZCBtb2RlLiJ9fQ -->


---

## Addendum (2026-02-20) — Follow-on commits review

**Reviewed:** `7c6be43ad051ec94a397eec57709071e79b2075c`, `9589570963b82dff7e1eb7dd3a131770c4b8241f`

### What changed since the prior addendum

- **Headless rendering fix**: `src/utils/event-router.ts` now supports inline `delta` on `message.part.updated` (newer OpenCode event shape) and dedupes subsequent legacy `message.part.delta` for the same part.
- **Tests**: `test/agents/opencode-rendering.test.ts` adds coverage for updated-delta streaming, reasoning gating, and dedupe behavior.

### Assessment (Staff Eng)

- **Correctness**: follow-on rendering change looks correct and has targeted tests; improves robustness against mixed event shapes.
- **Plan compliance (Phase 3)**: still incomplete. `AbortSignal` is plumbed into command → orchestrator options, but orchestration loops never consult it, and adapter invocations do not receive a signal. TUI exit / SIGINT in TUI mode therefore won’t reliably stop work.
- **Security**: `workdir-scoped` auto-approval remains unsafe. `isPathInWorkdir()` trusts all relative paths and does not resolve `..` segments for absolute paths; this can incorrectly auto-approve out-of-workdir file ops.
- **Operability**: non-interactive fail-closed still happens after adapter creation in `plan-review`, and also after adapter creation in `plan` (starts server/process before refusing to run).

### Issues (delta + confirmed)

#### P0 — Cooperative cancellation not implemented end-to-end

`options.signal` is declared but unused in `src/orchestrator/phase-execution-loop.ts` and `src/orchestrator/plan-review-loop.ts`. Additionally, adapter invocations (`invokeForStatus`/`invokeForVerdict`) are not passed any `signal`, so even if the orchestrator checked for abort between awaits, it can’t reliably interrupt an in-flight prompt.

Files: `src/orchestrator/phase-execution-loop.ts`, `src/orchestrator/plan-review-loop.ts`, `src/commands/run.ts`, `src/commands/plan-review.ts`, `src/commands/plan.ts`.

#### P0 — workdir-scoped permission approval vulnerable to traversal / mis-scoping

`src/tui/permissions.ts` uses string normalization and prefix checks without path resolution. Relative paths (including `../..`) are treated as in-scope, and absolute paths containing `..` segments can escape while still matching the prefix.

File: `src/tui/permissions.ts`.

#### P0 — Non-interactive fail-closed should run before adapter creation (plan-review, plan)

In `src/commands/plan-review.ts` and `src/commands/plan.ts`, the fail-closed check occurs after `createAndVerifyAdapter()`. The plan calls for failing closed before adapter creation to avoid side effects and orphaned server processes in disallowed modes.

Files: `src/commands/plan-review.ts`, `src/commands/plan.ts`.

#### P2 — event-router state can grow unbounded

`updatedDeltaPartIds` is never cleared; long-running sessions with many parts can grow memory. Likely fine for typical runs, but consider removing IDs on a part-complete event if available.

File: `src/utils/event-router.ts`.

### Phase readiness

- **Phase 3 completion:** ❌ (P0 cancellation + P0 permission scoping + P0 fail-closed ordering)
- **Ready for Phase 4:** ❌ (Phase 4 assumes stable TUI lifecycle + reliable cancellation; current behavior can leak work/locks and auto-approve unsafe paths)

---

## Addendum (2026-02-20) — Fix validation (004 Phase 3)

**Reviewed:** `1508d96d76ff92b901d177d8e6df36b81189084c` (no follow-on commits)

### Assessment (Staff Eng)

- **Correctness**: closes the prior P0s. `AbortSignal` is now honored in `src/orchestrator/plan-review-loop.ts` and `src/orchestrator/phase-execution-loop.ts` and is passed into all agent invocations; OpenCode adapter already wires `opts.signal` through to the SDK.
- **Security/tenancy**: `workdir-scoped` no longer trusts relative paths and now normalizes `..` segments via `path.resolve()`; added regression tests. Remaining edge: symlink escape (path in workdir that resolves outside at FS layer) is still possible if the underlying tool follows symlinks.
- **Operability**: non-interactive fail-closed checks now run before adapter creation in `src/commands/plan-review.ts` and `src/commands/plan.ts`, avoiding side effects (server/process spawn) on invalid invocations.
- **Performance**: no meaningful impact.
- **Tests**: good unit coverage for traversal; still no orchestrator-level cancellation test (mock adapter + abort mid-loop) to prevent regressions.

### Remaining concerns

- **P1 cancellation semantics**: in `src/orchestrator/phase-execution-loop.ts`, an in-flight cancel propagating via `signal` will typically throw from `adapter.invoke*()`, be recorded as an escalation, and then the run can finalize as `failed` (because `escalations.length > 0`) even though this is a user/system abort. Consider special-casing cancellation (e.g. propagate a typed cancel error or check `options.signal?.aborted` in catch) and ensuring final status is `aborted` when cancellation is the cause.
- **P2 UX**: `NON_INTERACTIVE_NO_FLAG_ERROR` still mentions `--auto`, but `5x plan` does not support `--auto` (the code even notes this). Consider command-specific messaging or wording like "Use `--ci` (or `--auto` where supported)".
- **P1 policy decision** (unchanged): exec/bash permission policy still deviates from the plan; decide + document.
- **P2 memory** (unchanged): `updatedDeltaPartIds` growth in `src/utils/event-router.ts` still worth bounding/clearing if long sessions are expected.

### Phase readiness

- **Phase 3 completion:** YES (P0 blockers addressed).
- **Ready for Phase 4:** YES (recommend the small P2 UX fix + a cancellation integration test before calling this production-ready).

---

## Addendum (2026-02-20) — Feedback validation (iteration 3)

**Reviewed:** `1f54815c867034eb2a672e3e8d7e3f864f74967a` (no follow-on commits)

### Assessment (Staff Eng)

- **Correctness**: cancellation now has a first-class error (`AgentCancellationError`) and both loops treat cancellation as `ABORTED` (not `ESCALATE`). The non-interactive error message now correctly reflects `plan` supporting `--ci` but not `--auto`.
- **Architecture**: cancellation handling is functionally right, but the orchestrators now import an adapter-specific error from `src/agents/opencode.ts` (`AgentCancellationError`). Prefer a shared, adapter-agnostic error contract (e.g. `src/agents/errors.ts`) to keep orchestrators decoupled.
- **Operability**: plan-review loop finalization already maps any abort to `aborted`. Phase-execution loop will now usually finalize as `aborted` on cancellation because it avoids recording an escalation; edge case remains if prior escalations exist (final status can still become `failed`). Decide whether user/system cancel should always win.
- **Tests**: commit claims all tests pass; still recommend adding an orchestrator-level cancellation test (mock adapter throws cancellation mid-invoke) to lock in the `ABORTED` behavior and final status.

### Phase readiness

- **Phase 3 completion:** YES.
- **Ready for Phase 4:** YES.

---

## Addendum (2026-02-20) — Implementation review (Phase 4)

**Reviewed:** `ddbaef18d1980b06787753d410bfb7348647989b` (no follow-on commits)

### What shipped

- **Session titles**: `InvokeOptions.sessionTitle` added and forwarded to `session.create()`.
- **Orchestrator wiring**: `tui?: TuiController` added to loop option types; `run` and `plan-review` commands pass the controller.
- **Phase loop UX**: `src/orchestrator/phase-execution-loop.ts` adds phase-boundary toasts and attempts session switching after each agent invocation.
- **Docs/tests**: Phase 4 checklist marked complete; new `test/tui/phase4-integration.test.ts` added.

### Assessment (Staff Eng)

- **Correctness**: toast calls are best-effort (controller swallows disconnect errors), good. Session switching does not occur “after `session.create()`”; it happens only after `invokeFor*()` resolves, which is typically after the prompt completes. The TUI therefore won’t reliably track the active session while the agent streams.
- **Architecture**: plumbing `tui` through command → loop options matches Phases 2/3. But `src/orchestrator/plan-review-loop.ts` accepts `tui` and never uses it, and `src/commands/plan.ts` remains un-integrated. Phase 4 behavior is uneven across commands.
- **Security**: no new material concerns introduced in this commit.
- **Operability**: the plan’s "Phase N failed — [reason]" toast is not implemented; review "approved" toast only happens in interactive mode (PHASE_GATE continue) and not in auto mode.
- **Test strategy**: `test/tui/phase4-integration.test.ts` is mostly interface/type assertions; it does not validate Phase 4 behavioral requirements (titles, session switching timing, toast boundaries, stdout-clean).
### Issues

#### P0 — Session switching happens after the work (not after `session.create()`)

Phase 4’s goal is “TUI tracks the active session.” Current `selectSession()` calls occur only after `adapter.invokeForStatus()` / `invokeForVerdict()` returns, which is too late to focus the TUI during streaming.

This likely requires an API change (e.g. `onSessionCreated(sessionId)` callback or a minimal TUI hook in `InvokeOptions`) so the adapter can notify immediately after `session.create()`.

Files: `src/agents/opencode.ts`, `src/agents/types.ts`, `src/orchestrator/phase-execution-loop.ts`.

#### P0 — Plan-review loop has no Phase 4 integration

`src/commands/plan-review.ts` passes `tui`, but `src/orchestrator/plan-review-loop.ts` never uses it (no session titles, no session switching, no toasts). In TUI mode (`--auto`), plan-review won’t show the intended session focus behavior.

File: `src/orchestrator/plan-review-loop.ts`.

#### P1 — Plan command does not set a session title or switch sessions

`src/commands/plan.ts` invokes the agent without `sessionTitle` and never calls `tui.selectSession()` using the returned `sessionId`. This is explicitly called out in Phase 4’s “Session Titles” table and user-facing goal.

File: `src/commands/plan.ts`.

#### P1 — Missing “Phase N failed — [reason]” toast and auto-mode “approved” toast

The plan specifies error toasts and “review approved” feedback. Current implementation covers phase start, auto escalation, auto phase complete (start review), and interactive continue; it does not toast on hard failures, and it does not toast “approved” in auto mode.

File: `src/orchestrator/phase-execution-loop.ts` (and likely `src/orchestrator/plan-review-loop.ts`).

#### P1 — Phase 4 tests do not validate Phase 4 requirements

Tests should assert behavior, not just interface shape:
- session titles passed for each invocation (including plan-review + plan)
- session switching occurs at session creation time (see P0)
- toast calls at specified boundaries
- stdout-clean guarantee when `tui.active === true`

Files: `test/tui/phase4-integration.test.ts` (and new tests in `test/orchestrator/*`).

### Local verification

- `bun test`: 488 pass, 6 skip, 0 fail

### Phase readiness

- **Phase 4 completion:** ❌ — P0 session switching timing + missing plan/plan-review integration + behavioral tests.
- **Ready for Phase 5:** ⚠️ — recommended to close Phase 4 P0s first; Phase 5 UX depends on reliable session focus + notifications.

---

## Addendum (2026-02-20) — Staff Engineer review (Phase 4, commit ddbaef1)

**Reviewed:** `ddbaef18d1980b06787753d410bfb7348647989b` (no follow-on commits)

### Assessment (Staff Eng)

- **Correctness / plan compliance**: Phase 4 is marked complete in `docs/development/004-impl-5x-cli-tui.md`, but key behaviors are either missing (plan-review/plan) or implemented too late (session switching after invoke). This does not meet the stated goal (“TUI tracks the active session”).
- **Architecture**: Passing `tui?: TuiController` through command → orchestrator options is consistent with earlier phases. The missing integration in `src/orchestrator/plan-review-loop.ts` indicates the contract is only partially adopted.
- **Operability**: Toasts cover some boundaries, but the plan-required failure toast is not implemented; “approved — continuing” feedback is absent in auto mode because interactive PHASE_GATE is skipped.
- **Tests**: Phase 4 tests are type-level; they do not protect the behavioral requirements (session selection timing, toast boundaries, stdout-clean).

### Recommended fixes

1. **Select the session at creation time**: needs an adapter-level hook (e.g. `InvokeOptions.onSessionCreated(sessionId)` or `InvokeOptions.tui?: Pick<TuiController, "selectSession">`) so `OpenCodeAdapter` can call it immediately after `session.create()`.
2. **Implement Phase 4 consistently**: add session titles + toasts + session selection in `src/orchestrator/plan-review-loop.ts` and ensure `src/commands/plan.ts` passes a descriptive `sessionTitle` and focuses the session.
3. **Add behavioral tests**: mock adapter/TUI to assert call order and expected toast calls; add a stdout-clean regression test under `tui.active === true`.

### Phase readiness

- **Phase 4 completion:** NO
- **Ready for Phase 5:** NO (Phase 5 UX depends on reliable session focus + notifications)

---

## Addendum (2026-02-20) — Review of Phase 4 fixes (commit ad05511)

**Reviewed:** `ad05511bcf5ae83cf4be8cec8562e826fd6645df` (no follow-on commits)

### Assessment (Staff Eng)

- **Correctness / plan compliance**: The Phase 4 P0 is addressed: session focus can now switch immediately after `session.create()` via `InvokeOptions.onSessionCreated`, and all main call sites pass `sessionTitle` + session-created hook.
- **Architecture**: The `onSessionCreated` hook is the right adapter-agnostic shape. Remaining coupling smell persists: orchestrators still import `AgentCancellationError` from `src/agents/opencode.ts`.
- **Operability**: Phase-boundary failure toasts are now emitted on invoke hard-failures; escalation is surfaced in auto mode. Stdout-clean behavior is generally preserved via `quiet` gating.
- **Test strategy**: Added coverage is directionally good, but the new “Phase 4 integration” tests are mostly contract/simulation and do not assert real call order/arguments through the orchestrators/adapter.

### What’s addressed (✅)

- **P0 session switching timing**: `src/agents/types.ts` adds `onSessionCreated`; `src/agents/opencode.ts` calls it immediately after `session.create()`; `src/orchestrator/phase-execution-loop.ts` and `src/orchestrator/plan-review-loop.ts` pass it to focus the TUI during streaming.
- **Phase 4 consistency across commands**: `src/commands/plan.ts` now passes `sessionTitle` and focuses the session; plan-review loop now sets session titles and focuses sessions.
- **Missing failure feedback**: `src/orchestrator/phase-execution-loop.ts` now shows `Phase N failed — <reason>` toasts for author/reviewer/quality-retry/auto-fix invocation failures.

### Remaining concerns

- **P0 cancellation wiring in `plan`**: `src/commands/plan.ts` creates/aborts a `cancelController` on TUI exit, but the `adapter.invokeForStatus()` call does not receive `signal: cancelController.signal`, so the invocation will not cancel. This also makes the “continuing headless” message misleading and can leave the process waiting silently (quiet was computed while TUI was active).
- **P1 toast boundary + auto-mode approval toast**: `Phase N complete — starting review` currently fires after the phase completes, not at the author→review boundary implied by `docs/development/004-impl-5x-cli-tui.md` Phase 4. Also, auto-mode does not emit an explicit “approved/continuing” toast at `PHASE_GATE` (if that’s still a requirement vs the “complete” toast).
- **P1 tests don’t lock in behavior**: Add orchestrator-level assertions that `sessionTitle` values are passed into adapter invocations and that `showToast` calls happen at the intended boundaries. Add an adapter unit test with a mocked client proving `onSessionCreated` fires before `session.prompt`.
- **Best-effort hook semantics**: `src/agents/opencode.ts` currently awaits `opts.onSessionCreated(sessionId)` without a try/catch; if a future callback throws (or is user-supplied), it will fail the entire invocation. This hook should be best-effort.

### Phase readiness

- **Phase 4 completion:** ⚠️ — core session switching + titles + failure toasts are in place; close the `plan` cancellation wiring and harden the Phase 4 tests/toast boundary semantics to fully meet the Phase 4 completion gate.
- **Ready for Phase 5:** ⚠️ — proceed once Phase 4 is considered complete (Phase 5 UX depends on robust, test-backed TUI orchestration + lifecycle semantics).

---

## Addendum (2026-02-20) — Implementation review (Phase 5 gate fixes)

**Reviewed:** `ae6e28362163b77b4076cd43d82e02f6bf83ac25` (no follow-on commits)

### What changed since the prior addendum

- **Gate termination semantics**: timeout / abort signal / TUI exit now resolve to `"abort"` instead of rejecting.
- **Best-effort UX**: `tui.showToast()` and `tui.selectSession()` are wrapped in `try/catch` so gate logic continues on TUI/API failures.
- **Event listener hygiene (partial)**: `AbortSignal` listeners use `{ once: true }`.

### Assessment (Staff Eng)

- **Correctness**: this addresses the core failure mode where gate rejection bubbles out of orchestration loops; timeouts now end gates predictably.
- **Plan compliance**: the plan text + Phase 5 checklist explicitly say cancel/TUI-exit should *reject* (not resolve `"abort"`). Implementation is probably the better contract for orchestration, but it’s now a spec mismatch that should be resolved explicitly (code vs plan).
- **Operability**: best-effort toast/session focus is correct and avoids turning UX/API flakiness into run failures.

### Issues

#### P1 — Phase 5 spec mismatch on cancel/TUI-exit semantics (resolve vs reject)

`docs/development/004-impl-5x-cli-tui.md` describes cancel + TUI exit as rejection paths; `src/tui/gates.ts` now resolves `"abort"` for both. Decide the intended contract and update either the plan (preferred if this is the new contract) or the implementation/tests.

Files: `docs/development/004-impl-5x-cli-tui.md`, `src/tui/gates.ts`, `test/tui/gates.test.ts`.

#### P1 — Listener accumulation still possible (TUI exit + abort signal)

`watchTuiExit()` registers an `onExit` handler per gate call and never unregisters; if the TUI never exits, these handlers accumulate. Similarly, `{ once: true }` on `AbortSignal` prevents repeat firing but does not remove listeners unless abort happens; repeated gates on a long-lived `AbortController.signal` will accumulate listeners until abort.

This is likely fine for short runs, but it’s a real leak in long-lived processes / repeated commands.

File: `src/tui/gates.ts`.

#### P2 — Tests cover the phase gate only for abort/timeout/TUI-exit

The updated assertions exist for `createTuiPhaseGate`, but equivalent termination-path tests are missing for `createTuiEscalationGate`, `createTuiResumeGate`, `createTuiHumanGate`, and `createTuiPlanReviewResumeGate`.

File: `test/tui/gates.test.ts`.

### Local verification

- `bun test`: 525 pass, 6 skip, 0 fail

### Phase readiness

- **Phase 5 completion:** ⚠️ — functionally improved, but not “plan complete” until the cancel/TUI-exit contract is reconciled (and ideally listener cleanup is hardened).

---

## Addendum (2026-02-22) — Closure validation (post re-review)

**Reviewed:** `2cb8be295fac665198aa81a03fecd97d8db0bffb` (no follow-on commits)

**Related (reference):** `docs/development/reviews/2026-02-21-004-impl-5x-cli-tui-rereview.md`

**Local verification:** `bun test` PASS (509 pass, 6 skip); `bun run typecheck` PASS

### What this addendum covers

This closes out any still-open items from the Phase 4/5 review chain in this document, based on the fixes implemented in `2cb8be2` and the detailed re-review in the related doc above.

### Issue closure (from this review doc)

- **Phase 4 remaining concern — plan cancellation wiring:** ✅ Closed. `src/commands/plan.ts` now passes `signal: cancelController.signal` into `adapter.invokeForStatus()`, so TUI cancel propagates to the SDK invocation and cleanup can run.
- **Phase 4 remaining concern — best-effort `onSessionCreated`:** ✅ Closed. `src/agents/opencode.ts` wraps `onSessionCreated` in try/catch (and has unit tests asserting call order + best-effort behavior).
- **Phase 5 issue — spec mismatch (cancel/TUI-exit resolve vs reject):** ✅ Closed. `docs/development/004-impl-5x-cli-tui.md` was updated to match the implemented contract (resolve to `"abort"`), and gate implementations/tests are aligned.
- **Phase 5 issue — listener accumulation:** ✅ Closed. `TuiController.onExit()` returns an unsubscribe and `src/tui/gates.ts` cleans up timeout + abort + exit subscriptions per gate invocation.

### Items from this doc that still appear active

Note: the items below were closed in `dcdc366fba` (see addendum at the end of this document).

- **Toast wording/boundary semantics (P1):** `Phase N complete — starting review` is emitted after the phase finishes (including review) in auto mode (`src/orchestrator/phase-execution-loop.ts`). If the intent is “author done, starting review”, this toast should either move to the author→review transition or be renamed to reflect the actual boundary.
- **Gate termination-path test coverage (P2):** `test/tui/gates.test.ts` has explicit timeout/abort coverage for `createTuiPhaseGate`, but equivalent termination-path tests are still missing for escalation/resume/human/wrapper gates.
- **Event-router boundedness (P2):** `src/utils/event-router.ts`’s `updatedDeltaPartIds` is not cleared; it is per-invocation state (so bounded to session lifetime), but can still grow with very large sessions.

### Phase readiness (for this document)

- **Phase 4 completion:** ✅ (with the caveats above around toast semantics/tests)
- **Phase 5 completion:** ✅ (core correctness/semantics now match the plan)

---

## Addendum (2026-02-22) — Follow-up item closure (toast/tests/boundedness)

**Reviewed:** `dcdc366fba479add4ba1ecc9e30a704e37162c38` (no follow-on commits)

**Local verification:** `bun test` PASS (518 pass, 6 skip); `bun run typecheck` PASS

### Updated assessment

The remaining items called out in the prior addendum are addressed cleanly and with appropriate regression coverage.

### Closure of previously-active items

- **Toast wording/boundary semantics (P1):** ✅ Closed. Auto-mode toast now reads `Phase N complete — continuing` (`src/orchestrator/phase-execution-loop.ts`), matching the actual boundary (review already completed by the time the toast is emitted).
- **Gate termination-path test coverage (P2):** ✅ Closed. `test/tui/gates.test.ts` adds timeout/abort/TUI-exit coverage across escalation/resume/human/wrapper gates (not just the phase gate).
- **Event-router boundedness (P2):** ✅ Closed. `src/utils/event-router.ts` bounds `updatedDeltaPartIds` via `MAX_TRACKED_DELTA_PART_IDS` with an insertion-order eviction strategy, and `test/agents/opencode-rendering.test.ts` asserts the set stays bounded.

### Further feedback

- **Bounded dedupe trade-off:** evicting old part IDs means very old parts could theoretically re-emit duplicate legacy deltas later. This is a reasonable trade for long-session safety; if this shows up in practice, consider clearing on a “part complete” event (if the SSE stream exposes one) or using a per-message eviction heuristic.
