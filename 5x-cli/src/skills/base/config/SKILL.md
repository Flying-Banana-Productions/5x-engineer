---
name: config
description: >-
  Guide for inspecting and editing 5x configuration through the CLI. Use when
  helping users choose providers, per-harness models, quality gates, monorepo path
  overrides, or personal settings with layered files and local overlays.
metadata:
  author: 5x-engineer
---

# Skill: config (5x configuration)

5x reads configuration from layered TOML (and optional JS) sources. Values merge
from the repository control-plane root down to the nearest `5x.toml` for your
working directory, then apply `5x.toml.local` overlays where present. You do
not need to memorize file paths: the CLI exposes the resolved result and writes
back with `5x config`.

## Inspect the live configuration

- Run `5x config show` to print the full resolved config as JSON (default).
  Each entry includes the dotted key, description, type, default, current value,
  and whether the key appears in a `.local` overlay (`isLocal`). For `enum` types,
  entries also include `enumValues` (all valid options from the schema).
- Add `--text` for a compact table with the active config file list.
- Add `--key <dotted.path>` to fetch a single key (JSON object or text value).
- Use `--context <dir>` so resolution matches work in that directory (monorepos).

## Mutate configuration (TOML targets)

Write commands apply to the nearest `5x.toml` for the context (or create one),
with the same merge semantics as manual edits. If the active source for that
context is a JS config file, the CLI refuses writes and tells you to migrate
with `5x upgrade` first.

- `5x config set <key> <value> [--local] [--context <dir>]`
- `5x config unset <key> [--local] [--context <dir>]`
- `5x config add <key> <value> [--local] [--context <dir>]` — append to array keys
- `5x config remove <key> <value> [--local] [--context <dir>]` — remove from arrays

`--local` targets the `.local` sibling of the resolved file (personal or
machine-specific overrides). Team-shared defaults stay in `5x.toml`; private
tweaks go to `5x.toml.local` (often git-ignored).

## Decision tree (common setups)

### Pick and change the agent provider

1. Run `5x config show --key author.provider` (or browse the full JSON) to see
   the current value and default.
2. Set explicitly, for example:
   `5x config set author.provider claude-code`
3. If you use multiple stacks in one repo, confirm each harness’s expectations in
   docs and align `author.provider` / reviewer settings accordingly.

### Per-harness model overrides

When one repo installs several harnesses that expect different model strings, use
`author.harnessModels.<harnessName>` (and reviewer equivalents) instead of a
single global `author.model`.

1. Inspect: `5x config show --key author.harnessModels` or search the JSON for
   `harnessModels`.
2. Set a dotted key, for example:
   `5x config set author.harnessModels.cursor anthropic/claude-sonnet-4-6`
3. Re-run `5x harness install <harness> --scope <scope>` if generated assets
   should pick up new model strings.

### Quality gates

1. List current gates: `5x config show --key qualityGates` (array type).
2. Append: `5x config add qualityGates "bun test"`
3. Remove: `5x config remove qualityGates "bun test"`

### Monorepo path overrides

1. Prefer a sub-project `5x.toml` (for example `packages/api/5x.toml`) with a
   `[paths]` section, or `5x init --sub-project-path` from the plan to scaffold
   paths-only config.
2. Use `5x config set paths.plans <relative-dir> --context packages/api` so
   writes land in the nearest config for that package.
3. Confirm with `5x config show --context packages/api`.

### Personal vs team defaults

- Shared policy: edit `5x.toml` (committed) or the sub-project file.
- Personal overrides: `5x config set <key> <value> --local` writes to
  `5x.toml.local` beside the resolved target so teammates keep team defaults.

## Example flows

**Flow A — tighten CI gates**

```bash
5x config show --key qualityGates
5x config add qualityGates "bun test"
5x config show --key qualityGates
```

**Flow B — override model for one harness only**

```bash
5x config show --key author.harnessModels
5x config set author.harnessModels.cursor anthropic/claude-sonnet-4-6
```

**Flow C — package-scoped paths**

```bash
5x config set paths.plans docs/plans --context packages/api
5x config show --context packages/api --text
```

Always prefer `5x config show` before editing so you see defaults, types, and
whether a value is coming from a `.local` file.
