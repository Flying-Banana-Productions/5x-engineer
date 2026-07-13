# 5x CLI v2 — Harness Asset Freshness

**Status:** Draft — Not Implemented
**Date:** July 13, 2026
**Part of:** v2 (`200-overview.md`, area #1)
**Shared core used:** Asset manifest (`200-overview.md` §3.1); surfaced by `5x doctor` (§3.3)

---

## 1. Problem (delta from v1)

`5x harness install` **compiles** harness assets — provider/model config and delegation mode are baked into the rendered skill/agent markdown at install time:

- Delegation mode selects which skill sections render (`src/harnesses/opencode/plugin.ts:64-78`, via `createRenderContext` → `src/skills/renderer.ts`).
- Per-role model strings are injected into agent YAML frontmatter (`renderAgentTemplates` in `plugin.ts:82-92`, `src/harnesses/opencode/loader.ts:159-186`).

The inputs come from `ctx.config` — `authorModel`, `reviewerModel`, `authorDelegationMode`, `reviewerDelegationMode` (resolved per-harness, including `harnessModels.*` overrides, in `src/commands/harness.handler.ts`). Once written, nothing connects those files back to the config that produced them:

- **No staleness detection.** The installer compares content only; no metadata, no fingerprint (`src/harnesses/installer.ts`).
- **No freshness command.** Only `5x upgrade` exists (templates/DB), and it does not refresh installed harness assets.
- **No signal at the point of cause.** Editing `author.model` in `5x.toml` produces no warning that installed assets are now stale.
- **No one-step refresh.** The user must know, manually, to re-run `5x harness install`.

### 1.1 The refresh is worse than "manual" — it's partial

Two installer paths behave differently on an existing install:

- **Skills:** `installSkillFiles` overwrites when content differs (`installer.ts:143-151`). A re-run *does* refresh skills.
- **Agents:** `installAgentFiles` → `installFiles` **skips existing files** unless `force` is set (`installer.ts:100-104`).

So changing `author.model` and re-running `5x harness install` **without `--force`** updates the skill markdown but leaves the **baked model in agent frontmatter stale**. The current "just reinstall" folk-remedy is silently incomplete. This shapes the `5x harness sync` design (§2.5): sync must refresh *managed* assets unconditionally (content-diff or force), not skip-on-exist.

---

## 2. Design

### 2.1 Manifest file (`.5x-manifest.json`)

A small JSON file written to the harness install **root** for each scope — `locations.rootDir` from the resolver (`src/harnesses/locations.ts`): `.opencode/.5x-manifest.json`, `~/.config/opencode/.5x-manifest.json`, `.cursor/.5x-manifest.json`, etc. One manifest per install location.

Placement rationale (`200-overview.md` §3.1): the manifest describes what is physically baked on disk, so it must live and die with those assets — travel with them when committed (project scope), survive `.5x/` deletion, and not desync when another project reinstalls user-scope assets.

Proposed shape:

```json
{
  "manifestVersion": 1,
  "harness": "opencode",
  "scope": "project",
  "hash": "sha256:…",
  "inputs": {
    "authorModel": "anthropic/claude-sonnet-4-6",
    "reviewerModel": "anthropic/claude-sonnet-4-6",
    "authorDelegationMode": "native",
    "reviewerDelegationMode": "native",
    "harnessPluginVersion": "1.2.2",
    "assetVersion": "…"
  },
  "installedAt": "2026-06-28T…Z",
  "assets": { "skills": ["…"], "agents": ["…"], "rules": [] }
}
```

`inputs` is stored in cleartext (not just folded into `hash`) so `5x doctor` can show a human-readable diff — "installed with model X, config now says Y" — not merely "stale."

- _TODO:_ confirm the dotfile is inert under each harness's asset discovery. OpenCode/Universal glob `skills/` and `agents/` subdirs, so a root-level dotfile is ignored; Cursor adds `rules/` — verify when the Cursor harness lands (`docs/027-cursor-harness-native-workflows.prd.md`).

### 2.2 Hashed input set

`hash` covers the **normalized** baked inputs:

- Resolved per-role models (after `harnessModels.<harness>` override) — the same values `harness.handler.ts` passes to `renderAgentTemplates`.
- `authorDelegationMode` / `reviewerDelegationMode` (the skill-render selector).
- Harness plugin version + bundled asset/template version (so a 5x upgrade that changes template prose is itself a staleness trigger).

Normalization (stable key order, canonical model spelling) so semantically-equal configs hash equal.

- _TODO:_ should each harness contribute extra fingerprint inputs (e.g. Cursor rules) via an optional `HarnessPlugin.fingerprintInputs(ctx)` hook, or does the handler own the full input set centrally? Leaning: handler owns the common set; plugins optionally extend. Keep the **hash function and manifest read/write in one harness-agnostic module** (`200-overview.md` §3.1) so Cursor inherits it for free.

### 2.3 Where the manifest is written

The write is **harness-agnostic**, in the install pipeline the handler drives — not reimplemented per plugin. After `plugin.install(ctx)` succeeds, the handler computes the hash from the same `ctx.config` inputs and writes the manifest to `locations.rootDir`.

- _TODO:_ new helper (e.g. `writeManifest(locations, inputs, assets)` / `readManifest(rootDir)`) beside the installer, or a small `src/harnesses/manifest.ts`.
- _TODO:_ `harness uninstall` removes the manifest.

### 2.4 Freshness check

- **Where it fires.** Commands that already load config and use installed assets — `run init`, `invoke` — recompute the hash from in-memory config (≈ free) and compare against the manifest. On mismatch, warn (do not block) with the exact remediation command.
- **At the point of cause.** `5x config set author.model …` (and siblings) checks installed manifests immediately and warns, so the user learns *when they make the change*, not later mid-run.
- _TODO:_ warning copy. Sketch: `⚠ opencode (project) harness assets were installed with reviewerModel=X; config now resolves Y. Run \`5x harness sync\` to refresh.`
- _TODO:_ suppression / once-per-session throttle so the warning doesn't spam every command.

### 2.5 `5x harness sync`

Idempotent re-render of installed scopes to match current config.

- No flags required: the manifest records harness + scope + asset inventory, so sync knows what and where to refresh.
- **Must refresh managed assets unconditionally** (content-diff or force) to fix the partial-refresh bug in §1.1 — agents must update, not skip-on-exist. Preserve the existing safety of `removeStaleAgentFiles` (only touch 5x-managed files; never clobber user-authored agents).
- Rewrites the manifest on completion.
- _TODO:_ `autoSync = true` config — silently sync on detected mismatch at the §2.4 fire points (opt-in; default off).
- _TODO:_ relationship to `5x harness install` (sync ≈ install over an existing manifest) and to `5x upgrade` (should upgrade chain into sync for installed harnesses?).

### 2.6 User-scope vs project-scope (key tension)

The two scopes are **not** symmetric, and the freshness model differs:

- **Project scope** — `.opencode/` assets pair 1:1 with one project's `5x.toml`. Manifest hash vs that project's resolved config is a clean, correct freshness signal. This is where the check delivers full value.
- **User scope** — `~/.config/opencode/` assets are **shared across every project on the machine**, but each project has its own models/delegation modes. The same assets are simultaneously "fresh" for project A and "stale" for project B. A single manifest cannot be correct for all consumers, and **auto-syncing user scope from project B would silently break project A**.

Implications:
- The freshness *check* on user scope is inherently **per-active-project-relative**: it can say "user-scope assets were last installed with config hash X by some project; your current project resolves Y." Useful as information, dangerous as an auto-fix.
- `autoSync` should be **project-scope only**; user-scope mismatches warn but never auto-rebake.
- This is the strongest argument for §2.7: user-scope assets ideally shouldn't bake project-specific config at all.

### 2.7 Longer-term: shrink the bake surface

Every value resolvable at runtime is one less staleness trigger. Candidates:

- **Model strings.** Rather than injecting into agent frontmatter at install, the orchestrator could resolve the model at runtime (e.g. from `5x config show`) — especially for user-scope assets, which can't carry one project's model correctly anyway (§2.6).
- **Delegation mode.** Skill conditional sections baked at install could instead branch on a runtime signal.

Reducing the baked set shrinks both the manifest's `inputs` and the frequency of "stale" — the freshness machinery is the safety net, not the end state. Out of scope to fully resolve in v2; flagged so the manifest design doesn't entrench baking.

---

## 3. Forward compatibility

Manifests are **local stamps describing local files**, not control-plane state. They are outside the sync surface of `200-overview.md` §3a — no UUIDs, no CAS, no shared store. Wherever a harness runs (local machine, LAN provider container, cloud), its assets and their manifest sit together on that machine's filesystem; the freshness check runs against whatever config is active there. So the cloud future adds nothing here beyond "the check runs in more places," which the harness-agnostic module already supports.

---

## 4. Migration / compatibility

- **Pre-existing installs have no manifest.** Treat a missing manifest as unknown/stale and prompt a single `5x harness sync` to establish the baseline. Non-breaking — purely additive warnings and a new command.
- No change to install output contracts beyond the added manifest file and (optionally) a new sync result envelope.

---

## 5. Open questions

- _TODO:_ central vs plugin-contributed fingerprint inputs (§2.2).
- _TODO:_ does `5x upgrade` chain into `harness sync` for installed harnesses (§2.5)?
- _TODO:_ user-scope freshness — warn-only is clear, but is there a per-project user-scope override worth supporting, or is §2.7 (don't bake) the real answer (§2.6)?
- _TODO:_ warning throttle / suppression model (§2.4).
