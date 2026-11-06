# Review: Phase 2 executable-plan diagnostics (W2)

**Review type:** Commit `8f4483abdd9cd3d4e1e6284d8e483a1efcb57f68`  
**Scope:** Initial exhaustive material review of `4e51a81e13fc1e510996dcc3b409c0ead6120963..8f4483abdd9cd3d4e1e6284d8e483a1efcb57f68`, with the authoritative exclusions supplied by the orchestrator.  
**Reviewer:** Staff engineer — correctness, authority, recovery, compatibility and verification  
**Implementation plan:** `5x-cli/docs/development/plans/217-operator-directed-workflow-repair-plan.md`, Phase 2 / W2; binding `ff84f50f-2b92-4847-ae70-8768167de44d`, approved commit `36ec99ddc06d9adcf4797819d8f8fcea283dec9f`.  
**Review context:** `1b6b03c5-f930-4eaf-a900-b6166717b091`

## Summary

The implementation adds a useful shared diagnostic result, nonblocking inspection, and same-run repair directions. The normal malformed-list recovery works, including budget-off paths. Four material W2 corrections remain: delegation must use recorded schema authority, literal filtering must distinguish actual fences/comments from executable content, runless invocation needs the pre-review check, and completion must not accept a zero-item COMPLETE heading as executable evidence.

**Readiness:** Not ready — mechanical P1 corrections are required within approved W2; no amendment or operator policy decision is needed.

## What shipped

- Shared executability diagnostics and repair classification, including per-phase item counts, duplicate IDs and zero-item COMPLETE reporting.
- Additive `plan phases` diagnostics and runnable repair previews, preserving ordinary inspection and historical display.
- Native/invoke author preflights, plan-review preparation/recording checks, and informational plan-run completion diagnostics.
- Regression coverage for ordinary malformed drafts, approved-run repair/resume, compact plans and schema authority at the pure-helper level.

## Strengths

- Recovery uses the existing Phase 1 proof/receipt mechanism rather than granting blanket drift authority.
- The primary integration tests demonstrate that deterministic repairs preserve the run and do not consume reviewer observations or decisions.
- Ordinary prose gates and the compact issue-plan fixture remain accepted without expanding the plan skeleton.
- Author-only approved-plan gaps warn and name scoped amendment rather than inventing an unrepairable mandatory formatting gate. This is a reasonable repair-first distinction; it must not turn into successful completion without executable items (R4).

## Production readiness blockers

No P0 finding.

## High priority (P1)

### R1 — Use the recorded schema in implementation delegation diagnostics

The new calls in `src/commands/template.handler.ts:437–441` and `src/commands/invoke.handler.ts:614–618` omit `expected`, so the helper defaults to `file` even after admission resolved a bound execution. The repair command, inspection and completion readers use the recorded schema instead. This can falsely refuse a valid schema-0 bound plan containing schema-1-looking markers: its existing task after the apparent contract end remains authoritative under schema 0, but the new preflight masks it and demands a new unchecked marker.

**Verification:** An in-memory reproduction produced schema-0 `executable: true`, the omitted-schema delegation result `PLAN_CHECKLIST_REPAIR_REQUIRED` with schema 1, and `status: ok` when passed `expected: 0` for identical bytes.

**Required correction:** Thread the effective recorded schema from the run context into both native and invoke checks, falling back to `file` only for an ungoverned file. Test the actual caller paths, not only the pure helper. Keep the existing schema/drift admission checks intact.

### R2 — Correct shared literal filtering for inline code and multiline comments

`src/parsers/plan.ts:33–82` treats every line beginning with three backticks as a fence opener, even when the same line is a valid triple-backtick inline code span, and recognizes HTML comment starts only at the beginning of a line. Both mistakes now affect the phase parser and the enforcement result.

