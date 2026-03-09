# Feature: Provider Process Lifecycle Cleanup

**Version:** 2.0
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

### 5. No process group management

The child process is spawned without process group assignment. If the parent is killed with SIGKILL (which cannot be caught), the child is orphaned because the kernel has no group association to propagate the kill.

## Scope Decisions

### In scope for this iteration
- Pre-stream failure cleanup (try/finally)
- Signal handler cleanup (SIGINT, SIGTERM) with both sync and async paths
- SIGKILL escalation for stalled child processes
- Process group management so kernel kills children when parent dies
- PID tracking in-repo (independent of SDK)

### Explicitly out of scope
- OOM-killer orphaning: when the parent is OOM-killed, it receives SIGKILL which cannot be caught. Process group management (Phase 2) provides kernel-level coverage for this case — no application-level handler is possible. If process groups prove insufficient on some platforms, a separate external watchdog or PID-file reaper would be needed, which is out of scope for this iteration.
- SDK upstream changes: all mitigations are implemented in-repo, wrapping the SDK. No SDK fork or contribution is required.

## Design Decisions

### DD1: Dual sync/async cleanup strategy (addresses P0.1)

**Problem:** `process.on("exit")` callbacks run synchronously — Node/Bun will not await async work. The v1 plan relied on `activeProvider?.close()` in the exit handler, which returns a promise that would be silently dropped.

**Decision:** Use two complementary cleanup paths:
- **Signal handlers (SIGINT, SIGTERM):** async cleanup path. These handlers can perform async work before calling `process.exit()`. Call `provider.close()` (which sends SIGTERM + escalation), await completion, then exit.
- **`process.on("exit")` handler:** synchronous last-resort kill. If the process is exiting and the child is still alive (e.g. `process.exit()` was called from somewhere else, or the async signal handler timed out), use synchronous `process.kill(pid, "SIGKILL")` to ensure the child dies. This requires tracking the child PID ourselves (see DD3).

The exit handler is a safety net, not the primary path. The signal handlers are the primary graceful cleanup path.

### DD2: Process group management (addresses P1.1)

**Problem:** If the parent is hard-killed (SIGKILL, OOM), no in-process handler can run. The child survives as an orphan.

**Decision:** Spawn the child process in its own process group using the `detached: false` default behavior combined with the `process group` option. Specifically: when spawning via the SDK, we do NOT use `detached: true`. Instead, we rely on the default behavior where the child is in the same process group as the parent. On Linux, when the parent is killed, the terminal's process group receives the signal. For non-terminal contexts (e.g. automated pipelines), we additionally register the child PID with the lifecycle module so that the sync exit handler can `process.kill(pid, "SIGKILL")` as a fallback.

**Trade-off:** This does not cover the case where the parent is killed in a non-terminal context without a controlling terminal sending a group signal. For full coverage in those scenarios, an external reaper/watchdog process would be needed — that is out of scope (see Scope Decisions).

### DD3: In-repo PID tracking and SIGKILL escalation (addresses P1.2)

**Problem:** The `@opencode-ai/sdk` returns `{ url, close() }` from `createOpencodeServer()`. The `close()` method calls `proc.kill()` (SIGTERM) but does not expose the child process PID or a force-kill API. The v1 plan proposed a `forceKill()` SDK method that doesn't exist.

**Decision:** Track the PID ourselves in-repo. The approach:
1. Before calling `createOpencodeServer()`, snapshot the set of running `opencode` processes.
2. After `createOpencodeServer()` returns, diff the process list to identify the new child PID. Alternatively, use the SDK's `spawn` event or parse `/proc` — the simplest reliable approach is to check `opencode` processes before/after.
3. Store the PID in the provider instance and register it with the lifecycle module.
4. In `close()`, call `server.close()` (SIGTERM via SDK), then poll for process exit up to 5s, then `process.kill(pid, "SIGKILL")` if still alive.
5. In the sync `process.on("exit")` handler, call `process.kill(pid, "SIGKILL")` directly — this is synchronous and works in exit handlers.

