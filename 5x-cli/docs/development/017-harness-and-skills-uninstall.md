# Harness & Skills Uninstall Support

**Version:** 1.4
**Created:** March 13, 2026
**Status:** Ready for implementation

## Overview

The harness plugin system and the `5x skills` command both support installing
assets (skills, agent profiles) but provide no way to remove them. Users who
want to clean up installed files must manually locate and delete them — a
process that varies by harness and scope.

This change adds `uninstall` subcommands to both `5x harness` and `5x skills`,
and enhances `5x harness list` to show installed state, managed files, and
plugin source (bundled vs external) so users can inspect what is installed
before deciding to remove it.

## Goals

- Users can cleanly remove all 5x-managed harness and skill files with a single
  command.
- `5x harness list` provides enough information to understand what is installed,
  where, and whether the plugin is bundled or external.
- Uninstall only removes known 5x-managed files — never user-created content.
- The harness plugin contract gains the minimal surface needed to support
  uninstall and inspection without coupling the handler to plugin internals.

## Non-Goals

- Removing the `5x skills` command (kept as a harness-agnostic escape hatch).
- Adding interactive confirmation prompts before deletion.
- Tracking install state in a manifest or database — existence checks on known
  file paths are sufficient.
- Supporting external plugin discovery in `harness list` (only bundled plugins
  are enumerated for now; external plugins are detected if loaded by name).

## Design Decisions

**Only remove known files, not entire directories.** The `skills/` and `agents/`
directories may contain user-created files alongside 5x-managed ones. Uninstall
iterates over the known bundled file names (from `listSkillNames()` and
`describe().agentNames`) and removes only those. Empty parent directories are
cleaned up afterward on a best-effort basis (`rmdir` if empty, no-op otherwise).

**No `5x init` prerequisite for uninstall.** The install path requires project
initialization (`.5x/5x.db`) for project-scope harness installs. Uninstall
skips this check — removal should work even if the project state DB is missing
or has been removed.

**`HarnessPlugin` gains `locations`, `describe()`, and `uninstall()`.** Three
additions to the plugin contract:

- `locations` exposes the path resolver so the handler can check file existence
  for `list` and derive removal paths for `uninstall` without reaching into
  plugin internals. This is reusable across multiple commands.
- `describe()` returns the names of managed skills and agents. The handler
  combines this with `locations` to check file existence for `list` output.
- `uninstall()` performs the actual removal, mirroring the `install()` pattern.
  Plugins may need custom cleanup beyond simple file deletion (e.g., a
  third-party harness that registers config entries), so delegating to the
  plugin is more extensible than having the handler delete files directly.

**`--all` on harness uninstall is a flag, not a scope value.** This keeps it
distinct from the `--scope` semantics and avoids ambiguity with the positional
`name` argument. Exactly one of `--all` or `--scope` must be provided.

**`all` on skills uninstall IS a positional scope value.** Consistent with the
existing `user`/`project` positional on `skills install` — just adds a third
option. The skills command is simpler (no plugin dispatch, no agent files).

**Project root resolution falls back to cwd.** Both `harness list` and
`harness uninstall` resolve the project root via `resolveCheckoutRoot(cwd) ?? cwd`,
matching the install handler's existing fallback. This means project-scope
operations always have a root to work with — even outside a git repo, the
handler checks/removes files relative to cwd. This is important for uninstall:
users should be able to clean up project-scope files even if `.git` is absent.

**Bundled vs external detection requires factory-level source tracking.** The
current `loadHarnessPlugin()` returns a bare `HarnessPlugin` — the handler
cannot determine whether the plugin was loaded from an external package or the
bundled fallback, because an external package can override a bundled name (e.g.,
a user installs `@5x-ai/harness-opencode` which shadows the bundled opencode
plugin). Checking the plugin name against `listBundledHarnesses()` would
incorrectly label such overrides as "bundled".

To fix this, `loadHarnessPlugin()` gains a `LoadedHarnessPlugin` return type
that wraps the plugin with a `source: "bundled" | "external"` field. The factory
already knows which path succeeded (external import vs bundled fallback) so this
is a trivial addition. The handler uses `loaded.source` directly for display.

## Phase 1: Installer Uninstall Helpers

**Completion gate:** reusable uninstall functions exist in the installer module,
with unit tests covering removal, not-found reporting, empty directory cleanup,
and preservation of user-created files.

- [x] Add `UninstallSummary` type to `src/harnesses/installer.ts`:
      `{ removed: string[]; notFound: string[] }`.
