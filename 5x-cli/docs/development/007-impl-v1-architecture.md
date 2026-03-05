# v1 Architecture Implementation

**Version:** 1.2
**Created:** March 4, 2026
**Status:** Draft

## Overview

Current behavior: The CLI uses imperative TypeScript state machines (`plan-review-loop.ts`, `phase-execution-loop.ts`) with a single `AgentAdapter` interface hardcoded to OpenCode. The DB schema has 6 tables (`runs`, `run_events`, `agent_results`, `quality_results`, `plans`, `phase_progress`). Commands (`5x run`, `5x plan`, `5x plan-review`) embed orchestration logic directly.

Desired behavior: The CLI becomes a stateless toolbelt of primitives (`5x run init/state/record/complete`, `5x invoke author/reviewer`, `5x quality run`, `5x prompt`, `5x diff`, `5x plan phases`, `5x worktree create/remove/list`). Orchestration moves to agent skills (markdown). Sub-agent invocation is abstracted behind a pluggable `AgentProvider`/`AgentSession` interface with implementations for OpenCode, Codex, and Claude Agent SDKs. The DB schema is simplified to 3 tables (`runs`, `steps`, `plans`).

Why this change: The v0 state machines are brittle (every edge case requires new code), duplicated across workflows, and can't assess semantic quality. The v1 architecture lets orchestrating agents reason about invariant violations instead of pre-coding every transition, supports multiple agent runtimes, and enables new workflow types via skills without new TypeScript.

## Design Decisions

**Implement bottom-up: data layer → provider interface → CLI commands → cleanup.** The provider interface and DB schema are foundational — all commands depend on them. Building bottom-up ensures each phase has stable dependencies and is independently testable. Top-down would require mocking everything.

**OpenCode is the bundled default provider; additional providers ship as separate plugin packages.** OpenCode has a working v0 adapter to migrate from (`src/agents/opencode.ts:481-1130`) and ships with the core CLI (direct import, zero additional install). Other providers (Codex, Claude Agent, third-party) are installed as separate npm packages (e.g. `npm install @5x-ai/provider-codex`) and loaded via dynamic `import()` at runtime. This eliminates optional/peer dependency packaging concerns — each plugin owns its SDK dependency. The core v1 architecture is validated end-to-end with OpenCode alone; plugin providers are developed independently on top of the stable `ProviderPlugin` contract.

**DB migration is additive then subtractive.** Schema version 4 creates the `steps` table and migrates existing data. Old tables are dropped in the same migration. This is a clean break — no compatibility layer. The migration is wrapped in a transaction so it either fully succeeds or rolls back.

**All v1 commands return JSON envelope `{ ok, data }` or `{ ok, error }`.** This is a new convention for v1 commands. v0 commands use console.log directly. Since v0 commands are being deleted (not preserved), the new convention applies only to new code. A shared `outputJson()` helper standardizes output.

**Commands throw typed errors; `bin.ts` renders and exits (error-handling policy).** Command handlers throw a `CliError` class (with `code`, `message`, `detail?`, `exitCode`) rather than calling `process.exit` directly. The top-level `bin.ts` runner catches `CliError`, writes `{ ok: false, error: { code, message, detail } }` to stdout, and exits with the specified code. This keeps command logic testable (tests assert on thrown errors) while maintaining clean exit behavior for the CLI. `outputSuccess()` writes `{ ok: true, data }` and returns (does not exit) — the normal exit happens when the command function returns. `outputError()` is a convenience that throws `CliError`.

**Exit codes are deterministic per error `code`.** Skills branch on exit codes, so they must be stable and documented:

| Exit code | Error `code` | Meaning |
|-----------|-------------|---------|
| 0 | — | Success |
| 1 | (default) | General error / unhandled |
| 2 | `TEMPLATE_NOT_FOUND`, `PLAN_NOT_FOUND`, `PROVIDER_NOT_FOUND`, `INVALID_PROVIDER` | Resource not found / invalid |
| 3 | `NON_INTERACTIVE`, `EOF` | Interactive prompt required but stdin is not a TTY / stdin closed without valid input |
| 4 | `PLAN_LOCKED` | Plan lock held by another process |
| 5 | `DIRTY_WORKTREE` | Uncommitted changes without `--allow-dirty` |
| 6 | `MAX_STEPS_EXCEEDED` | Run hit `maxStepsPerRun` limit |
| 7 | `INVALID_STRUCTURED_OUTPUT` | Agent returned unparseable structured output |
| 130 | `INTERRUPTED` | Prompt cancelled via SIGINT (Ctrl+C) |

**Dashboard reads from v1 schema (cross-initiative decision).** `docs/development/006-impl-dashboard.md` assumes v0 tables (`run_events`, `agent_results`, `quality_results`, `phase_progress`). This plan's v4 migration drops those tables. **Decision:** the dashboard implementation (006) must be updated to read from the v1 schema (`runs`, `steps`, `plans`) before or concurrently with this work. The v4 migration does NOT provide a compatibility view/layer for the old tables. If the dashboard ships first, it must be patched to use v1 tables before the v4 migration runs. This is called out in the "Not In Scope" section as an external dependency.

