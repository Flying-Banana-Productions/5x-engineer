# Review: Commander Migration Phase 1

**Review type:** commit `cbaee715b817c2225086d06b46d1e16d1f563479`
**Scope:** Phase 1 dependency swap and `src/program.ts` skeleton for `020-commander-migration.plan.md`
**Reviewer:** Staff engineer
**Local verification:** `bun run typecheck` - passed

## Summary

Phase 1 is implemented as planned. The new runtime dependencies are correctly added to `dependencies`, `bun.lock` is updated, and `src/program.ts` exports a minimal Commander factory that typechecks cleanly without disturbing the existing citty entrypoint.

**Readiness:** Ready - Phase 1 completion gate is met; no blocking issues found.

## Strengths

- Keeps `citty` in place while introducing Commander, matching the phased migration strategy and avoiding premature churn.
- Places `@commander-js/extra-typings` in runtime `dependencies`, which matches the actual import surface.
- `src/program.ts` stays intentionally minimal and aligns with the plan's error-handling strategy (`exitOverride`, help-after-error, suggestion support).

## Production Readiness Blockers

None.

## High Priority (P1)

None.

## Medium Priority (P2)

- No medium-priority issues for this phase.

## Readiness Checklist

**P0 blockers**
- [x] Phase 1 dependency additions are present in `package.json` and `bun.lock`.
- [x] `src/program.ts` exports a minimal Commander program factory.
- [x] `bun run typecheck` passes.

**P1 recommended**
- [x] Proceed to Phase 2 adapter migration.

## Addendum (2026-03-14) - Phase 2 adapter migration

### What's Addressed

- Reviewed commit `f5c806b1b935e3a39f6f795cbf326c27090ca588` and current `HEAD`; no follow-on commits were present.
- Verified all 13 adapter files under `src/commands/` now export Commander-style `register*()` functions and no `citty` imports remain in that directory.
- Verified `src/utils/parse-args.ts` adds the planned Commander parser wrappers and `bun run typecheck` passes.
- The highest-risk adapters (`src/commands/run-v1.ts`, `src/commands/invoke.ts`, `src/commands/protocol.ts`) match the planned command topology closely enough to proceed into the Phase 3 entrypoint rewrite.

### Remaining Concerns

- `src/commands/harness.ts` does not apply Commander `.choices()` to `--scope` for `install` or `uninstall`, which leaves a small Phase 2 plan-compliance gap. Handler-side validation still protects correctness, so this is mechanical rather than blocking.
- Readiness: Ready with corrections - Phase 2 completion gate is met (`bun run typecheck` passes, adapters are rewritten, `src/commands/` is citty-free), but the harness scope validation/help surface should be tightened.

## Addendum (2026-03-14) - Phase 3 bin.ts entrypoint rewrite

### Assessment

- Reviewed `e1ccdb1` plus follow-on changes since `f5c806b1b935e3a39f6f795cbf326c27090ca588`.
- `src/bin.ts` now delegates to Commander cleanly, registers all 13 planned top-level commands, and removes the citty-specific subcommand/help/version glue.
- `src/program.ts` still applies `.exitOverride()`, so Commander throws instead of calling `process.exit()` directly; Phase 3 error handling stays under the CLI's JSON envelope contract.
- `program.configureOutput()` routes framework errors to stderr, while the catch block emits envelope JSON on stdout. Local verification matched that split for required-option and unknown-command failures.
- `CommanderError` mapping is correct for the reviewed paths: `commander.unknownCommand` -> `UNKNOWN_COMMAND`, `commander.unknownOption` -> `UNKNOWN_OPTION`, everything else -> `INVALID_ARGS`.
- The `--pretty` / `--no-pretty` pre-parse strip is preserved and works from arbitrary argv positions without being exposed in Commander help.
- `run init` keeps the planned `--worktree [path]` handling and hidden `--worktree-path` compatibility path; deprecated alias use emits the expected stderr warning.

### Local verification

- `bun run typecheck` - passed
- `bun run src/bin.ts --help` - passed; commander help lists all 13 top-level commands
- `bun run src/bin.ts --version` - passed
- `bun run src/bin.ts run complet` - passed; stderr suggestion shown, stdout envelope code `UNKNOWN_COMMAND`, exit 1
- `bun run src/bin.ts --no-pretty run init` - passed; compact stdout envelope with `INVALID_ARGS`, framework text on stderr
- `bun run src/bin.ts run init --plan 5x-cli/docs/development/020-commander-migration.plan.md --bogus` - passed; stdout envelope code `UNKNOWN_OPTION`

### Readiness

- Readiness: ready
- Summary: Phase 3 is complete as planned. No blocking issues found in the `bin.ts` rewrite.
- Items: none

## Addendum (2026-03-14) - Phase 4 test updates

### Assessment

- Reviewed commit `53592f290f7e89f2e57dbd03d8c50c3899d935ee` against Phase 3 base `e1ccdb1`; no follow-on commits were present beyond the Phase 4 test update commit.
- `test/unit/utils/parse-args.test.ts` adds the planned commander-wrapper coverage for `intArg`, `floatArg`, `timeoutArg`, and `collect` without changing the existing parser behavior assertions.
- `test/integration/commands/commander-errors.test.ts` covers the key commander error-code mappings now enforced in `bin.ts`: unknown command -> `UNKNOWN_COMMAND`, unknown option -> `UNKNOWN_OPTION`, and validation failures -> `INVALID_ARGS`.
- Updated integration assertions correctly track commander text where framework wording changed (`harness.test.ts`, `run-init-worktree.test.ts`, `worktree-guards.test.ts`), and the `protocol-validate` coverage now exercises the intended `--iteration 0` behavior.
- The new/updated subprocess tests follow `AGENTS.md` integration-test hygiene: `cleanGitEnv()` on child processes that touch git, `stdin: "ignore"` except when intentionally piping, and explicit per-test timeouts.

