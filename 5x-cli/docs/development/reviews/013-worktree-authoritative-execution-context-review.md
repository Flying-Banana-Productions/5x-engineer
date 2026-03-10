# Review: Worktree-Authoritative Execution Context

**Review type:** `5x-cli/docs/development/013-worktree-authoritative-execution-context.md`
**Scope:** Implementation plan plus related architecture/docs and current handlers for context, config, run, invoke, quality, diff, worktree, init, DB, locks, and pipe behavior.
**Reviewer:** Staff engineer
**Local verification:** Not run

## Summary

The direction is right: root control-plane + run-scoped worktree resolution is the correct fix for the current cwd-driven split-brain behavior. But the plan is not implementation-ready yet because it still has one unresolved bootstrap contradiction around DB discovery, leaves `5x init` mode semantics underspecified, and does not fully pin down the plan-path contract when the stored plan is outside the repo root.

**Readiness:** Not ready - core control-plane bootstrap and mode-boundary decisions still need human resolution.

## Strengths

- Correctly identifies the current failure mode: DB, logs, and execution context drift with cwd/worktree location.
- Uses `git rev-parse --git-common-dir` as the right primitive for externally attached worktrees.
- Makes run-scoped context first-class instead of patching `invoke` alone.
- Fails closed on missing mapped worktrees, which is the right safety posture.
- Adds plan-anchored config layering, which fits the monorepo/sub-project use case better than ambient cwd discovery.

## Production Readiness Blockers

### P0.1 - DB bootstrap contract is internally inconsistent

**Risk:** The plan cannot deterministically find the canonical DB. `resolveControlPlaneRoot()` is defined in terms of `<main-repo>/.5x/5x.db`, but Phase 1c still says the root config `db` section remains authoritative. Those two rules conflict whenever the root config sets `db.path` to anything other than `.5x/5x.db`, and the current codebase already honors configurable DB paths.

**Requirement:** Pick one bootstrap contract and make the whole plan consistent with it:
- either hard-deprecate root `db.path` overrides and make `<controlPlaneRoot>/.5x/5x.db` the only supported DB location,
- or define a two-stage bootstrap that can safely discover the root config before opening the DB, then use the root-config DB path everywhere.

**Action:** `human_required`

### P0.2 - `5x init` behavior is missing from the managed-vs-isolated design

**Risk:** The plan's operating modes depend on `5x init`, but the implementation phases do not update `src/commands/init.handler.ts`. Today `5x init` always scaffolds `5x.toml` and `.5x/` in the current cwd. Without an explicit `init` contract, linked-worktree invocation can still create competing local state and undermine the "no `.5x` in managed worktrees" rule.

**Requirement:** Specify and test `5x init` behavior for each mode boundary:
- from the main checkout,
- from a linked worktree when the main repo is already 5x-managed,
- from a linked/external worktree when the main repo is not 5x-managed.

The plan needs an explicit UX decision on whether linked-worktree `5x init` should refuse, redirect to the control-plane root, or require an override.

**Action:** `human_required`

## High Priority (P1)

### P1.1 - The plan-path mapping contract is underspecified for plans outside the repo root

The run-context resolver assumes it can derive a repo-relative path from `run.plan_path` and re-root it into the mapped worktree. That works only if the canonical plan path is inside the control-plane repo tree. The current code stores absolute canonical paths and does not enforce that plans live under the repo root, so this feature needs a clear rule for external plans and realpath/symlink edge cases.

Recommendation: either require run/worktree-managed plans to live under `controlPlaneRoot` and validate that at `run init` / `worktree attach`, or explicitly document a fallback/error contract for external plans. Add tests for external-path rejection or fallback behavior.

**Action:** `human_required`

### P1.2 - Root-scoped artifacts need to be explicit, not implicit

The design says the root repo stays the single control-plane for DB, locks, and logs, but the implementation phases only partially thread that through. Current handlers root `.5x` paths off `projectRoot` in multiple places (`invoke`, `quality`, `run watch`, lock files, default worktree path, template override dir). If the plan does not explicitly re-anchor all of those to `controlPlaneRoot`, state will still split after the DB fix.

