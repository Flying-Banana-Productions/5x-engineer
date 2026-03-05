# Review: 007 impl v1 architecture — Phase 5 (invoke)

**Review type:** commit `66f9a06` (and follow-ons: none)
**Scope:** `5x invoke author|reviewer` command implementation + tests; plan compliance for Phase 5
**Reviewer:** Staff engineer
**Local verification:** `bun test test/commands/invoke.test.ts` (pass)

## Summary

Phase 5 lands the `invoke` command group with shared template rendering + provider invocation + NDJSON logging, and generally matches the plan’s intent. A few correctness/security gaps remain around log path handling, structured output error classification, and argument validation; these are mechanical to fix.

**Readiness:** Ready with corrections — P0 items are straightforward hardening.

## Strengths

- Clean separation: shared `invokeAgent()` used by both roles; stderr streaming keeps stdout reserved for JSON envelopes.
- Uses existing primitives as intended: template override dir (`.5x/templates/prompts`), provider factory, protocol assertions.
- NDJSON event logging is simple and debuggable; includes timestamps per event.
- Tests cover template loader behavior, schema invariants, and exit-code mapping.

## Production Readiness Blockers

### P0.1 — Path traversal via `--run` impacts NDJSON log writes

**Risk:** User-controlled `--run` can escape `.5x/logs/<run_id>` and write/overwrite arbitrary paths under (or outside) the repo via `..` segments.

**Requirement:** Constrain `run_id` to a safe filename component (e.g. `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) OR resolve and enforce that the final `logDir` stays within `<projectRoot>/.5x/logs/` before `mkdirSync`/`appendFileSync`.

### P0.2 — Structured output error detection is effectively unreachable

**Risk:** `isStructuredOutputError()` is only called when `structured` is falsy or non-object; real StructuredOutputError payloads are typically objects, so they’ll fall through to `assert*` and be reported as generic invalid output. This makes the error classification noisier and can mask actionable provider failures.

**Requirement:** Run `isStructuredOutputError(structured)` before the “object” guard (or run it in both branches) so StructuredOutputError objects are detected and surfaced consistently.

### P0.3 — `--timeout` parsing accepts NaN/invalid values

**Risk:** `Number.parseInt()` can produce `NaN` (or accept partial parses), which then flows into provider timeouts; behavior becomes inconsistent across providers/tests.

**Requirement:** Validate `--timeout` as a positive integer; reject invalid values with `INVALID_ARGS` (or equivalent) before invoking the provider.

## High Priority (P1)

### P1.1 — Decide/enforce whether `--run` is required for `invoke`

The plan and completion gate describe `--run` as required (log path `.5x/logs/<run_id>/...`), but implementation currently makes it optional and returns `log_path: null`.

Recommendation: either (a) make `--run` required and fail fast without it (aligns with the plan + downstream skills expecting logs), or (b) explicitly support “ad-hoc invoke” mode and update the plan/skills to reflect that behavior.

### P1.2 — `model` field in `invoke` output is likely always null

`invoke` tries to read a `model` property from `RunResult` via an unsafe cast, but `RunResult` does not include `model`, and the OpenCode provider currently does not return it. This makes the output contract misleading.

Recommendation: either add `model` to `RunResult` and populate it in providers, or remove it from the `invoke` output until it’s real (and update the plan accordingly).

### P1.3 — Workdir resolution semantics are a bit ambiguous

`workdir` is resolved via `path.resolve(args.workdir ?? projectRoot)`, which is process-CWD relative rather than project-root relative. This can surprise callers invoking `5x` from outside the repo.

Recommendation: resolve relative to `projectRoot` (or document the current behavior) to avoid accidental tool execution in an unintended directory.

## Medium Priority (P2)

- `appendFileSync` per event can be expensive for verbose streams; consider buffering or async writes if this becomes noticeable.
- Template-not-found detection relies on substring matching error messages; prefer a stable error type/code from the template loader.
- Tests don’t currently validate the full invoke pipeline (provider + runStreamed + NDJSON write) via mocking; adding a fake provider/session would give end-to-end confidence without needing OpenCode running.

## Readiness Checklist

**P0 blockers**
- [ ] Sanitize/contain `--run` when building log paths
- [ ] Fix StructuredOutputError detection path
- [ ] Validate `--timeout` as positive integer; reject invalid values

**P1 recommended**
- [ ] Align `--run` required/optional behavior with the plan (or update the plan)
- [ ] Make `model` output truthful (wire through, or remove)
- [ ] Clarify and stabilize `--workdir` resolution behavior
