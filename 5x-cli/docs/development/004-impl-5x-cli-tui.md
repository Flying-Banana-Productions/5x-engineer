# 5x CLI — TUI Integration

**Version:** 1.8
**Created:** February 19, 2026
**Updated (latest):** February 21, 2026 — v1.8 re-review closure: human-driven TUI gates via explicit user messages (no model-decided gate path), effective runtime TUI mode for permission/gate selection, deterministic headless rejection for out-of-scope permissions, and TUI early-exit split between cancel (abort) vs close/crash (continue headless).
**Updated:** February 19, 2026 — v1.7: Auto-resume policy for terminal states — auto mode now starts fresh instead of resuming runs stuck at ESCALATE or ABORTED (prevents no-progress loop), with `auto_start_fresh` audit event; v1.6: Orchestrator stdout fully quiet-gated — all `console.log` calls in `phase-execution-loop.ts` and `plan-review-loop.ts` now routed through a `log()` helper that respects `resolveQuiet()`, stdout-silent regression test fixed (intercepts `console.log` directly since Bun's `console.log` bypasses `process.stdout.write`), companion sanity test proves output IS produced when `quiet=false`; v1.5: Phase 2 closure review corrections — `shouldEnableTui()` now requires `--auto` to return true (non-auto flows fail-closed until Phase 5 TUI gates land; `5x plan` exempted as it has no readline gates), `plan.ts invokeForStatus` now includes `tui.active` in quiet (was passing only `effectiveQuiet`), escalation "continue" guidance is only stored when resuming to EXECUTE state (prevents stale guidance leaking to unrelated phases), quiet function re-evaluation test now proves cross-call flipping, stdout-silent regression test added; v1.4: Phase 2 implementation review corrections (2026-02-19-004-impl-5x-cli-tui-review.md addendum) — no-op controller `onExit` is now a no-op (was firing immediately, causing false "TUI exited" warning in headless mode; P0.5), `onExit` registration gated on `isTuiMode` in all commands, stdout output in commands guarded on `!tui.active` (P0.6 output ownership), TUI-by-default rollout gate documented (P0.6/P0.7 — gated on Phases 3-5), `quiet` option accepts `boolean | (() => boolean)` in orchestrators for dynamic re-evaluation on TUI exit (P1.4), `createTuiController` falls back to no-op controller when spawn fails (P1.5 / Phase 6 partial), `_spawner` injectable for testability, adapter coupling future-work note added (P2); v1.3: remaining review concerns — SDK surface validation step at start of Phase 2 with documented fallback protocol for missing APIs, fail-closed non-TTY permission policy (require `--auto`/`--ci` explicitly; non-TTY without either → actionable error), output-ownership wording scoped to `tuiController.active` with explicit stderr guard; v1.2: review corrections (2026-02-19-004-impl-5x-cli-tui-review.md) — deterministic gate protocol via injectable overrides (P0.1), permission policy specified for TUI/headless/CI (P0.2), terminal output ownership rules (P0.3), cooperative Ctrl-C cancellation / guaranteed cleanup (P0.4), `port: 0` instead of `findFreePort()` (P1.1), stdin+stdout TTY detection (P1.2), `--quiet` implies `--no-tui` (P1.3), session focus directory for worktrees and gate session audit retention (P2); v1.1: `opencode attach` verified working against a programmatically-started server
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
  ├─ createOpencode({ port: 0, hostname: '127.0.0.1' })  ← spawns on ephemeral port
  │   returns { client, server }  server.url has the actual port
  │
  ├─ if (stdin.isTTY && stdout.isTTY && !--no-tui && !--quiet):
  │   spawn: opencode attach http://127.0.0.1:<port>  ← TUI takes terminal
  │   (stdio: "inherit" — TUI renders from this point; 5x-cli writes nothing to stdout)
  │
  └─ Orchestration loop  (UNCHANGED internally)
      client.session.create({ title: "Phase 3 — author" })
      client.tui.selectSession({ sessionID, directory: workdir })  ← NEW: TUI focuses session
      client.session.prompt({ format: json_schema })   ← UNCHANGED: blocks, returns typed result
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
| `stdin.isTTY && stdout.isTTY`, no `--no-tui`, no `--quiet` | TUI mode |
| Non-auto mode (`run`, `plan-review` without `--auto`) | TUI mode with human-driven TUI gates |
| `5x plan` | TUI mode if TTY |
| `--no-tui` flag | Headless mode (current behavior) |
| `--quiet` flag | Headless mode, logs only (`--quiet` implies `--no-tui`) |
| stdout is not a TTY (pipe/CI) | Headless mode (auto-detected) |
| stdin is not a TTY (pipe/redirected input) | Headless mode (auto-detected) |

**Effective runtime mode:** Policy/gate selection must use the runtime TUI
state after spawn (`tui.active`), not detection intent alone. If spawn fails,
commands must run as headless from the start (headless permissions + headless
gates). If TUI exits mid-run, commands continue headless and gate behavior
falls back to headless prompts.

**`--quiet` implies `--no-tui`:** `--quiet` is a strong user intent signal to
suppress all output. Attaching a full TUI contradicts that intent. When
`--quiet` is active, TUI mode is unconditionally disabled.

**Both stdin and stdout must be TTYs:** A TUI requires interactive input. Cases
exist where stdout is a TTY but stdin is not (piped input, redirected stdin).
Detecting only `stdout.isTTY` would attach a TUI that cannot receive keyboard
input. TUI mode requires `process.stdin.isTTY && process.stdout.isTTY`.

---

## Port Selection

The hardcoded port 4096 is the source of the stale-server conflicts seen in
testing. The new design uses an OS-assigned ephemeral port per invocation via
`port: 0`.

```typescript
// Use port: 0 — OS assigns an ephemeral port atomically (no TOCTOU race)
const { client, server } = await createOpencode({
  hostname: "127.0.0.1",
  port: 0,
  timeout: 15_000,
});
const serverUrl = server.url; // e.g. "http://127.0.0.1:51234"
// Pass serverUrl to opencode attach
```

Using `port: 0` eliminates the probe race (`findFreePort()` check-then-bind is
a TOCTOU: another process can bind the port between the check and our bind).
The OS-assigned port is already bound when `server.url` is available — no
probing required. This removes the need for a `findFreePort()` utility
entirely.

`OpenCodeAdapter` exposes the server URL as `readonly serverUrl: string`
(from `this.server.url`), and `AgentAdapter` interface gains
`readonly serverUrl: string`.

---

## Terminal Output Ownership

Once `opencode attach` takes over the terminal (stdio: `inherit`), any
parent-process `console.log` / stdout writes corrupt the TUI display.

**Rule: while `tuiController.active === true`, 5x-cli writes nothing to stdout
or stderr.** All parent output is routed through the TUI's own APIs (toasts,
dialogs). Stdout and stderr writes — even to stderr — are gated on
`!tuiController.active`.

