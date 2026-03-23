# 5x Dashboard — Live Web Command Center

**Implementation plan**: [development/026-impl-dashboard.md](development/026-impl-dashboard.md)

---

## Overview

The 5x Dashboard is a real-time web interface served by `5x dashboard` on port 55555. It synthesizes the `.5x` data directory — SQLite database (`plans`, `runs`, `steps` tables), NDJSON agent logs, and quality gate output — into a live command center for monitoring 5x automation runs.

The dashboard is a standalone read-only process, independent of `5x run` or any other CLI command. It reads the same `.5x/5x.db` database and log files that the CLI writes to, and presents a multi-plan overview with drill-down into individual runs, step timelines, and agent sessions. The dashboard never writes to the database or modifies `.5x/` artifacts (except its own session token file).

### Design Goals

| Goal | Description |
|------|-------------|
| **Information density** | Every pixel earns its keep. Dense telemetry grids, multi-panel layouts, no wasted whitespace. |
| **Liveness** | Active processes pulse. Logs stream. Step arrivals animate. The dashboard feels alive when work is happening and calm when idle. |
| **Zero build step** | Vanilla HTML/CSS/JS served as static files from Bun's HTTP server. No npm dependencies, no bundler, no node_modules. |
| **Read-only** | Dashboard observes; CLI commands mutate. No write paths to the database or `.5x/` directory from the dashboard process. |
| **Standalone** | Works before, during, and after runs. Historical data is always browsable. |

### Scope

**In scope:**
- `5x dashboard` CLI command with Bun HTTP server on configurable port (default 55555)
- WebSocket transport for real-time data push
- Multi-plan overview with drill-down navigation
- Step timeline with phase grouping and live updates
- Streaming log viewer with ANSI color rendering and backfill
- Historical run browsing and comparison
- Cost/token analytics
- Quality gate pass/fail status display
- Browser localStorage for layout preferences
- Configurable network binding (localhost default, `--host` for all interfaces)
- Token-based authentication

**Out of scope:**
- Interactive gate control from the browser — agents interact with humans through the TUI (opencode), not the dashboard. A future plan may introduce dashboard→agent signaling.
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
| Step arrival | Panel border flash amber → fade | 400ms | ease-out |
| Log line arrival | Fade in from left + slight slide | 150ms | ease-out |
| Metric counter change | Number rolls up/down (CSS counter or JS) | 300ms | ease-out |
| Phase completion | Brief green flash on phase indicator | 600ms | ease-out |
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
 │  │  │ (WAL,   │  │ (fs.watch │  │  │
 │  │  │ r/o)    │  │  + rescan)│  │  │
 │  │  └────┬────┘  └─────┬─────┘  │  │
 │  │       │              │        │  │
 │  │  ┌────┴──────────────┴─────┐  │  │
 │  │  │   Step Poller (2s)      │  │  │
 │  │  │   + Log Aggregator      │  │  │
 │  │  └─────────────────────────┘  │  │
 │  └───────────────────────────────┘  │
 └──────────────┬──────────────────────┘
                │ reads (never writes)
 ┌──────────────┴──────────────────────┐
 │            .5x/                     │
 │  ┌─────────┐  ┌──────────────────┐  │
 │  │ 5x.db   │  │ logs/            │  │
 │  │ (SQLite) │  │  <run-id>/      │  │
 │  │ v4 WAL  │  │   agent-*.ndjson │  │
 │  └─────────┘  └──────────────────┘  │
 │  ┌─────────────────────────────────┐│
 │  │ dashboard-token.<port>.json     ││
 │  └─────────────────────────────────┘│
 └─────────────────────────────────────┘

 ┌─────────────────────────────────────┐
 │  Browser (localhost:55555)          │
 │                                     │
 │  ┌────────────────────────────┐     │
 │  │ WebSocket Client           │     │
 │  │  - Snapshot on connect     │     │
 │  │  - Incremental updates     │     │
 │  │  - Log subscriptions       │     │
 │  └─────────────┬──────────────┘     │
 │                │                    │
 │  ┌─────────────┴──────────────┐     │
 │  │ View Layer (vanilla JS)    │     │
 │  │  - Reactive store          │     │
 │  │  - Component modules       │     │
 │  │  - Direct DOM rendering    │     │
 │  └────────────────────────────┘     │
 └─────────────────────────────────────┘
