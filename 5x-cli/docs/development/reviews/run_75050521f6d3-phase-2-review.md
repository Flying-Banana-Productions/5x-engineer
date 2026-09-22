# Review: Plan 209 Phase 2 — Durable decisions and governing-state fold

**Review type:** `03c06d838faedacb478b471ee40675cd8606fb58`
**Scope:** `src/review-governance/{decisions,store,codec,sqlite-index}.ts`, migration v9, plan-208 snapshot/index extensions for effective/suppressed gate causes, `records index` rebuild of budget/decision projections, public exports, and the new unit tests.
**Reviewer:** Staff engineer (correctness, durability/concurrency, rebuild parity, plan compliance)
**Local verification:** `bun test test/unit/review-governance test/unit/db test/unit/control-plane test/unit/records` — 435 pass, 0 fail. `bunx tsc --noEmit` — clean. Ran an ad-hoc probe of `deriveOpenGate` against a two-snapshot run; the result is recorded under P1.1.

**Implementation plan:** `docs/development/plans/209-plan-review-governance-plan.md` (Phase 2)
**Technical design:** N/A

## Summary

Phase 2 adds an immutable governance decision record in the `decisions` stream, a validated codec, a deterministic intent hash, the steps-order `classifyDecisionAcceptance` classifier, the governing-state fold, deterministic gate IDs and successor chains, a RecordStore-backed facade with a gate-scoped CAS, and a v9 SQLite projection with a rebuild path. The core domain logic is sound and follows the plan's key invariants: the steps stream is the only source of acceptance order, lines are never updated, and SQLite is only a projection. One correctness bug needs fixing before Phase 5/6 build on it: `deriveOpenGate` can reopen a gate from an older snapshot after a newer snapshot has no causes. The other findings are latent hazards and over-claimed plan checkboxes. All of them are mechanical.

**Readiness:** Ready with corrections — one P1 `auto_fix` correctness bug plus P2 hardening and plan-accuracy items. None needs a human decision.

---

## What shipped

- **Decision records** (`decisions.ts`): `ReviewDecisionPayload` v1, `createReviewDecision` and `validateReviewDecision` with choice-specific checks, and a canonical-JSON `decisionIntentHash` that excludes `decisionId` and `createdAt`. Also adds `governanceDecisionKey` and `governanceCorrectionKey`, and `listGovernanceDecisions`, which ignores non-governance `decisions` lines and reports malformed governance payloads as diagnostics.
- **Acceptance classifier**: `classifyDecisionAcceptance` finds the gate's reviewer step from the snapshot `stepKey` tuple and the paired `human:review-governance` step by `decisionId`/`gateId`. It marks the decision stale if a `phase === "plan"` `reviewer:*` step lies strictly between them. Missing or duplicate boundaries, and inverted ordering, are reported as malformed.
- **Governing fold**: `foldGoverningReviewState` applies accepted, non-superseded decisions in insertion order: governing `B`, run-level baseline-dispute resolution and the re-estimate marker, approved scope, accepted risks, architecture approvals, and abort. Stale, malformed, and superseded decisions go to `auditOnly`.
- **Gate derivation and facade** (`store.ts`): `deriveGateId` builds the ID from `(runId, snapshotId, sorted causes, predecessorGateId)`. `deriveOpenGate` walks the successor chain. `resolveGate` performs a paired human-step and decision `atomicAppendIfAllNew` and reports semantic retries.
- **Persistence**: migration v9 adds `mode` to the baseline projection, effective/suppressed cause columns, the `review_decision_index` and `review_gate_index` tables, and nullable prompt context columns. Snapshot payload, codec, record, and index now carry `effectiveGateCauses`/`suppressedGateCauses`. `reindexReviewGovernance` rebuilds both projections, and `rebuildRecordsIndex` now loads `budget.jsonl`/`decisions.jsonl` and runs both the budget and governance reindex.

---

## Strengths

- **Acceptance is defined only by steps insertion order.** No timestamp or cross-stream comparison is used, which follows the plan's P1.10 correction. The same classifier drives the live fold and the reindex, so their audit classifications cannot drift.
- **Fail-closed validation of the intent hash.** `validateReviewDecision` recomputes the hash from the payload fields, so a hand-edited or partially corrupted decision line is reported as malformed instead of silently folding.
- **Backward-compatible codec additions.** The new snapshot fields are optional in the payload and default to `[]` in records, so plan-208 history decodes unchanged. Non-governance `decisions` kinds are skipped silently, as the plan requires.
- **Tests exercise the interesting orderings.** They cover reviewer-before-human (stale) against reviewer-after-human (accepted), memory and working-tree store parity, a two-cause successor chain where the predecessor never reopens, and rebuild equality after the index is wiped.
- **No `bun:sqlite` imports in the facade or domain modules.** SQLite is confined to `sqlite-index.ts` and the migration.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — `deriveOpenGate` reopens an older snapshot's gate after a newer snapshot with no causes

`store.ts` filters snapshots to those with a non-empty `effectiveGateCauses` before taking `.at(-1)`. If the latest reviewer snapshot has no causes, the chain falls back to an earlier snapshot, and that snapshot's unresolved gate is reported as open. Example: an advisory round, or any round that was recorded while an earlier gate was still pending. The plan says "a newer reviewer snapshot supersedes the chain" and "a resolved predecessor never reopens".

I confirmed this with a probe. With `snap1` (causes `[over_effective]`) followed by `snap2` (causes `[]`), `deriveOpenGate` returns `{ snapshotId: "snap1", resolved: false, … }` instead of `null`. Phase 5/6 will use this function to decide whether to pause, so the bug would make a clean round pause on a superseded gate.

