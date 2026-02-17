# 5x CLI — Automated Author-Review Loop Runner

**Version:** 1.9
**Created:** February 15, 2026
**Status:** Draft — v1.9: Phase 2 review corrections — timeout upper bound (SIGTERM→SIGKILL + bounded drain), is_error→failure semantics, prompt length guard, spawn injection for test fidelity, schema probe relaxation, factory comment alignment; v1.8: enforce canonical path on DB write boundaries (createRun/upsertPlan), optimized last-event query for status; v1.7: canonical plan path identity (locks/DB lookup), status respects config db.path and avoids migrations, phase numbering preserved as string, DB write types split from read types; v1.6: clarify id/upsert/log lifecycle, monotonic iteration counter for quality retries, naming consistency; v1.5: resume idempotency fix (composite unique + ON CONFLICT DO UPDATE), phase sentinel -1, review path reuse from DB; v1.4: runtime story, DB idempotency, worktree safety, log retention, template escaping; v1.3: SSOT prompt templates, SQLite DB, plan locking, git worktree support; v1.2: template contracts, .5x hygiene, scope, collision handling; v1.1: P0/P1 blockers

---

## Executive Summary

The 5x workflow (described in the [project README](../../README.md)) is a two-phase author-review loop with human-gated checkpoints: an author agent writes plans and code, a reviewer agent critiques, and the human decides when to proceed. Today this loop is driven manually — the developer invokes slash commands one at a time, copies paths between them, reads review verdicts, and decides next steps.

`5x-cli` automates the orchestration while preserving human oversight. It is a standalone CLI tool that drives author and reviewer agents through structured loops, reads machine-readable signals from agent output to determine next steps, and pauses for human intervention when agents identify decisions that require taste or judgment. The CLI is a dumb state machine; the agents carry the intelligence.

### Scope

**In scope:**
- CLI commands for the core plan lifecycle: generate → review → execute
- Agent adapter abstraction supporting Claude Code CLI and OpenCode SDK
- Structured signal protocol (`5x:verdict`, `5x:status`) embedded in agent output
- SSOT prompt templates bundled with CLI (no harness-specific scaffolding)
- Local SQLite database for orchestration state, journal, history, and reporting
- Plan-level file locking to prevent concurrent execution on the same plan
- Git worktree support (`--worktree` flag) for isolated branch execution
- Quality gate runner (configurable test/lint/build commands)
- Human gates between phases, with auto-resolution of mechanical review fixes within phases
- `--auto` flag for full autonomy with agent-driven escalation for consequential decisions
- Per-project configuration via `5x.config.js` (JS-only for cross-runtime compatibility)

**Out of scope:**
- Custom UI/dashboard for monitoring runs — terminal output only
- Token cost optimization or caching — agents manage their own context
- Multi-repo or monorepo orchestration — single project at a time
- Agent model selection logic — user configures models in config file

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Smart prompts, dumb orchestrator** | Classification of review items (mechanical vs. judgment) is done by the reviewer agent, not by CLI pattern matching. Agents have full context to reason about intent; regex is brittle. CLI reads structured signals. |
| **HTML comment signal blocks in markdown files** | `5x:verdict` and `5x:status` blocks are invisible when rendered, inspectable in source, persisted as part of the review artifact. No separate sideband channel needed. |
| **Fresh agent session per invocation** | Each agent call is a new subprocess with clean context. Matches the "size tasks to context window" principle. Agents read plan/review files from disk. Simpler than managing persistent sessions across adapters. |
| **Adapter pattern for agent harnesses** | Abstract interface enables Claude Code and OpenCode without coupling orchestration logic to either. New harnesses can be added without changing the state machine. |
| **SSOT prompt templates, not harness-specific commands** | Templates are bundled with the CLI and rendered into prompt strings at invocation time. No scaffolding into `.claude/commands/` or `.opencode/commands/`. No version tracking, checksums, or `5x upgrade` for templates. Adding a new harness requires only an adapter implementation — no template variants. Templates update when the CLI updates. |
| **SQLite DB as orchestration SOT** | Local `.5x/5x.db` (via `bun:sqlite`) stores run state, parsed agent signals, quality gate results, and metrics. Replaces JSON journal files. Provides ACID transactions, WAL-mode concurrent reads (e.g., `5x status` during active `5x run`), indexed recovery lookups, and aggregation queries for reporting. Commented YAML in markdown files remains as a human-inspectable artifact but is not the source of truth for orchestration decisions. |
| **Plan-level file locking** | `.5x/locks/<sha256(canonicalPlanPath).slice(0,16)>.lock` with PID prevents concurrent `5x run` on the same plan across relative/absolute/symlink path variants. Stale detection via `process.kill(pid, 0)` with EPERM treated as alive. File-based (not DB-based) so it works even if DB is corrupted. |
| **Git worktree support** | `--worktree` flag on `5x run` creates an isolated worktree + branch for phase execution. Association persisted in DB so subsequent commands auto-resolve `workdir`. Enables parallel execution of different plans without branch conflicts. |
| **Human gate between phases, auto-resolve within** | Within a phase, mechanical review fixes are handled automatically (reviewer says `auto_fix`, author fixes, reviewer re-reviews). Between phases, always pause for human unless `--auto`. Agents escalate judgment calls at any point via `human_required` / `needs_human` signals. |
| **CLI owns artifact paths — no directory scanning** | The CLI computes deterministic output paths for plans, reviews, and logs before invoking agents, passes them to the agent prompt, and requires the `5x:status` block to echo the path back. The CLI never infers artifacts by "newest file" or directory-scanning heuristics. This prevents mis-association in repos with parallel workstreams, unrelated doc edits, or editor autosaves. |
| **Git safety is fail-closed by default** | Before any agent invocation in `plan-review` or `run`, the CLI checks repo root, current branch, dirty working tree, and untracked files. A dirty working tree aborts the run unless the user explicitly opts in with `--allow-dirty`. `--auto` never bypasses git safety checks. |
| **JS-only config** | Config is `5x.config.js` / `.mjs` (not TypeScript). Runs natively in Bun runtime and `bun build --compile` binaries without extra loaders. `defineConfig()` provides autocomplete via JSDoc `@type` annotations. |
| **Minimal adapter output contract** | The orchestrator depends only on `exitCode`, `output` (full text), and `duration` from adapters. Optional fields like `tokens` and `cost` are used for display only, never for correctness decisions. All routing logic uses parsed `5x:*` signals and git observations (e.g., commit hash after author run). Failure semantics: non-zero exit code OR agent-reported `is_error` in JSON output → `exitCode != 0` in `AgentResult`. |

### References

