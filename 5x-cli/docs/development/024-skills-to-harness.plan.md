# Move Skills from Core to Harness Modules

**Version:** 1.0
**Created:** March 18, 2026
**Status:** Draft

## Overview

Skills are currently bundled in `src/skills/` as a core 5x-cli concern,
but they encode harness-specific delegation patterns (OpenCode agent paths,
`.opencode/agents/` detection order). This creates a false abstraction —
skills claim to be harness-agnostic but aren't. Moving skills to harness
modules aligns ownership with reality: the harness that installs agents
should also own the skills that reference them.

## Design Decisions

**Skills are a harness concern, not a core concern.** The 5x-cli core owns
the protocol (templates, run tracking, quality gates, `protocol
validate/emit`). Skills are agent instructions that reference
harness-specific delegation patterns — they belong with the harness that
installs agents.

**The `5x skills` command is removed entirely.** `5x harness install
opencode` already installs skills alongside agents. The standalone
`5x skills install` was redundant for OpenCode users and misleading for
future harness users.

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

- [ ] **1a.** Move skill files from `src/skills/` to
  `src/harnesses/opencode/skills/`:
  - `src/skills/5x/SKILL.md` → `src/harnesses/opencode/skills/5x/SKILL.md`
  - `src/skills/5x-plan/SKILL.md` →
    `src/harnesses/opencode/skills/5x-plan/SKILL.md`
  - `src/skills/5x-plan-review/SKILL.md` →
    `src/harnesses/opencode/skills/5x-plan-review/SKILL.md`
  - `src/skills/5x-phase-execution/SKILL.md` →
    `src/harnesses/opencode/skills/5x-phase-execution/SKILL.md`

- [ ] **1b.** Create `src/harnesses/opencode/skills/loader.ts` — a skill
  loader local to the OpenCode harness. Import all 4 SKILL.md files via
  `with { type: "text" }`. Move `parseSkillFrontmatter()` from
  `src/skills/loader.ts` to this file. Export `listSkills()` returning
  `SkillMetadata[]` and `listSkillNames()` returning `string[]`.

- [ ] **1c.** Update `src/harnesses/opencode/plugin.ts`:
  - Import `listSkillNames` and `listSkills` from the local
    `./skills/loader.js` instead of `../../skills/loader.js`
  - Change `install()` to call its own `listSkills()` instead of using
    `ctx.skills`
  - Update `describe()` to use the local `listSkillNames()`

- [ ] **1d.** Move `SkillMetadata` interface to `src/harnesses/installer.ts`.
  The interface is `{ name: string; description: string; content: string }`.
  Update the `installSkillFiles()` parameter type to reference it (currently
  uses `Array<{ name: string; content: string }>` — add `description` or
  keep the structural type and export `SkillMetadata` separately for plugin
  authors).

- [ ] **1e.** Remove `skills` from `HarnessInstallContext` in
  `src/harnesses/types.ts`. Remove the `import type { SkillMetadata }` from
  `../skills/loader.js`. If `HarnessInstallResult.skills` still references
  `InstallSummary`, that stays (it's from `installer.ts`, not the skill
  loader).

- [ ] **1f.** Update `src/commands/harness.handler.ts`: remove
  `import { listSkills }` from `../skills/loader.js` and the
  `const skills = listSkills()` call. Remove `skills` from the context
  passed to `plugin.install()`.

## Phase 2: Remove skills infrastructure from core

**Completion gate:** `src/skills/` directory is deleted. `5x skills` command
no longer exists. `bin.ts` has no reference to skills. All tests pass.

- [ ] **2a.** Delete `src/skills/loader.ts` and the entire `src/skills/`
  directory (the `.md` files were moved in Phase 1).

- [ ] **2b.** Remove the `5x skills` command:
  - Delete `src/commands/skills.ts` (command registration)
  - Delete `src/commands/skills.handler.ts` (handler)
  - Remove `import { registerSkills }` and `registerSkills(program)` from
    `src/bin.ts`

