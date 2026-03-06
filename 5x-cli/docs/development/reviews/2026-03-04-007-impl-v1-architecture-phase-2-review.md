# Review: 007 impl v1 architecture (Phase 2)

**Review type:** commit `13708be2fba76360f907a65eab28ee5f9ade698c`
**Scope:** Phase 2 DB migration v4 (`runs` rebuild + new `steps` table), new v1 DB operations (`operations-v1.ts`), and db test updates; includes follow-on commits (none).
**Reviewer:** Staff engineer
**Local verification:** `bun test test/db` (83 pass)

## Summary

Phase 2 largely matches the implementation plan: v4 migration introduces `steps`, migrates v0 tables into step rows (including the `:{result_type}` qualifier), rebuilds `runs`, drops v0 tables, and adds a coherent step-based ops surface with solid unit coverage.

The major gap is integration/rollout safety: the repo still registers v0 commands (`plan`, `plan-review`, `run`) and exports v0 DB ops in `src/index.ts`, but schema v4 deletes the tables those paths depend on. On a fresh DB, running those commands will migrate to v4 then crash with `no such table: run_events/agent_results/...`.

**Readiness:** Not ready — v4 schema break is not paired with a CLI/public-API cutover strategy.

## Strengths

- v4 migration uses table-rebuild pattern for `runs` and preserves `started_at`/`completed_at` semantics via `created_at`/`updated_at` mapping.
- Correct `agent_results` migration keying: `step_name = "{role}:{template}:{result_type}"` prevents status/verdict collisions.
- Good coverage of both fresh DB and v3->v4 migration scenarios in `test/db/schema-v4.test.ts`.
- Step ops are small, testable, and align to planned primitives (`recordStep`, pagination via `tail`/`sinceStepId`, summaries).

## Production Readiness Blockers

### P0.1 — v4 migration breaks v0 CLI commands still registered

**Risk:** `5x plan`, `5x plan-review`, `5x run` call v0 ops that write/read `run_events`, `agent_results`, `quality_results`, `phase_progress`. After v4 migration drops those tables, these commands will fail at runtime (likely mid-run), leaving locks/state unclear and making the CLI unusable for existing workflows.

**Requirement:** Decide and implement a cutover strategy before merging v4 to a shared branch:

- Option A: land v1 commands (or a minimal compatibility layer) in the same PR as schema v4, and switch `src/bin.ts` registration to v1.
- Option B: keep v0 tables (or add compatibility views) until v0 commands are removed.
- Option C: hard-disable v0 commands when schema version >= 4 with a clear error that points to the new command set.

### P0.2 — Public API exports still expose v0 DB ops that are invalid on v4

**Risk:** `src/index.ts` continues to export `appendRunEvent`, `upsertAgentResult`, `upsertQualityResult`, etc. With schema v4 these functions will throw on first use; downstream consumers will break with confusing runtime SQL errors.

**Requirement:** Either remove/rename these exports as part of the v4 cutover, or make them fail fast with a targeted error message that explains the schema incompatibility and points to the replacement API.

## High Priority (P1)

### P1.1 — `status` no longer reflects DB-approved phases

`src/commands/status.ts` currently sets `approvedPhases` to an empty set and falls back to checkbox completion only. In v1, phase approval is tracked via `steps` (`step_name = 'phase:complete'`).

Recommendation: derive approved phases from `steps` for the latest run (or for the active run when present) for the given plan path.

### P1.2 — `computeRunSummary` should guard against NULL phases

`src/db/operations-v1.ts` queries `SELECT DISTINCT phase ...` but does not filter `phase IS NOT NULL`; yet the return type assumes `phase: string`. If a `phase:complete` step is ever recorded with NULL phase, this becomes a latent runtime bug.

Recommendation: add `AND phase IS NOT NULL` and keep types aligned.

## Medium Priority (P2)

- `recordStep()` auto-increment is not concurrency-safe: two writers can compute the same next iteration and one insert will be ignored. If multi-process writers are possible, add a retry-on-conflict loop or require callers to provide `iteration` under the plan lock.
- Migration chooses the run to attach `phase_progress` approvals to via `ORDER BY r2.rowid DESC`. If “latest run” should be time-based, use `started_at`/`created_at` semantics instead of rowid.
- Consider `ON DELETE CASCADE` on `steps(run_id)` if `runs` deletion is ever supported (not required if runs are append-only forever).

## Readiness Checklist

**P0 blockers**
- [ ] Define cutover plan for v4 vs v0 commands (keep compat, disable v0, or land v1 commands together)
- [ ] Align public API exports with schema v4 (remove/guard v0 DB exports)

**P1 recommended**
- [ ] `status` derives approvals from `steps` (`phase:complete`) instead of `phase_progress`
- [ ] `computeRunSummary` filters `phase IS NOT NULL` (and updates types/tests accordingly)

## Addendum (2026-03-04) — Review Follow-up for `61858b05834ae3f1ebe61843d57447de25c3eba1`

### What's Addressed

- P0.1 resolved: v0 commands removed from `src/bin.ts` and v0 command entrypoints deleted, so schema v4 can no longer be broken at runtime by legacy paths.
- P0.2 resolved: `src/index.ts` no longer exports v0 agent/orchestrator APIs or v0-only DB ops that target dropped tables; exports are aligned to v4-safe surfaces plus v1 provider + step APIs.
- P1.1 resolved: `src/commands/status.ts` now derives approvals from `steps` (`phase:complete`) and has test coverage.
- P1.2 resolved: `computeRunSummary()` filters `phase IS NOT NULL`.

### Remaining Concerns

- Release/merge readiness: this change removes `5x run`/`5x plan`/`5x plan-review` without adding v1 replacements yet. This is OK for a feature branch mid-migration, but would be a breaking change if merged/released before Phase 4/5 land.
- Dead-but-dangerous code remains: `src/db/operations.ts` still contains v0-only functions that reference dropped tables (even if no longer exported/used). Consider deleting or making them fail fast with an explicit schema/version error if accidentally imported by path.
- Previously-noted P2 items remain unchanged: `recordStep()` auto-increment race semantics and the migration’s rowid-based “latest run” selection for `phase_progress` attachment.

## Addendum (2026-03-04) — Review Follow-up for `98f072d5874477353e8e02b2ad551915cc0cf9bd`

### What's Addressed

- Prior addendum concern resolved: v0-only DB ops referencing dropped tables were removed from `src/db/operations.ts` (only v4-safe plan/run/reporting helpers remain).
- P2 items were clarified in-code:
  - `src/db/operations-v1.ts` documents the `recordStep()` auto-increment race and the single-process assumption.
  - `src/db/schema.ts` documents why rowid is used to pick the "latest run" when migrating approvals.
- Public API adjusted: `src/index.ts` now exports `getRunMetrics`/`RunMetrics` from `src/db/operations.ts`.

### New / Remaining Concerns

- Release/merge readiness remains the main human decision: the CLI surface is still intentionally minimal (`status`/`init`/`worktree`) until v1 command replacements land.
- The rowid "clock skew immunity" rationale is fine, but it codifies the semantic choice; if the desired behavior is actually "most recent active run" or "most recent by created_at" then this migration logic will need revisiting.
