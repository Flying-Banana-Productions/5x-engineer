# Test Stabilization and Unit/Integration Separation

**Version:** 1.3
**Created:** March 12, 2026
**Status:** Draft

## Overview

The 5x-cli test suite has 68 test files (~1200 tests) that all run under
`bun test --concurrent`. Three tests fail intermittently due to subprocess
contention: `isolated-mode.test.ts` (git commit failures/SIGINT timeouts),
and `harness.test.ts` (cold-start timeout). The root cause is
systemic — 31 files spawn subprocesses, 8 are missing `cleanGitEnv()`, and
there is no separation between unit and integration tests.

This plan refactors the test suite to:
1. Add `startDir` parameters to 4 handler files (12 call sites) so handlers
   can be tested directly without `process.chdir()` or subprocess overhead.
2. Create a `test/unit/` and `test/integration/` directory structure.
3. Move the 37 existing pure unit test files into `test/unit/`.
4. Convert 2 high-feasibility subprocess test files to direct-call unit tests.
5. Stabilize the remaining integration tests with `cleanGitEnv()`,
   `stdin: "ignore"`, and per-test `timeout:` options.
6. Document testing conventions in `5x-cli/AGENTS.md`.

## Design Decisions

**Add `startDir` as an optional trailing parameter with `resolve(".")` as
the default.** This preserves backward compatibility — CLI adapter code
(citty command definitions) passes no argument, getting the current
behavior. Tests pass an explicit temp directory. The parameter is added to
the top-level exported handler functions in `init.handler.ts`,
`harness.handler.ts`, `worktree.handler.ts`, and `upgrade.handler.ts`
(4 files, 12 call sites). `run-v1.handler.ts` is excluded — it has only 1
partially convertible call site, and the relative-path semantics for
`plan`/`worktreePath` inputs under a non-default `startDir` are
underspecified. It can be revisited in a follow-up if `run-v1` tests need
stabilization.

**Reorganize into `test/unit/` and `test/integration/` while preserving
subdirectory structure.** The current `test/commands/init.test.ts` becomes
`test/unit/commands/init.test.ts` (after conversion) or
`test/integration/commands/init.test.ts` (if it remains an integration
test). This preserves import proximity and mental model. The flat files at
`test/*.test.ts` move to `test/unit/*.test.ts` or
`test/integration/*.test.ts` accordingly. Bun's test runner discovers
`*.test.ts` recursively, so `bun test` continues to find all tests.

**Move files rather than copy-and-delete.** Using `git mv` ensures history
is preserved and avoids confusion during review.

**Stabilize integration tests in-place before moving.** Applying
`cleanGitEnv()`, `stdin: "ignore"`, and `timeout:` fixes first (Phase 1)
ensures tests pass in their current location. The directory restructuring
(Phase 3) is then a pure rename operation with no behavioral changes.

**Unit tests assert on return values and side effects, not console
output.** Converted unit tests must verify behavior through return values,
filesystem side effects (files written, config created), and DB records —
never by capturing or mocking `console.log`/`console.error`. Tests that
need to assert on CLI-facing output (exit codes, JSON envelopes, stderr
progress messages, formatted output) remain as integration tests. This
avoids the concurrency-unsafe global mutation patterns that `test/setup.ts`
documents and eliminates the need for logging injection seams.

**Convert only "high feasibility" test files.** Two files have handlers
already exported and tests that primarily assert filesystem side effects:
`init.test.ts` and `harness.test.ts`. `skills-install.test.ts` is
kept as an integration test — its tests exercise command-level behavior
(scope resolution, `--install-root`, stderr progress, success envelope)
that cannot be meaningfully validated without the CLI layer. The 4
"partial" conversions are deferred — they require deeper refactoring and
the risk/reward is lower.

## Phase 1: Stabilize Existing Integration Tests

**Completion gate:** `bun test --concurrent` passes 10 consecutive times
with zero failures. No behavioral changes to tests — only hardening.

