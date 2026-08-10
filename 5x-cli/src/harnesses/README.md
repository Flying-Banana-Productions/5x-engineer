# Harness Plugin System

A harness plugin adapts the 5x workflow for a specific AI coding agent (OpenCode, Claude Code, Cursor, etc.). It installs **skills** and **agent profiles** into the correct locations for that harness, and may optionally manage **rules**.

## Architecture

```
src/harnesses/
  types.ts              HarnessPlugin interface and related types
  factory.ts            Plugin discovery, loading, and bundled registry
  installer.ts          Shared file installation helpers (harness-agnostic)
  locations.ts          Location resolver types and bundled resolvers
  manifest.ts           Asset manifest schema, hashing, read/write, compare
  freshness.ts          Discovery + warning formatting for fire points
  opencode/             Bundled OpenCode harness plugin
  cursor/               Bundled Cursor harness plugin
  universal/            Bundled universal harness plugin (skills-only, invoke path)
  README.md             This file
```

## Shared Skill Templates

Harnesses should render skills from the shared base template system in
`src/skills/` instead of maintaining harness-local `SKILL.md` copies.

Use `renderAllSkillTemplates()` with a delegation context:

```ts
import { renderAllSkillTemplates } from "../skills/loader.js";

// Native harnesses (OpenCode, dedicated Cursor plugin, etc.)
const nativeSkills = renderAllSkillTemplates({ native: true });

// Universal/invoke harnesses
const invokeSkills = renderAllSkillTemplates({ native: false });
```

Then install with `installSkillFiles(skillsDir, skills, force)`.

This keeps all harnesses in sync with one source of truth for workflow docs.

## Asset Manifest

Every successful `5x harness install` writes `<rootDir>/.5x-manifest.json`
(see `manifest.ts`). The stamp records:

- baked fingerprint inputs (`authorModel`, `reviewerModel`, delegation modes,
  CLI / plugin versions, optional `plugin` extras)
- `baseline: "verified" | "unverified"` — verified only when every managed
  asset on disk byte-matches the render of those inputs
- per-file `sha256` hashes of installed assets (relative POSIX paths)
- `installedFrom` provenance (`projectRoot`, relative `contextDir`)

Consumers outside the installer (`run init`, `config set`, `harness list`,
`harness sync`, `upgrade`, eventually `doctor`) call `compareManifest` /
`runHarnessFreshnessChecks`. Project-scope manifests are meant to be
**committed** with the install root (`.opencode/`, `.cursor/`, `.agents/`);
the CLI never auto-ignores them.

`5x harness sync` is the one-step re-render that establishes a verified
baseline. Plain `install` keeps its skip-on-exist semantics for agents, so a
non-force reinstall after a config change may write `baseline: "unverified"`
and keep warning until `sync`.

## Plugin Contract

A harness plugin is an object that satisfies `HarnessPlugin` (defined in `types.ts`):

```ts
interface HarnessPlugin {
  readonly name: string;
  readonly description: string;
  readonly supportedScopes: HarnessScope[];  // "project" | "user"
  readonly version?: string;                 // optional; CLI version used when omitted
  describe(scope?: HarnessScope): HarnessDescription;
  install(ctx: HarnessInstallContext): Promise<HarnessInstallResult>;
  uninstall(ctx: HarnessUninstallContext): Promise<HarnessUninstallResult>;
  /** Optional: dry render used by install and Tier 2 freshness. */
  renderAssets?(ctx: HarnessInstallContext): Promise<RenderedAsset[]>;
  /** Optional: extra fingerprint inputs nested under `inputs.plugin`. */
  fingerprintInputs?(
    ctx: HarnessInstallContext,
  ): Record<string, string | number>;
}
```

`describe(scope?)` can return scope-aware metadata. This is used by
`5x harness list` to report optional capabilities (for example, whether
rules are supported in that scope).

### Optional members for external plugin authors

| Member | Purpose | If omitted |
| --- | --- | --- |
| `renderAssets(ctx)` | Return every managed asset `{kind, name, path, content}` **without writing**. Bundled plugins make `install()` a thin writer over this so sync/doctor can never drift from install. | Tier 2 falls back to on-disk-vs-recorded hash compare (hand-edit detection only; no template-drift detection). |
| `fingerprintInputs(ctx)` | Extra bake inputs beyond the common set. Stored under `inputs.plugin` so they cannot collide with CLI-owned fields. | Only the common inputs are fingerprinted (sufficient for bundled harnesses). |
| `version` | Plugin version recorded in the fingerprint. | CLI version is used (correct for plugins that ship with the CLI). |

Duck-type validation still accepts plugins that lack these members — they
remain valid external plugins.

### `supportedScopes`

Declares which scopes this harness supports. Drives CLI `--scope` validation:

- **Single scope** (e.g. `["project"]`): `--scope` is optional; auto-inferred.
- **Multiple scopes** (e.g. `["project", "user"]`): `--scope` is required; CLI errors if omitted.

### `install(ctx)`

