# 5x Dashboard — Live Web Command Center

**Navigation**: [docs/development/001-impl-5x-cli.md](development/001-impl-5x-cli.md) > Dashboard

---

## Overview

The 5x Dashboard is a real-time web interface served by `5x dashboard` on port 55555. It synthesizes the `.5x` data directory — SQLite database, NDJSON agent logs, quality gate output, worktree state, and debug traces — into a live command center for monitoring and controlling 5x automation runs.

The dashboard is a standalone command, independent of `5x run` or `5x plan-review`. It reads the same `.5x/5x.db` database and log files, connects to active orchestrator processes via a shared gate bridge, and presents a multi-plan overview with drill-down into individual runs, phases, and agent sessions. It is fully interactive: phase gates, escalation gates, and resume gates can be answered from the browser, competing with the terminal on a first-responder-wins basis.

### Design Goals

| Goal | Description |
|------|-------------|
| **Information density** | Every pixel earns its keep. Dense telemetry grids, multi-panel layouts, no wasted whitespace. |
| **Liveness** | Active processes pulse. Logs stream. State transitions animate. The dashboard feels alive when work is happening and calm when idle. |
| **Zero build step** | Vanilla HTML/CSS/JS served as static files from Bun's HTTP server. No npm dependencies, no bundler, no node_modules. |
| **Interactive control** | Phase gates, escalation gates, and resume prompts appear in the dashboard and can be answered from the browser. |
| **Standalone** | Works before, during, and after runs. Historical data is always browsable. |

### Scope

**In scope:**
- `5x dashboard` CLI command with Bun HTTP server on configurable port (default 55555)
- WebSocket transport for real-time bidirectional communication
- Multi-plan overview with drill-down navigation
- Live process monitoring with state machine visualization
- Streaming log viewer with search, filter, and ANSI color rendering
- Interactive gate responses (phase, escalation, resume)
- Historical run browsing and comparison
- Cost/token analytics (secondary panel)
- Quality gate pass/fail status display
- Browser localStorage for layout preferences
- Configurable network binding (localhost default, `--host` for all interfaces)

**Out of scope:**
- Multi-user authorization (role-based access) — single-token auth is sufficient for a local dev tool
- Multi-repo support — one dashboard per project
- Persistent server mode — dashboard lifecycle matches the `5x dashboard` process
- Mobile-responsive layout — optimized for desktop monitors
- Audio notifications

---

## Aesthetic Direction

### Mission Control

The dashboard draws from NASA flight control rooms and aerospace telemetry displays. The visual language communicates: *this system is doing serious work, and you are the flight director*.

### Color System

```
Background layers:
  --bg-deep:        #0a0e17    Deep space — primary background
  --bg-panel:       #111827    Panel surface
  --bg-panel-hover: #1a2332    Panel hover/focus
  --bg-inset:       #0d1220    Inset areas (log viewers, code blocks)

Primary palette — Amber/Gold (active, important, human attention):
  --amber-100:      #fef3c7    Lightest amber (text highlights)
  --amber-300:      #fcd34d    Medium amber (active indicators)
  --amber-400:      #fbbf24    Primary amber (key metrics, active states)
  --amber-500:      #f59e0b    Strong amber (buttons, CTAs)
  --amber-600:      #d97706    Dark amber (hover states)

Data palette — Cool blue (informational, passive, metrics):
  --blue-200:       #bfdbfe    Light blue (secondary text)
  --blue-400:       #60a5fa    Medium blue (data values, charts)
  --blue-500:       #3b82f6    Standard blue (links, selections)
  --blue-600:       #2563eb    Dark blue (active nav)

Status colors:
  --status-success: #22c55e    Green (passed, complete, approved)
  --status-warning: #f59e0b    Amber (in-progress, waiting, corrections)
  --status-error:   #ef4444    Red (failed, aborted, blocked)
  --status-idle:    #6b7280    Gray (pending, not started)

Accent:
  --accent-cyan:    #06b6d4    Cyan (streaming indicators, live badges)

Border/separator:
  --border-dim:     #1e293b    Subtle panel borders
  --border-active:  #fbbf2440  Amber glow on active panels (40% opacity)
```

### Typography

```
Display / Headers:    "JetBrains Mono", monospace    — weight 700
                      Tracking: -0.02em
                      All-caps for panel headers

Body / Data:          "JetBrains Mono", monospace    — weight 400
                      Standard tracking

Numeric / Metrics:    "JetBrains Mono", monospace    — weight 500
                      Tabular nums (font-variant-numeric: tabular-nums)

Fallback stack:       "Fira Code", "Source Code Pro", "Courier New", monospace
```

Monospace throughout reinforces the terminal/mission-control aesthetic and ensures alignment in data-dense displays.

### Animation Language

| Context | Animation | Duration | Easing |
|---------|-----------|----------|--------|
| Active process indicator | Pulsing amber dot (opacity 0.4 → 1.0) | 2s | ease-in-out, infinite |
| State transition | Panel border flash amber → fade | 400ms | ease-out |
| Log line arrival | Fade in from left + slight slide | 150ms | ease-out |
| Metric counter change | Number rolls up/down (CSS counter or JS) | 300ms | ease-out |
| Phase completion | Brief green flash on phase card | 600ms | ease-out |
| Gate arrival | Amber border pulse + subtle scale bounce (1.0 → 1.02 → 1.0) | 500ms | spring |
| Panel loading | Shimmer gradient sweep left-to-right | 1.5s | linear, infinite |
| WebSocket connected | Cyan dot steady | — | — |
| WebSocket reconnecting | Cyan dot blink | 1s | step-end, infinite |
| Process idle | Dim all active indicators to gray | 500ms | ease-out |

### Visual Texture

- **Panel borders**: 1px `--border-dim`, with `--border-active` amber glow (box-shadow) on panels showing active processes
- **Noise overlay**: Subtle CSS noise texture on `--bg-deep` (repeating radial gradient or SVG filter) for depth
- **Grid lines**: Faint horizontal rules in data tables at 8% opacity
- **Scanline effect**: Optional subtle horizontal scanline overlay (2px transparent, 1px rgba(255,255,255,0.02)) on the log viewer panel for CRT texture — toggle via localStorage pref
- **Corner accents**: Small 90-degree angle brackets at panel corners (CSS border-image or pseudo-elements) evoking HUD framing
- **Status halos**: Active status dots get a soft radial glow (box-shadow 0 0 8px) in their status color

---

## Architecture

### System Diagram

