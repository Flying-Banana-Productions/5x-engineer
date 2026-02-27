# Session Continuation at Escalation Gate

**Version:** 2.0
**Created:** February 27, 2026
**Status:** Draft

## Overview

Current behavior: when an agent session reports `needs_human` or `failed` and the escalation gate shows `[f/o/q]`, choosing `f` creates a brand-new agent session with zero context from the prior attempt.

Desired behavior: a new `c` option resumes the interrupted OpenCode session. The agent retains full conversation context (tool calls, file reads, partial edits) and picks up where it left off. `f` remains for starting fresh.

Why: restarting from scratch wastes tokens, time, and loses accumulated context. Continuation is the natural expectation.

## Design Decisions

**Reuses `session.prompt()`.** The adapter already sends two prompts per invocation (work + structured summary) to the same session. Continuation is a third message to an existing session. No SDK changes needed.

**`sessionId` carried in-memory on `EscalationEvent`, not queried from DB.** Simpler and avoids coupling to the agent_results table. Does not survive process restart — that's acceptable.

**Only author sessions are continuable.** Reviewer-originated escalations that route to `AUTO_FIX` involve a role change; the reviewer's session has no author context. Only EXECUTE, QUALITY_RETRY, and AUTO_FIX states set `sessionId` on escalation events.

**No continuation after timeouts.** Timeout-originated escalations call `session.abort()` on the remote session. Continuing an aborted session is unreliable. Don't offer `c` — keeps the design simple and avoids needing `abortOnTimeout` config plumbing.

**Failed continuation suppresses repeat `c`.** If an invocation attempted continuation and failed, the resulting escalation omits `sessionId` to force the `f` path. Prevents a loop of retrying a broken session.

**Continuation prompt is inline, not a template.** One or two sentences. The agent already has full context — re-sending plan path, phase number, etc. would be redundant.

## Scope

In scope:
- `c` / `continue-session` escalation option in headless and TUI gates
- Plumb `sessionId` from adapter results → escalation events → state machine → adapter
- Adapter: skip `session.create()` when `sessionId` provided
- Phase execution loop only (`5x run`)

Out of scope:
- Plan-review loop (follow-up)
- Timeout continuation / `abortOnTimeout` config
- DB-backed continuation across process restart
- Cross-role continuation (reviewer → author)

## Phase 1: Types and Plumbing

### P1.1 — Extend EscalationEvent and EscalationResponse

**`src/gates/human.ts`**:

```ts
export interface EscalationEvent {
  // ...existing fields...
  /** Set when the interrupted session can be continued. */
  sessionId?: string;
}

export type EscalationResponse =
  | { action: "continue"; guidance?: string }
  | { action: "continue_session"; guidance?: string }
  | { action: "approve" }
  | { action: "abort" };
```

### P1.2 — Add sessionId to InvokeOptions

**`src/agents/types.ts`**:

```ts
export interface InvokeOptions {
  // ...existing fields...
  /** Existing session ID to continue instead of creating a new session. */
  sessionId?: string;
}
```

### P1.3 — Capture sessionId on escalation events

**`src/orchestrator/phase-execution-loop.ts`**: In author states (EXECUTE, QUALITY_RETRY, AUTO_FIX) that transition to ESCALATE:

- **Success path** (`needs_human`/`failed`): set `event.sessionId` from `InvokeStatus.sessionId`.
- **Error path** (non-timeout): do not set `sessionId` (session state is unknown).
- **Failed continuation**: if `continueSessionId` was set for this invocation, do not set `sessionId` on the new escalation (prevents repeat `c` loop).

Reviewer states (REVIEW) and timeout errors never set `sessionId`.

## Phase 2: Gate, Adapter, and State Machine

### P2.1 — Update headless escalation gate

**`src/gates/human.ts`**: Show `c` only when `event.sessionId` is present:

```
c = continue session (resume the interrupted agent)
f = fix in new session (start fresh with optional guidance)
o = override and move on (force approve this phase)
q = abort (stop execution)
```

`c` prompts for optional guidance (same flow as `f`), returns `{ action: "continue_session", guidance? }`. If `event.sessionId` is absent and user enters `c`, treat as invalid and re-prompt.

### P2.2 — Update TUI escalation gate

**`src/tui/gates.ts`**: Parse `c`, `continue-session` → `{ action: "continue_session" }`. Parse `c: guidance text` → `{ action: "continue_session", guidance }`. Reject `c` when `event.sessionId` is absent. Update toast text to mention `continue-session` only when eligible.

### P2.3 — Adapter: skip session.create() for continuation

**`src/agents/opencode.ts`**: In `_invoke()`:

- When `opts.sessionId` is provided: skip `session.create()`, use the provided ID directly. Fire `onSessionCreated` callback with the existing ID (keeps TUI attach working). Everything else (SSE subscription, prompt sending, structured summary) is identical.
- When not provided: existing behavior.

If `session.prompt()` fails on a continued session (deleted, aborted, etc.), the error propagates normally through existing catch blocks in the state machine.

### P2.4 — ESCALATE handler: continue_session action

**`src/orchestrator/phase-execution-loop.ts`**: Add `let continueSessionId: string | undefined` near existing `userGuidance` variable. In the `"continue_session"` case:

- Set `continueSessionId = lastEscalation.sessionId`
- Set `userGuidance = response.guidance` if provided
- Compute `resumeState` using existing routing (`retryState ?? preEscalateState`)
- Transition to `resumeState`

### P2.5 — Author states: use continuation prompt when continuing

In EXECUTE, QUALITY_RETRY, AUTO_FIX — when `continueSessionId` is set:

- Build prompt: `"Continue the current session and complete all remaining tasks."`
- If `userGuidance` is set, append: `"\n\nThe user has provided the following additional guidance:\n{guidance}"`
- Pass `sessionId: continueSessionId` and the continuation prompt to `adapter.invokeForStatus()`
- Clear `continueSessionId` and `userGuidance` after use

When `continueSessionId` is not set: existing behavior (render template, new session).

## Phase 3: Tests

### P3.1 — Gate tests

- `c` returns `{ action: "continue_session" }` when `event.sessionId` is present
- `c: guidance text` returns `{ action: "continue_session", guidance: "guidance text" }`
- `c` is rejected when `event.sessionId` is absent

### P3.2 — Phase execution loop tests

- `continue_session` action routes to correct `resumeState`
- `continueSessionId` is passed to adapter via `InvokeOptions.sessionId`
- `continueSessionId` is cleared after use
- Failed continuation attempt omits `sessionId` on the next escalation event
- Reviewer-originated escalations do not set `sessionId`
- Author `needs_human` result sets `sessionId` on escalation event

### P3.3 — Adapter tests (if applicable)

- `_invoke()` skips `session.create()` when `opts.sessionId` provided
- `_invoke()` creates new session when `opts.sessionId` not provided

## Files

| File | Change |
|---|---|
| `src/gates/human.ts` | `EscalationEvent.sessionId`, `EscalationResponse` `continue_session`, gate UX |
| `src/tui/gates.ts` | Parse `c` / `continue-session`, eligibility enforcement |
| `src/agents/types.ts` | `InvokeOptions.sessionId` |
| `src/agents/opencode.ts` | Skip `session.create()` when `sessionId` provided |
| `src/orchestrator/phase-execution-loop.ts` | Capture `sessionId` on escalation events, handle `continue_session`, build continuation prompt |
| Tests | Gate parsing, state machine routing, adapter session reuse |
