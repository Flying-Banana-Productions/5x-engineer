# Migrate CLI Framework from citty to Commander.js

**Version:** 1.0
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
extra dev dependency, but it's a type-only wrapper with zero runtime overhead.

**Eager registration over lazy `import()`.** citty used dynamic `import()` for
lazy-loading subcommands. Commander doesn't execute action handlers at
registration time, so eager registration is safe and simpler. Adapter files are
thin (~20-60 lines each) — the import cost is negligible.

**`exitOverride` + `configureOutput` for JSON envelope preservation.** Commander
normally calls `process.exit()` on errors. `exitOverride()` rethrows
`CommanderError`, caught by bin.ts's error handler which routes through the
existing JSON envelope system. `configureOutput()` sends framework errors to
stderr. This preserves the machine-readable error contract.

**Consolidate `--worktree`/`--worktree-path` into `--worktree [path]`.**
Commander's optional-value syntax natively supports "boolean or value." The
hidden `--worktree-path` flag and the 15-line argv splice hack in bin.ts are
eliminated. The adapter maps the single option to both handler params
(`worktree: boolean`, `worktreePath?: string`). Breaking change: only affects
the undocumented internal `--worktree-path` flag.

**`preAction` hook for `--pretty`/`--no-pretty`.** Replace the 20-line
pre-parse argv manipulation with a `preAction` lifecycle hook on the root
program. Commander's negatable boolean support handles `--no-pretty` natively.
The hook calls `setPrettyPrint()` before any action handler runs.

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

- [ ] Update `package.json` (line 57): replace `"citty": "^0.1.6"` with
  `"commander": "^13.1.0"` in `dependencies` and add
  `"@commander-js/extra-typings": "^13.1.0"` to `devDependencies`
- [ ] Run `bun install` to update `bun.lock`
- [ ] Create `src/program.ts` — the root commander program factory:

  ```ts
  import { Command } from "@commander-js/extra-typings";
  import { version } from "./version.js";

  export function createProgram(): Command {
    const program = new Command("5x")
      .version(version, "-V, --version")
      .description("A toolbelt of primitives for the 5x workflow")
      .option("--pretty", "Format JSON output with indentation (default: auto-detect TTY)")
      .option("--no-pretty", "Force compact JSON output")
      .exitOverride()
      .showHelpAfterError("(use --help for additional information)")
      .showSuggestionAfterError(true);

    return program;
  }
  ```

- [ ] Verify `bun run typecheck` passes with the new dependency and
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

- [ ] Add commander-compatible wrapper functions to `src/utils/parse-args.ts`
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

- [ ] Retain existing `parseIntArg`, `parseFloatArg`, `parseTimeout` unchanged
  (unit tests depend on them)

### Phase 2b: Leaf commands (no subcommands)

Migrate the 3 simplest files first — single command, no subcommands:

- [ ] Rewrite `src/commands/diff.ts` (40 → ~45 lines):
  - Export `registerDiff(parent: Command)` instead of default citty command
  - Options: `-s, --since <ref>`, `--stat`, `-r, --run <id>`
  - Action calls `runDiff({ since, stat, run })`

- [ ] Rewrite `src/commands/init.ts` (32 → ~35 lines):
  - Export `registerInit(parent: Command)`
  - Options: `-f, --force`
  - Action calls `initScaffold({ force })`

- [ ] Rewrite `src/commands/upgrade.ts` (27 → ~30 lines):
  - Export `registerUpgrade(parent: Command)`
  - Options: `-f, --force`
  - Action calls `runUpgrade({ force })`

### Phase 2c: Simple parent commands (2-3 subcommands)

- [ ] Rewrite `src/commands/prompt.ts` (100 → ~90 lines):
  - Export `registerPrompt(parent: Command)`
  - Parent `prompt` command with subcommands `choose`, `confirm`, `input`
  - `choose`: positional `<message>`, `-o, --options <list>` (required),
    `-d, --default <value>`
  - `confirm`: positional `<message>`, `-d, --default <value>` with
    `.choices(["yes", "no"])`
  - `input`: positional `<message>`, `--multiline`
  - Actions call `promptChoose`, `promptConfirm`, `promptInput`

- [ ] Rewrite `src/commands/plan-v1.ts` (38 → ~40 lines):
  - Export `registerPlan(parent: Command)`
  - Parent `plan` command with subcommand `phases`
  - `phases`: positional `<path>`, action calls `planPhases({ path })`

