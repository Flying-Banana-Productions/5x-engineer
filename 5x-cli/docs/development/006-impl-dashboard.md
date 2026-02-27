# Dashboard Command Center

**Version:** 1.1
**Created:** February 26, 2026
**Status:** Draft

## Overview

Current behavior: `5x-cli` has no dashboard command, no web transport, and no cross-process gate bridge. Observability exists in terminal output, SQLite (`.5x/5x.db`), and NDJSON logs, but humans cannot monitor multiple plans/runs in one place or respond to gates from the browser.

Desired behavior: `5x dashboard` starts a token-protected Bun HTTP/WebSocket server (default `127.0.0.1:55555`) that renders a dense, real-time mission-control UI backed by `.5x` DB/log/gate artifacts. It supports multi-plan drill-down, run/event/log streaming, gate modal interactions (when TUI is not active), and historical analytics without schema changes.

Why this change: the workflow now has enough orchestration state (`runs`, `run_events`, `agent_results`, `quality_results`, `phase_progress`) that terminal-only visibility slows diagnosis and supervision. A dedicated dashboard raises operator throughput while preserving the existing CLI as source of orchestration truth.

## Design Decisions

**Dashboard remains a standalone process with file/DB coordination, not embedded in `5x run`.** This keeps orchestration loops decoupled and allows monitoring before/during/after runs. Trade-off: cross-process coordination complexity, addressed by a file-based gate bridge and polling cursors.

**No DB migration for dashboard launch.** Use `run_events.id` high-water polling and targeted table re-queries (plus `(created_at, id)` tie-break polling where needed) instead of triggers/`updated_at`. Trade-off: slight poll overhead every 2s, but avoids schema churn and preserves backward compatibility.

**Gate bridge is the only write path for browser control.** Dashboard never mutates orchestration tables directly. Gate intent flows through `.5x/gates/<gate-id>.json` + `.resolved.json` files and audited gate events. Resolution uses exclusive-create (`wx`) for first-writer-wins semantics. Trade-off: extra file lifecycle management, but deterministic and auditable responder races.

**Dashboard reads DB via dedicated read-only handle.** Use `openDbReadOnly()` plus `busy_timeout`/bounded retry for read paths, instead of `getDb()` lifecycle hooks, so command-level signal handling controls deterministic shutdown. Trade-off: slightly more connection plumbing, but avoids async cleanup promises after forced exits.

**CLI flags own dashboard runtime config (`--host`, `--port`, `--no-gate-bridge`, hidden `--dev`).** No `5x.config.js` schema changes. Trade-off: no project-persisted dashboard settings, but avoids machine-specific config drift and unknown-key warnings.

**Frontend is vanilla static assets embedded in the binary.** No bundler/npm runtime deps. Trade-off: less framework ergonomics, but fast startup, small artifact, and predictable deploy/runtime behavior.

## Phase 1: Command + Server Foundation

**Completion gate:** `5x dashboard` serves HTML/CSS/JS over HTTP, enforces token auth on HTTP+WS handshake, and exits deterministically on SIGINT/SIGTERM (stop accepting new connections, close server/watchers, then process exit).

- [ ] Add `dashboard` subcommand registration in `src/bin.ts:11-19` and implement CLI args in new `src/commands/dashboard.ts` (`--port`, `--host`, `--no-gate-bridge`, hidden `--dev`).
- [ ] Implement dashboard bootstrap in new `src/dashboard/server.ts` with `startDashboardServer(opts)` and command-owned SIGINT/SIGTERM handling (do not rely on async shutdown after `process.exit()`).
- [ ] Open dashboard DB access via `openDbReadOnly()` and set read reliability knobs (`PRAGMA busy_timeout` + bounded retry/backoff for transient `database is locked`).
- [ ] Generate per-process session token (`crypto.randomBytes(32).toString("hex")`), persist `.5x/dashboard-token.<port>.json` mode `0600` with `{ pid, port, token, startedAt }`, and enforce request auth for static routes and WS upgrade.
- [ ] Add host-binding warning path for `0.0.0.0` and origin validation policy (strict localhost, relaxed non-localhost with token).
- [ ] Introduce static asset embedding strategy (prod embedded imports + dev filesystem fallback) in new `src/dashboard/routes.ts`.

```ts
// src/commands/dashboard.ts
export interface DashboardCommandArgs {
  port?: number;
  host?: string;
  "no-gate-bridge"?: boolean;
  dev?: boolean; // hidden
}

// src/dashboard/server.ts
export interface DashboardServerOptions {
  projectRoot: string;
  dbPath: string;
  host: string;
  port: number;
  token: string;
  gateBridgeEnabled: boolean;
  devStatic: boolean;
}

export async function startDashboardServer(
  opts: DashboardServerOptions,
): Promise<{ stop: () => Promise<void> }>;
```

