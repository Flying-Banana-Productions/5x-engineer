# 5x CLI — Automated Author-Review Loop Runner

**Version:** 1.2
**Created:** February 15, 2026
**Status:** Draft — revised per staff engineer review feedback (v1.1: P0/P1 blockers; v1.2: template contracts, .5x hygiene, scope, collision handling)

---

## Executive Summary

The 5x workflow (described in the [project README](../../README.md)) is a two-phase author-review loop with human-gated checkpoints: an author agent writes plans and code, a reviewer agent critiques, and the human decides when to proceed. Today this loop is driven manually — the developer invokes slash commands one at a time, copies paths between them, reads review verdicts, and decides next steps.

`5x-cli` automates the orchestration while preserving human oversight. It is a standalone CLI tool that drives author and reviewer agents through structured loops, reads machine-readable signals from agent output to determine next steps, and pauses for human intervention when agents identify decisions that require taste or judgment. The CLI is a dumb state machine; the agents carry the intelligence.

### Scope

**In scope:**
- CLI commands for the core plan lifecycle: generate → review → execute
- Agent adapter abstraction supporting Claude Code CLI and OpenCode SDK
- Structured signal protocol (`5x:verdict`, `5x:status`) embedded in agent output
- Versioned command template scaffolding with upgrade path
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
| **Scaffolded commands with `5x-` namespace** | Avoids collision with user's existing workflow commands. Version tracking enables `5x upgrade` to update templates while respecting user modifications. |
| **Human gate between phases, auto-resolve within** | Within a phase, mechanical review fixes are handled automatically (reviewer says `auto_fix`, author fixes, reviewer re-reviews). Between phases, always pause for human unless `--auto`. Agents escalate judgment calls at any point via `human_required` / `needs_human` signals. |
| **CLI owns artifact paths — no directory scanning** | The CLI computes deterministic output paths for plans, reviews, and logs before invoking agents, passes them to the agent prompt, and requires the `5x:status` block to echo the path back. The CLI never infers artifacts by "newest file" or directory-scanning heuristics. This prevents mis-association in repos with parallel workstreams, unrelated doc edits, or editor autosaves. |
| **Git safety is fail-closed by default** | Before any agent invocation in `plan-review` or `run`, the CLI checks repo root, current branch, dirty working tree, and untracked files. A dirty working tree aborts the run unless the user explicitly opts in with `--allow-dirty`. `--auto` never bypasses git safety checks. |
| **JS-only config for cross-runtime compatibility** | Config is `5x.config.js` / `.mjs` (not TypeScript). Runs natively in Bun, Node, and `bun build --compile` binaries without extra loaders. `defineConfig()` provides autocomplete via JSDoc `@type` annotations. Eliminates the TS-config-loading footgun across ESM/CJS/compiled runtimes. |
| **Minimal adapter output contract** | The orchestrator depends only on `exitCode`, `output` (full text), and `duration` from adapters. Optional fields like `filesModified` and `tokens` are used for display only, never for correctness decisions. All routing logic uses parsed `5x:*` signals and git observations (e.g., commit hash after author run). |

### References