```
 ┌─────────────────────────────────────┐
 │           5x dashboard              │
 │         (Bun HTTP server)           │
 │                                     │
 │  ┌───────────┐  ┌────────────────┐  │
 │  │  Static   │  │  WebSocket     │  │
 │  │  Files    │  │  Server        │  │
 │  │  (HTML/   │  │  (Bun native)  │  │
 │  │  CSS/JS)  │  │                │  │
 │  └───────────┘  └───────┬────────┘  │
 │                         │           │
 │  ┌──────────────────────┴────────┐  │
 │  │       Data Layer              │  │
 │  │                               │  │
 │  │  ┌─────────┐  ┌───────────┐  │  │
 │  │  │ SQLite  │  │ Log File  │  │  │
 │  │  │ Reader  │  │ Watcher   │  │  │
 │  │  │ (WAL)   │  │ (fs.watch)│  │  │
 │  │  └────┬────┘  └─────┬─────┘  │  │
 │  │       │              │        │  │
 │  │  ┌────┴──────────────┴─────┐  │  │
 │  │  │    Event Aggregator     │  │  │
 │  │  └─────────────────────────┘  │  │
 │  └───────────────────────────────┘  │
 │                                     │
 │  ┌───────────────────────────────┐  │
 │  │       Gate Bridge             │  │
 │  │  (shared file / IPC for      │  │
 │  │   gate request routing)      │  │
 │  └───────────────────────────────┘  │
 └──────────────┬──────────────────────┘
                │ reads
 ┌──────────────┴──────────────────────┐
 │            .5x/                     │
 │  ┌─────────┐  ┌──────────────────┐  │
 │  │ 5x.db   │  │ logs/            │  │
 │  │ (SQLite) │  │  <run-id>/      │  │
 │  │         │  │   agent-*.ndjson │  │
 │  │         │  │   quality-*.log  │  │
 │  └─────────┘  └──────────────────┘  │
 │  ┌─────────┐  ┌──────────────────┐  │
 │  │ locks/  │  │ debug/           │  │
 │  │         │  │  *-*.ndjson      │  │
 │  └─────────┘  └──────────────────┘  │
 └─────────────────────────────────────┘

 ┌─────────────────────────────────────┐
 │  Browser (localhost:55555)          │
 │                                     │
 │  ┌────────────────────────────┐     │
 │  │ WebSocket Client           │     │
 │  │  - Subscribe to channels   │     │
 │  │  - Send gate responses     │     │
 │  └─────────────┬──────────────┘     │
 │                │                    │
 │  ┌─────────────┴──────────────┐     │
 │  │ View Layer (vanilla JS)    │     │
 │  │  - Component modules       │     │
 │  │  - State management        │     │
 │  │  - DOM rendering           │     │
 │  └────────────────────────────┘     │
 └─────────────────────────────────────┘
```

### Server Component

The `5x dashboard` command starts a Bun HTTP server that serves static files and upgrades connections to WebSocket for real-time data.

**Static file serving**: HTML, CSS, and JS files are bundled inline within the CLI source (template literals or imported as text) to avoid runtime file resolution issues with compiled binaries. Alternative: embed as base64 or use Bun's `embed` if available.

**Database access**: Opens `.5x/5x.db` in read-only WAL mode. The dashboard never writes to orchestration tables — it only reads. Gate responses are communicated via the gate bridge (see below), not by writing to the DB directly.

**Log file watching**: Uses `fs.watch()` combined with periodic rescan (every 5s) on the `.5x/logs/` directory tree to detect new and updated log files. The rescan ensures reliability across platforms where `fs.watch()` may miss events. When an active run's agent log is appended to, the watcher reads new lines and pushes them to subscribed WebSocket clients.

**Lifecycle**: The server runs until the user sends SIGINT (Ctrl+C). On startup it prints the URL and connection info. No browser auto-open.

### WebSocket Protocol

Bidirectional JSON messages over a single WebSocket connection per browser tab. The WebSocket upgrade requires a valid session token (passed as `?token=<value>` query parameter or `Sec-WebSocket-Protocol` header). Unauthenticated upgrade attempts are rejected with `401`.

#### Server → Client Messages

```
{type: "snapshot", data: {plans: [...], runs: [...], ...}}
  Full state snapshot on connect and periodic refresh (every 5s)

{type: "run.update", data: {runId, ...fields}}
  Run state change (status, current_phase, current_state)

{type: "event", data: {runId, eventType, phase, iteration, data, createdAt}}
  New run_event journal entry

{type: "agent.result", data: {runId, phase, iteration, role, ...}}
  New agent result stored

{type: "quality.result", data: {runId, phase, attempt, passed, ...}}
  Quality gate result

{type: "log.line", data: {runId, logFile, line}}
  New NDJSON log line from agent session

{type: "gate.request", data: {gateId, gateType, runId, ...context}}
  Gate awaiting human response (phase, escalation, resume)

{type: "gate.resolved", data: {gateId, resolvedBy, response}}
  Gate was answered (by terminal or another dashboard tab)

{type: "phase.progress", data: {planPath, phase, ...fields}}
  Phase progress update
```

#### Client → Server Messages

```
{type: "gate.respond", data: {gateId, response}}
  Answer a pending gate (phase: continue/exit, escalation: fix/override/abort, etc.)

{type: "subscribe.logs", data: {runId, logFile?}}
  Subscribe to log streaming for a specific run (optional specific log file)

{type: "unsubscribe.logs", data: {runId}}
  Stop log streaming

{type: "request.snapshot"}
  Request a full state refresh
```

### Gate Bridge

The gate bridge provides a unified "human decision" mechanism used by both orchestration loops (`plan-review` and `phase-execution`), across all input modes (headless terminal, TUI, dashboard). Today's gate functions in `src/gates/human.ts` (`phaseGate`, `escalationGate`, `resumeGate`) read from stdin directly; the bridge layer abstracts the resolution source.

**Note on stale locks**: Stale locks are auto-stolen today (`src/lock.ts:acquireLock` — dead PID detection via `process.kill(pid, 0)`). There is no interactive stale-lock gate. The dashboard displays lock status as read-only telemetry, not as an interactive gate.

**Unified gate layer** (`src/gates/bridge.ts`): A new module that both orchestration loops call instead of the current direct-prompt functions. The bridge:
1. Writes a gate request file to `.5x/gates/<gate-id>.json`
2. Records a `human_decision` run_event with `data.status: "pending"` for audit
3. Races multiple resolution sources: terminal stdin (when interactive), gate file watch (for dashboard), and `--auto` policy (when applicable)
4. On resolution: atomically writes `<gate-id>.resolved.json`, records a `human_decision` run_event with the response and `resolvedBy` source, cleans up
5. Returns the typed response to the orchestrator

**Existing gate functions become thin wrappers**: `phaseGate()`, `escalationGate()`, and `resumeGate()` in `src/gates/human.ts` delegate to `bridge.requestGate()` with their specific context types. The plan-review loop's escalation gates (which currently use the same `escalationGate()` function) share this same path — no separate bespoke gate mechanism.

**TUI coexistence**: When TUI mode is active (`tui.active === true`), the dashboard operates in **observe-only mode** for gates — it displays gate status but does not accept gate responses. The TUI does not currently accept gate input either (gates remain CLI-driven per `src/commands/run.ts`), so the resolution sources in TUI mode are: terminal stdin + auto policy. When the dashboard is the only non-terminal interface (no TUI), it can respond to gates. This avoids three-way races.

| Mode | Gate resolution sources |
|------|------------------------|
| Headless (no TUI, no dashboard) | Terminal stdin only (or `--auto` policy) |
| Headless + dashboard | Terminal stdin + dashboard WebSocket (first-responder wins) |
| TUI mode (no dashboard) | Terminal stdin only (TUI is observe-only for gates) |
| TUI mode + dashboard | Terminal stdin only (both TUI and dashboard are observe-only) |

