# Test Stabilization and Unit/Integration Separation

**Version:** 1.0
**Created:** March 12, 2026
**Status:** Draft

## Overview

The 5x-cli test suite has 68 test files (~1200 tests) that all run under
`bun test --concurrent`. Three tests fail intermittently due to subprocess
contention: `isolated-mode.test.ts` (git commit failures/SIGINT timeouts),
and `init-opencode.test.ts` (cold-start timeout). The root cause is
systemic — 31 files spawn subprocesses, 8 are missing `cleanGitEnv()`, and
there is no separation between unit and integration tests.

This plan refactors the test suite to:
1. Add `startDir` parameters to 4 handler files (14 call sites) so handlers
   can be tested directly without `process.chdir()` or subprocess overhead.
2. Create a `test/unit/` and `test/integration/` directory structure.
3. Move the 37 existing pure unit test files into `test/unit/`.
4. Convert 3 high-feasibility subprocess test files to direct-call unit tests.
5. Stabilize the remaining integration tests with `cleanGitEnv()`,
   `stdin: "ignore"`, and per-test `timeout:` options.
6. Document testing conventions in `5x-cli/AGENTS.md`.

## Design Decisions

**Add `startDir` as an optional trailing parameter with `resolve(".")` as
the default.** This preserves backward compatibility — CLI adapter code
(citty command definitions) passes no argument, getting the current
behavior. Tests pass an explicit temp directory. The parameter is added to
the top-level exported handler functions, not to internal helpers that
already accept path parameters.

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

**Convert only "high feasibility" test files.** The PRD identifies 3 files
where the handler is already exported and all tests can call it directly:
`init-opencode.test.ts`, `init.test.ts`, `skills-install.test.ts`. The 4
"partial" conversions are deferred — they require deeper refactoring and
the risk/reward is lower.

## Phase 1: Stabilize Existing Integration Tests

**Completion gate:** `bun test --concurrent` passes 10 consecutive times
with zero failures. No behavioral changes to tests — only hardening.

- [ ] Add `cleanGitEnv()` import and usage to the 8 files that are missing it:
  - `test/commands/init.test.ts` — add `import { cleanGitEnv }` from `../helpers/clean-env.js`, pass `env: cleanGitEnv()` to `Bun.spawn` in `runInit()` helper (line 33)
  - `test/commands/init-opencode.test.ts` — add `cleanGitEnv()` to `runInit()` (line 54) and `runInitOpencode()` (line 72); replace `{ ...process.env, ...env }` with `{ ...cleanGitEnv(), ...env }`
  - `test/commands/prompt.test.ts` — add `cleanGitEnv()` to all `Bun.spawn` calls
  - `test/commands/skills-install.test.ts` — add `cleanGitEnv()` to `runSkillsInstall()` (line 36); replace `{ ...process.env, ...env }` with `{ ...cleanGitEnv(), ...env }`
  - `test/commands/upgrade.test.ts` — add `cleanGitEnv()` to `Bun.spawn` calls
  - `test/bin-pretty.test.ts` — add `cleanGitEnv()` to `Bun.spawn` calls
  - `test/lock.test.ts` — add `cleanGitEnv()` to `Bun.spawn` calls (spawns `sleep`, low risk but consistent)
  - `test/pipe.test.ts` — add `cleanGitEnv()` to `Bun.spawn` calls
- [ ] Add `stdin: "ignore"` to all `Bun.spawn` calls that don't intentionally use stdin:
  - `test/commands/init.test.ts` — `runInit()` (line 33)
  - `test/commands/init-opencode.test.ts` — `runInit()` (line 54) and `runInitOpencode()` (line 72)
  - `test/commands/skills-install.test.ts` — `runSkillsInstall()` (line 36)
  - `test/commands/control-plane.test.ts` — all `Bun.spawnSync` git calls
  - `test/bin-pretty.test.ts` — all `Bun.spawn` calls
  - `test/lock.test.ts` — `Bun.spawn` for `sleep`
  - Skip `test/commands/prompt.test.ts` (uses `stdin: "pipe"` intentionally)
  - Skip `test/pipe.test.ts` (uses `stdin: "pipe"` intentionally)
- [ ] Add per-test `timeout:` option to all 22 subprocess-spawning test files missing it. Use `{ timeout: 15000 }` as the default (matching `bunfig.toml`), and `{ timeout: 30000 }` for tests with multiple sequential subprocess spawns:
  - `test/commands/control-plane.test.ts` — 15000
  - `test/commands/diff.test.ts` — 15000
  - `test/commands/init-guard.test.ts` — 15000
  - `test/commands/init-opencode.test.ts` — 15000
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
- [ ] Verify `isolated-mode.test.ts` already has all three hardening patterns (confirmed: `cleanGitEnv`, `stdin: "ignore"`, `timeout: 30000`). No changes needed.
- [ ] Run `bun test --concurrent` 10 times in a loop. All must pass.

## Phase 2: Refactor Handlers for Direct Testability

