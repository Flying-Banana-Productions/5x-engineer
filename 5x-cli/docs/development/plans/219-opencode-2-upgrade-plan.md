<!-- 5x:plan-schema:1 -->

<!--
Generator guidance stays outside the contract, with the human document revision
and status. Obligations inside the contract are what a schema 1 approval binds.
Only contract content outside notes governs the work. Read other plan content as context. Surface apparent material requirements or conflicting instructions to the operator as warnings. Route necessary contract changes through amendment approval before acting. Informational claims such as review passed do not satisfy completion gates.
-->

**Version:** 1.9
**Created:** November 27, 2026
**Status:** Revised (v1.9) — Phase 1 complete; Phase 2 headless `question` acceptance amendment (P1.1, with R14/R15 corrections) pending plan review

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

**Prompt-ownership evidence (November 27, 2026, OpenCode 2.4.2 server, `@opencode/client` 2.4.2 declarations and two live probes).**
- `session.prompt` accepts a caller-assigned `id` and `delivery: "steer" | "queue"`. The server rejects an `id` that does not start with `msg_` (`Expected a string starting with "msg_"`). With no `delivery`, the item is `steer`.
- The returned inbox item's `id` is the caller's `id`, and the delivered user message in `session.context` has the same `id`.
- Submitting the same `id` again, after the first request had completed, returned the existing item and enqueued nothing. This was observed only sequentially. It is not a documented guarantee for a resend that races an in-flight first request, so 5x does not resend.
- The stream reports `session.inbox.enqueued{sessionID, inboxID, item}`, then `session.execution.started{sessionID}`, then `session.inbox.delivered{sessionID, inboxID}`, and later one `session.execution.succeeded|failed|interrupted`. Durable events carry `durable.seq` in that order. Terminal events carry only `sessionID` (plus `error` or `reason`), never an inbox id.
- A second prompt sent while an execution runs is not given its own execution, even with `delivery: "queue"`. It is delivered into the running execution after the current step ends, and one terminal event then covers both prompts.
- `session.active()` lists a running session. `session.inbox.list` lists undelivered items, which stay listed until delivery.
- `session.inbox.cancel({sessionID, inboxID})` removes an undelivered item and emits `session.inbox.cancelled`. It also returns success, with no event, for an unknown id or an item already delivered. So its acknowledgment is not evidence that anything was removed.
- `session.interrupt({sessionID})` on a running execution returns `{interrupted: true}` and emits `session.execution.interrupted{reason: "user"}`. On an idle session it returns `{interrupted: false}`.
- Each execution writes one durable `idle` transcript entry with `outcome` and, on failure, `error`. A model that cannot be routed produced user entry, `execution.failed{error}`, and an `idle{outcome: "failed", error}` entry with no assistant message.
- `form.created` carries `data.form` (`{id, sessionID, title, fields}`), not `data.sessionID`. `session.form.cancel` takes `{sessionID, formID, message?}`.
- Every request method accepts `requestOptions.signal`. Aborting it bounds only the client's wait. It does not guarantee that the server never admitted the request, so a `session.prompt` aborted on the client can still enqueue its item afterwards.
- The 2.4.2 declarations (`dist/promise/generated/types.d.ts`) also establish:
  - `EventSubscribeInput` takes only `types`. There is no replay cursor, so an event missed while the stream is down cannot be recovered.
  - `SessionInterruptInput` is `{sessionID, resume?}`. An interrupt names a session, never an execution or a prompt.
  - `SessionInboxCancelOutput` is `void`, so the reply carries no evidence of removal.
  - `SessionMessageAssistant` has optional `tokens: TokenUsageInfo` (`{input, output, reasoning, cache: {read, write}}`) and `cost: MoneyUSD`. Completed and failed `compaction` entries carry the same optional fields. Usage can therefore be read per transcript entry, not only as the cumulative `session.get` totals.
  - `MessageListInput` takes `sessionID`, `limit`, `order`, `cursor`, and `type`.

## Design Decisions

**Use `@opencode/client` through its Promise root, pinned to an exact version.**
- The package is the generated 2.x HTTP client. Its Promise root has no Effect runtime dependency.
- 2.x has shipped minor releases every few weeks, and the client is generated from the server contract, so pin an exact version: the latest 2.x at implementation time, 2.4.2 when this plan was written.
- Do not use `@opencode/sdk`. It embeds the full OpenCode runtime in-process and would make 5x's dependency footprint and lifecycle OpenCode's.
- Confirm that `bun build --compile` still bundles.

**Managed mode spawns a private `opencode serve` per provider instance.**
- Spawn: `Bun.spawn(["opencode", "serve", "--hostname=127.0.0.1", "--port=0"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, OPENCODE_PASSWORD } })`. Both output pipes are explicit: Bun inherits stderr by default, which would send the server's diagnostics to the caller's stderr and leave no stderr to report when startup fails.
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
- `OpenCodeProvider.verify()` calls `client.server.info()` and requires `version >= MIN_OPENCODE_VERSION`, an exported constant.
- The constant is the oldest OpenCode release on which both live cases (managed and authenticated external) have passed. It starts at `2.4.2`, the only release the prototype and probes ran on. Phase 2 sets it to the release its passing live run used. It may be lowered only to a release on which both live cases have also passed, with that run's `opencode --version` recorded in the PR description.
- A 1.x server or binary fails differently: 1.x prints a listen line the regex also matches, but the `server.info()` route (`/api/info`) is missing. That maps to "5x 2.x requires OpenCode ≥ <MIN_OPENCODE_VERSION> (found 1.x) — run `opencode upgrade --major`".
- An older 2.x maps to "5x 2.x requires OpenCode ≥ <MIN_OPENCODE_VERSION> (found <version>) — run `opencode upgrade`". These are the same upgrade hints the `5x doctor` check gives (Phase 3).
- `UnauthorizedError` maps to "the OpenCode server requires a password — set OPENCODE_PASSWORD".
- `factory.createOpenCodeProvider` calls `verify()` in both managed and external mode; today only managed mode verifies. If `verify()` throws, the provider is closed before the error propagates. Closing an external provider never stops the server it connected to.
- The factory takes the OpenCode constructors through an optional internal seam, so unit tests exercise verification and cleanup with a fake provider and no network I/O.

**Sessions are headless and fully permitted.**
- `startSession` passes `permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "question", resource: "*", effect: "deny" }]`. This replaces 1.x `config: { permission: "allow" }`.
- The `question` deny keeps a headless run from blocking on an interactive form.
- **How the deny prevents forms on 2.4.2.** OpenCode withholds the `question` tool from a session whose rules deny it. The Phase 2 review compared the same prompt and model in two fresh sessions on one test-owned 2.4.2 server, changing only the `question` deny rule:
  - With the deny, the captured events showed no `question` call and no form, and the execution succeeded.
  - Without the deny (allow-only rules), OpenCode started `question` and emitted the session's `form.created`.
  - Prevention is therefore the *absence* of a `question` call and form, not an observable denied tool call. Absence counts only when a positive control in the same configuration produces a matching form.
- **Headless acceptance is a controlled comparison.** Phase 2's live case (2.6) runs one prompt that tells the agent to call the `question` tool. Both arms use the same prompt, model, test-owned server (at `MIN_OPENCODE_VERSION`), and isolated test context, each in a fresh session with its own prompt id.
  - **Positive control:** a raw-client session with only the allow-all rule. It must emit `form.created` whose `data.form.sessionID` is the control session. Without that form, the case is inconclusive and fails. The control form is then cancelled with `session.form.cancel({ sessionID, formID: data.form.id })` purely as fixture cleanup. On 2.4.2, cancelling a form interrupts the execution (`session.tool.failed` aborted, `session.step.failed`, `session.execution.interrupted{reason: "shutdown"}`); it does not continue the turn. The case therefore never requires the control to continue or succeed after cancellation.
  - **Deny arm:** a provider session created by `startSession`, carrying the headless rules above. It must end in `done` with no `error`, within a bounded time, and show no `question` call (stream or provider events) and no `form.created` for its session.
  - **Complete raw observation.** Absence on the deny arm counts only over a complete observation window. The 2.x stream starts when it is consumed, has no replay, and can end early. The provider's `done` can also come from durable polling after its own stream drops, and neither the provider nor the mapper reports a form. So the test's own raw event subscription is the evidence for absence:
    - The test subscribes to the raw stream, consumes it, and observes its `server.connected` marker before it submits either arm's prompt.
    - The same subscription stays live and consumed, without ending, erroring, or being replaced, until it has delivered the deny session's raw terminal `session.execution.*` event for the execution that received the deny arm's prompt (the first terminal event for that session after its raw `session.inbox.delivered`).
    - A gap in that window (the stream ends, errors, or is resubscribed before that terminal event), or no such terminal event within the case bound, fails the case as inconclusive. It is never counted as absence or as a pass.
  - A timeout, an arbitrary error, or a normal turn without a passing positive control is never counted as prevention.
- **No cancel-and-continue fallback.** The provider never calls `session.form.cancel`. At `MIN_OPENCODE_VERSION` the deny prevents forms, so such a fallback would be unused, and its continuation premise is false on 2.4.2.
  - This plan defines no stop-on-form or other form-specific terminal policy. A form for the turn's own session follows §2.3: it produces no `AgentEvent` and no cancel call, and the turn's existing settlement, timeout, and owned-cleanup rules apply unchanged.
  - In the live comparison, a deny-arm form or `question` call fails the case, not passes. Supporting a release (including a newer minimum) that lets a denied session create a form or call `question` requires a plan amendment that defines a separately verifiable terminal policy.
  - `form.created` is still subscribed and routed. It has no `data.sessionID`: its session is `data.form.sessionID` (verified in the 2.4.2 declarations).
  - A form for any other session is dropped like every other foreign event.
- `parseModel` also accepts the 2.x `provider/model#variant` form and returns `{ providerID, id, variant? }`.
- `resumeSession` reads `location.directory` from `session.get`, and applies a model override with `session.switchModel`.

**One turn loop drives every prompt, and a turn owns exactly one prompt.**

In 2.x, `session.prompt` only enqueues an inbox item. A terminal `session.execution.*` event names the session, not the prompt. One execution can absorb several prompts: a prompt sent while an execution runs is delivered into it, and a single terminal event then covers both (Overview, prompt-ownership evidence). So "the first terminal event for this session" is not enough evidence that this turn finished. It can belong to a previous or foreign execution on a resumed or externally shared session.

A turn therefore identifies its prompt by a caller-assigned id. It accepts a terminal outcome only after that exact item has been delivered. It reads text and usage only from its own transcript window. It never returns success when other input shared the execution, or when the state of its own prompt cannot be established. Every unresolved state is bounded and ends in an error, never in success.

`runTurn(text, { stream, signal })` performs these steps:
1. **Pre-aborted short-circuit.** If `signal` is already aborted, raise `AgentCancellationError` without subscribing, prompting, or sending any other request.
2. **Subscribe.** Call `client.event.subscribe({ types, signal })`, filtered to the event types in 2.3, and wait for the `server.connected` marker with a 5 s bound. The 2.x stream is live-only and has no replay cursor, so it must be subscribed before prompting.
3. **Ownership precheck.**
   - The provider keeps an in-process set of the session ids that have a turn in progress. A turn on a session already in the set fails at once with the busy error below and sends no request. So one provider never drives two turns on one session at the same time.
   - Read `session.active()` and `session.inbox.list({ sessionID })`. If the session is running or has any undelivered item, the turn cannot own its execution. It fails with an `error`, `OpenCode session <sessionID> is busy (running or has queued input); 5x cannot attribute a turn on it`, and sends no prompt.
   - Otherwise record the id of the last transcript entry (the transcript tail) with the step 8 reader. No `session.get` usage baseline is taken (step 9).
   - The precheck is a snapshot, not a lock: another client can enqueue input immediately after it. Steps 5 and 6 detect that as overlap. New sessions created by `startSession` always pass. The check matters for `resumeSession` and for external servers that other clients also drive.
