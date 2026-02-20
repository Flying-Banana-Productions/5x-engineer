# Console Output Cleanup

**Version:** 1.2
**Created:** February 20, 2026
**Status:** Revised — addressing review `reviews/2026-02-20-005-impl-console-output-cleanup-review.md` (addendum 2026-02-20)

---

## Overview

The headless (non-TUI) console output is noisy and hard to follow. Tool calls
and results use verbose `[tool]`/`[result]`/`[done]` bracket formatting with
raw JSON input summaries, step-finish lines clutter every agent turn, and
thinking/reasoning tokens are completely hidden. There is no word wrapping, so
long lines hard-break mid-word at the terminal edge.

**Current behavior:**

- Agent text streams inline with 2-space indent, no word wrap (`opencode.ts:190-200`)
- Reasoning/thinking tokens are suppressed (`opencode.ts:202-203`, `textPartIds` filter)
- Tool calls: `  [tool] bash: {"command":"npm install","timeout":30000}` (`sse-formatter.ts:94-103`)
- Tool results: `  [result] file1.ts\nfile2.ts` — up to 200 chars, can contain embedded newlines (`sse-formatter.ts:105-111`)
- Step-finish: `  [done] endTurn | cost=$0.0342 | tokens=1200→450` shown every agent turn (`sse-formatter.ts:128-146`)
- Tool errors: `  [error] bash: command not found` (`sse-formatter.ts:113-119`)
- No ANSI styling — all output is same visual weight

**New behavior:**

- Agent text streams with word wrapping at terminal width, flush left (no indent)
- Thinking/reasoning tokens are suppressed by default; shown inline with dim styling when `--show-reasoning` is passed
- Tool calls: dim single line, tool name + human-friendly args, truncated to terminal width
- Tool results: dim single line, truncated to terminal width, newlines collapsed
- Step-finish: hidden (cost/token info remains in log files)
- Tool errors: visible (not dimmed), single line
- ANSI dim/reset respects `NO_COLOR` env var and non-TTY stdout

**Before / After:**

```
BEFORE:
  The agent is analyzing the codebase to understand the current architecture and identify areas for improvement. Let me start by examining the main entry point.
  [tool] bash: {"command":"find src -name '*.ts' | head -20","timeout":30000}
  [result] src/index.ts
src/utils/format.ts
src/utils/logger.ts
src/agents/opencode.ts
  [tool] read: {"filePath":"src/index.ts","limit":50}
  [result] import { run } from "./cli";
import { parseArgs } from "util";

const args = parseArgs({
  options: {
    auto: { type: "boolean" },
  [done] endTurn | cost=$0.0342 | tokens=1200→450
  Based on my analysis, the entry point delegates to the CLI module.

AFTER:
The agent is analyzing the codebase to understand the current
architecture and identify areas for improvement. Let me start by
examining the main entry point.
bash: find src -name '*.ts' | head -20
src/index.ts src/utils/format.ts src/utils/logger.ts src/agents/...
read: src/index.ts
import { run } from "./cli"; import { parseArgs } from "util"; ...
Based on my analysis, the entry point delegates to the CLI module.
```

Tool/result lines above would render in dim ANSI styling on TTY terminals,
visually receding below the agent's prose. In the example, dim lines are shown
without any special formatting since this is a markdown document.

**Prerequisites:**

- [004-impl-5x-cli-tui](004-impl-5x-cli-tui.md) — Phase 2 complete (quiet-gating, DI logger)

---

## Design Decisions

**Word wrapping is handled by a `StreamWriter` class, not the terminal.** Terminal
soft-wrap breaks mid-word, which is hard to read for prose-heavy agent output.
A streaming word wrapper buffers tokens until a whitespace boundary, then
decides whether to emit on the current line or wrap. The trade-off is a small
buffering overhead per token, but this is negligible compared to network
latency. The writer is injectable for testability.

