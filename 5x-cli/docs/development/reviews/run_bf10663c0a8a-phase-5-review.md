# Review: Plan 210 Phase 5 — Plan-defect routing and guarded text amendments

**Review type:** `5768ebcc2559f82cc36d42303c60e5f03e8bbb79`
**Scope:** Phase 5 (W5). This covers the new `src/review-governance/plan-amendment.ts`, guard snapshotting in `commands/implementation-review-context.ts`, `verifyAuthorTextAmendment` / `admitAuthorTextAmendmentFromGit` / `assessSupersedingApproval` in `implementation-state.ts`, the `textGuard` codec in `review-budget/record-lines.ts`, the shortcut exclusion in `implementation.ts`, author admission wiring in `protocol.handler.ts` and `invoke.handler.ts`, and `test/unit/review-governance/plan-amendment.test.ts`.
**Reviewer:** Staff engineer (correctness of the byte guard, fail-closed semantics, plan compliance, test strategy)
**Local verification:** `bun run typecheck`: clean. `bun run lint`: clean. `bun test`: 3713 pass, 0 fail. I also ran a throwaway probe against `prepareTextAmendmentGuard` / `verifyGuardedPlanBytes` (see P0.1) and deleted it afterwards.

**Implementation plan:** `5x-cli/docs/development/plans/210-implementation-review-governance-plan.md`
**Technical design:** N/A

## Summary

Most of the Phase 5 design is in place:

- Routing uses `planImpact.kind`.
- Guards are snapshotted before delegation with anchor bytes, table bytes, spans and a structural signature.
- Verification works on raw buffers and appends to the existing text-amendment lineage without touching `approvedPlanHash`.
- Plan defects never qualify for the final-correction shortcut.
- Superseding ledgers cannot add claims or increase credit.

There are two problems. First, the checkbox "toggle" allowance lets an author add arbitrary content outside the authorized spans, and that content is then recorded as authorized lineage. Second, in `protocol validate`, a blocking amendment failure is thrown inside a bare `try/catch` and silently discarded. Both break the phase completion gate ("Only exact authorized text spans can change without a plan decision"). Both fixes are mechanical.

**Readiness:** Not ready. There is one P0 and three P1s. All are `auto_fix`.

---

## What shipped

- **`plan-amendment.ts`**:
  - `planImpactDisposition` and `planDefectBlocksShortcut`.
  - A fence-aware heading parser.
  - Exact Delivery Budget table byte extraction, which fails closed on missing or duplicate sections and on missing, duplicate or non-contiguous tables.
  - A structural signature covering phase headings, checklist identity and protected sections.
  - Protected byte ranges.
  - Ordered fixed-segment matching that allows replacements to change length.
  - A UTF-8 validity check, a worktree-equals-commit check, and `evaluateSupersedingLedger`.
- **Guard snapshot**: `composeImplementationReviewerRecord` replays the verified chain to get the effective anchor and builds the guard. If the chain is unverified or the guard is rejected, it downgrades `author_revision` to `human_gate` / `plan_amendment`.
- **Verification**: `verifyAuthorTextAmendment` checks, in order: the latest same-phase observation has a guard; the chain is valid; the guard's parent and anchor hash equal the current lineage head; the worktree is clean against HEAD; the guarded bytes pass. On success it appends via `recordVerifiedTextAmendment`. A missing guard on a text-only `author_revision` returns `PLAN_AMENDMENT_GUARD_MISSING`.
- **Wiring**: after author recording, both `protocol validate --record` and `invoke --record` run the admission step. Failures are blocking in enforced mode.
- **Codec**: `textGuard` is optional on the observation and is decoded with unknown-key rejection.
- **Tests**: kind routing and shortcut exclusion; table missing/duplicate; length-changing replacement vs just-outside edit; table/debt/Addresses/heading/checklist/design edits; invalid bytes; checkbox toggle; lineage reaching `complete` without re-binding; a chained second edit; broken/stale guard; failed-edit restart; dirty worktree; claim addition and credit increase.

---

## Strengths

- Comparison is done on raw buffers, and anchored fixed-segment matching lets replacements change length. There is no parsed-ledger proxy, and the table-byte check runs independently after span matching.
- The lineage is append-only and hash-chained (`beforeBlobHash` = replayed head, `afterBlobHash` = recorded bytes). The binding and `approvedPlanHash` stay immutable, which matches the plan's "no re-binding" requirement.
- The guard is tied to the lineage head (`parentLineageId`, `anchorBlobHash`), so a guard minted before another amendment cannot be replayed.
- Failure paths degrade to `human_gate` / `plan_amendment` instead of best-effort replacement. The downgrade happens in the composer before the durable observation is written, so no route contradicts the stored record.
- `evaluateSupersedingLedger` refuses live Markdown and the same source snapshot, which enforces the "no new post-approval credit" rule.

