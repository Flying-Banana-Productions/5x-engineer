# 5x CLI — TUI Integration

**Version:** 1.1
**Created:** February 19, 2026
**Updated:** February 19, 2026 — `opencode attach` verified working against a programmatically-started server; design committed
**Status:** Approved for implementation
**Supersedes:** Nothing — additive to `003-impl-5x-cli-opencode.md`

---

## Overview

This document describes the integration of the OpenCode TUI as the display and
interaction layer for `5x run`, `5x plan-review`, and `5x plan`. The
orchestration logic (plan parsing, phase loops, reviewer evaluation, structured
output, DB, locks, worktrees) is unchanged. The change is confined to how
output is rendered to the user and how human gates work in non-auto mode.

### Motivation

The current headless mode pipes raw SSE events to stdout. The formatting is
noisy and unreadable. Rather than invest in a bespoke rendering pipeline, we
leverage the OpenCode TUI — a polished, actively-maintained terminal interface
— as a display layer. The user gets streaming tool calls, diffs, syntax
highlighting, model switching, and session history for free.

### Non-goals

- Changing the orchestration logic or structured output protocol
- Supporting the TUI as the sole interface (headless/CI mode is preserved)
- Building a custom TUI

---

## Architecture

### Current (headless)

```
5x run plan.md
  │
  ├─ createOpencode({ port: 4096 })      ← spawns "opencode serve"
  │   returns { client, server }
  │
  └─ Orchestration loop
      client.session.create()
      client.session.prompt({ format: json_schema })   ← blocks for response
      client.event.subscribe()   ← SSE → log file + stdout (noisy)
      evaluate structured output → next step
```

### Target (TUI-integrated)

```
5x run plan.md
  │
  ├─ createOpencode({ port: <random> })  ← spawns "opencode serve" on free port
  │   returns { client, server }
  │
  ├─ if (isTTY && !--no-tui):
  │   spawn: opencode attach http://127.0.0.1:<port>  ← TUI takes terminal
  │   (stdio: "inherit" — TUI renders everything from this point)
  │
  └─ Orchestration loop  (UNCHANGED internally)
      client.session.create({ title: "Phase 3 — author" })
      client.tui.selectSession({ sessionID })    ← NEW: TUI focuses session
      client.session.prompt({ format: json_schema })  ← UNCHANGED: blocks, returns typed result
      client.event.subscribe()   ← log file only (skip stdout when TUI active)
      evaluate structured output → next step
      client.tui.showToast({ message: "Phase 3 complete" })   ← NEW: phase feedback
```

### Key insight

`opencode attach <url>` connects an OpenCode TUI to an existing server started
by `opencode serve` (or `createOpencode()` from the SDK). This has been
manually verified: a server started programmatically via the SDK accepts a TUI
attached with `opencode attach http://127.0.0.1:<port>`, and the TUI renders
session activity correctly.

The TUI becomes a pure display client — it renders SSE events the server emits.
When `client.session.prompt()` is running, the server pushes streaming events
to both the TUI (for display) and our SSE subscriber (for logging). When the
prompt resolves, 5x-cli gets the structured result as today. The TUI has
already displayed the full conversation in real time.

The structured output pipeline requires zero changes. The TUI is bolt-on.

---

## TUI Mode Detection

| Condition | Behavior |
|---|---|
| stdout is a TTY, no `--no-tui` | TUI mode (default) |
| `--no-tui` flag | Headless mode (current behavior) |
| stdout is not a TTY (pipe/CI) | Headless mode (auto-detected) |
| `--quiet` | Headless mode, logs only |

The `--quiet` flag continues to suppress all console output (log files are
always written). In TUI mode, `--quiet` is ignored — the TUI controls display.

---

## Port Selection

The hardcoded port 4096 is the source of the stale-server conflicts seen in
testing. The new design uses a random available port per invocation.

```typescript
// Find a free port and start the server on it
const port = await findFreePort(); // tries random ports in 14000–15000 range
const { client, server } = await createOpencode({ port, hostname: "127.0.0.1" });
const serverUrl = `http://127.0.0.1:${port}`;
// Pass serverUrl to opencode attach
```

The `opencode attach <url>` command accepts the full URL, so discovery is
trivial. The server URL is returned from `createOpencode()` as `server.url`.

---

## TUI Process Lifecycle

```typescript
// Pseudo-code for TUI spawn + cleanup
const tuiProcess = Bun.spawn(
  ["opencode", "attach", server.url, "--dir", workdir],
  { stdio: ["inherit", "inherit", "inherit"] }
);

