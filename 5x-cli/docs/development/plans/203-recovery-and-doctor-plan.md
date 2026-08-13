# Recovery & `5x doctor` — Lock Surface, Step Budget, Remediation, Doctor Registry

**Version:** 1.0
**Created:** August 13, 2026
**Status:** Draft — pending staff engineer review

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
| **Doctor always runs harness-freshness; `freshnessWarnings=off` stays hot-path only** | Explicit diagnostics must not be silenced by the incidental-warning switch; `--fix` still honors project-scope + lossless gates. |

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
- `5x doctor [--fix]` runs five built-in checks with a standard envelope and human text formatter; `--fix` applies only safe repairs.

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

**Harness-freshness in doctor always runs Tier 2** via `runHarnessFreshnessChecks({ tier2: true })`. Status mapping: `fresh` / `not-installed` → `ok`; `stale` / `unknown` → `fail` with remediation `5x harness sync` (or project-scope install guidance for user-scope). Honor `harness.freshnessWarnings = "off"` only for incidental hot-path warnings — doctor is explicit and still reports. `--fix` calls `harnessSyncCore` for scopes where refresh is safe: `scope === "project"` and no hand-edit blocker (reuse existing sync policy; do not invent a second writer).

**Lingering-run age threshold is a named constant `LINGERING_RUN_AGE_MS = 24 * 60 * 60 * 1000`.** Heuristic: active run whose `updated_at` is older than 24h. Report-only — never auto-complete/abort. False positives are acceptable because the remediation is a suggested command, not a mutation. Session/PID presence is best-effort: if the plan lock is live for that plan, do not flag the run as lingering (someone is still working).

**DB check never migrates.** Compare `getSchemaVersion(db)` to `migrations[last].version` (export a `CURRENT_SCHEMA_VERSION` or `getMaxKnownSchemaVersion()` from `src/db/schema.ts`); run `PRAGMA integrity_check`. Failures → remediation `5x upgrade` / restore-from-backup guidance. `--fix` is a no-op for this check.

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
│  releaseLock()           │   │  checks/harness-freshness.ts      │
│  forceReleaseLock()      │   │  checks/locks.ts                  │
│  isLocked()              │   │  checks/worktrees.ts              │
└──────────────────────────┘   │  checks/runs.ts                   │
                               │  checks/db.ts                     │
                               └────────────┬──────────────────────┘
                                            │ reuses
                               ┌────────────▼──────────────────────┐
                               │ runHarnessFreshnessChecks (201)    │
                               │ harnessSyncCore (201)              │
                               │ worktreeDetach / upsertPlan        │
                               │ getSchemaVersion / listRuns        │
                               └───────────────────────────────────┘

Error / step surfaces (additive):
  bin.ts text catch ──► Error: msg + optional "  → remediation"
  run-v1.handler    ──► PLAN_LOCKED detail, step_budget, MAX_STEPS remediation
  output.ts         ──► helper to read detail.remediation (optional)
```

Doctor finding state:

```
  check runs ──► findings[] each { status: ok|warn|fail, code, message, remediation?, fixable }
       │
       ├─ --fix + fixable + exactly-one-repair ──► apply fix, re-status
       └─ aggregate: exit 0 iff no fail remains