- [x] Add `removeDirIfEmpty(dir)` helper — reads the directory; if it exists
      and is empty, removes it with `rmdirSync`. No-op if non-empty or missing.
- [x] Add `uninstallSkillFiles(skillsDir, skillNames)`:
      - For each name: remove `<skillsDir>/<name>/SKILL.md` if it exists, then
        `removeDirIfEmpty(<skillsDir>/<name>/)`.
      - After all skills: `removeDirIfEmpty(<skillsDir>/)`.
      - Returns `UninstallSummary` with entries formatted as `<name>/SKILL.md`.
- [x] Add `uninstallAgentFiles(agentsDir, agentNames)`:
      - For each name: remove `<agentsDir>/<name>.md` if it exists.
      - After all agents: `removeDirIfEmpty(<agentsDir>/)`.
      - Returns `UninstallSummary` with entries formatted as `<name>.md`.
- [x] Add unit tests in `test/unit/harnesses/installer.test.ts` (extend
      existing file):
      - `uninstallSkillFiles`: removes known files, reports not-found for
        missing skills, cleans empty subdirs, leaves user-created files and
        non-empty parent dirs intact.
      - `uninstallAgentFiles`: same pattern for flat agent files.
      - `removeDirIfEmpty`: removes empty dir, preserves non-empty dir,
        no-ops on missing dir.

## Phase 2: Plugin Contract Extensions

**Completion gate:** `HarnessPlugin` interface includes `locations`, `describe()`,
and `uninstall()`; the opencode plugin implements all three; existing install
behavior is unchanged.

- [x] Add imports and types to `src/harnesses/types.ts`:
      - Import `HarnessLocations` from `./locations.js`.
      - Import `UninstallSummary` from `./installer.js`.
      - Add `HarnessDescription` interface:
        ```ts
        interface HarnessDescription {
          skillNames: string[];
          agentNames: string[];
        }
        ```
      - Add `HarnessUninstallContext` interface:
        ```ts
        interface HarnessUninstallContext {
          scope: HarnessScope;
          projectRoot: string;
        }
        ```
      - Add `HarnessUninstallResult` interface:
        ```ts
        interface HarnessUninstallResult {
          skills: UninstallSummary;
          agents: UninstallSummary;
        }
        ```
- [x] Extend `HarnessPlugin` interface with three new members:
      - `locations: { resolve(scope: HarnessScope, projectRoot: string): HarnessLocations }`
      - `describe(): HarnessDescription`
      - `uninstall(ctx: HarnessUninstallContext): Promise<HarnessUninstallResult>`
- [x] Update `isValidPlugin()` duck-type check in `src/harnesses/factory.ts` to
      validate the new required members (`locations`, `describe`, `uninstall`).
- [x] Add `LoadedHarnessPlugin` type to `src/harnesses/factory.ts`:
      ```ts
      interface LoadedHarnessPlugin {
        plugin: HarnessPlugin;
        source: "bundled" | "external";
      }
      ```
      Update `loadHarnessPlugin()` to return `LoadedHarnessPlugin` instead of
      bare `HarnessPlugin`. Set `source: "external"` when the dynamic import
      succeeds, `source: "bundled"` when falling back to the bundled registry.
- [x] Update callers of `loadHarnessPlugin()` in `src/commands/harness.handler.ts`
      to destructure `{ plugin, source }` from the result. The `source` field
      is used by `harnessList()` (Phase 4) and ignored by `harnessInstall()` and
      `harnessUninstall()` (which only need the plugin).
- [x] Implement on `src/harnesses/opencode/plugin.ts`:
      - `locations`: expose `opencodeLocationResolver` directly.
      - `describe()`: return skill names from `listSkillNames()` (from
        `src/skills/loader.ts`) and agent names from `listAgentTemplates()` (from
        `./loader.ts`, extracting `.name` from each template).
      - `uninstall()`: resolve locations via `this.locations.resolve()`, get
        names from `this.describe()`, call `uninstallSkillFiles()` and
        `uninstallAgentFiles()` from the installer, return combined result.
- [x] Verify existing install tests still pass — no behavioral changes to
      `install()`.
- [x] Add unit tests in `test/unit/harnesses/opencode.test.ts` (extend existing):
      - `describe()` returns correct skill and agent name lists.
      - `uninstall()` removes installed files for both scopes, reports not-found
        for missing files, cleans empty directories.
- [x] Add unit tests in `test/unit/commands/harness.test.ts` (extend existing):
      - Verify `isValidPlugin()` rejects plugins missing `locations`, `describe`,
        or `uninstall`.
