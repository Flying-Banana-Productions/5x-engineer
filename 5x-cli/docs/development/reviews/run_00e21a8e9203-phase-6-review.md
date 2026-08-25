# Review: Prompt Queue Foundation — Phase 6 Prompt Command Integration

**Review type:** `9f0c4fd63a8eb23a871129ff7426c7887b0cb998`  
**Scope:** Persist-then-wait integration for `prompt choose`, `confirm`, and `input`, including CAS, timeout, stdin/pipe cancellation, lifecycle handling, and CLI coverage.  
**Reviewer:** Staff engineer (correctness, concurrency, reliability, operability, security, tests)  
**Local verification:** `bun run lint` (passed); `bun test test/unit/commands/prompt-store.test.ts test/unit/commands/prompt-context.test.ts test/integration/commands/prompt.test.ts` (72 passed); `bun test test/integration/commands/prompt.test.ts` (39 passed). `bun test` exceeded the 120 s review-command limit without a completed result.

**Implementation plan:** `docs/development/plans/205-prompt-queue-foundation-plan.md`  
**Technical design:** N/A

## Summary

Phase 6 correctly moves all prompt variants to a persisted `PromptStore` flow, preserves the success-envelope shapes, and implements the intended cancellable store/input/timeout race. The context boundary keeps SQLite and run lookup dependencies out of the handler, while the focused unit and temp-project integration tests cover CAS winners, pipe cancellation, lifecycle outcomes, EOF distinctions, and normal compatibility paths. One small explicit `--run` validation edge case remains: an explicitly supplied empty run id bypasses `runExists` and is silently persisted as an unassociated prompt.

**Readiness:** Ready with corrections — the race and persistence implementation is sound; close the empty `--run` validation bypass before relying on run association as an audit boundary.

---

## What shipped

- **Prompt context and persistence:** Commands resolve one prompt context, verify run association, create durable rows, and use CAS results for the existing output envelopes.
- **Race orchestration:** TTY reads, multiline reads, piped input, polling, timeout, and lifecycle cancellation share dual abort controllers and clean up losing branches.
- **Compatibility and tests:** Strict timeout flags, kind-aware EOF, no-TTY defaults, non-interactive abandonment, and isolated temporary-project integration coverage were added.

---

## Strengths

- The handler remains independent of `bun:sqlite`, `resolveDbContext`, and `getRunV1`; the injected context is a clean forward-compatible control-plane seam.
- Poll errors are converted to race outcomes, including the required poll-only lifecycle path, avoiding unhandled rejections and dangling waiters.
- Input EOF remains a successful terminal answer while choose/confirm EOF is abandoned, preserving the specified envelope behavior.
- Temp-project integration setup prevents prompt commands from creating or mutating the repository control-plane database during tests.
- Timeout parsing uses the strict shared integer parser before prompt creation, and focused tests cover invalid values and no-row behavior.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

- **P2.1 — Empty `--run` bypasses run validation** (`auto_fix`): `if (params.run && !runExists(params.run))` treats an explicitly supplied empty argument as absent, and `runId: params.run ?? null` then stores it as `null`. Use an `undefined` presence check for validation and persistence, and add CLI/unit coverage for `--run ""` yielding `RUN_NOT_FOUND` with no prompt row. This restores the plan requirement that every supplied `--run` be checked before insertion. (`src/commands/prompt.handler.ts:490, 608, 710`)

---

## Readiness checklist

**P0 blockers**
- [x] Persist-before-wait, store/terminal CAS behavior, cancellation, timeout, and EOF semantics are implemented and covered by focused tests.

**P1 recommended**
- [x] No pre-Phase-7 P1 correction identified.

**P2 follow-up**
- [ ] Validate an explicitly supplied empty `--run` rather than treating it as an omitted run.