- [ ] Rewrite `src/commands/skills.ts` (81 → ~75 lines):
  - Export `registerSkills(parent: Command)`
  - Parent `skills` with subcommands `install`, `uninstall`
  - `install`: positional `<scope>` with `.choices(["user", "project"])`,
    `-f, --force`, `--install-root <dir>`
  - `uninstall`: positional `<scope>` with `.choices(["all", "user", "project"])`,
    `--install-root <dir>`
  - Actions pass `homeDir: process.env.HOME`

### Phase 2d: Medium parent commands (3-5 subcommands)

- [ ] Rewrite `src/commands/harness.ts` (96 → ~90 lines):
  - Export `registerHarness(parent: Command)`
  - Parent `harness` with subcommands `install`, `list`, `uninstall`
  - `install`: positional `<name>`, `-s, --scope <scope>` with
    `.choices(["user", "project"])`, `-f, --force`
  - `list`: no options
  - `uninstall`: positional `<name>`, `-s, --scope <scope>` with
    `.choices(["user", "project"])`, `--all`
  - Actions pass `homeDir: process.env.HOME`

- [ ] Rewrite `src/commands/template.ts` (61 → ~60 lines):
  - Export `registerTemplate(parent: Command)`
  - Parent `template` with subcommand `render`
  - `render`: positional `<template>`, `-r, --run <id>`,
    `--var <key=value>` with `.argParser(collect)` and default `[]`,
    `--session <id>`, `-w, --workdir <path>`
  - Action calls `templateRender({ template, run, vars, session, workdir })`

- [ ] Rewrite `src/commands/quality-v1.ts` (60 → ~55 lines):
  - Export `registerQuality(parent: Command)`
  - Parent `quality` with subcommand `run`
  - `run`: `--record`, `--record-step <name>`, `-r, --run <id>`,
    `--phase <name>`, `-w, --workdir <path>`
  - Action calls `runQuality({ record, recordStep, run, phase, workdir })`

- [ ] Rewrite `src/commands/worktree.ts` (137 → ~120 lines):
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

- [ ] Rewrite `src/commands/protocol.ts` (123 → ~115 lines):
  - Export `registerProtocol(parent: Command)`
  - 3-level nesting: `protocol` → `validate` → `author`/`reviewer`
  - Shared options: `-i, --input <path>`, `-r, --run <id>`, `--record`,
    `--step <name>`, `--phase <name>`, `--iteration <n>` with
    `.argParser(intArg("--iteration", { positive: true }))`
  - `author`: adds `--require-commit` / `--no-require-commit` (default true),
    `--plan <path>`, `--phase-checklist-validate` /
    `--no-phase-checklist-validate` (default true)
  - Actions call `protocolValidate({ role, ... })`

- [ ] Rewrite `src/commands/invoke.ts` (160 → ~140 lines):
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