**Dashboard server integration**: On receiving a `gate.respond` WebSocket message, the server validates the token (see Security), checks that the gate is unresolved, and writes `<gate-id>.resolved.json`. The orchestrator (separate process) detects resolution via file watch or polling.

```
  Orchestrator                Gate File                  Dashboard
  (5x run)                (.5x/gates/)               (5x dashboard)
       │                        │                          │
       ├─── write gate ────────>│                          │
       │    request file        │                          │
       │                        │<──── fs.watch() ─────────┤
       │                        │                          │
       │                        │───── gate.request ──────>│ (WebSocket)
       │                        │                          │
       │    ┌───── terminal ────│                          │
       │    │      prompt       │                          │
       │    │                   │                          │
       │    │              OR   │<──── gate.respond ───────┤ (user clicks)
       │    │                   │      (atomic write)      │
       │    v                   │                          │
       ├─── poll / watch ──────>│                          │
       │    sees resolved       │                          │
       │                        │───── gate.resolved ─────>│ (WebSocket)
       └────────────────────────┴──────────────────────────┘
```

---

## Data Model Reference

The dashboard reads existing `.5x` artifacts. This section maps dashboard concepts to their actual DB/filesystem representations to prevent drift.

### Source of Truth: Database Tables

All table definitions are in `src/db/schema.ts` (migration v3). Row types are in `src/db/operations.ts`.

| Table | Dashboard Use | Key Columns |
|-------|--------------|-------------|
| `plans` | Plan list, worktree info | `plan_path` (PK), `worktree_path`, `branch` |
| `runs` | Run list, active state | `id`, `plan_path`, `status`, `current_phase`, `current_state`, `started_at`, `completed_at` |
| `run_events` | Timeline, event stream | `id` (autoincrement), `run_id`, `event_type`, `phase`, `iteration`, `data` (JSON), `created_at` |
| `agent_results` | Agent invocations, cost | `id`, `run_id`, `phase`, `iteration`, `role`, `template`, `result_type` (`status`\|`verdict`), `result_json`, `duration_ms`, `log_path`, `tokens_in`, `tokens_out`, `cost_usd` |
| `quality_results` | Quality gate badges | `id`, `run_id`, `phase`, `attempt`, `passed` (0\|1), `results` (JSON), `duration_ms` |
| `phase_progress` | Phase map status | `plan_path`, `phase`, `implementation_done` (0\|1), `latest_review_readiness`, `review_approved` (0\|1), `blocked_reason` |

### Run Statuses (DB values)

`runs.status` values: `active`, `completed`, `aborted`, `failed`

Dashboard display mapping:

| DB Status | Display | Icon | Color |
|-----------|---------|------|-------|
| `active` | ACTIVE | `◉` (pulsing) | `--amber-400` |
| `completed` | COMPLETE | `✓` | `--status-success` |
| `aborted` | ABORTED | `✗` | `--status-error` |
| `failed` | FAILED | `✗` | `--status-error` |

### Run Event Types (DB values)

`run_events.event_type` values as emitted by the orchestrators. The `data` column is JSON with event-specific fields.

**Phase execution loop** (`src/orchestrator/phase-execution-loop.ts`):

| Event Type | Phase | Description |
|------------|-------|-------------|
| `run_start` | — | Run begins |
| `phase_start` | yes | Phase begins execution |
| `agent_invoke` | yes | Author or reviewer agent invoked (data: role, template, resultId) |
| `quality_gate` | yes | Quality gate result (data: passed, attempt, results) |
| `verdict` | yes | Reviewer verdict stored (data: readiness, items) |
| `escalation` | yes | Escalation event (data: reason, items, source) |
| `human_decision` | yes | Human responded to gate (data: action, guidance) |
| `auto_escalation_continue` | yes | Auto-mode continued past escalation |
| `auto_escalation_abort` | yes | Auto-mode aborted at escalation |
| `phase_force_approved` | yes | Human force-approved phase (override) |
| `phase_complete` | yes | Phase finished successfully |
| `phase_execute_skipped_plan_complete` | yes | Phase skipped (already complete) |
| `phase_review_committed` | yes | Review committed to disk |
| `run_paused` | yes | Run paused at human gate |
| `run_complete` | — | All phases done |
| `run_abort` | — | Run aborted |
| `auto_start_fresh` | — | Previous active run marked aborted, starting fresh |

**Plan review loop** (`src/orchestrator/plan-review-loop.ts`):

| Event Type | Description |
|------------|-------------|
| `plan_review_start` | Review loop begins |
| `agent_invoke` | Author or reviewer invoked |
| `verdict` | Reviewer verdict stored |
| `escalation` | Escalation event |
| `human_decision` | Human responded to gate |
| `auto_escalation_continue` | Auto-mode continued |
| `auto_escalation_abort` | Auto-mode aborted |
| `plan_review_complete` | Plan approved |
| `plan_review_abort` | Plan review aborted |
| `auto_start_fresh` | Previous run aborted, starting fresh |

**Plan generation** (`src/commands/plan.ts`):

| Event Type | Description |
|------------|-------------|
| `plan_generate_start` | Plan generation begins |
| `plan_generate_complete` | Plan generated successfully |
| `error` | Error during generation |

### Agent Log Filenames

Agent logs are stored as `.5x/logs/<run-id>/agent-<resultId>.ndjson` where `<resultId>` is the `agent_results.id` value — a generated unique ID (not role/phase encoded). The `agent_results.log_path` column stores the full path.

To map a log file to its agent invocation context, join on `agent_results.log_path` or `agent_results.id` (extracted from the filename: `agent-<id>.ndjson` → `id`).

Quality gate logs: `.5x/logs/<run-id>/quality-phase<N>-attempt<N>-<gate-name>.log`

### Derived Views

The dashboard computes these derived values from raw DB data:

| View | Source | Computation |
|------|--------|-------------|
| Active phase | `runs.current_phase` | Direct read |
| Current state | `runs.current_state` | Direct read |
| Latest event | `run_events` | `MAX(id) WHERE run_id = ?` |
| Phase count / progress | `phase_progress` | Count rows, sum `review_approved` |
| Cost per run | `agent_results` | `SUM(cost_usd) WHERE run_id = ?` |
| Tokens per run | `agent_results` | `SUM(tokens_in)`, `SUM(tokens_out)` |
| Cost per plan | `agent_results` JOIN `runs` | Aggregate across all runs for a plan |

### Polling Strategy

Poll using monotonically increasing `run_events.id` as the high-water mark — avoids the need for an `updated_at` column on `runs` (no schema migration required):

```
SELECT * FROM run_events WHERE id > :lastSeenId ORDER BY id ASC
```

Changes to `runs`, `agent_results`, `quality_results`, and `phase_progress` are detected by tracking their max `rowid` or by re-querying active runs on each poll cycle. Polling interval: 2 seconds.

---

## Page Structure

### Navigation Model

Single-page application with hash-based routing. No page reloads.

