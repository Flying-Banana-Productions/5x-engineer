# Cursor Harness for Native 5x Workflows

**Version:** 1.0  
**Created:** March 23, 2026  
**Status:** Draft  
**PRD Reference:** docs/027-cursor-harness-native-workflows.prd.md

## Overview

Implement a bundled `cursor` harness that enables native 5x workflows in both the Cursor IDE and `cursor-agent` CLI. The harness installs 5x skills, subagents, and an orchestrator rule into Cursor's native asset locations (`.cursor/` for project scope, `~/.cursor/` for user scope).

The key design decision is to match the OpenCode harness capabilities wherever Cursor exposes equivalent native mechanisms, while adapting to Cursor's different architecture:

- Cursor uses project rules (`.mdc` files) as the orchestrator layer instead of a primary agent profile
- Cursor subagents use frontmatter with `name`, `description`, `model` fields
- Cursor CLI does not support plugins, so v1 uses only direct filesystem installs
- One harness covers both IDE and CLI since they share the same project/user asset structure

## Design Decisions

**One `cursor` harness covers both IDE and CLI.** Cursor editor and CLI share the same `.cursor/` project structure and `~/.cursor/` user structure for skills and subagents. This eliminates the need for separate `cursor-ide` and `cursor-cli` harness names.

**Filesystem install only in v1.** Cursor CLI does not support plugins per verified documentation. Marketplace packaging would create an IDE-only distribution story. The v1 harness installs plain files only via `5x harness install cursor`.

**Cursor uses a rule as the orchestrator layer.** OpenCode uses a custom primary agent profile (`5x-orchestrator`). Cursor does not document custom primary-agent profile files. The closest native equivalent is a project rule, so the main-agent orchestration guidance lives in `5x-orchestrator.mdc`.

**Canonical project skill path is `.cursor/skills/`.** Cursor supports both `.cursor/` and `.agents/`, but `.cursor/` is the only project root that can also hold subagents and rules. A single harness installs all project assets into one canonical tree.

**The harness framework gains first-class rule support.** The current plugin contract only manages skills and agents. Cursor needs managed rules for install/list/uninstall parity. Add optional rule support to shared harness types, installer helpers, and handler output. All new rule-related fields remain optional so existing harnesses stay source-compatible.

**Unsupported asset types use a typed CLI contract.** User-scope Cursor installs intentionally do not install rules (Cursor user rules are settings-managed, not file-backed). The plugin/handler contract surfaces this explicitly via typed result data with `unsupported` summaries and optional warnings, not ad-hoc printing.

**User-scope rules are out of scope until documented.** Do not guess a hidden `~/.cursor/rules` path. Treat user-scope orchestrator rules as unsupported in v1 with explicit messaging in install output and docs.

**Model injection follows Cursor's subagent frontmatter.** When no 5x role model is configured, omit the `model` field entirely; Cursor defaults to `inherit`. When a model is configured, inject it as a YAML-safe quoted scalar using the same escaping strategy as OpenCode (`yamlQuote()`-style escaping for `:`, `"`, `\`, newlines, and carriage returns).

**Do not use `readonly: true` for the reviewer in v1.** The current 5x review flow can require writing review artifacts and making a review commit. A readonly reviewer would diverge from current workflow behavior.

**Cursor-specific skill prose uses Cursor-native concepts.** Replace OpenCode-specific `Task tool` / `task_id` wording with Cursor subagent wording and resumable agent IDs. Use named subagents (`5x-plan-author`, `5x-code-author`, `5x-reviewer`) as delegation targets. Mention Cursor's built-in `explore` and `bash` subagents as optional helpers.

**Hooks are deferred.** Cursor hooks add cross-platform script complexity and are not required for v1 usability.

**Worktree execution requires manual verification.** 5x run-aware prompts append a `## Context` block containing the effective working directory. The Cursor orchestrator rule and subagent prompts must explicitly treat that path as authoritative. Manual release verification must prove that, for `5x run init --worktree`, Cursor-author edits land in the mapped worktree.

## Phase 0: Verification Gate — Validate Cursor Discovery and Worktree Assumptions

