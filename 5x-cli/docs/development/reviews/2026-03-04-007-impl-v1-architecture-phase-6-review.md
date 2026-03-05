# Review: 007 impl v1 architecture - Phase 6

**Review type:** commit `1225934`
**Scope:** `5x quality run`, `5x plan phases`, `5x diff`, `5x worktree create/remove/list` (JSON envelopes + CLI registration) + quality gate timeout fix + tests
**Reviewer:** Staff engineer
**Local verification:** `bun test test/commands/diff.test.ts test/commands/plan-v1.test.ts test/commands/quality-v1.test.ts test/commands/worktree-v1.test.ts` (26 pass)

## Summary

Implements the Phase 6 CLI primitives largely as specified: new commands are registered, output is consistently wrapped in `{ ok, data }` envelopes, and tests cover the happy paths + key error cases (notably invalid git refs and missing plan files for `plan phases`). The `runSingleCommand()` timeout fix (`unref()` + `clearTimeout`) is a solid operability improvement for standalone runs.

**Readiness:** Ready with corrections — a P0 stdout contract issue in `worktree.postCreate` needs a mechanical fix to preserve JSON-only stdout.

## Strengths

- Good contract hygiene: `src/output.ts` centralizes exit-code mapping and guarantees `data` is present (undefined normalized)
- Solid test coverage for the new command surfaces (4 files / 26 tests) and good use of temporary git repos
- `5x diff` includes both raw diff + file list; optional `--stat` matches the v1 primitives doc
- Quality gate timeout timer leak fix is correct and well-scoped (`unref()` + cleanup)

## Production Readiness Blockers

### P0.1 — `worktree.postCreate` can corrupt JSON stdout

**Risk:** If `worktree.postCreate` is configured, the hook currently inherits stdout/stderr, which can emit non-JSON output before the command writes its JSON envelope. Any orchestrator/skill parsing stdout as JSON will break.

**Requirement:** `5x worktree create` must emit JSON only on stdout under all configurations.

Acceptance criteria:
- Hook output is redirected to stderr and/or captured to a log file (but never written to stdout)
- Add a test that configures `worktree.postCreate` (e.g. `echo hook`) and asserts stdout parses as JSON (optionally asserts stderr contains the hook output)
- Ensure the error path for hook failures remains non-fatal but is observable (stderr or an explicit `warnings` field in `data`)

## High Priority (P1)

### P1.1 — `worktree create` should validate plan file existence

Today `src/commands/worktree.ts` will happily create a worktree for a non-existent `--plan` path and persist that association in the DB.

Recommendation:
- Mirror `src/commands/plan-v1.ts` behavior: if the plan path does not exist, throw `PLAN_NOT_FOUND` (exit code 2)
- Add a regression test for missing plan paths

### P1.2 — `5x diff` should fail closed if auxiliary git calls fail

`src/commands/diff.ts` checks `git diff` exit status, but it does not check failures from `--name-only` (and treats `--stat` failures as a silent 0/0/0 result).

Recommendation:
- If `nameResult.exitCode !== 0`, throw `GIT_ERROR` with stderr and context
- For `--stat`, either: (a) throw `GIT_ERROR` on non-zero exit, or (b) include a `stat_error` field while keeping the command successful; defaulting to zeros hides failures

## Medium Priority (P2)

- `src/commands/quality-v1.ts` advertises `--config` but ignores it; either remove the flag or plumb an override into `loadConfig()` (and test it)
- `src/commands/worktree.ts` worktree path derivation uses string slicing on `/` and can collide for same-basename plans; use `path.basename()` and decide on a uniqueness strategy (e.g. suffix a stable hash of the canonical plan path)
- `worktree remove` now best-effort deletes merged branches without an explicit flag; document this in `docs/v1/101-cli-primitives.md` or reintroduce an explicit `--delete-branch` knob

## Readiness Checklist

**P0 blockers**
- [ ] `worktree.postCreate` output never contaminates stdout JSON; add coverage

**P1 recommended**
- [ ] `worktree create` errors with `PLAN_NOT_FOUND` when plan path is missing
- [ ] `diff` propagates failures from `--name-only` / `--stat` instead of silently degrading

## Addendum (2026-03-05) — Re-review after fixes (`0d2e78f5d94c7342c1c70c80cadcca983e651cf1`)

### What's Addressed

- P0.1 fixed: `runWorktreeSetupCommand()` now pipes hook output and forwards it to stderr; `test/commands/worktree-v1.test.ts` asserts stdout remains valid JSON
- P1.1 fixed: `worktree create` validates plan existence and returns `PLAN_NOT_FOUND` (exit 2) with coverage
- P1.2 fixed: `diff` now fails closed on `--name-only` and `--stat` failures via `GIT_ERROR`
- P2 fixed: removed unused `quality run --config` flag; `worktreeDir()` now uses basename + short hash to avoid collisions

### Remaining Concerns

- P2: `runWorktreeSetupCommand()` buffers full hook stdout/stderr into memory before forwarding; for noisy hooks (e.g. `npm install`) stream-to-stderr would be safer
- P2: `src/commands/quality-v1.ts` header comment still mentions `--config` even though the flag is removed
- P2: `worktree remove` still best-effort deletes merged branches without an explicit flag; ensure docs match intended policy

Updated readiness: Ready (no remaining P0/P1 issues observed).