Recommendation: add explicit checklist items for root-scoping:
- log directories in `invoke`, `quality`, and `run watch`,
- lock paths used by `run init` / `run complete` / `run reopen`,
- template override lookup under `<controlPlaneRoot>/.5x/templates/prompts`,
- default managed worktree creation under `<controlPlaneRoot>/.5x/worktrees`.

This looks mechanical once the control-plane contract is fixed.

**Action:** `auto_fix`

## Medium Priority (P2)

- Legacy split-brain state needs rollout guidance. The current bug can already create worktree-local DBs/mappings/logs; after this change those local DBs will be ignored in managed mode. Even if migration stays out of scope, the plan should at least call for detection/warnings so users are not surprised by "missing" runs or mappings. **Action:** `human_required`

## Readiness Checklist

**P0 blockers**
- [ ] Resolve the canonical DB bootstrap contract (`.5x/5x.db` only vs root-config `db.path`).
- [ ] Add explicit `5x init` managed/isolated mode behavior and tests.

**P1 recommended**
- [ ] Define the allowed contract for `run.plan_path` when the plan is outside the control-plane repo.
- [ ] Make every `.5x` artifact root explicit in the phases and test matrix.

## Addendum (2026-03-09) - v1.5 Re-review

### What's Addressed

- The DB bootstrap contradiction is substantially resolved: the plan now defines a two-stage bootstrap and makes the canonical DB file `5x.db` inside a configured state directory.
- `5x init` mode semantics are now explicit: managed linked-worktree init is refused, with tests and handler updates called out.
- The plan-path contract is now explicit: managed plans must live under `controlPlaneRoot`, with `run init` and run-context validation errors defined.
- Artifact re-anchoring is now first-class: logs, locks, templates, worktrees, debug, and DB paths are all enumerated with file-level implementation checklists and tests.
- Legacy split-brain state now has a concrete warning path in Phase 6.

### Remaining Concerns

- **P1.1 - `db.path` compatibility is now under-specified.** The plan changes `db.path` from a file path to a directory path, but the current config schema and likely existing user configs still use file semantics (default today is `.5x/5x.db` in `src/config.ts`). As written, an existing configured value like `.5x/5x.db` would now resolve to `.5x/5x.db/5x.db`, breaking backward compatibility despite the plan's compatibility claims. This should be fixed mechanically by either supporting both legacy file-style and new directory-style values during resolution, or by explicitly adding config migration/normalization rules and tests. **Action:** `auto_fix`
- **P1.2 - Isolated-mode `db.path` resolution is still ambiguous.** Step 4 reads `db.path` from the root config file, then step 5 says to check the current checkout root for a local `<stateDir>/5x.db` using the same resolution. That leaves an unresolved design question when the main repo is unmanaged but the current worktree has its own local `5x.toml`: should isolated mode honor the local checkout's `db.path`, inherit root config if present, or always use default `.5x`? This materially affects where local state is created/found, so the plan needs one explicit rule. **Action:** `human_required`
- **P2.1 - The symlink remediation text contradicts current canonicalization.** The new error text for plans outside `controlPlaneRoot` says users can "use a symlink," but `canonicalizePlanPath()` currently resolves symlinks via `realpathSync`, so a symlink to an external plan would still canonicalize outside the repo and be rejected. Either remove that remediation or specify a different path-handling change. **Action:** `auto_fix`

## Addendum (2026-03-09) - v1.6 Re-review

### Outcome

The v1.6 revision addresses the remaining issues from the v1.5 addendum. The plan now has a coherent bootstrap story, explicit isolated-mode config ownership, and corrected plan-path remediation. At this point the remaining work is implementation, not design clarification.

### Previously Raised Issues