## Phase 2: Data Snapshot + Incremental Polling

**Completion gate:** initial `snapshot` payload renders complete plan/run state; incremental DB polling emits scoped WS updates with stable protocol versioning.

- [ ] Implement dashboard data access module in new `src/dashboard/data.ts` using existing tables in `src/db/schema.ts:144-217` and row contracts in `src/db/operations.ts:7-121`.
- [ ] Add dashboard-focused read queries/helpers in `src/db/operations.ts` near reporting helpers (`src/db/operations.ts:624-695`) for: list plans, active runs, latest events, phase progress, run/plan aggregates.
- [ ] Add polling loop (2s) with event-driven cursors: `run_events.id > lastSeen` as source-of-change, then targeted re-query by affected run/phase keys; where direct table polling is required, use `(created_at, id)` high-water (no `rowid` cursor on upserted tables).
- [ ] Define WS protocol envelope (`v: 1`) and typed message unions in new `src/dashboard/ws-protocol.ts`, including `snapshot`, `run.update`, `event`, `agent.result`, `quality.result`, `phase.progress`, `gate.request`, `gate.resolved`, `log.line`, and backward-compatible handling for existing `human_decision` payload variants.
- [ ] Wire client subscription lifecycle and `request.snapshot` handler in WS server path.

```ts
// src/dashboard/ws-protocol.ts
export type ServerMessage =
  | { v: 1; type: "snapshot"; data: DashboardSnapshot }
  | { v: 1; type: "run.update"; data: RunUpdate }
  | { v: 1; type: "event"; data: RunEventPayload }
  | { v: 1; type: "agent.result"; data: AgentResultPayload }
  | { v: 1; type: "quality.result"; data: QualityResultPayload }
  | { v: 1; type: "phase.progress"; data: PhaseProgressPayload }
  | { v: 1; type: "gate.request"; data: GateRequestPayload }
  | { v: 1; type: "gate.resolved"; data: GateResolvedPayload }
  | { v: 1; type: "log.line"; data: LogLinePayload };

export type ClientMessage =
  | { v: 1; type: "request.snapshot" }
  | { v: 1; type: "subscribe.logs"; data: { runId: string; logFile?: string } }
  | { v: 1; type: "unsubscribe.logs"; data: { runId: string } }
  | { v: 1; type: "gate.respond"; data: { gateId: string; response: unknown } };
```

## Phase 3: Log + Gate Filesystem Watchers

**Completion gate:** active log files stream in near-real-time; missed `fs.watch()` events are recovered by periodic rescan; gate file lifecycle watcher behavior is validated with fixtures (independent of orchestrator integration timing).

- [ ] Implement resilient log watcher in new `src/dashboard/log-watcher.ts` using watch+rescan and per-file offsets for `.5x/logs/<run-id>/agent-*.ndjson`.
- [ ] Implement gate directory scanner/watcher in new `src/dashboard/gate-responder.ts` for `.5x/gates/*.json` and `.resolved.json`, using fixture-backed tests in this phase before orchestrator bridge rollout.
- [ ] Validate first-writer-wins behavior for `gate.respond` using exclusive create (`open/writeFile` with `wx`) and ignore stale/duplicate responses with auditable no-op signaling.
- [ ] Add on-connect snapshot enrichment with pending gates and active log metadata.
- [ ] Add HTTP endpoint for backfill ranges (`Load earlier`) to support log virtualization in UI.

```ts
// src/dashboard/log-watcher.ts
export interface LogWatcher {
  start(): void;
  stop(): void;
  subscribe(runId: string, cb: (line: LogLinePayload) => void): () => void;
}

export function createLogWatcher(opts: {
  logsRoot: string;
  rescanMs: number; // 5000
}): LogWatcher;
```

## Phase 4: Unified Gate Bridge in Orchestrators

**Completion gate:** `phaseGate`, `escalationGate`, and `resumeGate` resolve via shared bridge; terminal and dashboard race correctly; TUI-active runs force dashboard observe-only gate behavior.

- [ ] Add new bridge module `src/gates/bridge.ts` implementing request/resolve protocol (`.5x/gates/<gate-id>.json` + `.resolved.json`), exclusive-create resolution (`wx`) for first writer, and audit event writes for stale resolver attempts.
- [ ] Refactor `src/gates/human.ts:88-239` into thin wrappers that delegate to bridge while retaining existing typed interfaces (`PhaseSummary`, `EscalationEvent`, resume tuple).
- [ ] Replace direct prompt defaults in `src/orchestrator/phase-execution-loop.ts:2478-2500` and `src/orchestrator/plan-review-loop.ts:214-277` with bridge-backed gate functions.
- [ ] Keep existing `human_decision` payloads backward-compatible; represent dashboard bridge lifecycle via `gate_request`/`gate_resolved` event types (or explicitly versioned payloads if reused).
- [ ] Add TUI coexistence guard by threading `tui.active` from `src/commands/run.ts:534-541` and `src/commands/plan-review.ts:207-214` into gate options; dashboard responses rejected when TUI mode is active.

