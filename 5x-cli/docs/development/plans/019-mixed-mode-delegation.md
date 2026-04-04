# Mixed-Mode Delegation for Native Harnesses

**Version:** 1.1
**Created:** April 4, 2026
**Revised:** April 4, 2026
**Status:** Draft

## Overview

Native harness orchestrators (OpenCode, Cursor) currently delegate both
author and reviewer work via native subagents — the orchestrator renders a
prompt with `5x template render`, launches a subagent via the harness's Task
tool, and validates the result with `5x protocol validate`. This bypasses the
`5x invoke` path entirely.

There are cases where a user wants to orchestrate from within a native harness
but invoke one role (typically the author) via `5x invoke` because the desired
model is unsupported by the harness. For example: authoring with Codex via
`5x invoke` while reviewing natively in OpenCode with Claude.

Today this is impossible because `native` is a binary, harness-wide flag.
Skills render with either all-native delegation blocks or all-invoke blocks.
There is no per-role granularity.

This plan introduces **per-role delegation mode** — a config-driven mechanism
that allows each role (author, reviewer) to independently use native delegation
or `5x invoke` delegation within a single native harness installation.

## Goals

- Users can configure `delegationMode = "invoke"` on `[author]` or
  `[reviewer]` in `5x.toml` to route that role through `5x invoke` even when
  running under a native harness.
- Skills render with the correct delegation pattern (Task tool or `5x invoke`)
  per step, based on which role that step delegates to.
- Native agent templates are only installed for roles that use native
  delegation. Invoke-mode roles have no corresponding agent profile on disk.
- The orchestrator profile works correctly in mixed mode — it knows which
  steps use the Task tool and which use `5x invoke`.
- The existing `native: true` / `native: false` behavior is preserved as the
  default. Mixed mode is opt-in via config.

## Non-Goals

- Changing how `5x invoke` works — it already supports all roles, providers,
  and models. No changes needed.
