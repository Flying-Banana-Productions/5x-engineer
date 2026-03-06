# Feature: `5x run watch` and `--stderr` Flag

**Version:** 1.1
**Created:** March 6, 2026
**Status:** Complete
**Review:** `docs/development/reviews/2026-03-06-run-watch-and-stderr-plan-review.md`

## Overview

Current behavior: When an agent harness (Claude Code, OpenCode) invokes `5x invoke author/reviewer` as a subprocess, the human-readable streaming output is suppressed because `process.stderr.isTTY` is `false`. The user sees nothing until the orchestrating agent receives the JSON envelope and decides what to relay. NDJSON log files are written unconditionally but there is no way to watch them in real-time.

Desired behavior: Users can monitor agent progress in real-time by running `5x run watch --run <run-id>` in a separate terminal. The watch command tails all NDJSON log files for a run, outputs raw NDJSON to stdout by default (preserving machine-parseable contract), and supports a `--human-readable` flag for StreamWriter-rendered output. Additionally, a `--stderr` flag on `invoke` allows harnesses that capture stderr to see streaming output without the TTY gate.

Why this change: The 5x workflow orchestrates multiple agent invocations per run (author and reviewer, across multiple phases). When driven by a TUI agent, the user has no visibility into what the inner agents are doing. The watch command provides a universal monitoring solution that works regardless of how invoke was started — direct CLI, agent subprocess, or script.

## Design Decisions

**Poll-based tailing with `fs.watch` acceleration.** `fs.watch(dir)` provides instant notification when files change, but has known cross-platform caveats (inode tracking on Linux/macOS breaks on file rotation). A 250ms `setInterval` poll provides reliable fallback. `fs.watch` events trigger an immediate poll cycle for low-latency response. All APIs are `node:fs` — no Bun-specific dependencies, preserving future migration flexibility to Node.js.

**Sync reads in bounded 64KB chunks.** Each poll tick reads new bytes in fixed 64KB chunks rather than allocating `size - offset` bytes (which could be O(fileSize) for large logs). Per-file partial-line buffers are capped at 1MB — if exceeded, the buffer is discarded with a warning to stderr.

**`session_start` is log-only metadata, not an `AgentEvent` variant.** Log files are named `agent-001.ndjson`, `agent-002.ndjson` — sequential with no semantic content. Adding a `session_start` entry as the first line of each log file provides role, template, run-id, and phase number. This is defined as a separate `SessionStartEntry` type in `log-writer.ts` — it is NOT added to the `AgentEvent` union, keeping the provider contract clean. Providers never emit `session_start`; it is written by the CLI invoke handler. The watch command treats it as control-plane data: updates labels, does not route through `StreamWriter.writeEvent()`.

**Only `phase_number` from vars, not full var dump.** `--var` commonly includes `user_notes` and other high-entropy/sensitive strings. The `session_start` entry logs only `role`, `template`, `run`, and `phase_number` (extracted from vars if present) — no full var values.

**DB validation with log-dir fallback.** `5x run watch` attempts to validate the run-id against the database via `getRunV1()` for fast-fail on typos. If the DB lookup fails but the log directory exists (supporting ad-hoc `invoke` without `run init`), it warns to stderr and proceeds. If neither DB entry nor log directory exists, it errors with `RUN_NOT_FOUND`.

**Raw NDJSON to stdout by default.** The watch command outputs raw NDJSON lines to stdout, with an added `source` field for multi-file disambiguation. Each line is valid JSON, preserving the machine-parseable stdout contract. A `--human-readable` flag switches to `StreamWriter`-rendered output for terminal monitoring. Pre-streaming errors (bad run-id, run not found) use `outputError()` as normal. Errors during streaming (malformed JSON, IO failures) are emitted as warnings to stderr in both modes — stdout remains a clean data channel.

**Replay from start by default.** When `run watch` starts, it replays existing log content before tailing for new data. Agent runs are finite (minutes), so replaying from start is almost always useful. `--tail-only` starts at current EOF for the tail-only case. (Note: `--no-replay` was avoided because citty interprets `--no-X` flags as negation of `--X`.)

**`--stderr` on invoke is opt-in.** The TTY gate on stderr streaming exists to prevent noise when stderr is piped to a file or discarded. The `--stderr` flag overrides this gate for environments where the caller explicitly wants streaming output regardless of TTY status (e.g., agent harnesses that capture and display subprocess stderr).