- [x] Add `cleanGitEnv()` import and usage to the 8 files that are missing it:
  - `test/commands/init.test.ts` — add `import { cleanGitEnv }` from `../helpers/clean-env.js`, pass `env: cleanGitEnv()` to `Bun.spawn` in `runInit()` helper (line 33)
  - `test/commands/harness.test.ts` — add `cleanGitEnv()` to `runCmd()` (line 53); replace `{ ...process.env, ...env }` with `{ ...cleanGitEnv(), ...env }`
  - `test/commands/prompt.test.ts` — add `cleanGitEnv()` to all `Bun.spawn` calls
  - `test/commands/skills-install.test.ts` — add `cleanGitEnv()` to `runSkillsInstall()` (line 36); replace `{ ...process.env, ...env }` with `{ ...cleanGitEnv(), ...env }`
  - `test/commands/upgrade.test.ts` — add `cleanGitEnv()` to `Bun.spawn` calls
  - `test/bin-pretty.test.ts` — add `cleanGitEnv()` to `Bun.spawn` calls
  - `test/lock.test.ts` — add `cleanGitEnv()` to `Bun.spawn` calls (spawns `sleep`, low risk but consistent)
  - `test/pipe.test.ts` — add `cleanGitEnv()` to `Bun.spawn` calls
- [x] Add `stdin: "ignore"` to all `Bun.spawn` calls that don't intentionally use stdin:
  - `test/commands/init.test.ts` — `runInit()` (line 33)
  - `test/commands/harness.test.ts` — `runCmd()` (line 53)
  - `test/commands/skills-install.test.ts` — `runSkillsInstall()` (line 36)
  - `test/commands/control-plane.test.ts` — all `Bun.spawnSync` git calls
  - `test/bin-pretty.test.ts` — all `Bun.spawn` calls
  - `test/lock.test.ts` — `Bun.spawn` for `sleep`
  - Skip `test/commands/prompt.test.ts` (uses `stdin: "pipe"` intentionally)
  - Skip `test/pipe.test.ts` (uses `stdin: "pipe"` intentionally)
- [x] Add per-test `timeout:` option to all 22 subprocess-spawning test files missing it. Use `{ timeout: 15000 }` as the default (matching `bunfig.toml`), and `{ timeout: 30000 }` for tests with multiple sequential subprocess spawns:
  - `test/commands/control-plane.test.ts` — 15000
  - `test/commands/diff.test.ts` — 15000
  - `test/commands/init-guard.test.ts` — 15000
  - `test/commands/harness.test.ts` — 15000
  - `test/commands/init.test.ts` — 15000
  - `test/commands/plan-v1.test.ts` — 15000
  - `test/commands/prompt.test.ts` — 15000
  - `test/commands/quality-v1.test.ts` — 15000
  - `test/commands/run-init-worktree.test.ts` — 15000
  - `test/commands/run-record-pipe.test.ts` — 15000
  - `test/commands/run-scoped-context.test.ts` — 15000
  - `test/commands/run-v1.test.ts` — 15000
  - `test/commands/run-watch.test.ts` — 15000
  - `test/commands/skills-install.test.ts` — 15000
  - `test/commands/upgrade.test.ts` — 15000
  - `test/commands/worktree-guards.test.ts` — 15000
  - `test/commands/worktree-v1.test.ts` — 15000
  - `test/bin-pretty.test.ts` — 15000
  - `test/lock.test.ts` — 15000
  - `test/pipe.test.ts` — 15000
- [x] Verify `isolated-mode.test.ts` already has all three hardening patterns (confirmed: `cleanGitEnv`, `stdin: "ignore"`, `timeout: 30000`). No changes needed.
- [x] Run `bun test --concurrent` 10 times in a loop. All must pass.

## Phase 2: Refactor Handlers for Direct Testability

**Completion gate:** All 4 handler files (`init.handler.ts`,
`harness.handler.ts`, `worktree.handler.ts`, `upgrade.handler.ts`) accept
an optional `startDir` parameter. Existing tests still pass. No behavioral
changes to CLI output.

