# Review: Plan 210 Phase 1 — Approved execution binding and compatibility

**Review type:** `fb4f8a8c98720a80867c11c60af154d2819cbf50`
**Scope:** Phase 1 (W1): versioned implementation binding/compatibility/text-amendment record kinds, first-admission binding check in record/render/invoke paths, `5x review implementation bind`, drift detection and debt-target phase mapping
**Reviewer:** Staff engineer (correctness, cross-run/worktree identity, operability, test strategy)
**Local verification:** `bun test` in `5x-cli/`: 3624 pass, 0 fail. `bun run typecheck`: clean. `bun run lint`: clean. Focused suites (`implementation-state.test.ts`, `implementation-review-governance.test.ts`): 13 pass. I also probed the helpers against this repository's real run records (see P0.1 and P1.1).

**Implementation plan:** `5x-cli/docs/development/plans/210-implementation-review-governance-plan.md`
**Technical design:** N/A

## Summary

The binding model is well structured and follows plan 209's patterns. It has a self-contained immutable payload with hash self-checks, copied B0/governing B/mode/thresholds/decisions, and idempotent append through RecordStore. Every admission path shares one validator, and approval is judged from terminal route and final-correction evidence rather than Markdown. However, the implementation only works in the unmapped single-checkout layout its tests use. In the standard 5x layout, where the run maps to a worktree (as this run does), canonical plan identity and approved-byte reads fail on every admission path. Separately, the drift rule rejects the plan edits that the workflow itself makes after approval. As written, this plan could not bind its own execution run.

**Readiness:** Not ready — a worktree-mapped execution cannot bind (P0.1), and the post-approval drift policy needs a human decision (P1.1).

---

## What shipped

- **Record kinds** (`review-budget/record-lines.ts`, `control-plane/review-budget-store.ts`): versioned `implementation-binding`, `implementation-compatibility` and `implementation-text-amendment` budget-stream payloads with get/save/list. Plan snapshot readers and `reindexReviewBudget` skip these kinds.
- **Admission core** (`review-governance/implementation-state.ts`): `ensureImplementationAdmission`, source approval assessment (baseline, snapshot, decision fold, open gate, terminal/final-correction route), approved-ledger cross-check, phase map and debt-target mapping, checkbox-insensitive drift check with amendment-chain replay, and `recordVerifiedTextAmendment` for Phase 5.
- **Wiring**: `recordStepInternal` (author steps with numeric phase), `template render` / `invoke` for `author-next-phase` and `author-process-impl-review`, and a new `5x review implementation bind` command.
- **Git**: an `exact` (untrimmed) option for `gitShowFile`/`execGit` so approved bytes hash precisely.

---

## Strengths

- One validator serves automatic selection, explicit selection, and same-run and separate-run sources, as the plan requires. Explicit selection does not relax approval checks.
- Approval evidence is strict. It needs the latest snapshot-coupled reviewer step, a post-decision route re-derived from the stored snapshot, final-correction approval with a recorded author commit, a rejected aborted run or open gate, and a cross-check that the approved bytes' ledger equals the source snapshot ledger.
- The binding is self-contained: it holds plan bytes, ledger and decisions plus their hashes. The test that deletes the source run directory shows execution does not depend on the source worktree.
- The mode-off/no-budget disposition is persisted, not inferred, and an existing binding keeps its source-pinned mode.
- Debt-target mapping rejects unmatched or ambiguous labels, never falls back to numeric sort, and runs before the binding is written.

---

## Production readiness blockers

### P0.1 — Worktree-mapped execution runs cannot bind (plan identity and approved-byte read use the wrong path)

**Risk:** Runs record `plan_path` as the canonical control-plane path, for example `/Users/…/5x-engineer/5x-cli/docs/development/plans/210-….md`. When the plan maps to a worktree, `resolveRunExecutionContext` returns `effectivePlanPath` under the worktree. The new code mixes the two paths:

- `template render`, `invoke` and `review implementation bind` pass `executionContext.effectivePlanPath` as the canonical `planPath`. `approvedCandidates`/`assessApprovedSource` compare it to the source run's canonical `plan_path` using `planPathsIdentifySamePlan`, which is a suffix match. I checked the real paths: `planPathsIdentifySamePlan(mainPath, worktreePath) === false`. Automatic selection therefore always finds zero candidates (`IMPLEMENTATION_APPROVAL_REQUIRED`), and explicit `bind --source-run` always refuses with "is not the canonical plan".
- `enforceFirstImplementationAdmission` in `run-v1.handler.ts` uses `run.plan_path` (the canonical path) as the identity, which is correct. But it reads current bytes from that path, meaning the control-plane checkout rather than the worktree the author edits, and it ignores the `effectivePlanPath` it has already resolved. `showPlanAtCommit(worktree, commit, canonicalAbsPath)` gets a path starting with `../` and falls back to `git show <c>:/abs/path`. I checked this: it returns `null` for this run, so binding fails with `IMPLEMENTATION_APPROVED_PLAN_UNAVAILABLE`. With no control plane, `workdir` is undefined and the same error follows.

