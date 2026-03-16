# PRD: Migrate CLI Framework from citty to Commander.js

**Created:** March 14, 2026

## Problem Statement

The 5x-cli uses citty v0.1.6 as its CLI framework. citty is a minimal,
zero-dependency CLI builder that was appropriate for bootstrapping but now
limits the CLI's usability and developer experience in several ways:

1. **No native number parsing.** All numeric options (`--tail`, `--timeout`,
   `--tokens-in`, `--cost-usd`, etc.) are declared as `type: "string"` and
   hand-converted in adapter code via `parseIntArg`/`parseFloatArg`/
   `parseTimeout` — 102 lines of workaround code in `src/utils/parse-args.ts`.

2. **No short flags.** citty's `alias` property on args is never used in the
   codebase and its behavior is undocumented. Users must type `--run`, `--plan`,
   `--force` in full every time.

3. **No choice/enum validation.** Options like `--status` (completed|aborted),
   `--scope` (user|project), and `--default` (yes|no) are validated manually in
   handler code rather than declaratively at the framework level.

4. **No help customization.** citty's `showUsage()` produces bare-minimum
   output: flag names and descriptions. There are no usage examples, no grouped
   options, no long-form command descriptions, and no "did you mean?" suggestions
   for typos.

5. **No optional-value options.** The `--worktree` flag on `run init` requires a
   pre-parse argv hack (bin.ts lines 31-45) that splices `--worktree-path` into
   argv because citty cannot express "boolean flag that optionally takes a
   value."

6. **Inconsistent repeated-flag handling.** When `--var key=value` is repeated,
   citty may return a single string or an array. Handler code must accept
   `string | string[]`.

7. **Manual `--help`/`--version` handling.** citty's `runCommand` doesn't handle
   `--help` or `--version` natively, requiring 45 lines of custom interception
   logic in bin.ts including a recursive `resolveSubCommand()` walker.

8. **Loose TypeScript types.** citty's command types require `as const`
   annotations and `Record<string, any>` escape hatches. Option values are
   untyped — every `ctx.args.X` access requires a manual `as string` cast.

The 008 refactor (completed) decoupled all business logic from citty, isolating
the framework-specific code to ~365 lines of adapter code across 13 files plus
bin.ts. The migration surface is well-scoped.

## Current State

- **Framework:** citty v0.1.6 (single dependency, 14 source files import it)
- **Command tree:** 13 top-level commands, 30 leaf commands, max depth 3
- **Adapter files:** 13 files in `src/commands/*.ts` (~365 lines total)
- **Entry point:** `src/bin.ts` (141 lines)
- **Handler files:** 13 files in `src/commands/*.handler.ts` — zero citty
  imports, framework-independent by design
- **Workaround code:** `src/utils/parse-args.ts` (102 lines), pre-parse argv
  hacks in bin.ts (45 lines)
- **Tests:** 10 unit test files + 28 integration test files for commands
- **Architecture:** adapter/handler separation enforced by convention; handlers
  accept typed params and return results; adapters only map citty args to handler
  params

## Goals

### G1: Replace citty with Commander.js

Swap the CLI framework dependency from citty to commander.js (via
`@commander-js/extra-typings` for full TypeScript inference). Rewrite the ~365
lines of adapter code and bin.ts. Preserve all handler signatures — no handler
file should change.

### G2: Conform to Commander.js Best Practices

Adopt commander.js idioms and high-value features that improve the CLI's
correctness, usability, and developer experience. This includes short flags,
native argument parsing, declarative validation, option conflicts/implications,
and proper error UX.

### G3: Implement Comprehensive Help and Usage Content

Leverage commander.js's help system to provide rich, contextual help for every
command. This includes long-form descriptions, usage examples, option grouping,
and global help text. All content should be drafted and implemented as part of
this initiative.

## Non-Goals

- Changing handler function signatures or business logic
- Adding new commands or options (beyond consolidating `--worktree`/
  `--worktree-path`)
- Changing the JSON envelope output format or exit code mapping
- Modifying test assertions for handler behavior (adapter-level tests will
  change)
- Migrating to a different runtime (remains Bun)
- Adding shell completions (future initiative that benefits from commander.js but
  is out of scope here)

## Design Decisions

### D1: Use `@commander-js/extra-typings` for type inference

The `@commander-js/extra-typings` package infers option and argument types from
their string flag definitions. This eliminates the `as const` annotations, the
`Record<string, any>` escape hatch, and all manual `as string` casts in adapter
code. Action handlers receive fully-typed parameters. The package is maintained
by the commander.js team and is the recommended TypeScript approach.

```ts
// Before (citty): args.run as string | undefined
// After (commander): opts.run is inferred as string | undefined from '-r, --run <id>'
```

### D2: Consolidate `--worktree` / `--worktree-path` into `--worktree [path]`