**Verification:** A phase containing a standalone inline span, ` ```literal example``` ` (without the surrounding spaces), followed by `- [ ] Real requirement` is reported as having zero items and needing missing requirements. Conversely, `Explanation <!--` followed by `- [x] Commented example, not a requirement` and `-->` is reported executable and 100% complete. The latter item's entire line is inside a valid multiline HTML comment.

**Required correction:** Keep the single shared filter, but recognize actual fence openers (in particular, reject backticks in a backtick fence's info string) and track multiline HTML comments that open after visible prose. Add tests for both failure directions through parsing, diagnostics and repair eligibility. Do not introduce a separate parser or dependency.

### R3 — Apply the invoke pre-review check without requiring a run

The new invoke preflight at `src/commands/invoke.handler.ts:797–808` is nested inside the `params.run`-guarded block beginning at line 745. A supported invocation with an explicit plan and no run therefore reaches the provider without checking executability. Native template rendering puts its equivalent check outside the run guard (`src/commands/template.handler.ts:593–619`), so the two delegation modes disagree.

**Failure:** An unapproved, nonbudgeted draft with only plain gate bullets can spend a reviewer invocation via the runless invoke path instead of returning directly to its author. The boundary is supposed to precede provider/session creation, not depend on durable review-budget machinery.

**Required correction:** Perform the shared reviewer-plan preflight for any resolved plan before provider/session creation, using the effective run path when available and the resolved file otherwise. Cover initial/continued templates with a fake provider and assert zero session starts on refusal, then successful invocation after repair. Do not force run creation or add a new approval gate.

### R4 — Enforce nonempty executability at completion, not just display it

The completion integration in `src/commands/protocol.handler.ts:370–402` invokes the new shared check only inside `phase.items.length === 0 && !phase.isComplete`. A zero-item phase whose heading ends in COMPLETE never enters it; the later completion test also accepts the display sentinel. This leaves the W2 completion integration incomplete even though diagnostics correctly call that same phase non-executable.

**Verification:** In a separate process with only an in-memory virtual-file mock, `diagnosePlanExecutability` returned `executable: false` and `markedCompleteWithoutItems: true` for `## Phase 1: Work - COMPLETE` followed by prose only. `evaluatePhaseChecklist` returned `{ ok: true }` for those identical bytes. This helper is used by protocol validation and phase finish, including nonbudgeted compatibility paths.

**Required correction:** Reject zero executable items independently of the historical `isComplete` display flag. Preserve that flag in inspection. Return the existing mechanical repair path when available, or author/scoped-amendment guidance when requirements are absent; do not fabricate completion evidence or require a new execution run. Add completion-boundary tests, including COMPLETE with an actual repairable gate list and COMPLETE with no list.

All four findings are `implementation_defect`, linked to W2, with architecture delta 0 and no boundary changes beyond the approved plan. Their fixes are uniquely derivable from the governing contract and existing helpers. Exact file-qualified reviewed-range hunks are included in the structured verdict.

## Medium priority (P2)

No additional actionable P2 findings.

## Verification

Reviewer-run command, from `5x-cli/`:

```sh
bun test test/unit/plan-schema/executability.test.ts test/integration/commands/plan-executability.test.ts test/integration/commands/plan-repair-checklists.test.ts test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts
```

Result: **74 pass, 0 fail, 1011 expectations**. This includes the required focused asset acceptance suite. Additional read-only, in-memory `bun -e` probes reproduced R1, both R2 cases, and R4; the R4 probe used a virtual-file mock, not a workspace file. R3 is established by control-flow inspection; no live provider was invoked.

The orchestrator separately reports passing lint/full tests/checklist finish, and the author reports 4301 tests/typecheck plus 258 focused tests. Those are supplied evidence, not reviewer-run verification.

## Workflow asset-impact check

| Surface | Phase 2 assessment |
|---|---|
| `src/templates/default-artifacts.ts` | Unchanged; skeleton wording is W5. The current diagnostic work must preserve valid compact/prose forms. |
| Initial/continued agent prompt assets | Unchanged; W5 owns guidance edits. Runtime initial/continued preflight selection was inspected; runless native/invoke divergence is R3. |
| Runtime-appended context / native-invoke parity | New refusal diagnostics are runtime-owned rather than prompt overrides. Both implementation caller paths need recorded schema (R1); pre-review parity needs R3. Anchored plan evidence is later W4. |
| Base workflow skills and delegation modes | Unchanged; W5 owns skill examples and repair orchestration. CLI help field-name corrections shipped now. |
| Installation, overrides, upgrade, harness sync | No installer or ownership changes. Reviewer ran the upgrade and implementation-review-governance acceptance tests successfully, exercising effective installed/rendered assets rather than just source wording. No new mandatory sync gate is appropriate. |

## Nonblocking follow-ups and scope notes

- Plan-run completion currently reports invalid structure without blocking. For a deterministically repairable legacy approval, Phase 1 provides the intended completed-source run repair, so this alone is not an additional W2 finding. Exact committed-blob approval reconciliation, unsupported final-correction deltas and finalization provenance belong to W3; this review does not demand their early delivery.
- The modified legacy fixture deliberately records a verdict against an executable working copy, restores malformed committed bytes, then completes. It is useful for constructing a legacy repair subject but is not evidence that current approval validates the final committed blob. Preserve that distinction when W3 replaces the finalization seam.
- Broader installed skill guidance, issue delivery recipes, empty-negative-verdict routing and truthful plan-only review evidence remain W3–W5 work, not missing W2 deliverables.

## Readiness checklist

- [ ] R1: Native/invoke diagnostics use effective recorded schema authority.
- [ ] R2: Literal masking preserves valid inline code and excludes multiline comments opened after prose.
- [ ] R3: Runless invoke preflights a draft before provider/session creation.
- [ ] R4: Completion refuses zero executable items despite a COMPLETE display heading and provides the proper recovery action.
- [x] Normal deterministic repair preserves the run, inspection and review iteration budget in the exercised integration tests.
- [x] Focused installed/rendered asset acceptance passes.

**Ready for next phase:** No — address the four mechanical W2 findings and re-review the corrected range. No operator decision or scope expansion is requested.

## Addendum (November 6, 2026) — Phase 2 findings closure

**Reviewed:** `8f4483abdd9cd3d4e1e6284d8e483a1efcb57f68..a740407bbf427e4337109ab8d4f0e5d091bd4bae`, using the complete authoritative delta and its supplied exclusions.  
**Review context:** `b8e7190c-f925-4417-b6b5-90a7803d19e6`  
**Scope:** Closure of R1–R4 and regressions introduced by their fixes, not a second exhaustive pass. Binding, approved W2 scope and plan authority are unchanged.

### Prior-finding outcomes

| ID | Outcome | Re-anchored evidence |
|---|---|---|
| R1 | **Addressed** | Both implementation-author closures accept `expected` and both bound-admission branches pass `expectedSchemaForStore`. The resolver includes effective recorded-schema lineage; unbound files keep file inference. New native and invoke caller tests exercise a schema-0 binding with schema-1-looking markers and a real item after the apparent contract end. |
| R2 | **Partially addressed** | `fenceOpener` now rejects backtick info strings containing backticks, and comments opened after prose are tracked. The originally reported examples and repair-eligibility assertions pass. However, new `leavesCommentOpen` strips inline-code spans before looking for comment boundaries, introducing the concrete false-empty regression below. |
| R3 | **Addressed — original defect rationale withdrawn** | `invokeAgent` already calls `requireAmbientRunId` and assigns `params.run` before reaching the former preflight block. This is unchanged code, not a fix supplied by this revision. Omitting explicit `--run` did not establish a truly runless provider path: a run is resolved or invocation fails first. The original review overlooked that assignment, so its claimed bypass and native/invoke divergence were not substantiated. The moved check is acceptable, and the new initial/continued ambient-run tests verify refusal before provider/session creation and successful continuation after checklist repair, but they do not demonstrate an old-code failure. No additional runless invocation support or new gate is required. |
| R4 | **Addressed** | `evaluatePhaseChecklist` rejects zero items independently of `isComplete`, while retaining the historical display flag. Protocol and phase-finish tests cover a repairable COMPLETE gate list, refusal before author recording, completion after verification, and author guidance when no list exists. |

### Remaining concern — R2 (P1): comment terminators must remain authoritative inside comments

The new helper at `src/parsers/plan.ts:53–63` removes backtick spans from the entire line before scanning HTML comments. Backticks inside an HTML comment are literal comment text, not Markdown code delimiters. Pairing a backtick inside a comment with one after its closing `-->` can remove the actual terminator, leaving the filter incorrectly inside a comment and hiding subsequent executable requirements.

Concrete valid input:

````markdown
# Plan

## Phase 1: Work

<!-- Ignore this backtick: ` --> `visible code`

- [ ] Real requirement
````

The HTML comment ends at `-->`; the following `visible code` span and real checklist are outside it. An isolated in-memory comparison imported the previous parser directly from the recorded base Git blob: **previous parser: 1 item; revised parser: 0 items**. The revised plan-review gate returns `PLAN_REPAIR_REQUIRED`, claims requirements are missing, and supplies no mechanical repair command. This is introduced by the R2 fix, not an unrelated missed initial finding.

**Required mechanical correction:** Scan comment and inline-code states in lexical order. Once inside an HTML comment, recognize its terminator without interpreting backticks as code; only ignore comment-open syntax inside actual code spans outside comments. Keep the one shared filter and preserve the already-fixed inline-span, prose-opened-comment and quoted-opener cases. Add a regression proving this input remains executable and its actual list remains available to repair when the task marker is removed. This is remaining W2 work, with no new dependency, schema, subsystem, plan change or human policy choice.

### Local verification

Reviewer-run from `5x-cli/`:

```sh
bun test test/unit/commands/invoke.test.ts test/unit/commands/phase-finish.test.ts test/unit/commands/protocol-validate.test.ts test/unit/plan-schema/executability.test.ts test/integration/commands/plan-executability.test.ts test/integration/commands/plan-repair-checklists.test.ts
```

Result: **191 pass, 0 fail, 541 expectations**. A separate read-only `bun -e` probe compared previous/current parser behavior using the previous Git blob transpiled and imported in memory, and reproduced the remaining R2 gate failure without writing a fixture or touching product files.

Required focused asset acceptance rerun:

```sh
bun test test/integration/commands/upgrade.test.ts test/unit/skills/implementation-review-governance.test.ts
```

Result: **48 pass, 0 fail, 826 expectations**. No skeleton, prompt, skill, runtime-appended governance-context format, installer, override-resolution or harness-sync asset changed in this delta; the existing W5 asset allocation remains applicable. The runtime preflight movement preserves explicit/ambient identity and does not add an approval or synchronization requirement.

The orchestrator independently reports successful phase-finish quality/checklist; the author reports lint/typecheck and 4310 full-suite tests. Those remain supplied evidence, not reviewer-run checks.

### Updated readiness

- **R1, R3, R4:** Closed. R3 is explicitly corrected as an unsupported original bypass claim, not credited as a demonstrated defect fix.
- **R2:** Partial; the original examples are fixed, but the revision introduces a false structural refusal on a valid comment/code combination. Retain R2 once in the structured items with only this remaining work.
- **New finding IDs:** None. The remaining issue is causally within R2's revised literal-filter implementation.
- **Ready for next phase:** No — finish the small shared-filter correction and its regression coverage. Existing repair authority, evidence preservation and no-new-tripwires requirements remain unchanged; no operator decision or scope expansion is requested.
