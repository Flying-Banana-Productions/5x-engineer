# Session Continuation at Escalation Gate

**Version:** 1.1
**Created:** February 27, 2026
**Updated:** February 27, 2026
**Status:** Draft

## Revision History

- **1.1 (2026-02-27):** Address review feedback in `docs/development/reviews/2026-02-27-007-impl-session-continuation-plan-review.md` (P0: handle new `EscalationResponse` action everywhere; explicit eligibility policy encoded on the event; include plan-review loop; decide timeout semantics; adjust test plan; fix symbol/path references).
- **1.0 (2026-02-27):** Initial draft.

## Overview

Current behavior: when an agent session is interrupted (reports `needs_human` or `failed`) and the user is presented with the escalation gate `[f/o/q]`, choosing `f` (fix) creates a brand-new agent session. The new session has zero context from the prior attempt — no tool calls, file reads, partial edits, or conversation history. The only carryover is optional guidance text injected into the template's `user_notes` variable.

Desired behavior: a new `c` (continue session) option resumes the interrupted agent session by sending a follow-up message to the existing OpenCode session. The agent retains full conversation context and can pick up where it left off. The existing `f` option remains for cases where a fresh start is preferred.

Why this change: interrupted sessions often have significant partial work completed. Restarting from scratch wastes tokens, time, and may produce different (worse) results without the accumulated context. Session continuation is the natural user expectation when "continuing" interrupted work.

## Design Decisions

**Session continuation reuses the OpenCode `session.prompt()` API, not a new mechanism.** The adapter already sends two prompts per invocation (work + structured summary) to the same session. Continuation is simply a third+ message to an existing session. No SDK gap.

**The `sessionId` is plumbed through `EscalationEvent`, not queried from the DB.** While `agent_results` stores session IDs, querying the DB adds coupling and race conditions. Carrying the ID in-memory through the escalation event is simpler and more reliable.

**Eligibility for `c` is explicit and enforced (not inferred by the gate).** The gate only offers `c` when the orchestrator sets a dedicated continuation payload on the escalation event (see `EscalationEvent.continueSession`). This prevents incorrect “continue reviewer session but route to author AUTO_FIX” behavior.

**Session continuation failures fall through to existing error handling.** If `session.prompt()` fails on the existing session (aborted, deleted, not found), the error propagates through the normal catch blocks in the state machine, creating a new escalation event. The user sees the gate again and can choose `f` to start fresh. No special error class or recovery path needed.

**The continuation prompt is minimal and inline, not a template.** It is one or two sentences, not a full frontmatter template. The agent already has full context from its prior conversation — re-sending the plan path, phase number, etc. would be redundant.

**Timeouts preserve the remote session to make `c` viable.** On timeout we stop waiting locally and throw `AgentTimeoutError` (carrying `sessionId`), but we do not call `client.session.abort(...)` by default. (Explicit cancellation/abort still aborts.)

**Limitation (explicit): in-memory only.** Continuation metadata is carried in-memory through the escalation event; it does not survive process restart/resume.

## Scope

In scope:

- Add a new escalation decision `c` / `continue-session` that reuses an existing OpenCode session.
- Plumb continuation metadata from adapter → orchestrators → escalation gate.
- Handle the new `EscalationResponse` action everywhere it is consumed (no hangs / silent ignores).
- Update both headless (stdin) and TUI parsers/UX.
- Update `docs/10-dashboard.md` to document the new response shape.

Out of scope:

- DB-backed continuation across process restart.
- Cross-role continuation (e.g., continue reviewer session but route into author AUTO_FIX).
- Fixing unrelated logging issues (e.g., `! [object Object]`).

## Phase 1: Plumb Continuation Metadata to the Escalation Gate

### P1.1 — Add sessionId to error classes

**`src/agents/errors.ts`**: Add optional `sessionId?: string` property to `AgentTimeoutError`. Accept it as a constructor parameter.

No change needed for `AgentCancellationError` — cancellation goes to ABORTED, never reaches the escalation gate.

