# Feature: Claude Code Provider Plugin

**Version:** 1.1
**Created:** April 10, 2026
**Status:** Draft
**Priority:** Medium — enables Claude Code as an alternative to OpenCode for `5x invoke`

## Problem

The only bundled provider is OpenCode. Users running Claude Code as their
primary coding agent cannot use `5x invoke author/reviewer` without an OpenCode
installation. A Claude Code provider plugin would let users set
`author.provider = "claude-code"` and delegate work to the `claude` CLI.

## Overview

Implement `@5x-ai/provider-claude-code` as an external provider plugin in
`packages/provider-claude-code/`. The provider spawns `claude -p` as a
subprocess (with a byte-length guard before spawn), streams NDJSON events from
stdout, and maps them to the `AgentEvent` contract.

Key architectural advantage: Claude Code's `--json-schema` flag provides
**single-phase** structured output. This eliminates the two-phase
prompt-then-summary approach in the OpenCode provider (~870 lines), making the
Claude Code provider significantly simpler (~400 lines estimated).

## Goals

- `5x invoke author author-code --run R1 --author-provider claude-code` works
  end-to-end.
- Streaming events (text, reasoning, tool_start/end, usage, done) map correctly
  to the `AgentEvent` contract.
- Structured output extraction via `--json-schema` produces valid
  `AuthorStatus` / `ReviewerVerdict` in the `RunResult.structured` field.
- Session continuity: first run creates a session, subsequent runs resume it.
- Resume correctness: `startSession()` first invocation uses `--session-id`,
  while `resumeSession(existingId)` first invocation uses `--resume` to avoid
  accidental session forks under `continuePhaseSessions`.
- Process lifecycle: subprocesses are reliably killed on timeout, cancellation,
  and `provider.close()`.
- Configuration via `[claude-code]` section in `5x.toml`.

## Non-Goals

- Harness plugin for Claude Code. This is a **provider** (runtime execution),
  not a harness (IDE setup). A Claude Code harness is a separate effort and
  already partially covered by the universal harness.
- Bundling the provider into the core binary. It follows the external plugin
  pattern (dynamic import of `@5x-ai/provider-claude-code`), same as a
  third-party provider would.
- Supporting Claude Code's `stream-json` input format or bidirectional
  streaming. The provider uses one-shot `-p` invocations.

## Design Decisions

### DD1: Subprocess invocation via `Bun.spawn`

Claude Code has no programmatic SDK — the CLI is the interface. Each
`session.run()` / `session.runStreamed()` call spawns a new `claude` process
with `-p <prompt>`. The process exits when the prompt completes. This is
simpler than OpenCode's managed-server model but means each run pays cold-start
cost.

The `cwd` option on `Bun.spawn` sets the working directory (not a CLI flag).
Stdin is set to `"ignore"` to prevent interactive prompts. Stdout is piped for
NDJSON parsing. Stderr is piped for error diagnostics.

Security/operational note: prompt text passed via `-p` is visible in process
argv to local process-inspection tools. Prompts must not assume secrecy.

### DD2: Single-phase structured output

Claude Code supports `--json-schema <schema>` natively. When provided, the
result JSON includes a `structured_output` field containing the validated
output. This replaces OpenCode's two-phase pattern (execute prompt → send
summary prompt with output format → poll for structured result → retry on
failure). The entire structured output machinery in `opencode.ts` lines
143-280 and 555-728 is unnecessary.

If the model fails schema validation, Claude Code returns an error result.
The provider maps this to an `AgentEvent.error`.

### DD3: Session management via CLI flags and first-invocation mode

Claude Code persists sessions to disk automatically. Session management maps
directly to CLI flags:

- **New session:** `--session-id <uuid>` — creates a session with a specific
  UUID. The provider generates the UUID via `crypto.randomUUID()`.
- **Resume session:** `--resume <uuid>` — resumes an existing session.

The session state must encode both `id` and `firstInvocationMode`:

- `startSession()` creates `firstInvocationMode = "session-id"`.
- `resumeSession(existingId)` creates `firstInvocationMode = "resume"`.

Each session also tracks `hasRun`. Effective flag selection:

- If `hasRun === false`, use `firstInvocationMode` (`--session-id` or
  `--resume` respectively).
- If `hasRun === true`, always use `--resume <id>`.

This prevents `resumeSession()` from spawning a new Claude session on first run
and preserves `continuePhaseSessions` continuity.

### DD4: Permission mode defaults to `--dangerously-skip-permissions`

When used as an automated provider for `5x invoke`, the agent needs full tool
access without interactive permission prompts. The provider defaults to
`--dangerously-skip-permissions`. Users can override this via
`[claude-code].permissionMode = "default"` if they want the standard
permission model.

### DD5: `--bare` is opt-in, not default

Using `--bare` skips CLAUDE.md auto-discovery, which contains valuable project
context for author/reviewer agents. The provider does NOT use `--bare` by
default. Users who want faster cold starts at the cost of losing project
context can enable it via `[claude-code].bare = true`.

### DD6: NDJSON event mapping strategy

With `--include-partial-messages`, Claude Code emits both streaming deltas
(`stream_event` with `content_block_delta`) and completed messages
(`assistant`, `user`). The mapping strategy:

- **Text streaming:** `stream_event` / `text_delta` → `AgentEvent.text`
- **Reasoning:** `stream_event` / `thinking_delta` → `AgentEvent.reasoning`
- **Tool starts:** `assistant` message with `tool_use` content blocks →
  `AgentEvent.tool_start` (uses complete input for summary)
- **Tool ends:** `user` message with `tool_result` → `AgentEvent.tool_end`
- **Result:** `result` line → `AgentEvent.usage` + `AgentEvent.done`

Tool correlation requires mapper state: pending tool calls are tracked by
`tool_use_id` so that `tool_end` events can reference the correct tool name.

### DD7: Prompt-size guard and deterministic over-limit behavior

Because the provider sends prompt text via argv (`-p <prompt>`), it must
enforce a byte-length safety limit before calling `Bun.spawn`.

- Add `MAX_PROMPT_BYTES` constant (provider-local, documented in code comment).
- Compute prompt size with `new TextEncoder().encode(prompt).length`.
- If above limit, do not spawn. Fail deterministically:
  - `run()` throws an explicit error type/message containing
    `{ actualBytes, maxBytes }`.
  - `runStreamed()` yields a single `AgentEvent.error` with the same structured
    message and exits without spawning.
- Unit tests include boundary coverage (`limit-1`, `limit`, `limit+1`) and
  multi-byte Unicode input to validate byte-based (not char-count) behavior.

## Configuration

```toml
[author]
provider = "claude-code"
model = "anthropic/claude-sonnet-4-6"

[claude-code]
# permissionMode = "dangerously-skip"   # default; or "default"
# bare = false                          # skip hooks/plugins/CLAUDE.md
# tools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]  # restrict tools
# maxBudgetUsd = 5.0                    # per-invocation cost limit
# systemPrompt = "..."                  # override system prompt
# appendSystemPrompt = "..."            # append to system prompt
# claudeBinary = "claude"               # path to claude binary
```

Model format: 5x uses `anthropic/claude-sonnet-4-6`. The provider strips the
`anthropic/` prefix since Claude Code accepts `claude-sonnet-4-6` or aliases
like `sonnet`.

## File Structure

```
packages/provider-claude-code/
  package.json                  # @5x-ai/provider-claude-code
  src/
    index.ts                    # ProviderPlugin default export
    provider.ts                 # ClaudeCodeProvider (AgentProvider impl)
    session.ts                  # ClaudeCodeSession (AgentSession impl)
    cli-args.ts                 # Pure function: context → CLI arg array
    prompt-guard.ts             # Byte-length guard + over-limit error helper
    event-mapper.ts             # NDJSON line → AgentEvent mapper (stateful)
    model.ts                    # Model string parser (strip anthropic/ prefix)
    types.ts                    # ClaudeCodeConfig interface

test/unit/providers/claude-code/
    model.test.ts
    cli-args.test.ts
    prompt-guard.test.ts
    event-mapper.test.ts
    session.test.ts
    provider.test.ts

test/integration/providers/
    claude-code.test.ts
    claude-code-live.test.ts    # env-gated capability/contract probe
```

