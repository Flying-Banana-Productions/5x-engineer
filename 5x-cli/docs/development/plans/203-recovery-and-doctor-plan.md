# Recovery & `5x doctor` — Lock Surface, Step Budget, Remediation, Doctor Registry

**Version:** 1.3
**Created:** August 18, 2026
**Last updated:** August 18, 2026
**Status:** Ready for implementation

---

## Executive Summary

Lock, step-budget, and repair primitives already exist; the CLI does not expose them. `acquireLock` auto-steals dead-PID and corrupt locks and `forceReleaseLock()` is implemented, but no command lists locks, unlocks them, or puts holder metadata on `PLAN_LOCKED`. `maxStepsPerRun` kills a run at the ceiling with no prior signal. Text-mode errors drop `detail.remediation` that JSON already carries. Stale worktree mappings, lingering active runs, and DB health require raw filesystem/sqlite inspection.

This plan implements `docs/v2/203-recovery-and-doctor.md`: a lock inspect/unlock surface over existing primitives, additive step-budget visibility, a non-breaking text-mode remediation line, and a `5x doctor` check registry with safe `--fix` actions. It reuses the area-201 `runHarnessFreshnessChecks()` / `harnessSyncCore()` seams and leaves prompt hygiene, remote liveness, and breaking output normalization to later slices.

### Scope

**In scope:**

- `5x lock list`, safe `5x unlock <plan>`, and `5x unlock <plan> --force` with holder details.
- Enriched `PLAN_LOCKED` detail (`holder`, `stale`, `remediation`) at every throw site, keeping existing `pid` / `started_at`.
- Step-budget fields on `run state`; 80% warning band on successful `run record`; actionable `MAX_STEPS_EXCEEDED` remediation.
- Text-mode errors print `→ <detail.remediation>` on stderr when present; JSON envelopes unchanged.
- `5x doctor` registry + standard envelope/text formatting; checks for harness freshness, locks, worktrees, lingering runs, and DB health; `--fix` only for deterministic non-destructive repairs.
- Unit + integration tests; docs status updates reflecting the implemented subset and deferred prompt check.

**Out of scope:**

- **Orphaned-prompt doctor check** — deferred to `03-prompt-queue-foundation` once prompt rows exist.
- **Remote-provider liveness / opaque invocation handles** — owned by `05-invocation-registry`.
- **Breaking output normalization** — owned by `09-output-normalization-release` / `205`.
- **PID-start-time verification, plugin-contributed checks, configurable warning thresholds** — deferred unless a later spike proves they are required.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Export `listLocks` / lock-entry types; keep `isPidAlive` private** | `isLocked` hides corrupt files (`locked: false`); `lock list` needs a directory scan with `live` / `stale` / `corrupt` verdicts. PID liveness stays behind the existing seam for later remote-handle swap. |
| **`--force` + visible holder suffice for PID reuse / EPERM** | Avoids OS-specific start-time checks; escape hatch is explicit and audited by printing the overridden holder. |
| **Fixed 80% step-warning threshold** | One less config knob for v2; matches plan-input assumption. |
| **Warn-only doctor results exit 0; any `fail` exits nonzero** | Usable in CI/preflight without treating warnings as breakage. |
| **`doctor` and `lock list` both ship** | Doctor is the full sweep; `lock list` answers the targeted question. `unlock` is a top-level command (`5x unlock`), matching 203. |
| **`--fix` only when exactly one correct answer** | Stale/corrupt lock → remove; dead worktree mapping → clear; lossless project harness → sync. Everything else is report + remediation command. |
| **Doctor always runs harness freshness; `freshnessWarnings=off` stays hot-path only** | Explicit diagnostics must not be silenced by the incidental-warning switch. |
| **Doctor harness `--fix` requires 201 lossless-refresh** | Auto-sync only when `FreshnessReport.losslessRefresh === true`. Context-mismatched / hand-edited project installs stay report-only. |
| **DB doctor opens read-only / no-create / no-migrate** | Never call `resolveDbContext()` or `getDb()` for inspection — those migrate and create. |
| **Corrupt locks removed by confined `lockPath`, not plan path** | `findExistingLock` skips unparsable non-canonical files. Doctor uses a lock-dir-confined helper on `LockEntry.lockPath`. |
| **Per-check failures become findings; fix then re-detect** | A thrown check must not abort the sweep. `--fix` records `fixed` only after a post-repair re-detect clears that finding by `findingKey` (code + identifying detail), not `code` alone. `DoctorCheck.fix` must re-validate its target so iterating the original `detected` array stays safe. |

### References