- [ ] Rewrite `src/commands/run-v1.ts` (295 → ~260 lines):
  - Export `registerRun(parent: Command)`
  - Parent `run` with 7 subcommands: `init`, `state`, `record`, `complete`,
    `reopen`, `list`, `watch`
  - `init`: `-p, --plan <path>` (required), `-w, --worktree [path]`
    (optional value — consolidates `--worktree` + `--worktree-path`),
    `--allow-dirty`
    - Adapter maps: `opts.worktree === true` → `{ worktree: true }`;
      `typeof opts.worktree === "string"` → `{ worktree: true, worktreePath: opts.worktree }`
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
run init --plan /nonexistent` produces a JSON error envelope. All existing
integration tests pass (except those asserting on framework-generated text,
which are updated in Phase 4).

- [ ] Rewrite `src/bin.ts` (141 → ~65 lines):

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

  // preAction hook: --pretty / --no-pretty
  program.hook("preAction", (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    if (opts.pretty !== undefined) {
      setPrettyPrint(opts.pretty);
    }
  });

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
      const envelope = {
        ok: false as const,
        error: {
          code: "INVALID_ARGS",
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

- [ ] Delete the 3 code blocks that are no longer needed:
  - Lines 10-29: `--pretty`/`--no-pretty` pre-parse argv manipulation
  - Lines 31-45: `--worktree`/`--worktree-path` argv splicing hack
  - Lines 76-94: `resolveSubCommand()` recursive walker
  - Lines 98-109: manual `--help`/`--version` handling
  - Lines 124-129: citty `CLIError` catch block

- [ ] Verify `bun run typecheck` passes
- [ ] Verify `bun run src/bin.ts --help` shows commander-formatted output
- [ ] Verify `bun run src/bin.ts --version` prints version
- [ ] Verify `bun run src/bin.ts run init --plan /nonexistent` produces JSON
  error envelope (CliError path works)
- [ ] Verify `bun run src/bin.ts run complet` produces "Did you mean init?"
  or similar suggestion (CommanderError path works)

## Phase 4: Update Tests

**Completion gate:** `bun test` passes. All 28+ integration tests pass. No
handler test files are modified. No unit test behavioral assertions change.

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
  `--worktree [path]` consolidation works. Remove any references to
  `--worktree-path` in test args.
- [ ] Audit remaining integration test files — run `bun test
  test/integration/` and fix any failures.

### Phase 4c: Add commander-specific integration tests

- [ ] Add test: unknown command suggestion — `5x run int` produces stderr
  containing "Did you mean" and exit code 1 with JSON error envelope
- [ ] Add test: choice validation — `5x run complete -r abc -s invalid`
  produces error mentioning "Allowed choices"
- [ ] Add test: required option — `5x run init` (no `--plan`) produces error
  mentioning "required option"
- [ ] Add test: `--worktree [path]` consolidation — both `5x run init -p
  plan.md -w` and `5x run init -p plan.md -w /tmp/wt` work correctly

## Phase 5: Help Content and Polish

**Completion gate:** `5x --help`, `5x run --help`, `5x run init --help`,
`5x protocol validate author --help` all produce the documented help
content from the PRD. Short flags work for all assigned commands.

- [ ] Add `.summary()` and `.description()` to every command in all 13
  adapter files, using the content from PRD Section 2.2. Each command gets:
  - `.summary()` — one-line shown in parent's subcommand list
  - `.description()` — longer explanation shown in own `--help`

- [ ] Add `.addHelpText("after", ...)` example blocks to all leaf commands
  using the content from PRD Section 2.2. Format:
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
      "cycle. It outputs JSON envelopes to stdout for machine consumption and\n" +
      "supports --pretty for human-readable formatting."
    )
    .addHelpText("afterAll",
      "\nAll commands output JSON envelopes ({ ok, data } or { ok, error }) to stdout.\n" +
      "Use --pretty for human-readable output. Exit codes: 0=success, 1=error,\n" +
      "2=not found, 3=non-interactive, 4=locked, 5=dirty, 6=limit, 7=invalid output.\n\n" +
      "Documentation: https://github.com/5x-ai/5x-cli\n" +
      "Configuration: 5x.toml in project root"
    );
  ```

- [ ] Add option grouping to `invoke author`/`invoke reviewer` and
  `run record` using commander's help customization (grouping headers
  via `.addHelpText("before", ...)` or custom `formatHelp`):
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
| `test/integration/commands/run-init-worktree.test.ts` | Update `--worktree-path` → `--worktree [path]` |
| `test/integration/commands/invoke.test.ts` | Verify `--var` array handling |
| `test/integration/commands/prompt.test.ts` | Verify positional arg handling |
| `test/integration/commands/protocol-validate.test.ts` | Verify negatable boolean |
| Other integration test files | Audit and fix as needed |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/utils/parse-args.test.ts` | `intArg`, `floatArg`, `timeoutArg`, `collect` wrappers |
| Integration | `test/integration/bin-pretty.test.ts` | `--pretty`/`--no-pretty` via `preAction` hook |
| Integration | `test/integration/commands/run-v1.test.ts` | Run lifecycle through commander |
| Integration | `test/integration/commands/run-init-worktree.test.ts` | `--worktree [path]` consolidation |
| Integration | `test/integration/commands/invoke.test.ts` | `--var` always produces `string[]` |
| Integration | `test/integration/commands/protocol-validate.test.ts` | `--no-require-commit` negatable boolean |
| Integration | New: commander error UX tests | Unknown command suggestion, choice validation, required option errors |
| Integration | All 28+ existing tests | Full regression — JSON envelope, exit codes, handler behavior |

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

### v1.0 (March 14, 2026) — Initial plan

- Complete implementation plan for citty → commander.js migration
- 6 phases: dependency swap, adapter migration, entry point, tests, help content, cleanup
