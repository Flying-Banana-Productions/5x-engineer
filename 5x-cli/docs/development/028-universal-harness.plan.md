# Universal Harness and Shared Skill Templates

**Version:** 1.0
**Created:** March 24, 2026
**Status:** Draft

## Overview

There is no out-of-the-box solution for AI coding tools that lack a dedicated harness
plugin. The OpenCode harness installs skills with native Task tool delegation, and the
planned Cursor harness will do the same with Cursor-native subagents. Any other tool —
Claude Code, Windsurf, Aider, or a custom setup — has no way to use 5x workflows today.

This plan introduces two things:

1. **A `universal` harness** that installs skills using `5x invoke` for all
   author/reviewer delegation. No native sub-agents, no agent definitions, no
   orchestrator profile. The user's AI tool reads the skills; `5x invoke` does the
   work via whatever providers are configured in `5x.toml`.

2. **A shared skill template system** so that all harnesses (opencode, cursor,
   universal) render their skills from a single set of base templates with
   conditional blocks for delegation method. This eliminates maintaining near-
   duplicate skill files per harness.

The universal harness writes skills to the [agentskills.io](https://agentskills.io/specification)
standard paths (`.agents/skills/`). This is an agentskills.io-conforming install —
files are placed at the documented discovery paths. Client discovery and orchestration
behavior depend on the host tool's implementation of the agentskills.io spec.

## Design Decisions

**The universal harness installs skills only — no agents, no orchestrator.** The host
tool IS the orchestrator. The user is responsible for configuring their tool to read
skills and follow them. This keeps the universal harness truly universal: it doesn't
need to know the host tool's agent/rule format.

**Install location follows agentskills.io paths.** Project scope installs to
`<project>/.agents/skills/`, user scope to `~/.agents/skills/`. These are the documented
paths from the agentskills.io spec. The 5x CLI writes files to these locations; actual
discovery and loading behavior depends on the host tool's agentskills.io implementation.

**All delegation in universal skills uses `5x invoke`.** `5x invoke` handles template
rendering, provider invocation, structured output validation, and run recording in a
single CLI call. The orchestrating LLM only needs shell access — no native sub-agent
capabilities required. The provider is determined by `5x.toml` config (`author.provider`,
`reviewer.provider`).

**No mixed-mode delegation.** If you use the universal harness, ALL roles go through
`5x invoke`. If you want native sub-agents, use the harness-specific plugin (opencode,
cursor). The user picks one harness per install scope.

**No `harness` field in `5x.toml`.** Adding a config dependency would create coupling
between config and the `5x harness` commands. The user manages installs via
`5x harness install`; harness runtimes handle skill loading prioritization per the
agentskills.io discovery spec (project overrides user, client-specific overrides
cross-client).

**Skill templates live in a shared `src/skills/` directory.** Base templates contain
the full skill content with conditional blocks for delegation method. Each harness
renders them with its context (`{ native: true }` or `{ native: false }`). This
eliminates maintaining near-duplicate skill files per harness.

**Hand-rolled template engine.** The conditional logic is simple (boolean if/else for
delegation method), only ~4 templates exist, and the blocks are well-defined. A custom
preprocessor (~60 LOC) avoids adding a dependency. The engine has a clean interface
that could be swapped for a real library later if needs grow.

**Template syntax is line-based `{{#if}}`/`{{else}}`/`{{/if}}`.** Directive lines are
stripped from output. Content between directives is included or excluded based on
context. No nesting is supported in v1 (not needed). The syntax is Handlebars-like but
does not aim for Handlebars compatibility.

**`5x invoke --record` is the single recording point for the invoke path.** Just as
`5x protocol validate --record` is the single recording point for native delegation,
`5x invoke --record` handles validation and recording in one call for the invoke path.
The orchestrator does not call `5x protocol validate` separately.

**Known limitation: `review_path` is not surfaced in `5x invoke` output.** The native
path extracts `review_path` from `5x template render` output to verify the reviewer
committed the review file. The invoke path renders the template internally and does not
surface template variables. For v1, the invoke-path skills perform a separate
`5x template render` call to extract `review_path` before invoking. This is a minor
inefficiency (double template rendering) that can be resolved later by adding
`template_variables` to the invoke output envelope.

**SKILL.md frontmatter conforms to agentskills.io spec.** Required fields: `name`
(lowercase, hyphens, matches parent directory, max 64 chars) and `description` (max
1024 chars). Optional: `metadata` (arbitrary key-value), `compatibility`, `license`.
The existing frontmatter is already compliant.

## Phase 1: Skill Template Engine

**Completion gate:** A `renderSkillTemplate()` function processes conditional blocks
in template strings, with unit tests covering all edge cases.

- [x] **1a.** Create `src/skills/renderer.ts` with the template engine:

  ```typescript
  export interface SkillRenderContext {
    /** true = native harness delegation (Task tool, subagents),
        false = CLI invoke delegation (5x invoke) */
    native: boolean;
  }

  /**
   * Render a skill template by processing conditional blocks.
   *
   * Syntax (each directive must be on its own line, no leading content):
   *   {{#if native}}   — include block when ctx.native is true
   *   {{#if invoke}}   — include block when ctx.native is false
   *   {{else}}         — switch to the opposite branch
   *   {{/if}}          — end conditional block
   *
   * Directive lines are stripped from output. Content lines are
   * included/excluded based on the active condition.
   * Nesting is not supported.
   */
  export function renderSkillTemplate(
    template: string,
    ctx: SkillRenderContext,
  ): string;
  ```

  Implementation: line-by-line scan. Track `inBlock: boolean`, `blockActive: boolean`.
  When a `{{#if native}}` line is encountered, set `inBlock = true`,
  `blockActive = ctx.native`. For `{{#if invoke}}`, set `blockActive = !ctx.native`.
  `{{else}}` flips `blockActive`. `{{/if}}` resets. Non-directive lines are emitted
  when `!inBlock || blockActive`. Throw on unmatched `{{else}}`/`{{/if}}` or
  unclosed blocks.

- [x] **1b.** Create `src/skills/loader.ts` — loads base templates from `src/skills/base/`:

  ```typescript
  import type { SkillMetadata } from "../harnesses/installer.js";
  import type { SkillRenderContext } from "./renderer.js";

  /** Load all base skill templates, render with context, parse frontmatter. */
  export function renderAllSkillTemplates(
    ctx: SkillRenderContext,
  ): SkillMetadata[];

  /** Load and render a single base skill template by name. */
  export function renderSkillByName(
    name: string,
    ctx: SkillRenderContext,
  ): SkillMetadata;

  /** List base skill template names. */
  export function listBaseSkillNames(): string[];
  ```

  Uses Bun text imports for the `.tmpl.md` files, renders via `renderSkillTemplate()`,
  parses frontmatter via the existing `parseSkillFrontmatter()` (moved to a shared
  location — see Phase 2).

- [x] **1c.** Add unit tests in `test/unit/skills/renderer.test.ts`:
  - `{{#if native}}` block included when `native: true`, stripped when `false`
  - `{{#if invoke}}` block included when `native: false`, stripped when `true`
  - `{{#if native}}...{{else}}...{{/if}}` selects correct branch
  - Directive lines are not present in output
  - Content outside conditional blocks always included
  - Markdown code blocks (triple backticks) inside conditionals preserved correctly
  - Unclosed `{{#if}}` throws
  - Unmatched `{{else}}` or `{{/if}}` throws
  - Empty conditional blocks produce no output for that section
  - Multiple conditional blocks in one template

## Phase 2: Extract Base Skill Templates

**Completion gate:** The four skill templates exist in `src/skills/base/`, the
OpenCode harness renders them with `{ native: true }`, and all existing OpenCode
skill tests pass unchanged.

- [x] **2a.** Create `src/skills/base/` directory with four template files:
  - `5x/SKILL.tmpl.md`
  - `5x-plan/SKILL.tmpl.md`
  - `5x-plan-review/SKILL.tmpl.md`
  - `5x-phase-execution/SKILL.tmpl.md`

- [x] **2b.** Move `parseSkillFrontmatter()` from
  `src/harnesses/opencode/skills/loader.ts` to `src/skills/frontmatter.ts` as a
  shared utility. Update the OpenCode loader import.

- [x] **2c.** Convert `5x/SKILL.md` to `5x/SKILL.tmpl.md` with conditional blocks:

  **Delegation sections (wrap in `{{#if native}}`/`{{else}}`/`{{/if}}`):**
  - "Delegating to Subagents" section (lines 42–69) — main delegation pattern
  - "Task Reuse" section (lines 74–84) — task reuse guidance

  The `{{#if native}}` branch retains the current Task tool pattern. The `{{else}}` branch describes `5x invoke` delegation:
  - No subagent table (no Task tool `subagent_type` parameter)
  - Delegation via `5x invoke <role> <template> --run $RUN ...`
  - Session reuse via `--session <id>` flag on `5x invoke`
  - `5x invoke --record` as the single recording point

  **Gotchas section (conditionalize specific items):**
  - Line 91: "Task reuse is best-effort" — change `task_id` reference to `{{#if native}}task_id{{else}}session_id{{/if}}`
  - Line 94-95: "Re-invoke with a fresh task (omit `task_id`)" — wrap in native block
  - Line 99: "Retry once with a fresh task (omit `task_id`)" — wrap in native block

  **All other sections are truly shared:** Tools, Human Interaction Model, and Gotchas items that don't reference `task_id` or `subagent_type`.

- [x] **2d.** Convert `5x-plan/SKILL.md` to `5x-plan/SKILL.tmpl.md`:

  **Delegation sections (wrap in `{{#if native}}`/`{{else}}`/`{{/if}}`):**
  - Step 2 "Generate the plan" (lines 72–84) — the entire delegation block with Task tool and `5x protocol validate`

  The `{{#if native}}` branch retains the Task tool pattern:
  ```bash
  RENDERED=$(5x template render author-generate-plan --run $RUN \
    --var prd_path=$PRD_PATH)
  PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
  STEP=$(echo "$RENDERED" | jq -r '.data.step_name')
  RESULT=<Task tool: subagent_type="5x-plan-author", prompt=$PROMPT>
  echo "$RESULT" | 5x protocol validate author \
    --run $RUN --record --step $STEP --phase plan
  ```

  The `{{else}}` branch uses `5x invoke`:
  ```bash
  RESULT=$(5x invoke author author-generate-plan --run $RUN \
    --var prd_path=$PRD_PATH \
    --record --step author:generate-plan --phase plan)
  ```
  Result checking reads from `.data.result` in the invoke output envelope.

  **Gotchas section (conditionalize specific items):**
  - Line 35: "re-invoke with a fresh task (omit `task_id`)" — wrap in `{{#if native}}` block

  **Recovery section (conditionalize specific items):**
  - Line 126-127: "re-invoke with a fresh task (omit `task_id`)" — wrap in `{{#if native}}` block
  - Line 129: "Re-invoke with a fresh task (omit `task_id`)" — wrap in `{{#if native}}` block
  - Line 135: "Retry once with a fresh task (omit `task_id`)" — wrap in `{{#if native}}` block

  **All other sections are truly shared:** Prerequisites, Tools, Invariants, Recovery items without `task_id` references, and Completion.

- [x] **2e.** Convert `5x-plan-review/SKILL.md` to `5x-plan-review/SKILL.tmpl.md`:

  **Delegation sections (wrap in `{{#if native}}`/`{{else}}`/`{{/if}}`):**
  - "Delegating sub-agent work" section under Tools (lines 49–89) — canonical Task tool example
  - Step 1 "Review" (lines 100–125) — reviewer delegation with Task tool
  - Step 3 "Author fix" (lines 148–163) — author delegation with Task tool

  The `{{#if native}}` branches retain Task tool patterns with `subagent_type`,
  `task_id` parameter, and `5x protocol validate --record` calls. The `{{else}}`
  branches use `5x invoke reviewer ... --record` and `5x invoke author ... --record`
  patterns with session reuse via `--session` flag.

  **Workflow intro (conditionalize):**
  - Lines 94-97: References to `$REVIEWER_TASK_ID` and `task_id=$REVIEWER_TASK_ID` to Task tool — wrap in `{{#if native}}` block. Invoke path uses `$SESSION_ID` and omits the Task tool `task_id` parameter.

  **Gotchas section (conditionalize specific items):**
  - Line 33: "`SESSION_REQUIRED` error → pass `--new-session` to `5x template render`" — this is actually shared (both paths use `--new-session` for recovery)

  **Recovery section (conditionalize specific items):**
  - Line 225: "re-invoke with a fresh task (omit `task_id`)" — wrap in `{{#if native}}` block
  - Line 232: "Re-invoke with a fresh task (omit `task_id`)" — wrap in `{{#if native}}` block
  - Line 237-239: "`SESSION_REQUIRED` error... pass the reviewer's `task_id` as `--session`" — wrap `task_id` reference in `{{#if native}}task_id{{else}}session_id{{/if}}`

  **All other sections are truly shared:** Prerequisites, Tools (non-delegation items), Invariants, most Recovery items, and Completion.

- [x] **2f.** Convert `5x-phase-execution/SKILL.md` to `5x-phase-execution/SKILL.tmpl.md`:

  **Delegation sections (wrap in `{{#if native}}`/`{{else}}`/`{{/if}}`):**
  - "Task reuse" subsection under Tools (lines 61–69) — the entire task reuse explanation
  - Step 1 "Author implements" (lines 129–143) — author delegation with Task tool
  - Step 2a "Quality retry" delegation (lines 179–193) — author delegation with Task tool
  - Step 3 "Code review" (lines 196–230) — reviewer delegation with Task tool
  - Step 5 "Author fixes review items" (lines 254–267) — author delegation with Task tool

  The `{{#if native}}` branches retain Task tool patterns with `subagent_type`,
  `task_id` parameter, and `5x protocol validate --record`. The `{{else}}` branches
  use `5x invoke <role> <template> --run $RUN ... --record` patterns with `--session`
  for continuity.

  **Tools section — Worktree-aware execution subsection (conditionalize):**
  - Lines 88-91: "For native subagents, the effective working directory is communicated via the `## Context` block..." — wrap in `{{#if native}}` block

  **Workflow tracking (conditionalize):**
  - Line 127: Track `$REVIEWER_TASK_ID = ""` — change to `{{#if native}}$REVIEWER_TASK_ID{{else}}$SESSION_ID{{/if}}`

  **Step 3 — Code review (additional conditional note):**
  - Lines 229-230: "Capture `$REVIEWER_TASK_ID` (the `task_id` from the Task tool)" — wrap in `{{#if native}}` block. Invoke path captures from `.data.session_id`.

  **Recovery section (conditionalize specific items):**
  - Line 371: "Re-invoke with a fresh task (omit `task_id`)" — wrap in `{{#if native}}` block
  - Line 417: "Retry once with a fresh task (omit `task_id`)" — wrap in `{{#if native}}` block
  - Line 426: "Retry once with a fresh task (omit `task_id`)" — wrap in `{{#if native}}` block

  **Known difference for invoke-path Step 3 (reviewer):** Add a comment in the `{{else}}`
  branch noting that the native path extracts `review_path` from `5x template render`
  output, but the invoke path renders the template internally. For v1, the invoke-path
  skills perform a separate `5x template render` call to extract `review_path` before
  calling `5x invoke`.

  **All other sections are truly shared:** Prerequisites, Quality gates, most Tools
  (non-delegation items), Verdict routing, Escalation, Invariants, Phase gate, and
  most Recovery logic.

- [x] **2g.** Rewire OpenCode harness skill loader (`src/harnesses/opencode/skills/loader.ts`)
  to use `renderAllSkillTemplates({ native: true })` from the shared loader instead
  of directly importing raw SKILL.md files. The OpenCode-specific SKILL.md files
  in `src/harnesses/opencode/skills/` are deleted — the base templates are the
  source of truth.

- [x] **2h.** Verify all existing OpenCode skill tests pass. The rendered output for
  `{ native: true }` must be byte-identical (modulo stripped directive lines) to
  the current SKILL.md content.

- [x] **2i.** Add unit tests in `test/unit/skills/loader.test.ts`:
  - All four templates load and parse frontmatter
  - `renderAllSkillTemplates({ native: true })` produces valid SkillMetadata[]
  - `renderAllSkillTemplates({ native: false })` produces valid SkillMetadata[]
  - Native output contains "Task tool" / "subagent_type" references (structure only, content placeholders ok)
  - Invoke output does NOT contain "Task tool" / "subagent_type" (structure only, content placeholders ok)
  - Frontmatter is identical in both render contexts
  - Placeholder invoke content (if any) is wrapped in `{{else}}` blocks correctly

  **Note:** This phase validates template structure and conditional block placement.
  The actual invoke-path content (what goes in `{{else}}` branches) is authored in
  Phase 4. Tests here check that the templates render without errors and that
  conditional blocks separate native/invoke paths correctly.

## Phase 3: Universal Harness Plugin

**Completion gate:** `5x harness install universal --scope project` writes skills to
`.agents/skills/` following the agentskills.io convention.
`5x harness install universal --scope user` writes to `~/.agents/skills/`.
`5x harness list` shows installed skills including `universal` entries.

- [x] **3a.** Add universal location resolver in `src/harnesses/locations.ts`:

  ```typescript
  export const universalLocationResolver: HarnessLocationResolver = {
    name: "universal",
    resolve(scope, projectRoot, homeDir?) {
      if (scope === "project") {
        const base = join(projectRoot, ".agents");
        return {
          rootDir: base,
          agentsDir: join(base, "agents"),
          skillsDir: join(base, "skills"),
        };
      }
      const home = homeDir ?? process.env.HOME ?? homedir();
      const base = join(home, ".agents");
      return {
        rootDir: base,
        agentsDir: join(base, "agents"),
        skillsDir: join(base, "skills"),
      };
    },
  };
  ```

- [x] **3b.** Create `src/harnesses/universal/plugin.ts`:

  ```typescript
  const universalPlugin: HarnessPlugin = {
    name: "universal",
    description: "Install 5x skills for any AI coding tool (uses 5x invoke for delegation)",
    supportedScopes: ["project", "user"],
    locations: universalLocationResolver,

    describe(): HarnessDescription {
      return {
        skillNames: listBaseSkillNames(),
        agentNames: [],  // no agents
      };
    },

    async install(ctx): Promise<HarnessInstallResult> {
      const locations = universalLocationResolver.resolve(
        ctx.scope, ctx.projectRoot, ctx.homeDir,
      );
      const skills = renderAllSkillTemplates({ native: false });
      return {
        skills: installSkillFiles(locations.skillsDir, skills, ctx.force),
        agents: { created: [], overwritten: [], skipped: [] },
      };
    },

    async uninstall(ctx): Promise<HarnessUninstallResult> {
      const locations = universalLocationResolver.resolve(
        ctx.scope, ctx.projectRoot, ctx.homeDir,
      );
      return {
        skills: uninstallSkillFiles(locations.skillsDir, listBaseSkillNames()),
        agents: { removed: [], notFound: [] },
      };
    },
  };
  ```

- [x] **3c.** Register `universal` in bundled harnesses in `src/harnesses/factory.ts`:

  ```typescript
  const BUNDLED_HARNESSES = {
    opencode: () => import("./opencode/plugin.js"),
    universal: () => import("./universal/plugin.js"),
  };
  ```

- [x] **3d.** Add unit tests in `test/unit/harnesses/universal.test.ts`:
  - Project scope resolves to `.agents/skills/`
  - User scope resolves to `~/.agents/skills/`
  - `describe()` returns skill names and empty agent names
  - Install writes `<skillsDir>/<name>/SKILL.md` for each skill
  - Installed SKILL.md files contain `5x invoke` delegation, not Task tool
  - Installed SKILL.md frontmatter is valid agentskills.io format
  - Uninstall removes skill directories
  - `agentsDir` is not written to (no agent files created)

- [x] **3e.** Add integration tests in `test/integration/commands/harness-universal.test.ts`:
  - `5x harness install universal --scope project` creates `.agents/skills/5x/SKILL.md` etc.
  - `5x harness list --scope project` shows installed skills (inspect output for `universal`)
  - `5x harness uninstall universal --scope project` removes all skill files
  - `--force` overwrites existing skills
  - Skill directory structure matches agentskills.io convention: `<name>/SKILL.md`

## Phase 4: Author Invoke-Path Skill Content

**Completion gate:** The `{{else}}` branches in all base templates contain complete,
usable `5x invoke`-based workflow descriptions. All delegation steps in these
branches use `5x invoke`, session reuse uses `--session`, and result checking reads
from the invoke output envelope. Phase 4d tests verify the authored content.

- [x] **4a.** Author the invoke-path content for the `{{else}}` branches in each
  base template (created in Phase 2 with conditional structure). Write complete
  delegation examples that an orchestrating LLM can follow. The invoke delegation
  pattern for each step follows this shape:

  **Author delegation (all author steps):**
  ```markdown
  Delegate to the code author via `5x invoke`:

  ```bash
  RESULT=$(5x invoke author <template> --run $RUN \
    --var plan_path=$PLAN_PATH --var phase_number=$PHASE_NUMBER \
    --record --step <step_name> --phase $PHASE)

  # Check result
  STATUS=$(echo "$RESULT" | jq -r '.data.result.result')
  COMMIT=$(echo "$RESULT" | jq -r '.data.result.commit // empty')
  SESSION_ID=$(echo "$RESULT" | jq -r '.data.session_id')
  ```
  ```

  **Reviewer delegation:**
  ```markdown
  Delegate to the reviewer via `5x invoke`:

  ```bash
  RESULT=$(5x invoke reviewer <template> --run $RUN \
    --var commit_hash=$COMMIT --var plan_path=$PLAN_PATH \
    ${SESSION_ID:+--session $SESSION_ID} \
    --record --step <step_name> --phase $PHASE \
    --iteration $REVIEW_ITERATIONS)

  READINESS=$(echo "$RESULT" | jq -r '.data.result.readiness')
  SESSION_ID=$(echo "$RESULT" | jq -r '.data.session_id')
  ```
  ```

  **Session reuse (invoke path):**
  ```markdown
  ## Session Reuse

  **Session reuse** is optional and best-effort. `5x invoke` returns a
  `session_id` in its output. Pass it back via `--session` on subsequent
  invocations to resume the same provider session with full prior context.

  To also get a shorter continued-template variant, pass `--session`
  to `5x invoke` (it forwards the value to template rendering internally).
  If session reuse fails or is unavailable, omit `--session` — never fail
  a workflow because session reuse didn't work.
  ```

- [x] **4b.** For the reviewer step in `5x-phase-execution`, the invoke path adds
  a separate `5x template render` call before `5x invoke` to extract `review_path`
  for the post-review commit verification:

  ```markdown
  # Extract review_path (needed for post-review verification)
  REVIEW_PATH=$(5x template render reviewer-commit --run $RUN \
    --var commit_hash=$COMMIT --var plan_path=$PLAN_PATH \
    | jq -r '.data.variables.review_path')
  ```

- [x] **4c.** Update the `5x` foundation template's Gotchas section invoke-path
  variant to reference `session_id` and `5x invoke --record` instead of `task_id`
  and `5x protocol validate --record`.

- [x] **4d.** Add unit tests in `test/unit/skills/invoke-content.test.ts`:
  - Invoke-rendered skills contain `5x invoke author` and `5x invoke reviewer` commands
  - Invoke-rendered skills do NOT contain `Task tool`, `subagent_type`, or `task_id`
  - Invoke-rendered `5x` foundation skill references `session_id` in Gotchas
  - Invoke-rendered `5x-phase-execution` includes `review_path` extraction step
  - All four invoke-rendered skills contain `--record` in delegation blocks
  - Invoke-rendered skills reference `.data.result` for result checking
  - No native-only references (`5x protocol validate`, `Task tool`) appear in invoke output

## Phase 5: Documentation

**Completion gate:** README documents the universal harness install flow and
describes when to use it vs harness-specific plugins. `harness list` includes
`universal` in its output.

- [ ] **5a.** Update `README.md`:
  - Add `universal` to supported harnesses list
  - Document `5x harness install universal --scope project` and `--scope user`
  - Explain when to use universal (any tool without a dedicated harness) vs
    opencode/cursor (native sub-agent support)
  - Note that `.agents/skills/` is the agentskills.io cross-client convention

- [ ] **5b.** Add `src/harnesses/universal/README.md` with plugin internals
  (how it renders from base templates, location conventions, no agents).

- [ ] **5c.** Update `src/harnesses/README.md` to document the shared skill
  template system and how new harnesses should use `renderAllSkillTemplates()`.

- [ ] **5d.** Update `src/skills/README.md` (new) documenting:
  - Base template location and format
  - Conditional block syntax
  - How to add a new conditional variable
  - Rendering pipeline: base template → renderer → harness loader → installer

- [ ] **5e.** Verify `5x harness install universal` end-to-end:
  - Install to a test project
  - Confirm skills are discoverable by reading `.agents/skills/*/SKILL.md`
  - Confirm skill content uses `5x invoke` for all delegation
  - Confirm `5x harness list` reports skills at the universal location

## Files Touched

| File | Change |
|------|--------|
| `src/skills/renderer.ts` | **New** — skill template engine |
| `src/skills/loader.ts` | **New** — shared skill template loader |
| `src/skills/frontmatter.ts` | **New** — moved from OpenCode skills loader |
| `src/skills/base/5x/SKILL.tmpl.md` | **New** — base template extracted from OpenCode |
| `src/skills/base/5x-plan/SKILL.tmpl.md` | **New** — base template extracted from OpenCode |
| `src/skills/base/5x-plan-review/SKILL.tmpl.md` | **New** — base template extracted from OpenCode |
| `src/skills/base/5x-phase-execution/SKILL.tmpl.md` | **New** — base template extracted from OpenCode |
| `src/skills/README.md` | **New** — documents template system |
| `src/harnesses/universal/plugin.ts` | **New** — universal harness plugin |
| `src/harnesses/universal/README.md` | **New** — plugin internals |
| `src/harnesses/locations.ts` | Add `universalLocationResolver` |
| `src/harnesses/factory.ts` | Register `universal` in `BUNDLED_HARNESSES` |
| `src/harnesses/installer.ts` | No changes (existing `installSkillFiles()` suffices) |
| `src/harnesses/opencode/skills/loader.ts` | Rewire to use shared `renderAllSkillTemplates({ native: true })` |
| `src/harnesses/opencode/skills/5x/SKILL.md` | **Deleted** — replaced by base template |
| `src/harnesses/opencode/skills/5x-plan/SKILL.md` | **Deleted** — replaced by base template |
| `src/harnesses/opencode/skills/5x-plan-review/SKILL.md` | **Deleted** — replaced by base template |
| `src/harnesses/opencode/skills/5x-phase-execution/SKILL.md` | **Deleted** — replaced by base template |
| `src/harnesses/README.md` | Document shared template system |
| `README.md` | Document universal harness install and usage |

## Tests

| Type | Scope | File | Validates |
|------|-------|------|-----------|
| Unit | Template engine | `test/unit/skills/renderer.test.ts` | Conditional block processing, directive stripping, error handling |
| Unit | Shared loader | `test/unit/skills/loader.test.ts` | Template loading, frontmatter parsing, native vs invoke rendering |
| Unit | Invoke content | `test/unit/skills/invoke-content.test.ts` | Invoke-path delegation patterns, no native references, result envelope parsing |
| Unit | Universal harness | `test/unit/harnesses/universal.test.ts` | Location resolution, plugin contract, install/uninstall, agentskills.io compliance |
| Unit | OpenCode regression | existing `test/unit/harnesses/opencode-skills.test.ts` | Rewired loader produces identical output |
| Integration | Harness commands | `test/integration/commands/harness-universal.test.ts` | Install/list/uninstall lifecycle, file structure, --force |

## Not In Scope

- Mixed-mode delegation (some roles native, some invoke) within a single harness install
- A `harness` field in `5x.toml` config
- Orchestrator agent profile or instructions in the universal harness (user responsibility)
- Surfacing `template_variables` in `5x invoke` output envelope (future enhancement)
- Nested conditional blocks in the template engine
- Template engine features beyond `{{#if}}`/`{{else}}`/`{{/if}}`
- Changes to `5x invoke` command interface or output schema
- Cursor harness migration to shared templates (separate plan, 027)
- Harness-specific `compatibility` frontmatter field in rendered skills

## Revision History

### v1.1 — March 24, 2026

**Changes per review:** `/docs/development/reviews/5x-cli-docs-development-028-universal-harness.plan-review.md`

- **R1 (P0.1):** Narrowed interoperability claims. Removed language implying "any compliant client discovers automatically" or validated client compatibility. Now describes the install as "agentskills.io-conforming" — files are written to spec paths; discovery depends on host tool implementation.
- **R2 (P0.2):** Expanded per-template conversion specs in phases 2c–2f. Explicitly enumerated every section containing native-only references (`task_id`, `subagent_type`, `Task tool`, `5x protocol validate`) that needs `{{#if native}}` conditionalization, including Gotchas and Recovery sections previously marked as "shared."
- **R3 (P1.1):** Fixed `5x harness list universal` → `5x harness list` throughout. The CLI does not support a harness-name argument.
- **P1.2:** Clarified phase sequencing. Phase 2 now validates template structure and conditional block placement only; Phase 4 is where invoke-path content is authored (filled into `{{else}}` branches). Updated test descriptions in 2i and 4d to reflect this separation.

### v1.0 — March 24, 2026

- Initial plan drafted from design exploration
- Covers shared template engine, base template extraction, universal harness plugin
- Follows agentskills.io spec for install locations and SKILL.md format
- Hand-rolled template engine with `{{#if}}`/`{{else}}`/`{{/if}}` syntax