**Wrapping preserves whitespace and skips fenced code blocks.** The word wrapper
never removes or collapses whitespace from the input — it only *inserts*
newlines when a word would overflow the terminal width. Leading whitespace on
input lines is preserved exactly. Fenced code blocks (delimited by `` ``` ``)
are detected via a simple `inFence` toggle and passed through verbatim with no
wrapping, since hard-wrapping code/tables produces worse output than terminal
soft-wrap.

**All output is flush left (no indent).** Agent text, tool lines, and error
lines all start at column 0, consistent with orchestrator status messages. Dim
ANSI styling alone provides visual recession for tool/result lines. This avoids
width-accounting bugs where indent is applied after truncation and simplifies
the writer. If testing reveals that tool lines need more visual separation,
indent can be added later as a single-point change in `StreamWriter.writeLine()`.

**Width accounting is centralized in StreamWriter.** The formatter returns
semantic text only — no indent, no truncation, no ANSI codes. The writer owns
all width math: it truncates `writeLine()` output to `width` (appending `...`
when truncated) and wraps streaming text at `width`. This eliminates the risk of
formatter and writer independently miscounting columns.

**Thinking/reasoning is opt-in via `--show-reasoning`.** Showing reasoning
inline is a significant UX change — it can increase noise and expose sensitive
intermediate content. The default behavior suppresses reasoning tokens (matching
the current behavior). When `--show-reasoning` is passed, reasoning streams
inline with text in dim ANSI styling. The `StreamWriter.writeThinking()` method
exists unconditionally; the adapter gates whether to call it.

**Tool/result lines use dim ANSI styling rather than bracket prefixes.** The
`[tool]`/`[result]`/`[done]` brackets add visual noise. Dim styling makes
these lines recede so the user's eye tracks the agent's text naturally. The
full event details remain in the NDJSON log file.

**Step-finish lines are hidden.** Cost and token counts per turn are useful for
debugging but clutter normal operation. They remain in the NDJSON log file.

**Tool input formatting is tool-aware.** Instead of `JSON.stringify(input)`,
common tools get human-friendly summaries: `bash` shows the command, `file_edit`
shows the path, `grep` shows the pattern. Unknown tools show key names only.
This produces shorter, more informative lines.

**`formatSseEvent()` returns `{ text, dim } | null` instead of `string | null`.**
Separating content from styling lets the caller (StreamWriter) apply ANSI codes
based on color support, rather than embedding ANSI in the formatter. This keeps
the formatter testable with plain string assertions.

**Tool output collapsing is bounded.** Real tool outputs (notably `read`) can
contain entire file contents — megabytes per event. Collapsing newlines across
the full string would be O(n) in output size. Instead the formatter slices the
output to a small window (capped at display width * 2 or 500 chars, whichever
is smaller), collapses whitespace within that window, then returns the result.
The caller (StreamWriter) handles final truncation to terminal width.

**ANSI color support is resolved via a pure function at construction time.**
Rather than import-time module-level constants (which are hard to test under
module caching and concurrent env changes), a `resolveAnsi()` function accepts
`{ isTTY, env }` and returns `{ dim, reset, colorEnabled }`. StreamWriter
calls this once in its constructor. Tests pass explicit values — no mocking of
`process.stdout.isTTY` or `process.env` required.

**Console markers are ASCII-only.** Unicode glyphs (`✗`, `…`) gated on color
support is the wrong proxy (color support does not imply Unicode support) and
conflicts with the repo's ASCII-first convention. Error markers use `!` and
truncation uses `...`.

---

## Visual Layout Policy

All console output in headless mode follows a consistent layout:

| Source | Indent | Style | Example |
|--------|--------|-------|---------|
| Orchestrator status | 2-space | normal | `  Author implementing phase 1...` |
| Agent text | none | normal | `The entry point delegates to the CLI module.` |
| Agent reasoning | none | dim | `I should check the imports first...` |
| Tool running | none | dim | `bash: npm install` |
| Tool result | none | dim | `src/index.ts src/utils/format.ts ...` |
| Tool error | none | normal | `! bash: command not found` |

Note: orchestrator status messages (`phase-execution-loop.ts`,
`plan-review-loop.ts`) currently use 2-space indent. This plan does not change
orchestrator output (see Not In Scope). Normalizing orchestrator indent to
match agent output (flush left) is a follow-up concern — the 2-space indent
gives orchestrator lines slight visual distinction from agent prose, which may
be desirable.

Dim styling is the sole visual differentiator for tool chatter. On non-TTY or
`NO_COLOR` terminals, dim sequences are empty strings — tool lines appear at
the same weight as agent text, which is acceptable since the line content itself
(tool name prefix, terse format) distinguishes them.

---

## Phase 1: Foundation — ANSI utilities and StreamWriter ✓ COMPLETE

**Completion gate:** `ansi.ts` and `stream-writer.ts` exist with tests passing. No visual changes yet.

### 1.1 `src/utils/ansi.ts` — ANSI color detection

**File:** `5x-cli/src/utils/ansi.ts` (new, ~30 lines)

Pure color-support resolver:

```typescript
export interface AnsiConfig {
  dim: string;
  reset: string;
  colorEnabled: boolean;
}

export function resolveAnsi(opts?: {
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
}): AnsiConfig {
  const env = opts?.env ?? process.env;
  const isTTY = opts?.isTTY ?? (process.stdout.isTTY === true);

  let enabled: boolean;
  if (env.NO_COLOR !== undefined) {
    enabled = false;                       // NO_COLOR wins unconditionally
  } else if (env.FORCE_COLOR !== undefined) {
    enabled = env.FORCE_COLOR !== "0";     // FORCE_COLOR=0 disables; any other value enables
  } else {
    enabled = isTTY;
  }

  return {
    dim: enabled ? "\x1b[2m" : "",
    reset: enabled ? "\x1b[0m" : "",
    colorEnabled: enabled,
  };
}
```

- [x] `NO_COLOR` takes highest priority (disables even if `FORCE_COLOR` is also set)
- [x] `FORCE_COLOR` enables (unless `"0"`, which is treated as disable)
- [x] Falls back to `isTTY`
- [x] Pure function — no module-level state, no import-time side effects
- [x] All parameters optional with sensible defaults for production use

### 1.2 `src/utils/stream-writer.ts` — streaming word-wrap writer

**File:** `5x-cli/src/utils/stream-writer.ts` (new, ~150 lines)

```typescript
export interface StreamWriterOptions {
  width?: number;         // default: process.stdout.columns || 80
  writer?: (s: string) => void;  // default: process.stdout.write (injectable for tests)
  ansi?: AnsiConfig;      // default: resolveAnsi() (injectable for tests)
}

export class StreamWriter {
  writeText(delta: string): void;      // normal style, word-wrapped
  writeThinking(delta: string): void;  // dim style, word-wrapped
  writeLine(text: string, opts?: { dim?: boolean }): void;  // single complete line, truncated to width
  endBlock(): void;   // flush word buffer, terminate current line, reset style
  destroy(): void;    // final cleanup (calls endBlock)
}
```

Internal state:

- `col: number` — current column position (0 = start of line)
- `wordBuf: string` — accumulates non-whitespace characters
- `style: "text" | "thinking" | "idle"` — current output style
- `width: number` — terminal width for wrap and truncation decisions
- `inFence: boolean` — true while inside a fenced code block (`` ``` ``)
- `ansi: AnsiConfig` — resolved ANSI codes