The three windows of the process lifetime:

| Window | Condition | Output target |
|---|---|---|
| Pre-attach | Before `opencode attach` spawns | stderr only (startup message) |
| TUI active | `tuiController.active === true` | TUI APIs only (toasts/dialogs) |
| Post-TUI | After TUI exits (or never started) | stdout/stderr as normal |

**Event routing table:**

| Event | While TUI active | While TUI inactive / headless |
|---|---|---|
| Run start banner | `client.tui.showToast(...)` (first thing after attach) | `console.log(...)` |
| Phase start | `client.tui.showToast(...)` | `console.log(...)` |
| Phase complete | `client.tui.showToast(...)` | `console.log(...)` |
| Review approved | `client.tui.showToast(...)` | `console.log(...)` |
| Escalation | `client.tui.showToast(..., { variant: "error" })` | `console.warn(...)` |
| Final summary | `console.error(...)` — **only after TUI exits** | `console.log(...)` |
| Pre-attach startup message | `process.stderr.write(...)` — **before spawn** | N/A |
| TUI exit warning | `process.stderr.write(...)` — **after TUI exits** | N/A |

**Implementation guard:** Every stderr write in TUI-capable code paths must be
conditioned on `!tuiController.active`:

```typescript
// Correct: guarded stderr write
if (!tuiController.active) {
  process.stderr.write(`Warning: ${msg}\n`);
} else {
  tui.showToast(msg, "error").catch(() => {});
}
```

**Pre-attach window:** In the brief interval between server start and TUI
attach, any startup messages (e.g., "Starting OpenCode...") are written to
stderr only. `tuiController.active` is `false` during this window — the guard
above naturally handles it.

**Post-TUI window:** `tuiController.active` flips to `false` when the TUI
process exits (normal completion, user close, crash). From that point, all
output reverts to normal stderr/stdout. The final run summary uses `console.error`
to stderr, ensuring it is visible even if the process exits quickly.

**Log files:** All SSE event log writes and DB writes are unaffected — they
never go to stdout/stderr.

---

## TUI Process Lifecycle

```typescript
// Pseudo-code for TUI spawn + cleanup
let tuiController: TuiController;

// Print startup message to stderr BEFORE TUI takes over
process.stderr.write("Starting OpenCode...\n");

const tuiController = await createTuiController({
  serverUrl: adapter.serverUrl,
  workdir,
  client,
  enabled: isTuiRequested,  // false → returns no-op controller
});

const effectiveTuiMode = tuiController.active;

// cancelController shared with orchestrator loop for cooperative cancellation
const cancelController = new AbortController();

// Handle TUI early exit during orchestration.
tuiController.onExit((info) => {
  // tuiController.active is already false when this fires — safe to write stderr.
  if (info.isUserCancellation) {
    process.stderr.write("TUI interrupted — cancelling run\n");
    cancelController.abort();
    process.exitCode = info.code ?? 130;
    return;
  }

  process.stderr.write("TUI exited — continuing headless\n");
  // orchestration continues without TUI; subsequent tui.* calls are no-ops.
  // permissions/gates are switched to headless behavior.
});

try {
  await runPhaseExecutionLoop({
    ...,
    signal: cancelController.signal,  // NEW: orchestrator respects abort signal
    tui: tuiController,
  });
} finally {
  await adapter.close();
  tuiController.kill();
  releaseLock(...);
}
```

