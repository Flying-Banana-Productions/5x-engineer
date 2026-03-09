# Review: CLI Composability Phase 4

**Review type:** commit `9877986`
**Scope:** Phase 4 implementation for `invoke` stdin context ingestion, including `src/commands/invoke.ts`, `src/commands/invoke.handler.ts`, and `test/commands/invoke-pipe.test.ts`
**Reviewer:** Staff engineer
**Local verification:** `bun test test/commands/invoke-pipe.test.ts` — pass (9 tests)

## Summary

Phase 4 is implemented cleanly and matches the plan's intended behavior. `invoke` now resolves `run_id` from upstream envelopes when stdin is piped, merges upstream string fields as template-variable fallbacks, preserves explicit CLI precedence, and keeps the stdin-consumer priority aligned with the Phase 5 design.

**Readiness:** Ready — phase gate is satisfied and I did not find correctness, architecture, security, performance, operability, or plan-compliance issues that block the next phase.

## Strengths

- Keeps pipe parsing in the shared `src/pipe.ts` utility instead of duplicating envelope logic in the handler.
- Preserves CLI override precedence with a simple merge order: piped context first, explicit `--var` values second.
- Avoids stdin-consumption conflicts by skipping upstream parsing when a `--var` uses `@-`, matching the planned priority model.
- Covers the main happy paths and guardrails with focused integration tests plus direct `extractPipeContext()` assertions.

## Production Readiness Blockers

None.

## High Priority (P1)

None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [x] None.
