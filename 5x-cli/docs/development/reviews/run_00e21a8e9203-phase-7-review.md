# Review: Prompt Queue Foundation — Phase 7 Completion

**Review type:** `6f76cfb828b2728b868bce1875e9c83cc42dbca4` and follow-ons  
**Scope:** Phase 7 concurrency/lifecycle hard gates, CLI compatibility, documentation, and overall production readiness for the prompt-queue foundation.  
**Reviewer:** Staff engineer (signal safety, concurrency, compatibility, persistence, operability, security, tests)  
**Local verification:** `bun run lint` (passed); `bun test test/integration/commands/prompt-queue.test.ts --concurrent` (9 passed); focused prompt/store tests (80 passed); `bunx tsc --noEmit` (failed: 2 TypeScript errors); full `bun test` did not complete within the 120 s review limit.

**Implementation plan:** `docs/development/plans/205-prompt-queue-foundation-plan.md`  
**Technical design:** N/A

## Summary

Phase 7 adds the required real-process SIGINT, SIGTERM, and poll-only SIGINT gates, plus CAS, timeout, pipe-vs-store, doctor repair, run-watch compatibility, and contract documentation. The focused runtime gates pass and the implementation retains the planned store boundary, first-writer-wins semantics, durable abandonment, and existing success envelopes. However, the newly added integration test does not type-check, so the package's `prepublishOnly` quality gate fails and this cannot be considered production-ready until corrected.

**Readiness:** Ready with corrections — runtime Phase 7 gates pass, but the committed test source breaks the required typecheck/prepublish gate.

---

## What shipped

- **Real-process lifecycle gates:** Spawned CLI tests validate persisted interruption and 130/143 envelopes for TTY SIGINT/SIGTERM and poll-only SIGINT.
- **Concurrency and compatibility coverage:** SQLite CAS, TTY/store winner behavior, timeout, hanging-pipe/store races, doctor repair, and `run watch` SIGINT behavior are exercised.
- **Contract documentation:** v1/v2 control-plane, doctor, overview, and plan-input documentation now describe the shipped local PromptStore contract and limits.

---

## Strengths

- The integration tests use isolated temporary git projects and migrated databases, preventing repository DB contamination.
- The real-process SIGTERM test specifically proves the lifecycle signal reaches a wait that stdin itself cannot observe.
- The CAS tests verify both first-writer-wins storage and loser visibility of the winning payload.
- Documentation accurately preserves the non-breaking JSON success envelopes while documenting new timeout and abandonment behavior.
- The public API exports the PromptStore abstraction and factories without exposing handler SQL concerns.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — Phase 7 integration test breaks the package typecheck (`auto_fix`)

`collect()` accepts `ReturnType<typeof Bun.spawn>`, which Bun types as a union including a non-process overload. Consequently `proc.stdout` and `proc.stderr` are inferred as `number | ReadableStream | undefined`, and wrapping them in `Response` fails TypeScript compilation. `bun run typecheck` is part of `prepublishOnly`; this blocks release even though the runtime test passes.

**Recommendation:** Type the spawned process as the concrete process overload (or narrow/assert its stdio streams in `spawnPrompt`/`collect`) so `proc.stdout` and `proc.stderr` are known readable streams, then run the package typecheck.

**Location:** `test/integration/commands/prompt-queue.test.ts:151-152`

---

## Medium priority (P2)

None.

---

## Readiness checklist

**P0 blockers**
- [x] Required real-process SIGINT, SIGTERM, and poll-only SIGINT coverage is present and passes.
- [x] CAS, timeout, pipe/store, doctor repair, and run-watch compatibility coverage is present and passes.

**P1 recommended**
- [ ] Correct the concrete spawned-process typing and obtain a clean `bun run typecheck` / prepublish gate.

---

## Addendum (2026-08-25) — Overall assessment

**Reviewed:** `6f76cfb828b2728b868bce1875e9c83cc42dbca4`

### What's addressed (✅)
- **Phase 7 hard gates:** The required end-to-end lifecycle and poll-only signal behaviors are covered by real child processes, including durable `interrupted` abandonment before exit.
- **Plan compliance:** The Phase 7 test, export, doctor-order, and documentation deliverables are represented in the committed diff.

### Remaining concerns
- **P1.1:** The added test has a deterministic TypeScript error, which fails the configured release quality gate.
- The full suite exceeded the 120-second review command limit; focused Phase 7 and adjacent prompt tests passed, but a completed full-suite run is still needed after the typing correction.

### Updated readiness
- **Phase 7 completion:** ⚠️ — functional gates pass, pending the derivable typecheck correction.
- **Ready for next phase:** ⚠️ — after P1.1 is corrected and the complete configured quality suite is green.

---

## Addendum (2026-08-25) — Spawned-process typing correction

**Reviewed:** `c035c11f26126d6574690e5590b0737643235e97`

### What's addressed (✅)
- **P1.1 — Phase 7 integration-test spawned-process typing:** The prompt-queue spawn helper now returns the concrete `Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">` type, so `collect()` and `killLater()` no longer receive Bun's broad overload union. The prior `Response(proc.stdout/stderr)` TypeScript errors are resolved.
- **Quality verification:** `bun run typecheck` passed; `bun run lint` passed; the Phase 7 integration suite passed (9 tests); focused prompt/store regression coverage passed (80 tests); and the configured full suite, `bun run test`, passed (2,828 tests across 163 files).

### Remaining concerns
- None identified in the follow-on diff or verification.

### Updated readiness
- **Phase 7 completion:** ✅ — all plan hard gates, the release typecheck, focused regressions, and the full configured suite are green.
- **Ready for next phase:** ✅