```
#/                          Multi-plan overview (landing page)
#/plan/<plan-path>          Plan detail — phases, runs, progress
#/run/<run-id>              Run detail — state machine, events, agents
#/run/<run-id>/logs         Log viewer for a specific run
#/history                   Historical runs table with filters
#/analytics                 Cost/token analytics (secondary)
```

### Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ ▸ 5X COMMAND CENTER           ● CONNECTED    [plan-a] [plan-b] [+] │  ← Top bar
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Main content area — varies by route                                │
│                                                                     │
│  (see individual page layouts below)                                │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ GATES: [Phase 3 gate awaiting response ▸]    ◉ 2 active  ○ 3 idle  │  ← Status bar
└─────────────────────────────────────────────────────────────────────┘
```

**Top bar** (fixed, 48px):
- "5X COMMAND CENTER" branding (amber, all-caps, letter-spaced)
- WebSocket connection indicator (cyan dot = connected, blinking = reconnecting, red = disconnected)
- Plan tabs for quick switching between active plans
- Settings gear (localStorage prefs: scanline toggle, animation speed)

**Status bar** (fixed, 36px):
- Pending gate notifications (amber pulse, clickable to open gate modal)
- Active/idle process count
- Elapsed time for current run

### Page: Multi-Plan Overview (`#/`)

The landing page. Shows all known plans with their current state.

```
┌─────────────────────────────────────────────────────────────────────┐
│ PLANS                                                        ⟳ 5s  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ 006-impl-dashboard ──────────────────────────────────────────┐  │
│  │ STATUS: ◉ EXECUTING   Phase 3/7   State: QUALITY_CHECK       │  │
│  │ ████████████░░░░░░░░░░ 42%                                   │  │
│  │                                                               │  │
│  │ Run: a1b2c3d4   Started: 14:23   Duration: 12m 34s           │  │
│  │ Cost: $0.47     Tokens: 124K in / 18K out                    │  │
│  │                                                               │  │
│  │ Phases: [1 ✓] [2 ✓] [3 ◉] [4 ○] [5 ○] [6 ○] [7 ○]         │  │
│  │         done   done  active                                   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ 005-impl-console-cleanup ────────────────────────────────────┐  │
│  │ STATUS: ✓ COMPLETE   7/7 phases   Total: 2h 14m              │  │
│  │ ████████████████████ 100%                                     │  │
│  │                                                               │  │
│  │ Last run: f9e8d7c6   Completed: yesterday 16:45              │  │
│  │ Total cost: $2.31   Tokens: 890K in / 156K out               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ 004-impl-tui ────────────────────────────────────────────────┐  │
│  │ STATUS: ✗ ABORTED   Phase 2/4   State: ESCALATE              │  │
│  │ ██████████░░░░░░░░░░░ 50%                                    │  │
│  │                                                               │  │
│  │ Last run: 1a2b3c4d   Aborted: 2 days ago                     │  │
│  │ Reason: Human aborted at escalation gate                      │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Each plan card is clickable → navigates to `#/plan/<path>`. Active plans sort to top with amber border glow. Completed plans have green left border. Aborted/failed plans have red left border.

**Plan discovery**: The dashboard shows plans that exist in the `plans` database table — i.e., plans that have been the target of at least one `5x run`, `5x plan-review`, or `5x plan` command. It does not scan the filesystem for plan files. This matches the CLI's existing behavior where plans are upserted into the DB on first use (`upsertPlan()` in `src/db/operations.ts`). Plan paths are canonical (resolved via `canonicalizePlanPath()`).

### Page: Plan Detail (`#/plan/<path>`)

Drill-down into a single plan's lifecycle.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ◂ PLANS   006-impl-dashboard                        ◉ EXECUTING    │
├──────────────────────────────────┬──────────────────────────────────┤
│ PHASE MAP                        │ ACTIVE RUN: a1b2c3d4            │
│                                  │                                  │
│  ┌──────┐   ┌──────┐   ┌──────┐ │ State: QUALITY_CHECK             │
│  │  P1  │──>│  P2  │──>│  P3  │ │ Phase: 3 — "HTTP Server"        │
│  │  ✓   │   │  ✓   │   │  ◉   │ │ Iteration: 2                    │
│  └──────┘   └──────┘   └──┬───┘ │ Quality attempt: 1/3            │
│                            │     │                                  │
│  ┌──────┐   ┌──────┐   ┌──┴───┐ │ ┌─ TIMELINE (run_events) ─────┐ │
│  │  P4  │──>│  P5  │──>│  P6  │ │ │ 14:23:01  run_start         │ │
│  │  ○   │   │  ○   │   │  ○   │ │ │ 14:23:05  phase_start P1    │ │
│  └──────┘   └──────┘   └──────┘ │ │ 14:24:30  agent_invoke P1   │ │
│                                  │ │ 14:25:12  quality_gate P1 ✓ │ │
│  ┌──────┐                        │ │ 14:25:45  verdict P1 ready  │ │
│  │  P7  │                        │ │ 14:26:00  human_decision ✓  │ │
│  │  ○   │                        │ │ 14:26:01  phase_complete P1 │ │
│  └──────┘                        │ │ 14:26:03  phase_start P2    │ │
│                                  │ │ 14:31:01  verdict P2 ready  │ │
│ Phase 3 detail:                  │ │ 14:31:18  phase_start P3    │ │
│ ┌────────────────────────────┐   │ │ 14:35:02  quality_gate P3.. │ │
│ │ Implementation: ✓ done     │   │ │           ◉ waiting...      │ │
│ │ Quality: ◉ running         │   │ └────────────────────────────┘ │
│ │ Review: ○ pending          │   │                                  │
│ │ Gate: ○ pending            │   │ Author result:                   │
│ │                            │   │   result: complete               │
│ │ Author: complete           │   │   commit: 8a3f2b1c              │
│ │   commit: 8a3f2b1c        │   │   duration: 3m 44s               │
│ │   duration: 3m 44s        │   │   tokens: 42K in / 8K out        │
│ │   cost: $0.12             │   │   cost: $0.12                    │
│ └────────────────────────────┘   │                                  │
├──────────────────────────────────┴──────────────────────────────────┤
│ RUN HISTORY                                                         │
│ ┌──────────┬────────┬───────┬────────┬─────────┬───────────────┐   │
│ │ Run ID   │ Status │ Phase │ Phases │ Cost    │ Started       │   │
│ ├──────────┼────────┼───────┼────────┼─────────┼───────────────┤   │
│ │ a1b2c3d4 │ ◉ act  │ 3/7   │ 2 done │ $0.47   │ today 14:23   │   │
│ │ 9f8e7d6c │ ✗ abt  │ 1/7   │ 0 done │ $0.08   │ today 13:55   │   │
│ └──────────┴────────┴───────┴────────┴─────────┴───────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Phase map**: Visual graph of phases with status indicators. Active phase pulses amber. Completed phases show green check. Layout follows the plan's phase numbering (1, 1.1, 2, etc.) as a directed graph.

**Active run panel**: Real-time state machine position, current iteration, quality attempt counter, and a scrolling timeline of run events.

