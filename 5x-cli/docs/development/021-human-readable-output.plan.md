# Human-Readable Output Mode

**Version:** 1.0
**Created:** March 15, 2026
**Status:** Draft

## Overview

The commander migration (020) standardized all command output around JSON
envelopes (`{ ok, data }`) to support pipe-chain composition. In practice,
humans reading CLI output must parse JSON visually or pipe through `jq`,
sacrificing ergonomics for machine readability. This plan adds a global
`--text` output mode that produces human-readable output for all commands,
while preserving JSON as the deterministic default.

The design prioritizes consistency: one global flag, one env var, one rule.
Every command that uses `outputSuccess()` participates in the output format
system. No per-command flags, no per-command defaults, no memorization.

## Design Decisions

**JSON is always the default. `--text` opts into human-readable output.**
Deterministic defaults matter. A user building a pipe chain tests individual
commands in a terminal, then pipes them together. If output format changed
based on TTY detection, the tested output (text) would differ from the piped
output (JSON) — a footgun. `--pretty` gets away with TTY auto-detection
because it only mutates whitespace, not structure. Output format changes
structure, so it must be explicit.

**Global pre-parse argv stripping, identical to `--pretty`.** `--text` and
`--json` are stripped from `process.argv` before Commander parses, setting
global state in `output.ts`. This means: no per-command option registration,
works at any argv position (`5x --text run state`, `5x run state --text`),
applies to error envelopes, and uses the exact same mechanism as the
existing `--pretty`/`--no-pretty` handling.

**`5X_OUTPUT_FORMAT` environment variable for session defaults.** Accepts
`text` or `json`. Lets a user `export 5X_OUTPUT_FORMAT=text` in their shell
profile for a persistently human-friendly experience. CLI flags override it.
Precedence: `--text`/`--json` flag > `5X_OUTPUT_FORMAT` env > `json`
(default).

**`outputSuccess(data, textFormatter?)` — optional formatter argument.**
The existing `outputSuccess<T>(data: T)` signature gains an optional second
argument: a function `(data: T) => void` that writes human-readable output
to stdout. When output format is `text` and a formatter is provided, the
formatter is called instead of writing the JSON envelope. When output format
is `text` and no formatter is provided, a built-in generic text formatter
renders key-value pairs with aligned columns. This is backward-compatible —
existing call sites with no formatter continue to work, and gain basic text
output for free via the generic fallback.

**Built-in generic text formatter as the universal fallback.** A ~40-line
function in `output.ts` renders any JSON-serializable data as aligned
key-value text, with nested object indentation and arrays rendered as
comma-separated lists or grouped blocks. This covers simple commands (like
`run complete`: `run_id  R1`, `status  completed`) without any custom code.
Commands with complex output (like `run state` with its step table) get
custom formatters for better presentation. Rolling our own rather than
adding a dependency — it's trivial code tailored to our data conventions.

**Errors follow the output format.** In JSON mode, errors are JSON envelopes
on stdout (unchanged). In text mode, errors are `Error: <message>` on
stderr. This is handled centrally in `bin.ts`'s catch block, which already
knows the output format from global state. Consistency: if you ask for text,
you get text for both success and failure.

**Custom formatters are co-located with handlers.** Each handler file can
define private `format*Text()` functions passed to `outputSuccess()`. No
ANSI colors — plain text only, clean for redirection. Custom formatters are
only written for commands where the generic fallback is inadequate.

**Incremental formatter rollout via graceful degradation.** Commands without
a custom formatter fall back to the generic text formatter in `--text` mode.
This means the infrastructure can ship and every command gets some text
output immediately. Custom formatters are added for high-value commands
first, and the rest can be improved incrementally based on usage.

**Grandfathered commands.** `init`, `upgrade`, and `harness install` write
progressive human-readable text directly to stdout via `console.log`. They
do not use `outputSuccess()` and do not participate in the output format
system. Retrofitting them would require collecting output before printing,
changing their progressive UX. They are setup commands that humans always
run interactively — their current behavior is already correct.

## Formatter Strategy

Three tiers of text output quality:

### Tier 1 — Custom formatters (high-value human commands)

