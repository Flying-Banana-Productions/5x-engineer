# Review: 5x CLI OpenCode Refactor — Phase 4 Execution (Orchestrator Refactor)

**Review type:** `22bece66a3`  \
**Scope:** Phase 4 of `docs/development/003-impl-5x-cli-opencode.md` (remove `PARSE_*` states; route on typed structured outputs; add structured audit records; update orchestrator + tests; adjust command wiring to single adapter param)  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, performance, operability, test strategy)  \
**Local verification:** `bun test` in `5x-cli/` (354 pass, 1 skip)

**Implementation plan:** `docs/development/003-impl-5x-cli-opencode.md` (Phase 4)  \
**Technical design:** `docs/development/001-impl-5x-cli.md` (baseline)

## Summary

This commit lands the core Phase 4 simplification: both orchestrator loops now call `AgentAdapter.invokeForStatus()` / `invokeForVerdict()` and route on typed results directly, eliminating the `PARSE_*` states and all free-text signal parsing. It also adds an append-only, base64url-encoded structured audit trail in review artifacts and updates orchestrator tests (including legacy-resume compatibility).

The main staff-level risks are around Phase 5 readiness: command-layer adapter lifecycle is not yet correct (no `adapter.close()`), the OpenCode factory is still stubbed, and `5x run` worktree mode appears to split DB identity (primary plan path vs worktree plan path), which will break resume/history continuity.

**Readiness:** Ready with corrections — Phase 4 is in good shape and well-tested; address P0s early in Phase 5 before enabling the real adapter/factory.

---

## What shipped

- **Phase execution loop:** `5x-cli/src/orchestrator/phase-execution-loop.ts` removes `PARSE_*` states; invokes adapter directly; validates routing invariants; adds backward-compat resume mapping; appends structured audit records.
- **Plan review loop:** `5x-cli/src/orchestrator/plan-review-loop.ts` same refactor pattern; legacy resume mapping; structured audit append.
- **Audit writer:** `5x-cli/src/utils/audit.ts` `appendStructuredAuditRecord()` writes `<!-- 5x:structured:v1 <base64url(JSON)> -->` records.
- **Escalation helpers:** `5x-cli/src/utils/agent-event-helpers.ts` simplified to log-path-inclusive escalation reason formatting.
- **Command wiring adjustment:** `5x-cli/src/commands/run.ts` + `5x-cli/src/commands/plan-review.ts` updated to pass a single adapter param to orchestrators.
- **Tests:** `5x-cli/test/orchestrator/*` rewritten for new adapter interface; `5x-cli/test/utils/audit.test.ts` added.

---

## Strengths

- **Correct architectural direction:** routing on typed structured output removes an entire class of “missing/invalid signal block” failures and simplifies orchestration.
- **Fail-closed invariants preserved:** `assertAuthorStatus()` / `assertReviewerVerdict()` are consistently used before routing.
- **Better operability hooks:** precomputed per-invocation `logPath` is threaded into escalation reasons and stored in DB; log directories remain `0700`.
- **Audit comment encoding is robust:** base64url encoding prevents `--` / `-->` delimiter breakage in embedded prose.
- **Good regression coverage:** tests cover happy paths, auto-fix loops, escalations, mid-phase resume, and legacy `PARSE_*` resume mapping.

---

## Production readiness blockers

### P0.1 — Command-layer adapter lifecycle is incomplete (no `close()`)

**Risk:** Once `createAndVerifyAdapter()` is enabled, `5x run` / `5x plan-review` will leak the managed OpenCode server and any associated resources (ports, child processes, file handles). This will also complicate Ctrl-C handling and can produce non-deterministic teardown on repeated runs.

**Requirement:** Commands that create an adapter must `await adapter.close()` in a `finally`, including error/early-return paths.

**Implementation guidance:** Update `5x-cli/src/commands/run.ts`, `5x-cli/src/commands/plan-review.ts`, and `5x-cli/src/commands/plan.ts` to:
- create adapter once
- wrap orchestration/invocation in `try { ... } finally { await adapter.close() }`

### P0.2 — Worktree mode appears to split DB identity (planPath canonicalization)

**Risk:** `5x-cli/src/commands/run.ts` intends DB identity to remain anchored to the primary checkout plan path, while remapping plan/review file I/O into the worktree. Currently `runPhaseExecutionLoop()` canonicalizes and uses the *effective* (worktree) plan path as the DB key, so resume detection (`getActiveRun`) and run history can silently fork between primary-vs-worktree canonical paths.

**Requirement:** DB identity for a plan must be stable across worktree remapping; effective paths should be used only for file reads/writes and agent workdir.

**Implementation guidance:** Pass a stable `canonicalPlanPath` separately (or as an option) into `runPhaseExecutionLoop()` and use that value for DB lookups/locks/runs; keep `effectivePlanPath` for file I/O.

---

## High priority (P1)

### P1.1 — Resume “skip step” routing uses `getLatestStatus/getLatestVerdict` (brittle)

When `hasCompletedStep()` returns true, the orchestrators route using `getLatestStatus()` / `getLatestVerdict()`, which are phase-wide “latest” lookups and can be wrong if multiple status/verdict rows exist for the same phase (quality retry vs execute vs auto-fix). Prefer fetching the exact step row by `(run_id, phase, iteration, role, template, result_type)` and also include its stored `log_path` in any escalation.

### P1.2 — Phase 5 bridge work is still outstanding (expected, but now on the critical path)

- `5x-cli/src/agents/factory.ts` still throws; Phase 5 needs to enable it.
- `5x-cli/src/commands/plan.ts` still uses legacy invocation + signal parsing; Phase 5 needs to move it to `invokeForStatus()`.
- `5x-cli/src/agents/types.ts` still carries legacy interfaces; delete after commands are migrated.

---

## Medium priority (P2)

- **Result semantics:** `PhaseExecutionResult.aborted` currently conflates “not complete” with “aborted”; consider distinguishing `failed` vs `aborted` explicitly to avoid misleading CLI output.
- **Audit record growth:** audit comments are append-only; consider a cap/rotation strategy or a config flag if review artifacts become noisy for long runs.

---

## Readiness checklist

**P0 blockers**
- [ ] Ensure adapter lifecycle is correctly closed in all commands (`close()` in `finally`).
- [ ] Fix stable DB identity vs worktree effective-path remapping for `5x run`.

**P1 recommended**
- [ ] Route resume/skip paths using exact step lookup (not phase-wide “latest”).
- [ ] Complete Phase 5 bridge: enable factory; migrate `plan` command; remove legacy adapter types; update templates.

---

## Phase alignment / next-phase readiness

**Implementation plan phase(s):** `docs/development/003-impl-5x-cli-opencode.md` Phase 4

- **Phase 4 completion:** ✅ — `PARSE_*` states removed from both loops; adapter-direct invocation; legacy resume compat; tests updated; audit trail implemented.
- **Ready for Phase 5:** ✅ — proceed, but treat P0.1/P0.2 as “early Phase 5” must-fix items before enabling the real adapter/factory.
