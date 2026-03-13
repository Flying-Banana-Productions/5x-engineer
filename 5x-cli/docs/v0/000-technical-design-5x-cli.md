# 5x CLI - Technical Design (Current)

**Version:** 1.0
**Created:** February 26, 2026
**Status:** Maintained - this doc reflects current implementation (code is source of truth)
**Supersedes:** N/A (new living design doc)

---

## Scope

`5x-cli` orchestrates the 5x author/reviewer workflow:

- `5x plan`: generate an implementation plan from a PRD/TDD doc
- `5x plan-review`: run iterative review/fix loops on a plan
- `5x run`: execute plan phases with author/reviewer/quality loops
- Supporting utilities: `status`, `init`, `worktree`

Non-goals:

- Remote/multi-user service; this is a local tool
- Multi-repo orchestration
- Web UI/dashboard (separate initiative)

---

## System model

### Source of truth

- **SQLite DB**: `.5x/5x.db` is orchestration SOT (runs, events, agent_results, quality_results, phase_progress).
  - Schema/migrations: `src/db/schema.ts`
  - Queries/writes: `src/db/operations.ts`
- **Filesystem artifacts**:
  - **Logs**: `.5x/logs/<runId>/agent-<agentResultId>.ndjson`, plus quality logs `quality-phase<phase>-attempt<attempt>-<slug>.log`
  - **Locks**: `.5x/locks/<hash>.lock` (plan-level, cross-process)
  - **Debug traces** (optional): `.5x/debug/<command>-<timestamp>.ndjson`

### Canonical identity

Plan identity in DB is based on canonicalized plan path:

- Canonicalization: `src/paths.ts` (`canonicalizePlanPath()`)
- Commands pass both:
  - `effectivePlanPath` (may be remapped into a worktree for file I/O)
  - `canonicalPlanPath` (anchored to primary checkout for DB continuity)

---

## Major components

- **Command layer**: `src/commands/*.ts`
  - Resolves project root/config, git safety, lock acquisition, worktree mapping, flags
  - Creates adapter + permission handler + (optional) external TUI listener
  - Starts orchestration loops and ensures cleanup in `finally`

- **Orchestrators**:
  - Plan review loop: `src/orchestrator/plan-review-loop.ts`
  - Phase execution loop: `src/orchestrator/phase-execution-loop.ts`

- **Agent adapter**:
  - Managed local OpenCode server: `src/agents/opencode.ts`
  - Factory + shutdown hooks: `src/agents/factory.ts`
  - Adapter contracts: `src/agents/types.ts`

- **Templates** (bundled, SSOT prompts): `src/templates/loader.ts`
- **Human gates** (CLI prompts): `src/gates/human.ts`
- **Quality gates**: `src/gates/quality.ts`
- **External TUI attach listen (observability only)**: `src/tui/detect.ts`, `src/tui/controller.ts`
- **Permission policy**: `src/tui/permissions.ts`

---

## Commands (behavioral contract)

### `5x run <plan.md>`

Implementation: `src/commands/run.ts`

- **Git safety**: fail closed on dirty worktree unless `--allow-dirty`
- **Plan lock**: acquire `.5x/locks` lock (auto-steals stale locks)
- **Worktrees**: `--worktree` creates `.5x/worktrees/<branch>`; plan/review paths remapped into worktree for agent I/O
- **Non-interactive**: if `!stdin.isTTY` and no `--auto/--ci`, exit with `NON_INTERACTIVE_NO_FLAG_ERROR`
- **Output policy**:
  - `--quiet` overrides
  - default quiet = `!process.stdout.isTTY`
- **TUI**: `--tui-listen` prints OpenCode server URL + attach command; does not take terminal ownership
- **Cancellation**: SIGINT/SIGTERM abort via shared `AbortController` (no `process.exit()`); loops honor `signal`

### `5x plan-review <plan.md>`

Implementation: `src/commands/plan-review.ts`

- Same non-interactive policy as `run`
- Same output + TUI listen behavior (`--quiet`, `--tui-listen`)
- Uses plan review loop; review file path resolved/validated under configured reviews dir

### `5x plan <prd.md>`

Implementation: `src/commands/plan.ts`

