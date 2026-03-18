# Move Skills from Core to Harness Modules

**Version:** 1.1
**Created:** March 18, 2026
**Status:** Draft

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-18 | Initial draft |
| 1.1 | 2026-03-18 | Address review feedback: add Migration section (R1/P0), add missing file references for integration test, init handler, README, and harness docs (R2/P1), name surviving regression coverage explicitly |

## Overview

Skills are currently bundled in `src/skills/` as a core 5x-cli concern,
but they encode harness-specific delegation patterns (OpenCode agent paths,
`.opencode/agents/` detection order). This creates a false abstraction —
skills claim to be harness-agnostic but aren't. Moving skills to harness
modules aligns ownership with reality: the harness that installs agents
should also own the skills that reference them.

## Migration

The `5x skills` command is intentionally removed. This section documents
the migration path for existing users.

**`5x skills install` → `5x harness install opencode`.** The standalone
`5x skills install` command is replaced by `5x harness install opencode`,
which already installs skills alongside native subagent profiles. Users
should run `5x harness install opencode --scope project` (or `--scope
user`) instead.

**Existing installations are unaffected.** Users who have previously run
`5x skills install` don't need to do anything — their installed skill
files remain on disk at their current locations (`.agents/skills/`,
`.opencode/skills/`, etc.). The installed files are standalone markdown;
they don't depend on the CLI's internal skill loader.

**Future skill updates come via the harness.** To get updated skill
content after upgrading 5x-cli, run `5x harness install opencode --force`.
This overwrites previously installed skills with the latest bundled
versions.

**Clear error on old command.** After removal, invoking `5x skills` will
produce an error message explaining that the command has been removed and
suggesting `5x harness install` as the replacement. This is handled by
the CLI's default "unknown command" behavior — no special stub is needed
since citty already reports unknown subcommands. The `5x init` post-init
guidance is updated to reference the new command (see Phase 2).

## Design Decisions

**Skills are a harness concern, not a core concern.** The 5x-cli core owns
the protocol (templates, run tracking, quality gates, `protocol
validate/emit`). Skills are agent instructions that reference
harness-specific delegation patterns — they belong with the harness that
installs agents.

**The `5x skills` command is removed entirely.** `5x harness install
opencode` already installs skills alongside agents. The standalone
`5x skills install` was redundant for OpenCode users and misleading for
future harness users. See the Migration section above for the transition
path.

**The OpenCode harness owns its skill content directly.** Skill `.md` files
move from `src/skills/` to `src/harnesses/opencode/skills/`. The plugin
imports them via Bun's text loader (same pattern as agent templates). No
more shared `listSkills()` indirection.

**`HarnessInstallContext.skills` is removed from the plugin contract.** The
handler no longer gathers skills — each plugin manages its own content. This
is a breaking change for any external harness plugins that rely on receiving
skills from the handler, but no external harness plugins exist yet.

**`SkillMetadata` moves to `installer.ts`.** The `installSkillFiles()` and
`uninstallSkillFiles()` helpers remain as generic utilities any harness can
use. The `SkillMetadata` interface (name, description, content) moves to
`installer.ts` since that's where it's consumed. Note: `installSkillFiles`
already uses `Array<{ name: string; content: string }>` inline — the named
type is for ergonomics, not a new contract.

**`parseSkillFrontmatter()` moves with the loader.** The frontmatter parser
is used by the skill loader to extract `name` and `description` from
SKILL.md files. It moves to the OpenCode harness's local skill loader.

## Phase 1: Move skill content to OpenCode harness

**Completion gate:** Skill `.md` files live under
`src/harnesses/opencode/skills/`, the OpenCode plugin imports them directly,
`5x harness install opencode` still works correctly. All tests pass.

- [x] **1a.** Move skill files from `src/skills/` to
  `src/harnesses/opencode/skills/`:
  - `src/skills/5x/SKILL.md` → `src/harnesses/opencode/skills/5x/SKILL.md`
  - `src/skills/5x-plan/SKILL.md` →
    `src/harnesses/opencode/skills/5x-plan/SKILL.md`
  - `src/skills/5x-plan-review/SKILL.md` →
    `src/harnesses/opencode/skills/5x-plan-review/SKILL.md`
  - `src/skills/5x-phase-execution/SKILL.md` →
    `src/harnesses/opencode/skills/5x-phase-execution/SKILL.md`

- [x] **1b.** Create `src/harnesses/opencode/skills/loader.ts` — a skill
  loader local to the OpenCode harness. Import all 4 SKILL.md files via
  `with { type: "text" }`. Move `parseSkillFrontmatter()` from
  `src/skills/loader.ts` to this file. Export `listSkills()` returning
  `SkillMetadata[]` and `listSkillNames()` returning `string[]`.

- [x] **1c.** Update `src/harnesses/opencode/plugin.ts`:
  - Import `listSkillNames` and `listSkills` from the local
    `./skills/loader.js` instead of `../../skills/loader.js`
  - Change `install()` to call its own `listSkills()` instead of using
    `ctx.skills`
  - Update `describe()` to use the local `listSkillNames()`