**Skills are bundled as static markdown files, not generated.** Skills are standalone `.md` files in `.5x/skills/`. The `5x init` command copies them from bundled defaults. No code generation, no templating of skills themselves. Skills reference CLI commands by name — they are decoupled from the implementation.

**External providers use a `ProviderPlugin` contract loaded via dynamic import.** The factory resolves provider names to packages by convention: short names map to scoped packages (`"codex"` → `@5x-ai/provider-codex`), and full package names are accepted for third-party providers (`"@acme/provider-foo"`). Each plugin package default-exports a `ProviderPlugin` with a `name` string and a `create()` factory function returning an `AgentProvider`. The bundled OpenCode provider bypasses this path (direct import). Plugin-specific configuration is passed through from the top-level config key matching the provider name (e.g. `codex: { apiKey: "..." }` is passed to the Codex plugin's `create()` function) — the core CLI does not validate plugin-specific config.

**`step_name` follows `{prefix}:{action}[:{qualifier}]` convention.** Reserved prefixes and their semantics:

| Prefix | Meaning | Examples |
|--------|---------|---------|
| `author:` | Author agent invocation | `author:implement:status`, `author:fix-quality:status` |
| `reviewer:` | Reviewer agent invocation | `reviewer:review:verdict` |
| `quality:` | Quality gate check | `quality:check` |
| `human:` | Human interaction/gate | `human:gate` |
| `phase:` | Phase lifecycle event | `phase:complete` |
| `run:` | Run lifecycle terminal steps | `run:complete`, `run:abort`, `run:reopen` |
| `event:` | Migrated v0 run events | `event:{event_type}` |

The `:{qualifier}` segment (e.g. `:status`, `:verdict`) is required for agent result steps to disambiguate `result_type` values from v0 migration. New v1 code should use it consistently. The `run:*` prefix is reserved for terminal/lifecycle steps recorded by `run complete` and `run reopen` commands. Skills and custom workflows may define additional prefixes but should not use reserved ones.

**Config schema extends, not replaces.** The `FiveXConfigSchema` in `src/config.ts:38-49` gains `provider` field on author/reviewer and `opencode` top-level config. The `maxStepsPerRun` field replaces `maxAutoIterations`. Old fields are accepted with deprecation warnings.

## Phase 1: AgentProvider Interface and OpenCode Provider

**Completion gate:** `AgentProvider`, `AgentSession`, and `ProviderPlugin` interfaces exist in `src/providers/types.ts`. `OpenCodeProvider` passes unit tests covering `startSession`, `resumeSession`, `run` (with structured output), and `close`. `runStreamed()` emits `AgentEvent` objects via a minimal OpenCode SSE→AgentEvent mapper implemented directly in `src/providers/opencode.ts` (not dependent on the full event-router refactor in Phase 11). Factory supports both direct import (bundled OpenCode) and dynamic import (external plugins via `ProviderPlugin` contract). Existing v0 test patterns from `test/agents/` validate behavior.

- [x] Create `src/providers/` directory with `types.ts` defining the `AgentProvider`, `AgentSession`, `ResumeOptions`, `SessionOptions`, `RunOptions`, `RunResult`, `AgentEvent`, and `ProviderPlugin` types per `100-architecture.md:198-244`.

```typescript
// src/providers/types.ts
export interface AgentProvider {
  startSession(opts: SessionOptions): Promise<AgentSession>;
  resumeSession(sessionId: string, opts?: ResumeOptions): Promise<AgentSession>;
  close(): Promise<void>;
}

export interface ResumeOptions {
  model?: string;              // model override for the resumed session
}

export interface AgentSession {
  readonly id: string;
  run(prompt: string, opts?: RunOptions): Promise<RunResult>;
  runStreamed(prompt: string, opts?: RunOptions): AsyncIterable<AgentEvent>;
}

export interface SessionOptions {
  model: string;               // model identifier (provider-specific format)
  workingDirectory: string;    // cwd for tool execution (file edits, shell commands)
}

/** JSON Schema type — matches `100-architecture.md` definition. */
export type JSONSchema = Record<string, unknown>;

export interface RunOptions {
  outputSchema?: JSONSchema;   // structured output extraction
  signal?: AbortSignal;
  timeout?: number;            // per-run timeout in seconds
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

/** Contract for external provider plugins. Default export of a provider package. */
export interface ProviderPlugin {
  readonly name: string;
  create(config?: Record<string, unknown>): Promise<AgentProvider>;
}
```

- [x] Create `src/providers/opencode.ts` implementing `AgentProvider` using `@opencode-ai/sdk`. Port the core invocation logic from `src/agents/opencode.ts:481-1130` — session creation, prompt execution, two-phase structured output, SSE event mapping to `AgentEvent`, timeout/cancellation handling. Key differences from v0:
  - `startSession()` creates session via `client.session.create()` (same as v0 `_invoke` line 790)
  - `resumeSession()` retrieves via `client.session.get()`; accepts optional `ResumeOptions` for model override
  - `run()` does the two-phase prompt (execute + summary with `format: json_schema`) and returns `RunResult`
  - `runStreamed()` maps OpenCode SSE events to `AgentEvent` via a minimal mapper implemented directly in `opencode.ts` (does NOT depend on `src/utils/event-router.ts` or `StreamWriter`; the full event-router refactor is deferred to Phase 11)
  - `close()` calls `server.close()` (same as v0 line 541)
  - Supports both managed mode (`createOpencode()`) and external mode (`createOpencodeClient()`)

```typescript
// src/providers/opencode.ts
export class OpenCodeProvider implements AgentProvider {
  static async createManaged(opts?: { model?: string }): Promise<OpenCodeProvider>;
  static createExternal(baseUrl: string, opts?: { model?: string }): OpenCodeProvider;

  startSession(opts: SessionOptions): Promise<AgentSession>;
  resumeSession(sessionId: string, opts?: ResumeOptions): Promise<AgentSession>;
  close(): Promise<void>;
}
```

- [x] Create `src/providers/factory.ts` with `createProvider(role, config)` that reads provider config from `FiveXConfig` and instantiates the correct provider. **Forward-compatible with missing config keys (P1.1):** if `config.author.provider` or `config.reviewer.provider` is absent (i.e. Phase 8 config extension hasn't landed yet), default to `"opencode"`. Similarly, if `config.opencode.url` is absent, use managed mode. This allows Phase 1 to be implemented and tested independently of Phase 8. **Plugin loading:** for `"opencode"`, uses a direct import (bundled). For any other provider name, resolves to an npm package via convention (`"codex"` → `@5x-ai/provider-codex`, or a full package name like `"@acme/provider-foo"`) and dynamically imports it. The imported module must default-export a `ProviderPlugin`. Throws `PROVIDER_NOT_FOUND` (exit code 2) with install instructions if the package is missing, or `INVALID_PROVIDER` if the module doesn't satisfy the `ProviderPlugin` contract.

```typescript
// src/providers/factory.ts
export async function createProvider(
  role: "author" | "reviewer",
  config: FiveXConfig,
): Promise<AgentProvider>;

// Plugin resolution (internal)
async function loadPlugin(providerName: string): Promise<ProviderPlugin> {
  if (providerName === "opencode") {
    // Bundled — direct import, no plugin indirection
    throw new Error("opencode is bundled; use direct import");
  }
  const packageName = providerName.startsWith("@")
    ? providerName
    : `@5x-ai/provider-${providerName}`;
  const mod = await import(packageName); // throws if not installed
  const plugin: ProviderPlugin = mod.default;
  if (!plugin?.create || typeof plugin.create !== "function") {
    throw new CliError("INVALID_PROVIDER", ...);
  }
  return plugin;
}
```

- [x] Create `src/providers/index.ts` re-exporting types and factory.

- [x] Write unit tests in `test/providers/types.test.ts` validating the type contracts (compile-time check).

- [x] Write integration tests in `test/providers/opencode.test.ts` covering:
  - Managed mode lifecycle (create → startSession → run → close)
  - External mode connection
  - Structured output extraction (AuthorStatus and ReviewerVerdict schemas)
  - Session resume
  - Timeout handling
  - Cancellation via AbortSignal
  - AgentEvent stream mapping

## Phase 2: Database Schema Migration

**Completion gate:** Schema version 4 migration creates `steps` table, migrates existing v0 data, drops old tables. `runMigrations()` succeeds on fresh DBs and on DBs with existing v0 data. All existing tests in `test/db/` pass with the new schema.

- [x] Add migration version 4 to `src/db/schema.ts:220` (after the existing `migrations` array). **Important:** SQLite does not reliably support `ALTER TABLE ... DROP COLUMN` across environments. The `runs` table modification (step 6) MUST use the table-rebuild pattern: `CREATE TABLE runs_new(...)` → `INSERT INTO runs_new SELECT ... FROM runs` → `DROP TABLE runs` → `ALTER TABLE runs_new RENAME TO runs`. The entire migration is wrapped in a transaction.

  Migration steps:
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

  2. Migrates `agent_results` → `steps` with `step_name = "{role}:{template}:{result_type}"` (e.g. `"author:author-next-phase:status"`, `"reviewer:reviewer-phase:verdict"`). Including `result_type` in `step_name` prevents UNIQUE constraint violations when the same `(run_id, phase, iteration, role, template)` has both a `status` and `verdict` row.
  3. Migrates `quality_results` → `steps` with `step_name = "quality:check"`
  4. Migrates `run_events` → `steps` with `step_name = "event:{event_type}"`
  5. Migrates `phase_progress` where `review_approved = 1` → `steps` with `step_name = "phase:complete"`
  6. Rebuilds `runs` table using SQLite table-rebuild pattern (see below) to remove `current_state`, `current_phase`, `review_path` columns, rename timestamp columns, and add `config_json`. Explicit column mapping: `created_at = started_at`, `updated_at = COALESCE(completed_at, started_at)`. The v0 `completed_at` column is dropped (terminal state is now recorded as a `run:complete` or `run:abort` step). Tests must assert that existing `started_at` values appear as `created_at` and `completed_at` values appear as `updated_at` after migration.
  7. Drops `agent_results`, `quality_results`, `run_events`, `phase_progress` tables

- [x] Create `src/db/operations-v1.ts` with new step-based operations:

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

/** Get steps for a run, ordered by creation. Supports optional pagination. */
export function getSteps(db: Database, runId: string, opts?: {
  sinceStepId?: number;  // return steps with id > sinceStepId
  tail?: number;         // return only the last N steps
}): StepRow[];

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

- [x] Write tests in `test/db/schema-v4.test.ts` covering:
  - Fresh DB migration (no v0 data)
  - Migration from v3 with existing v0 data (agent_results, quality_results, run_events, phase_progress)
  - Data integrity after migration: step counts match source records; both `result_type=status` and `result_type=verdict` rows from `agent_results` survive as distinct steps (e.g. `"author:tpl:status"` and `"author:tpl:verdict"`)
  - Runs table rebuild: v0 `started_at` mapped to `created_at`, v0 `completed_at` mapped to `updated_at`, dropped columns (`current_state`, `current_phase`, `review_path`, `started_at`, `completed_at`) absent, `config_json` column present
  - Migration on a v3 DB with representative data (multiple runs, mixed result types, partial phase_progress)
  - `recordStep` INSERT OR IGNORE semantics (first write wins)
  - Auto-increment iteration behavior
  - `computeRunSummary` aggregation

- [x] Write tests in `test/db/operations-v1.test.ts` covering all new operation functions.

## Phase 3: JSON Output Envelope and Shared Helpers

**Completion gate:** A shared `outputJson()` helper exists in `src/output.ts`. All v1 commands use `{ ok: true, data }` / `{ ok: false, error: { code, message, detail? } }` format.

- [x] Create `src/output.ts` with JSON output helpers:

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

/** Write success JSON to stdout (does not exit — command returns normally). */
export function outputSuccess<T>(data: T): void;

/** Throw a CliError — caught by bin.ts, which writes error JSON to stdout and exits. */
export function outputError(code: string, message: string, detail?: unknown, exitCode?: number): never;

/** Typed error class for CLI commands. Thrown, not caught internally. */
export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
    public readonly exitCode: number = 1,
  );
}

