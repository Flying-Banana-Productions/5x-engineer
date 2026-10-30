# Review: Plan 216 Phase 1 — Plan document projection

**Review type:** `4adb443b0d2e88a8e59106eb743b2b9454077e4f..9e40af03f6a52ad6cf4d5672cd726a8f35c1426a` (commit `9e40af03`)  
**Scope:** `src/plan-schema/document.ts`, the `normalizeCheckboxMarkers` move into `plan-markdown.ts` with its re-export from `plan-amendment.ts`, `test/unit/plan-schema/document.test.ts`, the phase 1 projection note, and the phase 1 checkbox toggles  
**Reviewer:** Staff engineer (correctness of the grammar and projection, offset contract, plan compliance, behavior preservation for existing callers)  
**Local verification:** `bunx --bun tsc --noEmit` clean. `bun run lint` clean (Biome 2.5.15, 455 files). Focused `bun test test/unit/plan-schema/ test/unit/review-governance/plan-amendment.test.ts`: 53 pass, 0 fail. Full `bun run test`: the first run had 3971 pass and 1 fail under `--dots`, which did not name the test. A rerun without `--dots` had 3972 pass and 0 fail. The new module is pure and has no shared state, so the one-off failure looks like an unrelated flake (see follow-ups). I also probed edge cases with a scratch script, and I compared `structuralSignature` before and after the commit in a temporary worktree at `4adb443b`.

**Implementation plan:** `5x-cli/docs/development/plans/216-plan-schema-contracts-and-migration-plan.md` (approved at `4018531a`)  
**Technical design:** N/A

## Summary

Phase 1 delivers the pure projection reader the plan specifies: the marker grammar, file, schema 0, and schema 1 modes, fence opacity, note validation, the one-blank splice, the space-filled mask, and the authority instruction constant. Nothing outside the module calls it yet. The tests cover every case in the W1 Tests row. I found one small behavior change outside the new module. `checkboxIdentity` in `plan-amendment.ts` now uses the global, multiline normalizer instead of the single-match regex. That changes the persisted `structuralSignature` for any line that contains a lone `\r` followed by a second checkbox. This contradicts the phase gate "No caller outside the new module changes behavior yet" and is a one-line fix.

**Readiness:** Ready with corrections. There is one P2 mechanical fix and no blocker.

---

## What shipped

- **Projection module** (`src/plan-schema/document.ts`): `loadPlanDocument`, the `PlanSchema`, `ExpectedPlanSchema`, `LoadedPlanDocument`, `PlanNoteSpan`, and error-code types as specified, `PLAN_SCHEMA_AUTHORITY_INSTRUCTION` with the exact Design Decisions paragraph, and `planDocumentByteOffset` and `planDocumentByteRange`, which measure the raw string.
- **Checkbox normalization move**: `normalizeCheckboxMarkers` and `CHECKBOX_MARKER_SOURCE` now live in `plan-markdown.ts`, unchanged. `plan-amendment.ts` re-exports the function, so `implementation-state.ts` and other importers keep working.
- **Tests** (`test/unit/plan-schema/document.test.ts`, 932 lines): schema 0 behavior, schema 1 projection, malformed declarations, note ids, fences, notes and the splice, and mask offsets.
- **Projection note** (`docs/development/216-phase-1-projection.md`): records the grammar decisions the plan left open and what is not wired yet.
- **Plan**: only the six phase 1 checkboxes changed.

---

## Strengths

- **The offset contract is enforced, not just documented.** `authorityMask` rebuilds the mask segment by segment from `splitRawLines` and throws if a gap appears or the length drifts. The non-ASCII status-line test checks both the UTF-16 offset and the raw-string byte conversion.
- **Schema 1 never falls back to schema 0.** Expected schema 1 with no declaration is `PLAN_SCHEMA_INVALID`. File mode returns schema 0 only when there is no declaration outside a fence. Expected schema 0 skips marker scanning entirely, as the plan requires.
- **The splice matches the plan exactly.** I probed notes directly after the contract start, notes directly before the contract end, adjacent notes, and CR-only line endings. In each case the result equals the no-note baseline whenever the plan's rule says it should. Two notes between the same paragraphs keep exactly one separator.
- **Fence handling reuses the `plan-markdown.ts` rules.** A fenced marker stays literal, and an unclosed fence hides later markers and fails closed.
- **The note's decisions are explicit.** Where the plan was silent (what counts as a reserved marker, declaration position, table-row definition, 1-based note lines), the projection note records the choice, so Phase 2 has a fixed reference.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

