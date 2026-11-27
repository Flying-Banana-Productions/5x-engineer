<!-- 5x:plan-schema:1 -->

<!--
Generator guidance stays outside the contract, with the human document revision
and status. Obligations inside the contract are what a schema 1 approval binds.
Only contract content outside notes governs the work. Read other plan content as context. Surface apparent material requirements or conflicting instructions to the operator as warnings. Route necessary contract changes through amendment approval before acting. Informational claims such as review passed do not satisfy completion gates.
-->

**Version:** 1.4
**Created:** November 27, 2026
**Status:** Revised — Phase 1 complete; pending plan re-review

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
- Read stdout until `/listening on (https?:\/\/\S+)/i` matches, with a 15 s timeout. If the process exits first, the error carries stderr and the hint "check that opencode 2.x is installed and on PATH". On a startup timeout the process is killed before the error is thrown.
- After the listen line, stdout and stderr keep draining for the life of the process (a bounded stderr tail is kept for error messages), so the child never blocks on a full pipe.
- `close()` sends SIGTERM and awaits exit within a bounded wait, escalating to SIGKILL.
- This matches 1.x isolation. It never starts, reuses, or restarts the operator's OpenCode background service (`opencode serve --service`). `Service.ensure()` can restart that service on a version mismatch, which would interrupt the operator's own sessions.
- The listen-line parser is an exported pure function, so it can be tested without spawning.

**External mode authenticates from the environment.**
- `opencode.url` (and `--opencode-url`) are unchanged.
- The password comes from `OPENCODE_PASSWORD`, falling back to `OPENCODE_SERVER_PASSWORD` (2.x still honors the latter). The username is always `opencode`, as in 2.x.
- No password key is added to `5x.toml`, so secrets stay out of committed config.

**A version gate replaces silent protocol failure.**
- `OpenCodeProvider.verify()` calls `client.server.info()` and requires `version >= MIN_OPENCODE_VERSION`, an exported constant. It starts at `2.4.0`, the oldest version the live test is verified on; Phase 2 may lower it only with a passing live run.
- A 1.x server or binary fails differently: 1.x prints a listen line the regex also matches, but the `server.info()` route (`/api/info`) is missing. Both failures map to "5x 2.x requires OpenCode 2.x (found <version or 1.x>) — run `opencode upgrade --major`".
- `UnauthorizedError` maps to "the OpenCode server requires a password — set OPENCODE_PASSWORD".
- `factory.createOpenCodeProvider` calls `verify()` in both managed and external mode; today only managed mode verifies. If `verify()` throws, the provider is closed before the error propagates. Closing an external provider never stops the server it connected to.
- The factory takes the OpenCode constructors through an optional internal seam, so unit tests exercise verification and cleanup with a fake provider and no network I/O.

**Sessions are headless and fully permitted.**
- `startSession` passes `permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "question", resource: "*", effect: "deny" }]`. This replaces 1.x `config: { permission: "allow" }`.
- The `question` deny keeps a headless run from blocking on an interactive form.
- Phase 2 verifies with the live test that a denied `question` fails fast. If it does not, the turn loop instead cancels any `form.created` for the session through `session.form.cancel` and reports a `text` notice; the turn continues.
- `parseModel` also accepts the 2.x `provider/model#variant` form and returns `{ providerID, id, variant? }`.
- `resumeSession` reads `location.directory` from `session.get`, and applies a model override with `session.switchModel`.

**One turn loop drives every prompt.** `runTurn(text, { stream, signal })` performs these steps:
1. Subscribe with `client.event.subscribe({ types, signal })`, filtered to the event types below, and wait for the `server.connected` marker with a 5 s bound. The 2.x stream is live-only, so it must be subscribed before prompting.
2. Snapshot a server-side baseline from `session.get`: tokens, cost, `outcome`, and `time.{busy, idle}`.
3. Call `session.prompt({ sessionID, text })` and keep the returned message id (`promptId`). This marks prompt admission only, not completion.
4. For events whose `data.sessionID` matches, map them to `AgentEvent`s until the first `session.execution.succeeded|failed|interrupted`.
5. If the stream errors or ends before a terminal event, poll every 500 ms. The admitted prompt's execution counts as newly settled only when both of these hold:
   - `session.get` shows the session idle with an `outcome` set: `time.idle` is set, is later than the baseline `time.idle` (when the baseline has one), and is not earlier than `time.busy`;
   - the durable transcript (step 7) contains `promptId`.

   A newly settled `failed` or `interrupted` outcome goes straight to `settleTurn` with no assistant-message prerequisite, because execution can fail during setup or be interrupted before any assistant message exists. An assistant reply is required only to recover a `succeeded` result: the transcript must also hold at least one assistant message after `promptId`, and polling continues until it does. Only server timestamps are compared with each other; no server timestamp is compared with a client clock. A baseline `outcome` left by an earlier turn never completes the turn. The inactivity timeout applies to polling too and resets when server-side progress changes (a new message or a token change). `signal` stays honored while polling.
6. Both paths settle through one terminal handler, `settleTurn(outcome)`. The streamed `session.execution.*` event and the polled `outcome` (`succeeded`, `failed`, `interrupted`) get identical treatment:
   - `succeeded`: continue to text extraction, usage, and any structured summary turn.
   - `failed`: an `error` carrying the server's error message, or "OpenCode execution failed" when none is available.
   - `interrupted` by our own timeout or cancel: `AgentTimeoutError` / `AgentCancellationError`.
   - `interrupted` for any other reason: an `error`.

   Only `succeeded` reads text or sends a summary or corrective prompt.
7. Read the turn text. The fast path is `session.context`: if `promptId` is present, the turn text is the text content of the `assistant` entries after it, up to the next user entry. `session.context` holds only messages since the last compaction, so if `promptId` is missing, page through the durable `session.message.list`, following its cursor until `promptId` is found, and take the assistant text after it across page boundaries. If the pages run out without finding `promptId`, the turn fails with `OpenCode turn reply not found: prompt <promptId> is missing from session <sessionID>`. It never falls back to all active context.
8. Tokens and cost for the turn are the `session.get` delta (`tokens.input`, `tokens.output`, `cost`).

Failure handling:
- `execution.failed` and `step.failed` yield `error` events carrying `error.message`. `execution.failed` and `execution.interrupted` settle through `settleTurn`, the same handler the polling path uses.
- The inactivity timeout (reset on each session event, or on server-side progress while polling) and external cancellation call `session.interrupt({ sessionID })`. The existing `AgentTimeoutError` / `AgentCancellationError` semantics and messages are kept.
- `run()` consumes `runStreamed()`, as `packages/provider-cursor-agent/src/session.ts` already does. This removes the duplicated execute/summary logic and the 1.x abort-recovery polling (`waitForRecoveredPromptResult`).

**Structured output is prompted and parsed, then validated by the caller.**
- 2.x has no `format` option. The two-phase design stays: a streamed execute turn, then a non-streamed summary turn.
- The summary prompt is `buildStructuredSummaryPrompt(schema)` plus the schema and the rule "your final message must be exactly one JSON object and nothing else".
- `src/providers/structured-output.ts` extracts the object. It tries exact JSON, then a fenced block, then the last complete top-level object in the text.
  - The precedence matches `packages/provider-cursor-agent/src/structured.ts`. The scanning algorithm does not. That package walks backward from each `{` and counts braces with no string state, so it returns an inner object (`{"result":"complete","metadata":{"commit":"abc"}}` yields `{"commit":"abc"}`) and rejects valid JSON with a brace inside a string.
  - The new scanner walks forward once. Depth counts both `{` and `[`. Inside an open span it tracks JSON string and escape state, so braces, brackets, and escaped quotes inside strings do not change depth. Prose outside a span is never treated as string content.
  - Each `{…}` span that opens at depth 0 is a candidate. A `{` nested inside an object or array never is, so `[{"result":"complete"}]` yields no candidate. Candidates are tried from last to first with `JSON.parse`, and the first that parses to an object wins.
  - The Cursor workspace package is published separately and is left unchanged.
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

