# Review: `5x run watch` and `--stderr` Flag (Implementation Plan)

**Review type:** Implementation plan review (`5x-cli/docs/development/009-run-watch-and-stderr.md`)
**Scope:** Add a run-log watcher (`5x run watch`) + log metadata (`session_start`) + `5x invoke --stderr` TTY override + shared run-id validation + skill guidance updates
**Reviewer:** Staff engineer (CLI contracts, operability, reliability, security)
**Local verification:** Not run (static review: plan + code inspection)

**Implementation plan:** `5x-cli/docs/development/009-run-watch-and-stderr.md`
**Technical design:** `5x-cli/docs/v1/101-cli-primitives.md`, `5x-cli/docs/development/007-impl-v1-architecture.md`, `5x-cli/docs/development/008-refactor-command-handlers.md`, `5x-cli/docs/development/archive/002-impl-realtime-agent-logs.md`, `5x-cli/docs/development/archive/005-impl-console-output-cleanup.md`

## Summary

This closes a real observability gap: harness-driven `5x invoke` calls are currently silent because console streaming is gated on `process.stderr.isTTY` (`5x-cli/src/commands/invoke.handler.ts`), and the only durable stream is NDJSON on disk (`5x-cli/src/providers/log-writer.ts`). A dedicated watcher + an explicit `--stderr` override is the right shape.

The plan is close, but several details conflict with existing CLI/output contracts and the actual on-disk log schema. Address the P0s (output contract, `session_start` semantics, tailer correctness/memory bounds, and interleaving safety) before implementation to avoid either (a) a watcher that crashes on real logs, or (b) a one-off command that silently breaks the v1 JSON envelope story.

**Readiness:** Ready with corrections -- direction is right; tighten contracts + edge-case handling first.

---

## Strengths

- Uses existing artifacts as SOT: `.5x/logs/<runId>/agent-*.ndjson` is already written for every invoke.
- Minimal surface-area change for harness visibility: `--stderr` is opt-in and preserves current quiet-by-default in non-TTY environments.
- Poll + `fs.watch` hybrid is pragmatic, dependency-free, and cross-runtime (Bun/Node).

---

## Production readiness blockers

### P0.1 -- Decide and document `run watch` output contract (JSON envelope vs streaming text)

**Risk:** v1 CLI currently claims/enforces JSON envelopes on stdout (`5x-cli/src/output.ts`, `5x-cli/src/bin.ts`). A long-running command that writes human-readable text to stdout means:
- the "all commands are JSON" contract becomes false (docs + user expectations)
- any thrown error after streaming begins will cause `bin.ts` to print a JSON error object into the middle of the stream

**Requirement:** Pick and document one stable contract:
- **Preferred:** keep stdout machine-parseable; stream human-readable output to stderr. If you still want a "watch started" signal, emit a one-time JSON envelope to stdout before streaming.
- **Acceptable:** make `run watch` a documented exception that writes non-JSON to stdout; ensure the handler never throws after streaming begins (all parse/IO failures become best-effort warnings to stderr).

**Implementation guidance:**
- If you keep stdout JSON: use `StreamWriter({ writer: (s) => process.stderr.write(s) })` in watch, and optionally `outputSuccess({ started: true, run_id, log_dir })` once.
- If you make an exception: update `5x-cli/src/output.ts` header comment ("All v1 commands...") and any docs that imply stdout is always JSON.

---

### P0.2 -- Clarify `session_start` lifecycle and rendering; avoid double headers and type confusion

**Risk:** The plan currently mixes responsibilities:
- It proposes a `session_start` variant in `AgentEvent` + `StreamWriter.writeEvent()` rendering, but the invoke streaming path never feeds `session_start` to StreamWriter (it only appends it to the log).
- It also proposes watch-level label headers on stream switches, which can duplicate the `StreamWriter` rendering (or produce inconsistent headers depending on routing).

**Requirement:**
- Define `session_start` as *log metadata* written by the CLI (not emitted by providers).
- In `run watch`, treat `session_start` as control-plane: use it to compute/remember labels; do not render it twice.
- Either introduce a separate type (e.g. `AgentLogEvent = AgentEvent | SessionStartEvent`) to keep provider contracts clean, or explicitly document that `AgentEvent` now includes a CLI-only variant and providers must ignore it.

**Implementation guidance:**
- Keep the `session_start` payload minimal (see P1.2); store only what you need for labeling.
- In watch: on `session_start`, update `labelByFile`; on file switch call `writer.writeLine(label)` (which flushes) before routing subsequent events.

---

### P0.3 -- Tailer must match real on-disk NDJSON schema and be memory-safe

**Risk:** The plan assumes each NDJSON line parses as `AgentEvent`, but current logs are timestamped entries (`{ ts, ...event }`) via `appendLogLine()` in `5x-cli/src/providers/log-writer.ts`. Also, reading `size - offset` bytes per tick can allocate O(fileSize) and OOM on large logs; buffering partial lines as strings can also grow unbounded (especially if `session_start` logs large `vars`).

