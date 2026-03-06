# 5x CLI

A toolbelt of CLI primitives for AI-assisted implementation workflows. Manages run lifecycle, agent invocation, quality gates, and human interaction -- designed to be driven by an orchestrating agent loaded with a skill, or composed in scripts.

## How It Works

5x uses a three-layer architecture:

```
Layer 3: Orchestrating Agent (Claude Code, OpenCode, ...)
         Loaded with a 5x skill (.md). Makes workflow decisions.
              |
              |  calls CLI commands as tools
              v
Layer 2: 5x CLI (this tool)
         Stateless primitives returning JSON envelopes.
         Manages persistence (SQLite), logging, sub-agent invocation.
              |
              |  5x invoke author/reviewer
              v
Layer 1: Sub-Agents (Workers)
         Author and reviewer agents. Pluggable providers.
         Currently ships with OpenCode provider.
```

The CLI does not decide what to do next -- it provides building blocks. Orchestration logic lives in **skills**: markdown documents loaded into your agent session that describe the workflow (which commands to run, when to retry, when to ask the human).

## Requirements

- [Bun](https://bun.sh) >= 1.1.0
- Git repository (recommended; safety checks and worktree features depend on it)
- [OpenCode](https://opencode.ai) installed and on `PATH` (for sub-agent invocation)
- Provider API keys configured for the models you use (e.g., via `.env` / `.env.local`)

## Install

```bash
npm install -g @5x-ai/5x-cli
```

Verify:

```bash
5x --help
```

## Quick Start

### Option A: With an Agent Harness

This is the intended workflow. Your agent (OpenCode, Claude Code, etc.) loads a 5x skill and drives the CLI.

1. Initialize in your repo:

```bash
5x init
```

2. Edit `5x.config.js` -- set your models, quality gates, and paths.

3. Install skills so your agent can discover them:

```bash
5x skills install project            # installs to .agents/skills/
# or for a specific agent client:
5x skills install project --install-root .opencode
```

4. Start your agent session and load the skill:

```bash
# Example with OpenCode:
opencode
# Then in the session, load the 5x-plan skill and point it at your PRD:
# "Use the 5x-plan skill to generate an implementation plan from docs/product/my-feature-prd.md"
```

The skill guides the agent through the full workflow: plan generation, review cycles, phase execution with quality gates.

5. Monitor progress from another terminal:

```bash
5x run watch --run <run-id> --human-readable
```

### Option B: Bash Scripting

Every 5x command returns a JSON envelope (`{ "ok": true, "data": {...} }`), making it straightforward to compose in scripts with `jq`.

A complete single-phase author/review loop:

```bash
# Initialize a run
RUN_ID=$(5x run init --plan docs/development/001-impl-example.md | jq -r '.data.run_id')

# Invoke the author agent
5x invoke author author-next-phase \
  --run "$RUN_ID" \
  --var plan_path=docs/development/001-impl-example.md \
  --var phase_number=1

# Run quality gates
5x quality run

# Invoke the reviewer
5x invoke reviewer reviewer-commit \
  --run "$RUN_ID" \
  --var plan_path=docs/development/001-impl-example.md \
  --var phase_number=1 \
  --var "diff=$(5x diff | jq -r '.data.diff')"

# Complete the run
5x run complete --run "$RUN_ID"
```

See [`examples/author-review-loop.sh`](examples/author-review-loop.sh) for a full working script with error handling and review-fix cycles.

## Upgrading from v0.2.0

v1 is a ground-up redesign. The high-level orchestrator commands (`5x plan`, `5x plan-review`, `5x run <plan>`) have been removed. Orchestration now lives in agent skills, not TypeScript state machines.

**What changed:**

- **Commands replaced:** `5x plan`, `5x plan-review`, `5x run <plan>`, `5x status` are gone. Use the v1 primitives (`run init/state/record/complete`, `invoke author/reviewer`, `quality run`, etc.) via skills or scripts.
- **Flags removed:** `--auto`, `--ci`, `--tui-listen` no longer exist. Non-interactive behavior is handled by `5x prompt` commands with `--default` values. Skills decide retry/escalation logic.
- **Config:** `maxAutoIterations` is deprecated (still accepted with a warning). Use `maxStepsPerRun` instead. New fields: `author.provider`, `reviewer.provider` for pluggable agent backends.
- **Database:** Schema migrated from v0 tables (`agent_results`, `quality_results`, `run_events`) to a unified `steps` journal. In-progress v0 runs are marked aborted on first migration. No manual migration needed.
- **Output:** All commands return structured JSON envelopes to stdout. Streaming commands (`run watch`) are documented exceptions.

For the full architecture rationale, see [`docs/v1/100-architecture.md`](docs/v1/100-architecture.md).

## Skills

Skills are markdown documents that teach an agent how to drive the 5x workflow. Three are bundled:

| Skill | Purpose |
| --- | --- |
| `5x-plan` | Generate an implementation plan from a PRD/TDD, then review/fix until approved |
| `5x-plan-review` | Run iterative review/fix cycles on an existing plan |
| `5x-phase-execution` | Execute phases: author, quality gates, code review, fix loops |

### Installing Skills

```bash
# Project-level (committed to repo, any agent can discover them):
5x skills install project

# User-level (global, in ~/.agents/skills/):
5x skills install user

# For a specific agent client directory:
5x skills install project --install-root .claude
```

Skills follow the [agentskills.io](https://agentskills.io) convention. Once installed, agents that support skill discovery will find them automatically.

### Customizing

Skills are plain markdown. After `5x init`, find them in `.5x/skills/` -- edit freely. The installed copies in `.agents/skills/` are what agents actually load; re-run `5x skills install` after editing to update them.

## Commands

All commands return JSON: `{ "ok": true, "data": {...} }` on success, `{ "ok": false, "error": {"code": "...", "message": "..."} }` on failure. Use `--help` on any command for full flag details.

### Run Lifecycle

```bash
5x run init --plan <path> [--allow-dirty]     # Start or resume a run for a plan
5x run state --run <id>                        # Get run state, steps, and summary
5x run record <step> --run <id> --result '{}' [--phase <p>] [--iteration <n>]
5x run complete --run <id> [--status aborted]  # Complete or abort a run
5x run reopen --run <id>                       # Re-activate a completed/aborted run
5x run list [--plan <path>] [--status active]  # List runs
5x run watch --run <id> [--human-readable]     # Tail agent logs in real-time
```

`run init` is idempotent -- returns the existing active run if one exists for the plan. `run record` uses INSERT OR IGNORE semantics (first write wins; corrections are new iterations).

### Agent Invocation

```bash
5x invoke author <template> --run <id> [--var key=value ...] [--model <m>]
5x invoke reviewer <template> --run <id> [--var key=value ...] [--model <m>]
```

Invokes a sub-agent with a prompt template. The author returns `AuthorStatus` (`result: complete | needs_human | failed`), the reviewer returns `ReviewerVerdict` (`readiness: ready | ready_with_corrections | not_ready`).

Key flags: `--var` (template variables, repeatable), `--model` (override config), `--session` (resume session), `--timeout` (seconds), `--quiet` (suppress stderr stream), `--stderr` (force stderr output in non-TTY contexts).

Templates are resolved from `.5x/templates/prompts/` (user overrides) then bundled defaults.

### Quality Gates

```bash
5x quality run    # Execute all configured quality gates
```

Runs each command in `qualityGates` from config sequentially. Returns `{ passed: bool, results: [...] }`.

### Inspection

```bash
5x plan phases <path>                   # Parse plan into phases with progress
5x diff [--since <ref>] [--stat]        # Git diff (working tree or since ref)
```

### Human Interaction

```bash
5x prompt choose <message> --options a,b,c [--default a]
5x prompt confirm <message> [--default yes]
5x prompt input <message> [--multiline]
```

When stdin is not a TTY: returns `--default` if provided, otherwise exits with code 3 (`NON_INTERACTIVE`). This makes scripts safe by default.

### Setup

```bash
5x init [--force]                                    # Scaffold config, templates, skills
5x skills install <project|user> [--install-root <dir>] [--force]
```

### Worktrees

```bash
5x worktree create --plan <path> [--branch <name>]   # Create isolated git worktree
5x worktree remove --plan <path> [--force]            # Remove worktree
5x worktree list                                      # List active worktrees
```

## Configuration

`5x init` creates `5x.config.js` (or `.mjs`). Auto-discovered by walking up from the working directory.

```js
/** @type {import('5x-cli').FiveXConfig} */
export default {
  author: {
    provider: "opencode",         // "opencode" (default) or plugin name
    model: "anthropic/claude-sonnet-4-6",
    timeout: 300,                 // seconds per invocation
  },
  reviewer: {
    provider: "opencode",
    model: "anthropic/claude-sonnet-4-6",
    timeout: 120,
  },

  // Shell commands run by `5x quality run`
  qualityGates: [
    "bun test --concurrent --dots",
    "bun run lint",
    "bun run typecheck",
  ],

  // Hard limit on steps per run (prevents runaway loops)
  maxStepsPerRun: 50,

  paths: {
    plans: "docs/development",
    reviews: "docs/development/reviews",
    archive: "docs/archive",
    templates: {
      plan: ".5x/templates/implementation-plan-template.md",
      review: ".5x/templates/review-template.md",
    },
  },

  db: { path: ".5x/5x.db" },

  worktree: {
    postCreate: "bun install",    // runs after worktree creation
  },
};
```

## Output Contract

### JSON Envelope

```jsonc
// Success (exit 0):
{ "ok": true, "data": { ... } }

// Error (exit 1-7):
{ "ok": false, "error": { "code": "RUN_NOT_FOUND", "message": "...", "detail": { ... } } }
```

Streaming commands (`run watch`) write NDJSON lines or human-readable text to stdout instead of envelopes. Pre-streaming errors still use the envelope format.

### Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | General error |
| 2 | Resource not found (template, plan, provider) |
| 3 | Non-interactive / EOF (TTY required, no default provided) |
| 4 | Plan locked by another process |
| 5 | Dirty worktree |
| 6 | Max steps exceeded |
| 7 | Invalid structured output from agent |
| 130 | Interrupted (SIGINT) |

## Plan Format

Plan files are markdown with phase headings and checklists:

```md
# Add Example Feature

**Version:** 1.0
**Status:** Draft

## Phase 1: Data model updates

**Completion gate:** New schema is migrated and validated.

- [ ] Add migration
- [ ] Add unit tests

## Phase 2: API endpoints

**Completion gate:** Endpoints pass integration tests.

- [ ] Implement handlers
- [ ] Add integration tests
```

`5x plan phases` uses this structure to extract phase metadata and checklist progress.

## Runtime Artifacts

`5x` writes local state under `.5x/`:

```
.5x/
  5x.db                          # SQLite: runs, steps, plans
  logs/<run-id>/agent-NNN.ndjson # Per-agent NDJSON event logs (0o700)
  locks/<hash>.lock              # Plan-level lock files
  worktrees/                     # Isolated git worktrees
  templates/                     # Editable plan, review, and prompt templates
  skills/                        # Bundled skill source (internal)
```

Logs may contain sensitive code and context. Keep `.5x/` out of version control (added to `.gitignore` by `5x init`).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `OpenCode server failed to start` | Ensure `opencode` is installed and on `PATH` |
| `Working tree has uncommitted changes` | Commit/stash, or pass `--allow-dirty` |
| `NON_INTERACTIVE` exit code 3 | Provide `--default` on prompt commands, or run in a TTY |
| `PLAN_LOCKED` | Another process holds the lock. Wait for it, or check for stale locks in `.5x/locks/` |
| `MAX_STEPS_EXCEEDED` | Increase `maxStepsPerRun` in config, or investigate why the run is looping |
| No phases found by `5x plan phases` | Ensure plan uses `## Phase N: ...` headings with markdown checklists |
| Agent output not visible during `invoke` | stderr streaming is TTY-gated. Use `--stderr` to force it, or run `5x run watch` in another terminal |

## License

MIT
