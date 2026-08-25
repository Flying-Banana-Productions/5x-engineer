# 5x CLI v2 — Run-Context Ergonomics

**Status:** Implemented — see plan `docs/development/plans/204-run-context-ergonomics-plan.md`
**Date:** July 13, 2026
**Updated:** August 24, 2026
**Part of:** v2 (`200-overview.md`, area #4)
**Shared core used:** Active-run pointer (`200-overview.md` §3.2)

---

## 1. Problem (delta from v1)

The v1 primitives are deliberately granular, and the orchestrating agent is their primary caller. In practice a single phase costs **8–10 CLI calls** (`run init` → `template render` → launch subagent → `protocol validate --record` → `quality run` → `commit` → reviewer render/launch/validate → …), each threading `--run`, `--phase`, `--iteration`, `--session` by hand. Every flag is:

- extra tokens on every tool call the agent makes,
- an opportunity to mis-thread (wrong run id, stale phase, skipped `--record`),
- prose in the skills spent on plumbing instead of judgment.

The alternative channel — piping envelopes between commands (`src/pipe.ts`) — has a structural weakness: because harness contexts leave stdin piped-but-empty with no EOF, `readUpstreamEnvelope()` races the first read against a **200ms timeout** and **silently assumes no upstream** on expiry (`src/pipe.ts:94-113`). A slow upstream (provider startup, cold quality gate) silently drops context rather than failing loudly. The timeout is a documented tradeoff, not a bug — but it means the pipe channel can never be the reliable default for context passing.

Meanwhile, run-scoped resolution is already centralized: `resolveRunExecutionContext` (`src/commands/run-context.ts`) is the single source of truth mapping run id → effective working directory, worktree, and plan path. Everything downstream of the run id is solved; **only the run id itself is manually threaded.**

---

## 2. Design

### 2.1 Ambient run resolution

Commands that take `--run` may default it from ambient state when the flag is omitted. Ambient resolution is a CLI/operator convenience, not authoritative run identity for queued or remote execution.

**Resolution precedence (strict):**

1. Explicit `--run <id>` — always wins (unchanged v1 behavior).
2. `FIVEX_RUN` environment variable — session-scoped override.
3. Current linked-worktree association — if the command is running in a linked worktree and exactly one active run is mapped to that checkout through `plans.worktree_path`, use it.
4. Active-run pointer — `.5x/current-run` by default (the configured control-plane state root's `current-run` file), written by `5x run init`, only when it does not conflict with the current linked-worktree context.
5. Piped upstream `run_id` (`run record` / `invoke` only).
6. None → required-run commands error (`RUN_CONTEXT_REQUIRED`) with remediation naming the applicable mechanisms; optional-run commands keep their no-run path.

`--plan` remains an explicit alternative selector on commands that already support it (for example, `run state --plan`) and is resolved before ambient run context.

**Linked-worktree rules:**

- Compare checkout and mapped worktree paths by canonical physical identity so symlinks, nested working directories, and externally attached worktrees resolve consistently.
- One mapped active run selects that run without consulting the shared pointer. This allows worktrees A and B to resolve different runs while sharing one root `.5x` control plane.
- More than one mapped active run is ambiguous and fails with the candidate run ids plus remediation to pass `--run` or set `FIVEX_RUN`. The pointer does not break this tie.
- With no mapped active run, a linked worktree must not consume a pointer for a run mapped to another checkout. A stale, missing, terminal, or incompatible pointer fails with actionable remediation rather than silently selecting unrelated work.
- Explicit `--run` and `FIVEX_RUN` may intentionally select a run mapped elsewhere; existing run execution-context resolution then moves execution to that run's mapped worktree. Worktree awareness constrains only implicit fallback.

**Pointer mechanics:**

- `5x run init` writes the new/resumed run id to the control-plane state root's `current-run` file (plain text, one id; `.5x/current-run` by default). `5x run complete` clears it **iff** it still points at the completed run.
- The pointer remains a single file at the local control-plane state root: trivially inspectable (`cat .5x/current-run`), migration-free, and consistent with `.5x/locks/`. It records the control plane's last operator-focused run; it is not a per-worktree registry and is not durable workflow state.
- `5x run state` (no args) resolves via the same precedence, making "what am I working on?" zero-flag.
- Surface the ambiently resolved marker and its source (`environment`, `worktree`, or `pointer`) in `5x run list` output without conflating it with the run's persisted `active` status.

**Concurrency boundary:** distinct linked worktrees do not depend on the shared pointer and therefore do not collide. Multiple sessions intentionally operating from the same checkout still need session identity; this is why `FIVEX_RUN` sits above ambient filesystem state. A harness session driving run A exports `FIVEX_RUN` once and is immune to run B re-pointing the file. Skills `export FIVEX_RUN` right after `run init` — one line replacing per-command `--run` threading.

`5x run init` includes additive `export_hint: "export FIVEX_RUN=<id>"` on the success envelope so callers can `eval` the hint. Skills still export explicitly.

**What defaults, what doesn't:**

- `--run` defaults through the shared ambient resolver everywhere `resolveRunExecutionContext` is used (`invoke`, `run record/state/complete/reopen`, `quality run`, `commit`, `diff`, `template render`, `protocol validate`, `phase finish`).
- `--phase` / `--iteration` are **not** defaulted. Defaulting phase from "latest recorded step's phase" is tempting but risky (a stale phase silently mis-records a step; idempotency keys include phase, so a wrong default is a *wrong write*, not an error). Revisit after composites see production use.
- `--session`: not defaulted — session continuity has deliberate explicit semantics (`--session` / `--new-session`, `docs/v1/100-architecture.md` §3) and auto-defaulting would blur the recovery escape hatch.

### 2.2 Composite verbs

Collapse the hottest fixed sequences into single commands with one envelope. Candidates, in priority order:

**`5x phase finish`** — the post-author convergence sequence (shipped):

1. `quality run` (all gates; record only on pass/skip)
2. `protocol validate author --record` (from `--input` / stdin; `--no-phase-checklist-validate` for this half)
3. phase checklist validation **only when** the author `result` is `"complete"` (otherwise the checklist sub-step is `skipped`)
4. single envelope: every sub-step's status (`completed` / `failed` / `skipped`), recorded step ids, failing step's full error + remediation

Required flags: `--phase`, `--iteration`, `--step`. `--run` is ambient-resolved. Exit code is the failing sub-step's existing code (`QUALITY_FAILED`, `INVALID_STRUCTURED_OUTPUT`, `PHASE_CHECKLIST_INCOMPLETE`, …) — not a composite-only code.

**`5x phase start`** — deferred. Evaluate later: `template render` + session-continuity check + (delegation-mode-aware) prompt assembly. Value is lower — rendering is already one call — but it could own phase-number derivation from `plan phases`. Measure remaining `template render` overhead first.

**Rules for composites:**

- **Sugar, not new semantics.** A composite calls the same handlers as the granular commands and records the same steps with the same idempotency keys. The granular primitives remain the contract; skills can always drop down. This preserves v1's "each command independently useful" invariant (`docs/v1/100-architecture.md` §3, Layer 2).
- **Fail-forward error envelope.** If a sub-step fails, the composite stops, and the envelope reports every sub-step's status (`completed` / `failed` / `skipped`), the failing step's full error + remediation, and — because steps are idempotent — re-running the composite resumes past already-recorded steps for the same `(run, phase, iteration)`. Partial state is not rolled back; it is *reported*.
- **Exit code = failing sub-step.** Propagate `exitCodeForError(code)` of the failing sub-step rather than a dedicated composite code.

### 2.3 Pipe-context de-emphasis

With explicit/session identity, worktree inference, and the focus pointer covering interactive run resolution, while composites collapse multi-command sequences, the pipe channel (`src/pipe.ts`) stops being load-bearing for context:

- Keep `--var @-` / explicit stdin *data* input (results into `protocol validate`) — that is payload, not context, and has no silent-drop problem.
- Implicit context extraction (`extractPipeContext` / `readUpstreamEnvelope`) stays for back-compat. The *silent* timeout is gone: if stdin is piped and the 200ms race expires, emit a one-line stderr warning that upstream context was not detected. stdout is unchanged (null envelope / command continues). TTY stdin stays silent.

### 2.4 Skill updates

The bundled skills (OpenCode + Cursor, via `src/skills/base/*.tmpl.md`) use the new idiom:

- `export FIVEX_RUN` after `run init`; drop per-command `--run` in the happy path.
- Use `phase finish` in the phase-execution hot loop; keep granular fallbacks (`quality run`, `protocol validate --record`, `run record`, `commit --run`) in the recovery prose.

---

## 3. Forward compatibility

Per `200-overview.md` §3a #4: the active-run pointer is **local control-plane operator focus, not authoritative workflow state**. It is not synced, carries no UUID/CAS requirements, and different machines attached to the same future cloud control plane may correctly hold different focus pointers. The control-plane UI's "focused run" (`202-control-plane.md` §5) is likewise a view concern that may read the pointer locally but must not treat it as authoritative shared state.

Worktree inference is also local materialization awareness, not logical run identity. Prompt-queue and invocation-registry workers receive an explicit `run_id` and must not call the ambient resolver. `.5x/current-run` and CWD inference are not dispatch or ownership mechanisms. Whether the worker executes in a git worktree, container, dedicated VM, or remote sandbox is an orthogonal execution-target concern; workers must not use `.5x/current-run` or CWD inference to discover which invocation they own.

Composite verbs are pure CLI sugar over primitives and inherit whatever store the primitives use — nothing to guard.

---

## 4. Migration / compatibility

Fully additive:

- Explicit `--run` call sites behave identically (precedence rule 1).
- A linked worktree with one mapped active run gains a new implicit default. Without a unique association or pointer, missing `--run` reproduces the v1 error behavior.
- The pointer file is new and remains a singleton convenience; no per-worktree state or schema migration is introduced.
- Composite verbs are new commands; no granular command changes shape.
- Pipe-context extraction unchanged except a new stderr visibility note when the implicit 200ms read times out.

---

## 5. Open questions

- Default `--phase` from latest step — remains deferred; revisit post-composites in production (§2.1).
- `phase start` composite — worth it, or is `template render` sufficient (§2.2)? Measure remaining plumbing first.
- Does the control-plane UI read the local pointer for initial focus, or maintain its own selection only (§3, `202` §5)? Dashboard reading the pointer is a later slice.
