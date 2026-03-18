# Changelog

All notable changes to `@5x-ai/5x-cli` will be documented in this file.

Format: categorized summary per release, newest first. Each entry is the
source of truth for the corresponding GitHub Release.

## 1.0.0 (2026-03-18)

### Breaking Changes

- **CLI framework migration** — migrated from citty to commander.js. All
  commands retain the same names and semantics, but help output formatting
  and error messages have changed.
- **Environment variable renamed** — `5X_OUTPUT_FORMAT` renamed to
  `FIVEX_OUTPUT_FORMAT` for POSIX compliance.
- **Skills moved to harness** — skill files are no longer scaffolded by
  `5x init`. They are now installed via `5x harness install opencode` and
  live in the OpenCode harness module.

### Features

- **v1 architecture** — complete rewrite of the agent provider system with
  the `AgentProvider` interface, OpenCode provider (managed and external
  server modes), and provider factory with plugin support.
- **Human-readable output** — `--text` / `--json` output modes across all
  commands. Text mode is default for TTY, JSON for pipes. Custom formatters
  for diff, run state, run list, and plan phases.
- **Harness system** — pluggable harness architecture for agent-specific
  integrations. Bundled OpenCode harness with agent templates and skill
  files. `5x harness install`, `5x harness list`, and `5x harness uninstall`
  commands.
- **Worktree-authoritative execution** — `5x run init --worktree` creates
  isolated git worktrees per plan. All `--run`-scoped commands auto-resolve
  the mapped worktree. Quality gates, diffs, and invocations execute in the
  correct worktree without manual `cd`.
- **Native workflow primitives** — `5x template render` and
  `5x protocol validate` commands for composable agent orchestration.
  Templates produce structured JSON envelopes with prompts, step names, and
  variables.
- **Protocol emit** — `5x protocol emit` command for generating structured
  author/reviewer output from agent responses.
- **Pipe infrastructure** — `5x invoke` reads upstream context from stdin,
  `5x run record` accepts piped input, `--var key=@-` reads from stdin and
  `--var key=@path` reads from files.
- **Human interaction commands** — `5x prompt choose`, `5x prompt confirm`,
  `5x prompt input` with /dev/tty fallback for non-interactive environments.
- **Config show** — `5x config show` displays the fully resolved runtime
  configuration with `--context` flag for monorepo sub-project overrides.
- **Template management** — `5x template list` and `5x template describe`
  subcommands. Stale on-disk template override detection with version
  warnings.
- **Session management** — session continuation enforcement when
  `reviewer.continuePhaseSessions` is enabled. `--session` and
  `--new-session` flags for explicit session control.
- **Quality gate improvements** — `skipQualityGates` config option,
  quality gates execute in sub-project cwd for layered configs, git env
  vars stripped from subprocess environments.
- **Run watch** — `5x run watch` command for monitoring agent session logs
  with `--stderr` flag.
- **Upgrade command** — `5x upgrade` with auto-update of stale stock
  prompt templates.

### Improvements

- **Task tool delegation in skills** — opencode skills now delegate to
  subagents via the Task tool's `subagent_type` parameter instead of
  filesystem-based agent detection with `5x invoke` fallback.
- **Foundation skill** — shared `5x` skill covering delegation patterns,
  human interaction model, session reuse, and cross-cutting gotchas.
  Extracted from repeated content across process skills.
- **Checklist verification** — `5x protocol validate author` enforces
  phase checklist completion via `5x plan phases`. Phase completion
  records `phase:checklist_mismatch` on failure instead of silently
  proceeding.
- **Config path resolution** — all `paths.*` values resolved to absolute
  paths after config loading. Layered config discovery bounded to
  control-plane root.
- **Handler extraction** — all command handlers extracted from CLI adapters
  with `startDir` parameter for direct testability without subprocess
  overhead.
- **Test infrastructure** — unit/integration test separation, `cleanGitEnv()`
  helper for subprocess isolation, `stdin: "ignore"` convention, concurrent
  test execution support.

### Fixes

- Plan paths re-rooted to main repo when CWD is inside a worktree.
- Review documents always committed after reviewer invocation.
- Numeric phase references validated with strict parsing.
- Run init validates output plan paths.
- Config discovery skips worktree root to prevent split-brain resolution.
- Lock files use ownership-safe cleanup.
- Non-zero exit codes propagated correctly from quality gates and watches.

## 0.2.0 (2026-03-03)

### Features

- **Session continuation** — agents can resume prior sessions across phase
  execution cycles, preserving context and reducing redundant work.
- **Reviewer session reuse** — the reviewer retains its session across
  review cycles within a phase, enabling follow-up reviews that reference
  prior feedback.
- **Model overrides** — `--author-model` and `--reviewer-model` flags allow
  per-run model selection without changing config.
- **Customizable prompt templates** — prompt templates can be overridden via
  `.5x/templates/` on disk, enabling project-specific tuning.
- **Separate plan and impl review workflows** — plan reviews and
  implementation reviews use distinct templates and produce separate review
  documents, preventing cross-contamination.

### Fixes

- DB-backed phase status with correct monorepo path resolution.
- `--allow-dirty` now respected in phase checkpoint gate.
- Review docs always committed at phase gate regardless of `--allow-dirty`.
- Worktree paths resolved correctly in monorepo subfolders.
- Reject continue-session input when ineligible in TUI gate.
- Clear reviewer session on invalid verdict to prevent stale state.

### Improvements

- Stronger author commit prompting to prevent missing commit hashes —
  structured summary prompt and all author templates now warn that a
  `complete` result without a commit hash triggers automatic escalation.
- Guidance option added to plan-review escalation gate.

## 0.1.1 (2026-02-26)

Initial public release. Core orchestrator with plan generation, phased
execution, automated code review, and human escalation gates.
