# Feature: Worktree-Authoritative Execution Context

**Version:** 1.6  
**Created:** March 9, 2026  
**Status:** Proposed (revised)

## Overview

Current behavior has a control-plane/data-plane mismatch:

- Plan-to-worktree mapping exists in root `.5x/5x.db`.
- But command execution context (especially `invoke`) is still derived from current cwd unless `--workdir` is passed.
- This can cause agent edits to land in the wrong checkout and can split run state across multiple `.5x` directories if users run commands from worktrees.

Desired behavior:

- Root repo remains the single control-plane (`.5x/5x.db`, locks, logs index).
- Worktree mapping is authoritative for execution when a run is mapped.
- `invoke`/`quality`/`diff` can resolve execution context by `run_id` without requiring manual `cd` or manual `--workdir`.
- No `.5x` folder is required in worktrees.
- Manual isolated workflow remains supported: users may `5x init` inside a worktree whose parent repo is not 5x-managed, keeping run history local to that checkout.

## Goals

- Make mapped worktree context automatic and deterministic for run-scoped commands.
- Ensure mapped worktree plan file is authoritative when resolving `plan_path` for agent templates.
- Keep run tracking in root DB only (single source of truth).
- Preserve backward compatibility for explicit overrides.

## Non-Goals

- Migrating historical run rows to new schema.
- Removing existing commands (`worktree create/attach/list/remove`).
- Forcing users into worktree-only operation for non-run commands.

## Design Decisions

**Root control-plane stays canonical.**

- All run lifecycle + step recording stays in repo-root DB.
- A worktree checkout does not need its own `.5x` state directory.
- **`db.path` is a directory path** (not a file path). Default: `.5x`. The canonical DB file is always `5x.db` within that directory. When resolving the DB location, `resolveControlPlaneRoot` computes `<controlPlaneRoot>/<db.path>/5x.db` (or `<db.path>/5x.db` directly if `db.path` is absolute). This decouples the config knob from the DB filename and ensures the bootstrap sequence is deterministic: the resolver always knows to look for `5x.db` inside the configured directory.
- **`db.path` backward compatibility:** the current config schema and existing user configs may use file-style values (e.g. `.5x/5x.db`). To avoid breaking backward compat, `resolveControlPlaneRoot` normalizes legacy file-style values during resolution: if `db.path` ends with `/5x.db` or `\5x.db` (i.e. includes the DB filename), the resolver strips the trailing filename component and uses the parent directory. Concretely: `db.path = ".5x/5x.db"` normalizes to `.5x`, and the DB resolves to `.5x/5x.db` as expected. The normalization is applied once during resolution, before any path joining. This means existing configs that set `db.path` to a file path continue to work without migration. The normalization check is: if `path.basename(dbPath) === '5x.db'`, use `path.dirname(dbPath)` instead.

**Authoritative control-plane resolution via git common-dir.**

The root DB must be discoverable from any checkout context — root, nested linked worktrees, and externally attached worktrees (worktrees whose checkout path is outside the main repo directory tree).

Resolution strategy for the canonical control-plane root:

1. From cwd, resolve both `git rev-parse --git-dir` and `git rev-parse --git-common-dir`.
   - `--git-dir` returns the `.git` directory for the current checkout (e.g. `.git` in main checkout, or `.git/worktrees/<name>` / an absolute path for linked worktrees).
   - `--git-common-dir` returns the shared `.git` directory. In the main checkout this equals `--git-dir`. In a linked worktree (including externally attached), it returns the path to the main repo's `.git` directory.
2. Derive an absolute path for common-dir:
   - If `--git-common-dir` returns an absolute path, use it directly.
   - If `--git-common-dir` returns a relative path (starts with `.` or `..`), resolve it relative to the absolute path of `--git-dir`. This handles git's default behavior where common-dir is expressed relative to the worktree's git-dir.
3. Derive the main repo root as the parent of the resolved common-dir (i.e. `dirname(absoluteCommonDir)`).
4. Determine the state directory path. If root config exists and specifies `db.path`, use that value; otherwise use the default (`.5x`). If `db.path` is relative, resolve it relative to the main repo root; if absolute, use it directly. The canonical DB file is always `5x.db` within this directory. **If `<stateDir>/5x.db` exists, that is the canonical control-plane DB (managed mode). This always wins — even if the current checkout also has a local state DB.**
5. If no DB exists at the main repo root's state directory, check the current checkout root for a local state DB. **In isolated mode, the current checkout root IS the control-plane root.** Its local `5x.toml` is the sole config — the `db` section applies directly with no layering against the main repo root config. Read `db.path` from `<checkoutRoot>/5x.toml` (if it exists; otherwise use default `.5x`), apply the same normalization and resolution rules as step 4 but relative to the checkout root. Check `<checkoutRoot>/<stateDir>/5x.db`. If found, that checkout is in isolated mode with `controlPlaneRoot = checkoutRoot`.
6. If neither exists, the command is outside any 5x-managed context and falls through to existing behavior (init prompt, etc.).

Note: the two-stage bootstrap is minimal — step 4 only needs to read `db.path` from the root config file (a TOML parse of a single field), not open the DB. This avoids a chicken-and-egg problem: the config file is a plain file at a known location (`controlPlaneRoot/5x.toml`), so it can be read before the DB exists.

**Root DB always wins.** When the git common-dir root has `<stateDir>/5x.db`, all checkouts (root, nested worktree, externally attached worktree) use that DB regardless of whether the current checkout also has a local state DB. Isolated mode is only possible when the common-dir root does NOT have a state DB — i.e., the user ran `5x init` in a worktree checkout that is not backed by a 5x-managed main repo.

This replaces the current `resolveProjectRoot` → `resolveDbContext` chain as the entry point for control-plane resolution. `resolveProjectRoot` remains used for config discovery (e.g. `5x.toml`) but DB location is no longer derived from it.

A new helper `resolveControlPlaneRoot(startDir?)` encapsulates this logic and is used by `resolveDbContext` and the run context resolver.

**Two operating modes are supported (default + explicit isolated).**

