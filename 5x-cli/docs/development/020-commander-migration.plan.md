# Migrate CLI Framework from citty to Commander.js

**Version:** 1.3
**Created:** March 14, 2026
**Status:** Draft

## Overview

The 5x-cli uses citty v0.1.6 as its CLI framework. citty's minimalism forces
102 lines of parse workarounds, 45 lines of argv hacks, manual `--help`/
`--version` handling, and untyped option access across 14 source files (~650
lines of adapter + entry point code). The 008 refactor decoupled all business
logic into `*.handler.ts` files with zero citty imports, isolating the
migration surface.

This plan replaces citty with commander.js (via `@commander-js/extra-typings`)
across 14 source files and 1 config file, rewrites the entry point, adapts the
parse-args utility, and updates integration tests that assert on
framework-generated output. Handler files remain untouched.

## Design Decisions

**Use `@commander-js/extra-typings` instead of plain `commander`.** The
extra-typings package infers option types from flag definition strings,
eliminating all `as string` casts in adapter code. It's maintained by the
commander.js team and is the recommended TypeScript approach. Trade-off:
extra dependency, but it's a thin wrapper over `commander` with negligible overhead.

**Eager registration over lazy `import()`.** citty used dynamic `import()` for
lazy-loading subcommands. Commander doesn't execute action handlers at
registration time, so eager registration is safe and simpler. Adapter files are
thin (~20-60 lines each) — the import cost is negligible.

**`exitOverride` + `configureOutput` for JSON envelope preservation.** Commander
normally calls `process.exit()` on errors. `exitOverride()` rethrows
`CommanderError`, caught by bin.ts's error handler which maps Commander error
codes to distinct envelope codes per the PRD contract
(`commander.unknownCommand` → `UNKNOWN_COMMAND`,
`commander.unknownOption` → `UNKNOWN_OPTION`, other parse errors →
`INVALID_ARGS`) and routes through the existing JSON envelope system.
`configureOutput()` sends framework errors to stderr. This preserves the
machine-readable error contract.

**Consolidate `--worktree`/`--worktree-path` into `--worktree [path]` with
backward compatibility.** Commander's optional-value syntax natively supports
"boolean or value," so `--worktree [path]` replaces the 15-line argv splice
hack in bin.ts. The adapter maps the single option to both handler params
(`worktree: boolean`, `worktreePath?: string`). For backward compatibility,
`--worktree-path <path>` is kept as a hidden option (`.hideHelp()`) that maps
to the same handler param. When `--worktree-path` is used, a deprecation
warning is emitted to stderr: `"Warning: --worktree-path is deprecated, use
--worktree <path> instead"`. This preserves existing automation and tests
while guiding users to the new syntax. The hidden alias can be removed in a
future release.

**Retain pre-parse argv stripping for `--pretty`/`--no-pretty`.** The current
pre-parse approach (scan `process.argv`, apply last-wins, strip all
occurrences before handing argv to commander) is preserved rather than
replaced with a `preAction` hook. Rationale: `preAction` hooks only run when
a command action executes — they do not fire for parse-time validation
failures, `--help`, or `--version` flows. The pre-parse approach guarantees
`--pretty`/`--no-pretty` is accepted at any argv position, applies
formatting to parse-error JSON envelopes, and matches current test behavior.
The `--pretty` and `--no-pretty` flags are NOT registered as commander
options (they are stripped before commander sees them), avoiding conflicts
with commander's own option parsing.

**Adapt `parse-args.ts` to commander's `argParser` callback signature.** The
existing `parseIntArg`, `parseFloatArg`, `parseTimeout` functions are wrapped
to match commander's `(value: string, previous: T) => T` pattern. The
unwrapped functions are retained for backward compatibility with unit tests.
Adapters no longer call parsers in their `run` handlers — parsing happens
declaratively in option definitions.

**Phase the work to maintain a passing test suite at every checkpoint.** Phase
1 sets up the dependency and builds the program skeleton. Phase 2 migrates all
adapter files. Phase 3 wires up the entry point. Phase 4 updates tests. Phase
5 adds help content. Each phase is independently testable.

## Phase 1: Dependency Swap and Program Skeleton

**Completion gate:** `bun install` succeeds. A minimal `program` object is
exported from a new `src/program.ts` that can be imported without errors.
`bun run typecheck` passes.

- [x] Update `package.json` (line 57): replace `"citty": "^0.1.6"` with
  `"commander": "^13.1.0"` in `dependencies` and add
  `"@commander-js/extra-typings": "^13.1.0"` to `dependencies`
  (Note: citty retained alongside commander until Phase 6 removal, to keep
  existing adapter files and tests passing at every phase boundary)
- [x] Run `bun install` to update `bun.lock`
- [x] Create `src/program.ts` — the root commander program factory:

  ```ts
  import { Command } from "@commander-js/extra-typings";
  import { version } from "./version.js";

  export function createProgram(): Command {
    const program = new Command("5x")
      .version(version, "-V, --version")
      .description("A toolbelt of primitives for the 5x workflow")
      .exitOverride()
      .showHelpAfterError("(use --help for additional information)")
      .showSuggestionAfterError(true);

    // Note: --pretty / --no-pretty are NOT registered as commander options.
    // They are handled by pre-parse argv stripping in bin.ts (see design
    // decision above). This ensures they work at any argv position and
    // apply even on parse-error JSON envelopes.

    return program;
  }
  ```

