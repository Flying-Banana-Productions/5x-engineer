# Review: Plan 210 Phase 3 — Exact code-review context and convergence evidence

**Review type:** `aeeda329b0702c2242fa81d5d3d3f04c86cd6b5d`
**Scope:** Phase 3 (W3). This covers the new `src/review-governance/code-diff.ts`, pre-author capture and review-context preparation and verification in `implementation-state.ts`, render/invoke wiring in `template.handler.ts`, `invoke.handler.ts` and `template-vars.ts`, `--review-context` in `protocol validate`, closure certification in `validateImplementationReview`, and the new unit and integration tests.
**Reviewer:** Staff engineer (correctness, fail-closed semantics, plan compliance, test strategy)
**Local verification:** `bunx tsc --noEmit`: clean. `bun test test/unit/review-governance test/integration/code-review-diff.test.ts`: 121 pass, 0 fail. I also ran throwaway probes against `parseCodePatch` / `validateCodeHunkEvidence` and `validateImplementationReview` (see P1.2 and P1.3). The probes were deleted afterwards.

**Implementation plan:** `5x-cli/docs/development/plans/210-implementation-review-governance-plan.md`
**Technical design:** N/A

## Summary

The git evidence boundary is careful. Diff options and pathspecs are fixed, and external diff and textconv are disabled. Endpoints are full SHAs with ancestry checks, and dirty-tree, intervening-code and patch-hash drift checks all fail closed. Pre-author capture is idempotent and durable, and the legacy earliest-`git:commit` fallback follows the plan. The CLI integration has three correctness gaps:

- The recorded paths never supply prior findings. As a result, every continued enforced review that keeps an open prior finding is fatally rejected.
- An author render in a phase that already has commits stamps post-work HEAD as the "pre-author" base. The plan forbids exactly this.
- The hunk format the validator expects differs from what the rendered diff shows. Copying a hunk verbatim from the prompt is rejected, with a misleading `CODE_HUNK_WRONG_FILE`.

All three fixes follow from the plan and the existing code.

**Readiness:** Not ready. Three P1 correctness defects break the Phase 3 completion gate in the wired CLI paths. All are mechanical (`auto_fix`).

---

## What shipped

- **Code diff (`code-diff.ts`)**: pinned `git diff` options (`--full-index`, `--no-ext-diff`, `--no-textconv`, fixed prefixes, `--find-renames=50%`, `-c diff.external=`), literal-top exclusion pathspecs, EOL-preserving hunk parsing with rename/delete/binary/combined detection, exact hunk validation (range, wrong-file, whitespace, context-only, binary, combined), a bounded renderer with omitted headers and a retrieval command, and closure certification (`validateCodeReviewClosure`).
- **Durable context (`implementation-state.ts`)**: an `implementation:pre-author` step captured once per binding and phase. `prepareImplementationReviewContext` covers the initial base, legacy fallback, the reviewed end advancing only on non-excluded code, and continued base = previous context end. `verifyImplementationReviewContext` rejects cross-run/phase reuse, dirty trees, intervening code and patch drift.
- **Wiring**: template render and invoke capture pre-author HEAD on bound author admissions. They also prepare a context for commit-review templates and append the diff section. Invoke keeps the context id internally and re-verifies it before accepting the verdict. `protocol validate --review-context` verifies a native caller's context.
- **Tests**: unit tests using injected git and pure patches (identical hunks in two paths, renames, deletes, CRLF, truncation, assembled/stale/whitespace hunks, closure, critical-late, deferred re-raise), plus integration tests over real repos (multi-commit author session, idempotent capture, review-only commits, legacy fallback and missing-base failure, drift).

---

## Strengths

- Endpoint handling is strict. `resolveCodeCommit` requires a 40-hex SHA, `assertNoInterveningCode` rejects both non-descendant HEAD and later code changes, and the recomputed patch hash must match. Equivalent-end matching is not allowed, as the plan requires.
- Hunk identity includes the `diff --git` line, so identical bodies in two files hash differently. The integration test covers this.
- Review-document-only commits don't move the reviewed end, because `advanceReviewedCommit` only advances on non-excluded paths. Records, review directories and the exact plan file are excluded as root-relative literal pathspecs.
- The legacy fallback does what the plan says. It uses the earliest same-phase `git:commit` parent and rejects root, merge and non-ancestor bases. It never uses HEAD or the parent of the author-result commit.
- Critical-late items bypass only the hunk requirement, still need `lateDiscoveryEvidence`, and force `human_gate`. A deferred re-raise still has to meet diff causality.

---

## Production readiness blockers

None at P0. The P1 items below block the Phase 3 completion gate.

---

## High priority (P1)

### P1.1 — Late pre-author capture stamps post-work HEAD as the review base

`capturePhaseAuthorAdmission` (`implementation-state.ts`) only checks for an existing admission step. The template/invoke author paths call it on every bound author render, including `author-process-impl-review`. Consider a phase that already has `git:commit` or `author:*` commit steps but no admission. This happens with in-flight runs bound before this commit, or when first author work was recorded directly without a render. The next correction render records current HEAD, which already includes the author's work, as `preAuthorCommit`. Then `prepareImplementationReviewContext` prefers the admission over the legacy fallback. Earlier admitted commits are ancestors of that base, so the reviewer render fails permanently with `CODE_DIFF_NOT_ANCESTOR`. If HEAD equals the only phase commit, the range is empty and the reviewer sees "no code changes": a fail-open review of unreviewed work. The plan says: "a post-work direct author record must not stamp current HEAD as a fictional pre-author base".