- **Managed mode (default):** commands from any checkout (root or linked worktree) resolve the root state DB via git common-dir. Run-scoped commands use plan→worktree mapping for execution context. When the root DB exists, it is always authoritative — a local state DB in a worktree checkout is ignored.
- **Isolated mode (explicit):** user runs `5x init` in a worktree checkout whose git common-dir root does NOT have a state DB. **The worktree checkout root becomes the control-plane root.** Its local `5x.toml` is the sole config — the `db` section applies directly with no layering against the main repo root config. The local state DB becomes the control-plane DB; state is local to that worktree and can be discarded with it. If a root DB is later created (e.g. via `5x init` in the main checkout), subsequent commands from the worktree will switch to managed mode and use the root DB.
- No implicit cross-sync between managed and isolated DBs.

**Run-scoped context resolution becomes first-class.**

- Add shared resolver: `run_id -> run.plan_path -> plans.worktree_path/branch`.
- All commands with `--run` use the same resolver to derive both effective working directory and effective plan path.
- Scope: `invoke`, `quality run`, `diff`, `run state`, `run record`, `run complete`, `run reopen`, and `run watch` all share this resolver.

**Context precedence (strict).**

1. Explicit CLI override (e.g. `--workdir`) wins.
2. If run has mapped worktree, use mapped worktree.
3. Fallback to current command behavior (project root/cwd semantics).

Note: `quality run` does not currently expose a `--workdir` flag. Phase 3 adds `--workdir` to `quality run` so the precedence model applies symmetrically.

**Mode boundary follows strict precedence.**

- Command context resolution starts by resolving the control-plane root via `resolveControlPlaneRoot` (git common-dir approach).
- If the git common-dir root has `<stateDir>/5x.db`, that DB is used (managed mode). Any local state DB in the current checkout is ignored.
- If the git common-dir root does NOT have a state DB but the current checkout has one, that local DB is used (isolated mode).
- This means a worktree cannot operate in isolated mode while its parent repo is 5x-managed. To use isolated mode, the main repo must not have been initialized with `5x init`.
- **`5x init` from a linked worktree is blocked when the main repo is already 5x-managed.** If `resolveControlPlaneRoot` returns managed mode (root state DB exists), `init.handler.ts` must refuse with a clear error: "This worktree is managed by the control-plane at `<controlPlaneRoot>`. Run `5x init` from the main checkout if you need to re-initialize." No `--force` or `--isolated` escape hatch is provided — the only way to get isolated mode is to have a main checkout that was never 5x-initialized.

**Missing worktree: fail closed for all commands.**

When a run is mapped to a worktree and that worktree path is missing or unreadable on disk, all run-scoped commands fail with a clear error. There is no fallback to root execution or degraded mode. Rationale:

- **Mutating commands** (`invoke`, `quality run`, `run record`, `run complete`): executing against the wrong checkout is worse than failing. Silently falling back to root would modify the wrong files while recording results against the intended run.
- **Read-only commands** (`run state`, `run watch`, `diff --run`): returning data from the wrong checkout is misleading. The mapped worktree is part of the run's contract.
- **Error contract:** return structured error `WORKTREE_MISSING` with the expected path and remediation guidance ("re-attach worktree or remove mapping").

**Worktree command guardrails reduce foot-guns in isolated mode.**

- `worktree create` from a linked worktree checkout should fail by default with a clear error and remediation.
- This avoids accidental nested `.5x/worktrees` trees under a worktree checkout.
- Advanced users can bypass with an explicit override flag (e.g. `--allow-nested`).
- `worktree list` remains safe in all modes.
- `worktree attach/remove` remain allowed, but should emit context-aware warnings when run from isolated mode.

**Plans must live under `controlPlaneRoot`.**

Run-managed plans must have a canonical path that is a descendant of `controlPlaneRoot`. This is enforced at `run init` time: if the resolved `plan_path` is not under `controlPlaneRoot`, `run init` fails with a `PLAN_OUTSIDE_CONTROL_PLANE` error and remediation guidance ("move the plan under the repository root"). Rationale: the run context resolver derives a repo-relative path from `run.plan_path` and re-roots it into mapped worktrees. This only works when the plan is inside the repo tree. External absolute paths cannot be meaningfully re-rooted. Note: symlinks do not help here — `canonicalizePlanPath` resolves symlinks via `realpathSync`, so a symlink to an external plan would still canonicalize outside the repo and be rejected.

`resolveRunExecutionContext` also validates this invariant defensively: if a stored `run.plan_path` is not under `controlPlaneRoot` (e.g. legacy data), it returns a structured error `PLAN_PATH_INVALID` with the offending path and remediation guidance.

**Mapped plan path is authoritative for run-scoped invocation.**

- For `invoke --run R`, if run plan is mapped to worktree, effective `plan_path` var should point to the plan file under that worktree (when present).
- Explicit `--var plan_path=...` still wins.

**Plan-path-anchored config layering for monorepo sub-projects.**

The single root DB model creates a problem for monorepos: `5x.toml` at the repo root is a global config, so `paths.*`, `qualityGates`, and other per-project settings have no sub-project scoping. A monorepo with a `5x-cli/` sub-project that has its own `docs/development/reviews/` directory cannot manage those reviews separately from the repo root config.

Two approaches were evaluated:

1. **Config layering** — multiple `5x.toml` files, nearest-to-context wins for overrides, single root DB unchanged.
2. **Project/workspace concept in DB** — new `projects` table, plans/runs scoped to a project, per-project config stored in DB.

Option 1 was selected. It has fewer edge cases, no DB schema changes, no migration, and a smaller blast radius. Option 2's main advantage (explicit project scope in DB) can be approximated by deriving project context from `plan_path` at query time, and added incrementally if needed later.

Design:

- Config resolution is anchored to the **plan's location** in the project structure, not to cwd. This eliminates ambient context drift while allowing sub-project-specific overrides.
- The `contextDir` used for config discovery depends on the command type:
  - **Creation commands** (no plan yet): cwd — determines where new plans/reviews land.
  - **Plan-scoped commands** (plan exists): `dirname(plan_path)`.
  - **Run-scoped commands** (`--run`): `dirname(effectivePlanPath)` from `resolveRunExecutionContext`.
  - **Global commands** (`run list`, unscoped): `controlPlaneRoot` — root config only.
- **Root config** is discovered from `controlPlaneRoot`. **Nearest config** is discovered by walking up from `contextDir`. If they are different files, nearest config provides overrides.
- Merge semantics: Zod defaults ← root config ← nearest config overrides.
  - **Objects**: deep field-level merge. Sub-project inherits unset fields from root. Example: root sets `author.model = "claude-opus"`, sub-project sets only `author.timeout = 300` → sub-project gets `{ model: "claude-opus", timeout: 300 }`.
  - **Arrays**: replace. Sub-project array replaces root array entirely. Example: sub-project sets `qualityGates = ["pytest"]` → only `["pytest"]`, not appended to root gates.
  - **`db` section**: always from root config (or Zod defaults). Nearest config `db` is ignored with a warning. Rationale: `db.path` must align with worktree-authoritative control-plane resolution; sub-project override would create split-brain DB state.
