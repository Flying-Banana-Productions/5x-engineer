# Universal Harness Plugin

Bundled harness plugin for tools without a dedicated 5x harness integration.
It installs only skills (no agent profiles) and uses `5x invoke` delegation.

## Files

```
universal/
  plugin.ts              HarnessPlugin implementation
  README.md              This file
```

## Install Paths

Resolved by `universalLocationResolver` in `src/harnesses/locations.ts`:

| Scope | Skills | Agents |
| --- | --- | --- |
| project | `.agents/skills/<name>/SKILL.md` | `.agents/agents/` (unused) |
| user | `~/.agents/skills/<name>/SKILL.md` | `~/.agents/agents/` (unused) |

The locations follow the [agentskills.io](https://agentskills.io/specification)
cross-client convention. 5x writes files to those paths; skill discovery depends
on host tool behavior.

## How It Works

`plugin.ts` uses shared skill templates from `src/skills/base/`:

1. `describe()` returns `listBaseSkillNames()` and no agents.
2. `install()` renders shared templates with `renderAllSkillTemplates({ native: false })`.
3. Installs rendered files via `installSkillFiles()`.
4. Returns empty install summaries for agents (`created/overwritten/skipped` all empty).
5. `uninstall()` removes skill directories with `uninstallSkillFiles()` and leaves agents untouched.

## Why No Agents?

Universal is intentionally harness-agnostic:

- No harness-specific agent/profile format assumptions.
- No native subagent contract.
- Orchestrating LLM reads skills and executes delegation via `5x invoke`.

If you need native subagents and harness-specific UX, use a dedicated harness
plugin (for example `opencode` or `cursor`).

## Per-harness model config

The universal harness does **not** install agent profiles, so `[author|reviewer].harnessModels.universal` has no effect on install output. You may still use `[author]` / `[reviewer]` `model` for `5x invoke`. Optional `harnessModels` keys for other harness names are ignored by this plugin.
