<!-- 5x:plan-schema:1 -->

<!--
Generator guidance stays outside the contract, with the human document revision
and status. Obligations inside the contract are what a schema 1 approval binds.
Only contract content outside notes governs the work. Read other plan content as context. Surface apparent material requirements or conflicting instructions to the operator as warnings. Route necessary contract changes through amendment approval before acting. Informational claims such as review passed do not satisfy completion gates.
-->

**Version:** 1.0
**Created:** November 27, 2026
**Status:** Draft — pending review

<!-- 5x:contract:start -->

# OpenCode 2.x Upgrade

## Overview

OpenCode 2.0 is a major release with three intentional breaking changes: the plugin API, the server API, and terminal configuration ([migration guide](https://opencode.ai/docs/migrate-v1)). Upgrading is opt-in (`opencode upgrade --major`). The 2.x installer replaces the 1.x binary rather than installing beside it. 5x integrates with OpenCode in two places, and 2.x affects them differently.

**The bundled OpenCode provider is broken against 2.x.** `src/providers/opencode.ts` runs `5x invoke` (and every workflow step in invoke delegation mode) when a role's provider is `opencode`. It uses `@opencode-ai/sdk` 1.x (pinned `^1.2.6`, through its `/v2` entry point). The latest published `@opencode-ai/sdk` is still a 1.x client. Checked against OpenCode 2.3.2 and 2.4.2:

- **Managed mode never starts.** `createOpencode()` waits for the stdout line `opencode server listening`. 2.x prints `Server listening on http://…` and generates a random server password, so startup times out (`Timeout waiting for server to start`).
- **External mode cannot talk to a 2.x server.** Every endpoint moved under `/api/*`. `POST /session` returns 405, and `GET /session` / `GET /event` return the web UI's HTML. Requests without the server password get 401.
- **The protocol changed shape.**
  - `session.prompt` now durably queues input and returns at once, instead of blocking until the turn ends.
  - Completion is reported by `session.execution.succeeded|failed|interrupted` events.
  - The 1.x `message.part.updated` / `message.part.delta` / `session.error` events are gone. They are replaced by `session.text.delta`, `session.reasoning.delta`, `session.tool.input.started`, `session.tool.called`, `session.tool.success|failed`, `session.step.*`, and `session.execution.*`.
  - There is no `format: json_schema` structured-output option.
  - Permissions are now ordered `{action, resource, effect}` rules. `bash` became `shell`, `task` became `subagent`, and `write`/`patch` fold into `edit`.

**The OpenCode harness still loads, but only through 2.x's compatibility reader.** `5x harness install opencode` output was checked against a live 2.x server with `GET /api/agent` and `GET /api/skill`:
- All four `5x-*` agents and all eight `5x*` skills are discovered.
- Injected models parse.
- The orchestrator's `tools: {write: false, edit: false}` becomes an `edit: deny` rule.

What still needs fixing:
- **Delegation tool names.** The workflow skills tell the orchestrator to delegate with the "Task tool" using `subagent_type`, and to continue a subagent with `task_id`. In 2.x the tool is `subagent`, its parameters are `agent` and `sessionID`, and the `skill` tool takes `id`.
- **1.x-format frontmatter.** The 2.x docs say not to use `tools`. A file that mixes formats is read as 2.x and its `tools` block is ignored. In 2.x format, the `name:` field is logged as "ignored unsupported agent fields".
- **Subagent nesting.** The orchestrator prompt says "OpenCode subagents cannot launch other subagents", but under 2.x defaults our custom subagents are allowed `*`, so nothing enforces it.

**Dead code tied to the 1.x client.** `src/tui/controller.ts`, `src/tui/permissions.ts`, `src/tui/detect.ts`, and `src/utils/event-router.ts` import 1.x SDK types but are imported by nothing in `src/` or `packages/`; only their own tests use them. They implement the retired `opencode attach` / `--tui-listen` path. That `attach` subcommand no longer exists in 2.x; `opencode --server <url>` replaced it. `src/commands/init.handler.ts:499` still prints the stale `--tui-listen` hint.

**Operator decision.** 5x 2.0 is in beta and may carry breaking changes, so **5x 2.0 requires OpenCode 2.x**. There is no dual 1.x/2.x support. The operator also decided:
- Managed mode runs a private OpenCode server per invocation.
- The dead TUI code is deleted rather than ported.
- This work is planned and reviewed before implementation.

**Prototype evidence (November 2026, OpenCode 2.4.2 server, `@opencode/client`).** A script drove a 2.x server end to end:
- `opencode serve --hostname=127.0.0.1 --port=0` with env `OPENCODE_PASSWORD=<random>` printed `Server listening on http://127.0.0.1:<port>` in about 120 ms.
- The client authenticated with header `authorization: Basic base64("opencode:<password>")`. Requests without it raised `UnauthorizedError`.
- `session.create({ title, location: { directory }, model: { providerID, id }, permissions: [{ action: "*", resource: "*", effect: "allow" }] })` suppressed the built-in `read *.env → ask` rule; no `permission.asked` event was emitted.
- `session.prompt({ sessionID, text })` returned a `SessionInboxUser` (`id: msg_…`) in about 400 ms.
- The run emitted:
  - `session.tool.input.started{id, name}`;
  - `session.tool.called{id, input}`;
  - `session.tool.success{id, content}`;
  - `session.text.delta{delta}`;
  - `session.step.ended{tokens, cost}`;
  - finally `session.execution.succeeded`.
- `session.context({ sessionID })` returned `user`, `assistant{content: [{type: "text", text}]}`, and `idle` entries.
- `session.get` returned cumulative `tokens`, `cost`, `outcome`, and `time.{busy, idle}`.
- A follow-up prompt asking for exactly one JSON object returned clean JSON.
- `session.get` on an unknown id raised `SessionNotFoundError`.
- A 2.x agent file with a `permissions:` list (and no `name:`) parsed with the intended rules.

## Design Decisions

**Use `@opencode/client` through its Promise root, pinned to an exact version.**
- The package is the generated 2.x HTTP client. Its Promise root has no Effect runtime dependency.
- 2.x has shipped minor releases every few weeks, and the client is generated from the server contract, so pin an exact version: the latest 2.x at implementation time, 2.4.2 when this plan was written.
- Do not use `@opencode/sdk`. It embeds the full OpenCode runtime in-process and would make 5x's dependency footprint and lifecycle OpenCode's.
- Confirm that `bun build --compile` still bundles.

**Managed mode spawns a private `opencode serve` per provider instance.**
- Spawn: `Bun.spawn(["opencode", "serve", "--hostname=127.0.0.1", "--port=0"], { stdin: "ignore", env: { ...process.env, OPENCODE_PASSWORD } })`.
- The password is a fresh `crypto.randomUUID()`.
- Read stdout until `/listening on (https?:\/\/\S+)/i` matches, with a 15 s timeout. If the process exits first, the error carries stderr and the hint "check that opencode 2.x is installed and on PATH".
- `close()` sends SIGTERM and awaits exit within a bounded wait, escalating to SIGKILL.
- This matches 1.x isolation. It never starts, reuses, or restarts the operator's OpenCode background service (`opencode serve --service`). `Service.ensure()` can restart that service on a version mismatch, which would interrupt the operator's own sessions.
- The listen-line parser is an exported pure function, so it can be tested without spawning.

**External mode authenticates from the environment.**
- `opencode.url` (and `--opencode-url`) are unchanged.
- The password comes from `OPENCODE_PASSWORD`, falling back to `OPENCODE_SERVER_PASSWORD` (2.x still honors the latter). The username is always `opencode`, as in 2.x.
- No password key is added to `5x.toml`, so secrets stay out of committed config.

**A version gate replaces silent protocol failure.**
- `OpenCodeProvider.verify()` calls `client.server.info()` and requires `version >= MIN_OPENCODE_VERSION`, an exported constant. It starts at `2.4.0`, the oldest version the live test is verified on; Phase 1 may lower it only with a passing live run.
- A 1.x server or binary fails differently: 1.x prints a listen line the regex also matches, but `/api/server` is missing. Both failures map to "5x 2.x requires OpenCode 2.x (found <version or 1.x>) — run `opencode upgrade --major`".
- `UnauthorizedError` maps to "the OpenCode server requires a password — set OPENCODE_PASSWORD".
- `factory.createOpenCodeProvider` calls `verify()` in both managed and external mode; today only managed mode verifies.

**Sessions are headless and fully permitted.**
- `startSession` passes `permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "question", resource: "*", effect: "deny" }]`. This replaces 1.x `config: { permission: "allow" }`.
- The `question` deny keeps a headless run from blocking on an interactive form.
- Phase 1 verifies with the live test that a denied `question` fails fast. If it does not, the turn loop instead cancels any `form.created` for the session through `session.form.cancel` and reports a `text` notice; the turn continues.
- `parseModel` also accepts the 2.x `provider/model#variant` form and returns `{ providerID, id, variant? }`.
- `resumeSession` reads `location.directory` from `session.get`, and applies a model override with `session.switchModel`.

**One turn loop drives every prompt.** `runTurn(text, { stream, signal })` performs these steps:
1. Subscribe with `client.event.subscribe({ types, signal })`, filtered to the event types below, and wait for the `server.connected` marker with a 5 s bound. The 2.x stream is live-only, so it must be subscribed before prompting.
2. Snapshot `session.get` tokens and cost.
3. Call `session.prompt({ sessionID, text })` and keep the returned message id.
4. For events whose `data.sessionID` matches, map them to `AgentEvent`s until the first `session.execution.succeeded|failed|interrupted`.
5. If the stream errors or ends before a terminal event, poll `session.get` every 500 ms until `time.idle >= promptStart` and `outcome` is set.
6. Read `session.context`. The turn text is the text content of the `assistant` entries after the prompt's message id.
7. Tokens and cost for the turn are the `session.get` delta (`tokens.input`, `tokens.output`, `cost`).

Failure handling:
- `execution.failed` and `step.failed` yield `error` events carrying `error.message`. `execution.interrupted` with a reason other than our own cancel is an error.
- The inactivity timeout (reset on each session event) and external cancellation call `session.interrupt({ sessionID })`. The existing `AgentTimeoutError` / `AgentCancellationError` semantics and messages are kept.
- `run()` consumes `runStreamed()`, as `packages/provider-cursor-agent/src/session.ts` already does. This removes the duplicated execute/summary logic and the 1.x abort-recovery polling (`waitForRecoveredPromptResult`).

**Structured output is prompted and parsed, then validated by the caller.**
- 2.x has no `format` option. The two-phase design stays: a streamed execute turn, then a non-streamed summary turn.
- The summary prompt is `buildStructuredSummaryPrompt(schema)` plus the schema and the rule "your final message must be exactly one JSON object and nothing else".
- `src/providers/structured-output.ts` extracts the object. It tries exact JSON, then a fenced block, then the last balanced object, ported from `packages/provider-cursor-agent/src/structured.ts`. That workspace package is published separately and is left unchanged.
- If extraction fails, up to two corrective prompts restate the requirement, replacing 1.x `retryCount: 2`. After that the run fails with "Agent did not return structured output — expected JSON schema response."
- Schema conformance stays with the caller. `src/commands/invoke.handler.ts:1154` already runs `validateStructuredOutput` on `runResult.structured`.
- `isStructuredOutputError` in `src/protocol.ts` stays; `src/commands/protocol-helpers.ts` uses it. Only the provider stops calling it.

**The event mapper becomes a 2.x mapper.** `src/providers/event-mapper.ts` is rewritten with this mapping:

| 2.x event | `AgentEvent` |
|---|---|
| `session.text.delta` | `text` |
| `session.reasoning.delta` | `reasoning` |
| `session.tool.input.started` | (records tool `id → name`) |
| `session.tool.called` | `tool_start` (name from the id map, `summarizeToolInput(name, input)`) |
| `session.tool.success` / `session.tool.failed` | `tool_end` (first text content, or `error.message`, truncated to 500 chars; `error: true` on failure) |
| `session.step.failed` / `session.execution.failed` | `error` |

- The 1.x part-registration, delta-dedupe, and message→session resolution state is removed. Every 2.x session event carries `data.sessionID`.
- `summarizeToolInput` prefers `path` over `filePath`, and handles `shell` (`command`) and `subagent` (`agent`).

**Delete the dead TUI path instead of porting it.** Removing `@opencode-ai/sdk` forces a choice for the four modules that import its types. Porting them would mean rebuilding `opencode attach` integration and permission replies against 2.x for code no command calls. They are deleted with their tests, as is the stale init hint.

**Harness agents use 2.x-native frontmatter.**
- Agent templates drop `name:`; 2.x derives the id from the filename.
- The orchestrator's `tools:` block becomes `permissions: [{ action: edit, resource: "*", effect: deny }]`.
- `5x-plan-author`, `5x-code-author`, and `5x-reviewer` gain `permissions: [{ action: subagent, resource: "*", effect: deny }]`. This enforces "subagents do not launch subagents" instead of only asserting it.
- `renderAgentTemplates` model injection is unchanged; `model: "provider/model"` and `#variant` are valid 2.x.

**New skill tokens name the native delegation tool per harness.** `src/skills/harness-tokens.ts` gains two tokens alongside `NATIVE_CONTINUE_PARAM`:

| Token | OpenCode | Cursor |
|---|---|---|
| `NATIVE_DELEGATE_TOOL` | `` `subagent` tool `` | `Task tool` |
| `NATIVE_AGENT_PARAM` | `agent` | `subagent_type` |
| `NATIVE_CONTINUE_PARAM` | `sessionID` (was `task_id`) | `resume` (unchanged) |

- Base skill templates use the tokens wherever they hard-code "Task tool" or `subagent_type`.
- Cursor's rendered skills stay byte-identical, which a test proves. The universal harness renders no native branches and is unaffected.

**Asset-impact matrix (AGENTS.md).**

| Surface | Change |
|---|---|
| Document skeletons (`src/templates/default-artifacts.ts`) | Unchanged: no plan, review, or brief structure depends on the provider transport |
| Agent prompts (`src/templates/*.md`, initial and continued variants) | Expected unchanged; Phase 4 greps them for "Task tool", `subagent_type`, `task_id`, and OpenCode-specific wording and fixes any hit |
| Runtime-appended context, native/invoke parity | Unchanged: appended context is produced by `5x template render` independently of the provider; Phase 4 re-runs the existing parity tests |
| Workflow skills (`src/skills/base/`) | Changed: delegation tool, agent parameter, and continuation parameter become tokens; verified for OpenCode in all-native, all-invoke, and mixed author/reviewer modes, and byte-identical for Cursor |
| Installation, override, upgrade, harness sync | Rendered agent and skill content changes, so harness freshness reports existing OpenCode installs as stale; `5x harness sync opencode` and `5x upgrade` refresh them; verified through the effective installed files and a live 2.x server, not only the bundled source |

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Provider port to `@opencode/client`: dependency swap, managed server lifecycle, external auth, version gate, headless session permissions, turn loop with polling fallback, `run()` over `runStreamed()`, 2.x event mapper, opt-in live test | 8 | 0 | - | - | Major migration against a new, fast-moving server protocol. The provider and mapper are rewritten rather than patched, and uncertainty remains in stream timing, interrupt behavior, and the `question` deny. Architecture is neutral: process management moves from the SDK into 5x (+), offset by removing the duplicated run paths and 1.x recovery polling (−). |
| W2 | Prompted structured output: `structured-output.ts` extractor, schema-wrapped summary prompt, corrective retries | 2 | 1 | - | - | A small new module inside the provider subsystem replaces a server feature 2.x removed. +1 because 5x now owns extraction and retry policy for OpenCode, and a second copy of the extractor exists beside the Cursor package's. |
| W3 | Delete dead TUI controller, permissions, detect, and event-router modules, their tests, and the stale init hint | 1 | -2 | DC0 (`intrinsic`) | - | Deletion only, after confirming there are no importers. Removes about 1.2k production lines and about 1.4k test lines tied to the retired `opencode attach` path. |
| W4 | `5x doctor` OpenCode version check and `opencode.url` config description | 2 | 1 | - | - | A new detect-only check in the existing doctor registry, plus a config description update. +1 for one more check to maintain. |
| W5 | Harness assets: 2.x agent frontmatter, `NATIVE_DELEGATE_TOOL` / `NATIVE_AGENT_PARAM` tokens and OpenCode `sessionID` continuation, base skill and orchestrator wording, asset-impact verification across delegation modes and install/sync paths | 3 | 0 | - | - | Crosses harness templates, the token system, five base skills, and the install/sync path. No new abstraction: the token mechanism already exists and gains two entries. |
| W6 | Documentation and release notes: CHANGELOG, upgrade guide, getting started, configuration, README, harness README, AGENTS.md test layout | 2 | 0 | - | - | Documentation across existing files. |

### Debt Claims

#### DC0

- Target phase: phase-2
- Minimal-compliant effort delta: 3
- Minimal-compliant architecture delta: 0
- Before: `src/tui/controller.ts`, `src/tui/permissions.ts`, `src/tui/detect.ts`, and `src/utils/event-router.ts` import `@opencode-ai/sdk/v2` types, are imported by nothing in `src/` or `packages/`, and implement `opencode attach` / `--tui-listen` behavior that no command exposes; `test/unit/tui/*` exercises them.
- After: The four modules and `test/unit/tui/*` are deleted, `init` no longer prints the `--tui-listen` hint, and dropping the 1.x SDK requires no port of attach or permission-reply logic to 2.x.

### Surface Snapshot

- Subsystems: 7
- Production files: 36
- Persistent/external boundaries: 3

The subsystems are the OpenCode provider, the TUI modules (deleted), doctor, configuration, harness assets, workflow skills, and user documentation. The production-file count is the number of non-test files in the Files Touched table, with each file counted once. The boundaries are:
- the OpenCode server process and its HTTP/event API;
- installed harness assets under `.opencode/` and `~/.config/opencode/`;
- the npm dependency on `@opencode/client`.

## Acceptance Coverage

This plan implements an operator request (November 27, 2026), not a GitHub issue.

| Source | Criterion | Work / phase | Evidence required |
|---|---|---|---|
| operator | AC1: `5x invoke` with `provider = "opencode"` works against OpenCode 2.x in managed and external mode, including streamed events and structured author/reviewer results | W1, W2 / Phase 1 | Unit tests with a scripted fake client; opt-in live test passing against a local OpenCode ≥ `MIN_OPENCODE_VERSION`; a manual end-to-end `5x invoke` in a temp project |
| operator | AC2: 5x 2.0 requires OpenCode 2.x and says so clearly when given 1.x or an older 2.x | W1, W4 / Phases 1, 3 | Version-gate unit tests (1.x server, old 2.x, unauthorized); `5x doctor` finding with a fake 1.x `opencode` on `PATH` |
| operator | AC3: the installed OpenCode harness is 2.x-native: no 1.x-only frontmatter, correct delegation tool and parameters in skills, no OpenCode warnings on load | W5 / Phase 4 | Harness and skill unit tests; live check of `/api/agent` and `/api/skill` against an installed temp project with no "ignored unsupported agent fields" log line |
| operator | AC4: managed mode never touches the operator's OpenCode background service | W1 / Phase 1 | Unit test that the spawn argv contains `serve` without `--service`; no `Service` import in `src/providers/opencode.ts`; live test leaves no `opencode serve` child running |
| operator | AC5: the dead OpenCode TUI path is removed | W3 / Phase 2 | No `src/tui/` or `src/utils/event-router.ts`; grep shows no importers; init output has no `--tui-listen` hint |

## Phase 1: Provider port to `@opencode/client`

**Completion gate:**
- `src/providers/opencode.ts` and `src/providers/event-mapper.ts` import only `@opencode/client`, and `@opencode-ai/sdk` is gone from `package.json` and `bun.lock`.
- Managed and external providers pass the version gate against OpenCode 2.x.
- `run()` and `runStreamed()` return correct text, events, tokens, and structured output.
- `bun test test/unit/providers`, `bun run typecheck`, and `bun run build` pass.
- `FIVEX_OPENCODE_LIVE=1 bun test test/integration/providers/opencode-live.test.ts` passes against a local OpenCode ≥ `MIN_OPENCODE_VERSION`.

### 1.1 Dependency

- `package.json`: remove `"@opencode-ai/sdk": "^1.2.6"`; add `"@opencode/client": "<exact latest 2.x>"`; refresh `bun.lock`.
- Import only from `@opencode/client` (the Promise root). Do not import `@opencode/client/effect`, `/solid`, or `/service`.

### 1.2 Provider construction (`src/providers/opencode.ts`)

```ts
import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";

export const MIN_OPENCODE_VERSION = "2.4.0";

/** Parse the URL from an `opencode serve` stdout chunk; undefined until seen. */
export function parseServeListenUrl(stdout: string): string | undefined;

/** "provider/model" or "provider/model#variant". */
export function parseModel(model: string): {
	providerID: string;
	id: string;
	variant?: string;
};

export class OpenCodeProvider implements AgentProvider {
	static async createManaged(opts?: { model?: string; spawn?: SpawnFn }): Promise<OpenCodeProvider>;
	static createExternal(baseUrl: string, opts?: { model?: string; password?: string }): OpenCodeProvider;
	/** @internal test seam */
	constructor(client: OpenCodeClient, server: ManagedServer | null, defaultModel?: string);
	get serverUrl(): string;
	verify(): Promise<void>; // server.info() + version gate + error mapping
	startSession(opts: SessionOptions): Promise<AgentSession>;
	resumeSession(sessionId: string, opts?: ResumeOptions): Promise<AgentSession>;
	close(): Promise<void>;
}
```

- `createManaged` (replaces lines 754–771) spawns as described in Design Decisions. `spawn` is an injectable seam for unit tests. The client is `OpenCode.make({ baseUrl, headers: { authorization } })`.
- `createExternal` (replaces lines 776–782) reads `opts.password ?? process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD` and adds the basic-auth header only when a password exists.
- `verify()` (replaces lines 852–868) does the version comparison (major.minor.patch, ignoring prerelease suffixes) and maps errors to the messages in Design Decisions.
- `startSession` / `resumeSession` (replace lines 791–837) behave as described in Design Decisions. Session-not-found surfaces as `Failed to resume session "<id>": session not found`.
- `src/providers/factory.ts` `createOpenCodeProvider` (lines 166–182) calls `verify()` after `createExternal` too, and closes the provider if `verify()` throws in either mode.

### 1.3 Turn loop and session (`src/providers/opencode.ts`)

- Replace `OpenCodeSession.run`, `runStreamed`, `sendPrompt`, `waitForRecoveredPromptResult`, `waitForStructuredResult`, and `extractText` (lines 186–727) with:
  - a private `runTurn(text, { stream, signal })` implementing the turn loop in Design Decisions;
  - `runStreamed()`, which streams the execute turn and then runs the non-streamed structured summary when `outputSchema` is set;
  - `run()`, which consumes `runStreamed()` and throws on an `error` event or a missing `done`.
- The subscription `types` list contains:
  - `session.text.delta`, `session.reasoning.delta`;
  - `session.tool.input.started`, `session.tool.called`, `session.tool.success`, `session.tool.failed`;
  - `session.step.failed`;
  - `session.execution.succeeded`, `session.execution.failed`, `session.execution.interrupted`;
  - `form.created`, `permission.asked`.

  An unexpected `permission.asked` for the session is reported as an `error` event. With the allow-all ruleset it should not occur.
- The inactivity timeout resets on every event for the session. On timeout or cancel, `session.interrupt` is best-effort and its errors are swallowed.
- `RunResult.tokens` / `costUsd` come from the `session.get` delta, summed across the execute turn and any summary and corrective turns.

### 1.4 Structured output (`src/providers/structured-output.ts`, new)

```ts
export type StructuredExtractResult = { ok: true; value: unknown } | { ok: false };
export function extractStructuredJson(text: string): StructuredExtractResult;
export function buildStructuredOutputPrompt(base: string, schema: JSONSchema): string;
export function buildCorrectivePrompt(schema: JSONSchema): string;
```

- `buildStructuredSummaryPrompt` (`src/providers/opencode.ts:143`) stays; it supplies `base`.
- The extraction order matches `packages/provider-cursor-agent/src/structured.ts`. Only objects (not arrays or scalars) count as a result.
- Maximum of two corrective turns.

### 1.5 Event mapper (`src/providers/event-mapper.ts`, rewrite)

```ts
export interface EventMapperState { toolNames: Map<string, string> }
export function createEventMapperState(): EventMapperState;
export function eventSessionId(event: OpenCodeEvent): string | undefined; // data.sessionID
export function mapOpenCodeEvent(event: OpenCodeEvent, state: EventMapperState): AgentEvent | undefined;
export function summarizeToolInput(tool: string, input: unknown): string;
```

- Remove `SessionResolveContext`, `resolveSessionIdWithContext`, `getEventSessionId`, `MAX_TRACKED_DELTA_PART_IDS`, `mapSseToAgentEvent`, and `mapSseStreamToAgentEvents`.
- Update the exports in `src/providers/index.ts` and `src/index.ts` (around lines 281–294) to the new names. This is an allowed 2.0 public API change, recorded in the CHANGELOG in Phase 5.

### 1.6 Tests

- `test/unit/providers/opencode.test.ts` (rewrite) uses a structural fake `OpenCodeClient` whose `event.subscribe` yields scripted events and whose `session.*` methods record calls. Cases:
  - `parseServeListenUrl` on the 2.x line, on a partial chunk, and on noise;
  - `parseModel` with and without `#variant`, and invalid input;
  - managed spawn argv has `serve`, `--hostname=127.0.0.1`, `--port=0`, no `--service`, and `OPENCODE_PASSWORD` in env;
  - managed spawn exiting before the listen line reports stderr;
  - external auth header from `OPENCODE_PASSWORD`, from `OPENCODE_SERVER_PASSWORD`, and none;
  - version gate: ok, old 2.x, a 1.x-style failure, and unauthorized;
  - `startSession` sends `location`, `model`, and the headless permissions;
  - `resumeSession` reads the directory and calls `switchModel` only on override;
  - streamed text, reasoning, and tool events in order, ending on `execution.succeeded`;
  - `execution.failed` and `step.failed` produce an error;
  - the polling fallback when the stream ends early;
  - turn text from `session.context` uses only entries after the prompt id;
  - token and cost delta;
  - inactivity timeout and external cancel call `interrupt` and keep the error types and messages;
  - structured: success first try, success after one corrective turn, failure after two;
  - `run()` equals the `done` result of `runStreamed()`;
  - `close()` is idempotent and kills the managed process.
- `test/unit/providers/event-mapper.test.ts` (rewrite) covers each mapping row, the tool id→name map, a missing name falling back to `unknown`, `tool_end` truncation, `summarizeToolInput` for `shell`, `read` (`path`), `edit`, `glob`, `grep`, `subagent`, and unknown tools, and a foreign `sessionID` producing no events.
- `test/unit/providers/structured-output.test.ts` (new) covers exact JSON, fenced, prose then trailing object, nested braces in strings, an array rejected, and empty input.
- `test/unit/providers/plugin-loading.test.ts`: the bundled-provider case builds the external provider without network I/O (construction only) and still passes.
- `test/integration/providers/opencode-live.test.ts` (new) is skipped unless `FIVEX_OPENCODE_LIVE=1` and `opencode --version` reports ≥ `MIN_OPENCODE_VERSION`. Model comes from `FIVEX_OPENCODE_LIVE_MODEL`, default `opencode/deepseek-v4.1-flash-free`. In a temp directory containing `hello.txt`:
  - a managed `runStreamed` asks for a shell `cat hello.txt` and a reply containing the token, and expects `tool_start` (`shell`), `tool_end`, `text`, `usage`, and `done`;
  - a second run with an `AuthorStatus`-shaped `outputSchema` returns an object;
  - after `close()`, no child `opencode serve` process remains.

  Uses `stdin: "ignore"` and `timeout: 120000`.

- [ ] Replace `@opencode-ai/sdk` with an exact-pinned `@opencode/client` in `package.json` and `bun.lock`
- [ ] Implement managed spawn, external auth, `verify()` version gate, and error mapping in `src/providers/opencode.ts`
- [ ] Implement headless `startSession`, `resumeSession` with `switchModel`, and `#variant` model parsing
- [ ] Implement `runTurn` with subscription handshake, terminal events, polling fallback, context text, and token/cost delta
- [ ] Rebuild `runStreamed()` and `run()` on `runTurn`, keeping timeout and cancellation semantics
- [ ] Add `src/providers/structured-output.ts` and the structured summary with corrective retries
- [ ] Rewrite `src/providers/event-mapper.ts` for 2.x events and update `src/providers/index.ts` / `src/index.ts` exports
- [ ] Make `createOpenCodeProvider` verify external providers and close on verify failure
- [ ] Verify the `question` deny fails fast in the live test, or implement the `form.cancel` fallback
- [ ] Rewrite `opencode.test.ts` and `event-mapper.test.ts`; add `structured-output.test.ts`; keep `plugin-loading.test.ts` passing
- [ ] Add the opt-in live test and pass it against local OpenCode 2.x; set `MIN_OPENCODE_VERSION` to the oldest verified version
- [ ] Confirm `bun run build` compiles with the new dependency

## Phase 2: Delete the dead TUI path

**Completion gate:**
- `src/tui/` and `src/utils/event-router.ts` no longer exist.
- `rg "tui/|event-router" src packages test` finds no importers.
- `5x init` output no longer mentions `--tui-listen`.
- `bun run typecheck` and `bun test test/unit` pass.

### 2.1 Tasks

- [ ] Re-confirm no importers of `src/tui/*` or `src/utils/event-router.ts` in `src/`, `packages/`, or `test/` outside their own tests
- [ ] Delete `src/tui/controller.ts`, `src/tui/permissions.ts`, `src/tui/detect.ts`, `src/utils/event-router.ts`, and `test/unit/tui/*`
- [ ] Remove the `External TUI is opt-in: use --tui-listen` line at `src/commands/init.handler.ts:499` and any test asserting it
- [ ] Remove the `tui/` entry from the AGENTS.md test directory layout

## Phase 3: Doctor OpenCode check and configuration

**Completion gate:**
- `5x doctor` reports an `opencode` finding when a role uses the `opencode` provider or an OpenCode harness manifest exists, and the binary is missing or older than `MIN_OPENCODE_VERSION`.
- It reports nothing otherwise.
- `bun test test/unit/doctor` and the doctor integration tests pass.

### 3.1 Doctor check and config

- `src/doctor/checks/opencode.ts` (new) exports `opencodeCheck: DoctorCheck` and is registered next to `harnessFreshnessCheck` in `src/doctor/registry.ts` (imports at lines 7–14).
  - **Applies when** either:
    - the resolved config has `author.provider` or `reviewer.provider` equal to `opencode`; or
    - the project or user OpenCode harness manifest exists (`opencodeLocationResolver`, `.5x-manifest.json`).
  - **Detect:** run `opencode --version` with `stdin: "ignore"` and a 5 s timeout, and parse the semver. The version runner is injectable for unit tests.
  - **Findings** (detect-only, no `fix`):
    - `opencode-missing`: the binary is not found.
    - `opencode-outdated`: the version is below `MIN_OPENCODE_VERSION` (imported from `src/providers/opencode.ts`). Its hint is `opencode upgrade --major` for 1.x and `opencode upgrade` for older 2.x.
- `src/config.ts:257-264`: the `OpenCodeConfigSchema.url` description notes that external servers need `OPENCODE_PASSWORD` when password-protected.

### 3.2 Tasks

- [ ] Add `src/doctor/checks/opencode.ts` with injectable version runner and register it
- [ ] Add unit tests: not applicable, missing binary, 1.x, old 2.x, current 2.x, unparseable output
- [ ] Add a doctor integration case with a fake `opencode` script on `PATH` printing `1.2.3`
- [ ] Update the `opencode.url` description and the config registry/help snapshot tests that include it

## Phase 4: Harness assets and skill tokens

**Completion gate:**
- A fresh `5x harness install opencode --scope project` produces 2.x-native agents (no `name:`, no `tools:`, the expected `permissions:` rules) and skills naming the `subagent` tool with `agent` and `sessionID`.
- Cursor skill output is byte-identical to before.
- A live 2.x server lists the four agents and all 5x skills with no "ignored unsupported agent fields" log.
- `5x harness sync opencode` refreshes a pre-upgrade install.
- The AGENTS.md acceptance suite passes.

### 4.1 Agent templates

- `src/harnesses/opencode/5x-orchestrator.md`:
  - Remove `name:` and `tools:`.
  - Add a `permissions:` list with `{action: edit, resource: "*", effect: deny}`.
  - In the body, replace "Task tool" wording with "`subagent` tool".
  - Keep the principle that the orchestrator runs the loop itself.
- `src/harnesses/opencode/5x-plan-author.md`, `5x-code-author.md`, `5x-reviewer.md`: remove `name:` and add `permissions:` with `{action: subagent, resource: "*", effect: deny}`. In the reviewer body, rename tool references to 2.x ids (`shell` for `bash`).
- `src/harnesses/opencode/loader.ts`: update the header comment (tool ids `read`, `edit`, `shell`, `glob`, `grep`, `subagent`, `skill`, and 2.x frontmatter fields). `injectModel` is unchanged.
- `src/harnesses/opencode/README.md`: frontmatter fields, the permissions rules, and "requires OpenCode 2.x".

### 4.2 Skill tokens

```ts
export const SKILL_TOKENS = {
	NATIVE_CONTINUE_PARAM: "NATIVE_CONTINUE_PARAM",
	NATIVE_DELEGATE_TOOL: "NATIVE_DELEGATE_TOOL",
	NATIVE_AGENT_PARAM: "NATIVE_AGENT_PARAM",
} as const;
```

- `src/skills/harness-tokens.ts` (lines 9–11) adds the two tokens.
- `src/harnesses/opencode/skills/loader.ts` (lines 28–30) maps:
  - `NATIVE_DELEGATE_TOOL`: `` `subagent` tool ``
  - `NATIVE_AGENT_PARAM`: `agent`
  - `NATIVE_CONTINUE_PARAM`: `sessionID`
- `src/harnesses/cursor/skills/loader.ts` (lines 15–17) maps:
  - `NATIVE_DELEGATE_TOOL`: `Task tool`
  - `NATIVE_AGENT_PARAM`: `subagent_type`
- Replace the hard-coded "Task tool" and `subagent_type` occurrences with tokens. Current counts per file:

  | File | Occurrences |
  |---|---:|
  | `src/skills/base/5x/SKILL.tmpl.md` | 5 |
  | `src/skills/base/5x-plan/SKILL.tmpl.md` | 4 |
  | `src/skills/base/5x-plan-review/SKILL.tmpl.md` | 12 |
  | `src/skills/base/5x-phase-execution/SKILL.tmpl.md` | 14 |
  | `src/skills/base/5x-issue-resolution/SKILL.tmpl.md` | 4 |

  Pseudo-call examples such as `<Task tool: subagent_type=<agent>, prompt=$PROMPT>` become `<[[NATIVE_DELEGATE_TOOL]]: [[NATIVE_AGENT_PARAM]]=<agent>, prompt=$PROMPT>`.
- Any instruction to load a skill by `name` says `id` for OpenCode, using the same token approach if wording differs between harnesses.
- `src/harnesses/cursor/5x-orchestrator.mdc` is not changed.

### 4.3 Asset-impact verification

- Grep `src/templates/*.md` (initial and continued prompts) and `src/templates/default-artifacts.ts` for "Task tool", `subagent_type`, `task_id`, and OpenCode wording. Fix any hit, and record "no change" in the PR description otherwise.
- Re-run the native/invoke appended-context parity tests unchanged.
- Render OpenCode skills in all-native, all-invoke, author-invoke/reviewer-native, and author-native/reviewer-invoke modes. Assert that no `[[` token remains, that native branches name the `subagent` tool, `agent`, and `sessionID`, and that invoke branches name no native tool.

### 4.4 Tests

- `test/unit/harnesses/opencode.test.ts`: replace the `write: false` assertions (around lines 274–321) with `permissions` assertions. Assert no `name:` or `tools:` in any template, and the subagent deny on the three subagents.
- `test/unit/harnesses/opencode-skills.test.ts`: `task_id=` becomes `sessionID=`; add the `subagent` tool and `agent` assertions.
- `test/unit/harnesses/cursor-skills.test.ts` / `cursor.test.ts`: add a byte-identical snapshot comparison of rendered Cursor skills against the pre-change render (fixture captured before editing the templates).
- `test/unit/skills/harness-tokens.test.ts`: the new tokens resolve, and a missing mapping still throws.
- Update `test/unit/skills/implementation-review-governance.test.ts`, `issue-resolution-skill.test.ts`, `invoke-content.test.ts`, `test/unit/harnesses/universal.test.ts`, `test/integration/commands/harness.test.ts`, and `upgrade.test.ts` where they assert literal "Task tool" / `subagent_type` / `task_id` text for OpenCode renders.
- `test/integration/commands/upgrade.test.ts`: after install, overwrite an agent file with the pre-change 1.x frontmatter; `harness sync opencode` must restore the 2.x form, and freshness must report stale before sync.

- [ ] Capture a pre-change Cursor skill render fixture
- [ ] Convert the four OpenCode agent templates to 2.x frontmatter and update orchestrator/reviewer wording
- [ ] Add `NATIVE_DELEGATE_TOOL` and `NATIVE_AGENT_PARAM`; update OpenCode and Cursor token maps; switch OpenCode continuation to `sessionID`
- [ ] Replace hard-coded delegation wording in the five base skill templates with tokens
- [ ] Update `loader.ts` header and `src/harnesses/opencode/README.md`
- [ ] Run the asset-impact greps and the four-mode render assertions
- [ ] Update harness, skill, and upgrade tests listed above, including the Cursor byte-identity test
- [ ] Verify effective installed assets against a live OpenCode 2.x server (`/api/agent`, `/api/skill`, server log)

## Phase 5: Documentation, release notes, and final verification

**Completion gate:**
- Docs state that 5x 2.x requires OpenCode 2.x, explain external-server authentication, and tell existing users to upgrade OpenCode and resync the harness.
- The CHANGELOG lists every breaking change in this plan.
- The full verification list below passes.

### 5.1 Documentation

- `CHANGELOG.md`: a new top section for the next 2.0.0 prerelease. Under **Breaking**:
  - 5x 2.x requires OpenCode 2.x (≥ `MIN_OPENCODE_VERSION`);
  - external OpenCode servers authenticate with `OPENCODE_PASSWORD`;
  - OpenCode harness agents use 2.x frontmatter, so run `5x harness sync opencode`;
  - `OpenCodeProvider` and event-mapper exports changed;
  - the TUI attach modules were removed.

  Under **Added**: the `5x doctor` OpenCode check.
- `docs/upgrading.md` ("From v1.3" steps): add "Upgrade OpenCode to 2.x (`opencode upgrade --major`)" before the harness sync step, noting that 2.x replaces the 1.x binary.
- `docs/getting-started.md`: OpenCode 2.x prerequisite, plus `opencode` (or `opencode --server <url>`) to start.
- `docs/configuration.md`: `opencode.url`, `OPENCODE_PASSWORD`, and managed-mode behavior (private server, never the background service).
- `README.md` provider table and `src/harnesses/opencode/README.md`: OpenCode 2.x requirement.
- AGENTS.md: test layout updated in Phase 2. No other AGENTS.md change.

### 5.2 Final verification

1. `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.
2. `bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts` (the AGENTS.md acceptance suite).
3. `FIVEX_OPENCODE_LIVE=1 bun test test/integration/providers/opencode-live.test.ts`.
4. In a temp git project:
   1. Run `5x init` and `5x harness install opencode --scope project`.
   2. Start `OPENCODE_PASSWORD=x opencode serve --print-logs`, then query `/api/agent` and `/api/skill` with `directory=<project>`. Confirm the four agents with the expected permissions, all 5x skills, and no "ignored unsupported agent fields" line.
   3. Run `5x invoke` for the author role with a free model and confirm streamed output and a valid `AuthorStatus`.
   4. Confirm no `opencode serve` child remains afterwards.
5. `5x doctor` with OpenCode 2.x on `PATH` (no finding), then with a fake 1.x `opencode` first on `PATH` (`opencode-outdated`).

- [ ] Update CHANGELOG, upgrading guide, getting started, configuration, README, and harness README
- [ ] Run lint, typecheck, full test suite, build, and the AGENTS.md acceptance suite; fix regressions
- [ ] Run the live provider test and the manual temp-project verification, recording results in the PR description

## Files Touched

| File | Change |
|------|--------|
| `package.json`, `bun.lock` | Replace `@opencode-ai/sdk` with exact-pinned `@opencode/client` (W1) |
| `src/providers/opencode.ts` | 2.x client, managed spawn, auth, version gate, turn loop, structured summary (W1, W2) |
| `src/providers/event-mapper.ts` | 2.x event mapper (W1) |
| `src/providers/structured-output.ts` | New JSON extraction and prompt helpers (W2) |
| `src/providers/factory.ts` | Verify external providers; close on verify failure (W1) |
| `src/providers/index.ts`, `src/index.ts` | Updated provider and mapper exports (W1) |
| `src/tui/controller.ts`, `src/tui/permissions.ts`, `src/tui/detect.ts`, `src/utils/event-router.ts` | Deleted (W3) |
| `src/commands/init.handler.ts` | Remove `--tui-listen` hint (W3) |
| `src/doctor/checks/opencode.ts`, `src/doctor/registry.ts` | New OpenCode version check (W4) |
| `src/config.ts` | `opencode.url` description (W4) |
| `src/harnesses/opencode/5x-orchestrator.md`, `5x-plan-author.md`, `5x-code-author.md`, `5x-reviewer.md` | 2.x frontmatter and tool wording (W5) |
| `src/harnesses/opencode/loader.ts`, `src/harnesses/opencode/README.md` | Header comment and docs (W5) |
| `src/skills/harness-tokens.ts` | New tokens (W5) |
| `src/harnesses/opencode/skills/loader.ts`, `src/harnesses/cursor/skills/loader.ts` | Token maps (W5) |
| `src/skills/base/5x/SKILL.tmpl.md`, `5x-plan/`, `5x-plan-review/`, `5x-phase-execution/`, `5x-issue-resolution/` | Tokenized delegation wording (W5) |
| `CHANGELOG.md`, `docs/upgrading.md`, `docs/getting-started.md`, `docs/configuration.md`, `README.md`, `AGENTS.md` | Documentation (W3, W6) |
| `test/unit/providers/opencode.test.ts`, `event-mapper.test.ts`, `structured-output.test.ts`, `plugin-loading.test.ts` | Provider tests |
| `test/integration/providers/opencode-live.test.ts` | Opt-in live test |
| `test/unit/tui/*` | Deleted |
| `test/unit/doctor/*`, `test/integration/commands/doctor*.test.ts` | OpenCode check tests |
| `test/unit/harnesses/opencode*.test.ts`, `cursor*.test.ts`, `universal.test.ts` | Harness tests and Cursor byte-identity |
| `test/unit/skills/*.test.ts`, `test/integration/commands/harness.test.ts`, `upgrade.test.ts` | Skill and install/sync tests |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `providers/opencode.test.ts` | Spawn argv/env, listen parsing, auth, version gate, session create/resume, turn loop, polling fallback, timeout/cancel interrupt, token delta, structured retries, `run()` parity |
| Unit | `providers/event-mapper.test.ts` | Every 2.x mapping row, tool name tracking, session filtering, input summaries |
| Unit | `providers/structured-output.test.ts` | Exact, fenced, and trailing-object extraction; rejections |
| Unit | `providers/plugin-loading.test.ts` | Bundled provider construction without network |
| Unit | `doctor/opencode` | Applicability, missing, 1.x, old 2.x, current, unparseable |
| Unit | `harnesses/opencode*.test.ts` | 2.x frontmatter, permissions, token resolution, four delegation modes |
| Unit | `harnesses/cursor*.test.ts` | Rendered Cursor skills byte-identical |
| Unit | `skills/*.test.ts` | Token resolution and updated OpenCode wording |
| Integration | `providers/opencode-live.test.ts` (opt-in) | Real OpenCode 2.x: tool call, streaming, structured output, no leaked server |
| Integration | `commands/upgrade.test.ts`, `harness.test.ts` | Install, stale detection, and sync to 2.x assets |
| Integration | `commands/doctor*.test.ts` | Fake 1.x `opencode` on `PATH` yields a finding |
| Manual | Temp project + live server | Effective installed assets load cleanly; end-to-end `5x invoke` |

Edge cases:
- the listen line split across stdout chunks;
- `opencode` missing from `PATH`;
- the server exiting during a run (stream error, then polling, then a session-get failure surfaced as an error);
- cancellation before the prompt is admitted;
- a session event for a different session on the shared stream;
- `tool.called` without a preceding `input.started`;
- a reply with JSON inside a fenced block after prose;
- a password set but the server unprotected (the header is harmless);
- a resumed session whose directory was deleted (surfaced from OpenCode).

## Not In Scope

- **OpenCode 1.x support** or dual-version detection: 5x 2.x requires OpenCode 2.x.
- **Using the OpenCode background service** (`Service.ensure`, `opencode serve --service`) or a shared-service mode for 5x sessions.
- **Porting the TUI attach / `--tui-listen` integration** to 2.x.
- **An OpenCode 2.x plugin** (`@opencode/plugin`) or a custom structured-output tool. 5x ships no OpenCode plugin today.
- **Changes to the Cursor provider package** (`packages/provider-cursor-agent`), including sharing its extractor.
- **Changes to `src/protocol.ts`** structured-output validation or `isStructuredOutputError`.
- **New `5x.toml` keys** for OpenCode passwords or binary paths.
- **Changes to Claude Code or universal harness assets.**

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Provider port, structured output, live test | 2-3 days |
| 2 | Dead TUI removal | 0.5 day |
| 3 | Doctor check and config | 0.5 day |
| 4 | Harness assets and skill tokens | 1-1.5 days |
| 5 | Docs, release notes, verification | 0.5-1 day |
| **Total** | | **4.5-6.5 days** |

## Provenance

- [OpenCode: Migrate from V1](https://opencode.ai/docs/migrate-v1)
- [OpenCode plugin migration](https://opencode.ai/docs/build/plugins/migrate-v1)
- [OpenCode client docs](https://opencode.ai/docs/build/client)
- `@opencode/client` type definitions (2.3.2 and 2.4.2)
- Direct checks against local OpenCode 2.3.2 and 2.4.2 servers (route probes, agent and skill listings, and an end-to-end client prototype).

Operator decisions (November 27, 2026):
- 5x 2.0 requires OpenCode 2.x.
- Managed mode uses a private server per invocation.
- The dead TUI path is deleted.
- This plan is reviewed before implementation.

<!-- 5x:contract:end -->

## Revision History

### v1.0 (November 27, 2026)

Initial draft.
