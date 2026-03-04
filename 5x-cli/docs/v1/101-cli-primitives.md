# 5x CLI v1 — CLI Primitives Specification

**Status:** Draft
**Date:** March 4, 2026
**Parent:** `100-architecture.md`

---

## 1. Overview

The CLI toolbelt exposes stateless primitives as standard CLI commands. Every command:

- Accepts structured input (flags, arguments, stdin)
- Returns JSON to stdout (unless `--format text` for human readability)
- Writes side effects to the SQLite database and/or filesystem
- Is independently callable — no implicit ordering or session state
- Exits with standard codes: 0 (success), 1 (error), 2 (usage error)

All JSON output follows a consistent envelope:

```json
{
  "ok": true,
  "data": { ... }
}
```

```json
{
  "ok": false,
  "error": { "code": "QUALITY_FAILED", "message": "2 of 3 gates failed", "detail": { ... } }
}
```

---

## 2. Command Taxonomy

| Group | Commands | Purpose |
|---|---|---|
| **Run lifecycle** | `run init`, `run state`, `run record`, `run list` | Create runs, query state, record steps |
| **Agent invocation** | `invoke author`, `invoke reviewer` | Invoke sub-agents via provider, return structured results |
| **Quality** | `quality run` | Execute quality gates |
| **Inspection** | `plan phases`, `diff` | Read plan structure, inspect git changes |
| **Worktree** | `worktree create`, `worktree remove`, `worktree list` | Git worktree isolation for runs |
| **Human interaction** | `prompt choose`, `prompt confirm`, `prompt input` | Present choices, confirmations, or collect input from the user |

---

## 3. Run Lifecycle

### `5x run init`

Create a new run for a plan.

```
5x run init --plan <path> [--command <name>] [--allow-dirty]
```

| Flag | Required | Description |
|---|---|---|
| `--plan` | Yes | Path to plan markdown file |
| `--command` | No | Workflow name (e.g., `plan-review`, `phase-execution`). Metadata only. |
| `--allow-dirty` | No | Skip dirty working tree check. Default: fail if uncommitted changes exist. |

**Returns:**

```json
{
  "ok": true,
  "data": {
    "run_id": "run_abc123",
    "plan_path": "docs/development/001-impl-feature.md",
    "status": "active",
    "created_at": "2026-03-04T10:00:00Z"
  }
}
```

**Behavior:**

- Checks for an existing active run for this plan. If found, returns it instead of creating a new one (idempotent).
- Checks for a clean git working tree. If dirty and `--allow-dirty` is not set, returns an error with `code: "DIRTY_WORKTREE"`. This preserves fail-safe behavior from v0.
- Canonicalizes the plan path for DB identity (worktree-safe).
- Does NOT acquire a lock — locking is a CLI-level concern if needed.

---

### `5x run state`

Query the current state of a run.

```
5x run state --run <id>
5x run state --plan <path>     # find active run for this plan
```

**Returns:**

```json
{
  "ok": true,
  "data": {
    "run_id": "run_abc123",
    "plan_path": "docs/development/001-impl-feature.md",
    "status": "active",
    "created_at": "2026-03-04T10:00:00Z",
    "steps": [
      {
        "id": 1,
        "step_name": "author:implement",
        "phase": "phase-1",
        "iteration": 1,
        "result": { "type": "status", "status": { "result": "complete", "commit": "abc123" } },
        "created_at": "2026-03-04T10:05:00Z"
      },
      {
        "id": 2,
        "step_name": "quality:check",
        "phase": "phase-1",
        "iteration": 1,
        "result": { "type": "quality", "passed": true, "results": [...] },
        "created_at": "2026-03-04T10:06:00Z"
      }
    ],
    "summary": {
      "total_steps": 2,
      "current_phase": "phase-1",
      "latest_step": "quality:check",
      "phases_completed": [],
      "cost_usd": 0.45,
      "tokens_total": 15000
    }
  }
}
```

**Behavior:**

- Returns ALL recorded steps for the run, ordered by creation time.
- The `summary` field provides a computed snapshot so the orchestrating agent doesn't need to compute it from raw steps.
- If `--plan` is used and no active run exists, returns `ok: true` with `data: null`.

