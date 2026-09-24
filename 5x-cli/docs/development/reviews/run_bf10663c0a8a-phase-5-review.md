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