### P1.2 — Attach sessionId to errors in the adapter

**`src/agents/opencode.ts`**: In `_invoke()` catch block (around line 1077), when constructing `AgentTimeoutError`, pass the local `sessionId` variable:

```ts
throw new AgentTimeoutError(
  `Agent timed out after ${timeoutMs}ms`,
  sessionId,
);
```

### P1.3 — Add continuation metadata to EscalationEvent

**`src/gates/human.ts`**: Add a dedicated continuation payload so the gate doesn’t need to infer eligibility from state machine internals:

```ts
export interface EscalationEvent {
  // ...existing fields...

  /** When set, `c` may be offered to reuse an existing agent session. */
  continueSession?: {
    sessionId: string;
    resumeState: string;
    role: "author" | "reviewer";
  };
}
```

### P1.4 — Capture continuation metadata in phase execution loop

**`src/orchestrator/phase-execution-loop.ts`**: In each state that can transition to ESCALATE (EXECUTE, QUALITY_RETRY, REVIEW, AUTO_FIX):

- **Success path** (`needs_human`/`failed` result): extract `sessionId` from `InvokeStatus`/`InvokeVerdict` and include in `EscalationEvent.continueSession` with the correct `role` and `resumeState`.
- **Error path** (timeout, network error): extract `sessionId` from `AgentTimeoutError.sessionId` if available and include it in `EscalationEvent.continueSession` (best-effort).

This requires capturing the sessionId before it goes out of scope at the end of each case block. The cleanest approach is to include it directly on the `EscalationEvent` being constructed.

Eligibility enforcement (P0): for any escalation where the next invocation role/state differs from the session being continued (e.g., reviewer-originated escalation that routes into author `AUTO_FIX`), do not set `continueSession`.

### P1.5 — Capture continuation metadata in plan-review loop

**`src/orchestrator/plan-review-loop.ts`**: When building an `EscalationEvent` from an agent invocation result/error, include `continueSession` only when the next invocation will use the same role/template family as the session being continued. This loop has both reviewer and author invocations; tag `continueSession.role` accordingly.

## Phase 2: Add `c` Option to Escalation Gate

### P2.1 — Extend EscalationResponse type

**`src/gates/human.ts`**: Add `"continue_session"` as a valid action:

```ts
export type EscalationResponse =
  | { action: "continue"; guidance?: string }
  | { action: "continue_session"; guidance?: string }
  | { action: "approve" }
  | { action: "abort" };
```

### P2.2 — Update headless escalation gate

**`src/gates/human.ts`**: In `escalationGate(event)`:

- Show `c` option only when `event.continueSession?.sessionId` is present
- Display text:
  ```
  c = continue session (resume the interrupted agent)
  f = fix in new session (start fresh with optional guidance)
  o = override and move on (force approve this phase)
  q = abort (stop execution)
  ```
- When user enters `c`: prompt for optional guidance (same flow as `f`), return `{ action: "continue_session", guidance? }`

Enforcement: if the user enters `c` when `event.continueSession` is unset, treat it as invalid input (interactive) and re-prompt.

### P2.3 — Update plan-review loop headless gate

`plan-review` currently has its own stdin prompt (`defaultHumanGate`) in **`src/orchestrator/plan-review-loop.ts`**.

Plan:

- Prefer replacing `defaultHumanGate` with a thin wrapper around **`src/gates/human.ts`** `escalationGate(event)` so option sets and eligibility checks stay consistent.
- If we keep a separate prompt, it must match the same `c` option rules (`event.continueSession`) and return `{ action: "continue_session" }`.

### P2.4 — Update TUI escalation gate

**`src/tui/gates.ts`**: In `parseEscalationDecision()`:

- Parse `c`, `continue-session` → `{ action: "continue_session" }`
- Parse `c: some guidance` → `{ action: "continue_session", guidance: "some guidance" }`

Enforcement (P0): `createTuiEscalationGate(event)` must reject `continue_session` when `event.continueSession` is unset (treat as invalid input and show the existing invalid-input toast).