```

### Server Component

The `5x dashboard` command starts a Bun HTTP server that serves static files and upgrades connections to WebSocket for real-time data.

**Static file serving**: HTML, CSS, and JS files are embedded in the CLI binary (imported as text modules) for production use. A hidden `--dev` flag falls back to filesystem reads from `src/dashboard/static/` for rapid iteration.

**Database access**: Opens `.5x/5x.db` via `openDbReadOnly()` (`src/db/connection.ts`) in WAL mode. The dashboard never writes to the database. Read reliability is handled by the existing `busy_timeout=5000` pragma.

**Control-plane resolution**: The dashboard resolves the canonical `.5x/` location via `resolveControlPlaneRoot()` (`src/commands/control-plane.ts`), handling managed/isolated/none modes and linked worktrees. This ensures correct DB discovery when running from any checkout directory.

**Log file watching**: Uses `fs.watch()` combined with periodic rescan (every 5s) on `.5x/logs/` to detect new and updated NDJSON log files. The rescan ensures reliability across platforms where `fs.watch()` may miss events.

**Lifecycle**: The server runs until SIGINT (Ctrl+C) or SIGTERM. Command-owned signal handlers stop accepting connections, close watchers, and exit. No browser auto-open.

### WebSocket Protocol

Bidirectional JSON messages over a single WebSocket connection per browser tab. All messages include a `v` field for protocol versioning.

#### Server → Client Messages

```
{v: 1, type: "snapshot", data: {status, plans, runs, activeRunIds, protocolVersion}}
  Full state snapshot on connect and on request.snapshot

{v: 1, type: "steps.new", data: {runId, steps: [...]}}
  New steps recorded for a run (from polling loop)

{v: 1, type: "run.update", data: {runId, status, updatedAt}}
  Run status change (inferred from terminal steps: run:complete, run:abort)

{v: 1, type: "log.lines", data: {runId, file, lines: [...]}}
  New NDJSON log lines from agent session (for subscribed runs)

{v: 1, type: "error", data: {code, message}}
  Server-side error notification
```

#### Client → Server Messages

```
{v: 1, type: "request.snapshot"}
  Request a full state refresh

{v: 1, type: "subscribe.logs", data: {runId}}
  Subscribe to log streaming for a specific run

{v: 1, type: "unsubscribe.logs", data: {runId}}
  Stop log streaming for a run