Commander's optional-value syntax (`[value]`) natively supports the "boolean or
value" pattern. The `run init` command changes from:

```
5x run init --plan ./plan.md --worktree /tmp/wt    # current (hacked)
5x run init --plan ./plan.md --worktree             # current (boolean only)
```

to the same surface — but the hidden `--worktree-path` flag and the argv
splicing hack are eliminated. The handler already accepts both `worktree:
boolean` and `worktreePath?: string`; the adapter maps the single
commander option to both handler params. **Breaking change:** scripts using
`--worktree-path` directly will break. This flag was always internal/hidden,
never documented.

### D3: Global `--pretty`/`--no-pretty` via commander's preAction hook

Replace the pre-parse argv manipulation with a `preAction` lifecycle hook on the
root program. Commander's negatable boolean support (`--no-pretty`) is native.
The hook reads `program.optsWithGlobals().pretty` and calls `setPrettyPrint()`
before any action handler runs.

### D4: `exitOverride` for JSON error envelope contract

Use commander's `exitOverride()` to prevent commander from calling
`process.exit()` directly. Instead, catch `CommanderError` in bin.ts and route
through the existing JSON envelope error handling. This preserves the CLI's
machine-readable error contract while letting commander handle validation,
unknown options, and missing arguments.

### D5: `configureOutput` for stderr routing

Use commander's `configureOutput()` to route `writeErr` to stderr and
`outputError` through the existing error formatting. This replaces the manual
citty `CLIError` catch block.

### D6: Preserve lazy-loading via `.command()` factory

Commander supports `.addCommand()` for pre-built subcommands. To preserve the
current lazy-loading behavior (dynamic `import()` for top-level commands), use
commander's action handlers that import on demand, or register commands eagerly
since commander's registration is lightweight (no handler execution until
`.parseAsync()`). Given that adapter files are thin and commander doesn't execute
action handlers at registration time, eager registration is acceptable and
simpler.

### D7: Short flags scoped per command to avoid confusion

Short flags are defined per-command, not globally. Commonly-used options get
short flags; obscure or dangerous options remain long-only. The mapping is
specified in the **Short Flag Assignments** section below.

### D8: Custom `argParser` replaces `parse-args.ts`

Commander's `.argParser()` callback on options performs inline validation and
type coercion. The existing `parseIntArg`, `parseFloatArg`, and `parseTimeout`
functions are adapted to commander's `(value: string, previous: T) => T`
signature and used directly in option definitions. The `parse-args.ts` module is
retained but its consumers shift from adapter `run` handlers to option
`.argParser()` callbacks.

### D9: Help content structure

Each command gets:
- **`.summary()`** — one-line description shown in parent command's subcommand
  list (existing descriptions, tightened)
- **`.description()`** — longer explanation shown in the command's own `--help`
  output; includes purpose, behavior notes, and interaction with other commands
- **`.addHelpText('after', ...)`** — usage examples block, prefixed with
  `Examples:` heading

## Constraints

- All 28 integration tests must pass after migration. Tests that assert on help
  output text will need updated expectations.
- The JSON envelope contract (`{ ok, data }` / `{ ok, error }`) must not change.
- Exit codes must remain identical (0-7, 130).
- Handler files must have zero diffs (the "framework-independent" invariant from
  008).
- `bun build --compile` must still produce a working standalone binary.
- The `--result=-` stdin syntax must continue to work (commander handles `=`
  syntax natively).

## Improvement Line 1: Commander.js Best Practices

### 1.1 Short Flag Assignments

Short flags for frequently-used options, assigned per-command to avoid collisions.

#### Global (root program)
| Flag | Option | Rationale |
|------|--------|-----------|
| `-V` | `--version` | Commander default |
| `-h` | `--help` | Commander default |
| (none) | `--pretty` / `--no-pretty` | Global option, long-only to avoid collisions |

#### `run init`
| Short | Long | Notes |
|-------|------|-------|
| `-p` | `--plan <path>` | Most-used flag |
| `-w` | `--worktree [path]` | Replaces `--worktree` + `--worktree-path` |

#### `run state`
| Short | Long |
|-------|------|
| `-r` | `--run <id>` |
| `-p` | `--plan <path>` |
| `-t` | `--tail <n>` |

#### `run record`
| Short | Long |
|-------|------|
| `-r` | `--run <id>` |
| `-p` | `--phase <name>` |

#### `run complete`
| Short | Long |
|-------|------|
| `-r` | `--run <id>` |
| `-s` | `--status <status>` |

#### `run reopen`
| Short | Long |
|-------|------|
| `-r` | `--run <id>` |

#### `run list`
| Short | Long |
|-------|------|
| `-p` | `--plan <path>` |
| `-s` | `--status <status>` |
| `-n` | `--limit <n>` |

