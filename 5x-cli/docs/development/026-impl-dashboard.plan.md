# Dashboard Command Center

**Version:** 1.0
**Created:** March 22, 2026
**Status:** Draft

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-22 | Initial draft. Supersedes `006-impl-dashboard.md` (written against v0 schema). Rewritten for v1 architecture: unified `steps` table, no orchestrator loops, stateless CLI toolbelt model. |
| 1.1 | 2026-03-23 | Revision per review feedback: added HTTP endpoints for run detail/log inventory (P0.1), replaced `.5x/` with resolved `stateDir` (P1.1), clarified no-project bootstrap behavior (P1.2), added WS Origin validation (P1.3), added `runs.status` polling (P2), added `protocolVersion` to snapshot contract (P2). |

## Overview

Current behavior: `5x-cli` has no dashboard command and no web transport. Observability is terminal-only — `5x run state`, `5x run watch`, direct DB queries, and raw NDJSON log files. Monitoring multiple concurrent runs, reviewing historical patterns, or comparing quality gate outcomes across phases requires ad-hoc CLI invocations.

Desired behavior: `5x dashboard` starts a token-protected Bun HTTP/WebSocket server (default `127.0.0.1:55555`) that renders a dense, real-time mission-control UI backed by the v1 schema (`plans`, `runs`, `steps`) and NDJSON log files in the resolved state directory. It supports multi-plan drill-down, run/step timeline streaming, live log tailing, quality gate result summaries, cost/token analytics, and historical comparison — all without schema changes.

Why this change: The v1 step journal captures rich orchestration state — author/reviewer/quality results, phase completions, session metadata, token counts, costs, and durations — that terminal-only tools cannot surface effectively when supervising multiple runs or reviewing trends. A dedicated dashboard raises operator throughput while preserving the CLI as the sole source of orchestration truth.

### Relationship to 006-impl-dashboard.md

The original plan (`006`) was written against the v0 schema (`run_events`, `agent_results`, `quality_results`, `phase_progress` tables) and the TypeScript orchestrator (`phase-execution-loop.ts`, `plan-review-loop.ts`). The v1 architecture migration (`007-impl-v1-architecture.md`) deleted all of those:

- **4 tables dropped** → replaced by unified `steps` table with `step_name` conventions
- **Orchestrator loops deleted** → replaced by agent skills + CLI primitives
- **`src/gates/human.ts` deleted** → human interaction flows through TUI (opencode)
- **`runs` table simplified** → removed `current_state`, `current_phase`, `review_path`

This plan (`026`) preserves the core design intent from 006 — standalone process, read-only DB, token auth, vanilla SPA, mission-control aesthetic — while completely reworking the data layer, protocol, and integration points for v1.

The 006 gate bridge concept (dashboard resolving human gates for the orchestrator) is deferred. In v1, agents interact with humans through the TUI, not through file-based gate resolution. A future plan may introduce a dashboard→agent signaling mechanism, but it is out of scope here.

## Design Decisions

**Dashboard remains a standalone process, not embedded in run commands.** Decouples monitoring from execution. Allows observation before, during, and after runs. Requires control-plane root resolution to find the correct state directory from any checkout context. Trade-off: extra process management, but avoids coupling the dashboard lifecycle to any single run.

**No DB schema migration.** The v1 `steps` table with autoincrement `id` is a natural polling cursor. `computeRunSummary()` already aggregates the metrics the dashboard needs. All dashboard queries are read-only against existing tables. Trade-off: no server-side push notification (polling only), but avoids schema churn and keeps the dashboard purely additive.

**`steps.id` cursor for incremental polling.** Since `steps.id` is autoincrement and inserts are append-only (INSERT OR IGNORE, first-write-wins), a simple `WHERE id > ?` high-water mark catches all new steps without the `(created_at, id)` tie-break complexity the old plan needed for upserted tables. Poll interval: 2s. Trade-off: 2s latency floor, but deterministic and zero contention with writers.

**Dashboard reads DB via `openDbReadOnly()`.** Already exists in `src/db/connection.ts`. Includes `busy_timeout=5000` and WAL mode from the writer. No lifecycle hooks or signal handler conflicts with the main CLI. Trade-off: separate connection, but clean shutdown semantics and no write-path accidents.