Commands where the generic formatter is inadequate due to complex or
special data shapes. Custom formatters are written as part of this plan.

| Command | Custom format |
|---------|--------------|
| `diff` | Raw diff text to stdout (like `git diff`). `--stat` prepends stat summary. |
| `run state` | Run info header, padded step table, summary line with totals |
| `run list` | Column-aligned table: ID, plan, status, steps, date |
| `plan phases` | Checklist: `[x] Phase 1: Title (3/5)` |

### Tier 2 — Generic formatter is good enough

Commands with simple, flat data shapes where aligned key-value output is
perfectly readable. No custom formatter needed.

| Command | Generic output example |
|---------|----------------------|
| `run complete` | `run_id  R1` / `status  completed` |
| `run reopen` | `run_id  R1` / `status  active` / `previous_status  completed` |
| `quality run` | `passed  true` / `results:` / (nested) |
| `template render` | `template  author-next-phase` / `prompt  ...` |
| `harness list` | Key-value with nested scopes |
| `harness uninstall` | Key-value with removed/notFound lists |
| `skills install` | `scope  project` / `created  skill1, skill2` |
| `skills uninstall` | `scope  project` / nested removed/notFound |
| `prompt choose` | `choice  option-a` |
| `prompt confirm` | `confirmed  true` |
| `prompt input` | `input  user text here` |
| `run init` | `run_id  R1` / `plan_path  ...` / `status  active` |
| `invoke author` | `run_id  R1` / `result:` / (nested) |
| `run record` | `step_id  S1` / `step_name  author:phase-1` |
| `protocol validate *` | `role  author` / `valid  true` / `result:` / (nested) |

### Tier 3 — Grandfathered (outside the system)

| Command | Behavior |
|---------|----------|
| `init` | Progressive `console.log` text (unchanged) |
| `upgrade` | Progressive `console.log` text (unchanged) |
| `harness install` | Progressive `console.log` text (unchanged) |
| `run watch` | NDJSON or `--human-readable` streaming (unchanged) |

## Phase 1: Output Format Infrastructure

**Completion gate:** `output.ts` exports `setOutputFormat`, `getOutputFormat`,
`formatGenericText`, and an updated `outputSuccess` with optional formatter.
`bin.ts` strips `--text`/`--json` from argv, reads `5X_OUTPUT_FORMAT`, and
handles errors in text mode. `bun run typecheck` passes. No behavioral
changes yet (no formatters registered, default is still JSON).

### Phase 1a: Output format state (`src/output.ts`)

- [ ] Add output format type and state management below the pretty-print
  state block (after line 119):

  ```ts
  // ---------------------------------------------------------------------------
  // Output format state
  // ---------------------------------------------------------------------------

  type OutputFormat = "json" | "text";

  let outputFormat: OutputFormat = "json";

  /** Set the output format. Called from bin.ts based on --text/--json/env. */
  export function setOutputFormat(format: OutputFormat): void {
    outputFormat = format;
  }

  /** Get the current output format. */
  export function getOutputFormat(): OutputFormat {
    return outputFormat;
  }
  ```

- [ ] Add the generic text formatter:

  ```ts
  // ---------------------------------------------------------------------------
  // Generic text formatter
  // ---------------------------------------------------------------------------

  /**
   * Render any JSON-serializable data as human-readable aligned key-value
   * text. Used as the fallback when --text is active and no custom formatter
   * is provided to outputSuccess().
   *
   * - Object keys are left-padded to align values
   * - Nested objects are indented
   * - Arrays of primitives are comma-joined on one line
   * - Arrays of objects are rendered as separated blocks
   * - Null/undefined values are omitted
   */
  export function formatGenericText(
    data: unknown,
    indent: number = 0,
  ): void {
    const pad = "  ".repeat(indent);

    if (data == null) return;

    if (typeof data !== "object") {
      console.log(`${pad}${data}`);
      return;
    }

    if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (typeof item === "object" && item !== null) {
          formatGenericText(item, indent);
          if (i < data.length - 1) console.log();
        } else {
          console.log(`${pad}${item}`);
        }
      }
      return;
    }

    const entries = Object.entries(data as Record<string, unknown>)
      .filter(([, v]) => v != null);
    if (entries.length === 0) return;

    const maxKey = Math.max(...entries.map(([k]) => k.length));

    for (const [key, value] of entries) {
      if (typeof value === "object" && !Array.isArray(value)) {
        console.log(`${pad}${key}:`);
        formatGenericText(value, indent + 1);
      } else if (Array.isArray(value)) {
        if (value.length === 0) continue;
        if (value.every((v) => typeof v !== "object")) {
          console.log(`${pad}${key.padEnd(maxKey)}  ${value.join(", ")}`);
        } else {
          console.log(`${pad}${key}:`);
          formatGenericText(value, indent + 1);
        }
      } else {
        console.log(`${pad}${key.padEnd(maxKey)}  ${value}`);
      }
    }
  }
  ```