#### `run watch`
| Short | Long |
|-------|------|
| `-r` | `--run <id>` |

#### `invoke author` / `invoke reviewer`
| Short | Long |
|-------|------|
| `-r` | `--run <id>` |
| `-m` | `--model <name>` |
| `-q` | `--quiet` |
| `-t` | `--timeout <seconds>` |
| `-w` | `--workdir <path>` |

#### `quality run`
| Short | Long |
|-------|------|
| `-r` | `--run <id>` |
| `-w` | `--workdir <path>` |

#### `plan phases`
(positional arg only — no flags need short forms)

#### `diff`
| Short | Long |
|-------|------|
| `-s` | `--since <ref>` |
| `-r` | `--run <id>` |

#### `prompt choose`
| Short | Long |
|-------|------|
| `-o` | `--options <list>` |
| `-d` | `--default <value>` |

#### `prompt confirm`
| Short | Long |
|-------|------|
| `-d` | `--default <value>` |

#### `init`
| Short | Long |
|-------|------|
| `-f` | `--force` |

#### `harness install`
| Short | Long |
|-------|------|
| `-s` | `--scope <scope>` |
| `-f` | `--force` |

#### `harness uninstall`
| Short | Long |
|-------|------|
| `-s` | `--scope <scope>` |

#### `template render`
| Short | Long |
|-------|------|
| `-r` | `--run <id>` |
| `-w` | `--workdir <path>` |

#### `protocol validate author` / `protocol validate reviewer`
| Short | Long |
|-------|------|
| `-i` | `--input <path>` |
| `-r` | `--run <id>` |

#### `skills install`
| Short | Long |
|-------|------|
| `-f` | `--force` |

#### `upgrade`
| Short | Long |
|-------|------|
| `-f` | `--force` |

#### `worktree create`
| Short | Long |
|-------|------|
| `-p` | `--plan <path>` |
| `-b` | `--branch <name>` |

#### `worktree remove`
| Short | Long |
|-------|------|
| `-p` | `--plan <path>` |
| `-f` | `--force` |

#### `worktree attach`
| Short | Long |
|-------|------|
| `-p` | `--plan <path>` |

#### `worktree detach`
| Short | Long |
|-------|------|
| `-p` | `--plan <path>` |

### 1.2 Declarative Choice Constraints

Options with a fixed set of valid values use `.choices()` for automatic
validation and help text:

| Command | Option | Choices |
|---------|--------|---------|
| `run complete` | `--status` | `completed`, `aborted` |
| `run list` | `--status` | `active`, `completed`, `aborted` |
| `harness install` | `--scope` | `user`, `project` |
| `harness uninstall` | `--scope` | `user`, `project` |
| `skills install` | `<scope>` (arg) | `user`, `project` |
| `skills uninstall` | `<scope>` (arg) | `all`, `user`, `project` |
| `prompt confirm` | `--default` | `yes`, `no` |

### 1.3 Native Number Parsing via `.argParser()`

Replace the citty workaround pattern (declare as string, convert in adapter
`run` handler) with commander's `.argParser()` on the option definition itself.

Options that gain `.argParser()`:
- `--tail <n>` → `parseIntArg(value, '--tail', { positive: true })`
- `--since-step <n>` → `parseIntArg(value, '--since-step')`
- `--iteration <n>` → `parseIntArg(value, '--iteration', { positive: true })`
- `--tokens-in <n>` → `parseIntArg(value, '--tokens-in')`
- `--tokens-out <n>` → `parseIntArg(value, '--tokens-out')`
- `--cost-usd <n>` → `parseFloatArg(value, '--cost-usd', { nonNegative: true })`
- `--duration-ms <n>` → `parseIntArg(value, '--duration-ms')`
- `--limit <n>` → `parseIntArg(value, '--limit', { positive: true })`
- `--timeout <seconds>` → `parseTimeout(value)`
- `--poll-interval <ms>` → inline `parseInt` with validation