**Control-plane root resolution required.** The dashboard must resolve the canonical state directory via the same `resolveControlPlaneRoot()` path used by other commands (`src/commands/control-plane.ts`), handling managed/isolated/none modes and linked worktrees. The resolved `stateDir` (from config, defaulting to `.5x`) anchors all state artifacts. Trade-off: imports control-plane resolution logic, but ensures correct DB discovery from any checkout directory.

**CLI flags own dashboard runtime config.** `--host`, `--port`, `--dev` (hidden). No `5x.config.js` schema changes. Trade-off: no project-persisted dashboard settings, but avoids machine-specific config drift.

**Frontend is vanilla static assets embedded in the binary.** No bundler, no npm runtime dependencies. HTML/CSS/JS served directly. Dev mode falls back to filesystem reads for live editing. Trade-off: no framework ergonomics, but fast startup, small artifact, predictable behavior.

**Read-only dashboard with no write paths.** Dashboard never mutates the DB or writes to the state directory (except its own token file). All state changes flow through CLI commands invoked by agents or operators. Trade-off: no interactive gate responses from the browser (deferred to future work), but eliminates an entire class of race conditions and keeps the CLI as single source of truth.

**Multi-tab: no coordination.** Each browser tab gets its own WebSocket connection and independent snapshot. No tab-to-tab synchronization. Server broadcasts identically to all authenticated connections. Trade-off: duplicate bandwidth per tab, but simple and correct.

**WebSocket Origin validation for localhost binds.** When binding to localhost/127.0.0.1, the server validates the `Origin` header on WS upgrade requests to prevent cross-site WebSocket hijacking via cookie-backed authentication. Non-localhost binds use relaxed validation (accept any origin) since the operator explicitly chose network exposure. This matches the security model in `docs/10-dashboard.md`.

### Design Specification

The visual design, page wireframes, color system, typography, animation language, and detailed UX are specified in `docs/10-dashboard.md`. This implementation plan references that document for frontend specifics rather than duplicating them. The Phase 4 frontend tasks implement the design spec.

### Performance Budget

| Metric | Target |
|--------|--------|
| Initial page load (HTML + CSS + JS) | < 200KB total |
| Time to first paint | < 500ms |
| WebSocket message processing | < 5ms per message |
| Database poll query time | < 10ms |
| Log line render (batch of 100) | < 50ms |
| Memory (1000 log lines cached) | < 10MB |

### Browser Support

Modern evergreen browsers only (Chrome, Firefox, Safari, Edge). ES2022+ features. No transpilation or polyfills.

## Phase 1: Command + Server Foundation

**Completion gate:** `5x dashboard` serves HTML/CSS/JS over HTTP, enforces token auth on HTTP+WS handshake, resolves control-plane root, handles both DB-present and no-project bootstrap modes, and exits deterministically on SIGINT/SIGTERM.

- [ ] Register `dashboard` subcommand in `src/bin.ts` and implement CLI adapter in new `src/commands/dashboard.ts` (`--port`, `--host`, hidden `--dev`).
- [ ] Implement `src/commands/dashboard.handler.ts` with control-plane root resolution via `resolveControlPlaneRoot()`, state directory discovery (resolved `stateDir` from config, default `.5x`), and delegation to `startDashboardServer()`.
- [ ] Implement dashboard server lifecycle in new `src/dashboard/server.ts` with `startDashboardServer(opts)` — Bun HTTP/WS server, command-owned SIGINT/SIGTERM handling (stop accepting connections, close watchers, then `process.exit`).
- [ ] Handle fresh-project bootstrap: server startup always resolves control-plane root and state directory. If DB file exists at `<stateDir>/5x.db`, open via `openDbReadOnly()` and probe with health query. If DB is absent, operate in "no-project" mode: skip DB open/probe, serve `status: "no_project"` in snapshots, continue monitoring for DB appearance (subsequent polls check for DB file). Token file is always written to `<stateDir>/` (creating the directory if necessary).
- [ ] Generate per-session token (`crypto.randomBytes(32).toString("hex")`), persist to `<stateDir>/dashboard-token.<port>.json` (mode `0600`) with `{ pid, port, token, startedAt }`. Create parent state directory if missing. Clean up token file on shutdown.
- [ ] Implement auth flow: bootstrap HTML via `/?token=...`, server validates and sets `Set-Cookie: dashboard_token=<token>; HttpOnly; SameSite=Strict; Path=/`. Subsequent requests (static assets, WS upgrade) accept cookie or query token. Reject unauthorized requests with 401.
- [ ] Implement WS Origin validation: when host is localhost/127.0.0.1, validate `Origin` header on WS upgrade matches `http://localhost:<port>` or `http://127.0.0.1:<port>`; reject with 403 if mismatched. Non-localhost binds skip origin validation.
- [ ] Add host-binding warning to stderr when `--host 0.0.0.0` is used.
- [ ] Implement static asset serving in new `src/dashboard/routes.ts` — prod: embedded imports; dev: filesystem reads from `src/dashboard/static/`.

