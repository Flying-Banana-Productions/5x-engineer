# Invocation Registry — Provider-Neutral Handles, Cancellation Contract, Doctor Hygiene

**Version:** 1.2
**Created:** August 28, 2026
**Status:** Draft — revision 1.2 addressing staff review addendum (Revision 1.1 reassessment, 2026-08-28)

---

## Executive Summary

`5x invoke` today starts a provider-owned session and forgets it. The control plane has no identity for the in-flight call, no truthful cancellation capability, and no way to distinguish “still running” from “the CLI crashed and left a row.” This slice adds a UUID-keyed invocation registry behind a store interface: opaque adapter-owned handles (never a universal PID field), separate cancellation-request / adapter-outcome / terminal-observation columns, invoke registration **immediately after session creation** (before later fallible log/session-start setup) in a single `try/finally` that also owns provider close, an independent heartbeat interval for the running lifetime, a local cancel/status action, and a doctor check that abandons **metadata only** via a liveness-predicate CAS (`markAbandonedIfStale`) so a concurrent heartbeat or run-reopen cannot retire a live row.

Shipped providers (OpenCode, sample, and plugins) report `cancellationSupported: false`. Cancel requests against them are rejected without touching `runs.status`. A synthetic remote test adapter — whose handle is a job id, not a PID — proves that a supported opaque handle receives **exactly one** idempotent cancel and records succeeded/failed. HTTP/UI auth stays owned by slice 04; this slice exports the in-process action 04 will wrap.

### Scope

**In scope:**

