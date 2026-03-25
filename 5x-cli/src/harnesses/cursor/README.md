# Cursor Harness Plugin

Bundled harness plugin for [Cursor](https://cursor.com). Installs 5x skills, subagent markdown profiles under `.cursor/agents/`, and (in project scope) Cursor rules under `.cursor/rules/`.

## Files

```
cursor/
  plugin.ts              HarnessPlugin implementation (entry point)
  loader.ts              Agent template registry, model injection, rendering
  skills/loader.ts       Skill templates for this harness
  5x-orchestrator.mdc    Project rule — orchestration (project scope)
  5x-permissions.mdc     Project rule — 5x CLI permissions (project scope)
  5x-plan-author.md      Subagent (author role)
  5x-code-author.md      Subagent (author role)
  5x-reviewer.md         Subagent (reviewer role)
  README.md              This file
```

## Install Paths

Resolved by `cursorLocationResolver` in `../locations.ts`:

| Scope | Skills | Agents | Rules |
|-------|--------|--------|-------|
| project | `<project>/.cursor/skills/<name>/SKILL.md` | `<project>/.cursor/agents/<name>.md` | `<project>/.cursor/rules/*.mdc` |
| user | `~/.cursor/skills/...` | `~/.cursor/agents/...` | (not file-backed in v1) |

## Agent Templates

Three subagent markdown files with YAML frontmatter (same injection pattern as the OpenCode harness). Cursor uses its own model id conventions; they may differ from OpenCode provider strings for the same logical model.

## Model Injection (`loader.ts`)

At install time, `renderAgentTemplates()` injects a `model:` line into each subagent's frontmatter when a resolved model string is available.

Resolution order for each role: `[author|reviewer].harnessModels.cursor` when non-empty, else `[author|reviewer].model`. Set `harnessModels` in `5x.toml` when you install both Cursor and another harness (e.g. OpenCode) and need different model identifiers per tool. See commented examples in `src/templates/5x.default.toml`. The orchestrator is implemented as **rules** (`.mdc`), not as a subagent profile here, and does not receive an injected `model` field from this harness.

## Customizing

After install, generated files under `.cursor/` are user-editable. Re-run `5x harness install cursor --force` to reset to bundled defaults.

