# Changelog

All notable changes to `@5x-ai/5x-cli` will be documented in this file.

Format: categorized summary per release, newest first. Each entry is the
source of truth for the corresponding GitHub Release.

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