**Completion gate:** All live discovery assumptions verified before implementation proceeds. Items marked **human-gated** require manual IDE/CLI verification; all others can be verified via automated tests.

- [x] **Verify Cursor IDE discovers `.cursor/` project assets** (human-gated)
  - Create `.cursor/skills/`, `.cursor/agents/`, `.cursor/rules/` with test files
  - Open project in Cursor IDE and confirm subagents/rules appear in UI
  - Document any path variations needed for discovery

- [x] **Verify Cursor IDE discovers `~/.cursor/` user assets** (human-gated)
  - Create `~/.cursor/skills/` and `~/.cursor/agents/` with test files
  - Open any project in Cursor IDE and confirm user subagents available
  - Confirm user scope rules are settings-managed (not file-backed)

- [x] **Verify Cursor CLI discovery behavior** (human-gated)
  - Run `cursor` CLI commands in a project with `.cursor/` assets
  - Confirm CLI loads subagents/rules correctly
  - Document any CLI-specific discovery paths or flags

- [x] **Verify omitted-`model` semantics** (automated)
  - Test that subagent frontmatter without `model` field defaults to `inherit`
  - Confirm no errors when model is omitted

- [x] **Verify Windows discovery paths** (human-gated)
  - Test `.cursor/` discovery on Windows with path separator handling
  - Test `~/.cursor/` resolution via `%USERPROFILE%` environment variable
  - Confirm subagents appear in Cursor IDE/CLI on Windows

- [x] **Verify worktree editing behavior** (human-gated)
  - Create a real `5x run init --worktree` mapped worktree
  - Open Cursor in the mapped worktree directory
  - Confirm Cursor author edits land in the mapped worktree, not main checkout
  - Verify `5x diff --run` shows correct changes

**Exit criteria:** This phase gates entry to Phases 1-5. If any verification fails, document the finding and either adjust the plan or escalate before proceeding.

## Phase 1: Add Optional Harness Rule Support

**Completion gate:** The harness framework can install, list, and uninstall rules in addition to skills and agents. All existing harnesses (OpenCode) continue to work unchanged.

- [x] **Extend `HarnessLocations` with optional `rulesDir`** in `src/harnesses/types.ts` (line 32-39 area)
  ```typescript
  export interface HarnessLocations {
    rootDir: string;
    agentsDir: string;
    skillsDir: string;
    rulesDir?: string;  // NEW: optional rules directory
  }
  ```

- [x] **Extend `HarnessDescription` with optional `ruleNames` and `capabilities`** in `src/harnesses/types.ts` (line 61-65 area)
  ```typescript
  export interface HarnessDescription {
    skillNames: string[];
    agentNames: string[];
    ruleNames?: string[];  // NEW: optional rule names
    capabilities?: {        // NEW: scope-aware capability metadata
      rules?: boolean;     // true if rules are supported in this scope
    };
  }
  ```

- [x] **Extend `describe()` with optional scope parameter** in plugin contract
  ```typescript
  describe(scope?: HarnessScope): HarnessDescription;
  ```
  When `scope` is provided, the plugin returns scope-aware metadata:
  - Project scope: `capabilities.rules = true` (supported), `ruleNames` populated
  - User scope: `capabilities.rules = false` (unsupported for Cursor), `ruleNames` empty or omitted
  When `scope` is omitted, returns global/default description.

- [x] **Extend `HarnessInstallResult` with optional `rules`** and `unsupported` in `src/harnesses/types.ts` (line 49-55 area)
  ```typescript
  export interface HarnessInstallResult {
    skills: InstallSummary;
    agents: InstallSummary;
    rules?: InstallSummary;  // NEW: optional rules summary
    unsupported?: {         // NEW: explicitly unsupported asset types
      rules?: boolean;
    };
    warnings?: string[];     // NEW: optional human-readable warnings
  }
  ```

- [x] **Extend `HarnessUninstallResult` with optional `rules`** and `unsupported` in `src/harnesses/types.ts` (line 77-83 area)
  ```typescript
  export interface HarnessUninstallResult {
    skills: UninstallSummary;
    agents: UninstallSummary;
    rules?: UninstallSummary;  // NEW: optional rules summary
    unsupported?: {
      rules?: boolean;
    };
  }
  ```

