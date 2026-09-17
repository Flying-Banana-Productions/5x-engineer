# Review: Plan 208 Phase 2 — Delivery Budget parser

**Review type:** `b6f6a448e2d808a137011c28d35b98f98e47cff9`  
**Scope:** `src/parsers/delivery-budget.ts` (new), `test/unit/parsers/delivery-budget.test.ts` (new), two `parsePlan` regression cases in `test/unit/parsers/plan.test.ts`, plan checkbox updates  
**Reviewer:** Staff engineer (correctness, fail-closed parsing, test strategy, plan compliance)  
**Local verification:** `bun test test/unit/parsers` — 44 pass / 0 fail; `bunx tsc --noEmit` — clean; `bunx biome check` on touched files — clean. Additional ad-hoc probe script exercised trailing subsections, fenced examples, `-0`, and CRLF input.

**Implementation plan:** `docs/development/plans/208-review-budget-advisory-plan.md` (Phase 2)  
**Technical design:** N/A

## Summary

Phase 2 delivers a standalone, pure `parseDeliveryBudget` with the exact diagnostic-code union from the plan, the 1:1 table-row ↔ `#### DCn` evidence join, and the two helpers. It is independent of `parsePlan` as required, every diagnostic code has a fixture, and the round-trip `debtClaim` assertion matches the plan verbatim. The main gap is that bullet lookups are not scoped to their own subsection: a later `###` subsection inside `## Delivery Budget` silently overrides Surface Snapshot values, which contradicts the phase's "parser failures are explicit" posture because this data becomes an immutable baseline in Phase 7.

**Readiness:** Ready with corrections — one mechanical P1 scoping fix plus P2 hardening/tests; no design decisions outstanding.

---

## What shipped

- **Parser**: `parseDeliveryBudget` returning `{ ok, value } | { ok: false, code, message, line }`; validates confidence, seven-column GFM table, `W<n>` ids, effort/architecture sets via Phase 1 guards, debt-claim cell grammar, Debt Claims subsection ordering, per-claim evidence bullets, Addresses tokens, and Surface Snapshot (including the split-alias sum).
- **Helpers**: `incorporatedFindingIds`, `rawDeliveryBudgetSection` (CRLF-tolerant, trims trailing inter-section whitespace).
- **Tests**: 15 parser cases covering the happy path and all 19 diagnostic codes; two `parsePlan` regressions (budget before Phase 1 / after last phase).

---

## Strengths

- Result-typed, non-throwing API; no path defaults a missing section or empty table to `B0 = 0`.
- Every failure carries a line number and, where relevant, the allowed value set (`{1, 2, 3, 5, 8}`, `{0, ±1, ±2, ±3, ±5}`) — asserted generically by the `expectFailure` helper.
- Join rules are strict in both directions (orphan block, missing block, duplicate table id, duplicate block) and a negative row can never yield `debtClaim: null` on an `ok` result — verified by tracing all exits.
- Reuses Phase 1 type guards rather than re-encoding the scales; no dependency on `src/protocol.ts` or `parsePlan`.
- Fixtures are derived from one canonical document via `replaceOnce`, which asserts the needle exists, so fixtures cannot silently stop mutating.

---

## Production readiness blockers

None.

---

## High priority (P1)

### P1.1 — Bullet lookups are not bounded to their own subsection (silent wrong baseline data)

`parseSnapshot` reads `lines.slice(headingIndex + 1)` to the end of the `##` section and uses a last-wins `Map`. Any later `###` subsection inside Delivery Budget is therefore treated as snapshot content. Verified: appending

```markdown
### Notes

- Subsystems: 99
```

after the snapshot returns `ok: true` with `surface.subsystems === 99`. The same class of issue exists in two other places:

- `findBullet(lines, "estimate confidence")` scans the entire section, so a confidence bullet that appears only inside a Debt Claims block or after the snapshot is accepted.
- The last `#### DCn` block runs to `debtEnd` (the Surface Snapshot heading); an intervening `###` heading does not terminate it.

Surface and confidence are authoritative record fields on the immutable baseline line (Phase 7), so silent mis-attribution is worse than an explicit failure.

