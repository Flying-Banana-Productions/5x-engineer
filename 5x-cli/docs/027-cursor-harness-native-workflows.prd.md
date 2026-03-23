# Feature: Cursor Harness for Native 5x Workflows

**Version:** 0.2  
**Created:** March 23, 2026  
**Status:** Draft

## Overview

We need a bundled `cursor` harness that enables native 5x workflows inside both
the Cursor IDE and the `agent` CLI without splitting them into separate
environments. The key product bet is that Cursor editor and CLI already share
the same project-level assets:

- project rules under `.cursor/rules/`
- project skills under `.cursor/skills/`
- project subagents under `.cursor/agents/`

They also share the same user-scope skills and subagents under `~/.cursor/`.
That makes a single `cursor` harness the right abstraction for v1.

The existing `opencode` harness is the closest reference implementation.
Cursor should match its capabilities wherever Cursor exposes equivalent native
mechanisms, while adapting to Cursor's different architecture:

- Cursor has custom subagents, but not documented custom primary-agent profile
  files comparable to OpenCode's `mode: primary` orchestrator.
- Cursor has first-class project rules, which can act as the orchestrator layer
  for the main agent in both IDE and CLI.
- Cursor CLI does not support marketplace plugins today, so v1 should use only
  direct filesystem installs via `5x harness install cursor`.

## Goals

- Ship one bundled `cursor` harness that works for both Cursor IDE and
  `cursor-agent` CLI.
- Preserve the current 5x protocol contract: `5x template render`,
  `5x protocol validate`, run recording, quality gates, and worktree-aware
  execution remain unchanged.
- Match the OpenCode harness as closely as Cursor's platform allows.
- Install native Cursor assets that make 5x workflows discoverable and
  ergonomic: skills, subagents, and an orchestrator rule.
- Reuse current 5x model config (`[author].model`, `[reviewer].model`) for
  Cursor subagents.
- Keep installs idempotent, user-editable, listable, and uninstallable.

## Non-Goals

- Cursor Marketplace or plugin packaging in v1.
- A separate `cursor-cli` or `cursor-ide` harness name.
- New 5x protocol schemas, DB tables, or run-state semantics.
- Replacing the OpenCode harness or refactoring all harnesses into a new shared
  prompt system.
- Direct filesystem installation of Cursor user rules if Cursor does not expose
  a documented on-disk location.
- Cloud Agent-specific workflow changes in v1.

## Verified Platform Constraints

The following checks were performed against current Cursor docs on March 23,
2026. They are the basis for the v1 design.

### Verified (March 23, 2026)

- **Project rules are file-backed.** `https://cursor.com/docs/rules` documents
  project rules under `.cursor/rules/` and supports `.md` / `.mdc` files.
- **Cursor CLI uses the same project rule system.**
  `https://cursor.com/docs/cli/using` says the CLI supports the same rules
  system as the editor and reads `.cursor/rules/`, plus root `AGENTS.md` /
  `CLAUDE.md`.
- **Skills are file-backed.** `https://cursor.com/docs/skills` documents
  `.cursor/skills/` and `~/.cursor/skills/` as native Cursor skill locations.
- **Subagents are file-backed.** `https://cursor.com/docs/subagents` documents
  `.cursor/agents/` and `~/.cursor/agents/` as native Cursor subagent
  locations.
- **Subagent frontmatter fields are documented.**
  `https://cursor.com/docs/subagents` documents `name`, `description`, `model`,
  `readonly`, and `is_background`, with `model` defaulting to `inherit` when
  omitted.
- **Cursor plugins are IDE-only today.** `https://cursor.com/docs/plugins`
  explicitly says Cursor CLI does not support plugins.
- **User rules are not documented as file-backed.** Cursor help/docs describe
  user rules as settings-managed rather than as files in `~/.cursor/`; no
  documented user rules directory was found.

### OS path reality

- Cursor docs express user-scope skills/subagents as `~/.cursor/...`.
- The harness implementation should resolve user scope from the effective home
  directory (`homeDir` override in tests; real home dir in production) and join
  `.cursor/<asset>` beneath it.
- On Windows, the expected equivalent is `%USERPROFILE%\\.cursor\\...`, but this
  must be manually verified before release because the Cursor skills/subagents
  docs use `~` shorthand rather than an explicit Windows table.

### Pre-ship verification still required

Do not treat discovery details as fully closed until implementation-time manual
verification confirms:

- `.cursor/rules/`, `.cursor/skills/`, and `.cursor/agents/` are discovered in
  the Cursor IDE on macOS/Linux and Windows.
- `~/.cursor/skills/` and `~/.cursor/agents/` are discovered in the Cursor IDE
  and CLI on macOS/Linux and Windows.
- `.mdc` is the correct rule file format for description-bearing rules and is
  auto-discovered without extra registration.
- Manual rule invocation semantics are confirmed before user-facing docs promise
  any `@rule-name` UX.

Implication: project-scope install can include skills, subagents, and rules;
user-scope install can reliably include skills and subagents, but not an
official user-scope orchestrator rule.

## Product Requirements

### User-facing commands

The existing harness surface stays the entry point:

```bash
5x harness install cursor --scope project
5x harness install cursor --scope user
5x harness list
5x harness uninstall cursor --scope project
5x harness uninstall cursor --scope user
```

### Installed assets

**Project scope** installs:

- `.cursor/skills/5x/SKILL.md`
- `.cursor/skills/5x-plan/SKILL.md`
- `.cursor/skills/5x-plan-review/SKILL.md`
- `.cursor/skills/5x-phase-execution/SKILL.md`
- `.cursor/agents/5x-plan-author.md`
- `.cursor/agents/5x-code-author.md`
- `.cursor/agents/5x-reviewer.md`
- `.cursor/rules/5x-orchestrator.mdc`

**User scope** installs:

- `~/.cursor/skills/5x/SKILL.md`
- `~/.cursor/skills/5x-plan/SKILL.md`
- `~/.cursor/skills/5x-plan-review/SKILL.md`
- `~/.cursor/skills/5x-phase-execution/SKILL.md`
- `~/.cursor/agents/5x-plan-author.md`
- `~/.cursor/agents/5x-code-author.md`
- `~/.cursor/agents/5x-reviewer.md`

**User-scope rule install is intentionally omitted** in v1. The command should
report that Cursor user rules are settings-managed and that project scope is the
supported path for installing the orchestrator rule.

### UX expectations

- Project-scope `5x harness install cursor` follows the existing harness command
  contract and therefore requires the project to have been initialized with
  `5x init` first.
- After project install, Cursor should naturally discover the 5x skills,
  subagents, and orchestrator rule in both IDE and CLI.
