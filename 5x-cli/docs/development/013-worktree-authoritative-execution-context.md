# Feature: Worktree-Authoritative Execution Context

**Version:** 1.0  
**Created:** March 9, 2026  
**Status:** Proposed

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
- Manual isolated workflow remains supported: users may `5x init` inside a worktree and keep run history local to that checkout.

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

- All run lifecycle + step recording stays in repo-root DB (`.5x/5x.db` from root config).
- A worktree checkout does not need its own `.5x` state directory.

**Two operating modes are supported (default + explicit isolated).**

- **Managed mode (default):** run from repo root, use root `.5x/5x.db`, leverage plan->worktree mapping for execution context.
- **Isolated mode (explicit):** user runs `5x init` in a worktree checkout and operates there as standalone root; state is local to that worktree and can be discarded with it.
- No implicit cross-sync between managed and isolated DBs.

**Run-scoped context resolution becomes first-class.**

- Add shared resolver: `run_id -> run.plan_path -> plans.worktree_path/branch`.
- Commands with `--run` can derive both effective working directory and effective plan path.

**Context precedence (strict).**

1. Explicit CLI override (e.g. `--workdir`) wins.
2. If run has mapped worktree, use mapped worktree.
3. Fallback to current command behavior (project root/cwd semantics).

**Mode boundary is checkout-local.**

- Command context resolution starts from the current checkout's project root (`resolveProjectRoot`).
- If that root has its own `.5x/5x.db`, commands use it (isolated mode).
- Managed mode behavior applies within whichever control-plane DB the command is currently using.

**Worktree command guardrails reduce foot-guns in isolated mode.**

- `worktree create` from a linked worktree checkout should fail by default with a clear error and remediation.
- This avoids accidental nested `.5x/worktrees` trees under a worktree checkout.
- Advanced users can bypass with an explicit override flag (e.g. `--allow-nested`).
- `worktree list` remains safe in all modes.
- `worktree attach/remove` remain allowed, but should emit context-aware warnings when run from isolated mode.

**Mapped plan path is authoritative for run-scoped invocation.**

- For `invoke --run R`, if run plan is mapped to worktree, effective `plan_path` var should point to the plan file under that worktree (when present).
- Explicit `--var plan_path=...` still wins.

**Skill/orchestration ergonomics.**

- Skill docs should use `run init --worktree` so mappings are established early.
- Pipeline output should include enough context for downstream commands to remain run/worktree-aware from root cwd.

## Proposed Implementation

### Phase 1: Shared Run Context Resolver

**Completion gate:** one helper resolves run-scoped worktree + effective plan path; used by multiple commands.

- [ ] Add `resolveRunExecutionContext(runId, opts?)` helper (new module, e.g. `src/commands/run-context.ts`).
- [ ] Inputs:
  - `runId` (required)
  - `projectRoot` (resolved by caller or helper)
  - optional override for explicit workdir
- [ ] Output shape:
  - `projectRoot`
  - `run` (`id`, `plan_path`, `status`)
  - `mappedWorktreePath | null`
  - `effectiveWorkingDirectory`
  - `effectivePlanPath`
  - `planPathInWorktreeExists` (bool)
- [ ] Canonical path logic:
  - derive repo-relative path from root `run.plan_path`
  - if mapped worktree exists, join relative plan path into mapped worktree path
  - if derived worktree plan file exists, use it as `effectivePlanPath`; else fallback to root plan path
- [ ] Add lightweight unit tests for resolver edge cases.

Files:

- `src/commands/run-context.ts` (new)
- `src/commands/context.ts` (optional helper glue)
- `src/db/operations-v1.ts` / `src/db/operations.ts` (reuse existing APIs as needed)
- `test/commands/*` (new resolver-focused tests or command integration tests)

### Phase 2: `invoke` Auto-Resolve Workdir + Plan Path

**Completion gate:** `invoke --run` works from root cwd and still executes in mapped worktree by default.

- [ ] Update `invoke.handler.ts`:
  - when `params.run` present and `params.workdir` absent, call resolver and set provider `workingDirectory` to resolved worktree directory.
  - when resolver returns effective mapped plan path, inject it as default for `plan_path` variable resolution.
- [ ] Preserve explicit precedence:
  - explicit `--workdir` wins over mapping
  - explicit `--var plan_path=...` wins over resolver defaults