```

### Protocol Versioning

The server includes `protocolVersion: 1` in the `snapshot` message. The client checks this on connect and displays a "dashboard out of date — reload" warning if the server version exceeds its known version.

---

## Data Model Reference

The dashboard reads the v1 schema (migration v4). All table definitions are in `src/db/schema.ts`. Row types and operations are in `src/db/operations.ts` and `src/db/operations-v1.ts`.

### Source of Truth: Database Tables

| Table | Dashboard Use | Key Columns |
|-------|--------------|-------------|
| `plans` | Plan list, worktree info | `plan_path` (PK), `worktree_path`, `branch`, `created_at`, `updated_at` |
| `runs` | Run list, active state | `id` (PK), `plan_path`, `status`, `config_json`, `created_at`, `updated_at` |
| `steps` | Step timeline, metrics, events | `id` (autoincrement), `run_id`, `step_name`, `phase`, `iteration`, `result_json`, `session_id`, `model`, `tokens_in`, `tokens_out`, `cost_usd`, `duration_ms`, `log_path`, `created_at` |

### Run Statuses

`runs.status` values: `active`, `completed`, `aborted`

Dashboard display mapping:

| DB Status | Display | Icon | Color |
|-----------|---------|------|-------|
| `active` | ACTIVE | `◉` (pulsing) | `--amber-400` |
| `completed` | COMPLETE | `✓` | `--status-success` |
| `aborted` | ABORTED | `✗` | `--status-error` |

### Step Name Conventions

The `steps.step_name` column encodes the step type. The dashboard parses these to categorize and display steps:

| Pattern | Description | Key `result_json` fields |
|---------|-------------|--------------------------|
| `author:<template>` | Author agent invocation | `result` (`complete`/`needs_human`/`failed`), `summary` |
| `reviewer:<template>` | Reviewer agent invocation | `readiness` (`ready`/`not_ready`), `items[]` |
| `quality:check` | Quality gate execution | `passed`, `results[]` (per-command pass/fail/output) |
| `phase:complete` | Phase marked complete | `phase`, phase metadata |
| `run:complete` | Run completed successfully | Terminal step |
| `run:abort` | Run aborted | Terminal step, may include `reason` |
| `run:reopen` | Run reopened from terminal state | Lifecycle step |
| `human:*` | Human interaction recorded | Context-dependent |
| `git:commit` | Git commit recorded | `sha`, `message`, `files_changed` |

### Agent Log Filenames

Agent logs are stored as `.5x/logs/<run-id>/agent-NNN.ndjson` where `NNN` is a sequential number. The `steps.log_path` column stores the path for each step that involved an agent invocation. The first line of each log file is a `session_start` metadata entry with `role`, `template`, `run`, and `phase_number`.

To map a log file to its agent invocation context, read the `session_start` line or join on `steps.log_path`.

### Derived Views

The dashboard computes these derived values from raw DB data:

| View | Source | Computation |
|------|--------|-------------|
| Run status | `runs.status` | Direct read |
| Latest step | `steps` | `MAX(id) WHERE run_id = ?` |
| Phases completed | `steps` | Count `step_name = 'phase:complete'` per run |
| Phase in progress | `steps` | Latest step's `phase` value for active runs |
| Cost per run | `steps` | `SUM(cost_usd) WHERE run_id = ?` |
| Tokens per run | `steps` | `SUM(tokens_in)`, `SUM(tokens_out)` |
| Cost per plan | `steps` JOIN `runs` | Aggregate across all runs for a plan |
| Quality pass rate | `steps` | Count `step_name = 'quality:check'` where `result_json.passed = true` |
| Review iterations | `steps` | Count `step_name LIKE 'reviewer:%'` per phase |

### Polling Strategy

Poll using the monotonically increasing `steps.id` as the high-water mark:

```
SELECT * FROM steps WHERE id > :lastSeenId ORDER BY id ASC LIMIT 200
```

New steps are grouped by `run_id` and broadcast as `steps.new` messages. Run status changes are inferred from terminal step names (`run:complete`, `run:abort`) and broadcast as `run.update` messages.

**Active runs**: Re-query `runs WHERE status = 'active'` on each poll cycle to detect status changes from external CLI commands.

**Why polling, not triggers**: SQLite doesn't support cross-process change notifications. WAL mode allows concurrent reads while CLI commands write. Polling at 2s is cheap (indexed queries on small tables) and consistent regardless of whether CLI commands are co-located or separate processes.

**No schema migration required.** The existing `steps.id` autoincrement column is the polling cursor.

---

## Page Structure

### Navigation Model

Single-page application with hash-based routing. No page reloads.

```
#/                          Multi-plan overview (landing page)
#/plan/<plan-path>          Plan detail — runs, phase progress, metrics
#/run/<run-id>              Run detail — step timeline, phase grouping
#/run/<run-id>/logs         Log viewer for a specific run
#/analytics                 Cost/token analytics
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
│ ◉ 2 active runs    ○ 3 idle    Steps: 847    Cost: $14.23          │  ← Status bar
└─────────────────────────────────────────────────────────────────────┘
```

**Top bar** (fixed, 48px):
- "5X COMMAND CENTER" branding (amber, all-caps, letter-spaced)
- WebSocket connection indicator (cyan dot = connected, blinking = reconnecting, red = disconnected)
- Plan tabs for quick switching between active plans
- Settings gear (localStorage prefs: scanline toggle, animation speed)

**Status bar** (fixed, 36px):
- Active/idle run count
- Total steps recorded
- Aggregate cost

### Page: Multi-Plan Overview (`#/`)

The landing page. Shows all known plans with their current state.

