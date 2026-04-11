# Review: Phase 1 — Claude Code provider pure modules

**Review type:** `7fb00493e5626b78ecff1e5cf69a34b4604ac9a1` (includes R1 `accumulatedText` fix atop `2cecee9fec43c9c063debf5340fcd9c0e3d7b6b8`)
**Scope:** `packages/provider-claude-code/` Phase 1 modules (`model`, `cli-args`, `prompt-guard`, `event-mapper`), package scaffold, unit tests, workspace wiring (`package.json`, `tsconfig.json`, `bun.lock`), plan doc updates
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/providers/claude-code/` — **43 pass, 0 fail**

## Summary

**First pass (`2cecee9fec43c9c063debf5340fcd9c0e3d7b6b8`):** Phase 1 delivers the planned pure-function layer with clear separation of concerns, solid unit coverage, and alignment with the design doc (CLI argv shape, byte-based prompt guard, NDJSON mapping, permission defaults). `buildCliArgs`, `guardPromptSize` / `formatPromptOverLimitMessage`, `parseModelForClaudeCode`, and `mapNdjsonLine` are straightforward to integrate in Phase 2.

One implementation gap was identified: `ClaudeCodeMapperState.accumulatedText` was initialized but never updated, so any Phase 2 consumer expecting a running transcript buffer would have seen an empty string.

**Second pass (`7fb00493e5626b78ecff1e5cf69a34b4604ac9a1`):** R1 is fixed: `stream_event` branches append `delta` to `state.accumulatedText` only when the mapped event is `{ type: "text" }`; `thinking_delta` / reasoning does not append. Unit tests cover the first delta, multi-chunk `"ab"` concatenation, and reasoning leaving the buffer empty.

**Readiness:** Ready — Phase 1 completion gate in `021-claude-code-provider.md` is satisfied; remaining notes are optional P2 polish (not blockers).

**Issue classification (first pass):** P1.1 was **auto_fix** — resolved in `7fb00493`.

## Strengths

- **Prompt guard:** Byte-accurate `TextEncoder` sizing, stable human-readable over-limit message, boundary tests (ASCII and Unicode) match DD7.
- **CLI args:** Ordering and flags match the plan (`-p`, session flags, model, output format, `--json-schema`, permissions, optional config); tests cover streaming vs JSON and permission modes.
- **Event mapper:** Handles `stream_event` shapes (direct delta and `content_block_delta`), tool correlation via `pendingTools`, `result` → `done` with `structured`, usage, cost, duration; `summarizeToolInput` covers the listed tools with JSON fallback.
- **Workspace:** `packages/**/*` added to `tsconfig` so the package type-checks with the rest of the tree; `workspace:*` devDependency wires resolution for later phases.

## Production Readiness Blockers

None for Phase 1 in isolation (no runtime I/O in scope).

## High Priority (P1)

### P1.1 — `accumulatedText` in mapper state is never updated — **resolved in `7fb00493`**

**Classification:** `auto_fix` (landed)

**Risk:** (Historical) Phase 2 or debugging could have assumed `accumulatedText` reflected streamed assistant text.

**Resolution:** `mapNdjsonLine` updates `state.accumulatedText` after `mapStreamEvent` when the event is `{ type: "text" }`; tests assert accumulation and non-text exclusion.

## Medium Priority (P2)

- **Tests:** Add an assertion that `jsonSchema: ""` omits `--json-schema` (implementation already skips empty strings).
- **Contract drift:** `mapNdjsonLine` accepts pre-parsed JSON; malformed-line skipping belongs in the Phase 2 NDJSON reader — no action for Phase 1.

## Readiness Checklist

**P0 blockers**

- [x] None identified

**P1 recommended**

- [x] Address P1.1 (`accumulatedText` or explicit deferral) — fixed in `7fb00493`

## Addendum (2026-04-10) — Follow-up

### What's Addressed

- First-pass review recorded P1.1; see **Addendum (2026-04-10) — Second pass** below for verification of the fix.

### Remaining Concerns

- Phase 2 should integrate `hasRun` / `firstInvocationMode` with `CliArgContext.isResume` per DD3 (caller responsibility; `buildCliArgs` API is sufficient for Phase 1).

## Addendum (2026-04-10) — Second pass: R1 `accumulatedText` fix

### What's Addressed

- **P1.1:** `event-mapper.ts` — on `type === "stream_event"`, the mapped event from `mapStreamEvent` is applied; if `ev?.type === "text"`, `state.accumulatedText += ev.delta` before return. Reasoning/`thinking_delta` paths do not mutate the buffer.
- **Tests:** Renamed and extended `event-mapper.test.ts` — single `text_delta` updates `accumulatedText`, two sequential deltas yield `"ab"`, `thinking_delta` leaves `accumulatedText` empty.

### Remaining Concerns

- **P2 (optional):** Assert `jsonSchema: ""` omits `--json-schema` in `cli-args` tests; Phase 2 owns malformed NDJSON line skipping in the reader.

### Local verification (second pass)

- `bun test test/unit/providers/claude-code/` — **43 pass, 0 fail**
