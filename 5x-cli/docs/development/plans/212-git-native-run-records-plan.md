# Git-Native Run Records and Progress Resolution

**Version:** 1.4
**Created:** August 31, 2026
**Last updated:** August 31, 2026
**Status:** Draft — pending staff engineer re-review (P0.5)

---

## Executive Summary

Completed-work history today lives in two per-machine places: the checked-out plan markdown and `.5x/5x.db`. A fresh clone, a teammate, or a deleted `.5x/` cannot answer "what is the status of plan X." This slice commits that history to the repository as append-only run records (`run.json`, `steps.jsonl`, `decisions.jsonl`) on the plan branch, makes `plan list` / `plan phases` / `run state --plan` resolve progress from the most advanced git ref rather than the checked-out file, and demotes SQLite `runs` / `steps` to a rebuildable index of that record.

Phase 1 freezes `RecordStore` plus an in-memory implementation so slice 06 (`208-review-budget-advisory-plan.md`) can persist budget lines through the same contract without ever targeting SQLite-only rows. Later phases add the working-tree JSONL materialization, dual-write from existing primitives, progress resolution, `records index` / `records backfill`, and a doctor `records` check.

### Scope

**In scope:**

- `RecordStore` interface in `src/control-plane/` (sibling of `PromptStore`) with a working-tree JSONL implementation and an in-memory test implementation. The interface must not assume a working-tree path. **Phase 1 freezes the interface + memory impl** before any persistence work here or in slice 06.
- Record layout under configurable `paths.records` (default `docs/development/runs/<plan-slug>/<run-id>/`): `run.json`, append-only `steps.jsonl`, append-only `decisions.jsonl`, plus `budget.jsonl` for slice 06's opaque budget stream. `.gitattributes` `merge=union` for `*.jsonl` under that root, written by `init` / `upgrade`.
- Record writes from existing primitives: `run init`, `run record` / `protocol validate --record` / `phase finish` / `invoke --record` / `quality run --record` / `5x commit` (via `recordStepInternal`), `run complete` (seal + dedicated seal commit), answered prompts and `human:*` steps (decision lines).
- `5x commit` always stages the records root; `checkGitSafety` exempts uncommitted changes under that root only.
- Field policy, `records.redact`, `patch_id` / `diff_summary` at record time.
- Progress resolution for `plan list` / `plan phases` / `run state --plan` with `--fetch` and `--all-refs`.
- `5x records index` / `5x records backfill`, doctor `records` check.
- Docs: `207` status; `101-cli-primitives.md` for new commands/flags/`source`; config reference for new keys.

**Out of scope:**

- Remote control plane, leases, event stream, telemetry/blob store (`207` §2.8).
- Git-based coordination (claim files, push-as-CAS) — rejected in `207` §3.
- `refs/5x/*` storage — reserved behind the interface seam only.
- Moving coordination tables (`prompts`, locks, invocation registry, `.5x/current-run`).
- Review-budget line payloads (`206` §6.4) — slice 06 owns those; this slice only provides the opaque `budget` stream.
- Dashboard reads from git — dashboard continues to read the SQLite index.
- Dropping SQLite.
- `plan.autoFetch` / `coordination.allowOffline` (deferred; see Not In Scope).

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Freeze `RecordStore` + memory impl first** | Slice 06 cannot fork the contract. Budget-stream get/list/append, insertion order, and `atomicAppend` must exist before 06 Phase 4. |
| **Working-tree JSONL, not `refs/5x/*`** | Visible in PRs and hosting UIs; `merge=union` handles rare parallel-iteration merges. Interface stays path-agnostic so a ref-namespace impl remains possible. |
| **SQLite is a rebuildable index** | Fast path for idempotency and `run state`; a fresh clone rebuilds it from git. Record wins for completed work. |
| **`atomicAppend` is all-or-nothing** | Slice 06 appends a reviewer step and a budget snapshot in one batch. A throw, crash, or power loss must leave none of the ops durable, or fail closed on corrupt txn metadata — never a mixed-stream half-write (working-tree: Phase 3.2 journal). |
| **Dirty-tree exemption is path-scoped** | Uncommitted record files are expected between `run record` and `5x commit`. Any other dirty path still blocks `run init`. |
| **Re-root records to the run's effective worktree** | `config.paths.records` is control-plane-absolute. Writers, seal, and `5x commit` join the canonical repo-relative path under `effectiveWorkingDirectory` so a `--worktree` run commits records with the code. Git pathspecs and `git show` keep the repo-relative path. |
| **`atomicAppend` uses a power-loss-durable per-run journal** | Independent `renameSync` per stream is not crash-safe, and file `fsyncSync` alone does not persist directory entries. An immutable prepared journal plus a separately durable checksummed commit marker, with `fsyncDir` after every create/rename/unlink, restores the pre-batch state or finishes the batch. Corrupt or incomplete recovery metadata fails closed (`RECORD_TXN_CORRUPT`); never assume `prepared` and delete artifacts. |
| **`atomicAppend` serializes writers with a per-run lock** | Fixed `.txn.*` names are not mutually exclusive. Two CLI processes (a step writer and a run-scoped prompt snapshot) can otherwise recover each other's prepared txn or last-writer-wins a stream replacement. A store-internal lock is acquired before recovery/read/stage and held through directory-synced cleanup. Lock metadata is published atomically (unique temp + `fsync` + `linkSync` to `.txn.lock`); never `openSync(".txn.lock", "wx")`, which exposes an empty pathname a contender can steal. Only an abandoned lock (dead PID, or a lock that stays malformed for `lockTimeoutMs`) may be stolen; a live owner is never recovered over. |
| **`paths.records` must be inside the repository** | Staging, `git show`, ref resolution, and backfill all need a git path. An outside root is a configuration error, not a warning that silently disables git-native behavior. |
| **JSONL decode takes `runId` from the caller** | On-disk lines omit `run_id` (directory-implied). `decodeJsonlFile(text, runId)` reconstructs `RecordLine.runId` for steps, decisions, and budget. |
| **No implicit network** | `--fetch` is the only fetch. Remote-tracking refs are as fresh as the last fetch. |
| **Diverged refs are reported, never picked** | Silent resolution would hide split history. Completion is monotonic, so display max checklist progress and flag `source: diverged`. |

### References

