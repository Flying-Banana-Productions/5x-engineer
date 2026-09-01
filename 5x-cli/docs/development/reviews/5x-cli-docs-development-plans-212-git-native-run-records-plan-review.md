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

---

## Addendum (August 31, 2026) — Revision 1.1 re-review

**Reviewed:** `d7c02f4d368b16f6ab9e8745c14ca9e28d221626`

### What's addressed (✅)

- **P0.1 — Effective-worktree record placement:** **Addressed.** `resolveRecordsRoot` cleanly separates the canonical repository-relative path from the worktree-absolute write path, and the plan applies it to init, writers, staging, sealing, backfill, prompts, and doctor. The linked-worktree integration case directly verifies the prior failure mode.
- **P1.1 — Outside records root:** **Addressed.** Configuration now rejects both absolute and escaping relative roots outside the repository, with explicit coverage.
- **P1.2 — JSONL run identity:** **Addressed.** The decoder now accepts the directory-derived run id, validates mismatches, and has stream-wide coverage.

### Partially addressed

- **P0.2 — Crash-safe mixed-stream `atomicAppend`: Partially addressed.** The journal, staged before-images, commit marker, recovery paths, and fault injection are a substantial improvement. However, the stated power-loss guarantee is not durable as written: file `fsyncSync` alone does not persist the directory entries created, renamed, or removed by the transaction. In addition, treating a corrupt/unreadable journal as `prepared` is unsafe when replacements may already have occurred after the commit marker; it can silently expose or preserve a partial batch.

### Production readiness blocker

### P0.3 — Journal commit/recovery protocol is not power-loss durable

**Action:** `auto_fix`

**Risk:** After the commit marker or any `.new` replacement, a power loss can lose rename/create metadata unless the run directory is fsynced. Recovery can then see a committed journal with missing staged data. More critically, Phase 3.2 says a corrupt journal is treated as `prepared`, even though one or more original stream files may already have been replaced. Deleting journal artifacts in that state does not restore the pre-batch files and violates the promised all-or-nothing view.

**Requirement:** Make the journal state transition and every create/rename/unlink durability boundary explicit: fsync the run directory after durable journal creation/commit-marker replacement, after each stream rename, and after cleanup. Preserve recoverable transaction metadata in an immutable prepared record plus a separately durable, checksummed commit marker (or equivalent redundant design). If recovery metadata is corrupt or incomplete, fail closed with a dedicated record-transaction corruption error and doctor finding; never assume `prepared` and delete artifacts. Add fault-injection coverage for a corrupt/torn commit marker and directory-sync failure/interrupt points.

### Updated readiness

- **Plan completion:** ⚠️ — prior worktree, configuration, and codec blockers are resolved; the journal requires one more durability revision.
- **Ready for next phase:** ⚠️ — after P0.3 is specified and tested.

---

## Addendum (August 31, 2026) — Revision 1.2 re-review

**Reviewed:** `79b47839c1a87d49062d02571d19e76da1ed01ba`

### What's addressed (✅)

- **P0.3 — Journal commit/recovery durability:** **Addressed.** The revision adds directory fsync boundaries for every metadata mutation, separates immutable prepared metadata from the checksummed commit marker, fails closed on corrupt metadata, preserves artifacts, and adds targeted fault-injection and doctor coverage. This fully resolves the prior directory-durability and unsafe-corrupt-journal findings.

### Production readiness blocker

### P0.4 — RecordStore has no cross-process writer exclusion

**Action:** `auto_fix`

**Risk:** `atomicAppend` uses fixed per-run `.txn.*` names but specifies no mutual exclusion. Two CLI processes can concurrently append different records for the same run (notably a run-scoped prompt answer and a normal step writer). The second process can recover/delete the first process's prepared transaction or overwrite its staging files; both can read the same old stream and last-writer-wins a replacement. This loses authoritative events and invalidates the atomicity claim.

**Requirement:** Add a store-internal, cross-process per-run writer lock acquired before recovery/read/stage and held through directory-synced cleanup. It must distinguish a live owner from a crashed owner and recover only abandoned transactions; do not let a concurrent caller recover an active prepared transaction. Define bounded wait/error behavior, release/durability semantics, and ensure all writer paths (including prompt decision snapshots) use it. Add a multi-process integration test that concurrently appends distinct step/decision or step/budget operations to one run and proves both records survive without journal corruption or loss.

### Updated readiness

- **Plan completion:** ⚠️ — P0.3 is resolved, but the new writer-concurrency gap blocks the authoritative record design.
- **Ready for next phase:** ⚠️ — after P0.4 specifies and tests per-run cross-process serialization.

