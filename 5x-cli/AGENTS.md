# 5x-cli Agent Guide

## Harness freshness warnings

When `5x run init` returns additive `warnings` / `harness_freshness` fields (or
prints a stderr freshness warning), the orchestrator **must surface them** to
the operator — do not ignore or suppress them. They mean installed harness
assets no longer match the current config; the fix is `5x harness sync` (plain
`harness install` preserves existing agent files and does not establish a
verified baseline). Honor `harness.freshnessWarnings = "off"` when the operator
has explicitly silenced the signal.

## Recovery

`5x doctor` is the recovery front door: it reports harness freshness, locks,
worktrees, lingering runs, and DB health. Use `5x doctor --fix` only for the
safe repairs (stale/corrupt locks, dead worktree mappings, lossless project
harness sync). Targeted lock questions go through `5x lock list` / `5x unlock`;
live holders require `5x unlock <plan> --force`.

Run-scoped commands resolve `--run` from `FIVEX_RUN`, a unique linked-worktree
mapping, or `.5x/current-run` when the flag is omitted; prompt-queue and
invocation-registry workers still pass `--run` explicitly.

## Test Tiers

**Unit tests** (`test/unit/`) — call functions directly, assert on return values and filesystem side effects (files written, config created, DB records). No subprocesses, no network, no console output capture. Must run deterministically under `--concurrent`.

**Integration tests** (`test/integration/`) — spawn the CLI binary via `Bun.spawn`/`Bun.spawnSync`, assert on stdout/stderr text, exit codes, or JSON envelopes. May use temp git repos, subprocesses, or process-wide env mutation.

## Directory Layout

```
test/
├── unit/
│   ├── commands/          # direct-call handler tests
│   ├── db/                # database schema & operations
│   ├── gates/             # quality gate logic
│   ├── harnesses/         # harness installer logic
│   ├── parsers/           # plan/review parsers
│   ├── providers/         # provider adapters
│   ├── skills/            # skill content loading
│   ├── templates/         # template loader
│   ├── tui/               # TUI controller & permissions
│   ├── utils/             # ansi, ndjson, parse-args, etc.
│   └── *.test.ts          # config, env, git, output, paths, protocol, run-id
├── integration/
│   ├── commands/          # CLI subprocess tests
│   └── *.test.ts          # bin-pretty, lock, pipe
├── helpers/               # shared by both tiers
│   ├── clean-env.ts       # cleanGitEnv() — sanitized env for spawns
│   ├── pipe-read-helper.ts
│   └── watch-error-harness.ts
└── setup.ts               # preload: silences console.log/warn, deletes GIT_DIR
```

## Running Tests

```bash
bun test                      # all tests (quality gate)
bun test test/unit/           # unit tests only (<5s)
bun test test/integration/    # integration tests only
bun test --concurrent         # parallel execution (CI default)
```

Config in `bunfig.toml`: `timeout = 15000`, `preload = ["./test/setup.ts"]`.

## Required Patterns for Integration Tests

### `cleanGitEnv()`

Every `Bun.spawn`/`Bun.spawnSync` call that runs git (or spawns a process that will run git) must pass `env: cleanGitEnv()`. Bun's `delete process.env.X` doesn't call `unsetenv()` at the C level, so child processes still inherit `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` from git hooks.

```ts
import { cleanGitEnv } from "../../helpers/clean-env.js";

Bun.spawnSync(["git", "init"], { cwd: tmp, env: cleanGitEnv() });
```

### `stdin: "ignore"`

All `Bun.spawn`/`Bun.spawnSync` calls that don't intentionally read stdin must pass `stdin: "ignore"`. Prevents hangs from inherited stdin under concurrent execution. Exception: tests that use `stdin: "pipe"` intentionally (e.g., prompt, pipe tests).

### Per-test `timeout:`

All subprocess-spawning tests should include a `timeout` option in the test/describe block. Default `15000`; use `30000` for tests with multiple sequential spawns.

```ts
test("spawns CLI", async () => { ... }, { timeout: 15000 });
```

## Where to Put New Tests

1. Does the test call a function directly and assert on return values or filesystem side effects? → `test/unit/`
2. Does the test spawn the CLI binary, assert on stdout/stderr, or check exit codes? → `test/integration/`
3. Does the test require process-wide env mutation or `HOME` overrides? → `test/integration/`
4. Mirror the `src/` subdirectory structure: handler tests go in `commands/`, DB tests in `db/`, etc.

## Handler `startDir` Convention

Four handlers accept an optional `startDir` parameter for testability:

- `initScaffold({ startDir })` — `src/commands/init.handler.ts`
- `harnessInstall({ startDir })` — `src/commands/harness.handler.ts`
- `worktreeCreate/Attach/Remove/List({ startDir })` — `src/commands/worktree.handler.ts`
- `runUpgrade({ startDir })` — `src/commands/upgrade.handler.ts`

Default is `resolve(".")`. CLI adapter code (citty command definitions) passes no argument. Tests pass an explicit temp directory to avoid `process.chdir()` and subprocess overhead.

```ts
// Unit test — call handler directly with startDir
await initScaffold({ startDir: tmp });
expect(existsSync(join(tmp, ".5x"))).toBe(true);
```

## Test Setup

- **`test/setup.ts`** — preloaded by `bunfig.toml`. Silences `console.log`/`console.warn` (no-ops) and deletes `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` from `process.env`.
- **`test/helpers/`** — shared utilities for both tiers. `cleanGitEnv()` is the most critical; always use it in integration tests that spawn git.
- **Warning assertions** — don't monkey-patch `console.warn`. Use dependency-injected warning sinks (see `setup.ts` doc comment for patterns).
