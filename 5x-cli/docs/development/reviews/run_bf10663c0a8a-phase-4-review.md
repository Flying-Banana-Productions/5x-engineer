# Review: Plan 210 Phase 4 — Paired implementation observations and telemetry

**Review type:** `e9b10f4c91ef8685fd489a18ae276a605ad89807`
**Scope:** Phase 4 (W4). This covers the new `src/commands/implementation-review-context.ts` (composer and paired writer), the `implementation-review` record codec in `record-lines.ts`, store/index support in `review-budget-store.ts` / `review-budget-index.ts`, activity telemetry in `run-v1.handler.ts`, and wiring in `protocol.handler.ts` and `invoke.handler.ts`, plus the new unit tests.
**Reviewer:** Staff engineer (correctness, durable-write semantics, plan compliance, test strategy)
**Local verification:** `bunx tsc --noEmit`: clean. `bun test test/unit/commands/implementation-review-context.test.ts test/unit/commands/protocol-validate.test.ts test/unit/commands/invoke.test.ts`: 143 pass, 0 fail. I also ran a throwaway probe against `composeImplementationReviewerRecord` (see P1.1) and deleted it afterwards.

**Implementation plan:** `5x-cli/docs/development/plans/210-implementation-review-governance-plan.md`
**Technical design:** N/A

## Summary

The paired writer is solid:

- It reuses the admitted `prepareRecordStepAppend` / `finalizeAndWritePreparedStep` path with `paired-all-new`.
- `completionAuthorized` is only computed inside the append op and read back from the durable line.
- Duplicates return the stored winner, and a coupled-key collision is a `RECORD_PAIR_CORRUPT` error.
- Both handlers now write the pair *before* the success envelope.
- Variance stays telemetry: inherited W/R/B/D come from an empty finding list, and the codec rejects a `findings` field.

There are two gaps:

- A clean `ready` verdict under a binding whose inherited budget needs a human publishes `route: complete` / `nextAction: complete` alongside an `inherited_budget` gate cause.
- The "protocol/invoke parity" test only calls the composer twice. No test exercises the handler wiring that this phase actually changed.

**Readiness:** Not ready. One P1 route-coherence defect and one P1 test gap are open. Both are mechanical (`auto_fix`), and P2 items are unaffected by this rating. The P2 items are telemetry fidelity and hardening.

---

## What shipped

- **Composer (`composeImplementationReviewerRecord`)**: checks that the binding, phase and stored review context identity (binding, phase, patch hash, endpoints) match. It re-runs `validateImplementationReview` with the prior closure and derives inherited budget with no findings. It also builds scoped gate causes (critical_safety, plan_amendment, semantic_human, inherited_budget), class counts, a boundary inventory with explicit `unknown`, effort/architecture variance, added paths (excluding workflow artifacts) and activity telemetry. It returns a pending observation with `completionAuthorized: false`.
- **Paired writer (`recordImplementationReviewerStepWithObservation`)**: writes the step and the `implementation-review` budget line atomically, keyed by the finalized step tuple. A duplicate returns the persisted winner, and a coupled-key-exists result becomes a corruption error.
- **Records/store/index**: a versioned codec with unknown-field rejection, plus `listImplementationReviews` / `getImplementationReview` / `projectImplementationReview`. Reindex decodes and tolerates observation and context lines without projecting them as plan snapshots.
- **Wiring**: `protocol validate --record --review-context` and `invoke --record` use the pair, decorate the output with `governance`, and skip the legacy post-envelope record path.
- **Tests**: duplicate explicit iteration, auto-iteration and lost race, coupled-key corruption, max-step admission, no partial writes, projection failure and retry, fresh clone, origin redaction, W/R/B/D invariance.

---

## Strengths

- Completion authority is computed only in `extraOps` at append time and only exposed from the re-read durable line. The test at `implementation-review-context.test.ts:407` proves that a failed append leaves pending unauthorized.
- The collision semantics follow the plan. The retry test shows that a rival pending route (`complete`) is never published over the stored `author_revision` winner.
- Keeping implementation observations as a separate budget-stream kind means plan snapshot readers and `applyPlanReviewBudget` can't see them. The fresh-clone and reindex assertions check this.
- Moving the implementation record ahead of `outputSuccess` fixes a real hazard. The legacy path could emit a success envelope and then fail to record, which would publish a route that was never stored.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — A `complete` route coexists with an `inherited_budget` gate cause

