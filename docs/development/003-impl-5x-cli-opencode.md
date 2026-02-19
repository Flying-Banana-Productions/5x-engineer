# 5x CLI — OpenCode-First Refactor

**Version:** 1.1
**Created:** February 18, 2026
**Updated:** February 18, 2026 — addendum corrections: remote mode deferred, step identity fix, invariant validators, log/quiet parity, enum alignment, cost columns, audit trail
**Status:** Draft
**Supersedes:** [001-impl-5x-cli.md](./001-impl-5x-cli.md) (phases 6–7 are cancelled; this document governs all remaining work)

---

## Executive Summary

Phases 1–5 of `001-impl-5x-cli.md` are complete: the orchestrator state machines, DB persistence, quality gates, human gates, git/worktree support, prompt templates, and plan/status commands all work. The agent adapter layer (Phase 2 of 001) was implemented for Claude Code only.

This plan replaces the incomplete phases (6–7 of 001) with a focused refactor that:

1. **Drops Claude Code** as an agent harness
2. **Makes OpenCode the sole adapter**, using the `@opencode-ai/sdk` TypeScript SDK
3. **Replaces free-text signal parsing** (`<!-- 5x:verdict -->`, `<!-- 5x:status -->`) with **OpenCode structured output** (typed JSON schema)
4. **Simplifies the orchestrator state machines** by eliminating the `PARSE_*` states that existed solely to extract signals from agent text
5. **Completes reporting and polish** (history command, `--auto` mode, distribution)

> **Scope note (v1):** The adapter runs the OpenCode server **locally only** (same host, same filesystem as the CLI). Remote/cross-host server support is out of scope for this plan — it requires a separate design covering remote filesystem access and tool execution semantics. See P0.2 in the review addendum.