```ts
// src/gates/bridge.ts
export type GateType = "phase" | "escalation" | "resume";

export interface RequestGateOptions<TResponse> {
  db: Database;
  projectRoot: string;
  runId: string;
  gateType: GateType;
  context: unknown;
  terminalPrompt?: () => Promise<TResponse>;
  autoResolve?: () => TResponse | null;
  allowDashboardResolution: boolean;
  timeoutMs?: number;
}

export async function requestGate<TResponse>(
  opts: RequestGateOptions<TResponse>,
): Promise<TResponse>;
```

## Phase 5: Frontend SPA (Overview, Plan, Run, Logs, Analytics)

**Completion gate:** browser renders all required routes with live updates, dense mission-control styling, gate modals, and localStorage UI prefs.

- [ ] Add static entry files: `src/dashboard/static/index.html`, `src/dashboard/static/style.css`, `src/dashboard/static/app.js` with hash-router boot.
- [ ] Implement component modules under `src/dashboard/static/components/` (`top-bar.js`, `status-bar.js`, `plan-overview.js`, `plan-detail.js`, `run-detail.js`, `log-viewer.js`, `analytics.js`, `gate-modal.js`, `phase-map.js`, `state-machine.js`).
- [ ] Implement client libs under `src/dashboard/static/lib/` (`ws-client.js`, `router.js`, `store.js`, `render.js`, `format.js`, `ansi.js`) with reconnect/backoff and selective subscriptions.
- [ ] Implement mission-control aesthetic tokens/animations from requirements with scanline/noise toggles persisted in localStorage.
- [ ] Implement gate modal UX (phase/escalation/resume), including observe-only state messaging when gate control disabled.

```js
// src/dashboard/static/lib/store.js
export function createStore(initialState) {
  /** @type {Map<string, Set<(value:any, root:any)=>void>>} */
  const subscribers = new Map();
  let state = initialState;
  return {
    getState: () => state,
    subscribe(path, cb) { /* path-scoped subscriptions */ },
    update(path, value) { /* immutable path update + targeted notify */ },
  };
}
```

## Phase 6: Hardening, Tests, and Rollout

**Completion gate:** test suite covers unit/integration/edge paths, security checks pass, and docs include operator workflow + limitations.

- [ ] Add command tests in new `test/commands/dashboard.test.ts` (startup, auth rejection, host/port flags, graceful shutdown).
- [ ] Add gate bridge tests in new `test/gates/bridge.test.ts` covering first-responder wins, stale gate file handling, TUI observe-only, and auto-mode short-circuit.
- [ ] Extend orchestrator tests (`test/orchestrator/phase-execution-loop.test.ts`, `test/orchestrator/plan-review-loop.test.ts`) to assert bridge-driven `human_decision` event payload shape.
- [ ] Add dashboard data/watcher tests in new `test/dashboard/data.test.ts`, `test/dashboard/log-watcher.test.ts`, `test/dashboard/ws-protocol.test.ts`.
- [ ] Add docs updates in `docs/10-dashboard.md` (status links) and `README.md` usage examples for `5x dashboard` startup and token behavior.
- [ ] Add explicit WS input validation and limits (schema checks, max message size, allowed message types).
- [ ] Add resource bounds for log backfill/streaming (max lines/bytes per request and per-connection memory caps).
- [ ] Document token transport caveat (token-in-URL/local history/referrer exposure) and local-tool risk acceptance.
- [ ] Run verification suite: `bun test --concurrent --dots`, `bun run lint`, `bun run typecheck`.

## Files Touched