```

---

## Phase 1: Lock inventory + CLI unlock surface

**Completion gate:** `5x lock list` and `5x unlock` work in JSON and text modes; live locks require `--force`; unit tests cover list/classify/unlock; `PLAN_LOCKED` detail includes holder + remediation at all three sites.

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

- [ ] Add `LockLiveness`, `LockEntry`, `listLocks`, `inspectLock`
- [ ] Re-export new symbols from `src/index.ts` (lines 77–89)
- [ ] Unit tests in `test/unit/lock-list.test.ts` (or extend `test/integration/lock.test.ts` unit portions) for live / stale / corrupt / empty dir

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

Custom text formatter: one line per lock, e.g. `live  pid=1234  plan=docs/...  since=...`.

`unlock` behavior:

| Condition | Action | Exit |
|-----------|--------|------|
| No lock | Success `{ released: false, reason: "not_locked" }` | 0 |
| Corrupt / stale | `releaseLock` | 0 |
| Live, no `--force` | `outputError("PLAN_LOCKED", …)` with holder + remediation naming `--force` | 4 |
| Live + `--force` | Read holder via `inspectLock`, `forceReleaseLock`, success includes `forced: true` + `previous_holder` | 0 |

- [ ] Implement adapter + handler with `startDir?` for unit tests
- [ ] Register via `registerLock(program)` in `src/bin.ts` (~line 96)
- [ ] Unit tests: safe unlock stale/corrupt; refuse live; force overrides; list classification

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

### Phase 2: Text-mode remediation

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

### Phase 3: Step-budget visibility

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

**File:** `src/commands/run-v1.handler.ts:924-989` (`runV1State`), `formatStateText` (~540–649)

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

Update `formatStateText` to print a `Steps used: N / max (remaining R)` line in the header or summary.

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

### Phase 4: Doctor registry, formatting, and CLI skeleton

**Completion gate:** `5x doctor` runs an empty-or-noop registry, emits the standard envelope, custom text format, exit 0; `--fix` flag accepted; unit tests cover aggregation/exit-code rules.

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
  /** When true, checks may perform safe repairs. */
  fix: boolean;
}

export interface DoctorCheck {
  id: string;
  /** Run detection (and optional fix when ctx.fix). */
  run(ctx: DoctorCheckContext): Promise<DoctorFinding[]>;
}

export interface DoctorReport {
  ok: boolean; // true iff no fail findings remain
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
```

- [ ] Create `src/doctor/types.ts`, `registry.ts`, `summary.ts` (or keep helpers in registry)
- [ ] Unit tests: warn-only → exit 0; any fail → exit 1; empty → ok

### 4.2 Handler + commander adapter

**New files:** `src/commands/doctor.ts`, `src/commands/doctor.handler.ts`

```typescript
export async function doctorRun(params: {
  fix?: boolean;
  startDir?: string;
  homeDir?: string;
}): Promise<void> {
  // resolve projectRoot / stateDir / db as needed
  // for (const check of builtinDoctorChecks) findings.push(...await check.run(ctx))
  // outputSuccess(report, formatDoctorText)
  // if (!report.ok) process.exitCode = 1  — OR throw CliError("DOCTOR_FAILED", …, undefined, 1)
}
```

Prefer setting exit code without throwing when the envelope is a successful diagnostic report (`ok: false` inside data is fine — stdout still gets `{ ok: true, data: report }` **or** `{ ok: false, error }`?).

**Decision:** Follow diagnostic-command pattern: stdout success envelope always (`{ ok: true, data: DoctorReport }`) where `data.ok` reflects check health; process exit code is `doctorExitCode(report)`. This keeps parsers simple (always a success envelope for the command invocation itself) while CI can still key off exit code. Document clearly. (If existing CLI convention for similar commands differs, match it — `harness sync --check` is the closest analogue; inspect and stay consistent during implementation.)

Text formatter (human-first):

```
harness-freshness  fail  opencode (project) assets are stale
  → 5x harness sync
locks              warn  live lock on docs/foo.md (pid 1234)
  → 5x unlock docs/foo.md --force
db                 ok    schema v5, integrity ok
```

- [ ] Adapter with `--fix`
- [ ] Register `registerDoctor(program)` in `src/bin.ts`
- [ ] Custom text formatter + JSON envelope tests

---

### Phase 5: Doctor checks — freshness, locks, worktrees

**Completion gate:** Three checks registered; `--fix` removes stale/corrupt locks, clears dead worktree mappings, and syncs safe project-scope harness stale installs; live locks / orphan dirs / user-scope / hand-edits are report-only.

### 5.1 `harness-freshness` check

**File:** `src/doctor/checks/harness-freshness.ts`

- Call `runHarnessFreshnessChecks({ startDir, homeDir, tier2: true })`.
- Map each installed report:
  - `fresh` → ok finding (or omit ok noise — **include one ok summary per check id** to keep output stable; detailed per-scope fails/warns as separate findings).
  - `stale` / `unknown` → `fail`, remediation `5x harness sync` (user-scope: remediation explains warn-only / install project scope per 201 D4).
- `--fix`: for each project-scope finding that `harnessSyncCore` can refresh without `--force` hand-edit override, call `harnessSyncCore({ name, scope: "project", startDir, homeDir })`. Skip user-scope auto-fix. Skip when sync would throw `HARNESS_ASSETS_MODIFIED` — report remediation with `--force` instead.
- Do **not** consult `freshnessWarningsEnabled` to suppress findings.