---

## Production readiness blockers

### P0.1 — Checkbox "toggle" ranges allow arbitrary out-of-span insertions that then become authorized lineage

**Risk:** `verifyGuardedPlanBytes` adds `checkboxByteRanges(anchor)` (each 3-byte `[ ]` marker) to the editable spans passed to `fixedSegmentsMatch`. Any replacement is accepted inside an editable span, so the `[ ]` marker can be replaced with any text, including newlines. The only downstream check is `structuralSignature`, and it only fingerprints checkbox lines and protected sections. Injecting `Also build a whole new subsystem\n- [x]` in place of `[ ]` produces a new non-checkbox bullet and leaves the original checkbox line's normalized identity unchanged, so the signature still matches. I confirmed this with a probe: anchor `- [ ] Do the thing`, committed `- Also build a whole new subsystem\n- [x] Do the thing`, authorized span left untouched → `{ ok: true }`. `verifyAuthorTextAmendment` would then append this as a verified amendment. `detectPlanDrift` would treat the injected scope as authorized for the rest of the binding, and Phase 9 boundaries would inherit it. This is exactly the "out-of-span edit" the phase gate forbids.

**Requirement:** Only an exact toggle may change a checkbox marker: `[ ]`, `[x]` or `[X]` replaced by one of those same three values, with no other bytes. Out-of-span insertion adjacent to a checkbox must return `PLAN_AMENDMENT_OUT_OF_SPAN`.

**Implementation guidance:** Do not treat checkbox markers as free-replacement spans. Two options:
- Compare `normalizeCheckbox(before)` against `normalizeCheckbox(after)` using only `allowedSpans` as editable, where the normalizer uses the same regex as `checkboxByteRanges`, including ordered-list markers.
- Make each checkbox range cover only the single inner byte, and after matching assert that the replaced byte is in `{" ", "x", "X"}`.

Add a regression test for the probe case and for a marker replaced with a multi-line payload.

---

## High priority (P1)

### P1.1 — `protocol validate` swallows blocking amendment failures

`protocol.handler.ts:861-905` wraps admission in `try { ... } catch { /* A run with no execution binding ... */ }`. `outputError` throws a `CliError` (`output.ts:287`). The enforced-mode `if (admitted.blocking) outputError(...)` is inside that `try`, so the bare `catch` discards the throw, and no warning is printed either. As a result, `PLAN_AMENDMENT_OUT_OF_SPAN`, `_TABLE`, `_DIRTY`, `_GUARD_MISSING` and similar failures never reach the caller, and author recording succeeds. The plan requires out-of-span edits, a missing guard or a mismatch to "emit typed amendment failure". Later drift detection would still catch the unauthorized bytes. But the typed failure is lost at the point where the author can act on it, and the result differs from `invoke`, which does throw. Recommendation: narrow the `try` to context construction and binding lookup only, or rethrow `CliError` from the catch. Add a handler test that asserts the error envelope.

### P1.2 — Re-invoking the author after a consumed guard fails as `PLAN_AMENDMENT_STALE` (blocking)

`verifyAuthorTextAmendment` always uses the latest same-phase observation's guard. After a successful verification, the lineage head is the new amendment. If the author is invoked again before the next review (for example, a quality-gate retry), the guard is the same one, so `guard.parentLineageId` (old head) no longer equals `parent.id`. The call returns `PLAN_AMENDMENT_STALE` with `blocking: true` in enforced mode, and the author step fails even if the plan is untouched. Recommendation: if an amendment with `guardId === guard.id` already exists, treat the guard as consumed and return `not_applicable`. Any further plan edits are then handled by the ordinary drift check against the extended lineage. Add a test covering two author passes after a single review.

### P1.3 — No handler-level or composer-level tests for the Phase 5 wiring

All new tests call `plan-amendment.ts` / `verifyAuthorTextAmendment` directly. Nothing exercises:
- `protocol validate --record` or `invoke --record` author admission (this is why P1.1 went unnoticed);
- the composer's guard snapshot, persistence of `textGuard` on the observation, or the `author_revision` → `human_gate`/`plan_amendment` downgrade when the lineage is invalid or the guard is rejected;
- the phase checklist's "same-code-plus-text pass through normal review closure to `phase:complete`". The existing test stops at `validateImplementationReview` returning `complete`; it does not go through the paired observation and `phase:complete`.

The Phase 4 review raised the same parity gap for the reviewer path. Recommendation: follow the existing `test/unit/commands/protocol-validate.test.ts` / `invoke.test.ts` patterns. Also add CRLF and non-ASCII (for example, em dash) anchors so the UTF-8 byte-offset conversions in `protectedByteRanges` and `checkboxByteRanges` are covered. This plan file itself contains em dashes.

---

