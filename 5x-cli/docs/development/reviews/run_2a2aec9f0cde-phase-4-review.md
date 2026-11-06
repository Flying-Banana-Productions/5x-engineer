# Review: Phase 4 — actionable gates and plan evidence

**Review type:** `7d45073e5ee37192faeb4f574b6cf286cd494442`  
**Scope:** Initial exhaustive material review of W4 only, authoritative range `732b1424ccd5008ca56b568148dfec09c19dd13a..7d45073e5ee37192faeb4f574b6cf286cd494442`, with the supplied plan/review/run exclusions.  
**Reviewer:** Staff engineer — correctness, security, architecture, operability, tests and phase compliance.  
**Local verification:** Focused gate, upgrade and effective-runtime asset tests: 72 passed, 0 failed (20.32 seconds). Pure template-render reproduction also performed; see R1.

**Implementation plan:** `5x-cli/docs/development/plans/217-operator-directed-workflow-repair-plan.md`  
**Governance:** Initial/enforced; context `44bc1a59-47db-467d-8cdd-30e9e78100db`; binding `ff84f50f-2b92-4847-ae70-8768167de44d`. No prior outcomes, due claims or inherited alerts supplied.

## Summary

W4 adds useful composition/persistence guards against empty enforced human gates, preserves compatibility routing, and supplies effective approved-plan evidence independently of the code diff. One material recovery defect remains: both implementation corrective-review commands advertised for historical gate-less observations omit the required `commit_hash` template variable. Consequently neither advertised delegation path can start the corrective review as written.

**Readiness:** Not ready — R1 is an in-scope, mechanically derivable P1 correction; no plan amendment or human design decision is necessary.

## What shipped

- Shared enforced gate checks at composition and paired persistence for plan and implementation reviews, with empty unexplained negative verdicts returned as structured-output errors.
- Historical gate-less observation diagnostics in state, gate display and decision attempts, preserving original audit records and directing recovery to the same run.
- Runtime governing phase text, approved identity, structural diagnostics and separate plan-only diff retrieval, shared by native/invoke and fresh/continued review context.
- Anchor diagnostics for supplied design/budget plan locations without requiring new mandatory fields or weakening ordinary implementation-defect code evidence.

## Strengths

- Empty negative responses do not manufacture findings, approval observations or operator decisions.
- Gate derivation remains owned by the shared journal/store; tests rebuild the SQLite index and check decision/replay behavior.
- Existing design findings with empty locations and authorized text-only findings remain accepted without code hunks. Ordinary continued code findings still require exact hunk evidence.
- Schema 1 runtime evidence excludes notes and outside-contract content, and evidence derives from the effective approved revision rather than mutable working-tree text.
- Advisory/off behavior is explicitly separated from enforced durable-gate behavior.

## Production readiness blockers

No P0 findings.

## High priority (P1)

### R1 — Make historical implementation recovery commands renderable

**Risk:** `gatelessHumanGateReport` in `src/review-governance/gate-invariant.ts:162–167` emits both `template render reviewer-commit ... --new-session` and `invoke reviewer reviewer-commit ...` without `--var commit_hash=...`. `reviewer-commit.md` declares `commit_hash` as required with no default. `resolveAndRenderTemplate` and `resolveInternalTemplateVariables` do not infer this variable from a run; rendering occurs before the implementation context is prepared. The newly exposed same-run recovery path therefore fails before delegation, even after checklist drift is repaired. The focused tests only assert command substrings and call composition directly; they do not execute these generated render/invoke inputs.

**Reproduction:** From `5x-cli/`, a pure `renderTemplate("reviewer-commit", {run_id:"run1",plan_path:"docs/plan.md",review_path:"docs/review.md",review_template_path:"docs/template.md",phase_number:"1"})` throws `Template "reviewer-commit" is missing required variables: commit_hash`. This supplies the other CLI-derived variables and reproduces exactly the missing input in the advertised commands without touching a journal or invoking a provider.

**Requirement:** A historical gate-less implementation observation must expose at least one actually executable native corrective-review path and one invoke path, using durable reviewed-end identity and preserving the same run, phase and next iteration. No nonexistent gate decision may be required.

