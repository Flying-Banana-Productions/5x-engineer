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
/ `{{#if invoke}}` binary is replaced with a six-variable system:

- `{{#if author_native}}` / `{{#if author_invoke}}` — for author delegation blocks
- `{{#if reviewer_native}}` / `{{#if reviewer_invoke}}` — for reviewer delegation blocks
- `{{#if any_native}}` — true when at least one role is native (for cross-cutting native-only content)
- `{{#if any_invoke}}` — true when at least one role is invoke (for cross-cutting invoke-only content)
- `{{#if all_native}}` / `{{#if all_invoke}}` — true only when both roles match (retained for backward compatibility)

Each delegation step in the skill templates already maps unambiguously to a
single role, so the refactoring is mechanical: replace `{{#if native}}` with
the role-specific variant around each delegation code block. Cross-cutting blocks
use `any_native`/`any_invoke` to appear when the relevant mode is active for
any role.

**Conditional agent template installation.** When `author.delegationMode` is
`"invoke"`, the author agent templates (`5x-plan-author`, `5x-code-author`)
are not installed — `5x invoke` handles provider selection and prompting
externally, so no agent profile is needed. Similarly, if
`reviewer.delegationMode` is `"invoke"`, `5x-reviewer` is not installed. The
orchestrator profile is always installed (it has no role).

**`SkillRenderContext` expansion.** The `SkillRenderContext` type in
`src/skills/renderer.ts` expands from `{ native: boolean }` to carry per-role
flags. The renderer gains new directive support while retaining backward
compatibility with the existing `{{#if native}}` / `{{#if invoke}}` syntax.

**Harness skill loaders resolve mixed context from config.** During
`5x harness install`, each native harness's skill loader reads
`delegationMode` from the resolved config for each role and constructs the
appropriate `SkillRenderContext`. When both roles are native (the default),
the behavior is identical to today.

## Phase 1: Config and Render Context

**Completion gate:** `delegationMode` is parsed from `5x.toml`, exposed on
the config type, and the `SkillRenderContext` type carries per-role flags.
Unit tests cover config parsing and the new render context derivation.

- [x] Add `delegationMode` to `AgentConfigSchema` in `src/config.ts`:
      ```ts
      delegationMode: z.enum(["native", "invoke"]).default("native"),
      ```
      This makes `delegationMode` available on both `config.author` and
      `config.reviewer` with a default of `"native"`.
- [x] Add a helper `resolveDelegationContext(config: FiveXConfig)` in
      `src/config.ts` that returns:
      ```ts
      { authorNative: boolean; reviewerNative: boolean }
      ```
      Where `authorNative = config.author.delegationMode !== "invoke"` and
      similarly for reviewer. This is the bridge between config and the
      render context.
- [x] Expand `SkillRenderContext` in `src/skills/renderer.ts`:
      ```ts
      export interface SkillRenderContext {
        /** Legacy backward-compatibility: true when both roles are native. */
        native: boolean;
        /** Legacy backward-compatibility: true when both roles are invoke. */
        invoke: boolean;
        /** Per-role delegation: true = Task tool, false = 5x invoke. */
        authorNative: boolean;
        reviewerNative: boolean;
        /** Cross-cutting: true when at least one role uses native delegation. */
        anyNative: boolean;
        /** Cross-cutting: true when at least one role uses invoke delegation. */
        anyInvoke: boolean;
      }
      ```
      For backward compatibility:
      - `native` is `true` only when both `authorNative` and `reviewerNative` are `true`.
      - `invoke` is `true` only when both `authorNative` and `reviewerNative` are `false`.
      - `anyNative` is `true` when either role is native (authorNative || reviewerNative).
      - `anyInvoke` is `true` when either role is invoke (!authorNative || !reviewerNative).
- [x] Add unit tests in `test/unit/config.test.ts`:
      - Default config has `delegationMode: "native"` for both roles.
      - Explicit `delegationMode: "invoke"` on author is parsed correctly.
      - `resolveDelegationContext` returns correct flags for all
        combinations (native/native, invoke/native, native/invoke,
        invoke/invoke).
- [x] Add unit tests in `test/unit/skills/renderer.test.ts`:
      - Verify the new context type is accepted by `renderSkillTemplate`.
      - Verify `native` is only `true` when both roles are native.

## Phase 2: Renderer Support for Role-Scoped Conditionals