- Invocation identity, lifecycle, ownership, timestamps, session/run linkage, capability flags, and terminal outcomes (schema v7).
- Opaque cancellation-handle / adapter contract that can represent local or remote invocations.
- `InvocationStore` (SQLite + memory) with CAS request, CAS terminal, heartbeat, stale listing, status-only `markAbandoned` (lifecycle races), and `markAbandonedIfStale` (doctor `--fix`: atomic expected-`updated_at` and/or still-terminal-run predicate).
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
| **Heartbeat, not PID liveness, for stale detection** | PID liveness is a local-machine concept (`203` §3). An independent interval keeps long invokes fresh even when the provider is silent; do not bake `isPidAlive` into the registry. |
| **Doctor `--fix` abandons metadata only, CAS’d against the observed liveness predicate** | Safe unique repair. Messaging must not claim the provider process was reaped. Abandon must not win if a heartbeat refreshed `updated_at` or a run was reopened after detect/revalidation. |
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
15. [Revision History](#revision-history)
16. [Provenance](#provenance)

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

- Every `5x invoke author|reviewer` that reaches session start writes a UUID invocation row **immediately after** `startSession`/`resumeSession` succeeds: run/session linkage, provider name, opaque handle, `cancellation_supported`, timestamps. `prepareLogPath()` and `appendSessionStart()` run inside that lifecycle so a throw cannot leave an unregistered live session or skip `provider.close()`. A rate-limited heartbeat **interval** runs for the lifetime of the invocation (stream events may beat early as an optimization) and is cleared in `finally`. `try/finally` always drives the row to `completed`, `failed`, `cancelled`, or leaves it `running` only if the process dies before `finally`.
- Production providers register `cancellationSupported: false` and handle `{ adapter: "none", ref: session.id }`. `5x invoke cancel` rejects with `CANCELLATION_UNSUPPORTED` and does not change `runs.status` or abort the in-flight stream.
- Tests inject a `test-remote` adapter whose `ref` is a job id. One successful CAS request calls `adapter.cancel` once; a second request is a no-op at the store and does not call the adapter again. Outcome is recorded separately from lifecycle status. A supported row with no registered adapter records `cancellation_outcome = "unsupported"`; an adapter that returns or throws failure records `"failed"`.
- `5x invoke status --id <uuid>` / `--run <id>` returns the client view (seven distinguishable states). Supplying both flags requires the id to belong to that run (mismatch or missing → `INVOCATION_NOT_FOUND`; never return a foreign-run row). Workers pass explicit ids; they must not call `requireAmbientRunId` / `resolveAmbientRunId`. CLI JSON uses snake_case (`client_state`); in-process TypeScript uses `clientState`.
- `5x doctor` reports `INVOCATION_STALE` for non-terminal rows that are heartbeat-stale **or** whose run is missing/terminal. `--fix` CAS-abandons `stale-metadata` via `markAbandonedIfStale` (heartbeat findings: `updated_at` still equals the observed timestamp; run-terminal findings: run still missing/terminal in the same write) and states that no process was reaped.

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

**Exactly one adapter cancel per invocation.** `markCancellationRequested` is CAS: `UPDATE … WHERE id = ? AND status = 'running' AND cancellation_requested_at IS NULL AND cancellation_supported = 1`. Winner looks up the adapter and calls `adapter.cancel(handle)` once inside `try/catch`, then `recordCancellationOutcome`. Loser returns the stored row and **must not** call the adapter. Calling cancel against an already-terminal row returns the record without an adapter call. Record `outcome = unsupported` only if a supported row’s adapter is **missing** at cancel time (misconfiguration); that is distinct from the capability flag being false (`CANCELLATION_UNSUPPORTED`, no `requested_at`) and from an adapter that exists but returns or **throws** failure (`outcome = failed`). A thrown `adapter.cancel()` must not escape the action.

**Heartbeat is the stale predicate, not `isPidAlive`.** `INVOCATION_HEARTBEAT_MIN_INTERVAL_MS = 5_000`. After `register()`, `withInvocationLifecycle` starts a rate-limited **interval** that calls `store.heartbeat(id)` independently of streamed events, and **clears that timer in `finally`**. Do not rely on `runStreamed` events as the sole heartbeat source — a live provider that is silent for more than `INVOCATION_STALE_MS` would otherwise be falsely abandoned. `invokeStreamed` may still call `heartbeat()` on events as an optimization (first event can beat immediately). `INVOCATION_STALE_MS = 15 * 60 * 1000`. Doctor uses `ctx.now` (already on `DoctorCheckContext`, `src/doctor/types.ts:34–35`). A live long invoke stays fresh even when silent; a crashed CLI leaves `running` until TTL (or immediately if the run is already terminal/missing). Do not add a `cli_pid` column to “improve” this.

**Doctor `--fix` must CAS against the observed liveness predicate, not `status = 'running'` alone.** `markAbandoned(id, reason)` stays a status-only CAS for lifecycle races (`markTerminal` vs an already-abandoned row). A heartbeat can bump `updated_at`, or a run can be reopened, between doctor’s revalidation `get` and that UPDATE — status-only CAS would then abandon a live invocation. Doctor `--fix` calls `markAbandonedIfStale` (Phase 3 / 6): heartbeat-stale findings require `status = 'running' AND updated_at = expectedUpdatedAt`; run-terminal findings require `status = 'running'` and an atomic still-missing/terminal run check in the same write. Re-validation is a friendly fast-path only; the CAS is the correctness gate. Do not call adapters or `process.kill`.

**One registry lifecycle boundary with `try/finally`; register immediately after session creation.** Extract `withInvocationLifecycle` (Phase 4). Call it **immediately after** `startSession`/`resumeSession` succeeds (session id exists) — **before** `prepareLogPath()` and `appendSessionStart()`. Those calls, the stream, and structured-output validation all run inside `fn`. A throw from any of them marks the invocation `failed` (or `cancelled` for `AgentCancellationError`) and the outer `finally` still `provider.close()`. Session-start failure stays **outside** the wrapper: close provider, do not register (`invoke.handler.ts:458–460`). Lifecycle `finally` CAS-marks `failed` if still `running` (normal unwind without a terminal write) and always clears the heartbeat timer. Process kill before `finally` is the stale/abandon path. After session success, collapse existing `provider.close()` calls into that outer `finally`; keep close-before-throw on session-start failure. Do not add SIGKILL/PID tracking. Fault-injection tests throw from **each** pre-stream path (`prepareLogPath`, `appendSessionStart`), during stream, and after stream — they must not prescribe OpenCode internals.

**Cancel/status commands are workers: explicit ids only.** `5x invoke cancel <invocation-id>` keys by UUID. `5x invoke status` requires `--id <invocation-id>` and/or `--run <run-id>` (explicit `int`/`string` flags, no ambient fill). Combined `--id` and `--run` **intersects**: the invocation must exist and `runId` must equal `--run`. A missing id or a run mismatch both return `INVOCATION_NOT_FOUND` (mismatch message names both ids) and **must not** return a row whose run differs from `--run`. Do not import `requireAmbientRunId` in the new handler. Invoke author/reviewer keep today’s ambient resolution; they pass the already-resolved `params.run` into `register`.

**CLI JSON envelopes are snake_case; in-process views stay camelCase.** `InvocationClientView` uses TypeScript camelCase (`clientState`, `runId`, `sessionId`, …) for unit tests and in-process callers. `toInvocationStatusEnvelope()` maps that view to CLI/HTTP JSON keys (`client_state`, `run_id`, `session_id`, `provider_name`, `template_name`, `created_at`, `updated_at`, `terminal_at`, `cancellation.requested_by`). Cancel success also emits `adapter_called`. This matches `InvokeResult` / `5x run list`. Integration tests assert snake_case on spawned CLI stdout. The CLI handler must not `JSON.stringify` the camelCase view directly.

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
           │    (failure: close provider, do not register)  │
           ├─ store.register({ uuid, runId, sessionId,      │
           │     handle, cancellationSupported })           │
           │    immediately after session success           │
           ├─ heartbeat interval (5s) ─────────┐            ├─ requestInvocationCancellation
           ├─ prepareLogPath / appendSessionStart           │    actor: "cli" | "control-plane"
           ├─ invokeStreamed (+ optional event beat)        │
           │                               │                ├─ if !supported → CANCELLATION_UNSUPPORTED
           │     try / finally             │                │    (no requested_at, no adapter, no run change)
           │     (timer cleared in finally)│                ├─ CAS requested_at (once)
           ├─ markTerminal(completed|      │                ├─ adapter.cancel(opaque handle) once
           │     failed|cancelled)         │                │    missing adapter → outcome unsupported
           └─ provider.close() (outer      │                │    return/throw failure → outcome failed
                 finally after session)    │                └─ recordCancellationOutcome
                                           │
                                           ▼
                              InvocationStore (control plane)
                              SQLite materialization: invocations
                              (UUID, opaque handle_json, no pid)

  5x invoke status --id/--run          5x doctor [--fix]
           │                                    │
           ├─ --id and --run intersect          ├─ list non-terminal + stale heartbeat
           │    (mismatch → NOT_FOUND)          │    OR run missing/terminal
           └─ snake_case envelope               ├─ INVOCATION_STALE (fixable)
              client_state: running |           └─ --fix: markAbandonedIfStale
              cancellation-requested |             heartbeat: expected updated_at
              cancelled | completed |              run-terminal: run still
              failed | abandoned | unsupported        missing/terminal (no reap)

  Future 04 dashboard (not in this slice unless already present)
           │
           ├─ GET  /api/invocations?run_id=  → list + snake_case envelope
           ├─ GET  /api/invocations/:id      → snake_case envelope
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
                   │      + outcome succeeded|failed|unsupported
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

- [x] Export `createInvocationId` from `src/control-plane/index.ts` and `src/index.ts`.

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

/** CLI/HTTP JSON DTO: snake_case keys. Do not stringify InvocationClientView. */
export interface InvocationStatusEnvelope {
  id: string;
  run_id: string;
  session_id: string | null;
  role: "author" | "reviewer";
  provider_name: string;
  template_name: string | null;
  status: InvocationStatus;
  client_state: ClientInvocationState;
  cancellation: {
    supported: boolean;
    requested: boolean;
    requested_by: CancellationActor | null;
    outcome: CancellationOutcome | "none";
  };
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
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

export function toInvocationStatusEnvelope(
  view: InvocationClientView,
): InvocationStatusEnvelope {
  return {
    id: view.id,
    run_id: view.runId,
    session_id: view.sessionId,
    role: view.role,
    provider_name: view.providerName,
    template_name: view.templateName,
    status: view.status,
    client_state: view.clientState,
    cancellation: {
      supported: view.cancellation.supported,
      requested: view.cancellation.requested,
      requested_by: view.cancellation.requestedBy,
      outcome: view.cancellation.outcome,
    },
    created_at: view.createdAt,
    updated_at: view.updatedAt,
    terminal_at: view.terminalAt,
  };
}
```

Invariant: `toClientInvocationView` must not spread `handle` and must not add `pid`. `toInvocationStatusEnvelope` is the only JSON shape the CLI handler (and Phase 5.4 HTTP, if wired) may emit for an invocation.

- [x] Add types + view helpers + snake_case envelope mapper.
- [x] Unit-test all seven `clientState` branches, including `running + supported` vs `running + unsupported` vs `running + requested` (requested wins over unsupported if both could apply — requested should be unreachable when `supported` is false because cancel rejects first; still assert requested takes precedence if a record is constructed that way).
- [x] Unit-test `toInvocationStatusEnvelope`: `clientState` → `client_state`, `runId` → `run_id`; no `handle` / `pid` / camelCase client-state key.

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

- [x] Implement registry + test-remote adapter.
- [x] Unit tests: non-PID `ref`; unknown handle fails; abort signal fires on success; `handle` JSON has no `pid` key.

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

- [x] Append migration 7. Do not add a `pid` column or a process-group column.

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

- [x] Bump version-6 “current max” assertions to 7.
- [x] Add `schema-v7.test.ts` covering DDL, indexes, FK, CHECKs, no `pid`, v6→v7.

---

## Phase 3: InvocationStore, SQLite, memory, CAS

**Completion gate:** Shared contract tests pass on SQLite and memory: register/get/list, heartbeat, CAS request (exactly one winner under parallel sqlite writers), CAS terminal, status-only CAS abandon, `markAbandonedIfStale` (heartbeat expected-`updated_at` and run-terminal predicates; two-writer loss when a heartbeat or run-reopen lands first), stale listing. Command handlers still unchanged.

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
  /**
   * CAS: succeed iff still running. Doctor `--fix` must not use this —
   * it only CASes status and loses the heartbeat / run-reopen TOCTOU.
   * Use markAbandonedIfStale.
   */
  markAbandoned(
    id: string,
    reason: InvocationAbandonReason,
  ): InvocationCasResult;
  /**
   * CAS-abandon iff the observed liveness predicate still holds.
   * Doctor `--fix` uses this. Never a status-only write.
   *
   * staleReason "heartbeat": succeed iff status = 'running'
   *   AND updated_at = expectedUpdatedAt.
   * staleReason "run-terminal": succeed iff status = 'running'
   *   AND the linked run is missing, completed, or aborted
   *   (SQLite: same UPDATE, subquery on runs; memory: getRun
   *   callback invoked inside this method before the write).
   * Do not AND both predicates globally — a fresh heartbeat must
   * not block abandoning a still-terminal run, and a matching
   * timestamp must not abandon after a run was reopened.
   */
  markAbandonedIfStale(opts: {
    id: string;
    reason: InvocationAbandonReason;
    expectedUpdatedAt: string;
    staleReason: "heartbeat" | "run-terminal";
  }): InvocationCasResult;
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

`markTerminal` / `markAbandoned` similarly require `status = 'running'`. Abandoned sets `status`, `abandon_reason`, `terminal_at`, `updated_at`. Keep `markAbandoned` for lifecycle CAS races only.

`markAbandonedIfStale` SQL — **heartbeat** (`staleReason = "heartbeat"`):

```sql
UPDATE invocations
SET status = 'abandoned',
    abandon_reason = ?1,
    terminal_at = datetime('now'),
    updated_at = datetime('now')
WHERE id = ?2
  AND status = 'running'
  AND updated_at = ?3  -- expectedUpdatedAt from detect/revalidation
```

`markAbandonedIfStale` SQL — **run-terminal** (`staleReason = "run-terminal"`):

```sql
UPDATE invocations
SET status = 'abandoned',
    abandon_reason = ?1,
    terminal_at = datetime('now'),
    updated_at = datetime('now')
WHERE id = ?2
  AND status = 'running'
  AND NOT EXISTS (
    SELECT 1 FROM runs r
    WHERE r.id = invocations.run_id
      AND r.status NOT IN ('completed', 'aborted')
  )
```

`expectedUpdatedAt` is still required in the TypeScript signature for both reasons (heartbeat CAS uses it; run-terminal may ignore it in SQL). If `changes() = 0`: load row; missing → `INVOCATION_NOT_FOUND`; else `{ ok: false, invocation }`.

Memory `createMemoryInvocationStore` takes optional `{ now?: () => string; getRun?: (runId: string) => { status: string } | null }`. `getRun` is invoked **inside** `markAbandonedIfStale` when `staleReason === "run-terminal"` (missing/completed/aborted → allow; active/unknown-non-terminal → CAS miss). Do not read run status in the doctor check and then pass a boolean into the store — that reopens the TOCTOU.

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
- `markAbandonedIfStale` heartbeat: matching `expectedUpdatedAt` on a running row succeeds; mismatched timestamp (heartbeat already bumped `updated_at`) → `ok: false`, status stays `running`.
- `markAbandonedIfStale` run-terminal: linked run `aborted`/`completed`/missing → `ok: true`; run `active` → `ok: false`, status stays `running`.
- **Two-writer heartbeat:** observe `updatedAt`; second sqlite connection (or memory `heartbeat`) bumps `updated_at`; first writer `markAbandonedIfStale({ staleReason: "heartbeat", expectedUpdatedAt: observed })` → `ok: false`, row not abandoned. Copy the two-connection pattern from `cas-race.test.ts:60–79` for sqlite.
- **Two-writer run reopen:** running row + aborted run; second writer sets `runs.status` back to `active` (sqlite `UPDATE runs`; memory: mutate `getRun`); `markAbandonedIfStale({ staleReason: "run-terminal" })` → `ok: false`, row not abandoned.
- `listStale` with injected `nowMs`: fresh heartbeat excluded; old `updated_at` included; completed excluded.
- Missing id throws `INVOCATION_NOT_FOUND`.

- [ ] Dual-backend contract tests including parallel CAS and `markAbandonedIfStale` two-writer losses.

---

## Phase 4: Invoke registration lifecycle

**Completion gate:** `withInvocationLifecycle` unit tests cover success, thrown error, cancellation error, `finally` when unmarked, pre-stream fault injection, and a silent invocation that stays non-stale past `INVOCATION_STALE_MS` via the heartbeat timer (timer cleared on completion and on error). `invokeAgent` registers **immediately after** session success, before `prepareLogPath`/`appendSessionStart`; a throw from either leaves `failed` and still closes the provider. A successful sample invoke leaves `completed`; a thrown provider error leaves `failed`. Production register uses `cancellationSupported: false`. `AgentProvider` / `AgentSession` interfaces (`src/providers/types.ts:15–36`) are unchanged.

#### 4.1 Lifecycle helper — new `src/control-plane/invocation-lifecycle.ts`

```typescript
export const INVOCATION_HEARTBEAT_MIN_INTERVAL_MS = 5_000;
export const INVOCATION_STALE_MS = 15 * 60 * 1000;

export async function withInvocationLifecycle<T>(opts: {
  store: InvocationStore;
  input: RegisterInvocationInput;
  isCancellationError?: (err: unknown) => boolean;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  fn: (ctx: {
    invocation: InvocationRecord;
    heartbeat: () => void;
  }) => Promise<T>;
}): Promise<T> {
  const invocation = opts.store.register(opts.input);
  const nowFn = opts.now ?? Date.now;
  let lastBeat = 0;
  const heartbeat = () => {
    const t = nowFn();
    if (t - lastBeat < INVOCATION_HEARTBEAT_MIN_INTERVAL_MS) return;
    lastBeat = t;
    opts.store.heartbeat(invocation.id);
  };
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const timer = setIntervalFn(
    () => heartbeat(),
    INVOCATION_HEARTBEAT_MIN_INTERVAL_MS,
  );
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
    clearIntervalFn(timer);
    const current = opts.store.get(invocation.id);
    if (current?.status === "running") {
      opts.store.markTerminal(invocation.id, "failed");
    }
  }
}
```

`isCancellationError`: default treats `err` with `name === "AgentCancellationError"` (class is in `src/providers/opencode.ts:49–52`; do not import OpenCode from the control-plane helper — duck-type `name` or move `AgentCancellationError` to `src/providers/errors.ts` **only if** a one-line move is needed; prefer duck-typing to avoid a provider refactor).

The **interval** is the source of truth for “this invocation is still live.” Event-hook `heartbeat()` calls inside `fn` are an optional optimization (rate-limited here so `invokeStreamed` can call `heartbeat()` on every event). Inject `now` / `setIntervalFn` / `clearIntervalFn` so tests can fake-clock a silent `fn` past `INVOCATION_STALE_MS` without waiting 15 minutes. Doctor (Phase 6) **imports** `INVOCATION_STALE_MS` from this module — do not define a second literal.

If `markTerminal` in `try` succeeds, `finally` clears the timer and sees non-running. If `fn` returns without throwing and `markTerminal('completed')` CAS-loses to doctor abandon, leave `abandoned` (do not overwrite).

- [ ] Implement helper with independent heartbeat interval. Do not call adapters here.
- [ ] Clear the timer in `finally` on both success and error paths.

#### 4.2 `invokeStreamed` heartbeat hook

**File:** `src/commands/invoke.handler.ts`, `invokeStreamed` at lines 126–168.

Add optional `onEvent?: () => void` (or `heartbeat?: () => void`) invoked once per streamed event **before** rendering. This is an **optimization** on top of the lifecycle interval (first event can beat immediately). It is **not** sufficient by itself — a silent provider must stay fresh via the timer. Do not change NDJSON or stderr behavior.

- [ ] Add the hook; existing tests that call `invokeStreamed` indirectly still pass.

#### 4.3 Wire `invokeAgent`

**File:** `src/commands/invoke.handler.ts`, provider/session/stream block lines 415–592.

Optional deps (do not require sqlite in tests of the helper):

```typescript
export interface InvokeAgentDeps {
  invocationStore?: InvocationStore;
  prepareLogPath?: typeof prepareLogPath;
  appendSessionStart?: typeof appendSessionStart;
}
```

**Register immediately after session success** (`:445–461`). Today `prepareLogPath()` (`:471`) and `appendSessionStart()` (`:476–484`) run after `startSession`/`resumeSession` and before stream — both can throw. Those calls **must** live inside `fn`, not between session start and `withInvocationLifecycle`. Session-start failure stays outside: close provider, do not register (`:458–460`).

```typescript
const store =
  deps?.invocationStore ?? createSqliteInvocationStore(runDb);
const prepareLog = deps?.prepareLogPath ?? prepareLogPath;
const appendStart = deps?.appendSessionStart ?? appendSessionStart;
try {
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
      const logPath = prepareLog(logDir);
      appendStart(logPath, { type: "session_start", /* existing fields */ });
      runResult = await invokeStreamed(..., heartbeat);
      // existing validation / record-failure (throws on invalid output)
    },
  });
} finally {
  await provider.close().catch(() => {});
}
outputSuccess(output); // after lifecycle has marked completed
```

Collapse the existing stream-error and validation-error `provider.close()` calls (`:514`, `:528`, `:592`) into that outer `finally`. Do **not** remove close-before-throw on session-start failure. `outputSuccess` / auto-record stay **after** the lifecycle returns (a print/record error must not un-complete a finished invoke).

Do not pass `opts.signal` tied to registry cancel for unsupported providers.

If `runDb` is used after the block that currently scopes it (`:231–279`), keep the connection open through invoke (it already is via `getDb` singleton). Construct the sqlite invocation store from that same db.

- [ ] Register every successful session start, **before** `prepareLogPath` / `appendSessionStart`.
- [ ] `cancellationSupported: false` and `adapter: "none"` for all production providers in this slice (including OpenCode and sample).
- [ ] Heartbeat interval from the lifecycle helper; stream hook remains an optimization.
- [ ] Outer `finally` closes the provider on every post-session path.

#### 4.4 Tests

**New:** `test/unit/control-plane/invocation-lifecycle.test.ts`

- Memory store; `fn` returns → `completed`.
- `fn` throws `Error` → `failed`, error propagates.
- `fn` throws `{ name: "AgentCancellationError" }` → `cancelled`.
- `fn` throws after doctor `markAbandoned` (status-only CAS, simulating an already-abandoned row) → status stays `abandoned` (CAS loss). Doctor `--fix` itself uses `markAbandonedIfStale` (Phase 6); this case only needs a terminal `abandoned` row.
- Fault injection: `fn` throws before any heartbeat; row is `failed` not `running`.
- Heartbeat rate-limit: spy on `store.heartbeat` and call the wrapped heartbeat 3 times within 5s → one call (inject fake `now`).
- **Silent liveness:** inject fake `now` + `setIntervalFn`/`clearIntervalFn`. Drive store timestamps from the same fake clock (wrap `heartbeat` / pass `now` into `createMemoryInvocationStore` so `updatedAt` is not wall-clock). `fn` waits (never calls `heartbeat`, never emits stream events). Advance `now` past `INVOCATION_STALE_MS` and fire the interval callbacks. `listStale({ olderThanMs: INVOCATION_STALE_MS, nowMs })` must **not** include the row. A control that never fires the timer **does** include it. Then resolve `fn` → `completed` and assert `clearIntervalFn` was called once.
- **Timer cleared on error:** same fake timer; `fn` throws → `failed` and `clearIntervalFn` called once. After clear, further interval ticks must not call `store.heartbeat`.

**New or extend:** `test/unit/commands/invoke-registry.test.ts`

- Inject a memory invocation store into `invokeAgent` via `InvokeAgentDeps`. Sample provider is fast (`packages/provider-sample/src/index.ts:66–89`).
- After successful sample invoke, `store.list({ runId })[0].status === "completed"` and `cancellationSupported === false`.
- **Pre-stream fault injection (each path):** inject `prepareLogPath` that throws after a real session start → row is `failed` not `running`, and `provider.close()` ran (spy). Repeat with `appendSessionStart` that throws. These two tests are required; a single “`fn` throws immediately” lifecycle test does **not** substitute for wiring coverage.

- [ ] Lifecycle unit tests including pre-stream fault injection and silent heartbeat-timer coverage.
- [ ] At least one invoke path writes a `completed` row with `cancellationSupported: false`.
- [ ] `invokeAgent` tests: `prepareLogPath` throw and `appendSessionStart` throw each leave `failed` and close the provider.

---

## Phase 5: Cancel/status action, CLI, dashboard seam

**Completion gate:** `requestInvocationCancellation` rejects unsupported without mutating run or requested_at; a supported row with no adapter records `unsupported`; a throwing adapter records `failed` and still returns `ok: true`; supported synthetic adapter is called exactly once; second cancel is idempotent; invalid actor is rejected. Combined `--id --run` intersects (mismatch → `INVOCATION_NOT_FOUND`). CLI JSON uses `client_state` (snake_case). CLI `5x invoke status` / `cancel` integration tests pass. No ambient run resolver in the new handler. If dashboard command exists, authenticated HTTP tests pass; if not, the HTTP contract is documented and the in-process action is the gate.

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
    opts.store.recordCancellationOutcome(opts.id, "unsupported");
    return {
      ok: true,
      view: toClientInvocationView(opts.store.get(opts.id)!),
      adapterCalled: false,
    };
  }
  let outcome: CancellationOutcome;
  try {
    const result = await adapter.cancel(cas.invocation.handle);
    outcome = result.outcome === "succeeded" ? "succeeded" : "failed";
  } catch {
    outcome = "failed";
  }
  opts.store.recordCancellationOutcome(opts.id, outcome);
  return {
    ok: true,
    view: toClientInvocationView(opts.store.get(opts.id)!),
    adapterCalled: true,
  };
}
```