- [ ] Update `outputSuccess` signature (line 128) to accept an optional
  text formatter:

  ```ts
  export function outputSuccess<T>(
    data: T,
    textFormatter?: (data: T) => void,
  ): void {
    if (outputFormat === "text") {
      if (textFormatter) {
        textFormatter(data);
      } else {
        formatGenericText(data);
      }
      return;
    }
    // JSON mode (default) — unchanged
    const normalized = data === undefined ? null : data;
    const envelope = { ok: true as const, data: normalized };
    console.log(jsonStringify(envelope));
  }
  ```

- [ ] Verify `bun run typecheck` passes

### Phase 1b: Argv stripping and env var (`src/bin.ts`)

- [ ] Add `--text`/`--json` pre-parse argv stripping block after the
  existing `--pretty`/`--no-pretty` block (after line 40). Same pattern:

  ```ts
  // ---------------------------------------------------------------------------
  // Global --text / --json flags (pre-parse argv strip)
  // Accepted anywhere in argv. Last flag wins. Sets output format before
  // commander parses. --text produces human-readable output; --json (default)
  // produces JSON envelopes.
  // ---------------------------------------------------------------------------
  import { setOutputFormat, getOutputFormat } from "./output.js";

  {
    // 1. Environment variable sets the baseline (lowest priority)
    const envFormat = process.env["5X_OUTPUT_FORMAT"];
    if (envFormat === "text" || envFormat === "json") {
      setOutputFormat(envFormat);
    }

    // 2. CLI flags override env (highest priority, last flag wins)
    const indices: { idx: number; format: "text" | "json" }[] = [];
    for (let i = process.argv.length - 1; i >= 0; i--) {
      if (process.argv[i] === "--text") {
        indices.push({ idx: i, format: "text" });
      } else if (process.argv[i] === "--json") {
        indices.push({ idx: i, format: "json" });
      }
    }
    if (indices.length > 0) {
      const last = indices.reduce((a, b) => (a.idx > b.idx ? a : b));
      setOutputFormat(last.format);
      for (const { idx } of indices.sort((a, b) => b.idx - a.idx)) {
        process.argv.splice(idx, 1);
      }
    }
  }
  ```

- [ ] Update error handler in `bin.ts` catch block. For each of the three
  error branches (CliError, CommanderError, generic Error), add text mode
  handling before the existing JSON path:

  ```ts
  // CliError branch (line 68):
  if (err instanceof CliError) {
    if (getOutputFormat() === "text") {
      console.error(`Error: ${err.message}`);
      process.exit(err.exitCode);
    }
    // ... existing JSON envelope code unchanged ...
  }

  // CommanderError branch (line 80):
  if (err instanceof CommanderError) {
    if (err.code === "commander.helpDisplayed" ||
        err.code === "commander.version") {
      process.exit(0);
    }
    if (getOutputFormat() === "text") {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    // ... existing JSON envelope code unchanged ...
  }

  // Generic error branch (line 108):
  const message = err instanceof Error ? err.message : String(err);
  if (getOutputFormat() === "text") {
    console.error(`Error: ${message}`);
    process.exit(1);
  }
  // ... existing JSON envelope code unchanged ...
  ```

- [ ] Add `setOutputFormat` and `getOutputFormat` to the import from
  `./output.js` on line 16