---

### `5x run record`

Record a completed step. This is the primary persistence primitive.

```
5x run record <step-name> --run <id> --result '<json>' \
  [--phase <id>] [--iteration <n>]
```

| Arg/Flag | Required | Description |
|---|---|---|
| `step-name` | Yes | Step identifier (e.g., `author:implement`, `quality:check`, `reviewer:review`) |
| `--run` | Yes | Run ID |
| `--result` | Yes | Step result as JSON string |
| `--phase` | No | Phase identifier |
| `--iteration` | No | Iteration number within the phase (default: auto-increment) |

**Returns:**

```json
{
  "ok": true,
  "data": {
    "step_id": 3,
    "step_name": "reviewer:review",
    "phase": "phase-1",
    "iteration": 1,
    "recorded": true
  }
}
```

**Idempotency:**

The step is keyed by `(run_id, step_name, phase, iteration)`. If a record already exists for this key:

- Returns the existing record with `"recorded": false` (already existed)
- Does NOT overwrite the existing result
- The orchestrating agent can detect this via the `recorded` flag

This is the foundation of resumability. The orchestrating agent can re-attempt steps without worrying about duplication.

**Auto-increment iteration:**

If `--iteration` is omitted, the CLI computes `MAX(iteration) + 1` for the given `(run_id, step_name, phase)`. This simplifies the common pattern of recording successive attempts.

---

### `5x run complete`

Mark a run as completed or aborted.

```
5x run complete --run <id> [--status completed|aborted] [--reason <text>]
```

Defaults to `completed`. Records a terminal `run:complete` or `run:abort` step and updates the run status.

---

### `5x run reopen`

Re-activate a completed or aborted run for manual correction.

```
5x run reopen --run <id>
```

Sets the run status back to `active`. Records a `run:reopen` step with the previous status. This is an escape hatch for runs that ended in a bad state (e.g., aborted by a crash before all phases completed). Normal workflows should not need this.

---

### `5x run list`

List runs, optionally filtered.

```
5x run list [--plan <path>] [--status active|completed|aborted] [--limit <n>]
```

Returns an array of run summaries (same shape as `run state` but without the full step list).

---

## 4. Agent Invocation

### `5x invoke author`

Invoke the author sub-agent with a prompt template.

```
5x invoke author <template> --run <id> \
  [--var key=value ...] \
  [--model <model>] \
  [--workdir <path>] \
  [--session <id>] \
  [--timeout <seconds>]
```

| Arg/Flag | Required | Description |
|---|---|---|
| `template` | Yes | Full template name (e.g., `author-next-phase`, `author-process-impl-review`, `author-generate-plan`) |
| `--run` | Yes | Run ID (for logging and metadata) |
| `--var` | No | Template variable substitution (repeatable) |
| `--model` | No | Model override. Falls back to config `author.model`. |
| `--workdir` | No | Working directory for tool execution. Defaults to project root. |
| `--session` | No | Existing session ID to continue (for multi-turn interactions) |
| `--timeout` | No | Timeout in seconds. Falls back to config `author.timeout`. |

**Returns:**

```json
{
  "ok": true,
  "data": {
    "status": {
      "result": "complete",
      "commit": "abc1234",
      "notes": "Implemented the authentication module with JWT support."
    },
    "session_id": "sess_xyz",
    "model": "anthropic/claude-sonnet-4-6",
    "duration_ms": 45000,
    "tokens_in": 8500,
    "tokens_out": 3200,
    "cost_usd": 0.12,
    "log_path": ".5x/logs/run_abc123/agent-001.ndjson"
  }
}
```

**Template resolution:**

The `template` argument is the full template name (without `.md` extension). The CLI looks for `{template}.md` in the user override directory (`.5x/templates/prompts/`), then falls back to bundled templates. No role prefix is added — the template name is used as-is.

Bundled templates follow the naming convention `{role}-{action}` (e.g., `author-generate-plan`, `reviewer-plan`). When invoking, pass the full name:

