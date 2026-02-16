# Review: 5x CLI Phase 1 and 1.1

**Review type:** `925f937..ab5ee72`  \
**Scope:** Phase 1 (config/parsers/status) + Phase 1.1 (SQLite DB, locking, status DB integration) in `5x-cli/`  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, performance, operability, test strategy)  \
**Local verification:** `bun test` PASS (104 tests); `bun run typecheck` PASS; `bun run lint` FAIL (Biome)

**Implementation plan:** `docs/development/001-impl-5x-cli.md`  \
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