**Phase detail**: Expandable section showing the inner state for the selected phase — implementation status, quality results, review verdict, and agent result summaries.

**Run history**: Table of all runs for this plan, clickable to navigate to run detail.

### Page: Run Detail (`#/run/<id>`)

Deep dive into a single run.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ◂ PLAN   RUN a1b2c3d4                    ◉ ACTIVE   12m 34s        │
├──────────────────────────────────┬──────────────────────────────────┤
│ STATE MACHINE                    │ EVENTS                           │
│                                  │                                  │
│  ┌─────────┐    ┌────────────┐   │ ┌────────────────────────────┐  │
│  │ EXECUTE │───>│  QUALITY   │   │ │ 14:35:02 quality_gate     │  │
│  │         │    │  CHECK  ◉  │   │ │   phase: 3, attempt: 1    │  │
│  └────┬────┘    └──────┬─────┘   │ │ 14:34:58 agent_invoke     │  │
│       │                │         │ │   role: author, complete   │  │
│       │         ┌──────┴─────┐   │ │   commit: 8a3f2b1c        │  │
│       │         │  QUALITY   │   │ │ 14:31:18 phase_start      │  │
│       │         │  RETRY     │   │ │   phase: 3                │  │
│       │         └──────┬─────┘   │ │ 14:31:15 human_decision   │  │
│       │                │         │ │   action: continue         │  │
│  ┌────┴────┐    ┌──────┴─────┐   │ │ 14:31:01 verdict          │  │
│  │ REVIEW  │<───│            │   │ │   readiness: ready         │  │
│  │         │    │            │   │ │ ...                        │  │
│  └────┬────┘    └────────────┘   │ └────────────────────────────┘  │
│       │                          │                                  │
│  ┌────┴────┐    ┌────────────┐   │ AGENT RESULTS                   │
│  │AUTO_FIX │    │  ESCALATE  │   │ ┌────────────────────────────┐  │
│  │         │    │            │   │ │ P3 Author   3m44s  $0.12  │  │
│  └─────────┘    └────────────┘   │ │ P2 Reviewer 1m22s  $0.04  │  │
│                                  │ │ P2 Author   4m11s  $0.15  │  │
│  ┌─────────┐    ┌────────────┐   │ │ P1 Reviewer 1m05s  $0.03  │  │
│  │  PHASE  │    │  PHASE     │   │ │ P1 Author   2m58s  $0.11  │  │
│  │  GATE   │    │  COMPLETE  │   │ │ ...                        │  │
│  └─────────┘    └────────────┘   │ └────────────────────────────┘  │
│                                  │                                  │
│  Current: QUALITY_CHECK          │  [View Logs]                     │
│  Arrows show valid transitions   │                                  │
├──────────────────────────────────┴──────────────────────────────────┤
│ QUALITY GATES                                                       │
│ Phase 1: ✓ build  ✓ lint  ✓ test    Phase 2: ✓ build  ✓ lint  ✓   │
│ Phase 3: ◉ running...                                               │
└─────────────────────────────────────────────────────────────────────┘
```

**State machine diagram**: Visual representation of the phase execution loop states. Current state highlighted with amber glow. Valid transitions shown as arrows. States already visited in this phase shown with subtle trail.

**Events panel**: Scrolling list of run_events in reverse chronological order. Each event shows type, phase, iteration, and parsed data. Auto-scrolls to newest; pause on user scroll-up.

**Agent results**: Compact table of all agent invocations for this run with role, phase, duration, cost, and a link to open the log viewer.

**Quality gates**: Bottom bar showing pass/fail badges per phase for each configured quality gate command.

### Page: Log Viewer (`#/run/<id>/logs`)

