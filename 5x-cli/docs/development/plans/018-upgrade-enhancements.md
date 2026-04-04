# Upgrade Command Enhancements

**Version:** 1.2
**Created:** March 13, 2026
**Status:** Ready for implementation

## Overview

The existing `5x upgrade` command handles config migration (JS→TOML, deprecated
key renames), database schema migration, and template refresh. However, it has
several gaps that make it insufficient as a reliable post-update maintenance
command:

- **No dry-run mode.** Users cannot preview what will change before committing.
- **No stale file cleanup.** When bundled templates or skills are removed across
  CLI versions, the old files remain on disk indefinitely.
- **No safe overwrite detection.** Templates and skills are either skipped
  (default) or force-overwritten — there is no middle ground that updates
  untouched managed files while preserving user edits.
- **No harness asset refresh.** Installed harness skills and agent profiles are
  never updated; users must manually `uninstall` + `install` after CLI upgrades.
- **Missing config key addition.** TOML upgrade only renames/removes deprecated
  keys — it does not add new keys introduced in later CLI versions.
- **Ad hoc DB path resolution.** The upgrade handler reads `db.path` directly
  from raw config instead of using the control-plane resolver, which may diverge
  in worktree or custom-path setups.

This change extends `5x upgrade` into a manifest-driven reconciler with a
plan-then-apply architecture, `--dry-run` support, and harness asset refresh.

## Goals

- `5x upgrade --dry-run` reports every planned change without writing anything.
- Managed files (templates, prompt templates, project-scope harness skills,
  project-scope agent profiles) that have not been user-modified are updated
  automatically.
- Managed files that have been removed from the bundled set are cleaned up if
  they have not been user-modified.
- User-modified managed files are reported as conflicts and left untouched
  (unless `--force`).
- New config keys from the default TOML template are merged into existing
  `5x.toml` while preserving comments and user values.
- Installed project-scope harness assets are refreshed for all harnesses where
  they are currently installed.
- Database migration uses the control-plane resolver for consistent DB path
  discovery.

## Non-Goals

- Changing the `5x init` scaffolding flow — init remains a one-time setup
  command. Upgrade consumes the manifest that init and harness install create.
- Adding a persistent manifest to the `5x skills install` (generic agentskills.io)
  path — that command remains a simple file writer with its own idempotency.
- Interactive confirmation prompts — upgrade is designed for unattended use in
  CI and post-install hooks.
- Upgrading external (third-party) harness plugins — only bundled harness
  assets are refreshed. External plugins manage their own upgrade lifecycle.
- **User-scope harness asset refresh.** User-scoped harness assets (installed
  under `$HOME`) live outside any single repo and can be refreshed from many
  repos. Tracking them in a project-scoped manifest creates cross-repo
  collisions. User-scope refresh is deferred to a future iteration that
  introduces a separate user-scoped manifest at `~/.config/5x/`.

## Design Decisions

**Plan-then-apply architecture.** Every upgrade phase (config, database,
templates, harness assets) first builds a typed action plan describing what
would change. In `--dry-run` mode, only the plan is printed. In normal mode,
the plan is executed. This avoids duplicating logic between preview and apply
paths and makes the upgrade handler unit-testable without filesystem side
effects.

**Managed-asset manifest tracks installed file hashes (project scope only).**
A JSON manifest lives at `{stateDir}/upgrade-manifest.json` where `stateDir`
is resolved via `resolveControlPlaneRoot()` (typically `.5x`). The manifest
tracks only project-scoped managed assets — templates, prompt templates, and
project-scope harness skills/agents. Each entry records:

- `relativePath` — path relative to the control-plane root.
- `owner` — logical owner string (e.g. `template`, `prompt-template`,
  `harness:opencode:skill`, `harness:opencode:agent`).
- `contentHash` — SHA-256 hex digest of the file content at last write.
- `cliVersion` — CLI version that last wrote the entry.

This enables three behaviors that are impossible with existence-only checks:

1. **Safe auto-update:** If the on-disk hash matches the manifest hash, the
   file has not been user-modified and can be safely overwritten.
2. **Conflict detection:** If the on-disk hash differs from the manifest hash,
   the user edited the file — report it as a conflict and skip.