**Labels use `[role-phase-N]` format.** In `--human-readable` mode, when switching between interleaved streams from different log files, the watch command prints a header line like `[author-phase-1]` or `[reviewer-phase-2]`. Derived from `session_start` entries. Falls back to `[agent-NNN]` for log files without a `session_start` entry. `StreamWriter.endBlock()` is called before label headers to prevent cross-file word/space buffer bleeding.

**NdjsonTailer is deterministically testable.** The tailer exposes a `poll()` method. Tests create it with `pollInterval: 0` (disables auto-polling) and call `poll()` directly after writing to files. No timer flakes, no `fs.watch` dependency in tests.

## Phase 1: Add `session_start` Metadata to NDJSON Logs

**Completion gate:** Invoke commands write a `session_start` entry as the first NDJSON line. `SessionStartEntry` is a separate type from `AgentEvent`. All tests pass.

- [x] Define `SessionStartEntry` in `src/providers/log-writer.ts`:

```typescript
/** Log-only metadata written by the CLI, not emitted by providers. */
export interface SessionStartEntry {
  type: "session_start";
  role: string;
  template: string;
  run: string;
  phase_number?: string;
}
```

- [x] Add `appendSessionStart()` function in `src/providers/log-writer.ts`:

```typescript
export function appendSessionStart(
  logPath: string,
  entry: SessionStartEntry,
  opts?: LogWriterOptions,
): void {
  const timestamp = opts?.getTimestamp?.() ?? new Date().toISOString();
  const line = JSON.stringify({ ts: timestamp, ...entry });
  appendFileSync(logPath, `${line}\n`);
}
```

- [x] In `src/commands/invoke.handler.ts`, after `prepareLogPath()`, write the metadata line before the streaming loop:

```typescript
import { appendSessionStart } from "../providers/log-writer.js";

// After prepareLogPath:
appendSessionStart(logPath, {
  type: "session_start",
  role,
  template: templateName,
  run: params.run,
  phase_number: variables.phase_number,
});
```

- [x] Do NOT modify `AgentEvent` in `src/providers/types.ts` — `session_start` is log-only metadata.
- [x] Do NOT modify `StreamWriter.writeEvent()` — label rendering is handled by the watch command directly.

**Files:** `src/providers/log-writer.ts`, `src/commands/invoke.handler.ts`

## Phase 2: Extract `validateRunId` to Shared Module

**Completion gate:** `SAFE_RUN_ID` and `validateRunId()` are exported from `src/run-id.ts`. `invoke.handler.ts` imports from there. All tests pass.

- [x] Add to `src/run-id.ts` (which already exports `generateRunId`):

```typescript
import { outputError } from "./output.js";

/** Safe run_id pattern: alphanumeric start, then alphanumeric/underscore/hyphen, max 64 chars. */
export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Validate that a run_id is safe for use as a filesystem path component. Throws CliError on failure. */
export function validateRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) {
    outputError(
      "INVALID_ARGS",
      `--run must match ${SAFE_RUN_ID} (alphanumeric start, alphanumeric/underscore/hyphen, 1-64 chars), got: "${runId}"`,
    );
  }
}
```

- [x] Remove the private `SAFE_RUN_ID` and `validateRunId` from `src/commands/invoke.handler.ts`, replace with import from `../run-id.js`.

- [x] Add unit tests for `validateRunId` in `test/run-id.test.ts` (if not already covered).

**Files:** `src/run-id.ts`, `src/commands/invoke.handler.ts`, `test/run-id.test.ts`

## Phase 3: Implement `NdjsonTailer` Utility

**Completion gate:** `NdjsonTailer` is a working cross-runtime utility that tails multiple NDJSON files in a directory, yields parsed entries, and cleans up on abort. Unit tests are deterministic (no timer/watcher flakes).

- [x] Create `src/utils/ndjson-tailer.ts`:

```typescript
export interface TailerOptions {
  /** Directory to watch for *.ndjson files. */
  dir: string;
  /** Poll interval in ms (default: 250). Set to 0 to disable auto-polling (test mode). */
  pollInterval?: number;
  /** AbortSignal for cleanup. */
  signal: AbortSignal;
}

export interface TaggedLine {
  /** Filename within the directory (e.g., "agent-001.ndjson"). */
  file: string;
  /** Parsed JSON entry (the raw log line with ts, type, and event fields). */
  entry: Record<string, unknown>;
}
```