- [ ] **2c.** Check `src/index.ts` for any skills-related exports and
  remove them (currently none expected, but verify).

## Phase 3: Update tests

**Completion gate:** All skills tests are removed or moved to harness test
directories. All remaining tests pass.

- [ ] **3a.** Move skill content tests from
  `test/unit/skills/skill-content.test.ts` to
  `test/unit/harnesses/opencode-skills.test.ts` (or similar). Update
  imports to use the OpenCode-local skill loader at
  `src/harnesses/opencode/skills/loader.ts`. Keep all content assertions
  (frontmatter parsing, section presence, gotchas, agent names,
  `5x config show` references, delegation patterns, etc.).

- [ ] **3b.** Move skill loader tests from
  `test/unit/commands/init-skills.test.ts` to the same harness test file
  (or a separate `opencode-skill-loader.test.ts`). Tests for
  `listSkillNames()`, `listSkills()`, `parseSkillFrontmatter()` move with
  the loader. Update imports.

- [ ] **3c.** Delete `test/integration/commands/skills-install.test.ts` —
  the `5x skills install` command no longer exists. Skill installation
  coverage is provided by the existing harness install tests in
  `test/integration/commands/harness.test.ts` and
  `test/unit/harnesses/installer.test.ts`.

- [ ] **3d.** Delete `test/unit/commands/skills-uninstall.test.ts` — same
  reason. Harness uninstall is covered by existing harness tests.

- [ ] **3e.** Update harness tests in `test/unit/commands/harness.test.ts`
  and `test/unit/harnesses/opencode.test.ts` to reflect the new plugin
  contract (no `skills` in install context, plugin owns skills directly).
  Update any assertions that reference `listSkills()` from the old loader
  path.

- [ ] **3f.** Run `bun test` and fix any remaining import or assertion
  failures.

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
| `src/harnesses/installer.ts` | Add `SkillMetadata` interface |
| `src/harnesses/types.ts` | Remove `skills` from `HarnessInstallContext` |
| `src/commands/harness.handler.ts` | Remove `listSkills()` call, drop `skills` from context |
| `src/commands/skills.ts` | **Deleted** |
| `src/commands/skills.handler.ts` | **Deleted** |
| `src/bin.ts` | Remove `registerSkills` |
| `test/unit/skills/skill-content.test.ts` | **Deleted** — moved to harness tests |
| `test/unit/commands/init-skills.test.ts` | **Deleted** — moved to harness tests |
| `test/unit/harnesses/opencode-skills.test.ts` | **New** — merged skill content + loader tests |
| `test/integration/commands/skills-install.test.ts` | **Deleted** |
| `test/unit/commands/skills-uninstall.test.ts` | **Deleted** |
| `test/unit/commands/harness.test.ts` | Update for new plugin contract |
| `test/unit/harnesses/opencode.test.ts` | Update for local skill loader |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `opencode-skills.test.ts` | Skill content, frontmatter, sections, loader functions |
| Unit | `harness.test.ts` | Plugin contract without `skills` in context |
| Unit | `opencode.test.ts` | OpenCode plugin uses local skill loader |
| Unit | `installer.test.ts` | Generic skill/agent install helpers (unchanged) |
| Integration | `harness.test.ts` | `5x harness install opencode` installs skills + agents |
| Regression | Full suite | No `5x skills` references remain, no broken imports |

## Estimated Scope

| Phase | Size | Notes |
|-------|------|-------|
| Phase 1 | Medium | File moves + new loader + plugin/handler/types updates |
| Phase 2 | Small | Deletions only |
| Phase 3 | Medium | Test moves + harness test updates |

## Not In Scope

- Generic harness with basic workflow skills (future, when a second harness
  needs it)
- External harness plugin contract changes beyond removing `skills` from
  context (no external plugins exist yet)
- Changes to templates, protocol, or run tracking
- Skill content changes (the `.md` files move as-is)
