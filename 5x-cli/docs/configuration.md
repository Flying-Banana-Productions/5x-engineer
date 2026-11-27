# Configuration

[README](../README.md) · [Setup](getting-started.md) · [CLI reference](cli-reference.md)

## Inspect and edit

Defaults come from the CLI schema; a root `5x.toml` is optional. Inspect resolved
values, defaults, and local overrides:

```bash
5x config show --text
5x config show --key author.model --text
5x config show --context packages/api --text
```

Edit TOML through the CLI, or edit it directly:

```bash
5x config set maxStepsPerRun 300
5x config add qualityGates "bun test"
5x config remove qualityGates "bun test"
5x config set reviewer.model anthropic/claude-sonnet-4-6 --local
5x config unset reviewer.model --local
```

`set/unset/add/remove` target the nearest main TOML, or its `.local` overlay with
`--local`. `--context <dir>` selects a package context. JS/MJS configs remain
readable, but editing commands require migration with `5x upgrade` first.

## Models, providers, and delegation

Each role has independent `model`, `provider`, `delegationMode`, timeout, and
session-continuity settings. The default provider is `opencode`; model and timeout
are unset by default. Native harnesses default to `delegationMode = "native"`.

- **Native:** the host's subagent executes the task. Installed agent frontmatter
  selects the model; provider settings do not launch an external worker.
- **Invoke:** `5x invoke` launches the configured provider/model. Use this for
  external providers even when the orchestrator is in a native harness.
- **Universal:** always uses invoke.

For example, this selects an external reviewer in an otherwise native OpenCode
workflow:

```toml
[author]
model = "anthropic/claude-sonnet-4-6"
delegationMode = "native"

[reviewer]
provider = "cursor-agent"
delegationMode = "invoke"
# model = "<model ID accepted by your Cursor Agent installation>"
```

`author.harnessModels.<harness>` / `reviewer.harnessModels.<harness>` override the
role model when rendering native profiles for that harness. They do not change
the model used by `invoke`. For a personal native Cursor model override:

```bash
5x config set author.harnessModels.cursor '<Cursor model ID>' --local
5x harness sync
```

Replace placeholders with IDs accepted by the relevant tool. Different harnesses
and providers need not use the same model naming.

### Provider plugins and authentication

OpenCode is bundled. Other short names resolve to `@5x-ai/provider-<name>`;
fully scoped package names are used as supplied. Install plugins alongside the
CLI so its module resolution can find them. For a globally npm-installed CLI:

```bash
npm install -g @5x-ai/provider-cursor-agent
5x config set reviewer.provider cursor-agent
5x config set reviewer.delegationMode invoke
```

For a project-local CLI installation, add the provider to that same project.
See the [Cursor Agent provider guide](../packages/provider-cursor-agent/README.md)
for its executable, authentication, and `[cursor-agent]` options. Provider-specific
options live in a top-level table named after the provider. Native tools use
their own login/configuration; invoke providers may use CLI login, environment
credentials, or configured server authentication. There is no universal API-key
requirement. A provider source package in this repository is not proof it has
been published to npm.

### OpenCode provider

The bundled `opencode` provider requires OpenCode 2.x, at least 2.4.2. Before
each invocation it checks the server's version and fails with an upgrade hint
for OpenCode 1.x (`opencode upgrade --major`) or an older 2.x
(`opencode upgrade`).

- **Managed mode** (no `opencode.url`, the default): 5x starts a private
  `opencode serve` on `127.0.0.1` for the invocation, protected by a random
  password only 5x holds, and stops it when the invocation ends. `opencode` must
  be on `PATH`. 5x never starts, reuses, or restarts OpenCode's background
  service (`opencode serve --service`), so your own OpenCode sessions are not
  affected.
- **External mode:** set `opencode.url` (or pass `--opencode-url <url>`) to use
  a server you already run. OpenCode 2.x servers are password-protected; 5x
  reads the password from `OPENCODE_PASSWORD`, falling back to
  `OPENCODE_SERVER_PASSWORD`, and always uses the username `opencode`. There is
  no `5x.toml` key for the password, so it stays out of committed config.