### P2.1 — `checkboxIdentity` changed behavior on lines that contain a lone `\r`

`structuralSignature` calls `checkboxIdentity(line.raw)` for each `\n`-split line. Before this commit it ran a single, non-multiline replace (`new RegExp(CHECKBOX_MARKER_SOURCE)`), which normalized only the checkbox at the start of the line. It now calls `normalizeCheckboxMarkers`, which uses the `gm` flags. With `m`, `^` also matches after a lone `\r`, so a later checkbox in the same `line.raw` is normalized too. `structuralSignature` is persisted on text guards (`record-lines.ts` `textGuard.structuralSignature`) and compared again at verification (`plan-amendment.ts:391`).

I confirmed this against the parent commit. For `"# T\n- [x] a\r- [x] b\n"`, `4adb443b` returns `sha256:5780f9b4…` and `9e40af03` returns `sha256:ab8c7fd2…`. So a guard snapshotted by the old binary on such a plan would now fail `PLAN_AMENDMENT_STRUCTURE`. In the other direction, toggling the second checkbox no longer changes the signature. Mixed line endings like this are rare, but the phase gate says no caller outside the new module changes behavior, and the plan says the move keeps "the regex and the replacement" the same.

**Requirement:** Restore the original single-match, non-multiline replace in `checkboxIdentity`. For example, export `CHECKBOX_MARKER_SOURCE` from `plan-markdown.ts` (or add a single-line helper there) and keep `line.replace(new RegExp(CHECKBOX_MARKER_SOURCE), "$1[ ]")`. Add a regression test showing that the signature of a line with an embedded lone `\r` matches the pre-move result.

---

## Nonblocking follow-ups

These are not author work for this phase.

- **Reserved-marker breadth (decide before Phase 2 wires file mode).** `classifyMarker` treats any standalone HTML comment whose body contains `5x:` anywhere as a reserved marker. In file mode, a harmless comment such as `<!-- generated by 5x: do not edit -->` in an unversioned plan becomes `PLAN_SCHEMA_INVALID` (I confirmed this with a probe). The plan says only "reserved `5x:` marker" and does not define the namespace. The projection note records the broad reading on purpose. Anchoring on `<!--\s*5x:` would still catch every malformed real marker and leave prose comments alone. That is a product choice for the operator or the Phase 2 author. It matters once `plan-v1.handler.ts` calls file mode on pre-approval plans. No such comment exists outside fences in this repository's plans.
- **Contract-edge notes need a pre-existing blank line.** Under the plan's block-boundary and splice rules, adding a note as the first or last block of a contract that has no blank line next to its marker forces a new governing blank line, which is drift. That follows the plan as written. The Phase 4 schema 1 skeleton should open and close the contract with blank lines, so authors can add edge notes without an amendment.
- **Separate tables around a note.** A note between two distinct tables that are separated by blank lines is rejected as "inside a table", because the plan's rule looks at the nearest non-blank governing lines. That matches the plan. The skill text in Phase 4 could mention it.
- **Unattributed full-suite flake.** One run of `bun run test` had a single failure that `--dots` output did not name, and a rerun was clean. It is unlikely to involve this pure module. Worth watching in CI.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [x] None

**P2**
- [ ] P2.1 — restore the single-match `checkboxIdentity` replace and add a lone-`\r` regression test

**Phase gate:** Unit tests pass for schema 0, valid schema 1, notes, fences, splices, and malformed declarations. Behavior outside the new module is unchanged except for P2.1. After P2.1 the phase is complete, and Phase 2 can start on the approved plan text.