- [x] **Add `installRuleFiles()` helper** in `src/harnesses/installer.ts` (after line 169)
  ```typescript
  export function installRuleFiles(
    rulesDir: string,
    rules: Array<{ name: string; content: string }>,
    force: boolean,
  ): InstallSummary {
    return installFiles(
      rulesDir,
      rules.map((r) => ({ filename: `${r.name}.mdc`, content: r.content })),
      force,
    );
  }
  ```

- [x] **Add `uninstallRuleFiles()` helper** in `src/harnesses/installer.ts` (after line 259)
  ```typescript
  export function uninstallRuleFiles(
    rulesDir: string,
    ruleNames: string[],
  ): UninstallSummary {
    const removed: string[] = [];
    const notFound: string[] = [];

    for (const name of ruleNames) {
      const filePath = join(rulesDir, `${name}.mdc`);

      if (existsSync(filePath)) {
        rmSync(filePath);
        removed.push(`${name}.mdc`);
      } else {
        notFound.push(`${name}.mdc`);
      }
    }

    removeDirIfEmpty(rulesDir);
    return { removed, notFound };
  }
  ```

- [x] **Update `harness list` handler** in `src/commands/harness.handler.ts` (around line 200-214)
  - Pass current scope to `plugin.describe(scope)` to get scope-aware metadata
  - Add rule file detection loop similar to skills/agents (when `capabilities.rules` is true)
  - Include rules in `files` array with `rules/` prefix
  - Show `rules: unsupported` in JSON output when `capabilities.rules === false` or `capabilities` field is missing and rulesDir is absent
  - Example output structure:
    ```typescript
    {
      name: "cursor",
      scope: "user",
      files: [...],
      unsupported: { rules: true },  // when rules not supported in this scope
      capabilities: { rules: false }  // from describe(scope)
    }
    ```

- [x] **Update `printInstallSummary()`** in `src/commands/harness.handler.ts` (line 348-380) to print rule installation results

- [x] **Update `src/harnesses/README.md`** to document the optional rule contract for plugin authors

- [x] **Add unit tests** in `test/unit/harnesses/installer.test.ts` for rule install/uninstall helpers
  - Rule file creation, overwrite, skip semantics
  - Directory cleanup on uninstall

- [x] **Add unit tests in `test/unit/commands/harness.test.ts`** for scope-aware unsupported/rules JSON shape
  - `harness list --format json` includes `capabilities` field when plugin supports it
  - `harness list --format json` includes `unsupported.rules: true` when scope doesn't support rules
  - Handler correctly passes scope to `describe(scope)` call
  - Regression coverage for list output schema stability

## Phase 2: Add Cursor Location Resolver

**Completion gate:** `loadHarnessPlugin("cursor")` resolves a bundled plugin and the plugin can describe its assets for both scopes.

- [x] **Add Cursor location resolver** in `src/harnesses/locations.ts` (after line 95)
  ```typescript
  export const cursorLocationResolver: HarnessLocationResolver = {
    name: "cursor",
    resolve(
      scope: HarnessScope,
      projectRoot: string,
      homeDir?: string,
    ): HarnessLocations {
      if (scope === "project") {
        const base = join(projectRoot, ".cursor");
        return {
          rootDir: base,
          agentsDir: join(base, "agents"),
          skillsDir: join(base, "skills"),
          rulesDir: join(base, "rules"),  // Only for project scope
        };
      }

      // user scope: no documented rules directory
      const home = homeDir ?? process.env.HOME ?? homedir();
      const base = join(home, ".cursor");
      return {
        rootDir: base,
        agentsDir: join(base, "agents"),
        skillsDir: join(base, "skills"),
        // rulesDir intentionally omitted for user scope
      };
    },
  };
  ```

- [x] **Register `cursor` in bundled harnesses** in `src/harnesses/factory.ts` (line 22-27)
  ```typescript
  const BUNDLED_HARNESSES: Record<string, () => Promise<{ default: HarnessPlugin }>> = {
    opencode: () => import("./opencode/plugin.js"),
    universal: () => import("./universal/plugin.js"),
    cursor: () => import("./cursor/plugin.js"),  // NEW
  };
  ```

