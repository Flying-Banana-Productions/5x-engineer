# Review: Run Watch TUI Implementation Plan (213)

**Review type:** `5x-cli/docs/development/plans/213-run-watch-tui-plan.md`  
**Scope:** Plan v1.0 for `5x run watch --tui`: additive provider metadata, replay-aware bounded tailer, watch reducer and renderer, terminal lifecycle, CLI integration  
**Reviewer:** Staff engineer (correctness, terminal lifecycle reliability, compatibility of existing stream modes, delivery budget)  
**Local verification:** Not run (static review). Plan claims were checked against `src/commands/run-v1.{ts,handler.ts}`, `src/utils/ndjson-tailer.ts`, `src/providers/{types,log-writer,event-mapper,opencode}.ts`, `src/commands/invoke.handler.ts`, `src/cli-lifecycle.ts`, `src/bin.ts`, `src/program.ts`, both bundled provider packages, and existing tailer and provider tests.

**Implementation plan:** `5x-cli/docs/development/plans/213-run-watch-tui-plan.md`  
**Technical design:** `5x-cli/docs/v2/208-run-watch-tui.md`

## Summary

The plan covers requirements doc 208 well. It resolves all five open decisions there: renderer spike, event schema, breakpoints, history limits, and log-observed-only status. It also finds a real prerequisite the requirements only hinted at: the tailer's pending queue has no size limit. Phase ordering, module boundaries, and the fact/inference discipline are sound.

Four issues need correcting before implementation, each with a fix that follows from the codebase:

- The workspace header is wrong for resumed OpenCode sessions.
- The plan ignores the existing process-wide signal owner (`cli-lifecycle.ts`), which can force-exit before the terminal is restored.
- The bounded, rotating drain would reorder `--human-readable` replay across invocations.
- The paused-viewport snapshot, stored as rendered rows, cannot survive a resize.

**Readiness:** Ready with corrections. All items are mechanical plan edits with one derivable answer each.

---

## Strengths

- **Correct diagnosis of the source layer.** The plan recognizes that a bounded UI over the current `NdjsonTailer` (`poll()` reads the entire backlog, `pending` grows without limit) would not bound memory. It fixes the problem at the source, using byte-offset watermarks instead of timestamps.
- **Additive, fallback-first contract.** Optional metadata goes on the existing `AgentEvent` variants, so exhaustive switches keep working. Old-plugin type fixtures are required. IDs are scoped by source and generation rather than by provider session ID.
- **Discipline about observed facts.** ID-less ambiguity becomes an explicit uncertain group. `done` closes only its source. Usage is shown as a snapshot, not summed. Search scope is kept separate from file reads. Edits are not presented as Git changes.
- **Legacy decoder left alone.** The legacy `entryToAgentEvent` is left untouched, which avoids accidental changes to human-readable formatting.
- **Early renderer spike with a single-adapter rule.** This handles the largest source of uncertainty early and prevents two runtime implementations.

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1 — Workspace header is wrong for resumed OpenCode sessions

Phase 2.1 says to populate `session_start.workspace` "from the same `workdir` used by `startSession`/`resumeSession`". The Phase 2 completion gate requires the header to record "the actual provider workspace on fresh and resumed sessions". However, `OpenCodeProvider.resumeSession` (`src/providers/opencode.ts:815–837`) ignores `ResumeOptions.workingDirectory` and uses the stored `session.directory`. Only the Claude Code and Cursor providers honor the requested cwd (`packages/*/src/provider.ts`, `opts?.workingDirectory ?? process.cwd()`).

Suppose an OpenCode session is resumed from a different `--workdir` or mapped worktree. The header would then name a workspace the agent is not using. Every target would be shortened against the wrong root or labeled "outside workspace", which violates the plan's own rule that the observer must never guess.

**Fix:** Record the effective workspace the session reports. For example, add an optional read-only `workingDirectory?` to `AgentSession`, set by `OpenCodeSession` from `session.directory` and by the CLI providers from their resolved cwd. Fall back to the requested workdir only for fresh sessions. Omit `workspace` when a resumed session does not report one; the plan already says unknown values stay unknown. Add a fixture for OpenCode resumed with a directory that differs from the request.

