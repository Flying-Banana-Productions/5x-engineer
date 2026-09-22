# Review: Plan 209 Phase 3 — Closure protocol and plan-diff evidence validation

**Review type:** `ea40ac0287d0a326c186168fc36dd42d1d9507d2`
**Scope:** Reviewer contract extensions (`src/protocol.ts`), `protocol emit reviewer --prior-finding`, new `src/review-governance/plan-diff.ts`, the shared diff builder in `template-vars.ts`, `validateIntroducedBy` wired into `closure.ts`, closure validation in `protocol validate reviewer --phase plan`, public exports, and the new unit/integration tests.
**Reviewer:** Staff engineer (correctness, git/path handling, protocol contract, plan compliance)
**Local verification:** `bun test test/unit/review-governance test/integration/plan-diff.test.ts test/integration/commands/protocol-validate.test.ts test/unit/commands/protocol-emit.test.ts test/integration/commands/review-budget.test.ts` — 73 pass, 0 fail. `bunx tsc --noEmit` — clean. `bunx biome check src test` — clean. I also ran an ad-hoc probe of `buildPlanReviewDiffContext` on this repository; the results are under P1.1.

**Implementation plan:** `docs/development/plans/209-plan-review-governance-plan.md` (Phase 3)
**Technical design:** N/A

## Summary

Phase 3 extends the reviewer contract with the closure item fields and a top-level `priorFindings[]` array, and adds the new aggregate/route keys to the CLI-owned rejection list. It also adds a plan-only diff builder and exact-hunk validator that prompt rendering and closure validation share, and wires `validateClosureReview` into `protocol validate` for plan reviewer steps, where it runs before any write. The design matches the plan and the unit coverage is good. However, the diff builder is broken whenever the effective working directory is a subdirectory of the git top-level, and that includes this monorepo (`5x-cli/`). In that case the plan patch comes back empty. Reviewers are then told the plan is unchanged, and in enforced mode every `introducedBy` citation fails with `INTRODUCED_HUNK_NOT_FOUND`. The fix is mechanical.

**Readiness:** Ready with corrections. One P1 `auto_fix` path bug and several P2 hardening and plan-accuracy items remain. None needs a human decision.

---

## What shipped

- **Contract**: `VerdictItem` gains `failure`, `lowestCostCorrection`, `introducedBy`, `lateDiscovery`, `lateDiscoveryEvidence`, `priorDecisionId`, `newEvidence` and `requiresReviewerVerification`. `ReviewerVerdict` gains `priorFindings`. The JSON schema and `assertReviewerVerdict` validate the structured fields. The following keys are now rejected as CLI-owned: `reviewRoute`, `normalizedReadiness`, `gateCauses`, `budgetTotals`, `budgetStatus`, `decisionOutcomes`, `findingOutcomes` and `governance`.
- **Emit**: `--prior-finding <json>` is repeatable and does not imply corrections. `--ready` with only `addressed` outcomes emits `ready` with an empty `items[]`.
- **Plan diff** (`plan-diff.ts`): `buildPlanReviewDiffContext` resolves both endpoints and detects renames through `--name-status -M`. It builds the plan-only patch with renamed pathspecs, rejects binary patches, and parses hunks with transport-normalized SHA-256 hashes. It also computes `equivalentPlanCommits`, which is how review-artifact-only HEAD advances are accepted. `validateIntroducedBy` enforces the range start and end, resolves abbreviated SHAs uniquely within the context, matches the exact hunk, and reports the closest header by edit distance. `formatPlanReviewDiffContext` renders the range, a 200-line truncation, the omitted headers and a retrieval command.
- **Protocol integration**: `protocol validate` derives prior plan reviewer steps from the `steps` stream and chooses `initial` or `closure` from them. For closure reviews it rebuilds the diff context from the prior step's `head_commit`, folds persisted findings, loads decisions, and runs `validateClosureReview` before admission or budget writes. Enforced mode fails with one envelope that carries every diagnostic. Advisory mode attaches `governance: { reviewKind, diagnostics }` to the verdict.

---

## Strengths

- **Validation runs before any write.** The closure check sits ahead of baseline admission and `applyPlanReviewBudget`, so an enforced failure leaves the run untouched. This is what the plan requires.
- **Exact-hunk matching is strict in the right places.** Only line endings and trailing whitespace are normalized. The cited text must equal one parsed hunk, so snippets stitched together from several hunks cannot match.
- **Review-artifact-only HEAD advances are handled by equivalence, not by a special case.** Any commit whose plan-only patch is byte-identical to the current one is accepted as a range end. This covers the "HEAD changed only because of the review document" completion gate without trusting commit messages.
- **Abbreviated SHAs resolve only against the context's own commits.** Ambiguity is detected and rejected, not guessed. There is a unit test for this.
- **The prompt renderer and the validator share one builder.** Markdown formatting and truncation live only in `formatPlanReviewDiffContext`, as the plan asks.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — Plan diff is empty when the working directory is below the git top-level

