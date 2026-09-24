# Review: Plan 210 Phase 10 — Implementation prompts and workflow skills (W10)

**Review type:** `8b421bbd67e7d52f66248d802ff0f0261d2f8d26..99e5ba0bb8c21aa3ef3f99801c6bc82926458726` (commits `4b3784e`, `99e5ba0`)
**Scope:** Shared implementation-review prompt context, render/invoke envelope fields, reviewer/author templates, `5x-phase-execution` skill routing, new skill/template tests
**Reviewer:** Staff engineer (correctness, workflow contract, test strategy)
**Local verification:** `bun test test/unit/skills/implementation-review-governance.test.ts test/integration/commands/template-list.test.ts` — 11 pass; `bunx tsc --noEmit` clean. Manually ran `5x protocol emit reviewer` with the template's `introducedBy` example — rejected (see P1.1).

**Implementation plan:** `5x-cli/docs/development/plans/210-implementation-review-governance-plan.md` (Phase 10, W10)
**Technical design:** N/A

**Governance context:** review context `27d03306-4005-43eb-a1e5-5bcc36a0bfc7`, binding `b6177755-f899-4c4e-b94a-c70431fecf13`, advisory mode, initial review, no due claims/decisions/waivers.

## Summary

Phase 10 adds one shared builder (`buildImplementationReviewPromptContext`) used by both `template render` and `invoke`, formats separate reviewer/author appendices, returns `binding_id`/`source_run_id`/`pinned_mode`/`pre_author_commit` in both envelopes, and rewrites the reviewer and author templates and the phase-execution skill around the four classes and the durable route. The structure is right, and render/invoke now append in the same order (template + code diff + governance). However, the new instructions contain four defects that break the workflow they describe: the reviewer template's `introducedBy` example fails protocol validation; the native-reviewer skill branch reads the governance route from the raw agent output rather than the validate envelope; fresh-session closure rounds receive the initial template with no prior-outcome instructions; and human-deferred findings still reach the author as admitted work.

**Readiness:** Not ready — four P1 contract defects, all mechanically correctable.

---

## What shipped

- **Shared context builder** (`review-governance/context.ts`): binding/source/snapshot/approved commit, phase heading and scope, approved W IDs, review context ID and full-diff command, required prior outcomes, due claims (with waiver-adjusted magnitude), imported and implementation deferred risks, debt waivers, author route/next action, final-correction item, admitted findings, and text guard spans.
- **Handlers**: `template.handler.ts` and `invoke.handler.ts` call the builder for commit-review and implementation-author templates and surface binding/mode/pre-author fields; `capturePreAuthorHead` now returns the captured SHA.
- **Templates**: `reviewer-commit` v5 (exhaustive initial pass, classes, planImpact object), `reviewer-commit-continued` v3 (closure rules), `author-process-impl-review` v3 and `author-next-phase` v3 (admitted-only work, guard, final-correction limit).
- **Skill**: first-admission binding and `IMPLEMENTATION_APPROVAL_REQUIRED` handling, envelope field capture, enforced route branch, `review corrections finish`, Step 5b typed gate via `review gate show` / `review decide`.
- **Tests**: new `test/unit/skills/implementation-review-governance.test.ts`; template version bump and a plan-diff timeout increase.

---

## Strengths

- One builder for both delegation paths, so render and invoke cannot drift semantically; the append order is now the same in both handlers.
- The session ID doesn't affect the context (`void input.sessionId`), and a test checks that fresh and continued builds are equal.
- Every skill CLI reference (`review implementation bind --run --source-run`, `review corrections finish --run --phase --review --commit`, `review gate show --phase`, `review decide --gate`) matches `commands/review.ts`.
- Imported plan-review `defer_accept_risk` decisions are carried through the binding with supersession handling, so a separate execution run still shows them.
- The author context filters out scope expansion, critical safety, non-text plan defects and ordinary pre-existing items, and narrows the list to the eligible item on a final correction.

---

## Production readiness blockers

None at P0.

---

## High priority (P1)

### P1.1 — Reviewer template `introducedBy` example fails protocol validation

`templates/reviewer-commit.md` (the `5x protocol emit reviewer` example) shows `"introducedBy":{"path":…,"header":…,"text":…}`. The protocol (`src/protocol.ts:366–374`, `:966–975`) requires `{commitRange, diffHunk, explanation}`. Running the example verbatim returns `INVALID_STRUCTURED_OUTPUT: item 'I1' has incomplete 'introducedBy' evidence.` Every reviewer that copies the documented example gets a rejected verdict, and in enforced continued reviews it cannot supply the new-blocker evidence at all. The two prose descriptions ("the `diff --git` line plus the complete `@@` hunk") are correct; only the JSON shape is wrong.

**Requirement:** use `{"commitRange":"<base>..<reviewed>","diffHunk":"diff --git …\n@@ … @@\n…","explanation":"…"}` in the example. Add a test that pipes the rendered example items through `protocol emit`/validation so the example cannot drift from the schema.

### P1.2 — Native-reviewer skill branch reads the governance route from agent output, not the validate envelope

In the `reviewer_native` branch of Step 3, `echo "$RESULT" | 5x protocol validate reviewer --record …` does not capture its output. `$RESULT` is still the raw Task result. Step 4 then runs `jq '.data.result.governance.route'` / `.observationId` / `.nextAction` against `$RESULT`. The governance decoration exists only in the validate envelope (`protocol.handler.ts:958–983`, `data.result.governance`). In native-reviewer mode `GOVERNANCE_ROUTE` and `OBSERVATION_ID` are therefore always empty. The enforced "only branch" has no route, and `review corrections finish --review $OBSERVATION_ID` receives an empty ID. The invoke branch works because the invoke envelope carries the same decoration.

