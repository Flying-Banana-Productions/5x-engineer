# Review: Plan 210 Phase 6 — Quality-backed final implementation corrections

**Review type:** `e6c61535e92cdafc751d8a2b712dca53fdf78298`
**Scope:** `src/review-governance/corrections.ts`, the `5x review corrections finish` command and handler, extraction of `resolveQualityTarget` in `quality-v1.handler.ts`, correction-attempt records, store and reindex support, the `phase.handler.ts` cache predicate, and unit tests
**Reviewer:** Staff engineer (correctness, governance bypass, test strategy)
**Local verification:** `bun test test/unit/review-governance/corrections.test.ts` passed (12 pass, 0 fail). `bunx tsc --noEmit` passed.

**Implementation plan:** `docs/development/plans/210-implementation-review-governance-plan.md` (Phase 6)
**Technical design:** N/A

## Summary

Phase 6 adds a separate eligibility predicate for single-P2 implementation corrections and a CLI-only finish command. The command runs the full layered quality configuration and stores failed and passed attempts, each bound to the observation, commit, tree, quality digest and execution directory. It also adds a latch: once an attempt is invalidated, the shortcut stays unavailable for that observation. The design is sound and closely follows the plan. However, two correctness gaps let the shortcut produce a passing proof that it should not produce. Both are mechanical to fix.

1. A "correction" that is just the reviewed commit, with no change at all, passes.
2. The command ignores the observation's durable route, gate causes and closure outcome.

Phase 7 will treat this proof as authority to carry claims forward, so both must be closed first.

**Readiness:** Ready with corrections. The P1 items are mechanical guards derivable from existing records.

---

## What shipped

- **Eligibility predicate** (`evaluateImplementationCorrectionEligibility`): accepts exactly one actionable P2 `implementation_defect`. The item must be `auto_fix`, have `architectureDelta: 0`, list explicitly empty `boundaryChanges`, include a mechanical explanation, and have no exceptions, reviewer verification or re-raise fields. Plan defects, human items and boundary items go to human or author routes.
- **Changed-path inventory** (`classifyCorrectionPath` / `assessCorrectionInventory`): detects manifests, lockfiles, schema, migrations, API specs and plan paths, and treats config, index and public paths as uncertain. Paths outside the reviewed hunk set count as unconfined or uncertain.
- **Attempt identity and latch**: attempts are keyed by observation, commit, tree, quality digest and execution directory. The command resumes only an identical attempt that passed. After any failure, timeout, skip, empty configuration, dirty tree, wrong workdir or boundary result, re-entry is permanent. A different commit, tree or config counts as new evidence.
- **CLI adapter**: `review corrections finish` resolves the layered quality target and runs `runQualityCore` with `record: false`. It accepts no gate override and no passed flag.
- **Record plumbing**: codec, store list/save and reindex validation for `implementation-correction-attempt`.

---

## Strengths

- The failure latch is enforced by the durable records. Retrying cannot win back the shortcut or the claim carry-forward, which matches the plan's hardest requirement.
- Pre-review `quality:check` and `phase finish` caches are separate record kinds and are never read as proof.
- The quality digest covers the gate list, the skip flag and the execution directory, so a layered subproject configuration cannot reuse a root-level proof.
- A crash while running quality persists nothing, so the next call reruns the full suite rather than guessing success.
- The clean-tree check runs both before and after quality. A dirty tree afterwards produces an invalidated attempt rather than a pass.

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1 — A no-op "correction" at the reviewed commit produces a passing proof

**Risk:** Suppose `--commit` is the reviewed commit itself. That commit is normally recorded as the pre-review author result, so `authorRecordedCommit` accepts it. `isCodeAncestor` returns true when the two commits are equal. `changedCodePaths` returns `[]` when `from === to`, and an empty inventory counts as clean and confined. If quality passes (it did before review), the command writes a `passed` attempt, carries the originating claims forward and returns `complete`. The eligible P2 defect is never fixed.

`authorRecordedCommit` also accepts any author step in the phase, including steps recorded before the observation. It does not require the author result recorded after the observation.