- [ ] Implement check + register
- [ ] Unit tests with temp install / stale manifest (reuse 201 test helpers patterns from `test/unit/harnesses/freshness.test.ts`)
- [ ] `--fix` syncs project stale; leaves user-scope as warn/fail without write

### 5.2 `locks` check

**File:** `src/doctor/checks/locks.ts`

- `listLocks(projectRoot, { stateDir })`.
- `stale` / `corrupt` → `fail`, `fixable: true`, remediation `5x unlock <plan>` (or internal fix).
- `live` → `warn`, `fixable: false`, remediation `5x unlock <plan> --force`.
- `--fix`: `forceReleaseLock` **only** for stale/corrupt (prefer `releaseLock` / delete corrupt path — never force-remove live).

- [ ] Implement + tests for each liveness class
- [ ] Filesystem-focused unit tests ensuring live lock files survive `--fix`

### 5.3 `worktrees` check

**File:** `src/doctor/checks/worktrees.ts`

- Query plans with non-empty `worktree_path` (same SQL as `worktreeList`, `src/commands/worktree.handler.ts:484-492`).
- Missing/unreadable dir → `fail`, `fixable: true`, remediation `5x worktree detach -p <plan>` (or equivalent).
- `--fix`: clear mapping via the same DB write as `worktreeDetach` (`upsertPlan` with empty worktree/branch) **without** deleting directories.
- Orphan git worktrees under `.5x/worktrees/` (or `listWorktrees`) with no plan row → `warn`, not fixable.

- [ ] Implement + tests (dead mapping cleared; orphan dir preserved)
- [ ] Ensure detach-equivalent does not call `git worktree remove`

---

### Phase 6: Doctor checks — runs, db; docs and end-to-end validation

**Completion gate:** All five checks ship; docs reflect implemented subset + deferred prompt check; integration suite covers CLI text/JSON/exit codes/lock behavior; `203-recovery-and-doctor.md` status updated.

### 6.1 `runs` check (report-only)

**File:** `src/doctor/checks/runs.ts`

```typescript
export const LINGERING_RUN_AGE_MS = 24 * 60 * 60 * 1000;
```

- `listRuns` (or SQL) for `status = 'active'`.
- Flag when `Date.now() - Date.parse(updated_at) >= LINGERING_RUN_AGE_MS` **and** the plan's lock is not live.
- Finding: `warn`, remediation `5x run complete --run <id> --status aborted` (and/or `run reopen` guidance as appropriate — complete/abort is the primary suggestion for crashed sessions).
- `--fix`: no-op (judgment call).

- [ ] Implement + unit tests with injected "now" or fixture timestamps
- [ ] Active run with live lock → not flagged

### 6.2 `db` check (report-only)

**File:** `src/doctor/checks/db.ts`

- Open DB via existing connection helpers; `getSchemaVersion(db)`.
- Export `getMaxKnownSchemaVersion()` from `src/db/schema.ts` (max of `migrations`).
- Version behind → `fail`, remediation `5x upgrade`.
- Version ahead → `fail`, remediation to upgrade CLI (message already used in `runMigrations`).
- `PRAGMA integrity_check` not `ok` → `fail`, remediation to restore/delete DB (never auto-delete).
- Healthy → single `ok` finding with version number.
- `--fix`: no-op.

- [ ] Export max known version helper
- [ ] Implement check + unit tests (temp DB, optional corrupt file)

### 6.3 Wire registry + integration suite

- [ ] `builtinDoctorChecks = [harnessFreshness, locks, worktrees, runs, db]` in order shown in 203 §2.4 (prompts omitted)
- [ ] Integration: `test/integration/commands/doctor.test.ts` — exit codes, JSON shape, `--fix` lock cleanup, text formatter
- [ ] Integration: `test/integration/commands/lock.test.ts` — list/unlock/force via CLI spawn + `cleanGitEnv()`
- [ ] Integration: step-budget + text remediation smoke tests

### 6.4 Documentation

- [ ] Update `docs/v2/203-recovery-and-doctor.md` status to Implemented (or Partial) with pointer to this plan; note prompts check deferred
- [ ] Update `docs/v2/200-overview.md` area #3 row if it tracks implementation status
- [ ] Update plan-input metadata `Generated plan` → this file path
- [ ] Command help text in adapters is the primary CLI reference (no separate man pages exist); ensure `--help` examples cover list/unlock/doctor
- [ ] AGENTS.md: short note that `5x doctor` is the recovery front door (optional, only if an existing recovery section exists — do not create a large new doc)

