# Skill Improvements: Config Command, Shared Foundation, Gotchas, Trigger Descriptions

**Version:** 1.2
**Created:** March 18, 2026
**Status:** Draft

## Overview

Applying lessons from Anthropic's "How We Use Skills" article (Thariq, March 2026)
to improve the 5x bundled agent skills. Four problems to address:

1. **Hardcoded iteration limits diverge from config.** The skills hardcode
   `maxQualityRetries = 2` and `maxReviewIterations = 3` in `5x-phase-execution`,
   but the config defaults are `3` and `5` respectively. If a user customizes
   `5x.toml`, the skill prose becomes incorrect. There is no CLI command for
   the orchestrator to read resolved config values at runtime.

2. **Cross-cutting content duplicated across 3 skills.** Human interaction
   note (~16 lines), delegation patterns (~12 lines), fallback documentation
   (~4 lines), and timeout layers (~18 lines) are near-identical across
   `5x-plan`, `5x-plan-review`, and `5x-phase-execution`. Updates require
   editing all three files, and they have already drifted (e.g., `5x-phase-execution`
   has a duplicated "Native agent detection order" block).

3. **No gotchas sections.** The highest-signal content for agent skills is a
   short list of common failure points. Our skills bury this information in
   verbose Recovery sections. Front-loading gotchas improves first-pass
   reliability.

4. **Description fields lack trigger words.** The description field is what the
   model scans to decide whether to load a skill. Current descriptions are
   summaries, not trigger-optimized. They also don't instruct the agent to
   co-load the shared foundation skill.

## Design Decisions

**`5x config show` outputs the full resolved config using layered resolution.**
A single command that dumps the merged, resolved config as a JSON envelope. The
orchestrator runs it once at init and reads values like `maxReviewIterations`
and `maxQualityRetries` from the output. This is simpler than per-key lookup
(`5x config get <key>`) and consistent with the existing `outputSuccess`
envelope pattern. Sensitive values (db path, absolute filesystem paths) are
included — this is a local development tool, not a public API.

The handler uses `resolveLayeredConfig(projectRoot, contextDir)` — the same
function used by `template.handler.ts`, `run-v1.handler.ts`, `context.ts`, and
`invoke.handler.ts` — so it resolves nearest-config overrides in sub-project /
monorepo layouts. An optional `--context <dir>` CLI flag (defaults to
`process.cwd()`) lets the caller specify which directory's config context to
resolve. This ensures the command reports the same values the workflow would
see when running in that directory.

**Shared `5x` foundational skill over inline duplication.** A new `5x` skill
contains all cross-cutting orchestration knowledge. Process skills reference it
via a prerequisite line: "Load the `5x` skill for delegation patterns,
interaction model, and timeout handling." The agent loads both skills via
two `mcp_skill` calls (or equivalent). This relies on reliable co-loading — if
it proves fragile, the content can be inlined back (the fallback is the current
state, not a regression).

**Gotchas seeded from Recovery, refined over time.** Initial gotchas are
extracted from existing Recovery sections and hardcoded-value bugs. The article
recommends evolving gotchas as new failure modes are discovered — the initial
set is a starting point, not exhaustive.

**Skills reference config values by name, not by number.** Instead of
"Maximum 5 review cycles", skills say "Read `maxReviewIterations` from
`5x config show`." This ensures the skill never disagrees with the config.

## Phase 1: Add `5x config show` command

**Completion gate:** `5x config show` outputs the resolved config as a JSON
envelope, tests pass.