- [x] **1d.** Move `SkillMetadata` interface to `src/harnesses/installer.ts`.
  The interface is `{ name: string; description: string; content: string }`.
  Update the `installSkillFiles()` parameter type to reference it (currently
  uses `Array<{ name: string; content: string }>` — add `description` or
  keep the structural type and export `SkillMetadata` separately for plugin
  authors).

- [x] **1e.** Remove `skills` from `HarnessInstallContext` in
  `src/harnesses/types.ts`. Remove the `import type { SkillMetadata }` from
  `../skills/loader.js`. If `HarnessInstallResult.skills` still references
  `InstallSummary`, that stays (it's from `installer.ts`, not the skill
  loader).

- [x] **1f.** Update `src/commands/harness.handler.ts`: remove
  `import { listSkills }` from `../skills/loader.js` and the
  `const skills = listSkills()` call. Remove `skills` from the context
  passed to `plugin.install()`.

## Phase 2: Remove skills infrastructure from core

**Completion gate:** `src/skills/` directory is deleted. `5x skills` command
no longer exists. `bin.ts` has no reference to skills. Init guidance
references the new command. All tests pass.

- [x] **2a.** Delete `src/skills/loader.ts` and the entire `src/skills/`
  directory (the `.md` files were moved in Phase 1).

- [x] **2b.** Remove the `5x skills` command:
  - Delete `src/commands/skills.ts` (command registration)
  - Delete `src/commands/skills.handler.ts` (handler)
  - Remove `import { registerSkills }` and `registerSkills(program)` from
    `src/bin.ts`

- [x] **2c.** Check `src/index.ts` for any skills-related exports and
  remove them (currently none expected, but verify).

- [x] **2d.** Update `src/commands/init.handler.ts` post-init guidance:
  replace the line `Run '5x skills install project' to install skills for
  agent clients` with guidance to use `5x harness install opencode --scope
  project` instead. The existing harness install line on the next line can
  remain or be consolidated.

- [x] **2e.** Update `README.md`:
  - **Lines 121–128** (Quick Start step 3): Replace the `5x skills install`
    examples with `5x harness install opencode --scope project`. Remove the
    `--install-root .opencode` / `--install-root .claude` variants.
  - **Lines 217–264** (Skills section): Rewrite the "Installing Skills"
    subsection to point to `5x harness install opencode` only. Remove the
    "For other harnesses (generic agentskills.io layout)" block with
    `5x skills install` examples. Keep the skills overview table and
    customization guidance. Update the "Customizing" subsection to reference
    `5x harness install opencode --force` instead of `5x skills install`.
  - **Line 390** (Setup command reference): Remove the
    `5x skills install <project|user> [--install-root <dir>] [--force]`
    line from the command reference table.

- [x] **2f.** Update `src/harnesses/README.md`:
  - **Lines 39–52** (Plugin Contract): Remove `skills: SkillMetadata[]`
    from the `HarnessInstallContext` code example. This reflects the
    contract change in Phase 1e.
  - **Lines 145–147** (Command Interface): Remove or update step 5
    ("Gathers bundled skills") from the install orchestration description.

- [x] **2g.** Update `src/harnesses/opencode/README.md`:
  - **Lines 25–29** (How It Works): Update the `install()` method
    description to say the plugin loads its own skills via the local
    loader instead of "installs bundled 5x skills using the shared
    `installSkillFiles()` helper" (it still uses `installSkillFiles()`
    but it no longer receives skills from the handler context).
  - **Lines 89–93** (Extension Points): Update the `plugin.ts` extension
    point description — change "Change which skills are installed" to
    reflect that skills are loaded from the local `skills/loader.ts`, not
    received from the handler.

## Phase 3: Update tests

**Completion gate:** All skills tests are removed or moved to harness test
directories. No active runtime, test, or user-facing references to
`src/skills/loader.js` or `5x skills` remain (archived docs like
changelogs are excluded from this check). All remaining tests pass.

- [x] **3a.** Move skill content tests from
  `test/unit/skills/skill-content.test.ts` to
  `test/unit/harnesses/opencode-skills.test.ts` (or similar). Update
  imports to use the OpenCode-local skill loader at
  `src/harnesses/opencode/skills/loader.ts`. Keep all content assertions
  (frontmatter parsing, section presence, gotchas, agent names,
  `5x config show` references, delegation patterns, etc.).

- [x] **3b.** Move skill loader tests from
  `test/unit/commands/init-skills.test.ts` to the same harness test file
  (or a separate `opencode-skill-loader.test.ts`). Tests for
  `listSkillNames()`, `listSkills()`, `parseSkillFrontmatter()` move with
  the loader. Update imports.

- [x] **3c.** Delete `test/integration/commands/skills-install.test.ts` —
  the `5x skills install` command no longer exists. Skill installation
  coverage is provided by the existing harness install tests in
  `test/integration/commands/harness.test.ts` and
  `test/unit/harnesses/installer.test.ts`.

- [x] **3d.** Delete `test/unit/commands/skills-uninstall.test.ts` — same
  reason. Harness uninstall is covered by existing harness tests.

