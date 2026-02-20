# Review: 5x CLI Phase 5 (Phase Execution Loop)

**Review type:** `f78c3d7a`  \
**Scope:** `5x run`, `5x worktree`, phase-execution orchestrator loop, git + quality + human gates, tests, plan doc updates  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, performance, operability, test strategy)  \
**Local verification:** `cd 5x-cli && bun test` PASS (288 pass, 1 skip); `bun run typecheck` PASS; `bun run lint` PASS

**Implementation plan:** `5x-cli/docs/development/001-impl-5x-cli.md`  \
**Technical design:** N/A

## Summary

Commit `f78c3d7a` lands the Phase 5 execution loop: `5x run` drives per-phase author->quality->review->auto-fix cycles with DB journaling, and adds worktree tooling (`5x worktree`) plus git safety + quality gate runners. The architecture continues the Phase 4 pattern well (explicit state machine, DB as SOT, log artifacts on disk, strong unit coverage).

Main correctness gap: worktree execution is not actually isolated because the orchestrator and templates use absolute `plan_path`/`review_path` outside the worktree; this breaks the mental model of `--worktree` and can lead to code commits in the worktree branch while plan/review artifacts are written to the primary checkout. Second gap: the “resume” story is not implemented as documented (state/iteration are not restored, and “review then rerun” doesn’t reliably continue).

**Readiness:** Ready with corrections - fix P0 worktree path mapping + resume semantics before starting Phase 6.

---

## What shipped

- **Phase execution loop:** state machine for `5x run` with DB run/events/results recording and auto-fix routing (`5x-cli/src/orchestrator/phase-execution-loop.ts`).
- **Quality gates:** sequential command runner with log files + truncated inline output persisted to DB (`5x-cli/src/gates/quality.ts`).
- **Git + worktrees:** git safety checks and basic branch/worktree helpers (`5x-cli/src/git.ts`); `5x worktree status|cleanup` CLI (`5x-cli/src/commands/worktree.ts`).
- **Human gates:** terminal prompts for phase gates, escalations, resume, stale locks (`5x-cli/src/gates/human.ts`).
- **CLI wiring:** `5x run` command (`5x-cli/src/commands/run.ts`) and exports (`5x-cli/src/index.ts`).
- **Tests:** substantial new coverage for git, quality gates, human gates, and orchestrator behaviors.

---

## Strengths

- **State machine readability:** explicit states + run_events journaling makes failures diagnosable and future refactors safer (`5x-cli/src/orchestrator/phase-execution-loop.ts`).
- **Fail-safe routing:** missing `5x:status`/`5x:verdict` escalates rather than guessing; non-ready/no-items escalates (good safety posture).
- **Pragmatic persistence:** DB stores structured signals/results; full logs go to disk (sane size/retention tradeoff).
- **Good unit coverage:** core happy paths + quality retry + auto-fix loops + missing-signal escalations are directly tested.

---

## Production readiness blockers

### P0.1 - Worktree mode is not isolated (plan/review/log paths escape the worktree)

**Risk (correctness/security-of-process):** With `--worktree` (or an existing DB-associated worktree), `5x run` invokes agents in the worktree but provides absolute `plan_path`/`review_path` from the primary checkout; reviewers/authors will write artifacts outside the worktree, and phase completion bookkeeping (plan checkboxes) can diverge from code commits. This defeats the safety guarantees of worktrees and creates hard-to-debug split-brain state.

**Requirement:** When `workdir !== projectRoot`, all file paths passed to agents and all orchestrator reads/writes must resolve to the corresponding paths *inside* the worktree (and be validated to remain within the worktree). Logs should be anchored to a single predictable root (recommend: `projectRoot/.5x/logs/<run-id>/` since DB/locks live there).

**Implementation guidance:**
- In `5x-cli/src/commands/run.ts`, compute `planPathRel = path.relative(projectRoot, canonicalPlanPath)`; if it starts with `..`, abort. Use `planPathInWorkdir = resolve(workdir, planPathRel)` when `workdir !== projectRoot`.
- Similarly map `reviewPath` into the worktree (use `path.relative(projectRoot, reviewPath)` then resolve under `workdir`), and pass the mapped paths into `runPhaseExecutionLoop()`.
- In `5x-cli/src/orchestrator/phase-execution-loop.ts`, anchor `logBaseDir` to `projectRoot` (pass it in via options) rather than `dirname(planPath)`.
- Add a regression test where `workdir` is different from the plan/review path root and assert the orchestrator reads/writes the in-workdir copies.

