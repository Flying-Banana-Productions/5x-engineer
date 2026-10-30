# Review: Plan 216 Phase 3 — Migration commands and records

**Review type:** `2278a7348fd9fd6a6544b6fa609a8c883c00082d..2dec16d6aa863d32363a0d471ad2335c4384223e` (commit `2dec16d6`)  
**Scope:** Governance-context range, excluding the plan, reviews, and run records. Covers `src/review-governance/schema-migration.ts` (new), `src/commands/plan-migrate.handler.ts` (new), the `plan migrate` and `review migrate-schema` registrations, the `plan-schema-migration` codec and keys in `record-lines.ts`, the lineage fold and `listPlanSchemaMigrations` in `review-budget-store.ts`, subject resolution, the governed-plan check, and source-migration bind in `implementation-state.ts`, the lineage type changes in `implementation.ts`, `implementation-boundary.ts`, and `implementation-review-context.ts`, and the three new test files.  
**Reviewer:** Staff engineer (record and lineage correctness, idempotency and concurrency, fail-closed behavior, plan compliance, test coverage)  
**Local verification:** `bunx tsc --noEmit` clean. `bun run lint` clean (462 files). Focused suites (`schema-migration`, `migrate-schema`, `plan-migrate`): 17 pass, 0 fail. Full `bun run test`: 4014 pass, 0 fail.

**Implementation plan:** `5x-cli/docs/development/plans/216-plan-schema-contracts-and-migration-plan.md` (approved at `4018531a`), Phase 3, work items W1–W4 (this phase is W3)  
**Technical design:** N/A

## Summary

Phase 3 adds the `plan-schema-migration` lineage record, the pre-approval `5x plan migrate` command, and the recorded `5x review migrate-schema` transition. It also changes bind to pick up a migration recorded on an approved source run. The diff, digest, authority rules, and fold follow the plan closely. Tests cover the motivating status-sentence recovery end to end, retry and conflict ordering, stale digests, decisions in `expectedKeys`, the `run:complete` fold invariance, and source-migration bind. In the plan this phase belongs to work item W3.

I found two P1 defects. First, `migrate-schema` captures its `expectedKeys` after it has read the migration subject and awaited a git read. The precondition therefore cannot detect a competing migration or lineage write that lands in that window. Second, the command refuses to migrate an execution run whenever its source run has any migration. The plan names that run as the operator's path when a source migration did not attach to an existing binding. Neither defect makes the run read a plan under the wrong authority. Both can leave a run permanently unable to migrate, because records are append-only. I also found one P2 cosmetic item in `plan migrate --mode selective`.

**Readiness:** Not ready. Two P1 auto-fix items remain. Both fixes are mechanical and follow existing patterns, and the rest of the phase meets its gate.

---

## What shipped

- **Payload and codec** (`record-lines.ts`): `PlanSchemaMigrationPayload` matches the §3.1 interface exactly. It has no `currentText`, no `snapshotId`, and no reviewer authority. The decoder rejects other versions, any transition other than 0→1, and any authority other than `verified_equivalent` or `operator`. Idempotency keys are `budget:plan-schema-migration:${runId}:${digest}` and a digest-qualified `schema-migration` step key.
- **Lineage fold** (`review-budget-store.ts`): `listImplementationTextAmendments` returns text amendments, frontier recoveries, and migrations in journal order, filtered by binding. Unknown kinds are still skipped. `listPlanSchemaMigrations` reads one run's migrations. Callers that use guard fields (`verifyAuthorTextAmendment` and `planAmendmentCount`) narrow the migration kind out.
- **Diff and digest** (`schema-migration.ts`): approved schema 0 lines are diffed against target `governingLines` with an earliest-match LCS. Exclusion ids are `L<approved line>`. `nonGoverningText` holds the target's non-governing raw lines. In equivalent mode only, the trailing-newline allowance applies. The digest is canonical JSON with sorted keys, built from `runId`, both blob hashes, the parent lineage id, the `{ id, approvedTextHash }` list, and `nonGoverningTextHash`.
- **`review migrate-schema`**: requires a full sha that resolves exactly. It resolves a bound execution subject (replayed authorized bytes from the pre-migration prefix) or an approved source subject (the approved commit blob). On a bound run, and on a source run with a linked worktree, the worktree must match the commit exactly. The command returns an identical stored migration before any conflict refusal, refuses distinct second migrations, checks ledger deep-equality, and enforces the equivalent and selective authority rules. It writes the budget record and the `schema-migration` step in one `atomicAppendIfAllNew` call, with steps, budget, and decisions keys. `completionAuthorized: false` is always returned, and the receipt omits `authorizedPlanBytes`.
- **Source bind** (`implementation-state.ts`): `resolveSourceSchemaMigration` replays the source-run migration, rereads `afterCommit`, and checks the blob, `governingHash`, and ledger. The new binding gets `planSchema: 1`, `governingHash`, `schemaMigrationId`, `predecessorPlanCommit`, and `approvedPlanCommit = afterCommit`. The source snapshot and baseline ids are unchanged.
- **`plan migrate`**: refuses when any run for the plan path has a binding or a completed approval, and names `5x review migrate-schema`. Equivalent mode wraps the file and is idempotent on an exact wrap. Selective mode validates schema 1 and reports the non-governing lines. Neither mode writes a record.

