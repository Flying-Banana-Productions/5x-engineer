# Review: Phase 1 — `5x plan list` handler and registration

**Review type:** `4281ef420574b466e1090db7529a8dade7f53954` (and branch tip; no further `plan-v1` source changes after this commit)  
**Scope:** Phase 1 only per `5x-cli/docs/development/030-plan-list-command.plan.md` — `planList` / `formatPlanListText` / Commander `list` subcommand  
**Reviewer:** Staff engineer  
**Local verification:** `bun run src/bin.ts plan list`, `bun run src/bin.ts --text plan list`, `bun run src/bin.ts plan list --exclude-finished` (exit 0, plausible JSON/text); `bun test test/unit/commands/` (pass)

## Summary

Commit `4281ef4` delivers the Phase 1 implementation described in the plan: recursive `.md` discovery under `config.paths.plans`, batch loading of plan rows and runs, canonical `plan_path` keys aligned with DB storage, worktree-preferred read paths consistent with `plan phases`, per-file parse failure fallback, `--exclude-finished` filtering, unfinished-first sorting with alphabetical tie-break, JSON envelope shape matching the plan, and a ColDef/`padEnd` text table including the empty state `(no plans)`.

No production blockers were found in the Phase 1 code path. Follow-on commits on the branch do not modify `plan-v1.handler.ts` or `plan-v1.ts` after `4281ef4`. Automated handler and integration tests remain explicitly scoped to Phases 2 and 3 of the plan.

**Readiness:** Ready with corrections — implementation matches Phase 1 spec; one product-scope question should be resolved before treating the feature as “done” for users (see P1.1).

## Strengths

- Clear separation: Commander adapter stays thin; business logic lives in `planList` with reusable `formatPlanListText`.
- DB usage matches existing conventions: `canonicalizePlanPath` for keys matches `upsertPlan` / run rows; avoids N+1 with bulk `listRuns` and a single `SELECT * FROM plans`.
- Worktree behavior reuses the same re-root rule as `effectivePlanReadPath` / `plan phases`, so checklist state can come from the mapped worktree when present.
- Sorting and filtering behavior match the written plan; text output follows the same table pattern as other inspection commands.

## Production Readiness Blockers

None for Phase 1 scope.

## High Priority (P1)

### P1.1 — Ambiguous listing scope for “plan” markdown

**Risk:** Users may see noisy or misleading rows (for example `README.md`, review templates, or prompt files) summarized as plans with `0/0` phases and `incomplete` status, if those files live under `paths.plans`.

**Requirement:** Decide and document whether `plan list` should include every `.md` under the tree, only files matching a naming pattern (e.g. `*.plan.md`), or another rule; then align implementation and docs in a later phase if the decision differs from “all `.md`”.

## Medium Priority (P2)

- **0-phase documents:** Rows with `phases_total === 0` show `0/0` and `0%`, which is logically consistent but may read oddly in the table; consider a clearer display once product scope (P1.1) is fixed.
- **Phase 2–4 follow-through:** Direct-call tests, integration tests, and documentation/harness updates remain open per the plan; schedule as planned work rather than skipping.

## Readiness Checklist

**P0 blockers**

- [x] None identified

**P1 recommended**

- [ ] Resolve listing scope for markdown under `paths.plans` (human decision)

## Addendum (2026-03-31) — Initial review

### What's Addressed

- Phase 1 checklist items in the plan (handler, formatter, registration, CLI smoke behavior) are satisfied by `4281ef4`.

### Remaining Concerns

- Phases 2–4 of the plan (tests, README, primitives doc, orchestrator harness text) are out of scope for this review but should still be executed before calling the overall feature complete.