The `parse-args.ts` module is retained and adapted to commander's `(value,
previous) => T` signature. The adapter `run` handlers no longer call these
parsers — they're invoked automatically by commander during parsing.

### 1.4 Required Options via `.requiredOption()`

Options that are currently `required: true` in citty become
`.requiredOption()` calls in commander, producing automatic error messages
instead of citty's silent undefined:

| Command | Option |
|---------|--------|
| `run init` | `--plan <path>` |
| `run complete` | `--run <id>` |
| `run reopen` | `--run <id>` |
| `run watch` | `--run <id>` |
| `prompt choose` | `--options <list>` |

### 1.5 Variadic Option for `--var`

The `--var` option on `invoke` and `template render` is used repeatedly
(`--var a=1 --var b=2`). In citty this produces ambiguous `string | string[]`.
In commander, declare as:

```ts
.option('--var <key=value...>', 'Template variable (repeatable)')
```

This is not strictly variadic in the commander sense (which reads multiple args
after a single flag). Instead, use `.argParser()` with a collect function:

```ts
.option('--var <key=value>', 'Template variable (repeatable)', collect, [])
```

where `collect` appends each value to the array. This always produces
`string[]`, eliminating the `string | string[]` ambiguity.

### 1.6 Negatable Booleans

Commander natively supports `--no-X` to negate boolean options. The following
existing negatable patterns are preserved:

| Option | Negation | Command |
|--------|----------|---------|
| `--pretty` | `--no-pretty` | global |
| `--require-commit` | `--no-require-commit` | `protocol validate author` |

Commander's approach: define `--no-pretty` explicitly alongside the positive
form. The `--require-commit` default of `true` is handled via `.default(true)`.

### 1.7 Error UX Improvements

```ts
program
  .showHelpAfterError('(use --help for additional information)')
  .showSuggestionAfterError(true);
```

This enables two features citty lacks entirely:
- After any validation error, a hint to use `--help` is shown
- Unknown commands/options trigger "did you mean X?" suggestions

### 1.8 `exitOverride` + JSON Envelope Integration

```ts
program.exitOverride((err) => {
  throw err; // Re-throw; caught by bin.ts error handler
});
```

The bin.ts error handler catches `CommanderError` (replacing the citty
`CLIError` catch) and routes through the JSON envelope system:
- Validation errors (missing required option, invalid choice, etc.) →
  `INVALID_ARGS` code, exit 1
- Unknown command → `UNKNOWN_COMMAND` code, exit 1, show usage
- Unknown option → `UNKNOWN_OPTION` code, exit 1, show suggestion

## Improvement Line 2: Help and Usage Content

### 2.1 Program-Level Help

The root `5x --help` output adds a global description and footer:

```
Usage: 5x [options] [command]

A toolbelt of primitives for the 5x workflow.

The 5x CLI manages implementation runs, invokes AI agents, validates
structured output, and orchestrates the plan-author-review development
cycle. It outputs JSON envelopes to stdout for machine consumption and
supports --pretty for human-readable formatting.

Options:
  --pretty               Format JSON output with indentation (default: auto-detect TTY)
  --no-pretty            Force compact JSON output
  -V, --version          Output the version number
  -h, --help             Display help for command

Commands:
  run                    Run lifecycle management
  invoke                 Invoke an AI agent with a prompt template
  quality                Quality gate operations
  plan                   Plan inspection operations
  diff                   Show git diff relative to a reference
  prompt                 Human interaction prompts
  init                   Initialize 5x workflow in the current project
  harness                Manage harness integrations
  template               Prompt template operations
  protocol               Structured protocol validation and recording
  skills                 Manage agent skills
  upgrade                Upgrade project config, database, and templates
  worktree               Manage git worktrees for plan execution
  help [command]         Display help for command

All commands output JSON envelopes ({ ok, data } or { ok, error }) to stdout.
Use --pretty for human-readable output. Exit codes: 0=success, 1=error,
2=not found, 3=non-interactive, 4=locked, 5=dirty, 6=limit, 7=invalid output.
```

### 2.2 Per-Command Descriptions and Examples

Below is the complete help content for every command. Each entry specifies the
`.summary()` (shown in parent listing), `.description()` (shown in own help),
and example block (via `.addHelpText('after', ...)`).

---

#### `run` (parent)

**Summary:** Run lifecycle management

**Description:**
Manage implementation runs — the unit of work in the 5x workflow. A run tracks
an AI agent's progress through an implementation plan, recording each step
(author, reviewer, quality gate) with metadata. Runs are backed by a local
SQLite database in the project's .5x directory.

---

#### `run init`

**Summary:** Initialize or resume a run for a plan

**Description:**
Create a new run for an implementation plan, or resume an existing active run
for the same plan. Optionally creates or attaches a git worktree for isolated
development. If a run already exists for the plan and is still active, returns
the existing run ID.

**Examples:**
```
Examples:
  $ 5x run init -p docs/development/015-test-separation.md
  $ 5x run init -p plan.md -w                        # create worktree
  $ 5x run init -p plan.md -w /tmp/my-worktree       # use specific path
  $ 5x run init -p plan.md --allow-dirty              # skip clean-worktree check
```

---

#### `run state`

**Summary:** Get run state including steps and summary

**Description:**
Retrieve the current state of a run: status, step history, and summary
metadata. Supports filtering to recent steps via --tail or --since-step for
efficient polling. Accepts either --run (by ID) or --plan (finds the active
run for that plan).

**Examples:**
```
Examples:
  $ 5x run state -r abc123
  $ 5x run state -p plan.md
  $ 5x run state -r abc123 -t 5                      # last 5 steps only
  $ 5x run state -r abc123 --since-step 42            # steps after #42