- [x] Refactor `src/commands/init.handler.ts` — `initScaffold()`:
  - Add `startDir?: string` to `InitParams` interface
  - Replace `resolve(".")` on lines 175–176 and 191 with `resolve(params.startDir ?? ".")`
  ```ts
  export interface InitParams {
    force?: boolean;
    startDir?: string;  // NEW
  }

  export async function initScaffold(params: InitParams): Promise<void> {
    const force = Boolean(params.force);
    const cwd = resolve(params.startDir ?? ".");
    const controlPlane = resolveControlPlaneRoot(cwd);
    const checkoutRoot = resolveCheckoutRoot(cwd);
    // ... line 191:
    const projectRoot = checkoutRoot ?? cwd;
    // ... rest unchanged
  }
  ```

- [x] Refactor `src/commands/harness.handler.ts` — `harnessInstall()`:
  - Add `startDir?: string` to `HarnessInstallParams` interface
  - Replace `resolve(".")` on lines 53–54 with `resolve(params.startDir ?? ".")`
  ```ts
  export interface HarnessInstallParams {
    name: string;
    scope?: string;
    force?: boolean;
    startDir?: string;  // NEW — defaults to resolve(".")
  }

  export async function harnessInstall(params: HarnessInstallParams): Promise<void> {
    // ...
    const cwd = resolve(params.startDir ?? ".");
    const checkoutRoot = resolveCheckoutRoot(cwd);
    const projectRoot = checkoutRoot ?? cwd;
    // ... rest unchanged
  }
  ```

- [x] Refactor `src/commands/worktree.handler.ts`:
  - Add `startDir?: string` to `WorktreeCreateParams`, `WorktreeRemoveParams`, `WorktreeAttachParams`, and `worktreeList()` (which currently takes no params — change to `worktreeList(params?: { startDir?: string })`)
  - Replace `resolve(".")` at 7 call sites (lines 87, 100, 154, 260, 310, 324, 397) with the `startDir` parameter threaded through
  - For `isLinkedWorktreeContext()` — change signature to accept `startDir` parameter:
  ```ts
  function isLinkedWorktreeContext(
    controlPlane: ControlPlaneResult,
    startDir?: string,
  ): boolean {
    const checkoutRoot = resolveCheckoutRoot(resolve(startDir ?? "."));
    if (!checkoutRoot) return false;
    return resolve(checkoutRoot) !== resolve(controlPlane.controlPlaneRoot);
  }
  ```
  - For `emitSplitBrainWarning()` — add `startDir` parameter:
  ```ts
  export function emitSplitBrainWarning(
    controlPlane: ControlPlaneResult,
    startDir?: string,
  ): void {
    if (controlPlane.mode !== "managed") return;
    const checkoutRoot = resolveCheckoutRoot(resolve(startDir ?? "."));
    // ... rest unchanged
  }
  ```
  - Thread `params.startDir` through `worktreeCreate`, `worktreeAttach`, `worktreeRemove`, `worktreeList`

- [x] Refactor `src/commands/upgrade.handler.ts` — `runUpgrade()`:
  - Add `startDir?: string` to `UpgradeParams` interface
  - Replace `resolve(".")` on line 325 with `resolve(params.startDir ?? ".")`
  ```ts
  export interface UpgradeParams {
    force?: boolean;
    startDir?: string;  // NEW
  }

  export async function runUpgrade(params: UpgradeParams): Promise<void> {
    const projectRoot = resolve(params.startDir ?? ".");
    // ... rest unchanged
  }
  ```

- [x] Verify no citty command definition files changed (they pass no `startDir`, getting the default).
- [x] Run `bun test --concurrent` — all tests pass unchanged.

## Phase 3: Create Directory Structure and Move Tests

**Completion gate:** `test/unit/` and `test/integration/` directories
exist. All test files are in the correct location. `bun test` discovers
and runs all tests. `bun test test/unit/` and `bun test test/integration/`
each run independently.