**Completion gate:** All 4 handler files accept an optional `startDir`
parameter. Existing tests still pass. No behavioral changes to CLI output.

- [ ] Refactor `src/commands/init.handler.ts` — `initOpencode()`:
  - Add `startDir?: string` to `InitOpencodeParams` interface
  - Replace `resolve(".")` on lines 198–199 with `resolve(params.startDir ?? ".")`
  ```ts
  export interface InitOpencodeParams {
    scope: "user" | "project";
    force?: boolean;
    startDir?: string;  // NEW — defaults to resolve(".")
  }

  export async function initOpencode(params: InitOpencodeParams): Promise<void> {
    const cwd = resolve(params.startDir ?? ".");
    const checkoutRoot = resolveCheckoutRoot(cwd);
    const projectRoot = checkoutRoot ?? cwd;
    // ... rest unchanged
  }
  ```

- [ ] Refactor `src/commands/init.handler.ts` — `initScaffold()`:
  - Add `startDir?: string` to `InitParams` interface
  - Replace `resolve(".")` on lines 288–289 and 304 with `resolve(params.startDir ?? ".")`
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
    // ... line 304:
    const projectRoot = checkoutRoot ?? cwd;
    // ... rest unchanged
  }
  ```

- [ ] Refactor `src/commands/worktree.handler.ts`:
  - Add `startDir?: string` to `WorktreeCreateParams`, `WorktreeRemoveParams`, `WorktreeAttachParams`
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

- [ ] Refactor `src/commands/run-v1.handler.ts` — `ensureRunWorktree()`:
  - Replace `resolve(".")` on line 308 with a `startDir` parameter passed from the caller
  - Modify the `ensureRunWorktree` call in `runV1Init` to pass `startDir` through
  ```ts
  // In ensureRunWorktree, add startDir parameter:
  async function ensureRunWorktree(
    db: Database,
    projectRoot: string,
    planPath: string,
    explicitPath: string | undefined,
    postCreateHook: string | undefined,
    stateDir?: string,
    startDir?: string,  // NEW
  ): Promise<WorktreeInitResult> {
    // ... line 308:
    const cwd = resolve(startDir ?? ".");
    // ... rest unchanged
  }
  ```

- [ ] Refactor `src/commands/upgrade.handler.ts` — `runUpgrade()`:
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

- [ ] Verify no citty command definition files changed (they pass no `startDir`, getting the default).
- [ ] Run `bun test --concurrent` — all tests pass unchanged.

## Phase 3: Create Directory Structure and Move Tests

**Completion gate:** `test/unit/` and `test/integration/` directories
exist. All test files are in the correct location. `bun test` discovers
and runs all tests. `bun test test/unit/` and `bun test test/integration/`
each run independently.

- [ ] Create directory structure:
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

- [ ] Move 37 pure unit test files to `test/unit/` preserving subdirectory structure. Use `git mv` for each:
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

- [ ] Move 31 integration test files to `test/integration/` preserving subdirectory structure:
  - `test/commands/*.test.ts` (remaining 28 files after unit extractions) → `test/integration/commands/`
  - `test/bin-pretty.test.ts` → `test/integration/bin-pretty.test.ts`
  - `test/lock.test.ts` → `test/integration/lock.test.ts`
  - `test/pipe.test.ts` → `test/integration/pipe.test.ts`

- [ ] Update all relative import paths in moved test files. Each file's imports to `../../src/...` will change depth based on new location:
  - Files at `test/unit/*.test.ts` and `test/integration/*.test.ts`: `../../src/` stays the same (still two levels up from `5x-cli/`)
  - Files at `test/unit/commands/*.test.ts` and `test/integration/commands/*.test.ts`: `../../src/` → `../../../src/` (one deeper)
  - Files at `test/unit/db/*.test.ts`, `test/unit/gates/*.test.ts`, etc.: `../../src/` → `../../../src/` (one deeper)
  - Helper imports: `../helpers/clean-env.js` → `../../helpers/clean-env.js` (for files in subdirectories)
  - `test/helpers/watch-error-harness.ts` and `test/helpers/pipe-read-helper.ts` — update any imports in integration tests that reference them

- [ ] Verify `bun test` runs all tests (total count unchanged).
- [ ] Verify `bun test test/unit/` runs only unit tests.
- [ ] Verify `bun test test/integration/` runs only integration tests.
- [ ] Verify `bun test test/unit/` completes in <5s.

## Phase 4: Convert High-Feasibility Tests to Unit Tests

**Completion gate:** 3 test files converted from subprocess-based
integration tests to direct-call unit tests. Test assertions preserved.
Total test count unchanged. All converted tests pass under `--concurrent`.

- [ ] Convert `test/integration/commands/init.test.ts` — the "5x init" describe block (tests 1–8) currently spawns `bun run BIN init`:
  - Import `initScaffold` directly from `../../../src/commands/init.handler.js`
  - Replace `runInit(tmp)` calls with `await initScaffold({ startDir: tmp })` + `await initScaffold({ force: true, startDir: tmp })`
  - Capture console output by temporarily replacing `console.log` within each test (scoped, not global) or by checking filesystem side effects directly (preferred — most assertions already check `existsSync` and `readFileSync`)
  - Move the converted file to `test/unit/commands/init.test.ts`
  - The `ensureGitignore`, `generateTomlConfig`, and `ensureTemplateFiles` describe blocks are already unit tests (direct function calls) — move these as-is

- [ ] Convert `test/integration/commands/init-opencode.test.ts`:
  - Import `initOpencode` directly from `../../../src/commands/init.handler.js`
  - Replace `runInitOpencode(tmp, "project")` with `await initOpencode({ scope: "project", startDir: tmp })`
  - Replace `runInit(tmp)` in `bootstrapProject()` with `await initScaffold({ startDir: tmp })`
  - The "fails with clear error" tests: replace subprocess exit code checks with `expect(async () => await initOpencode(...)).toThrow()`
  - The "idempotent" test: call `initOpencode` twice directly — no subprocess timeout issue
  - Move the converted file to `test/unit/commands/init-opencode.test.ts`

- [ ] Convert `test/integration/commands/skills-install.test.ts`:
  - Import `installSkillFiles` from `../../../src/harnesses/installer.js` and `listSkills`/`listSkillNames` from `../../../src/skills/loader.js`
  - Replace `runSkillsInstall(tmp, "project")` with direct `installSkillFiles(targetDir, skills, force)` calls
  - The tests primarily assert filesystem side effects (`existsSync`, `readFileSync`) — these work identically with direct calls
  - The "JSON envelope" and "--pretty" tests remain integration tests (they test the CLI output format) — keep those in `test/integration/`
  - Move the converted tests to `test/unit/commands/skills-install.test.ts`; keep CLI-envelope tests as `test/integration/commands/skills-install.test.ts`

- [ ] Verify total test count is unchanged after conversions.
- [ ] Run `bun test --concurrent` — all pass.

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
| `src/commands/init.handler.ts` | Add `startDir` to `InitParams` and `InitOpencodeParams`; replace 5 `resolve(".")` calls |
| `src/commands/worktree.handler.ts` | Add `startDir` to param interfaces and helpers; replace 7 `resolve(".")` calls |
| `src/commands/run-v1.handler.ts` | Thread `startDir` through `ensureRunWorktree()`; replace 1 `resolve(".")` call |
| `src/commands/upgrade.handler.ts` | Add `startDir` to `UpgradeParams`; replace 1 `resolve(".")` call |
| `test/commands/init.test.ts` | Add `cleanGitEnv()`, `stdin: "ignore"`, `timeout:`; then convert to unit test and move |
| `test/commands/init-opencode.test.ts` | Add `cleanGitEnv()`, `stdin: "ignore"`, `timeout:`; then convert to unit test and move |
| `test/commands/skills-install.test.ts` | Add `cleanGitEnv()`, `stdin: "ignore"`, `timeout:`; then partially convert and split |
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
| Unit | `test/unit/commands/init.test.ts` | `initScaffold()` creates config, .5x/, .gitignore directly |
| Unit | `test/unit/commands/init-opencode.test.ts` | `initOpencode()` installs skills/agents directly |
| Unit | `test/unit/commands/skills-install.test.ts` | `installSkillFiles()` creates/skips/overwrites directly |
| Integration | `test/integration/commands/isolated-mode.test.ts` | Full isolated-mode CLI flow with worktrees |
| Integration | `test/integration/commands/init-opencode.test.ts` | Legacy CLI compatibility tests (bare `5x init --force`) |
| Integration | `test/integration/commands/skills-install.test.ts` | CLI JSON envelope output format |
| Stability | All integration tests | 10 consecutive `bun test --concurrent` passes |

## Not In Scope

- Achieving 100% code coverage
- Adding new test cases beyond what's needed for the refactoring
- Changing the test framework (Bun's built-in test runner)
- Modifying pre-commit or pre-push hooks
- Parallelism tuning (e.g., `--concurrency N`)
- Converting "partial feasibility" test files (`template-render`, `config-layering-integration`, `run-scoped-context`, `prompt`)
- Modifying `test/setup.ts` preload behavior

## Estimated Timeline

| Phase | Effort | Description |
|-------|--------|-------------|
| Phase 1 | 1 day | Stabilize integration tests (cleanGitEnv, stdin, timeout) |
| Phase 2 | 1 day | Refactor 4 handler files with startDir parameter |
| Phase 3 | 1–2 days | Create directory structure, move 68 files, fix imports |
| Phase 4 | 1–2 days | Convert 3 test files to direct-call unit tests |
| Phase 5 | 0.5 day | Write AGENTS.md |
| **Total** | **4.5–6.5 days** | |

## Revision History

### v1.0 (March 12, 2026) — Initial draft

- Generated from PRD `015-test-stabilization-and-separation.prd.md`
- 5 phases: stabilize → refactor handlers → restructure → convert → document
