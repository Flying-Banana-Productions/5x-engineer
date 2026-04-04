# Plan List Command

**Version:** 1.2
**Created:** March 31, 2026
**Status:** Draft

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-31 | Initial draft for `5x plan list`. |
| 1.1 | 2026-03-31 | Address review feedback in `reviews/5x-cli-docs-development-030-plan-list-command.plan-review.md`: recurse full `paths.plans` tree, make relative path the primary identifier in JSON/text output, add direct-call handler unit coverage, and switch default sort to unfinished-first. |
| 1.2 | 2026-03-31 | Address addendum in `reviews/5x-cli-docs-development-030-plan-list-command.plan-review.md` by fixing Files Changed inventory consistency (unit handler test file marked as new; totals updated). |

## Overview

`5x plan` only has a `phases` subcommand that operates on a single plan file.
There is no way to get a bird's-eye view of all plans in the project, their
completion status, and associated runs. This command fills that gap.

`5x plan list` recursively scans the configured plans directory tree for
markdown plan files, parses each to extract phase/completion status, joins
with DB data to show associated runs, and outputs a summary table (`--text`)
or JSON envelope.

## Design Decisions

**Disk-authoritative listing.** The command scans `config.paths.plans` for
`.md` files rather than querying the `plans` DB table. Plans that exist on
disk but have never been used with `run init` still appear. Plans in the DB
but deleted from disk are not shown.

**Recursive discovery across the full plans tree.** Discovery traverses all
subdirectories under `config.paths.plans`, matching the existing contract that
plan paths are valid anywhere inside that directory tree.

**Path-first identity.** Plan identity is the stable path relative to
`config.paths.plans` (for example `milestones/030-feature.plan.md`), not just
a basename. Basename/title remain convenience fields.

**Batch DB lookups.** Worktree mappings and runs are loaded in two bulk queries
before the per-file loop, avoiding N+1 queries. `listRuns()` from
`operations-v1.ts` is reused with a high limit.

**Worktree-aware parsing.** For plans with a mapped worktree, the worktree
copy is read instead of the root copy (same logic as `plan phases`). This
ensures checklist state is accurate.

**Inspection-oriented ordering.** Sort unfinished plans first, then completed
plans, with alphabetical tie-break by `plan_path`. This keeps active work at
the top while preserving stable output.

**No new DB operations.** All required queries exist or are simple raw
`SELECT * FROM plans` calls consistent with existing patterns.

## Implementation

### Phase 1: Command registration and handler

- [x] Add `PlanListParams` interface to `plan-v1.handler.ts`
- [x] Add `planList` handler function to `plan-v1.handler.ts`
- [x] Add `formatPlanListText` text formatter to `plan-v1.handler.ts`
- [x] Register `list` subcommand in `plan-v1.ts`

**Completion gate:** `5x plan list` and `5x --text plan list` execute without
error in a project with plans. `5x plan list --exclude-finished` filters
complete plans.

#### Commander adapter (`src/commands/plan-v1.ts`)

Add `list` subcommand after the existing `phases` subcommand:

- Name: `list`
- Summary: `"List plans and their completion status"`
- Option: `--exclude-finished` (boolean flag) -- hide 100%-complete plans
- No required arguments -- discovers plans from `config.paths.plans`
- Action calls `planList({ excludeFinished })` from handler
- Update import to include `planList`

#### Handler (`src/commands/plan-v1.handler.ts`)

**Param interface:**

```typescript
export interface PlanListParams {
  excludeFinished?: boolean;
}
```

**Data flow:**

1. `resolveDbContext()` -> `{ projectRoot, config, db }`
2. Recursively scan `config.paths.plans` for all `.md` files. If dir doesn't
   exist, return empty result (not error).
3. Batch-load worktree mappings: `db.query("SELECT * FROM plans").all()` ->
   `Map<plan_path, worktree_path>`