---

## Addendum (August 31, 2026) — Revision 1.3 re-review

**Reviewed:** `76216de098a490b87b09986bf312d1b4beff46fb`

### Partially addressed

- **P0.4 — Cross-process writer exclusion: Partially addressed.** The revision correctly centralizes a per-run lock around recovery, read, write, cleanup, prompt snapshots, and adds liveness, stale-lock, and multi-process test coverage. However, the lock publication itself has a fatal acquisition race.

### Production readiness blocker

### P0.5 — A contender can steal a live lock while its metadata is being written

**Action:** `auto_fix`

**Risk:** `openSync(lock, "wx")` makes an empty lock pathname visible before the successful writer writes and fsyncs `{ pid, owner }`. A second process that observes this normal in-progress state is directed to classify the unreadable/empty lock as abandoned and unlink it. The first process then continues believing it owns the lock while the second acquires the pathname, allowing concurrent fixed-name journal writes and record loss.

**Requirement:** Publish a fully written, fsynced lock record atomically rather than exposing an empty `wx` lock. For example, create a unique temporary lock record containing the owner metadata, fsync it, atomically hard-link it to `.txn.lock` (link succeeds only if the destination does not exist), fsync the run directory, then remove the temporary file. On a malformed visible lock, never immediately steal it merely because its metadata is unavailable; use a protocol that can establish abandonment safely. Add deterministic fault-injection/multi-process coverage that pauses the first acquirer after the exclusive creation attempt and before metadata publication; the contender must not obtain the lock or reach journal recovery.

### Updated readiness

- **Plan completion:** ⚠️ — writer serialization is substantially designed but lock publication remains racy.
- **Ready for next phase:** ⚠️ — after P0.5 makes lock acquisition atomically publish owner metadata and proves the creation-window race is closed.

---

## Addendum (August 31, 2026) — Revision 1.4 re-review

**Reviewed:** `223de9c45f69c1481df05f8c07331542dd6cc67b`

### What's addressed (✅)

- **P0.5 — Atomic lock publication:** **Addressed.** A complete owner record is written and fsynced to a unique temporary file before `linkSync` atomically publishes `.txn.lock`; the lock pathname is therefore never an empty in-progress file. The plan explicitly rejects a `wx` fallback, delays malformed-lock stealing for the full timeout, keeps recovery behind the acquired lock, and supplies deterministic creation-window plus multi-process coverage.

### Remaining concerns

- No new blocking issues identified in revision 1.4.

### Updated readiness

- **Plan completion:** ✅ — all prior P0/P1 findings are addressed with implementable algorithms and targeted tests.
- **Ready for next phase:** ✅ — ready for implementation.

---

## Addendum (September 1, 2026) — Revision 1.5 origin-attribution re-review

**Reviewed:** `9acb8a04d88cafef8195c7dda87d56b821b9bd69`

The line-level envelope, user-scope installation identity, crash-safe record store, and explicit slice-06 budget-stream intent are strong improvements. The revision does not yet provide a complete or privacy-safe attribution contract across all required writers and summary/backfill cases.

### Production readiness blockers

#### P0.6 — Backfill misattributes unknown run creators and sealers

**Action:** `auto_fix`

**Risk:** The plan correctly gives each backfilled JSONL line `origin: null` plus an exporter `materializer`, but `RunRecordSummary.creator` is non-nullable and Phase 7 sets both `creator` and (for terminal runs) `sealer` to the exporting installation. Those fields are defined as the recorder at init/seal, so this asserts that the exporter created and sealed historical runs even while the text acknowledges both facts are unknown. This defeats the stated honest-origin rule for the run-summary attribution that users will inspect.

**Requirement:** Make unknown historical summary attribution representable (for example nullable/omitted `creator` and `sealer` plus a distinct summary materializer/exporter field, or explicitly versioned summary-attribution states). Preserve a known live creator across sealing; never substitute the exporter for an unknown historical creator/sealer. Add backfill, decode, index, and text/JSON-output tests proving legacy summaries remain unknown while the exporter is separately identifiable.

#### P0.7 — Agent performer metadata has no defined data path into the record append

**Action:** `auto_fix`

**Risk:** Phase 4 requires `invoke --record` to emit `{ kind: "agent", role, provider }`, but the shown `RunRecordParams`, `PreparedRecordStep`, and `recordStepInternal` context carry no performer or invocation metadata. The proposed `originFor(performer)` factory cannot infer an invocation from the existing step parameters. The generic path will consequently default these lines to `{ kind: "system", role: "cli" }` or force an ad-hoc bypass, losing the principal new attribution guarantee.

