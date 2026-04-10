# Config UX Overhaul

**Version:** 1.3
**Created:** April 10, 2026
**Status:** Draft

## Overview

The 5x configuration system is powerful (layered resolution, local overlays,
per-harness model overrides, sub-project scoping) but the UX around it is weak:

- `5x init` writes a 73-line template TOML full of commented-out options that
  users must read and manually edit. Most users should start with defaults.
- `5x config show` renders a subset of config fields in a hand-coded text
  format. It omits fields (`qualityGates`, `worktree.postCreate`, `opencode.url`,
  `delegationMode`, `harnessModels`, `maxAutoRetries`, `skipQualityGates`),
  shows no defaults, no descriptions, and no indication of which files
  contributed to the resolved config.
- There is no `5x config set`. Users and agents must hand-edit TOML files,
  which requires knowing the file locations, layering semantics, and exact
  key names.
- An agent cannot help a user configure 5x without understanding TOML structure
  and file paths — there is no config skill.

This plan restructures config UX around four outcomes:

1. `5x init` stops writing a template config — Zod defaults are sufficient.
2. `5x config show` becomes a rich, self-documenting config inspector.
3. `5x config set/unset/add/remove` enables scriptable config manipulation.
4. A config skill allows agents to assist users in interactive setup.

## Goals

- Zero-config onboarding: `5x init` creates `.5x/`, DB, templates, and
  `.gitignore` — but no `5x.toml`. Defaults apply until the user explicitly
  overrides something.
- `5x config show` outputs a flat array of config entries (dotted notation),
  each with: key, description, type, default, current value, and an `isLocal`
  flag. JSON output (default) emits the full array; `--text` renders a compact
  human-friendly table with file-layer header.
- `5x config set author.provider claude-code` writes to the nearest `5x.toml`
  (or `5x.toml.local` with `--local`), creating the file if needed, preserving
  existing comments and formatting. Uses `--context` to resolve the target
  config file, defaulting to cwd.
- If the active config source is `5x.config.js` / `5x.config.mjs`, write
  commands (`set`/`unset`/`add`/`remove`) fail fast with a migration hint to run
  `5x upgrade`; they do not silently create TOML and change precedence.
- `5x init --sub-project-path=<path>` scaffolds a minimal sub-project config
  containing only `[paths]` keys, enabling monorepo setups from the start.
- An agent can run `5x config show` to understand all options, then
  `5x config set` to write them — no TOML knowledge required.

## Non-Goals

- Changing the config layering semantics (root → nearest → local overlays).
  The merge logic stays unchanged.
- Supporting `5x config set` for plugin-specific passthrough keys (e.g.
  `codex.foo`). Passthrough keys are shown in `config show` as unrecognized
  but require `--force` to set. Deferred.
- Interactive TUI config wizard. The agent-assisted path (outcome 4) replaces
  the need for one.
- Deprecating `5x.config.js`/`.mjs` for reads. Existing JS configs still load.
  This plan only defines TOML mutation commands, with explicit fail-fast
  behavior and upgrade guidance when JS/MJS is the active config source.
- Changing the `[db]` root-only restriction. Sub-project configs still cannot
  override `db`.

## Design Decisions

**Flat key registry derived from the Zod schema.** The `FiveXConfigSchema`
(`src/config.ts:64-81`) is already the single source of truth for config shape,
types, and defaults. Rather than maintaining a parallel metadata map, we walk
the Zod schema tree recursively to produce a flat registry of config entries.
Each entry has: `key` (dotted path), `type` (from Zod), `default` (from Zod
`.default()`), and `description` (from Zod `.describe()`). This means
descriptions must be added to the schema via `.describe()` — several fields
already have JSDoc, but the schema itself lacks `.describe()` calls. Adding
them co-locates documentation with the source of truth and ensures the registry
stays in sync automatically.

**Simplified provenance: file list + `isLocal` flag.** Per-key source tracking
would require instrumenting `deepMerge` (`src/config.ts:521-544`), which is
risky and complex. Instead, `config show` reports:

1. The list of config files used in resolution (already available from
   `LayeredConfigResult`: `rootConfigPath`, `nearestConfigPath`, plus the
   local overlay paths discovered in `mergeLayeredLocalTomlIntoRaw`).
