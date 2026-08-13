# Recovery & `5x doctor` — Lock Surface, Step Budget, Remediation, Doctor Registry

**Version:** 1.2
**Created:** August 13, 2026
**Last updated:** August 13, 2026
**Status:** Draft — revised for staff engineer review (v1.2)

---

## Executive Summary

Several failure modes end in a wall: the error is correct, but the operator has no self-service recovery path. Lock primitives already auto-steal stale/corrupt locks and expose `forceReleaseLock()`, yet nothing CLI-facing lists locks, unlocks them, or puts holder metadata on `PLAN_LOCKED`. Step ceilings fire as a surprise at `maxStepsPerRun` with no prior signal. Text-mode errors drop structured `remediation` that JSON mode already carries. Stale worktree mappings, lingering active runs, and DB health require raw filesystem/sqlite inspection.

This plan implements `docs/v2/203-recovery-and-doctor.md`: a lock inspect/unlock surface over existing primitives, additive step-budget visibility, non-breaking text-mode remediation, and a `5x doctor` check registry with safe `--fix` actions. It reuses the area-201 `runHarnessFreshnessChecks()` seam and leaves prompt hygiene / remote liveness / output-normalization breakages to later slices.

### Scope

**In scope:**

- `5x lock list`, safe `5x unlock <plan>`, and `5x unlock <plan> --force` with holder details.
- Enriched `PLAN_LOCKED` detail (`holder`, `stale`, `remediation`) at every throw site.
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
| **Warn-only doctor exits 0; any `fail` exits nonzero** | Usable in CI/preflight without treating warnings as breakage. |
| **`doctor` and `lock list` both ship** | Doctor is the full sweep; `lock list` answers the targeted question. |
| **`--fix` only when exactly one correct answer** | Stale/corrupt lock → remove; dead worktree mapping → clear; everything else is report + remediation command. |
| **Doctor always runs harness-freshness; `freshnessWarnings=off` stays hot-path only** | Explicit diagnostics must not be silenced by the incidental-warning switch; project-scope stale/unknown is `fail`, user-scope stale/unknown is `warn`. |
| **Doctor harness `--fix` requires 201 lossless-refresh** | Auto-sync only when `FreshnessReport.losslessRefresh === true` (matching `installedFrom.contextDir` **and** unmodified recorded asset hashes, plus the other 201 blockers). Context-mismatched / hand-edited project installs stay `fail` with remediation; no write. |
| **DB doctor opens read-only / no-create / no-migrate** | Never call `resolveDbContext()` or `getDb()` for inspection — those migrate and create. Resolve the same control-plane path, require the file to exist, open via `openDbReadOnly` (or equivalent), and map missing/unreadable/query failures to findings. |
| **Corrupt locks removed by confined `lockPath`, not plan path** | `findExistingLock` / `unlock <plan>` skip unparsable non-canonical files. Doctor uses a lock-dir-confined helper on `LockEntry.lockPath`; `lock list` remediation for corrupt entries names `5x doctor --fix`. |
| **Per-check failures become findings; fix then re-detect** | A thrown check must not abort the sweep. Handler catches, emits a stable `fail` code, continues. `--fix` records `fixed` only after a post-repair re-detect clears the finding. |

### References