- [x] Verify `bun run typecheck` passes with the new dependency and
  `src/program.ts`

## Phase 2: Migrate Adapter Files

**Completion gate:** All 13 adapter files (`src/commands/*.ts`) are rewritten
to use commander. Each file exports a function that receives a parent
`Command` and adds subcommands/options to it. Zero citty imports remain in
`src/commands/`. `bun run typecheck` passes.

Each adapter file follows a consistent pattern:

```ts
import { Command } from "@commander-js/extra-typings";
import { handlerFn } from "./foo.handler.js";

export function registerFoo(parent: Command) {
  const cmd = parent
    .command("foo")
    .summary("One-line for parent listing")
    .description("Longer description for own --help")
    .option("-f, --flag <value>", "Description")
    .action(async (opts) => {
      await handlerFn({ flag: opts.flag });
    });
}
```

### Phase 2a: Adapt `parse-args.ts`

- [x] Add commander-compatible wrapper functions to `src/utils/parse-args.ts`
  that match the `(value: string, previous: T) => T` signature:

  ```ts
  /** Commander argParser wrapper for parseIntArg */
  export function intArg(flag: string, opts?: { positive?: boolean }) {
    return (value: string, _prev: number): number =>
      parseIntArg(value, flag, opts);
  }

  /** Commander argParser wrapper for parseFloatArg */
  export function floatArg(flag: string, opts?: { nonNegative?: boolean }) {
    return (value: string, _prev: number): number =>
      parseFloatArg(value, flag, opts);
  }

  /** Commander argParser wrapper for parseTimeout */
  export function timeoutArg() {
    return (value: string, _prev: number | undefined): number => {
      const result = parseTimeout(value);
      if (result === undefined) {
        throw new CliError("INVALID_ARGS", "--timeout must be a positive integer");
      }
      return result;
    };
  }

  /** Commander argParser: collect repeatable --var values into string[] */
  export function collect(value: string, prev: string[]): string[] {
    return [...prev, value];
  }
  ```

- [x] Retain existing `parseIntArg`, `parseFloatArg`, `parseTimeout` unchanged
  (unit tests depend on them)

### Phase 2b: Leaf commands (no subcommands)

Migrate the 3 simplest files first — single command, no subcommands:

- [x] Rewrite `src/commands/diff.ts` (40 → ~45 lines):
  - Export `registerDiff(parent: Command)` instead of default citty command
  - Options: `-s, --since <ref>`, `--stat`, `-r, --run <id>`
  - Action calls `runDiff({ since, stat, run })`

- [x] Rewrite `src/commands/init.ts` (32 → ~35 lines):
  - Export `registerInit(parent: Command)`
  - Options: `-f, --force`
  - Action calls `initScaffold({ force })`

- [x] Rewrite `src/commands/upgrade.ts` (27 → ~30 lines):
  - Export `registerUpgrade(parent: Command)`
  - Options: `-f, --force`
  - Action calls `runUpgrade({ force })`

### Phase 2c: Simple parent commands (2-3 subcommands)

- [x] Rewrite `src/commands/prompt.ts` (100 → ~90 lines):
  - Export `registerPrompt(parent: Command)`
  - Parent `prompt` command with subcommands `choose`, `confirm`, `input`
  - `choose`: positional `<message>`, `-o, --options <list>` (required),
    `-d, --default <value>`
  - `confirm`: positional `<message>`, `-d, --default <value>`
    (no `.choices()` — handler accepts `yes/no/y/n/true/false`, validated
    in the handler layer to preserve current behavior)
  - `input`: positional `<message>`, `--multiline`
  - Actions call `promptChoose`, `promptConfirm`, `promptInput`

- [x] Rewrite `src/commands/plan-v1.ts` (38 → ~40 lines):
  - Export `registerPlan(parent: Command)`
  - Parent `plan` command with subcommand `phases`
  - `phases`: positional `<path>`, action calls `planPhases({ path })`

- [x] Rewrite `src/commands/skills.ts` (81 → ~75 lines):
  - Export `registerSkills(parent: Command)`
  - Parent `skills` with subcommands `install`, `uninstall`
  - `install`: positional `<scope>` with `.choices(["user", "project"])`,
    `-f, --force`, `--install-root <dir>`
  - `uninstall`: positional `<scope>` with `.choices(["all", "user", "project"])`,
    `--install-root <dir>`
  - Actions pass `homeDir: process.env.HOME`

### Phase 2d: Medium parent commands (3-5 subcommands)