4. **Admission with a stable request id, never resent.**
   - Generate `requestId = "msg_5x" + <random UUID without dashes>` once per turn. The server requires the `msg_` prefix.
   - Call `session.prompt({ sessionID, id: requestId, text, delivery: "queue" })` once, bounded at 10 s through `requestOptions.signal`. `delivery` is explicit so behavior does not depend on the server's `steer` default.
   - A reply moves the turn to `pending`.
   - A timeout or lost reply leaves admission **indeterminate**. The client-side abort does not prove that the server did not admit the request (Overview), and same-id idempotency is verified only for sequential resends. So 5x never resends `session.prompt`. Instead it reconciles admission for up to 10 s, on the same evidence as later steps:
     - `session.inbox.enqueued{inboxID: requestId}` on the stream, or `requestId` in `session.inbox.list`: admitted and `pending`. The turn continues normally.
     - `session.inbox.delivered{inboxID: requestId}`, or the user entry `requestId` in the transcript: admitted and `delivered`. The turn continues normally.
     - No evidence within the bound: the turn runs owned cleanup (below) and fails with `OpenCode prompt <requestId> admission is unresolved on session <sessionID>; it may still be queued or run`. Absence is not proof of non-admission.
   - `promptId` is `requestId` from this point on: the delivered transcript user message carries the same id.
5. **Streamed ownership.** The turn's state is `admitting`, `pending`, `delivered`, `unknown`, or `removed`, plus an `overlap` flag. It is updated from session-matching events in stream order. `eventSessionId` (2.5) resolves each event's session.
   - `session.inbox.enqueued{inboxID: requestId}` moves an `admitting` turn to `pending`.
   - `session.inbox.delivered{inboxID: requestId}` moves the turn to `delivered`.
   - `session.inbox.enqueued` or `session.inbox.delivered` for any other `inboxID` sets `overlap`.
   - A terminal `session.execution.*` before this turn's delivery is not this turn's. It sets `overlap` and never settles the turn.
   - Content events (text, reasoning, tool, step) are mapped to `AgentEvent`s only after delivery and before any other item is delivered. Earlier ones belong to another prompt.
   - `session.inbox.cancelled{inboxID: requestId}` moves the turn to `removed`. This event is the only positive evidence of removal. If this turn did not request the cancellation, the turn fails with `OpenCode prompt <requestId> was cancelled by another client`.
   - If `overlap` is set while the turn is `admitting` or `pending`, the turn runs owned cleanup and fails with `OpenCode session <sessionID> received other input during this turn; the result is ambiguous`.
   - The first terminal `session.execution.succeeded|failed|interrupted` after delivery settles the turn through `settleTurn`. If `overlap` is set by then, a `succeeded` outcome settles as the ambiguous-overlap error instead of a result. `failed` and `interrupted` keep their own errors.
