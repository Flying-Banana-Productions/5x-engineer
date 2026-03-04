# v1 Architecture Implementation

**Version:** 1.0
**Created:** March 4, 2026
**Status:** Draft

## Overview

Current behavior: The CLI uses imperative TypeScript state machines (`plan-review-loop.ts`, `phase-execution-loop.ts`) with a single `AgentAdapter` interface hardcoded to OpenCode. The DB schema has 6 tables (`runs`, `run_events`, `agent_results`, `quality_results`, `plans`, `phase_progress`). Commands (`5x run`, `5x plan`, `5x plan-review`) embed orchestration logic directly.

Desired behavior: The CLI becomes a stateless toolbelt of primitives (`5x run init/state/record/complete`, `5x invoke author/reviewer`, `5x quality run`, `5x prompt`, `5x diff`, `5x plan phases`, `5x worktree create/remove/list`). Orchestration moves to agent skills (markdown). Sub-agent invocation is abstracted behind a pluggable `AgentProvider`/`AgentSession` interface with implementations for OpenCode, Codex, and Claude Agent SDKs. The DB schema is simplified to 3 tables (`runs`, `steps`, `plans`).

Why this change: The v0 state machines are brittle (every edge case requires new code), duplicated across workflows, and can't assess semantic quality. The v1 architecture lets orchestrating agents reason about invariant violations instead of pre-coding every transition, supports multiple agent runtimes, and enables new workflow types via skills without new TypeScript.

## Design Decisions

**Implement bottom-up: data layer → provider interface → CLI commands → cleanup.** The provider interface and DB schema are foundational — all commands depend on them. Building bottom-up ensures each phase has stable dependencies and is independently testable. Top-down would require mocking everything.

**Provider implementations ship sequentially: OpenCode first, then Codex and Claude Agent.** OpenCode has a working v0 adapter to migrate from (`src/agents/opencode.ts:481-1130`). Codex and Claude Agent SDKs are new dependencies. Shipping OpenCode first validates the interface; the other two are thin adapters (~50-100 LOC) over their respective SDKs.

**DB migration is additive then subtractive.** Schema version 4 creates the `steps` table and migrates existing data. Old tables are dropped in the same migration. This is a clean break — no compatibility layer. The migration is wrapped in a transaction so it either fully succeeds or rolls back.

**All v1 commands return JSON envelope `{ ok, data }` or `{ ok, error }`.** This is a new convention for v1 commands. v0 commands use console.log directly. Since v0 commands are being deleted (not preserved), the new convention applies only to new code. A shared `outputJson()` helper standardizes output.

**Skills are bundled as static markdown files, not generated.** Skills are standalone `.md` files in `.5x/skills/`. The `5x init` command copies them from bundled defaults. No code generation, no templating of skills themselves. Skills reference CLI commands by name — they are decoupled from the implementation.

**Config schema extends, not replaces.** The `FiveXConfigSchema` in `src/config.ts:38-49` gains `provider` field on author/reviewer and `opencode` top-level config. The `maxStepsPerRun` field replaces `maxAutoIterations`. Old fields are accepted with deprecation warnings.

## Phase 1: AgentProvider Interface and OpenCode Provider

**Completion gate:** `AgentProvider` and `AgentSession` interfaces exist in `src/providers/types.ts`. `OpenCodeProvider` passes unit tests covering `startSession`, `resumeSession`, `run` (with structured output), and `close`. Existing v0 test patterns from `test/agents/` validate behavior.

- [ ] Create `src/providers/` directory with `types.ts` defining the `AgentProvider`, `AgentSession`, `SessionOptions`, `RunOptions`, `RunResult`, and `AgentEvent` types exactly as specified in `100-architecture.md:198-240`.

```typescript
// src/providers/types.ts
export interface AgentProvider {
  startSession(opts: SessionOptions): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  close(): Promise<void>;
}

export interface AgentSession {
  readonly id: string;
  run(prompt: string, opts?: RunOptions): Promise<RunResult>;
  runStreamed(prompt: string, opts?: RunOptions): AsyncIterable<AgentEvent>;
}

export interface SessionOptions {
  model: string;
  workingDirectory: string;
  systemPrompt?: string;
  timeout?: number;
}

export interface RunOptions {
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  timeout?: number;
}

export interface RunResult {
  text: string;
  structured?: unknown;
  sessionId: string;
  tokens: { in: number; out: number };
  costUsd?: number;
  durationMs: number;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; tool: string; input_summary: string }
  | { type: "tool_end"; tool: string; output: string; error?: boolean }
  | { type: "error"; message: string }
  | { type: "usage"; tokens: { in: number; out: number }; costUsd?: number }
  | { type: "done"; result: RunResult };
```

