# 5x CLI v2 — Overview

**Status:** Draft — Not Implemented
**Date:** July 13, 2026
**Updated:** July 31, 2026
**Builds on:** `docs/v1/100-architecture.md` (v1 remains authoritative until v2 ships)
**Deprecates:** `docs/10-dashboard.md` (v0-era read-only dashboard plan — written without cloud control planes or remote providers in view; replaced by the v2 control plane, see `202-control-plane.md`)

---

## 1. Thesis

v1 established 5x as a **stateless toolbelt**: idempotent CLI primitives, orchestration pushed up into agent skills, persistence in SQLite, sub-agent work behind a pluggable provider interface. That model is sound and v2 does not revisit it.

What v1 left unfinished is the **operator experience around** that toolbelt. In practice four gaps recur:

1. **Silent staleness.** Harness assets (skills, agent profiles) are *compiled* at `5x harness install` time — models and delegation mode are baked into the rendered markdown. Changing provider/model config in `5x.toml` leaves the installed assets stale with **no signal** and no one-step refresh. The user must know, manually, to reinstall — and even a manual reinstall without `--force` refreshes skills but silently skips existing agent files (`201-harness-freshness.md` §1.1).
2. **No interactive control surface.** The only planned UI (`docs/10-dashboard.md`) is read-only by design. Human decision points flow exclusively through `5x prompt`, which blocks on the terminal where the orchestrating agent runs. There is no way to observe a run and *act on it* from anywhere but that terminal.
3. **Dead-end failure modes.** Several errors have no self-service recovery: `PLAN_LOCKED` exposes no holder info, no inspect command, and no force-release when the holding process is live or hung (the primitives auto-steal *dead*-holder locks, but the CLI surfaces none of this — `203-recovery-and-doctor.md` §1.1); `MAX_STEPS_EXCEEDED` fires with no prior warning; remediation hints are dropped in `--text` mode; stale worktree mappings have no repair path. Per-phase ergonomics also force the agent to thread `--run`/`--phase`/`--session` by hand through 8–10 calls.
4. **Unbounded review expansion.** Stronger reviewers repeatedly find valid adjacent issues after each plan revision. The v1 workflow prices no scope growth, treats deterministic but expensive work as `auto_fix`, and asks every continued review to surface new issues. Plans can double in size and implementation surface before the iteration limit finally asks a human. There is no delivery budget, convergence rule, or bounded way to trade additional effort for architecture-debt reduction (`206-review-budget-governance.md` §1).

v2 closes these gaps. The throughline: **5x evolves from a fire-and-forget toolbelt into an interactive, self-healing control plane** — without giving up the v1 invariant that *the orchestrating agent decides and the CLI is the source of truth*.

---

## 2. The Six Areas

| # | Area | Doc | Breaking? |
|---|---|---|---|
| 1 | Harness asset freshness — manifest fingerprint + `5x harness sync` | `201-harness-freshness.md` | No (additive) |
| 2 | Interactive control plane — decision-queue dashboard | `202-control-plane.md` | `5x prompt` contract change; schema migration |
| 3 | Recovery & `5x doctor` — unlock, step warnings, remediation surfacing | `203-recovery-and-doctor.md` | No (additive) |
| 4 | Run-context ergonomics — active-run pointer + composite verbs | `204-run-context-ergonomics.md` | No (additive; flags preserved) |
| 5 | Output normalization — retire grandfathered text-only commands | `205-output-normalization.md` | **Yes** |
| 6 | Review budget governance — bounded scope growth, convergence, and debt credits | `206-review-budget-governance.md` | Workflow/protocol extension |

These are deliberately bundled rather than shipped as six independent PRDs, because they **share infrastructure** (Section 3). Designing them separately would mean redesigning that shared core repeatedly and letting it drift.

---

## 3. Shared Core

Three new primitives underpin multiple areas. They are designed **once, here**, and consumed by the area docs.

### 3.1 Asset manifest (`.5x-manifest.json`)

A small JSON file written **adjacent to installed harness assets** (not in `.5x/`), one per harness install location, recording a hash of every input baked into those assets at install time.