- [x] **Create `src/harnesses/cursor/` directory** with initial structure:
  - `plugin.ts` - main harness plugin implementation
  - `loader.ts` - subagent template loader and renderer
  - `skills/` - directory for Cursor-local skills
  - `5x-orchestrator.mdc` - orchestrator rule template
  - `5x-plan-author.md` - plan author subagent template
  - `5x-code-author.md` - code author subagent template
  - `5x-reviewer.md` - reviewer subagent template

- [x] **Implement `src/harnesses/cursor/plugin.ts`**
  ```typescript
  const cursorPlugin: HarnessPlugin = {
    name: "cursor",
    description: "Install 5x skills, subagents, and orchestrator rule for Cursor",
    supportedScopes: ["project", "user"],
    locations: cursorLocationResolver,
    
    describe(scope?: HarnessScope): HarnessDescription {
      const skillNames = listSkillNames();
      const agentNames = listAgentTemplates().map((t) => t.name);
      
      // Scope-aware rule support
      if (scope === "user") {
        return {
          skillNames,
          agentNames,
          ruleNames: [],
          capabilities: { rules: false },
        };
      }
      
      // Project scope (or default): rules supported
      return {
        skillNames,
        agentNames,
        ruleNames: ["5x-orchestrator"],
        capabilities: { rules: true },
      };
    },

    async install(ctx: HarnessInstallContext): Promise<HarnessInstallResult> {
      const locations = cursorLocationResolver.resolve(
        ctx.scope,
        ctx.projectRoot,
        ctx.homeDir,
      );

      // Install skills (both scopes)
      const skills = installSkillFiles(
        locations.skillsDir,
        listSkills(),
        ctx.force,
      );

      // Render and install subagents (both scopes)
      const agentTemplates = renderAgentTemplates({
        authorModel: ctx.config.authorModel,
        reviewerModel: ctx.config.reviewerModel,
      });
      const agents = installAgentFiles(
        locations.agentsDir,
        agentTemplates,
        ctx.force,
      );

      // Install rules (project scope only)
      if (ctx.scope === "project" && locations.rulesDir) {
        const rules = installRuleFiles(
          locations.rulesDir,
          [{ name: "5x-orchestrator", content: RULE_TEMPLATE }],
          ctx.force,
        );
        return { skills, agents, rules };
      }

      // User scope: rules are unsupported
      return {
        skills,
        agents,
        unsupported: { rules: true },
        warnings: [
          "Cursor user rules are settings-managed and not file-backed. " +
          "Install with --scope project to add the orchestrator rule to your project."
        ],
      };
    },

    async uninstall(ctx: HarnessUninstallContext): Promise<HarnessUninstallResult> {
      const locations = this.locations.resolve(
        ctx.scope,
        ctx.projectRoot,
        ctx.homeDir,
      );
      const { skillNames, agentNames, ruleNames } = this.describe(ctx.scope);

      const skills = uninstallSkillFiles(locations.skillsDir, skillNames);
      const agents = uninstallAgentFiles(locations.agentsDir, agentNames);

      if (ctx.scope === "project" && locations.rulesDir && ruleNames?.length) {
        const rules = uninstallRuleFiles(locations.rulesDir, ruleNames);
        return { skills, agents, rules };
      }

      return {
        skills,
        agents,
        unsupported: { rules: true },
      };
    },
  };
  ```

- [x] **Add unit tests** in `test/unit/harnesses/cursor.test.ts`
  - Project scope resolves to `.cursor/skills/`, `.cursor/agents/`, `.cursor/rules/`
  - User scope resolves to `~/.cursor/skills/`, `~/.cursor/agents/`, no `rulesDir`
  - `describe()` returns correct skills, agents, and rule names
  - `describe("user")` returns `capabilities: { rules: false }` and empty `ruleNames`
  - `describe("project")` returns `capabilities: { rules: true }` and populated `ruleNames`
  - User scope reports `rules` as unsupported in install result
  - Install result `unsupported.rules === true` when scope is user
  - List output JSON includes `capabilities` and `unsupported` fields correctly