```

---

#### `run record`

**Summary:** Record a step in a run

**Description:**
Append a step to a run's history. Steps capture what happened (author
implementation, reviewer verdict, quality check) with optional metadata:
session ID, model, token counts, cost, and duration. The result can be
provided as a JSON string, read from stdin (-), or read from a file (@path).

**Examples:**
```
Examples:
  $ 5x run record author:impl:status -r abc123 --result '{"status":"complete"}'
  $ echo '{"ok":true}' | 5x run record quality:check -r abc123 --result=-
  $ 5x run record review:verdict -r abc123 --result=@/tmp/verdict.json
  $ 5x run record author:impl -r abc123 -p phase-1 --iteration 2 \
      --model claude-sonnet --tokens-in 5000 --tokens-out 2000
```

---

#### `run complete`

**Summary:** Complete or abort a run

**Description:**
Set a run's terminal status to "completed" or "aborted". Once completed, no
further steps can be recorded. Use "run reopen" to reverse this.

**Examples:**
```
Examples:
  $ 5x run complete -r abc123
  $ 5x run complete -r abc123 -s aborted --reason "Plan superseded"
```

---

#### `run reopen`

**Summary:** Reopen a completed or aborted run

**Description:**
Return a terminated run to active status, allowing additional steps to be
recorded. Useful when a run was completed prematurely.

**Examples:**
```
Examples:
  $ 5x run reopen -r abc123
```

---

#### `run list`

**Summary:** List runs with optional filters

**Description:**
List runs in the project database. Filter by plan path, status, or limit the
number of results. Returns an array of run summaries.

**Examples:**
```
Examples:
  $ 5x run list
  $ 5x run list -p plan.md
  $ 5x run list -s active -n 10
  $ 5x run list --status completed
```

---

#### `run watch`

**Summary:** Watch agent logs for a run in real-time

**Description:**
Tail the NDJSON log file for a run, streaming new entries as they are written.
In human-readable mode, formats log entries with timestamps and optional
reasoning display. Useful for monitoring a running agent session.

**Examples:**
```
Examples:
  $ 5x run watch -r abc123
  $ 5x run watch -r abc123 --human-readable --show-reasoning
  $ 5x run watch -r abc123 --tail-only                # skip replay, live only
```

---

#### `invoke` (parent)

**Summary:** Invoke an AI agent with a prompt template

**Description:**
Launch an author or reviewer agent with a prompt template. Templates are
rendered with variable substitution, then sent to the configured AI provider.
Supports session resumption, model override, timeout, and automatic run step
recording.

---

#### `invoke author`

**Summary:** Invoke an author agent with a template

**Description:**
Launch an author agent using the specified prompt template. The author agent
generates code, documentation, or other artifacts. Use --var to inject
template variables, --model to override the provider, and --record to
automatically save the result as a run step.

**Examples:**
```
Examples:
  $ 5x invoke author author-next-phase -r abc123
  $ 5x invoke author author-fix-quality -r abc123 --var user_notes="fix lint"
  $ 5x invoke author author-next-phase -r abc123 -m claude-opus -t 300
  $ 5x invoke author author-next-phase -r abc123 --record -p phase-1
```

---

#### `invoke reviewer`

**Summary:** Invoke a reviewer agent with a template

**Description:**
Launch a reviewer agent using the specified prompt template. The reviewer
agent evaluates code or plan quality and produces a structured verdict.

**Examples:**
```
Examples:
  $ 5x invoke reviewer reviewer-plan -r abc123
  $ 5x invoke reviewer reviewer-impl -r abc123 -p phase-1 --record
  $ 5x invoke reviewer reviewer-impl -r abc123 -q              # quiet mode
```

---

#### `quality` (parent)

**Summary:** Quality gate operations

**Description:**
Execute quality gates configured in 5x.toml. Gates are shell commands (build,
test, lint, typecheck) that validate code quality between iterations.

---

#### `quality run`

**Summary:** Execute configured quality gates

**Description:**
Run all quality gates defined in the project's 5x.toml configuration. Returns
a structured result indicating which gates passed and failed. Use --record to
save the result as a run step.

**Examples:**
```
Examples:
  $ 5x quality run
  $ 5x quality run --record -r abc123 -p phase-1
  $ 5x quality run -w /path/to/worktree
```

---

#### `plan` (parent)

**Summary:** Plan inspection operations

**Description:**
Inspect and parse implementation plans. Plans are markdown documents that
define phases of work for the 5x workflow.

---

#### `plan phases`

**Summary:** Parse a plan and return its phases

**Description:**
Read an implementation plan file and extract its phase structure. Returns an
array of phases with their names, descriptions, and step counts.

**Examples:**
```
Examples:
  $ 5x plan phases docs/development/015-test-separation.md
  $ 5x plan phases ./plan.md | jq '.data.phases[].name'