- [ ] Ensure `invoke` still works for non-run flows and for unmapped runs.
- [ ] Extend invoke output envelope with optional execution context fields for downstream pipelines:
  - `worktree_path` (if mapped)
  - `worktree_plan_path` (if resolved)

Files:

- `src/commands/invoke.handler.ts`
- `src/pipe.ts` (context extraction updates)
- `src/commands/invoke.ts` (only if new flags needed; likely no changes)

### Phase 3: Run-Scoped `quality` and `diff` Context

**Completion gate:** run-scoped quality/diff can execute against mapped worktree without manual cwd changes.

- [ ] `quality run`:
  - add optional `--run`-aware context resolution
  - if run mapped and no explicit workdir override mechanism exists, execute quality gates in mapped worktree directory
  - keep recording into root DB by `run`
- [ ] `diff`:
  - add optional `--run <id>`
  - when provided, resolve mapped worktree and run git diff in that directory
  - keep existing behavior unchanged when `--run` omitted

Files:

- `src/commands/quality-v1.handler.ts`
- `src/commands/quality-v1.ts` (args)
- `src/commands/diff.handler.ts`
- `src/commands/diff.ts` (args)

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

- [ ] Add linked-worktree context detector (shared utility, e.g. git common-dir vs git-dir check).
- [ ] `worktree create`:
  - default: fail in linked-worktree context with `WORKTREE_CONTEXT_INVALID`
  - message: "Run from repository root checkout or pass --allow-nested"
  - optional escape hatch: `--allow-nested`
- [ ] `worktree remove`:
  - prevent removing current checkout worktree; return explicit error
  - keep existing force semantics for dirty checks
- [ ] Add warning banners for isolated-mode operations that update local DB mappings only.
- [ ] Update docs/help text for mode expectations.

## Test Matrix

### Core behavior

- [ ] `invoke --run` from repo root uses mapped worktree as provider working dir.
- [ ] `invoke --run --workdir <x>` uses explicit workdir (override).
- [ ] `invoke --run` with explicit `--var plan_path=...` keeps explicit value.
- [ ] `invoke --run` with no explicit `plan_path` uses mapped worktree plan path when present.

### Pipe behavior

- [ ] `run init --worktree | invoke ...` carries `run_id` and worktree context correctly.
- [ ] `invoke` still accepts envelopes without worktree fields (backward compatible).

### Quality/diff

- [ ] `quality run --run <id>` executes gates in mapped worktree and records against root DB run.
- [ ] `diff --run <id>` diffs mapped worktree.
- [ ] `diff` without `--run` remains unchanged.

### Error paths

- [ ] mapped worktree missing on disk: clear error/warning path with fallback behavior where safe.
- [ ] run not found: existing error contract preserved.
- [ ] `worktree create` from linked-worktree context fails unless `--allow-nested`.

## Backward Compatibility

- Existing workflows that explicitly `cd` into worktree keep working.
- Existing workflows using explicit `--workdir` keep working.
- Existing JSON envelope fields remain; new fields are additive.
- Manual isolated workflows (`5x init` inside worktree, local `.5x`) remain supported.

## Risks and Mitigations

- **Risk:** path canonicalization bugs across root/worktree paths.
  - **Mitigation:** centralized resolver + focused tests around relative path derivation.
- **Risk:** mixed root/worktree configs if both contain `5x.toml`.
  - **Mitigation:** for run-scoped commands, root resolution is derived from run DB context, not ambient cwd.
- **Risk:** commands without `--run` remain ambiguous from root cwd.
  - **Mitigation:** keep behavior explicit; only run-scoped auto-resolution is automatic.

## Rollout

1. Implement Phase 1-2 (resolver + invoke).
2. Land Phase 3 (`quality`/`diff` run-scoped behavior).
3. Land Phase 4-5 (envelope enrichment + skills/docs).
4. Run full test suite + typecheck + lint.

## Acceptance Criteria

- From repo root, with a mapped plan/worktree and active run:
  - `5x invoke author ... --run <id>` edits files in mapped worktree by default.
  - `5x quality run --run <id>` executes in mapped worktree and records to root run DB.
  - `5x diff --run <id>` inspects mapped worktree changes.
- No `.5x/` directory is required in worktree checkouts for managed mode.
- In isolated mode, `5x init` inside a worktree creates local `.5x/5x.db` and commands run entirely against that local state.