- Changing the universal harness — it already uses `5x invoke` for everything.
- Supporting mixed mode at the individual step level (e.g. "use invoke for
  `author-next-phase` but native for `author-fix-quality`"). The granularity
  is per-role, not per-template.
- Auto-detecting which models a harness supports — the user explicitly opts in
  via config.

## Design Decisions

**Per-role `delegationMode` field on `AgentConfigSchema`.** Each role section
in `5x.toml` gains an optional `delegationMode` field with values `"native"`
(default) or `"invoke"`. The field only has effect when installed under a
native harness — the universal harness always uses invoke regardless. This
keeps the config surface minimal and the semantics clear: "for this role, how
should the native orchestrator delegate work?"

```toml
[author]
provider = "codex"
model = "o3"
delegationMode = "invoke"   # orchestrator calls 5x invoke for author steps

[reviewer]
# delegationMode defaults to "native" — orchestrator uses Task tool
model = "anthropic/claude-opus-4-6"
```

**Role-scoped conditionals in skill templates.** The existing `{{#if native}}`
/ `{{#if invoke}}` binary is replaced with a four-variable system:

- `{{#if author_native}}` / `{{#if author_invoke}}` — for author delegation blocks
- `{{#if reviewer_native}}` / `{{#if reviewer_invoke}}` — for reviewer delegation blocks
- `{{#if any_native}}` / `{{#if any_invoke}}` — for cross-cutting blocks
  (tool lists, human gates, gotchas) where the distinction is "at least one
  role is native" vs "at least one role is invoke"

**Legacy `native` and `invoke` remain strict all-native/all-invoke only.**
In mixed mode (one role native, one role invoke), `native` is `false` (because
not both roles are native) and `invoke` is `false` (because not both roles are
invoke). Mixed-mode templates must use `any_native`/`any_invoke` for cross-cutting
content, or the role-scoped conditionals for role-specific content. This
eliminates ambiguity: `native` means "universal native harness" (the historical
all-Task-tool path), `invoke` means "universal harness" (the all-5x-invoke path),
and mixed mode uses the new per-role and any-role flags.

Each delegation step in the skill templates already maps unambiguously to a
single role, so the refactoring is mechanical: replace `{{#if native}}` with
the role-specific variant around each delegation code block.

**Conditional agent template installation.** When `author.delegationMode` is
`"invoke"`, the author agent templates (`5x-plan-author`, `5x-code-author`)
are not installed — `5x invoke` handles provider selection and prompting
externally, so no agent profile is needed. Similarly, if
`reviewer.delegationMode` is `"invoke"`, `5x-reviewer` is not installed. The
orchestrator profile is always installed (it has no role).

**`SkillRenderContext` expansion.** The `SkillRenderContext` type in
`src/skills/renderer.ts` expands from `{ native: boolean }` to carry per-role
flags and any-role flags. The renderer gains new directive support while
retaining backward compatibility with the existing `{{#if native}}` /
`{{#if invoke}}` syntax.

```ts
export interface SkillRenderContext {
  /** Legacy: true only when both roles are native (strict all-native). */
  native: boolean;
  /** Legacy inverse: true only when both roles are invoke (strict all-invoke). */
  invoke: boolean;
  /** Per-role delegation: true = Task tool, false = 5x invoke. */
  authorNative: boolean;
  reviewerNative: boolean;
  /** Cross-cutting: true when at least one role is native/invoke. */
  anyNative: boolean;
  anyInvoke: boolean;
}
```

**Harness skill loaders resolve mixed context from config.** During
`5x harness install`, each native harness's skill loader reads
`delegationMode` from the resolved config for each role and constructs the
appropriate `SkillRenderContext`. When both roles are native (the default),
the behavior is identical to today.

## Phase 1: Config, Render Context, and Call-Site Updates

**Completion gate:** `delegationMode` is parsed from `5x.toml`, exposed on
the config type, `SkillRenderContext` carries per-role and any-role flags, and
**all call sites that construct `SkillRenderContext` are updated** to pass the
new required fields. Unit tests cover config parsing and the new render context
derivation.

- [ ] Add `delegationMode` to `AgentConfigSchema` in `src/config.ts`:
      ```ts
      delegationMode: z.enum(["native", "invoke"]).default("native"),
      ```
      This makes `delegationMode` available on both `config.author` and
      `config.reviewer` with a default of `"native"`.
- [ ] Add a helper `resolveDelegationContext(config: FiveXConfig)` in
      `src/config.ts` that returns:
      ```ts
      {
        native: boolean;        // strict all-native
        invoke: boolean;        // strict all-invoke
        authorNative: boolean;
        reviewerNative: boolean;
        anyNative: boolean;
        anyInvoke: boolean;
      }
      ```
      Where `native = authorNative && reviewerNative`, `invoke = !authorNative &&
      !reviewerNative`, `anyNative = authorNative || reviewerNative`,
      `anyInvoke = !authorNative || !reviewerNative`. This is the bridge
      between config and the render context.
- [ ] Expand `SkillRenderContext` in `src/skills/renderer.ts`:
      ```ts
      export interface SkillRenderContext {
        /** Legacy: true only when both roles are native. */
        native: boolean;
        /** Legacy: true only when both roles are invoke. */
        invoke: boolean;
        /** Per-role delegation: true = Task tool, false = 5x invoke. */
        authorNative: boolean;
        reviewerNative: boolean;
        /** Cross-cutting: true when at least one role is native/invoke. */
        anyNative: boolean;
        anyInvoke: boolean;
      }
      ```
      For backward compatibility, `native` is `true` only when both
      `authorNative` and `reviewerNative` are `true`. `invoke` is `true` only
      when both are `false`.
- [ ] **Update all `SkillRenderContext` call sites:** The interface now has 6
      required fields. Update all existing call sites to pass complete context:
      - `src/harnesses/universal/plugin.ts`: Update `renderToRaw()` calls to
        pass the new context fields (universal harness always uses invoke-only
        context: `native: false, invoke: true, authorNative: false,
        reviewerNative: false, anyNative: false, anyInvoke: true`).
      - `src/harnesses/opencode/skills/loader.ts`: Update `listSkills()` and
        `getDefaultSkillRaw()` to accept optional context parameter (Phase 5
        will pass resolved config; default remains all-native for backward
        compatibility).
      - `src/harnesses/cursor/skills/loader.ts`: Same as OpenCode loader.
      - `test/unit/skills/renderer.test.ts`: Update all test fixtures that
        construct `SkillRenderContext` to include the new fields.
      - Any other call sites discovered during implementation.
- [ ] Add unit tests in `test/unit/config.test.ts`:
      - Default config has `delegationMode: "native"` for both roles.
      - Explicit `delegationMode: "invoke"` on author is parsed correctly.
      - `resolveDelegationContext` returns correct flags for all
        combinations (native/native, invoke/native, native/invoke,
        invoke/invoke).
      - `native` is true only for native/native; `invoke` is true only for
        invoke/invoke; `anyNative`/`anyInvoke` are correct for all modes.
- [ ] Add unit tests in `test/unit/skills/renderer.test.ts`:
      - Verify the new context type is accepted by `renderSkillTemplate`.
      - Verify `native` is only `true` when both roles are native.
      - Verify `invoke` is only `true` when both roles are invoke.
      - Verify `anyNative` is `true` when at least one role is native.
      - Verify `anyInvoke` is `true` when at least one role is invoke.

## Phase 2: Renderer Support for Role-Scoped Conditionals

**Completion gate:** The skill template renderer supports `{{#if author_native}}`,
`{{#if author_invoke}}`, `{{#if reviewer_native}}`, `{{#if reviewer_invoke}}`,
`{{#if any_native}}`, `{{#if any_invoke}}` directives alongside the existing
`{{#if native}}` / `{{#if invoke}}`. Unit tests cover all directive combinations.

- [ ] Extend `renderSkillTemplate()` in `src/skills/renderer.ts` to recognize
      the new directives:
      - `{{#if author_native}}` → active when `ctx.authorNative` is true.
      - `{{#if author_invoke}}` → active when `ctx.authorNative` is false.
      - `{{#if reviewer_native}}` → active when `ctx.reviewerNative` is true.
      - `{{#if reviewer_invoke}}` → active when `ctx.reviewerNative` is false.
      - `{{#if any_native}}` → active when `ctx.anyNative` is true (at least one
        role is native).
      - `{{#if any_invoke}}` → active when `ctx.anyInvoke` is true (at least one
        role is invoke).
      - Existing `{{#if native}}` / `{{#if invoke}}` remain unchanged —
        `native` is true **only when both roles are native**; `invoke` is true
        **only when both are invoke**. These are strict all-native/all-invoke
        indicators for backward compatibility.
      - `{{else}}` and `{{/if}}` work the same as today.
      - Nesting remains unsupported (consistent with current design).
- [ ] Add unit tests in `test/unit/skills/renderer.test.ts`:
      - `{{#if author_native}}` includes block when author is native.
      - `{{#if author_invoke}}` includes block when author is invoke.
      - Same for reviewer variants.
      - `{{#if any_native}}` includes block when at least one role is native.
      - `{{#if any_invoke}}` includes block when at least one role is invoke.
      - Mixed mode: `author_invoke` + `reviewer_native` renders correct
        blocks for each role.
      - `{{#if native}}` only active when both roles are native.
      - `{{#if invoke}}` only active when both roles are invoke (i.e. the
        universal harness case).
      - In mixed mode, both `native` and `invoke` are false.
      - `{{else}}` flips correctly for all new directives.
      - Error on unknown directive (e.g. `{{#if foo}}`).

## Phase 3: Skill Template Refactoring

**Completion gate:** All skill templates use role-scoped conditionals for
delegation blocks. Cross-cutting blocks use `{{#if any_native}}` or
`{{#if any_invoke}}` as appropriate. Rendering produces correct output for
all four delegation mode combinations. Existing tests still pass.

This is the largest phase — each `{{#if native}}` block in the skill
templates must be audited and either kept (strict all-native, for backward
compatibility), replaced with the role-specific variant, or replaced with
`any_native`/`any_invoke` for cross-cutting content.

- [ ] Refactor `src/skills/base/5x/SKILL.tmpl.md` (foundation skill):
      - **"Delegating to Subagents" section:** This section currently renders
        entirely under `{{#if native}}` or `{{else}}` (invoke). In mixed
        mode, use `{{#if any_native}}` to show the Task tool pattern when at
        least one role is native, and `{{#if any_invoke}}` to show the
        `5x invoke` pattern when at least one role is invoke. This makes both
        patterns visible to the orchestrator in mixed mode.
      - **"Task Reuse" / "Session Reuse" sections:** Use `{{#if any_native}}`
        for task reuse (applies to whichever roles are native). Use
        `{{#if author_invoke}}` and `{{#if reviewer_invoke}}` for
        invoke-side session reuse in mixed mode.
      - **Gotchas:** Most gotchas are role-neutral (commit invariant, config
        limits) and can stay under `{{#if any_native}}` (they apply whenever
        native delegation is in use). Role-specific recovery advice should use
        role-scoped conditionals.
- [ ] Refactor `src/skills/base/5x-phase-execution/SKILL.tmpl.md`:
      - **Step 1 (Author implements):** Replace `{{#if native}}` with
        `{{#if author_native}}` and `{{else}}` (author invoke path).
      - **Step 2a (Quality retry — author fix):** Same — replace with
        `{{#if author_native}}`.
      - **Step 3 (Code review):** Replace `{{#if native}}` with
        `{{#if reviewer_native}}` and `{{else}}` (reviewer invoke path).
      - **Step 5 (Author fixes review items):** Replace with
        `{{#if author_native}}`.
      - **Tools section:** The tools list currently shows
        `5x protocol validate` under native and `5x invoke` under invoke.
        In mixed mode, both tools are used. Show `5x protocol validate`
        gated on `{{#if any_native}}` (at least one native role) and
        `5x invoke` gated on `{{#if any_invoke}}` (at least one invoke role).
      - **Task reuse / Session reuse sections:** Task reuse applies to the
        reviewer when native (the main reuse scenario). Session reuse
        applies to the reviewer when invoke. Use `{{#if reviewer_native}}`
        and `{{#if reviewer_invoke}}`.
      - **Step tracking variables:** In mixed mode, the orchestrator tracks
        both `$REVIEWER_TASK_ID` (for native reviewer) or `$SESSION_ID`
        (for invoke reviewer). Gate each variable intro on
        `{{#if reviewer_native}}` / `{{#if reviewer_invoke}}`.
      - **Recovery / Gotchas:** Role-specific recovery advice (fresh task
        vs omit session) uses the role-scoped conditional matching the
        role it refers to.
      - **Escalation steps (5a, phase gate):** These are orchestrator-level
        human gates, not role delegation. Use `{{#if any_native}}` since
        they apply whenever native delegation is in use.
- [ ] Refactor `src/skills/base/5x-plan/SKILL.tmpl.md`:
      - **Step 2 (Generate the plan):** Author delegation — replace with
        `{{#if author_native}}`.
      - **Gotchas and Recovery:** Use role-scoped conditionals where the
        advice references a specific role's retry mechanism.
      - **Cross-cutting guidance:** Use `{{#if any_native}}` for content
        that applies whenever native delegation is in use.
- [ ] Refactor `src/skills/base/5x-plan-review/SKILL.tmpl.md`:
      - **Step 1 (Review):** Reviewer delegation — replace with
        `{{#if reviewer_native}}`.
      - **Delegating sub-agent work example section:** This section shows
        the reviewer delegation pattern. Replace with
        `{{#if reviewer_native}}`.
      - **Step 3 (Author fix):** Author delegation — replace with
        `{{#if author_native}}`.
      - **Tracking variables and session/task reuse:** Gate reviewer task
        reuse on `{{#if reviewer_native}}`, author session reuse on
        `{{#if author_invoke}}` where applicable.
      - **Escalation (Step 4):** Orchestrator-level, use `{{#if any_native}}`.
- [ ] Add unit tests that render each skill template with all
      four context combinations (native/native, invoke/native, native/invoke,
      invoke/invoke) and verify:
      - No unclosed or unmatched directives.
      - Author delegation blocks use the correct pattern for each mode.
      - Reviewer delegation blocks use the correct pattern for each mode.
      - The invoke/invoke output matches the current `{ native: false }`
        output (backward compatibility).
      - The native/native output matches the current `{ native: true }`
        output (backward compatibility).

## Phase 4: Conditional Agent Template Installation

**Completion gate:** `5x harness install` only installs agent templates for
roles that use native delegation. When `author.delegationMode` is `"invoke"`,
author agent profiles are not written to disk. The orchestrator profile is
always installed. `describe()` remains a static bundled inventory; uninstall
removes all managed assets regardless of current configuration.

**Asset ownership model:** Agent templates are managed assets — files written
by `install()` that must be removed by `uninstall()`. The plugin contract is:

- `describe()` returns the **static bundled inventory** (all templates that
  could be installed, not filtered by config). It has no config input.
- `harness list` and `5x harness show` use `describe()` to show what the plugin
  can install.
- **Install-time state** determines what actually gets written to disk (filtered
  by delegation mode).
- **Uninstall removes all managed assets** by enumerating files on disk (not
  by re-running `describe()` or re-reading config). This ensures stale assets
  are cleaned up even if config changed after installation.

- [ ] Extend `AgentRenderConfig` in `src/harnesses/opencode/loader.ts` to
      accept delegation mode flags:
      ```ts
      export interface AgentRenderConfig {
        authorModel?: string;
        reviewerModel?: string;
        /** When true, skip author agent templates (author uses 5x invoke). */
        authorInvoke?: boolean;
        /** When true, skip reviewer agent template (reviewer uses 5x invoke). */
        reviewerInvoke?: boolean;
      }
      ```
- [ ] Update `renderAgentTemplates()` in `src/harnesses/opencode/loader.ts`
      to filter out templates whose role matches an invoke-mode flag:
      - Skip `role: "author"` templates when `config.authorInvoke` is true.
      - Skip `role: "reviewer"` template when `config.reviewerInvoke` is true.
      - Always include `role: null` (orchestrator).
      - **Do not change `describe()`** — it continues to return all bundled
        templates. The filtering happens at render/write time.
- [ ] Apply the same changes to `src/harnesses/cursor/loader.ts` (the Cursor
      agent loader has the same `AgentRenderConfig` / `renderAgentTemplates`
      pattern).
- [ ] Update `HarnessInstallContext` in `src/harnesses/types.ts` to carry
      delegation mode:
      ```ts
      config: {
        authorModel?: string;
        reviewerModel?: string;
        authorDelegationMode?: "native" | "invoke";
        reviewerDelegationMode?: "native" | "invoke";
      };
      ```
- [ ] Update the harness install handler (`src/commands/harness.handler.ts`
      or equivalent) to read `delegationMode` from config and pass it through
      `HarnessInstallContext.config`.
- [ ] Update `opencodePlugin.install()` in
      `src/harnesses/opencode/plugin.ts` to pass the delegation flags to
      `renderAgentTemplates()`.
- [ ] Update `cursorPlugin.install()` in `src/harnesses/cursor/plugin.ts`
      similarly.
- [ ] **Do not change `describe()` behavior** — it remains a static bundled
      inventory. If the plan previously suggested config-aware `describe()`,
      remove that requirement. The contract is:
      - `describe()` returns static inventory.
      - `install()` writes files conditionally based on delegation mode.
      - `uninstall()` removes all files by enumerating the install directory.
- [ ] Add unit tests:
      - `renderAgentTemplates` with `authorInvoke: true` returns only
        reviewer + orchestrator.
      - `renderAgentTemplates` with `reviewerInvoke: true` returns only
        author agents + orchestrator.
      - `renderAgentTemplates` with both invoke flags returns only
        orchestrator.
      - Default behavior (no invoke flags) returns all templates (backward
        compatibility).
      - `install()` with `authorDelegationMode: "invoke"` does not write
        author agent files.
      - `uninstall()` removes all files in the managed directory regardless
        of current config.

## Phase 5: Harness Skill Loader Integration

**Completion gate:** Native harness skill loaders read `delegationMode` from
config and construct the correct `SkillRenderContext`. Skills installed by
`5x harness install` contain the appropriate delegation patterns for the
configured mode.

- [ ] Update `src/harnesses/opencode/skills/loader.ts`:
      - `listSkills()` and `getDefaultSkillRaw()` currently hardcode
        `{ native: true }`. Change them to accept an optional
        `SkillRenderContext` or delegation config, defaulting to all-native
        for backward compatibility.
      - When called from the install path, pass the resolved per-role
        context.
- [ ] Update `src/harnesses/cursor/skills/loader.ts`:
      - `listSkills()` currently hardcodes `{ native: true }`. Change to
        accept optional context. The `adaptCursorTerminology()` post-
        processing should still apply to native-rendered blocks (it
        replaces "Task tool" → "Cursor subagent invocation", etc.).
        For invoke-rendered blocks, the terminology is already correct
        (they reference `5x invoke` directly). Verify that
        `adaptCursorTerminology` does not corrupt invoke-path content.
- [ ] Update `opencodePlugin.install()` to resolve `SkillRenderContext`
      from the delegation config and pass it through the skill loader.
- [ ] Update `cursorPlugin.install()` similarly.
- [ ] Add integration tests:
      - Install with `author.delegationMode = "invoke"`: verify installed
        skill files contain `5x invoke` for author steps and Task tool
        for reviewer steps.
      - Install with default config: verify output matches current behavior.

## Phase 6: Orchestrator Profile Updates

**Completion gate:** The orchestrator agent profiles for OpenCode and Cursor
acknowledge mixed delegation and guide the orchestrator correctly when some
roles use `5x invoke`.

- [ ] Update `src/harnesses/opencode/5x-orchestrator.md`:
      - Add a note under "Key principles" or a new section explaining that
        when some roles are configured for invoke delegation, the skill
        templates will contain `5x invoke` blocks for those roles instead
        of Task tool delegation. The orchestrator should follow the skill's
        delegation pattern for each step.
      - The orchestrator should expect that invoke-mode steps return a JSON
        envelope on stdout (the `5x invoke` output format) rather than raw
        subagent output.
- [ ] Update `src/harnesses/cursor/5x-orchestrator.mdc` with the same
      mixed-mode awareness.
- [ ] These changes are static content updates — no conditional rendering
      needed in the orchestrator profiles themselves, since the skills
      already encode the correct delegation pattern per step.
- [ ] Verify by manually inspecting the rendered orchestrator + skill
      combination for each mode.

## Risks and Mitigations

**Skill template complexity.** The templates will have more conditional blocks.
Mitigation: the refactoring is mechanical (each block already maps to one
role), and Phase 3 includes backward-compatibility tests that verify the
native/native and invoke/invoke outputs are unchanged.

**Cursor terminology adaptation.** The `adaptCursorTerminology()` function
does string replacements that could corrupt invoke-path content if it matches
patterns that appear in `5x invoke` blocks. Mitigation: Phase 5 includes a
verification step. The invoke blocks use `5x invoke` (not "Task tool") so
the existing replacements should not match.

**Orchestrator confusion in mixed mode.** The orchestrator may not correctly
distinguish between "run `5x invoke` and parse stdout" vs "launch subagent
and read result." Mitigation: the skills encode explicit code blocks for each
pattern — the orchestrator follows the skill, not a general principle. Phase 6
adds explicit guidance.

**Renderer directive proliferation.** Six directive types (native, invoke,
author_native, author_invoke, reviewer_native, reviewer_invoke) plus else/endif.
Mitigation: the nesting prohibition keeps the parser simple. A future iteration
could introduce expression syntax (`{{#if author.native}}`) but that is not
needed now.

## Revision History

**Version 1.1 (April 4, 2026)** — Revision addressing review feedback from
`/docs/development/reviews/5x-cli-docs-development-plans-019-mixed-mode-delegation-review.md`:

1. **P0.1 — Enforced strict directive semantics:** Clarified that legacy `native`
   and `invoke` are **strict all-native/all-invoke only**. In mixed mode, both
   are `false`. Cross-cutting blocks must use the new `any_native`/`any_invoke`
   directives. Removed contradictory Phase 3 wording that suggested `native`/
   `invoke` could mean "at least one role."

2. **P1.1 — Lock lifecycle contract:** Documented that `describe()` remains a
   **static bundled inventory** (returns all templates, not filtered by config).
   Install-time filtering happens at render/write. Uninstall removes all managed
   assets by filesystem enumeration, regardless of current config. This prevents
   stale assets when config changes after installation.

3. **P1.2 — Added explicit call-site updates:** Expanded Phase 1 to include
   **mechanical updates to all `SkillRenderContext` call sites**:
   - `src/harnesses/universal/plugin.ts` — universal harness context
   - `src/harnesses/opencode/skills/loader.ts` — skill loader context
   - `src/harnesses/cursor/skills/loader.ts` — skill loader context
   - `test/unit/skills/renderer.test.ts` — test fixtures and coverage

4. **P2 items:** Reclassified template rendering tests as unit tests (already
   reflected in the plan's test organization). Deferred `5x config show` text
   output for delegation mode to a future UX iteration.
