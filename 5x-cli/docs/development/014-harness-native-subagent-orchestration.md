# Feature: Harness-Native Subagent Orchestration

**Version:** 1.2  
**Created:** March 10, 2026  
**Status:** Proposed

## Overview

Current 5x skills assume delegated author/reviewer work always happens through
`5x invoke` as an external provider transport. That gave 5x a stable structured
output contract, but it also creates a mismatch for agent harnesses that already
have first-class subagents and skills:

- The harness UI cannot present the delegated author/reviewer sessions as native
  child sessions.
- `5x invoke` owns prompt rendering, session continuation, structured result
  validation, logging, and recording side effects as one combined operation.
- Provider/runtime bugs inside the external transport path can block otherwise
  good harness-native workflows.
- OpenCode project installs are asymmetric: project assets live under
  `.opencode/...`, but user assets live under `~/.config/opencode/...`, so the
  current `--install-root .opencode` escape hatch is not a complete install
  story.

Desired behavior:

- Harnesses with native skills + subagents should use those native subagents
  first.
- 5x should provide the reusable workflow primitives around that native path:
  prompt rendering, structured result validation, run recording, quality gates,
  and state inspection.
- `5x invoke` should remain supported as a fallback transport, not the only way
  to execute author/reviewer work.
- The first implementation should target OpenCode, while leaving a clean path
  for Claude Code, Cursor, and similar harnesses later.

## Goals

- Make native subagent execution the preferred path for supported harnesses.
- Preserve the existing `AuthorStatus` / `ReviewerVerdict` machine contract.
- Keep current plan/review/phase skills as the workflow layer; only change how
  they delegate author/reviewer work.
- Add a first-class OpenCode installer that can install both skills and custom
  subagents at project or user scope.
- Keep `5x invoke` working as a documented fallback for unsupported or missing
  native agents.

## Non-Goals

- Removing `5x invoke` or the provider abstraction in this change.
- Shipping native installers for every harness in the first pass.
- Adding a new DB schema purely for native child session persistence.
- Replacing `5x run record`, `5x quality run`, `5x diff`, or existing run state
  semantics.
- Designing a new prompt corpus per harness unless the existing task prompts
  prove insufficient.

## Design Decisions

**Native subagents become the preferred transport; `5x invoke` remains the fallback.**

- Skills should prefer native subagent execution when the harness exposes both
  skills and subagents.
- Fallback order:
  1. harness-specific custom 5x subagent,
  2. harness built-in/general-purpose subagent,
  3. `5x invoke`.
- This preserves compatibility for non-native environments and for harnesses
  where the custom 5x agents have not been installed.

**Prompt rendering and result validation must be first-class CLI primitives.**

- The current `invoke.handler.ts` already knows how to:
  - load prompt templates,
  - inject explicit variables,
  - resolve internal variables like template paths,
  - resolve run/worktree context,
  - choose continued templates for resumed sessions,
  - validate structured output.
- Native orchestration should not reimplement that logic inside skill prose.
- Add two standalone primitives:
  - `5x template render <template>`
  - `5x protocol validate <author|reviewer>`
- These commands become the stable bridge between native harness orchestration
  and 5x's workflow contract.

**`5x template render` is run-aware and outputs a specified JSON envelope to stdout.**

- `template render` accepts `--run <id>` and, when provided, performs
  run/worktree context resolution mirroring the logic in `invoke.handler.ts`
  lines 332–381.
- All structured output is written to stdout as a single JSON object.
- The envelope schema is:

  ```json
  {
    "template": "reviewer-plan",
    "selected_template": "reviewer-plan-continued",
    "step_name": "reviewer:review",
    "prompt": "<rendered markdown>",
    "declared_variables": ["plan_path", "review_path"],
    "run_id": "run_abc123",
    "plan_path": "/abs/path/to/plan.md",
    "worktree_root": "/abs/path/to/worktree"
  }
  ```

- `run_id`, `plan_path`, and `worktree_root` are only included when `--run`
  is passed. Without `--run`, the envelope contains `template`,
  `selected_template`, `step_name`, `prompt`, and `declared_variables` only.

**Native subagents receive the effective working directory via prompt text
(primary) and agent profile `cwd` (secondary).**

