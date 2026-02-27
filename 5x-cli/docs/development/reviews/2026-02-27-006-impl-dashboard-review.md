# Review: 006-impl-dashboard (Implementation Plan)

**Review type:** `docs/development/006-impl-dashboard.md`
**Scope:** Dashboard command/server, WS protocol, DB polling, log watching, gate bridge integration, frontend static assets, tests
**Reviewer:** Staff engineer
**Local verification:** Not run (plan + code review)

## Summary

Plan matches repo direction (DB/logs as SOT, Bun runtime, no bundler) and is implementable, but a few correctness details will cause silent staleness or flaky cross-process control if not fixed.

**Readiness:** Ready with corrections  Fix polling (upsert + rowid), gate file atomicity, and shutdown/signal handling.

## Strengths

- Clear separation: dashboard reads DB/logs; gate bridge is the only write path.
- Avoids schema migrations by anchoring incremental updates on `run_events.id`.
- Vanilla static assets + embedding is consistent with existing `src/templates/loader.ts` pattern.
- Explicit test plan across command, security, data polling, watchers, and gate races.

## Production Readiness Blockers

### P0.1  Incremental polling will miss updates (rowid + upserts)

**Risk:** Dashboard shows stale agent/quality data on resume/retry because `MAX(rowid)` does not change on `ON CONFLICT DO UPDATE`.

**Requirement:** Replace `MAX(rowid)` cursors for `agent_results`/`quality_results` with an update-detectable strategy:
- Preferred: drive incremental fetch off `run_events` (already appended on invocations/verdicts/quality) and re-query affected runs/phases by key.
- Or: poll on `(created_at, id)` (since upserts set `created_at=datetime('now')`) with a tie-breaker, not `rowid`.

### P0.2  Gate resolution is not first-writer-wins with temp+rename alone

**Risk:** Two dashboard tabs (or terminal + dashboard) can clobber each other; "last writer wins" breaks determinism and auditability.

**Requirement:** Define and test an atomic resolve primitive:
- Create resolved file with exclusive create semantics (`writeFile(..., { flag: 'wx' })` / `open(..., 'wx')`) so the second responder fails.
- Ensure orchestrator treats any later writes as stale and emits an auditable no-op.

### P0.3  Graceful shutdown plan conflicts with existing SIGINT/SIGTERM `process.exit()` handlers

**Risk:** `getDb()`/lock cleanup register signal handlers that call `process.exit(...)` (see `src/db/connection.ts`, `src/lock.ts`), which prevents awaiting an async `stop()` path; dashboard server may exit mid-flight and leave partial writes.

**Requirement:** Make dashboard shutdown deterministic without relying on async work after a forced exit:
- Prefer `openDbReadOnly()` for the dashboard to avoid `getDb()` signal hooks.
- Ensure the dashboard command owns SIGINT/SIGTERM handling and can synchronously stop accepting new connections before exit.
- If shared signal hooks must remain, document that dashboard shutdown is best-effort and avoid promising graceful stop in the completion gate.

## High Priority (P1)

### P1.1  Phase ordering: gate watchers before gates exist

Phase 3 introduces gate watchers/responder, but Phase 4 is when orchestrators start emitting gate files. Either move gate watcher work after Phase 4, or explicitly stub/fixture gate files for Phase 3 validation.

### P1.2  Token file semantics for multi-instance dashboards

Persisting a single `.5x/dashboard-token` is ambiguous if multiple dashboards run (different ports). Recommend namespacing by pid/port (or store a small JSON with `{ pid, port, token, startedAt }`).

### P1.3  Keep `human_decision` payloads backward-compatible

Current orchestrators already emit `human_decision` with different shapes for phase gate vs escalation (`src/orchestrator/phase-execution-loop.ts`, `src/orchestrator/plan-review-loop.ts`). If adding pending/resolved semantics, either:
- Add new event types (`gate_request`, `gate_resolved`) and leave existing payloads untouched, or
- Version `human_decision.data` and ensure the dashboard handles both.

### P1.4  Read-only DB connection needs reliability knobs

`openDbReadOnly()` does not set `busy_timeout`; concurrent writers may surface transient "database is locked" errors. Add bounded retry/backoff or set `PRAGMA busy_timeout` even on read-only connections.

## Medium Priority (P2)

- Bound resource usage: log streaming/backfill must cap bytes/lines per request and per-connection memory.
- Validate WS inputs strictly (size limits, schema checks) even though this is localhost-by-default.
- Consider token-in-URL leakage (browser history/referrer); acceptable for local tools, but document it.

## Readiness Checklist

**P0 blockers**
- [ ] Fix incremental polling cursors to detect upsert updates (no `rowid` high-water for upserted tables)
- [ ] Implement true first-writer-wins atomic gate resolution and race tests
- [ ] Resolve shutdown/signal handling so dashboard can stop deterministically

**P1 recommended**
- [ ] Reorder Phase 3/4 gate work (or add fixtures) so gates can be validated when introduced
- [ ] Namespace token persistence for multi-instance clarity
- [ ] Keep `human_decision` payloads compatible (or introduce new gate event types)
- [ ] Add read-only DB busy handling/backoff

## Addendum (2026-02-27) -- Re-review after plan v1.1 updates

Updated assessment: Ready with corrections -- remaining issues are mechanical spec gaps (auth plumbing, bootstrap edge cases).

### What's Addressed

- Polling strategy: run_events.id high-water + key-based re-queries; avoids upsert/rowid staleness.
- Gate bridge semantics: explicit first-writer-wins (wx) resolve + stale responder audit behavior.
- Shutdown model: dashboard uses read-only DB handle; command owns signals; avoids getDb()/lock process.exit hooks.
- Multi-instance token: token file namespaced by port + 0600 perms.
- Phase ordering: gate watcher validation via fixtures before orchestrator bridge rollout.

### Remaining Concerns

- P0: Token auth vs static assets -- if static routes require auth, define how HTML propagates token to /style.css and /app.js (query param, cookie, or inline assets) and add an integration test to prevent 401-on-assets regressions.
- P1: Fresh-project bootstrap -- define behavior when .5x/5x.db (or .5x/) does not exist yet (serve empty snapshot vs error) and cover with tests.
- P1: Atomic gate request writes -- request file creation should be atomic (temp+rename) so the dashboard never reads partial JSON; validate/ignore malformed gate files.
- P2: Gate file lifecycle -- clarify whether request/resolved files are cleaned up or retained; if retained, add a simple pruning rule to prevent unbounded .5x/gates/ growth.