- [x] Add unit tests in `test/unit/harnesses/factory.test.ts` (new file) for
      `LoadedHarnessPlugin.source`:
      - Loading a bundled harness (e.g. "opencode") when no external package is
        installed returns `source: "bundled"`.
      - Loading a name that resolves via dynamic import returns
        `source: "external"`. Mock the dynamic import to simulate an external
        package that overrides a bundled name — verify the result is
        `source: "external"`, not `"bundled"`. This is the critical regression
        test for the P2 mislabeling bug.

## Phase 3: Harness Uninstall Command

**Completion gate:** `5x harness uninstall <name> --scope <scope>` and
`5x harness uninstall <name> --all` remove harness-managed files from the
specified scope(s) and print a summary.

- [x] Add `HarnessUninstallParams` interface to `src/commands/harness.handler.ts`:
      ```ts
      interface HarnessUninstallParams {
        name: string;
        scope?: string;
        all?: boolean;
        startDir?: string;
      }
      ```
- [x] Add `harnessUninstall()` handler. Structure the handler as two layers:
      a pure data-building function that returns a typed result, and a thin
      output layer that prints/envelopes. This enables unit tests to assert on
      the returned data without capturing console output.
      - **Data layer** (`harnessUninstallCore()` or inline in handler, returning
        a typed `HarnessUninstallOutput`):
        - Load plugin via `loadHarnessPlugin(name)`.
        - Validate: exactly one of `scope` or `all` must be set; error otherwise.
        - Validate `scope` against `plugin.supportedScopes` if provided.
        - Determine scopes to process: `all` → both supported scopes,
          otherwise `[scope]`.
        - Resolve project root: `resolveCheckoutRoot(cwd) ?? cwd`. This mirrors
          the install handler's fallback (`harness.handler.ts:56-57`) — if
          there's no git repo, use cwd (or `startDir`) as the project root.
          This ensures uninstall can find and remove project-scope files even
          when `.git` is absent (e.g., the repo was de-initialized or the
          command is run from a plain directory where files were installed).
        - No `5x init` prerequisite check.
        - For each scope: call `plugin.uninstall({ scope, projectRoot })`.
        - Return merged results as a typed object.
      - **Output layer**: print human-readable summary to stderr, output JSON
        success envelope to stdout via `outputSuccess()`.
      - Return type:
        ```ts
        interface HarnessUninstallOutput {
          harnessName: string;
          /** Only the scopes that were actually processed. */
          scopes: Partial<Record<HarnessScope, HarnessUninstallResult>>;
        }
        ```
        When `--scope project` is used, only `scopes.project` is present.
        When `--all`, both are present. Every requested scope always runs
        (project root falls back to cwd).
- [x] Add `printUninstallSummary()` helper (mirrors `printInstallSummary()`):
      reports removed and not-found files per category (skills, agents).
- [x] Register `uninstall` subcommand in `src/commands/harness.ts`:
      - Args: `name` (positional, required), `--scope` (string), `--all`
        (boolean, default false).
      - Handler calls `harnessUninstall()`.
- [x] Add unit tests in `test/unit/commands/harness.test.ts` (extend existing).
      Tests call the handler directly with `startDir` overrides and assert on
      return values / filesystem side effects:
      - Single scope uninstall (project, user).
      - `--all` processes both scopes.
      - Missing files reported gracefully (not-found, no error).
      - Validation: error when neither `--scope` nor `--all` provided.
      - Validation: error when both `--scope` and `--all` provided.
      - `--all` outside a git repo uses cwd as project root, removes files
        relative to cwd.
- [x] Add integration tests in `test/integration/commands/harness.test.ts`
      (extend existing):
      - Round-trip: install → verify files exist → uninstall → verify removed.
      - `--all` removes from both scopes.

## Phase 4: Enhanced Harness List

**Completion gate:** `5x harness list` shows each harness name, source
(bundled/external), per-scope installed state, and managed file paths. JSON
envelope contains structured equivalent.