- [x] Rewrite `src/commands/harness.ts` (96 → ~90 lines):
  - Export `registerHarness(parent: Command)`
  - Parent `harness` with subcommands `install`, `list`, `uninstall`
  - `install`: positional `<name>`, `-s, --scope <scope>` with
    `.choices(["user", "project"])`, `-f, --force`
  - `list`: no options
  - `uninstall`: positional `<name>`, `-s, --scope <scope>` with
    `.choices(["user", "project"])`, `--all`
  - Actions pass `homeDir: process.env.HOME`

- [x] Rewrite `src/commands/template.ts` (61 → ~60 lines):
  - Export `registerTemplate(parent: Command)`
  - Parent `template` with subcommand `render`
  - `render`: positional `<template>`, `-r, --run <id>`,
    `--var <key=value>` with `.argParser(collect)` and default `[]`,
    `--session <id>`, `-w, --workdir <path>`
  - Action calls `templateRender({ template, run, vars, session, workdir })`

- [x] Rewrite `src/commands/quality-v1.ts` (60 → ~55 lines):
  - Export `registerQuality(parent: Command)`
  - Parent `quality` with subcommand `run`
  - `run`: `--record`, `--record-step <name>`, `-r, --run <id>`,
    `--phase <name>`, `-w, --workdir <path>`
  - Action calls `runQuality({ record, recordStep, run, phase, workdir })`

- [x] Rewrite `src/commands/worktree.ts` (137 → ~120 lines):
  - Export `registerWorktree(parent: Command)`
  - Parent `worktree` with subcommands `create`, `attach`, `detach`,
    `remove`, `list`
  - `create`: `-p, --plan <path>` (required), `-b, --branch <name>`,
    `--allow-nested`
  - `attach`: `-p, --plan <path>` (required), `--path <dir>` (required)
  - `detach`: `-p, --plan <path>` (required)
  - `remove`: `-p, --plan <path>` (required), `-f, --force`
  - `list`: no options

### Phase 2e: Complex parent commands

- [x] Rewrite `src/commands/protocol.ts` (123 → ~115 lines):
  - Export `registerProtocol(parent: Command)`
  - 3-level nesting: `protocol` → `validate` → `author`/`reviewer`
  - Shared options: `-i, --input <path>`, `-r, --run <id>`, `--record`,
    `--step <name>`, `--phase <name>`, `--iteration <n>` with
    `.argParser(intArg("--iteration", { positive: true }))`
  - `author`: adds `--require-commit` / `--no-require-commit` (default true),
    `--plan <path>`, `--phase-checklist-validate` /
    `--no-phase-checklist-validate` (default true)
  - Actions call `protocolValidate({ role, ... })`

- [x] Rewrite `src/commands/invoke.ts` (160 → ~140 lines):
  - Export `registerInvoke(parent: Command)`
  - Parent `invoke` with subcommands `author`, `reviewer`
  - Use a helper function to register shared options on both subcommands:
    ```ts
    function addInvokeOptions(cmd: Command) {
      return cmd
        .argument("<template>", "Template name")
        .option("-r, --run <id>", "Run ID")
        .option("--var <key=value>", "Template variable (repeatable)", collect, [])
        .option("-m, --model <name>", "Model override")
        .option("-w, --workdir <path>", "Working directory")
        .option("--session <id>", "Resume session by ID")
        .option("-t, --timeout <seconds>", "Timeout in seconds", timeoutArg())
        .option("-q, --quiet", "Suppress console output")
        .option("--show-reasoning", "Show agent reasoning")
        .option("--stderr", "Stream to stderr")
        .option("--author-provider <name>", "Override author provider")
        .option("--reviewer-provider <name>", "Override reviewer provider")
        .option("--opencode-url <url>", "Override OpenCode server URL")
        .option("--record", "Auto-record result as run step")
        .option("--record-step <name>", "Override step name")
        .option("--phase <name>", "Phase identifier")
        .option("--iteration <n>", "Iteration number", intArg("--iteration", { positive: true }));
    }
    ```
  - Both subcommands call `invokeAgent(role, { ... })` mapping opts to handler params
  - Key change: `vars` is now always `string[]` (never `string | string[]`)
    due to the `collect` argParser

