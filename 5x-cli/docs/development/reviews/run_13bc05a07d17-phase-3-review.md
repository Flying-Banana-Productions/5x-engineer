# Review: 208 Review Budget Advisory — Phase 3 (`reviewBudget` configuration)

**Review type:** `f6696196abad6c60602d4674107fadb643e87568`
**Scope:** `ReviewBudgetConfigSchema`, root `reviewBudget` key, unknown-key warning coverage, default TOML block, config/registry tests
**Reviewer:** Staff engineer (correctness, config layering, plan compliance, test strategy)
**Local verification:** `bun test test/unit/config.test.ts test/unit/config-v1.test.ts test/unit/config-registry.test.ts test/unit/providers/opencode.test.ts` — 149 pass, 0 fail; `bun test test/unit/commands/config.test.ts` — 54 pass, 0 fail; `bunx tsc --noEmit` — clean

**Implementation plan:** `docs/development/plans/208-review-budget-advisory-plan.md` (Phase 3)
**Technical design:** `docs/v2/206` §7 (referenced by the plan)

## Summary

Phase 3 adds the `[reviewBudget]` config table exactly as the plan specifies: the Zod schema matches §3.1 field for field (types, bounds, defaults, descriptions), the root key is registered, the default TOML block matches §3.2, and tests cover the completion gate. The implementation also goes one sensible step beyond the plan by validating nested `reviewBudget.*` keys in `warnUnknownConfigKeys`, consistent with how `db`, `records`, and `plans` are handled. One minor test-hardening gap remains.

**Readiness:** Ready with corrections — completion gate met; one P2 mechanical drift-guard test recommended.

---

## What shipped

- **Schema** (`src/config.ts`): `ReviewBudgetConfigSchema` next to `HarnessConfigSchema`; `reviewBudget: ReviewBudgetConfigSchema.default({})` on `FiveXConfigSchema`.
- **Unknown-key handling** (`src/config.ts`): `"reviewBudget"` in `KNOWN_ROOT_CONFIG_KEYS`; `allowedReviewBudget` nested-key set wired into `collect`.
- **Default TOML** (`src/templates/5x.default.toml`): `[reviewBudget]` block after `[db]`, `mode = "advisory"` live, thresholds commented with defaults.
- **Tests**: defaults from `parse({})`, rejection of `mode = "strict"` and negative percent, no-warning load of a `[reviewBudget]` table, `.local` overlay to `mode = "off"` preserving sibling keys, registry `reviewBudget.mode` enum/default/allowedValues, opencode provider fixture updated for the new required config shape.

---

## Strengths

- Schema is a verbatim match for plan §3.1; no invented knobs, no drifted bounds.
- Nested unknown-key validation follows the existing per-table pattern, so typos like `growthPercnt` warn instead of silently no-op'ing — good operability for a table made mostly of numeric thresholds.
- Overlay test asserts both the overridden key and an untouched sibling (`growthPercent = 40` survives), which actually proves `deepMerge` semantics rather than just replacement.
- No behavior wiring leaked into this phase; config is inert until Phase 6/7 as planned.
- Inferred `FiveXConfig["reviewBudget"]` is structurally identical to `ReviewBudgetConfig` in `src/review-budget/types.ts`, so later phases can pass it straight to the arithmetic module.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

### P2.1 — No drift guard between Zod defaults and `DEFAULT_REVIEW_BUDGET_CONFIG`

**Action:** `auto_fix`

Threshold defaults now live in two places: the Zod schema in `src/config.ts` and the frozen `DEFAULT_REVIEW_BUDGET_CONFIG` in `src/review-budget/types.ts` (used by the arithmetic tests). They agree today, but nothing fails if one is edited without the other, and the arithmetic suite would then be validating numbers production never uses.

**Requirement:** Add one assertion (e.g. in `test/unit/config-v1.test.ts`) that `FiveXConfigSchema.parse({}).reviewBudget` equals `{ mode: "advisory", ...DEFAULT_REVIEW_BUDGET_CONFIG }`. Optionally add a compile-time assignability check of `FiveXConfig["reviewBudget"]` to `ReviewBudgetConfig`.

---

## Notes (no action)

- Boundary rejections are tested only for `mode` and a negative `growthPercent`, which is what the plan's checklist asks for. Upper bounds (`> 100`, `absoluteGrowthPercent > 500`) and non-integer percents are untested; the schema is declarative enough that this is acceptable.
- README config reference does not yet mention `[reviewBudget]`; that is Phase 9 scope per the plan.
- "Update any snapshot of `5x config show` keys": `test/unit/commands/config.test.ts` does not enumerate the full key set and passes unchanged; the only full-shape fixture (`opencode.test.ts`) was updated.

---

## Plan compliance

| Completion-gate item | Status |
|---|---|
| `parse({})` → `mode === "advisory"` + §7 defaults | Met (`config-v1.test.ts`) |
| Layered overlay can set `mode = "off"` | Met (`config.test.ts`) |
| Invalid mode/percent fails Zod parse | Met |
| Registry lists dotted keys | Met (`config-registry.test.ts`) |
| `KNOWN_ROOT_CONFIG_KEYS` includes `reviewBudget` | Met, plus nested-key validation |

## Phase readiness

Phase 3 is complete. Phase 4 (record lines, `atomicAppendIfAllNew`, facade, v8 index) has no dependency on the P2 item and can proceed; P2.1 can be folded into this phase's fix pass or picked up alongside Phase 4.

---

## Addendum — Re-review at `309357cd7fbaeaf2750c13ea2ea09839424b7b12`

**Diff since last review:** one commit, `309357c` ("test: guard review budget defaults against drift"), touching only `test/unit/config-v1.test.ts` (plus the run's `steps.jsonl` ledger). No production source changed.

### Prior findings — disposition

| ID | Status | Notes |
|---|---|---|
| P2.1 — no drift guard between Zod defaults and `DEFAULT_REVIEW_BUDGET_CONFIG` | **Addressed** | `config-v1.test.ts`'s `"reviewBudget uses advisory defaults"` test now imports `DEFAULT_REVIEW_BUDGET_CONFIG` from `src/review-budget/types.ts` and asserts `FiveXConfigSchema.parse({}).reviewBudget` equals `{ mode: "advisory", ...DEFAULT_REVIEW_BUDGET_CONFIG }`, replacing the prior hand-copied literal. This is exactly the requested fix: the two default sources can no longer silently diverge — editing either the Zod schema or the frozen constant without updating the other now fails this test. |

### What changed

- `test/unit/config-v1.test.ts:7` — new import of `DEFAULT_REVIEW_BUDGET_CONFIG`.
- `test/unit/config-v1.test.ts:98–102` — the 10 hard-coded threshold fields are replaced with a spread of `DEFAULT_REVIEW_BUDGET_CONFIG` alongside the literal `mode: "advisory"` (correct, since `ReviewBudgetThresholds = Omit<ReviewBudgetConfig, "mode">` excludes `mode` from the frozen constant).

### Verification

- `bun test test/unit/config-v1.test.ts test/unit/config.test.ts test/unit/config-registry.test.ts test/unit/providers/opencode.test.ts test/unit/review-budget/types.test.ts` — 153 pass, 0 fail.
- `bunx tsc --noEmit` — clean.

### New issues

None. The change is minimal, test-only, and matches the requested fix precisely.

### Updated readiness

All P2 items from the prior review are resolved and no blockers exist. Phase 3 is complete and ready to proceed to Phase 4.

**Readiness:** Ready — no outstanding items.
