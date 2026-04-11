# 5x CLI v1 — Architecture

**Status:** Draft — Not Implemented
**Date:** March 4, 2026
**Supersedes:** `docs/000-technical-design-5x-cli.md` (upon implementation — v0 doc remains authoritative until v1 ships)

---

## 1. Motivation

The v0 architecture orchestrates author/reviewer workflows via imperative state machines — TypeScript `while`/`switch` loops with explicit state enums and hand-coded transitions. This works for the happy path but has proven brittle in practice:

- **Edge case accumulation.** Every unexpected agent behavior requires a new state, branch, or guard. The transition space grows combinatorially.
- **Semantic failures are invisible.** The state machine can validate structure (valid JSON, required fields) but cannot assess quality (did the author actually address the review feedback? did context loss from compaction degrade the output?).
- **Duplication across workflows.** Plan review and phase execution share patterns (invoke, route verdict, escalate) but are implemented as separate ~400-line loops with duplicated logic.
- **Rigid composition.** New workflow types (quick-fix, refactor, debug) would each require a new state machine.

The core insight: a human with good tools can self-orchestrate the 5x workflow by reading state, invoking agents, checking results, and making judgment calls. An agent with the same tools and a skill document describing the workflow can do the same — with the advantage of handling novel situations through reasoning rather than pre-coded branches.

---

## 2. Design Philosophy

### 2.1 Invariants over transitions

v0 codes **transitions** — "if the verdict is `ready_with_corrections` and all items are `auto_fix`, go to AUTO_FIX state." This requires enumerating every possible outcome.

v1 codes **invariants** — "after the author claims `complete`, a non-empty commit must exist." The CLI checks the invariant. If it holds, move forward. If it doesn't, the orchestrating agent decides how to recover. New failure modes don't require new code — they require the agent to reason about an invariant violation.

### 2.2 CLI as toolbelt, not brain

The CLI provides **primitives** — invoke agents, record steps, run quality gates, query state. It does not decide what to do next. Orchestration intelligence lives in the agent's skill, not in TypeScript control flow.

### 2.3 Idempotent steps for resumability

Every meaningful action is recorded as a step in the database. Steps are keyed by `(run_id, phase, step_name, iteration)`. Recording an already-completed step returns the existing result. This enables resumability without explicit resume logic — the orchestrating agent reads the run state and picks up where things left off.

### 2.4 Agent-agnostic primitives

The CLI primitives are standard CLI commands returning JSON. They can be called by:

- A human in a terminal
- A shell script
- An agent via tool use (Claude Code, OpenCode, etc.)
- A CI pipeline

The orchestration skill is separate from the toolbelt. Different agents can use the same CLI with different skills (or no skill at all for manual use).

---

## 3. Three-Layer Model

```
                    ┌───────────────────────────────────────┐
                    │  Layer 3: Orchestrating Agent + Skill  │
                    │                                       │
                    │  The user's own agent session (Claude  │
                    │  Code, OpenCode 5x-orchestrator, etc.) │
                    │  loaded with a 5x skill. Makes workflow│
                    │  decisions, handles recovery, judgment. │
                    └──────────────────┬────────────────────┘
                                       │ calls CLI commands
                    ┌──────────────────▼────────────────────┐
                    │  Layer 2: 5x CLI Toolbelt              │
                    │                                       │
                    │  Stateless primitives: render prompts, │
                    │  validate results, invoke agents,      │
                    │  record steps, run quality gates,      │
                    │  query state. Handles persistence,     │
                    │  idempotency, sub-agent lifecycle.     │
                    └──────────────────┬────────────────────┘
                                       │ native subagents (preferred)
                                       │ or 5x invoke (fallback)
                    ┌──────────────────▼────────────────────┐
                    │  Layer 1: Sub-Agents (Workers)         │
                    │                                       │
                    │  Preferred: native harness subagents   │
                    │   (5x-plan-author, 5x-code-author,     │
                    │    5x-reviewer) — visible in TUI       │
                    │  Fallback: 5x invoke via provider      │
                    │   (OpenCode provider ships by default) │
                    └───────────────────────────────────────┘
```