- **Resolved - `db.path` backward compatibility.** The plan now explicitly normalizes legacy file-style values such as `.5x/5x.db` to the parent directory before joining `5x.db`, and it adds implementation notes, tests, and acceptance criteria for that behavior.
- **Resolved - isolated-mode `db.path` source.** The plan now explicitly states that in isolated mode the checkout root becomes `controlPlaneRoot` and the checkout's local `5x.toml` is the sole config, including `db.path`.
- **Resolved - symlink remediation conflict.** The plan removes the incorrect symlink guidance and now correctly documents that `canonicalizePlanPath()` resolves symlinks, so external targets remain invalid.

### Assessment

- Correctness looks sound: control-plane resolution, run-context resolution, and mode precedence now form a consistent model.
- Architecture fits the existing codebase: the plan introduces focused helpers (`resolveControlPlaneRoot`, `resolveRunExecutionContext`, layered config resolution) instead of scattering more cwd-based fixes.
- Completeness is good: the plan covers command behavior, artifact rooting, mode boundaries, config layering, rollout, and a broad test matrix including attached worktrees and isolated mode.
- Phasing is reasonable: resolver and config primitives come before handler rewiring and docs/skills updates.
- Testability is strong: the matrix is specific and maps well to the identified failure modes.

**Readiness:** Ready

## Addendum (2026-03-09) - Phase 1 implementation re-review

### What's Addressed

- `resolveControlPlaneRoot`, `resolveRunExecutionContext`, and layered config resolution are now implemented with focused helpers instead of more cwd-specific branching.
- The latest follow-up closes the two correctness gaps from the previous round: `5x init` now scaffolds at the checkout root when invoked from a subdirectory, and `run init` normalizes legacy file-style `db.path` values before opening the DB.
- Regression coverage improved materially. Targeted Bun tests for control-plane resolution, run-context resolution, init guard behavior, and config layering all pass locally.

### Remaining Concerns

- **P1.1 - Control-plane bootstrap still ignores JS/MJS `db.path` overrides.** `readDbPathFromConfig()` only reads `5x.toml` and explicitly falls back to the default when the root config is `5x.config.js` or `5x.config.mjs` (`5x-cli/src/commands/control-plane.ts:85`, `5x-cli/src/commands/control-plane.ts:107`). That means an existing repo with a custom DB location in JS config can be misdetected as unmanaged from a worktree, reopening the split-brain problem the phase is meant to close. Because the current resolver is synchronous, fixing this needs an explicit product/architecture choice: either support JS/MJS during bootstrap or formally narrow the contract to TOML-only for `db.path`. **Action:** `human_required`
- **P1.2 - Layered config discovery can escape the control-plane root.** `resolveLayeredConfig()` uses `discoverConfigFile()` for both the root and nearest lookup, and that helper walks all the way to `/` with no boundary (`5x-cli/src/config.ts:153`, `5x-cli/src/config.ts:478`, `5x-cli/src/config.ts:502`). If a repo lacks an in-repo `5x.toml`, the resolver can silently adopt a parent-directory config outside `controlPlaneRoot`, which violates the plan's "root config from controlPlaneRoot" contract and can leak unrelated paths/quality settings into the repo. Bound both searches to `controlPlaneRoot` and add regression coverage. **Action:** `auto_fix`

### Assessment

- Architecture is headed the right way and most Phase 1 mechanics are now in place.
- This is not ready to advance as complete Phase 1 work yet because bootstrap behavior for non-TOML configs is still undefined in shipped code.
- If the JS/MJS bootstrap contract is resolved and the config-discovery boundary is fixed, the remaining issues here look mechanical.

**Readiness:** Not ready

## Addendum (2026-03-09) - Commit `5366302` Phase 4 review

### What's Addressed