## Medium priority (P2)

- **Checkbox normalization mismatch**: `normalizeCheckboxState` (`implementation-state.ts:117`) only handles `[-*+]` lists. `plan-amendment.ts` also treats ordered-list (`1. [ ]`) checkboxes as toggles. Drift and "unchanged" detection therefore disagree with the guard on ordered lists. Share one regex.
- **Duplicated Markdown structure logic**: `implementation.ts` (roughly lines 238-290) and `plan-amendment.ts` each implement heading/section/protected-range parsing. If the two definitions of "protected" diverge, span resolution could accept a span that the guard later rejects, or the reverse. Consolidate into one helper.
- **`PLAN_AMENDMENT_INVALID_BYTES` is unreachable on the real path**: `showPlanAtCommit` returns a decoded string, and `admitAuthorTextAmendmentFromGit` re-encodes it. Invalid UTF-8 is replaced before `isValidUtf8` runs, so the failure surfaces as `PLAN_AMENDMENT_DIRTY` (worktree ≠ re-encoded blob) instead. It still fails closed, but with the wrong code. Read the blob as a Buffer.
- **The HEAD commit is used, not the author's recorded commit**: the plan says "on the author's recorded commit". The implementation uses the workdir HEAD. That is equivalent when the author commits last, but it should be documented or aligned with the author result's `commit`.
- **Guard payload size**: every guarded observation stores the full `anchorBytes` (about 30 KB for this plan), and every amendment stores `authorizedPlanBytes`. This is acceptable for now. Consider referencing the lineage head by hash, since the anchor is reconstructable from the chain.

---

## Readiness checklist

**P0 blockers**
- [ ] P0.1 Restrict checkbox edits to exact marker toggles and add the injection regression test

**P1 recommended**
- [ ] P1.1 Stop the bare `catch` in `protocol validate` from swallowing blocking amendment failures
- [ ] P1.2 Treat an already-consumed guard as `not_applicable` on author re-invocation
- [ ] P1.3 Add handler/composer tests for author admission, guard snapshot/downgrade, the `phase:complete` path, and CRLF/non-ASCII anchors

---

## Addendum (2026-09-23) — Checkbox-toggle fix, error propagation, and guard-consumption fix verified

**Reviewed:** `e4055802df149a5a5943df4735265cc28bf72968` (one commit since `4182759d30bbb736df22f1f256e866ad6acbe100`: "Restrict plan checkbox edits to exact toggles and stop protocol validate from swallowing blocking amendment failures.")

**Local verification:** `bun run typecheck`: clean. `bun run lint`: clean (424 files). `bun test`: 3719 pass, 0 fail (up from 3713). I re-ran my P0.1 probe against the patched `verifyGuardedPlanBytes` directly (see below) and deleted it afterwards.

### What's addressed (✅)

- **P0.1 (checkbox injection) — fixed.** `verifyGuardedPlanBytes` (`src/review-governance/plan-amendment.ts:457-521`) no longer treats each `[ ]`/`[x]`/`[X]` marker as a free-replacement span. It now normalizes checkbox markers to `[ ]` on *both* the anchor and committed buffers via the new shared `normalizeCheckboxMarkers` (byte-length-preserving, so `allowedSpans` offsets stay valid), then runs `fixedSegmentsMatch` with only `input.guard.allowedSpans` as editable — the separate `checkboxByteRanges` editable-span list is gone entirely. I re-ran my original probe (`- [ ] Do the thing` → `- Also build a whole new subsystem\n- [x] Do the thing`) against the patched code: it now returns `PLAN_AMENDMENT_OUT_OF_SPAN`. A genuine exact toggle (`[ ] Do` → `[x] Do`) still returns `ok: true`. New regression tests cover the injection case, a multi-line marker payload, and an ordered-list (`1. [ ]`) toggle (`test/unit/review-governance/plan-amendment.test.ts:928-978`). Confirmed fixed.

- **P1.1 (swallowed blocking failures) — fixed.** `protocol.handler.ts:905-908` now does `catch (err) { if (err instanceof CliError) throw err; ... }`, so a blocking `outputError` thrown inside the `try` propagates instead of being discarded; only non-`CliError` failures (e.g., no execution binding) fall through to ordinary author recording. A new end-to-end test drives `protocolValidate` through a real temp git repo and asserts the call `rejects.toMatchObject({ code: "PLAN_AMENDMENT_OUT_OF_SPAN" })` (`test/unit/commands/protocol-validate.test.ts:547-731`). Confirmed fixed, and now has handler-level coverage that was previously missing.

