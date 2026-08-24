# Prompt-Queue Foundation — Durable UUID Prompts, CAS Answers, Doctor Hygiene

**Version:** 1.2
**Created:** August 24, 2026
**Last updated:** August 24, 2026
**Status:** Ready for implementation

---

## Executive Summary

`5x prompt choose` / `confirm` / `input` today block on the calling TTY and never persist. v2 inverts that: every invocation writes a UUID-keyed open row to the control-plane store, then waits. The terminal, a `--default` writer, and (later) the dashboard are symmetric CAS writers; first writer wins and losers observe the stored answer. This slice lands the repository, schema, polling/abandonment contract, prompt-command integration, and the orphaned-prompt doctor check deferred from area 203. It does not ship HTTP, UI, budget tables, or provider cancellation.

### Scope

**In scope:**

- `prompts` table (schema v6), UUID ids, open/recent indexes, SQLite repository plus an in-memory test implementation.
- `PromptStore` contract: `createPrompt`, `getPrompt`, `listOpenPrompts`, `answerPrompt` (CAS), `abandonPrompt` (CAS).
- Bounded poll loop, timeout/interrupt/EOF/SIGTERM abandonment, terminal vs store race with cancellable stdin **and** piped input.
- `5x prompt choose|confirm|input` persist-then-wait; preserve `--default` CI behavior and existing success envelopes.
- Doctor `prompts` check: open rows whose run is terminal; `--fix` abandons them deterministically.

**Out of scope:**

- Dashboard server, browser UI, auth, WebSocket (`04-control-plane-dashboard`).
- General-purpose `decisions` table (answered prompts + `human:*` steps are sufficient).
- Review-budget records (`06-review-budget-advisory`).
- Remote/synced store implementation (keep the abstraction + CAS contract).
- Agent cancellation / provider lifecycle (`05-invocation-registry`).
- Ambient run identity inside this command (slice 204). Optional `--run` is explicit only.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **New `src/control-plane/` layer, not `operations-v1.ts`** | Forward-compat constraint #1: command logic must not import `bun:sqlite`. SQLite is one materialization. |
| **No `decisions` table** | Request/answer history is answered `prompts` rows; unsolicited control actions stay `human:*` steps. |
| **`run_id` nullable** | Skills call `5x prompt` without `--run` today. Requiring a run would break them. `--run` is optional and explicit. |
| **Abandonment is a third state, not a fake answer** | Timeout/interrupt/orphan repair must not look like a human answer. CAS on both answer and abandon. |
| **no-TTY + `--default` CAS-es immediately** | Preserves CI. TTY waits; a store writer can still win. no-TTY choose/confirm without default stays fail-fast `NON_INTERACTIVE` after persist+abandon. no-TTY `input` waits on the pipe **inside the same abortable race** (`--timeout` and store writers apply). |
| **Cancellable `readLine` / `readAll` / `readStdinPipe` via `AbortSignal`** | When a store writer, timeout, or lifecycle abort wins, the pending TTY or pipe read must stop. Spike this before wiring the race. Always abort **every** race branch (stdin/pipe, poll/timeout, and the lifecycle-linked controllers) so a loser cannot keep the process alive. |
| **CLI lifecycle owns SIGINT/SIGTERM; waiting prompts observe `getCliAbortSignal()`** | `getDb()` (`src/db/connection.ts:47–54`) and `registerLockCleanup()` (`src/lock.ts:433–440`) currently exit on the first SIGINT, which races ahead of prompt abandonment. Centralize at the CLI boundary: first SIGINT/SIGTERM aborts work without exiting. Every active prompt race fans that signal into stdin/pipe and poll controllers so the handler can CAS-abandon `interrupted` while SQLite is open, then emit `INTERRUPTED` (130) or `TERMINATED` (143). Second signal or a bounded grace timeout force-exits. |
| **Doctor `--fix` abandons orphaned prompts** | Terminal run + open prompt has exactly one correct answer. Uses `findingKey` identity `detail.promptId`. |

### References

- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — §3.2 run-state surface; §3a store / UUID / CAS constraints.
- [`docs/v2/202-control-plane.md`](../../v2/202-control-plane.md) — queue inversion, repository TODOs, schema, polling.
- [`docs/v2/203-recovery-and-doctor.md`](../../v2/203-recovery-and-doctor.md) — deferred `prompts` check (table row ~83).
- [`docs/v1/101-cli-primitives.md`](../../v1/101-cli-primitives.md) — current prompt UX (§7, ~688–765).
- [`docs/v1/100-architecture.md`](../../v1/100-architecture.md) — persistence and envelope invariants.
- Plan input: [`docs/v2/plan-inputs/03-prompt-queue-foundation.plan-input.md`](../../v2/plan-inputs/03-prompt-queue-foundation.plan-input.md).
- Predecessor: [`203-recovery-and-doctor-plan.md`](./203-recovery-and-doctor-plan.md) (ships five checks; defers prompts).
- Follow-on: [`docs/v2/plan-inputs/04-control-plane-dashboard.plan-input.md`](../../v2/plan-inputs/04-control-plane-dashboard.plan-input.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Architecture Overview](#architecture-overview)
4. [Phase 1: Schema v6 and row types](#phase-1-schema-v6-and-row-types)
5. [Phase 2: PromptStore contract, SQLite, memory, CAS tests](#phase-2-promptstore-contract-sqlite-memory-cas-tests)
6. [Phase 3: Doctor orphaned-prompt check](#phase-3-doctor-orphaned-prompt-check)
7. [Phase 4: CLI signal lifecycle](#phase-4-cli-signal-lifecycle)
8. [Phase 5: Cancellable stdin and poll helper](#phase-5-cancellable-stdin-and-poll-helper)
9. [Phase 6: Prompt command integration](#phase-6-prompt-command-integration)
10. [Phase 7: Concurrency, CLI compatibility, and docs](#phase-7-concurrency-cli-compatibility-and-docs)
11. [Files Touched](#files-touched)
12. [Tests](#tests)
13. [Not In Scope](#not-in-scope)
14. [Estimated Timeline](#estimated-timeline)
15. [Revision History](#revision-history)
16. [Provenance](#provenance)

---

## Overview

Human gates are ephemeral TTY reads. v2 makes them durable control-plane records so a future dashboard (and tests today) can answer through the same atomic CAS as the terminal.

**Current behavior:**

- `promptChoose` / `promptConfirm` / `promptInput` (`src/commands/prompt.handler.ts:61–258`) validate flags, then either return `--default` on non-TTY, error `NON_INTERACTIVE`, or block on `readLine` / `readAll` / `readStdinPipe`.
- Success envelopes are `{ choice }`, `{ confirmed }`, `{ input }` (`test/integration/commands/prompt.test.ts`). Error codes: `INVALID_OPTIONS`, `INVALID_DEFAULT`, `NON_INTERACTIVE` (exit 3), `EOF` (exit 3), `INTERRUPTED` (exit 130). This slice adds `PROMPT_TIMEOUT` (exit 3) and `TERMINATED` (exit 143).
- No prompt table. Schema max is v5 (`src/db/schema.ts:402–417`; `test/unit/db/schema.test.ts` asserts version `5`).
- `5x prompt` does not open a DB (`registerPrompt` at `src/commands/prompt.ts:14` only forwards message/options/default).
- Doctor registry has five checks (`src/doctor/registry.ts:15–21`). `findingKey` has no prompt case (`src/doctor/registry.ts:77–107`). Area 203 defers `prompts` (`docs/v2/203-recovery-and-doctor.md:83`).
- Run ids are `run_` + 12 hex chars (`src/run-id.ts:9–11`), unique enough as FK values. Prompt ids must be full UUIDs (`200` §3a constraint #2).

**New behavior:**

- Every prompt command resolves `{ store, runExists }` via `defaultResolvePromptContext` (one `resolveDbContext`), creates an open `prompts` row (UUID), then waits or CAS-es. Optional `--run` is validated with `runExists` **before** insert.
- Terminal, `--default`, and test/control-plane writers call one `answerPrompt`. Exactly one write succeeds; losers receive the stored winning answer and still emit the existing success envelope.
- no-TTY + `--default`: persist, CAS immediately with `answered_by = 'default'`. no-TTY choose/confirm without default: persist, abandon (`non-interactive`), `NON_INTERACTIVE` (unless positive `--timeout`).
- TTY: persist, render as today, race cancellable stdin against a 250ms poll **and** `getCliAbortSignal()`. The winner always aborts the losing branches (store win aborts stdin; TTY/EOF/timeout win abort the poll; lifecycle abort aborts both). Interrupt/EOF abandon then existing errors (EOF may still apply default when `--default` is set). Multiline `readAll` SIGINT is `interrupted`, not a partial answer.
- no-TTY `input` (piped stdin): persist, then the same race with abortable `readStdinPipe` instead of TTY `readLine` — `--timeout` and control-plane CAS both apply; a hanging pipe does not bypass the wait contract.
- First SIGINT/SIGTERM is owned by the CLI lifecycle: abort in-flight work (prompt races observe this signal explicitly; SIGTERM never reaches the stdin listener). The handler CAS-abandons `interrupted` while the DB is open, emits `INTERRUPTED` (exit 130) or `TERMINATED` (exit 143), then release locks, close SQLite, and exit. A second signal or grace timeout force-exits.
- `5x doctor` reports `PROMPT_ORPHANED` for open rows whose `run_id` points at `completed` or `aborted`; `--fix` abandons with reason `run-terminal`.

**Prerequisites:**

- [`203-recovery-and-doctor-plan.md`](./203-recovery-and-doctor-plan.md) — complete enough to register the deferred check (`builtinDoctorChecks`, `findingKey`, `--fix` re-detect).
- Slice 204 (ambient run identity) is **not** required. This slice must not call `resolveAmbientRunId` (`204` plan: workers/commands pass explicit `run_id`).

---

## Design Decisions

**Command logic depends on `PromptStore` + `runExists`, never on `bun:sqlite`.** `202` §3.1 and `200` §3a#1. Put the store interface in `src/control-plane/store.ts`. SQLite SQL lives only in `src/control-plane/sqlite-store.ts`. Do not add prompt functions to `src/db/operations-v1.ts` for handlers to call. Handlers receive a `PromptCommandContext` (`store` + `runExists`) from a factory that runs **one** `resolveDbContext` and closes `runExists` over that `Database` via `getRunV1`. Unit tests inject a memory store and a fake `runExists`. The handler file must not import `bun:sqlite` or call `getRunV1` / `resolveDbContext` itself.

**Answered prompts are the request/answer log; do not add `decisions`.** `202` §3.2 lean and the plan-input assumption. Unsolicited abort/reopen/override stay `human:*` steps (`202` §3.4). Revisit only if a later spike proves this insufficient.

**`run_id` is a nullable FK.** `REFERENCES runs(id)` without `NOT NULL`. Standalone `5x prompt choose` (skills, ad-hoc) keeps working. Optional `--run <id>`: if set, `runExists(id)` (backed by `getRunV1` on the already-resolved DB) must be true or error `RUN_NOT_FOUND`; do not invent ambient resolution. Doctor orphans only rows with a non-null `run_id` whose run status is not `active`.

**Abandonment is first-class, and the schema enforces the pair.** Columns `abandoned_at` and `abandon_reason` (`timeout` \| `interrupted` \| `eof` \| `non-interactive` \| `run-terminal`). Open means both answer and abandon timestamps are null. `answerPrompt` and `abandonPrompt` are both `UPDATE … WHERE id = ? AND answered_at IS NULL AND abandoned_at IS NULL`. CHECKs make `(abandoned_at, abandon_reason)` all-or-nothing, keep those columns null on answered/open rows, and keep answered mutually exclusive with abandoned. A human answer must never be encoded as an abandon, and `--fix` must never invent `{ choice }` / `{ confirmed }` / `{ input }`.

**`--default` + no-TTY is immediate CAS, not a poll.** Matches `202` §3.3 recommendation and existing CI (`prompt.handler.ts:84–87`, `:177–180`). TTY still waits so a test/control-plane writer can win. no-TTY choose/confirm without `--default` stays fail-fast (do not hang CI): persist, abandon `non-interactive`, same `NON_INTERACTIVE` envelope/exit 3 unless `--timeout` / `FIVEX_PROMPT_TIMEOUT_MS` is a positive integer (opt-in wait). no-TTY `input` always waits on the pipe (today’s behavior) **but that wait is the same abortable race** as TTY: store writers, `--timeout`, and lifecycle abort can win; do not `await readStdinPipe()` unbounded outside the race. Parse timeout sources with `parseIntArg` / `intArg` from `src/utils/parse-args.ts` (finite, non-negative integer, full-string match). Reject `NaN`, negatives, `Infinity`, and trailing junk **before** `createPrompt`. Do not use Commander `parseInt` (partial parses) or existing `parseTimeout` (seconds, rejects `0`).

**Poll cadence is a constant 250ms with no backoff.** Local SQLite reads are cheap (`202` example 250–500ms). TTY default wall-clock timeout is none (today’s unbounded wait). `--timeout` applies to TTY waits, to no-TTY choose/confirm without `--default` when set, **and** to no-TTY `input` pipe waits.

**Success envelopes stay `{ choice }`, `{ confirmed }`, `{ input }`.** Do not add `prompt_id` in this slice. Losing CAS still prints the winning answer in that shape so agents do not see a new contract. Validation errors (`INVALID_OPTIONS`, `INVALID_DEFAULT`) still fire **before** insert.

**Cancellable stdin (TTY and pipe) is a hard prerequisite to the store race.** Extend `readLine` / `readAll` (`src/utils/stdin.ts:102–196`) **and** `readStdinPipe` (`:199–201`) with `AbortSignal`. On abort, remove listeners / cancel the stream reader and resolve a new `ABORTED` sentinel (do not reuse `EOF`/`SIGINT`). Every `Promise.race` of stdin/pipe vs poll vs timeout vs lifecycle must abort **all** losers in `finally` (store win aborts stdin/pipe; TTY/EOF/pipe win abort the poll; timeout aborts stdin/pipe and poll; lifecycle abort aborts both local controllers). `readAll` on SIGINT must resolve the `SIGINT` sentinel (not partial text) so multiline interrupt maps to `interrupted`. If the spike fails, stop Phase 6 TTY/pipe racing and escalate — do not ship a dangling `readLine` or an uncancellable `readStdinPipe`.

**CLI lifecycle owns process signals; every waiting prompt observes that abort.** Install a single SIGINT/SIGTERM owner from `src/bin.ts` (new `src/cli-lifecycle.ts`) before `parseAsync`. First SIGINT/SIGTERM records `getCliAbortCause()` (`"SIGINT"` \| `"SIGTERM"`), aborts `getCliAbortSignal()`, and does **not** call `process.exit`. Phase 6 **must** fan that signal into both the stdin/pipe controller and the poll controller (`AbortSignal.any` or a local fan-in; do not import `anySignal` from `src/providers/opencode.ts`). SIGINT may also hit the stdin listener; SIGTERM does not — the lifecycle signal is the only SIGTERM path. On lifecycle abort the handler CAS-abandons `interrupted` (same durable reason for both signals; no new CHECK value) while SQLite is open, then `outputError("INTERRUPTED", …)` (exit 130) or `outputError("TERMINATED", …)` (exit 143). After the command unwinds, cleanup order is: release locks, close DB, exit. `getDb` and `registerLockCleanup` keep idempotent `process.on("exit")` cleanup and **must not** register SIGINT/SIGTERM listeners that call `process.exit`. A second signal, or a bounded grace timeout (`CLI_SIGINT_GRACE_MS`, 2s) if the command does not unwind, force-exits 130 (SIGINT) or 143 (SIGTERM) (best-effort envelope). Commands that already complete after abort (e.g. `run watch`) must keep their current exit code: cancel the grace timer when `parseAsync` returns. This is compatible with superseded `011-provider-process-lifecycle.md` (removing `process.exit` from db/lock) and does **not** implement provider cleanup.

**Doctor `--fix` is safe here.** Unlike lingering runs (warn-only, `fixable: false`, `src/doctor/checks/runs.ts:92–107`), an open prompt on a terminal run cannot be answered usefully. `--fix` calls `abandonPrompt(..., 'run-terminal')`. Finding identity is `detail.promptId` via a new `findingKey` case; `fixable: true` without identity must keep throwing.

**Prompt commands always persist, so they always open the control-plane DB.** `defaultResolvePromptContext()` calls `resolveDbContext` (`src/commands/context.ts:82–149`) like other mutating commands. `getDb` may create `.5x/5x.db`. Integration tests that currently spawn without `cwd` (`test/integration/commands/prompt.test.ts`) **must** move to temp projects (pattern: `test/integration/commands/doctor.test.ts:19–62`) so they do not write the repo database.

**Test writers are first-class `PromptStore` clients.** Shared contract tests run against `SqlitePromptStore` and `MemoryPromptStore`. Handler unit tests inject `MemoryPromptStore` plus fake `runExists`, clock/sleep/stdin, and abort signal/cause. Do not change command behavior to special-case tests.

---

## Architecture Overview

```
  5x prompt choose|confirm|input
           │
           ├─ validate flags (unchanged)
           ├─ resolvePromptContext() → { store, runExists }   // one resolveDbContext
           ├─ optional --run: runExists(id) else RUN_NOT_FOUND (before create)
           ├─ createPrompt({ uuid, runId?, kind, message, options, default })
           │
           ├─ no-TTY + --default ──► answerPrompt(..., "default") ──► envelope
           ├─ no-TTY choose/confirm, no default, no --timeout
           │         └─ abandonPrompt(..., "non-interactive") ──► NON_INTERACTIVE
           │
           └─ wait (TTY, no-TTY input pipe, or positive --timeout)
                     │
                     ├─ render prompt (stderr /dev/tty) as today (TTY only)
                     ├─ two local AbortControllers (stdin/pipe + poll)
                     ├─ fan-in getCliAbortSignal() into both controllers
                     ├─ race: abortable readLine/readAll/readStdinPipe
                     │        vs  poll getPrompt every 250ms
                     │        vs  timeout (if set)
                     │
                     ├─ TTY/pipe wins ──► answerPrompt(..., "terminal")
                     │                     lost CAS ──► use stored answer
                     ├─ store wins ──► abort stdin/pipe + abort poll ──► stored answer
                     ├─ TTY/EOF/pipe/timeout ──► abort the losing poll/stdin branch
                     ├─ lifecycle SIGINT ──► CAS-abandon interrupted (DB still open)
                     │                       ──► INTERRUPTED ──► locks ──► close DB ──► exit 130
                     ├─ lifecycle SIGTERM ──► CAS-abandon interrupted (DB still open)
                     │                       ──► TERMINATED ──► locks ──► close DB ──► exit 143
                     └─ EOF ──► default CAS or abandon eof ──► EOF

  Test / future dashboard
           └─ store.answerPrompt(id, answer, "control-plane")   // same CAS

  5x doctor [--fix]
           └─ listOpenPrompts → run status completed|aborted
                └─ --fix: abandonPrompt(id, "run-terminal")
```

State machine per row:

```
          createPrompt
               │
               v
            OPEN ──────────────────────────► ANSWERED
               │           answerPrompt         (answered_at, answer, answered_by)
               │
               └──── abandonPrompt ────────► ABANDONED
                     (timeout|interrupted|eof|non-interactive|run-terminal)
```

`listOpenPrompts` returns OPEN only.

---

## Phase 1: Schema v6 and row types

**Completion gate:** Fresh and v5 databases migrate to v6 with `prompts` + indexes; `getMaxKnownSchemaVersion()` is `6`; no command behavior change.

#### 1.1 Migration 6 — `src/db/schema.ts` after v5 (`:402–409`)

Append version 6. Keep v1 `runs` / `steps` / `plans` unchanged. UUID ids are TEXT (same as `runs.id`).

```sql
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('choose', 'confirm', 'input')),
  message TEXT NOT NULL,
  options_json TEXT,
  default_value TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at TEXT,
  answer TEXT,
  answered_by TEXT CHECK (
    answered_by IS NULL OR answered_by IN ('terminal', 'control-plane', 'default')
  ),
  abandoned_at TEXT,
  abandon_reason TEXT CHECK (
    abandon_reason IS NULL OR abandon_reason IN (
      'timeout', 'interrupted', 'eof', 'non-interactive', 'run-terminal'
    )
  ),
  CHECK (
    (answered_at IS NULL AND answer IS NULL AND answered_by IS NULL)
    OR (answered_at IS NOT NULL AND answer IS NOT NULL AND answered_by IS NOT NULL)
  ),
  CHECK (
    (abandoned_at IS NULL AND abandon_reason IS NULL)
    OR (abandoned_at IS NOT NULL AND abandon_reason IS NOT NULL)
  ),
  CHECK (NOT (answered_at IS NOT NULL AND abandoned_at IS NOT NULL))
);
CREATE INDEX idx_prompts_open_run
  ON prompts(run_id) WHERE answered_at IS NULL AND abandoned_at IS NULL;
CREATE INDEX idx_prompts_recent ON prompts(created_at DESC);
```

`run_id` nullable (standalone prompts). `options_json` is a JSON array of strings for `choose`, NULL otherwise. Confirm `--default` stores the raw flag text (`yes`/`no`/…); the handler still maps to boolean in the envelope.

- [ ] Add migration 6 with the SQL above; description names UUID prompts + open/recent indexes.
- [ ] Do not alter `runs` / `steps` / `plans`.

#### 1.2 Schema tests — `test/unit/db/schema.test.ts`, `test/unit/db/schema-v4.test.ts`

Those files hard-code max version `5` (`schema.test.ts:28,40,117,136,166`; `schema-v4.test.ts:45`). Bump every “current version” assertion to `6`. Add a focused `schema-v6.test.ts` (copy the v4 helper `migrateUpTo` pattern at `schema-v4.test.ts:28–37`):

- Fresh DB → version 6; table + both indexes exist (`sqlite_master` / `PRAGMA index_list`).
- v5 DB (migrate up to 5, then `runMigrations`) gains `prompts` without dropping steps.
- FK: inserting `run_id` that is not in `runs` throws; `run_id` NULL succeeds.
- CHECK: cannot set `answered_at` without `answer`/`answered_by`.
- CHECK: cannot set `abandoned_at` without `abandon_reason`; cannot set `abandon_reason` without `abandoned_at`.
- CHECK: cannot set both answered and abandoned timestamps.
- CHECK: cannot set an answered triple plus `abandon_reason` (pair integrity + mutex).

- [ ] Update version-5 assertions to 6.
- [ ] Add `test/unit/db/schema-v6.test.ts` covering table, indexes, FK, CHECKs (including abandon-pair all-or-nothing and mutual exclusion with answered), v5→v6.

---

## Phase 2: PromptStore contract, SQLite, memory, CAS tests

**Completion gate:** Shared contract tests pass on SQLite and memory. Parallel `answerPrompt` yields exactly one winner. Command handlers still unchanged.

#### 2.1 Types and IDs — new `src/control-plane/`

```typescript
// src/control-plane/ids.ts
import { randomUUID } from "node:crypto";
export function createPromptId(): string {
  return randomUUID(); // RFC 4122, not run_ + 12 hex
}

// src/control-plane/types.ts
export type PromptKind = "choose" | "confirm" | "input";
export type AnsweredBy = "terminal" | "control-plane" | "default";
export type AbandonReason =
  | "timeout"
  | "interrupted"
  | "eof"
  | "non-interactive"
  | "run-terminal";

export interface PromptRecord {
  id: string;
  runId: string | null;
  kind: PromptKind;
  message: string;
  options: string[] | null;
  defaultValue: string | null;
  createdAt: string;
  answeredAt: string | null;
  answer: string | null;
  answeredBy: AnsweredBy | null;
  abandonedAt: string | null;
  abandonReason: AbandonReason | null;
}

export interface CreatePromptInput {
  runId?: string | null;
  kind: PromptKind;
  message: string;
  options?: string[] | null;
  defaultValue?: string | null;
  id?: string; // tests only
}

export type CasResult =
  | { ok: true; prompt: PromptRecord }
  | { ok: false; prompt: PromptRecord }; // already answered or abandoned
```

Confirm answers persist as `"true"` / `"false"` strings; the handler maps to `{ confirmed: boolean }` (existing envelope at `prompt.handler.ts:179`). Choose/input persist the option/text string.

#### 2.2 Store interface — `src/control-plane/store.ts`

```typescript
export interface PromptStore {
  createPrompt(input: CreatePromptInput): PromptRecord;
  getPrompt(id: string): PromptRecord | null;
  listOpenPrompts(runId?: string): PromptRecord[];
  /** CAS: succeed iff still open. Loser returns stored row, does not overwrite. */
  answerPrompt(id: string, answer: string, answeredBy: AnsweredBy): CasResult;
  abandonPrompt(id: string, reason: AbandonReason): CasResult;
}
```

No SQLite types on this interface. Dashboard slice 4 will depend on it.

#### 2.3 SQLite implementation — `src/control-plane/sqlite-store.ts`

Constructor takes `Database` from `bun:sqlite` (same as `getDb` / `openDbReadOnly`). Map rows in this file only.

CAS SQL:

```sql
UPDATE prompts
SET answered_at = datetime('now'), answer = ?1, answered_by = ?2
WHERE id = ?3 AND answered_at IS NULL AND abandoned_at IS NULL;
```

Then `SELECT changes()`; if `0`, `SELECT * FROM prompts WHERE id = ?` and return `{ ok: false, prompt }`. Missing id: throw a small `PromptStoreError` with code `PROMPT_NOT_FOUND` (handlers map later if needed). Same pattern for `abandonPrompt`. `listOpenPrompts`: `answered_at IS NULL AND abandoned_at IS NULL`, optional `run_id = ?`, `ORDER BY created_at ASC`.

`createPrompt` uses `createPromptId()` unless `input.id` is provided.

#### 2.4 Memory implementation — `src/control-plane/memory-store.ts`

`Map<string, PromptRecord>`. CAS is compare-and-set on the in-memory object (single-threaded atomicity is enough; contract tests also `Promise.all` two answers). Used by handler unit tests and as the “test control-plane writer.”

#### 2.5 Factory — `src/control-plane/index.ts`

```typescript
export function createSqlitePromptStore(db: Database): PromptStore;
export function createMemoryPromptStore(): PromptStore;
export type { PromptStore, PromptRecord, CasResult, /* … */ };
```

Re-export types from `src/index.ts` so slice 4 does not import deep paths. Do not export SQL helpers.

#### 2.6 Contract tests — `test/unit/control-plane/store-contract.test.ts`

Parameterized factory: run the same suite for sqlite (temp `getDb` + `runMigrations`) and memory.

- [ ] `createPrompt` then `getPrompt` round-trips UUID, kind, message, options, default, null answer.
- [ ] `listOpenPrompts()` omits answered and abandoned; `listOpenPrompts(runId)` filters; null `run_id` rows appear only in the unfiltered list.
- [ ] First `answerPrompt` wins; second returns `{ ok: false }` with the first answer; stored `answered_by` unchanged.
- [ ] `Promise.all` two `answerPrompt` calls → exactly one `ok: true`.
- [ ] `abandonPrompt` then `answerPrompt` loses; `answerPrompt` then `abandonPrompt` loses.
- [ ] Abandoned rows are not open.
- [ ] SQLite: two stores on one DB still CAS correctly (shared file).

Do not start prompt CLI tests in this phase.

---

## Phase 3: Doctor orphaned-prompt check

**Completion gate:** `5x doctor` reports `PROMPT_ORPHANED` for open prompts on terminal runs; `--fix` abandons them; `findingKey` identity is `promptId`. Prompt CLI still unchanged. Lands **before** command integration so crashed later work has a cleanup path (plan-input risk table).

#### 3.1 Check module — `src/doctor/checks/prompts.ts`

Follow `runs.ts`: if `!existsSync(ctx.dbPath)` return `[]`. Open `openDbReadOnly(ctx.projectRoot, ctx.dbRelPath)`. On open/query failure, one `fail` `PROMPT_DB_UNREADABLE` (`fixable: false`), same shape as runs’ `DB_UNREADABLE`.

Construct `createSqlitePromptStore(db)`. For each `listOpenPrompts()` with non-null `runId`, `getRunV1(db, runId)` (`src/db/operations-v1.ts:320–324`). If missing or `status` is `completed` or `aborted` (`completeRun` at `:360–371`):

```typescript
{
  check: "prompts",
  status: "fail",
  code: "PROMPT_ORPHANED",
  message: `open prompt ${id} is orphaned; run ${runId} is ${status}`,
  remediation: "5x doctor --fix",
  fixable: true,
  detail: { promptId: id, runId, runStatus: status },
}
```

Standalone open prompts (`run_id` NULL) are **not** this finding (no terminal run). Process-crash leftovers without a run stay until that prompt command’s own abandon path; document as residual.

If no orphan findings: one `ok` `PROMPTS_OK`.

`fix(finding, ctx)`: re-read `detail.promptId`; reopen **writable** `getDb(ctx.projectRoot, ctx.dbRelPath)` (do **not** `resolveDbContext` — it migrates; doctor DB check forbids that). `abandonPrompt(id, "run-terminal")`. Re-validate still-open-on-terminal-run before write (handler iterates original `detected`). `attempted: true` only if CAS ran (`DoctorFixResult.attempted` in `src/doctor/types.ts:38–42`). Missing/already-closed: `attempted: false`.

Close connections in `finally`.

#### 3.2 Registry — `src/doctor/registry.ts`

- [ ] Import `promptsCheck` and append after `dbCheck` (203 table order: prompts last).
- [ ] `findingKey`: `case "PROMPT_ORPHANED": return String(d.promptId ?? "");`
- [ ] Update `test/unit/doctor/registry.test.ts` order assertion (`:28–35`) to include `"prompts"` last.
- [ ] Add registry tests: two orphans with the same code but different `promptId` produce different keys; `fixable` + missing `promptId` throws.

#### 3.3 Unit tests — `test/unit/doctor/prompts.test.ts`

Temp DB + `runMigrations` + `createRunV1` + store:

- [ ] Open prompt + `active` run → `PROMPTS_OK`.
- [ ] Open prompt + `completeRun(..., "completed")` → `PROMPT_ORPHANED` fail fixable.
- [ ] Open prompt + `aborted` run → same.
- [ ] Answered prompt + terminal run → not reported.
- [ ] Open prompt + `run_id` NULL → not reported.
- [ ] `--fix` path: `fix()` then re-`run()` no longer lists that `promptId`.
- [ ] Missing DB file → `[]`.
- [ ] Unreadable DB → `PROMPT_DB_UNREADABLE`.

---

## Phase 4: CLI signal lifecycle

**Completion gate:** `getDb` and `registerLockCleanup` no longer call `process.exit` on SIGINT/SIGTERM. A process-wide lifecycle installed from `src/bin.ts` aborts in-flight work on first SIGINT/SIGTERM without exiting, records `getCliAbortCause()`, then (after the command unwinds) releases locks, closes the DB, and exits 130/143. Second signal or `CLI_SIGINT_GRACE_MS` force-exits. Cleanup is ordered and idempotent. Prompt CLI still unchanged in this phase (end-to-end abandon is Phase 7).

This phase lands **before** command integration so Phase 6 interrupt-abandonment is possible. It is not solved by `AbortSignal` on stdin alone: today `getDb()` registers its SIGINT listener first and exits before `readLine`’s listener runs.

#### 4.1 Lifecycle module — new `src/cli-lifecycle.ts`

```typescript
export const CLI_SIGINT_GRACE_MS = 2_000;

export type CliAbortCause = "SIGINT" | "SIGTERM";

export function installCliLifecycle(): AbortSignal;
export function getCliAbortSignal(): AbortSignal;
export function getCliAbortCause(): CliAbortCause | undefined;
export function disarmCliLifecycle(): void; // cancel grace timer; call when parseAsync returns
```

Install from `src/bin.ts` **before** `program.parseAsync`. Register SIGINT and SIGTERM once (idempotent). `getCliAbortSignal()` before install (or in unit tests that never install) returns a **never-aborted** signal so handlers can default to it without throwing. `getCliAbortCause()` is `undefined` until the first signal. Behavior:

| Event | Action |
|-------|--------|
| First SIGINT | Record cause `"SIGINT"`. Abort the process `AbortController`. Do **not** `process.exit`. Start `CLI_SIGINT_GRACE_MS` timer. Remaining SIGINT listeners (stdin, `run watch`) still run. |
| First SIGTERM | Record cause `"SIGTERM"`. Same abort-without-exit; grace timer; eventual exit 143 if the command does not unwind. Stdin has **no** SIGTERM listener — waiters must observe `getCliAbortSignal()`. |
| Command completes after abort | Prompt handler CAS-abandons `interrupted` then `outputError("INTERRUPTED")` (130) or `outputError("TERMINATED")` (143) according to `getCliAbortCause()`. `bin.ts` catch emits envelope and `process.exit`. `process.on("exit")` then runs lock release + `closeDb`. `disarmCliLifecycle()` in `bin.ts` `finally` cancels the grace timer. |
| `parseAsync` returns normally after abort | Example: `run watch` aborts its tailer and returns. Disarm grace timer. Process exits with that command’s code (today 0 for watch). Do **not** force 130/143. |
| Second SIGINT / grace timeout | Force `process.exit(130)` (SIGTERM: 143). Sync `exit` listeners still run. Envelope is best-effort only if not already written. |

Force-exit and normal exit must both be idempotent: `closeDb()` is already safe to call twice; lock release must be too; the lifecycle must ignore a second force-exit.

Do **not** emit `INTERRUPTED` / `TERMINATED` from the lifecycle on the graceful path — the prompt handler owns the envelope so it can CAS-abandon first. Lifecycle force-exit may skip the envelope if the process is wedged.

`getCliAbortCause()` returns `undefined` until the first signal. Prompt races (Phase 6) treat a lifecycle abort as durable interruption: `abandon_reason = 'interrupted'` for **both** SIGINT and SIGTERM (no new schema value). Exit code and envelope code distinguish the signals (`INTERRUPTED`/130 vs `TERMINATED`/143).

#### 4.2 Strip `process.exit` from DB and lock utilities

`src/db/connection.ts` (`getDb`, lines 41–54 today): keep `process.on("exit", closeDb)`. Remove the SIGINT listener that `closeDb()` + `process.exit(130)` and the SIGTERM listener that exits 143. Closing the DB must remain the `exit` handler’s job so a prompt can still `UPDATE` after first SIGINT.

`src/lock.ts` `registerLockCleanup` (lines 425–441 today): keep `process.on("exit", releaseLock)`. Remove SIGINT/SIGTERM listeners that `releaseLock()` + `process.exit(130/143)`.

Cleanup order on any actual process exit (graceful `bin.ts` `process.exit(130)` or force-exit):

1. Abort in-flight work (already done on first signal).
2. Command-level durable work (prompt CAS-abandon) — only on the graceful path, while SQLite is open.
3. Release locks (`registerLockCleanup`’s `exit` handler).
4. Close DB (`getDb`’s `exit` handler).
5. Process gone.

`process.on("exit")` listeners run in registration order. Document that lock cleanup is registered per acquire (may be after DB open). Both operations are independent and idempotent; do not require a specific listener order beyond “locks and DB are released on `exit`, never on SIGINT itself.”

`run watch` (`src/commands/run-v1.handler.ts:1665–1696`) already aborts a local `AbortController` and does not `process.exit`. After this change it should keep working: first SIGINT aborts (watch’s own listener still fires), watch returns, grace timer is disarmed, process exits 0. Prefer eventually observing `getCliAbortSignal()` instead of a second process listener, but abort-only extra listeners are allowed. Extra listeners must never call `process.exit`.

Out of scope: provider-process cleanup from superseded `011-provider-process-lifecycle.md`. Removing `process.exit` from db/lock is compatible with that design.

#### 4.3 Tests — `test/unit/cli-lifecycle.test.ts`, `test/unit/db/connection.test.ts`

- [ ] `getDb` SIGINT/SIGTERM listeners do not call `process.exit` (stub `process.exit`; raise a fake signal or inspect listener side effects). After SIGINT the connection is still open (`closeDb` not yet called).
- [ ] `registerLockCleanup` SIGINT/SIGTERM listeners do not call `process.exit`; lock file still present until `process.emit("exit")` / explicit release.
- [ ] First SIGINT: `getCliAbortSignal().aborted === true`; `getCliAbortCause() === "SIGINT"`; `process.exit` not called; grace timer scheduled.
- [ ] First SIGTERM: `getCliAbortSignal().aborted === true`; `getCliAbortCause() === "SIGTERM"`; `process.exit` not called.
- [ ] Second SIGINT: `process.exit(130)` once; subsequent signals are no-ops.
- [ ] Grace timeout: `process.exit(130)` if still armed after SIGINT; `process.exit(143)` if still armed after SIGTERM.
- [ ] `disarmCliLifecycle()` cancels the grace timer; process does not later force-exit.
- [ ] `closeDb` + lock release on simulated `exit` are idempotent (double `closeDb` / double release does not throw).
- [ ] `installCliLifecycle()` is idempotent (no duplicate listeners).

Do not require a spawned prompt in this phase. The real-process “row abandoned `interrupted` + exit 130/143” tests (SIGINT and SIGTERM) are Phase 7 gates (need persist + handler).

- [ ] Existing `run watch` SIGINT integration still exits as today (regression; may live in Phase 7 if it needs a full CLI spawn).

---

## Phase 5: Cancellable stdin and poll helper

**Completion gate:** `readLine`/`readAll`/`readStdinPipe` honor `AbortSignal`; `readAll` SIGINT uses the `SIGINT` sentinel (not partial text); `waitForPromptAnswer` returns on store answer, timeout, or abort and stops polling when aborted. No CLI wiring yet.

#### 5.1 Stdin — `src/utils/stdin.ts`

Add `export const ABORTED = Symbol("ABORTED");`.

```typescript
export function readLine(
  signal?: AbortSignal,
): Promise<string | typeof EOF | typeof SIGINT | typeof ABORTED>;

export function readAll(
  signal?: AbortSignal,
): Promise<string | typeof EOF | typeof SIGINT | typeof ABORTED>;

export function readStdinPipe(
  signal?: AbortSignal,
): Promise<string | typeof ABORTED>;
```

If `signal?.aborted` already, resolve `ABORTED`. On `abort`, `cleanup()` and resolve `ABORTED` (do not treat as EOF). Existing tests without a signal must be unchanged for `readLine` and `readStdinPipe` (pipe still returns the full text).

**`readStdinPipe` abort:** today `readStdinPipe` (`src/utils/stdin.ts:199–201`) is `new Response(Bun.stdin.stream()).text()` with no cancellation. Consume the stream via a reader; on abort, `reader.cancel()`, resolve `ABORTED`. A hanging pipe must not keep the process alive after timeout, store win, or lifecycle abort.

**`readAll` SIGINT:** today `readAll` (`src/utils/stdin.ts:182–188`) resolves **partial text** on SIGINT. Change it to resolve the `SIGINT` sentinel (same as `readLine`), discarding partial chunks. Prompt `input --multiline` maps that sentinel to abandon `interrupted` / `INTERRUPTED`, never to a successful `{ input }` of partial text.

- [ ] Unit tests: abort before wait → `ABORTED`; abort mid-wait → `ABORTED` and listeners removed; no signal → current EOF/line/pipe-text behavior.
- [ ] `readAll` SIGINT → `SIGINT` sentinel, not a string of partial chunks; listeners removed.
- [ ] `readStdinPipe` abort mid-read → `ABORTED`; stream reader cancelled; no-signal path still returns piped text.

#### 5.2 Wait helper — `src/control-plane/wait.ts`

```typescript
export const PROMPT_POLL_INTERVAL_MS = 250;

export async function waitForPromptAnswer(
  store: PromptStore,
  id: string,
  opts: {
    pollIntervalMs?: number;
    timeoutMs?: number | null; // null = no wall clock
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    signal?: AbortSignal;
  },
): Promise<PromptRecord>;
```

Loop: `getPrompt`; if answered, return; if abandoned, throw `PromptAbandonedError`; if `signal.aborted`, throw `PromptWaitAbortedError`; if `timeoutMs` elapsed, throw `PromptTimeoutError`. Else `sleep(pollIntervalMs)`. Default `sleep` is `Bun.sleep` (or `setTimeout` promisified). Inject `sleep`/`now` in tests.

- [ ] Tests: answers on Nth poll; timeout; abort; abandoned row errors; does not busy-spin (fake sleep records interval 250).
- [ ] Abort mid-poll: `waitForPromptAnswer` throws `PromptWaitAbortedError` and does not schedule another `sleep`/`getPrompt` after abort.

Every race against this helper (Phase 6) must abort **this** `signal` in `finally` as well as the stdin/pipe `AbortController`, including timeout, TTY/EOF/pipe wins, **and lifecycle abort** — not only store wins. Phase 6 fans `getCliAbortSignal()` into this `signal` (and the stdin/pipe controller) so SIGTERM is observed.

---

## Phase 6: Prompt command integration

**Completion gate:** All three commands persist before waiting. `--default` CI path unchanged. TTY and no-TTY `input` pipe race store vs local reader vs timeout vs lifecycle abort. `--run` uses injected `runExists`. Interrupt/EOF/SIGTERM abandon. Existing success envelopes unchanged. Integration tests run in temp dirs.

#### 6.1 Adapter flags — `src/commands/prompt.ts`

Add to `choose`, `confirm`, and `input`:

```typescript
.option("--run <id>", "Associate this prompt with a run id")
.option(
  "--timeout <ms>",
  "Max wait in ms (TTY and no-TTY input pipe: unbounded if omitted; no-TTY choose/confirm without --default: 0)",
  intArg("--timeout"),
)
```

Use `intArg` from `src/utils/parse-args.ts` (wraps `parseIntArg`: finite, non-negative integer, full-string match). Do **not** pass Commander `parseInt` (`parseInt("10abc", 10) === 10`, `parseInt("foo") === NaN`). `0` is allowed (immediate timeout). Invalid `--timeout` must fail with `INVALID_ARGS` **before** `createPrompt`.

Pass `run` / `timeout` into handlers. Do not add `--run` as required.

#### 6.2 Handler deps and shared flow — `src/commands/prompt.handler.ts`

`--run` validation needs a run lookup, but `PromptStore` is prompt-table-only and handlers must not keep the `Database` from `resolveDbContext`. Inject a small context object so one resolved DB backs both the store and the run check:

```typescript
export interface PromptCommandContext {
  store: PromptStore;
  /** True iff a `runs` row exists. Production closes over getRunV1(db). */
  runExists: (runId: string) => boolean;
}

export interface PromptHandlerDeps {
  store?: PromptStore;
  runExists?: (runId: string) => boolean;
  resolveContext?: () => Promise<PromptCommandContext>;
  isTTY?: () => boolean;
  readLine?: typeof readLine;
  readAll?: typeof readAll;
  readStdinPipe?: typeof readStdinPipe;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  getAbortSignal?: () => AbortSignal; // default: getCliAbortSignal
  getAbortCause?: () => CliAbortCause | undefined; // default: getCliAbortCause
}

export interface ChooseParams {
  message: string;
  options: string;
  default?: string;
  run?: string;
  timeout?: number;
}
// ConfirmParams / InputParams: add run? timeout? similarly
```

**Default context factory** — new `src/commands/prompt-context.ts` (not in the handler file, so `prompt.handler.ts` never imports `bun:sqlite`, `getRunV1`, or `resolveDbContext`):

```typescript
export async function defaultResolvePromptContext(): Promise<PromptCommandContext> {
  const { db } = await resolveDbContext();
  return {
    store: createSqlitePromptStore(db),
    runExists: (runId) => getRunV1(db, runId) !== null,
  };
}
```

Adapter `src/commands/prompt.ts` **always** passes `{ resolveContext: defaultResolvePromptContext }`. `prompt.handler.ts` does **not** import `prompt-context.ts`, `getRunV1`, `resolveDbContext`, or `bun:sqlite`. Unit tests pass `store: createMemoryPromptStore()` plus `runExists`. Resolution: if `deps.store` is set, use `{ store: deps.store, runExists: deps.runExists ?? (() => false) }`; else `await deps.resolveContext()` (required in production). Do **not** open a second DB, call `getRunV1` from the handler, or add `getRun` to `PromptStore`.

Shared sequence after existing validation (`INVALID_OPTIONS` / `INVALID_DEFAULT` **before** create):

1. Resolve timeout: if `--timeout` omitted, read `FIVEX_PROMPT_TIMEOUT_MS`. Parse with `parseIntArg("FIVEX_PROMPT_TIMEOUT_MS")` (same rules as `--timeout`). Unset/empty env → omitted (unbounded TTY/pipe; no-TTY choose/confirm-without-default stays 0). Invalid env or flag → `INVALID_ARGS` **before** `createPrompt`. Re-check `Number.isFinite(timeout) && timeout >= 0` in the handler so injected deps cannot sneak `NaN`/`Infinity` past the adapter.
2. Resolve `{ store, runExists }` via the context factory above.
3. Optional `run`: if `!runExists(run)` → `outputError("RUN_NOT_FOUND", ...)`. **No row created.**
4. `createPrompt({ runId, kind, message, options, defaultValue })`.
5. Branch:
   - **no-TTY + default (choose/confirm):** `answerPrompt(id, normalized, "default")`; `outputSuccess` from `result.prompt` (winner’s answer if CAS lost).
   - **no-TTY choose/confirm, no default, timeout 0/omitted:** `abandonPrompt(id, "non-interactive")`; `outputError("NON_INTERACTIVE", ...)` same message as today (`:89–92`, `:182–185`).
   - **Wait paths** (TTY; no-TTY `input` pipe; no-TTY choose/confirm with positive timeout): use one shared race helper. TTY renders as today. no-TTY `input` does **not** `await readStdinPipe()` outside the race.

**Shared race helper** (TTY `readLine`/`readAll`, no-TTY `input` `readStdinPipe`, or poll-only when no-TTY choose/confirm + positive timeout):

1. Create **two** local `AbortController`s (`stdinCtl`, `pollCtl`).
2. Read `lifecycle = deps.getAbortSignal?.() ?? getCliAbortSignal()`. Fan-in: `lifecycle.addEventListener("abort", () => { stdinCtl.abort(); pollCtl.abort(); }, { once: true })` (or `AbortSignal.any([local, lifecycle])` passed into each waiter). If `lifecycle` is already aborted, skip the race and take the lifecycle-abandon path immediately.
3. `Promise.race` the input promise (if any) against `waitForPromptAnswer({ signal: pollCtl.signal, timeoutMs, sleep, now })`. no-TTY choose/confirm + timeout has no stdin promise — poll/timeout/lifecycle only.
4. In `finally`, abort **both** local controllers (idempotent) so the loser cannot keep polling or listening.
5. Outcomes:
   - Store answered: abort stdin/pipe; map stored answer to envelope. Poll branch is already complete.
   - TTY/pipe value: abort poll; `answerPrompt(..., "terminal")`; if `ok: false` and the row is answered, still success from stored answer; if abandoned, map reason to `INTERRUPTED` / `TERMINATED` / `EOF` / timeout error.
   - Lifecycle abort (`getAbortCause() === "SIGINT"` or stdin `SIGINT` sentinel): abort both; `abandonPrompt(..., "interrupted")` **while the DB is still open**; `outputError("INTERRUPTED", ...)`. Lifecycle then releases locks, closes SQLite, exits 130.
   - Lifecycle abort (`getAbortCause() === "SIGTERM"`): abort both; `abandonPrompt(..., "interrupted")` (same durable reason; no new CHECK value); `outputError("TERMINATED", "Prompt terminated")` (add `TERMINATED: 143` to `EXIT_CODE_MAP` in `src/output.ts:50–71`). Do not emit `INTERRUPTED`/130 for SIGTERM.
   - `EOF`: abort poll; if default, CAS `"default"` (today’s EOF+default); else abandon `eof`; `EOF`.
   - `PromptTimeoutError`: abort stdin/pipe; abandon `timeout`; new code `PROMPT_TIMEOUT` (exit 3, add to `EXIT_CODE_MAP`). Reachable with `--timeout` / env on TTY, no-TTY wait opt-in, **and** no-TTY `input` pipe.
   - `ABORTED` from stdin/pipe after store win: treat as store win, not interrupt.
   - `ABORTED` from stdin/pipe because lifecycle aborted: treat as the lifecycle-abandon path above (inspect `getAbortCause()`), not as store win.

Envelope mappers (keep exact keys):

| Kind | Stored `answer` | Success data |
|------|-----------------|--------------|
| choose | option string | `{ choice }` |
| confirm | `"true"` / `"false"` | `{ confirmed: boolean }` |
| input | text | `{ input }` |

`try/finally`: if the function is about to throw/`outputError` and the row is still open, abandon with the matching reason so doctor is not required for the happy-path failure.

#### 6.3 Env override

Read `FIVEX_PROMPT_TIMEOUT_MS` when `--timeout` is omitted. Validate with `parseIntArg` **before** `createPrompt` (reject non-finite, negative, empty-but-set, `10abc`, `Infinity`). Document in 101. Tests can set a short wait without new argv in every case.

#### 6.4 Handler unit tests — `test/unit/commands/prompt-store.test.ts`

Inject memory store + `runExists` + fake TTY/sleep + injectable abort signal/cause:

- [ ] Choose `--default` no-TTY: one open-then-answered row, `answeredBy === "default"`, stdout `{ choice }`.
- [ ] Choose no-TTY no default: abandoned `non-interactive`, `NON_INTERACTIVE`.
- [ ] Invalid default: no row created.
- [ ] Parallel: create via handler TTY path (fake `readLine` that never resolves until abort); second task `answerPrompt(..., "control-plane")`; handler returns the control-plane answer; `readLine` was aborted **and** the poll helper’s signal was aborted.
- [ ] Timeout win: stdin `AbortController` aborted; poll stopped; row abandoned `timeout`.
- [ ] TTY/EOF win: poll signal aborted (no further `getPrompt` after the race settles).
- [ ] Multiline `readAll` → `SIGINT`: abandoned `interrupted`, `INTERRUPTED`; no success envelope with partial text.
- [ ] Injected lifecycle abort with cause `"SIGTERM"` during TTY wait: both controllers aborted; row abandoned `interrupted`; envelope `TERMINATED` (not `INTERRUPTED`).
- [ ] Injected lifecycle abort with cause `"SIGINT"` during TTY wait: abandoned `interrupted`, `INTERRUPTED`.
- [ ] no-TTY `input` + hanging pipe + `--timeout`: pipe aborted; row abandoned `timeout`; `PROMPT_TIMEOUT`.
- [ ] no-TTY `input` + hanging pipe + store writer: pipe aborted; envelope is the stored `{ input }`.
- [ ] `--timeout -1` / `abc` / `10ms` / `NaN`: `INVALID_ARGS`, **no row**.
- [ ] `FIVEX_PROMPT_TIMEOUT_MS=nope` with flag omitted: `INVALID_ARGS`, **no row**.
- [ ] `--run` unknown (`runExists` → false): `RUN_NOT_FOUND`, **no row**.
- [ ] `--run` known (`runExists` → true): row created with that `runId`.
- [ ] Confirm/input equivalent persist+CAS.

#### 6.5 Integration tests — rewrite `test/integration/commands/prompt.test.ts`

Use temp dir + git init + migrated DB (`doctor.test.ts:49–62`). Spawn with `cwd: dir`. Re-assert every current case (defaults, `NON_INTERACTIVE` exit 3, `INVALID_*`, interactive `5X_FORCE_TTY`, EOF, pipe input). Add:

- [ ] After `--default` success, SQLite has one answered row `answered_by = 'default'`.
- [ ] After `NON_INTERACTIVE`, row is abandoned not open.
- [ ] `--run` + real `createRunV1` sets `run_id`.
- [ ] `--run` unknown: `RUN_NOT_FOUND`, no prompt row.
- [ ] `--timeout abc` and `--timeout -1` exit non-zero with `INVALID_ARGS` and insert no prompt row.
- [ ] no-TTY `input` with a hanging stdin pipe + `--timeout 50`: `PROMPT_TIMEOUT` exit 3; row abandoned `timeout`; process exits (pipe did not hang the CLI).
- [ ] no-TTY `input` with a hanging stdin pipe: a second process `answerPrompt`s via sqlite; waiter exits 0 with the stored `{ input }`; pipe reader aborted.

---

## Phase 7: Concurrency, CLI compatibility, and docs

**Completion gate:** CAS race, timeout, pipe-vs-store, **real-process SIGINT and SIGTERM abandon**, doctor CLI, and docs match the contract. Full `bun test` green.

#### 7.1 Concurrency / lifecycle tests — `test/unit/control-plane/cas-race.test.ts`, `test/integration/commands/prompt-queue.test.ts`

- [ ] Two `answerPrompt` writers (terminal vs `control-plane`) on sqlite: one winner; loser payload equals winner.
- [ ] TTY handler + injected store writer: handler exit 0, envelope is the stored winner even if TTY later produces a line; stdin and poll both aborted.
- [ ] `--timeout 50` TTY with no input: `PROMPT_TIMEOUT` exit 3, row abandoned `timeout`; stdin listeners gone.
- [ ] **Required real-process SIGINT test** (not unit-only): `Bun.spawn` the CLI (`5X_FORCE_TTY=1`) in a temp project with a migrated DB; keep stdin open so the prompt waits; poll SQLite until the open `prompts` row exists; `proc.kill("SIGINT")`; assert exit code **130**, stdout error envelope `INTERRUPTED`, and `abandon_reason = 'interrupted'` (and `abandoned_at` set) on that row. Do not accept a fake-`readLine` unit test as a substitute for this gate.
- [ ] **Required real-process SIGTERM test** (not unit-only): same setup as SIGINT; `proc.kill("SIGTERM")`; assert exit code **143**, stdout error envelope `TERMINATED`, and `abandon_reason = 'interrupted'` (and `abandoned_at` set) on that row. Proves the lifecycle signal is in the race (stdin has no SIGTERM listener). Do not accept an injected-abort unit test as a substitute.
- [ ] Second SIGINT while abandoning: process still exits 130 (force path); no hang.
- [ ] no-TTY `input` hanging pipe + `--timeout`: CLI exits `PROMPT_TIMEOUT`; row abandoned `timeout`.
- [ ] no-TTY `input` hanging pipe + control-plane `answerPrompt`: waiter exits 0 with stored `{ input }`.
- [ ] Doctor integration: seed orphaned prompt in temp project; `5x doctor` JSON contains `PROMPT_ORPHANED`; `5x doctor --fix` lists it under `fixed` and re-run is clean.
- [ ] `5x run watch` SIGINT still exits as today (do not force 130 after a clean watch abort).

#### 7.2 Docs

- [ ] `docs/v2/202-control-plane.md`: mark store/schema/polling TODOs resolved for this slice; record `--default` precedence, 250ms poll, abandonment, nullable `run_id`, no `decisions` table. Leave dashboard/server TODOs.
- [ ] `docs/v2/203-recovery-and-doctor.md`: prompts check is implemented (fail + `--fix` abandon); drop “deferred” on the table row; status line ~10.
- [ ] `docs/v1/101-cli-primitives.md` §7: persist-then-wait; terminal and control-plane are CAS writers; `--run` / `--timeout` (strict integer parse, applies to TTY and no-TTY `input` pipe); success envelopes unchanged; no-TTY `--default` immediate; no-TTY choose/confirm no-default still `NON_INTERACTIVE` after abandon; Ctrl-C CAS-abandons `interrupted` then exits 130; SIGTERM CAS-abandons `interrupted` then exits 143 (`TERMINATED`).
- [ ] `docs/v2/200-overview.md` §3.2: one sentence that the prompt queue is implemented locally via `PromptStore`.
- [ ] `docs/v2/plan-inputs/03-prompt-queue-foundation.plan-input.md`: set **Generated plan** to this file; status `planned`.
- [ ] `src/index.ts`: export `PromptStore`, `PromptRecord`, `createSqlitePromptStore`, `createMemoryPromptStore`, CAS types.

#### 7.3 AGENTS.md / doctor order

If `5x-cli/AGENTS.md` lists the five doctor checks, add `prompts`. Registry comment “five builtins” in 203 docs already updated in 7.2.

---

## Files Touched

| File | Change |
|------|--------|
| `src/cli-lifecycle.ts` | **New** — process SIGINT/SIGTERM owner; abort-without-exit; `getCliAbortCause()`; grace/second-signal force-exit |
| `src/bin.ts` | `installCliLifecycle()` before `parseAsync`; `disarmCliLifecycle()` in `finally` |
| `src/db/connection.ts` | Remove SIGINT/SIGTERM `process.exit`; keep idempotent `exit` → `closeDb` |
| `src/lock.ts` | `registerLockCleanup`: remove SIGINT/SIGTERM `process.exit`; keep `exit` → release |
| `src/db/schema.ts` | Migration 6: `prompts` table + indexes + abandon-pair CHECKs |
| `src/control-plane/ids.ts` | **New** — `createPromptId()` |
| `src/control-plane/types.ts` | **New** — records, CAS result, enums |
| `src/control-plane/store.ts` | **New** — `PromptStore` |
| `src/control-plane/sqlite-store.ts` | **New** — SQLite impl |
| `src/control-plane/memory-store.ts` | **New** — test impl |
| `src/control-plane/wait.ts` | **New** — poll helper + constants |
| `src/control-plane/index.ts` | **New** — factory re-exports |
| `src/utils/stdin.ts` | `AbortSignal` + `ABORTED`; `readAll` SIGINT sentinel; abortable `readStdinPipe` |
| `src/commands/prompt-context.ts` | **New** — `defaultResolvePromptContext()` (`store` + `runExists` over one DB) |
| `src/commands/prompt.ts` | `--run`, `--timeout` via `intArg`; inject `resolveContext` |
| `src/commands/prompt.handler.ts` | Persist, CAS, dual-abort race with lifecycle fan-in, pipe race, `runExists`; optional deps |
| `src/output.ts` | `PROMPT_TIMEOUT` → exit 3; `TERMINATED` → exit 143 |
| `src/doctor/checks/prompts.ts` | **New** — orphan detect/fix |
| `src/doctor/registry.ts` | Register check; `findingKey` `PROMPT_ORPHANED` |
| `src/index.ts` | Export control-plane types/factories |
| `test/unit/cli-lifecycle.test.ts` | **New** — first/second SIGINT/SIGTERM, cause, grace, disarm, idempotency |
| `test/unit/db/connection.test.ts` | SIGINT does not `process.exit`; connection stays open |
| `test/unit/db/schema.test.ts` | Expect version 6 |
| `test/unit/db/schema-v4.test.ts` | Expect version 6 |
| `test/unit/db/schema-v6.test.ts` | **New** — including abandon-pair CHECKs |
| `test/unit/control-plane/store-contract.test.ts` | **New** |
| `test/unit/control-plane/cas-race.test.ts` | **New** |
| `test/unit/control-plane/wait.test.ts` | **New** — including abort stops further polls |
| `test/unit/utils/stdin-abort.test.ts` | **New** — `ABORTED` vs EOF/SIGINT; `readAll` SIGINT sentinel; pipe abort |
| `test/unit/commands/prompt-store.test.ts` | **New** — dual-abort race, lifecycle SIGTERM, pipe timeout/store-win, `runExists`, timeout validation, multiline SIGINT |
| `test/unit/commands/prompt-context.test.ts` | **New** — factory returns store + `runExists` over one DB; missing run is false |
| `test/unit/doctor/prompts.test.ts` | **New** |
| `test/unit/doctor/registry.test.ts` | Sixth check; `findingKey` |
| `test/integration/commands/prompt.test.ts` | Temp cwd; persistence + invalid timeout + `--run` + pipe timeout/store-win |
| `test/integration/commands/prompt-queue.test.ts` | **New** — timeout/doctor/CAS CLI + **required** real-process SIGINT and SIGTERM |
| `test/integration/commands/doctor.test.ts` | Orphan `--fix` case if not in prompt-queue file |
| `docs/v2/202-control-plane.md` | Resolve in-slice TODOs |
| `docs/v2/203-recovery-and-doctor.md` | Prompts check shipped |
| `docs/v1/101-cli-primitives.md` | Contract shift; Ctrl-C / SIGTERM abandon |
| `docs/v2/200-overview.md` | Prompt queue implemented locally |
| `docs/v2/plan-inputs/03-prompt-queue-foundation.plan-input.md` | Generated-plan pointer |

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `schema-v6.test.ts` | v6 DDL, indexes, FK, CHECKs (answered triple, abandon pair, mutex), v5→v6 |
| Unit | `store-contract.test.ts` | create/get/list/CAS/abandon on SQLite **and** memory |
| Unit | `cas-race.test.ts` | Parallel first-writer-wins; loser sees winner |
| Unit | `wait.test.ts` | Poll, timeout, abort, abandon; abort stops further polls |
| Unit | `stdin-abort.test.ts` | `ABORTED` vs EOF/SIGINT; `readAll` SIGINT sentinel (not partial text); `readStdinPipe` abort |
| Unit | `cli-lifecycle.test.ts` | First SIGINT/SIGTERM aborts without exit and records cause; second/grace force-exit 130/143; disarm; idempotent cleanup |
| Unit | `connection` signal tests | `getDb` / `registerLockCleanup` do not `process.exit` on SIGINT; DB stays open |
| Unit | `prompt-store.test.ts` | Handler persist/CAS/dual-abort race, lifecycle SIGTERM, pipe timeout/store-win, `runExists`, timeout validation before insert, multiline SIGINT |
| Unit | `prompt-context.test.ts` | Default factory: one DB, `runExists` true/false, store usable |
| Unit | `doctor/prompts.test.ts` | Orphan detect/fix; null run_id skipped; missing DB |
| Unit | `doctor/registry.test.ts` | Check order; `PROMPT_ORPHANED` identity |
| Integration | `prompt.test.ts` | Existing CLI envelopes/exits on a temp project + DB rows + invalid timeout + `--run` + pipe timeout/store-win |
| Integration | `prompt-queue.test.ts` | Timeout, doctor `--fix`, CAS CLI, **required real-process SIGINT (130)** and **SIGTERM (143 + `abandon_reason='interrupted'`)** |
| Integration | `doctor.test.ts` | Sweep still green; optional orphan case |

---

## Not In Scope

- **Dashboard HTTP/WebSocket/UI/auth** — `04-control-plane-dashboard.plan-input.md`. That slice must call `answerPrompt`, not raw SQL.
- **`decisions` table** — answered prompts + `human:*` steps.
- **Review-budget schema** — `06-review-budget-advisory.plan-input.md`.
- **Remote/synced `PromptStore`** — preserve interface only.
- **Provider cancellation / invocation registry** — `05-invocation-registry.plan-input.md`.
- **Ambient `--run` filling** — 204; this slice never calls the ambient resolver.
- **Changing success JSON keys** or adding `prompt_id` to envelopes.
- **Hanging CI** on no-TTY without `--default` (keep fail-fast after persist+abandon).
- **Auto-deleting prompt rows** — abandon in place for audit.

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Schema v6 + tests (including abandon-pair CHECKs) | 0.5–1 day |
| 2 | PromptStore + SQLite + memory + CAS contract tests | 1–2 days |
| 3 | Doctor prompts check + `findingKey` | 1 day |
| 4 | CLI signal lifecycle (strip `process.exit` from db/lock; abort cause) | 1 day |
| 5 | Abortable stdin/pipe + wait helper (both-branch cancel, `readAll` SIGINT) | 1 day |
| 6 | Prompt command integration + lifecycle race + pipe race + `runExists` + timeout validation + temp-dir CLI tests | 2–2.5 days |
| 7 | Race/timeout/real-process SIGINT+SIGTERM/docs/exports | 1–2 days |
| **Total** | | **7.5–10.5 days** |

Phase 4 is a P0 prerequisite to Phase 6 interrupt-abandonment. Phase 5 remains a schedule risk (TTY/pipe cancellation): if `AbortSignal` cannot stop `readLine` or `readStdinPipe` cleanly, do not start Phase 6 TTY/pipe racing. Phase 7’s real-process SIGINT **and** SIGTERM tests are hard gates, not optional.

---

## Revision History

### 1.2 — August 24, 2026

Addresses P1.3, P1.4, and P1.5 in the **Addendum (2026-08-24) — Revision 1.1 re-review** of [`docs/development/reviews/5x-cli-docs-development-plans-205-prompt-queue-foundation-plan-review.md`](../reviews/5x-cli-docs-development-plans-205-prompt-queue-foundation-plan-review.md). Prior P0.1 / P1.1 / P1.2 / P2.1 remain as specified in 1.1.

**P1.3 — Lifecycle abort in every prompt race.** Phase 6 fans `getCliAbortSignal()` into both the stdin/pipe and poll controllers. SIGTERM (which never reaches the stdin listener) therefore CAS-abandons before the grace force-exit. Durable mapping: `abandon_reason = 'interrupted'` for both SIGINT and SIGTERM; envelopes/exits are `INTERRUPTED`/130 vs `TERMINATED`/143 via `getCliAbortCause()`. Phase 7 requires a real-process SIGTERM test (exit 143 + abandoned row).

**P1.4 — Piped input is in the wait race.** no-TTY `input` no longer `await readStdinPipe()` outside the race. `readStdinPipe` takes `AbortSignal`; `--timeout` and control-plane CAS apply; tests cover hanging-pipe timeout and store-wins-pipe.

**P1.5 — `runExists` on a prompt context.** New `PromptCommandContext` (`store` + `runExists`) from `defaultResolvePromptContext()` over one `resolveDbContext` DB. Handlers never call `getRunV1` or import `bun:sqlite`. Unit tests inject `runExists`; unknown `--run` creates no row.

### 1.1 — August 24, 2026

Addresses P0.1, P1.1, P1.2, and P2.1 in [`docs/development/reviews/5x-cli-docs-development-plans-205-prompt-queue-foundation-plan-review.md`](../reviews/5x-cli-docs-development-plans-205-prompt-queue-foundation-plan-review.md) (no addendums; P0.1 was `human_required` and is resolved here by the CLI-lifecycle decision).

**P0.1 — SIGINT ownership.** Centralize signal handling at the CLI lifecycle (`src/cli-lifecycle.ts` installed from `src/bin.ts`). First SIGINT aborts in-flight work without exiting so an active prompt can CAS-abandon `interrupted` while SQLite is open; then release locks, close the DB, emit `INTERRUPTED`, and exit 130. Second SIGINT or `CLI_SIGINT_GRACE_MS` force-exits. `getDb` and `registerLockCleanup` keep idempotent `process.on("exit")` cleanup and lose `process.exit` on SIGINT/SIGTERM. Phase 7 requires a real-process test: spawn CLI, interrupt an active DB-backed prompt, assert exit 130 and `abandon_reason = 'interrupted'`.

**P1.1 — Cancel both race branches; multiline SIGINT.** Every stdin/poll/timeout `Promise.race` aborts **both** losers in `finally`. `readAll` SIGINT resolves the `SIGINT` sentinel (not partial text) and maps to `interrupted`. Tests cover timeout cleanup, terminal-win poll cleanup, store-win read cleanup, and multiline SIGINT.

**P1.2 — Abandonment-pair integrity.** Migration 6 CHECK makes `(abandoned_at, abandon_reason)` all-or-nothing and keeps those columns null on answered/open rows, in addition to the existing answered-vs-abandoned mutex. Schema tests cover the invalid combinations.

**P2.1 — Timeout validation.** `--timeout` and `FIVEX_PROMPT_TIMEOUT_MS` are parsed with `parseIntArg` / `intArg` (finite, non-negative integer, full-string match) **before** `createPrompt`. Commander `parseInt` is not used.

---

## Provenance

Implements v2 area #2’s **prompt-queue foundation** (`docs/v2/202-control-plane.md`) from plan input `docs/v2/plan-inputs/03-prompt-queue-foundation.plan-input.md`, and completes the orphaned-prompt doctor check deferred by `203-recovery-and-doctor-plan.md` / `docs/v2/203-recovery-and-doctor.md`. Honors `200` §3a: store interface, UUID prompt ids, CAS first-writer-wins, control plane as source of truth. Suggested next slice: `04-control-plane-dashboard.plan-input.md` (authenticated server + CAS answer endpoint over this repository).