```
┌─────────────────────────────────────────────────────────────────────┐
│ PLANS                                                        ⟳ 2s  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ 026-impl-dashboard ──────────────────────────────────────────┐  │
│  │ STATUS: ◉ ACTIVE   Phase 3   Steps: 47                       │  │
│  │                                                               │  │
│  │ Run: a1b2c3d4   Started: 14:23   Duration: 12m 34s           │  │
│  │ Cost: $0.47     Tokens: 124K in / 18K out                    │  │
│  │                                                               │  │
│  │ Phases completed: [1 ✓] [2 ✓] [3 ◉] [4 ○] [5 ○]            │  │
│  │                   done   done  active                         │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ 025-commit-tracking ──────────────────────────────────────────┐  │
│  │ STATUS: ✓ COMPLETE   5/5 phases   Total: 2h 14m               │  │
│  │                                                               │  │
│  │ Last run: f9e8d7c6   Completed: yesterday 16:45              │  │
│  │ Total cost: $2.31   Tokens: 890K in / 156K out               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌─ 024-skills-to-harness ─────────────────────────────────────────┐  │
│  │ STATUS: ✗ ABORTED   Phase 2   Steps: 23                       │  │
│  │                                                               │  │
│  │ Last run: 1a2b3c4d   Aborted: 2 days ago                     │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

Each plan card is clickable → navigates to `#/plan/<path>`. Active plans sort to top with amber border glow. Completed plans have green left border. Aborted plans have red left border.

**Plan discovery**: The dashboard shows plans that exist in the `plans` database table — i.e., plans that have been the target of at least one `5x run` command. It does not scan the filesystem for plan files. Plan paths are canonical (resolved via `canonicalizePlanPath()`).

### Page: Plan Detail (`#/plan/<path>`)

Drill-down into a single plan's lifecycle.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ◂ PLANS   026-impl-dashboard                        ◉ ACTIVE        │
├──────────────────────────────────┬──────────────────────────────────┤
│ PHASE PROGRESS                   │ ACTIVE RUN: a1b2c3d4            │
│                                  │                                  │
│  Phase 1 ████████████████████ ✓  │ Status: ACTIVE                   │
│  Phase 2 ████████████████████ ✓  │ Phase: 3                        │
│  Phase 3 ██████████░░░░░░░░░ ◉  │ Steps: 47                       │
│  Phase 4 ░░░░░░░░░░░░░░░░░░ ○  │ Duration: 12m 34s               │
│  Phase 5 ░░░░░░░░░░░░░░░░░░ ○  │                                  │
│                                  │ ┌─ RECENT STEPS ──────────────┐ │
│ Phases derived from              │ │ 14:35:02 quality:check  P3  │ │
│ phase:complete steps             │ │   passed: true               │ │
│ and step phase column            │ │ 14:34:58 author:impl   P3  │ │
│                                  │ │   result: complete           │ │
│                                  │ │   cost: $0.12                │ │
│                                  │ │ 14:31:18 reviewer:rev  P2  │ │
│                                  │ │   readiness: ready           │ │
│                                  │ │ 14:31:01 phase:complete P2  │ │
│                                  │ │ ...                          │ │
│                                  │ └──────────────────────────────┘ │
├──────────────────────────────────┴──────────────────────────────────┤
│ RUN HISTORY                                                         │
│ ┌──────────┬────────┬───────┬────────┬─────────┬───────────────┐   │
│ │ Run ID   │ Status │ Steps │ Phases │ Cost    │ Started       │   │
│ ├──────────┼────────┼───────┼────────┼─────────┼───────────────┤   │
│ │ a1b2c3d4 │ ◉ act  │ 47    │ 2 done │ $0.47   │ today 14:23   │   │
│ │ 9f8e7d6c │ ✗ abt  │ 12    │ 0 done │ $0.08   │ today 13:55   │   │
│ └──────────┴────────┴───────┴────────┴─────────┴───────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Phase progress**: Derived from `steps` table — count `phase:complete` steps for completed phases, identify current phase from the latest step's `phase` column for active runs.

**Recent steps**: Scrolling list of steps for the active run, grouped and labeled by `step_name` and `phase`. Auto-scrolls to newest; pauses on user scroll-up.

**Run history**: Table of all runs for this plan, clickable to navigate to `#/run/<id>`.

### Page: Run Detail (`#/run/<id>`)

