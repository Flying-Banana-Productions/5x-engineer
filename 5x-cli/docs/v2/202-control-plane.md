# 5x CLI v2 — Interactive Control Plane

**Status:** Draft — Not Implemented
**Date:** July 13, 2026
**Part of:** v2 (`200-overview.md`, area #2)
**Shared core used:** Run-state surface (`200-overview.md` §3.2); honors forward-compat constraints (§3a)
**Deprecates:** `docs/10-dashboard.md` (v0-era read-only design)

---

## 1. Problem (delta from v1)

v1 has no interactive control surface. The only UI ever planned — `docs/10-dashboard.md` — is **read-only by design**: a standalone Bun HTTP+WebSocket server (port 55555) that reads SQLite + NDJSON logs and never writes. Human decision points flow exclusively through `5x prompt choose/confirm/input` (`src/commands/prompt.ts`), which **blocks on the terminal** where the orchestrating agent runs. Consequences:

- A run can be *observed* from anywhere but *acted on* only from the agent's terminal.
- There is no backward-communication infrastructure — no daemon, no IPC, no agent-process tracking. Agents are owned by the provider (v1 §7.4), so the control plane has no handle on them.
- The read-only invariant was a deliberate choice to avoid write races with the CLI and keep the CLI as sole mutator.

The v2 directive: replace this with a **full control interface** — observe *and* act — without giving up the v1 invariant that the orchestrating agent decides and the CLI is the source of truth, and without foreclosing the future remote/cloud direction (`200-overview.md` §3a).

`docs/10-dashboard.md` is **deprecated** for architecture purposes. Its UI/telemetry detail (information density, streaming log viewer, WebSocket transport, cost/token panels) remains a useful reference for the *presentation* layer; its read-only architecture does not carry forward.

---

## 2. Key inversion: decision-queue prompts

The naive path to a control interface is dashboard→agent signaling. That requires IPC into provider-owned processes and does not survive the jump to remote agents. We invert instead:

> **`5x prompt` writes a pending-prompt row to the control-plane store and polls for an answer**, rather than blocking on the terminal directly. The answer may be written by the **terminal** (unchanged UX) **or** by the **control plane** (native app / dashboard / another machine). First writer wins.

The orchestrating agent's contract is unchanged: it still calls a blocking CLI command and receives a JSON answer. The blocking-CLI semantics *become* the two-way channel. No IPC, no signaling, no daemon-to-agent socket.

This is the keystone of v2's forward compatibility (`200-overview.md` §3a): coordination through shared state is what a cloud-synchronized control plane later replicates. A remote agent calling `5x prompt` writes to the same queue a local one would; whoever answers does not know or care where the agent ran.

```
        ┌──────────────────────────────────────────────┐
        │  Orchestrating agent (local or remote)         │
        │    calls: 5x prompt choose "Proceed?" ...      │
        └───────────────────────┬──────────────────────┘
                                 │ INSERT pending prompt (UUID)
                                 │ then poll for answer
                  ┌──────────────▼───────────────┐
                  │   Control-plane store         │
                  │   (prompts / decisions)       │  ◄── SQLite in v2;
                  │   first-writer-wins via CAS   │      synced store later
                  └───▲───────────────────────▲───┘
       answer from    │                       │   answer from
       terminal TTY ──┘                       └── control plane
                                                  (native app / dashboard / API)
```

---

## 3. Design

### 3.1 Store interface (repository)

Per forward-compat constraint #1 (`200-overview.md` §3a), `5x prompt` and all control-plane write-paths go through a **repository abstraction**, not direct SQLite calls.

- _TODO:_ define the minimal interface — `createPrompt(p)`, `getPrompt(id)`, `answerPrompt(id, answer, by)` (CAS), `listOpenPrompts(runId?)`, plus the run/decision operations control actions need (§3.3).
- v2 ships exactly one impl: SQLite over the existing `.5x/5x.db`. A synced/remote store is a future impl swap, not a command rewrite.
- _TODO:_ confirm existing `src/db/operations-v1.ts` is the right home or whether a new `control-plane/store.ts` layer sits above it.

### 3.2 Prompt / decision tables

Two new tables alongside v1 `runs` / `steps` / `plans` (`src/db/schema.ts`).

**`prompts`** — pending and answered human prompts:

| Column | Notes |
|---|---|
| `id` | **UUID** (constraint #2 — not autoincrement; sync-safe) |
| `run_id` | FK to `runs.id` |
| `kind` | `choose` \| `confirm` \| `input` |
| `message` | prompt text |
| `options_json` | for `choose` — allowed values |
| `default_value` | optional; powers the non-interactive `--default` escape hatch |
| `created_at` | |
| `answered_at` | null while open |
| `answer` | null while open |
| `answered_by` | `terminal` \| `control-plane` \| `default` |

- _TODO:_ decide whether `decisions` is a separate table or just answered `prompts` rows. Leaning: prompts cover the request/answer cycle; unsolicited control-plane actions (abort, reopen) go through §3.3 primitives and land in `steps` as `human:*`, so a separate `decisions` table may be unnecessary. Resolve in design.
- _TODO:_ indices: open prompts by `run_id`; recent prompts for dashboard backfill.

### 3.3 Answer & polling semantics

- **Poll loop.** `5x prompt` inserts an open row, then polls `getPrompt(id)` until `answered_at` is set or timeout. _TODO:_ cadence (e.g. 250–500ms), backoff, max wait.
- **Terminal path preserved.** If a TTY is present, render the prompt locally as today; a local answer calls `answerPrompt(id, …, "terminal")` — the same write the control plane would do. Terminal and dashboard are symmetric writers.
- **Non-interactive `--default`.** Existing escape hatch: if `--default` is set and no answer arrives (or immediately, in CI/no-TTY), resolve with `answered_by = "default"`. _TODO:_ reconcile precedence — does `--default` short-circuit the poll, or seed a fallback after timeout? Recommend: no-TTY + `--default` resolves immediately (preserves CI behavior); TTY waits and a control-plane answer can still win.
- **First-writer-wins = CAS** (constraint #3). `answerPrompt` is a compare-and-swap on `answer IS NULL`; the losing writer gets a "already answered" result and surfaces the winning answer. This is correct locally and remains correct when the store is synced, where last-write-wins would otherwise corrupt the race.
- _TODO:_ timeout behavior when neither side answers and no `--default` — error (current `NON_INTERACTIVE`/EOF semantics) vs configurable wait.

### 3.4 Control actions → existing primitives

The control plane gets no new mutation surface where an existing idempotent primitive already exists. It calls the same operations the orchestrating agent does:

| Control action | Underlying primitive | Lands as |
|---|---|---|
| Answer a prompt | `answerPrompt` (§3.1) CAS | `prompts` row |
| Abort a run | `5x run complete --status aborted` | `run:abort` step |
| Reopen a run | `5x run reopen` | `run:reopen` step |
| Record a human decision/override | `5x run record human:*` | `human:*` step |
| Re-run a quality gate | `5x quality run` | `quality:check` step |

- _TODO:_ whether the HTTP API shells these commands or calls the handlers in-process. Leaning in-process (the server links the CLI lib) to avoid subprocess overhead, but must respect the same store interface so a remote server stays possible.
- **Auth.** Extend the token / HttpOnly-cookie scheme already specified in `docs/10-dashboard.md` to cover write endpoints. _TODO:_ single-token sufficient for local v2; multi-user authz remains out of scope (and is a cloud-service concern, not v2).

### 3.5 Server model

- The v2 server **writes rows; it does not hold agent handles.** The agent polls the store. This keeps the server stateless with respect to agent lifecycle — the property that lets the same server later sit in front of a synced store.
- _TODO:_ reuse vs replace the read path from `docs/10-dashboard.md` (SQLite reads, NDJSON log streaming, WebSocket push). The read path is largely reusable; the delta is the write endpoints (§3.4) and the prompt-answer surface (§3.3).
- _TODO:_ live prompt delivery — push open prompts to connected clients over the existing WebSocket so the operator sees them without polling the UI.

### 3.6 Phase 2 — agent cancellation registry

Aborting a *run* (§3.4) is bookkeeping. Cancelling an *in-flight agent invocation* needs a handle on a provider-owned process, which v1 deliberately does not track.

- Add an invocation registry: when `5x invoke` (or a native delegation) starts, record a handle. _TODO:_ location (`.5x/agents/<session>.meta`) and contents.
- **Opaque handles** (constraint #5). Model a running invocation as a handle that knows how to cancel itself: a local PID is one case; a remote provider container's job id reached by RPC is another. Do not bake local-PID-only assumptions in.
- Unifies with the orphaning gap already flagged in `docs/development/plans/011-provider-process-lifecycle.md` — the same registry that enables operator cancellation enables orphan reaping.
- _TODO:_ graceful-abort vs hard-kill semantics; allow the agent to record a terminal step on cancel. Explicitly **not** a 5x-level daemon owning agent lifecycle — the registry is a handle store, not a supervisor.

---

## 4. Migration / compatibility

- **`5x prompt` contract shift.** Terminal answering is preserved, so interactive use is unchanged. The shift matters only to callers that scripted around the old *block-on-terminal* behavior; document it. Back-compatible in the common case (`200-overview.md` §4).
- **Schema migration** for `prompts` (and `decisions` if separate). New tables only — no change to `runs` / `steps` / `plans` shape, except adopting UUIDs for *new* tables (constraint #2). _TODO:_ decide whether existing autoincrement tables are left as-is (local-only) or migrated; at minimum, all v2-new tables are UUID-keyed.
- **Dashboard.** `docs/10-dashboard.md` deprecated; its read path informs the v2 server, its read-only architecture does not.

---

## 5. Open questions

- _TODO:_ single delivery, or ship read-only server first and add write-paths second?
- _TODO:_ `decisions` table vs answered-`prompts` rows (§3.2).
- _TODO:_ `--default` precedence under the poll model (§3.3).
- _TODO:_ in-process vs subprocess for HTTP write endpoints (§3.4).
- _TODO:_ should the active-run pointer (`204-run-context-ergonomics.md` §2.1) drive a default "focused run" in the control-plane UI?