Update the toast message to mention `continue-session` only when the event is eligible.

## Phase 3: Handle `continue_session` in All Consumers (P0)

### P3.1 — Add continue_session case to ESCALATE handler

**`src/orchestrator/phase-execution-loop.ts`**: In the ESCALATE handler (around line 1994):

- Add `let continueSessionId: string | undefined` alongside existing `userGuidance` variable (near line 590).
- In the `"continue_session"` case:
  - Set `continueSessionId = lastEscalation.continueSession?.sessionId`
  - Set `userGuidance = response.guidance` if provided
  - Compute `resumeState` from the event payload (prefer `lastEscalation.continueSession?.resumeState`; fall back to existing `retryState ?? preEscalateState`)
  - Transition to `resumeState`

### P3.2 — Handle continue_session in plan-review loop

**`src/orchestrator/plan-review-loop.ts`**: Audit all `EscalationResponse` consumers (including any `switch (response.action)`) and explicitly handle `"continue_session"`.

Minimum safe behavior: treat `continue_session` like `continue` for state progression, but also store the continued `sessionId` so the next agent invocation can pass `InvokeOptions.sessionId`.

## Phase 4: Adapter Support for Session Continuation

### P4.1 — Add sessionId to InvokeOptions

**`src/agents/types.ts`**: Add optional field:

```ts
export interface InvokeOptions {
  // ... existing fields ...
  /** Existing session ID to continue instead of creating a new session */
  sessionId?: string;
}
```

### P4.2 — Modify _invoke() to support continuation

**`src/agents/opencode.ts`**: In `_invoke()`:

- When `opts.sessionId` is provided:
  - Skip `session.create()` call
  - Use `opts.sessionId` as the `sessionId` local variable
  - The rest of the flow (SSE subscription, prompt sending, structured summary, timeout/abort) remains identical
- When `opts.sessionId` is NOT provided: existing behavior (create new session)

The prompt text (`opts.prompt`) will contain the continuation message instead of a rendered template — the adapter doesn't care about the content, it just sends it.

### P4.2b — TUI/session callback semantics (P2)

Continuation skips `session.create()`, so any UI behavior that relies on `InvokeOptions.onSessionCreated` won’t fire.

Plan (pick one, keep behavior consistent across create vs reuse):

- Add a new callback (e.g., `onSessionReady` / `onSessionUsed`) that is invoked for both new and reused sessions (with an `isNew` flag), and migrate TUI code to use it, or
- Invoke `onSessionCreated(sessionId)` for reuse as well (minimal change, but the name becomes slightly misleading).

### P4.3 — Timeout behavior (decision reflected in implementation)

**`src/agents/opencode.ts`**: Change timeout handling to preserve the remote session so `c` is viable:

- On timeout: stop waiting locally and throw `AgentTimeoutError` with `sessionId`.
- Do not call `client.session.abort(...)` on timeout by default.

If we keep any abort-on-timeout behavior (e.g., via an opt-in flag), document that `c` is best-effort for timeouts under that configuration.

### P4.4 — Error handling for continuation failures

No special error handling needed in the adapter. If `session.prompt()` fails because the session is aborted, deleted, or otherwise unusable, the error propagates normally. The phase execution loop's existing catch blocks will:

1. Create a new `EscalationEvent` with the error message
2. Transition to ESCALATE
3. The user sees the gate again with the error context and can choose `f` to start fresh

## Phase 5: Wire Continuation into State Machine

### P5.1 — Build continuation prompt in EXECUTE / QUALITY_RETRY / AUTO_FIX states

**`src/orchestrator/phase-execution-loop.ts`**: At the top of each state that calls `adapter.invokeForStatus()`:

- If `continueSessionId` is set:
  - Build continuation prompt: `"Continue the current session and complete all remaining tasks."`
  - If `userGuidance` is set, append: `"\n\nThe user has provided the following additional guidance:\n{guidance}"`
  - Pass `sessionId: continueSessionId` and the continuation prompt to the adapter
  - Clear `continueSessionId` and `userGuidance` after use (same as existing pattern for `userGuidance`)