## Phase 1: Pure Functions

**Completion gate:** `model.ts`, `cli-args.ts`, `prompt-guard.ts`, and
`event-mapper.ts` are implemented with full unit test coverage. No I/O or
subprocess spawning.

### 1.1 Package scaffold

- [x] Create `packages/provider-claude-code/package.json`:
      ```json
      {
        "name": "@5x-ai/provider-claude-code",
        "version": "0.0.1",
        "private": true,
        "type": "module",
        "exports": { ".": "./src/index.ts" },
        "peerDependencies": { "@5x-ai/5x-cli": "file:../.." }
      }
      ```
- [x] Add `"@5x-ai/provider-claude-code": "workspace:*"` to root
      `package.json` devDependencies.
- [x] Create `src/types.ts` with `ClaudeCodeConfig` interface.

### 1.2 Model parser (`src/model.ts`)

- [x] Implement `parseModelForClaudeCode(model: string): string`.
      Strip `anthropic/` prefix if present; pass through otherwise.
- [x] Unit tests: `"anthropic/claude-sonnet-4-6"` → `"claude-sonnet-4-6"`,
      `"sonnet"` → `"sonnet"`, `"claude-sonnet-4-6"` → passthrough,
      empty string, multiple slashes.

### 1.3 CLI arg builder (`src/cli-args.ts`)

- [x] Define `CliArgContext` interface capturing prompt, sessionId, isResume,
      model, outputFormat, jsonSchema, and config fields.
- [x] Implement `buildCliArgs(ctx: CliArgContext): string[]`. Mapping:
      - `-p <prompt>` always
      - `--session-id <id>` when `!isResume`, `--resume <id>` when `isResume`
      - `--model <model>` when model is set
      - `--output-format stream-json --verbose --include-partial-messages` for
        streaming; `--output-format json` for non-streaming
      - `--json-schema <serialized>` when jsonSchema is set
      - `--dangerously-skip-permissions` when permissionMode is
        `"dangerously-skip"` (default)
      - `--bare`, `--tools`, `--max-budget-usd`, `--system-prompt`,
        `--append-system-prompt` from config when set
- [x] Unit tests covering all flag combinations and edge cases (no model,
      resume vs new, streaming vs json, config options present/absent).

### 1.4 Prompt guard (`src/prompt-guard.ts`)

- [x] Define `MAX_PROMPT_BYTES` and `getPromptBytes(prompt: string): number`
      using `TextEncoder`.
- [x] Implement guard helper used by both `run()` and `runStreamed()` before
      spawn.
- [x] Standardize deterministic over-limit payload/message containing
      `actualBytes` and `maxBytes`.
- [x] Unit tests:
      - ASCII boundary: `limit-1`, `limit`, `limit+1`
      - Unicode boundary (multi-byte chars)
      - Message/error shape is stable for assertions

### 1.5 Event mapper (`src/event-mapper.ts`)

- [x] Define `ClaudeCodeMapperState` with `pendingTools: Map<string, string>`
      and `accumulatedText: string`.
- [x] Implement `createMapperState(): ClaudeCodeMapperState`.
- [x] Implement `mapNdjsonLine(line: Record<string, unknown>, state): AgentEvent | AgentEvent[] | undefined`.
      Event type mapping:
      - `system` (init) → `undefined`
      - `stream_event` / `text_delta` → `{ type: "text", delta }`
      - `stream_event` / `thinking_delta` → `{ type: "reasoning", delta }`
      - `assistant` with `tool_use` blocks → `{ type: "tool_start" }` per block;
        register tool_use_id → tool name in `pendingTools`
      - `user` with `tool_result` → `{ type: "tool_end" }`;
        look up tool name from `pendingTools` by tool_use_id
      - `result` (success) → `{ type: "done", result: RunResult }`
      - `result` (error) → `{ type: "error", message }`
      - `rate_limit_event` → `undefined`