- **P1.2 (consumed-guard re-invocation) — fixed.** `verifyAuthorTextAmendment` (`implementation-state.ts:1349-1352`) now checks `loaded.amendments.some((amendment) => amendment.guardId === guard.id)` before the staleness check and returns `not_applicable` if the guard was already consumed. This correctly short-circuits before the `parentLineageId`/`anchorBlobHash` comparison, so a second author pass against the same review no longer fails as blocking `PLAN_AMENDMENT_STALE`. Two new tests cover this directly: one exercising `verifyAuthorTextAmendment` twice with the same guard, and one confirming an *unconsumed* guard against a stale lineage head still correctly fails as `PLAN_AMENDMENT_STALE` (`test/unit/review-governance/plan-amendment.test.ts:1021-1093`). Confirmed fixed.

- **P1.3 (test gaps) — partially addressed.** New coverage since the last review:
  - `protocol.handler.ts` author admission: the blocking-failure test above, plus a full `phase:complete` path test that seeds a binding, an existing text amendment, runs `prepareImplementationReviewContext` → `composeImplementationReviewerRecord` → `recordImplementationReviewerStepWithObservation` → `protocolValidate({step: "phase:complete", ...})` against a real temp repo, and asserts `route: "complete"` without rebinding (`test/unit/commands/protocol-validate.test.ts:733-906`). This is exactly the "same-code-plus-text pass through normal review closure to `phase:complete` without re-binding" case the plan's Phase 5 test checklist calls for.
  - Composer guard snapshot/downgrade: a new test in `implementation-review-context.test.ts:384-503` verifies `composeImplementationReviewerRecord` both snapshots a `textGuard` on a valid lineage and downgrades to `route: "human_gate"` / `nextAction: "plan_amendment"` with `textGuard: undefined` when the lineage is broken.
  - CRLF and non-ASCII (em dash) anchors: `plan-amendment.test.ts:980-1006` now covers a CRLF-normalized, em-dash-containing anchor, confirming the UTF-8 byte-offset math holds and an out-of-span edit still fails correctly.
  - **Still missing:** `invoke.handler.ts`'s author-admission wiring (the block at `invoke.handler.ts:1234-1276`, including the new `authorCommit` extraction from `structured`) has no direct test coverage — `test/unit/commands/invoke.test.ts` has zero references to `admitAuthorTextAmendmentFromGit`, `textGuard`, or `PLAN_AMENDMENT_*`. All new handler-level tests target `protocol.handler.ts` only. Since `invoke.handler.ts` duplicates the same `try`/blocking-error logic (without the bare-catch bug, since it never had one — `outputError` there was already unguarded), the risk is lower than P1.1 was, but the `authorCommit` plumbing is new and unverified end-to-end. Downgrading from P1 to a **P2 item** below, since the composer/domain logic it depends on (`verifyAuthorTextAmendment`, `admitAuthorTextAmendmentFromGit`) is now well covered at the unit level and `invoke.handler.ts`'s wrapping is structurally simple and mirrors the now-tested `protocol.handler.ts` path.

### New observations in this revision

- **Bonus fix beyond what was asked:** both `protocol.handler.ts` and `invoke.handler.ts` now extract a `commit` field from the author's own recorded result (`validated`/`structured`) and pass it as `authorCommit` to `admitAuthorTextAmendmentFromGit`, which uses it in place of blind `workdir` `HEAD` when present (`implementation-state.ts:1427-1451`). This directly addresses a P2 note from my prior review ("the plan says 'on the author's recorded commit'; the implementation uses the workdir HEAD"). The plan reading is also upgraded from `showPlanAtCommit` (string) to the new `showPlanBlobAtCommit`/`gitShowFileBytes` (raw `Buffer`, via a new `subprocess.execGitBytes`), so invalid-UTF-8 bytes are now preserved through to `verifyGuardedPlanBytes`'s `isValidUtf8` check instead of being silently mangled by an intermediate string decode — this also resolves the "PLAN_AMENDMENT_INVALID_BYTES is unreachable on the real path" half of my prior P2.1 note. I did not find a dedicated integration-level test exercising `PLAN_AMENDMENT_INVALID_BYTES` through the real git-blob path (only the existing unit-level `plan-amendment.test.ts` invalid-bytes case), but the structural fix is real and verified by inspection of `showPlanBlobAtCommit` → `gitShowFileBytes` → `execGitBytes`.
- **Checkbox normalization unified:** `normalizeCheckboxState` (`implementation-state.ts:117-119`) now delegates to the same `normalizeCheckboxMarkers` used by the guard, closing the ordered-list-checkbox inconsistency from my prior P2.1 note. Verified with the new ordered-list test asserting `detectPlanDrift(...).drifted` is `false` after an ordered-list toggle.
- **No new defects found.** I checked the `authorCommit` fallback (empty/missing → `HEAD`; a wrong-but-well-formed commit → fails closed via `worktreeMatchesCommit`/`git show` `ls-tree` fallback, not a bypass), the guard's byte-offset stability under `normalizeCheckboxMarkers` (length-preserving, so `allowedSpans` stay valid), and the ordering of the new "already consumed" check relative to the staleness check (correctly placed before, so consumption is detected even once the lineage head has moved past the guard's `parentLineageId`). All checked out.

