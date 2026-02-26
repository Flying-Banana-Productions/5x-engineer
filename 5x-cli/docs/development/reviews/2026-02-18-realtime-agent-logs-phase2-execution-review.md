# Review: Real-time Agent Logs Phase 2 Execution

**Review type:** `8e8d60fa5de1c261a81a18184bb5eb30d2fc37ff`
**Scope:** 002 Phase 2 execution: orchestrator wiring for NDJSON log streaming at all agent invocation sites + console formatting + `--quiet` plumbing + escalation messaging
**Reviewer:** Staff engineer (correctness, operability, performance, security/tenancy, test strategy)
**Local verification:** `cd 5x-cli && bun test` PASS (335 pass, 1 skip)

**Implementation plan:** `5x-cli/docs/development/002-impl-realtime-agent-logs.md`
**Technical design:** `5x-cli/docs/development/001-impl-5x-cli.md`

## Summary

Phase 2 wires the Phase 1 adapter streaming primitives into both orchestrators: every agent invocation now produces a durable `.ndjson` log artifact and (by default on TTY) emits formatted progress to the console. It closes the primary operability gap (silent long-running steps, missing artifacts for most callsites) and aligns the runtime with the 002 plan.

**Readiness:** Ready with corrections - the feature is functionally complete, but `endStream()` durability/termination semantics should be hardened and log dir permissions should be made consistent before treating logs as reliable artifacts under failure/IO error conditions.

---

## What shipped

- **Orchestrator wiring (all callsites):** pre-open `agent-<id>.ndjson` streams for all 6 agent invocations (phase-execution: EXECUTE/QUALITY_RETRY/REVIEW/AUTO_FIX; plan-review: REVIEW/AUTO_FIX), pass `logStream` + `onEvent`, and `await endStream()` in `finally`.
- **Console output model:** `formatNdjsonEvent()` renders `system.init`, assistant text/tool_use, tool_result, and final result lines; default verbosity is TTY=verbose, non-TTY=quiet.
- **CLI UX:** single boolean `--quiet` (and framework-provided `--no-quiet`) overrides the auto default; help text warns logs are always written and may contain sensitive data.
- **Escalation behavior:** escalation reasons always include log path; inline output snippet only in quiet mode; tests cover the difference.
- **Security posture basics:** `.5x/logs/<runId>/` created with `0o700`; `.5x/` ignored in `.gitignore`.

---

## Strengths

- **Correctness under normal operation:** streams opened before invocation and flushed in `finally`, eliminating "post-hoc write" gaps and the quality-gate-style "file exists but empty" class of bugs.
- **Good separation of concerns:** adapter emits structured events; orchestrator formats/prints; avoids coupling the subprocess layer to CLI presentation.
- **Operability improvements are real:** users can now watch progress live (TTY) and still get deterministic, tooling-friendly artifacts for postmortems.
- **Test coverage targets the right contracts:** verifies log files exist at each invocation site; verifies quiet suppresses formatting; verifies escalation snippet policy.

---

## Production readiness blockers

### P0.1 - Harden `endStream()` so log flush/close is deterministic under errors

**Risk:** current `endStream()` attaches an `'error'` listener after calling `end()`. If the stream errors earlier (or errors without invoking the end callback), the returned promise can hang and stall the orchestrator in `finally`.

**Requirement:** `endStream()` must resolve on `finish`/`close` and resolve on prior/async errors without hanging.

**Implementation guidance:** prefer `node:stream/promises` `finished(stream)`; attach listeners before calling `end()`; ensure you don't accumulate extra listeners per invocation.

### P0.2 - Enforce `0o700` when any component creates log directories

**Risk:** `runQualityGates()` creates `opts.logDir` without an explicit `mode`. Today phase execution creates the directory with `0o700` first, but if this code is reused or called in another context, permissions can drift.

**Requirement:** wherever `.5x/logs` run directories are created, apply least-privilege defaults consistently.

**Implementation guidance:** add `mode: 0o700` to `mkdirSync(opts.logDir, ...)` when it is the creator (and consider `chmod` if the directory already exists but is too open).

---

## High priority (P1)

### P1.1 - Respect/measure log write backpressure

Both NDJSON log writes (adapter) and quality gate writes ignore `write()` return value. Likely fine for v1, but measure under slow disks/large tool results; consider `await once(stream, 'drain')` gating if memory growth is observed.

### P1.2 - Bound formatter allocations and reduce sensitive console surface

`formatNdjsonEvent()` uses `JSON.stringify(tool_use.input)` and may allocate huge strings for large tool inputs. Consider bounded safe-stringify / structured summaries, and consider suppressing some event classes by default if they commonly contain secrets.

### P1.3 - Improve traceability metadata consistency

