# Review: Orchestrator Improvements

**Review type:** `5x-cli/docs/development/019-orchestrator-improvements.md`
**Scope:** Implementation plan plus related config layering, template rendering, protocol validation, quality handler, parser, and phase-execution skill code/docs.
**Reviewer:** Staff engineer
**Local verification:** Not run

## Summary

The plan is directionally strong and the phase ordering mostly makes sense, but it is not implementation-ready yet. Two core parts are under-specified in ways that can either bypass the new checklist gate entirely or change path semantics for layered configs without a clear contract.

**Readiness:** Not ready - checklist-gate failure semantics and layered-path semantics need correction before implementation.

## Strengths

- Fixes the real user-facing pain points in the right general order: unblock sub-project config first, then isolated CLI behavior, then skill prose.
- Reuses existing shared seams such as `resolveLayeredConfig()`, `parseTemplate()`, `protocolValidate()`, and `resolveRunExecutionContext()` instead of inventing parallel paths.
- Keeps backward-compatibility in view with explicit flags/defaults like `--no-phase-checklist-validate` and explicit-var precedence for template defaults.
- Aligns the skill updates with already-existing internal variable generation for `review_path`, which reduces operator-only glue.

## Production Readiness Blockers

### P0.1 - Checklist validation is specified to fail open on explicit lookup errors

**Risk:** Phase 4 says missing plan files or missing phases should "skip silently". That means an explicit `--plan` typo, stale phase id, or plan-path mismatch can let `result: "complete"` validate successfully and bypass the very checklist gate this change is meant to enforce.

**Requirement:** Define fail-closed behavior for explicit validation inputs. At minimum, when the caller explicitly supplies `--plan` and `--phase`, unresolved plan/phase lookup must surface a validation error rather than silently succeeding. Silent skip is reasonable only for the best-effort auto-discovery path when neither input is available.

**Action:** `human_required`

## High Priority (P1)

### P1.1 - Phase 1 changes path semantics without a coherent contract

The plan says layered config should produce all-absolute `paths.*` values, but current architecture treats review/template paths as repo-relative by default and absolute only when configured as absolute (`src/commands/template-vars.ts`, `docs/development/016-review-artifacts-and-phase-checks.md`). The proposed helper also only rewrites raw configured values, so Zod defaults would remain relative anyway. As written, the phase mixes absolute and relative semantics and would make layered configs behave differently from non-layered configs.

Recommendation: choose one contract and state it precisely. Either preserve existing repo-relative semantics in layered config, or deliberately move all path consumers to absolute normalized values and audit every downstream caller/test accordingly.

**Action:** `human_required`

### P1.2 - Regression coverage is too indirect for the behavior this plan claims to fix

The plan mostly adds unit coverage around helpers, but the top-line bugs are user-visible workflow failures: sub-project `run init`, run-scoped author validation with auto-derived plan paths, and the stderr/stdout behavior of `quality run` when no gates are configured. Those need command-level integration coverage, not only helper tests, or the plan can pass while the actual operator flows still regress.

Recommendation: add explicit integration tests for the broken/fixed workflows, especially sub-project `5x run init`, `5x protocol validate author --run ...` with a mapped worktree plan, and the empty-quality-gates warning path.

**Action:** `auto_fix`

## Medium Priority (P2)

- The plan should call out reference-doc updates for the new `skipQualityGates` config key and `variable_defaults` frontmatter behavior so operators can discover the new contract without reading source. **Action:** `auto_fix`

## Readiness Checklist

**P0 blockers**
- [ ] Redefine Phase 4 so explicit `--plan`/`--phase` lookup failures do not silently bypass checklist enforcement.

**P1 recommended**
- [ ] Clarify whether layered `paths.*` stay repo-relative by default or become fully normalized absolute paths, and align completion gates/tests with that choice.
- [ ] Add command-level regression coverage for the user-visible flows this plan says it fixes.