```

---

#### `diff`

**Summary:** Show git diff relative to a reference

**Description:**
Generate a git diff of the working tree or a worktree associated with a run.
Without --since, diffs the working tree against HEAD. With --since, diffs
against the specified git ref. Use --stat for a summary of changed files.

**Examples:**
```
Examples:
  $ 5x diff
  $ 5x diff -s main                                   # diff against main
  $ 5x diff -s HEAD~3 --stat                          # summary of last 3 commits
  $ 5x diff -r abc123                                 # diff in run's worktree
```

---

#### `prompt` (parent)

**Summary:** Human interaction prompts

**Description:**
Present interactive prompts to the user and return their response as JSON.
Used by agent orchestration to gather human input. Supports non-interactive
mode via defaults for CI/automation.

---

#### `prompt choose`

**Summary:** Present a choice prompt

**Description:**
Display a list of options and wait for the user to select one. Returns the
chosen value. In non-interactive environments, uses --default if provided.

**Examples:**
```
Examples:
  $ 5x prompt choose "Pick a strategy" -o "proceed,skip,abort"
  $ 5x prompt choose "Action?" -o "approve,reject" -d approve
```

---

#### `prompt confirm`

**Summary:** Present a yes/no confirmation prompt

**Description:**
Display a yes/no confirmation and return the boolean result. In
non-interactive environments, uses --default if provided.

**Examples:**
```
Examples:
  $ 5x prompt confirm "Deploy to production?"
  $ 5x prompt confirm "Continue?" -d yes
```

---

#### `prompt input`

**Summary:** Read text input from user or stdin pipe

**Description:**
Read a line of text input. In multiline mode, reads until EOF (Ctrl+D). When
stdin is a pipe, reads from the pipe regardless of --multiline.

**Examples:**
```
Examples:
  $ 5x prompt input "Enter your feedback"
  $ 5x prompt input "Paste content" --multiline
  $ echo "automated input" | 5x prompt input "Question"
```

---

#### `init`

**Summary:** Initialize 5x workflow in the current project

**Description:**
Create the .5x directory structure and 5x.toml configuration file in the
current project. Sets up the SQLite database, default templates, and
directory layout. Use --force to overwrite an existing configuration.

**Examples:**
```
Examples:
  $ 5x init
  $ 5x init -f                                        # overwrite existing config
```

---

#### `harness` (parent)

**Summary:** Manage harness integrations

**Description:**
Install, list, and uninstall harness integrations that connect 5x to AI agent
clients like OpenCode and Claude Code. Harnesses configure agent files, skills,
and MCP server settings.

---

#### `harness install`

**Summary:** Install a harness integration

**Description:**
Install a harness integration for the specified agent client. Creates
configuration files, agent definitions, and skill manifests. Use --scope to
control whether the harness is installed at user level (~/) or project level.

**Examples:**
```
Examples:
  $ 5x harness install opencode
  $ 5x harness install claude-code -s user
  $ 5x harness install opencode -s project -f         # overwrite existing
```

---

#### `harness list`

**Summary:** List available harness integrations

**Description:**
Show all available harness integrations with their installation status.

**Examples:**
```
Examples:
  $ 5x harness list
```

---

#### `harness uninstall`

**Summary:** Uninstall a harness integration

**Description:**
Remove a harness integration's configuration files. Use --scope to target a
specific scope, or --all to remove from all scopes.

**Examples:**
```
Examples:
  $ 5x harness uninstall opencode -s project
  $ 5x harness uninstall claude-code --all
```

---

#### `template` (parent)

**Summary:** Prompt template operations

**Description:**
Inspect and render prompt templates used by agent invocations. Templates use
variable substitution and are resolved from the project's template directory.

---

#### `template render`

**Summary:** Render a prompt template with variable substitution

**Description:**
Render a prompt template, substituting variables and resolving run context.
Returns the fully rendered template text. Use --var for explicit variables
and --run for run/worktree context resolution.

**Examples:**
```
Examples:
  $ 5x template render author-next-phase -r abc123
  $ 5x template render reviewer-plan --var plan_path=./plan.md
  $ 5x template render author-next-phase -r abc123 --session sess_abc
```

---

#### `protocol` (parent)

**Summary:** Structured protocol validation and recording

**Description:**
Validate JSON output from author and reviewer agents against the 5x protocol
schemas. Optionally record validated results as run steps.

---

#### `protocol validate` (intermediate parent)

**Summary:** Validate structured JSON against protocol schemas

**Description:**
Parse and validate JSON from a file or stdin against the author or reviewer
protocol schema. Returns the validated and normalized result.

---

#### `protocol validate author`

**Summary:** Validate an AuthorStatus structured result

**Description:**
Validate a JSON object against the AuthorStatus protocol schema. By default,
requires a commit hash for "complete" results; use --no-require-commit to
relax this constraint.

**Examples:**
```
Examples:
  $ 5x protocol validate author -i /tmp/author-result.json
  $ cat result.json | 5x protocol validate author
  $ 5x protocol validate author -i result.json --record -r abc123 -p phase-1
  $ 5x protocol validate author -i result.json --no-require-commit