**Requirement:**
- Parse the actual log entry shape (at minimum `type` + optional `ts` + event fields) and yield it (or yield `{ file, ts, event }`).
- Bound memory: cap max read chunk size and cap per-file partial-line buffer size with a degraded-mode policy (warn + skip/truncate).
- Define initial cursor semantics: do you replay existing logs or start tailing at EOF? (Recommend: default to start-at-EOF for "watch", add `--replay`/`--from-start` for full playback.)

**Implementation guidance:**
- Handle truncation (`size < offset`) by resetting offsets.
- Avoid `Buffer.alloc(size - offset)`; read in fixed chunks (e.g. 64KiB) until caught up.

---

### P0.4 -- Prevent cross-file token mixing when interleaving streams

**Risk:** `StreamWriter` keeps internal word/space buffers and fence state. If events from multiple files interleave without an explicit flush/reset on file switches, output will splice deltas from different agents into the same line (and can corrupt fence detection).

**Requirement:** On any file switch (and before printing a label header), force a `StreamWriter` boundary (`endBlock()` or `writeLine()`), so stream state cannot bleed across files.

**Implementation guidance:** Use `writer.writeLine(label)` for label headers; it calls `endBlock()` first.

---

## High priority (P1)

### P1.1 -- Reconcile DB validation with current `invoke` behavior

Today `5x invoke ... --run <id>` writes logs without checking the DB. If `run watch` hard-requires `getRunV1()` success, you cannot watch logs for ad-hoc invocations (or for runs created outside `run init`).

Recommendation: either (a) add an escape hatch (`--no-db` / `--skip-db-check`), or (b) treat "log dir exists" as sufficient and only use DB validation as a helpful fast-fail when available.

### P1.2 -- Do not log full `--var` values in `session_start` by default

`--var` commonly includes `user_notes` and other high-entropy/sensitive strings. Writing all vars into a single first-line JSON object increases both sensitive-data exposure surface and the probability of enormous single-line entries (tailer memory/latency risk).

Recommendation: log only:
- `role`, `template`, `run`
- `phase_number` (and optionally a short allowlist of other keys)
- optionally `var_keys: string[]` (keys only), not values

### P1.3 -- Tests: avoid flakiness from timers and `fs.watch`

The proposed tailer tests are valuable but will be timing-sensitive if they rely on real `setInterval` cadence and OS watch delivery.

Recommendation: make `NdjsonTailer` testable via injection (poll interval, a `pollNow()` hook, or a fake watcher), and keep unit tests deterministic without depending on `fs.watch` behavior.

---

## Medium priority (P2)

- **UX knobs:** consider `--replay`/`--from-start`, `--tail <n>`, and `--timestamps` for watch.
- **UTF-8 correctness:** if you decode arbitrary byte chunks into strings, you can split multi-byte sequences; a byte-buffer + newline scan avoids subtle corruption.
- **Naming:** `--workdir` on watch is really "project root resolution start dir"; consider `--start-dir` / `--project-root` to avoid confusion with invoke's tool-execution workdir.

---

## Readiness checklist

**P0 blockers**
- [ ] `run watch` output/error contract is explicit and consistent with `5x-cli/src/bin.ts` behavior
- [ ] `session_start` write/render semantics are unambiguous; no double headers; provider vs log typing is clarified
- [ ] Tailer parses the real log-entry schema and is memory-safe (bounded reads + bounded line buffer + defined start cursor)
- [ ] Watch flushes StreamWriter state on file switches to prevent cross-agent mixing

**P1 recommended**
- [ ] DB validation behavior is reconciled with ad-hoc `invoke` (escape hatch or fallback)
- [ ] `session_start` avoids logging full var values by default (size + sensitive-data hardening)
- [ ] Tailer tests are deterministic (no `fs.watch`/timer flakes)

---

## Addendum (2026-03-06) — Implementation Review (`d643a9fa4b`)

**Reviewed:** `d643a9fa4b` (implementation) + `5x-cli/docs/development/009-run-watch-and-stderr.md` (v1.1)

**Local verification:** `bun test --concurrent --dots 5x-cli/test/utils/ndjson-tailer.test.ts 5x-cli/test/commands/run-watch.test.ts` (pass)

### What's addressed (✅)

