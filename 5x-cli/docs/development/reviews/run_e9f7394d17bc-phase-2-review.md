# Review: Plan 216 Phase 2 — Authority readers

**Review type:** `0fceb63ac4ab521fad6b515c6548985c49397082..1c0c3d9cbebc0aced7dd06d9a9614f797e5ad87f` (commits `487ea0a7`, `1c0c3d9c`)  
**Scope:** Governance-context range, excluding the plan, reviews, and run records. Covers `src/plan-schema/{authority,document}.ts`, drift, replay, bind, and admission in `implementation-state.ts`, span resolution in `implementation.ts`, projected guards in `plan-amendment.ts`, recovery, the boundary, the binding codec, the budget readers (`apply`, `ensure-baseline`, `plan-repair`), the command call sites (`plan-v1`, `protocol`, `phase`, `run-v1`, `template`, `invoke`, `implementation-review-context`), and the new tests.  
**Reviewer:** Staff engineer (correctness of schema 0 and schema 1 authority routing, fail-closed behavior, offset and span mapping, plan compliance, test coverage)  
**Local verification:** `bun run typecheck` clean. `bun run lint` clean (457 files). Focused suites (`implementation-state`, `plan-amendment`, `implementation-recovery`, `parsers`, `record-lines`, `plan-schema`): 175 pass, 0 fail. Full `bun run test`: 3994 pass, 0 fail.

**Implementation plan:** `5x-cli/docs/development/plans/216-plan-schema-contracts-and-migration-plan.md` (approved at `4018531a`), Phase 2, work items W1–W4 (this phase is W2)  
**Technical design:** N/A

## Summary

Phase 2 wires the projection reader into drift, replay, bind, admission, span resolution, text-amendment guards, frontier recovery, the binding codec, and the parser call sites the plan lists. The core governance path is correct. Schema 0 keeps raw checkbox-normalized drift and raw guards. Schema 1 compares `comparisonBytes`, maps raw spans into projection coordinates with fail-closed rules, verifies the budget table and structural signature on the projection, and keeps raw hashes as lineage identity. The unit tests cover every item in the phase gate.

I found one P1. `5x plan phases` and `5x plan list` read the active run's binding from the control-plane checkout. A worktree-mapped run keeps its records in its worktree, so these commands never see the binding and always use file mode. That defeats the plan's explicit rule for `plan phases` with a bound active run. I also found one P2: several no-binding readers treat a schema load failure as "no delivery budget", which silently routes a budgeted run to v1 behavior.

**Readiness:** Ready with corrections. Both items are mechanical fixes that follow patterns already in the codebase.

---

## What shipped

- **Authority helpers** (`src/plan-schema/authority.ts`): `readAuthoritativePlan`, which parses the mask and takes schema 1 version and status from the raw preamble; `readAuthoritativeBudget`; `planSchemaCommandMessage`, which adds the "not a legacy fallback" text and the `5x-plan-migration` skill name.
- **Projection extensions** (`document.ts`): `GoverningLineLocation` with raw byte, raw line-ending, and comparison byte offsets; `readPlanPreamble`; `authoritativePlan`; `governingLinesInLineRange`; `mapRawSpanToComparisonBytes`.
- **Drift and replay** (`implementation-state.ts`): `detectPlanDrift` takes `recordedSchema` and `governingHash`. Replay accepts one `plan-schema-migration` record, with full validation, and does not install an invalid target. Also adds `resolveRecordedPlanSchema`, `recordedPlanSchemaFromBinding`, `expectedSchemaForStore`, and `PLAN_DRIFT_RECOVERY_HELP`, which names `migrate-schema`, `5x-plan-migration`, and `recover-plan`.
- **Bind**: parses the approved blob in file mode, reads the ledger from the mask, and maps phases from the mask. A schema 1 approval stores `planSchema: 1` and `governingHash`. A schema 0 approval omits both.
- **Guards** (`plan-amendment.ts`): `prepareSchema1Guard` and `verifySchema1GuardedPlanBytes`. Protected ranges are found in mask character coordinates and converted to bytes with the raw string. The budget table and structural signature are computed on `comparisonBytes`. Fixed segments are matched on the projection. The guard still stores the raw anchor and raw anchor hash. The unchanged check in `verifyAuthorTextAmendment` compares `comparisonBytes`.
- **Spans** (`implementation.ts`): `resolvePlanImpactSpans` searches the mask and converts offsets to bytes using the raw `byteSource`.
- **Recovery**: on schema 1, the earlier-phase check compares `governingLines` within the mask's phase bounds. The ledgers are read from the mask.
- **Codec** (`record-lines.ts`): the four optional binding fields are encoded only when present. The decoder rejects `planSchema` values other than 0 or 1, and rejects schema 1 with a missing or empty `governingHash`.
- **Call sites**: every site in §2.2 now goes through the authority helpers. `evaluatePhaseChecklist` became async so it can resolve the run's expected schema, and `phase.handler.ts` awaits it.
- **Tests**: a shared schema 1 fixture with a non-ASCII status line, plus drift, bind, parser, budget, and signature agreement, projected guard, recovery, codec, and SQLite-index tests.

