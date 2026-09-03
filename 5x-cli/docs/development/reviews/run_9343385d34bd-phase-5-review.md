# Review: Git-native run records — Phase 5

**Reviewed commits:** `887b0ad5e77dbdf5b66005fde1f8c45a7e10d964` through `06f98116fcf317dcf1a99c33369ef9de585e4714`  
**Scope:** Progress resolution, ref ranking/pruning, fetch/all-refs, source metadata, branch-only plans, and `run state --plan`.

## Summary

The batched resolver, last-touch comparison, ancestor pruning, divergence reporting, remote fetch isolation, branch-only discovery, record-backed state fallback, and quality follow-up are well covered. The phase is not ready because the required `plans.branch` candidate is not configurable or wired into any handler, so that ordering path can never be exercised in production.

## Verification

- `bun test --concurrent` — 3189 pass, 0 fail.
- Focused Phase 5 tests — 57 pass, 0 fail.
- `bun run typecheck` and `bun run lint` pass.

## Blocking item

### P1 — `plans.branch` is never passed to resolution and is absent from configuration

**Location:** `src/commands/plan-v1.handler.ts:240-247,397-405,435-443`; `src/commands/run-v1.handler.ts:1612-1619`; `src/config.ts:69+`.

Phase 5 requires candidates in this order: mapped worktree, local `5x/<slug>`, remote `5x/<slug>`, `plans.branch`, then `HEAD`. `resolvePlanProgress` supports `plansBranch`, but all callers omit it. Moreover, `FiveXConfig` has no `plans.branch` setting, so no configured plans branch can be resolved by `plan list`, `plan phases`, or `run state --plan`. This violates the required candidate ordering and leaves plans maintained on the configured plans branch invisible unless they are also reachable by another candidate.

**Required fix (auto_fix):** Add/preserve the configured plans-branch value in the configuration model, pass it into `prepareProgressSession` and every `resolvePlanProgress` call, and add a real-git regression covering a plan that exists only on that branch (including source metadata).

## Readiness

Not ready pending P1. No other blocking correctness, security, performance, or operability findings in the reviewed commits.

## Addendum — plans.branch follow-up (2026-09-03)

**Reviewed:** `2f1ad3dee0438cb476446b8dda0d4fdc55e34e41`

### P1 resolved

`plans.branch` is now a validated, documented, registry-visible configuration option. `plan list`, `plan phases`, and `run state --plan` pass it into the shared progress session/resolver, preserving the required placement after conventional local/remote `5x/<slug>` candidates and before `HEAD`.

The added real-Git fixture demonstrates a plan and record available only on the configured branch through all three commands, including source metadata and record-backed `run state`. Unit coverage verifies schema defaults, unknown-key behavior, registry exposure, and resolver selection.

### Verification

- Focused config/resolver/progress suites: 90 pass, 0 fail.
- `bun run typecheck`, `bun run lint`, and `git diff --check` pass.

### Updated readiness

Ready for the next phase. No regressions or remaining Phase 5 blockers found.