- [x] **3e.** Update harness tests in `test/unit/commands/harness.test.ts`
  and `test/unit/harnesses/opencode.test.ts` to reflect the new plugin
  contract (no `skills` in install context, plugin owns skills directly).
  Update any assertions that reference `listSkills()` from the old loader
  path.

- [x] **3f.** Update `test/integration/commands/harness.test.ts`:
  - Change `import { listSkillNames } from "../../../src/skills/loader.js"`
    to import from `../../../src/harnesses/opencode/skills/loader.js`
    instead. This import is used in 3 test assertions (lines 250, 540,
    654) that verify installed skill filenames match the bundled skill list.

- [x] **3g.** Run `bun test` and fix any remaining import or assertion
  failures.

### Surviving Regression Coverage

After the refactor, the following test assertions must still pass to confirm
skill installation works end-to-end through the harness:

| Test file | Assertion scope |
|-----------|----------------|
| `test/integration/commands/harness.test.ts` | `5x harness install opencode` writes skill files to correct paths for project and user scopes; skill names match `listSkillNames()` |
| `test/unit/harnesses/installer.test.ts` | `installSkillFiles()` creates/overwrites/skips correctly; `uninstallSkillFiles()` removes installed skills |
| `test/unit/harnesses/opencode.test.ts` | OpenCode plugin `install()` returns correct skill install summaries; `describe()` lists skill names |
| `test/unit/harnesses/opencode-skills.test.ts` (new) | Skill content frontmatter, section structure, loader functions (`listSkills`, `listSkillNames`, `parseSkillFrontmatter`) |

## Files Touched

| File | Change |
|------|--------|
| `src/skills/` (entire dir) | **Deleted** — content moved to harness |
| `src/harnesses/opencode/skills/5x/SKILL.md` | **Moved** from `src/skills/5x/` |
| `src/harnesses/opencode/skills/5x-plan/SKILL.md` | **Moved** from `src/skills/5x-plan/` |
| `src/harnesses/opencode/skills/5x-plan-review/SKILL.md` | **Moved** from `src/skills/5x-plan-review/` |
| `src/harnesses/opencode/skills/5x-phase-execution/SKILL.md` | **Moved** from `src/skills/5x-phase-execution/` |
| `src/harnesses/opencode/skills/loader.ts` | **New** — local skill loader + `parseSkillFrontmatter()` |
| `src/harnesses/opencode/plugin.ts` | Use local skill loader, drop `ctx.skills` |
| `src/harnesses/opencode/README.md` | Update install flow and extension point descriptions |
| `src/harnesses/installer.ts` | Add `SkillMetadata` interface |
| `src/harnesses/types.ts` | Remove `skills` from `HarnessInstallContext` |
| `src/harnesses/README.md` | Remove `skills` from contract example, update orchestration steps |
| `src/commands/harness.handler.ts` | Remove `listSkills()` call, drop `skills` from context |
| `src/commands/init.handler.ts` | Update post-init guidance to reference `5x harness install` |
| `src/commands/skills.ts` | **Deleted** |
| `src/commands/skills.handler.ts` | **Deleted** |
| `src/bin.ts` | Remove `registerSkills` |
| `README.md` | Replace `5x skills` references with `5x harness install opencode` |
| `test/unit/skills/skill-content.test.ts` | **Deleted** — moved to harness tests |
| `test/unit/commands/init-skills.test.ts` | **Deleted** — moved to harness tests |
| `test/unit/harnesses/opencode-skills.test.ts` | **New** — merged skill content + loader tests |
| `test/integration/commands/skills-install.test.ts` | **Deleted** |
| `test/unit/commands/skills-uninstall.test.ts` | **Deleted** |
| `test/integration/commands/harness.test.ts` | Update `listSkillNames` import to new loader path |
| `test/unit/commands/harness.test.ts` | Update for new plugin contract |
| `test/unit/harnesses/opencode.test.ts` | Update for local skill loader |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `opencode-skills.test.ts` | Skill content, frontmatter, sections, loader functions |
| Unit | `harness.test.ts` | Plugin contract without `skills` in context |
| Unit | `opencode.test.ts` | OpenCode plugin uses local skill loader |
| Unit | `installer.test.ts` | Generic skill/agent install helpers (unchanged) |
| Integration | `harness.test.ts` | `5x harness install opencode` installs skills + agents; skill file list matches `listSkillNames()` |
| Regression | Full suite | No active runtime/test/user-facing `5x skills` or `src/skills/loader` references remain (archived changelogs excluded) |

## Estimated Scope

| Phase | Size | Notes |
|-------|------|-------|
| Phase 1 | Medium | File moves + new loader + plugin/handler/types updates |
| Phase 2 | Medium | Deletions + init handler + README + harness doc updates |
| Phase 3 | Medium | Test moves + harness test updates + integration test import fix |

## Not In Scope

- Generic harness with basic workflow skills (future, when a second harness
  needs it)
- External harness plugin contract changes beyond removing `skills` from
  context (no external plugins exist yet)
- Changes to templates, protocol, or run tracking
- Skill content changes (the `.md` files move as-is)
