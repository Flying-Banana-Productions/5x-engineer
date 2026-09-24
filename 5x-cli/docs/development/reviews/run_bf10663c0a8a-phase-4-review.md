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

**Readiness:** Ready with corrections. One P1 route-coherence defect and one P1 test gap, both mechanical (`auto_fix`). The P2 items are telemetry fidelity and hardening.

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