- `run init` now emits top-level `worktree_path` alongside the existing nested `worktree` object, which matches the Phase 4 requirement to make pipe context extraction work without teaching `extractPipeContext()` about nested payloads (`5x-cli/src/commands/run-v1.handler.ts:215`, `5x-cli/src/commands/run-v1.handler.ts:550`, `5x-cli/src/commands/run-v1.handler.ts:579`).
- `worktree_plan_path` is derived conservatively and only emitted when the re-rooted plan file actually exists in the mapped worktree, preserving the Phase 2 fix that avoided advertising a root-checkout path as a worktree-local plan (`5x-cli/src/commands/run-v1.handler.ts:226`).
- Regression coverage is adequate for this delta: the subprocess tests cover fresh and resumed `run init --worktree` flows, the no-worktree path, and the optional `worktree_plan_path` behavior; pipe parsing tests cover both enriched and legacy envelopes (`5x-cli/test/commands/run-init-worktree.test.ts:179`, `5x-cli/test/commands/invoke-pipe.test.ts:463`).
- Local verification passes: `bun test 5x-cli/test/commands/run-init-worktree.test.ts 5x-cli/test/commands/invoke-pipe.test.ts` (18 pass).

### Remaining Concerns

- None for this change set. The implementation matches the Phase 4 plan slice and does not reopen the earlier control-plane/worktree-path issues.

### Assessment

- Correctness looks good: downstream pipe consumers can now receive worktree context directly from `run init`, and the emitted fields remain additive/backward compatible.
- Architecture stays consistent with the plan: the change is localized to `run init` payload shaping, leaving shared pipe parsing behavior simple.
- Test strategy is proportionate to the delta and covers the important compatibility edges.

**Readiness:** Ready

## Addendum (2026-03-09) - Commit `1bb1427` re-review

### What's Addressed

- The control-plane bootstrap gap called out in the last review is now closed for the supported config file set. `readDbPathFromConfig()` stops on the first discovered config file and extracts literal `db.path` values from `5x.toml`, `5x.config.js`, and `5x.config.mjs`, so managed worktrees no longer silently fall back to `.5x` when the root repo keeps its DB path in JS/MJS config (`5x-cli/src/commands/control-plane.ts:85`).
- The added tests cover the new bootstrap cases and the precedence rule that matters here: JS config, MJS config, TOML-over-JS precedence, and "first config wins even when TOML omits `db.path`" (`5x-cli/test/commands/control-plane.test.ts:280`).
- Local verification passes: `bun test 5x-cli/test/commands/control-plane.test.ts 5x-cli/test/config-layering.test.ts` (32 pass).

### Remaining Concerns

- None for this change set. The previously open JS/MJS bootstrap issue is addressed, and I do not see a new blocker introduced by `1bb1427`.

### Assessment

- Correctness is improved in the right place: the control-plane resolver now honors the same config filename precedence the rest of the config system uses during bootstrap.
- Architecture stays consistent with the Phase 1 design: the fix remains localized to the bootstrap helper and tightens coverage rather than adding more cwd-specific branching.
- Test strategy is adequate for this delta: the new cases exercise both new config formats and the precedence behavior that previously regressed.

**Readiness:** Ready

## Addendum (2026-03-09) - Commit `41abb41` re-review

### What's Addressed

- The Phase 2 envelope bug is fixed. `invoke` now only emits `worktree_plan_path` when `resolveRunExecutionContext()` confirmed that the derived plan path actually exists in the mapped worktree (`5x-cli/src/commands/invoke.handler.ts:344`, `5x-cli/src/commands/invoke.handler.ts:634`).
- That behavior matches the plan contract more closely: downstream consumers no longer get a misleading `worktree_plan_path` that actually points back at the control-plane checkout.
- Focused verification passes locally: `bun test 5x-cli/test/commands/invoke-worktree.test.ts` (10 pass).

### Remaining Concerns

- **P1.1 - Control-plane bootstrap still ignores JS/MJS `db.path` overrides.** This commit fixes the output-envelope correctness issue, but it does not change the unresolved bootstrap contract in `5x-cli/src/commands/control-plane.ts:85`. The resolver still falls back to `.5x` when the authoritative root config is `5x.config.js` or `5x.config.mjs`, so a managed repo with a custom JS/MJS `db.path` can still be misdetected from a worktree. That remains a correctness and plan-compliance gap requiring an explicit product/architecture decision: either support JS/MJS bootstrap or narrow the supported bootstrap contract to TOML-only. **Action:** `human_required`