3. **Stale cleanup:** If a manifest entry exists but the asset is no longer in
   the bundled set, it can be removed — but only if the on-disk hash still
   matches the manifest hash (proving the user never edited it).

User-scope harness assets are explicitly excluded from this manifest. They
will be tracked by a separate mechanism in a future iteration.

**Bootstrap adoption compares against bundled content, not blind adoption.**
On first run after this change lands, no manifest exists. For each
pre-existing file that matches a desired managed asset, the reconciler
compares the on-disk content hash against the _bundled content hash_ (not
just recording the on-disk hash as the baseline). Two outcomes:

- **On-disk hash matches bundled hash:** The file is unmodified from what the
  CLI would have written. Adopt it into the manifest with the bundled hash
  as the baseline. Future upgrades can safely auto-update it.
- **On-disk hash does NOT match bundled hash:** The user has customized the
  file. Classify it as `conflict` immediately — do not adopt it as an
  overwrite-safe baseline. The file is preserved, and the user is informed.

This prevents the bootstrap from silently making user-edited files
auto-overwritable on subsequent upgrades. Files that are genuinely
untouched are seamlessly adopted; customized files are surfaced as conflicts
from the start.

**All managed-asset paths resolve through `resolveControlPlaneRoot()`.**
The upgrade handler calls `resolveControlPlaneRoot(startDir)` once at the
top of `buildUpgradePlan()`. The returned `controlPlaneRoot` and `stateDir`
anchor all asset paths:

| Asset class | Root | Example path |
|-------------|------|-------------|
| Manifest | `{stateDir}/upgrade-manifest.json` | `.5x/upgrade-manifest.json` |
| Templates | `{controlPlaneRoot}/.5x/templates/` | `/repo/.5x/templates/review-template.md` |
| Prompt templates | `{controlPlaneRoot}/.5x/templates/prompts/` | `/repo/.5x/templates/prompts/plan.md` |
| Project harness assets | `plugin.locations.resolve("project", controlPlaneRoot)` | `/repo/.claude/skills/5x-plan/SKILL.md` |
| Database | `{stateDir}/{DB_FILENAME}` | `.5x/5x.db` |
| Config | `discoverConfigFile(controlPlaneRoot)` | `/repo/5x.toml` |

The `startDir` parameter (from `UpgradeParams`) flows into
`resolveControlPlaneRoot()` as the entry point. This ensures correct
behavior when `5x upgrade` is invoked from a subdirectory, a linked
worktree, or with a custom `db.path` configuration. Tests must cover
subdirectory invocation and linked-worktree invocation.

**Config key addition via TOML merge.** The default TOML template
(`src/templates/5x.default.toml`) is the source of truth for the full key set.
During TOML→TOML upgrade, the handler parses both the user's config and the
default template, identifies keys present in the default but missing from the
user's config, and patches them in. Commented-out keys in the default template
are added as comments (preserving the "opt-in" style). Existing user values
are never overwritten by defaults.

**Harness refresh is auto-detected, not opt-in (project scope only).** The
upgrade handler inspects each bundled harness plugin's `"project"` scope and
checks whether assets are currently installed (using `plugin.describe()` +
`plugin.locations.resolve()` + existence checks). In addition, harness scopes
are considered installed if the manifest contains any entries with a matching
harness owner prefix (e.g. `harness:opencode:*`). This dual check — current
files OR manifest entries — ensures that stale-only installs (where all
currently bundled files were removed/renamed but manifest-managed files still
exist on disk) still enter reconciliation for cleanup. Users do not need to
pass `--scope` or harness names — upgrade discovers what is installed and
refreshes it.

**DB path resolution uses `resolveControlPlaneRoot()`.** The current ad hoc
config-read for `db.path` in the upgrade handler is replaced with the canonical
control-plane resolver from `src/commands/control-plane.ts`. This ensures
upgrade finds the correct DB in worktree and custom-path configurations.

**DB migration failure keeps the backup-then-abort strategy.** On migration
failure, the handler backs up the DB and reports the error. The current
delete-and-recreate fallback is removed — silently discarding run history is
too destructive for a maintenance command. Users who want a fresh DB can
delete it manually.