- [ ] Create `src/providers/opencode.ts` implementing `AgentProvider` using `@opencode-ai/sdk`. Port the core invocation logic from `src/agents/opencode.ts:481-1130` — session creation, prompt execution, two-phase structured output, SSE event mapping to `AgentEvent`, timeout/cancellation handling. Key differences from v0:
  - `startSession()` creates session via `client.session.create()` (same as v0 `_invoke` line 790)
  - `resumeSession()` retrieves via `client.session.get()`
  - `run()` does the two-phase prompt (execute + summary with `format: json_schema`) and returns `RunResult`
  - `runStreamed()` maps OpenCode SSE events to `AgentEvent` using the existing event router from `src/utils/event-router.ts`
  - `close()` calls `server.close()` (same as v0 line 541)
  - Supports both managed mode (`createOpencode()`) and external mode (`createOpencodeClient()`)

```typescript
// src/providers/opencode.ts
export class OpenCodeProvider implements AgentProvider {
  static async createManaged(opts?: { model?: string }): Promise<OpenCodeProvider>;
  static createExternal(baseUrl: string, opts?: { model?: string }): OpenCodeProvider;

  startSession(opts: SessionOptions): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  close(): Promise<void>;
}
```

- [ ] Create `src/providers/factory.ts` with `createProvider(role, config)` that reads provider config from `FiveXConfig` and instantiates the correct provider. For v1, only `"opencode"` is handled; `"codex"` and `"claude-agent"` throw "not yet implemented" errors.

```typescript
// src/providers/factory.ts
export async function createProvider(
  role: "author" | "reviewer",
  config: FiveXConfig,
): Promise<AgentProvider>;
```

- [ ] Create `src/providers/index.ts` re-exporting types and factory.

- [ ] Write unit tests in `test/providers/types.test.ts` validating the type contracts (compile-time check).

- [ ] Write integration tests in `test/providers/opencode.test.ts` covering:
  - Managed mode lifecycle (create → startSession → run → close)
  - External mode connection
  - Structured output extraction (AuthorStatus and ReviewerVerdict schemas)
  - Session resume
  - Timeout handling
  - Cancellation via AbortSignal
  - AgentEvent stream mapping

## Phase 2: Database Schema Migration

**Completion gate:** Schema version 4 migration creates `steps` table, migrates existing v0 data, drops old tables. `runMigrations()` succeeds on fresh DBs and on DBs with existing v0 data. All existing tests in `test/db/` pass with the new schema.

- [ ] Add migration version 4 to `src/db/schema.ts:220` (after the existing `migrations` array) that:
  1. Creates the `steps` table per `101-cli-primitives.md:778-809`:

```sql
CREATE TABLE steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  step_name     TEXT NOT NULL,
  phase         TEXT,
  iteration     INTEGER NOT NULL DEFAULT 1,
  result_json   TEXT NOT NULL,
  session_id    TEXT,
  model         TEXT,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  cost_usd      REAL,
  duration_ms   INTEGER,
  log_path      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(run_id, step_name, phase, iteration)
);
CREATE INDEX idx_steps_run ON steps(run_id, created_at);
CREATE INDEX idx_steps_phase ON steps(run_id, phase);
```

  2. Migrates `agent_results` → `steps` with `step_name = "{role}:{template}"`
  3. Migrates `quality_results` → `steps` with `step_name = "quality:check"`
  4. Migrates `run_events` → `steps` with `step_name = "event:{event_type}"`
  5. Migrates `phase_progress` where `review_approved = 1` → `steps` with `step_name = "phase:complete"`
  6. Alters `runs` table: drops `current_state`, `current_phase`, `review_path` columns; adds `config_json` and `updated_at` columns
  7. Drops `agent_results`, `quality_results`, `run_events`, `phase_progress` tables

- [ ] Create `src/db/operations-v1.ts` with new step-based operations:

