# Review: 020-config-ux-overhaul Phase 3 (rich `config show`)

**Review type:** commit `d55fe5073f4348ed1db9492b115b612d34cb31e4`  
**Scope:** Phase 3 — rich `5x config show` (registry-backed JSON, text table, `--key`, passthrough keys, path default normalization)  
**Reviewer:** Staff engineer  
**Plan reference:** `docs/development/plans/020-config-ux-overhaul.md` Phase 3  
**Local verification:** `bun test test/unit/commands/config.test.ts test/integration/commands/config-show.test.ts --concurrent` — passed (18 tests)

## Summary

The commit delivers Phase 3’s completion gate: `config show` now returns a structured `{ files, entries }` payload with per-key metadata, effective absolute defaults for `paths.*`, `isLocal` from local overlays, passthrough keys surfaced as unrecognized, and `--key` for single-key lookup (value-only in text mode). The plan checklist in the doc is updated to `[x]`. Unit coverage exercises `buildConfigShowOutput`, `flattenConfig`, layering, passthrough, and `files`; integration coverage exercises the CLI envelope, `--context`, passthrough, worktrees, and `--key` success/failure.

**Readiness:** Ready with corrections — behavior matches the plan; remaining gaps are test-only (text mode at the CLI boundary).

## Strengths

- **JSON shape** matches the plan: `ConfigShowEntry` (`key`, `description`, `type`, `default`, `value`, `isLocal`) and `ConfigShowOutput` (`files`, `entries`) in `src/commands/config.handler.ts`.
- **Path defaults:** `computeEffectiveDefault()` resolves string `paths.*` schema defaults with `resolve(controlPlaneRoot, …)`, consistent with post-parse `resolveConfigPaths(config, resolve(controlPlaneRoot))` in `resolveLayeredConfig`. Unit test asserts `paths.plans` default and value align as absolute under the control-plane root.
- **Passthrough:** `flattenConfig` expands plugin/passthrough objects; `buildConfigShowOutput` appends keys not covered by the registry with `description: "(unrecognized)"` and `type: "unknown"`. Covered in unit and integration tests.
- **`--key`:** Commander passes `--key`; handler filters to one entry, unknown keys error with `INVALID_ARGS`. Integration tests cover JSON single entry and unknown-key failure.
- **Text mode:** `formatConfigShowText` prints the file-layer header (`buildConfigFileRows`: root / nearest / local), aligned table, `*` local marker, dimming when value equals default (TTY-aware via `resolveAnsi`).
- **Dead code:** Hand-coded `formatConfigText` removed; old `config-show.test.ts` folded into `config.test.ts`.

## Checklist (requested)

| Area | Status | Notes |
|------|--------|--------|
| JSON shape | Pass | Matches plan; success envelope via `outputSuccess`. |
| Path defaults | Pass | Absolute `paths.*` defaults aligned with resolver base (control-plane root). |
| Passthrough | Pass | Unrecognized entries + preserved nested keys (`acme.*`, `pluginx.foo`). |
| `--key` | Pass | JSON: single `ConfigShowEntry`; text: value-only line; unknown key errors. |
| Text mode | Pass (manual) | Formatter implemented; no integration test for `--text` output. |
| Test coverage | Pass with gap | Strong unit + JSON integration; see P2. |

## Production Readiness Blockers

None.

## High Priority (P1)

None.

## Medium Priority (P2)

### P2.1 — CLI integration tests omit `--text` / `--key --text`

**Risk:** Text formatting and the value-only `--key` text path are only indirectly covered (handler uses `getOutputFormat()`). Regressions in commander wiring or `outputSuccess` text callbacks would not be caught at the subprocess boundary.

**Requirement:** Add one or two integration tests that run `5x config show --text` and `5x config show --key <k> --text` and assert stable substrings (file header, table header, or printed value).

**Action:** `auto_fix`

## Readiness Checklist

**P0 blockers**

- [x] None.

**P1 recommended**

- [x] None.

**P2 optional**

- [x] Add subprocess tests for `--text` and `--key` + `--text`.

---

## Addendum (re-review at `02491098809820b3899bc7d4f4ad3307bacb431c`)

**P2.1 verification:** `test/integration/commands/config-show.test.ts` now includes subprocess integration coverage for text mode at the CLI boundary:

- **`5x config show --text`** — `"--text prints file header and table header with resolved defaults"` asserts stable substrings: `Config files:`, `(none)`, table column headers (`Key`, `Value`, `Default`, `Local`), and a known default row (`author.provider` / `opencode`).
- **`5x config show --key <k> --text`** — `"--key --text prints value only"` sets `maxStepsPerRun = 400` in `5x.toml` and expects stdout to be exactly `400`.

**Readiness:** P2.1 is satisfied; Phase 3 review items from the prior pass are addressed with no new blockers identified at this commit.