**TUI early-exit handling:** If exit code indicates user cancellation (130/143),
the run is cancelled cooperatively. Otherwise (close/crash), orchestration
continues headless. `tuiController.active` flips to `false`, output resumes via
existing quiet guards, and permissions/gates move to headless behavior.

---

## TUI Rollout Gate

> **Current status (v1.8):** TUI spawn/lifecycle, permission policy, session
> integration, and human gates are implemented. Remaining risk is edge-case
> polish and API hardening.
>
> - **Phase 3 (permission policy + signal handling):** Without this, non-TTY
>   runs lack a permission policy and SIGINT bypass `finally` cleanup in TUI mode.
>   The existing headless `process.exit()` signal behavior is preserved as-is.
> - **Phase 4 (session integration + output ownership):** Orchestrator stdout
>   is now fully quiet-gated (v1.6): all `console.log` calls in both loops
>   route through a `log()` helper that checks `resolveQuiet()`. SSE event
>   stdout from the adapter was already gated on `quiet` (v1.4). Phase 4 still
>   needs toast notification integration and session switching.
> - **Phase 5 (TUI human gates):** Implemented via deterministic user-message
>   subscription in dedicated gate sessions. No model-decided gate path.
>
> **Auto-resume policy (v1.7):** In auto mode, resume detection checks the
> saved state before resuming. If the saved state is `ESCALATE` or `ABORTED`,
> resuming would immediately re-abort (the ESCALATE handler in auto mode goes
> straight to `ABORTED`), creating a no-progress loop on repeated retries.
> Instead, auto mode marks the stuck run as aborted and starts fresh. An
> `auto_start_fresh` audit event is recorded on the old run for traceability.
> This applies to both `phase-execution-loop` and `plan-review-loop`.

---

## Signal Handling and Cooperative Cancellation

The current `registerAdapterShutdown()` in `factory.ts` registers
`process.on("SIGINT", () => process.exit(130))` / `process.on("SIGTERM", () =>
process.exit(143))`. These `process.exit()` calls bypass async `finally`
cleanup blocks in command handlers, risking leaked locks, servers, and
worktrees.

### TUI mode: Ctrl-C and early-exit flow

With TUI owning the terminal, Ctrl-C typically lands on the TUI process first.
`TuiController` captures child exit code and emits exit info:

1. exit `130/143` (user cancellation) -> abort orchestration cooperatively
2. any other exit (close/crash) -> continue orchestration headless

This preserves `finally` cleanup and matches the visible behavior message.

### Headless mode: Ctrl-C flow

In headless mode, SIGINT reaches 5x-cli directly. The existing
`registerAdapterShutdown()` behavior (`process.exit()` in SIGINT/SIGTERM
handlers) is preserved for headless use — the "exit" event fires and
`adapter.close()` runs synchronously. This is the existing behavior from 003
Phase 5 review and is not changed by this plan.

However, the signal handler chain must be updated so that TUI mode registers
**different** SIGINT/SIGTERM behavior:

```typescript
// factory.ts (updated)
export function registerAdapterShutdown(
  adapter: AgentAdapter,
  opts: { tuiMode?: boolean; cancelController?: AbortController } = {},
): void {
  process.on("exit", () => { adapter.close() });  // synchronous close on exit

  if (opts.tuiMode) {
    // TUI mode: Ctrl-C goes to TUI first; we rely on tuiProcess.exited to
    // cooperatively cancel. SIGINT/SIGTERM still need handlers to prevent
    // abrupt termination if somehow delivered to the parent directly.
    process.once("SIGINT",  () => { opts.cancelController?.abort(); process.exitCode = 130; });
    process.once("SIGTERM", () => { opts.cancelController?.abort(); process.exitCode = 143; });
  } else {
    // Headless mode: convert signal to process.exit() to trigger the "exit" event
    if (!_signalHandlersRegistered) {
      _signalHandlersRegistered = true;
      process.on("SIGINT",  () => process.exit(130));
      process.on("SIGTERM", () => process.exit(143));
    }
  }
}
```

### Acceptance criteria

- [x] Ctrl-C in TUI mode: cancellation path aborts orchestrator cooperatively
- [x] Non-cancel TUI exit: orchestration continues headless
- [x] Ctrl-C in headless mode: SIGINT/SIGTERM retain existing `process.exit()` behavior
- [x] Programmatic `cancelController.abort()` stops loops and runs cleanup

---

## Permission Policy