```ts
// src/commands/dashboard.handler.ts
export interface DashboardHandlerArgs {
  port: number;
  host: string;
  dev: boolean;
}

// src/dashboard/server.ts
export interface DashboardServerOptions {
  controlPlaneRoot: string;
  stateDir: string;
  dbPath: string | null; // null in no-project mode
  host: string;
  port: number;
  token: string;
  devStatic: boolean;
}

export async function startDashboardServer(
  opts: DashboardServerOptions,
): Promise<{ stop: () => Promise<void> }>;
```

## Phase 2: Data Snapshot + WS Protocol + HTTP API

**Completion gate:** initial `snapshot` payload renders complete plan/run/step state; incremental polling emits scoped WS updates every 2s; protocol is versioned and typed; HTTP endpoints serve full run detail and historical log inventory on demand.

- [ ] Implement dashboard data module in new `src/dashboard/data.ts` with queries against the v1 schema (`plans`, `runs`, `steps` tables).
- [ ] Implement `buildSnapshot()`: list all plans, list runs per plan (with computed summaries via `computeRunSummary()`), fetch recent steps for active runs. Return typed `DashboardSnapshot` with `protocolVersion: 1`.
- [ ] Implement `pollSteps(sinceId)`: `SELECT * FROM steps WHERE id > ? ORDER BY id LIMIT 200`. Group new steps by `run_id`, compute incremental updates (new steps, status changes inferred from terminal step names like `run:complete`/`run:abort`).
- [ ] Implement `pollRunStatus(activeRunIds)`: re-query `runs.status` for active run IDs each polling cycle to catch status changes recorded outside the terminal-step path. Emit `run.update` if status differs from inferred state.
- [ ] Implement `getRunDetail(runId)`: full step history with phase grouping derived from `step_name`/`phase` columns, quality gate results (`step_name = 'quality:check'`), cost/token aggregates, and run-level metadata.
- [ ] Implement `getRunLogsInventory(runId)`: return array of log files for the run with labels (e.g., `[{file: "agent-001.ndjson", label: "author:phase-1", size: 12345, mtime: "..."}]`) by scanning `<stateDir>/logs/<runId>/`.
- [ ] Define WS protocol envelope (`v: 1`) and typed message unions in new `src/dashboard/ws-protocol.ts`.
- [ ] Implement polling loop (2s interval) in `src/dashboard/poller.ts` — polls `steps`, polls `runs.status` for active runs, diff against last snapshot, emit scoped WS messages to connected clients.
- [ ] Wire WS connection lifecycle: `request.snapshot` handler sends full snapshot on connect; incremental updates stream automatically.
- [ ] Add HTTP API routes in `src/dashboard/routes.ts`:
  - `GET /api/runs/:id` — full run detail (steps, aggregates, metadata). Returns 404 if run not found.
  - `GET /api/runs/:id/logs` — log file inventory for the run. Returns 404 if run not found, empty array if no logs directory.
  - `GET /api/runs/:id/logs/:filename?offset=0&limit=500` — paginated log lines from specific file. Enforce max 10,000 lines per response.