/** Generate a run ID with prefix. */
export function generateRunId(): string;

/** Generate a log sequence number for agent invocations within a run. */
export function nextLogSequence(logDir: string): string;
```

- [x] Create `src/run-id.ts` with `generateRunId()` returning `"run_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12)`.

- [x] Write tests in `test/output.test.ts` covering envelope formatting and error codes.

## Phase 4: Run Lifecycle Commands

**Completion gate:** `5x run init`, `5x run state`, `5x run record`, `5x run complete`, `5x run reopen`, and `5x run list` are functional and return JSON envelopes. Integration tests exercise the full lifecycle: init → record steps → state → complete.

- [x] Create `src/commands/run-v1.ts` implementing the `run` subcommand group with six subcommands. Register it in `src/bin.ts` replacing the v0 `run` import (line 17).

- [x] Implement `5x run init --plan <path> [--command <name>] [--allow-dirty]`:
  - Canonicalize plan path via `canonicalizePlanPath()` from `src/paths.ts:4`
  - **Lock-first invariant (P0.2):** `run init` MUST hold the plan lock before returning any active run. The sequence is:
    1. Attempt to acquire plan lock via `acquireLock()` from `src/lock.ts:98`.
    2. If lock is held by another **live** PID → return `PLAN_LOCKED` error (do NOT return the existing run).
    3. If lock is missing or stale (owner PID dead) → steal/acquire it and proceed.
    4. Only after the lock is held: check for existing active run via `getActiveRunV1()`. If found, return it (idempotent). If not, create a new run.
  - This ordering guarantees that the caller always holds the lock when it receives a run, preventing two orchestrators from acting on the same plan concurrently.
  - Check git safety via `checkGitSafety()` from `src/git.ts:74`; on dirty without `--allow-dirty`, return `DIRTY_WORKTREE` error (release lock before returning error)
  - Create run via `createRunV1()` with generated ID
  - Register lock cleanup via `registerLockCleanup()` from `src/lock.ts:196`
  - Return `{ ok: true, data: { run_id, plan_path, status, created_at } }`

