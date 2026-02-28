# Reviewer Session Reuse Across Review Cycles

**Version:** 1.0
**Created:** February 27, 2026
**Status:** Draft

**Dependency:** Requires `007-impl-session-continuation` (provides `InvokeOptions.sessionId` and adapter skip-create logic).

## Overview

Current behavior: within a phase's author-review loop (EXECUTE → REVIEW → AUTO_FIX → REVIEW → ...), every REVIEW invocation creates a new OpenCode session. The reviewer re-reads the plan, re-reads the codebase, and rebuilds full context from scratch each cycle. This is wasteful — the reviewer already understands the plan, the review criteria, and the prior issues.

Desired behavior: the first REVIEW of a phase creates a new session with the full `reviewer-commit` template. Subsequent REVIEWs of the same phase reuse the existing session with a shorter follow-up prompt that only references the new commit. The reviewer retains context from prior review cycles and can verify whether its previous feedback was addressed.

Why: each reviewer session spends significant tokens on context rebuild (reading plan, reading code, understanding goals). For phases that go through 2-3 review cycles, this is redundant work. Reuse cuts token cost and latency while improving review quality — the reviewer has direct memory of what it asked for.

## Design Decisions

**Reuse scoped to a single phase.** The `reviewerSessionId` is stored as loop state and cleared on phase transition or abort. Different phases get fresh reviewer sessions — they cover different work.

**Follow-up prompt is inline, not a template.** The reviewer already has the plan context, review criteria, and issue classification rules from the first invocation's full template. The follow-up just needs the new commit hash and an instruction to verify prior feedback. A full template would be redundant context.

**Fallback to fresh session on failure.** If `session.prompt()` fails on the reused session (context exhaustion, session deleted, etc.), clear `reviewerSessionId` and let the normal error handling retry with a fresh session. No special recovery path.

**`onSessionCreated` fires only on first review.** Subsequent reviews reuse the session — the TUI already has it selected. This falls out naturally from the adapter's existing behavior (007 makes `onSessionCreated` fire only when `sessionId` is not provided).

## Scope

In scope:
- Store and reuse reviewer session within a phase's review cycles
- Follow-up review prompt for subsequent reviews
- Graceful fallback on session reuse failure

Out of scope:
- Plan-review loop (different orchestrator, different review pattern)
- Reusing author sessions across AUTO_FIX cycles (different concern)
- Persisting reviewer session across process restart

## Phase 1: Store Reviewer Session Across Review Cycles

- [x] P1.1 — Add reviewerSessionId to phase execution loop state
- [x] P1.2 — Capture sessionId after REVIEW invocation
- [x] P1.3 — Pass sessionId on subsequent REVIEW invocations (full template; follow-up prompt deferred to Phase 2)
- [x] P1.4 — Clear on phase transition and failure

### P1.1 — Add reviewerSessionId to phase execution loop state

**`src/orchestrator/phase-execution-loop.ts`**: Add `let reviewerSessionId: string | undefined` alongside existing loop state variables (near `userGuidance`, `continueSessionId`).

Clear it at the start of each phase iteration (the outer `for` loop over phases), so different phases always start with a fresh reviewer session.

### P1.2 — Capture sessionId after REVIEW invocation

In the REVIEW state, after a successful `adapter.invokeForVerdict()` call (around line 1563 where `upsertAgentResult` runs):

```ts
reviewerSessionId = reviewResult.sessionId;
```

On REVIEW errors (catch block), do not update `reviewerSessionId` — the prior session may still be usable on retry.

### P1.3 — Pass sessionId on subsequent REVIEW invocations

In the REVIEW state, when `reviewerSessionId` is set:

- Pass `sessionId: reviewerSessionId` to `adapter.invokeForVerdict()`
- The full `reviewer-commit` template is still rendered (follow-up prompt optimization deferred to Phase 2)

When `reviewerSessionId` is not set (first review of a phase): existing behavior (full template, new session).

### P1.4 — Clear on phase transition and failure

- [x] Clear `reviewerSessionId` at the start of each phase (outer `for` loop)
- [x] Clear `reviewerSessionId` when state transitions to ABORTED
- [x] On REVIEW invocation failure when `reviewerSessionId` was set: clear it so the retry/escalation path uses a fresh session

## Phase 2: Follow-up Review Prompt

- [x] P2.1 — Build follow-up prompt
- [x] P2.2 — Structured summary prompt unchanged (no-op, confirmed)

### P2.1 — Build follow-up prompt

When `reviewerSessionId` is set, construct the follow-up prompt inline:

```
A new commit ({commit_hash}) has been made in response to your review feedback.

1. Examine the changes introduced at commit {commit_hash} and any subsequent commits.
2. Verify whether the issues from your previous review have been addressed.
3. Identify any new issues introduced by the fixes.
4. Write your updated review as a new addendum to {review_path}.
```

This is short because the reviewer already has:
- The implementation plan context (from the first review's template)
- The review criteria and dimensions
- The issue classification rules (`auto_fix` / `human_required`)
- The structured output format (from the structured summary prompt, which is always sent)

Only `commit_hash` and `review_path` change between cycles. `plan_path` and `review_template_path` are already in context.

### P2.2 — Structured summary prompt unchanged

The adapter's two-prompt pattern (work prompt → structured summary) works identically for both first and follow-up reviews. The structured summary prompt requests the same `ReviewerVerdict` schema regardless. No changes needed.

## Phase 3: Tests

### P3.1 — Phase execution loop tests

- First REVIEW of a phase creates a new session (no `sessionId` in `InvokeOptions`)
- Second REVIEW of same phase passes `reviewerSessionId` via `InvokeOptions.sessionId`
- `reviewerSessionId` is cleared at start of new phase
- `reviewerSessionId` is cleared on REVIEW failure when it was set
- Follow-up prompt contains the new commit hash and review path
- Follow-up prompt does not contain full template content (plan_path variable, review dimensions, etc.)

### P3.2 — Fallback behavior

- When `reviewerSessionId` is set but invocation fails, subsequent retry does not pass `sessionId` (fresh session)

## Files

| File | Change |
|---|---|
| `src/orchestrator/phase-execution-loop.ts` | `reviewerSessionId` state variable, capture after REVIEW, pass on subsequent REVIEW, build follow-up prompt, clear on phase transition/failure |
| Tests | Loop state management, follow-up prompt content, fallback behavior |