```typescript
// src/db/operations-v1.ts
export interface StepRow {
  id: number;
  run_id: string;
  step_name: string;
  phase: string | null;
  iteration: number;
  result_json: string;
  session_id: string | null;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  log_path: string | null;
  created_at: string;
}

export interface RecordStepInput {
  run_id: string;
  step_name: string;
  phase?: string;
  iteration?: number; // auto-increment if omitted
  result_json: string;
  session_id?: string;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  duration_ms?: number;
  log_path?: string;
}

export interface RecordStepResult {
  step_id: number;
  step_name: string;
  phase: string | null;
  iteration: number;
  recorded: boolean; // true=new, false=already existed
}

/** INSERT OR IGNORE — first write wins. Returns existing record if duplicate. */
export function recordStep(db: Database, input: RecordStepInput): RecordStepResult;

/** Get all steps for a run, ordered by creation. */
export function getSteps(db: Database, runId: string): StepRow[];

/** Get steps filtered by phase. */
export function getStepsByPhase(db: Database, runId: string, phase: string): StepRow[];

/** Get the latest step with a given step_name for a run. */
export function getLatestStep(db: Database, runId: string, stepName: string): StepRow | null;

/** Compute MAX(iteration) + 1 for auto-increment. */
export function nextIteration(db: Database, runId: string, stepName: string, phase?: string): number;

/** Create a run (simplified from v0 — no review_path, no current_state). */
export function createRunV1(db: Database, run: {
  id: string;
  planPath: string;
  command?: string;
  configJson?: string;
}): void;

/** Get run by ID. */
export function getRunV1(db: Database, runId: string): RunRowV1 | null;

/** Find active run for a plan. */
export function getActiveRunV1(db: Database, planPath: string): RunRowV1 | null;

/** Update run status. */
export function completeRun(db: Database, runId: string, status: "completed" | "aborted"): void;

/** Reopen a completed/aborted run. */
export function reopenRun(db: Database, runId: string): void;

/** List runs with optional filters. */
export function listRuns(db: Database, opts?: {
  planPath?: string;
  status?: string;
  limit?: number;
}): RunSummaryV1[];

/** Compute run summary from steps (phases completed, cost, tokens). */
export function computeRunSummary(db: Database, runId: string): RunSummaryComputed;
```

- [ ] Write tests in `test/db/schema-v4.test.ts` covering:
  - Fresh DB migration (no v0 data)
  - Migration from v3 with existing v0 data (agent_results, quality_results, run_events, phase_progress)
  - Data integrity after migration (step counts match source records)
  - `recordStep` INSERT OR IGNORE semantics (first write wins)
  - Auto-increment iteration behavior
  - `computeRunSummary` aggregation

- [ ] Write tests in `test/db/operations-v1.test.ts` covering all new operation functions.

## Phase 3: JSON Output Envelope and Shared Helpers

**Completion gate:** A shared `outputJson()` helper exists in `src/output.ts`. All v1 commands use `{ ok: true, data }` / `{ ok: false, error: { code, message, detail? } }` format.

- [ ] Create `src/output.ts` with JSON output helpers:

```typescript
// src/output.ts
export interface SuccessEnvelope<T> {
  ok: true;
  data: T;
}

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    detail?: unknown;
  };
}

export type JsonEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/** Write success JSON to stdout and exit 0. */
export function outputSuccess<T>(data: T): void;

/** Write error JSON to stdout and exit with code. */
export function outputError(code: string, message: string, detail?: unknown, exitCode?: number): never;

/** Generate a run ID with prefix. */
export function generateRunId(): string;

/** Generate a log sequence number for agent invocations within a run. */
export function nextLogSequence(logDir: string): string;
```

- [ ] Create `src/run-id.ts` with `generateRunId()` returning `"run_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12)`.

- [ ] Write tests in `test/output.test.ts` covering envelope formatting and error codes.

## Phase 4: Run Lifecycle Commands

**Completion gate:** `5x run init`, `5x run state`, `5x run record`, `5x run complete`, `5x run reopen`, and `5x run list` are functional and return JSON envelopes. Integration tests exercise the full lifecycle: init → record steps → state → complete.

- [ ] Create `src/commands/run-v1.ts` implementing the `run` subcommand group with six subcommands. Register it in `src/bin.ts` replacing the v0 `run` import (line 17).

- [ ] Implement `5x run init --plan <path> [--command <name>] [--allow-dirty]`:
  - Canonicalize plan path via `canonicalizePlanPath()` from `src/paths.ts:4`
  - Check for existing active run via `getActiveRunV1()`; if found, return it (idempotent)
  - Acquire plan lock via `acquireLock()` from `src/lock.ts:98`; on `PLAN_LOCKED`, return error
  - Check git safety via `checkGitSafety()` from `src/git.ts:74`; on dirty without `--allow-dirty`, return `DIRTY_WORKTREE` error
  - Create run via `createRunV1()` with generated ID
  - Register lock cleanup via `registerLockCleanup()` from `src/lock.ts:196`
  - Return `{ ok: true, data: { run_id, plan_path, status, created_at } }`

- [ ] Implement `5x run state --run <id>` / `5x run state --plan <path>`:
  - Fetch run and all steps via `getRunV1()` and `getSteps()`
  - Compute summary via `computeRunSummary()`
  - Return full step list and summary per `101-cli-primitives.md:120-156`

