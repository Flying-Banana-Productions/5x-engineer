# Review: Phase 4 installed assets and operator documentation

**Review type:** Implementation review of `fa3d2281139ff96d42537489be85289738455f98`  
**Scope:** Authoritative range `9fdbaf8060af52166473012d7aef7327ee2328ea..fa3d2281139ff96d42537489be85289738455f98`, with the supplied plan/review/run-record exclusions; Phase 4, W4, with W1-W3 checked as settled dependencies rather than reopened work.  
**Reviewer:** Staff engineer (correctness, asset delivery, operability, test strategy)  
**Implementation plan:** `5x-cli/docs/development/plans/217-explicit-issue-resolution-plan.md`, effective approved v1.6 amendment.  
**Governance:** Initial enforced review; binding `52e5d3b5-bbbb-4b71-94b2-ae4174bb6b16`; review context `2325542a-8dd5-4f43-b32f-51adc480e07e`.

## Summary

The reviewed range adds installation/override/mixed-mode acceptance coverage and accurate operator documentation for the already-reviewed issue-resolution assets. No material implementation defect or new boundary change was found. The effective contract explicitly permits unexecuted manual smoke cases to remain pending; publishing all 18 cases as pending satisfies that gate without claiming live GitHub validation.

**Readiness:** Ready — Phase 4 is complete against the approved gate. Automated acceptance is verified; agent judgment and live GitHub behavior remain honestly unvalidated by the manual matrix, not represented as proven production behavior.

## What shipped

- Fresh OpenCode install, sync restoration, customized-skill preservation, installed mixed delegation, intake-template scaffolding, override resolution, stale-warning, and non-destructive upgrade tests.
- Actual Cursor and universal project-install tests inspecting installed skill files and Cursor orchestrator discovery text.
- Getting-started instructions, README/automation/LLM entry points, changelog, and an 18-scenario sandbox rehearsal matrix.

## Verification and contract assessment

- Read the complete mandatory authoritative diff and the governing plan outside notes. Phase 4's completion gate requires publication of the matrix, not live execution of every case. Issue Coverage AC4 explicitly allows the smoke matrix to be executed **or listed as pending**; section 4.2 likewise requires unrun cases to stay pending. No fabricated execution or unauthorized remote action was performed.
- Ran the focused asset suite together with Cursor/universal installation and executable issue-resolution recipes: **126 passed, 0 failed** across five files. The focused suite exercises actual installed and rendered assets, not only bundled-source strings.
- Ran `bun test test/unit/templates test/unit/skills test/unit/harnesses test/unit/parsers`: **762 passed, 0 failed**. Expected stale-override fixture warnings were printed.
- Ran `bun run lint`: clean, 475 files checked with no fixes. Ran `bun run typecheck`: passed.
- Ran `bun run test`: **4229 passed, 0 failed**, 17875 assertions across 269 files. An earlier reviewer attempt was terminated by the review tool's 120-second timeout; rerunning with a sufficient tool timeout completed in 219.13 seconds. This was a tool execution limit, not a test failure.
- Inspected the installed-asset assertions and the effective skill's receipt rules. OpenCode, Cursor, and universal installs assert that mandatory receipt preflight precedes closure branches; mixed mode retains invoke intake and native reviewer instructions without the opposite branches. The installed OpenCode skill also carries both receipt kinds and the persistent external-closure outcome.
- Confirmed the existing executable recipe suite invokes the shipped publication recipe and checks repeated external-closure resumes remain `resolved_externally_closed_unverified`, ordinary successful resumes remain idempotent, invalid authenticated markers and duplicate receipts stop without writes, and confirming re-lists cannot proceed to close after a duplicate appears. These are behavioral recipe tests, not proof an agent will obey the workflow.
- Documentation accurately distinguishes intake's read-only GitHub work, operator-authorized publication, externally performed merge, delivery-identity checks, receipt preflight, and post-merge closure. The smoke document expressly says automated recipes and asset tests do not prove agent judgment; all 18 rows remain pending with no invented operator/date evidence.

## Asset-impact check

| Surface | Assessment |
|---|---|
| Document skeletons (`default-artifacts.ts`) | No Phase 4 change required; compact-plan guidance was delivered in Phase 2 and parser/template tests pass. |
| Initial/continued agent prompts | No Phase 4 behavior change required; intake installation/override behavior is now tested, and existing issue-coverage parity tests pass. |
| Runtime-appended context and native/invoke parity | Unchanged by this range; existing shared-render/parity and governance tests pass. No durable runtime facts were duplicated into the new documentation. |
| Workflow skills and delegation modes | No new skill edits in this range. Installed OpenCode/Cursor/universal outputs and mixed delegation are covered, including the v1.6 receipt-preflight order. |
| Install, override, upgrade, synchronization | New regression coverage exercises fresh delivery, missing-skill restoration, preservation of customization, override precedence/stale warning, and upgrade reporting without replacement. No installer changes or new boundary are needed. |

## Strengths

- Tests inspect real installed file paths and rendered prompt output, including the project override probe rather than merely template registration.
- Customization preservation is tested as a refusal with unchanged bytes, avoiding accidental destructive synchronization.
- Closure provenance and preflight are both documented on operator-facing surfaces and checked through installed assets plus executable recipes.
- The manual matrix covers failure/resume and hostile-input scenarios without presenting pending agent rehearsals as automated guarantees.

## Production readiness blockers

None found in the reviewed Phase 4 range.

## High priority (P1)

None.

## Medium priority (P2)

None requiring correction.

## Nonblocking follow-ups

- Execute and record the published sandbox smoke rows when an operator authorizes the necessary live GitHub work. This is the disclosed manual validation limitation, not an unmet Phase 4 gate or new author assignment.
- Informational plan status above the contract still describes amendment review as pending. The supplied registered amendment governs this review; that informational sentence is not an approval record and does not invalidate the effective contract.

## Readiness checklist

- [x] Full authoritative implementation diff reviewed.
- [x] Phase 4 completion gate and AC4 assessed against governing contract text.
- [x] Effective installed/rendered assets checked across relevant harnesses and delegation modes.
- [x] External-closure persistence and mandatory receipt preflight documented and tested.
- [x] Focused suite, scoped suites, lint, typecheck, and full suite pass.
- [x] Pending manual rehearsals explicitly disclosed; no live GitHub execution claimed.
- [x] No unresolved actionable finding or amendment required for this phase.
