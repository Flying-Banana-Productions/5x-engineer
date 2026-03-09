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
