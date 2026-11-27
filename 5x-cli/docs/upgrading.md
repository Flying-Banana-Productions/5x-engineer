# Upgrading to v2

[README](../README.md) · [Changelog](../CHANGELOG.md) · [Recovery](operations.md#recovery)

## Release boundary

2.0.0 is in beta: prereleases such as **2.0.0-beta.1** are published under the npm
`beta` dist-tag, and `latest` is still v1.3.0. These instructions describe changes
since `5x-cli-v1.3.0`. Check `5x --version` before following version-specific
commands.

Implemented additions include harness freshness/sync, doctor and lock recovery,
ambient run identity, phase finish, a durable prompt queue, invocation registry,
git-native records, Git-aware plan progress, and plan/implementation review
governance.

The dashboard and output normalization remain pending. Same-run semantic plan
amendments use `review implementation amend`; the earlier `recover-plan` command
is retired. Invocation cancellation
is capability-dependent, with provider-specific process adapters still follow-up
work.

## From v1.3

### 1. Update the executable

Install the release you intend to use through your package manager, for example:

```bash
npm install -g @5x-ai/5x-cli@beta
5x --version
```

Until v2 is published as stable, `latest` is still v1.x; the `beta` dist-tag
installs the v2 prerelease. Use the repository development installation described
in [setup](getting-started.md#install-the-cli) to evaluate unreleased changes.

### 2. Migrate the project and synchronize the harness

If you use OpenCode (as a harness or as the `opencode` invoke provider), first
upgrade OpenCode to 2.x. 5x 2.x requires OpenCode 2.x (at least 2.4.2) and does
not support 1.x:

```bash
opencode upgrade --major
opencode --version
```

The 2.x installer replaces the 1.x binary rather than installing beside it.
If you use a password-protected external OpenCode 2.x server, set
`OPENCODE_PASSWORD` in the environment that runs `5x`; see
[configuration](configuration.md#opencode-provider). Then, from the initialized
project:

```bash
5x upgrade
5x harness sync
5x doctor --text
```

`upgrade` migrates database/config compatibility and manages document templates;
it does not update the installed npm executable. It checks prompt overrides and
reports harness freshness. Harness roots are report-only by default;
`harness.autoSync = true` opts into lossless refresh, `--sync` explicitly requests
it, and `--no-sync` prevents it for that invocation.

OpenCode 2.x changed agent frontmatter and delegation tools, so an existing
OpenCode harness reports stale until `5x harness sync opencode` (or `5x harness
sync`) refreshes it. `5x doctor` warns (`opencode-outdated`) while OpenCode is
older than the minimum.

Plain `harness install` preserves existing agent files and does not establish a
verified baseline for those files. Use sync. Review reported local modifications
before force-overwriting them. Commit updated project harness assets and their
adjacent manifests together.

### 3. Review customized templates and skills

Bundled prompts are used automatically unless `.5x/templates/prompts/` overrides
exist. `template describe <name>` shows the effective override. Review both
initial and continued variants during migration: an old override can omit the
current protocol or governance instructions. `upgrade` reports prompt differences;
`harness sync` does not replace prompt overrides.

Document skeletons now explain Delivery Budget ledgers, stable IDs, debt claims,
and governed review evidence. Reconcile project-owned skeletons with the current
scaffolded examples rather than dropping their parser-sensitive structure.

### 4. Decide whether to export historical runs

New run history is written to `paths.records` (default
`docs/development/runs`). To inspect export of older SQLite-only runs:

```bash
5x records backfill --dry-run
5x records backfill --plan <slug> --dry-run
```

After inspecting the target mapping:

```bash
5x records backfill --plan <slug>
5x records index
```

Backfill writes/commits tracked history. `--target auto` chooses the conventional
plan branch when available, otherwise the current branch; it does not fetch
remote refs. Fetch explicitly beforehand if needed, or choose `--target <branch>`.
Backfilled records identify the export honestly rather than invent historical
origin identities. Backfill commits skip Git hooks. Inspect `records.redact`
before exporting fields you do not want tracked.

Indexing rebuilds local projections from records; it is not a backup/restore
operation for live prompts, sessions, locks, or logs. Keep `.5x/` local and track
the records directory.

### 5. Resume using durable state

```bash
5x run list --text
5x run state --run <id> --text
```

Existing baselines and implementation bindings retain their pinned policy.
Advisory remains the default; changing config to enforced does not rewrite an
existing baseline. Legacy mid-review runs keep their compatibility path unless
explicitly opted into baseline capture after human confirmation. Do not infer
approval from a Markdown status or fabricate a new baseline to bypass a block.

For budgeted implementation, approved-source binding and plan-drift validation
apply even in advisory mode. If admission needs a source, inspect approved
plan-review runs and use `review implementation bind` to select one. For active
governance recovery, follow the current installed skill and prepare fresh review
context at an unused iteration; replaying a stored step identity returns its
stored observation.

Checkpoint active-run records before human handoff or exit:

```bash
5x commit --run <id> --no-record -m "5x: checkpoint run records"
```

`run complete` seals records itself. Doctor is the recovery front door for stale
locks/mappings, orphaned prompts, freshness, and records issues.

## Automation changes to account for

- **Explicit identity wins:** environment/worktree/pointer context now precedes
  pipe fallback. Pass `--run` when coordinating runs; do not assume a pipe changes
  a session's selected run.
- **Recording changes Git files:** treat mid-loop record dirtiness as expected;
  checkpoint records before stopping.
- **Phase finish is a composite:** it runs quality, author validation/recording,
  and checklist checks, not reviewer approval. Changed code needs a new attempt
  identity so an earlier successful quality result is not reused.
- **Prompts are persisted:** account for timeouts, cancellation, and terminal-run
  cleanup instead of assuming a prompt is only a blocking terminal read.
- **Review routes can be enforced:** obey CLI-owned routes and decision gates;
  do not use generic approval records to bypass them.
- **Output exceptions remain:** setup text, raw protocol output, and watch
  streams are documented in the [CLI reference](cli-reference.md#current-exceptions).

## Historical migration: v0.2 → v1

v1 moved orchestration from TypeScript state machines into agent skills. The old
high-level `5x plan`, `5x plan-review`, `5x run <plan>`, and `5x status` interfaces
were removed/replaced by primitives (the present `plan` command is inspection).
`--auto`, `--ci`, and `--tui-listen` are no longer the orchestration controls.

The old `maxAutoIterations` key is a deprecated alias for `maxStepsPerRun`;
upgrade migrates it. Old JS/MJS configuration can be migrated to TOML. Database
migration replaces the v0 result/event tables with the steps journal and marks
in-progress v0 runs aborted. See the
[v1 architecture](v1/100-architecture.md) for historical rationale, then use the
current guides for today's commands and output behavior.