- **Everything except `db` is overridable** at the sub-project level: `author`, `reviewer`, `opencode`, `qualityGates`, `worktree`, `paths`, and all limits (`maxStepsPerRun`, `maxReviewIterations`, `maxQualityRetries`, `maxAutoRetries`).

**All `.5x` artifact paths are anchored to `controlPlaneRoot`, not `projectRoot`.**

Every handler that constructs a path under `.5x/` must use `controlPlaneRoot` (from `resolveControlPlaneRoot`) as the base, not the ambient `projectRoot` derived from cwd. This ensures artifacts are never split across worktrees. The following artifact subdirectories must all resolve under `<controlPlaneRoot>/<stateDir>/`:

| Artifact | Current base | Files to update |
|---|---|---|
| `logs/<run_id>/` | `projectRoot` | `invoke.handler.ts`, `quality-v1.handler.ts`, `run-v1.handler.ts` |
| `locks/` | `projectRoot` | `lock.ts` |
| `templates/prompts/` | `projectRoot` | `invoke.handler.ts`, `init.handler.ts` |
| `worktrees/` | `projectRoot` | `worktree.handler.ts`, `run-v1.handler.ts` |
| `debug/` | `projectRoot` | `debug/trace.ts` |
| `5x.db` | `projectRoot` | `db/connection.ts` (already handled by Phase 1a) |

Phase 2 and Phase 3 checklist items include explicit re-anchoring for each artifact. Tests verify that artifacts are created under `controlPlaneRoot` when running from a linked worktree.

**Skill/orchestration ergonomics.**

- Skill docs should use `run init --worktree` so mappings are established early.
- Pipeline output should include enough context for downstream commands to remain run/worktree-aware from root cwd.

## Proposed Implementation

### Phase 1: Control-Plane Resolver + Run Context Resolver

**Completion gate:** (a) control-plane root is reliably resolved from any checkout context (root, nested worktree, externally attached worktree); (b) one helper resolves run-scoped worktree + effective plan path; both are used by multiple commands.

#### 1a: Control-plane root resolver

- [x] Add `resolveControlPlaneRoot(startDir?)` helper (new module, e.g. `src/commands/control-plane.ts`).
- [x] Implementation:
  - [x] Run both `git rev-parse --git-dir` and `git rev-parse --git-common-dir` from `startDir` (or cwd).
  - [x] Resolve common-dir to an absolute path: if already absolute, use directly; if relative (starts with `.` or `..`), resolve relative to the absolute path of git-dir.
  - [x] Derive main repo root as `dirname(absoluteCommonDir)`.
  - [x] **DB directory resolution:** read `db.path` from root config file (`<mainRepoRoot>/5x.toml`) if it exists; otherwise use default `.5x`. `db.path` is a directory path. **Backward compat normalization:** if `path.basename(dbPath) === '5x.db'`, strip the filename and use `path.dirname(dbPath)` as the directory. If relative, resolve relative to main repo root; if absolute, use directly. The DB file is always `5x.db` within this directory.
  - [x] Check for `<stateDir>/5x.db` at main repo root → managed mode (always wins, even if local state DB exists).
  - [x] If no root DB, check current checkout root for local `<stateDir>/5x.db` → isolated mode.
  - [x] Return `{ controlPlaneRoot, stateDir, mode: 'managed' | 'isolated' | 'none' }`. In managed mode, `controlPlaneRoot` is the main repo root (parent of git common-dir). In isolated mode, `controlPlaneRoot` is the current checkout root (the worktree itself).
- [x] Update `resolveDbContext()` in `src/commands/context.ts` to use `resolveControlPlaneRoot` for DB path resolution instead of deriving DB path directly from `resolveProjectRoot`.
- [x] **Add `5x init` guard in `src/commands/init.handler.ts`:**
  - [x] Before scaffolding, call `resolveControlPlaneRoot()` from cwd.
  - [x] If mode is `managed` (root state DB exists at git common-dir root), refuse with error: "This worktree is managed by the control-plane at `<controlPlaneRoot>`. Run `5x init` from the main checkout if you need to re-initialize."
  - [x] No escape hatch (`--force` does not bypass this check; it only overwrites config/templates as before).
  - [x] Isolated mode is only allowed when the main checkout was never 5x-initialized (mode is `none`).
- [x] Add unit tests covering: root checkout, nested linked worktree, externally attached worktree (checkout outside repo tree), isolated mode (local state DB in worktree with no root DB), no-context fallback, custom `db.path` directory (non-default), absolute `db.path`, legacy file-style `db.path` normalization (e.g. `.5x/5x.db` → `.5x`), `5x init` blocked from managed worktree, `5x init` allowed from unmanaged worktree.

#### 1b: Run execution context resolver

- [x] Add `resolveRunExecutionContext(runId, opts?)` helper (new module, e.g. `src/commands/run-context.ts`).
- [x] Inputs:
  - [x] `runId` (required)
  - [x] `controlPlaneRoot` (from `resolveControlPlaneRoot`)
  - [x] optional override for explicit workdir
- [x] Output shape:
  - [x] `controlPlaneRoot`
  - [x] `run` (`id`, `plan_path`, `status`)
  - [x] `mappedWorktreePath | null`
  - [x] `effectiveWorkingDirectory`
  - [x] `effectivePlanPath`
  - [x] `planPathInWorktreeExists` (bool)
- [x] Canonical path logic:
  - [x] validate that `run.plan_path` is under `controlPlaneRoot`; if not, return structured error `PLAN_PATH_INVALID` with the offending path and remediation guidance
  - [x] derive repo-relative path from root `run.plan_path`
  - [x] if mapped worktree exists and is accessible on disk, join relative plan path into mapped worktree path
  - [x] if mapped worktree is expected but missing/unreadable, return structured error `WORKTREE_MISSING` with expected path and remediation guidance
  - [x] if derived worktree plan file exists, use it as `effectivePlanPath`; else fallback to root plan path
- [x] Add lightweight unit tests for resolver edge cases (including missing worktree → error, plan path outside control-plane root → error).

Files:

- `src/commands/control-plane.ts` (new — control-plane root resolver)
- `src/commands/run-context.ts` (new — run execution context resolver)
- `src/commands/context.ts` (update `resolveDbContext` to use control-plane resolver)
- `src/commands/init.handler.ts` (add managed-mode guard before scaffolding)
- `src/db/operations-v1.ts` / `src/db/operations.ts` (reuse existing APIs as needed)
- `test/commands/control-plane.test.ts` (new — control-plane resolution tests)
- `test/commands/run-context.test.ts` (new — run context resolver tests)
- `test/commands/init-guard.test.ts` (new — init guard tests for managed/isolated mode boundaries)

#### 1c: Plan-path-anchored config layering

**Completion gate:** config resolution returns the correct layered config for any plan/run context, independent of cwd. Sub-project `5x.toml` overrides are merged correctly with root config.

- [x] Add `resolveLayeredConfig(controlPlaneRoot, contextDir?)` helper in `src/config.ts`.
- [x] Implementation:
  - [x] Discover **root config**: `discoverConfigFile(controlPlaneRoot)`. Load and parse if found.
  - [x] If `contextDir` provided and differs from `controlPlaneRoot`, discover **nearest config**: `discoverConfigFile(contextDir)`. Load and parse if found and is a different file from root config.
  - [x] Merge: Zod defaults ← root config ← nearest config overrides.
  - [x] Objects: deep field-level merge (nearest config inherits unset fields from root).
  - [x] Arrays: replace (nearest config array replaces root array entirely).
  - [x] `db` section: always from root config (or Zod defaults). If nearest config contains `db`, emit warning and ignore.
  - [x] Return `{ config: FiveXConfig, rootConfigPath: string | null, nearestConfigPath: string | null, isLayered: boolean }`.
- [x] Update `resolveProjectContext()` in `src/commands/context.ts` to accept optional `contextDir` parameter and use `resolveLayeredConfig` instead of plain `loadConfig` when `contextDir` is provided.
- [x] Update `resolveDbContext()` to pass `contextDir` through to `resolveProjectContext()`.
- [x] Add unit tests covering:
  - [x] Root config only (no sub-project config): existing behavior preserved, `isLayered = false`.
  - [x] Sub-project config overrides `paths.*`: correct merge, root paths replaced.
  - [x] Sub-project config overrides `qualityGates`: array replace, not append.
  - [x] Sub-project config sets `author.timeout` only: inherits `author.model` from root (deep merge).
  - [x] Sub-project config sets `db.path`: ignored with warning, root DB path used.
  - [x] No root config, sub-project config only: sub-project provides all settings, Zod defaults fill gaps.
  - [x] No config at all: Zod defaults returned, `isLayered = false`.
  - [x] `contextDir` inside sub-project: walks up and finds nearest `5x.toml`.
  - [x] `contextDir` at repo root: finds root `5x.toml` only, no layering.

Files:

- `src/config.ts` (new `resolveLayeredConfig` function + deep merge logic)
- `src/commands/context.ts` (update `resolveProjectContext` / `resolveDbContext` to accept `contextDir`)
- `test/config-layering.test.ts` (new — config layering tests)

### Phase 2: `invoke` Auto-Resolve Workdir + Plan Path

**Completion gate:** `invoke --run` works from root cwd and still executes in mapped worktree by default.

- [ ] Update `invoke.handler.ts`:
  - when `params.run` present and `params.workdir` absent, call resolver and set provider `workingDirectory` to resolved worktree directory.
  - when resolver returns effective mapped plan path, inject it as default for `plan_path` variable resolution.
  - pass `dirname(effectivePlanPath)` as `contextDir` to config resolution so layered config is plan-anchored (Phase 1c).
- [ ] Preserve explicit precedence:
  - explicit `--workdir` wins over mapping
  - explicit `--var plan_path=...` wins over resolver defaults
- [ ] Ensure `invoke` still works for non-run flows and for unmapped runs.
- [ ] **Re-anchor artifact paths to `controlPlaneRoot`:**
  - Log directory: `join(controlPlaneRoot, stateDir, "logs", params.run)` instead of `join(projectRoot, ".5x", "logs", params.run)`.
  - Template override lookup: `join(controlPlaneRoot, stateDir, "templates", "prompts")` instead of `join(projectRoot, ".5x", "templates", "prompts")`.
- [ ] Extend invoke output envelope with optional execution context fields for downstream pipelines:
  - `worktree_path` (if mapped)
  - `worktree_plan_path` (if resolved)

Files:

- `src/commands/invoke.handler.ts`
- `src/pipe.ts` (context extraction updates)
- `src/commands/invoke.ts` (only if new flags needed; likely no changes)

### Phase 3: Run-Scoped `quality`, `diff`, and `run` Subcommand Context

**Completion gate:** all `--run`-addressed commands resolve the same control-plane DB and execute against mapped worktree when applicable.

#### 3a: `quality run` and `diff`

- [ ] `quality run`:
  - add `--workdir` flag for explicit override (aligns with precedence model)
  - add `--run`-aware context resolution via `resolveRunExecutionContext`
  - if run mapped, execute quality gates in mapped worktree directory
  - pass `dirname(effectivePlanPath)` as `contextDir` to config resolution (Phase 1c) so `qualityGates` are resolved from the correct sub-project config
  - **re-anchor log path:** `join(controlPlaneRoot, stateDir, "logs", runId)` instead of `join(projectRoot, ".5x", "logs", runId)`
  - keep recording into root DB by `run`
- [ ] `diff`:
  - add optional `--run <id>`
  - when provided, resolve mapped worktree and run git diff in that directory
  - keep existing behavior unchanged when `--run` omitted

#### 3b: `run` subcommands (`state`, `record`, `complete`, `reopen`, `watch`)

All `run` subcommands that accept `--run` must use the control-plane resolver to open the correct DB, ensuring they never read/write a worktree-local DB when a root DB exists.

- [ ] `run state --run <id>`: update to use `resolveControlPlaneRoot` for DB resolution. When run has mapped worktree, report worktree path in output.
- [ ] `run record --run <id>`: update to use `resolveControlPlaneRoot` for DB resolution. Records always go to root DB.
- [ ] `run complete --run <id>`: update to use `resolveControlPlaneRoot` for DB resolution.
- [ ] `run reopen --run <id>`: update to use `resolveControlPlaneRoot` for DB resolution.
- [ ] `run watch --run <id>`: update to use `resolveControlPlaneRoot` for DB resolution. **Re-anchor log path:** `join(controlPlaneRoot, stateDir, "logs", params.run)` instead of `join(projectRoot, ".5x", "logs", params.run)`.
- [ ] `run list`: update to use `resolveControlPlaneRoot` for DB resolution (no `--run` flag, but must find root DB from any checkout context).
- [ ] `run init`: **re-anchor worktree default path:** `join(controlPlaneRoot, stateDir, "worktrees", ...)` instead of `join(projectRoot, ".5x", "worktrees", ...)`.

