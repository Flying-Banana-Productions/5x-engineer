# Review: Phase 2 — `planList` handler unit tests

**Review type:** `ef9e14ff2b30cfd864b0f867d74ff16201280d7f` (phase 2; plan checkbox update in same commit)  
**Scope:** Phase 2 only per `5x-cli/docs/development/030-plan-list-command.plan.md` — direct-call `describe("planList handler")` in `test/unit/commands/plan-v1.handler.test.ts`  
**Reviewer:** Staff engineer  
**Local verification:** `bun test test/unit/commands/plan-v1.handler.test.ts --dots` (9 pass, 0 fail)

## Summary

Phase 2 adds an isolated temp-git harness with `chdir` + DB migration helpers so `planList` exercises `resolveDbContext()` without spawning the CLI. The seven behaviors called out in the plan are covered: recursive discovery, distinct `plan_path` for duplicate basenames, missing `paths.plans` directory (empty list, `plans_dir` may not exist), `--exclude-finished`, unfinished-first sort with alphabetical tie-break among complete rows, worktree-preferred reads when the mirrored file exists, and a per-file failure path that keeps other rows while emitting a stderr warning and listing the bad file with zeroed progress.

Two extra cases strengthen confidence: stderr-only handling for non-plan markdown (no warning text in the JSON payload) and run association by canonical `plan_path` with `active_run` populated.

**Readiness:** Ready — Phase 2 completion gate is met; remaining notes are optional polish.

## Strengths

- **Plan alignment:** Each numbered Phase 2 test case from the plan has a named test; assertions target `plan_path`, sort order, filter behavior, and worktree-derived title/completion.
- **Hermetic setup:** `withProject` restores cwd, closes DB, and tears down temp dirs; `cleanGitEnv()` on git spawns matches integration-test hygiene expectations.
- **Failure semantics:** Unreadable file test asserts stderr contains the path and “could not read”, while `good.md` still parses to 100% completion—matching the handler’s single `try/catch` around read + parse.

## Production Readiness Blockers

None for Phase 2 scope (tests only).

## High Priority (P1)

None. Phase 1 listing-scope concerns were handled separately (stderr warnings for non-phase markdown); these unit tests reinforce that contract.

## Medium Priority (P2)

- **Plan wording vs. fixture:** The plan calls out “parse failure”; the implementation uses one `catch` for read and parse errors. The unreadable-file test exercises that path correctly; adding a separate case where `readFileSync` succeeds but content forces a throw from `parsePlan` (if feasible) would mirror the plan’s wording literally.
- **Output capture style:** Tests spy on `console.log` and temporarily replace `process.stderr.write` to capture envelopes and warnings. `AGENTS.md` prefers dependency-injected sinks for warnings; for `outputSuccess`, a long-term refactor could inject a log sink. Not required for Phase 2 correctness.

## Readiness Checklist

**P0 blockers**

- [x] None identified

**P1 recommended**

- [x] None for Phase 2 scope

## Addendum (2026-03-31) — Phase 2 first review

### What's Addressed

- New `test/unit/commands/plan-v1.handler.test.ts` with `describe("planList handler")` and nine tests covering discovery, identity, empty dir, filtering, sorting, worktree precedence, per-file error fallback, non-plan markdown warnings, and run linkage.
- Plan Phase 2 checkbox marked complete in `030-plan-list-command.plan.md` in the same commit.

### Remaining Concerns

- Phase 3 (integration) and Phase 4 (docs/harness) remain open per the plan.