- [x] Revalidate the test file inventory before moving files. Run `find test/ -name '*.test.ts' | sort` and compare against the file lists in this plan. Reconcile any discrepancies (files added/removed since the plan was written). Update the unit/integration move lists below if the actual file set differs from what is documented.

- [x] Create directory structure:
  ```
  test/
  ├── unit/
  │   ├── commands/
  │   ├── db/
  │   ├── gates/
  │   ├── harnesses/
  │   ├── parsers/
  │   ├── providers/
  │   ├── skills/
  │   ├── templates/
  │   ├── tui/
  │   └── utils/
  ├── integration/
  │   └── commands/
  ├── helpers/        (stays — shared by both tiers)
  └── setup.ts        (stays — preload for all tests)
  ```

- [x] Move 37 pure unit test files to `test/unit/` preserving subdirectory structure. Use `git mv` for each:
  - `test/config.test.ts` → `test/unit/config.test.ts`
  - `test/config-layering.test.ts` → `test/unit/config-layering.test.ts`
  - `test/config-v1.test.ts` → `test/unit/config-v1.test.ts`
  - `test/env.test.ts` → `test/unit/env.test.ts`
  - `test/git.test.ts` → `test/unit/git.test.ts`
  - `test/output.test.ts` → `test/unit/output.test.ts`
  - `test/paths.test.ts` → `test/unit/paths.test.ts`
  - `test/protocol.test.ts` → `test/unit/protocol.test.ts`
  - `test/run-id.test.ts` → `test/unit/run-id.test.ts`
  - `test/commands/artifact-paths.test.ts` → `test/unit/commands/artifact-paths.test.ts`
  - `test/commands/protocol-helpers.test.ts` → `test/unit/commands/protocol-helpers.test.ts`
  - `test/commands/run-context.test.ts` → `test/unit/commands/run-context.test.ts`
  - `test/commands/init-skills.test.ts` → `test/unit/commands/init-skills.test.ts`
  - `test/db/*.test.ts` → `test/unit/db/*.test.ts` (5 files)
  - `test/gates/quality.test.ts` → `test/unit/gates/quality.test.ts`
  - `test/harnesses/*.test.ts` → `test/unit/harnesses/*.test.ts` (2 files)
  - `test/parsers/*.test.ts` → `test/unit/parsers/*.test.ts` (2 files)
  - `test/providers/*.test.ts` → `test/unit/providers/*.test.ts` (4 files)
  - `test/skills/skill-content.test.ts` → `test/unit/skills/skill-content.test.ts`
  - `test/templates/loader.test.ts` → `test/unit/templates/loader.test.ts`
  - `test/tui/*.test.ts` → `test/unit/tui/*.test.ts` (3 files)
  - `test/utils/*.test.ts` → `test/unit/utils/*.test.ts` (5 files)

- [x] Move 31 integration test files to `test/integration/` preserving subdirectory structure:
  - `test/commands/*.test.ts` (remaining 28 files after unit extractions) → `test/integration/commands/`
  - `test/bin-pretty.test.ts` → `test/integration/bin-pretty.test.ts`
  - `test/lock.test.ts` → `test/integration/lock.test.ts`
  - `test/pipe.test.ts` → `test/integration/pipe.test.ts`

- [x] Audit and update all relative import paths in moved test files. Do NOT rely on path-depth heuristics — inspect actual imports in each file:
  - For each moved file, extract all `import`/`require()` statements and dynamic `import()` calls
  - Compute the new relative path from the file's destination to the imported target
  - Top-level files moving from `test/*.test.ts` to `test/unit/*.test.ts`: these currently import from `../src/` — after the move, the depth increases by one, so paths become `../../src/`
  - Files in subdirectories moving from `test/commands/*.test.ts` to `test/unit/commands/*.test.ts` (or `test/integration/commands/`): these currently import from `../../src/` — after the move, paths become `../../../src/`
  - Helper imports: `../helpers/` → `../../helpers/` (for files that gain one directory level)
  - Validate: after all import rewrites, run `bun test --dry-run` or equivalent to confirm no import resolution errors before running the full suite