Normative behavior:

- Unsupported capability (`cancellationSupported: false`): **do not** `markCancellationRequested`; return `CANCELLATION_UNSUPPORTED`; caller must not touch `runs`.
- Actor missing/invalid: `INVOCATION_INVALID_ACTOR` (auth test).
- Already requested / already terminal: `ok: true`, `adapterCalled: false` (idempotent).
- CAS winner: exactly one `adapter.cancel`.
- **Missing adapter** on a supported row: `recordCancellationOutcome(..., "unsupported")`, `ok: true`, `adapterCalled: false`. This is misconfiguration, not a capability-flag reject.
- **Adapter returns `{ outcome: "failed" }`:** `recordCancellationOutcome(..., "failed")`, `ok: true`, `adapterCalled: true`.
- **Adapter throw:** catch, `recordCancellationOutcome(..., "failed")`, still `ok: true` with `outcome: "failed"` (request happened; adapter failed). Do not convert that into run abort. The exception must not escape `requestInvocationCancellation`.

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

- `invokeStatus({ id?, run?, startDir? }, deps)` — require `id` or `run`; never ambient.
  - `--run` set: `runExists` or `RUN_NOT_FOUND`.
  - `--id` only: `store.get(id)`; missing → `INVOCATION_NOT_FOUND`; envelope `{ invocation: toInvocationStatusEnvelope(view) }`.
  - `--run` only: `store.list({ runId: run })`; envelope `{ invocations: views.map(toInvocationStatusEnvelope) }`.
  - **`--id` and `--run` together:** `store.get(id)`; if missing **or** `record.runId !== run` → `INVOCATION_NOT_FOUND` with a message that names both ids (e.g. `invocation ${id} not found for run ${run}`). **Do not** return a row whose `runId` differs from `--run`. Success envelope is the single `{ invocation }` shape.