- [`docs/v2/207-state-segmentation.md`](../../v2/207-state-segmentation.md) — segmentation rule, record layout, resolution algorithm, backfill.
- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — §3a store / UUID / control-plane vs SQLite constraints; `207` refines #4.
- [`docs/v2/202-control-plane.md`](../../v2/202-control-plane.md) — §3.1 store-interface mandate; `src/control-plane/` placement.
- [`docs/v2/203-recovery-and-doctor.md`](../../v2/203-recovery-and-doctor.md) — §2.4 doctor check registry the `records` check joins.
- [`docs/v2/204-run-context-ergonomics.md`](../../v2/204-run-context-ergonomics.md) — §2.1, §3 local pointer / worktree mapping stay unsynced.
- [`docs/v1/100-architecture.md`](../../v1/100-architecture.md) — §2.3, §3 idempotent steps; this slice must not change keys.
- [`docs/v1/101-cli-primitives.md`](../../v1/101-cli-primitives.md) — primitives to document (`records index`/`backfill`, `--fetch`, `--all-refs`, `source`).
- Plan input: [`docs/v2/plan-inputs/10-git-native-run-records.plan-input.md`](../../v2/plan-inputs/10-git-native-run-records.plan-input.md).
- Predecessor store pattern: [`205-prompt-queue-foundation-plan.md`](./205-prompt-queue-foundation-plan.md).
- Parallel consumer: [`208-review-budget-advisory-plan.md`](./208-review-budget-advisory-plan.md) (consumes Phase 1 freeze).

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Architecture Overview](#architecture-overview)
4. [Phase 1: Freeze RecordStore and in-memory implementation](#phase-1-freeze-recordstore-and-in-memory-implementation)
5. [Phase 2: Config keys and `.gitattributes`](#phase-2-config-keys-and-gitattributes)
6. [Phase 3: Working-tree JSONL implementation](#phase-3-working-tree-jsonl-implementation)
7. [Phase 4: Dual-write, safety exemption, commit staging, seal](#phase-4-dual-write-safety-exemption-commit-staging-seal)
8. [Phase 5: Progress resolution](#phase-5-progress-resolution)
9. [Phase 6: Records index and doctor check](#phase-6-records-index-and-doctor-check)
10. [Phase 7: Records backfill](#phase-7-records-backfill)
11. [Phase 8: Docs, exports, and compatibility](#phase-8-docs-exports-and-compatibility)
12. [Files Touched](#files-touched)
13. [Tests](#tests)
14. [Not In Scope](#not-in-scope)
15. [Estimated Timeline](#estimated-timeline)
16. [Provenance](#provenance)
17. [Revision History](#revision-history)

---

## Overview

v1 made SQLite the persistence layer. v2 (`200` §3a #4) said the control plane is the source of truth and SQLite is one materialization — correct for **coordination**, wrong for **completed-work history**. That history must travel with the code.

**Current behavior:**

- `plan list` (`src/commands/plan-v1.handler.ts:270–377`) scans `paths.plans` for `.md` files, prefers a mapped worktree copy (`effectivePlanReadPath`, `:258–268`), and derives `completion_pct` from `parsePlan` phase completion (`src/parsers/plan.ts:140–157`). Run counts come from local `listRuns`.
- `plan phases` (`plan-v1.handler.ts:181–212`) reads the worktree or checkout file via `readFileSync`. No git-ref walk.
- `run record` writes only SQLite through `recordStepInternal` (`run-v1.handler.ts:1193–1311`), capturing `head_commit` via `getLatestCommit` (`git.ts:121–127`). Idempotency is `UNIQUE(run_id, step_name, phase, iteration)` (`schema.ts:345–364`, `operations-v1.ts:140–202`).
- `run complete` (`run-v1.handler.ts:1421–1523`) inserts `run:complete` / `run:abort` via `recordStep` **directly**, skipping `head_commit`.
- `5x commit` (`commit.handler.ts:192–207`) stages `--files` or `-A` and records `git:commit` via `recordStepInternal`. It does not guarantee records are in the commit.
- `checkGitSafety` (`git.ts:52–94`) treats **any** porcelain line, including untracked, as dirty. `runV1Init` (`run-v1.handler.ts:1001–1018`) calls it before the resume/create fork, so uncommitted record files would block the next `run init`.
- No `.gitattributes` writer exists. `ensureGitignore` (`init.handler.ts:257–293`) is the idempotent-append pattern to copy.
- Control-plane stores exist for prompts and invocations only (`src/control-plane/store.ts`, `invocation-store.ts`). Schema max is v7 (`schema.ts:450–505`).

**New behavior:**

- Every admitted step is appended to the run record first (in the run's **effective worktree**), then projected into SQLite. Re-recording an existing key appends no JSONL line and returns the existing step.
- `run init` writes `run.json` (unsealed). `run complete` seals it, records the terminal step through the same path (with `head_commit`), and creates a `5x: seal run <id>` commit if record files remain uncommitted.
- `plan list` / `plan phases` / `run state --plan` resolve the plan file and records from the most advanced candidate ref, surface `source` (and ref age for remotes), and report `diverged` rather than picking.
- `5x records index` rebuilds `runs` / `steps` from the resolved record without clobbering newer local-only rows. `doctor` reports drift; `--fix` only re-indexes.
- `5x records backfill` exports existing DB history into the record format with `provenance: "backfilled"`.

**Prerequisites:**

- [`205-prompt-queue-foundation-plan.md`](./205-prompt-queue-foundation-plan.md) — **merged**. Establishes `src/control-plane/` and answered-prompt events this slice snapshots into `decisions.jsonl`.
- [`204-run-context-ergonomics-plan.md`](./204-run-context-ergonomics-plan.md) — **merged**. `phase finish` is the composite that must append records by wrapping primitives; this slice does not change the composite.
- Slice 06 is a **parallel consumer**, not a prerequisite. This slice's Phase 1 must land first so 06 Phase 4+ can compile against `RecordStore`.

---

## Design Decisions

**`RecordStore` is a sibling of `PromptStore`, not a SQLite table and not a git wrapper.** Command logic never imports `bun:sqlite` and never takes a working-tree path as a store method argument. The working-tree JSONL impl closes over an **absolute** `recordsRoot` in its factory (the worktree-re-rooted path from `resolveRecordsRoot`, not the raw control-plane `config.paths.records`), matching `createSqlitePromptStore(db)`. A future `refs/5x/*` impl swaps the factory. Slice 06 imports types from `src/control-plane/`, not a forked copy.

**The Phase 1 freeze includes everything 06's consumed surface requires.** `208` Design Decisions (consumed `RecordStore` surface) are binding on this freeze:

- Step append / get / list keyed by `(run_id, step_name, phase, iteration)`. Duplicate appends return `created: false` and keep the original payload.
- Opaque **budget** stream append / get / list. Slice 06 supplies `idempotencyKey` + JSON payload; this slice does not interpret budget fields.
- Insertion-ordered `listLines`. Equal `createdAt` must not reorder (memory: sequence counter; working-tree: file order).
- `atomicAppend(ops)`: all-or-nothing across mixed streams. Duplicate keys in the batch return `created: false` for those ops and add no line. A throw **or a crash** leaves none of the ops durable (memory: clone-then-swap; working-tree: Phase 3.2 journal).

This slice also freezes a **decisions** stream (answered prompts + `human:*`) and `putRun` / `getRun` / `listRuns` for `run.json`. Those are not 06's concern but must not be retrofitted incompatibly.

**Generic opaque lines plus typed step helpers.** Store methods operate on `RecordStream = "steps" | "decisions" | "budget"` and `RecordLine { runId, stream, idempotencyKey, payload, createdAt }`. Step payloads are encoded/decoded by helpers this slice owns (`encodeStepPayload` / `decodeStepPayload`). Budget and decision payloads are opaque `unknown` JSON. Do not put working-tree filenames on the interface.

**Idempotency key is unchanged.** `(run_id, step_name, phase, iteration)` remains the step identity (`100` §2.3, `operations-v1.ts` UNIQUE). The JSONL key is `step:${runId}:${stepName}:${phase ?? ""}:${iteration}`. NULL-phase behavior matches SQLite: omitted/null phase is a new record (no collision). Do not add a second identity.

**Record is the write authority; SQLite is a projection.** `prepareRecordStepAppend` (extracted from `recordStepInternal` `:1201–1299`) runs **before** any `atomicAppend`. Admission failure writes nothing. After a unique append, project into `recordStep`. After `created: false` or admission-duplicate, project from the existing record line (repair a missing SQLite row) and append nothing. Index failure after a successful append does not roll back the record — `records index` / retry repairs the index.

**`records.redact` is applied by the writer, not the store.** The store persists whatever payload it is given. `redactStepPayload(payload, config.records.redact)` runs in the dual-write path before `atomicAppend`. `session_id`, `log_path`, and transcript content are dropped unconditionally and are not valid redact-list members (they are never present). Redact may drop `cost_usd`, `tokens_in`, `tokens_out`, `model`, `diff_summary`, etc.

**`patch_id` and `diff_summary` are computed at record time.** `git patch-id --stable` of `git diff <previousStep.head_commit> <current.head_commit>` while both SHAs exist. `diff_summary` is `{ files_changed, insertions, deletions }` from `git diff --numstat`. If the previous step has no `head_commit`, or either SHA is unreachable, both fields are `null`. Unreachable `head_commit` later (squash merge) is informational, not an error — that is why these fields exist (`207` §2.3).

**`.gitattributes` uses `merge=union` on `*.jsonl` under the configured records root.** Parallel iterations that actually merge (rare) concatenate lines instead of conflicting. Readers **dedupe by idempotency key, first line wins**, matching `INSERT OR IGNORE`. Tests must merge two branches with distinct keys and assert a valid JSONL file with no conflict markers, then merge two files that share a key and assert first-line-wins on read.

**Dirty-tree exemption is canonical-path scoped.** `checkGitSafety(workdir, { exemptRoots?: string[] })` parses `git status --porcelain=v1 -z` (NUL-safe; handles quotes, renames). A path is exempt iff `isPathUnder(absPath, canonicalExemptRoot)` (`paths.ts:65–67`). Exempt paths are omitted from `untrackedFiles` and do not set `isDirty`. A dirty file **outside** the root still yields `safe: false`. `runV1Init` passes the **worktree-re-rooted absolute** records path from `resolveRecordsRoot` (equal to `config.paths.records` when there is no linked worktree). Do not pass control-plane `config.paths.records` when `workdir` is a linked worktree — porcelain paths are relative to that worktree. Do not exempt via string prefix on porcelain lines (breaks worktrees, monorepos, and quoted paths).

**`5x commit` always stages the records root in addition to `--files` / `--all-files`.** `--all-files` (`git add -A`) already includes it when the directory exists in the effective worktree. `--files` must also `git add -- <recordsRelPath>` when `existsSync(recordsAbsPath)` in the **effective worktree** (not the control-plane checkout). Dry-run includes the same extra pathspec. Staging a missing directory is skipped, not an error. Pathspec is always the canonical repo-relative POSIX path; existence check is always the re-rooted absolute path.

**Records I/O is re-rooted to the run's effective worktree.** `resolveConfigPaths` resolves `paths.records` against the control-plane root, like other `paths.*`. That absolute path is **not** the write target for a `run init --worktree` run: `resolveRunExecutionContext` executes commits in the linked worktree, so record files written under the main checkout are invisible to that worktree's `git add` / `5x commit` (or stage an unrelated path). One helper, `resolveRecordsRoot` (`src/records/paths.ts`):

```typescript
export interface ResolvedRecordsRoot {
	/** Canonical repo-relative POSIX path for git pathspecs, `git show`, resolution, `.gitattributes`. */
	recordsRelPath: string;
	/** Absolute path in `effectiveWorkdir` (linked worktree or control-plane root). Store write target. */
	recordsAbsPath: string;
}

export function resolveRecordsRoot(opts: {
	recordsConfigAbs: string; // config.paths.records after resolveConfigPaths
	controlPlaneRoot: string;
	effectiveWorkdir: string;
}): ResolvedRecordsRoot;
```

Algorithm: `recordsRelPath = relativePathUnder(recordsConfigAbs, controlPlaneRoot)` (fail with `RECORDS_ROOT_OUTSIDE_REPO` if null); `recordsAbsPath = join(effectiveWorkdir, recordsRelPath)`. Callers: `run init` `putRun`, every record writer (`recordStepInternal`, prompt decisions, seal), `checkGitSafety` exempt root, seal dirty check / `commitFiles`, `5x commit` existence + pathspec, backfill target worktree, doctor uncommitted-stale. Do not construct `createWorkingTreeRecordStore({ recordsRoot: config.paths.records })`. Preserve `recordsRelPath` separately; never derive git pathspecs from the worktree-absolute path.

**`paths.records` outside the repository is a configuration error.** Git-native records require a path that can be staged, shown, and resolved from refs. After `resolveConfigPaths`, if `!isPathUnder(config.paths.records, baseDir)` (control-plane / project root), throw: `paths.records must be inside the repository (resolved to <abs>). Git-tracked run records cannot live outside the work tree.` Do **not** warn and skip `.gitattributes` / disable git-native behavior. Cover relative default, absolute-inside (e.g. `resolve(projectRoot, "custom/runs")` as the configured value), and absolute-outside (`/tmp/5x-records`) plus a relative path that escapes (`../../tmp/records`).

**JSONL decode reconstructs `RecordLine.runId` from the caller.** On-disk objects omit `run_id` (implied by `<slug>/<run-id>/`). `encodeJsonlLine` must not write `run_id`. `decodeJsonlFile(text, runId)` sets `runId` on every returned `RecordLine`. If an object contains `run_id` and it differs from the caller value, throw `INVALID_JSONL`. Contract coverage includes decisions and budget lines, not only steps.

**`atomicAppend` durability is a per-run journal, not in-process rollback.** A thrown JS exception still rolls back (memory: clone-then-swap; FS: abort before the commit marker is directory-durable). A process kill, power loss, or failed rename between `steps.jsonl` and `budget.jsonl` cannot leave slice 06 with an orphaned reviewer step or budget snapshot. File `fsyncSync` of `.new` / journal bytes is not enough: every create, rename, and unlink must be followed by `fsync` of the **run directory** so the directory entry survives power loss. Prepared metadata is immutable; the commit decision is a separate checksummed marker. If that metadata is corrupt or incomplete, recovery **fails closed** (`RECORD_TXN_CORRUPT`) and leaves artifacts for doctor — it must not assume `prepared` and delete them. See Phase 3.2. Recovery runs on every store open/read/append **only while holding the per-run writer lock**. Journal artifacts (`.txn.*`, including `.txn.lock`) are gitignored under the records root and are never staged.

**Cross-process writers are serialized per run.** The working-tree store acquires an exclusive per-run lock (`.txn.lock`) before `recoverRunDir`, before reading stream bytes, and before staging; it holds that lock until cleanup has been directory-fsynced. Publication is atomic: write a unique temp with `{ pid, owner }`, `fsyncFile`, `linkSync` onto `.txn.lock` (fails if the name exists), `fsyncDir`. A second process waits a bounded time or throws `RECORD_TXN_LOCKED`. An unreadable/empty `.txn.lock` is **not** immediately stolen — that is the creation-window race. Recovery runs only for the lock owner; a live owner's prepared transaction is never rolled back or deleted by a concurrent caller. Stale locks (dead PID, or malformed for a full `lockTimeoutMs`) are stolen, then recovered. Memory has no lock (single-threaded clone-then-swap). All writer paths — `putRun`, `append` / `atomicAppend`, and prompt decision snapshots that call `recordStore.append` — go through this lock. Do not write JSONL files from handlers.

**Post-commit steps get a dedicated seal commit.** `run complete` writes the terminal step + sealed `run.json`, then if the records root is dirty, `commitFiles` with message `5x: seal run <id>`. Do not wait for a later `5x commit` that may never come (`207` open question 1, resolved: seal commit). If there is nothing to commit, skip (no empty commit).

**Progress resolution never checks out.** Candidate refs in order: mapped worktree working copy → local `5x/<slug>` → each remote's `5x/<slug>` → `plans.branch` if set → `HEAD`. Per candidate, last commit touching the plan file **or** that slug's records directory (`git log -1 --format=%H <ref> -- <plan-path> <records-path>`). Dedupe by commit. Prune ancestors via `merge-base --is-ancestor`. One survivor → `git show <sha>:<path>`. Multiple survivors → `source: "diverged"`, report all sources, display max checklist progress. `--fetch` runs `git fetch <remote> 'refs/heads/5x/*'` per remote first. `--all-refs` opts into `git log --all -- <path>` discovery. Branch-only plans (not on `HEAD`) are listed with their source.

**No schema migration.** v7 `runs` / `steps` already hold the index columns. Do not add `provenance` columns; provenance lives on the record line. Slice 06 owns schema v8 budget **index** tables.

**Answered prompts snapshot into `decisions.jsonl` only when `run_id` is set.** Standalone `5x prompt` (nullable `run_id`, `202` §3.2) has no run directory. CAS-success and CAS-loser both ensure the decision line exists (idempotent key `decision:prompt:<promptId>`). `human:*` steps go to **both** `steps.jsonl` and `decisions.jsonl` in one `atomicAppend`.

**`plan list` skips the records subtree** the same way it skips reviews (`plan-v1.handler.ts:218–234`). Default `paths.records` (`docs/development/runs`) sits under default `paths.plans` (`docs/development`); the config **key** is a sibling of `paths.plans`, not a nested `paths.plans.records`. JSONL files are not `.md`, but a `README.md` under runs must not appear as a plan.

---

## Architecture Overview

```
  run init / record / complete / commit / protocol validate --record
  invoke --record / quality --record / phase finish (composite)
  prompt answer (run-scoped) / human:* steps
           │
           ├─ prepareRecordStepAppend     // admission only; no writes
           │     active run, worktree, JSON, maxSteps, idempotency, head_commit
           ├─ redact + patch_id/diff_summary
           ├─ RecordStore.atomicAppend    // authoritative (memory or working-tree JSONL)
           └─ SQLite recordStep           // rebuildable index projection

  <recordsAbsPath>/<plan-slug>/<run-id>/   // re-rooted into effective worktree
           run.json          // putRun at init and seal
           steps.jsonl       // append-only; merge=union
           decisions.jsonl   // answered prompts + human:*
           budget.jsonl      // opaque; slice 06 owns payloads
           .txn.lock         // per-run writer lock; gitignored
           .txn.journal.json // immutable prepared record; gitignored
           .txn.commit       // checksummed commit marker; gitignored
           .txn.<stream>.*   // .new / .old staging; gitignored; never staged

  plan list / plan phases / run state --plan
           │
           └─ resolvePlanProgress
                 candidates: worktree → local 5x/<slug> → remotes → plans.branch → HEAD
                 last-touching commit per ref → ancestor prune → git show
                 1 survivor: source = that ref
                 2+ survivors: source = diverged (max progress, all sources listed)

  5x records index     → walk resolution, upsert runs/steps; keep newer local-only rows
  5x records backfill  → export DB → record files + commit (target auto|<branch>)
  doctor records       → missing lines, missing rows, unreachable head_commit;
                         uncommitted records older than lingering-run threshold;
                         corrupt/torn record-transaction journal (not auto-fixed);
                         in-flight `.txn.lock` (valid live PID **or** unreadable/empty)
                         is not treated as corrupt and is not immediately stolen
                         --fix = index only
```

SQLite coordination tables (`prompts`, locks, invocations, `.5x/current-run`) are never written to git.

---

## Phase 1: Freeze RecordStore and in-memory implementation

**Completion gate:** `RecordStore` is exported from `src/control-plane/index.ts` and `src/index.ts`. `createMemoryRecordStore()` passes the shared contract suite, including budget-stream get/list/append, insertion order at equal timestamps, duplicate-key first-writer-wins, and `atomicAppend` all-or-nothing (including a thrown op that leaves no lines). Slice 06 can import these types and the memory factory. No working-tree files, no CLI commands, no handler wiring.

This phase is the hard prerequisite for `208` Phase 4. If 06 later needs a contract change, it is a coordinated revision **here**, not a 06 fork.

#### 1.1 Types — `src/control-plane/record-types.ts` (new)

```typescript
export type RecordStream = "steps" | "decisions" | "budget";
export type RecordProvenance = "recorded" | "backfilled";

export interface StepIdempotencyKey {
	runId: string;
	stepName: string;
	phase: string | null;
	iteration: number;
}

export interface DiffSummary {
	files_changed: number;
	insertions: number;
	deletions: number;
}

/** Payload stored on stream "steps". Never includes session_id, log_path, or transcript. */
export interface StepRecordPayload {
	step_name: string;
	phase: string | null;
	iteration: number;
	result_json: unknown; // parsed JSON object/array/value, not a double-encoded string
	head_commit: string | null;
	patch_id: string | null;
	diff_summary: DiffSummary | null;
	provenance: RecordProvenance;
	duration_ms: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	cost_usd: number | null;
	model: string | null;
}

export interface RunRecordSummary {
	id: string;
	plan_path: string;
	config_json: unknown | null;
	created_at: string;
	sealed_at: string | null;
	status: "active" | "completed" | "aborted";
	final_head_commit: string | null;
	cli_version: string;
	/** Present on backfilled unsealed exports (`207` §2.7). */
	backfilled?: boolean;
}

export interface RecordLine {
	runId: string;
	stream: RecordStream;
	idempotencyKey: string;
	payload: unknown;
	createdAt: string;
}

export type AppendOp = Omit<RecordLine, "createdAt"> & { createdAt?: string };

export interface AppendResult {
	created: boolean;
	line: RecordLine;
}

export class RecordStoreError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "RecordStoreError";
		this.code = code;
	}
}
```

Helpers in the same file (or `record-keys.ts`):

```typescript
export function stepIdempotencyKey(k: StepIdempotencyKey): string {
	return `step:${k.runId}:${k.stepName}:${k.phase ?? ""}:${k.iteration}`;
}
```

- [ ] `stepIdempotencyKey` is the only step-key encoder; 06's `prepareRecordStepAppend` will look up by this key via `getLine("steps", key)`.
- [ ] `RecordStoreError` codes used in Phase 1: `RUN_NOT_FOUND` (append/getLine against a run that was never `putRun`), `INVALID_STREAM`. Do not invent CAS codes — duplicates are `created: false`, not errors. Phase 3 adds `INVALID_JSONL`, `RECORD_TXN_CORRUPT`, and `RECORD_TXN_LOCKED`. `RECORDS_ROOT_OUTSIDE_REPO` is a config / `resolveRecordsRoot` error (Phase 2/4), not a store-method code.

#### 1.2 Interface — `src/control-plane/record-store.ts` (new)

Mirror `PromptStore` (`store.ts:14–21`) and `InvocationStore` (`invocation-store.ts:16–78`): handlers depend on this, never on files or SQLite.

```typescript
export interface RecordStore {
	putRun(summary: RunRecordSummary): void;
	getRun(runId: string): RunRecordSummary | null;
	listRuns(filter?: { planSlug?: string }): RunRecordSummary[];

	getLine(
		runId: string,
		stream: RecordStream,
		idempotencyKey: string,
	): RecordLine | null;
	/** Insertion order. Equal createdAt must not reorder. */
	listLines(runId: string, stream: RecordStream): RecordLine[];

	append(op: AppendOp): AppendResult;
	/**
	 * All-or-nothing. Per-op duplicates return created: false and add no line.
	 * A throw leaves the store identical to before the call.
	 */
	atomicAppend(ops: AppendOp[]): AppendResult[];
}
```

**Semantic rules (contract tests encode these; do not weaken):**

1. `putRun` is last-write-wins on the summary document (init then seal). It does not touch streams.
2. `append` / `atomicAppend` require a prior `putRun` for that `runId` or throw `RUN_NOT_FOUND`.
3. Duplicate `idempotencyKey` on the same `(runId, stream)`: return the **original** line, `created: false`. Do not overwrite payload.
4. `listLines` returns the insertion sequence, not `createdAt` sort. Contract test: two budget lines with identical `createdAt`; order matches append order.
5. `atomicAppend([])` returns `[]` and writes nothing.
6. `atomicAppend` of mixed streams is atomic. Test: `[step, budget]` where the second op's encoder/store hook throws → neither line exists. Working-tree crash recovery (Phase 3.2) extends this to process kill and power loss (directory fsync); corrupt txn metadata fails closed. Concurrent working-tree writers for the same run are serialized by the per-run lock (atomically published owner metadata); a live owner's prepared txn is never recovered by another process, including during lock publication. Memory has no disk journal or lock.
7. Methods take `runId` + stream + key. **No path parameters.**

- [ ] File-level comment states the interface must not assume a working-tree path (`207` §3).
- [ ] Do not add `gitShow` / `commit` / `fetch` to this interface.

#### 1.3 Memory implementation — `src/control-plane/record-memory.ts` (new)

Pattern: `memory-store.ts` (clone-on-read, injected clock).

```typescript
export interface MemoryRecordStoreOptions {
	now?: () => string; // default: UTC `YYYY-MM-DD HH:MM:SS` like PromptStore
}

export function createMemoryRecordStore(
	opts?: MemoryRecordStoreOptions,
): RecordStore;
```

Internal structure: `Map<runId, { summary: RunRecordSummary; streams: Record<RecordStream, Map<string, RecordLine> & { order: string[] }> }>`. `atomicAppend` clones the affected run maps, applies ops, then swaps. A throw during apply leaves the original maps in place.

- [ ] `listRuns({ planSlug })` filters by `planSlugFromPath(summary.plan_path)` (`paths.ts:171–175`).
- [ ] Returned objects are cloned (mutating a `getLine` result must not change the store).

#### 1.4 Shared contract tests — `test/unit/control-plane/record-store-contract.test.ts` (new)

Pattern: `test/unit/control-plane/store-contract.test.ts` and `invocation-store-contract.test.ts` — a `backends` array of `{ name, setup }`. Phase 1 registers **memory only**. Phase 3 adds a working-tree harness to the **same** `describe` factory so both impls stay honest.

```typescript
export function runRecordStoreContract(setup: () => RecordStore): void;
```

Required cases:

- [ ] `putRun` / `getRun` round-trip including `sealed_at: null` then a second `putRun` that seals.
- [ ] `listRuns` / `listRuns({ planSlug })`.
- [ ] Step append then `getLine` by `stepIdempotencyKey`; duplicate returns `created: false` and original `result_json`.
- [ ] `listLines("steps")` insertion order with two lines sharing `createdAt` (inject `now`).
- [ ] Budget stream: append `{ idempotencyKey: "budget:baseline:run_1", payload: { b0: 4 } }`; get/list; duplicate CAS.
- [ ] Decisions stream: same shape, opaque payload.
- [ ] `atomicAppend([step, budget])` both `created: true`; `getLine` both streams.
- [ ] `atomicAppend([step, budget])` when step key already exists: step `created: false`, budget still appended (caller/06 decides whether to include budget; the store does not infer pairing).
- [ ] `atomicAppend` throw: spy/hook the memory store **or** pass an op that the test double throws on after the first write in the in-memory apply; assert store unchanged. For memory, implement by wrapping `append` internals: if any op's `stream` is the sentinel `"__throw__"` as a test-only… **Do not** add a test stream. Instead: `atomicAppend` of two valid ops where the test subclasses/spies `put` of the second stream map and throws. Simplest: export a test-only `createMemoryRecordStore({ now, onBeforeCommit?: () => void })` that `onBeforeCommit` throws after mutating the clone but before swap — the swap is skipped, original intact.
- [ ] `append` without `putRun` throws `RUN_NOT_FOUND`.
- [ ] Missing `getLine` / `getRun` return `null`.

- [ ] Re-export `RecordStore`, types, `createMemoryRecordStore`, `stepIdempotencyKey`, `RecordStoreError` from `src/control-plane/index.ts` and `src/index.ts`.

---

## Phase 2: Config keys and `.gitattributes`

**Completion gate:** `paths.records` defaults to `docs/development/runs` (resolved absolute like other `paths.*`). A resolved `paths.records` outside the repository (`!isPathUnder(abs, baseDir)`) is a configuration error — git-native record behavior is not silently disabled. `records.redact` defaults to `[]`. `5x config show` / registry lists both keys. `5x init` and `5x upgrade` idempotently write a `.gitattributes` `merge=union` rule for `*.jsonl` under the configured records path. No RecordStore wiring yet.

#### 2.1 Config schema — `src/config.ts`

Add to `PathsSchema` (`:69–115`):

```typescript
records: z
	.string()
	.default("docs/development/runs")
	.describe(
		"Directory for git-tracked run records (relative to config; resolved to absolute at load).",
	),
```

Add top-level `RecordsSchema` on `FiveXConfigSchema` (`:166–197`):

```typescript
const RecordsSchema = z.object({
	redact: z
		.array(z.string())
		.default([])
		.describe(
			"Additional step-record field names to drop before writing (e.g. cost_usd, model).",
		),
});
```

Mount as `records: RecordsSchema.default({})`.

- [ ] `resolveConfigPaths` (`:476–494`) resolves `paths.records` with `resolve(baseDir, config.paths.records)` alongside `plans` / `reviews` / `archive`. Immediately after resolve, if `!isPathUnder(config.paths.records, baseDir)`, throw: `paths.records must be inside the repository (resolved to <abs>). Git-tracked run records cannot live outside the work tree.` Use error code `RECORDS_ROOT_OUTSIDE_REPO` when the load path has an envelope (otherwise a thrown `Error` whose message includes that code/phrase). This is fail-closed for every command that loads config.
- [ ] Add `"records"` to `KNOWN_ROOT_CONFIG_KEYS` (`:498–512`).
- [ ] `src/templates/5x.default.toml` (`:59–65`): `records = "docs/development/runs"` under `[paths]`; commented `[records]` / `redact = []`.
- [ ] Unit tests: `test/unit/config.test.ts`, `test/unit/config-registry.test.ts` — default, override, relative resolution, **absolute path inside the repo accepted** (configured value `resolve(projectRoot, "custom/runs")` → stored abs equals that path), **absolute path outside the repo rejected** (`/tmp/5x-records` → `RECORDS_ROOT_OUTSIDE_REPO`), **relative path that escapes** (`../../tmp/records` → same error), unknown-key warning does not fire for `[records]`.

`config-registry.ts` walks Zod automatically; no hand-maintained key list.

#### 2.2 `ensureGitattributes` — `src/commands/init.handler.ts`

Copy the idempotent-append pattern of `ensureGitignore` (`:257–293`). Export it next to `ensureGitignore` (`:400–406`) so upgrade can call it.

```typescript
const GITATTRIBUTES_COMMENT = "# 5x run records";

export function recordsGitattributesLine(recordsRelPath: string): string {
	const rel = recordsRelPath.replace(/\\/g, "/").replace(/\/$/, "");
	return `${rel}/**/*.jsonl merge=union`;
}

export function ensureGitattributes(
	projectRoot: string,
	recordsRelPath: string,
): { created: boolean; appended: boolean };
```

- [ ] If `.gitattributes` is missing, create it with the comment + one rule.
- [ ] If present and the exact rule line exists, no-op.
- [ ] If present without the rule, append (preserve existing content; do not rewrite unrelated attributes).
- [ ] Call from `initScaffold` after `ensureGitignore` (`:379–387`). Use the **relative** default `docs/development/runs` on first init (Zod default; no `5x.toml` required). If layered config is already loaded, use `relative(projectRoot, config.paths.records)` — config load has already rejected an outside root, so this relative path is always inside the repo. If `relativePathUnder` would still return null (defense in depth), throw `RECORDS_ROOT_OUTSIDE_REPO`; **do not** skip `.gitattributes` or log a warning.
- [ ] Call from `runUpgrade` (`upgrade.handler.ts:485`) as a new "Git attributes:" section after templates (`:533–537`), using the resolved layered `paths.records` (same inside-repo relative path).
- [ ] Tests: `test/unit/commands/init.test.ts`, `test/unit/commands/upgrade.test.ts`, `test/integration/commands/init.test.ts`, `test/integration/commands/upgrade.test.ts` — create, append, idempotent, custom `paths.records` inside the repo (relative and absolute-inside). An outside `paths.records` fails at config load before attributes are written.

- [ ] Do **not** create the records directory on init (empty dirs are not git-tracked). The first `putRun` creates `<slug>/<run-id>/`.

---

## Phase 3: Working-tree JSONL implementation

**Completion gate:** `createWorkingTreeRecordStore({ recordsRoot, now? })` satisfies `runRecordStoreContract`. Layout matches `207` §2.3. `decodeJsonlFile(text, runId)` reconstructs `RecordLine.runId` for steps, decisions, and budget. `atomicAppend` of mixed streams is power-loss durable: an immutable prepared journal, a separately durable checksummed commit marker, and `fsyncDir` after every create/rename/unlink. A per-run writer lock is acquired before recovery/read/stage and held through directory-synced cleanup; owner metadata is published atomically (`linkSync` of a fsynced temp, never empty `wx` on `.txn.lock`); only abandoned transactions are recovered. Recovery on every open/read/append restores the pre-batch state or finishes the entire batch; corrupt or incomplete txn metadata throws `RECORD_TXN_CORRUPT` and does not delete artifacts. No visible partial mixed-stream write remains. Two concurrent processes appending distinct ops to one run both persist. A contender paused against an empty or in-publication lock does not obtain it or reach journal recovery. Redaction is **not** inside the store (writer-side; tested in Phase 4) except a shared `redactStepPayload` helper can live here for unit tests. `git patch-id` / `numstat` helpers exist and are unit-tested with mocked `subprocess.execGit`.

#### 3.1 Layout and codecs — `src/control-plane/record-layout.ts` (new)

```
<recordsRoot>/<plan-slug>/<run-id>/run.json
<recordsRoot>/<plan-slug>/<run-id>/steps.jsonl
<recordsRoot>/<plan-slug>/<run-id>/decisions.jsonl
<recordsRoot>/<plan-slug>/<run-id>/budget.jsonl
```

`plan-slug` = `planSlugFromPath(summary.plan_path)`.

```typescript
export const STREAM_FILES: Record<RecordStream, string> = {
	steps: "steps.jsonl",
	decisions: "decisions.jsonl",
	budget: "budget.jsonl",
};

export function encodeJsonlLine(line: RecordLine): string; // single JSON object, no pretty-print; omits runId
export function decodeJsonlFile(text: string, runId: string): RecordLine[]; // skip blank lines; first-key-wins dedupe; set runId on every line
export function parseRunJson(text: string): RunRecordSummary;
```

JSONL on-disk object:

```json
{"stream":"steps","idempotency_key":"step:run_ab:author:impl:1:1","payload":{...},"created_at":"2026-08-31 12:00:00"}
```

`runId` is implied by the directory. `encodeJsonlLine` **must not** write `run_id`. `decodeJsonlFile(text, runId)` reconstructs `RecordLine.runId` from the caller argument — the decoder cannot recover it from the file body alone. If an object contains `run_id` and it differs from `runId`, throw `RecordStoreError("INVALID_JSONL")`. Each JSONL object **must** include `idempotency_key` so merge=union readers can dedupe without the directory. Step `payload` still includes identifying fields so a concatenated merge remains self-describing.

- [ ] `decodeJsonlFile` drops conflict-marker lines if present (treat as corrupt: throw `RecordStoreError("INVALID_JSONL")` rather than silently parsing half a merge). After a correct `merge=union` there are no markers — the throw is a doctor-facing signal.
- [ ] First occurrence of an `idempotency_key` wins; later duplicates in the same file are ignored on read (union merge of two backfills).
- [ ] Codec unit tests: `decodeJsonlFile` of a steps line, a decisions line, and a budget line each return `RecordLine.runId ===` the caller-supplied id; encode round-trip does not emit `run_id`; mismatched on-disk `run_id` throws `INVALID_JSONL`.

#### 3.2 Working-tree store — `src/control-plane/record-fs.ts` (new)

```typescript
export type TxnEvent =
	| "after-lock-temp-written"
	| "after-lock-linked"
	| "after-lock-acquired"
	| "after-lock-released"
	| "after-new"
	| "after-dirsync:staging"
	| "after-prepared"
	| "after-dirsync:prepared"
	| "after-commit-marker"
	| "after-dirsync:commit"
	| `after-rename:${RecordStream}`
	| `after-dirsync:rename:${RecordStream}`
	| "after-dirsync:cleanup"
	| "during-recovery";

export interface WorkingTreeRecordStoreOptions {
	recordsRoot: string; // absolute (already worktree-re-rooted by the caller)
	now?: () => string;
	/** Test-only; not re-exported from the public barrel. Default: real file/dir fsync. */
	fsyncFile?: (path: string) => void;
	fsyncDir?: (dir: string) => void;
	/** Test-only; not re-exported from the public barrel. Throw to simulate a crash. */
	onTxnEvent?: (event: TxnEvent) => void;
	/** Max wait for `.txn.lock` when another live process holds it. Default: 5000. */
	lockTimeoutMs?: number;
	/** Poll interval while waiting for `.txn.lock`. Default: 25. */
	lockPollMs?: number;
}

export function createWorkingTreeRecordStore(
	opts: WorkingTreeRecordStoreOptions,
): RecordStore;
```

**Write algorithm for `atomicAppend` (power-loss-durable journal):**

In-process try/catch around independent `renameSync` per stream is **not** sufficient: a process kill between `steps.jsonl` and `budget.jsonl` replacements leaves exactly the mixed-stream orphan slice 06's `atomicAppend` is intended to prevent. SQLite reindex cannot infer or repair the missing counterpart. File `fsyncSync` of journal bytes is also **not** sufficient: create/rename/unlink only persist across power loss after the **parent directory** is fsynced. Rewriting one journal file from `prepared` → `commit` is unsafe: a torn rewrite after some stream replacements can look like a corrupt `prepared` journal, and deleting artifacts then leaves a partial batch.

Every `atomicAppend` (including single-op `append`) uses a per-run journal. `putRun` remains single-file tmp+rename (`run.json` is not a mixed-stream batch) but still fsyncs the file and the run directory after rename.

**Durability helpers** (implement once in `record-fs.ts`; inject `fsyncFile` / `fsyncDir` in tests):

- `fsyncFile(path)`: open the file, `fsyncSync(fd)`, close. After tmp+rename, the renamed inode was already fsynced as the tmp file; still fsync the dest path if the implementation writes in place.
- `fsyncDir(dir)`: `openSync(dir, "r")` (or `O_RDONLY`), `fsyncSync(fd)`, close. Required on macOS and Linux after every create, `renameSync`, or `unlinkSync` in `dir`. Do not skip this on Darwin.
- `durableWriteFile(path, bytes)`: write to `path.tmp`, `fsyncFile(tmp)`, `renameSync(tmp, path)`, `fsyncDir(dirname(path))`.

Reserved files in `<runDir>/` (gitignored; never staged):

| File | Role |
|------|------|
| `.txn.lock` | **Per-run exclusive writer lock.** `{ version: 1, pid, owner, started_at }`. Published atomically: unique temp + `fsyncFile` + `linkSync` onto this name (link fails if the destination exists). Never created with `openSync(".txn.lock", "wx")`. `owner` is 16 random bytes hex, kept in a process-local map. Gitignored. |
| `.txn.lock.<hex>` | Unique prepare temp for lock publication. Not the lock. Gitignored via `.txn.*`. Unlinked after `linkSync` succeeds or fails. |
| `.txn.journal.json` | **Immutable prepared record.** Written once; never rewritten. `{ version: 1, streams, created, new_sha256, old_sha256 }`. `new_sha256` / `old_sha256` are hex SHA-256 of the corresponding staging bytes (`old_sha256` omits streams that were creates). |
| `.txn.commit` | **Separately durable commit marker.** Created only after the prepared journal and all staging files are directory-durable. `{ version: 1, journal_sha256 }` where `journal_sha256` is SHA-256 of the exact `.txn.journal.json` bytes. Never written by rewriting the journal. |
| `.txn.<stream>.new` | Staged replacement bytes for that stream (`steps` / `decisions` / `budget`). |
| `.txn.<stream>.old` | Before-image of an existing stream file (absent if the file did not exist). |

There is **no** `state` field on the journal. Commit vs prepare is the presence of a **valid, checksum-matching** `.txn.commit`. Do not encode commit by mutating `.txn.journal.json`.

`ensureGitignore` (Phase 3, called from init/upgrade alongside `ensureGitattributes`) idempotently appends `${recordsRelPath}/**/.txn.*` so `git add -A` / `5x commit` never stages journals (covers `.txn.lock`, `.txn.lock.<hex>` temps, `.txn.journal.json`, `.txn.commit`, and `.txn.<stream>.*`). Custom `paths.records` gets a matching ignore line.

**Per-run writer lock** — store-internal (not `src/lock.ts` plan locks). Memory impl is a no-op: JS is single-threaded and clone-then-swap is already atomic. Do not add lock methods to the `RecordStore` interface.

Invariant: `recoverRunDir` runs **only** while this process holds `.txn.lock` for that `runDir`. A concurrent caller blocked on the lock never inspects, recovers, or deletes another process's `.txn.journal.json` / `.new` / `.old` / `.txn.commit`. Fixed `.txn.*` names are therefore exclusive.

Liveness matches `src/lock.ts` `isPidAlive`: `process.kill(pid, 0)` returns alive; `EPERM` is alive (not stealable across users); `ESRCH` is dead. Do not add a native `flock` dependency. A reused PID belonging to a live unrelated process is treated as a live owner (wait / `RECORD_TXN_LOCKED`), not a steal. Records require a POSIX filesystem that supports hard links (APFS, ext4, and typical local disks); do **not** fall back to `wx` on `.txn.lock` if `linkSync` fails with `EXDEV` / `EPERM`.

**`acquireRunWriterLock(runDir)`** (sync; `Bun.sleepSync` for the wait poll):

Do **not** `openSync(join(runDir, ".txn.lock"), "wx")`. That makes an empty lock pathname visible before `{ pid, owner }` is written and fsynced. A contender that classifies unreadable/empty as abandoned unlinks it; the first process continues as owner — concurrent fixed-name journal writes and record loss (P0.5).

Publish a fully written, fsynced lock record **atomically**:

1. If `runDir` does not exist and the caller is not `putRun`: do not create it, do not lock; writers throw `RUN_NOT_FOUND`, readers return `null`.
2. `putRun` may `mkdirSync(runDir, { recursive: true })` first, then acquire.
3. Generate `owner` once per successful acquire (16 random bytes hex). Loop until acquired, or until a **live** owner has been waited on for `lockTimeoutMs` (default 5000):
   1. **Prepare.** Create unique temp `join(runDir, ".txn.lock." + randomBytes(16).toString("hex"))`. Write `{ version: 1, pid: process.pid, owner, started_at }`, `fsyncFile(temp)`. Fire `after-lock-temp-written`. The temp is not the lock; nobody may recover or treat a temp as `.txn.lock`. `wx` on the temp name is allowed (unique; not the published pathname).
   2. **Publish.** `linkSync(temp, join(runDir, ".txn.lock"))` (hard-link; succeeds only if the destination does not exist).
      - Success: `fsyncDir(runDir)` so the `.txn.lock` directory entry is durable. Fire `after-lock-linked`. At this point `.txn.lock` is a complete, readable lock record (same inode as the fsynced temp) — never empty. `unlinkSync(temp)`, `fsyncDir(runDir)`. Store `{ pid, owner }` in a process-local map keyed by `runDir`. Fire `after-lock-acquired`. Return (nesting depth = 1). Optionally unlink other leftover `.txn.lock.<hex>` temps **only while holding** `.txn.lock` (a waiter's deleted temp makes their `linkSync` `ENOENT`; they retry — safe).
      - `EEXIST`: `unlinkSync(temp)` (ignore `ENOENT`). Inspect `.txn.lock` below. This is **not** ownership.
      - `EXDEV` / `EPERM` (hard-link unsupported): throw; do **not** fall back to `openSync(".txn.lock", "wx")`.
   3. **Inspect existing `.txn.lock`:**
      - Subsequent read hits `ENOENT` (owner released): continue the loop and retry prepare+link.
      - **Valid** `{ version: 1, pid, owner, started_at }`:
        - `pid === process.pid` **and** `owner` is in this process's map: re-entrant (nesting depth++). Return without rewriting the file.
        - Same-pid with an **unknown** owner is **not** re-entrant (PID reuse); treat as another owner.
        - `isPidAlive(pid)`: **live owner.** Sleep `lockPollMs` (default 25), continue. Do **not** recover, unlink, or read `.txn.journal.json`.
        - PID dead: **abandoned.** `unlinkSync(".txn.lock")` only (leave journal/staging), `fsyncDir(runDir)`, continue the loop to publish our lock. Recovery happens *after* we hold the lock.
      - **Unreadable, empty, truncated, or schema-invalid:** **not** immediately abandoned. A live publisher using this protocol never exposes an empty `.txn.lock` (the pathname appears only as a hard-link of a fsynced complete record). Immediate steal is the P0.5 race. Protocol:
        1. On the first consecutive malformed observation, record `malformedSince` (reset when the file is valid or absent).
        2. Sleep `lockPollMs`, re-read. If it becomes valid, handle as valid. If it disappears, retry prepare+link.
        3. If it remains malformed for a continuous `lockTimeoutMs`: **abandoned garbage** (crash leftover or external corruption — not a live metadata-write window). `unlinkSync(".txn.lock")`, `fsyncDir(runDir)`, reset `malformedSince`, continue to publish. Do **not** delete journal/staging files.
4. If the loop times out with a live owner: throw `RecordStoreError("RECORD_TXN_LOCKED", "run <id> record writer lock held by pid <n>")`. Store unchanged. Do not recover. Do not touch `.txn.*` except our unlinked temp.

**`releaseRunWriterLock(runDir)`:** decrement nesting depth. If depth reaches 0: unlink `.txn.lock` **only if** pid+owner still match this process's map entry; then `fsyncDir(runDir)`; drop the map entry. Fire `after-lock-released`. Call from `finally` on every path that acquired (including `RECORD_TXN_CORRUPT` and JS throws). Never unlink a lock we do not own. A leftover lock after crash is stolen by the next acquirer via the dead-PID path (or the malformed-grace path if the file is unreadable).

**Who acquires:** every working-tree method that would call `recoverRunDir` — `getRun`, `getLine`, `listLines`, `append`, `atomicAppend`, `putRun`, and each run directory visited by `listRuns`. Readers take the same exclusive lock so they cannot roll back a live writer's prepared txn or observe a mixed mid-rename view. `listRuns` acquires/releases **per** run directory (never holds every run at once). `atomicAppend([])` returns `[]` without locking (no `runId`). Prompt decision snapshots (Phase 4.7) call `recordStore.append` and therefore take this lock; handlers must not write `decisions.jsonl` themselves.

Held through: acquire → recover → read stream bytes → stage → commit marker → renames → directory-synced cleanup → release. Do not release before cleanup's `fsyncDir` returns.

**Commit protocol** (each numbered step names its durability boundary; crash after any step is recoverable or fail-closed):

1. Resolve `<recordsRoot>/<slug>/<runId>/` internally from the run directory layout (slug is the parent directory name / `plan_path`). Do **not** call the public `getRun` here — that would acquire/release and leave a race before this method's lock. Missing run directory → `RUN_NOT_FOUND` (no lock file created). **Acquire** `.txn.lock` via `acquireRunWriterLock` (fires `after-lock-acquired`).
2. `recoverRunDir(runDir)` (see below) **while holding the lock**. Then read current bytes of each affected stream file (missing file = empty). Decode with `decodeJsonlFile(text, runId)`, apply ops in memory (duplicate keys → `created: false`). If no stream file would change, skip staging (no journal) and fall through to `finally` to release the lock.
3. Write `.txn.<stream>.old` (copy of existing bytes) for each mutated file that already exists. Write `.txn.<stream>.new` for each mutated stream. `fsyncFile` each of those files. Then `fsyncDir(runDir)` (directory entries for staging are durable). Fire `after-new` after each file fsync and `after-dirsync:staging` after the directory fsync. Originals are still untouched.
4. `durableWriteFile` `.txn.journal.json` with the immutable prepared record (streams, created vs replaced, `new_sha256`, `old_sha256`). `fsyncFile` the journal (if not already covered by `durableWriteFile`), then `fsyncDir(runDir)`. Fire `after-prepared` then `after-dirsync:prepared`. **Never rewrite this file.** Originals are still untouched.
5. `durableWriteFile` `.txn.commit` with `{ version: 1, journal_sha256 }` of the prepared journal bytes. `fsyncFile` the marker, then `fsyncDir(runDir)`. Fire `after-commit-marker` then `after-dirsync:commit`. **This is the commit point.** After this directory fsync, recovery rolls *forward*. Before it, recovery rolls *back* only if the proof below holds. Do not replace any original until this directory fsync returns.
6. For each affected stream, `renameSync(.txn.<stream>.new, <stream>.jsonl)`, then `fsyncDir(runDir)`. Fire `after-rename:<stream>` then `after-dirsync:rename:<stream>`.
7. `unlinkSync` `.txn.<stream>.old` files, then `fsyncDir(runDir)`. Then `unlinkSync` `.txn.journal.json` and `.txn.commit` (either order; leftover pair with no remaining `.new` is a no-op roll-forward). Then `fsyncDir(runDir)`. Fire `after-dirsync:cleanup`. Do not unlink journal/commit until all stream replacements have been directory-fsynced. **Do not unlink `.txn.lock` here** — release it in `finally` after this directory fsync.
8. `finally`: `releaseRunWriterLock(runDir)` (unlink `.txn.lock` if still owned, `fsyncDir`, `after-lock-released`).

Do not create `.txn.commit` until every `.new` / `.old` file and `.txn.journal.json` is file- and directory-durable. Do not replace any original until `.txn.commit` is directory-durable. Cleanup of journal/staging `.txn.*` only after all stream replacements are directory-durable. Release the writer lock only after that cleanup directory fsync (or after a no-op/error `finally`).

**`recoverRunDir(runDir)`** — call only while holding `.txn.lock` for that directory, at the start of `getRun`, `getLine`, `listLines`, `append`, `atomicAppend`, `putRun` (for that run), and once per run directory visited by `listRuns`. Fire `during-recovery` at the start of a recovery that finds any `.txn.journal.json` / `.txn.commit` / `.txn.*.new` / `.txn.*.old` (not merely `.txn.lock`). **Never assume `prepared` and delete artifacts when metadata is corrupt or incomplete. Never unlink `.txn.lock` from recovery.** A concurrent process that does not hold the lock must not call this function.

Let `journalOk` mean `.txn.journal.json` parses as version 1, has the required fields, and every present `.new` / `.old` file matches the recorded SHA-256. Let `commitOk` mean `.txn.commit` parses as version 1 and `journal_sha256` equals SHA-256 of the current journal file bytes. Let `commitExists` mean the `.txn.commit` path exists (even if unreadable).

1. If neither `.txn.journal.json` nor `.txn.commit` exists: delete any orphan `.txn.*.new` / `.txn.*.old` / `*.tmp` leftover from `durableWriteFile` (crash during prepare before the journal), `fsyncDir(runDir)`, return. Visible stream files are unchanged. A leftover `.txn.journal.json.tmp` is not a journal. **Never unlink `.txn.lock` or `.txn.lock.<hex>` lock-prepare temps** (the caller holds `.txn.lock`; waiters own their temps).
2. If `!journalOk` (journal missing while `.txn.commit` exists; journal unreadable, JSON/schema invalid, or a present `.new`/`.old` checksum mismatch) **or** `commitExists && !commitOk` (torn, truncated, or checksum-mismatch commit marker): throw `RecordStoreError("RECORD_TXN_CORRUPT", ...)`. Leave every `.txn.*` file in place **except** the caller still releases `.txn.lock` in `finally`. Do **not** roll back, roll forward, or delete artifacts. Doctor reports `RECORD_TXN_CORRUPT` (Phase 6); `--fix` does not repair this.
3. If `journalOk && commitOk`: **roll forward**. For each listed stream, if `.txn.<stream>.new` still exists, verify SHA-256 then `renameSync` it over `<stream>.jsonl` and `fsyncDir(runDir)`. Then unlink `.old` files, journal, and commit marker; `fsyncDir(runDir)`. Store content equals the full batch. Idempotent if some renames already completed (missing `.new` for a listed stream is OK on this path).
4. If `journalOk && !commitExists`: **rollback only when replacements are proven not to have started.** Proof (all must hold): every listed stream still has `.txn.<stream>.new` whose SHA-256 matches `new_sha256`; for replaced streams, `.old` exists and the live `<stream>.jsonl` SHA-256 matches `old_sha256` (or the live file is absent iff it was a create and `.old` is absent). Then unlink `.new`, `.old`, and the journal; `fsyncDir(runDir)`. Store content equals the pre-batch state.
5. If `journalOk && !commitExists` but the rollback proof fails: **do not roll back.** If every listed `.new` is absent **and** every live stream file SHA-256 matches `new_sha256` (the batch was fully applied and the commit marker was lost during cleanup): unlink leftover `.old` / journal, `fsyncDir(runDir)`, return (already all-or-nothing). Otherwise throw `RECORD_TXN_CORRUPT` and leave artifacts. This is the "lost commit marker after a partial rename" case — deleting `.old` would destroy the only before-image.
6. Never leave a visible mix where one stream in the batch is updated and another is not. `getLine` / `listLines` after successful recovery must observe all-or-nothing. After `RECORD_TXN_CORRUPT`, those methods throw rather than returning a mixed view; `listRuns` that hits a corrupt run dir throws the same error (doctor walks directories itself and catches it).

**Fault-injection tests** (working-tree FS suite, not required of memory): `onTxnEvent` / `fsyncDir` may throw (simulating kill or directory-sync failure). Cases:

- [ ] Interrupt after each `.new` write, after `after-dirsync:staging`, and after `after-dirsync:prepared`: reopen the store; neither stream from a mixed `[step, budget]` batch is visible; no leftover partial line. Reopen steals the stale `.txn.lock` (dead PID) before recovering.
- [ ] Interrupt after `after-dirsync:commit` and after 0, 1, … n−1 stream replacements (including after each `after-dirsync:rename:<stream>`): reopen; **both** (all) streams from the batch are visible; no journal remains after recovery.
- [ ] Interrupt **during recovery** of a committed txn (hook on the first roll-forward rename): second open finishes the batch; still all-or-nothing.
- [ ] Interrupt `fsyncDir` (injected `fsyncDir` throws) after staging, after prepared journal, after commit marker, after a stream rename, and during cleanup: reopen is either all-or-nothing or `RECORD_TXN_CORRUPT`; never a silent mixed-stream view.
- [ ] **Torn / corrupt commit marker:** after a durable prepared journal, write truncated or garbage `.txn.commit` (and a variant that also completes 0 or 1 stream replacement, then corrupts the marker). Reopen throws `RECORD_TXN_CORRUPT`; `.txn.*` artifacts remain on disk (not deleted); `getLine` / `listLines` throw rather than returning a partial batch.
- [ ] **Corrupt journal after commit:** durable commit marker + one stream replacement, then truncate/garbage `.txn.journal.json`. Reopen throws `RECORD_TXN_CORRUPT`; does **not** treat as prepared and delete `.old` / `.new`.
- [ ] `atomicAppend` JS throw before the commit marker is directory-durable: same as rollback (in-process catch still deletes staging if the process lives); lock is released in `finally`.
- [ ] **Live lock is not recovered:** hold `.txn.lock` in a child process with a prepared `.txn.journal.json` + `.new` files (PID alive). A second store `atomicAppend` / `getLine` must **not** delete those staging files. With `lockTimeoutMs` shorter than the hold: throws `RECORD_TXN_LOCKED` and streams are unchanged. After the child exits (or releases): the waiter acquires, recovers the abandoned txn, then proceeds.
- [ ] **Stale lock is stolen:** write `.txn.lock` with a dead PID plus a prepared uncommitted journal; reopen steals the lock, rolls back, then a subsequent append succeeds.
- [ ] **Lock pathname is never empty:** after `after-lock-linked` and after `after-lock-acquired`, `.txn.lock` parses as version 1 with `pid` + `owner` (not an empty file). `acquireRunWriterLock` must not `openSync(".txn.lock", "wx")`.
- [ ] **`after-lock-temp-written` mutual exclusion:** pause A at `after-lock-temp-written` (temp exists; `.txn.lock` does not). Contender B may win `linkSync`. Exactly one process becomes owner and may call `recoverRunDir`. The loser must not stage `.txn.journal.json` or recover. Resume A: `EEXIST` → wait or `RECORD_TXN_LOCKED`; A does not also own.
- [ ] **`after-lock-linked` is already complete:** pause A at `after-lock-linked` (before `after-lock-acquired` / temp unlink). `.txn.lock` is a valid live-PID record. Contender B waits or throws `RECORD_TXN_LOCKED`; B must **not** unlink `.txn.lock`, must **not** obtain the lock, must **not** reach `recoverRunDir`.
- [ ] **Creation-window race (P0.5):** deterministic multi-process (or child + parent) coverage. Process A performs the exclusive creation of the lock pathname and pauses **before** owner metadata would have been readable under the old `wx` protocol: child `openSync(".txn.lock", "wx")` then sleeps without writing `{ pid, owner }` (empty/unreadable visible lock, PID alive), **or** equivalent planted empty `.txn.lock` while a sibling process is live. Process B constructs `createWorkingTreeRecordStore` and calls `atomicAppend` / `getLine` with `lockTimeoutMs` longer than the pause. During the pause B must **not** obtain `.txn.lock` and must **not** reach journal recovery (no unlink of the empty file on the first observation; no delete of a prepared `.txn.journal.json` / `.new` planted beside it). After A writes+fsyncs complete metadata and `fsyncDir`, or after A exits, B either waits on the live owner or steals a dead-PID lock — never two concurrent owners.
- [ ] **Malformed lock is not immediately stolen:** write empty or garbage `.txn.lock` (no valid pid). An acquire with `lockTimeoutMs` well above several `lockPollMs` intervals must still see that file on the second poll (not unlinked after the first observation). After a continuous `lockTimeoutMs` of malformed observations, a later acquire may steal (abandoned garbage) and proceed.
- [ ] Extra FS tests (not required of memory): `putRun` creates nested dirs and directory-fsyncs after `run.json` rename; reading a union-concatenated file with two keys returns both in file order; concatenated file with duplicate key returns first payload.
- [ ] Add working-tree harness to `runRecordStoreContract` using `mkdtempSync`. Assert files on disk after append (one line, valid JSON). `listLines` / `getLine` return `runId` matching the directory.
- [ ] **Multi-process integration** (`test/integration/records/concurrent-append.test.ts`): temp `recordsRoot` with one `putRun`. Two `Bun.spawn` workers (`cleanGitEnv()`, `stdin: "ignore"`, timeout 30s) each construct `createWorkingTreeRecordStore` on that root and `atomicAppend` a **distinct** op (worker A: a step line; worker B: a decision or budget line). Both exit 0. Reopen: both keys exist with original payloads; no `.txn.lock` / `.txn.journal.json` / `.txn.commit` / `.new` / `.old` remain; `getLine` does not throw `RECORD_TXN_CORRUPT`. Repeat the pair enough times (or with a barrier file) that the appends overlap, not merely run sequentially. Include a variant that pauses the first worker after exclusive lock-path creation and before metadata publication (empty `wx` stand-in or `after-lock-temp-written` / planted empty lock as above) and asserts the second worker does not recover or append until the window closes.

Single-op `append` is `atomicAppend([op])` (same lock + journal path; one stream).

**`putRun`:** `mkdirSync(..., { recursive: true })`, **acquire the writer lock**, then `recoverRunDir` so a pending stream txn is not hidden behind a summary rewrite, then write `run.json` via `durableWriteFile` (pretty-print 2-space JSON is acceptable for the summary file; JSONL stays one compact object per line), then release in `finally`. If recovery throws `RECORD_TXN_CORRUPT`, do not rewrite `run.json` (still release the lock).

**`listRuns`:** for each `recordsRoot/*/*/run.json` directory, acquire that run's lock, recover, read, release, then move on. A `RECORD_TXN_CORRUPT` from any run dir propagates (fail closed). `RECORD_TXN_LOCKED` from a live writer also propagates (caller retries or surfaces). Ignore *other* unreadable `run.json` files (warn via injected optional `onWarn`, default `console.warn` is **forbidden in unit tests** — inject a sink or swallow). Filter by `planSlug` using directory name (must match `planSlugFromPath`).

#### 3.3 Git helpers for patch-id and show — `src/git.ts`

`subprocess.execGit` (`subprocess.ts:52–66`) sets `stdin: "ignore"`. Add a spyable sibling:

```typescript
// on subprocess object
async execGitStdin(
	args: string[],
	workdir: string,
	stdin: string,
): Promise<ExecResult>;
```

New exports on `git.ts`:

```typescript
export async function computePatchId(
	workdir: string,
	fromCommit: string,
	toCommit: string,
): Promise<string | null>;
// git diff from to | git patch-id --stable; null on any failure

export interface NumstatSummary {
	files_changed: number;
	insertions: number;
	deletions: number;
}

export async function computeDiffSummary(
	workdir: string,
	fromCommit: string,
	toCommit: string,
): Promise<NumstatSummary | null>;
// git diff --numstat from to

export async function gitShowFile(
	workdir: string,
	commit: string,
	path: string,
): Promise<string | null>;
// git show commit:path ; null if missing

export async function gitLogLastTouching(
	workdir: string,
	ref: string,
	paths: string[],
): Promise<string | null>;
// git log -1 --format=%H ref -- paths
```

- [ ] Unit tests in `test/unit/git.test.ts` with the existing `mockGit` helper (`:50–73`). Do not spawn real git in unit tests.
- [ ] `computePatchId` returns `null` when `execGit` diff or patch-id is non-zero (squash-safe; do not throw at record time).

#### 3.4 Redaction helper — `src/control-plane/record-redact.ts` (new)

```typescript
export function redactStepPayload(
	payload: StepRecordPayload,
	redact: string[],
): StepRecordPayload;
```

- [ ] Always omit `session_id` / `log_path` if a caller smuggles them on a widened object (delete those keys).
- [ ] For each name in `redact` that exists on the payload, set the field to `null` (keep the key so schema stays stable) **except** `result_json` / `step_name` / `phase` / `iteration` / `provenance` / `head_commit` which are **not redactable** — ignore them in the list.
- [ ] Unit tests: drop `cost_usd`; ignore unknown names; refuse to strip `result_json`.

---

## Phase 4: Dual-write, safety exemption, commit staging, seal

**Completion gate:** Recording a unique step writes one `steps.jsonl` line and one SQLite `steps` row **in the run's effective worktree**. Re-recording returns `recorded: false`, appends no line, and leaves SQLite unchanged (or repairs a missing row from the line). `run init` creates `run.json` at the re-rooted records path. `run complete` seals, records the terminal step **with** `head_commit`, and creates a seal commit when record files are dirty in that worktree. `5x commit --files` also stages the canonical `recordsRelPath` when `recordsAbsPath` exists in the effective worktree. `checkGitSafety` with the re-rooted exempt root ignores record dirt and still fails on any other dirty file. Answered run-scoped prompts and `human:*` steps append `decisions.jsonl`. An integration test with `run init --worktree` proves `run.json` and a recorded step are written in the linked worktree and included in that worktree's `5x commit`. `phase finish` / `protocol validate --record` / `invoke --record` need **no composite changes** — they already call `recordStepInternal`.

#### 4.0 `resolveRecordsRoot` — `src/records/paths.ts` (new)

Phase 4 creates `src/records/` (Phase 5 adds `resolve.ts` beside it). The helper is the only conversion from control-plane `config.paths.records` to a write/stage target.

```typescript
export function resolveRecordsRoot(opts: {
	recordsConfigAbs: string;
	controlPlaneRoot: string;
	effectiveWorkdir: string;
}): ResolvedRecordsRoot;
```

- [ ] Same checkout (`effectiveWorkdir === controlPlaneRoot`): `recordsAbsPath` equals `recordsConfigAbs`; `recordsRelPath` is the POSIX relative (default `docs/development/runs`).
- [ ] Linked worktree: `recordsAbsPath === join(worktree, recordsRelPath)` and is **not** equal to `recordsConfigAbs`; `recordsRelPath` is unchanged.
- [ ] `relativePathUnder` null → throw `RECORDS_ROOT_OUTSIDE_REPO` (defense in depth; config load already rejected this).
- [ ] Unit: `test/unit/records/paths.test.ts`.

#### 4.1 `checkGitSafety` exemption — `src/git.ts:52–94`

```typescript
export async function checkGitSafety(
	workdir: string,
	opts?: { exemptRoots?: string[] },
): Promise<GitSafetyReport>;
```

- [ ] Switch status to `["status", "--porcelain=v1", "-z"]`. Parse NUL-delimited records. Handle rename (`R100\0old\0new`) by testing **both** paths; if either is non-exempt, the repo is dirty. Untracked (`??`) same as today but skip exempt paths.
- [ ] Canonicalize: `resolve(repoRoot, porcelainPath)` then `isPathUnder(abs, realpathExisting(exemptRoot))`.
- [ ] Existing `checkGitSafety` tests (`test/unit/git.test.ts:79+`) still pass with no `exemptRoots` (treat as today). New tests: only records dirty → `safe: true`, `untrackedFiles` empty; records + `README.md` dirty → `safe: false`, `untrackedFiles` contains `README.md` only; rename out of records root is dirty.
- [ ] `runV1Init` (`run-v1.handler.ts:1003`) passes `{ exemptRoots: [resolveRecordsRoot({ recordsConfigAbs: config.paths.records, controlPlaneRoot: projectRoot, effectiveWorkdir: projectRoot }).recordsAbsPath] }` for the non-`--worktree` safety check (`--worktree` still skips `checkGitSafety` today because worktrees are isolated). Do not pass raw `config.paths.records` when a later caller uses a linked-worktree `workdir`.

#### 4.2 `prepareRecordStepAppend` — `src/commands/run-v1.handler.ts`

Extract the admission body currently at `:1201–1299` so Phase 6 of slice 06 and this dual-write share one seam (`208` P1.8).

```typescript
export type PrepareRecordStepOutcome =
	| { outcome: "admit"; prepared: PreparedRecordStep }
	| { outcome: "duplicate"; prepared: PreparedRecordStep };

export interface PreparedRecordStep {
	runId: string;
	stepName: string;
	phase: string | undefined;
	iteration: number | undefined; // still optional if caller omitted; resolved before append
	resultJson: string;
	headCommit: string | undefined;
	sessionId?: string;
	model?: string;
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
	durationMs?: number;
	logPath?: string;
	effectiveWorkdir: string | undefined;
	maxSteps: number;
}

export async function prepareRecordStepAppend(
	params: RunRecordParams & { run: string; stepName: string; result: string },
	ctx: {
		db: Database;
		config: FiveXConfig;
		controlPlane?: ControlPlaneResult;
		recordStore: RecordStore;
	},
): Promise<PrepareRecordStepOutcome>;
```

Algorithm (preserve today's order):

1. `getRunV1`; missing → `RecordError("RUN_NOT_FOUND")`; not active → `RUN_NOT_ACTIVE`.
2. Fail-closed `resolveRunExecutionContext` when `controlPlaneRoot` is set.
3. Best-effort `getLatestCommit`.
4. `maxStepsPerRun` from live config; if at ceiling, duplicate detection **prefers `recordStore.getLine`** then falls back to `findExistingStep` (so a fresh clone whose index is behind still no-ops). New unique at ceiling → `MAX_STEPS_EXCEEDED`. Duplicate at ceiling → `{ outcome: "duplicate" }`.
5. `JSON.parse(params.result)` or `INVALID_JSON`.
6. If a complete key exists in RecordStore (and iteration was provided) → `{ outcome: "duplicate" }`. If iteration omitted, do not treat as duplicate (same as `findExistingStep` returning null when iteration omitted, `operations-v1.ts:111–113`).
7. Otherwise `{ outcome: "admit" }`.

- [ ] `recordStepInternal` calls `prepareRecordStepAppend` then the persist sequence below. Slice 06's wrapper will call the same prepare **before** `atomicAppend([step, budget])`.
- [ ] Unit tests with `MemoryRecordStore`: terminal run, missing worktree, invalid JSON, new-at-limit throw with **zero** store lines; duplicate-at-limit is `duplicate` with zero new lines.

#### 4.3 Persist sequence — `recordStepInternal`

On `admit`:

1. Resolve iteration (if omitted, `nextIteration` from SQLite **or** `max(iteration)+1` from `listLines("steps")` for that `(stepName, phase)` — prefer RecordStore so the index being behind cannot allocate a colliding iteration). Document: if both exist and disagree, RecordStore wins.
2. Previous step with `head_commit`: last `listLines("steps")` entry whose payload has a non-null `head_commit`.
3. `patch_id` / `diff_summary` via Phase 3 helpers when both SHAs exist; else null.
4. Build `StepRecordPayload` with `provenance: "recorded"`; `redactStepPayload(..., config.records.redact)`; drop session/log (never copy `sessionId` / `logPath` onto the payload).
5. `ops: AppendOp[] = [{ stream: "steps", ... }]`. If `stepName.startsWith("human:")`, also push a decisions line keyed `decision:human:${stepIdempotencyKey}`.
6. `atomicAppend(ops)` (store-internal lock serializes this against a concurrent prompt snapshot on the same run).
7. `recordStep(db, { ... prepared, head_commit })` projection. SQLite still stores `session_id` / `log_path` (local/telemetry); the record does not.

On `duplicate` or `created: false`:

8. Do not append. `recordStep` / upsert from the existing line so a missing SQLite row is repaired. Return `recorded: false`.

- [ ] Handlers still never import `bun:sqlite`. `recordStepInternal` already receives `db` through `dbContext`; add `recordStore` to that object.
- [ ] Factory `src/commands/record-context.ts` (new), analogue of `prompt-context.ts`: one `resolveDbContext`, then `resolveRunExecutionContext` for the run, then `resolveRecordsRoot` with that context's `effectiveWorkingDirectory`, then `createWorkingTreeRecordStore({ recordsRoot: recordsAbsPath })`. Return `{ db, config, controlPlane, recordStore, recordsRelPath, recordsAbsPath, executionContext }`. `recordStepInternal` / `runV1Init` / `runV1Complete` use it when `dbContext` is omitted. **Never** `createWorkingTreeRecordStore({ recordsRoot: config.paths.records })`.
- [ ] For `run init`, after `ensureRunWorktree` / `createRunV1`, `effectiveWorkdir` is the mapped worktree path when `--worktree`, else `projectRoot`. `putRun` uses the store rooted there.
- [ ] Unit tests inject `MemoryRecordStore`. Integration tests in a temp git repo assert `steps.jsonl` content.

#### 4.4 `run init` writes `run.json`

After `createRunV1` (`run-v1.handler.ts:1055–1065`):

```typescript
recordStore.putRun({
	id: runId,
	plan_path: planPath,
	config_json: { maxStepsPerRun: getMaxStepsPerRun(...) },
	created_at: /* from getRunV1 after insert */,
	sealed_at: null,
	status: "active",
	final_head_commit: null,
	cli_version: version, // src/version.ts
});
```

The `recordStore` here is the factory result rooted at `resolveRecordsRoot(..., effectiveWorkdir).recordsAbsPath` for this run (linked worktree after `--worktree`, otherwise `projectRoot`). `run.json` must appear under that worktree, not only under the control-plane checkout.

Resume path (`:1034–1052`): if `getRun` is null (index-only row from before this slice), `putRun` an unsealed summary from the SQLite row. Do not overwrite a sealed summary. Resume of a worktree-mapped run uses that mapping's `effectiveWorkingDirectory`.

#### 4.5 `run complete` seal + commit

Replace the raw `recordStep` at `:1493–1502` with `recordStepInternal` (or prepare+append) so the terminal step gets `head_commit`, JSONL, and projection. Then `completeRun`, then `putRun` with `sealed_at = now`, `status`, `final_head_commit`.

Then, in the run's `effectiveWorkingDirectory`, using `resolveRecordsRoot` for that workdir:

- If the re-rooted records root has changes (`listChangedFiles` filtered by `isPathUnder(..., recordsAbsPath)` non-empty, **or** `git status` scoped to `recordsRelPath`), `commitFiles(workdir, [recordsRelPath], `5x: seal run ${runId}`)`. Existence and dirty checks use `recordsAbsPath`; the git pathspec is `recordsRelPath`.
- Skip if nothing to commit.
- Do not add non-record files to the seal commit. Do not stage `.txn.*` (gitignored).

Release lock and clear pointer **after** the seal commit (keep today's order of lock release at `:1507–1516`, but move it to after the commit so a crash mid-seal still holds the lease). If the seal commit fails, do not release the lock; surface `COMMIT_FAILED`. SQLite may already show `completed` — doctor `records` will flag uncommitted files. **Safer alternative (implement this):** perform the seal commit **before** `completeRun`, while the run is still `active` and the lock is held; if commit fails, the run stays `active` and the operator retries `run complete` (idempotent terminal step). Prefer this.

- [ ] Tests: complete with dirty records → one commit whose `diff-tree` is only under records; complete with already-committed records → no extra commit; abort status seals as `aborted`.

#### 4.6 `5x commit` stages records — `commit.handler.ts:192–207`

When `params.files` is set (not `--all-files`), append `recordsRelPath` to the `git add` pathspec if `existsSync(recordsAbsPath)` in the **effective worktree** (`resolveRunExecutionContext` + `resolveRecordsRoot`). Dry-run (`:151–157`) uses the same pathspec. Do not `existsSync(config.paths.records)` — that is the control-plane checkout and is wrong for `--worktree` runs.

- [ ] Integration: `test/integration/commands/commit.test.ts` — `--files src/foo.ts` with a dirty `docs/development/runs/.../steps.jsonl` includes the jsonl in `diff-tree`.
- [ ] Unit: mock `execGit` and assert `add` args contain the records **relative** path.
- [ ] Linked-worktree integration (see 4.8): `run init --worktree`, record a step, `5x commit --files` from that run; `diff-tree` includes the worktree records files and the control-plane checkout does not hold the only copy.

#### 4.7 Decision snapshots from prompts — `prompt.handler.ts`

After a successful or losing `answerPrompt` (`:245`) when `prompt.runId` is non-null, `recordStore.append` a decisions line:

```typescript
{
	runId: prompt.runId,
	stream: "decisions",
	idempotencyKey: `decision:prompt:${prompt.id}`,
	payload: {
		kind: "answered-prompt",
		prompt_id: prompt.id,
		kind_prompt: prompt.kind,
		message: prompt.message,
		answer: prompt.answer,
		answered_by: prompt.answeredBy,
	},
}
```

Extend `PromptCommandContext` (`prompt.handler.ts` + `prompt-context.ts`) with optional `recordStore`. When `prompt.runId` is set, resolve that run's execution context and pass a store rooted at `resolveRecordsRoot(..., effectiveWorkingDirectory).recordsAbsPath` (same factory as record-context, not control-plane `config.paths.records`). If `getRun(runId)` is null (prompt answered before `run init` wrote a record — unusual), skip the snapshot (do not throw; prompt UX must not fail). Abandoned prompts are **not** decisions. The snapshot **must** use `recordStore.append` (store-internal writer lock + journal). Do not `writeFileSync` / append to `decisions.jsonl` from the handler — a concurrent `recordStepInternal` `atomicAppend` on the same run would otherwise clobber or recover the in-flight txn.

- [ ] Unit: `test/unit/commands/prompt-store.test.ts` — answered with `runId` appends one decision line; second CAS loser does not duplicate; `runId` null appends nothing.

#### 4.8 Context wiring

- [ ] `runV1Record`, `protocol.handler.ts` record path (`:427+`), `invoke.handler.ts` (`:644+`), `quality-v1.handler.ts`, `commit.handler.ts` already funnel through `recordStepInternal` — pass `recordStore` via the shared context (re-rooted per run). Do not add a second `resolveDbContext`.
- [ ] `phase.handler.ts` unchanged (composite). Add a regression integration test that `phase finish` produces a `steps.jsonl` line in the effective worktree.
- [ ] Integration: `test/integration/records/worktree-records.test.ts` (new). `cleanGitEnv()`, `stdin: "ignore"`, timeout 30s. `run init --worktree` on a temp repo; assert `run.json` exists at `join(worktree, recordsRelPath, slug, runId, "run.json")` and is **not** the only copy under the main checkout's `config.paths.records` (main checkout must not be the write target). Record a step; assert `steps.jsonl` is in the worktree. `5x commit --files` of a code path (cwd/startDir such that the run resolves to the worktree) includes both the code file and the record files in `diff-tree`. `.txn.*` files are absent from the commit.

---

## Phase 5: Progress resolution

**Completion gate:** Against a scripted temp git fixture (real git, `cleanGitEnv()`), `plan list` / `plan phases` / `run state --plan` report progress from the winning ref with additive `source` / `source_ref` / `source_age_seconds` / `diverged_sources`. Merged, stacked, diverged, branch-only, remote-only, and worktree cases pass. `--fetch` is the only network; `--all-refs` discovers non-conventional branches. No existing envelope field is renamed.

Start this phase with a **short spike** (half day, same checkout): measure `merge-base --is-ancestor` fan-out for N plans × remotes. If a 20-plan / 3-remote fixture exceeds ~500ms, implement the batched `for-each-ref` + single `rev-list` topology query **before** wiring handlers. If it is fast, ship the naive loop and leave a comment with the measured number. Do not skip the measurement.

#### 5.1 Resolution module — `src/records/resolve.ts` (new)

Keep git I/O out of `RecordStore`. This module uses Phase 3 `gitShowFile` / `gitLogLastTouching` plus new helpers:

```typescript
export type ProgressSourceKind =
	| "worktree"
	| "branch"      // local 5x/<slug> or plans.branch
	| "remote"      // origin/5x/<slug>
	| "HEAD"
	| "diverged"
	| "local-index" // no record on any ref; SQLite only
	| "backfilled"; // record present but provenance is backfilled-only / no branch

export interface ProgressSource {
	kind: ProgressSourceKind;
	label: string; // "worktree" | "5x/<slug>" | "origin/5x/<slug>" | "HEAD" | "diverged"
	ref?: string;
	commit?: string;
	age_seconds?: number; // remote-tracking tip vs now
}

export interface ResolvedPlanProgress {
	source: ProgressSource;
	diverged_sources?: ProgressSource[];
	markdown: string | null;
	planPath: string;
	commit: string | null;
}

export async function resolvePlanProgress(opts: {
	workdir: string;
	planPath: string; // canonical repo-relative or absolute; convert to relative for git
	planSlug: string;
	recordsRelPath: string; // repo-relative records root
	worktreePath?: string | null;
	plansBranch?: string | null; // plans.branch override
	allRefs?: boolean;
	nowMs?: number;
}): Promise<ResolvedPlanProgress>;
```

Algorithm (`207` §2.4), implemented literally:

1. Build candidate refs in order. Skip missing refs (`rev-parse --verify`).
2. For each, `gitLogLastTouching(ref, [relPlanPath, join(recordsRel, slug)])`. Drop null (ref never touched either path).
3. Dedupe by commit SHA.
4. For every pair, `git merge-base --is-ancestor A B`; drop A if ancestor of B.
5. 0 survivors: fall back to reading the worktree/checkout file if it exists (`source.kind = "worktree"` or `"HEAD"`); else `markdown: null`.
6. 1 survivor: `gitShowFile` for the plan path at that commit unless the survivor is the mapped worktree (read the file from disk, `kind: "worktree"`).
7. 2+ survivors: `kind: "diverged"`, `diverged_sources` listed, `markdown` from the survivor with the **maximum** `parsePlan` phase-completion percentage (monotonic). Tie-break: lexicographic `label`.

`--fetch` is **not** inside `resolvePlanProgress`. The command handler fetches first.

Additional git helpers (`git.ts`):

```typescript
export async function listFiveXRefs(workdir: string): Promise<{
	local: string[];          // 5x/<slug>
	remote: Array<{ remote: string; ref: string }>; // origin/5x/<slug>
}>;
// git for-each-ref refs/heads/5x/* refs/remotes/*/5x/*

export async function isAncestor(
	workdir: string,
	maybeAncestor: string,
	commit: string,
): Promise<boolean>;

export async function fetchFiveXBranches(
	workdir: string,
	remote: string,
): Promise<void>;
// git fetch remote refs/heads/5x/* — only called when --fetch

export async function listRemotes(workdir: string): Promise<string[]>;
```

- [ ] Unit tests with `mockGit` covering ancestor prune, diverged pair, missing ref.
- [ ] Cache `(refSha, path) → lastTouching` in-process for a single `plan list` invocation (the handler passes a shared `Map` or the resolve module holds a per-call cache object). Do not persist the cache in SQLite in this slice unless the spike shows it is necessary.

#### 5.2 `plan phases` — `plan-v1.handler.ts:181–212` and `plan-v1.ts:21–42`

- [ ] Add `--fetch` and `--all-refs` flags (boolean).
- [ ] Replace `readFileSync(effectivePath)` with `resolvePlanProgress`. `PLAN_NOT_FOUND` only when markdown is null and no checkout file exists.
- [ ] Envelope **additive** fields on the existing result (`:198–209`):

```typescript
{
	phases: [...], // unchanged shape
	filePaths: { root, worktree? },
	source: string,            // ProgressSource.label
	source_ref?: string,
	source_commit?: string,
	source_age_seconds?: number,
	diverged_sources?: Array<{ source: string; ref?: string; age_seconds?: number }>,
}
```

- [ ] `formatPhasesText`: when `source` is not the checked-out worktree/HEAD file, print a line `source: origin/5x/<slug> (fetched 2h ago)` so users do not distrust unchecked local boxes (`207` §2.4.5).
- [ ] Unreachable `head_commit` on verbose output is **not** required on `plan phases` today (no `--verbose`). If adding a verbose note later, it is informational. Do not fail the command.

#### 5.3 `plan list` — `plan-v1.handler.ts:270–377` and `plan-v1.ts:44–68`

- [ ] Add `--fetch` / `--all-refs`.
- [ ] Include `config.paths.records` in `planListSkipSubtrees` (`:222–234`).
- [ ] After scanning checkout `.md` files, **union** plan paths discovered from `listFiveXRefs` (`git ls-tree -r --name-only <ref> -- <plansRel>` filtered to `.md`, minus reviews/records skip roots). Branch-only plans appear with their source.
- [ ] Per plan, call `resolvePlanProgress` (shared cache). Derive `completion_pct` from the resolved markdown the same way as today (`:312–323`).
- [ ] Extend `PlanListEntry` (`:90–101`):

```typescript
source: string;
source_ref?: string;
source_age_seconds?: number;
diverged?: boolean;
```

Do not remove `active_run` / `runs_total` — those remain local-index coordination. If the index is empty on a fresh clone, `runs_total` is 0 until `records index`; progress still comes from git.

- [ ] `formatPlanListText`: add a `Source` column.
- [ ] `--fetch`: `listRemotes` then `fetchFiveXBranches` each. Fetch failure is a **warning** on stderr, not a hard fail (offline clone still lists local refs).

#### 5.4 `run state --plan` — `run-v1.handler.ts:1092–1181`

When `params.plan` is set (`:1100–1104`), resolve progress and add the same additive `source*` fields on the **top-level** success payload (`:1163–1178`). Still select the local active run for step listing (coordination). If no local run:

- [ ] If the resolved records at the winning commit contain a `run.json`, surface that summary (`status` from the record, `steps` from decoding `steps.jsonl` via `gitShowFile`) **without** requiring SQLite rows. Auto-increment `steps.id` in the formatted output may be missing; use `null` or omit `id` — **do not change** `formatStep` keys for the SQLite path. Prefer: when SQLite has the run, keep today's step objects; when only git has it, emit steps without `id` (additive omission). Document in 101.
- [ ] `RUN_NOT_FOUND` only when neither the local index nor the resolved record has a run.

Existing `--run` path is unchanged (no resolution).

#### 5.5 Integration fixture — `test/integration/records/progress-resolution.test.ts` (new)

Timeout 30s. `cleanGitEnv()`, `stdin: "ignore"`. Scripted repo:

| Case | Setup | Expect |
|------|--------|--------|
| merged | `5x/slug` squash-merged to `main`, branch deleted, records on `main` | `source: HEAD` (or `main`), progress from merged checklists |
| stacked | branch A based on B; plan B never touched on A | plan B's candidate from A dedupes to B's base; not diverged |
| diverged | two branches both edit the same plan file | `source: diverged`, both labels listed, `completion_pct` = max |
| branch-only | plan exists only on `5x/slug`, not `main` | listed with `source: 5x/slug` |
| remote-only | only `origin/5x/slug` (local branch deleted); without `--fetch` uses stale remote-tracking; with `--fetch` updates | `source: origin/5x/slug`, `source_age_seconds` present |
| worktree | mapped worktree has newer checklist than `main` | `source: worktree` |
| no implicit fetch | remote updated but no `--fetch` | still shows old remote-tracking SHA |

- [ ] Envelope `source` field present in JSON mode; text mode mentions source when not checkout.

---

## Phase 6: Records index and doctor check

**Completion gate:** `5x records index` on a fresh clone (DB empty, records on the fetched `5x/<slug>` branch) materializes `runs` / `steps` identical modulo autoincrement ids and local-only columns (`session_id`, `log_path`, `updated_at`). Newer local-only SQLite steps are not deleted. `doctor` reports missing lines, missing rows, unreachable `head_commit` (warn), stale uncommitted record files, and `RECORD_TXN_CORRUPT` (fail, not fixable); `--fix` only runs index.

#### 6.1 Index rebuild — `src/records/index-rebuild.ts` (new)

```typescript
export interface IndexRebuildResult {
	runs_upserted: number;
	steps_upserted: number;
	steps_skipped_newer_local: number;
	plans: string[];
}

export async function rebuildRecordsIndex(opts: {
	db: Database;
	recordStore?: RecordStore; // unused for git-at-commit reads
	workdir: string;
	config: FiveXConfig;
	planSlug?: string;
	resolve: typeof resolvePlanProgress;
}): Promise<IndexRebuildResult>;
```

For each plan (or `--plan` slug):

1. `resolvePlanProgress`.
2. `gitShowFile` `run.json` + `steps.jsonl` (+ decisions are **not** indexed into SQLite; prompts stay coordination).
3. Upsert `runs` by `id` (`createRunV1` if missing; `completeRun` if sealed; do not force `active` over a local `completed` unless the record is sealed-completed — record wins for **terminal** status; local `active` + record `active` keep local `updated_at`).
4. For each step line, `findExistingStep` / `recordStep`. If SQLite has a row for that key, **do not overwrite** `result_json`. If SQLite has a step whose key is **absent** from the record and whose `created_at` is newer than the newest record line (in-flight local work), keep it (`steps_skipped_newer_local++`). If SQLite has a key absent from the record and **older** than lingering-run threshold, still keep it (do not delete user data); doctor reports `RECORD_INDEX_EXTRA_ROW`.
5. Never delete rows in this slice (safer). Doctor `--fix` does not delete extras.

- [ ] Idempotent: second `records index` is a no-op on counts.
- [ ] `session_id` / `log_path` stay null on rebuilt rows.

#### 6.2 Command — `src/commands/records.ts` + `records.handler.ts` (new)

Commander nested group, pattern `plan-v1.ts` / `lock.ts`:

```typescript
export function registerRecords(parent: Command): void;
// 5x records index [--plan <slug>]
// 5x records backfill  (Phase 7)
```

Register in `bin.ts` (`:88–104`) next to `registerDoctor`.

Handler uses `resolveDbContext` (allowed: this **is** the index command) + `rebuildRecordsIndex`. No `bun:sqlite` import in the handler file — pass `db` from context into `index-rebuild.ts` which may import `operations-v1`.

- [ ] Success envelope: `{ runs_upserted, steps_upserted, steps_skipped_newer_local, plans }`.
- [ ] `--plan` limits to one slug (`planSlugFromPath` / exact directory name).

#### 6.3 Doctor check — `src/doctor/checks/records.ts` (new)

Join `builtinDoctorChecks` (`registry.ts:17–25`) after `invocationsCheck`.

| Code | Status | Meaning | `fixable` | Identity (`findingKey`) |
|------|--------|---------|-----------|-------------------------|
| `RECORD_INDEX_MISSING_ROW` | fail | JSONL line with no SQLite step | true | `detail.stepKey` |
| `RECORD_INDEX_MISSING_RUN` | fail | `run.json` with no `runs` row | true | `detail.runId` |
| `RECORD_INDEX_EXTRA_ROW` | warn | SQLite step with no record line | false | n/a |
| `RECORD_HEAD_UNREACHABLE` | warn | `head_commit` not in any known ref | false | n/a |
| `RECORD_UNCOMMITTED_STALE` | warn | dirty files under the **re-rooted** records root older than `LINGERING_RUN_AGE_MS` (`runs.ts:23`) | false | n/a |
| `RECORD_TXN_CORRUPT` | fail | corrupt, torn, or incomplete `.txn.*` journal / commit marker so mixed-stream recovery cannot proceed | false | `detail.runId` |
| `RECORD_INDEX_OK` | ok | summary | false | n/a |

`--fix`: `fixable` findings call `rebuildRecordsIndex` once per unique `(check, runId or planSlug)` — not per step. Re-detect must drop `MISSING_ROW` / `MISSING_RUN`. **Do not** commit files, do not delete extras, do not rewrite JSONL, **do not** delete or rewrite `.txn.*` on `RECORD_TXN_CORRUPT` (not fixable; operator inspects leftover `.old` / `.new` or restores from git).

`RECORD_UNCOMMITTED_STALE` inspects `git status` in each mapped plan worktree (and the control-plane checkout when a plan has no mapping), using `resolveRecordsRoot` with that checkout as `effectiveWorkdir`. Do not only `git status` the main checkout — a `--worktree` run's dirty records live in the linked worktree.

`RECORD_TXN_CORRUPT` walks `recordsAbsPath` in each of those checkouts for `.txn.journal.json` / `.txn.commit` that fail `recoverRunDir` (catch `RECORD_TXN_CORRUPT`). Include `runId` and the run directory path in the finding detail. Leave artifacts on disk. If `.txn.lock` is held by a **live** PID, do **not** call `recoverRunDir` and do **not** emit `RECORD_TXN_CORRUPT` (transaction in flight). If `.txn.lock` exists but is **unreadable/empty/malformed**, do **not** treat it as absent and do **not** immediately steal it — same P0.5 rule as acquire; skip recover for this pass (do not emit `RECORD_TXN_CORRUPT`). If the lock is stale (dead PID) or absent with leftover journal/commit files, acquire/steal the lock then recover; on `RECORD_TXN_CORRUPT`, report it and release the lock without deleting artifacts. `RECORD_TXN_LOCKED` is a store error, not a doctor finding.

- [ ] `findingKey` cases in `registry.ts:83–116` for `RECORD_INDEX_MISSING_ROW` (`stepKey`), `RECORD_INDEX_MISSING_RUN` (`runId`). `RECORD_TXN_CORRUPT` is not fixable; still pass `runId` in detail for operator UX. Empty identity on fixable must throw (existing invariant).
- [ ] Unit: `test/unit/doctor/records.test.ts`. Integration: seed drift in temp repo; `5x doctor --json` contains codes; `5x doctor --fix` lists them under `fixed`; re-run clean for fixable codes. Seed a torn `.txn.commit` and assert `RECORD_TXN_CORRUPT` is reported and `--fix` does not delete journal files. Seed a live `.txn.lock` (child PID alive + prepared journal) and assert doctor does **not** emit `RECORD_TXN_CORRUPT` and does **not** delete staging. Seed an empty/unreadable `.txn.lock` plus a prepared journal and assert doctor does **not** immediately recover or emit `RECORD_TXN_CORRUPT`.
- [ ] `test/unit/doctor/registry.test.ts` — check order includes `records`; identity cases.

---

## Phase 7: Records backfill

**Completion gate:** `records backfill --dry-run` on a DB with historical runs prints a deterministic run → target mapping and file list without writing. A real run writes records with `provenance: "backfilled"`, commits to the correct branch, is idempotent on a second run, reports disagreements without overwriting, and leaves active runs unsealed (`status: active`, `backfilled: true`). `patch_id` is null unless both SHAs are reachable.

#### 7.1 Target-branch rule — `src/records/backfill.ts` (new)

`--target auto` (`207` §2.7):

1. If `refs/heads/5x/<slug>` exists **or** any `refs/remotes/*/5x/<slug>` exists → records go to `5x/<slug>`. Prefer the mapped worktree (`plans.worktree_path`) if it is that branch; otherwise `git worktree add` a temporary worktree (remove in `finally`).
2. If the branch is gone (merged and deleted, no remote-tracking) → current branch, aggregate commit message `5x: backfill records` (multiple runs in one commit when several share this fallback).
3. `--target <branch>` overrides auto (must exist).

Commit message for the branch-exists case: `5x: backfill records for <run-id>` (one commit per run) **or** one commit per target branch per invocation listing all run ids — pick **one commit per target branch per command invocation** (fewer commits, still bisectable). Dry-run prints the mapping either way.

```typescript
export interface BackfillParams {
	planSlug?: string;
	target: "auto" | string;
	dryRun: boolean;
	startDir?: string;
}

export interface BackfillMapping {
	run_id: string;
	plan_path: string;
	target_branch: string;
	worktree: string | null;
	files: string[];
	disagreements: Array<{ key: string; reason: string }>;
}
```

Export algorithm:

1. `listRuns` (no 50 cap — pass a high limit or add `listRuns(db, { limit: 0 })` meaning unlimited; do not silently truncate).
2. Filter `--plan` by slug.
3. For each run, `getSteps`. Build `RunRecordSummary` (`provenance` N/A on summary; `backfilled: true` if `status === "active"`; if already terminal, `sealed_at = updated_at`, `final_head_commit` from last step with `head_commit`).
4. For each step, apply field policy + redact. `provenance: "backfilled"`. `patch_id` only when `computePatchId` succeeds.
5. `human:*` steps also become decision lines.
6. Answered prompts for that `run_id` (`list` via PromptStore or SQL in `backfill.ts` through a small helper that uses `operations`/prompt store — **not** from the records handler importing sqlite) → decision lines. If adding a `listAnsweredPrompts(runId)` on PromptStore is too much scope, a dedicated `src/records/backfill-prompts.ts` that uses `createSqlitePromptStore(db).` — PromptStore has `getPrompt` / `listOpenPrompts` only. **Add** `listPrompts(filter: { runId: string; answered?: true })` to PromptStore? That would change the frozen prompt contract. **Do not.** Query via a new function in `src/control-plane/sqlite-store.ts` exported as a non-interface helper, or a one-off SQL in `backfill-prompts.ts` colocated with the index layer. Prefer: `createSqlitePromptStore` gains `listPromptsByRun(runId)` **on the impl class but not the interface** — messy. Clean: add optional `listAnsweredPrompts(runId)` to `PromptStore` as a documented additive method (Phase 7 only, not Phase 1 freeze). Tests on both prompt impls. This is additive and backward compatible for 06.
7. Write via `WorkingTreeRecordStore` in the target worktree: `createWorkingTreeRecordStore({ recordsRoot: resolveRecordsRoot({ recordsConfigAbs: config.paths.records, controlPlaneRoot, effectiveWorkdir: targetWorktree }).recordsAbsPath })`. Existing lines: skip if keys match **and** payloads equal (deep equal of canonical JSON); if keys match and payloads **differ**, push a disagreement and **do not overwrite**.
8. Commit unless `dryRun`.

- [ ] Dry-run: no `git add`, no file writes (compute mappings in memory; existence checks only).
- [ ] Second real run: `disagreements: []`, `created: false` for every line, no new commit if `git status` clean.
- [ ] Two DBs with partial history (A: phases 1–3, B: 4–5) backfill independently; after merge=union, `decodeJsonlFile(text, runId)` contains all keys.
- [ ] Pre-v5 rows (`head_commit` null): export with `head_commit: null`; `plan list` may show `source: backfilled` when the only record is on HEAD with `backfilled: true` and no conventional branch — only if no other candidate exists.

#### 7.2 CLI — `records.handler.ts`

```
5x records backfill [--plan <slug>] [--target auto|<branch>] [--dry-run]
```

Default `--target auto`.

- [ ] Integration tests as listed in the Tests table. Use two temp clones for the partial-history case.
- [ ] Never push. Never fetch unless we need to see remote `5x/<slug>` for the auto rule — use already-present remote-tracking refs; document that `--target auto` does not fetch (operator fetches first, or we accept missing remote as "branch gone"). **Do not** implicit-fetch here (forbidden without `--fetch`; backfill has no `--fetch`). Remote-tracking existence is enough.

---

## Phase 8: Docs, exports, and compatibility

**Completion gate:** `207` status is "Implemented" (or "Implemented — local working-tree records; remote plane still deferred") with this plan linked. `101-cli-primitives.md` documents `records index`, `records backfill`, `--fetch`, `--all-refs`, and `source`. Config reference includes `paths.records` and `records.redact`. Public exports include `RecordStore` / factories. Full `bun test` green. No skill/template hot-loop changes (composites already wrap primitives) — confirm `5x-phase-execution` still only calls `phase finish` / `run record` / `commit`.

#### 8.1 Docs

- [ ] `docs/v2/207-state-segmentation.md`: Status line; **Implementation plan** link to this file; mark open questions 1–2 resolved as implemented (seal commit; keep SQLite as index). Leave Q3 `plan.autoFetch` and Q4 lease interface as open/deferred.
- [ ] `docs/v1/101-cli-primitives.md`:
  - §2 taxonomy (`:82–92`): add **Records** group (`records index`, `records backfill`).
  - §3 `run init` / `run record` / `run complete`: dual-write + seal commit.
  - §6 `plan phases` (`:589`) / `plan list` (`:614`): `--fetch`, `--all-refs`, `source` fields; branch-only discovery.
  - New §6b (or under Inspection): `5x records index` / `backfill` flags, dry-run, target rule, doctor `--fix`.
  - §10 idempotency: JSONL first-line-wins ≡ `INSERT OR IGNORE`; no key change.
  - §13 (`:1193`): `paths.records`, `records.redact` example.
- [ ] Do not rewrite skills unless a command name in the hot loop changed (none expected).

#### 8.2 Exports

- [ ] `src/control-plane/index.ts` and `src/index.ts`: `RecordStore`, `createMemoryRecordStore`, `createWorkingTreeRecordStore`, `stepIdempotencyKey`, record types, `RecordStoreError`.
- [ ] Do not export SQL or filesystem helpers from the public control-plane barrel except the two factories.

#### 8.3 Compatibility sweep

- [ ] Existing envelope fields on `plan list`, `plan phases`, `run state`, `run record`, `commit` unchanged (additive only).
- [ ] Integration `text-output.test.ts` updated for new columns/lines.
- [ ] `test/unit/git.test.ts` porcelain `-z` mocks updated for `checkGitSafety` (Phase 4) — confirm still green.
- [ ] No `bun:sqlite` in `src/commands/plan-v1.handler.ts`, `records.handler.ts`, `prompt.handler.ts` (prompt still uses PromptStore). `index-rebuild.ts` / `backfill.ts` may use `operations-v1` (already sqlite-backed) but not new ad-hoc SQL in command files.

---

## Files Touched

| File | Change |
|------|--------|
| `src/control-plane/record-types.ts` | **New.** Stream/payload/summary types, `RecordStoreError`, `stepIdempotencyKey`. |
| `src/control-plane/record-store.ts` | **New.** `RecordStore` interface. |
| `src/control-plane/record-memory.ts` | **New.** In-memory impl (Phase 1 freeze). |
| `src/control-plane/record-fs.ts` | **New.** Working-tree JSONL impl; per-run `.txn.lock` + immutable `.txn.journal.json` + checksummed `.txn.commit` + `fsyncDir` + fail-closed `recoverRunDir`. |
| `src/control-plane/record-layout.ts` | **New.** Paths, JSONL encode/decode (`decodeJsonlFile(text, runId)`), first-key-wins. |
| `src/control-plane/record-redact.ts` | **New.** `redactStepPayload`. |
| `src/control-plane/index.ts` | Re-export RecordStore types and factories. |
| `src/index.ts` | Public API re-exports. |
| `src/config.ts` | `paths.records`, `RecordsSchema`, `resolveConfigPaths` (inside-repo validation), `KNOWN_ROOT_CONFIG_KEYS`. |
| `src/templates/5x.default.toml` | Default `paths.records`; commented `[records]`. |
| `src/git.ts` | `checkGitSafety` exempt roots + porcelain `-z`; `computePatchId`, `computeDiffSummary`, `gitShowFile`, `gitLogLastTouching`, `listFiveXRefs`, `isAncestor`, `fetchFiveXBranches`, `listRemotes`. |
| `src/utils/subprocess.ts` | `execGitStdin` for `git patch-id`. |
| `src/commands/init.handler.ts` | `ensureGitattributes`; `${recordsRelPath}/**/.txn.*` gitignore; call from `initScaffold`. |
| `src/commands/upgrade.handler.ts` | Call `ensureGitattributes` / txn gitignore during upgrade. |
| `src/commands/run-v1.handler.ts` | `prepareRecordStepAppend`; dual-write; `putRun` on init/complete; seal commit; `checkGitSafety` opts; `run state --plan` source; worktree-re-rooted store. |
| `src/commands/commit.handler.ts` | Always stage `recordsRelPath` with `--files` when `recordsAbsPath` exists in the effective worktree. |
| `src/commands/record-context.ts` | **New.** Factory: `resolveDbContext` + `resolveRecordsRoot` + working-tree `RecordStore`. |
| `src/records/paths.ts` | **New (Phase 4).** `resolveRecordsRoot` — canonical rel path + worktree-absolute path. |
| `src/commands/prompt.handler.ts` | Decision snapshot on answered run-scoped prompts. |
| `src/commands/prompt-context.ts` | Pass a worktree-re-rooted `recordStore` on context. |
| `src/commands/plan-v1.handler.ts` | Resolution, skip records subtree, `source` fields, `--fetch`/`--all-refs`, branch-only discovery. |
| `src/commands/plan-v1.ts` | Flags `--fetch`, `--all-refs`. |
| `src/commands/run-v1.ts` | `--fetch` / `--all-refs` on `run state` if they apply when `--plan` is set. |
| `src/commands/records.ts` | **New.** Commander `records index` / `records backfill`. |
| `src/commands/records.handler.ts` | **New.** Handlers. |
| `src/records/resolve.ts` | **New.** Progress resolution algorithm. |
| `src/records/index-rebuild.ts` | **New.** Index upsert. |
| `src/records/backfill.ts` | **New.** Export + target rule. |
| `src/bin.ts` | `registerRecords`. |
| `src/doctor/checks/records.ts` | **New.** Doctor `records` check. |
| `src/doctor/registry.ts` | Register check; `findingKey` cases. |
| `src/control-plane/store.ts` / `memory-store.ts` / `sqlite-store.ts` | Additive `listAnsweredPrompts(runId)` for backfill (Phase 7 only). |
| `docs/v2/207-state-segmentation.md` | Status, plan link, resolved open questions. |
| `docs/v1/101-cli-primitives.md` | Commands, flags, `source`, config keys. |

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/control-plane/record-store-contract.test.ts` | Memory (Phase 1) and working-tree (Phase 3) share append/get/list/duplicate/`atomicAppend`/insertion-order/budget stream. |
| Unit | `test/unit/control-plane/record-fs.test.ts` | Journal rollback/roll-forward; `fsyncDir` after create/rename/unlink; torn commit marker / corrupt journal fail closed (`RECORD_TXN_CORRUPT`, artifacts kept); live `.txn.lock` is not recovered (`RECORD_TXN_LOCKED`); stale lock is stolen then recovered; lock metadata published atomically (`linkSync`, never empty `wx`); empty/malformed lock is not immediately stolen (P0.5); JSONL first-key-wins; `decodeJsonlFile(text, runId)` for steps/decisions/budget; directory layout. |
| Unit | `test/unit/control-plane/record-redact.test.ts` | Field policy; non-redactable keys. |
| Unit | `test/unit/git.test.ts` | Safety exemption scope; porcelain `-z`; patch-id/numstat/show/log mocks. |
| Unit | `test/unit/config.test.ts` / `config-registry.test.ts` | `paths.records`, `records.redact` defaults; absolute-inside accepted; absolute-outside and escaping relative rejected. |
| Unit | `test/unit/commands/init.test.ts` / `upgrade.test.ts` | `.gitattributes` create/append/idempotent/custom inside-repo root; `.txn.*` gitignore line. |
| Unit | `test/unit/commands/run-v1.handler.test.ts` | `prepareRecordStepAppend` no-write failures; dual-write admit/duplicate; init `putRun`; complete seal-before-completeRun. |
| Unit | `test/unit/commands/commit.test.ts` | `--files` add pathspec includes `recordsRelPath`. |
| Unit | `test/unit/commands/prompt-store.test.ts` | Decision line on answer; skip without `runId`; no duplicate on CAS loser. |
| Unit | `test/unit/records/paths.test.ts` | `resolveRecordsRoot` same-checkout vs linked worktree; outside-repo throws. |
| Unit | `test/unit/records/resolve.test.ts` | Ancestor prune, diverged, missing ref (mocked git). |
| Unit | `test/unit/records/index-rebuild.test.ts` | Upsert; skip newer local-only; idempotent. |
| Unit | `test/unit/records/backfill.test.ts` | Target auto (live branch vs deleted); disagreement; dry-run no writes; `provenance: backfilled`. |
| Unit | `test/unit/doctor/records.test.ts` | Missing row/run, extra row, unreachable head, stale uncommitted, `RECORD_TXN_CORRUPT`; live `.txn.lock` is not reported as corrupt; empty/unreadable `.txn.lock` is not immediately stolen or reported as corrupt; `--fix` identity; `--fix` does not delete `.txn.*`. |
| Unit | `test/unit/doctor/registry.test.ts` | `records` registered; `findingKey` for fixable codes. |
| Integration | `test/integration/commands/run-v1.test.ts` | Record files after `run record`; dirty records do not `DIRTY_WORKTREE`; other dirty still does. |
| Integration | `test/integration/commands/commit.test.ts` | Phase commit contains `steps.jsonl` lines. |
| Integration | `test/integration/commands/phase.test.ts` (or existing phase test) | `phase finish` appends a record line. |
| Integration | `test/integration/records/progress-resolution.test.ts` | Merged, stacked, diverged, branch-only, remote-only, worktree, no implicit fetch. |
| Integration | `test/integration/commands/plan-v1.test.ts` | Envelope `source`; `--fetch` / `--all-refs`; skip records subtree. |
| Integration | `test/integration/commands/doctor.test.ts` | `records` check in sweep; `--fix` re-index only. |
| Integration | `test/integration/records/backfill.test.ts` | Dry-run mapping; real commit; second run no-op; two-DB partial history + union; disagreements. |
| Integration | `test/integration/records/index.test.ts` | Fresh clone + `records index` matches origin steps modulo ids/local columns. |
| Integration | `test/integration/records/merge-union.test.ts` | Two branches append distinct JSONL lines; merge has no conflict markers and both keys. |
| Integration | `test/integration/records/worktree-records.test.ts` | `run init --worktree`: `run.json` + step line in the linked worktree; `5x commit` from that worktree includes them. |
| Integration | `test/integration/records/atomic-append-crash.test.ts` | Fault-injection after each stream replacement, each directory-sync point, and during recovery; torn/corrupt commit marker; stale-lock recovery; no visible partial mixed-stream batch. |
| Integration | `test/integration/records/concurrent-append.test.ts` | Two OS processes concurrently `atomicAppend` distinct step vs decision (or step vs budget) ops to one run; both lines persist; no leftover `.txn.*`; no `RECORD_TXN_CORRUPT`. Creation-window variant: first process pauses after exclusive lock-path creation and before metadata publication; contender does not obtain the lock or recover. |
| Integration | `test/integration/commands/text-output.test.ts` | Source column / source line. |
| Integration | `test/integration/commands/init.test.ts` / `upgrade.test.ts` | `.gitattributes` on disk. |

Edge cases (must appear in the suites above):

- Duplicate step key after `merge=union` concatenation: first line wins.
- `records.redact = ["cost_usd"]`: line has `cost_usd: null`; SQLite row may still have the number (index is local). **Decision:** project redacted values into SQLite too so index matches the record (rebuildable). Implement: `recordStep` input uses redacted cost fields.
- Unreachable `head_commit` after simulated squash: doctor warn, `plan list` still works.
- `--files` with missing records dir: no extra `git add` pathspec, commit still succeeds.
- Linked worktree: records written and committed in the worktree, not the control-plane checkout.
- Mixed-stream `atomicAppend` interrupted after each file replacement, each directory-sync, and during recovery: no visible partial batch. Torn or corrupt commit marker / journal throws `RECORD_TXN_CORRUPT` and leaves artifacts. A live `.txn.lock` is not recovered (`RECORD_TXN_LOCKED`); a stale lock is stolen then recovered. An empty/unreadable `.txn.lock` is not immediately stolen; a contender in that window does not obtain the lock or reach journal recovery.
- Two OS processes concurrently appending a step and a decision (or budget) to the same run: both records survive; no journal leftover.
- Absolute `paths.records` inside the repo is accepted; absolute or relative path outside is `RECORDS_ROOT_OUTSIDE_REPO`.
- `decodeJsonlFile` reconstructs `runId` for steps, decisions, and budget lines.

---

## Not In Scope

- **Remote control plane** (leases, run registry, prompt queue remote impl, invocation remote impl, event stream, blob store) — `207` §2.8; new design doc, not this slice.
- **Git-as-lock / claim files / push-as-CAS** — rejected in `207` §3.
- **`refs/5x/*` record storage** — reserved; only the path-agnostic interface is required.
- **Coordination tables in git** — `prompts` (open), locks, invocation registry, `.5x/current-run` stay local (`204` §3, `207` §2.2).
- **Budget line payloads and v8 index tables** — slice 06 (`208-review-budget-advisory-plan.md`) against this Phase 1 freeze. This slice only provides stream `"budget"`.
- **Dashboard reading git** — `04-control-plane-dashboard` keeps reading the SQLite index.
- **Dropping SQLite** — remains the index (`207` open question 2).
- **`plan.autoFetch`** — `207` open question 3; teams that want implicit fetch wait.
- **`coordination.allowOffline`** — tagged in `207` §3/§4 for a future remote plane; not wired here.
- **Changing step idempotency keys or existing envelope field names.**
- **Network without `--fetch`.**
- **Skill/template rewrites** unless a primitive invocation in the hot loop changes (none expected).
- **Direct `bun:sqlite` in command handlers.**

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Freeze `RecordStore` + memory impl + contract tests (unblocks slice 06) | 1–2 days |
| 2 | `paths.records` / `records.redact` + inside-repo validation + `.gitattributes` via init/upgrade | 0.5–1 day |
| 3 | Working-tree JSONL, codecs (`decodeJsonlFile(text, runId)`), power-loss-durable journal (`fsyncDir`, checksummed commit marker, fail-closed recovery), per-run writer lock (atomic lock publish), patch-id helpers, contract on FS backend | 3–3.5 days |
| 4 | Dual-write, worktree re-root helper, `prepareRecordStepAppend`, safety exemption, commit staging, seal, decisions | 2–3 days |
| 5 | Resolution spike + algorithm + plan list/phases/run state `--plan` + git fixture | 2–3 days |
| 6 | `records index` + doctor `records` check | 1.5–2 days |
| 7 | `records backfill` (auto target, dry-run, disagreements, two-DB union) | 2–3 days |
| 8 | Docs, exports, text-output, full `bun test` | 1 day |
| **Total** | | **14–19 days** |

Phase 1 is a schedule gate for slice 06 Phase 4; land and tag it before 06 persistence work. Phase 5's ancestor-fan-out spike happens at the start of that phase, not as its own numbered phase. Phase 7 can start after Phase 3 (needs FS store) in parallel with Phase 5 if staffing allows, but it should not merge before Phase 4's `putRun`/redact helpers exist.

---

## Provenance

This plan implements slice `v2-git-native-run-records` from [`docs/v2/plan-inputs/10-git-native-run-records.plan-input.md`](../../v2/plan-inputs/10-git-native-run-records.plan-input.md), which is the implementation vehicle for [`docs/v2/207-state-segmentation.md`](../../v2/207-state-segmentation.md). It refines `200` §3a constraint #4 (repository is source of truth for the completed-work **record**; control plane remains source of truth for **coordination**; SQLite materializes both) and follows the `src/control-plane/` store-interface pattern established by [`205-prompt-queue-foundation-plan.md`](./205-prompt-queue-foundation-plan.md). Slice 06 ([`208-review-budget-advisory-plan.md`](./208-review-budget-advisory-plan.md)) consumes Phase 1 in parallel and must not fork `RecordStore`.

---

## Revision History

### 1.4 — August 31, 2026

Addresses **P0.5** in the August 31 addendum of [`docs/development/reviews/5x-cli-docs-development-plans-212-git-native-run-records-plan-review.md`](../reviews/5x-cli-docs-development-plans-212-git-native-run-records-plan-review.md) (Revision 1.3 re-review). Prior P0.1 / P0.2 / P0.3 / P0.4 / P1.1 / P1.2 remain as specified in 1.1–1.3.

1. **P0.5 — Atomic lock publication.** `.txn.lock` is no longer created with `openSync(..., "wx")` (empty pathname visible before `{ pid, owner }` is fsynced). Acquire writes a unique temp with the full lock record, `fsyncFile`s it, `linkSync`s onto `.txn.lock` (fails if the name exists), then `fsyncDir`s the run directory and removes the temp. A malformed/empty visible lock is never stolen on first observation; abandonment requires a dead PID or a continuous `lockTimeoutMs` of still-malformed reads. Fault-injection/multi-process coverage pauses after exclusive path creation and before metadata publication; the contender must not obtain the lock or reach journal recovery.

### 1.3 — August 31, 2026

Addresses **P0.4** in the August 31 addendum of [`docs/development/reviews/5x-cli-docs-development-plans-212-git-native-run-records-plan-review.md`](../reviews/5x-cli-docs-development-plans-212-git-native-run-records-plan-review.md) (Revision 1.2 re-review). Prior P0.1 / P0.2 / P0.3 / P1.1 / P1.2 remain as specified in 1.1–1.2.

1. **P0.4 — Per-run cross-process writer lock.** Store-internal `.txn.lock` (`O_EXCL` + PID liveness, matching `src/lock.ts`) is acquired before `recoverRunDir` / stream read / staging and held through directory-synced cleanup. Live owners are waited on (bounded `lockTimeoutMs`, then `RECORD_TXN_LOCKED`); only dead-PID locks are stolen and then recovered. Concurrent callers never recover an active prepared transaction. All writer paths including prompt `recordStore.append` use the lock. Multi-process integration test: concurrent distinct step vs decision/budget appends both persist without journal corruption or loss.

### 1.2 — August 31, 2026

Addresses **P0.3** in the August 31 addendum of [`docs/development/reviews/5x-cli-docs-development-plans-212-git-native-run-records-plan-review.md`](../reviews/5x-cli-docs-development-plans-212-git-native-run-records-plan-review.md) (Revision 1.1 re-review). Prior P0.1 / P1.1 / P1.2 remain as specified in 1.1.

1. **P0.3 — Power-loss-durable journal commit/recovery.** Directory `fsync` after every create, rename, and unlink in the run directory (staging, prepared journal, commit marker, each stream replacement, cleanup). Prepared metadata is an **immutable** `.txn.journal.json` (checksums of `.new` / `.old`); the commit decision is a **separate** checksummed `.txn.commit` (`journal_sha256`). Recovery never treats a corrupt or unreadable journal as `prepared`. Torn/mismatched commit marker, corrupt journal, or incomplete metadata throws `RECORD_TXN_CORRUPT` and leaves artifacts; doctor reports it and `--fix` does not delete `.txn.*`. Fault-injection covers directory-sync interrupt points and a corrupt/torn commit marker.

### 1.1 — August 31, 2026

Addresses all **P0** and **P1** items in [`docs/development/reviews/5x-cli-docs-development-plans-212-git-native-run-records-plan-review.md`](../reviews/5x-cli-docs-development-plans-212-git-native-run-records-plan-review.md) (no addendum; original review).

1. **P0.1 — Re-root records to the effective worktree.** `resolveRecordsRoot` converts control-plane `config.paths.records` into `{ recordsRelPath, recordsAbsPath }` under the run's `effectiveWorkingDirectory`. `run init`, record writers, seal dirty checks/commits, `5x commit` staging, prompt decisions, backfill, and doctor uncommitted-stale use the helper. Git pathspecs and `git show` keep the canonical repo-relative path. Integration test: `run init --worktree` writes `run.json` and a step line in the linked worktree and includes them in that worktree's `5x commit`.
2. **P0.2 — Durable mixed-stream `atomicAppend`.** Per-run `.txn.journal.json` with `prepared` then `commit` marker, staged `.new` / before-image `.old` files, fsync before advancing the marker, recovery on every open/read/append. `prepared` rolls back to pre-batch; `commit` rolls forward to the full batch. `.txn.*` is gitignored. Fault-injection tests interrupt after each replacement and during recovery; no visible partial mixed-stream batch remains.
3. **P1.1 — Reject records roots outside the repository.** After `resolveConfigPaths`, `!isPathUnder(paths.records, baseDir)` is `RECORDS_ROOT_OUTSIDE_REPO`. No warn-and-skip `.gitattributes` path. Tests cover relative default, absolute-inside, absolute-outside, and escaping relative.
4. **P1.2 — JSONL decode takes `runId`.** `decodeJsonlFile(text, runId)` reconstructs `RecordLine.runId`. Encode omits `run_id`; a mismatched on-disk `run_id` throws `INVALID_JSONL`. Coverage includes decisions and budget lines, not only steps.

### 1.0 — August 31, 2026

Initial draft.
