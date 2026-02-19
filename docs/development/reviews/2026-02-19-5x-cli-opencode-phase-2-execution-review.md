# Review: 5x CLI OpenCode Refactor — Phase 2 Execution

**Review type:** `9bdd7c2523`  \
**Scope:** Phase 2 of `docs/development/003-impl-5x-cli-opencode.md` (structured protocol types + invariant validators; DB schema v2 for structured results; legacy signal parser relocation)  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, operability, test strategy)  \
**Local verification:** `bun test` (293 pass, 1 skip)

**Implementation plan:** `docs/development/003-impl-5x-cli-opencode.md` (Phase 2)  \
**Technical design:** `docs/development/001-impl-5x-cli.md` (baseline)

## Summary

This phase lands the core “structured protocol” surface area (`AuthorStatus` / `ReviewerVerdict` + JSON schemas + invariant validators) and reworks persistence to a v2 `agent_results` table that stores typed results as JSON. DB migration behavior is now fail-closed when DB is ahead of the CLI, and the updated unique key matches the plan’s step identity intent (includes `template` and `result_type`). Tests are comprehensive and green.

Primary staff concern is Phase 3 integration sequencing: command code currently calls `createAndVerifyAdapter()` (new `AgentAdapter`) but then casts to `LegacyAgentAdapter` and invokes legacy methods. Once the OpenCode adapter is implemented (Phase 3), this will likely become a runtime failure unless the adapter (temporarily) supports the legacy interface or Phase 4/5 are pulled forward in lockstep.

**Readiness:** Ready with corrections — Phase 2 is complete, but address P0.1 before enabling a real adapter in Phase 3.

---

## What shipped

- **Structured protocol module:** `5x-cli/src/protocol.ts` defines canonical types + JSON schemas and adds routing-critical invariant validators (`assertAuthorStatus`, `assertReviewerVerdict`).
- **Legacy signal parsing relocation:** `5x-cli/src/utils/legacy-signals.ts` replaces `src/parsers/signals.ts` and normalizes legacy `result: completed` -> `complete`.
- **DB schema v2:** `5x-cli/src/db/schema.ts` adds migration 002 and a clear “DB ahead of CLI” abort.
- **DB ops update:** `5x-cli/src/db/operations.ts` stores/retrieves `status`/`verdict` via `result_type` + `result_json` and updates upsert semantics.
- **Orchestrator plumbing:** loops now persist structured-ish `status`/`verdict` payloads and apply invariant checks on parsed results.
- **Tests:** updated/added coverage for schema migrations, DB ops, protocol validators, and orchestrator behavior.

---

## Strengths

- **Fail-closed routing invariants:** validators prevent “looks successful but missing critical fields” from silently advancing.
- **Schema/version safety:** explicit “DB ahead of CLI” abort avoids undefined behavior on unknown schemas.
- **Step identity alignment:** uniqueness now includes `template` + `result_type`, matching the plan’s resume/idempotency model.
- **Good regression coverage:** orchestrator and DB tests cover many edge cases (resume, log paths, parser-dropped items → escalation).
- **Security posture remains local-first:** no new remote surface; review path reuse remains constrained to the configured reviews directory (prevents DB-poisoned path escapes).

---

## Production readiness blockers

### P0.1 — Phase 3 will break at runtime without an adapter/interface bridge

**Risk:** `createAndVerifyAdapter()` returns the new `AgentAdapter` contract, but current command/orchestrator code uses legacy `.invoke()` via `as unknown as LegacyAgentAdapter` casts (`5x-cli/src/commands/plan.ts`, `5x-cli/src/commands/plan-review.ts`, `5x-cli/src/commands/run.ts`). Once Phase 3 makes `createAndVerifyAdapter()` succeed, these casts become “type lies” and will crash at runtime unless the returned adapter also implements the legacy interface.

**Requirement:** Before Phase 3 lands “real adapter creation,” choose and implement a compatibility strategy:
- Adapter temporarily implements **both** `AgentAdapter` and `LegacyAgentAdapter`, or
- Phase 4 (orchestrator refactor) and the minimal command wiring are pulled earlier so no legacy casts remain when the adapter is enabled, or
- Keep `createAndVerifyAdapter()` throwing until Phase 5 and introduce a separate (explicit) Phase 3 adapter test harness entrypoint.

**Implementation guidance:** Treat this as a gating decision for Phase 3. If you pick the dual-interface bridge, keep it narrowly-scoped and delete it as soon as Phase 4/5 are complete.

---

## High priority (P1)

### P1.1 — Resume correctness: `hasCompletedStep()` should include `result_type`

`agent_results` uniqueness includes `result_type`, but `hasCompletedStep()` currently does not. Today this is “probably fine” only because role/template usage implies a single result type per step; the DB schema explicitly allows both. Including `result_type` makes resume/idempotency semantics explicit and future-proof.

### P1.2 — Escalation iteration off-by-one in PARSE_* states

On success paths, `iteration++` happens before entering `PARSE_AUTHOR_STATUS` / `PARSE_VERDICT` / `PARSE_FIX_STATUS`. Escalations raised in these parse states report the post-increment iteration, which can break correlation with the agent result row/log created immediately before. Add a dedicated “current invocation iteration” variable (or decrement when attributing) and cover with tests.