registerAdapterShutdown(adapter);  // existing: closes server on SIGINT/SIGTERM

// On orchestration complete:
try {
  await runPhaseExecutionLoop(...);
} finally {
  await adapter.close();     // closes server
  tuiProcess.kill();         // TUI exits (server gone, it will exit anyway)
  releaseLock(...);
}
```

**TUI crash handling:** If the TUI exits before the orchestration completes
(user closes terminal, TUI crash), the orchestration continues in headless
mode. The server is still alive; 5x-cli detects the TUI process has exited and
continues without it. A warning is printed to stderr after the TUI exits.

**Signal flow:** With the TUI owning the terminal, Ctrl-C goes to the TUI
process first. The TUI exits. The `tuiProcess` exit triggers our "TUI exited"
handler which sets `process.exitCode = 1` and lets the orchestration abort
naturally. The `finally` block closes the server.

---

## Session Titles

With the TUI displaying session history, descriptive titles improve readability.

| Step | Current title | New title |
|---|---|---|
| Author phase | `5x-status-<timestamp>` | `Phase 3.1 — author` |
| Reviewer pass 1 | `5x-verdict-<timestamp>` | `Phase 3.1 — review 1` |
| Revision pass | `5x-status-<timestamp>` | `Phase 3.1 — revision 1` |
| Reviewer pass 2 | `5x-verdict-<timestamp>` | `Phase 3.1 — review 2` |
| Plan generation | `5x-status-<timestamp>` | `Plan generation` |
| Plan review | `5x-verdict-<timestamp>` | `Plan review — iteration 1` |

The title is passed to `session.create()`. No other changes to session
management.

---

## TUI Session Switching

After each `session.create()`, 5x-cli calls `client.tui.selectSession()` to
focus the TUI on the new session. The user sees the active session's
conversation stream as the agent works.

```typescript
const session = await client.session.create({ title, directory: workdir });
if (tuiActive) {
  // Best-effort — ignore if TUI has disconnected
  try {
    await client.tui.selectSession({ sessionID: session.data.id });
  } catch { /* ignore */ }
}
```

---

## Human Gates (Non-auto Mode)

In `--auto` mode, phases continue automatically after the reviewer approves.
In interactive (non-auto) mode, 5x-cli currently pauses at a readline prompt
between phases.

With the TUI owning the terminal, readline is not available. The new mechanism:

1. **Phase completes:** 5x-cli shows a toast:
   ```
   client.tui.showToast({
     title: "Phase 3 complete",
     message: "Type 'continue' to start Phase 4, or 'abort' to stop.",
     variant: "info",
   })
   ```

2. **Pre-fill prompt:** 5x-cli injects a hint into the TUI input:
   ```
   client.tui.appendPrompt("continue")
   ```
   The user sees the word "continue" pre-filled. They can edit it to "abort"
   or just press Enter.

3. **Monitor for gate response:** 5x-cli subscribes to SSE events and waits
   for the next `session.idle` on the gate session. The user's input is the
   first message in a lightweight "gate" session. We parse the assistant
   reply (or the user message text directly) for "continue" / "abort" /
   "stop".

4. **Gate session:** A minimal session titled `"Gate — after Phase 3"` is
   created. The first user message is parsed locally (no LLM call needed for
   simple continue/abort decisions). If the user types something other than
   a recognized command, we show another toast asking them to type "continue"
   or "abort".

This mechanism is refined during Phase 3 implementation. The fallback for
headless mode (no TUI) remains the existing readline prompt, unchanged.

---

## SSE Log Streaming

`writeEventsToLog()` currently serves two purposes:
1. Write NDJSON log file for audit/debug
2. Format and print SSE events to stdout

In TUI mode, purpose (2) is handled by the TUI. The `quiet` option passed to
`writeEventsToLog()` becomes `true` when TUI mode is active, suppressing the
stdout path. Log files continue to be written identically.

This requires no changes to `writeEventsToLog()` — it already accepts a
`{ quiet }` option. The adapter caller passes `quiet: true` when TUI is active.

---

## Adapter Changes

`OpenCodeAdapter.create()` currently hardcodes `createOpencode({ timeout: 15_000 })`.
The new version accepts a `port` option to support random port selection.

```typescript
// factory.ts
const port = await findFreePort();
const adapter = await OpenCodeAdapter.create({ model: config.model, port });
const serverUrl = adapter.serverUrl; // NEW: expose for TUI attach
```

`OpenCodeAdapter` gains a `serverUrl` property (already available as
`this.server.url` internally — just needs to be exposed).

---

## Implementation Phases

### Phase 1: Port randomization + server URL exposure

**Goal:** Eliminate hardcoded port 4096. Expose server URL for TUI attach.

- [ ] Implement `findFreePort()` utility in `src/utils/port.ts`
  - Tries random ports in range 14000–15000 until bind succeeds
  - Uses `net.createServer().listen(port)` probe
- [ ] Update `OpenCodeAdapter.create()` to accept `port?: number`
  - Passes port to `createOpencode({ port, timeout: 15_000 })`
  - Defaults to random port when not specified
- [ ] Expose `serverUrl: string` on `OpenCodeAdapter` (from `this.server.url`)
- [ ] Update `AgentAdapter` interface to include `readonly serverUrl: string`
- [ ] Update `createAndVerifyAdapter()` to accept `port?: number` and thread through
- [ ] Tests: `findFreePort()` returns a usable port; adapter exposes serverUrl

**Completion gate:** Tests pass. No hardcoded 4096 references in adapter code.

### Phase 2: TUI spawn + lifecycle

**Goal:** When running in a TTY, spawn `opencode attach` and manage its lifecycle.

- [ ] Implement `TuiController` in `src/tui/controller.ts`:
  ```typescript
  interface TuiController {
    active: boolean;
    selectSession(sessionID: string): Promise<void>;
    showToast(message: string, variant: "info" | "success" | "error"): Promise<void>;
    appendPrompt(text: string): Promise<void>;
    kill(): void;
  }
  ```
  - `createTuiController(serverUrl, workdir, client)` — spawns `opencode attach`,
    returns controller; or returns a no-op controller if TUI mode is disabled
- [ ] Add `--no-tui` flag to `run`, `plan-review`, `plan` commands
- [ ] TTY auto-detection: `process.stdout.isTTY && !args["no-tui"]`
- [ ] Spawn `opencode attach <serverUrl> --dir <workdir>` via `Bun.spawn` with `stdio: "inherit"`
- [ ] Handle TUI exit: monitor child process; if TUI exits during orchestration,
  log a warning and continue headless
- [ ] `TuiController.kill()` called from `finally` blocks after `adapter.close()`
- [ ] No-op `TuiController` (when headless) has identical interface — callers
  don't need `if (tui)` guards everywhere
- [ ] Tests: `createTuiController` with TTY=false returns no-op controller;
  no-op controller's methods resolve without side effects

**Completion gate:** `5x run --no-tui plan.md` behaves identically to today.
`5x run plan.md` in a TTY spawns the TUI via `opencode attach` and keeps it
alive. Manual verification confirmed `opencode attach` works against a
programmatically-started server.

### Phase 3: TUI session integration

**Goal:** TUI tracks the active session; phase transitions are visible.

- [ ] Update `OpenCodeAdapter.invokeForStatus()` and `invokeForVerdict()` to
  accept a `sessionTitle?: string` option (forwarded to `session.create()`)
- [ ] Update all `InvokeOptions` call sites in the orchestrator to pass
  descriptive titles (see Session Titles table above)
- [ ] After each `session.create()`, call `tui.selectSession()` via
  `TuiController`
- [ ] Add `tui.showToast()` calls at key orchestrator events:
  - Phase start: `"Starting Phase N — <title>"`
  - Phase complete (auto mode): `"Phase N complete — starting review"`
  - Review approved: `"Phase N approved — continuing"`
  - Escalation: `"Human required — Phase N escalated"`
  - Error: `"Phase N failed — <reason>"`
- [ ] Pass `quiet: tuiController.active` to `invokeForStatus`/`invokeForVerdict`
  (suppresses SSE stdout formatting when TUI is active)
- [ ] Tests: orchestrator passes correct titles; TuiController methods called
  at expected points (mock TuiController with recorded calls)

**Completion gate:** Running `5x run` in a TTY shows session switches and
toast notifications at phase boundaries.

### Phase 4: Human gates via TUI

**Goal:** Non-auto mode human gates work through the TUI prompt.

- [ ] Design and implement gate session mechanism in `src/tui/gate.ts`:
  - Create a gate session: `client.session.create({ title: "Gate — after Phase N" })`
  - `client.tui.selectSession()` to focus it
  - Show toast with instructions
  - `client.tui.appendPrompt("continue")`
  - Subscribe to SSE `session.idle` events on the gate session
  - First message content is inspected for "continue" / "abort" / "stop"
  - Simple string matching — no LLM call for gate decisions
- [ ] Gate session is deleted after gate resolves:
  `client.session.delete({ sessionID: gateSessionId })`
- [ ] Fallback: in headless mode, gate falls back to current readline behavior
  (no change to existing code path)
- [ ] Tests: gate resolves `continue` on matching input; resolves `abort` on
  abort input; gate session is cleaned up

**Completion gate:** `5x run plan.md` (without `--auto`) in a TTY pauses at
phase boundaries and waits for user input through the TUI.

### Phase 5: Edge cases + polish

- [ ] TUI cold-start delay: show a brief `"Starting OpenCode..."` spinner on
  stderr before the TUI takes over (in the gap between server start and
  TUI attach)
- [ ] Handle `opencode attach` not found (opencode not on PATH): fall back to
  headless with a warning, not a fatal error
- [ ] Handle TUI crash / early exit gracefully (continue headless)
- [ ] Ctrl-C flow: TUI exits → 5x-cli detects → sets `process.exitCode = 1`
  → `finally` cleans up server and lock
- [ ] `plan` command: TUI lifecycle is shorter (single invocation); ensure
  TUI exits cleanly when plan generation completes
- [ ] `--quiet` in TUI mode: warn that `--quiet` is ignored when TUI is active
- [ ] Update `5x init` output to mention TUI mode

**Completion gate:** All integration tests pass. Manual test on `player_desk`
repo shows clean TUI experience across a full multi-phase run.

---

## File Map

| File | Phase | Change summary |
|---|---|---|
| `src/utils/port.ts` | 1 | New: `findFreePort()` utility |
| `src/agents/opencode.ts` | 1 | Accept `port?` in `create()`; expose `serverUrl` |
| `src/agents/types.ts` | 1 | Add `serverUrl` to `AgentAdapter` interface |
| `src/agents/factory.ts` | 1 | Thread `port?` through `createAndVerifyAdapter()` |
| `src/tui/controller.ts` | 2 | New: `TuiController` interface + `createTuiController()` |
| `src/commands/run.ts` | 2, 3, 4 | Add `--no-tui`; spawn TUI; pass controller to orchestrator |
| `src/commands/plan-review.ts` | 2, 3, 4 | Same |
| `src/commands/plan.ts` | 2, 3 | Same (simpler — no human gates) |
| `src/orchestrator/phase-execution-loop.ts` | 3 | Pass TUI controller; session titles; toasts |
| `src/orchestrator/plan-review-loop.ts` | 3 | Same |
| `src/agents/opencode.ts` | 3 | Accept `sessionTitle` in invoke options; pass `quiet` through |
| `src/agents/types.ts` | 3 | Add `sessionTitle?` to `InvokeOptions` |
| `src/tui/gate.ts` | 4 | New: gate session mechanism |
| `src/orchestrator/phase-execution-loop.ts` | 4 | Wire human gate for non-auto mode |
| `test/utils/port.test.ts` | 1 | Port utility tests |
| `test/tui/controller.test.ts` | 2 | TUI controller tests (no-op path) |
| `test/tui/gate.test.ts` | 4 | Gate mechanism tests (mock SSE) |

---

## Open Questions

1. **Permission prompts in TUI mode:** When the agent requests a tool
   permission, the TUI shows a native dialog. In headless mode, 5x-cli would
   need to auto-reply via `client.permission.reply()`. Clarify the expected
   permission model for `5x run` (likely: auto-approve file read/write within
   workdir, require human for bash exec).

3. **Gate UX iteration:** The toast + pre-fill mechanism for human gates is
   a first design. It may need adjustment after hands-on testing. The
   alternative (readline in a side channel) is preserved as a fallback.

4. **Multi-monitor setups / split-pane:** Users often run `5x` in one pane
   and have another terminal open. Consider whether `opencode attach` should
   be optional even in TTY mode — some users may prefer to attach manually.
   `--no-tui` covers this, but `--tui-url` (print the URL and let the user
   attach manually) could be a future addition.

---

## Relationship to Existing Documents

- `003-impl-5x-cli-opencode.md` — governs the orchestration, adapter, DB, and
  structured output pipeline. That document remains authoritative for those
  concerns. This document is additive.
- `001-impl-5x-cli.md` — superseded baseline. Not updated.
- `002-impl-realtime-agent-logs.md` — log file strategy is unchanged. SSE
  event log writing continues as-is; only the stdout rendering path changes.