OpenCode tool calls may require explicit permission grants. Unhandled permission
prompts block indefinitely in headless/CI mode. The policy must be specified for
each mode.

### Policy table

| Mode | Permission behavior |
|---|---|
| `--auto` flag | All tool permissions auto-approved. Pass `dangerouslyAutoApproveEverything: true` to session prompt (or equivalent SDK option). |
| `--ci` flag (new) | Same as `--auto` for permissions: all auto-approved. Intended for explicit CI/unattended invocations. |
| TUI mode (non-auto, non-ci) | Permissions handled natively by the TUI; 5x-cli does not reply programmatically while TUI is active. |
| Headless interactive TTY (non-auto, non-ci) | Listen for permission requests via `client.permission.*` events; auto-approve file read/write/exec within `opts.workdir`; reject outside-workdir/unknown deterministically with actionable message. |
| Non-TTY stdin, no `--auto`/`--ci` | **Fail closed:** emit an actionable error before starting and exit non-zero. Do not auto-approve silently. |

**Non-TTY fail-closed rationale:** Automatically granting all tool permissions
in non-interactive mode (non-TTY stdin) without an explicit flag is a
surprising default — the operator may not intend to run unattended. Requiring
an explicit `--auto` or `--ci` flag makes the intent legible in shell history,
CI configs, and audit logs, and prevents accidental unrestricted execution when
a script inadvertently pipes stdin.

The error message for non-TTY without a flag:

```
Error: 5x is running non-interactively but no permission policy was specified.
  Use --auto to auto-approve all tool permissions, or
  use --ci for the same behavior in CI environments.
  To run interactively, ensure stdin is a TTY.
```

### Implementation

The permission behavior is wrapped in a `PermissionPolicy` object and kept out
of the adapter internals:

```typescript
// src/tui/permissions.ts
export type PermissionPolicy =
  | { mode: "auto-approve-all" }                 // --auto or --ci
  | { mode: "tui-native" }                       // TUI handles it
  | { mode: "workdir-scoped"; workdir: string }  // headless interactive TTY

export function createPermissionHandler(
  client: OpencodeClient,
  policy: PermissionPolicy,
): PermissionHandler
```

The handler is wired after adapter creation, before the orchestration loop
starts. Policy is resolved in the command layer:

```typescript
const isNonInteractive = !process.stdin.isTTY;

if (isNonInteractive && !args.auto && !args.ci) {
  // Fail closed — non-TTY without explicit flag
  console.error(NON_INTERACTIVE_NO_FLAG_ERROR);
  process.exitCode = 1;
  return;
}

const permissionPolicy: PermissionPolicy =
  args.auto || args.ci ? { mode: "auto-approve-all" } :
  isTuiMode            ? { mode: "tui-native" } :
  /* headless TTY */     { mode: "workdir-scoped", workdir };
```

> **`--ci` flag:** Add `ci: { type: "boolean", default: false }` to `run`,
> `plan-review`, and `plan` command args. Semantically: "I know this is
> unattended, proceed with all permissions approved." Operationally identical
> to `--auto` for permission resolution; kept separate so `--auto` retains its
> meaning of "skip human phase gates too," while `--ci` only opts into
> permission auto-approval without affecting gate behavior.

### Acceptance criteria

- [ ] `--auto` mode: agent tool calls proceed without permission dialogs (no hang)
- [ ] `--ci` mode: same permission behavior as `--auto`; phase gates still apply
- [ ] Non-TTY stdin without `--auto`/`--ci`: exits with code 1 and actionable
  error message before any adapter is created
- [ ] Headless interactive TTY (non-auto, non-ci): file read/write within workdir
  is auto-approved; operations outside workdir prompt
- [ ] Test that would hang without policy: mock a permission request event with
  no reply handler → assert it is handled within 5s (timeout = test failure)

---

## Human Gates (Non-auto Mode)

In `--auto` mode, phases continue automatically after the reviewer approves.
In interactive (non-auto) mode, 5x-cli currently pauses at a readline prompt
between phases.

With the TUI owning the terminal, readline is not available. The new mechanism
uses the **existing injectable gate override pattern** already present in the
orchestrator loops (`options.phaseGate`, `options.escalationGate`,
`options.resumeGate`). TUI mode supplies TUI-backed implementations; headless
mode uses the existing readline implementations unchanged.

### Gate protocol

| Context | Gate mechanism |
|---|---|
| TUI active | Dedicated gate session + deterministic user-message subscription (`message.updated`/`message.part.updated`, role=`user`) |
| Headless TTY | Existing readline prompt (`gates/human.ts`) |
| Non-interactive stdin | Auto-abort (existing behavior in `gates/human.ts` when `!process.stdin.isTTY`) |
| Resume flow | `resumeGate` override behaves identically to non-resume flow |

### TUI gate implementation

`src/tui/gates.ts` now creates a short-lived gate session, focuses it in the
TUI, and waits for explicit user text input (for example: `continue`,
`approve`, `start-fresh`, `abort`).