### Layer 3 — Orchestrating Agent + Skill

- Runs in the user's existing agent session (not managed by 5x)
- Loads a 5x skill document that describes the workflow pattern, invariants, and recovery heuristics (see `102-agent-skills.md`)
- Calls `5x` CLI commands as tools
- Makes judgment calls: interpreting results, deciding retries, escalating to the human
- Context is workflow state, not codebase — keeps context small and focused

### Layer 2 — 5x CLI Toolbelt

- Stateless commands that accept inputs and return JSON envelopes by default
- Dual output format: `--json` (default) for machine consumption, `--text` for human-readable output (see Section 4a)
- Manages all persistence (SQLite), logging, and sub-agent invocation
- Enforces hard constraints (not suggestions): max steps per run, required human gates, structured output validation
- Handles structured output extraction internally (provider-specific, transparent to callers)
- Each command is independently useful — no implicit ordering or required sequences
- Pluggable provider architecture for sub-agent invocation (see Section 7)
- Specified fully in `101-cli-primitives.md`

Key primitives for native subagent orchestration:

- **`5x template render`** — renders a task prompt with run/worktree context, continued-template selection, and variable injection. Returns a `outputSuccess()` envelope with the rendered prompt, declared variables, and (when `--run` is passed) resolved `run_id`, `plan_path`, and `worktree_root`. Appends a `## Context` block with the effective working directory when a worktree is resolved. `--session/--new-session` here are CLI continuity controls (template selection + continuity validation), not native subagent reuse ids.
- **`5x protocol validate`** — validates `AuthorStatus` or `ReviewerVerdict` JSON from stdin or `--input`. Auto-detects raw native subagent output vs `outputSuccess()` envelope from `5x invoke`. With `--record`, records the validated result as a run step (one-command validation and recording).
- **`5x invoke`** — fallback transport: invokes a sub-agent via provider, validates structured output, optionally records. Remains fully supported; skills fall back to it automatically when native agents are not installed.

Session terminology is intentionally split:
- Native subagent continuity id (harness-specific): OpenCode `task_id`, Cursor `resume`.
- Provider session continuity id (invoke mode): `session_id`, passed back via `--session`.
- CLI template continuity control: `5x template render --session/--new-session`.

### Layer 1 — Sub-Agents (Workers)

**Preferred path — native harness subagents:**

- Author and reviewer agents run as native child sessions in the harness (e.g., OpenCode `5x-plan-author`, `5x-code-author`, `5x-reviewer`)
- Orchestrating agent calls `5x template render` to produce the task prompt, then launches the native subagent with that prompt
- Orchestrating agent calls `5x protocol validate --record` to validate and record structured output
- Native sessions are visible in the harness TUI as first-class child sessions
- Install native agent profiles with `5x init opencode project` or `5x init opencode user`

**Fallback path — `5x invoke` via provider:**

- Author and reviewer agents invoked via `5x invoke` when native subagents are not installed
- Run in isolated sessions managed by the configured **agent provider**
- Provider handles tool execution, session management, and process lifecycle internally
- Each invocation gets a fresh session (or explicit session continuation)
- Prompted via templates with variable substitution
- Return structured output (AuthorStatus / ReviewerVerdict) — validated by the CLI before returning to the orchestrator

---

## 4. Native-First Subagent Orchestration

Skills prefer native subagents over `5x invoke` when the harness exposes both.
The detection order is:

1. **Project scope:** `.opencode/agents/<name>.md`
2. **User scope:** `~/.config/opencode/agents/<name>.md`
3. **Fallback:** `5x invoke`

Skills check project scope first, then user scope. If neither file exists, the
skill falls back to `5x invoke`. This order is documented in skill prose so the
orchestrating agent follows it consistently.

### Canonical Delegation Pattern