- [x] Expand `harnessList()` in `src/commands/harness.handler.ts`. Structure as
      two layers (same pattern as uninstall):
      - **Data layer** — a pure function `buildHarnessListData()` that accepts
        `startDir` and returns a typed `HarnessListOutput`:
        ```ts
        interface HarnessListEntry {
          name: string;
          source: "bundled" | "external";
          description: string;
          /** Only scopes the plugin supports (from plugin.supportedScopes). */
          scopes: Partial<Record<HarnessScope, HarnessScopeStatus>>;
        }
        interface HarnessScopeStatus {
          installed: boolean;
          files: string[];
        }
        interface HarnessListOutput {
          harnesses: HarnessListEntry[];
        }
        ```
        - Accept optional `startDir` for testability.
        - Resolve project root: `resolveCheckoutRoot(cwd) ?? cwd`, same
          fallback as install and uninstall handlers. Project scope is always
          checkable — files are checked relative to the resolved root (git
          checkout root or cwd).
        - For each bundled harness name:
          - Load plugin via `loadHarnessPlugin()` which returns
            `{ plugin, source }`.
          - Call `plugin.describe()` to get managed file names.
          - Use `source` directly from `LoadedHarnessPlugin` ("bundled" or
            "external") — this correctly identifies external overrides of
            bundled names.
          - For each supported scope:
            - Resolve locations via `plugin.locations.resolve()`,
              check file existence for each managed skill and agent file.
            - Compute installed state: true if at least one managed file exists.
            - Collect list of existing file paths (relative to scope root).
        - Return the assembled `HarnessListOutput`.
      - **Output layer** — `harnessList()` calls `buildHarnessListData()`, then
        prints human-readable summary to stderr and calls `outputSuccess(data)`
        for the JSON envelope.
      - Unit tests assert on `buildHarnessListData()` return value directly;
        integration tests assert on the JSON envelope from stdout.
      - Human-readable output (TTY/`--pretty`):
        ```
          opencode (bundled)
            project: installed
              skills/5x-plan/SKILL.md
              skills/5x-plan-review/SKILL.md
              skills/5x-phase-execution/SKILL.md
              agents/5x-orchestrator.md
              agents/5x-reviewer.md
              agents/5x-plan-author.md
              agents/5x-code-author.md
            user: not installed
        ```
      - JSON envelope:
        ```json
        {
          "ok": true,
          "data": {
            "harnesses": [{
              "name": "opencode",
              "source": "bundled",
              "description": "Install 5x skills and native subagent profiles for OpenCode",
              "scopes": {
                "project": {
                  "installed": true,
                  "files": [
                    "skills/5x-plan/SKILL.md",
                    "skills/5x-plan-review/SKILL.md",
                    "skills/5x-phase-execution/SKILL.md",
                    "agents/5x-orchestrator.md",
                    "agents/5x-reviewer.md",
                    "agents/5x-plan-author.md",
                    "agents/5x-code-author.md"
                  ]
                },
                "user": {
                  "installed": false,
                  "files": []
                }
              }
            }]
          }
        }
        ```
      - Project root always resolves (`resolveCheckoutRoot(cwd) ?? cwd`), so
        project scope is always checkable. If no files are found, it reports
        `"installed": false` — the output does not need an "n/a" state.
- [x] Update the `harnessList()` signature and the `listCmd` in
      `src/commands/harness.ts` if `startDir` passthrough is needed for the
      citty adapter.
- [x] Add unit tests in `test/unit/commands/harness.test.ts` (extend existing).
      Tests call `buildHarnessListData()` directly and assert on the returned
      `HarnessListOutput` — no console output capture needed:
      - Lists bundled harness with correct source label.
      - Shows installed state when files exist on disk.
      - Shows not-installed state when files are absent.
      - Reports not-installed for project scope when `startDir` is a plain
        directory with no harness files (project root falls back to cwd).
      - File list matches expected managed files.
- [x] Add integration tests in `test/integration/commands/harness.test.ts`
      (extend existing):
      - `5x harness list` after install shows installed state with file list.
      - `5x harness list` after uninstall shows not-installed state.
      - JSON envelope structure matches expected schema.

## Phase 5: Skills Uninstall Command

**Completion gate:** `5x skills uninstall <all|user|project>` removes
5x-managed skill files from the specified scope(s) and prints a summary.

- [ ] Add `SkillsUninstallParams` interface to `src/commands/skills.handler.ts`:
      ```ts
      interface SkillsUninstallParams {
        scope: "all" | "user" | "project";
        installRoot?: string;
        /** Working directory override for project scope — defaults to resolve("."). */
        startDir?: string;
        /** Home directory override for user scope — defaults to homedir(). */
        homeDir?: string;
      }
      ```
      The `startDir` parameter follows the existing handler convention
      (`initScaffold`, `harnessInstall`, etc.) for testability. The `homeDir`
      parameter is needed because user-scope resolution depends on `homedir()`,
      which cannot be overridden via `startDir` alone. Unit tests pass explicit
      temp directories for both; the citty adapter passes neither (defaults apply).