- `invokeCancel({ id }, deps)` — `requestInvocationCancellation({ actor: "cli" })`. Map `CANCELLATION_UNSUPPORTED` / `INVOCATION_NOT_FOUND` through `outputError`. Success: `outputSuccess({ ...toInvocationStatusEnvelope(view), adapter_called })`.

The handler **must** map through `toInvocationStatusEnvelope` before `outputSuccess`. Do not emit camelCase `clientState` / `runId` on CLI stdout.

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
- Unsupported capability: code `CANCELLATION_UNSUPPORTED`; row still `running`; `requested_at` null. Pair with a fake `runs` row that stays `active` (action tests don’t open `runs` — document that invoke-registry handler tests / integration must assert `getRunV1().status === "active"`).
- Synthetic adapter: first cancel `adapterCalled: true`, `outcome: "succeeded"`, `clientState: "cancellation-requested"` (status still `running`).
- Second cancel: `adapterCalled: false`; adapter `cancelCalls === 1`.
- Adapter returns `{ outcome: "failed" }`: `outcome: "failed"`; still `running`; `clientState: "cancellation-requested"`; `adapterCalled: true`.
- **Adapter throws:** `cancel()` rejects/throws; action still `ok: true`; `outcome: "failed"`; `requested_at` set; `adapterCalled: true`; exception does not propagate. Distinct from the returned-failed case — both are required.
- **Missing adapter** on a `cancellationSupported: true` row (`getAdapter` returns `undefined`): `outcome: "unsupported"`; `adapterCalled: false`; `ok: true`; status still `running`; `clientState: "cancellation-requested"`.
- Terminal completed: `ok: true`, adapter not called.
- Missing id: `INVOCATION_NOT_FOUND`.