**Requirement:** Reject a correction commit equal to `context.reviewedCommit`, and reject an empty changed-path inventory. Either case should return re-entry or an error, never a proof. Only accept an author step recorded after the originating observation's reviewer step, for example by comparing line order or `createdAt` against the observation. Add unit tests for `commit === reviewedCommit` and for an author step recorded before the review.

### P1.2 — `finish` ignores the observation's durable route, gate causes and closure outcome

**Risk:** `finishImplementationCorrection` recomputes eligibility from `observation.originalVerdict` only. Implementation routing can still put the same verdict on `human_gate`:

- closure validation can set `forcesHuman` when prior findings are unresolved;
- the observation can carry budget or credit `gateCauses`;
- advisory mode never makes an item a `shortcutCandidate`.

In each of these cases, a verdict holding one mechanical P2 still gets `status: complete` and carries claims forward. That skips the human gate the durable observation recorded.

**Requirement:** Grant the shortcut only when all of these hold:

- the stored observation's `route` is `author_revision`;
- `gateCauses` is empty;
- no error-severity diagnostics are present;
- the binding is in enforced mode.

The simpler option is to persist the routing layer's `shortcutCandidate` on the observation and require it. Any other observation should return the `ordinary` result with its recorded route and next action. Add tests that use an observation with a one-P2 verdict and a `human_gate` route or a non-empty `gateCauses`.

---

## Medium priority (P2)

### P2.1 — No handler-level or real-git test for `review corrections finish`

The unit tests call the pure core with a fake git and a fake quality runner. The plan lists "subproject layering, wrong workdir, dirty tree, restart at each substep". Layering is covered only as a digest-inequality check. Restart is covered only for a crash before the quality result. Nothing checks the following:

- the adapter's `resolveQualityTarget`/`runQualityCore` pairing, where the configuration is resolved twice and the results can differ;
- CliError mapping;
- a crash after `saveImplementationCorrectionAttempt`;
- git-backed tree or path inventory.

Add one handler test with a temporary git repository and a layered `5x.toml`, following the existing review-decision handler test pattern. Also add a restart test in which the attempt is saved and then resumed.

### P2.2 — Minor cleanups

- `assessCorrectionInventory` sets `architectureDelta: inventoryClean ? 0 : 0`, a conditional whose branches are identical. Replace it with `0`.
- `isPreReviewQualityCache` only checks `stepName.startsWith("quality:")`. `phaseFinishCore` always passes a `quality:` name, so the new predicate has no effect there. That is harmless, but the doc comment overstates what it protects.
- When the tree is dirty after checks, the attempt is labeled `outcome: "failed"` even though quality passed. Because `passed` includes `!dirtyAfter`, `qualityFailure` is true. Use `"invalidated"` so the telemetry is accurate.
- When quality returns zero results with a non-empty gate list, the code latches it as `quality_skipped`. The plan says missing results should rerun the suite, not latch the shortcut. Consider treating that case like a crash: persist nothing and allow a rerun.

---

## Plan compliance

| Plan item | Status |
|---|---|
| Pure eligibility predicate | Done |
| `review corrections finish` command and core, full layered quality, no overrides | Done |
| Attempt identity, clean tree before and after, only a CLI proof resumes | Done, except P1.1 (a no-op commit counts as a correction) |
| Persist failed and passed attempts, latch, rerun after crash | Done; P2.2 covers the edge case where zero results latch instead of rerunning |
| Inventory compared with the finding and scope | Partial: checked against reviewed hunk paths, not the finding location (acceptable), but the durable route and gate causes are ignored (P1.2) |
| Passing proof stores zero delta, empty boundaries, source and destination identities and carried claims | Done |
| Test matrix | Mostly done at the unit level; handler and restart gaps (P2.1) |

## Phase readiness

Phase 7 reconciliation will treat this proof as the only authority for carrying claims forward. Fix P1.1 and P1.2 before Phase 7 relies on it. Both fixes are local to `corrections.ts` and its tests.
