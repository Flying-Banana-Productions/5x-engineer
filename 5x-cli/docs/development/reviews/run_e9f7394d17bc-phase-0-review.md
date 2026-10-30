# Review: Plan 216 Phase 0 — Confirm the seams

**Review type:** `f06078cf03895915f5c02bf84741741d11f209b1..d28466a331d9e8d55a5fe83abda1ca084bc0097d` (commits `9b73d18d`, `d28466a3`)  
**Scope:** Phase 0 seam verification note, Phase 0 checkboxes, and the operator-authorized quality-baseline tooling repair (Biome pin, test timeout)  
**Reviewer:** Staff engineer (correctness of the seam evidence, plan compliance, tooling and CI operability)  
**Local verification:** `bun install --frozen-lockfile` no changes; `bun run lint` clean (Biome 2.5.15, 453 files); `bun run typecheck` clean; `bun run test` 3931 pass, 0 fail. A temporary probe confirmed that Bun 1.4.4 ignores `[test].timeout` in `bunfig.toml`: a 6000ms test fails at 5000ms without the flag and passes with `--timeout 15000`.

**Implementation plan:** `5x-cli/docs/development/plans/216-plan-schema-contracts-and-migration-plan.md` (approved at `4018531a`)  
**Technical design:** N/A

## Summary

Phase 0 delivers what the plan asks for: a short note that cites the inspected commit and confirms every Overview line reference, the plan 215 contingency, the decoder and SQLite tolerance of unknown data, the shared prompt append and override directory, and the completed-run `schema-migration` step shape. I re-checked each citation against `f06078cf` and found no moved symbol and no wrong claim. The tooling commit is a small, documented repair that the operator authorized at the `human:gate` step. It adds no product behavior. Phase 1 can start on the approved plan text.

**Readiness:** Ready — the gate evidence is accurate and complete, there are no blockers, and the tooling repair stays inside the operator's authorization.

---

## What shipped

- **Seam verification note** (`5x-cli/docs/development/216-phase-0-seam-verification.md`): names the inspected commit, the plan 215 result, a symbol table for every Overview citation, the decoder, budget-kind and SQLite results, the completed-run step analysis, the file count, and the quality baseline.
- **Plan checkboxes**: only the five Phase 0 checkboxes changed. No other plan bytes changed, so drift is still checkbox-only.
- **Tooling repair** (`d28466a3`): an exact `@biomejs/biome` 2.5.15 devDependency with a lockfile entry. The `test` script now passes `--timeout 15000`. CI runs `bun run test`. `bunfig.toml` and `AGENTS.md` explain why.

---

## Strengths

- **Every citation checked out.** I confirmed these at `f06078cf`: `detectPlanDrift` 192–216, `normalizeCheckboxMarkers` 172–180, admission 634–647 with `recover-plan --help` at 645, bind 1094–1108, `hashPlanBytes` 100–102, `fixedSegmentsMatch` 242, `ImplementationBindingPayload` 281–303, `IMPLEMENTATION_STATE_VERSION` at 23, `listImplementationTextAmendments` 472–495, SQLite index 255–259, `atomicAppendIfAllNew` 747 with the `RECORD_PRECONDITION_FAILED` throw at 856–857, `recover-plan` expected keys 422–437, `appendPlanReviewPromptContext` 134–142 and its call sites (`template.handler.ts:666`, `invoke.handler.ts:854`), both override-directory joins, `getTemplateSource`, `BASE_SKILL_TEMPLATES`, the author template lines, and the raw parser call sites.
- **The completed-run analysis rests on the real predicates.** `terminalRoute` filters reviewers on `phase === "plan"` and `reviewer:`. `authorCommitAfter` filters on `phase === "plan"` and `author:`, including the `steps.length` scan in the `final_corrections` branch. `resolveFinalizedPlanCommit` selects only `run:complete`. A `phase: null` `schema-migration` step matches none of them, so the Phase 3 shape is safe.
- **The plan 215 contingency is settled with evidence.** `amend` is not registered, and there is no `implementation-plan-amendment` kind. `listImplementationTextAmendments` stays the single lineage reader.
- **The tooling repair is minimal and explained.** The pin matches the version that already passes. `bunx --bun` resolves the installed copy. The `bunfig.toml` comment names the Bun issue, so nobody "fixes" the dead key back.
- **Plan prose, status, and structure are unchanged.** That keeps the approved bytes valid for Phase 1 admission.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

None that require author work in this phase. See the nonblocking follow-ups.

---

## Nonblocking follow-ups

- **Subset test commands still use Bun's 5000ms default.** `AGENTS.md` still lists `bun test test/unit/`, `bun test test/integration/`, and `bun test --concurrent` without `--timeout 15000`. Those commands were never covered by the `bunfig.toml` key either, so this is not a regression. Someone running the integration subset by hand can hit the same 5000ms kill. A later docs pass could add the flag to those lines.
- **The 15000ms budget is now stated twice.** It appears in the `package.json` script and in the inert `bunfig.toml` key. The comment explains the duplication, but the two can drift. Drop the key or keep the two in sync once Bun reads it.
- **`@types/bun` is still `latest`.** This predates this range. It is the same unpinned-tool risk that the Biome pin just fixed for lint.
- **The Phase 0 probes are not committed as tests.** The completion gate asks only for a note, so this is not a gap. Phase 3 should still add the completed-run `schema-migration` invariants (route, finalized commit, governing fold unchanged) as regression tests next to the writer.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [x] None

---

## Local verification

- `bun install --frozen-lockfile`: no changes. The lockfile matches `package.json`.
- `bun run lint`: `Checked 453 files ... No fixes applied.`
- `bun run typecheck`: clean.
- `bun run test`: 3931 pass, 0 fail across 255 files (190.20s), exit 0. This matches the count in the note.