- [5x Workflow Commands](../../commands/) — existing command templates
- [Implementation Plan Template](../_implementation_plan_template.md) — plan structure the CLI reads and updates
- [Review Template](reviews/_review_template.md) — review structure the CLI parses

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Phase 1: Foundation — Config, Parsers, Status](#phase-1-foundation--config-parsers-status)
3. [Phase 2: Agent Adapters](#phase-2-agent-adapters)
4. [Phase 3: Command Templates v1](#phase-3-command-templates-v1)
5. [Phase 4: Plan Generation + Review Loop](#phase-4-plan-generation--review-loop)
6. [Phase 5: Phase Execution Loop](#phase-5-phase-execution-loop)
7. [Phase 6: OpenCode Adapter](#phase-6-opencode-adapter)
8. [Phase 7: Upgrade, Auto Mode, Polish](#phase-7-upgrade-auto-mode-polish)

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

**Fresh subprocess per agent invocation.** Each call to an agent starts a new process with a clean context window. This matches the workflow principle of keeping context tight. Within a review-fix cycle (author fixes → reviewer re-reviews), each invocation is independent — the agent reads the updated files from disk. This is simpler to implement across both adapters and avoids context pollution.

**Graceful fallback when signals are missing.** Agents may not always produce the structured block (model variability, prompt drift, tool errors). Fallback rules: missing `5x:verdict` → escalate to human; missing `5x:status` → escalate to human (never assume completed, even with exit 0); any non-zero exit → assume failed. The CLI never crashes due to missing signals; worst case is an unnecessary human escalation. The CLI MUST NOT substitute unsafe guesses (e.g., "assume completed") when signals are absent.

**Bun-primary, node-compatible distribution.** Built with Bun (`bun build --compile` for native binary), published to npm with node-compatible entrypoint. Bun is the primary target because it's the author's stack and gives fast startup + native TypeScript. Node fallback ensures broader adoption. Config is JS-only (`5x.config.js` / `.mjs`) to avoid requiring TS loaders in Node or compiled binaries. The `loadConfig()` function uses dynamic `import()` which works in all three targets (Bun runtime, Node runtime, compiled binary). If config fails to load, the error message tells the user which file was attempted and what format is expected.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                        5x CLI                            │
│                                                          │
│  ┌─────────┐   ┌──────────────┐   ┌──────────────────┐  │
│  │ Commands │──▶│ Orchestrator │──▶│  Agent Adapters   │  │
│  │          │   │              │   │                   │  │
│  │ plan     │   │ plan-review  │   │ ┌───────────────┐ │  │
│  │ plan-rev │   │   loop       │   │ │ Claude Code   │ │  │
│  │ run      │   │              │   │ │ (subprocess)  │ │  │
│  │ status   │   │ phase-exec   │   │ └───────────────┘ │  │
│  │ init     │   │   loop       │   │ ┌───────────────┐ │  │
│  │ upgrade  │   │              │   │ │ OpenCode      │ │  │
│  └─────────┘   └──────┬───────┘   │ │ (SDK)         │ │  │
│                        │           │ └───────────────┘ │  │
│                        ▼           └──────────────────┘  │
│              ┌──────────────────┐                        │
│              │  Signal Parsers  │                        │
│              │                  │                        │
│              │ parseVerdictBlock│                        │
│              │ parseStatusBlock │                        │
│              │ parsePlan        │                        │
│              └──────────────────┘                        │
│                        │                                 │
│              ┌─────────┴─────────┐                       │
│              │                   │                        │
│         ┌────▼─────┐     ┌──────▼───────┐                │
│         │ Quality  │     │ Human Gates  │                │
│         │ Gates    │     │ (terminal)   │                │
│         └──────────┘     └──────────────┘                │
└──────────────────────────────────────────────────────────┘

Signal flow:
  Reviewer agent ──writes──▶ review.md (includes <!-- 5x:verdict -->)
  Author agent   ──stdout──▶ captured by CLI (includes <!-- 5x:status -->)
  CLI            ──parses──▶ structured decisions (proceed / auto-fix / escalate / fail)
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
                                      │              │          │
                                 QUALITY_CHECK   (human        │
                                      │          decides)      │
                                 REVIEW ──▶ ...    │          │
                                              ┌────┘     ┌────┘
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

Load and validate `5x.config.js` (or `.mjs`) from project root with sensible defaults. Config is JS-only to ensure cross-runtime compatibility (Bun, Node, `bun build --compile` binary) without requiring TS loaders like `jiti` or `tsx`.

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
- Loading: use dynamic `import()` which works natively in Bun, Node ESM, and compiled binaries.
- The `defineConfig()` helper is exported from the `5x-cli` package; users get autocomplete via JSDoc `@type {import('5x-cli').FiveXConfig}` in their config file.
- If no config file is found, use defaults. If a file is found but fails to load (syntax error, wrong format), emit an actionable error: `"Failed to load 5x.config.js at <path>: <error>. Config must be a JS/MJS module exporting a default config object."`.

- [x] Config file discovery (walk up from cwd to find `5x.config.js` / `.mjs`)
- [x] Dynamic `import()` loader with actionable error messages on failure
- [x] Zod schema validation with clear error messages
- [x] Default values for all optional fields
- [x] `defineConfig()` helper exported for autocomplete via JSDoc
- [x] Unit tests: valid config, missing config (uses defaults), partial config with defaults, invalid values, `.mjs` variant
- [ ] Verify config loading works under Bun runtime, Node runtime, and `bun build --compile` output

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
  number: number;
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
}

export interface AgentResult {
  // --- Required (orchestration depends on these) ---
  output: string;             // full text output — signals are parsed from this
  exitCode: number;           // non-zero → assume failed
  duration: number;           // ms

  // --- Optional (display/logging only, never used for routing) ---
  tokens?: { input: number; output: number };
  cost?: number;              // USD if adapter reports it
  error?: string;             // stderr or error message on failure
}
```

- [ ] Define interface and types
- [ ] Export adapter factory type
- [ ] Add a "schema probe" test that validates Claude Code `--output-format json` output maps cleanly to the required fields, with clear error messages on schema changes

### 2.2 `src/agents/claude-code.ts` — Claude Code CLI adapter

Drives Claude Code via `claude -p "<prompt>" --output-format json`.

```typescript
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code';

  async isAvailable(): Promise<boolean> {
    // Check `claude --version` succeeds
  }

  async invoke(opts: InvokeOptions): Promise<AgentResult> {
    const args = [
      '-p', opts.prompt,
      '--output-format', 'json',
      '--max-turns', '50',
    ];
    if (opts.model) args.push('--model', opts.model);

    const proc = Bun.spawn(['claude', ...args], {
      cwd: opts.workdir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Parse structured JSON output
    // Extract cost/token info if available
    // Map exit codes
  }
}
```

- [ ] Implement subprocess spawning with timeout
- [ ] Parse Claude Code JSON output format (research `--output-format json` schema)
- [ ] Map JSON output to `AgentResult` — extract only `output`, `exitCode`, `duration`; optionally extract `tokens`/`cost` if present in JSON
- [ ] Lock parsing to specific known JSON fields with graceful handling of schema changes (log warning, don't crash)
- [ ] Handle stderr capture for error diagnostics
- [ ] Map exit codes to result states
- [ ] `isAvailable()` check via `claude --version`
- [ ] Unit tests with mocked subprocess
- [ ] Schema probe test: validate expected JSON output fields exist, fail loudly if schema has changed
- [ ] Integration test (env-gated): invoke Claude Code with a trivial prompt, verify round-trip

### 2.3 `src/agents/factory.ts` — Adapter factory

```typescript
export function createAdapter(config: AdapterConfig): AgentAdapter {
  switch (config.adapter) {
    case 'claude-code': return new ClaudeCodeAdapter();
    case 'opencode': return new OpenCodeAdapter();
    default: throw new Error(`Unknown adapter: ${config.adapter}`);
  }
}
```

- [ ] Config-driven adapter instantiation
- [ ] Availability check on creation (warn if adapter binary not found)
- [ ] Unit test: factory returns correct adapter type

---

## Phase 3: Command Templates v1

**Completion gate:** `5x init` scaffolds versioned command templates and config file into a project. Templates include the 5x signal protocol sections. `manifest.json` tracks versions and checksums.

### 3.1 Command templates — Author commands

Create command templates that include task instructions + 5x protocol output requirements.

**`commands/v1/claude-code/author-generate-plan.md`:**
- `$1`: PRD/TDD path(s)
- `$2`: CLI-computed target plan path (agent MUST write the plan to this path)
- Instructs agent to generate implementation plan using the project's plan template
- 5x protocol: emit `<!-- 5x:status -->` with `result` + `planPath` echoing `$2`

**`commands/v1/claude-code/author-next-phase.md`:**
- `$1`: plan path
- `$2`: optional user notes
- Instructs agent to read plan, determine current phase, implement, test, commit
- Branch management: validate or create branch
- 5x protocol: emit `<!-- 5x:status -->` with `result`, `commit`, `phase`

**`commands/v1/claude-code/author-process-review.md`:**
- `$1`: review document path (CLI-computed)
- `$2`: plan path
- Instructs agent to address review feedback (latest addendum if present)
- If task is plan revision only, skip test execution
- 5x protocol: emit `<!-- 5x:status -->` with `result`

- [ ] Write `author-generate-plan.md` template
- [ ] Write `author-next-phase.md` template
- [ ] Write `author-process-review.md` template
- [ ] Create OpenCode variants (different frontmatter: `agent`, `model` fields)
- [ ] Ensure all templates include 5x protocol section with format spec + classification guidance

### 3.2 Command templates — Reviewer commands

**`commands/v1/claude-code/reviewer-plan.md`:**
- `$1`: plan path
- `$2`: CLI-computed review file path (agent MUST write/append to this path)
- Staff Engineer review perspective
- Creates or appends to the review document at `$2`
- 5x protocol: append `<!-- 5x:verdict -->` to `$2` with `readiness`, `reviewPath` echoing `$2`, per-item `action` classification

**`commands/v1/claude-code/reviewer-commit.md`:**
- `$1`: commit hash
- `$2`: CLI-computed review file path (agent MUST write/append to this path)
- `$3`: plan path (for context)
- Staff Engineer review of implementation
- 5x protocol: append `<!-- 5x:verdict -->` to `$2` with `readiness`, `reviewPath` echoing `$2`, per-item `action` classification

- [ ] Write `reviewer-plan.md` template
- [ ] Write `reviewer-commit.md` template
- [ ] Create OpenCode variants
- [ ] Ensure verdict block format spec includes classification guidance (auto_fix vs human_required with examples)

### 3.3 `commands/v1/manifest.json` — Version tracking

```json
{
  "version": "v1",
  "files": {
    "author-generate-plan.md": { "checksum": "sha256:..." },
    "author-next-phase.md": { "checksum": "sha256:..." },
    "author-process-review.md": { "checksum": "sha256:..." },
    "reviewer-plan.md": { "checksum": "sha256:..." },
    "reviewer-commit.md": { "checksum": "sha256:..." }
  }
}
```

- [ ] Generate checksums for all template files
- [ ] Write manifest.json

### 3.4 `src/commands/init.ts` — Project initialization

```
$ 5x init
  ✓ Created 5x.config.js
  ✓ Added .5x/ to .gitignore
  ✓ Scaffolded 5 commands to .claude/commands/5x/
  ✓ Scaffolded 5 commands to .opencode/commands/
  ✓ Created .claude/commands/5x/.5x-version
  ✓ Created .opencode/commands/.5x-version
```

- [ ] Detect which harnesses are present (`.claude/` dir, `.opencode/` dir) and scaffold accordingly
- [ ] Copy command templates to appropriate locations
- [ ] Generate `.5x-version` file with version + per-file checksums
- [ ] Generate `5x.config.js` with detected defaults (adapter based on which harness exists), including JSDoc `@type` annotation for autocomplete
- [ ] Append `.5x/` to `.gitignore` if not already present (run journals + auto-confirmation state live here; must not be committed)
- [ ] Skip files that already exist (with `--force` flag to overwrite)
- [ ] Unit tests: scaffold to empty project, scaffold to project with existing commands, .gitignore append idempotency

---

## Phase 4: Plan Generation + Review Loop

**Completion gate:** `5x plan <prd-path>` generates an implementation plan via the author agent. `5x plan-review <plan-path>` runs the full review loop: reviewer → verdict → auto-fix → re-review, with human escalation on `human_required` items or max iterations. End-to-end integration test proves the loop with mocked agent responses.

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

Review path computation (used in `plan-review` and `run`): `<config.paths.reviews>/<date>-<plan-basename>-review.md`, where `<plan-basename>` is the full plan filename without extension (e.g., plan `001-impl-5x-cli.md` → review `2026-02-15-001-impl-5x-cli-review.md`). The sequence number is preserved to guarantee uniqueness across plans with the same subject slug. If the review file already exists, append to it (addendum model). Review paths are derived deterministically from the plan filename, not from a directory scan, so they are stable across runs for the same plan.

- [ ] Compute target plan path deterministically (sequence number from existing plans + slug from PRD title), or accept `--out <path>` override
- [ ] Read PRD/TDD file(s) from provided path(s)
- [ ] Compose prompt from `author-generate-plan` template + paths + target plan path
- [ ] Invoke author adapter
- [ ] Parse `5x:status` from output; verify `planPath` matches expected target path
- [ ] If no `5x:status` block → escalate to human (never scan for new files)
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

- [ ] Compute deterministic review path before first iteration: `<config.paths.reviews>/<date>-<plan-basename>-review.md` (preserves plan sequence number for uniqueness)
- [ ] Implement state machine with clear transition logging
- [ ] Invoke reviewer adapter with `reviewer-plan` template + CLI-computed review path passed in prompt
- [ ] Parse `5x:verdict` from the CLI-computed review file path (never scan for review files)
- [ ] Verify `5x:verdict.reviewPath` matches expected path; warn if mismatched
- [ ] Route based on verdict: ready → done, auto_fix items → author, human_required → escalate
- [ ] Invoke author adapter with `author-process-review` template for auto-fix cycles (pass review path)
- [ ] Parse `5x:status` from author output
- [ ] Track iteration count, enforce `maxReviewIterations`
- [ ] Implement human escalation prompt (display items, options: continue/abort/override)
- [ ] Implement `--auto` behavior: proceed on auto_fix, still escalate on human_required
- [ ] Log cumulative iteration count, agent invocations, and duration
- [ ] Unit tests with mocked adapters: happy path (ready on first review), two-iteration fix, escalation, max iterations

### 4.3 `src/commands/plan-review.ts` — CLI command wiring

- [ ] Parse command arguments (plan path, `--auto`, `--allow-dirty`, flags)
- [ ] Run git safety check; abort on dirty tree unless `--allow-dirty`
- [ ] Validate plan file exists and is parseable
- [ ] Initialize adapters from config
- [ ] Call `runPlanReviewLoop`
- [ ] Display final result

---

## Phase 5: Phase Execution Loop

**Completion gate:** `5x run <plan-path>` executes phases sequentially. Per phase: author implements → quality gates → reviewer → auto-fix cycles → human gate → next phase. Git branch management works. Quality gate failures trigger author retry. End-to-end integration test with mocked agents proves the full loop.

### 5.1 `src/gates/quality.ts` — Quality gate runner

```typescript
export interface QualityResult {
  passed: boolean;
  results: Array<{
    command: string;
    passed: boolean;
    output: string;
    duration: number;
  }>;
}

export async function runQualityGates(
  commands: string[],
  workdir: string,
): Promise<QualityResult> { ... }
```

- [ ] Run each configured command sequentially
- [ ] Capture stdout/stderr for each
- [ ] Report pass/fail per command and overall
- [ ] Timeout handling per command
- [ ] Unit tests with mocked commands

### 5.2 `src/git.ts` — Git operations and safety invariants

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

// --- Operations ---
export async function getCurrentBranch(workdir: string): Promise<string> { ... }
export async function createBranch(name: string, workdir: string): Promise<void> { ... }
export async function getLatestCommit(workdir: string): Promise<string> { ... }
export async function hasUncommittedChanges(workdir: string): Promise<boolean> { ... }
export async function getBranchCommits(base: string, workdir: string): Promise<string[]> { ... }
```

Git safety invariants:
- `checkGitSafety()` runs `git status --porcelain` and `git rev-parse --show-toplevel` before any phase execution or review loop.
- Default behavior is **fail-closed**: if the working tree is dirty, the CLI refuses to proceed and displays a clear remediation message (`"Working tree has uncommitted changes. Commit or stash them, or pass --allow-dirty to proceed."`).
- `--allow-dirty` allows proceeding with a dirty tree; this is recorded in run output and requires explicit confirmation in interactive mode.
- `--auto` mode NEVER bypasses git safety checks. `--auto --allow-dirty` is the only way to auto-run with a dirty tree.

- [ ] Implement `checkGitSafety()` via `git status --porcelain` + `git rev-parse`
- [ ] Implement remaining git helpers via subprocess
- [ ] Branch name generation from plan title/number
- [ ] Validate branch relevance (does branch name relate to plan?)
- [ ] Unit tests with a temp git repo: clean state, dirty state, untracked files

### 5.3 `src/orchestrator/phase-execution-loop.ts` — Loop 2 state machine

```typescript
export interface PhaseExecutionResult {
  phasesCompleted: number;
  totalPhases: number;
  complete: boolean;
  aborted: boolean;
  escalations: EscalationEvent[];
}

export async function runPhaseExecutionLoop(
  planPath: string,
  config: FiveXConfig,
  options: { auto?: boolean; startPhase?: number },
): Promise<PhaseExecutionResult> { ... }
```

Per-phase inner loop:

```
0. Run git safety check (fail-closed unless --allow-dirty)
1. Parse plan → identify current phase
2. Validate/create git branch
3. Invoke author (author-next-phase template)
4. Parse 5x:status → handle needs_human / failed
5. Run quality gates
   - If fail: re-invoke author with failure output (up to maxQualityRetries)
   - If still fail: escalate
6. Invoke reviewer (reviewer-commit template)
7. Parse 5x:verdict from review file
   - ready → proceed to phase gate
   - auto_fix items → invoke author (process-review), loop to step 5
   - human_required → escalate
   - missing verdict → escalate
8. Phase gate (human confirmation unless --auto)
9. Next phase (fresh agent sessions)
```

- [ ] Implement outer loop (iterate phases)
- [ ] Implement inner review-fix loop (within a phase)
- [ ] Compose author prompt from template + plan path
- [ ] Compose reviewer prompt from template + commit hash
- [ ] Quality gate integration with retry logic
- [ ] Git branch validation/creation at phase start
- [ ] Detect new commits after author invocation (for reviewer input)
- [ ] Human gate between phases: display summary, prompt for continue/review/abort
- [ ] `--auto` mode: skip inter-phase gate, still escalate on `human_required`
- [ ] `--phase N` flag: skip to specific phase
- [ ] Track and display cumulative progress
- [ ] Unit tests with mocked adapters: single-phase happy path, quality gate failure + retry, review fix cycle, escalation, multi-phase progression

### 5.4 `src/run-journal.ts` — Run journaling and resumability

Long-running `5x run` invocations will be interrupted (user ctrl-c, machine sleep, agent crash). The CLI writes an append-only journal so that `5x status` can show run state and `5x run` can resume safely.

```typescript
export interface RunJournal {
  id: string;                    // unique run ID (ulid or uuid)
  planPath: string;
  reviewPath: string;
  startedAt: string;             // ISO 8601
  currentPhase: number;
  currentState: string;          // state machine state name
  iterations: number;
  events: RunEvent[];            // append-only log of state transitions
}

export interface RunEvent {
  timestamp: string;
  type: 'phase_start' | 'agent_invoke' | 'quality_gate' | 'verdict' | 'escalation' | 'phase_complete' | 'error';
  data: Record<string, unknown>;
}

export function createJournal(planPath: string, reviewPath: string): RunJournal { ... }
export function appendEvent(journal: RunJournal, event: RunEvent): void { ... }
export function loadJournal(runId: string): RunJournal | null { ... }
export function findLatestJournal(planPath: string): RunJournal | null { ... }
```

Journal storage: `.5x/runs/<run-id>/run.json` in the project root. Each state transition appends to the `events` array and flushes to disk.

Resume behavior: when `5x run <plan-path>` detects an existing incomplete journal for the same plan, it prompts: `"Found interrupted run <id> at phase <N>. Resume? [yes/no/start-fresh]"`. Resume re-enters the state machine at the recorded `currentState`.

- [ ] Implement journal creation, append, and load
- [ ] Write journal to `.5x/runs/<id>/run.json` on each state transition
- [ ] Detect interrupted runs on `5x run` startup; prompt for resume
- [ ] `5x status <plan-path>` reads journal to show run state (if in progress)
- [ ] Unit tests: journal creation, append, load, resume detection

### 5.5 `src/gates/human.ts` — Interactive prompts

```typescript
export async function phaseGate(summary: PhaseSummary): Promise<'continue' | 'review' | 'abort'>;
export async function escalationGate(event: EscalationEvent): Promise<EscalationResponse>;
```

- [ ] Phase gate: display phase summary (files changed, tests, review verdict), prompt for decision
- [ ] Escalation gate: display escalation reason + context, prompt for guidance or override
- [ ] Handle non-interactive mode (pipe detection) — default to abort with message
- [ ] Unit tests with simulated stdin

### 5.6 `src/commands/run.ts` — CLI command wiring

- [ ] Parse command arguments (plan path, `--phase`, `--auto`, `--allow-dirty`, `--skip-quality`)
- [ ] Run git safety check; abort on dirty tree unless `--allow-dirty`
- [ ] Validate plan file, check for incomplete phases
- [ ] Initialize adapters from config
- [ ] Detect interrupted run journal; prompt for resume if found
- [ ] Call `runPhaseExecutionLoop` (with journal integration)
- [ ] Display final result (phases completed, total time, review links)

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

## Phase 7: Upgrade, Auto Mode, Polish

**Completion gate:** `5x upgrade` updates command templates with user-modification awareness. `--auto` mode works end-to-end. `--dry-run` shows planned actions without executing. Terminal output is polished. Token/cost tracking is displayed.

### 7.1 `src/commands/upgrade.ts` — Template upgrade

```
$ 5x upgrade
  Checking command templates...

  .claude/commands/5x/author-next-phase.md
    Current: v1 (modified locally)
    Available: v2
    → Showing diff...
    [apply] [skip] [show full diff]

  .claude/commands/5x/reviewer-commit.md
    Current: v1 (unmodified)
    Available: v2
    → Updated automatically ✓

  3/5 templates updated, 1 skipped (user-modified), 1 unchanged
```

- [ ] Compare installed checksums (`.5x-version`) against bundled manifest
- [ ] Detect user modifications (checksum mismatch from installed version)
- [ ] Auto-update unmodified files
- [ ] Show diff and prompt for modified files
- [ ] Update `.5x-version` after upgrade
- [ ] `--force` flag to overwrite all
- [ ] Unit tests: unmodified upgrade, modified file detection, force mode

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

- [ ] `build.ts` script: `bun build --compile` for native binary
- [ ] Node-compatible entrypoint via esbuild/tsup bundle
- [ ] `package.json` bin field for `npx 5x` / `bunx 5x`
- [ ] README with installation, quickstart, and configuration docs

---

## Files Touched

| File | Change |
|------|--------|
| `src/bin.ts` | NEW — CLI entry point, command routing |
| `src/config.ts` | NEW — Config loader with Zod validation |
| `src/version.ts` | NEW — CLI + template version tracking |
| `src/commands/init.ts` | NEW — Project scaffolding |
| `src/commands/upgrade.ts` | NEW — Template upgrade with diff detection |
| `src/commands/plan.ts` | NEW — Plan generation command |
| `src/commands/plan-review.ts` | NEW — Plan review loop command |
| `src/commands/run.ts` | NEW — Phase execution loop command |
| `src/commands/status.ts` | NEW — Plan status display |
| `src/agents/types.ts` | NEW — Agent adapter interface |
| `src/agents/claude-code.ts` | NEW — Claude Code subprocess adapter |
| `src/agents/opencode.ts` | NEW — OpenCode SDK adapter |
| `src/agents/factory.ts` | NEW — Config-driven adapter instantiation |
| `src/orchestrator/plan-review-loop.ts` | NEW — Loop 1 state machine |
| `src/orchestrator/phase-execution-loop.ts` | NEW — Loop 2 state machine |
| `src/orchestrator/signals.ts` | NEW — Parse 5x:verdict / 5x:status blocks |
| `src/parsers/plan.ts` | NEW — Implementation plan markdown parser |
| `src/parsers/review.ts` | NEW — Review summary parser |
| `src/parsers/markdown.ts` | NEW — Shared markdown utilities |
| `src/gates/quality.ts` | NEW — Quality gate command runner |
| `src/gates/human.ts` | NEW — Interactive terminal prompts |
| `src/git.ts` | NEW — Git operations + safety invariants (`checkGitSafety`) |
| `src/run-journal.ts` | NEW — Run journaling for resumability |
| `src/logger.ts` | NEW — Structured terminal output |
| `commands/v1/*.md` | NEW — 10 command templates (5 per harness) |
| `commands/v1/manifest.json` | NEW — Template version + checksums |
| `templates/5x.config.js` | NEW — Default config template (JS, with JSDoc types) |
| `build.ts` | NEW — Build script for compile + bundle |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `parsers/plan.test.ts` | Phase extraction, checklist parsing, completion calculation from real plan files |
| Unit | `parsers/signals.test.ts` | Verdict/status block extraction, YAML parsing, malformed input handling |
| Unit | `parsers/review.test.ts` | Review summary extraction, P0/P1/P2 counting, addendum detection |
| Unit | `config.test.ts` | Config loading, validation, defaults, missing file handling |
| Unit | `agents/claude-code.test.ts` | Subprocess argument construction, output parsing, exit code mapping |
| Unit | `agents/factory.test.ts` | Config-driven adapter instantiation |
| Unit | `orchestrator/plan-review-loop.test.ts` | State transitions with mocked adapters: happy path, multi-iteration, escalation |
| Unit | `orchestrator/phase-execution-loop.test.ts` | Phase progression, quality retry, review fix cycles, human gates |
| Unit | `gates/quality.test.ts` | Command execution, pass/fail aggregation, timeout handling |
| Unit | `git.test.ts` | Branch operations, safety checks against temp repos (clean, dirty, untracked) |
| Unit | `run-journal.test.ts` | Journal creation, append, load, resume detection |
| Integration | `claude-code-adapter.test.ts` | Real Claude Code CLI invocation round-trip. **Env-gated:** only runs when `FIVE_X_TEST_LIVE_AGENTS=1` is set. Not in default CI. |
| Integration | `opencode-adapter.test.ts` | Real OpenCode SDK invocation round-trip. **Env-gated:** only runs when `FIVE_X_TEST_LIVE_AGENTS=1` is set. Not in default CI. |
| Integration | `claude-code-schema-probe.test.ts` | Validates Claude Code `--output-format json` schema has expected fields. **Env-gated.** |
| Integration | `plan-review-e2e.test.ts` | Full plan-review loop with mocked agent responses (golden test, runs in CI by default) |
| Integration | `phase-execution-e2e.test.ts` | Full phase execution loop with mocked agents + git repo (golden test, runs in CI by default) |

---

## Not In Scope

- **Web dashboard or monitoring UI** — terminal output only; CI integration is sufficient
- **Token cost optimization** — agents manage their own context; CLI only reports what adapters provide
- **Multi-project orchestration** — single project root per invocation
- **Git worktree management** — mentioned in the README as a scaling technique; deferred to a future plan
- **Custom agent adapters** — only Claude Code and OpenCode; plugin system deferred
- **Reviewer model selection heuristics** — user configures models; CLI doesn't choose
- **`5x archive` command** — plan/review archival lifecycle deferred to post-v1; the core generate → review → execute loop ships first

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Foundation — config (JS), parsers, signal protocol v1, status | 2 days |
| 2 | Agent adapters (Claude Code) + schema probe | 1 day |
| 3 | Command templates v1 + init | 1 day |
| 4 | Plan generation + review loop (deterministic paths) | 1.5 days |
| 5 | Phase execution loop + git safety + run journaling | 2.5 days |
| 6 | OpenCode adapter | 1 day |
| 7 | Upgrade, auto mode guardrails, polish | 2 days |
| **Total** | | **11 days** |
