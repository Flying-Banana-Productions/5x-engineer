# Feature: Cursor Agent Provider Plugin

**Version:** 1.0
**Created:** May 22, 2026
**Status:** Draft
**Priority:** Medium — enables Cursor Agent as an external `5x invoke` provider

## Problem

`5x invoke` can already use the bundled OpenCode provider and the external
Claude Code provider package. Users who run Cursor Agent in headless mode cannot
select it with `author.provider = "cursor-agent"` or `reviewer.provider =
"cursor-agent"`.

Cursor Agent exposes a scriptable CLI (`agent`) with print mode,
`stream-json` events, session IDs, `--resume`, model selection, workspace
selection, and automation flags. A provider plugin should adapt those
capabilities to the existing `AgentProvider` / `AgentSession` contract.

## Research Summary

Sources checked:

- Cursor headless CLI docs: `https://cursor.com/docs/cli/headless`
- Cursor CLI usage docs: `https://cursor.com/docs/cli/using#non-interactive-mode`
- Cursor output format docs: `https://cursor.com/docs/cli/reference/output-format`
- Cursor authentication docs: `https://cursor.com/docs/cli/reference/authentication`
- Cursor ACP docs: `https://cursor.com/docs/cli/acp`
- Local CLI help: `agent --help`, `agent create-chat --help`

Relevant Cursor Agent capabilities:

- `agent -p` / `agent --print` runs non-interactively for scripts and CI.
- `--output-format text|json|stream-json` controls output in print mode.
- `--output-format stream-json` emits NDJSON with documented `system`, `user`,
  `assistant`, `tool_call`, and terminal `result` events.
- `--stream-partial-output` adds incremental assistant text deltas. Only
  assistant events with `timestamp_ms` present and `model_call_id` absent contain
  new text; pre-tool and final flushes are duplicates and must be skipped.
- Terminal `result` contains `duration_ms`, `duration_api_ms`, `is_error`,
  `result`, `session_id`, and optional `request_id`.
- Tool calls emit `tool_call` events with `subtype: "started" | "completed"`,
  `call_id`, and typed payloads such as `readToolCall` and `writeToolCall`.
- `--resume [chatId]` resumes an existing conversation. `agent create-chat`
  creates an empty chat and returns its ID.
- `--workspace <path>` sets the workspace directory.
- `--model <model>` selects the model.
- `--force` / `--yolo` allows direct file changes and command execution in
  headless scripts; `--trust` trusts the workspace in print/headless mode.
- Authentication supports browser login (`agent login`) and automation auth via
  `CURSOR_API_KEY` or `--api-key`.

Important limitations:

- The documented CLI has no native `--json-schema` equivalent. Structured
  `AuthorStatus` / `ReviewerVerdict` must be requested in the prompt and parsed
  from the final assistant output.
- `json` failure mode is not machine-readable: on failure the process exits
  non-zero and writes stderr, with no guaranteed JSON result object.
- `stream-json` terminal `result.result` is the concatenation of assistant text,
  not necessarily only the final answer. Structured extraction should prefer the
  last non-duplicate assistant message observed in the stream.
- Thinking/reasoning events are suppressed in print mode and should not be
  expected.

## Goals

- `5x invoke author author-code --run R1 --author-provider cursor-agent` works
  end-to-end.
- `5x invoke reviewer reviewer-review --run R1 --reviewer-provider cursor-agent`
  works end-to-end.
- The provider is implemented as `packages/provider-cursor-agent/`, matching the
  external plugin pattern used by `packages/provider-claude-code/`.
- Cursor `stream-json` events map to the canonical `AgentEvent` contract.
- `RunResult.structured` is populated when `RunOptions.outputSchema` is provided
  by parsing the final assistant JSON requested through prompt instructions.
- Cursor session continuity works via real Cursor `session_id` / chat IDs and
  `--resume`.
- Subprocesses are killed on timeout, cancellation, and `provider.close()`.
- Configuration is available through `[cursor-agent]` in `5x.toml`.

