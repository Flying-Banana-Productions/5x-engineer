# OpenCode Harness Plugin

Bundled harness plugin for [OpenCode](https://opencode.ai). Installs 5x skills and native subagent profiles so the 5x orchestration workflow runs inside OpenCode's agent system.

## Files

```
opencode/
  plugin.ts              HarnessPlugin implementation (entry point)
  loader.ts              Agent template registry, model injection, rendering
  locations.ts           Install path resolution (project vs user scope)
  5x-orchestrator.md     Primary agent -- delegates to subagents, never writes code
  5x-plan-author.md      Subagent (author role) -- generates/revises implementation plans
  5x-code-author.md      Subagent (author role) -- implements code from approved plans
  5x-reviewer.md         Subagent (reviewer role) -- evaluates work, produces structured verdicts
  README.md              This file
```

## How It Works

### Plugin Entry Point (`plugin.ts`)

The plugin implements `HarnessPlugin` with `supportedScopes: ["project", "user"]`.

The `install()` method:
1. Resolves install paths via `opencodeLocationResolver` (from `../locations.ts`).
2. Loads bundled 5x skills from the local `skills/loader.ts` and installs them using the shared `installSkillFiles()` helper.
3. Renders agent templates with model config via `renderAgentTemplates()`.
4. Installs rendered agents using the shared `installAgentFiles()` helper.

### Install Paths

Resolved by `opencodeLocationResolver` in `../locations.ts`:

| Scope | Skills | Agents |
|-------|--------|--------|
| project | `.opencode/skills/<name>/SKILL.md` | `.opencode/agents/<name>.md` |
| user | `~/.config/opencode/skills/<name>/SKILL.md` | `~/.config/opencode/agents/<name>.md` |

OpenCode uses `~/.config/opencode/` (XDG-style) for user scope, not `~/.opencode/`.

### Agent Templates

Four markdown templates with YAML frontmatter, bundled as static text imports:

| Template | Mode | Role | Tools Restricted |
|----------|------|------|-----------------|
| `5x-orchestrator` | primary | (none) | `write: false`, `edit: false` |
| `5x-plan-author` | subagent | author | no |
| `5x-code-author` | subagent | author | no |
| `5x-reviewer` | subagent | reviewer | no |

**Frontmatter fields** used by OpenCode:
- `name` -- agent identifier
- `description` -- shown in agent picker UI
- `mode` -- `primary` (top-level) or `subagent` (invoked by primary)
- `model` -- (injected at render time) provider/model string, e.g. `"anthropic/claude-sonnet-4-6"`
- `tools` -- optional tool restrictions (only orchestrator uses this)

**Tool naming**: OpenCode uses its own tool identifiers (`write`, `edit`, `bash`, `read`, `grep`, `glob`, `list`, `webfetch`). These are not the same as Claude Code names (`Read`, `Write`, `Bash`) or legacy names (`read_file`, `write_file`).

### Model Injection (`loader.ts`)

At install time, `renderAgentTemplates()` injects a `model:` line into each agent's YAML frontmatter. The CLI resolves strings from `5x.toml` **for this harness** (`opencode`):

- **Author agents** (`5x-plan-author`, `5x-code-author`) use the resolved author model (see below).
- **Reviewer agent** (`5x-reviewer`) uses the resolved reviewer model.
- **Orchestrator** never gets a model field -- it inherits whatever the user selects in the OpenCode UI.

Resolution order for each role: `[author|reviewer].harnessModels.opencode` when non-empty, else `[author|reviewer].model`. Use `harnessModels` when one repo installs multiple harnesses (e.g. OpenCode and Cursor) that expect different provider/model id strings. OpenCode typically uses provider-style ids such as `anthropic/claude-sonnet-4-6`.

When no resolved model is available, the field is omitted entirely (OpenCode inherits the primary agent's model for subagents).

The injection uses `yamlQuote()` to safely escape special characters (backslashes, quotes, newlines) in model strings.

## Customizing the OpenCode Harness

### Modifying Agent Behavior

After install, the generated `.md` files in `.opencode/agents/` (or `~/.config/opencode/agents/`) are user-editable. Customize the prompt body, tool restrictions, or description as needed. Use `--force` on subsequent installs to reset to defaults.

### Creating a Custom OpenCode Harness

To create a modified version of this harness (e.g. different agent profiles, additional agents, custom install logic):

1. **Fork the plugin**: Copy `src/harnesses/opencode/` to a new npm package.
2. **Implement `HarnessPlugin`**: Modify `plugin.ts` to change install behavior.
3. **Customize templates**: Edit or add agent `.md` files with your desired prompts and tool configurations.
4. **Publish**: Name the package `@5x-ai/harness-opencode` to override the bundled version, or use a unique name (e.g. `@myorg/harness-opencode-custom`).

The key extension points:

- **`loader.ts`**: Add/remove/modify agent templates in the `AGENT_TEMPLATES` registry. Change model injection logic.
- **`plugin.ts`**: Change install behavior, add custom post-install steps, modify the install flow. Skills are loaded from the local `skills/loader.ts`.
- **`../locations.ts`**: Override install paths if targeting a different directory structure.
- **Agent templates**: Rewrite the prompt content, change tool restrictions, adjust the orchestrator's delegation patterns.

### Agent Roles and the 5x Protocol

The agent templates are designed around the 5x protocol's role system:

- **Author agents** produce work and output `AuthorStatus` JSON (`done | failed | needs_human`) validated by `5x protocol validate author`.
- **Reviewer agents** evaluate author work and output `ReviewerVerdict` JSON (`approved | rejected | escalate`) validated by `5x protocol validate reviewer`.
- **The orchestrator** manages the workflow loop: render prompt templates, delegate to subagents, validate outputs, and track run state via `5x run` commands.

Any custom harness that participates in the 5x workflow should maintain this protocol contract so that the orchestrator, quality gates, and run lifecycle work correctly.