## Phase 3: Add Cursor Rules and Subagent Renderer

**Completion gate:** Project-scope install writes a usable orchestrator rule and all three subagents; user-scope install writes all three subagents. Model injection correctly omits `model` when unset and YAML-escapes when set.

- [ ] **Add `src/harnesses/cursor/5x-orchestrator.mdc`** with Cursor rule frontmatter:
  ```markdown
  ---
  description: Use for 5x plan generation, plan review, and phased implementation workflows. Load the matching 5x skill, delegate author/reviewer work to the 5x subagents, and keep the main Cursor agent in an orchestration role.
  alwaysApply: false
  ---
  
  # 5x Orchestrator Rule
  
  You are the 5x orchestrator. You manage structured software engineering
  workflows by delegating to native Cursor subagents and guiding the human
  through decision points.
  
  ## How you work
  
  You follow **skills** — structured workflow documents that define each
  process step by step. Always load the relevant skill before starting a
  workflow:
  
  - **5x-plan**: Generate an implementation plan from a requirements doc
  - **5x-plan-review**: Run review/fix cycles on a plan until approved  
  - **5x-phase-execution**: Execute approved plan phases through author
    implementation, quality gates, and code review
  
  ## Key principles
  
  1. **Delegate, don't implement.** Render task prompts with
     `5x template render`, launch the appropriate Cursor subagent
     (`5x-plan-author`, `5x-code-author`, or `5x-reviewer`), and validate
     results with `5x protocol validate --record`.
  
  2. **Honor the effective working directory.** The rendered prompt includes
     a `## Context` block with the effective working directory. All file reads,
     edits, and shell commands must use this path as authoritative. This is
     critical for worktree-backed runs where the working directory is mapped
     to `.5x/worktrees/...`.
  
  3. **Track state.** Use `5x run state --run <id>` and
     `5x plan phases <path>` to know where a run stands before acting.
  
  4. **Guide human decisions.** When a workflow requires human input,
     present the situation with enough context for the human to decide.
  
  5. **Verify before proceeding.** After each subagent completes, check
     the result against the skill's invariants.
  
  6. **Recover gracefully.** When subagents fail or produce invalid
     results, follow the skill's recovery section. Retry once with a
     fresh subagent invocation before escalating.
  ```

- [ ] **Add `src/harnesses/cursor/5x-plan-author.md`**:
  ```markdown
  ---
  name: 5x-plan-author
  description: 5x plan author — generates implementation plans from requirements documents
  ---
  
  You are the 5x plan author. Your role is to produce or revise an
  implementation plan and output an `AuthorStatus` JSON verdict when complete.
  
  ## Your task
  
  You will receive a rendered task prompt from `5x template render`. Follow the
  instructions in that prompt exactly. When you have completed your work, output
  **only** the `AuthorStatus` JSON object as your final message.
  
  The JSON must conform to this schema:
  
  ```json
  {
    "result": "complete" | "needs_human" | "failed",
    "commit": "<git commit hash — required when result is complete>",
    "reason": "<required if result is needs_human or failed; brief explanation>",
    "notes": "<optional additional context>"
  }
  ```
  
  ## Important
  
  You **must** commit all changes using `5x commit` before reporting `result: "complete"`.
  Use `5x commit --run {{run_id}} -m "<descriptive message>" --all-files` to commit.
  The `commit` field must contain the full SHA from that commit.
  
  ## Working Directory
  
  The rendered prompt includes a `## Context` block with the effective working
  directory. Treat this path as authoritative for all file operations. This is
  essential for worktree runs where the working directory is mapped outside the
  main checkout.
  ```

- [ ] **Add `src/harnesses/cursor/5x-code-author.md`** and **`src/harnesses/cursor/5x-reviewer.md`** with similar structure adapted from OpenCode templates

- [ ] **Implement `src/harnesses/cursor/loader.ts`** with Cursor-specific rendering:
  ```typescript
  import codeAuthorRaw from "./5x-code-author.md" with { type: "text" };
  import planAuthorRaw from "./5x-plan-author.md" with { type: "text" };
  import reviewerRaw from "./5x-reviewer.md" with { type: "text" };

  const AGENT_TEMPLATES = [
    { name: "5x-reviewer", role: "reviewer", rawContent: reviewerRaw },
    { name: "5x-plan-author", role: "author", rawContent: planAuthorRaw },
    { name: "5x-code-author", role: "author", rawContent: codeAuthorRaw },
  ];

  function yamlQuote(value: string): string {
    return (
      '"' +
      value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r") +
      '"'
    );
  }

  function injectModel(raw: string, model: string | undefined): string {
    if (!model) return raw;
    return raw.replace(/^(---\r?\n)/, `$1model: ${yamlQuote(model)}\n`);
  }

  export function renderAgentTemplates(config: {
    authorModel?: string;
    reviewerModel?: string;
  }): Array<{ name: string; content: string }> {
    return AGENT_TEMPLATES.map((tmpl) => {
      let model: string | undefined;
      if (tmpl.role === "author") {
        model = config.authorModel?.trim() || undefined;
      } else if (tmpl.role === "reviewer") {
        model = config.reviewerModel?.trim() || undefined;
      }
      const content = injectModel(tmpl.rawContent, model);
      return { name: tmpl.name, content };
    });
  }
  ```

- [ ] **Add unit tests** in `test/unit/harnesses/cursor-loader.test.ts`
  - Omits `model` frontmatter field when unset
  - YAML-escapes configured `model` values containing `:`, `"`, `\`, and newlines
  - Correctly injects author model into author subagents
  - Correctly injects reviewer model into reviewer subagent