Note: `run init` already uses a custom DB resolution flow (lock-first). It must also be updated to resolve the control-plane root via `resolveControlPlaneRoot` so that `run init` from a linked worktree creates the run in the root DB. Config should be resolved with `contextDir = dirname(canonicalPlanPath)` (Phase 1c) so run config inherits the correct sub-project settings.

**Plan-path validation at `run init`:** before creating the run, validate that the resolved `plan_path` is a descendant of `controlPlaneRoot`. If not, fail with `PLAN_OUTSIDE_CONTROL_PLANE` error: "Plan path `<path>` is outside the repository root `<controlPlaneRoot>`. Move the plan under the repository root." (Do not suggest symlinks — `canonicalizePlanPath` resolves symlinks via `realpathSync`, so a symlink to an external plan would still canonicalize outside the repo and be rejected.) This ensures all stored `run.plan_path` values are re-roottable into mapped worktrees.

#### 3c: Cross-cutting artifact path re-anchoring

- [ ] **`lock.ts`:** update lock directory from `join(projectRoot, ".5x", "locks")` to `join(controlPlaneRoot, stateDir, "locks")`. The `controlPlaneRoot` and `stateDir` must be threaded through from the calling context (run handlers already have it from Phase 3b).
- [ ] **`worktree.handler.ts`:** update default worktree creation path from `join(projectRoot, ".5x", "worktrees", ...)` to `join(controlPlaneRoot, stateDir, "worktrees", ...)`.
- [ ] **`debug/trace.ts`:** update debug output directory from `join(projectRoot, ".5x", "debug")` to `join(controlPlaneRoot, stateDir, "debug")`.
- [ ] **`init.handler.ts`:** template scaffolding path already uses `projectRoot` which equals `controlPlaneRoot` when running from main checkout (init is blocked from managed worktrees by Phase 1a guard). No change needed — but add a comment documenting this invariant.
- [ ] Add tests verifying artifact paths resolve under `controlPlaneRoot` when commands are run from a linked worktree.

Files:

- `src/commands/quality-v1.handler.ts`
- `src/commands/quality-v1.ts` (args — add `--workdir`)
- `src/commands/diff.handler.ts`
- `src/commands/diff.ts` (args)
- `src/commands/run-v1.handler.ts` (update all `--run` subcommands + `run init` + `run list`)
- `src/commands/run-v1.ts` (if flag changes needed)
- `src/lock.ts` (re-anchor lock directory)
- `src/commands/worktree.handler.ts` (re-anchor default worktree path)
- `src/debug/trace.ts` (re-anchor debug output directory)
- `test/commands/artifact-paths.test.ts` (new — verify artifact paths resolve under `controlPlaneRoot`)

### Phase 4: `run init` + Pipe Context Enrichment

**Completion gate:** downstream commands receive run/worktree context directly from `run init` output.

- [ ] Extend `run init` success payload to include top-level context fields when worktree is known:
  - `worktree_path`
  - `worktree_plan_path` (derived path in mapped worktree)
- [ ] Update pipe context extraction rules to capture these fields as safe template defaults where applicable.
- [ ] Ensure compatibility with existing envelope consumers.

Files:

- `src/commands/run-v1.handler.ts`
- `src/pipe.ts`
- `test/commands/run-init-worktree.test.ts`
- `test/commands/invoke-pipe.test.ts`

### Phase 5: Skills + Docs Alignment

**Completion gate:** root-start orchestration guidance is worktree-aware and accurate.

- [ ] Update skill docs to use `run init --worktree` and rely on run-scoped context:
  - `src/skills/5x-plan/SKILL.md`
  - `src/skills/5x-plan-review/SKILL.md`
  - `src/skills/5x-phase-execution/SKILL.md`
- [ ] Update user docs:
  - `README.md`
  - `docs/v1/101-cli-primitives.md`
- [ ] Document no-worktree-`.5x` requirement and root control-plane model.

### Phase 6: Worktree Command Guards (Mode-Aware UX)

**Completion gate:** high-risk worktree ops fail safely in linked-worktree context unless explicitly overridden.

- [ ] Use `resolveControlPlaneRoot` (from Phase 1a) as the linked-worktree context detector.
- [ ] `worktree create`:
  - default: fail in linked-worktree context with `WORKTREE_CONTEXT_INVALID`
  - message: "Run from repository root checkout or pass --allow-nested"
  - optional escape hatch: `--allow-nested`
- [ ] `worktree remove`:
  - prevent removing current checkout worktree; return explicit error
  - keep existing force semantics for dirty checks
- [ ] Add warning banners for isolated-mode operations that update local DB mappings only.
- [ ] **Legacy split-brain detection:** when `resolveControlPlaneRoot` finds a root state DB (managed mode) AND the current checkout also has a local `<stateDir>/5x.db`, emit a startup warning: "Local state DB at `<localPath>` is being ignored — using control-plane DB at `<rootPath>`. Local runs/mappings are not visible in managed mode." This alerts users who may have accumulated worktree-local state from pre-fix behavior. Warning is emitted once per command invocation via stderr, not repeated for sub-operations.
- [ ] Update docs/help text for mode expectations.

## Test Matrix

### Control-plane resolution

- [ ] From root checkout: `resolveControlPlaneRoot` returns root path, managed mode.
- [ ] From nested linked worktree (inside repo tree): resolves to root state DB.
- [ ] From externally attached worktree (checkout outside repo tree): resolves to root state DB via git common-dir.
- [ ] From worktree with local state DB but root DB also exists: resolves to root state DB (managed mode wins).
- [ ] From worktree with local state DB and no root DB: resolves to local state DB, isolated mode.
- [ ] Relative `--git-common-dir` result: resolved correctly relative to `--git-dir` absolute path.
- [ ] From directory with no git context: returns mode `none`.
- [ ] Custom `db.path` directory (non-default): resolver finds DB at `<controlPlaneRoot>/<db.path>/5x.db`.
- [ ] Absolute `db.path`: resolver finds DB at `<db.path>/5x.db` directly.
- [ ] Legacy file-style `db.path` (e.g. `.5x/5x.db`): normalized to directory `.5x`, resolver finds DB at `.5x/5x.db` (not `.5x/5x.db/5x.db`).
- [ ] `db.path` read from root config only (not nearest config in layered resolution).