2. Per key, an `isLocal` boolean indicating whether the key exists in any
   `5x.toml.local` file. This is computed by flattening the parsed (pre-merge)
   local overlay objects to dotted keys and checking membership — no merge
   instrumentation needed.

This is sufficient for the primary use case: "is this value coming from a
local file that won't be version-controlled?" The file list at the top tells
the user which layers are active.

**`LayeredConfigResult` extended with local overlay paths.** Currently
`resolveLayeredConfig` returns `rootConfigPath`, `nearestConfigPath`, and
`isLayered`. It discovers local overlay paths internally in
`mergeLayeredLocalTomlIntoRaw` but discards them. We extend the result type
to also return `localPaths: string[]` (the `5x.toml.local` files that exist
and were merged) and `localRaw: Record<string, unknown>[]` (the parsed
pre-merge contents of those files, for `isLocal` computation). This keeps the
merge logic untouched — we just preserve references that are currently
discarded.

**TOML writes via `toml-patch`.** The project already depends on
`@decimalturn/toml-patch` (used in `src/commands/upgrade.handler.ts:217`)
which supports comment-preserving patches. `config set` reads the existing
TOML file (or an empty string if creating), applies a structural patch for
the target key, and writes back. This preserves user comments and formatting.

**Type coercion from Zod schema.** `5x config set maxStepsPerRun 500` must
coerce the string `"500"` to a number. The flat key registry knows each key's
Zod type, so coercion is deterministic: `z.number()` → `Number()`,
`z.boolean()` → `"true"/"false"` comparison, `z.string()` → passthrough.
Arrays are not set via `config set` — they use `config add`/`config remove`
with scalar values.

**JS/MJS active config is write-protected.** Read resolution continues to
support `5x.config.js` / `.mjs`, but write commands are TOML-only. Before any
mutation, write handlers detect whether the effective config source for the
selected context is JS/MJS. If so, the command exits with an actionable error,
for example: "Active config is 5x.config.js. Run `5x upgrade` to migrate to
5x.toml before using `5x config set`." This avoids silently creating a new
TOML file and unintentionally changing precedence.

**`config set` writes to the nearest config by context.** All write commands
(`set`, `unset`, `add`, `remove`) resolve the target config file using the
same `--context` semantics as `config show`. The resolution logic:

1. Resolve context directory (`--context` or cwd).
2. Walk up from context dir to find the nearest `5x.toml` (bounded by
   control-plane root).
3. If no nearest config exists, fall back to root config path.
4. If no root config exists, create `5x.toml` at the control-plane root.
5. With `--local`, target the `.local` overlay of the resolved file.
6. If the active source for the context is JS/MJS, fail fast with the
   migration hint (no implicit TOML creation).

This means `5x config set paths.plans custom/plans --context packages/api`
writes to `packages/api/5x.toml` if it exists, or creates it if a
sub-project was initialized there. From the root, it writes to the root
config. The behavior follows the existing layering model — no new semantics.

**`5x init --sub-project-path` scaffolds sub-project configs.** Monorepo
sub-projects need a `5x.toml` with `[paths]` overrides so that plans,
reviews, and archives land in the right directory. The init command gains a
`--sub-project-path=<relativePath>` flag that:

1. Verifies the control-plane root has been initialized (`.5x/` dir and DB
   exist). Errors if not — sub-projects depend on the root.
2. Resolves `--sub-project-path` relative to cwd.
3. Verifies the resolved path is inside the control-plane root (rejects `..`
   escapes outside root).
4. Creates a minimal `5x.toml` in that directory containing only `[paths]`
   keys, with values defaulted to paths relative to the sub-project
   directory (e.g. `plans = "docs/development"`).
5. Does not create `.5x/`, DB, or templates — those are root-only resources.

This can also be used with `--sub-project-path=.` when already in the
target sub-directory.

**`config show --key` for single-key lookup.** Returns just the value (text
mode) or a single entry object (JSON mode). Useful in scripts and agent
tool output where the full config is noise.

## Phase 1: Schema Annotations and Flat Key Registry

**Completion gate:** A `buildConfigRegistry()` function exists that walks the
Zod schema and returns a flat array of `ConfigKeyMeta` entries with correct
dotted keys, types, defaults, and descriptions. Unit tests validate the
registry against the known schema shape.