4. Batch-load runs: `listRuns(db, { limit: 10000 })` -> group by `plan_path`
   into `Map<plan_path, RunSummaryV1[]>`
5. For each discovered `.md` file:
   - Build canonical path via `canonicalizePlanPath(absolutePath)`
   - Build stable `plan_path` as POSIX-style path relative to `plansDir`
   - Resolve effective path (prefer worktree copy if mapped and exists)
   - `parsePlan(readFileSync(...))` to get phases/completion
   - Look up runs from the pre-built map
6. Apply `--exclude-finished` filter if set
7. Sort: unfinished first (alpha by `plan_path`), then complete (alpha by
   `plan_path`)
8. `outputSuccess(data, formatPlanListText)`

**Worktree resolution (inline):** For each plan, check `worktreeMap.get(canonical)`.
If worktree path exists, compute `join(wtPath, relative(projectRoot, canonical))`.
If that file exists on disk, read from there instead.

**Imports to add:**

- `readdirSync` (add to existing `fs` import)
- `canonicalizePlanPath` from `../paths.js`
- `listRuns` from `../db/operations-v1.js`
- `resolveDbContext` from `./context.js`
- `PlanRow` type from `../db/operations.js`

#### Text formatter

Follow the ColDef/padEnd table pattern from `run-v1.handler.ts:614-668`.

| Header     | Description                             |
|------------|-----------------------------------------|
| Plan Path  | Relative path under `plans_dir`         |
| Status     | `complete` / `incomplete`               |
| Progress   | `75%`                                   |
| Phases     | `3/4` (done/total)                      |
| Runs       | Total run count                         |
| Active Run | Run ID if active, else `-`              |

Example `--text` output:
```
Plan Path                                 Status      Progress  Phases  Runs  Active Run
features/016-new-feature.md               incomplete  33%       1/3     1     run_abc123def4
features/018-refactor.md                  incomplete  0%        0/4     0     -
archive/015-test-separation.md            complete    100%      3/3     2     -
archive/020-old-feature.md                complete    100%      2/2     1     -
```

Empty state: `(no plans)`

#### JSON envelope

```json
{
  "ok": true,
  "data": {
    "plans_dir": "/path/to/docs/development",
    "plans": [
      {
        "plan_path": "features/015-test-separation.md",
        "name": "015-test-separation",
        "file": "015-test-separation.md",
        "title": "Test Separation Plan",
        "status": "complete",
        "completion_pct": 100,
        "phases_done": 3,
        "phases_total": 3,
        "active_run": null,
        "runs_total": 2
      }
    ]
  }
}
```

### Phase 2: Handler unit tests (direct-call)

- [x] Add new file `test/unit/commands/plan-v1.handler.test.ts` with `describe("planList handler")` coverage

**Completion gate:** Direct-call tests cover discovery, filtering, sorting,
worktree resolution, empty-dir handling, and parse-failure fallback without
spawning the CLI.

Test cases:

1. Recursive discovery includes nested markdown plans under `paths.plans`
2. Duplicate basenames in different subdirectories are distinct via `plan_path`
3. Missing plans dir returns empty list, no throw
4. `--exclude-finished` filters complete plans
5. Sorting is unfinished first, then complete; ties by `plan_path` alpha
6. Worktree mapped plan prefers worktree copy when present
7. Parse failure for one file yields incomplete/0% fallback while other files continue

### Phase 3: Integration tests

- [x] Add `describe("5x plan list (integration)")` block in `test/integration/commands/plan-v1.test.ts`

**Completion gate:** All new and existing tests pass.

Test cases:

1. Empty plans dir -> `{ plans: [] }`, exit 0
2. Plans dir doesn't exist -> `{ plans: [] }`, exit 0
3. Nested plans are discovered recursively
4. Multiple plans with mixed completion -> correct sorting (unfinished first)
5. `--exclude-finished` filters out complete plans
6. `--text` shows path-oriented column headers and rows
7. Plans with active runs show run ID in JSON output
8. Plans without DB entries still appear (runs_total=0, active_run=null)