- [ ] Verify `bun run typecheck` passes
- [ ] Manual verification:
  - `5x run list` → JSON envelope (default, unchanged)
  - `5x --text run list` → generic text output
  - `5x run list --text` → generic text output (any position)
  - `5X_OUTPUT_FORMAT=text 5x run list` → generic text output
  - `5x --text --json run list` → JSON (last flag wins)
  - `5x --text run init` (missing `--plan`) → `Error: ...` on stderr
  - `5x run init` (missing `--plan`) → JSON error envelope on stdout

## Phase 2: Custom Formatters

**Completion gate:** Four custom formatter functions exist in their
respective handler files. Each is a private function that writes to stdout.
Not yet wired to `outputSuccess` — they are standalone functions at this
point. `bun run typecheck` passes.

- [ ] `src/commands/diff.handler.ts` — Add `formatDiffText()`:
  ```ts
  function formatDiffText(data: Record<string, unknown>): void {
    const stat = data.stat as {
      files_changed: number;
      insertions: number;
      deletions: number;
    } | undefined;
    if (stat) {
      console.log(
        ` ${stat.files_changed} file(s) changed,` +
        ` ${stat.insertions} insertion(s),` +
        ` ${stat.deletions} deletion(s)`
      );
    }
    const diff = data.diff as string;
    if (diff) {
      process.stdout.write(diff);
      if (!diff.endsWith("\n")) process.stdout.write("\n");
    }
  }
  ```
  Raw diff text to stdout. Stat summary precedes diff when present. File
  list, ref, and run_id are omitted (implicit in the diff itself or not
  useful to humans).

- [ ] `src/commands/run-v1.handler.ts` — Add `formatStateText()`:
  ```
  Run:     R-abc123
  Plan:    docs/development/015-test-separation.md
  Status:  active
  Created: 2026-03-15 10:30:00

  Steps:
    #  Step                    Phase  Iter  Duration  Created
    1  author:phase-1          1      1     2m 15s    2026-03-15 10:32:00
    2  reviewer:phase-1        1      1     1m 30s    2026-03-15 10:35:00
    3  quality:check           1      1     45s       2026-03-15 10:37:00

  Summary: 3 steps | Phases completed: 1 | Cost: $0.42 | Duration: 4m 30s
  ```
  Padded columns for step table. Duration formatted as `Xm Ys` or `Xs`.
  Cost as `$X.XX`. Omit columns where all values are null (e.g., no cost
  data → no Cost column). The function receives the same data shape that
  `outputSuccess` currently gets: `{ run, steps, summary }`.

- [ ] `src/commands/run-v1.handler.ts` — Add `formatListText()`:
  ```
  ID          Plan                                          Status     Steps  Created
  R-abc123    docs/development/015-test-separation.md       active     3      2026-03-15
  R-def456    docs/development/010-cli-composability.md     completed  12     2026-03-14
  ```
  Column-aligned with space padding. Truncate long plan paths with `...`
  if exceeding 50 chars. Print `(no runs)` if empty.

- [ ] `src/commands/plan-v1.handler.ts` — Add `formatPhasesText()`:
  ```
  Phases:
    [x] Phase 1: Dependency Swap and Program Skeleton (3/3)
    [x] Phase 2: Migrate Adapter Files (13/13)
    [ ] Phase 3: Rewrite Entry Point (0/5)
    [ ] Phase 4: Update Tests (0/8)
  ```
  Checkbox notation. `(done/total)` suffix shows checklist progress.

- [ ] Verify `bun run typecheck` passes

## Phase 3: Register Formatters and Clean Up stderr

**Completion gate:** Custom formatters are wired into `outputSuccess()` calls.
Auxiliary stderr output is removed from handlers that used it as a
human-readable workaround. `--text` mode produces custom-formatted output
for Tier 1 commands and generic-formatted output for all others.
`bun run typecheck` passes. Manual verification of all four
custom-formatted commands in `--text` mode.

### Phase 3a: Register formatters at call sites

- [ ] `src/commands/diff.handler.ts` line 187 — Change:
  ```ts
  outputSuccess(data);
  ```
  to:
  ```ts
  outputSuccess(data, formatDiffText);
  ```