**DB upgrade:** The schema is bumped to version 2 via a new additive migration. If the on-disk DB is *ahead* of the CLI's known schema (newer CLI wrote it), the CLI emits a clear error and aborts rather than operating against an unknown schema. Being *behind* is safe — pending migrations are applied. The existing DB is never silently discarded or mutated in unexpected ways.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Key Design Decisions](#key-design-decisions)
3. [Signal Protocol — Structured Output](#signal-protocol--structured-output)
4. [Phase 1: Prune + SDK Install](#phase-1-prune--sdk-install)
5. [Phase 2: Structured Protocol + DB Schema](#phase-2-structured-protocol--db-schema)
6. [Phase 3: OpenCode Adapter](#phase-3-opencode-adapter)
7. [Phase 4: Orchestrator Refactor](#phase-4-orchestrator-refactor)
8. [Phase 5: Command Layer + Template Updates](#phase-5-command-layer--template-updates)
9. [Phase 6: Reporting, Auto Mode, Polish](#phase-6-reporting-auto-mode-polish)
10. [Files](#files)

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                            5x CLI                                  │
│                                                                    │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────────────────┐  │
│  │ Commands │──▶│ Orchestrator │──▶│   OpenCode Adapter         │  │ 
│  │          │   │              │   │                            │  │
│  │ plan     │   │ plan-review  │   │  managed (local) mode:     │  │
│  │ plan-rev │   │   loop       │   │  ┌──────────────────────┐  │  │
│  │ run      │   │              │   │  │ opencode server      │  │  │
│  │ status   │   │ phase-exec   │   │  │ (spawned locally,    │  │  │
│  │ history  │   │   loop       │   │  │  same filesystem)    │  │  │
│  │ init     │   │              │   │  └──────────┬───────────┘  │  │
│  └──────────┘   └──────┬───────┘   │             │              │  │
│                        │           │  per-invocation:           │  │
│                        │           │  session.create()          │  │
│                        │           │  session.prompt(           │  │
│                        │           │    format: json_schema)    │  │
│                        │           │  → typed structured output │  │
│              ┌─────────┤           │  event.subscribe() → log   │  │
│              │         │           └────────────────────────────┘  │
│              ▼         ▼                                           │
│  ┌──────────────┐ ┌───────────────┐  ┌────────────────────────┐    │
│  │ Prompt       │ │ SQLite DB     │  │ Gates                  │    │
│  │ Templates    │ │ (.5x/5x.db)   │  │                        │    │
│  │ (bundled)    │ │               │  │ quality (shell cmds)   │    │
│  │              │ │ runs, events  │  │ human  (terminal tty)  │    │
│  │ render()     │ │ agent_results │  └────────────────────────┘    │
│  │   ↓ prompt   │ │ quality_res   │                                │
│  │   → adapter  │ │ plans, locks  │  ┌────────────────────────┐    │
│  └──────────────┘ └───────────────┘  │ Plan Lock              │    │
│                                      │ (.5x/locks/)           │    │
│                                      └────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

**Data flow (new):**
```
Templates ──render──▶ prompt string ──▶ adapter.invoke()
                                              │
                               opencode server session.prompt()
                               + format: { type: "json_schema", schema }
                                              │
                               structured output JSON (validated)
                                              │
                          orchestrator reads typed result directly
                          (no text parsing, no PARSE_* states)
                                              │
                               SQLite DB ◀── result stored
                                              │
                               proceed / auto-fix / escalate / fail
```

**Simplified state machine (phase execution):**
```
EXECUTE ──▶ QUALITY_CHECK ──▶ REVIEW
   │              │               │
(SDK call)   (fail, retry)   (SDK call → typed verdict)
   │              │               │
   │        QUALITY_RETRY    ┌────┴────────┐
   │                         │             │
   │                      auto_fix    human_required
   │                         │             │
   │                     AUTO_FIX ──▶ ESCALATE
   │                         │
   │                    QUALITY_CHECK
   │                         │
   │                      REVIEW ──▶ ...
   │                                  │
   └──────────────────────────▶ PHASE_GATE
                                       │
                                  NEXT_PHASE
                                       │
                                   COMPLETE
```

Key difference from 001: **no `PARSE_*` states**. Structured output is returned directly from the SDK call — the orchestrator gets a typed `StatusResult` or `VerdictResult` object immediately.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **OpenCode-only adapter** | Eliminates the subprocess spawn/kill/drain complexity of the Claude Code harness. One adapter, one mental model. OpenCode is model-agnostic so any provider can be used without changing the orchestrator. |
| **Managed (local) mode only — v1** | The adapter always spawns and owns a local OpenCode server (`createOpencode()`). Server and CLI run on the same host with access to the same filesystem — a prerequisite for agent tools (file edits, git ops, test runs) to operate on the CLI's working tree. Remote/cross-host support requires a separate design and is deferred. |
| **Persistent server per `5x run`** | One `createOpencode()` call at run start, reused across all phases and iterations. Avoids cold-start overhead on every agent invocation. Server is closed when `5x run` exits (normal or error). |
| **Fresh session per agent invocation** | Each call creates a new OpenCode session (clean context window). Sessions are cheap to create. Avoids context contamination between author and reviewer, or across iterations. The warm server means session creation is fast. |
| **Structured output replaces signal parsing** | `session.prompt()` accepts `format: { type: "json_schema", schema }`. The SDK validates the response against the schema and retries on validation failure. Eliminates the entire `parsers/signals.ts` module and `PARSE_*` orchestrator states. No more "agent did not produce a 5x:status block" escalations from parsing failures. |
| **SSE event stream → log file** | OpenCode's `event.subscribe()` SSE stream replaces the Claude Code NDJSON stdout pipe. Events (message.part.updated, tool calls, etc.) are streamed to the per-invocation log file. Same log retention contract, different source format. |
| **Abort via session.abort()** | Timeout/cancellation uses `client.session.abort()` + AbortSignal on the SDK client. No subprocess kill required. |
| **Config: model specified per role** | `5x.config.js` specifies `author.model` and `reviewer.model` in `provider/model` format (e.g. `"anthropic/claude-sonnet-4-6"`). Passed to `session.prompt()` at invocation time. Different models can be used per role or per phase. |
| **DB schema — migration to v2** | New migration 002 applied on top of migration 001 (additive). If the on-disk DB version is ahead of the CLI's maximum known version, the CLI errors and aborts — never operates against an unknown schema. Being behind is safe; migrations are applied automatically. The new schema stores structured output JSON directly in `agent_results`, removing `output` and separate `signal_type`/`signal_data` columns. |
| **Templates simplified** | Prompt templates no longer instruct agents to emit `<!-- 5x:status -->` or `<!-- 5x:verdict -->` blocks. The structured output schema is enforced at the SDK layer, not by prompt engineering. Templates focus on the task, not the signal protocol. |
| **Quality gates unchanged** | `src/gates/quality.ts` runs shell commands and captures output — entirely agent-agnostic. No changes needed. |
| **Human gates unchanged** | `src/gates/human.ts` is a terminal prompt — no agent coupling. No changes needed. |

---

## Signal Protocol — Structured Output

The previous protocol used HTML comment blocks embedded in markdown files (for verdicts) or agent stdout (for status). This is replaced by OpenCode's structured output feature.

### Author Status Schema

Requested after every author invocation (plan generation, phase execution, auto-fix):

```typescript
// JSON Schema sent to session.prompt() as format.schema
const AuthorStatusSchema = {
  type: "object",
  properties: {
    result: {
      type: "string",
      enum: ["complete", "needs_human", "failed"],
      description: "Outcome of the author's work",
    },
    commit: {
      type: "string",
      description: "Git commit hash if result is 'complete' for phase execution. Omit otherwise.",
    },
    reason: {
      type: "string",
      description: "Required if result is 'needs_human' or 'failed'. Brief explanation.",
    },
    notes: {
      type: "string",
      description: "Optional notes for the reviewer about what was done.",
    },
  },
  required: ["result"],
} as const
```

> **Routing invariants (enforced by `assertAuthorStatus()` after parse):**
> - If `result === "complete"` and the invocation context is phase execution: `commit` must be present.
> - If `result !== "complete"`: `reason` must be present.
> - Violations are treated as escalations (fail-closed) — never assume success.

### Reviewer Verdict Schema

Requested after every reviewer invocation (plan review, phase review):

```typescript
const ReviewerVerdictSchema = {
  type: "object",
  properties: {
    readiness: {
      type: "string",
      enum: ["ready", "ready_with_corrections", "not_ready"],
      description: "Overall readiness assessment",
    },
    items: {
      type: "array",
      description: "Review items. Empty array if readiness is 'ready'.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short unique identifier, e.g. 'P0.1'" },
          title: { type: "string", description: "One-line description" },
          action: {
            type: "string",
            enum: ["auto_fix", "human_required"],
            description: "auto_fix: mechanical, author can resolve. human_required: needs judgment.",
          },
          reason: { type: "string", description: "Why this item needs attention" },
          priority: {
            type: "string",
            enum: ["P0", "P1", "P2"],
            description: "P0: blocking. P1: important. P2: nice-to-have.",
          },
        },
        required: ["id", "title", "action", "reason"],
      },
    },
    summary: {
      type: "string",
      description: "Optional 1-3 sentence overall assessment.",
    },
  },
  required: ["readiness", "items"],
} as const
```

### TypeScript Types (derived from schemas)

```typescript
export type AuthorStatus = {
  result: "complete" | "needs_human" | "failed"
  commit?: string
  reason?: string
  notes?: string
}

export type VerdictItem = {
  id: string
  title: string
  action: "auto_fix" | "human_required"
  reason: string
  priority?: "P0" | "P1" | "P2"
}

export type ReviewerVerdict = {
  readiness: "ready" | "ready_with_corrections" | "not_ready"
  items: VerdictItem[]
  summary?: string
}
```

> **Routing invariants (enforced by `assertReviewerVerdict()` after parse):**
> - If `readiness !== "ready"`: `items.length > 0` is required.
> - Each item must have `action` present (`"auto_fix"` or `"human_required"`).
> - Violations are treated as escalations (fail-closed).

### Handling Structured Output Failures

If OpenCode's structured output validation fails after retries, the SDK returns an error in `result.data.info.error`. The orchestrator treats this as an escalation (same as the old "missing signal" fallback): never assume success, always escalate to human on parse failure.

---

## Phase 1: Prune + SDK Install

**Goal:** Remove all Claude Code adapter code and prepare the project for the new adapter. Install `@opencode-ai/sdk`.

> **Note on interim non-functionality:** This phase deletes the only working agent harness (`claude-code.ts`) before the OpenCode adapter exists. This is intentional for a speed-first, local-branch refactor — `5x plan`, `5x plan-review`, and `5x run` will throw at the factory call until Phase 3 completes. Tests for the deleted code are removed; all remaining tests must pass. Treat this phase as the start of the big-bang window.

**Completion gate:** `bun test` passes. No references to `claude-code` adapter remain in `src/`. `ndjson-formatter.ts` is **renamed** to `sse-formatter.ts` (not deleted) — see 1.1 below. Commands fail with a single, user-facing message (no stack trace) while the adapter is intentionally unimplemented.

### 1.1 Remove deprecated files / rename formatter

Delete the following files entirely:

- `src/agents/claude-code.ts` — subprocess harness, replaced by OpenCode SDK
- `test/agents/claude-code.test.ts`
- `test/agents/claude-code-schema-probe.test.ts`

**Rename (not delete):**

- `src/utils/ndjson-formatter.ts` → `src/utils/sse-formatter.ts` — Phase 3 will update the internals to handle SSE event shapes. Renaming preserves the module for consumers (Phase 3.3 references it); deleting and re-adding later would leave a gap where Phase 3 has no formatter to build on.
- `test/utils/ndjson-formatter.test.ts` → `test/utils/sse-formatter.test.ts` — update test file name and adjust imports accordingly.

- [x] Delete the 3 deprecated agent files listed above
- [x] Rename `src/utils/ndjson-formatter.ts` → `src/utils/sse-formatter.ts`; update all import references in `src/`
- [x] Rename `test/utils/ndjson-formatter.test.ts` → `test/utils/sse-formatter.test.ts`; update imports

### 1.2 Install OpenCode SDK

- [x] `bun add @opencode-ai/sdk` in `5x-cli/`
- [x] Verify import resolves: `import { createOpencode } from "@opencode-ai/sdk"`
- [x] **Bun/compiled-binary compatibility gate:** verify `@opencode-ai/sdk` imports resolve and a basic object can be constructed under `bun build --compile` (smoke test: import + construct client, assert no bundler errors). Add as an env-gated test similar to `FIVE_X_TEST_LIVE_AGENTS=1` pattern so it is opt-in during CI and can be run locally before broad refactoring.

### 1.3 Update config schema

Update `src/config.ts` `FiveXConfig`:

```typescript
export interface FiveXConfig {
  // v1: adapter always runs locally (same host, same filesystem).
  // No server.url config — managed mode is the only supported topology.

  author: {
    model?: string           // provider/model, e.g. "anthropic/claude-sonnet-4-6"
  }
  reviewer: {
    model?: string
  }

  qualityGates: string[]
  // ... rest unchanged
}
```

> **Note:** Remote/cross-host server config (`server.url`, `server.password`) is intentionally absent from v1. Deferring until a concrete remote filesystem/tool-execution design exists.

- [x] Remove `'claude-code'` from adapter enum; the `adapter` field is removed entirely (only one adapter exists)
- [x] Add `author.model?: string` and `reviewer.model?: string`
- [x] Update Zod schema and `defineConfig()` JSDoc types
- [x] Update `src/commands/init.ts` to generate config with example model strings and a comment noting remote server support is a future feature

### 1.4 Stub out new agent interface

Update `src/agents/types.ts` with new `AgentAdapter` interface (implementation comes in Phase 3):

```typescript
export interface InvokeOptions {
  prompt: string
  model?: string       // provider/model override
  logPath: string      // write SSE events here (always written; independent of quiet)
  quiet?: boolean      // suppress console output; log file still written
  timeout?: number     // ms, default 300_000
  signal?: AbortSignal
}

export type InvokeStatus = {
  type: "status"
  status: AuthorStatus
  duration: number
  sessionId: string
  tokensIn?: number   // nullable — not all providers/models report this
  tokensOut?: number
  costUsd?: number
}

export type InvokeVerdict = {
  type: "verdict"
  verdict: ReviewerVerdict
  duration: number
  sessionId: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
}

export type InvokeResult = InvokeStatus | InvokeVerdict

export interface AgentAdapter {
  /** Invoke agent and return structured output. Throws on hard failure (network, timeout). */
  invokeForStatus(opts: InvokeOptions): Promise<InvokeStatus>
  invokeForVerdict(opts: InvokeOptions): Promise<InvokeVerdict>
  /** Check adapter is available (server reachable, model configured). */
  verify(): Promise<void>
  /** Shut down the underlying server (called once at end of run). */
  close(): Promise<void>
}
```

- [x] Update `src/agents/types.ts` with interface above (import `AuthorStatus`, `ReviewerVerdict` from new protocol types file — created in Phase 2)
- [x] Update `src/agents/factory.ts`: `createAdapter()` throws `Error("opencode adapter not yet implemented")` with clear message; remove all Claude Code references
- [x] Update `test/agents/factory.test.ts` to match new interface

### 1.5 Update agent-event-helpers

`src/utils/agent-event-helpers.ts` currently exports `makeOnEvent()` (Claude Code NDJSON-specific), `outputSnippet()`, and `buildEscalationReason()`. The `makeOnEvent()` helper is deprecated. The other two are partially reusable but will change shape.

- [ ] Remove `makeOnEvent()` entirely (deferred to Phase 4)
- [x] Keep `outputSnippet()` and `buildEscalationReason()` as stubs; they will be updated in Phase 4 when the orchestrator is refactored
- [x] Update test for `agent-event-helpers` if one exists (currently it's tested implicitly via orchestrator tests)

> **Note:** `makeOnEvent()` removal is deferred to Phase 4. Orchestrator loops still call it via `LegacyAgentAdapter.invoke()`; Phase 4 rewrites orchestrators to use `AgentAdapter.invokeForStatus`/`invokeForVerdict` and drops `onEvent` entirely.

### 1.6 Verify tests pass

- [x] `bun test --concurrent --dots` — all remaining tests pass, 0 failures

---

## Phase 2: Structured Protocol + DB Schema

**Goal:** Define the canonical TypeScript types for structured output. Update the DB schema to store structured results directly. Remove `parsers/signals.ts`. All DB operations reflect the new schema.

**Completion gate:** `bun test` passes. `src/parsers/signals.ts` is deleted. DB operations store and retrieve `AuthorStatus` / `ReviewerVerdict` as JSON.

### 2.1 Create protocol types module

Create `src/protocol.ts`:

> **Enum naming:** The previous signal protocol (001) used `result: "completed"`. The structured output protocol uses `result: "complete"` (no trailing 'd'). This is intentional — the old enum only existed in text-parsed signal blocks which are fully removed by this refactor. All new code must use `"complete"`.

- [x] Export `AuthorStatus`, `ReviewerVerdict`, `VerdictItem` TypeScript types (as shown in the Signal Protocol section above)
- [x] Export `AuthorStatusSchema` and `ReviewerVerdictSchema` JSON schema objects (used by adapter when calling `session.prompt()`)
- [x] Export a helper `isStructuredOutputError(result): boolean` that checks for SDK structured output failures
- [x] Export `assertAuthorStatus(status: AuthorStatus, context: string): void` — post-parse routing invariant validator (see Phase 2.5)
- [x] Export `assertReviewerVerdict(verdict: ReviewerVerdict): void` — post-parse routing invariant validator (see Phase 2.5)

### 2.2 Remove signal parsers

- [x] Delete `src/parsers/signals.ts`
- [x] Delete `test/parsers/signals.test.ts`
- [x] Remove signal parser exports from `src/index.ts`

### 2.3 Update DB schema

Add a new migration 002 on top of the existing migration 001. **Do not replace migration 001** — the migration runner is additive. Migration 002 drops the old `agent_results` table and recreates it with the new structure (acceptable since DB wipe is explicitly accepted for this effort).

> **Schema mismatch behavior:** The migration runner is additive — a DB that is *behind* the CLI's known schema is fine; pending migrations are applied automatically. The only hard error case is **DB ahead of CLI** (on-disk version > CLI's maximum known migration version), which indicates the DB was written by a newer CLI build. In that case, emit a clear error and abort:
> `"DB schema version vN is newer than this CLI's maximum known version vM. Upgrade the CLI or delete .5x/5x.db to reset."` — never silently operate against an unknown schema.

**`agent_results` table** — new structure:

```sql
CREATE TABLE agent_results (
  id          TEXT    NOT NULL PRIMARY KEY,  -- ULID, generated fresh per invocation (log file key)
  run_id      TEXT    NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase       TEXT    NOT NULL,              -- phase number or '-1' for plan-review context
  iteration   INTEGER NOT NULL,              -- monotonic per-phase/run agent invocation counter
  role        TEXT    NOT NULL,              -- 'author' | 'reviewer'
  template    TEXT    NOT NULL,              -- template name used (e.g. 'author-next-phase')
  result_type TEXT    NOT NULL,              -- 'status' | 'verdict'
  result_json TEXT    NOT NULL,              -- AuthorStatus | ReviewerVerdict as JSON
  duration_ms INTEGER NOT NULL,
  log_path    TEXT,                          -- SSE event log file path (.5x/logs/<run>/<id>.ndjson)
  session_id  TEXT,                          -- opencode session ID for debugging
  model       TEXT,                          -- provider/model used
  tokens_in   INTEGER,                       -- input tokens (nullable — not all providers report)
  tokens_out  INTEGER,                       -- output tokens (nullable)
  cost_usd    REAL,                          -- estimated cost (nullable — used by Phase 6 history)
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  --
  -- Step identity: uniquely represents one invocation site within a run.
  -- (run_id, phase, iteration, role, template, result_type) maps 1:1 to a
  -- logical orchestration step. On resume, re-running the same step replaces
  -- the previous result (ON CONFLICT DO UPDATE). This matches how the
  -- orchestrator schedules invocations: each combination of template + role +
  -- result_type is distinct, even within the same phase/iteration, so there
  -- are no collision risks when multiple templates are used per role/phase.
  --
  UNIQUE(run_id, phase, iteration, role, template, result_type)
);
```

**`runs` table** — unchanged. Does not have `signal_data`/`signal_type` columns in the existing 001 schema (those were only in the 001 *plan*, not implemented). No changes needed.

**Other tables** (`plans`, `run_events`, `quality_results`) — unchanged.

- [x] Update `src/db/schema.ts`: add migration 002 that drops and recreates `agent_results` with the new structure (schema version bumps to 2)
- [x] Migration 002 includes `CHECK(result_type IN ('status', 'verdict'))` to catch DB corruption early
- [x] Add schema version mismatch error to `runMigrations()` in `src/db/schema.ts`
- [x] Update `src/db/operations.ts`:
  - [x] Remove `getLatestVerdict()` and `getLatestStatus()` which queried the old `signal_data` column
  - [x] Add `upsertAgentResult(db, input: AgentResultInput): void` — stores structured result; uses `INSERT ... ON CONFLICT(run_id, phase, iteration, role, template, result_type) DO UPDATE`
  - [x] Add `getLatestVerdict(db, runId, phase): ReviewerVerdict | null` — queries `agent_results` where `result_type = 'verdict'`, returns parsed `result_json`
  - [x] Add `getLatestStatus(db, runId, phase): AuthorStatus | null` — queries `agent_results` where `result_type = 'status'`, returns parsed `result_json`
  - [x] `hasCompletedStep()` includes `result_type` parameter — matches the composite unique key to make resume/idempotency semantics explicit
  - [x] `getAgentResults()` orders by `CAST(phase AS INTEGER)` for correct numeric phase ordering
  - [x] `AgentResultRow` includes: `id`, `run_id`, `phase`, `iteration`, `role`, `template`, `result_type`, `result_json`, `duration_ms`, `log_path`, `session_id`, `model`, `tokens_in`, `tokens_out`, `cost_usd`, `created_at`
  - [x] Update `upsertAgentResult()` input type to match new schema

> **Migration 002 data loss note:** Migration 002 `DROP TABLE IF EXISTS agent_results` destroys all existing agent result data. This is intentionally acceptable for the local-branch refactor — the schema change is not backwards-compatible and this is pre-production code. If migration 002 runs on a non-empty DB, the user loses all agent result history for previous runs. The runs table and other tables are preserved.

### 2.4 Update tests

- [x] Update `test/db/schema.test.ts` — verify new schema (v2) creates correctly; verify "DB ahead of CLI" (on-disk version > CLI max) produces a clear error; verify "DB behind CLI" applies pending migrations without error
- [x] Update `test/db/operations.test.ts` — update for new `AgentResultInput` shape, corrected composite unique key, and new `getLatestVerdict/getLatestStatus` query behavior

### 2.5 Post-parse invariant validators

Implement in `src/protocol.ts` and call from all orchestrator state machine handler code (after the adapter returns a typed result, before routing decisions are made).

```typescript
/**
 * Assert routing-critical invariants on an AuthorStatus.
 * Throws with a descriptive message on violation (caller should escalate).
 *
 * @param requireCommit - pass true when in phase execution context (commit required on 'complete')
 */
export function assertAuthorStatus(
  status: AuthorStatus,
  context: string,
  opts?: { requireCommit?: boolean }
): void {
  if (status.result === "complete" && opts?.requireCommit && !status.commit) {
    throw new Error(
      `[${context}] AuthorStatus invariant violation: result is 'complete' but 'commit' is missing. ` +
      `Phase execution requires a commit hash. Escalating.`
    )
  }
  if (status.result !== "complete" && !status.reason) {
    throw new Error(
      `[${context}] AuthorStatus invariant violation: result is '${status.result}' but 'reason' is missing. ` +
      `Required for needs_human/failed results. Escalating.`
    )
  }
}

/**
 * Assert routing-critical invariants on a ReviewerVerdict.
 * Throws with a descriptive message on violation (caller should escalate).
 */
export function assertReviewerVerdict(verdict: ReviewerVerdict, context: string): void {
  if (verdict.readiness !== "ready" && verdict.items.length === 0) {
    throw new Error(
      `[${context}] ReviewerVerdict invariant violation: readiness is '${verdict.readiness}' but 'items' is empty. ` +
      `Review items are required for non-ready verdicts. Escalating.`
    )
  }
  for (const item of verdict.items) {
    if (!item.action) {
      throw new Error(
        `[${context}] ReviewerVerdict invariant violation: item '${item.id}' is missing 'action'. ` +
        `Each item must have action: 'auto_fix' | 'human_required'. Escalating.`
      )
    }
  }
}
```

- [x] Implement `assertAuthorStatus()` in `src/protocol.ts`
- [x] Implement `assertReviewerVerdict()` in `src/protocol.ts`
- [x] Add `test/protocol.test.ts` — unit tests for both validators:
  - [x] `assertAuthorStatus` — passes with valid complete+commit, valid needs_human+reason, valid failed+reason
  - [x] `assertAuthorStatus` — throws when complete+requireCommit but no commit
  - [x] `assertAuthorStatus` — throws when needs_human/failed but no reason
  - [x] `assertReviewerVerdict` — passes with ready+empty items, not_ready+items with actions
  - [x] `assertReviewerVerdict` — throws when not_ready+empty items
  - [x] `assertReviewerVerdict` — throws when item missing action

---

## Phase 3: OpenCode Adapter

**Goal:** Implement `src/agents/opencode.ts` — a full OpenCode SDK adapter that manages server lifecycle, creates sessions, sends prompts with structured schemas, streams SSE events to log files, and handles timeout/abort.

> **Adapter isolation (P0.1 resolution):** Phase 3 implements and tests the adapter in isolation. The factory (`createAndVerifyAdapter()`) continues to throw its "not yet implemented" error throughout Phase 3 — commands and orchestrators still use `LegacyAgentAdapter` casts and are never exposed to the new adapter. Wiring the adapter into commands/orchestrators happens atomically in Phases 4–5, which remove all legacy casts before enabling the factory. This avoids dual-interface complexity and prevents the runtime crash that would occur if the factory returned an `AgentAdapter` while commands still cast to `LegacyAgentAdapter`.

**Completion gate:** `bun test` passes including new adapter tests. `OpenCodeAdapter.create()` returns a working adapter (tested via direct instantiation, not via factory). Adapter unit tests cover status/verdict invocations with mock server.

### 3.1 Server lifecycle

`OpenCodeAdapter` uses managed (local) mode only in v1. The server is spawned by the CLI on the same host as the repo/worktree, ensuring agent tools have access to the same filesystem.

```typescript
export class OpenCodeAdapter implements AgentAdapter {
  private client: OpencodeClient
  private server: OpencodeServer   // always present — always managed
  private defaultModel?: string

  /**
   * Spawns a local OpenCode server and returns a ready adapter.
   * Throws with an actionable message if the server fails to start.
   */
  static async create(opts: { model?: string }): Promise<OpenCodeAdapter>

  async close(): Promise<void>
  async verify(): Promise<void>
}
```

**Factory function** (called from `src/agents/factory.ts`):

```typescript
// Always managed/local for v1
export async function createAndVerifyAdapter(config: FiveXConfig): Promise<OpenCodeAdapter> {
  const adapter = await OpenCodeAdapter.create({ model: config.author.model })
  await adapter.verify()
  return adapter
}
```

> **Single adapter, both roles:** One `OpenCodeAdapter` instance is created per `5x run` or `5x plan-review` invocation and used for both the author and reviewer roles. Role distinction is expressed via `InvokeOptions.model` (per-invocation override) and the prompt template content, not via separate adapter instances.

- [ ] `static async create()`:
  - Calls `createOpencode({ config: { model: opts.model }, timeout: 15_000 })`
  - Stores server reference; waits for server start
  - Throws descriptive error if server startup times out: `"OpenCode server failed to start — check that opencode is installed and on PATH"`

- [ ] `async close()`:
  - Calls `server.close()` to shut down the spawned local server
  - Idempotent — safe to call multiple times

- [ ] `async verify()`:
  - Calls `client.global.health()`
  - Throws with actionable message if unreachable: `"OpenCode server health check failed — server did not start correctly"`

### 3.2 Per-invocation session management

Both `invokeForStatus()` and `invokeForVerdict()` follow the same pattern:

```
1. Create session: client.session.create({ body: { title } })
2. Start SSE event stream in background: writeEventsToLog(client, logPath)
3. Send prompt: client.session.prompt({ path: { id }, body: { parts, format, model } })
4. Stop SSE stream, flush log file
5. Check for structured output error; if present → throw
6. Return typed result
7. On timeout: client.session.abort({ path: { id } }); throw TimeoutError
```

- [ ] `invokeForStatus(opts: InvokeOptions): Promise<InvokeStatus>`:
  - Sends prompt with `format: { type: "json_schema", schema: AuthorStatusSchema }`
  - Extracts token/cost info from SDK response if available (nullable; stored in `AgentResultInput`)
  - Returns `{ type: "status", status: result.data.info.structured_output, duration, sessionId, tokensIn?, tokensOut?, costUsd? }`

- [ ] `invokeForVerdict(opts: InvokeOptions): Promise<InvokeVerdict>`:
  - Sends prompt with `format: { type: "json_schema", schema: ReviewerVerdictSchema }`
  - Extracts token/cost info from SDK response if available
  - Returns `{ type: "verdict", verdict: result.data.info.structured_output, duration, sessionId, tokensIn?, tokensOut?, costUsd? }`

- [ ] Timeout handling:
  - Race `session.prompt()` against `setTimeout(timeout)` using `AbortController`
  - On timeout: `client.session.abort({ path: { id } })`, log timeout event to log file, throw `AgentTimeoutError`

- [ ] Model override: if `opts.model` is provided, pass as `body.model` to `session.prompt()`

### 3.3 SSE event log streaming

Replace the Claude Code NDJSON pipe with OpenCode's SSE event stream. The **log file contract is preserved** from the 001 implementation:

```typescript
async function writeEventsToLog(
  client: OpencodeClient,
  sessionId: string,
  logPath: string,
  abortSignal: AbortSignal,
  opts: { quiet?: boolean }
): Promise<void>
```

**Log file contract (maintained from 001):**
- Log path: `.5x/logs/<runId>/agent-<resultId>.ndjson` — same path scheme as before
- Each SSE event is serialized as one JSON object per line (NDJSON format, UTF-8)
- Log file is always written regardless of `--quiet` flag (quiet only suppresses console output)
- `EscalationEvent.logPath` is always populated (computed before invocation, passed in; never inferred after the fact)

**Console streaming:**
- When `!quiet`: format SSE events for console display (text content, tool call summaries, etc.) using `formatSseEvent(event)` from `src/utils/sse-formatter.ts`. This module is the Phase 1 rename of `ndjson-formatter.ts`; Phase 3 updates its internals to handle OpenCode SSE event shapes in place of Claude Code NDJSON events.
- When `quiet`: suppress all console output; log file still written.

- [ ] Subscribe: `client.event.subscribe()` → iterate `events.stream`
- [ ] Filter for events relevant to this session (by session ID in event properties)
- [ ] Write each event as a NDJSON line to `logPath` (one JSON object per line)
- [ ] When `!quiet`: format and print event to stdout (console streaming parity with 001)
- [ ] Stop on `AbortSignal` or when session reaches terminal state
- [ ] Log file error handling: attach `on("error")` listener at creation (best-effort, warn + continue)
- [ ] Use `endStream()` from `src/utils/stream.ts` to flush log file on completion

### 3.4 Factory — unchanged in Phase 3

> **P0.1 constraint:** `createAndVerifyAdapter()` in `src/agents/factory.ts` continues to throw `"opencode adapter not yet implemented"` throughout Phase 3. The factory is updated to return the real adapter in Phase 5 (after Phase 4 removes all `LegacyAgentAdapter` casts from orchestrators and commands). Phase 3 tests the adapter exclusively via direct `OpenCodeAdapter.create()` instantiation.

- [ ] Verify factory still throws — no changes to `src/agents/factory.ts` in Phase 3
- [ ] All adapter tests use direct `OpenCodeAdapter.create()`, not the factory

### 3.5 Tests

- [ ] `test/agents/opencode.test.ts` — unit tests using a mock/stub OpenCode client:
  - [ ] `invokeForStatus` returns typed `AuthorStatus`
  - [ ] `invokeForVerdict` returns typed `ReviewerVerdict`
  - [ ] Timeout → `AgentTimeoutError` thrown, session aborted
  - [ ] Structured output failure → throws with descriptive message
  - [ ] SSE events written to log file (log file written even when quiet=true)
  - [ ] Console output suppressed when quiet=true; printed when quiet=false
  - [ ] `close()` is idempotent — safe to call multiple times
  - [ ] `close()` shuts down the spawned local server
  - [ ] `verify()` throws with actionable message if health check fails
  - [ ] `createAndVerifyAdapter()` always creates a managed (local) adapter
  - [ ] `assertAuthorStatus()` called after `invokeForStatus()` — escalation on violation
  - [ ] `assertReviewerVerdict()` called after `invokeForVerdict()` — escalation on violation

---

## Phase 4: Orchestrator Refactor

**Goal:** Remove all `PARSE_*` states from both orchestrator state machines. Replace subprocess-based invocation with `adapter.invokeForStatus()` / `adapter.invokeForVerdict()`. Simplify both loops significantly.

> **P0.1 bridge completion (part 1 of 2):** This phase removes all `LegacyAgentAdapter` imports and casts from the orchestrators. After Phase 4, orchestrators accept the new `AgentAdapter` interface — eliminating the type-lie casts that would crash at runtime if the factory returned a real adapter. Phase 5 completes the bridge by updating commands and enabling the factory.

**Completion gate:** `bun test` passes including all orchestrator tests. State machines no longer contain `PARSE_AUTHOR_STATUS`, `PARSE_VERDICT`, `PARSE_FIX_STATUS`, `PARSE_STATUS` states. Orchestrators accept `adapter: AgentAdapter` instead of constructing one internally. No `LegacyAgentAdapter` references remain in orchestrator code.

### 4.1 Update orchestrator signatures

Both orchestrators receive a pre-constructed `AgentAdapter`:

```typescript
// phase-execution-loop.ts
export interface PhaseExecutionOptions {
  adapter: AgentAdapter       // replaces: author/reviewer config fields
  db: Database
  runId: string
  plan: ParsedPlan
  planPath: string
  reviewPath: string
  workdir: string
  logDir: string
  quiet?: boolean
  maxReviewIterations?: number
  maxQualityRetries?: number
}

// plan-review-loop.ts
export interface PlanReviewLoopOptions {
  adapter: AgentAdapter
  db: Database
  runId: string
  reviewPath: string
  planPath: string
  logDir: string
  quiet?: boolean
  maxIterations?: number
}
```

### 4.2 Refactor `phase-execution-loop.ts`

Current states: `EXECUTE, PARSE_AUTHOR_STATUS, QUALITY_CHECK, QUALITY_RETRY, REVIEW, PARSE_VERDICT, AUTO_FIX, PARSE_FIX_STATUS, PHASE_GATE, ESCALATE`

New states: `EXECUTE, QUALITY_CHECK, QUALITY_RETRY, REVIEW, AUTO_FIX, PHASE_GATE, ESCALATE`

- [ ] **EXECUTE**: call `adapter.invokeForStatus(...)` → `InvokeStatus` returned directly
  - Call `assertAuthorStatus(result.status, "EXECUTE", { requireCommit: true })` — escalate on invariant violation
  - On `result.status.result === "complete"`: store to DB, advance to `QUALITY_CHECK`
  - On `result.status.result === "needs_human"` or `"failed"`: escalate immediately
  - On throw (timeout, network, invariant violation): escalate with error message
  - `PARSE_AUTHOR_STATUS` state eliminated

- [ ] **REVIEW**: call `adapter.invokeForVerdict(...)` → `InvokeVerdict` returned directly
  - Call `assertReviewerVerdict(result.verdict, "REVIEW")` — escalate on invariant violation
  - On `result.verdict.readiness === "ready"`: advance to `PHASE_GATE`
  - On `auto_fix` items: advance to `AUTO_FIX`
  - On `human_required` items or invariant violation: escalate
  - `PARSE_VERDICT` state eliminated

- [ ] **AUTO_FIX**: call `adapter.invokeForStatus(...)` → `InvokeStatus`
  - Call `assertAuthorStatus(result.status, "AUTO_FIX")` — escalate on invariant violation
  - On complete: re-enter `QUALITY_CHECK`
  - On needs_human/failed/throw: escalate
  - `PARSE_FIX_STATUS` state eliminated

- [ ] **QUALITY_RETRY**: call `adapter.invokeForStatus(...)` → same as EXECUTE
  - `PARSE_FIX_STATUS` (quality variant) eliminated

- [ ] Log path: compute `logPath = path.join(logDir, \`agent-\${resultId}.ndjson\`)` **before** each adapter invocation; pass to `InvokeOptions.logPath`. `EscalationEvent.logPath` is always populated from this pre-computed value — no cross-state tracking needed.

- [ ] Remove iteration off-by-one workaround — structured output is synchronous; `iteration++` happens after the result is stored

- [ ] Pass `quiet` flag through to `invokeForStatus`/`invokeForVerdict` so SSE console output is suppressed when `--quiet` is active (log file still written)

### 4.3 Refactor `plan-review-loop.ts`

Current states: `REVIEW, PARSE_VERDICT, AUTO_FIX, PARSE_STATUS, APPROVED, ESCALATE`

New states: `REVIEW, AUTO_FIX, APPROVED, ESCALATE`

- [ ] **REVIEW**: call `adapter.invokeForVerdict(...)` → `InvokeVerdict`
  - Call `assertReviewerVerdict(result.verdict, "PLAN_REVIEW/REVIEW")` — escalate on violation
  - Routing identical to phase-execution REVIEW
  - `PARSE_VERDICT` eliminated

- [ ] **AUTO_FIX**: call `adapter.invokeForStatus(...)` → `InvokeStatus`
  - Call `assertAuthorStatus(result.status, "PLAN_REVIEW/AUTO_FIX")` — escalate on violation
  - `PARSE_STATUS` eliminated

### 4.4 Update `agent-event-helpers.ts`

- [ ] Remove `makeOnEvent()` (deferred from Phase 1; delete in Phase 4 once orchestrators no longer pass `onEvent`)
- [ ] Update `buildEscalationReason()`:
  - No longer takes `AgentResult` (no stdout output)
  - Takes `{ message: string; logPath?: string }` — simpler signature
  - Formats: `"${message}. Log: ${logPath}"`
- [ ] Update `outputSnippet()` or remove if no longer needed (no captured stdout to snippet)

### 4.5 Update orchestrator tests

- [ ] `test/orchestrator/phase-execution-loop.test.ts`:
  - Replace mock `AgentAdapter` from subprocess semantics to new `invokeForStatus`/`invokeForVerdict` interface
  - Remove tests for `PARSE_*` states (they no longer exist)
  - Add tests for structured output error handling (adapter throws)
  - Add tests for invariant validator integration (assertAuthorStatus/assertReviewerVerdict failures escalate)
  - Keep: multi-phase, quality retry, escalation, resume, worktree tests
  - Verify: `EscalationEvent.logPath` is always populated; log file written even when quiet=true

- [ ] `test/orchestrator/plan-review-loop.test.ts`:
  - Same adapter mock update
  - Remove `PARSE_*` state tests
  - Add invariant validator integration tests

### 4.6 Persist structured verdict/status in review artifacts

After storing a verdict or status result in the DB, also append a compact audit record to the review file. This enables humans to inspect result history outside the DB and provides an audit trail that survives DB resets.

**Encoding:** The JSON payload is **base64url-encoded** before embedding in the HTML comment. This prevents `-->` (or any `--` sequence) appearing in string fields — a real risk since review item titles and reasons routinely contain prose with dashes — from breaking the comment delimiter.

Format (append to end of review file, one record per invocation):

```
<!-- 5x:structured:v1 <base64url(JSON)> -->
```

Where the base64url payload decodes to the record object, e.g.:
```json
{"schema":1,"type":"verdict","phase":"-1","iteration":0,"data":{...}}
```

Decoding: `Buffer.from(payload, 'base64url').toString('utf8')`.

- Append-only — never overwrite existing blobs; each invocation appends one new line
- DB remains the source of truth for all orchestration decisions; this is for auditability only
- Parsing by the orchestrator is optional (not in the routing path)
- Implement in `appendStructuredAuditRecord(filePath: string, record: object): Promise<void>` in `src/utils/audit.ts`:
  - Encode: `Buffer.from(JSON.stringify(record)).toString('base64url')`
  - Append: `\n<!-- 5x:structured:v1 ${encoded} -->\n` to the file (append-only file write)
- Call after `upsertAgentResult()` in both orchestrators (plan-review-loop REVIEW and AUTO_FIX results, phase-execution-loop REVIEW and EXECUTE results)

- [ ] Implement `appendStructuredAuditRecord()` in `src/utils/audit.ts` with base64url encoding
- [ ] Call from `plan-review-loop.ts` after storing each verdict/status result
- [ ] Call from `phase-execution-loop.ts` after storing each verdict/status result
- [ ] Add to `test/utils/audit.test.ts`:
  - [ ] Append-only: multiple calls accumulate, never overwrite
  - [ ] Format: each appended line matches `<!-- 5x:structured:v1 <base64url> -->`
  - [ ] Round-trip: decoded payload equals original record object
  - [ ] Encoding safety: payload containing `-->` or `--` in string values does not break comment delimiter

---

## Phase 5: Command Layer + Template Updates

**Goal:** Update all commands to use the new adapter pattern. Update prompt templates to remove structured signal instructions (no more `<!-- 5x:status -->` or `<!-- 5x:verdict -->` blocks). All end-to-end command tests pass. Enable the factory to return a real adapter.

> **P0.1 bridge completion (part 2 of 2):** This phase removes all `LegacyAgentAdapter` casts from commands and enables `createAndVerifyAdapter()` in the factory to return the real `OpenCodeAdapter`. After Phase 5, the entire legacy adapter interface can be deleted — no code references `LegacyAgentAdapter` anywhere.

**Completion gate:** `bun test` passes. Templates contain no references to `5x:verdict` or `5x:status` blocks. Commands construct adapters correctly via `createAndVerifyAdapter()`. No `LegacyAgentAdapter` references remain anywhere in `src/`.

### 5.1 Update `commands/run.ts`

The run command creates the adapter once and passes it to the orchestrator:

```typescript
// Pseudo-code for new run command adapter lifecycle
const adapter = await createAndVerifyAdapter(config) // single adapter for both roles
try {
  await runPhaseExecutionLoop({ adapter, ... })
} finally {
  await adapter.close()
}
```

A single `OpenCodeAdapter` instance serves both author and reviewer roles. The role distinction is expressed through the prompt template content and `InvokeOptions.model` at each call site (e.g., `config.reviewer.model` is passed for reviewer invocations). The adapter itself is model-agnostic.

- [ ] **Enable factory:** Update `createAndVerifyAdapter()` in `src/agents/factory.ts` to call `OpenCodeAdapter.create({ model: config.author.model })` + `adapter.verify()` instead of throwing (deferred from Phase 3 per P0.1 resolution)
- [ ] Remove all `as unknown as LegacyAgentAdapter` casts from `commands/run.ts`
- [ ] Update `commands/run.ts` to create adapter before loop, close in `finally`
- [ ] Pass single `adapter` through to orchestrator (replaces separate author/reviewer adapters)

### 5.2 Update `commands/plan-review.ts`

Same adapter lifecycle pattern:

- [ ] Remove all `as unknown as LegacyAgentAdapter` casts
- [ ] Create single adapter, pass to `runPlanReviewLoop()`, close in `finally`

### 5.3 Update `commands/plan.ts`

The plan generation command invokes an author agent to create the plan. Update to use `adapter.invokeForStatus()`:

- [ ] Remove `as unknown as LegacyAgentAdapter` cast
- [ ] Create `OpenCodeAdapter` via factory, call `invokeForStatus()` with `author-generate-plan` template
- [ ] The `result.status.result === "complete"` path means the plan file was written; use `result.status.commit` if a commit was made
- [ ] Close adapter in `finally`
- [ ] **Delete `LegacyAgentAdapter`:** After all commands are updated, remove the `LegacyAgentAdapter` interface and all legacy types from `src/agents/types.ts`

### 5.4 Update prompt templates

Remove all structured signal instructions. Templates become simpler — they describe the task and the expected output artifact (file path to write), but the structured result is captured by the SDK, not embedded in agent output.

**`author-generate-plan.md`:**
- [ ] Remove any `5x:status` block instructions
- [ ] Add: instruct the agent to write the plan to `{{plan_path}}` and return when done
- [ ] Add: "You will be asked to report the outcome of your work in a structured format when you complete"

**`author-next-phase.md`:**
- [ ] Remove `5x:status` block instructions
- [ ] Clarify: commit your work and return when the phase is implemented
- [ ] Note: the structured outcome (complete/needs_human/failed + commit hash) is captured separately

**`author-process-review.md`:**
- [ ] Remove `5x:status` block instructions
- [ ] Simplify to: address the review items and return when done

**`reviewer-plan.md`:**
- [ ] Remove `5x:verdict` block instructions (verdict is returned via structured output)
- [ ] Keep: detailed reviewer instructions for classifying items as `auto_fix` vs `human_required`
- [ ] Keep: priority (P0/P1/P2) guidance
- [ ] Update: items should be returned in the structured response (describe the fields: id, title, action, reason, priority)

**`reviewer-commit.md`:**
- [ ] Same removals/updates as `reviewer-plan.md`
- [ ] Remove `5x:verdict` block instructions

### 5.5 Update `commands/init.ts`

- [x] Remove `adapter` field from generated config (no longer needed) (done in Phase 1)
- [x] Include example `author.model` and `reviewer.model` with `// e.g. "anthropic/claude-sonnet-4-6"` (done in Phase 1)
- [x] Do **not** include a `server` block in the generated config — remote mode is not supported in v1. Add a comment in the generated config: `// OpenCode server runs locally (same host). Remote server support is a future feature.` (done in Phase 1)
- [x] Remove any reference to Claude Code in the generated config or output messages (done in Phase 1)

### 5.6 Update `src/parsers/review.ts`

The review summary parser reads human-readable review markdown. Verify it has no dependency on `parsers/signals.ts` (it shouldn't — it parses the prose, not signal blocks):

- [ ] Audit `parsers/review.ts` for any signal block imports — remove if present
- [ ] No functional changes expected

### 5.7 Tests

- [ ] Update `test/commands/plan.test.ts` — mock adapter
- [ ] Update `test/commands/plan-review.test.ts` — mock adapter
- [ ] Verify `test/commands/init.test.ts` — config output matches new format

---

## Phase 6: Reporting, Auto Mode, Polish

**Goal:** Complete the remaining functionality from the original Phase 7 (001 plan). Add `5x history`, `--auto` guardrails, terminal polish, and distribution build.

**Completion gate:** `bun build --compile` produces working binary. `5x history` displays run history. `--auto` runs without pausing for human gates unless escalation is triggered.

### 6.1 `5x history` command

`src/commands/history.ts`:

- [ ] `5x history [plan]` — lists recent runs with status, duration, phase count, cost (if tracked)
- [ ] `5x history [plan] --run <id>` — shows detailed event log for a specific run
- [ ] Reads from `run_events` and `agent_results` via `db/operations.ts`
- [ ] Table output: run ID (short), date, status, phases completed, duration
- [ ] Cost display: sum `cost_usd` from `agent_results` where not null; display as "~$X.XX" when available, omit when no cost data present (providers/models that do not report cost populate `NULL`)
- [ ] `--format json` flag for machine-readable output

### 6.2 `--auto` mode

Plumbing exists (DB schema has `auto` flag on runs) but human gate bypass is not implemented:

- [ ] `5x run --auto <plan>` — skips `phaseGate()` prompts between phases; only pauses on escalation
- [ ] First-run confirmation: if this is the first `--auto` run ever on this machine, print a one-time warning and require `--confirm` or stdin `y` before proceeding
- [ ] Running cost tally: after each phase, print estimated token cost if model supports it (display only, not blocking)
- [ ] Max iteration guardrail: configurable `maxAutoIterations` in config (default 10); abort if exceeded
- [ ] `--dry-run` flag: renders prompts and logs intended actions but does not invoke agents or modify files

### 6.3 Terminal polish

- [ ] Consistent color scheme: phase headers in bold, agent role labels dimmed, escalation warnings in yellow, errors in red
- [ ] Progress indicator during agent invocation (non-TTY safe: suppress spinner if `!process.stdout.isTTY`)
- [ ] Cleaner escalation UX: show structured verdict items with priority labels before the `c/a/q` prompt
- [ ] `--quiet` flag: suppress all agent output streaming (log to file only)

### 6.4 Structured logging

- [ ] `src/logger.ts`: thin wrapper over `console.error` to `stderr`, `console.log` to `stdout`
- [ ] All orchestrator and command output goes through logger (not raw `console.log`)
- [ ] `--log-level` flag (debug/info/warn/error) for verbosity control
- [ ] Debug mode logs DB operations, adapter calls, state transitions

### 6.5 Build + distribution

- [ ] `script/build.ts`: runs `bun build --compile src/bin.ts --outfile dist/5x`
- [ ] Verify compiled binary works: `./dist/5x status`, `./dist/5x --help`
- [ ] Add `build` script to `package.json`
- [ ] Verify config loading works in compiled binary (`import()` of `5x.config.js`)
- [ ] **Bun/compiled-binary SDK smoke test** (env-gated `FIVE_X_TEST_LIVE_AGENTS=1`): compile a minimal binary that imports `@opencode-ai/sdk` and performs one prompt call against a local managed server; assert no bundler/runtime errors. This validates end-to-end SDK compatibility before shipping.

### 6.6 Tests

- [ ] `test/commands/history.test.ts` — history display from seeded DB
- [ ] Integration test: `--dry-run` does not invoke adapter, exits 0

---

## Files

### To delete (Phase 1)

| File | Reason |
|------|--------|
| `src/agents/claude-code.ts` | Replaced by OpenCode SDK adapter |
| `test/agents/claude-code.test.ts` | Tests deleted module |
| `test/agents/claude-code-schema-probe.test.ts` | Live Claude Code probe |

### To rename (Phase 1)

| From | To | Reason |
|------|----|--------|
| `src/utils/ndjson-formatter.ts` | `src/utils/sse-formatter.ts` | Rename in place; Phase 3 updates internals for SSE event shapes. Rename (not delete) ensures there is always a formatter module. |
| `test/utils/ndjson-formatter.test.ts` | `test/utils/sse-formatter.test.ts` | Follows source rename |

### To delete (Phase 2)

| File | Reason |
|------|--------|
| `src/parsers/signals.ts` | Replaced by structured output; no text parsing needed |
| `test/parsers/signals.test.ts` | Tests deleted module |

### New files

| File | Phase | Description |
|------|-------|-------------|
| `src/protocol.ts` | 2 | `AuthorStatus`, `ReviewerVerdict` types + JSON schemas + routing invariant validators |
| `src/agents/opencode.ts` | 3 | OpenCode SDK adapter implementation (managed/local mode only) |
| `src/utils/audit.ts` | 4 | `appendStructuredAuditRecord()` — append structured results to review files |
| `src/commands/history.ts` | 6 | `5x history` command |
| `src/logger.ts` | 6 | Structured logging wrapper |
| `script/build.ts` | 6 | Bun compile script |
| `test/protocol.test.ts` | 2 | `assertAuthorStatus` / `assertReviewerVerdict` unit tests |
| `test/agents/opencode.test.ts` | 3 | OpenCode adapter tests |
| `test/utils/audit.test.ts` | 4 | Audit record append tests |
| `test/commands/history.test.ts` | 6 | History command tests |

### Modified files (significant changes)

| File | Phase | Change summary |
|------|-------|----------------|
| `src/agents/types.ts` | 1 | New `AgentAdapter` interface: `invokeForStatus`, `invokeForVerdict`, `verify`, `close` |
| `src/agents/factory.ts` | 1, 3 | Async factory, OpenCode only, no role parameter |
| `src/config.ts` | 1 | Remove `claude-code` adapter and `server` block; add `model` fields |
| `src/utils/sse-formatter.ts` | 1, 3 | Renamed from `ndjson-formatter.ts` (Phase 1); internals updated for SSE event shapes (Phase 3) |
| `test/utils/sse-formatter.test.ts` | 1, 3 | Renamed from `ndjson-formatter.test.ts` (Phase 1); tests updated for SSE (Phase 3) |
| `src/protocol.ts` | 2 | (new) — includes validators |
| `src/db/schema.ts` | 2 | Migration 002: `agent_results` redesigned with corrected step identity + tokens/cost columns |
| `src/db/operations.ts` | 2 | New `upsertAgentResult` with correct composite key; updated `getLatestVerdict`/`getLatestStatus` |
| `src/orchestrator/phase-execution-loop.ts` | 4 | Remove `PARSE_*` states; add invariant validators; audit record writes; quiet/logPath parity |
| `src/orchestrator/plan-review-loop.ts` | 4 | Remove `PARSE_*` states; add invariant validators; audit record writes |
| `src/utils/agent-event-helpers.ts` | 4 | Remove `makeOnEvent`, simplify `buildEscalationReason` |
| `src/templates/*.md` | 5 | Remove signal block instructions |
| `src/commands/plan.ts` | 5 | Async adapter lifecycle |
| `src/commands/run.ts` | 5 | Async adapter lifecycle; pass reviewer model via `InvokeOptions.model` |
| `src/commands/plan-review.ts` | 5 | Async adapter lifecycle |
| `src/commands/init.ts` | 1 | Update generated config; OpenCode-only, no remote server block |

### Unchanged files

| File | Notes |
|------|-------|
| `src/gates/quality.ts` | Agent-agnostic shell runner |
| `src/gates/human.ts` | Terminal prompts, no agent coupling |
| `src/parsers/plan.ts` | Parses plan markdown |
| `src/parsers/review.ts` | Parses review prose |
| `src/templates/loader.ts` | Template engine |
| `src/db/connection.ts` | SQLite singleton |
| `src/git.ts` | Git operations |
| `src/lock.ts` | Plan file locking |
| `src/paths.ts` | Path canonicalization |
| `src/project-root.ts` | Project root resolution |
| `src/commands/status.ts` | Read-only DB viewer |
| `src/commands/worktree.ts` | Worktree management |
| `src/utils/stream.ts` | `endStream()` still used for SSE log writes |
| `src/bin.ts` | CLI entry point (add `history` command) |
| `src/version.ts` | Version string |