## Phase 1: Managed-Asset Manifest

**Completion gate:** A reusable manifest module exists that can read, write,
hash, and diff managed files against their recorded state. Unit tests cover
all classification outcomes (create, update, skip, conflict, stale-clean,
stale-modified) including bootstrap with both matching and divergent files.

- [ ] Create `src/managed-assets.ts` with types and helpers:
      - `ManifestEntry`: `{ relativePath: string; owner: string; contentHash: string; cliVersion: string }`.
      - `Manifest`: `{ version: 1; entries: ManifestEntry[] }`.
      - `AssetAction`: `"create" | "update" | "skip" | "remove" | "conflict" | "stale-modified"`.
      - `AssetPlan`: `{ relativePath: string; owner: string; action: AssetAction; detail?: string }`.
      - `readManifest(manifestPath): Manifest | null` — reads and parses the
        JSON manifest; returns null if the file does not exist or is malformed.
      - `writeManifest(manifestPath, manifest)` — atomically writes the manifest.
      - `hashContent(content: string): string` — SHA-256 hex digest.
      - `hashFile(absolutePath: string): string | null` — reads file and hashes;
        returns null if file does not exist.
      - `reconcileAssets(desired, manifest, diskHashFn): AssetPlan[]` — core
        reconciliation logic. Takes desired assets (path + content + owner),
        existing manifest entries, and a disk-hash lookup function. Returns
        a plan of classified actions.
- [ ] The `reconcileAssets` function implements these rules:
      - Desired asset not on disk and not in manifest → `create`.
      - Desired asset not on disk but in manifest → `create` (was deleted,
        re-create from bundled source).
      - Desired asset on disk, in manifest, disk hash = manifest hash →
        `update` (safe to overwrite with new content) unless new content hash
        equals disk hash, in which case `skip`.
      - Desired asset on disk, in manifest, disk hash ≠ manifest hash →
        `conflict` (user modified the file).
      - Desired asset on disk, NOT in manifest (bootstrap), disk hash =
        desired content hash → `skip` (file matches bundled content; adopt
        into manifest after apply with the bundled hash as baseline).
      - Desired asset on disk, NOT in manifest (bootstrap), disk hash ≠
        desired content hash → `conflict` (file has been customized; do NOT
        adopt into manifest; report conflict immediately).
      - Manifest entry with no matching desired asset, disk hash = manifest
        hash → `remove` (stale, unmodified).
      - Manifest entry with no matching desired asset, disk hash ≠ manifest
        hash → `stale-modified` (stale but user-edited; keep and report).
      - Manifest entry with no matching desired asset, file missing from
        disk → silently drop from manifest (already gone).
- [ ] Add unit tests in `test/unit/managed-assets.test.ts` covering every
      classification branch above, plus:
      - Round-trip manifest read/write.
      - `hashContent` determinism.
      - `reconcileAssets` with empty manifest (bootstrap case) — both
        matching and divergent files.
      - `reconcileAssets` with empty desired set (full stale cleanup).
      - Bootstrap: pre-existing file matching bundled content is adopted.
      - Bootstrap: pre-existing file with user edits is flagged as conflict.

## Phase 2: Upgrade Plan Model and Dry-Run

**Completion gate:** `runUpgrade()` builds a typed plan for all phases and
either prints it (`--dry-run`) or executes it. `--dry-run` writes nothing to
disk. Unit tests verify plan generation and dry-run behavior.

- [ ] Define `UpgradePlan` type in `src/commands/upgrade.handler.ts`:
      ```ts
      interface UpgradePlan {
        controlPlaneRoot: string;
        stateDir: string;
        config: ConfigAction[];
        database: DatabaseAction;
        templates: AssetPlan[];
        harnesses: HarnessUpgradePlan[];
      }
      ```
      Where `ConfigAction` describes key additions, renames, removals, and
      JS→TOML migration; `DatabaseAction` describes version delta and backup;
      `HarnessUpgradePlan` groups per-harness, per-scope asset plans.
      The plan carries `controlPlaneRoot` and `stateDir` so that
      `applyUpgradePlan()` does not need to re-resolve paths.