**New:** `test/unit/commands/invoke-registry.test.ts`

- Inject memory store; `status --run` lists; unknown run → `RUN_NOT_FOUND`.
- `status --id` returns a single `{ invocation }` envelope with snake_case keys (`client_state`, `run_id`).
- **Combined `--id --run`:** id that belongs to that run → single `{ invocation }`. id that belongs to a **different** run → `INVOCATION_NOT_FOUND`; the foreign row is not in the envelope. Missing id with a valid `--run` → `INVOCATION_NOT_FOUND`.
- `cancel` passes `actor: "cli"`.
- Grep/test: handler module source must not import `requireAmbientRunId` / `resolveAmbientRunId` (or a unit test that status without `--run`/`--id` is `INVALID_ARGS` even when `.5x/current-run` exists).

**New:** `test/integration/commands/invoke-registry.test.ts`

- Temp project + sample provider + `5x invoke author …` then `5x invoke status --run <id>` → one row, `client_state: "completed"` (snake_case key; after sample returns, `completed` not `unsupported`). Assert the key is `client_state`, not `clientState`.
- `5x invoke status --id <uuid> --run <that-run>` → same single invocation. `5x invoke status --id <uuid> --run <other-run>` → error `INVOCATION_NOT_FOUND` (do not print the foreign row).
- `5x invoke cancel <id>` on that completed sample row → success, no adapter, status unchanged. Success JSON includes `adapter_called` and `client_state`.
- `5x invoke cancel` on a **running** unsupported row: spawn a slow test by injecting a hanging store row via sqlite in the test (do not hang sample): insert `running` + `cancellation_supported=0`, run cancel CLI, expect error envelope `CANCELLATION_UNSUPPORTED`, then `SELECT status FROM runs` still `active`.
- Supported path in integration: insert row with `cancellation_supported=1` and handle `test-remote` **cannot** call in-process adapter from a spawned CLI unless the CLI process registers the adapter. **Do not** register test adapters in production `bin.ts`. Cover the supported once-only path, throwing-adapter path, and missing-adapter `unsupported` outcome in **unit** tests of `requestInvocationCancellation`. Integration covers unsupported reject + status CLI (including combined `--id --run`) + completed sample row.