```ts
// src/dashboard/ws-protocol.ts
export type ServerMessage =
  | { v: 1; type: "snapshot"; data: DashboardSnapshot }
  | { v: 1; type: "steps.new"; data: { runId: string; steps: StepPayload[] } }
  | { v: 1; type: "run.update"; data: RunUpdatePayload }
  | { v: 1; type: "log.lines"; data: { runId: string; file: string; lines: LogLine[] } }
  | { v: 1; type: "error"; data: { code: string; message: string } };

export type ClientMessage =
  | { v: 1; type: "request.snapshot" }
  | { v: 1; type: "subscribe.logs"; data: { runId: string } }
  | { v: 1; type: "unsubscribe.logs"; data: { runId: string } };

// src/dashboard/data.ts
export interface DashboardSnapshot {
  protocolVersion: number; // 1
  status: "ready" | "no_project";
  plans: PlanSummary[];
  runs: RunSummaryWithSteps[];
  activeRunIds: string[];
}

export interface StepPayload {
  id: number;
  runId: string;
  stepName: string;
  phase: string | null;
  iteration: number;
  resultJson: unknown;
  sessionId: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  durationMs: number | null;
  logPath: string | null;
  createdAt: string;
}

// src/dashboard/routes.ts
export interface RunDetailResponse {
  run: RunSummary;
  steps: StepPayload[];
  phases: PhaseGroup[];
  aggregates: CostAggregates;
}

export interface LogInventoryResponse {
  runId: string;
  files: LogFileInfo[];
}

export interface LogFileInfo {
  file: string;
  label: string;
  size: number;
  mtime: string;
}
```

## Phase 3: Log Streaming

**Completion gate:** active log files stream to subscribed WS clients in near-real-time; missed `fs.watch` events recovered by periodic rescan; backfill endpoint serves historical lines; log file inventory available via HTTP API.

- [ ] Implement log watcher in new `src/dashboard/log-watcher.ts` using the same watch+poll pattern as `src/utils/ndjson-tailer.ts` (fs.watch + interval rescan at 5s, 64KB read chunks, 1MB partial-line buffer cap). Track per-file byte offsets.
- [ ] Watch `<stateDir>/logs/<run-id>/` directories for `agent-*.ndjson` files. Discover new run log dirs from `steps` rows with non-null `log_path`.
- [ ] Route parsed NDJSON lines through the poller to connected WS clients subscribed to that `runId`.
- [ ] Handle log subscription lifecycle: `subscribe.logs` starts watching (or attaches to existing watcher), `unsubscribe.logs` detaches. Clean up watchers when all subscribers disconnect.
- [ ] Add HTTP endpoint `GET /api/runs/:runId/logs/:filename?offset=0&limit=500` for backfill/history, supporting pagination via byte offset. Enforce max 10,000 lines per response. Log inventory available via `GET /api/runs/:runId/logs` (Phase 2).

```ts
// src/dashboard/log-watcher.ts
export interface LogWatcher {
  start(): void;
  stop(): void;
  subscribe(runId: string, cb: (lines: LogLine[]) => void): () => void;
}

export interface LogLine {
  file: string;
  offset: number;
  entry: Record<string, unknown>;
}

export function createLogWatcher(opts: {
  logsRoot: string;
  rescanIntervalMs: number; // 5000
  readChunkBytes: number; // 65536
}): LogWatcher;
```

## Phase 4: Frontend SPA

**Completion gate:** browser renders all required views with live updates, dense mission-control styling, and localStorage UI preferences.

- [ ] Add static entry files: `src/dashboard/static/index.html` (app shell, `<noscript>` fallback), `src/dashboard/static/style.css` (mission-control design tokens), `src/dashboard/static/app.js` (hash-router bootstrap, WS connection, store wiring).
- [ ] Implement client-side store in `src/dashboard/static/lib/store.js` — path-scoped subscriptions, immutable updates, targeted re-render notification.
- [ ] Implement WS client in `src/dashboard/static/lib/ws-client.js` — auto-reconnect with exponential backoff (1s → 2s → 4s → 8s → 16s max), request snapshot on reconnect to resync state, message dispatch to store, connection state reflected in top bar.
- [ ] Implement hash router in `src/dashboard/static/lib/router.js` — routes: `#/` (overview), `#/plan/:planPath` (plan detail), `#/run/:runId` (run detail + step timeline), `#/run/:runId/logs` (log viewer), `#/analytics` (cross-run metrics).

**Views:**

