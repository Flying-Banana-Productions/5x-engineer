# Prompt-Queue Foundation — Durable UUID Prompts, CAS Answers, Doctor Hygiene

**Version:** 1.0
**Created:** August 24, 2026
**Status:** Draft — pending staff engineer review

---

## Executive Summary

`5x prompt choose` / `confirm` / `input` today block on the calling TTY and never persist. v2 inverts that: every invocation writes a UUID-keyed open row to the control-plane store, then waits. The terminal, a `--default` writer, and (later) the dashboard are symmetric CAS writers; first writer wins and losers observe the stored answer. This slice lands the repository, schema, polling/abandonment contract, prompt-command integration, and the orphaned-prompt doctor check deferred from area 203. It does not ship HTTP, UI, budget tables, or provider cancellation.

### Scope

**In scope:**

- `prompts` table (schema v6), UUID ids, open/recent indexes, SQLite repository plus an in-memory test implementation.
- `PromptStore` contract: `createPrompt`, `getPrompt`, `listOpenPrompts`, `answerPrompt` (CAS), `abandonPrompt` (CAS).
- Bounded poll loop, timeout/interrupt/EOF abandonment, terminal vs store race with cancellable stdin.
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
| **no-TTY + `--default` CAS-es immediately** | Preserves CI. TTY waits; a store writer can still win. no-TTY without default stays fail-fast `NON_INTERACTIVE` after persist+abandon. |
| **Cancellable `readLine` via `AbortSignal`** | When a store writer wins, the pending TTY read must stop. Spike this before wiring the race. |
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
7. [Phase 4: Cancellable stdin and poll helper](#phase-4-cancellable-stdin-and-poll-helper)
8. [Phase 5: Prompt command integration](#phase-5-prompt-command-integration)
9. [Phase 6: Concurrency, CLI compatibility, and docs](#phase-6-concurrency-cli-compatibility-and-docs)
10. [Files Touched](#files-touched)
11. [Tests](#tests)
12. [Not In Scope](#not-in-scope)
13. [Estimated Timeline](#estimated-timeline)
14. [Provenance](#provenance)

---

## Overview

Human gates are ephemeral TTY reads. v2 makes them durable control-plane records so a future dashboard (and tests today) can answer through the same atomic CAS as the terminal.

**Current behavior:**

- `promptChoose` / `promptConfirm` / `promptInput` (`src/commands/prompt.handler.ts:61–258`) validate flags, then either return `--default` on non-TTY, error `NON_INTERACTIVE`, or block on `readLine` / `readAll` / `readStdinPipe`.
- Success envelopes are `{ choice }`, `{ confirmed }`, `{ input }` (`test/integration/commands/prompt.test.ts`). Error codes: `INVALID_OPTIONS`, `INVALID_DEFAULT`, `NON_INTERACTIVE` (exit 3), `EOF` (exit 3), `INTERRUPTED` (exit 130).
- No prompt table. Schema max is v5 (`src/db/schema.ts:402–417`; `test/unit/db/schema.test.ts` asserts version `5`).
- `5x prompt` does not open a DB (`registerPrompt` at `src/commands/prompt.ts:14` only forwards message/options/default).
- Doctor registry has five checks (`src/doctor/registry.ts:15–21`). `findingKey` has no prompt case (`src/doctor/registry.ts:77–107`). Area 203 defers `prompts` (`docs/v2/203-recovery-and-doctor.md:83`).
- Run ids are `run_` + 12 hex chars (`src/run-id.ts:9–11`), unique enough as FK values. Prompt ids must be full UUIDs (`200` §3a constraint #2).

**New behavior:**

- Every prompt command resolves a DB via `resolveDbContext`, creates an open `prompts` row (UUID), then waits or CAS-es.
- Terminal, `--default`, and test/control-plane writers call one `answerPrompt`. Exactly one write succeeds; losers receive the stored winning answer and still emit the existing success envelope.
- no-TTY + `--default`: persist, CAS immediately with `answered_by = 'default'`. no-TTY + no default: persist, abandon (`non-interactive`), `NON_INTERACTIVE`.
- TTY: persist, render as today, race cancellable stdin against a 250ms poll. Store win aborts the TTY read. Interrupt/EOF abandon then existing errors (EOF may still apply default when `--default` is set).
- `5x doctor` reports `PROMPT_ORPHANED` for open rows whose `run_id` points at `completed` or `aborted`; `--fix` abandons with reason `run-terminal`.

**Prerequisites:**

- [`203-recovery-and-doctor-plan.md`](./203-recovery-and-doctor-plan.md) — complete enough to register the deferred check (`builtinDoctorChecks`, `findingKey`, `--fix` re-detect).
- Slice 204 (ambient run identity) is **not** required. This slice must not call `resolveAmbientRunId` (`204` plan: workers/commands pass explicit `run_id`).

---

## Design Decisions

**Command logic depends on `PromptStore`, never on `bun:sqlite`.** `202` §3.1 and `200` §3a#1. Put the interface in `src/control-plane/store.ts`. SQLite SQL lives only in `src/control-plane/sqlite-store.ts`. Do not add prompt functions to `src/db/operations-v1.ts` for handlers to call. Handlers receive a store from a factory used after `resolveDbContext`.

**Answered prompts are the request/answer log; do not add `decisions`.** `202` §3.2 lean and the plan-input assumption. Unsolicited abort/reopen/override stay `human:*` steps (`202` §3.4). Revisit only if a later spike proves this insufficient.

**`run_id` is a nullable FK.** `REFERENCES runs(id)` without `NOT NULL`. Standalone `5x prompt choose` (skills, ad-hoc) keeps working. Optional `--run <id>`: if set, `getRunV1` must find the row or error `RUN_NOT_FOUND`; do not invent ambient resolution. Doctor orphans only rows with a non-null `run_id` whose run status is not `active`.

**Abandonment is first-class.** Columns `abandoned_at` and `abandon_reason` (`timeout` \| `interrupted` \| `eof` \| `non-interactive` \| `run-terminal`). Open means both answer and abandon timestamps are null. `answerPrompt` and `abandonPrompt` are both `UPDATE … WHERE id = ? AND answered_at IS NULL AND abandoned_at IS NULL`. A human answer must never be encoded as an abandon, and `--fix` must never invent `{ choice }` / `{ confirmed }` / `{ input }`.

**`--default` + no-TTY is immediate CAS, not a poll.** Matches `202` §3.3 recommendation and existing CI (`prompt.handler.ts:84–87`, `:177–180`). TTY still waits so a test/control-plane writer can win. no-TTY without `--default` stays fail-fast (do not hang CI): persist, abandon `non-interactive`, same `NON_INTERACTIVE` envelope/exit 3. Opt-in wait via `--timeout <ms>` (and `FIVEX_PROMPT_TIMEOUT_MS`) for tests and the future dashboard.

**Poll cadence is a constant 250ms with no backoff.** Local SQLite reads are cheap (`202` example 250–500ms). TTY default wall-clock timeout is none (today’s unbounded wait). `--timeout` applies to TTY and to no-TTY-without-default when set.

**Success envelopes stay `{ choice }`, `{ confirmed }`, `{ input }`.** Do not add `prompt_id` in this slice. Losing CAS still prints the winning answer in that shape so agents do not see a new contract. Validation errors (`INVALID_OPTIONS`, `INVALID_DEFAULT`) still fire **before** insert.

**Cancellable stdin is a hard prerequisite to the TTY/store race.** Extend `readLine` / `readAll` (`src/utils/stdin.ts:102–196`) with `AbortSignal`. On abort, remove listeners and resolve a new `ABORTED` sentinel (do not reuse `EOF`/`SIGINT`). If the spike fails, stop Phase 5 TTY racing and escalate — do not ship a dangling `readLine`.

**Doctor `--fix` is safe here.** Unlike lingering runs (warn-only, `fixable: false`, `src/doctor/checks/runs.ts:92–107`), an open prompt on a terminal run cannot be answered usefully. `--fix` calls `abandonPrompt(..., 'run-terminal')`. Finding identity is `detail.promptId` via a new `findingKey` case; `fixable: true` without identity must keep throwing.

**Prompt commands always persist, so they always open the control-plane DB.** Call `resolveDbContext` (`src/commands/context.ts:82–149`) like other mutating commands. `getDb` may create `.5x/5x.db`. Integration tests that currently spawn without `cwd` (`test/integration/commands/prompt.test.ts`) **must** move to temp projects (pattern: `test/integration/commands/doctor.test.ts:19–62`) so they do not write the repo database.

**Test writers are first-class `PromptStore` clients.** Shared contract tests run against `SqlitePromptStore` and `MemoryPromptStore`. Handler unit tests inject `MemoryPromptStore` plus fake clock/sleep/stdin. Do not change command behavior to special-case tests.

---

## Architecture Overview

```
  5x prompt choose|confirm|input
           │
           ├─ validate flags (unchanged)
           ├─ resolveDbContext() → PromptStore
           ├─ createPrompt({ uuid, runId?, kind, message, options, default })
           │
           ├─ no-TTY + --default ──► answerPrompt(..., "default") ──► envelope
           ├─ no-TTY, no default, no --timeout
           │         └─ abandonPrompt(..., "non-interactive") ──► NON_INTERACTIVE
           │
           └─ TTY (or --timeout wait)
                     │
                     ├─ render prompt (stderr /dev/tty) as today
                     ├─ race: abortable readLine  vs  poll getPrompt every 250ms
                     │
                     ├─ TTY wins ──► answerPrompt(..., "terminal")
                     │                 lost CAS ──► use stored answer
                     ├─ store wins ──► abort TTY ──► stored answer
                     ├─ SIGINT ──► abandon interrupted ──► INTERRUPTED
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
- CHECK: cannot set `answered_at` without `answer`/`answered_by`; cannot set both answered and abandoned.

- [ ] Update version-5 assertions to 6.
- [ ] Add `test/unit/db/schema-v6.test.ts` covering table, indexes, FK, CHECKs, v5→v6.

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

## Phase 4: Cancellable stdin and poll helper

**Completion gate:** `readLine`/`readAll` honor `AbortSignal`; `waitForPromptAnswer` returns on store answer, timeout, or abort. No CLI wiring yet.

#### 4.1 Stdin — `src/utils/stdin.ts`

Add `export const ABORTED = Symbol("ABORTED");`.

```typescript
export function readLine(
  signal?: AbortSignal,
): Promise<string | typeof EOF | typeof SIGINT | typeof ABORTED>;
```

If `signal?.aborted` already, resolve `ABORTED`. On `abort`, `cleanup()` and resolve `ABORTED` (do not treat as EOF). Same for `readAll`. Existing tests without a signal must be unchanged.

- [ ] Unit tests: abort before wait → `ABORTED`; abort mid-wait → `ABORTED` and listeners removed; no signal → current EOF/line behavior.

#### 4.2 Wait helper — `src/control-plane/wait.ts`

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

---

## Phase 5: Prompt command integration

**Completion gate:** All three commands persist before waiting. `--default` CI path unchanged. TTY races store vs terminal. Interrupt/EOF abandon. Existing success envelopes unchanged. Integration tests run in temp dirs.

#### 5.1 Adapter flags — `src/commands/prompt.ts`

Add to `choose`, `confirm`, and `input`:

```typescript
.option("--run <id>", "Associate this prompt with a run id")
.option("--timeout <ms>", "Max wait in ms (TTY: unbounded if omitted; no-TTY without --default: 0)", parseInt)
```

Pass `run` / `timeout` into handlers. Do not add `--run` as required.

#### 5.2 Handler deps and shared flow — `src/commands/prompt.handler.ts`

```typescript
export interface PromptHandlerDeps {
  store?: PromptStore;
  resolveStore?: () => Promise<PromptStore>; // default: resolveDbContext + createSqlitePromptStore
  isTTY?: () => boolean;
  readLine?: typeof readLine;
  readAll?: typeof readAll;
  readStdinPipe?: typeof readStdinPipe;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
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

Default `resolveStore`: `resolveDbContext()` then `createSqlitePromptStore(ctx.db)`. Unit tests pass `store: createMemoryPromptStore()`.

Shared sequence after existing validation (`INVALID_OPTIONS` / `INVALID_DEFAULT` **before** create):

1. Optional `run`: `getRunV1`; missing → `outputError("RUN_NOT_FOUND", ...)`.
2. `createPrompt({ runId, kind, message, options, defaultValue })`.
3. Branch:
   - **no-TTY + default (choose/confirm):** `answerPrompt(id, normalized, "default")`; `outputSuccess` from `result.prompt` (winner’s answer if CAS lost).
   - **no-TTY, no default, timeout 0/omitted:** `abandonPrompt(id, "non-interactive")`; `outputError("NON_INTERACTIVE", ...)` same message as today (`:89–92`, `:182–185`).
   - **no-TTY input + pipe:** persist, `readStdinPipe()`, `answerPrompt(..., "terminal")` (pipe is a local writer, not `--default`).
   - **TTY or positive timeout:** render as today; `AbortController`; `Promise.race` wait helper vs abortable `readLine`/`readAll`.
     - Store answered: `controller.abort()`; map stored answer to envelope.
     - TTY value: `answerPrompt(..., "terminal")`; if `ok: false` and the row is answered, still success from stored answer; if abandoned, map reason to `INTERRUPTED` / `EOF` / timeout error.
     - `SIGINT`: abandon `interrupted`; `INTERRUPTED`.
     - `EOF`: if default, CAS `"default"` (today’s EOF+default); else abandon `eof`; `EOF`.
     - `PromptTimeoutError`: abandon `timeout`; new code `PROMPT_TIMEOUT` (exit 3, add to `EXIT_CODE_MAP` in `src/output.ts:50–71`). Only reachable with `--timeout` / env on TTY, or no-TTY wait opt-in.

Envelope mappers (keep exact keys):

| Kind | Stored `answer` | Success data |
|------|-----------------|--------------|
| choose | option string | `{ choice }` |
| confirm | `"true"` / `"false"` | `{ confirmed: boolean }` |
| input | text | `{ input }` |

`try/finally`: if the function is about to throw/`outputError` and the row is still open, abandon with the matching reason so doctor is not required for the happy-path failure.

#### 5.3 Env override

Read `FIVEX_PROMPT_TIMEOUT_MS` when `--timeout` is omitted. Document in 101. Tests can set a short wait without new argv in every case.

#### 5.4 Handler unit tests — `test/unit/commands/prompt-store.test.ts`

Inject memory store + fake TTY/sleep:

- [ ] Choose `--default` no-TTY: one open-then-answered row, `answeredBy === "default"`, stdout `{ choice }`.
- [ ] Choose no-TTY no default: abandoned `non-interactive`, `NON_INTERACTIVE`.
- [ ] Invalid default: no row created.
- [ ] Parallel: create via handler TTY path (fake `readLine` that never resolves until abort); second task `answerPrompt(..., "control-plane")`; handler returns the control-plane answer; `readLine` was aborted.
- [ ] `--run` unknown: `RUN_NOT_FOUND`, no row.
- [ ] Confirm/input equivalent persist+CAS.

#### 5.5 Integration tests — rewrite `test/integration/commands/prompt.test.ts`

Use temp dir + git init + migrated DB (`doctor.test.ts:49–62`). Spawn with `cwd: dir`. Re-assert every current case (defaults, `NON_INTERACTIVE` exit 3, `INVALID_*`, interactive `5X_FORCE_TTY`, EOF, pipe input). Add:

- [ ] After `--default` success, SQLite has one answered row `answered_by = 'default'`.
- [ ] After `NON_INTERACTIVE`, row is abandoned not open.
- [ ] `--run` + real `createRunV1` sets `run_id`.

---

## Phase 6: Concurrency, CLI compatibility, and docs

**Completion gate:** CAS race, timeout, interrupt, doctor CLI, and docs match the contract. Full `bun test` green.

#### 6.1 Concurrency / lifecycle tests — `test/unit/control-plane/cas-race.test.ts`, `test/integration/commands/prompt-queue.test.ts`

- [ ] Two `answerPrompt` writers (terminal vs `control-plane`) on sqlite: one winner; loser payload equals winner.
- [ ] TTY handler + injected store writer: handler exit 0, envelope is the stored winner even if TTY later produces a line.
- [ ] `--timeout 50` TTY with no input: `PROMPT_TIMEOUT` exit 3, row abandoned `timeout`.
- [ ] SIGINT during TTY: `INTERRUPTED` 130, abandoned `interrupted` (if spawn-signal is flaky, keep this at unit level with fake `readLine` → `SIGINT`).
- [ ] Doctor integration: seed orphaned prompt in temp project; `5x doctor` JSON contains `PROMPT_ORPHANED`; `5x doctor --fix` lists it under `fixed` and re-run is clean.

#### 6.2 Docs

- [ ] `docs/v2/202-control-plane.md`: mark store/schema/polling TODOs resolved for this slice; record `--default` precedence, 250ms poll, abandonment, nullable `run_id`, no `decisions` table. Leave dashboard/server TODOs.
- [ ] `docs/v2/203-recovery-and-doctor.md`: prompts check is implemented (fail + `--fix` abandon); drop “deferred” on the table row; status line ~10.
- [ ] `docs/v1/101-cli-primitives.md` §7: persist-then-wait; terminal and control-plane are CAS writers; `--run` / `--timeout`; success envelopes unchanged; no-TTY `--default` immediate; no-TTY no-default still `NON_INTERACTIVE` after abandon.
- [ ] `docs/v2/200-overview.md` §3.2: one sentence that the prompt queue is implemented locally via `PromptStore`.
- [ ] `docs/v2/plan-inputs/03-prompt-queue-foundation.plan-input.md`: set **Generated plan** to this file; status `planned`.
- [ ] `src/index.ts`: export `PromptStore`, `PromptRecord`, `createSqlitePromptStore`, `createMemoryPromptStore`, CAS types.

#### 6.3 AGENTS.md / doctor order

If `5x-cli/AGENTS.md` lists the five doctor checks, add `prompts`. Registry comment “five builtins” in 203 docs already updated in 6.2.

---

## Files Touched

| File | Change |
|------|--------|
| `src/db/schema.ts` | Migration 6: `prompts` table + indexes |
| `src/control-plane/ids.ts` | **New** — `createPromptId()` |
| `src/control-plane/types.ts` | **New** — records, CAS result, enums |
| `src/control-plane/store.ts` | **New** — `PromptStore` |
| `src/control-plane/sqlite-store.ts` | **New** — SQLite impl |
| `src/control-plane/memory-store.ts` | **New** — test impl |
| `src/control-plane/wait.ts` | **New** — poll helper + constants |
| `src/control-plane/index.ts` | **New** — factory re-exports |
| `src/utils/stdin.ts` | `AbortSignal` + `ABORTED` on `readLine`/`readAll` |
| `src/commands/prompt.ts` | `--run`, `--timeout` |
| `src/commands/prompt.handler.ts` | Persist, CAS, race, abandon; optional deps |
| `src/output.ts` | `PROMPT_TIMEOUT` → exit 3 |
| `src/doctor/checks/prompts.ts` | **New** — orphan detect/fix |
| `src/doctor/registry.ts` | Register check; `findingKey` `PROMPT_ORPHANED` |
| `src/index.ts` | Export control-plane types/factories |
| `test/unit/db/schema.test.ts` | Expect version 6 |
| `test/unit/db/schema-v4.test.ts` | Expect version 6 |
| `test/unit/db/schema-v6.test.ts` | **New** |
| `test/unit/control-plane/store-contract.test.ts` | **New** |
| `test/unit/control-plane/cas-race.test.ts` | **New** |
| `test/unit/control-plane/wait.test.ts` | **New** |
| `test/unit/utils/stdin-abort.test.ts` | **New** |
| `test/unit/commands/prompt-store.test.ts` | **New** |
| `test/unit/doctor/prompts.test.ts` | **New** |
| `test/unit/doctor/registry.test.ts` | Sixth check; `findingKey` |
| `test/integration/commands/prompt.test.ts` | Temp cwd; persistence assertions |
| `test/integration/commands/prompt-queue.test.ts` | **New** — timeout/doctor/CAS CLI |
| `test/integration/commands/doctor.test.ts` | Orphan `--fix` case if not in prompt-queue file |
| `docs/v2/202-control-plane.md` | Resolve in-slice TODOs |
| `docs/v2/203-recovery-and-doctor.md` | Prompts check shipped |
| `docs/v1/101-cli-primitives.md` | Contract shift |
| `docs/v2/200-overview.md` | Prompt queue implemented locally |
| `docs/v2/plan-inputs/03-prompt-queue-foundation.plan-input.md` | Generated-plan pointer |

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `schema-v6.test.ts` | v6 DDL, indexes, FK, CHECKs, v5→v6 |
| Unit | `store-contract.test.ts` | create/get/list/CAS/abandon on SQLite **and** memory |
| Unit | `cas-race.test.ts` | Parallel first-writer-wins; loser sees winner |
| Unit | `wait.test.ts` | Poll, timeout, abort, abandon |
| Unit | `stdin-abort.test.ts` | `ABORTED` vs EOF/SIGINT |
| Unit | `prompt-store.test.ts` | Handler persist/CAS/race with injected store |
| Unit | `doctor/prompts.test.ts` | Orphan detect/fix; null run_id skipped; missing DB |
| Unit | `doctor/registry.test.ts` | Check order; `PROMPT_ORPHANED` identity |
| Integration | `prompt.test.ts` | Existing CLI envelopes/exits on a temp project + DB rows |
| Integration | `prompt-queue.test.ts` | Timeout, doctor `--fix`, optional spawn CAS |
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
| 1 | Schema v6 + tests | 0.5–1 day |
| 2 | PromptStore + SQLite + memory + CAS contract tests | 1–2 days |
| 3 | Doctor prompts check + `findingKey` | 1 day |
| 4 | Abortable stdin + wait helper | 1 day |
| 5 | Prompt command integration + temp-dir CLI tests | 2 days |
| 6 | Race/timeout/interrupt/docs/exports | 1–2 days |
| **Total** | | **6.5–9 days** |

Phase 4 is the schedule risk (TTY cancellation). If `AbortSignal` cannot stop `readLine` cleanly, do not start Phase 5 TTY racing.

---

## Provenance

Implements v2 area #2’s **prompt-queue foundation** (`docs/v2/202-control-plane.md`) from plan input `docs/v2/plan-inputs/03-prompt-queue-foundation.plan-input.md`, and completes the orphaned-prompt doctor check deferred by `203-recovery-and-doctor-plan.md` / `docs/v2/203-recovery-and-doctor.md`. Honors `200` §3a: store interface, UUID prompt ids, CAS first-writer-wins, control plane as source of truth. Suggested next slice: `04-control-plane-dashboard.plan-input.md` (authenticated server + CAS answer endpoint over this repository).
