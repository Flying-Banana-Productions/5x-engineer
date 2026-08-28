# 5x CLI v2 — Recovery & `5x doctor`

**Status:** Implemented
**Date:** July 13, 2026
**Updated:** August 25, 2026
**Part of:** v2 (`200-overview.md`, area #3)
**Shared core used:** `5x doctor` (`200-overview.md` §3.3); surfaces the manifest freshness check (`201-harness-freshness.md` §2.4)
**Implementation plan:** [`docs/development/plans/203-recovery-and-doctor-plan.md`](../development/plans/203-recovery-and-doctor-plan.md)

Shipped: `5x lock list` / `5x unlock [--force]`, additive `PLAN_LOCKED` holder + remediation, step-budget fields and 80% warning, text-mode `→ remediation` line, and `5x doctor [--fix]` with six built-in checks (harness freshness, locks, worktrees, lingering runs, DB health, orphaned prompts). The prompts check fails on open rows whose run is terminal; `--fix` CAS-abandons them with reason `run-terminal` (`205-prompt-queue-foundation-plan.md`).

---

## 1. Problem (delta from v1)

Several failure modes end in a wall: the error is correct, but the user has no self-service path forward.

### 1.1 Locks — the primitives are better than the surface

Corrected against the code: the lock layer (`src/lock.ts`) already handles more than folklore suggests. `acquireLock` **auto-steals** stale locks — dead PID or corrupt file (`lock.ts:131-160`); `releaseLock` is ownership-safe; and `forceReleaseLock()` exists (`lock.ts:237-246`) but is **not exposed by any CLI command**.

The actual gaps:

- **`PLAN_LOCKED` (exit 4) only fires when the holder appears live** — and the error carries no holder info. The user can't see *who* holds it (PID, started-at), whether it's a legitimate concurrent session or a hung process, or what to do. There is no inspect command and no force-release command.
- **"Appears live" over-triggers.** `isPidAlive` treats `EPERM` as alive (`lock.ts:48-63`, conservative but opaque), and PID reuse can make a long-dead lock look live. Both land the user in the no-recovery-path case.
- Locks are **PID-based and per-machine** — worth noting now for forward compatibility (§3).

### 1.2 Silent step ceiling

`maxStepsPerRun` (default 250) is enforced at `run record` time with zero prior signal — no warning as the count approaches the ceiling, no budget surfaced in `run state`. The run dies at step 250 as a surprise (`MAX_STEPS_EXCEEDED`, exit 6).

### 1.3 Remediation dropped in text mode

Error envelopes carry structured `detail` including a `remediation` field (e.g. `run-context.ts:126`, `165-168`). In JSON mode the agent sees it; in `--text` mode the v1 contract collapses errors to a single `Error: <message>` line on stderr (`docs/v1/100-architecture.md` §4a) — the human gets *less* guidance than the machine.

### 1.4 Stale state with no repair path

- Manually-deleted worktrees leave `plans.worktree_path` pointing at nothing; every run-scoped command then fails `WORKTREE_MISSING`. The remediation text is good, but nothing detects the condition proactively or fixes it in one step.
- Runs left `active` after a crashed session linger indefinitely; nothing lists or flags them.
- No CLI introspection of DB health at all — schema version, orphans, inconsistencies require raw `sqlite3`.

---

## 2. Design

### 2.1 Lock surface: expose what the primitives already know

No new lock semantics — new *visibility and control* over existing ones:

- **`5x lock list`** — directory scan of every `*.lock` under `.5x/locks/` (or the control-plane `stateDir` lock dir) via exported `listLocks()`, with plan path, PID, started-at, and liveness verdict (`live` / `stale` / `corrupt`). Listing cannot reuse `isLocked` / `readLockFile`: `isLocked` returns `{ locked: false }` for corrupt files and `readLockFile` is private, so those APIs would hide the files operators need to clear.
- **`5x unlock <plan>`** — safe release: removes the lock iff stale or corrupt (exactly `releaseLock`'s dead-PID path, human-initiated). Refuses on a live holder, showing holder info.
- **`5x unlock <plan> --force`** — exposes `forceReleaseLock()`. Prints the holder it is overriding. This is the escape hatch for hung-but-alive processes, EPERM misreads, and PID reuse. PID-start-time verification is not implemented; `--force` + visible holder is the resolved mitigation.
- **Enrich `PLAN_LOCKED`** — `detail` gains `{ holder: { pid, startedAt }, stale: false, remediation: "If this process is hung, run `5x unlock <plan> --force`." }`. The error itself becomes the recovery documentation.

### 2.2 Step budget visibility

- **Warning band in `run record`.** Past a fixed 80% of `maxStepsPerRun` (`STEP_WARNING_RATIO`), every successful `run record` envelope includes `step_budget: { used, max, remaining }` plus a `warnings: ["…approaching maxStepsPerRun…"]` entry; text mode prints it. The threshold is not configurable in v2.
- **Always in `run state`.** The summary gains `steps_used` / `max_steps` unconditionally — the orchestrating agent can self-pace long runs instead of discovering the wall at 250.
- **Actionable ceiling error.** `MAX_STEPS_EXCEEDED.detail.remediation` names both outs: raise `maxStepsPerRun` (`5x config set …`) or split the work.

### 2.3 Remediation in text mode

Amend the v1 §4a error contract: text-mode errors print

```
Error: <message>
  → <detail.remediation>        (when present)
```

Additive line on stderr for humans; JSON mode unchanged. Coordinated with `205-output-normalization.md` since both touch the §4a contract — this piece is non-breaking and does not need to wait for 205's breaking pass.

### 2.4 `5x doctor`

The front door for "why is this broken, what do I run." A check registry, each check reporting `ok` / `warn` / `fail` + a remediation command, with `--fix` applying the subset of repairs that are safe without judgment.

| Check | Detects | `--fix` action |
|---|---|---|
| `harness-freshness` | Manifest hash mismatch / missing manifest per installed harness+scope (`201` §2.4) | Runs `harness sync` (project scope only — `201` §2.6) |
| `locks` | Stale / corrupt lock files | Removes them (same safety as `5x unlock`); live locks reported, never auto-removed |
| `worktrees` | `plans.worktree_path` pointing at a missing/unreadable dir; worktrees on disk with no mapping | Clears dead mappings (equivalent of `worktree detach`); orphan dirs *reported only* — deleting user files is never a `--fix` |
| `runs` | Runs `active` beyond 24h (`LINGERING_RUN_AGE_MS`) with a dead/absent lock | Reported only; suggests `5x run complete --run <id> --status aborted` / `run reopen` — terminal status is a judgment call |
| `db` | Schema version vs CLI expectation; integrity check | Suggests `5x upgrade`; never auto-migrates |
| `prompts` | Open prompt rows (`202` §3.2) whose run is terminal — orphaned waits | `--fix` calls `abandonPrompt(id, "run-terminal")`; finding identity is `detail.promptId` |

Semantics:

- **`--fix` fixes only what has exactly one correct answer.** Stale lock → remove. Dead worktree mapping → clear. Anything requiring judgment (terminal status of a run, deleting directories, migrations) is surfaced with the command to run, never executed.
- **Exit code:** 0 unless any finding has status `fail`. Warn-only results (live locks, lingering runs, user-scope freshness) exit 0 — no distinct warn exit code.
- **Output:** standard envelope; text mode gets a custom formatter (per-check line + remediation) — this command exists primarily for humans.
- **`doctor` and `lock list` both ship.** Doctor is the full sweep; `lock list` answers the targeted question. `unlock` is top-level (`5x unlock`).
- **Plugin-contributed checks are deferred.** The registry array is the extension point; v2 ships the six builtins above.

---

## 3. Forward compatibility

Per `200-overview.md` §3a:

- **PID-based liveness is a local-machine concept.** `isPidAlive` cannot answer for an agent running in a LAN/cloud provider container. When remote invocation lands, lock-holder liveness should route through the **opaque invocation handle** registry (`202-control-plane.md` §3.6) rather than growing remote-PID hacks. v2 keeps PID checks (correct for everything v2 ships) but confines them behind the existing `lock.ts` seam so the liveness predicate is swappable.
- **`doctor` checks local materializations.** Locks, worktrees, manifests, and the local DB are per-machine state; `doctor` is correct to check them locally forever. Checks that touch synced state later (`runs`, `prompts`) will read through the store interface (`202` §3.1) like everything else — no doctor-specific guard needed.

---

## 4. Migration / compatibility

Fully additive: new commands (`doctor`, `unlock`, `lock list`), enriched error `detail` payloads (existing fields untouched), new optional envelope fields (`step_budget`, `warnings`), one extra stderr line in text-mode errors. No breaking changes; no schema migration beyond what `202` already introduces.

---

## 5. Resolved decisions

Recorded from the implementation plan so this design doc no longer carries open TODOs:

- Warn-only doctor results exit 0 (no distinct warn code).
- `doctor` and `lock list` both ship.
- Lingering-run age is 24h (`LINGERING_RUN_AGE_MS`).
- PID reuse: `--force` + visible holder (no start-time check).
- Step-warning threshold is fixed at 80% (`STEP_WARNING_RATIO`).
- Plugin-contributed checks are deferred.