- [ ] Add `skillsUninstall()` handler:
      - Resolve `installRoot` (default `.agents`, same as `skillsInstall`).
      - Validate scope: must be `"all"`, `"user"`, or `"project"`.
      - Determine scopes to process: `"all"` → `["user", "project"]`,
        otherwise single scope.
      - For each scope:
        - Resolve base dir: `params.homeDir ?? homedir()` for user,
          `resolveProjectRoot(params.startDir)` for project (following the
          `startDir` convention from `harnessInstall`).
        - Build `skillsDir = join(baseDir, installRoot, "skills")`.
        - Get skill names from `listSkillNames()`.
        - For each skill name: remove `<skillsDir>/<name>/SKILL.md` if exists,
          then `rmdir <skillsDir>/<name>/` if empty.
        - After all skills: `rmdir <skillsDir>/` if empty.
        - Track removed and not-found per skill.
      - Report removed/not-found to stderr (mirrors install output style).
      - Output JSON success envelope with per-scope results.
- [ ] Reuse `removeDirIfEmpty()` from `src/harnesses/installer.ts` (or extract
      to a shared utility if importing from `harnesses/` feels like a layering
      violation — use judgment based on the final module structure).
- [ ] Register `uninstall` subcommand in `src/commands/skills.ts`:
      - Args: `scope` (positional, required), `--install-root` (string).
      - Handler calls `skillsUninstall()`.
- [ ] Add unit tests in `test/unit/commands/skills-uninstall.test.ts` (new file).
      All tests use `startDir` and `homeDir` overrides pointing to temp
      directories — no process-wide env mutation or real home directory writes:
      - Uninstall user scope: removes skill files from `<homeDir>/<root>/skills/`.
      - Uninstall project scope: removes skill files from `<startDir>/<root>/skills/`.
      - Uninstall all: removes from both scopes.
      - `--install-root` override targets correct directory.
      - Empty directory cleanup after removal.
      - Not-found reporting when skills were never installed.
      - User-created files in `skills/` directory are preserved.
- [ ] Add integration tests in `test/integration/commands/skills-install.test.ts`
      (extend existing):
      - Round-trip: install → verify files → uninstall → verify removed.
      - `uninstall all` removes from both user and project scope.
      - JSON envelope structure.

## Files Touched

| File | Change |
|------|--------|
| `src/harnesses/types.ts` | Add `HarnessDescription`, `HarnessUninstallContext`, `HarnessUninstallResult`; extend `HarnessPlugin` with `locations`, `describe()`, `uninstall()` |
| `src/harnesses/installer.ts` | Add `UninstallSummary`, `removeDirIfEmpty()`, `uninstallSkillFiles()`, `uninstallAgentFiles()` |
| `src/harnesses/factory.ts` | Update `isValidPlugin()` duck-type check for new plugin members; add `LoadedHarnessPlugin` return type to `loadHarnessPlugin()` |
| `src/harnesses/opencode/plugin.ts` | Implement `locations`, `describe()`, `uninstall()` |
| `src/commands/harness.ts` | Register `uninstall` subcommand |
| `src/commands/harness.handler.ts` | Add `harnessUninstall()` handler; expand `harnessList()` with installed state and file listing |
| `src/commands/skills.ts` | Register `uninstall` subcommand |
| `src/commands/skills.handler.ts` | Add `skillsUninstall()` handler |
| `test/unit/harnesses/factory.test.ts` | New: `LoadedHarnessPlugin.source` tests (bundled vs external) |
| `test/unit/harnesses/installer.test.ts` | Uninstall helper tests |
| `test/unit/harnesses/opencode.test.ts` | Plugin `describe()` and `uninstall()` tests |
| `test/unit/commands/harness.test.ts` | Handler uninstall + enhanced list tests |
| `test/unit/commands/skills-uninstall.test.ts` | New: skills uninstall handler tests |
| `test/integration/commands/harness.test.ts` | Uninstall round-trip + list state tests |
| `test/integration/commands/skills-install.test.ts` | Uninstall round-trip tests |

## Risks

