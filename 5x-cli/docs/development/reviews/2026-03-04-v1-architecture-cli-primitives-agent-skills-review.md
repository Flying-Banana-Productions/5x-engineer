# Review: 5x CLI v1 design docs (Architecture, CLI primitives, Agent skills)

**Review type:** Design doc review (`docs/v1/100-architecture.md`, `docs/v1/101-cli-primitives.md`, `docs/v1/102-agent-skills.md`)  
**Scope:** v1 proposal consistency (PM + Staff Eng), cross-check against `docs/000-technical-design-5x-cli.md` and current code in `src/`  
**Reviewer:** Principal PM + Staff engineer (product UX, correctness, operability, migration, security)  
**Local verification:** Not run (static review: docs + repo inspection)

**Implementation plan:** N/A  
**Technical design:** `docs/000-technical-design-5x-cli.md`

## Summary

These docs propose a clear architectural pivot: move orchestration logic out of TypeScript loops and into an orchestrating agent skill, with the CLI providing a composable, JSON-returning toolbelt. The direction is strong (modularity, resumability, fewer brittle transitions).

However, as written they are not consistent with current implementation or the maintained technical design (`docs/000-technical-design-5x-cli.md`). They specify a command surface (`5x run init/state/record`, `5x invoke`, `5x prompt`, `5x quality run`, `5x diff`, `5x plan phases`) and a DB schema (`steps` table) that do not exist today, and a provider abstraction (Codex/Claude Agent SDK) that is not present in `src/agents/` (OpenCode-only). The set needs a tighter “current vs proposed” contract and an explicit migration/back-compat plan.

**Readiness:** Not ready — P0 items are about spec/impl alignment, migration, and contract clarity.

---

## Strengths

- **Correct diagnosis of v0 pain:** state-machine edge-case growth and inability to semantically validate outputs matches issues implicit in `src/orchestrator/*` complexity.
- **Toolbelt separation is a good product abstraction:** “primitives return JSON, orchestration lives outside” enables human, agent, and CI consumers.
- **Provider-agnostic intent is right:** decoupling from a single runtime reduces vendor lock and supports long-term platform strategy.
- **Idempotent/resumable model is directionally correct:** step journaling as SOT makes recovery explainable and auditable.

---

## Doc-by-doc consistency notes

- `docs/v1/100-architecture.md`: strong narrative + layering model, but currently conflicts with `docs/000-technical-design-5x-cli.md` on what exists (provider set, DB schema, orchestration removal). Migration section references files that still exist and are currently wired (`src/orchestrator/*`, `src/commands/run.ts`, `src/commands/plan-review.ts`).
- `docs/v1/101-cli-primitives.md`: reads like an implementation-ready spec, but the described commands and JSON envelope are not implemented; also its proposed log naming/sequence differs from current `.5x/logs/<runId>/agent-<uuid>.ndjson` and current DB tables.
- `docs/v1/102-agent-skills.md`: internally consistent as a workflow description, but is not runnable without `101` primitives; also some invariants (commit required for plan revision) are stricter than current protocol enforcement (`src/protocol.ts` + `src/orchestrator/plan-review-loop.ts`).

---

## Production readiness blockers

### P0.1 — Spec must clearly separate “proposed v1” from “current v0”

**Risk:** Today’s maintained design (`docs/000-technical-design-5x-cli.md`) claims to reflect current implementation (it does: orchestrator loops, OpenCode adapter, current DB tables). `docs/v1/100-architecture.md` currently says it “supersedes” that doc, which will mislead implementers and users because v1 is not implemented.

**Requirement:**
- Mark all `docs/v1/*` as “Proposed” (or “Draft — Not implemented”) and remove/adjust supersedence language until merged.
- Add a “Compatibility with current CLI” section that explicitly lists what exists today vs what will be introduced.

**Implementation guidance:**
- In `docs/v1/100-architecture.md`, change **Supersedes** to “N/A (proposal)” or “Supersedes upon release”.

---

### P0.2 — CLI contract mismatch: v1 primitives are not present in current implementation

**Risk:** `docs/v1/101-cli-primitives.md` defines a new public contract (JSON envelope, exit codes, commands) that is incompatible with the current UX and command set (plain text output; orchestrators own agent invocation; no `invoke/prompt/quality/diff/plan phases` subcommands).

