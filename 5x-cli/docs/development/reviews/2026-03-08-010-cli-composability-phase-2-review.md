# Review: CLI Composability Phase 2

**Review type:** commit `b85d078`
**Scope:** Phase 2 implementation from `docs/development/010-cli-composability.md` (template `step_name`, shared pipe infrastructure, invoke context enrichment, docs alignment)
**Reviewer:** Staff engineer
**Local verification:** `bun test test/pipe.test.ts test/templates/loader.test.ts test/commands/invoke.test.ts` (138 pass, 0 fail); manual `bun -e` repro confirms override-only `custom-template.md` loads with `stepName: null`

## Summary

Phase 2 is directionally solid. The runtime changes in `src/pipe.ts`, `src/templates/loader.ts`, and `src/commands/invoke.handler.ts` fit the existing architecture, preserve backward compatibility for pre-existing prompt overrides, and align the public docs with the actual invoke envelope. The remaining issues are in test coverage and plan-compliance, not in the shipped behavior I reviewed.

**Readiness:** Ready with corrections -- core implementation is sound, but a couple of plan-required tests were not actually implemented.

## Strengths

- `src/pipe.ts` cleanly centralizes stdin envelope parsing, invoke-metadata extraction, and template-var filtering without reusing the interactive stdin helpers.
- `src/templates/loader.ts` handles the pre-existing scaffolded-template compatibility story well: known templates get a safe fallback plus warning, while custom override templates can still resolve with `stepName: null`.
- `src/commands/invoke.handler.ts` enriches the invoke envelope with `run_id`, `step_name`, `phase`, and `model` in a minimal, architecture-consistent way.
- `docs/v1/101-cli-primitives.md` now matches the real invoke/quality shapes, which closes an important contract gap before downstream pipe consumers land.

## Production Readiness Blockers

- None.

## High Priority (P1)

### P1.1 -- Invoke enrichment tests do not exercise the real handler/output path

The Phase 2 plan explicitly calls for invoke-handler tests that assert the new `run_id`, `step_name`, `phase`, and `model` fields in the emitted envelope. The added coverage in `test/commands/invoke.test.ts:1320` does not do that; it only constructs a local object literal and asserts properties on the literal. Likewise, `test/commands/invoke.test.ts:1347` and `test/commands/invoke.test.ts:1355` assert trivial expressions rather than the handler behavior. That leaves the most important new runtime contract effectively unverified at the adapter level. Replace these synthetic assertions with a real handler or CLI-level test that exercises `invokeAgent()` output.

## Medium Priority (P2)

- `test/templates/loader.test.ts:391` is a placeholder, not a test. The plan required coverage for "unknown template name with no `step_name` -> `stepName: null`, no warning", but this block never calls `setTemplateOverrideDir()` or `loadTemplate("custom-template")`, so the required behavior is still untested.
- `test/pipe.test.ts:299` also misses its stated target. The test name says `readUpstreamEnvelope()` returns `null` when stdin is a TTY, but it only checks that `isStdinPiped()` returns a boolean. Add a direct unit seam or subprocess-based harness that actually validates the non-piped branch.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Replace synthetic invoke-envelope assertions with a real handler or CLI-level test that verifies emitted `run_id`, `step_name`, `phase`, and `model` fields.
- [ ] Add the missing loader test for override-only custom templates without `step_name`.
- [ ] Add a real `readUpstreamEnvelope()` non-piped test instead of the current boolean sanity check.

## Addendum (2026-03-08) -- Follow-up at `e0164c4`

### What's Addressed

- `test/commands/invoke.test.ts` now exercises the real CLI/handler path with the sample provider and asserts emitted `run_id`, `step_name`, `phase`, and `model` fields from the actual invoke envelope.
- `packages/provider-sample/src/index.ts` now supports configured structured output, which keeps the new invoke contract test architecture-consistent instead of relying on synthetic literals or invasive mocks.
- `src/templates/loader.ts` now exports `parseTemplate()` specifically for direct test coverage of unknown template names, and `test/templates/loader.test.ts` now verifies the null-`stepName`, no-warning path the prior review called out.
- `test/pipe.test.ts` now exercises the non-piped branch of `readUpstreamEnvelope()` directly by forcing `process.stdin.isTTY = true`, closing the remaining plan-compliance gap from the prior review.
- Focused verification passed: `bun test test/commands/invoke.test.ts` (57 pass, 0 fail) and `bun test test/templates/loader.test.ts test/pipe.test.ts` (81 pass, 0 fail).

### Remaining Concerns

- None. This follow-up addresses the prior review items, and Phase 2 is ready to close.

## Addendum (2026-03-08) -- Independent validation at `e0164c4`

### What's Addressed

- Re-reviewed `e0164c4` and confirmed there are no follow-on commits beyond it in scope, so the assessment is against the full post-fix Phase 2 state.
- `test/commands/invoke.test.ts` now verifies the emitted invoke envelope through the real CLI path with the sample provider, covering `run_id`, `step_name`, `phase`, `model`, and the existing invoke metadata fields together.
- `test/templates/loader.test.ts` uses direct `parseTemplate()` coverage for unknown template names without `step_name`, which closes the prior plan-compliance gap without distorting the production loader path.
- `test/pipe.test.ts` now exercises the non-piped `readUpstreamEnvelope()` branch directly and focused verification passed: `bun test test/commands/invoke.test.ts test/templates/loader.test.ts test/pipe.test.ts` (138 pass, 0 fail).

### Remaining Concerns

- None. Phase 2 now matches the plan's completion gate and is ready for the next phase.