- [ ] Implement `5x run record <step-name> --run <id> --result <json> [--phase <id>] [--iteration <n>]`:
  - Parse `--result`: raw JSON string, `-` for stdin, `@path` for file
  - Compute iteration via `nextIteration()` if `--iteration` omitted
  - Record via `recordStep()` — INSERT OR IGNORE
  - Return `{ step_id, step_name, phase, iteration, recorded }` per `101-cli-primitives.md:184-195`
  - Enforce `maxStepsPerRun` from config; return error if exceeded

- [ ] Implement `5x run complete --run <id> [--status completed|aborted] [--reason <text>]`:
  - Record terminal step (`run:complete` or `run:abort`)
  - Update run status via `completeRun()`
  - Release plan lock via `releaseLock()` from `src/lock.ts:154`

- [ ] Implement `5x run reopen --run <id>`:
  - Record `run:reopen` step with previous status
  - Set run back to active via `reopenRun()`

- [ ] Implement `5x run list [--plan <path>] [--status <s>] [--limit <n>]`:
  - Query via `listRuns()`
  - Return array of run summaries

- [ ] Write integration tests in `test/commands/run-v1.test.ts` covering:
  - Full lifecycle: init → record → state → complete
  - Idempotent init (returns existing active run)
  - Plan lock enforcement (second init fails)
  - Dirty worktree check (without --allow-dirty)
  - Step recording with INSERT OR IGNORE (duplicate returns recorded=false)
  - Auto-increment iteration
  - Max steps per run enforcement
  - Run reopen
  - Run list with filters

## Phase 5: Agent Invocation Commands

**Completion gate:** `5x invoke author <template>` and `5x invoke reviewer <template>` execute sub-agent invocations via the provider interface, return structured results as JSON, and write NDJSON log files. Template resolution, variable substitution, and structured output validation work end-to-end.

- [ ] Create `src/commands/invoke.ts` implementing the `invoke` subcommand group with `author` and `reviewer` subcommands.

- [ ] Implement shared invocation logic (used by both `invoke author` and `invoke reviewer`):
  - Resolve template via `loadTemplate()` from `src/templates/loader.ts:180` — look in `.5x/templates/prompts/{template}.md` (override), then bundled defaults
  - Render template via `renderTemplate()` from `src/templates/loader.ts:286` with `--var key=value` parsed into record
  - Create provider via `createProvider(role, config)` from `src/providers/factory.ts`
  - Start session (or resume with `--session`)
  - Call `session.run(prompt, { outputSchema })` with AuthorStatusSchema or ReviewerVerdictSchema
  - Validate result via `assertAuthorStatus()` or `assertReviewerVerdict()` from `src/protocol.ts:118-157`
  - Write NDJSON log to `.5x/logs/<run_id>/agent-<seq>.ndjson`
  - Return JSON envelope with result, session_id, model, duration_ms, tokens, cost, log_path
  - Handle `--quiet` (suppress console when stdout is not TTY), `--show-reasoning`

```typescript
// CLI flags for 5x invoke author/reviewer
interface InvokeArgs {
  template: string;     // positional
  run: string;          // --run (required)
  var?: string[];       // --var key=value (repeatable)
  model?: string;       // --model override
  workdir?: string;     // --workdir
  session?: string;     // --session (resume)
  timeout?: number;     // --timeout seconds
  quiet?: boolean;      // --quiet
  "show-reasoning"?: boolean;
}
```

- [ ] Implement NDJSON log writer using `AgentEvent` stream from `runStreamed()`:
  - Create log dir `.5x/logs/<run_id>/` with `0o700` permissions
  - Compute sequence number from existing files in the directory
  - Write each `AgentEvent` as a JSON line
  - Reuse console rendering from `src/utils/stream-writer.ts` for non-quiet mode

- [ ] Register `invoke` in `src/bin.ts`.

- [ ] Write tests in `test/commands/invoke.test.ts` covering:
  - Template resolution (bundled + override)
  - Variable substitution
  - Structured output validation (valid AuthorStatus, valid ReviewerVerdict)
  - Invalid structured output (returns error with `INVALID_STRUCTURED_OUTPUT`)
  - Template not found (exit 2)
  - NDJSON log file creation
  - Session resume via `--session`

## Phase 6: Quality, Inspection, and Worktree Commands

**Completion gate:** `5x quality run`, `5x plan phases`, `5x diff`, and `5x worktree create/remove/list` return JSON envelopes and are registered in the CLI.

- [ ] Create `src/commands/quality-v1.ts` implementing `5x quality run`:
  - Reuse `runQualityGates()` from `src/gates/quality.ts:146`
  - Wrap result in JSON envelope per `101-cli-primitives.md:396-408`
  - Return `{ passed, results: [{ command, passed, duration_ms, output }] }`

