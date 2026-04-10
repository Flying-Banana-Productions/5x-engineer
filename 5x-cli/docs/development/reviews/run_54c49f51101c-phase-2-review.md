# Review: Phase 2 — Local overlay metadata (`LayeredConfigResult` + `computeLocalKeys`)

**Review type:** commit `5896cf100ea4b7a6bf6729f9b449ee0d24f58dc4`  
**Scope:** `5x-cli/` — Phase 2 of `docs/development/plans/020-config-ux-overhaul.md`  
**Reviewer:** Staff engineer (correctness, merge semantics, `localRaws` contract, tests)  
**Plan reference:** Phase 2 completion gate (`LayeredConfigResult` + `computeLocalKeys`)

**Local verification:** `bun test test/unit/config.test.ts test/unit/config-layering.test.ts test/unit/config-registry.test.ts` — PASS (88 tests)

---

## Summary

The commit implements Phase 2 as specified: `LayeredConfigResult` gains `localPaths` and `localRaws` (parallel arrays), `mergeLayeredLocalTomlIntoRaw` returns `{ merged, localPaths, localRaws }`, `resolveLayeredConfig` threads them through, and `computeLocalKeys` unions dotted keys from pre-merge local parses. Existing layering and config tests pass; new `computeLocalKeys` unit tests cover the checklist items (empty, single nested key, union across files).

**Merge behavior** is preserved relative to the pre-change logic: `deepMerge` still applies `rootOverlay.prepared` / `nearestOverlay.prepared` in the same order (root local, then nearest local when paths differ). **`localRaws`** correctly stores the **pre-`resolveRawConfigPaths`** table (`rawForKeys`), matching the plan’s “parsed (pre-merge) local overlay objects” requirement for `isLocal` membership — independent of path normalization applied during merge.

**Readiness:** Ready with minor follow-ups (optional test hardening, cosmetic guard simplification).

---

## Strengths

- **Clear split:** `prepareLocalTomlOverlay` returns both `prepared` (path-resolved, merge input) and `rawForKeys` (same parse reference before resolution), so merge correctness and provenance metadata stay decoupled.
- **Ordering:** `localPaths` and `localRaws` are appended in merge order (root local, then nearest local), matching the documented merge order in `mergeLayeredLocalTomlIntoRaw`.
- **Nearest skip:** When nearest `5x.toml.local` resolves to the same path as root local, the second overlay is skipped — `localPaths`/`localRaws` stay aligned with actual merges (no duplicate entries).
- **`computeLocalKeys`:** Recursive flattening treats nested plain objects as prefixes, arrays and scalars as leaves (arrays as a single dotted key), consistent with “set membership for `isLocal`” without merge semantics.
- **Plan checklist:** Phase 2 markdown items are marked complete and match the implementation shape (`localRaws` naming aligns with the checklist; the older design doc line that said `localRaw` is superseded by the Phase 2 block).

---

## Merge correctness

### What changed vs. what stayed the same

- Previously, `mergeLayeredLocalTomlIntoRaw` returned the merged object only. Now it returns the same merged object plus sidecar arrays.
- The **merge inputs** are still `rootOverlay.prepared` and `nearestOverlay.prepared` after `resolveRawConfigPaths` and `stripDb` handling for nearest — identical to the prior `prepareLocalTomlOverlay` return value used for `deepMerge`.
- **`loadConfig`** was updated to use `localOverlay.prepared` instead of a single nullable record; behavior for empty-file / missing-file branches matches the prior `null`/`Record` distinction.

### Guards on merge vs. metadata

The merge runs when `rootOverlay.prepared && rootOverlay.rawForKeys` (and similarly for nearest). On every successful parse of an existing file, `rawForKeys` is assigned the root table and `prepared` is always a `Record` — so the conjunct is logically equivalent to `rootOverlay.prepared != null` for valid files. No behavioral skew between merge and `localPaths`/`localRaws` pushes was found in review.

### `stripDb` (nearest local)

- **Merge:** `db` is stripped from `prepared` for nearest local (same as before).
- **`rawForKeys`:** Still the full parsed table, including `[db]` if present. **`computeLocalKeys`** will therefore include `db.*` keys when the user typed them in the nearest local file, even though merge ignores them. This matches the plan’s stated `isLocal` rule (“exists in any `5x.toml.local` file”), not “effective value changed by merge.” Phase 3 `config show` may need to present this carefully (e.g., user may see a local marker for `db` keys that are ignored in resolution); that is a product/UX nuance, not a Phase 2 contract violation.

---

## `localRaws` semantics

| Aspect | Assessment |
|--------|------------|
| **Pre-merge** | `rawForKeys` is captured after `parseToml` / `isRecord` and before `resolveRawConfigPaths` — correct for dotted-key membership. |
| **Parallel to `localPaths`** | One raw object per merged file, same index order as merge — satisfies “parallel array” and Phase 3 `files` list construction. |
| **Unknown keys** | Present in raw TOML and included in `flatten` for `computeLocalKeys` — appropriate for passthrough/plugin keys and future `isLocal` / unrecognized display. |
| **Empty file** | `5x.toml.local` parsing to `{}` yields a truthy `prepared` and `{}` in `localRaws`; merge is a no-op but the file is still listed — consistent with “file existed and was processed.” |

---

## Gaps / follow-ups (non-blocking)

### P2 — Layering tests do not assert `localPaths` / `localRaws`

Phase 2 asks that existing layering tests still pass (they do). Adding a few assertions in `test/unit/config-layering.test.ts` that fixtures with `5x.toml.local` produce non-empty `localPaths`/`localRaws` with matching lengths would lock the contract against accidental regressions without relying on Phase 3.

### P2 — Redundant `&& rawForKeys` in merge guards

Could be simplified to `if (rootOverlay.prepared)` (and same for nearest) once `prepareLocalTomlOverlay` invariants are trusted — purely cosmetic.

---

## Readiness checklist

**Phase 2 gate**

- [x] `LayeredConfigResult` extended with `localPaths` / `localRaws`
- [x] `mergeLayeredLocalTomlIntoRaw` return type and callers updated
- [x] `resolveLayeredConfig` threads metadata
- [x] `computeLocalKeys` implemented and tested (empty, nested record, union)
- [x] Existing `config` / `config-layering` tests pass

**Optional follow-ups**

- [ ] Layering unit tests: assert `localPaths`/`localRaws` shape on representative local-overlay cases
- [ ] Simplify merge guards if desired

---

## Verdict

Phase 2 is **implemented correctly** for the stated completion gate: merge order and inputs are unchanged, `localRaws` are true pre-merge parses suitable for `isLocal`, and `computeLocalKeys` behavior matches the “union of dotted keys, no merge” requirement.