---

## Strengths

- **Retry and conflict ordering match the plan.** The identical-retry lookup runs before the schema 1, existing-migration, and ledger refusals. The unit and integration tests show a retry after success returns the stored winner (`created: false`, same id), even when the binding reads schema 1.
- **The fail-closed behavior is real.** A migrated run with deleted markers is `PLAN_SCHEMA_INVALID` with "not a legacy fallback", at both the drift and admission layers. A migration record with an invalid schema 1 target does not install. A schema 0 run that never migrates still drifts on a status edit.
- **The earliest-match diff is deterministic.** It walks a single suffix-LCS table, so repeated blanks always get the same `L<n>` ids. The test asserts `L3` for the extra blank line. Checks I ran for LF, no trailing newline, CRLF, and a double trailing newline all give zero exclusions and zero insertions on the equivalent wrap.
- **Raw identity is preserved.** `authorizedPlanBytes` is the committed raw blob, `beforeBlobHash` is the replayed raw hash, and replay validates the hash linkage and the target projection hash. The binding is never rewritten, and the integration test shows `approvedPlanCommit`, the snapshot and baseline ids, the ledger, and the `author:implement` steps unchanged after migration.
- **The source-run step shape is proven safe.** A test shows a `schema-migration` step appended after `run:complete` leaves `foldGoverningReviewState` and the subsequent bind unchanged.

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1 — `expectedKeys` is captured after the subject read, so the precondition misses concurrent migrations and lineage writes

`migratePlanSchema` reads the subject first (`schema-migration.ts:510`, `readSchemaMigrationSubject`). That read produces `migrations`, `sourceMigrations`, `parentLineageId`, and the replayed `sourceBytes`. The function then awaits a git subprocess for the target blob (`:522`). Only after that does `executePlanSchemaMigration` capture the steps, budget, and decisions keys for `expectedKeys` (`:339–344`). Anything appended in between is included in `expectedKeys`, so `atomicAppendIfAllNew` accepts it as the baseline instead of rejecting the attempt.

Concrete failure: operators A and B run `migrate-schema` on the same run with different targets or digests. Both read the subject while no migration exists. B appends. A then captures keys that include B's records, passes the precondition, and appends a second migration with a different idempotency key. `replayTextAmendments` treats a second migration as an invalid chain (`sawMigration`). Every later drift check then reports an unverified lineage, and the run cannot recover by appending more records. The same window lets a text amendment or recovery land between the subject read and the append. The migration then records a stale `parentLineageId` and `beforeBlobHash`, and replay invalidates the chain the same way. A concurrent review decision written during the git read is also not detected. The plan states the purpose of `expectedKeys` directly: "a concurrent review decision invalidates the attempt" and "A different digest competing for the same parent fails with `RECORD_PRECONDITION_FAILED` … The command never applies twice."

**Requirement:** Capture the steps, budget, and decisions key lists before (or atomically with) the reads that build the subject, and pass those lists into `executePlanSchemaMigration`. Recover-plan already follows this pattern: `implementation-recovery.ts:175–181` captures the three streams before it reads `listImplementationTextAmendments`. Alternatively, derive `migrations` and the lineage from the same captured `budget` lines that feed `expectedKeys`. Add a unit test that appends a distinct migration, or a text amendment, after the subject is read but before the append. The test must get `RECORD_PRECONDITION_FAILED` and leave exactly one migration.

