# Changelog

All notable changes to `@5x-ai/5x-cli` will be documented in this file.

Format: categorized summary per release, newest first. Each entry is the
source of truth for the corresponding GitHub Release.

## 1.1.1-beta.3 (2026-03-27)

### Fixes

- **CRLF-safe review parsing** — review summary parsing now handles Windows
  CRLF line endings correctly, preventing dropped readiness/addendum and
  priority-item detection in review markdown.
- **CLI version reporting** — `5x --version` now reads directly from
  `package.json`, keeping the reported CLI version aligned with published npm
  releases.

### Improvements

- **Version regression coverage** — added a CLI integration test that asserts
  `--version` matches `package.json`, alongside CRLF review-parser coverage.

## 1.1.1-beta.2 (2026-03-27)

### Fixes

- **CRLF-safe phase parsing** — `5x plan phases` now parses Windows-authored
  plans with CRLF line endings correctly, restoring phase headings,
  completion gates, and checklist detection.
- **Mapped worktree plan lookup** — `5x plan phases` now reads the mapped
  worktree copy even when the canonical repo path has not been created yet,
  eliminating false `PLAN_NOT_FOUND` failures in worktree-first flows.

### Improvements

- **Optional Windows skill** — added a bundled `5x-windows` supplemental skill
  with PowerShell, path quoting, JSON parsing, and worktree-path guidance so
  Windows-specific ergonomics stay out of the main foundation skill by default.
- **Windows command help** — `5x plan phases --help` and README examples now
  include PowerShell-friendly parsing guidance and a `worktree_plan_path`
  fallback hint.
- **Regression coverage** — added parser, integration, harness, and skill-loader
  tests for CRLF handling, missing canonical plans with mapped worktree copies,
  and supplemental-skill installation.

## 1.1.1-beta.1 (2026-03-27)

### Fixes

- **Windows worktree branch naming** — plan-derived branch and worktree slugs
  now normalize Windows-style paths before generating git refs, preventing
  invalid branch names like `5x/D:\...` during `5x run init --worktree`.
- **Protocol validation input** — `5x protocol validate` now accepts a single
  fenced JSON block in addition to raw JSON, reducing friction when native
  subagents accidentally wrap structured output in markdown fences.
- **Plan commit scope** — plan-generation and plan-review author prompts now use
  file-scoped `5x commit --files <plan>` commands instead of `--all-files`,
  reducing scope bleed into unrelated bootstrap or harness files.

### Improvements

- **Worktree failure messaging** — `run init --worktree` now reports more
  clearly when no worktree was created or attached, making fallback behavior
  explicit.
- **Windows docs and guardrails** — README guidance now includes PowerShell-
  friendly `run record` usage, and plan-author harness prompts explicitly
  require raw JSON final output with no markdown fences.
- **Regression coverage** — added tests for Windows-style plan paths, fenced
  protocol input, scoped plan commits, and the template-render no-worktree
  context assertion.

## 1.1.1-beta.0 (2026-03-26)

### Features

- **Windows platform helpers** — new `src/utils/platform.ts` exports
  `getPlatformShell()` and `getPlatformHome()` helpers that return
  platform-appropriate values on Windows vs. POSIX, laying the groundwork
  for Windows 10/11 support.

### Fixes

- **Windows blocking fixes** — wired platform helpers throughout the CLI
  to resolve shell and home-directory resolution failures on Windows.

### Improvements

- **Cross-platform test infrastructure** — added `test/integration/` script
  and lock tests that exercise the CLI binary on non-POSIX paths, ensuring
  CI coverage for Windows compatibility.
- **Cursor harness model overrides** — `harnessModels` overrides now apply
  correctly when the `cursor` harness is selected via `harness install`.

## 1.1.0 (2026-03-25)

### Features

- **Per-harness model overrides** — optional `[author|reviewer].harnessModels` in
  `5x.toml` maps harness names (e.g. `opencode`, `cursor`) to model id strings
  for `5x harness install`, with fallback to `[author|reviewer].model`. Exported
  helper: `resolveHarnessModelForRole`. Documented in the default config template
  and each bundled harness README.
- **Universal harness** — new `universal` harness plugin installs 5x skills
  and agents into any directory (`.agents/`, `.skills/`), suitable for agents
  and tools not covered by a dedicated harness.
- **Cursor harness** — new `cursor` harness installs skills, subagents
  (`5x-plan-author`, `5x-code-author`, `5x-reviewer`), an orchestrator rule,
  and a permissions rule into `.cursor/` (project scope) or `~/.cursor/`
  (user scope). Covers both Cursor IDE and cursor-agent CLI. User-scope rule
  limitation is surfaced explicitly in install output.
- **Shared skill template system** — base skill templates extracted to
  `src/skills/base/` and rendered via `renderAllSkillTemplates()`. Harnesses
  consume shared templates with harness-specific terminology adaptation
  (`native` mode for non-OpenCode harnesses), eliminating per-harness skill
  copies.
- **`5x commit` command** — dedicated commit command that stages files,
  commits, and records the commit in the run journal. Authors use
  `5x commit --run <id>` in place of raw `git commit`.
- **Harness rule support** — optional `rulesDir`, `ruleNames`, `rules`
  install/uninstall summaries, `unsupported`, `warnings`, and `capabilities`
  fields added to the harness plugin contract. `installRuleFiles()` and
  `uninstallRuleFiles()` helpers added to the installer.
- **Scope-aware `describe(scope?)`** — harness plugins return scope-aware
  metadata including `capabilities.rules` used by `harness list` to show
  rules or an unsupported notice per scope.

### Fixes

- Prevent `readUpstreamEnvelope` from blocking on dangling stdin pipe.
- Fix `review_path` doubling when worktree path is already inside
  `worktreeRoot`.
- Fix quality gates using sub-project cwd for layered configs instead of
  worktree root.
- Fix `git:commit` phase resolution and reviewer template compliance.
- Fix native skill template parity with historical OpenCode content.
- Fix text duplication after tool calls in stream output.
- Fix OpenCode provider permission hang and duplicate stream output.
- Fix `discoverConfigFile` escaping project root boundary.
- Fix clear error when creating a worktree in an empty repo (no commits).
- Fix `--record-step` flag usage in `5x invoke` blocks.

### Improvements

- `continuePhaseSessions` now defaults to `true` for the reviewer agent.
- `harness list` shows rule files and a "rules: unsupported" notice for user
  scope; includes `capabilities` and `unsupported` fields in JSON output.
- `printInstallSummary` prints rule install results and warnings array.
- `5x-permissions.mdc` rule (`alwaysApply: true`) installed alongside the
  orchestrator rule in the Cursor harness to pre-authorize `5x` CLI commands
  and file edits, reducing in-agent approval prompts.
- Reviewer issue classification refined to reduce over-escalation of
  auto-fixable items to `human_required`.
- Skills updated to reference `5x commit` instead of raw `git commit`.

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