```

---

#### `protocol validate reviewer`

**Summary:** Validate a ReviewerVerdict structured result

**Description:**
Validate a JSON object against the ReviewerVerdict protocol schema.

**Examples:**
```
Examples:
  $ 5x protocol validate reviewer -i /tmp/verdict.json
  $ cat verdict.json | 5x protocol validate reviewer --record -r abc123
```

---

#### `skills` (parent)

**Summary:** Manage agent skills

**Description:**
Install and uninstall 5x skill files that are discovered by AI agent clients.
Skills provide structured instructions for plan authoring, code review, and
phase execution.

---

#### `skills install`

**Summary:** Install skills for agent client discovery

**Description:**
Copy skill files to the specified scope directory. "user" installs to
~/.agents/skills/ for global availability; "project" installs to
.agents/skills/ for project-scoped access.

**Examples:**
```
Examples:
  $ 5x skills install user
  $ 5x skills install project -f                      # overwrite existing
  $ 5x skills install project --install-root .claude   # custom directory
```

---

#### `skills uninstall`

**Summary:** Uninstall skills from the specified scope

**Description:**
Remove 5x skill files from the specified scope. Use "all" to remove from
both user and project scopes.

**Examples:**
```
Examples:
  $ 5x skills uninstall project
  $ 5x skills uninstall all
```

---

#### `upgrade`

**Summary:** Upgrade project config, database, and templates

**Description:**
Run database migrations, update prompt templates, and apply any configuration
schema changes for the current 5x version. Safe to run multiple times; skips
already up-to-date components unless --force is used.

**Examples:**
```
Examples:
  $ 5x upgrade
  $ 5x upgrade -f                                     # force template refresh
```

---

#### `worktree` (parent)

**Summary:** Manage git worktrees for plan execution

**Description:**
Create, attach, detach, and remove git worktrees that isolate plan execution
from the main working tree. Worktrees are tracked in the run database and
automatically resolved by commands that accept --run.

---

#### `worktree create`

**Summary:** Create a git worktree for a plan

**Description:**
Create a new git worktree and associate it with an implementation plan. The
branch name defaults to a sanitized form of the plan filename. The worktree
is registered in the database for automatic resolution.

**Examples:**
```
Examples:
  $ 5x worktree create -p plan.md
  $ 5x worktree create -p plan.md -b feature/my-branch
  $ 5x worktree create -p plan.md --allow-nested
```

---

#### `worktree attach`

**Summary:** Attach an existing git worktree to a plan

**Description:**
Associate an existing git worktree with a plan in the database. Use this
when the worktree was created outside of 5x.

**Examples:**
```
Examples:
  $ 5x worktree attach -p plan.md --path /tmp/existing-worktree
```

---

#### `worktree detach`

**Summary:** Detach a plan from its worktree

**Description:**
Remove the association between a plan and its worktree in the database. The
git worktree itself is not removed.

**Examples:**
```
Examples:
  $ 5x worktree detach -p plan.md
```

---

#### `worktree remove`

**Summary:** Remove a worktree for a plan

**Description:**
Delete the git worktree associated with a plan and remove the database
association. Use --force to remove even with uncommitted changes.

**Examples:**
```
Examples:
  $ 5x worktree remove -p plan.md
  $ 5x worktree remove -p plan.md -f                  # force remove dirty
```

---

#### `worktree list`

**Summary:** List active worktrees

**Description:**
Show all worktrees tracked in the project database with their associated
plans and paths.

**Examples:**
```
Examples:
  $ 5x worktree list
```

### 2.3 Option Grouping

Commands with many options use help groups to organize them visually.
Commander's `.optionsGroup()` method sets the heading for subsequent options.

#### `invoke author` / `invoke reviewer` (16 options)

```
Template Options:
  <template>                 Template name (e.g. author-next-phase)
  --var <key=value>          Template variable (repeatable)
  --session <id>             Resume an existing session by ID

Execution Options:
  -r, --run <id>             Run ID
  -m, --model <name>         Model override
  -t, --timeout <seconds>    Per-run timeout in seconds
  -w, --workdir <path>       Working directory for agent tool execution
  --author-provider <name>   Override author provider
  --reviewer-provider <name> Override reviewer provider
  --opencode-url <url>       Override OpenCode server URL

Output Options:
  -q, --quiet                Suppress console output (stderr)
  --show-reasoning           Show agent reasoning/thinking in console output
  --stderr                   Stream output to stderr even when not a TTY