### P1.2 — An execution run is refused whenever its source run has any migration, which blocks the plan's path for a pre-existing binding

`executePlanSchemaMigration` refuses with `PLAN_MIGRATION_CONFLICT` when `subject.kind === "execution" && subject.sourceMigrations.length > 0` (`schema-migration.ts:256–259`). `sourceMigrations` comes from `listPlanSchemaMigrations(binding.sourceRunId)`. Bind always applies a valid source migration, so any binding created after a source migration already has `planSchema: 1` and is refused by the `bindingPlanSchema === 1` check. The new clause therefore only affects one case: an execution binding that existed before the source migration was recorded. The plan names that exact case as the operator's path: "A source migration does not silently attach to an execution binding that already exists; the operator runs the command on the execution run." In §3.3, the conflict "the source run already has a migration record" applies when the source run is the subject. That reading is how the plan's own checklist frames it ("an already migrated lineage or source run").

Concrete failure: an execution run binds the schema 0 approval. The operator then migrates the source run, for example to prepare a later execution run. The first execution run's status edit drifts, and `migrate-schema --run <execution>` returns `PLAN_MIGRATION_CONFLICT`. Records are append-only and the source migration cannot be removed, so the drift-blocked run has no migration path. Its only option is `recover-plan`, which is the semantic tool the plan says is wrong for a status edit. No test exercises this ordering. The integration conflict test passes only because the binding there already reads schema 1.

**Requirement:** Remove the `sourceMigrations` clause from the execution-subject conflict check, along with the field if it becomes unused. Keep `bindingPlanSchema === 1` and `migrations.length > 0`. Add a unit test that binds first, then records a source migration, then migrates the execution run, and expects `created: true`. Also assert the source migration did not attach to the existing binding.

---

## Medium priority (P2)

- **P2.1 — `plan migrate --mode selective --write` rewrites identical bytes and reports `wrote: true` with `unchanged: true`.** At `plan-migrate.handler.ts:91–93`, selective mode never transforms the file, yet it calls `writeFileSync(absolute, raw)` and returns `wrote: write`. The output contradicts itself, and the file's mtime changes for no reason. Report `wrote: false` and skip the write, as equivalent mode already does through `write && !unchanged`.

---

## Nonblocking follow-ups

- None. Every observation above is inside the Phase 3 scope.

---

## Plan compliance

| Gate / checklist item | Status |
|---|---|
| Codec and lineage fold, no `currentText`, `snapshotId`, or reviewer authority | ✅ |
| Reject migration whose target is not valid schema 1 | ✅ (replay does not install it; `resolveRecordedPlanSchema` stays 0) |
| Store test: unknown kind skipped, migration folded once | ✅ |
| `plan migrate` registered, refuses governed plans, equivalent `--write` idempotent | ✅ |
| Equivalent proof and selective operator confirmation, no snapshot path | ✅ |
| Motivating status-sentence fixture through admission, same ledger and phase records | ✅ |
| Identical retry before schema 1 refusal; distinct second migration refused, writes nothing | ✅ sequentially; ⚠️ concurrently (P1.1) |
| Stale confirmation writes nothing; changed target rejects old digest | ✅ |
| Repeated blanks give stable ids; `nonGoverningText` equals dry-run text | ✅ |
| Retained governing edit rejected with recover-plan help | ✅ |
| `expectedKeys` includes decisions | ✅ present; ⚠️ captured too late (P1.1) |
| Never-migrated schema 0 still drifts; migrated run with deleted markers is `PLAN_SCHEMA_INVALID` | ✅ |
| `schema-migration` step after `run:complete` leaves the fold unchanged | ✅ |
| Source migration does not attach to an existing binding; operator migrates the execution run | ⚠️ first half ✅, second half blocked (P1.2) |

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 — Capture `expectedKeys` before the subject and lineage reads, and add a race test.
- [ ] P1.2 — Drop the `sourceMigrations` conflict for execution subjects, and add the bind-then-source-migrate test.

**P2**
- [ ] P2.1 — Make selective `plan migrate` skip the identical rewrite and report `wrote: false`.

**Ready for next phase:** ⚠️ After P1.1 and P1.2. Phase 4 (workflow assets) does not depend on these fixes, but the migration skill will document this command's conflict semantics.
