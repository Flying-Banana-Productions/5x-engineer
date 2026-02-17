# Review: 5x CLI Phase 4 (Plan Generation + Review Loop)

**Review type:** `d9acb009`  \
**Scope:** `5x plan` command, `5x plan-review` command + orchestrator loop, DB recording, tests, plan doc updates  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, performance, operability, test strategy)  \
**Local verification:** `cd 5x-cli && bun test` PASS (229 pass, 1 skip); `bun run typecheck` PASS; `bun run lint` PASS

**Implementation plan:** `docs/development/001-impl-5x-cli.md`  \
**Technical design:** N/A

## Summary

Commit `d9acb009` implements Phase 4 of `docs/development/001-impl-5x-cli.md`: deterministic plan-path generation (`5x plan`) and a DB-backed, resumable plan review loop (`5x plan-review`) with an explicit state machine and strong unit coverage.

Main correctness gap: the plan-review loop can incorrectly treat a non-ready verdict as approved if the verdict items fail parsing (e.g., unknown `action` values get dropped, leaving `items: []` while `readiness != ready`). Also, Phase 4 introduces new places where “project root” is assumed to be `cwd`, which will create confusing behavior when invoked from subdirectories (DB + artifact paths).

**Readiness:** Ready with corrections - fix P0 approval fallback; harden project-root/workdir handling before starting Phase 5.

---

## What shipped

- **Plan generation:** `5x plan <prd>` computes deterministic `NNN-impl-<slug>.md` output path, invokes author, validates `5x:status`, records run + agent result in DB (`5x-cli/src/commands/plan.ts`).
- **Plan review loop:** `5x plan-review <plan>` resolves/reuses a stable review doc path, invokes reviewer/author in a REVIEW->FIX loop with resume gates + escalation gates, records signals to DB (`5x-cli/src/commands/plan-review.ts`, `5x-cli/src/orchestrator/plan-review-loop.ts`).
- **CLI wiring + exports:** registers commands and exports orchestrator APIs (`5x-cli/src/bin.ts`, `5x-cli/src/index.ts`).
- **Tests:** targeted unit tests for path helpers + plan-review state machine (resume, max-iterations, auto mode, escalations) (`5x-cli/test/commands/*.test.ts`, `5x-cli/test/orchestrator/plan-review-loop.test.ts`).

---

## Strengths

- **Deterministic artifacts:** `computePlanPath()` avoids directory-scanning heuristics and has collision handling; aligns with earlier plan-review feedback.
- **Explicit state machine:** loop states are readable and audit-friendly; DB events make failures diagnosable (`5x-cli/src/orchestrator/plan-review-loop.ts`).
- **Fail-safe bias on missing signals:** missing verdict/status escalates rather than guessing.
- **Good coverage where it matters:** the loop’s behavioral cases (auto-fix cycles, resume, max iterations, exit-code escalation) are directly tested.

---

## Production readiness blockers

### P0.1 - Non-ready verdict can be treated as approved when items fail parsing

**Risk (correctness/security-of-process):** A reviewer can return `readiness: ready_with_corrections|not_ready` but with items that don"t survive parsing (e.g., typoed `action`, missing fields). `parseVerdictBlock()` will drop invalid items, and `runPlanReviewLoop()` can fall through to `APPROVED` via the "shouldn't reach here" fallback, incorrectly bypassing the review gate.

**Requirement:** For any verdict where `readiness !== 'ready'`, the loop must NOT approve unless it has at least one actionable item and routes deterministically (AUTO_FIX or ESCALATE). Any "non-ready + no actionable items" must escalate.

**Implementation guidance:**
- In `5x-cli/src/orchestrator/plan-review-loop.ts`, replace the `PARSE_VERDICT` fallback `state = 'APPROVED'` with an escalation.
- Add an explicit guard: if `readiness !== 'ready' && verdict.items.length === 0` => ESCALATE (covers parser-drop and reviewer mistakes).
- Add a regression test constructing a verdict with `ready_with_corrections` + an invalid item action (so parsed `items: []`) and assert escalation.

---

## High priority (P1)

### P1.1 - Project root is treated as `cwd` (artifact + DB paths become subdir-relative)

`5x-cli/src/commands/plan.ts` and `5x-cli/src/commands/plan-review.ts` use `projectRoot = resolve('.')` then resolve `config.paths.*` and `config.db.path` from that. If invoked from a nested directory, you will create `.5x/` and `docs/development/` under that subdir, splitting state/artifacts across multiple roots.

Recommendation: derive a single "project root" consistently from config discovery (e.g., `configPath ? dirname(configPath) : cwd`, or prefer git root when available) and use it for DB path, artifact roots, and git safety checks.

### P1.2 - Agent `workdir` should be the project root (not plan directory)

In `runPlanReviewLoop()` the adapters run with `workdir: dirname(planPath)`. This will surprise reviewers/authors that rely on repo-root-relative commands/searches and increases variability across plans stored in different directories.

Recommendation: pass a `workdir`/`projectRoot` into the orchestrator and use that for all adapter invocations.