**Recommendation:** Terminate each scoped region at the next heading: snapshot lines stop at the next `#{1,6}` heading; each claim block stops at the next heading of level ≤ 4; the confidence bullet is searched only in the preamble between `## Delivery Budget` and the table (or first `###`). Treat a repeated required snapshot label inside the snapshot as `BUDGET_SNAPSHOT_INVALID` rather than last-wins. Add a fixture for each (trailing `### Notes` must not change `surface`; confidence inside a DC block → `BUDGET_INVALID_CONFIDENCE`).

---

## Medium priority (P2)

- **P2.1 — Section location is not code-fence aware.** `sectionLines` / `rawDeliveryBudgetSection` take the first `## Delivery Budget` line even inside a fenced block. A plan that documents the format before its real section (plan 208 itself does this) parses the *example*: with a partial example it fails closed (`BUDGET_TABLE_MISSING`, verified), but a complete fenced example would be captured as the baseline. Likewise a `# comment` line inside a fence within the section truncates it. Skip fenced regions when locating the heading and the section end, in both functions, and add a fixture. (`parsePlan` is not fence-aware either, but it does not feed an immutable record.)
- **P2.2 — Test gaps against stated rules.** Add cases for: `adjacent` / `unrelated` coupling parse successfully (plan rule 2.1 calls this out explicitly); `Minimal-compliant effort delta: 0` accepted; CRLF input for both `parseDeliveryBudget` and `rawDeliveryBudgetSection`; budget section at EOF with no following `##`; invalid Addresses token characters (only the empty-token case is covered); missing `Target phase` bullet reports the block heading line. Also remove the duplicated `BUDGET_INVALID_EFFORT` assertion in "validates effort and architecture allowed sets" (the first call is a copy of the second).
- **P2.3 — `-0` accepted as a numeric cell.** `parseInteger("-0")` yields `-0`, which passes `isArchitectureDelta` and the snapshot `value < 0` check and lands in the ledger as `-0` (JSON-serializes to `0`, but `toEqual`/`Object.is` comparisons in later slices would differ). Normalize with `parsed === 0 ? 0 : parsed` in `parseInteger`.
- **P2.4 — Dead branch.** The `headingIndex < 0` branch in `parseSnapshot` is unreachable because `parseDeliveryBudget` already returns `BUDGET_SNAPSHOT_MISSING` when `surfaceHeadingIndex <= firstTableIndex + 1`. Remove it or drop the caller guard's `-1` coverage; keep one source of the diagnostic.

**Observations (no action required):**

- `isNumericPhaseRef` is re-implemented locally and is stricter than `src/commands/protocol.handler.ts:131` (rejects `"Phase 2: Title"` and `"## Phase 2"`). Given a parser must not import a command handler, and the plan's accepted examples all pass, the local copy is the right layering call; a one-line comment pointing at the shared definition would help future readers.
- Table cells containing `|` (escaped or inside inline code) fail as `BUDGET_TABLE_MALFORMED` "exactly seven cells". Fail-closed and acceptable; worth a sentence in the Phase 9 author-facing docs.
- `New persistent schemas` is parsed as an extra optional bullet beyond the plan's rule text; it matches the Phase 1 `SurfaceSnapshot` type, so this is consistent.

---

## Readiness checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] P1.1 — Bound snapshot, claim-block, and confidence bullet lookups to their own subsection; add fixtures

**P2**
- [ ] P2.1 — Fence-aware section location in `sectionLines` and `rawDeliveryBudgetSection`
- [ ] P2.2 — Fill test gaps; remove duplicate assertion
- [ ] P2.3 — Normalize `-0`
- [ ] P2.4 — Remove unreachable `parseSnapshot` branch

**Phase readiness:** Completion gate (happy path with debt evidence, every diagnostic code, `parsePlan` unchanged for both placements) is met. Phase 3 (`reviewBudget` config) does not depend on the parser, so it can proceed once the mechanical corrections above land; P1.1 must be fixed before Phase 7 consumes the parser for baseline capture.
