# 5x CLI v2 — State Segmentation: Repository Records and the Control Plane

**Status:** Implemented — local working-tree records; remote plane still deferred
**Date:** August 28, 2026
**Updated:** September 3, 2026
**Part of:** v2 (`200-overview.md`, area #7)
**Shared core used:** Run-state surface (`200-overview.md` §3.2); refines forward-compat constraint #4 (§3a)
**Refines:** `202-control-plane.md` §3.1 (store interface), `203-recovery-and-doctor.md` §3 (locks are per-machine), `204-run-context-ergonomics.md` §3 (local materialization vs. logical identity), `206-review-budget-governance.md` §6.4 (run-state records)
**Implementation plan:** [`docs/development/plans/212-git-native-run-records-plan.md`](../development/plans/212-git-native-run-records-plan.md) (plan input: `plan-inputs/10-git-native-run-records.plan-input.md`)

---

## 1. Problem (delta from v1/v2)

v1 made SQLite the persistence layer and v2 (`200-overview.md` §3a #4) corrected the phrasing: *the control plane is the source of truth; local SQLite is one materialization of it*. That is right for coordination state, but it leaves a gap that shows up today, before any remote control plane exists:

### 1.1 Progress is invisible off the machine that made it

`5x plan list` and `5x plan phases` derive progress from the plan markdown's checklist (`src/parsers/plan.ts`), re-rooted to the mapped worktree copy when `plans.worktree_path` is set (`src/commands/plan-v1.handler.ts`), and decorate it with run status from the local DB. Both inputs are per-machine:

- The checked plan file lives on the `5x/<slug>` branch (`branchNameFromPlan`, `src/git.ts`) and in that branch's worktree. A fresh clone, a second machine, or a teammate's checkout sees the unchecked copy on `main`.
- `runs`, `steps`, `plans`, and every future `prompts` / budget row live in `.5x/5x.db`, which never leaves the machine.

So "what is the status of plan X" has a different answer on every clone, and the answer on the machine that did the work is lost if that machine's `.5x/` is deleted. Nothing in v2 slices 1–9 changes this: they add coordination state to the same local store.

### 1.2 The control plane is asked to hold two kinds of state

The tables in `src/db/schema.ts` (and the ones v2 adds) mix two things with different lifetimes, consistency needs, and audiences:

| Kind | Examples | Needs |
|---|---|---|
| **Record** — what happened and what was decided | phase checklist, reviewer verdicts, quality results, run summary, human decisions, budget baselines (`206` §6.4) | Durable, attributable, travels with the code, reviewable in a PR, must outlive any service |
| **Coordination** — what is happening now and who may act | plan locks (`.5x/locks`), active-run status, open prompts (`202`), invocation handles (`202` §3.6), the focus pointer (`204`) | Atomic across actors, TTL/heartbeat, worthless a week later |

Putting both behind one "control plane" store means a future remote control plane must be the system of record for engineering history *and* a lock service, which raises its availability and durability bar for no benefit — and means teams that need no concurrency still need a server to see their own history. Conversely, pushing coordination into git (claim files, commit-per-event) turns a version-control system into a lock manager with a fetch→push race window. Neither extreme is right. The segmentation has to be explicit.

### 1.3 Existing hooks that make the split cheap

- `steps.head_commit` already binds every recorded step to a commit (schema v5).
- `5x commit` is a CLI primitive; the CLI already controls what goes into phase commits.
- `branchNameFromPlan` / `isBranchRelevant` already define the branch convention; `plans.branch` is the override.
- `202` §3.1 mandates a store interface; `205-prompt-queue-foundation-plan.md` establishes `src/control-plane/` as the layer that owns it.
- Reviews are already committed under `paths.reviews` — there is precedent for committing agent output.

---

## 2. Design

### 2.1 The segmentation rule

Every piece of 5x state lives in exactly one of four tiers. The tier is decided by two tests:

1. **Would two actors need to agree about it within the same second?** → *Coordination* (control plane).
2. **Would you want it in an audit of how the code came to exist?** → *Record* (repository).

Otherwise it is *telemetry* (large or sensitive detail, kept behind a pointer) or *local* (per-workspace convenience).

| Tier | Lives in | Authoritative for | Lifetime |
|---|---|---|---|
| **Record** | The git repository, committed on the plan branch, merged with the code | Completed work: what was recorded, verified, decided | Forever (repo history) |
| **Coordination** | The control plane (local `.5x/` store in v2; a remote service later) | In-flight work: leases, open prompts, live run status, invocation handles | Until lease expiry / run terminal |
| **Telemetry** | Local log dir in v2; a blob/telemetry store attached to the control plane later | Transcripts, full agent output, streaming logs | Retention policy |
| **Local** | `.5x/` per workspace, gitignored, never synced | Focus pointer, worktree mappings, caches, offline lock fallback | Until the workspace is discarded |

**Conflict precedence.** For *completed* phases the record wins: a commit exists or it doesn't. For *in-flight* state the control plane wins. A control plane that observes a record contradicting its in-flight view reconciles toward the record, never the reverse.

**Rebuildability asymmetry.** The record-derived slice of the control plane (run summaries, phase progress, approvals, budget baselines) must be rebuildable from the repository. The repository is never rebuildable from the control plane. This is what makes the control plane replaceable and what lets a fresh clone answer "what is the status of plan X" with no server at all.

### 2.2 Mapping today's state

| State (today) | Tier | Notes |
|---|---|---|
| Plan markdown, checklist boxes | Record | Unchanged. |
| Reviews under `paths.reviews` | Record | Unchanged. |
| `steps` rows: `step_name`, `phase`, `iteration`, `result_json` (verdict/status), `head_commit`, `duration_ms`, `tokens_*`, `cost_usd`, `model` | Record (summary) | Appended to the run record (§2.3), plus `patch_id` and a diff summary (§2.3) so the line stays verifiable after a squash merge. `session_id` and `log_path` are **not** recorded — they are telemetry pointers, not history. |
| `runs`: `id`, `plan_path`, `config_json`, `created_at` | Record | Written at `run init`, sealed at `run complete` with terminal status and final `head_commit`. |
| `runs.status = active`, heartbeat | Coordination | The run-active fact is a lease, not a record. |
| Phase approval / readiness (v2 `phase_progress`-style state) | Record, **derived** | Not stored: derived from the latest reviewer verdict step plus any `human:*` decision for that phase. Storing it would create a second writable copy. |
| `.5x/locks/*.lock` | Coordination | A lease on `(repo, plan-slug)`; PID-based locally (`203` §3). Remains as the offline fallback when no remote plane is configured. |
| `plans.worktree_path` | Local | Materialization of *this* machine's checkout. |
| `plans.branch` | Record-adjacent config | Override for the branch convention; discoverable from git otherwise. |
| `.5x/current-run` | Local | Per `204` §3, explicitly not shared state. |
| `prompts` (open) | Coordination | `202` — CAS-answered queue. |
| `prompts` (answered, `human:*` steps) | Record | A human decision that gated work is history: snapshotted into `decisions.jsonl` (§2.3) at the next record commit. The queue row itself is not the record. |
| Invocation registry (`202` §3.6, slice 05) | Coordination | Opaque handles, TTL. Terminal outcome of an invocation is already a step. |
| Review-budget baseline `B0`, governing `B`, work-item ledger, human budget/scope/risk decisions (`206` §6.4) | Record | See §2.6 — refines `206`'s "control-plane state, not editable prose": a machine-written committed record, tamper-evident via git history. |
| Review-budget forecast, current `W/R/S/N/D/E/A/P` | Coordination, **derived** | Recomputed from the record + plan; cached, never authoritative. |
| Agent logs, transcripts | Telemetry | Gitignored; pointer only. |

### 2.3 The run record on disk

Records live under a configurable, git-tracked root, keyed by plan slug and run id:

```
<paths.records>/                       # default: docs/development/runs
  <plan-slug>/
    <run-id>/
      run.json          # summary: id, plan_path, config_json, created_at,
                        #   sealed_at, status, final_head_commit, cli_version,
                        #   format_version, creator, sealer, optional materializer
      steps.jsonl       # append-only, one line per recorded step (§2.2 fields)
      decisions.jsonl   # append-only: answered prompts + human:* steps
      budget.jsonl      # append-only opaque stream for slice 06 (review budget)
```

Rules:

- **Append-only streams, per-run directories.** Two runs never touch the same file; JSONL lines are independent. `.gitattributes` marks `*.jsonl` under the records root `merge=union` so a rare merge of parallel iterations never conflicts. `run.json` is rewritten only at `run init` and `run complete`, both under the plan lease.
- **Written where the step is recorded, committed with the code.** `run record` / `phase finish` / `protocol validate --record` append to the record in the run's effective working directory (the worktree) at the same time they write the local store. `5x commit` always stages the records root, so a phase's steps land in the phase commit — atomic with the code they describe. Steps recorded after the last `5x commit` of a run (final reviewer verdict, `run complete`) are committed by `run complete` as a dedicated `5x: seal run <id>` commit.
- **Dirty-tree safety exempts the records root.** `checkGitSafety` (`src/git.ts`) must treat uncommitted changes under `paths.records` as expected, otherwise every `run record` would block the next agent invocation. Nothing else about the safety check changes.
- **Idempotency key is unchanged.** `(run_id, step_name, phase, iteration)` still dedupes; re-recording an existing step does not append a duplicate line. The local store remains the fast path for that check; on a fresh clone the check is rebuilt from the record (§2.5).
- **Squash-merge safe by design.** `5x/*` branches are commonly squash-merged, so intermediate commits vanish. Records are content, not commits, and survive; but `head_commit` in `steps.jsonl` then points at commits that no longer exist. Each step line therefore also carries `patch_id` (`git patch-id --stable` of the diff between the previous recorded step's `head_commit` and this one, computed at record time while both exist) and `diff_summary` (`{ files_changed, insertions, deletions }`). A step remains verifiable against the squashed result by patch-id even when its commit is gone; `plan phases --verbose` labels unreachable `head_commit` values as informational rather than erroring.
- **Provenance.** Every JSONL line (`steps`, `decisions`, `budget`) carries `schema_version` and `provenance: "recorded"` (written at record time) or `"backfilled"` (exported later, §2.7). Provenance is how the line entered the record. It is not origin, and it is not Git commit author/committer (squash-merges rewrite those).
- **Origin envelope (recorder vs performer).** Every recorded line also carries a versioned `origin` object so reconstructed history answers "who recorded this, and who performed it" without relying on Git attribution:
  - **Recorder** — a random `installation_id` (UUID v4) from a user-scope identity file outside the repository (`$XDG_CONFIG_HOME/5x/identity.json` or `%APPDATA%/5x/identity.json`, overridable via `FIVEX_CONFIG_HOME`), plus an optional operator-chosen `actor` label (`FIVEX_RECORDS_ACTOR` → `records.actor` → identity-file `actor`). `installation_id` is a correlator for one CLI install, not a person.
  - **Performer** — `human` | `agent` | `system`, with `role` / `provider` when known (e.g. agent author/reviewer with the configured provider; CLI steps `system`/`cli`; answered prompts `human`/`operator`).
  - Live writers construct origin only through `originFor` (already redacted). `run.json` `creator` (init) and `sealer` (complete) are **summary-only** and may be `null` when unknown. Seal preserves `creator` including `null` and sets `sealer` to this installation.
  - Backfill writes `origin: null` (original recorder/performer unknown) and a separate `materializer` for the exporter (`performer.kind: "system"`, `role: "exporter"`). Summary `creator`/`sealer` stay `null`; the exporter is summary `materializer` only — never copied into `origin`, `creator`, or `sealer`. Text/JSON output surfaces the exporter as `exported_by`.
- **Privacy default.** `tokens_*`, `cost_usd`, and `model` are recorded (they are summaries, and useful history); `session_id`, `log_path`, and transcript content are not. Origin never records hostname, hardware ID, OS username, or Git `user.name` / `user.email`. A `records.redact` config list allows dropping additional fields for public repositories — including `origin.actor`, which `originFor` / `redactedRecorder` omit from step/decision/budget lines **and** from `run.json` `creator`/`sealer`. Teams with public repositories should omit `actor` or add `origin.actor` to `records.redact`.
- **Newer `run.json` is read-only for this CLI.** `format_version` is a number; this slice writes `1`. A summary with `format_version > 1` is readable for display/index when v1 required fields are present, but `putRun` / `run complete` / abort refuse mutation (`UNSUPPORTED_FORMAT_VERSION`). Completion **version-checks before any terminal append**, so a rejected seal cannot leave a `run:complete` / `run:abort` line beside an untouched newer summary.

### 2.4 Reading the record from git: progress resolution

`plan list` / `plan phases` (and `run state --plan`) stop assuming the checked-out copy is current. For each plan slug:

1. **Candidate refs**, in order: mapped worktree working copy (unchanged from today) → local `5x/<slug>` → each remote's `5x/<slug>` → `plans.branch` if set → `HEAD`. Non-conventional branches are ignored unless mapped; `--all-refs` opts in to `git log --all -- <path>` discovery.
2. **Per candidate**, take the last commit that touched the plan file or the records directory for that slug (`git log -1 --format=%H <ref> -- <plan-path> <records-path>`). Dedupe by commit.
3. **Prune ancestors.** Drop any candidate that is an ancestor of another (`git merge-base --is-ancestor`). This handles the awkward cases without special rules: a merged branch collapses into `main`; a stacked branch that never touched plan B contributes plan B's base commit, which dedupes away; a HEAD that descends from the plan branch wins outright.
4. **Exactly one survivor** → read plan + records from that commit via `git show <sha>:<path>` (no checkout). **Multiple survivors** → the plan is `diverged`; report all sources, display the max checklist progress (completion is monotonic) and flag it. Never silently pick.
5. **Surface provenance.** Output gains `source` (`worktree` / `5x/<slug>` / `origin/5x/<slug>` / `HEAD` / `diverged`) and, for remote-tracking sources, the age of the ref's tip commit. When the source is not the checked-out file, say so — users will otherwise open the file, see unchecked boxes, and distrust the tool.
6. **No implicit network.** Remote-tracking refs are as fresh as the last fetch. `--fetch` performs `git fetch <remote> 'refs/heads/5x/*'` first; a list command never fetches on its own.

Plans that exist *only* on a branch (new plan, not yet on `main`) are discovered by the same walk over `5x/*` refs and listed with their source, so a fresh clone sees in-flight plans it has never checked out.

### 2.5 The local store becomes an index

SQLite is retained — every v2 slice builds on it, and it is the right fast path — but its record-derived tables are demoted to a **rebuildable index**:

- `5x records index [--plan <slug>]` (also run by `doctor --fix` when the index is missing or behind) walks the resolution in §2.4 for each plan and re-materializes `runs` / `steps` rows from `run.json` / `steps.jsonl`. It is idempotent and never overwrites a row that has a *newer* local-only step (in-flight work on this machine).
- `doctor` gains a `records` check: index rows with no corresponding record line (a record write failed or was never committed), record lines with no index row (fresh clone), and `head_commit` values unreachable from any known ref (reported only).
- Coordination tables (`prompts`, locks, invocation registry) are **not** indexed from git; they have no record counterpart by construction.

Deleting `.5x/` on a machine now loses only coordination and local state — which is exactly the state that should be lost with the workspace.

### 2.6 Reconciliation with existing area docs

- **`200-overview.md` §3a #4** — *"Source of truth is the control plane, not SQLite."* Refined, not reversed: the control plane is the source of truth **for coordination state**; the repository is the source of truth **for the record**; SQLite is a materialization of both. Constraint #1 (store interface) is unaffected — the record writer is one more consumer behind `src/control-plane/`, and `RecordStore` is a sibling of `PromptStore`, not a replacement.
- **`202-control-plane.md` §3.4** — control actions still map to existing primitives; the primitives now also append record lines. The dashboard's read model (`04-control-plane-dashboard`) reads the index, not git, and is unchanged. Answered prompts are snapshotted into `decisions.jsonl` (§2.2); the `prompts` table is not the durable record.
- **`203-recovery-and-doctor.md` §3** — locks stay PID-based and per-machine as the *offline* coordination fallback. When a remote control plane exists, `acquireLock` becomes one impl of a lease interface; liveness routes through the invocation registry as `203` already anticipates. No change now beyond the `records` doctor check.
- **`204-run-context-ergonomics.md` §3** — fully consistent: the pointer and worktree inference are *local* tier. Ambient run resolution never consults the record.
- **`206-review-budget-governance.md` §6.4** — the baseline `B0`, governing `B`, ledgers, and human decisions are *record* tier. `206`'s concern ("not merely editable plan prose") is satisfied differently: the record is machine-written, committed, and any hand edit is a visible diff in history rather than an undetectable DB write. Derived forecasts remain control-plane cache. `06-review-budget-advisory` codes against the `RecordStore` interface from day one (using the in-memory implementation until this area's working-tree implementation merges), so budget rows never exist as SQLite-only state needing a later migration. The interface is therefore defined and frozen **first**, as the opening phase of slice 10, and published to slice 06 before either slice's persistence work proceeds.

### 2.7 Backfilling existing history

Runs recorded before this area lands exist only in local `.5x/5x.db` files. `5x records backfill [--plan <slug>] [--target auto|<branch>] [--dry-run]` exports them into the record format so history is not stranded on the machine that made it.

- **Pure export.** Reads `runs` / `steps`, applies the §2.3 field policy and `records.redact`, writes `run.json` / `steps.jsonl` / `decisions.jsonl`. It never touches coordination state and never invents a terminal status: runs still `active` in the DB are exported as `status: active` with `backfilled: true`, for a human (or `doctor`) to seal.
- **Target-branch rule (`--target auto`).** If `5x/<slug>` exists locally or on a remote, records go to that branch — through its mapped worktree if one exists, otherwise a temporary worktree — as a `5x: backfill records for <run-id>` commit. If the branch is gone (merged and deleted), records go to the current branch in one aggregate `5x: backfill records` commit. `--dry-run` prints the run → target mapping and file list without writing.
- **Degraded provenance is explicit.** `patch_id` is computed only when both the previous step's and this step's `head_commit` are reachable; otherwise it is `null`. Every backfilled line carries `provenance: "backfilled"` (live lines carry `provenance: "recorded"`) so consumers never mistake exported rows for contemporaneous evidence. Original origin is unknown: lines have `origin: null` plus a separate exporter `materializer`. `run.json` `creator` is `null`; terminal exports also set `sealer: null` and still set `sealed_at` / `status` from the SQLite row. The exporter is never copied into `origin`, `creator`, or `sealer`.
- **Idempotent and merge-friendly.** Steps already present in the target's record are skipped by idempotency key, so machines that each hold part of a plan's history (A did phases 1–3, B did 4–5) can backfill independently and `merge=union` combines them. A DB row that *disagrees* with an existing record line on the same key is reported, never overwritten.
- **Runs without a plan branch and without `head_commit`** (pre-schema-v5 rows) are exported with `head_commit: null`; `plan list` shows them as `source: backfilled` rather than hiding them.

### 2.8 What the remote control plane is left to do

By construction, a future remote control plane is a small service with no plan semantics:

- **Leases** on `(repo, plan-slug[, phase])` with holder identity, heartbeat, and TTL.
- **Run registry** for in-flight runs (status, current phase/state, heartbeat).
- **Prompt queue** (`202`) with CAS answers — the same interface, remote impl.
- **Invocation registry** (slice 05) — the same interface, remote impl.
- **Event stream** for live dashboards.
- **Telemetry/blob store** for logs and transcripts, referenced by run id.

It never parses a plan, computes a budget, or decides whether a phase is complete; all of that reads the record. Its durable slice (run registry) is rebuildable from the record. Teams that do not need cross-machine concurrency run without it and lose nothing durable. **This document does not design that service**; it fixes the contract so the service can be small when it is designed.

---

## 3. Forward compatibility

- **Identity crosses both ways.** Run ids are already UUIDs (v1); step identity is the existing idempotency key, not the autoincrement `steps.id`, so record lines carry no local-only ids (constraint #2). Record entries reference commits; the control plane references run ids and plan slugs.
- **Offline is a first-class mode, not a degraded one.** With no remote plane configured, coordination is local locks and the record is git — which is v2 today. When a remote plane is configured but unreachable, the CLI may proceed with local leases only if `coordination.allowOffline` is set, tagging the run `coordination: local` in `run.json`; on reconnect, lease conflicts are surfaced to a human, never auto-resolved.
- **Git as a lock is out of scope.** Push-rejection-as-CAS (claim files) is deliberately not used for coordination: its race window is acceptable at phase granularity but it requires network at claim time and a shared remote, and it puts churn in history. If a lightweight cross-machine advisory claim is ever wanted without a service, it is a separate design.
- **Ref-namespace records are a reserved option.** Storing records under `refs/5x/*` (git-notes style) would remove working-tree noise at the cost of custom fetch refspecs, `cat-file`-only reads, and invisibility on hosting UIs. §2.3 chooses the working tree; the `RecordStore` interface must not assume a working-tree path so this can change.

---

## 4. Migration / compatibility

- **Additive.** New config (`paths.records`, `records.redact`, `records.actor`; `coordination.allowOffline` remains reserved), new files under the records root, new `records index` / `records backfill` commands, new doctor `records` check, new `source` (and related) fields on `plan list` / `plan phases` / `run state --plan` envelopes. No existing envelope field names change; `--json` consumers that ignore unknown fields are unaffected.
- **Existing runs.** Runs recorded before this lands have no record on disk. `5x records backfill` (§2.7) exports them from the local DB to the plan branch or current branch with explicit `provenance: backfilled`. Not required; history without a record simply shows `source: local-index` in `plan list`.
- **Dirty-tree exemption** for the records root is the only behavior change to an existing safety check; it is scoped to that path.
- **`.gitattributes`** entry for `merge=union` is written by `5x init` / `5x upgrade` when the records root is created.

---

## 5. Decisions

Resolved August 28, 2026:

- **Records root is a sibling of the plans tree** (`docs/development/runs/`, configurable via `paths.records`), not nested under `paths.plans` and not a ref namespace. The `RecordStore` seam keeps the ref-namespace option open.
- **Squash merges are the common case.** Step lines carry `patch_id` and `diff_summary` in addition to `head_commit` (§2.3); unreachable commits are informational.
- **Slice 06 proceeds in parallel** against the frozen `RecordStore` interface with the in-memory implementation; the interface is the first deliverable of slice 10 (§2.6).
- **Privacy default:** `cost_usd`, `tokens_*`, and `model` are recorded; `session_id`, `log_path`, and transcripts never are; hostname / hardware ID / OS username are never origin; `records.redact` may drop `origin.actor` (and applies to `run.json` creator/sealer via `redactedRecorder`).
- **Seal commit (open question 1, implemented).** Post-commit steps (final reviewer verdict, `run complete`) land in a dedicated `5x: seal run <id>` commit when record files remain uncommitted. They are not folded into a later `5x commit` that may never come.
- **SQLite stays the index (open question 2, implemented).** Record-derived `runs` / `steps` are rebuildable from git via `5x records index`. SQLite is not dropped.

## 6. Open questions

1. **`--fetch` default (`plan.autoFetch`).** §2.4 says never fetch implicitly. A `plan.autoFetch` config for teams that want `plan list` to always reflect the remote is cheap; is it wanted? **Deferred** — `--fetch` remains explicit.
2. **Lease interface timing.** `203`'s PID locks become one impl of a lease interface when a remote plane exists. Defining that interface now (unused remote impl) vs. when the remote design lands — leaning: later, to avoid speculative abstraction. **Deferred** with the remote plane.
