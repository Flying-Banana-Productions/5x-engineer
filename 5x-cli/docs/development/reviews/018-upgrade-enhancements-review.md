# Review: Upgrade Command Enhancements

**Review type:** `5x-cli/docs/development/018-upgrade-enhancements.md`
**Scope:** Implementation plan plus related upgrade, init, control-plane, harness, template, and config code/docs.
**Reviewer:** Staff engineer
**Local verification:** Not run

## Summary

The overall direction is good: plan/apply, dry-run, safer DB behavior, and manifest-based reconciliation are the right primitives. But the plan is not implementation-ready because the proposed manifest topology does not work for mixed project/user-scope assets, and the bootstrap strategy would misclassify existing user-edited files as safe-to-overwrite on later upgrades.

**Readiness:** Not ready - manifest ownership and first-run adoption semantics need design correction before implementation.

## Strengths

- Moves upgrade logic toward a single plan/apply path, which fits dry-run and testability well.
- Correctly removes the delete-and-recreate DB fallback; that is a much safer maintenance posture.
- Reuses existing control-plane and harness abstractions instead of inventing a parallel upgrade-only stack.
- Calls out stale cleanup and conflict preservation explicitly instead of treating overwrite vs skip as a binary.

## Production Readiness Blockers

### P0.1 - Manifest storage model is incompatible with harness scope topology

**Risk:** A single manifest at `.5x/upgrade-manifest.json` cannot safely track both project-scoped assets and user-scoped harness assets. User-scoped assets live outside any one repo and can be refreshed from many repos, while the proposed manifest entry shape (`relativePath`, `owner`) does not encode scope or asset root. That creates collisions between project/user installs and cross-repo clobbering for global harness assets.

**Requirement:** Define a manifest topology that matches asset ownership boundaries. At minimum, the plan must specify where manifest state lives for project assets vs user-scoped harness assets, and how entries are uniquely keyed across harness name + scope + root + relative path without collisions.

**Action:** `human_required`

### P0.2 - Bootstrap adoption would erase conflict detection for existing customized files

**Risk:** The plan says first-run existing managed files are treated as `skip`, then "adopted" into the manifest after apply. If a user already customized a template or harness asset before manifests exist, storing the current on-disk hash as the managed baseline will make later upgrades treat that edited file as untouched and auto-overwrite it when bundled content changes. That violates the core goal of preserving user edits.

**Requirement:** Redefine first-run/bootstrap behavior so pre-existing files only become auto-updatable when the CLI can prove they match the bundled baseline, or else keep them in an explicit unmanaged/conflict state. The plan needs a concrete state model and tests for pre-existing customized files, not just pre-existing default files.

**Action:** `human_required`

## High Priority (P1)

### P1.1 - Root anchoring is still under-specified for config/templates/manifest paths

The plan fixes DB resolution via `resolveControlPlaneRoot()`, but it still describes the manifest as `.5x/upgrade-manifest.json` and template reconciliation against the upgrade target root without defining whether that root is raw cwd, checkout root, or control-plane root. Existing architecture already roots shared `.5x` artifacts and prompt overrides at the control-plane state dir, and current `runUpgrade()` still uses `resolve(params.startDir ?? ".")` directly.

Recommendation: explicitly define upgrade root resolution for every asset class: config file discovery, project templates, prompt overrides, manifest location, and DB path. Add tests for subdirectory invocation and linked-worktree invocation.

**Action:** `human_required`

### P1.2 - Harness install detection misses stale-only scopes

The harness refresh phase says a scope is included only if existence checks find any currently known files from `describe()`. That is not sufficient for stale cleanup: if a bundled skill/agent was removed or renamed and no current known file remains, the scope can be treated as "not installed" even though stale manifest-managed files still exist and should be reconciled.

Recommendation: drive scope inclusion from manifest state and/or explicit scope markers in addition to current-file existence checks, so stale-only installs still enter reconciliation.

**Action:** `auto_fix`

## Medium Priority (P2)

- The Phase 5 interface snippet shows `desiredAssets(ctx)` as required, while later bullets and the risk table say it must stay optional for third-party compatibility. Tighten the plan text so the contract is consistent before implementation. **Action:** `auto_fix`

## Readiness Checklist

**P0 blockers**
- [ ] Redesign manifest ownership/keying so project and user-scope assets can be tracked without collisions or cross-repo interference.
- [ ] Define bootstrap semantics that preserve existing user customizations instead of adopting them as overwrite-safe baselines.

**P1 recommended**
- [ ] Make upgrade root anchoring explicit for config, templates, prompt overrides, DB, and manifest paths.
- [ ] Ensure harness reconciliation can run for stale-only installs, not just scopes with currently known files present.

## Addendum (2026-03-13) - v1.1 Re-review

### What's Addressed

- **R1 resolved.** The plan now explicitly limits manifest-driven refresh to project-scoped assets and moves user-scope harness refresh into Non-Goals with a separate future manifest under `~/.config/5x/`.
- **R2 resolved.** Bootstrap adoption now compares on-disk content to bundled content and only adopts exact matches; divergent pre-existing files are classified as conflicts immediately and excluded from manifest adoption.
- **R3 resolved.** The revised plan now threads `startDir` into a single `resolveControlPlaneRoot()` call and explicitly anchors manifest, templates, prompt templates, config, harness assets, and DB paths off the resolved control-plane root/state dir.
- The previous stale-only harness detection gap is also fixed by including manifest-owner-prefix checks in scope detection.

### Remaining Concerns

- **P2.1 - Harness asset path normalization should be stated explicitly.** The manifest contract says `relativePath` is relative to `controlPlaneRoot`, while `desiredAssets()` returns paths relative to the harness scope root. The implementation can handle this mechanically by re-rooting `desiredAssets()` output through `plugin.locations.resolve("project", controlPlaneRoot)` before reconciliation, but the plan should say that explicitly to avoid mismatched manifest keys for harness entries. **Action:** `auto_fix`

### Assessment

- The blocking issues from the first review are addressed.
- The remaining gap is mechanical clarification, not a design blocker.

**Readiness:** Ready with corrections