Key properties:

- No model-driven gate path (`client.session.prompt()` is not used for gate decisions)
- Decision source is user-authored message events only (`role === "user"`)
- Timeout/cancel/TUI-exit resolve deterministically to `"abort"`
- Listener cleanup is explicit (`AbortSignal` + TUI exit unsubscribe) to avoid accumulation on long runs

### Gate cleanup

Gate sessions are created per invocation and deleted on completion/abort.
This keeps gate interaction isolated while preserving deterministic behavior.

### Fallback for headless mode

In headless mode (no TUI), the gate falls back to the current readline
behavior:

```typescript
// No TUI — use existing readline gates
const phaseGate = tuiController.active
  ? createTuiPhaseGate(client, tuiController)
  : undefined;  // undefined → orchestrator uses default gates/human.ts

await runPhaseExecutionLoop({ ..., phaseGate });
```

Passing `undefined` is equivalent to today's behavior — the orchestrator
lazy-imports `gates/human.ts` for the default implementation. No changes to
`gates/human.ts`.

### Acceptance criteria

- [x] TUI gate blocks on explicit user-authored message input
- [x] No model can satisfy a gate decision path on behalf of the user
- [x] Gate timeout/cancel/TUI-exit resolve to `"abort"`
- [x] Headless fallback remains `gates/human.ts`

---

## TUI Session Switching

After each `session.create()`, 5x-cli calls `client.tui.selectSession()` to
focus the TUI on the new session. The user sees the active session's
conversation stream as the agent works.

```typescript
const session = await client.session.create({ title, directory: workdir });
if (tuiActive) {
  try {
    await client.tui.selectSession({
      sessionID: session.data.id,
      directory: workdir,  // always pass workdir for worktree-correctness
    });
  } catch { /* ignore — TUI may have disconnected */ }
}
```

**Worktree note:** `client.tui.selectSession()` supports an optional
`directory` parameter. We always pass `workdir` so that multi-workdir runs
(where `workdir` is the worktree path, not the primary checkout) focus the TUI
on the correct directory context. This is particularly important for worktree
runs where `workdir !== projectRoot`.

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
The new version uses `port: 0` and exposes `serverUrl`.

```typescript
// opencode.ts
static async create(opts: { model?: string } = {}): Promise<OpenCodeAdapter> {
  const { client, server } = await createOpencode({
    hostname: "127.0.0.1",
    port: 0,            // OS assigns ephemeral port — no TOCTOU race
    timeout: 15_000,
  });
  return new OpenCodeAdapter(client, server, opts.model);
}

get serverUrl(): string {
  return this.server.url;
}
```

The `port` option from the previous plan iteration is removed — `port: 0` is
always used (there is no use case for passing a specific port in v1). The
`findFreePort()` utility from Phase 1 is not needed.

`AgentAdapter` interface gains `readonly serverUrl: string`.

---

## Implementation Phases

### Phase 1: Port randomization + server URL exposure

**Goal:** Eliminate hardcoded port 4096. Expose server URL for TUI attach.

**Change from v1.1:** Use `port: 0` instead of `findFreePort()`. No port
utility file needed.

- [x] Update `OpenCodeAdapter.create()` to pass `{ hostname: "127.0.0.1", port: 0, timeout: 15_000 }` to `createOpencode()`
- [x] Expose `get serverUrl(): string` on `OpenCodeAdapter` (returns `this.server.url`)
- [x] Add `readonly serverUrl: string` to `AgentAdapter` interface in `src/agents/types.ts`
- [x] Tests: adapter exposes `serverUrl` with expected hostname/port format; port is not hardcoded 4096

**Completion gate:** Tests pass. No hardcoded 4096 references in adapter code.

### Phase 2: TUI spawn + lifecycle

**Goal:** When running in an interactive TTY (both stdin and stdout), spawn
`opencode attach` and manage its lifecycle.

**SDK surface validation (do first, before writing controller code):**
Before implementing Phase 2 or 3, verify the following SDK APIs against the
installed `@opencode-ai/sdk` version:

- `client.tui.showToast(...)` — used in Phases 2, 4
- `client.tui.selectSession(...)` — used in Phase 4
- `message.updated` / `message.part.updated` user events — used in Phase 5 gate decisions
- `client.permission.*` subscribe + reply — used in Phase 3

Phase 5 uses deterministic user-message subscription in a dedicated gate
session. This avoids any model-decided path and does not depend on a blocking
dialog API.

If `client.permission.*` reply API does not exist, consult the SDK docs for
the correct auto-approval mechanism (e.g., a session-creation flag such as
`dangerouslyAutoApproveEverything`). The `PermissionPolicy` abstraction layer
is designed for exactly this swap — policy decisions stay in the command layer
regardless of which underlying API is used.

Record findings (API names, method signatures, any gaps) in a brief note at
the top of `src/tui/controller.ts` before submitting Phase 2 for review.