```bash
# 1. Render the prompt
RENDERED=$(5x template render reviewer-plan --run $RUN \
  --var plan_path=$PLAN_PATH --var review_path=$REVIEW_PATH)
PROMPT=$(echo "$RENDERED" | jq -r '.data.prompt')
STEP=$(echo "$RENDERED" | jq -r '.data.step_name')

# 2. Detect native agent
if [[ -f ".opencode/agents/5x-reviewer.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-reviewer.md" ]]; then
  RESULT=<native subagent result JSON>
else
  # Fallback: omit --record so validate is the single recording point
  RESULT=$(5x invoke reviewer reviewer-plan --run $RUN ... 2>/dev/null)
fi

# 3. Validate + record (universal for both paths)
echo "$RESULT" | 5x protocol validate reviewer \
  --run $RUN --record --step $STEP --phase $PHASE --iteration $ITERATION
```

### OpenCode Harness Support

OpenCode is the first supported harness with a native installer. Four agent
profiles are bundled:

| Agent | Mode | Role |
|---|---|---|
| `5x-orchestrator` | primary | Loads skills, delegates to subagents, guides human |
| `5x-plan-author` | subagent | Generates and revises implementation plans |
| `5x-code-author` | subagent | Implements code changes from approved plans |
| `5x-reviewer` | subagent | Performs quality review and produces structured verdicts |

Install with:

```bash
5x init opencode project   # .opencode/skills/ + .opencode/agents/
5x init opencode user      # ~/.config/opencode/skills/ + ~/.config/opencode/agents/
```

> **Path note:** OpenCode uses `~/.config/opencode/` (XDG-style) for user-scope
> assets, **not** `~/.opencode/`. The `user` scope installer writes to the
> correct path automatically. Do not use `~/.opencode/` — OpenCode will not
> discover assets there.

---

## 4a. Output Format System

The CLI supports two output formats: JSON envelopes (default) and human-readable text. The format is controlled globally — no per-command flags.

### Format selection

| Mechanism | Priority | Example |
|---|---|---|
| `--text` / `--json` flag | Highest (last flag wins) | `5x --text run list`, `5x run list --json` |
| `FIVEX_OUTPUT_FORMAT` env var | Medium | `export FIVEX_OUTPUT_FORMAT=text` |
| Default | Lowest | `json` |

JSON is the default to ensure deterministic pipe-chain composition. Output format is explicit, not TTY-detected.

### Formatter tiers

| Tier | Description | Examples |
|---|---|---|
| **Custom** | Hand-written formatters for complex data shapes | `diff` (raw diff text), `run state` (step table), `run list` (column table), `plan phases` (checklist) |
| **Generic fallback** | Built-in key-value renderer for simple data | `run complete`, `run reopen`, `skills install`, `prompt choose` |
| **Grandfathered** | Commands that always produce text, outside the format system | `init`, `upgrade`, `harness install`, `run watch` |

Custom formatters are co-located with their handlers. The generic fallback renders aligned key-value pairs with nested indentation, handling arrays and nested objects. Commands without a custom formatter automatically get the generic fallback in `--text` mode.

### Error handling

In JSON mode, errors are JSON envelopes on stdout. In text mode, errors produce a single `Error: <message>` line on stderr. Commander's built-in parse-error output (help text, suggestions) is suppressed in text mode to prevent duplicate or contract-breaking output.

### Implementation

Flags are stripped from `process.argv` before Commander parses, using the same pre-parse mechanism as `--pretty`/`--no-pretty`. The `outputSuccess()` function accepts an optional text formatter — when format is `text`, it calls the formatter (or the generic fallback) instead of writing a JSON envelope.

---

## 5. Comparison to v0

| Aspect | v0 (current) | v1 (proposed) |
|---|---|---|
| **Orchestration logic** | TypeScript state machines (~400 LOC each) | Agent skill (~40 lines of natural language) |
| **Edge case handling** | New code per edge case | Agent reasoning + recovery heuristics in skill |
| **Workflow types** | Separate loop per type | Separate skill per type, shared CLI |
| **Resume** | DB state + `hasCompletedStep()` checks at every step | Idempotent steps + `5x run state` query |
| **Human interaction** | Injected gate functions | `5x prompt` commands called by orchestrating agent |
| **Semantic validation** | None (structural only) | Orchestrating agent can assess quality of results |
| **Sub-agent lifecycle** | Managed by orchestrator loop | Managed by CLI via pluggable providers |
| **Customization** | Config file (limited) | Custom skills, custom scripts, or manual CLI use |