Recording Options:
  --record                   Auto-record the result as a run step
  --record-step <name>       Override step name for recording
  --phase <name>             Phase identifier (used with --record)
  --iteration <n>            Iteration number (used with --record)
```

#### `run record` (13 options)

```
Required:
  [step-name]                Step name (e.g. author:impl:status)
  -r, --run <id>             Run ID

Result:
  --result <value>           Result JSON (raw string, "-" for stdin, "@path" for file)

Metadata:
  -p, --phase <name>         Phase identifier
  --iteration <n>            Iteration number
  --session-id <id>          Agent session ID
  --model <name>             Model used

Metrics:
  --tokens-in <n>            Input tokens
  --tokens-out <n>           Output tokens
  --cost-usd <n>             Cost in USD
  --duration-ms <n>          Duration in milliseconds
  --log-path <path>          Path to NDJSON log file
```

Commands with 5 or fewer options use the default `Options:` group.

### 2.4 Global Footer

Add via `.addHelpText('afterAll', ...)` on the root program:

```
Documentation: https://github.com/5x-ai/5x-cli
Configuration: 5x.toml in project root
```

## Acceptance Criteria

1. **All 28 integration tests pass.** Tests asserting on help output text are
   updated. Tests asserting on JSON envelope output, exit codes, or handler
   behavior pass without changes.

2. **Zero handler file diffs.** No file matching `src/commands/*.handler.ts` is
   modified.

3. **`--help` works at every level.** `5x --help`, `5x run --help`,
   `5x run init --help`, `5x protocol validate author --help` all produce the
   documented help content.

4. **Short flags work.** `5x run init -p plan.md -w` is equivalent to
   `5x run init --plan plan.md --worktree`.

5. **Choice validation works.** `5x run complete -r abc -s invalid` produces
   `error: option '-s, --status <status>' argument 'invalid' is invalid.
   Allowed choices are completed, aborted.`

6. **Number parsing works.** `5x run state -r abc -t notanumber` produces a
   validation error.

7. **Suggestion works.** `5x run int` produces
   `error: unknown command 'int'. Did you mean 'init'?`

8. **JSON envelope contract preserved.** All error paths produce
   `{ ok: false, error: { code, message } }` on stdout.

9. **`--pretty` / `--no-pretty` works.** Global flag applies to all commands.

10. **`--worktree [path]` consolidation works.** Both `5x run init -p plan.md
    -w` (boolean) and `5x run init -p plan.md -w /tmp/wt` (with path) work.

11. **`bun build --compile` produces working binary.** Standalone binary passes
    the same integration tests.

12. **`parse-args.ts` is no longer called from adapter `run` handlers.** All
    numeric parsing happens in commander `.argParser()` callbacks.

## Reference Data

### Files to Rewrite (adapter layer)

| File | Lines | Type |
|------|-------|------|
| `src/bin.ts` | 141 | Entry point |
| `src/commands/run-v1.ts` | ~95 | 7 subcommands + parent |
| `src/commands/invoke.ts` | ~65 | Shared args + 2 subcommands |
| `src/commands/quality-v1.ts` | ~25 | 1 subcommand + parent |
| `src/commands/plan-v1.ts` | ~20 | 1 subcommand + parent |
| `src/commands/diff.ts` | ~15 | Leaf command |
| `src/commands/prompt.ts` | ~45 | 3 subcommands + parent |
| `src/commands/init.ts` | ~20 | Leaf command |
| `src/commands/harness.ts` | ~45 | 3 subcommands + parent |
| `src/commands/template.ts` | ~25 | 1 subcommand + parent |
| `src/commands/protocol.ts` | ~50 | 3-level nesting |
| `src/commands/skills.ts` | ~35 | 2 subcommands + parent |
| `src/commands/upgrade.ts` | ~15 | Leaf command |
| `src/commands/worktree.ts` | ~55 | 5 subcommands + parent |

**Total:** ~650 lines to rewrite (adapter + bin.ts)

### Files Unchanged (handler layer)

All 13 `*.handler.ts` files, `src/output.ts`, `src/version.ts`,
`src/utils/stdin.ts`, `src/commands/context.ts`, `src/commands/control-plane.ts`,
`src/commands/run-context.ts`, `src/commands/template-vars.ts`,
`src/commands/protocol-helpers.ts`.

### Files Modified (non-rewrite)

| File | Change |
|------|--------|
| `src/utils/parse-args.ts` | Adapt signatures for commander `.argParser()` callback pattern |
| `package.json` | Replace `citty` with `commander` + `@commander-js/extra-typings` |

### Test Files Likely Needing Updates

Integration tests that assert on help output, error messages from the framework
(unknown option text, missing argument text), or the exact stderr text of
validation errors. Handler-level assertions should be unaffected.