- When `5x template render` resolves a worktree root via `--run`, it appends a
  `## Context` block to the already-rendered prompt string after `renderBody()`
  returns, bypassing the `{{var}}` template variable mechanism entirely. No
  changes to existing template frontmatter are needed. The block is only appended
  when `--run` resolves a worktree root:

  ```markdown
  ## Context

  - Effective working directory: /abs/path/to/worktree
  ```

  This post-render concatenation is the primary mechanism and is harness-agnostic.
- As a belt-and-suspenders secondary layer, OpenCode agent profiles (Phase 2)
  should set a `cwd` frontmatter field if OpenCode supports it, so the harness
  itself can set the working directory when launching the subagent.
- The primary mechanism (prompt text) must always be present. The secondary
  mechanism (agent profile `cwd`) is best-effort and harness-specific.

**`5x protocol validate` supports combined validation and recording.**

- `5x protocol validate` accepts `--run <id>`, `--record`, `--step <name>`,
  `--phase <name>`, and `--iteration <number>` flags so validation and recording
  can be combined in one command.
- `--phase` and `--iteration` are passed through to `recordStepInternal()`,
  matching the existing metadata that `5x invoke --record` supports
  (`invoke.handler.ts:655–656`).
- This preserves the ergonomics of `5x invoke --record` — skills need not issue
  separate `5x run record` calls after every validation.
- `--require-commit` defaults to `true` for author validation, matching
  existing `5x invoke` behavior. Use `--no-require-commit` to opt out.

**Task prompts stay universal; harness agent profiles carry role/process mechanics.**

- Keep the existing task templates (`author-generate-plan`, `author-next-phase`,
  `author-process-plan-review`, `author-process-impl-review`, `reviewer-plan`,
  `reviewer-plan-continued`, `reviewer-commit`) as the shared task layer.
- Move harness-specific role framing into installed subagent profiles.
- Update prompt template wording where needed so it is transport-neutral
  ("delegated non-interactive workflow") rather than subprocess-specific.
- Do not fork separate run prompts per harness in v1 unless a real gap appears.

**OpenCode installs need a harness location registry, not just `--install-root`.**

- Project-local OpenCode assets belong under `.opencode/skills/` and
  `.opencode/agents/`.
- User-scoped OpenCode assets belong under `~/.config/opencode/skills/` and
  `~/.config/opencode/agents/`.
- This asymmetry cannot be represented by today's single-string `installRoot`
  override.
- Add a small harness location abstraction so `init opencode user|project` can
  install into the correct directories.
- Keep the existing `skills install --install-root` behavior for simple
  agentskills-compatible layouts, but do not depend on it for OpenCode user
  installs.

**OpenCode gets three custom subagents with stable names.**

- Install three subagent profiles:
  - `5x-plan-author`
  - `5x-code-author`
  - `5x-reviewer`
- All are `mode: subagent`.
- `5x-reviewer` is read-only for file modifications (enforced via
  `allowedTools` / `disallowedTools` in the agent frontmatter).
- The author agents allow edits and bash, following current 5x author behavior.
- Agent profiles set `cwd` frontmatter if supported by OpenCode, as a secondary
  mechanism for working directory communication (see prompt-text primary
  mechanism above).
- Installed files remain user-editable so model changes and prompt tuning do not
  require new 5x config schema in v1.

**Model defaults come from existing 5x config, but installed agents may diverge.**

- When generating OpenCode agent frontmatter:
  - `5x-plan-author` and `5x-code-author` default to `[author].model` when set.
  - `5x-reviewer` defaults to `[reviewer].model` when set.
  - If a role model is unset, omit the `model` field so OpenCode inherits the
    primary agent's model.
- v1 does not add separate `planAuthorModel` / `codeAuthorModel` config fields.
- If users want distinct models per installed subagent, they can edit the
  generated agent markdown directly.

**Session reuse is best effort and should not block shipping.**

- Skills may reuse native child sessions when the harness exposes a stable task
  or session identifier and the orchestrating agent can carry it forward.
- If reuse is awkward or unavailable, native flows may start a fresh subagent
  session and continue the workflow.