### What's preserved from v0

- **Structured protocol.** `AuthorStatus` and `ReviewerVerdict` remain the contract between sub-agents and the orchestrator. JSON schemas, validation, invariant assertions — all carry forward.
- **Template-driven prompts.** The template engine (YAML frontmatter + variable substitution + user overrides) is unchanged.
- **Quality gates.** Subprocess execution with bounded output capture. Same config format.
- **SQLite as SOT.** Persistence model stays SQLite-based, schema revised.
- **Plan parsing.** Markdown plan parser for phase extraction.
- **Git safety.** Dirty worktree checks, worktree isolation.

### What changes

- **No more orchestrator loops.** `plan-review-loop.ts` and `phase-execution-loop.ts` are replaced by skills + CLI primitives.
- **CLI becomes the primary interface.** Commands are designed for external callers (agents, scripts, humans), not just internal use by an orchestrator.
- **Pluggable provider architecture.** Sub-agent invocation is abstracted behind a provider interface. v1 ships with OpenCode, Codex, and Claude Agent SDK providers. No background server management at the 5x level — providers handle their own process lifecycle.
- **DB schema simplified.** Unified `steps` table replaces `agent_results` + `quality_results` + `run_events`.

---

## 6. Scope

### In scope for v1

Three core skills that cover the existing v0 functionality (specified fully in `102-agent-skills.md`):

| Skill | Replaces | Purpose |
|---|---|---|
| `5x-plan` | `5x plan` command + plan-review loop | Generate a plan from a PRD/TDD, then optionally run review/fix cycles |
| `5x-plan-review` | `5x plan-review` command | Review an existing plan with iterative fix cycles |
| `5x-phase-execution` | `5x run` command | Execute plan phases with author/quality/reviewer loops |

The full CLI toolbelt to support these skills (specified fully in `101-cli-primitives.md`): run lifecycle, agent invocation, quality gates, plan inspection, worktree management, human interaction.

### Not in scope

- Web UI / dashboard (separate initiative)
- Multi-repo orchestration
- Remote/multi-user service
- New workflow types beyond the three above (but architecture supports them)
- Automated skill selection (user explicitly loads a skill)

---

## 7. Provider Architecture

Sub-agent invocation is abstracted behind a provider interface. The CLI doesn't know or care how agents execute work — it delegates to a configured provider. This decouples 5x from any single agent runtime.

```
┌─────────────────────────────────────────────────┐
│  5x invoke author/reviewer                      │
│  (renders template, calls provider, validates)  │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│  AgentProvider interface                        │
│                                                 │
│  startSession(opts) → AgentSession              │
│  resumeSession(id)  → AgentSession              │
│  close()                                        │
│                                                 │
│  AgentSession:                                  │
│    run(prompt, { outputSchema? }) → RunResult    │
│    runStreamed(prompt, opts) → AsyncIterable     │
└───────┬──────────┬──────────┬───────────────────┘
        │          │          │
   ┌────▼───┐ ┌───▼────┐ ┌───▼──────┐
   │OpenCode│ │ Codex  │ │  Claude  │  ...
   │Provider│ │Provider│ │  Agent   │
   └────┬───┘ └───┬────┘ └───┬──────┘
        │         │           │
   Uses SDK   Uses SDK    Uses SDK
   in-process  (wraps CLI)  in-process
```

### 7.1 Provider Interface

```typescript
interface AgentProvider {
  startSession(opts: SessionOptions): Promise<AgentSession>;
  resumeSession(sessionId: string, opts?: ResumeOptions): Promise<AgentSession>;
  close(): Promise<void>;
}

interface ResumeOptions {
  model?: string;              // model override for the resumed session
}

interface AgentSession {
  readonly id: string;
  run(prompt: string, opts?: RunOptions): Promise<RunResult>;
  runStreamed(prompt: string, opts?: RunOptions): AsyncIterable<AgentEvent>;
}

interface SessionOptions {
  model: string;               // model identifier (provider-specific format)
  workingDirectory: string;    // cwd for tool execution (file edits, shell commands)
}

interface RunOptions {
  outputSchema?: JSONSchema;   // structured output extraction
  signal?: AbortSignal;
  timeout?: number;            // per-run timeout in seconds
}

interface RunResult {
  text: string;                // final text response
  structured?: unknown;        // parsed JSON if outputSchema was provided
  sessionId: string;
  tokens: { in: number; out: number };
  costUsd?: number;
  durationMs: number;
}

type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; tool: string; input_summary: string }
  | { type: "tool_end"; tool: string; output: string; error?: boolean }
  | { type: "error"; message: string }
  | { type: "usage"; tokens: { in: number; out: number }; costUsd?: number }
  | { type: "done"; result: RunResult };
```