### 6.5 End-to-end validation checklist

- [ ] Live lock → `PLAN_LOCKED` JSON has holder + remediation; text shows `→ …unlock…--force`
- [ ] `unlock` without `--force` refuses; with `--force` prints previous holder
- [ ] `run record` at 80% warns; at max fails with remediation; `run state` always shows budget
- [ ] `doctor` detects all five classes; `--fix` only mutates stale locks + dead mappings + safe project harness sync
- [ ] `harness.freshnessWarnings=off` does not hide doctor freshness findings
- [ ] `bun test` unit + integration green

---

## Files Touched

| File | Change |
|------|--------|
| `src/lock.ts` | Add `listLocks`, `inspectLock`, `LockEntry` / `LockLiveness` |
| `src/index.ts` | Re-export new lock symbols |
| `src/commands/lock.ts` | **New** — `lock list` / `unlock` adapter |
| `src/commands/lock.handler.ts` | **New** — list/unlock handlers |
| `src/commands/doctor.ts` | **New** — `doctor [--fix]` adapter |
| `src/commands/doctor.handler.ts` | **New** — run registry, exit code |
| `src/doctor/types.ts` | **New** — check/finding/report types |
| `src/doctor/registry.ts` | **New** — builtin check list + summarize/exit helpers |
| `src/doctor/checks/harness-freshness.ts` | **New** — Tier-2 freshness + safe sync fix |
| `src/doctor/checks/locks.ts` | **New** — stale/corrupt/live findings + safe fix |
| `src/doctor/checks/worktrees.ts` | **New** — dead mappings + orphan warns |
| `src/doctor/checks/runs.ts` | **New** — lingering active runs (report-only) |
| `src/doctor/checks/db.ts` | **New** — schema version + integrity (report-only) |
| `src/bin.ts` | Register lock + doctor; text remediation line |
| `src/output.ts` | `remediationFromDetail` / `formatTextError` |
| `src/commands/run-v1.handler.ts` | PLAN_LOCKED detail; step budget; MAX_STEPS remediation; state fields |
| `src/db/schema.ts` | Export `getMaxKnownSchemaVersion()` (or equivalent) |
| `docs/v1/100-architecture.md` | §4a additive remediation line |
| `docs/v2/203-recovery-and-doctor.md` | Status + deferred prompts note |
| `docs/v2/200-overview.md` | Area #3 status if applicable |
| `docs/v2/plan-inputs/01-recovery-and-doctor.plan-input.md` | Generated plan pointer |
| `test/unit/output.test.ts` | Remediation helper coverage |
| `test/unit/lock-list.test.ts` | **New** — inventory / classify |
| `test/unit/commands/lock.test.ts` | **New** — handler-level unlock/list |
| `test/unit/doctor/*.test.ts` | **New** — registry + each check |
| `test/unit/commands/run-step-budget.test.ts` | **New** — threshold + state fields |
| `test/integration/commands/lock-cli.test.ts` | **New** — CLI spawn coverage |
| `test/integration/commands/doctor.test.ts` | **New** — CLI doctor coverage |
| `test/integration/commands/run-step-budget.test.ts` | **New** — record/state/text remediation |

---

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `lock.ts` list/inspect | live / stale / corrupt / empty; no mutation |
| Unit | `lock.handler` | safe unlock; refuse live; force releases + returns holder |
| Unit | `output.ts` | remediation extracted; absent/non-string ignored |
| Unit | step-budget helpers | 79% silent, 80% warns, remaining math |
| Unit | `run-v1.handler` PLAN_LOCKED detail | holder + remediation shape at helper level |
| Unit | doctor summary | warn-only exit 0; fail exit 1 |
| Unit | doctor checks | each check's detect + fix matrix with temp dirs/DB |
| Integration | `lock list` / `unlock` CLI | stdout JSON, text lines, exit 4 on live without force |
| Integration | `run init` PLAN_LOCKED | text remediation line; JSON envelope single object on stdout |
| Integration | `run record` / `run state` | step_budget warnings; state fields always present |
| Integration | `doctor` / `doctor --fix` | five check classes; fix mutates only safe targets; exit codes |
| Edge | doctor freshness | `freshnessWarnings=off` still reports; user-scope not auto-fixed |
| Edge | lingering runs | live lock suppresses warn; fresh active run not flagged |

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