```
5x invoke author author-generate-plan --run $RUN --var ...
5x invoke reviewer reviewer-plan --run $RUN --var ...
```

**Behavior:**

1. Resolves the template by name from user overrides (`.5x/templates/prompts/{template}.md`) or bundled defaults
2. Renders the template with provided variables
3. Instantiates the configured provider for the `author` role (or reuses a cached instance)
4. Calls `provider.startSession()` (or `resumeSession()` if `--session` provided)
5. Calls `session.run(prompt, { outputSchema: AuthorStatusSchema })` — provider handles tool execution and structured output extraction internally
6. Validates the AuthorStatus via `assertAuthorStatus()`
7. Returns the validated result with metadata

The structured output extraction method is provider-specific and handled internally:
- **Codex:** Native `outputSchema` parameter on `run()` — single call
- **OpenCode:** Two-phase (execute prompt, then summary prompt with `format: json_schema`)
- **Claude Agent:** Two-phase (first `query()` does work, second `query()` with `resume` extracts JSON)

The caller (`5x invoke`) does not know or care which method is used.

**Error cases:**

- Template not found: exit 2
- Provider failed to start session: exit 1 with error
- Agent invocation failed (timeout, network): exit 1 with error details
- Structured output validation failed: exit 1 with `code: "INVALID_STRUCTURED_OUTPUT"` and the raw response in `detail`

The CLI does NOT record the step — that's the orchestrating agent's responsibility via `5x run record`. This keeps `invoke` stateless and composable.

---

### `5x invoke reviewer`

Same interface as `invoke author`, but returns a ReviewerVerdict.

```
5x invoke reviewer <template> --run <id> \
  [--var key=value ...] \
  [--model <model>] \
  [--workdir <path>] \
  [--session <id>] \
  [--timeout <seconds>]
```

**Returns:**

```json
{
  "ok": true,
  "data": {
    "verdict": {
      "readiness": "ready_with_corrections",
      "items": [
        {
          "id": "P1.1",
          "title": "Missing error handling in auth middleware",
          "action": "auto_fix",
          "reason": "JWT verification errors are silently swallowed",
          "priority": "P0"
        }
      ],
      "summary": "Implementation is solid. One blocking issue with error handling."
    },
    "session_id": "sess_abc",
    "model": "anthropic/claude-sonnet-4-6",
    "duration_ms": 30000,
    "tokens_in": 12000,
    "tokens_out": 1500,
    "cost_usd": 0.08,
    "log_path": ".5x/logs/run_abc123/agent-002.ndjson"
  }
}
```

Validation uses `assertReviewerVerdict()`. Same error behavior as `invoke author`.

---

## 5. Quality Gates

### `5x quality run`

Execute configured quality gates.

```
5x quality run [--config <path>]
```

Reads `qualityGates` from config (array of shell commands). Executes each sequentially with a 5-minute timeout per command.

**Returns:**

```json
{
  "ok": true,
  "data": {
    "passed": false,
    "results": [
      { "command": "npm run typecheck", "passed": true, "duration_ms": 3200, "output": "..." },
      { "command": "npm test", "passed": false, "duration_ms": 15000, "output": "3 tests failed\n..." }
    ]
  }
}
```

The `output` field is bounded (last N bytes, same as v0). Full output written to log files.

---

## 6. Inspection

### `5x plan phases`

Parse a plan and return its phases.

```
5x plan phases <path>
```

**Returns:**

```json
{
  "ok": true,
  "data": {
    "phases": [
      { "id": "phase-1", "title": "Authentication Module", "done": true, "checklist_total": 5, "checklist_done": 5 },
      { "id": "phase-2", "title": "Authorization Layer", "done": false, "checklist_total": 4, "checklist_done": 1 },
      { "id": "phase-3", "title": "API Endpoints", "done": false, "checklist_total": 6, "checklist_done": 0 }
    ]
  }
}
```

### `5x diff`

Get a git diff relative to a reference.

```
5x diff [--since <ref>] [--stat]
```