**Fix:** take the last decodable snapshot in the `budget` stream, whatever its causes, and return `null` when its `effectiveGateCauses` is empty. Add a unit test with two snapshots where the newer one has no causes.

---

## Medium priority (P2)

- **P2.1 — `resolveGate` handles loser lookup wrongly for step-key collisions and corrections.** The human step's idempotency key comes from `(phase, iteration)` only. The batch can therefore fail because the step key already exists, while the gate key is new. This happens, for example, when a successor gate is resolved at the same iteration. In that case `winnerLine` is absent and the function throws `REVIEW_GATE_ALREADY_RESOLVED`, which is the wrong error; the tests avoid it by bumping `iteration` by hand. On a conflict for a correction (`supersedesDecisionId`), the loser is looked up under `governanceDecisionKey(gateId)`, so the original gate decision is reported as the "winner" instead of the conflicting correction. Phase 5.2 replaces this path with the finalize-seam `coupled-key-exists` outcome. Until then:
  - look up the key that was actually written (the correction key for corrections);
  - when the step key collides but the decision key does not, throw a distinct error instead of `REVIEW_GATE_ALREADY_RESOLVED`;
  - add a test for each case.
- **P2.2 — `rebuildRecordsIndex` appends historical lines into a caller-supplied authoritative store.** `projectionStore = opts.recordStore ?? createMemoryRecordStore()`, then every git-committed steps, budget, and decisions line is `append`ed, and `putRun` is called for missing runs. Current callers do not pass `recordStore`, so this is latent. A caller that passes the working-tree store would have an index rebuild write into authoritative JSONL. **Fix:** always project through a fresh memory store, or read from the supplied store without mutating it.
- **P2.3 — Live `deriveOpenGate` and the reindex disagree on malformed gate decisions.** `deriveOpenGate` calls `decodeReviewDecisionPayload` on the gate-key line, which throws on a malformed or unknown-version payload. `reindexReviewGovernance` excludes the same decision and treats the gate as unresolved. Whichever behavior is chosen, the live path and the rebuild must match. The plan says malformed governance is diagnosed, not fatal, so the fix is to catch the error in `deriveOpenGate`, treat the gate as unresolved, and add a test.
- **P2.4 — Write-through upserts are not reachable.** Plan 2.3 asks for "write-through upserts and `reindexReviewGovernance`". `upsertDecision` and `upsertGate` are module-private, and nothing calls them on the live `resolveGate` path. As a result, `review_decision_index` and `review_gate_index` are only populated by `records index`, and that rebuild runs from committed git history (DELETE then reinsert per run). **Fix:** export the upsert helpers, or expose a per-run `projectReviewGovernance(recordStore, db, runId)` built on `reindexReviewGovernance`, so the Phase 5 decision handler can write through after the record append.
- **P2.5 — Some Phase 2 checkboxes claim work that is not present.** Three Phase 2 checkboxes are marked `[x]`, but the corresponding work lands in later phases:
  - 2.2 "At reviewer-record time, fold … and persist effective unresolved causes": only the storage fields exist; nothing computes them yet (Phase 6.1).
  - 2.2 "Treat typed prompts … Repair recreates missing prompts": `promptStore` is `void`ed (Phase 5.1/5.2).
  - 2.2 "facade over … `ReviewBudgetCommandContext`": not used.

  `routeForChoice` returns `human_gate` for budget and baseline choices, while `deriveOpenGate` returns `null` when a decision covers no cause (for example `increase_budget`). That interim inconsistency is intentionally resolved by Phase 4's authoritative rerun, and should say so. **Fix:** annotate these checkboxes as schema/seam-only with a pointer to the completing phase, so the plan stays an accurate audit trail.
- **P2.6 — Test gaps.**
  - The test named "fold … keeps stale decisions audit-only" never adds a stale decision; it asserts `auditOnly` is empty.
  - Nothing tests `supersedesDecisionId` folding. That includes a retain that is superseded and then a re-estimate marker, and a superseded accepted risk dropping out of `acceptedRisks`.
  - The plan asks for byte-equivalence between the post-rebuild governing state and the live fold. The rebuild test compares only decision index rows.

  Add these cases alongside the existing fixtures.
- **P2.7 — `review_gate_index.record_seq` is `seq + gateCount` with a cumulative counter.** This counter spans runs, so the value has no stable meaning. Use the budget line's sequence plus the chain depth instead, so ordering by `(run_id, snapshot_id, record_seq)` is well defined.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 `deriveOpenGate` uses the latest snapshot and returns `null` when it has no effective causes; regression test added

**P2**
- [ ] P2.1 `resolveGate` loser lookup uses the written key; step-key collision gets a distinct error
- [ ] P2.2 Index rebuild never mutates a supplied authoritative RecordStore
- [ ] P2.3 Live and rebuilt gate derivation agree on malformed gate decisions
- [ ] P2.4 Write-through projection helper exported for Phase 5
- [ ] P2.5 Over-claimed Phase 2 checkboxes annotated with their completing phase
- [ ] P2.6 Stale-fold, supersession, and rebuild governing-state parity tests
- [ ] P2.7 Stable `review_gate_index.record_seq`

**Phase readiness:** ⚠️ Phase 2 can proceed to Phase 3 after P1.1 is fixed. Phase 3 (protocol and diff validation) does not depend on the gate facade, so P2.1 and P2.4 can be deferred until they are needed in Phase 5.