### P0.2 - Resume behavior does not resume at the recorded state/iteration

**Risk (correctness/operability):** `runPhaseExecutionLoop()` prompts for resume but always restarts phases from `EXECUTE`, does not restore the last state, and derives `iteration` from `getAgentResults().length` (not the phase-local step identity). The `PHASE_GATE` “review” path instructs users to rerun to continue, but reruns won’t reliably skip already-completed steps. This can cause duplicate agent executions, inconsistent DB state, and user confusion.

**Requirement:** “Resume” must re-enter the phase loop at the recorded `runs.current_state` + `runs.current_phase`, with a deterministic step identity (iteration) derived from DB state for that phase; completed steps must be skipped (or re-run idempotently) in a way that matches the stored composite unique key.

**Implementation guidance:**
- Persist and restore state: initialize `state` from `activeRun.current_state` when resuming; if missing/unknown, escalate.
- Derive `iteration` as `max(agent_results.iteration) + 1` for that `run_id` + phase (or store iteration explicitly in `runs`).
- Add tests: resume from mid-phase (e.g., after author EXECUTE + QUALITY_CHECK but before REVIEW), and resume from the PHASE_GATE “review” abort path.

---

## High priority (P1)

### P1.1 - Quality gate runner reads full output into memory (OOM risk on large outputs)

`runSingleCommand()` buffers full stdout+stderr into strings before writing logs (`5x-cli/src/gates/quality.ts`). Large test/build logs can be tens/hundreds of MB.

Recommendation: stream stdout/stderr directly to the log file while also maintaining a bounded in-memory ring buffer (first/last N bytes) for the truncated inline output.

### P1.2 - Phase identity stored as `Number(phase.number)` risks collisions and bad resume/startPhase behavior

The execution loop uses `Number(phase.number)` for DB keys and resume/start computations (`5x-cli/src/orchestrator/phase-execution-loop.ts`). This loses string fidelity (e.g., `1.10` and `1.1` collapse to the same numeric value) and makes plan compliance brittle.

Recommendation: treat phase identity as a string label in DB (schema migration) or store a separate stable ordinal index for DB identity while preserving the label for user-facing `--phase` routing.

### P1.3 - Operability gaps in run event journaling and human guidance plumbing

- Some escalation paths push into `escalations` without appending a matching `run_event` (harder to debug via DB).
- `EscalationResponse.guidance` is collected but ignored (human “continue with guidance” has no effect).
- Phase gate summary hard-codes `reviewVerdict: "ready"` even when the actual verdict was `ready_with_corrections` and auto-fixed.

Recommendation: make event logging consistent for every escalation transition; plumb guidance into the next author invocation (e.g., `user_notes`); compute phase summary from DB (latest verdict, quality result, files changed if desired).

---

## Medium priority (P2)

- **Plan compliance drift:** plan doc lists “git branch validation/creation at phase start” but the orchestrator does not enforce it; either implement a minimal invariant (relevant branch) or update the plan.
- **Logs location consistency:** today logs are derived from `dirname(planPath)`; prefer a single project-level `.5x/` root for all artifacts.
- **Worktree cleanup UX:** `--force` removal is destructive; emit an explicit data loss warning before proceeding.

---

## Readiness checklist

**P0 blockers**
- [ ] Fix worktree path mapping so plan/review/log artifacts are in-worktree (P0.1).
- [ ] Implement real resume-at-state behavior with deterministic iteration/skip semantics (P0.2).

**P1 recommended**
- [ ] Stream/bound quality gate output to avoid OOM (P1.1).
- [ ] Fix phase identity persistence (string/ordinal) (P1.2).
- [ ] Improve run event journaling + guidance plumbing + phase summary accuracy (P1.3).

---

## Readiness assessment vs implementation plan

- **Phase(s) implemented:** Phase 5 in `5x-cli/docs/development/001-impl-5x-cli.md` (Phase Execution Loop).
- **Phase 5 completion:** ⚠️ - core loop exists and is tested, but worktree isolation + resume semantics do not meet the phase completion gate.
- **Ready for next phase (Phase 6: OpenCode Adapter):** ⚠️ - proceed after P0.1/P0.2; Phase 6 will amplify any workdir/path/resume inconsistencies.