- No schema change is required for v1. If useful, task/session ids may be
  recorded inside step result JSON as advisory metadata only.

**Run recording, quality gates, and diff inspection stay unchanged.**

- Native execution changes how author/reviewer work is delegated, not how 5x
  tracks workflow progress.
- The orchestrator still records `author:*`, `reviewer:*`, `quality:check`, and
  `human:*` steps with the same run/phase/iteration model.
- `5x run watch` remains oriented around `5x invoke` logs; native child-session
  UX in the harness is the preferred live-monitoring path for native runs.

## Proposed Implementation

### Phase 1: Extract Native Workflow Primitives

**Completion gate:** 5x can render any author/reviewer task prompt and validate
its final JSON result without invoking a provider.

- [ ] Add `5x template render <template>` command and handler.
- [ ] Support the same variable sources as `5x invoke`: repeated `--var`, `@file`,
      `@-`, internal template variables, and run/worktree-aware plan path
      resolution.
- [ ] Accept `--run <id>` on `template render` and perform run/worktree context
      resolution (mirroring `invoke.handler.ts` lines 332–381). When `--run` is
      passed, include `run_id`, `plan_path`, and `worktree_root` in the output
      envelope. Append a `## Context` block (containing the effective working
      directory) to the rendered prompt string via post-render concatenation —
      not the `{{var}}` template variable mechanism — so native subagents receive
      the working directory in their instructions without requiring changes to
      template frontmatter.
- [ ] Make `template render` mirror continued-template selection: when a caller
      passes `--session` and `<template>-continued` exists, render the continued
      variant automatically and expose the selected template name in output.
- [ ] Output a JSON envelope to stdout with the fields: `template`,
      `selected_template`, `step_name`, `prompt`, `declared_variables`, and
      (when `--run` is passed) `run_id`, `plan_path`, `worktree_root`.
- [ ] Extract shared variable-resolution logic from `invoke.handler.ts` into a
      reusable helper owned by the template/render path.
- [ ] Add `5x protocol validate <author|reviewer>` command and handler.
- [ ] Accept JSON from stdin or `--input`, validate against the existing schemas
      in `src/protocol.ts`, and return the validated payload in a JSON envelope.
- [ ] Support `--require-commit` for author validation. Default to `true` for
      author role to match existing `5x invoke` behavior; use
      `--no-require-commit` to opt out.
- [ ] Support `--run <id>`, `--record`, `--step <name>`, `--phase <name>`, and
      `--iteration <number>` on `5x protocol validate` so validation and recording
      are combined in one command, preserving the ergonomics of `5x invoke --record`.
      `--phase` and `--iteration` are passed through to `recordStepInternal()` to
      maintain phase/iteration metadata in recorded steps.
- [ ] Refactor `invoke.handler.ts` to reuse the extracted render/validate helpers
      so native and fallback execution share one contract. This is a pure
      extraction — existing invoke test assertions must not change.
- [ ] Add unit tests for render output, internal variable resolution,
      continued-template selection, stdin/file variable expansion, run-aware
      envelope fields, post-render `## Context` block injection, reviewer validation,
      author validation, author-commit enforcement, and combined
      validate-and-record flow.

### Phase 2: Add Harness Install Abstractions + OpenCode Asset Templates

**Completion gate:** the codebase has a reusable harness asset installer model,
plus bundled OpenCode agent templates and correct project/user path mapping.

- [ ] Verify that `.opencode/agents/` is the correct agent discovery path for
      OpenCode project installs, and `~/.config/opencode/agents/` for user
      installs. Reference OpenCode documentation or source as evidence before
      writing the installer. If the paths differ, update all references in this
      plan accordingly.
- [ ] Verify OpenCode's exact tool naming convention (e.g., `read_file` vs
      `readFile` vs `Read`) against OpenCode's tool registry or source before
      finalizing `allowedTools`/`disallowedTools` in agent templates. If the
      assumed names in the skeletons above are incorrect, update them. Silently
      mismatched tool names would cause restrictions to not apply.
- [ ] Add a small harness registry describing install locations for supported
      harnesses, starting with OpenCode.