Uses existing `makeTmpDir`, `setupProject`, `run5x`, `parseJson` helpers.

### Phase 4: Documentation updates

- [x] Add `5x plan list` to `README.md` Inspection section (~line 456)
- [x] Add `### 5x plan list` subsection to `docs/v1/101-cli-primitives.md` Section 6: Inspection (after `5x plan phases`, before `5x diff`)
- [x] Update command group table in `docs/v1/101-cli-primitives.md` (~line 87) to include `plan list`
- [x] Add `5x plan list` to `src/harnesses/opencode/5x-orchestrator.md` state-tracking guidance (~line 36)
- [x] Add `5x plan list` to `src/harnesses/cursor/5x-orchestrator.mdc` state-tracking guidance (~line 36)

**Completion gate:** All references to plan inspection commands include
`plan list`. Orchestrator harness profiles mention it as a state-tracking tool.

#### `README.md` (~line 453-458, Inspection section)

```bash
5x plan list [--exclude-finished]          # List all plans with completion status
5x plan phases <path>                      # Parse plan into phases with progress
5x diff [--since <ref>] [--stat]           # Git diff (working tree or since ref)
```

#### `docs/v1/101-cli-primitives.md`

New subsection between `5x plan phases` and `5x diff` with command syntax,
flag description, JSON return shape, and text mode column layout.

Update command group table:
```
| **Inspection** | `plan list`, `plan phases`, `diff` | Read plan structure, inspect git changes |
```

#### Orchestrator harness profiles

Add `5x plan list` alongside existing state-tracking commands in both
`src/harnesses/opencode/5x-orchestrator.md` and
`src/harnesses/cursor/5x-orchestrator.mdc`:

```markdown
2. **Track state.** Use `5x run state --run <id>`,
   `5x plan list` for an overview, and
   `5x plan phases <path>` for detailed phase status.
```

## Files Changed

| File | Change |
|------|--------|
| `src/commands/plan-v1.ts` | Register `list` subcommand with `--exclude-finished` option |
| `src/commands/plan-v1.handler.ts` | Add `planList` handler + `formatPlanListText` formatter |
| `test/unit/commands/plan-v1.handler.test.ts` | New direct-call tests for recursive discovery, filtering, sorting, worktree precedence, and parse fallback |
| `test/integration/commands/plan-v1.test.ts` | Integration tests for new subcommand |
| `README.md` | Add `5x plan list` to Inspection section |
| `docs/v1/101-cli-primitives.md` | Add `5x plan list` spec in Section 6 + update command group table |
| `src/harnesses/opencode/5x-orchestrator.md` | Add `5x plan list` to state-tracking guidance |
| `src/harnesses/cursor/5x-orchestrator.mdc` | Add `5x plan list` to state-tracking guidance |

**Total: 1 new file, 7 modified files. No schema changes. No new dependencies.**

## Edge Cases

- **Plans dir missing**: Return empty result, not error
- **File on disk but not in DB**: Show it (runs_total=0, active_run=null)
- **Plan in DB but not on disk**: Skipped (disk-authoritative)
- **Parse failure on a file**: Catch per-file, treat as 0% incomplete
- **Non-`.md` files in any nested plans subdirectory**: Ignored

## Verification

### Automated

1. `bun test test/unit/commands/plan-v1.handler.test.ts` -- direct-call coverage passes
2. `bun test test/integration/commands/plan-v1.test.ts` -- integration coverage passes
3. `bun test --concurrent --dots` -- full suite still passes

### Manual

1. `cd` to a project with nested plans, run `5x --text plan list`
2. `5x plan list` -- JSON envelope includes `plan_path` per entry
3. `5x --text plan list --exclude-finished` -- hides complete plans
4. Run in a project with no plans dir -- empty result, exit 0