**Completion gate:** The skill template renderer supports `{{#if author_native}}`,
`{{#if author_invoke}}`, `{{#if reviewer_native}}`, `{{#if reviewer_invoke}}`,
`{{#if any_native}}`, and `{{#if any_invoke}}` directives alongside the legacy
`{{#if native}}` / `{{#if invoke}}`. Unit tests cover all directive combinations.

- [x] Extend `renderSkillTemplate()` in `src/skills/renderer.ts` to recognize
      the new directives:
      - `{{#if author_native}}` → active when `ctx.authorNative` is true.
      - `{{#if author_invoke}}` → active when `ctx.authorNative` is false.
      - `{{#if reviewer_native}}` → active when `ctx.reviewerNative` is true.
      - `{{#if reviewer_invoke}}` → active when `ctx.reviewerNative` is false.
      - `{{#if any_native}}` → active when `ctx.anyNative` is true (at least one native role).
      - `{{#if any_invoke}}` → active when `ctx.anyInvoke` is true (at least one invoke role).
      - Legacy `{{#if native}}` / `{{#if invoke}}` remain unchanged —
        `native` is true only when both roles are native (backward compatibility);
        `invoke` is true only when both are invoke.
      - `{{else}}` and `{{/if}}` work the same as today.
      - Nesting remains unsupported (consistent with current design).
- [x] Add unit tests in `test/unit/skills/renderer.test.ts`:
      - `{{#if author_native}}` includes block when author is native.
      - `{{#if author_invoke}}` includes block when author is invoke.
      - Same for reviewer variants.
      - Mixed mode: `author_invoke` + `reviewer_native` renders correct
        blocks for each role.
      - `{{#if any_native}}` active when at least one role is native.
      - `{{#if any_invoke}}` active when at least one role is invoke.
      - `{{#if native}}` only active when both roles are native (legacy behavior).
      - `{{#if invoke}}` only active when both roles are invoke (legacy behavior).
      - `{{else}}` flips correctly for all new directives.
      - Error on unknown directive (e.g. `{{#if foo}}`).
      - Rendering with all four context combinations produces valid output
        (native/native, invoke/native, native/invoke, invoke/invoke).

## Phase 3: Skill Template Refactoring

**Completion gate:** All skill templates use role-scoped conditionals for
delegation blocks. Cross-cutting blocks use `{{#if native}}` or the new
role-scoped variants as appropriate. Rendering produces correct output for
all four delegation mode combinations. Existing tests still pass.

This is the largest phase — each `{{#if native}}` block in the skill
templates must be audited and either kept (cross-cutting) or replaced with
the role-specific variant.

- [ ] Refactor `src/skills/base/5x/SKILL.tmpl.md` (foundation skill):
      - **"Delegating to Subagents" section:** This section currently renders
        entirely under `{{#if native}}` or `{{else}}` (invoke). In mixed
        mode both patterns are needed. Split into two subsections: one for
        native delegation (Task tool pattern) gated on `{{#if any_native}}`
        (at least one role is native), and one for invoke delegation gated
        on `{{#if any_invoke}}` (at least one role is invoke). In mixed
        mode, the orchestrator needs both reference patterns visible.
      - **"Task Reuse" / "Session Reuse" sections:** Use `{{#if any_native}}`
        for task reuse content (applies to whichever roles are native). Use
        `{{#if any_invoke}}` for invoke-side session reuse content.
      - **Gotchas:** Most gotchas are role-neutral (commit invariant, config
        limits) and can stay ungated. Role-specific recovery advice (e.g.
        "start fresh task" vs "omit --session") should use role-scoped
        conditionals (`{{#if author_native}}`, `{{#if author_invoke}}`, etc.).
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
        gated on `{{#if any_native}}` (at least one native role) and `5x invoke`
        gated on `{{#if any_invoke}}` (at least one invoke role).
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
        these paths are only relevant when at least one role uses native
        delegation.
- [ ] Refactor `src/skills/base/5x-plan/SKILL.tmpl.md`:
      - **Step 2 (Generate the plan):** Author delegation — replace with
        `{{#if author_native}}`.
      - **Gotchas and Recovery:** Use role-scoped conditionals where the
        advice references a specific role's retry mechanism.
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
      - **Escalation (Step 4):** Orchestrator-level human gate, use
        `{{#if any_native}}` since this path is only relevant when at
        least one role uses native delegation.