Word wrap algorithm:

1. For each character in a delta:
   - Newline: flush word buffer, write newline, reset column to 0. Check if the
     flushed line starts with `` ``` `` and toggle `inFence` accordingly.
   - Whitespace (space, tab): flush word buffer, write the whitespace character
     as-is (preserving tabs and multiple spaces). Advance column.
   - Other: append to word buffer.
2. `flush()`: if `inFence`, write word buffer directly (no wrap check). Otherwise,
   if word buffer would overflow the line (`col + wordBuf.length > width`), write
   newline first, then write the word. Update column.
3. Style transitions: when switching between text/thinking, write ANSI reset before
   the new style's code.
4. **Whitespace preservation invariant:** the writer never removes, collapses, or
   reorders whitespace from the input delta. It only *inserts* newlines when a
   word would overflow the terminal width. Leading whitespace on lines from the
   model's output is preserved exactly.

`writeLine()` behavior:

1. Call `endBlock()` to flush any in-progress streaming.
2. Truncate `text` to `width` characters, appending `...` if truncated.
3. If `dim` option is set, wrap output in `ansi.dim` / `ansi.reset`.
4. Write the line followed by a newline.

- [x] Word wrapping at configurable width
- [x] Column tracking across multiple `writeText`/`writeThinking` calls
- [x] Whitespace preservation: spaces, tabs, leading whitespace kept exactly
- [x] Fenced code block detection: `inFence` toggle on `` ``` `` lines, wrapping bypassed
- [x] ANSI dim/reset on thinking<->text transitions
- [x] `writeLine()` calls `endBlock()` first, then truncates + writes line
- [x] Dim `writeLine` wraps text in `ansi.dim`/`ansi.reset`
- [x] `writer` and `ansi` parameters injectable for test assertions
- [x] Handles edge cases: empty deltas, deltas with only whitespace, very long words (>width)
- [x] No indent applied (all output flush left)

