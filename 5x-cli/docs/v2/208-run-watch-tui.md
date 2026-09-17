# 5x CLI v2 — TUI Run Watcher

**Status:** Draft — Not Implemented
**Date:** September 17, 2026
**Related:** `200-overview.md` (operator experience), `202-control-plane.md` (control surface), `205-output-normalization.md` (streaming output contract), `207-state-segmentation.md` (telemetry tier)
**Builds on:** Existing `5x run watch`, normalized provider events, and NDJSON invocation logs
**Breaking:** No — opt-in presentation mode with additive event metadata

---

## 1. Problem

Today, `5x run watch --human-readable` is useful for getting a general sense of an author or reviewer invocation, but its scrolling output is dominated by tool calls. Useful agent prose quickly disappears beneath repeated reads, edits, and searches. Long absolute worktree paths consume space without helping the operator understand what is happening.

A common setup puts the orchestrator in a large upper terminal pane and the watcher in a shallow lower pane. The operator occasionally maximizes the watcher for closer inspection. Both uses need a view that answers:

1. What is the agent trying to do, according to its latest message?
2. What is it doing now, and where in the workspace?
3. What has happened recently?
4. Is the stream active, quiet, complete, or reporting errors?

The proposed `5x run watch --tui` mode presents a stateful, animated view of the run. Important information stays in predictable places while new events update the surrounding activity.

## 2. Design principles

- **Compact first.** The shallow split pane is a primary use case. Layout responds to both terminal height and width.
- **Narrative stays visible.** Tool traffic must not immediately push the latest agent prose off screen.
- **Animation conveys activity.** Pulses, fading highlights, and timers make real events legible; they do not imply progress the system cannot measure.
- **Details are available on demand.** The default view summarizes activity; selection and expansion expose event details.
- **Observed facts remain distinct from inference.** A successful edit call is not proof of a net Git diff. A quiet stream is not proof that an invocation is hung.
- **Provider-neutral core.** The view consumes normalized events and tolerates missing metadata, older logs, and unfamiliar tools.
- **Read-only monitoring.** The watcher observes invocations. Leaving the UI does not interrupt their execution.

## 3. Operator experience

### 3.1 Command surface

```sh
5x run watch --tui                         # resolve the ambient run
5x run watch --run <id> --tui               # select an explicit run
5x run watch --tui --show-reasoning         # include provider reasoning events
5x run watch --tui --tail-only              # observe new activity only
```

`--tui` is an explicit output mode alongside raw NDJSON and `--human-readable`. Supplying both `--tui` and `--human-readable` is an argument error. Existing run resolution, `--workdir`, and polling behavior remain shared with the watcher.

The TUI requires an interactive terminal for input and output. If unavailable, fail before entering the UI with a diagnostic pointing to the existing stream modes. Do not silently substitute another format. Global output-format defaults do not override an explicitly selected watch mode; `run watch` remains a documented streaming-output exception.

### 3.2 Compact layout

Illustrative layout; labels, dimensions, and key bindings are provisional:

```text
 AUTHOR · phase 1 · GPT-5.6                    2m 39s · last event 1s ago
 ─────────────────────────────────────────────────────────────────────
 “I’m updating the outbox worker to carry the role-separation fields
  through delivery, then checking the environment contract.”

 ⠋ EDIT  src/workers/outbox-worker.ts                              0.8s

 RECENT ACTIVITY                          FILE ACTIVITY
 ✓ read  src/workers/outbox-worker.ts     outbox-worker.ts   R ▂▅█ E ▃█
 ✓ grep  "optionalLogging" · src/         env-contract.ts    R ▃  E ▅
 ! edit  src/workers/env-contract.ts      outbox.test.ts     R ▂

 18 reads · 7 edits · 4 searches · 1 error          tab view · space pause
```

Four layers establish the information hierarchy:

| Layer | Contents | Behavior |
|---|---|---|
| Context | Role, phase, model, invocation elapsed time, last-event age | Stable header; unavailable fields are omitted or marked unknown |
| Narrative | Latest agent prose | Streams in place and remains visible through subsequent tool activity |
| Now | Active tools, targets, elapsed times | Multiple active calls remain independently visible or have an overflow count |
| Recent activity | Compact event history and file activity | Repeated operations can be grouped; individual events remain inspectable |

