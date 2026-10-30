# Plan 216 Phase 0 seam verification

**Inspected commit:** `f06078cf03895915f5c02bf84741741d11f209b1`
**Plan:** `5x-cli/docs/development/plans/216-plan-schema-contracts-and-migration-plan.md`
**Run:** `run_e9f7394d17bc`

Phase 0 confirms the seams this plan cites. No product code, tests, or plan prose changed. The note is in this file so the schema 0 plan keeps its status, line references, and structure, and only the phase 0 checkboxes change.

## Result

Every phase 0 confirmation holds at the inspected commit. Plan 215's `amend` command has not landed, and `listImplementationTextAmendments` is still the lineage reader. No cited module has moved, so the Files Touched count stays 42. Phase 1 can use the approved obligations as written.

## Plan 215 contingency

Plan 215 is present as an approved document (`215-implementation-plan-amendment-plan.md`, status approved for a separate implementation branch). This tree does not contain `5x review implementation amend`, an `implementation-plan-amendment` record kind, or a replacement lineage reader. `src/commands/review.ts` still registers `recover-plan` at lines 237–282 and does not register `amend`. Phase 3 folds `plan-schema-migration` into `listImplementationTextAmendments` (`src/control-plane/review-budget-store.ts`, lines 472–495), which already skips every other budget kind. That is the reader the plan already names. No second chain is required.

## Checklist

### Overview symbols still match

| Citation | Present behavior |
|---|---|
| `detectPlanDrift`, `implementation-state.ts` 192–216 | Compares checkbox-normalized current bytes with the replayed amendment chain. The only ignored difference is checkbox state. |
| `normalizeCheckboxMarkers`, `plan-amendment.ts` 172–180 | The marker regex is line 172. The function at lines 178–180 collapses `[ ]`, `[x]`, and `[X]` without changing length. `detectPlanDrift` calls it through `normalizeCheckboxState` (lines 121–123 and 203–204). |
| Admission `IMPLEMENTATION_PLAN_DRIFT`, lines 634–647 | Returned when the amendment list fails to load or `detectPlanDrift` reports drift. Line 645 still names `5x review implementation recover-plan --help`. |
| Bind comparison, lines 1094–1108 | `detectPlanDrift` against the approved blob with an empty amendment list, before the binding payload is built. |
| `parsePlan`, `src/parsers/plan.ts` line 34 | Reads the whole Markdown string. The parser has no fence skip. |
| `parseDeliveryBudget`, `src/parsers/delivery-budget.ts` line 438 | Reads the whole Markdown string. |
| Raw parser call sites | `plan-v1.handler.ts` 398, `protocol.handler.ts` 298, and `run-v1.handler.ts` 1605, 2789, 3060, 3722, and 4620 still call those parsers on the file or archived Markdown. |
| `resolvePlanImpactSpans`, `implementation.ts` line 192 | Still the raw span resolver. |
| `ImplementationBindingPayload`, `record-lines.ts` 281–303 | Stores `approvedPlanHash` and `approvedPlanBytes`. No schema field. |
| `IMPLEMENTATION_STATE_VERSION`, `record-lines.ts` line 23 | Still `1`. |
| `hashPlanBytes`, `implementation-state.ts` 100–102 | Still the single SHA-256 helper. |
| `fixedSegmentsMatch`, `plan-amendment.ts` line 242 | Still the raw fixed-segment comparison. |
| `atomicAppendIfAllNew`, `record-fs.ts` 747–860 | The method starts at 747. The `expectedKeys` mismatch throws `RECORD_PRECONDITION_FAILED` at line 857, inside the cited range. |
| `recover-plan` expected keys, `implementation-recovery.ts` 422–437 | Passes the current steps, budget, and decisions key lists. The exact worktree match is the inequality at line 168. |
| `appendPlanReviewPromptContext`, `context.ts` 134–142 | Appends diff and governance text. It does not yet append an authority paragraph. |
| Native and invoke calls | `template.handler.ts` line 666 and `invoke.handler.ts` line 854. |
| Override directory | `template.handler.ts` lines 206–207 and 277–278 set `join(controlPlaneRoot, stateDir, "templates", "prompts")`. `invoke.handler.ts` lines 313 and 417–424 use the same join. `projectRoot` in the template handler is `controlPlane.controlPlaneRoot`. |
| `getTemplateSource`, `loader.ts` 109–113 | The override branch returns `"override"` at line 113. The function continues through the bundled return at line 116. |
| `DEFAULT_IMPLEMENTATION_PLAN_TEMPLATE`, `default-artifacts.ts` line 1 | No contract markers. |
| Author checkbox rules | `author-next-phase.md` line 37 allows checkbox toggles and forbids structural amendments. `author-process-impl-review.md` lines 43–44 allow checklist marks and forbid structural plan edits. |
| `BASE_SKILL_TEMPLATES`, `skills/loader.ts` lines 20–26 | The registration object is still here. `5x-plan-migration` is not registered yet. |
| Later-phase call sites that the completion gate also covers | `detectPlanDrift` callers are `implementation.ts` 911, `implementation-boundary.ts` 343, `implementation-recovery.ts` 256, and `implementation-review-context.ts` 531. Span resolution is `implementation.ts` 926. Guard preparation is `implementation-review-context.ts` 550. The unchanged check is `implementation-state.ts` 1423–1434. The earlier-phase raw comparison is `implementation-recovery.ts` 299–320. Bind is still `implementation-state.ts` 1066–1120. The binding decoder is `record-lines.ts` 442–512. `loadTemplate`'s override version warning is `loader.ts` 329–336. |