- After user install, Cursor should discover 5x skills and subagents globally.
- Users can start a workflow naturally (for example: "Use 5x to generate a plan
  from `docs/...`" ).
- User-facing docs should not promise manual `@5x-orchestrator` invocation until
  Cursor rule invocation semantics are verified during implementation.
- Installed assets remain editable; `--force` restores bundled defaults.

## Design Decisions

**One `cursor` harness covers both IDE and CLI.**

- Cursor editor and CLI share the same `.cursor/` project structure and the same
  `~/.cursor/` user structure for skills and subagents.
- The harness name should be `cursor`, not `cursor-ide` and `cursor-cli`.

**Filesystem install only in v1.**

- Cursor CLI does not support plugins, so marketplace/plugin packaging would
  create a second, IDE-only distribution story.
- The v1 harness should install plain files only.

**Cursor uses a rule as the orchestrator layer.**

- OpenCode uses a custom primary agent profile (`5x-orchestrator`).
- Cursor does not document custom primary-agent profile files.
- The closest native equivalent is a project rule, so the main-agent
  orchestration guidance should live in `5x-orchestrator.mdc`.

**Canonical project skill path is `.cursor/skills/`, not `.agents/skills/`.**

- Cursor supports both, but `.cursor/` is the only project root that can also
  hold subagents and rules.
- A single `cursor` harness should install its project assets into one canonical
  tree.

**The harness framework should gain first-class rule support.**

- The current plugin contract only manages skills and agents.
- Cursor needs managed rules for install/list/uninstall parity.
- Add optional rule support to the shared harness types, installer helpers, and
  `harness list` / `harness uninstall` output.
- All new rule-related fields must remain optional so existing bundled and
  external harness plugins stay source-compatible.

**Unsupported asset types need a typed CLI contract.**

- User-scope Cursor installs intentionally do not install rules.
- The plugin/handler contract should surface this explicitly via typed result
  data rather than ad-hoc plugin printing.
- Preferred shape: per-scope install/list output includes an `unsupported`
  summary (for example `rules: true`) and optional warnings.
- `harness list` must represent `rules: unsupported` for Cursor user scope,
  not `rules: not installed`.

**User-scope rules are out of scope until Cursor documents a file path.**

- Do not guess a hidden `~/.cursor/rules` path.
- Treat user-scope orchestrator rules as unsupported in v1.
- Make the limitation explicit in install output and docs.

**Keep the 5x asset set close to OpenCode, with one structural substitution.**

- Keep the same 4 skills: `5x`, `5x-plan`, `5x-plan-review`,
  `5x-phase-execution`.
- Keep the same 3 specialist subagents: `5x-plan-author`, `5x-code-author`,
  `5x-reviewer`.
- Replace the OpenCode primary orchestrator agent with one Cursor rule:
  `5x-orchestrator.mdc`.

**Cursor-specific skill prose should use Cursor's native concepts.**

- Replace OpenCode-specific `Task tool` / `task_id` wording with Cursor
  subagent wording and resumable agent IDs.
- Use named subagents (`5x-plan-author`, `5x-code-author`, `5x-reviewer`) as
  the native delegation targets.
- Mention Cursor's built-in `explore` and `bash` subagents as optional helpers
  for noisy research and shell-heavy work.
- Include one canonical Cursor-native delegation example in the Cursor-local
  skills so the main agent has a concrete reference for render -> subagent ->
  validate/record behavior.

**Model injection should follow Cursor's subagent frontmatter.**

- When no 5x role model is configured, omit the `model` field entirely; Cursor
  docs state the default behavior is `inherit`.
- When a model is configured, inject it as a YAML-safe quoted scalar using the
  same escaping strategy as the OpenCode harness (`yamlQuote()`-style escaping
  for `:`, `"`, `\\`, newlines, and carriage returns).
- Author subagents use `[author].model` when set.
- Reviewer subagent uses `[reviewer].model` when set.
- Do not add new 5x config keys in v1.

**Do not use `readonly: true` for the reviewer in v1.**

- The current 5x review flow can require writing review artifacts and making a
  review commit.
- A readonly reviewer would diverge from current workflow behavior.
- Keep the read-only expectation behavioral, not enforced by Cursor frontmatter.

**Hooks are deferred.**

- Cursor hooks are powerful and may be valuable later for policy enforcement,
  audit trails, or follow-up automation.
- They add cross-platform script complexity and are not required to make native
  5x workflows usable in v1.

**Worktree execution is supported only if Cursor edits the mapped worktree
reliably.**

- 5x run-aware prompts already append a `## Context` block containing the
  effective working directory.
- The Cursor orchestrator rule and Cursor author/reviewer subagent prompts must
  explicitly treat that path as authoritative for all reads, edits, and shell
  commands.
- Manual release verification must prove that, for `5x run init --worktree`,
  Cursor-author edits land in the mapped worktree (for example
  `.5x/worktrees/...`) and not in the main checkout.
- If this cannot be verified reliably in Cursor IDE and CLI, the Cursor harness
  must not ship as worktree-compatible.

## Cursor Asset Design

### 1. Orchestrator rule

Add `src/harnesses/cursor/5x-orchestrator.mdc`.

Recommended frontmatter shape:

```md
---
description: Use for 5x plan generation, plan review, and phased implementation workflows. Load the matching 5x skill, delegate author/reviewer work to the 5x subagents, and keep the main Cursor agent in an orchestration role.
alwaysApply: false
---
```

Rule body should adapt the current OpenCode orchestrator guidance to Cursor:

- load `5x` plus the relevant workflow skill
- delegate author work to `5x-plan-author` or `5x-code-author`
- delegate review work to `5x-reviewer`
- validate via `5x protocol validate --record`
- use `5x run state` and `5x plan phases` for recovery/resume
- present human decision points clearly
- do not perform direct code-writing in the main agent during structured 5x
  workflows

Additional rule requirements:

- The rule must explicitly tell the main agent to honor the rendered
  `## Context` effective working directory for all delegated work.
- The rule should not rely on an explicit `name` frontmatter field; Cursor rule
  docs only guarantee filename + description/frontmatter semantics.
- User-facing docs may describe manual invocation only after implementation
  verifies how Cursor resolves project rule names/selectors.

The rule should be narrow enough to avoid hijacking normal Cursor usage, but
clear enough that prompts mentioning `5x`, `plan`, `review`, `phase execution`,
or approved plans trigger it reliably.

### 2. Subagents

Add three bundled Cursor subagent templates:

- `5x-plan-author.md`
- `5x-code-author.md`
- `5x-reviewer.md`

They should use Cursor's documented frontmatter:

```md
---
name: 5x-code-author
description: 5x code author - implements code changes from approved plans
model: inherit
---
```

This snippet shows the documented `model` field shape; the generated Cursor
subagent files should omit `model` entirely when no explicit 5x role model is
configured.

Cursor-specific notes:

- Omit `model` entirely when no explicit 5x role model is configured.
- When `model` is injected, quote/escape it with the same YAML-safe strategy as
  the OpenCode harness.
- Omit `readonly` for all three subagents in v1.
- Omit `is_background`; 5x workflow steps need foreground completion and
  immediate structured results.
- The subagent prompt body must restate that the `## Context` effective working
  directory is authoritative, especially for worktree runs.

### 3. Skills

Add a Cursor-local skill loader and Cursor-local skill copies under
`src/harnesses/cursor/skills/`.

The skill set should remain functionally equivalent to the OpenCode harness, but
with Cursor-native phrasing:

- the foundation skill should talk about Cursor subagents and resumable agent
  IDs instead of `task_id`
- workflow skills should say "launch the `5x-reviewer` subagent" instead of
  referencing OpenCode's `Task` parameter names
- when useful, skills may mention Cursor Plan mode as a friendly UX for initial
  requirements clarification, but the workflow contract still lives in 5x

Each Cursor-local workflow skill should include one canonical delegation example
in natural-language or pseudocode form showing:

1. render the prompt with `5x template render`
2. invoke the named Cursor subagent in the foreground
3. capture the subagent's final structured JSON
4. validate and record with `5x protocol validate --record`
5. optionally resume the same subagent when Cursor exposes a resumable agent ID

## Proposed Implementation

### Phase 0: Verify Cursor discovery and worktree assumptions

**Completion gate:** all file-path, frontmatter, and worktree assumptions used by
the PRD are verified against the live Cursor product before broad implementation
proceeds.

- Verify discovery of `.cursor/rules/`, `.cursor/skills/`, and
  `.cursor/agents/` in Cursor IDE.
- Verify discovery of `~/.cursor/skills/` and `~/.cursor/agents/` in Cursor IDE
  and CLI.
- Verify how Cursor project rules are manually invoked, if at all, before any
  docs promise `@5x-orchestrator` UX.
- Verify Cursor accepts omitted `model` frontmatter and uses default `inherit`
  behavior for subagents.
- Verify a real `5x run init --worktree` flow where the rendered
  effective-working-directory path points into `.5x/worktrees/...`, the Cursor
  author edits files there, and `5x diff --run` shows the changes in the mapped
  worktree instead of the main checkout.
- Record the results in a short verification note or in the implementation PR.

### Phase 1: Add optional harness rule support

**Completion gate:** the harness framework can install, list, and uninstall
rules in addition to skills and agents.

- Extend `HarnessLocations` with optional `rulesDir`.
- Extend `HarnessDescription` with optional `ruleNames`.
- Extend install/uninstall result types with optional `rules` summaries.
- Extend handler result types with `warnings` and/or `unsupported` asset-type
  summaries so unsupported rules can be represented explicitly per scope.
- Add `installRuleFiles()` and `uninstallRuleFiles()` helpers for flat rule
  files (`*.md` / `*.mdc`).
- Update `harness list` to show rules when the harness exposes them.
- Update `src/harnesses/README.md` to document the optional rule contract.
- Keep existing harnesses working unchanged when `rulesDir` / `ruleNames` are
  absent.

### Phase 2: Add the bundled `cursor` harness plugin

**Completion gate:** `loadHarnessPlugin("cursor")` resolves a bundled plugin and
the plugin can describe its assets for both scopes.

- Add `src/harnesses/cursor/plugin.ts`.
- Register `cursor` in `src/harnesses/factory.ts`.
- Add a Cursor location resolver:
  - project: `.cursor/skills/`, `.cursor/agents/`, `.cursor/rules/`
  - user: `~/.cursor/skills/`, `~/.cursor/agents/`, no documented rules dir
- Implement `describe()`, `install()`, and `uninstall()`.
- For user scope, return no rule installs and no rule uninstall targets, plus a
  typed `unsupported.rules` indication and a warning string suitable for CLI
  output.

### Phase 3: Add Cursor rules, subagents, and renderers

**Completion gate:** project-scope install writes a usable orchestrator rule and
all three subagents; user-scope install writes all three subagents.

- Add `5x-orchestrator.mdc`.
- Add `5x-plan-author.md`, `5x-code-author.md`, and `5x-reviewer.md`.
- Add a Cursor agent loader that omits `model` when unset and injects a
  YAML-escaped configured model when set.
- Add rule rendering if any frontmatter needs generated values.
- Ensure install summaries clearly distinguish skills, agents, and rules.
- Add unit tests for YAML-safe model injection with `:`, `"`, `\\`, and
  newline-bearing model strings.

### Phase 4: Add Cursor-local skills

**Completion gate:** Cursor skill prose is native to Cursor terminology while
preserving the same 5x workflow behavior and protocol invariants.

- Copy the current OpenCode skills into `src/harnesses/cursor/skills/`.
- Rewrite Cursor-specific wording only where needed.
- Keep the same workflow steps, invariants, validation calls, and recovery
  logic.
- Update references from OpenCode `task_id` semantics to Cursor resumable
  subagent IDs.
- Add a canonical Cursor-native delegation example to the foundation skill and
  reuse/adapt it in the workflow skills.

### Phase 5: Docs and UX polish

**Completion gate:** users can install and use the Cursor harness without
reading source code.

- Update `README.md` with Cursor install instructions.
- Add a short "how to start a 5x workflow in Cursor" section.
- Document the user-scope limitation for rules.
- Document that project-scope harness install requires `5x init` first.
- Ensure install output mentions:
  - project scope installs the orchestrator rule
  - user scope installs only skills + subagents
  - user-scope rules are unsupported, not broken
  - manual rule invocation guidance is included only if verified during
    implementation
- Keep `harness list` readable with three asset types and stable JSON for
  scripts.

## Files Touched

| File | Change |
|------|--------|
| `src/harnesses/types.ts` | Add optional rule support to plugin contract |
| `src/harnesses/locations.ts` | Add Cursor location resolver |
| `src/harnesses/installer.ts` | Add rule install/uninstall helpers |
| `src/harnesses/factory.ts` | Register bundled `cursor` harness |
| `src/harnesses/README.md` | Document optional rule support |
| `src/commands/harness.handler.ts` | Include rules in install/list/uninstall flows |
| `src/harnesses/cursor/plugin.ts` | New bundled Cursor harness plugin |
| `src/harnesses/cursor/loader.ts` | New Cursor subagent template loader/rendering |
| `src/harnesses/cursor/5x-orchestrator.mdc` | New Cursor project rule |
| `src/harnesses/cursor/5x-plan-author.md` | New Cursor subagent template |
| `src/harnesses/cursor/5x-code-author.md` | New Cursor subagent template |
| `src/harnesses/cursor/5x-reviewer.md` | New Cursor subagent template |
| `src/harnesses/cursor/skills/*` | New Cursor-local skill set |
| `README.md` | Document Cursor harness install and usage |
| `test/unit/harnesses/*` | Add Cursor resolver/plugin/loader coverage |
| `test/unit/commands/harness.test.ts` | Add rules-aware handler coverage |
| `test/integration/commands/harness.test.ts` | Add Cursor install/list/uninstall integration coverage |

## Test Plan

### Unit

- `test/unit/harnesses/cursor.test.ts`
  - project/user location resolution
  - project scope exposes `rulesDir`; user scope does not
  - `describe()` returns correct skills, agents, and project rule names
  - install/uninstall summaries are correct for both scopes
  - user scope reports `rules` as unsupported rather than merely absent
- `test/unit/harnesses/cursor-skills.test.ts`
  - skill frontmatter parses
  - Cursor-specific wording references Cursor subagents, not OpenCode task IDs
  - Cursor skills include a canonical delegation example
- `test/unit/harnesses/installer.test.ts`
  - rule install/uninstall helpers create, overwrite, skip, and clean up
- `test/unit/harnesses/cursor-loader.test.ts`
  - omits `model` when unset
  - YAML-escapes configured `model` values containing `:`, `"`, `\\`, and
    newlines
- `test/unit/commands/harness.test.ts`
  - install/list/uninstall include rules when present
  - user scope reports rules as unsupported for Cursor
  - list output/JSON remain stable with three asset types

### Integration

- `5x harness install cursor --scope project`
  - writes `.cursor/skills/`, `.cursor/agents/`, `.cursor/rules/`
- `5x harness install cursor --scope user`
  - writes `~/.cursor/skills/` and `~/.cursor/agents/`
  - does not write user rules
- `5x harness list`
  - shows project rules for project scope
  - shows `rules: unsupported` for user scope rather than implying not installed
- `5x harness uninstall cursor --scope project`
  - removes project rule, skills, and agents
- `5x harness uninstall cursor --scope user`
  - removes user skills and agents

### Manual verification

- Verify project/user discovery on macOS/Linux and Windows.
- Cursor IDE discovers the installed project rule, skills, and subagents.
- Cursor CLI discovers the same project rule, skills, and subagents.
- A prompt like "Use 5x to generate a plan from `docs/...`" loads
  the orchestrator rule and delegates to `5x-plan-author`.
- A phase execution workflow can delegate to `5x-code-author` and
  `5x-reviewer`, then validate via `5x protocol validate`.
- User-scope install works globally for skills and subagents.
- A real `5x run init --worktree` run produces a mapped worktree under
  `.5x/worktrees/...`, the Cursor author edits files in that mapped worktree,
  and `5x diff --run` shows the diff in the mapped worktree rather than the
  main checkout.
- If manual project-rule invocation is supported, verify the exact selector
  semantics before documenting it.

## Risks

- **Rule auto-application may be imperfect.** Cursor may not always pick the
  orchestrator rule automatically; mitigation: keep the rule description highly
  specific and only document manual invocation if live verification proves the
  exact selector semantics.
- **User-scope asymmetry.** Project scope can install the orchestrator rule,
  user scope cannot. Mitigation: make the limitation explicit in docs and output.
- **Dead-asset risk from wrong Cursor assumptions.** Mitigation: Phase 0
  verification is a release gate, not a best-effort task.
- **Skill duplication drift.** Cursor and OpenCode skills may diverge over time.
  Mitigation: keep structure as parallel as possible, prefer shared source plus
  small harness-specific overlays where practical, and review both when 5x
  workflow semantics change.
- **Cursor subagent resume semantics may differ from OpenCode task reuse.**
  Mitigation: keep reuse best-effort and never make workflow correctness depend
  on it.
- **Worktree boundary issues.** If Cursor cannot reliably operate inside
  `.5x/worktrees/...`, worktree-backed author flows could edit the wrong tree.
  Mitigation: require explicit `## Context` guidance and manual proof before
  release.
- **Future hooks support may need another plugin contract extension.** Acceptable
  for v1 because hooks are intentionally deferred.

## Acceptance Criteria

- `5x harness install cursor --scope project` installs 4 skills, 3 subagents,
  and 1 orchestrator rule under `.cursor/`.
- `5x harness install cursor --scope user` installs 4 skills and 3 subagents
  under `~/.cursor/` and does not attempt undocumented user-rule writes.
- User-scope install/list output explicitly reports `rules` as unsupported for
  Cursor rather than silently omitting them.
- `5x harness list` and `5x harness uninstall` manage Cursor rules where they
  are supported.
- Cursor-local skills preserve the same 5x workflow contract used by the
  OpenCode harness.
- Cursor subagent templates omit `model` when unset and safely YAML-escape any
  configured model values.
- The bundled `cursor` harness works in both Cursor IDE and Cursor CLI without a
  separate harness name or install path.
- Manual verification proves Cursor-author edits land in the mapped worktree for
  `5x run init --worktree` flows.
- Existing OpenCode behavior remains unchanged.

## Rollout

1. Extend the harness framework for optional rules.
2. Land the bundled `cursor` harness with locations, subagents, and rule.
3. Land Cursor-local skills.
4. Update docs and install output.
5. Verify in Cursor IDE and Cursor CLI.

## Open Questions

- Manual project-rule invocation semantics should be documented only after live
  Cursor verification confirms whether filename-based `@rule` invocation exists
  and what exact selector string it uses.

## Revision History

### v0.2 - March 23, 2026

- Address review feedback:
  - added explicit Cursor doc verification/citation block and OS path notes
  - added Phase 0 verification gate for discovery/frontmatter/worktree behavior
  - defined typed UX requirements for `rules: unsupported` at user scope
  - specified model omission + YAML-safe injection behavior
  - added worktree-specific constraints and manual verification requirements
  - added Cursor-native delegation example requirement for skills

### v0.1 - March 23, 2026

- Initial draft.