- If `continueSessionId` is NOT set: existing behavior (render template, create new session)

### P5.2 — Handle REVIEW state continuation (if applicable)

If the escalation originated from a reviewer error (timeout during review), the `resumeState` would be `REVIEW` and the adapter call is `invokeForVerdict()`. The same pattern applies: send a continuation prompt to the existing session, follow with the structured summary prompt.

However, reviewer-originated escalations that route to an author state (e.g., `resumeState = "AUTO_FIX"`) must not offer `c`. This is enforced by omitting `event.continueSession` when the role/state boundary changes (Phase 1), so gates don’t need to infer it from `preEscalateState`.

## Phase 6: Tests

Test strategy avoids stdin-driven interactive unit tests: `src/gates/human.ts` disables interactivity under `NODE_ENV=test`, and plan-review has historically duplicated stdin prompts. Coverage comes from TUI parsing tests + orchestrator tests with injected gate functions.

### P6.1 — TUI parsing tests (primary)

**`test/tui/gates.test.ts`**:

- `parseEscalationDecision("c")` → `{ action: "continue_session" }`
- `parseEscalationDecision("continue-session")` → `{ action: "continue_session" }`
- `parseEscalationDecision("c: fix the import")` → `{ action: "continue_session", guidance: "fix the import" }`

### P6.2 — Orchestrator integration tests (no stdin)

Add/update tests that inject an escalation gate function returning `continue_session` and assert:

- Phase-execution loop: `continue_session` resumes the correct state and passes `InvokeOptions.sessionId`.
- Plan-review loop: `continue_session` is handled explicitly (no hang / no silent ignore), and the next invocation reuses the session ID when eligible.
- Eligibility enforcement: role/state mismatch cases do not set `event.continueSession`, and TUI enforcement rejects `continue_session` when not eligible.

### P6.3 — Unit tests for error classes

- `AgentTimeoutError` carries `sessionId` property
- `AgentTimeoutError` without sessionId has `undefined`

### P6.4 — Integration tests for phase execution loop

- `continue_session` action routes to correct `resumeState`
- `continueSessionId` is passed to adapter invocation
- `continueSessionId` is cleared after use
- Reviewer-originated escalation that routes to author states does not set `continueSession`

## Docs Updates

**`docs/10-dashboard.md`**: Update escalation gate response shape docs to include `continue_session`.

## Files / Touchpoints

- `src/gates/human.ts` (EscalationEvent: `continueSession`; EscalationResponse: `continue_session`; headless `escalationGate` UX)
- `src/tui/gates.ts` (parse + eligibility enforcement + toast text)
- `src/orchestrator/phase-execution-loop.ts` (build escalation events; handle `continue_session`; pass `InvokeOptions.sessionId`)
- `src/orchestrator/plan-review-loop.ts` (build escalation events; handle `continue_session`; reuse sessionId when eligible)
- `src/agents/types.ts` (InvokeOptions.sessionId; session callback semantics)
- `src/agents/opencode.ts` (reuse `opts.sessionId`; timeout semantics; callback behavior)
- `src/agents/errors.ts` (AgentTimeoutError.sessionId)
- `docs/10-dashboard.md` (document new action)
- `test/tui/gates.test.ts` + orchestrator tests (cover parsing + state machine safety)

## Completion Gates

P0 blockers:

- All `EscalationResponse` consumers explicitly handle `continue_session` (phase-execution loop, plan-review loop, TUI gate wrapper logic).
- `c` is only offered when `EscalationEvent.continueSession` is set; role/state mismatch cases never set it.

P1 recommended:

- Timeout behavior is implemented as decided (preserve remote session on timeout by default) and reflected in UX/plan text.
- Plan references match actual symbols/paths (`escalationGate()`, `createTuiEscalationGate()`, etc.).
- Tests cover `continue_session` without relying on interactive stdin unit tests.