```toml
[opencode]
url = "http://127.0.0.1:4096"
```

```bash
export OPENCODE_PASSWORD='<server password>'
5x invoke author <template> --opencode-url http://127.0.0.1:4096 [options]
```

5x attributes each OpenCode turn to exactly one prompt it sent. It cannot
attribute a turn on an external session that another client drives at the same
time:

- A turn on a session that is already running or has queued input fails with
  `OpenCode session <id> is busy (running or has queued input)`, and sends no
  prompt.
- A turn whose execution also received other input fails with `OpenCode session
  <id> received other input during this turn; the result is ambiguous`, rather
  than returning another prompt's result.

On timeout or cancellation, a turn cancels its own queued prompt by its id and
reports when removal cannot be confirmed. In managed mode it also interrupts
the private server's running execution. On an external server it never
interrupts a running execution, which may keep running; the error says the
execution `was left running on the external server`. An unresolved prompt
admission (for example, a lost reply) is reported as `may still be queued or
run`, not assumed cancelled.

### Timeouts and continuation

`author.timeout` and `reviewer.timeout` are seconds for invoke execution; omitting
them disables the configured timeout. `invoke --timeout` overrides it. Native
subagents use host timeout controls.

`continuePhaseSessions` defaults to false. When enabled, continued work requires
an explicit continuity choice. Invoke uses `--session <provider-session-id>` or
`--new-session`; native render uses `--continue-native` or `--new-session`. Native
task IDs are distinct from provider session IDs. See [automation](automation.md).

## Quality gates and limits

`qualityGates` is an array of shell commands, run sequentially. The default is
empty. Use commands meaningful for your project; gate success with no configured
checks is not evidence that tests ran.

```toml
maxStepsPerRun = 250
qualityGates = ["bun test", "bun run lint", "bun run typecheck"]

[worktree]
postCreate = "bun install"
root = "../my-project-worktrees"   # optional
```

`worktree.root` sets the directory where `5x` creates plan worktrees
(`<root>/<plan-slug>-<hash>`). A relative value resolves against the config
file's directory; an absolute value is used as-is and may point outside the
repository; `~/…` expands to your home directory. Commands run inside such a worktree still find the main
repository's state through git. Like `db`, it is repo-wide: only the root
config and the root `5x.toml.local` may set it; a sub-project value is
ignored with a warning. When unset, worktrees go in
`<stateDir>/worktrees` (by default `.5x/worktrees`). Worktrees that already
exist keep their recorded path; changing `root` only affects new ones.

These are illustrative project settings. `maxStepsPerRun` defaults to 250;
`maxQualityRetries` defaults to 3. The workflow still reads
`maxReviewIterations` (default 5, deprecated schema key) for compatibility routes.
Read resolved limits rather than copying fixed retry counts into automation.
`skipQualityGates` defaults to false.

## Paths and monorepos

Common defaults:

| Key | Default |
| --- | --- |
| `paths.plans` | `docs/development` |
| `paths.reviews` | `docs/development/reviews` |
| `paths.planReviews`, `paths.runReviews` | Fall back to `paths.reviews` |
| `paths.archive` | `docs/archive` |
| `paths.records` | `docs/development/runs` |
| `paths.templates.plan` | `.5x/templates/implementation-plan-template.md` |
| `paths.templates.review` | `.5x/templates/review-template.md` |

Paths resolve relative to the owning configuration layer. In `paths.*`,
`worktree.root` and `db.path`, a leading `~` or `~/…` expands to your home
directory; `~user/…` and environment variables such as `$HOME` are not
expanded. `plans.branch` adds a configured branch to Git-aware progress
discovery.

Layering merges the root main config and nearest subproject main config, then
root/nearest `5x.toml.local` overlays. Objects merge deeply; arrays replace rather
than concatenate. A root local overlay also works without a main TOML file.
`5x init` ignores `5x.toml.local` in Git.