- [x] Implement `summarizeToolInput(tool: string, input: Record<string, unknown>): string`
      for common tools (Read → file path, Write → file path, Edit → file path,
      Bash → command excerpt, Glob → pattern, Grep → pattern).
- [x] Unit tests:
      - Each event type maps correctly.
      - Tool correlation: tool_start registers pending, tool_end resolves it.
      - Multiple tool_use blocks in one assistant message → multiple events.
      - Error tool result → `error: true` on tool_end.
      - Result extracts tokens, cost, duration, structured_output correctly.
      - Unknown/malformed lines → `undefined`.

## Phase 2: Session and Provider

**Completion gate:** `ClaudeCodeSession` and `ClaudeCodeProvider` implement
the full `AgentProvider` / `AgentSession` contract. Unit tests with mocked
`Bun.spawn` verify lifecycle, streaming, structured output, timeout, and
cancellation.

### 2.1 NDJSON line reader (in `src/session.ts`)

- [ ] Implement `readNdjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>>`.
      Buffers partial lines, splits on newlines, parses JSON. Skips malformed
      lines silently.

### 2.2 Session (`src/session.ts`)

- [ ] `ClaudeCodeSession` implements `AgentSession`:
      - `readonly id: string`
      - `private firstInvocationMode: "session-id" | "resume"`
      - `private hasRun: boolean`
      - `private activeProcess` — ref for cleanup
      - `run(prompt, opts?)`: enforce prompt-byte guard before spawn; spawn
        with `--output-format json`, read stdout,
        parse JSON result, extract `RunResult` fields. When `opts.outputSchema`
        is set, pass `--json-schema` and extract `structured_output`.
      - `runStreamed(prompt, opts?)`: enforce prompt-byte guard before spawn;
        for over-limit prompt emit one deterministic `AgentEvent.error` and
        return. Otherwise spawn with `--output-format stream-json`, iterate
        NDJSON lines via `readNdjsonLines`, map via `mapNdjsonLine`, yield
        `AgentEvent`s. Yield `usage` before `done` (matches contract).
- [ ] Timeout handling: setTimeout → kill(SIGTERM) → 3s grace → kill(SIGKILL).
      Reset inactivity timer on each event for streaming.
- [ ] Cancellation: listen on `opts.signal`, kill subprocess on abort.
- [ ] Process exit without result line: yield error event with exit code.
- [ ] Binary not found (ENOENT): throw descriptive error with install hint.
- [ ] Unit tests (mock `Bun.spawn` to return fake process with piped stdout):
      - `run()` returns correct `RunResult` from mock JSON.
      - `run()` with `outputSchema` passes `--json-schema` and extracts
        `structured_output`.
      - `runStreamed()` yields events in correct order.
      - Timeout kills process and yields error.
      - `startSession()` path: first run uses `--session-id`, second uses
        `--resume`.
      - `resumeSession(existingId)` path: first run already uses `--resume`.
      - Over-limit prompt: no spawn occurs; `run()` throws deterministic error;
        `runStreamed()` emits deterministic error event.

### 2.3 Provider (`src/provider.ts`)

- [ ] `ClaudeCodeProvider` implements `AgentProvider`:
      - `startSession(opts)`: generate UUID, create session with
        `firstInvocationMode: "session-id"`, parse model via
        `parseModelForClaudeCode`.
      - `resumeSession(sessionId, opts?)`: create session with
        `firstInvocationMode: "resume"`. Return existing session if already
        tracked.
      - `close()`: kill all active subprocesses (SIGTERM → SIGKILL), clear
        session map. Idempotent.
- [ ] Unit tests: lifecycle, idempotent close, session tracking, and
      `continuePhaseSessions`-safe resume behavior (no first-run fork).