- [ ] Create `src/commands/plan-v1.ts` implementing `5x plan phases <path>`:
  - Reuse `parsePlan()` from `src/parsers/plan.ts`
  - Return `{ phases: [{ id, title, done, checklist_total, checklist_done }] }`

- [ ] Create `src/commands/diff.ts` implementing `5x diff [--since <ref>] [--stat]`:
  - Shell out to `git diff` via `Bun.spawn` (similar to `src/git.ts:33-48`)
  - Parse stat output for `files_changed`, `insertions`, `deletions`
  - Return per `101-cli-primitives.md:455-465`

- [ ] Rewrite `src/commands/worktree.ts` (currently at 180 lines) to implement v1 API:
  - `5x worktree create --plan <path> [--branch <name>]` — uses `createWorktree()` from `src/git.ts:304`, runs `postCreate` hook, records in `plans` table
  - `5x worktree remove --plan <path> [--force]` — uses `removeWorktree()` from `src/git.ts:324`, clears DB
  - `5x worktree list` — uses `listWorktrees()` from `src/git.ts:339`, joins with `plans` table
  - All return JSON envelopes

- [ ] Register `quality`, updated `plan`, `diff` in `src/bin.ts`.

- [ ] Write tests in `test/commands/quality-v1.test.ts`, `test/commands/plan-v1.test.ts`, `test/commands/diff.test.ts`, `test/commands/worktree-v1.test.ts`.

## Phase 7: Human Interaction Commands

**Completion gate:** `5x prompt choose`, `5x prompt confirm`, and `5x prompt input` present interactive prompts and return JSON results. Non-TTY behavior (default values, `NON_INTERACTIVE` error) works correctly.

- [ ] Create `src/commands/prompt.ts` implementing the `prompt` subcommand group:

- [ ] Implement `5x prompt choose <message> --options <a,b,c> [--default <a>]`:
  - If stdin is TTY: present numbered options, wait for selection
  - If not TTY + `--default`: return default immediately
  - If not TTY + no default: exit 1 with `NON_INTERACTIVE`
  - Return `{ choice: "<selected>" }`

- [ ] Implement `5x prompt confirm <message> [--default yes|no]`:
  - If stdin is TTY: present `[y/n]` prompt
  - Non-TTY behavior same as `choose`
  - Return `{ confirmed: true|false }`

- [ ] Implement `5x prompt input <message> [--multiline]`:
  - If stdin is TTY: read line (or multiline with Ctrl+D terminator)
  - If not TTY: read from stdin pipe
  - Return `{ input: "<text>" }`

- [ ] Register `prompt` in `src/bin.ts`.

- [ ] Write tests in `test/commands/prompt.test.ts` covering:
  - Non-interactive with default (returns default)
  - Non-interactive without default (NON_INTERACTIVE error)
  - Input parsing (single line, multiline)

## Phase 8: Config Schema Extension

**Completion gate:** Config schema accepts `provider` field on author/reviewer, `opencode` top-level config, and `maxStepsPerRun`. Unknown/deprecated keys produce warnings. Existing configs continue to work.

- [ ] Extend `AgentConfigSchema` in `src/config.ts:5-9` to add `provider`:

```typescript
const AgentConfigSchema = z.object({
  provider: z.enum(["opencode", "codex", "claude-agent"]).default("opencode"),
  model: z.string().optional(),
  timeout: z.number().int().positive().optional(),
});
```

- [ ] Add `OpenCodeConfigSchema` and `maxStepsPerRun` to `FiveXConfigSchema` in `src/config.ts:38-49`:

```typescript
const OpenCodeConfigSchema = z.object({
  url: z.string().url().optional(),
});

const FiveXConfigSchema = z.object({
  author: AgentConfigSchema.default({}),
  reviewer: AgentConfigSchema.default({}),
  opencode: OpenCodeConfigSchema.default({}),
  qualityGates: z.array(z.string()).default([]),
  worktree: WorktreeSchema.default({}),
  paths: PathsSchema.default({}),
  db: DbSchema.default({}),
  maxStepsPerRun: z.number().int().positive().default(50),
  // Preserved for backward compat, deprecated
  maxReviewIterations: z.number().int().positive().default(5),
  maxQualityRetries: z.number().int().positive().default(3),
  maxAutoIterations: z.number().int().positive().default(10),
  maxAutoRetries: z.number().int().positive().default(3),
});
```

- [ ] Update `warnUnknownConfigKeys()` in `src/config.ts:130-206` to accept `provider` in agent config and `opencode` at root level. Add deprecation warnings for `maxAutoIterations` → `maxStepsPerRun`.

- [ ] Update `applyModelOverrides()` in `src/config.ts:62-78` to also support `--author-provider`, `--reviewer-provider`, `--opencode-url` overrides.