- [x] Rewrite `src/commands/run-v1.ts` (295 → ~260 lines):
  - Export `registerRun(parent: Command)`
  - Parent `run` with 7 subcommands: `init`, `state`, `record`, `complete`,
    `reopen`, `list`, `watch`
  - `init`: `-p, --plan <path>` (required), `-w, --worktree [path]`
    (optional value — consolidates `--worktree` + `--worktree-path`),
    `--worktree-path <path>` (hidden, deprecated alias — `.hideHelp()`),
    `--allow-dirty`
    - Adapter maps: `opts.worktree === true` → `{ worktree: true }`;
      `typeof opts.worktree === "string"` → `{ worktree: true, worktreePath: opts.worktree }`;
      `opts.worktreePath` (from deprecated flag) → `{ worktree: true, worktreePath: opts.worktreePath }`
      with stderr warning: `"Warning: --worktree-path is deprecated, use --worktree <path> instead"`
  - `state`: `-r, --run <id>`, `-p, --plan <path>`,
    `-t, --tail <n>` with `.argParser(intArg("--tail", { positive: true }))`,
    `--since-step <n>` with `.argParser(intArg("--since-step"))`
  - `record`: positional `[step-name]`, `-r, --run <id>`,
    `--result <value>`, `-p, --phase <name>`,
    `--iteration <n>` with `.argParser(intArg("--iteration", { positive: true }))`,
    `--session-id <id>`, `--model <name>`,
    `--tokens-in <n>` with `.argParser(intArg("--tokens-in"))`,
    `--tokens-out <n>` with `.argParser(intArg("--tokens-out"))`,
    `--cost-usd <n>` with `.argParser(floatArg("--cost-usd", { nonNegative: true }))`,
    `--duration-ms <n>` with `.argParser(intArg("--duration-ms"))`,
    `--log-path <path>`
  - `complete`: `-r, --run <id>` (required),
    `-s, --status <status>` with `.choices(["completed", "aborted"])` and
    `.default("completed")`,
    `--reason <text>`
  - `reopen`: `-r, --run <id>` (required)
  - `list`: `-p, --plan <path>`,
    `-s, --status <status>` with `.choices(["active", "completed", "aborted"])`,
    `-n, --limit <n>` with `.argParser(intArg("--limit", { positive: true }))`
  - `watch`: `-r, --run <id>` (required), `--human-readable`,
    `--show-reasoning`, `--tail-only`, `--workdir <path>`,
    `--poll-interval <ms>` with inline `parseInt` parser

## Phase 3: Rewrite Entry Point (`bin.ts`)

**Completion gate:** `bun run src/bin.ts --help` prints commander-formatted
help. `bun run src/bin.ts --version` prints the version. `bun run src/bin.ts
run init --plan /nonexistent` produces a JSON error envelope.
`bun run src/bin.ts --pretty run init` and `bun run src/bin.ts run init
--pretty` both apply pretty formatting (any-position argv).
`bun run src/bin.ts run init` (missing `--plan`) produces a JSON error
envelope with `--no-pretty` applied correctly. All existing integration
tests pass (except those asserting on framework-generated text, which are
updated in Phase 4).

- [x] Rewrite `src/bin.ts` (141 → ~80 lines):

  ```ts
  #!/usr/bin/env bun
  import { CommanderError } from "@commander-js/extra-typings";
  import { CliError, jsonStringify, setPrettyPrint } from "./output.js";
  import { createProgram } from "./program.js";
  import { registerRun } from "./commands/run-v1.js";
  import { registerInvoke } from "./commands/invoke.js";
  import { registerQuality } from "./commands/quality-v1.js";
  import { registerPlan } from "./commands/plan-v1.js";
  import { registerDiff } from "./commands/diff.js";
  import { registerPrompt } from "./commands/prompt.js";
  import { registerInit } from "./commands/init.js";
  import { registerHarness } from "./commands/harness.js";
  import { registerTemplate } from "./commands/template.js";
  import { registerProtocol } from "./commands/protocol.js";
  import { registerSkills } from "./commands/skills.js";
  import { registerUpgrade } from "./commands/upgrade.js";
  import { registerWorktree } from "./commands/worktree.js";

  // ---------------------------------------------------------------------------
  // Global --pretty / --no-pretty flags (pre-parse strip, preserved from citty)
  // Accepted anywhere in argv. Last flag wins. Applied before commander parses
  // so that formatting is active even for parse-error JSON envelopes.
  // ---------------------------------------------------------------------------
  {
    const indices: { idx: number; pretty: boolean }[] = [];
    for (let i = process.argv.length - 1; i >= 0; i--) {
      if (process.argv[i] === "--pretty") {
        indices.push({ idx: i, pretty: true });
      } else if (process.argv[i] === "--no-pretty") {
        indices.push({ idx: i, pretty: false });
      }
    }
    if (indices.length > 0) {
      const last = indices.reduce((a, b) => (a.idx > b.idx ? a : b));
      setPrettyPrint(last.pretty);
      for (const { idx } of indices.sort((a, b) => b.idx - a.idx)) {
        process.argv.splice(idx, 1);
      }
    }
  }

  const program = createProgram();

  // Register all commands eagerly
  registerRun(program);
  registerInvoke(program);
  registerQuality(program);
  registerPlan(program);
  registerDiff(program);
  registerPrompt(program);
  registerInit(program);
  registerHarness(program);
  registerTemplate(program);
  registerProtocol(program);
  registerSkills(program);
  registerUpgrade(program);
  registerWorktree(program);

  // Configure output routing
  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
    outputError: (str, write) => write(str),
  });

  try {
    await program.parseAsync(process.argv);
  } catch (err: unknown) {
    if (err instanceof CliError) {
      const envelope = {
        ok: false as const,
        error: {
          code: err.code,
          message: err.message,
          ...(err.detail !== undefined ? { detail: err.detail } : {}),
        },
      };
      console.log(jsonStringify(envelope));
      process.exit(err.exitCode);
    }
    if (err instanceof CommanderError) {
      // Commander validation/help/version errors
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") {
        process.exit(0);
      }
      // Map Commander error codes to PRD-specified envelope codes:
      //   commander.unknownCommand  → UNKNOWN_COMMAND
      //   commander.unknownOption   → UNKNOWN_OPTION
      //   all other parse errors    → INVALID_ARGS
      const code =
        err.code === "commander.unknownCommand"
          ? "UNKNOWN_COMMAND"
          : err.code === "commander.unknownOption"
            ? "UNKNOWN_OPTION"
            : "INVALID_ARGS";
      const envelope = {
        ok: false as const,
        error: {
          code,
          message: err.message,
        },
      };
      console.log(jsonStringify(envelope));
      process.exit(1);
    }
    // Non-CliError — still emit JSON envelope
    const message = err instanceof Error ? err.message : String(err);
    const envelope = {
      ok: false as const,
      error: { code: "INTERNAL_ERROR", message },
    };
    console.log(jsonStringify(envelope));
    process.exit(1);
  }
  ```

