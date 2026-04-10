# Review: 020-config-ux-overhaul Phase 4 (`config set` / `unset`)

**Review type:** commit `a4906ccd18541629451b90fc19af0a76237a6b06`  
**Scope:** Phase 4 — `5x config set` / `unset`, target resolution, JS/MJS write guard, `db` root-only guard, coercion, TOML patching  
**Reviewer:** Staff engineer  
**Plan reference:** `docs/development/plans/020-config-ux-overhaul.md` Phase 4  
**Local verification:** `bun test test/unit/commands/config.test.ts test/integration/commands/config.test.ts --concurrent` — passed (37 tests)

## Summary

The commit implements Phase 4’s completion gate: Commander wires `set` and `unset` with `--local` and `--context`; `config.handler.ts` adds `resolveTargetConfigPath()`, `discoverNearestTomlPath()`, `detectActiveConfigSource()`, `configSet()` / `configUnset()`, shared helpers for merge/patch/unset, and `config-registry.ts` adds `resolveWritableConfigKey()` for leaf vs record-descendant vs array vs exact-record rejection. Unit tests cover resolution, coercion, db guard, JS/MJS fail-fast (no TOML creation), comment preservation, nested keys, unset behaviors including file deletion; integration tests cover set→show, `--local`, `--context` sub-project targeting, JS rejection on set, and unset restoring defaults via `show`.

**Readiness:** Ready with corrections — core behavior matches the plan; one optional integration gap remains (JS guard on `unset` at CLI boundary).

## Plan compliance (focused areas)

### Target path resolution

- **Control plane + context:** `resolveTargetConfigPath()` resolves the control-plane root via `resolveControlPlaneRoot`, normalizes `contextDir` (default cwd), and rejects contexts outside the root with `INVALID_ARGS` — aligns with “bounded by control-plane root.”
- **Nearest TOML:** `discoverNearestTomlPath()` walks upward to the first existing `5x.toml`, stopping at the control-plane root; if none exists, the target base is `join(controlPlaneRoot, "5x.toml")`, matching the plan’s fallback.
- **Root context shortcut:** When `contextDir === controlPlaneRoot`, the implementation uses `join(controlPlaneRoot, "5x.toml")` directly (equivalent to a walk whose first candidate is the root file).
- **`--local`:** Writes `5x.toml.local` in the same directory as the resolved base TOML (`dirname(baseToml)`), i.e. the overlay beside the nearest/root file as specified.

### JS/MJS guard

- **`detectActiveConfigSource()`** uses the same `discoverConfigFile()` walk as config loading (TOML preferred over JS in each directory per `CONFIG_FILENAMES` order). Returns `toml` | `js` | `none`.
- **`assertWritableSource()`** rejects when the active kind is `js`, with an actionable message naming the file and instructing `5x upgrade` — no implicit `5x.toml` creation (verified in unit test: no `5x.toml` after failed set).
- **Integration:** `5x config set` with `5x.config.mjs` asserts non-zero exit, error envelope, and `5x upgrade` + filename hint.

### `db` root guard

- **`isRootDbConfigTarget()`** allows only resolved paths equal to root `5x.toml` or root `5x.toml.local` (absolute comparison).
- **Unit:** `db.path` from sub-project context throws `CliError` with the root-only message path.

### Coercion

- **`resolveWritableConfigKey()`** rejects exact `record` keys and `string[]` keys with messages pointing to dotted syntax / `config add`.
- **`coerceConfigValue()`** implements string passthrough, integer-only numbers (`Number.isInteger` + finite), strict boolean `true`/`false`, and `enum` validation via registry `allowedValues` — stricter than the plan’s illustrative `Number()` for floats, but consistent with the schema (all `z.number()` fields use `.int()` in `FiveXConfigSchema` / `AgentConfigSchema`).
- **Record descendants:** `author.harnessModels.<name>` resolves as `recordChild` and coerces to string.

### TOML patch edge cases

- **Empty file:** `configSet` uses `tomlPatch(existingText === "" ? "\n" : existingText, merged)` so `toml-patch` receives a non-empty baseline when creating new files.
- **Merge + patch:** Existing TOML is parsed, deep-merged with `buildNestedFromDotted()`, then patched — preserves comments in the exercised unit test.
- **Unset:** `removeDottedKey` plus `pruneEmptyTables` / `isDocumentEmpty`; deletes the file when no keys remain — covered in unit tests.

### Test coverage

- **Unit:** Broad coverage matching the Phase 4 checklist (nested tables, `--local`, sub-project context, db error, type errors, unknown key, boolean `yes`, JS set/unset, unset preserve/delete/no-op).
- **Integration:** Strong for happy paths and JS `set` rejection; **gap:** no subprocess test that `5x config unset` fails with the same migration hint when `5x.config.js`/`.mjs` is active (unit tests cover handler-level rejection).

## Strengths

- **Separation of concerns:** Exported helpers (`resolveTargetConfigPath`, `discoverNearestTomlPath`, `detectActiveConfigSource`) are testable without spawning the CLI.
- **Single write guard:** `assertWritableSource` is shared by `configSet` and `configUnset`.
- **Registry-driven validation:** `resolveWritableConfigKey` centralizes leaf vs record-child vs rejected shapes for Phase 5 reuse.

## Production readiness blockers

None.

## High priority (P1)

None.

## Medium priority (P2)

### P2.1 — Integration test: JS/MJS active source rejects `config unset`

**Risk:** Phase 4 plan and test matrix call out fail-fast behavior for **any** write command when JS/MJS is active. `config unset` is covered in unit tests but not in `test/integration/commands/config.test.ts`, so a regression in commander wiring or handler dispatch for `unset` would not be caught at the subprocess boundary.

**Requirement:** Add one integration test mirroring the existing `5x config set` JS case: `5x config unset maxStepsPerRun` with only `5x.config.mjs` present — expect non-zero exit, error message containing `5x upgrade`, and no new TOML file created.

**Action:** `auto_fix`

## Readiness checklist

**P0 blockers**

- [x] None.

**P1 recommended**

- [x] None.

**P2 optional**

- [ ] P2.1 — integration coverage for JS/MJS + `unset`.

---

**Phase handoff:** Phase 4 completion gate is met for production behavior; after P2.1 (optional), proceed to Phase 5 (`config add` / `remove`) with confidence that `resolveTargetConfigPath()` and write guards are shared and stable.