`gateCausesFor` appends `inherited_budget` when `deriveBudget(...).requiresHuman` is true. The route and nextAction still come from `validateImplementationReview`, which knows nothing about inherited budget. I probed an enforced binding (`effort: 8, governingB: 1`) with a ready verdict and no items. The result was `{"route":"complete","nextAction":"complete","gateCauses":["inherited_budget"]}`. `completionAuthorized` is correctly false. However, the `governance` decoration tells the orchestrator to complete while also saying completion is not authorized, and any consumer keyed on `route`/`nextAction` will advance.

The plan requires ordinary defects to keep routing to author revision even when inherited budget requires a separate gate. That already works: `author_revision` plus the gate cause is fine. But a `complete` route must not survive a non-empty gate-cause list.

**Recommendation:** in the composer, when the validator route is `complete` and `gateCauses` is non-empty, set `route: "human_gate"` and `nextAction: "human_gate"`. Keep `author_revision` untouched. Add a test next to the existing "clean complete route" test using the over-budget binding.

### P1.2 — No handler-level protocol/invoke parity or wiring tests

The plan's test bullet and completion gate ("native, invoke and direct validated recording yield the same observation/route") are ticked, but the "parity" assertion at `implementation-review-context.test.ts:~121` calls `composeImplementationReviewerRecord` twice with identical inputs. That is tautological. Nothing exercises the new code in `protocolValidate` (`protocol.handler.ts:670-740`, `858-910`) or `invokeAgent` (`invoke.handler.ts:990-1045`, `1185-1232`). This phase's riskiest changes are in those two files:

- the step-name and phase that each passes to the composer versus the writer;
- the `implementationRecorded` skip of the legacy path;
- decoration with the durable versus the pending observation;
- the error envelope on `RecordError` before success;
- the non-`--record` pending decoration.

**Recommendation:** extend the existing handler tests (`protocol-validate.test.ts:~400` and `invoke.test.ts:~370` already assert `result_json.governance.route` for plan reviews). Record the same implementation verdict through both entry points with a prepared context. Assert:

- one step line and one observation line are written;
- the persisted route, gate causes and step tuple are identical;
- `governance.completionAuthorized` is taken from the durable line;
- a pair collision surfaces as an error envelope, not a success envelope.

---

## Medium priority (P2)

- **Added paths miss empty and binary new files**: `addedPathsFromCodeContext` only looks at `hunks` with `oldPath === "/dev/null"`. `parseCodePatch` emits no hunk for an empty new file (there is no `@@`), and it moves binary files to `binaryPaths`. Both are real git additions, and the plan says "Record path additions exactly from git". Derive additions from the `new file mode` / `--- /dev/null` file headers in the patch, including `binaryPaths` entries whose old side is `/dev/null`, with the same workflow exclusion. Add a test for each case.
- **Duplicate step without its coupled observation returns silent success**: in the duplicate branch, if the step line exists but no observation line does, the writer returns `observation: null` and the handler emits success with no `governance`. This can happen when the step was first recorded through the legacy path, or in the reverse orphan case. The plan says a paired collision returns "the actual winner or corruption error". In enforced mode, throw `RECORD_PAIR_CORRUPT`, mirroring the `coupled-key-exists` branch.
- **Plan-amendment telemetry scope and identity**: `planAmendments` adds binding-wide `amendments.length` to a phase-filtered observation count. It also counts every prior observation that carries a `plan_amendment` cause, so a single plan defect re-raised over N rounds counts N times. Filter amendments to the phase's source observations and de-duplicate by finding fingerprint, matching the plan's "from stable record identities".
- **Duplicated phase canonicalization**: `activityPhaseKey` in `run-v1.handler.ts` re-implements `canonicalPhaseId` from `implementation.ts`. Reuse the existing helper so that telemetry and observation phases can't diverge.
- **Corrupt or future observation line fails the composer with a raw exception**: `listImplementationReviews` decodes with throwing codecs, so one unreadable line makes `protocol validate` throw a non-`RecordError` stack instead of a structured envelope. Failing closed is right, but map it to a typed error code.
- **Raw `run record reviewer:*` in an enforced implementation run** still writes a reviewer step without an observation. The plan's Phase 9 covers direct-admission guards, so this is not a Phase 4 item. Note it for that phase.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1: never publish `route: complete` / `nextAction: complete` with a non-empty gate-cause list
- [ ] P1.2: handler-level protocol/invoke parity and wiring tests for implementation recording

