# Review: Phase 3 — Issue-resolution skill and orchestrator wiring

**Review type:** implementation, initial; `58a8ca1c751ccfefcc6554d998ecadfb5b7ac35f`  
**Scope:** Authoritative range `e0e326fc265da936eb40605835b764c14b6d1476..58a8ca1c751ccfefcc6554d998ecadfb5b7ac35f`, Phase 3 only, approved W1–W4.  
**Reviewer:** Staff engineer (workflow correctness, provenance, remote-write recovery)  
**Implementation plan:** `5x-cli/docs/development/plans/217-explicit-issue-resolution-plan.md`, approved commit `ebf30e36377d008672e51352ceadcf7bbaf7ec8a`  
**Governance:** enforced; binding `52e5d3b5-bbbb-4b71-94b2-ae4174bb6b16`; review context `46a6dbc9-5978-4ebf-b823-58c6878f0264`.

## Summary

The registered skill provides the intended end-to-end composition and genuinely executable recipes. Four delegation-mode renders, harness wiring, exact correction-proof fields, and the ordinary recovery fixtures pass. Phase 3 is not ready: executable paths bypass required identity/error checks, and the approved closure algorithm itself promotes an externally closed issue to success on a subsequent resume.

**Readiness: Not ready** — mechanical workflow corrections plus a human-approved closure-contract correction are required. No Phase 4 documentation or installation-expansion work is demanded here.

## What shipped

- New registered `5x-issue-resolution` skill, foundation pointer, and OpenCode/Cursor orchestrator references.
- Seven bash recipes for discovery, refresh, delivery identity, compatibility, PR preparation, and publication.
- Four-mode render coverage, resume-matrix consistency checks, and real-git/stub-gh integration fixtures.

## Strengths

- Tests extract and execute the shipped recipe blocks, rather than a second implementation.
- Accepted-interval fixtures reject uncovered pre-admission/inter-phase code, reverted code, and divergent equal trees; squash delivery uses PR-head identity.
- The corrected-route predicate includes the full `exactCorrectionCarryProof` checks, including inventory, boundaries, assessed commit, and ordered carried-claim equality. Both corrected routes are exercised with completion authorization false.
- Missing durable legacy reviewed inputs stop rather than substituting a reviewer-recording head. This agrees with the approved compatibility stop rule.
- Existing permissions were not widened. Push/PR authorization and operator-controlled remote writes remain explicit.

## Production readiness blockers

No P0 findings.

## High priority (P1)

### I1 — Enforce validated identity and fail-closed checks throughout the new workflow

**Classification:** `implementation_defect`; `auto_fix`; W1, W3; effort delta 3; architecture delta 0; boundary changes none; estimate confidence high; reviewer verification required.

These are missing applications of already approved safeguards in the same new asset, grouped under one correction item. Each subcase must be fixed and regression-tested:

1. **Resume must reuse the discovered intake association.** The incomplete-intake row sends resume to Step 1 (skill lines 237–240), but Step 1 unconditionally allocates `NEXT`, a new `PLAN_PATH`, and a new brief directory (lines 257–276). Restore the validated plan path, original planning run, worktree, and brief directory on resume; allocate a new association only when discovery found none. Otherwise a checkpointed intake starts duplicate work instead of continuing its immutable snapshots.
2. **PR preparation must validate ownership before mutation.** `prepare-pr` selects `.[0]` from every PR sharing the branch and then edits that PR's body (lines 420–433), without validating the canonical source/plan marker or ambiguity. A probe with an unmarked human PR on that branch overwrote its body with the workflow marker and returned `awaiting_merge`. The existing integration test even expects an unmarked body `old` to be adopted. Use the approved marker + validated plan + head-branch identity, stop for unmarked/mismatched/multiple candidates, and apply the same validation after create read-back. Branch equality alone is not authorization to adopt someone else's PR.
3. **Refresh must fail closed when evidence cannot be read.** `refresh-compare` does not guard snapshot `git show` failures (lines 471–483), and live fetch/pagination status is not checked in the preceding block (lines 459–464). A probe with both pinned snapshot paths absent returned exit 0 and no difference lines despite fatal git errors. Require successful, complete, structurally valid snapshot/live inputs before comparison; otherwise return `needs_human`, with no publication. Do not treat empty jq input as a successful comparison. Discovery's run-list validation should likewise not treat a failed query as evidence that a run exists.
4. **Delivery classification must propagate unsettled/error results.** `accepted-intervals` emits `unsettled <phase>`, but `classify-delivery` handles only `interval`, `correction`, and `needs_human` (lines 662–670). A probe with `BASE=FINAL=PR_HEAD` and `INTERVALS='unsettled 1'` returned `delivery: ok`. Reject unsettled and malformed/error recipe output, and check git/jq command statuses instead of allowing failed reads to become an empty successful classification. Add a case where the phase has no code-touching commits, so uncovered-code detection cannot accidentally mask this failure.

