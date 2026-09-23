# Run Watch TUI

**Version:** 1.0
**Created:** September 23, 2026
**Status:** Draft — pending staff engineer review

---

## Executive Summary

Add an explicitly selected `5x run watch --tui` presentation of the existing invocation logs. The default view keeps the latest agent prose, active tools, and observed file activity visible in a shallow terminal pane; larger terminals expose invocation history, a timeline, and an inspector. Monitoring remains read-only: quitting detaches the watcher, not the agent.

Implementation extends the normalized provider contract additively, gives the existing file tailer replay attribution and bounded consumption, and introduces a small `src/watch/` subsystem with a deterministic reducer, responsive text renderer, and terminal lifecycle controller. Raw NDJSON and human-readable output remain compatible. Work is sequenced into seven independently testable deliveries, including a renderer compatibility gate before terminal implementation.

### Scope

**In scope:**
- Explicit TUI mode, existing ambient/explicit run resolution, replay and tail-only attachment.
- Optional correlated tool/message metadata for OpenCode and the bundled Claude Code and Cursor Agent providers.
- Sticky narrative, independent overlapping invocations/tools, stable file activity, timeline/error inspection, basic Markdown, and bounded retained detail.
- Keyboard navigation, follow/pause, resize, reduced motion, low-color output, and cleanup on normal and exceptional exits.

**Out of scope:**
- Agent cancellation, prompt answering, or other control-plane writes.
- Git/filesystem change detection, full diff browsing, saved UI preferences, recorded-session playback, and on-demand loading of evicted detail.
- A daemon, cloud service, new database schema, or mandatory plugin migration.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Consume normalized logs, not provider payloads** | One renderer supports both bundled and external providers; unknown metadata degrades honestly. |
| **Separate event collection, state, viewport, and render clock** | Pause and resize cannot interrupt ingestion; event bursts cannot force unbounded redraws. |
| **Bound source batches and retained detail** | A bounded UI alone would not fix the tailer's current unbounded pending queue. |
| **Use observational status only in this release** | Avoids joining invocation registries to legacy log files or conflating a log `done` with run completion. |

### References