**Requirement:** Freeze a typed performer/origin input path through `RunRecordParams` or the record context and through `prepareRecordStepAppend`/`recordStepInternal`; specify who supplies it for direct `run record`, protocol validation, invoke, quality, commit, terminal, prompt, and slice-06 baseline/snapshot writes. The shared factory must be the only origin constructor. Add integration assertions for author and reviewer invoke records that retain the configured provider/role, alongside system and human cases and the paired step/budget origin equality case.

### High priority

#### P1.3 — `records.redact` is not guaranteed for every persisted attribution surface

**Action:** `auto_fix`

**Risk:** The normal step flow explicitly calls `redactOrigin`, but prompt snapshots and the slice-06 instructions call `recordedEnvelope(ctx.originFor(...))` without defining whether `originFor` redacts. `run.json` writes `creator`/`sealer` as `RecordRecorder`, outside `redactOrigin` entirely. A project opting into `records.redact = ["origin.actor"]` can therefore still commit its actor label through decisions, budget records, or run summaries.

**Requirement:** Define `originFor` as the sole, already-redacted origin/recorder factory (including forbidden-key stripping), or explicitly apply a shared redactor at every writer and summary write. Cover steps, decisions, all budget operations (including baseline-only), and `run.json` creator/sealer for configured, environment, and identity-file actor sources. Assert that `installation_id` and performer kind remain intact and that no forbidden identity fields can survive on any surface.

#### P1.4 — Forward-compatible `run.json` parsing silently loses newer fields on seal/rewrite

**Action:** `auto_fix`

**Risk:** Phase 3 accepts `format_version > 1` and ignores unknown fields, yet `RunRecordSummary.format_version` is typed as literal `1` and `putRun` is documented to replace the whole summary with the v1 typed object. An older CLI can therefore successfully open a newer summary and then erase its additive fields during `run complete` or any rewrite. This is neither safe forward compatibility nor a fail-closed downgrade policy.

**Requirement:** Choose and specify one consistent policy: preserve the raw unknown fields/version through summary read-modify-write, or reject newer `format_version` summaries for mutation while allowing a read-only compatible view. Align the TypeScript types and tests with that choice; include a newer-version summary followed by a seal/rewrite and verify no future field is lost (or that mutation fails without changing the file).

### Updated readiness

- **Plan completion:** ⚠️ — earlier durability and worktree blockers remain resolved, but origin attribution is incomplete for invoked agents and backfilled summaries, with actor redaction and run-summary compatibility gaps.
- **Ready for implementation:** ⚠️ — after P0.6 and P0.7 are specified; P1.3 and P1.4 should be resolved in the same revision because they affect the newly frozen attribution/schema contract.

---

## Addendum (September 1, 2026) — Revision 1.6 origin-attribution re-review

**Reviewed:** `d76eca30c949978c74113aa31f6e9e0c940a6c67`

### Prior-issue disposition

- **P0.6 — Unknown creator/sealer versus exporter materializer: Addressed.** `RunRecordSummary` now represents unknown `creator`/`sealer` as `null`, retains a separate summary `materializer`, and specifies backfill, decode, index, and output coverage. Live sealing preserves a known or null creator rather than replacing it with the exporter.
- **P0.7 — Typed invoke performer path: Partially addressed.** The revised shared plan adds `RunRecordParams.performer`, carries it through preparation, defines producer values for direct, protocol, invoke, quality, commit, terminal, and prompt paths, and requires paired live step/budget origins. However, the parallel consumer plan (`208` §6.2) still defines its review-budget context without `originFor` and its independently shown prepared-result shape has no performer. The slice-06 production wrapper therefore has no compatible specified way to meet this plan's required agent-origin wiring.
- **P1.3 — Redaction across streams and summaries: Addressed.** `originFor`/`redactedRecorder` are now explicit sole constructors, cover lines, baseline-only budget writes, and summaries, and are backed by actor-source and forbidden-key test cases.
- **P1.4 — Safe newer `run.json` handling: Partially addressed.** The read-only compatible view plus `UNSUPPORTED_FORMAT_VERSION` prevents a v1 `putRun` rewrite from erasing future fields. The terminal completion sequence still performs its terminal-step write before checking the summary format, so a rejected completion can mutate `steps.jsonl` while leaving the newer summary and SQLite run active.

### Production readiness blockers

#### P0.8 — Slice-06 budget writer contract is not coordinated with the new origin API

**Action:** `auto_fix`