### P1.3 - Review-path reuse from DB should be constrained or warned

`resolveReviewPath()` will reuse `runs.review_path` from DB even if it points outside `config.paths.reviews`. If the DB is stale/corrupted, the loop can direct agents to write arbitrary files.

Recommendation: if reusing an existing path, verify it is under the configured reviews dir (or emit a loud warning + require an explicit opt-in flag to proceed).

---

## Medium priority (P2)

- **Slug edge cases:** if `slugFromPath()` produces an empty slug, `computePlanPath()` can generate `NNN-impl-.md`; consider a fallback slug.
- **CLI args drift:** `--allow-dirty` is accepted by `5x plan` but currently unused; either implement or remove to reduce false expectations.

---

## Readiness checklist

**P0 blockers**
- [ ] Fix non-ready verdict fallback approval (P0.1) + add regression test.

**P1 recommended**
- [ ] Resolve project-root determination and use it consistently (P1.1).
- [ ] Run agents from project root/worktree root (P1.2).
- [ ] Constrain/warn on DB-provided reviewPath reuse (P1.3).

---

## Readiness assessment vs implementation plan

- **Phase(s) implemented:** Phase 4 in `docs/development/001-impl-5x-cli.md` (Plan Generation + Review Loop).
- **Phase 4 completion:** ⚠️ - broadly complete, but P0.1 is a real correctness hole in the safety gate.
- **Ready for next phase (Phase 5: Phase Execution Loop):** ⚠️ - proceed after P0.1; strongly recommend landing P1.1/P1.2 first since Phase 5 will amplify root/workdir inconsistencies.

<!-- 5x:verdict
protocolVersion: 1
readiness: ready_with_corrections
reviewPath: docs/development/reviews/2026-02-17-5x-cli-phase-4-plan-generation-review-loop-review.md
items:
  - id: p0-1
    title: Prevent plan-review from approving non-ready verdicts with no actionable items
    action: auto_fix
    reason: Current PARSE_VERDICT fallback can incorrectly treat parser-dropped items as approval
  - id: p1-1
    title: Derive and use a single project root for DB and artifact paths
    action: auto_fix
    reason: Current use of cwd can split state/artifacts when invoked from subdirectories
  - id: p1-2
    title: Run reviewer/author adapters from project root (not plan directory)
    action: auto_fix
    reason: Reduces variability and enables repo-root-relative tooling during review/fix loops
  - id: p1-3
    title: Constrain or warn when reusing DB-provided reviewPath outside reviews dir
    action: auto_fix
    reason: Hardens against stale/corrupt DB state directing agents to write unexpected files
-->

---

## Addendum (2026-02-17) - Re-review after remediation

**Reviewed:** `424f03642d`

**Local verification:** `cd 5x-cli && bun test` PASS (232 pass, 1 skip); `bun run typecheck` PASS; `bun run lint` PASS

### What's addressed (✅)

- **P0.1 non-ready approval fallback:** `runPlanReviewLoop()` now escalates on any `readiness != ready` verdict with no auto-fixable items; no fallback-to-APPROVED path remains (`5x-cli/src/orchestrator/plan-review-loop.ts`). Regression tests added for `ready_with_corrections` + empty items and `not_ready` + empty items (`5x-cli/test/orchestrator/plan-review-loop.test.ts`).
- **P1.1 project root consistency:** new `resolveProjectRoot()` (config file > git root > cwd) centralizes root selection; `plan`, `plan-review`, and `status` now anchor DB/artifacts/safety checks consistently (`5x-cli/src/project-root.ts`, `5x-cli/src/commands/plan.ts`, `5x-cli/src/commands/plan-review.ts`, `5x-cli/src/commands/status.ts`).
- **P1.2 agent workdir:** plan-review loop now accepts `projectRoot` and uses it as the agent `workdir` instead of `dirname(planPath)` (`5x-cli/src/orchestrator/plan-review-loop.ts`).
- **P1.3 review path hardening:** DB-provided `review_path` is reused only if it resolves under the configured reviews dir; otherwise warn + compute fresh path; tests cover the rejection case (`5x-cli/src/orchestrator/plan-review-loop.ts`, `5x-cli/test/orchestrator/plan-review-loop.test.ts`).
- **P2 edge cases:** empty slug fallback in `computePlanPath()`; `5x plan` now actually enforces `--allow-dirty` semantics (previously declared but unused) (`5x-cli/src/commands/plan.ts`).

### Remaining concerns

- No new staff-level blockers identified for Phase 4. (Minor: `resolveReviewPath()` uses string-prefix checks; if you later care about platform portability, consider `path.relative()`-based containment checks.)

### Updated readiness

- **Phase 4 completion:** ✅
- **Ready for next phase (Phase 5: Phase Execution Loop):** ✅

<!-- 5x:verdict
protocolVersion: 1
readiness: ready
reviewPath: docs/development/reviews/2026-02-17-5x-cli-phase-4-plan-generation-review-loop-review.md
items: []
-->
