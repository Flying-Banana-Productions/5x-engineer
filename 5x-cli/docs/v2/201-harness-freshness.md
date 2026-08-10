# 5x CLI v2 — Harness Asset Freshness

**Status:** Implemented
**Date:** July 13, 2026
**Updated:** August 10, 2026 — implemented via [`docs/development/plans/201-harness-freshness-plan.md`](../development/plans/201-harness-freshness-plan.md)
**Part of:** v2 (`200-overview.md`, area #1)
**Shared core used:** Asset manifest (`200-overview.md` §3.1); surfaced by `5x doctor` (§3.3)
**Implementation plan:** [`docs/development/plans/201-harness-freshness-plan.md`](../development/plans/201-harness-freshness-plan.md)

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

The asymmetry cuts both ways. `installSkillFiles` overwrites *any* differing skill file, including one the user hand-edited (`installer.ts:143-151`), while `installFiles` preserves every existing agent file. Neither behavior is a decision anyone made — they are two defaults that drifted apart. Sync's unconditional refresh makes the inconsistency load-bearing, so the manifest records a content hash per installed file (§2.1) and sync reports what it is about to overwrite rather than inheriting the accident.

---

## 2. Design

### 2.1 Manifest file (`.5x-manifest.json`)

A small JSON file written to the harness install **root** for each scope — `locations.rootDir` from the resolver (`src/harnesses/locations.ts`): `.opencode/.5x-manifest.json`, `~/.config/opencode/.5x-manifest.json`, `.cursor/.5x-manifest.json`, etc. One manifest per install location.

Placement rationale (`200-overview.md` §3.1): the manifest describes what is physically baked on disk, so it must live and die with those assets — travel with them when committed (project scope), survive `.5x/` deletion, and not desync when another project reinstalls user-scope assets.

Shape:

```json
{
  "manifestVersion": 1,
  "harness": "opencode",
  "scope": "project",
  "hash": "sha256:…",
  "configResolved": true,
  "installedFrom": {
    "projectRoot": "/home/…/myrepo",
    "contextDir": "packages/api"
  },
  "inputs": {
    "authorModel": "anthropic/claude-sonnet-4-6",
    "reviewerModel": "anthropic/claude-sonnet-4-6",
    "authorDelegationMode": "native",
    "reviewerDelegationMode": "native",
    "cliVersion": "…",
    "harnessPluginVersion": "…",
    "plugin": {}
  },
  "installedAt": "2026-06-28T…Z",
  "assets": [
    { "path": "skills/5x-plan/SKILL.md", "sha256": "…" },
    { "path": "agents/5x-plan-author.md", "sha256": "…" }
  ]
}
```

`inputs` is stored in cleartext (not just folded into `hash`) so `5x doctor` can show a human-readable diff — "installed with model X, config now says Y" — not merely "stale."

**`assets` records a content hash per installed file**, path relative to `rootDir`. This makes "are these assets unmodified since install?" a decidable question, which is the safety gate for every automatic refresh (§2.5, §2.6). It also removes the need for a hand-maintained `assetVersion` input (§2.2).

**`installedFrom` records which project and context produced the bake.** Config resolves per *context* (`resolveLayeredConfig`, `src/config.ts:994`) while assets install once per *root*, so the manifest must name the context whose config it reflects — otherwise the freshness comparison has no defined operand (§2.6).

**`configResolved: false`** marks an install where config resolution threw. `harness.handler.ts:137-147` swallows that failure and installs with undefined models; recording those as if they were intentional would make the first *successful* config load read as a config change. A `configResolved: false` manifest is treated as unknown/stale, exactly like a missing one.

**Values stay machine-independent.** `assets` paths are relative to `rootDir`, and project-scope manifests may be committed. `installedFrom.projectRoot` is the one absolute path, is advisory only (it feeds the user-scope provenance message in §2.6), and is never compared for equality.

**Dotfile inertness — resolved.** All three shipped harnesses (`opencode`, `cursor`, `universal`) discover assets from *subdirectories* of the root — `skills/`, `agents/`, `rules/` (`src/harnesses/locations.ts`) — so a root-level dotfile is inert by construction. The residual risk is not asset discovery but *config* discovery: harness config files do live at the root (`.opencode/opencode.json`, `.cursor/mcp.json`), so a loader globbing `*.json` there could see the manifest. A leading-dot filename makes that very unlikely; the implementation carries one manual smoke test per harness rather than a design change.

### 2.2 Hashed input set and the two-tier check

`hash` covers the **normalized** baked inputs:

- Resolved per-role models (after `harnessModels.<harness>` override) — the same values `harness.handler.ts` passes to `renderAgentTemplates`.
- `authorDelegationMode` / `reviewerDelegationMode` (the skill-render selector).
- CLI version + harness plugin version (bundled plugins report the CLI version from `src/version.ts`; external packages report their own).

Normalization (stable key order, canonical model spelling) so semantically-equal configs hash equal.

**No `assetVersion` input.** A hand-maintained version string for bundled template prose gets forgotten on the first prose edit that ships without a bump — a silent miss, which is precisely the failure this document exists to prevent. Template drift is detected instead by re-rendering and comparing against the per-file hashes in `assets` (§2.1). That is more expensive than a string compare, which the check structure accommodates:

- **Tier 1 — inputs only.** Compare recorded `inputs` against config resolved in memory. No plugin load, no render, effectively free. Catches config edits and CLI/plugin upgrades. The only tier that runs on hot paths (§2.4).
- **Tier 2 — rendered content.** Re-render the harness's assets and compare per-file hashes against `assets`. Catches bundled-template drift *and* user hand-edits, and reports exactly what a sync would change. Runs only in `5x doctor` and `5x harness sync`.

**Fingerprint inputs are owned centrally.** Both shipped plugins bake an identical four-input surface (`opencode/plugin.ts:63-87`, `cursor/plugin.ts:63-88`), and Cursor's extra asset class — rules — renders from static templates with no config inputs at all (`cursor/plugin.ts:104-112`). A plugin-contributed input set would ship with zero implementors. The `HarnessPlugin` contract nonetheless declares an optional `fingerprintInputs?(ctx): Record<string, string | number>`, nested under `inputs.plugin` so it can never collide with the common set, so that an external harness baking something else stays representable — no bundled plugin implements it. The hash function and manifest read/write live in **one harness-agnostic module** (`200-overview.md` §3.1) so every harness inherits them for free.

### 2.3 Where the manifest is written

The write is **harness-agnostic**, in the install pipeline the handler drives — not reimplemented per plugin. After `plugin.install(ctx)` succeeds, the handler computes the hash from the same `ctx.config` inputs and writes the manifest to `locations.rootDir`.

- **Module: `src/harnesses/manifest.ts`** — not loose helpers beside the installer. Its consumers (`doctor`, `upgrade`, `config set`, `sync`) all sit outside the installer layer, and it carries its own types. Exports: `computeFingerprint`, `readManifest`, `writeManifest`, `removeManifest`, `compareManifest`.
- **`harness uninstall` removes the manifest** — *before* the directory-emptiness sweeps. `removeDirIfEmpty` runs only over `skillsDir` / `agentsDir` / `rulesDir` (`installer.ts:213`), so a manifest left at the root survives a full uninstall and keeps an otherwise-empty `.opencode/` alive.

### 2.4 Freshness check — where it fires

The check fires at **transitions**, not on every command that touches assets. That is what removes the need for a throttle: every throttle design (once-per-session flag, TTL stamp file) needs per-scope state that itself goes stale, and the spam problem only exists if the warning fires on a hot path.

Fire points, all Tier 1 (§2.2), all warn-not-block, all naming the exact remediation command:

- **`5x run init`** — once per run, before any work is delegated.
- **`5x config set author.model …`** (and any other baked key) — at the point of cause, so the user learns *when they make the change*.
- **`5x doctor`** — on demand, and the only place Tier 2 runs by default (`203-recovery-and-doctor.md` §4).
- **`5x harness list`** — freshness as a status column.

**`invoke` is deliberately not a fire point.** It runs per step, dozens of times per run, and the warning has near-zero value there: rebaking assets mid-run would change agent behavior mid-run, which is not a fix anyone wants. If a mid-run reminder proves necessary, stamp `staleAtInit` on the run row (`200-overview.md` §3.2 already adds run state) and surface it once — no new store.

Suppression is a single config key, `harness.freshnessWarnings = "on" | "off"`. No TTL, no session state.

Warning copy shows only the changed fields and always names the fix:

```
⚠ opencode (project) assets are stale
  installed  author.model = anthropic/claude-sonnet-4-6
  current    author.model = anthropic/claude-opus-4-1
  fix        5x harness sync
```

### 2.5 `5x harness sync`

Idempotent re-render of installed scopes to match current config.

- No flags required: the manifest records harness + scope + asset inventory, so sync knows what and where to refresh.
- **Must refresh managed assets unconditionally** (content-diff or force) to fix the partial-refresh bug in §1.1 — agents must update, not skip-on-exist. Preserve the existing safety of `removeStaleAgentFiles` (only touch 5x-managed files; never clobber user-authored agents).
- Rewrites the manifest on completion.

**One render path, not two.** For each discovered manifest, sync calls `plugin.install({ force: true, … })` and rewrites the manifest. Sync is not a parallel renderer that can drift from install.

| Command | Meaning |
|---|---|
| `harness install` | Create assets and establish a manifest. Semantics unchanged apart from the manifest write; `--force` retained. |
| `harness sync` | Make installed assets match current config, targeting whatever the manifests say is installed. |
| `upgrade` | Detect staleness across all installed scopes; auto-sync only where refresh is provably lossless (below). |

A missing manifest (§4) is **adopted** by sync: force-install, then write the manifest. That is the "establish the baseline" path.

**`autoSync` is opt-in, default off** (`harness.autoSync`), and gated on both halves of the lossless predicate (§2.6):

1. the manifest's `installedFrom.contextDir` is the context resolving config right now, and
2. every file in `assets` still hashes to its recorded value — no user edits to clobber.

Anything else degrades to a warning.

**`upgrade` uses the same predicate.** A CLI upgrade changes bundled asset bytes, so *every* install is stale by construction afterwards; staying silent would turn the manifest into a chore the user chases on the next command rather than a safety net. So `upgrade` always reports, auto-syncs only where the predicate holds, and takes `--sync` / `--no-sync` to override. Its installed-set oracle is `buildHarnessListData()` (`harness.handler.ts:202`), which already enumerates harnesses × scopes with existence checks — it walks only *bundled* harnesses, so an externally-published harness is not swept, which the output states rather than hides.

### 2.6 One install root, many config contexts (key tension)

The freshness question is well-posed only when one physical set of assets corresponds to one resolved config. Two situations break that correspondence, and they are the same bug:

- **User scope.** `~/.config/opencode/` assets are **shared across every project on the machine**, but each project has its own models and delegation modes. The same assets are simultaneously "fresh" for project A and "stale" for project B. A single manifest cannot be correct for all consumers, and **auto-syncing user scope from project B would silently break project A**.
- **Multi-context projects.** Less obvious, equally real: `resolveLayeredConfig` (`src/config.ts:994`) layers a nearest-context config over the root one, so `packages/api/5x.toml` may set its own `author.model` — while assets install once, to the checkout root (`harness.handler.ts:118-120, 150-154`). Installing from `packages/api` bakes api's models into the root `.opencode/`, which the root context does not resolve to. This is user scope's problem inside a single repo.

So the rule is **not** "project scope is safe, user scope is not." It is:

> **Lossless-refresh predicate.** Refresh automatically only when the manifest's `installedFrom.contextDir` is the context resolving config right now, **and** every recorded asset hash still matches. Otherwise warn, naming what differs and who baked it.

One predicate covers both cases, so the monorepo case needs no later redesign.

**User-scope freshness is warn-only, permanently — no per-project override.** The alternatives are incoherent rather than merely awkward: keeping N manifests over one physical asset copy means N−1 of them describe something that does not exist, and keeping per-project asset copies under user scope *is* project scope with extra steps. The scope is defined by there being exactly one copy; the freshness question is unanswerable there in principle, not for want of design.

What makes warn-only useful is provenance plus a remediation that exists today. `installedFrom` lets the warning say "user-scope opencode assets were baked from `~/dev/foo` with `author.model=X`; this project resolves Y," and the recommended fix is to **install project scope for this project** rather than rebake the shared copy.

> ⚠ **Verify before building on this.** The remediation assumes project-scope assets take precedence over user-scope assets in OpenCode and Cursor. That is unverified and is a hard prerequisite — if precedence does not hold, the advice degrades to "warn and let the user choose," and §2.7 becomes materially more urgent.

### 2.7 Longer-term: shrink the bake surface

Every value resolvable at runtime is one less staleness trigger. Candidates:

- **Model strings.** Rather than injecting into agent frontmatter at install, the orchestrator could resolve the model at runtime (e.g. from `5x config show`) — especially for user-scope assets, which can't carry one project's model correctly anyway (§2.6).
- **Delegation mode.** Skill conditional sections baked at install could instead branch on a runtime signal.

Reducing the baked set shrinks both the manifest's `inputs` and the frequency of "stale" — the freshness machinery is the safety net, not the end state. Out of scope to fully resolve in v2; flagged so the manifest design doesn't entrench baking.

§2.6's permanent warn-only verdict for user scope is a symptom of the bake, not a limit of the manifest: nothing about a shared asset copy is unanswerable once it stops carrying one project's config. That makes §2.7 the eventual answer, but it does not block v2 — the predicate in §2.6 is correct with or without it, and simply fires less often as the bake surface shrinks.

---

## 3. Forward compatibility

Manifests are **local stamps describing local files**, not control-plane state. They are outside the sync surface of `200-overview.md` §3a — no UUIDs, no CAS, no shared store. Wherever a harness runs (local machine, LAN provider container, cloud), its assets and their manifest sit together on that machine's filesystem; the freshness check runs against whatever config is active there. So the cloud future adds nothing here beyond "the check runs in more places," which the harness-agnostic module already supports.

---

## 4. Migration / compatibility

- **Pre-existing installs have no manifest.** Treat a missing manifest as unknown/stale and prompt a single `5x harness sync` to establish the baseline (§2.5 adoption path). Non-breaking — purely additive warnings and a new command.
- **`configResolved: false` manifests are treated identically** to missing ones (§2.1), so an install that ran without resolvable config converges on the same one-command baseline rather than masquerading as fresh.
- No change to install output contracts beyond the added manifest file and (optionally) a new sync result envelope.

---

## 5. Decisions

Resolved ahead of the execution plan. Each entry records the decision and why it beat the alternative.

| # | Question | Decision |
|---|---|---|
| D1 | Central vs plugin-contributed fingerprint inputs (§2.2) | Handler owns the input set. `fingerprintInputs?()` is declared on `HarnessPlugin` and implemented by no bundled plugin — both shipped plugins bake an identical surface, so a plugin-contributed set would launch with zero implementors, but an external harness must stay representable. |
| D2 | `assetVersion` as a hashed input (§2.2) | Dropped. Replaced by per-file content hashes in `assets` plus the Tier 1 / Tier 2 split — a hand-maintained prose version would be missed exactly when it mattered. |
| D3 | Does `upgrade` chain into `sync`? (§2.5) | Always detect and report; auto-sync only where the lossless predicate holds; `--sync` / `--no-sync` to override. A CLI upgrade invalidates every install by construction, so silence would make the manifest a chore rather than a safety net. |
| D4 | User-scope freshness — per-project override? (§2.6) | No override; warn-only, permanently. Both alternatives collapse (N manifests describing one copy, or per-project copies that are just project scope). Provenance via `installedFrom` plus "install project scope" is the usable remediation. |
| D5 | Warning throttle / suppression (§2.4) | No throttle. Fire at transitions (`run init`, `config set`, `doctor`, `harness list`), never on `invoke`; one `harness.freshnessWarnings` off switch. Throttle state is itself state that goes stale. |
| D6 | Auto-sync safety rule (§2.6) | The lossless predicate — matching install context **and** unmodified asset hashes — replaces "project scope only." One rule serves `autoSync` and `upgrade`, and covers the multi-context case the scope-based rule missed. |
| D7 | Manifest module (§2.3) | `src/harnesses/manifest.ts`; its consumers all sit outside the installer layer. |
| D8 | Dotfile inertness (§2.1) | Inert by construction for all three shipped harnesses. Carried as a per-harness smoke test, not a design constraint. |

### 5.1 Carried into the execution plan

Not open questions — prerequisites and known limits the plan must handle explicitly:

- **Verify project-over-user asset precedence** in OpenCode and Cursor before building on the §2.6 remediation. If it does not hold, D4's user-facing advice changes.
- **Smoke-test the manifest dotfile** against each harness's *config* discovery (not asset discovery), the only plausible collision (§2.1).
- **`upgrade` sweeps bundled harnesses only** — `buildHarnessListData()` cannot see an externally-published harness. State that in the output rather than implying full coverage.
- **Settle the skill-overwrite policy explicitly** (§1.1): sync reports what it will overwrite, using recorded asset hashes, instead of inheriting today's silent clobber.