- [ ] Unit action tests including idempotent synthetic cancel, throwing adapter → `failed`, missing adapter → `unsupported`.
- [ ] Unit handler tests: no ambient resolution; combined `--id --run` intersection; snake_case envelope.
- [ ] Integration: status CLI (`client_state`), combined `--id --run`, unsupported cancel does not abort the run.

#### 5.4 Dashboard seam (conditional)

Detect: `src/commands/dashboard.ts` **or** `registerDashboard` in `src/bin.ts`.

**If absent (current tree):** do not add HTTP. In Phase 7, document:

| Method | Path | Auth | Implementation |
|--------|------|------|----------------|
| GET | `/api/invocations?run_id=` | 04 token | `listInvocationViews` |
| GET | `/api/invocations/:id` | 04 token | `getInvocationView` |
| POST | `/api/invocations/:id/cancel` | 04 token | `requestInvocationCancellation({ actor: "control-plane" })` |

Unauthorized requests must not call the action (04’s middleware). Live status: 04 may poll GET or push `client_state` (snake_case, same envelope as CLI) on the existing WebSocket; this slice does not add WS messages. HTTP JSON **must** use `toInvocationStatusEnvelope`, not the camelCase `InvocationClientView`.

**If present:** wire those three routes to the exported functions; add one integration test that no token → 401 and token → cancel hits the same CAS as CLI (unsupported row still 409/400 with `CANCELLATION_UNSUPPORTED`, run active).

- [ ] Either wire 04 routes **or** document the table in `202` and skip HTTP code.

---

## Phase 6: Doctor stale-entry check

**Completion gate:** Doctor lists a seventh check `invocations`. Stale heartbeat and terminal-run leftovers fail `INVOCATION_STALE`. `--fix` calls `markAbandonedIfStale` (not status-only `markAbandoned`) so a heartbeat or run-reopen between revalidation and the write cannot abandon a live row. Messages state that provider processes were **not** reaped. Fresh heartbeats are not flagged. `findingKey` uses `detail.invocationId`.

#### 6.1 Check — new `src/doctor/checks/invocations.ts`

Mirror `src/doctor/checks/prompts.ts:1–171`:

- Detect: `existsSync(ctx.dbPath)`; `openDbReadOnly`; `createSqliteInvocationStore`.
- Findings for each row where `status === "running"` AND (`updatedAt` older than `INVOCATION_STALE_MS` relative to `ctx.now` **OR** `getRunV1` is null / `completed` / `aborted`).
- When both predicates match, set `reason: "run-terminal"` (stronger claim: a still-terminal run must remain abandonable even if a heartbeat lands in the `--fix` window). Otherwise `reason: "heartbeat"` or `"run-terminal"` as matched.
- Export `INVOCATION_STALE_MS = 15 * 60 * 1000` (same constant as `invocation-lifecycle.ts`; import it — do not duplicate the literal).
- `code: "INVOCATION_STALE"`, `fixable: true`, `detail: { invocationId, runId, updatedAt, reason: "heartbeat" | "run-terminal" }`. `updatedAt` is the value observed at detect (passed through to `--fix` as documentation; the CAS uses the re-read timestamp).
- `remediation: "5x doctor --fix"`.
- **Message must include** that registry metadata can be abandoned and that **the underlying provider process is not reaped** (plan-input: doctor reporting without claiming processes can be reaped).
- Empty: `{ code: "INVOCATIONS_OK", status: "ok" }`.
- `--fix`: writable `getDb` (not `resolveDbContext` — same comment as `prompts.ts:11–12`). Optional test dep `createStore?: (db) => InvocationStore` so unit tests can wrap the store; production uses `createSqliteInvocationStore`.
  1. Load the row. Missing / not `running` → `{ attempted: false }` (already repaired or terminalized).
  2. Fast-path re-validate the **finding’s** predicate: `heartbeat` still older than `INVOCATION_STALE_MS` vs `ctx.now`; `run-terminal` still missing/`completed`/`aborted`. If that predicate no longer holds → `{ attempted: false }` with a message (`"invocation is no longer stale"` / `"run is no longer terminal"`). This is UX only — it does not close the TOCTOU.
  3. **Required write:** `store.markAbandonedIfStale({ id, reason: "stale-metadata", expectedUpdatedAt: record.updatedAt, staleReason: finding.detail.reason })`. Do **not** call `markAbandoned(id, "stale-metadata")`.
  4. CAS miss (`ok: false`) → `{ attempted: false }` (heartbeat won, run reopened, or another writer terminalized). CAS hit → `{ attempted: true }`.