- [ ] Add `--dry-run` boolean arg to `src/commands/upgrade.ts` citty definition.
- [ ] Extend `UpgradeParams` with `dryRun?: boolean`.
- [ ] Refactor `runUpgrade()` into two internal phases:
      - `buildUpgradePlan(params): Promise<UpgradePlan>` — calls
        `resolveControlPlaneRoot(params.startDir)` first, then reads current
        state and computes all planned actions using the resolved root for
        every asset path. Writes nothing.
      - `applyUpgradePlan(plan, params): Promise<void>` — executes the plan
        actions and writes the updated manifest.
- [ ] `runUpgrade()` calls `buildUpgradePlan()`, prints the plan, and then
      calls `applyUpgradePlan()` only if `dryRun` is false.
- [ ] Printer formats the plan as a human-readable summary grouped by phase
      (Config, Database, Templates, Harnesses), using the same `console.log`
      style as the current output.
- [ ] Add unit tests in `test/unit/commands/upgrade.test.ts` (new file):
      - `buildUpgradePlan` returns correct plan for various scenarios.
      - `runUpgrade({ dryRun: true })` produces a plan but writes no files.
      - `buildUpgradePlan` from a subdirectory resolves to the correct
        control-plane root.

## Phase 3: Config Key Addition

**Completion gate:** TOML→TOML upgrade adds missing keys from the default
template while preserving existing user values and comments. Dry-run reports
which keys would be added.

- [ ] In `upgradeTomlConfig()`, after deprecated-key transforms, compare the
      user's parsed config against the default template parsed from
      `generateTomlConfig()`.
- [ ] Identify keys present in the default but absent from the user config.
      Walk nested objects (e.g. `[author]`, `[paths]`, `[db]`) to detect
      missing sub-keys.
- [ ] For each missing key, add it to the transform output. Use `tomlPatch()`
      to merge — this preserves existing comments and formatting.
- [ ] Add missing keys as commented-out entries (matching the default template
      style) when the default value is itself commented out, and as active
      entries when the default is active. This requires inspecting the raw
      TOML template text to determine comment state.
- [ ] Return `ConfigAction` entries describing each addition for the plan.
- [ ] Add unit tests covering:
      - Missing top-level key is added.
      - Missing nested key (e.g. `[worktree].postCreate`) is added.
      - Existing keys are not overwritten.
      - Already-present keys produce no action.

## Phase 4: Template Reconciliation

**Completion gate:** Template refresh uses the manifest-driven reconciler.
Unchanged managed templates are auto-updated. User-modified templates are
reported as conflicts. Stale templates are removed if unmodified. All
template and manifest paths are resolved via `resolveControlPlaneRoot()`.

- [ ] Refactor `refreshTemplates()` in `upgrade.handler.ts` to use
      `reconcileAssets()` from the manifest module.
- [ ] Resolve all template paths relative to `controlPlaneRoot` from the
      upgrade plan (not raw `startDir` or `resolve(".")`). The manifest
      path is `{stateDir}/upgrade-manifest.json`.
- [ ] Build the desired asset list from:
      - `ensureTemplateFiles` targets: `implementation-plan-template.md`,
        `review-template.md` (owner: `template`).
      - `listTemplates()` prompt templates (owner: `prompt-template`).
- [ ] Read the existing manifest (or null on first run).
- [ ] Call `reconcileAssets()` to get the plan.
- [ ] In apply mode:
      - Execute `create` and `update` actions by writing files.
      - Execute `remove` actions by deleting files and cleaning empty dirs.
      - Skip `conflict` and `stale-modified` actions (report only).
      - With `--force`: execute `conflict` and `stale-modified` as overwrites
        and removals respectively.
- [ ] After apply, update the manifest with the new state of all managed
      template files (including bootstrap-adopted files that matched bundled
      content).
- [ ] Add unit tests covering:
      - First-run bootstrap (no manifest) with default files → adopts all,
        writes manifest.
      - First-run bootstrap with user-customized file → conflict reported,
        file preserved, file NOT adopted into manifest.
      - Second run with unchanged templates skips all.
      - Bundled template content changed → auto-update untouched files.
      - User-modified template → conflict reported, file preserved.
      - Template removed from bundled set → stale unmodified file removed.
      - Template removed from bundled set but user-edited → stale-modified
        reported, file preserved.
      - `--force` overwrites conflicts and removes stale-modified files.