- [ ] Model both `project` and `user` roots explicitly so OpenCode can target
      `.opencode/...` for project installs and `~/.config/opencode/...` for user
      installs.
- [ ] Add bundled OpenCode agent templates in source control for:
      `5x-plan-author`, `5x-code-author`, and `5x-reviewer`.
- [ ] Define prompt, tool, permission, mode, description, and optional model
      frontmatter for each OpenCode agent template using the skeletons below as
      the concrete target.
- [ ] Set `cwd` frontmatter in agent profiles if OpenCode supports it, as a
      secondary mechanism for communicating the effective working directory to
      native subagents (the primary mechanism is the post-render `## Context`
      block appended to the rendered prompt text from Phase 1).
- [ ] Ensure the reviewer template denies direct file edits while still allowing
      read-only investigation commands.
- [ ] Make agent template rendering parameterized by current 5x config so model
      fields can be included or omitted deterministically.
- [ ] Add installer helpers for writing both skills and agents with
      `created/overwritten/skipped` reporting matching existing command style.
- [ ] Keep the existing `skills install` command backward-compatible; do not
      change its output contract in this phase.
- [ ] Add unit tests covering OpenCode location resolution, agent template
      rendering with and without configured models, and correct file generation
      for project vs user scope.

**Agent template skeletons:**

The following skeletons are the concrete target for the three OpenCode agent
templates. All three use `mode: subagent`. Model fields are included only when
the corresponding 5x config role model is set; otherwise they are omitted so
OpenCode inherits the primary agent's model.

`5x-reviewer` _(tool names are assumed — verify against OpenCode's tool registry
in Phase 2 before finalizing)_:

```markdown
---
name: 5x-reviewer
description: 5x quality reviewer — read-only investigation and structured verdict
model: <omit or from [reviewer].model>
mode: subagent
allowedTools: [read_file, search_files, run_terminal_cmd, list_directory]
disallowedTools: [write_file, edit_file, delete_file]
---
```

`5x-plan-author`:

```markdown
---
name: 5x-plan-author
description: 5x plan author — generates and revises implementation plans
model: <omit or from [author].model>
mode: subagent
---
```

`5x-code-author`:

```markdown
---
name: 5x-code-author
description: 5x code author — implements code changes from approved plans
model: <omit or from [author].model>
mode: subagent
---
```

### Phase 3: Add `5x init opencode <user|project>`

**Completion gate:** users can install all required OpenCode-native 5x assets in
one command without disturbing the existing repository scaffolding flow.

- [ ] Restructure `init.ts` using citty's parent-with-subcommands pattern (same
      pattern as the existing `skills` command). The existing flat `init` handler
      is preserved as the no-arg/default `run` handler on the parent command.
      `5x init opencode` is registered as a `subCommands` entry on the parent.
      Bare `5x init [--force]` continues to run `initScaffold` via the parent's
      `run` handler (which fires only when no subcommand matches).
- [ ] Add `5x init opencode <user|project>` as a new subcommand path.
- [ ] `5x init opencode project` requires `.5x/` and `5x.toml` to already exist
      (i.e., `5x init` must have been run first). Add a prerequisite check that
      exits with a clear error message if these are absent.
- [ ] Support `--force` for overwriting installed agent and skill files.
- [ ] For project scope, install:
      - skills under `.opencode/skills/`
      - agents under `.opencode/agents/`
- [ ] For user scope, install:
      - skills under `~/.config/opencode/skills/`
      - agents under `~/.config/opencode/agents/`
- [ ] Reuse the existing control-plane safeguards where appropriate so running
      `5x init opencode project` from a managed linked worktree still resolves to
      the checkout root intended for project-local assets.
- [ ] Update `5x init` success messaging to mention the native OpenCode install
      path alongside the generic skills install path.
- [ ] Add integration tests covering:
      - legacy `5x init` scaffolding still works (compatibility test that
        `5x init --force` works without arguments),
      - `5x init opencode project` writes both skills and agents,
      - `5x init opencode project` fails with clear error when `.5x/` or
        `5x.toml` is absent,
      - `5x init opencode user` resolves the correct global config paths,
      - `--force` overwrite behavior,
      - idempotent re-run behavior.

