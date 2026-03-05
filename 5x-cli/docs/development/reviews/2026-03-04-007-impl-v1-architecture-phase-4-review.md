# Review: 007 Phase 4 - v1 Run Lifecycle Commands

**Review type:** commit `9050f7f`
**Scope:** `src/commands/run-v1.ts`, `src/bin.ts`, `test/commands/run-v1.test.ts`, plan checkbox updates
**Reviewer:** Staff engineer
**Local verification:** `bun test test/commands/run-v1.test.ts` (pass)

## Summary

Phase 4 is largely implemented as planned: `5x run init/state/record/complete/reopen/list` exist, emit JSON envelopes, and are covered by high-signal integration tests (full lifecycle, lock enforcement, dirty worktree, idempotent init, INSERT OR IGNORE, max steps, reopen, list filters).

**Readiness:** Not ready - lock ownership/release semantics can break the lock-first concurrency invariant.

## Strengths

- Plan compliance is strong: subcommand set and behaviors match the Phase 4 checklist, including lock-first ordering and dirty worktree handling.
- CLI error policy is consistent: commands throw `CliError` via `outputError()`, and `src/bin.ts` renders `{ ok:false, error }` envelopes deterministically.
- Integration tests are comprehensive and exercise real subprocess boundaries (important for lock behavior).
- `--result` input handling covers `raw`, `-` (stdin), and `@file`, plus JSON validation before recording.

## Production Readiness Blockers

### P0.1 - Lock can be released by a non-owner process

**Risk:** Any process can delete another process's plan lock via `releaseLock()`. In particular, `5x run complete` can remove a lock held by a different live PID, enabling concurrent orchestrators against the same plan and violating the "lock-first invariant" intent.

**Requirement:** Lock release must be ownership-safe.

- `releaseLock(projectRoot, planPath)` should only remove a lock when either:
  - the lock is owned by the current process (`lock.pid === process.pid`), or
  - the lock is stale (PID not alive), or
  - an explicit "force" path is invoked (separately named API, clearly scoped).
- `5x run complete` and `5x run reopen` should not mutate run state unless the lock is held by the caller (either already held or acquired as part of the command). If the plan is locked by another live PID, return `PLAN_LOCKED`.
- Add tests proving:
  - `run complete` does not release another live PID's lock.
  - `run reopen` cannot activate a run when plan is locked by another live PID.

## High Priority (P1)

### P1.1 - Validate numeric CLI args (avoid NaN / negative inputs)

`--tail`, `--since-step`, `--limit`, `--iteration`, and numeric metadata flags use `parseInt/parseFloat` without validating finite/positive values. Bad inputs can silently become `NaN` and cause undefined DB behavior or runtime errors.

Recommendation: validate each numeric flag (integer, finite, non-negative/positive as appropriate) and fail with `INVALID_ARGS` + helpful detail.

### P1.2 - Canonicalize `--plan` in `run list`

`run init/state` canonicalize plan paths, but `run list --plan` passes the raw string through. This can cause surprising "missing" results when callers use relative paths or differing path spellings.

Recommendation: apply `canonicalizePlanPath()` in `listCmd` when `--plan` is provided.

### P1.3 - Harden `config_json` parsing

`run record` parses `run.config_json` with `JSON.parse()` without guardrails. While it should be well-formed in normal flows, corruption (or older DB rows) will currently crash with a non-JSON error envelope.

Recommendation: wrap `JSON.parse()` and either (a) fall back to default config, or (b) return a typed `CliError` with a stable error code.

## Medium Priority (P2)

- Consider emitting JSON envelopes for non-`CliError` failures in `src/bin.ts` as well (keeps the CLI contract stable even on unexpected exceptions).
- `run state --plan` currently resolves only the active run. If a caller passes a plan with no active run, the UX may be nicer if it returns the most recent run (requires product/UX decision).

## Readiness Checklist

**P0 blockers**
- [ ] Make lock release ownership-safe; ensure `run complete`/`run reopen` enforce lock ownership or acquisition.

**P1 recommended**
- [ ] Validate numeric args and add negative/NaN test cases.
- [ ] Canonicalize `run list --plan`.
- [ ] Guard `config_json` parsing to preserve JSON error envelopes.

## Addendum (2026-03-05) — HEAD Re-Review

### What's Addressed

- No follow-on commits found after `9050f7f` (HEAD unchanged); prior findings still apply.
- Re-verified: `bun test test/commands/run-v1.test.ts` (pass).

### Remaining Concerns

- P0.1 remains: `src/lock.ts` `releaseLock()` is not ownership-safe and `src/commands/run-v1.ts` `complete` can delete a lock held by a different live PID.
- P1.1 remains: numeric args in `src/commands/run-v1.ts` are parsed without validating finite/non-negative values (NaN/negative inputs).
- P1.2 remains: `run list --plan` does not canonicalize the path.
- P1.3 remains: `run record` parses `run.config_json` without guarding JSON corruption.
- P2 remains: non-`CliError` exceptions in `src/bin.ts` do not return JSON envelopes, breaking the v1 CLI contract under unexpected failures.

## Addendum (2026-03-05) — Review of `de571b9`

### What's Addressed

- P0.1 fixed: `src/lock.ts` `releaseLock()` is ownership-safe (owner or stale only) and adds explicit `forceReleaseLock()`; `run complete`/`run reopen` refuse with `PLAN_LOCKED` when another live PID holds the plan lock.
- P1.1 fixed: `src/commands/run-v1.ts` validates numeric flags and returns `INVALID_ARGS` for NaN/negative/invalid cases; new integration tests cover these.
- P1.2 fixed: `run list --plan` now canonicalizes via `canonicalizePlanPath()`.
- P1.3 fixed: `run record` guards `JSON.parse(run.config_json)` and falls back to global defaults on corruption; test added.
- P2 fixed: `src/bin.ts` now emits a JSON error envelope for non-`CliError` exceptions (`INTERNAL_ERROR`).

Local verification: `bun test test/commands/run-v1.test.ts test/lock.test.ts` (pass)

### Remaining Concerns

- P1.new — Numeric parsing still accepts trailing junk (e.g. `--limit 1abc` becomes `1`): `parseIntArg`/`parseFloatArg` rely on `parseInt/parseFloat` semantics rather than strict full-string validation. Mechanical fix: use a regex (`/^-?\d+$/`) / (`/^-?(\d+)(\.\d+)?$/`) or `Number()` + string roundtrip checks.

**Readiness:** Ready with corrections — prior blockers addressed; one mechanical input-validation tightening remains.

## Addendum (2026-03-05) — Review of `8d5824b`

### What's Addressed

- P1.new fixed: `src/commands/run-v1.ts` now rejects trailing junk for numeric flags via strict full-string regex validation; integration tests cover `1abc`, `1.5abc`, etc.

Local verification: `bun test test/commands/run-v1.test.ts` (pass)

### Remaining Concerns

- None for Phase 4 readiness.
- Minor UX note: the stricter float regex rejects formats like `.5`, `1.`, `+1`, and scientific notation (`1e-3`). If you want to accept those, widen the regex (non-blocking).

**Readiness:** Ready — Phase 4 issues addressed; no new blockers found.