- [ ] Write tests in `test/config-v1.test.ts` covering:
  - New fields parse correctly
  - Defaults work (provider defaults to "opencode")
  - Unknown keys warn
  - Deprecated keys warn
  - `opencode.url` validation

## Phase 9: Codex and Claude Agent Providers

**Completion gate:** `CodexProvider` and `ClaudeAgentProvider` implement `AgentProvider`, pass unit tests with mocked SDKs, and can be selected via config `provider: "codex"` / `provider: "claude-agent"`.

- [ ] Add `@openai/codex-sdk` and `@anthropic-ai/claude-agent-sdk` as dependencies in `package.json:51-57`.

- [ ] Create `src/providers/codex.ts` implementing `AgentProvider`:
  - `startSession()` → `codex.startThread({ workingDirectory })`
  - `run()` → `thread.run(prompt, { outputSchema })` — native structured output
  - `resumeSession()` → `codex.resumeThread(id)`
  - `runStreamed()` → map Codex JSONL events to `AgentEvent`
  - `close()` → cleanup

- [ ] Create `src/providers/claude-agent.ts` implementing `AgentProvider`:
  - `startSession()` → captures `session_id` from `init` event during first `query()`
  - `run()` → `query({ prompt, options: { allowedTools, resume } })` — two-phase structured output
  - `resumeSession()` → pass `session_id` via resume option
  - `runStreamed()` → map Claude Agent async iterable to `AgentEvent`
  - `close()` → no-op (fully in-process)

- [ ] Update `src/providers/factory.ts` to handle `"codex"` and `"claude-agent"` provider types.

- [ ] Write tests in `test/providers/codex.test.ts` and `test/providers/claude-agent.test.ts` covering:
  - Session lifecycle (start, run, close)
  - Structured output extraction
  - AgentEvent mapping
  - Error handling

## Phase 10: Skills Bundling and Init Update

**Completion gate:** `5x init` scaffolds `.5x/skills/` with three bundled skill files. Skills are standalone markdown that reference v1 CLI commands.

- [ ] Create bundled skill files:
  - `.5x/skills/5x-plan.md` — from `102-agent-skills.md:68-162`
  - `.5x/skills/5x-plan-review.md` — from `102-agent-skills.md:170-312`
  - `.5x/skills/5x-phase-execution.md` — from `102-agent-skills.md:320-602`

- [ ] Store skill content as importable text (same pattern as templates in `src/templates/loader.ts:8-19`).