No symbol in that table has moved to another file.

### Decoder, omitted schema, and unknown budget kinds

`decodeImplementationBindingPayload` copies the known fields and does not call `rejectUnknownKeys`. A historical payload with no `planSchema`, plus an extra `unexpectedFutureField`, decoded at version 1. The returned object has neither extra field. `approvedPlanBytes` was preserved.

`listImplementationTextAmendments` (lines 472–495) keeps only `implementation-plan-recovery` and `implementation-text-amendment`. A budget line whose kind was `plan-schema-migration`, and another whose kind was `future-budget-kind`, were both absent from the returned list.

The SQLite index (`sqlite-index.ts` lines 255–259) continues unless `kind` is `implementation-binding` or `implementation-review`. Unknown budget kinds are not decoded there.

### Completed-run `schema-migration` step

Phase 3 writes the step with `atomicAppendIfAllNew`, not through `prepareRecordStepAppend`. The record store does not read run status. `prepareRecordStepAppend` (`run-v1.handler.ts` line 3129) still rejects a run whose status is not `active`. That CLI path is not the Phase 3 writer, and the store path does not need a different lock: `atomicAppendIfAllNew` is the same per-run writer lock recover-plan already uses.

A memory-store run was sealed with `status: "completed"`, a `final_head_commit`, a plan reviewer step, a following `human:review-governance` step, an accepted `adjust_baseline` decision, and `run:complete`. Appending `step_name: "schema-migration"`, `phase: null`, `iteration: 0` after `run:complete` succeeded. The run summary stayed `completed`, and `sealed_at` and `final_head_commit` were unchanged.

`foldGoverningReviewState` was equal before and after that append. The accepted decision stayed in `history` and the governing baseline stayed 8. The new step is outside the reviewer-to-human window `classifyDecisionAcceptance` uses, and it is not a `reviewer:` step.

`terminalRoute` (`implementation-state.ts` lines 832–954) builds its reviewer list only from steps whose `phase` is `"plan"` and whose `step_name` starts with `"reviewer:"` (lines 842–843). `authorCommitAfter` (lines 956–978) ignores every step that is not `phase === "plan"` and `author:`. A `schema-migration` step matches neither filter, so it does not change the selected reviewer, the final-correction author scan, or the route. The same step list, filtered with those predicates, still contained only the original `reviewer:plan` step and no author step.

`resolveFinalizedPlanCommit` (lines 807–830) reads `summary.status` and `summary.final_head_commit`, then selects the last step named `run:complete` (line 820). The appended step does not have that name, and the summary fields did not change, so the finalized commit stayed the original `run:complete` head.

## File count

The Files Touched table has 42 rows. Every existing path in that table is still at the cited location. The new modules (`src/plan-schema/document.ts`, `src/review-governance/plan-markdown.ts`, `src/review-governance/schema-migration.ts`, `src/commands/plan-migrate.handler.ts`, and `src/skills/base/5x-plan-migration/SKILL.tmpl.md`) are not present yet. No lock, stream, or `IMPLEMENTATION_STATE_VERSION` bump is required by these seams. The surface snapshot stays at 42 production files.

## Quality baseline

Phase 0 quality gates failed on tooling, not on a seam. `bun run lint` is `bunx --bun @biomejs/biome check src/ test/` with no dependency pin. That resolved Biome 2.6.4, which checks Markdown that 2.5.15 does not: 26 format errors in unchanged harness, skill, and template assets, plus `useMathMinMax` warnings. Biome 2.5.15 checks the same `src/` and `test/` trees with no diagnostics (453 files). It is now an exact devDependency, and `bunx` resolves that installed copy.

`bun test` still killed one test at 5000ms under the full concurrent suite (`protocol-validate.test.ts`, "both entry points persist the same observation and durable authorization"). A 6000ms probe in this tree also died at 5000ms while `bunfig.toml` said `timeout = 15000`. Bun 1.4 does not read that key. The isolated file had already passed. The `test` script now passes `--timeout 15000`, which is the budget the config already recorded. The rerun was `bun run lint` clean, `bun run typecheck` clean, and `bun run test` 3931 pass / 0 fail. No product source or plan prose changed for this repair.