- [ ] `src/commands/run-v1.handler.ts` line 683 — Change:
  ```ts
  outputSuccess({ run: { ... }, steps: ..., summary });
  ```
  to:
  ```ts
  outputSuccess({ run: { ... }, steps: ..., summary }, formatStateText);
  ```

- [ ] `src/commands/run-v1.handler.ts` line 1017 — Change:
  ```ts
  outputSuccess({ runs: ... });
  ```
  to:
  ```ts
  outputSuccess({ runs: ... }, formatListText);
  ```

- [ ] `src/commands/plan-v1.handler.ts` line 59 — Change:
  ```ts
  outputSuccess(result);
  ```
  to:
  ```ts
  outputSuccess(result, formatPhasesText);
  ```

- [ ] All other `outputSuccess()` call sites remain unchanged — they
  automatically get the generic text formatter in `--text` mode.

### Phase 3b: Remove auxiliary stderr output

The following `console.error` calls were a workaround for JSON-only stdout
— they provided human-readable feedback when stdout was always a JSON
envelope. With `--text` mode, this feedback is provided by the text
formatter (custom or generic) on stdout, making the stderr copies
redundant. In JSON mode, the user has opted for machine output and does
not need auxiliary human text on stderr.

**Legitimate stderr usage is NOT removed.** Warnings (deprecation notices,
non-fatal recording failures, watch-mode errors), streaming output,
framework routing, and prompt UI output all remain on stderr. The rule:
stderr is for warnings and diagnostics, not for duplicating structured
data that belongs on stdout.

- [ ] `src/commands/harness.handler.ts` — Delete `printListSummary()`
  function (lines 220–234) and remove its call in `harnessList()`
  (line 162). The function writes harness name, scope status, and file
  lists to stderr — all of which are available via `outputSuccess()` in
  JSON mode or the generic text formatter in `--text` mode.

- [ ] `src/commands/harness.handler.ts` — Delete `printUninstallSummary()`
  function (lines 314–334) and remove its call in `harnessUninstall()`
  (line 247). The function writes removed/not-found skill and agent
  lists plus a completion message to stderr — all duplicated in the
  `outputSuccess()` envelope.

- [ ] `src/commands/skills.handler.ts` — Remove the 3 `console.error`
  progress lines in `skillsInstall()` (lines 112–122):
  ```ts
  // DELETE these lines:
  console.error(`  Created ${targetDisplay}${name}/SKILL.md`);
  console.error(`  Overwrote ${targetDisplay}${name}/SKILL.md`);
  console.error(`  Skipped ${targetDisplay}${name}/SKILL.md (already exists)`);
  ```
  The created/overwritten/skipped arrays are already in the
  `outputSuccess()` data. The generic text formatter renders them.

- [ ] `src/commands/skills.handler.ts` — Remove the 2 `console.error`
  progress lines in `skillsUninstall()` (lines 204–209):
  ```ts
  // DELETE these lines:
  console.error(`  Removed ${targetDisplay}${entry}`);
  console.error(`  Not found ${targetDisplay}${entry}`);
  ```
  The removed/notFound arrays are already in the `outputSuccess()` data.

### Phase 3c: Verify

- [ ] Verify `bun run typecheck` passes
- [ ] Manual verification:
  - `5x --text diff` → raw diff text
  - `5x --text run state -r <id>` → formatted step table
  - `5x --text run list` → column-aligned table
  - `5x --text plan phases <path>` → checklist
  - `5x --text run complete -r <id>` → generic key-value text
  - `5x --text skills install project` → generic key-value text
  - `5x --text harness list` → generic key-value text
  - `5x run state -r <id>` → JSON envelope (default unchanged)
  - `5x harness list` → JSON envelope only, no stderr summary
  - `5x skills install project` → JSON envelope only, no stderr progress

## Phase 4: Tests

**Completion gate:** `bun test` passes. Existing tests are unchanged (they
test JSON mode, which is still the default). New tests cover `--text` mode
for custom-formatted commands, generic-formatted commands, error handling,
and the env var.

### Phase 4a: Unit tests for new output infrastructure

