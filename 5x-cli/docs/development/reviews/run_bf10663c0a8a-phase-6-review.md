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

---

## Addendum — Re-review at `6dd19ee242abeceac287de62a691f1ab8b6ceb84`

**Review type:** `6dd19ee242abeceac287de62a691f1ab8b6ceb84` (one commit since `1694fbcba5099e41b22de195fc70116b04d86798`)
**Scope of change:** `src/review-governance/corrections.ts`, `src/commands/phase.handler.ts` (doc comment only), new `test/unit/commands/review-corrections-finish.test.ts`, and expanded `test/unit/review-governance/corrections.test.ts`
**Local verification:** `bunx tsc --noEmit` passed. `bun test test/unit/review-governance/corrections.test.ts test/unit/commands/review-corrections-finish.test.ts` — 16 pass, 0 fail, 96 expect() calls. `bun test test/unit/commands/phase-finish.test.ts` — 14 pass, 0 fail. `bun test test/unit/review-governance/ test/unit/commands/review-decision.test.ts test/unit/commands/quality-v1.test.ts` — 165 pass, 0 fail (no regressions).

### Summary

This revision closes both P1 findings from the prior review with targeted, minimal changes plus direct unit-test coverage for each, and also resolves the P2 items raised previously (dead ternary, misleading doc comment, dirty-after mislabeling, zero-results latch). One P2 item (broader handler-level coverage) is now substantially addressed with a new real-git, layered-config handler test; a narrow slice of it (a crash occurring *after* the attempt is durably saved) remains uncovered and is restated below as a smaller residual item.

**Readiness:** Ready with corrections — only a P2 test-coverage gap remains, and it is mechanical.

### Prior findings — disposition

| ID | Status | Evidence |
|---|---|---|
| P1.1 — no-op correction at the reviewed commit produces a passing proof | **Addressed** | `finishImplementationCorrection` now resolves `context.reviewedCommit` and rejects `resolved === reviewed` with `reason: "unchanged_commit"` before running quality (`corrections.ts`). Independently, `assessCorrectionInventory`'s `changedPaths.length === 0` case is now treated as `emptyInventory`, which both blocks `proofFrom` and forces `outcome: "invalidated"` even if quality passed — a second, defense-in-depth guard against an empty diff slipping through by a different code path. `authorRecordedCommit` now also requires the matched author step to be recorded strictly after the observation's own reviewer step (by line order when the reviewer step is found, else by `createdAt`), closing the "author step recorded before the review" gap. All three sub-cases have direct new tests: `"the reviewed commit itself is not a correction proof"`, `"an author step recorded before the review is not the correction"`, and the `empty-inventory` case in the timeout/skip/dirty test matrix — all passing. |
| P1.2 — `finish` ignores the observation's durable route, gate causes and closure outcome | **Addressed** | `finishImplementationCorrection` now reads the run's `ImplementationBindingPayload.mode` and requires `observation.route === "author_revision" && observation.gateCauses.length === 0 && no error-severity diagnostics && bindingMode === "enforced"` (`durableShortcut`) before treating the observation as shortcut-eligible; otherwise it returns `status: "ordinary"` with the observation's own recorded `route`/`nextAction` and `reason: "not_shortcut_candidate"`. This is layered on top of (not a replacement for) the existing `evaluateImplementationCorrectionEligibility` check on `originalVerdict`, so it correctly catches cases the verdict-only check can't see: closure-forced `human_gate`, non-empty `gateCauses`, advisory-mode bindings, and error-severity diagnostics. New test `"a one-P2 verdict on a human gate or with gate causes stays ordinary"` exercises all four sub-cases (human-gate route, gate causes, advisory mode, error diagnostic) and the new handler-level test (`review-corrections-finish.test.ts`) exercises the same guard end-to-end through `finishImplementationCorrections` with a real `enforced`-mode binding. |
| P2.1 — no handler-level or real-git test for `review corrections finish` | **Partially addressed** | New `test/unit/commands/review-corrections-finish.test.ts` spins up a real git repo, a layered `5x.toml` (root + `packages/api` subproject), makes a genuine reviewed commit followed by a genuine correction commit, and calls `finishImplementationCorrections` through the same code path the CLI adapter uses. It asserts the layered execution directory is picked up (`attempt.executionDirectory` resolves to the subproject, and `qualityResults` reflects the subproject's gate, not the root's), asserts resume behavior on a second identical call (`resumed: true`), and asserts `CliError` is thrown for a missing observation. This covers the adapter pairing, layering, and CliError-mapping gaps called out previously. It does **not** yet cover a crash/process-exit occurring *after* `saveImplementationCorrectionAttempt` succeeds but before the CLI returns — i.e., resuming a call whose attempt was durably persisted mid-request. That specific restart case is still only implicitly covered by the "same identity resumes" test, which exercises a clean two-call sequence rather than an interrupted one. Not blocking; a good next unit test to add is a saved `"passed"` attempt fixture (constructed directly via `store.saveImplementationCorrectionAttempt`) followed by a `finishImplementationCorrection` call with matching identity, asserting `resumed: true` without invoking `runQuality` a second time — this is already effectively what `"a fresh passing suite carries claims and a later identical call resumes"` in `corrections.test.ts` does, so this gap is smaller than originally scoped and mostly a documentation nit rather than a real coverage hole. |
| P2.2 — minor cleanups (dead ternary, no-op cache predicate, dirty-after outcome label, zero-results latch) | **Addressed** | `architectureDelta: inventoryClean ? 0 : 0` is now `architectureDelta: 0`. `isPreReviewQualityCache`'s doc comment was rewritten to accurately state it doesn't filter step kinds at its current call site, rather than overstating protection. The dirty-after case now produces `outcome: "invalidated"` (not `"failed"`) with `qualityPassed: true` preserved, asserted directly by the updated test. Zero-results-with-a-non-empty-gate-list no longer latches as `"quality_skipped"`; it now short-circuits to a `reentry` with `reason: "quality_incomplete"` and persists **no** attempt at all (`noAttempt: true` in the test matrix, verifying `store.listImplementationCorrectionAttempts(RUN)).toHaveLength(0)`), matching the plan's "missing results... reruns the full suite; it never guesses success" requirement more faithfully than the original "skip and latch" behavior. |

### New issues introduced by this revision

None found. The `authorRecordedCommit` reviewer-step matching (`isObservationReviewerStep`) falls back to `iteration === null` meaning "match any iteration," which is consistent with the wildcard convention used elsewhere for `ImplementationReviewStepKey.iteration` (e.g. `implementationReviewObservationKey`'s `stepKey.iteration ?? ""`), so this is not a new inconsistency. The redundant `resolveCodeCommit(input.git, context.reviewedCommit)` call (in addition to the existing use of `context.reviewedCommit` later for `changedCodePaths`) is a harmless extra git round-trip, not a correctness issue.

### Updated plan compliance

All Phase 6 checklist items previously marked "Done, except P1.1" / "Partial" are now fully satisfied:

- Attempt identity, clean tree before/after, only a CLI proof resumes — **Done**, no-op commit and empty-inventory gaps closed.
- Inventory compared with the finding and scope — **Done**, durable route/gate-causes/diagnostics/binding-mode now honored in addition to the reviewed-hunk-path comparison.
- Persist failed/passed attempts, latch, rerun after crash — **Done**, zero-results case now reruns rather than latching.

### Updated readiness

**Ready with corrections.** No P0/P1 items remain. The single residual P2 (crash-after-save restart test) is a nice-to-have documentation/coverage gap with an already-established test pattern to follow, not a design or correctness question. Phase 7 can proceed to rely on the Phase 6 correction proof.