<!-- 5x:verdict
protocolVersion: 1
readiness: ready_with_corrections
reviewPath: 5x-cli/docs/development/reviews/2026-02-17-5x-cli-phase-5-phase-execution-loop-review.md
items:
  - id: p0-1
    title: Map plan/review/log paths into the worktree when --worktree is active
    action: auto_fix
    reason: Current absolute paths break worktree isolation and split artifacts across checkouts
  - id: p0-2
    title: Implement resume-at-state semantics with deterministic iteration/skip behavior
    action: auto_fix
    reason: Resume currently restarts at EXECUTE and iteration derivation does not match step identity
  - id: p1-1
    title: Stream or bound quality gate output capture to avoid OOM on large logs
    action: auto_fix
    reason: Current implementation buffers full stdout/stderr into memory before writing logs
  - id: p1-2
    title: Persist phase identity as a stable label or ordinal (avoid Number(phase.number) collisions)
    action: auto_fix
    reason: Numeric coercion can collapse distinct phase labels and break resume/startPhase routing
  - id: p1-3
    title: Make run event journaling and human guidance plumbing consistent across all escalation paths
    action: auto_fix
    reason: Missing events and ignored guidance reduce debuggability and make human intervention less effective
-->

---

## Addendum (2026-02-17) - Re-review after remediation

**Reviewed:** `256ce393c90`  \
**Local verification:** `cd 5x-cli && bun test` PASS (294 pass, 1 skip); `bun run typecheck` PASS; `bun run lint` PASS

### What's addressed (✅)

- **P0.1 worktree isolation:** `5x run` remaps `planPath`/`reviewPath` into the worktree; logs are anchored to `projectRoot/.5x/logs/` via the new `projectRoot` option (`5x-cli/src/commands/run.ts`, `5x-cli/src/orchestrator/phase-execution-loop.ts`).
- **P0.2 resume-at-state:** resume restores `current_state`, derives per-phase `iteration` via `getMaxIterationForPhase()+1`, restores `qualityAttempt` via `getQualityAttemptCount()`, and adds regression tests for resuming from mid-phase states (`5x-cli/src/db/operations.ts`, `5x-cli/src/orchestrator/phase-execution-loop.ts`, `5x-cli/test/orchestrator/phase-execution-loop.test.ts`).
- **P1.1 bounded quality output:** quality gates now stream stdout to log files and capture bounded inline output via `BoundedCapture` (prevents stdout OOM in practice) (`5x-cli/src/gates/quality.ts`).
- **P1.2 phase identity fidelity:** phase columns are now TEXT throughout schema + operations + orchestrators, removing `Number(phase.number)` collisions and preserving labels like `1.10` (`5x-cli/src/db/schema.ts`, `5x-cli/src/db/operations.ts`, `5x-cli/src/orchestrator/*.ts`).
- **P1.3 operability plumbing:** escalation run_events added for more paths, escalation guidance is plumbed into the next author invocation via `user_notes`, and phase gate summary reads the actual DB verdict (`5x-cli/src/orchestrator/phase-execution-loop.ts`).
- **P2 polish:** worktree cleanup warns on `--force` data loss; branch relevance warning added at phase start; plan doc updated (`5x-cli/src/commands/worktree.ts`, `5x-cli/src/orchestrator/phase-execution-loop.ts`, `5x-cli/docs/development/001-impl-5x-cli.md`).

### Remaining concerns

- **Schema upgrade path for existing DBs:** phase columns were changed to TEXT in migration v1, but there is no new migration version to convert already-created DBs. If a user has an existing `.5x/5x.db` with INTEGER-affinity phase columns, storing phase labels like `"1.10"` may still coerce/collapse. Add a migration (v2) that rebuilds affected tables (or detect old schema and require an explicit DB reset).
- **Quality gate stderr still unbounded:** stdout is streamed, but stderr is buffered into `stderrChunks` (still OOMable) and the timeout path overwrites any partially-written log file with a single timeout message. Stream stderr as well (optionally with a single `--- stderr ---` marker) and preserve partial output on timeout.
- **Worktree remap assumptions:** review path remap is conditional on `reviewPath` being under `projectRoot`; if a user config points reviews outside the repo, worktree isolation becomes partial. Recommend warning loudly (or failing) when `--worktree` is active and `reviewPath` cannot be remapped.

### Updated readiness

- **Phase 5 completion:** ✅ - primary blockers (worktree artifact isolation and resume correctness) are addressed with regression coverage.
- **Ready for next phase (Phase 6: OpenCode Adapter):** ✅ - proceed; remaining items are mechanical hardening.

