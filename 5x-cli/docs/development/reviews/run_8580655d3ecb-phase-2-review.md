# Review: Invocation Registry Phase 2

**Review type:** `2864161e763f0b3e76304d67a5e95ffaceb58b27`  
**Scope:** Phase 2 schema-v7 migration for the invocation registry, including DDL, indexes, constraints, migration compatibility, and schema tests.  
**Reviewer:** Staff engineer (correctness, architecture, security, performance, operability, test strategy, and plan compliance)  
**Local verification:** `bun test --concurrent --dots` (2,870 pass); focused schema tests (44 pass); `bun run typecheck`; `bun run lint`.

**Implementation plan:** `docs/development/plans/207-invocation-registry-plan.md`  
**Technical design:** N/A

## Summary

The implementation completes the Phase 2 schema-v7 slice with an additive `invocations` table, a required run foreign key, opaque `handle_json`, cancellation and terminal-observation fields, lifecycle consistency constraints, and the two required indexes. It preserves the provider-neutral design by omitting PID and process-group fields, leaves existing tables unchanged, and correctly advances fresh and v6 databases to schema version 7. Focused migration coverage and the full repository test suite pass.

**Readiness:** Ready — Phase 2 completion criteria are met; no corrective actions are required.

---

## What shipped

- **Schema v7:** Additive `invocations` registry table with opaque handles, cancellation metadata, lifecycle status, terminal timestamps, and abandon reason.
- **Integrity and query support:** Run FK, cancellation-pair and terminal-state CHECK constraints, plus run-history and partial live-row indexes.
- **Migration verification:** Fresh, v6-to-v7, FK, required-handle, index, no-PID, and lifecycle-CHECK tests; existing max-version assertions now expect v7.

---

## Strengths

- The DDL precisely follows the planned state model and separates cancellation request, adapter outcome, and terminal observation.
- `handle_json` is required while no universal PID or process-group representation is introduced, preserving adapter ownership boundaries.
- The partial `idx_invocations_live` index limits the stale-row access path to running rows, while the run index supports per-run history lookups.
- The v6 upgrade test retains prompt data, demonstrating that the migration is additive and does not disturb the previous prompt-queue slice.
- Tests cover each required CHECK invariant and quality verification passes across the repository.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

None.

---

## Readiness checklist

**P0 blockers**
- [x] No production blockers identified.

**P1 recommended**
- [x] No corrective actions identified.
