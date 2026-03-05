# Review: 007 impl v1 architecture — Phase 3 (JSON Output + Run IDs)

**Review type:** d52473a6a50ac19f5b2a875cefd1c29091f0cf70
**Scope:** `src/output.ts`, `src/run-id.ts`, `test/output.test.ts`, plan checkbox updates
**Reviewer:** Staff engineer
**Local verification:** `bun test test/output.test.ts` (pass)

## Summary

Phase 3 lands the core building blocks for the v1 JSON envelope contract: typed envelopes, a single typed `CliError` with deterministic exit codes, and small run-id/log-seq helpers. Tests are thorough for the helper surface area and should make later v1 command work much less error-prone.

**Readiness:** Ready with corrections — one edge case can silently violate the `{ ok, data }` contract.

## Strengths

- Clear, centralized exit-code mapping (`exitCodeForError`) that matches the plan’s “deterministic exit codes” requirement.
- `CliError` is small and ergonomic; supports optional `detail` and explicit exitCode overrides.
- `nextLogSequence()` behavior is well specified and well tested (nonexistent dir, gaps, ignore patterns).
- Unit tests cover the likely failure modes for this phase without pulling in higher-level command wiring.

## Production Readiness Blockers

None identified for Phase 3 in isolation.

## High Priority (P1)

### P1.1 — `outputSuccess(undefined)` drops the `data` field in JSON

`outputSuccess()` constructs `{ ok: true, data }`, but `JSON.stringify()` omits properties whose value is `undefined`. That yields `{"ok":true}` which violates the documented envelope shape and can break consumers expecting `data` to always exist.

**Recommendation and rationale**

- Ensure `data` is always present on the wire. Options:
  - Normalize `undefined` to `null`.
  - Or throw a typed error if `data === undefined` (more strict, but forces callers to decide).
- Add a unit test to lock the behavior.

## Medium Priority (P2)

- `nextLogSequence()` is not atomic under multi-process writers (two processes can pick the same next seq). If concurrent `invoke` writes are possible, consider reserving the filename via exclusive create + retry.
- JSON serialization failure mode: `JSON.stringify()` can throw (e.g. BigInt, circular). Decide whether to enforce “JSON-serializable only” at call sites or to catch and convert to a typed CLI error.

## Readiness Checklist

**P0 blockers**
- [x] None for this phase

**P1 recommended**
- [x] Fix `outputSuccess(undefined)` contract violation; add test