**Ready for next phase:** ⚠️ Yes after P1.1 and P1.2. Phase 5 builds on the observation route and `plan_amendment` causes, so route coherence should be fixed first.

---

## Addendum (2026-09-23) — Route coherence and paired-write fixes verified

**Reviewed:** `6d4800c7ddcba8f06f81d1b46fb34191cc151172` (`2158e0b` — substantive fix; `6d4800c` — Biome formatting only, no logic change)
**Local verification:** `bunx tsc --noEmit`: clean. `bunx biome check` on all touched source/test files: clean. `bun test test/unit/commands/implementation-review-context.test.ts test/unit/commands/protocol-validate.test.ts test/unit/commands/invoke.test.ts`: 152 pass, 0 fail. `bun test test/unit/review-governance test/unit/review-budget test/unit/commands`: 880 pass, 0 fail.

### What's addressed (✅)

- **P1.1 (route/gate-cause incoherence)** — Fixed. `composeImplementationReviewerRecord` now overrides `route`/`nextAction` to `human_gate` whenever the validator's route is `complete` but `gateCauses` is non-empty (`implementation-review-context.ts:479-484`). `author_revision` is untouched, matching the plan's requirement to keep ordinary defects routing to author revision regardless of inherited budget. Covered by a new test ("a complete route with inherited budget becomes a human gate") that reproduces the exact scenario from my prior probe (enforced binding, `effort: 8`/`governingB: 1`, ready verdict) and asserts both the pending and the durable-written observation carry `route`/`nextAction: "human_gate"` with `completionAuthorized: false`.
- **P1.2 (no handler-level parity/wiring tests)** — Fixed, and more thoroughly than I asked for. `invoke.test.ts` adds a real end-to-end test that drives `invokeAgent` through git/plan/binding/context setup, records a reviewer step, asserts a single step line and one observation, and confirms a second `invokeAgent` call against the same colliding observation identity rejects with `RECORD_PAIR_CORRUPT`. `protocol-validate.test.ts` adds a dual-entry-point test that calls `protocolValidate` (without `--record`, then with `--record`) and `invokeAgent` against the *same* run/phase/iteration, and asserts: exactly one step line and one observation are written; `protocolValidate`'s and `invokeAgent`'s `governance.route`/`completionAuthorized`/`gateCauses` are identical; and both match the persisted observation's `route`/`gateCauses`/`stepKey`. A second test confirms a paired collision surfaces as a rejected promise (error) before any success envelope, exercised through the real `protocolValidate` entry point. This is a genuine, non-tautological parity test, unlike the composer-only test that existed before.
- **P2 (added paths miss empty/binary files)** — Fixed. `parseCodePatch` now tracks `addedPaths` from `new file mode` and `--- /dev/null` headers, and a new `Binary files /dev/null and ...` check catches binary additions that never have a `--- /dev/null` line. `addedPathsFromCodeContext` consumes `parsed.addedPaths` directly (workflow-path-excluded via `considerAddedPath`), with a hunk-based fallback retained only for non-git-formatted synthetic contexts (used throughout the existing test suite's `patch: "patch"` fixtures). New test "empty and binary additions come from patch headers" covers an empty new file, a binary new file, a binary *modification* (correctly excluded — no `new file mode`), and a binary new file under an excluded workflow path (correctly excluded). I traced the parsing logic by hand against all four fixture cases and it's correct. One minor observation: the second loop in `addedPathsFromCodeContext` that iterates `codeContext.binaryPaths` is dead in practice — `addedBinary` is by construction a subset of `parsed.addedPaths`, so the loop's guard condition never lets through a path that wasn't already added by the first loop. It's harmless (a Set re-insertion, not a bug) — a cleanup opportunity, not worth its own item.
- **P2 (duplicate step without coupled observation)** — Fixed. The duplicate branch in `recordImplementationReviewerStepWithObservation` now throws `RECORD_PAIR_CORRUPT` when a step line exists without its observation and the binding mode is `enforced` (`implementation-review-context.ts:657-664`). Covered by "a duplicate step without its observation is corrupt in enforced mode".
- **P2 (plan-amendment telemetry scope/identity)** — Fixed. `planAmendmentCount` now de-duplicates by finding fingerprint across phase-scoped prior observations, phase-relevant amendments (looked up by `sourceObservationId` against the phase-filtered observation map, so cross-phase amendments are correctly excluded), and the current gate causes. Covered by "plan amendments are phase-scoped and unique by finding fingerprint," which re-raises the same plan defect across two iterations and confirms the count stays at 1, and confirms an amendment referencing an out-of-phase/nonexistent source observation doesn't inflate the count. I checked by hand that the amendments loop is now largely redundant with the observations loop for same-phase amendments (both land on the same fingerprint set), but redundant-and-correct is fine here — it isn't a new bug.
- **P2 (`activityPhaseKey` duplicated `canonicalPhaseId`)** — Fixed. `run-v1.handler.ts` now imports and calls `canonicalPhaseId` from `review-governance/implementation.ts` directly. This is actually a behavior improvement, not just deduplication: the old regex only matched `phase-N` (hyphen, anchored to end-of-string), so a step recorded with `phase: "Phase 1"` (space-separated, as `capturePhaseAuthorAdmission`-adjacent code and humans commonly write) previously fell through to a literal-string return and would not match the canonical phase key `"1"`. `canonicalPhaseId`'s `phase[\s-]+(\d+...)​\b` regex matches both forms. New test "activity telemetry uses the canonical phase id" proves a step recorded with `phase: "Phase 1"` is correctly matched against a compose call using `phase: "phase-1"`, both canonicalizing to `"1"`.
- **P2 (corrupt/future observation line raw exception)** — Fixed, beyond what I asked for. `composeImplementationReviewerRecord` now wraps the `listRecordedImplementationReviews` call in try/catch and returns a typed `{ status: "error", code: "IMPLEMENTATION_REVIEW_RECORD_CORRUPT", ... }` result instead of letting the decode exception propagate raw. Covered by "a corrupt observation line is a typed compose error," which appends a line with an unknown `version: 99` and asserts the typed error code.

### Remaining concerns

None from the prior review. I looked for new issues introduced by the fix commit itself:

- The redundant `codeContext.binaryPaths` loop noted above (dead but harmless) — not worth a tracked item.
- The `planAmendmentCount` amendments loop is similarly redundant with the observations loop for in-phase amendments — also not worth a tracked item, since it doesn't produce wrong output and the test suite confirms correct counts.
- I re-ran the full `test/unit/commands`, `test/unit/review-governance`, and `test/unit/review-budget` suites (880 tests) plus `tsc --noEmit` and `biome check` on all touched files — all clean. No regressions found in adjacent code paths (direct `run record`, plan-review composer, budget arithmetic).

The `6d4800c` commit is exactly what its message claims — Biome import-sort and line-wrap formatting on the three files touched by `2158e0b`, with zero logic change (confirmed by diff inspection: only import reordering and multi-line wrapping of existing expressions).

### Updated readiness

- **Phase 4 completion:** ✅ — Both P1 items and all five P2 items from the prior addendum are fixed, each with a targeted regression test that reproduces the original failure mode. No new defects introduced by the fix commits.
- **Ready for next phase:** ✅ — Phase 5 (plan-defect routing and guarded text amendments) can proceed. The `plan_amendment` gate-cause fingerprint plumbing it will build on is now scoped and deduplicated correctly.