**Requirement:**
- Either (A) explicitly scope `101-cli-primitives.md` as an aspirational spec with a phased rollout plan, or (B) update it to match current commands and only describe deltas.
- Provide a command mapping table (old -> new) including deprecation/renames (`5x run <plan>` vs `5x run init/...` etc.).

**Implementation guidance:**
- If keeping the toolbelt design: document how the existing top-level commands (`5x plan`, `5x plan-review`, `5x run`) will be implemented on top of primitives during migration (or explicitly deprecated).

---

### P0.3 — Data model mismatch: v1 `steps` table vs current `.5x/5x.db` schema

**Risk:** `101` proposes `runs` + `steps` as the sole journal; current DB schema is `runs` + `run_events` + `agent_results` + `quality_results` + `phase_progress` (`src/db/schema.ts`). This affects resumability semantics, log path naming, and tooling (`5x status` reads phase_progress approvals).

**Requirement:**
- Choose one: migrate to `steps` with a migration plan, or keep current tables and update v1 docs accordingly.
- Define idempotency semantics precisely (insert-ignore vs upsert/overwrite). Current code uses upsert semantics for agent_results and quality_results.

**Implementation guidance:**
- If migrating: specify how `phase_progress` is computed (or replaced) and how `5x status` should behave without it.

---

### P0.4 — Provider architecture in v1 docs does not match current agent adapter

**Risk:** `100`/`101` describe an `AgentProvider`/`AgentSession` interface with start/resume/stream events and multiple providers (OpenCode, Codex, Claude Agent). Current implementation has `AgentAdapter` (`src/agents/types.ts`) and only an OpenCode SDK adapter (`src/agents/opencode.ts`), with raw OpenCode events logged.

**Requirement:**
- Align terminology and interfaces: either adopt the new provider interface in code (and document how it maps to the existing adapter), or rewrite v1 docs to describe the current adapter and the intended refactor path.
- Ensure logging/event normalization spec matches reality: v1 claims normalized `AgentEvent` logs; current writes provider-native OpenCode events.

**Implementation guidance:**
- Add a “provider event/log format” decision: raw-provider NDJSON vs normalized NDJSON; if normalized, specify retention of raw events for debug.

---

### P0.5 — Skills doc is not executable against the current CLI

**Risk:** `docs/v1/102-agent-skills.md` workflows depend on primitives that do not exist (`5x run init/state/record/complete`, `5x invoke *`, `5x prompt *`, `5x quality run`, `5x plan phases`, `5x diff`). Users cannot actually run these skills today.

**Requirement:**
- Add an explicit “Requires v1 primitives (not yet implemented)” header to each skill.
- Decide distribution and install story. `102` says skills ship under `.5x/skills/` and can be installed by `5x init`; current `src/commands/init.ts` does not scaffold skills.

**Implementation guidance:**
- Either implement a minimal compatibility layer (e.g., `5x plan phases`, `5x quality run`, `5x diff`) first, or rewrite skills to call existing commands during the transition.

---

## High priority (P1)

### P1.1 — JSON quoting ergonomics for `run record`

`--result '<json>'` will be painful for agents and humans (shell escaping, multi-line). Add a first-class stdin/file option (e.g., `--result @path` or `--result-file`, plus `--result -` to read stdin).

### P1.2 — Locking/concurrency story is inconsistent

`101` says `run init` does not lock; current `5x run` uses plan locks (`.5x/locks/*`). If the toolbelt is meant to be agent-driven and resumable, define: per-plan lock, per-run lock, or explicitly unsupported concurrency + enforcement.

### P1.3 — Phase identifiers are inconsistent across docs

`101` examples use `phase-1` while current implementation uses numeric-ish strings (`phase.number`) derived from plan markdown (e.g., `"1"`, `"1.1"`) and stores them in DB (`phase_progress.phase`). Pick one canonical phase ID format and use it across docs/CLI/DB.

### P1.4 — Commit invariants in skills need product decision

`102` requires commits for plan revisions; current plan-review loop does not enforce commit presence (and it’s plausible to revise docs without committing immediately). Decide whether “every author completion must produce a commit” is a v1 policy, and if so, state it consistently in `protocol`/schemas and across skills.

---

## Medium priority (P2)