## Non-Goals

- Implementing a Cursor harness plugin or editor integration.
- Using Cursor ACP for the first provider version. ACP is better for custom
  clients and permission UX, but it introduces JSON-RPC session management and
  permission request handling that is not needed for the initial headless
  provider.
- Providing native schema validation in Cursor. The provider can only prompt for
  JSON and parse it unless Cursor adds a documented schema flag.
- Using Cursor's `--worktree`; 5x already resolves and passes the effective
  worktree/workspace via `SessionOptions.workingDirectory`.

## Design Decisions

### DD1: Provider name and package name

Use provider name `cursor-agent` and package name
`@5x-ai/provider-cursor-agent`.

Rationale:

- It matches the actual headless agent surface (`agent`) rather than the editor
  launcher (`cursor`).
- It avoids ambiguity with future Cursor-specific harness or editor features.
- It maps cleanly to existing dynamic import convention:
  `cursor-agent` → `@5x-ai/provider-cursor-agent`.

Configuration section name is `[cursor-agent]` because `getPluginConfig()` reads
the top-level config key matching the provider name.

### DD2: Spawn `agent -p --output-format stream-json`

Each `session.run()` / `session.runStreamed()` call spawns one Cursor Agent
process. The baseline argv is:

```bash
agent -p --output-format stream-json --stream-partial-output --trust --workspace <cwd> --resume <session-id> <prompt>
```

Add optional flags from config:

- `--model <model>` when configured.
- `--force` enabled by default provider-wide.
- `[cursor-agent].force = false` is the explicit escape hatch to disable force.
- `--sandbox enabled|disabled` when configured.
- `--approve-mcps` when configured.
- `--plugin-dir <path>` for each configured plugin directory.

Use `Bun.spawn` with `stdin: "ignore"`, `stdout: "pipe"`, and `stderr: "pipe"`.
Pass the workspace both as `cwd` and `--workspace` so Cursor's tool execution and
workspace trust match 5x's resolved worktree.

### DD3: Use `agent create-chat` for new sessions

`AgentSession.id` should be a real Cursor session/chat ID, not a synthetic UUID.
For `startSession(opts)`, run `agent create-chat` once, trim stdout, and use the
returned chat ID as the session ID. The first prompt then uses
`--resume <chat-id>` against that empty chat.

For `resumeSession(sessionId, opts)`, construct a session around the supplied ID
and use `--resume <sessionId>` for every run.

If `create-chat` is unavailable or returns an empty/non-string value, fail with a
clear provider error that includes the binary and install/auth hint.

### DD4: Structured output via prompt wrapping

Cursor Agent does not document a JSON Schema CLI flag. When `RunOptions.outputSchema`
is provided, the provider wraps the prompt with a strict final-response contract:

- The agent may use tools and edit files normally.
- The final assistant message must be exactly one JSON object.
- The object must satisfy the supplied JSON Schema.
- No markdown fences, prose, or extra text are allowed in the final message.

During streaming, the event mapper tracks the latest assistant text segment that
is not a duplicate partial flush. On the terminal `result`, parse structured
output from that final assistant segment first, then fall back to the terminal
`result.result` text. Use a tolerant extractor that accepts exact JSON and, as a
fallback, one fenced JSON block. If parsing fails, leave `structured` undefined;
the existing invoke validation path will emit `STRUCTURED_OUTPUT_INVALID` with
the provider text/log available for debugging.

This is intentionally less strong than Claude Code's `--json-schema`, but it is
the only documented Cursor headless path today.

### DD5: Event mapping follows documented Cursor `stream-json`

Map Cursor NDJSON to `AgentEvent` as follows:

