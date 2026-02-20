
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

<!-- 5x:structured:v1 eyJzY2hlbWEiOjEsInR5cGUiOiJ2ZXJkaWN0IiwicGhhc2UiOiIzIiwiaXRlcmF0aW9uIjoyLCJkYXRhIjp7InJlYWRpbmVzcyI6Im5vdF9yZWFkeSIsIml0ZW1zIjpbeyJpZCI6IlAwLjEiLCJ0aXRsZSI6IkFib3J0U2lnbmFsIHBsdW1iZWQgYnV0IGlnbm9yZWQ7IG5vIHJlYWwgY2FuY2VsbGF0aW9uIiwiYWN0aW9uIjoiYXV0b19maXgiLCJyZWFzb24iOiJgc2lnbmFsPzogQWJvcnRTaWduYWxgIGlzIGFkZGVkIHRvIG9yY2hlc3RyYXRvciBvcHRpb24gdHlwZXMgYW5kIGNvbW1hbmRzIHBhc3MgYGNhbmNlbENvbnRyb2xsZXIuc2lnbmFsYCwgYnV0IGBzcmMvb3JjaGVzdHJhdG9yL3BoYXNlLWV4ZWN1dGlvbi1sb29wLnRzYCBhbmQgYHNyYy9vcmNoZXN0cmF0b3IvcGxhbi1yZXZpZXctbG9vcC50c2AgbmV2ZXIgY2hlY2sgaXQsIGFuZCBhZGFwdGVyIGludm9jYXRpb25zIGRvbuKAmXQgcmVjZWl2ZSBhIHNpZ25hbC4gVFVJIGV4aXQgLyBTSUdJTlQgaW4gVFVJIG1vZGUgdGhlcmVmb3JlIHdvbuKAmXQgcmVsaWFibHkgc3RvcCBpbi1mbGlnaHQgd29yayBvciByZWFjaCBjbGVhbnVwIGRldGVybWluaXN0aWNhbGx5LiIsInByaW9yaXR5IjoiUDAifSx7ImlkIjoiUDAuMiIsInRpdGxlIjoid29ya2Rpci1zY29wZWQgcGVybWlzc2lvbiBhdXRvLWFwcHJvdmFsIGlzIHRyYXZlcnNhbC1wcm9uZSIsImFjdGlvbiI6ImF1dG9fZml4IiwicmVhc29uIjoiYHNyYy90dWkvcGVybWlzc2lvbnMudHNgIGBpc1BhdGhJbldvcmtkaXIoKWAgcmV0dXJucyB0cnVlIGZvciBhbGwgcmVsYXRpdmUgcGF0aHMgKGluY2x1ZGluZyBgLi4vLi5gKSBhbmQgdXNlcyBwcmVmaXggY2hlY2tzIHdpdGhvdXQgcmVzb2x2aW5nIGAuLmAgc2VnbWVudHMgZm9yIGFic29sdXRlIHBhdGhzIChlLmcuIGAvcHJvamVjdC8uLi9ldGMvcGFzc3dkYCksIGFsbG93aW5nIG91dC1vZi13b3JrZGlyIGZpbGUgb3BlcmF0aW9ucyB0byBiZSBhdXRvLWFwcHJvdmVkLiIsInByaW9yaXR5IjoiUDAifSx7ImlkIjoiUDAuMyIsInRpdGxlIjoiTm9uLWludGVyYWN0aXZlIGZhaWwtY2xvc2VkIGNoZWNrIHJ1bnMgYWZ0ZXIgYWRhcHRlciBjcmVhdGlvbiIsImFjdGlvbiI6ImF1dG9fZml4IiwicmVhc29uIjoiSW4gYHNyYy9jb21tYW5kcy9wbGFuLXJldmlldy50c2AgYW5kIGBzcmMvY29tbWFuZHMvcGxhbi50c2AsIHRoZSBgIXByb2Nlc3Muc3RkaW4uaXNUVFlgIGZhaWwtY2xvc2VkIGNoZWNrIGhhcHBlbnMgYWZ0ZXIgYGNyZWF0ZUFuZFZlcmlmeUFkYXB0ZXIoKWAsIGNvbnRyYXJ5IHRvIHRoZSBwbGFu4oCZcyByZXF1aXJlbWVudCB0byBmYWlsIGJlZm9yZSBhZGFwdGVyIGNyZWF0aW9uIHRvIGF2b2lkIHNpZGUgZWZmZWN0cyAoc3RhcnRpbmcgYSBzZXJ2ZXIvcHJvY2VzcykgaW4gZGlzYWxsb3dlZCBtb2Rlcy4iLCJwcmlvcml0eSI6IlAwIn0seyJpZCI6IlAxLjEiLCJ0aXRsZSI6IlRVSS1tb2RlIHNpZ25hbCBoYW5kbGVycyBjYW4gYmUgcmVnaXN0ZXJlZCBtdWx0aXBsZSB0aW1lcyIsImFjdGlvbiI6ImF1dG9fZml4IiwicmVhc29uIjoiYHJlZ2lzdGVyQWRhcHRlclNodXRkb3duKC4uLiwgeyB0dWlNb2RlOiB0cnVlIH0pYCB1c2VzIGBwcm9jZXNzLm9uY2VgIGJ1dCBkb2VzIG5vdCBndWFyZCB3aXRoIGBfc2lnbmFsSGFuZGxlcnNSZWdpc3RlcmVkYDsgcmVwZWF0ZWQgY2FsbHMgcmVnaXN0ZXIgbXVsdGlwbGUgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgKGVhY2ggZmlyZXMgb25jZSksIGluY3JlYXNpbmcgcmlzayBvZiBkdXBsaWNhdGVkIGFib3J0L2V4aXRDb2RlIGJlaGF2aW9yLiIsInByaW9yaXR5IjoiUDEifSx7ImlkIjoiUDEuMiIsInRpdGxlIjoiUGVybWlzc2lvbiBwb2xpY3kgZm9yIGV4ZWMvYmFzaCBkZXZpYXRlcyBmcm9tIHBsYW47IGRlY2lkZSArIGRvY3VtZW50IiwiYWN0aW9uIjoiaHVtYW5fcmVxdWlyZWQiLCJyZWFzb24iOiJUaGUgcGxhbiBjYWxscyBmb3IgYXV0by1hcHByb3Zpbmcg4oCcZXhlYyB3aXRoaW4gd29ya2RpcuKAnSBpbiBoZWFkbGVzcyBpbnRlcmFjdGl2ZSBtb2RlLCBidXQgYHNyYy90dWkvcGVybWlzc2lvbnMudHNgIGludGVudGlvbmFsbHkgZG9lcyBub3QgYXV0by1hcHByb3ZlIGBiYXNoYCAobm8gcGF0aCBleHRyYWN0aW9uKS4gVGhpcyBpcyBhIHNlY3VyaXR5L1VYIHBvbGljeSBjaG9pY2UgdGhhdCBzaG91bGQgYmUgZXhwbGljaXRseSBkZWNpZGVkIChrZWVwIHNhZmVyIGRlZmF1bHQgYW5kIHVwZGF0ZSBwbGFuL2RvY3MsIG9yIGltcGxlbWVudCBhIHNhZmUgZXhlYy1zY29waW5nIG1lY2hhbmlzbSkuIiwicHJpb3JpdHkiOiJQMSJ9LHsiaWQiOiJQMi4xIiwidGl0bGUiOiJldmVudC1yb3V0ZXIgZGVkdXBlIHNldCBjYW4gZ3JvdyB1bmJvdW5kZWQiLCJhY3Rpb24iOiJhdXRvX2ZpeCIsInJlYXNvbiI6ImBzcmMvdXRpbHMvZXZlbnQtcm91dGVyLnRzYCB0cmFja3MgYHVwZGF0ZWREZWx0YVBhcnRJZHNgIGluZGVmaW5pdGVseTsgZm9yIGxvbmcgc2Vzc2lvbnMgd2l0aCBtYW55IHBhcnRzIHRoaXMgY2FuIGFjY3VtdWxhdGUuIENvbnNpZGVyIGNsZWFyaW5nIElEcyBvbiBhIHBhcnQtY29tcGxldGUgZXZlbnQgaWYgYXZhaWxhYmxlLCBvciBib3VuZGluZyBzdGF0ZS4iLCJwcmlvcml0eSI6IlAyIn1dLCJzdW1tYXJ5IjoiUmV2aWV3IHdyaXR0ZW4gdG8gYGRvY3MvZGV2ZWxvcG1lbnQvcmV2aWV3cy8yMDI2LTAyLTIwLTAwNC1pbXBsLTV4LWNsaS10dWktcmV2aWV3Lm1kYCB3aXRoIGEgbmV3IGFkZGVuZHVtIGNvdmVyaW5nIGA3YzZiZTQzLi4uYCBhbmQgZm9sbG93LW9uIGA5NTg5NTcwLi4uYC4gRm9sbG93LW9uIGhlYWRsZXNzIFNTRSBkZWx0YSBoYW5kbGluZyBsb29rcyBnb29kLCBidXQgUGhhc2UgMyBpcyBub3QgY29tcGxldGUgZHVlIHRvIG1pc3NpbmcgZW5kLXRvLWVuZCBjb29wZXJhdGl2ZSBjYW5jZWxsYXRpb24sIHVuc2FmZSB3b3JrZGlyLXNjb3BlZCBwYXRoIGNoZWNrcywgYW5kIGZhaWwtY2xvc2VkIG9yZGVyaW5nOyBvbmUgb3BlbiBwb2xpY3kgZGVjaXNpb24gcmVtYWlucyBhcm91bmQgZXhlYyBwZXJtaXNzaW9ucy4ifX0 -->

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