- [x] Implement `5x run state --run <id>` / `5x run state --plan <path>` with optional pagination:
  - Fetch run and steps via `getRunV1()` and `getSteps()`
  - Support `--tail <N>` to return only the last N steps (default: all)
  - Support `--since-step <id>` to return only steps after the given step ID
  - When neither flag is set, return full step list (backward-compatible, agent-friendly)
  - Compute summary via `computeRunSummary()` (always covers the full run, regardless of step filters)
  - Return step list and summary per `101-cli-primitives.md:120-156`
  - **Performance note:** for long runs with large `result_json` blobs, `--tail` / `--since-step` avoid unbounded payloads

- [x] Implement `5x run record <step-name> --run <id> --result <json> [--phase <id>] [--iteration <n>]`:
  - Parse `--result`: raw JSON string, `-` for stdin, `@path` for file
  - Compute iteration via `nextIteration()` if `--iteration` omitted
  - Record via `recordStep()` — INSERT OR IGNORE
  - Return `{ step_id, step_name, phase, iteration, recorded }` per `101-cli-primitives.md:184-195`
  - Enforce `maxStepsPerRun` from config; return error if exceeded

- [x] Implement `5x run complete --run <id> [--status completed|aborted] [--reason <text>]`:
  - Record terminal step (`run:complete` or `run:abort`)
  - Update run status via `completeRun()`
  - Release plan lock via `releaseLock()` from `src/lock.ts:154`

