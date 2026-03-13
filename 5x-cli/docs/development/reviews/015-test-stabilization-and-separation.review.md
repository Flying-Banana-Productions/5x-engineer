# Review: Test Stabilization and Unit/Integration Separation

**Review type:** 5x-cli/docs/development/015-test-stabilization-and-separation.md
**Scope:** Full implementation plan — Phases 1–5
**Reviewer:** Staff engineer
**Local verification:** Read PRD, `init.handler.ts`, `worktree.handler.ts`, `run-v1.handler.ts`, `upgrade.handler.ts`, `context.ts`, `installer.ts`, `locations.ts`, `test/setup.ts`, and representative test files (`init.test.ts`, `init-opencode.test.ts`, `skills-install.test.ts`, `control-plane.test.ts`)

## Summary

The plan correctly attacks the underlying problem: too many tests pay subprocess
cost and inherit ambient cwd/env state, so adding explicit `startDir` seams and
separating unit from integration is the right direction. Phase ordering is also
mostly sound: harden first, then refactor, then rename, then convert.

The plan is not ready as written. The Phase 4 conversion strategy relies on
global mutation patterns that `test/setup.ts` already documents as unsafe under
`bun test --concurrent`, and the `run-v1` `startDir` work is underspecified
enough that the stated Phase 2 completion gate would not actually be met.

**Readiness:** Not ready — the main unit-conversion strategy still needs human
decisions on how CLI-facing output and HOME-dependent behavior are observed
without reintroducing concurrency flakes.

## Strengths

- The diagnosis is directionally correct: the flake is systemic, not a one-off
  in `isolated-mode.test.ts`.
- Phasing is mostly dependency-correct: hardening before mass moves keeps Phase
  3 closer to a pure rename.
- Adding an optional trailing `startDir` parameter is the right compatibility
  shape for handler-level testability.
- Preserving `test/helpers/` and `test/setup.ts` in place avoids gratuitous
  churn in shared test infrastructure.
- The plan explicitly keeps total test count stable and calls out the known
  partial-conversion candidates as out of scope.

## Production Readiness Blockers

### P0.1 — Phase 4 lacks a concurrency-safe strategy for CLI-output and HOME-sensitive tests

**Risk:** The proposed conversions for `test/commands/init.test.ts` and
`test/commands/init-opencode.test.ts` will either stop asserting important
CLI-facing behavior or reintroduce the same class of global-state flakes the
plan is trying to remove. `test/setup.ts` explicitly warns that monkey-patching
console functions is unsafe under `bun test --concurrent`, yet the plan
suggests temporarily replacing `console.log`. Separately, `init-opencode`
user-scope tests currently rely on per-test `HOME` overrides; direct handler
calls would need process-wide env mutation or a new injection seam.

**Requirement:** Pick and document one explicit strategy before implementation:
either (a) keep CLI-output / HOME-dependent cases as thin integration tests,
or (b) refactor handlers/location resolvers to support dependency-injected log
sinks and home-directory resolution so unit tests can observe behavior without
mutating globals.

## High Priority (P1)

### P1.1 — `skills-install` conversion targets the installer helper, not the command behavior

Converting `test/commands/skills-install.test.ts` to call
`installSkillFiles()` does not preserve the behavior the current file covers.
Those tests exercise `skillsInstall()` semantics: scope resolution,
`--install-root`, stderr progress messages, and the success envelope. The
installer helper only writes files; it cannot validate command-level behavior.

Recommendation: either unit-test `skillsInstall()` directly (with any needed
test seams), or keep the scope/install-root/output cases in integration and
only extract the truly pure filesystem assertions.

### P1.2 — Phase 2 does not actually specify a complete `startDir` contract for `run-v1.handler.ts`

The plan says all four handler files will accept optional `startDir`, but the
`run-v1.handler.ts` section only changes the private `ensureRunWorktree()`
helper. It does not add `startDir` to `RunInitParams`, nor does it specify how
relative `plan` / `worktreePath` inputs should resolve when a non-default start
directory is supplied. As written, the Phase 2 completion gate would still be
false for `runV1Init()`.

Recommendation: update the plan to make the exported `runV1Init()` contract
explicit and define relative-path semantics when `startDir` is provided.

### P1.3 — Phase 3 import-rewrite guidance is mechanically incorrect for moved top-level tests

The plan says files moved from `test/*.test.ts` to `test/unit/*.test.ts` or
`test/integration/*.test.ts` can keep `../../src/`, but the current top-level
tests generally import from `../src/` (for example `test/config.test.ts` and
`test/paths.test.ts`). After the move, those paths become `../../src/`. The
same risk applies to dynamic imports and `require()` calls inside test bodies.

Recommendation: replace the path-depth heuristics with an audit/update step
based on actual imports in each moved file.

## Medium Priority (P2)

- The file inventory should be revalidated mechanically before Phase 3 starts.
  The PRD and plan already disagree on total test-file counts, and Phase 3/4
  depend on exact rename and split lists.

## Readiness Checklist

**P0 blockers**
- [ ] Decide how converted tests observe CLI output and HOME-dependent behavior without global mutation

**P1 recommended**
- [ ] Re-scope `skills-install` conversion around command behavior, not just installer helpers
- [ ] Define the exported `runV1Init(startDir)` contract and relative-path semantics
- [ ] Recompute import-path updates from actual file contents before the mass move

## Addendum (March 12, 2026) — Re-review of v1.1

### What's Addressed

The revision closes the substantive issues from the initial review.

- **P0.1 (concurrency-safe conversion strategy):** Resolved. The plan now
  explicitly says converted unit tests assert only on return values and
  filesystem side effects, never on captured console output, and it keeps
  CLI-output / `HOME`-dependent cases as integration tests.
- **P1.1 (`skills-install` scope):** Resolved. `skills-install.test.ts` now
  stays fully in the integration tier, with the plan correctly framing it as
  CLI-behavior coverage rather than pure installer-helper coverage.
- **P1.2 (`run-v1` `startDir` contract):** Resolved by de-scoping. The plan no
  longer claims `run-v1.handler.ts` is part of this refactor and explicitly
  documents why it is deferred.
- **P1.3 (import rewrite guidance):** Resolved. Phase 3 now requires an
  import-audit pass based on actual `import` / `require()` / dynamic `import()`
  usage instead of path-depth heuristics.
- **P2.1 (inventory drift):** Resolved. The plan now adds a pre-move
  reconciliation step to revalidate the actual `test/**/*.test.ts` inventory
  before the mass rename.

### Remaining Concerns

#### P2.2 — `worktreeList` `startDir` threading is still underspecified

Phase 2 says `worktree.handler.ts` will replace all 7 `resolve(".")` call
sites, including the one in `worktreeList()`, and says to thread
`params.startDir` through `worktreeList`. But the checklist only adds
`startDir?: string` to `WorktreeCreateParams`, `WorktreeRemoveParams`, and
`WorktreeAttachParams`; it does not explicitly define the updated exported
signature for `worktreeList()`.

This looks mechanically fixable — likely `worktreeList(params?: { startDir?:
string })` or equivalent — but the plan should state it directly so Phase 2's
completion gate is unambiguous.

### Updated Readiness Assessment

**Readiness:** Ready with corrections — the prior blockers are addressed and the
plan is now implementation-ready in substance. One remaining mechanical
clarification should be made around the `worktreeList()` `startDir` signature so
the Phase 2 contract is fully explicit.