When space is constrained, preserve context, a bounded narrative excerpt, and active tools first. Collapse file activity and counters before sacrificing those elements. A very short pane uses a minimal status-and-activity layout. A narrow pane stacks sections or exposes them as switchable views.

Long paths are displayed relative to the invocation's workspace when known. Outside-workspace paths retain enough context to distinguish them. Truncation preserves the filename and useful parent components; the inspector retains the full path. The observer's current directory must not be assumed to be the agent's workspace.

### 3.3 Expanded layout

Additional terminal space reveals three areas:

| Area | Purpose |
|---|---|
| Narrative and timeline | Streaming prose and compact tool records, with browsing of earlier messages and invocations |
| File activity | A directory-oriented view of observed reads, searches, and edit operations |
| Inspector | Selected event's command, targets, search scope, output, error, and patch information where available |

The latest prose remains easy to locate even while browsing the timeline. Expanded prose supports basic terminal-friendly Markdown rendering. Large tool results are collapsed by default and bounded in the visible inspector.

Resizing preserves selection, scroll position where practical, and follow/pause state. Layout changes do not reset collection or reconstruct the run from scratch.

### 3.4 Activity visualization

- File rows briefly highlight on reads or edits, then fade toward their resting appearance.
- Active tools show a spinner and elapsed time; matched completion changes the indicator to success or error.
- Small activity strips show recent event frequency by category: read, edit, search, command, and other. They are activity histories, not completion percentages.
- Author/reviewer and phase transitions visibly update the invocation context.
- Last-event age makes quiet periods explicit without declaring the invocation stalled.
- File rows have stable placement during live updates. Constant recency re-sorting would make the view difficult to follow.

Color reinforces labels and symbols rather than carrying meaning alone. Provide a reduced-motion mode and a usable low-color presentation. Exact controls and theme choices are implementation decisions.

### 3.5 Interaction

The first version needs a small keyboard surface:

| Action | Behavior |
|---|---|
| Pause / resume follow | Freeze the viewport while event collection continues; resume returns to current activity |
| Navigate | Move through retained events, files, and invocations |
| Expand / inspect | Show details for the selected item |
| Switch view / focus | Reach sections collapsed by the current terminal dimensions |
| Toggle reasoning | Show or hide provider-emitted reasoning, initially controlled by `--show-reasoning` |
| Help | Show available bindings and display modes |
| Quit (`q` or Ctrl-C) | Detach the watcher and restore the terminal; leave the invocation running |

Scrolling away from the live edge suspends automatic scrolling. A visible indicator reports newer activity while the operator inspects history. Pausing does not pause the provider, file tailer, or run.

### 3.6 Invocation and error semantics

The watcher follows the run across successive author/reviewer invocations and waits for new logs between them. An invocation's `done` event does not mean the overall run is complete. Keep the final invocation summary available rather than immediately clearing the screen.

When invocations overlap, maintain independent state and show an active-invocation count or selector. Prose, tools, counters, and file activity must remain attributable to their source invocation. Browsing an older invocation should not be interrupted by a newly discovered one.

Tool errors stay discoverable in the timeline and error count after the active row changes. A failed edit is a tool outcome, not automatically a failed invocation. A later successful call does not erase the earlier error or prove that it was semantically recovered.

Use precise states such as `waiting for events`, `tool active`, `last event 24s ago`, and `invocation complete`. Log silence alone cannot distinguish model processing, provider delay, a blocked tool, or a dead process. Authoritative run or invocation status may be displayed when available through existing read interfaces, separately from observed log activity.

## 4. Existing foundation and data gaps

### 4.1 Reusable implementation

