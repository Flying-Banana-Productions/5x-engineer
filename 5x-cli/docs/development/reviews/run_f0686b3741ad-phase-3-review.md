# Review: Phase 3 — Cursor Agent integration and workspace wiring

**Review type:** `77b51707307da961fa6e87f59481eb2f3b5d195a`, `2d474133f356b9b70e8f61c7e7082b63093de2ef`  
**Scope:** Phase 3 only per `docs/development/plans/022-cursor-agent-provider.md` — workspace resolution, mock-`agent` integration tests, opt-in live CLI probe, and regression verification  
**Reviewer:** Staff engineer (reliability, test harness safety, provider factory integration)  
**Local verification:** `bun test test/unit/providers/cursor-agent/ test/integration/providers/cursor-agent.test.ts test/unit/providers/plugin-loading.test.ts` (109 pass); `bun test --concurrent` (2179 pass, 8 skip, 0 fail)

**Implementation plan:** `docs/development/plans/022-cursor-agent-provider.md`  
**Technical design:** N/A

## Summary

Commits `77b5170` and `2d47413` complete Phase 3: the `@5x-ai/provider-cursor-agent` package resolves through the existing factory, integration tests exercise the full provider lifecycle with a bash mock emitting documented Cursor `stream-json` fixtures, and an opt-in live probe guards upstream CLI contract drift. The follow-on fix correctly replaces process-wide `PATH` mutation with per-test absolute `agentBinary` paths, making the suite safe under `--concurrent`.

All Phase 3 checklist items are satisfied; no production blockers were found. The cursor-agent provider plan is implementation-complete pending manual smoke with a real authenticated `agent` binary.

**Readiness:** Ready — Phase 3 completion gate is met and full regression passes under `--concurrent`.

---

## What shipped

- **`test/integration/providers/cursor-agent.test.ts`**: Nine integration tests covering `createProvider` → `startSession` → `runStreamed`/`run` → `close`, `AuthorStatus` structured extraction, `resumeSession` without `create-chat`, `CURSOR_API_KEY` env forwarding (not argv), non-zero exit handling, binary-not-found install hint, create-chat auth failure, and explicit `stdin: "ignore"` / `cleanGitEnv()` spawn hygiene.
- **`test/integration/providers/cursor-agent-live.test.ts`**: Four opt-in probes (`CURSOR_AGENT_LIVE_TEST=1`) for help text, `create-chat`, read-only JSON prompt, and `stream-json` system/result events.
- **Plan update**: Phase 3 checklist items marked complete in `022-cursor-agent-provider.md`.
- **Concurrent fix (`2d47413`)**: Refactored mock harness to pass absolute mock binary paths via `[cursor-agent].agentBinary` instead of mutating `process.env.PATH`; renamed mock executable to `mock-cursor-agent` to avoid collisions with a real `agent` on PATH.

---

## Strengths

- **Plan coverage**: Every Phase 3.2 test requirement is exercised — factory resolution, full streaming lifecycle, structured output, resume semantics, secret env forwarding, failure messaging, and repo spawn conventions.
- **Mock fidelity**: The bash mock emits Cursor-shaped NDJSON (system init, partial assistant delta, correlated tool start/end, terminal result) aligned with the Phase 1 event mapper, so integration tests validate the real spawn→parse→map path rather than stubbing internals.
- **Concurrent safety**: The follow-on commit removes `withMockPath()` PATH mutation — a known footgun under parallel test execution — in favor of absolute binary paths configured through the provider's own `agentBinary` setting. This matches the Claude Code integration pattern and AGENTS.md guidance.
- **Live probe discipline**: Live tests are gated, skip when `agent` is absent, use read-only prompts with kill timers, and assert only documented contract surfaces (flags, session IDs, event types) without brittle field-level expectations.
- **Regression confidence**: Full suite (`bun test --concurrent`, 2179 pass) confirms no collateral impact to plugin loading or existing provider tests.

---

## Production readiness blockers

None for Phase 3 scope.

---

## High priority (P1)

None for Phase 3 scope.

---

## Medium priority (P2)

- **Unused delay hook**: The mock script implements `__MOCK_CURSOR_DELAY__` (3s sleep) but no integration test exercises timeout behavior at this tier. Acceptable because unit tests cover inactivity timeout and cancellation; an integration-level timeout test would further lock end-to-end kill semantics if desired.
- **Phase 2 carryover**: P2 items from the Phase 2 review (unused error imports, `buildCreateChatArgs` reuse, post-`done` non-zero exit edge case) remain open but are outside Phase 3 scope and non-blocking for provider use.
- **Manual smoke**: Plan verification still recommends `5x invoke author ... --author-provider cursor-agent` with an authenticated Cursor install; this is operator verification, not an automated gate.

---

## Readiness checklist

**P0 blockers**

- [x] None identified

**P1 recommended**

- [x] N/A for Phase 3 scope

---

## Addendum (2026-05-24) — Phase 3 review including concurrent fix

**Reviewed:** `77b51707307da961fa6e87f59481eb2f3b5d195a`, `2d474133f356b9b70e8f61c7e7082b63093de2ef`

### What's addressed (✅)

- **Phase 3.1**: Workspace dependency resolves; `import("@5x-ai/provider-cursor-agent")` and `createProvider("author", …)` work via existing factory behavior.
- **Phase 3.2**: Mock-`agent` integration tests cover full lifecycle, structured output, resume, env-based secrets, and failure paths with `stdin: "ignore"` and `cleanGitEnv()`.
- **Phase 3.3**: Opt-in live probe with appropriate gating and minimal contract assertions.
- **Phase 3.4**: Targeted and full regression suites pass, including `--concurrent`.
- **Concurrent fix**: Absolute mock binary paths eliminate PATH races; mock renamed to avoid real-binary shadowing.

### Remaining concerns

- P2 polish items above are optional follow-ups, not merge blockers.
- Manual end-to-end invoke smoke with authenticated Cursor Agent remains recommended before production rollout.

### Updated readiness

- **Phase 3 completion:** ✅ — Integration wiring, mock tests, live probe, and regression verification are in place.
- **Plan implementation:** ✅ — All three phases complete; feature ready for use with documented manual verification.
