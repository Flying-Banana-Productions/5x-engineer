# PRD: Test Stabilization and Unit/Integration Separation

**Created:** March 12, 2026

## Problem Statement

The 5x-cli test suite has intermittent failures under `bun test --concurrent`.
Tests pass in isolation but fail when the full suite runs concurrently — both
across files and within files (Bun runs all tests concurrently unless `.serial`
is used).

Three tests have been observed to fail:

1. **`test/commands/isolated-mode.test.ts`** — two tests fail intermittently
   with `git commit` failures or exit code 130 (SIGINT timeout). The file's 6
   tests spawn up to 21 subprocesses and 60 synchronous git operations
   concurrently.

2. **`test/commands/init-opencode.test.ts`** — "idempotent" test times out
   after 5000ms. It spawns 3 sequential `bun run BIN` subprocesses, each
   cold-starting the Bun runtime, which exceeds the default timeout under
   concurrent load.

The root cause is systemic: many tests that could be fast, deterministic unit
tests are instead implemented as integration tests that spawn real subprocesses.
The codebase has no distinction between unit and integration tests — all 66 test
files live in a flat structure under `test/` and run together with `--concurrent`.

## Current State

- **66 test files**, ~1200 tests, run time ~10-12s under `--concurrent`
- **31 files** spawn subprocesses (Bun.spawn or Bun.spawnSync)
- **8 files** missing `cleanGitEnv()` (risk of env var leakage in git hook
  contexts)
- **16 files** with subprocesses have no per-test `timeout:` option
- **No unit/integration separation** — all tests run in one pass
- **Handler functions use `resolve(".")`** (implicit CWD) at 14 call sites
  across 4 handler files, making direct invocation from tests impossible without
  `process.chdir()` (which is unsafe under concurrency)
- **`resolveControlPlaneRoot` and `resolveCheckoutRoot`** already accept a
  `startDir` parameter — the threading is missing only at the handler level
- **Pre-push hook runs the full test suite**; pre-commit runs only lint +
  typecheck
- **Quality gate** is `bun run test` (the full concurrent suite)

## Goals

1. **Eliminate flaky tests.** The three known flaky tests must be deterministic
   at any concurrency level.

2. **Separate unit and integration tests.** Establish a clear boundary:
   - **Unit tests**: no subprocesses, no real git repos, no filesystem side
     effects outside of temp dirs, no network. May use in-memory SQLite. Target
     <250ms per test.
   - **Integration tests**: may spawn subprocesses, create real git repos,
     exercise the full CLI entry point. Inherently slower and more
     resource-sensitive.

3. **Refactor handlers for direct testability.** Add an explicit `startDir`
   parameter to handler functions that currently use `resolve(".")`, enabling
   unit tests to call handlers directly without subprocess overhead.

4. **Establish testing conventions.** Create `AGENTS.md` at `5x-cli/AGENTS.md`
   that documents:
   - Unit vs integration test criteria
   - Required patterns for subprocess-based tests (cleanGitEnv, stdin:"ignore",
     per-test timeout)
   - Where new tests should go
   - How to run each test tier independently

5. **Support independent execution.** Unit tests should be runnable separately
   (`bun test test/unit/`) for fast feedback. Integration tests should be
   runnable separately (`bun test test/integration/`). The full suite
   (`bun test`) should still work.

6. **Maintain total test count.** No tests should be deleted. Tests that are
   currently integration tests but can be converted to unit tests should be
   converted. Tests that must remain integration tests should be stabilized.

## Non-Goals

- Achieving 100% code coverage
- Adding new test cases beyond what's needed for the refactoring
- Changing the test framework (Bun's built-in test runner)
- Modifying the pre-commit or pre-push hooks (though the plan may recommend
  future changes)
- Parallelism tuning for integration tests (e.g., `--concurrency N`) — this is
  a Bun feature that may not exist yet

## Constraints

- Handler refactoring must be backward-compatible. The `startDir` parameter must
  be optional with `resolve(".")` as the default. CLI adapter code (citty
  command definitions) should not change.
- Existing test assertions should not change unless the test is being converted
  from integration to unit. Refactoring must preserve test intent.
- The `test/setup.ts` preload (which suppresses console and sanitizes git env
  vars) applies to all tests and should continue to do so.
- `bun run test` (the quality gate) must continue to run all tests.

## Acceptance Criteria

- The three known flaky tests pass reliably under `bun test --concurrent` on
  repeated runs (10+ consecutive passes with no failures).
- `bun test test/unit/` runs all unit tests in <5s.
- `bun test test/integration/` runs all integration tests.
- `bun test` runs everything (backward-compatible).
- `5x-cli/AGENTS.md` exists with testing conventions documented.
- All 4 handler files (`init.handler.ts`, `worktree.handler.ts`,
  `run-v1.handler.ts`, `upgrade.handler.ts`) accept an explicit `startDir`
  parameter.
- No subprocess-spawning test file is missing `cleanGitEnv()` or
  `stdin: "ignore"`.

## Reference Data

### Handler `resolve(".")` call sites (14 total)

| File | Line(s) | Functions |
|------|---------|-----------|
| `src/commands/init.handler.ts` | 198, 199, 288, 289, 304 | `initOpencode()`, `initScaffold()` |
| `src/commands/worktree.handler.ts` | 87, 100, 154, 260, 310, 324, 397 | Various worktree handlers + helpers |
| `src/commands/run-v1.handler.ts` | 308 | `resolveWorktreeTarget()` |
| `src/commands/upgrade.handler.ts` | 325 | `runUpgrade()` |

### Test files convertible to direct function calls

| File | Current subprocess count | Conversion feasibility |
|------|:------------------------:|------------------------|
| `commands/init-opencode.test.ts` | 2 per test | High — `initOpencode()` is exported |
| `commands/init.test.ts` | 1 | High — `initScaffold()` is exported |
| `commands/skills-install.test.ts` | 1 | High — `installSkillFiles()` is exported |
| `commands/template-render.test.ts` | 6 | Partial — `renderTemplate()` is importable |
| `commands/config-layering-integration.test.ts` | 2 | Partial — `loadConfig()` is importable |
| `commands/run-scoped-context.test.ts` | 7 | Partial — context resolution is importable |
| `commands/prompt.test.ts` | 1 | Partial — non-interactive paths testable directly |

### DB module exports (for direct test use)

- `Database` from `bun:sqlite`
- `runMigrations` from `src/db/schema.ts`
- `getDb`, `_resetForTest` from `src/db/connection.ts`

### Files missing `cleanGitEnv()` (8)

`init.test.ts`, `init-opencode.test.ts`, `prompt.test.ts`,
`skills-install.test.ts`, `upgrade.test.ts`, `bin-pretty.test.ts`,
`lock.test.ts`, `pipe.test.ts`
