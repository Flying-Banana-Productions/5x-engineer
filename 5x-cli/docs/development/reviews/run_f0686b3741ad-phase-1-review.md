# Review: Phase 1 — Cursor Agent provider pure functions

**Review type:** `57daeab6e726297fde971480afe7c21e30e93dde`  
**Scope:** Phase 1 only per `docs/development/plans/022-cursor-agent-provider.md` — package scaffold, config parser, CLI argv builder, env builder, prompt guard, structured-output helpers, and stream-json event mapper (no subprocess/session lifecycle)  
**Reviewer:** Staff engineer (security, reliability, provider contract alignment)  
**Local verification:** `bun test test/unit/providers/cursor-agent/` (57 pass); `bun test test/unit/providers/plugin-loading.test.ts` (17 pass)

**Implementation plan:** `docs/development/plans/022-cursor-agent-provider.md`  
**Technical design:** N/A

## Summary

Commit `57daeab` delivers the Phase 1 completion gate: all pure helpers for `@5x-ai/provider-cursor-agent` are implemented with focused unit coverage and no subprocess spawning. The package follows the external plugin pattern used by `provider-claude-code`, including workspace wiring, `ProviderPlugin` export, tolerant config parsing with `force=true` / `trust=true` defaults, argv construction aligned with DD2, secret injection via environment variables (DD7), prompt byte guarding (DD8), prompt-based structured output extraction (DD4), and Cursor `stream-json` → `AgentEvent` mapping (DD5–DD6).

A minimal `CursorAgentProvider` stub correctly defers session lifecycle to Phase 2. No production blockers were found within Phase 1 scope.

**Readiness:** Ready — Phase 1 checklist is complete, tests pass, and the implementation matches the plan's design decisions.

---

## What shipped

- **Package scaffold**: `packages/provider-cursor-agent/` with `@5x-ai/provider-cursor-agent`, ESM exports, peer dependency on `@5x-ai/5x-cli`, and root workspace devDependency.
- **Config & plugin entry**: `parseCursorAgentPluginConfig`, `CursorAgentConfig` type, default `cursor-agent` plugin export.
- **CLI argv builder**: `buildCreateChatArgs`, `buildRunArgs` with documented flag order and provider-wide `--force` default.
- **Env builder**: `buildSubprocessEnv` preserving ambient env and injecting `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` without mutating `process.env`.
- **Prompt guard**: `MAX_PROMPT_BYTES` (256 KiB), byte counting, stable over-limit message shape.
- **Structured output**: `wrapPromptForStructuredOutput`, `extractStructuredOutput` with exact JSON → fenced JSON → terminal fallback order.
- **Event mapper**: `CursorAgentMapperState`, `mapCursorAgentLine`, partial-delta filtering, tool correlation, terminal `usage`/`done` with zero token counts.
- **Unit tests**: Six test files covering all Phase 1 modules (57 tests).

---

## Strengths

- **Pattern consistency**: Prompt guard, env builder, and plugin config parsing mirror `provider-claude-code` conventions, reducing cognitive load for maintainers.
- **Security posture**: Secrets are injected via environment variables only; CLI arg builder has no secret parameters.
- **Partial-stream semantics**: Event mapper correctly skips duplicate assistant flushes (`timestamp_ms` + `model_call_id`) and accumulates partial deltas into `finalAssistantText` for structured extraction in Phase 2.
- **Tolerant config parsing**: Invalid optional fields are ignored rather than throwing; empty strings and empty arrays are filtered appropriately.
- **Test quality**: Tests assert argv order, default/override behavior, Unicode byte boundaries, fallback extraction order, and documented event sequences without subprocess overhead.

---

## Production readiness blockers

None for Phase 1 scope.

---

## High priority (P1)

None for Phase 1 scope. Session lifecycle, NDJSON reader, subprocess kill/timeout, and integration tests are correctly deferred to Phases 2–3 per the plan.

---

## Medium priority (P2)

- **Lockfile churn**: `bun.lock` drops peer-resolution entries for `@5x-ai/provider-invalid` and `@5x-ai/provider-sample` while adding the cursor-agent entry. Tests pass today; consider verifying `bun install` from a clean tree during Phase 3 integration to ensure no regression.
- **Structured extract redundancy**: `extractStructuredOutput` calls `extractFromFencedBlock` after `extractFromText`, which already attempts fenced parsing. Harmless but could be simplified in a follow-up.
- **Assistant edge case**: In partial mode, an assistant line with `model_call_id` but no `timestamp_ms` falls through to the non-partial emit path. Unlikely per Cursor docs; add a fixture if live probes surface this shape.
- **Phase 2 stub visibility**: `CursorAgentProvider` rejects `startSession`/`resumeSession` with a clear message. Ensure Phase 3 integration tests cover the stub until Phase 2 lands so factory resolution does not silently appear broken.

---

## Readiness checklist

**P0 blockers**

- [x] None identified

**P1 recommended**

- [x] N/A for Phase 1 (session/subprocess work tracked in Phases 2–3)

---

## Addendum (2026-05-24) — Initial review

**Reviewed:** `57daeab6e726297fde971480afe7c21e30e93dde`

### What's addressed (✅)

- **Phase 1.1–1.7**: All plan checklist items marked complete in the commit are satisfied by the implementation and unit tests.
- **Completion gate**: Pure helpers are implemented and covered without spawning subprocesses.

### Remaining concerns

- Phases 2–3 (session lifecycle, provider close, mock/live integration) remain open per the plan and are out of scope for this review.

### Updated readiness

- **Phase 1 completion:** ✅ — All pure-function modules and tests are in place.
- **Ready for next phase:** ✅ — Proceed to Phase 2 session and provider implementation.