- [x] Delete the code blocks that are no longer needed:
  - Lines 31-45: `--worktree`/`--worktree-path` argv splicing hack (replaced
    by commander's optional-value syntax + hidden `--worktree-path` alias)
  - Lines 76-94: `resolveSubCommand()` recursive walker
  - Lines 98-109: manual `--help`/`--version` handling
  - Lines 124-129: citty `CLIError` catch block
  - Note: The `--pretty`/`--no-pretty` pre-parse block (lines 10-29) is
    **retained** (ported to the new bin.ts), not deleted

- [x] Verify `bun run typecheck` passes
- [x] Verify `bun run src/bin.ts --help` shows commander-formatted output
- [x] Verify `bun run src/bin.ts --version` prints version
- [x] Verify `bun run src/bin.ts run init --plan /nonexistent` produces JSON
  error envelope (CliError path works)
- [x] Verify `bun run src/bin.ts run complet` produces "Did you mean init?"
  or similar suggestion (CommanderError path works) with `UNKNOWN_COMMAND`
  error code in the JSON envelope
- [x] Verify `--pretty` works at any argv position:
  - `bun run src/bin.ts --pretty run init --plan /nonexistent` → formatted JSON
  - `bun run src/bin.ts run init --plan /nonexistent --pretty` → formatted JSON
  - `bun run src/bin.ts run --pretty init --plan /nonexistent` → formatted JSON
- [x] Verify `--no-pretty` applies to parse-error envelopes:
  - `bun run src/bin.ts --no-pretty run init` (no `--plan`) → compact JSON envelope
- [x] Verify `--worktree-path` backward compatibility:
  - `bun run src/bin.ts run init --plan plan.md --worktree --worktree-path /tmp/wt` →
    works, stderr shows deprecation warning

## Phase 4: Update Tests

**Completion gate:** `bun test` passes. All 28+ integration tests pass. No
handler test files are modified. No unit test behavioral assertions change.
Pipe-composability flows (`run init | invoke`, `invoke | run record`) pass
non-regression tests. `--pretty`/`--no-pretty` works at any argv position
including in pipe contexts and on parse-error envelopes.

### Phase 4a: Update `parse-args.ts` unit tests

- [ ] Add unit tests for the new commander wrapper functions in
  `test/unit/utils/parse-args.test.ts`:
  - `intArg` returns a function that delegates to `parseIntArg`
  - `floatArg` returns a function that delegates to `parseFloatArg`
  - `timeoutArg` returns a function that delegates to `parseTimeout`
  - `collect` accumulates values into an array

### Phase 4b: Update integration tests for framework text changes

Commander produces different error messages and help text than citty. Scan
all integration tests for assertions on:
- stderr text containing citty-specific error messages
- stdout text containing help/usage output
- Exact error message strings from the framework

Files likely needing updates (based on codebase analysis):

- [ ] `test/integration/bin-pretty.test.ts` — should work as-is (asserts on
  JSON envelope structure, not framework text). Verify.
- [ ] `test/integration/commands/run-v1.test.ts` — verify all assertions.
  Tests that spawn `5x run init` without `--plan` will now get a commander
  "required option" error instead of citty's behavior. Update expected error
  messages if any test asserts on exact text.
- [ ] `test/integration/commands/invoke.test.ts` — verify `--var` handling.
  Commander always produces `string[]` from `collect`, eliminating the
  `string | string[]` ambiguity. Tests should pass or improve.
- [ ] `test/integration/commands/prompt.test.ts` — positional `<message>`
  arg handling may differ. Verify.
- [ ] `test/integration/commands/protocol-validate.test.ts` — verify
  `--no-require-commit` behavior works with commander negatable boolean.
- [ ] `test/integration/commands/run-init-worktree.test.ts` — verify the
  `--worktree [path]` consolidation works. Keep existing `--worktree-path`
  tests (they exercise the backward-compatible hidden alias). Add a test
  asserting that `--worktree-path` usage emits a deprecation warning to
  stderr.
- [ ] Audit remaining integration test files — run `bun test
  test/integration/` and fix any failures.

### Phase 4c: Add commander-specific integration tests

- [ ] Add test: unknown command → `UNKNOWN_COMMAND` — `5x run int` produces
  JSON error envelope with `code: "UNKNOWN_COMMAND"`, stderr containing
  "Did you mean", and exit code 1
- [ ] Add test: unknown option → `UNKNOWN_OPTION` — `5x run init --bogus`
  produces JSON error envelope with `code: "UNKNOWN_OPTION"` and exit code 1
- [ ] Add test: choice validation → `INVALID_ARGS` — `5x run complete -r abc
  -s invalid` produces error envelope with `code: "INVALID_ARGS"` mentioning
  "Allowed choices"
- [ ] Add test: required option → `INVALID_ARGS` — `5x run init` (no
  `--plan`) produces error envelope with `code: "INVALID_ARGS"` mentioning
  "required option"
- [ ] Add test: `--worktree [path]` consolidation — both `5x run init -p
  plan.md -w` and `5x run init -p plan.md -w /tmp/wt` work correctly
- [ ] Add test: `--worktree-path` backward compatibility — `5x run init -p
  plan.md --worktree --worktree-path /tmp/wt` works and emits deprecation
  warning to stderr

### Phase 4d: Pipe-composability non-regression tests

Pipe composition is a critical automation surface (see
`docs/development/archive/010-cli-composability.md`). The framework migration
must not regress stdin-priority or envelope-ingestion behavior.

- [ ] Add test (or verify existing): `5x run init ... | 5x invoke author ...`
  — invoke reads `run_id` from piped upstream envelope without `--run`
- [ ] Add test (or verify existing): `5x invoke ... | 5x run record` —
  step name, result, run_id, and metadata auto-extracted from piped envelope
- [ ] Add test (or verify existing): `5x quality run | 5x run record
  "quality:check" --run R1` — step name and run from CLI, result from pipe
- [ ] Add test: `--pretty` position in pipe context — `5x run init -p
  plan.md --pretty | head -1` produces formatted JSON (pretty applies even
  when stdout is piped, because `--pretty` was explicit)
- [ ] Add test: `--no-pretty` on parse-error — `5x --no-pretty run init`
  (no `--plan`) produces compact JSON error envelope on stdout
- [ ] Verify existing pipe tests in `test/integration/pipe.test.ts` pass
  without modification

## Phase 5: Help Content and Polish

**Completion gate:** `5x --help`, `5x run --help`, `5x run init --help`,
`5x protocol validate author --help` all produce correct help content.
Help examples are audited against actual CLI behavior (not copied verbatim
from the PRD, which contains stale examples). Short flags work for all
assigned commands.

- [ ] Add `.summary()` and `.description()` to every command in all 13
  adapter files, using the content from PRD Section 2.2 as a starting point.
  Each command gets:
  - `.summary()` — one-line shown in parent's subcommand list
  - `.description()` — longer explanation shown in own `--help`

- [ ] Audit all PRD Section 2.2 help examples against actual current CLI
  behavior before copying them into commander help definitions. The PRD
  contains stale examples that do not match the implemented CLI surface.
  Known corrections needed:
  - `harness install`: PRD example `$ 5x harness install opencode` omits
    the required `--scope` flag. The `opencode` harness supports multiple
    scopes (`project`, `user`), so `--scope` is mandatory. Correct to:
    `$ 5x harness install opencode -s project`
  - For each command, verify that all example flags/args match the current
    option definitions and handler requirements. Cross-reference adapter
    files and handler param interfaces.

- [ ] Add `.addHelpText("after", ...)` example blocks to all leaf commands
  using the audited/corrected content from PRD Section 2.2. Format:
  ```ts
  .addHelpText("after", `
  Examples:
    $ 5x run init -p docs/development/015-test-separation.md
    $ 5x run init -p plan.md -w
    $ 5x run init -p plan.md -w /tmp/my-worktree
    $ 5x run init -p plan.md --allow-dirty
  `)
  ```

- [ ] Add program-level description and footer to `src/program.ts`:
  ```ts
  program
    .description(
      "A toolbelt of primitives for the 5x workflow.\n\n" +
      "The 5x CLI manages implementation runs, invokes AI agents, validates\n" +
      "structured output, and orchestrates the plan-author-review development\n" +
      "cycle. Most commands output JSON envelopes to stdout for machine\n" +
      "consumption. Use --pretty for human-readable formatting."
    )
    .addHelpText("afterAll",
      "\nMost commands output JSON envelopes ({ ok, data } or { ok, error }) to stdout.\n" +
      "Exceptions: init, upgrade, and harness install emit human-readable text;\n" +
      "run watch streams NDJSON or human-readable output.\n" +
      "Use --pretty for formatted JSON output, --no-pretty for compact.\n" +
      "Exit codes: 0=success, 1=error, 2=not found, 3=non-interactive,\n" +
      "4=locked, 5=dirty, 6=limit, 7=invalid output.\n\n" +
      "Documentation: https://github.com/5x-ai/5x-cli\n" +
      "Configuration: 5x.toml in project root"
    );
  ```

- [ ] Add option grouping to `invoke author`/`invoke reviewer` and
  `run record` using Commander's `configureHelp()` with a custom
  `formatHelp` function. This is the verified Commander v13 approach —
  `configureHelp()` accepts a `formatHelp(cmd, helper)` callback that
  returns the full help string, allowing arbitrary section headers.
  Alternative: use `.addHelpText("after", ...)` for simpler section
  dividers if full `formatHelp` override proves too complex. Do NOT use
  `.optionsGroup()` (not a Commander API).
  - `invoke`: Template Options, Execution Options, Output Options,
    Recording Options
  - `run record`: Required, Result, Metadata, Metrics

- [ ] Verify all short flags work end-to-end:
  - `5x run init -p plan.md -w` ≡ `5x run init --plan plan.md --worktree`
  - `5x run state -r abc -t 5` ≡ `5x run state --run abc --tail 5`
  - `5x invoke author tmpl -r abc -m claude -t 60 -q`
  - `5x diff -s main -r abc`
  - `5x init -f` ≡ `5x init --force`

- [ ] Final pass: `bun test` — all tests pass
- [ ] Final pass: `bun run typecheck` — no type errors
- [ ] Final pass: `bun build --compile src/bin.ts --outfile dist/5x` — binary
  works

## Phase 6: Cleanup

**Completion gate:** `citty` is completely removed. No dead code remains.
`bun test && bun run typecheck && bun run lint` all pass.

- [ ] Remove `citty` from `package.json` dependencies
- [ ] Run `bun install` to clean `bun.lock`
- [ ] Verify zero imports of `citty` remain:
  `grep -r "from.*citty" src/` returns nothing
- [ ] Remove any commented-out citty code or TODO markers from Phase 2/3
- [ ] Run `bun run lint` and fix any formatting issues introduced by
  the migration
- [ ] Verify `bun build --compile src/bin.ts --outfile dist/5x` still works
- [ ] Run the full test suite one final time: `bun test --concurrent`

## Files Touched

| File | Change |
|------|--------|
| `package.json` | Replace `citty` dep with `commander` + `@commander-js/extra-typings` |
| `bun.lock` | Regenerated |
| `src/program.ts` | **New** — root commander program factory |
| `src/bin.ts` | Rewrite: commander `parseAsync`, `exitOverride`, error handler |
| `src/utils/parse-args.ts` | Add commander `argParser` wrappers (`intArg`, `floatArg`, `timeoutArg`, `collect`) |
| `src/commands/run-v1.ts` | Rewrite: 7 subcommands with commander API |
| `src/commands/invoke.ts` | Rewrite: 2 subcommands with shared option helper |
| `src/commands/quality-v1.ts` | Rewrite: 1 subcommand with commander API |
| `src/commands/plan-v1.ts` | Rewrite: 1 subcommand with commander API |
| `src/commands/diff.ts` | Rewrite: leaf command with commander API |
| `src/commands/prompt.ts` | Rewrite: 3 subcommands with commander API |
| `src/commands/init.ts` | Rewrite: leaf command with commander API |
| `src/commands/harness.ts` | Rewrite: 3 subcommands with commander API |
| `src/commands/template.ts` | Rewrite: 1 subcommand with commander API |
| `src/commands/protocol.ts` | Rewrite: 3-level nesting with commander API |
| `src/commands/skills.ts` | Rewrite: 2 subcommands with commander API |
| `src/commands/upgrade.ts` | Rewrite: leaf command with commander API |
| `src/commands/worktree.ts` | Rewrite: 5 subcommands with commander API |
| `test/unit/utils/parse-args.test.ts` | Add tests for commander wrappers |
| `test/integration/bin-pretty.test.ts` | Verify / update if needed |
| `test/integration/commands/run-v1.test.ts` | Update framework-dependent assertions |
| `test/integration/commands/run-init-worktree.test.ts` | Verify `--worktree [path]` + `--worktree-path` compat; add deprecation warning test |
| `test/integration/commands/invoke.test.ts` | Verify `--var` array handling |
| `test/integration/commands/prompt.test.ts` | Verify positional arg handling |
| `test/integration/commands/protocol-validate.test.ts` | Verify negatable boolean |
| Other integration test files | Audit and fix as needed |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/utils/parse-args.test.ts` | `intArg`, `floatArg`, `timeoutArg`, `collect` wrappers |
| Integration | `test/integration/bin-pretty.test.ts` | `--pretty`/`--no-pretty` via pre-parse argv strip (any position, parse-error envelopes) |
| Integration | `test/integration/commands/run-v1.test.ts` | Run lifecycle through commander |
| Integration | `test/integration/commands/run-init-worktree.test.ts` | `--worktree [path]` consolidation + `--worktree-path` backward compat |
| Integration | `test/integration/commands/invoke.test.ts` | `--var` always produces `string[]` |
| Integration | `test/integration/commands/protocol-validate.test.ts` | `--no-require-commit` negatable boolean |
| Integration | New: commander error UX tests | Unknown command suggestion, choice validation, required option errors |
| Integration | New/verify: pipe-composability non-regression | `run init \| invoke`, `invoke \| run record`, stdin-priority rules |
| Integration | All 28+ existing tests | Full regression — JSON envelope, exit codes, handler behavior, pipe composition |

## Estimated Timeline

| Phase | Scope | Estimate |
|-------|-------|----------|
| Phase 1: Dependency + Skeleton | 1 new file, 1 modified | 0.5 days |
| Phase 2: Adapter Migration | 13 files rewritten, 1 modified | 2-3 days |
| Phase 3: Entry Point | 1 file rewritten | 0.5 days |
| Phase 4: Test Updates | ~8-12 test files | 1-2 days |
| Phase 5: Help Content | 13 adapter files + program.ts | 1 day |
| Phase 6: Cleanup | Dependency removal, lint | 0.5 days |
| **Total** | | **5.5-7.5 days** |

## Not In Scope

- Changing handler function signatures or business logic (*.handler.ts files)
- Adding new CLI commands or options (beyond `--worktree [path]` consolidation)
- Changing the JSON envelope output format or exit code mapping
- Adding shell completions (benefits from commander but separate initiative)
- Migrating to a different runtime (remains Bun)
- Modifying unit test assertions for handler behavior

## Revision History

### v1.3 (March 14, 2026) — Fix extra-typings dependency classification

Review addendum: `docs/development/020-commander-migration.review.md` (iteration 3, R9)

**R9 — `@commander-js/extra-typings` misclassified as devDependency:**
Moved `@commander-js/extra-typings` from `devDependencies` to `dependencies`
in Phase 1. The package is imported at runtime from `src/program.ts`, all
adapter files, and `src/bin.ts`, so it must be a regular dependency.
Updated the Design Decisions section to match.

### v1.2 (March 14, 2026) — Address v1.1 follow-up review

Review addendum: `docs/development/020-commander-migration.review.md` (v1.1 follow-up)

**R6 — Phase 5 stale PRD help examples:** Added audit step requiring all
PRD Section 2.2 help examples to be verified against actual CLI behavior
before copying into commander help. Documented the known stale example
(`harness install opencode` missing required `--scope`). Updated Phase 5
completion gate to reference audited content, not verbatim PRD.

**R7 — Incomplete non-JSON stdout exceptions:** Added `harness install` to
the help footer's list of commands that emit human-readable stdout instead
of JSON envelopes. The `printInstallSummary()` function writes directly to
stdout via `console.log`.

**R8 — CommanderError code mapping:** Updated Phase 3 `bin.ts` sketch to
map Commander error codes to distinct PRD-specified envelope codes:
`commander.unknownCommand` → `UNKNOWN_COMMAND`,
`commander.unknownOption` → `UNKNOWN_OPTION`, all other parse errors →
`INVALID_ARGS`. Added corresponding integration tests in Phase 4c for
each error code path. Updated Phase 3 completion gate verification.

### v1.1 (March 14, 2026) — Address review feedback

Review: `docs/development/020-commander-migration.review.md`

**P0.1 — Global `--pretty` handling:** Replaced `preAction` hook approach
with retained pre-parse argv stripping. `--pretty`/`--no-pretty` are no
longer registered as commander options; they are stripped from `process.argv`
before commander parses, preserving any-position acceptance and parse-error
envelope formatting. Updated Phase 1 (`program.ts`), Phase 3 (`bin.ts`
code), and Phase 4 completion gates.

**P0.2 — `--worktree-path` backward compatibility:** Changed from breaking
removal to backward-compatible deprecation. `--worktree-path` is kept as a
hidden option (`.hideHelp()`) that maps to the same handler param, with a
stderr deprecation warning. Updated design decision, Phase 2e (`run-v1.ts`
adapter), Phase 4b (keep existing worktree-path tests), Phase 4c (add
deprecation warning test), and Files Touched table.

**P1.1 — Help/footer contract:** Updated Phase 5 program description and
footer to accurately reflect that `init`/`upgrade` emit human-readable
text and `run watch` streams NDJSON, rather than claiming all commands
output JSON envelopes.

**P1.2 — `prompt confirm --default` choices:** Removed `.choices(["yes",
"no"])` from `prompt confirm --default` in Phase 2c. Handler-layer
validation accepts `yes/no/y/n/true/false` — framework-level restriction
would break existing behavior and tests.

**P1.3 — Pipe-composability non-regression:** Added Phase 4d with explicit
non-regression tests for `run init | invoke`, `invoke | run record`, and
`quality run | run record` pipe flows. Added `--pretty`/`--no-pretty`
position and parse-error tests. Updated Phase 4 completion gate.

**P2 — Help customization approach:** Specified `configureHelp()` with
custom `formatHelp` callback as the verified Commander v13 API for option
grouping. Noted `.optionsGroup()` is not a Commander API.

### v1.0 (March 14, 2026) — Initial plan

- Complete implementation plan for citty → commander.js migration
- 6 phases: dependency swap, adapter migration, entry point, tests, help content, cleanup
