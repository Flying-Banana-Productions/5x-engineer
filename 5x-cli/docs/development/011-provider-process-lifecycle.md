# Feature: Provider Process Lifecycle Cleanup

**Version:** 4.0
**Created:** March 8, 2026
**Status:** Draft
**Priority:** High — causes OOM during extended automated runs

## Problem

Spawned `opencode` child processes are not reliably cleaned up, leading to process accumulation and eventual OOM during multi-phase automated runs. Observed during 010-cli-composability execution: after several `5x invoke` calls, multiple orphaned `opencode` processes remain alive consuming ~600MB each.

## Root Causes

### 1. No `try/finally` around provider lifecycle

`invoke.handler.ts` has 5 manual `provider.close()` calls at each exit point, but gaps exist. Specifically, if `prepareLogPath()` or `appendSessionStart()` throw after provider creation but before the `invokeStreamed` try/catch block, `provider.close()` is never called and the child process leaks.

### 2. No signal handler cleanup for providers

SIGINT/SIGTERM handlers are registered for SQLite (`src/db/connection.ts`) and file locks (`src/lock.ts`), but NOT for provider processes. If the CLI receives SIGINT (ctrl-C) or is killed by timeout, the spawned `opencode` child process survives as an orphan.

### 3. Only SIGTERM, no SIGKILL escalation

The OpenCode SDK's `server.close()` calls `proc.kill()` which sends SIGTERM (Node.js default). If the opencode process ignores SIGTERM or takes too long to shut down, it stays alive indefinitely. There is no follow-up SIGKILL after a timeout.

### 4. No process-exit cleanup

`bin.ts` catches errors and calls `process.exit()` without any provider reference. No `process.on("exit")` handler is registered for provider cleanup. The provider instance is scoped to `invokeAgent()` and not accessible from the top-level error handler.

### 5. No defense against parent hard-kill

If the parent is killed with SIGKILL (which cannot be caught) or by the OOM-killer, the child is orphaned. No in-process handler can address this — SIGKILL cannot be caught, and OOM kills are immediate. This root cause is acknowledged but explicitly out of scope for this iteration (see DD2 and Scope Decisions). Addressing it requires an external mechanism such as a PID-file reaper or supervisor.

## Scope Decisions

### In scope for this iteration
- **Phase 1:** Pre-stream failure cleanup (try/finally around provider lifecycle) and normal-exit cleanup. Signal handlers are scaffolded but only best-effort without PID tracking.
- **Phase 2:** PID tracking via local SDK patch, SIGKILL escalation for stalled children, and fully effective signal cleanup (async graceful path + sync last-resort kill backed by tracked PID).

### Explicitly out of scope
- **SIGKILL/OOM orphan prevention:** when the parent is hard-killed (SIGKILL, OOM-killer), no in-process handler can run. This plan does not attempt to solve that class of orphaning. A future iteration could address it via a PID-file reaper, external supervisor process, or `prctl(PR_SET_PDEATHSIG)` on Linux. These are architectural additions beyond the scope of fixing the current leak paths. See DD2 for rationale.
- **SDK upstream changes:** all mitigations are implemented in-repo. The SDK is patched locally to expose the child PID (see DD3); no upstream fork or contribution is required.

## Design Decisions

### DD1: Dual sync/async cleanup strategy (addresses P0.1)

**Problem:** `process.on("exit")` callbacks run synchronously — Node/Bun will not await async work. The v1 plan relied on `activeProvider?.close()` in the exit handler, which returns a promise that would be silently dropped.

**Decision:** Use two complementary cleanup paths:
- **Signal handlers (SIGINT, SIGTERM):** async cleanup path. These handlers can perform async work before calling `process.exit()`. Call `provider.close()` (which sends SIGTERM + escalation), await completion, then exit.
- **`process.on("exit")` handler:** synchronous last-resort kill. If the process is exiting and the child is still alive (e.g. `process.exit()` was called from somewhere else, or the async signal handler timed out), use synchronous `process.kill(pid, "SIGKILL")` to ensure the child dies. This requires tracking the child PID ourselves (see DD3).

