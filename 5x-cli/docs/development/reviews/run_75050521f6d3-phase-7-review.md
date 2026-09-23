# Review: Plan 209 Phase 7 — Reviewer templates and workflow skills

**Review type:** `8c95e65062c518c6a78aa8b13634d0314398f99a`
**Scope:** Phase 7 of plan 209: initial reviewer prompt (7.1), closure prompt (7.2), author correction prompt (7.3), and the `5x-plan-review` / `5x-plan` workflow skills (7.4)
**Reviewer:** Staff engineer (prompt/CLI contract correctness, plan compliance, compatibility, test strategy)
**Local verification:** `bun run typecheck` passes. `bun run lint` passes. `bun test` → 3585 pass / 0 fail (229 files).

**Implementation plan:** `docs/development/plans/209-plan-review-governance-plan.md`
**Technical design:** N/A

## Summary

Phase 7 rewrites the plan-review prompts and skills around the CLI-derived governance route. The skill now routes enforced runs only from `.data.result.governance.route`. It covers every route: `complete`, `author_revision`, `final_corrections` (one author pass, no reviewer re-entry), `human_gate`, and post-decision `aborted`. It handles enforced gates only through `5x review gate show` / `5x review decide`, and it keeps v1 routing for advisory, off, and `v1_compat` runs. I checked the flags and output fields the skill references (`--gate`, `--choice`, `--rationale`, `--evidence`, `--finding`, `--retain`, `--remove`, `--baseline`, `--approved-p`, `--approved-item`, `--approved-work-item`, `--input-json -`, `.data.route`, `requiredFieldsByChoice`, `review_budget.enforcement_implemented`, `--prior-finding`). All of them match the real CLI.

There are two contract gaps between the prompts and the CLI:

1. **Closure prompt vs. closure validator.** The prompt asks the reviewer to emit an outcome for every "required" prior finding, but it never says which findings are required. The appended context lists every persisted finding, including ones already `[addressed]` and ones covered by an active deferral. The validator in `closure.ts` rejects outcomes for those findings with a `PRIOR_FINDING_UNKNOWN` error. In enforced mode that fails closed.
2. **No fallback text for runs without a baseline.** The static prompt text now describes closure-only, enforced-style behavior. It has no concrete instructions for runs where no governance context is appended.

The 7.3 test obligation for native and invoke render paths is also only met at the helper level.

**Readiness:** Ready with corrections. All fixes can be derived from existing code. No design decisions are needed.

---

## What shipped

- **Initial prompt (`reviewer-plan.md` v6)**: requires one exhaustive pass and forbids deliberately deferring findings. Every item needs `failure` and `lowestCostCorrection`. Adds a debt-coupling and minimal-compliant assessment and a **Nonblocking follow-ups** section excluded from `items[]`. Adds a strict final-correction meaning for `ready_with_corrections`. Reviewers may not author CLI-owned fields (now including `governance`, `reviewRoute`, `normalizedReadiness`, `gateCauses`). Adds enforced vs. advisory wording.
- **Closure prompt (`reviewer-plan-continued.md` v6)**: records `priorFindings[]` outcomes first. Partial and open findings are repeated under the same ID. A new blocker needs `introducedBy` with a single complete hunk and handling for truncated patches. The critical-safety late exception needs `lateDiscovery` evidence. Re-raising a deferred item needs `priorDecisionId` plus `newEvidence`. Nonblocking follow-ups stay out of `items[]`. Adds `--prior-finding` to the emit instructions.
- **Author prompt (`author-process-plan-review.md` v5)**: tells the author the appended **Governing decisions** block is authoritative, to update `Addresses` only for findings actually incorporated, and not to reintroduce deferred findings or removed scope.
- **Skills**: `5x-plan-review` adds Step 2 (route from the recorded result), Step 3 (final-corrections mode), and Step 4A (typed enforced gate), and relabels the legacy v1 escalation step. `5x-plan` points to those branches.
- **Tests**: a new `plan-review-governance.test.ts` renders the skill for native, invoke, and mixed contexts. There are new loader assertions for both reviewer templates, formatter-level tests in `context.test.ts`, and an installed-skill content check in `harness.test.ts`.