**Requirement:** capture the validate output (e.g. `VALIDATED=$(echo "$RESULT" | 5x protocol validate reviewer …)`) and read governance fields (and readiness/items for the legacy path) from it in native mode. Extend the four-combination skill test to assert that native Step 4 reads from the validate envelope.

### P1.3 — Fresh-session closure rounds get the initial template without prior-outcome instructions

Template selection is session-based (`wantContinued` in both handlers). The context builder instead derives `reviewKind` from durable history (`priorReviewCount`). The skill explicitly states "`--new-session` selects the initial template", and `reviewer-commit.md` says to use the appended context "on this initial pass and on a fresh session". The initial template, however, never mentions `priorFindings`, `--prior-finding`, "Required prior-finding outcome IDs", or `priorDecisionId`/`newEvidence`, and it tells the reviewer to "perform one exhaustive material pass". On a second-or-later review in a fresh session, the reviewer sees `Review kind: closure` and a list of required IDs but no instruction to emit outcomes. The result is a closure verdict missing required outcomes (rejected or unconverged in enforced mode) and an exhaustive re-review, which is exactly what the plan's "subsequent reviews as closure" is meant to prevent.

**Requirement:** when `reviewKind === "closure"`, the reviewer prompt must carry the closure rules regardless of session. The lowest-cost fix is to have `formatImplementationReviewerContext` append the closure-rule block (one `priorFindings` outcome per required ID via `--prior-finding`, partial/open stay in `items[]`, new-blocker hunk evidence, deferred re-raise requirements) when the context is closure, and to correct the skill sentence. Add a fresh-session closure test.

### P1.4 — Human-deferred findings are still listed as admitted author work

`buildImplementationReviewPromptContext` builds `actionableFindings` from the latest observation's `originalVerdict.items` without consulting the active accepted implementation decisions it has just computed. After a human `defer_accept_risk` on a finding, the next author prompt lists that finding under "Actionable findings — Implement only the admitted findings below" and also under "Finding IDs not to implement". The second list shows the finding title, not the ID, so the two lists don't even obviously match. This contradicts the plan's requirement that authors "consume only admitted actionable findings and governing decisions".

**Requirement:** exclude from `actionableFindings` every finding ID referenced by an active `defer_accept_risk` decision for this binding/phase. Render the skipped list as finding IDs (with title/decision as annotation). Add a unit test with a recorded observation plus an accepted defer decision.

---

## Medium priority (P2)

- **P2.1 — Final-correction flow contradicts Step 5's loop-back.** Step 4 says `final_corrections` → "Step 5 limited to the eligible item, then `review corrections finish` … with no reviewer re-entry". But Step 5's "Check the result" unconditionally says `complete` → "loop back to Step 2" (quality → Step 3 reviewer). An orchestrator following Step 5 literally re-enters review and never calls `corrections finish`. Add an explicit final-correction exit in Step 5's result handling: on `complete` in final-correction mode, run `corrections finish` with the new `$COMMIT`; if it passes go to Step 6, if it's invalidated go to Step 2 → Step 3.
- **P2.2 — Byte-parity test is tautological; render/invoke handler outputs are untested.** "keeps native and invoke governance bytes identical" calls `appendPlanReviewPromptContext` twice with identical inputs. It never exercises `templateRender` versus `invokeAgent`. No test asserts the new `binding_id` / `source_run_id` / `pinned_mode` / `pre_author_commit` envelope fields or that either handler appends the implementation context for `reviewer-commit`, `reviewer-commit-continued`, `author-process-impl-review` and `author-next-phase`. The plan explicitly requires "context byte parity" and "invocation/native continuation versus new sessions". Add a handler-level test that renders via template render and captures the invoke prompt for the same bound run/phase and compares the bytes.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 `introducedBy` example matches the protocol schema
- [ ] P1.2 native reviewer branch reads governance from the validate envelope
- [ ] P1.3 closure rules reach fresh-session closure reviews
- [ ] P1.4 deferred findings excluded from admitted author work

**P2**
- [ ] P2.1 final-correction exit in Step 5
- [ ] P2.2 handler-level parity and envelope tests

---

## Nonblocking follow-ups

- `phaseScope` lists only work items whose debt claim targets the phase (`workItemsForPhase` joins through `debtTargets`). For phases without claims (e.g. this one) it shows only the heading. The binding has no phase→work-item map, so the heading is the only reliable source. Consider labelling the derived list "work items with claims due here" to avoid implying it is complete.
- `phaseHeading` retains the `## ` Markdown prefix, producing `Phase: 10 — ## Phase 10: …` and `10: ## Phase 10: …` in rendered context. Cosmetic.
- The advisory-mode paragraph in Step 4 doesn't say which branch applies; state explicitly that advisory runs use the legacy readiness route below.
- Step 5's max-iteration escalation points to Step 5a, which in enforced mode redirects to Step 5b. If there is no open typed gate, `review gate show` has nothing to show. Consider stating the enforced escalation path explicitly.
- The invoke handler resolves the context phase from `params.phase ?? mergedVars.phase_number`; render also falls back to `resolved.variables.phase_number`. The sources are equivalent in current skill usage but could diverge for direct callers.