- **P0.1 output contract:** `5x run watch` now defaults to NDJSON-to-stdout streaming (machine-parseable) and gates human-readable output behind `--human-readable` (`5x-cli/src/commands/run-v1.handler.ts`, `5x-cli/src/commands/run-v1.ts`, `5x-cli/docs/development/009-run-watch-and-stderr.md`).
- **P0.2 session_start semantics:** `session_start` is log-only metadata (`SessionStartEntry` + `appendSessionStart()`), not an `AgentEvent` variant; watch treats it as control-plane label data (`5x-cli/src/providers/log-writer.ts`, `5x-cli/src/commands/invoke.handler.ts`, `5x-cli/src/commands/run-v1.handler.ts`).
- **P0.3 tailer correctness + memory bounds:** `NdjsonTailer` parses the real log entry shape (timestamped objects), reads bounded 64KB chunks, caps partial buffers at 1MB, and is deterministic in tests via `poll()`/`pollInterval: 0` (`5x-cli/src/utils/ndjson-tailer.ts`, `5x-cli/test/utils/ndjson-tailer.test.ts`).
- **P0.4 interleaving safety:** human-readable watch forces StreamWriter boundaries on file switches and before label headers to avoid cross-file token mixing (`5x-cli/src/commands/run-v1.handler.ts`).
- **P1.1 DB validation fallback:** watch fast-fails via DB when possible, but proceeds when DB is missing/stale and the log dir exists (warns to stderr) (`5x-cli/src/commands/run-v1.handler.ts`).
- **P1.2 sensitive vars:** `session_start` only records `phase_number` (no full var dump) (`5x-cli/src/commands/invoke.handler.ts`, `5x-cli/src/providers/log-writer.ts`).
- **P1.3 test flake avoidance:** tailer and watch tests avoid `fs.watch`/timer reliance and remain stable.

### Remaining concerns

### P0.5 — Log directory permissions: `run watch` can create `.5x/logs/<run>` without `0o700`

**Risk:** `runV1Watch()` creates the log directory via `mkdirSync(logDir, { recursive: true })` with no explicit mode (`5x-cli/src/commands/run-v1.handler.ts`). If `run watch` is the first codepath to create that run’s log directory, it may be group/world-readable (umask-dependent). Later `prepareLogPath()` will not tighten permissions on an existing directory, so sensitive logs can be exposed.

**Requirement:** Ensure `.5x/logs/<run>` is created with `0o700` (and consider explicitly chmod’ing to `0o700` when it already exists, or at least warning if perms are too open).

### P1 — Human-readable robustness: don’t crash on unexpected/legacy log entries

`entryToAgentEvent()` currently casts fields (e.g. `delta`) to string and can throw if logs contain malformed/partial/legacy entries. Recommendation: add runtime guards (type checks) and treat bad lines as warnings + skip (especially in `--human-readable` mode) (`5x-cli/src/commands/run-v1.handler.ts`).

### P1 — Tailer IO hardening: treat read/stat errors as best-effort

`NdjsonTailer.poll()` catches some FS errors, but `readSync()` failures (EIO/EPERM during concurrent writes/rotations) can still throw and crash the watcher. Recommendation: wrap per-read operations in try/catch and degrade with warnings (`5x-cli/src/utils/ndjson-tailer.ts`).

### P2 — NDJSON-mode error signaling doesn’t match the updated plan

The plan states streaming-time errors should be emitted as NDJSON `{source:"watch",type:"error",...}` in default mode; current implementation writes warnings to stderr only (malformed JSON lines) and otherwise stays silent. Decide whether to align code to doc or relax the doc (`5x-cli/docs/development/009-run-watch-and-stderr.md`, `5x-cli/src/utils/ndjson-tailer.ts`).

### P2 — Documentation: stdout envelope claims are now materially false

`5x-cli/src/output.ts` still claims “All v1 commands return `{ ok: true, data }` or `{ ok: false, error }`” to stdout. `run watch` intentionally streams non-envelope JSON lines (and in `--human-readable`, plain text) to stdout. Recommendation: update the comment/docs to explicitly carve out streaming commands.

### Updated readiness

- **Implementation completion:** ✅ — core behavior implemented + tests passing.
- **Production readiness:** ⚠️ — fix P0.5 (log dir perms) before treating this as safe-by-default; remaining items are hardening/docs.

---

## Addendum (2026-03-06) — Follow-up Review (`c4ba7b66e9`)

**Reviewed:** `c4ba7b66e9`

**Local verification:** `bun test --concurrent --dots 5x-cli/test/utils/ndjson-tailer.test.ts 5x-cli/test/commands/run-watch.test.ts 5x-cli/test/output.test.ts` (pass)

### What's addressed (✅)

- **P0.5 log dir perms:** `runV1Watch()` now creates `.5x/logs/<run>` with `mode: 0o700` (`5x-cli/src/commands/run-v1.handler.ts`).
- **P1 human-readable robustness:** `entryToAgentEvent()` now has runtime type guards + is non-throwing (skip on malformed/legacy entries) (`5x-cli/src/commands/run-v1.handler.ts`).
- **P1 tailer IO hardening:** `NdjsonTailer` catches `readSync()` failures and degrades with a warning + retry on next poll (`5x-cli/src/utils/ndjson-tailer.ts`).
- **P2 doc alignment:** Plan doc now states streaming-time errors are stderr warnings (stdout stays clean NDJSON); `output.ts` docs now explicitly carve out streaming commands (`5x-cli/docs/development/009-run-watch-and-stderr.md`, `5x-cli/src/output.ts`).

### Remaining concerns

- **Existing directory perms (minor):** `mkdirSync(..., mode: 0o700)` does not tighten permissions on already-existing directories. Optional hardening: if `logDir` exists, consider a best-effort `chmodSync(logDir, 0o700)` (or at least warn when perms are too open).

### Updated readiness

- **Implementation completion:** ✅
- **Production readiness:** ✅ — no remaining P0/P1 items from this review.