---

## Strengths

- **The span mapper fails closed in the right places.** `mapRawSpanToComparisonBytes` accepts a line ending only between two governing lines that are adjacent both in the raw file and in the projection. A span that crosses a spliced note, a blanked line, a partial CRLF, or the newline before a contract marker returns `OUT_OF_SPAN`. Checkbox normalization keeps line length, so the raw and comparison offsets stay in step.
- **Raw identity and projected comparison stay separate, as the plan requires.** Guards store `hashBytes(rawAnchor)`. `authorizedPlanBytes` is the committed raw blob. Replay hashes raw bytes. Only the comparisons switch to `comparisonBytes`.
- **Schema 1 drift does not fall back.** A current file, approved blob, or replayed target that fails `loadPlanDocument(…, 1)` is drift, and the reason carries the code and "not a legacy fallback". A `governingHash` mismatch is drift too. A migrated schema 0 binding is checked against the migration record's hash.
- **Replay already handles Phase 3 records** (one migration only, parent and before/after hash linkage, target-projection hash), so Phase 3 only needs to add the writer and store reader.
- **Test coverage maps to the gate.** One fixture shows `parsePlan`, `parseDeliveryBudget`, `structuralSignature`, and drift agreeing. Status-only blobs return `unchanged` with no record. Raw hashes are stored on span changes. A note in an earlier phase passes recovery on schema 1, and schema 0 still rejects raw edits.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — `plan phases` and `plan list` look up the active binding in the control-plane checkout, not the run's worktree

`expectedSchemaForPlanFile` (`src/commands/plan-v1.handler.ts`, added at lines 354–382) finds the active run and then builds its record store with `resolveRecordsRoot({ controlPlaneRoot: projectRoot, effectiveWorkdir: projectRoot })`. A worktree-mapped run writes its budget stream (and so its binding) under the worktree's records root, not the control-plane checkout's. This run is an example: `docs/development/runs/216-…/run_e9f7394d17bc` exists only under `.5x/worktrees/216-…-768a25/` and not under the control-plane root. `getImplementationBinding` therefore finds nothing (or throws, which is also caught), and `expectedSchemaForStore` returns `"file"`.

Plan §2.2 says: "When `active_run` has a binding, it parses with that binding's expected schema. Expected schema 1 with missing or malformed markers exits `PLAN_SCHEMA_INVALID` or `PLAN_SCHEMA_UNSUPPORTED`, names the skill `5x-plan-migration`, and does not return a partial phase list." With the current lookup, suppose a schema 1–bound worktree run has its `<!-- 5x:plan-schema:1 -->` line deleted. `plan phases` falls back to file mode, reads the file as schema 0, and returns phases, gates, and checklist items from the raw file, including headings inside notes or outside the contract. It should exit `PLAN_SCHEMA_INVALID`. `plan list` has the same problem for completion percentages. Nothing tests either command with a bound active run.

**Requirement:** Resolve the active run's records the way the other new call sites do. `runV1Relink` and `evaluatePhaseChecklist` both call `createReviewBudgetContext({ runId, startDir })`, which resolves the run's execution context and worktree records. Alternatively, pass `mapped?.worktreeRoot` or `worktreePath` as `effectiveWorkdir` to `resolveRecordsRoot`. Do not swallow a store read error into `"file"` when a binding may exist. Add a command-level test: a worktree-mapped active run with a schema 1 binding, whose current file is missing its declaration, must make `plan phases` exit `PLAN_SCHEMA_INVALID` and mention `5x-plan-migration`.

---

## Medium priority (P2)

### P2.1 — No-binding readers treat a schema load failure as "no delivery budget"

Several sites replaced `parseDeliveryBudget(raw)` with `readAuthoritativeBudget(…)` and then turned `!loaded.ok` into `null` or `undefined`:

- `enforceImplementationBoundary` (`run-v1.handler.ts` around line 3748) gets `parsed = null`, so `hasDeliveryBudget: false`.
- `authoritativeBudgetOk` (`runV1State` readiness) returns `false`.
- `templateRender` and `invokeAgent`, in the `RecordContextError` fallback, get `parsed = null`, so the `IMPLEMENTATION_APPROVAL_REQUIRED` refusal is skipped.