- [x] Implement `5x run reopen --run <id>`:
  - Record `run:reopen` step with previous status
  - Set run back to active via `reopenRun()`

- [x] Implement `5x run list [--plan <path>] [--status <s>] [--limit <n>]`:
  - Query via `listRuns()`
  - Return array of run summaries

- [x] Write integration tests in `test/commands/run-v1.test.ts` covering:
  - Full lifecycle: init → record → state → complete
  - Idempotent init (returns existing active run with lock held)
  - Plan lock enforcement (second init from different PID returns `PLAN_LOCKED`)
  - Stale lock recovery (lock held by dead PID is stolen, run returned)
  - Dirty worktree check (without --allow-dirty)
  - Step recording with INSERT OR IGNORE (duplicate returns recorded=false)
  - Auto-increment iteration
  - Max steps per run enforcement
  - Run reopen
  - Run list with filters

## Phase 5: Agent Invocation Commands

**Completion gate:** `5x invoke author <template>` and `5x invoke reviewer <template>` execute sub-agent invocations via the provider interface, return structured results as JSON, and write NDJSON log files. Template resolution, variable substitution, and structured output validation work end-to-end.

- [x] Create `src/commands/invoke.ts` implementing the `invoke` subcommand group with `author` and `reviewer` subcommands.

- [x] Implement shared invocation logic (used by both `invoke author` and `invoke reviewer`):
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

- [x] Implement NDJSON log writer using `AgentEvent` stream from `runStreamed()`:
  - Create log dir `.5x/logs/<run_id>/` with `0o700` permissions
  - Compute sequence number from existing files in the directory
  - Write each `AgentEvent` as a JSON line
  - Reuse console rendering from `src/utils/stream-writer.ts` for non-quiet mode

- [x] Register `invoke` in `src/bin.ts`.

- [x] Write tests in `test/commands/invoke.test.ts` covering:
  - Template resolution (bundled + override)
  - Variable substitution
  - Structured output validation (valid AuthorStatus, valid ReviewerVerdict)
  - Invalid structured output (throws `INVALID_STRUCTURED_OUTPUT`, exit code 7)
  - Template not found (throws `TEMPLATE_NOT_FOUND`, exit code 2)
  - NDJSON log file creation
  - Session resume via `--session`

## Phase 6: Quality, Inspection, and Worktree Commands

**Completion gate:** `5x quality run`, `5x plan phases`, `5x diff`, and `5x worktree create/remove/list` return JSON envelopes and are registered in the CLI.

- [x] Create `src/commands/quality-v1.ts` implementing `5x quality run`:
  - Reuse `runQualityGates()` from `src/gates/quality.ts:146`
  - Wrap result in JSON envelope per `101-cli-primitives.md:396-408`
  - Return `{ passed, results: [{ command, passed, duration_ms, output }] }`

- [x] Create `src/commands/plan-v1.ts` implementing `5x plan phases <path>`:
  - Reuse `parsePlan()` from `src/parsers/plan.ts`
  - Return `{ phases: [{ id, title, done, checklist_total, checklist_done }] }`

- [x] Create `src/commands/diff.ts` implementing `5x diff [--since <ref>] [--stat]`:
  - Shell out to `git diff` via `Bun.spawn` (similar to `src/git.ts:33-48`)
  - Parse stat output for `files_changed`, `insertions`, `deletions`
  - Return per `101-cli-primitives.md:455-465`

- [x] Rewrite `src/commands/worktree.ts` (currently at 180 lines) to implement v1 API:
  - `5x worktree create --plan <path> [--branch <name>]` — uses `createWorktree()` from `src/git.ts:304`, runs `postCreate` hook, records in `plans` table
  - `5x worktree remove --plan <path> [--force]` — uses `removeWorktree()` from `src/git.ts:324`, clears DB
  - `5x worktree list` — uses `listWorktrees()` from `src/git.ts:339`, joins with `plans` table
  - All return JSON envelopes

- [x] Register `quality`, updated `plan`, `diff` in `src/bin.ts`.

- [x] Write tests in `test/commands/quality-v1.test.ts`, `test/commands/plan-v1.test.ts`, `test/commands/diff.test.ts`, `test/commands/worktree-v1.test.ts`.

## Phase 7: Human Interaction Commands

**Completion gate:** `5x prompt choose`, `5x prompt confirm`, and `5x prompt input` present interactive prompts and return JSON results. Non-TTY behavior (default values, `NON_INTERACTIVE` error) works correctly.

- [x] Create `src/commands/prompt.ts` implementing the `prompt` subcommand group:

- [x] Implement `5x prompt choose <message> --options <a,b,c> [--default <a>]`:
  - If stdin is TTY: present numbered options, wait for selection
  - If not TTY + `--default`: return default immediately
  - If not TTY + no default: throw `NON_INTERACTIVE` error (exit code 3)
  - Return `{ choice: "<selected>" }`

- [x] Implement `5x prompt confirm <message> [--default yes|no]`:
  - If stdin is TTY: present `[y/n]` prompt
  - Non-TTY behavior same as `choose`
  - Return `{ confirmed: true|false }`