---

## Strengths

- The routing authority is clear and strict. Enforced runs never fall back to readiness or prose, and a missing route is an invariant failure that must be escalated rather than silently defaulted.
- The skill takes required decision fields from `requiredFieldsByChoice` returned by `gate show` instead of keeping its own copy of the choice matrix, as the plan requires.
- Final corrections are one bounded pass. It does not consume a closure iteration and does not re-enter the reviewer.
- Advisory, off, and `v1_compat` routing is spelled out, including "ignore advisory hypothetical routes".
- Every CLI surface the skill names exists with matching flags and output fields, so there is no drift between the skill and the CLI.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — The closure prompt never shows which prior findings are required, so enforced closure reviews can fail closed

`validateClosureReview` (`src/review-governance/closure.ts:397-430`) treats a prior finding as required only if it is not `addressed` and is not covered by an active deferral or accepted-risk decision. An outcome for any other ID is a `PRIOR_FINDING_UNKNOWN` error. In enforced mode, `accepted = !hasErrors` (`closure.ts:591`), and `applyPlanReviewGovernance` returns an error.

The prompt only says "emit exactly one top-level `priorFindings[]` outcome for every **required** prior finding". Meanwhile `formatReviewerGovernanceContext` (`src/review-governance/context.ts:75-94`) lists every persisted finding under `### Prior findings`, including ones marked `[addressed]` and ones that also appear under `### Deferred or accepted-risk findings`.

**Failure case:** in round 3, a reviewer reasonably re-reports P1.1 as `addressed` (it was addressed in round 2), or reports status for a deferred P1.7. The recorded validation is rejected with `PRIOR_FINDING_UNKNOWN`. The reviewer retries with the same prompt and the loop stalls.

**Correction:** render a separate list of required outcome IDs. Compute it with the same predicate `closure.ts` uses, ideally by exporting it rather than duplicating it. Change the closure prompt to require outcomes for exactly that list and to forbid outcomes for addressed or deferred findings. Add a test that feeds a rendered context through `validateClosureReview`.

### P1.2 — Phase 7.3 render tests only exercise the formatter, not the native or invoke render paths

The plan requires "render tests for fresh/continued native and invoke paths". The new tests in `test/unit/review-governance/context.test.ts:168-231` call `appendPlanReviewPromptContext` twice with literal strings. No test drives `template.handler.ts` (lines 308-339) or `invoke.handler.ts` (lines 530-550) and checks that the governance block appears in a real `reviewer-plan`, `reviewer-plan-continued`, or `author-process-plan-review` render. No test checks that the author render gets **Governing decisions** rather than the reviewer block (the `-continued` suffix-strip branch). No test checks that the invoke and native renders match byte-for-byte. A regression that drops the append would pass every test.

**Correction:** add handler-level tests modeled on the existing `test/unit/commands/invoke.test.ts` and the template-render tests. Seed a baseline, a snapshot, and a deferral decision. Assert the reviewer block in both reviewer templates, the author block in `author-process-plan-review`, and equal appended text on the invoke and render paths.

---

## Medium priority (P2)