- [x] Implement `TuiController` in `src/tui/controller.ts`:
  ```typescript
  interface TuiController {
    active: boolean;
    attached: boolean;
    selectSession(sessionID: string, directory?: string): Promise<void>;
    showToast(message: string, variant: "info" | "success" | "error"): Promise<void>;
    onExit(handler: (info: TuiExitInfo) => void): () => void;
    kill(): void;
  }
  ```
  - `createTuiController(opts: { serverUrl, workdir, client, enabled })` — spawns
    `opencode attach` if `enabled`, returns no-op controller otherwise
- [x] Add `--no-tui` flag to `run`, `plan-review`, `plan` commands
- [x] TTY auto-detection: `process.stdin.isTTY && process.stdout.isTTY && !args["no-tui"] && !args.quiet`
- [x] Spawn `opencode attach <serverUrl> --dir <workdir>` via `Bun.spawn` with `stdio: "inherit"`
- [x] Print `"Starting OpenCode..."` to **stderr** before spawn (pre-attach window)
- [x] Handle TUI exit: `tuiController.onExit()` callback sets `tuiController.active = false`;
  subsequent `tui.*` calls become no-ops; orchestration continues headless
- [x] No-op `TuiController` (when headless) has identical interface — callers
  don't need `if (tui)` guards everywhere
- [x] Tests:
  - `createTuiController({ enabled: false })` returns no-op controller
  - No-op controller's methods resolve without side effects
  - No-op controller `active === false`
  - No-op controller `onExit` does NOT fire the handler (no TUI was started)
  - `createTuiController` falls back to no-op controller when spawn fails (P1.5)
- [x] Guard stdout/stderr writes in commands on `!tui.active` (P0.6)
- [x] Gate `onExit` handler registration on `isTuiMode` in all three commands (P0.5)

**Completion gate:** `5x run --no-tui plan.md` behaves identically to today.
`5x run plan.md` in a TTY with `--auto` spawns the TUI via `opencode attach`
and keeps it alive. Headless mode emits no spurious "TUI exited" warnings.
See "TUI Rollout Gate" section for non-auto limitations until Phases 3–5.

### Phase 3: Permission policy + signal handling

**Goal:** Wire permission policy; update signal handling to support cooperative
cancellation in TUI mode.

- [x] Implement `createPermissionHandler(client, policy)` in `src/tui/permissions.ts`:
  - `"auto-approve-all"`: subscribe to permission requests; reply "approve" immediately
  - `"tui-native"`: no-op handler (TUI handles it natively)
  - `"workdir-scoped"`: subscribe; auto-approve paths under workdir; escalate others
- [x] Add `--ci` flag to `run`, `plan-review`, `plan` commands:
  `ci: { type: "boolean", default: false, description: "CI/unattended mode: auto-approve all tool permissions" }`
- [x] Fail-closed check in command layer before adapter creation:
  ```typescript
  if (!process.stdin.isTTY && !args.auto && !args.ci) {
    console.error(NON_INTERACTIVE_NO_FLAG_ERROR);
    process.exitCode = 1;
    return;
  }
  ```
- [x] Resolve policy in command layer (run.ts, plan-review.ts, plan.ts):
  ```typescript
  const policy: PermissionPolicy =
    args.auto || args.ci ? { mode: "auto-approve-all" } :
    isTuiMode            ? { mode: "tui-native" } :
    /* headless TTY */     { mode: "workdir-scoped", workdir };
  ```
- [x] Update `registerAdapterShutdown()` in `src/agents/factory.ts` to accept
  optional `{ tuiMode, cancelController }`:
  - TUI mode: registers SIGINT/SIGTERM handlers that call `cancelController.abort()`
    + set `process.exitCode` (no `process.exit()`)
  - Headless mode: existing `process.exit()` behavior (unchanged)
- [x] Create a shared `cancelController = new AbortController()` in command handlers;
  pass `cancelController.signal` to orchestrator options (as `signal?: AbortSignal`)
- [x] Wire TUI exit → `cancelController.abort()` + `process.exitCode = 1` in the
  `tuiController.onExit()` callback (for Ctrl-C via TUI)
- [x] Tests:
  - `"auto-approve-all"` handler approves a mock permission request immediately
  - Permission handler test that would hang without policy (mock request + assert
    resolved within 1s)
  - TUI-mode signal handler sets `cancelController.aborted === true` (no `process.exit()`)
  - Headless-mode signal handler: existing behavior preserved

**Completion gate:** A `--auto` run in non-TTY mode does not hang on permission
prompts. TUI-mode Ctrl-C cancels the orchestrator and runs `finally` cleanup.

### Phase 4: TUI session integration

**Goal:** TUI tracks the active session; phase transitions are visible; no
stdout writes from 5x-cli after TUI attach.