- [ ] **Overview** (`src/dashboard/static/components/overview.js`): plan list with active run counts, global status indicators, recent activity feed from latest steps across all runs.
- [ ] **Plan detail** (`src/dashboard/static/components/plan-detail.js`): run history for a plan, status breakdown, aggregate metrics (total cost, tokens, duration).
- [ ] **Run detail** (`src/dashboard/static/components/run-detail.js`): step timeline grouped by phase, expandable step results (author status, reviewer verdict, quality gate output), live step arrivals via `steps.new` messages. Phase progress bar derived from `phase:complete` steps.
- [ ] **Log viewer** (`src/dashboard/static/components/log-viewer.js`): live-tailing NDJSON display with ANSI color rendering, file selector for multi-agent logs (labeled by phase + role for readability, populated via `GET /api/runs/:runId/logs`), scroll-lock toggle (auto-scroll when at bottom, pause on scroll-up, "Jump to bottom" button), backfill via HTTP endpoint. Virtualized list capped at 10,000 lines per file in memory; older lines discarded from front.
- [ ] **Analytics** (`src/dashboard/static/components/analytics.js`): cost-per-run trends, token usage breakdown (in/out by role), quality gate pass/fail rates, average phase durations, review iteration counts.
- [ ] **Top bar** (`src/dashboard/static/components/top-bar.js`): connection status indicator, active run count, nav links.

**Styling** (per design spec in `docs/10-dashboard.md`):

- [ ] Implement mission-control color system, typography (JetBrains Mono), and animation language from design spec. Scanline/noise texture toggleable via localStorage.
- [ ] Implement ANSI-to-HTML renderer in `src/dashboard/static/lib/ansi.js` for quality gate output and log lines.
- [ ] Implement number/date/duration formatters in `src/dashboard/static/lib/format.js` with tabular-nums for metric alignment.

```js
// src/dashboard/static/lib/store.js
export function createStore(initialState) {
  const subscribers = new Map();
  let state = initialState;
  return {
    getState: () => state,
    subscribe(path, cb) { /* path-scoped subscriptions */ },
    update(path, value) { /* immutable path update + targeted notify */ },
  };
}
```

## Phase 5: Hardening, Tests, and Rollout

**Completion gate:** test suite covers unit/integration/edge paths per `AGENTS.md` tiers, security checks pass, docs include operator workflow.

**Unit tests** (`test/unit/dashboard/`):

- [ ] `data.test.ts` — snapshot composition from seeded DB, `pollSteps` cursor correctness, `pollRunStatus` status re-query, `getRunDetail` phase grouping, `getRunLogsInventory` file scanning, empty-DB/no-project handling.
- [ ] `ws-protocol.test.ts` — message serialization/deserialization, unknown message type handling, version mismatch rejection, protocolVersion field presence.
- [ ] `log-watcher.test.ts` — offset tracking, new file discovery, rescan recovery after missed fs.watch events, partial-line buffering, subscriber lifecycle.
- [ ] `poller.test.ts` — step diff computation, run status inference from terminal steps + runs.status polling, incremental update message construction.
- [ ] `routes.test.ts` — HTTP API endpoints: run detail 200/404, log inventory 200/404, log backfill pagination, max limit enforcement.

**Integration tests** (`test/integration/commands/`):

- [ ] `dashboard.test.ts` — CLI startup/shutdown via `Bun.spawn` (with `cleanGitEnv()`, `stdin: "ignore"`, per-test `timeout`), token file creation/cleanup, auth rejection (401 without token), host/port flags, graceful shutdown on SIGTERM.
- [ ] `dashboard.test.ts` — token bootstrap: `/?token=...` sets cookie, subsequent `/style.css` and `/app.js` requests succeed without query token.
- [ ] `dashboard.test.ts` — fresh project: missing state directory returns app shell with `no_project` snapshot; server creates state directory for token file.
- [ ] `dashboard.test.ts` — WS origin validation: localhost binds reject mismatched Origin header with 403; non-localhost binds accept any origin.
- [ ] `dashboard.test.ts` — HTTP API: `GET /api/runs/:id` returns run detail, `GET /api/runs/:id/logs` returns inventory, pagination via offset/limit works, 404 for missing runs.

**Security hardening:**

- [ ] WS input validation: schema check inbound messages, reject unknown types, enforce max message size (64KB).
- [ ] Log backfill resource bounds: max 10,000 lines per response, 5MB response cap.
- [ ] Per-connection memory bound: cap buffered outbound WS messages (1MB), drop connection on overflow.
- [ ] Document token transport caveat (token-in-URL visible in browser history/referer) and local-tool risk acceptance.

**Documentation:**

- [ ] Update `docs/10-dashboard.md` to reflect implemented behavior (verify design spec matches implementation).
- [ ] Add usage examples to `--help` output.

**Verification:**