- **P2.1 — No v1 fallback text for continued reviews without a governance context.** The CLI has no template conditionals, so `reviewer-plan-continued.md` now tells every run to put ordinary missed issues in nonblocking follow-ups, to use `introducedBy` for new blockers, and to emit `--prior-finding`. It then says "Mode off and `v1_compat` retain the v1 contract" without saying what that contract is. It also says "The appended context states the pinned mode" when no such context is appended for runs without a baseline. For mode off, `v1_compat`, and plans with no Delivery Budget, this can quietly stop the reviewer from raising issues in `items[]`, which goes against "Preserve advisory/off behavior and mid-review v1 compatibility". **Correction:** add an explicit rule: when no `Plan-review governance context` block is appended, re-review broadly, surface new issues in `items[]`, and omit `--prior-finding`/`introducedBy`. The closure-only rules then apply only when the block is present. Alternatively, always append a minimal mode block (`off`/`v1_compat`). Add a loader assertion.
- **P2.2 — `ready_with_corrections` in the initial prompt applies enforced wording to every mode.** The text "combined remaining effort is at most one point … This route skips another review" is unconditional. In advisory, off, and v1 runs, `ready_with_corrections` still goes through the author and then back to review, and items in runs without a budget have no `effortDelta`. **Correction:** scope that sentence to pinned `enforced` runs, and keep the v1 definition for everything else.
- **P2.3 — Recovery after a decision.** Step 4A says to recover from `5x review gate show` on restart. Once a decision is recorded, `gate show` returns `{ "open": false }` and does not return the route. The skill should say how to get the route back in that case, for example by re-submitting the identical decision, which is idempotent and returns `.data.route`, or by reading run state. It should also show where the gate ID comes from (`.data.gateId` from `gate show`).

---

## Nonblocking follow-ups

- The author prompt does not tell the author when it is running a `final_corrections` pass. A short note in the rendered prompt would help keep that pass mechanical.
- Explain how `requiredFieldsByChoice` keys map to flags (`findingRefs` → `--finding`, `retained` → `--retain`, `approvedItemIds` → `--approved-item`) so the orchestrating agent does not have to guess.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Render the required prior-finding IDs in the closure context and limit outcomes to that set
- [ ] P1.2 Add handler-level render tests for native and invoke paths, reviewer and author blocks

**P2**
- [ ] P2.1 Explicit v1 fallback in the continued prompt when no governance context is appended
- [ ] P2.2 Scope the strict `ready_with_corrections` definition to enforced runs
- [ ] P2.3 Recovery guidance after a recorded decision; show where the gate ID comes from

**Phase readiness:** Phase 7's structure and routing are complete, and the CLI contracts match. Correct P1.1 before running Phase 9's multi-round enforced end-to-end fixtures, because those fixtures would hit the prior-finding rejection.

---

## Addendum (2026-09-22) — Fix-round follow-up

**Reviewed:** `c702c135aa5e9cd67e85c7e5d3482c67499b17c6` (previous review commit: `8c95e65062c518c6a78aa8b13634d0314398f99a`)

**Local verification:** `bun run typecheck` clean. `bun run lint` clean. `bun test` → 3589 pass / 0 fail on a clean run (229 files); one unrelated cross-process race test (`review decision CLI > two independent processes converge on one gate decision and human step`) flaked once under `--concurrent` and passed on immediate rerun and in isolation — not a regression from this diff.

### What changed

- **`src/review-governance/closure.ts`**: extracted the required-outcome predicate into an exported `requiredClosureOutcomeFindings(...)`, reused by both `validateClosureReview` and the new context builder, so there is exactly one definition of "which prior findings must get an outcome."
- **`src/review-governance/context.ts`**: `PlanReviewPromptContext` gains `requiredOutcomeIds`, computed via `requiredClosureOutcomeFindings`. `formatReviewerGovernanceContext` now renders a `Required prior-finding outcome IDs: ...` line.
- **`src/templates/reviewer-plan-continued.md` (v7)**: the closure prompt now branches explicitly on whether the `## Plan-review governance context` block is present. When present, it restricts `priorFindings[]` outcomes to exactly the rendered required-ID list. When absent (mode off, `v1_compat`, or no active Delivery Budget), it defines a broad v1 fallback: re-review broadly, put new/prior issues in `items[]`, and omit `priorFindings[]`/`--prior-finding`/`introducedBy`.
- **`src/templates/reviewer-plan.md` (v7)**: the `ready_with_corrections` definition is now split — the strict one-point/zero-architecture-delta shortcut applies only in pinned `enforced` mode; advisory/off/`v1_compat` keep the ordinary v1 author/re-review cycle.
- **`src/skills/base/5x-plan-review/SKILL.tmpl.md`**: Step 4A now says explicitly to set `$GATE_ID` from `.data.gateId`, and gives a concrete idempotent-retry recovery procedure for the case where a decision was durably recorded but its route wasn't captured (re-submit the identical `5x review decide` payload; the CLI's already-resolved path returns the winning decision's route on a matching retry).
- **`src/commands/invoke.handler.ts` / `template.handler.ts`**: added an `onRenderedPrompt` test hook (production behavior unchanged) enabling direct assertions on the fully-rendered prompt string.
- **Tests**: new handler-level tests (`template-handler.test.ts`, `invoke.test.ts`) seed a real baseline/snapshot/deferral-decision fixture and assert the reviewer governance block appears in `reviewer-plan`/`reviewer-plan-continued` renders, the `## Governing decisions` block appears in the author render (and the reviewer block does not), and native (`templateRender`) and invoke (`invokeAgent`) renders produce byte-identical governance context blocks. A new `context.test.ts` test renders the required-IDs line and feeds it straight through `validateClosureReview`, proving the rendered set is exactly what the validator accepts (not just a superficial string match). Loader and skill tests were extended to match.