- [`docs/v2/203-recovery-and-doctor.md`](../../v2/203-recovery-and-doctor.md) — canonical requirements.
- [`docs/v2/201-harness-freshness.md`](../../v2/201-harness-freshness.md) — freshness states and doctor Tier-2 contract.
- [`docs/development/plans/201-harness-freshness-plan.md`](./201-harness-freshness-plan.md) — implemented `runHarnessFreshnessChecks()` / `harnessSyncCore()` APIs.
- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — shared-core §3.3 doctor; §3a forward-compat.
- [`docs/v1/100-architecture.md`](../../v1/100-architecture.md) — §4a output/error contract being extended additively.
- Plan input: `docs/v2/plan-inputs/01-recovery-and-doctor.plan-input.md`.

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
14. [Provenance](#provenance)
15. [Revision History](#revision-history)

---

## Overview

Lock, step-budget, and repair primitives are stronger than the CLI surface. Operators hit `PLAN_LOCKED` / `MAX_STEPS_EXCEEDED` / `WORKTREE_MISSING` with incomplete guidance, and there is no `doctor` front door.

**Current behavior:**

- `acquireLock` auto-steals dead-PID and corrupt locks (`src/lock.ts:131-160`); `forceReleaseLock()` exists (`src/lock.ts:237-246`) but no command exposes it.
- `PLAN_LOCKED` at `run init` / `complete` / `reopen` carries flat `{ pid, started_at }` only (`src/commands/run-v1.handler.ts:811-818`, `:1222-1226`, `:1294-1298`) — no remediation command.
- Text-mode errors print a single `Error: <message>` line (`src/bin.ts:117-120`); structured `detail.remediation` (e.g. `src/commands/run-context.ts:125-126`, `:165-166`) is dropped.
- `run record` enforces `maxStepsPerRun` with no prior warning (`src/commands/run-v1.handler.ts:1054-1067`); `run state` summary has `total_steps` but no max / remaining (`:975-988`).
- No `doctor` / `lock` / `unlock` commands registered in `src/bin.ts:82-96`.
- Area 201 exported `runHarnessFreshnessChecks()` (`src/harnesses/freshness.ts:67`) and `harnessSyncCore()` for this slice to consume.

**New behavior:**

- `5x lock list` enumerates `.5x/locks/*.lock` with `live` / `stale` / `corrupt` verdicts.
- `5x unlock <plan>` releases stale/corrupt locks; refuses live holders with holder info; `--force` calls `forceReleaseLock` and prints the overridden holder.
- `PLAN_LOCKED.detail` always includes `holder`, `stale: false`, and a remediation naming `5x unlock <plan> --force` (existing `pid` / `started_at` fields retained for compatibility).
- Successful `run record` past 80% of `maxStepsPerRun` adds `step_budget` + `warnings`; `run state` always includes `steps_used` / `max_steps` (and remaining); `MAX_STEPS_EXCEEDED` names config bump and split-work outs.
- Text-mode errors append `→ <remediation>` on stderr when `detail.remediation` is a string; JSON stdout unchanged.
- `5x doctor [--fix]` runs five built-in checks with a standard envelope and human text formatter; `--fix` applies only safe repairs (lossless harness sync, stale/path-addressed corrupt locks, dead worktree mappings). Per-check failures become findings; DB inspection is read-only/non-creating.

**Prerequisites:**

- [`201-harness-freshness-plan.md`](./201-harness-freshness-plan.md) — complete; freshness API available.

---

## Design Decisions

**Lock listing is a new exported scan, not a loop over `isLocked`.** `isLocked` returns `{ locked: false }` for corrupt files (`src/lock.ts:277-280`), so a doctor/`lock list` built on it would miss the exact files operators need to clear. Export `listLocks(projectRoot, opts?)` that reads every `*.lock` under the lock dir, classifies each entry, and never mutates. Keep `isPidAlive` / `readLockFile` private; re-export `listLocks` from `src/index.ts` alongside existing lock exports.

**Safe unlock reuses `releaseLock`; force unlock reuses `forceReleaseLock`.** No new lock semantics. The CLI layer only adds: plan-path resolution (same `resolvePlanArg` / `canonicalizePlanPath` / control-plane `stateDir` pattern as `run init`), refusal messaging for live holders, and printing the holder overridden by `--force`. `releaseLock` already treats corrupt + dead-PID as releasable and live foreign PID as `not_owner` (`src/lock.ts:192-227`).

**`PLAN_LOCKED` detail is additive.** Keep existing top-level `pid` / `started_at` so any consumer already reading them keeps working. Add nested `holder: { pid, startedAt }`, `stale: false`, and `remediation` naming the exact unlock command with the plan path that was locked. Apply the same shape at all three throw sites (init, complete, reopen).

**PID-start-time verification is deferred.** EPERM-as-alive and PID reuse remain known false-live cases; the escape hatch is `unlock --force` with holder details printed. Matches plan-input deferred list and 203 §2.1 lean.

**Step warning threshold is a module constant `STEP_WARNING_RATIO = 0.8`.** Not a config key. Warning is additive on successful records only — never suppresses the record, never changes exit code. Below-threshold records omit `step_budget` / `warnings` (or include `step_budget` always? → **omit below threshold on `record`**; **always include on `state`** so agents can self-pace). Decision: `run state` always surfaces `steps_used` / `max_steps` / `steps_remaining`; `run record` adds `step_budget` + `warnings` only when `used/max >= 0.8`.

**Text remediation is a one-line stderr addition in `bin.ts`.** Extract `detail.remediation` when `detail` is a plain object with a string `remediation` field. Do not pretty-print the whole detail blob. JSON mode path untouched. Coordinate with 205 later; this change is non-breaking.

**Doctor is a check registry, not a switch statement in the handler.** `src/doctor/types.ts` defines `DoctorCheck` / `DoctorFinding` / `DoctorReport`; `src/doctor/registry.ts` holds the built-in list; each check lives in `src/doctor/checks/<name>.ts`. Handler runs all checks, aggregates, optionally applies `fix` functions, formats, and sets exit code. Plugin registration is a future extension point (registry array), not implemented now.

**Doctor exit code: 0 unless any finding has status `fail`.** `warn` findings (live locks that need human judgment, lingering runs, user-scope freshness that cannot auto-sync, orphan worktree dirs) do not fail CI. `--fix` that successfully clears all fixable fails can still leave warns → exit 0.

**Harness-freshness in doctor always runs Tier 2** via `runHarnessFreshnessChecks({ tier2: true })` (`src/harnesses/freshness.ts:67-139`). Status mapping: `fresh` / `not-installed` → `ok`; project-scope `stale` / `unknown` → `fail` with remediation `5x harness sync`; **user-scope** `stale` / `unknown` → `warn` (D4: never auto-refreshed; remediation names project-scope install). Honor `harness.freshnessWarnings = "off"` only for incidental hot-path warnings — doctor is explicit and still reports.

**Doctor harness `--fix` gates on the 201 lossless-refresh predicate, not on scope alone.** `harnessSyncCore` only blocks modified assets; it force-installs even when `installedFrom.contextDir` differs (`src/commands/harness.handler.ts:742-844`). Doctor must therefore refuse auto-sync unless `report.losslessRefresh === true` (201 D6 / §2.6: matching install context **and** unchanged recorded asset hashes — plus the other blockers already encoded on the report). When `losslessBlockers` includes `context-mismatch` or `assets-modified` (or any other blocker), keep the finding as `fail`/`warn` with remediation naming the manual command (`5x harness sync` / `5x harness sync --force` as appropriate) and perform **no write**. Never invent a second writer. Record `fixed` only after a successful sync **and** a re-detect that no longer reports that stale/unknown finding.

**Lingering-run age threshold is a named constant `LINGERING_RUN_AGE_MS = 24 * 60 * 60 * 1000`.** Heuristic: active run whose `updated_at` is older than 24h. Report-only — never auto-complete/abort. False positives are acceptable because the remediation is a suggested command, not a mutation. Session/PID presence is best-effort: if the plan lock is live for that plan, do not flag the run as lingering (someone is still working).

**DB check never migrates, creates, or opens through a mutating context.** Do **not** call `resolveDbContext()` (migrates by default, `src/commands/context.ts:82-149`) or `getDb()` (creates parent/file and sets WAL, `src/db/connection.ts:16-67`). Resolve the same control-plane DB relative path the rest of the CLI uses (`join(stateDir, DB_FILENAME)` / normalized `config.db.path`), then: if the file is absent → explicit finding (see Phase 6.2); if present → `openDbReadOnly(projectRoot, dbRelPath)` (or a thin doctor inspection helper wrapping it — no pragmas, no create, no migrate). Open/query/`PRAGMA integrity_check`/schema-version failures become `fail` findings with remediation; never throw out of the check. Compare `getSchemaVersion(db)` to `getMaxKnownSchemaVersion()` from `src/db/schema.ts`. `--fix` is a no-op for this check.

**Corrupt lock cleanup is path-addressed and lock-dir-confined.** A corrupt entry has no usable `plan_path`; `findExistingLock` skips unparsable non-canonical files (`src/lock.ts:65-88`), so `unlock <plan>` / `releaseLock` cannot target arbitrary corrupt leftovers. Export `removeCorruptLock(projectRoot, lockPath, opts?)` that (1) resolves `lockDir`, (2) verifies `lockPath` is exactly under that directory (realpath / prefix confinement — reject `..` escapes), (3) re-reads and confirms the file is still corrupt/unparsable, (4) unlinks that exact path. Doctor `--fix` uses this with `LockEntry.lockPath`. CLI `unlock <plan>` stays plan-keyed (canonical corrupt + stale via `releaseLock`); `lock list` remediation for `liveness: "corrupt"` names `5x doctor --fix` as the executable safe path (doctor-only handling for non-canonical corrupt files — deliberate CLI limit).

**Doctor check failures are findings, not process crashes.** The handler wraps each `check.run` in try/catch. Any thrown error becomes a single `fail` finding with stable code `CHECK_FAILED` (detail includes `check` id + message) so a corrupt DB, inaccessible worktree root, or freshness plugin load failure cannot abort the remaining sweep.

**`--fix` has an explicit detect → repair → re-detect contract.** `DoctorCheck.run` stays detect-only (ignores `ctx.fix` for mutation, or the handler never passes write permission into detect). Optional `DoctorCheck.fix?(finding, ctx)` performs one deterministic repair and returns whether it attempted a write. Handler algorithm (Phase 4.2): detect all checks → for each `fixable` finding when `--fix`, call `fix` → on claimed success, re-run that check's detect → if the matching finding is gone (or no longer `fail`/`fixable` for that code), append to `report.fixed` and keep the post-detect findings; if still present, keep the fail and do **not** claim `fixed`. Compute `report.ok` / exit code only from the final findings list.

**Worktree `--fix` clears dead mappings only.** Equivalent of `worktree detach` for rows where `worktree_path` is set but the directory is missing/unreadable. Orphan directories on disk with no DB row are reported (`warn`) and never deleted.

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
│  removeCorruptLock()     │   │  checks/harness-freshness.ts      │
│  releaseLock()           │   │  checks/locks.ts                  │
│  forceReleaseLock()      │   │  checks/worktrees.ts              │
│  isLocked()              │   │  checks/runs.ts                   │
└──────────────────────────┘   │  checks/db.ts                     │
                               └────────────┬──────────────────────┘
                                            │ reuses
                               ┌────────────▼──────────────────────┐
                               │ runHarnessFreshnessChecks (201)    │
                               │ harnessSyncCore (201) + lossless   │
                               │ worktreeDetach / upsertPlan        │
                               │ openDbReadOnly / getSchemaVersion  │
                               │ listRuns (read-only detect path)   │
                               └───────────────────────────────────┘

Error / step surfaces (additive):
  bin.ts text catch ──► Error: msg + optional "  → remediation"
  run-v1.handler    ──► PLAN_LOCKED detail, step_budget, MAX_STEPS remediation
  output.ts         ──► helper to read detail.remediation (optional)
```

Doctor finding / fix state:

```
  for each check:
    try detect ──► findings[]  { status, code, message, remediation?, fixable, detail? }
    catch     ──► fail finding code=CHECK_FAILED (sweep continues)
       │
       ├─ --fix + fixable + check.fix? ──► attempt repair
       │         └─ re-detect that check
       │              ├─ finding cleared ──► append report.fixed; keep post-detect findings
       │              └─ still present  ──► keep fail; do not claim fixed
       └─ aggregate: report.ok / exit 0 iff no fail remains in final findings
```

---

## Phase 1: Lock inventory + CLI unlock surface

**Completion gate:** `5x lock list` and `5x unlock` work in JSON and text modes; live locks require `--force`; `removeCorruptLock` confines and removes corrupt files by path; unit tests cover list/classify/unlock/corrupt-removal; `PLAN_LOCKED` detail includes holder + remediation at all three sites.

### 1.1 `src/lock.ts` — export inventory API

**File:** `src/lock.ts`, after `isLocked` (~lines 268–287)

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

- Scan `lockDir(projectRoot, opts)` for `*.lock` (same as `findExistingLock`'s directory walk).
- Parse via existing private `readLockFile`; `null` → `liveness: "corrupt"`, `info: null`.
- Parsed + `isPidAlive(pid)` → `"live"`; else `"stale"`.
- Empty / missing lock dir → `[]`.
- Optionally export a thin `getLockEntry(projectRoot, planPath, opts?)` for unlock preflight (or have the handler call `listLocks` / `isLocked` + corrupt path lookup). Prefer a small `inspectLock(projectRoot, planPath, opts?): LockEntry | null` that uses `findExistingLock` so unlock does not have to reimplement path hashing.

Also export `inspectLock` if it keeps the handler simpler:

```typescript
export function inspectLock(
  projectRoot: string,
  planPath: string,
  opts?: LockDirOpts,
): LockEntry | null;
```

Add a path-addressed corrupt cleanup helper (required for doctor — see Design Decisions / Phase 5.2):

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

- Resolve `lockDir(projectRoot, opts)` and the absolute `lockPath`; reject unless `lockPath` is a direct child of that directory (normalize + prefix/`..` check — no path escape).
- If missing → `{ removed: false, reason: "not_found" }`.
- Re-read with `readLockFile`; if it now parses as valid `LockInfo` → `{ removed: false, reason: "not_corrupt" }` (do not delete live/stale-by-path this way — those go through `releaseLock` / `forceReleaseLock`).
- Else `unlinkSync` that exact path; map unlink errors to `unlink_failed`.

- [ ] Add `LockLiveness`, `LockEntry`, `listLocks`, `inspectLock`, `removeCorruptLock`
- [ ] Re-export new symbols from `src/index.ts` (lines 77–89)
- [ ] Unit tests in `test/unit/lock-list.test.ts` (or extend `test/integration/lock.test.ts` unit portions) for live / stale / corrupt / empty dir
- [ ] Unit tests for `removeCorruptLock`: rejects path outside lock dir; refuses parsable lock; removes confirmed corrupt; missing → not_found

### 1.2 Lock command adapter + handler

**New files:**

- `src/commands/lock.ts` — commander adapter (`lock list`, `unlock <plan> [--force]`)
- `src/commands/lock.handler.ts` — business logic

Follow `registerWorktree` / `registerHarness` patterns. Resolve control-plane root + `stateDir` the same way `runV1Init` does (`resolveDbContext` / `resolveControlPlaneRoot`).

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

Custom text formatter: one line per lock, e.g. `live  pid=1234  plan=docs/...  since=...`. For `corrupt` rows, print `lock_path=` and omit a fake plan path.

`unlock` behavior (plan-keyed; deliberate limit — non-canonical corrupt leftovers are doctor-only):

| Condition | Action | Exit |
|-----------|--------|------|
| No lock | Success `{ released: false, reason: "not_locked" }` | 0 |
| Corrupt at canonical path / stale | `releaseLock` | 0 |
| Live, no `--force` | `outputError("PLAN_LOCKED", …)` with holder + remediation naming `--force` | 4 |
| Live + `--force` | Read holder via `inspectLock`, `forceReleaseLock`, success includes `forced: true` + `previous_holder` | 0 |

`lock list` remediation strings (text footer or per-row guidance when emitting findings elsewhere):

- `stale` → `5x unlock <plan>`
- `live` → `5x unlock <plan> --force`
- `corrupt` → `5x doctor --fix` (executable path that uses `removeCorruptLock` on `lock_path`; do **not** advertise `5x unlock <plan>` for corrupt rows with `plan_path: null`)

- [ ] Implement adapter + handler with `startDir?` for unit tests
- [ ] Register via `registerLock(program)` in `src/bin.ts` (~line 96)
- [ ] Unit tests: safe unlock stale/canonical-corrupt; refuse live; force overrides; list classification; corrupt list row exposes `lock_path`

### 1.3 Enrich `PLAN_LOCKED` at all throw sites

**File:** `src/commands/run-v1.handler.ts`, lines 811–818, 1222–1226, 1294–1298

Shared helper (local to handler or small util):

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

Use the canonical plan path string the operator can pass back to `unlock`.

- [ ] Replace detail objects at init / complete / reopen
- [ ] Unit or integration assertion that JSON error envelope includes `holder` + `remediation`

---

## Phase 2: Text-mode remediation

**Completion gate:** Any `CliError` whose `detail.remediation` is a string prints two stderr lines in `--text` mode; JSON stdout remains a single parseable envelope with no stderr remediation requirement.

### 2.1 Helper + `bin.ts` catch path

**Files:** `src/output.ts` (new helper near `CliError`), `src/bin.ts:117-120` (and the other text-mode error branches that print `Error: …` if they can carry remediation — Commander/internal errors typically have none).

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

Use `formatTextError` in the `CliError` text branch. Leave Commander / INTERNAL_ERROR branches on the single-line form unless detail exists.

- [ ] Add helpers + unit tests in `test/unit/output.test.ts`
- [ ] Wire `bin.ts` CliError text path
- [ ] Integration: `5x run init` against a live lock with `--text` shows remediation line; `--json` stdout has no second envelope

### 2.2 Doc note (contract)

**File:** `docs/v1/100-architecture.md` §4a (~line 224)

Amend the text-mode error sentence to: single `Error: <message>` plus optional `→ <remediation>` when present. Mark as additive / non-breaking. Full normalization remains 205's job.

- [ ] Update §4a wording
- [ ] Mention in `docs/v2/203-recovery-and-doctor.md` status when Phase 6 lands (not required mid-phase)

---

## Phase 3: Step-budget visibility

**Completion gate:** `run state` always shows step budget fields; `run record` warns at ≥80% without failing; `MAX_STEPS_EXCEEDED` includes remediation naming config bump and split-work.

### 3.1 Constants + shared budget helper

**File:** `src/commands/run-v1.handler.ts` (near `getMaxStepsPerRun`, ~lines 201–220)

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

### 3.2 `run state` — always surface budget

**File:** `src/commands/run-v1.handler.ts:924-989` (`runV1State`), `formatStateText` (`:540-649`)

After `computeRunSummary` / `getMaxStepsPerRun`:

```typescript
const maxSteps = getMaxStepsPerRun(config as unknown as Record<string, unknown>);
const budget = computeStepBudget(summary.total_steps, maxSteps);

outputSuccess(
  {
    run: { /* existing */ },
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

**File:** `src/commands/run-v1.handler.ts` — `recordStepInternal` return + `runV1Record` success path (~1094–1169)

After a successful record, recompute summary (or use `used = previous + 1` carefully with idempotent re-records). Prefer reading `computeRunSummary` post-insert so idempotent re-records report the true count.

```typescript
const budget = computeStepBudget(summary.total_steps, maxSteps);
const warning = stepBudgetWarning(budget);
outputSuccess({
  ...result,
  ...(warning
    ? { step_budget: budget, warnings: [warning] }
    : {}),
});
```

Text mode: if `warnings` present, print them to stderr (same pattern as freshness — keep stdout envelope/text body clean) **or** include in the text formatter. Prefer stderr for warnings to match harness-freshness (`emitFreshnessWarnings`), and keep `warnings` / `step_budget` on the JSON data object.

- [ ] Warning only at ≥80%; success exit 0 unchanged
- [ ] Idempotent re-record does not false-trigger incorrectly
- [ ] Unit tests for threshold boundaries (199/250 silent if under; 200/250 warns)

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

- [ ] Detail includes remediation
- [ ] Integration: text mode shows `→ Raise maxStepsPerRun…`

---

## Phase 4: Doctor registry, formatting, and CLI skeleton

**Completion gate:** `5x doctor` runs an empty-or-noop registry, emits the standard envelope, custom text format, exit 0; `--fix` flag accepted; unit tests cover aggregation/exit-code rules, per-check exception isolation, and the detect→fix→re-detect/`fixed` contract with a stub check.

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
   * Absolute control-plane DB path when resolved, else null when absent.
   * Never an open mutating connection — checks that need SQLite open
   * read-only themselves (see Phase 6.2).
   */
  dbPath: string | null;
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

/** Built-in checks — plugin contribution deferred. */
export const builtinDoctorChecks: DoctorCheck[] = [];
// Phase 5/6 push concrete checks here (or import and spread).
```

Aggregation helper:

```typescript
export function summarizeDoctor(findings: DoctorFinding[], fixed: DoctorReport["fixed"]): DoctorReport {
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
```

- [ ] Create `src/doctor/types.ts`, `registry.ts`, `summary.ts` (or keep helpers in registry)
- [ ] Unit tests: warn-only → exit 0; any fail → exit 1; empty → ok
- [ ] Unit tests: throwing check → `CHECK_FAILED` finding; sibling checks still run

### 4.2 Handler + commander adapter

**New files:** `src/commands/doctor.ts`, `src/commands/doctor.handler.ts`

Handler algorithm (normative — this is how `fixed` and `report.ok` are produced):

```typescript
export async function doctorRun(params: {
  fix?: boolean;
  startDir?: string;
  homeDir?: string;
}): Promise<void> {
  const ctx = await resolveDoctorContext(params); // path resolution only; no migrate/create
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

    // Repair each fixable finding, then re-detect before claiming success.
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
        (f) => f.code === candidate.code && f.status === "fail",
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

Notes:

- `resolveDoctorContext` derives `projectRoot` / `stateDir` / `dbPath` the same way as control-plane resolution, but **must not** open a migrating/creating DB. Prefer `existsSync` + path join; leave opening to the `db` check.
- Matching for “finding cleared” keys on `code` + `status === "fail"` for that check; ok/warn replacements after repair are fine.
- Prefer setting exit code without throwing when the envelope is a successful diagnostic report.

**Decision:** Follow diagnostic-command pattern: stdout success envelope always (`{ ok: true, data: DoctorReport }`) where `data.ok` reflects check health; process exit code is `doctorExitCode(report)`. This keeps parsers simple (always a success envelope for the command invocation itself) while CI can still key off exit code. Document clearly. (If existing CLI convention for similar commands differs, match it — `harness sync --check` is the closest analogue; inspect and stay consistent during implementation.)

Text formatter (human-first):

```
harness-freshness  fail  opencode (project) assets are stale
  → 5x harness sync
locks              warn  live lock on docs/foo.md (pid 1234)
  → 5x unlock docs/foo.md --force
db                 ok    schema v5, integrity ok
```

When `report.fixed.length > 0`, print a short `Fixed:` section after the findings (JSON already carries `fixed`).

- [ ] Adapter with `--fix`
- [ ] Register `registerDoctor(program)` in `src/bin.ts`
- [ ] Custom text formatter + JSON envelope tests
- [ ] Unit tests: stub check with fixable finding — `--fix` populates `fixed` only after re-detect clears it; failed re-detect does not claim `fixed`

---

## Phase 5: Doctor checks — freshness, locks, worktrees

**Completion gate:** Three checks registered; `--fix` removes stale locks and path-addressed corrupt locks, clears dead worktree mappings, and syncs only project-scope harness installs that satisfy `losslessRefresh`; live locks / orphan dirs / user-scope / context-mismatch / hand-edits are report-only (no write).

### 5.1 `harness-freshness` check

**File:** `src/doctor/checks/harness-freshness.ts`

- Call `runHarnessFreshnessChecks({ startDir, homeDir, tier2: true })`.
- Map each installed report:
  - `fresh` → ok finding (or omit ok noise — **include one ok summary per check id** when every scope is fresh/not-installed, so empty-failing output stays distinguishable).
  - project-scope `stale` / `unknown` → `fail`, remediation `5x harness sync` (or `5x harness sync --force` when `losslessBlockers` includes `assets-modified`).
  - user-scope `stale` / `unknown` → `warn`, remediation `5x harness install <harness> --scope project` (201 D4; never auto-fix).
- Put `losslessRefresh`, `losslessBlockers`, and `installedFrom` on `finding.detail` so `--fix` and tests can assert the predicate without re-querying.
- `fixable: true` **only** when `report.scope === "project"` **and** `report.losslessRefresh === true` **and** status is `stale` or `unknown`. Context-mismatched project installs (`losslessBlockers` includes `context-mismatch`) stay `fixable: false` with remediation — no write.
- `fix` implementation: call `harnessSyncCore({ name, scope: "project", startDir, homeDir })` (`src/commands/harness.handler.ts:660`) **only** for findings that were marked fixable under the predicate above. Do **not** pass `force: true`. If sync returns `skipped-modified` / non-success action, return `{ attempted: false, … }` or `{ attempted: true, … }` with a message but rely on handler re-detect to withhold `fixed`. Skip user-scope always.
- Do **not** consult `freshnessWarningsEnabled` to suppress findings.
- Align with `docs/v2/201-harness-freshness.md` §2.6 / D6 — doctor must not weaken the lossless predicate that `upgrade`/`autoSync` already honor; `harnessSyncCore` alone is insufficient as a gate.

- [ ] Implement check + register (`run` + `fix`)
- [ ] Unit tests with temp install / stale manifest (reuse 201 test helpers patterns from `test/unit/harnesses/freshness.test.ts`)
- [ ] `--fix` syncs only when `losslessRefresh`; leaves user-scope, context-mismatch, and hand-edited assets as report-only without write
- [ ] Unit test: project install baked from a different `contextDir` → fail/warn finding, `fixable: false`, no `harnessSyncCore` write

### 5.2 `locks` check

**File:** `src/doctor/checks/locks.ts`

- `listLocks(projectRoot, { stateDir })`.
- `stale` → `fail`, `fixable: true`, remediation `5x unlock <plan>` (plan path from `info.planPath`).
- `corrupt` → `fail`, `fixable: true`, remediation `5x doctor --fix`, `detail.lockPath = entry.lockPath` (required — no plan path).
- `live` → `warn`, `fixable: false`, remediation `5x unlock <plan> --force`.
- `fix`:
  - `stale` → `releaseLock(projectRoot, planPath, { stateDir })` (never `forceReleaseLock` for doctor auto-fix).
  - `corrupt` → `removeCorruptLock(projectRoot, detail.lockPath, { stateDir })` — path-confined helper from Phase 1.1; never attempt plan-keyed unlock for `plan_path: null`.
  - never remove live locks.

- [ ] Implement + tests for each liveness class
- [ ] Filesystem-focused unit tests ensuring live lock files survive `--fix`
- [ ] Unit test: non-canonical corrupt file removed via `removeCorruptLock` on `lockPath`; plan-keyed `unlock` is not required for that case

### 5.3 `worktrees` check

**File:** `src/doctor/checks/worktrees.ts`

- Detect path: if `ctx.dbPath` is null → return `[]` (the `db` check owns `DB_MISSING`). If present, open with `openDbReadOnly` (never `getDb` / `resolveDbContext`); close when done. Open/query failures → `fail` `DB_UNREADABLE` (or let handler `CHECK_FAILED` if unexpected) — do not abort other checks.
- Query plans with non-empty `worktree_path` (same SQL as `worktreeList`, `src/commands/worktree.handler.ts:484-492`).
- Missing/unreadable dir → `fail`, `fixable: true`, remediation `5x worktree detach -p <plan>` (or equivalent).
- `fix`: open a **writable** connection only for the detach-equivalent write (`upsertPlan` with empty worktree/branch) **without** deleting directories and **without** running migrations — if the schema is too old to query/update, leave the finding and remediate `5x upgrade`. Prefer reusing the same write path as `worktreeDetach` once the DB is confirmed openable.
- Orphan git worktrees under `.5x/worktrees/` (or `listWorktrees`) with no plan row → `warn`, not fixable.

- [ ] Implement + tests (dead mapping cleared; orphan dir preserved)
- [ ] Ensure detach-equivalent does not call `git worktree remove`
- [ ] Detect path does not create/migrate the DB

---

## Phase 6: Doctor checks — runs, db; docs and end-to-end validation

**Completion gate:** All five checks ship; docs reflect implemented subset + deferred prompt check; integration suite covers CLI text/JSON/exit codes/lock behavior; `203-recovery-and-doctor.md` status updated.

### 6.1 `runs` check (report-only)

**File:** `src/doctor/checks/runs.ts`

```typescript
export const LINGERING_RUN_AGE_MS = 24 * 60 * 60 * 1000;
```

- If `ctx.dbPath` is null → return `[]` (the `db` check owns `DB_MISSING`; do not create a file).
- Else open `openDbReadOnly` from `ctx.dbPath`'s projectRoot/relPath; never migrate. Open/query failures → `fail` `DB_UNREADABLE` (stable code; do not throw).
- Use `listRuns(db, { status: "active" })` (`src/db/operations-v1.ts:360`).
- Flag when `Date.now() - Date.parse(updated_at) >= LINGERING_RUN_AGE_MS` **and** `inspectLock` / `isLocked` for that plan is not live.
- Inject `now?: number` (or clock) on the check context / check factory for deterministic unit tests — do not call unmockable `Date.now()` without a seam.
- Finding: `warn`, remediation `5x run complete --run <id> --status aborted` (primary suggestion for crashed sessions; mention `run reopen` only if documenting the judgment fork in the message).
- `--fix`: no-op (judgment call).

- [ ] Implement + unit tests with injected "now" or fixture timestamps
- [ ] Active run with live lock → not flagged
- [ ] Missing DB does not create a file

### 6.2 `db` check (report-only, non-mutating)

**File:** `src/doctor/checks/db.ts`

**Inspection path (normative):**

1. Resolve the absolute DB path the same way as control-plane / legacy contexts (`join(stateDir, DB_FILENAME)` or normalized `config.db.path` + `DB_FILENAME`) — path math only; reuse helpers that do **not** open SQLite.
2. If `!existsSync(dbPath)` → single finding:
   - `status: "fail"`, `code: "DB_MISSING"`, `fixable: false`
   - remediation: initialize/restore guidance (`5x init` when no control plane, or restore backup / re-clone state — message should not imply doctor will create the DB)
3. Else open with `openDbReadOnly(projectRoot, dbRelPath)` (`src/db/connection.ts:64-67`) — **readonly, no pragma/WAL setup, no mkdir, no migrate**. Optionally wrap in a tiny `openDbForDoctorInspection` helper if tests need a seam; do **not** call `getDb` or `resolveDbContext`.
4. On open failure (corrupt header, permissions, etc.) → `fail` `DB_UNREADABLE`, remediation restore/delete (never auto-delete), `fixable: false`.
5. `getSchemaVersion(db)` vs `getMaxKnownSchemaVersion()` (export from `src/db/schema.ts`, max of `migrations`):
   - behind → `fail`, remediation `5x upgrade`
   - ahead → `fail`, remediation to upgrade CLI (same message family as `runMigrations`)
6. `PRAGMA integrity_check` not `ok` → `fail` `DB_INTEGRITY`, remediation restore/delete (never auto-delete).
7. Healthy → single `ok` finding with version number.
8. Always close the read-only connection in `finally`.
9. `--fix`: no-op (no migrations, no create, no delete).

This preserves the plan's “never migrates” guarantee and lets doctor report an old schema instead of silently upgrading it during inspection.

- [ ] Export max known version helper
- [ ] Implement check + unit tests: missing file → `DB_MISSING` and no file created; outdated schema reported without migration; corrupt/unreadable → finding; healthy → ok
- [ ] Assert `resolveDbContext` / `getDb` are not used on the detect path (code review / grep gate in review checklist)

### 6.3 Wire registry + integration suite

- [ ] `builtinDoctorChecks = [harnessFreshness, locks, worktrees, runs, db]` in order shown in 203 §2.4 (prompts omitted)
- [ ] Integration: `test/integration/commands/doctor.test.ts` — exit codes, JSON shape, `--fix` lock cleanup (including corrupt-by-path), text formatter, check-failure isolation
- [ ] Integration: `test/integration/commands/lock.test.ts` — list/unlock/force via CLI spawn + `cleanGitEnv()`
- [ ] Integration: step-budget + text remediation smoke tests
- [ ] Integration/unit: doctor `--fix` does not sync context-mismatched project harness; does not create DB when absent

### 6.4 Documentation

- [ ] Update `docs/v2/203-recovery-and-doctor.md` status to Implemented (or Partial) with pointer to this plan; note prompts check deferred
- [ ] Update `docs/v2/200-overview.md` area #3 row if it tracks implementation status
- [ ] Update plan-input metadata `Generated plan` → this file path
- [ ] Command help text in adapters is the primary CLI reference (no separate man pages exist); ensure `--help` examples cover list/unlock/doctor
- [ ] AGENTS.md: short note that `5x doctor` is the recovery front door (optional, only if an existing recovery section exists — do not create a large new doc)

### 6.5 End-to-end validation checklist

- [ ] Live lock → `PLAN_LOCKED` JSON has holder + remediation; text shows `→ …unlock…--force`
- [ ] `unlock` without `--force` refuses; with `--force` prints previous holder
- [ ] Corrupt non-canonical lock → `lock list` shows it; `doctor --fix` removes via `lockPath`; plan-keyed unlock not required
- [ ] `run record` at 80% warns; at max fails with remediation; `run state` always shows budget
- [ ] `doctor` detects all five classes; `--fix` only mutates stale locks + path-addressed corrupt locks + dead mappings + lossless project harness sync
- [ ] Context-mismatched project harness is reported and not auto-synced
- [ ] Absent DB → `DB_MISSING`; doctor does not create/migrate the file
- [ ] Throwing check → `CHECK_FAILED`; other checks still run; `fixed` only after successful re-detect
- [ ] `harness.freshnessWarnings=off` does not hide doctor freshness findings
- [ ] `bun test` unit + integration green

---

## Files Touched

| File | Change |
|------|--------|
| `src/lock.ts` | Add `listLocks`, `inspectLock`, `removeCorruptLock`, `LockEntry` / `LockLiveness` |
| `src/index.ts` | Re-export new lock symbols |
| `src/commands/lock.ts` | **New** — `lock list` / `unlock` adapter |
| `src/commands/lock.handler.ts` | **New** — list/unlock handlers |
| `src/commands/doctor.ts` | **New** — `doctor [--fix]` adapter |
| `src/commands/doctor.handler.ts` | **New** — detect→fix→re-detect loop, `CHECK_FAILED` isolation, exit code |
| `src/doctor/types.ts` | **New** — check/finding/report/`fix?` types |
| `src/doctor/registry.ts` | **New** — builtin check list + summarize/exit/`checkFailedFinding` helpers |
| `src/doctor/checks/harness-freshness.ts` | **New** — Tier-2 freshness + lossless-gated sync fix |
| `src/doctor/checks/locks.ts` | **New** — stale/corrupt/live findings; corrupt fix via `removeCorruptLock` |
| `src/doctor/checks/worktrees.ts` | **New** — dead mappings + orphan warns (read-only detect) |
| `src/doctor/checks/runs.ts` | **New** — lingering active runs (report-only, read-only DB) |
| `src/doctor/checks/db.ts` | **New** — missing/unreadable/schema/integrity via `openDbReadOnly` |
| `src/bin.ts` | Register lock + doctor; text remediation line |
| `src/output.ts` | `remediationFromDetail` / `formatTextError` |
| `src/commands/run-v1.handler.ts` | PLAN_LOCKED detail; step budget; MAX_STEPS remediation; state fields |
| `src/db/schema.ts` | Export `getMaxKnownSchemaVersion()` (or equivalent) |
| `src/db/connection.ts` | Reuse `openDbReadOnly`; optional thin doctor inspection wrapper if needed |
| `docs/v1/100-architecture.md` | §4a additive remediation line |
| `docs/v2/203-recovery-and-doctor.md` | Status + deferred prompts note |
| `docs/v2/200-overview.md` | Area #3 status if applicable |
| `docs/v2/plan-inputs/01-recovery-and-doctor.plan-input.md` | Generated plan pointer |
| `test/unit/output.test.ts` | Remediation helper coverage |
| `test/unit/lock-list.test.ts` | **New** — inventory / classify / `removeCorruptLock` |
| `test/unit/commands/lock.test.ts` | **New** — handler-level unlock/list |
| `test/unit/doctor/*.test.ts` | **New** — registry, fix contract, each check (incl. lossless + DB_MISSING) |
| `test/unit/commands/run-step-budget.test.ts` | **New** — threshold + state fields |
| `test/integration/commands/lock-cli.test.ts` | **New** — CLI spawn coverage |
| `test/integration/commands/doctor.test.ts` | **New** — CLI doctor coverage |
| `test/integration/commands/run-step-budget.test.ts` | **New** — record/state/text remediation |

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `lock.ts` list/inspect | live / stale / corrupt / empty; no mutation |
| Unit | `lock.ts` `removeCorruptLock` | confined path; refuses parsable; removes corrupt; rejects escape |
| Unit | `lock.handler` | safe unlock; refuse live; force releases + returns holder |
| Unit | `output.ts` | remediation extracted; absent/non-string ignored |
| Unit | step-budget helpers | 79% silent, 80% warns, remaining math |
| Unit | `run-v1.handler` PLAN_LOCKED detail | holder + remediation shape at helper level |
| Unit | doctor summary / handler | warn-only exit 0; fail exit 1; `CHECK_FAILED` isolation; fix→re-detect `fixed` rules |
| Unit | doctor checks | each check's detect + fix matrix with temp dirs/DB |
| Unit | doctor freshness | `losslessRefresh` gate; context-mismatch not fixable; no sync write |
| Unit | doctor db | `DB_MISSING` / unreadable / behind schema; no create/migrate |
| Integration | `lock list` / `unlock` CLI | stdout JSON, text lines, exit 4 on live without force; corrupt shows `lock_path` |
| Integration | `run init` PLAN_LOCKED | text remediation line; JSON envelope single object on stdout |
| Integration | `run record` / `run state` | step_budget warnings; state fields always present |
| Integration | `doctor` / `doctor --fix` | five check classes; fix mutates only safe targets; exit codes |
| Edge | doctor freshness | `freshnessWarnings=off` still reports; user-scope / context-mismatch not auto-fixed |
| Edge | lingering runs | live lock suppresses warn; fresh active run not flagged |
| Edge | corrupt locks | doctor removes by `lockPath`; unlock-by-plan not required for non-canonical corrupt |

---

## Not In Scope

- **Prompt-hygiene doctor check** — needs prompt persistence from control-plane / prompt-queue slice (`03-prompt-queue-foundation.plan-input.md`).
- **Remote liveness via opaque invocation handles** — `05-invocation-registry`; keep PID checks behind `lock.ts`.
- **Breaking stdout/text normalization** — `09-output-normalization-release` / `205`.
- **PID-start-time vs lock `startedAt` sanity check** — deferred; `--force` is the escape hatch.
- **Plugin-contributed doctor checks** — registry shape allows it later; v2 ships five builtins.
- **Configurable `stepWarningThreshold` / doctor warn exit codes / lingering-run age config** — fixed constants for v2.
- **Deleting orphan worktree directories from `doctor --fix`** — never; report only.

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

## Provenance

Implements v2 area #3 (`docs/v2/203-recovery-and-doctor.md`) from plan input `docs/v2/plan-inputs/01-recovery-and-doctor.plan-input.md`. Depends on completed area #1 freshness APIs (`201-harness-freshness-plan.md`) for the doctor harness check and safe sync fix. Leaves prompt hygiene and remote invocation liveness to subsequent plan inputs as specified in the handoff section.

---

## Revision History

- **v1.2 (2026-08-13):** Revised per
  `docs/development/reviews/.5x-worktrees-203-recovery-and-doctor-plan-0323a0-5x-cli-docs-development-plans-203-recovery-and-doctor-plan-review.md`
  (initial review; no addendum).
  - **P0.1:** DB doctor inspection is path-resolve + `openDbReadOnly` / no-create / no-migrate; defines `DB_MISSING` / `DB_UNREADABLE` / integrity findings.
  - **P0.2:** Harness `--fix` gated on `FreshnessReport.losslessRefresh` (201 D6 context + unmodified assets); context-mismatch stays report-only.
  - **P0.3:** Added lock-dir-confined `removeCorruptLock(lockPath)`; doctor uses it; `lock list` corrupt remediation → `5x doctor --fix`.
  - **P1.1:** Handler converts per-check throws to `CHECK_FAILED` findings and continues the sweep.
  - **P1.2:** Normative detect → `fix?` → re-detect algorithm; `report.fixed` only after verified clear; `DoctorCheck.run` is detect-only.
- **v1.1 (2026-08-13):** Prior draft pending staff engineer review.