`planPathspecs` computes `displayPath` relative to `git rev-parse --show-toplevel`, and `--name-status` also returns top-level-relative paths. Every `git diff … -- <pathspecs>` call, however, runs with `cwd = workdir`, and git interprets pathspecs relative to the cwd. When `effectiveWorkingDirectory` is a subdirectory, the pathspec becomes `5x-cli/5x-cli/docs/...`, which matches nothing, so the patch is empty.

Reproduced on this repository: `buildPlanReviewDiffContext({ workdir: <worktree>/5x-cli, planPath: <abs plan>, previousReviewCommit: 2b11d9a, currentCommit: ea40ac0 })` returns 0 hunks and an empty patch. The same call with `workdir` set to the top-level returns 2 hunks (6143 bytes). Consequences:

- The closure prompt renders "(plan file unchanged…)" for real plan revisions.
- Every `introducedBy` in enforced mode fails with `INTRODUCED_HUNK_NOT_FOUND`, and the closest header is empty. Correct closure reviews therefore fail closed.
- The rendered retrieval command `git diff <range> -- 5x-cli/docs/...` also fails when run from `5x-cli/`.

**Requirement:** Run the diff and `--name-status` calls from the top-level (`execGit(args, root)`), or use `:(top)` pathspec magic. The retrieval command must also work from the reviewer's cwd, for example `git -C <root> diff …` or a `:(top)`-prefixed path. Add an integration test in which the plan lives in a subdirectory and `workdir` is that subdirectory.

---

## Medium priority (P2)

- **P2.1 — Diff-context build failures are swallowed.** `protocol.handler.ts` catches every error from `buildPlanReviewDiffContext` and records only `PLAN_DIFF_CONTEXT_MISSING`. `template-vars.ts` now returns `diffAppend: null`, where it previously rendered a placeholder section. `PLAN_DIFF_BINARY_UNSUPPORTED` and `PLAN_DIFF_GIT_ERROR` never reach the reviewer or the diagnostics. Include the `PlanDiffError` code and message in the missing-context diagnostic, and keep a short diff section in the prompt that explains why no diff is shown.
- **P2.2 — Mode is read from live config, not pinned.** Checklist item 3.3 says "load the pinned baseline mode", but the handler uses `budgetContext.config.reviewBudget.mode`, and the baseline payload strips `mode`. If the config is edited mid-run from advisory to enforced, validation of an in-flight run changes from diagnostics to rejection. Pinning is scheduled in W6 (Phase 6). Annotate the Phase 3 checkbox and leave a TODO that points at Phase 6 so the plan does not overclaim.
- **P2.3 — A hunk that straddles the truncation boundary is not listed as omitted.** `formatPlanReviewDiffContext` lists a header only when the header's own line index is 200 or more. A hunk that starts before line 200 and ends after it is only partly shown, and nothing in the output points to it. List any hunk whose body extends past `maxLines`, and add a unit case for it.
- **P2.4 — Unbounded per-commit diffs for `equivalentPlanCommits`.** The builder runs one `git diff` for every commit in `previous..current`, including when it only renders a prompt, where the list is not used. In an active monorepo this can mean hundreds of subprocesses per review. Walk back only as far as the last commit that touches the plan pathspecs (`git rev-list -1 <range> -- <pathspecs>`), and check equivalence only from that commit onward.
- **P2.5 — Emit copies closure string fields without type checks.** `protocolEmitReviewer` casts `failure`, `lowestCostCorrection`, `lateDiscoveryEvidence`, `priorDecisionId` and `newEvidence` with `as string`, and `assertReviewerVerdict` does not type-check them. As a result, `{"failure": 3}` passes structural validation. Add `typeof === "string"` checks next to the existing `introducedBy`/`lateDiscovery` checks.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 — Run plan-diff git commands (and the retrieval command) against the top-level; add a subdirectory-workdir test.

**P2**
- [ ] P2.1 — Surface `PlanDiffError` codes in diagnostics and the prompt.
- [ ] P2.2 — Annotate the pinned-mode checkbox as deferred to Phase 6.
- [ ] P2.3 — List partially truncated hunks as omitted.
- [ ] P2.4 — Bound the equivalent-commit scan.
- [ ] P2.5 — Type-check the closure string fields in `assertReviewerVerdict`.

**Phase readiness:** Phase 4 (the pure router) does not depend on the diff builder, so it can start in parallel. P1.1 must be fixed before enforced mode is used in any repository where the plan workdir sits below the git root.