| Cursor event | Canonical event |
| --- | --- |
| `system` / `subtype: "init"` | store session/model metadata; no emitted event |
| `user` | no emitted event |
| `assistant` partial delta (`timestamp_ms` present, `model_call_id` absent) | `{ type: "text", delta }` |
| `assistant` pre-tool flush (`timestamp_ms` and `model_call_id` present) | skip duplicate |
| `assistant` final flush with no partial fields | skip if partial mode is enabled; otherwise emit text segment |
| `tool_call` / `subtype: "started"` | `{ type: "tool_start", tool, input_summary }` |
| `tool_call` / `subtype: "completed"` | `{ type: "tool_end", tool, output, error? }` |
| `result` success | `{ type: "usage", ... }` then `{ type: "done", result }` |

Token counts and cost are not documented in Cursor `result` events. Return
`tokens: { in: 0, out: 0 }` and omit `costUsd` unless future events expose them.

### DD6: Tool names and summaries are best-effort

Cursor typed tool calls use keys such as `readToolCall` and `writeToolCall`.
Normalize names by removing a trailing `ToolCall` and lowercasing the first word
(`readToolCall` → `read`, `writeToolCall` → `write`). For generic function tool
calls, use `tool_call.function.name` when present.

Summaries:

- File tools: use `args.path` when present.
- Shell/function tools: use command/name/arguments excerpts.
- Unknown typed tools: JSON-stringify `args`, truncated for readability.

Track `call_id` → tool name so completion events can reference the started tool.

### DD7: Authentication uses environment variables, not argv secrets

Default behavior preserves the user's existing Cursor login state and ambient
environment. If `[cursor-agent].apiKey` is configured, inject it into the child
environment as `CURSOR_API_KEY`; do not pass it with `--api-key` because argv is
visible to local process inspection.

Support optional `[cursor-agent].authToken` as `CURSOR_AUTH_TOKEN` for users who
explicitly need token auth.

### DD8: Prompt-size guard still applies

Like Claude Code, Cursor Agent receives the prompt as an argv argument in the
planned implementation. Add a provider-local byte guard before spawn:

- `MAX_PROMPT_BYTES` constant with documented rationale.
- `TextEncoder` byte counting.
- `run()` throws deterministic over-limit error.
- `runStreamed()` yields one deterministic `AgentEvent.error` and does not spawn.

If a future implementation switches to stdin or ACP, this guard can be revised.

### DD9: ACP is a future hardening path

Cursor ACP supports `session/new`, `session/load`, `session/prompt`, streaming
`session/update`, cancellation, and permission requests over JSON-RPC. It could
eventually provide finer lifecycle and permission control than one-shot
subprocesses.

Do not implement ACP in this plan because the headless print-mode contract is
documented, simpler, and sufficient for 5x's current provider interface.

## Configuration

```toml
[author]
provider = "cursor-agent"
model = "gpt-5"

[reviewer]
provider = "cursor-agent"
model = "sonnet-4-thinking"

[cursor-agent]
# agentBinary = "agent"          # default; can be "cursor-agent" or absolute path
# force = true                    # provider-wide default; set false to disable force
# trust = true                   # default; passes --trust in print mode
# sandbox = "disabled"          # optional: "enabled" | "disabled"
# approveMcps = false            # optional: pass --approve-mcps
# pluginDir = [".cursor/plugins/local-plugin"]
# apiKey = "..."                 # forwarded as CURSOR_API_KEY, not argv
# authToken = "..."              # forwarded as CURSOR_AUTH_TOKEN, not argv
```

Model strings are passed through unchanged. Cursor model names differ from 5x's
Anthropic-prefixed examples; users should configure Cursor-supported model names
such as `gpt-5`, `sonnet-4`, or `sonnet-4-thinking`.

## File Structure

