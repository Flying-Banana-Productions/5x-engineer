# Setup and harnesses

[README](../README.md) · [Configuration](configuration.md) · [Operations](operations.md)

This guide describes the implemented 2.0.0 development line, currently unreleased.
Use `5x --version` and the [changelog](../CHANGELOG.md) to match your installation.

## Install the CLI

Install Bun >= 1.1.0 and Git, then:

```bash
npm install -g @5x-ai/5x-cli
5x --version
5x --help
```

The npm command installs the published package; it does not install unreleased
main-branch changes. For development from this repository, run `bun install` in
`5x-cli/`, then use `bun run src/bin.ts --help` from that directory. A local `bun
link` makes that checkout available as `5x` for testing in another repository.

Use a Git repository with an initial commit for implementation workflows. Some
inspection/setup commands work outside Git, but worktrees, commit evidence, and
git-native history depend on it.

## Initialize a project

```bash
5x init
5x config show --text
5x config add qualityGates "bun test"
```

Replace the example gate with your project's actual commands. Defaults contain
no quality gates. `init` creates `.5x/`, document skeletons under
`.5x/templates/`, `.gitignore` entries, and record merge attributes in
`.gitattributes`. It does not create root `5x.toml`; `config set` and `config add`
create it when needed.

The scaffolded skeletons are `implementation-plan-template.md` and
`review-template.md`. Configured `paths.templates.plan` and
`paths.templates.review` can select project-owned alternatives; inspect the
effective settings rather than assuming the skeleton location is the configured
path. [Template customization](configuration.md#templates) explains both kinds
of template.

## Install a harness

The harness is the host integration, not necessarily the worker's provider.
Choose one harness for a given workflow/install scope. Native harnesses can use
different execution modes per role; universal always delegates through invoke.

### OpenCode

Install and authenticate [OpenCode](https://opencode.ai) first.

```bash
5x harness install opencode --scope project
opencode
```

Select the `5x-orchestrator` agent. It loads the process skill and delegates to
`5x-plan-author`, `5x-code-author`, and `5x-reviewer`. Native child sessions are
visible in the host UI. Set model IDs supported by OpenCode, or use the host's
defaults when model configuration is omitted.

For user scope:

```bash
5x harness install opencode --scope user
```

User assets go under `~/.config/opencode/`, **not** `~/.opencode/`.

### Cursor

Use Cursor with native subagent support and authenticate through Cursor.

```bash
5x harness install cursor --scope project
```

Open the repository in Cursor and request a 5x workflow. Project scope installs
an orchestrator rule, skills, and author/reviewer subagent profiles. Configure
per-harness model IDs when Cursor's naming differs from your invoke provider.

```bash
5x harness install cursor --scope user
```

User scope installs skills and subagents only. Cursor user rules are
settings-managed, so there is no file-backed user orchestrator rule. Load the
workflow skills explicitly in that case. Host approval settings still control
command execution and edits; installed instruction files do not replace those
settings.

### Universal

Use this for other tools that can load Markdown skills:

```bash
5x harness install universal --scope project
# Or: 5x harness install universal --scope user
```

Universal installs skills at the agentskills.io convention paths. Host discovery
is tool-dependent: if the tool does not discover `.agents/skills/`, point it at
the installed `SKILL.md` files. It installs no native agent profiles. Workers use
`5x invoke`, so install/authenticate the chosen provider and configure its models.
OpenCode is the default invoke provider; it needs OpenCode available on `PATH`
for managed local execution, or a configured external OpenCode server.

## Install locations

| Harness | Project scope | User scope |
| --- | --- | --- |
| OpenCode | `.opencode/skills/`, `.opencode/agents/` | `~/.config/opencode/skills/`, `~/.config/opencode/agents/` |
| Cursor | `.cursor/skills/`, `.cursor/agents/`, `.cursor/rules/` | `~/.cursor/skills/`, `~/.cursor/agents/` |
| Universal | `.agents/skills/` | `~/.agents/skills/` |

Project installs require initialization. User installs are shared across projects;
their rendered models and delegation settings reflect the configuration used to
install/sync them. Prefer project scope when repositories need different settings.

The install root also contains `.5x-manifest.json`. Commit that manifest alongside
project assets when sharing them. `5x harness list --text` reports installations
and freshness; `5x harness sync` refreshes them after configuration or CLI changes.

## Start a workflow

Always load the `5x` foundation alongside the process skill:

| Skill | Input | Outcome |
| --- | --- | --- |
| `5x-plan` | Requirements/PRD/TDD | Plan generation and review/fix cycles |
| `5x-plan-review` | Existing plan | Review/fix cycles until approved or escalated |
| `5x-phase-execution` | Approved plan | Per-phase implementation, quality checks, code review |
| `5x-config` | Setup/configuration question | Configuration inspection and editing guidance |
| `5x-windows` | Windows/PowerShell environment | Supplement to the foundation/process skills |

Example request:

> Load the 5x foundation and 5x-plan skills. Create an implementation plan from
> docs/product/my-feature-prd.md, and review it before implementation.

After approval:

> Use 5x-phase-execution to implement docs/development/my-feature.md. Ask me at
> phase boundaries before proceeding.

The CLI's `run init --plan` takes the **plan output path** under `paths.plans`,
not the requirements path. A plan-generation run may initialize before that file
exists. The agent uses the configured paths and templates to write the artifacts.

Review/commit generated project configuration and harness files before execution,
or explicitly choose worktree isolation. A normal shared-checkout run checks for
uncommitted changes; `--allow-dirty` is an explicit opt-out.

## Plan documents

Plans use Markdown phase headings and checklists:

```markdown
## Phase 1: Atomic settings writes

**Completion gate:** Either both writes succeed or neither persists.

- [ ] Use the transaction helper and test rollback on the second write
```

This is a checklist-format illustration, not a complete approval artifact. Use the
installed implementation-plan skeleton for a full plan, including its Delivery
Budget ledger, stable work-item IDs, design, and acceptance criteria. Debt claims
are needed only when claiming a concrete simplification. `5x plan phases <path>`
reports checklist progress; a checked checklist or an editable “Approved” status
does not substitute for governed review evidence.