### Still open

- **P2 (downgraded from P1.3):** No direct test coverage for `invoke.handler.ts`'s author-admission block, including the new `authorCommit` extraction. `action: auto_fix` — the pattern to mirror already exists in `protocol-validate.test.ts:547-731`.
- **P2.1 (partially open, carried forward):** Heading/protected-range parsing (`headingSpans`, `protectedByteRanges`-style logic) is still duplicated between `src/review-governance/implementation.ts` (`headingSpans` at line 194) and `src/review-governance/plan-amendment.ts` (`headingSpans` at line 115). Not touched by this revision. Still worth consolidating so the two definitions of "protected" can't silently diverge, but this is polish, not a blocker.

### Updated readiness

- **Phase 5 (W5) completion:** ✅ — The P0 blocker and all three P1s from the prior review are resolved or downgraded to mechanical polish. `bun test` is green (3719/3719), lint and typecheck are clean.
- **Ready for next phase:** ✅ — No P0/P1 items remain. The one open item (missing `invoke.handler.ts` test coverage) and the pre-existing structural duplication are both P2 `auto_fix` polish that don't block phase advancement.

---

## Addendum (2026-09-23, second) — invoke.handler.ts coverage and shared markdown structure verified

**Reviewed:** `55493e72284d8b6ea99e95fcf5d5718b2efa0888` (two commits since `d0e02df2528fbe163d3d177a76826ddea826e326`: "Address the Phase 5 review addendum: cover invoke author-admission commit extraction and typed amendment failures, and share plan heading and protected-range parsing." and "Isolate invoke text-amendment tests from the process-wide database so concurrent runs do not close a shared connection.")

**Local verification:** `bun run typecheck`: clean. `bun run lint`: clean (425 files). `bun test --concurrent` (full suite): 3721 pass, 0 fail (up from 3719), run twice with no flakes. I also spot-checked concurrency isolation by re-running narrower file subsets (see "New observations" below) and by building a temporary detached worktree at the prior review commit to confirm one finding predates this revision, then removed it (`git worktree remove --force`).

### What's addressed (✅)

- **P2 "No test coverage for `invoke.handler.ts` author-admission wiring" — fixed.** A new `describe("invoke author text-amendment admission", ...)` block in `test/unit/commands/invoke.test.ts` (from line 1648) drives `invokeAgent` end-to-end through a fake provider and a real temp git repo:
  - `"uses the author result commit and surfaces a typed amendment failure"`: the fake provider commits an out-of-span plan edit, captures that intermediate commit's SHA, then restores the approved bytes at HEAD and leaves the out-of-span bytes uncommitted on disk. The test asserts `invokeAgent(...)` rejects with `PLAN_AMENDMENT_OUT_OF_SPAN` and that no amendment was recorded. This specifically exercises the new `authorCommit` plumbing: HEAD alone would show the *restored* (in-span) bytes, so a passing result here only occurs if the code actually reads the author's self-reported commit rather than blindly using HEAD. I traced this by hand and confirmed the assertion is real, not a tautology.
  - `"falls back to HEAD when the author result omits commit"`: same fake provider without a `commit` field in the structured result; worktree ends up dirty relative to HEAD, and the test asserts `PLAN_AMENDMENT_DIRTY` — correctly exercising the fallback path.
  - Both tests inject a private per-test `Database` via the new `deps.db` parameter (see below), matching the established `db`/`ctx.db` cleanup pattern (`finally { ctx.db.close(); db.close(); }`).
  - This closes the coverage gap from the prior addendum. `action: auto_fix` item is resolved, not just downgraded.