**Requirement:** Only capture when the phase has no prior admitted commit (a same-phase `git:commit` or `author:*` step with a commit). Otherwise, skip capture so the legacy fallback applies. Add a regression test: commit steps first, then a correction render, then a reviewer render whose range starts at the earliest commit's parent.

### P1.2 — Continued enforced reviews are rejected because prior findings are never supplied

`validateImplementationReview` enables closure certification whenever `codeContext` is set. `protocol.handler.ts` and `invoke.handler.ts` always set it for bound phases (or set it to `null` for continued enforced reviews), but never pass `priorCodeFindings` or `priorCodeDecisions`. No production code references them. In `validateCodeReviewClosure`, `required` is therefore empty, so:

- every `priorFindings` outcome gets `PRIOR_FINDING_UNKNOWN`
- a still-open prior finding kept in `items` is treated as a new ordinary blocker, which needs a hunk from the *correction* range that it cannot have

Probe: enforced, `priorReviewCount: 1`, a prepared context, `priorFindings: [{id:"F1",status:"still_open"}]` and item `F1` → `valid:false, fatalCode:"PRIOR_FINDING_UNKNOWN"`. In advisory mode the same verdict produces spurious error diagnostics. This contradicts the closure checklist item and makes enforced mode unusable after round 1.

**Requirement:** Pass the open findings from the latest recorded same-phase reviewer step to `validateImplementationReview` as `priorCodeFindings`, in both `protocol validate` and invoke. Both paths already scan those steps to compute `priorReviewCount`. Carry decisions where they exist. Add a CLI-level test of a round-2 verdict with addressed and still-open outcomes in enforced mode.

### P1.3 — The required hunk format doesn't match the rendered diff

`parseCodePatch` stores a hunk as the `diff --git` line followed directly by the `@@` body. It drops the `index`, `---`, `+++`, mode, rename and similarity lines. The prompt shows the raw patch with those lines and only asks for "one exact file-qualified hunk from this range". Probe results on a single-file patch:

- citing the file block verbatim from the rendered diff → `CODE_HUNK_WRONG_FILE` ("the diff --git file header does not [match]"), which is false and misleading
- citing the stored hunk text without its trailing newline, which is typical once text passes through JSON `--item` → `CODE_HUNK_NOT_FOUND`

Plan-diff (`normalizeTransport`) tolerates transport trailing newlines. Code-diff has neither that tolerance nor documentation of the expected format. In enforced mode (see the fatal path above), this rejects the whole verdict, not just the item.

**Requirement:** Canonicalize cited evidence before matching. Drop extended-header lines between the `diff --git` line and the first `@@`, and tolerate a missing final line terminator, without otherwise relaxing whitespace. A verbatim block copied from the rendered diff should then match. Keep `WRONG_FILE` for a genuinely different `diff --git` line. Also state the accepted form in `formatCodeReviewDiff`, and add tests for verbatim copy and a missing trailing newline.

---

## Medium priority (P2)

- **Diff output isn't fully pinned**: `CODE_DIFF_OPTIONS` doesn't override `diff.algorithm`, `diff.indentHeuristic`, `diff.interHunkContext` or `diff.relative`. A user or repo config can change hunk shapes or paths, so patch hashes and hunks differ across machines or config changes. Add `--diff-algorithm=myers`, `--indent-heuristic`, `--inter-hunk-context=0` and `--no-relative`, or the matching `-c` overrides.
- **The retrieval command depends on the current directory**: the pathspec `.` is resolved from the shell's cwd. Git runs from `effectiveWorkingDirectory`, but the command handed to the reviewer carries no `-C`. Run from another directory, it returns a different patch than the recorded one. Prefix `-C <workdir>`, or use a root-anchored whole-tree pathspec.
- **Omitted-hunk detection matches on header text**: `formatCodeReviewDiff` finds each hunk's position with `findIndex(line.text === header)`. Identical `@@` headers in different files (a case the phase tests) resolve to the first occurrence, so truncated hunks can be left out of "Omitted hunk headers". Locate hunks by file-section offset instead.
- **Phase 4 carry-forward (note, not an item)**: the continued base is the latest *prepared* context's end, not the latest *recorded* observation's `reviewedCommit`. That's acceptable until observations exist. Phase 4 should switch to the observation so an abandoned render can't advance the base.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 Skip pre-author capture when the phase already has admitted commits, and add a regression test
- [ ] P1.2 Thread prior findings and decisions into closure validation in `protocol validate` and invoke, and add an enforced round-2 CLI test
- [ ] P1.3 Canonicalize cited hunks (extended headers, final newline), document the format in the prompt, and add tests

**Phase readiness:** ❌ Phase 4 builds its paired observation on this validator and context. Fix P1.1–P1.3 first.