Called by the `5x harness install` command after prerequisite checks. The context provides everything the plugin needs:

```ts
interface HarnessInstallContext {
  scope: "project" | "user";
  projectRoot: string;          // absolute path to project root
  force: boolean;               // overwrite existing files?
  config: {
    authorModel?: string;       // resolved for this harness (see below)
    reviewerModel?: string;
  };
}
```

`authorModel` and `reviewerModel` are resolved by the CLI from `5x.toml`:
`[author|reviewer].harnessModels.<harnessName>` when set for the harness
being installed (where `<harnessName>` matches `5x harness install <name>`),
otherwise `[author|reviewer].model`. See `resolveHarnessModelForRole` in
`src/config.ts` and the commented examples in `src/templates/5x.default.toml`.

The return value reports what was installed:

```ts
interface HarnessInstallResult {
  skills: InstallSummary;   // { created[], overwritten[], skipped[] }
  agents: InstallSummary;
  rules?: InstallSummary;
  unsupported?: {
    rules?: boolean;
  };
  warnings?: string[];
}
```

The framework handles all console output based on the returned summaries.

## Writing a Harness Plugin

### As a Bundled Harness

1. Create a directory under `src/harnesses/<name>/`.
2. Implement `HarnessPlugin` in `plugin.ts`, exporting it as the default export.
3. Register it in `factory.ts` under `BUNDLED_HARNESSES`.

### As an External Package

1. Create an npm package named `@5x-ai/harness-<name>` (or any scoped package).
2. Default-export an object satisfying `HarnessPlugin`:

```ts
// index.ts
import type { HarnessPlugin } from "@5x-ai/5x-cli/harnesses/types";

const myHarness: HarnessPlugin = {
  name: "my-harness",
  description: "5x integration for My Harness",
  supportedScopes: ["project"],
  async install(ctx) {
    // resolve install paths, render templates, write files
    // return { skills: ..., agents: ... }
  },
};

export default myHarness;
```

3. Users install the package in their project, then run:

```sh
5x harness install my-harness --scope project
```

### Overriding a Bundled Harness

External packages are resolved **before** bundled harnesses. To override the bundled `opencode` harness, publish (or install locally) a package named `@5x-ai/harness-opencode`. The factory will load it instead of the bundled version.

## Discovery & Resolution

The factory (`factory.ts`) resolves harness names to packages using the same convention as the provider system:

| Input | Resolved package |
|-------|-----------------|
| `opencode` | `@5x-ai/harness-opencode` |
| `claude-code` | `@5x-ai/harness-claude-code` |
| `@acme/my-harness` | `@acme/my-harness` |

Resolution order:

1. Try `import("@5x-ai/harness-<name>")` (or the scoped name).
2. If module not found and name matches a bundled harness, return the bundled plugin.
3. If module not found and not bundled, throw `HarnessNotFoundError` with install instructions.

The duck-type validation checks for `name` (string), `description` (string), `supportedScopes` (array), and `install` (function).

## Shared Utilities

Plugins can (and should) use the shared installer helpers in `installer.ts`:

- **`installSkillFiles(skillsDir, skills, force)`** -- installs skills following the `<skillsDir>/<name>/SKILL.md` convention.
- **`installAgentFiles(agentsDir, agents, force)`** -- installs agent profiles as `<agentsDir>/<name>.md`.
- **`installRuleFiles(rulesDir, rules, force)`** -- installs rules as `<rulesDir>/<name>.mdc`.
- **`installFiles(targetDir, files, force)`** -- generic flat file installer.

For skills, pair `installSkillFiles()` with shared rendering from
`src/skills/loader.ts` (`renderAllSkillTemplates()` / `listBaseSkillNames()`).

All installer helpers return `InstallSummary { created[], overwritten[], skipped[] }` and handle directory creation, existence checks, and force-overwrite semantics.

For uninstall flows, matching helpers are available:

- `uninstallSkillFiles(skillsDir, skillNames)`
- `uninstallAgentFiles(agentsDir, agentNames)`
- `uninstallRuleFiles(rulesDir, ruleNames)`

## Command Interface

```
5x harness install <name> [--scope user|project] [--force]
5x harness list
5x harness sync [name] [--scope user|project] [--check] [--force]
5x harness uninstall <name> [--scope user|project|--all]
```

The `install` command orchestration (in `harness.handler.ts`):

1. Loads the plugin via the factory.
2. Validates `--scope` against `plugin.supportedScopes`.
3. For project scope: verifies the 5x control plane exists (`.5x/5x.db`).
4. Loads model config from `5x.toml` (non-fatal failure for user scope).
5. Calls `plugin.install(ctx)` — the plugin manages its own skills and agents.
6. Verifies the installed inventory against `renderAssets()` (when present) and
   writes `.5x-manifest.json` (`verified` or `unverified`).
7. Prints the install summary.

`sync` force-refreshes managed assets (refusing hand-edits without `--force`),
rewrites a verified manifest, and is the migration path for pre-manifest
installs.