- [ ] `test/unit/output.test.ts` — Add tests for output format state:
  - `setOutputFormat("text")` / `getOutputFormat()` round-trip
  - Default format is `"json"`
  - `setOutputFormat("json")` resets to JSON

- [ ] `test/unit/output.test.ts` — Add tests for `formatGenericText()`:
  - Flat object → aligned key-value lines
  - Nested object → indented key-value
  - Array of primitives → comma-joined
  - Array of objects → separated blocks
  - Null values omitted
  - Empty object → no output

- [ ] `test/unit/output.test.ts` — Add tests for `outputSuccess` with
  formatter:
  - `outputFormat = "json"`: formatter is NOT called, JSON envelope written
  - `outputFormat = "text"` with formatter: formatter IS called, no JSON
  - `outputFormat = "text"` without formatter: generic formatter called

### Phase 4b: Integration tests for `--text` flag and env var

- [ ] Add test file `test/integration/commands/text-output.test.ts`:
  - `--text` at start of argv: `5x --text run list` → no `{"ok"` in stdout
  - `--text` at end of argv: `5x run list --text` → no `{"ok"` in stdout
  - `--json` overrides `--text`: `5x --text --json run list` → JSON envelope
  - `5X_OUTPUT_FORMAT=text`: env var activates text mode
  - `--json` overrides env var: `5X_OUTPUT_FORMAT=text 5x --json run list`
    → JSON envelope
  - Unknown format env value ignored: `5X_OUTPUT_FORMAT=bogus 5x run list`
    → JSON envelope (default)

### Phase 4c: Integration tests for text-mode errors

- [ ] In `test/integration/commands/text-output.test.ts`:
  - `5x --text run init` (missing `--plan`) → stderr contains `Error:`,
    stdout is empty, exit code 1
  - `5x --text run complete -r nonexistent` → stderr contains `Error:`,
    stdout is empty
  - JSON mode error unchanged: `5x run init` (missing `--plan`) → stdout
    contains `{"ok":false`, stderr may have Commander help text

### Phase 4d: Integration tests for custom formatters

- [ ] In `test/integration/commands/text-output.test.ts` or co-located with
  existing command tests:
  - `5x --text diff` in a repo with changes → stdout contains raw diff
    text, not `{"ok"`. Stdout does not contain `"data"` or `"ref"`.
  - `5x --text diff --stat` → stdout contains `file(s) changed` summary
  - `5x --text run state -r <id>` → stdout contains `Run:`, `Steps:`,
    `Summary:` section headers
  - `5x --text run list` → stdout contains column headers (ID, Plan, etc.)
  - `5x --text run list` with no runs → stdout contains `(no runs)` or
    similar empty message
  - `5x --text plan phases <path>` → stdout contains `[x]` or `[ ]`
    checkbox notation

### Phase 4e: Integration tests for generic formatter fallback

- [ ] In `test/integration/commands/text-output.test.ts`:
  - `5x --text run complete -r <id>` → stdout contains `run_id` and
    `status` as plain text, not wrapped in JSON
  - `5x --text skills install project` → stdout contains `scope` and
    `created` as plain text

### Phase 4f: Update tests affected by stderr cleanup

The auxiliary stderr output removed in Phase 3b has test assertions that
need updating:

- [ ] `test/integration/commands/harness.test.ts` line 565–566 — Remove
  assertions `expect(uninstallResult.stderr).toContain("Removed")` and
  `expect(uninstallResult.stderr).toContain("uninstall complete")`.
  These asserted on `printUninstallSummary()` stderr output which no
  longer exists.

- [ ] `test/integration/commands/skills-install.test.ts` lines 88, 210,
  237 — Remove assertions `expect(stderr).toContain("Created ...")`.
  These asserted on the `console.error` progress lines which no longer
  exist.

### Phase 4g: Verify existing tests pass

- [ ] All existing integration tests pass (with the stderr assertion
  updates from Phase 4f applied)
- [ ] Pipe tests (`invoke-pipe.test.ts`, `run-record-pipe.test.ts`,
  `pipe.test.ts`) pass unchanged
- [ ] `bin-pretty.test.ts` passes unchanged (`--pretty` is orthogonal to
  `--text`)
- [ ] Full suite: `bun test` passes