As a result, in the standard worktree workflow (including run `run_bf10663c0a8a` itself) every budgeted non-off first admission fails closed, and no admission path can create a binding. The tests pass only because every fixture is an unmapped single-checkout repo.

**Requirement:** Use the run's canonical `plan_path` (`executionContext.run.plan_path`) as plan identity on every path. Read current plan bytes from `effectivePlanPath`. Read approved bytes with a repo-relative path computed against `controlPlaneRoot` (the canonical path), not against the worktree. Remove the `../` absolute-path fallback in `showPlanAtCommit`. Add an integration test in which the plan maps to a worktree (`5x worktree` or a `plans.worktree_path` mapping). It should cover automatic bind via record, bind via render/invoke, and explicit `review implementation bind`. It should also check that drift is evaluated against the worktree copy.

**Implementation guidance:** `relativePathUnder(planPath, controlPlaneRoot)` in `run-context.ts` already derives the repo-relative path. `phase.handler.ts:335` and `protocol.handler.ts:217` show the existing "canonical identity, effective read" pattern.

---

## High priority (P1)

### P1.1 — Drift policy rejects the workflow's own post-approval plan edits; this plan cannot bind

`terminalRoute` takes the approved commit from the completed reviewer step's `head_commit`. For source run `run_3fb9ee9c10c6` that is `2c23519`. Two later edits change the plan without touching a checkbox:

1. `22a8dee`, the workflow's "mark plan reviewed" commit, which rewrites the `**Status:**` header. Plan 209 has the same step (`d3c3f24`).
2. `abaa379`, the Phase 0 verification paragraph. Phase 0 explicitly requires this: "Record any integration drift in this plan".

Running `detectPlanDrift` on this repository's approved bytes against HEAD returns `drifted: true`. Even after P0.1 is fixed, this execution run, and any run whose plan went through the normal "mark reviewed" step, gets `IMPLEMENTATION_PLAN_DRIFT`. This also happens in advisory mode, because binding is required whenever mode ≠ off. Authors who add notes to the plan will likewise block their own later `author:*` recordings.

The plan says "ignore checkbox-state changes" and sends other edits to an amendment workflow that does not exist yet. So the implementation follows the letter of the plan, but the plan conflicts with its own Phase 0 instruction and with the established status-header convention. This needs a decision. Options include:

- (a) Anchor approval to the source run's sealed `final_head_commit` or `run:complete` commit, and treat later edits as drift.
- (b) Also normalize the `**Status:**` metadata line, or other workflow-owned spans.
- (c) Have Phase 0 and verification notes go in run records instead of the plan.
- (d) Provide an interim human-approved amendment path.

Tests should then cover the real "mark reviewed" and "Phase 0 note" sequence.

---

## Medium priority (P2)