Full-screen streaming log viewer.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ◂ RUN a1b2c3d4   LOGS                    [Search: ________] [⏸ ▶]  │
├────────────────────┬────────────────────────────────────────────────┤
│ LOG FILES          │ agent-ex_3f8a2b.ndjson                         │
│ (from agent_       │                                                │
│  results.log_path) │                                                │
│                    │ {"type":"event","event":{"type":"assistant.    │
│ ◉ P3 Author i2    │  message.start","data":{"messageId":"msg_01... │
│   agent-ex_3f8a.. │ {"type":"event","event":{"type":"content.      │
│ ○ P3 Author i1    │  delta","data":{"delta":{"type":"text","text": │
│   agent-ex_2d7c.. │  "Let me start by examining the existing...    │
│ ○ P2 Reviewer     │                                                │
│   agent-rv_9e4f.. │ {"type":"event","event":{"type":"tool_use.     │
│ ○ P2 Author       │  start","data":{"toolName":"Read","input":{... │
│   agent-ex_7b3a.. │                                                │
│ ○ P1 Reviewer     │ {"type":"event","event":{"type":"tool_use.     │
│   agent-rv_1c5d.. │  result","data":{"output":"...file contents... │
│ ○ P1 Author       │                                                │
│                    │ {"type":"event","event":{"type":"content.      │
│                    │  delta","data":{"delta":{"type":"text","text": │
│                    │  "I'll implement the HTTP server module by...  │
│                    │                                                │
│                    │                    ◉ STREAMING — 342 lines     │
│                    │                    ▼ auto-scroll active        │
└────────────────────┴────────────────────────────────────────────────┘
```

**Left panel**: List of log files for the run, derived from `agent_results` rows (join `agent_results.log_path` to resolve filenames). Displayed grouped by phase and labeled with role + iteration for readability (the raw filenames are `agent-<resultId>.ndjson`). Active log (being written to) gets a pulsing indicator. Click to switch.

**Right panel**: NDJSON log content rendered with:
- Syntax highlighting for JSON structure
- ANSI color code rendering for embedded terminal output
- Line numbers
- Search highlighting (Ctrl+F or search box)
- Auto-scroll when at bottom; pauses when user scrolls up; "Jump to bottom" button appears
- Click a line to copy its content

**Streaming**: When viewing an active log, new lines appear in real-time via WebSocket `log.line` messages. A "STREAMING" indicator with line count is shown at the bottom.

### Page: Analytics (`#/analytics`)

Secondary page for cost and token usage data.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ◂ HOME   ANALYTICS                          Period: [Last 7 days ▾] │
├──────────────────────────────────┬──────────────────────────────────┤
│ COST SUMMARY                     │ TOKEN USAGE                      │
│                                  │                                  │
│ Total spend:     $14.23          │ Total input:    2.4M tokens      │
│ Avg per run:     $1.78           │ Total output:   410K tokens      │
│ Avg per phase:   $0.32           │ Avg per run:    300K / 51K       │
│                                  │                                  │
│ ┌────────────────────────────┐   │ ┌────────────────────────────┐  │
│ │  $3                        │   │ │  500K                      │  │
│ │  ██                        │   │ │  ████                      │  │
│ │  ██ ██                     │   │ │  ████ ████                 │  │
│ │  ██ ██ ██       ██         │   │ │  ████ ████ ████     ████  │  │
│ │  ██ ██ ██ ██ ██ ██ ██      │   │ │  ████ ████ ████ ████ ████ │  │
│ │  ── ── ── ── ── ── ──      │   │ │  ──── ──── ──── ──── ──── │  │
│ │  M  T  W  T  F  S  S      │   │ │  Mon  Tue  Wed  Thu  Fri  │  │
│ └────────────────────────────┘   │ └────────────────────────────┘  │
│                                  │                                  │
├──────────────────────────────────┴──────────────────────────────────┤
│ COST BY PLAN                                                        │
│ ┌──────────────────────────┬────────┬──────────┬────────┬─────────┐ │
│ │ Plan                     │ Runs   │ Phases   │ Cost   │ Tokens  │ │
│ ├──────────────────────────┼────────┼──────────┼────────┼─────────┤ │
│ │ 006-impl-dashboard       │ 2      │ 3/7      │ $0.55  │ 166K    │ │
│ │ 005-impl-console-cleanup │ 1      │ 7/7      │ $2.31  │ 890K    │ │
│ │ 004-impl-tui             │ 3      │ 2/4      │ $4.12  │ 520K    │ │
│ │ 003-impl-opencode        │ 2      │ 5/5      │ $5.89  │ 1.2M    │ │
│ └──────────────────────────┴────────┴──────────┴────────┴─────────┘ │
│                                                                     │
│ COST BY ROLE                                                        │
│ Author:   $10.45 (73%)  ████████████████████████░░░░░░░░░          │
│ Reviewer: $3.78  (27%)  ████████░░░░░░░░░░░░░░░░░░░░░░░           │
└─────────────────────────────────────────────────────────────────────┘
```

Charts are rendered with SVG (no charting library). Simple bar charts and horizontal progress bars. Data is aggregated from `agent_results` table.

### Gate Modal

When a gate fires, a modal overlay appears (in addition to the status bar notification).

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│    ┌─ PHASE GATE ──────────────────────────────────────────────┐    │
│    │                                                           │    │
│    │  Phase 3: "HTTP Server" — Complete                        │    │
│    │                                                           │    │
│    │  ┌─────────────────────────────────────────────────────┐  │    │
│    │  │ Commit:       8a3f2b1c                              │  │    │
│    │  │ Quality:      PASSED                                │  │    │
│    │  │ Review:       ready                                 │  │    │
│    │  │ Files changed: 12                                   │  │    │
│    │  │ Duration:     3m 44s                                │  │    │
│    │  └─────────────────────────────────────────────────────┘  │    │
│    │                                                           │    │
│    │  ┌──────────────────────┐  ┌─────────────────────────┐   │    │
│    │  │  ▸ CONTINUE          │  │    EXIT (pause run)     │   │    │
│    │  │    to Phase 4        │  │                         │   │    │
│    │  └──────────────────────┘  └─────────────────────────┘   │    │
│    │                                                           │    │
│    └───────────────────────────────────────────────────────────┘    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Phase gate modal**: Shows phase summary, two action buttons (continue / exit).

**Escalation gate modal**: Shows reason, review items with priorities, three action buttons (fix with guidance / override / abort). Guidance input appears as a text area when "fix" is selected. Used by both `plan-review` and `phase-execution` loops.

**Resume gate modal**: Shows interrupted run info, three action buttons (resume / start fresh / abort).

All gate modals have an amber pulsing border and auto-dismiss when resolved (by any responder). If resolved by terminal, the modal shows "Resolved via terminal" briefly before dismissing. When TUI mode is active, gate modals display in read-only mode with a "Gate controlled via terminal" notice.

---

## Data Flow

### Database Polling

The dashboard polls the SQLite database on a 2-second interval using the strategy defined in [Data Model Reference > Polling Strategy](#polling-strategy):

- **Run events**: `SELECT * FROM run_events WHERE id > :lastSeenId` — monotonically increasing ID, no schema change needed
- **Active runs**: Re-query `runs WHERE status = 'active'` and diff against in-memory state for `current_phase`/`current_state` changes
- **Agent results / quality results**: Track max `rowid` per table, query new rows
- **Phase progress**: Re-query for active plans, diff against cached state

Changes are diffed against in-memory state and broadcast as targeted WebSocket messages to connected clients.

**Why polling, not triggers**: SQLite doesn't support cross-process change notifications. The WAL mode allows concurrent reads while the orchestrator writes. Polling at 2s is cheap (indexed queries on small tables) and provides consistent behavior regardless of whether the orchestrator is co-located or a separate process.

**No schema migration required.** The existing `run_events.id` autoincrement column serves as the polling cursor.

### Log File Streaming

`fs.watch()` semantics are inconsistent across platforms (missing events, duplicate events, no recursive support on some OSes). The log watcher uses a **watch + periodic rescan** strategy for reliability:

```
fs.watch(".5x/logs/")         Periodic rescan (every 5s)
        │                              │
        ├── new directory ──────>  ┌───┴────────────────────┐
        │   (new run)              │ readdir(".5x/logs/")   │
        │                          │ for each run dir:      │
        └── file change ─────┐    │   stat each .ndjson    │
                              │    │   compare mtime/size   │
                              v    │   vs last known        │
                     ┌────────┴────┴───────────┐
                     │ Read new bytes from     │
                     │ last known offset       │
                     │ Parse NDJSON lines      │
                     │ Push to subscribed WS   │
                     └─────────────────────────┘
```

- `fs.watch()` is treated as an **optimization** (immediate notification) not a guarantee
- A periodic rescan (every 5 seconds) catches any events missed by `fs.watch()` — bounded cost: `readdir` + `stat` on a small directory tree
- Each log file gets a tracked read offset and mtime. On change (watch or rescan), the server reads from the last offset to EOF, splits on newlines, and sends each complete line as a `log.line` WebSocket message
- Gate files in `.5x/gates/` use the same watch + rescan pattern

### State Snapshot

On WebSocket connect, the server sends a full `snapshot` message containing:
- All plans (from `plans` table)
- All runs (from `runs` table) with their latest events
- Phase progress for all plans
- All pending gates (from `.5x/gates/` directory)
- Active log files and their line counts

This ensures the client can render immediately without waiting for incremental updates.

---

## CLI Command

### `5x dashboard`

```
Usage: 5x dashboard [options]

Options:
  --port <number>     Port to listen on (default: 55555)
  --host <address>    Bind address (default: 127.0.0.1)
  --no-gate-bridge    Disable gate bridge (read-only mode)
```

**Startup sequence**:
1. Resolve project root (same logic as other 5x commands)
2. Load config (for DB path, quality gate names)
3. Open database in read-only WAL mode
4. Scan `.5x/gates/` for pending gate files
5. Start file watchers on `.5x/logs/` and `.5x/gates/`
6. Start HTTP server on configured host:port
7. Print startup banner:

```
  5X COMMAND CENTER
  ─────────────────
  URL:   http://127.0.0.1:55555?token=a3f8...c7d8
  Token: a3f8b2c1d4e5...d8e9f0a1
  DB:    .5x/5x.db (14 runs, 3 active plans)
  Logs:  .5x/logs/ (watching)

  Press Ctrl+C to stop.
```

**Shutdown**: SIGINT triggers graceful shutdown — close WebSocket connections, stop file watchers, close database, exit.

### Config

Dashboard settings are **CLI flags only** — no config file section. This avoids modifying `FiveXConfigSchema` in `src/config.ts` and the unknown-key warning allowlist. Dashboard is a development-time tool; persisting host/port preferences in the project config has no value since they're machine-specific.

```
5x dashboard                         # localhost:55555 (defaults)
5x dashboard --port 8080             # localhost:8080
5x dashboard --host 0.0.0.0         # all interfaces:55555
```

If a `dashboard` config section is needed later (e.g., for team-shared port conventions), it can be added to the schema at that time with a migration to the allowlist in `warnUnknownConfigKeys()`.

---

## File Organization

All dashboard source lives within the `5x-cli` package:

```
5x-cli/src/
  commands/
    dashboard.ts              CLI command definition (citty)
  gates/
    bridge.ts                 Unified gate mechanism (new — used by both loops)
  dashboard/
    server.ts                 Bun HTTP server + WebSocket setup
    routes.ts                 Static file serving + API routes
    ws-protocol.ts            WebSocket message types and handlers
    data.ts                   Database polling + state diffing
    log-watcher.ts            Log file watching + streaming
    gate-responder.ts         Dashboard-side gate file writer (reads WS, writes .resolved.json)
    static/
      index.html              Single HTML entry point
      style.css               All styles
      app.js                  Main application module
      components/
        top-bar.js            Top navigation bar
        status-bar.js         Bottom status bar
        plan-overview.js      Multi-plan landing page
        plan-detail.js        Plan drill-down
        run-detail.js         Run state machine + events
        log-viewer.js         Streaming log viewer
        analytics.js          Cost/token charts
        gate-modal.js         Gate response modals
        phase-map.js          Phase graph visualization
        state-machine.js      State machine diagram
      lib/
        ws-client.js          WebSocket client with reconnect
        router.js             Hash-based SPA router
        store.js              Reactive state management
        render.js             DOM rendering utilities
        format.js             Number/date/duration formatters
        ansi.js               ANSI escape code → HTML converter
```

Static files are embedded into the compiled binary using Bun's `embed` macro or by inlining as template literals during the build step, ensuring `5x dashboard` works without needing the source tree.

---

## Gate Bridge Protocol

### Gate File Format

```json
{
  "gateId": "gate_a1b2c3d4",
  "gateType": "phase",
  "runId": "run_5678",
  "createdAt": "2026-02-26T14:31:15.000Z",
  "resolved": false,
  "resolvedBy": null,
  "resolvedAt": null,
  "context": {
    "phaseNumber": "3",
    "phaseTitle": "HTTP Server",
    "commit": "8a3f2b1c",
    "qualityPassed": true,
    "reviewVerdict": "ready",
    "filesChanged": 12,
    "duration": 224000
  },
  "response": null
}
```

Gate types and their response shapes (shared by both `plan-review` and `phase-execution` loops):

| Gate Type | Context Fields | Response Shape | Used By |
|-----------|---------------|----------------|---------|
| `phase` | `PhaseSummary` (`src/gates/human.ts`) | `{action: "continue"\|"exit"}` | phase-execution |
| `escalation` | `EscalationEvent` (`src/gates/human.ts`) | `{action: "continue"\|"approve"\|"abort", guidance?: string}` | both loops |
| `resume` | `{runId, phase, state}` | `{action: "resume"\|"start-fresh"\|"abort"}` | phase-execution |

**Not a gate**: Stale lock resolution is handled automatically by `src/lock.ts` (dead PID → auto-steal). No interactive gate exists today.

### Resolution Protocol

1. Orchestrator calls `bridge.requestGate()` which writes `<gateId>.json` with `resolved: false`
2. Orchestrator records `human_decision` run_event with `data: {gateId, gateType, status: "pending"}`
3. Responder (terminal stdin or dashboard) writes `<gateId>.resolved.json` with the response (atomic via rename from temp file)
4. Orchestrator detects resolution via `fs.watch()` or polling (combined — see P1.1)
5. Orchestrator records `human_decision` run_event with `data: {gateId, response, resolvedBy: "terminal"|"dashboard"}`
6. Orchestrator reads response and continues state machine

The two-file approach (separate `.resolved.json`) avoids read-write races on the same file. The orchestrator only acts when it sees the `.resolved.json` file appear.

### Cleanup

Resolved gate files are deleted after the orchestrator reads them. The `human_decision` run_events in the database serve as the audit trail (gate files are ephemeral coordination artifacts, not permanent records).

---

## State Management (Client)

### Reactive Store

A minimal reactive store (< 100 lines) provides:
- Centralized state object
- `subscribe(path, callback)` for fine-grained DOM updates
- `update(path, value)` triggers only relevant subscribers
- No virtual DOM — direct DOM manipulation via subscriber callbacks

```
store = {
  connection: "connected" | "reconnecting" | "disconnected",
  plans: Map<planPath, PlanState>,
  runs: Map<runId, RunState>,
  activeGates: Map<gateId, GateState>,
  logs: {
    subscribed: Set<runId>,
    lines: Map<logFile, string[]>,
    offsets: Map<logFile, number>,
  },
  ui: {
    currentRoute: string,
    selectedPlan: string | null,
    selectedRun: string | null,
    prefs: { scanlines: boolean, animationSpeed: number },
  },
}
```

### WebSocket Client

Auto-reconnecting WebSocket client with:
- Exponential backoff (1s → 2s → 4s → 8s → 16s max)
- Automatic re-subscribe on reconnect
- Snapshot request on reconnect to resync state
- Connection state reflected in top bar indicator

### Protocol Versioning

All WebSocket messages include a `v` field indicating the protocol version:

```
{v: 1, type: "snapshot", data: {...}}
{v: 1, type: "gate.respond", data: {...}}
```

The server includes `protocolVersion: 1` in the initial `snapshot` message. The client checks this on connect and displays a "dashboard out of date — reload" warning if the server version exceeds its known version. This mirrors the structured-signal versioning pattern in the existing CLI and allows the UI and server to evolve independently.

---

## Implementation Considerations

### Database Schema

No schema migrations required. The dashboard reads existing tables via WAL-mode read-only access. Polling uses `run_events.id` (autoincrement) as the high-water mark — see [Data Model Reference](#data-model-reference).

### Orchestrator Changes

A new `src/gates/bridge.ts` module provides `requestGate()` — the single entry point for all human decisions across both orchestration loops:

1. **New module**: `src/gates/bridge.ts` — `requestGate(db, runId, gateType, context, options)` → typed response
2. **Existing functions become wrappers**: `phaseGate()`, `escalationGate()`, `resumeGate()` in `src/gates/human.ts` delegate to `requestGate()` with their typed context. Plan-review and phase-execution loops both use the same gate primitives.
3. **Resolution race**: `requestGate()` races terminal `readLine()` (when `isInteractive()`) against file-based resolution (`.5x/gates/` watch + poll). The `--auto` policy short-circuits both.
4. **Backward compatible**: When no `.5x/gates/` directory exists (no dashboard running), resolution falls back to terminal-only. The `isInteractive()` check is preserved — non-interactive mode auto-resolves per current behavior.
5. **Audit**: Every gate request and resolution is recorded as a `human_decision` run_event in the database.

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

Modern evergreen browsers only (Chrome, Firefox, Safari, Edge). ES2022+ features permitted. No transpilation or polyfills.

### Security

**Threat model**: The `.5x/` directory contains NDJSON agent logs that may include file contents, environment variables, or other sensitive data from the project. Interactive gate control allows affecting running orchestrator processes. The security model must prevent unauthorized access to both data and control surfaces.

**Token authentication**: On startup, `5x dashboard` generates a cryptographically random token (32 bytes, hex-encoded) and prints it to the local terminal alongside the URL:

```
  5X COMMAND CENTER
  ─────────────────
  URL:   http://127.0.0.1:55555?token=a3f8...
  Token: a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
  DB:    .5x/5x.db (14 runs, 3 active plans)

  Press Ctrl+C to stop.
```

The token is also written to `.5x/dashboard-token` (mode 0600) so that future integrations (e.g., `5x run --dashboard`) can read it.

**Token enforcement**:
- **HTTP requests**: Token required as `?token=<value>` query parameter or `Authorization: Bearer <value>` header. Requests without a valid token receive `401 Unauthorized`. The initial HTML page load must include the token in the URL.
- **WebSocket upgrade**: Token required in the `Sec-WebSocket-Protocol` header or as a query parameter during the upgrade handshake. Connections without a valid token are rejected with `401`.
- **Gate responses**: `gate.respond` WebSocket messages are only accepted on authenticated connections (enforced by the upgrade check).

**Network binding**:
- Default: `127.0.0.1` (localhost only)
- `--host 0.0.0.0`: Binds to all interfaces with a loud warning:

```
  ⚠ WARNING: Dashboard bound to 0.0.0.0 — accessible from the network.
  ⚠ All access is gated by the session token. Do not share the URL.
```

- **Origin validation**: When bound to localhost, WebSocket upgrade requests are validated against `Origin: http://localhost:*` or `http://127.0.0.1:*`. When bound to all interfaces, origin validation is relaxed (token is the primary gate).

**Data exposure**: NDJSON agent logs may contain project file contents, environment variables, and other sensitive context. This is the same data accessible via `cat .5x/logs/*` on the local filesystem — the dashboard does not increase the attack surface for localhost users, but non-localhost binding exposes it over the network (hence the token requirement).

---

## Design Decisions (Resolved)

These were originally open questions, now resolved:

1. **Co-location vs. separate process**: Start with standalone `5x dashboard` only. The gate bridge uses file-based coordination which works across process boundaries. A future `5x run --dashboard` flag can be added later with an in-memory event emitter short-circuit — the bridge abstraction supports both paths without changing the dashboard code.

2. **Multi-tab coordination**: No tab-to-tab coordination. Each browser tab gets its own WebSocket connection. Gate responses are deduplicated at the server level (first write to `.resolved.json` wins). Subsequent tabs see `gate.resolved` and auto-dismiss. Simple and correct.

3. **Log file size limits**: The server streams only new lines to the client (not full history). The client uses a virtualized list for display and caps in-memory lines at **10,000 per log file**. Older lines are discarded from the front. A "Load earlier" button triggers an HTTP GET for the full log file with byte-range offsets. This bounds browser memory while keeping the common case (watching a live log) fast.

4. **Embedded vs. external static files**: Production builds embed static files in the binary (Bun `embed` macro or template literals). A `--dev` flag serves from the filesystem (`src/dashboard/static/`) for rapid iteration with browser refresh. The `--dev` flag is omitted from `--help` output (developer convenience, not user-facing).

---

## User Workflows: TUI vs. Dashboard

Three expected usage patterns:

| Mode | How to run | Gate control | Best for |
|------|-----------|-------------|----------|
| **Dashboard only** | `5x run <plan>` in one terminal + `5x dashboard` in another, open browser | Terminal + dashboard (first-responder) | Multi-plan monitoring, visual gate control |
| **TUI only** | `5x run <plan> --tui-listen`, attach with `opencode attach <url>` | Terminal only (TUI is observe-only) | Agent session visibility, debugging prompts |
| **Dashboard + TUI** | All three running simultaneously | Terminal only (dashboard + TUI both observe-only for gates) | Maximum observability, gate control via terminal |

The dashboard never conflicts with TUI mode because gate control is arbitrated at the bridge level (see [Gate Bridge](#gate-bridge)). Both dashboard and TUI provide observability; only the terminal (or dashboard in non-TUI mode) can resolve gates.

---

## See Also

- [001-impl-5x-cli.md](development/001-impl-5x-cli.md) — Core CLI implementation plan (orchestrator, DB, gates)
- [src/gates/human.ts](../src/gates/human.ts) — Current terminal gate implementations
- [src/db/schema.ts](../src/db/schema.ts) — Database schema and migrations
- [src/orchestrator/phase-execution-loop.ts](../src/orchestrator/phase-execution-loop.ts) — Phase execution state machine
- [src/orchestrator/plan-review-loop.ts](../src/orchestrator/plan-review-loop.ts) — Plan review state machine

---

## Revision History

### v1.1 (February 26, 2026) — Review corrections

**Review**: [2026-02-26-10-dashboard-design-review.md](development/reviews/2026-02-26-10-dashboard-design-review.md)

**P0 blockers resolved:**
- **P0.1**: Updated `001-impl-5x-cli.md` to reference dashboard as a separate initiative (was listed as "out of scope")
- **P0.2**: Replaced ad-hoc gate bridge with unified gate mechanism (`src/gates/bridge.ts`) shared by both loops. Removed stale-lock gate (auto-stolen by `src/lock.ts`, no interactive gate exists). Added TUI coexistence matrix. Gate resolutions recorded as `human_decision` run_events for audit.
- **P0.3**: Added Data Model Reference section mapping dashboard views to actual DB tables, `run_events.event_type` vocabulary, `runs.status` values, and `agent-<resultId>.ndjson` log naming. Replaced `updated_at`-based polling with `run_events.id` high-water mark (no schema migration). Fixed wireframe event names and log filenames.
- **P0.4**: Added token-based security model — random token generated at startup, required for all HTTP/WS access, printed to terminal only. Token written to `.5x/dashboard-token`. Origin validation for localhost binding. Documented data exposure risks for NDJSON logs.

**P1 items resolved:**
- **P1.1**: Hardened file watching with periodic rescan (5s) as fallback for unreliable `fs.watch()` across platforms.
- **P1.2**: Defined "plans shown" as DB-only (`plans` table rows) — no filesystem scanning.
- **P1.3**: Dashboard settings are CLI flags only — no config file section, avoiding `FiveXConfigSchema` changes.

**P2 items resolved:**
- Added protocol versioning (`v: 1` field on all WS messages, `protocolVersion` in snapshot).
- Specified log viewer virtualization (10K line cap per file, "Load earlier" for history).
- Added TUI vs. Dashboard workflow table documenting expected usage patterns and gate control ownership.