7 types, 4 methods. This is the entire abstraction between the CLI and any agent runtime. Each provider maps its native event format to `AgentEvent`; the CLI renders and logs normalized events without provider-specific knowledge. See `101-cli-primitives.md`, Section 9 for the full output and monitoring specification.

### 7.2 v1 Providers

**OpenCode** — via `@opencode-ai/sdk`, two modes.

The SDK provides two factory functions:

- **`createOpencode(opts?)`** — spawns an `opencode serve` process and returns `{ client, server }`. Default mode: each `5x invoke` starts a server on a random port, does work, and closes it on exit.
- **`createOpencodeClient({ baseUrl })`** — connects to an already-running server. Used when `opencode.url` is configured (see Per-Role Configuration below).

API mapping:

- `startSession` → `client.session.create({ directory, title })`
- `resumeSession` → `client.session.get({ sessionID })` (sessions persist on disk per-project — resume works across server restarts)
- `run()` → `client.session.prompt({ sessionID, parts, format? })` (blocks until completion)
- `runStreamed()` → `client.event.subscribe()` filtered by session ID (SSE stream)
- Structured output: two-phase (second `prompt()` with `format: { type: "json_schema" }`)
- Process lifecycle: in default mode, server is spawned per invocation and closed on exit. In external mode, the user manages the server. Session data persists to disk either way.

**Codex** — via `@openai/codex-sdk`, wraps Codex CLI process.

- `startSession` → `codex.startThread({ workingDirectory })`
- `run()` → `thread.run(prompt, { outputSchema })` — native structured output in a single call
- Session resume via `codex.resumeThread(id)`
- Process lifecycle: SDK spawns/manages CLI process internally

**Claude Agent** — via `@anthropic-ai/claude-agent-sdk`, in-process.

- `startSession` → captures `session_id` from `init` event during first `query()`
- `run()` → `query({ prompt, options: { allowedTools, resume } })`
- Structured output: two-phase (second `query()` in same session)
- Native subagent support, hooks, MCP, fine-grained permissions
- Process lifecycle: fully in-process, no external dependencies
- Auth: Anthropic API key, or Bedrock/Vertex AI/Azure credentials

### 7.3 Provider Comparison

| Capability | OpenCode | Codex | Claude Agent |
|---|---|---|---|
| **Structured output** | Two-phase | Native (`outputSchema`) | Two-phase |
| **Session resume** | Session ID | Thread ID | Session ID |
| **Streaming** | SSE over HTTP | Async iterable | Async iterable |
| **Subagents** | Not built-in | Not built-in | Native (Task tool) |
| **Hooks** | Not built-in | Not built-in | PreToolUse, PostToolUse, Stop, etc. |
| **MCP support** | Via config | Via config | Native (`mcpServers` option) |
| **Tool permissions** | Via config | Via config | Native (`allowedTools`) |
| **Models** | Any (via OpenCode routing) | OpenAI models | Anthropic (direct, Bedrock, Vertex, Azure) |
| **Process model** | SDK-managed | SDK wraps CLI process | In-process |

### 7.4 Provider Lifecycle

No background server management at the 5x level. Each provider handles its own lifecycle:

- **OpenCode:** Default mode spawns a server per invocation (`createOpencode({ port: 0 })`), closes on exit. External mode connects to user-managed server (`createOpencodeClient({ baseUrl })`). Sessions persist to disk per-project either way — resume works across server restarts.
- **Codex:** SDK spawns CLI child process, manages via stdin/stdout JSONL
- **Claude Agent:** Fully in-process, HTTP calls to Anthropic API