Run-scoped execution resolves configuration from the plan's directory. Config
editing and harness install/sync are working-directory/context anchored: run
them from the package whose overrides you want baked into its assets.

After root initialization, bootstrap a package with:

```bash
5x init --sub-project-path packages/api
5x config show --context packages/api --text
```

This writes a paths-only package TOML. Local coordination remains root-owned.
`db.path` accepts a state directory (default `.5x`; the schema's legacy
`.5x/5x.db` spelling is normalized). Only the root main/local config can relocate
it; subproject `[db]` values are ignored with a warning. An absolute state
directory is supported. This does not relocate git-tracked `paths.records`.

## Harness freshness

```bash
5x harness list --text
5x harness sync --check
5x harness sync
5x harness sync opencode --scope project
```

Install/sync renders skills and agent profiles from resolved models/delegation.
The adjacent `.5x-manifest.json` records baked inputs and file hashes.

- Plain install preserves existing agents; it may refresh managed skills.
- Sync establishes a verified baseline and reports locally modified assets it
  cannot replace safely.
- `sync --force` overwrites local edits. Keep desired customizations before using it.
- `upgrade` reports freshness by default. `harness.autoSync = true` opts into
  automatic **lossless** refresh. `upgrade --sync` requests sync explicitly;
  `--no-sync` forces report-only harness handling.

`harness.freshnessWarnings` defaults to `"on"`; `"off"` explicitly silences the
warning signal. Otherwise, agents must show run-init warnings to the operator.

## Review budgets

```toml
[reviewBudget]
mode = "advisory" # default; alternatives: "off", "enforced"
```

Mode is pinned when a baseline is captured and inherited by implementation
bindings. Changing config does not retroactively rewrite that policy.

Budgets price delivery effort and architecture burden, not tokens or dollars.
Growth ceilings, baseline disagreements, and debt-credit limits are configured
under `reviewBudget`; `5x config show` exposes their current defaults. Use the
CLI's calculated forecast rather than manually maintaining totals in a plan.

Advisory records diagnostics without enforced budget gates. For budgeted
implementation it still requires an approved source and validates plan drift.
Enforced mode additionally validates closure evidence and derives durable routes
and human gates. Mode off and unbound compatibility runs use the legacy contract.
See [review governance](automation.md#review-governance).

## Records and privacy

`paths.records` controls git-tracked history. Sessions, log paths, and transcripts
remain local; `records.redact` names additional step-record fields to omit, such
as `cost_usd` or `model`. Inspect records before sharing them. `records.actor`
is an optional recorder label; a committed value is shared by all clones, so use
a personal overlay or `FIVEX_RECORDS_ACTOR` for personal attribution.

## Templates

There are two separate customization surfaces:

1. **Document skeletons:** `init` scaffolds plan/review Markdown skeletons under
   `.5x/templates/`, which are the `paths.templates.*` defaults. Set
   `paths.templates.plan` or `paths.templates.review` to supply a
   project-owned skeleton instead.
2. **Agent task prompts:** bundled by default. `5x init --install-templates`
   installs editable overrides under `.5x/templates/prompts/`. Overrides take
   precedence over bundled prompts. Inspect them with `template list/describe`.

`upgrade` scaffolds missing skeletons, and `upgrade --force` refreshes the
copies under `.5x/templates/`. It never modifies a configured skeleton path, but
warns when the skeleton in use differs from the bundled version or when a file
remains at a former default location (`docs/_implementation_plan_template.md`,
`docs/development/reviews/_review_template.md`).

`upgrade` checks installed prompt versions; custom overrides can retain old
workflow instructions. Review them during upgrades, including continued variants.
`harness sync` refreshes harness assets, not these prompt overrides. Installed
skills can also be edited, but sync will report conflicts for protected local edits.

Preserve parser-sensitive headings, budget columns, and checklist syntax in
document skeletons. The current skeleton contains annotated examples; its Draft
status and sample IDs are not approval evidence.