### P1.2 — TUI signal handling ignores the existing process-wide signal owner

`src/bin.ts` calls `installCliLifecycle()`. On the first SIGINT/SIGTERM, `src/cli-lifecycle.ts` aborts `getCliAbortSignal()` and starts a 2 s grace timer that calls `process.exit(130|143)`. A second signal exits immediately. Phase 6.1/7.1 proposes separate "signal handlers [that] abort local tailing only" and leaves SIGTERM's status as "documented conventional status". The plan never mentions `cli-lifecycle.ts`.

Two failure cases follow:

- A second SIGINT/SIGTERM (for example `kill -INT` twice), or cleanup blocked longer than the grace window on a slow or stalled `stdout.write`, exits the process through `process.exit` without running the controller's `finally`. The terminal is left in raw mode on the alternate screen.
- The watch handler today listens only for SIGINT. A SIGTERM therefore does not reach the TUI source at all until the force exit.

**Fix:** Make the TUI controller's abort input `getCliAbortSignal()`, merged with the local detach controller, instead of new process handlers. Take the exit status from `getCliAbortCause()`, matching the existing 130/143. Register a synchronous, idempotent terminal-restore on `process.on("exit")` while the UI is entered, so a forced exit still leaves the alternate screen and restores the cursor and raw mode. Add PTY cases for double-signal and grace-timeout exit to 7.1.

### P1.3 — Bounded, rotating drain changes `--human-readable` and raw replay order

Phase 3.1 limits every drain turn to 256 KiB / 256 records and requires "rotate source traversal across turns". These are changes to the shared `NdjsonTailer`. Only `replayMetadata` is described as TUI-only.

Today, `poll()` drains each file completely in sorted order within one call. Replaying `agent-001` and then `agent-002` therefore prints all of invocation 1, then all of invocation 2. With the new drain, a replay of two backlogs larger than 256 records would alternate in 256-record chunks. `watchHumanReadable` would then print interleaved invocations with a repeated `[role]` label header at each switch.

The Phase 3 gate ("existing raw/human watch integration tests pass unchanged") would not catch this, because the existing tailer and watch fixtures contain only a handful of lines.

**Fix:** Drain historical (pre-watermark) data in sorted file order to completion, one source at a time, across turns. Apply fairness rotation only to live data or only under the TUI option. Add a regression test: a two-file backlog of more than 256 records per file must produce the same `watchHumanReadable` and raw source order as before.

### P1.4 — Paused viewport stores rendered rows, which cannot be re-laid out on resize

Design Decisions says "A paused viewport stores bounded rendered rows/detail". W6 requires "Resize recomputes layout only … without resetting selection/follow", and the W7 manual pass resizes 80×12 → 140×40 → 40×6 while inspecting. Rows rendered for one width cannot be re-wrapped for another. While paused, a resize would either overflow or clip. The alternative, discarding the snapshot, loses the paused focus that requirements §3.3/§7 promise to keep.

**Fix:** Snapshot bounded, width-independent row models: stable IDs, sanitized text, and inspector detail within the existing 256 KiB cap. Have `renderWatch` lay out the snapshot at the current size. Add a controller test: pause, resize to 40×6 and back, and confirm the same selected ID and inspector content.

---

## Medium priority (P2)

- **P2.1 — Phase 1 compiled/subprocess smoke has no entry point.** The Phase 1 gate requires the adapter to "enter, draw, resize, read keys, and restore" in Bun source and compiled execution, and adds `test/helpers/watch-tui-harness.ts` for subprocess smoke. However, `--tui` is not exposed until Phase 6, and `bun run build` compiles only `src/bin.ts`. Name a small test-only fixture entry (for example `test/fixtures/watch-terminal-smoke.ts`), and add the exact `bun build --compile <fixture>` command used to produce the recorded evidence. Without these, the gate cannot be checked.

---

## Nonblocking follow-ups