### P1.3 — QUALITY_RETRY ignores author status semantics

In `QUALITY_RETRY`, status is parsed and persisted but not used for routing (e.g., `needs_human`/`failed` are not escalated). Either treat quality retries as “quality-gate is source of truth” and remove status parsing entirely, or enforce/route on status consistently.

---

## Medium priority (P2)

- **Data model clarity:** consider a CHECK constraint for `agent_results.result_type IN ('status','verdict')` to catch DB corruption early.
- **DB migration messaging:** migration 002 drops/recreates `agent_results` (data loss). If this is intentionally acceptable for the refactor branch, prefer making the user-facing messaging explicit when/if this goes beyond a local-only workflow.
- **Reporting ordering:** `getAgentResults()` orders by `phase` (TEXT) then `iteration`; lexicographic phase sorting will surprise once phases reach `10` or include `1.1`-style numbers.
- **Parser hardening (legacy path):** YAML parsing is on untrusted agent output; ensure inputs are bounded (size/time) if legacy parsing remains reachable in production.

---

## Readiness checklist

**P0 blockers**
- [x] Decide and implement the Phase 3 adapter/interface compatibility strategy (remove legacy casts or provide a deliberate bridge). -- **Resolved:** factory continues to throw during Phase 3; adapter tested via direct instantiation. Legacy casts removed atomically in Phases 4-5. See updated `003-impl-5x-cli-opencode.md` Phases 3-5.

**P1 recommended**
- [x] Include `result_type` in `hasCompletedStep()` (or document why it cannot vary). -- **Fixed:** `hasCompletedStep()` now takes `resultType` parameter; all call sites updated.
- [x] Fix PARSE_* escalation iteration attribution; add targeted tests. -- **Fixed:** `lastInvokeIteration` variable tracks pre-increment iteration; all PARSE_* escalation events use it.
- [x] Make QUALITY_RETRY status semantics consistent (route or drop). -- **Fixed:** QUALITY_RETRY now escalates on `needs_human`/`failed` author status.

---

## Phase alignment / next-phase readiness

**Implementation plan phase(s):** `docs/development/003-impl-5x-cli-opencode.md` Phase 2

### Updated readiness

- **Phase 2 completion:** ✅ — protocol/types, v2 schema, ops, and tests are landed. All review items addressed.
- **Ready for Phase 3:** ✅ — P0.1 resolved; adapter isolation strategy documented in implementation plan. P1/P2 code fixes landed.

---

## Addendum (2026-02-19) — Review Feedback Closure (f691fb6)

**Reviewed:** `f691fb69ed`

### What's addressed (✅)

- **P0.1 adapter/interface bridge:** Plan updated to keep factory throwing in Phase 3; wire adapter atomically in Phases 4–5 after legacy casts are removed.
- **P1.1 hasCompletedStep result_type:** `hasCompletedStep()` now takes `resultType` and queries include `result_type`.
- **P1.2 PARSE_* iteration attribution:** `lastInvokeIteration` tracks pre-increment iteration; PARSE_* escalations/events use it.
- **P1.3 QUALITY_RETRY status routing:** quality retry now escalates on `needs_human`/`failed` author status.
- **P2 hardening/polish:** `CHECK(result_type IN ('status','verdict'))`, numeric-ish ordering in `getAgentResults()`, 64KB YAML parse guard, migration 002 data-loss explicitly documented in plan.

### Remaining concerns / further required changes

- [x] **Resume + PARSE_* still off-by-one:** on resume into a PARSE_* state, `iteration` is restored as "next iteration" (max+1 / results.length), so `lastInvokeIteration` initializes incorrectly. Fix by setting `lastInvokeIteration = iteration - 1` (or deriving from DB) when resuming into `PARSE_AUTHOR_STATUS`/`PARSE_VERDICT`/`PARSE_FIX_STATUS`/`PARSE_STATUS`, and add tests for resuming in those states. — **Fixed:** both orchestrator loops now detect resume into PARSE_* states and set `lastInvokeIteration = Math.max(0, iteration - 1)`. Tests added for resume into `PARSE_AUTHOR_STATUS`, `PARSE_VERDICT` (phase-execution), and `PARSE_VERDICT` (plan-review).
- [x] **Phase ordering for non-integers:** `CAST(phase AS INTEGER)` truncates values like `"1.1"` → `1` (ties/misorder). If Phase 1.1-style numbering is expected in reporting, switch to `CAST(phase AS REAL)` or a split/normalize ordering function. — **Fixed:** `getAgentResults()` now uses `CAST(phase AS REAL)`. Test added covering integer, decimal, and sentinel phase ordering.
- [x] **QUALITY_RETRY missing-status semantics:** still proceeds when status block is missing/null; decide whether that's acceptable (then stop parsing/status-routing there) or treat missing status as escalation for consistency. — **Fixed:** QUALITY_RETRY now escalates on missing/null status (fail-closed, consistent with PARSE_AUTHOR_STATUS / PARSE_FIX_STATUS). Test added.

### Updated assessment

- **Phase 2 completion:** ✅
- **Ready for Phase 3:** ✅ — all addendum items resolved; adapter isolation strategy is explicit; legacy PARSE_* paths are correct and tested.