- [x] Verify `bun test` runs all tests (total count unchanged).
- [x] Verify `bun test test/unit/` runs only unit tests.
- [x] Verify `bun test test/integration/` runs only integration tests.
- [x] Verify `bun test test/unit/` completes in <5s.

## Phase 4: Convert High-Feasibility Tests to Unit Tests

**Completion gate:** 2 test files converted from subprocess-based
integration tests to direct-call unit tests. Converted tests assert only
on return values and filesystem side effects (files written, config
created) — never on console output. Tests that need CLI-output assertions
remain as integration tests. Total test count unchanged. All converted
tests pass under `--concurrent`.

- [x] Convert `test/integration/commands/init.test.ts` — the "5x init" describe block (tests 1–8) currently spawns `bun run BIN init`:
  - Import `initScaffold` directly from `../../../src/commands/init.handler.js`
  - Replace `runInit(tmp)` calls with `await initScaffold({ startDir: tmp })` + `await initScaffold({ force: true, startDir: tmp })`
  - All assertions must verify filesystem side effects (`existsSync`, `readFileSync`, file contents) — do NOT capture or mock `console.log`/`console.error`
  - Any tests that currently assert on CLI stdout/stderr text or exit codes stay in `test/integration/commands/init.test.ts` as integration tests
  - Move the converted tests to `test/unit/commands/init.test.ts`
  - The `ensureGitignore`, `generateTomlConfig`, and `ensureTemplateFiles` describe blocks are already unit tests (direct function calls) — move these as-is

- [x] Convert `test/integration/commands/harness.test.ts`:
  - Import `harnessInstall` directly from `../../../src/commands/harness.handler.js`
  - Replace `runHarnessInstall(tmp, "opencode", ["--scope", "project"])` with `await harnessInstall({ name: "opencode", scope: "project", startDir: tmp })`
  - Replace `runInit(tmp)` in `bootstrapProject()` with `await initScaffold({ startDir: tmp })`
  - The "fails when control plane absent" test: replace subprocess exit code check with `expect(async () => await harnessInstall(...)).toThrow()`
  - The "idempotent" test: call `harnessInstall` twice directly — no subprocess timeout issue
  - All assertions must verify filesystem side effects and thrown errors — do NOT capture or mock console output
  - Any tests that assert on CLI stdout/stderr text, exit codes, or HOME-dependent behavior that requires process-wide env mutation stay in `test/integration/commands/harness.test.ts`
  - Move the converted tests to `test/unit/commands/harness.test.ts`

- [x] `test/integration/commands/skills-install.test.ts` — **no conversion**. This file exercises command-level behavior (scope resolution, `--install-root`, stderr progress messages, success envelope) that requires the CLI layer. It stays as an integration test with `cleanGitEnv()` + `stdin: "ignore"` hygiene applied in Phase 1.

- [x] Verify total test count is unchanged after conversions.
- [x] Run `bun test --concurrent` — all pass.

## Phase 5: Document Testing Conventions

**Completion gate:** `5x-cli/AGENTS.md` exists with testing conventions.
Contents reviewed for accuracy against the final directory structure.

- [ ] Create `5x-cli/AGENTS.md` with the following sections:
  - **Test Tiers**: unit vs integration criteria (matching PRD definitions)
  - **Directory Layout**: `test/unit/` and `test/integration/` structure
  - **Running Tests**:
    - `bun test` — all tests (quality gate)
    - `bun test test/unit/` — unit tests only (<5s)
    - `bun test test/integration/` — integration tests only
  - **Required Patterns for Integration Tests**:
    - `cleanGitEnv()` — when and why
    - `stdin: "ignore"` — required for all non-interactive spawns
    - Per-test `timeout:` — required for all subprocess-spawning tests
  - **Where to Put New Tests**: decision tree based on subprocess/network/filesystem usage
  - **Handler `startDir` Convention**: document that handlers accept `startDir` for testability
  - **Test Setup**: `test/setup.ts` preload, `test/helpers/` shared utilities