- [ ] **1a.** Create `src/commands/config.handler.ts` with a `configShow` handler
  that loads the resolved config via `resolveLayeredConfig(controlPlaneRoot,
  contextDir)` and outputs it via `outputSuccess()`. The control plane root is
  resolved via `resolveControlPlaneRoot(startDir)` — the same pattern used by
  `template.handler.ts`, `invoke.handler.ts`, `quality-v1.handler.ts`, etc. —
  so that root-anchored values like `db.path` match runtime behavior in linked
  worktrees. The first argument to `resolveLayeredConfig` must be
  `controlPlane.controlPlaneRoot`, not `resolveProjectRoot()` or `cwd`. The
  handler accepts optional `startDir` and `contextDir` parameters for
  testability (same convention as `initScaffold`, `planPhases`, etc.).
  `contextDir` defaults to `process.cwd()`. Include a text formatter that
  renders key config values in human-readable format (similar to
  `plan-v1.handler.ts:formatPhasesText`).

- [ ] **1b.** Create `src/commands/config.ts` with a `registerConfig` function
  that registers `5x config show` as a commander subcommand. Pattern:
  `parent.command("config")` → `.command("show")` →
  `.option("--context <dir>", "Config context directory", process.cwd())` →
  `.action(configShow)`. The `--context` flag passes `contextDir` to the
  handler for layered config resolution.

- [ ] **1c.** Register the command in `src/bin.ts`: import `registerConfig`,
  call `registerConfig(program)`.

- [ ] **1d.** Add unit test `test/unit/commands/config-show.test.ts` that tests
  pure config-resolution and text-formatting helpers directly (no stdout
  capture). Specifically:
  (a) calls the text formatter with a known config object and asserts the
  returned string contains expected key-value pairs;
  (b) calls `resolveLayeredConfig(rootDir)` with a temp dir containing a
  `5x.toml` with custom values and verifies the resolved config reflects
  those overrides;
  (c) calls `resolveLayeredConfig(rootDir, subDir)` where `subDir` contains
  a nearest-config override, verifying the layered merge (sub-project values
  override root, root values fill gaps);
  (d) calls `resolveLayeredConfig(rootDir)` with no config file and verifies
  defaults are returned.

- [ ] **1e.** Add integration test `test/integration/commands/config-show.test.ts`
  that spawns `5x config show` via `Bun.spawnSync` and validates
  stdout/envelope output. Use `cleanGitEnv()`, `stdin: "ignore"`, and
  per-test `timeout`. Cases:
  (a) spawn in a temp dir with a `5x.toml` containing custom values, parse
  the JSON envelope, assert `ok: true` with expected config values;
  (b) spawn with `--context <subdir>` where `subdir` has a nearest-config
  override, verify the envelope reflects the layered merge;
  (c) spawn in a temp dir with no config file, verify the envelope contains
  default values.

## Phase 2: Create `5x` foundational skill

**Completion gate:** A new `5x` skill exists in the loader, is installed by
`5x skills install`, and contains all cross-cutting orchestration content.

- [ ] **2a.** Create `src/skills/5x/SKILL.md` with the following content
  extracted from the existing three skills:
  - YAML frontmatter with `name: 5x` and a description focused on the
    co-loading instruction (no trigger words — this skill is loaded by
    process skills, never independently)
  - `## Tools` section listing `5x config show` as the way to read runtime
    config values (iteration limits, quality retry limits, timeout settings)
  - `## Human Interaction Model` — the 3-tier interaction model (native
    tool → conversational → `5x prompt` subprocess), moved verbatim from
    the existing "Human interaction note" sections
  - `## Delegating Sub-Agent Work` — native-first pattern explanation,
    installed agent names (full list from all skills: `5x-orchestrator`,
    `5x-plan-author`, `5x-code-author`, `5x-reviewer`), agent detection
    order (project → user → fallback), the generic delegation code example
  - `## Session Reuse` — general concept of session identifiers, `--session`
    flag, continued-template auto-selection. Skill-specific details (e.g.,
    `continuePhaseSessions` enforcement) stay in the process skills
  - `## Fallback: 5x invoke` — stderr suppression pattern with `2>/dev/null`
  - `## Timeout Layers` — invocation timeout vs. shell tool timeout, how to
    configure, what empty output means
  - `## Gotchas` — cross-cutting gotchas:
    - Empty subprocess output = agent killed by timeout, never treat as valid
    - Always `2>/dev/null` on `5x invoke` to keep stderr out of context
    - Never pass `--timeout` to `5x invoke` unless intentionally overriding config
    - `5x protocol validate --record` is the single recording point — don't also
      `--record` on `5x invoke`
    - Native agent detection checks project scope before user scope
    - Session reuse is best-effort — never fail a workflow because it didn't work
    - `result: "complete"` without a commit = invariant violation in any author step
    - Read iteration/retry limits from `5x config show`, never hardcode numbers