**Lowest-cost correction:** Resolve the observation's recorded review context and include its `reviewedCommit` as `--var commit_hash=...` in both implementation recovery delegation commands (or reuse an equivalent existing durable endpoint resolver). Keep the authoritative code-range preparation unchanged; do not substitute arbitrary HEAD. Add tests that pass the generated arguments through real template resolution for both delegation modes instead of only comparing substrings. This is approved W4 recovery wiring, with no new API/schema/dependency/subsystem/architecture/plan-structure boundary.

**Classification:** `implementation_defect`, W4, `auto_fix`; effort delta 1, architecture delta 0. The fix follows the existing template contract and recorded context identity, so it does not require operator judgment.

## Medium priority (P2)

None promoted to actionable work.

## Nonblocking follow-ups / phase boundary

- Shipped static prompt/skill/skeleton revisions and the integrated incident/issue-delivery lifecycle are explicitly W5. Their absence is not a W4 defect. The W4 asset check covers the runtime-appended context and its effective render parity; installation, override resolution, upgrade and harness synchronization mechanics are unchanged.
- Prior Phases 1–3 were not reopened. No external project, sealed run, code or plan was edited during this review. Existing dirty active-run records were observed and left to the run-aware review commit.

## Verification

Executed from `5x-cli/`:

```sh
bun test test/unit/commands/review-gate-invariant.test.ts test/unit/review-governance/gate-invariant.test.ts test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts
```

Result: **72 pass, 0 fail, 1011 assertions**. The orchestrator's separately reported full test/lint/checklist success and the author's reported typecheck/full-suite results are supporting reports, not fresh full-suite executions by this reviewer. Reviewed the complete supplied authoritative diff and traced composition, paired writes, historical readback, shared gate derivation, SQLite replay, template variable resolution and native/invoke runtime context wiring.

## Readiness checklist

**P0 blockers**
- None.

**P1 required**
- [ ] R1: Generated historical implementation recovery commands satisfy the real reviewer template's required inputs in native and invoke modes, with durable reviewed identity and same-run iteration continuity.

**Ready for next phase:** No — correct R1 and verify the recovery entry points before considering W4 complete.

## Addendum (November 6, 2026) — Close recovery command finding

**Reviewed:** `303c5546011323dd2462bcb2a8863cc5f19201a3`; exact closure range `7d45073e5ee37192faeb4f574b6cf286cd494442..303c5546011323dd2462bcb2a8863cc5f19201a3`, with the supplied plan/review/run exclusions.  
**Governance:** Enforced closure, context `b6392b66-0a38-4298-997b-d91288f8c41c`; binding and W4 scope unchanged. Required prior outcome: R1 only.

### What's addressed

- **R1 — Addressed.** `implementationGatelessReport` now looks up the historical observation's durable review context using the same run/budget key and decoder as the existing store. Its `reviewedCommit` flows to both native-render and invoke recovery commands as `--var commit_hash=...`. Run, phase and next-iteration selectors remain intact. No HEAD inference or code-range broadening was introduced.
- The command-handler test verifies that gate display publishes the recorded context's endpoint in both delegation paths. The new regression extracts the generated native/invoke arguments and passes them through real `parseVars` and `resolveAndRenderTemplate`, checking the required commit, phase, run, generated review path, rendered commit text and step identity. Its negative control removes `commit_hash` and reproduces the original missing-variable error.

### Verification

Executed from `5x-cli/`:

```sh
bun test test/unit/commands/review-gate-invariant.test.ts test/unit/review-governance/gate-invariant.test.ts
```

Result: **25 pass, 0 fail, 182 assertions** (243 ms). Read the complete supplied revision diff and checked the durable lookup against the existing context storage/read implementation. The separately reported current-commit quality/checklist pass and author full-suite/lint/typecheck results were not independently rerun in this bounded closure review.

### Remaining concerns / nonblocking follow-ups

- No remaining R1 work and no new revision-caused material blocker found.
- If the referenced context is absent or undecodable, the fallback names that context in a shell-quoted placeholder rather than inventing a hash or using HEAD. That is an explicit unresolved input, not a claim that a verified endpoint was recovered. The normal durable-context recovery path is the one verified above; no speculative additional recovery subsystem is required to close R1.
- W5 static assets and integrated lifecycle acceptance remain the next phase's work, as noted in the initial review.

### Updated readiness

- **Phase 4 completion:** Ready — R1 is addressed; no actionable review items remain.
- **Ready for next phase:** Yes — proceed to the approved W5 scope. This addendum does not itself record phase completion or approve later-phase work.