- [x] Implement `5x prompt input <message> [--multiline]`:
  - If stdin is TTY: read line (or multiline with Ctrl+D terminator)
  - If not TTY: read from stdin pipe
  - Return `{ input: "<text>" }`

- [x] Register `prompt` in `src/bin.ts`.

- [x] Write tests in `test/commands/prompt.test.ts` covering:
  - Non-interactive with default (returns default)
  - Non-interactive without default (NON_INTERACTIVE error)
  - Input parsing (single line, multiline)

## Phase 8: Config Schema Extension

**Completion gate:** Config schema accepts `provider` field on author/reviewer, `opencode` top-level config, and `maxStepsPerRun`. Unknown/deprecated keys produce warnings. Existing configs continue to work.

- [ ] Extend `AgentConfigSchema` in `src/config.ts:5-9` to add `provider` as an open string (not an enum — allows third-party plugin names):

```typescript
const AgentConfigSchema = z.object({
  provider: z.string().default("opencode"),
  model: z.string().optional(),
  timeout: z.number().int().positive().optional(),
});
```

- [ ] Add `OpenCodeConfigSchema` and `maxStepsPerRun` to `FiveXConfigSchema` in `src/config.ts:38-49`. The `opencode` key is validated because it's the bundled provider. Plugin-specific config keys (e.g. `codex`, `claude`) are **not** validated by the core schema — they're passed through to the plugin's `create()` function via `z.passthrough()` or by reading raw config before Zod strips unknown keys:

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
}).passthrough(); // Allow plugin-specific config keys (e.g. codex: { ... })
```

- [ ] Update `warnUnknownConfigKeys()` in `src/config.ts:130-206` to accept `provider` in agent config and `opencode` at root level. Suppress unknown-key warnings for top-level keys that match a configured provider name (i.e. if `author.provider` is `"codex"`, don't warn about a top-level `codex` key). Add deprecation warnings for `maxAutoIterations` → `maxStepsPerRun`.

- [ ] Update `applyModelOverrides()` in `src/config.ts:62-78` to also support `--author-provider`, `--reviewer-provider`, `--opencode-url` overrides.

- [ ] Write tests in `test/config-v1.test.ts` covering:
  - New fields parse correctly
  - Defaults work (provider defaults to "opencode")
  - Unknown keys warn (except keys matching a configured provider name)
  - Deprecated keys warn
  - `opencode.url` validation
  - Plugin config passthrough: arbitrary keys under a provider name (e.g. `codex: { apiKey: "..." }`) survive parsing

## Phase 9: Skills Bundling and Init Update

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

## Phase 10: v0 Cleanup and Public API Update

**Completion gate:** v0 orchestrator loops, commands, and adapter interface are deleted. `src/bin.ts` only registers v1 commands. `src/index.ts` exports v1 types (including `ProviderPlugin`). All tests pass. TypeScript compiles cleanly.

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
  - Add: `AgentProvider`, `AgentSession`, `AgentEvent`, `RunResult`, `SessionOptions`, `RunOptions`, `ProviderPlugin`
  - Add: `recordStep`, `getSteps`, `StepRow`, `RecordStepInput`, `RecordStepResult`
  - Add: `outputSuccess`, `outputError`, `CliError`, `JsonEnvelope`

- [ ] Delete v0 test files:
  - `test/orchestrator/`
  - `test/agents/`
  - `test/commands/run.test.ts`, `test/commands/plan.test.ts`, `test/commands/plan-review.test.ts`

- [ ] Run full test suite: `bun test`
- [ ] Run typecheck: `bunx --bun tsc --noEmit`
- [ ] Run lint: `bunx --bun @biomejs/biome check src/ test/`

## Phase 11: Event Router Migration

**Completion gate:** The existing SSE event router in `src/utils/event-router.ts` is refactored to use `AgentEvent` as its canonical output type, consolidating the minimal mapper from Phase 1's `opencode.ts` into a shared `event-mapper.ts`. NDJSON logs use `AgentEvent` format exclusively. `StreamWriter` renders `AgentEvent` instead of raw SSE events.

- [ ] Create `src/providers/event-mapper.ts` that maps provider-native events to `AgentEvent`:
  - OpenCode: reuse logic from `src/utils/event-router.ts` (currently maps SSE events to StreamWriter calls) — refactor to emit `AgentEvent` objects instead
  - Plugin providers: each plugin is responsible for its own event mapping (the `runStreamed()` contract already requires `AsyncIterable<AgentEvent>`)

- [ ] Update `src/utils/stream-writer.ts` to accept `AgentEvent` objects directly (instead of provider-specific event routing).

- [ ] Update NDJSON log writing (currently in `src/agents/opencode.ts:295-475`) to write `AgentEvent` objects. Move log writing logic to a shared `src/providers/log-writer.ts`.

- [ ] Write tests in `test/providers/event-mapper.test.ts` covering:
  - OpenCode SSE → AgentEvent mapping (text, reasoning, tool_start, tool_end, usage, done)
  - Tool input summary formatting (bash→command, edit→file, etc.)
  - Error events

## Phase 12: Sample Provider Plugin

**Completion gate:** A sample provider plugin exists in `packages/provider-sample/`, implements the `ProviderPlugin` contract, and is loadable via `provider: "sample"` in config. The factory's dynamic import path, error handling for missing plugins, and plugin contract validation are smoke-tested end-to-end. This phase validates the external plugin architecture without introducing real SDK dependencies.

- [ ] Add Bun workspace configuration to the repo root `package.json`:

```json
{
  "workspaces": ["packages/*"]
}
```

- [ ] Create `packages/provider-sample/package.json`:

```json
{
  "name": "@5x-ai/provider-sample",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "peerDependencies": {
    "@5x-ai/5x-cli": "workspace:*"
  }
}
```

- [ ] Create `packages/provider-sample/src/index.ts` implementing `ProviderPlugin`:
  - `SampleProvider` implements `AgentProvider` with echo/noop behavior:
    - `startSession()` returns a `SampleSession` with a generated ID
    - `resumeSession()` returns a session with the given ID
    - `close()` is a no-op
  - `SampleSession` implements `AgentSession`:
    - `run()` echoes the prompt back as `RunResult.text` with zero tokens/cost
    - `runStreamed()` yields a minimal event sequence: `text` → `usage` → `done`
  - Default export satisfies `ProviderPlugin { name: "sample", create() }`
  - No external SDK dependencies — the entire plugin is ~50 LOC

- [ ] Write integration tests in `test/providers/plugin-loading.test.ts` covering:
  - Factory resolves `provider: "sample"` → dynamically imports `@5x-ai/provider-sample`
  - Full lifecycle through factory: `createProvider("author", config)` → `startSession` → `run` → `close`
  - `runStreamed()` yields correctly typed `AgentEvent` sequence
  - Missing plugin: factory throws `PROVIDER_NOT_FOUND` with install instructions when package doesn't exist
  - Invalid plugin: module exists but doesn't export valid `ProviderPlugin` → `INVALID_PROVIDER` error
  - Bundled OpenCode provider still works via direct import path (not the plugin code path)
  - Plugin-specific config passthrough: `sample: { echo: true }` in config is passed to `create()`

## Files Touched

| File | Change |
|------|--------|
| `src/providers/types.ts` | **New** — AgentProvider, AgentSession, AgentEvent, ProviderPlugin interfaces |
| `src/providers/opencode.ts` | **New** — OpenCode provider implementation (bundled) |
| `src/providers/factory.ts` | **New** — Provider factory with plugin loading via dynamic import |
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
| `src/config.ts` | **Modified** — Add provider (open string), opencode, maxStepsPerRun; passthrough for plugin config |
| `src/bin.ts` | **Modified** — Register v1 commands, remove v0 commands |
| `src/index.ts` | **Modified** — Export v1 types (incl. ProviderPlugin), remove v0 exports |
| `src/utils/stream-writer.ts` | **Modified** — Accept AgentEvent input |
| `src/utils/event-router.ts` | **Modified** — Refactor to emit AgentEvent objects |
| `package.json` | **Modified** — Add workspaces config; remove @opencode-ai/sdk from root (moved to bundled provider) |
| `packages/provider-sample/` | **New** — Sample provider plugin package for smoke testing plugin architecture |
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
| Unit | `test/providers/types.test.ts` | Type contracts (incl. ProviderPlugin) compile correctly |
| Integration | `test/providers/opencode.test.ts` | OpenCode provider lifecycle, structured output, streaming |
| Unit | `test/providers/event-mapper.test.ts` | Native event → AgentEvent mapping |
| Integration | `test/providers/plugin-loading.test.ts` | Plugin discovery, loading, error handling, config passthrough |
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
| Unit | `test/config-v1.test.ts` | Extended config schema, plugin config passthrough |

## Estimated Timeline

| Phase | Effort | Dependencies |
|-------|--------|-------------|
| Phase 1: AgentProvider + OpenCode Provider | 3 days | None (factory defaults to opencode when config keys absent) |
| Phase 2: DB Schema Migration | 2 days | None |
| Phase 3: JSON Output Helpers | 0.5 day | None |
| Phase 4: Run Lifecycle Commands | 2 days | Phase 2, Phase 3 |
| Phase 5: Agent Invocation Commands | 2 days | Phase 1, Phase 3, Phase 4 |
| Phase 6: Quality/Inspection/Worktree Commands | 2 days | Phase 3 |
| Phase 7: Human Interaction Commands | 1 day | Phase 3 |
| Phase 8: Config Schema Extension | 1 day | None |
| Phase 9: Skills Bundling | 1 day | None |
| Phase 10: v0 Cleanup | 1.5 days | Phases 1-9 |
| Phase 11: Event Router Migration | 1.5 days | Phase 1 |
| Phase 12: Sample Provider Plugin | 1 day | Phase 1, Phase 8 |
| **Total** | **~18.5 days** | |

Phases 1, 2, 3, 8, 9, and 11 have no inter-dependencies and can be parallelized. Phase 12 (sample plugin) depends on Phase 1 (provider interface + `ProviderPlugin` contract) and Phase 8 (config string-typed `provider` field). Phase 1's factory is forward-compatible with missing config keys (defaults to `"opencode"`), so it does not depend on Phase 8. Phase 12 is non-blocking — the v1 architecture is complete after Phase 11; Phase 12 validates the plugin extension point. Critical path: Phase 1 → Phase 5 → Phase 10 (~8.5 days).

## Not In Scope

- Web UI / dashboard (separate initiative, see `006-impl-dashboard.md`). **Note:** `006-impl-dashboard.md` must be updated to read from v1 schema (`runs`, `steps`, `plans`) before or alongside this work — no v0 compatibility layer is provided by this plan.
- Multi-repo orchestration
- Remote/multi-user service
- New workflow types beyond the three core skills
- Automated skill selection
- Production Codex and Claude Agent provider plugins (developed independently as `@5x-ai/provider-codex`, `@5x-ai/provider-claude` — only the sample plugin is in scope for validating the plugin architecture)
- Category 2 (headless CLI wrapper) or Category 3 (model API + built-in tools) providers
- TUI integration for v1 commands (can be added later on top of v1 primitives)
- v0 → v1 data migration for in-progress runs (runs active at migration time are marked aborted)

## Revision History

### v1.2 (March 4, 2026) — Plugin architecture for providers

Review: `docs/development/reviews/2026-03-04-007-impl-v1-architecture-plan-review.md` (P2.2 follow-up)

**Plugin architecture:**
- Providers restructured as a plugin system. OpenCode remains bundled (direct import). External providers (Codex, Claude Agent, third-party) ship as separate npm packages loaded via dynamic `import()`. This eliminates the optional/peer dependency packaging question entirely — each plugin owns its SDK dependency.
- Added `ProviderPlugin` contract to `src/providers/types.ts` (Phase 1): `{ name: string, create(config?) → AgentProvider }`.
- Factory updated to resolve short provider names to scoped packages by convention (`"codex"` → `@5x-ai/provider-codex`) and accept full package names for third-party plugins.
- Config `provider` field changed from `z.enum()` to `z.string()` (Phase 8). `FiveXConfigSchema` uses `.passthrough()` for plugin-specific config keys.

**Phase reordering:**
- Old Phase 9 (Codex + Claude Agent Providers) removed — production provider plugins are developed independently, out of scope for the v1 architecture plan.
- Old Phases 10-12 renumbered to 9-11. Dependencies updated.
- New Phase 12: Sample Provider Plugin — creates a minimal `@5x-ai/provider-sample` package in `packages/provider-sample/` to smoke test the plugin loading path, error handling, and contract validation end-to-end. Non-blocking for v1 completion.
- Net timeline reduction: ~19.5 days → ~18.5 days (removed 2 days of Codex/Claude implementation, added 1 day for sample plugin + workspace setup).

### v1.1 (March 4, 2026) — Address review feedback

Review: `docs/development/reviews/2026-03-04-007-impl-v1-architecture-plan-review.md`

**P0 blockers resolved:**
- P0.1: `step_name` for migrated `agent_results` now includes `result_type` (`"{role}:{template}:{result_type}"`) to prevent UNIQUE constraint collisions between status and verdict rows. Added migration test coverage for both variants.
- P0.2: `run init` lock-first invariant documented — lock MUST be held before returning any active run. Stale-lock recovery and `PLAN_LOCKED` error for live-PID conflicts specified. Tests updated.
- P0.3: Phase 1 completion gate no longer depends on Phase 12. OpenCode provider implements a minimal SSE→AgentEvent mapper directly; Phase 12 consolidates it into the shared event-mapper.
- P0.4: Migration step 6 (`runs` table modification) uses SQLite table-rebuild pattern (`CREATE runs_new` → copy → drop → rename). Timestamp mapping documented.
- P0.5: Dashboard compatibility decision documented — `006-impl-dashboard.md` must be updated to read from v1 schema; no v0 compatibility layer provided.

**P1 items resolved:**
- P1.1: Phase dependency graph corrected. Phase 1 factory defaults to `"opencode"` when config keys absent (forward-compatible). Phase 9 now explicitly depends on Phase 8. Parallelization note updated.
- P1.2: `RunOptions.outputSchema` type changed from `Record<string, unknown>` to `JSONSchema`. `SessionOptions.timeout` and `RunOptions.timeout` annotated as seconds. Matches `100-architecture.md` exactly.
- P1.3: Error-handling policy decided — commands throw `CliError`, `bin.ts` catches and renders. `outputError()` is a convenience that throws. Tests assert on thrown errors. `CliError` class added to Phase 3.
- P1.4: `run state` supports `--tail <N>` and `--since-step <id>` pagination flags. Default (no flags) returns all steps for backward compatibility. `getSteps()` DB operation updated to accept pagination opts.

**P2 items resolved:**
- P2.1: `step_name` convention table added to Design Decisions — documents all reserved prefixes (`author:`, `reviewer:`, `quality:`, `human:`, `phase:`, `run:`, `event:`), the `:{qualifier}` segment, and guidance for custom workflows.
- P2.2: Codex/Claude Agent SDKs changed to optional peer dependencies with dynamic `import()`. Factory throws clear error if SDK not installed. *(Superseded by v1.2 plugin architecture.)*
- P2.3: Exit-code convention table added — deterministic mapping from error `code` to exit code (0-7) so skills can reliably branch.

### v1.0 (March 4, 2026) — Initial plan

- Complete implementation plan covering all 12 phases of v1 architecture