<!-- 5x:verdict
protocolVersion: 1
readiness: ready_with_corrections
reviewPath: 5x-cli/docs/development/reviews/2026-02-17-5x-cli-phase-5-phase-execution-loop-review.md
items:
  - id: p1-1
    title: Add a DB migration (or explicit reset detection) for phase columns changing to TEXT
    action: auto_fix
    reason: Existing DBs may retain INTEGER affinity and still coerce/collapse phase labels like "1.10"
  - id: p1-2
    title: Stream stderr and preserve partial logs on quality gate timeout to fully eliminate OOM/log-loss risk
    action: auto_fix
    reason: stderr is still buffered unbounded and timeout handling currently overwrites the log file
  - id: p2-1
    title: Warn or fail when worktree mode cannot remap reviewPath into the worktree
    action: auto_fix
    reason: Configured reviews dir outside projectRoot makes worktree isolation partial and surprising
-->

---

## Addendum (2026-02-17) - Re-review after follow-up hardening

**Reviewed:** `beda2ca6ee`  \
**Local verification:** `cd 5x-cli && bun test` FAIL (1 fail, 293 pass, 1 skip); `bun run typecheck` PASS; `bun run lint` PASS

### What's addressed (✅)

- **P1.2 quality gate stderr bounded + timeout preserves partial logs:** stderr is now streamed with `BoundedCapture` instead of buffered unbounded, and timeout handling appends a marker instead of overwriting the log file (`5x-cli/src/gates/quality.ts`).
- **P2.1 worktree unmappable reviewPath:** `5x run --worktree` now emits a loud warning when `reviewPath` cannot be remapped into the worktree because it is outside `projectRoot` (`5x-cli/src/commands/run.ts`).

### Remaining concerns

- **P0: quality gate log file can be empty immediately after return:** `runSingleCommand()` uses a Node `WriteStream` but does not await flush/close after `logStream.end()`. This shows up as a deterministic unit test failure (`test/gates/quality.test.ts`) where `readFileSync(outputPath)` returns empty string. This is both a test/CI blocker and a correctness/operability bug (log artifacts are part of the debugging contract).
- **Schema upgrade path (deferred per branch-local assumption):** per note, OK to skip migration/upgrade handling while this branch remains local and `.5x/` isn’t created. If this ever lands on a shared branch, the TEXT phase-column change needs a migration story.

### Updated readiness

- **Phase 5 completion:** ⚠️ - blocked on fixing the quality gate log flush bug so tests go green.
- **Ready for next phase (Phase 6: OpenCode Adapter):** ⚠️ - proceed after the P0 test regression is fixed.

<!-- 5x:verdict
protocolVersion: 1
readiness: ready_with_corrections
reviewPath: 5x-cli/docs/development/reviews/2026-02-17-5x-cli-phase-5-phase-execution-loop-review.md
items:
  - id: p0-1
    title: Await quality gate log stream flush/close before returning to guarantee log artifacts are durable
    action: auto_fix
    reason: Current implementation can return before writes flush, producing empty/partial logs and failing tests
  - id: p2-1
    title: If this branch is ever shared, add a DB migration plan for INTEGER->TEXT phase columns
    action: human_required
    reason: You indicated this is intentionally deferred for branch-local development; if merging, policy decision needed (migrate vs force-reset)
-->

---

## Addendum (2026-02-17) - Re-review after log flush fix

**Reviewed:** `4aa0487`  \
**Local verification:** `cd 5x-cli && bun test` PASS (294 pass, 1 skip); `bun run typecheck` PASS; `bun run lint` PASS

### What's addressed (✅)

- **P0 quality gate log durability:** `runSingleCommand()` now awaits write stream flush via a promisified `endStream()` before returning, eliminating the empty-log race and restoring deterministic test behavior (`5x-cli/src/gates/quality.ts`).

### Remaining concerns

- No further required changes for Phase 5 on this branch.
- Schema upgrade path remains intentionally out-of-scope while this branch is local and `.5x/` isn’t created; if you later merge/share, revisit migrations/reset policy.

### Updated readiness

- **Phase 5 completion:** ✅
- **Ready for next phase (Phase 6: OpenCode Adapter):** ✅

<!-- 5x:verdict
protocolVersion: 1
readiness: ready
reviewPath: 5x-cli/docs/development/reviews/2026-02-17-5x-cli-phase-5-phase-execution-loop-review.md
items: []
-->