| Flag | Description |
|---|---|
| `--since` | Git ref to diff against (commit, branch, tag). Default: HEAD~1. |
| `--stat` | Include diffstat summary. |

**Returns:**

```json
{
  "ok": true,
  "data": {
    "ref": "abc1234",
    "diff": "diff --git a/src/auth.ts b/src/auth.ts\n...",
    "stat": { "files_changed": 3, "insertions": 45, "deletions": 12 },
    "files": ["src/auth.ts", "src/middleware.ts", "test/auth.test.ts"]
  }
}
```

---

## 6a. Worktree Management

Git worktrees provide isolation — each run can work in a separate worktree so concurrent work doesn't conflict.

### `5x worktree create`

Create a git worktree for a plan.

```
5x worktree create --plan <path> [--branch <name>]
```

| Flag | Required | Description |
|---|---|---|
| `--plan` | Yes | Plan path (used to derive default branch name) |
| `--branch` | No | Branch name. Default: derived from plan filename. |

**Returns:**

```json
{
  "ok": true,
  "data": {
    "worktree_path": "/path/to/repo/.5x/worktrees/001-impl-feature",
    "branch": "5x/001-impl-feature",
    "created": true
  }
}
```

**Behavior:**

- Creates a new git worktree at `.5x/worktrees/<plan-slug>/` and checks out a new branch
- If the worktree already exists, returns it with `"created": false` (idempotent)
- Runs the `worktree.postCreate` hook from config (e.g., `npm install`) if configured
- Records the worktree path in the `plans` table

### `5x worktree remove`

Remove a worktree.

```
5x worktree remove --plan <path> [--force]
```

Removes the git worktree and cleans up the branch. `--force` removes even if the worktree has uncommitted changes.

### `5x worktree list`

List active worktrees.

```
5x worktree list
```

Returns an array of `{ plan_path, worktree_path, branch }` for all active worktrees.

---

## 7. Human Interaction

These commands present interactive prompts to the user (the human at the terminal, not the orchestrating agent). They block until the human responds.

### `5x prompt choose`

Present a multiple-choice prompt.

```
5x prompt choose <message> --options <a,b,c> [--default <a>]
```

**Returns:**

```json
{
  "ok": true,
  "data": {
    "choice": "continue"
  }
}
```

**Non-interactive behavior:**

If stdin is not a TTY, returns the `--default` value if provided. If no default, exits with code 1 and `"code": "NON_INTERACTIVE"`. This preserves fail-closed behavior from v0.

### `5x prompt confirm`

Present a yes/no confirmation.

```
5x prompt confirm <message> [--default yes|no]
```

**Returns:**

```json
{
  "ok": true,
  "data": {
    "confirmed": true
  }
}
```

### `5x prompt input`

Collect freeform text input from the human.

```
5x prompt input <message> [--multiline]
```

**Returns:**

```json
{
  "ok": true,
  "data": {
    "input": "Focus on the error handling in the auth middleware, the rest looks good."
  }
}
```

This replaces the "continue with guidance" escalation path from v0 — the orchestrating agent asks the human for input via this primitive and includes it in the next sub-agent invocation.

---

## 8. Provider Architecture

Agent invocation (`5x invoke`) delegates to a pluggable **provider** that handles session management, tool execution, and structured output extraction. The provider is configured per role in `5x.config.js`.

The full provider interface, v1 provider implementations (OpenCode, Codex, Claude Agent), provider taxonomy, and extensibility model are specified in `100-architecture.md`, Section 6.

**Key points for CLI consumers:**

- `5x invoke` is provider-agnostic — it calls the same interface regardless of backend
- Each `5x invoke` CLI invocation creates a provider instance, uses it, and closes it on exit
- Session state survives across invocations via provider-managed persistence (OpenCode: server sessions, Codex: thread IDs, Claude Agent: session files) — the `--session` flag passes the session ID
- No background server or daemon management at the CLI level — providers handle their own lifecycle
- Provider selection is per-role: author and reviewer can use different providers and models

---

## 9. Output and Monitoring

During `5x invoke`, the sub-agent may run for minutes — editing files, running commands, reading code. The CLI must stream progress to the console and persist a full log for debugging.