- **CLI help outside `run-v1.ts`.** `src/program.ts:27` says "run watch streams NDJSON or human-readable output". Update it with the W7 help/README changes and add it to Files Touched.
- **Metadata caps for external plugins.** `invokeStreamed` spreads every provider event verbatim into the log (`appendLogLine`). The W2 caps (32 targets, 4 KiB, 16 KiB) are described for bundled mappers only. Enforcing the same caps in `decodeWatchEntry` (or one shared normalizer at the log-writer) would keep external-plugin logs from carrying oversized metadata. The W4 retention caps already bound UI state.
- **Legacy OpenCode repeated `tool_start`.** The OpenCode mapper emits a new `tool_start` whenever a running part's input signature changes. Legacy ID-less logs may therefore show phantom overlapping same-name calls. The plan's uncertain-group and outcome-unknown-on-`done` rules degrade honestly. A fixture for this case would document the expected display.
- **Reducer copy cost.** If `reduceWatchEvent` copies bounded arrays (2,000 timeline records) on every event, a 100k-event replay costs about 2×10⁸ element copies. Allow in-place mutation behind the reducer API, or use ring buffers, and assert throughput in the W7 stress test.
- **PTY mechanism.** Bun 1.4.x exposes `Bun.Terminal`. Naming it (with a capability gate for `engines.bun >=1.1.0`) as the PTY mechanism avoids ad hoc `script(1)` differences between macOS and Linux.

---

## Delivery budget assessment (advisory)

The author ledger totals 28 across W1–W7 and has no debt claims. My independent estimate is about **32**, with medium confidence:

- **W2 looks light at 3.** It covers the public contract, three mappers, and Claude stream `message_start`/block tracking, which the Claude mapper does not do today. It also covers the workspace producer, now including the resume correction in P1.1.
- **W6 looks light at 3.** It covers the controller, the key surface, the viewport and paused-snapshot model, CLI preflight, and integration with the signal lifecycle (P1.2).
- **W1, W3, W4, W5 and W7 look reasonable.**

The Surface Snapshot counts (4 / 18 / 3) match the Files Touched table. `src/program.ts` would make 19 production files if it is updated.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Record the session-reported effective workspace; omit it when unknown on resume
- [ ] P1.2 Route TUI abort and exit status through `cli-lifecycle`; add an exit-time terminal-restore fallback
- [ ] P1.3 Preserve per-file replay order for raw and human-readable modes under bounded draining
- [ ] P1.4 Store the paused snapshot as width-independent row models and re-render on resize

**P2**
- [ ] P2.1 Name the Phase 1 smoke fixture entry and its compile command

---

## Addendum (September 23, 2026) — Closure review of v1.1

**Reviewed:** plan version 1.1, commit `0fbfca7de80e687a68c1ae95a78e356154a3fdde` (prior review at `95817c31f4b5c665346e0171edf2ea155222d30d`)

### What's addressed (✅)