## Phase 5: Harness Asset Refresh (Project Scope Only)

**Completion gate:** `5x upgrade` detects installed project-scope harness
assets and refreshes skills and agent profiles using the manifest reconciler.
Stale harness assets (skills/agents removed from the bundled set) are cleaned
up. User-scope harness assets are not touched.

- [ ] Add optional `desiredAssets?(ctx)` method to `HarnessPlugin` interface
      in `src/harnesses/types.ts`:
      ```ts
      interface HarnessDesiredAsset {
        /**
         * Path relative to the harness scope root — NOT relative to the
         * control-plane root.  Example: "skills/5x-plan/SKILL.md".
         *
         * Callers must re-root these paths through
         * `plugin.locations.resolve("project", controlPlaneRoot)` before
         * passing them to `reconcileAssets()` so that the resulting
         * `relativePath` values in the manifest are control-plane-root-
         * relative (e.g. ".claude/skills/5x-plan/SKILL.md").
         */
        relativePath: string;
        /** Content to write. */
        content: string;
      }
      desiredAssets?(ctx: HarnessInstallContext): HarnessDesiredAsset[];
      ```
      The `?` makes the method optional at the type level. This returns the
      full set of files the plugin would install, without writing anything.
      The existing `install()` method is kept for backward compatibility.
      Third-party plugins that do not implement `desiredAssets()` are simply
      skipped during upgrade harness refresh.
- [ ] Implement `desiredAssets()` on the OpenCode plugin:
      - Skills: map `ctx.skills` through `installSkillFiles`-equivalent logic
        to produce `skills/<name>/SKILL.md` paths + content.
      - Agents: call `renderAgentTemplates()` to produce `agents/<name>.md`
        paths + content.
- [ ] In `buildUpgradePlan()`, for each bundled harness:
      - Load the plugin via `loadHarnessPlugin()`.
      - Skip if the plugin does not implement `desiredAssets()`.
      - For `"project"` scope only (skip `"user"` scope entirely):
        - Check if any managed files are currently installed (existence check
          on known paths from `describe()` + `locations.resolve()`).
        - Additionally check if the manifest contains any entries with a
          matching harness owner prefix (e.g. entries where `owner` starts
          with `harness:opencode:`). This ensures stale-only installs —
          where all currently bundled files were removed or renamed but
          manifest-managed files still exist on disk — still enter
          reconciliation.
        - If installed (by either check): call `desiredAssets()` to get the
          desired state. Re-root each returned `relativePath` through
          `plugin.locations.resolve("project", controlPlaneRoot)` so that
          paths become control-plane-root-relative (e.g.
          `"skills/5x-plan/SKILL.md"` →
          `".claude/skills/5x-plan/SKILL.md"`). This ensures manifest
          `relativePath` values are consistent with the manifest's
          control-plane-root-relative keying. Then call
          `reconcileAssets()` to produce the plan.
      - Compute manifest owner strings as `harness:<name>:skill` and
        `harness:<name>:agent`.
- [ ] In `applyUpgradePlan()`, execute harness asset plans using the same
      create/update/remove/skip logic as templates.
- [ ] After apply, update the manifest with the new harness asset state.
- [ ] Update `isValidPlugin()` in `src/harnesses/factory.ts` to accept
      plugins without `desiredAssets()` (already optional via `?` in the
      interface; `isValidPlugin` must not require it).
- [ ] Add unit tests covering:
      - Installed project-scope harness is detected and included in plan.
      - Non-installed scope is excluded from plan.
      - User-scope is always excluded from plan (even if installed).
      - Skill/agent content changes trigger update for untouched files.
      - User-modified harness files are reported as conflicts.
      - Removed bundled skill/agent produces stale removal.
      - Stale-only harness scope (all current files gone, manifest entries
        remain) still enters reconciliation and cleans up.
      - Agent model re-rendering (config change) triggers update.
      - Plugin without `desiredAssets()` is gracefully skipped.