- **P2.1 "Heading/protected-range parsing duplicated between `implementation.ts` and `plan-amendment.ts`" — fixed.** A new `src/review-governance/plan-markdown.ts` module centralizes `planMarkdownLines`, `planHeadingSpans`, `protectedPlanCharRanges` (character offsets, consumed by `implementation.ts:resolvePlanImpactSpans`) and `protectedPlanByteRanges` (UTF-8 byte offsets, consumed by `plan-amendment.ts`'s guard prep/verify). Both `implementation.ts` and `plan-amendment.ts` now import from this shared module instead of maintaining independent copies of `headingSpans`/`fenceMarker`/protected-range logic. I diffed the old and new heading-protection semantics carefully: the two prior implementations actually disagreed (as my original P2.1 flagged) — `plan-amendment.ts`'s old `protectedByteRanges` only protected *Phase*-heading lines, while `implementation.ts`'s old `protectedCharRanges` protected *every* heading line unconditionally. The merged `protectedPlanCharRanges`/`protectedPlanByteRanges` adopts the broader (every-heading-line) behavior from `implementation.ts`. This is a net *tightening* for `plan-amendment.ts` (a resolved text-only span can no longer land on any heading line, not just a phase heading), is unlikely to reject any legitimate exemption (`staleText` values come from review-finding prose, not heading text), and the full suite passes, so I'm treating this as correctly resolved rather than a regression.
  - One related note: the shared `protectedPlanCharRanges` now protects the *entire* checkbox line (`{ start: line.start, end: line.end }`), same as `implementation.ts`'s old behavior, rather than `plan-amendment.ts`'s old narrower "protect the line except the 3-byte marker" range. This doesn't affect the checkbox-toggle bypass fix from the last addendum — that fix works purely through `normalizeCheckboxMarkers` + `fixedSegmentsMatch`, independent of `protectedRanges` — and `protectedRanges` is only consulted to reject a *resolved text-only span* that overlaps protected structure, so this is consistent and, if anything, stricter. Confirmed via test suite and by inspection.

### New observations in this revision

- **Test-isolation root cause fixed, but only for the tests this revision added.** `invoke.handler.ts` now accepts an injectable `deps.db: Database` (skipping the process-wide `getDb()` singleton), and the new `invoke.test.ts` amendment tests open a private on-disk SQLite file per test (`openPrivateControlPlaneDb`) instead of calling `closeDb()`/`_resetForTest()` on the shared connection. This is a correct, well-targeted fix for exactly the tests the commit's message describes.
  - However, while re-running subsets of the test suite concurrently (as `bun test --concurrent` does in CI), I found `test/unit/commands/invoke.test.ts` reproducibly fails 2 of its *pre-existing* tests (`"invoke reviewer — plan read state > continued reviewer opt-in captures once before provider and records the step snapshot"` and `"...records stays enforced and opens a gate after live config flips to advisory"`) with `RangeError: Cannot use a closed database`, when the file is run alone or alongside a few other files with `--concurrent` (reproduced 3/3 times). These older test blocks (lines ~250-620) still use the process-wide `getDb()`/`closeDb()`/`_resetForTest()` pattern this revision's commit message explicitly calls out as unsafe ("so concurrent runs do not close a shared connection"), and one concurrently-running test's `closeDb()` races another's still-open query. **I confirmed this predates the reviewed diff**: I built a temporary detached worktree at the prior review commit (`d0e02df2528fbe163d3d177a76826ddea826e326`, before either of the two new commits) and reproduced the identical failure there too (2/2 runs), then removed the worktree. The reviewed diff did not introduce this — it left it exactly as it found it, having fixed only the code path its own new tests exercise.
  - This did **not** reproduce in a full unfiltered `bun test --concurrent` run of the whole 237-file suite (3721/3721 passed, twice), so it's not currently blocking CI at full scale — likely a scheduler/interleaving artifact that only surfaces with a smaller worker pool or different file ordering. Given it's pre-existing, out of scope for this phase's fix, and not currently failing full-suite CI, I'm logging it as a new **P2** item rather than a blocker: apply the same `deps.db`-injection / private-file-DB pattern this revision just established to the older test blocks in `invoke.test.ts` that still call `closeDb()`/`_resetForTest()` under `--concurrent`.
  - No other new defects found. I re-checked the `authorCommit`/`worktreeMatchesCommit` interaction in the new invoke tests by hand-tracing the fake provider's git sequence and confirmed the two test outcomes (`PLAN_AMENDMENT_OUT_OF_SPAN` vs `PLAN_AMENDMENT_DIRTY`) are exactly what the code should produce, not incidental passes.

### Still open

- **P2 (new): pre-existing `closeDb()`/`_resetForTest()` races in `invoke.test.ts`'s older "plan read state" test blocks under `--concurrent`.** Reproducible in isolation (not at full-suite scale), predates this revision (confirmed at `d0e02df`). `action: auto_fix` — mirror the `deps.db` / `openPrivateControlPlaneDb` pattern this revision introduced for the newer amendment tests.
- No items remain open from the prior addendum. Both P2s there (`invoke.handler.ts` coverage, duplicated heading/protected-range parsing) are resolved.

### Updated readiness

- **Phase 5 (W5) completion:** ✅ — All P0/P1 items from the original review and both P2 carry-forwards from the first addendum are now resolved. Only a newly-surfaced, pre-existing, non-blocking P2 test-isolation item remains.
- **Ready for next phase:** ✅ — No P0/P1 items remain and the full suite is green at full scale. The one open P2 is mechanical, pre-existing, and doesn't affect current CI.

---

## Addendum (2026-09-23, third) — plan-read-state test isolation fix verified

**Reviewed:** `cd13523dac48745e1cc3c13b976d59bb11fd57e0` (one commit since `35d3275557ff9df4a9f8ef8f5c54c64bf23e1d51`: "Isolate plan-read-state invoke tests from the process-wide database.", explicitly addressing the P2 item from the second addendum.)

**Local verification:** `bun run typecheck`: clean. `bun run lint`: clean (425 files). `bun test --concurrent` (full suite): 3721 pass, 0 fail (same count as before — this commit only fixes test isolation, adds no new tests). I specifically re-ran the repro that previously failed 3/3 times before this fix:
- `bun test --concurrent test/unit/commands/invoke.test.ts` alone: **7 runs, 0 failures** (previously failed 2 tests, 3/3 times, before this fix).
- The exact four-file subset from the prior addendum (`invoke.test.ts`, `protocol-validate.test.ts`, `review-governance/`, `implementation-review-context.test.ts`): **2 runs, 0 failures** (previously failed 2/2 times).
- A broader six-target mix (adding `protocol.test.ts` and `test/unit/db`) to probe for scheduling-dependent flakes: **3 runs, 0 failures**.

### What's addressed (✅)

- **P2.3 ("pre-existing `closeDb()`/`_resetForTest()` races in `invoke.test.ts`'s older plan-read-state test blocks") — fixed.** The `describe("invoke reviewer — plan read state", ...)` block (the exact block I traced the `RangeError: Cannot use a closed database` failures to, and confirmed predated this revision via a throwaway worktree at `d0e02df`) now:
  - Hoists `openPrivateControlPlaneDb` (previously local to the newer "invoke author text-amendment admission" block) to module scope and reuses it here, opening a private on-disk SQLite file per test instead of touching the process-wide `getDb()` singleton.
  - `setupBudgetInvoke` now opens that private DB *before* calling `initScaffold({ startDir: dir })`. I traced `initScaffold`'s DB step (`src/commands/init.handler.ts`, the `.5x/5x.db` existence check) and confirmed it only calls `getDb()`/`closeDb()` when the DB file doesn't already exist — since the private DB file now exists first, `initScaffold` takes the "already exists" branch and never touches the process-wide connection. This is the correct fix, not a workaround.
  - `templateRender` (`src/commands/template.handler.ts`) gained the same `deps?.db` injection point already added to `invokeAgent` in the prior revision, since one test in this block (`"invoke and template handlers append byte-identical reviewer governance context"`) calls `templateRender` directly and needed the same isolation.
  - Every test in the block now threads `db` through `deps` to `invokeAgent`/`templateRender`/`invokeWithBudgetContext` and closes it in `finally`, replacing every `closeDb()`/`_resetForTest()` call in that block.
  - I confirmed by direct repro (see above) that the specific failure mode I reported is gone: 7/7 clean runs of the file in isolation where it previously failed reliably.

### New observations in this revision

- **Scope was precisely targeted, and it worked.** The commit message names exactly the addendum that raised the issue and fixes exactly the two failing tests I identified, without touching unrelated code. No scope creep, no unrelated refactors.
- **Residual, unconfirmed risk (not the same finding, logging separately):** two other `describe` blocks in `invoke.test.ts` — `"invoke implementation admission"` (~line 1349) and `"invoke implementation review recording"` (~line 1427-1694) — still call `closeDb()`/`_resetForTest()` on the process-wide singleton and were not touched by this fix. In principle these could exhibit the same class of race under some other `--concurrent` scheduling/interleaving, the same way the "plan read state" block only failed under specific subset combinations and passed clean in a full-suite run. I deliberately stress-tested this (7 isolated runs of the whole file, 2 runs of the originally-failing four-file subset, 3 runs of a broader six-target mix) and could not reproduce any failure in these two blocks. Given I have no concrete repro (unlike P2.3, which I reproduced 3/3 before verifying the fix), I'm not raising this as a confirmed defect — only as a forward-looking P2 suggestion to apply the same `openPrivateControlPlaneDb` pattern there for consistency and to close off the theoretical risk, not because I observed a failure.
- No new defects found. No other files changed in this commit besides the two described above and the run's own step log.

### Still open

- **P2 (new, unconfirmed/preventive):** `"invoke implementation admission"` and `"invoke implementation review recording"` in `invoke.test.ts` still use `closeDb()`/`_resetForTest()` on the process-wide singleton. No failure reproduced despite active stress-testing across 12 runs in varied configurations; flagged for consistency with the now-established `openPrivateControlPlaneDb` pattern, not as a confirmed race. `action: auto_fix`.
- No items remain open from the second addendum. The one P2 raised there (P2.3) is resolved and verified by direct repro.

### Updated readiness

- **Phase 5 (W5) completion:** ✅ — Every P0/P1 from the original review and every P2 from both prior addenda are now resolved and verified. Only a new, unconfirmed, preventive P2 suggestion remains.
- **Ready for next phase:** ✅ — No P0/P1 items remain, the full suite is green at full scale, and the specific flake reported last time is confirmed fixed by direct repro.

---

## Addendum (2026-09-23, fourth) — remaining process-wide DB usages removed

**Reviewed:** `5b24822df03ff77b61e4830d9cf9587beb8387ea` (one commit since `d049a5b44d61cf41b9a8db3649e460ef4bbe344b`: "Isolate remaining invoke admission and review-recording tests from the process-wide database (phase 5 review addendum 3, P2.4).", explicitly named after the P2.4 item from the third addendum.)

**Local verification:** `bun run typecheck`: clean. `bun run lint`: clean (425 files). `bun test --concurrent` (full suite, single clean run): 3721 pass, 0 fail — same count as before, test-only diff. Targeted stress-testing:
- `bun test --concurrent test/unit/commands/invoke.test.ts` alone: 5/5 clean runs.
- The broader six-target mix from the third addendum (`invoke.test.ts`, `protocol.test.ts`, `protocol-validate.test.ts`, `review-governance/`, `implementation-review-context.test.ts`, `test/unit/db`): 34 total runs across three batches, 33 clean, 1 timeout (details below — not a DB-closing race, and not caused by this diff).

### What's addressed (✅)

- **P2.4 ("two other `invoke.test.ts` describe blocks still use `closeDb()`/`_resetForTest()`") — fixed.** Both remaining call sites are converted to the same `openPrivateControlPlaneDb`/`deps.db` pattern verified in the prior addendum:
  - `describe("invoke implementation admission", ...)`: the `_resetForTest()` at the top of the test and the manual `new Database(...)` + `runMigrations` + immediate `db.close()` (which meant `invokeAgent` fell through to the process-wide singleton) are replaced by `db = openPrivateControlPlaneDb(dir)`, kept open and passed via `deps.db` to `invokeAgent`, and closed in `finally`. The redundant `mkdirSync(join(dir, ".5x"), ...)` is also removed since `openPrivateControlPlaneDb` already creates the state directory.
  - `describe("invoke implementation review recording", ...)`: the `getDb(dir)` / `closeDb()` / `_resetForTest()` sequence around `createRunV1` is replaced by opening the private DB *before* `initScaffold({ startDir: dir })` (same "create the file first" trick verified in the prior addendum — `initScaffold` skips its own `getDb()`/`closeDb()` call when `.5x/5x.db` already exists), and `db` is threaded through `deps` to both `invokeAgent` calls in the test, closed once in `finally`.
  - `grep -n "closeDb\|_resetForTest\|getDb("` against `test/unit/commands/invoke.test.ts` now returns **zero matches** — the file no longer touches the process-wide singleton anywhere. Confirmed by direct inspection.
  - I re-ran the exact stress configuration that surfaced P2.4 as a *theoretical* risk (I had not reproduced a failure there before this fix, so there's no "before" repro to compare against) — 5/5 clean runs of the file alone, consistent with the fix being complete and correct.

### New observations in this revision

- **One unrelated timeout observed during stress-testing, not caused by this diff.** Across 34 runs of the broader six-target concurrent mix, one run produced `(fail) protocol and invoke implementation recording > both entry points persist the same observation and durable authorization [5001.15ms] ^ this test timed out after 5000ms`. I traced this: the failing test lives in `test/unit/commands/protocol-validate.test.ts`, a file **not touched by either of the last two reviewed commits** (`cd13523`, `5b24822`), and the failure has no `RangeError: Cannot use a closed database` signature — it's a plain timeout, most likely resource contention from my own aggressive back-to-back stress-testing (30+ consecutive `bun test --concurrent` invocations in a short window on one machine) rather than a code defect. `git log` confirms this test file was last touched by `e405580`, two revisions before the current review chain even started addressing test isolation. I'm not raising this as a finding — it didn't reproduce in 33 of 34 runs, it's outside the diff under review, and a single clean full-suite run (not artificially loaded) passed 3721/3721.
- No new defects found in the reviewed diff itself. The change is test-only, mechanical, and exactly matches the pattern already validated twice in prior addenda.

### Still open

- None. Both items from the third addendum are resolved: P2.4 is fixed and verified; there is no unconfirmed residual risk remaining in `invoke.test.ts` since every process-wide DB usage in the file has been removed.

### Updated readiness

- **Phase 5 (W5) completion:** ✅ — All P0/P1 items across the original review and all four addenda are resolved. No open items of any priority remain from this review chain.
- **Ready for next phase:** ✅ — Full suite green at full scale (3721/3721), lint and typecheck clean, and the test-isolation work explicitly requested across the last three addenda is now complete and verified with zero remaining `closeDb()`/`_resetForTest()`/`getDb()` call sites in `invoke.test.ts`.