## Phase 4: Cursor Skills via Shared Base Templates

**Completion gate:** Cursor installs skills rendered from shared base templates (no per-harness skill copies), with Cursor-native terminology while preserving all 5x workflow behavior and protocol invariants.

- [ ] **Use shared base skill templates as the source of truth**
  - Do not copy `src/harnesses/opencode/skills/*/SKILL.md` into a Cursor-local tree
  - Render all four base skills from `src/skills/base/*/SKILL.tmpl.md` via shared loader APIs
  - Use native delegation mode: `renderAllSkillTemplates({ native: true })`

- [ ] **Adapt only terminology for Cursor after native render**
  - Keep base template logic and invariant text shared across harnesses
  - Apply a lightweight Cursor terminology substitution pass (best fit for current renderer, which supports `native`/`invoke` but not harness-specific conditionals):
    - "Task tool" / `subagent_type` → Cursor subagent invocation wording
    - `task_id` → "agent session ID" / resumable session wording
  - Keep workflow steps, validation calls, and recovery behavior unchanged

- [ ] **Wire Cursor skill loading to shared loader output**
  - Cursor harness/plugin skill install path should consume shared rendered skills, not local `src/harnesses/cursor/skills/*` files
  - Any Cursor wording adaptation should be applied to the rendered shared-skill content before install

- [ ] **Add minimal template deltas only if substitution is insufficient**
  - If specific lines cannot be safely transformed by substitution, add small conditional edits to `src/skills/base/*/SKILL.tmpl.md` while preserving OpenCode and Universal behavior

- [ ] **Update unit tests** in `test/unit/harnesses/cursor-skills.test.ts`
  - All four skills load from shared template pipeline
  - Cursor wording is present (Cursor subagent/session terminology)
  - OpenCode-only wording (`Task tool`, raw `task_id` usage) is not present in Cursor-rendered skills
  - Skill frontmatter remains valid after render + adaptation

## Phase 5: Documentation and UX Polish

**Completion gate:** Users can install and use the Cursor harness without reading source code. Install output clearly distinguishes skills, agents, and rules with appropriate warnings for user-scope limitations.

- [ ] **Update `README.md`** with Cursor harness install instructions:
  - Add Cursor to the list of supported harnesses
  - Document `5x harness install cursor --scope project` and `--scope user`
  - Add "how to start a 5x workflow in Cursor" section
  - Document the user-scope limitation for rules
  - Document that project-scope harness install requires `5x init` first

