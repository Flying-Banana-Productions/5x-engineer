# 5x CLI v1 — Architecture

**Status:** Draft
**Date:** March 4, 2026
**Supersedes:** `docs/000-technical-design-5x-cli.md` (v0 — scripted state machines)

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
                    │  Code, OpenCode, etc.) loaded with a   │
                    │  5x skill. Makes workflow decisions,   │
                    │  handles recovery, uses judgment.      │
                    └──────────────────┬────────────────────┘
                                       │ calls CLI commands
                    ┌──────────────────▼────────────────────┐
                    │  Layer 2: 5x CLI Toolbelt              │
                    │                                       │
                    │  Stateless primitives: invoke agents,  │
                    │  record steps, run quality gates,      │
                    │  query state. Handles persistence,     │
                    │  idempotency, sub-agent lifecycle.     │
                    └──────────────────┬────────────────────┘
                                       │ manages
                    ┌──────────────────▼────────────────────┐
                    │  Layer 1: Sub-Agents (Workers)         │
                    │                                       │
                    │  Author: implements code, fixes issues │
                    │  Reviewer: reviews plans and commits   │
                    │  Managed by CLI via provider interface. │
                    └───────────────────────────────────────┘
```

### Layer 3 — Orchestrating Agent + Skill

- Runs in the user's existing agent session (not managed by 5x)
- Loads a 5x skill document that describes the workflow pattern, invariants, and recovery heuristics (see `102-agent-skills.md`)
- Calls `5x` CLI commands as tools
- Makes judgment calls: interpreting results, deciding retries, escalating to the human
- Context is workflow state, not codebase — keeps context small and focused

### Layer 2 — 5x CLI Toolbelt

- Stateless commands that accept inputs and return JSON
- Manages all persistence (SQLite), logging, and sub-agent invocation
- Enforces hard constraints (not suggestions): max steps per run, required human gates, structured output validation
- Handles structured output extraction internally (provider-specific, transparent to callers)
- Each command is independently useful — no implicit ordering or required sequences
- Pluggable provider architecture for sub-agent invocation (see Section 6)
- Specified fully in `101-cli-primitives.md`

### Layer 1 — Sub-Agents (Workers)

- Author and reviewer agents invoked via `5x invoke`
- Run in isolated sessions managed by the configured **agent provider**
- Provider handles tool execution, session management, and process lifecycle internally
- Each invocation gets a fresh session (or explicit session continuation)
- Prompted via templates with variable substitution
- Return structured output (AuthorStatus / ReviewerVerdict) — validated by the CLI before returning to the orchestrator

---

## 4. Comparison to v0

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

## 5. Scope

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

## 6. Provider Architecture

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

### 6.1 Provider Interface

```typescript
interface AgentProvider {
  startSession(opts: SessionOptions): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  close(): Promise<void>;
}

interface AgentSession {
  readonly id: string;
  run(prompt: string, opts?: RunOptions): Promise<RunResult>;
  runStreamed(prompt: string, opts?: RunOptions): AsyncIterable<AgentEvent>;
}

interface SessionOptions {
  model: string;               // model identifier (provider-specific format)
  workingDirectory: string;    // cwd for tool execution (file edits, shell commands)
  systemPrompt?: string;       // system prompt / instructions
  timeout?: number;            // session-level timeout in seconds
}

interface RunOptions {
  outputSchema?: JSONSchema;   // structured output extraction
  signal?: AbortSignal;
  timeout?: number;
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

6 types, 4 methods. This is the entire abstraction between the CLI and any agent runtime. Each provider maps its native event format to `AgentEvent`; the CLI renders and logs normalized events without provider-specific knowledge. See `101-cli-primitives.md`, Section 9 for the full output and monitoring specification.

### 6.2 v1 Providers

**OpenCode** — via OpenCode SDK, in-process.

- `startSession` → `client.session.create()`
- `run()` → `client.session.prompt()` (streams SSE, waits for completion)
- Structured output: two-phase (second prompt with `format: { type: "json_schema" }`)
- Session resume via session ID
- Process lifecycle: SDK manages internally (no external server at the 5x level)

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

### 6.3 Provider Comparison

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

### 6.4 Provider Lifecycle

No background server management at the 5x level. Each provider handles its own lifecycle:

- **OpenCode:** SDK manages connection to server internally
- **Codex:** SDK spawns CLI child process, manages via stdin/stdout JSONL
- **Claude Agent:** Fully in-process, HTTP calls to Anthropic API

Each `5x invoke` CLI invocation instantiates the provider, uses it for the single agent call, and closes it on exit. No PID files, no daemons, no idle timeouts. If 5x is used as a library (in-process), the caller may cache and reuse provider instances across multiple invocations.

### 6.5 Per-Role Configuration

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

Or same provider for both:

```javascript
export default {
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

### 6.6 Provider Taxonomy and Future Extensibility

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

**Gemini path:** Use a Category 1 provider that supports Gemini models (e.g., OpenCode with Gemini routing). A native Gemini provider via the Google GenAI Interactions API would be Category 3 — viable but requires the built-in tool set. If Google ships a coding agent SDK (their equivalent of Codex), it becomes a Category 1 adapter.

---

## 7. Migration Strategy

**Parallel implementation.** v1 is built alongside v0 code:

1. v1 takes over the `5x run` namespace with subcommands (`run init`, `run state`, `run record`, etc.). v0's `5x run <plan>` is renamed to `5x exec <plan>` and deprecated.
2. New v1 commands (`5x invoke`, `5x prompt`, `5x worktree`) are added under the `5x` binary
3. Existing v0 commands (`5x plan`, `5x plan-review`) continue working unchanged alongside v1 commands
4. Skills are standalone markdown files — no code dependency on v0
5. Shared infrastructure (templates, plan parser, quality gates, config, protocol) is reused, not forked
6. Once v1 skills are validated, v0 orchestrator loops (`5x exec`, `5x plan`, `5x plan-review`) are deprecated and removed

**What can be reused directly:**

- `src/protocol.ts` — AuthorStatus, ReviewerVerdict, schemas, assertions
- `src/templates/` — all prompt templates and the loader
- `src/gates/quality.ts` — quality gate runner
- `src/parsers/plan.ts` — plan parser
- `src/config.ts` — config schema and loader
- `src/paths.ts` — path canonicalization
- `src/db/` — migrations framework (schema will be revised)

**What gets replaced:**

- `src/orchestrator/plan-review-loop.ts`
- `src/orchestrator/phase-execution-loop.ts`
- `src/commands/run.ts` (the orchestration wiring, not the CLI flags)
- `src/commands/plan-review.ts` (same)
- `src/gates/human.ts` (replaced by `5x prompt` commands)