| File | Change |
|------|--------|
| `src/bin.ts:11` | Register `dashboard` subcommand loader. |
| `src/commands/dashboard.ts` | New command entrypoint, CLI flags, startup banner, token generation, signal-owned shutdown flow. |
| `src/dashboard/server.ts` | New HTTP/WS server lifecycle and auth enforcement. |
| `src/dashboard/routes.ts` | New static route/auth gate and optional dev-static serving. |
| `src/dashboard/ws-protocol.ts` | New protocol message contracts and dispatcher. |
| `src/dashboard/data.ts` | New DB snapshot/polling/diff aggregation layer with run-events keyed incremental refresh. |
| `src/dashboard/log-watcher.ts` | New NDJSON watcher with offset tracking + rescan fallback. |
| `src/dashboard/gate-responder.ts` | New gate file scanner/responder bridge for dashboard writes with exclusive-create race handling. |
| `src/dashboard/static/index.html` | New SPA shell and route containers. |
| `src/dashboard/static/style.css` | New mission-control visual system, layout, animation tokens. |
| `src/dashboard/static/app.js` | New SPA bootstrap, router/store/websocket wiring. |
| `src/dashboard/static/components/*` | New page components and gate modal/state visualizers. |
| `src/dashboard/static/lib/*` | New WS client, store, router, render, formatter, ANSI parser. |
| `src/gates/bridge.ts` | New unified gate request/resolve mechanism with first-writer-wins semantics. |
| `src/gates/human.ts:88` | Convert direct stdin gates to bridge-backed wrappers. |
| `src/orchestrator/phase-execution-loop.ts:2064` | Route escalation/phase/resume gates via bridge defaults. |
| `src/orchestrator/plan-review-loop.ts:214` | Replace inline human/resume prompt logic with bridge-backed defaults. |
| `src/db/operations.ts:624` | Add dashboard-oriented read helpers/aggregates and incremental fetch APIs. |
| `src/db/connection.ts` | Add read-only reliability knobs (`busy_timeout`/retry policy) used by dashboard data paths. |
| `src/templates/text-imports.d.ts:1` | Extend text module declarations for embedded `.html`, `.css`, `.js` static imports. |
| `test/commands/dashboard.test.ts` | New CLI/integration tests for dashboard command behavior. |
| `test/gates/bridge.test.ts` | New unit/integration tests for gate bridge races and audit events. |
| `test/dashboard/*.test.ts` | New unit tests for data polling, ws protocol, and file watching. |
| `test/orchestrator/phase-execution-loop.test.ts:641` | Update expectations for bridge-backed human decision event shape. |
| `test/orchestrator/plan-review-loop.test.ts:529` | Update auto/escalation assertions for unified gate bridge semantics. |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/gates/bridge.test.ts` | Gate file protocol, exclusive-create first-writer-wins resolve, stale responder no-op auditing, TUI observe-only restrictions. |
| Unit | `test/dashboard/data.test.ts` | Snapshot composition, run-events keyed incremental refresh, and no-staleness behavior for upserted result rows. |
| Unit | `test/dashboard/log-watcher.test.ts` | Offset reads, missed-event recovery via 5s rescan, NDJSON line framing. |
| Unit | `test/dashboard/ws-protocol.test.ts` | Message schema/version handling, subscribe/unsubscribe routing, invalid payload rejection, input size/type limits. |
| Integration | `test/commands/dashboard.test.ts` | CLI startup/shutdown, auth enforcement, host/port behavior, token file creation. |
| Integration | `test/orchestrator/phase-execution-loop.test.ts` | Phase loop gate flow remains correct with bridge-backed defaults. |
| Integration | `test/orchestrator/plan-review-loop.test.ts` | Plan-review escalation and resume flow remains correct with unified bridge. |
| Integration | Browser smoke (`bun run src/bin.ts dashboard --dev`) | End-to-end route rendering, live updates, gate modal interactions, reconnect flow. |
| Edge | `test/dashboard/security.test.ts` | Unauthorized HTTP/WS rejection, localhost origin checks, 0.0.0.0 warning path. |
| Edge | `test/dashboard/log-history.test.ts` | Log virtualization limits (10k lines), backfill endpoint range handling, per-connection memory caps. |

## Estimated Timeline

| Phase | Estimate |
|------|----------|
| Phase 1 | 2 days |
| Phase 2 | 2 days |
| Phase 3 | 2 days |
| Phase 4 | 3 days |
| Phase 5 | 3 days |
| Phase 6 | 2 days |
| **Total** | **14 days** |

## Not In Scope

- Multi-user authorization/RBAC; token is single-session and operator-local.
- Multi-repo aggregation in one dashboard process.
- Mobile-first/responsive redesign beyond desktop usability.
- Audio notifications and non-visual alerting.
- Persistent daemon mode detached from `5x dashboard` process lifecycle.

## Revision History

### v1.1 (2026-02-27) — Review feedback incorporation

- Replaced rowid-based incremental polling with run-events keyed refresh strategy and `(created_at, id)` fallback.
- Specified exclusive-create (`wx`) first-writer-wins gate resolution with stale responder audit no-ops.
- Updated shutdown model to command-owned deterministic signal handling + read-only DB reliability knobs.
- Clarified phase sequencing via fixture-backed gate watcher validation before orchestrator bridge rollout.
- Added multi-instance token file semantics, WS/resource hardening items, and compatibility guidance for `human_decision` payloads.

### v1.0 (2026-02-26) — Initial implementation plan

- Created phased implementation plan for `5x dashboard`, unified gate bridge integration, static SPA delivery, security model, and test strategy.
