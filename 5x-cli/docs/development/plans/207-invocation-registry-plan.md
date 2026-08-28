# Invocation Registry — Provider-Neutral Handles, Cancellation Contract, Doctor Hygiene

**Version:** 1.0
**Created:** August 28, 2026
**Status:** Draft — pending staff engineer review

---

## Executive Summary

`5x invoke` today starts a provider-owned session and forgets it. The control plane has no identity for the in-flight call, no truthful cancellation capability, and no way to distinguish “still running” from “the CLI crashed and left a row.” This slice adds a UUID-keyed invocation registry behind a store interface: opaque adapter-owned handles (never a universal PID field), separate cancellation-request / adapter-outcome / terminal-observation columns, invoke registration in a single `try/finally`, a local cancel/status action, and a doctor check that abandons **metadata only**.

Shipped providers (OpenCode, sample, and plugins) report `cancellationSupported: false`. Cancel requests against them are rejected without touching `runs.status`. A synthetic remote test adapter — whose handle is a job id, not a PID — proves that a supported opaque handle receives **exactly one** idempotent cancel and records succeeded/failed. HTTP/UI auth stays owned by slice 04; this slice exports the in-process action 04 will wrap.

### Scope

**In scope:**

- Invocation identity, lifecycle, ownership, timestamps, session/run linkage, capability flags, and terminal outcomes (schema v7).
- Opaque cancellation-handle / adapter contract that can represent local or remote invocations.
- `InvocationStore` (SQLite + memory) with CAS request, CAS terminal, heartbeat, stale listing, and deterministic abandon.
- Register/finalize around `5x invoke` provider execution without changing `AgentProvider` / `AgentSession` or process ownership.
- Client status DTO and authenticated cancel action (CLI + in-process handler; dashboard HTTP only if slice 04 is already in tree).
- Doctor reporting for stale/orphaned registry rows; `--fix` is metadata-only.

**Out of scope:**

- OpenCode SDK patches, child-PID extraction, SIGTERM/SIGKILL, process groups, orphan reaping (`011-provider-process-lifecycle.md` remains historical only).
- Provider-specific production adapters (OpenCode, Codex, Claude, Cursor).
- A daemon/supervisor or any guarantee that unsupported providers can be cancelled.
- Automatic `runs.status` abortion when an invocation is cancelled.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **New `InvocationStore`, not columns on `prompts` or `steps`** | Invocations are coordination state (`207-state-segmentation.md` §2.2). Terminal work is already a step. Mixing them would make doctor cleanup look like history mutation. |
| **No `pid` column; handle is opaque JSON owned by the adapter** | `200` §3a constraint #5. A local PID is one future adapter’s private ref, not the registry contract. Tests use a non-PID remote job id. |
| **Request, adapter outcome, and terminal status are three fields** | Avoids implying cancel succeeded when it was only requested. Client “states” are a derived view. |
| **Unsupported cancel is a hard reject** | Exit criterion: no run-status change, no local `AbortSignal` abort of the in-flight invoke. Truthful capability, not a fake kill. |
| **Heartbeat, not PID liveness, for stale detection** | PID liveness is a local-machine concept (`203` §3). Heartbeat keeps long invokes fresh without baking `isPidAlive` into the registry. |
| **Doctor `--fix` abandons metadata only** | Safe unique repair. Messaging must not claim the provider process was reaped. |
| **Cancel/status workers take explicit ids; no ambient run resolver** | `200` §3.2 / `204` plan: invocation-registry workers must not call `resolveAmbientRunId`. |
| **Dashboard HTTP is a consumer, not this slice’s server** | Slice 04 is the auth/live-status host and is not in tree as of this draft. Export the handler 04 wraps. |

### References

- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — §3.2 workers must pass explicit `run_id`; §3a opaque-handle constraint.
- [`docs/v2/202-control-plane.md`](../../v2/202-control-plane.md) — §3.6 phase-2 cancellation registry (TODOs this slice resolves).
- [`docs/v2/203-recovery-and-doctor.md`](../../v2/203-recovery-and-doctor.md) — doctor `--fix` safety; PID liveness is local-only.
- [`docs/v2/207-state-segmentation.md`](../../v2/207-state-segmentation.md) — invocation registry is coordination state with TTL.
- [`docs/v1/100-architecture.md`](../../v1/100-architecture.md) — `AgentProvider` / `AgentSession` ownership (unchanged).
- [`docs/v1/101-cli-primitives.md`](../../v1/101-cli-primitives.md) — current `5x invoke` contract.
- Plan input: [`docs/v2/plan-inputs/05-invocation-registry.plan-input.md`](../../v2/plan-inputs/05-invocation-registry.plan-input.md).
- Superseded: [`011-provider-process-lifecycle.md`](./011-provider-process-lifecycle.md) — failure analysis only; do not inherit OpenCode PID design.
- Predecessor: [`205-prompt-queue-foundation-plan.md`](./205-prompt-queue-foundation-plan.md) — store/CAS/doctor patterns to copy.
- Follow-on: provider-specific adapters after this contract; fresh OpenCode process-cleanup plan if still needed. Next slice: `06-review-budget-advisory.plan-input.md`.

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Architecture Overview](#architecture-overview)
4. [Phase 1: Types, state view, and adapter contract](#phase-1-types-state-view-and-adapter-contract)
5. [Phase 2: Schema v7](#phase-2-schema-v7)
6. [Phase 3: InvocationStore, SQLite, memory, CAS](#phase-3-invocationstore-sqlite-memory-cas)
7. [Phase 4: Invoke registration lifecycle](#phase-4-invoke-registration-lifecycle)
8. [Phase 5: Cancel/status action, CLI, dashboard seam](#phase-5-cancelstatus-action-cli-dashboard-seam)
9. [Phase 6: Doctor stale-entry check](#phase-6-doctor-stale-entry-check)
10. [Phase 7: Docs and forward-compat notes](#phase-7-docs-and-forward-compat-notes)
11. [Files Touched](#files-touched)
12. [Tests](#tests)
13. [Not In Scope](#not-in-scope)
14. [Estimated Timeline](#estimated-timeline)
15. [Provenance](#provenance)

---

## Overview

v1 providers own process lifecycle (`100-architecture.md` §7.4). v2’s control plane needs a **handle store**, not a supervisor: record that an invocation exists, expose whether cancel is actually supported, and remember what was requested versus what the adapter and the invoke process later observed.

**Current behavior:**

- `invokeAgent` (`src/commands/invoke.handler.ts:174–659`) resolves a run, creates a provider (`:415–432`), starts/resumes a session (`:445–461`), streams (`invokeStreamed` `:126–168`), then `provider.close()` at each exit (`:459`, `:514`, `:528`, `:592`). No registry row. No heartbeat.
- `AgentSession.run` / `runStreamed` already accept `AbortSignal` (`src/providers/types.ts:52–58`). OpenCode maps abort to `AgentCancellationError` (`src/providers/opencode.ts:49–52`, `:307`). That is in-process SDK abort, not a control-plane handle.
- Control-plane store is prompts-only (`src/control-plane/store.ts:14–21`). Schema max is v6 (`src/db/schema.ts:410–449`; `test/unit/db/schema.test.ts:28,40,117,136,166`).
- Doctor has six checks (`src/doctor/registry.ts:16–23`). No invocation check. `findingKey` has no invocation case (`:80–112`).
- `5x invoke` subcommands are only `author` / `reviewer` (`src/commands/invoke.ts:90–186`). `src/bin.ts:90` registers invoke; there is no `dashboard` command (`:90–104`).
- Superseded plan 011 proposed PID files and an OpenCode SDK patch; this slice must not implement that.

**New behavior:**

- Every `5x invoke author|reviewer` that reaches session start writes a UUID invocation row: run/session linkage, provider name, opaque handle, `cancellation_supported`, timestamps. Heartbeats during the stream. `try/finally` always drives the row to `completed`, `failed`, `cancelled`, or leaves it `running` only if the process dies before `finally`.
- Production providers register `cancellationSupported: false` and handle `{ adapter: "none", ref: session.id }`. `5x invoke cancel` rejects with `CANCELLATION_UNSUPPORTED` and does not change `runs.status` or abort the in-flight stream.
- Tests inject a `test-remote` adapter whose `ref` is a job id. One successful CAS request calls `adapter.cancel` once; a second request is a no-op at the store and does not call the adapter again. Outcome is recorded separately from lifecycle status.
- `5x invoke status --id <uuid>` / `--run <id>` returns the client view (seven distinguishable states). Workers pass explicit ids; they must not call `requireAmbientRunId` / `resolveAmbientRunId`.
- `5x doctor` reports `INVOCATION_STALE` for non-terminal rows that are heartbeat-stale **or** whose run is missing/terminal. `--fix` CAS-abandons `stale-metadata` and states that no process was reaped.

**Prerequisites:**

- [`205-prompt-queue-foundation-plan.md`](./205-prompt-queue-foundation-plan.md) — complete (`PromptStore`, schema v6, doctor `findingKey` pattern). Copy its store/CAS/doctor shape; do not extend `PromptStore`.
- [`204-run-context-ergonomics-plan.md`](./204-run-context-ergonomics-plan.md) — complete. Invoke author/reviewer may keep ambient run identity; **new** status/cancel commands must not use it.
- Slice 04 dashboard (`04-control-plane-dashboard.plan-input.md`) — **listed as a dependency but not present** in this tree (`registerDashboard` is absent from `src/bin.ts`). This plan does not block on it. Phase 5 exports the handler 04 will wrap; Phase 5.4 wires HTTP only if `src/commands/dashboard.ts` (or equivalent) exists at implementation time.

---

## Design Decisions

**`InvocationStore` is a sibling of `PromptStore`, in `src/control-plane/`, never `operations-v1.ts`.** Same forward-compat rule as prompts (`200` §3a#1, `202` §3.1): command logic and the future dashboard call the interface; SQL lives only in `invocation-sqlite.ts`. Handlers must not import `bun:sqlite` **in the new cancel/status handler** (mirror `prompt.handler.ts` / `prompt-context.ts`). `invoke.handler.ts` already opens `getDb` (`:232–236`); it may construct the sqlite store from that existing `Database` but must still go through `InvocationStore` methods, not ad-hoc SQL.

**Globally unique invocation ids are RFC 4122 UUIDs.** Add `createInvocationId()` next to `createPromptId()` in `src/control-plane/ids.ts:8–10`. Do not reuse `run_` + 12 hex (`src/run-id.ts`). Constraint #2 (`200` §3a).

**`run_id` is NOT NULL.** Unlike prompts, `5x invoke` always has a resolved run (`invoke.handler.ts:246–255`). FK `REFERENCES runs(id)`. Status/cancel workers that filter by run take explicit `--run` and validate with `runExists` (same pattern as `prompt-context.ts:20`).

**The registry’s universal contract has no PID field.** Table columns, `InvocationRecord`, and `InvocationClientView` must not include `pid`. Durable handle storage is `handle_json TEXT NOT NULL` — a JSON object `{ adapter: string, ref: string }` owned by the adapter. Public client views **omit** `handle`. Schema tests assert `PRAGMA table_info(invocations)` has no `pid` column. A synthetic test handle uses `adapter: "test-remote"` and `ref: "job-<uuid>"`.

**Lifecycle status, cancellation request, and adapter outcome are independent.** Stored `status` is only `running | completed | failed | cancelled | abandoned`. Cancellation adds `cancellation_supported`, `cancellation_requested_at`, `cancellation_requested_by`, `cancellation_outcome` (`succeeded | failed | unsupported | null`), `cancellation_outcome_at`. Terminal observation sets `status` + `terminal_at`. “Cancellation-requested” and “unsupported” are **derived** by `toClientInvocationState` (Phase 1), not extra CHECK values. This is the mitigation for the plan-input risk that registry state implies cancel succeeded when only requested.

**Unsupported providers reject cancel with no side effects on the run or the invoke.** `cancellationSupported: false` (the v2 default for every shipped provider) → `requestInvocationCancellation` returns error `CANCELLATION_UNSUPPORTED`, does not set `requested_at`, does not call any adapter, does not abort `AbortSignal` in the invoke process, does not call `updateRunStatus`. The in-flight invoke continues. Do not “best-effort” abort the local stream — that would be a false guarantee.

**Exactly one adapter cancel per invocation.** `markCancellationRequested` is CAS: `UPDATE … WHERE id = ? AND status = 'running' AND cancellation_requested_at IS NULL AND cancellation_supported = 1`. Winner calls `adapter.cancel(handle)` once, then `recordCancellationOutcome`. Loser returns the stored row and **must not** call the adapter. Calling cancel against an already-terminal row returns the record without an adapter call. Record `outcome = unsupported` only if a supported row’s adapter is missing at cancel time (misconfiguration); that is distinct from the capability flag being false.

**Heartbeat is the stale predicate, not `isPidAlive`.** `INVOCATION_HEARTBEAT_MIN_INTERVAL_MS = 5_000`. `invokeStreamed` rate-limits `store.heartbeat(id)` on events. `INVOCATION_STALE_MS = 15 * 60 * 1000`. Doctor uses `ctx.now` (already on `DoctorCheckContext`, `src/doctor/types.ts:34–35`). A live long invoke stays fresh; a crashed CLI leaves `running` until TTL (or immediately if the run is already terminal/missing). Do not add a `cli_pid` column to “improve” this.

**One registry lifecycle boundary with `try/finally`; do not redesign provider cleanup.** Extract `withInvocationLifecycle` (Phase 4). Register after `startSession`/`resumeSession` succeeds (session id exists). `finally` CAS-marks `failed` if still `running` (normal unwind without a terminal write). Process kill before `finally` is the stale/abandon path. Existing `provider.close()` calls may stay; collapsing them into the same `finally` is allowed only if it does not change close semantics and does not add SIGKILL/PID tracking. Fault-injection tests throw after register, during stream, and after stream — they must not prescribe OpenCode internals.

**Cancel/status commands are workers: explicit ids only.** `5x invoke cancel <invocation-id>` keys by UUID. `5x invoke status` requires `--id <invocation-id>` and/or `--run <run-id>` (explicit `int`/`string` flags, no ambient fill). Do not import `requireAmbientRunId` in the new handler. Invoke author/reviewer keep today’s ambient resolution; they pass the already-resolved `params.run` into `register`.

**Authenticated action = typed actor at the store boundary; HTTP auth is slice 04.** `CancellationActor = "cli" | "control-plane"`. `requestInvocationCancellation` requires a valid actor or throws `INVOCATION_INVALID_ACTOR`. CLI passes `"cli"`. Future dashboard, after verifying the per-process token, passes `"control-plane"`. Do not invent a second token scheme in this slice. If `src/commands/dashboard.ts` exists when Phase 5 is implemented, wire `GET/POST` routes to this handler and reuse 04’s token middleware; otherwise document the contract in `202` and stop.

**Do not auto-abort the run.** Cancelling an invocation is not `5x run complete --status aborted`. Out of scope per plan input. `runs.status` stays untouched.

**Native harness delegations are not registered in this slice.** `202` §3.6 mentions “`5x invoke` (or a native delegation).” Native subagents never enter `invoke.handler.ts`. Leave them for a follow-on after this contract exists. Document that gap in Phase 7.

**OpenCode-specific cancellation is explicitly deferred.** Update `202` §3.6 and `011` (already superseded) so implementers do not “just add SIGKILL.” A new post-v2 OpenCode plan is the handoff, not a phase here.

---

## Architecture Overview

```
  5x invoke author|reviewer                         5x invoke cancel <id>
           │                                                │
           ├─ existing run/template/provider setup          │
           ├─ startSession / resumeSession                  │
           ├─ store.register({ uuid, runId, sessionId,      │
           │     handle, cancellationSupported })           │
           │                                                ├─ requestInvocationCancellation
           ├─ invokeStreamed + heartbeat ──┐                │    actor: "cli" | "control-plane"
           │                               │                │
           │     try / finally             │                ├─ if !supported → CANCELLATION_UNSUPPORTED
           │                               │                │    (no requested_at, no adapter, no run change)
           ├─ markTerminal(completed|      │                ├─ CAS requested_at (once)
           │     failed|cancelled)         │                ├─ adapter.cancel(opaque handle) once
           └─ provider.close() (unchanged) │                └─ recordCancellationOutcome(succeeded|failed)
                                           │
                                           ▼
                              InvocationStore (control plane)
                              SQLite materialization: invocations
                              (UUID, opaque handle_json, no pid)

  5x invoke status --id/--run          5x doctor [--fix]
           │                                    │
           └─ toClientInvocationState           ├─ list non-terminal + stale heartbeat
              running | cancellation-requested  │    OR run missing/terminal
              | cancelled | completed           ├─ INVOCATION_STALE (fixable)
              | failed | abandoned              └─ --fix: CAS abandon stale-metadata
              | unsupported                        (does NOT reap processes)

  Future 04 dashboard (not in this slice unless already present)
           │
           ├─ GET  /api/invocations?run_id=  → list + client view
           ├─ GET  /api/invocations/:id      → client view
           └─ POST /api/invocations/:id/cancel
                auth token → actor "control-plane" → same requestInvocationCancellation
```

**Client state derivation (normative):**

```
abandoned                         → "abandoned"
cancelled                         → "cancelled"
completed                         → "completed"
failed                            → "failed"
running && requested_at != null   → "cancellation-requested"
running && !cancellationSupported → "unsupported"
running && cancellationSupported  → "running"
```

**Lifecycle (stored `status` only):**

```
                  register()
                      │
                      ▼
                  running ──────────────────────────────► abandoned
                   │  ▲                                   (doctor / stale)
                   │  └── cancellation_requested_at
                   │      + outcome succeeded|failed
                   │      (status still running until observed)
                   ├── invoke done ─────────────────────► completed
                   ├── invoke error ────────────────────► failed
                   └── observed AgentCancellationError ─► cancelled
```

A cancel **request** never by itself writes `cancelled`. Adapter success does not write `cancelled`. Only the invoke lifecycle (or a future adapter that can observe remote terminal state — not in this slice) writes terminal statuses other than `abandoned`.

---

## Phase 1: Types, state view, and adapter contract

**Completion gate:** Unit tests pass for `toClientInvocationState`, actor validation types, opaque handle parsing, and the synthetic `test-remote` adapter (allocate job, cancel once, second `cancel` on the adapter is safe but the **action** tests that prove store-level once-only live in Phase 3/5). No schema or CLI changes. No production provider implements `CancellationAdapter`.

#### 1.1 IDs — `src/control-plane/ids.ts`

**File:** `src/control-plane/ids.ts`, lines 1–10

Add `createInvocationId()` identical to `createPromptId()` (`randomUUID()`). Keep both named functions so call sites stay obvious.

```typescript
export function createInvocationId(): string {
  return randomUUID();
}
```

- [ ] Export `createInvocationId` from `src/control-plane/index.ts` and `src/index.ts`.

#### 1.2 Invocation types — new `src/control-plane/invocation-types.ts`

Do **not** cram these into `src/control-plane/types.ts` (prompt-specific). New file:

```typescript
export type InvocationStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned";

export type CancellationActor = "cli" | "control-plane";

export type CancellationOutcome = "succeeded" | "failed" | "unsupported";

export type InvocationAbandonReason = "stale-metadata";

/** Adapter-owned. Never a schema-level pid. */
export interface OpaqueCancellationHandle {
  adapter: string;
  ref: string;
}

export interface InvocationRecord {
  id: string;
  runId: string;
  sessionId: string | null;
  role: "author" | "reviewer";
  providerName: string;
  templateName: string | null;
  handle: OpaqueCancellationHandle;
  cancellationSupported: boolean;
  status: InvocationStatus;
  createdAt: string;
  updatedAt: string;
  cancellationRequestedAt: string | null;
  cancellationRequestedBy: CancellationActor | null;
  cancellationOutcome: CancellationOutcome | null;
  cancellationOutcomeAt: string | null;
  terminalAt: string | null;
  abandonReason: InvocationAbandonReason | null;
}

export type ClientInvocationState =
  | "running"
  | "cancellation-requested"
  | "cancelled"
  | "completed"
  | "failed"
  | "abandoned"
  | "unsupported";

/** Public DTO: no handle, no pid. */
export interface InvocationClientView {
  id: string;
  runId: string;
  sessionId: string | null;
  role: "author" | "reviewer";
  providerName: string;
  templateName: string | null;
  status: InvocationStatus;
  clientState: ClientInvocationState;
  cancellation: {
    supported: boolean;
    requested: boolean;
    requestedBy: CancellationActor | null;
    outcome: CancellationOutcome | "none";
  };
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface RegisterInvocationInput {
  runId: string;
  sessionId?: string | null;
  role: "author" | "reviewer";
  providerName: string;
  templateName?: string | null;
  handle: OpaqueCancellationHandle;
  cancellationSupported: boolean;
  id?: string; // tests only
}

export type InvocationCasResult =
  | { ok: true; invocation: InvocationRecord }
  | { ok: false; invocation: InvocationRecord };

export class InvocationStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InvocationStoreError";
    this.code = code;
  }
}
```

```typescript
// src/control-plane/invocation-view.ts
export function toClientInvocationState(
  record: InvocationRecord,
): ClientInvocationState {
  if (record.status !== "running") return record.status;
  if (record.cancellationRequestedAt) return "cancellation-requested";
  if (!record.cancellationSupported) return "unsupported";
  return "running";
}

export function toClientInvocationView(
  record: InvocationRecord,
): InvocationClientView {
  return {
    id: record.id,
    runId: record.runId,
    sessionId: record.sessionId,
    role: record.role,
    providerName: record.providerName,
    templateName: record.templateName,
    status: record.status,
    clientState: toClientInvocationState(record),
    cancellation: {
      supported: record.cancellationSupported,
      requested: record.cancellationRequestedAt !== null,
      requestedBy: record.cancellationRequestedBy,
      outcome: record.cancellationOutcome ?? "none",
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    terminalAt: record.terminalAt,
  };
}
```

Invariant: `toClientInvocationView` must not spread `handle` and must not add `pid`.

- [ ] Add types + view helpers.
- [ ] Unit-test all seven `clientState` branches, including `running + supported` vs `running + unsupported` vs `running + requested` (requested wins over unsupported if both could apply — requested should be unreachable when `supported` is false because cancel rejects first; still assert requested takes precedence if a record is constructed that way).

#### 1.3 Adapter contract + synthetic remote adapter

**New files:** `src/control-plane/cancellation-adapter.ts`, `src/control-plane/test-remote-adapter.ts` (test adapter may live under `src/` with a `createTestRemoteAdapter()` export used only by tests, matching how `createMemoryPromptStore` is production-exported for tests).

```typescript
export type AdapterCancelResult =
  | { outcome: "succeeded" }
  | { outcome: "failed"; error: string };

export interface CancellationAdapter {
  readonly name: string;
  cancel(handle: OpaqueCancellationHandle): Promise<AdapterCancelResult>;
}

const adapters = new Map<string, CancellationAdapter>();

export function registerCancellationAdapter(
  adapter: CancellationAdapter,
): void {
  adapters.set(adapter.name, adapter);
}

export function getCancellationAdapter(
  name: string,
): CancellationAdapter | undefined {
  return adapters.get(name);
}

/** Tests only — clear the process-local registry. */
export function _resetCancellationAdaptersForTest(): void {
  adapters.clear();
}
```

`createTestRemoteAdapter()`:

- `name = "test-remote"`.
- `allocateJob(): { handle: OpaqueCancellationHandle; signal: AbortSignal }` where `handle.ref` is `job-` + uuid (not a number, not `process.pid`).
- `cancel(handle)` looks up `ref`. Unknown ref → `{ outcome: "failed", error: "unknown handle" }`. Wrong `adapter` field → failed. Known job → `controller.abort()` and `{ outcome: "succeeded" }`.
- Counter `cancelCalls` on the adapter instance for tests.

Production `registerCancellationAdapter` is never called from `bin.ts` or provider factory in this slice.

- [ ] Implement registry + test-remote adapter.
- [ ] Unit tests: non-PID `ref`; unknown handle fails; abort signal fires on success; `handle` JSON has no `pid` key.

---

## Phase 2: Schema v7

**Completion gate:** Fresh DB migrates to 7 with `invocations` table, indexes, CHECKs, FK. `PRAGMA table_info` has no `pid`. v6→v7 is additive (prompts/steps untouched). Existing schema tests that assert “current max version” bump from 6 → 7.

#### 2.1 Migration 7 — `src/db/schema.ts`

**File:** `src/db/schema.ts`, after migration 6 (ends ~line 449). `getMaxKnownSchemaVersion` (`:456–458`) picks this up automatically.

```sql
CREATE TABLE invocations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  session_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('author', 'reviewer')),
  provider_name TEXT NOT NULL,
  template_name TEXT,
  handle_json TEXT NOT NULL,
  cancellation_supported INTEGER NOT NULL CHECK (cancellation_supported IN (0, 1)),
  status TEXT NOT NULL CHECK (
    status IN ('running', 'completed', 'failed', 'cancelled', 'abandoned')
  ),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancellation_requested_at TEXT,
  cancellation_requested_by TEXT CHECK (
    cancellation_requested_by IS NULL
    OR cancellation_requested_by IN ('cli', 'control-plane')
  ),
  cancellation_outcome TEXT CHECK (
    cancellation_outcome IS NULL
    OR cancellation_outcome IN ('succeeded', 'failed', 'unsupported')
  ),
  cancellation_outcome_at TEXT,
  terminal_at TEXT,
  abandon_reason TEXT CHECK (
    abandon_reason IS NULL OR abandon_reason IN ('stale-metadata')
  ),
  CHECK (
    (cancellation_requested_at IS NULL AND cancellation_requested_by IS NULL)
    OR (cancellation_requested_at IS NOT NULL AND cancellation_requested_by IS NOT NULL)
  ),
  CHECK (
    (cancellation_outcome IS NULL AND cancellation_outcome_at IS NULL)
    OR (cancellation_outcome IS NOT NULL AND cancellation_outcome_at IS NOT NULL)
  ),
  CHECK (
    (status = 'running' AND terminal_at IS NULL AND abandon_reason IS NULL)
    OR (status IN ('completed', 'failed', 'cancelled')
        AND terminal_at IS NOT NULL AND abandon_reason IS NULL)
    OR (status = 'abandoned'
        AND terminal_at IS NOT NULL AND abandon_reason IS NOT NULL)
  )
);
CREATE INDEX idx_invocations_run ON invocations(run_id, created_at DESC);
CREATE INDEX idx_invocations_live
  ON invocations(updated_at) WHERE status = 'running';
```

Do not alter `runs` / `steps` / `plans` / `prompts`. Description: `UUID invocations table with opaque handle, cancellation columns, live index`.

- [ ] Append migration 7. Do not add a `pid` column or a process-group column.

#### 2.2 Schema tests

Bump “current version is 6” to 7 in:

- `test/unit/db/schema.test.ts:28,40,117,136,166` (the v999 error string currently says `v6` at `:117`).
- `test/unit/db/schema-v4.test.ts:45,559,563`.
- `test/unit/db/schema-v6.test.ts` assertions that call `runMigrations` and expect 6 (`:58–59`, `:162`). CHECK tests that only need prompts can keep using `runMigrations` (v7 is additive). `getMaxKnownSchemaVersion()` in the v6 file (`:59`) becomes 7.

Add `test/unit/db/schema-v7.test.ts` (copy `migrateUpTo` from `schema-v6.test.ts:23–31`):

- Fresh DB → version 7; table + both indexes; `idx_invocations_live` is partial (`PRAGMA index_list` `partial = 1`).
- v6 DB (migrateUpTo 6, then `runMigrations`) gains `invocations` without dropping `prompts`.
- FK: `run_id` missing from `runs` throws.
- CHECK: requested_at without requested_by fails; outcome without outcome_at fails; `status='running'` with `terminal_at` set fails; `abandoned` without `abandon_reason` fails; `completed` with `abandon_reason` fails.
- `PRAGMA table_info(invocations)` names do **not** include `pid`.
- `handle_json` is NOT NULL.

- [ ] Bump version-6 “current max” assertions to 7.
- [ ] Add `schema-v7.test.ts` covering DDL, indexes, FK, CHECKs, no `pid`, v6→v7.

---

## Phase 3: InvocationStore, SQLite, memory, CAS

**Completion gate:** Shared contract tests pass on SQLite and memory: register/get/list, heartbeat, CAS request (exactly one winner under parallel sqlite writers), CAS terminal, CAS abandon, stale listing. Command handlers still unchanged.

#### 3.1 Store interface — new `src/control-plane/invocation-store.ts`

```typescript
export interface InvocationStore {
  register(input: RegisterInvocationInput): InvocationRecord;
  get(id: string): InvocationRecord | null;
  list(filter?: { runId?: string; status?: InvocationStatus }): InvocationRecord[];
  heartbeat(id: string): InvocationRecord;
  /**
   * CAS: succeed iff still running, supported, and not yet requested.
   * Missing id → InvocationStoreError INVOCATION_NOT_FOUND.
   */
  markCancellationRequested(
    id: string,
    actor: CancellationActor,
  ): InvocationCasResult;
  recordCancellationOutcome(
    id: string,
    outcome: CancellationOutcome,
  ): InvocationRecord;
  /**
   * CAS: succeed iff still running (including cancellation-requested).
   * Abandoned/other terminal → ok: false.
   */
  markTerminal(
    id: string,
    status: "completed" | "failed" | "cancelled",
  ): InvocationCasResult;
  markAbandoned(
    id: string,
    reason: InvocationAbandonReason,
  ): InvocationCasResult;
  /**
   * Non-terminal rows with updatedAt older than olderThanMs, using `nowMs`.
   * Does not inspect PIDs.
   */
  listStale(opts: { olderThanMs: number; nowMs: number }): InvocationRecord[];
}
```

`heartbeat`: `UPDATE invocations SET updated_at = datetime('now') WHERE id = ? AND status = 'running'`. If not running, return current row without error (no-op). Missing id → `INVOCATION_NOT_FOUND`.

Timestamps: SQLite uses `datetime('now')` like prompts (`sqlite-store.ts:106–107`). Memory store copies `utcNow()` from `memory-store.ts:17–19` (`YYYY-MM-DD HH:MM:SS`). `listStale` must parse with the same UTC rule as `parseRunTimestamp` (`src/doctor/checks/runs.ts:47–54`). Export that helper from `runs.ts` **or** move it to `src/db/timestamps.ts` and update `runs.ts` — prefer a tiny shared helper rather than duplicating timezone bugs. If moving, keep `parseRunTimestamp` as a re-export from `runs.ts` so existing tests keep importing it.

- [ ] Add `InvocationStore` interface.
- [ ] Share timestamp parsing; do not treat sqlite `datetime('now')` as local time.

#### 3.2 Implementations

**New:** `src/control-plane/invocation-sqlite.ts`, `src/control-plane/invocation-memory.ts`.

Follow `SqlitePromptStore` / `MemoryPromptStore`: `changes()` for CAS (`sqlite-store.ts:124–136`); clone records in memory (`memory-store.ts:21–26`). `handle_json` round-trips via `JSON.parse` / `JSON.stringify`. Reject register if `handle` is missing `adapter` or `ref`.

`markCancellationRequested` SQL:

```sql
UPDATE invocations
SET cancellation_requested_at = datetime('now'),
    cancellation_requested_by = ?1,
    updated_at = datetime('now')
WHERE id = ?2
  AND status = 'running'
  AND cancellation_supported = 1
  AND cancellation_requested_at IS NULL
```

If `changes() = 0`: load row; missing → `INVOCATION_NOT_FOUND`; else `{ ok: false, invocation }`.

`markTerminal` / `markAbandoned` similarly require `status = 'running'`. Abandoned sets `status`, `abandon_reason`, `terminal_at`, `updated_at`.

- [ ] SQLite + memory implementations.
- [ ] Re-export factories from `src/control-plane/index.ts`.

#### 3.3 Contract tests — new `test/unit/control-plane/invocation-store-contract.test.ts`

Mirror `test/unit/control-plane/store-contract.test.ts:50–53` (memory + sqlite harnesses). `ensureRun` via `createRunV1` like `:39–41`.

Required cases:

- `register` then `get` round-trips UUID, runId, handle `{ adapter, ref }`, `cancellationSupported`, `status: "running"`, null cancel fields.
- UUID matches `/^[0-9a-f]{8}-…$/i`.
- `list({ runId })` filters; other runs excluded.
- `heartbeat` bumps `updatedAt` while running; no-op after terminal.
- CAS `markCancellationRequested`: two sqlite connections (copy `cas-race.test.ts:60–79`) → exactly one `ok: true`.
- Second request returns `ok: false` with the winner’s `requestedBy`.
- Request against `cancellationSupported: false` → `ok: false`, `requested_at` still null (SQL predicate). (The **action** layer maps this to `CANCELLATION_UNSUPPORTED` in Phase 5; store-level is just CAS miss / unsupported predicate.)
- Prefer: if `cancellation_supported = 0`, the UPDATE matches 0 rows. Action tests distinguish “unsupported” from “already requested.”
- `markTerminal('completed')` then `markTerminal('failed')` → second `ok: false`, status stays `completed`.
- `markAbandoned` on running succeeds; on completed fails.
- `listStale` with injected `nowMs`: fresh heartbeat excluded; old `updated_at` included; completed excluded.
- Missing id throws `INVOCATION_NOT_FOUND`.

- [ ] Dual-backend contract tests including parallel CAS.

---

## Phase 4: Invoke registration lifecycle

**Completion gate:** `withInvocationLifecycle` unit tests cover success, thrown error, cancellation error, `finally` when unmarked, and fault injection after register. `invokeAgent` registers around session+stream for sample-provider integration: a successful invoke leaves `completed`; a thrown provider error leaves `failed`. Production register uses `cancellationSupported: false`. `AgentProvider` / `AgentSession` interfaces (`src/providers/types.ts:15–36`) are unchanged.

#### 4.1 Lifecycle helper — new `src/control-plane/invocation-lifecycle.ts`

```typescript
export const INVOCATION_HEARTBEAT_MIN_INTERVAL_MS = 5_000;

export async function withInvocationLifecycle<T>(opts: {
  store: InvocationStore;
  input: RegisterInvocationInput;
  isCancellationError?: (err: unknown) => boolean;
  fn: (ctx: {
    invocation: InvocationRecord;
    heartbeat: () => void;
  }) => Promise<T>;
}): Promise<T> {
  const invocation = opts.store.register(opts.input);
  let lastBeat = 0;
  const heartbeat = () => {
    const now = Date.now();
    if (now - lastBeat < INVOCATION_HEARTBEAT_MIN_INTERVAL_MS) return;
    lastBeat = now;
    opts.store.heartbeat(invocation.id);
  };
  try {
    const result = await opts.fn({ invocation, heartbeat });
    opts.store.markTerminal(invocation.id, "completed");
    return result;
  } catch (err) {
    const cancelled = opts.isCancellationError?.(err) === true;
    opts.store.markTerminal(
      invocation.id,
      cancelled ? "cancelled" : "failed",
    );
    throw err;
  } finally {
    const current = opts.store.get(invocation.id);
    if (current?.status === "running") {
      opts.store.markTerminal(invocation.id, "failed");
    }
  }
}
```

`isCancellationError`: default treats `err` with `name === "AgentCancellationError"` (class is in `src/providers/opencode.ts:49–52`; do not import OpenCode from the control-plane helper — duck-type `name` or move `AgentCancellationError` to `src/providers/errors.ts` **only if** a one-line move is needed; prefer duck-typing to avoid a provider refactor).

Heartbeat no-ops inside `fn` are rate-limited here so `invokeStreamed` can call `heartbeat()` on every event.

If `markTerminal` in `try` succeeds, `finally` sees non-running and does nothing. If `fn` returns without throwing and `markTerminal('completed')` CAS-loses to doctor abandon, leave `abandoned` (do not overwrite).

- [ ] Implement helper. Do not call adapters here.

#### 4.2 `invokeStreamed` heartbeat hook

**File:** `src/commands/invoke.handler.ts`, `invokeStreamed` at lines 126–168.

Add optional `onEvent?: () => void` (or `heartbeat?: () => void`) invoked once per streamed event **before** rendering. Do not change NDJSON or stderr behavior.

- [ ] Add the hook; existing tests that call `invokeStreamed` indirectly still pass.

#### 4.3 Wire `invokeAgent`

**File:** `src/commands/invoke.handler.ts`, provider/session/stream block lines 415–592.

Optional deps (do not require sqlite in tests of the helper):

```typescript
export interface InvokeAgentDeps {
  invocationStore?: InvocationStore;
}
```

After session start (`:445–461`), wrap stream + validate + close-on-success in `withInvocationLifecycle`:

```typescript
const store =
  deps?.invocationStore ?? createSqliteInvocationStore(runDb);
await withInvocationLifecycle({
  store,
  input: {
    runId: params.run,
    sessionId: session.id,
    role,
    providerName,
    templateName: resolved.selectedTemplateName,
    handle: { adapter: "none", ref: session.id },
    cancellationSupported: false,
  },
  fn: async ({ heartbeat }) => {
    runResult = await invokeStreamed(..., heartbeat);
    // existing validation / record-failure / outputSuccess / record
  },
});
```

Place `provider.close()` so it still runs on every path (existing catch + success). Prefer: `try { await withInvocationLifecycle(...) } finally { await provider.close().catch(() => {}) }` around the stream/validate/output section, **without** removing close-before-throw on session-start failure (`:458–460` — session never registered, correct).

Do not pass `opts.signal` tied to registry cancel for unsupported providers.

If `runDb` is used after the block that currently scopes it (`:231–279`), keep the connection open through invoke (it already is via `getDb` singleton). Construct the sqlite invocation store from that same db.

- [ ] Register every successful session start.
- [ ] `cancellationSupported: false` and `adapter: "none"` for all production providers in this slice (including OpenCode and sample).
- [ ] Heartbeat from the stream hook.

#### 4.4 Tests

**New:** `test/unit/control-plane/invocation-lifecycle.test.ts`

- Memory store; `fn` returns → `completed`.
- `fn` throws `Error` → `failed`, error propagates.
- `fn` throws `{ name: "AgentCancellationError" }` → `cancelled`.
- `fn` throws after doctor `markAbandoned` → status stays `abandoned` (CAS loss).
- Fault injection: `fn` throws before any heartbeat; row is `failed` not `running`.
- Heartbeat rate-limit: 100 calls in 1 ms → at most one `updatedAt` change if clock is frozen… simpler: spy on `store.heartbeat` and call the wrapped heartbeat 3 times within 5s → one call (inject a fake `now` if needed, or assert `heartbeat` method call count via wrapping the store).

**New or extend:** `test/unit/commands/invoke-registry.test.ts`

- Inject `MemoryPromptStore`-style memory invocation store into `invokeAgent` **or** test via sample provider integration (sample is fast: `packages/provider-sample/src/index.ts:66–89`).
- Preferred: unit-test by extracting is heavy; integration with sample + sqlite is acceptable here **and** required in Phase 5. For Phase 4, lifecycle unit tests are the gate; add one `invokeAgent` unit/integration: after successful sample invoke, `store.list({ runId })[0].status === "completed"` and `clientState === "unsupported"` (running path is unsupported capability after complete → `completed`).

- [ ] Lifecycle unit tests including fault injection.
- [ ] At least one invoke path writes a `completed` row with `cancellationSupported: false`.

---

## Phase 5: Cancel/status action, CLI, dashboard seam

**Completion gate:** `requestInvocationCancellation` rejects unsupported without mutating run or requested_at; supported synthetic adapter is called exactly once; second cancel is idempotent; invalid actor is rejected. CLI `5x invoke status` / `cancel` integration tests pass. No ambient run resolver in the new handler. If dashboard command exists, authenticated HTTP tests pass; if not, the HTTP contract is documented and the in-process action is the gate.

#### 5.1 Action module — new `src/control-plane/invocation-actions.ts`

This is the **only** cancel mutation entry besides doctor abandon.

```typescript
export const CANCELLATION_UNSUPPORTED = "CANCELLATION_UNSUPPORTED";
export const INVOCATION_NOT_FOUND = "INVOCATION_NOT_FOUND";
export const INVOCATION_INVALID_ACTOR = "INVOCATION_INVALID_ACTOR";

export async function requestInvocationCancellation(opts: {
  store: InvocationStore;
  id: string;
  actor: CancellationActor;
  getAdapter?: typeof getCancellationAdapter;
}): Promise<
  | { ok: true; view: InvocationClientView; adapterCalled: boolean }
  | { ok: false; code: string; message: string; view?: InvocationClientView }
> {
  if (opts.actor !== "cli" && opts.actor !== "control-plane") {
    return { ok: false, code: INVOCATION_INVALID_ACTOR, message: "invalid actor" };
  }
  const record = opts.store.get(opts.id);
  if (!record) {
    return { ok: false, code: INVOCATION_NOT_FOUND, message: `invocation ${opts.id} not found` };
  }
  if (!record.cancellationSupported) {
    return {
      ok: false,
      code: CANCELLATION_UNSUPPORTED,
      message: "cancellation is not supported for this invocation",
      view: toClientInvocationView(record),
    };
  }
  if (record.status !== "running") {
    return { ok: true, view: toClientInvocationView(record), adapterCalled: false };
  }
  const cas = opts.store.markCancellationRequested(opts.id, opts.actor);
  if (!cas.ok) {
    return { ok: true, view: toClientInvocationView(cas.invocation), adapterCalled: false };
  }
  const getAdapter = opts.getAdapter ?? getCancellationAdapter;
  const adapter = getAdapter(cas.invocation.handle.adapter);
  if (!adapter) {
    opts.store.recordCancellationOutcome(opts.id, "failed");
    return {
      ok: true,
      view: toClientInvocationView(opts.store.get(opts.id)!),
      adapterCalled: false,
    };
  }
  const result = await adapter.cancel(cas.invocation.handle);
  opts.store.recordCancellationOutcome(
    opts.id,
    result.outcome === "succeeded" ? "succeeded" : "failed",
  );
  return {
    ok: true,
    view: toClientInvocationView(opts.store.get(opts.id)!),
    adapterCalled: true,
  };
}
```

Normative behavior:

- Unsupported: **do not** `markCancellationRequested`; return `CANCELLATION_UNSUPPORTED`; caller must not touch `runs`.
- Actor missing/invalid: `INVOCATION_INVALID_ACTOR` (auth test).
- Already requested / already terminal: `ok: true`, `adapterCalled: false` (idempotent).
- CAS winner: exactly one `adapter.cancel`.
- Adapter throw: catch, `recordCancellationOutcome(..., "failed")`, still `ok: true` with `outcome: "failed"` (request happened; adapter failed). Do not convert that into run abort.

Also export `getInvocationView(store, id)` and `listInvocationViews(store, { runId })`.

- [ ] Implement actions. No `bun:sqlite`. No `resolveAmbientRunId`.

#### 5.2 Context factory + handler + CLI

**New:** `src/commands/invoke-registry-context.ts` (mirror `prompt-context.ts:14–22`):

```typescript
export async function defaultResolveInvocationContext(opts?: {
  startDir?: string;
}): Promise<{
  store: InvocationStore;
  runExists: (runId: string) => boolean;
}> {
  const { db } = await resolveDbContext({ startDir: opts?.startDir });
  return {
    store: createSqliteInvocationStore(db),
    runExists: (runId) => getRunV1(db, runId) !== null,
  };
}
```

**New:** `src/commands/invoke-registry.handler.ts`

- `invokeStatus({ id?, run?, startDir? }, deps)` — require `id` or `run`; if `run` set, `runExists` or `RUN_NOT_FOUND`; never ambient. Envelope: `{ invocations: InvocationClientView[] }` or single `{ invocation: InvocationClientView }`.
- `invokeCancel({ id }, deps)` — `requestInvocationCancellation({ actor: "cli" })`. Map `CANCELLATION_UNSUPPORTED` / `INVOCATION_NOT_FOUND` through `outputError`. Success: `outputSuccess(view)` plus `adapter_called`.

**File:** `src/commands/invoke.ts`, `registerInvoke` at lines 90–186.

Add sibling subcommands **before** or **after** author/reviewer (not nested under author):

```
5x invoke status --id <uuid>
5x invoke status --run <run_id>
5x invoke cancel <invocation-id>
```

`--run` help text: explicit run id only; do **not** use `AMBIENT_RUN_OPTION_HELP` (`invoke.ts:21`).

**File:** `src/output.ts`, `EXIT_CODE_MAP` at lines 51–75.

Add `CANCELLATION_UNSUPPORTED`, `INVOCATION_NOT_FOUND`, `INVOCATION_INVALID_ACTOR` → exit 1 (default). Optional explicit map entries for documentation.

- [ ] Context factory does one `resolveDbContext`.
- [ ] Handler has no ambient imports (`run-identity.ts`).
- [ ] Register `status` and `cancel` on `5x invoke`.

#### 5.3 Action and CLI tests

**New:** `test/unit/control-plane/invocation-actions.test.ts`

- Invalid actor rejected; `requested_at` unchanged.
- Unsupported: code `CANCELLATION_UNSUPPORTED`; row still `running`; `requested_at` null. Pair with a fake `runs` row that stays `active` (action tests don’t open `runs` — document that invoke-registry handler tests / integration must assert `getRunV1().status === "active"`).
- Synthetic adapter: first cancel `adapterCalled: true`, `outcome: "succeeded"`, `clientState: "cancellation-requested"` (status still `running`).
- Second cancel: `adapterCalled: false`; adapter `cancelCalls === 1`.
- Adapter failure: `outcome: "failed"`; still `running`; `clientState: "cancellation-requested"`.
- Terminal completed: `ok: true`, adapter not called.
- Missing id: `INVOCATION_NOT_FOUND`.

**New:** `test/unit/commands/invoke-registry.test.ts`

- Inject memory store; `status --run` lists; unknown run → `RUN_NOT_FOUND`.
- `cancel` passes `actor: "cli"`.
- Grep/test: handler module source must not import `requireAmbientRunId` / `resolveAmbientRunId` (or a unit test that status without `--run`/`--id` is `INVALID_ARGS` even when `.5x/current-run` exists).

**New:** `test/integration/commands/invoke-registry.test.ts`

- Temp project + sample provider + `5x invoke author …` then `5x invoke status --run <id>` → one row, `client_state: "completed"` (or `unsupported` only while running — after sample returns, `completed`).
- `5x invoke cancel <id>` on that completed sample row → success, no adapter, status unchanged.
- `5x invoke cancel` on a **running** unsupported row: spawn a slow test by injecting a hanging store row via sqlite in the test (do not hang sample): insert `running` + `cancellation_supported=0`, run cancel CLI, expect error envelope `CANCELLATION_UNSUPPORTED`, then `SELECT status FROM runs` still `active`.
- Supported path in integration: insert row with `cancellation_supported=1` and handle `test-remote` **cannot** call in-process adapter from a spawned CLI unless the CLI process registers the adapter. **Do not** register test adapters in production `bin.ts`. Cover the supported once-only path in **unit** tests of `requestInvocationCancellation`. Integration covers unsupported reject + status CLI + completed sample row.

- [ ] Unit action tests including idempotent synthetic cancel.
- [ ] Unit handler tests: no ambient resolution.
- [ ] Integration: status CLI, unsupported cancel does not abort the run.

#### 5.4 Dashboard seam (conditional)

Detect: `src/commands/dashboard.ts` **or** `registerDashboard` in `src/bin.ts`.

**If absent (current tree):** do not add HTTP. In Phase 7, document:

| Method | Path | Auth | Implementation |
|--------|------|------|----------------|
| GET | `/api/invocations?run_id=` | 04 token | `listInvocationViews` |
| GET | `/api/invocations/:id` | 04 token | `getInvocationView` |
| POST | `/api/invocations/:id/cancel` | 04 token | `requestInvocationCancellation({ actor: "control-plane" })` |

Unauthorized requests must not call the action (04’s middleware). Live status: 04 may poll GET or push `clientState` on the existing WebSocket; this slice does not add WS messages.

**If present:** wire those three routes to the exported functions; add one integration test that no token → 401 and token → cancel hits the same CAS as CLI (unsupported row still 409/400 with `CANCELLATION_UNSUPPORTED`, run active).

- [ ] Either wire 04 routes **or** document the table in `202` and skip HTTP code.

---

## Phase 6: Doctor stale-entry check

**Completion gate:** Doctor lists a seventh check `invocations`. Stale heartbeat and terminal-run leftovers fail `INVOCATION_STALE`. `--fix` CAS-abandons `stale-metadata`. Messages state that provider processes were **not** reaped. Fresh heartbeats are not flagged. `findingKey` uses `detail.invocationId`.

#### 6.1 Check — new `src/doctor/checks/invocations.ts`

Mirror `src/doctor/checks/prompts.ts:1–171`:

- Detect: `existsSync(ctx.dbPath)`; `openDbReadOnly`; `createSqliteInvocationStore`.
- Findings for each row where `status === "running"` AND (`updatedAt` older than `INVOCATION_STALE_MS` relative to `ctx.now` **OR** `getRunV1` is null / `completed` / `aborted`).
- Export `INVOCATION_STALE_MS = 15 * 60 * 1000`.
- `code: "INVOCATION_STALE"`, `fixable: true`, `detail: { invocationId, runId, updatedAt, reason: "heartbeat" | "run-terminal" }`.
- `remediation: "5x doctor --fix"`.
- **Message must include** that registry metadata can be abandoned and that **the underlying provider process is not reaped** (plan-input: doctor reporting without claiming processes can be reaped).
- Empty: `{ code: "INVOCATIONS_OK", status: "ok" }`.
- `--fix`: writable `getDb` (not `resolveDbContext` — same comment as `prompts.ts:11–12`). Re-validate still running and still stale/orphaned. `markAbandoned(id, "stale-metadata")`. Do **not** call `getCancellationAdapter` / `adapter.cancel`. Do **not** `process.kill`.

#### 6.2 Registry wiring

**File:** `src/doctor/registry.ts`

- Import and append `invocationsCheck` after `promptsCheck` (`:16–23`).
- `findingKey` (`:80–112`): `case "INVOCATION_STALE": return String(d.invocationId ?? "");`
- Doc comment (`:58–68`) add `INVOCATION_STALE → detail.invocationId`.

**File:** `test/unit/doctor/registry.test.ts:28–36` — expect seven ids including `"invocations"` last.

**File:** `test/integration/commands/doctor.test.ts:138–148` — `toContain("invocations")` and `INVOCATIONS_OK` on a clean project.

#### 6.3 Tests — new `test/unit/doctor/invocations.test.ts`

Copy fixtures from `test/unit/doctor/prompts.test.ts`.

- Heartbeat-fresh running + active run → `INVOCATIONS_OK`.
- Running + `updated_at` 16 minutes before `ctx.now` → `INVOCATION_STALE`, `reason: "heartbeat"`.
- Running + fresh heartbeat + run `aborted` → `INVOCATION_STALE`, `reason: "run-terminal"`.
- `--fix` abandons; re-detect ok; `status === "abandoned"`.
- `--fix` does not call a registered test adapter (spy `cancelCalls === 0`).
- Message matches `/not reaped/i` or `/was not reaped/i`.
- Missing `invocationId` on fixable finding: `findingKey` throws (registry test).
- Completed invocations never flagged.

- [ ] Implement check + `findingKey`.
- [ ] Unit + integration doctor coverage.
- [ ] Confirm `--fix` never kills processes (no `process.kill` in the check file — code review / grep in tests).

---

## Phase 7: Docs and forward-compat notes

**Completion gate:** `202` §3.6 TODOs for location/contents/opaque handles are resolved for this slice. `203` lists the invocations check. `101` documents status/cancel. OpenCode cancellation is explicitly a **new post-v2 plan**, not this one. `011` remains superseded. Plan-input metadata can point at this file.

#### 7.1 `docs/v2/202-control-plane.md`

**File:** `docs/v2/202-control-plane.md`, §3.6 lines 119–126.

Replace TODOs with:

- Location: `invocations` table in the control-plane SQLite materialization (not `.5x/agents/<session>.meta`).
- Contents: UUID, run/session, opaque `handle_json`, capability flag, request/outcome/terminal timestamps. No PID column.
- Cancel action: `requestInvocationCancellation`; dashboard POST contract (Phase 5.4 table).
- Not a daemon. OpenCode PID/SDK/SIGKILL **deferred** to a new plan after v2 foundation; do not revive `011`.

Leave dashboard-server TODOs in §3.5 / §5 that 04 owns.

- [ ] Resolve §3.6 in-slice TODOs only.

#### 7.2 `docs/v2/203-recovery-and-doctor.md`

**File:** `docs/v2/203-recovery-and-doctor.md`, shipped blurb `:10`, table `:77–83`, “six builtins” `:91`.

Add check row:

| `invocations` | Non-terminal registry rows with stale heartbeat or terminal/missing run | `--fix` CAS-abandons `stale-metadata`; does not reap provider processes |

Update counts from six to seven builtins. Point at this plan.

- [ ] Document the seventh check and the no-reap rule.

#### 7.3 `docs/v1/101-cli-primitives.md`

**File:** `docs/v1/101-cli-primitives.md`, §8 around lines 838–850 and the invoke command list near `:87`.

Document:

- `5x invoke status --id|--run` (explicit `--run` only).
- `5x invoke cancel <invocation-id>`.
- Unsupported → `CANCELLATION_UNSUPPORTED`; run status unchanged.
- Registry is coordination metadata, not a supervisor.

- [ ] Add primitives; do not promise OpenCode kill.

#### 7.4 `011` and plan-input pointer

**File:** `docs/development/plans/011-provider-process-lifecycle.md` — already superseded (`:5–12`). Add one sentence: v2 registry is `207-invocation-registry-plan.md`; OpenCode process cleanup requires a **new** plan, not a resurrection of Phases 1–2 here.

**File:** `docs/v2/plan-inputs/05-invocation-registry.plan-input.md` — set **Generated plan** to `docs/development/plans/207-invocation-registry-plan.md`.

Optional: `AGENTS.md` already says invocation-registry workers pass `--run` explicitly (`5x-cli/AGENTS.md:23`). Confirm cancel/status match; no change required unless wording is wrong.

- [ ] Point 011 and the plan-input at this plan.
- [ ] State in `202` / `101` that OpenCode-specific cancellation is a new post-v2 plan.

---

## Files Touched

| File | Change |
|------|--------|
| `src/control-plane/ids.ts` | Add `createInvocationId()` |
| `src/control-plane/invocation-types.ts` | **New** — records, CAS, errors, client view types |
| `src/control-plane/invocation-view.ts` | **New** — `toClientInvocationState` / `toClientInvocationView` |
| `src/control-plane/cancellation-adapter.ts` | **New** — adapter interface + process-local registry |
| `src/control-plane/test-remote-adapter.ts` | **New** — synthetic non-PID remote adapter |
| `src/control-plane/invocation-store.ts` | **New** — `InvocationStore` |
| `src/control-plane/invocation-sqlite.ts` | **New** — SQL materialization |
| `src/control-plane/invocation-memory.ts` | **New** — test impl |
| `src/control-plane/invocation-lifecycle.ts` | **New** — `withInvocationLifecycle` + heartbeat interval |
| `src/control-plane/invocation-actions.ts` | **New** — cancel/status actions |
| `src/control-plane/index.ts` | Re-export invocation APIs |
| `src/db/schema.ts` | Migration 7 |
| `src/db/timestamps.ts` | **New** (or equivalent) — shared `parseRunTimestamp` |
| `src/doctor/checks/runs.ts` | Import shared timestamp helper |
| `src/commands/invoke.handler.ts` | Lifecycle wrap, heartbeat hook, optional `invocationStore` dep |
| `src/commands/invoke-registry.handler.ts` | **New** — status/cancel |
| `src/commands/invoke-registry-context.ts` | **New** — store + `runExists` |
| `src/commands/invoke.ts` | Register `status` / `cancel` |
| `src/output.ts` | Error codes for cancel/status |
| `src/doctor/checks/invocations.ts` | **New** — stale detect/fix |
| `src/doctor/registry.ts` | Seventh check; `findingKey` |
| `src/index.ts` | Export invocation store/types/actions |
| `src/commands/dashboard.ts` (if exists) | Wire GET/POST to actions |
| `test/unit/db/schema.test.ts` | Expect version 7 |
| `test/unit/db/schema-v4.test.ts` | Expect version 7 |
| `test/unit/db/schema-v6.test.ts` | `runMigrations` current-max → 7 |
| `test/unit/db/schema-v7.test.ts` | **New** |
| `test/unit/control-plane/invocation-store-contract.test.ts` | **New** |
| `test/unit/control-plane/invocation-lifecycle.test.ts` | **New** |
| `test/unit/control-plane/invocation-actions.test.ts` | **New** |
| `test/unit/control-plane/invocation-view.test.ts` | **New** — seven client states |
| `test/unit/control-plane/test-remote-adapter.test.ts` | **New** |
| `test/unit/commands/invoke-registry.test.ts` | **New** |
| `test/unit/doctor/invocations.test.ts` | **New** |
| `test/unit/doctor/registry.test.ts` | Seventh check; `INVOCATION_STALE` key |
| `test/integration/commands/invoke-registry.test.ts` | **New** |
| `test/integration/commands/doctor.test.ts` | `invocations` check present |
| `docs/v2/202-control-plane.md` | Resolve §3.6; HTTP contract table |
| `docs/v2/203-recovery-and-doctor.md` | Seventh check; no-reap wording |
| `docs/v1/101-cli-primitives.md` | status/cancel primitives |
| `docs/development/plans/011-provider-process-lifecycle.md` | Pointer to this plan + new OpenCode follow-on |
| `docs/v2/plan-inputs/05-invocation-registry.plan-input.md` | Generated plan path |

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `invocation-view.test.ts` | Seven client states; view omits `handle`/`pid` |
| Unit | `test-remote-adapter.test.ts` | Non-PID job ref; abort on cancel; unknown handle fails |
| Unit | `schema-v7.test.ts` | v7 DDL, indexes, FK, CHECKs, no `pid` column, v6→v7 |
| Unit | `invocation-store-contract.test.ts` | Register/list/heartbeat; CAS request/terminal/abandon on memory + sqlite |
| Unit | `cas-race` (in contract or sibling) | Parallel sqlite `markCancellationRequested` → one winner |
| Unit | `invocation-lifecycle.test.ts` | completed/failed/cancelled; `finally`; abandon CAS win; heartbeat rate-limit; fault injection after register |
| Unit | `invocation-actions.test.ts` | Unsupported reject; invalid actor; synthetic once-only cancel; adapter failed outcome; terminal no-op |
| Unit | `invoke-registry.test.ts` | Explicit `--run`/`--id`; no ambient; `actor: "cli"` |
| Unit | `invocations.test.ts` (doctor) | Stale heartbeat, run-terminal orphan, `--fix` metadata-only, message does not claim reap |
| Unit | `registry.test.ts` | Seven checks; `findingKey` `INVOCATION_STALE` |
| Integration | `invoke-registry.test.ts` | Sample invoke → status `completed`; cancel unsupported inserted row; `runs.status` still `active` |
| Integration | `doctor.test.ts` | Check id present; clean `INVOCATIONS_OK`; optional `--fix` stale row |
| Integration (conditional) | dashboard auth | No token cannot cancel; token maps to `control-plane` actor |

---

## Not In Scope

- **OpenCode SDK patch, PID scraping, SIGTERM/SIGKILL escalation, process groups, orphan reaping** — forbidden by the plan input; `011` is historical failure analysis only. Track in a **new** post-v2 OpenCode plan.
- **Production cancellation adapters** for OpenCode, Codex, Claude Agent, Cursor, or sample — investigate each provider against this adapter contract in a follow-on. This slice ships `cancellationSupported: false` for all of them.
- **Daemon / supervisor / always-on reaper** — registry is a handle store (`202` §3.6, `200` §5).
- **SIGKILL/OOM orphan prevention** — no in-process handler can run (`011` DD2); out of scope.
- **Automatic run abortion on invocation cancel** — separate workflow requirement; do not call `updateRunStatus`.
- **Native harness subagent registration** — native path never hits `invoke.handler.ts`; follow-on after this contract.
- **Dashboard HTTP/WebSocket/UI/token implementation** — `04-control-plane-dashboard`, unless that code is already in tree at Phase 5.4.
- **Review-budget records, prompt-queue changes, `decisions` table.**
- **Remote/synced `InvocationStore` impl** — keep the interface; SQLite + memory only.
- **Changing `AgentProvider` / `AgentSession` method signatures** — register/unregister wrap invoke; do not add `cancel()` to the provider interface in this slice (adapters are a side contract keyed by opaque handle).

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Types, client view, adapter contract, synthetic remote adapter | 1 day |
| 2 | Schema v7 + migration tests | 0.5–1 day |
| 3 | InvocationStore sqlite/memory + CAS contract tests | 1–2 days |
| 4 | `withInvocationLifecycle` + invoke wiring + fault injection | 1–2 days |
| 5 | Cancel/status action, CLI, auth actor tests, optional dashboard wire | 1–2 days |
| 6 | Doctor stale check + `--fix` | 1 day |
| 7 | Docs (`202`, `203`, `101`, `011`, plan-input) | 0.5 day |
| **Total** | | **6–10 days** |

---

## Provenance

Implements v2 area #2’s **agent cancellation registry** (`docs/v2/202-control-plane.md` §3.6) from plan input `docs/v2/plan-inputs/05-invocation-registry.plan-input.md`. Honors `200` §3a constraint #5 (opaque handles, no universal PID) and `207-state-segmentation.md` (coordination TTL, not a git record). Replaces the approach in superseded `011-provider-process-lifecycle.md` without inheriting its OpenCode PID/SDK design. Store/CAS/doctor patterns follow `205-prompt-queue-foundation-plan.md`. Suggested next slice: `06-review-budget-advisory.plan-input.md`. Provider-specific adapters, including OpenCode process cleanup, are a **new** plan after this contract is proven.