- [x] Update `OpenCodeAdapter.invokeForStatus()` and `invokeForVerdict()` to
  accept a `sessionTitle?: string` option (forwarded to `session.create()`)
- [x] Update all `InvokeOptions` call sites in the orchestrator to pass
  descriptive titles (see Session Titles table above)
- [x] After each `session.create()`, call `tui.selectSession(sessionId, workdir)`
  via `TuiController`
- [x] Add `tui.showToast()` calls at key orchestrator events (replacing any
  `console.log()` calls that would interleave with TUI):
  - Phase start: `"Starting Phase N — <title>"`
  - Phase complete (auto mode): `"Phase N complete — starting review"`
  - Review approved: `"Phase N approved — continuing"`
  - Escalation: `"Human required — Phase N escalated"`
  - Error: `"Phase N failed — <reason>"`
- [x] Pass `quiet: () => tuiController.active` to `invokeForStatus`/`invokeForVerdict`
  (function form so TUI exit mid-run is reflected; orchestrators already accept
  `boolean | (() => boolean)` as of v1.4)
- [x] Verify no `console.log()` / stdout writes from 5x-cli after TUI attach in
  TUI mode (stdout-clean guarantee)
- [x] Tests:
  - Orchestrator passes correct titles to adapter
  - `TuiController.selectSession()` called after each `session.create()`
  - `TuiController.showToast()` called at phase boundaries (mock with recorded calls)
  - No stdout output from orchestrator when `tuiController.active === true`
    (integration-ish test: no-op controller + forced quiet, verify no stdout writes)

**Completion gate:** Running `5x run` in a TTY shows session switches and
toast notifications at phase boundaries without any stdout corruption.

### Phase 5: Human gates via TUI

**Goal:** Non-auto mode human gates are truly human-driven while TUI owns stdin.

- [x] Implement TUI gate factories in `src/tui/gates.ts`:
  - `createTuiPhaseGate(client, tui, opts)` — returns injectable `phaseGate` function
  - `createTuiEscalationGate(client, tui, opts)` — returns injectable `escalationGate`
  - `createTuiResumeGate(client, tui, opts)` — returns injectable `resumeGate`
  - All use deterministic user-message subscription (`role=user`) in a dedicated gate session
  - All include timeout semantics (`timeoutMs`, default 30 min → resolves `"abort"`)
  - All respect `cancelController.signal` and TUI exit with explicit listener cleanup
- [x] Wire in `commands/run.ts`: if TUI active, pass TUI gate factories to
  `runPhaseExecutionLoop` options; else pass `undefined` (uses `gates/human.ts`)
- [x] Wire in `commands/plan-review.ts`: same pattern with `humanGate` override
- [x] Fallback: in headless mode, all gate options are `undefined` →
  orchestrator uses default readline behavior (no changes to `gates/human.ts`)
- [x] Tests:
  - Gate resolves decisions from explicit user messages
  - Gate resolves `"abort"` after timeout (fast timeout in test)
  - Gate resolves `"abort"` when `cancelController.signal` is aborted
  - Gate resolves `"abort"` when `tuiController.active` becomes false mid-wait

**Completion gate:** `5x run plan.md` (without `--auto`) in a TTY pauses at
phase boundaries and resumes only after explicit user message input.

### Phase 6: Edge cases + polish

- [x] Handle `opencode attach` not found (opencode not on PATH): fall back to
  headless with a warning on stderr, not a fatal error
  *(implemented in Phase 2 v1.4 — `createTuiController` catches spawn errors)*
- [x] Handle TUI crash / early exit gracefully (continue headless on non-cancel exits)
- [x] `plan` command: TUI lifecycle is shorter (single invocation); ensure
  TUI exits cleanly when plan generation completes
  *(TUI killed in finally block after single invoke, same pattern as run/plan-review)*
- [x] `--quiet` in TUI mode: document that `--quiet` always implies `--no-tui`
  (no warning needed — it is consistent by definition)
  *(implemented in `shouldEnableTui()`: returns false when `args.quiet` is true)*
- [x] Update `5x init` output to mention TUI mode and `--no-tui`
- [x] TUI cold-start delay: print `"Starting OpenCode..."` to stderr before
  TUI attach (already in Phase 2 — verified working end-to-end)

**Completion gate:** All integration tests pass. Manual test on `player_desk`
repo shows clean TUI experience across a full multi-phase run.

---

## File Map