- Extending `HarnessPlugin` with three new required members is a breaking change
  for any third-party plugins. Mitigation: there are no known third-party plugins
  yet, and the plugin contract has not been published as a stable API. The
  duck-type validator in `factory.ts` will produce a clear error message listing
  the missing members if an incomplete plugin is loaded. If third-party plugins
  appear before this lands, consider making the new members optional on the
  interface and having the handler fall back to degraded behavior (e.g., `list`
  shows "unknown" for file state, `uninstall` errors with "not supported by
  this plugin"). For now, required members are the simpler path.
- `removeDirIfEmpty` has a TOCTOU race (check-then-remove). Acceptable for CLI
  tooling — not a concurrent server. Use try/catch on `rmdirSync` to handle
  the edge case where the directory becomes non-empty between check and remove.
- Skills uninstall imports `removeDirIfEmpty` from the harnesses module, which
  creates a cross-layer dependency. If this feels wrong at implementation time,
  extract to a shared `src/fs-utils.ts` or similar.

## Acceptance Criteria

- `5x harness uninstall opencode --scope project` removes all 5x-managed skill
  and agent files from `.opencode/` and cleans up empty directories.
- `5x harness uninstall opencode --all` removes from both project and user scope,
  skipping gracefully if either scope has no installed files.
- `5x harness list` shows installed/not-installed state per scope with file
  listing, and labels each harness as bundled or external.
- `5x harness list` checks project scope relative to cwd even outside a git
  repository (falls back to cwd as project root).
- `5x skills uninstall project` removes all 5x-managed skill files from
  `.agents/skills/` (or the `--install-root` override).
- `5x skills uninstall all` removes from both user and project scope.
- User-created files in the same directories are never removed.
- All existing install tests continue to pass.

## Revision History

### v1.4 — March 13, 2026

Addresses re-review feedback on v1.3:

- **P1:** Changed `HarnessUninstallOutput.scopes` from
  `Record<HarnessScope, ...>` to `Partial<Record<HarnessScope, ...>>` so only
  the actually-processed scopes are present. Single-scope uninstall produces one
  entry; `--all` produces both.
- **P2:** Changed `HarnessListEntry.scopes` to `Partial<Record<...>>` so only
  scopes from `plugin.supportedScopes` are populated. Single-scope plugins
  produce one entry without needing placeholder data.

### v1.3 — March 13, 2026

Addresses re-review feedback on v1.2:

- **P1:** Removed stale `null` semantics from `HarnessUninstallOutput.scopes`
  type — every requested scope now always runs (project root falls back to cwd).
  Updated Phase 3 test description: `--all` outside a git repo uses cwd as
  project root instead of skipping.
- **P2:** Removed residual "n/a" / `null` language from Phase 4 list data layer.
  Project scope is always checkable relative to the resolved root. Cleaned up
  contradictory text that referenced a reserved `null` trigger that was never
  defined.

### v1.2 — March 13, 2026

Addresses re-review feedback on v1.1:

- **P1:** Fixed project-scope uninstall and list to use `resolveCheckoutRoot(cwd)
  ?? cwd` fallback (matching install handler behavior) instead of skipping when
  outside a git repo. Users can now clean up project-scope files even when `.git`
  is absent. Removed the "n/a" state from `harness list` — project scope is
  always checkable relative to cwd.
- **P2:** Added explicit unit tests for the external-override case in
  `LoadedHarnessPlugin.source`. New `test/unit/harnesses/factory.test.ts` file
  mocks dynamic import to verify an external package that overrides a bundled
  name is correctly labeled `source: "external"`.

### v1.1 — March 13, 2026

Addresses review feedback:

- **P1:** Added `startDir` and `homeDir` parameters to `SkillsUninstallParams`
  for testability. Follows the existing handler convention (`initScaffold`,
  `harnessInstall`). Unit tests pass explicit temp directories for both scopes
  instead of relying on process-wide env mutation or the real home directory.
- **P2:** Fixed bundled/external detection for `harness list`. Added
  `LoadedHarnessPlugin` wrapper type to `factory.ts` with a `source` field set
  by `loadHarnessPlugin()` based on which resolution path succeeded. The handler
  uses `loaded.source` directly instead of checking names against
  `listBundledHarnesses()`, which would misidentify external overrides of
  bundled names.
- **P3:** Restructured `harnessList()` and `harnessUninstall()` as two-layer
  handlers: a pure data-building function (`buildHarnessListData()`,
  `HarnessUninstallOutput`) that returns typed results, and a thin output layer
  for printing and JSON envelope wrapping. Unit tests assert on the data layer
  return value directly — no console output capture needed.
- **P4:** Expanded the breaking `HarnessPlugin` change risk with a concrete
  fallback strategy: if third-party plugins appear before landing, make the new
  members optional with degraded behavior. For now, required is simpler.

### v1.0 — March 13, 2026

- Initial draft.