## Phase 6: DB Path Resolution Fix and Migration Safety

**Completion gate:** DB upgrade uses `resolveControlPlaneRoot()` for path
discovery. Migration failure backs up and aborts without deleting the DB.
Dry-run reports schema version delta.

- [ ] Replace the ad hoc DB-path reading in `runUpgrade()` (lines 338-367)
      with `resolveControlPlaneRoot(startDir)` from
      `src/commands/control-plane.ts`. The resolved `stateDir` is shared
      with the rest of the plan (manifest path, template root, etc.) —
      a single call at the top of `buildUpgradePlan()` serves all phases.
- [ ] Derive `dbRelPath` from the resolved `stateDir` + `DB_FILENAME` constant.
- [ ] In `buildUpgradePlan()`, compute `DatabaseAction`:
      - `{ exists: false }` → report "will be created on first command".
      - `{ exists: true, currentVersion, targetVersion }` → report delta.
      - `targetVersion` is the max migration version from `src/db/schema.ts`.
- [ ] In `applyUpgradePlan()`, remove the delete-and-recreate fallback on
      migration failure. Keep backup, run migrations, report error on failure.
      The user can manually delete the DB if they want a fresh start.
- [ ] Add unit tests verifying:
      - Plan correctly reports version delta.
      - Plan works when no DB exists.
      - Custom `db.path` in config is respected via control-plane resolution.
      - Subdirectory invocation resolves the same DB as root invocation.

## Phase 7: Integration Tests and CLI Polish

**Completion gate:** Integration tests exercise the full `5x upgrade` CLI
path including `--dry-run`, and the AGENTS.md and README are updated.

- [ ] Add integration tests in `test/integration/commands/upgrade.test.ts`:
      - `--dry-run` prints planned changes and writes no files.
      - Full upgrade creates missing templates, updates unchanged templates,
        writes manifest.
      - Upgrade after harness install refreshes project-scope harness assets.
      - Stale template removed on upgrade (pre-seed manifest with an extra
        entry, verify file is removed).
      - User-modified template is not overwritten (modify a managed file,
        verify conflict is reported and file preserved).
      - Bootstrap with customized file reports conflict immediately (does not
        silently adopt the file).
      - `--force` overwrites user-modified files.
      - Config key addition (start with minimal TOML, verify new keys added).
      - Subdirectory invocation produces the same plan as root invocation.
      - Linked-worktree invocation resolves to the correct control-plane root.
- [ ] Update `AGENTS.md` handler documentation to include the new `dryRun`
      parameter in the `runUpgrade()` entry.
- [ ] Update `src/commands/upgrade.ts` description to mention dry-run and
      harness refresh.
- [ ] Ensure all existing upgrade tests still pass.

## Files Touched