Internal design:
- `fs.watch(dir)` on the log directory — on any event, trigger an immediate poll cycle
- `setInterval(pollInterval)` as reliable fallback (disabled when `pollInterval: 0`)
- Per-file state: `Map<string, { offset: number; lineBuf: Buffer }>` — tracks read position and buffers partial lines
- Each poll tick: `readdirSync(dir)` filtered to `agent-*.ndjson` → for each file: `statSync` → if `size > offset` → read in 64KB chunks via `openSync` + `readSync` → `closeSync` → scan for `0x0a` (newline byte) in Buffer → parse complete JSON lines → yield `TaggedLine`
- If `size < offset`: file was truncated — reset offset to 0
- Partial-line buffer cap: 1MB per file — if exceeded, discard buffer, warn to stderr, reset to next complete line
- Malformed JSON lines: warn to stderr and skip (don't crash)
- `signal.addEventListener('abort', cleanup)` — closes `fs.watch`, clears interval, resolves the async iterator
- Falls back gracefully if `fs.watch` throws (emit warning to stderr, rely on interval polling alone)
- Exposes `poll(): TaggedLine[]` method for synchronous test-driven polling (returns collected lines from one poll cycle)
- UTF-8 correctness: Buffer-based newline scanning avoids splitting multi-byte sequences

- [x] Create `test/utils/ndjson-tailer.test.ts` covering:
  - Single file tailing: write lines incrementally, call `poll()`, verify yielded in order
  - Multi-file: two files, both yield events via `poll()`
  - New file detection: start tailing with one file, add a second, call `poll()`, verify new file picked up
  - Partial line buffering: write half a JSON line, `poll()` returns nothing, write rest, `poll()` returns complete line
  - Malformed JSON: verify skip + no crash
  - Abort signal: verify cleanup (iterator ends)
  - Empty directory: start watching empty dir, add first file, `poll()` returns events
  - File truncation: write data, truncate file, `poll()` resets offset
  - Buffer overflow: write line > 1MB, verify warning + skip

Tests use `pollInterval: 0` and call `poll()` directly — fully deterministic.

**Files:** `src/utils/ndjson-tailer.ts`, `test/utils/ndjson-tailer.test.ts`

## Phase 4: Implement `5x run watch` Handler and Adapter

**Completion gate:** `5x run watch --run <id>` tails all NDJSON logs for a run, outputs raw NDJSON to stdout by default, supports `--human-readable` for StreamWriter rendering, validates run existence, and exits cleanly on SIGINT. Integration tests pass.

- [x] Add `runV1Watch()` to `src/commands/run-v1.handler.ts`:

```typescript
export interface RunWatchParams {
  run: string;
  humanReadable?: boolean;
  showReasoning?: boolean;
  noReplay?: boolean;
  workdir?: string;
}

export async function runV1Watch(params: RunWatchParams): Promise<void>
```

Handler logic:
1. `validateRunId(params.run)` — shared validation
2. Open DB via `resolveDbContext()`, call `getRunV1(db, runId)`:
   - If found: proceed
   - If not found: check if log dir exists → if yes, warn to stderr and proceed; if no, error `RUN_NOT_FOUND`
3. Resolve log dir: `join(projectRoot, ".5x", "logs", params.run)`
4. If log dir doesn't exist, create it with `mkdirSync` (run was init'd but no invoke yet)
5. Create `AbortController`, wire `SIGINT` to `controller.abort()`
6. Create `NdjsonTailer({ dir: logDir, signal: controller.signal })`
7. If `--tail-only`: skip existing content (via `startAtEnd` constructor option)
8. **Default mode (NDJSON):** For each `TaggedLine`, add `source` field and write JSON line to stdout:
   ```typescript
   process.stdout.write(JSON.stringify({ source: line.file, ...line.entry }) + "\n");
   ```
9. **`--human-readable` mode:**
   - Create `StreamWriter({ writer: (s) => process.stdout.write(s) })`
   - Maintain label state: `Map<string, string>` mapping filename → label string
   - Track `currentFile: string | null` — on file switch, call `writer.endBlock()` then `writer.writeLine(label)` (endBlock prevents cross-file token mixing)
   - Build labels from `session_start` entries: `[${role}-phase-${phase_number}]`, fallback to `[${filename}]`
   - Route agent events through `writer.writeEvent(event, { showReasoning })` (requires reconstructing `AgentEvent` from the parsed entry)
   - `session_start` entries update labels but are NOT passed to `writeEvent()`
10. On abort (SIGINT): `writer?.destroy()`, exit cleanly (no JSON envelope)
11. Errors during streaming: `{"source":"watch","type":"error","message":"..."}` in NDJSON mode; stderr warning in human-readable mode

- [x] Add `watchCmd` to `src/commands/run-v1.ts` subCommands:

