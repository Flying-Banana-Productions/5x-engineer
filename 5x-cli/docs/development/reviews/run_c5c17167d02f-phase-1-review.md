# Review: Phase 1 — Claude Code provider pure modules

**Review type:** `2cecee9fec43c9c063debf5340fcd9c0e3d7b6b8` (HEAD; no subsequent commits)
**Scope:** `packages/provider-claude-code/` Phase 1 modules (`model`, `cli-args`, `prompt-guard`, `event-mapper`), package scaffold, unit tests, workspace wiring (`package.json`, `tsconfig.json`, `bun.lock`), plan doc updates
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/providers/claude-code/` — **42 pass, 0 fail**

## Summary

Phase 1 delivers the planned pure-function layer with clear separation of concerns, solid unit coverage, and alignment with the design doc (CLI argv shape, byte-based prompt guard, NDJSON mapping, permission defaults). `buildCliArgs`, `guardPromptSize` / `formatPromptOverLimitMessage`, `parseModelForClaudeCode`, and `mapNdjsonLine` are straightforward to integrate in Phase 2.

One implementation gap: `ClaudeCodeMapperState.accumulatedText` is initialized but never updated, so any Phase 2 consumer expecting a running transcript buffer would get an empty string unless fixed here or in the session layer.

**Readiness:** Not ready — Phase 1 is otherwise solid; one `auto_fix` item (P1.1) should land before closing the phase as complete.

**Issue classification:** The actionable item below is **auto_fix** (mechanical: mutate state when handling `stream_event` text deltas, or explicitly drop the field until Phase 2 with a short comment).

## Strengths

- **Prompt guard:** Byte-accurate `TextEncoder` sizing, stable human-readable over-limit message, boundary tests (ASCII and Unicode) match DD7.
- **CLI args:** Ordering and flags match the plan (`-p`, session flags, model, output format, `--json-schema`, permissions, optional config); tests cover streaming vs JSON and permission modes.
- **Event mapper:** Handles `stream_event` shapes (direct delta and `content_block_delta`), tool correlation via `pendingTools`, `result` → `done` with `structured`, usage, cost, duration; `summarizeToolInput` covers the listed tools with JSON fallback.
- **Workspace:** `packages/**/*` added to `tsconfig` so the package type-checks with the rest of the tree; `workspace:*` devDependency wires resolution for later phases.

## Production Readiness Blockers

None for Phase 1 in isolation (no runtime I/O in scope).

## High Priority (P1)

### P1.1 — `accumulatedText` in mapper state is never updated

**Classification:** `auto_fix`

**Risk:** Phase 2 or debugging may assume `accumulatedText` reflects streamed assistant text; leaving it permanently empty is misleading and could hide integration bugs.

**Requirement:** When mapping `stream_event` lines that yield `{ type: "text", delta }`, append `delta` to `state.accumulatedText` (or remove the field from Phase 1 and restore it in Phase 2 with a one-line rationale). Prefer the minimal fix: update state in `mapNdjsonLine` on the `stream_event` branch after resolving the text event.

## Medium Priority (P2)

- **Tests:** Add an assertion that `jsonSchema: ""` omits `--json-schema` (implementation already skips empty strings).
- **Contract drift:** `mapNdjsonLine` accepts pre-parsed JSON; malformed-line skipping belongs in the Phase 2 NDJSON reader — no action for Phase 1.

## Readiness Checklist

**P0 blockers**

- [x] None identified

**P1 recommended**

- [ ] Address P1.1 (`accumulatedText` or explicit deferral)

## Addendum (2026-04-10) — Follow-up

### What's Addressed

- (Initial review; no addendum yet.)

### Remaining Concerns

- Phase 2 should integrate `hasRun` / `firstInvocationMode` with `CliArgContext.isResume` per DD3 (caller responsibility; `buildCliArgs` API is sufficient for Phase 1).