- [`docs/v2/203-recovery-and-doctor.md`](../../v2/203-recovery-and-doctor.md) — canonical requirements.
- [`docs/v2/201-harness-freshness.md`](../../v2/201-harness-freshness.md) — freshness states and doctor Tier-2 contract.
- [`docs/development/plans/201-harness-freshness-plan.md`](./201-harness-freshness-plan.md) — implemented `runHarnessFreshnessChecks()` / `harnessSyncCore()` APIs.
- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — shared-core §3.3 doctor; §3a forward-compat.
- [`docs/v1/100-architecture.md`](../../v1/100-architecture.md) — §4a output/error contract being extended additively.
- Plan input: [`docs/v2/plan-inputs/01-recovery-and-doctor.plan-input.md`](../../v2/plan-inputs/01-recovery-and-doctor.plan-input.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Architecture Overview](#architecture-overview)
4. [Phase 1: Lock inventory + CLI unlock surface](#phase-1-lock-inventory--cli-unlock-surface)
5. [Phase 2: Text-mode remediation](#phase-2-text-mode-remediation)
6. [Phase 3: Step-budget visibility](#phase-3-step-budget-visibility)
7. [Phase 4: Doctor registry, formatting, and CLI skeleton](#phase-4-doctor-registry-formatting-and-cli-skeleton)
8. [Phase 5: Doctor checks — freshness, locks, worktrees](#phase-5-doctor-checks--freshness-locks-worktrees)
9. [Phase 6: Doctor checks — runs, db; docs and end-to-end validation](#phase-6-doctor-checks--runs-db-docs-and-end-to-end-validation)
10. [Files Touched](#files-touched)
11. [Tests](#tests)
12. [Not In Scope](#not-in-scope)
13. [Estimated Timeline](#estimated-timeline)
14. [Revision History](#revision-history)
15. [Provenance](#provenance)

---

## Overview

Lock, step-budget, and repair primitives are stronger than the CLI surface. Operators hit `PLAN_LOCKED` / `MAX_STEPS_EXCEEDED` / `WORKTREE_MISSING` with incomplete guidance, and there is no `doctor` front door.

**Current behavior:**

- `acquireLock` auto-steals dead-PID and corrupt locks (`src/lock.ts:131-160`); `forceReleaseLock()` exists (`src/lock.ts:237-246`) but no command exposes it.
- `isLocked` returns `{ locked: false }` for corrupt files (`src/lock.ts:277-280`), so any listing built on it would miss the files operators need to clear.
- `PLAN_LOCKED` at `run init` / `complete` / `reopen` carries flat `{ pid, started_at }` only (`src/commands/run-v1.handler.ts:811-818`, `:1222-1226`, `:1294-1298`) — no nested `holder`, no `stale`, no remediation command.
- Text-mode errors print a single `Error: <message>` line (`src/bin.ts:117-120`); structured `detail.remediation` (e.g. `src/commands/run-context.ts:125-126`, `:165-166`) is dropped.
- `run record` enforces `maxStepsPerRun` with no prior warning (`src/commands/run-v1.handler.ts:1054-1067`); `run state` summary has `total_steps` but no max / remaining (`:975-988`).
- No `doctor` / `lock` / `unlock` commands registered in `src/bin.ts:82-96`.
- Area 201 exported `runHarnessFreshnessChecks()` (`src/harnesses/freshness.ts:67-139`) and `harnessSyncCore()` (`src/commands/harness.handler.ts:660`) for this slice to consume. `FreshnessReport` already carries `losslessRefresh` / `losslessBlockers` (`src/harnesses/manifest.ts:823-838`).
- `openDbReadOnly` exists (`src/db/connection.ts:64-67`) and does not create files or run pragmas. `resolveDbContext()` (`src/commands/context.ts:82-149`) always opens via `getDb()` (creates parent/file, sets WAL) and migrates by default.

**New behavior:**

- `5x lock list` enumerates `.5x/locks/*.lock` (or the control-plane `stateDir` lock dir) with `live` / `stale` / `corrupt` verdicts.
- `5x unlock <plan>` releases stale/canonical-corrupt locks; refuses live holders with holder info; `--force` calls `forceReleaseLock` and prints the overridden holder.
- `PLAN_LOCKED.detail` always includes `holder`, `stale: false`, and a remediation naming `5x unlock <plan> --force` (existing `pid` / `started_at` fields retained for compatibility).
- Successful `run record` past 80% of `maxStepsPerRun` adds `step_budget` + `warnings`; `run state` always includes `steps_used` / `max_steps` / `steps_remaining`; `MAX_STEPS_EXCEEDED` names config bump and split-work outs.
- Text-mode errors append `  → <remediation>` on stderr when `detail.remediation` is a string; JSON stdout unchanged.
- `5x doctor [--fix]` runs five built-in checks with a standard envelope and human text formatter; `--fix` applies only safe repairs (lossless harness sync, stale/path-addressed corrupt locks, dead worktree mappings). Per-check failures become findings; DB inspection is read-only/non-creating.

**Prerequisites:**

- [`201-harness-freshness-plan.md`](./201-harness-freshness-plan.md) — complete; freshness API available.

---

## Design Decisions

**Lock listing is a new exported scan, not a loop over `isLocked`.** `isLocked` returns `{ locked: false }` for corrupt files (`src/lock.ts:277-280`), so a doctor/`lock list` built on it would miss the exact files operators need to clear. Export `listLocks(projectRoot, opts?)` that reads every `*.lock` under the lock dir, classifies each entry, and never mutates. Keep `isPidAlive` / `readLockFile` / `findExistingLock` private; re-export `listLocks` from `src/index.ts` alongside existing lock exports (`src/index.ts:77-89`).

**Safe unlock reuses `releaseLock`; force unlock reuses `forceReleaseLock`.** No new lock semantics. The CLI layer only adds: plan-path resolution (same `resolvePlanArg` / `canonicalizePlanPath` / control-plane `stateDir` pattern as `runV1Init` at `src/commands/run-v1.handler.ts:720-741`), refusal messaging for live holders, and printing the holder overridden by `--force`. `releaseLock` already treats corrupt-at-canonical-path + dead-PID as releasable and live foreign PID as `not_owner` (`src/lock.ts:192-227`).

**`5x unlock` is a top-level command; `5x lock list` is nested.** Matches 203 §2.1 literally. One adapter (`src/commands/lock.ts`) registers both on the parent program: a `lock` command with a `list` subcommand, plus a sibling `unlock <plan> [--force]`. Do not ship `5x lock unlock`.

**`PLAN_LOCKED` detail is additive.** Keep existing top-level `pid` / `started_at` so any consumer already reading them keeps working. Add nested `holder: { pid, startedAt }`, `stale: false`, and `remediation` naming the exact unlock command with the canonical plan path that was locked. Apply the same shape at all three throw sites (init, complete, reopen).

**PID-start-time verification is deferred.** EPERM-as-alive (`src/lock.ts:48-63`) and PID reuse remain known false-live cases; the escape hatch is `unlock --force` with holder details printed. Matches plan-input deferred list and 203 §2.1 lean.

**Step warning threshold is a module constant `STEP_WARNING_RATIO = 0.8`.** Not a config key. Warning is additive on successful records only — never suppresses the record, never changes exit code. `run state` always surfaces `steps_used` / `max_steps` / `steps_remaining`. `run record` adds `step_budget` + `warnings` only when `used/max >= 0.8`. Below-threshold records omit those fields.

**Text remediation is a one-line stderr addition in `bin.ts`.** Extract `detail.remediation` when `detail` is a plain object with a string `remediation` field. Do not pretty-print the whole detail blob. JSON mode path untouched. Coordinate with 205 later; this change is non-breaking.

**Doctor is a check registry, not a switch statement in the handler.** `src/doctor/types.ts` defines `DoctorCheck` / `DoctorFinding` / `DoctorReport`; `src/doctor/registry.ts` holds the built-in list; each check lives in `src/doctor/checks/<name>.ts`. Handler runs all checks, aggregates, optionally applies `fix` functions, formats, and sets exit code. Plugin registration is a future extension point (registry array), not implemented now.

**Doctor exit code: 0 unless any finding has status `fail`.** `warn` findings (live locks that need human judgment, lingering runs, user-scope freshness, orphan worktree dirs) do not fail CI. `--fix` that successfully clears all fixable fails can still leave warns → exit 0.

**Diagnostic commands emit a success envelope; process exit code reflects check health.** stdout is always `{ ok: true, data: DoctorReport }` where `data.ok` is `true` iff no `fail` remains. `process.exitCode = doctorExitCode(report)` (0 or 1). Closest analogue is `harness sync --check`. Do not throw `CliError` for failed checks — that would put the report on the error envelope and break the human formatter contract.

**Harness-freshness in doctor always runs Tier 2** via `runHarnessFreshnessChecks({ startDir, homeDir, tier2: true })` (`src/harnesses/freshness.ts:42-53, 67-139`). Status mapping:

- `fresh` / `not-installed` → `ok` (one summary finding per check when every scope is clean, so empty output stays distinguishable from a crashed check).
- project-scope `stale` / `unknown` → `fail`, remediation `5x harness sync` (or `5x harness sync --force` when `losslessBlockers` includes `assets-modified`).
- user-scope `stale` / `unknown` → `warn` (201 D4: never auto-refreshed; remediation names project-scope install).

Honor `harness.freshnessWarnings = "off"` only for incidental hot-path warnings (`emitFreshnessWarnings` at `src/harnesses/freshness.ts:202-216`). Doctor is explicit and still reports.

**Doctor harness `--fix` gates on the 201 lossless-refresh predicate, not on scope alone.** `harnessSyncCore` only blocks modified assets; it force-installs even when `installedFrom.contextDir` differs (`src/commands/harness.handler.ts:742-844`). Doctor must therefore refuse auto-sync unless `report.losslessRefresh === true` (201 D6 / §2.6: matching install context **and** unchanged recorded asset hashes — plus the other blockers already encoded on the report: `shared-user-scope`, `no-manifest`, `config-unresolved`, `baseline-unverified`). When any `losslessBlockers` entry is present, keep the finding as `fail`/`warn` with remediation and perform **no write**. Never invent a second writer. Never pass `force: true` to `harnessSyncCore` from doctor. Record `fixed` only after a successful sync **and** a re-detect that no longer reports that stale/unknown finding.

**Lingering-run age threshold is a named constant `LINGERING_RUN_AGE_MS = 24 * 60 * 60 * 1000`.** Heuristic: active run whose `updated_at` is older than 24h. Report-only — never auto-complete/abort. If the plan lock is live for that plan, do not flag the run as lingering. Inject `now` for tests.

**Do not use `listRuns`' default 50-row cap.** `listRuns` defaults `limit` to 50 and orders by `created_at DESC` (`src/db/operations-v1.ts:360-398`). Lingering runs are the *oldest* actives and would be the first dropped. The runs check must query active runs without that cap — either pass an explicit large `limit` (document it) or run a dedicated `SELECT` of `status = 'active'` with no `LIMIT`. Prefer a dedicated query in the check (or a `listRuns` call with `limit: Number.MAX_SAFE_INTEGER`) and cover “51st oldest active is still flagged” in a unit test.

**DB check never migrates, creates, or opens through a mutating context.** Do **not** call `resolveDbContext()` (migrates by default, `src/commands/context.ts:82-149`) or `getDb()` (creates parent/file and sets WAL, `src/db/connection.ts:16-67`). Resolve the same control-plane DB relative path the rest of the CLI uses (`join(stateDir, DB_FILENAME)` / normalized `config.db.path`), then: if the file is absent → `DB_MISSING`; if present → `openDbReadOnly(projectRoot, dbRelPath)` (`src/db/connection.ts:64-67`). Open/query/`PRAGMA integrity_check`/schema-version failures become `fail` findings; never throw out of the check. Compare `getSchemaVersion(db)` (`src/db/schema.ts:416-426`) to a new exported `getMaxKnownSchemaVersion()` (max of the private `migrations` array; `_migrations` is test-only today at `:465`). `--fix` is a no-op for this check.

**Corrupt lock cleanup is path-addressed and lock-dir-confined.** A corrupt entry has no usable `plan_path`. `findExistingLock` (`src/lock.ts:65-88`) returns a corrupt file only when it sits at the *canonical* hash path; the directory walk `continue`s on `!info`, so non-canonical unparsable leftovers are invisible to `unlock <plan>` / `releaseLock`. Export `removeCorruptLock(projectRoot, lockPath, opts?)` that (1) resolves `lockDir`, (2) verifies `lockPath` is a direct child of that directory (realpath / prefix confinement — reject `..` escapes), (3) re-reads and confirms the file is still corrupt/unparsable, (4) unlinks that exact path. Doctor `--fix` uses this with `LockEntry.lockPath`. CLI `unlock <plan>` stays plan-keyed (canonical corrupt + stale via `releaseLock`); `lock list` remediation for `liveness: "corrupt"` names `5x doctor --fix`.

**Doctor check failures are findings, not process crashes.** The handler wraps each `check.run` in try/catch. Any thrown error becomes a single `fail` finding with stable code `CHECK_FAILED` (detail includes `check` id + message) so a corrupt DB, inaccessible worktree root, or freshness plugin load failure cannot abort the remaining sweep.

**`--fix` has an explicit detect → repair → re-detect contract.** `DoctorCheck.run` is detect-only and must not mutate. Optional `DoctorCheck.fix?(finding, ctx)` performs one deterministic repair and returns whether it attempted a write. **Invariant:** every `fix` re-validates its target before mutating (`removeCorruptLock` re-reads; `releaseLock` handles `not_locked`; harness sync is scoped to one harness+scope; worktree upsert is keyed by `planPath`) — the handler iterates the original `detected` array even after `current = again`, so a later candidate may already be gone. Handler algorithm (Phase 4.2): detect all checks → for each `fixable` finding when `--fix`, call `fix` → on claimed success, re-run that check's detect → if the matching finding is gone (`findingKey(f)` equal and no longer `fail`), append to `report.fixed`; if still present, keep the fail and do **not** claim `fixed`. Matching on `code` alone under-reports `fixed` when two findings share a code (two stale locks). Compute `report.ok` / exit code only from the final findings list.

**Worktree `--fix` clears dead mappings only — and must not call `worktreeDetach`.** `worktreeDetach` (`src/commands/worktree.handler.ts:442-470`) calls `resolveDbContext()`, which migrates and can create the DB. Doctor detect opens `openDbReadOnly`. Doctor `--fix` opens a **writable** connection to the *existing* file only (`new Database(absolutePath)` after `existsSync` — not `getDb()`, which mkdir/creates) and calls `upsertPlan(db, { planPath, worktreePath: "", branch: "" })` (`src/db/operations.ts:52-89`). Never delete directories. Never run `git worktree remove`. Orphan directories on disk with no DB row are `warn` and never deleted. If the schema is too old to query/update, leave the finding and remediate `5x upgrade`.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ CLI adapters                                                      │
│  src/commands/lock.ts      → lock list / unlock [--force]         │
│  src/commands/doctor.ts    → doctor [--fix]                      │
│  src/bin.ts                → register + text remediation line     │
└───────────────┬───────────────────────────┬──────────────────────┘
                │                           │
┌───────────────▼──────────┐   ┌────────────▼──────────────────────┐
│ src/commands/lock.handler│   │ src/commands/doctor.handler.ts    │
│  resolve plan / stateDir │   │  run registry, apply fixes, exit  │
└───────────────┬──────────┘   └────────────┬──────────────────────┘
                │                           │
┌───────────────▼──────────┐   ┌────────────▼──────────────────────┐
│ src/lock.ts              │   │ src/doctor/                       │
│  listLocks() (new)       │   │  types.ts / registry.ts           │
│  inspectLock() (new)     │   │  checks/harness-freshness.ts      │
│  removeCorruptLock()     │   │  checks/locks.ts                  │
│  releaseLock()           │   │  checks/worktrees.ts              │
│  forceReleaseLock()      │   │  checks/runs.ts                   │
│  isLocked()              │   │  checks/db.ts                     │
└──────────────────────────┘   └────────────┬──────────────────────┘
                                            │ reuses
                               ┌────────────▼──────────────────────┐
                               │ runHarnessFreshnessChecks (201)    │
                               │ harnessSyncCore (201) + lossless   │
                               │ upsertPlan (detach-equivalent)     │
                               │ openDbReadOnly / getSchemaVersion  │
                               │ active-run query (no 50-row cap)   │
                               └───────────────────────────────────┘

Error / step surfaces (additive):
  bin.ts text catch ──► Error: msg + optional "  → remediation"
  run-v1.handler    ──► PLAN_LOCKED detail, step_budget, MAX_STEPS remediation
  output.ts         ──► remediationFromDetail / formatTextError
```

Doctor finding / fix state:

```
  for each check:
    try detect ──► findings[]  { status, code, message, remediation?, fixable, detail? }
    catch     ──► fail finding code=CHECK_FAILED (sweep continues)
       │
       ├─ --fix + fixable + check.fix? ──► attempt repair
       │         └─ re-detect that check
       │              ├─ findingKey cleared ──► append report.fixed; keep post-detect findings
       │              └─ same identity still fail ──► keep fail; do not claim fixed
       └─ aggregate: report.ok / exit 0 iff no fail remains in final findings
```

---

## Phase 1: Lock inventory + CLI unlock surface

**Completion gate:** `5x lock list` and `5x unlock` work in JSON and text modes; live locks require `--force`; `removeCorruptLock` confines and removes corrupt files by path; unit tests cover list/classify/unlock/corrupt-removal; `PLAN_LOCKED` detail includes holder + remediation at all three sites.

### 1.1 `src/lock.ts` — export inventory API

**File:** `src/lock.ts`, after `isLocked` (lines 261–287)

Add types and `listLocks`:

```typescript
export type LockLiveness = "live" | "stale" | "corrupt";

export interface LockEntry {
  /** Absolute path to the `.lock` file. */
  lockPath: string;
  /** Present when the file parsed; omitted/null when corrupt. */
  info: LockInfo | null;
  liveness: LockLiveness;
}

/** List every lock file under the project's lock directory. Never mutates. */
export function listLocks(
  projectRoot: string,
  opts?: LockDirOpts,
): LockEntry[];
```

Implementation notes:

- Scan `lockDir(projectRoot, opts)` for `*.lock` (same directory walk as `findExistingLock` at lines 75–86, but **do not skip** unparsable files).
- Parse via existing private `readLockFile` (lines 91–106); `null` → `liveness: "corrupt"`, `info: null`.
- Parsed + `isPidAlive(pid)` → `"live"`; else `"stale"`.
- Empty / missing lock dir → `[]`. Never creates the directory.

Also export a plan-keyed inspector so unlock does not reimplement hashing:

```typescript
export function inspectLock(
  projectRoot: string,
  planPath: string,
  opts?: LockDirOpts,
): LockEntry | null;
```

`inspectLock` wraps `findExistingLock`. Returns `null` when no file is associated with the plan. Canonical-path corrupt → `{ lockPath, info: null, liveness: "corrupt" }`. Non-canonical corrupt leftovers are **not** visible here (by design — they have no `plan_path`); `listLocks` / doctor own them.

Add a path-addressed corrupt cleanup helper:

```typescript
export type RemoveCorruptLockResult =
  | { removed: true }
  | {
      removed: false;
      reason:
        | "not_found"
        | "not_in_lock_dir"
        | "not_corrupt"
        | "unlink_failed";
    };

/**
 * Remove one corrupt lock file by exact path.
 * Confined to lockDir(projectRoot, opts); re-validates corrupt before unlink.
 * Never resolves by plan_path — corrupt entries may have none.
 */
export function removeCorruptLock(
  projectRoot: string,
  lockPath: string,
  opts?: LockDirOpts,
): RemoveCorruptLockResult;
```

Implementation notes for `removeCorruptLock`:

- Resolve `lockDir(projectRoot, opts)` and the absolute `lockPath`. Reject unless `lockPath` is a **direct child** of that directory after `resolve()` (normalize + prefix/`..` check — no path escape, no nested subdirs).
- If missing → `{ removed: false, reason: "not_found" }`.
- Re-read with `readLockFile`; if it now parses as valid `LockInfo` → `{ removed: false, reason: "not_corrupt" }` (do not delete live/stale-by-path this way — those go through `releaseLock` / `forceReleaseLock`).
- Else `unlinkSync` that exact path; map unlink errors to `unlink_failed`.

- [ ] Add `LockLiveness`, `LockEntry`, `listLocks`, `inspectLock`, `removeCorruptLock`
- [ ] Re-export new symbols from `src/index.ts` (lines 77–89)
- [ ] Unit tests in `test/unit/lock-list.test.ts` for live / stale / corrupt / empty dir / no mutation
- [ ] Unit tests for `removeCorruptLock`: rejects path outside lock dir; refuses parsable lock; removes confirmed corrupt; missing → `not_found`

### 1.2 Lock command adapter + handler

**New files:**

- `src/commands/lock.ts` — commander adapter
- `src/commands/lock.handler.ts` — business logic

Follow `registerWorktree` (`src/commands/worktree.ts:18-26`) / `registerHarness` (`src/commands/harness.ts:19-27`) patterns. Resolve control-plane root + `stateDir` the same way `runV1Init` does (`src/commands/run-v1.handler.ts:723-729`): `resolveControlPlaneRoot(startDir)` then `lockOpts = { stateDir }`. For plan-arg resolution, load root config via `loadConfig` / `resolveProjectContext` (no DB open required for list/unlock).

Register **two** commands on `parent`:

```typescript
export function registerLock(parent: Command) {
  const lock = parent
    .command("lock")
    .summary("Inspect plan locks")
    .description("List plan-level locks under the control-plane state directory.");

  lock
    .command("list")
    .summary("List all plan locks")
    .description("Show every .lock file with plan path, PID, started-at, and liveness (live / stale / corrupt).")
    .addHelpText("after", "\nExamples:\n  $ 5x lock list\n  $ 5x lock list --text")
    .action(async () => {
      await lockList();
    });

  parent
    .command("unlock")
    .summary("Release a plan lock")
    .description(
      "Release a stale or corrupt lock for a plan. Live holders are refused unless --force is passed.",
    )
    .argument("<plan>", "Path to the plan whose lock to release")
    .option("-f, --force", "Release even when the holder PID appears live")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  $ 5x unlock docs/development/foo.md\n" +
        "  $ 5x unlock docs/development/foo.md --force",
    )
    .action(async (plan, opts) => {
      await unlockPlan({ plan, force: opts.force });
    });
}
```

`lockList` envelope:

```typescript
{
  locks: Array<{
    plan_path: string | null; // null when corrupt / unreadable
    pid: number | null;
    started_at: string | null;
    liveness: LockLiveness;
    lock_path: string;
  }>;
}
```

Custom text formatter: one line per lock, e.g. `live  pid=1234  plan=docs/...  since=...`. For `corrupt` rows, print `lock_path=` and omit a fake plan path. Empty list prints `(none)` / `{ locks: [] }`.

`unlock` behavior (plan-keyed; non-canonical corrupt leftovers are doctor-only):

| Condition | Action | Exit |
|-----------|--------|------|
| No lock | Success `{ released: false, reason: "not_locked" }` | 0 |
| Corrupt at canonical path / stale | `releaseLock` | 0 |
| Live, no `--force` | `outputError("PLAN_LOCKED", …)` with holder + remediation naming `--force` | 4 |
| Live + `--force` | Read holder via `inspectLock`, `forceReleaseLock`, success includes `forced: true` + `previous_holder` | 0 |

Force-success envelope:

```typescript
{
  released: true;
  forced: true;
  previous_holder: { pid: number; startedAt: string; planPath: string };
}
```

`lock list` remediation strings (text footer or per-row guidance):

- `stale` → `5x unlock <plan>`
- `live` → `5x unlock <plan> --force`
- `corrupt` → `5x doctor --fix` (executable path that uses `removeCorruptLock` on `lock_path`; do **not** advertise `5x unlock <plan>` for corrupt rows with `plan_path: null`)

Both handlers accept `startDir?` for unit tests (same convention as `initScaffold` / `worktreeList`).

- [ ] Implement adapter + handler with `startDir?` for unit tests
- [ ] Register via `registerLock(program)` in `src/bin.ts` after `registerWorktree` (~line 96)
- [ ] Unit tests: safe unlock stale/canonical-corrupt; refuse live; force overrides and returns `previous_holder`; list classification; corrupt list row exposes `lock_path`

### 1.3 Enrich `PLAN_LOCKED` at all throw sites

**File:** `src/commands/run-v1.handler.ts`, lines 811–818, 1222–1226, 1294–1298

Shared helper (local to the handler file):

```typescript
function planLockedDetail(planPath: string, lock: LockInfo): Record<string, unknown> {
  return {
    pid: lock.pid,
    started_at: lock.startedAt,
    holder: { pid: lock.pid, startedAt: lock.startedAt },
    stale: false,
    remediation: `If this process is hung, run \`5x unlock ${planPath} --force\`.`,
  };
}
```

Use the canonical plan path string the operator can pass back to `unlock` (`planPath` at init, `run.plan_path` at complete/reopen). Init currently has `lockResult.existingLock`; complete/reopen have `lockStatus.info`. Guard the helper call — those fields are defined whenever `acquired === false` / live-locked.

- [ ] Replace detail objects at init / complete / reopen
- [ ] Unit or integration assertion that JSON error envelope includes `holder` + `remediation`

---

## Phase 2: Text-mode remediation

**Completion gate:** Any `CliError` whose `detail.remediation` is a string prints two stderr lines in `--text` mode; JSON stdout remains a single parseable envelope with no stderr remediation requirement.

### 2.1 Helper + `bin.ts` catch path

**Files:** `src/output.ts` (new helper near `CliError`, after line 105), `src/bin.ts:117-120` (CliError text branch only).

```typescript
/** Return detail.remediation when it is a non-empty string; else undefined. */
export function remediationFromDetail(detail: unknown): string | undefined {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const value = (detail as Record<string, unknown>).remediation;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function formatTextError(err: { message: string; detail?: unknown }): void {
  console.error(`Error: ${err.message}`);
  const remediation = remediationFromDetail(err.detail);
  if (remediation) console.error(`  → ${remediation}`);
}
```

Use `formatTextError` in the `CliError` text branch (`src/bin.ts:117-120`). Leave Commander / INTERNAL_ERROR branches on the single-line form — they have no `detail`. Nested `detail: { detail: { remediation } }` (the `outputError` wrapping used by some run-context call sites at `run-v1.handler.ts:954-956`) is **out of scope** for this helper; only a top-level string `remediation` on `CliError.detail` is printed. `PLAN_LOCKED` and `MAX_STEPS_EXCEEDED` pass remediation at the top level of `detail`, which is the contract this slice owns.

- [ ] Add helpers + unit tests in `test/unit/output.test.ts`
- [ ] Wire `bin.ts` CliError text path
- [ ] Integration: `5x run init` against a live lock with `--text` shows remediation line; `--json` stdout has no second envelope and stderr has no required remediation line

### 2.2 Doc note (contract)

**File:** `docs/v1/100-architecture.md` §4a (line 224)

Amend the text-mode error sentence to: single `Error: <message>` plus optional `  → <remediation>` when present. Mark as additive / non-breaking. Full normalization remains 205's job.

- [ ] Update §4a wording
- [ ] Mention in `docs/v2/203-recovery-and-doctor.md` status when Phase 6 lands (not required mid-phase)

---

## Phase 3: Step-budget visibility

**Completion gate:** `run state` always shows step budget fields; `run record` warns at ≥80% without failing; `MAX_STEPS_EXCEEDED` includes remediation naming config bump and split-work.

### 3.1 Constants + shared budget helper

**File:** `src/commands/run-v1.handler.ts` (near `getMaxStepsPerRun`, lines 201–221)

Export so unit tests can import without spawning the CLI:

```typescript
/** Fixed v2 warning band — not configurable (203 plan-input assumption). */
export const STEP_WARNING_RATIO = 0.8;

export interface StepBudget {
  used: number;
  max: number;
  remaining: number;
}

export function computeStepBudget(used: number, max: number): StepBudget {
  return { used, max, remaining: Math.max(0, max - used) };
}

export function stepBudgetWarning(budget: StepBudget): string | undefined {
  if (budget.max <= 0) return undefined;
  if (budget.used / budget.max < STEP_WARNING_RATIO) return undefined;
  return `Approaching maxStepsPerRun (${budget.used}/${budget.max}); raise maxStepsPerRun or split the work.`;
}
```

Default `maxStepsPerRun` is 250 (`getMaxStepsPerRun` line 220), so the warning band starts at 200 used steps.

### 3.2 `run state` — always surface budget

**File:** `src/commands/run-v1.handler.ts:924-989` (`runV1State`), `formatStateText` (`:540-652`)

After `computeRunSummary` / `getMaxStepsPerRun`:

```typescript
const maxSteps = getMaxStepsPerRun(config as unknown as Record<string, unknown>);
const budget = computeStepBudget(summary.total_steps, maxSteps);

outputSuccess(
  {
    run: { /* existing fields unchanged */ },
    steps: steps.map(formatStep),
    summary,
    steps_used: budget.used,
    max_steps: budget.max,
    steps_remaining: budget.remaining,
  },
  formatStateText,
);
```

Extend `formatStateText`'s parameter type with the three budget fields and print a `Steps: N / max (R remaining)` line after the Status/Created header (before the steps table). Today the summary line only shows `total_steps` (`:639`) with no ceiling.

- [ ] Additive fields on state envelope
- [ ] Text formatter update
- [ ] Unit test: state includes fields even at 0 steps

### 3.3 `run record` — warning band

**File:** `src/commands/run-v1.handler.ts` — `runV1Record` success path (lines 1162–1169)

After a successful `recordStepInternal`, recompute summary via `computeRunSummary` so idempotent re-records report the true count (the insert is a no-op on duplicate, so `used = previous + 1` would false-trigger). `runV1Record` currently does not hold a `db` reference after `recordStepInternal`; either:

- have `recordStepInternal` return `{ ...result, total_steps }` from a post-insert `computeRunSummary`, or
- re-resolve context in `runV1Record` only when computing the warning.

Prefer returning `total_steps` from `recordStepInternal` (additive on `RecordStepResult`, `src/commands/run-v1.handler.ts:169`) so the CLI wrapper does not re-open the DB.

```typescript
const budget = computeStepBudget(result.total_steps, maxSteps);
const warning = stepBudgetWarning(budget);
outputSuccess({
  ...result,
  ...(warning ? { step_budget: budget, warnings: [warning] } : {}),
});
```

`maxSteps` is already computed inside `recordStepInternal` (lines 1056–1058); return it too, or re-read via `getMaxStepsPerRun` in the wrapper. Text mode: print `warnings` to stderr (same pattern as `emitFreshnessWarnings` at `src/harnesses/freshness.ts:211`) and keep `warnings` / `step_budget` on the JSON data object. Do **not** put the warning on stdout in text mode — that would mix with the generic key-value body.

`recordStepInternal` is also used by `5x commit` (see comment at lines 996–999). Adding `total_steps` to the return value is additive and safe; do not emit CLI warnings from `recordStepInternal` itself.

- [ ] Warning only at ≥80%; success exit 0 unchanged
- [ ] Idempotent re-record does not false-trigger incorrectly
- [ ] Unit tests for threshold boundaries (199/250 silent; 200/250 warns; `max <= 0` silent)

### 3.4 `MAX_STEPS_EXCEEDED` remediation

**File:** `src/commands/run-v1.handler.ts:1061-1067`

```typescript
throw new RecordError(
  "MAX_STEPS_EXCEEDED",
  `Run has reached the maximum of ${maxSteps} steps`,
  {
    current_steps: summary.total_steps,
    max_steps: maxSteps,
    remediation:
      "Raise maxStepsPerRun via `5x config set maxStepsPerRun <n>`, or split the work into a new run.",
  },
);
```

`runV1Record` already forwards `err.detail` to `outputError` (lines 1171–1177), so Phase 2 will print the `→` line in text mode automatically.

- [ ] Detail includes remediation
- [ ] Integration: text mode shows `→ Raise maxStepsPerRun…`

---

## Phase 4: Doctor registry, formatting, and CLI skeleton

**Completion gate:** `5x doctor` runs an empty-or-noop registry, emits the standard envelope, custom text format, exit 0; `--fix` flag accepted; unit tests cover aggregation/exit-code rules, per-check exception isolation, `findingKey` identity matching (not `code` alone), and the detect→fix→re-detect/`fixed` contract with a stub check.

### 4.1 Types + registry

**New files under `src/doctor/`:**

```typescript
// src/doctor/types.ts
export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorFinding {
  check: string;          // e.g. "locks"
  status: DoctorStatus;
  code: string;           // stable machine code
  message: string;
  remediation?: string;   // command or guidance
  /** When true, doctor --fix may call `fix`. */
  fixable: boolean;
  detail?: unknown;
}

export interface DoctorCheckContext {
  startDir: string;
  projectRoot: string;
  stateDir?: string;
  homeDir?: string;
  /**
   * Absolute control-plane DB path. Always a resolved path string —
   * `resolveDoctorContext` fails the whole command if path math cannot run.
   * The file at this path may or may not exist — checks must existsSync.
   * Never an open mutating connection.
   */
  dbPath: string;
  dbRelPath: string;
  /** Injected clock for lingering-run tests. Defaults to Date.now. */
  now?: number;
}

export interface DoctorFixResult {
  /** True only when a write was attempted and the helper reported success. */
  attempted: boolean;
  message: string;
}

export interface DoctorCheck {
  id: string;
  /** Detection only — must not mutate. */
  run(ctx: DoctorCheckContext): Promise<DoctorFinding[]>;
  /**
   * Optional deterministic repair for one fixable finding.
   * Called only when `--fix` and `finding.fixable` and `finding.check === id`.
   *
   * Invariant: `fix` MUST re-validate its target before mutating. The handler
   * iterates the original `detected` array even after `current = again`, so a
   * later candidate may already have been removed (or become live). Specified
   * helpers already do this (`removeCorruptLock` re-reads; `releaseLock`
   * handles `not_locked`; harness sync is one harness+scope; worktree upsert
   * is keyed by `planPath`). Future checks must preserve that: never assume
   * the candidate is still in the same state as detect.
   */
  fix?(finding: DoctorFinding, ctx: DoctorCheckContext): Promise<DoctorFixResult>;
}

export interface DoctorReport {
  ok: boolean; // true iff no fail findings remain after optional fixes
  checks: DoctorFinding[];
  fixed: Array<{ check: string; code: string; message: string }>;
}
```

```typescript
// src/doctor/registry.ts
import type { DoctorCheck } from "./types.js";

/** Built-in checks — plugin contribution deferred. Phase 5/6 populate this. */
export const builtinDoctorChecks: DoctorCheck[] = [];
```

Aggregation helpers (same file or `src/doctor/summary.ts`):

```typescript
export function summarizeDoctor(
  findings: DoctorFinding[],
  fixed: DoctorReport["fixed"],
): DoctorReport {
  return {
    ok: findings.every((f) => f.status !== "fail"),
    checks: findings,
    fixed,
  };
}

export function doctorExitCode(report: DoctorReport): number {
  return report.ok ? 0 : 1;
}

/** Stable code when a check throws — must not abort the sweep. */
export const DOCTOR_CHECK_FAILED = "CHECK_FAILED";

export function checkFailedFinding(checkId: string, err: unknown): DoctorFinding {
  const message = err instanceof Error ? err.message : String(err);
  return {
    check: checkId,
    status: "fail",
    code: DOCTOR_CHECK_FAILED,
    message: `Doctor check "${checkId}" failed: ${message}`,
    fixable: false,
    detail: { error: message },
  };
}

/**
 * Identity of one finding for `--fix` re-detect matching.
 * NEVER match on `code` alone: two stale locks share `LOCK_STALE`.
 * Identifying detail (required on the finding when that code is emitted):
 *   LOCK_CORRUPT              → detail.lockPath
 *   LOCK_STALE / LOCK_LIVE    → detail.planPath
 *   HARNESS_STALE / UNKNOWN   → detail.harness + detail.scope
 *   WORKTREE_MAPPING_MISSING  → detail.planPath
 */
export function findingKey(f: DoctorFinding): string {
  const d =
    f.detail && typeof f.detail === "object" && !Array.isArray(f.detail)
      ? (f.detail as Record<string, unknown>)
      : {};
  const ident = (() => {
    switch (f.code) {
      case "LOCK_CORRUPT":
        return String(d.lockPath ?? "");
      case "LOCK_STALE":
      case "LOCK_LIVE":
        return String(d.planPath ?? "");
      case "HARNESS_STALE":
      case "HARNESS_UNKNOWN":
        return `${String(d.harness ?? "")}:${String(d.scope ?? "")}`;
      case "WORKTREE_MAPPING_MISSING":
        return String(d.planPath ?? "");
      default:
        return "";
    }
  })();
  return `${f.check}:${f.code}:${ident}`;
}
```

- [ ] Create `src/doctor/types.ts`, `registry.ts`, and summary helpers including `findingKey`
- [ ] Unit tests: warn-only → exit 0; any fail → exit 1; empty → ok
- [ ] Unit tests: throwing check → `CHECK_FAILED` finding; sibling checks still run
- [ ] Unit tests: `findingKey` distinguishes two `LOCK_STALE` findings by `detail.planPath` (same code, different identity)

### 4.2 Handler + commander adapter

**New files:** `src/commands/doctor.ts`, `src/commands/doctor.handler.ts`

`resolveDoctorContext` (handler-local):

- `startDir` = `resolve(params.startDir ?? ".")`
- `controlPlane = resolveControlPlaneRoot(startDir)` (`src/commands/control-plane.ts:220`)
- `projectRoot` / `stateDir` from that result
- DB path math only:
  - managed/isolated: `dbRelPath = join(stateDir, DB_FILENAME)` (`src/commands/context.ts:108-109`)
  - `none` mode: `resolveProjectContext({ startDir })` then `join(normalizeDbPath(config.db.path), DB_FILENAME)` (`src/commands/context.ts:134-135`) — this loads config, **does not** open SQLite
- `dbPath = resolve(projectRoot, dbRelPath)`
- **Must not** call `getDb`, `openDbReadOnly`, or `runMigrations` here
- If control-plane / DB path math cannot run (`resolveControlPlaneRoot` throws, config unreadable in a way that blocks `dbRelPath`, etc.), **fail the whole command** with a `CliError`. Do not return a context with a missing or null `dbPath`. Checks never see an unresolved path; they only `existsSync` the resolved absolute path. The file at `dbPath` may still be absent (`DB_MISSING`).

Handler algorithm (normative — this is how `fixed` and `report.ok` are produced). Import `findingKey`, `checkFailedFinding`, `summarizeDoctor`, `doctorExitCode`, and `builtinDoctorChecks` from `src/doctor/registry.ts`:

```typescript
export async function doctorRun(params: {
  fix?: boolean;
  startDir?: string;
  homeDir?: string;
  now?: number;
}): Promise<void> {
  const ctx = await resolveDoctorContext(params);
  const fixed: DoctorReport["fixed"] = [];
  const findings: DoctorFinding[] = [];

  for (const check of builtinDoctorChecks) {
    let detected: DoctorFinding[];
    try {
      detected = await check.run(ctx);
    } catch (err) {
      findings.push(checkFailedFinding(check.id, err));
      continue;
    }

    if (!params.fix || !check.fix) {
      findings.push(...detected);
      continue;
    }

    let current = detected;
    for (const candidate of detected.filter((f) => f.fixable)) {
      const result = await check.fix(candidate, ctx);
      if (!result.attempted) continue;
      let again: DoctorFinding[];
      try {
        again = await check.run(ctx);
      } catch (err) {
        findings.push(checkFailedFinding(check.id, err));
        current = [];
        break;
      }
      const stillThere = again.some(
        (f) => f.status === "fail" && findingKey(f) === findingKey(candidate),
      );
      if (!stillThere) {
        fixed.push({
          check: check.id,
          code: candidate.code,
          message: result.message,
        });
      }
      current = again;
    }
    findings.push(...current);
  }

  const report = summarizeDoctor(findings, fixed);
  outputSuccess(report, formatDoctorText);
  process.exitCode = doctorExitCode(report);
}
```

Matching for “finding cleared” uses `findingKey(f)` (check + code + identifying detail) plus `status === "fail"`. Matching on `code` alone under-reports `fixed` when two findings share a code (two stale locks both `LOCK_STALE`). ok/warn replacements after repair are fine. The candidate loop iterates the original `detected` array even after `current = again`; that is safe **only** because every `DoctorCheck.fix` re-validates its target before mutating. Do not throw when the envelope is a successful diagnostic report.

Text formatter (human-first, custom formatter passed to `outputSuccess`):

```
harness-freshness  fail  opencode (project) assets are stale
  → 5x harness sync
locks              warn  live lock on docs/foo.md (pid 1234)
  → 5x unlock docs/foo.md --force
db                 ok    schema v5, integrity ok
```

When `report.fixed.length > 0`, print a short `Fixed:` section after the findings (JSON already carries `fixed`). Column-align check id / status.

- [ ] Adapter with `--fix` and help examples (`5x doctor`, `5x doctor --fix`, `5x doctor --text`)
- [ ] Register `registerDoctor(program)` in `src/bin.ts`
- [ ] Custom text formatter + JSON envelope tests
- [ ] Unit tests: stub check with fixable finding — `--fix` populates `fixed` only after re-detect clears it by `findingKey`; failed re-detect does not claim `fixed`
- [ ] Unit tests: stub check emitting two same-code findings with distinct identity keys — `--fix` records both in `fixed` (`fixed.length === 2`)

---

## Phase 5: Doctor checks — freshness, locks, worktrees

**Completion gate:** Three checks registered; `--fix` removes stale locks and path-addressed corrupt locks, clears dead worktree mappings, and syncs only project-scope harness installs that satisfy `losslessRefresh`; live locks / orphan dirs / user-scope / context-mismatch / hand-edits are report-only (no write).

### 5.1 `harness-freshness` check

**File:** `src/doctor/checks/harness-freshness.ts`

- Call `runHarnessFreshnessChecks({ startDir: ctx.startDir, homeDir: ctx.homeDir, tier2: true })`.
- Map each report:
  - `not-installed` → skip (do not emit per-harness noise).
  - `fresh` → contribute to an ok summary.
  - project-scope `stale` / `unknown` → `fail`, `code` like `HARNESS_STALE` / `HARNESS_UNKNOWN`, remediation `5x harness sync` (or `5x harness sync --force` when `losslessBlockers` includes `assets-modified`).
  - user-scope `stale` / `unknown` → `warn`, `fixable: false`, remediation `5x harness install <harness> --scope project` (201 D4).
- If every installed-or-not report is `fresh` or `not-installed`, emit a single `ok` finding `code: "HARNESS_FRESH"`.
- Put `losslessRefresh`, `losslessBlockers`, `harness`, `scope`, and `installedFrom` on `finding.detail` so `--fix` and tests can assert the predicate without re-querying. `harness` + `scope` are required — they are the `findingKey` identity for `HARNESS_STALE` / `HARNESS_UNKNOWN`.
- `fixable: true` **only** when `report.scope === "project"` **and** `report.losslessRefresh === true` **and** status is `stale` or `unknown`. Any blocker (`context-mismatch`, `assets-modified`, `baseline-unverified`, `no-manifest`, `config-unresolved`, `shared-user-scope`) ⇒ `fixable: false`.
- `fix`: call `harnessSyncCore({ name: finding.detail.harness, scope: "project", startDir: ctx.startDir, homeDir: ctx.homeDir })` **only** for findings marked fixable. Do **not** pass `force: true`. If the matching result `action` is not `synced` / `adopted`, return `{ attempted: false, … }` (or `{ attempted: true }` and rely on re-detect to withhold `fixed`). Skip user-scope always.
- Do **not** consult `freshnessWarningsEnabled`.
- Align with `docs/v2/201-harness-freshness.md` §2.6 / D6 — `harnessSyncCore` alone is insufficient as a gate.

- [ ] Implement check + register (`run` + `fix`)
- [ ] Unit tests with temp install / stale manifest (reuse helpers from `test/unit/harnesses/freshness.test.ts`)
- [ ] `--fix` syncs only when `losslessRefresh`; leaves user-scope, context-mismatch, and hand-edited assets as report-only without write
- [ ] Unit test: project install baked from a different `contextDir` → fail finding, `fixable: false`, no `harnessSyncCore` write
- [ ] Unit test: `freshnessWarnings=off` still produces findings

### 5.2 `locks` check

**File:** `src/doctor/checks/locks.ts`

- `listLocks(ctx.projectRoot, { stateDir: ctx.stateDir })`.
- `stale` → `fail`, `code: "LOCK_STALE"`, `fixable: true`, remediation `5x unlock <plan>` (plan path from `info.planPath`), `detail.planPath = info.planPath` (required — `findingKey` identity).
- `corrupt` → `fail`, `code: "LOCK_CORRUPT"`, `fixable: true`, remediation `5x doctor --fix`, `detail.lockPath = entry.lockPath` (required — no plan path; `findingKey` identity).
- `live` → `warn`, `code: "LOCK_LIVE"`, `fixable: false`, remediation `5x unlock <plan> --force`, `detail.planPath = info.planPath` (required — identity even though not fixable).
- No locks → single `ok` finding `code: "LOCKS_OK"`.
- `fix`:
  - `LOCK_STALE` → `releaseLock(projectRoot, finding.detail.planPath, { stateDir })` (never `forceReleaseLock`).
  - `LOCK_CORRUPT` → `removeCorruptLock(projectRoot, finding.detail.lockPath, { stateDir })`.
  - never remove live locks.

- [ ] Implement + tests for each liveness class
- [ ] Filesystem-focused unit tests ensuring live lock files survive `--fix`
- [ ] Unit test: non-canonical corrupt file removed via `removeCorruptLock` on `lockPath`; plan-keyed `unlock` is not required for that case
- [ ] Unit test: two stale locks, `--fix` → both removed, `report.fixed.length === 2` (identity matching, not `code` alone)

### 5.3 `worktrees` check

**File:** `src/doctor/checks/worktrees.ts`

- Detect path: if `!existsSync(ctx.dbPath)` → return `[]` (the `db` check owns `DB_MISSING`). If present, open with `openDbReadOnly(ctx.projectRoot, ctx.dbRelPath)` (`src/db/connection.ts:64-67`); close in `finally`. Open/query failures → `fail` `code: "DB_UNREADABLE"`, `fixable: false` — do not throw.
- Query plans with non-empty `worktree_path` (same SQL as `worktreeList`, `src/commands/worktree.handler.ts:484-492`).
- Missing/unreadable dir (`!existsSync` or not accessible) → `fail`, `code: "WORKTREE_MAPPING_MISSING"`, `fixable: true`, remediation `5x worktree detach -p <plan>`, `detail.planPath = planPath` (required — `findingKey` identity).
- `fix`: after `existsSync(ctx.dbPath)`, open **writable** `new Database(ctx.dbPath)` (not `getDb` — that mkdir/creates; not `resolveDbContext` — that migrates). Call `upsertPlan(db, { planPath, worktreePath: "", branch: "" })`. Close in `finally`. If the write throws (old schema, locked, etc.), return `{ attempted: false }` and leave the finding; remediation already names `5x worktree detach` / `5x upgrade`.
- Orphan git worktrees: `listWorktrees(ctx.projectRoot)` (`src/git.ts:358`) plus directories under `<projectRoot>/.5x/worktrees/` that have no matching `plans.worktree_path` row → `warn`, `code: "WORKTREE_ORPHAN"`, `fixable: false`. Never delete.

- [ ] Implement + tests (dead mapping cleared; orphan dir preserved)
- [ ] Ensure detach-equivalent does not call `git worktree remove` and does not call `worktreeDetach`
- [ ] Detect path does not create/migrate the DB
- [ ] Missing DB returns `[]` (no `DB_MISSING` from this check)

---

## Phase 6: Doctor checks — runs, db; docs and end-to-end validation

**Completion gate:** All five checks ship; docs reflect implemented subset + deferred prompt check; integration suite covers CLI text/JSON/exit codes/lock behavior; `203-recovery-and-doctor.md` status updated.

### 6.1 `runs` check (report-only)

**File:** `src/doctor/checks/runs.ts`

```typescript
export const LINGERING_RUN_AGE_MS = 24 * 60 * 60 * 1000;
```

- If `!existsSync(ctx.dbPath)` → return `[]` (the `db` check owns `DB_MISSING`; do not create a file).
- Else `openDbReadOnly(ctx.projectRoot, ctx.dbRelPath)`; never migrate. Open/query failures → `fail` `DB_UNREADABLE` (do not throw). Close in `finally`.
- Query **all** `status = 'active'` runs. Do **not** call `listRuns(db, { status: "active" })` without overriding `limit` — default 50 + `ORDER BY created_at DESC` (`src/db/operations-v1.ts:387-397`) would hide the oldest lingering runs. Dedicated SQL (no `LIMIT`) or `listRuns(..., { status: "active", limit: Number.MAX_SAFE_INTEGER })`.
- Flag when `(ctx.now ?? Date.now()) - Date.parse(updated_at) >= LINGERING_RUN_AGE_MS` **and** `inspectLock(ctx.projectRoot, plan_path, { stateDir: ctx.stateDir })` is not `liveness: "live"`.
- Finding: `warn`, `code: "RUN_LINGERING"`, `fixable: false`, remediation `5x run complete --run <id> --status aborted` (primary suggestion for crashed sessions). Mention `run reopen` in the message as the judgment fork, not as a second command to run blindly.
- `--fix`: no-op (`fix` omitted).
- No lingering runs (and DB readable) → single `ok` finding `code: "RUNS_OK"`.

- [ ] Implement + unit tests with injected `ctx.now`
- [ ] Active run with live lock → not flagged
- [ ] Fresh active run (updated_at within 24h) → not flagged
- [ ] Oldest of 51 active runs still flagged (cap regression)
- [ ] Missing DB does not create a file

### 6.2 `db` check (report-only, non-mutating)

**File:** `src/doctor/checks/db.ts`

**Inspection path (normative):**

1. Use `ctx.dbPath` / `ctx.dbRelPath` from Phase 4.2 — path math only.
2. If `!existsSync(ctx.dbPath)` → single finding: `status: "fail"`, `code: "DB_MISSING"`, `fixable: false`, remediation: initialize/restore guidance (`5x init` when no control plane, or restore backup — message must not imply doctor will create the DB).
3. Else open with `openDbReadOnly(ctx.projectRoot, ctx.dbRelPath)` — **readonly, no pragma/WAL setup, no mkdir, no migrate**. Do **not** call `getDb` or `resolveDbContext`.
4. On open failure (corrupt header, permissions, etc.) → `fail` `DB_UNREADABLE`, remediation restore/delete (never auto-delete), `fixable: false`.
5. `getSchemaVersion(db)` (`src/db/schema.ts:416`) vs `getMaxKnownSchemaVersion()` (new export: `migrations[migrations.length - 1]?.version ?? 0`, currently 5 at lines 401–409):
   - behind → `fail` `code: "DB_SCHEMA_BEHIND"`, remediation `5x upgrade`
   - ahead → `fail` `code: "DB_SCHEMA_AHEAD"`, remediation to upgrade CLI (same message family as `runMigrations` at `src/db/schema.ts:436-440`)
6. `PRAGMA integrity_check` first row not `ok` → `fail` `DB_INTEGRITY`, remediation restore/delete (never auto-delete).
7. Healthy → single `ok` finding `code: "DB_OK"` with version number in the message.
8. Always close the read-only connection in `finally`.
9. `--fix`: no-op.

Export from `src/db/schema.ts`:

```typescript
export function getMaxKnownSchemaVersion(): number {
  return migrations[migrations.length - 1]?.version ?? 0;
}
```

This preserves the “never migrates” guarantee and lets doctor report an old schema instead of silently upgrading it during inspection.

- [ ] Export `getMaxKnownSchemaVersion()`
- [ ] Implement check + unit tests: missing file → `DB_MISSING` and no file created; outdated schema reported without migration; corrupt/unreadable → finding; healthy → ok; schema ahead → `DB_SCHEMA_AHEAD`
- [ ] Assert `resolveDbContext` / `getDb` are not imported from the detect path (review grep gate)

### 6.3 Wire registry + integration suite

Populate `builtinDoctorChecks` in this order (203 §2.4 minus prompts):

```typescript
export const builtinDoctorChecks: DoctorCheck[] = [
  harnessFreshnessCheck,
  locksCheck,
  worktreesCheck,
  runsCheck,
  dbCheck,
];
```

- [ ] Registry order as above
- [ ] Integration: `test/integration/commands/doctor.test.ts` — exit codes, JSON shape, `--fix` lock cleanup (including corrupt-by-path), text formatter, check-failure isolation. Spawn `src/bin.ts` via `Bun.spawnSync` with `env: cleanGitEnv()`, `stdin: "ignore"`, and per-test `timeout: 15000` (`5x-cli/AGENTS.md`).
- [ ] Integration: `test/integration/commands/lock-cli.test.ts` — list/unlock/force via CLI spawn + `cleanGitEnv()`
- [ ] Integration: step-budget + text remediation smoke tests (`test/integration/commands/run-step-budget.test.ts` or extend `test/integration/commands/run-v1.test.ts`)
- [ ] Integration/unit: doctor `--fix` does not sync context-mismatched project harness; does not create DB when absent

### 6.4 Documentation

- [ ] Update `docs/v2/203-recovery-and-doctor.md` status from `Draft — Not Implemented` to Implemented (or Partial) with pointer to this plan; note prompts check deferred to `03-prompt-queue-foundation`
- [ ] Amend 203 §2.1: replace “via existing `isLocked` / `readLockFile`” with the implemented `listLocks` scan. `isLocked` returns `{ locked: false }` for corrupt files (`src/lock.ts:277-280`) and `readLockFile` is private, so listing cannot reuse those APIs.
- [ ] Record resolved 203 TODOs in the status/design doc so it stops carrying decided questions:
  - warn-only doctor results → exit 0 (no distinct warn code)
  - `doctor` and `lock list` both ship
  - lingering-run age = 24h (`LINGERING_RUN_AGE_MS`)
  - PID-reuse: `--force` + visible holder (no start-time check)
  - step-warning threshold fixed at 80% (`STEP_WARNING_RATIO`)
  - plugin-contributed checks deferred
- [ ] Update `docs/v2/200-overview.md` area #3 row if it tracks implementation status (currently the table is design-only — only add a status note if a status column already exists; do not invent one)
- [ ] Update plan-input metadata `Generated plan` → `docs/development/plans/203-recovery-and-doctor-plan.md`
- [ ] Command help text in adapters is the primary CLI reference; `--help` examples cover `lock list` / `unlock` / `doctor`
- [ ] `5x-cli/AGENTS.md`: add a short note under a recovery heading that `5x doctor` is the recovery front door (keep to a few sentences; do not create a large new doc)

### 6.5 End-to-end validation checklist

- [ ] Live lock → `PLAN_LOCKED` JSON has holder + remediation; text shows `→ …unlock…--force`
- [ ] `unlock` without `--force` refuses; with `--force` prints previous holder
- [ ] Corrupt non-canonical lock → `lock list` shows it; `doctor --fix` removes via `lockPath`; plan-keyed unlock not required
- [ ] `run record` at 80% warns; at max fails with remediation; `run state` always shows budget
- [ ] `doctor` detects all five classes; `--fix` only mutates stale locks + path-addressed corrupt locks + dead mappings + lossless project harness sync
- [ ] Context-mismatched project harness is reported and not auto-synced
- [ ] Absent DB → `DB_MISSING`; doctor does not create/migrate the file
- [ ] Throwing check → `CHECK_FAILED`; other checks still run; `fixed` only after successful re-detect by `findingKey` (two stale locks both appear in `fixed`)
- [ ] `harness.freshnessWarnings=off` does not hide doctor freshness findings
- [ ] `bun test` unit + integration green

---

## Files Touched

| File | Change |
|------|--------|
| `src/lock.ts` | Add `listLocks`, `inspectLock`, `removeCorruptLock`, `LockEntry` / `LockLiveness` |
| `src/index.ts` | Re-export new lock symbols |
| `src/commands/lock.ts` | **New** — `lock list` + top-level `unlock` adapter |
| `src/commands/lock.handler.ts` | **New** — list/unlock handlers |
| `src/commands/doctor.ts` | **New** — `doctor [--fix]` adapter |
| `src/commands/doctor.handler.ts` | **New** — detect→fix→re-detect loop keyed by `findingKey`, `CHECK_FAILED` isolation, exit code |
| `src/doctor/types.ts` | **New** — check/finding/report/`fix?` types |
| `src/doctor/registry.ts` | **New** — builtin check list + summarize/exit/`checkFailedFinding`/`findingKey` helpers |
| `src/doctor/checks/harness-freshness.ts` | **New** — Tier-2 freshness + lossless-gated sync fix |
| `src/doctor/checks/locks.ts` | **New** — stale/corrupt/live findings; corrupt fix via `removeCorruptLock` |
| `src/doctor/checks/worktrees.ts` | **New** — dead mappings + orphan warns (read-only detect) |
| `src/doctor/checks/runs.ts` | **New** — lingering active runs (report-only, read-only DB, no 50-row cap) |
| `src/doctor/checks/db.ts` | **New** — missing/unreadable/schema/integrity via `openDbReadOnly` |
| `src/bin.ts` | Register lock + doctor; text remediation line |
| `src/output.ts` | `remediationFromDetail` / `formatTextError` |
| `src/commands/run-v1.handler.ts` | PLAN_LOCKED detail; step budget helpers; MAX_STEPS remediation; state fields; record warning |
| `src/db/schema.ts` | Export `getMaxKnownSchemaVersion()` |
| `docs/v1/100-architecture.md` | §4a additive remediation line |
| `docs/v2/203-recovery-and-doctor.md` | Status + deferred prompts; §2.1 `listLocks` (not `isLocked`/`readLockFile`); record resolved TODOs |
| `docs/v2/plan-inputs/01-recovery-and-doctor.plan-input.md` | Generated plan pointer |
| `5x-cli/AGENTS.md` | Short recovery note pointing at `5x doctor` |
| `test/unit/output.test.ts` | Remediation helper coverage |
| `test/unit/lock-list.test.ts` | **New** — inventory / classify / `removeCorruptLock` |
| `test/unit/commands/lock.test.ts` | **New** — handler-level unlock/list |
| `test/unit/doctor/*.test.ts` | **New** — registry, `findingKey`, fix contract (incl. two stale locks → `fixed.length === 2`), each check (incl. lossless + DB_MISSING + listRuns cap) |
| `test/unit/commands/run-step-budget.test.ts` | **New** — threshold + state fields |
| `test/integration/commands/lock-cli.test.ts` | **New** — CLI spawn coverage |
| `test/integration/commands/doctor.test.ts` | **New** — CLI doctor coverage |
| `test/integration/commands/run-step-budget.test.ts` | **New** — record/state/text remediation |

`src/db/connection.ts` is reused (`openDbReadOnly`) but not modified unless a thin doctor wrapper proves necessary during implementation — prefer calling it directly from checks.

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `lock.ts` list/inspect | live / stale / corrupt / empty; no mutation |
| Unit | `lock.ts` `removeCorruptLock` | confined path; refuses parsable; removes corrupt; rejects escape |
| Unit | `lock.handler` | safe unlock; refuse live; force releases + returns holder |
| Unit | `output.ts` | remediation extracted; absent/non-string/array ignored |
| Unit | step-budget helpers | 79% silent, 80% warns, remaining math, `max <= 0` |
| Unit | `run-v1.handler` PLAN_LOCKED detail | holder + remediation shape at helper level |
| Unit | doctor summary / handler | warn-only exit 0; fail exit 1; `CHECK_FAILED` isolation; `findingKey` identity; fix→re-detect `fixed` rules; two same-code findings → `fixed.length === 2` |
| Unit | doctor checks | each check's detect + fix matrix with temp dirs/DB; two stale locks → `fixed.length === 2` |
| Unit | doctor freshness | `losslessRefresh` gate; context-mismatch not fixable; no sync write; `freshnessWarnings=off` still reports |
| Unit | doctor db | `DB_MISSING` / unreadable / behind / ahead schema; no create/migrate |
| Unit | doctor runs | live lock suppresses warn; 51st oldest active still flagged |
| Integration | `lock list` / `unlock` CLI | stdout JSON, text lines, exit 4 on live without force; corrupt shows `lock_path` |
| Integration | `run init` PLAN_LOCKED | text remediation line; JSON envelope single object on stdout |
| Integration | `run record` / `run state` | step_budget warnings; state fields always present |
| Integration | `doctor` / `doctor --fix` | five check classes; fix mutates only safe targets; exit codes |
| Edge | doctor freshness | user-scope / context-mismatch not auto-fixed |
| Edge | lingering runs | fresh active run not flagged |
| Edge | corrupt locks | doctor removes by `lockPath`; unlock-by-plan not required for non-canonical corrupt |

---

## Not In Scope

- **Prompt-hygiene doctor check** — needs prompt persistence from control-plane / prompt-queue slice (`03-prompt-queue-foundation.plan-input.md`).
- **Remote liveness via opaque invocation handles** — `05-invocation-registry`; keep PID checks behind `lock.ts`.
- **Breaking stdout/text normalization** — `09-output-normalization-release` / `205`. Nested `detail.detail.remediation` unwrapping is also deferred.
- **PID-start-time vs lock `startedAt` sanity check** — deferred; `--force` is the escape hatch.
- **Plugin-contributed doctor checks** — registry shape allows it later; v2 ships five builtins.
- **Configurable `stepWarningThreshold` / doctor warn exit codes / lingering-run age config** — fixed constants for v2.
- **Deleting orphan worktree directories from `doctor --fix`** — never; report only.
- **`5x lock unlock` alias** — 203 names `5x unlock` as the command.

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 1 | Lock inventory API, `lock list` / `unlock`, PLAN_LOCKED enrichment | 1–2 days |
| 2 | Text-mode remediation helpers + bin.ts + §4a doc | 0.5–1 day |
| 3 | Step-budget on record/state + MAX_STEPS remediation | 1 day |
| 4 | Doctor registry, formatting, CLI skeleton | 1 day |
| 5 | Doctor checks: freshness, locks, worktrees (+ `--fix`) | 1.5–2 days |
| 6 | Doctor checks: runs, db; docs; integration E2E | 1–2 days |
| **Total** | | **6–9 days** |

---

## Revision History

### 1.3 — August 18, 2026

Addresses P1.1 and P2.1–P2.3 in [`docs/development/reviews/.5x-worktrees-203-recovery-and-doctor-plan-f3f71b-5x-cli-docs-development-plans-203-recovery-and-doctor-plan-review.md`](../reviews/.5x-worktrees-203-recovery-and-doctor-plan-f3f71b-5x-cli-docs-development-plans-203-recovery-and-doctor-plan-review.md) (no addendums; all items `auto_fix`). Header version had regressed to 1.0 after the 1.2 reviewed revision; this bump is 1.3.

**P1.1 — `--fix` re-detect matching keyed on `code` alone under-reports `fixed`.** Matching two stale locks by `LOCK_STALE` withheld the first repair and left `fixed.length === 1` after both succeeded.

- Added `findingKey(f)` in `src/doctor/registry.ts` (check + code + identifying detail: `lockPath` for `LOCK_CORRUPT`, `planPath` for `LOCK_STALE`/`LOCK_LIVE`/`WORKTREE_MAPPING_MISSING`, `harness`+`scope` for freshness). Handler “cleared” matching uses `findingKey`, not `code` alone.
- Required those identifying fields on the corresponding findings (Phases 5.1–5.3).
- Stated the `DoctorCheck.fix` re-validation invariant: the candidate loop iterates the original `detected` array after `current = again`; specified helpers already re-read / handle `not_locked`.
- Added tests: stub two same-code findings → `fixed.length === 2`; two stale locks, `--fix` → both removed, `report.fixed.length === 2`.

**P2.1 — Version header.** Bumped 1.0 → 1.3; status → Ready for implementation.

**P2.2 — `DoctorCheckContext.dbPath` type/comment.** Deleted the “Null only if path math cannot run” sentence. `dbPath` stays `string`; `resolveDoctorContext` fails the whole command if path math cannot run. Checks only `existsSync` the resolved path.

**P2.3 — Phase 6.4 vs 203 §2.1.** Doc updates now amend the `isLocked`/`readLockFile` sketch to the `listLocks` scan and record resolved TODOs (warn → exit 0, doctor + `lock list` both ship, 24h lingering-run age, `--force` + visible holder, fixed 80% threshold, plugin checks deferred).

### 1.2 — August 18, 2026

Prior reviewed revision (`48f77e3`): read-only DB inspection, 201 lossless-refresh gate on harness `--fix`, path-confined `removeCorruptLock`, `CHECK_FAILED` isolation, and the detect → fix → re-detect contract.

---

## Provenance

Implements v2 area #3 (`docs/v2/203-recovery-and-doctor.md`) from plan input `docs/v2/plan-inputs/01-recovery-and-doctor.plan-input.md`. Depends on completed area #1 freshness APIs (`201-harness-freshness-plan.md`) for the doctor harness check and safe sync fix. Leaves prompt hygiene and remote invocation liveness to subsequent plan inputs as specified in the handoff section. Suggested next slice: `02-run-context-ergonomics.plan-input.md`.