### Phase 4: Rewrite Skills for Native-First Delegation

**Completion gate:** bundled skills describe native subagent orchestration as the
default path, with explicit fallback to `5x invoke` when native agents are not
available.

- [ ] Rewrite `5x-plan`, `5x-plan-review`, and `5x-phase-execution` skill docs.
- [ ] Replace "always run `5x invoke` as a subprocess" guidance with a new
      delegation pattern:
  - render the task prompt with `5x template render`,
  - detect whether a native agent is installed (see detection order below),
  - run the prompt in a native subagent if available,
  - validate the final JSON with `5x protocol validate --record`,
  - fall back to `5x invoke` if no native agent is found.
- [ ] Document the preferred OpenCode agent names (`5x-plan-author`,
      `5x-code-author`, `5x-reviewer`) and the fallback path when they are not
      present.
- [ ] In the fallback guidance, preserve `5x invoke` as the last-resort path so
      older environments and unsupported harnesses still work.
- [ ] Update skill prose to treat session reuse as optional/best effort.
- [ ] Remove or rewrite subprocess-only wording in the shared task templates so
      native subagents are not told they are external subprocesses.
- [ ] Keep the structured outcome contract identical to today: author returns
      `AuthorStatus`, reviewer returns `ReviewerVerdict`.
- [ ] Add focused tests for any template text or loader behavior changed by this
      phase.

**Native agent detection order:**

Skills detect whether native agents are installed via a two-location file
existence check:

1. Project scope: `.opencode/agents/<name>.md`
2. User scope: `~/.config/opencode/agents/<name>.md`
3. Fallback: `5x invoke`

Skills check project scope first, then user scope. If neither file exists, the
skill falls back to `5x invoke`. This order is documented in skill prose so the
orchestrating agent follows it consistently.

**Canonical native delegation example (reviewer:review in `5x-plan-review`):**

The following sequence is the reference pattern that all skill rewrites should
follow for delegated steps:

```bash
# 1. Render the prompt
RENDERED=$(5x template render reviewer-plan --run $RUN \
  --var plan_path=$PLAN_PATH --var review_path=$REVIEW_PATH)
PROMPT=$(echo "$RENDERED" | jq -r '.prompt')
STEP=$(echo "$RENDERED" | jq -r '.step_name')

# 2. Detect native agent (project scope first, then user scope)
if [[ -f ".opencode/agents/5x-reviewer.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-reviewer.md" ]]; then
  # 3a. Launch native subagent (harness provides child session)
  RESULT=<native subagent result JSON>
else
  # 3b. Fallback to 5x invoke (NOTE: --record is intentionally omitted here
  #     so that 5x protocol validate --record is the single recording point
  #     for both native and fallback paths, avoiding double-recording)
  RESULT=$(5x invoke reviewer reviewer-plan --run $RUN ...)
fi

# 4. Validate + record (combined — universal for both paths)
echo "$RESULT" | 5x protocol validate reviewer \
  --run $RUN --record --step $STEP --phase $PHASE --iteration $ITERATION
```

This example uses bash syntax for clarity. In practice, the delegation logic
appears as natural-language instructions in skill prose that the orchestrating
agent interprets — the agent calls these commands as tool invocations, not as a
literal shell script. The key properties are: render first, detect before
choosing a path, validate and record in one command. The fallback `5x invoke`
call intentionally omits `--record` so that `5x protocol validate --record` is
the single recording point for both native and fallback paths — this avoids
double-validation and double-recording in the fallback case.

### Phase 5: Docs, Compatibility Notes, and End-to-End Verification

**Completion gate:** the native-first OpenCode workflow is documented, tested,
and does not regress the existing `5x invoke` path.

- [ ] Update `README.md` quick-start instructions to show:
      - generic skill install,
      - `5x init opencode project`,
      - native subagent expectations,
      - `5x invoke` as fallback.
- [ ] Update architecture/docs files that currently describe `5x invoke` as the
      only subagent execution path.
- [ ] Document the OpenCode user-scope path difference explicitly so users do not
      assume `~/.opencode/...` is correct.
