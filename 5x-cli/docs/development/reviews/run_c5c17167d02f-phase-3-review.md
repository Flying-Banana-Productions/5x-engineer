# Review: Phase 3 — Claude Code integration tests + live probe

**Commits:** `25354203b0c7ddec1c34e2e912a281b4d3ffd177` (Phase 3 integration tests + plan), `14c0fcb474a975e64bb48bcdd934e981af7baef0` (concurrent test isolation fix)  
**Scope:** `test/integration/providers/claude-code.test.ts` (mock `claude` binary, `createProvider` → `@5x-ai/provider-claude-code`), `test/integration/providers/claude-code-live.test.ts` (opt-in `CLAUDE_LIVE_TEST` probe), plan updates in `021-claude-code-provider.md`  
**Reviewer:** 5x reviewer (subagent)  
**Local verification:** `bun test test/integration/providers/claude-code.test.ts test/integration/providers/claude-code-live.test.ts --concurrent` — **5 pass, 3 skip** (live tests skipped without `CLAUDE_LIVE_TEST=1` and `claude` on `PATH`)

## Summary

Phase 3 validates **end-to-end factory wiring**: `createProvider("author", config)` dynamically loads the Claude Code plugin and runs real `Bun.spawn` against a bash mock that emits NDJSON / JSON aligned with the provider mapper. Coverage includes streaming lifecycle (`text`, tools, `usage`, `done`), `--json-schema` / `structured_output` on sync and streamed paths, and failure handling (non-zero exit → thrown `run()` / terminal `error` in `runStreamed()`).

The **live probe** is correctly **opt-in** (`CLAUDE_LIVE_TEST=1`, `Bun.which("claude")`), asserts help text still mentions contract flags, exercises `stream-json` with a long timeout + kill guard, and checks `structured_output` for a schema run—good guard against upstream CLI drift without burdening default CI.

Commit **14c0fcb** replaces shared fixed temp paths with **per-test unique directories** (`tmpdir` + timestamp + random suffix) and consistent cleanup, fixing collisions under `bun test --concurrent`.

**Structured verdict (canonical JSON):**

```json
{"readiness":"ready","items":[],"summary":"Phase 3: mock integration tests exercise createProvider + @5x-ai/provider-claude-code (streaming, run, outputSchema, failures); unique temp dirs (14c0fcb) fix concurrent isolation; opt-in live probe documents CLI contract; bun test passes under --concurrent."}
```

## Strengths

- **Plugin loading:** Tests hit the real `loadPlugin` / `create` path—not a direct import of session internals—so resolution and default export shape are exercised.
- **Mock fidelity:** The bash script mirrors flag parsing (`stream-json`, `--json-schema`, session id, failure prompt) and emits representative `stream_event`, tool, and `result` lines.
- **Concurrency:** Isolation fix is minimal and targeted (unique `makeTmpDir` / `tmpProject` patterns).
- **Live probe:** Skips cleanly when unavailable; uses unique project dirs; 120s kill timer on long runs.

## Production Readiness Blockers

None identified for Phase 3 scope.

## High Priority (P1)

None.

## Medium Priority (P2)

### P2.1 — Live spawns use full `process.env`

**Classification:** `human_required` (optional hygiene)

**Observation:** `claude-code-live.test.ts` passes `env: { ...process.env }`. Other integration tests often use `cleanGitEnv()` when spawning subprocesses to avoid inherited `GIT_*` from hooks. The live probe does not run `git` directly; risk is low.

**Recommendation:** Consider `cleanGitEnv()` (merged with any vars `claude` truly needs) for consistency with `AGENTS.md` subprocess guidance—only if you see flaky behavior under git hooks.

## Low Priority / Notes

- **Live flakiness:** Real API runs depend on network/model; opt-in placement is appropriate. The `json-schema` test asserts `structured_output` contains `ok`; upstream behavior changes could require adjustment.
- **Plan doc:** Phase 3 checkboxes in `021-claude-code-provider.md` should stay aligned with what ships (maintainer responsibility).

## Readiness Checklist

**P0 blockers**

- [x] None.

**P1**

- [x] N/A for this phase.

**P2**

- [ ] P2.1 optional — `cleanGitEnv` in live spawns (only if desired for consistency).
