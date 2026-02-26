# Review: 5x CLI Phase 1 and 1.1

**Review type:** `925f937..ab5ee72`  \
**Scope:** Phase 1 (config/parsers/status) + Phase 1.1 (SQLite DB, locking, status DB integration) in `5x-cli/`  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, performance, operability, test strategy)  \
**Local verification:** `bun test` PASS (104 tests); `bun run typecheck` PASS; `bun run lint` FAIL (Biome)

**Implementation plan:** `5x-cli/docs/development/001-impl-5x-cli.md`  \
**Technical design:** N/A

## Summary

Phase 1 and 1.1 deliver a solid foundation: deterministic config loading, parsers for plans/reviews/signals, a usable `5x status`, and a DB-backed run model with idempotent upserts plus plan-level locking. Unit test coverage is strong and the plan/test coupling got corrected.

Main gaps are around identity normalization (paths), a few multi-user safety edges in locking, and operability polish (lint gate, "read-only" commands mutating state).

**Readiness:** Ready with corrections - address P0.1 before building Phase 2 orchestration that depends on resume/locking.

---

## What shipped

- **CLI scaffold:** Bun/TS package, citty CLI entrypoint (`5x-cli/src/bin.ts`, `5x-cli/package.json`).
- **Config:** walk-up discovery + dynamic import + zod validation + defaults (`5x-cli/src/config.ts`).
- **Parsers:** plan progress (`5x-cli/src/parsers/plan.ts`), signal blocks (`5x-cli/src/parsers/signals.ts`), review summary (`5x-cli/src/parsers/review.ts`).
- **Status command:** plan progress display + optional DB run state (`5x-cli/src/commands/status.ts`).
- **SQLite foundation:** singleton connection + pragmas (`5x-cli/src/db/connection.ts`), migrations (`5x-cli/src/db/schema.ts`), CRUD + upserts + reporting queries (`5x-cli/src/db/operations.ts`).
- **Plan locking:** file lock w/ PID liveness + stale detection (`5x-cli/src/lock.ts`).

---

## Strengths

- **Deterministic-by-default parsing:** parsers are strict, "last block wins" is clear, malformed signals return null (fail-safe escalation posture later).
- **DB schema fits the orchestration model:** step-identity unique constraint + upsert semantics align with resume-by-replay.
- **Tests are mostly deterministic:** fixture-based parser tests; real-plan/review tests downgraded to loose smoke tests.
- **Status degrades gracefully:** if DB is missing or broken, still shows plan progress.

---

## Production readiness blockers

### P0.1 - Canonicalize plan identity (paths) across DB + locks

**Risk (correctness):** DB keys (`plans.plan_path`, `runs.plan_path`) and lock hashes are based on raw `planPath` strings. Relative vs absolute (or symlink/case differences) becomes different "plans," enabling double-runs, missed resume detection, and `5x status` failing to show the active run.

**Requirement:** define and enforce a canonical plan identifier at CLI boundaries before any DB reads/writes and before lock acquire/release.

**Implementation guidance:** normalize to absolute + `realpath` where possible; store/display both canonical and "as provided" if you want UX friendliness.

---

## High priority (P1)

### P1.1 - Lock liveness check should treat EPERM as "alive"

`process.kill(pid, 0)` can throw `EPERM` for a live process owned by another user; current logic treats all errors as "dead" and can steal a lock (`5x-cli/src/lock.ts`). Treat `EPERM` as locked/alive.

### P1.2 - `status` DB discovery ignores config and can mutate state

`5x-cli/src/commands/status.ts` walks up directories looking for `.5x/5x.db` and runs migrations if found. This misses `db.path` overrides and can surprise by migrating during a read-ish command.

Recommendation: resolve project root deterministically (git root or config root), consult config for DB path, and either avoid migrations in `status` or make schema repair an explicit action with clear messaging.

### P1.3 - Close lint gaps before Phase 2

Biome currently fails (unused import in `5x-cli/src/db/connection.ts`, unused variable in `5x-cli/src/db/operations.ts`, formatting/non-null assertion warnings). If lint is (or becomes) a gate, fix now.

### P1.4 - DB row type contracts: remove or wire `created_at`

`AgentResultRow`/`QualityResultRow` accept `created_at` in the input type but inserts do not set it explicitly (DB default applies). Either remove these fields from "write" types or explicitly support writing timestamps (and decide whether upserts should refresh them).

---

## Medium priority (P2)

- **Prepared statement reuse:** `db.query()` is called per operation; consider caching prepared statements if Phase 4/5 become chatty.
- **Phase numbering as float:** `parsePlan()` uses `parseFloat` for dotted phases; avoid using floats as stable identifiers (e.g., "1.10" vs "1.1").
- **Test log noise:** protocol-version tests emit `console.warn`; spy/suppress to keep CI logs clean.

---

## Readiness checklist

**P0 blockers**
- [ ] Canonicalize plan path identity everywhere (DB + locks + status lookup).

**P1 recommended**
- [ ] Treat EPERM as alive/locked in PID liveness checks.
- [ ] Make `status` respect config DB path and avoid surprising migrations.
- [ ] Fix Biome lint failures; decide if lint is a hard gate.
- [ ] Clarify/clean DB write types around `created_at`.

---

## Addendum (2026-02-16) — Validation of remediation commit

**Reviewed:** `1d4f8f23f196b41dec478a4e7e1af8b698deb64f` (no follow-on commits on this branch)

**Local verification:** `bun test` PASS (109 tests); `bun run typecheck` PASS; `bun run lint` PASS

### What's addressed (✅)