- [5x Workflow Commands](../../commands/) — existing command templates
- [Implementation Plan Template](../_implementation_plan_template.md) — plan structure the CLI reads and updates
- [Review Template](reviews/_review_template.md) — review structure the CLI parses

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Phase 1: Foundation — Config, Parsers, Status](#phase-1-foundation--config-parsers-status) — COMPLETE
3. [Phase 1.1: Architecture Foundation — DB, Lock, Templates](#phase-11-architecture-foundation--db-lock-templates) — COMPLETE
4. [Phase 2: Agent Adapters](#phase-2-agent-adapters) — COMPLETE
5. [Phase 3: Prompt Templates + Init](#phase-3-prompt-templates--init) — COMPLETE
6. [Phase 4: Plan Generation + Review Loop](#phase-4-plan-generation--review-loop)
7. [Phase 5: Phase Execution Loop](#phase-5-phase-execution-loop)
8. [Phase 6: OpenCode Adapter](#phase-6-opencode-adapter)
9. [Phase 7: Reporting, Auto Mode, Polish](#phase-7-reporting-auto-mode-polish)

---

## Overview

The 5x workflow currently requires manual orchestration: invoking commands, routing output between agents, interpreting review verdicts, and managing git state. The CLI automates this orchestration layer.

**Current behavior:**
- Developer manually invokes `/workflow-reviewer-review-implementation-plan <path>` in one agent
- Reads review verdict prose, decides whether to send to author for fixes
- Manually invokes `/workflow-builder-process-review <path>` in a different agent
- Repeats until plan is approved, then switches to phase execution loop
- Per phase: manually invokes builder, waits, runs tests, invokes reviewer, reads verdict, etc.

**New behavior:**
- `5x plan <prd-path>` generates an implementation plan from PRD/TDD docs
- `5x plan-review <plan-path>` runs the plan through automated review loops until approved
- `5x run <plan-path>` executes phases sequentially: author → quality gates → reviewer → auto-fix cycles → human gate → next phase
- Agents produce structured signals (`5x:verdict`, `5x:status`) that the CLI reads to route decisions
- Agents classify review items as `auto_fix` or `human_required`; the CLI trusts these classifications
- Human intervention happens when agents request it, between phases, or on failure

---

## Design Decisions

**Agent-driven escalation, not CLI pattern matching.** The reviewer classifies each review item with `action: auto_fix | human_required` based on its own reasoning about whether a fix is mechanical or requires human judgment. The author emits `needs_human` when it encounters ambiguity it can't resolve. The CLI never attempts to infer intent from prose — it reads structured signals. This makes the orchestrator simple and robust; the agents carry all the classification intelligence.

**Structured signals as HTML comments in review files.** The `5x:verdict` block is appended to the review markdown file as `<!-- 5x:verdict ... -->`. This is invisible when rendered (GitHub, Obsidian, etc.), inspectable in source, and persisted as part of the review artifact. It avoids requiring agents to produce two separate outputs (file + stdout) which is error-prone. The `5x:status` block from the author is captured from agent stdout since author output doesn't always map to a specific file. Both blocks include a `protocolVersion` field to allow future schema upgrades. All YAML field values are constrained to safe scalars (no multi-line strings, no `-->` sequences); templates strongly instruct agents to respect these constraints. Parsing rules: if multiple blocks are found, last one wins; if a block is malformed, treat as missing (escalate to human).

**SSOT prompt templates bundled with CLI.** Templates are markdown files with `{{variable}}` substitution, bundled directly with the CLI binary. The CLI reads a template, substitutes variables (plan paths, review paths, etc.), and passes the rendered prompt string to `adapter.invoke()`. This replaces the prior design of scaffolding harness-specific command variants into `.claude/commands/` and `.opencode/commands/`. Benefits: one template per operation (not per-harness variants), no version tracking or checksums for scaffolded files, no `5x upgrade` command for templates, new harnesses only need an adapter implementation. Templates update when the CLI updates.

**SQLite as orchestration SOT.** Parsed `5x:status` and `5x:verdict` blocks are stored in SQLite (`.5x/5x.db` via `bun:sqlite`) immediately after parsing. The DB is the source of truth for all orchestration decisions — resume detection, iteration tracking, retry decisions, reporting. The commented YAML blocks in markdown files remain as human-inspectable artifacts but are not re-read for decision making. Benefits: ACID transactions for reliable state updates, WAL mode for concurrent reads (`5x status` during active `5x run`), indexed lookups for fast recovery, aggregation queries for reporting, natural idempotency via unique constraints.

**Plan-level file locking.** `.5x/locks/<sha256(canonicalPlanPath)>.lock` files contain `{ pid, startedAt, planPath }` where `planPath` is canonicalized (absolute + realpath when possible). Acquired at `5x run` startup, released on exit. Stale detection via `process.kill(pid, 0)`; `EPERM` is treated as "alive" (lock is not stealable across users). File-based rather than DB-based so locking works even if the DB is corrupted. Prevents concurrent `5x run` on the same plan while allowing parallel execution on different plans.

**Git worktree support for isolated execution.** `--worktree` on `5x run` creates a git worktree + branch, persists the association in the DB `plans` table. All subsequent `5x` commands for that plan auto-resolve `workdir` from the DB without requiring `--worktree` again. Enables parallel plan execution without branch conflicts. Worktree creation is limited to `5x run` (not `plan` or `plan-review`) since plan/review operations only modify markdown files. Cleanup is non-destructive by default: `5x worktree cleanup` removes the worktree directory but retains the branch. Branch deletion requires `--delete-branch` and is only allowed if the branch is fully merged.

**Fresh subprocess per agent invocation.** Each call to an agent starts a new process with a clean context window. This matches the workflow principle of keeping context tight. Within a review-fix cycle (author fixes → reviewer re-reviews), each invocation is independent — the agent reads the updated files from disk. This is simpler to implement across both adapters and avoids context pollution.

**Graceful fallback when signals are missing.** Agents may not always produce the structured block (model variability, prompt drift, tool errors). Fallback rules: missing `5x:verdict` → escalate to human; missing `5x:status` → escalate to human (never assume completed, even with exit 0); any non-zero exit → assume failed. The CLI never crashes due to missing signals; worst case is an unnecessary human escalation. The CLI MUST NOT substitute unsafe guesses (e.g., "assume completed") when signals are absent.

**Bun-only distribution.** Built with Bun (`bun build --compile` for native binary). Bun is the sole supported runtime — fast startup, native TypeScript, built-in SQLite (`bun:sqlite`), and `Bun.spawn` for subprocess management. The compiled binary bundles the Bun runtime and works on any machine without Bun installed. Node runtime is explicitly not supported (no `better-sqlite3` fallback, no Node-compatible entrypoint). Config is JS-only (`5x.config.js` / `.mjs`). The `loadConfig()` function uses dynamic `import()` which works in Bun runtime and compiled binaries. If config fails to load, the error message tells the user which file was attempted and what format is expected.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                              5x CLI                                  │
│                                                                      │
│  ┌──────────┐   ┌──────────────┐   ┌───────────────────┐             │
│  │ Commands │──▶│ Orchestrator │──▶│  Agent Adapters   │             │
│  │          │   │              │   │                   │             │
│  │ plan     │   │ plan-review  │   │ ┌───────────────┐ │             │
│  │ plan-rev │   │   loop       │   │ │ Claude Code   │ │             │
│  │ run      │   │              │   │ │ (subprocess)  │ │             │
│  │ status   │   │ phase-exec   │   │ └───────────────┘ │             │
│  │ init     │   │   loop       │   │ ┌───────────────┐ │             │
│  │ history  │   │              │   │ │ OpenCode      │ │             │
│  └─────────┘    └──────┬───────┘   │ │ (SDK)         │ │             │
│                        │           │ └───────────────┘ │             │
│              ┌─────────┼───────────┴───────────────────┘             │
│              │         │                                             │
│              ▼         ▼                                             │
│  ┌──────────────┐ ┌──────────────────┐  ┌───────────────────────┐    │
│  │ Prompt       │ │  Signal Parsers  │  │  SQLite DB (.5x/)     │    │
│  │ Templates    │ │                  │  │                       │    │
│  │ (bundled)    │ │ parseVerdictBlock│  │ runs, events,         │    │
│  │              │ │ parseStatusBlock │─▶│ agent_results,        │    │
│  │ render()     │ │ parsePlan        │  │ quality_results,      │    │
│  │   ↓ prompt   │ └──────────────────┘  │ plan associations     │    │
│  │   → adapter  │          │            └───────────┬───────────┘    │
│  └──────────────┘ ┌────────┴────────┐               │                │
│                   │                 │               │                │
│              ┌────▼─────┐    ┌──────▼───────┐  ┌────▼────────┐       │
│              │ Quality  │    │ Human Gates  │  │ Plan Lock   │       │
│              │ Gates    │    │ (terminal)   │  │ (.5x/locks/)│       │
│              └──────────┘    └──────────────┘  └─────────────┘       │
└──────────────────────────────────────────────────────────────────────┘

Data flow:
  Prompt Templates ──render──▶ prompt string ──▶ adapter.invoke()
  Reviewer agent   ──writes──▶ review.md (includes <!-- 5x:verdict -->)
  Author agent     ──stdout──▶ captured by CLI (includes <!-- 5x:status -->)
  CLI              ──parses──▶ structured signals ──▶ SQLite DB (SOT)
  CLI              ──decides──▶ proceed / auto-fix / escalate / fail (from DB)
```

**State machine transitions (per phase):**

```
EXECUTE ──▶ QUALITY_CHECK ──▶ REVIEW ──▶ PARSE_VERDICT
                │                              │
          (fail, retry)                   ┌────┴────┐
                │                         │         │
          QUALITY_RETRY ◀──┘        auto_fix   human_required
                                      │              │
                                 AUTO_FIX ──▶   ESCALATE ──▶ HUMAN
                                      │              │         │
                                 QUALITY_CHECK   (human        │
                                      │          decides)      │
                                 REVIEW ──▶ ...    │           │
                                              ┌────┘     ┌─────┘
                                              ▼          ▼
                                         PHASE_GATE (between phases)
                                              │
                                         NEXT_PHASE or COMPLETE
```

---

## Phase 1: Foundation — Config, Parsers, Status

**Completion gate:** `5x status <plan-path>` displays accurate phase/checklist progress from any valid implementation plan. Config file loads and validates. Signal parsers extract verdict/status blocks from markdown. All unit tests pass.

### 1.1 Project scaffolding

Initialize the `5x-cli` package:

```
5x-cli/
├── src/
│   ├── bin.ts
│   ├── config.ts
│   ├── version.ts
│   └── ...
├── test/
├── package.json
├── tsconfig.json
└── bunfig.toml
```

- [x] Initialize Bun project with TypeScript
- [x] Add CLI framework dependency (citty or commander)
- [x] Configure test runner, linting
- [x] Set up `bin` entry in `package.json`

### 1.2 `src/config.ts` — Configuration loader

Load and validate `5x.config.js` (or `.mjs`) from project root with sensible defaults. Config is JS-only for simplicity — no TS loaders needed.

```typescript
export interface FiveXConfig {
  author: {
    adapter: 'claude-code' | 'opencode';
    model?: string;
  };
  reviewer: {
    adapter: 'claude-code' | 'opencode';
    model?: string;
  };
  qualityGates: string[];
  paths: {
    plans: string;
    reviews: string;
    archive: string;
    templates: {
      plan: string;
      review: string;
    };
  };
  maxReviewIterations: number;
  maxQualityRetries: number;
  maxAutoIterations: number;     // hard cap for --auto mode (default: 10)
  maxAutoRetries: number;        // hard cap for --auto quality retries (default: 3)
}

export function loadConfig(projectRoot: string): Promise<FiveXConfig> { ... }
export function defineConfig(config: Partial<FiveXConfig>): Partial<FiveXConfig> { ... }
```

Config loading strategy:
- Discovery: walk up from cwd to find `5x.config.js` or `5x.config.mjs` (in that precedence order).
- Loading: use dynamic `import()` which works natively in Bun runtime and compiled binaries.
- The `defineConfig()` helper is exported from the `5x-cli` package; users get autocomplete via JSDoc `@type {import('5x-cli').FiveXConfig}` in their config file.
- If no config file is found, use defaults. If a file is found but fails to load (syntax error, wrong format), emit an actionable error: `"Failed to load 5x.config.js at <path>: <error>. Config must be a JS/MJS module exporting a default config object."`.

- [x] Config file discovery (walk up from cwd to find `5x.config.js` / `.mjs`)
- [x] Dynamic `import()` loader with actionable error messages on failure
- [x] Zod schema validation with clear error messages
- [x] Default values for all optional fields
- [x] `defineConfig()` helper exported for autocomplete via JSDoc
- [x] Unit tests: valid config, missing config (uses defaults), partial config with defaults, invalid values, `.mjs` variant
- [ ] Verify config loading works under Bun runtime and `bun build --compile` output

### 1.3 `src/parsers/plan.ts` — Implementation plan parser

Extract phase structure, checklist state, and metadata from implementation plan markdown files.

```typescript
export interface ParsedPlan {
  title: string;
  version: string;
  status: string;
  phases: Phase[];
  currentPhase: Phase | null;   // first incomplete phase
  completionPercentage: number;
}

export interface Phase {
  number: string;               // phase label from the plan heading (e.g. '1', '1.1', '1.10')
  title: string;
  heading: string;              // raw markdown heading text
  completionGate?: string;
  items: ChecklistItem[];
  isComplete: boolean;
  line: number;                 // line number in source
}

export interface ChecklistItem {
  text: string;
  checked: boolean;
  line: number;
}

export function parsePlan(markdown: string): ParsedPlan { ... }
```

- [x] Extract `**Version:**`, `**Status:**` from metadata block
- [x] Parse `## Phase N:` or `### Phase N:` headings (handle both depths)
- [x] Parse `- [x]` / `- [ ]` checklist items within each phase
- [x] Handle `COMPLETE` suffix in phase headings (e.g., `## Phase 1: Title - COMPLETE`)
- [x] Calculate per-phase and overall completion percentage
- [x] Identify `currentPhase` (first phase with unchecked items)
- [x] Extract `**Completion gate:**` text per phase
- [x] Unit tests against real plan files (use sample plan from this repo + player_desk examples)

### 1.4 `src/parsers/signals.ts` — Structured signal parsers

Parse `5x:verdict` and `5x:status` blocks from agent output. This is the canonical signal protocol spec — all templates and orchestration logic depend on these schemas.

**Signal protocol v1 spec:**
- Transport: HTML comments in the form `<!-- 5x:verdict\n...\n-->` and `<!-- 5x:status\n...\n-->`.
- Content: YAML between the delimiters. All field values MUST be safe scalars (no multi-line strings, no sequences containing `-->`). Templates instruct agents to respect these constraints.
- Multiple blocks: if multiple `5x:verdict` or `5x:status` blocks appear in the same text, the **last** one wins.
- Malformed blocks: if a block is found but YAML parsing fails, treat as missing (escalate to human). Never substitute a guess.
- Future consideration: if agents frequently produce malformed YAML (e.g., unquoted strings with `-->` or multi-line values), protocol v2 may switch to single-line JSON payloads inside the comment block or a sidecar `.5x-signal.json` file written by the agent. The `protocolVersion` field enables this migration without breaking existing templates.

```typescript
export interface VerdictBlock {
  protocolVersion: 1;
  readiness: 'ready' | 'ready_with_corrections' | 'not_ready';
  reviewPath: string;             // echoes the CLI-provided review file path
  items: VerdictItem[];
}

export interface VerdictItem {
  id: string;
  title: string;
  action: 'auto_fix' | 'human_required';
  reason: string;
}

export interface StatusBlock {
  protocolVersion: 1;
  result: 'completed' | 'needs_human' | 'failed';
  planPath?: string;              // echoes CLI-provided plan output path (plan generation)
  reviewPath?: string;            // echoes CLI-provided review path (review commands)
  commit?: string;                // commit hash created by author (phase execution)
  phase?: number;                 // phase number being worked on (phase execution)
  summary?: string;               // human-readable summary of work done
  reason?: string;                // explanation for needs_human / failed
  context?: string;               // additional context for escalation
  blockedOn?: string;             // what the agent is blocked on (needs_human)
}

export function parseVerdictBlock(text: string): VerdictBlock | null { ... }
export function parseStatusBlock(text: string): StatusBlock | null { ... }
```

Required fields per command context:
| Command | Block | Required fields |
|---------|-------|----------------|
| `5x plan` | `5x:status` | `protocolVersion`, `result`, `planPath` |
| `5x plan-review` (reviewer) | `5x:verdict` | `protocolVersion`, `readiness`, `reviewPath`, `items` |
| `5x plan-review` (author fix) | `5x:status` | `protocolVersion`, `result` |
| `5x run` (author phase) | `5x:status` | `protocolVersion`, `result`, `commit`, `phase` |
| `5x run` (reviewer) | `5x:verdict` | `protocolVersion`, `readiness`, `reviewPath`, `items` |

- [x] Extract `<!-- 5x:verdict ... -->` block from markdown text (last occurrence wins)
- [x] Extract `<!-- 5x:status ... -->` block from text (last occurrence wins)
- [x] Parse YAML content within blocks
- [x] Validate `protocolVersion` field; warn on unknown versions but still attempt parse
- [x] Return `null` for missing or malformed blocks (never throw, never guess)
- [x] Unit tests: valid blocks, missing blocks, malformed YAML, partial fields, multiple blocks (last wins), unknown protocolVersion

### 1.5 `src/parsers/review.ts` — Review summary parser

Extract human-readable summary info from review documents for terminal display. Not in the decision path — the `5x:verdict` block drives decisions.

```typescript
export interface ReviewSummary {
  subject: string;
  readiness: string;          // from prose "Readiness:" line
  p0Count: number;
  p1Count: number;
  p2Count: number;
  hasAddendums: boolean;
  latestAddendumDate?: string;
}

export function parseReviewSummary(markdown: string): ReviewSummary { ... }
```

- [x] Extract `**Readiness:**` line from prose
- [x] Count `### P0.`, `### P1.`, `### P2.` sections
- [x] Detect addendum sections (`## Addendum`)
- [x] Unit tests against real review files

### 1.6 `src/commands/status.ts` — Plan status display

```
$ 5x status docs/development/525-impl-onboarding-progress-tracker.md

  Onboarding Progress Tracker (v1.5)
  Status: Phases 1–4 complete; Phase 5 ready

  Phase 1: Backend — Dismiss Endpoint          ████████████ 100%
  Phase 2: OpenAPI + Codegen                   ████████████ 100%
  Phase 3: BFF + Web Route Wiring              ████████████ 100%
  Phase 4: Dashboard Widget Component          ████████████ 100%
  Phase 5: Venue-Scoped Refactor               ░░░░░░░░░░░░   0%

  Overall: 80% (4/5 phases complete)
```

- [x] Load and parse plan file
- [x] Format phase progress with visual indicators
- [x] Show current phase and next steps
- [x] Handle edge cases: no phases found, all complete, plan not found

---

## Phase 1.1: Architecture Foundation — DB, Lock, Templates

**Completion gate:** SQLite database creates, migrates, and performs CRUD operations for all tables. Plan lock acquire/release works with stale PID detection. Status command shows DB run state when available. All existing tests pass (stale assertions fixed).

> **Context:** This phase retrofits the architecture decisions made after Phase 1 completion: SQLite as orchestration SOT (replacing the planned JSON journal), plan-level file locking, and removal of harness-specific template scaffolding. These are prerequisites for all subsequent phases.

### 1.1.1 `src/db/connection.ts` — Database connection management

Singleton connection to `.5x/5x.db` with WAL mode for concurrent reads.

```typescript
import { Database } from 'bun:sqlite';

export function getDb(projectRoot: string): Database { ... }
export function closeDb(): void { ... }
```

- [x] Singleton `Database` instance, created on first access
- [x] DB path: `<projectRoot>/.5x/5x.db` (auto-create `.5x/` directory if missing)
- [x] Pragmas on open: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`
- [x] Register cleanup on `process.on('exit')`, `SIGINT`, `SIGTERM` — close DB gracefully
- [x] Export `getDb()` and `closeDb()` — no direct `Database` construction elsewhere
- [x] Unit tests: connection creates DB file, WAL mode is active, singleton returns same instance

### 1.1.2 `src/db/schema.ts` — Schema definition and migrations

Sequential migration runner with version tracking. Simple and forward-only — no down migrations for a local CLI tool.

```typescript
export function runMigrations(db: Database): void { ... }
export function getSchemaVersion(db: Database): number { ... }
```

**Migration 001 — Initial schema:**

```sql
-- Schema version tracking
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Plan associations (worktree, branch, lock state)
CREATE TABLE plans (
  plan_path TEXT PRIMARY KEY,
  worktree_path TEXT,
  branch TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Runs (replaces JSON journal)
CREATE TABLE runs (
  id TEXT PRIMARY KEY,                          -- ULID
  plan_path TEXT NOT NULL,
  review_path TEXT,
  command TEXT NOT NULL,                         -- 'plan' | 'plan-review' | 'run'
  status TEXT NOT NULL DEFAULT 'active',         -- 'active' | 'completed' | 'aborted' | 'failed'
  current_phase INTEGER,
  current_state TEXT,                            -- state machine state name
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX idx_runs_plan_path ON runs(plan_path);
CREATE INDEX idx_runs_status ON runs(status);

-- Run events (append-only journal log)
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  event_type TEXT NOT NULL,                     -- 'phase_start' | 'agent_invoke' | 'quality_gate' | 'verdict' | 'escalation' | 'phase_complete' | 'error'
  phase INTEGER,
  iteration INTEGER,
  data TEXT,                                     -- JSON blob
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_run_events_run_id ON run_events(run_id);

-- Agent invocation results with parsed signal data.
-- Each row represents one adapter.invoke() call.
--
-- Resume/idempotency: the composite key (run_id, role, phase, iteration,
-- template_name) uniquely identifies a logical step in the orchestration.
-- On resume after a crash, the orchestrator re-derives the step identity
-- from run state and re-invokes with the same key. INSERT ... ON CONFLICT
-- DO UPDATE replaces the old result with the new one (the re-run is
-- authoritative).
--
-- ULID `id` and log file lifecycle: `id` is generated fresh per invocation
-- and serves as the PK + log file key (.5x/logs/<run-id>/agent-<id>.log).
-- On upsert (ON CONFLICT DO UPDATE), the `id` column IS updated to the new
-- invocation's ULID — the new log file replaces the logical slot. The old
-- log file from the interrupted/crashed attempt remains on disk as an
-- orphan (acceptable for a local tool; cleaned up with the log directory).
-- The derivable log path (run_id + id) always points to the latest attempt.
--
-- Output retention: full agent output is written to
-- .5x/logs/<run-id>/agent-<id>.log on disk. The DB stores parsed signal
-- data (signal_type + signal_data) and metrics only — not the full output
-- blob. Log file path is derivable from run_id + id (always the latest).
--
-- Iteration semantics: `iteration` is a monotonic counter that advances on
-- every agent invocation within a phase (or within a run for plan-review).
-- This includes review-fix cycles AND quality-retry re-invocations of the
-- author. The counter ensures each invocation gets a unique step identity.
--   plan-review loop: iteration increments on each agent call (reviewer=0,
--     author-fix=1, reviewer=2, author-fix=3, ...).
--   phase-execution loop: iteration increments on each agent call within
--     the phase (author=0, quality-retry-author=1, reviewer=2,
--     review-fix-author=3, reviewer=4, ...).
--   quality gate results: tracked separately in quality_results.attempt
--     (not agent_results.iteration), since quality gates are command
--     executions, not agent invocations.
--   plan generation: iteration = 0 (single invocation).
--
-- Phase sentinel: -1 means "no phase context" (plan generation, plan-review).
-- Phase 0+ maps to real plan phases.
CREATE TABLE agent_results (
  id TEXT PRIMARY KEY,                           -- ULID, generated fresh per invocation (log file key)
  run_id TEXT NOT NULL REFERENCES runs(id),
  role TEXT NOT NULL,                            -- 'author' | 'reviewer'
  template_name TEXT NOT NULL,                   -- which prompt template was used
  phase INTEGER NOT NULL DEFAULT -1,             -- -1 for no phase context; 0+ for real phases
  iteration INTEGER NOT NULL DEFAULT 0,          -- monotonic per-phase/run agent invocation counter
  exit_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  signal_type TEXT,                              -- 'status' | 'verdict' | null (if missing)
  signal_data TEXT,                              -- JSON of parsed StatusBlock or VerdictBlock
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, role, phase, iteration, template_name)  -- step identity for resume idempotency
);
CREATE INDEX idx_agent_results_run ON agent_results(run_id);
CREATE INDEX idx_agent_results_run_phase ON agent_results(run_id, phase);

-- Quality gate results.
-- Each row represents one quality gate run (all configured commands).
-- Composite key (run_id, phase, attempt) is the step identity for resume.
CREATE TABLE quality_results (
  id TEXT PRIMARY KEY,                           -- ULID, generated fresh per gate run
  run_id TEXT NOT NULL REFERENCES runs(id),
  phase INTEGER NOT NULL,
  attempt INTEGER NOT NULL,                      -- 0-indexed retry count within phase
  passed INTEGER NOT NULL,                       -- 0 or 1
  results TEXT NOT NULL,                          -- JSON array of per-command results
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, phase, attempt)                 -- step identity for resume idempotency
);
CREATE INDEX idx_quality_results_run ON quality_results(run_id, phase);
```

- [x] Migration runner: read `schema_version` table (create if missing), apply migrations with version > current
- [x] Each migration is a function: `(db: Database) => void`, runs in a transaction
- [x] Migrations stored as an ordered array in `schema.ts` (not separate SQL files — bundled with binary)
- [x] On schema mismatch: clear error message with DB path, suggest delete `.5x/5x.db` to reset
- [x] Unit tests: fresh DB gets all migrations, already-migrated DB is no-op, partial migration resumes

### 1.1.3 `src/db/operations.ts` — Typed CRUD helpers

```typescript
// --- Plans ---
export function upsertPlan(db: Database, plan: { planPath: string; worktreePath?: string; branch?: string }): void;
export function getPlan(db: Database, planPath: string): Plan | null;

// --- Runs ---
export function createRun(db: Database, run: { id: string; planPath: string; command: string; reviewPath?: string }): void;
export function updateRunStatus(db: Database, runId: string, status: string, state?: string, phase?: number): void;
export function getActiveRun(db: Database, planPath: string): Run | null;
export function getLatestRun(db: Database, planPath: string): Run | null;

// --- Events ---
export function appendRunEvent(db: Database, event: { runId: string; eventType: string; phase?: number; iteration?: number; data?: unknown }): void;
export function getRunEvents(db: Database, runId: string): RunEvent[];

// --- Agent Results (composite unique on step identity; ULID PK for log refs) ---
export function upsertAgentResult(db: Database, result: AgentResultRow): void;  // INSERT ... ON CONFLICT(run_id,role,phase,iteration,template_name) DO UPDATE
export function getAgentResults(db: Database, runId: string, phase?: number): AgentResultRow[];
export function getLatestVerdict(db: Database, runId: string, phase: number): VerdictBlock | null;
export function getLatestStatus(db: Database, runId: string, phase: number): StatusBlock | null;
export function hasCompletedStep(db: Database, runId: string, role: string, phase: number, iteration: number, templateName: string): boolean;

// --- Quality Results (composite unique on run_id + phase + attempt) ---
export function upsertQualityResult(db: Database, result: QualityResultRow): void;  // INSERT ... ON CONFLICT(run_id,phase,attempt) DO UPDATE
export function getQualityResults(db: Database, runId: string, phase: number): QualityResultRow[];

// --- Reporting ---
export function getRunHistory(db: Database, planPath?: string, limit?: number): RunSummary[];
export function getRunMetrics(db: Database, runId: string): RunMetrics;
```

- [x] All write operations use prepared statements for safety and performance
- [x] Agent result upserts use `INSERT ... ON CONFLICT(run_id, role, phase, iteration, template_name) DO UPDATE` — on resume, re-running a step replaces the old result with the new one
- [x] Quality result upserts use `INSERT ... ON CONFLICT(run_id, phase, attempt) DO UPDATE`
- [x] `hasCompletedStep()` checks if a step already has a result — orchestrator uses this on resume to skip completed steps
- [x] Plan upserts use `INSERT ... ON CONFLICT(plan_path) DO UPDATE` for worktree/branch updates
- [x] JSON fields serialized with `JSON.stringify()`, deserialized with `JSON.parse()` on read
- [x] Type-safe row interfaces matching the schema
- [x] Separate write input types (`AgentResultInput`, `QualityResultInput`) from read row types; `created_at` is DB-managed and updated on upsert overwrite
- [x] `createRun()` and `upsertPlan()` enforce canonical plan path internally via `canonicalizePlanPath()` — prevents duplicate rows for relative/absolute/symlink path variants regardless of caller discipline
- [x] `getLastRunEvent()` — optimized single-row fetch for the most recent event of a run (replaces full `getRunEvents()` + tail pattern in status display)
- [x] Unit tests: CRUD round-trips for each table, upsert idempotency (re-insert same step key updates row), `hasCompletedStep` returns true after insert, concurrent read during write (WAL)
- [x] Regression tests: canonical path deduplication for `createRun`/`upsertPlan` with relative, absolute, and symlink path variants

### 1.1.4 `src/lock.ts` — Plan-level file locking

```typescript
export interface LockInfo {
  pid: number;
  startedAt: string;    // ISO 8601
  planPath: string;
}

export interface LockResult {
  acquired: boolean;
  existingLock?: LockInfo;
  stale?: boolean;
}

export function acquireLock(projectRoot: string, planPath: string): LockResult;
export function releaseLock(projectRoot: string, planPath: string): void;
export function isLocked(projectRoot: string, planPath: string): { locked: boolean; info?: LockInfo; stale?: boolean };
export function registerLockCleanup(projectRoot: string, planPath: string): void;
```

Lock mechanics:
- Canonicalization: compute `canonicalPlanPath` = absolute + realpath (when possible) once at CLI boundaries; use it for DB + locks
- Lock path: `<projectRoot>/.5x/locks/<sha256(canonicalPlanPath).slice(0,16)>.lock`
- Content: JSON `LockInfo` — `{ pid, startedAt, planPath }` where `planPath` is canonical
- Acquire: check if lock file exists → if yes, check PID liveness via `process.kill(pid, 0)` (treat `EPERM` as alive) → if dead, log stale lock warning and steal → if alive, return `{ acquired: false, existingLock, stale: false }`
- Release: delete lock file (no-op if already gone)
- `registerLockCleanup()`: register `process.on('exit')`, `SIGINT`, `SIGTERM` handlers that call `releaseLock()`
- Race condition note: there's a small TOCTOU window between checking and creating the lock file. Acceptable for a single-developer CLI tool — not a distributed system.

- [x] Implement `acquireLock` with PID liveness check
- [x] Implement `releaseLock` (idempotent delete)
- [x] Implement `registerLockCleanup` for graceful shutdown
- [x] Create `.5x/locks/` directory on first lock acquisition
- [x] Unit tests: acquire/release round-trip, stale lock detection (write lock with dead PID), double-acquire same PID (re-entrant), concurrent lock attempt

### 1.1.5 Config updates

Minimal changes to the existing `FiveXConfig` interface.

```typescript
// Add to FiveXConfig:
export interface FiveXConfig {
  // ... existing fields ...
  db?: {
    path?: string;  // default: '.5x/5x.db' (relative to project root)
  };
}
```

- [x] Add optional `db.path` field to Zod schema with default `.5x/5x.db`
- [x] Update `configSchema` in `src/config.ts`
- [x] Unit test: config with db override, config without db (uses default)

### 1.1.6 Status command enhancement

Update `5x status <plan-path>` to show active run information from the database when available.

```
$ 5x status docs/development/001-impl-5x-cli.md

  5x CLI — Automated Author-Review Loop Runner (v1.3)
  Status: Phase 1 complete; Phase 1.1 ready

  Phase 1: Foundation                              ████████████ 100%
  Phase 1.1: Architecture Foundation               ░░░░░░░░░░░░   0%
  Phase 2: Agent Adapters                          ░░░░░░░░░░░░   0%
  ...

  Overall: 12% (1/8 phases complete)

  Active run: abc123 (5x run, phase 3, state: REVIEW)
  Started: 2 hours ago | Iterations: 4
  Last event: verdict received (ready_with_corrections)
```

- [x] Check for DB existence at resolved `config.db.path`; if present, query for active/latest run
- [x] Resolve project root deterministically (config root if present, else git root) and resolve DB path from `config.db.path`
- [x] `status` is read-only: never creates a DB file and never runs migrations; if DB exists but schema is stale, omit DB info with a clear warning
- [x] Display active run info: run ID, command, current phase, state, duration, iteration count, last event (uses optimized `getLastRunEvent` — single-row fetch, not full event history)
- [x] Display latest completed run summary if no active run
- [x] Graceful when no DB exists (fresh project, pre-first-run) — show only plan progress
- [x] Unit tests: status with DB (active run), status with DB (no active run), status without DB

### 1.1.7 Fix failing tests

- [x] Update stale assertions in `test/parsers/plan.test.ts` — tests hardcode expectations against `docs/development/001-impl-5x-cli.md` which has progressed since initial implementation. Either update expected values or use a dedicated test fixture file instead of the live plan.

---

## Phase 2: Agent Adapters

**Completion gate:** Claude Code adapter can invoke an agent with a prompt, capture structured output, and return a typed `AgentResult`. Adapter interface is clean and OpenCode-ready. Integration test proves a real Claude Code invocation round-trips.

### 2.1 `src/agents/types.ts` — Adapter interface

The adapter contract is intentionally minimal. The orchestrator relies on parsed `5x:*` signals from agent output and git observations (e.g., new commits) for correctness decisions — never on adapter-internal fields like `filesModified`. Optional fields are used for display/logging only.

```typescript
export interface AgentAdapter {
  readonly name: string;
  invoke(opts: InvokeOptions): Promise<AgentResult>;
  isAvailable(): Promise<boolean>;
}

export interface InvokeOptions {
  prompt: string;
  model?: string;
  workdir: string;
  timeout?: number;           // ms, default 300_000
  maxTurns?: number;          // default 50
  allowedTools?: string[];    // adapter-specific tool filter
}

export interface AgentResult {
  // --- Required (orchestration depends on these) ---
  output: string;             // full text output — signals are parsed from this
  exitCode: number;           // non-zero → assume failed (includes is_error mapping)
  duration: number;           // ms

  // --- Optional (display/logging only, never used for routing) ---
  tokens?: { input: number; output: number };
  cost?: number;              // USD if adapter reports it
  error?: string;             // stderr or error message on failure
  sessionId?: string;         // agent session ID for debugging
}
```

- [x] Define interface and types
- [x] Export adapter factory type
- [x] Add a "schema probe" test that validates Claude Code `--output-format json` output maps cleanly to the required fields, with clear error messages on schema changes

### 2.2 `src/agents/claude-code.ts` — Claude Code CLI adapter

Drives Claude Code via `claude -p "<prompt>" --output-format json`.

**Timeout guarantee:** `invoke(timeout=X)` returns within O(X + KILL_GRACE_MS + DRAIN_TIMEOUT_MS) regardless of subprocess behavior. After the deadline the adapter sends SIGTERM, waits a 2 s grace, then SIGKILL, and bounds stream draining with an AbortController.

**Failure semantics:** `exitCode != 0` OR `is_error === true` in the parsed JSON maps to a non-zero `AgentResult.exitCode`. When `is_error` is true and the process exited 0, the adapter overrides to exitCode 1 and populates `error` with the `subtype` and stderr context. This prevents orchestration from treating agent-reported errors (e.g., `error_max_turns`) as successes.

**Prompt delivery:** Prompts are passed via `-p` on the command line. The Claude Code CLI uses stdin as supplementary context, not as a replacement for `-p`, so argv is the only delivery mechanism. Prompts exceeding `MAX_PROMPT_LENGTH` (~128 KiB) are rejected before spawning to avoid OS `ARG_MAX` failures. Templates must not embed secrets, since argv is visible via `ps` on multi-user systems.

**Subprocess injection:** `spawnProcess()` is a protected method that returns a `SpawnHandle` abstraction. Tests override this single method to inject controlled subprocess behavior, ensuring the real `invoke()` logic (JSON parsing, `is_error` mapping, timeout/kill, stream draining) is exercised by tests.

```typescript
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code';

  async isAvailable(): Promise<boolean> {
    // Check `claude --version` succeeds
  }

  protected spawnProcess(args: string[], opts: { cwd: string }): SpawnHandle {
    // Bun.spawn wrapper returning { exited, stdout, stderr, kill() }
  }

  async invoke(opts: InvokeOptions): Promise<AgentResult> {
    // Guard: reject prompts > MAX_PROMPT_LENGTH
    const args = [
      '-p', opts.prompt,
      '--output-format', 'json',
      '--max-turns', String(maxTurns),
    ];
    if (opts.model) args.push('--model', opts.model);

    const proc = this.spawnProcess(args, { cwd: opts.workdir });
    // Race proc.exited vs timeout
    // On timeout: SIGTERM → grace → SIGKILL, bounded drain
    // Parse structured JSON output
    // Map is_error → failure exitCode
    // Extract cost/token info if available
  }
}
```

- [x] Implement subprocess spawning with timeout
- [x] Enforce timeout upper bound: SIGTERM → grace → SIGKILL + AbortController-bounded drain
- [x] Parse Claude Code JSON output format (research `--output-format json` schema)
- [x] Map `is_error`/`subtype` into failure semantics (exitCode override + error context)
- [x] Map JSON output to `AgentResult` — extract only `output`, `exitCode`, `duration`; optionally extract `tokens`/`cost` if present in JSON
- [x] Lock parsing to specific known JSON fields with graceful handling of schema changes (log warning, don't crash)
- [x] Handle stderr capture for error diagnostics
- [x] Map exit codes to result states
- [x] Prompt length guard (MAX_PROMPT_LENGTH) — rejects before spawn, documents argv limitation
- [x] Stream draining via `new Response(stream).text()` (correct multi-byte handling + EOF flush)
- [x] Protected `spawnProcess()` method for test injection (tests exercise real invoke logic)
- [x] `isAvailable()` check via `claude --version`
- [x] Unit tests with spawn-injected mock (no invoke override)
- [x] Schema probe test: require only `result`/`type`; validate optional fields by type when present
- [x] Integration test (env-gated): invoke Claude Code with a trivial prompt, verify round-trip

### 2.3 `src/agents/factory.ts` — Adapter factory

`createAdapter()` is synchronous and does not check availability. `createAndVerifyAdapter()` additionally calls `isAvailable()` and throws with an actionable error message if the binary is not found.

```typescript
export function createAdapter(config: AdapterConfig): AgentAdapter {
  // Synchronous — no availability check
  switch (config.adapter) {
    case 'claude-code': return new ClaudeCodeAdapter();
    case 'opencode': throw new Error('Not yet implemented');
    default: throw new Error(`Unknown adapter: ${config.adapter}`);
  }
}

export async function createAndVerifyAdapter(config: AdapterConfig): Promise<AgentAdapter> {
  // Creates adapter + verifies isAvailable(); throws if not reachable
}
```

- [x] Config-driven adapter instantiation (synchronous, no availability check)
- [x] Separate `createAndVerifyAdapter()` for startup verification (async, throws if unavailable)
- [x] Unit test: factory returns correct adapter type

---

## Phase 3: Prompt Templates + Init

**Completion gate:** Template loader renders all 5 prompt templates with variable substitution. `5x init` creates config file and `.5x/` directory. Templates are bundled with the CLI binary — no scaffolding into harness directories.

> **Architecture change (v1.3):** Templates are SSOT prompt files bundled with the CLI, not harness-specific command files scaffolded into `.claude/commands/` or `.opencode/commands/`. The CLI reads a template, substitutes `{{variables}}`, and passes the rendered prompt string directly to `adapter.invoke()`. This eliminates per-harness variants, version tracking, checksums, `manifest.json`, `.5x-version`, and the `5x upgrade` command for templates. New harnesses only need an adapter implementation.

### 3.1 `src/templates/` — Prompt template system

Template format: markdown files with `{{variable}}` substitution and optional YAML frontmatter for metadata.

```
src/templates/
├── loader.ts                       # Template loading + rendering
├── author-generate-plan.md
├── author-next-phase.md
├── author-process-review.md
├── reviewer-plan.md
└── reviewer-commit.md
```

**Template structure:**

```markdown
---
name: author-generate-plan
version: 1
variables: [prd_path, plan_path, plan_template_path]
---

You are implementing the 5x workflow. Generate an implementation plan from the provided requirements document.

## Input
- Requirements document: {{prd_path}}
- Target plan output path: {{plan_path}}
- Plan template to follow: {{plan_template_path}}

## Instructions
...

## 5x Protocol Output
You MUST emit a status block as the last thing in your output:
<!-- 5x:status
protocolVersion: 1
result: completed | needs_human | failed
planPath: {{plan_path}}
summary: <brief description of what was done>
-->
```

**Template loader:**

```typescript
export interface TemplateMetadata {
  name: string;
  version: number;
  variables: string[];
}

export interface RenderedTemplate {
  name: string;
  prompt: string;                // fully substituted prompt string
}

export function loadTemplate(name: string): { metadata: TemplateMetadata; body: string };
export function renderTemplate(name: string, variables: Record<string, string>): RenderedTemplate;
export function listTemplates(): TemplateMetadata[];
```

Templates are loaded from the bundled source (compiled into the binary). `renderTemplate()` validates all required variables are present (from frontmatter `variables` list), performs `{{variable}}` substitution, and returns the prompt string ready for `adapter.invoke()`.

**Rendering rules:**
- Substitution: all `{{variable_name}}` occurrences are replaced with the variable value. Variable names are `[a-z_]+` only.
- Escaping: literal `{{` in templates that should NOT be substituted must be written as `\{{`. The renderer replaces `\{{` with `{{` after substitution. This is only needed in the rare case a template must show `{{example}}` syntax to the agent.
- Variable values are inserted verbatim (no quoting, no escaping). Since variables are file paths and simple strings controlled by the CLI (not user input), injection risk is negligible. The 5x signal protocol constrains YAML values to safe scalars; the template instructions remind agents of this.
- Unresolved `{{...}}` after substitution (indicating a typo or missing variable) is a hard error — never pass a partially-rendered template to an agent.

- [x] Implement template loader (reads from bundled files)
- [x] Implement `{{variable}}` substitution with validation against frontmatter `variables` list
- [x] Implement `\{{` escape sequence (literal `{{` passthrough)
- [x] Error on missing variables (list which are missing)
- [x] Error on unresolved `{{...}}` after substitution (typo detection)
- [x] Unit tests: rendering, escaping, missing variables, unresolved variables

### 3.2 Prompt templates — Author templates

**`author-generate-plan.md`:**
- Variables: `prd_path`, `plan_path`, `plan_template_path`
- Instructs agent to generate implementation plan using the project's plan template
- 5x protocol: emit `<!-- 5x:status -->` with `result` + `planPath` echoing `{{plan_path}}`

**`author-next-phase.md`:**
- Variables: `plan_path`, `phase_number`, `user_notes` (optional)
- Instructs agent to read plan, determine current phase, implement, test, commit
- Branch management: validate or create branch
- 5x protocol: emit `<!-- 5x:status -->` with `result`, `commit`, `phase`

**`author-process-review.md`:**
- Variables: `review_path`, `plan_path`
- Instructs agent to address review feedback (latest addendum if present)
- If task is plan revision only, skip test execution
- 5x protocol: emit `<!-- 5x:status -->` with `result`

- [x] Write `author-generate-plan.md` template
- [x] Write `author-next-phase.md` template
- [x] Write `author-process-review.md` template
- [x] Ensure all templates include 5x protocol section with format spec + classification guidance
- [x] Unit tests: each template renders with valid variables, missing variable errors

### 3.3 Prompt templates — Reviewer templates

**`reviewer-plan.md`:**
- Variables: `plan_path`, `review_path`
- Staff Engineer review perspective
- Creates or appends to the review document at `{{review_path}}`
- 5x protocol: append `<!-- 5x:verdict -->` with `readiness`, `reviewPath` echoing `{{review_path}}`, per-item `action` classification

**`reviewer-commit.md`:**
- Variables: `commit_hash`, `review_path`, `plan_path`
- Staff Engineer review of implementation
- 5x protocol: append `<!-- 5x:verdict -->` with `readiness`, `reviewPath` echoing `{{review_path}}`, per-item `action` classification

- [x] Write `reviewer-plan.md` template
- [x] Write `reviewer-commit.md` template
- [x] Ensure verdict block format spec includes classification guidance (auto_fix vs human_required with examples)
- [x] Unit tests: each template renders with valid variables

### 3.4 `src/commands/init.ts` — Project initialization (simplified)

```
$ 5x init
  Created 5x.config.js
  Created .5x/ directory
  Added .5x/ to .gitignore
```

- [x] Generate `5x.config.js` with detected defaults (detect which agent harnesses are available via `claude --version`, `opencode --version`), including JSDoc `@type` annotation for autocomplete
- [x] Create `.5x/` directory
- [x] Append `.5x/` to `.gitignore` if not already present
- [x] Skip config file if already exists (with `--force` flag to overwrite)
- [x] Unit tests: init to empty project, init with existing config, .gitignore append idempotency

---

## Phase 4: Plan Generation + Review Loop

**Completion gate:** `5x plan <prd-path>` generates an implementation plan via the author agent. `5x plan-review <plan-path>` runs the full review loop: reviewer → verdict → auto-fix → re-review, with human escalation on `human_required` items or max iterations. All orchestration state persisted to SQLite — resume works after interruption. End-to-end integration test proves the loop with mocked agent responses.

### 4.1 `src/commands/plan.ts` — Plan generation

The CLI computes a deterministic target plan path before invoking the agent and passes it in the prompt. The agent writes the plan to that path and echoes it in the `5x:status` block. The CLI never infers the plan path by directory scanning.

```
$ 5x plan docs/workflows/370-court-time-allocation-reporting.md

  Generating implementation plan from PRD...
  Target: docs/development/720-impl-court-time-allocation-reporting.md
  Author (claude-opus-4-6) .............. done (38s)
  
  Created: docs/development/720-impl-court-time-allocation-reporting.md
  Phases: 5
  
  Next: 5x plan-review docs/development/720-impl-court-time-allocation-reporting.md
```

Target path computation: `<config.paths.plans>/<next-sequence-number>-impl-<slug-from-prd>.md`. User can override with `--out <path>`. If the computed path already exists (e.g., parallel runs), auto-increment the sequence number until a free path is found.

Review path computation (used in `plan-review` and `run`): on the first review for a plan, the CLI computes `<config.paths.reviews>/<date>-<plan-basename>-review.md` (e.g., plan `001-impl-5x-cli.md` → review `2026-02-15-001-impl-5x-cli-review.md`) and persists it in the `runs` table (`review_path` column). On subsequent runs for the same plan, the CLI checks the DB for an existing `review_path` and reuses it — this keeps a single addendum trail even across multi-day runs, without directory scanning. If no DB entry exists (first run, or DB reset), the path is computed fresh. If the review file already exists on disk, append to it (addendum model).

- [ ] Compute target plan path deterministically (sequence number from existing plans + slug from PRD title), or accept `--out <path>` override
- [ ] Read PRD/TDD file(s) from provided path(s)
- [ ] Render prompt from `author-generate-plan` template with variables `{ prd_path, plan_path, plan_template_path }`
- [ ] Invoke author adapter with rendered prompt
- [ ] Parse `5x:status` from output; verify `planPath` matches expected target path
- [ ] Store parsed status in DB via `upsertAgentResult()` (run_id, role='author', template_name, signal_data)
- [ ] If no `5x:status` block → escalate to human (never scan for new files)
- [ ] Upsert plan record in DB (`plans` table) for future association
- [ ] Display result with suggested next command
- [ ] Handle author `needs_human` / `failed` signals

### 4.2 `src/orchestrator/plan-review-loop.ts` — Loop 1 state machine

```typescript
export interface PlanReviewResult {
  approved: boolean;
  iterations: number;
  reviewPath: string;
  escalations: EscalationEvent[];
}

export async function runPlanReviewLoop(
  planPath: string,
  config: FiveXConfig,
  options: { auto?: boolean },
): Promise<PlanReviewResult> { ... }
```

State transitions:

```
REVIEW → PARSE_VERDICT → APPROVED          (ready)
REVIEW → PARSE_VERDICT → AUTO_FIX → REVIEW (ready_with_corrections, all auto_fix)
REVIEW → PARSE_VERDICT → ESCALATE          (has human_required items)
REVIEW → PARSE_VERDICT → ESCALATE          (missing verdict block)
AUTO_FIX → PARSE_STATUS → REVIEW           (author completed)
AUTO_FIX → PARSE_STATUS → ESCALATE         (author needs_human)
ESCALATE → REVIEW                          (human provides guidance, continue)
ESCALATE → APPROVED                        (human overrides, accepts)
ESCALATE → ABORTED                         (human aborts)
any → ESCALATE                             (max iterations reached)
```

**DB integration:** Each state transition is recorded as a `run_event`. Parsed `5x:verdict` and `5x:status` blocks are stored in `agent_results` as the SOT for routing decisions. The commented YAML in the review markdown file is a human-inspectable artifact but is not re-read by the orchestrator after initial parse.

**Resume behavior:** On startup, check `getActiveRun(planPath)` — if an active run exists for command `plan-review`, prompt: `"Found interrupted run <id> at iteration <N>. Resume? [yes/no/start-fresh]"`. Resume re-enters the state machine at the recorded `currentState`. Before each agent invocation, the orchestrator calls `hasCompletedStep(runId, role, phase, iteration, templateName)` — if the step already has a result in the DB, it skips invocation and uses the stored result. If a step is re-run (e.g., interrupted mid-invocation), the new result replaces the old via `ON CONFLICT DO UPDATE`.

- [ ] Create `run` record in DB at loop start (`createRun()`)
- [ ] Resolve review path: check DB for existing `review_path` from prior runs on this plan (reuse for addendum continuity); if none, compute `<config.paths.reviews>/<date>-<plan-basename>-review.md`
- [ ] Implement state machine with clear transition logging
- [ ] Append `run_event` on each state transition (`appendRunEvent()`)
- [ ] Render reviewer prompt from `reviewer-plan` template with variables `{ plan_path, review_path }`
- [ ] Invoke reviewer adapter; store result in `agent_results` table
- [ ] Parse `5x:verdict` from the CLI-computed review file path (never scan for review files)
- [ ] Store parsed verdict in DB as SOT; use DB for routing decisions
- [ ] Verify `5x:verdict.reviewPath` matches expected path; warn if mismatched
- [ ] Route based on verdict: ready → done, auto_fix items → author, human_required → escalate
- [ ] Render author prompt from `author-process-review` template for auto-fix cycles
- [ ] Invoke author adapter; store result in `agent_results` table
- [ ] Parse `5x:status` from author output; store in DB
- [ ] Track iteration count, enforce `maxReviewIterations`
- [ ] Update run status on completion/abort (`updateRunStatus()`)
- [ ] Implement human escalation prompt (display items, options: continue/abort/override)
- [ ] Implement `--auto` behavior: proceed on auto_fix, still escalate on human_required
- [ ] Detect interrupted runs on startup; prompt for resume
- [ ] Unit tests with mocked adapters: happy path, two-iteration fix, escalation, max iterations, resume after interruption

### 4.3 `src/commands/plan-review.ts` — CLI command wiring

- [ ] Parse command arguments (plan path, `--auto`, `--allow-dirty`, flags)
- [ ] Run git safety check; abort on dirty tree unless `--allow-dirty`
- [ ] Validate plan file exists and is parseable
- [ ] Initialize DB connection and run migrations
- [ ] Initialize adapters from config
- [ ] Call `runPlanReviewLoop`
- [ ] Display final result (with run ID for future reference)

---

## Phase 5: Phase Execution Loop

**Completion gate:** `5x run <plan-path>` executes phases sequentially. Per phase: author implements → quality gates → reviewer → auto-fix cycles → human gate → next phase. Plan-level locking prevents concurrent execution. `--worktree` creates isolated git worktrees. All state persisted to SQLite — resume works after interruption. Quality gate results stored in DB. End-to-end integration test with mocked agents proves the full loop.

### 5.1 `src/gates/quality.ts` — Quality gate runner

```typescript
export interface QualityResult {
  passed: boolean;
  results: Array<{
    command: string;
    passed: boolean;
    output: string;       // truncated for DB/display (first 4KB)
    outputPath?: string;  // full output written to .5x/logs/<run-id>/...
    duration: number;
  }>;
}

export async function runQualityGates(
  commands: string[],
  workdir: string,
  opts: { runId: string; logDir: string },
): Promise<QualityResult> { ... }
```

**Output retention strategy:** Quality gate command output and agent output can be large (multi-MB test output, verbose build logs). The DB stores structured summaries only; full output goes to the filesystem.

- DB `quality_results.results` JSON: per-command `{ command, passed, duration, outputPath }` + first 4KB of output (truncated, for terminal display and quick diagnostics).
- Full output: `.5x/logs/<run-id>/quality-phase<N>-attempt<M>-<command-slug>.log`
- Agent output: `.5x/logs/<run-id>/agent-<invocation-id>.log` (full adapter output, referenced by `agent_results.id`)
- Terminal display: show truncated output inline; on failure, display path to full log file.
- Cleanup: log files are retained until `5x worktree cleanup` or manual deletion. No automatic retention policy for v1.

- [ ] Run each configured command sequentially
- [ ] Capture stdout/stderr for each; write full output to `.5x/logs/<run-id>/`
- [ ] Store truncated output (first 4KB) + file path in DB results JSON
- [ ] Report pass/fail per command and overall
- [ ] Timeout handling per command
- [ ] Store structured results in DB via `upsertQualityResult()` (id, run_id, phase, attempt, passed, results JSON)
- [ ] Unit tests with mocked commands

### 5.2 `src/git.ts` — Git operations, safety invariants, and worktree support

```typescript
// --- Safety checks (run before any agent invocation) ---
export interface GitSafetyReport {
  repoRoot: string;
  branch: string;
  isDirty: boolean;            // staged or unstaged changes
  untrackedFiles: string[];
  safe: boolean;               // true if clean (or --allow-dirty)
}
export async function checkGitSafety(workdir: string): Promise<GitSafetyReport> { ... }

// --- Branch operations ---
export async function getCurrentBranch(workdir: string): Promise<string> { ... }
export async function createBranch(name: string, workdir: string): Promise<void> { ... }
export async function getLatestCommit(workdir: string): Promise<string> { ... }
export async function hasUncommittedChanges(workdir: string): Promise<boolean> { ... }
export async function getBranchCommits(base: string, workdir: string): Promise<string[]> { ... }

// --- Worktree operations ---
export interface WorktreeInfo {
  path: string;
  branch: string;
}
export async function createWorktree(repoRoot: string, branch: string, path: string): Promise<WorktreeInfo> { ... }
export async function removeWorktree(repoRoot: string, path: string): Promise<void> { ... }
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> { ... }
```

Git safety invariants:
- `checkGitSafety()` runs `git status --porcelain` and `git rev-parse --show-toplevel` before any phase execution or review loop.
- Default behavior is **fail-closed**: if the working tree is dirty, the CLI refuses to proceed and displays a clear remediation message (`"Working tree has uncommitted changes. Commit or stash them, or pass --allow-dirty to proceed."`).
- `--allow-dirty` allows proceeding with a dirty tree; this is recorded in run output and requires explicit confirmation in interactive mode.
- `--auto` mode NEVER bypasses git safety checks. `--auto --allow-dirty` is the only way to auto-run with a dirty tree.

Worktree operations:
- `createWorktree()` runs `git worktree add <path> -b <branch>`. Path defaults to `.5x/worktrees/<branch-name>`.
- `removeWorktree()` runs `git worktree remove <path>`. Does NOT delete the branch by default (branch may have unmerged commits). With `--force`: removes even if worktree has changes, and optionally deletes the branch if it has been fully merged.
- `listWorktrees()` runs `git worktree list --porcelain` and parses output.
- If branch already exists, reuse it: `git worktree add <path> <branch>` (no `-b`).

- [ ] Implement `checkGitSafety()` via `git status --porcelain` + `git rev-parse`
- [ ] Implement remaining git helpers via subprocess
- [ ] Branch name generation from plan title/number (e.g., `5x/001-impl-5x-cli`)
- [ ] Validate branch relevance (does branch name relate to plan?)
- [ ] Implement `createWorktree()`, `removeWorktree()`, `listWorktrees()`
- [ ] Handle worktree reuse (branch/path already exists)
- [ ] Unit tests with a temp git repo: clean state, dirty state, untracked files, worktree create/remove

### 5.3 `src/orchestrator/phase-execution-loop.ts` — Loop 2 state machine

```typescript
export interface PhaseExecutionResult {
  phasesCompleted: number;
  totalPhases: number;
  complete: boolean;
  aborted: boolean;
  escalations: EscalationEvent[];
  runId: string;
}

export async function runPhaseExecutionLoop(
  planPath: string,
  config: FiveXConfig,
  options: { auto?: boolean; startPhase?: number; worktree?: boolean },
): Promise<PhaseExecutionResult> { ... }
```

Per-phase inner loop:

```
0. Acquire plan lock (abort if locked by another process)
1. Resolve workdir: check DB for worktree association, or create if --worktree
2. Run git safety check in workdir (fail-closed unless --allow-dirty)
3. Parse plan → identify current phase
4. Validate/create git branch in workdir
5. Render author prompt from author-next-phase template
6. Invoke author → store result in agent_results table
7. Parse 5x:status → handle needs_human / failed
8. Run quality gates in workdir → store result in quality_results table
   - If fail: re-invoke author with failure output (up to maxQualityRetries)
   - If still fail: escalate
9. Render reviewer prompt from reviewer-commit template
10. Invoke reviewer → store result in agent_results table
11. Parse 5x:verdict from review file → store in DB as SOT
   - ready → proceed to phase gate
   - auto_fix items → invoke author (process-review), loop to step 8
   - human_required → escalate
   - missing verdict → escalate
12. Phase gate (human confirmation unless --auto)
13. Next phase (fresh agent sessions)
14. Release plan lock on exit (including SIGINT/SIGTERM)
```

**DB integration:** All orchestration state flows through the database:
- `runs` table: create on start, update `current_phase`/`current_state` on each transition
- `run_events` table: append-only journal of every state transition
- `agent_results` table: parsed signals stored immediately after agent invocation, used as SOT for routing
- `quality_results` table: gate outcomes stored per phase/attempt
- `plans` table: worktree/branch association persisted for future command resolution

**Resume behavior:** On startup, check `getActiveRun(planPath)` — if an active run exists, prompt: `"Found interrupted run <id> at phase <N>, state <S>. Resume? [yes/no/start-fresh]"`. Resume re-enters at the recorded state. Before each agent invocation, the orchestrator calls `hasCompletedStep()` — if the step already has a result, skip and use stored result. If re-running (interrupted mid-invocation), `ON CONFLICT DO UPDATE` replaces the old result. Starting fresh marks the old run as `aborted`.

**Lock integration:** `acquireLock()` at startup, `releaseLock()` on exit. If locked by another live process, abort with message: `"Plan is locked by PID <N> (started <time>). Another 5x process is running on this plan."` If stale, prompt to steal.

**Worktree integration:** If `--worktree` flag is set (and no worktree exists for this plan), create worktree + branch. Persist in DB. On subsequent runs for the same plan, auto-resolve `workdir` from DB even without `--worktree` flag. All agent invocations and quality gates run in the worktree.

- [ ] Acquire plan lock at loop start; release on exit (including signal handlers)
- [ ] Resolve workdir: check `getPlan(planPath)` for worktree association
- [ ] If `--worktree` and no existing worktree: create via `createWorktree()`, persist in DB via `upsertPlan()`
- [ ] Create `run` record in DB at loop start
- [ ] Implement outer loop (iterate phases)
- [ ] Implement inner review-fix loop (within a phase)
- [ ] Render author prompt from `author-next-phase` template with variables `{ plan_path, phase_number, user_notes }`
- [ ] Invoke author adapter; store result in `agent_results` table
- [ ] Render reviewer prompt from `reviewer-commit` template with variables `{ commit_hash, review_path, plan_path }`
- [ ] Invoke reviewer adapter; store result in `agent_results` table
- [ ] Quality gate integration with retry logic; store results in `quality_results` table
- [ ] Append `run_event` on each state transition
- [ ] Update `runs.current_phase`, `runs.current_state` on each transition
- [ ] Git branch validation/creation at phase start (in correct workdir)
- [ ] Detect new commits after author invocation (for reviewer input)
- [ ] Human gate between phases: display summary, prompt for continue/review/abort
- [ ] `--auto` mode: skip inter-phase gate, still escalate on `human_required`
- [ ] `--phase N` flag: skip to specific phase
- [ ] Detect interrupted runs on startup; prompt for resume
- [ ] Mark run as `completed`/`aborted`/`failed` on exit
- [ ] Track and display cumulative progress
- [ ] Unit tests with mocked adapters: single-phase happy path, quality gate failure + retry, review fix cycle, escalation, multi-phase progression, lock contention, worktree creation, resume after interruption

### 5.4 `src/gates/human.ts` — Interactive prompts

```typescript
export async function phaseGate(summary: PhaseSummary): Promise<'continue' | 'review' | 'abort'>;
export async function escalationGate(event: EscalationEvent): Promise<EscalationResponse>;
```

- [ ] Phase gate: display phase summary (files changed, tests, review verdict), prompt for decision
- [ ] Escalation gate: display escalation reason + context, prompt for guidance or override
- [ ] Handle non-interactive mode (pipe detection) — default to abort with message
- [ ] Unit tests with simulated stdin

### 5.5 `src/commands/run.ts` — CLI command wiring

- [ ] Parse command arguments (plan path, `--phase`, `--auto`, `--allow-dirty`, `--skip-quality`, `--worktree`)
- [ ] Initialize DB connection and run migrations
- [ ] Resolve workdir from DB plan association (worktree auto-detection)
- [ ] Run git safety check in resolved workdir; abort on dirty tree unless `--allow-dirty`
- [ ] Validate plan file, check for incomplete phases
- [ ] Initialize adapters from config
- [ ] Call `runPhaseExecutionLoop` (with DB, lock, and worktree integration)
- [ ] Display final result (phases completed, total time, review links, run ID)

### 5.6 `src/commands/worktree.ts` — Worktree management

```
$ 5x worktree status docs/development/001-impl-5x-cli.md
  Plan: 001-impl-5x-cli
  Worktree: .5x/worktrees/5x/001-impl-5x-cli
  Branch: 5x/001-impl-5x-cli

$ 5x worktree cleanup docs/development/001-impl-5x-cli.md
  Checking worktree .5x/worktrees/5x/001-impl-5x-cli...
  Worktree is clean.
  Removing worktree...
  Branch 5x/001-impl-5x-cli retained (use --delete-branch to remove).
  Cleared plan worktree association from DB.

$ 5x worktree cleanup docs/development/001-impl-5x-cli.md --delete-branch
  Checking worktree .5x/worktrees/5x/001-impl-5x-cli...
  Worktree is clean.
  Branch 5x/001-impl-5x-cli is fully merged.
  Removing worktree...
  Deleting branch 5x/001-impl-5x-cli...
  Cleared plan worktree association from DB.
```

Cleanup safety:
- Default: removes worktree directory only; retains the branch (may have unmerged work).
- `--delete-branch`: also deletes the branch, but ONLY if it is fully merged into HEAD or its upstream. Aborts with an error if branch has unmerged commits.
- Refuses to remove worktree if it has uncommitted changes — user must commit/stash first, or pass `--force`.
- `--force`: removes worktree even with uncommitted changes (data loss warning displayed). Does NOT force-delete unmerged branches — that requires explicit `--force --delete-branch`.

- [ ] `5x worktree status <plan-path>` — show worktree info from DB
- [ ] `5x worktree cleanup <plan-path>` — remove worktree only, retain branch, clear DB association
- [ ] `--delete-branch` flag: also delete branch if fully merged; abort if unmerged
- [ ] Refuse cleanup if worktree has uncommitted changes (unless `--force`)
- [ ] `--force`: remove worktree with uncommitted changes (display data loss warning)
- [ ] `--force --delete-branch`: NOT allowed for unmerged branches (always aborts)

---

## Phase 6: OpenCode Adapter

**Completion gate:** OpenCode adapter passes the same integration tests as Claude Code adapter. Config-driven adapter selection works. Both adapters can be used in the same run (e.g., author=claude-code, reviewer=opencode).

### 6.1 `src/agents/opencode.ts` — OpenCode SDK adapter

```typescript
export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode';

  async isAvailable(): Promise<boolean> {
    // Check opencode binary or SDK availability
  }

  async invoke(opts: InvokeOptions): Promise<AgentResult> {
    // Use @opencode-ai/sdk to create session and send prompt
    // Parse response into AgentResult
  }
}
```

- [ ] Research OpenCode SDK session/message API (from `@opencode-ai/sdk`)
- [ ] Implement invoke using SDK programmatic API
- [ ] Map SDK response to `AgentResult`
- [ ] Handle model specification (OpenCode uses frontmatter `model:` field)
- [ ] `isAvailable()` check
- [ ] Unit tests with mocked SDK
- [ ] Integration test: real OpenCode invocation round-trip

### 6.2 Adapter factory update

- [ ] Add OpenCode to factory switch
- [ ] Validate adapter availability at startup (warn if configured adapter unavailable)
- [ ] Integration test: mixed adapter run (author=claude-code, reviewer=opencode)

---

## Phase 7: Reporting, Auto Mode, Polish

**Completion gate:** `5x history` shows run history and metrics from DB. `--auto` mode works end-to-end. `--dry-run` shows planned actions without executing. Terminal output is polished. Token/cost tracking is displayed.

> **Architecture change (v1.3):** `5x upgrade` for templates has been removed — templates are bundled with the CLI and update when the CLI updates. This phase now focuses on DB-powered reporting instead.

### 7.1 `src/commands/history.ts` — Run history and reporting

```
$ 5x history
  Recent runs (all plans):
  
  ID       Plan                     Command      Status     Duration  Phases  Iterations
  abc123   001-impl-5x-cli          run          completed  2h 15m    3/7     12
  def456   001-impl-5x-cli          plan-review  completed  8m        —       3
  ghi789   002-impl-metrics         run          aborted    45m       1/4     5

$ 5x history docs/development/001-impl-5x-cli.md
  Runs for 001-impl-5x-cli:

  Run abc123 (5x run, completed 2h ago):
    Phases completed: 3/7
    Total iterations: 12
    Agent invocations: 18 (author: 12, reviewer: 6)
    Total tokens: 450K in / 120K out
    Estimated cost: $3.20
    Quality gates: 8 passed, 2 failed (retried)

$ 5x history --run abc123
  Detailed event log for run abc123:
  ...
```

- [ ] `5x history` — list recent runs from DB (`getRunHistory()`)
- [ ] `5x history <plan-path>` — list runs for a specific plan with metrics
- [ ] `5x history --run <id>` — detailed event log for a specific run
- [ ] Aggregate metrics from `agent_results` table: invocation counts, token totals, cost totals, duration
- [ ] Aggregate quality gate stats from `quality_results` table
- [ ] Formatted terminal output with tables
- [ ] `--json` flag for machine-readable output
- [ ] Unit tests with seeded DB data

### 7.2 `--auto` mode guardrails

`--auto` skips inter-phase human gates but retains all safety checks. It is treated as "powerful but guarded" — not "skip all prompts."

**Hard guardrails (enforced, not configurable):**
- Git safety checks are never bypassed (dirty tree → abort unless `--allow-dirty`).
- `human_required` items always escalate, even in `--auto`.
- Non-zero exit codes from agents always stop the loop.

**Configurable limits (with defaults in config):**
- `maxAutoIterations` (default: 10): total review-fix cycles per phase before aborting. Prevents infinite loops when reviewer and author disagree.
- `maxAutoRetries` (default: 3): quality gate retry attempts per phase before escalating.
- `maxReviewIterations` (default: 5): review loop iterations before escalating.

**First-use confirmation:**
- The first time `--auto` is used in a project, the CLI displays a one-time confirmation prompt explaining what auto mode does and what safeguards are in place. The user must confirm with `--auto --confirm` or respond to the interactive prompt. Subsequent runs skip this (tracked via `.5x/auto-confirmed`).

**Abort conditions (any of these stops the auto run):**
- Any hard limit exceeded
- Agent returns `needs_human` or `failed`
- Reviewer verdict contains `human_required` items
- Quality gates fail after max retries
- Git safety check fails
- Agent process crashes or times out

- [ ] Implement hard limits with clear abort messages
- [ ] Implement first-use confirmation flow
- [ ] Track confirmation state in `.5x/auto-confirmed`
- [ ] Display running tallies (iteration N of max M) during auto runs
- [ ] Unit tests: limit enforcement, abort conditions, first-use confirmation

### 7.3 `--dry-run` mode

- [ ] Add `--dry-run` flag to `plan`, `plan-review`, `run`
- [ ] Display planned actions without invoking agents or modifying files
- [ ] Show: which adapters would be used, which commands, which quality gates

### 7.4 Terminal output polish

- [ ] Consistent formatting with box-drawing characters or `@clack/prompts`
- [ ] Progress indicators during agent invocations (spinner/dots)
- [ ] Color-coded verdicts (green=ready, yellow=corrections, red=not ready)
- [ ] Cumulative stats at end of run: phases, iterations, duration, agent invocations
- [ ] Token usage and estimated cost tracking (if adapter provides token counts)

### 7.5 `src/logger.ts` — Structured output

- [ ] Log levels: info (default), verbose (`--verbose`), quiet (`--quiet`)
- [ ] Machine-readable output mode (`--json`) for CI/scripting
- [ ] Agent invocation logging (prompt length, duration, tokens)

### 7.6 Build and distribution

- [ ] `build.ts` script: `bun build --compile` for native binary (Linux, macOS, Windows targets)
- [ ] `package.json` bin field for `bunx 5x`
- [ ] README with installation, quickstart, and configuration docs
- [ ] Document supported runtimes: Bun runtime or compiled binary only (no Node)

---

## Files Touched

| File | Change |
|------|--------|
| `src/bin.ts` | MOD — CLI entry point, command routing (added init subcommand) |
| `src/config.ts` | MOD — Config loader with Zod validation (add `db.path` field) |
| `src/version.ts` | DONE — CLI version tracking |
| `src/db/connection.ts` | NEW — SQLite singleton, WAL mode, cleanup handlers |
| `src/db/schema.ts` | NEW — Schema DDL, migration runner |
| `src/db/operations.ts` | NEW — Typed CRUD helpers for all tables |
| `src/lock.ts` | NEW — Plan-level file locking with stale PID detection |
| `src/templates/loader.ts` | DONE — Template loading + `{{variable}}` rendering |
| `src/templates/author-generate-plan.md` | DONE — Bundled prompt template |
| `src/templates/author-next-phase.md` | DONE — Bundled prompt template |
| `src/templates/author-process-review.md` | DONE — Bundled prompt template |
| `src/templates/reviewer-plan.md` | DONE — Bundled prompt template |
| `src/templates/reviewer-commit.md` | DONE — Bundled prompt template |
| `src/commands/init.ts` | DONE — Project initialization (config + .5x/ + .gitignore) |
| `src/commands/plan.ts` | NEW — Plan generation command |
| `src/commands/plan-review.ts` | NEW — Plan review loop command |
| `src/commands/run.ts` | NEW — Phase execution loop command |
| `src/commands/status.ts` | MOD — Plan status display (add DB run state) |
| `src/commands/history.ts` | NEW — Run history and reporting from DB |
| `src/commands/worktree.ts` | NEW — Worktree status and cleanup |
| `src/agents/types.ts` | DONE — Agent adapter interface |
| `src/agents/claude-code.ts` | DONE — Claude Code subprocess adapter |
| `src/agents/opencode.ts` | NEW — OpenCode SDK adapter |
| `src/agents/factory.ts` | DONE — Config-driven adapter instantiation |
| `src/orchestrator/plan-review-loop.ts` | NEW — Loop 1 state machine (DB-backed) |
| `src/orchestrator/phase-execution-loop.ts` | NEW — Loop 2 state machine (DB + lock + worktree) |
| `src/parsers/plan.ts` | DONE — Implementation plan markdown parser |
| `src/parsers/signals.ts` | DONE — 5x:verdict / 5x:status block parsers |
| `src/parsers/review.ts` | DONE — Review summary parser |
| `src/parsers/markdown.ts` | NEW — Shared markdown utilities |
| `src/gates/quality.ts` | NEW — Quality gate command runner (results → DB) |
| `src/gates/human.ts` | NEW — Interactive terminal prompts |
| `src/git.ts` | NEW — Git operations, safety invariants, worktree support |
| `src/logger.ts` | NEW — Structured terminal output |
| `build.ts` | NEW — Build script for compile + bundle |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `parsers/plan.test.ts` | Phase extraction, checklist parsing, completion calculation from real plan files |
| Unit | `parsers/signals.test.ts` | Verdict/status block extraction, YAML parsing, malformed input handling |
| Unit | `parsers/review.test.ts` | Review summary extraction, P0/P1/P2 counting, addendum detection |
| Unit | `config.test.ts` | Config loading, validation, defaults, missing file handling |
| Unit | `db/connection.test.ts` | Singleton creation, WAL mode, cleanup on exit |
| Unit | `db/schema.test.ts` | Fresh migration, already-migrated no-op, partial resume |
| Unit | `db/operations.test.ts` | CRUD round-trips, upsert idempotency, concurrent read (WAL) |
| Unit | `lock.test.ts` | Acquire/release, stale PID detection, re-entrant same PID, contention |
| Unit | `templates/loader.test.ts` | Template rendering, missing variable errors, unknown variable errors |
| Unit | `agents/claude-code.test.ts` | Subprocess argument construction, output parsing, exit code mapping |
| Unit | `agents/factory.test.ts` | Config-driven adapter instantiation |
| Unit | `orchestrator/plan-review-loop.test.ts` | State transitions with mocked adapters + DB: happy path, multi-iteration, escalation, resume |
| Unit | `orchestrator/phase-execution-loop.test.ts` | Phase progression, quality retry, review fix cycles, human gates, lock contention, worktree creation, resume |
| Unit | `gates/quality.test.ts` | Command execution, pass/fail aggregation, timeout handling, results stored in DB |
| Unit | `git.test.ts` | Branch operations, safety checks, worktree create/remove against temp repos |
| Integration | `claude-code-adapter.test.ts` | Real Claude Code CLI invocation round-trip. **Env-gated:** only runs when `FIVE_X_TEST_LIVE_AGENTS=1` is set. Not in default CI. |
| Integration | `opencode-adapter.test.ts` | Real OpenCode SDK invocation round-trip. **Env-gated:** only runs when `FIVE_X_TEST_LIVE_AGENTS=1` is set. Not in default CI. |
| Integration | `claude-code-schema-probe.test.ts` | Validates Claude Code `--output-format json` schema has expected fields. **Env-gated.** |
| Integration | `plan-review-e2e.test.ts` | Full plan-review loop with mocked agent responses + DB (golden test, runs in CI) |
| Integration | `phase-execution-e2e.test.ts` | Full phase execution loop with mocked agents + git repo + DB + lock (golden test, runs in CI) |

---

## Not In Scope

- **Web dashboard or monitoring UI** — terminal output only; CI integration is sufficient
- **Token cost optimization** — agents manage their own context; CLI only reports what adapters provide
- **Multi-project orchestration** — single project root per invocation
- **Custom agent adapters** — only Claude Code and OpenCode; plugin system deferred
- **Reviewer model selection heuristics** — user configures models; CLI doesn't choose
- **`5x archive` command** — plan/review archival lifecycle deferred to post-v1; the core generate → review → execute loop ships first
- **User-customizable prompt templates** — v1 uses bundled-only templates; local override mechanism deferred
- **Node runtime support** — Bun runtime or compiled binary only; no Node-compatible entrypoint, no `better-sqlite3` fallback
- **Multi-machine lock coordination** — file locks are local-only; shared filesystem locking deferred
- **DB migration rollback** — forward-only migrations; delete `.5x/5x.db` to reset

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Foundation — config (JS), parsers, signal protocol v1, status | 2 days (**COMPLETE**) |
| 1.1 | Architecture foundation — SQLite DB, plan lock, config updates, test fixes | 1.5 days |
| 2 | Agent adapters (Claude Code) + schema probe | 1 day (**COMPLETE**) |
| 3 | Prompt templates (bundled SSOT) + simplified init | 0.5 days (**COMPLETE**) |
| 4 | Plan generation + review loop (DB-backed) | 1.5 days |
| 5 | Phase execution loop + git safety + worktree + lock integration | 3 days |
| 6 | OpenCode adapter | 1 day |
| 7 | Reporting (DB), auto mode guardrails, polish | 2 days |
| **Total** | | **13 days** |