- **Checkbox normalization is not anchored**: `normalizeCheckboxState` rewrites every `[x]`, `[X]` or `[ ]` in the document, so edits like `arr[x]` ↔ `arr[ ]` in code blocks or prose are ignored as drift. Anchor it to Markdown task-list markers, for example `/^(\s*[-*+]\s+)\[[ xX]\]/gm`, and add a unit case.
- **Render/invoke admission paths are untested**: the gating added to `template.handler.ts` and `invoke.handler.ts` has no tests. That includes the `RecordContextError` fallback that emits `IMPLEMENTATION_APPROVAL_REQUIRED` for SQLite-only budgeted runs, and the `isImplementationAuthorTemplate` selection with its `-continued` suffix handling. Only the record path and the `bind` command are exercised. Add render and invoke cases that mirror the existing `plan-review-governance` render/invoke parity tests.
- **Rebuild coverage is claimed but not shown**: the checklist says "source worktree removal/rebuild". The integration test deletes the source run directory but never runs an index rebuild, and `records/index-rebuild.ts` (listed under the phase's Files) is unchanged. Bindings are read straight from the stream, so behavior is probably correct. Either add a `records rebuild` step to the test or reword the checklist item.

---

## Readiness checklist

**P0 blockers**
- [ ] Canonical plan identity and approved-byte reads work for worktree-mapped runs across record, render, invoke and explicit bind, with an integration test

**P1 recommended**
- [ ] Human decision on authorized post-approval plan edits (status header, Phase 0 notes); implement and test the chosen policy

**P2**
- [ ] Anchor checkbox normalization to task-list markers
- [ ] Tests for render/invoke admission gating
- [ ] Rebuild step in the separate-run integration test, or corrected checklist wording

---

## Addendum (2026-09-23) — Worktree identity, drift-anchor decision, and mechanical fixes

**Reviewed:** `745e38a8efa3dd231337c5a164758f50d393e278` (two commits: `0c54274` addresses this review; `745e38a` fixes a fallback gap and two concurrency races found while finishing the fix)

**Local verification:** `bun test` in `5x-cli/`: 3634 pass, 0 fail (up from 3624 — 10 new tests). `bun run typecheck`: clean. `bun run lint`: clean. I re-derived the P0.1 repro (canonical vs. worktree plan path) against the fixed code and confirmed `planRepoPath` now resolves the worktree case; I also read the recorded human-gate decision (`docs/development/runs/210-implementation-review-governance-plan/run_bf10663c0a8a/decisions.jsonl`) that authorized the R2 policy choice below.

### What's addressed (✅)

- **R1 (P0 — worktree identity/byte reads) — addressed.** Every admission path now passes the run's canonical `plan_path` for identity (`invoke.handler.ts`, `template.handler.ts`, `review-decision.handler.ts`, `run-v1.handler.ts`), not the worktree-resolved `effectivePlanPath`. Current bytes are read from the worktree copy when the mapping actually contains one; approved bytes are read via a new `planRepoPath(planPath, controlPlaneRoot)` helper that relativizes against the control-plane root and rejects paths that escape it, replacing the old `git show <c>:/abs/path` fallback that silently returned `null`. `showPlanAtCommit` takes an explicit `repoRoot` option. New integration test `binds a worktree-mapped plan from canonical identity and worktree bytes` exercises record, `template render`, `invoke`, and explicit `review implementation bind` against a real `5x worktree create` mapping, including a drift case where only the worktree copy changes. `enforceFirstImplementationAdmission` also now surfaces `resolveRunExecutionContext` failures (e.g. `WORKTREE_MISSING`) instead of silently proceeding without a workdir.
- **R2 (P1 — drift on workflow-owned post-approval edits) — addressed via recorded human decision.** The human gate on this run (`step:run_bf10663c0a8a:human:gate:1:1`) chose option (a)+(c) from my prior review: anchor approved plan bytes to the source run's sealed `final_head_commit`/`run:complete` commit (which includes the "mark reviewed" Status edit), and move Phase 0 verification prose out of the plan into a run record (`docs/development/runs/.../run_bf10663c0a8a/phase-0-verification.md`). `assessApprovedSource` now calls `resolveFinalizedPlanCommit`, which requires `summary.status === "completed"`, a `final_head_commit`, and a matching recorded `run:complete` step commit before treating any commit as approved — an arbitrary later HEAD is explicitly rejected ("Later HEAD is not approval"). The plan's own `**Status:** Reviewed` line and the Phase 0 note are no longer drift for this run; a genuinely new edit after the sealed commit still is. Covered by both a unit test (`anchors approved bytes to the finalized plan commit, not a later HEAD`, including the mismatched-`final_head_commit` refusal case) and an integration test (`keeps the status update inside the finalized plan commit and drifts later notes`).
- **R3 (P2 — checkbox regex too broad) — addressed.** `normalizeCheckboxState` now matches only list-item checkboxes (`/^(\s*[-*+]\s+)\[[ xX]\]/gm`), so `arr[x]` in prose/code is no longer ignored as a checkbox toggle. New unit test covers both the intended no-drift case and the `arr[x]`→`arr[ ]` should-still-drift case.
- **R4 (P2 — untested render/invoke gating) — addressed.** New unit tests cover the SQLite-only budgeted case (`RecordContextError` → `IMPLEMENTATION_APPROVAL_REQUIRED`, provider never constructed) for both `invokeAgent` and `templateRender`, plus mode-off passing through without approval for `templateRender`.
- **R5 (P2 — rebuild not exercised) — addressed.** The source-removal test now runs `5x records index` after deleting the source run directory and before the retry, actually exercising the rebuild path the checklist claimed.

### Remaining concerns

- **New, untested race-handling branch in `submitPlanReviewDecision`** (`review-decision.handler.ts`): `745e38a` adds a second `readDecision()` call after `deriveOpenGate` returns no match, so a same-intent decision loser observes the winner that committed between the two reads instead of failing with `REVIEW_GATE_NOT_OPEN`. The lock-race half of the same commit has a dedicated unit test (`lock prepare fsync ENOENT retries after the temp is unlinked`), but this decision-race branch does not. The logic mirrors the pre-existing `alreadyResolved` path via the new `acceptStoredWinner` closure, so risk is low, but it's new behavior on a shared decision-acceptance seam and deserves a concurrent-writer regression test (two `submitPlanReviewDecision` calls racing against the same gate, one committing between the other's open-gate check and re-read). This is outside Phase 1's stated scope (it touches plan-review decision submission, not implementation binding) but shipped in this revision, so I'm flagging it rather than treating it as pre-existing.
- Nothing from the original P0/P1/P2 list is still open.

### Updated readiness

- **Phase 1 completion:** ✅ — the binding model works for both single-checkout and worktree-mapped runs, the drift anchor is a deliberate, recorded human decision rather than an inferred one, and all previously identified mechanical gaps have tests.
- **Ready for next phase:** ✅ — no blockers remain. The one new item (untested decision-race branch) is a P2 test-coverage gap on adjacent code, not a Phase 1 defect.