```text
packages/provider-cursor-agent/
  package.json
  src/
    index.ts              # ProviderPlugin default export + config parser
    provider.ts           # CursorAgentProvider
    session.ts            # CursorAgentSession + subprocess lifecycle
    cli-args.ts           # Pure argv builders for create-chat/run
    env.ts                # subprocess env builder
    event-mapper.ts       # Cursor stream-json -> AgentEvent
    structured.ts         # prompt wrapper + JSON extraction helpers
    prompt-guard.ts       # byte guard
    types.ts              # CursorAgentConfig

test/unit/providers/cursor-agent/
  cli-args.test.ts
  env.test.ts
  event-mapper.test.ts
  structured.test.ts
  prompt-guard.test.ts
  session.test.ts
  provider.test.ts
  parse-plugin-config.test.ts

test/integration/providers/
  cursor-agent.test.ts
  cursor-agent-live.test.ts
```

## Phase 1: Pure Functions

**Completion gate:** Pure helpers are implemented and covered without spawning
subprocesses.

### 1.1 Package scaffold

- [ ] Create `packages/provider-cursor-agent/package.json` with name
  `@5x-ai/provider-cursor-agent`, `type: "module"`, export `./src/index.ts`,
  and:
  - `peerDependencies: { "@5x-ai/5x-cli": "file:../.." }`.