**Requirement / correction source:** Design Decisions' validated discovery/PR identity, stateless resume, read-only material-source checks, and effective accepted-interval rules; Phase 3 §§3.1–3.3 and AC3. These corrections do not change approved behavior or add a boundary.

**Diff-causal evidence:** `diff --git a/5x-cli/src/skills/base/5x-issue-resolution/SKILL.tmpl.md b/5x-cli/src/skills/base/5x-issue-resolution/SKILL.tmpl.md`, complete new-file hunk `@@ -0,0 +1,903 @@` in the authoritative range. The structured verdict carries that entire hunk, not a truncated excerpt. This range introduces all four executable/control-flow gaps; they are not pre-existing notes.

### I2 — Preserve externally closed provenance across repeated resumes

**Classification:** `plan_defect`; `human_required`; design impact; W3; effort delta 1; architecture delta 0; boundary changes none; estimate confidence high; reviewer verification required.

The approved Design Decisions closure branches conflict: branch d publishes an “already closed” receipt and returns `resolved_externally_closed_unverified`, but branch b treats any marked comment plus closed state as `resolved`. On the next resume, branch b consumes the receipt created by branch d and promotes unrelated human closure to success.

**Verified failure:** Ran `publish-resolution` twice against the same stub state, initially CLOSED, using the documented externally-closed comment body. First result: `resolved_externally_closed_unverified`. Second result: `resolved`. No new delivery or closure evidence arrived between invocations.

**Plan impact:** `{"kind":"design","locations":[]}`. Governing location: `## Design Decisions`, **Reconciliation order after merge**, branches b and d; also the **Outcome vocabulary** statement that only `resolved` means success. This is not a mechanical code-only fix: the shipped recipe follows the approved branch b, so the approved closure rule must first change through amendment approval.

**Lowest-cost correction:** Have the operator approve a closure rule that distinguishes an external-closure receipt from a workflow-completed close on every resume, using GitHub-resident evidence as already required. Then align the skill and add a two-resume external-closure fixture while preserving ordinary successful-close idempotency. Do not invent a new run schema, reopen sealed runs, or silently auto-approve a receipt-design choice.

## Medium priority (P2)

None admitted.

## Verification and asset-impact check

- Retrieved and read the complete authoritative implementation diff; compared governing contract text with the approved plan commit. Revision-history claims were informational, not authorization.
- `bun test test/unit/skills test/unit/harnesses test/unit/commands/harness.test.ts test/integration/issue-resolution-recipes.test.ts test/integration/commands/upgrade.test.ts`: **676 pass, 0 fail**, 3,673 assertions. This includes the required focused upgrade/governance suite.
- Additional disposable real-git/stub-gh probes executed the actual extracted recipes and reproduced I1's PR adoption, missing-snapshot success, unsettled-classifier success, and I2's two-resume outcome change. Probes made no changes to implementation files or real GitHub state.
- Checked installed `gh` 2.101.0 help for issue/PR JSON fields and PR-list flags. The documented field names used by these queries are supported.
- **Skeletons:** unaffected by this phase; Phase 2's compact note remains in place.
- **Initial/continued agent prompts:** unaffected by this phase; bounded intake and coverage prompts are existing inputs to the new skill.
- **Runtime-appended context/native-invoke parity:** no runtime change. Four effective role-mode skill renders and generic native/invoke separation tests passed.
- **Workflow skills:** new skill plus pointer; render and executable behavior reviewed above. Requiring bash is explicit and matches the fixture execution shell.
- **Install/override/upgrade/harness sync:** registration feeds existing installers; harness/list suites and upgrade suite passed. OpenCode write/edit remain disabled, Cursor permission rules unchanged. Phase 4's dedicated fresh-install/sync/override/manual acceptance expansion remains pending, not a Phase 3 blocker.

## Nonblocking follow-ups

- No ordinary pre-existing issue is admitted as author work.
- Operator smoke-matrix execution and user-facing docs belong to Phase 4. No claim here that string consistency tests prove agent judgment.

## Readiness checklist

- [x] Reviewed all authoritative hunks and all four role-mode render paths.
- [x] Verified recipes are extracted from the shipped skill and executed with bash.
- [x] Verified durable record names and full exact correction-proof predicate against runtime source.
- [ ] I1: Restore resume identity reuse, validated PR ownership, fail-closed refresh, and unsettled/error propagation; add regression fixtures for each.
- [ ] I2: Obtain approved closure-rule correction and prove repeated external-closure resume does not become success.
- [ ] Phase 3 completion / ready for Phase 4: blocked on the findings above.
