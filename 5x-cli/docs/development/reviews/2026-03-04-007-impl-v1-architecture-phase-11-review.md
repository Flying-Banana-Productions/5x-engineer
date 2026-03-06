# Review: 007 Impl v1 Architecture — Phase 11 (Event Router Migration)

**Review type:** commit `3d85048` (and follow-ons; none)
**Scope:** `src/providers/event-mapper.ts`, `src/providers/log-writer.ts`, `src/utils/event-router.ts`, `src/utils/stream-writer.ts`, `src/providers/opencode.ts`, `src/commands/invoke.ts`, tests
**Reviewer:** Staff engineer
**Local verification:** `bun test` (fail) — `test/commands/invoke.test.ts` timeout validation (`--timeout 0`) hangs; test times out at 20s and produces empty stdout

## Summary

Phase 11 intent is met: SSE→`AgentEvent` mapping is consolidated into `src/providers/event-mapper.ts`, NDJSON writing is centralized in `src/providers/log-writer.ts`, and console rendering is simplified via `StreamWriter.writeEvent()`.

Main gap: a regression causes `5x invoke ... --timeout 0` to hang instead of failing fast, and the overall test suite currently fails.

**Readiness:** Not ready — P0 test failure + CLI hang on invalid `--timeout`.

## Strengths

- Clean consolidation: mapper state (part registration, delta dedupe, tool dedupe) moved out of `opencode.ts`/`event-router.ts` into a single module.
- `StreamWriter.writeEvent()` reduces duplicated rendering logic and aligns CLI rendering with canonical `AgentEvent` types.
- `log-writer.ts` isolates filesystem concerns (dir perms, sequencing, timestamping) and reduces duplication across commands/providers.
- Mapper tests are broad and readable; they cover key SSE shapes and dedupe behavior.

## Production Readiness Blockers

### P0.1 — `--timeout 0` can bypass validation and hang `invoke`

**Risk:** CLI can hang on invalid user input; `invoke` becomes unreliable; CI is red (`bun test` fails).

**Requirement:** `5x invoke {author|reviewer} ... --timeout 0` must exit quickly with `{ ok: false, error: { code: "INVALID_ARGS" } }` and no provider/server startup. `bun test` passes.

Notes:
- Current `parseTimeout(raw: string | undefined)` treats falsy `0` as “not provided” if the arg parser supplies a number (likely behavior observed in the failing test).

## High Priority (P1)

### P1.1 — Legacy delta mapping only checks `properties.partID`, not `partId`

`resolveSessionIdWithContext()` already handles both `partID`/`partId`, but `mapSseToAgentEvent()` only reads `props.partID`. If OpenCode emits the camelCase variant, text/reasoning deltas will be dropped.

Recommendation:
- Accept both keys in `src/providers/event-mapper.ts` for `message.part.delta` mapping (and add a unit test).

## Medium Priority (P2)

- `src/providers/log-writer.ts` sequence detection only matches `agent-XXX.ndjson` (exactly 3 digits). If any older/manual logs exist as `agent-1.ndjson`, sequencing may restart at `001`. Consider matching `\d+` and still padding output to 3 digits.
- Phase 11 checklist text says event-mapper tests cover `usage`/`done`. Those events are synthesized in `src/providers/opencode.ts` (not mapped from SSE). Either add a focused test asserting `runStreamed()` yields `usage`/`done`, or update the plan/test description to reflect where the contract is enforced.

## Readiness Checklist

**P0 blockers**
- [ ] Fix `invoke` timeout validation so numeric `0` is rejected (and does not start provider work)
- [ ] `bun test` passes

**P1 recommended**
- [ ] Handle both `partID` and `partId` in legacy delta mapping; add regression test

## Addendum (2026-03-05) — Follow-up Review for `70b23a8`

### What's Addressed

- P1.1: `src/providers/event-mapper.ts` now accepts both `properties.partID` and `properties.partId`; regression tests added in `test/providers/event-mapper.test.ts`.
- P2: `src/providers/log-writer.ts` sequence detection now matches `agent-\d+.ndjson`; coverage added (legacy `agent-1.ndjson` / `agent-42.ndjson`).
- P0.1 attempt: `src/commands/invoke.ts` `parseTimeout()` updated to handle `string | number` and explicitly reject numeric `0`.

### Remaining Concerns

- P0.1 still failing: `bun test` continues to time out on `test/commands/invoke.test.ts` “zero timeout is rejected”, with empty stdout (JSON parse EOF). Net: `--timeout 0` is still not reliably rejected early in the integration harness, and the suite remains red.
- P2.2 still open: Phase 11 checklist/test wording around `usage`/`done` coverage remains inconsistent with the implementation (those events are synthesized in `src/providers/opencode.ts`, not mapped from SSE in `src/providers/event-mapper.ts`).

## Addendum (2026-03-05) — Follow-up Review for `e3083c7`

### What's Addressed

- P2.2: Phase 11 plan checklist updated in `docs/development/007-impl-v1-architecture.md` to clarify `usage`/`done` are synthesized in `src/providers/opencode.ts` and covered by `test/providers/opencode.test.ts`.
- P0.1: `test/commands/invoke.test.ts` now passes (verified directly) and the `--timeout 0` regression appears resolved in the invoke test suite.

### Remaining Concerns

- Test suite still failing: `bun test` currently fails in `test/commands/run-v1.test.ts` (`complete with abort status records run:abort step`) via a 5s timeout and exit code 143. This appears newly surfaced now that invoke tests are green, but it still blocks overall readiness.

## Addendum (2026-03-05) — Follow-up Review for `6ca8519`

### What's Addressed

- Full suite is green: `bun test` now passes.
- Plan checklist updated in `docs/development/007-impl-v1-architecture.md` to explicitly capture the review-driven deltas (timeout validation behavior, `partID`/`partId` regression coverage, and log sequence regex).

### Remaining Concerns

- No new issues found in this change set (docs-only) given tests are passing.