- Do **not** call `getCancellationAdapter` / `adapter.cancel`. Do **not** `process.kill`.
- Do **not** read run status (or `updatedAt`) in the check and pass a precomputed boolean into the store — the run-terminal predicate must be evaluated inside the same `UPDATE` / memory write as the status CAS (Phase 3).

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
- Both predicates match → `reason: "run-terminal"`.
- `--fix` abandons a still-stale heartbeat row and a still-terminal-run row; re-detect ok; `status === "abandoned"`.
- `--fix` does not call a registered test adapter (spy `cancelCalls === 0`).
- Message matches `/not reaped/i` or `/was not reaped/i`.
- Missing `invocationId` on fixable finding: `findingKey` throws (registry test).
- Completed invocations never flagged.
- **Two-writer heartbeat (required):** after detect/revalidation, a heartbeat lands **before** the abandon write. Prove `--fix` does **not** abandon. Deterministic approach: inject `createStore` wrapping the real store so `markAbandonedIfStale` first calls `inner.heartbeat(id)` then delegates (revalidation `get` still sees the stale row). Assert `attempted: false` and `status === "running"`. Also cover detect → heartbeat → `--fix` (fast-path or CAS miss; row not abandoned).
- **Two-writer run reopen (required):** same pattern for `reason: "run-terminal"`: wrapper (or second sqlite writer) sets `runs.status` back to `active` after revalidation / before `markAbandonedIfStale`. Assert `--fix` does not abandon. Cover detect → reopen → `--fix` as well.
- Grep or unit assertion: `src/doctor/checks/invocations.ts` calls `markAbandonedIfStale` and does not call `markAbandoned(`.

- [ ] Implement check + `findingKey`.
- [ ] Unit + integration doctor coverage.
- [ ] Two-writer `--fix` tests: competing heartbeat and competing run-reopen do not abandon.
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

| `invocations` | Non-terminal registry rows with stale heartbeat or terminal/missing run | `--fix` `markAbandonedIfStale` (expected `updated_at` / still-terminal run); does not reap provider processes |

Update counts from six to seven builtins. Point at this plan.

- [ ] Document the seventh check and the no-reap rule.

#### 7.3 `docs/v1/101-cli-primitives.md`

**File:** `docs/v1/101-cli-primitives.md`, §8 around lines 838–850 and the invoke command list near `:87`.

Document:

- `5x invoke status --id|--run` (explicit `--run` only; combined flags intersect — mismatch is `INVOCATION_NOT_FOUND`).
- CLI JSON keys are snake_case (`client_state`, `run_id`); not camelCase `clientState`.
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
| `src/control-plane/invocation-types.ts` | **New** — records, CAS, errors, client view + snake_case envelope types |
| `src/control-plane/invocation-view.ts` | **New** — `toClientInvocationState` / `toClientInvocationView` / `toInvocationStatusEnvelope` |
| `src/control-plane/cancellation-adapter.ts` | **New** — adapter interface + process-local registry |
| `src/control-plane/test-remote-adapter.ts` | **New** — synthetic non-PID remote adapter |
| `src/control-plane/invocation-store.ts` | **New** — `InvocationStore` including `markAbandonedIfStale` |
| `src/control-plane/invocation-sqlite.ts` | **New** — SQL materialization; abandon-if-stale `UPDATE` predicates |
| `src/control-plane/invocation-memory.ts` | **New** — test impl; `getRun` callback for run-terminal CAS |
| `src/control-plane/invocation-lifecycle.ts` | **New** — `withInvocationLifecycle` + heartbeat interval/timer |
| `src/control-plane/invocation-actions.ts` | **New** — cancel/status actions (catch adapter throw; missing adapter → `unsupported`) |
| `src/control-plane/index.ts` | Re-export invocation APIs |
| `src/db/schema.ts` | Migration 7 |
| `src/db/timestamps.ts` | **New** (or equivalent) — shared `parseRunTimestamp` |
| `src/doctor/checks/runs.ts` | Import shared timestamp helper |
| `src/commands/invoke.handler.ts` | Lifecycle wrap immediately after session; log/session-start inside `fn`; heartbeat hook; optional `invocationStore` / log-path deps |
| `src/commands/invoke-registry.handler.ts` | **New** — status/cancel; combined `--id --run`; snake_case envelope |
| `src/commands/invoke-registry-context.ts` | **New** — store + `runExists` |
| `src/commands/invoke.ts` | Register `status` / `cancel` |
| `src/output.ts` | Error codes for cancel/status |
| `src/doctor/checks/invocations.ts` | **New** — stale detect; `--fix` via `markAbandonedIfStale` |
| `src/doctor/registry.ts` | Seventh check; `findingKey` |
| `src/index.ts` | Export invocation store/types/actions |
| `src/commands/dashboard.ts` (if exists) | Wire GET/POST to actions |
| `test/unit/db/schema.test.ts` | Expect version 7 |
| `test/unit/db/schema-v4.test.ts` | Expect version 7 |
| `test/unit/db/schema-v6.test.ts` | `runMigrations` current-max → 7 |
| `test/unit/db/schema-v7.test.ts` | **New** |
| `test/unit/control-plane/invocation-store-contract.test.ts` | **New** — including `markAbandonedIfStale` two-writer |
| `test/unit/control-plane/invocation-lifecycle.test.ts` | **New** |
| `test/unit/control-plane/invocation-actions.test.ts` | **New** |
| `test/unit/control-plane/invocation-view.test.ts` | **New** — seven client states |
| `test/unit/control-plane/test-remote-adapter.test.ts` | **New** |
| `test/unit/commands/invoke-registry.test.ts` | **New** |
| `test/unit/doctor/invocations.test.ts` | **New** — stale detect/fix + heartbeat/reopen TOCTOU |
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
| Unit | `invocation-view.test.ts` | Seven client states; view omits `handle`/`pid`; envelope maps `clientState` → `client_state` |
| Unit | `test-remote-adapter.test.ts` | Non-PID job ref; abort on cancel; unknown handle fails |
| Unit | `schema-v7.test.ts` | v7 DDL, indexes, FK, CHECKs, no `pid` column, v6→v7 |
| Unit | `invocation-store-contract.test.ts` | Register/list/heartbeat; CAS request/terminal/abandon on memory + sqlite; `markAbandonedIfStale` expected-`updated_at` and run-terminal predicates; two-writer heartbeat and run-reopen losses |
| Unit | `cas-race` (in contract or sibling) | Parallel sqlite `markCancellationRequested` → one winner |
| Unit | `invocation-lifecycle.test.ts` | completed/failed/cancelled; `finally`; abandon CAS win; heartbeat rate-limit; pre-stream fault injection; silent invocation stays fresh past stale TTL via timer; timer cleared on complete/error |
| Unit | `invocation-actions.test.ts` | Unsupported reject; invalid actor; synthetic once-only cancel; adapter returned-failed; **adapter throw → failed**; **missing adapter → unsupported**; terminal no-op |
| Unit | `invoke-registry.test.ts` | Explicit `--run`/`--id`; combined intersection; snake_case envelope; no ambient; `actor: "cli"`; `prepareLogPath`/`appendSessionStart` throw → `failed` + close |
| Unit | `invocations.test.ts` (doctor) | Stale heartbeat, run-terminal orphan, `--fix` metadata-only, message does not claim reap; two-writer `--fix` does not abandon after competing heartbeat or run reopen |
| Unit | `registry.test.ts` | Seven checks; `findingKey` `INVOCATION_STALE` |
| Integration | `invoke-registry.test.ts` | Sample invoke → status `client_state: "completed"`; combined `--id --run` match/mismatch; cancel unsupported inserted row; `runs.status` still `active` |
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
| 3 | InvocationStore sqlite/memory + CAS contract tests (incl. `markAbandonedIfStale`) | 1–2 days |
| 4 | `withInvocationLifecycle` (register-at-session, heartbeat timer, pre-stream faults) + invoke wiring | 1–2 days |
| 5 | Cancel/status action, CLI, auth actor tests, optional dashboard wire | 1–2 days |
| 6 | Doctor stale check + predicate-CAS `--fix` | 1–1.5 days |
| 7 | Docs (`202`, `203`, `101`, `011`, plan-input) | 0.5 day |
| **Total** | | **6.5–10.5 days** |