- [ ] Verify `AGENTS.md` file renders correctly.

## Files Touched

| File | Change |
|------|--------|
| `src/commands/init.handler.ts` | Add `startDir` to `InitParams`; replace 3 `resolve(".")` calls |
| `src/commands/harness.handler.ts` | Add `startDir` to `HarnessInstallParams`; replace 2 `resolve(".")` calls |
| `src/commands/worktree.handler.ts` | Add `startDir` to param interfaces and helpers; replace 7 `resolve(".")` calls |
| `src/commands/upgrade.handler.ts` | Add `startDir` to `UpgradeParams`; replace 1 `resolve(".")` call |
| `test/commands/init.test.ts` | Add `cleanGitEnv()`, `stdin: "ignore"`, `timeout:`; then convert side-effect tests to unit tests and move |
| `test/commands/harness.test.ts` | Add `cleanGitEnv()`, `stdin: "ignore"`, `timeout:`; then convert side-effect tests to unit tests and move |
| `test/commands/skills-install.test.ts` | Add `cleanGitEnv()`, `stdin: "ignore"`, `timeout:` (stays as integration test — no conversion) |
| `test/commands/prompt.test.ts` | Add `cleanGitEnv()`, `timeout:` (stdin already "pipe") |
| `test/commands/upgrade.test.ts` | Add `cleanGitEnv()`, `timeout:` |
| `test/bin-pretty.test.ts` | Add `cleanGitEnv()`, `stdin: "ignore"`, `timeout:` |
| `test/lock.test.ts` | Add `cleanGitEnv()`, `stdin: "ignore"`, `timeout:` |
| `test/pipe.test.ts` | Add `cleanGitEnv()`, `timeout:` (stdin already "pipe") |
| `test/commands/control-plane.test.ts` | Add `stdin: "ignore"`, `timeout:` to spawnSync calls |
| `test/commands/diff.test.ts` | Add `timeout:` |
| `test/commands/init-guard.test.ts` | Add `timeout:` |
| `test/commands/plan-v1.test.ts` | Add `timeout:` |
| `test/commands/quality-v1.test.ts` | Add `timeout:` |
| `test/commands/run-init-worktree.test.ts` | Add `timeout:` |
| `test/commands/run-record-pipe.test.ts` | Add `timeout:` |
| `test/commands/run-scoped-context.test.ts` | Add `timeout:` |
| `test/commands/run-v1.test.ts` | Add `timeout:` |
| `test/commands/run-watch.test.ts` | Add `timeout:` |
| `test/commands/worktree-guards.test.ts` | Add `timeout:` |
| `test/commands/worktree-v1.test.ts` | Add `timeout:` |
| 37 unit test files | Move from `test/` to `test/unit/` (update import paths) |
| 31 integration test files | Move from `test/` to `test/integration/` (update import paths) |
| `5x-cli/AGENTS.md` | New file — testing conventions |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/commands/init.test.ts` | `initScaffold()` creates config, .5x/, .gitignore via filesystem side effects |
| Unit | `test/unit/commands/harness.test.ts` | `harnessInstall()` installs harness configs via filesystem side effects |
| Integration | `test/integration/commands/isolated-mode.test.ts` | Full isolated-mode CLI flow with worktrees |
| Integration | `test/integration/commands/init.test.ts` | Tests asserting CLI stdout/stderr/exit codes (if any) |
| Integration | `test/integration/commands/harness.test.ts` | HOME-dependent and CLI-output tests |
| Integration | `test/integration/commands/skills-install.test.ts` | Scope resolution, --install-root, stderr progress, JSON envelope |
| Stability | All integration tests | 10 consecutive `bun test --concurrent` passes |

## Not In Scope

- Achieving 100% code coverage
- Adding new test cases beyond what's needed for the refactoring
- Changing the test framework (Bun's built-in test runner)
- Modifying pre-commit or pre-push hooks
- Parallelism tuning (e.g., `--concurrency N`)
- Converting "partial feasibility" test files (`template-render`, `config-layering-integration`, `run-scoped-context`, `prompt`)
- Adding `startDir` to `run-v1.handler.ts` (1 call site; relative-path semantics for `plan`/`worktreePath` are underspecified — revisit in a follow-up)
- Converting `skills-install.test.ts` to unit tests (tests exercise command-level behavior requiring the CLI layer)
- Adding logging injection seams for console output capture
- Modifying `test/setup.ts` preload behavior

## Estimated Timeline

| Phase | Effort | Description |
|-------|--------|-------------|
| Phase 1 | 1 day | Stabilize integration tests (cleanGitEnv, stdin, timeout) |
| Phase 2 | 1 day | Refactor 4 handler files with startDir parameter |
| Phase 3 | 1–2 days | Create directory structure, move 68 files, fix imports |
| Phase 4 | 1–2 days | Convert 2 test files to direct-call unit tests |
| Phase 5 | 0.5 day | Write AGENTS.md |
| **Total** | **4.5–6.5 days** | |

## Revision History

### v1.3 (March 12, 2026) — Align with harness refactor (fefffe76b1)

- Overview and Phase 2 now reflect 4 handler files (12 call sites), not 3
  (13). `harness.handler.ts` added; `initOpencode()` removed.
- `harness.handler.ts` Phase 2 entry updated: 2 `resolve(".")` calls
  (lines 53–54), not 1.
- Files Touched table: removed stale `InitOpencodeParams` reference,
  renamed `init-opencode.test.ts` → `harness.test.ts`, added
  `harness.handler.ts` row.
- Tests table: replaced `initOpencode()` / `init-opencode.test.ts`
  references with `harnessInstall()` / `harness.test.ts`.
- Timeline Phase 2: "4 handler files" (was "3").

### v1.2 (March 12, 2026) — Address re-review feedback

Review addendum: `reviews/015-test-stabilization-and-separation.review.md`

- **P2.2** — Explicitly added `worktreeList()` to the Phase 2 `startDir`
  refactoring checklist. `worktreeList()` currently takes no parameters;
  the plan now specifies changing it to
  `worktreeList(params?: { startDir?: string })`.

### v1.1 (March 12, 2026) — Address review feedback

Review: `reviews/015-test-stabilization-and-separation.review.md`

- **P0.1** — Phase 4 conversion strategy now explicit: unit tests assert on
  return values and filesystem side effects only. Tests needing console output
  or exit code assertions stay as integration tests. No logging injection seams.
- **P1.1** — `skills-install.test.ts` stays as an integration test (exercises
  command-level behavior: scope resolution, `--install-root`, stderr progress,
  success envelope). Phase 1 hygiene (`cleanGitEnv` + `stdin: "ignore"`) still
  applied. Phase 4 converts 2 files, not 3.
- **P1.2** — `run-v1.handler.ts` removed from Phase 2 `startDir` refactoring.
  Only 1 call site with partial convertibility; relative-path semantics for
  `plan`/`worktreePath` are underspecified. Deferred to follow-up. Phase 2 now
  covers 3 handler files (13 call sites), not 4 (14).
- **P1.3** — Phase 3 import path guidance replaced with an audit-based approach:
  inspect actual imports in each moved file rather than relying on depth
  heuristics. Noted that top-level `test/*.test.ts` files import from `../src/`
  (not `../../src/`), so the move adds one level.
- **P2.1** — Added a pre-move inventory revalidation step at the start of
  Phase 3 to reconcile actual test files against the plan's file lists.
- Updated Files Touched table, Tests table, Design Decisions, Not In Scope,
  estimated timeline, and overview counts for consistency.

### v1.0 (March 12, 2026) — Initial draft

- Generated from PRD `015-test-stabilization-and-separation.prd.md`
- 5 phases: stabilize → refactor handlers → restructure → convert → document
