# Review: 5x Dashboard (Web Command Center)

**Review type:** `5x-cli/docs/10-dashboard.md` (design doc)
**Scope:** `5x dashboard` command, web UI + WS protocol, DB/log ingestion, interactive gate control
**Reviewer:** Principal PM + Staff engineer (product usability, security, reliability, operability)
**Local verification:** Not run (static review vs existing docs + code)

**Implementation plan:** `5x-cli/docs/development/001-impl-5x-cli.md`
**Technical design:** `5x-cli/docs/development/006-technical-design-5x-cli.md`

## Summary

The dashboard direction is compelling for multi-run observability (plan/run overview, events, costs, streaming NDJSON logs) and matches the repo's existing artifacts (`.5x/5x.db`, `.5x/logs/<runId>/agent-<id>.ndjson`, `.5x/debug/*.ndjson`). The current doc is not yet consistent with the rest of the system design/implementation: it introduces a new cross-process "gate bridge" and runtime model without reconciling current CLI-driven gates, lock semantics, and the actual DB/event vocabulary.

**Readiness:** Not ready - scope alignment + gate/control architecture + data model mappings need correction before implementation.

---

## Strengths

- **Clear user value:** single place to monitor multiple plans/runs + drill into logs/events (gap vs `5x status` being single-plan).
- **Uses existing substrates:** DB is already SOT; logs are already NDJSON (`src/orchestrator/phase-execution-loop.ts`, `src/orchestrator/plan-review-loop.ts`); debug traces exist (`src/debug/trace.ts`).
- **Standalone + zero-bundler approach:** vanilla static assets and Bun server are consistent with existing "import text into binary" pattern (`src/templates/loader.ts`).
- **Control surface is explicit:** gate modals and first-responder-wins semantics are the right mental model if cross-process control is truly required.

---

## Production readiness blockers

### P0.1 - Scope conflicts with existing technical design

**Risk:** `001-impl-5x-cli.md` explicitly lists "custom UI/dashboard" as out of scope, so implementing this as-is creates roadmap ambiguity and conflicting expectations (what is supported, tested, maintained).

**Requirement:**
- Update `5x-cli/docs/development/001-impl-5x-cli.md` to make dashboard either (a) in-scope with an explicit phase/acceptance criteria, or (b) explicitly "separate initiative" with dependency/versioning expectations.

**Implementation guidance:**
- If it's in-scope: place it after log streaming + TUI work (it depends on their artifacts) and call out the support matrix (headless vs TUI vs dashboard).

---

### P0.2 - Gate/control architecture is inconsistent with current implementation (and incomplete)

**Risk:** The doc's "gate bridge via `.5x/gates/` files" doesn't integrate with current gate/input reality:
- Existing headless terminal gates (`src/gates/human.ts`)
- Plan-review loop's distinct "humanGate" (not `escalationGate`) (`src/orchestrator/plan-review-loop.ts`)
- Current TUI mode is external attach listen only (`--tui-listen`); it is observability-only and does not accept gate input (`src/tui/detect.ts`, `src/tui/controller.ts`, `src/commands/run.ts` comment: "gates remain CLI-driven")
- `src/tui/gates.ts` exists but is not wired from commands today (legacy/untrusted as an integration point)
- Current lock behavior: stale locks are auto-stolen; there is no stale-lock gate today (`src/lock.ts`, `src/commands/run.ts`)

Without a unified gate subsystem, "first responder wins" will be flaky (CLI blocks on stdin; dashboard is a separate process).

**Requirement:**
- Define one canonical "human decision" mechanism that works across: `run` + `plan-review`, CLI prompts, and (future) dashboard mode.
- Explicitly decide whether dashboard control is supported when TUI is active (`tui.active === true`).
- Align supported gate types with reality (remove stale-lock gate unless reintroduced intentionally).

**Implementation guidance:**
- Introduce a small gate layer (e.g. `src/gates/bridge.ts`) that: emits a gate request (file + optional in-process hook), races local prompt (stdin) with external resolution, and records the resolution as a run_event (`human_decision`) for audit.
- Keep plan-review and phase-execution using the same gate primitives (no separate bespoke `defaultHumanGate`).

---

### P0.3 - Dashboard data/event model doesn't match the DB and artifacts

**Risk:** UI and WS protocol are specified using event/status names and file naming that don't exist, causing rework or misleading UI:
- Run statuses in DB: `active|completed|aborted|failed` (`src/db/schema.ts`, `src/db/operations.ts`), doc examples use "COMPLETE"/"ABORTED" (fine as display) but must map.
- Run events in DB are `run_events.event_type` like `run_start`, `phase_start`, `agent_invoke`, `quality_gate`, `verdict`, `escalation`, `human_decision` (see `src/orchestrator/phase-execution-loop.ts`), but the doc uses example types like `quality_start`, `author_complete`.
- Agent log filenames are `agent-<resultId>.ndjson`, not role/phase encoded names (`src/orchestrator/phase-execution-loop.ts`).

**Requirement:**
- Update `5x-cli/docs/10-dashboard.md` to reference the actual DB schema + event vocabulary as the source of truth.
- Specify the minimal derived views the dashboard computes (e.g. "active phase" from `runs.current_phase`, "latest event" from `run_events.id`, "tokens/cost" from `agent_results`).

**Implementation guidance:**
- Prefer incremental polling keyed by monotonically increasing `run_events.id` over adding `runs.updated_at` (migration optional, but not required).

---

### P0.4 - Security model for network binding + interactive control is underspecified

**Risk:** With `--host 0.0.0.0` and no auth, any machine on the network could view logs and (worse) answer gates. Origin checks help, but WebSockets are not protected by CORS; you must enforce Origin and/or require a per-process token.