Deep dive into a single run.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ◂ PLAN   RUN a1b2c3d4                    ◉ ACTIVE   12m 34s        │
├──────────────────────────────────┬──────────────────────────────────┤
│ STEP TIMELINE                    │ STEP DETAIL                      │
│                                  │                                  │
│ ┌─ Phase 1 ──────────────────┐   │ ┌────────────────────────────┐  │
│ │  14:23:05 author:impl      │   │ │ quality:check — Phase 3    │  │
│ │    result: complete         │   │ │                            │  │
│ │    tokens: 42K / 8K         │   │ │ Passed: true              │  │
│ │    cost: $0.11              │   │ │ Duration: 4.2s            │  │
│ │  14:25:12 quality:check  ✓ │   │ │                            │  │
│ │  14:25:45 reviewer:rev     │   │ │ Results:                   │  │
│ │    readiness: ready         │   │ │  ✓ bun run build    1.2s  │  │
│ │  14:26:01 phase:complete ✓ │   │ │  ✓ bun run lint     0.8s  │  │
│ └────────────────────────────┘   │ │  ✓ bun run typecheck 2.2s │  │
│                                  │ │                            │  │
│ ┌─ Phase 2 ──────────────────┐   │ │ Output (first 2KB):       │  │
│ │  14:26:03 author:impl      │   │ │ > build completed          │  │
│ │    result: complete         │   │ │ > 0 errors, 0 warnings    │  │
│ │  14:28:44 quality:check  ✓ │   │ │                            │  │
│ │  14:29:01 reviewer:rev     │   │ └────────────────────────────┘  │
│ │    readiness: ready         │   │                                  │
│ │  14:31:01 phase:complete ✓ │   │                                  │
│ └────────────────────────────┘   │                                  │
│                                  │                                  │
│ ┌─ Phase 3 (active) ─────────┐   │ AGENT INVOCATIONS               │
│ │  14:31:18 author:impl      │   │ ┌────────────────────────────┐  │
│ │    result: complete         │   │ │ P3 Author   3m44s  $0.12  │  │
│ │  14:35:02 quality:check  ✓ │   │ │ P2 Reviewer 1m22s  $0.04  │  │
│ │  ◉ waiting for next step   │   │ │ P2 Author   4m11s  $0.15  │  │
│ └────────────────────────────┘   │ │ P1 Reviewer 1m05s  $0.03  │  │
│                                  │ │ P1 Author   2m58s  $0.11  │  │
│                                  │ └────────────────────────────┘  │
│                                  │                                  │
│                                  │  [View Logs]                     │
├──────────────────────────────────┴──────────────────────────────────┤
│ QUALITY GATES                                                       │
│ Phase 1: ✓ build  ✓ lint  ✓ typecheck    Phase 2: ✓ all passed     │
│ Phase 3: ✓ build  ✓ lint  ✓ typecheck                              │
└─────────────────────────────────────────────────────────────────────┘
```

**Step timeline**: Left panel showing all steps grouped by phase, in chronological order. Each step shows `step_name`, key result fields (parsed from `result_json`), cost, and tokens. Click a step to show full detail in the right panel. Active phase has amber border.

**Step detail**: Right panel showing expanded `result_json` for the selected step, formatted by step type (author results, reviewer verdicts, quality gate output with per-command breakdown).

**Agent invocations**: Compact table of all agent steps for this run, filtered from steps where `step_name` starts with `author:` or `reviewer:`, showing role, phase, duration, cost, and log link.

**Quality gates**: Bottom bar showing pass/fail badges per phase, derived from `quality:check` steps. Each badge can be expanded to show per-command results.

### Page: Log Viewer (`#/run/<id>/logs`)

Full-screen streaming log viewer.

```
┌─────────────────────────────────────────────────────────────────────┐
│ ◂ RUN a1b2c3d4   LOGS                    [Search: ________] [⏸ ▶]  │
├────────────────────┬────────────────────────────────────────────────┤
│ LOG FILES          │ agent-003.ndjson                               │
│                    │                                                │
│ ◉ P3 Author       │                                                │
│   agent-003.ndjson │ {"type":"session_start","role":"author",...}   │
│ ○ P2 Reviewer      │ {"type":"event","event":{"type":"assistant.   │
│   agent-002.ndjson │  message.start",...}}                         │
│ ○ P2 Author        │ {"type":"event","event":{"type":"content.     │
│   agent-001.ndjson │  delta","data":{"delta":{"type":"text",...    │
│ ○ P1 Reviewer      │ {"type":"event","event":{"type":"tool_use.    │
│   agent-000.ndjson │  start","data":{"toolName":"Read",...}}       │
│                    │                                                │
│ Labels derived     │ {"type":"event","event":{"type":"tool_use.     │
│ from session_start │  result","data":{"output":"..."}}}            │
│ metadata line      │                                                │
│ (role + phase)     │ {"type":"event","event":{"type":"content.      │
│                    │  delta","data":{"delta":{"type":"text",...     │
│                    │                                                │
│                    │                    ◉ STREAMING — 342 lines     │
│                    │                    ▼ auto-scroll active        │
└────────────────────┴────────────────────────────────────────────────┘
```

