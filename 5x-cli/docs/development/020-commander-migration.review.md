# Review: Commander Migration Implementation Plan

**Review type:** `5x-cli/docs/development/020-commander-migration.plan.md`
**Scope:** Phase plan for citty -> commander migration across adapters, entrypoint, tests, and help content
**Reviewer:** Staff engineer
**Local verification:** Not run (static review: plan + PRD + adapter/tests/docs inspection)

## Summary

The plan is directionally right: it keeps the migration at the adapter boundary and phases the work sensibly. As written, though, it still inherits a few unresolved contract mismatches from the PRD and adds one correctness gap around the proposed `preAction`-only `--pretty` implementation. Those issues can cause real CLI regressions in automation and integration tests.

**Readiness:** Not ready — blocking contract and correctness gaps still need plan updates before implementation starts.

## Strengths

- The migration boundary is correct: handlers remain framework-independent and the plan keeps changes in adapters, `src/bin.ts`, and tests.
- The phasing is mostly sound: dependency/program skeleton -> adapter migration -> entrypoint -> tests -> help/polish keeps the blast radius controlled.
- The plan is concrete about target files, option mappings, and completion gates, which makes execution auditable.

## Production Readiness Blockers

### P0.1 - Global `--pretty` handling is under-specified and the proposed `preAction` hook is insufficient

**Risk:** The plan replaces argv pre-processing with a root `preAction` hook, but parse-time failures and help/version flows do not run command actions. That means `--pretty` / `--no-pretty` can silently stop applying to validation-error JSON envelopes, and possibly to non-leading flag placements that current tests/scripts rely on.

**Requirement:** Update the plan to preserve current global flag semantics explicitly: accepted anywhere in argv, last flag wins, and formatting applies even on parse/validation failures.

### P0.2 - `--worktree-path` compatibility is still treated as an internal detail when it is a public tested surface

**Risk:** The plan removes `--worktree-path` as a breaking change, but the current CLI documents it in `src/commands/run-v1.ts` and integration tests exercise it in `test/integration/commands/run-init-worktree.test.ts`. Removing it without a compatibility or deprecation plan breaks user automation and existing tests.

**Requirement:** Decide and document one of two paths: keep `--worktree-path` as a supported alias for at least one release, or explicitly scope this as a breaking change with migration/update steps across docs and tests.

## High Priority (P1)

### P1.1 - Help/output contract in Phase 5 still conflicts with actual command behavior

The plan reuses PRD help/footer content asserting that all commands emit JSON envelopes, but current behavior intentionally includes human-readable stdout for `5x init` and `5x upgrade`, plus streaming stdout for `5x run watch`. The plan should correct the documented contract instead of steering implementation toward an out-of-scope output-format change.

### P1.2 - Framework-level choice validation would regress current `prompt confirm` behavior

The plan specifies `.choices(["yes", "no"])` for `prompt confirm --default`, but the current handler and integration tests accept `yes/no/y/n/true/false`. Tightening validation at the framework layer would be a behavior break, not just a help improvement.

### P1.3 - Pipe-composability regressions are not covered in phase gates or tests

`invoke` and `run record` rely on subtle stdin-priority and envelope-ingestion behavior documented in `docs/development/archive/010-cli-composability.md`. The migration plan does not add explicit non-regression checks for `run init | invoke` and `invoke | run record`, so a parser/framework rewrite could regress core automation flows without tripping the listed completion gates.

## Medium Priority (P2)

- Validate and document the exact Commander help-customization approach before Phase 5 implementation; the current wording still leaves room for speculative API usage and avoidable implementation thrash.

## Readiness Checklist

**P0 blockers**
- [ ] Preserve `--pretty` / `--no-pretty` semantics for any argv position and parse-error JSON output
- [ ] Make an explicit compatibility/deprecation decision for `--worktree-path`

**P1 recommended**
- [ ] Correct help/footer language so documented stdout behavior matches real command behavior
- [ ] Preserve current accepted `prompt confirm --default` values
- [ ] Add pipe-composability non-regression coverage to phase gates/tests
- [ ] Lock down the exact Commander help-grouping/customization mechanism

## Structured Assessment

```json
{
  "readiness": "not_ready",
  "items": [
    {
      "id": "R1",
      "title": "Global --pretty design does not preserve current semantics",
      "action": "human_required",
      "reason": "The plan's preAction-only approach does not clearly preserve current global flag behavior for any argv position or for parse-time error envelopes, so the implementation strategy needs an explicit design decision.",
      "priority": "P0"
    },
    {
      "id": "R2",
      "title": "Plan removes documented --worktree-path without a compatibility decision",
      "action": "human_required",
      "reason": "`--worktree-path` is part of the current documented and tested CLI surface, so removing it requires an intentional compatibility/deprecation call rather than an implicit cleanup.",
      "priority": "P0"
    },
    {
      "id": "R3",
      "title": "Help and readiness gates describe the wrong stdout contract",
      "action": "auto_fix",
      "reason": "The plan can be corrected mechanically to reflect that some commands remain human-readable or streaming instead of JSON-envelope output.",
      "priority": "P1"
    },
    {
      "id": "R4",
      "title": "Choice validation plan would break prompt confirm defaults",
      "action": "auto_fix",
      "reason": "The plan should match current accepted values (`yes/no/y/n/true/false`) or keep this validation in the handler; the current `.choices([\"yes\",\"no\"])` direction is a mechanical plan bug.",
      "priority": "P1"
    },
    {
      "id": "R5",
      "title": "Pipe-composability regressions are not called out in migration gates",
      "action": "auto_fix",
      "reason": "The plan can add explicit test/gate coverage for stdin-priority and pipe-based workflows that existing automation depends on.",
      "priority": "P1"
    }
  ],
  "summary": "The plan is close, but it is not yet safe to execute because it still leaves two contract-level decisions unresolved and misses key non-regression coverage around global pretty handling and CLI composability. Fix those plan gaps first, then implementation can proceed cleanly."
}
```