- [ ] Add an end-to-end test plan for manual verification in OpenCode:
      - custom agents installed,
      - skill discovers them,
      - native child sessions appear in the TUI,
      - validated JSON result records correctly,
      - fallback to `5x invoke` still works when custom agents are absent.
- [ ] Run lint, typecheck, and the full affected test suite.

## Files Touched

| File | Change |
|------|--------|
| `src/commands/init.ts` | Extend CLI surface to support harness subcommands while preserving existing init behavior |
| `src/commands/init.handler.ts` | Add OpenCode install flow and shared asset-install helpers |
| `src/commands/skills.handler.ts` | Reuse or factor installer logic for harness-aware skill installs |
| `src/commands/invoke.handler.ts` | Reuse extracted render/validate helpers; keep fallback path intact |
| `src/protocol.ts` | Reuse schemas/assertions from a dedicated validate command |
| `src/templates/loader.ts` | Share render behavior with the new template command |
| `src/templates/*.md` | Make task prompts transport-neutral where needed |
| `src/skills/5x-plan/SKILL.md` | Rewrite for native-first delegation |
| `src/skills/5x-plan-review/SKILL.md` | Rewrite for native-first delegation |
| `src/skills/5x-phase-execution/SKILL.md` | Rewrite for native-first delegation |
| `src/bin.ts` | Register any new top-level command groups |
| `src/commands/template.ts` | New `template` citty adapter |
| `src/commands/template.handler.ts` | New prompt-render business logic |
| `src/commands/protocol.ts` | New `protocol` citty adapter |
| `src/commands/protocol.handler.ts` | New structured-result validation business logic |
| `src/harnesses/locations.ts` | New harness install location registry |
| `src/harnesses/opencode/*.md` | Bundled OpenCode agent templates |
| `README.md` | Document native-first OpenCode setup and fallback behavior |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/commands/template*.test.ts` | Prompt rendering, variable injection, continued-template selection, run-aware envelope fields (`run_id`, `plan_path`, `worktree_root`), post-render `## Context` block injection, stdout JSON output |
| Unit | `test/commands/protocol*.test.ts` | Author/reviewer schema validation, `--require-commit` defaults to true for author, `--no-require-commit` opt-out, `--run`/`--record`/`--step`/`--phase`/`--iteration` combined validation-and-record flow, stdin/input parsing |
| Unit | `test/harnesses/opencode*.test.ts` | OpenCode install locations, generated agent frontmatter, model inclusion/omission, `cwd` field inclusion |
| Integration | `test/commands/init-opencode.test.ts` | `5x init opencode <scope>` installs both skills and agents correctly, prerequisite check for `.5x/`/`5x.toml`, `5x init --force` compatibility |
| Regression | existing `invoke` tests | Fallback transport still works with shared helpers; refactoring is a pure extraction with no invoke test assertion changes |
| Manual | OpenCode TUI workflow | Native child sessions, custom subagent usage, JSON validation, run recording, fallback behavior |

## Risks

- Skills become more complex because they must describe both native-first and
  fallback execution.
- If prompt rendering and validation are not factored cleanly, logic may be
  duplicated between native and fallback flows.
- OpenCode-specific assumptions could leak into shared skill prose if the
  fallback contract is not kept generic.
- User-edited installed agent files may drift from generated defaults; docs must
  treat them as customizable artifacts.

## Acceptance Criteria

- `5x template render <template>` can render the exact prompt needed for native
  author/reviewer delegation, including run/worktree-aware plan paths.
- `5x protocol validate author --require-commit` and
  `5x protocol validate reviewer` enforce the same structured contracts used by
  `5x invoke` today.
- `5x init opencode project` installs 5x skills and 3 custom subagents under
  `.opencode/`.
- `5x init opencode user` installs 5x skills and 3 custom subagents under
  `~/.config/opencode/`.
- The bundled skills instruct OpenCode-capable orchestrators to use native
  subagents first, then fall back safely.
- The task prompts remain shared across native and fallback execution paths.
- Existing `5x invoke` workflows continue to work without behavior regressions.

## Rollout

1. Land prompt rendering + protocol validation primitives.
2. Land harness location abstraction and bundled OpenCode agent templates.
3. Land `5x init opencode <scope>` installer flow.
4. Rewrite bundled skills and neutralize subprocess-specific prompt text.
5. Update docs and run the full verification suite.