**Alternative considered:** Patching `child_process.spawn` to intercept the PID. Rejected as fragile and coupling to SDK internals.

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

### Phase 1: try/finally + lifecycle module (Quick fix)

**Scope:** `src/commands/invoke.handler.ts`, `src/providers/lifecycle.ts` (new)

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

    // Sync last-resort: kill child if still alive when process exits
    process.on("exit", () => {
      if (trackedPid) {
        try { process.kill(trackedPid, "SIGKILL"); } catch {}
      }
    });

    // Async graceful: close provider, then exit
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, async () => {
        if (activeProvider) {
          await activeProvider.close().catch(() => {});
          activeProvider = null;
        }
        // trackedPid is killed by the exit handler if close() didn't work
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

Handler ordering with existing db/lock signal handlers: all three modules register independent handlers on the same signals. Node.js invokes them in registration order. Since each handler calls `process.exit()`, the first handler to run will trigger the `"exit"` event, which runs all `process.on("exit")` handlers synchronously. The lifecycle module's exit handler kills the child PID. To ensure this works:
- The lifecycle module's signal handlers must NOT call `process.exit()` before the provider is closed (the async close must complete first).
- Since db/lock handlers also call `process.exit()`, we need lifecycle handlers to be registered BEFORE db/lock handlers, OR we need lifecycle cleanup to be in the `"exit"` handler (which always runs regardless of which signal handler calls `process.exit()`). Our design uses both: async close in signal handler + sync kill in exit handler, so even if a db/lock handler fires first and calls `process.exit()`, the exit handler still kills the PID.

**Completion gates:**
- [ ] All manual `provider.close()` calls in `invoke.handler.ts` replaced by single try/finally
- [ ] `lifecycle.ts` registers signal handlers idempotently (no duplicate registration across repeated invocations)
- [ ] Signal handlers compose correctly with `db/connection.ts` and `lock.ts` handlers
- [ ] External provider mode (`OpenCodeProvider.createExternal()`) is unaffected — no PID tracking, no kill
- [ ] Test: provider closes on pre-stream failures (throw between provider creation and invokeStreamed)
- [ ] Test: SIGINT triggers lifecycle cleanup handler
- [ ] Test: no duplicate signal handler registration across multiple `invokeAgent()` calls in one process

### Phase 2: PID tracking + SIGKILL escalation + process groups

**Scope:** `src/providers/opencode.ts`, `src/providers/lifecycle.ts`

**Changes:**

**PID capture:** In `OpenCodeProvider.createManaged()`, capture the child PID:
```typescript
static async createManaged(): Promise<OpenCodeProvider> {
  // Snapshot PIDs of existing opencode processes before spawn
  const before = getOpencodeProcessIds();
  const server = await createOpencodeServer(/* ... */);
  const after = getOpencodeProcessIds();
  const childPid = after.find(pid => !before.includes(pid)) ?? null;

  const provider = new OpenCodeProvider(server);
  provider.childPid = childPid;
  return provider;
}
```

The `getOpencodeProcessIds()` helper reads from `/proc` on Linux or uses `pgrep` to find `opencode` process PIDs. This is a best-effort heuristic — if the diff finds zero or multiple new PIDs, we log a warning and fall back to no PID tracking (SDK's SIGTERM-only close).

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

**Lifecycle integration:** `invoke.handler.ts` now calls `lifecycle.registerProvider(provider, provider.childPid)` after creation, giving the exit handler the PID for sync SIGKILL.

**Process group note:** The default Node.js `spawn()` behavior already places the child in the same process group as the parent. This means terminal-initiated signals (SIGINT from Ctrl-C) are delivered to the entire group by the kernel. No code change is needed for this — it's the default. The value of our explicit PID tracking is for non-terminal contexts where the kernel doesn't send group signals (e.g., `kill <pid>` targeting only the parent).

**Completion gates:**
- [ ] PID is captured and stored for managed providers
- [ ] PID is null for external providers (no spawn occurred)
- [ ] `close()` escalates to SIGKILL after 5s timeout when SIGTERM is insufficient
- [ ] Sync exit handler successfully kills child via `process.kill(pid, "SIGKILL")`
- [ ] Graceful case: child exits within 5s, no SIGKILL sent
- [ ] Test: `close()` with a process that ignores SIGTERM is killed after escalation timeout
- [ ] Test: sync exit handler kills tracked PID
- [ ] Test: external provider close is a no-op (no PID, no kill)
- [ ] Test: PID capture failure (race condition) degrades gracefully to SIGTERM-only

## Risk Assessment

| Phase | Risk | Mitigation |
|-------|------|------------|
| Phase 1 | Low | Small refactor; try/finally is strictly safer than scattered close calls |
| Phase 1 | Signal handler ordering | Exit handler is sync SIGKILL fallback, works regardless of which signal handler calls process.exit() first |
| Phase 2 | PID capture heuristic | Best-effort diff of process list; failure degrades to SDK-only SIGTERM close, no worse than today |
| Phase 2 | SIGKILL escalation timing | 5s is generous; if too aggressive, processes lose state. Configurable constant. |
| Phase 2 | Platform differences | `/proc`-based PID discovery is Linux-specific; macOS fallback via `pgrep`. CI runs on Linux. |

## Files Touched

| File | Phase | Change |
|------|-------|--------|
| `src/providers/lifecycle.ts` (new) | 1 | Provider registration, signal handlers, sync exit handler |
| `src/commands/invoke.handler.ts` | 1 | try/finally wrapper, remove manual close calls, register/unregister via lifecycle |
| `src/providers/opencode.ts` | 2 | PID capture in createManaged(), SIGKILL escalation in close(), childPid field |
| `src/providers/lifecycle.ts` | 2 | Accept PID from provider, use in sync exit handler |

## Test Strategy

### Unit tests

| Test | Phase | Validates |
|------|-------|-----------|
| Pre-stream failure cleanup | 1 | Throwing between provider creation and invokeStreamed still calls close() |
| Signal handler idempotency | 1 | Multiple registerProvider() calls don't stack duplicate signal handlers |
| External provider unaffected | 1, 2 | External providers have no PID, close is no-op, no kill attempted |
| SIGKILL escalation | 2 | Process ignoring SIGTERM is killed after timeout |
| Sync exit handler | 2 | process.on("exit") kills tracked PID synchronously |
| PID capture failure | 2 | Missing PID degrades gracefully, no throw |
| Graceful shutdown | 2 | Process that exits on SIGTERM within 5s does not receive SIGKILL |

### Integration / manual verification

- Run `5x invoke` and Ctrl-C mid-stream: verify no orphaned `opencode` processes remain.
- Run `5x invoke` with a provider that hangs on SIGTERM: verify SIGKILL escalation.
- Run multiple sequential `5x invoke` calls: verify no signal handler accumulation.
- Run `5x invoke` with `--provider-url` (external mode): verify no PID tracking or kill behavior.

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-08 | Initial draft |
| 2.0 | 2026-03-09 | Address review feedback from 011-provider-process-lifecycle.review.md. P0.1: replaced async-only exit cleanup with dual sync/async strategy — sync `process.kill(pid, SIGKILL)` in exit handler, async `provider.close()` in signal handlers. P1.1: added process group discussion and explicit scope decision — SIGKILL/OOM orphaning addressed via process groups + PID tracking; external watchdog out of scope. P1.2: SIGKILL escalation implemented in-repo by tracking PID ourselves via process-list diffing, wrapping SDK close() with timeout + escalation; no SDK changes required. P1.3: added concrete completion gates per phase and full test strategy table. P2: moved cleanup registry from invoke.handler.ts to new lifecycle module. Added Design Decisions section (DD1–DD4). |
