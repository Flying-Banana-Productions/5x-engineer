# Review: Git-native run records — Phase 1

**Review type:** `440180baa99e25f13421f3e36636120b47a28ed9`  
**Scope:** Phase 1 `RecordStore` contract, memory implementation, exports, and contract tests.  
**Reviewer:** Staff engineer (correctness, architecture, reliability, security, operability)  
**Local verification:** `bun test test/unit/control-plane/record-store-contract.test.ts` (26 pass); `bun test test/unit/control-plane/` (134 pass); `bun run typecheck` (pass); `git diff --check` (pass).

**Implementation plan:** `docs/development/plans/212-git-native-run-records-plan.md`

## Summary

The commit introduces a path-agnostic `RecordStore`, clone-on-read in-memory implementation, public exports, and a substantial shared contract suite. The basic append, duplicate, ordering, and atomic clone/swap behaviors are well covered. It is not ready to tag Phase 1 because the published cross-slice writer shape is absent, and the store does not itself enforce immutable creator attribution on a subsequent summary write.

**Readiness:** Not ready — mechanical contract and Phase 1 freeze corrections are required before Slice 06 can safely consume the API.

---

## What shipped

- **Record contract:** Added record stream, provenance, origin, summary, and step-key types plus `RecordStore`.
- **Memory backend:** Added insertion-ordered, clone-on-read `createMemoryRecordStore()` with clone-then-swap atomic append.
- **API and tests:** Re-exported the contract from both public barrels and added focused unit coverage.

---

## Strengths

- The store interface remains independent of SQLite, git, and working-tree paths.
- `atomicAppend` clones affected run state before applying operations, so validation errors and the test commit hook do not partially mutate memory state.
- Duplicate keys preserve the original line and insertion ordering does not depend on timestamps.
- The contract suite covers all three streams, provenance/origin round trips, and mutable-result isolation.

---

## Production readiness blockers

### P0.1 — Phase 1 does not publish the required cross-slice writer-shape types

**Classification:** `auto_fix`

**Risk:** Phase 1 is declared as the hard prerequisite for Slice 06, but neither `RecordCommandContext` nor `PreparedRecordStep` (including `performer`) exists or is exported. Slice 06 therefore cannot consume the promised shared type contract and may recreate incompatible local shapes.

**Requirement:** Publish and export the Phase 1 declarations specified in plan §1.5, including `RecordCommandContext.originFor` / `redactedRecorder` and the `PreparedRecordStep.performer` shape, without implementing `createRecordContext`.

**Implementation guidance:** Add the declaration-only shared types at the planned seam and add a compilation-oriented contract test/import proving Slice 06 can consume them while `record-context` remains absent.

**Location:** `src/control-plane/index.ts`; `src/index.ts`; plan §1.5, lines 512–544 and 531.

---

### P0.2 — `putRun` permits a later write to replace the original creator

**Classification:** `auto_fix`

**Risk:** `putRun` directly replaces an existing v1 summary with caller-provided data. A seal write can thus change a known creator to another recorder or `null`, violating the attribution invariant that the creator is preserved across seal. The current tests only pass because they manually supply the original creator again.

**Requirement:** For an existing v1 run, preserve the stored `creator` when updating the summary (including `null`) and add regression coverage that attempts to overwrite a known creator and a `null` creator.

**Implementation guidance:** Clone the incoming summary, replace its `creator` from the existing summary before storing it, and keep the newer-format rejection before any mutation.

**Location:** `src/control-plane/record-memory.ts:146-166`; `test/unit/control-plane/record-store-contract.test.ts:93-167`.

---

## High priority (P1)

None.

---

## Readiness checklist

**P0 blockers**
- [ ] Export the shared `RecordCommandContext` and `PreparedRecordStep.performer` freeze surface.
- [ ] Make creator attribution immutable across existing-summary writes and cover overwrite attempts.

**P1 recommended**
- [x] Focused contract, control-plane unit, typecheck, and whitespace checks pass.

---

## Addendum (2026-09-03) — Phase 1 correction review

**Reviewed:** `83f2e664b3cccb479454ba6467cafb879eb216cb`

### What's addressed (✅)
- **P0.1 — `auto_fix`:** Added and re-exported declaration-only `RecordCommandContext`, `PreparedRecordStep`, and `PrepareRecordStepOutcome`. The shape matches plan §1.5/§4.2, retains `performer`, and adds a compile-oriented consumer test while confirming `record-context.ts` is still absent.
- **P0.2 — `auto_fix`:** `putRun` now copies the existing creator into every subsequent v1 summary update. Regression tests cover attempted replacement of both known and `null` creators while allowing the sealer to be updated.

### Remaining concerns
- No correctness, security, architecture, performance, or operability regressions found in the follow-on diff.
- `bun test` was attempted but exceeded the 120-second review timeout in unrelated interactive/unit suites; the changed contract suite (30 pass), all control-plane unit tests (138 pass), and typecheck passed.

### Updated readiness
- **Phase 1 completion:** ✅ — the frozen store and writer-shape contract now meet the Phase 1 gate.
- **Ready for next phase:** ✅ — Slice 06 Phases 4–5 may consume the published types; Phase 6+ remains correctly gated on this slice's Phase 4 factory.