- [ ] Update `src/commands/init.ts` to copy bundled skills to `.5x/skills/` during scaffolding. Skip if files already exist (don't overwrite user customizations).

- [ ] Write tests in `test/commands/init-skills.test.ts` validating:
  - Skills are created on first init
  - Existing skills are not overwritten
  - Skill content matches bundled source

## Phase 11: v0 Cleanup and Public API Update

**Completion gate:** v0 orchestrator loops, commands, and adapter interface are deleted. `src/bin.ts` only registers v1 commands. `src/index.ts` exports v1 types. All tests pass. TypeScript compiles cleanly.

- [ ] Delete v0 orchestrator files:
  - `src/orchestrator/plan-review-loop.ts`
  - `src/orchestrator/phase-execution-loop.ts`
  - `src/orchestrator/` directory

- [ ] Delete v0 agent adapter files:
  - `src/agents/types.ts`
  - `src/agents/opencode.ts`
  - `src/agents/factory.ts`
  - `src/agents/errors.ts` (move error classes to `src/providers/errors.ts` if still needed)
  - `src/agents/` directory

- [ ] Delete v0 command files:
  - `src/commands/run.ts` (replaced by `src/commands/run-v1.ts`)
  - `src/commands/plan.ts` (replaced by `5x-plan` skill)
  - `src/commands/plan-review.ts` (replaced by `5x-plan-review` skill)
  - `src/commands/status.ts` (replaced by `5x run state`)

- [ ] Delete v0 gate file:
  - `src/gates/human.ts` (replaced by `src/commands/prompt.ts`)

- [ ] Delete v0 DB operations (superseded by `operations-v1.ts`):
  - Remove v0-only functions from `src/db/operations.ts` (or rename `operations-v1.ts` to `operations.ts`)

- [ ] Update `src/bin.ts` to register only v1 commands:

```typescript
const main = defineCommand({
  meta: { name: "5x", version, description: "5x workflow CLI" },
  subCommands: {
    init: () => import("./commands/init.js").then((m) => m.default),
    run: () => import("./commands/run-v1.js").then((m) => m.default),
    invoke: () => import("./commands/invoke.js").then((m) => m.default),
    quality: () => import("./commands/quality-v1.js").then((m) => m.default),
    plan: () => import("./commands/plan-v1.js").then((m) => m.default),
    diff: () => import("./commands/diff.js").then((m) => m.default),
    worktree: () => import("./commands/worktree.js").then((m) => m.default),
    prompt: () => import("./commands/prompt.js").then((m) => m.default),
  },
});
```

- [ ] Update `src/index.ts` to export v1 types and remove v0 exports:
  - Remove: `AgentAdapter`, `InvokeOptions`, `InvokeResult`, `InvokeStatus`, `InvokeVerdict`, `createAndVerifyAdapter`, `OpenCodeAdapter`
  - Remove: `runPhaseExecutionLoop`, `PhaseExecutionOptions`, `PhaseExecutionResult`
  - Remove: `runPlanReviewLoop`, `PlanReviewLoopOptions`, `PlanReviewResult`, `resolveReviewPath`
  - Remove: `escalationGate`, `phaseGate`, `resumeGate`, `staleLockGate`, `EscalationResponse`, `PhaseSummary`
  - Remove: v0 DB operation exports (`upsertAgentResult`, `upsertQualityResult`, `appendRunEvent`, etc.)
  - Add: `AgentProvider`, `AgentSession`, `AgentEvent`, `RunResult`, `SessionOptions`, `RunOptions`
  - Add: `recordStep`, `getSteps`, `StepRow`, `RecordStepInput`, `RecordStepResult`
  - Add: `outputSuccess`, `outputError`, `JsonEnvelope`

- [ ] Delete v0 test files:
  - `test/orchestrator/`
  - `test/agents/`
  - `test/commands/run.test.ts`, `test/commands/plan.test.ts`, `test/commands/plan-review.test.ts`

- [ ] Run full test suite: `bun test`
- [ ] Run typecheck: `bunx --bun tsc --noEmit`
- [ ] Run lint: `bunx --bun @biomejs/biome check src/ test/`

## Phase 12: Event Router Migration

**Completion gate:** The existing SSE event router in `src/utils/event-router.ts` maps OpenCode SSE events to `AgentEvent` type. NDJSON logs use `AgentEvent` format exclusively. `StreamWriter` renders `AgentEvent` instead of raw SSE events.

- [ ] Create `src/providers/event-mapper.ts` that maps provider-native events to `AgentEvent`:
  - OpenCode: reuse logic from `src/utils/event-router.ts` (currently maps SSE events to StreamWriter calls) — refactor to emit `AgentEvent` objects instead
  - Codex: new mapper for JSONL events
  - Claude Agent: new mapper for query response events

- [ ] Update `src/utils/stream-writer.ts` to accept `AgentEvent` objects directly (instead of provider-specific event routing).

- [ ] Update NDJSON log writing (currently in `src/agents/opencode.ts:295-475`) to write `AgentEvent` objects. Move log writing logic to a shared `src/providers/log-writer.ts`.

- [ ] Write tests in `test/providers/event-mapper.test.ts` covering:
  - OpenCode SSE → AgentEvent mapping (text, reasoning, tool_start, tool_end, usage, done)
  - Tool input summary formatting (bash→command, edit→file, etc.)
  - Error events

## Files Touched

| File | Change |
|------|--------|
| `src/providers/types.ts` | **New** — AgentProvider, AgentSession, AgentEvent interfaces |
| `src/providers/opencode.ts` | **New** — OpenCode provider implementation |
| `src/providers/codex.ts` | **New** — Codex provider implementation |
| `src/providers/claude-agent.ts` | **New** — Claude Agent provider implementation |
| `src/providers/factory.ts` | **New** — Provider factory |
| `src/providers/errors.ts` | **New** — AgentTimeoutError, AgentCancellationError |
| `src/providers/event-mapper.ts` | **New** — Native event → AgentEvent mapping |
| `src/providers/log-writer.ts` | **New** — NDJSON log writer for AgentEvent |
| `src/providers/index.ts` | **New** — Re-exports |
| `src/db/schema.ts` | **Modified** — Add migration v4 (steps table, data migration, table drops) |
| `src/db/operations-v1.ts` | **New** — Step-based DB operations |
| `src/output.ts` | **New** — JSON envelope helpers |
| `src/run-id.ts` | **New** — Run ID generation |
| `src/commands/run-v1.ts` | **New** — Run lifecycle commands (init, state, record, complete, reopen, list) |
| `src/commands/invoke.ts` | **New** — Agent invocation commands |
| `src/commands/quality-v1.ts` | **New** — Quality gate command (JSON envelope wrapper) |
| `src/commands/plan-v1.ts` | **New** — Plan phases command |
| `src/commands/diff.ts` | **New** — Git diff command |
| `src/commands/prompt.ts` | **New** — Human interaction commands |
| `src/commands/worktree.ts` | **Modified** — Rewrite for v1 API (create/remove/list, JSON envelopes) |
| `src/commands/init.ts` | **Modified** — Add skills scaffolding |
| `src/config.ts` | **Modified** — Add provider, opencode, maxStepsPerRun fields |
| `src/bin.ts` | **Modified** — Register v1 commands, remove v0 commands |
| `src/index.ts` | **Modified** — Export v1 types, remove v0 exports |
| `src/utils/stream-writer.ts` | **Modified** — Accept AgentEvent input |
| `src/utils/event-router.ts` | **Modified** — Refactor to emit AgentEvent objects |
| `package.json` | **Modified** — Add @openai/codex-sdk, @anthropic-ai/claude-agent-sdk deps |
| `src/orchestrator/plan-review-loop.ts` | **Deleted** |
| `src/orchestrator/phase-execution-loop.ts` | **Deleted** |
| `src/commands/run.ts` | **Deleted** |
| `src/commands/plan.ts` | **Deleted** |
| `src/commands/plan-review.ts` | **Deleted** |
| `src/commands/status.ts` | **Deleted** |
| `src/agents/types.ts` | **Deleted** |
| `src/agents/opencode.ts` | **Deleted** |
| `src/agents/factory.ts` | **Deleted** |
| `src/agents/errors.ts` | **Deleted** |
| `src/gates/human.ts` | **Deleted** |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/providers/types.test.ts` | Type contracts compile correctly |
| Integration | `test/providers/opencode.test.ts` | OpenCode provider lifecycle, structured output, streaming |
| Unit | `test/providers/codex.test.ts` | Codex provider with mocked SDK |
| Unit | `test/providers/claude-agent.test.ts` | Claude Agent provider with mocked SDK |
| Unit | `test/providers/event-mapper.test.ts` | Native event → AgentEvent mapping |
| Unit | `test/db/schema-v4.test.ts` | Migration v4: steps table creation, data migration, table drops |
| Unit | `test/db/operations-v1.test.ts` | Step recording, INSERT OR IGNORE, auto-increment, run lifecycle |
| Unit | `test/output.test.ts` | JSON envelope formatting |
| Integration | `test/commands/run-v1.test.ts` | Full run lifecycle: init → record → state → complete |
| Integration | `test/commands/invoke.test.ts` | Template resolution, invocation, structured output validation |
| Unit | `test/commands/quality-v1.test.ts` | Quality gate JSON output |
| Unit | `test/commands/plan-v1.test.ts` | Plan phases JSON output |
| Unit | `test/commands/diff.test.ts` | Git diff JSON output |
| Unit | `test/commands/prompt.test.ts` | Non-interactive behavior, default values |
| Integration | `test/commands/worktree-v1.test.ts` | Worktree create/remove/list lifecycle |
| Unit | `test/commands/init-skills.test.ts` | Skills scaffolding |
| Unit | `test/config-v1.test.ts` | Extended config schema |

## Estimated Timeline

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| Phase 1: AgentProvider + OpenCode Provider | 3 days | None |
| Phase 2: DB Schema Migration | 2 days | None |
| Phase 3: JSON Output Helpers | 0.5 day | None |
| Phase 4: Run Lifecycle Commands | 2 days | Phase 2, Phase 3 |
| Phase 5: Agent Invocation Commands | 2 days | Phase 1, Phase 3, Phase 4 |
| Phase 6: Quality/Inspection/Worktree Commands | 2 days | Phase 3 |
| Phase 7: Human Interaction Commands | 1 day | Phase 3 |
| Phase 8: Config Schema Extension | 1 day | None |
| Phase 9: Codex + Claude Agent Providers | 2 days | Phase 1 |
| Phase 10: Skills Bundling | 1 day | None |
| Phase 11: v0 Cleanup | 1.5 days | Phases 1-10 |
| Phase 12: Event Router Migration | 1.5 days | Phase 1 |
| **Total** | **~19.5 days** | |

Phases 1, 2, 3, 8, 9, 10, and 12 have no inter-dependencies and can be parallelized. Critical path: Phase 1 → Phase 5 → Phase 11 (~8.5 days).

## Not In Scope

- Web UI / dashboard (separate initiative, see `006-impl-dashboard.md`)
- Multi-repo orchestration
- Remote/multi-user service
- New workflow types beyond the three core skills
- Automated skill selection
- Category 2 (headless CLI wrapper) or Category 3 (model API + built-in tools) providers
- TUI integration for v1 commands (can be added later on top of v1 primitives)
- v0 → v1 data migration for in-progress runs (runs active at migration time are marked aborted)

## Revision History

### v1.0 (March 4, 2026) — Initial plan

- Complete implementation plan covering all 12 phases of v1 architecture