- Generates a deterministic plan path under `config.paths.plans` (unless `--out`)
- Non-interactive policy: requires `--ci` (no `--auto` on this command)
- Writes plan file + run records in DB

### `5x status <plan.md>`

Implementation: `src/commands/status.ts`

- Reads plan markdown to compute checkbox completion
- Best-effort DB lookup (read-only) to show active/latest run state

---

## Orchestration loops

### Plan review loop (Loop 1)

Implementation: `src/orchestrator/plan-review-loop.ts`

- Iterates: reviewer -> route verdict -> (auto_fix => author fix -> re-review) / (human_required => escalate)
- Writes:
  - `runs` row (command=`plan-review`)
  - `run_events` journal entries
  - `agent_results` rows (typed status/verdict JSON)
- Logs: `.5x/logs/<runId>/agent-<agentResultId>.ndjson`

### Phase execution loop (Loop 2)

Implementation: `src/orchestrator/phase-execution-loop.ts`

Inner loop per phase:

1) Author execute
2) Quality gates (optional, retry bounded)
3) Reviewer
4) Route verdict:
   - ready => (if not `--auto`) phase gate
   - auto_fix => author fix => back to quality/review
   - human_required => escalation gate

Progress for "what phases are pending" is DB-backed (`phase_progress.review_approved`), not checkbox-based.

---

## Human gates (user input)

Current contract: **all user input is handled by the CLI**.

- Default gate implementations: `src/gates/human.ts`
  - `phaseGate(summary)` -> continue/exit
  - `escalationGate(event)` -> continue(with guidance)/approve/abort
  - `resumeGate(runId, phase, state)` -> resume/start-fresh/abort
- Non-interactive behavior is deterministic (exit/abort) to avoid hangs.

Note: `src/tui/gates.ts` exists but is not wired from commands today.

---

## Permission policy

Implementation: `src/tui/permissions.ts`

- `--auto` / `--ci`: `auto-approve-all`
- Otherwise: `workdir-scoped` (best-effort auto-approve within workdir; reject outside deterministically)
- Fail closed: non-interactive without an explicit policy flag

---

## TUI integration (external attach listen)

Implementation: `src/tui/detect.ts`, `src/tui/controller.ts`

- Enabled only with `--tui-listen` and when stdin+stdout are TTY and not `--quiet`.
- Prints:
  - OpenCode server URL
  - attach command: `opencode attach <url> --dir <workdir>`
- When a user attaches in another terminal and TUI APIs are reachable (`controller.active === true`), 5x may:
  - best-effort `selectSession()`
  - best-effort `showToast()`

This mode is observability-only; it does not accept gate input.

---

## Data model and vocabulary

Schema: `src/db/schema.ts`

Key tables:

- `plans(plan_path, worktree_path, branch, ...)`
- `runs(id, plan_path, command, status, current_phase, current_state, ...)`
  - status values: `active|completed|aborted|failed`
- `run_events(run_id, event_type, phase, iteration, data, created_at)`
- `agent_results(..., result_type in (status, verdict), result_json, log_path, session_id, model, tokens_*, cost_usd, ...)`
- `quality_results(run_id, phase, attempt, passed, results, ...)`
- `phase_progress(plan_path, phase, implementation_done, latest_review_readiness, review_approved, ...)`

The authoritative event vocabulary is whatever orchestrators write via `appendRunEvent()`.

---

## Logging and tracing

- Agent NDJSON logs: written during invocation; filenames are derived from `agent_results.id`.
  - Producers: `src/orchestrator/phase-execution-loop.ts`, `src/orchestrator/plan-review-loop.ts`
- Quality logs: `src/gates/quality.ts`
- Debug traces: `src/debug/trace.ts` enabled via `--debug-trace` or `FIVEX_DEBUG_TRACE`

---

## Relationship to older docs

- `docs/development/001-impl-5x-cli.md`: historical implementation plan; useful for rationale, but not fully current.
- `docs/development/002-impl-realtime-agent-logs.md`: aligns with current NDJSON log artifacts.
- `docs/development/004-impl-5x-cli-tui.md`: historical; deprecated as design doc (see "Current state" header there).