## Phase 5: Documentation and Help Text

**Completion gate:** Documentation reflects the new output format system.
`bun run typecheck` passes. Help text mentions `--text`/`--json` and
`5X_OUTPUT_FORMAT`.

- [ ] `src/program.ts` — Update program-level description and footer:
  - Add `--text`/`--json` and `5X_OUTPUT_FORMAT` to the help footer
  - Explain that JSON is the default, `--text` switches to human-readable
  - Note the precedence: `--text`/`--json` > `5X_OUTPUT_FORMAT` > json
  - List grandfathered commands (init, upgrade, harness install) that
    always produce human-readable text

- [ ] `docs/v1/101-cli-primitives.md` — Add a section on output format:
  - Document `--text` and `--json` global flags
  - Document `5X_OUTPUT_FORMAT` env var
  - Document precedence chain
  - Note which commands have custom text formatters vs generic fallback
  - Note grandfathered commands

- [ ] `docs/v1/100-architecture.md` — Add output format system to
  architecture description. Reference the formatter tiers (custom, generic
  fallback, grandfathered).

- [ ] `docs/v1/102-agent-skills.md` — No changes needed. Skills call
  commands without `--text`, so they always get JSON (the default).

## Files Touched

| File | Change |
|------|--------|
| `src/output.ts` | Add output format state, generic text formatter, update `outputSuccess` signature |
| `src/bin.ts` | Add `--text`/`--json` argv stripping, `5X_OUTPUT_FORMAT` env var, text-mode error handling |
| `src/commands/diff.handler.ts` | Add `formatDiffText()`, pass to `outputSuccess` |
| `src/commands/run-v1.handler.ts` | Add `formatStateText()`, `formatListText()`, pass to `outputSuccess` |
| `src/commands/plan-v1.handler.ts` | Add `formatPhasesText()`, pass to `outputSuccess` |
| `src/commands/harness.handler.ts` | Delete `printListSummary()`, `printUninstallSummary()` and their call sites |
| `src/commands/skills.handler.ts` | Remove 5 `console.error` progress lines from install/uninstall handlers |
| `src/program.ts` | Update help footer |
| `test/unit/output.test.ts` | Add tests for format state, generic formatter, outputSuccess with formatter |
| `test/integration/commands/text-output.test.ts` | **New** — `--text` flag, env var, custom/generic formatters, error handling |
| `docs/v1/100-architecture.md` | Add output format system docs |
| `docs/v1/101-cli-primitives.md` | Add output format section |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `output.test.ts` | Format state, generic formatter, outputSuccess branching |
| Integration | `text-output.test.ts` | `--text`/`--json` flags, env var, precedence, custom formatters, generic fallback, text-mode errors |
| Integration | All existing tests (unchanged) | JSON default preserved — full non-regression |
| Integration | `harness.test.ts` (existing) | Verify no stderr summary after `printListSummary`/`printUninstallSummary` removal |
| Integration | `skills-install.test.ts` (existing) | Verify no stderr progress after `console.error` removal |

## Estimated Scope

| Phase | Files | Estimate |
|-------|-------|----------|
| Phase 1: Infrastructure | `output.ts`, `bin.ts` | 0.5 days |
| Phase 2: Custom formatters | 3 handler files | 1 day |
| Phase 3: Wire + stderr cleanup | 5 handler files | 0.5 days |
| Phase 4: Tests | 2 test files | 1 day |
| Phase 5: Documentation | 3 doc/help files | 0.5 days |
| **Total** | **~12 files** | **3.5 days** |

## Not In Scope

- TTY auto-detection for output format (explicit-only by design decision)
- ANSI colors or terminal width detection in formatters
- Retrofitting `init`, `upgrade`, `harness install` into the output format
  system (grandfathered — they use progressive `console.log`)
- Changing `run watch` output (already has `--human-readable` flag)
- Per-command `--text`/`--json` flags (global only)
- `--pretty`/`--no-pretty` interaction with text mode (`--pretty` is
  ignored in text mode — it only affects JSON formatting)
- Custom formatters for Tier 2 commands (generic fallback is sufficient;
  custom formatters can be added later based on usage)