The exit handler is a safety net, not the primary path. The signal handlers are the primary graceful cleanup path.

### DD2: SIGKILL/OOM orphaning is an explicit non-goal (addresses P1.1)

**Problem:** If the parent is hard-killed (SIGKILL, OOM-killer), no in-process handler can run. The child survives as an orphan.

**Decision:** This plan explicitly does not solve SIGKILL/OOM orphaning. No in-process mechanism (signal handlers, exit hooks, process groups) can reliably prevent orphaned children when the parent is hard-killed. This class of orphaning requires an external mechanism and is deferred to a future iteration.

**Note on process groups:** While the default Node.js `spawn()` behavior places the child in the parent's process group, this only helps when the terminal's job control delivers signals to the foreground process group (e.g., Ctrl-C). It does **not** help when the parent is killed directly (`kill -9 <pid>`) or by the OOM-killer, because those signals target a specific PID, not the process group. This plan does not rely on process-group behavior for cleanup correctness.

**Future options (not implemented here):**
- **PID file + reaper:** write the child PID to a known file; a startup check or periodic reaper process cleans orphans.
- **`prctl(PR_SET_PDEATHSIG)` (Linux):** request the kernel to send a signal to the child when the parent dies. Requires native bindings or an SDK change.
- **External supervisor:** a lightweight watchdog that monitors the parent PID and kills children when it exits.

**Rationale for deferral:** the immediate OOM problem is caused by normal-path leaks (missing try/finally, no signal handlers for catchable signals), not by SIGKILL/OOM scenarios. Fixing the normal-path leaks in Phases 1-2 addresses the observed issue. SIGKILL/OOM orphan prevention is a hardening concern for a later iteration.

### DD3: Local SDK patch to expose child PID (addresses P1.2)

**Problem:** The `@opencode-ai/sdk` returns `{ url, close() }` from `createOpencode()`. The returned `server` handle has a `close()` method that calls `proc.kill()` (SIGTERM) but does not expose the child process PID or a force-kill API.

**Decision:** Patch the SDK locally (via `patch-package` or equivalent) to expose the child PID on the server handle. The SDK's internal spawn logic in `dist/server.js` already has the `proc` reference from `spawn()` — the patch adds `pid: proc.pid` to the returned server object. This gives us clean ownership of the child process with no guessing.

**Patch scope:** One line in `dist/server.js` — change the return from `{ url, close() { proc.kill(); } }` to `{ url, pid: proc.pid, close() { proc.kill(); } }`. Corresponding type addition in `dist/server.d.ts`.

**What this enables:**
1. Store `server.pid` in the provider instance and register it with the lifecycle module.
2. In `close()`, call `server.close()` (SIGTERM via SDK), then poll for process exit up to 5s, then `process.kill(pid, "SIGKILL")` if still alive.
3. In the sync `process.on("exit")` handler, call `process.kill(pid, "SIGKILL")` directly — this is synchronous and works in exit handlers.

**Why not process-list diffing:** The v2 plan proposed snapshotting `opencode` PIDs before/after `createOpencode()` and diffing. This is too heuristic for a lifecycle primitive — it can misidentify the wrong process when multiple `opencode` instances start concurrently, when unrelated `opencode` processes already exist, or when the child exits/restarts during sampling. A false positive could `SIGKILL` the wrong process.

**Patch workflow (addresses P2.1):**

The project uses Bun, which does not natively support `patch-package`. The concrete workflow is:

1. **Create the patch:** Run `bunx patch-package @opencode-ai/sdk` after making the edits to `node_modules/@opencode-ai/sdk/dist/server.js` and `node_modules/@opencode-ai/sdk/dist/server.d.ts`. This generates `patches/@opencode-ai+sdk+<version>.patch`.
2. **Add `patch-package` as a dev dependency:** `bun add -d patch-package`.
3. **Add a `postinstall` script to `package.json`:**
   ```json
   "scripts": {
     "postinstall": "bunx patch-package"
   }
   ```
   This ensures the patch is re-applied after every `bun install`, including in CI and fresh clones.
