# Review: Phase 5 — `config add` / `config remove`

**Review type:** `b18f19950deaa400c6ea1d6380269b46ba61ed57`
**Scope:** Phase 5 of `docs/development/plans/020-config-ux-overhaul.md` — array add/remove, parity with Phase 4 write guards and target resolution
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/commands/config.test.ts test/integration/commands/config.test.ts` — 58 pass, 0 fail

## Summary

Commit `b18f199` implements `5x config add` and `5x config remove` with the same contract as Phase 4: `resolveTargetConfigPath()` for `--context` / `--local`, `assertWritableSource()` for JS/MJS fail-fast with `5x upgrade` guidance, and root-only `db.*` checks. Array keys are validated via `resolveWritableArrayConfigKey()` (exact registry key, must be an array type; rejects unknown keys and record descendants with actionable messages). Add is idempotent on duplicate values; remove no-ops when the file, key, or value is absent; removing the last array element removes the key and prunes tables, deleting the file when the document becomes empty.

`liftKeysMisnestedUnderPaths()` addresses a real TOML edge case (keys accidentally parsed under `[paths]`) and is applied consistently on read paths for `set`, `unset`, `add`, and `remove`, which keeps dotted-key helpers and array reads aligned with the schema.

**Readiness:** Ready — Phase 5 completion gate is met; unit and integration coverage match the plan’s Phase 5 matrix.

## Strengths

- **Parity with Phase 4:** Same resolution (`resolveTargetConfigPath`), active-source detection, `discoverConfigFile` / `assertWritableSource` pattern, and `db` root-only guard as `set`/`unset`.
- **Array-only validation:** `resolveWritableArrayConfigKey` enforces an exact registry key whose metadata type ends with `[]`; non-array keys get a pointer to `config set`; record descendants are explicitly rejected for add/remove (arrays are not dotted record entries in this schema).
- **JS/MJS:** Add and remove reject before any TOML write; integration tests assert non-zero exit, JSON error envelope mentions `5x upgrade`, and add does not create `5x.toml`.
- **Idempotence and remove semantics:** Duplicate add is a successful noop; remove missing value/key/file is a noop; last-value remove drops the key and can delete an otherwise-empty file (matches “optionally remove the key” in the plan).
- **`liftKeysMisnestedUnderPaths`:** Documented, scoped to known `[paths]` children vs schema, avoids mis-parsed `qualityGates` (and similar) living under `paths` after patching.

## Production Readiness Blockers

None identified for Phase 5 scope.

## High Priority (P1)

None required for merge; behavior is covered by tests.

## Medium Priority (P2)

- **Future array keys:** If the Zod schema gains additional top-level `string[]` keys (or nested array keys), `resolveWritableArrayConfigKey` today only matches exact registry keys. That matches current needs (`qualityGates`); extend the resolver if nested array keys appear later.
- **Direct test for `liftKeysMisnestedUnderPaths`:** Behavior is indirectly exercised via real TOML round-trips; a focused unit fixture for a mis-nested `qualityGates` under `[paths]` would lock the regression explicitly (optional).

## Readiness Checklist

**P0 blockers**

- [x] Array-only validation (exact registry array keys; not record paths)
- [x] JS/MJS fail-fast before mutation; migration hint
- [x] `--context` / `--local` target resolution aligned with `set`/`unset`
- [x] Idempotent add
- [x] Remove / empty-array: key removed; file deleted when document empty
- [x] `liftKeysMisnestedUnderPaths` applied on mutation read paths
- [x] Test matrix vs plan Phase 5 (unit + integration)

**P1 recommended**

- [x] Sub-project `--context` add/remove
- [x] `--local` add/remove
- [x] JS active config rejects add and remove

## Addendum (April 10, 2026) — Staff review

### What's Addressed

- Phase 5 plan checkboxes updated to `[x]` in the same commit.
- Full parity checklist (R8) satisfied in implementation and tests.

### Remaining Concerns

- None blocking; optional P2 tests noted above.