### 9.1 Normalized Event Stream

Providers emit native events in different formats. The CLI normalizes them into a common `AgentEvent` type before rendering or logging:

```typescript
type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; tool: string; input_summary: string }
  | { type: "tool_end"; tool: string; output: string; error?: boolean }
  | { type: "error"; message: string }
  | { type: "usage"; tokens: { in: number; out: number }; costUsd?: number }
  | { type: "done"; result: RunResult };
```

Each provider maps its native events to this type:

| Provider | Native format | Mapping |
|---|---|---|
| **OpenCode** | SSE events (`message.part.updated`, `message.part.delta`, etc.) | Direct mapping — event router from v0 is reused |
| **Codex** | JSONL events from `runStreamed()` (`item.completed`, `turn.completed`, etc.) | Map `item` events to tool_start/tool_end, text content to `text` |
| **Claude Agent** | Async iterable from `query()` (message objects with `type`, `subtype`, `result`) | Map message types to corresponding AgentEvents |

### 9.2 Console Output

`5x invoke` streams normalized events to the console by default. The renderer matches v0 behavior:

| Event type | Console rendering | Style |
|---|---|---|
| `text` | Streamed inline, word-wrapped at terminal width | Normal |
| `reasoning` | Streamed inline, **only if `--show-reasoning`** | Dim (ANSI) or `> ` prefix (no-color) |
| `tool_start` | One-liner summary: `bash: ls -la` | Dim |
| `tool_end` | Collapsed output, max 500 chars | Dim (errors: normal) |
| `error` | `! <error message>` | Normal (not dim) |
| `usage` | Suppressed | — |
| `done` | Suppressed | — |

**Tool input summaries** are tool-aware (carried forward from v0):
- `bash` / `Bash` → shows `command`
- `edit` / `Edit` / `file_edit` → shows file path
- `read` / `Read` → shows file path
- `glob` / `Glob` → shows pattern
- `grep` / `Grep` → shows pattern
- Unknown tools → shows `{key1, key2, ...}`