**Left panel**: List of log files for the run, derived from `steps` rows with non-null `log_path`. Labeled with phase + role by reading the `session_start` metadata line. Active log (being appended to) gets a pulsing indicator. Click to switch.

**Right panel**: NDJSON log content rendered with:
- ANSI color code rendering for embedded terminal output
- Line numbers
- Search highlighting (Ctrl+F or search box)
- Auto-scroll when at bottom; pauses when user scrolls up; "Jump to bottom" button appears
- Click a line to copy its content

**Streaming**: When viewing an active log, new lines appear in real-time via WebSocket `log.lines` messages. A "STREAMING" indicator with line count is shown at the bottom.

**Memory management**: Virtualized list capped at 10,000 lines per file in memory. Older lines are discarded from the front. A "Load earlier" button triggers an HTTP GET to the backfill endpoint for historical lines.

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
│ │ 026-impl-dashboard       │ 2      │ 2 done   │ $0.55  │ 166K    │ │
│ │ 025-commit-tracking      │ 1      │ 5 done   │ $2.31  │ 890K    │ │
│ │ 024-skills-to-harness    │ 3      │ 2 done   │ $4.12  │ 520K    │ │
│ │ 023-skill-improvements   │ 2      │ 5 done   │ $5.89  │ 1.2M    │ │
│ └──────────────────────────┴────────┴──────────┴────────┴─────────┘ │
│                                                                     │
│ COST BY ROLE                                                        │
│ Author:   $10.45 (73%)  ████████████████████████░░░░░░░░░          │
│ Reviewer: $3.78  (27%)  ████████░░░░░░░░░░░░░░░░░░░░░░░           │
└─────────────────────────────────────────────────────────────────────┘
```

Charts are rendered with SVG (no charting library). Simple bar charts and horizontal progress bars. Data aggregated from `steps` table where `step_name` matches `author:*` or `reviewer:*`.

---

## Data Flow

### Database Polling

The dashboard polls the SQLite database on a 2-second interval:

- **Steps**: `SELECT * FROM steps WHERE id > :lastSeenId ORDER BY id ASC LIMIT 200` — monotonically increasing ID, no schema change needed
- **Active runs**: Re-query `runs WHERE status = 'active'` and diff against in-memory state for status changes

Changes are diffed against in-memory state and broadcast as targeted WebSocket messages to connected clients.

**Why polling, not triggers**: SQLite doesn't support cross-process change notifications. WAL mode allows concurrent reads while CLI commands write. Polling at 2s is cheap (indexed queries on small tables) and provides consistent behavior regardless of process topology.

**No schema migration required.** The existing `steps.id` autoincrement column serves as the polling cursor.

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
- Each log file gets a tracked read offset. On change (watch or rescan), the server reads from the last offset to EOF, splits on newlines, sends each complete line as a `log.lines` WebSocket message
- Uses the same pattern as the existing `NdjsonTailer` in `src/utils/ndjson-tailer.ts` (64KB read chunks, 1MB partial-line buffer cap)

### State Snapshot

On WebSocket connect (and on `request.snapshot`), the server sends a full `snapshot` message containing:
- All plans (from `plans` table)
- All runs (from `runs` table) with computed summaries
- Active run IDs
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
```

Hidden: `--dev` (serve static files from filesystem instead of embedded).

**Startup sequence**:
1. Resolve control-plane root (same logic as other 5x commands, via `resolveControlPlaneRoot()`)
2. Open database in read-only WAL mode via `openDbReadOnly()`
3. Generate session token, write to `.5x/dashboard-token.<port>.json`
4. Start log file watcher on `.5x/logs/`
5. Start HTTP server on configured host:port
6. Print startup banner:

```
  5X COMMAND CENTER
  ─────────────────
  URL:   http://127.0.0.1:55555?token=a3f8...c7d8
  Token: a3f8b2c1d4e5...d8e9f0a1
  DB:    .5x/5x.db (14 runs, 3 active plans)
  Logs:  .5x/logs/ (watching)

  Press Ctrl+C to stop.
```