### Local verification

- `bun test test/unit/utils/parse-args.test.ts test/integration/commands/commander-errors.test.ts test/integration/commands/run-init-worktree.test.ts test/integration/pipe.test.ts test/integration/commands/invoke-pipe.test.ts test/integration/commands/run-record-pipe.test.ts test/integration/commands/protocol-validate.test.ts test/integration/commands/harness.test.ts` - passed (134 tests)

### Readiness

- Readiness: ready
- Summary: Phase 4 is complete for the reviewed scope. Test updates match the commander migration, cover the new error mapping paths, and preserve pipe-composability coverage.
- Items: none

## Addendum (2026-03-14) - Phase 5 help content and polish

### Assessment

- Reviewed commit `6b6f3f49bb63a0b5458f54d3a81e6690eab72bd8` against Phase 4 base `53592f290f7e89f2e57dbd03d8c50c3899d935ee`.
- Program-level description/footer, command summaries/descriptions, and most example blocks are present and materially improve the Commander help surface.
- Local help verification passed for `5x --help`, `5x run --help`, `5x invoke author --help`, `5x run record --help`, and `5x protocol validate author --help`.

### Blocking issues

- `src/commands/invoke.ts` ships invalid examples for both `invoke author` and `invoke reviewer`: the help text uses `-p phase-1`, but these commands only define `--phase` (no `-p` short flag). Running the documented example fails immediately with `UNKNOWN_OPTION`.
- `src/commands/protocol.ts` repeats the same stale `-p phase-1` example for `protocol validate author`; that command also only defines `--phase`, so the help example is incorrect and fails with `UNKNOWN_OPTION`.

### Local verification

- `bun run src/bin.ts --help` - passed
- `bun run src/bin.ts run --help` - passed
- `bun run src/bin.ts invoke author --help` - passed, but example text is incorrect
- `bun run src/bin.ts protocol validate author --help` - passed, but example text is incorrect
- `bun run src/bin.ts invoke author author-next-phase -r abc123 --record -p phase-1` - failed with `UNKNOWN_OPTION`
- `bun run src/bin.ts protocol validate author -i result.json --record -r abc123 -p phase-1` - failed with `UNKNOWN_OPTION`

### Readiness

- Readiness: not ready
- Summary: Phase 5 is close, but the help examples were not fully audited against the actual CLI surface. The documented `-p` examples are stale and contradict the Phase 5 acceptance criteria.
- Items:
  - Replace `-p phase-1` with `--phase phase-1` in the invalid `invoke` and `protocol validate author` help examples, then re-verify the examples against the current option definitions.

## Addendum (2026-03-14) - Phase 5 re-review after help example fix

### Assessment

- Reviewed fix commit `5dba6cac1a1a95e42a7afd5d4f532048d0d4a682` via `git diff 6b6f3f4..5dba6ca`.
- Verified `src/commands/invoke.ts` now uses `--phase phase-1` in both previously broken examples (`invoke author`, `invoke reviewer`), matching the command's actual option surface.
- Verified `src/commands/protocol.ts` now uses `--phase phase-1` in the `protocol validate author` example, matching the defined option.
- Spot-checked other adapter help examples with short flags in `src/commands/run-v1.ts`, `src/commands/quality-v1.ts`, `src/commands/harness.ts`, `src/commands/worktree.ts`, and `src/commands/diff.ts`; sampled short-form usage matches declared options, with no remaining `-p`/`--phase` mismatch found.

### Readiness

- Readiness: ready
- Summary: The two Phase 5 help-example blockers are fixed, and the spot-check did not find additional short-flag/help mismatches in nearby adapter help text.
- Items: none

## Addendum (2026-03-14) - Phase 6 cleanup and final migration completeness

### Assessment

- Reviewed commit `cdc2b510066acbc3efc52ce2b328ab1c70c38e30` via `git log 5dba6ca..HEAD --oneline` and `git diff 5dba6ca..HEAD`; scope is limited to dependency cleanup, lockfile refresh, plan checklist updates, and removal of stale citty wording in comments/docs.
- Verified `5x-cli/package.json` no longer lists `citty`, and `5x-cli/bun.lock` no longer contains `citty` or its transitive `consola` entry.
- Verified zero `citty` imports remain under `5x-cli/src/` and no `defineCommand`, `runCommand`, or `CLIError` references remain in active source, which closes out the old framework surface rather than only renaming comments.
- Verified stale commented/documented citty references in active source were cleaned up (`src/bin.ts`, handler docblocks, `src/utils/parse-args.ts`, `src/utils/stdin.ts`, integration test comments).
- Final migration completeness looks good: active CLI entrypoint and all 13 command adapters now import Commander typings/APIs, while residual `citty` mentions are confined to historical docs/reviews/archives and the implementation plan itself.

### Verification

- `git log 5dba6ca..HEAD --oneline` -> single Phase 6 cleanup commit present.
- `git diff 5dba6ca..HEAD` -> matches planned cleanup only; no unreviewed functional churn.
- `grep '"citty"' 5x-cli/package.json` -> no matches.
- `grep 'from ["'"']citty["'"']|require\(["'"']citty["'"']\)' 5x-cli/src` -> no matches.
- `grep 'defineCommand|runCommand|CLIError' 5x-cli/src` -> no matches.
- Full test suite status accepted per orchestrator note: `1441 pass, 0 fail`.

### Readiness

- Readiness: ready
- Summary: Phase 6 meets its cleanup gate, and the citty -> Commander migration is complete in active CLI code.
- Items: none
