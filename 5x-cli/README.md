# 5x CLI

`5x-cli` automates a practical author/reviewer loop for implementation plans:

- Generate a plan from a PRD/TDD (`5x plan`)
- Review/fix the plan until approved (`5x plan-review`)
- Execute phases with quality gates + re-review (`5x run`)

It is built for Bun and uses OpenCode under the hood for agent execution.

## Requirements

- Bun `>=1.1.0`
- Git repository (recommended; some safety checks and worktree features depend on it)
- `opencode` installed and available on `PATH`
- Provider API keys configured for the models you use (for example via `.env` / `.env.local`)

## Install

```bash
npm install -g @5x-ai/5x-cli
```

Verify:

```bash
5x --help
```

## Quick Start

1. Initialize in your repo:

```bash
5x init
```

2. Update `5x.config.js` (models, quality gates, paths).

3. Generate a plan from a PRD/TDD markdown file:

```bash
5x plan docs/product/123-prd-example.md
```

4. Review and iterate on that plan:

```bash
5x plan-review docs/development/001-impl-example.md
```

5. Execute implementation phases:

```bash
5x run docs/development/001-impl-example.md
```

Use `--auto` for unattended loops and `--ci` for non-interactive permission auto-approval.

## Expected Plan Format

Plan files should be markdown with phase headings and checklists. Example:

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

`5x status` uses this structure to compute progress.

## Configuration

`5x` auto-discovers `5x.config.js` (or `5x.config.mjs`) by walking up from the current directory.

```js
/** @type {import('5x-cli').FiveXConfig} */
export default {
  author: {
    model: "opencode/kimi-k2.5",
    timeout: 120,
  },
  reviewer: {
    model: "openai/gpt-5.2",
    timeout: 120,
  },
  qualityGates: [
    "bun test --concurrent --dots",
    "bun run lint",
    "bun run typecheck"
  ],
  worktree: {
    postCreate: "bun install"
  },
  paths: {
    plans: "docs/development",
    reviews: "docs/development/reviews",
    archive: "docs/archive",
    templates: {
      plan: ".5x/templates/implementation-plan-template.md",
      review: ".5x/templates/review-template.md"
    }
  },
  db: {
    path: ".5x/5x.db"
  },
  maxReviewIterations: 5,
  maxQualityRetries: 3,
  maxAutoIterations: 10,
  maxAutoRetries: 3,
};
```

## Commands

- `5x init`
  - Bootstraps `5x.config.js`
  - Creates `.5x/` and default templates
  - Adds `.5x/` to `.gitignore`
- `5x plan <prd-path>`
  - Generates a new `NNN-impl-*.md` plan by default
  - Use `--out` to override path
- `5x plan-review <plan-path>`
  - Runs reviewer/author loop on the plan
  - Reuses existing review file when possible
- `5x run <plan-path>`
  - Executes phases (author -> quality gates -> reviewer -> fix loops)
  - Supports `--worktree` for isolated execution
- `5x status <plan-path>`
  - Shows markdown checklist progress
  - Shows active/latest DB run state when available
- `5x worktree status <plan-path>`
  - Shows associated worktree/branch
- `5x worktree cleanup <plan-path> [--delete-branch] [--force]`
  - Removes plan worktree and optionally branch (if merged)

## Common Flags

- `--auto`: skip some interactive gates; still escalates human-required items
- `--ci`: non-interactive mode; auto-approves all tool permissions
- `--tui-listen`: enable external TUI attach integration (default: off; `--no-tui-listen` forces off)
- `--allow-dirty`: bypass clean-working-tree guard
- `--quiet`: suppress formatted agent output (logs still written)
- `--show-reasoning`: display reasoning stream inline
- `--debug-trace` (`run`, `plan-review`): write detailed lifecycle traces to `.5x/debug`

### Flag Interactions (`--tui-listen`)

| `--tui-listen` | Where prompts/gates run | CLI stream output | `--show-reasoning` effect |
| --- | --- | --- | --- |
| disabled (default) | CLI terminal | Normal headless output | Visible in CLI output |
| enabled | CLI terminal | CLI output still active | Visible in CLI output |

`--tui-listen` is observability-only (session focus + notifications). Human decisions are always entered in the CLI terminal.

Precedence:

- `--quiet` overrides TUI listening (forces headless output behavior).
- `--auto` (`run` / `plan-review`) changes loop control with or without TUI listening: skips normal human gates, still escalates `human_required`, and auto-continues escalations with no guidance (best judgment) up to retry limits before aborting.

## Runtime Artifacts

`5x` writes local state under `.5x/`:

- `.5x/5x.db`: SQLite run state
- `.5x/logs/<run-id>/`: per-agent NDJSON event logs
- `.5x/locks/`: plan-level lock files
- `.5x/worktrees/`: optional isolated git worktrees
- `.5x/templates/`: default editable plan/review templates

Agent logs can include sensitive code/context. Keep `.5x/` out of version control.

## CI / Headless Usage

For unattended runs:

```bash
5x plan-review docs/development/001-impl-example.md --auto --ci
5x run docs/development/001-impl-example.md --auto --ci
```

## Troubleshooting

- `OpenCode server failed to start`
  - Ensure `opencode` is installed and on `PATH`.
- `Working tree has uncommitted changes`
  - Commit/stash, or pass `--allow-dirty` if intentional.
- Non-interactive prompt errors
  - Use `--auto` and/or `--ci` depending on command.
- No progress shown in `5x status`
  - Confirm plan file uses `## Phase N: ...` headings and markdown checklists.

## License

MIT