**Requirement:**
- If interactive control exists, require an explicit opt-in for non-localhost binding, and gate control behind an unguessable token (at least) even on localhost.
- Document which data is exposed (NDJSON logs can contain secrets) and how binding interacts with threat model.

**Implementation guidance:**
- Generate a random token at dashboard startup; require it in WS query/header; print it only to the local terminal.
- Keep default host `127.0.0.1` and show a loud warning when binding non-local.

---

## High priority (P1)

### P1.1 - File watching approach needs hardening (cross-platform correctness)

`fs.watch()` semantics vary and recursive watching is unreliable; missing events will break "liveness" and gate discovery.

Recommendation: combine `fs.watch()` with periodic directory rescan (cheap, bounded) and treat watch as an optimization.

### P1.2 - Define "plans shown" explicitly

The `plans` DB table only contains plans that have been upserted by CLI runs. If the dashboard is meant to show "all plans in repo", it must scan `config.paths.plans` (and reconcile with canonical paths).

Recommendation: start with "known plans = rows in `plans` table" and optionally add repo scan later.

### P1.3 - Config + CLI flag integration needs to match current config schema

Doc proposes a `dashboard` config section; current schema (`src/config.ts`) will warn/ignore unknown keys.

Recommendation: either (a) add `dashboard` to config schema (and unknown-key allowlist), or (b) keep dashboard config flags only and explicitly state it.

---

## Medium priority (P2)

- **Protocol versioning:** add `protocolVersion` to WS messages (mirrors structured-signal versioning) so UI/server can evolve safely.
- **Large logs UX:** specify browser-side virtualization + server-side "tail N lines" vs "stream all" default; avoid unbounded memory.
- **TUI coexistence:** document expected user workflows (TUI-only vs dashboard-only vs both) and which interface owns gates.

---

## Readiness checklist

**P0 blockers**
- [ ] Align scope with `5x-cli/docs/development/001-impl-5x-cli.md` (P0.1)
- [ ] Define a unified gate mechanism across headless/TUI/dashboard + both loops; remove/justify stale-lock gate (P0.2)
- [ ] Update dashboard doc to match actual DB schema, run_event types, statuses, and log naming (P0.3)
- [ ] Specify and enforce security controls for interactive gates, especially when binding non-localhost (P0.4)

**P1 recommended**
- [ ] Harden watchers with periodic rescan and bounded recovery (P1.1)
- [ ] Define "plans shown" source (DB vs filesystem) and path canonicalization rules (P1.2)
- [ ] Reconcile config schema/flags for dashboard settings (P1.3)

---

## Addendum (2026-02-26) - Re-review after `docs/10-dashboard.md` v1.1 updates

The doc is substantially improved and addresses most of the original review items:

- **Scope clarity (P0.1):** `docs/development/001-impl-5x-cli.md` now explicitly calls dashboard a separate initiative and links to `docs/10-dashboard.md`.
- **Gate model alignment (P0.2):** Updated to a unified gate bridge (`src/gates/bridge.ts`) consistent with current CLI-driven gates and current TUI reality (`--tui-listen` is observability-only; no TUI gate input). Stale-lock gate removed; locks are telemetry.
- **Data model alignment (P0.3):** Added a solid Data Model Reference mapping to `src/db/schema.ts`, `src/db/operations.ts`, `runs.status`, `agent-<resultId>.ndjson` naming, and `run_events.id` high-water polling.
- **Security (P0.4):** Token auth is now specified for *all* HTTP + WS access; host binding warnings and localhost Origin checks included; token file persistence is bounded with 0600 permissions.
- **Watcher hardening (P1.1):** `fs.watch()` + periodic rescan is called out for logs and gates.
- **Plans shown (P1.2):** Explicitly DB-backed (`plans` table) - no filesystem scanning.
- **Config mismatch (P1.3):** Resolved by making dashboard settings CLI flags only.

Updated assessment: **Near-ready**, with one remaining correctness risk that should be fixed before implementation.

### Remaining issues

**P0 - Event vocabulary drift in the doc**

- `docs/10-dashboard.md` lists `run_complete` / `run_abort` (phase execution) and `plan_review_complete` / `plan_review_abort` (plan review) as `run_events.event_type` values.
- These event types are not emitted by current code (see `src/orchestrator/phase-execution-loop.ts`, `src/orchestrator/plan-review-loop.ts`). Completion/abort is currently represented by `runs.status` + `completed_at`, not explicit events.

Fix options (pick one and make doc+code consistent):

1) **Doc-only:** remove those event types from the reference tables and derive completion/abort from `runs`.
2) **Code+doc:** add explicit terminal events to both loops (and tests), then the dashboard can rely on them for timeline rendering.

**P1 - Minor doc consistency:** `docs/development/001-impl-5x-cli.md` now mentions dashboard as a separate initiative in Scope, but still lists it in "Not In Scope" later. Not wrong, but worth de-duplicating to avoid mixed messaging.

---

## Addendum (2026-02-26) - Corrections verified

- **Correction to prior addendum:** The event vocabulary items flagged as drift are present in code.
  - `run_complete` / `run_abort`: `src/orchestrator/phase-execution-loop.ts` writes these in finalization (`appendRunEvent` at ~L2373).
  - `plan_review_complete` / `plan_review_abort`: `src/orchestrator/plan-review-loop.ts` writes these in finalization (`appendRunEvent` at ~L1069).
  - Net: dashboard doc event tables are consistent with current implementation.

- **Doc consistency (P1) now resolved:** `docs/development/001-impl-5x-cli.md` "Not In Scope" section now matches the top-of-file scope wording by cross-referencing `docs/10-dashboard.md`.

Updated assessment: **Ready for implementation** (as a separate initiative), with no remaining review blockers.