### 1.3 Tests

**File:** `5x-cli/test/utils/ansi.test.ts` (new)

- [x] `NO_COLOR` set → colorEnabled false, dim/reset are empty strings
- [x] `NO_COLOR` set + `FORCE_COLOR` set → colorEnabled false (NO_COLOR wins)
- [x] `FORCE_COLOR=1` set → colorEnabled true
- [x] `FORCE_COLOR=0` set → colorEnabled false
- [x] No env vars, `isTTY=true` → colorEnabled true
- [x] No env vars, `isTTY=false` → colorEnabled false
- [x] Default parameters (no args) → does not throw

**File:** `5x-cli/test/utils/stream-writer.test.ts` (new)

- [x] Word wraps at specified width
- [x] Handles multiple deltas building up a line
- [x] Newlines in delta reset column position
- [x] Long word exceeding width is not broken (written as-is, wraps on next word)
- [x] Preserves leading whitespace on input lines
- [x] Preserves multiple consecutive spaces within a line
- [x] Preserves tab characters
- [x] Fenced code block: content inside `` ``` `` fences is not word-wrapped
- [x] Fenced code block: wrapping resumes after closing fence
- [x] Nested/multiple fenced blocks tracked correctly
- [x] `writeThinking()` emits dim/reset codes (when color enabled)
- [x] `writeThinking()` emits no dim/reset codes (when color disabled)
- [x] Style transition text->thinking->text emits proper ANSI sequences
- [x] `writeLine()` flushes any in-progress streaming first
- [x] `writeLine({ dim: true })` wraps in dim/reset
- [x] `writeLine()` truncates long text to width, appends `...`
- [x] `endBlock()` is idempotent
- [x] `destroy()` flushes and terminates
- [x] Injectable writer captures all output for assertions
- [x] Injectable ansi config controls ANSI output

---

## Phase 2: Formatter + caller update — simplified event formatting ✓ COMPLETE

**Completion gate:** `formatSseEvent()` returns new type, `opencode.ts` consumes
the new type via direct `process.stdout.write` (no StreamWriter yet), all
formatter tests updated and passing, `bun run typecheck` clean. This phase IS a
user-visible formatting change: bracket prefixes are removed, step-finish lines
are suppressed, and tool output is collapsed to single lines. What it does NOT
change: no word wrapping, no ANSI styling, no reasoning display — those arrive
in Phase 3.

**Why this phase also updates `opencode.ts`:** The return type change from
`string | null` to `FormattedEvent` would break the only caller if landed
alone. To keep each phase independently buildable and passing CI, this phase
updates the caller to unwrap `FormattedEvent` into the existing stdout write
path. Phase 3 then adds StreamWriter for wrapping, styling, and reasoning.

### 2.1 `src/utils/sse-formatter.ts` — return type and format changes

**File:** `5x-cli/src/utils/sse-formatter.ts`, full rewrite of formatting logic

**Return type change:**

```typescript
export type FormattedEvent = { text: string; dim: boolean } | null;
export function formatSseEvent(event: unknown): FormattedEvent;
```

Note: `formatSseEvent()` takes no width/truncation parameter. It returns
semantic text only. The caller (StreamWriter in Phase 3, or raw stdout in this
phase) owns truncation.

**Tool input formatting — tool-aware summaries:**

```typescript
function toolInputSummary(tool: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const obj = input as Record<string, unknown>;
  // Tool-specific: extract the most useful field
  switch (tool) {
    case "bash":
      return typeof obj.command === "string" ? obj.command : "";
    case "file_edit": case "write":
      return typeof obj.filePath === "string" ? obj.filePath
           : typeof obj.path === "string" ? obj.path : "";
    case "read":
      return typeof obj.filePath === "string" ? obj.filePath
           : typeof obj.path === "string" ? obj.path : "";
    case "glob": case "grep":
      return typeof obj.pattern === "string" ? obj.pattern : "";
    default: {
      // Key names only
      const keys = Object.keys(obj);
      return keys.length > 0 ? `{${keys.join(", ")}}` : "";
    }
  }
}
```

**Tool result collapsing (bounded):**

```typescript
function collapseToolOutput(output: string, maxSlice: number): string {
  // O(k) in maxSlice, not O(n) in output.length
  const slice = output.slice(0, maxSlice);
  return slice.replace(/\s+/g, " ").trim();
}
```

The `maxSlice` parameter caps how much of the raw output is scanned. A
reasonable default is `500` (enough to fill any terminal line with slack). The
caller (StreamWriter.writeLine) handles final truncation to terminal width.

**Format changes (OpenCode SSE events):**

| Part/event | New `text` value | `dim` |
|---|---|---|
| Tool running | `"tool_name: human_summary"` or just `"tool_name"` if no input | `true` |
| Tool completed | collapsed output snippet (bounded slice, whitespace collapsed) | `true` |
| Tool completed (empty) | `null` | -- |
| Tool error | `"! tool_name: error_message"` | `false` |
| Step-finish | `null` (hidden) | -- |
| Session error | `"! error_message"` | `false` |
| Text part updated | `null` (handled as deltas upstream) | -- |
| Reasoning part updated | `null` (handled as deltas upstream) | -- |
| Delta | `null` (handled upstream) | -- |

**Legacy NDJSON events:** Same return type wrapper. Legacy `result` events -> `null`.
Legacy `assistant` text/tool_use and `user` tool_result updated to match new
format. `system init` -> `null` (hidden; model info is in log).

**`safeInputSummary()`** retained as fallback for the `default` case in
`toolInputSummary()` and for legacy events.

- [x] Return type is `FormattedEvent` (`{ text, dim } | null`)
- [x] No width/truncation parameter — formatter returns semantic text only
- [x] Tool-specific input summaries for bash, file_edit, write, read, glob, grep
- [x] Tool results: bounded slice then whitespace collapse (O(k) in display width, not O(n) in output size)
- [x] Step-finish returns `null`
- [x] Error lines use ASCII `!` marker (no Unicode glyphs)
- [x] No indent or ANSI codes in returned text (caller handles those)
- [x] Legacy NDJSON events updated to match

### 2.2 `src/agents/opencode.ts` — consume new return type (preserve current visuals)

**File:** `5x-cli/src/agents/opencode.ts`, changes to the `!opts.quiet` code path

This phase updates the caller to compile against the new `FormattedEvent` type.
The caller still uses direct `process.stdout.write` with 2-space indent (no
StreamWriter yet). The formatted text content changes (brackets removed,
step-finish suppressed, tool output collapsed), but there is no wrapping or
ANSI styling yet. This ensures the repo builds and tests pass after Phase 2
lands while delivering the first user-visible formatting improvement.

```typescript
// Replace:
//   const formatted = formatSseEvent(event);
//   if (formatted != null) {
//     process.stdout.write(`${formatted}\n`);
//   }
// With:
const formatted = formatSseEvent(event);
if (formatted != null) {
  process.stdout.write(`  ${formatted.text}\n`);
}
```

The `formatted.dim` flag is ignored in this phase (no ANSI styling yet).
The 2-space indent is preserved temporarily for visual consistency; Phase 3
removes it when StreamWriter takes over.

- [x] Consumes `FormattedEvent` type (`.text` access instead of raw string)
- [x] Preserves 2-space indent and direct stdout write (no ANSI, no wrapping — those come in Phase 3)
- [x] Builds and passes typecheck cleanly

### 2.3 Tests

**File:** `5x-cli/test/utils/sse-formatter.test.ts` (update all ~50 assertions)

- [x] Tool running -> `{ text: "bash: npm install", dim: true }`
- [x] Tool running with title -> uses title as label
- [x] Tool completed -> `{ text: "file1.ts file2.ts", dim: true }` (newlines collapsed)
- [x] Tool completed with huge output -> only slices first N chars before collapsing
- [x] Tool completed empty -> `null`
- [x] Tool error -> `{ text: "! bash: command not found", dim: false }`
- [x] Step-finish -> `null`
- [x] Session error -> `{ text: "! Provider connection lost", dim: false }`
- [x] Tool-specific input: bash shows command, file_edit shows path, grep shows pattern
- [x] Unknown tool shows key names
- [x] Legacy events updated to new return type

---

## Phase 3: Integration — wire StreamWriter into the event consumer

**Completion gate:** All tests pass, `bun run lint` and `bun run typecheck` clean. Running `5x run --auto` in headless mode shows the new output format.

### 3.1 `src/agents/opencode.ts` — replace stdout logic with StreamWriter

**File:** `5x-cli/src/agents/opencode.ts`, lines 113-233

Changes to the `!opts.quiet` code path:

```typescript
// At function start (when !quiet):
const writer = new StreamWriter({
  width: process.stdout.columns || 80,
});