- [ ] Add unit tests in `test/unit/skills/renderer.test.ts` that render each
      skill template with all four context combinations (native/native,
      invoke/native, native/invoke, invoke/invoke) and verify:
      - No unclosed or unmatched directives.
      - Author delegation blocks use the correct pattern for each mode.
      - Reviewer delegation blocks use the correct pattern for each mode.
      - The invoke/invoke output matches the current `{ native: false }`
        output (backward compatibility).
      - The native/native output matches the current `{ native: true }`
        output (backward compatibility).
      - Cross-cutting blocks with `{{#if any_native}}` appear when expected.
      - Cross-cutting blocks with `{{#if any_invoke}}` appear when expected.

## Phase 4: Conditional Agent Template Installation

**Completion gate:** `5x harness install` only installs agent templates for
roles that use native delegation. When `author.delegationMode` is `"invoke"`,
author agent profiles are not written to disk. The orchestrator profile is
always installed. The `describe()` method returns the static bundled asset
inventory; `harness list` reports actual installed state via filesystem
inspection. Uninstall removes all managed assets regardless of current config
to prevent orphaned files.

**Ownership model decision:** `describe()` reports the static bundled inventory
(i.e., what the plugin *can* install), not the runtime-configurable subset.
Accurate installed-state reporting for mixed-mode configurations is handled by
`harness list` via filesystem inspection of the actual agent directories.
Uninstall removes all managed assets unconditionally to ensure no stale files
remain when config changes after installation.

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
- [ ] Keep `describe()` on both plugins unchanged — it returns the static
      bundled asset inventory. The `harness list` command already inspects
      the filesystem to report what is actually installed.
- [ ] Verify that `uninstall()` on both plugins removes all managed agent
      files regardless of current config state (already the current behavior;
      confirm no regression).
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
      - `harness list` after mixed-mode install reports only installed agents
        (via filesystem inspection), not the full bundled inventory.
- [ ] Add integration tests for lifecycle transitions (P1.1 — stale-asset handling):
      - Install with native/native config, verify both author and reviewer
        agents are on disk.
      - Change config to invoke/native (author invoke, reviewer native),
        reinstall, verify author agents are removed and reviewer agents remain.
      - Change config to native/invoke, reinstall, verify reviewer agents are
        removed and author agents remain.
      - Change config to invoke/invoke, reinstall, verify only orchestrator
        remains.
      - After each transition, verify `harness list` accurately reports the
        installed state.
      - Verify `harness uninstall` removes all managed assets regardless of
        current config state (no orphaned files).

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
- [ ] Add integration tests for correct skill rendering under mixed mode:
      - Install with `author.delegationMode = "invoke"`: verify installed
        skill files contain `5x invoke` for author steps and Task tool
        for reviewer steps.
      - Install with default config: verify output matches current behavior.
- [ ] Add integration tests for lifecycle transitions (P1.1):
      - Install native/native, change config to invoke/native, reinstall,
        verify skill files now contain invoke patterns for author, native
        patterns for reviewer.
      - After config change and reinstall, verify `harness list` shows the
        current effective agents (filesystem state, not config-dependent).

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

**Renderer directive proliferation.** Eight directive types (native, invoke,
author_native, author_invoke, reviewer_native, reviewer_invoke, any_native,
any_invoke) plus else/endif.
Mitigation: the nesting prohibition keeps the parser simple. The additional
any_native/any_invoke predicates are required for cross-cutting content in
mixed mode. A future iteration could introduce expression syntax
(`{{#if author.native}}`) but that is not needed now.

## Revision History

**v1.0 → v1.1** (April 4, 2026)
- **P0.1 Fixed:** Added `any_native` and `any_invoke` predicates to
  `SkillRenderContext` and renderer directives to support cross-cutting content
  in mixed mode. Legacy `native`/`invoke` now strictly mean "both roles match"
  for backward compatibility; new `anyNative`/`anyInvoke` flags express
  "at least one role uses this delegation mode" for cross-cutting sections.
  Updated all Phase 3 template refactoring tasks to use correct predicates.
- **P0.2 Fixed:** Clarified ownership model for `describe()` and uninstall.
  `describe()` returns static bundled inventory; `harness list` uses filesystem
  inspection for accurate installed-state reporting. Uninstall removes all
  managed assets regardless of current config to prevent orphaned files when
  delegation mode changes after installation.
- **P1.1 Added:** Explicit lifecycle transition tests for config changes
  (native ↔ invoke per role) and stale-asset cleanup/reporting in Phase 4
  and Phase 5 integration test sections.
- **P2 Addressed:** Changed "integration-level tests" to "unit tests" for
  skill template rendering matrix (kept integration tests for harness
  install/uninstall filesystem assertions).