| Component | Existing capability |
|---|---|
| `src/commands/run-v1.ts` | `watch` command and output-mode options |
| `src/commands/run-v1.handler.ts` | Run/context resolution, watcher lifecycle, NDJSON and human-readable consumers |
| `src/utils/ndjson-tailer.ts` | Discovery and concurrent tailing of `agent-*.ndjson`, using filesystem notifications with polling fallback |
| `src/providers/log-writer.ts` | Timestamped normalized events and per-file `session_start` metadata |
| `src/providers/types.ts` | Text, reasoning, tool start/end, error, usage, and completion event contract |
| `src/providers/event-mapper.ts` | OpenCode event normalization and tool-input summarization |

Invocation metadata already includes role, template, run, and optional phase, provider, and model. This is enough for a useful initial context header. Text deltas and tool summaries support basic narrative and timeline views without a new transport.

### 4.2 Event enrichment

The current `AgentEvent` tool-start shape has `tool` and `input_summary`; tool-end has `tool`, `output`, and an optional error flag. Neither carries a tool-call ID. Matching concurrent calls to the same tool is therefore ambiguous.

Input summarization also loses useful structure. For example, the OpenCode mapper preserves a grep pattern but drops the search scope. File-read summaries omit line ranges, and edit summaries do not preserve patches.

Proposed additive metadata:

| Metadata | Purpose |
|---|---|
| Tool-call ID on start and end | Reliably correlate overlapping calls within an invocation |
| Structured tool target information | Preserve paths, search pattern/scope, read ranges, and command/cwd where known |
| Effective workspace in invocation metadata | Resolve relative targets and shorten worktree paths correctly |
| Message/block identity and boundaries | Group prose and reasoning deltas without conflating separate messages |
| Optional change summaries or patches | Enrich edit inspection when the provider supplies meaningful change data |

Exact field names and shapes need a provider-contract review before implementation. Keep existing summary fields as display fallbacks, and make new fields optional so older logs and external provider plugins remain usable. Normalize metadata at the provider boundary; renderer code should not parse provider-native payloads.

For legacy events, infer targets only when unambiguous. Without call IDs, do not claim precise per-call duration or completion matching for overlapping same-name tools. Prefer an explicitly uncertain tool summary to a misleading animation. Unknown tools retain their names and available summaries and render under an `other` category.

### 4.3 Boundaries of observation

- A read target is not necessarily a successfully read file until an attributable result is available.
- A search scope is not a list of files read. Do not light up every file beneath the searched directory.
- An edit operation is not a verified net working-tree change. File panels report observed operations, not Git status.
- Arbitrary shell commands may read or modify files without structured target events. Their file effects remain unknown unless independently reported.
- Token usage and cost are displayed only when reported, with freshness and scope preserved. Do not add a final total to the same usage already counted from earlier updates.
- Provider prose is displayed as supplied; the watcher does not generate an additional model-written narrative or infer a percentage complete.

## 5. Architecture

```text
NDJSON logs
    │
    ▼
NdjsonTailer / replay-aware event source
    │
    ▼
Normalization and compatibility handling
    │
    ▼
Watch state reducer ──────► compact / expanded TUI renderer
    ▲                                  ▲
    │                                  │
Optional read-only run metadata    keyboard, resize, render clock
```

The reducer owns invocation identity, prose blocks, active calls, recent history, file activity, and counters. Rendering consumes that state and terminal dimensions. Animation uses a separate clock so a provider event burst does not trigger one screen redraw per event.

Log source identity scopes tool and message IDs. Preserve order within each source; the current tailer does not establish a globally causal order across files. Cross-invocation timeline ordering must be deterministic without implying stronger ordering guarantees than timestamps and per-source order provide.

Prefer a small watch-specific module boundary rather than embedding state management and drawing in `run-v1.handler.ts`. The existing stream modes and TUI can share event parsing where useful. This document leaves the terminal library selection open; evaluate Bun compatibility, compiled distribution, resize behavior, text layout, input handling, and maintenance cost before choosing one.

### 5.1 Attach, replay, and follow

Default attach reconstructs existing state before following new activity. Historical events populate the timeline and file summaries without playing their animations as if they were happening now. Show a catching-up state when reconstruction is noticeable.