- [x] Add `.describe()` to every leaf field in the Zod schema definitions
      (`AgentConfigSchema`, `PathsSchema`, `DbSchema`, `WorktreeSchema`,
      `OpenCodeConfigSchema`, `FiveXConfigSchema` top-level fields). Use
      concise, user-facing language. Example:
      ```ts
      provider: z.string().default("opencode").describe("Agent provider name"),
      model: z.string().optional().describe("Default model identifier"),
      ```
- [x] Define `ConfigKeyMeta` type in a new `src/config-registry.ts`:
      ```ts
      interface ConfigKeyMeta {
        key: string;           // dotted path, e.g. "author.harnessModels"
        type: string;          // "string" | "number" | "boolean" | "string[]" | "record"
        default: unknown;      // from Zod .default(), undefined if optional
        description: string;   // from Zod .describe()
        deprecated?: boolean;  // true for maxAutoIterations, maxReviewIterations
      }
      ```
- [x] Implement `buildConfigRegistry(schema: ZodObject): ConfigKeyMeta[]`.
      Walk the Zod schema tree recursively:
      - For `ZodDefault` wrappers, extract the default value.
      - For `ZodOptional`, mark default as `undefined`.
      - For `ZodObject`, recurse with dotted key prefix.
      - For `ZodRecord`, emit a single entry with type `"record"` (keys are
        dynamic, cannot enumerate).
      - For `ZodArray`, emit a single entry with the element type suffixed
        (e.g. `"string[]"`).
      - For `ZodEnum`, include the allowed values in the metadata.
      - Skip `.passthrough()` keys (they are plugin-specific and unknown).
      - Extract `.description` from the Zod schema's `_def.description`.
- [x] Export a memoized `getConfigRegistry()` that calls
      `buildConfigRegistry(FiveXConfigSchema)` once.
- [x] Add unit tests in `test/unit/config-registry.test.ts`:
      - Registry contains expected keys (spot-check `author.provider`,
        `paths.templates.plan`, `maxStepsPerRun`, `qualityGates`).
      - Every entry has a non-empty description.
      - Default values match Zod schema defaults.
      - Deprecated keys are flagged.
      - `harnessModels` entries have type `"record"`.
      - `qualityGates` has type `"string[]"`.
      - `author.delegationMode` includes enum values.

## Phase 2: Extend `resolveLayeredConfig` with Local Overlay Metadata

**Completion gate:** `LayeredConfigResult` includes local overlay file paths
and raw parsed contents. The `isLocal` computation helper works correctly.
Existing layering tests still pass unchanged.

- [x] Extend `LayeredConfigResult` in `src/config.ts`:
      ```ts
      export interface LayeredConfigResult {
        config: FiveXConfig;
        rootConfigPath: string | null;
        nearestConfigPath: string | null;
        isLayered: boolean;
        localPaths: string[];                  // new
        localRaws: Record<string, unknown>[];  // new — parallel to localPaths
      }
      ```
- [x] Modify `mergeLayeredLocalTomlIntoRaw` to also return the local overlay
      paths and parsed raw objects it discovered (currently it only returns
      the merged result). Change its return type from `unknown` to:
      ```ts
      { merged: unknown; localPaths: string[]; localRaws: Record<string, unknown>[] }
      ```
      Callers destructure accordingly.
- [x] Thread `localPaths` and `localRaws` through to the
      `LayeredConfigResult` returned by `resolveLayeredConfig`.
- [x] Implement `computeLocalKeys(localRaws): Set<string>` in
      `src/config-registry.ts`:
      - Takes the array of parsed local overlay objects.
      - Recursively flattens each to dotted keys.
      - Returns the union set.
      This is a pure set-membership operation — no merge involved.
- [x] Verify all existing tests in `test/unit/config.test.ts` and
      `test/unit/config-layering.test.ts` still pass (no behavioral change,
      only return-type expansion).
- [x] Add tests for `computeLocalKeys`:
      - Empty array → empty set.
      - Single local file with `author.provider` → set contains
        `"author.provider"`.
      - Nested key `author.harnessModels.opencode` is correctly flattened.
      - Multiple local files with overlapping keys → union.

## Phase 3: Rich `config show`

