# 5x CLI

**Turn requirements into reviewed plans, then implement them one verified phase at a time.**

5x gives your coding agent a repeatable author/reviewer workflow: write a plan,
review it, implement a phase, run your checks, and review the result. You make
scope and design decisions; the CLI preserves progress, review evidence, and
decisions so work can resume across sessions.

```text
Requirements → Plan → Plan review → Implement phase → Quality checks → Code review
                        ↑ fix ↵                          ↑ fix ↵          │
                                                        Next phase ←─────┘
```

An **orchestrating agent** follows installed workflow skills and delegates bounded
tasks to author and reviewer agents. The **CLI** manages runs, worktrees, records,
validation, and governance. You can also compose its commands in scripts.

> **Version status:** This checkout contains the implemented changes for **2.0.0
> (unreleased)** since v1.3.0. The published npm version may differ. Check
> `5x --version` and the [changelog][changelog]. General semantic plan amendments
> and the dashboard are still pending; current output-format exceptions remain.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Everyday commands](#everyday-commands)
- [Configuration essentials](#configuration-essentials)
- [Reviews and approvals](#reviews-and-approvals)
- [Files, history, and worktrees](#files-history-and-worktrees)
- [Upgrading and recovery](#upgrading-and-recovery)
- [Documentation](#documentation)

## Install

You need [Bun](https://bun.sh) **1.1.0 or newer** on `PATH`, and Git for the
normal branch/worktree/commit workflow. Use a Git repository for implementation.
Install and authenticate the coding tool or provider you intend to use; OpenCode
is required only for OpenCode execution, not for every integration.

```bash
npm install -g @5x-ai/5x-cli
5x --version
5x --help
```

### Choose your integration

A **harness** connects 5x to the tool where you interact with the orchestrator.
A **provider** executes workers launched through `5x invoke`.

| Harness | Best fit | Worker execution |
| --- | --- | --- |
| `opencode` | OpenCode sessions with visible native child sessions | Native subagents by default; per-role invoke supported |
| `cursor` | Cursor with native subagent support | Native subagents by default; project rules guide orchestration |
| `universal` | Other tools that can load skills, or custom integrations | `5x invoke` through configured providers |

Native execution uses the host tool's authentication and model support. Invoke
execution needs the selected provider's executable/server and authentication.
The OpenCode provider is bundled; other providers are plugins. See
[setup and harnesses][getting-started] for paths, authentication, and scope choices.

## Quick start

### 1. Initialize and configure your repository

From your repository:

```bash
5x init
5x config show --text
```

`init` creates local state, document templates, and Git ignore/attribute entries.
It **does not create a root `5x.toml`**: built-in defaults apply until you customize
them. Configuration commands create the TOML file as needed.

Add the checks that actually validate your project. For example, for a Bun project:

```bash
5x config add qualityGates "bun test"
5x config add qualityGates "bun run lint"
```

The default quality-gate list is empty. Configure your author/reviewer models as
appropriate for your tool; the [configuration guide][configuration] covers model
overrides, providers, and mixed delegation. You can also ask your agent to use the
`5x-config` skill.

### 2. Install one harness

Choose the matching command:

```bash
5x harness install opencode --scope project
# or
5x harness install cursor --scope project
# or
5x harness install universal --scope project
```

Project scope keeps the integration with the repository. Use `--scope user` for
shared user-level assets. Universal skill discovery depends on your host tool;
point it at `.agents/skills/` if it does not discover that directory automatically.

Review and commit the generated project files before starting work. `.5x/` and
`5x.toml.local` are ignored; project harness assets and their `.5x-manifest.json`
belong together if you version them.

### 3. Ask your agent to run a workflow

In OpenCode, select the installed `5x-orchestrator` agent. In Cursor, the
project-level orchestrator rule guides skill selection. In other tools, load the
installed skills explicitly.

| Your goal | Example request |
| --- | --- |
| Create and review a plan | “Use 5x to create an implementation plan from `docs/product/my-feature-prd.md`.” |
| Review an existing plan | “Use 5x to review `docs/development/my-feature.md`.” |
| Execute an approved plan | “Use 5x to implement `docs/development/my-feature.md`, one phase at a time.” |

The agent loads the `5x` foundation plus `5x-plan`, `5x-plan-review`, or
`5x-phase-execution`. `5x-windows` adds PowerShell guidance when needed.

Expect a Markdown plan and reviews, code commits during implementation, and
tracked run records. The workflow asks you to resolve decisions it cannot make
from the approved scope. Plan generation/review and implementation are distinct
workflows; an approved plan is the starting point for implementation.

## Everyday commands

Use `--text` for terminal inspection. Most commands default to JSON for automation.

```bash
5x plan list --text                     # Plans and progress across Git sources
5x plan phases docs/development/my-feature.md --text
5x run list --text                      # Runs, including the ambient selection
5x run state --text                     # Current run, history, and governance
5x run watch --human-readable           # Stream worker logs
5x config show --text                   # Effective settings and defaults
5x harness sync                        # Refresh installed assets after changes
5x doctor --text                       # Diagnose project health
```

Run-scoped commands can infer the run from `FIVEX_RUN`, a unique linked-worktree
mapping, or the local `current-run` pointer. Pass `--run <id>` when selecting a
different run or when context is ambiguous. Invocation-registry commands use
explicit IDs. See [operations and recovery][operations].

`run watch` streams logs, not a dashboard. Use `run state` to inspect decisions,
budget usage, and completion readiness.

## Configuration essentials

Use `5x.toml` for shared settings and `5x.toml.local` for machine-local overrides.
Common changes are:

```bash
5x config set maxStepsPerRun 300
5x config set paths.plans docs/development
5x config set author.model anthropic/claude-sonnet-4-6
5x config set reviewer.model anthropic/claude-sonnet-4-6
5x config show --key author.model --text
```

Model IDs must be supported by the selected harness/provider; those above are
OpenCode-style examples. Per-harness `harnessModels` overrides let native tools
use their own model naming.

**Delegation is configured per role.** `native` uses a harness subagent;
`invoke` uses the configured external provider. A native author and invoke
reviewer, or the reverse, is supported. Universal always uses invoke. Installed
agent-file presence is not a substitute for reading this configuration.

Models and delegation settings are baked into installed harness assets. After
changing them, run:

```bash
5x harness sync
```

Plain `harness install` preserves existing agent files; `sync` establishes a
verified freshness baseline. Inspect local-edit conflicts before using `--force`,
which overwrites those edits. Surface freshness warnings when a run starts.

See [configuration][configuration] for defaults, monorepo layering, provider
plugins, timeouts, template overrides, and review-budget settings.

## Reviews and approvals

5x separates automated checks from independent review:

- **Quality gates** run your test/lint/build commands.
- **Plan review** assesses scope, design, estimates, and required corrections.
- **Implementation review** checks the implementation against the approved plan
  and, for bound runs, an exact recorded code range.
- **Human decisions** resolve scope, architecture, risk, and budget trade-offs.

Delivery budgets use work-item estimates and architecture-burden scores, not
token costs or currency. The CLI calculates forecasts and tracks whether promised
simplifications were actually delivered.

`reviewBudget.mode` defaults to **`advisory`**. **`enforced`** adds deterministic
review routing and durable gates; **`off`** uses the compatibility workflow.
Existing baselines/bindings retain their pinned mode. Advisory still applies
approved-source binding and plan-drift validation for budgeted implementation.

Inspect a governance gate with `5x review gate show`; submit its human decision
with `5x review decide`. Generic prompts do not resolve these gates.

For scripts and agents, `5x phase finish` combines quality, author-result
validation/recording, and checklist checks. **It does not grant reviewer approval
or replace the phase/run completion boundary.** See [automation][automation].

## Files, history, and worktrees

| Location | Purpose | Version control |
| --- | --- | --- |
| `docs/development/` | Default plan location | Track |
| `docs/development/reviews/` | Default review location | Track |
| `docs/development/runs/` | Default `paths.records`: run summaries, steps, decisions | Track |
| `.5x/` | Local SQLite index/coordination, logs, locks, worktrees, templates | Ignore |
| `5x.toml` / `5x.toml.local` | Shared / machine-local configuration | Track / ignore |
| Project harness directories | Installed skills, agents/rules, freshness manifest | Track together if shared |

Git-native records carry durable history with the plan branch. SQLite indexes
that history and also holds local coordination state. Sessions and transcripts
stay local. `5x records index` rebuilds record projections; it does not restore
local sessions or logs.

`5x run init --plan <path> --worktree` creates or attaches an isolated checkout.
Run-scoped execution resolves that checkout automatically while local coordination
stays in the repository's control plane. The plan argument is the implementation
plan path under `paths.plans`, not the requirements document.

See [operations][operations] for record checkpoints, branch-aware plan discovery,
worktree management, and what to do after moving or archiving plans.

## Upgrading and recovery

Updating the CLI package and migrating a project are separate actions. After
installing the intended CLI release:

```bash
5x upgrade
5x harness sync
5x doctor --text
```

`upgrade` reports harness freshness; automatic lossless sync is opt-in. Use
`5x records backfill --dry-run` to inspect migration of historical SQLite runs
before exporting them. Follow the [v1.3 → v2 migration guide][upgrading] for active
runs, prompt overrides, and compatibility details.

Start troubleshooting with `5x doctor --text`. Use `5x doctor --fix` for supported
safe repairs. For locks, inspect `5x lock list`; use `5x unlock <plan>` for targeted
recovery. Releasing a live holder requires explicit `--force`.

## Documentation

- [Setup and harnesses][getting-started] — installation paths and first workflow
- [Configuration][configuration] — models, providers, local overrides, monorepos
- [Operations and recovery][operations] — monitoring, records, worktrees, diagnosis
- [CLI reference][reference] — command map and output/exit contracts
- [Automation guide][automation] — workflow contracts for scripts and assistants
- [Upgrading to v2][upgrading] — migration from v1.3 and earlier versions
- [LLM documentation index][llms] — start here when helping a user operate 5x
- [Changelog][changelog] — implemented changes and release status

Contributors: see [AGENTS.md][agent-guide] for repository development conventions.
The numbered `docs/v0/`, `docs/v1/`, and `docs/v2/` trees contain architecture and
design history; proposals there may describe behavior that has not shipped.

## License

[MIT][license]

[getting-started]: https://github.com/Flying-Banana-Productions/5x-engineer/blob/main/5x-cli/docs/getting-started.md
[configuration]: https://github.com/Flying-Banana-Productions/5x-engineer/blob/main/5x-cli/docs/configuration.md
[operations]: https://github.com/Flying-Banana-Productions/5x-engineer/blob/main/5x-cli/docs/operations.md
[reference]: https://github.com/Flying-Banana-Productions/5x-engineer/blob/main/5x-cli/docs/cli-reference.md
[automation]: https://github.com/Flying-Banana-Productions/5x-engineer/blob/main/5x-cli/docs/automation.md
[upgrading]: https://github.com/Flying-Banana-Productions/5x-engineer/blob/main/5x-cli/docs/upgrading.md
[llms]: https://github.com/Flying-Banana-Productions/5x-engineer/blob/main/5x-cli/llms.txt
[changelog]: https://github.com/Flying-Banana-Productions/5x-engineer/blob/main/5x-cli/CHANGELOG.md
[agent-guide]: https://github.com/Flying-Banana-Productions/5x-engineer/blob/main/5x-cli/AGENTS.md
[license]: https://github.com/Flying-Banana-Productions/5x-engineer/blob/main/5x-cli/LICENSE
