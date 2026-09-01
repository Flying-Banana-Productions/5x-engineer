# Review: Git-Native Run Records and Progress Resolution

**Review type:** `docs/development/plans/212-git-native-run-records-plan.md`  
**Scope:** Git-tracked run records, SQLite projection, ref-based progress, indexing, and backfill.  
**Reviewer:** Staff engineer (correctness, reliability, worktree behavior, operability)  
**Local verification:** Not run (static plan and implementation review)

**Implementation plan:** `docs/development/plans/212-git-native-run-records-plan.md`  
**Technical design:** `docs/v2/207-state-segmentation.md`

## Summary

The plan is unusually thorough: it preserves the control-plane boundary, defines a shared contract before the parallel budget consumer, retains idempotency, and provides meaningful unit and real-git integration coverage. However, its proposed context factory uses the control-plane-resolved absolute `paths.records` directly even when the run executes in a linked worktree. That writes and stages records in a different checkout than the code commit, breaking the central durable-record guarantee. It also needs an on-disk transaction/recovery design for mixed-stream appends and a defined policy for records roots outside the repository.

**Readiness:** Not ready — correct worktree materialization and crash-safe mixed-stream atomicity must be specified before implementation.

---

## Strengths

- Freezes the path-agnostic `RecordStore` and memory contract before slice 06 consumes it.
- Preserves existing step identity and makes record-first projection/recovery explicit.
- Specifies ref ancestry pruning, divergence reporting, no implicit fetches, and fixtures for the important ref topologies.
- Includes redaction, scoped dirty-tree handling, `.gitattributes`, backfill disagreement behavior, and doctor/index recovery.

---

## Production readiness blockers

### P0.1 — Records root is not re-rooted to the run's effective worktree

**Action:** `auto_fix`

**Risk:** Phase 4.3 constructs `createWorkingTreeRecordStore({ recordsRoot: config.paths.records })`, but existing `resolveDbContext` resolves config paths against the control-plane root. For a `run init --worktree` run, `resolveRunExecutionContext` deliberately executes commits in the linked worktree while the proposed store writes under the main checkout. `5x commit` would stage the worktree-relative records directory, so the phase commit omits the actual record files (or stages an unrelated path).

**Requirement:** Define and use one helper that converts a repository-relative configured records root into the run effective worktree's corresponding absolute path. Use it for `run init`, all record writers, seal dirty checks/commits, and commit staging. Preserve the canonical repository-relative path separately for git pathspecs and resolution. Add an integration test using `run init --worktree` that proves `run.json` and a recorded step are written in the linked worktree and included in that worktree's `5x commit`.

---

### P0.2 — Multi-file `atomicAppend` has no crash-recovery transaction

**Action:** `auto_fix`

**Risk:** The Phase 3 algorithm renames each affected stream independently and rolls back only when code throws. A process kill, power loss, or failed rollback between the `steps.jsonl` and `budget.jsonl` renames leaves slice 06 with exactly the orphaned reviewer step or budget snapshot that `atomicAppend` is intended to prevent. The record is authoritative, so SQLite reindex cannot infer or repair the missing counterpart safely.

**Requirement:** Specify a durable per-run transaction journal (including before-images or staged file names and commit marker), recovery on every store open/read/append, and cleanup only after all stream replacements are durable. Recovery must restore the pre-batch state or finish the entire batch deterministically. Add fault-injection integration tests for interruption after each file replacement and during recovery; assert no visible partial mixed-stream batch remains.

---

## High priority (P1)

### P1.1 — An external `paths.records` is permitted even though core operations require a git path

**Action:** `auto_fix`

Phase 2 only warns and skips `.gitattributes` when `paths.records` is outside the repository, but Phases 4–7 subsequently require a repository-relative path for staging, `git show`, ref resolution, and backfill. This configuration silently produces non-portable records and makes progress resolution impossible. Validate `paths.records` as inside the repository for this feature (with a clear configuration error), or explicitly disable all git-native record behavior; the former matches the stated git-tracked contract. Cover absolute-inside and absolute-outside configurations.

### P1.2 — The JSONL codec signature cannot reconstruct its declared line type

**Action:** `auto_fix`

`RecordLine` requires `runId`, while the documented on-disk JSONL object intentionally omits `run_id` and `decodeJsonlFile(text)` receives neither a run id nor a directory. The plan must change the decoder to accept `runId` from its caller (or include and validate `run_id` on disk) and add coverage for decisions and budget lines, not only step payloads.

---

## Readiness checklist

**P0 blockers**
- [ ] Re-root all record I/O and record staging to the effective linked worktree while retaining canonical repo-relative git paths.
- [ ] Add durable recovery semantics and interruption tests for mixed-stream `atomicAppend`.

**P1 recommended**
- [ ] Reject or explicitly disable unsupported records roots outside the repository.
- [ ] Make the JSONL decode API capable of restoring `RecordLine.runId`.