| File | Change |
|------|--------|
| `src/managed-assets.ts` | New: manifest types, read/write, hashing, reconciliation engine |
| `src/commands/upgrade.ts` | Add `--dry-run` arg |
| `src/commands/upgrade.handler.ts` | Refactor into plan/apply; add config key addition, template reconciliation, harness refresh, DB path fix; single `resolveControlPlaneRoot()` call anchors all paths |
| `src/harnesses/types.ts` | Add optional `desiredAssets?()` to `HarnessPlugin` |
| `src/harnesses/factory.ts` | Update `isValidPlugin()` (keep `desiredAssets` optional) |
| `src/harnesses/opencode/plugin.ts` | Implement `desiredAssets()` |
| `src/commands/control-plane.ts` | No change — consumed by upgrade handler |
| `src/commands/init.handler.ts` | No change — `ensureTemplateFiles` / `ensurePromptTemplates` still used by init; upgrade takes its own path |
| `test/unit/managed-assets.test.ts` | New: manifest and reconciliation tests (incl. bootstrap adoption/conflict) |
| `test/unit/commands/upgrade.test.ts` | New: plan-building, dry-run, subdirectory-invocation unit tests |
| `test/integration/commands/upgrade.test.ts` | Extend: dry-run, harness refresh, stale cleanup, conflict detection, bootstrap conflict, subdirectory, linked-worktree |
| `AGENTS.md` | Update `runUpgrade()` docs |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/managed-assets.test.ts` | Manifest read/write, hashing, all reconciliation branches, bootstrap adoption vs conflict |
| Unit | `test/unit/commands/upgrade.test.ts` | Plan building for config/db/templates/harnesses, dry-run no-write, subdirectory root resolution |
| Integration | `test/integration/commands/upgrade.test.ts` | End-to-end CLI `--dry-run`, template reconciliation, harness refresh (project scope), stale cleanup, conflict preservation, bootstrap conflict detection, `--force` behavior, config key addition, subdirectory invocation, linked-worktree invocation |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Bootstrap manifest missing on first upgrade after this change | Certain (one-time) | Low | Files matching bundled content are adopted; divergent files are flagged as conflicts; no destructive actions without manifest |
| Bootstrap misclassifies user-edited file as safe-to-overwrite | N/A (eliminated) | N/A | Bootstrap compares on-disk hash against bundled content hash; only exact matches are adopted; divergent files become conflicts immediately |
| TOML key addition changes formatting or removes comments | Medium | Medium | Use `tomlPatch()` which preserves comments; integration test verifies comment preservation |
| `desiredAssets()` rendering depends on config (model injection) | Low | Low | Config is loaded before harness planning; missing config falls back to no-model rendering (matching current install behavior) |
| Stale file removal deletes a file the user intended to keep | Low | High | Only removes files whose on-disk hash matches manifest hash; `stale-modified` files are always preserved unless `--force` |
| Third-party harness plugins lack `desiredAssets()` | Likely | Low | Method is optional (`?` in interface); plugins without it are skipped during upgrade harness refresh |
| User-scope harness assets not refreshed by upgrade | Certain (deferred) | Low | Out of scope for this iteration; users can `harness uninstall` + `harness install` for user-scope. Future iteration adds user-scoped manifest |
| Stale-only harness scope missed during reconciliation | N/A (eliminated) | N/A | Scope inclusion driven by manifest entries OR current-file existence, so stale-only installs still enter reconciliation |

## Revision History

### v1.1 — Address review feedback (018-upgrade-enhancements-review.md)

**P0.1 (manifest scope topology):** Scoped manifest to project-only assets.
Added "User-scope harness asset refresh" to Non-Goals. All references to
harness refresh now say "project scope only." User-scope refresh deferred to
future iteration with a separate `~/.config/5x/` manifest.

**P0.2 (bootstrap adoption erasing conflict detection):** Replaced blind
bootstrap adoption with bundled-content comparison. Bootstrap rule now has two
branches: on-disk matches bundled → adopt; on-disk diverges → conflict
immediately. Updated reconcileAssets rules, Design Decisions, Phase 1 tests,
Phase 4 tests, Phase 7 integration tests, and Risks table.

**P1.1 (root anchoring under-specified):** Added "All managed-asset paths
resolve through `resolveControlPlaneRoot()`" design decision with asset-path
table. `buildUpgradePlan()` calls the resolver once and threads
`controlPlaneRoot`/`stateDir` through to all phases. Added subdirectory and
linked-worktree test cases to Phases 2, 6, and 7.

**P1.2 (harness stale-only scope detection):** Updated harness refresh design
decision and Phase 5 scope-detection logic to check manifest entries in
addition to current-file existence, ensuring stale-only installs enter
reconciliation. Added stale-only harness scope test case.

**P2 (desiredAssets contract consistency):** Changed `desiredAssets(ctx)` to
`desiredAssets?(ctx)` in the interface definition (optional at type level).
Updated Phase 5 text to consistently describe the method as optional, with
explicit skip logic for plugins that lack it. Added test case for graceful
skip of plugins without `desiredAssets()`.

### v1.2 — Address Addendum 2 review feedback

**R4 / P2.1 (harness asset path normalization):** Clarified in the
`HarnessDesiredAsset` interface that `relativePath` is relative to the
harness scope root, not the control-plane root. Added explicit re-rooting
step in the `buildUpgradePlan()` bullet: `desiredAssets()` output must be
re-rooted through `plugin.locations.resolve("project", controlPlaneRoot)`
before being passed to `reconcileAssets()`, ensuring manifest `relativePath`
values remain control-plane-root-relative.