```typescript
const watchCmd = defineCommand({
  meta: { name: "watch", description: "Watch agent logs for a run in real-time" },
  args: {
    run: { type: "string", description: "Run ID", required: true },
    "human-readable": {
      type: "boolean",
      description: "Render human-readable output instead of raw NDJSON",
      default: false,
    },
    "show-reasoning": {
      type: "boolean",
      description: "Show agent reasoning (human-readable mode only)",
      default: false,
    },
    "tail-only": {
      type: "boolean",
      description: "Start at current EOF instead of replaying existing logs",
      default: false,
    },
    workdir: { type: "string", description: "Project root override" },
  },
  run: ({ args }) =>
    runV1Watch({
      run: args.run,
      humanReadable: args["human-readable"],
      showReasoning: args["show-reasoning"],
      noReplay: args["no-replay"],
      workdir: args.workdir,
    }),
});

// In subCommands object:
watch: () => Promise.resolve(watchCmd),
```

- [x] Create `test/commands/run-watch.test.ts` covering:
  - Rejects invalid run-id
  - Errors with `RUN_NOT_FOUND` when neither DB entry nor log dir exists
  - Warns and proceeds when DB entry missing but log dir exists
  - Outputs raw NDJSON by default with `source` field
  - `--human-readable` renders session_start as `[role-phase-N]` header
  - `--human-readable` renders text/tool events through StreamWriter
  - `--human-readable` flushes StreamWriter on file switches (no cross-file mixing)
  - `--no-replay` skips existing content

**Files:** `src/commands/run-v1.handler.ts`, `src/commands/run-v1.ts`, `test/commands/run-watch.test.ts`

## Phase 5: Add `--stderr` Flag to `invoke`

**Completion gate:** `5x invoke author/reviewer --stderr` streams output to stderr regardless of TTY status. Tests verify the flag is passed through and respected.

- [x] Add `stderr?: boolean` to `InvokeParams` in `src/commands/invoke.handler.ts`.

- [x] Thread `stderr` parameter into `invokeStreamed()` and change the gate:

```typescript
// Before:
const writer =
  !quiet && process.stderr.isTTY
    ? new StreamWriter({ writer: (s) => process.stderr.write(s) })
    : null;

// After:
const writer =
  !quiet && (stderr || process.stderr.isTTY)
    ? new StreamWriter({ writer: (s) => process.stderr.write(s) })
    : null;
```

- [x] Add `stderr` arg definition to both `authorCmd` and `reviewerCmd` in `src/commands/invoke.ts`:

```typescript
stderr: {
  type: "boolean",
  description: "Stream output to stderr even when not a TTY",
  default: false,
},
```

Pass `stderr: args.stderr` in the params object for both commands.

**Files:** `src/commands/invoke.handler.ts`, `src/commands/invoke.ts`

## Phase 6: Update Skill Guidance

**Completion gate:** All three skills mention `5x run watch` for monitoring and `--stderr` for harnesses that capture stderr.

- [x] Add to all three skills' human interaction notes in:
  - `src/skills/5x-plan/SKILL.md`
  - `src/skills/5x-plan-review/SKILL.md`
  - `src/skills/5x-phase-execution/SKILL.md`

Guidance text:

```
To monitor agent progress in real-time, suggest the user run
`5x run watch --run <run-id> --human-readable` in a separate terminal.

When invoking sub-agents, use the `--stderr` flag if your harness
displays subprocess stderr output (e.g., `5x invoke author ... --stderr`).
```

**Files:** `src/skills/5x-plan/SKILL.md`, `src/skills/5x-plan-review/SKILL.md`, `src/skills/5x-phase-execution/SKILL.md`

## Phase 7: Verification

**Completion gate:** All tests pass, type-check is clean, lint is clean.

- [x] `bun test --concurrent --dots` — all tests pass
- [x] `bunx tsc --noEmit` — clean
- [x] Biome lint — clean (run via pre-commit hook or `bunx biome check`)
- [x] No `citty` imports in any `*.handler.ts` file

## Dependency Graph

```
Phase 1 (session_start entry) ──┐
Phase 2 (extract validateRunId) ├── Phase 4 (run watch handler) ── Phase 6 (skill updates)
Phase 3 (NdjsonTailer utility) ─┘                                        │
Phase 5 (--stderr flag) ── independent ───────────────────────────────────┘
                                                                          │
                                                                   Phase 7 (verification)
```

Phases 1, 2, 3, and 5 have no interdependencies and can be executed in any order. Phase 4 requires 1-3. Phase 6 requires 4 and 5. Phase 7 is final.
