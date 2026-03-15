# Review: Human-Readable Output Mode

**Review type:** `5x-cli/docs/development/021-human-readable-output.plan.md`
**Scope:** Output-format plan across `src/output.ts`, `src/bin.ts`, selected handlers, tests, and docs
**Reviewer:** Staff engineer
**Local verification:** `bun run src/bin.ts run init` reproduces current Commander parse-error stderr before JSON envelope; static review of plan, `src/bin.ts`, `src/output.ts`, handler call sites, and v1 docs

## Summary

The plan has the right top-level shape: keep JSON as the deterministic default, add a single global text switch, and let `outputSuccess()` own the mode split. It is not ready as written, though, because the proposed Phase 1 error-path changes do not actually achieve the documented text-mode error contract, and the generic fallback formatter is still lossy for empty-but-meaningful results.

**Readiness:** Ready with corrections - the architecture is sound, but the plan still needs a small set of mechanical corrections before implementation starts.

## Strengths

- The output-mode boundary is correct: centralizing behavior in `src/output.ts` and `src/bin.ts` keeps handlers mostly unchanged.
- The explicit-default design is right for CLI composability: JSON stays stable for pipes and automation, while humans opt into text deliberately.
- The formatter tiering is pragmatic: custom formatters are reserved for the few commands where layout materially matters.

## Production Readiness Blockers

### P0.1 - Text-mode parse errors still leak Commander stderr output

**Risk:** Phase 1 says text-mode errors become `Error: <message>` on stderr, but `src/bin.ts` currently lets Commander print parse errors/help to stderr before the catch block runs. Adding `getOutputFormat() === "text"` branches in the catch block alone will produce duplicated or contract-breaking stderr for cases like missing required options, unknown options, and unknown commands.

**Requirement:** Update the plan to include the output-routing change needed to suppress or deliberately reshape Commander's built-in parse-error writes when `--text` is active, and add explicit integration coverage for text-mode parse errors (`missing required option`, `unknown option`, `unknown command`) so the chosen contract is enforced.

## High Priority (P1)

### P1.1 - Generic formatter drops empty collections and can hide successful results

The proposed `formatGenericText()` skips empty arrays and empty objects entirely. That makes some successful commands render as partial or even blank output in `--text` mode, despite the empty result being semantically meaningful (`run list` with no runs before custom formatting lands, empty `removed`/`notFound` sets, empty nested result groups, etc.). The plan should define stable empty-state rendering such as `(none)` / `[]` / explicit section headers rather than silently omitting those fields.

### P1.2 - The test plan does not cover the documented `--pretty` + `--text` interaction

The plan explicitly states that `--pretty` is ignored in text mode, but Phase 4 never verifies it. Because both features are implemented through shared global pre-parse state in `src/bin.ts` and `src/output.ts`, this precedence/orthogonality rule should be locked down with integration coverage rather than left implicit.

## Medium Priority (P2)

- Revisit whether `template render` really belongs in Tier 2 generic formatting; its primary payload is a multi-line prompt string, and the proposed key-value fallback will be readable but awkward for one of the most human-consumed commands.

## Readiness Checklist

**P0 blockers**
- [ ] Define how Commander parse-error output is suppressed or reshaped in `--text` mode
- [ ] Add integration tests for text-mode parse errors across required-option, unknown-option, and unknown-command cases

**P1 recommended**
- [ ] Specify non-lossy empty-value rendering for the generic text formatter
- [ ] Add tests proving `--pretty` / `--no-pretty` do not affect text mode
- [ ] Decide whether `template render` needs a custom text formatter

## Structured Assessment

```json
{
  "readiness": "ready_with_corrections",
  "items": [
    {
      "id": "R1",
      "title": "Text-mode parse-error handling does not yet match the documented contract",
      "action": "auto_fix",
      "reason": "The plan updates only the `catch` branches in `src/bin.ts`, but Commander already writes parse errors/help to stderr before control reaches that code. The plan needs an explicit output-routing change plus integration coverage for parse-error cases in `--text` mode.",
      "priority": "P0"
    },
    {
      "id": "R2",
      "title": "Generic text fallback is lossy for empty-but-meaningful results",
      "action": "auto_fix",
      "reason": "The proposed formatter omits empty arrays and empty objects entirely, which can hide legitimate success states or make `--text` output misleading. The plan should define explicit empty-state rendering.",
      "priority": "P1"
    },
    {
      "id": "R3",
      "title": "`--pretty` interaction with text mode is specified but untested",
      "action": "auto_fix",
      "reason": "The plan says `--pretty` is ignored in text mode, yet Phase 4 contains no assertion for that rule. Because both behaviors are controlled centrally in `bin.ts`/`output.ts`, the contract should be covered by integration tests.",
      "priority": "P1"
    }
  ],
  "summary": "The overall design is good and should be implementable without architectural rework, but the plan still misses one real correctness gap on Commander parse-error output and two smaller specification/test gaps around fallback rendering and flag interaction. Fix those mechanically, then it is ready to execute."
}
```

## Addendum (2026-03-15) - v1.1 follow-up

The v1.1 revision addresses the earlier blocking and high-priority gaps. The
plan now matches the intended text-mode contract, covers the empty-state cases
that would have made generic output lossy, and locks down the `--pretty` /
`--text` interaction with explicit tests.

**Readiness:** Ready - prior blockers are addressed; phasing, coverage, and
scope are now implementation-ready.

### What's Addressed

- `src/bin.ts` now has an explicit Phase 1 path for suppressing Commander's
  built-in parse-error stderr in text mode via `configureOutput`, plus manual
  and integration verification for required-option, unknown-option, and
  unknown-command cases.
- `formatGenericText()` now specifies stable empty rendering (`(none)`) for
  empty arrays and empty objects, including nested object fields, so text mode
  does not silently hide meaningful success states.
- Phase 4 now includes the previously-missing `--pretty` / `--no-pretty`
  interaction coverage, which is important because both behaviors are driven by
  shared pre-parse global state.
- The `template render` Tier 2 placement is now called out explicitly as an
  intentional rollout trade-off instead of an unexamined omission.

### Remaining Concerns

- None blocking. The only follow-up worth watching post-rollout is whether
  `template render` should move from generic formatting to a dedicated prompt-
  first formatter based on real usage.