- **P0.1 canonical plan identity:** Added canonical path utility (`5x-cli/src/paths.ts`) and applied it in locking + status DB lookup (`5x-cli/src/lock.ts`, `5x-cli/src/commands/status.ts`). Status now checks canonical path first, with fallback to legacy raw-path rows for backward compatibility.
- **P1.1 EPERM lock safety:** PID liveness now treats `EPERM` as alive, preventing cross-user lock stealing (`5x-cli/src/lock.ts`).
- **P1.2 status DB behavior:** `status` now resolves config (`db.path`), determines root deterministically, opens DB read-only, and no longer runs migrations (`5x-cli/src/commands/status.ts`, `5x-cli/src/db/connection.ts`).
- **P1.3 lint gate:** Biome issues were cleaned up; lint now passes.
- **P1.4 DB write contracts:** Write input types now exclude DB-managed `created_at`; upserts set `created_at = datetime('now')` explicitly on overwrite (`5x-cli/src/db/operations.ts`).
- **P2 parser/test cleanup:** Phase numbers are now preserved as strings (no float coercion) and protocol-version warning tests are quieted via warn stubs (`5x-cli/src/parsers/plan.ts`, `5x-cli/test/parsers/signals.test.ts`).

### Staff assessment (by dimension)

- **Correctness:** Major prior risks are closed. Canonical path usage in status/lock materially reduces duplicate-plan identity drift; lock behavior for live cross-user PIDs is now correct.
- **Architecture:** Direction remains sound (thin CLI orchestration primitives, explicit read-only DB access for inspection paths). Export surface updates are coherent (`5x-cli/src/index.ts`).
- **Tenancy/security:** Multi-user lock stealing via `EPERM` is fixed. Remaining model is still local-file cooperative locking (acceptable for local CLI scope).
- **Performance:** No regressions for current scale. Minor inefficiency remains: status loads full run event history to get the last event (`getRunEvents` then tail) rather than a targeted query.
- **Operability:** Better UX and safer runtime behavior: explicit stderr notes on config/DB read failures, and status no longer mutates DB state.
- **Test strategy:** Coverage improved where it mattered (config DB path behavior, read-only status behavior, EPERM liveness, path canonicalization). Test suite/lint/typecheck all green.

### Remaining concerns / follow-ups

- **P1 — Enforce canonical path on all future DB write boundaries:** `createRun`/`upsertPlan` still accept arbitrary path strings by API contract. Before Phase 4/5 orchestration writes are introduced, enforce canonicalization at command boundaries and add regression tests proving no duplicate rows for relative/absolute/symlink variants.
- **P2 — Optimize status last-event lookup:** Replace full event fetch with a `LIMIT 1` query for active run tail event once run/event volume grows.

### Updated readiness

- **Phase 1 + 1.1 completion:** ✅ — previously raised P0/P1 remediation items are addressed in code and tests.
- **Ready for next phase (Phase 2: Agent Adapters):** ✅ — proceed. Carry the canonical-write-boundary guardrail into later orchestration phases (Phase 4/5) where DB writes expand.

---

## Addendum (2026-02-16) — Review of follow-up remediation (canonical-write + status tail)

**Reviewed:** `fc8232dfafdf67ad97e1d1da894ac511c36268bc` (no follow-on commits)

**Local verification:** `bun test --concurrent --dots` PASS (117 tests); `bun run typecheck` PASS; `bun run lint` PASS

### What's addressed (✅)

- **P1 canonical DB write boundaries:** `createRun()` and `upsertPlan()` now canonicalize `planPath` internally (`5x-cli/src/db/operations.ts`) so callers cannot accidentally create split identities (relative/absolute/symlink). Added regression tests covering relative/absolute/symlink variants (`5x-cli/test/db/operations.test.ts`).
- **P2 status last-event lookup:** `status` now uses a targeted `LIMIT 1` query (`getLastRunEvent`) rather than fetching full history (`5x-cli/src/db/operations.ts`, `5x-cli/src/commands/status.ts`).

### Staff assessment (by dimension)

- **Correctness:** Path normalization at the DB write boundary materially reduces identity drift risk, but note it is not a full migration strategy: legacy DB rows keyed by non-canonical paths remain and future commands that read from DB (beyond `status`, which already has fallback logic) should either migrate or dual-lookup to avoid “lost association” behavior.
- **Architecture:** Slight layering leak (DB ops now depend on filesystem `realpath`), but it functions as an enforcement guardrail and is acceptable at this stage. Keep command-boundary canonicalization as the primary contract; treat DB-side canonicalization as defense-in-depth.
- **Tenancy/security:** No new trust boundaries introduced. Canonicalization via `realpath` reduces symlink ambiguity for local cooperative locking/state. No cross-user escalation risk observed.
- **Performance:** `getLastRunEvent()` is the right micro-optimization for `status` once run event volume grows. Canonicalization cost (`realpathSync`) is negligible for current write frequency.
- **Operability:** `status` becomes more predictable under large DBs; fewer reads and less memory pressure.
- **Test strategy:** Added focused regression tests for the exact failure mode cited in the prior addendum. Symlink tests can be environment-sensitive (CI/user privileges); if this ever flakes, gate the symlink cases on platform capability rather than removing coverage.

### Remaining concerns / follow-ups

- **Back-compat for existing DB rows:** Consider a one-time migration or a “canonical + legacy fallback” read helper for `plans`/`runs` once additional commands start reading these tables (Phase 4/5+). Without this, upgrading could strand earlier `plans.plan_path` associations.
- **Relative path semantics:** `canonicalizePlanPath()` resolves relative paths against process CWD. Ensure all command boundaries pass absolute paths (project-root-relative resolution) so DB canonicalization can’t accidentally anchor to an unexpected working directory.

### Updated readiness

- **Phase 1 + 1.1 completion:** ✅ — remaining concerns from the prior addendum are addressed with code + tests.
- **Ready for next phase (Phase 2: Agent Adapters):** ✅ — proceed.
