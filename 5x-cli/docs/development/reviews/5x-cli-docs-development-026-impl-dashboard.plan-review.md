# Review: Dashboard Command Center

**Review type:** docs/development/026-impl-dashboard.plan.md
**Scope:** Staff review of the dashboard implementation plan, related design doc, and referenced runtime architecture (`docs/10-dashboard.md`, `docs/development/006-impl-dashboard.md`, `src/commands/control-plane.ts`, `src/db/connection.ts`, `src/db/operations-v1.ts`, `src/utils/ndjson-tailer.ts`)
**Reviewer:** Staff engineer
**Local verification:** `5x plan phases docs/development/026-impl-dashboard.plan.md` ✅; document/code review only

## Summary

Strong direction overall: the plan is aligned with the v1 `steps` model, keeps the dashboard additive/read-only, and phases most of the work sensibly. The main gap is that the data contract is incomplete for deep-link run detail/log views: the plan defines `getRunDetail()` and a rich log viewer, but the transport only ships snapshots plus incremental updates, so an implementation team still has to invent how completed-run history and file inventories are fetched.

**Readiness:** Not ready — one architecture-level data contract decision is still missing, and a few important compatibility/security details need to be folded into the plan before implementation starts.

## Strengths

- Rewrites the old dashboard concept cleanly for the v1 schema instead of dragging forward v0 abstractions.
- Correctly chooses additive, read-only integration points (`steps.id` polling, `openDbReadOnly()`, standalone process) rather than schema churn.
- Test tiering mostly matches the repo's current `AGENTS.md` guidance.
- Fresh-project bootstrap and bounded log-tail design are both good operator-focused choices.

## Production Readiness Blockers

### P0.1 — Missing transport contract for full run detail and historical log inventory

**Action:** `human_required`

**Risk:** Phase 4 depends on data that Phase 2/3 never make available. `buildSnapshot()` only promises recent steps for active runs, while the WS protocol only defines `request.snapshot`, `subscribe.logs`, and `unsubscribe.logs`. That leaves no specified way to load full step history for a deep-linked/completed run or to populate the log file selector for historical runs before live subscription starts.

**Requirement:** Choose and document one explicit read path for on-demand detail data — e.g. HTTP endpoints (`/api/runs/:id`, `/api/runs/:id/logs`) or new WS request/response messages — and thread that contract through Phases 2–4 plus tests. The plan should state which payload owns: full step history, per-run log file inventory/labels, and pagination/backfill behavior.

## High Priority (P1)

### P1.1 — Plan hardcodes `.5x/` instead of the resolved `stateDir`

**Action:** `auto_fix`

The existing architecture explicitly supports custom state directories via `resolveControlPlaneRoot()` and `stateDir`, and current log/worktree/template code is already anchored to `<controlPlaneRoot>/<stateDir>`. This plan repeatedly hardcodes `.5x/` for token files, logs, and bootstrap paths, which would break repos using `db.path` overrides. Replace literal `.5x/...` references with control-plane-root + `stateDir` language everywhere the dashboard reads or writes state artifacts.

### P1.2 — Fresh-project bootstrap conflicts with unconditional read-only DB open/probe

**Action:** `auto_fix`

Phase 1 says the server always opens the DB with `openDbReadOnly()` and probes it on startup, but also says startup must succeed when the DB is absent. `openDbReadOnly()` on a missing file will fail, so the bootstrap path needs to be called out explicitly: no-DB mode must skip the DB open/probe and serve `status: "no_project"` until a DB appears, while token-file persistence must also define whether the state dir is created just for the token file.

### P1.3 — Security requirements dropped origin validation from the executable plan

**Action:** `auto_fix`

`docs/10-dashboard.md` requires stricter WS Origin validation for localhost binds and relaxed behavior only for explicit non-localhost binds. The implementation plan keeps token auth and host warnings, but it no longer carries origin validation into a phase task or test case. Add it back so the plan matches the design doc and avoids a cookie-backed cross-site WS gap on localhost.

## Medium Priority (P2)

- Add an explicit poll requirement to re-read `runs.status` for active runs each cycle (as the design doc says), instead of relying only on terminal-step inference. That keeps `run.update` correct if status changes are recorded outside the narrow `run:complete` / `run:abort` path. **Action:** `auto_fix`
- Add `protocolVersion` to the Phase 2 `DashboardSnapshot` contract if the client is expected to enforce version skew, since the design doc already relies on it. **Action:** `auto_fix`

## Readiness Checklist

**P0 blockers**
- [ ] Specify the on-demand transport/API for full run detail and historical log file inventory.

**P1 recommended**
- [ ] Replace literal `.5x` paths with resolved `stateDir`-anchored paths.
- [ ] Split startup into DB-present vs no-project bootstrap behavior.
- [ ] Restore localhost origin-validation requirements and tests.
- [ ] Re-query active run status during polling.
- [ ] Include protocol versioning in the concrete snapshot contract if the client depends on it.

## Addendum (2026-03-23) — Revision 1.1 re-review

### What's Addressed

- Added explicit HTTP APIs for full run detail, log inventory, and log backfill; the earlier deep-link transport gap is closed.
- Re-anchored plan language to resolved `stateDir` instead of hardcoded `.5x` paths.
- Clarified no-project bootstrap: DB-absent startup now skips `openDbReadOnly()` probing and serves `status: "no_project"`.
- Restored localhost-only WS Origin validation requirements and test coverage.
- Added `runs.status` polling and `protocolVersion` to the concrete snapshot contract.

### Remaining Concerns

- **P1 — Validate `:filename` on the log backfill route.** The plan now exposes `GET /api/runs/:id/logs/:filename`, but it does not explicitly require constraining `:filename` to discovered inventory entries or the `agent-*.ndjson` pattern. Without that requirement, a naive `join()` implementation could become a path-traversal bug inside the state directory. **Action:** `auto_fix`

### Updated Readiness

**Readiness:** Ready with corrections — prior blockers are resolved; one mechanical hardening requirement remains for the log-file route.

## Addendum (2026-03-23) — Revision 1.2 re-review

### What's Addressed

- Added explicit filename validation requirements for the log backfill route: pattern check, inventory membership check, and path-separator rejection.
- Added matching unit-test coverage for filename validation and path traversal rejection.
- Added a dedicated security-hardening checklist item for log backfill filename validation.

### Remaining Concerns

- None. The previously raised plan gaps are now addressed in an implementable, testable way.

### Updated Readiness

**Readiness:** Ready — the plan is now implementation-ready as written.