**Fresh project**: If `.5x/` or `.5x/5x.db` is absent, the server still starts and serves the app shell. The snapshot payload returns `status: "no_project"` and the UI displays a clear "awaiting first run" state.

**Shutdown**: SIGINT/SIGTERM triggers graceful shutdown — stop accepting connections, close WebSocket connections, stop log watcher, close database, clean up token file, exit.

### Config

Dashboard settings are **CLI flags only** — no config file section. This avoids modifying `FiveXConfigSchema` in `src/config.ts` and the unknown-key warning allowlist. Dashboard is a development-time tool; persisting host/port preferences in the project config has no value since they're machine-specific.

```
5x dashboard                         # localhost:55555 (defaults)
5x dashboard --port 8080             # localhost:8080
5x dashboard --host 0.0.0.0         # all interfaces:55555
```

---

## File Organization

All dashboard source lives within the `5x-cli` package:

```
5x-cli/src/
  commands/
    dashboard.ts              CLI command definition (Commander adapter)
    dashboard.handler.ts      Handler: control-plane resolution, server startup
  dashboard/
    server.ts                 Bun HTTP server + WebSocket setup
    routes.ts                 Static file serving + API routes
    ws-protocol.ts            WebSocket message types and validation
    data.ts                   Database snapshot/polling/diff layer
    poller.ts                 Polling loop: step cursor, diff, WS broadcast
    log-watcher.ts            Log file watching + streaming
    static/
      index.html              Single HTML entry point
      style.css               All styles (mission-control design tokens)
      app.js                  Main application module
      components/
        top-bar.js            Top navigation bar
        status-bar.js         Bottom status bar
        overview.js           Multi-plan landing page
        plan-detail.js        Plan drill-down
        run-detail.js         Step timeline + phase grouping
        log-viewer.js         Streaming log viewer
        analytics.js          Cost/token charts
      lib/
        ws-client.js          WebSocket client with reconnect
        router.js             Hash-based SPA router
        store.js              Reactive state management
        format.js             Number/date/duration formatters
        ansi.js               ANSI escape code → HTML converter
```

Static files are embedded into the compiled binary using text module imports for production. The `--dev` flag serves from the filesystem for rapid iteration.

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
- Automatic snapshot request on reconnect to resync state
- Connection state reflected in top bar indicator

---

## Implementation Considerations

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

**Threat model**: The `.5x/` directory contains NDJSON agent logs that may include file contents, environment variables, or other sensitive data from the project. The security model must prevent unauthorized access to this data.

**Token authentication**: On startup, `5x dashboard` generates a cryptographically random token (32 bytes, hex-encoded) and prints it to the local terminal alongside the URL:

```
  5X COMMAND CENTER
  ─────────────────
  URL:   http://127.0.0.1:55555?token=a3f8...
  Token: a3f8b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1
  DB:    .5x/5x.db (14 runs, 3 active plans)
```

The token is also written to `.5x/dashboard-token.<port>.json` (mode 0600) so that future integrations can read it.

**Token enforcement**:
- **Bootstrap**: Initial HTML page load at `/?token=...` validates the token and sets `Set-Cookie: dashboard_token=<token>; HttpOnly; SameSite=Strict; Path=/`.
- **HTTP requests**: Subsequent requests (static assets, API endpoints) accept the cookie or query token. Requests without a valid token receive `401 Unauthorized`.
- **WebSocket upgrade**: Token required via cookie or query parameter during the upgrade handshake. Connections without a valid token are rejected with `401`.

**Network binding**:
- Default: `127.0.0.1` (localhost only)
- `--host 0.0.0.0`: Binds to all interfaces with a loud warning:

```
  WARNING: Dashboard bound to 0.0.0.0 — accessible from the network.
  All access is gated by the session token. Do not share the URL.
```

- **Origin validation**: When bound to localhost, WebSocket upgrade requests are validated against `Origin: http://localhost:*` or `http://127.0.0.1:*`. When bound to all interfaces, origin validation is relaxed (token is the primary gate).

**Data exposure**: NDJSON agent logs may contain project file contents, environment variables, and other sensitive context. This is the same data accessible via `cat .5x/logs/*` on the local filesystem — the dashboard does not increase the attack surface for localhost users, but non-localhost binding exposes it over the network (hence the token requirement).

