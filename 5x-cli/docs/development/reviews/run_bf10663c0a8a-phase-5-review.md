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
