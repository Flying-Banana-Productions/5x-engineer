# Review: Phase 3 — `5x plan list` integration tests

**Review type:** `af6a55dadea2a1351dd5dd5a3c702a7966a473be`  
**Scope:** Phase 3 only per `5x-cli/docs/development/030-plan-list-command.plan.md` — `describe("5x plan list (integration)")` additions in `test/integration/commands/plan-v1.test.ts`, plus Phase 3 checklist tick in the plan doc  
**Reviewer:** Staff engineer  
**Local verification:** `bun test test/integration/commands/plan-v1.test.ts --concurrent` (14 pass, 0 fail)

## Summary

Phase 3 adds subprocess-level coverage for `5x plan list` alongside the existing `plan phases` integration block. New cases exercise empty and missing `docs/development` trees, recursive discovery with committed fixtures, unfinished-before-complete ordering with a deliberate basename tie (`zdir/…` before `aaa-done.md`), `--exclude-finished`, `--text` table output (headers, row content, no JSON envelope on stdout), DB-backed `active_run` after `5x run init`, and `runs_total` / `active_run` for plans that never had a run. Helpers `commitAll`, `PLAN_ONE_PHASE_TODO`, and `PLAN_ONE_PHASE_DONE` reduce duplication; git spawns use `cleanGitEnv()` and `stdin: "ignore"` per `AGENTS.md`. The heavier run-init test uses a 30s test timeout, matching the guideline for multiple sequential spawns.

**Readiness:** Ready — completion gate (“all new and existing tests pass”) is satisfied; findings below are optional polish, not merge blockers.

## Strengths

- **Contract coverage:** Assertions hit JSON envelope shape (`ok`, `data.plans`), CLI flags, text mode, and run linkage—the behaviors users and agents depend on beyond unit-tested handler logic.
- **Deterministic fixtures:** Plans are minimal valid phase/checklist markdown; nested discovery sorts collected paths before asserting, avoiding order fragility for that case.
- **Plan alignment:** Phase 3 checkbox is marked complete in the plan; the new `describe` block name matches the plan’s wording.

## Production Readiness Blockers

None for Phase 3 scope (tests only).

## High Priority (P1)

None.

## Medium Priority (P2)

- **`commitAll` diagnostics:** `commitAll` does not assert non-zero exit codes from `git add` / `git commit`. A silent failure could make downstream assertions confusing; asserting success (or throwing with stderr) would fail fast.
- **Alphabetical within-group sort:** The unfinished-vs-complete test proves cross-group ordering well; it does not place two unfinished files whose relative order would fail if alphabetical sorting within the unfinished group regressed. Adding a second open plan would lock that invariant.
- **File banner:** The top-of-file comment still describes only `5x plan phases`; a one-line mention of `plan list` would match the file’s actual scope.

## Readiness Checklist

**P0 blockers**

- [x] None identified

**P1 recommended**

- [x] None for Phase 3 scope

## Addendum (2026-03-31) — Phase 3 first review

### What's Addressed

- Eight new integration tests under `5x plan list (integration)` plus shared helpers and plan markdown constants.
- Phase 3 checklist item marked done in `030-plan-list-command.plan.md`.

### Remaining Concerns

- Phase 4 (docs/harness) and any follow-on phases per the plan remain out of scope for this review.
