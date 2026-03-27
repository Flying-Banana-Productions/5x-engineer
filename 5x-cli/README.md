# 5x CLI

A toolbelt of CLI primitives for AI-assisted implementation workflows. Manages run lifecycle, agent invocation, quality gates, and human interaction -- designed to be driven by an orchestrating agent loaded with a skill, or composed in scripts.

## How It Works

5x uses a three-layer architecture:

```
Layer 3: Orchestrating Agent (OpenCode 5x-orchestrator, Claude Code, ...)
         Loaded with a 5x skill (.md). Makes workflow decisions.
              |
              |  calls CLI commands as tools
              v
Layer 2: 5x CLI (this tool)
         Stateless primitives returning JSON envelopes.
         Manages persistence (SQLite), logging, sub-agent invocation.
              |
              |  native subagents (preferred) or 5x invoke (fallback)
              v
Layer 1: Sub-Agents (Workers)
         Author and reviewer agents.
         Preferred: harness-native subagents (5x-plan-author, 5x-code-author, 5x-reviewer).
         Fallback: 5x invoke with pluggable provider (OpenCode provider ships by default).
```

The CLI does not decide what to do next -- it provides building blocks. Orchestration logic lives in **skills**: markdown documents loaded into your agent session that describe the workflow (which commands to run, when to retry, when to ask the human).

### Native-First Subagent Execution

When running inside a supported harness (OpenCode or Cursor), author and reviewer work is
delegated to **native subagents** rather than external subprocess invocations.
The `5x-orchestrator` agent renders task prompts with `5x template render`,
launches the appropriate native child agent, and validates structured results
with `5x protocol validate`. This keeps all sub-agent work visible as native
child sessions in the harness UI.

`5x invoke` is retained as a fallback transport for unsupported harnesses and
for environments where the custom 5x agents have not been installed.

## Requirements