Each `5x invoke` CLI invocation instantiates the provider, uses it for the single agent call, and closes it on exit. No PID files, no daemons, no idle timeouts. If 5x is used as a library (in-process), the caller may cache and reuse provider instances across multiple invocations.

### 7.5 Per-Role Configuration

Different roles can use different providers and models:

```javascript
// 5x.config.js
export default {
  author: {
    provider: "codex",
    model: "o3",
  },
  reviewer: {
    provider: "claude-agent",
    model: "claude-sonnet-4-6",
  },
}
```

OpenCode with external server:

```javascript
export default {
  opencode: {
    url: "http://localhost:4096",     // connect to existing server (skip per-invocation spawn)
  },
  author: {
    provider: "opencode",
    model: "anthropic/claude-sonnet-4-6",
  },
  reviewer: {
    provider: "opencode",
    model: "anthropic/claude-sonnet-4-6",
  },
}
```

### 7.6 Provider Taxonomy and Future Extensibility

Providers fall into three categories. v1 implements Category 1 only.

**Category 1: Agent Runtime SDKs** (v1 — ship)

Thin adapters (~50-100 lines) over SDKs that handle tool execution internally:

- OpenCode SDK
- Codex SDK (`@openai/codex-sdk`)
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

**Category 2: Headless CLI Wrappers** (designed, not implemented)

Spawn a coding agent CLI in non-interactive mode, capture output. A base class is documented for future providers. Candidates: `claude -p`, `codex --non-interactive`, `aider --yes-always`, or any future agent CLI with headless support.

**Category 3: Model API + Built-in Tool Set** (deferred)

Direct model API calls (Anthropic SDK, Google GenAI, OpenAI SDK) with a 5x-managed tool execution loop and built-in tool set (read_file, write_file, edit_file, shell, etc.). This is the most universal but requires building a minimal agent harness. Deferred unless there is demand or a specific optimization opportunity.

### 7.7 Migration from v0 AgentAdapter

The current v0 agent interface (`AgentAdapter` in `src/agents/types.ts`) maps to the v1 provider interface as follows:

| v0 `AgentAdapter` | v1 `AgentProvider` / `AgentSession` | Notes |
|---|---|---|
| `invokeForStatus(opts)` | `session.run(prompt, { outputSchema: AuthorStatusSchema })` | Provider handles structured output extraction internally |
| `invokeForVerdict(opts)` | `session.run(prompt, { outputSchema: ReviewerVerdictSchema })` | Same |
| `InvokeOptions.logPath` | Managed by CLI (`5x invoke`), not passed to provider | Log path is determined by run ID + sequence counter |
| `InvokeOptions.quiet` / `showReasoning` | CLI-level rendering flags on `5x invoke` | Not provider concerns — provider emits all events, CLI filters for display |
| `InvokeOptions.sessionId` | `provider.resumeSession(sessionId, opts?)` | Explicit method with optional `ResumeOptions` (model override) |
| `InvokeOptions.trace` | Removed — replaced by `AgentEvent` stream | Provider emits normalized events, CLI handles logging |
| `verify()` | Implicit — provider validates connectivity on `startSession()` | No separate health check |
| `close()` | `provider.close()` | Same semantics |

The existing OpenCode adapter (`src/agents/opencode.ts`) becomes the first `AgentProvider` implementation. The SSE event router from v0 (`src/utils/event-router.ts`) is reused as the `AgentEvent` mapping layer for the OpenCode provider.

### 7.8 Logging Format

v1 writes **normalized `AgentEvent` NDJSON only**. Raw provider-native events are not persisted separately. Each provider maps its native events to `AgentEvent` before emission; the CLI logs what it receives. This ensures consistent log format across all providers and simplifies tooling that reads logs.

The v0 approach of logging raw OpenCode SSE events is replaced. Existing v0 log files remain readable but use a different format.

**Gemini path:** Use a Category 1 provider that supports Gemini models (e.g., OpenCode with Gemini routing). A native Gemini provider via the Google GenAI Interactions API would be Category 3 — viable but requires the built-in tool set. If Google ships a coding agent SDK (their equivalent of Codex), it becomes a Category 1 adapter.