4. **Pin the SDK version:** Change `"@opencode-ai/sdk": "^1.2.6"` to an exact version (e.g., `"@opencode-ai/sdk": "1.2.6"`) to prevent silent patch-breaking upgrades. Upgrades must be intentional and must verify patch compatibility.
5. **CI validation:** The existing `bun test` step validates patch presence because Phase 2 includes a startup assertion that `server.pid` is a number (see Phase 2 completion gates). If the patch is missing or fails to apply, `postinstall` errors during `bun install` and the CI pipeline fails before tests run.

**Files touched by patch workflow:**
| File | Change |
|------|--------|
| `package.json` | Add `patch-package` to devDependencies, add `postinstall` script, pin SDK version |
| `patches/@opencode-ai+sdk+<version>.patch` (new) | Generated patch file exposing `pid` on server handle |

**Patch durability on SDK upgrades:** When `@opencode-ai/sdk` is upgraded, `patch-package` will warn if the patch no longer applies cleanly. The `postinstall` script will fail, blocking the install. The developer must then: (a) verify the new SDK version still needs the patch (check if upstream now exposes `pid`), and (b) regenerate the patch against the new version if still needed.

**Alternative considered:** Using `AbortSignal` passed to the SDK. The SDK accepts `signal` in options but this only aborts the spawn itself, not a running process.

### DD4: Lifecycle module owns cleanup, not invoke.handler (addresses P2)

**Problem:** The v1 plan scoped the cleanup registry to `invoke.handler.ts` as a module global. This bakes lifecycle policy into one command file and won't scale if other commands use providers.

**Decision:** Create `src/providers/lifecycle.ts` as the single owner of provider cleanup registration. It:
- Maintains the active provider reference and tracked PID
- Registers signal handlers (once, idempotent) that compose with existing db/lock handlers
- Registers the sync `process.on("exit")` last-resort handler
- Exposes `registerProvider(provider, pid)` and `unregisterProvider()` for callers

`invoke.handler.ts` calls `registerProvider()` after creation and `unregisterProvider()` in its `finally` block. It no longer owns any cleanup infrastructure.

## Proposed Mitigations

### Phase 1: try/finally + lifecycle module scaffolding (Quick fix)

**Scope:** `src/commands/invoke.handler.ts`, `src/providers/lifecycle.ts` (new)