- [Bun](https://bun.sh) >= 1.1.0
- Git repository (recommended; safety checks and worktree features depend on it)
- [OpenCode](https://opencode.ai) installed and on `PATH` (for native subagent and fallback invocation)
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

### Option A: Native OpenCode Workflow (Recommended)

The recommended workflow uses OpenCode's native subagents so all author and
reviewer sessions appear as first-class child sessions in the OpenCode TUI.

1. Initialize in your repo:

```bash
5x init
```

2. Edit `5x.toml` -- set your models, quality gates, and paths.

3. Install the native OpenCode agents and skills:

```bash
# Project scope — installs to .opencode/skills/ and .opencode/agents/:
5x init opencode project

# Or user scope — installs to ~/.config/opencode/skills/ and ~/.config/opencode/agents/:
5x init opencode user
```

> **Note:** OpenCode uses `~/.config/opencode/` for user-scope assets, not
> `~/.opencode/`. The `5x init opencode user` command installs to the correct
> XDG-style path automatically.

4. Start an OpenCode session using the `5x-orchestrator` agent:

```bash
opencode
# Select or @mention the 5x-orchestrator agent, then describe your task:
# "Use the 5x-plan skill to generate an implementation plan from docs/product/my-feature-prd.md"
```

The orchestrator loads the skill, delegates author and reviewer work to native
subagents (`5x-plan-author`, `5x-code-author`, `5x-reviewer`), and guides you
through decision points.

### Option B: Universal Harness Workflow (Any Tool)

Use this when your tool does **not** have a dedicated 5x harness plugin (for
example: Claude Code, Windsurf, Aider, or custom setups).

The universal harness installs only skills (no agent profiles) to
agentskills.io convention paths. Delegation runs through `5x invoke`.

1. Initialize in your repo:

```bash
5x init
```

2. Edit `5x.toml` -- set your models, quality gates, and paths.

3. Install universal skills:

```bash
# Project scope -> .agents/skills/
5x harness install universal --scope project

# User scope -> ~/.agents/skills/
5x harness install universal --scope user
```

4. Start your agent session and load the skill:

```bash
# Example with any AI coding tool (e.g., Claude Code or Windsurf):
<your-tool-command>
# Then in the session, load the 5x-plan skill and point it at your PRD:
# "Use the 5x-plan skill to generate an implementation plan from docs/product/my-feature-prd.md"
```

The skill guides the agent through the full workflow: plan generation, review
cycles, phase execution with quality gates. In this mode, author/reviewer
delegation uses `5x invoke`.

5. Monitor progress from another terminal:

```bash
5x run watch --run <run-id> --human-readable
```

### Option C: Native Cursor Workflow

Use this when you run 5x from Cursor IDE or `cursor-agent` CLI.

1. Initialize in your repo:

```bash
5x init
```

2. Install Cursor harness assets:

```bash
# Project scope (recommended): installs to .cursor/skills/, .cursor/agents/, .cursor/rules/
# Requires `5x init` first.
5x harness install cursor --scope project

# User scope: installs to ~/.cursor/skills/ and ~/.cursor/agents/
# (rules are not file-backed at user scope)
5x harness install cursor --scope user
```

3. Start Cursor in the repo and trigger a workflow:

```text
Use 5x to generate an implementation plan from docs/product/my-feature-prd.md
```

Cursor will use the installed `5x-orchestrator` rule (project scope), load the
right skill (`5x-plan`, `5x-plan-review`, or `5x-phase-execution`), and
delegate to `5x-plan-author`, `5x-code-author`, and `5x-reviewer`.

> **User-scope limitation:** Cursor user rules are settings-managed (not
> file-backed). `5x harness install cursor --scope user` installs skills and
> subagents only.

> **Reducing approval prompts:** By default Cursor asks for confirmation on
> terminal commands and file edits. To run 5x workflows without interruption:
>
> - **Terminal commands:** `Cursor Settings → Agents → Auto-run mode` →
>   set to **"Run everything"** (full auto) or **"Use allowlist"** and add
>   `bun`, `git`, `5x` to the list.
> - **File edits:** `Cursor Settings → Agents` → disable
>   **"External file edit protection"**.
>
> The installed `5x-permissions.mdc` rule (`alwaysApply: true`) also
> pre-authorizes subagents to run `5x` commands and edit files without
> asking in-chat, reducing the "may I?" pauses independent of IDE settings.

### Option D: Bash Scripting

Commands return JSON envelopes (`{ "ok": true, "data": {...} }`) and compose via Unix pipes. Context (run ID, template variables) flows through the pipe chain automatically.

```bash
# Pipe-composed: run_id and plan_path flow from init to invoke automatically
5x run init --plan docs/development/001-impl-example.md | \
  5x invoke author author-next-phase --var phase_number=1 --record
```

For workflows that need branching logic, capture the envelope and use `jq`:

```bash
PLAN="docs/development/001-impl-example.md"
RUN_ID=$(5x run init --plan "$PLAN" | jq -r '.data.run_id')

# --record auto-records using the template's step_name
AUTHOR_OUT=$(5x invoke author author-next-phase --run "$RUN_ID" --record \
  --var phase_number=1)
RESULT=$(echo "$AUTHOR_OUT" | jq -r '.data.result.result')

# Quality output piped to run record (step name + run from CLI flags)
5x quality run | 5x run record "quality:check" --run "$RUN_ID"

5x run complete --run "$RUN_ID"
```

For native subagent workflows (render → detect → subagent → validate):

```bash
RUN_ID=$(5x run init --plan "$PLAN" | jq -r '.data.run_id')

# Render the task prompt
RENDERED=$(5x template render author-next-phase --run "$RUN_ID" \
  --var phase_number=1)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

# Detect native agent; fallback to 5x invoke
if [[ -f ".opencode/agents/5x-code-author.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-code-author.md" ]]; then
  RESULT=<native subagent result JSON>
else
  RESULT=$(5x invoke author author-next-phase --run "$RUN_ID" \
    --var phase_number=1 2>/dev/null)
fi

# Validate + record (works for both paths)
echo "$RESULT" | 5x protocol validate author \
  --run "$RUN_ID" --record --step "$STEP"
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

### Choosing a Harness

Use one harness per install scope:

| Harness | Use when | Delegation mode |
| --- | --- | --- |
| `opencode` | You use OpenCode and want native subagents in the harness UI | Native subagents (`Task` tool + `5x protocol validate`) |
| `cursor` | You use Cursor IDE / `cursor-agent` and want native subagents + project rule orchestration | Native Cursor subagents + `5x protocol validate` |
| `universal` | Your tool has no dedicated 5x harness plugin | `5x invoke` |

### Installing Skills

Skills are installed via the harness system.

OpenCode installs skills **and** native subagent profiles:

```bash
# Project scope: installs skills under .opencode/skills/ AND
# native subagent profiles under .opencode/agents/
5x harness install opencode --scope project

# User scope: installs under ~/.config/opencode/skills/ and
# ~/.config/opencode/agents/ (XDG path, NOT ~/.opencode/)
5x harness install opencode --scope user
```

Universal installs skills only (cross-client agentskills.io convention):

```bash
# Project scope: .agents/skills/<name>/SKILL.md
5x harness install universal --scope project

# User scope: ~/.agents/skills/<name>/SKILL.md
5x harness install universal --scope user
```

Cursor installs skills + native subagents in both scopes, and installs the
orchestrator rule in project scope:

```bash
# Project scope: .cursor/skills/, .cursor/agents/, .cursor/rules/
# Requires `5x init` first.
5x harness install cursor --scope project

# User scope: ~/.cursor/skills/ and ~/.cursor/agents/ (no rules)
5x harness install cursor --scope user
```

`.agents/skills/` (project) and `~/.agents/skills/` (user) are the
[agentskills.io](https://agentskills.io) cross-client convention paths.
5x writes files there; discovery behavior depends on each host tool's
implementation.

> **OpenCode path note:** OpenCode discovers user-scope assets at
> `~/.config/opencode/skills/` and `~/.config/opencode/agents/` (XDG-style),
> **not** `~/.opencode/`. Running `5x harness install opencode --scope user`
> writes to the correct path. If you install manually, ensure you use
> `~/.config/opencode/`, not `~/.opencode/`.

### Customizing

Skills are plain markdown. Edit the installed copies directly:

- OpenCode: `.opencode/skills/` or `~/.config/opencode/skills/`
- Cursor: `.cursor/skills/` or `~/.cursor/skills/`
- Universal: `.agents/skills/` or `~/.agents/skills/`

Re-run `5x harness install <harness> --scope <scope> --force` to reset them
to bundled defaults.

## Commands

All commands return JSON: `{ "ok": true, "data": {...} }` on success, `{ "ok": false, "error": {"code": "...", "message": "..."} }` on failure. Use `--help` on any command for full flag details.

### Run Lifecycle

```bash
5x run init --plan <path> [--allow-dirty] [--worktree [<path>]]
                                                # Start/resume run; optionally ensure/attach worktree
5x run state --run <id>                        # Get run state, steps, and summary
5x run record [step] [--run <id>] [--result '{}'] [--phase <p>] [--iteration <n>]
5x run complete --run <id> [--status aborted]  # Complete or abort a run
5x run reopen --run <id>                       # Re-activate a completed/aborted run
5x run list [--plan <path>] [--status active]  # List runs
5x run watch --run <id> [--human-readable]     # Tail agent logs in real-time
```

`run init` is idempotent -- returns the existing active run if one exists for the plan. `run record` uses INSERT OR IGNORE semantics (first write wins; corrections are new iterations). When piping from `invoke`, step name, run ID, result, and metadata are auto-extracted: `5x invoke ... | 5x run record`.

`run init --plan` takes the implementation plan output path, not the requirements doc path. The file may not exist yet, but it must live under `paths.plans`.

**Windows notes:**
- In PowerShell, prefer `--result @path/to/result.json` or `Get-Content result.json -Raw | 5x run record ... --result -` over inline JSON.
- On older Windows PowerShell, use `;` or separate lines instead of `&&`.

### Native Subagent Primitives

```bash
5x template render <template> [--run <id>] [--var key=value ...] [--session <id>] [--new-session]
5x template list                           # List all available prompt templates
5x template describe <template>            # Show detailed template metadata
```

`template render` renders a task prompt template and returns the result in a JSON envelope. When
`--run` is passed, resolves run/worktree context and appends a `## Context`
block with the effective working directory. When `--session` is passed and a
`<template>-continued` variant exists, the shorter continued template is used
automatically. `--new-session` forces a fresh session (skips continued-template selection).

```json
{
  "ok": true,
  "data": {
    "template": "reviewer-plan",
    "selected_template": "reviewer-plan-continued",
    "step_name": "reviewer:review",
    "prompt": "<rendered markdown>",
    "declared_variables": ["plan_path", "review_path"],
    "run_id": "run_abc123",
    "plan_path": "/abs/path/to/plan.md",
    "worktree_root": "/abs/path/to/worktree"
  }
}
```

`template list` returns all available prompt templates with descriptions. `template describe` shows full metadata including version, variables, defaults, step name, and whether an on-disk override is active.

```bash
5x protocol validate <author|reviewer> [--run <id>] [--record] [--step <name>]
                                        [--phase <name>] [--iteration <n>]
                                        [--require-commit | --no-require-commit]
5x protocol emit <author|reviewer> [flags]
```

`protocol validate` validates structured output from a native subagent or `5x invoke` fallback.
Accepts JSON via stdin or `--input`. Auto-detects input format: if the JSON
contains an `ok` field (from `5x invoke`), unwraps `.data.result` before
validation; otherwise treats the input as raw structured JSON (from a native
subagent). A single fenced JSON block is also accepted as input, but native
subagents should still return raw JSON with no markdown fences. With `--record`,
records the validated result as a run step in one command.

`--require-commit` defaults to `true` for author validation. Use
`--no-require-commit` to opt out.

`protocol emit` lets agents construct canonical structured output from CLI flags or piped JSON. Success output is raw canonical JSON to stdout (not wrapped in the `{ok, data}` envelope) so agents can use it directly as their structured result. Accepts alternative field names (e.g., `verdict` → `readiness`) and normalizes to the canonical schema.

### Agent Invocation (Fallback Transport)

```bash
5x invoke author <template> [--run <id>] [--var key=value ...] [--record]
5x invoke reviewer <template> [--run <id>] [--var key=value ...] [--record]
```

Invokes a sub-agent with a prompt template via an external provider (fallback
when native subagents are not installed). The author returns `AuthorStatus`
(`result: complete | needs_human | failed`), the reviewer returns
`ReviewerVerdict` (`readiness: ready | ready_with_corrections | not_ready`).

Key flags:
- `--run` -- run ID (optional when piping from an upstream command)
- `--var key=value` -- template variables (repeatable). Supports `--var key=@path` (read from file) and `--var key=@-` (read from stdin)
- `--record` / `--record-step` -- auto-record the result as a run step using the template's `step_name`
- `--phase`, `--iteration` -- metadata for `--record`
- `--session` -- resume an existing session (auto-selects an abbreviated prompt template if a `-continued` variant exists)
- `--model` (override config), `--timeout` (seconds), `--quiet` (suppress stderr), `--stderr` (force stderr in non-TTY)

Templates are resolved from `.5x/templates/prompts/` (user overrides, if installed via `5x init --install-templates`) then bundled defaults. Use `5x template list` to see all available templates.

### Quality Gates

```bash
5x quality run [--record --run <id>]    # Execute quality gates, optionally auto-record
```

Runs each command in `qualityGates` from config sequentially. Returns `{ passed: bool, results: [...] }`. With `--record`, the result is auto-recorded as a `quality:check` step. Can also pipe to `run record`: `5x quality run | 5x run record "quality:check" --run <id>`.

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
5x init [--force] [--install-templates]              # Scaffold config, templates, DB
5x harness install <name> [--scope user|project] [--force]  # Install harness skills + agents
```

`--install-templates` scaffolds editable prompt templates to `.5x/templates/prompts/` for customization. Without this flag, the CLI uses bundled templates directly (recommended for most users).

`5x init opencode project` installs skills under `.opencode/skills/` and agent profiles under
`.opencode/agents/` (requires `5x init` to have been run first).
`5x init opencode user` installs under `~/.config/opencode/skills/` and `~/.config/opencode/agents/`.

### Worktrees

```bash
5x worktree create --plan <path> [--branch <name>]   # Create isolated git worktree
5x worktree attach --plan <path> --path <worktree>   # Attach existing git worktree to plan
5x worktree detach --plan <path>                     # Remove plan->worktree mapping only
5x worktree remove --plan <path> [--force]            # Remove worktree
5x worktree list                                      # List active worktrees
```

`run init --worktree` resolves a plan worktree automatically: reuse existing DB mapping, attach a unique matching git worktree, or create a new default worktree when none exists. Use `--worktree <path>` (or `--worktree-path <path>`) to attach an explicit existing path. If worktree creation fails, `run init` now errors clearly and does not silently fall back to the main checkout; rerun without `--worktree` only when shared-checkout execution is intentional.

`worktree detach` reports the post-detach state (`worktree_path: null`, `branch: null`) and also includes `previous_worktree_path` / `previous_branch` for confirmation.

**Worktree-aware execution:** When a run is mapped to a worktree, all `--run`-scoped commands (`invoke`, `quality run`, `diff`) automatically resolve the mapped worktree as their execution context. No `cd` or `--workdir` is needed. No `.5x/` directory is required in worktree checkouts — all state stays in the root control-plane.

## Configuration

`5x init` creates `5x.toml`. Auto-discovered by walking up from the working directory. (`5x.config.js` / `.mjs` are also supported for backward compatibility.)

```toml
# 5x.toml

maxStepsPerRun = 50    # Hard limit on steps per run (prevents runaway loops)

# Shell commands run by `5x quality run`
qualityGates = [
  "bun test --concurrent --dots",
  "bun run lint",
  "bun run typecheck",
]

[author]
provider = "opencode"                  # "opencode" (default) or plugin name
model = "anthropic/claude-sonnet-4-6"
timeout = 300                          # Inactivity timeout in seconds
# continuePhaseSessions = true         # Require --session for continued reviews (opt-in)

[reviewer]
provider = "opencode"
model = "anthropic/claude-sonnet-4-6"
timeout = 120
# continuePhaseSessions = true

[paths]
plans = "docs/development"
reviews = "docs/development/reviews"
archive = "docs/archive"

[paths.templates]
plan = ".5x/templates/implementation-plan-template.md"
review = ".5x/templates/review-template.md"

[db]
path = ".5x"    # Directory path (DB file is always 5x.db within this directory)

[worktree]
postCreate = "bun install"
```

**Config layering:** In monorepos, sub-projects can have their own `5x.toml` that overrides the root config. Config resolution is anchored to the plan's location — run-scoped commands use `dirname(plan_path)` to find the nearest `5x.toml`. Objects merge deeply (sub-project inherits unset fields from root), arrays replace entirely, and `db` settings always come from the root config.

## Output Contract

### JSON Envelope

```jsonc
// Success (exit 0):
{ "ok": true, "data": { ... } }

// Error (exit 1-9):
{ "ok": false, "error": { "code": "RUN_NOT_FOUND", "message": "...", "detail": { ... } } }
```

Output is compact JSON when piped, pretty-printed when stdout is a TTY. Override with `--pretty` or `--no-pretty`. Streaming commands (`run watch`) write NDJSON lines or human-readable text to stdout instead of envelopes.

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
| 8 | Phase checklist incomplete / phase not found |
| 9 | Session required (continuePhaseSessions enabled, no --session provided) |
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

`5x` writes local state under `.5x/` in the **control-plane root** (the main repository root):

```
.5x/
  5x.db                          # SQLite: runs, steps, plans
  logs/<run-id>/agent-NNN.ndjson # Per-agent NDJSON event logs (0o700)
  locks/<hash>.lock              # Plan-level lock files
  worktrees/                     # Isolated git worktrees
  templates/                     # Plan and review templates (prompt templates opt-in via --install-templates)
  skills/                        # Bundled skill source (internal)
  debug/                         # Debug traces
```

**Control-plane model:** The root repository's `.5x/` directory is the single source of truth. All artifacts — DB, logs, locks, worktrees, templates — are anchored to this root, regardless of which checkout (root or linked worktree) a command is run from. Worktree checkouts do not need their own `.5x/` directory.

The control-plane root is resolved via `git rev-parse --git-common-dir`, so commands run from any linked worktree (including externally attached worktrees) automatically find the root state DB.

**Isolated mode:** If you run `5x init` in a worktree checkout whose parent repo is *not* 5x-managed (no root `.5x/5x.db`), a local state DB is created in that checkout. This is isolated mode — state is local to that worktree. If a root DB is later created, subsequent commands from the worktree switch to managed mode and use the root DB.

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