- **Command naming compatibility:** `worktree create/remove/list` vs current `run --worktree` + `worktree cleanup/status`; document the intended end state and the migration.
- **`5x diff` semantics:** default `HEAD~1` is unsafe for initial commits and confusing for multi-commit phases; prefer explicit refs (e.g., merge-base) or make it required.
- **Non-interactive behavior needs one unified policy:** current uses `--auto/--ci` semantics; v1 uses prompt defaults. Consolidate into a single matrix: interactive vs CI, default outcomes, exit codes.

---

## Readiness checklist

**P0 blockers**
- [ ] `docs/v1/100-architecture.md` no longer claims to supersede current maintained design until implemented
- [ ] `docs/v1/101-cli-primitives.md` either matches current CLI or includes a phased migration plan + explicit “not implemented yet” contract
- [ ] Data model decision made (`steps` vs current tables) and idempotency semantics specified
- [ ] Provider interface/logging format reconciled with `src/agents/*`
- [ ] `docs/v1/102-agent-skills.md` updated to reflect availability + install story for skills

**P1 recommended**
- [ ] Add ergonomic structured input for `run record` results (stdin/file)
- [ ] Document locking/concurrency enforcement
- [ ] Standardize phase ID format across docs and implementation
- [ ] Decide and document commit policy for plan revisions

---

## Addendum (2026-03-04) — Re-review after doc revisions

**Reviewed:** `docs/v1/100-architecture.md`, `docs/v1/101-cli-primitives.md`, `docs/v1/102-agent-skills.md` (revised)

### What's addressed (✅)

- **Draft vs implemented clarity:** All three v1 docs now clearly marked “Draft — Not Implemented”, and `docs/v1/100-architecture.md` scopes supersedence to “upon implementation”.
- **Compatibility + mapping:** `docs/v1/100-architecture.md` adds a concrete compatibility table; `docs/v1/101-cli-primitives.md` adds an explicit v0→v1 command mapping.
- **Locking/concurrency:** `docs/v1/101-cli-primitives.md` now specifies plan-lock acquisition in `5x run init` and release in `5x run complete`, aligning with current `.5x/locks` behavior.
- **Phase ID consistency:** `docs/v1/101-cli-primitives.md` examples now use numeric-string phase IDs (`"1"`, `"1.1"`), matching `src/parsers/plan.ts` (`PHASE_HEADING_RE`).
- **`run record` ergonomics:** `docs/v1/101-cli-primitives.md` now supports `--result -` (stdin) and `--result @path` (file), addressing shell quoting pain.
- **`diff` safety:** `docs/v1/101-cli-primitives.md` removes the unsafe default-by-design `HEAD~1` behavior; skills must pass explicit refs.
- **Skills availability + install story:** `docs/v1/102-agent-skills.md` now flags skills as requiring v1 primitives, and specifies `5x init` will scaffold `.5x/skills/`.
- **Data model decision + migration plan:** `docs/v1/101-cli-primitives.md` now includes a concrete migration plan to `steps` + explicit idempotency semantics change (v0 upsert → v1 insert-ignore).
- **Provider interface reconciliation:** `docs/v1/100-architecture.md` adds an explicit mapping from current `AgentAdapter` to the proposed provider/session interface and clarifies normalized logging.

### Remaining concerns

- **OpenCode session resume across CLI invocations (P1):** `docs/v1/100-architecture.md` + `docs/v1/101-cli-primitives.md` assume `--session` enables cross-invocation continuation while also stating each `5x invoke` creates a provider instance and closes it on exit. For OpenCode specifically, this implies a persistent underlying runtime (server/thread) independent of the `5x invoke` process. Clarify in `docs/v1/100-architecture.md` whether OpenCode provider connects to a persistent server (resume works), or whether resume is only guaranteed for providers with durable threads/sessions (Codex/Claude Agent) and OpenCode resume is best-effort.
- **Clean-break migration risk (P2/product):** `docs/v1/100-architecture.md` positions a full removal of v0 commands at v1 ship. As a product decision, this is viable but high-friction; consider documenting an escape hatch (e.g., a separate `5x-v0` binary, or a short coexistence window) to reduce upgrade pain.

### Updated readiness

- **Doc set internal consistency:** ✅ — the three v1 docs now read as a coherent, implementation-ready proposal with explicit “not implemented” status and clear deltas vs v0.
- **Consistency with current implementation:** ✅ (as a proposal) — docs no longer imply these commands/DB/providers exist today; they explicitly describe a replacement plan.
- **Ready to implement:** ⚠️ — proceed after resolving the OpenCode session durability assumption (or explicitly scoping `--session` guarantees per provider).