### 2.4 Plugin entry (`src/index.ts`)

- [ ] Default export: `ProviderPlugin` with `name: "claude-code"` and
      `create(config?)` that instantiates `ClaudeCodeProvider`.
- [ ] Parse `config` to `ClaudeCodeConfig` with defaults:
      `permissionMode: "dangerously-skip"`, `claudeBinary: "claude"`.

## Phase 3: Integration

**Completion gate:** Factory resolves `@5x-ai/provider-claude-code` via
dynamic import. Integration tests pass with a mock `claude` script, plus an
env-gated live capability/contract probe passes when Claude is available.

### 3.1 Workspace wiring

- [ ] Run `bun install` to link the new workspace package.
- [ ] Verify `import("@5x-ai/provider-claude-code")` resolves in the factory.

### 3.2 Integration tests (`test/integration/providers/claude-code.test.ts`)

- [ ] Create a mock `claude` bash script that outputs canned NDJSON for
      streaming and canned JSON for non-streaming. Script inspects args to
      determine which fixture to output (e.g., checks for `--json-schema`).
- [ ] Test full streaming lifecycle: create provider → startSession →
      runStreamed → collect events → verify text, tool, done events → close.
- [ ] Test structured output: runStreamed with outputSchema → verify
      `structured_output` in done event's `RunResult`.
- [ ] Test non-streaming: run() → verify RunResult fields.
- [ ] Test factory resolution: `createProvider("author", configWithClaudeCode)`
      resolves and returns a working provider.
- [ ] Test error case: mock script exits non-zero → error event / thrown error.

### 3.3 Env-gated live capability/contract probe (`test/integration/providers/claude-code-live.test.ts`)

- [ ] Add a live probe test that runs only when explicitly enabled (for
      example `CLAUDE_LIVE_TEST=1`) and when `claude` binary is available.
- [ ] Validate minimum required CLI capability (documented below):
      `--output-format stream-json`, `--include-partial-messages`,
      `--json-schema`, `--resume`, and `--session-id` support.
- [ ] Validate required response contract subset only (stable fields):
      - NDJSON stream emits `stream_event` deltas and terminal `result`
      - Result payload includes usage/cost fields used by provider mapping
      - Schema run exposes `structured_output` when `--json-schema` is passed
- [ ] Keep assertions intentionally narrow to detect upstream contract drift
      without overfitting on non-essential fields.

### 3.4 Existing test verification

- [ ] `bun test test/unit/providers/plugin-loading.test.ts` — existing plugin
      loading tests still pass.
- [ ] Full test suite passes: `bun test`.

## Verification

1. **Unit tests:** `bun test test/unit/providers/claude-code/`
2. **Integration tests:** `bun test test/integration/providers/claude-code.test.ts`
3. **Live probe (opt-in):**
   `CLAUDE_LIVE_TEST=1 bun test test/integration/providers/claude-code-live.test.ts`
4. **Regression:** `bun test` — full suite passes
5. **Manual smoke test:** With Claude Code installed:
   ```bash
   # Minimal 5x.toml override:
   # [author]
   # provider = "claude-code"
   5x invoke author author-code --run test-001 --author-provider claude-code
   ```

## Claude CLI compatibility baseline

Minimum supported Claude CLI is the first release that supports all required
provider capabilities together:

- `-p` prompt mode
- `--output-format stream-json`
- `--include-partial-messages`
- `--json-schema`
- `--session-id` and `--resume`

Implementation should enforce this via the env-gated live probe in CI/dev
profiles where Claude is available, and treat incompatible CLI behavior as a
provider compatibility failure.

## Revision History

- **v1.1 (2026-04-10):** Revised per
  `docs/development/reviews/5x-cli-docs-development-plans-021-claude-code-provider-review.md`.
  Added byte-based prompt-length guard + deterministic over-limit behavior,
  documented argv visibility limitations, clarified start vs resume first-run
  semantics to prevent session forking, added env-gated live contract probe and
  CLI capability baseline, and normalized `tool_result` naming.