**Delete the dead TUI path instead of porting it.** Removing `@opencode-ai/sdk` forces a choice for the four modules that import its types. Porting them would mean rebuilding `opencode attach` integration and permission replies against 2.x for code no command calls. They are deleted with their tests, as is the stale init hint. `tsconfig.json` typechecks all of `src`, `test`, and `packages`, so the deletion is Phase 1. It lands before Phase 2 removes the SDK dependency, which lets Phase 2's typecheck gate pass.

**Harness agents use 2.x-native frontmatter.**
- Agent templates drop `name:`; 2.x derives the id from the filename.
- The orchestrator's `tools:` block becomes `permissions: [{ action: edit, resource: "*", effect: deny }]`.
- `5x-plan-author`, `5x-code-author`, and `5x-reviewer` gain `permissions: [{ action: subagent, resource: "*", effect: deny }]`. This enforces "subagents do not launch subagents" instead of only asserting it.
- `renderAgentTemplates` model injection is unchanged; `model: "provider/model"` and `#variant` are valid 2.x.
- The orchestrator body describes the background delegation lifecycle below. Its continuation instructions (today `task_id` and "agent id", at `5x-orchestrator.md:73,83,88`) name `sessionID` and the child `sessionID` saved from the launch acknowledgment.

**OpenCode native delegation is asynchronous; Cursor's stays synchronous.**
- In 2.x a `subagent` call always runs the child in the background. The tool result is a launch acknowledgment carrying the child `sessionID`, not the child's answer. The parent gets a completion report each time the child goes idle.
- So every OpenCode-native delegation example has separate steps:
  1. Launch, and save `CHILD_SESSION_ID` from the acknowledgment.
  2. Wait for the completion report from that `CHILD_SESSION_ID`.
  3. Take the final author/reviewer JSON from that report as `RESULT`.
  4. Validate and record `RESULT` against the `$STEP` rendered for this delegation.
- The launch acknowledgment is never piped to `5x protocol validate`.
- Reports from any other child session (an earlier step or another delegation) are never recorded against the current `$STEP`.
- Delegate one step at a time: do not render or launch the next step until the current child's result is recorded.
- A completion report with no valid author/reviewer object goes through the skill's existing invalid-result recovery and is not recorded.
- Reviewer continuation passes the saved `CHILD_SESSION_ID` (kept as `$NATIVE_SUBTASK_ID`) as `sessionID`.
- Rendered OpenCode shape, for the plan-review example:

  ```bash
  # 2. Launch subagent via `subagent` tool
  LAUNCH=<`subagent` tool: agent="5x-reviewer", prompt=$PROMPT,
          sessionID=$NATIVE_SUBTASK_ID (omit if empty)>
  CHILD_SESSION_ID=<sessionID from LAUNCH>
  # The subagent runs in the background. LAUNCH is only an acknowledgment:
  # never validate it. Wait for the completion report from $CHILD_SESSION_ID
  # and ignore reports from other child sessions.
  RESULT=<final JSON object from $CHILD_SESSION_ID's completion report>

  # 3. Validate + record
  VALIDATED=$(echo "$RESULT" | 5x protocol validate reviewer --record --step $STEP ...)

  # 4. Keep the child session for reuse in subsequent reviews
  NATIVE_SUBTASK_ID=$CHILD_SESSION_ID
  ```

**Harness skill tokens carry the delegation tool and its lifecycle.**
- Rendering uses the existing harness token map in `src/skills/harness-tokens.ts`. A token value may span several lines.
- `src/skills/harness-tokens.ts` gains these tokens alongside `NATIVE_CONTINUE_PARAM`:

| Token | OpenCode | Cursor |
|---|---|---|
| `NATIVE_DELEGATE_TOOL` | `` `subagent` tool `` | `Task tool` |
| `NATIVE_AGENT_PARAM` | `agent` | `subagent_type` |
| `NATIVE_CONTINUE_PARAM` | `sessionID` (was `task_id`) | `resume` (unchanged) |
| `NATIVE_LAUNCH_VAR` | `LAUNCH` | `RESULT` |
| `NATIVE_AWAIT_RESULT` | A newline, then the `CHILD_SESSION_ID=` line, the wait/correlation comment, and the `RESULT=<final JSON … completion report>` line shown above | empty string |
| `NATIVE_CHILD_ID_SOURCE` | `$CHILD_SESSION_ID` | the current `<agent id from Task tool result>` wording |

- Base skill templates use the tokens:
  - wherever they hard-code "Task tool" or `subagent_type`;
  - at every native launch site (`RESULT=<Task tool: …>`), as `[[NATIVE_LAUNCH_VAR]]=<…>[[NATIVE_AWAIT_RESULT]]`;
  - at every point that captures the continuation id.
- If capture wording differs between sites, add a narrower token per wording rather than rewording Cursor text.
- Each Cursor value reproduces the current text exactly at every site it replaces. Cursor's rendered skills stay byte-identical, which a fixture test proves. The universal harness renders no native branches and is unaffected.

**Asset-impact matrix (AGENTS.md).**

| Surface | Change |
|---|---|
| Document skeletons (`src/templates/default-artifacts.ts`) | Unchanged: no plan, review, or brief structure depends on the provider transport |
| Agent prompts (`src/templates/*.md`, initial and continued variants) | Runtime-rendered role prompts are expected to stay transport-neutral and unchanged; Phase 4 greps them for "Task tool", `subagent_type`, `task_id`, and OpenCode-specific wording and fixes any hit. The OpenCode harness agent bodies change: the orchestrator's continuation references become `sessionID` and it describes background completion |
| Runtime-appended context, native/invoke parity | Unchanged: appended context is produced by `5x template render` independently of the provider; Phase 4 re-runs the existing parity tests |
| Workflow skills (`src/skills/base/`) | Changed: delegation tool, agent parameter, continuation parameter, and the OpenCode background launch/await/continue lifecycle become harness tokens. Verified for OpenCode in all-native, all-invoke, and both mixed author/reviewer modes, and byte-identical for Cursor |
| Installation, override, upgrade, harness sync | Rendered agent and skill content changes, so harness freshness reports existing OpenCode installs as stale; `5x harness sync opencode` and `5x upgrade` refresh them. Verified through the effective installed files and a live 2.x server, including one real native delegation and continuation by the installed orchestrator, not only the bundled source. User override resolution is unchanged |

## Delivery Budget

- Estimate confidence: medium