- [Requirements: TUI Run Watcher](../../v2/208-run-watch-tui.md) — product behavior and acceptance criteria.
- [Output normalization](../../v2/205-output-normalization.md) — streaming-output exception.
- [State segmentation](../../v2/207-state-segmentation.md) — disposable telemetry presentation state.
- [Implementation plan template](../../../../docs/_implementation_plan_template.md) — plan structure and delivery scoring.

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Delivery Budget](#delivery-budget)
4. [Architecture Overview](#architecture-overview)
5. [Phase 1: Terminal compatibility and lifecycle foundation](#phase-1-terminal-compatibility-and-lifecycle-foundation)
6. [Phase 2: Additive provider and invocation metadata](#phase-2-additive-provider-and-invocation-metadata)
7. [Phase 3: Replay-aware bounded event source](#phase-3-replay-aware-bounded-event-source)
8. [Phase 4: Invocation reducer and retention](#phase-4-invocation-reducer-and-retention)
9. [Phase 5: Responsive rendering and activity views](#phase-5-responsive-rendering-and-activity-views)
10. [Phase 6: Interaction and command integration](#phase-6-interaction-and-command-integration)
11. [Phase 7: Release hardening and operator documentation](#phase-7-release-hardening-and-operator-documentation)
12. [Files Touched](#files-touched)
13. [Tests](#tests)
14. [Estimated Timeline](#estimated-timeline)

---

## Overview

The current watcher streams parsed NDJSON or formats it through `StreamWriter`; it does not retain a browsable run view. This plan adds an opt-in terminal presentation without changing invocation execution. A watch-specific module boundary prevents the already large run handler from becoming a terminal application.

All source/test paths below are relative to `5x-cli/` unless explicitly qualified. Line references describe the initial checkout and are navigation anchors, not immutable patch offsets. New files have no existing line numbers.

**Current behavior:**
- Commander defines watch options in `src/commands/run-v1.ts:337–382`; `--show-reasoning` currently advertises human-readable mode only.
- `src/commands/run-v1.handler.ts:3268–3344` resolves ambient identity, validates worktree context, finds logs, and checks permissions. Lines `3346–3378` own SIGINT/tailer cleanup; `3384–3513` contain stream consumers and a private decoder that intentionally drops `done` and optional metadata.
- `src/utils/ndjson-tailer.ts:87–118,124–240,268–325` discovers and tails multiple files, but reads an entire backlog per poll into arrays and an uncapped pending queue. Chunk size does not bound total poll work. Warnings write directly to stderr.
- `src/providers/types.ts:84–91` has no call or prose identity. OpenCode already has native IDs during normalization (`src/providers/event-mapper.ts:269–361`); Claude Code and Cursor also correlate native IDs internally but omit them from emitted events.
- `src/providers/log-writer.ts:40–48,100–109` defines/writes `session_start`; `src/commands/invoke.handler.ts:613–622` supplies role, phase, provider, and model, but not effective workspace.
- `src/tui/controller.ts:1–29` controls an external OpenCode UI. It is not a reusable terminal renderer and must not be repurposed for this watcher.

**New behavior:**
- `--tui` requires interactive stdin and stdout; incompatible modes or unavailable terminal capabilities fail before entering raw input or the alternate screen.
- Logs remain the only activity source. Replay reconstructs state without fresh pulses; tail-only explicitly reports partial history. Invocation completion preserves its summary and keeps listening for subsequent logs.
- Structured targets shorten against the recorded invocation workspace, never the observer's CWD. Unknown targets, overlapping legacy tools, and missing timing remain explicitly unknown.

**Prerequisites:**
- Existing watch/log/provider implementations in this checkout; no unimplemented v2 control-plane plan is a dependency.
- Bun toolchain and compiled-binary build (`package.json:39–48`); a real terminal for the release smoke pass. CI unit tests must not require an interactive terminal.

---

## Design Decisions

**Keep the terminal choice behind one adapter and validate it first.** Phase 1 compares a small ANSI/readline adapter using Bun's terminal-width primitives with a pure-JavaScript terminal library (such as neo-blessed). Prefer the small adapter if Unicode width, resize, raw input, and compiled-Bun smoke checks pass; it avoids React/native dependencies for a bounded text dashboard. If it fails, select the pure-JS candidate only after the same checks and record the exact dependency/version in the plan. Do not introduce two runtime implementations. This is a bounded compatibility spike, not an open-ended renderer framework project.

**Extend event variants with optional fields instead of adding required variants.** Existing plugins can continue emitting their current `AgentEvent` objects. Keep `input_summary`, `output`, and tool names as fallbacks. Optional message/block identity and boundary markers on text/reasoning permit empty boundary deltas without changing existing exhaustive event switches. IDs are scoped by log source and source generation, not provider session ID (resumed sessions can produce multiple invocation logs).

**Normalize provider-specific structure at the mapper.** Each supported mapper recognizes its native path, search, range, and command fields and emits the shared shape. Do not expose raw arbitrary tool-input objects or parse them inside the renderer. Preserve supplied patches/change summaries with explicit truncation; do not synthesize Git diffs or treat requested edits as verified changes. Keep OpenCode's existing 500-character output contract and annotate truncation rather than silently expanding all invocation logs.

**Separate attach classification from timestamps.** Snapshot file byte sizes before starting notifications. A record is historical only if its terminating newline is at or before that file's attach watermark; a partial record completed after attachment is live. Newly discovered files are live. Attach wall time or event timestamps cannot reliably establish this boundary.

**Use deterministic observation ordering, not invented causality.** Preserve per-source byte order. Merge ready batches with a deterministic source/sequence tie-breaker; label the cross-invocation timeline as observed order and show recorded timestamps separately. Do not reorder a source on bad or backwards timestamps. File placement is first-seen order within directory groups, not continuously re-sorted recency.

**Keep live state separate from navigation.** A paused viewport stores bounded rendered rows/detail and selected stable IDs while the reducer continues updating. Resume discards that snapshot and returns to live activity. If retained history is evicted underneath a selection, keep its bounded inspector snapshot and show an eviction boundary, not an ever-growing queue. Browsing an older invocation never auto-switches to a new one.

**Report facts conservatively.** An ID-less end can match one unambiguous outstanding same-name call only, with estimated timing explicitly labeled; once concurrent ID-less calls overlap, render an uncertain group and never assign individual completion durations. Search activity belongs to a scope row, not every file under that scope. Read/edit starts are attempts; attributable results add success/error outcomes. Errors remain in counts after detail eviction. `done` closes only the source invocation; unmatched tools become outcome-unknown, not success. Silence shows age, never a hang verdict.

**Show usage as a reported snapshot, not an additive total.** Display the latest `usage` update with timestamp and label “reported usage”; a valid final `done.result` replaces it with “final invocation usage.” Do not sum these values or sum cross-invocation usage in v1. Missing fields stay unavailable rather than inferred from other calls.

**No authoritative status enrichment in v1.** Keep all UI status explicitly log-observed (`waiting for events`, `tool active`, `invocation complete`). No background DB polling, run-state transition, or provider API call is needed.

---

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Terminal adapter and compatibility decision (phase 1) | 5 | 1 | - | - | New platform-facing lifecycle boundary, Bun/compiled validation, input and terminal restoration; adapter tests included. |
| W2 | Optional normalized metadata across bundled providers (phase 2) | 3 | 2 | - | - | Crosses public provider API, three mappers, invocation header producer, and compatibility fixtures; adds a maintained external contract without migration. |
| W3 | Replay-aware bounded tailing and decoding (phase 3) | 5 | 1 | - | - | Adds watermark/backpressure semantics to a filesystem boundary and a watch decoder; race, partial-record, polling, and legacy tests belong here. |
| W4 | Watch reducer, attribution, and retention (phase 4) | 5 | 2 | - | - | New bounded state machine for concurrent invocations, tools, prose, counters, and evictions; deterministic fixtures and stress tests included. |
| W5 | Responsive views and safe display formatting (phase 5) | 5 | 2 | - | - | New layout/formatting surface for compact/expanded views, Markdown, Unicode, path safety, inspectors, and activity clocks. |
| W6 | Keyboard controller and watch command wiring (phase 6) | 3 | 1 | - | - | Integrates CLI validation, async collection, viewport state, lifecycle adapter, and rendering while preserving stream modes. |
| W7 | Release failure handling, capability polish, and documentation (phase 7) | 2 | 0 | - | - | Finishes the existing watcher slice: failure/slow-terminal fixes, CLI help and docs, compiled/PTY validation, and manual acceptance; no new subsystem. |

### Surface Snapshot

- Subsystems: 4 — provider normalization/log production; file tailing/decoding; watch state/presentation; CLI integration.
- Production files: 18 — 10 existing TypeScript files and 8 new `src/watch/` files listed below. A renderer dependency, if selected by W1, additionally changes package metadata/lockfile rather than adding an in-repo subsystem.
- Persistent/external boundaries: 3 — normalized provider/plugin contract; NDJSON files on disk; interactive terminal input/output. No new database persistence.

---

## Architecture Overview

```text
OpenCode / Claude Code / Cursor / external plugins
   -> optional normalized AgentEvent metadata
   -> existing log writer + session_start.workspace
   -> agent-N.ndjson
          |
          v
NdjsonTailer (attach watermark, bounded batches, diagnostic sink)
          |
          v
watch/events.ts (defensive normalized-log decoder)
          |
          v
watch/state.ts (bounded invocation/tool/prose/file state)
          |                         keyboard / resize
          |                              |
          +----> watch/controller.ts <----+
                     | viewport + independent clock
                     v
watch/render.ts + watch/format.ts -> bounded Frame
                     |
                     v
watch/terminal.ts (safe styles, input, alternate screen, cleanup)
```

`watch/types.ts` holds internal state/action/frame contracts; `watch/limits.ts` holds named caps. The run handler continues to own run/context resolution. It chooses exactly one consumer and delegates all TUI resources to the watch controller. No watch module imports a provider SDK, invocation cancellation interface, or DB mutation API.

---

## Phase 1: Terminal compatibility and lifecycle foundation

**Completion gate:** One selected terminal adapter can enter, draw, resize, read keys, and restore a terminal in Bun source and compiled execution. Injected-port unit tests prove idempotent cleanup after every partial initialization step. No user-facing `--tui` option is exposed yet.

### 1.1 W1 — Establish the terminal boundary

**Files:** new `src/watch/terminal.ts`, `src/watch/types.ts`; `package.json:39–65` and `bun.lock` only if a dependency is selected.

```typescript
export interface WatchFrame {
  // Text spans and styles are separate; never accept log-supplied ANSI.
  rows: ReadonlyArray<ReadonlyArray<{ text: string; style?: string }>>;
}
export interface WatchTerminal {
  size(): { columns: number; rows: number };
  enter(): void;
  draw(frame: WatchFrame): Promise<void>;
  onKey(listener: (key: string) => void): () => void;
  onResize(listener: () => void): () => void;
  close(): void; // idempotent, restores prior raw-mode state
}
```

- [ ] W1: Run the bounded candidate comparison with a 40×8 and 120×40 fixture, combining marks, CJK, emoji, resizing, q/Ctrl-C input, and a thrown draw error. Record the selected approach and source/compiled build evidence in this plan before implementing later renderer phases.
- [ ] W1: Prefer a local adapter using `node:readline` keypress events and ANSI screen operations; verify `Bun.stringWidth` behavior against supported Bun versions. If widths need a pure-JS helper, select/pin it at this gate, not as ad hoc per-view logic.
- [ ] W1: Inject stdin/stdout/signal ports for tests. Capture prior raw mode and input flow state; track every resource actually acquired. Restore cursor, styles, screen, raw input, listeners, and timers in reverse order even if entry/draw partially fails.
- [ ] W1: Implement coalesced output: at most one frame write in flight and one latest pending frame; honor writable backpressure. Never buffer a frame per event. Terminal failures reject to the owner; the adapter does not print errors or call `process.exit()`.
- [ ] W1: Verify an unsupported/dumb terminal can be rejected before entry; ensure labels/symbols work without color. Do not reuse the external OpenCode attach controller.

### 1.2 W1 — Focused adapter validation

- [ ] W1: Add `test/unit/watch/terminal.test.ts` with injected ports, partial-entry failures, repeated close, slow writes, and input subscription teardown; no process-wide env mutation or console capture.
- [ ] W1: Add a reusable `test/helpers/watch-tui-harness.ts` fixture for adapter/lifecycle subprocess smoke testing. Keep platform-specific PTY setup in integration tests, not the production adapter.

---

## Phase 2: Additive provider and invocation metadata

**Completion gate:** All bundled providers retain existing summary/text behavior while emitting available normalized IDs/targets. Old plugin event fixtures still typecheck and render identically through `StreamWriter`. Invocation logs record the actual provider workspace on fresh and resumed sessions.

### 2.1 W2 — Settle and publish optional shapes

**Files:** `src/providers/types.ts:84–91`; `src/index.ts:274–284`; `src/providers/log-writer.ts:40–48`; `src/commands/invoke.handler.ts:450–452,539–556,613–622`.

Use this contract unless mapper fixtures demonstrate a specific incompatibility; document any refinement at this phase gate:

```typescript
export interface ToolTarget {
  kind: "file" | "search" | "command";
  path?: string;             // file path, not inferred from command text
  pattern?: string;
  scope?: string;            // search root/scope, not matched files
  range?: { startLine: number; endLine?: number };
  command?: string;
  cwd?: string;
}
export interface ToolMetadata {
  call_id?: string;
  category?: "read" | "edit" | "search" | "command" | "other";
  targets?: ToolTarget[];
  change_summary?: string;
  patch?: string;
  detail_truncated?: boolean;
}
export interface ProseMetadata {
  message_id?: string;
  block_id?: string;
  boundary?: "start" | "end"; // may accompany an empty delta
}
// Intersect text/reasoning variants with ProseMetadata;
// intersect tool_start/tool_end variants with ToolMetadata.
// SessionStartEntry adds workspace?: string (absolute effective tool cwd).
```

- [ ] W2: Export the new public types from `src/index.ts` for provider packages. Do not require plugins to emit them or add a provider capability handshake.
- [ ] W2: Populate `workspace` from the same `workdir` used by `startSession`/`resumeSession`, not `process.cwd()` or the control-plane root. Extend log-writer and invoke fixtures to assert explicit-workdir, mapped-worktree, and resume behavior.
- [ ] W2: Bound newly introduced metadata: at most 32 targets per event, 4 KiB per path/pattern/command, 16 KiB supplied patch/summary combined; set `detail_truncated` on loss. Preserve existing required summary/output semantics. Do not log arbitrary native input snapshots.

### 2.2 W2 — Provider mappings and identities

**Files:** `src/providers/event-mapper.ts:233–263,269–361,365–453`; `packages/provider-claude-code/src/event-mapper.ts:3–14,77–110,120–180`; `packages/provider-cursor-agent/src/event-mapper.ts:64–117,167–240`.

- [ ] W2: OpenCode: use the same stable native call ID (fallback part ID) on start/end; retain input summary and running-update dedupe. Attach message and part IDs on all text/reasoning delta paths, including legacy delta registration. Emit boundary metadata when native part timing establishes it; never turn a full-text flush into duplicated prose.
- [ ] W2: Claude Code: forward `tool_use.id` / `tool_result.tool_use_id`; map `file_path`, ranges, search pattern/path, command/cwd. Track stream `message_start` and block indexes through start/delta/stop; index alone is not globally unique. Missing native message identity uses a mapper-local sequential message identity only when an explicit native boundary is observed.
- [ ] W2: Cursor: forward `call_id` on both lifecycle events, normalize typed and function-call arguments, and retain partial-mode duplicate-flush suppression. Use message/block IDs only when supplied or when explicit boundaries establish them; otherwise leave them absent and use the legacy reducer policy.
- [ ] W2: Preserve native tool names for unfamiliar tools; emit `other` without speculative file effects. Map meaningful provided change summary/patch data, but do not derive successful edits from request input. Annotate OpenCode's existing output truncation (`event-mapper.ts:359`).
- [ ] W2: Extend existing mapper suites for concurrent same-name calls, native message boundaries, absent IDs, unknown tools, malformed optional input, native errors, and output truncation. Add a type fixture showing an external provider using only the old required fields still satisfies `AgentEvent`.

---

## Phase 3: Replay-aware bounded event source

**Completion gate:** A deterministic tailer test suite proves historical/live classification without loss or duplication across attachment and concurrent append. A slow consumer cannot grow the pending queue without bound; abort interrupts catch-up. Existing raw/human watch integration tests pass unchanged.

### 3.1 W3 — Watermarks and bounded draining

**File:** `src/utils/ndjson-tailer.ts:30–46,65–69,87–118,124–240,246–325,329–365`.

```typescript
// Additive tagged metadata; raw output still serializes only {source, ...entry}.
export interface TailPosition {
  generation: number; // increments after observed truncation/replacement
  sequence: number;   // per-generation record order
  endOffset: number;  // exclusive byte offset including newline
  replay: boolean;
}
// TaggedLine adds position?: TailPosition for compatibility with old fixtures.
// TailerOptions adds replayMetadata?: boolean and onWarning?: (s: string) => void.
// A bounded drain reports catch-up progress independently of valid JSON lines.
export interface ReplayProgress { pendingFiles: number; complete: boolean }
```

- [ ] W3: Capture initial directory membership/file sizes before watch registration even in replay mode. Classify initial records by newline end offset; newly created logs are live even while another source is still replaying. Expose catch-up progress on byte consumption so malformed/empty files cannot leave “catching up” stuck forever.
- [ ] W3: Preserve existing `poll()` test seam but limit one drain turn to a named byte/record budget, starting with 256 KiB / 256 records. Rotate source traversal across turns so a large first file cannot starve later ones. Continue scheduled catch-up even without another filesystem notification.
- [ ] W3: Replace eager queue growth with bounded pull/backpressure: notification/poll callbacks mark work ready; stop reading when queued parsed payload reaches 1 MiB or 256 records. Permit one capped record to make progress. Resume reading from stored byte offsets when the consumer drains; yield to the event loop between batches.
- [ ] W3: Enforce the existing 1 MiB line cap for complete as well as partial lines; discard an oversized record through its next newline, not an arbitrary suffix that might parse as JSON. Keep UTF-8 byte framing intact and bound unread remainder buffers.
- [ ] W3: Tail-only starts existing files at attach EOF and reads only a bounded first-line `session_start` for context. Suppress all historical activity/counters. If EOF was mid-record, discard through the next newline before processing later records; report unavailable header context rather than replaying old events.
- [ ] W3: On observed truncate/inode replacement, clear partial buffers, increment source generation, and emit a reset notice so IDs cannot collide. New generation data is live. Do not promise detection of an in-place rewrite that leaves no observable filesystem identity/size change.
- [ ] W3: Add an injectable diagnostic sink (default preserves existing stderr warnings). TUI routes warnings into status/history, never directly through an active screen. Destroy must clear queues, pending continuation work, file watchers, polling and abort listeners, including an already-aborted signal.

### 3.2 W3 — Defensive log decoding

**File:** new `src/watch/events.ts`. Leave `run-v1.handler.ts:3446–3513` and the legacy stream decoder untouched to avoid changing existing formatting semantics merely to share code.

```typescript
export function decodeWatchEntry(line: TaggedLine): WatchInput | null;
// WatchInput discriminates session metadata, AgentEvent, reset, and warning.
// It includes source key, per-source sequence, replay flag, and optional valid ts.
```

- [ ] W3: Validate required event fields; retain only validated optional metadata. Recognize `done` without copying an unbounded result text/structured object into UI state. Unknown event types are skipped with bounded diagnostics, not fatal errors.
- [ ] W3: Keep legacy known-tool target inference conservative: only a single path-like summary for a recognized read/edit tool; never extract file effects from shell text or guess a search scope from its pattern. Malformed metadata falls back to the original summary.
- [ ] W3: Extend `test/unit/utils/ndjson-tailer.test.ts`; add `test/unit/watch/events.test.ts`. Cover files created during replay, append across watermark, partial Unicode/newline boundaries, poll fallback, missing directory, malformed/oversized lines, abort during catch-up, slow consumers, and source generation changes.

---

## Phase 4: Invocation reducer and retention

**Completion gate:** Fixture-driven reducers independently reconstruct overlapping invocations and legacy logs, retain latest prose during tool bursts, preserve errors, and remain within all caps under a long paused-session stress test. Replay changes state but creates no live animation marks.

### 4.1 W4 — Bounded state model

**Files:** new `src/watch/state.ts`, `src/watch/limits.ts`; extend `src/watch/types.ts`.

```typescript
export type SourceKey = string; // file + generation; never provider session alone
export interface WatchViewport {
  invocation?: SourceKey;
  focus: "timeline" | "files" | "invocations" | "inspector";
  follow: boolean;
  selectedId?: string;
  newerCount: number;
  showReasoning: boolean;
  reducedMotion: boolean;
}
export function createWatchState(partialHistory: boolean): WatchState;
export function reduceWatchEvent(
  state: WatchState, input: WatchInput, receivedAtMs: number,
): WatchState;
export function reduceWatchAction(
  state: WatchState, action: WatchAction,
): WatchState;
```

- [ ] W4: Track per-invocation context, latest prose/reasoning blocks, lifecycle, active calls, history, files/scopes, usage snapshot, and operation/error counts. Store chronological event IDs independently of grouped display rows so grouped operations remain individually inspectable within retention.
- [ ] W4: Scope call and block IDs by source generation. Repeated starts with the same ID update one active record rather than increasing call counts; duplicate ends do not double-count within a bounded dedupe window. Unmatched ends are visible with “start not observed”; legacy ambiguous groups never receive fabricated success timing.
- [ ] W4: Group metadata-bearing prose by message/block identity. For ID-less logs, append contiguous same-kind deltas into a local block and begin a new block after a tool/event boundary; label grouping as inferred. Tool traffic must not clear the latest narrative. Retain reasoning independently while hidden so toggling can reveal retained reasoning without re-reading logs.
- [ ] W4: Count observed operations at start (or unmatched end with a missing-start marker), keep outcomes separate, and preserve tool errors independently of later successes. `error` is an observed error, not automatic terminal invocation status. A valid `done` freezes elapsed duration and keeps the source summary available; a run remains watchable indefinitely.
- [ ] W4: Resolve target identity lexically against recorded workspace only; no filesystem probes. Keep outside-workspace paths distinguishable, unresolved relative paths labeled, and search scopes separate from file reads. File counts reflect observed operations and attributable results, not net changes.

### 4.2 W4 — Explicit retention and animation policy

- [ ] W4: Centralize initial limits: 2,000 timeline records globally; 128 prose blocks with 256 KiB aggregate text; 8 KiB preview per output/patch and 4 MiB aggregate retained tool detail; 512 file/scope rows; 64 detailed invocation states; 128 active-call details per invocation and 1,024 globally; 256 KiB paused viewport snapshot. Bound IDs/labels and every secondary index as well as primary arrays.
- [ ] W4: Retain compact aggregate category/error counters when their details expire; evict least-recent inactive invocation detail first. If active sources/calls exceed caps, keep an explicitly incomplete overflow summary rather than allocating indefinitely or claiming precise untracked matching. Compact tailer offset bookkeeping may scale with discovered files, but event payloads, file detail, prose, and UI invocation state must not.
- [ ] W4: Expose “earlier detail discarded,” truncation and overflow counts in browse/inspector state. A returning source whose details were evicted is marked partially retained; do not silently reconstruct totals from incomplete data. Preserve a bounded selected-error snapshot if its timeline row expires.
- [ ] W4: Use recorded timestamps for display only when valid; use injected monotonic receipt time for live fades and timers. Historical active tools may show recorded start age, but no fresh pulse. Never label a replay receipt as a new event. Maintain fixed 60-bin category strips and a one-second fade window only for live observations.
- [ ] W4: Add reducer and retention suites with interleaved same-name calls, missing starts/ends/headers, overlapping role transitions, reasoning toggles, final usage replacement, invalid timestamps, thousands of files, and cap overflow. Assert state-size limits deterministically rather than brittle process-memory measurements.

---

## Phase 5: Responsive rendering and activity views

**Completion gate:** Pure frame snapshots at the target sizes preserve context, bounded latest narrative, and tool targets without overflow. File/timeline/inspector data is accessible in every size through focus switching. Malicious controls cannot emit terminal commands; Unicode truncation respects display width.

### 5.1 W5 — Layout and formatting

**Files:** new `src/watch/render.ts`, `src/watch/format.ts`; extend `src/watch/types.ts`.

```typescript
export function renderWatch(
  state: WatchState,
  viewport: WatchViewport,
  size: { columns: number; rows: number },
  nowMs: number,
): WatchFrame;
export function displayTarget(
  target: ToolTarget, workspace: string | undefined, columns: number,
): string;
export function safeDisplayText(text: string): string;
```

- [ ] W5: Start with explicit breakpoints: minimal below 8 rows; compact at 8–23 rows; expanded at 24+ rows and 100+ columns; narrower screens stack or show one focused section. Clamp zero/unknown sizes to a safe minimal frame. Validate 1×1, 40×6, 60×10, 80×12, 100×24 and 140×40 snapshots.
- [ ] W5: Allocate compact space in order: context/status, bounded latest prose (normally 2–4 rows), active tool rows plus overflow count, then recent/file panels, then counters. On extremely tiny screens prioritize a status line and activity target; every other section remains reachable by view switching. Expanded layouts add a directory-grouped file list and bounded inspector without losing a “latest prose” location.
- [ ] W5: Format workspace-relative paths with segment-aware containment (`/repo2` is not inside `/repo`); normalize native path syntax without assuming observer CWD, including Windows drive/UNC fixtures. Preserve filename/useful parents on truncation and full sanitized path in inspector.
- [ ] W5: Strip/neutralize ESC, CSI, OSC (including hyperlinks/clipboard), C0/C1 controls and carriage-return tricks before width measurement. Treat tab/newline as layout input, never raw cursor control. Grapheme-aware wrapping must not split combining sequences or emoji. Only renderer-owned styles may become ANSI.
- [ ] W5: Render supplied prose with basic headings, lists, emphasis and fenced code using safe styled text; no HTML, remote images, executable links or full Markdown dependency required. Wrap/truncate within allocated lines and expose retained full prose through the timeline/inspector.

### 5.2 W5 — Activity and inspector semantics

- [ ] W5: Draw each correlated active tool with name, target, elapsed time and spinner. Draw uncertain legacy groups with an explicit unknown/ambiguous label. Keep success/error symbols and error counts meaningful without color.
- [ ] W5: Implement stable first-seen rows within directory groups, category activity strips, fading read/edit attempts, and separate attributable outcomes. Never label edit rows “Git modified.” Search scopes have their own marker; shell effects are unknown.
- [ ] W5: Inspector shows selected command/cwd, targets, search scope/range, result/error, supplied patch/summary and truncation markers. Default output is collapsed. Grouped repeated operations expand to retained individual event rows; errors cannot disappear into a success group.
- [ ] W5: Display invocation selector/count, observed status, last-event age, partial history, replay catch-up, retention boundaries, and new-event count while browsing. Unknown role/model/start time is omitted or explicitly unknown.
- [ ] W5: Reduced motion uses static active symbols/no pulse; `NO_COLOR` and terminal capability influence style only, never text semantics. Add deterministic render/format tests using an injected clock and hostile-content fixtures.

---

## Phase 6: Interaction and command integration

**Completion gate:** `5x run watch --tui` works with ambient and explicit identity; keyboard/resize actions preserve attribution and selection. TUI resources close before fatal diagnostics. Existing stream output is unchanged and no watcher exit sends agent cancellation.

### 6.1 W6 — Controller and key surface

**File:** new `src/watch/controller.ts`; use adapter/state/render modules from prior phases.

```typescript
export interface WatchTuiOptions {
  source: AsyncIterable<WatchInput>;
  terminal: WatchTerminal;
  signal: AbortSignal;
  detach(): void; // aborts only the watcher-owned source
  showReasoning: boolean;
  partialHistory: boolean;
}
export function runWatchTui(options: WatchTuiOptions): Promise<void>;
```

- [ ] W6: Collect continuously in bounded batches, including while paused/help is visible. Render on a separate clock, capped at 10 frames/second during activity and 1 frame/second when only age labels change. Coalesce resize/event dirtiness; avoid rebuilding histories per frame or replaying on resize.
- [ ] W6: Bind Space to pause/resume; arrows or j/k to browse; PageUp/PageDown to page; End to follow latest; Tab/Shift-Tab to cycle focus/views; Enter to inspect/expand; Escape to close overlay; `[`/`]` to move invocations; r to toggle reasoning; m reduced motion; c low color; ? help; q/Ctrl-C detach. List all bindings in help. Do not persist preferences.
- [ ] W6: Scrolling away suspends auto-follow. Preserve selected IDs and bounded viewport snapshot when paused; new arrivals increment a badge without changing the inspected invocation. Resuming moves to current activity; automatic role transitions occur only when following live.
- [ ] W6: Resize recomputes layout only; clamp scroll offsets without resetting selection/follow. Retain the same selected event even if its panel moves behind a focus-switchable view.
- [ ] W6: One try/finally owns controller subscriptions and terminal close; treat q/Ctrl-C as successful detach, SIGTERM as a terminating detach with documented conventional status. Signal handlers abort local tailing only. Raw-mode Ctrl-C arrives as input and must take the same cleanup path as SIGINT.

### 6.2 W6 — CLI mode validation and lifecycle seam

**Files:** `src/commands/run-v1.ts:337–382`; `src/commands/run-v1.handler.ts:3258–3378`.

- [ ] W6: Add `tui?: boolean`/`--tui`, reject `--tui --human-readable` with `INVALID_ARGS` at handler entry, and update reasoning help to cover both human modes. Do not let global output defaults choose or override a watch mode.
- [ ] W6: Preflight stdin/stdout TTY, supported terminal, and raw-mode capability; emit the normal pre-stream error contract with guidance to raw NDJSON or `--human-readable`. Finish existing run/context/worktree validation before alternate-screen entry. Non-TTY failure never prints escape sequences.
- [ ] W6: Preserve existing stream branches and raw serialization. Construct a replay-aware tailer only for TUI options; route warnings through the watch decoder/controller after entry. Tailer/controller abort lifetimes are shared locally but never shared with provider execution.
- [ ] W6: Ensure initialization is inside cleanup coverage, not just consumer execution. After UI entry, unwind terminal and tailer first, then emit one `[watch] Error:` diagnostic on stderr and set a failing exit status; do not emit a JSON envelope into the UI stream. Preserve pre-UI error envelopes and existing stream-mode error behavior.
- [ ] W6: Add unit controller tests with fake source/terminal/clock, plus subprocess cases for conflicts, non-TTY stdin or stdout, ambient/workdir selection, tail-only, and output defaults. Continue using the existing `watch-error-harness.ts` for legacy error-contract regression.

---

## Phase 7: Release hardening and operator documentation

**Completion gate:** Full lint/typecheck/concurrent tests and compiled build pass. Terminal integration and the manual split-pane/full-screen acceptance checklist have recorded outcomes. All requirements validation bullets have a named automated or manual check; any unresolved terminal capability is documented as an explicit unsupported case, not a silent fallback.

### 7.1 W7 — Close runtime failure and scale gaps

**Files:** `src/watch/controller.ts`, `src/watch/terminal.ts`, `src/commands/run-v1.handler.ts:3346–3378` as needed for integration-found lifecycle fixes; new `test/integration/commands/run-watch-tui.test.ts`; extend watch harness.

- [ ] W7: Exercise a recorded/synthetic run with author/reviewer transitions, simultaneous sources, 100,000 events, malformed metadata, giant tool results, quiet intervals, and long paused browsing. Assert bounded pending payload/state, responsive injected key/resize servicing between batches, and no per-event redraw explosion.
- [ ] W7: PTY integration on supported Unix CI: verify alternate-screen exit/cursor/raw-mode restoration for q, Ctrl-C bytes, SIGINT, SIGTERM, source rejection, and renderer rejection. Use the existing repository subprocess conventions; gate only real PTY-dependent tests by capability and keep injected lifecycle coverage mandatory everywhere.
- [ ] W7: Start a separate log-producing child in the harness and prove it continues writing after watcher quit/failure. No test should require a live provider or network.
- [ ] W7: Run source and `bun run build` compiled-binary smoke checks. Test slow output/backpressure, loss of terminal output, and empty directory waiting. Fix only this feature's failure handling/capability issues, not unrelated terminal abstractions.
- [ ] W7: Run `bun run lint`, `bun run typecheck`, `bun test --concurrent`, and `bun run build` from `5x-cli/`. New subprocess tests use explicit timeouts, `stdin: "ignore"` unless intentionally piping/PTY input, and `cleanGitEnv()` for any process that may run git. Unit tests remain console-capture-free and deterministic under concurrency.

### 7.2 W7 — Operator contract and manual acceptance

**File:** `README.md:143,259,382,646,724`; CLI watch help in `src/commands/run-v1.ts:341–371`.

- [ ] W7: Document `--tui`, mode conflicts, TTY requirement, streaming-output exception, controls, reduced motion/color toggles, unknown/observed statuses, partial-history counts, retention limits, and read-only detach. Include ambient, explicit run, reasoning, and tail-only examples.
- [ ] W7: Manual 80×12 split-pane → 140×40 fullscreen → 40×6 → restored size: latest prose survives tool bursts, active target remains legible, inspection and follow state survive resizing, full paths/results remain inspectable within bounds, and older invocation browsing is not stolen by a new source.
- [ ] W7: Manual replay/tail-only/error pass: historical activity does not pulse; live appends pulse once; quiet intervals show age; failed edits remain discoverable; `done` leaves final summary visible; next invocation is followed; low-color and reduced-motion modes communicate the same facts.
- [ ] W7: Record platform/Bun version, selected renderer, sizes, fixture, cleanup result, and any unsupported capability in implementation completion notes. Update this plan's checklist and append revision history only when implementation/review changes warrant it.

---

## Files Touched

| File | Change |
|------|--------|
| `src/providers/types.ts:84–91` | W2 optional tool/prose metadata contract. |
| `src/index.ts:274–284` | W2 public metadata type exports for plugins. |
| `src/providers/event-mapper.ts:233–453` | W2 OpenCode ID/target/message preservation. |
| `packages/provider-claude-code/src/event-mapper.ts:3–180` | W2 Claude tool and message identities/targets. |
| `packages/provider-cursor-agent/src/event-mapper.ts:64–240` | W2 Cursor call IDs and structured targets, conservative prose identity. |
| `src/providers/log-writer.ts:40–48` | W2 optional workspace header. |
| `src/commands/invoke.handler.ts:613–622` | W2 populate effective invocation workspace. |
| `src/utils/ndjson-tailer.ts:30–365` | W3 replay positions, bounded draining, warning injection, cleanup. |
| `src/commands/run-v1.ts:337–382` | W6/W7 TUI options and help. |
| `src/commands/run-v1.handler.ts:3258–3378` | W6/W7 mode validation and TUI lifecycle dispatch. |
| `src/watch/types.ts` (new) | W1/W4 internal frame, source, state, viewport/action types. |
| `src/watch/terminal.ts` (new) | W1 terminal adapter and lifecycle, W7 capability/failure polish. |
| `src/watch/events.ts` (new) | W3 validated log-to-watch inputs. |
| `src/watch/limits.ts` (new) | W4 named detail/retention limits. |
| `src/watch/state.ts` (new) | W4 reducer, attribution, grouping, retention and counters. |
| `src/watch/format.ts` (new) | W5 safe text, width, paths, Markdown formatting. |
| `src/watch/render.ts` (new) | W5 pure responsive frame generation. |
| `src/watch/controller.ts` (new) | W6 collection, actions, viewport and render clock; W7 hardening. |
| `package.json`, `bun.lock` (conditional) | W1 selected pure-JS renderer/width dependency only if compatibility gate requires it. |
| `README.md:143,259,382,646,724` | W7 operator usage and streaming contract. |
| `test/unit/providers/event-mapper.test.ts` | W2 OpenCode metadata cases. |
| `test/unit/providers/claude-code/event-mapper.test.ts` | W2 Claude metadata cases. |
| `test/unit/providers/cursor-agent/event-mapper.test.ts` | W2 Cursor metadata cases. |
| `test/unit/providers/log-writer.test.ts` (new if absent) | W2 header/metadata serialization and legacy type fixture. |
| `test/unit/commands/invoke.test.ts`, `test/integration/commands/invoke-worktree.test.ts` | W2 effective workspace header assertions for fresh/resumed and mapped/explicit workdirs. |
| `test/unit/utils/ndjson-tailer.test.ts` | W3 source boundary, fairness and backpressure cases. |
| `test/unit/watch/{terminal,events,state,retention,format,render,controller}.test.ts` (new) | W1/W3–W6 focused deterministic component tests. |
| `test/integration/commands/run-watch.test.ts` | W2/W3/W6 existing stream regressions and mode validation. |
| `test/integration/commands/run-watch-tui.test.ts` (new) | W6/W7 CLI and terminal lifecycle. |
| `test/helpers/watch-tui-harness.ts` (new) | W1/W7 controlled terminal/source failures and independent producer. |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit (W1) | `watch/terminal.test.ts` | Partial entry failure, prior raw state, idempotent restore, slow output coalescing, listener removal. |
| Unit (W2) | Three provider mapper suites | Optional IDs/targets, native boundaries, deduplication, legacy events, unknown tools, supplied/truncated changes. |
| Unit/integration (W2) | Log writer and invoke fixtures | Header workspace equals actual fresh/resumed provider workdir; additive fields do not invalidate old plugin shapes. |
| Unit (W3) | Tailer and `watch/events.test.ts` | Attach watermark races, new files, UTF-8, partial EOF, malformed lines, rotation/reset, bounded queues, polling fallback and abort. |
| Unit (W4) | `watch/state.test.ts` | Independent overlapping invocations/tools, ID-less ambiguity, sticky prose, persistent error counts, usage replacement, no run completion inference. |
| Unit (W4) | `watch/retention.test.ts` | All payload/index caps, overflow labels, paused eviction, no historical animation, deterministic long-session stress. |
| Unit (W5) | `watch/format.test.ts` | Path containment, missing workspace, Windows/outside paths, grapheme width, ANSI/OSC/C0/C1 safety, Markdown text-only handling. |
| Unit (W5) | `watch/render.test.ts` | Tiny/compact/expanded snapshots, narrative priority, multi-active overflow, inspector bounds, no-color/reduced-motion parity. |
| Unit (W6) | `watch/controller.test.ts` | Follow/pause/new-event badge, keys, reasoning toggle, older invocation focus, resize stability, coalesced fake-clock redraws. |
| Integration (W3/W6) | `commands/run-watch.test.ts` | Existing raw/human output and error contracts, no added positional fields on raw wrapper, global output defaults, ambient/workdir resolution. |
| Integration (W6/W7) | `commands/run-watch-tui.test.ts` | Mode conflict, TTY validation, pre-entry error envelopes, post-entry diagnostic ordering, signals and provider-independent detach. |
| Integration (W7) | PTY + compiled harness | Real terminal restoration on every exit path, source and compiled distribution compatibility, independent producer survives. |
| Manual (W7) | Split-pane/fullscreen replay fixture | Readability, animation fidelity, resizing while browsing, controls/help, low-color and reduced-motion accessibility. |

The fixture vocabulary must include both old logs and new metadata, same-name concurrent calls, two simultaneous log sources sharing native IDs, timestamp anomalies, malformed optional values, missing session headers, failed edits followed by success, oversized outputs and terminal-control payloads. Prefer inline builders shared by these tests over captured provider transcripts containing potentially sensitive workspace content.

---

## Not In Scope

- **Control-plane actions/status joins** — no cancellation, prompt replies, or background authoritative-status lookup; this release labels log-observed state.
- **Verified filesystem changes** — no Git commands, filesystem scans of targets, or shell-effect inference.
- **Full diff viewer/recorded playback** — inspect bounded supplied patches only; no seek/replay controls or disk-backed historical browsing.
- **Persistent preferences or UI database** — presentation state is process-local and disposable.
- **Provider transport rewrite** — retain current logging and event transports; external plugin metadata is optional.
- **Global stream formatter/tailer rewrite beyond required seams** — preserve existing raw/human decoder and output behavior; change tailer scheduling only as required for replay correctness and bounded consumption.

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Terminal compatibility and lifecycle foundation | 1–2 days |
| 2 | Additive provider and invocation metadata | 2–3 days |
| 3 | Replay-aware bounded event source | 2–3 days |
| 4 | Invocation reducer and retention | 2–3 days |
| 5 | Responsive rendering and activity views | 2–3 days |
| 6 | Interaction and command integration | 2–3 days |
| 7 | Release hardening and operator documentation | 1–2 days |
| **Total** | Sequential implementation and validation | **12–19 days** |

The dependency path is phase 1 → 2 → 3 → 4 → 5 → 6 → 7. Phases 2 and 3 deliver backward-compatible foundation changes before the CLI option is exposed; phase 6 is the first complete user-facing slice. Terminal compatibility and replay/backpressure edge cases are the largest sources of estimate uncertainty.

---

## Provenance

This plan implements [208-run-watch-tui](../../v2/208-run-watch-tui.md), motivated by tool traffic obscuring agent narrative in the existing human-readable watcher. It builds on the current watch command and normalized NDJSON pipeline, not the external OpenCode attach UI or the proposed control-plane dashboard.

---

## Revision History

### September 23, 2026 — Pre-review parser recovery

Normalized positive Architecture delta literals from `+1`/`+2` to `1`/`2` after `BUDGET_INVALID_ARCHITECTURE` parser feedback. Scores, work-item IDs, phases, Surface Snapshot, and substantive content are unchanged. No reviewer has run; this is a syntax correction, not a response to review findings.