**Completion gate:** `5x config show` outputs a flat array of annotated
config entries in JSON mode and a compact table with file-layer header in
text mode. `--key` returns a single entry. All config fields are represented.
Path-valued keys compare and render defaults using effective normalized
defaults (absolute paths), not raw schema literals.

- [x] Define the JSON output shape in `src/commands/config.handler.ts`:
      ```ts
      interface ConfigShowEntry {
        key: string;
        description: string;
        type: string;
        default: unknown; // effective default in resolved-value form
        value: unknown;
        isLocal: boolean;
      }
      interface ConfigShowOutput {
        files: string[];        // ordered list of config files used
        entries: ConfigShowEntry[];
      }
      ```
- [x] Refactor `configShow()` to:
      1. Call `resolveLayeredConfig()` (gets `config`, file paths, `localRaws`).
      2. Call `getConfigRegistry()` to get the key metadata.
      3. Call `computeLocalKeys(localRaws)` to get the local key set.
      4. Flatten the resolved config to dotted key-value pairs.
      5. Compute effective defaults in runtime form before joining entries:
         - For non-path keys, use schema defaults from the registry.
         - For `paths.*`, normalize schema defaults to absolute paths using
           the same base and resolver logic used in runtime config resolution.
      6. Join registry metadata + resolved values + `isLocal` membership into
         `ConfigShowEntry[]`.
      7. Use those effective defaults for value/default comparison and dimming
         in text output.
      8. Build `files` from `rootConfigPath`, `nearestConfigPath`, `localPaths`
         (filtering nulls).
      9. Output via `outputSuccess()`.
- [x] Implement `flattenConfig(config: FiveXConfig): Map<string, unknown>`.
      Recursively walks the config object and produces dotted-key → value pairs.
      Records (`harnessModels`) are expanded to individual keys (e.g.
      `author.harnessModels.opencode = "model-name"`).
- [x] Replace `formatConfigText()` with a new text formatter:
      ```
      Config files:
        root     /path/to/5x.toml
        local    /path/to/5x.toml.local

      Key                              Value                    Default          Local
      author.provider                  opencode                 opencode
      author.model                     -                        -
      author.harnessModels.opencode    gpt-5.4                  -                *
      author.continuePhaseSessions     false                    false
      ...
      ```
      - `*` in the Local column indicates the value comes from a `.local` file.
      - `-` for unset optional values.
      - Values matching their default are dimmed (if TTY).
      - Default for `paths.*` is displayed as normalized absolute path (same
        representation as resolved value), so default comparison is accurate.
- [x] Add `--key <dotted.key>` option to the `config show` command in
      `src/commands/config.ts`. When provided, filter to a single entry.
      In text mode, print just the value. In JSON mode, emit a single
      `ConfigShowEntry`.
- [x] Handle passthrough (plugin) keys: flatten any extra keys from the
      resolved config that are not in the registry. Emit them with
      `description: "(unrecognized)"`, `type: "unknown"`, no default.
- [x] Add unit tests in `test/unit/commands/config.test.ts`:
      - JSON output contains all registry keys.
      - `isLocal` is true for keys present in local overlays.
      - `isLocal` is false for keys only in main config.
      - `--key` filters to single entry.
      - `--key` with unknown key returns error.
      - Passthrough keys appear as unrecognized.
      - Default-only config (no files) shows all defaults with empty `files`.
      - `files` list reflects actual discovered config files.
- [x] Remove the old hand-coded `formatConfigText()` function (dead code
      after this phase).

## Phase 4: `config set` / `unset`

**Completion gate:** `5x config set author.provider claude-code` writes to
the nearest `5x.toml`. `--local` writes to the `.local` overlay. `--context`
controls which config file is targeted. `unset` removes a key.
Comment-preserving writes confirmed by test. Creates files on demand for TOML
contexts only; JS/MJS active contexts fail fast with migration guidance.

- [ ] Add subcommands to `src/commands/config.ts`:
      ```
      5x config set <key> <value> [--local] [--context <dir>]
      5x config unset <key> [--local] [--context <dir>]
      ```
- [ ] Implement `resolveTargetConfigPath()` helper in
      `src/commands/config.handler.ts`:
      1. Resolve `controlPlaneRoot` from `startDir`.
      2. Resolve context directory (`--context` or cwd).
      3. Walk up from context to find the nearest `5x.toml` (bounded by
         control-plane root), using existing `discoverConfigFile()`.
      4. If no nearest config found, fall back to
         `join(controlPlaneRoot, "5x.toml")`.
      5. With `--local`, return the `.local` sibling of the resolved path.
      6. Return the resolved path (may or may not exist on disk yet).
