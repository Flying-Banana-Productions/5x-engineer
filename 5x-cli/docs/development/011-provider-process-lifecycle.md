# Feature: Provider Process Lifecycle Cleanup

**Version:** 1.0
**Created:** March 8, 2026
**Status:** Draft
**Priority:** High — causes OOM during extended automated runs

## Problem

Spawned `opencode` child processes are not reliably cleaned up, leading to process accumulation and eventual OOM during multi-phase automated runs. Observed during 010-cli-composability execution: after several `5x invoke` calls, multiple orphaned `opencode` processes remain alive consuming ~600MB each.

## Root Causes

### 1. No `try/finally` around provider lifecycle

`invoke.handler.ts` has 6 manual `provider.close()` calls at each exit point, but gaps exist. Specifically, if `prepareLogPath()` (line 389) or `appendSessionStart()` (line 392) throw after provider creation but before the `invokeStreamed` try/catch block, `provider.close()` is never called and the child process leaks.

### 2. No signal handler cleanup for providers

SIGINT/SIGTERM handlers are registered for SQLite (`src/db/connection.ts`) and file locks (`src/lock.ts`), but NOT for provider processes. If the CLI receives SIGINT (ctrl-C), is killed by timeout, or OOM-killed, the spawned `opencode` child process survives as an orphan.

### 3. Only SIGTERM, no SIGKILL escalation

The OpenCode SDK's `server.close()` calls `proc.kill()` which sends SIGTERM (Node.js default). If the opencode process ignores SIGTERM or takes too long to shut down, it stays alive indefinitely. There is no follow-up SIGKILL after a timeout.

### 4. No process-exit cleanup

`bin.ts` catches errors and calls `process.exit()` without any provider reference. No `process.on("exit")` handler is registered for provider cleanup. The provider instance is scoped to `invokeAgent()` and not accessible from the top-level error handler.

### 5. No process group management

The child process is spawned without `detached: true` and without process group tracking. If the parent is killed with SIGKILL (which cannot be caught), the child may be orphaned depending on OS behavior.

## Proposed Mitigations

### Phase 1: try/finally + provider registry (Quick fix)

**Scope:** `src/commands/invoke.handler.ts`

- Wrap the entire post-provider-creation block in `try/finally` with `provider.close()` in the `finally` block. Remove all manual `provider.close()` calls from individual catch blocks.
- Register a module-level `activeProvider` reference that a `process.on("exit")` handler can clean up.

```typescript
// Module-level cleanup registry
let activeProvider: AgentProvider | null = null;
process.on("exit", () => {
  activeProvider?.close().catch(() => {});
});

export async function invokeAgent(role, params) {
  // ... setup ...
  const provider = await createProvider(role, config);
  activeProvider = provider;
  try {
    // ... all invoke logic ...
  } finally {
    await provider.close().catch(() => {});
    activeProvider = null;
  }
}
```

### Phase 2: SIGKILL escalation in SDK close()

**Scope:** `src/providers/opencode.ts` (or SDK contribution)

- After calling `proc.kill()` (SIGTERM), wait up to 5 seconds for the process to exit.
- If still alive, send SIGKILL.

```typescript
async close(): Promise<void> {
  if (this.closed) return;
  this.closed = true;
  if (!this.server) return;
  try {
    this.server.close(); // SIGTERM
    // Wait for graceful shutdown, then escalate
    await Promise.race([
      this.waitForExit(),
      new Promise(r => setTimeout(r, 5000)),
    ]);
    if (this.isProcessAlive()) {
      this.server.forceKill(); // SIGKILL
    }
  } catch {
    // Ignore close errors
  }
}
```

This may require changes to the `@opencode-ai/sdk` to expose a `forceKill()` method or a `kill(signal)` variant.

### Phase 3: Signal handlers for provider cleanup

**Scope:** `src/commands/invoke.handler.ts` or new `src/providers/lifecycle.ts`

- Register SIGINT/SIGTERM handlers that call `activeProvider?.close()` before process exit.
- Coordinate with existing signal handlers in `db/connection.ts` and `lock.ts`.

## Risk Assessment

- **Phase 1** is low-risk, small change, eliminates the most common leak path.
- **Phase 2** depends on SDK capabilities; may need to fork or contribute upstream.
- **Phase 3** has signal handler ordering concerns with existing handlers.

## Files Touched

| File | Change |
|------|--------|
| `src/commands/invoke.handler.ts` | try/finally wrapper, module-level provider registry |
| `src/providers/opencode.ts` | SIGKILL escalation in close() |
| `src/providers/lifecycle.ts` (new) | Signal handler registration, provider cleanup coordination |
