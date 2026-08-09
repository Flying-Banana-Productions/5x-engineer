# Harness Asset Freshness — Manifest, Freshness Check, and `5x harness sync`

**Version:** 1.2
**Created:** August 9, 2026
**Last updated:** August 9, 2026
**Status:** Phases 0–3 complete — verification spikes passed (see [Appendix A](#appendix-a--phase-0-verification-findings)); `src/harnesses/manifest.ts` (schema, hashing, read/write, `assertAssetPathsUnderRoot`, `collectInstalledAssets`/`verifyInstalledInventory`/`buildManifest`) landed; all three bundled plugins now render through `renderAssets()` and `install()` is a thin writer over it; `harness install` writes a verified/unverified manifest and `harness uninstall` removes it before the emptiness sweep; Phases 4–8 pending

---

## Executive Summary

`5x harness install` **compiles** harness assets: per-role model strings are injected into agent YAML frontmatter and delegation mode selects which skill sections render. Once written, nothing connects those files back to the config that produced them — there is no staleness detection, no freshness command, no signal at the point of cause, and no one-step refresh. Worse, the folk-remedy ("just reinstall") is *silently partial*: `installSkillFiles` overwrites skills on content diff (`src/harnesses/installer.ts:143-151`) while `installFiles` skips existing agent files unless `--force` (`src/harnesses/installer.ts:100-104`), so changing `author.model` and re-running install refreshes the skill markdown and leaves the baked agent model stale.

This plan implements `docs/v2/201-harness-freshness.md`: a harness-agnostic `.5x-manifest.json` written to each harness install root recording the baked inputs, a fingerprint over those inputs, and a per-file content hash of every installed asset; a two-tier freshness check (free input compare on hot paths, re-render compare on demand); fire points at `run init` / `config set` / `harness list`; a new `5x harness sync` command that re-renders installed scopes through the *same* render path as install; and `5x upgrade` integration that reports staleness across all bundled installs and auto-syncs only where the refresh is provably lossless *and* the user opted in.

Because that partial-refresh behavior is preserved (§"`install()` keeps its existing write semantics"), the manifest must never launder it: a manifest claims a **verified baseline** only when every managed asset on disk byte-matches the render of the inputs it records. A non-force install that skipped stale agent files writes an **unverified** manifest instead, which reads as `unknown` — never `fresh` — until `5x harness sync` establishes a real baseline.

### Scope

**In scope:**

- `src/harnesses/manifest.ts` — manifest schema, canonical JSON, fingerprint hashing, read/write/remove, two-tier compare. One harness-agnostic module.
- `HarnessPlugin` contract extension: optional `renderAssets()` (enables Tier 2 and unifies the render path) and optional `fingerprintInputs()` (external-harness escape hatch, D1).
- Manifest write on `harness install`; manifest removal on `harness uninstall` (before directory-emptiness sweeps).
- Tier 1 freshness warnings at `5x run init`, `5x config set <baked key>`, and a freshness column in `5x harness list`.
- `5x harness sync` — idempotent re-render of installed scopes, manifest adoption for pre-existing installs, explicit hand-edit reporting, `--check` for on-demand Tier 2.
- `5x upgrade` freshness sweep with `--sync` / `--no-sync`; automatic refresh requires `harness.autoSync = true` **and** the lossless-refresh predicate.
- Config keys `harness.freshnessWarnings` and `harness.autoSync`.
- Exported `runHarnessFreshnessChecks()` seam for `5x doctor` (area #3) to consume when it lands.

**Out of scope:**

- **`5x doctor` itself** — owned by `docs/v2/203-recovery-and-doctor.md` (area #3), not yet implemented. This plan ships the API it will call and uses `5x harness sync --check` as the interim on-demand Tier 2 surface.
- **Shrinking the bake surface** (`201` §2.7 — runtime model resolution, runtime delegation branching). Explicitly deferred; the manifest design must not entrench baking, which the optional `renderAssets()` seam respects.
- **Output normalization** of `harness install` / `upgrade` text output — owned by area #5 (`205-output-normalization.md`). New surfaces here (`harness sync`) emit a proper JSON envelope from day one; existing surfaces keep their current output shape plus additive fields.
- **Per-project user-scope manifests** — rejected permanently by D4.
- **Externally-published harness sweep in `upgrade`** — `buildHarnessListData()` cannot see them (`src/commands/harness.handler.ts:202`, `listBundledHarnesses()`). Stated in output rather than hidden.

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **One harness-agnostic module `src/harnesses/manifest.ts`** | D7. Consumers (`doctor`, `upgrade`, `config set`, `sync`, `run init`) all sit *outside* the installer layer, and the module carries its own types. Every harness inherits hash + read/write for free. |
| **Handler owns the fingerprint input set; `fingerprintInputs?()` declared but unimplemented** | D1. Both shipped plugins bake an identical four-input surface (`opencode/plugin.ts:63-87`, `cursor/plugin.ts:63-88`); Cursor's rules render from static templates with no config inputs. A plugin-contributed set would launch with zero implementors, but an external harness must stay representable — nested under `inputs.plugin` so it can never collide. |
| **No `assetVersion` input; per-file content hashes instead** | D2. A hand-maintained prose version gets forgotten on the first prose edit that ships without a bump — a silent miss, precisely the failure this work exists to prevent. |
| **Two-tier check** | Tier 1 (inputs only, no plugin load, no render) is the only tier on hot paths. Tier 2 (re-render + per-file hash compare) catches template drift *and* user hand-edits, and runs only in `sync` / `doctor`. |
| **Optional `renderAssets()` on the plugin contract; `install()` is a thin writer over it** | Tier 2 needs a *dry* render. Making `install()` consume the same function guarantees sync/doctor can never drift from install ("one render path, not two", §2.5). Plugins that don't implement it degrade Tier 2 to on-disk-vs-recorded hash compare (still catches hand-edits). |
| **A manifest records a `baseline` of `"verified"` or `"unverified"`; only a verified baseline can read `fresh`** | Install keeps its skip-on-exist semantics for agents, so a plain reinstall after a model change refreshes skills and leaves agents stale. Stamping the new inputs over that mixture would make Tier 1 report `fresh` on demonstrably stale bytes — the exact failure this work exists to prevent. Verification is a post-install byte compare against the render; anything less writes `unverified`, which compares as `unknown`. |
| **Lossless-refresh predicate gates every automatic refresh; `harness.autoSync` decides whether to use it** | D6. The predicate is a *safety* gate (`scope === "project"`, matching `installedFrom.contextDir`, `baseline === "verified"`, no hand-edited assets); it is never a *permission* gate. Automatic refresh additionally requires `harness.autoSync = true`, which defaults to false, so the default posture everywhere is report-only. |
| **User scope is warn-only permanently, as an additional gate beyond the predicate** | D4. `installedFrom.projectRoot` is advisory and *never compared for equality* (§2.1), so the CLI cannot prove the current project is the sole consumer of a shared asset copy. Auto-syncing user scope from project B would silently break project A. Encoded as a `shared-user-scope` blocker, not as a predicate special case. |
| **Sync refuses to clobber hand-edited files without `--force`** | Settles §5.1's open policy item. §2.5 requires unconditional refresh of *managed* assets (fixing the agent skip-on-exist bug) but the manifest makes "hand-edited" decidable for the first time, so sync reports and preserves rather than inheriting `installSkillFiles`' silent clobber. Adoption (no manifest) still force-installs per §2.5 and lists what it overwrote. |
| **No throttle; fire at transitions only** | D5. Every throttle design needs per-scope state that itself goes stale. `invoke` is deliberately not a fire point — it runs dozens of times per run and rebaking mid-run changes agent behavior mid-run. Suppression is one config key. |
| **Warnings go to stderr; JSON data gains additive `warnings` fields** | Keeps `--json` envelopes on stdout parseable and unbroken while humans still see the signal. No existing field changes type or disappears. |

### References

- [`docs/v2/201-harness-freshness.md`](../../v2/201-harness-freshness.md) — requirements; §2 design, §5 decisions D1–D8, §5.1 carried prerequisites.
- [`docs/v2/200-overview.md`](../../v2/200-overview.md) — §3.1 asset manifest shared core, §3.3 `5x doctor`, §3a forward-compatibility constraints.
- [`docs/v2/203-recovery-and-doctor.md`](../../v2/203-recovery-and-doctor.md) — §2.4 `doctor`, the eventual host for the Tier 2 surface.

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Architecture Overview](#architecture-overview)
4. [Phase 0: Prerequisite verification spikes](#phase-0-prerequisite-verification-spikes)
5. [Phase 1: `src/harnesses/manifest.ts` — schema, hashing, read/write](#phase-1-srcharnessesmanifestts--schema-hashing-readwrite)
6. [Phase 2: Plugin contract — `renderAssets()` and one render path](#phase-2-plugin-contract--renderassets-and-one-render-path)
7. [Phase 3: Manifest write on install, removal on uninstall](#phase-3-manifest-write-on-install-removal-on-uninstall)
8. [Phase 4: Freshness engine — compare, discovery, config keys](#phase-4-freshness-engine--compare-discovery-config-keys)
9. [Phase 5: Fire points — `run init`, `config set`, `harness list`](#phase-5-fire-points--run-init-config-set-harness-list)
10. [Phase 6: `5x harness sync`](#phase-6-5x-harness-sync)
11. [Phase 7: `5x upgrade` freshness sweep](#phase-7-5x-upgrade-freshness-sweep)
12. [Phase 8: Documentation, migration, and end-to-end validation](#phase-8-documentation-migration-and-end-to-end-validation)
13. [Files Touched](#files-touched)
14. [Tests](#tests)
15. [Not In Scope](#not-in-scope)
16. [Estimated Timeline](#estimated-timeline)
17. [Revision History](#revision-history)
18. [Appendix](#appendix)

---

## Overview

Harness assets are compiled at install time from `ctx.config` — `authorModel`, `reviewerModel`, `authorDelegationMode`, `reviewerDelegationMode` — resolved per-harness (including `harnessModels.<harness>` overrides) in `src/commands/harness.handler.ts:137-147`. Nothing on disk records which config produced them.

**Current behavior:**

- Delegation mode selects which skill sections render (`src/harnesses/opencode/plugin.ts:63-78` → `createRenderContext`, `src/skills/renderer.ts`); per-role models are injected into agent frontmatter (`src/harnesses/opencode/plugin.ts:82-92`, `src/harnesses/opencode/loader.ts:159-186`).
- The installer compares content only — no metadata, no fingerprint (`src/harnesses/installer.ts`).
- Re-running `5x harness install` without `--force` refreshes skills (`installer.ts:143-151`) but **skips existing agent files** (`installer.ts:100-104`), leaving baked models stale.
- `5x upgrade` refreshes config/DB/templates (`src/commands/upgrade.handler.ts:354-409`) and never touches installed harness assets.
- Editing `author.model` via `5x config set` (`src/commands/config.handler.ts:806-866`) produces no signal that installed assets are now stale.
- `5x harness list` reports installed/not-installed and a file inventory (`src/commands/harness.handler.ts:202-267`) with no freshness dimension.

**New behavior:**

- Every `harness install` writes `<rootDir>/.5x-manifest.json` recording harness, scope, fingerprint, cleartext inputs, `installedFrom` provenance, `configResolved`, a `baseline` trust marker, and a `sha256` per installed asset. The current inputs become the recorded baseline only when a post-install byte compare proves every managed asset on disk matches the render; otherwise the manifest is written `baseline: "unverified"` and reads as `unknown`.
- `5x run init`, `5x config set <baked key>`, and `5x harness list` surface a Tier 1 staleness warning naming the changed fields and the exact fix (`5x harness sync`).
- `5x harness sync` re-renders every installed scope the manifests describe, refreshing agents *and* skills, reporting hand-edits instead of silently clobbering them, and rewriting the manifest.
- `5x upgrade` sweeps all bundled harness × scope installs and reports staleness. It writes nothing by default: automatic refresh requires `harness.autoSync = true` (opt-in) *and* the lossless-refresh predicate, with `--sync` / `--no-sync` as explicit per-invocation overrides.
- `harness uninstall` removes the manifest before the emptiness sweeps, so an uninstalled `.opencode/` can actually go away.

**Prerequisites:**

- None blocking. This is `200-overview.md` §3.1, which the overview marks as independent of the run-state surface (§3.2) and parallelizable with area #3.
- Phase 0 verification spikes are internal prerequisites for Phase 5/6 user-facing copy, not external dependencies.

---

## Design Decisions

**The manifest lives at `locations.rootDir`, not in `.5x/`.** Its job is to describe what is physically baked on disk, so it must live and die with those assets: travel with them when a project-scope `.opencode/` is committed, survive `.5x/` deletion, and not desync when another project reinstalls user-scope assets. `src/harnesses/locations.ts` already exposes `rootDir` for all three shipped resolvers, so the path resolution is free. Centralizing in `.5x/` was rejected because user-scope assets (`~/.config/opencode/`, `~/.cursor/`) are shared across every repo on the machine — a per-project stamp would describe a file set that another project just rewrote.

**Dotfile inertness is verified, not assumed.** All three shipped harnesses discover *assets* from subdirectories (`skills/`, `agents/`, `rules/`), so a root-level dotfile is inert by construction (D8). The residual risk is *config* discovery — `.opencode/opencode.json` and `.cursor/mcp.json` do live at the root, so a loader globbing `*.json` there could see the manifest. A leading dot makes that very unlikely; Phase 0 carried one smoke test per harness rather than a design change. **Confirmed inert** (Appendix A.3–A.5): both loaders read their config by exact filename rather than globbing, so a manifest carrying adversarial `model` / `agent` / `mcpServers` keys changed nothing in either harness's resolved config.

**`inputs` is stored in cleartext alongside the hash.** The hash answers "is it stale"; only cleartext answers "stale *how*". Warning copy shows the changed fields — `installed author.model = X` / `current author.model = Y` — which is the difference between a warning a user acts on and one they learn to ignore.

**`configResolved: false` marks an install where config resolution threw.** `harness.handler.ts:137-147` swallows that failure and installs with undefined models. Recording those as if intentional would make the first *successful* config load read as a config change and fire a spurious warning. Such a manifest is treated as unknown/stale — identical to a missing one — so both converge on the same one-command baseline (§4).

**`installedFrom` names the context, not just the project.** `resolveLayeredConfig` (`src/config.ts:994`) resolves config per *context* while assets install once per *root* (`harness.handler.ts:118-120, 150-154`). Installing from `packages/api` bakes api's models into the checkout-root `.opencode/`, which the root context does not resolve to. Without recording the context, the freshness comparison has no defined operand. `contextDir` is stored **relative to `projectRoot`** (POSIX-separated, `""` for the root context) so project-scope manifests stay machine-independent when committed; `installedFrom.projectRoot` is the one absolute path, is advisory only, and is never compared for equality.

**All manifest values are machine-independent except advisory `projectRoot`.** Asset paths are relative to `rootDir` and POSIX-separated regardless of platform, so a manifest committed from Windows compares equal on Linux.

**Missing/unreadable/future-version manifests are `unknown`, never `fresh`.** `readManifest` returns `null` on ENOENT, JSON parse failure, schema mismatch, or `manifestVersion > MANIFEST_VERSION`. Failing closed means a corrupt stamp prompts a sync rather than silently asserting freshness.

**Tier 2 needs a dry render, so `renderAssets()` joins the plugin contract as optional.** Re-implementing the render inside the manifest module would create exactly the parallel renderer §2.5 forbids. Instead each bundled plugin exposes `renderAssets(ctx)` returning `{kind, name, path, content}[]`, and its `install()` becomes a thin dispatcher that groups those assets by kind and calls the existing installers. Install and Tier 2 then read from one function by construction. External plugins that omit it lose template-drift detection but keep hand-edit detection (on-disk vs recorded hashes), which is the safety-critical half.

**`install()` keeps its existing write semantics; `sync` supplies `force: true`.** Changing `harness install`'s skip-on-exist behavior would be a silent semantic change to a shipped command. Sync is the new surface and is defined as unconditional refresh, so it passes `force: true` and the asymmetry stops being load-bearing.

**A manifest never claims a baseline it did not verify.** Because install keeps skip-on-exist for agents (`installer.ts:100-104`), the file set left on disk after a non-force reinstall can be a *mixture*: skills re-rendered from the current config, agents still baked from whatever produced them. Writing the current inputs plus a read-back of those bytes would produce a manifest that is internally consistent and factually false — Tier 1 would report `fresh` and the hot-path warnings would vanish precisely when the assets went stale. So the manifest write is conditional on a **post-install verification**: every asset the plugin renders for this context must byte-match what is on disk. When it does, the manifest records the current inputs with `baseline: "verified"`. When it does not, the current inputs are *not* adopted as the baseline — a prior manifest's `inputs`/`hash` are retained so the warning can still name the changed fields, or, when there is no prior manifest, the attempted inputs are recorded for diagnostics only — and `baseline: "unverified"` is written, which `compareManifest` maps to `unknown`. Only `sync` (or `install --force`, which verifies by construction) establishes a fresh baseline. The `assets` hashes are always refreshed to the true on-disk bytes, so hand-edit detection stays accurate and a normal reinstall never masquerades as a hand-edit.

**Automatic refresh needs both a safety gate and a permission gate.** The lossless-refresh predicate answers "would refreshing lose anything?"; `harness.autoSync` (default `false`) answers "did the user ask us to?". Both must be true before any command writes assets on its own. `5x upgrade --sync` is the explicit per-invocation permission override; `--no-sync` forces report-only. Nothing else — not a lossless predicate, not a CLI version bump — grants permission on its own.

**Sync aborts on hand-edited files unless `--force`.** With a manifest present, "the user edited this" is decidable for the first time. §2.5 demands unconditional refresh of *managed* assets — that fixes the agent skip bug — but it does not demand silent destruction of user edits, and §5.1 explicitly asks for the skill-overwrite policy to be settled rather than inherited. Sync therefore computes the Tier 2 report first and exits with `HARNESS_ASSETS_MODIFIED` listing the edited paths and naming `--force`. The adoption path (no manifest) still force-installs per §2.5, because without a recorded hash a hand-edit is indistinguishable from config drift — it prints every overwritten path so the action is at least legible.

**User scope is a hard blocker on automatic refresh, separate from the predicate.** The predicate (context match + unmodified hashes) is necessary but not sufficient at user scope: one physical asset copy serves N projects and `installedFrom.projectRoot` is explicitly non-comparable. Encoding `shared-user-scope` as its own blocker keeps D4 ("warn-only, permanently") true without contorting D6's single predicate, and the remediation is provenance plus "install project scope for this project" — verified in Phase 0.1 (Appendix A.1, A.2: project scope wins the name collision in both harnesses).

**Warnings are stderr-first with additive JSON fields.** `run init` returns a `{ok, data}` envelope on stdout (`src/output.ts:230-251`); printing a warning there would break parsers, and dropping it entirely would hide the signal from humans. Warnings go to stderr as formatted text, plus an additive `warnings: string[]` and `harness_freshness` array in the JSON data. Additive fields are safe under the v2 policy for area #1 ("purely additive", `200-overview.md` §4).

**Suppression is one config key with no state.** `harness.freshnessWarnings = "on" | "off"` (default `"on"`) and `harness.autoSync` (default `false`). No TTL file, no session flag — D5.

---

## Architecture Overview

```
                       ┌─────────────────────────────────────────┐
                       │ src/harnesses/manifest.ts               │
                       │  MANIFEST_FILENAME = ".5x-manifest.json"│
                       │  computeFingerprint / normalizeInputs   │
                       │  readManifest / writeManifest / remove  │
                       │  compareManifest  (Tier 1 | Tier 2)     │
                       └──────────────┬──────────────────────────┘
                                      │ (harness-agnostic; no plugin import)
        ┌──────────────┬──────────────┼───────────────┬──────────────────┐
        │              │              │               │                  │
┌───────▼──────┐ ┌─────▼───────┐ ┌────▼────────┐ ┌────▼─────────┐ ┌──────▼──────┐
│ harness      │ │ harness     │ │ harness     │ │ run init     │ │ upgrade     │
│ install      │ │ uninstall   │ │ sync (new)  │ │ config set   │ │ (sweep)     │
│ write        │ │ remove      │ │ T2 + force  │ │ harness list │ │ T1 + gated  │
│ manifest     │ │ manifest    │ │ install     │ │ Tier 1 warn  │ │ auto-sync   │
└───────┬──────┘ └─────────────┘ └────┬────────┘ └──────────────┘ └─────────────┘
        │                             │
        └────────────┬────────────────┘
                     ▼
      plugin.renderAssets(ctx) ──► RenderedAsset[]  ──►  install writers
                     │                                   (installSkillFiles /
                     └── (dry, no writes) ──► Tier 2      installAgentFiles /
                                              compare      installRuleFiles)
```

Freshness state machine per (harness, scope):

```
  no assets on disk              ──► not-installed  (no warning)
  assets, no/unreadable manifest ──► unknown        (warn: run `5x harness sync` to baseline)
  manifest.configResolved=false  ──► unknown        (same copy)
  manifest.baseline="unverified" ──► unknown        (warn: partial install, show deltas if known)
  fingerprint(inputs) mismatch   ──► stale          (warn: show changed fields)
  fingerprint match, Tier 1 only ──► fresh          (silent)
  fingerprint match, Tier 2:
     re-render hash ≠ recorded   ──► stale          (template drift; sync will change it)
     on-disk hash  ≠ recorded    ──► stale + modified (hand-edit; blocks auto-sync)
```

`unknown` is never `fresh` and is never lossless-refreshable, so no fire point can fall silent and no command can auto-sync on the strength of a manifest that was never verified.

Lossless-refresh predicate (`losslessRefresh === true`) is the **safety** gate. It requires **all** of:

1. `scope === "project"` (D4 — user scope is never auto-refreshed),
2. `manifest.installedFrom.contextDir` equals the context resolving config right now,
3. every entry in `assets` still hashes to its recorded value,
4. `manifest.configResolved === true` and the manifest parsed cleanly,
5. `manifest.baseline === "verified"` — an unverified manifest is `unknown`, and `unknown` never refreshes automatically,
6. `tier === 2` — Tier 1 cannot see hand-edits, so it always reports `false` (§4.2).

The predicate is necessary but **not sufficient** for an automatic write. Permission is separate: `harness.autoSync = true` (default `false`), or an explicit `5x upgrade --sync` / `5x harness sync` invocation. See "Automatic refresh needs both a safety gate and a permission gate" above and Phase 7.1.

---

## Phase 0: Prerequisite verification spikes

> **Completion gate:** Findings for both spikes are recorded in this plan's Appendix A (edited in place, with dates and evidence), and Phase 5/6 warning copy is written against the verified answer — not the assumed one.

These are `201-harness-freshness.md` §5.1's carried prerequisites. They are cheap, they gate user-facing copy, and getting them wrong ships advice that does not work.

#### 0.1 Verify project-over-user asset precedence (OpenCode + Cursor)

§2.6's remediation — "install project scope for this project" — assumes project-scope assets take precedence over user-scope assets. The requirements doc flags this as **unverified and a hard prerequisite**.

Method (per harness):

1. Install user scope into a temp `HOME`: `5x harness install <name> --scope user`.
2. Install project scope into a temp repo with a *distinguishable* baked value (e.g. `author.model = "test/precedence-project"` vs `"test/precedence-user"`).
3. Confirm which agent profile / skill the harness actually loads (harness UI listing or its documented resolution order).

Outcomes:

- **Precedence holds** → keep the §2.6 remediation copy as designed.
- **Precedence does not hold** → the user-scope warning degrades to "warn and let the user choose" (no directive remediation), and Appendix A records that `201` §2.7 (shrink the bake surface) becomes materially more urgent.

- [x] Verify OpenCode project-over-user precedence; record evidence + date in Appendix A
- [x] Verify Cursor project-over-user precedence; record evidence + date in Appendix A
- [x] Decide and record the user-scope remediation string for Phase 5

**Result: precedence holds for both harnesses** (Appendix A). The §2.6 remediation copy stands as designed — Phase 5's user-scope warning keeps its directive `fix 5x harness install <name> --scope project` line.

#### 0.2 Smoke-test manifest dotfile inertness against *config* discovery

Asset discovery is inert by construction (all three harnesses read from subdirectories — `src/harnesses/locations.ts`). The plausible collision is config discovery: `.opencode/opencode.json` and `.cursor/mcp.json` live at the root.

- [x] OpenCode: place `.opencode/.5x-manifest.json`, launch OpenCode, confirm no config parse error / no unexpected config merge
- [x] Cursor: place `.cursor/.5x-manifest.json`, launch Cursor, confirm the same
- [x] Universal (`.agents/`): confirm no tooling reads root-level files
- [x] Record results + versions tested in Appendix A

**Result: the dotfile is inert at every scope tested** (Appendix A). No design change; `MANIFEST_FILENAME = ".5x-manifest.json"` at `locations.rootDir` stands.

---

## Phase 1: `src/harnesses/manifest.ts` — schema, hashing, read/write

> **Completion gate:** `bun test test/unit/harnesses/manifest.test.ts` passes; the module has zero imports from `factory.ts` or any `*/plugin.ts` (verified by an import assertion in the test); `bunx tsc --noEmit` clean.

Pure module, no CLI dependency, no plugin dependency. Everything in later phases builds on it.

#### 1.1 Types and constants

**File:** `src/harnesses/manifest.ts` (new)

```typescript
import type { HarnessScope } from "./types.js";

export const MANIFEST_FILENAME = ".5x-manifest.json";
export const MANIFEST_VERSION = 1;

/** One installed file, path relative to `locations.rootDir`, POSIX separators. */
export interface ManifestAssetEntry {
	path: string;
	sha256: string;
}

/**
 * The normalized baked-input surface (§2.2). `null` means "not baked"
 * (e.g. no model configured) and is distinct from the empty string.
 */
export interface ManifestInputs {
	authorModel: string | null;
	reviewerModel: string | null;
	authorDelegationMode: "native" | "invoke" | null;
	reviewerDelegationMode: "native" | "invoke" | null;
	/** `src/version.ts` value at install time. */
	cliVersion: string;
	/** Bundled plugins report the CLI version; external packages report their own. */
	harnessPluginVersion: string;
	/** Optional plugin-contributed inputs (D1). Empty for all bundled plugins. */
	plugin: Record<string, string | number>;
}

export interface ManifestProvenance {
	/** Absolute; advisory only; never compared for equality (§2.1). */
	projectRoot: string;
	/** Relative to `projectRoot`, POSIX separators, "" for the root context. */
	contextDir: string;
}

/**
 * Whether the recorded `inputs` are a trustworthy freshness baseline.
 *
 * - `"verified"`: at write time every asset the plugin renders for this
 *   context byte-matched the file on disk, so `inputs`/`hash` describe
 *   exactly what is installed. Only this value can ever compare `fresh`.
 * - `"unverified"`: the installed file set is a mixture — e.g. a non-force
 *   `harness install` skipped existing agent files (`installer.ts:100-104`)
 *   while skills were re-rendered. `inputs` then describe the last verified
 *   bake (retained from a prior manifest) or, absent one, the attempted bake
 *   for diagnostics only. Compares as `unknown` until `sync` re-establishes
 *   a baseline.
 */
export type ManifestBaseline = "verified" | "unverified";

export interface HarnessManifest {
	manifestVersion: number;
	harness: string;
	scope: HarnessScope;
	/** "sha256:<hex>" over the canonicalized `inputs`. */
	hash: string;
	/** false when config resolution threw at install time (§2.1). */
	configResolved: boolean;
	/** Trust level of `inputs`/`hash` as a freshness baseline (§3.2). */
	baseline: ManifestBaseline;
	installedFrom: ManifestProvenance;
	/**
	 * The baked-input surface `hash` covers. Meaningful as a baseline only
	 * when `baseline === "verified"`; otherwise diagnostic (drives warning
	 * copy) and never a basis for `fresh`.
	 */
	inputs: ManifestInputs;
	/** ISO-8601 UTC of the last manifest write. */
	installedAt: string;
	/**
	 * Always the true on-disk bytes at write time, regardless of `baseline`,
	 * so hand-edit detection stays accurate across partial installs.
	 */
	assets: ManifestAssetEntry[];
}
```

- [x] Add the types above with doc comments mirroring the rationale in `201` §2.1
- [x] Re-export `HarnessScope` type usage from `./types.js` (do not redeclare)
- [x] `baseline` participates in the shape guard but **not** in `computeFingerprint` — it describes the manifest's trustworthiness, not the bake

#### 1.2 Canonicalization and hashing

**File:** `src/harnesses/manifest.ts`

Normalization must make semantically-equal configs hash equal: stable key order, trimmed model strings, `undefined`/`""` collapsed to `null`, delegation mode defaulted explicitly.

```typescript
import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string { /* … */ }

export function normalizeInputs(raw: {
	authorModel?: string;
	reviewerModel?: string;
	authorDelegationMode?: "native" | "invoke";
	reviewerDelegationMode?: "native" | "invoke";
	cliVersion: string;
	harnessPluginVersion: string;
	plugin?: Record<string, string | number>;
}): ManifestInputs;

/** "sha256:<hex>" over canonicalJson(normalizeInputs(...)). */
export function computeFingerprint(inputs: ManifestInputs): string;

/** "<hex>" sha256 of a UTF-8 file body. Used for `assets[].sha256`. */
export function hashContent(content: string): string;
```

Normalization rules (each gets a unit test):

| Input | Normalized |
|---|---|
| `undefined`, `""`, `"   "` model | `null` |
| `" anthropic/claude-sonnet-4-6 "` | `"anthropic/claude-sonnet-4-6"` |
| `undefined` delegation mode | `"native"` (matches `authorNative = mode !== "invoke"` in `opencode/plugin.ts:65`) |
| `plugin` absent | `{}` |
| key order in `plugin` | sorted |

- [x] Implement `canonicalJson` (recursive sort; arrays keep order; rejects non-JSON values)
- [x] Implement `normalizeInputs` per the table
- [x] Implement `computeFingerprint` and `hashContent`
- [x] Unit test: two configs differing only in key order / whitespace hash equal
- [x] Unit test: changing any one of the six scalar inputs changes the hash
- [x] Unit test: `plugin: {}` vs `plugin` absent hash equal

#### 1.3 Read / write / remove

**File:** `src/harnesses/manifest.ts`

```typescript
export function manifestPath(rootDir: string): string;

/**
 * Returns null on: missing file, unreadable file, invalid JSON, shape
 * mismatch, or `manifestVersion > MANIFEST_VERSION`. Never throws.
 * Callers treat null as unknown/stale (§4).
 */
export function readManifest(rootDir: string): HarnessManifest | null;

/** Writes pretty-printed JSON + trailing newline. Creates rootDir if absent. */
export function writeManifest(rootDir: string, manifest: HarnessManifest): void;

/** Returns true if a manifest existed and was removed. */
export function removeManifest(rootDir: string): boolean;

/** Normalize an absolute asset path to a manifest-relative POSIX path. */
export function toManifestPath(rootDir: string, absolutePath: string): string;
```

Validation in `readManifest` is a hand-written shape guard (not Zod) to keep the module dependency-free and cheap on Tier 1 hot paths; it checks `manifestVersion` is a number ≤ `MANIFEST_VERSION`, `harness`/`hash`/`installedAt` are strings, `scope` ∈ `{project,user}`, `configResolved` is boolean, `baseline` ∈ `{verified,unverified}`, `inputs` and `installedFrom` are objects, and `assets` is an array of `{path, sha256}` strings.

A missing or unrecognized `baseline` is **not** defaulted to `"verified"` — the guard rejects it and `readManifest` returns `null`, so an old or hand-written manifest fails closed to `unknown` rather than asserting a baseline nobody verified.

- [x] Implement the five functions
- [x] Unit test: round-trip write → read returns a deep-equal manifest, `baseline` included
- [x] Unit test: each corruption mode (missing, `"{"`, `[]`, `manifestVersion: 99`, missing `assets`, missing `baseline`, `baseline: "yes"`) returns `null`
- [x] Unit test: `removeManifest` returns `false` when absent, `true` after a write
- [x] Unit test: `toManifestPath` emits `skills/5x-plan/SKILL.md` on both separators

---

## Phase 2: Plugin contract — `renderAssets()` and one render path

> **Completion gate:** All three bundled plugins implement `renderAssets()`; each plugin's `install()` derives its writes from that call; the full existing harness test suite (`test/unit/harnesses/`, `test/integration/commands/harness*.test.ts`) passes **unchanged** — this phase must be behavior-preserving.

#### 2.1 Extend `HarnessPlugin`

**File:** `src/harnesses/types.ts`, after line 107

```typescript
/** One rendered asset, produced without writing to disk. */
export interface RenderedAsset {
	kind: "skill" | "agent" | "rule";
	/** Asset name without directory or extension (e.g. "5x-plan", "5x-plan-author"). */
	name: string;
	/** Path relative to `locations.rootDir`, POSIX separators. */
	path: string;
	content: string;
}

export interface HarnessPlugin {
	// … existing members unchanged …

	/**
	 * Render every managed asset for this context **without writing**.
	 * Enables the Tier 2 freshness check (`201` §2.2) and is the single
	 * render path `install()` itself consumes. Optional so external
	 * plugins remain valid; omitting it degrades Tier 2 to on-disk-vs-
	 * recorded hash comparison (hand-edit detection only).
	 */
	renderAssets?(ctx: HarnessInstallContext): Promise<RenderedAsset[]>;

	/**
	 * Extra fingerprint inputs for harnesses that bake something outside
	 * the common set. Stored under `inputs.plugin` so it can never collide
	 * (D1). No bundled plugin implements this.
	 */
	fingerprintInputs?(ctx: HarnessInstallContext): Record<string, string | number>;

	/** Plugin version for the fingerprint. Bundled plugins omit it (CLI version is used). */
	readonly version?: string;
}
```

`isValidPlugin` (`src/harnesses/factory.ts:93-107`) is **not** tightened — both new members are optional, so external plugins written against the current contract stay valid.

- [x] Add `RenderedAsset`, `renderAssets?`, `fingerprintInputs?`, `version?`
- [x] Unit test in `test/unit/harnesses/factory.test.ts`: a plugin without the new members still passes `isValidPlugin`

#### 2.2 OpenCode plugin — extract render, keep install semantics

**File:** `src/harnesses/opencode/plugin.ts`, lines 56-108

Extract the existing body of `install()` up to the write calls into `renderAssets()`, then rewrite `install()` to dispatch:

```typescript
async renderAssets(ctx: HarnessInstallContext): Promise<RenderedAsset[]> {
	const authorNative = ctx.config.authorDelegationMode !== "invoke";
	const reviewerNative = ctx.config.reviewerDelegationMode !== "invoke";
	const skillRenderContext = createRenderContext(
		authorNative && reviewerNative,
		authorNative,
		reviewerNative,
	);

	const out: RenderedAsset[] = [];
	for (const s of listSkills(skillRenderContext)) {
		out.push({ kind: "skill", name: s.name, path: `skills/${s.name}/SKILL.md`, content: s.content });
	}
	for (const a of renderAgentTemplates({
		authorModel: ctx.config.authorModel,
		reviewerModel: ctx.config.reviewerModel,
		authorInvoke: !authorNative,
		reviewerInvoke: !reviewerNative,
	})) {
		out.push({ kind: "agent", name: a.name, path: `agents/${a.name}.md`, content: a.content });
	}
	return out;
}
```

`install()` then becomes:

```typescript
async install(ctx: HarnessInstallContext): Promise<HarnessInstallResult> {
	const locations = opencodeLocationResolver.resolve(ctx.scope, ctx.projectRoot, ctx.homeDir);
	const rendered = await this.renderAssets!(ctx);

	const skills = installSkillFiles(
		locations.skillsDir,
		rendered.filter((a) => a.kind === "skill").map((a) => ({ name: a.name, content: a.content })),
		ctx.force,
	);
	const agentTemplates = rendered
		.filter((a) => a.kind === "agent")
		.map((a) => ({ name: a.name, content: a.content }));
	const agents = installAgentFiles(locations.agentsDir, agentTemplates, ctx.force);

	const staleRemoved = removeStaleAgentFiles(
		locations.agentsDir,
		agentTemplates.map((t) => t.name),
		listAgentTemplates().map((t) => t.name),
	);
	if (staleRemoved.length > 0) agents.removed = staleRemoved;

	return { skills, agents };
}
```

Note: the path prefixes (`skills/`, `agents/`, `rules/`) are the *relative* form of `locations.skillsDir` etc. against `rootDir` for all three shipped resolvers (`src/harnesses/locations.ts:79-96, 116-133, 156-173`). Phase 2.5 adds an assertion so a future resolver that breaks that assumption fails loudly.

- [x] Extract `renderAssets()`; rewrite `install()` as a dispatcher
- [x] Unit test: `renderAssets()` output is byte-identical to what `install()` writes (read back from a temp dir)
- [x] Unit test: `authorDelegationMode: "invoke"` omits author agents from `renderAssets()`

#### 2.3 Cursor plugin — same extraction, plus rules

**File:** `src/harnesses/cursor/plugin.ts`, lines 54-124

Identical extraction. Rules render from static templates with no config inputs and only at project scope:

```typescript
if (ctx.scope === "project" && locations.rulesDir) {
	out.push({ kind: "rule", name: "5x-orchestrator", path: "rules/5x-orchestrator.mdc", content: ruleTemplate });
	out.push({ kind: "rule", name: "5x-permissions", path: "rules/5x-permissions.mdc", content: permissionsTemplate });
}
```

`install()` preserves the existing user-scope `unsupported`/`warnings` return shape verbatim.

- [x] Extract `renderAssets()`; rewrite `install()` as a dispatcher
- [x] Unit test: user scope yields no `kind: "rule"` assets; project scope yields exactly two
- [x] Unit test: existing `unsupported.rules` + warning text unchanged at user scope

#### 2.4 Universal plugin

**File:** `src/harnesses/universal/plugin.ts`, lines 42-53

`renderAllSkillTemplates(createRenderContext(false))` → skills only, no agents. Its fingerprint therefore varies only with CLI version — correct and worth a doc comment, since a universal install can only ever go stale on upgrade.

- [x] Extract `renderAssets()`; rewrite `install()` as a dispatcher
- [x] Unit test: no agent assets; skill set matches `listBaseSkillNames()`

#### 2.5 Guard the `rootDir`-relative path assumption

**File:** `src/harnesses/manifest.ts`

```typescript
/**
 * Derive manifest asset paths from a plugin's rendered assets, asserting
 * that each declared path resolves under `rootDir`. Throws
 * `MANIFEST_PATH_ESCAPE` otherwise — a location resolver whose asset dirs
 * are not under rootDir cannot be represented by a rootDir-relative manifest.
 */
export function assertAssetPathsUnderRoot(
	rootDir: string,
	locations: { skillsDir: string; agentsDir: string; rulesDir?: string },
): void;
```

- [x] Implement and call from the manifest-write path (Phase 3)
- [x] Unit test: a synthetic resolver with `skillsDir` outside `rootDir` throws

---

## Phase 3: Manifest write on install, removal on uninstall

> **Completion gate:** `5x harness install <name> --scope <scope>` writes a valid `.5x-manifest.json` at `locations.rootDir` for all three bundled harnesses at both scopes; a **first** install and any `--force` install record `baseline: "verified"`; a non-force reinstall that skips a stale agent file records `baseline: "unverified"` and does **not** adopt the new inputs as the baseline; `5x harness uninstall <name> --all` removes the manifest and leaves no orphan root directory; existing install/uninstall integration tests pass with only additive assertions.

#### 3.1 Track config-resolution success and context

**File:** `src/commands/harness.handler.ts`, lines 132-168

The current try/catch (lines 137-147) silently swallows resolution failure. Capture it:

```typescript
let configResolved = false;
let contextDir = cwd;                     // the dir passed to resolveLayeredConfig
try {
	const cp = resolveControlPlaneRoot(cwd);
	const { config } = await resolveLayeredConfig(cp.controlPlaneRoot, cwd);
	authorModel = resolveHarnessModelForRole(config, "author", name);
	reviewerModel = resolveHarnessModelForRole(config, "reviewer", name);
	authorDelegationMode = config.author.delegationMode;
	reviewerDelegationMode = config.reviewer.delegationMode;
	configResolved = true;
} catch {
	// Non-fatal (unchanged): agent templates render without model fields.
	// Recorded as configResolved: false so this install never masquerades
	// as fresh (§2.1).
}
```

- [x] Add `configResolved` tracking without changing the swallow behavior
- [x] Capture `contextDir` (the exact directory handed to `resolveLayeredConfig`)

#### 3.2 Verify the installed inventory, then build and write the manifest

**File:** `src/commands/harness.handler.ts`, after line 168

`install()` keeps its skip-on-exist semantics for agent files, so what is on disk after a non-force reinstall may be a mixture of freshly rendered skills and previously baked agents. The manifest write must therefore *prove* that the inputs it is about to record actually produced the files it is about to hash.

**Step 1 — collect on-disk truth.** After `plugin.install()` returns, build the asset set and hash the **on-disk bytes** of every path (never the rendered string). The path set is `plugin.renderAssets()`' paths ∪ every path named by the `InstallSummary` arrays (`created ∪ overwritten ∪ skipped`) resolved against `locations` ∪ every path recorded by a prior manifest that still exists on disk. Files that fail to read are omitted, not recorded with a bogus hash.

**Step 2 — verify.** `verifyInstalledInventory` decides whether the current inputs may become the baseline:

```typescript
/**
 * True only when every asset the plugin renders for this context is present
 * on disk with byte-identical content, and no rendered path failed to read.
 * A single skipped-stale agent file (or any drift) makes this false.
 */
export function verifyInstalledInventory(args: {
	/** null when the plugin does not implement `renderAssets()`. */
	rendered: RenderedAsset[] | null;
	onDisk: Map<string, string>;   // manifest-relative path → sha256 of on-disk bytes
	/** Every `InstallSummary` the plugin returned — the fallback evidence. */
	summaries: InstallSummary[];
}): boolean;
```

- Plugins that implement `renderAssets()` (all three bundled) are verified by byte comparison: `hashContent(asset.content) === onDisk.get(asset.path)` for every rendered asset.
- Plugins that omit `renderAssets()` have no render to compare against, so the fallback is the conservative structural rule: verified **iff** every `InstallSummary.skipped` array is empty. This can under-report freshness for an external plugin that legitimately skips byte-identical files; under-reporting costs one `sync`, over-reporting costs a silent stale bake. No bundled plugin takes this path.

**Step 3 — write.** One rule, applied identically at every scope and harness:

```typescript
const prior = readManifest(locations.rootDir);   // null when absent/corrupt; install never touches it
const rendered = (await plugin.renderAssets?.(installCtx)) ?? null;
const summaries = [result.skills, result.agents, result.rules].filter(Boolean);
const onDisk = collectInstalledAssets(rendered, summaries, prior, locations);        // step 1
const verified = verifyInstalledInventory({ rendered, onDisk, summaries });          // step 2
const currentInputs = {
	authorModel, reviewerModel, authorDelegationMode, reviewerDelegationMode,
	cliVersion: version,
	harnessPluginVersion: plugin.version ?? version,
	plugin: plugin.fingerprintInputs?.(installCtx) ?? {},
};

const manifest = buildManifest({
	harness: name,
	scope,
	projectRoot,
	contextDir,
	rootDir: locations.rootDir,
	locations,
	// Verified: adopt the current bake as the baseline.
	// Unverified: retain the prior baseline if there is one (so the warning can
	// still name the changed fields); otherwise record the attempted inputs for
	// diagnostics only. Either way `baseline: "unverified"` forbids `fresh`.
	baseline: verified ? "verified" : "unverified",
	configResolved: verified ? configResolved : (prior?.configResolved ?? configResolved),
	inputs: verified ? currentInputs : (prior?.inputs ?? currentInputs),
	// Always the true on-disk bytes — a normal reinstall must never look like a hand-edit.
	assets: assetsFromOnDisk(onDisk),
});
writeManifest(locations.rootDir, manifest);
```

`buildManifest` recomputes `hash` from whichever `inputs` it was handed, so `hash` and `inputs` never disagree. `installedFrom` and `installedAt` always describe **this** install (they document the last write, not the baseline); the predicate cannot be fooled by that because `baseline: "unverified"` is already a blocker.

Consequences, stated so the tests can assert them directly:

| Situation | `baseline` | `inputs` recorded | Tier 1 verdict |
|---|---|---|---|
| First install (no assets on disk) | `verified` | current | `fresh` |
| `install --force` | `verified` | current | `fresh` |
| Reinstall, nothing changed (all bytes already match) | `verified` | current | `fresh` |
| Reinstall after a model change, agents skipped | `unverified` | prior (model A) | `unknown` — warns, names A → B |
| Reinstall over a manifest-less install, agents skipped | `unverified` | current (diagnostic) | `unknown` — warns "no verified baseline" |
| `5x harness sync` (force path) | `verified` | current | `fresh` |

The false-fresh path the review flagged is closed at the source: after model A → config B → plain `harness install`, the manifest still carries A's fingerprint (or none), so Tier 1 keeps warning on every hot path until `sync` runs.

- [x] Add `buildManifest(...)` to `src/harnesses/manifest.ts` (assembles + computes `hash` via `computeFingerprint` over the `inputs` it is given; takes `baseline` explicitly — no default)
- [x] Add `collectInstalledAssets(rendered, summaries, prior, locations)` (read-back hashing of the union path set: `renderAssets` paths + `InstallSummary` paths + still-present prior-manifest paths) — takes one options object, and summaries are kind-tagged (`KindedInstallSummary`) since a summary's bare entries (`5x-plan/SKILL.md`) only resolve against the directory for their kind
- [x] Add `verifyInstalledInventory(...)` with the byte-compare path and the `skipped`-empty fallback
- [x] Wire the read-prior → verify → write sequence into `harnessInstall` after `plugin.install` succeeds (never on throw)
- [x] Print `  Wrote manifest: .5x-manifest.json` in `printInstallSummary` (`harness.handler.ts:388-444`); when `baseline === "unverified"`, print the reason and the fix on stderr: `existing assets were preserved — freshness baseline not established; run '5x harness sync'`, listing the skipped paths — narrowed to the paths whose on-disk bytes actually differ from the render (a model change skips every byte-identical skill too, and listing those buries the one stale agent); the full skipped set remains the fallback for plugins without `renderAssets()`
- [x] Integration test: install opencode project scope → manifest exists, `configResolved: true`, `baseline: "verified"`, inputs match `5x.toml`
- [x] Integration test: install with an unparseable `5x.toml` → `configResolved: false`, models `null`
- [x] Integration test: `installedFrom.contextDir` is `"packages/api"` when installing from a sub-project
- [x] Integration test **(review §1 regression, end-to-end)**: install with `author.model = A`; `5x config set author.model B`; plain `5x harness install opencode -s project` (no `--force`) → agent frontmatter still says `A`, manifest has `baseline: "unverified"` and still records `authorModel: A` — `test/integration/commands/harness-manifest.test.ts`. The `Tier 1 reports unknown` and `then 5x harness sync → fresh` halves need `compareManifest` (Phase 4) and `harness sync` (Phase 6); the test asserts the `--force` equivalent for now and Phase 6.3 carries the full sequence.
- [x] Integration test: same flow but with `--force` → `baseline: "verified"` in one step, no warning afterwards
- [x] Integration test: install twice with no config change → second manifest is still `baseline: "verified"` (byte-identical files are verified, not penalized)
- [x] Unit test: `verifyInstalledInventory` returns false when one rendered asset's on-disk hash differs, false when a rendered path is missing from `onDisk`, true when all match
- [x] Unit test: the unverified write retains the prior `inputs`/`hash`/`configResolved` and refreshes `assets` to on-disk hashes

#### 3.3 Remove the manifest on uninstall, before the emptiness sweeps

**File:** `src/commands/harness.handler.ts`, lines 329-337

`removeDirIfEmpty` runs only over `skillsDir` / `agentsDir` / `rulesDir` (`src/harnesses/installer.ts:213`), so a root-level manifest survives a full uninstall and keeps an otherwise-empty `.opencode/` alive.

```typescript
for (const s of scopesToProcess) {
	const locations = plugin.locations.resolve(s, projectRoot, params.homeDir);
	const manifestRemoved = removeManifest(locations.rootDir);   // BEFORE uninstall
	scopes[s] = await plugin.uninstall({ scope: s, projectRoot, homeDir: params.homeDir });
	removeDirIfEmpty(locations.rootDir);                          // now able to succeed
	manifests[s] = manifestRemoved;
}
```

- [x] Remove manifest before `plugin.uninstall`, sweep `rootDir` after
- [x] Add `manifests: Partial<Record<HarnessScope, boolean>>` to `HarnessUninstallOutput`
- [x] Integration test: `uninstall --all` leaves no `.opencode/` directory when 5x created it
- [x] Integration test: `.opencode/` containing a user's own `opencode.json` survives (sweep is empty-only)

---

## Phase 4: Freshness engine — compare, discovery, config keys

> **Completion gate:** `compareManifest()` returns correct `status` / `reason` / `losslessRefresh` for the full matrix in `test/unit/harnesses/manifest-compare.test.ts`; `harness.freshnessWarnings` and `harness.autoSync` appear in `5x config show`; no command behavior has changed yet (engine only).

#### 4.1 Compare result types

**File:** `src/harnesses/manifest.ts`

```typescript
export type FreshnessStatus = "fresh" | "stale" | "unknown" | "not-installed";

export type FreshnessReason =
	| "no-manifest"
	| "manifest-unreadable"
	| "config-unresolved"
	/** `baseline: "unverified"` — a partial install never established a baseline (§3.2). */
	| "baseline-unverified"
	| "inputs-changed"
	| "assets-drifted"
	| "assets-modified"
	| null;

export interface InputDelta {
	/** Dotted config-facing key, e.g. "author.model". */
	key: string;
	installed: string | null;
	current: string | null;
}

export type AssetDeltaState =
	/** on-disk ≠ recorded → user hand-edited it (blocks lossless refresh) */
	| "modified"
	/** recorded, absent on disk */
	| "missing"
	/** re-render ≠ recorded → bundled-template or config drift; sync will rewrite */
	| "drifted"
	/** re-render produced a path not in the manifest; sync will create it */
	| "added"
	/** recorded path no longer rendered; sync will remove it */
	| "orphaned";

export interface AssetDelta { path: string; state: AssetDeltaState }

export type LosslessBlocker =
	| "shared-user-scope"
	| "context-mismatch"
	| "assets-modified"
	| "no-manifest"
	| "config-unresolved"
	| "baseline-unverified";

export interface FreshnessReport {
	harness: string;
	scope: HarnessScope;
	rootDir: string;
	tier: 1 | 2;
	status: FreshnessStatus;
	reason: FreshnessReason;
	inputDeltas: InputDelta[];
	/** Empty at Tier 1. */
	assetDeltas: AssetDelta[];
	/** Safety gate only — never a permission to write (§Phase 7.1). */
	losslessRefresh: boolean;
	losslessBlockers: LosslessBlocker[];
	installedFrom: ManifestProvenance | null;
	/** `null` when there is no readable manifest. */
	baseline: ManifestBaseline | null;
}
```

#### 4.2 `compareManifest`

**File:** `src/harnesses/manifest.ts`

```typescript
export interface CompareArgs {
	harness: string;
	scope: HarnessScope;
	rootDir: string;
	/** True when any managed asset exists on disk (drives "not-installed"). */
	installed: boolean;
	/** Inputs resolved from config right now, pre-normalization. */
	current: Parameters<typeof normalizeInputs>[0];
	/** Context resolving config right now, relative to projectRoot, POSIX. */
	currentContextDir: string;
	/** Tier 2 only: freshly rendered assets. Omit for Tier 1. */
	rendered?: RenderedAsset[];
	/** Tier 2 only: reads a manifest-relative path; returns null if absent. */
	readAsset?: (relPath: string) => string | null;
}

export function compareManifest(args: CompareArgs): FreshnessReport;
```

Algorithm:

1. `!args.installed` → `not-installed`, no blockers evaluated, no warning downstream.
2. `readManifest(rootDir)` is `null` → `unknown` / `no-manifest` (or `manifest-unreadable` when the file exists but failed validation), `losslessRefresh: false`, blocker `no-manifest`.
3. `manifest.configResolved === false` → `unknown` / `config-unresolved`, blocker `config-unresolved` (§4 — identical treatment to missing).
4. `manifest.baseline === "unverified"` → `unknown` / `baseline-unverified`, blocker `baseline-unverified`. **Evaluated before the fingerprint compare and terminal for `status`** — an unverified manifest can never be `fresh`, and the fingerprint over its retained inputs would otherwise decide the verdict. `inputDeltas` are still computed (step 5's field-by-field diff) so the warning can name `installed author.model = A` / `current author.model = B`; when the manifest carried no prior baseline the deltas are diagnostic and the copy falls back to the unknown variant. Tier 2 asset deltas are still populated when requested, because `sync` needs them.
5. Tier 1: `computeFingerprint(normalizeInputs(args.current))` vs `manifest.hash`. Mismatch → `stale` / `inputs-changed`, with `inputDeltas` computed field-by-field over the six scalar inputs plus a `plugin.<key>` entry per differing plugin input.
6. Tier 2 (only when `rendered` and `readAsset` are supplied):
   - For each recorded asset: on-disk missing → `missing`; on-disk hash ≠ recorded → `modified`.
   - For each rendered asset: hash ≠ recorded → `drifted`; path absent from manifest → `added`.
   - Recorded path absent from `rendered` → `orphaned`.
   - Any `modified` → `status: "stale"`, `reason: "assets-modified"` (takes precedence in reporting; it is the case that blocks refresh) — unless step 4 already set `unknown`, which outranks it.  Otherwise any `drifted`/`added`/`orphaned` → `stale` / `assets-drifted`.
7. Lossless predicate (safety gate only): `losslessRefresh = tier === 2 && status !== "unknown" && manifest.baseline === "verified" && scope === "project" && manifest.installedFrom.contextDir === args.currentContextDir && no "modified" assets`. Blockers accumulate `baseline-unverified`, `shared-user-scope`, `context-mismatch`, `assets-modified` respectively.

> Tier 1 cannot observe `modified` assets, so a Tier-1-only report sets `losslessRefresh` optimistically **only for reporting**; every automatic-refresh caller (`autoSync`, `upgrade`) must run Tier 2 before acting. Encoded by requiring `tier === 2` for `losslessRefresh === true` — Tier 1 always reports `false` with blocker list unchanged. This makes it impossible to auto-sync on incomplete evidence.

> `losslessRefresh === true` means "refreshing would lose nothing" — **not** "go ahead". Callers must independently establish permission (`harness.autoSync = true`, or an explicit `--sync` / `5x harness sync` invocation) before writing anything. See Phase 7.1.

- [ ] Implement `compareManifest` per the algorithm
- [ ] Unit test matrix: not-installed / no-manifest / unreadable / config-unresolved / baseline-unverified / fresh / each single-input change
- [ ] Unit test: `baseline: "unverified"` whose recorded inputs *match* current config still returns `unknown`, never `fresh` (the false-fresh regression at unit level)
- [ ] Unit test: `baseline: "unverified"` with retained prior inputs still populates `inputDeltas` naming the changed key
- [ ] Unit test: Tier 2 detects `modified`, `drifted`, `added`, `orphaned` independently and in combination
- [ ] Unit test: Tier 1 never returns `losslessRefresh: true`
- [ ] Unit test: `baseline: "unverified"` never returns `losslessRefresh: true`, even at Tier 2 with matching context and no hand-edits
- [ ] Unit test: user scope with a perfect match still returns `losslessRefresh: false` + `shared-user-scope`
- [ ] Unit test: `contextDir` `"packages/api"` vs `""` yields `context-mismatch`

#### 4.3 Installed-scope discovery

**File:** `src/harnesses/freshness.ts` (new) — the orchestration layer that loads plugins, resolves config, and produces reports. Kept separate from `manifest.ts` so the latter stays plugin-free and cheap.

```typescript
export interface FreshnessCheckOptions {
	startDir?: string;
	homeDir?: string;
	/** Restrict to one harness; default = all bundled harnesses. */
	harness?: string;
	/** Restrict to one scope; default = every supported scope. */
	scope?: HarnessScope;
	/** Run the re-render comparison. Default false (Tier 1). */
	tier2?: boolean;
}

/** Public seam consumed by `run init`, `config set`, `harness list`, `sync`, `upgrade`, and (later) `doctor`. */
export async function runHarnessFreshnessChecks(
	options?: FreshnessCheckOptions,
): Promise<FreshnessReport[]>;

/** Human-readable warning block for one stale report (§2.4 copy). */
export function formatFreshnessWarning(report: FreshnessReport): string;

/** True when `harness.freshnessWarnings` is "on" (default) for the resolved config. */
export async function freshnessWarningsEnabled(startDir?: string): Promise<boolean>;
```

`runHarnessFreshnessChecks` reuses `buildHarnessListData()`-equivalent existence logic to decide `installed`, resolves config once via `resolveLayeredConfig`, and computes `currentContextDir` as `relative(projectRoot, contextDir)` normalized to POSIX (`""` at the root).

Warning copy (§2.4, verbatim shape):

```
⚠ opencode (project) assets are stale
  installed  author.model = anthropic/claude-sonnet-4-6
  current    author.model = anthropic/claude-opus-4-1
  fix        5x harness sync
```

Unknown-manifest variant:

```
⚠ opencode (project) assets have no manifest — freshness unknown
  fix        5x harness sync
```

Unverified-baseline variant — a plain `harness install` preserved existing agent files, so part of the install is still baked from the previous config (§3.2). With a retained prior baseline the deltas are shown; without one the `installed`/`current` lines are omitted:

```
⚠ opencode (project) assets are partially installed — freshness unknown
  installed  author.model = anthropic/claude-sonnet-4-6
  current    author.model = anthropic/claude-opus-4-1
  note       `harness install` preserved existing agent files; no verified baseline
  fix        5x harness sync
```

User-scope variant — wording settled by Phase 0.1, which verified project-over-user precedence for both OpenCode and Cursor (Appendix A.1, A.2), so the `fix` line stays directive:

```
⚠ opencode (user) assets were baked from /home/me/dev/foo
  installed  author.model = anthropic/claude-sonnet-4-6
  current    author.model = anthropic/claude-opus-4-1
  note       user-scope assets are shared across projects and are never auto-refreshed
  fix        5x harness install opencode --scope project
```

- [ ] Implement `runHarnessFreshnessChecks`, `formatFreshnessWarning`, `freshnessWarningsEnabled`
- [ ] Unit test: report set covers exactly the harness × supported-scope grid, filtered by options
- [ ] Unit test: `formatFreshnessWarning` renders only changed fields, never unchanged ones
- [ ] Unit test: the `baseline-unverified` report renders the partial-install variant, with and without retained deltas
- [ ] Unit test: a `not-installed` or `fresh` report produces no output from callers

#### 4.4 Config keys

**File:** `src/config.ts`, alongside `WorktreeSchema` (line 125) and registered in `FiveXConfigSchema` (line 143)

```typescript
const HarnessConfigSchema = z.object({
	freshnessWarnings: z
		.enum(["on", "off"])
		.default("on")
		.describe(
			"Warn when installed harness assets no longer match current config (`on`), or stay silent (`off`).",
		),
	autoSync: z
		.boolean()
		.default(false)
		.describe(
			"Opt in to automatic re-rendering of stale harness assets during `5x upgrade`. Off by default: with it off, upgrade only reports. When on, assets are still only rewritten where the refresh is provably lossless (project scope, verified baseline, matching install context, no local edits).",
		),
});

// in FiveXConfigSchema:
harness: HarnessConfigSchema.default({}).describe(
	"Harness asset freshness warnings and automatic re-sync behavior.",
),
```

`.describe()` is required — `src/config-registry.ts` derives `5x config show` / `config set` metadata by walking the Zod tree.

- [ ] Add `HarnessConfigSchema`; register under `harness`
- [ ] Unit test in `test/unit/config-registry.test.ts`: both keys appear with descriptions, types, and defaults
- [ ] Unit test: `harness.autoSync` resolves to `false` when the `harness` table is absent from `5x.toml` entirely (the default posture must survive a config that never mentions it)
- [ ] Unit test: `5x config set harness.autoSync true` round-trips through `configSet`

---

## Phase 5: Fire points — `run init`, `config set`, `harness list`

> **Completion gate:** Each fire point warns exactly once for a stale install, stays silent for `fresh` / `not-installed`, respects `harness.freshnessWarnings = "off"`, and leaves stdout JSON envelopes parseable (asserted in `test/integration/commands/text-output.test.ts` style tests). `5x invoke` produces no freshness output under any condition.

#### 5.1 `5x run init`

**File:** `src/commands/run-v1.handler.ts`, in `runV1Init` before each `outputSuccess` (lines 838 and 873)

Fires once per run, before any work is delegated. Tier 1 only.

```typescript
const freshness = (await freshnessWarningsEnabled(projectRoot))
	? await runHarnessFreshnessChecks({ startDir: dirname(planPath) })
	: [];
const stale = freshness.filter((r) => r.status === "stale" || r.status === "unknown");
for (const r of stale) console.error(formatFreshnessWarning(r));

outputSuccess({
	run_id: runId,
	// … existing fields unchanged …
	...(stale.length > 0
		? {
				warnings: stale.map((r) => `${r.harness} (${r.scope}) assets are ${r.status}`),
				harness_freshness: stale.map((r) => ({
					harness: r.harness, scope: r.scope, status: r.status, reason: r.reason,
				})),
			}
		: {}),
});
```

Context note: `run init` already anchors config to the plan's directory (`run-v1.handler.ts:737-745`), so the freshness check must use `dirname(planPath)` as `startDir` — using cwd would compare against the wrong context and produce a spurious `context-mismatch` in monorepos.

The check must never fail the command: wrap in try/catch and swallow (a broken freshness check blocking run creation would be strictly worse than the status quo).

- [ ] Wire Tier 1 check into both `outputSuccess` paths (new run and resumed run)
- [ ] Use `dirname(planPath)` as the context
- [ ] Guard with try/catch — freshness failures never abort `run init`
- [ ] Integration test: stale project install → stderr warning + `harness_freshness` in JSON data
- [ ] Integration test: `harness.freshnessWarnings = "off"` → no stderr, no extra JSON fields
- [ ] Integration test: stdout remains valid JSON with warnings present

#### 5.2 `5x config set`

**File:** `src/commands/config.handler.ts`, in `configSet` after the write (line 860)

Fires at the point of cause. Only for keys that are actually baked:

```typescript
const BAKED_CONFIG_KEYS = [
	"author.model",
	"reviewer.model",
	"author.delegationMode",
	"reviewer.delegationMode",
] as const;

/** True for a baked scalar key or any `<role>.harnessModels.<harness>` key. */
export function isBakedConfigKey(key: string): boolean {
	if ((BAKED_CONFIG_KEYS as readonly string[]).includes(key)) return true;
	return /^(author|reviewer)\.harnessModels\.[^.]+$/.test(key);
}
```

When `isBakedConfigKey(key)` and warnings are enabled, run Tier 1 for the context that was written to (`contextDir`, already computed at `config.handler.ts:820`) and print warnings to stderr. `config unset` / `config add` / `config remove` get the same treatment for baked keys — unsetting `author.model` changes the bake exactly as setting it does.

- [ ] Add `isBakedConfigKey`
- [ ] Wire the check into `configSet` and `configUnset` (and `configAdd`/`configRemove` when the key is baked)
- [ ] Guard with try/catch — a freshness failure never fails the write
- [ ] Unit test: `isBakedConfigKey` accepts the four scalars + `author.harnessModels.opencode`, rejects `maxStepsPerRun`, `author.provider`, `author.harnessModels`
- [ ] Integration test: `5x config set author.model X` on a fresh install warns; `5x config set maxStepsPerRun 10` does not

#### 5.3 `5x harness list` — freshness column

**File:** `src/commands/harness.handler.ts`, `HarnessScopeStatus` (line 63) and `buildHarnessListData` (line 202), formatter at line 449

```typescript
export interface HarnessScopeStatus {
	installed: boolean;
	root: string;
	files: string[];
	unsupported?: { rules?: boolean };
	capabilities?: { rules?: boolean };
	/** Tier 1 freshness (§2.4). Absent when the scope is not installed. */
	freshness?: {
		status: FreshnessStatus;
		reason: FreshnessReason;
		inputDeltas: InputDelta[];
	};
}
```

Text output gains one line per scope, after `installed:`:

```
project:
  installed: true
  freshness: stale (inputs-changed)
  root: /home/me/dev/foo/.opencode
```

`buildHarnessListData` already enumerates harnesses × scopes with existence checks; it resolves config once and reuses it across all entries so `list` stays a single config load.

- [ ] Add `freshness` to `HarnessScopeStatus`; populate in `buildHarnessListData`
- [ ] Add the `freshness:` line to `formatHarnessListText`
- [ ] Unit test: `buildHarnessListData` returns `freshness: undefined` for uninstalled scopes
- [ ] Integration test: `5x harness list --text` shows `stale` after a model change, `fresh` after `sync`

#### 5.4 Explicitly no fire point in `invoke`

**File:** `src/commands/invoke.handler.ts` — no change; add a comment recording the decision.

`invoke` runs per step, dozens of times per run, and rebaking mid-run would change agent behavior mid-run (D5). If a mid-run reminder later proves necessary, the path is a `staleAtInit` stamp on the run row surfaced once — not a new store.

- [ ] Add a short comment at the top of `invoke.handler.ts` pointing at `201` §2.4 so a future contributor does not "helpfully" add the check
- [ ] Integration test: `5x invoke` on a stale install emits nothing about freshness

---

## Phase 6: `5x harness sync`

> **Completion gate:** `5x harness sync` is idempotent (second run reports zero changes), refreshes **agent** files after a model change (the §1.1 bug), adopts manifest-less installs, refuses to clobber hand-edits without `--force`, and rewrites the manifest with `baseline: "verified"` on completion — sync is the *only* command guaranteed to establish a baseline. Verified by an integration test that reproduces §1.1 end-to-end.

#### 6.1 Handler

**File:** `src/commands/harness.handler.ts` (new exports) — `harnessSync`, `harnessSyncCore`

```typescript
export interface HarnessSyncParams {
	/** Restrict to one harness; default = every harness with a manifest or installed assets. */
	name?: string;
	scope?: string;
	/** Report only; make no writes. Runs Tier 2. */
	check?: boolean;
	/** Overwrite hand-edited assets. */
	force?: boolean;
	startDir?: string;
	homeDir?: string;
}

export interface HarnessSyncScopeResult {
	harness: string;
	scope: HarnessScope;
	root: string;
	/** "synced" | "adopted" | "skipped-fresh" | "skipped-modified" | "checked" | "sync-unverified" */
	action: string;
	before: FreshnessStatus;
	changed: string[];       // manifest-relative paths written
	removed: string[];       // stale managed assets removed
	preserved: string[];     // hand-edited paths left alone (no --force)
	notes: string[];
}

export interface HarnessSyncOutput {
	results: HarnessSyncScopeResult[];
	/** Stated explicitly: externally-published harnesses are not swept (§5.1). */
	sweptBundledOnly: true;
}
```

Flow per (harness, scope) with either a manifest or installed assets:

1. Run Tier 2 via `runHarnessFreshnessChecks({ tier2: true, ... })`.
2. `not-installed` → skip entirely (sync never *creates* a new install; that is `harness install`).
3. `fresh` → `skipped-fresh`, no writes. This is what makes sync idempotent. Note that `fresh` already implies `baseline === "verified"` (§4.2 step 4), so an unverified manifest never short-circuits here even when its retained inputs happen to match current config.
4. Hand-edits present (`assetDeltas` containing `modified`) and no `--force` → `skipped-modified`; list the paths in `preserved`; the command exits with `HARNESS_ASSETS_MODIFIED` (exit code 2, `INVALID_ARGS` class) when *every* target was blocked, otherwise completes and reports.
5. `--check` → `checked`, report the deltas sync *would* apply, no writes.
6. Otherwise: `await plugin.install({ ...ctx, force: true })` — the one render path (§2.5) — then run the **same** Phase 3.2 verify-then-write sequence. Because `force: true` overwrites every managed asset, `verifyInstalledInventory` passes and the manifest is written with `baseline: "verified"`; that is what makes sync the command that establishes a baseline. If verification somehow fails after a forced write (an unwritable path, a plugin that ignores `force`), the manifest is written `unverified` and the scope is reported as `sync-unverified` rather than claimed as fixed — sync never lies about its own result. `removeStaleAgentFiles` inside `install()` already keeps the delete blast radius to 5x-managed names.
7. No manifest (`unknown`/`no-manifest`) or an unverified manifest with no prior baseline → `adopted`: force-install, write a `verified` manifest, and print every overwritten path (§2.5 adoption; hand-edits are undetectable without a recorded hash, so legibility is the mitigation). An unverified manifest that *does* carry recorded asset hashes is not adoption — hand-edits are still detectable from those hashes, so step 4's protection applies normally.

- [ ] Implement `harnessSyncCore` + `harnessSync` (two-layer pattern matching `harnessList`/`harnessUninstall`)
- [ ] Reuse the Phase 3 manifest build **and verification** path — no second manifest assembler, no second definition of "verified"
- [ ] Add `"sync-unverified"` to the `action` union; report it as a failure-to-baseline, not a success
- [ ] Emit a proper `outputSuccess` envelope with a text formatter

#### 6.2 CLI wiring

**File:** `src/commands/harness.ts`, after the `list` subcommand (line 68)

```typescript
harness
	.command("sync")
	.summary("Re-render installed harness assets to match current config")
	.description(
		"Refresh installed skills and agent profiles so they match the current 5x\n" +
			"config. Targets whatever the on-disk manifests say is installed — no flags\n" +
			"required. Use --check to report without writing.",
	)
	.argument("[name]", "Harness name (default: all installed harnesses)")
	.addOption(new Option("-s, --scope <scope>", "Sync scope: user or project").choices(["user", "project"] as const))
	.option("--check", "Report what would change without writing")
	.option("-f, --force", "Overwrite locally modified assets")
	.addHelpText("after",
		"\nExamples:\n" +
			"  $ 5x harness sync                        # refresh every installed scope\n" +
			"  $ 5x harness sync opencode -s project\n" +
			"  $ 5x harness sync --check                # report only",
	)
	.action(async (name, opts) => {
		await harnessSync({ name, scope: opts.scope, check: opts.check, force: opts.force, homeDir: homedir() });
	});
```

- [ ] Register the subcommand with help text and examples
- [ ] Integration test: `5x harness sync --help` lists the flags

#### 6.3 Regression coverage for §1.1

The bug this command exists to fix deserves a named test:

- [ ] Integration test `sync refreshes baked agent models` — install opencode project scope with `author.model = A`; `5x config set author.model B`; assert the agent frontmatter still says `A`; run `5x harness sync`; assert it now says `B` **and** the skill markdown is unchanged where it should be, and that the manifest is `baseline: "verified"` with `authorModel: B`
- [ ] Integration test `no false-fresh via plain reinstall` (review §1) — same setup, but interpose a plain `5x harness install opencode -s project` before syncing: the manifest must be `baseline: "unverified"`, `harness list` must report `unknown` (not `fresh`), `run init` must still warn, and only the subsequent `sync` may flip it to `fresh`
- [ ] Integration test: `5x harness sync` twice → second run reports `skipped-fresh`, no file mtimes change
- [ ] Integration test: hand-edit `agents/5x-plan-author.md`; `sync` reports `skipped-modified` and preserves the edit; `sync --force` overwrites it
- [ ] Integration test: delete `.5x-manifest.json`; `sync` adopts (force-installs + writes manifest) and lists overwritten paths
- [ ] Integration test: `sync --check` writes nothing (assert mtimes + manifest unchanged)
- [ ] Integration test: delegation mode `native` → `invoke`, sync removes the now-orphaned author agent files and only those

---

## Phase 7: `5x upgrade` freshness sweep

> **Completion gate:** `5x upgrade` reports harness freshness for every bundled harness × scope, states that external harnesses are not swept, writes **nothing** under the default configuration (`harness.autoSync = false`, no flags), auto-syncs only when `harness.autoSync = true` **and** the lossless predicate holds, and honors `--sync` / `--no-sync`. A CLI-version bump alone (simulated) marks installs stale.

#### 7.1 New upgrade section

**File:** `src/commands/upgrade.handler.ts`, in `runUpgrade` after the Templates section (line 406)

A CLI upgrade changes bundled asset bytes, so *every* install is stale by construction afterwards — staying silent would turn the manifest into a chore the user chases on the next command rather than a safety net (D3).

```typescript
console.log("Harness assets:");
const harnessLog = await upgradeHarnessAssets(projectRoot, {
	sync: params.sync,      // undefined = config-driven; true/false = explicit override
	homeDir: params.homeDir,
});
for (const line of harnessLog) console.log(line);
console.log();
```

`upgradeHarnessAssets` behavior:

1. Enumerate installs via the same existence logic as `buildHarnessListData()` (`harness.handler.ts:202`) — bundled harnesses only.
2. Run Tier 2 checks (upgrade is not a hot path; correctness beats speed here).
3. Decide per scope. Permission and safety are evaluated separately and **both** must hold before anything is written:

   ```typescript
   // Permission: did the user ask for writes?
   const permitted =
       params.sync === false ? false            // --no-sync: never write
     : params.sync === true  ? true             // --sync: explicit per-invocation override
     : config.harness.autoSync === true;        // no flag: config decides, default false

   // Safety: would writing lose anything? (Tier 2 predicate, §4.2 step 7)
   // `--sync` asserts intent for *this* checkout, so it may override that one
   // blocker; nothing overrides a hand-edit, a shared user-scope copy, or an
   // unverified/absent baseline.
   const OVERRIDABLE: LosslessBlocker[] = ["context-mismatch"];
   const blockers = report.losslessBlockers.filter(
     (b) => !(params.sync === true && OVERRIDABLE.includes(b)),
   );
   const shouldSync =
     report.status === "stale" && permitted && report.tier === 2 && blockers.length === 0;
   ```

   With no flag, nothing is overridable, so `shouldSync` reduces exactly to `config.harness.autoSync && report.losslessRefresh`.

   - **Neither flag (the default path):** `harness.autoSync` decides, and it defaults to `false` — so a stock project is **report-only**, no matter how lossless the refresh would be. `losslessRefresh` alone never authorizes a write; it only decides whether an already-authorized write is safe.
   - `--sync`: explicit override of the config key for this invocation. Safety still applies — hand-edited assets are reported and preserved (upgrade exposes no `--force`; the remediation is `5x harness sync <name> --force`), and `shared-user-scope` still blocks (D4: user scope is never refreshed by an automatic sweep; the remediation is an explicit `5x harness sync <name> -s user`). `--sync` *does* override `context-mismatch`, since the user is asserting intent for this checkout.
   - `--no-sync`: report only, overriding `harness.autoSync = true`.
   - Everything not synced is reported with its blockers, plus — when the only thing missing was permission — the line `run '5x harness sync' (or set harness.autoSync = true)`.

   Precedence, stated once: `--no-sync` > `--sync` > `harness.autoSync` > report-only.
4. Always print the coverage caveat:

```
  Note: only bundled harnesses (opencode, cursor, universal) are checked.
        Externally-published harness packages are not swept — run
        `5x harness sync <name>` for those.
```

- [ ] Implement `upgradeHarnessAssets` in `upgrade.handler.ts` delegating to `harnessSyncCore`
- [ ] Add `sync?: boolean` to `UpgradeParams`; register `--sync` / `--no-sync` in `src/commands/upgrade.ts` (Commander maps `--no-sync` to `sync: false` and leaves `sync` `undefined` when neither is passed — assert this, since the tri-state is what makes "no flag ≠ `--sync`" work)
- [ ] Implement the permission/safety split exactly as written above — `losslessRefresh` must never appear on the permission side of the expression
- [ ] Print blockers per non-synced scope (`baseline-unverified`, `shared-user-scope`, `context-mismatch`, `assets-modified`) and the permission line when permission was the only thing missing
- [ ] Integration test **(review §2 regression)**: stale, lossless, project-scope install under the **default** config (no `harness` table in `5x.toml`, no flags) → upgrade reports it, mtimes and file bytes are unchanged, manifest untouched
- [ ] Integration test: same fixture with `harness.autoSync = true` → auto-synced; assets and manifest updated, `baseline: "verified"`
- [ ] Integration test: post-upgrade, a manifest with an older `cliVersion` reports stale; auto-syncs at project scope **only** with `autoSync = true` or `--sync`
- [ ] Integration test: user-scope install is reported but **never** synced by upgrade — with `autoSync = true` and with `--sync`
- [ ] Integration test: `--no-sync` reports and writes nothing even when `harness.autoSync = true`
- [ ] Integration test: `--sync` syncs a scope the predicate would have blocked for context mismatch, but still preserves a hand-edited asset and reports it
- [ ] Integration test: a `baseline: "unverified"` install is reported and never auto-synced under any flag combination short of an explicit `5x harness sync`
- [ ] Integration test: the bundled-only caveat appears in output

---

## Phase 8: Documentation, migration, and end-to-end validation

> **Completion gate:** `bun test` fully green; `bunx tsc --noEmit` clean; `bunx biome check` clean; `docs/v2/201-harness-freshness.md` status updated; README + AGENTS.md document `harness sync` and the two new config keys; a manual end-to-end pass against a real OpenCode and Cursor install is recorded.

#### 8.1 Documentation

- [ ] `README.md` — add `5x harness sync` to the command list; document `harness.freshnessWarnings` / `harness.autoSync` (stating that `autoSync` is off by default and that `upgrade` only reports until it is turned on or `--sync` is passed); state that plain `harness install` preserves existing agent files and therefore does not establish a freshness baseline — `sync` is the command that does
- [ ] `AGENTS.md` — note that the orchestrator should surface `harness_freshness` warnings from `run init` output rather than ignoring them
- [ ] `CHANGELOG.md` — additive entry: manifest, freshness warnings, `harness sync`, upgrade sweep
- [ ] `docs/v2/201-harness-freshness.md` — flip status from "Design settled — Not Implemented" to "Implemented", link this plan
- [ ] `src/harnesses/README.md` — document the manifest contract and the `renderAssets()` / `fingerprintInputs()` optional members for external plugin authors

#### 8.2 Migration behavior (§4)

Purely additive: pre-existing installs have no manifest, are treated as unknown/stale, and are prompted toward a single `5x harness sync`. No schema migration, no install output contract change beyond the added manifest file and the new sync envelope.

- [ ] Integration test: an install created *before* this feature (manifest deleted to simulate) produces exactly one `unknown` warning per fire point and is fixed by one `sync`
- [ ] Verify `.gitignore` guidance: project-scope manifests are intended to be committed alongside `.opencode/` (document; do not auto-ignore)

#### 8.3 Manual end-to-end pass

- [ ] Fresh repo → `5x init` → `5x harness install opencode -s project` → confirm manifest contents by eye
- [ ] `5x config set author.model <other>` → confirm the point-of-cause warning
- [ ] `5x run init` → confirm one warning, valid JSON on stdout
- [ ] Plain `5x harness install opencode -s project` → confirm the manifest reads `baseline: "unverified"`, the agent frontmatter is still the old model, and the warning **persists**
- [ ] `5x upgrade` with default config → confirm it reports and changes nothing on disk
- [ ] `5x harness sync` → confirm agent frontmatter updated, `baseline: "verified"`, warning gone
- [ ] Repeat for Cursor (including the project-scope rules) and Universal
- [ ] Re-run the Phase 0.2 dotfile smoke tests against the *real* manifest produced by the implementation

---

## Files Touched

| File | Change |
|------|--------|
| `src/harnesses/manifest.ts` | **New.** Manifest types (incl. `ManifestBaseline`), canonical JSON, fingerprint + content hashing, read/write/remove, `buildManifest`, `verifyInstalledInventory`, `compareManifest`, `toManifestPath`, `assertAssetPathsUnderRoot`. |
| `src/harnesses/freshness.ts` | **New.** Plugin-aware orchestration: `runHarnessFreshnessChecks`, `formatFreshnessWarning`, `freshnessWarningsEnabled`. |
| `src/harnesses/types.ts` | Add `RenderedAsset`; add optional `renderAssets?()`, `fingerprintInputs?()`, `version?` to `HarnessPlugin` (lines 108-134). |
| `src/harnesses/opencode/plugin.ts` | Extract `renderAssets()`; `install()` becomes a dispatcher over it (lines 56-108). |
| `src/harnesses/cursor/plugin.ts` | Same extraction, including project-scope rules (lines 54-124). |
| `src/harnesses/universal/plugin.ts` | Same extraction, skills only (lines 42-53). |
| `src/harnesses/installer.ts` | No behavior change; add doc comments cross-referencing the settled overwrite policy at `installFiles` (line 85) and `installSkillFiles` (line 127). |
| `src/commands/harness.handler.ts` | Track `configResolved` + `contextDir` (137-147); read prior manifest, verify the installed inventory, and write the manifest after install (168); remove manifest + sweep `rootDir` on uninstall (329-337); add `freshness` to `HarnessScopeStatus` (63) and populate it (202-267); add `harnessSync`/`harnessSyncCore`; extend `printInstallSummary` and `formatHarnessListText`. |
| `src/commands/harness.ts` | Register the `sync` subcommand with `--scope`, `--check`, `--force`. |
| `src/commands/run-v1.handler.ts` | Tier 1 check in `runV1Init` before both `outputSuccess` calls (838, 873); additive `warnings` / `harness_freshness` fields. |
| `src/commands/config.handler.ts` | `isBakedConfigKey`; Tier 1 check after `configSet` (860) / `configUnset` / baked-key `configAdd`/`configRemove`. |
| `src/commands/upgrade.handler.ts` | `upgradeHarnessAssets` section in `runUpgrade` after templates (406); permission (`--sync`/`--no-sync`/`harness.autoSync`) evaluated separately from the safety predicate; bundled-only caveat. |
| `src/commands/upgrade.ts` | Register `--sync` / `--no-sync`. |
| `src/commands/invoke.handler.ts` | Comment only — records that `invoke` is deliberately not a fire point (D5). |
| `src/config.ts` | `HarnessConfigSchema` (`freshnessWarnings`, `autoSync`) registered under `harness` in `FiveXConfigSchema` (143-211), with `.describe()` for the config registry. |
| `src/harnesses/README.md` | Document the manifest contract and optional plugin members. |
| `README.md`, `AGENTS.md`, `CHANGELOG.md` | Command + config documentation, changelog entry. |
| `docs/v2/201-harness-freshness.md` | Status → Implemented; link this plan. |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/harnesses/manifest.test.ts` | Canonical JSON stability; fingerprint equality under key-order/whitespace differences; every input change moves the hash; `baseline` excluded from the fingerprint; `normalizeInputs` table; `hashContent`; read/write round-trip; every corruption mode returns `null` (including missing/invalid `baseline`); `toManifestPath` POSIX normalization; `assertAssetPathsUnderRoot` throws for an escaping resolver; `verifyInstalledInventory` byte-compare and `skipped`-empty fallback. |
| Unit | `test/unit/harnesses/manifest-compare.test.ts` | Full `compareManifest` matrix: not-installed / no-manifest / unreadable / `configResolved: false` / `baseline: "unverified"` / fresh / per-input stale; an unverified manifest whose inputs match current config is still `unknown`, never `fresh`, and never lossless; Tier 2 `modified` / `drifted` / `added` / `orphaned`; Tier 1 never returns `losslessRefresh: true`; user scope always blocked; `context-mismatch` on differing `contextDir`. |
| Unit | `test/unit/harnesses/freshness.test.ts` | Report grid matches harness × supported scopes with option filtering; warning formatter prints only changed fields; unknown/user-scope copy variants; `freshnessWarningsEnabled` honors config. |
| Unit | `test/unit/harnesses/opencode.test.ts`, `cursor.test.ts`, `universal.test.ts` | `renderAssets()` output is byte-identical to what `install()` writes; invoke mode omits the right agents; Cursor rules only at project scope; universal has no agents. |
| Unit | `test/unit/harnesses/factory.test.ts` | A plugin lacking `renderAssets`/`fingerprintInputs` still passes `isValidPlugin` (external-plugin back-compat). |
| Unit | `test/unit/config-registry.test.ts` | `harness.freshnessWarnings` and `harness.autoSync` surface with type, default, and description. |
| Unit | `test/unit/commands/harness.test.ts` | Manifest written on install with correct `inputs`/`installedFrom`/`configResolved`; removed on uninstall before the sweep; `freshness` absent for uninstalled scopes in list data. |
| Integration | `test/integration/commands/harness-manifest.test.ts` | Install writes a valid manifest at `rootDir` for all three harnesses × both scopes with `baseline: "verified"`; unparseable config yields `configResolved: false`; sub-project install records `installedFrom.contextDir`; **non-force reinstall after a model change yields `baseline: "unverified"` with the prior inputs retained, and Tier 1 stays `unknown`**; `--force` reinstall yields `verified` in one step; a no-op reinstall stays `verified`; `uninstall --all` removes the manifest and the now-empty root; a user-owned `opencode.json` prevents the sweep. |
| Integration | `test/integration/commands/harness-sync.test.ts` | **§1.1 regression:** model change → agent frontmatter stale after plain reinstall, correct after `sync`. **Review §1 regression:** plain reinstall between the change and the sync never yields `fresh`; only `sync` establishes `baseline: "verified"`. Idempotence on second run; hand-edit preserved without `--force` and overwritten with it; adoption of a manifest-less install; `--check` writes nothing; native→invoke removes only orphaned managed agents; `sync --help` flags. |
| Integration | `test/integration/commands/harness-freshness-firepoints.test.ts` | `run init` warns once on stderr with parseable stdout JSON and additive `harness_freshness`; `config set author.model` warns, `config set maxStepsPerRun` does not; `harness list --text` shows the freshness line; `harness.freshnessWarnings = "off"` silences all of them; `invoke` never warns. |
| Integration | `test/integration/commands/upgrade.test.ts` | New harness section reports stale installs; **default config (`harness.autoSync` unset, no flags) writes nothing** — bytes, mtimes, and manifest unchanged; auto-sync at project scope only with `autoSync = true` (or `--sync`) *and* the predicate; user scope reported but never synced under any flag; `--no-sync` overrides `autoSync = true`; `--sync` overrides `context-mismatch` but not a hand-edit or an unverified baseline; bundled-only caveat present. |
| Edge case | across the above | Missing `rootDir` entirely; manifest present with zero `assets`; asset file deleted out from under the manifest (`missing`); `manifestVersion` from the future; simultaneous `modified` + `drifted` on the same file; monorepo install from `packages/api` then check from the repo root; config resolution failing at check time (not just install time). |
| Manual | Phase 0 + Phase 8.3 | Project-over-user asset precedence in OpenCode and Cursor; manifest dotfile inertness against each harness's *config* discovery; full end-to-end walkthrough per harness. |

---

## Not In Scope

- **`5x doctor`** — area #3 (`203-recovery-and-doctor.md`). This plan exports `runHarnessFreshnessChecks()` for it and uses `5x harness sync --check` as the interim Tier 2 surface.
- **Shrinking the bake surface (§2.7)** — runtime model resolution and runtime delegation branching. Deferred out of v2; the `renderAssets()` seam keeps the option open, and the §2.6 predicate stays correct with or without it, simply firing less often as the bake shrinks.
- **Per-project user-scope manifests or overrides** — rejected permanently (D4). N manifests over one physical copy means N−1 describe nothing that exists; per-project copies under user scope *are* project scope with extra steps.
- **A plugin-contributed fingerprint input implementation** — the contract member ships (D1); no bundled plugin implements it, by design.
- **Sweeping externally-published harnesses in `upgrade`** — `buildHarnessListData()` cannot enumerate them; the output states this rather than implying full coverage (§5.1).
- **Output normalization of `harness install` / `upgrade` text output** — area #5. New fields here are additive only.
- **Mid-run staleness reminders** — deliberately excluded (D5). If ever needed, the path is a `staleAtInit` stamp on the run row (`200-overview.md` §3.2), not a new store.
- **Any control-plane/CAS/UUID treatment of manifests** — they are local stamps describing local files, outside the sync surface of `200-overview.md` §3a (§3).

---

## Estimated Timeline

| Phase | Description | Time |
|-------|-------------|------|
| 0 | Prerequisite verification spikes (asset precedence, dotfile inertness) | 0.5 day |
| 1 | `manifest.ts` — schema, canonical JSON, hashing, read/write/remove | 1.5 days |
| 2 | Plugin contract `renderAssets()`; behavior-preserving refactor of three plugins | 1.5 days |
| 3 | Manifest write on install (with post-install verification); removal + root sweep on uninstall | 2 days |
| 4 | Freshness engine — `compareManifest`, discovery, warning copy, config keys | 2 days |
| 5 | Fire points — `run init`, `config set`, `harness list` | 1.5 days |
| 6 | `5x harness sync` — handler, CLI, §1.1 regression coverage | 2.5 days |
| 7 | `5x upgrade` freshness sweep with gated auto-sync | 1.5 days |
| 8 | Documentation, migration verification, manual end-to-end pass | 1 day |
| **Total** | | **14 days** |

Phases 1 and 2 are independent and can run in parallel if two people are available (saves ~1.5 days). Phase 0 must complete before Phase 5's user-facing copy is finalized, but does not block Phases 1–4.

---

## Revision History

### 1.2 — August 9, 2026

Phase 0 executed. Both verification spikes passed against live harnesses (OpenCode 1.17.18, cursor-agent 2026.07.23-e383d2b); findings, method, and evidence recorded in Appendix A.

- **0.1 — precedence holds.** Project-scope assets win the name collision over user-scope assets in both harnesses, for agents and skills alike, with a control run proving the user-scope copy is loaded and simply loses. The §2.6 remediation copy is kept as designed, so Phase 5's user-scope warning retains its directive `fix 5x harness install <name> --scope project` line and the §2.7 escalation contingency is not triggered.
- **0.2 — the dotfile is inert.** A `.5x-manifest.json` carrying adversarial `model` / `agent` / `mcpServers` keys, placed at every install root at both scopes, produced no parse error, no config merge, and a byte-identical resolved config; assets kept resolving. No design change — the filename and location stand.
- Recorded one additional finding: Cursor's CLI does not load custom agents from `~/.cursor/agents/` at all, only from project `.cursor/agents/`. This strengthens the directive remediation rather than weakening it, and the pre-existing product question it raises about `harness install cursor --scope user` is noted as out of scope.
- Removed the "pending Phase 0" and "final wording set by Phase 0.1" placeholders in Design Decisions and Phase 4.3 now that both are settled.

### 1.1 — August 9, 2026

Addresses both blocking findings in [`docs/development/reviews/.5x-worktrees-201-harness-freshness-plan-85bccc-5x-cli-docs-development-plans-201-harness-freshness-plan-review.md`](../reviews/.5x-worktrees-201-harness-freshness-plan-85bccc-5x-cli-docs-development-plans-201-harness-freshness-plan-review.md) (no addendums; both items were `auto_fix`). Install semantics are unchanged — the fix is in what the manifest is allowed to claim, not in what install writes.

**Review §1 — non-force reinstall could create a false-fresh manifest.** v1.0 wrote the current inputs plus a post-install read-back of on-disk bytes, so a plain reinstall after a model change stamped the *new* fingerprint over *old* agent bytes and Tier 1 reported `fresh`.

- Added `baseline: "verified" | "unverified"` to `HarnessManifest` (Phase 1.1) with a shape guard that fails closed on a missing or unrecognized value (Phase 1.3). `baseline` is deliberately excluded from the fingerprint.
- Phase 3.2 rewritten as read-prior → **verify** → write. New `verifyInstalledInventory()` byte-compares every rendered asset against disk (structural `skipped`-empty fallback for plugins without `renderAssets()`). Verified → adopt current inputs as the baseline; unverified → retain the prior manifest's `inputs`/`hash`/`configResolved` (or record the attempted inputs diagnostically when there is none) and mark `baseline: "unverified"`. `assets` always record true on-disk bytes so a normal reinstall never reads as a hand-edit.
- Added a consequences table (first install / `--force` / no-op reinstall / partial reinstall / adoption / sync) so each case is directly assertable.
- `compareManifest` gained `baseline-unverified` as both a `FreshnessReason` and a `LosslessBlocker`, evaluated *before* the fingerprint compare and terminal for `status` (Phase 4.2 step 4); `FreshnessReport` now carries `baseline`. Added the state-machine row and predicate clauses 5–6.
- Added the unverified-baseline warning copy variant (Phase 4.3) and an install-time stderr note naming the preserved paths and the fix.
- Phase 6 states that `sync` is the command that establishes a baseline, reuses the same verification path, and reports `sync-unverified` rather than claiming success if a forced write still fails verification.
- Added the review's requested end-to-end test (model A → config B → non-force reinstall → Tier 1 `unknown`, never `fresh` → `sync` → `fresh`) in Phases 3.2 and 6.3, plus unit coverage that an unverified manifest whose inputs happen to match current config is still `unknown` and still not lossless.

**Review §2 — upgrade auto-sync ignored `harness.autoSync = false`.** v1.0's no-flag branch auto-synced whenever `losslessRefresh === true` **or** `autoSync` was enabled, which made the opt-in key inert.

- Phase 7.1 step 3 now evaluates **permission** and **safety** separately: `permitted = --no-sync ? false : --sync ? true : harness.autoSync` (default `false`), and a write requires `permitted && report.losslessRefresh` (spelled out as a blocker filter so `--sync` can override `context-mismatch` and nothing else). With no flag this reduces to `autoSync && losslessRefresh`; the stock default is report-only.
- Documented precedence `--no-sync` > `--sync` > `harness.autoSync` > report-only, and that `--sync` never overrides a hand-edit, `shared-user-scope` (D4), or an unverified baseline.
- Reworded the `harness.autoSync` `.describe()`, the Key Design Decisions row, the scope bullet, and the Phase 7 completion gate to state the opt-in contract once, consistently.
- Added the review's requested test (a lossless stale project install is unchanged under the default configuration) plus tests for `autoSync = true`, `--no-sync` overriding it, `--sync` overriding only `context-mismatch`, user scope never swept, and the tri-state Commander mapping that keeps "no flag" distinct from `--sync`.

**Consistency edits:** Executive Summary, scope bullets, "New behavior", the freshness state machine, Files Touched, the Tests table, Appendix B (both a verified and an unverified example manifest), Appendix C (two new rows), README/manual-pass checklists, and Phase 3's estimate (1.5 → 2 days; total 13.5 → 14 days).

---

## Provenance

Implements `docs/v2/201-harness-freshness.md` (area #1 of v2), whose §5 resolved all eight open design questions ahead of this plan and whose §5.1 carried four prerequisites into execution — all four are handled explicitly here (Phase 0.1, Phase 0.2, Phase 7's bundled-only caveat, and the sync overwrite policy settled in Design Decisions and enforced in Phase 6). The underlying defect — a "reinstall" that silently refreshes skills but skips agent files — is documented in `201` §1.1 and reproduced as a named regression test in Phase 6.3.

---

## Appendix

### Appendix A — Phase 0 verification findings

> Completed August 9, 2026. Both spikes passed; Phase 5/6 copy is written against these results, not assumptions.

| Spike | Harness | Version tested | Date | Result | Evidence |
|---|---|---|---|---|---|
| Project-over-user asset precedence | opencode | 1.17.18 | 2026-08-09 | **Holds** — project wins for agents *and* skills | A.1 |
| Project-over-user asset precedence | cursor | cursor-agent 2026.07.23-e383d2b | 2026-08-09 | **Holds** — project wins for skills; user-scope agents are not loaded by the CLI at all | A.2 |
| Dotfile inertness (config discovery) | opencode | 1.17.18 | 2026-08-09 | **Inert** — resolved config byte-identical, no parse error, no key merge | A.3 |
| Dotfile inertness (config discovery) | cursor | cursor-agent 2026.07.23-e383d2b | 2026-08-09 | **Inert** — no parse error, `mcpServers` not merged | A.4 |
| Dotfile inertness (config discovery) | universal (`.agents/`) | opencode 1.17.18 + cursor-agent 2026.07.23 | 2026-08-09 | **Inert** — both readers load `.agents/skills/` normally, ignore the root dotfile | A.5 |

Method for every row: a throwaway `HOME` at `/tmp/5x-spike-201` with separate `repo-user`, `repo-project`, `repo-universal`, and `repo-empty` checkouts, `5x` run from this worktree (`bun run src/bin.ts`), and `author.model` set to the distinguishable sentinels `test/precedence-user` and `test/precedence-project`.

**A.1 — OpenCode precedence.** `5x harness install opencode --scope user` from a repo with `author.model = "test/precedence-user"`, then `--scope project` in a repo with `author.model = "test/precedence-project"`. `opencode debug agent 5x-plan-author` run inside the project reports `model: {"providerID":"test","modelID":"precedence-project"}`; the same command in `repo-empty` (user assets only) reports `precedence-user`, proving the user-scope copy is loaded and simply loses the name collision. Skills behave identically: a `MARKER-PROJECT-SKILL` sentinel appended to `.opencode/skills/5x/SKILL.md` appears in `opencode debug skill` while the user-scope `MARKER-USER-SKILL` does not, and every resolved `5x*` skill path is under `repo-project/.opencode/skills/`.

**A.2 — Cursor precedence.** Sentinels injected into the `description` frontmatter of both copies of the `5x` skill and of `5x-plan-author`. `cursor-agent -p --mode ask --trust` inside the project answers `MARKERPROJECTXYZ` and quotes the agent description as `AGENTMARKERPROJECT …`; in `repo-empty` the same skill probe answers `MARKERUSERXYZ`, so user-scope skills load and lose the collision exactly as OpenCode does.

> **Additional finding (agents, user scope):** in `repo-empty` the CLI reports **no** `5x-*` subagents at all — only its five built-ins — despite `~/.cursor/agents/{5x-code-author,5x-plan-author,5x-reviewer}.md` being present. Cursor's CLI loads custom agents from project `.cursor/agents/` only; `~/.cursor/agents/` is not an agent source for it. Precedence therefore holds *a fortiori* for agents, and the directive remediation ("install project scope for this project") is not merely valid but is the only thing that makes 5x agents visible to the Cursor CLI. Two caveats worth carrying: this was verified against the CLI, which is the only surface drivable non-interactively — Cursor Desktop was not tested and may differ; and `5x harness install cursor --scope user` writes agent files the CLI will never read, which is a pre-existing product question outside this plan's scope.

**A.3 — OpenCode dotfile inertness.** `opencode debug config` captured before and after writing `.5x-manifest.json` to both `repo-project/.opencode/` and `~/.config/opencode/`. The manifest carried adversarial top-level keys (`"model": "MANIFEST-SHOULD-NOT-LEAK"`, `"agent": {"manifest-leak-agent": …}`) that would be valid `opencode.json` fields. Both dumps are byte-identical (`diff` clean), stderr is empty, exit status 0, and neither sentinel appears in the resolved config. Assets keep resolving with the manifest in place (`opencode agent list` and `opencode debug agent` unchanged). OpenCode reads project config from `./opencode.json`, `./opencode.jsonc`, or `.opencode/opencode.json` by exact name — it does not glob the directory — which is why the dotfile is invisible.

**A.4 — Cursor dotfile inertness.** Same manifest written to `repo-project/.cursor/` and `~/.cursor/`, this time carrying `"mcpServers": {"manifest-leak-mcp": {"command": "/bin/false"}}`. `cursor-agent mcp list` still reports `No MCP servers configured (expected in .cursor/mcp.json or ~/.cursor/mcp.json)`, the skill probe still answers `MARKERPROJECTXYZ`, and no parse error is emitted. Cursor likewise reads `mcp.json` by exact name.

**A.5 — Universal (`.agents/`).** Worth noting that `.agents/` is *not* an untrafficked directory: OpenCode auto-loads `~/.agents/skills/` as an external skill root and Cursor documents `.agents/skills/` as a project-level skill location, so both readers do traverse it. With `.agents/.5x-manifest.json` in place (carrying both the `model` and `mcpServers` sentinels), `opencode debug config` exits 0 with empty stderr and no sentinel in the resolved config, `opencode debug skill` resolves `repo-universal/.agents/skills/*/SKILL.md` normally, and `cursor-agent` answers the skill probe with `MARKERUNIVERSAL` while `cursor-agent mcp list` still reports no servers. Both tools discover skills by walking `skills/<name>/SKILL.md` subdirectories, so a root-level file is never a candidate.

**If precedence does not hold:** _(contingency not taken — precedence holds; retained for the record.)_ replace the user-scope remediation line with a non-directive form ("this project resolves a different model; installing project scope will not necessarily take precedence — choose one config or the other"), and record in `docs/v2/201-harness-freshness.md` that §2.7 is now materially more urgent.

### Appendix B — Example manifest

```json
{
  "manifestVersion": 1,
  "harness": "opencode",
  "scope": "project",
  "hash": "sha256:3f7c1b…",
  "configResolved": true,
  "baseline": "verified",
  "installedFrom": {
    "projectRoot": "/home/me/dev/myrepo",
    "contextDir": "packages/api"
  },
  "inputs": {
    "authorModel": "anthropic/claude-sonnet-4-6",
    "reviewerModel": "anthropic/claude-sonnet-4-6",
    "authorDelegationMode": "native",
    "reviewerDelegationMode": "native",
    "cliVersion": "2.0.0",
    "harnessPluginVersion": "2.0.0",
    "plugin": {}
  },
  "installedAt": "2026-08-09T12:00:00.000Z",
  "assets": [
    { "path": "skills/5x-plan/SKILL.md", "sha256": "a1b2…" },
    { "path": "agents/5x-plan-author.md", "sha256": "c3d4…" }
  ]
}
```

The same install after `author.model` changed and a plain (non-force) `5x harness install` — skills re-rendered, agents preserved. `inputs`/`hash` still describe the last *verified* bake, `assets` describe what is actually on disk now, and `baseline` says the pair is not a baseline:

```json
{
  "manifestVersion": 1,
  "harness": "opencode",
  "scope": "project",
  "hash": "sha256:3f7c1b…",
  "configResolved": true,
  "baseline": "unverified",
  "installedFrom": { "projectRoot": "/home/me/dev/myrepo", "contextDir": "packages/api" },
  "inputs": { "authorModel": "anthropic/claude-sonnet-4-6", "…": "…" },
  "installedAt": "2026-08-09T13:20:00.000Z",
  "assets": [
    { "path": "skills/5x-plan/SKILL.md", "sha256": "9e8f…" },
    { "path": "agents/5x-plan-author.md", "sha256": "c3d4…" }
  ]
}
```

Tier 1 reads this as `unknown` / `baseline-unverified` and warns with the retained `installed author.model` line; `5x harness sync` force-installs, verifies, and rewrites it as `verified` with the new inputs.

### Appendix C — Exit codes and error surfaces

| Situation | Surface | Code |
|---|---|---|
| Sync blocked entirely by hand-edited assets, no `--force` | error envelope | `HARNESS_ASSETS_MODIFIED` (exit 2) |
| Install left an unverified baseline (existing agents preserved) | stderr note + `baseline: "unverified"` in the manifest | none — install still succeeds (§3.2) |
| Sync force-installed but verification still failed | `action: "sync-unverified"` in the envelope + stderr note | none — reported, never claimed as fixed |
| Location resolver whose asset dirs escape `rootDir` | error envelope | `MANIFEST_PATH_ESCAPE` (exit 2) |
| Stale/unknown assets at any fire point | stderr warning + additive JSON fields | none — warn, never block (§2.4) |
| Freshness check itself throws | swallowed | none — never degrades the host command |