- [ ] `bun test --concurrent --dots`
- [ ] `bun run lint`
- [ ] `bun run typecheck`

## Files Touched

| File | Change |
|------|--------|
| `src/bin.ts` | Register `dashboard` subcommand. |
| `src/commands/dashboard.ts` | New Commander adapter, CLI flags. |
| `src/commands/dashboard.handler.ts` | New handler: control-plane resolution, stateDir discovery, server startup, signal-owned shutdown. |
| `src/dashboard/server.ts` | New Bun HTTP/WS server lifecycle, auth enforcement, origin validation, token file management. |
| `src/dashboard/routes.ts` | New static asset serving (embedded + dev filesystem fallback), HTTP API routes (`/api/runs/:id`, `/api/runs/:id/logs`). |
| `src/dashboard/data.ts` | New read-only queries against `plans`/`runs`/`steps`, snapshot builder (with `protocolVersion`), step poller, run status poller, log inventory scanner. |
| `src/dashboard/ws-protocol.ts` | New protocol message types and validation. |
| `src/dashboard/poller.ts` | New polling loop: step cursor, run status re-query, diff, WS broadcast. |
| `src/dashboard/log-watcher.ts` | New NDJSON watcher with offset tracking, rescan fallback, subscriber management. |
| `src/dashboard/static/index.html` | New SPA shell. |
| `src/dashboard/static/style.css` | New mission-control visual system. |
| `src/dashboard/static/app.js` | New SPA bootstrap, router/store/WS wiring. |
| `src/dashboard/static/components/*.js` | New view components (overview, plan-detail, run-detail, log-viewer, analytics, top-bar). |
| `src/dashboard/static/lib/*.js` | New client libraries (ws-client, store, router, ansi, format). |
| `src/templates/text-imports.d.ts` | Extend text module declarations for `.html`/`.css`/`.js` embedded imports. |
| `test/unit/dashboard/*.test.ts` | New unit tests for data, ws-protocol, log-watcher, poller, routes. |
| `test/integration/commands/dashboard.test.ts` | New integration tests for CLI startup, auth, origin validation, shutdown, HTTP API, fresh-project bootstrap.

## Tests

| Type | Location | Validates |
|------|----------|-----------|
| Unit | `test/unit/dashboard/data.test.ts` | Snapshot composition, cursor polling, run status re-query, phase grouping, log inventory scanning, empty/no-project DB. |
| Unit | `test/unit/dashboard/ws-protocol.test.ts` | Message schema, protocolVersion field, version handling, unknown type rejection. |
| Unit | `test/unit/dashboard/log-watcher.test.ts` | Offset reads, rescan recovery, partial-line buffering, subscriber cleanup. |
| Unit | `test/unit/dashboard/poller.test.ts` | Step diffing, run status inference + polling, incremental message construction. |
| Unit | `test/unit/dashboard/routes.test.ts` | HTTP API endpoints, pagination, 404 handling. |
| Integration | `test/integration/commands/dashboard.test.ts` | CLI startup/shutdown, auth enforcement, origin validation, token file lifecycle, HTTP API, fresh-project bootstrap. |
| Edge | `test/unit/dashboard/ws-protocol.test.ts` | Oversized message rejection, malformed JSON handling, connection memory caps.

## Estimated Timeline

| Phase | Estimate |
|-------|----------|
| Phase 1: Command + Server Foundation | 2 days |
| Phase 2: Data Snapshot + WS Protocol | 2 days |
| Phase 3: Log Streaming | 1.5 days |
| Phase 4: Frontend SPA | 3 days |
| Phase 5: Hardening, Tests, Rollout | 2 days |
| **Total** | **10.5 days** |

## Not In Scope

- **Interactive gate bridge.** In v1, agents interact with humans through the TUI (opencode), not file-based gate resolution. A dashboard→agent signaling mechanism may be added in a future plan.
- **Multi-user authorization/RBAC.** Token is single-session, operator-local.
- **Multi-repo aggregation.** One dashboard process monitors one project's state directory.
- **Mobile-first/responsive design.** Desktop-only density.
- **Audio/push notifications.** Visual-only alerting.
- **Persistent daemon mode.** Dashboard lifecycle is tied to the `5x dashboard` process.
- **DB writes from dashboard.** All mutations flow through CLI commands. Dashboard is strictly read-only.