- [ ] **2b.** Update `src/skills/loader.ts`: add `import` for the new
  `5x/SKILL.md` with `{ type: "text" }`, add `"5x": skill5xRaw` to the
  `SKILLS` registry. Update `test/unit/commands/init-skills.test.ts` to
  account for the fourth bundled skill: change `expect(names.length).toBe(3)`
  to `toBe(4)` and `expect(skills.length).toBe(3)` to `toBe(4)`, and add
  `expect(names).toContain("5x")` to the name assertions.

- [ ] **2c.** Update existing skill loader tests in
  `test/unit/skills/skill-content.test.ts`:
  - Add `"5x"` to the expected skill names
  - Add a new `describe("5x foundational skill")` block that verifies:
    - Skill loads and frontmatter parses correctly
    - Contains "Human Interaction" or equivalent section
    - Contains "Delegating Sub-Agent Work" or equivalent section
    - Contains "Timeout" section
    - Contains "Gotchas" section
    - References all four agent names (`5x-orchestrator`, `5x-plan-author`,
      `5x-code-author`, `5x-reviewer`)
    - References `5x config show`
    - Documents native agent detection order (project → user → fallback)

## Phase 3: Slim down process skills and add gotchas

**Completion gate:** All three process skills have shared content removed,
gotchas sections added, and back-reference the `5x` skill. Existing tests
updated to match new structure.

- [ ] **3a.** Update `src/skills/5x-plan/SKILL.md`:
  - Remove: "Human interaction note" section (~16 lines)
  - Remove: "Delegating sub-agent work" intro, agent names list, detection
    order, generic delegation example (~40 lines). Keep the skill-specific
    delegation example (author-generate-plan code block in Step 2)
  - Remove: "Fallback: 5x invoke" section (~8 lines)
  - Remove: "Timeout layers" section (~18 lines)
  - Add after Prerequisites: `## Prerequisite Skill` section stating
    "Load the `5x` skill for delegation patterns, interaction model, and
    timeout handling."
  - Add after Prerequisite Skill: `## Gotchas` section:
    - Plan path must resolve inside `paths.plans` (from config)
    - After author generates plan, file must exist AND parse via
      `5x plan phases`
    - Author must produce a commit — no commit is an invariant violation;
      re-invoke with fresh session
    - Read `maxReviewIterations` from `5x config show` for the review loop limit

- [ ] **3b.** Update `src/skills/5x-plan-review/SKILL.md`:
  - Same shared content removal as 3a
  - Keep the skill-specific delegation examples (reviewer-plan and
    author-process-plan-review code blocks) and session reuse details
    (continuePhaseSessions enforcement)
  - Add `## Prerequisite Skill` section
  - Add `## Gotchas` section:
    - Only completed review-then-author cycles count toward
      `maxReviewIterations` — retries from timeout/empty output don't count
    - Empty diff after author "completes" = context loss → use `--new-session`
    - `not_ready` with no actionable items → escalate, don't loop
    - `SESSION_REQUIRED` error → pass `--new-session` to recover
    - Read `maxReviewIterations` from `5x config show` for the iteration limit

