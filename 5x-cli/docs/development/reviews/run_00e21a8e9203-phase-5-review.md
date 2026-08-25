# Review: Prompt Queue Foundation — Phase 5 Cancellable Stdin and Poll Helper

**Review type:** `fee342ab1129130d7a27bed3acc5a6c2830990cc`  
**Scope:** Phase 5 cancellable TTY/pipe readers and bounded prompt polling.  
**Reviewer:** Staff engineer (correctness, reliability, operability, tests)  
**Local verification:** `bun test test/unit/utils/stdin-abort.test.ts test/unit/control-plane/wait.test.ts` (18 passed); `bun test test/unit/` (2,115 passed); `bun run lint` (passed).

**Implementation plan:** `docs/development/plans/205-prompt-queue-foundation-plan.md`  
**Technical design:** N/A

## Summary

Phase 5 delivers abort-aware `readLine`, `readAll`, and piped-stdin readers, including the required distinct `ABORTED` and multiline-SIGINT outcomes. It also adds the 250 ms prompt-store polling helper with typed timeout, abandonment, and cancellation outcomes. The implementation satisfies the phase completion gate and is ready for Phase 6 wiring.

**Readiness:** Ready — required behavior and focused regression coverage are present; unit suite and lint pass.

---

## What shipped

- **Cancellable stdin:** TTY line/all readers clean up listeners on abort, while pipe reads cancel their stream reader.
- **Prompt waiting:** `waitForPromptAnswer` polls the store without busy-spinning and exits predictably for answer, abandonment, timeout, missing rows, and cancellation.
- **Regression coverage:** Focused tests exercise cancellation cleanup, SIGINT multiline behavior, stream-end semantics, pipe cancellation, and polling outcomes.

---

## Strengths

- `ABORTED` remains distinct from EOF and SIGINT, preserving the Phase 6 lifecycle classification contract.
- `readAll` now discards partial input on SIGINT while retaining empty and non-empty stream-end text as successful input.
- The poll helper uses injectable clock and sleep dependencies, making timeout and cancellation tests deterministic.
- The abortable sleep path prevents a cancellation from scheduling another store poll.

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
- [x] No pre-Phase-6 corrections required.