- Ensure every escalation that originates from an agent invocation carries `logPath` (missing-status/missing-verdict/needs_human/failed paths currently don't always include it).
- Align escalation `iteration` values with the triggering agent result (avoid increment-before-escalation off-by-one).

---

## Medium priority (P2)

- **Deduplicate helpers:** `outputSnippet` / `buildEscalationReason` / `makeOnEvent` duplicated across orchestrators; centralize to reduce drift.
- **Log artifacts UX:** consider printing the run log dir (`.5x/logs/<runId>/`) at run start/end for quick navigation.

---

## Readiness checklist

**P0 blockers**
- [ ] Make `endStream()` non-hanging and deterministic on errors.
- [ ] Ensure log dir permissions are consistently `0o700` when created.

**P1 recommended**
- [ ] Measure/handle log write backpressure if needed.
- [ ] Bound formatter allocations and consider secret-minimizing output defaults.
- [ ] Make `logPath` + `iteration` metadata consistent across escalations.

---

## Addendum (2026-02-18) - P0/P1/P2 correction pass

**Reviewed:** commit following this addendum

### What's addressed (OK)

**P0 blockers - resolved:**

- **P0.1** - `endStream()` hardened: listeners (`once("finish")`, `once("error")`) now attached BEFORE `stream.end()` is called, eliminating the race where errors emitted during `end()` were not caught. `once()` prevents per-invocation listener accumulation. Non-throwing contract preserved (errors -> resolve). (`src/utils/stream.ts`)
- **P0.2** - Log dir permissions consistent: `runQualityGates()` now passes `mode: 0o700` to `mkdirSync(opts.logDir, ...)`, matching the permission level both orchestrators apply. (`src/gates/quality.ts:135`)

**P1 - resolved:**

- **P1.1** - Backpressure: noted-but-not-blocking per review. No code change needed for v1; documented in implementation plan.
- **P1.2** - Bounded formatter allocations: `ndjson-formatter.ts` now uses `safeInputSummary()` for `tool_use.input` - wraps `JSON.stringify` in try/catch (handles circular refs), and falls back to a key-names-only summary for large objects to avoid retaining huge intermediate strings. (`src/utils/ndjson-formatter.ts`)
- **P1.3** - Traceability metadata consistency:
  - `logPath` now propagated via `lastAgentLogPath` variable across all state transitions in both orchestrators. PARSE_AUTHOR_STATUS, PARSE_VERDICT, PARSE_FIX_STATUS (phase-execution-loop) and PARSE_VERDICT, PARSE_STATUS (plan-review-loop) all include `logPath` in escalation events. 21 of 26 previously-missing sites now have `logPath`.
  - `iteration` off-by-one fixed: `iteration++` moved to after exit-code checks in EXECUTE, QUALITY_RETRY, REVIEW, and AUTO_FIX states. Exit-code escalation events now carry the same iteration as the triggering `agent_results` row.

**P2 - resolved:**

- Extracted `outputSnippet()`, `buildEscalationReason()`, `makeOnEvent()` into `src/utils/agent-event-helpers.ts`. Both orchestrators import from the shared module.
- `EscalationEvent` consolidated to single definition in `src/gates/human.ts`; local duplicate removed from `plan-review-loop.ts` (re-exported for backward compat).
- Run log directory printed at start (`Logs: <logDir>`) in both orchestrators.

### Remaining concerns

- (none - all P0/P1/P2 items addressed)

### Updated readiness
- **002 Phase 2 completion:** COMPLETE - all P0 blockers resolved; P1/P2 improvements applied.

---

## Addendum (2026-02-18) - Staff re-review of remediation commit

**Reviewed:** `14d3ccfc927d`

### What's addressed (OK)

- **P0.1 endStream race:** listener attach order fixed; `endStream()` no longer misses synchronous `finish`/`error` emissions during `end()` and remains non-throwing. (`5x-cli/src/utils/stream.ts`)
- **P0.2 permissions consistency:** `runQualityGates()` creates the log dir with `mode: 0o700` when it is the creator. (`5x-cli/src/gates/quality.ts`)
- **P1.2 formatter hardening:** `safeInputSummary()` adds non-throwing stringification and bounds output size for tool inputs; avoids printing full huge payloads by falling back to key summaries. (`5x-cli/src/utils/ndjson-formatter.ts`)
- **P1.3 traceability + iteration:** `lastAgentLogPath` is propagated into PARSE_* escalations; exit-code escalations now use pre-increment iteration matching the triggering `agent_results` row; regression tests added for PARSE_* logPath propagation. (`5x-cli/src/orchestrator/phase-execution-loop.ts`, `5x-cli/src/orchestrator/plan-review-loop.ts`, `5x-cli/test/orchestrator/phase-execution-loop.test.ts`)
- **P2 maintainability:** duplicated helper functions are centralized in `5x-cli/src/utils/agent-event-helpers.ts`; `EscalationEvent` unified under `5x-cli/src/gates/human.ts`; both loops print the run log dir at start.

### Remaining concerns

- **Quality gate log stream errors can still crash:** `runSingleCommand()` creates a write stream without an `'error'` handler. A disk/full/permission failure during writes can emit an unhandled `'error'` event and take down the process. Recommendation: attach an error listener on the quality-gate `logStream` at creation time and treat log write failure as best-effort (warn + keep running, similar to agent logs).
- **safeInputSummary still allocates to measure size:** it still calls `JSON.stringify(input)` for objects before deciding to fall back, so worst-case allocations can still spike. If this shows up in practice, replace with a depth/byte-limited serializer that never allocates an unbounded intermediate string.
- **endStream corner:** with the current contract (call-site attaches `'error'` at creation), this is likely fine; but `endStream()` can still hang if called after the stream already emitted `finish`/`error` before listeners are attached. If this is a concern, guard with `writableFinished`/`destroyed` checks or switch to `stream/promises` `finished()`.

### Updated readiness

- **002 Phase 2 completion:** COMPLETE - acceptable for local interactive use; address the quality-gate logStream error handling if you want logs to be reliably best-effort under IO failures.