- [ ] **Update `printInstallSummary()`** in `src/commands/harness.handler.ts` to:
  - Print rule installation results when present
  - Print warnings array from install result
  - For Cursor user scope, explicitly state: "Note: Cursor user rules are settings-managed. Install with --scope project to add the orchestrator rule."

- [ ] **Update `buildHarnessListData()`** in `src/commands/harness.handler.ts`:
  - Check for rule files (`.mdc`) in `rulesDir` when present
  - Include `rules/` prefix in file listings
  - Include `unsupported` field in JSON output when harness reports it

- [ ] **Ensure `harness list` readable output** shows:
  - Skills: `skills/5x/SKILL.md`, etc.
  - Agents: `agents/5x-reviewer.md`, etc.
  - Rules: `rules/5x-orchestrator.mdc` (project scope only for Cursor)
  - For user scope: "rules: unsupported (Cursor user rules are settings-managed)"

- [ ] **Add integration tests** in `test/integration/commands/harness.test.ts`:
  - `5x harness install cursor --scope project` writes `.cursor/skills/`, `.cursor/agents/`, `.cursor/rules/`
  - `5x harness install cursor --scope user` writes `~/.cursor/skills/` and `~/.cursor/agents/`, not rules
  - `5x harness list` shows correct installed state for both scopes
  - `5x harness uninstall cursor --scope project` removes all assets
  - User scope install reports rules as unsupported

## Files Touched

| File | Change |
|------|--------|
| `src/harnesses/types.ts` | Add optional `rulesDir`, `ruleNames`, `rules`, `unsupported`, `warnings`, `capabilities` to plugin contract; add optional `scope` parameter to `describe()` |
| `src/harnesses/locations.ts` | Add `cursorLocationResolver` with project/user paths |
| `src/harnesses/installer.ts` | Add `installRuleFiles()` and `uninstallRuleFiles()` helpers |
| `src/harnesses/factory.ts` | Register `cursor` in `BUNDLED_HARNESSES` |
| `src/harnesses/README.md` | Document optional rule support in plugin contract |
| `src/commands/harness.handler.ts` | Include rules in install/list/uninstall flows; print warnings |
| `src/harnesses/cursor/plugin.ts` | New bundled Cursor harness plugin |
| `src/harnesses/cursor/loader.ts` | New Cursor subagent template loader with YAML-safe model injection |
| `src/harnesses/cursor/5x-orchestrator.mdc` | New Cursor project rule with orchestrator guidance |
| `src/harnesses/cursor/5x-plan-author.md` | New Cursor subagent template |
| `src/harnesses/cursor/5x-code-author.md` | New Cursor subagent template |
| `src/harnesses/cursor/5x-reviewer.md` | New Cursor subagent template |
| `src/skills/base/*/SKILL.tmpl.md` | Optional minor Cursor wording conditionals only if substitution pass is insufficient |
| `README.md` | Document Cursor harness install and usage |
| `test/unit/harnesses/cursor.test.ts` | Cursor resolver/plugin/loader coverage |
| `test/unit/harnesses/cursor-skills.test.ts` | Shared-template Cursor skill rendering + terminology adaptation coverage |
| `test/unit/harnesses/cursor-loader.test.ts` | Model injection and YAML escaping tests |
| `test/unit/harnesses/installer.test.ts` | Rule install/uninstall helper tests |
| `test/unit/commands/harness.test.ts` | Rules-aware handler coverage |
| `test/integration/commands/harness.test.ts` | Cursor install/list/uninstall integration tests |

## Tests

| Type | Scope | File | Validates |
|------|-------|------|-----------|
| Unit | Harness | `test/unit/harnesses/cursor.test.ts` | Location resolution, plugin describe(scope), install/uninstall summaries, unsupported rules reporting, capabilities metadata |
| Unit | Harness | `test/unit/harnesses/cursor-skills.test.ts` | Shared-template skill rendering, Cursor terminology adaptation, frontmatter validity |
| Unit | Harness | `test/unit/harnesses/cursor-loader.test.ts` | Model omission when unset, YAML escaping for special characters |
| Unit | Harness | `test/unit/harnesses/installer.test.ts` | Rule file install/uninstall, directory cleanup |
| Unit | Commands | `test/unit/commands/harness.test.ts` | Scope-aware list output, capabilities/unsupported JSON schema, warning display, regression coverage |
| Integration | Commands | `test/integration/commands/harness.test.ts` | Full install/list/uninstall workflow for both scopes |
| Integration | E2E | Manual | Cursor IDE/CLI discovery (macOS/Linux/Windows), worktree editing verification |