## Not In Scope

- Native installers for Claude Code, Cursor, or other harnesses in this change.
- Deprecating `5x invoke`.
- Persisting native child session ids in first-class DB columns.
- Adding separate 5x config fields for plan-author vs code-author model choice.

## Revision History

### v1.2 — March 10, 2026

Addresses re-review feedback from
`014-harness-native-subagent-orchestration.review.md` (Addendum 2).

- **P1.5:** Replaced `{{effective_workdir}}` template variable injection with
  post-render string concatenation. `5x template render` now appends a
  `## Context` block to the rendered prompt after `renderBody()` returns,
  bypassing the `{{var}}` mechanism entirely. No changes to existing template
  frontmatter are needed. Updated Design Decisions, Phase 1 checklist, Phase 2
  checklist, Tests table, and v1.1 revision entry to use "appended Context block"
  language instead of `{{effective_workdir}}`.
- **P2.5:** Fixed canonical delegation example in Phase 4 to avoid
  double-validation/double-recording. The fallback `5x invoke` call now
  intentionally omits `--record`; `5x protocol validate --record` is the single
  recording point for both native and fallback paths. Added explanatory note.
- **P2.6:** Added `--phase <name>` and `--iteration <number>` flags to
  `5x protocol validate` in Design Decisions and Phase 1 checklist, matching the
  existing metadata supported by `5x invoke --record` (`invoke.handler.ts:655–656`).
  Updated canonical delegation example and Tests table to reflect all five flags.
- **P2.7:** Annotated agent template skeletons in Phase 2 as "assumed names —
  verify against OpenCode tool registry in Phase 2." Added a new Phase 2
  checklist item requiring verification of OpenCode's exact tool naming
  convention before finalizing `allowedTools`/`disallowedTools`.

### v1.1 — March 10, 2026

Addresses review feedback from `014-harness-native-subagent-orchestration.review.md`
(initial review + human guidance addendum).

- **P0.1:** Specified exact `5x template render` JSON envelope fields. Command
  accepts `--run <id>` and performs run/worktree context resolution. `run_id`,
  `plan_path`, `worktree_root` included only when `--run` is passed. Output goes
  to stdout.
- **P0.2:** Effective working directory communicated via two layers: primary is
  a `## Context` block appended to rendered prompt text; secondary is `cwd`
  frontmatter in OpenCode agent profiles. Both layers documented in Design
  Decisions and reflected in Phase 1/Phase 2 checklists.
- **P1.1:** Phase 3 now specifies citty parent-with-subcommands pattern (same as
  `skills` command). Bare `5x init [--force]` preserved as parent `run` handler.
  Compatibility test added to checklist.
- **P1.2:** Added concrete agent template skeletons for all three OpenCode agents
  (`5x-reviewer`, `5x-plan-author`, `5x-code-author`) in Phase 2, showing
  frontmatter fields including `allowedTools`/`disallowedTools` for reviewer.
- **P1.3:** Added canonical native delegation example (reviewer:review) in
  Phase 4 showing the full render → detect → subagent/fallback → validate+record
  sequence.
- **P1.4:** `5x protocol validate` now supports `--run`, `--record`, and
  `--step` flags for combined validation and recording. Added to Design Decisions
  and Phase 1 checklist.
- **P2.1:** Documented two-location file existence check for native agent
  detection (project → user → fallback) in Phase 4.
- **P2.2:** `--require-commit` defaults to `true` for author validation. Opt-out
  via `--no-require-commit`.
- **P2.3:** `5x init opencode project` requires `.5x/` and `5x.toml` to exist.
  Prerequisite check and error message added to Phase 3. Test added.
- **P2.4:** Added verification step in Phase 2 to confirm `.opencode/agents/`
  and `~/.config/opencode/agents/` are correct discovery paths before writing
  the installer.
- **P2.5:** Explicitly stated that `5x template render` outputs to stdout.
- **P2.6:** Noted that invoke.handler.ts refactoring is a pure extraction —
  existing invoke test assertions must not change.

### v1.0 — March 10, 2026

- Initial draft.