---

## Revision History

### 1.2 — August 28, 2026

Addresses the **New active correction** in **Addendum — Revision 1.1 reassessment (August 28, 2026)** of [`docs/development/reviews/5x-cli-docs-development-plans-207-invocation-registry-plan-review.md`](../reviews/5x-cli-docs-development-plans-207-invocation-registry-plan-review.md). Prior addendum items (session-boundary registration, thrown adapter cancel, missing-adapter `unsupported`, combined status filters / snake_case envelope, independent heartbeat interval) remain as in 1.1.

1. **Doctor abandonment CAS against the observed liveness predicate.** `markAbandoned(id, reason)` stays status-only for lifecycle races. Doctor `--fix` must call `markAbandonedIfStale`: heartbeat-stale findings CAS `updated_at = expectedUpdatedAt`; run-terminal findings CAS an atomic still-missing/terminal run check in the same write (SQLite subquery; memory `getRun` inside the method). Re-validation is UX only. Store contract and doctor `--fix` two-writer tests prove a competing heartbeat or run-reopen does not abandon the row.

### 1.1 — August 28, 2026

Addresses all five **Active corrections** in the **Addendum — August 28, 2026** of [`docs/development/reviews/5x-cli-docs-development-plans-207-invocation-registry-plan-review.md`](../reviews/5x-cli-docs-development-plans-207-invocation-registry-plan-review.md). Original P1.1–P1.3 / P2 items are the same corrections; this revision implements them in the plan plus the addendum’s independent-heartbeat requirement.

1. **Register immediately after session creation.** `prepareLogPath()` and `appendSessionStart()` move inside `withInvocationLifecycle` `fn`. Session-start failure still closes the provider without registering. Pre-stream fault-injection tests cover each of those two throws (row `failed`, provider closed).
2. **Catch `adapter.cancel()` throw.** Phase 5 action wraps cancel in `try/catch`, persists `failed`, returns `ok: true`. Unit test for a throwing adapter (distinct from returned `{ outcome: "failed" }`).
3. **Missing supported adapter → `unsupported`.** Pseudocode and tests record `cancellation_outcome = "unsupported"` when `getAdapter` returns undefined; `failed` is reserved for an adapter that exists but returns or throws failure.
4. **Combined `status --id --run` and JSON naming.** Both flags intersect: the id must belong to that run or the handler returns `INVOCATION_NOT_FOUND` without emitting a foreign-run row. In-process `InvocationClientView.clientState` stays camelCase; CLI/HTTP JSON uses `toInvocationStatusEnvelope` (`client_state`, `run_id`, …). Integration tests assert snake_case.
5. **Independent heartbeat interval.** `withInvocationLifecycle` starts a rate-limited timer after `register()` and clears it in `finally`. Stream-event heartbeats remain an optimization. Fake-clock tests prove a silent invocation stays fresh past `INVOCATION_STALE_MS` and that the timer is cleared on completion and on error.

---

## Provenance

Implements v2 area #2’s **agent cancellation registry** (`docs/v2/202-control-plane.md` §3.6) from plan input `docs/v2/plan-inputs/05-invocation-registry.plan-input.md`. Honors `200` §3a constraint #5 (opaque handles, no universal PID) and `207-state-segmentation.md` (coordination TTL, not a git record). Replaces the approach in superseded `011-provider-process-lifecycle.md` without inheriting its OpenCode PID/SDK design. Store/CAS/doctor patterns follow `205-prompt-queue-foundation-plan.md`. Suggested next slice: `06-review-budget-advisory.plan-input.md`. Provider-specific adapters, including OpenCode process cleanup, are a **new** plan after this contract is proven.