**Token transport caveat**: The bootstrap URL includes the token as a query parameter, which is visible in browser history and potentially in Referer headers. This is accepted as a trade-off for a local development tool. The cookie-based auth for subsequent requests minimizes exposure after the initial bootstrap.

---

## Design Decisions (Resolved)

1. **Co-location vs. separate process**: Standalone `5x dashboard` only. The dashboard reads `.5x/` artifacts via filesystem and DB — no IPC needed. A future `5x run --dashboard` flag could embed the dashboard, but the file-based interface would remain the same.

2. **Multi-tab coordination**: No tab-to-tab coordination. Each browser tab gets its own WebSocket connection. Server broadcasts identically to all authenticated connections. Simple and correct.

3. **Log file size limits**: The server streams only new lines to the client (not full history). The client uses a virtualized list for display and caps in-memory lines at **10,000 per log file**. Older lines are discarded from the front. A "Load earlier" button triggers an HTTP GET to the backfill endpoint with byte-range offsets. This bounds browser memory while keeping the common case (watching a live log) fast.

4. **Embedded vs. external static files**: Production builds embed static files in the binary via text module imports. A hidden `--dev` flag serves from the filesystem (`src/dashboard/static/`) for rapid iteration.

5. **Read-only vs. interactive**: The dashboard is strictly read-only in v1. No database writes, no gate responses, no agent signaling. This eliminates race conditions with CLI command writers and keeps the CLI as the single source of orchestration truth. Interactive features (gate bridge, agent signaling) are deferred to a future plan.

---

## See Also

- [development/026-impl-dashboard.md](development/026-impl-dashboard.md) — Implementation plan (v1 architecture)
- [development/006-impl-dashboard.md](development/006-impl-dashboard.md) — Original implementation plan (v0, superseded)
- [src/db/schema.ts](../src/db/schema.ts) — Database schema (v4 migration)
- [src/db/operations-v1.ts](../src/db/operations-v1.ts) — v1 step operations
- [src/db/connection.ts](../src/db/connection.ts) — `openDbReadOnly()` and connection management
- [src/commands/control-plane.ts](../src/commands/control-plane.ts) — Control-plane root resolution
- [src/utils/ndjson-tailer.ts](../src/utils/ndjson-tailer.ts) — NDJSON tailing pattern (reference for log watcher)

---

## Revision History

### v2.0 (March 22, 2026) — Rewrite for v1 architecture

Supersedes v1.1. Complete rewrite to align with the v1 architecture migration (`007-impl-v1-architecture.md`):

- **Data model**: Replaced references to deleted tables (`run_events`, `agent_results`, `quality_results`, `phase_progress`) with unified `steps` table. Updated all derived views, polling strategy, and WS protocol messages.
- **Gate bridge removed**: Deleted gate bridge protocol, gate file format, gate modals, `gate-responder.ts`, and `--no-gate-bridge` flag. Dashboard is now strictly read-only. Interactive gate control deferred to future work.
- **Orchestrator references removed**: Deleted references to `phase-execution-loop.ts`, `plan-review-loop.ts`, `gates/human.ts`, and orchestrator state machine visualization. These files no longer exist in v1.
- **Run detail page**: Replaced state machine diagram with step timeline grouped by phase. Removed orchestrator state visualization.
- **WS protocol simplified**: Replaced per-table message types (`event`, `agent.result`, `quality.result`, `phase.progress`, `gate.request`, `gate.resolved`) with steps-centric messages (`steps.new`, `run.update`).
- **Polling simplified**: `steps.id` autoincrement cursor replaces the multi-table `rowid` tracking strategy.
- **File organization updated**: Added `dashboard.handler.ts` (per current handler convention), `poller.ts`. Removed `gate-responder.ts`.
- **See Also links**: Updated to reference existing files.

### v1.1 (February 26, 2026) — Review corrections

**Review**: [development/reviews/2026-02-26-10-dashboard-design-review.md](development/reviews/2026-02-26-10-dashboard-design-review.md)

- Added unified gate mechanism, TUI coexistence matrix, data model reference, security model, protocol versioning, log viewer virtualization, and user workflow table.

### v1.0 (February 26, 2026) — Initial design

- Created dashboard design specification with aesthetic direction, architecture, page wireframes, and implementation considerations.