### Assessment

- The shipped fix is correct and closes the previously raised `worktree_plan_path` issue without widening behavior.
- Phase 2 is still not ready to mark complete because the broader control-plane bootstrap contract remains unresolved in shipped code.

**Readiness:** Not ready

## Addendum (2026-03-09) - Commit `36bd2a4` Phase 2 review

### What's Addressed

- `invoke` now resolves the control-plane and run execution context before starting the provider, which is the right architectural shape for Phase 2.
- Log and template override paths are now rooted under `controlPlaneRoot/stateDir`, matching the Phase 2 artifact-rooting requirement.
- The follow-on commit `c484f93` improves `init` test isolation and keeps the Phase 1 guard coverage stable under repeated subprocess runs.

### Remaining Concerns

- **P1.1 - `worktree_plan_path` can point at the root checkout instead of the mapped worktree.** `resolveRunExecutionContext()` intentionally falls back to the root `plan_path` when the plan file is absent in the mapped worktree (`5x-cli/src/commands/run-context.ts:184`), but `invoke` still emits that value as `worktree_plan_path` whenever any worktree mapping exists (`5x-cli/src/commands/invoke.handler.ts:632`). That makes the envelope lie about where the plan lives and can mislead downstream pipe consumers that treat `worktree_plan_path` as a worktree-local path. Only emit `worktree_plan_path` when the derived worktree plan path actually exists, and add a regression test for the mapped-worktree/missing-plan-file case. **Action:** `auto_fix`
- **P1.2 - Control-plane bootstrap still ignores JS/MJS `db.path` overrides.** This phase builds more behavior on top of `resolveControlPlaneRoot()`, but the bootstrap helper still only reads `db.path` from `5x.toml` and silently falls back to `.5x` for `5x.config.js` / `5x.config.mjs` (`5x-cli/src/commands/control-plane.ts:85`, `5x-cli/src/commands/control-plane.ts:107`). In a managed repo that keeps its authoritative DB path in JS config, `invoke --run` from a worktree can still resolve the wrong control-plane and reintroduce split-brain behavior. This remains a product/architecture contract gap: either support JS/MJS bootstrap or explicitly narrow the supported bootstrap contract and documentation. **Action:** `human_required`

### Assessment

- Phase 2 is mostly implemented in the right places, and the focused tests that were added here pass locally (`bun test test/commands/invoke-worktree.test.ts`, `bun test test/commands/init-guard.test.ts`).
- I do not consider the phase ready to advance yet: one shipped envelope bug remains, and the previously-raised bootstrap contract gap still blocks full correctness for managed worktrees.

**Readiness:** Not ready

## Addendum (2026-03-09) - Commit `c484f93` re-review

### What's Addressed

- The new test changes remove the shared temp-root dependency from the three subprocess-heavy `init` scenarios that were most likely to interfere under repeated execution, and the focused `bun test 5x-cli/test/commands/init-guard.test.ts` run passes locally.
- The added per-test temp directories preserve the intended assertions around repo-root scaffolding and managed-checkout behavior without changing product code.

### Remaining Concerns

- **P1.1 - Control-plane bootstrap still ignores JS/MJS `db.path` overrides.** This commit is test-only and does not change the bootstrap contract in `5x-cli/src/commands/control-plane.ts:85`. The resolver still falls back to `.5x` whenever the authoritative root config is `5x.config.js` or `5x.config.mjs`, so a managed repo with a custom JS/MJS `db.path` can still be misdetected from a worktree. That remains a plan-compliance and correctness gap requiring a product/architecture decision: either support JS/MJS `db.path` during bootstrap or explicitly narrow the supported bootstrap contract to TOML-only. **Action:** `human_required`

### Assessment

- This commit improves test isolation, but it does not materially change phase readiness because the unresolved bootstrap contract remains in shipped code.
- Phase 1 still should not be considered complete until the JS/MJS bootstrap behavior is resolved and documented.

**Readiness:** Not ready