// Track text part IDs (existing) and reasoning part IDs (new)
const textPartIds = new Set<string>();
const reasoningPartIds = new Set<string>();

// In message.part.updated handler:
if (part?.type === "text") {
  const pid = part.id as string | undefined;
  if (pid) textPartIds.add(pid);
}
if (part?.type === "reasoning") {
  const pid = part.id as string | undefined;
  if (pid) reasoningPartIds.add(pid);
}

// In message.part.delta handler:
if (partId && delta) {
  if (textPartIds.has(partId)) {
    writer.writeText(delta);
    continue;
  }
  // Only route reasoning when --show-reasoning is active
  if (opts.showReasoning && reasoningPartIds.has(partId)) {
    writer.writeThinking(delta);
    continue;
  }
}

// For formatted events (replaces Phase 2 shim):
const formatted = formatSseEvent(event);
if (formatted != null) {
  writer.writeLine(formatted.text, { dim: formatted.dim });
}

// In finally block:
writer?.destroy();
```

- [ ] Create `StreamWriter` instance when `!quiet`
- [ ] Track `reasoningPartIds` set (register on `message.part.updated` with `part.type === "reasoning"`)
- [ ] Route text deltas to `writer.writeText()`
- [ ] Route reasoning deltas to `writer.writeThinking()` only when `opts.showReasoning` is true
- [ ] Route formatted events to `writer.writeLine()` with dim flag
- [ ] Remove `streamingLine` flag (StreamWriter handles this)
- [ ] Remove temporary 2-space indent from Phase 2 shim
- [ ] Call `writer.destroy()` in finally block
- [ ] Suppress reasoning deltas gracefully when `reasoningPartIds` is empty (model doesn't emit reasoning)

### 3.2 `--show-reasoning` CLI flag

Thread a `showReasoning` boolean through `opts` from the CLI argument parser to
`writeEventsToLog()`. The flag defaults to `false`. When false, reasoning part
IDs are still tracked (for future use / log completeness) but deltas for those
parts are not routed to the writer.

- [ ] Add `--show-reasoning` to CLI argument parser
- [ ] Thread `showReasoning: boolean` through opts to `writeEventsToLog()`
- [ ] Default: `false` (reasoning suppressed, matching current behavior)

### 3.3 Tests

**File:** `5x-cli/test/agents/opencode-rendering.test.ts` (new — adapter-level integration test)

Feeds a synthetic SSE event stream through the rendering code path and asserts
on captured output. Uses injectable writer to capture all output without
touching real stdout.

- [ ] Step-finish events are suppressed (no output)
- [ ] Tool running events produce single-line dim output
- [ ] Tool completed events produce single-line dim output (newlines collapsed)
- [ ] Tool error events produce single-line non-dim output with `!` prefix
- [ ] Text deltas are word-wrapped at the configured width
- [ ] Text deltas preserve leading whitespace and newlines from the model
- [ ] Fenced code blocks in text deltas are not word-wrapped
- [ ] Reasoning deltas are suppressed when `showReasoning` is false
- [ ] Reasoning deltas produce dim output when `showReasoning` is true

### 3.4 Verify end-to-end

- [ ] Run `bun test --concurrent --dots` — all tests pass
- [ ] Run `bun run lint` — no warnings
- [ ] Run `bun run typecheck` — no errors
- [ ] Manual smoke test: `5x run --auto` on a test plan, verify output format

---

## Files Touched

| File | Phase | Change |
|------|-------|--------|
| `5x-cli/src/utils/ansi.ts` | 1 | New — `resolveAnsi()` pure function |
| `5x-cli/src/utils/stream-writer.ts` | 1 | New — StreamWriter class with word wrap, fence detection, truncation |
| `5x-cli/test/utils/ansi.test.ts` | 1 | New — color detection tests (pure, no mocking) |
| `5x-cli/test/utils/stream-writer.test.ts` | 1 | New — word wrap, whitespace preservation, fence, style, truncation tests |
| `5x-cli/src/utils/sse-formatter.ts` | 2 | Return type change, format simplification, tool-aware input, bounded collapse |
| `5x-cli/src/agents/opencode.ts` | 2, 3 | Phase 2: consume new return type (shim). Phase 3: wire StreamWriter, add reasoning routing |
| `5x-cli/test/utils/sse-formatter.test.ts` | 2 | Update ~50 assertions for new format and return type |
| `5x-cli/test/agents/opencode-rendering.test.ts` | 3 | New — adapter-level rendering integration test |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `ansi.test.ts` | NO_COLOR, FORCE_COLOR, FORCE_COLOR=0, isTTY detection — pure function, no mocking |
| Unit | `stream-writer.test.ts` | Word wrap, column tracking, whitespace preservation, fenced code bypass, ANSI styles, truncation, injectable writer+ansi |
| Unit | `sse-formatter.test.ts` | New return type, tool-specific input summaries, bounded collapse, dim flags, ASCII markers |
| Integration | `opencode-rendering.test.ts` | Full rendering pipeline: step-finish suppression, tool line format, text wrapping, reasoning gating |
| Integration | Existing orchestrator tests | No regression — formatter output routed through quiet-gated log() |

---

## Not In Scope

- **TUI mode output** — TUI owns the terminal; this plan only affects headless (non-TUI) console output
- **Log file format changes** — NDJSON log files are untouched; every SSE event still logged in full
- **Orchestrator status messages** — Messages from the `log()` helper in `phase-execution-loop.ts` and `plan-review-loop.ts` (e.g. "Author implementing phase 1...") keep their current format
- **Color themes / configurable styles** — Only `dim` is used; no broader theming system
- **Interactive/non-auto mode** — Currently gated off from TUI; headless readline output is unchanged
- **Terminal resize (`SIGWINCH`)** — Reacting to terminal resize mid-run to update wrap width is a useful enhancement but out of scope for this iteration. StreamWriter accepts width at construction; a future follow-up could re-read `process.stdout.columns` on `SIGWINCH`.

---

## Provenance

Follows up on [004-impl-5x-cli-tui](004-impl-5x-cli-tui.md) Phase 2 closure.
During TUI integration, orchestrator stdout was quiet-gated (v1.6) and routed
through a DI logger. The console output format itself was not changed — this
plan addresses the readability of that output in headless mode, which was
identified as a separate concern during review.