The current tailer yields source-tagged entries but no replay/live boundary. The event-source layer needs an explicit per-file attach watermark or equivalent mechanism. Events already present at attach are historical; subsequent appends and newly created invocation logs are live. Reading must continue across this boundary without gaps or duplicates.

With `--tail-only`, skip historical activity and label the view as partial history. The watcher may read invocation-header metadata for context without replaying prior tool or prose events. Counts then describe activity observed since attachment; pre-existing active calls and missing starts remain unknown.

Bound retained event history, prose, tool output, and file-detail state. Aggregate counters may outlive detailed history, with the retention boundary visible when browsing. A paused viewport must not cause an unbounded event queue. Large backlogs should yield between batches so input and resize remain responsive; exact limits are to be established during implementation.

### 5.2 Terminal lifecycle

Enter the alternate screen and interactive input mode only after argument/context validation. Restore terminal state on quit, signals, and rendering or streaming errors. Pre-UI errors use the normal command error contract; fatal errors after UI entry restore the terminal before writing a diagnostic and returning a failing exit status.

Render log content as text rather than executing embedded terminal control sequences. Display widths and truncation must handle Unicode correctly. Redraw work should be bounded and coalesced, and idle rendering should remain inexpensive.

## 6. First-release scope

The recommended first release includes:

1. `--tui` command integration with existing run resolution and log following.
2. Responsive compact and expanded layouts centered on latest prose, active tools, and file activity.
3. Correlated tool lifecycle and structured targets for supported providers, with legacy fallbacks.
4. Grouped recent activity, basic file list/tree presentation, and subtle pulse/fade animation.
5. Event/error inspection and invocation history.
6. Pause, scroll, resume-follow, resize handling, and reliable terminal cleanup.
7. Replay-aware attachment and bounded long-session state.

Full patch/diff browsing, recorded-session playback controls, sophisticated visualizations, and persistent UI preferences can follow after the core experience is validated. A new filesystem/Git change-tracking subsystem is not required for the first release.

Control-plane actions such as answering prompts or cancelling invocations belong to the control surface described in `202-control-plane.md`; this watcher is a focused telemetry view. It requires no new daemon or cloud service. Logs remain telemetry under `207-state-segmentation.md`, and derived presentation state is local and disposable.

## 7. Validation criteria

- In a shallow pane, the latest prose remains visible during a burst of tool calls, and the active target is legible without its full worktree prefix.
- Maximizing, shrinking, and restoring the terminal preserves collected state and operator focus.
- Concurrent same-name tools with IDs complete independently; legacy ambiguity is visibly degraded rather than incorrectly paired.
- Author/reviewer transitions and overlapping invocations preserve event attribution and prose ownership.
- Historical attachment reconstructs the view without live pulses; subsequent events animate once. Tail-only counters clearly describe partial history.
- Errors remain inspectable, and a failed tool call does not incorrectly terminate the run display.
- Long logs, large outputs, and prolonged paused browsing have bounded retained state and responsive input.
- Quiet streams show event age without claiming a stall; invocation completion leaves the watcher available for the next invocation.
- Quit and exceptional exits restore the terminal and leave the invocation running.
- Existing raw NDJSON and human-readable modes retain their output contracts.

Use recorded or synthetic event fixtures for deterministic reducer and layout checks, including old logs and missing metadata. Exercise the command and terminal lifecycle with integration tests and a manual split-pane/full-screen pass. Animation clocks should be controllable so verification does not depend on wall-clock timing.

## 8. Open decisions

1. **Terminal rendering library:** choose after a small compatibility and layout spike; avoid committing this design to a renderer prematurely.
2. **Event schema:** settle optional IDs, structured targets, message boundaries, and workspace metadata across built-in and plugin providers.
3. **Responsive breakpoints and bindings:** validate against genuinely shallow panes as well as typical full-screen terminals.
4. **History limits:** choose practical bounds and decide whether later versions load older detail on demand from the source logs.
5. **Status enrichment:** decide whether the first release reads authoritative invocation/run status or relies on clearly labelled log-observation state.

The central product decision is settled for this draft: **latest prose + active tools + file activity** is the default experience, with a timeline and inspector supplying depth when space or operator attention allows.