**What Phase 1 solves:** Pre-stream failure cleanup and normal-exit cleanup only. The try/finally guarantees `provider.close()` is called on every code path through `invoke.handler.ts`, including early failures after provider creation. This eliminates the primary leak path observed in production (root cause #1).

**What Phase 1 does NOT solve:** Signal-driven cleanup (SIGINT/SIGTERM) and SIGKILL escalation are **Phase 2 responsibilities**. Phase 1 scaffolds the lifecycle module and registers signal handlers, but without PID tracking these handlers are best-effort only. Specifically: if another handler (`src/db/connection.ts` or `src/lock.ts`) calls `process.exit()` before the lifecycle module's async `provider.close()` completes, the child leaks because the sync exit handler has no PID to kill. This is an accepted limitation of Phase 1 — Phase 2 closes the gap by adding PID tracking.

**Changes:**
- Create `src/providers/lifecycle.ts` with provider registration, signal handlers, and sync exit handler.
- Wrap the entire post-provider-creation block in `invoke.handler.ts` in `try/finally` with `provider.close()` in the `finally` block.
- Remove all 5 manual `provider.close()` calls from individual catch blocks.
- Call `lifecycle.registerProvider(provider, null)` after provider creation (PID tracking comes in Phase 2).
- Call `lifecycle.unregisterProvider()` in the finally block after close.

Signal handler design in `lifecycle.ts`:
```typescript
let activeProvider: AgentProvider | null = null;
let trackedPid: number | null = null;
let handlersRegistered = false;

export function registerProvider(provider: AgentProvider, pid: number | null): void {
  activeProvider = provider;
  trackedPid = pid;
  if (!handlersRegistered) {
    handlersRegistered = true;

    // Sync last-resort: kill child if still alive when process exits.
    // In Phase 1 (trackedPid is null), this is a no-op.
    // In Phase 2, this provides the critical safety net.
    process.on("exit", () => {
      if (trackedPid) {
        try { process.kill(trackedPid, "SIGKILL"); } catch {}
      }
    });

    // Async best-effort: close provider, then exit.
    // This works when OUR handler runs first. If db/lock handlers
    // call process.exit() before us, the async close is abandoned
    // and we rely on the sync exit handler (effective in Phase 2).
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, async () => {
        if (activeProvider) {
          await activeProvider.close().catch(() => {});
          activeProvider = null;
        }
        process.exit(sig === "SIGINT" ? 130 : 143);
      });
    }
  }
}

export function unregisterProvider(): void {
  activeProvider = null;
  trackedPid = null;
}
```

Handler ordering with existing db/lock signal handlers: all three modules register independent handlers on the same signals. Node.js invokes them in registration order. Since each handler calls `process.exit()`, the first handler to run triggers the `"exit"` event, which runs all `process.on("exit")` handlers synchronously. In Phase 1 (no PID), the sync exit handler is a no-op. In Phase 2 (PID tracked), the exit handler kills the child regardless of which signal handler triggered exit.

**Completion gates:**
- [ ] All manual `provider.close()` calls in `invoke.handler.ts` replaced by single try/finally
- [ ] `lifecycle.ts` module created with provider registration, signal handler scaffolding, and sync exit handler (PID-dependent, no-op in Phase 1)
- [ ] Signal handlers registered idempotently (no duplicate registration across repeated invocations)
- [ ] External provider mode (`OpenCodeProvider.createExternal()`) is unaffected — no PID tracking, no kill
- [ ] Test: provider closes on pre-stream failures (throw between provider creation and invokeStreamed)
- [ ] Test: normal-exit paths (success, error) all invoke provider.close() exactly once
- [ ] Test: no duplicate signal handler registration across multiple `invokeAgent()` calls in one process

**Known limitation (resolved in Phase 2):** Signal-driven cleanup (SIGINT/SIGTERM) is best-effort only in Phase 1. The sync exit handler is a no-op without a tracked PID. If the lifecycle module's async signal handler does not complete before another handler calls `process.exit()`, the child leaks. Phase 2 adds PID tracking, making the sync exit handler effective and closing this gap.

### Phase 2: PID tracking via SDK patch + SIGKILL escalation

**Scope:** `src/providers/opencode.ts`, `src/providers/lifecycle.ts`, SDK patch

**What Phase 2 solves:** Signal-driven cleanup, SIGKILL escalation for stalled children, and the sync exit handler safety net. After Phase 2, all catchable termination paths (normal exit, SIGINT, SIGTERM) reliably kill the child process.

**Changes:**

**SDK patch:** Patch `@opencode-ai/sdk` locally (via `patch-package` or `patches/` directory) to expose the child PID. The SDK's `dist/server.js` spawns the `opencode` process and captures it in a closure. The patch adds `pid: proc.pid` to the returned server handle:

```javascript
// In dist/server.js — patched return value
return {
  url,
  pid: proc.pid,  // <-- added by patch
  close() {
    proc.kill();
  },
};
```

Corresponding type addition in `dist/server.d.ts` so TypeScript sees `server.pid: number`.

**PID capture with startup assertion (addresses P2.2):** In `OpenCodeProvider.createManaged()`, read the PID directly from the server handle and assert its presence. If the SDK patch is missing or no longer applies after an upgrade, the assertion fails immediately at provider startup rather than silently falling back to no PID and weaker cleanup:
```typescript
static async createManaged(opts?: {
  model?: string;
}): Promise<OpenCodeProvider> {
  const { client, server } = await createOpencode({
    hostname: "127.0.0.1",
    port: 0,
    timeout: 15_000,
  });

  // Fail fast if SDK patch is missing — do not silently degrade to no PID tracking
  if (typeof server.pid !== "number") {
    // Kill the server we just spawned (best-effort via SDK close) before throwing
    try { server.close(); } catch {}
    throw new Error(
      "SDK patch missing: server.pid is not available. " +
      "Run 'bun install' to apply patches, or regenerate the patch for the current SDK version."
    );
  }

  const provider = new OpenCodeProvider(client, server, opts?.model);
  provider.childPid = server.pid;
  return provider;
}
```

This assertion serves as a runtime guard that catches patch drift. It is also covered by a dedicated test (see Phase 2 completion gates and test strategy).

**SIGKILL escalation in close():**
```typescript
async close(): Promise<void> {
  if (this.closed) return;
  this.closed = true;
  if (!this.server) return;
  try {
    this.server.close(); // SIGTERM via SDK
    if (this.childPid) {
      // Wait up to 5s for graceful exit, then escalate
      const exited = await this.waitForPidExit(this.childPid, 5000);
      if (!exited) {
        try { process.kill(this.childPid, "SIGKILL"); } catch {}
      }
    }
  } catch {
    // Best-effort: force kill if we have PID
    if (this.childPid) {
      try { process.kill(this.childPid, "SIGKILL"); } catch {}
    }
  }
}
```

**Lifecycle integration:** `invoke.handler.ts` now calls `lifecycle.registerProvider(provider, provider.childPid)` after creation, giving the sync exit handler the PID for last-resort SIGKILL. This closes the Phase 1 limitation — the exit handler now works regardless of signal handler ordering.

**Completion gates:**
- [ ] SDK patch applied and committed to `patches/` directory
- [ ] `patch-package` added as devDependency with `postinstall` script in `package.json`
- [ ] SDK version pinned to exact version (no `^` range) to prevent silent patch-breaking upgrades
- [ ] `bun install` in a clean checkout applies the patch without errors
- [ ] PID is read from `server.pid` for managed providers
- [ ] PID is null for external providers (no spawn occurred)
- [ ] Startup assertion: `createManaged()` throws if `server.pid` is not a number (patch missing/broken)
- [ ] `close()` escalates to SIGKILL after 5s timeout when SIGTERM is insufficient
- [ ] Sync exit handler successfully kills child via `process.kill(pid, "SIGKILL")`
- [ ] Signal-driven cleanup (SIGINT/SIGTERM) now reliably kills child via sync exit handler even if async close is preempted
- [ ] Graceful case: child exits within 5s, no SIGKILL sent
- [ ] Test: `close()` with a process that ignores SIGTERM is killed after escalation timeout
- [ ] Test: sync exit handler kills tracked PID
- [ ] Test: external provider close is a no-op (no PID, no kill)
- [ ] Test: SIGINT triggers lifecycle cleanup and child is killed
- [ ] Test: `createManaged()` throws with clear error message when `server.pid` is missing (simulates unpatched/broken SDK upgrade)
- [ ] Test: `postinstall` patch application succeeds in CI (validated by `bun install` step in CI pipeline)

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|------------|
| Phase 1 | Low | Small refactor; try/finally is strictly safer than scattered close calls |
| Phase 1 | Signal cleanup incomplete | Accepted: Phase 1 signal handlers are best-effort without PID. Phase 2 closes this gap. |
| Phase 2 | SDK patch maintenance | Patch is minimal (one line + type). SDK version pinned to exact. `postinstall` re-applies on every install. `patch-package` fails loudly if patch drifts on SDK upgrade. Runtime assertion in `createManaged()` catches missing patch at startup. |
| Phase 2 | SIGKILL escalation timing | 5s is generous; if too aggressive, processes lose state. Configurable constant. |
| Both | SIGKILL/OOM orphaning | Out of scope. No in-process handler can run. Future: PID file reaper or supervisor. |

## Files Touched

| File | Phase | Change |
|------|-------|--------|
| `src/providers/lifecycle.ts` (new) | 1 | Provider registration, signal handlers, sync exit handler scaffolding |
| `src/commands/invoke.handler.ts` | 1 | try/finally wrapper, remove manual close calls, register/unregister via lifecycle |
| `package.json` | 2 | Add `patch-package` devDependency, add `postinstall` script, pin `@opencode-ai/sdk` to exact version |
| `patches/@opencode-ai+sdk+*.patch` (new) | 2 | Expose `pid: proc.pid` on server handle returned by `createOpencode()` |
| `src/providers/opencode.ts` | 2 | Read `server.pid`, store as `childPid`, startup assertion for PID presence, SIGKILL escalation in `close()` |
| `src/providers/lifecycle.ts` | 2 | Accept PID from provider, sync exit handler kills tracked PID |

## Test Strategy

### Unit tests

| Test | Phase | Validates |
|------|-------|-----------|
| Pre-stream failure cleanup | 1 | Throwing between provider creation and invokeStreamed still calls close() |
| Normal-exit close | 1 | Success and error paths both call provider.close() exactly once |
| Signal handler idempotency | 1 | Multiple registerProvider() calls don't stack duplicate signal handlers |
| External provider unaffected | 1, 2 | External providers have no PID, close is no-op, no kill attempted |
| PID read from server handle | 2 | `server.pid` is stored as `childPid` after `createOpencode()` |
| Missing PID startup assertion | 2 | `createManaged()` throws descriptive error when `server.pid` is undefined (unpatched SDK) |
| SIGKILL escalation | 2 | Process ignoring SIGTERM is killed after timeout |
| Sync exit handler | 2 | process.on("exit") kills tracked PID synchronously |
| Graceful shutdown | 2 | Process that exits on SIGTERM within 5s does not receive SIGKILL |
| Signal + PID integration | 2 | SIGINT/SIGTERM triggers sync exit handler that kills child PID |
| Patch application in CI | 2 | `bun install` applies SDK patch; `postinstall` step succeeds in clean checkout |

### Integration / manual verification

- Run `5x invoke` and Ctrl-C mid-stream: verify no orphaned `opencode` processes remain.
- Run `5x invoke` with a provider that hangs on SIGTERM: verify SIGKILL escalation.
- Run multiple sequential `5x invoke` calls: verify no signal handler accumulation.
- Run `5x invoke` with `--provider-url` (external mode): verify no PID tracking or kill behavior.

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-08 | Initial draft |
| 2.0 | 2026-03-09 | Address initial review feedback. P0.1: replaced async-only exit cleanup with dual sync/async strategy. P1.1: added scope decisions for SIGKILL/OOM. P1.2: added PID tracking via process-list diffing. P1.3: added completion gates and test strategy. Moved cleanup to lifecycle module. Added DD1–DD4. |
| 3.0 | 2026-03-09 | Address review addendum (2026-03-09). P0.1: corrected Phase 1 scope claims — Phase 1 only guarantees try/finally and normal-exit cleanup; signal cleanup is explicitly best-effort until Phase 2 provides PID tracking. P1.1: tightened DD2 — removed misleading process-group reliability claims; SIGKILL/OOM orphaning is now an explicit non-goal with clear rationale, deferring to PID-file reaper or supervisor in a future iteration. P1.2: replaced process-list diffing with local SDK patch (`patch-package`) to expose child PID directly from spawn — eliminates heuristic misidentification risk. P2.1: fixed API naming throughout — `createOpencode()` not `createOpencodeServer()` to match actual `@opencode-ai/sdk/v2` API surface. |
| 4.0 | 2026-03-09 | Address v3 review addendum remaining concerns. P2.1: added concrete SDK patch workflow — `patch-package` devDependency, `postinstall` script, exact SDK version pinning, files touched, CI validation via `bun install` failure on patch drift. P2.2: added runtime startup assertion in `createManaged()` that throws if `server.pid` is missing (unpatched/broken SDK upgrade), preventing silent fallback to weaker cleanup. Added corresponding completion gates, test cases, and updated files-touched and risk tables. |