## Not In Scope

- Cursor Marketplace or plugin packaging in v1
- A separate `cursor-cli` or `cursor-ide` harness name
- New 5x protocol schemas, DB tables, or run-state semantics
- Replacing the OpenCode harness or refactoring all harnesses into a new shared prompt system
- Direct filesystem installation of Cursor user rules (not documented as file-backed)
- Cloud Agent-specific workflow changes in v1
- Cursor hooks support in v1
- Automatic rule invocation UX (manual `@rule-name` documentation deferred until verified)

## Estimated Timeline

| Phase | Duration | Work |
|-------|----------|------|
| Phase 0 | 0.5-1 day | Verify Cursor discovery assumptions before implementation |
| Phase 1 | 1-2 days | Add optional rule support to harness framework |
| Phase 2 | 1-2 days | Add Cursor location resolver and plugin shell |
| Phase 3 | 2-3 days | Add orchestrator rule, subagent templates, and renderer |
| Phase 4 | 2-3 days | Add Cursor skills via shared templates + native terminology |
| Phase 5 | 1-2 days | Documentation, UX polish, integration tests |
| **Total** | **7.5-13 days** | |

## Manual Verification Checklist

Before marking complete, manually verify:

- [ ] `.cursor/rules/`, `.cursor/skills/`, and `.cursor/agents/` are discovered in Cursor IDE on macOS/Linux
- [ ] `~/.cursor/skills/` and `~/.cursor/agents/` are discovered in Cursor IDE and CLI
- [ ] Cursor IDE discovers the installed project rule, skills, and subagents
- [ ] Cursor CLI discovers the same project rule, skills, and subagents
- [ ] A prompt like "Use 5x to generate a plan from `docs/...`" loads the orchestrator rule
- [ ] A phase execution workflow can delegate to `5x-code-author` and `5x-reviewer`
- [ ] `5x protocol validate` works correctly with Cursor subagent outputs
- [ ] User-scope install works globally for skills and subagents
- [ ] A real `5x run init --worktree` run produces a mapped worktree, Cursor author edits files there, and `5x diff --run` shows the diff in the mapped worktree

## Revision History

### v1.2 (March 24, 2026) — Plan 028 alignment

- Updated Phase 4 to use the shared skill-template system introduced by plan 028 (`renderAllSkillTemplates({ native: true })`) instead of copying OpenCode SKILL.md files into `src/harnesses/cursor/skills/`
- Switched Cursor skill customization strategy to lightweight Cursor terminology substitution over shared rendered content (with optional minimal base-template edits only if required)
- Updated Phase 2 bundled harness snippet to include `universal` alongside `opencode` and `cursor`
- Removed per-harness Cursor skill-copy files from Files Touched and aligned skill-test expectations with shared-template rendering

### v1.1 (March 23, 2026) — Review revisions

- Added Phase 0 verification gate with explicit human-gated vs automated verification items (P0.1)
- Defined scope-aware contract: `describe(scope?)` returns `capabilities` metadata for `harness list` to show `rules: unsupported` (P0.2)
- Added Windows verification to manual checklist (P1.1)
- Added explicit unit-test expectations for unsupported/rules JSON schema in `test/unit/commands/harness.test.ts` (P2)
- Updated file tables and timeline to reflect Phase 0 addition

### v1.0 (March 23, 2026) — Initial plan

- Created from PRD docs/027-cursor-harness-native-workflows.prd.md v0.2
- Organized into 5 phases with clear completion gates
- Specified all file changes with code snippets for non-trivial interfaces
- Included test coverage plan for unit and integration tests
- Added manual verification checklist for pre-ship validation