| File                                             | Phase      | Change summary                                                                                                                                  |
| ------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/opencode.ts`                         | 1          | Use `port: 0`; expose `get serverUrl()`                                                                                                         |
| `src/agents/errors.ts`                           | 6          | Shared agent timeout/cancellation errors for adapter-agnostic orchestrator handling                                                              |
| `src/agents/types.ts`                            | 1          | Add `readonly serverUrl: string` to `AgentAdapter` interface                                                                                    |
| `src/tui/controller.ts`                          | 2, 6       | `TuiController` lifecycle + spawn fallback; `onExit` now returns unsubscribe and surfaces exit classification (cancel vs non-cancel)             |
| `src/commands/run.ts`                            | 2, 3, 4, 5, 6 | Add `--no-tui`, `--ci`; spawn TUI; effective runtime mode for policy/gates; non-cancel exit continues headless; cancel exits abort cooperatively |
| `src/commands/plan-review.ts`                    | 2, 3, 4, 5, 6 | Same as run                                                                                                                                       |
| `src/commands/plan.ts`                           | 2, 3, 4, 6 | Same (single invoke) with effective runtime mode + non-cancel headless continuation                                                             |
| `src/orchestrator/phase-execution-loop.ts`       | 2          | v1.4: `quiet` option accepts `boolean \| (() => boolean)`                                                                                       |
| `src/orchestrator/plan-review-loop.ts`           | 2          | v1.4: same `quiet` type change                                                                                                                  |
| `src/agents/factory.ts`                          | 3          | `registerAdapterShutdown()` accepts TUI mode option                                                                                             |
| `src/tui/permissions.ts`                         | 3          | New: permission policy + handler                                                                                                                |
| `src/orchestrator/phase-execution-loop.ts`       | 4          | TUI controller; session titles; toasts; signal option (`quiet` type already updated in v1.4 Phase 2)                                            |
| `src/orchestrator/plan-review-loop.ts`           | 4          | Same                                                                                                                                            |
| `src/agents/opencode.ts`                         | 4          | Accept `sessionTitle` in invoke options; pass `quiet` through                                                                                   |
| `src/agents/types.ts`                            | 4          | Add `sessionTitle?` to `InvokeOptions`                                                                                                          |
| `src/tui/gates.ts`                               | 5          | TUI gate implementations using deterministic user-message subscription (no model-decided gate path)                                             |
| `src/orchestrator/phase-execution-loop.ts`       | 5          | Wire TUI gates for non-auto mode                                                                                                                |
| `test/agents/opencode.test.ts`                   | 1          | serverUrl exposure test                                                                                                                         |
| `test/tui/controller.test.ts`                    | 2          | TUI controller tests (no-op path); v1.4: no-op `onExit` assertion inverted, spawn-failure fallback test                                         |
| `test/orchestrator/phase-execution-loop.test.ts` | 2          | v1.4: quiet function form test                                                                                                                  |
| `test/tui/permissions.test.ts`                   | 3          | Permission policy tests (hang-prevention test)                                                                                                  |
| `test/tui/gates.test.ts`                         | 5          | Gate mechanism tests (explicit user message input, timeout, cancel, headless-safe behavior)                                                     |

**Removed from v1.1 file map:**
- `src/utils/port.ts` — not needed; `port: 0` replaces `findFreePort()`
- `test/utils/port.test.ts` — not needed
- `src/tui/gate.ts` — replaced by `src/tui/gates.ts` (plural; contains all gate types)

---

## Open Questions

1. **Gate UX polish:** Current Phase 5 gates use gate sessions + explicit user
   message replies. This is correct and deterministic; future polish can improve
   copy and affordances without changing the contract.

2. **TUI control API adoption:** `client.tui.control.*` remains available for
   future richer interactions, but is not required for correctness now that
   user-message-driven gates are in place.

3. **Multi-monitor setups / split-pane:** Users often run `5x` in one pane
   and have another terminal open. Consider whether `opencode attach` should
   be optional even in TTY mode — some users may prefer to attach manually.
   `--no-tui` covers this, but `--tui-url` (print the URL and let the user
   attach manually) could be a future addition.

4. **Adapter coupling / `_clientForTui`:** Commands currently cast `adapter`
   to `OpenCodeAdapter` to access the `_clientForTui` getter. If/when other
   adapter implementations exist, consider formalizing a minimal "TUI client
   surface" on the `AgentAdapter` interface, or providing it via the adapter
   factory rather than a cast. The `_clientForTui` prefix signals that this is
   a stopgap; it should be promoted or refactored in Phase 4 when the TUI
   integration is more deeply integrated.

---

## Relationship to Existing Documents

- `003-impl-5x-cli-opencode.md` — governs the orchestration, adapter, DB, and
  structured output pipeline. That document remains authoritative for those
  concerns. This document is additive. Cross-references:
  - Phase 3 of 003 (`opencode.ts`): updated by Phase 1 of this document
    (`port: 0`, `serverUrl` exposure)
  - Phase 5 of 003 (`factory.ts`, `registerAdapterShutdown`): updated by
    Phase 3 of this document (TUI-mode cooperative cancellation)
  - `AgentAdapter` interface (Phase 1.4 of 003, `types.ts`): gains
    `readonly serverUrl: string` in Phase 1 of this document
- `001-impl-5x-cli.md` — superseded baseline. Not updated.
- `002-impl-realtime-agent-logs.md` — log file strategy is unchanged. SSE
  event log writing continues as-is; only the stdout rendering path changes.