### Core behavior

- [ ] `invoke --run` from repo root uses mapped worktree as provider working dir.
- [ ] `invoke --run` from a linked worktree resolves root DB and uses mapped worktree.
- [ ] `invoke --run --workdir <x>` uses explicit workdir (override).
- [ ] `invoke --run` with explicit `--var plan_path=...` keeps explicit value.
- [ ] `invoke --run` with no explicit `plan_path` uses mapped worktree plan path when present.

### Pipe behavior

- [ ] `run init --worktree | invoke ...` carries `run_id` and worktree context correctly.
- [ ] `invoke` still accepts envelopes without worktree fields (backward compatible).

### Quality/diff

- [ ] `quality run --run <id>` executes gates in mapped worktree and records against root DB run.
- [ ] `quality run --run <id> --workdir <x>` uses explicit workdir (override).
- [ ] `diff --run <id>` diffs mapped worktree.
- [ ] `diff` without `--run` remains unchanged.

### Run subcommands

- [ ] `run state --run <id>` from linked worktree resolves root DB.
- [ ] `run record --run <id>` from linked worktree writes to root DB.
- [ ] `run complete --run <id>` from linked worktree writes to root DB.
- [ ] `run reopen --run <id>` from linked worktree writes to root DB.
- [ ] `run watch --run <id>` from linked worktree reads logs from root.
- [ ] `run list` from linked worktree lists runs from root DB.
- [ ] `run init` from linked worktree creates run in root DB.

### Error paths

- [ ] Mapped worktree missing on disk: all run-scoped commands fail with `WORKTREE_MISSING` error (no fallback).
- [ ] `WORKTREE_MISSING` error includes expected path and remediation guidance.
- [ ] Run not found: existing error contract preserved.
- [ ] `worktree create` from linked-worktree context fails unless `--allow-nested`.
- [ ] `5x init` from linked worktree when root state DB exists: fails with managed-mode error (no escape hatch).
- [ ] `5x init --force` from linked worktree when root state DB exists: still fails (force does not bypass managed-mode guard).
- [ ] `run init` with plan path outside `controlPlaneRoot`: fails with `PLAN_OUTSIDE_CONTROL_PLANE` error.
- [ ] `resolveRunExecutionContext` with stored plan path outside `controlPlaneRoot` (legacy data): returns `PLAN_PATH_INVALID` error.

### Externally attached worktree (end-to-end)

- [ ] `invoke --run` from externally attached worktree resolves root DB and uses mapped worktree.
- [ ] `quality run --run` from externally attached worktree resolves root DB and executes in mapped worktree.
- [ ] `run state --run` from externally attached worktree resolves root DB.
- [ ] `run init` from externally attached worktree creates run in root DB.
- [ ] `run list` from externally attached worktree lists runs from root DB.

### Config layering

- [ ] Root config only (no sub-project `5x.toml`): `resolveLayeredConfig` returns root config, `isLayered = false`.
- [ ] Sub-project `5x.toml` overrides `paths.*`: merged config uses sub-project paths, root config for everything else.
- [ ] Sub-project `5x.toml` overrides `qualityGates`: sub-project array replaces root array (not appended).
- [ ] Sub-project `5x.toml` sets only `author.timeout`: merged config has root `author.model` + sub-project `author.timeout` (deep field-level merge).
- [ ] Sub-project `5x.toml` sets `db.path`: ignored with warning, root `db.path` used.
- [ ] No root config, sub-project config only: sub-project provides all settings, Zod defaults fill gaps.
- [ ] No config at all: Zod defaults returned, `isLayered = false`.
- [ ] `invoke --run` for plan under sub-project: config resolved from sub-project `5x.toml`, not root.
- [ ] `quality run --run` for plan under sub-project: `qualityGates` from sub-project config.
- [ ] `run init` for plan under sub-project: run config uses sub-project settings.
- [ ] Plan creation from sub-project cwd: `paths.*` from nearest `5x.toml` determine output location.
- [ ] Plan creation from repo root cwd: root `5x.toml` paths used (no sub-project overlay).

### Isolated mode

Isolated mode only applies when the git common-dir root does NOT have a state DB.