- **P1.1 — Workspace header for resumed OpenCode sessions.** The revision adds a new Design Decision ("Record session-reported workspace, not requested resume cwd") and rewrites the Phase 2 gate and W2.1 bullet: an optional read-only `AgentSession.workingDirectory` is exposed by all three bundled providers — `OpenCodeSession` reports the resolved `session.directory` it already tracks (`src/providers/opencode.ts:181` `private workdir`, populated from `startSession`'s `opts.workingDirectory` or `resumeSession`'s `sessionData.directory`), and `ClaudeCodeSession`/`CursorAgentSession` report the `private cwd` they already store (`packages/provider-{claude-code,cursor-agent}/src/session.ts`). `workspace` now prefers this reported value, falls back to the requested workdir only for fresh sessions, and is omitted for a resumed session that reports none. A dedicated fixture set covers the OpenCode-resume-with-differing-directory case. This is exactly the fix the prior finding required and is mechanically sound against the current code (all three sessions already hold the needed field privately; the change only needs to surface it).
- **P1.2 — TUI signal handling vs. `cli-lifecycle.ts`.** A new Design Decision ("Reuse the process-wide signal owner") and rewritten W6.1/6.2/7.1 bullets now: merge `getCliAbortSignal()` with the watcher-local detach controller instead of installing competing handlers; derive exit status 130/143 from `getCliAbortCause()`; explicitly bypass the handler's existing stream-only `SIGINT` listener for TUI while leaving it untouched for non-TUI modes; and keep the W1 synchronous `process.on("exit")` restore (added for P1.2/P2.1 jointly) active until restoration completes, independent of a stalled frame write. W7 adds explicit double-signal and grace-timeout PTY cases asserting 130/143 and synchronous restoration. This closes both original failure modes (bypassed `finally` on double-signal/grace-timeout, and SIGTERM never reaching the TUI) without modifying `cli-lifecycle.ts` itself, which the plan now explicitly protects ("do not alter `cli-lifecycle.ts` signal ownership").
- **P1.3 — Bounded drain reordering legacy replay.** W3.1's bullet now splits behavior by mode: raw/human draining stays in strict sorted-file order to each source's watermark across turns (matching today's `poll()` semantics, just chunked), with fairness rotation confined to live draining after catch-up or to TUI's own `replayMetadata` opt-in. The Phase 3 completion gate and a new W3.2 bullet add a concrete regression: two sorted files each exceeding 256 records/the byte budget, asserting unchanged source order and no repeated role headers under `watchHumanReadable`. This preserves current output-order behavior for the unmodified code paths while keeping the bounded-turn fix that motivated the original change.
- **P1.4 — Paused snapshot survives resize.** The "Keep live state separate from navigation" Design Decision, the `WatchViewport.pausedSnapshot` field, and new W4/W5/W6 bullets replace "rendered rows" with "width-independent row models (stable IDs, sanitized text, inspector detail)" that `renderWatch` lays out at whatever size is current, whether live or paused. W6.1 adds a concrete controller test: pause on inspector detail, ingest/evict live data, resize to 40×6 and back, assert the same selected ID/inspector text/paused state. This is the exact width-independent-snapshot fix requested.
- **P2.1 — Phase 1 gate has no testable entry point.** W1.2 adds `test/fixtures/watch-terminal-smoke.ts` (a direct, CLI-flag-free import of the adapter) with the exact commands: `bun test/fixtures/watch-terminal-smoke.ts` for source evidence, then `bun build --compile test/fixtures/watch-terminal-smoke.ts --outfile .5x/watch-terminal-smoke` (a path already covered by `.gitignore`) for compiled evidence. The Phase 1 gate and the Tests table now reference this fixture explicitly instead of the unreachable `bun run build` path.

All five required findings are concretely and specifically resolved, each with a design-decision-level statement, a completion-gate rewrite, an implementation bullet, and a matching test bullet — not just a checklist acknowledgment. Verification against the current codebase (`opencode.ts`, both provider `session.ts` files, `cli-lifecycle.ts`, `bin.ts`) confirms each fix is mechanically compatible with what already exists (e.g., the private `cwd`/`workdir` fields the sessions need to expose are already present).

The revision also folded in every item from the prior **Nonblocking follow-ups** section as a bonus (global help in `src/program.ts`, decoder-side caps for external-plugin metadata in `decodeWatchEntry`, a legacy-repeated-`tool_start` reducer fixture, permission for in-place reducer mutation/ring buffers plus a W7 throughput assertion, and a capability-gated `Bun.Terminal` PTY note). These were not required for closure and are not re-scored here, but they remove what would otherwise have been recurring low-priority notes.

### New issues found in this revision

None. The diff is additive and corrective — new Design Decisions, gate language, checklist bullets, file/test references, and one Surface Snapshot count update (18 → 22 production files, reconciled against the four newly touched existing files: `src/providers/opencode.ts`, both provider `session.ts` files, and `src/program.ts`). No hunk in the diff changes behavior in a way that introduces a fresh correctness, ordering, or lifecycle problem; the sorted-historical-drain fix does not reintroduce the memory/CPU-unbounded-turn problem the original W3 rotation was meant to solve, since per-turn byte/record budgets still apply within a source.

### Remaining concerns

None blocking. The delivery-budget observation from the initial review (W2 and W6 look roughly 2 points light apiece against my independent estimate) still applies qualitatively — the corrections added session-accessor plumbing to W2 and signal-lifecycle integration plus a resize/pause controller test to W6, both under "scores unchanged" — but the author ledger's effort/architecture deltas for W1–W7 are otherwise unchanged, no re-estimate was requested, and no new debt claims were introduced, so there is nothing further to assess here.

### Updated readiness

- **Plan completion:** ✅ — all five required prior findings are addressed with concrete, verifiable mechanisms.
- **Ready for implementation:** ✅