- [ ] **3c.** Update `src/skills/5x-phase-execution/SKILL.md`:
  - Same shared content removal as 3a
  - Remove the duplicated "Native agent detection order" block
    (appears at lines 68-72 and again at lines 79-83)
  - Keep all skill-specific delegation examples, worktree-aware execution
    section, workflow steps, invariants, and recovery scenarios
  - Add `## Prerequisite Skill` section
  - Add `## Gotchas` section:
    - NEVER record `phase:complete` if checklist shows `done: false` —
      record `phase:checklist_mismatch` and escalate instead
    - `5x plan phases` is the authoritative signal for phase completion,
      not step records
    - After author fix, re-run quality gates (Step 2), don't skip to
      review (Step 3)
    - Read `maxReviewIterations` and `maxQualityRetries` from
      `5x config show` — never hardcode limits
    - Phase count should not change during a run — if it does, flag to human

- [ ] **3d.** Update `test/unit/skills/skill-content.test.ts`:
  - For each process skill, update or replace tests that assert on content
    that has moved to the `5x` skill. Specifically:
    - Tests checking for "Native agent detection order" in each process
      skill should be moved to the `5x` skill test block
    - Tests checking for "5x invoke" fallback should be updated: process
      skills still reference `5x invoke` in their specific examples, but
      the "Fallback" section is now in the `5x` skill
    - Add tests verifying each process skill contains a "Gotchas" section
    - Add tests verifying each process skill contains a "Prerequisite Skill"
      section referencing the `5x` skill
  - Skill-specific contract tests (AuthorStatus, ReviewerVerdict, checklist
    verification) remain unchanged — these test content that stays in the
    process skills

## Phase 4: Improve description fields

**Completion gate:** All three process skill descriptions include trigger words
and instruct the agent to co-load the `5x` skill. The `5x` skill description
instructs co-loading (no trigger words — it never fires independently).

- [ ] **4a.** Update the description field in `src/skills/5x/SKILL.md`.
  The `5x` skill is a co-loaded dependency, not an independently triggered
  skill — it should never fire on its own. Remove the `Triggers on:` line
  entirely and keep the description focused on the co-loading instruction:
  ```yaml
  description: >-
    Shared foundation for all 5x workflows. ALWAYS load this skill alongside
    any 5x-plan, 5x-plan-review, or 5x-phase-execution skill. Covers
    delegation patterns, human interaction, timeouts, and cross-cutting
    gotchas.
  ```

- [ ] **4b.** Update the description field in `src/skills/5x-plan/SKILL.md`:
  ```yaml
  description: >-
    Generate an implementation plan from a requirements document, then run
    review/fix cycles until the plan is approved. Load the `5x` skill first.
    Triggers on: 'new feature', 'implementation plan', 'plan from
    requirements', 'generate plan', 'PRD', 'TDD'.
  ```

- [ ] **4c.** Update the description field in `src/skills/5x-plan-review/SKILL.md`:
  ```yaml
  description: >-
    Run iterative review/fix cycles on an implementation plan until it is
    approved by the reviewer or the human overrides. Load the `5x` skill
    first. Triggers on: 'review plan', 'plan review', 'iterate on plan',
    'get plan approved'.
  ```

- [ ] **4d.** Update the description field in `src/skills/5x-phase-execution/SKILL.md`:
  ```yaml
  description: >-
    Execute implementation phases from an approved plan. Each phase goes
    through author implementation, quality gates, code review, and optional
    fix cycles. Load the `5x` skill first. Triggers on: 'execute plan',
    'implement plan', 'run phases', 'next phase', 'phase execution'.
  ```

- [ ] **4e.** Run full test suite (`bun test`) and fix any failures from
  description changes affecting test assertions.

## Files Touched