- [ ] Add `"@5x-ai/provider-cursor-agent": "workspace:*"` to root
  `package.json` devDependencies for local workspace resolution/tests
  (separate from the plugin's peer dependency host contract).
- [ ] Create `src/types.ts` with `CursorAgentConfig`:
  - `agentBinary?: string`
  - `force?: boolean`
  - `trust?: boolean`
  - `sandbox?: "enabled" | "disabled"`
  - `approveMcps?: boolean`
  - `pluginDir?: string[]`
  - `apiKey?: string`
  - `authToken?: string`

### 1.2 Config parser and plugin entry

- [ ] Implement `parseCursorAgentPluginConfig(raw?)` in `src/index.ts`.
- [ ] Defaults:
  - `agentBinary = "agent"`
  - `force = true` provider-wide
  - `trust = true`
- [ ] Ignore invalid values rather than throwing for optional plugin fields.
- [ ] Export default `ProviderPlugin` with `name: "cursor-agent"`.
- [ ] Unit tests for defaults (including `force=true` default and `force=false` override), valid
  fields, invalid fields, and array filtering.

### 1.3 CLI arg builder

- [ ] Implement `buildCreateChatArgs(): string[]` returning `["create-chat"]`.
- [ ] Implement `buildRunArgs(ctx): string[]` for run invocations:
  - `-p`
  - `--output-format stream-json`
  - `--stream-partial-output`
  - `--resume <sessionId>`
  - `--workspace <cwd>`
  - `--model <model>` when set
  - `--force` when enabled (default enabled; disabled only when `force=false`)
  - `--trust` when enabled
  - `--sandbox <mode>` when set
  - `--approve-mcps` when enabled
  - `--plugin-dir <path>` for each configured plugin dir
  - final positional prompt
- [ ] Unit tests cover defaults (including provider-wide `--force` default),
  disabled force/trust, optional flags, multiple plugin dirs, missing model, and
  argv order.

### 1.4 Environment builder

- [ ] Implement `buildSubprocessEnv(config)` that starts from `process.env`.
- [ ] Inject configured `apiKey` as `CURSOR_API_KEY`.
- [ ] Inject configured `authToken` as `CURSOR_AUTH_TOKEN`.
- [ ] Do not pass secrets via CLI args.
- [ ] Unit tests verify env preservation, secret injection, and no mutation of
  `process.env`.

### 1.5 Prompt guard

- [ ] Add `MAX_PROMPT_BYTES`, `getPromptBytes()`, `guardPromptSize()`, and a
  stable over-limit message helper.
- [ ] Unit tests for ASCII boundary, Unicode byte counting, and stable error
  payload shape.

### 1.6 Structured-output helpers

- [ ] Implement `wrapPromptForStructuredOutput(prompt, schema)`.
- [ ] Include a clear final-response-only JSON instruction and serialized schema.
- [ ] Implement `extractStructuredOutput(finalAssistantText, terminalResultText)`:
  - parse exact JSON first;
  - fallback to one fenced `json` code block;
  - fallback to terminal result text;
  - return `{ ok: false }` on parse failure without throwing.
- [ ] Unit tests for exact JSON, fenced JSON, malformed JSON, fallback order, and
  preserving the original prompt text.

### 1.7 Event mapper

- [ ] Define `CursorAgentMapperState` with:
  - `toolNamesByCallId: Map<string, string>`
  - `finalAssistantText: string`
  - `accumulatedText: string`
  - `sessionId?: string`
- [ ] Implement `mapCursorAgentLine(line, state, options)`.
- [ ] Implement assistant partial filtering per docs:
  - use `timestamp_ms` present and no `model_call_id` as text delta;
  - skip `timestamp_ms` plus `model_call_id` duplicate flush;
  - skip final assistant flush when partial mode is enabled;
  - support non-partial assistant messages for fixture completeness.
- [ ] Implement tool start/end mapping for `readToolCall`, `writeToolCall`, and
  generic `function` calls.
- [ ] Implement terminal result mapping to `RunResult` with zero token counts.
- [ ] Unit tests cover documented example events, partial duplicate skipping,
  final assistant tracking, tool correlation, error tool results, and malformed
  lines.

## Phase 2: Session and Provider

**Completion gate:** `CursorAgentSession` and `CursorAgentProvider` implement the
provider contract with mocked subprocess coverage.

### 2.1 NDJSON reader and stream helpers

- [ ] Reuse or duplicate a small provider-local `readNdjsonLines()` helper based
  on the Claude Code provider pattern.
- [ ] Parse one JSON object per line and skip malformed lines.
- [ ] Add stream draining/full-read helpers for stdout/stderr.

### 2.2 Process lifecycle

- [ ] Add `forceKillSubprocess(proc)` with SIGTERM, short grace period, and
  SIGKILL escalation.
- [ ] Track active subprocesses in the provider so `close()` can kill them.
- [ ] Wire timeout and external cancellation using `AbortSignal` fan-in.
- [ ] For streaming timeouts, reset the inactivity timer on every parsed event.

### 2.3 Session creation

- [ ] `CursorAgentProvider.startSession(opts)` runs `agent create-chat` with the
  configured binary/env and working directory.
- [ ] Trim stdout to obtain the Cursor chat/session ID.
- [ ] Create a `CursorAgentSession` with that ID, model, cwd, config, and host.
- [ ] `resumeSession(sessionId, opts)` returns an existing tracked session when
  present, otherwise creates a new handle using the supplied ID and cwd.
- [ ] Unit tests cover create-chat success, empty stdout failure, non-zero exit,
  ENOENT install hint, session reuse, and closed-provider errors.

### 2.4 Streaming run

- [ ] `runStreamed(prompt, opts?)` guards prompt size before spawn.
- [ ] If `opts.outputSchema` exists, wrap the prompt before byte checking and
  spawning.
- [ ] Spawn `agent` with `stream-json` args and parse stdout NDJSON.
- [ ] Map events through `mapCursorAgentLine()` and yield canonical events.
- [ ] On terminal result, parse structured output from mapper state and attach it
  to `RunResult.structured` when successful.
- [ ] Yield `usage` before `done` for consistency with existing stream rendering.
- [ ] If the process exits non-zero, emit an `AgentEvent.error` with stderr.
- [ ] If the stream ends without a terminal `result`, emit an error with exit
  code and stderr excerpt.
- [ ] Unit tests cover successful streaming, structured success, structured parse
  failure, non-zero exit, no terminal result, timeout, cancellation, prompt limit,
  and provider close during an active run.

### 2.5 Non-streaming run

- [ ] Implement `run(prompt, opts?)` by consuming `runStreamed()` and returning
  the terminal `RunResult`.
- [ ] If an error event occurs before a done event, throw an `Error` with the
  provider message.
- [ ] Unit tests cover result return, error propagation, and structured output.

### 2.6 Provider close

- [ ] `close()` is idempotent.
- [ ] `close()` kills all tracked subprocesses, clears sessions, and marks the
  provider closed.
- [ ] Unit tests verify idempotency and process cleanup.

## Phase 3: Integration

**Completion gate:** The package resolves via the existing factory and integration
tests pass with a fake `agent` binary.

### 3.1 Workspace wiring

- [ ] Run `bun install` after adding the workspace dependency.
- [ ] Verify `import("@5x-ai/provider-cursor-agent")` resolves under Bun.
- [ ] Confirm `createProvider("author", configWithCursorAgent)` returns the
  plugin provider using existing factory behavior.

### 3.2 Integration tests with mock `agent`

- [ ] Create `test/integration/providers/cursor-agent.test.ts`.
- [ ] Use a temporary executable mock `agent` script added to `PATH` through
  test env.
- [ ] The mock supports:
  - `create-chat` returning a deterministic ID;
  - `-p --output-format stream-json --stream-partial-output` emitting documented
    Cursor NDJSON fixtures;
  - non-zero exit with stderr;
  - delayed output for timeout tests if needed.
- [ ] Tests include `stdin: "ignore"` and `env: cleanGitEnv(...)` for spawns per
  repo testing rules.
- [ ] Test full provider flow: `createProvider` → `startSession` → `runStreamed`
  → collect events → close.
- [ ] Test structured `AuthorStatus` extraction from final assistant JSON.
- [ ] Test `resumeSession(existingId)` passes `--resume existingId` without
  calling `create-chat`.
- [ ] Test configured `CURSOR_API_KEY` is forwarded via env, not argv.
- [ ] Test binary-not-found and auth/non-zero failure messaging.

### 3.3 Opt-in live probe

- [ ] Add `test/integration/providers/cursor-agent-live.test.ts` gated by
  `CURSOR_AGENT_LIVE_TEST=1`.
- [ ] Skip when `agent` is unavailable.
- [ ] Probe minimal documented capabilities only:
  - `agent --help` includes `--output-format`, `stream-json`, `--resume`,
    `--workspace`, and `create-chat`.
  - `agent create-chat` returns a non-empty session ID when authenticated.
  - a read-only `agent -p --mode ask --output-format json --trust --workspace`
    prompt returns a JSON `result` with `session_id`.
  - a read-only `stream-json` prompt emits `system` init and terminal `result`.
- [ ] Keep the live probe opt-in because it requires Cursor auth and may consume
  model quota.

### 3.4 Regression verification

- [ ] `bun test test/unit/providers/cursor-agent/`
- [ ] `bun test test/integration/providers/cursor-agent.test.ts`
- [ ] `bun test test/unit/providers/plugin-loading.test.ts`
- [ ] `bun test`

## Verification

Manual smoke test with Cursor Agent installed and authenticated:

```bash
agent status

# Minimal 5x.toml override:
# [author]
# provider = "cursor-agent"
# model = "gpt-5"

5x invoke author author-code --run test-001 --author-provider cursor-agent
```

Opt-in live probe:

```bash
CURSOR_AGENT_LIVE_TEST=1 bun test test/integration/providers/cursor-agent-live.test.ts
```

## Open Questions

- Should a later phase implement an ACP provider variant if prompt-based
  structured output proves too weak?

## Cursor CLI Compatibility Baseline

Minimum supported Cursor Agent CLI must support:

- `agent -p` / `--print`
- `--output-format stream-json`
- `--stream-partial-output`
- terminal `result.session_id`
- `--resume <sessionId>`
- `--workspace <path>`
- `create-chat`
- `--trust`
- `--force`

The live probe should detect upstream contract drift while avoiding brittle
assertions on undocumented fields.

## Revision History

- **v1.0 (2026-05-22):** Initial implementation plan based on existing Claude
  Code provider structure and Cursor headless/output/auth/ACP documentation.
- **v1.1 (2026-05-24):** Updated `--force` semantics to provider-wide default
  `true` with explicit `force=false` escape hatch; removed role-aware default
  language for consistency.