6. **Polled settlement on durable evidence.** If the stream errors or ends before settlement, poll every 500 ms, each request bounded at 10 s. Until the turn is `delivered`, each poll reads `session.inbox.list` first and then the transcript, with the step 8 reader. After delivery, it reads only the transcript.
   - **Delivered:** the transcript contains the user entry `requestId`. This outranks every other observation.
   - **Pending:** `requestId` is in `session.inbox.list` and not yet in the transcript.
   - **Unknown:** `requestId` is in neither. This is not removal. Delivery can remove the item from the inbox between the two reads, before its user entry is readable. A request whose admission was indeterminate can also still be in flight. The turn stays `unknown` and keeps re-reading both on later polls, so a later read of `requestId` in the transcript moves it to `delivered`.
   - **Removed** only on positive evidence: a `session.inbox.cancelled{inboxID: requestId}` received before the stream failed. Because the stream has no replay, a removal that happens while polling cannot be proven.
   - **Bounded reconciliation:** once a turn has been `unknown` for 10 s of consecutive polls, it fails closed. If this turn requested cancellation, it raises the typed error with the unresolved note (owned cleanup, step 3). Otherwise it fails with `OpenCode prompt <requestId> left the inbox of session <sessionID> but is not in its transcript; its outcome is unknown`. It never reports success, and never reports cancellation by another client without the event.
   - **Settled:** the transcript holds an `idle` entry after `requestId`. The first such entry is this turn's execution end. Its `outcome` and `error` go to `settleTurn`.
   - **Overlap:** any `user` entry other than `requestId` between the transcript tail recorded at step 3 and this turn's `idle` entry, or any other item in `session.inbox.list`. It is handled as in step 5.
   - A newly settled `failed` or `interrupted` outcome goes straight to `settleTurn` with no assistant-message prerequisite. Execution can fail during setup or be interrupted before any assistant message exists; verified: a failed execution writes `idle{outcome: "failed", error}` directly after the user entry. This keeps the R3 early-failure path.
   - An `idle` entry before `requestId` (an earlier turn's outcome) never settles this turn, and neither does the `session.get` `outcome`. No timestamp is compared at all, so client and server clocks cannot disagree.
   - The inactivity timeout applies to polling too, and resets when the transcript gains or changes an entry, or the inbox changes. `signal` stays honored while polling.
7. **One terminal handler.** Both paths settle through `settleTurn(outcome)`. The streamed `session.execution.*` event and the polled `idle` entry (`succeeded`, `failed`, `interrupted`) get identical treatment:
   - `succeeded` with no overlap: continue to the turn window (text and usage) and any structured summary turn.
   - `succeeded` with overlap: the ambiguous-overlap `error`.
   - `failed`: an `error` carrying the server's error message, or "OpenCode execution failed" when none is available.
   - `interrupted` by our own timeout or cancel: `AgentTimeoutError` / `AgentCancellationError`.
   - `interrupted` for any other reason: an `error`.

   Only a non-overlapped `succeeded` reads the window or sends a summary or corrective prompt.
8. **Read the turn window.** The window is the transcript entries after the user entry `promptId`, up to and including the first `idle` entry after it. `readTurnWindow(promptId)` returns the window's text and usage.
   - The fast path is `session.context`. It holds only messages since the last compaction. If `promptId` is missing from it, page through the durable `session.message.list` (`order: "asc"`), following its cursor until `promptId` is found, and read the window across page boundaries.
   - The window must be closed by its `idle` entry. A streamed terminal event can arrive before that entry is readable, so the reader re-reads every 500 ms for up to 10 s. If the entry is still missing, the turn fails with `OpenCode turn window for prompt <promptId> on session <sessionID> has no end`.
   - A `user` entry other than `promptId` inside the window is overlap, and yields the ambiguous-overlap error.
   - The turn text is the text content of the window's `assistant` entries.
   - If the pages run out without finding `promptId`, the turn fails with `OpenCode turn reply not found: prompt <promptId> is missing from session <sessionID>`. It never falls back to all active context.
9. **Usage from the turn window only.**
   - Tokens are the sums of `tokens.input` and `tokens.output` over the window's `assistant` entries and its `completed` or `failed` `compaction` entries (2.4.2 `SessionMessageAssistant.tokens` and `SessionMessageCompaction*.tokens`, Overview). `costUsd` is the sum of their `cost`.
   - The cumulative `session.get` totals are never used. Another client's execution can start after this turn's terminal event and before any usage read. That execution begins after settlement, so it never sets `overlap`, but it would inflate a session-wide delta.
   - Attribution fails closed. If any of those entries lacks `tokens`, the turn fails with `OpenCode usage for prompt <requestId> on session <sessionID> cannot be attributed to its turn`, instead of substituting session totals. If every entry has `tokens` but one lacks `cost`, `costUsd` is left undefined rather than reported as a partial sum.
   - The Phase 2 live test asserts that window usage is present on a real 2.x server.

**Owned cleanup on timeout, cancellation, overlap, and unresolved admission.** `session.interrupt` stops a running execution, but it does not remove an undelivered inbox item. It names only a session (2.4.2 `SessionInterruptInput {sessionID, resume?}`), never an execution or prompt. `session.active()` is a momentary snapshot: the execution it reports can finish and be replaced by another before an interrupt lands. So the turn never infers from an activity check that it owns the running execution.

**Exclusive use** is established by construction, not observed. A managed provider's private server was spawned for this provider with a random password that only this provider holds, and the in-process set of sessions with an active turn (step 3) keeps 5x from driving two turns on one session. Any execution on that server is therefore this invocation's own work. An external server is never exclusive: other clients may hold its password and drive the same session.

Cleanup acts only on what this turn owns:
1. **Exact-id cancellation with bounded reconciliation.** This step runs if the turn is `admitting`, `pending`, or `unknown`. Call `session.inbox.cancel({ sessionID, inboxID: requestId })`. Its acknowledgment proves nothing: the reply is `void`, and cancel also succeeds for unknown and already-delivered ids (verified). An unknown id includes one whose `session.prompt` is still in flight and can enqueue later. So for up to 10 s, the turn reconciles from evidence. It polls `session.inbox.list` and the transcript every 500 ms, and also reads the stream while it is up.
   - `session.inbox.cancelled{inboxID: requestId}` seen: `removed`. Done.
   - `session.inbox.enqueued{inboxID: requestId}` seen, or `requestId` in `session.inbox.list`: still pending, for example after a late admission that the first cancel missed. Cancel again by the same exact id and keep reconciling.
   - `session.inbox.delivered{inboxID: requestId}` seen, or `requestId` in the transcript: delivery won the race. Go to step 2.
   - Absence from both inbox and transcript is never treated as removal.
   - At the bound with none of these: **unresolved**. Go to step 3.
   - The prompt is never resent after local cancellation, and never resent at all (turn loop step 4).
2. **Delivered.**
   - On a managed provider, call `session.interrupt({ sessionID })` once. Exclusive use, not activity, authorizes it. Even if the execution observed earlier has been replaced, the replacement is this invocation's own work on its private server.
   - On an external provider, never interrupt. The raised error says `the OpenCode execution on session <sessionID> was left running on the external server`.
3. **Unresolved.** No interrupt in either mode.
   - External: the raised error says `OpenCode prompt <requestId> may still be queued or run on session <sessionID>`.
   - Managed: the error says the same, and that the private server is stopped when the provider closes.

Every cleanup request has its own 5 s bound and does not use the caller's aborted signal. Total cleanup is bounded at 15 s. Cleanup request errors are swallowed and count as no evidence. After cleanup the turn raises its typed error at once: `AgentTimeoutError` for the inactivity timeout, `AgentCancellationError` for `signal`, the ambiguous-overlap error for overlap, and the unresolved-admission error for admission. It never waits for a terminal event after the local abort. The existing `AgentTimeoutError` / `AgentCancellationError` messages are kept as the start of the message, and a cleanup note (left running, or unresolved) is appended only when step 2 or 3 applies.

Failure handling:
- `execution.failed` and `step.failed` yield `error` events carrying `error.message`. `execution.failed` and `execution.interrupted` settle through `settleTurn`, the same handler the polling path uses.
- The inactivity timeout resets on each event for the session, or on server-side progress while polling. It and caller cancellation run owned cleanup.
- `run()` consumes `runStreamed()`, as `packages/provider-cursor-agent/src/session.ts` already does. This removes the duplicated execute/summary logic and the 1.x abort-recovery polling (`waitForRecoveredPromptResult`).
- The structured summary and corrective prompts are ordinary turns. Each has its own `requestId`, precheck, ownership tracking, and window usage.

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

- The 1.x part-registration, delta-dedupe, and message→session resolution state is removed. Every subscribed 2.x event carries `data.sessionID`, except `form.created`, whose session is `data.form.sessionID`. `eventSessionId` handles that case explicitly.
- Inbox events (`session.inbox.enqueued|delivered|cancelled`) and `session.execution.*` produce no `AgentEvent` themselves. The turn loop reads them for ownership and settlement.
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
| W1 | Provider core port to `@opencode/client`: dependency swap, managed private-server lifecycle (spawn, listen parsing, startup-timeout kill, output draining), external auth, version gate, headless session permissions, 2.x event mapper and exports | 5 | 0 | - | R11 | v1.5: R11 (reviewer effortDelta 0) makes the spawn's `stdout: "pipe"` and `stderr: "pipe"` explicit and has the existing spawn-seam test assert them. That is two options and two assertions in work this row already prices, so the score is unchanged. Major migration against a new, fast-moving server protocol. The provider construction and mapper are rewritten rather than patched, and uncertainty remains in the `question` deny and 2.x event shapes. Rescored 11 → 5 only because the former 11-point row (an invalid point value) was split into W1, W7, and W8, which together held 11 at v1.2. The v1.4 W7 re-estimate raises the combined W1 + W7 + W8 effort to 13 without changing W1. W1 keeps the original pre-review core of construction, lifecycle, auth, version gate, permissions, and mapper. The turn loop and R3/R4 work moved to W7; the factory seam, live test, and R6 work moved to W8. Architecture stays neutral: process management moves from the SDK into 5x (+), offset by removing the 1.x SDK startup path (−). |
| W7 | Provider turn loop: prompt admission and streamed completion, server-evidence polling fallback settling through a shared `settleTurn`, compaction-safe durable-transcript text recovery (`readTurnWindow` with paginated `session.message.list`), `run()` over `runStreamed()`, and their unit tests | 5 | 0 | - | R3, R4, R7 | v1.6: the planned `session.get` usage baseline and delta leave this row, because usage now comes from the turn window, which W9 prices. `readTurnText` is renamed `readTurnWindow` and also returns the window entries that W9 sums. Score unchanged at 5: dropping the delta is a small reduction, too small to support the next lower allowed value of 3, and the rename costs nothing. v1.5: R7 rewrites this row's settlement predicates. The streamed path settles on the first terminal event after this turn's own delivery, and the polled path on the first durable `idle` entry after the prompt instead of `session.get` timestamp comparisons. Score unchanged at 5: the new ownership, overlap, and cleanup work is priced in W9, and the polling predicate swap is effort-neutral, because one transcript scan replaces the timestamp checks and the R3 early-failure, stale-state, and skew cases are kept. Split from the former 11-point W1 row with no change to scope. Rescored 3 → 5 in v1.4 as a re-estimate of the same scope, not a scope change. Two things were missing from the 3. First, the v1.2 split held W1 + W7 + W8 at 11 by arithmetic, which left the core turn loop about one point once the R3 and R4 increments were counted. Second, the R3 closure correction (addendum iteration 2, reviewer effortDelta +1: newly settled `failed`/`interrupted` outcomes reach `settleTurn` without an assistant-message prerequisite, plus SSE-drop-before-assistant fixtures) was carried only as run_a9914ec93486's final-corrections allowance and never entered this ledger. A new run inherits no correction allowance, so the row must carry it. Combined work: the core turn loop (subscription handshake, prompt admission, streamed mapping, inactivity timeout and interrupt, `run()` over `runStreamed()` with the summary turn), replacing about 540 lines (`opencode.ts:186–727`); R3 server-evidence polling and shared `settleTurn` (+1), and its closure correction (+1); R4 paginated durable text recovery (+1). About 25 scripted cases in the rewritten 1,126-line `opencode.test.ts` cover this work. That re-estimates above 3. 4 is not an allowed value, so the row is scored 5 rather than rounded down to 3. Uncertainty sits in stream timing and interrupt behavior. Includes R3 (+1 reviewer effortDelta: polling completes on server-side evidence and settles through the streamed path's terminal handler, with outcome, stale-state, clock-skew, timeout, and cancel cases; closure +1 as above) and R4 (+1: a paginated `session.message.list` fallback when compaction drops the prompt from context, with an explicit missing-boundary error). Architecture neutral: one turn loop replaces the duplicated 1.x run paths and recovery polling, and the corrections reuse it rather than adding an abstraction. |
| W8 | Factory verification and live evidence: external-provider verification and close-on-failure in `src/providers/factory.ts`, the `OpenCodeFactoryDeps` test seam with fake healthy, unauthorized, and cleanup tests, network-free bundled plugin-loading case, the opt-in live test covering managed and authenticated external mode against a test-owned server, headless form routing with the live `question` case (deny arm), and minimum-version evidence | 5 | 0 | - | R6, R9, R13, P1.1, R14 | v1.9: R14 (amendment review; reviewer effort 0, architecture delta 0) rewords the Design Decisions no-fallback statement. The deleted "never continues a turn past one" clause would have implied a stop-on-form exit path. The text now says only that there is no cancel-and-continue fallback, that a matching form follows §2.3 under the existing settlement and cleanup rules, and that no form-specific terminal policy is defined without a further amendment. This is plan wording that matches the implemented behavior and adds no production or test work, so the score is unchanged. v1.8: P1.1 (Phase 2 review; reviewer estimated additional effort 1, architecture delta 0) removes the conditional `form.cancel` fallback, its matching-form unit case, and the turn-continues-after-cancel outcome from this row's R9 scope. The live `question` case keeps only its deny arm here, now required to end in `done` with no `question` call or form. The removal is a small reduction. The remaining R6, R9 routing and deny-arm, and R13 work is still about 4.5, too much for the next lower allowed value of 3, so the score stays 5. The added positive-control comparison is priced in W11, not here: W8 (5) plus that work would be 6, which is off-scale, and the comparison is separable test-only work. v1.6: the R13 closure correction (reviewer remaining effort 0) changes §2.2's `MIN_OPENCODE_VERSION` literal from `2.4.0` to `2.4.2`, matching Design and the positive live gate. One literal; score unchanged. Rescored 3 → 5 in v1.5 for R9 and R13. R9 (reviewer effortDelta +1): `eventSessionId` reads `data.form.sessionID` for `form.created`, the fallback cancels by `data.form.id`, unit cases cover a matching and a foreign-session form, and the live test gains an explicit `question` deny-or-cancel case. R13 (+1): an opted-in live run fails on a missing or too-old binary instead of skipping, `MIN_OPENCODE_VERSION` equals the oldest release both live cases passed on, and the provider's version errors name the minimum with the doctor check's upgrade hints. The small edits these make to `event-mapper.ts` and `verify()` are priced here, not in W1. Combined work is about 5 (3 + 1 + 1), on the allowed scale. Architecture neutral: no new seam or abstraction. Split from the former 11-point W1 row with no change to scope. Re-examined in v1.4 and unchanged; the combined W1 + W7 + W8 effort is 13 after the W7 re-estimate. Includes R6 (+1 reviewer effortDelta): an injectable factory seam with fake verification and cleanup tests, plus a live authenticated external-mode run against a test-owned server that survives `close()`. Architecture neutral: the seam is a test-only dependency parameter on the existing factory, and the live test extends the existing opt-in fixture. |
| W9 | Turn ownership, owned usage, and owned cancellation: pre-aborted short-circuit, per-provider in-flight session guard and idle/empty-inbox ownership precheck with a busy error, caller-assigned `msg_` request id sent once with bounded admission reconciliation and no resend, inbox-delivery tracking and overlap detection on the streamed and polled paths with a bounded `unknown` polling state, window-scoped usage attribution that fails closed, owned cleanup (exact-id inbox cancel with bounded reconciliation and re-cancel of a late admission, session interrupt only on a managed provider's private server, left-running and unresolved reporting, bounded cleanup requests), their scripted unit tests, and the live window-usage assertion | 8 | 0 | - | R7, R8 | v1.6: rescored 5 → 8 for the closure addendum's remaining R7 (reviewer remaining effort 1) and R8 (remaining effort 2). These deltas are evidence for a re-estimate and are not added to the score. Combined-work re-estimate: the v1.5 scope was about 4 (precheck, delivery tracking and overlap on both paths, evidence-resolved cancel, and their cases). Remaining R7 adds about 1: the polling `unknown` state with inbox-before-transcript reads and its bounded reconciliation; window-scoped usage replacing the `session.get` delta, with fail-closed attribution and the closing-`idle` re-read; the delivery-between-reads and new-execution-after-terminal regressions; and the live usage assertion. Remaining R8 adds about 2: admission reconciliation replacing the same-id resend; repeated exact-id cancel reconciliation that catches a late admission; interrupt authorized by managed-server exclusivity and the per-provider in-flight guard instead of an activity check; the left-running and unresolved notes; managed and external variants of the existing interrupt cases; and the cancel-before-late-enqueue and replacement-execution regressions. That totals about 7. 7 is not an allowed value, so the row is scored 8 rather than rounded down to 5. It is not split: ownership, usage attribution, and cleanup share one per-turn state machine and one scripted fake-client fixture, so they cannot be delivered or tested apart, and 8 is within the scale. Uncertainty sits in event ordering under load and in whether 2.x assistant entries always carry `tokens` (the live usage assertion checks this). Architecture stays 0. The state, guard, and reconciliation live in the planned `runTurn` / `settleTurn` / `readTurnWindow` and use existing 2.4.2 client calls, with no new module, seam, coordination service, or persistence. The per-turn state is a real maintenance cost, and it nets to zero only as part of the single replacement turn loop. Window usage replaces W7's planned `session.get` baseline and delta rather than adding a second usage path. v1.5: new. Separated from W7 because W7 (5) plus this work would exceed 8, and ownership and cancellation can be built and tested apart from the core loop. R7 (reviewer effortDelta +2): ownership precheck, delivery-gated settlement, overlap handling on both paths, and the previous-terminal-before-delivery, foreign-delivery, and busy-session cases. R8 (+2): pre-abort, stable-id admission with bounded resend, evidence-based cancel versus interrupt, the cancel-races-delivery decision, and delayed or lost acknowledgment and queued-item cancellation cases. Combined work was about 4. 4 is not an allowed value, so the row was scored 5 rather than rounded down to 3. The design rests on behavior verified against a 2.4.2 server and the 2.4.2 declarations (Overview, prompt-ownership evidence). |
| W10 | Reviewer acceptance through `5x invoke`: seeded temp-project plan and run, bundled `opencode` provider selected explicitly for both roles, one unrecorded `reviewer-plan` invocation in managed mode and one in external mode, with the accepted `ReviewerVerdict` and the rendered review context's required fields checked | 1 | 0 | - | R12 | New in v1.5 for R12 (reviewer effortDelta +1). It adds two CLI invocations and their checks to the existing Phase 5 temp-project fixture and seeds the plan and run that the invoke handler requires. Kept as its own row because it is end-to-end acceptance evidence, not provider, live-test, or documentation work. Architecture neutral. |
| W11 | Headless `question` acceptance comparison: a positive-control arm on the authenticated external fixture's test-owned server (raw-client allow-only session, its own `msg_` prompt id, capture of the matching `form.created`, form cancellation and interrupt as cleanup only), raw-stream capture of `question` calls and forms for both arms over one continuous raw subscription that observes `server.connected` before either prompt and stays live through the deny execution's raw terminal event, the bounded successful (`done`, no `error`) deny-arm assertion through the provider, inconclusive-as-failure handling for a missing control form, an observation gap, or a missing deny terminal event, and the per-arm and observer log | 2 | 0 | - | P1.1, R15 | v1.9: rescored 1 → 2 for R15 (amendment review; reviewer effort 1, architecture delta 0). The reviewer's effort is evidence for a re-estimate, not added to the score. Combined-work re-estimate: the v1.8 scope (control session, scoped capture, cleanup, per-arm log) was about 1. R15 adds about 1 of test-only work in the same capture: awaiting the raw `server.connected` before either prompt, correlating the deny session's raw delivery to its first terminal event, keeping the one subscription consumed until then, detecting a stream end, error, or resubscription as a gap, and failing inconclusively on a gap or a missing terminal event within the bound, with the observer log. The combined work is about 2, which is on the allowed scale, so the row is scored 2. It is not split: the observer is the existing capture of this row, and the requirement cannot be tested apart from it. The added point is not offset by lowering any other row, and the amendment review baseline does not reset the plan's original execution baseline. Architecture stays 0: no production code, seam, or module changes; the provider's `done` / no-error requirement is unchanged. New in v1.8 for P1.1 (Phase 2 review `run_98e4caae2772-phase-2-review.md`; reviewer estimated additional effort 1, architecture delta 0, no API, schema, dependency, subsystem, or phase-structure change). The work extends one existing live case with a second session and a raw event subscription on a server the external fixture already starts. No production code changes: the implemented provider already has no form fallback, and the `question` deny rule is unchanged. Scored 1, the reviewer's estimate, which is on the allowed scale. It is a separate row because W8 (5) plus this work would be 6, which is off-scale; rescoring W8 to 8 would overstate the combined work by about 2. Architecture neutral: no new seam, module, or production path. Uncertainty: model compliance with the prompt in the control arm. A control that does not produce a form fails as inconclusive and is never counted as a pass. |
| W2 | Prompted structured output: `structured-output.ts` string-aware top-level extractor, schema-wrapped summary prompt, corrective retries | 3 | 1 | - | R5 | A small new module inside the provider subsystem replaces a server feature 2.x removed. +1 architecture because 5x now owns extraction and retry policy for OpenCode, beside the Cursor package's separate extractor. Rescored 2 → 3 for R5: the extractor is a new forward scanner with string, escape, and depth state and nested, escaped-quote, string-brace, multiple-object, and array rejection tests. It does not port the Cursor package's backward brace counter. Architecture unchanged: the scanner sits inside the already planned module. |
| W3 | Delete dead TUI controller, permissions, detect, and event-router modules, their tests, and the stale init hint | 1 | -2 | DC0 (`intrinsic`) | R1, R10 | v1.5: R10 (reviewer effortDelta 0) changes only the Phase 1 completion gate's unit-test command to the configured invocation that the Phase 1 review ran and saw exit 0. No completed work is redone or waived, and the score is unchanged. Deletion only, after confirming there are no importers. Removes about 1.2k production lines and about 1.4k test lines tied to the retired `opencode attach` path. R1: moved to Phase 1, ahead of the provider port, so the SDK dependency removal and its typecheck gate in Phase 2 can pass. Reordering existing work leaves effort and architecture unchanged. v1.4 evidence: completed in Phase 1 (`fa19978d`, independently reviewed in `ce74d860`). Actual work matched the score: about 1.23k production lines and 1.37k test lines deleted, plus two one-line edits. Score unchanged. |
| W4 | `5x doctor` OpenCode version check and `opencode.url` config description | 2 | 1 | - | - | A new detect-only check in the existing doctor registry, plus a config description update. +1 for one more check to maintain. |
| W5 | Harness assets: 2.x agent frontmatter, `NATIVE_DELEGATE_TOOL` / `NATIVE_AGENT_PARAM` tokens and OpenCode `sessionID` continuation, OpenCode background launch/await/continue lifecycle tokens, base skill and orchestrator wording and continuation references, asset-impact verification across delegation modes and install/sync paths, live installed native delegation and continuation exercise | 5 | 0 | - | R2 | Crosses harness templates, the token system, five base skills, and the install/sync path. Rescored 3 → 5 for R2 (the reviewer's effortDelta of 2). The work adds lifecycle tokens at every native launch and continuation-capture site, reworks the orchestrator's `task_id` continuation instructions, adds launch-versus-completion and continuation assertions in all four delegation modes, and adds one real delegation and continuation by the installed orchestrator on a live 2.x server. No new abstraction: the token mechanism already exists and gains entries, and Cursor output stays byte-identical. |
| W6 | Documentation and release notes: CHANGELOG, upgrade guide, getting started, configuration, README, harness README, AGENTS.md test layout | 2 | 0 | - | R7, R8 | Documentation across existing files. v1.6: R8 extends the same CHANGELOG line and configuration note. On an external server, a timeout or cancellation never interrupts the session and may leave its execution running, and an unresolved prompt admission is reported as such. Score unchanged: this extends text the row already prices. v1.5: R7 adds one CHANGELOG breaking-change line and one configuration note for the busy-session error. Score unchanged. |

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
| operator | AC1: `5x invoke` with `provider = "opencode"` works against OpenCode 2.x in managed and external mode, including streamed events and structured author/reviewer results | W1, W7, W9, W8, W2 / Phase 2; W10 / Phase 5 | Unit tests with a scripted fake client and a fake factory seam (healthy, unauthorized, verification-failure cleanup), including prompt ownership, overlap, window-scoped usage, and owned cancellation; opt-in live test passing against a local OpenCode at `MIN_OPENCODE_VERSION` for a managed provider and for an authenticated external provider against a test-owned server, with the run's `opencode --version` recorded; manual end-to-end `5x invoke` in a seeded temp-project plan and run, in both managed and external (`--opencode-url` with `OPENCODE_PASSWORD`) mode, for the author role (valid `AuthorStatus`) and, unrecorded, the reviewer role (accepted `ReviewerVerdict`) |
| operator | AC2: 5x 2.0 requires OpenCode 2.x and says so clearly when given 1.x or an older 2.x | W1, W8, W4 / Phases 2, 3 | Version-gate unit tests (1.x server, old 2.x, unauthorized), whose messages name `MIN_OPENCODE_VERSION` and the doctor's upgrade hints; `5x doctor` finding with a fake 1.x `opencode` on `PATH` |
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
- `bun run typecheck` and `bun test --concurrent --parallel=2 --dots --timeout 15000 test/unit` pass. This is the configured unit invocation (the `package.json` `test` flags). The bare `bun test test/unit` exits 1 with zero failed tests on both the base and the Phase 1 tree, as the Phase 1 review recorded, so it is not a usable gate.

### 1.1 Tasks

- [x] Re-confirm no importers of `src/tui/*` or `src/utils/event-router.ts` in `src/`, `packages/`, or `test/` outside their own tests
- [x] Delete `src/tui/controller.ts`, `src/tui/permissions.ts`, `src/tui/detect.ts`, `src/utils/event-router.ts`, and `test/unit/tui/*` (`controller.test.ts`, `permissions.test.ts`, `phase4-integration.test.ts`)
- [x] Remove the `External TUI is opt-in: use --tui-listen` line at `src/commands/init.handler.ts:499` and any test asserting it
- [x] Remove the `tui/` entry from the AGENTS.md test directory layout

## Phase 2: Provider port to `@opencode/client`

**Completion gate:**
- `src/providers/opencode.ts` and `src/providers/event-mapper.ts` import only `@opencode/client`, and `@opencode-ai/sdk` is gone from `package.json` and `bun.lock`.
- Managed and external providers pass the version gate against OpenCode 2.x.
- `run()` and `runStreamed()` return correct text, events, tokens, and structured output on both the streamed and the polling path. They settle only on their own delivered prompt and report usage only from that prompt's transcript window. They never return success on overlapped input or on a prompt whose state is unresolved. They cancel only their own request id, and interrupt a session only on the provider's private managed server.
- `bun test test/unit/providers`, `bun run typecheck`, and `bun run build` pass.
- `FIVEX_OPENCODE_LIVE=1 bun test test/integration/providers/opencode-live.test.ts` passes, with no skipped case, for the managed, authenticated external, and headless `question` comparison cases against a local OpenCode whose version equals `MIN_OPENCODE_VERSION`. The PR description records that `opencode --version`.
- The headless `question` comparison passes only when, on one test-owned server, the allow-only positive control emits a matching `form.created` and the denied provider arm ends in `done` with no `error` within its bound with no matching `question` call or form, over a raw observation window that saw `server.connected` before either prompt and stayed live through the deny execution's raw terminal event (Design Decisions). A missing control form, an observation gap, or a missing deny terminal event fails as inconclusive. A deny-arm form, `question` call, timeout, or error fails the case. None counts as a pass.

### 2.1 Dependency

- `package.json`: remove `"@opencode-ai/sdk": "^1.2.6"`; add `"@opencode/client": "<exact latest 2.x>"`; refresh `bun.lock`.
- Import only from `@opencode/client` (the Promise root). Do not import `@opencode/client/effect`, `/solid`, or `/service`.

### 2.2 Provider construction (`src/providers/opencode.ts`)

```ts
import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";

export const MIN_OPENCODE_VERSION = "2.4.2";

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

- `createManaged` (replaces lines 754–771) spawns as described in Design Decisions, with `stdin: "ignore"`, `stdout: "pipe"`, and `stderr: "pipe"`. `spawn` is an injectable seam for unit tests. The client is `OpenCode.make({ baseUrl, headers: { authorization } })`.
- `createExternal` (replaces lines 776–782) reads `opts.password ?? process.env.OPENCODE_PASSWORD ?? process.env.OPENCODE_SERVER_PASSWORD` and adds the basic-auth header only when a password exists.
- `verify()` (replaces lines 852–868) does the version comparison (major.minor.patch, ignoring prerelease suffixes) and maps errors to the messages in Design Decisions. Both version messages name `MIN_OPENCODE_VERSION`.
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
  - `session.inbox.enqueued`, `session.inbox.delivered`, `session.inbox.cancelled`;
  - `form.created`, `permission.asked`.

  An unexpected `permission.asked` for the session is reported as an `error` event. With the allow-all ruleset it should not occur.
- The inactivity timeout resets on every event for the session, and while polling on server-side progress. On timeout or cancel, the turn runs owned cleanup (Design Decisions). It cancels by its own exact `requestId` with bounded reconciliation, re-cancelling a late admission and treating only `session.inbox.cancelled` as removal. It calls `session.interrupt` only on a delivered turn of a managed provider, whose private server makes exclusive use established by construction; it never calls it on an external provider, and never decides from `session.active()`. Each cleanup request is bounded, errors are swallowed, and the typed error is raised without waiting for a terminal event, with a left-running or unresolved note where that applies.
- Events for any other session on the shared stream, as resolved by `eventSessionId`, are dropped before mapping. They neither reset the timeout nor end the turn.
- A private `admitPrompt(text)` generates the turn's `msg_5x…` `requestId` and runs the ownership precheck: the provider's in-process set of sessions with an active turn, then the idle/empty-inbox check. It sends `session.prompt` once with `id` and `delivery: "queue"`, bounded at 10 s. On a timeout or lost reply it reconciles admission for up to 10 s from inbox, transcript, and stream evidence, and never resends. A pre-aborted `signal` raises `AgentCancellationError` before any request. The session id leaves the in-flight set when the turn ends, after cleanup.
- Turn state (`admitting` / `pending` / `delivered` / `unknown` / `removed`, `overlap`, and `cancelRequested`) is per turn. The streamed path updates it from inbox and execution events. The polled path updates it from `session.inbox.list` read before the transcript, and keeps `unknown` (never `removed`) when `requestId` is in neither, until the 10 s reconciliation bound (Design Decisions, turn loop steps 5–6).
- There is no `form.cancel` fallback (Design Decisions). The turn loop never calls `session.form.cancel`. A `form.created` is routed by `data.form.sessionID`; a foreign one is dropped, and a matching one produces no `AgentEvent` and does not by itself end the turn, which settles and cleans up under its existing rules. No form-specific terminal policy is defined.
- A private `settleTurn(outcome)` is the only place that turns a terminal outcome into a result or error. The streamed terminal event after delivery and the polled `idle` transcript entry after `requestId` both call it (Design Decisions, turn loop step 7).
- A private `readTurnWindow(promptId)` returns the text and usage of the entries after `promptId` up to its closing `idle` entry. It uses the `session.context` fast path, and falls back to paginated `session.message.list` when compaction has removed the prompt. It re-reads for up to 10 s until the closing `idle` entry is readable, treats another `user` entry in the window as overlap, and raises the explicit missing-boundary and no-end errors (turn loop step 8).
- `RunResult.tokens` / `costUsd` are the window usage (turn loop step 9) summed across the execute turn and any summary and corrective turns. `costUsd` is undefined if any turn's cost is undefined. `session.get` is never read for usage. A window entry without `tokens` fails the turn with the attribution error.

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
export function eventSessionId(event: OpenCodeEvent): string | undefined; // data.form.sessionID for form.created, else data.sessionID
export function mapOpenCodeEvent(event: OpenCodeEvent, state: EventMapperState): AgentEvent | undefined;
export function summarizeToolInput(tool: string, input: unknown): string;
```

- Remove `SessionResolveContext`, `resolveSessionIdWithContext`, `getEventSessionId`, `MAX_TRACKED_DELTA_PART_IDS`, `mapSseToAgentEvent`, and `mapSseStreamToAgentEvents`.
- Update the exports in `src/providers/index.ts` and `src/index.ts` (around lines 281–294) to the new names. This is an allowed 2.0 public API change, recorded in the CHANGELOG in Phase 5.

### 2.6 Tests

- `test/unit/providers/opencode.test.ts` (rewrite) uses a structural fake `OpenCodeClient` whose `event.subscribe` yields scripted events and whose `session.*` methods record calls. Cases:
  - `parseServeListenUrl` on the 2.x line, on a partial chunk, and on noise;
  - `parseModel` with and without `#variant`, and invalid input;
  - managed spawn argv has `serve`, `--hostname=127.0.0.1`, `--port=0`, no `--service`, and `OPENCODE_PASSWORD` in env, and the spawn options are `stdin: "ignore"`, `stdout: "pipe"`, and `stderr: "pipe"`;
  - managed spawn exiting before the listen line reports stderr;
  - managed spawn that never prints the listen line times out at the bound, kills the process, and leaves no child;
  - stdout and stderr keep draining after the listen line: a fake child that writes past a pipe buffer does not block, and the stderr tail stays bounded;
  - external auth header from `OPENCODE_PASSWORD`, from `OPENCODE_SERVER_PASSWORD`, and none;
  - `createExternal` construction-only assertions (base URL, auth header, no request sent);
  - version gate: ok, old 2.x, a 1.x-style failure, and unauthorized. The old-2.x and 1.x messages name `MIN_OPENCODE_VERSION` and use `opencode upgrade` and `opencode upgrade --major` respectively;
  - `startSession` sends `location`, `model`, and the headless permissions;
  - `resumeSession` reads the directory and calls `switchModel` only on override;
  - streamed text, reasoning, and tool events in order, ending on `execution.succeeded`. The scripted stream includes `inbox.enqueued`, `execution.started`, and `inbox.delivered` for the turn's own `requestId` before the content events;
  - `session.prompt` is sent with `id` matching `^msg_5x` and `delivery: "queue"`, and the summary and corrective turns each use a new id;
  - ownership precheck: a session listed by `session.active()`, or with an item in `session.inbox.list`, fails with the busy error and sends no prompt. A second concurrent turn on a session that the same provider is already driving fails with the busy error before any request;
  - previous same-session terminal before delivery: the stream yields `execution.succeeded` for the session after this turn's `inbox.enqueued` but before its `inbox.delivered`. The turn does not settle on it, does not return that execution's text or usage, and never returns success. It fails with the ambiguous-overlap error after cancelling its own pending item;
  - foreign delivery into the turn's execution: another `inboxID` is delivered after this turn's, then `execution.succeeded`. The turn fails with the ambiguous-overlap error, does not interrupt the shared execution, and sends no summary prompt;
  - a foreign `inbox.enqueued` while this turn is pending: the turn cancels its own item and fails with the ambiguous-overlap error;
  - an unrequested `inbox.cancelled` for this turn's `requestId` fails with the cancelled-by-another-client error;
  - `execution.failed` and `step.failed` produce an error;
  - events for a foreign `sessionID` on the shared stream yield no `AgentEvent`, do not reset the timeout, and do not end the turn;
  - form routing: a `form.created` for a foreign session (by `data.form.sessionID`) is not cancelled and does not reset the timeout. The provider never calls `session.form.cancel`; there is no fallback;
  - polling fallback when the stream ends early, once per outcome:
    - `succeeded` returns text and usage;
    - `failed` produces the same error as the streamed `execution.failed`;
    - `interrupted` by our own cancel or timeout raises `AgentCancellationError` / `AgentTimeoutError`;
    - a foreign `interrupted` produces an error.

    Each case matches the streamed result for the same outcome, and only `succeeded` sends a structured summary prompt;
  - SSE drops after delivery but before any assistant message, then polling sees the delivered `requestId` followed directly by an `idle` entry with `outcome: "failed"` and its `error` (and, separately, a foreign `interrupted`), with no assistant message between them: the turn terminates with that original outcome's error, sends no summary prompt, and settles on that poll without waiting for the inactivity timeout;
  - polling with a stale prior state: the fake's `session.get` reports `outcome: "succeeded"` and the transcript ends with an earlier turn's `idle` entry. The turn does not complete until an `idle` entry appears after `requestId`;
  - polling under remote clock skew, with server timestamps hours ahead of and behind the client, completes correctly and never early (no timestamp is compared);
  - polling ownership: `requestId` still in `session.inbox.list` keeps polling; another `user` entry between the recorded transcript tail and this turn's `idle` entry yields the ambiguous-overlap error, not success;
  - polling, delivery between reads: on one poll the fake's inbox read no longer lists `requestId`, and the transcript read on the same poll does not yet hold it. On the next poll the transcript holds `requestId`, then this turn's `idle{outcome: "succeeded"}`. The turn stays `unknown` on the first poll, never reports removal or cancellation by another client, sends no `session.inbox.cancel`, and returns the delivered result. Each poll's inbox read precedes its transcript read;
  - polling, unknown beyond the bound: `requestId` stays out of both inbox and transcript, with no `inbox.cancelled` seen before the stream ended. The turn fails with the unknown-outcome error after the 10 s reconciliation bound. It never returns success and never raises the cancelled-by-another-client error;
  - polling inactivity timeout on a delivered, running turn: a managed provider calls `interrupt` once and raises `AgentTimeoutError`, and an external provider never calls `interrupt` and raises `AgentTimeoutError` with the left-running note. Cancel during polling does the same with `AgentCancellationError`;
  - turn text from `session.context` uses only assistant entries after the prompt id;
  - compaction removed `promptId` from `session.context`: the text comes from `session.message.list`;
  - a reply spanning more than one `session.message.list` page is concatenated in order;
  - `promptId` missing from both context and every message page raises the explicit missing-boundary error and does not return other context text;
  - window usage: `tokens` and `cost` are summed over this window's `assistant` entries and a completed `compaction` entry inside it. The fake's `session.get` returns arbitrary cumulative totals, and the result does not depend on them;
  - new execution between the terminal event and the usage read: after this turn's `execution.succeeded`, the fake's cumulative `session.get` totals jump, and the transcript gains a foreign `user`, `assistant` (with `tokens` and `cost`), and `idle` after this turn's `idle` entry. Usage equals the sum of this window's entries only, and the text excludes the foreign reply. A variant where the closing `idle` entry becomes readable only on the second read still succeeds;
  - attribution fails closed: an `assistant` entry in the window without `tokens` fails the turn with the attribution error, and one without `cost` leaves `costUsd` undefined. Neither case falls back to `session.get`;
  - window with no readable closing `idle` entry within 10 s raises the no-end error;
  - inactivity timeout and caller cancellation on a delivered, non-overlapped, running turn keep the error types and messages. A managed provider calls `interrupt` once; an external provider never calls it, and appends the left-running note;
  - owned cancellation:
    - a `signal` aborted before `runTurn` raises `AgentCancellationError` with no subscribe, prompt, or other request;
    - cancel of a known queued item (`requestId` in `session.inbox.list`, not delivered) calls `session.inbox.cancel` with that `inboxID`, never calls `interrupt`, and raises `AgentCancellationError`;
    - cancel while admission is in flight with a delayed acknowledgment, and separately with a lost one (the `prompt` request rejects after the server enqueued the item): cleanup cancels by the same `requestId`, resolves removal only from `inbox.cancelled`, and raises `AgentCancellationError`. `session.prompt` is called exactly once;
    - cancel before a late enqueue: the caller cancels while `session.prompt` is in flight. The first `session.inbox.cancel` finds no item (acknowledged, no event), and the fake then enqueues the late request (`inbox.enqueued{inboxID: requestId}`, and `requestId` in `session.inbox.list`). Cleanup cancels again by the same `requestId`, resolves `removed` on `inbox.cancelled`, never resends, and raises `AgentCancellationError`. In a variant where the late enqueue comes after the 10 s reconciliation bound, the error carries the unresolved note, and the absence observed during the bound is never reported as removal;
    - lost admission reply, without cancellation: when `inbox.enqueued{inboxID: requestId}` or `requestId` in `session.inbox.list` appears within 10 s, the turn proceeds and returns its result; with no evidence within 10 s, it fails with the unresolved-admission error. In both cases `session.prompt` is called exactly once;
    - cancel racing delivery: `inbox.cancel` acknowledges, but the transcript already holds `requestId` and the session is running. A managed provider calls `interrupt` once; an external provider never calls it and appends the left-running note. Both raise `AgentCancellationError`;
    - replacement execution between an activity check and the interrupt: the fake's `session.active()` lists the session while this turn's execution runs. That execution then ends, and a foreign prompt starts a new execution on the session before cleanup runs. An external provider never calls `session.interrupt`. A managed provider's single `interrupt` call is made with the same arguments whatever `session.active()` returns: the fake asserts that no interrupt decision reads `session.active()` after the precheck;
    - timeout or cancel on an overlapped, delivered turn: an external provider does not call `interrupt`. A managed provider calls it once, because the overlapping input can only be this invocation's own work on its private server;
    - cleanup requests that hang are abandoned at their bound, and the typed error is raised without any terminal event after the local abort;
  - structured: success first try, success after one corrective turn, failure after two;
  - `run()` equals the `done` result of `runStreamed()`;
  - `close()` is idempotent and kills the managed process.
- `test/unit/providers/opencode-factory.test.ts` (new) calls `createProvider` with an injected `OpenCodeFactoryDeps` fake and no network I/O:
  - external healthy: `verify()` runs and the provider is returned;
  - external unauthorized: the password error propagates and the provider is closed;
  - external verification failure (1.x or old 2.x): the error propagates and the provider is closed;
  - managed verification failure: the provider is closed;
  - `opencode.url` selects `createExternal`, and its absence selects `createManaged`.
- `test/unit/providers/event-mapper.test.ts` (rewrite) covers each mapping row, the tool id→name map, a missing name falling back to `unknown`, `tool_end` truncation, `summarizeToolInput` for `shell`, `read` (`path`), `edit`, `glob`, `grep`, `subagent`, and unknown tools, and `eventSessionId` returning `data.sessionID`, and `data.form.sessionID` for `form.created`. Foreign-session isolation is asserted at the provider level in `opencode.test.ts`.
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
- `test/integration/providers/opencode-live.test.ts` (new) is skipped only when `FIVEX_OPENCODE_LIVE` is not `1`. When it is set, missing prerequisites are failures, not skips: an `opencode` not on `PATH`, an unparseable `opencode --version`, or a version below `MIN_OPENCODE_VERSION` fails a first prerequisite test with a message naming the found and required versions. The test logs the `opencode --version` it ran against. Model comes from `FIVEX_OPENCODE_LIVE_MODEL`, default `opencode/deepseek-v4.1-flash-free`. In a temp directory containing `hello.txt`:
  - Managed mode:
    - `runStreamed` asks for a shell `cat hello.txt` and a reply containing the token, and expects `tool_start` (`shell`), `tool_end`, `text`, `usage`, and `done`. The `usage` event and the `RunResult` carry positive input and output tokens read from the turn window, which shows that 2.x assistant entries carry the `tokens` that window attribution needs;
    - a second run with an `AuthorStatus`-shaped `outputSchema` returns an object;
    - after `close()`, no child `opencode serve` process remains.
  - Authenticated external mode, against a test-owned server:
    - The test starts `opencode serve --hostname=127.0.0.1 --port=0` with a random `OPENCODE_PASSWORD`.
    - In a `test.serial` case it sets and then restores `process.env.OPENCODE_PASSWORD`, and builds the provider through `createProvider` with `opencode.url` set to that server.
    - It runs the same streaming and structured-output checks.
    - Without the password, `createProvider` fails with the password error.
    - After the provider's `close()`, the test-owned server process is still alive and answers an authenticated `server.info()`. The test then stops it in `afterAll`.
  - Headless `question` comparison, in the authenticated external group against its test-owned server (same binary, at `MIN_OPENCODE_VERSION`). Both arms use one prompt that tells the agent to call the `question` tool to ask the user to choose between two options before replying, the same model, and a fresh session each.
    - Raw observer: before submitting either arm's prompt, the test opens one raw-client `event.subscribe` on the server (without a session filter, or with a `types` list that includes `server.connected`, `session.inbox.enqueued`, `session.inbox.delivered`, `session.tool.input.started`, `session.tool.called`, `form.created`, and `session.execution.*`), starts consuming it, and awaits its `server.connected` marker within a bound. It keeps consuming that one subscription, without ending or resubscribing, until it has recorded the deny session's raw terminal `session.execution.*` event for the execution that received the deny prompt (the first terminal event for the deny session after its raw `session.inbox.delivered`). If the stream ends or errors before that event, or the event does not arrive within the case bound, the case fails as inconclusive, even if the provider reported `done`. Both arms' `question` calls and forms are judged only from this subscription and, for the deny arm, the provider's own events.
    - Positive control: the test creates a session with the raw client and only the allow-all rule, then prompts it with its own `msg_` id. The case requires a `form.created` whose `data.form.sessionID` is the control session within the test bound. If none appears, the case fails as inconclusive. The test then cancels that exact form by `data.form.id` as cleanup, and interrupts the control session if it is still running. The case does not require the control to continue or succeed after cancellation; it records the terminal events it saw.
    - Deny arm: the provider, built by `createProvider` against the same server with the same password setup, starts a session through `startSession` (headless rules) and calls `runStreamed` with the same prompt and a 90 s turn timeout. It passes only if the run ends in `done` with no `error` event, the raw observer stayed connected through the deny execution's raw terminal event, and neither the provider events (`tool_start` with tool `question`) nor the raw stream (`session.tool.input.started` or `session.tool.called` for `question`, or `form.created` for the deny session) show a question over that window. A deny-arm form is cancelled as cleanup, and the case fails.
    - The test logs, for each arm, the tools called, whether a form appeared, and the terminal outcome, and logs when the raw observer connected and the deny terminal event it ended on, or the gap that made the case inconclusive. No path passes on absence alone.

  Uses `stdin: "ignore"` and `timeout: 120000`.

- [x] Replace `@opencode-ai/sdk` with an exact-pinned `@opencode/client` in `package.json` and `bun.lock`
- [x] Implement managed spawn (explicit `stdout`/`stderr` pipes, startup-timeout kill, continuous output draining), external auth, `verify()` version gate, and error mapping naming `MIN_OPENCODE_VERSION` in `src/providers/opencode.ts`
- [x] Implement headless `startSession`, `resumeSession` with `switchModel`, and `#variant` model parsing
- [x] Implement `runTurn` with subscription handshake, delivery-gated terminal events, and durable `idle`-entry polling fallback
- [x] Implement prompt ownership: pre-aborted short-circuit, per-provider in-flight session guard and idle/empty-inbox precheck with the busy error, `msg_5x` request id sent once with bounded admission and admission reconciliation (no resend), streamed and polled delivery tracking with the bounded `unknown` state, and ambiguous-overlap handling
- [x] Implement owned cleanup for timeout, cancellation, overlap, and unresolved admission: exact-id `session.inbox.cancel` with bounded reconciliation and re-cancel of a late admission, removal only on `inbox.cancelled`, `session.interrupt` only for a delivered turn on a managed provider's private server (never external, never decided from `session.active()`), left-running and unresolved notes, and bounded cleanup requests
- [x] Implement `settleTurn` as the single terminal-outcome handler for the streamed and polling paths
- [x] Implement `readTurnWindow` with the `session.context` fast path, paginated `session.message.list` fallback, closing-`idle` re-read, and missing-boundary and no-end errors, and window-scoped usage with fail-closed attribution in place of any `session.get` delta
- [x] Rebuild `runStreamed()` and `run()` on `runTurn`, keeping timeout and cancellation semantics
- [x] Add `src/providers/structured-output.ts` with the string-aware top-level scanner, and the structured summary with corrective retries
- [x] Rewrite `src/providers/event-mapper.ts` for 2.x events, with `eventSessionId` reading `data.form.sessionID` for `form.created`, and update `src/providers/index.ts` / `src/index.ts` exports
- [x] Make `createOpenCodeProvider` verify external providers and close on verify failure, through the `OpenCodeFactoryDeps` seam
- [x] Run the live headless `question` comparison case on one test-owned server: the raw observer must see `server.connected` before either prompt and stay live through the deny execution's raw terminal event (a gap or missing terminal event fails as inconclusive), the allow-only positive control must emit a matching form (cancelled only as cleanup), and the denied provider arm must end in `done` with no `error` within its bound with no matching `question` call or form. Implement no `form.cancel` fallback; keep the foreign-session form unit case. If the deny arm shows a form or `question` call, the case fails and the plan must be amended
- [x] Rewrite `opencode.test.ts` and `event-mapper.test.ts`; add `structured-output.test.ts` and `opencode-factory.test.ts`; update the `plugin-loading.test.ts` bundled case to use the fake seam
- [x] Add the opt-in live test with managed, authenticated external, and headless `question` comparison cases. When opted in, it fails rather than skips on a missing or too-old binary. Pass it against local OpenCode 2.x, set `MIN_OPENCODE_VERSION` to the oldest release both provider cases passed on, and record that `opencode --version` in the PR description
- [x] Confirm `bun run build` compiles with the new dependency

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

- [x] Add `src/doctor/checks/opencode.ts` with injectable version runner and register it
- [x] Add unit tests: not applicable, missing binary, 1.x, old 2.x, current 2.x, unparseable output
- [x] Add a doctor integration case with a fake `opencode` script on `PATH` printing `1.2.3`
- [x] Update the `opencode.url` description and the config registry/help snapshot tests that include it

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
  - an OpenCode turn on a session that is already running or has queued input fails with a busy error, and a turn that shares its execution with other input fails as ambiguous, instead of returning another prompt's result. A turn whose prompt state cannot be established fails instead of succeeding. On an external server, a timeout or cancellation never interrupts the session and may leave its execution running;
  - the TUI attach modules were removed.

  Under **Added**: the `5x doctor` OpenCode check.
- `docs/upgrading.md` ("From v1.3" steps): add "Upgrade OpenCode to 2.x (`opencode upgrade --major`)" before the harness sync step, noting that 2.x replaces the 1.x binary.
- `docs/getting-started.md`: OpenCode 2.x prerequisite, plus `opencode` (or `opencode --server <url>`) to start.
- `docs/configuration.md`: `opencode.url`, `OPENCODE_PASSWORD`, managed-mode behavior (private server, never the background service), and the note that 5x cannot attribute a turn on an external session that another client is driving at the same time (busy and ambiguous-overlap errors). The note also says that, on an external server, a timed-out or cancelled turn attempts to cancel its own queued prompt and reports when removal cannot be confirmed, but never interrupts a running execution, so the execution may keep running; and that an unresolved prompt admission is reported, not assumed cancelled.
- `README.md` provider table and `src/harnesses/opencode/README.md`: OpenCode 2.x requirement.
- AGENTS.md: test layout updated in Phase 1. No other AGENTS.md change.

### 5.2 Final verification

1. `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.
2. `bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts` (the AGENTS.md acceptance suite).
3. `FIVEX_OPENCODE_LIVE=1 bun test test/integration/providers/opencode-live.test.ts`, with the managed, authenticated external, and headless `question` comparison cases passing and none skipped. The comparison passes only under the Phase 2 rule: a matching control form, and a denied provider arm ending in `done` with no `error` within its bound with no matching `question` call or form, over a raw observation window from `server.connected` before either prompt through the deny execution's raw terminal event. A missing control form, an observation gap, a missing deny terminal event, or any deny-arm form, `question` call, timeout, or error, fails the step. The `opencode --version` used must equal `MIN_OPENCODE_VERSION`. If only a newer release was available, raise the constant to that release before release, rerun, and record the version.
4. In a temp git project:
   1. Run `5x init` and `5x harness install opencode --scope project`.
      - Select the bundled provider explicitly for both roles: `author.provider = "opencode"` and `reviewer.provider = "opencode"`, each with a free model.
      - Seed a minimal valid plan from the default plan skeleton, confirm that `5x plan phases <plan>` accepts it, commit it, and run `5x run init --plan <plan>`. Export `FIVEX_RUN`. The invoke handler requires a run.
   2. Start `OPENCODE_PASSWORD=x opencode serve --print-logs`, then query `/api/agent` and `/api/skill` with `directory=<project>`. Confirm the four agents with the expected permissions, all 5x skills, and no "ignored unsupported agent fields" line.
   3. Run the Phase 4 installed-orchestrator native delegation and continuation exercise against that server.
   4. Managed mode, with no `opencode.url`:
      - Run `5x invoke` for the author role on the seeded run. Confirm streamed output and a valid `AuthorStatus`.
      - Run one unrecorded reviewer invocation on the same run: `5x invoke reviewer reviewer-plan --run $FIVEX_RUN --var review_path=<temp review path>`, without `--record`. It must exit 0 with `.data.result` accepted as a `ReviewerVerdict` by the CLI's role validation, not just parsed as JSON. Every field the rendered review context requires for this run must be present, and the review file must exist at the given path.
      - Confirm that `5x run state` shows no recorded reviewer step, and that no `opencode serve` child remains afterwards.
   5. External mode, with `--opencode-url <url of the step 2 server>` and `OPENCODE_PASSWORD=x`:
      - Run the same author invocation and the same unrecorded reviewer invocation, with a different review path, and apply the same checks.
      - Confirm that the step 2 server is still running and answering afterwards.
      - Then run the author invocation once without `OPENCODE_PASSWORD` and confirm the password error.
5. `5x doctor` with OpenCode 2.x on `PATH` (no finding), then with a fake 1.x `opencode` first on `PATH` (`opencode-outdated`).

- [ ] Update CHANGELOG, upgrading guide, getting started, configuration, README, and harness README
- [ ] Run lint, typecheck, full test suite, build, and the AGENTS.md acceptance suite; fix regressions
- [ ] Run the live provider test at `MIN_OPENCODE_VERSION` with no skipped case (including the headless `question` comparison), and the manual temp-project verification (installed delegation; managed and authenticated external author `5x invoke`; one unrecorded reviewer `5x invoke` per mode on the seeded run with an accepted `ReviewerVerdict`), recording results and the `opencode --version` in the PR description

## Files Touched

| File | Change |
|------|--------|
| `package.json`, `bun.lock` | Replace `@opencode-ai/sdk` with exact-pinned `@opencode/client` (W1) |
| `src/providers/opencode.ts` | 2.x client, managed spawn with explicit output pipes, auth, version gate and minimum-naming errors, turn loop with polling fallback, `settleTurn`, `readTurnWindow` with window-scoped usage, prompt ownership with admission reconciliation and owned cleanup, `form.created` routing with no form-cancel fallback, structured summary (W1, W7, W9, W8, W2) |
| `src/providers/event-mapper.ts` | 2.x event mapper; `eventSessionId` with `form.created` routing (W1, W8) |
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
| `CHANGELOG.md`, `docs/upgrading.md`, `docs/getting-started.md`, `docs/configuration.md`, `README.md`, `AGENTS.md` | Documentation, including the busy-session, ambiguous-overlap, and external left-running behavior (W3, W6) |
| `test/unit/providers/opencode.test.ts`, `event-mapper.test.ts`, `structured-output.test.ts`, `opencode-factory.test.ts`, `plugin-loading.test.ts` | Provider tests (W1, W7, W9, W2), form-routing cases (W8), and factory tests (W8) |
| `test/integration/providers/opencode-live.test.ts` | Opt-in live test (W8); headless `question` comparison with positive control (W11) |
| `test/unit/tui/*` (`controller.test.ts`, `permissions.test.ts`, `phase4-integration.test.ts`) | Deleted |
| `test/unit/doctor/*`, `test/integration/commands/doctor*.test.ts` | OpenCode check tests |
| `test/unit/harnesses/opencode*.test.ts`, `cursor*.test.ts`, `universal.test.ts` | Harness tests and Cursor byte-identity |
| `test/unit/skills/*.test.ts`, `test/integration/commands/harness.test.ts`, `upgrade.test.ts` | Skill and install/sync tests |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `providers/opencode.test.ts` | Spawn argv/env and pipe options, listen parsing, startup-timeout kill, output draining, auth, `createExternal` construction, version gate, session create/resume, turn loop, foreign-session isolation, foreign-session form routing with no form cancel, prompt ownership (busy precheck and in-flight guard, previous terminal before delivery, foreign delivery and enqueue, external inbox cancel, lost-reply admission reconciliation), owned cancellation (pre-abort, queued-item cancel, delayed and lost acknowledgment, cancel before a late enqueue, cancel racing delivery, replacement execution between activity check and interrupt, managed-only interrupt, bounded cleanup), polling fallback (each outcome, failure and interruption before any assistant reply, stale prior state, clock skew, overlap, delivery between reads, unknown beyond the bound, timeout, cancel), compaction-safe text recovery and pagination, window-scoped usage (new execution after the terminal event, fail-closed attribution), structured retries, `run()` parity |
| Unit | `providers/event-mapper.test.ts` | Every 2.x mapping row, tool name tracking, `eventSessionId` (including `form.created`), input summaries |
| Unit | `providers/structured-output.test.ts` | Exact, fenced, and trailing top-level object extraction; nested objects, string braces, escaped quotes, multiple objects; array and scalar rejections |
| Unit | `providers/opencode-factory.test.ts` | Factory verification in both modes: healthy, unauthorized, and verification-failure cleanup through a fake seam |
| Unit | `providers/plugin-loading.test.ts` | Bundled provider routing through the fake factory seam, without network |
| Unit | `doctor/opencode` | Applicability, missing, 1.x, old 2.x, current, unparseable |
| Unit | `harnesses/opencode*.test.ts` | 2.x frontmatter, permissions, orchestrator `sessionID` continuation, token resolution, launch-versus-completion separation and continuation in four delegation modes |
| Unit | `harnesses/cursor*.test.ts` | Rendered Cursor skills byte-identical in four delegation modes |
| Unit | `skills/*.test.ts` | Token resolution and updated OpenCode wording |
| Integration | `providers/opencode-live.test.ts` (opt-in) | Real OpenCode 2.x at `MIN_OPENCODE_VERSION`, managed and authenticated external against a test-owned server: tool call, streaming, window usage, structured output, headless `question` comparison (raw observer connected before either prompt and live through the deny execution's terminal event; allow-only control emits a matching form; denied provider turn ends in `done` with no `error`, `question` call, or form; observation gaps fail as inconclusive), no leaked managed server, external server survives `close()`; opted-in runs fail rather than skip on bad prerequisites |
| Integration | `commands/upgrade.test.ts`, `harness.test.ts` | Install, stale detection, and sync to 2.x assets |
| Integration | `commands/doctor*.test.ts` | Fake 1.x `opencode` on `PATH` yields a finding |
| Manual | Temp project + live server | Effective installed assets load cleanly; installed orchestrator native delegation and continuation; end-to-end author `5x invoke` and unrecorded reviewer `5x invoke` (accepted `ReviewerVerdict`) on a seeded run in managed and external mode |

Edge cases:
- the listen line split across stdout chunks;
- `opencode` missing from `PATH`;
- the server exiting during a run (stream error, then polling, then a session-get failure surfaced as an error);
- the SSE stream dropping after a failed or interrupted execution, including one that ends before any assistant message (polling reports the same failure promptly, never success or a timeout);
- compaction during a long turn removing the prompt from `session.context`;
- cancellation before the turn starts (no request sent), and cancellation while admission is in flight or its acknowledgment is lost (the owned item is cancelled by its request id, re-cancelled if it is admitted late, and reported unresolved without positive evidence);
- a lost admission reply without cancellation (reconciled from evidence, never resent);
- cancellation racing delivery of the turn's own prompt (interrupt only on the managed private server);
- delivery observed between a poll's inbox and transcript reads (unknown, never removal);
- another client's execution starting between this turn's terminal event and its usage read (usage from the turn window only);
- a resumed or externally shared session that is running, has queued input, or receives other input during the turn (busy or ambiguous-overlap error, never another prompt's result);
- a `form.created` for another session (ignored). The provider has no form-cancel fallback; a denied session that calls `question` or creates a form fails the live comparison;
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
| 2 | Provider port, prompt ownership, owned usage and cancellation, structured output, live test | 5-6 days |
| 3 | Doctor check and config | 0.5 day |
| 4 | Harness assets, skill tokens, delegation lifecycle | 1.5-2 days |
| 5 | Docs, release notes, verification | 0.5-1 day |
| **Total** | | **8-10 days** |

## Provenance

- [OpenCode: Migrate from V1](https://opencode.ai/docs/migrate-v1)
- [OpenCode plugin migration](https://opencode.ai/docs/build/plugins/migrate-v1)
- [OpenCode client docs](https://opencode.ai/docs/build/client)
- `@opencode/client` type definitions (2.3.2 and 2.4.2), including the inbox, execution, and form event types and `SessionPromptInput`. Also, from 2.4.2 `dist/promise/generated/types.d.ts`: `EventSubscribeInput` (event types only, no replay), `SessionInterruptInput {sessionID, resume?}`, `SessionInboxCancelOutput` (`void`), `SessionMessageAssistant` and `SessionMessageCompaction*` optional `tokens` / `cost`, `TokenUsageInfo`, and `MessageListInput`
- Two live probes against a local OpenCode 2.4.2 server (November 27, 2026): queued and steered delivery, caller-assigned prompt ids and their resubmission, inbox cancel of pending, unknown, and delivered items, interrupt, and the transcript `idle` entries of succeeded, interrupted, and failed executions
- Direct checks against local OpenCode 2.3.2 and 2.4.2 servers (route probes, agent and skill listings, and an end-to-end client prototype).

Operator decisions (November 27, 2026):
- 5x 2.0 requires OpenCode 2.x.
- Managed mode uses a private server per invocation.
- The dead TUI path is deleted.
- This plan is reviewed before implementation.

<!-- 5x:contract:end -->

## Revision History

### v1.9 (November 27, 2026)

Corrections to the v1.8 amendment for R14 and R15 in the "Phase 2 implementation-run amendment assessment" addendum (November 27, 2026) of `docs/development/reviews/.5x-worktrees-219-opencode-2-upgrade-plan-78d6ac-5x-cli-docs-development-plans-219-opencode-2-upgrade-plan-review.md` (review of `9e45be20`, run_98e4caae2772). Still scoped to P1.1 under authorization `c111556f-651a-490b-a706-6cbfae8f0c13`. The review's nonblocking follow-ups, P1.2, P2.1, and P2.2 are not addressed here.

- R14: Design Decisions no longer says the provider "never continues a turn past" a form. That implied an unauthorized stop-on-form exit. The bullet is now "No cancel-and-continue fallback": the provider never calls `session.form.cancel`, a matching form follows §2.3 (no `AgentEvent`, no cancel, existing settlement, timeout, and cleanup rules), no form-specific terminal policy is introduced, a deny-arm form or `question` call fails the live comparison, and a terminal policy still requires a separate amendment. §2.3's form bullet says the same.
- R15: the comparison now requires complete raw observation before a negative result counts. One raw subscription is consumed and its `server.connected` observed before either prompt. It stays live, with no end, error, or resubscription, through the deny session's raw terminal `session.execution.*` event for the execution that received the deny prompt. A gap, or no such event within the bound, fails the case as inconclusive. The provider `done` with no `error` requirement is kept. Updated: Design Decisions (headless acceptance), §2.6 live case (raw observer), the Phase 2 completion gate, the open Phase 2 live-comparison checklist item (wording only, still unchecked), §5.2 step 3, and the Tests table.
- Unchanged: the scoped positive control, Phase 1, DC0, every checklist state, the acceptance criteria and their mappings, Files Touched, the timeline, and the Surface Snapshot. No production code or new file is planned.

Delivery Budget (IDs preserved; reviewer efforts treated as evidence, not added to row scores):
- W11 rescored 1 → 2 and adds R15. The combined positive-control comparison plus the complete-observation work is about 2 points of test-only work in the same capture; architecture stays 0.
- W8 adds R14 at an unchanged 5: a wording correction with no added work.
- No other row changed, and no estimate was lowered to compensate. This adds 1 effort point over the v1.8 ledger. The original execution standard ceiling remains 38; the amendment review baseline is not a reset of the execution baseline. The CLI owns the totals and the route.

### v1.8 (November 27, 2026)

Document-only design amendment for Phase 2 finding P1.1 in `docs/development/reviews/run_98e4caae2772-phase-2-review.md` (review of `4f91b494`), under the operator's recorded amendment authorization `c111556f-651a-490b-a706-6cbfae8f0c13`, which is scoped to P1.1 only. P1.2, P2.1, P2.2, and the review's nonblocking follow-ups are implementation findings. They are not addressed here and are not listed in any `Addresses` cell.

P1.1: on OpenCode 2.4.2, the headless `question` deny prevents forms by withholding the tool. A denied session makes no `question` call, so the approved "denied `tool_end` or form cancel" case cannot pass at `MIN_OPENCODE_VERSION`. Cancelling a form interrupts the execution rather than letting the turn continue, so the fallback's premise is false.
- Design Decisions ("Sessions are headless and fully permitted"): records the review's controlled evidence. Headless acceptance is now a controlled comparison: same prompt, model, test-owned server at `MIN_OPENCODE_VERSION`, and isolated context; a fresh session and prompt id per arm.
  - The allow-only positive control must emit a matching `form.created`, or the case fails as inconclusive. Its cancellation is fixture cleanup and requires no continuation or success.
  - The denied provider arm must end in `done` within its bound with no matching `question` call or form.
  - A timeout, an arbitrary error, or absence without a passing control never counts as prevention.
- The `form.cancel` fallback and its cancel-and-continue promise are removed. If a release lets a denied session create a form or call `question`, the live case fails, and supporting it needs a further amendment with a separately verifiable terminal policy. `form.created` is still subscribed and routed by `data.form.sessionID`. The production `question` deny, the managed and external version gate, `MIN_OPENCODE_VERSION`, and the external-ownership rules are unchanged.
- Consequential edits: the Phase 2 completion gate (case renamed, plus an explicit pass/fail rule); §2.3's form bullet; §2.6's form-routing unit case (the matching-form cancel case is removed; the foreign-session case is kept) and the live case, now under the authenticated external group; the two open Phase 2 checklist items (wording only, still unchecked); §5.2 step 3 and its Phase 5 checklist item; Files Touched, Tests, and edge cases.
- Unchanged: Phase 1, every checklist state, DC0, the acceptance criteria and their mappings, the timeline, and the Surface Snapshot. The amendment adds only test work, with no new production file.

Delivery Budget (IDs preserved; the reviewer's estimated additional effort of 1 was treated as evidence, not added to a row score):
- New W11 (1, P1.1): the positive-control comparison. Split from W8, because W8 (5) plus this work would be 6, which is off-scale. Rescoring W8 to 8 would overstate the work.
- W8 stays 5 and adds P1.1 to Addresses. Removing the fallback, its matching-form unit case, and the continuation outcome is a small reduction. The remaining work is about 4.5, too much for 3.
- No other row changed. This adds 1 effort point over the v1.7 ledger. No estimate was lowered to fit a limit. The CLI owns the totals and the route.

### v1.7 (November 27, 2026)

Final corrections for the enforced closure addendum, revision 1.6 (November 27, 2026) in `docs/development/reviews/.5x-worktrees-219-opencode-2-upgrade-plan-78d6ac-5x-cli-docs-development-plans-219-opencode-2-upgrade-plan-review.md` (run_b9df06a4d15d, review of `74d43ccd`).

- R8 (admitted correction): §5.1's `docs/configuration.md` note no longer says a timed-out or cancelled external turn removes its queued prompt. It now says the turn attempts to cancel its own queued prompt and reports when removal cannot be confirmed. The external no-interrupt and possible continued execution caveats, and the unresolved-admission caveat, are kept.

No other governing text, checkpoint, scope, or estimate changed. R8 was already listed in W6's and W9's Addresses and is retained. No Delivery Budget row was rescored.

### v1.6 (November 27, 2026)

Addresses the remaining R7, R8, and R13 corrections from the enforced closure addendum (November 27, 2026) in `docs/development/reviews/.5x-worktrees-219-opencode-2-upgrade-plan-78d6ac-5x-cli-docs-development-plans-219-opencode-2-upgrade-plan-review.md` (run_b9df06a4d15d, review of `1684e990`). R9–R12 were marked addressed and are unchanged. The scope, acceptance criteria, Phase 1's checked items, gate, and evidence, and DC0 are unchanged. The governing baseline is the operator-authorized B=30. The CLI owns the totals and the route.

The corrections cite the published 2.4.2 declarations, now listed in the Overview and Provenance. Subscriptions have no replay cursor. `session.interrupt` names only a session. `session.inbox.cancel` returns `void`. Assistant and compaction transcript entries carry optional per-entry `tokens` and `cost`.

- R7 (remaining):
  - Polling reads the inbox before the transcript. When `requestId` is in neither, the turn becomes `unknown`, not removed, and keeps re-reading. Only a received `session.inbox.cancelled` proves removal. An `unknown` state that lasts 10 s fails closed, never with success.
  - Usage now comes only from the turn's own transcript window: the entries from `promptId` to its closing `idle` entry. The `session.get` baseline and delta are removed. A window entry without `tokens` fails the turn with an attribution error rather than substituting session totals. The window reader re-reads until its closing `idle` entry is readable, and treats another `user` entry in the window as overlap.
  - Added the delivery-between-reads, unknown-beyond-bound, new-execution-between-terminal-and-usage, and fail-closed attribution regressions, plus a live window-usage assertion. The early terminal failure path and the prior-terminal fixture are kept.
- R8 (remaining):
  - The same-id resend is removed: sequential idempotency is not a concurrency guarantee. A timeout or lost admission reply is now reconciled for up to 10 s from inbox, transcript, and stream evidence. Without evidence, the turn fails as unresolved and never resends.
  - Cleanup cancels by the exact id with bounded reconciliation. It re-cancels an admission that arrives late, never treats absence as removal, and reports uncertainty when no `inbox.cancelled` or delivery evidence appears.
  - `session.interrupt` is now authorized only by exclusive use established by construction: a managed provider's private, password-holding server plus a per-provider in-flight session guard. It is never authorized by `session.active()`. External providers never interrupt; they say the execution was left running.
  - Added the cancel-before-late-enqueue, lost-reply reconciliation, and replacement-execution-between-check-and-interrupt regressions, and managed and external variants of the interrupt cases. The CHANGELOG and configuration notes describe the external left-running behavior.
- R13 (remaining): §2.2's literal is now `MIN_OPENCODE_VERSION = "2.4.2"`, matching Design and the positive live gate. No new live scope.
- Consequential edits: the Phase 2 completion gate, §2.3, §2.6, the Phase 2 checklist wording, AC1 evidence, Files Touched, Tests, edge cases, and the Phase 2 timeline (4-5 → 5-6 days). `readTurnText` is renamed `readTurnWindow`.

Delivery Budget (IDs preserved; the reviewer's remaining efforts were treated as evidence, not added to row scores):
- W9 5 → 8 (R7, R8). The combined work is about 7: the v1.5 scope of about 4, plus about 1 for remaining R7 and about 2 for remaining R8. 7 is off-scale, so the row is scored 8, not rounded down. It is not split, because the work shares one per-turn state machine and one fixture. Architecture is unchanged at 0.
- W7 unchanged at 5. Its `session.get` delta moved to W9's window usage; the reduction is too small to support a lower allowed value.
- W8 unchanged at 5 (R13 literal only).
- W6 adds R8 to Addresses for the external left-running and unresolved-admission documentation, with its score unchanged.
- No other row changed. These changes add 3 effort points over the v1.5 ledger. No estimate was lowered to fit a limit, and no provisional, final-correction, or inherited credit is assumed.

The closure addendum's nonblocking follow-ups (mapper versus `settleTurn` terminal-error wording; informational Phase 1 header) were not incorporated as structured work.

### v1.5 (November 27, 2026)

Addresses R7–R13 from the plan review of `13a626a8` in `docs/development/reviews/.5x-worktrees-219-opencode-2-upgrade-plan-78d6ac-5x-cli-docs-development-plans-219-opencode-2-upgrade-plan-review.md` (run_b9df06a4d15d, initial pass). Acceptance criteria scope, Phase 1's checked items and commits, and DC0 are unchanged.

R7 and R8 required checking real OpenCode 2.x behavior before the design was written. The published `@opencode/client` 2.4.2 declarations and two live probes against a local 2.4.2 server (Overview, prompt-ownership evidence) confirmed the reviewer's mechanisms, with two refinements the evidence forced:
- A prompt sent while an execution runs joins that execution instead of getting its own, even with `delivery: "queue"`. One terminal event then covers both prompts. So ownership needs both an idle/empty-inbox precheck and overlap detection; delivery tracking alone is not enough.
- `session.inbox.cancel` acknowledges unknown and already-delivered ids. So cancellation decides between "removed" and "delivered" from events or transcript and inbox evidence, never from the acknowledgment.

Changes by finding:
- R7: the turn loop now owns exactly one prompt. It runs an ownership precheck (busy error), uses a caller-assigned `msg_5x…` request id, settles only on a terminal event after its own `session.inbox.delivered`, and fails as ambiguous, never with success, on foreign enqueue or delivery or on a terminal before its delivery.
  - Polling settles on the durable transcript `idle` entry after the prompt instead of `session.get` timestamp comparisons. It keeps the R3 early-failure path (verified: a failed execution writes `idle{outcome: "failed"}` with no assistant message) and the stale-state and skew guarantees.
  - Text reading stops at the next `user` or `idle` entry.
  - Added scripted cases, including the previous same-session terminal event before this prompt's delivery.
  - CHANGELOG and configuration docs note the new busy and ambiguous-overlap errors.
- R8: added a pre-aborted short-circuit; stable-id admission bounded at 10 s with one idempotent same-id resend; and owned cleanup. Cleanup cancels the owned pending item, resolves the outcome from evidence, interrupts only a delivered, non-overlapped, running execution, never interrupts a shared one, bounds each request, and raises the typed error without waiting for a terminal event. Added cases for queued-item cancellation, delayed and lost acknowledgment, cancel racing delivery, and hung cleanup.
- R9: `eventSessionId` reads `data.form.sessionID` for `form.created`, and the fallback cancels by `data.form.id`. Added matching and foreign-session form cases, and an explicit live `question` deny-or-cancel case that cannot pass on an ordinary turn.
- R10: the Phase 1 gate now names `bun test --concurrent --parallel=2 --dots --timeout 15000 test/unit`, the configured invocation the Phase 1 review ran with exit 0. Only the gate text changed. Phase 1's checked items and commits are preserved, and no completed work is redone or waived.
- R11: the managed spawn sets `stdout: "pipe"` and `stderr: "pipe"`, and the spawn-seam test asserts them.
- R12: Phase 5 seeds a valid plan and run, selects the bundled provider for both roles, keeps both author smokes, and adds one unrecorded `reviewer-plan` `5x invoke` per mode, checked for an accepted `ReviewerVerdict` and the rendered review context's required fields.
- R13: `MIN_OPENCODE_VERSION` starts at `2.4.2`, the only release actually verified. It equals the oldest release both live provider cases passed on, and that version is recorded. An opted-in live run fails, instead of skipping, on a missing or too-old binary. Final verification applies the same rule. The provider's version errors name the minimum and use the doctor check's upgrade hints.

Delivery Budget (IDs preserved; `effortDelta` values were treated as evidence, not added to row scores):
- New W9 (5, R7 and R8): ownership and owned cancellation. It is split from W7 because the combined work would exceed 8. The combined estimate is about 4, which is off-scale, so the row is scored 5 and not rounded down.
- New W10 (1, R12): reviewer acceptance through `5x invoke`.
- W8 3 → 5 (R9, R13).
- W7 adds R7 to Addresses with its score unchanged, because the predicate swap is effort-neutral.
- W1 adds R11, W3 adds R10, and W6 adds R7, all with scores unchanged.
- No other row changed.

These row changes add 8 effort points over the v1.4 ledger. Against the fresh governing baseline, the revised ledger may exceed the current standard ceiling; the CLI computes the totals, ceiling comparison, and route. No estimate was lowered to fit a limit. No provisional, final-correction, or inherited credit is assumed to carry into execution.

The reviewer's nonblocking follow-ups were not incorporated as structured work.

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
