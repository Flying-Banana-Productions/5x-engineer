# Review: Phase 6 — Zero-config `5x init` + sub-project scaffolding

**Review type:** `d45f5368134f50fbaf2b47944fa4c0717aa0b8fc`
**Scope:** Phase 6 of `docs/development/plans/020-config-ux-overhaul.md` — no root `5x.toml` from init, `--sub-project-path`, upgrade no-op without config, tests (including concurrent-safe integration temp dirs)
**Reviewer:** Staff engineer
**Local verification:** `bun test` (full suite) — pass

## Summary

Commits `6d43c2d` (feature) and `d45f536` (integration test hygiene) implement Phase 6: root `initScaffold` creates `.5x/`, DB, templates, and `.gitignore` entries for `.5x/` and `5x.toml.local` only — no `5x.toml`. User-facing completion lines point to `5x config show` / `5x config set`. `generateTomlConfig()` remains for `upgrade`’s JS→TOML template merge; it is not re-exported from the package entrypoint.

`--sub-project-path` runs a separate path: after verifying the control plane exists (state dir + DB, not merely an empty `.5x/`), it resolves the target under the control-plane root, creates the directory, and writes a minimal `[paths]`-only `5x.toml` with the planned defaults; skips or overwrites with `--force` as specified. `upgradeConfig` returns early with a clear message when no config file exists, so `5x upgrade` does not create `5x.toml` on the incremental “missing keys” path.

Unit tests cover root init (no `5x.toml`, layered defaults, legacy JS untouched, `.gitignore` behavior), sub-project matrix (error without root, `packages/api`, `.` from subdir, skip/force), and `generateTomlConfig` / `ensureGitignore` helpers. Integration tests cover CLI hints, `--force`, sub-project failure and success; `d45f536` switches temp dirs to `crypto.randomUUID()`-style names to avoid collisions under `bun test --concurrent`.

**Readiness:** Ready — Phase 6 completion gate is met; behavior matches the plan and tests are aligned.

## Strengths

- **Clear mode split:** Sub-project init short-circuits before managed-worktree and root scaffolding; root init still anchors to checkout root for `.5x/` placement.
- **Safety:** `assertPathInsideControlRoot` rejects escape via `..`; root readiness checks DB presence so half-initialized trees fail predictably.
- **Upgrade contract:** No-config path is an explicit skip with Zod-defaults messaging; JS→TOML migration unchanged where a JS file exists.
- **Test depth:** Unit layer holds most of the matrix; integration focuses on CLI wiring and concurrency-safe isolation.

## Production Readiness Blockers

None identified for Phase 6 scope.

## High Priority (P1)

None required for merge.

## Medium Priority (P2)

- **Plan wording vs implementation:** The plan’s checklist says verify “`.5x/` dir exists”; the implementation requires the DB file under the state dir as well. This is stricter and reasonable — consider aligning the plan text in a doc pass if it matters for support.
- **Integration breadth:** Sub-project edge cases (e.g. `--sub-project-path=.` from repo root, force overwrite) are covered in unit tests more than integration; acceptable given handler coverage.

## Readiness Checklist

**P0 blockers**

- [x] Root init does not write `5x.toml`; hints reference `config show` / `config set`
- [x] `.gitignore` does not ignore `5x.toml`; still ignores `.5x/` and `5x.toml.local`
- [x] `--sub-project-path` with validation, paths-only TOML, mutual exclusion with root resources
- [x] `5x upgrade` no-op when no config file (no spurious `5x.toml`)
- [x] `generateTomlConfig` / `5x.default.toml` retained for upgrade migration path
- [x] Unit + integration tests updated; concurrent-safe tmp dirs

**P1 recommended**

- [x] Existing `5x.toml` not deleted by root init
- [x] Sub-project without root → error; existing file → skip unless `--force`