**Risk:** Revision 1.6 makes `ctx.originFor(performer)` mandatory for every slice-06 snapshot and baseline append, but `208-review-budget-advisory-plan.md` still specifies a context containing only `{ db, config, controlPlane, recordStore, store }` and a prepared admission result containing only `stepInput`/`maxSteps`. It neither receives `originFor` nor retains the caller's performer. Implementing each approved plan literally either leaves budget records without the required envelope or causes slice 06 to fork/construct origin despite the Phase 1 freeze.

**Requirement:** Make a coordinated update to the slice-06 plan before the Phase 1 interface is tagged: its shared context must consume the same record context/origin factory, its prepared result must retain the resolved performer (or receive it as an explicit wrapper input), and baseline-only plus paired step/snapshot writes must use that value. Add cross-slice contract coverage for invoke reviewer step + budget snapshot and baseline-only appends, including origin equality and actor redaction.

#### P0.9 — Unsupported future summaries can receive a terminal step before completion fails

**Action:** `auto_fix`

**Risk:** Phase 4.5 directs `run complete` to call `recordStepInternal` for `run:complete`/`run:abort` and only then discusses rejecting `getRun().format_version > 1`. The proposed failure preserves `run.json` bytes but can leave a new terminal step line (and possibly dirty records) beside an active SQLite run. This violates the stated read-only/fail-closed policy and makes a retry ambiguous.

**Requirement:** Read and version-check the run summary before any terminal record append, SQLite mutation, seal commit, pointer clear, or lock release. On `UNSUPPORTED_FORMAT_VERSION`, leave both `run.json` and every stream byte-identical, keep the run active, and surface a deterministic remediation. Extend the planted-v2 integration test to assert no `run:complete`/`run:abort` line, no SQLite status change, and no seal commit.

### Updated readiness

- **Plan completion:** ⚠️ — P0.6 and P1.3 are resolved; the generic P0.7 and P1.4 remedies are sound but need the slice-06 coordination and pre-append future-version guard above.
- **Ready for implementation:** ⚠️ — after P0.8 and P0.9 are addressed.

---

## Addendum (September 1, 2026) — Revision 1.7 cross-slice origin re-review

**Reviewed:** `fdaa4d6a5b87a628e029f1734524b290663dd454`

### Prior-issue disposition

- **P0.8 — Slice-06 writers consume the shared origin factory and retain performer metadata: Addressed.** The coordinated 212 §1.5 / 208 §6.2 contract now embeds `createRecordContext`, preserves `PreparedRecordStep.performer`, requires an already-redacted origin on baseline capture, and uses one `originFor(prepared.performer)` result for both reviewer step and snapshot. The new cross-slice unit and integration cases cover provider/role, equality, baseline-only behavior, and redaction.
- **P0.9 — Future `run.json` is rejected before terminal mutation: Addressed.** The binding order checks the record summary before preparing or appending a terminal step, changing SQLite state, committing, clearing the pointer, or releasing the lock. The planted-v2 cases now assert stream bytes, SQLite state, commit history, lock, and pointer are unchanged.

### New blocker

#### P1.5 — Slice-06 Phase 6 now depends on slice-10 Phase 4, but the phase graph still permits it after only Phase 1

**Action:** `auto_fix`

**Risk:** The new 208 `ReviewBudgetCommandContext` calls `createRecordContext`, which 212 does not create until Phase 4. Yet 208's dependency/timeline still says every persistence and record path from Phase 4 onward is blocked only on 212 Phase 1, and Phase 6 is described as runnable after 208 Phase 4. Consequently a team following the approved phase graph can start 208 Phase 6 against a non-existent context factory, or is forced to add a forbidden local substitute. Calling the Phase-4 factory shape part of the Phase-1 freeze does not make its implementation available.

**Requirement:** Preserve the Phase-1 interface freeze while making the implementation dependency explicit in both plans: 208 Phases 4–5 may use `RecordStore`/fixture origins after 212 Phase 1, but 208 Phase 6+ production record wiring (including `createReviewBudgetContext`, `originFor`, and baseline capture hooks) must wait for 212 Phase 4 to merge. State this in each phase gate/timeline and add a sequencing test or build boundary showing Phase-4 facade tests require no `createRecordContext`, while Phase-6 wiring does.

### Updated readiness

- **Plan completion:** ⚠️ — P0.8 and P0.9 are fully addressed; the new shared context introduces an unrecorded cross-slice implementation dependency.
- **Ready for implementation:** ⚠️ — after P1.5 phases the `createRecordContext` dependency explicitly.