- [ ] `5x init` inside a worktree whose parent repo has no state DB creates local state DB; subsequent commands use local DB (isolated mode).
- [ ] `5x init` inside a worktree whose parent repo HAS a state DB: **refused** (managed-mode guard).
- [ ] `5x init` inside an externally attached worktree whose parent repo has no state DB creates local state DB (isolated mode).
- [ ] Commands in isolated mode do not read/write the root DB (because it doesn't exist).
- [ ] Isolated mode `controlPlaneRoot` is the checkout root, not the main repo root.
- [ ] Isolated mode `db.path` is read from the checkout root's `5x.toml`, not the main repo root's config.
- [ ] `run init` in isolated mode creates run in local DB, not root DB.
- [ ] `invoke --run` in isolated mode uses local DB run context.
- [ ] `quality run --run` in isolated mode executes against local checkout.
- [ ] Root DB creation overrides isolated mode: if `5x init` is later run in the main checkout, subsequent commands from the worktree switch to managed mode and use the root DB (local state DB is ignored).
- [ ] `worktree attach/remove` from isolated mode emit context-aware warnings.
- [ ] When root DB exists AND local state DB exists, commands always use root DB (managed mode wins).
- [ ] When root DB exists AND local state DB exists, startup warning is emitted about ignored local DB.

### Artifact path re-anchoring

- [ ] `invoke --run` from linked worktree: logs written under `<controlPlaneRoot>/<stateDir>/logs/`, not under worktree's `.5x/logs/`.
- [ ] `quality run --run` from linked worktree: logs written under `<controlPlaneRoot>/<stateDir>/logs/`.
- [ ] `run watch --run` from linked worktree: logs read from `<controlPlaneRoot>/<stateDir>/logs/`.
- [ ] Lock files created under `<controlPlaneRoot>/<stateDir>/locks/` when commands run from linked worktree.
- [ ] Template overrides read from `<controlPlaneRoot>/<stateDir>/templates/prompts/` when `invoke` runs from linked worktree.
- [ ] Default worktree creation path is `<controlPlaneRoot>/<stateDir>/worktrees/` regardless of cwd.
- [ ] Debug traces written under `<controlPlaneRoot>/<stateDir>/debug/` when commands run from linked worktree.
- [ ] Custom `db.path` directory: all artifact subdirectories (logs, locks, templates, worktrees, debug) resolve under the custom state directory.

## Backward Compatibility

- Existing workflows that explicitly `cd` into worktree keep working.
- Existing workflows using explicit `--workdir` keep working.
- Existing JSON envelope fields remain; new fields are additive.
- Manual isolated workflows (`5x init` inside worktree, local `.5x`) remain supported when the parent repo is not 5x-managed.

## Risks and Mitigations

- **Risk:** path canonicalization bugs across root/worktree paths.
  - **Mitigation:** centralized resolver + focused tests around relative path derivation.
- **Risk:** mixed root/worktree configs if both contain `5x.toml`.
  - **Mitigation:** for run-scoped commands, root resolution is derived from run DB context, not ambient cwd. Config layering (Phase 1c) formalizes precedence: root config is base, nearest-to-plan config provides overrides with deep merge.
- **Risk:** commands without `--run` remain ambiguous from root cwd.
  - **Mitigation:** keep behavior explicit; only run-scoped auto-resolution is automatic.
- **Risk:** config layering merge semantics surprise users (e.g. array replace vs append).
  - **Mitigation:** arrays replace (not append) — predictable and consistent. Document merge semantics in user docs (Phase 5). Emit `isLayered` flag in resolver output so commands can surface which config files are active.

## Rollout

1. Implement Phase 1a-1b (control-plane resolver + run context resolver + `5x init` managed-mode guard).
2. Implement Phase 1c (config layering).
3. Land Phase 2 (invoke auto-resolve with layered config + artifact path re-anchoring for invoke).
4. Land Phase 3 (`quality`/`diff` + all `run` subcommands: `state`, `record`, `complete`, `reopen`, `watch`, `list`, `init` — all with `contextDir` threading + plan-path validation + cross-cutting artifact re-anchoring).
5. Land Phase 4-5 (envelope enrichment + skills/docs — document config layering semantics).
6. Land Phase 6 (worktree command guards + legacy split-brain detection warning).
7. Run full test suite + typecheck + lint.

## Acceptance Criteria

- From repo root, with a mapped plan/worktree and active run:
  - `5x invoke author ... --run <id>` edits files in mapped worktree by default.
  - `5x quality run --run <id>` executes in mapped worktree and records to root run DB.
  - `5x diff --run <id>` inspects mapped worktree changes.
- No `.5x/` directory is required in worktree checkouts for managed mode.
- `5x init` from a linked worktree whose main repo is already 5x-managed is refused outright (no escape hatch).
- In isolated mode (parent repo not 5x-managed), `5x init` inside a worktree creates local state DB and commands run entirely against that local state.
- When root DB exists, it always wins: a local state DB in a worktree is ignored in favor of the root DB, with a startup warning emitted.
- `run init` rejects plan paths outside `controlPlaneRoot`.
- All `.5x` artifacts (logs, locks, templates, worktrees, debug) resolve under `controlPlaneRoot`/`stateDir`, not under the ambient `projectRoot` from cwd.
- `db.path` is treated as a directory path (default `.5x`); the DB file is always `5x.db` within that directory. Legacy file-style `db.path` values (e.g. `.5x/5x.db`) are normalized to their parent directory automatically.
- In a monorepo with sub-project `5x.toml` (e.g. `5x-cli/5x.toml`):
  - Plans under the sub-project use the sub-project's `paths.*`, `qualityGates`, and other config.
  - Plans under the repo root use the root `5x.toml` config (or Zod defaults if none).
  - All runs are stored in the single root state DB regardless of which sub-project config is active.
  - Sub-project `db` overrides are ignored; root DB is always authoritative.

## Revision History

### v1.6 — March 9, 2026 (review addendum: `013-worktree-authoritative-execution-context-review.md`, v1.5 re-review)

Addressed remaining concerns from the v1.5 re-review addendum:

- **P1.1 — `db.path` backward compatibility normalization.** The plan now changes `db.path` from file to directory semantics, but existing configs may have file-style values like `.5x/5x.db`. Added normalization rule: if `path.basename(dbPath) === '5x.db'`, strip the filename and use `path.dirname(dbPath)`. Applied in design decisions (`db.path` section), Phase 1a implementation (DB directory resolution step), Phase 1a test list, and control-plane resolution test matrix. Updated acceptance criteria.
- **P1.2 — Isolated-mode `db.path` resolution made explicit.** In isolated mode, the worktree checkout root IS the control-plane root. Its local `5x.toml` is the sole config — the `db` section applies directly with no layering against the main repo root config. Updated: resolution algorithm step 5, "Two operating modes" section, `resolveControlPlaneRoot` return shape description, and isolated mode test matrix (added `controlPlaneRoot` identity and `db.path` source tests).
- **P2.1 — Symlink remediation text fixed.** Removed "use a symlink" from plan-path error remediation guidance. `canonicalizePlanPath()` resolves symlinks via `realpathSync`, so symlinks to external plans would still canonicalize outside the repo and be rejected. Updated: "Plans must live under controlPlaneRoot" design section and Phase 3b `run init` plan-path validation text. Both now explain why symlinks don't help.

### v1.5 — March 9, 2026 (review: `013-worktree-authoritative-execution-context-review.md`)

Addressed review feedback (P0 blockers, P1 high-priority, P2 medium-priority):

- **P0.1 — DB bootstrap contract resolved.** `db.path` is now defined as a **directory path** (not file path), default `.5x`. The canonical DB file is always `5x.db` within that directory. `resolveControlPlaneRoot` performs a two-stage bootstrap: reads `db.path` from root config file (plain TOML parse) before opening the DB, then checks `<stateDir>/5x.db` relative to the control-plane root (or absolute if `db.path` is absolute). Updated: design decisions ("Root control-plane stays canonical"), resolution algorithm (step 4), Phase 1a implementation, `resolveControlPlaneRoot` return shape (now includes `stateDir`), and test matrix (custom/absolute `db.path` cases).
- **P0.2 — `5x init` managed-mode guard added.** `init.handler.ts` now calls `resolveControlPlaneRoot()` before scaffolding. If mode is `managed` (root state DB exists), init refuses outright — no `--force` or `--isolated` escape hatch. Isolated mode is only possible when the main checkout was never 5x-initialized. Updated: "Mode boundary follows strict precedence" section, Phase 1a checklist and file list, test matrix (error paths + isolated mode sections).
- **P1.1 — Plan-path contract defined.** Plans must live under `controlPlaneRoot`. Validated at `run init` time (`PLAN_OUTSIDE_CONTROL_PLANE` error). `resolveRunExecutionContext` defensively validates stored paths (`PLAN_PATH_INVALID` error for legacy data). New "Plans must live under controlPlaneRoot" design section. Updated: Phase 1b canonical path logic, Phase 3b `run init` note, error paths test matrix.
- **P1.2 — All `.5x` artifact paths explicitly re-anchored to `controlPlaneRoot`.** New design section ("All `.5x` artifact paths are anchored to `controlPlaneRoot`, not `projectRoot`") with artifact table listing every subdirectory and the files to update. Explicit re-anchoring checklist items added to Phase 2 (logs, templates for invoke), Phase 3a (logs for quality), Phase 3b (logs for run watch, worktrees for run init), and new Phase 3c (locks, worktrees, debug, init invariant comment). New test matrix section ("Artifact path re-anchoring") with 8 test cases. New test file `test/commands/artifact-paths.test.ts` added to Phase 3c file list.
- **P2.1 — Legacy split-brain detection warning.** Phase 6 now includes a checklist item for emitting a startup warning when `resolveControlPlaneRoot` finds a root state DB AND a local state DB exists in the current checkout. Warning emitted once per command invocation via stderr. Test case added to isolated mode test matrix.

### v1.4 — March 9, 2026

Added plan-path-anchored config layering for monorepo sub-project support:

- **Problem:** single root DB model makes `5x.toml` config global — `paths.*`, `qualityGates`, and other per-project settings cannot be scoped to sub-projects (e.g. `5x-cli/` within a broader monorepo).
- **Approach selection:** evaluated config layering (multiple `5x.toml` files, nearest-to-context wins) vs project/workspace concept in DB (new `projects` table). Selected config layering — fewer edge cases, no DB schema changes, smaller blast radius.
- **Design:** config resolution anchored to plan's location (not cwd) eliminates ambient context drift. `contextDir` varies by command type: cwd for creation, `dirname(plan_path)` for plan-scoped, `dirname(effectivePlanPath)` for run-scoped, `controlPlaneRoot` for global.
- **Merge semantics:** Zod defaults ← root config ← nearest config. Objects: deep field-level merge. Arrays: replace. `db` section: always from root (sub-project override ignored with warning).
- **Overridable scope:** everything except `db`. Includes `author`, `reviewer`, `opencode`, `qualityGates`, `worktree`, `paths`, and all limits.
- Added Phase 1c (config layering implementation) between existing Phase 1b and Phase 2.
- Updated Phases 2-3 to note `contextDir` threading requirement for command handlers.
- Added config layering test matrix section.
- Updated Risks, Rollout, and Acceptance Criteria sections.

### v1.3 — March 9, 2026 (review addendum: `.5x/runs/run_fef6a3ad86da/review.md`)

Addressed three remaining concerns from the review addendum (2026-03-09):

- **Mode precedence inconsistency (addendum concern 1):** Resolved conflicting statements about managed-vs-isolated mode. Established single authoritative rule: root DB always wins. When git common-dir root has `.5x/5x.db`, it is used regardless of local `.5x/5x.db` in the current checkout. Isolated mode is ONLY possible when the common-dir root does NOT have a `.5x` DB. Updated: resolution algorithm (step 4), "Two operating modes" section, "Mode boundary" section (renamed to "Mode boundary follows strict precedence"), isolated mode test matrix, backward compat, acceptance criteria, and overview.
- **Git path resolution gap (addendum concern 2):** Resolution algorithm now explicitly captures both `git rev-parse --git-dir` and `git rev-parse --git-common-dir`. Relative common-dir results are resolved relative to the absolute path of git-dir. Updated: resolution algorithm (steps 1-2), Phase 1a implementation checklist, and added relative path resolution test case to control-plane test matrix.
- **Rollout misalignment (addendum concern 3):** Rollout section Phase 3 now explicitly lists all `run` subcommands (`state`, `record`, `complete`, `reopen`, `watch`, `list`, `init`) alongside `quality`/`diff`. Added Phase 6 (worktree command guards) as a rollout step.

### v1.2 — March 9, 2026 (review: `.5x/runs/run_fef6a3ad86da/review.md`)

Addressed review feedback. All items from the initial review were already incorporated in v1.1; v1.2 strengthens test coverage for remaining P2 gaps.

- **P0.1** (control-plane resolution for attached worktrees): Verified — git common-dir strategy, `resolveControlPlaneRoot` helper, and externally attached worktree test cases were already present in v1.1.
- **P1.1** (all `--run` commands share resolver): Verified — Phase 3b already covers `run state/record/complete/reopen/watch/list/init`. Scope line at Design Decisions §"Run-scoped context resolution" enumerates all commands.
- **P1.2** (fail closed for missing worktree): Verified — "Missing worktree: fail closed for all commands" section already specifies no-fallback semantics for both mutating and read-only commands, with `WORKTREE_MISSING` error contract.
- **P2.1** (`--workdir` for `quality run`): Verified — already specified in precedence note (line 79) and Phase 3a checklist.
- **P2.2** (test matrix coverage): **Expanded.** Added "Externally attached worktree (end-to-end)" test section covering invoke, quality, run subcommands, and run init from externally attached worktrees. Expanded "Isolated mode" section with coverage for `5x init` in externally attached worktrees, run-scoped commands in isolated mode, and mode switching behavior.

### v1.1 — March 9, 2026

Initial revision incorporating human decisions on review feedback:

- Added "Authoritative control-plane resolution via git common-dir" design section with 5-step resolution strategy.
- Added `resolveControlPlaneRoot` helper to Phase 1a with implementation details.
- Extended Phase 3 with §3b covering all `run` subcommands (`state`, `record`, `complete`, `reopen`, `watch`, `list`, `init`).
- Added "Missing worktree: fail closed for all commands" design section with `WORKTREE_MISSING` error contract.
- Added `--workdir` flag to `quality run` in Phase 3a.
- Added control-plane resolution and run subcommand test matrix sections.

### v1.0 — March 9, 2026

Initial draft.