- [ ] Implement `detectActiveConfigSource()` (or equivalent) to classify the
      effective config source for a context as TOML, JS/MJS, or none.
- [ ] Implement `configSet()` in `src/commands/config.handler.ts`:
      1. Validate `key` against the registry with explicit record-descendant
         semantics:
         - Exact registry keys are valid.
         - Dotted descendants of registry `record` keys are valid write
           targets (e.g. `author.harnessModels.opencode`).
         - Unknown keys are rejected (unless `--force`, deferred to non-goal).
      2. Guard: if active config source is JS/MJS for the context, reject with
         migration hint: run `5x upgrade` before mutating config.
      3. Guard: if key is in the `db` group and the resolved target is not
         the root config, reject with message ("db config is root-only").
      4. Look up the key's Zod type from the registry.
      5. Coerce `value` string to the correct type:
          - `"string"` → passthrough
          - `"number"` → `Number(value)`, reject `NaN`
          - `"boolean"` → `value === "true"`, reject other strings
          - `"string[]"` → reject with message directing to `config add`
          - `"record"` exact key → reject with message directing to dotted
            record syntax
          - Descendant of `record` key → coerce to the record value type
            (string for `harnessModels`), so
            `author.harnessModels.opencode` is valid.
      6. Call `resolveTargetConfigPath()` to determine target file.
      7. Read existing file content (empty string if file doesn't exist).
      8. Build a nested object from the dotted key (e.g. `"author.provider"` →
         `{ author: { provider: "claude-code" } }`).
      9. Parse existing TOML, deep-merge the new key, and use `tomlPatch()`
         to produce the updated TOML string preserving comments.
      10. Write the file.
      11. Output the written key, value, and target file path via
          `outputSuccess()`.
- [ ] Implement `configUnset()`:
      1. Validate key with the same exact-or-record-descendant rule.
      2. Guard JS/MJS active source → fail fast with migration hint.
      3. Resolve target file via `resolveTargetConfigPath()`.
      4. Read existing file. If file doesn't exist, no-op with message.
      5. Parse TOML, remove the key from the nested structure.
      6. Patch and write back.
      7. If the file is now empty (no user keys), delete it.
- [ ] Handle nested TOML table creation: setting `author.harnessModels.opencode`
      in an empty file must create both `[author.harnessModels]` and the key
      under it.
- [ ] Add unit tests:
      - Set a top-level key in empty file → creates valid TOML.
      - Set a nested key → creates correct table structure.
      - Set on existing file preserves comments.
      - Set with `--local` writes to `5x.toml.local`.
      - Set with `--context packages/api` writes to sub-project config.
      - Set `db.path` from sub-project context → error.
      - Set with wrong type (string where number expected) → error.
      - Set with unknown key → error.
      - Set descendant under record key (`author.harnessModels.opencode`) →
        valid and written.
      - Set exact record key (`author.harnessModels`) → error directing to
        dotted syntax.
      - Unset removes key, preserves other keys.
      - Unset on missing file → no-op.
      - Unset last key in file → file deleted.
      - Number coercion: `"500"` → `500`.
      - Boolean coercion: `"true"` → `true`, `"yes"` → error.
      - Any write command when active source is `5x.config.js`/`.mjs` →
        fail-fast error with `5x upgrade` migration hint and no TOML file
        creation.

## Phase 5: `config add` / `config remove` (Array and Record Operations)

**Completion gate:** `5x config add qualityGates "bun test"` appends to
the array. `5x config remove` removes a value. `add`/`remove` reuse the same
write-path contract as Phase 4: target resolution via
`resolveTargetConfigPath()` (`--context` defaulting to cwd, `--local`
supported), TOML-only mutation, and fail-fast JS/MJS active-source guard with
`5x upgrade` migration hint. Record keys are settable via dotted notation in
`config set` (Phase 4), so this phase only covers arrays.

- [ ] Add subcommands:
      ```
      5x config add <key> <value> [--local] [--context <dir>]
      5x config remove <key> <value> [--local] [--context <dir>]
      ```
- [ ] Implement `configAdd()`:
      1. Validate key is an array type in the registry.
      2. Reuse `resolveTargetConfigPath()` from Phase 4 to resolve target file
         using full `--context`/`--local` behavior.
      3. Apply the same write-command guard as Phase 4: if active source for
         the resolved context is `5x.config.js`/`.mjs`, fail fast with
         migration hint to run `5x upgrade` (no implicit TOML creation).
      4. Read existing target file content (empty string if file is absent in
         TOML-writable contexts), parse TOML.
      5. Get current array value (or empty array if absent).
      6. Append value if not already present (idempotent).
      7. Patch and write back.
- [ ] Implement `configRemove()`:
      1. Validate key is an array type.
      2. Reuse `resolveTargetConfigPath()` from Phase 4 for target selection
         (`--context`/`--local` parity with `set`/`unset`).
      3. Apply the same JS/MJS active-source fail-fast guard and migration
         hint as all other write commands.
      4. Read, parse, filter out the value, patch, write.
      5. If array is now empty, optionally remove the key entirely.
- [ ] Add unit tests:
      - Add to empty array.
      - Add duplicate is idempotent.
      - Remove existing value.
      - Remove non-existent value is no-op.
      - Add/remove with `--local`.
      - Add/remove with `--context packages/api` targets sub-project config.
      - Add/remove in JS/MJS active-source context fail fast with `5x upgrade`
        hint and do not create TOML files.
      - Add/remove share target-resolution behavior with `set`/`unset`
        (same helper/contract expectations).

## Phase 6: Drop Template Config from `5x init` + Sub-Project Init

**Completion gate:** `5x init` no longer writes `5x.toml`. `5x init
--sub-project-path=<path>` creates a minimal sub-project config with
`[paths]` keys only. Defaults apply via Zod. All init-related tests updated.

- [ ] Remove the config-file generation block from `initScaffold()`
      (`src/commands/init.handler.ts:250-268`). Keep `.5x/` dir creation,
      DB creation, template scaffolding, and `.gitignore` updates.
- [ ] Remove `5x.toml` from the `.gitignore` auto-entries (it's no longer
      generated, but users may still create one — don't ignore it).
      Keep `5x.toml.local` in `.gitignore`.
- [ ] Update `initScaffold()` output to print a hint:
      ```
      Run '5x config show' to see all available configuration options.
      Run '5x config set <key> <value>' to customize.
      ```
- [ ] Add `--sub-project-path <relativePath>` option to `5x init` in
      `src/commands/init.ts`.
- [ ] Implement sub-project init logic in `initScaffold()`:
      1. Resolve the control-plane root. Verify it is initialized (`.5x/`
         dir exists). Error if not: "Root project must be initialized first.
         Run `5x init` from the repository root."
      2. Resolve `--sub-project-path` relative to cwd.
      3. Verify resolved path is inside the control-plane root (no `..`
         escaping outside root). Create the
         directory if it doesn't exist.
      4. Check for existing `5x.toml` at the sub-project path. Skip if
         present (unless `--force`).
      5. Write a minimal `5x.toml` containing only `[paths]` keys with
         defaults relative to the sub-project directory:
         ```toml
         [paths]
         plans = "docs/development"
         reviews = "docs/development/reviews"
         archive = "docs/archive"
         ```
      6. Do NOT create `.5x/`, DB, templates, or `.gitignore` — those are
         root-only resources.
      7. Print the created file path and a hint about `5x config set
          --context <path>` for further customization.
- [ ] When `--sub-project-path` is provided, skip all root-init logic
      (`.5x/` dir, DB, templates, `.gitignore`). The two modes are
      mutually exclusive.
- [ ] Update or remove `generateTomlConfig()` export — it's still used by
      `upgradeTomlConfig()` in `src/commands/upgrade.handler.ts` as the
      template for TOML patching, so keep it but remove its export from
      `src/index.ts` if it was public.
- [ ] Keep `src/templates/5x.default.toml` — it's still the TOML template
      used by the upgrade command's JS→TOML migration path.
- [ ] Update tests in `test/unit/commands/init.test.ts` and
      `test/integration/commands/init.test.ts`:
      - `5x init` does not create `5x.toml`.
      - `5x init --force` does not create `5x.toml`.
      - `5x config show` after init returns all defaults.
      - Existing `5x.toml` is not deleted by init.
      - `5x init --sub-project-path=packages/api` creates
        `packages/api/5x.toml` with only `[paths]` keys.
      - `5x init --sub-project-path=.` from sub-dir creates config in cwd.
      - Sub-project init without root init → error.
      - Sub-project init with existing config → skip (unless `--force`).
      - Sub-project config does not contain `[db]`, `[author]`, `[reviewer]`,
        or any non-paths keys.
- [ ] Update `5x upgrade` path: when no config file exists, `5x upgrade`
      should not create one. Currently it may create `5x.toml` during
      JS→TOML migration — that path stays (it requires a pre-existing JS
      config). But the "add missing keys" path (plan 018 Phase 3) should
      no-op if no config file exists.

## Phase 7: Config Skill for Agent-Assisted Setup

**Completion gate:** Config skill content is installable via harness install,
loadable by the skill loader, and covered by deterministic tests (content and
installation plumbing), without LLM-behavior assertions.

- [ ] Create a config skill at the standard skill location for the project's
      harness (e.g. `.5x/skills/config/SKILL.md` or equivalent for the
      active harness).
- [ ] Skill content should include:
      - A summary of the 5x config model (layered files, local overrides).
      - Instructions to run `5x config show` to get full config state (JSON
        by default).
      - Instructions to use `5x config set`, `unset`, `add`, `remove`.
      - A decision tree for common setup scenarios:
        - Choosing a provider (opencode, claude-code, etc.)
        - Setting model overrides per harness
        - Configuring quality gates
        - Setting up path overrides for monorepo sub-projects
        - Using `--local` for personal preferences vs team defaults
      - Example interaction flows.
- [ ] The skill should be installable via `5x harness install` (add it to
      the harness plugin's skill set) so it's available in any 5x project.
- [ ] Add deterministic tests for this phase:
      - Harness install includes the config skill in expected output paths.
      - Skill loader resolves and reads config skill content successfully.
      - Skill content includes required command guidance (`config show`,
        `set`, `unset`, `add`, `remove`) and layering/local-override notes.

## Files Touched

| File | Change |
|------|--------|
| `src/config.ts` | Add `.describe()` to all Zod schema fields; extend `LayeredConfigResult` with `localPaths`/`localRaws`; modify `mergeLayeredLocalTomlIntoRaw` return type |
| `src/config-registry.ts` (new) | `ConfigKeyMeta`, `buildConfigRegistry()`, `getConfigRegistry()`, `computeLocalKeys()`, `flattenConfig()` |
| `src/commands/config.ts` | Add `set`, `unset`, `add`, `remove` subcommands; add `--key` to `show`; add `--local` and `--context` flags |
| `src/commands/config.handler.ts` | Rewrite `configShow()` with registry-based output; add `resolveTargetConfigPath()`, `configSet()`, `configUnset()`, `configAdd()`, `configRemove()`; replace `formatConfigText()` |
| `src/commands/init.ts` | Add `--sub-project-path` option |
| `src/commands/init.handler.ts` | Remove root config-file generation; add sub-project init logic |
| `src/templates/5x.default.toml` | No change (kept for upgrade migration) |
| Skill file (TBD by harness) | New config setup skill content |
| `test/unit/config-registry.test.ts` (new) | Registry and `computeLocalKeys` tests |
| `test/unit/commands/config.test.ts` (new) | `config show`, `set`, `unset`, `add`, `remove` tests |
| Existing init/upgrade tests | Updated for no-template-on-init behavior |
| Skill installer/loader tests | Deterministic coverage for skill installation and content expectations |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/config-registry.test.ts` | Registry derivation from Zod schema, `computeLocalKeys`, `flattenConfig` |
| Unit | `test/unit/commands/config.test.ts` | `show` output shape, `isLocal` accuracy, `--key` filter, `set`/`unset`/`add`/`remove` correctness, type coercion, file creation, comment preservation, context-aware target resolution, and shared write guards (including JS/MJS fail-fast for add/remove) |
| Unit | `test/unit/config-layering.test.ts` | Existing tests still pass with extended return type |
| Integration | `test/integration/commands/config.test.ts` | Full CLI round-trips: `set` then `show` reflects change; `--local` writes correct file; `--context` targets sub-project config; JS/MJS active config rejects writes with migration hint; `unset` reverts to default |
| Integration | `test/integration/commands/init.test.ts` | Init no longer creates `5x.toml`; `--sub-project-path` creates paths-only config; defaults work without config file |
| Unit | Skill installer/loader tests | Config skill is installed, discoverable, and contains required deterministic guidance |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Zod schema introspection breaks on complex types | Medium | Medium | Unit test every schema leaf; fall back to manual annotation if Zod internals change across versions |
| `toml-patch` cannot represent all structural patches (e.g. creating nested tables from scratch) | Low | Medium | Integration test covers empty-file → nested key creation; fall back to `stringify` + `patch` if needed |
| Removing template from init confuses users expecting a config file | Low | Low | `5x init` prints hint about `config show`/`config set`; `5x config show` is self-documenting |
| `isLocal` false negative when local file sets a key inside a table that also exists in main config | N/A (eliminated) | N/A | `computeLocalKeys` flattens the raw local objects independently of the merge — it checks key existence in the local file, not whether the merge changed the value |
| Write commands silently create TOML when JS config is active | N/A (eliminated) | High | Explicit fail-fast guard with `5x upgrade` migration hint; no implicit TOML creation in JS/MJS contexts |
| Sub-project init writes keys that should be root-only | N/A (eliminated) | N/A | Sub-project template is hardcoded to `[paths]` only; `config set` guards `db` keys against non-root targets |

## Not In Scope

- Config layering semantics changes (merge order, array vs object merge rules).
- Plugin/passthrough key validation (requires plugin registry, future work).
- Interactive TUI config wizard.
- Migrating existing `5x.toml` files to strip template boilerplate — users
  can `5x config unset` keys they don't need, or delete and re-create via
  `5x config set`.

## Revision History

### v1.3 (April 10, 2026) — Address addendum mechanical gap (Phase 5 parity)

**R8 (Addendum major):** Updated Phase 5 so `config add`/`config remove`
explicitly reuse `resolveTargetConfigPath()` and the same write-command
guards as Phase 4: TOML-only mutation, fail-fast when active source is
`5x.config.js`/`.mjs` with `5x upgrade` migration hint, and full
`--context`/`--local` target-resolution behavior. Expanded Phase 5 unit-test
checklist and test matrix wording to require parity validation.

### v1.2 (April 10, 2026) — Address staff review blockers/recommendations

**R3 (P0 JS write semantics):** Added explicit fail-fast behavior for
`config set/unset/add/remove` when active config source is
`5x.config.js`/`.mjs`, including migration hint to run `5x upgrade`.
Documented design rule, Phase 4 implementation steps, tests, and risk update.

**R4 (P1 record descendants):** Clarified key validation so exact registry keys
and dotted descendants of `record` keys are valid. Added explicit examples and
tests (`author.harnessModels.opencode` valid; exact `author.harnessModels`
rejected with guidance).

**R5 (P1 sub-project path semantics):** Updated `--sub-project-path` behavior to
resolve relative to cwd, then enforce resolved path remains inside
control-plane root. Kept support for root and subdirectory usage including
`--sub-project-path=.`.

**R6 (P1 path default rendering):** Specified that `config show` computes and
displays effective normalized defaults for `paths.*` (absolute-path form) and
uses those values for default comparison/dimming.

**R7 (P2 consistency/testability):** Aligned remaining wording so `--context`
defaults to cwd. Replaced Phase 7 LLM-behavior assertion with deterministic
skill install/content/loader tests.

### v1.1 (April 10, 2026) — Address review feedback

**R1 (JSON default):** Removed all `--json` flag references. JSON is the
default output format across the 5x toolchain; `--text` overrides to
human-readable. Updated Goals, Phase 7 skill instructions.

**R2 (sub-project scoping):** Moved sub-project support from Not In Scope
to a first-class feature. `config set/unset/add/remove` now write to the
nearest config resolved via `--context` (defaulting to cwd), not always to
the root. Added `resolveTargetConfigPath()` helper to Phase 4. Added
`5x init --sub-project-path=<relativePath>` to Phase 6 that scaffolds a
paths-only config after verifying root initialization. Added `db` key guard
for non-root configs. Updated design decisions, files touched, tests, and
risks.

### v1.0 (April 10, 2026) — Initial draft