Take an unbound, budgeted run whose plan has a malformed reserved `5x:` marker, or a duplicate declaration, in file mode. Before this commit, the raw parse found the budget, and `evaluateImplementationBoundary` denied phase or run completion with `IMPLEMENTATION_APPROVAL_REQUIRED`. Now `hasDeliveryBudget` is false, the boundary takes the `v1` branch at `implementation-boundary.ts:325–329`, and it allows the run. The plan's rule is that a schema failure "is not a fallback to schema 0" and surfaces as `PLAN_SCHEMA_INVALID` or `PLAN_SCHEMA_UNSUPPORTED`. Here it is silently treated as "this run is not governed". The main admission path (`ensureImplementationAdmission`) does surface the error, so I rate this P2. A smaller case of the same problem: `expectedSchemaForStore` returns `"file"` when `getImplementationBinding` throws, so a corrupt or unreadable binding record makes `evaluatePhaseChecklist` and `relink` parse in file mode instead of failing.

**Requirement:** When `readAuthoritativeBudget` returns `ok: false` at these sites, surface the failure with `outputError(loaded.code, planSchemaCommandMessage(loaded))`, or return a deny with that code at the boundary, as `ensureImplementationAdmission`, `applyPlanReviewBudget`, and `ensurePlanReviewBaseline` already do. Have `expectedSchemaForStore` let a binding read error propagate (or return a typed error) instead of mapping it to `"file"`. Add a boundary test: an unbound, budgeted run with a malformed marker must not be allowed through `phase_complete`.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1: `plan phases` and `plan list` resolve the active run's binding from the run's worktree records. A command test covers a bound schema 1 run with a missing declaration.

**P2**
- [ ] P2.1: schema load failures in the boundary, readiness, template, and invoke budget reads surface `PLAN_SCHEMA_*` instead of becoming "no budget". Binding read errors are not mapped to file mode.

---

## Nonblocking follow-ups

- `planList` calls `expectedSchemaForPlanFile` once per plan. Each call does `listRuns(db, { limit: 10000 })` and builds a new record store, so the cost is O(plans × runs). Group runs once, using the `runsByPlanPath` map already built in `planList`.
- `planList` turns a schema failure into a thrown error that the per-plan `catch` downgrades to a warning, and the plan drops out of the listing. Showing it with an error status instead would be easier to diagnose. This is a UX choice, not a contract violation.
- `mapRawSpanToComparisonBytes` returns `{ start: 0, end: 0 }` for an empty span no matter where it sits. `resolvePlanImpactSpans` never produces empty spans today, but a span-independent sentinel (or rejecting empty spans) would be safer if insertion spans are ever added.

## Phase readiness

- **Phase 2 completion:** ⚠️ The core authority wiring, guards, recovery, and codec meet the gate. P1.1 leaves the `plan phases` active-binding rule unimplemented for worktree runs.
- **Ready for Phase 3:** ✅ after P1.1 and P2.1. Both are mechanical. Replay already accepts the migration kind that Phase 3 will write.

---

## Addendum (2026-10-30) — Closure review of `a519e581`

**Reviewed:** `1c0c3d9c..a519e581` (review context `b131a273`)  
**Local verification:** `bun run typecheck` and `bun run lint` clean. Focused run of `test/integration/commands/plan-v1.test.ts`, `test/unit/commands`, and `test/unit/review-governance`: 1015 pass, 0 fail.

### What's addressed (✅)
- **P1.1 — addressed.** `expectedSchemaForPlanFile` now calls `createReviewBudgetContext({ runId, startDir, dbContext })`, which resolves the run's mapped-worktree records. `expectedSchemaForStore` no longer maps binding read errors to `"file"`. `planPhases` fails closed through `failPlanSchemaIdentity`, which outputs the `RecordContextError` code or a typed `IMPLEMENTATION_BINDING_UNREADABLE`. A new integration test in `plan-v1.test.ts` covers the bound-worktree case.
- **P2.1 — addressed.** The boundary read (`readBoundaryBudget`), the readiness read (`authoritativeBudgetOk`), the template and invoke fallbacks, `runV1Relink`, and `evaluatePhaseChecklist` now surface `PLAN_SCHEMA_*` or `IMPLEMENTATION_BINDING_UNREADABLE` instead of treating a failure as "no budget". The two `runV1State` catch blocks rethrow `CliError` so the failure is not downgraded to a warning. Tests were added in `run-v1.handler.test.ts`, `invoke.test.ts`, `template-handler.test.ts`, and `implementation-state.test.ts`.

### Remaining concerns
- None blocking. The O(plans × runs) lookup in `planList` from the earlier follow-ups remains, and is not blocking.

### Updated readiness
- **Phase 2 completion:** ✅
- **Ready for next phase:** ✅