| ID | Work item | Effort | Architecture delta | Debt claim | Addresses | Rationale |
|---|---|---:|---:|---|---|---|
| W1 | Provider core port to `@opencode/client`: dependency swap, managed private-server lifecycle (spawn, listen parsing, startup-timeout kill, output draining), external auth, version gate, headless session permissions, 2.x event mapper and exports | 5 | 0 | - | - | Major migration against a new, fast-moving server protocol. The provider construction and mapper are rewritten rather than patched, and uncertainty remains in the `question` deny and 2.x event shapes. Rescored 11 → 5 only because the former 11-point row (an invalid point value) was split into W1, W7, and W8, which together held 11 at v1.2. The v1.4 W7 re-estimate raises the combined W1 + W7 + W8 effort to 13 without changing W1. W1 keeps the original pre-review core of construction, lifecycle, auth, version gate, permissions, and mapper. The turn loop and R3/R4 work moved to W7; the factory seam, live test, and R6 work moved to W8. Architecture stays neutral: process management moves from the SDK into 5x (+), offset by removing the 1.x SDK startup path (−). |
| W7 | Provider turn loop: prompt admission and streamed completion, server-evidence polling fallback settling through a shared `settleTurn`, compaction-safe durable-transcript text recovery (`readTurnText` with paginated `session.message.list`), `run()` over `runStreamed()`, and their unit tests | 5 | 0 | - | R3, R4 | Split from the former 11-point W1 row with no change to scope. Rescored 3 → 5 in v1.4 as a re-estimate of the same scope, not a scope change. Two things were missing from the 3. First, the v1.2 split held W1 + W7 + W8 at 11 by arithmetic, which left the core turn loop about one point once the R3 and R4 increments were counted. Second, the R3 closure correction (addendum iteration 2, reviewer effortDelta +1: newly settled `failed`/`interrupted` outcomes reach `settleTurn` without an assistant-message prerequisite, plus SSE-drop-before-assistant fixtures) was carried only as run_a9914ec93486's final-corrections allowance and never entered this ledger. A new run inherits no correction allowance, so the row must carry it. Combined work: the core turn loop (subscription handshake, prompt admission, streamed mapping, inactivity timeout and interrupt, `run()` over `runStreamed()` with the summary turn), replacing about 540 lines (`opencode.ts:186–727`); R3 server-evidence polling and shared `settleTurn` (+1), and its closure correction (+1); R4 paginated durable text recovery (+1). About 25 scripted cases in the rewritten 1,126-line `opencode.test.ts` cover this work. That re-estimates above 3. 4 is not an allowed value, so the row is scored 5 rather than rounded down to 3. Uncertainty sits in stream timing and interrupt behavior. Includes R3 (+1 reviewer effortDelta: polling completes on server-side evidence and settles through the streamed path's terminal handler, with outcome, stale-state, clock-skew, timeout, and cancel cases; closure +1 as above) and R4 (+1: a paginated `session.message.list` fallback when compaction drops the prompt from context, with an explicit missing-boundary error). Architecture neutral: one turn loop replaces the duplicated 1.x run paths and recovery polling, and the corrections reuse it rather than adding an abstraction. |
| W8 | Factory verification and live evidence: external-provider verification and close-on-failure in `src/providers/factory.ts`, the `OpenCodeFactoryDeps` test seam with fake healthy, unauthorized, and cleanup tests, network-free bundled plugin-loading case, and the opt-in live test covering managed and authenticated external mode against a test-owned server | 3 | 0 | - | R6 | Split from the former 11-point W1 row with no change to scope. Re-examined in v1.4 and unchanged; the combined W1 + W7 + W8 effort is 13 after the W7 re-estimate. Includes R6 (+1 reviewer effortDelta): an injectable factory seam with fake verification and cleanup tests, plus a live authenticated external-mode run against a test-owned server that survives `close()`. Architecture neutral: the seam is a test-only dependency parameter on the existing factory, and the live test extends the existing opt-in fixture. |
| W2 | Prompted structured output: `structured-output.ts` string-aware top-level extractor, schema-wrapped summary prompt, corrective retries | 3 | 1 | - | R5 | A small new module inside the provider subsystem replaces a server feature 2.x removed. +1 architecture because 5x now owns extraction and retry policy for OpenCode, beside the Cursor package's separate extractor. Rescored 2 → 3 for R5: the extractor is a new forward scanner with string, escape, and depth state and nested, escaped-quote, string-brace, multiple-object, and array rejection tests. It does not port the Cursor package's backward brace counter. Architecture unchanged: the scanner sits inside the already planned module. |
| W3 | Delete dead TUI controller, permissions, detect, and event-router modules, their tests, and the stale init hint | 1 | -2 | DC0 (`intrinsic`) | R1 | Deletion only, after confirming there are no importers. Removes about 1.2k production lines and about 1.4k test lines tied to the retired `opencode attach` path. R1: moved to Phase 1, ahead of the provider port, so the SDK dependency removal and its typecheck gate in Phase 2 can pass. Reordering existing work leaves effort and architecture unchanged. v1.4 evidence: completed in Phase 1 (`fa19978d`, independently reviewed in `ce74d860`). Actual work matched the score: about 1.23k production lines and 1.37k test lines deleted, plus two one-line edits. Score unchanged. |
| W4 | `5x doctor` OpenCode version check and `opencode.url` config description | 2 | 1 | - | - | A new detect-only check in the existing doctor registry, plus a config description update. +1 for one more check to maintain. |
| W5 | Harness assets: 2.x agent frontmatter, `NATIVE_DELEGATE_TOOL` / `NATIVE_AGENT_PARAM` tokens and OpenCode `sessionID` continuation, OpenCode background launch/await/continue lifecycle tokens, base skill and orchestrator wording and continuation references, asset-impact verification across delegation modes and install/sync paths, live installed native delegation and continuation exercise | 5 | 0 | - | R2 | Crosses harness templates, the token system, five base skills, and the install/sync path. Rescored 3 → 5 for R2 (the reviewer's effortDelta of 2). The work adds lifecycle tokens at every native launch and continuation-capture site, reworks the orchestrator's `task_id` continuation instructions, adds launch-versus-completion and continuation assertions in all four delegation modes, and adds one real delegation and continuation by the installed orchestrator on a live 2.x server. No new abstraction: the token mechanism already exists and gains entries, and Cursor output stays byte-identical. |
| W6 | Documentation and release notes: CHANGELOG, upgrade guide, getting started, configuration, README, harness README, AGENTS.md test layout | 2 | 0 | - | - | Documentation across existing files. |

### Debt Claims

#### DC0

- Target phase: phase-1
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
| operator | AC1: `5x invoke` with `provider = "opencode"` works against OpenCode 2.x in managed and external mode, including streamed events and structured author/reviewer results | W1, W7, W8, W2 / Phase 2 | Unit tests with a scripted fake client and a fake factory seam (healthy, unauthorized, verification-failure cleanup); opt-in live test passing against a local OpenCode ≥ `MIN_OPENCODE_VERSION` for a managed provider and for an authenticated external provider against a test-owned server; manual end-to-end `5x invoke` in a temp project in both managed and external (`--opencode-url` with `OPENCODE_PASSWORD`) mode |
| operator | AC2: 5x 2.0 requires OpenCode 2.x and says so clearly when given 1.x or an older 2.x | W1, W4 / Phases 2, 3 | Version-gate unit tests (1.x server, old 2.x, unauthorized); `5x doctor` finding with a fake 1.x `opencode` on `PATH` |
| operator | AC3: the installed OpenCode harness is 2.x-native: no 1.x-only frontmatter, correct delegation tool, parameters, and background completion lifecycle in skills, no OpenCode warnings on load | W5 / Phase 4 | Harness and skill unit tests, including launch-versus-completion separation and `sessionID` continuation in all four delegation modes; live check of `/api/agent` and `/api/skill` against an installed temp project with no "ignored unsupported agent fields" log line; one live native delegation and continuation by the installed orchestrator |
| operator | AC4: managed mode never touches the operator's OpenCode background service | W1, W8 / Phase 2 | Unit test that the spawn argv contains `serve` without `--service`; no `Service` import in `src/providers/opencode.ts`; live test leaves no `opencode serve` child running |
| operator | AC5: the dead OpenCode TUI path is removed | W3 / Phase 1 | No `src/tui/` or `src/utils/event-router.ts`; grep shows no importers; init output has no `--tui-listen` hint |

## Phase 1: Delete the dead TUI path

This phase runs first. It removes every remaining `@opencode-ai/sdk` importer outside the provider, so Phase 2 can drop the dependency and still pass typecheck.

**Completion gate:**
- `src/tui/` and `src/utils/event-router.ts` no longer exist.
- `rg 'from "[^"]*(/tui/|event-router)' src packages test` finds no importers.
- `rg -l "@opencode-ai/sdk" src packages test` lists only `src/providers/opencode.ts`, `src/providers/event-mapper.ts`, and `test/unit/providers/event-mapper.test.ts`, which Phase 2 rewrites.
- `5x init` output no longer mentions `--tui-listen`.
- `bun run typecheck` and `bun test test/unit` pass.

### 1.1 Tasks

- [x] Re-confirm no importers of `src/tui/*` or `src/utils/event-router.ts` in `src/`, `packages/`, or `test/` outside their own tests
- [x] Delete `src/tui/controller.ts`, `src/tui/permissions.ts`, `src/tui/detect.ts`, `src/utils/event-router.ts`, and `test/unit/tui/*` (`controller.test.ts`, `permissions.test.ts`, `phase4-integration.test.ts`)
- [x] Remove the `External TUI is opt-in: use --tui-listen` line at `src/commands/init.handler.ts:499` and any test asserting it
- [x] Remove the `tui/` entry from the AGENTS.md test directory layout

## Phase 2: Provider port to `@opencode/client`

**Completion gate:**
- `src/providers/opencode.ts` and `src/providers/event-mapper.ts` import only `@opencode/client`, and `@opencode-ai/sdk` is gone from `package.json` and `bun.lock`.
- Managed and external providers pass the version gate against OpenCode 2.x.
- `run()` and `runStreamed()` return correct text, events, tokens, and structured output on both the streamed and the polling path.
- `bun test test/unit/providers`, `bun run typecheck`, and `bun run build` pass.
- `FIVEX_OPENCODE_LIVE=1 bun test test/integration/providers/opencode-live.test.ts` passes for the managed and authenticated external cases against a local OpenCode ≥ `MIN_OPENCODE_VERSION`.

### 2.1 Dependency

- `package.json`: remove `"@opencode-ai/sdk": "^1.2.6"`; add `"@opencode/client": "<exact latest 2.x>"`; refresh `bun.lock`.
- Import only from `@opencode/client` (the Promise root). Do not import `@opencode/client/effect`, `/solid`, or `/service`.

### 2.2 Provider construction (`src/providers/opencode.ts`)

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
- The factory gains an optional internal test seam, threaded from `createProvider`:

  ```ts
  /** @internal test seam; defaults to the OpenCodeProvider statics. */
  export interface OpenCodeFactoryDeps {
  	createManaged(opts: { model?: string }): Promise<OpenCodeProvider>;
  	createExternal(url: string, opts: { model?: string }): OpenCodeProvider;
  }
  export async function createProvider(
  	role: "author" | "reviewer",
  	config: FiveXConfig,
  	deps?: { openCode?: OpenCodeFactoryDeps },
  ): Promise<AgentProvider>;
  ```

  Production callers pass no `deps`. Unit tests inject a fake whose `verify()` and `close()` record calls. No module-level mutable state is used, so tests stay safe under `--concurrent`.

### 2.3 Turn loop and session (`src/providers/opencode.ts`)

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
- The inactivity timeout resets on every event for the session, and while polling on server-side progress. On timeout or cancel, `session.interrupt` is best-effort and its errors are swallowed.
- Events for any other `sessionID` on the shared stream are dropped before mapping. They neither reset the timeout nor end the turn.
- A private `settleTurn(outcome)` is the only place that turns a terminal outcome into a result or error. The streamed terminal event and the polled `session.get` outcome both call it (Design Decisions, turn loop step 6).
- A private `readTurnText(promptId)` uses the `session.context` fast path. When compaction has removed the prompt, it falls back to paginated `session.message.list`, and it raises the explicit missing-boundary error (turn loop step 7).
- `RunResult.tokens` / `costUsd` come from the `session.get` delta, summed across the execute turn and any summary and corrective turns.

### 2.4 Structured output (`src/providers/structured-output.ts`, new)

```ts
export type StructuredExtractResult = { ok: true; value: unknown } | { ok: false };
export function extractStructuredJson(text: string): StructuredExtractResult;
export function buildStructuredOutputPrompt(base: string, schema: JSONSchema): string;
export function buildCorrectivePrompt(schema: JSONSchema): string;
```

- `buildStructuredSummaryPrompt` (`src/providers/opencode.ts:143`) stays; it supplies `base`.
- The extraction precedence (exact, fenced, last top-level object) matches `packages/provider-cursor-agent/src/structured.ts`. The scanner is the new forward, string- and escape-aware, top-level-only scanner in Design Decisions, not a port of that package's backward brace counter. Only objects (not arrays or scalars) count as a result.
- Maximum of two corrective turns.

### 2.5 Event mapper (`src/providers/event-mapper.ts`, rewrite)

```ts
export interface EventMapperState { toolNames: Map<string, string> }
export function createEventMapperState(): EventMapperState;
export function eventSessionId(event: OpenCodeEvent): string | undefined; // data.sessionID
export function mapOpenCodeEvent(event: OpenCodeEvent, state: EventMapperState): AgentEvent | undefined;
export function summarizeToolInput(tool: string, input: unknown): string;
```

- Remove `SessionResolveContext`, `resolveSessionIdWithContext`, `getEventSessionId`, `MAX_TRACKED_DELTA_PART_IDS`, `mapSseToAgentEvent`, and `mapSseStreamToAgentEvents`.
- Update the exports in `src/providers/index.ts` and `src/index.ts` (around lines 281–294) to the new names. This is an allowed 2.0 public API change, recorded in the CHANGELOG in Phase 5.

### 2.6 Tests

- `test/unit/providers/opencode.test.ts` (rewrite) uses a structural fake `OpenCodeClient` whose `event.subscribe` yields scripted events and whose `session.*` methods record calls. Cases:
  - `parseServeListenUrl` on the 2.x line, on a partial chunk, and on noise;
  - `parseModel` with and without `#variant`, and invalid input;
  - managed spawn argv has `serve`, `--hostname=127.0.0.1`, `--port=0`, no `--service`, and `OPENCODE_PASSWORD` in env;
  - managed spawn exiting before the listen line reports stderr;
  - managed spawn that never prints the listen line times out at the bound, kills the process, and leaves no child;
  - stdout and stderr keep draining after the listen line: a fake child that writes past a pipe buffer does not block, and the stderr tail stays bounded;
  - external auth header from `OPENCODE_PASSWORD`, from `OPENCODE_SERVER_PASSWORD`, and none;
  - `createExternal` construction-only assertions (base URL, auth header, no request sent);
  - version gate: ok, old 2.x, a 1.x-style failure, and unauthorized;
  - `startSession` sends `location`, `model`, and the headless permissions;
  - `resumeSession` reads the directory and calls `switchModel` only on override;
  - streamed text, reasoning, and tool events in order, ending on `execution.succeeded`;
  - `execution.failed` and `step.failed` produce an error;
  - events for a foreign `sessionID` on the shared stream yield no `AgentEvent`, do not reset the timeout, and do not end the turn;
  - polling fallback when the stream ends early, once per outcome:
    - `succeeded` returns text and usage;
    - `failed` produces the same error as the streamed `execution.failed`;
    - `interrupted` by our own cancel or timeout raises `AgentCancellationError` / `AgentTimeoutError`;
    - a foreign `interrupted` produces an error.

    Each case matches the streamed result for the same outcome, and only `succeeded` sends a structured summary prompt;
  - SSE drops before any assistant message, then polling sees a new server idle time, the admitted `promptId` with no assistant message after it, and `outcome: "failed"` (and, separately, a foreign `interrupted`): the turn terminates with that original outcome's error, sends no summary prompt, and settles on that poll without waiting for the inactivity timeout;
  - polling with a stale prior state: the baseline already shows `outcome: "succeeded"` and an idle time from an earlier turn, and the turn does not complete until the server reports a new idle time and the transcript has a reply after `promptId`;
  - polling under remote clock skew, with server timestamps hours ahead of and behind the client, completes correctly and never early;
  - polling inactivity timeout calls `interrupt` and raises `AgentTimeoutError`; cancel during polling calls `interrupt` and raises `AgentCancellationError`;
  - turn text from `session.context` uses only assistant entries after the prompt id;
  - compaction removed `promptId` from `session.context`: the text comes from `session.message.list`;
  - a reply spanning more than one `session.message.list` page is concatenated in order;
  - `promptId` missing from both context and every message page raises the explicit missing-boundary error and does not return other context text;
  - token and cost delta;
  - inactivity timeout and external cancel call `interrupt` and keep the error types and messages;
  - structured: success first try, success after one corrective turn, failure after two;
  - `run()` equals the `done` result of `runStreamed()`;
  - `close()` is idempotent and kills the managed process.
- `test/unit/providers/opencode-factory.test.ts` (new) calls `createProvider` with an injected `OpenCodeFactoryDeps` fake and no network I/O:
  - external healthy: `verify()` runs and the provider is returned;
  - external unauthorized: the password error propagates and the provider is closed;
  - external verification failure (1.x or old 2.x): the error propagates and the provider is closed;
  - managed verification failure: the provider is closed;
  - `opencode.url` selects `createExternal`, and its absence selects `createManaged`.
- `test/unit/providers/event-mapper.test.ts` (rewrite) covers each mapping row, the tool id→name map, a missing name falling back to `unknown`, `tool_end` truncation, `summarizeToolInput` for `shell`, `read` (`path`), `edit`, `glob`, `grep`, `subagent`, and unknown tools, and `eventSessionId` returning `data.sessionID`. Foreign-session isolation is asserted at the provider level in `opencode.test.ts`.
- `test/unit/providers/structured-output.test.ts` (new) covers:
  - exact JSON;
  - fenced block;
  - prose then trailing object;
  - prose-prefixed object with a nested object (`Here is the result:\n{"result":"complete","metadata":{"commit":"abc"}}` returns the outer object);
  - `}` and `{` inside a string value (`{"result":"complete","reason":"a } brace"}`);
  - an escaped quote followed by a brace inside a string;
  - a stray double quote in prose before the object;
  - several top-level objects, where the last parseable one wins;
  - a top-level array containing an object rejected;
  - a scalar rejected;
  - empty input.
- `test/unit/providers/plugin-loading.test.ts`: the bundled-provider case injects the `OpenCodeFactoryDeps` fake. It asserts that `opencode` routes to the bundled factory without dynamic import or network I/O, with no `catch` branch that could hide a failure.
- `test/integration/providers/opencode-live.test.ts` (new) is skipped unless `FIVEX_OPENCODE_LIVE=1` and `opencode --version` reports ≥ `MIN_OPENCODE_VERSION`. Model comes from `FIVEX_OPENCODE_LIVE_MODEL`, default `opencode/deepseek-v4.1-flash-free`. In a temp directory containing `hello.txt`:
  - Managed mode:
    - `runStreamed` asks for a shell `cat hello.txt` and a reply containing the token, and expects `tool_start` (`shell`), `tool_end`, `text`, `usage`, and `done`;
    - a second run with an `AuthorStatus`-shaped `outputSchema` returns an object;
    - after `close()`, no child `opencode serve` process remains.
  - Authenticated external mode, against a test-owned server:
    - The test starts `opencode serve --hostname=127.0.0.1 --port=0` with a random `OPENCODE_PASSWORD`.
    - In a `test.serial` case it sets and then restores `process.env.OPENCODE_PASSWORD`, and builds the provider through `createProvider` with `opencode.url` set to that server.
    - It runs the same streaming and structured-output checks.
    - Without the password, `createProvider` fails with the password error.
    - After the provider's `close()`, the test-owned server process is still alive and answers an authenticated `server.info()`. The test then stops it in `afterAll`.

  Uses `stdin: "ignore"` and `timeout: 120000`.

- [ ] Replace `@opencode-ai/sdk` with an exact-pinned `@opencode/client` in `package.json` and `bun.lock`
- [ ] Implement managed spawn (startup-timeout kill, continuous output draining), external auth, `verify()` version gate, and error mapping in `src/providers/opencode.ts`
- [ ] Implement headless `startSession`, `resumeSession` with `switchModel`, and `#variant` model parsing
- [ ] Implement `runTurn` with subscription handshake, terminal events, server-evidence polling fallback, and token/cost delta
- [ ] Implement `settleTurn` as the single terminal-outcome handler for the streamed and polling paths
- [ ] Implement `readTurnText` with the `session.context` fast path, paginated `session.message.list` fallback, and missing-boundary error
- [ ] Rebuild `runStreamed()` and `run()` on `runTurn`, keeping timeout and cancellation semantics
- [ ] Add `src/providers/structured-output.ts` with the string-aware top-level scanner, and the structured summary with corrective retries
- [ ] Rewrite `src/providers/event-mapper.ts` for 2.x events and update `src/providers/index.ts` / `src/index.ts` exports
- [ ] Make `createOpenCodeProvider` verify external providers and close on verify failure, through the `OpenCodeFactoryDeps` seam
- [ ] Verify the `question` deny fails fast in the live test, or implement the `form.cancel` fallback
- [ ] Rewrite `opencode.test.ts` and `event-mapper.test.ts`; add `structured-output.test.ts` and `opencode-factory.test.ts`; update the `plugin-loading.test.ts` bundled case to use the fake seam
- [ ] Add the opt-in live test with managed and authenticated external cases and pass it against local OpenCode 2.x; set `MIN_OPENCODE_VERSION` to the oldest verified version
- [ ] Confirm `bun run build` compiles with the new dependency

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
- Every OpenCode-native delegation example separates the launch acknowledgment (`CHILD_SESSION_ID`) from the completed result. It validates and records only `RESULT` from the child's completion report and continues with the saved child `sessionID`. The orchestrator body contains no `task_id`.
- Cursor skill output is byte-identical to before.
- A live 2.x server lists the four agents and all 5x skills with no "ignored unsupported agent fields" log.
- On that server, the installed orchestrator completes one native delegation and one continuation of the same child session.
- `5x harness sync opencode` refreshes a pre-upgrade install.
- The AGENTS.md acceptance suite passes.

### 4.1 Agent templates

- `src/harnesses/opencode/5x-orchestrator.md`:
  - Remove `name:` and `tools:`.
  - Add a `permissions:` list with `{action: edit, resource: "*", effect: deny}`.
  - In the body, replace "Task tool" wording (lines 43 and 79) with "`subagent` tool".
  - Add the background lifecycle to the principles:
    - native subagents run in the background;
    - the launch returns only a `sessionID` acknowledgment;
    - wait for that child's completion report and validate only the completed author/reviewer JSON;
    - delegate one step at a time and never record another child's report against the current step.
  - Continuation references (lines 73, 83, 88):
    - "fresh task (omit `task_id`)" becomes "fresh subagent (omit `sessionID`)";
    - "pass the Task tool's `task_id` with the prior delegation's agent id" becomes "pass the `subagent` tool's `sessionID` with the child `sessionID` saved from the prior launch acknowledgment";
    - "native Task reuse via `task_id`" becomes "native subagent reuse via `sessionID`".
    - Keep the rule that this id is never passed to `5x template render --session`.
  - Keep the principle that the orchestrator runs the loop itself.
- `src/harnesses/opencode/5x-plan-author.md`, `5x-code-author.md`, `5x-reviewer.md`: remove `name:` and add `permissions:` with `{action: subagent, resource: "*", effect: deny}`. In the reviewer body, rename tool references to 2.x ids (`shell` for `bash`).
- `src/harnesses/opencode/loader.ts`: update the header comment (tool ids `read`, `edit`, `shell`, `glob`, `grep`, `subagent`, `skill`, and 2.x frontmatter fields). `injectModel` is unchanged.
- `src/harnesses/opencode/README.md`: frontmatter fields, the permissions rules, the background delegation lifecycle, and "requires OpenCode 2.x".

### 4.2 Skill tokens

```ts
export const SKILL_TOKENS = {
	NATIVE_CONTINUE_PARAM: "NATIVE_CONTINUE_PARAM",
	NATIVE_DELEGATE_TOOL: "NATIVE_DELEGATE_TOOL",
	NATIVE_AGENT_PARAM: "NATIVE_AGENT_PARAM",
	NATIVE_LAUNCH_VAR: "NATIVE_LAUNCH_VAR",
	NATIVE_AWAIT_RESULT: "NATIVE_AWAIT_RESULT",
	NATIVE_CHILD_ID_SOURCE: "NATIVE_CHILD_ID_SOURCE",
	// plus any narrower capture-wording tokens 4.2 requires
} as const;
```

- `src/skills/harness-tokens.ts` (lines 9–11) adds the tokens. `resolveSkillTokens` already substitutes multi-line values unchanged.
- `src/harnesses/opencode/skills/loader.ts` (lines 28–30) maps:
  - `NATIVE_DELEGATE_TOOL`: `` `subagent` tool ``
  - `NATIVE_AGENT_PARAM`: `agent`
  - `NATIVE_CONTINUE_PARAM`: `sessionID`
  - `NATIVE_LAUNCH_VAR`: `LAUNCH`
  - `NATIVE_AWAIT_RESULT`: a newline, then the `CHILD_SESSION_ID=<sessionID from LAUNCH>` line, the background/correlation comment, and `RESULT=<final JSON object from $CHILD_SESSION_ID's completion report>` (Design Decisions)
  - `NATIVE_CHILD_ID_SOURCE`: `$CHILD_SESSION_ID`
- `src/harnesses/cursor/skills/loader.ts` (lines 15–17) maps:
  - `NATIVE_DELEGATE_TOOL`: `Task tool`
  - `NATIVE_AGENT_PARAM`: `subagent_type`
  - `NATIVE_LAUNCH_VAR`: `RESULT`
  - `NATIVE_AWAIT_RESULT`: empty string
  - `NATIVE_CHILD_ID_SOURCE`: the exact current capture text (`<agent id from Task tool result>`)
- Replace the hard-coded "Task tool" and `subagent_type` occurrences with tokens. Current counts per file:

  | File | Occurrences |
  |---|---:|
  | `src/skills/base/5x/SKILL.tmpl.md` | 5 |
  | `src/skills/base/5x-plan/SKILL.tmpl.md` | 4 |
  | `src/skills/base/5x-plan-review/SKILL.tmpl.md` | 12 |
  | `src/skills/base/5x-phase-execution/SKILL.tmpl.md` | 14 |
  | `src/skills/base/5x-issue-resolution/SKILL.tmpl.md` | 4 |

  Pseudo-call examples such as `RESULT=<Task tool: subagent_type=<agent>, prompt=$PROMPT>` become `[[NATIVE_LAUNCH_VAR]]=<[[NATIVE_DELEGATE_TOOL]]: [[NATIVE_AGENT_PARAM]]=<agent>, prompt=$PROMPT>[[NATIVE_AWAIT_RESULT]]`.
- Native launch sites that get the launch/await tokens:
  - `5x/SKILL.tmpl.md:185`;
  - `5x-plan/SKILL.tmpl.md:178`;
  - `5x-plan-review/SKILL.tmpl.md:155, 296, 388`;
  - `5x-phase-execution/SKILL.tmpl.md:285, 383, 437, 566`;
  - `5x-issue-resolution/SKILL.tmpl.md:346`.
- Each site's following `5x protocol validate` keeps reading `$RESULT`.
- Continuation-id capture sites use `[[NATIVE_CHILD_ID_SOURCE]]`:
  - `5x-plan-review/SKILL.tmpl.md:164–165`;
  - `5x-phase-execution/SKILL.tmpl.md:483`;
  - any other place that sets `$NATIVE_SUBTASK_ID` from the tool result.
- Where a capture site's Cursor wording differs from the shared value, add a narrower token whose Cursor value is that site's exact text.
- Prose that says to launch "then validate and record the result" gains OpenCode-only wording through a token: wait for the child's completion report first. The Cursor value is empty or identical to the current text.
- Any instruction to load a skill by `name` says `id` for OpenCode, using the same token approach if wording differs between harnesses.
- `src/harnesses/cursor/5x-orchestrator.mdc` is not changed.

### 4.3 Asset-impact verification

- Grep `src/templates/*.md` (initial and continued prompts) and `src/templates/default-artifacts.ts` for "Task tool", `subagent_type`, `task_id`, and OpenCode wording. Fix any hit, and record "no change" in the PR description otherwise.
- Re-run the native/invoke appended-context parity tests unchanged.
- Render OpenCode skills in all-native, all-invoke, author-invoke/reviewer-native, and author-native/reviewer-invoke modes. Assert that:
  - no `[[` token remains;
  - native branches name the `subagent` tool, `agent`, and `sessionID`;
  - at every native launch site, `LAUNCH=`, `CHILD_SESSION_ID=`, and `RESULT=<… completion report>` appear in that order before the step's `5x protocol validate`, which reads `$RESULT` and never `$LAUNCH`;
  - reviewer continuation passes `sessionID=$NATIVE_SUBTASK_ID`, and `$NATIVE_SUBTASK_ID` is set from `$CHILD_SESSION_ID`;
  - invoke branches contain no native tool, `LAUNCH=`, or `CHILD_SESSION_ID`.
- Live installed exercise (effective installed assets, not the bundled source):
  - Setup: a temp project with `5x harness install opencode --scope project` and a password-protected 2.x server.
  - Through the server API, start a session with the installed `5x-orchestrator` agent. Instruct it to use the `subagent` tool to delegate to `5x-reviewer` a prompt asking for a given reviewer-status JSON, generated with `5x protocol emit reviewer`.
  - After the completion report, instruct it to continue the same child by `sessionID` with a second, distinct JSON request.
  - Confirm that:
    - each JSON the orchestrator reports is the child's completed answer, not the launch acknowledgment;
    - both pass `5x protocol validate reviewer` without recording;
    - the server shows one child session holding both requests;
    - the reviewer child is denied the `subagent` tool.
  - Record the transcript summary in the PR description.

### 4.4 Tests

- `test/unit/harnesses/opencode.test.ts`:
  - replace the `write: false` assertions (around lines 274–321) with `permissions` assertions;
  - assert no `name:` or `tools:` in any template, and the subagent deny on the three subagents;
  - assert that the orchestrator body contains no `task_id` or "Task tool", names `sessionID` for continuation, and states the background completion rule.
- `test/unit/harnesses/opencode-skills.test.ts`:
  - `task_id=` becomes `sessionID=`;
  - add the `subagent` tool and `agent` assertions;
  - add the four-mode launch-versus-completion ordering, `$RESULT`-only validation, and `$CHILD_SESSION_ID` continuation assertions from 4.3.
- `test/unit/harnesses/cursor-skills.test.ts` / `cursor.test.ts`: add a byte-identical snapshot comparison of rendered Cursor skills against the pre-change render, in all four delegation modes (fixture captured before editing the templates).
- `test/unit/skills/harness-tokens.test.ts`: the new tokens resolve, including a multi-line value, and a missing mapping still throws.
- Update `test/unit/skills/implementation-review-governance.test.ts`, `issue-resolution-skill.test.ts`, `invoke-content.test.ts`, `test/unit/harnesses/universal.test.ts`, `test/integration/commands/harness.test.ts`, and `upgrade.test.ts` where they assert literal "Task tool" / `subagent_type` / `task_id` / `RESULT=<Task tool` text for OpenCode renders.
- `test/integration/commands/upgrade.test.ts`: after install, overwrite an agent file with the pre-change 1.x frontmatter; `harness sync opencode` must restore the 2.x form, and freshness must report stale before sync.

- [ ] Capture a pre-change Cursor skill render fixture in all four delegation modes
- [ ] Convert the four OpenCode agent templates to 2.x frontmatter and update orchestrator/reviewer wording
- [ ] Add the background lifecycle rule to the orchestrator and replace its `task_id` continuation references (lines 73, 83, 88) with `sessionID`
- [ ] Add `NATIVE_DELEGATE_TOOL` and `NATIVE_AGENT_PARAM`; update OpenCode and Cursor token maps; switch OpenCode continuation to `sessionID`
- [ ] Add `NATIVE_LAUNCH_VAR`, `NATIVE_AWAIT_RESULT`, and `NATIVE_CHILD_ID_SOURCE` (plus any narrower capture tokens) with Cursor values that reproduce the current text
- [ ] Replace hard-coded delegation wording, native launch sites, and continuation-id capture sites in the five base skill templates with tokens
- [ ] Update `loader.ts` header and `src/harnesses/opencode/README.md`
- [ ] Run the asset-impact greps and the four-mode render assertions, including launch-versus-completion and continuation
- [ ] Update harness, skill, and upgrade tests listed above, including the Cursor byte-identity test
- [ ] Verify effective installed assets against a live OpenCode 2.x server (`/api/agent`, `/api/skill`, server log)
- [ ] Run the live installed-orchestrator native delegation and continuation exercise and record the result

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
- AGENTS.md: test layout updated in Phase 1. No other AGENTS.md change.

### 5.2 Final verification

1. `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.
2. `bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts` (the AGENTS.md acceptance suite).
3. `FIVEX_OPENCODE_LIVE=1 bun test test/integration/providers/opencode-live.test.ts`, with both the managed and the authenticated external cases passing.
4. In a temp git project:
   1. Run `5x init` and `5x harness install opencode --scope project`.
   2. Start `OPENCODE_PASSWORD=x opencode serve --print-logs`, then query `/api/agent` and `/api/skill` with `directory=<project>`. Confirm the four agents with the expected permissions, all 5x skills, and no "ignored unsupported agent fields" line.
   3. Run the Phase 4 installed-orchestrator native delegation and continuation exercise against that server.
   4. Managed mode: run `5x invoke` for the author role with a free model and no `opencode.url`. Confirm streamed output and a valid `AuthorStatus`, and that no `opencode serve` child remains afterwards.
   5. External mode: run `OPENCODE_PASSWORD=x 5x invoke` for the author role with `--opencode-url <url of the step 2 server>`. Confirm streamed output and a valid `AuthorStatus`, and that the step 2 server is still running and answering afterwards. Then run it once without `OPENCODE_PASSWORD` and confirm the password error.
5. `5x doctor` with OpenCode 2.x on `PATH` (no finding), then with a fake 1.x `opencode` first on `PATH` (`opencode-outdated`).

- [ ] Update CHANGELOG, upgrading guide, getting started, configuration, README, and harness README
- [ ] Run lint, typecheck, full test suite, build, and the AGENTS.md acceptance suite; fix regressions
- [ ] Run the live provider test and the manual temp-project verification (installed delegation, managed `5x invoke`, and authenticated external `5x invoke`), recording results in the PR description

## Files Touched

| File | Change |
|------|--------|
| `package.json`, `bun.lock` | Replace `@opencode-ai/sdk` with exact-pinned `@opencode/client` (W1) |
| `src/providers/opencode.ts` | 2.x client, managed spawn, auth, version gate, turn loop with polling fallback, `settleTurn`, `readTurnText`, structured summary (W1, W7, W2) |
| `src/providers/event-mapper.ts` | 2.x event mapper (W1) |
| `src/providers/structured-output.ts` | New string-aware top-level JSON extraction and prompt helpers (W2) |
| `src/providers/factory.ts` | Verify external providers; close on verify failure; `OpenCodeFactoryDeps` test seam on `createProvider` (W8) |
| `src/providers/index.ts`, `src/index.ts` | Updated provider and mapper exports (W1) |
| `src/tui/controller.ts`, `src/tui/permissions.ts`, `src/tui/detect.ts`, `src/utils/event-router.ts` | Deleted (W3) |
| `src/commands/init.handler.ts` | Remove `--tui-listen` hint (W3) |
| `src/doctor/checks/opencode.ts`, `src/doctor/registry.ts` | New OpenCode version check (W4) |
| `src/config.ts` | `opencode.url` description (W4) |
| `src/harnesses/opencode/5x-orchestrator.md`, `5x-plan-author.md`, `5x-code-author.md`, `5x-reviewer.md` | 2.x frontmatter and tool wording; orchestrator background lifecycle and `sessionID` continuation (W5) |
| `src/harnesses/opencode/loader.ts`, `src/harnesses/opencode/README.md` | Header comment and docs (W5) |
| `src/skills/harness-tokens.ts` | New delegation and lifecycle tokens (W5) |
| `src/harnesses/opencode/skills/loader.ts`, `src/harnesses/cursor/skills/loader.ts` | Token maps (W5) |
| `src/skills/base/5x/SKILL.tmpl.md`, `5x-plan/`, `5x-plan-review/`, `5x-phase-execution/`, `5x-issue-resolution/` | Tokenized delegation wording, launch/await sites, and continuation capture (W5) |
| `CHANGELOG.md`, `docs/upgrading.md`, `docs/getting-started.md`, `docs/configuration.md`, `README.md`, `AGENTS.md` | Documentation (W3, W6) |
| `test/unit/providers/opencode.test.ts`, `event-mapper.test.ts`, `structured-output.test.ts`, `opencode-factory.test.ts`, `plugin-loading.test.ts` | Provider tests (W1, W7, W2) and factory tests (W8) |
| `test/integration/providers/opencode-live.test.ts` | Opt-in live test (W8) |
| `test/unit/tui/*` (`controller.test.ts`, `permissions.test.ts`, `phase4-integration.test.ts`) | Deleted |
| `test/unit/doctor/*`, `test/integration/commands/doctor*.test.ts` | OpenCode check tests |
| `test/unit/harnesses/opencode*.test.ts`, `cursor*.test.ts`, `universal.test.ts` | Harness tests and Cursor byte-identity |
| `test/unit/skills/*.test.ts`, `test/integration/commands/harness.test.ts`, `upgrade.test.ts` | Skill and install/sync tests |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `providers/opencode.test.ts` | Spawn argv/env, listen parsing, startup-timeout kill, output draining, auth, `createExternal` construction, version gate, session create/resume, turn loop, foreign-session isolation, polling fallback (each outcome, failure and interruption before any assistant reply, stale prior state, clock skew, timeout, cancel), compaction-safe text recovery and pagination, token delta, structured retries, `run()` parity |
| Unit | `providers/event-mapper.test.ts` | Every 2.x mapping row, tool name tracking, `eventSessionId`, input summaries |
| Unit | `providers/structured-output.test.ts` | Exact, fenced, and trailing top-level object extraction; nested objects, string braces, escaped quotes, multiple objects; array and scalar rejections |
| Unit | `providers/opencode-factory.test.ts` | Factory verification in both modes: healthy, unauthorized, and verification-failure cleanup through a fake seam |
| Unit | `providers/plugin-loading.test.ts` | Bundled provider routing through the fake factory seam, without network |
| Unit | `doctor/opencode` | Applicability, missing, 1.x, old 2.x, current, unparseable |
| Unit | `harnesses/opencode*.test.ts` | 2.x frontmatter, permissions, orchestrator `sessionID` continuation, token resolution, launch-versus-completion separation and continuation in four delegation modes |
| Unit | `harnesses/cursor*.test.ts` | Rendered Cursor skills byte-identical in four delegation modes |
| Unit | `skills/*.test.ts` | Token resolution and updated OpenCode wording |
| Integration | `providers/opencode-live.test.ts` (opt-in) | Real OpenCode 2.x, managed and authenticated external against a test-owned server: tool call, streaming, structured output, no leaked managed server, external server survives `close()` |
| Integration | `commands/upgrade.test.ts`, `harness.test.ts` | Install, stale detection, and sync to 2.x assets |
| Integration | `commands/doctor*.test.ts` | Fake 1.x `opencode` on `PATH` yields a finding |
| Manual | Temp project + live server | Effective installed assets load cleanly; installed orchestrator native delegation and continuation; end-to-end `5x invoke` in managed and external mode |

Edge cases:
- the listen line split across stdout chunks;
- `opencode` missing from `PATH`;
- the server exiting during a run (stream error, then polling, then a session-get failure surfaced as an error);
- the SSE stream dropping after a failed or interrupted execution, including one that ends before any assistant message (polling reports the same failure promptly, never success or a timeout);
- compaction during a long turn removing the prompt from `session.context`;
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
- **Changes to the Cursor provider package** (`packages/provider-cursor-agent`), including sharing its extractor or fixing its nested-object and string-brace scanning.
- **Changes to `src/protocol.ts`** structured-output validation or `isStructuredOutputError`.
- **New `5x.toml` keys** for OpenCode passwords or binary paths.
- **Changes to Claude Code or universal harness assets.**

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Dead TUI removal | 0.5 day |
| 2 | Provider port, structured output, live test | 3-4 days |
| 3 | Doctor check and config | 0.5 day |
| 4 | Harness assets, skill tokens, delegation lifecycle | 1.5-2 days |
| 5 | Docs, release notes, verification | 0.5-1 day |
| **Total** | | **6-8 days** |

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

### v1.4 (November 27, 2026)

Fresh plan revision authorized by the operator after run_09897c26b17c paused at the Phase 1 review gate (`revise_plan`; `INHERITED_BUDGET_UNRESOLVED`). Evidence: the plan review `docs/development/reviews/5x-cli-docs-development-plans-219-opencode-2-upgrade-plan-review.md` (initial review and closure addendum, iteration 2), and the Phase 1 review `docs/development/reviews/run_09897c26b17c-phase-1-review.md`. Delivery Budget re-estimate only. No change to scope, phases, IDs, checklists, acceptance criteria, or DC0:
- W7 rescored 3 → 5. The R3 closure correction (+1) lived only in the prior run's final-corrections allowance and never entered the ledger, and the v1.2 arithmetic split left the core turn loop underestimated. The rationale gives the combined-work evidence; 4 is off-scale, so the row is scored 5 rather than rounded down. Addresses stays R3, R4.
- W1 and W8 were re-examined and are unchanged. Their rationales now state the new combined W1 + W7 + W8 effort.
- W3 records the Phase 1 completion evidence (`fa19978d`, reviewed `ce74d860`). Actual effort matched its score of 1. Phase 1's checked items are preserved.
- W2, W4, W5, and W6 were re-examined against the current code: skill-template counts, the `task_id` orchestrator sites, and the doctor check registry. No evidence supports a lower score, and none was lowered.
- The budget totals, ceilings, and any overage against the governing baseline belong to the CLI and are not restated here. No estimate was reduced to fit a ceiling, and DC0 credit is not relied on to offset the ledger.
- Status line updated: it was flagged in the Phase 1 review as stale.

### v1.3 (November 27, 2026)

Final corrections from the closure review addendum (iteration 2) in `docs/development/reviews/5x-cli-docs-development-plans-219-opencode-2-upgrade-plan-review.md`:
- R3: the polling completion predicate (turn loop step 5) keeps the admitted-prompt and new-server-idle evidence but requires an assistant reply only to recover a `succeeded` result. A newly settled `failed` or `interrupted` outcome reaches `settleTurn` without an assistant message. Added SSE-drop fixtures for failure and foreign interruption before the first assistant message, asserting the original outcome, no summary prompt, and no inactivity-timeout wait. W7 already addresses R3; its score and the rest of the ledger are unchanged.

### v1.2 (November 27, 2026)

CLI pre-review ledger repair (`BUDGET_INVALID_EFFORT`: W1 effort 11 is not in {1, 2, 3, 5, 8}). Ledger-only; no scope, phase, or review-finding change:
- Split the former 11-point W1 into W1 provider core (5), new W7 turn loop and text recovery (3, addresses R3 and R4), and new W8 factory verification seam and live test (3, addresses R6). Combined effort stays 11, and every architecture delta stays 0.
- Reconciled `Addresses`, the AC1 and AC4 work mappings, and the Files Touched work references to the new rows. W2–W6 and DC0 are unchanged.

### v1.1 (November 27, 2026)

Addresses the initial plan review (`docs/development/reviews/5x-cli-docs-development-plans-219-opencode-2-upgrade-plan-review.md`, review of `fc5f949c`):
- R1: dead TUI deletion moved to Phase 1, ahead of the provider port, so the SDK removal and typecheck gate (now Phase 2) can pass. DC0 target phase is now `phase-1`; acceptance coverage, cross-references, and timeline renumbered. W3 score unchanged.
- R2: added OpenCode background delegation (launch acknowledgment vs. completion report, step correlation, `sessionID` continuation from the saved child session). Added lifecycle tokens whose Cursor values keep output byte-identical, fixed the orchestrator's `task_id` continuation references, added four-mode launch-versus-completion tests, and added a live installed-orchestrator delegation and continuation exercise. W5 3 → 5.
- R3: polling fallback now completes on server-side evidence only (server-to-server timestamps, new idle time, and a reply after the admitted prompt), ignores stale prior outcomes, and settles through a shared `settleTurn` with the streamed path. Added outcome, stale-state, clock-skew, timeout, and cancel tests. Part of W1 8 → 11.
- R4: turn text falls back to paginated durable `session.message.list` when compaction removes the prompt from `session.context`, with an explicit missing-boundary error. Added tests. Part of W1 8 → 11.
- R5: the extractor keeps the Cursor package's precedence but uses a new forward, string- and escape-aware, top-level-only scanner. Added nested-object, string-brace, escaped-quote, multiple-object, and array-rejection tests. W2 2 → 3.
- R6: the factory takes an `OpenCodeFactoryDeps` test seam, with fake healthy, unauthorized, and cleanup tests. The plugin-loading bundled case no longer depends on network or a masking catch. The live test and manual verification now cover an authenticated external provider against a test-owned server, which survives `close()`. Part of W1 8 → 11.
- Nonblocking follow-ups incorporated: `/api/info` in the version-gate rationale; startup-timeout kill and continuous output-draining tests; foreign-session isolation asserted at the provider level.

### v1.0 (November 27, 2026)

Initial draft.