**Text rendering:**
- Word-wrapped at terminal width (`process.stdout.columns || 80`)
- Fenced code blocks (`` ``` ``) pass through verbatim, no wrapping
- Streamed character-by-character with word-boundary buffering

### 9.3 CLI Flags

| Flag | Default | Effect |
|---|---|---|
| `--quiet` | `false` (auto-`true` when stdout is not a TTY) | Suppresses all console output. NDJSON log is still written. |
| `--show-reasoning` | `false` | Shows reasoning/thinking tokens inline (dim). |

The `--quiet` flag can also be provided as a function in programmatic use, enabling mid-invocation toggling (e.g., when a TUI attaches or detaches).

### 9.4 NDJSON Log Files

Every `5x invoke` call writes a full NDJSON log regardless of `--quiet` or `--show-reasoning` settings.

**Path:** `.5x/logs/<run_id>/agent-<seq>.ndjson`

Where `<seq>` is a zero-padded sequential counter (001, 002, ...) per run, incremented on each `5x invoke` call. This is NOT the step table ID — it's a local file counter.

**Content:** One JSON object per line. ALL normalized events are written — text, reasoning, tool calls, tool output, usage, errors. Nothing is filtered.

**Security:** Log directory is created with `0o700` permissions. Logs may contain sensitive content (file contents, command output, API responses).

**Lifecycle:** Log stream opens at invocation start, appends events as they arrive, and closes on invocation completion or abort. Write errors are logged as warnings but never throw.

The log path is returned in the `5x invoke` response (`log_path` field) so the orchestrating agent can reference it for debugging or include it in escalation context.

### 9.5 Structured Output Phase

When structured output is being extracted (the second phase for OpenCode and Claude Agent providers), the CLI behavior depends on the provider:

- **Codex:** No separate phase — structured output is part of the single `run()` call. Console output streams continuously.
- **OpenCode / Claude Agent:** A follow-up prompt is sent in the same session. Console output for this phase is suppressed by default (it's just the agent producing JSON). The raw response is still written to the NDJSON log.

---

## 10. Idempotency Model

The idempotency model enables resumability without explicit resume logic.

### Step identity

Each step is uniquely identified by `(run_id, step_name, phase, iteration)`:

- `run_id` — the run this step belongs to
- `step_name` — what action was performed (e.g., `author:implement`, `quality:check`)
- `phase` — which plan phase (nullable for non-phase workflows like plan review)
- `iteration` — which attempt within the phase/step (1-indexed)

### Recording behavior

`5x run record` uses INSERT OR IGNORE semantics:

- If the key doesn't exist: insert the record, return `recorded: true`
- If the key exists: return the existing record, return `recorded: false`

### Auto-increment vs explicit iteration

There is a design tension between auto-increment convenience and idempotency guarantees:

- **Auto-increment** (`--iteration` omitted): computes `MAX(iteration) + 1`. Convenient for the common case (successive attempts). However, if the agent crashes after the step succeeds but before recording it, a retry creates a new iteration rather than deduplicating. The duplicate is benign — the agent reads the full history and uses the latest.
- **Explicit iteration** (`--iteration N`): full idempotency guarantee. Use this when the agent wants true at-most-once semantics for a specific attempt.

In practice, auto-increment is the default. The skill reads `run state` on resume and determines the correct next action from the history — duplicate steps don't cause incorrect behavior because the agent reasons over the full history, not individual records.

### Resume pattern

The orchestrating agent doesn't need special resume logic. On startup (or after any interruption), it:

1. Calls `5x run state` to see what's been done
2. Reads the step history to understand current position
3. Decides what to do next based on the last recorded step
4. Continues normally — if a step was already recorded, the agent sees it in the history and skips re-execution

### Concurrency

The CLI does not enforce single-writer semantics. If two agents work on the same plan:

- `5x run init` returns the same active run to both
- Concurrent `5x run record` calls are serialized by SQLite (WAL mode). No data corruption, but both agents may record interleaved steps for the same phase. The step history becomes a merge of both agents' actions.
- This is not a supported workflow. If concurrent execution is needed, use separate worktrees with separate plans.

### Correcting bad state

If a step was recorded with an incorrect result (e.g., the agent erroneously recorded success), the orchestrating agent or human can:

```
5x run record <step-name> --run <id> --phase <phase> --iteration <n+1> --result '<corrected>'
```

This records a new iteration rather than overwriting. The orchestrating agent sees both iterations in the step history and uses the latest.

---

## 11. Data Model

### Schema

```sql
-- Runs: top-level workflow execution
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,        -- e.g., "run_abc123"
  plan_path     TEXT NOT NULL,           -- canonicalized plan path
  command       TEXT,                    -- workflow name (metadata)
  status        TEXT NOT NULL DEFAULT 'active',  -- active|completed|aborted
  config_json   TEXT,                    -- snapshot of relevant config at run creation
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_runs_plan_status ON runs(plan_path, status);

-- Steps: ordered record of actions within a run
CREATE TABLE steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  step_name     TEXT NOT NULL,           -- e.g., "author:implement", "quality:check"
  phase         TEXT,                    -- phase identifier (nullable)
  iteration     INTEGER NOT NULL DEFAULT 1,
  result_json   TEXT NOT NULL,           -- step result as JSON
  -- Agent invocation metadata (populated for invoke steps)
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

-- Plans: plan metadata (carried forward from v0)
CREATE TABLE plans (
  plan_path     TEXT PRIMARY KEY,        -- canonicalized
  worktree_path TEXT,
  branch        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Key changes from v0

| v0 | v1 | Change |
|---|---|---|
| `agent_results` | `steps` | Unified — agent results are steps with agent metadata populated |
| `quality_results` | `steps` | Quality results recorded as steps with `step_name = "quality:check"` |
| `run_events` | `steps` | Events are steps — the step history IS the event journal |
| `phase_progress` | Computed from steps | Phase completion derived from steps where `step_name = "phase:complete"` |
| `runs.current_state` | Removed | No state enum — state is the step history |
| `runs.current_phase` | Computed from steps | Current phase derived from latest step |

The `runs` table no longer tracks mutable state (current_state, current_phase). All state is derived from the ordered step history. This eliminates the class of bugs where `runs` metadata diverges from actual step records.

### Step naming conventions

| Step name | Result shape | When recorded |
|---|---|---|
| `author:implement` | `{ type: "status", status: AuthorStatus }` | After author implements a phase |
| `author:fix-review` | `{ type: "status", status: AuthorStatus }` | After author fixes review items |
| `author:fix-quality` | `{ type: "status", status: AuthorStatus }` | After author fixes quality failures |
| `author:revise-plan` | `{ type: "status", status: AuthorStatus }` | After author revises plan |
| `author:generate-plan` | `{ type: "status", status: AuthorStatus }` | After author generates initial plan |
| `reviewer:review` | `{ type: "verdict", verdict: ReviewerVerdict }` | After reviewer reviews code/plan |
| `quality:check` | `{ type: "quality", passed: bool, results: [...] }` | After quality gates run |
| `phase:complete` | `{ type: "phase", phase: "<id>" }` | When a phase is approved |
| `human:gate` | `{ type: "human", choice: "<option>" }` | After human responds to a prompt |
| `run:complete` | `{ type: "terminal", status: "completed" }` | Run finished successfully |
| `run:abort` | `{ type: "terminal", status: "aborted", reason: "..." }` | Run aborted |

These are conventions, not enforced enums. The orchestrating agent (or skill) can record custom step names for workflow-specific actions.

---

## 12. Hard Constraints

The CLI enforces these regardless of what the orchestrating agent requests:

| Constraint | Enforcement point | Behavior |
|---|---|---|
| **Max steps per run** | `5x run record` | Rejects new steps after `maxStepsPerRun` total steps. Returns error. This is a global safety net independent of skill-level iteration limits (which are smaller and trigger escalation, not hard failure). |
| **Non-interactive safety** | `5x prompt *` | If stdin is not TTY and no default, exit 1. Never hang. |
| **Structured output validation** | `5x invoke *` | AuthorStatus/ReviewerVerdict must pass assertion. Invalid output returns error, not a fake result. |
| **Quality gate timeout** | `5x quality run` | 5-minute default per command. SIGTERM then SIGKILL. |
| **Provider cleanup** | Process exit | `provider.close()` called on CLI exit. Providers handle their own process/connection cleanup. |

These constraints are **not overridable by the skill or agent**. They are safety rails at the toolbelt level.

---

## 13. Configuration

v1 reuses the existing `5x.config.js` / `5x.config.mjs` format. The primary change is per-role provider configuration.

```javascript
export default {
  // Per-role provider + model configuration
  author: {
    provider: "claude-agent",               // "opencode" | "codex" | "claude-agent"
    model: "claude-sonnet-4-6",
    timeout: 300,
  },
  reviewer: {
    provider: "claude-agent",
    model: "claude-sonnet-4-6",
    timeout: 120,
  },

  // Unchanged from v0
  qualityGates: ["npm run typecheck", "npm test"],
  paths: {
    plans: "docs/development",
    reviews: "docs/development/reviews",
  },

  // v1 additions
  maxStepsPerRun: 50,         // hard limit on total steps (replaces maxAutoIterations)
};
```

**Provider-specific notes:**

- **`opencode`**: Model format is `provider/model` (e.g., `"anthropic/claude-sonnet-4-6"`). Requires OpenCode SDK.
- **`codex`**: Model format is OpenAI model name (e.g., `"o3"`). Requires `OPENAI_API_KEY` env var.
- **`claude-agent`**: Model format is Anthropic model name (e.g., `"claude-sonnet-4-6"`). Requires `ANTHROPIC_API_KEY` env var. Also supports Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`), Vertex AI (`CLAUDE_CODE_USE_VERTEX=1`), and Azure (`CLAUDE_CODE_USE_FOUNDRY=1`).

CLI flags override config values (same precedence as v0). `--author-provider`, `--reviewer-provider`, `--author-model`, `--reviewer-model` flags are available on `5x invoke`.