---

## 8. Migration Strategy

**Clean break.** When v1 ships, v0 orchestrator commands are removed — no coexistence period:

1. v0 commands `5x run <plan>`, `5x plan`, `5x plan-review` are deleted. Their functionality is replaced by skills + v1 primitives.
2. v1 commands (`5x run init/state/record/...`, `5x invoke`, `5x prompt`, `5x worktree`, `5x quality run`, `5x diff`, `5x plan phases`) are the entire CLI surface.
3. Shared infrastructure (templates, plan parser, quality gates, config, protocol) is reused directly — not forked.
4. Skills are standalone markdown files with no code dependency on v0.
5. The v0 orchestrator loops, human gate functions, and their command wrappers are deleted from the codebase.

### Compatibility with current CLI

The v0 design doc (`docs/000-technical-design-5x-cli.md`) and its implementation remain authoritative until v1 is released. This table summarizes what exists today vs what v1 introduces:

| Component | Current (v0) | v1 Proposed | Implementation status |
|---|---|---|---|
| **Agent interface** | `AgentAdapter` with `invokeForStatus`/`invokeForVerdict` — OpenCode only | `AgentProvider`/`AgentSession` with `run`/`runStreamed` — OpenCode, Codex, Claude Agent | Not implemented |
| **DB schema** | `runs` + `run_events` + `agent_results` + `quality_results` + `phase_progress` (6 tables) | `runs` + `steps` + `plans` (3 tables, unified journal) | Not implemented |
| **Orchestration** | TypeScript state machines (`plan-review-loop.ts`, `phase-execution-loop.ts`) | Agent skills (markdown) + CLI primitives | Not implemented |
| **Commands** | `5x run <plan>`, `5x plan`, `5x plan-review`, `5x status` | `5x run init/state/record/...`, `5x invoke`, `5x prompt`, `5x quality run`, `5x diff` | Not implemented |
| **Worktree** | `5x worktree status/cleanup` + `5x run --worktree` flag | `5x worktree create/remove/list` | Partially exists (v0 has status/cleanup) |
| **Plan locking** | File-based plan locks (`.5x/locks/`) with stale detection | Preserved — `5x run init` acquires, `5x run complete` releases | Exists |
| **Protocol** | `AuthorStatus`, `ReviewerVerdict`, JSON schemas, assertions | Preserved unchanged | Exists |
| **Templates** | Template engine (YAML frontmatter + variable substitution + user overrides) | Preserved unchanged | Exists |
| **Quality gates** | Subprocess execution with bounded output capture | Preserved unchanged | Exists |
| **Plan parser** | Markdown parser, phase extraction, checklist tracking | Preserved unchanged | Exists |
| **Output/logging** | SSE event router, raw OpenCode events in NDJSON | Normalized `AgentEvent` NDJSON across all providers | Not implemented |

**What can be reused directly:**

- `src/protocol.ts` — AuthorStatus, ReviewerVerdict, schemas, assertions
- `src/templates/` — all prompt templates and the loader
- `src/gates/quality.ts` — quality gate runner
- `src/parsers/plan.ts` — plan parser
- `src/config.ts` — config schema and loader
- `src/paths.ts` — path canonicalization
- `src/db/` — migrations framework (schema will be revised)

**What gets deleted:**

- `src/orchestrator/plan-review-loop.ts` — replaced by `5x-plan-review` skill
- `src/orchestrator/phase-execution-loop.ts` — replaced by `5x-phase-execution` skill
- `src/commands/run.ts` — replaced by `5x run` subcommands + `5x invoke`
- `src/commands/plan.ts` — replaced by `5x-plan` skill + `5x invoke`
- `src/commands/plan-review.ts` — replaced by `5x-plan-review` skill + `5x invoke`
- `src/gates/human.ts` — replaced by `5x prompt` commands
- `src/agents/types.ts` (`AgentAdapter`) — replaced by `AgentProvider`/`AgentSession`
- `src/agents/opencode.ts` — rewritten as OpenCode provider
- `src/agents/factory.ts` — replaced by provider instantiation in `5x invoke`