- **Why asset-adjacent, not centralized in `.5x/`:** the manifest's job is to describe what is physically on disk. User-scope assets (`~/.config/opencode/`, `~/.cursor/`) are shared across every repo on the machine, each with its own `5x.toml` — a per-project manifest would desync the moment another project reinstalls user-scope. The stamp must live and die with the assets it describes, travel with them when committed (project scope), and survive `.5x/` deletion. The path is resolved per harness+scope via `src/harnesses/locations.ts`; the **filename, schema, hash function, and compare-logic are uniform** across harnesses (one shared module in the installer layer), so Cursor inherits it for free when its harness plugin lands.
- **Baked inputs hashed:** resolved `authorModel` / `reviewerModel` (after `harnessModels` override), `authorDelegationMode` / `reviewerDelegationMode`, harness plugin version, bundled template/skill version. (See `src/harnesses/opencode/plugin.ts` for the current bake surface.)
- **Consumed by:** #1 (freshness check + `harness sync`), surfaced by #3 (`doctor`).

### 3.2 Run-state surface (new SQLite tables)

v2 adds persistent rows that outlive a single CLI invocation, alongside the v1 `runs` / `steps` / `plans` tables (`src/db/schema.ts`):

- **Pending-prompt / decision queue.** When `5x prompt` is invoked, it writes a pending row and polls for an answer. The answer may arrive from the terminal **or** from the control plane (#2) — first writer wins. This converts the existing blocking-CLI prompt contract into a two-way channel **without** inter-process signaling or a daemon-to-agent socket.
- **Active-run pointer.** A small piece of state (`.5x/current-run`, file or table) set by `5x run init`, recording the run the next command defaults to — git-style implicit context.
- **Review-budget baseline and decisions.** The plan records stable scored work items; the CLI derives an immutable initial baseline, current forecast, and budget status. Run state preserves those calculations plus human budget/scope/risk decisions and the full audit trail (`206-review-budget-governance.md` §6.4).
- **Consumed by:** #2 (dashboard selects on and answers via these), #4 (active-run pointer eliminates most `--run`/`--phase` threading), #6 (budget baselines and tradeoff decisions).

### 3.3 `5x doctor`

A single diagnostic/repair command that is the front door for "why is this broken, what do I run." It hosts the freshness check from #1, the lock/worktree repairs and run/prompt hygiene checks from #3, and DB schema validation.

- **Consumed by:** #1 (freshness surfacing), #3 (recovery actions).

**Dependency note:** #2, #4, and #6 block on 3.2 (run-state surface) → build it first. #1 (3.1) and #3 (3.3) are independent and can land in parallel.

---

## 3a. Forward Compatibility (remote providers + cloud control plane)

v2 ships **local-only**. But a plausible future direction is a native command-center app coordinating **any** project's 5x control plane, with provider invocation that may be local, delegated to provider containers on the LAN, or cloud-hosted (eventually as a service). We are **not designing that system here.** This subsection records constraints the v2 shared core must honor so that future is not foreclosed — all of which are cheap now and expensive to retrofit.

The reason the v2 design is compatible at all: the prompt-queue inversion (§3.2, detailed in `202-control-plane.md`) replaces inter-process signaling with **coordination through shared state**. That is the only model that survives the jump to distributed/async — a cloud-synchronized control plane is essentially replication of that shared state. The future moves along two orthogonal axes, each of which already has an abstraction:

- **Where humans answer** — the prompt/decision queue. Terminal, native app, or another machine are all just *writers to the queue*.
- **Where agents run** — the v1 `AgentProvider` / `AgentSession` interface (`docs/v1/100-architecture.md` §7). A remote provider container is just another provider impl whose `run` / `runStreamed` cross a network transport. The normalized `AgentEvent` stream (v1 §7.8) is already transport-agnostic, so remote event/log streaming falls out.

These axes do not interact badly: a remote agent that calls `5x prompt` writes to the same queue a local one would; the human answering does not know or care where the agent ran.

**Constraints v2 must honor:**

1. **Queue behind a store interface.** `5x prompt` and the decision/dashboard write-paths must go through a repository abstraction, not read/write SQLite directly. SQLite is the first and only v2 impl; a synced/remote store swaps the impl, not the commands.
2. **Globally-unique IDs.** Runs, prompts, and decisions use UUIDs, **not** the local `INTEGER AUTOINCREMENT` the v1 `steps` table uses (`src/db/schema.ts`). Autoincrement rows collide the instant two control planes sync. This is the single most painful thing to retrofit — get it right in the v2 schema from day one.
3. **First-writer-wins = compare-and-swap.** The "first writer wins" answer semantics (terminal vs dashboard, §3.2) must be a CAS on the authoritative store, not a local row insert. Under sync, distributed write races degrade "first row locally" into last-write-wins garbage unless the answer commit is atomic at one point of truth.
4. **"Source of truth" is the control plane, not SQLite.** v1 phrasing ("SQLite is the source of truth") is locally fine but conceptually leaky for v2. Treat the **control plane** as the source of truth and local SQLite as one *materialization* of it. Avoid command logic that assumes the local DB file *is* the plane rather than a view of it.
5. **Invocation handles are opaque.** The agent-cancellation registry (`202-control-plane.md` §3.6) must model a running invocation as an opaque handle that knows how to cancel itself — a local PID is one case; a remote container/job id reached by RPC is another. Do not bake local-PID-only assumptions into the registry.

Constraints 1–3 are good hygiene we would want **regardless** of the cloud future; 4–5 are conceptual guards. None expand v2 scope — they only rule out a few shortcuts.

---

## 4. Versioning Policy

v2 is both a **design epoch** and the **2.0 semver line** — these are kept aligned for now.

The honest accounting of breaking changes is deliberately small:

- **Genuinely breaking:** #5 (output normalization — `init` / `upgrade` / `harness install` begin honoring `--json`/`--text`; `protocol emit` envelope behavior normalized). Any script parsing the old text output is affected.
- **Contract shift (back-compatible in the common case):** #2 changes `5x prompt` from "block on terminal" to "block on queue, answerable from either side." Terminal answering still works; the change matters only to callers that scripted around the old blocking behavior. Carries a schema migration.
- **Everything else (#1, #3, #4):** purely additive — new files, new commands, new warnings, new defaults. Existing flags and call patterns keep working.
- **Workflow/protocol extension (#6):** additive structured fields and plan sections during advisory rollout; enforcement adds deterministic budget routing while preserving `human_required` as the reviewer's semantic judgment signal. Existing mid-review runs remain on v1 routing unless explicitly opted in.

We bump to 2.0 even though the breaking surface is thin, because:

1. The codebase already treats `docs/v0` → `docs/v1` → `docs/v2` as **architecture epochs**, not strict semver gates. Aligning the major version keeps docs and releases legible.
2. The userbase is small enough today that a 2.0 bump neither confuses nor over-promises.

**This alignment is a current convenience, not a permanent contract.** As adoption grows, the epoch number and the semver major may diverge — a future design epoch could ship as a minor, or breaking changes could accumulate into a major without a new epoch. v2 does not commit us to keeping them locked.

Unlike the v1 "clean break" (`docs/v1/100-architecture.md` §8), v2 is **not** a rewrite. It is additive on top of shipped v1 surface, with one deliberate breaking pass (#5) taken under the 2.0 banner rather than dripped out.

---

## 5. Scope

### In scope for v2

- Harness asset manifest + freshness check + `5x harness sync` (#1)
- Interactive control plane: decision-queue `5x prompt`, dashboard write-paths mapped to existing primitives, agent-cancellation registry (#2)
- `5x doctor`, `5x unlock`, step-count warnings, `--text` remediation surfacing (#3)
- Active-run pointer + composite verbs (#4)
- Output normalization of grandfathered commands (#5)
- Review budget governance, convergence rules, and bounded architecture-debt credits (#6)

### Not in scope

- Multi-repo / multi-user orchestration (unchanged from v1)
- New provider categories (Category 2/3 from v1 §7.6)
- New workflow skills beyond the v1 three
- General-purpose technical-debt discovery or standalone refactoring programs; #6 only credits simplification directly coupled to planned work
- Replacing the provider process model — agent cancellation (#2) adds a process registry but does **not** introduce a 5x-level daemon owning agent lifecycle

---

## 6. Document Map

| Doc | Contents |
|---|---|
| `200-overview.md` (this) | Thesis, the six areas, shared core, versioning policy, scope |
| `201-harness-freshness.md` | Manifest schema, hashed inputs, asset-adjacent placement, `harness sync`, where checks fire |
| `202-control-plane.md` | Prompt-queue contract, decision/prompt tables, dashboard write-paths, agent-cancellation registry |
| `203-recovery-and-doctor.md` | `unlock`, step-count warnings, `--text` remediation, `doctor` checks/repairs |
| `204-run-context-ergonomics.md` | Active-run pointer, composite verbs, pipe-context de-emphasis |
| `205-output-normalization.md` | Grandfathered-command normalization + migration notes |
| `206-review-budget-governance.md` | Delivery budgets, review convergence, debt credits, protocol and human-gate changes |