### Prior findings — addressed / partially addressed / still open

- **P1.1** (closure prompt didn't say which prior findings were required, enforced closure reviews could fail closed) — **addressed**. The fix closes the loop precisely: the same predicate now backs both the validator's `requiredFindings` and the rendered `Required prior-finding outcome IDs` line, and a new test (`context.test.ts`) proves a verdict built from exactly the rendered IDs is accepted by `validateClosureReview`. This is the strongest form of fix — it eliminates the possibility of the two computations drifting again, rather than just documenting the current required set.
- **P1.2** (native/invoke render tests only exercised the formatter helper) — **addressed**. The new tests drive real `templateRender`/`invokeAgent` calls against a seeded governance fixture (baseline + snapshot with an open and a deferred finding + a resolved defer-accept-risk decision) and assert on the actual rendered prompt text, including exact byte-for-byte equality of the governance block between native and invoke paths, and correct suppression of the reviewer block in the author prompt. This is exactly the coverage the plan's completion gate and my prior finding asked for.
- **P2.1** (no v1 fallback text when no governance context is appended) — **addressed**. `reviewer-plan-continued.md` now has an explicit "Context present" / "No context present" branch with concrete instructions for the fallback case, and a loader test asserts the fallback text is present.
- **P2.2** (strict `ready_with_corrections` wording applied unconditionally) — **addressed**. The definition is now split by pinned mode, with the strict one-point/zero-delta shortcut scoped to `enforced` and the ordinary v1 cycle preserved for advisory/off/`v1_compat`.
- **P2.3** (no recovery guidance after a recorded decision, no stated source for `$GATE_ID`) — **addressed**. The skill now states the `$GATE_ID` source explicitly and gives a correct, code-verified idempotent-retry recovery path (I traced `submitPlanReviewDecision`'s `alreadyResolved` branch in `review-decision.handler.ts` and confirmed a retry with a matching `decisionIntentHash` does return `acceptedWinnerResult(...)`, which includes `.data.route`).

### New issues introduced by this revision

None found. I checked the new `requiredClosureOutcomeFindings` extraction for behavioral drift from the original inline logic (none — it's a pure refactor with an added export), checked that the new `onRenderedPrompt` hook has no effect when omitted (both call sites use `deps?.onRenderedPrompt?.(...)`, a no-op when absent), and reran the full suite twice to confirm the one observed failure was pre-existing concurrency flakiness unrelated to this change.

### Updated readiness

- **Phase 7 completion:** ✅ — All five prior findings are addressed with fixes that are verified by new, targeted tests rather than just asserted in prose. `bun run typecheck`, `bun run lint`, and the full test suite are clean.
- **Ready for next phase:** ✅ — No blockers remain. Phase 9's end-to-end enforced multi-round fixtures should no longer hit the prior-finding rejection this addendum previously flagged as a prerequisite.