| File | Change |
|------|--------|
| `src/commands/config.handler.ts` | **New** — `configShow` handler using `resolveLayeredConfig` |
| `src/commands/config.ts` | **New** — commander registration with `--context <dir>` option |
| `src/bin.ts` | Add `registerConfig` import and call |
| `src/skills/5x/SKILL.md` | **New** — shared foundational skill |
| `src/skills/5x-plan/SKILL.md` | Remove shared content, add gotchas, update description |
| `src/skills/5x-plan-review/SKILL.md` | Remove shared content, add gotchas, update description |
| `src/skills/5x-phase-execution/SKILL.md` | Remove shared content, fix duplicate block, add gotchas, update description |
| `src/skills/loader.ts` | Add import + registry entry for `5x` skill |
| `test/unit/commands/config-show.test.ts` | **New** — unit tests for config show |
| `test/integration/commands/config-show.test.ts` | **New** — integration test for config show |
| `test/unit/commands/init-skills.test.ts` | Update exact-count assertions (3 → 4) for new `5x` skill |
| `test/unit/skills/skill-content.test.ts` | Update for new skill, moved content, gotchas assertions |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `config-show.test.ts` | Pure config-resolution (layered + defaults) and text-formatting helpers |
| Unit | `skill-content.test.ts` | All 4 skills load, frontmatter parses, content assertions |
| Integration | `config-show.test.ts` | `5x config show` subprocess returns JSON envelope; `--context` layered resolution |
| Existing | `skill-content.test.ts` | Existing contract tests still pass after content moves |

## Estimated Scope

| Phase | Size | Notes |
|-------|------|-------|
| Phase 1 | Small | ~60 lines handler + ~30 lines commander adapter + ~80 lines tests |
| Phase 2 | Medium | ~120 lines SKILL.md + ~5 lines loader + ~40 lines tests |
| Phase 3 | Medium | Net removal across 3 skills; test updates are the main work |
| Phase 4 | Small | Description field updates only + test fixups |

## Not In Scope

- Hub+spoke file structure for `5x-phase-execution` (recovery scenarios are
  sequential, not independent — splitting adds indirection without benefit)
- On-demand hooks for skills (future opportunity, requires hook system changes)
- Memory/data persistence in skills (we use the 5x database for this)
- Skill marketplace or plugin distribution changes
- Changes to the skill installer to support multi-file skill directories
- Changes to templates or agent definitions

## Revision History

### v1.2 — Address R2 review (023-skill-improvements-review.md, Addendum)

**P1.2 — worktree control plane root (R1):** Phase 1a now explicitly requires
`resolveControlPlaneRoot(startDir)` and passes `controlPlane.controlPlaneRoot`
as the first argument to `resolveLayeredConfig`. This matches the pattern used
by `template.handler.ts`, `invoke.handler.ts`, etc. and ensures root-anchored
values like `db.path` resolve correctly in linked worktrees.

**P2.2 — self-trigger contradiction (R2):** Fixed Phase 4 completion gate to
say "All three process skill descriptions include trigger words" (not four),
and clarifies the `5x` skill description instructs co-loading only. Updated
Phase 2a frontmatter description from "optimized for triggering" to "focused
on co-loading instruction."

**P2.3 — missing test coverage for 4th skill (R3):** Added
`test/unit/commands/init-skills.test.ts` to the Files Touched table. Phase 2b
now explicitly notes updating the exact-count assertions (3 → 4) in that file.

### v1.1 — Address R1 review (023-skill-improvements-review.md)

**P0.1 — config resolution (R1):** Replaced `loadConfig(projectRoot)` with
`resolveLayeredConfig(projectRoot, contextDir)` in Phase 1a. Added
`--context <dir>` CLI flag to Phase 1b. Updated Design Decisions to document
layered resolution and reference the existing callers. Updated Phase 1d/1e
tests to cover both root-only and layered (sub-project override) scenarios.

**P1.1 — trigger descriptions (R2):** Removed `Triggers on:` line from the
`5x` skill description in Phase 4a. The `5x` skill is a co-loaded dependency
that should never fire independently; its description now focuses solely on
the co-loading instruction.

**P2.1 — unit test stdout capture (R3):** Reworked Phase 1d to test pure
config-resolution and text-formatting helpers directly (function return values,
no stdout capture). Moved envelope/stdout assertions to the integration test
in Phase 1e.
