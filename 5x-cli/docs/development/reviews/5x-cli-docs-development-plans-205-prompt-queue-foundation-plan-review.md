# Review: Prompt-Queue Foundation implementation plan

**Review type:** `docs/development/plans/205-prompt-queue-foundation-plan.md`  
**Scope:** Durable prompt repository, CLI prompt races, abandonment lifecycle, and doctor repair  
**Reviewer:** Staff engineer (reliability, concurrency, persistence, operability)  
**Local verification:** Not run (static review of plan, referenced v2/v1 designs, and current implementation)

**Implementation plan:** `docs/development/plans/205-prompt-queue-foundation-plan.md`  
**Technical design:** `docs/v2/200-overview.md`, `docs/v2/202-control-plane.md`, `docs/v2/203-recovery-and-doctor.md`

## Summary

The plan is strong on repository boundaries, UUID/CAS semantics, migration coverage, doctor hygiene, and preservation of the existing success envelopes. Its phase ordering correctly establishes persistence and cleanup before changing the prompt commands. It is not ready because the required interruption-abandonment behavior is impossible with the current DB connection SIGINT handler: opening the DB installs a listener that exits the process before the prompt handler can abandon its row.

**Readiness:** Not ready — signal ownership must be resolved before the command-race phase can meet its durable-abandonment contract.

---

## Strengths

- The `PromptStore` boundary and UUID/CAS contract directly honor the v2 forward-compatibility constraints without leaking `bun:sqlite` into command logic.
- Separating schema/store contract tests from command integration gives the race semantics a focused, implementation-independent test surface.
- Persisting and abandoning non-interactive failures preserves fail-fast CI behavior while leaving an audit record.
- The doctor check has a safe, deterministic repair target and follows the existing detect/fix/re-detect identity conventions.
- Completion gates are concrete and the plan explicitly calls out the cancellable-stdin spike as a dependency rather than assuming it works.

---

## Production readiness blockers

### P0.1 — Establish SIGINT ownership before durable prompt abandonment

**Action:** `human_required`

**Risk:** Phase 5 requires a SIGINT to CAS-abandon the prompt and emit `INTERRUPTED`. However, `resolveDbContext()` opens the DB through `getDb()`, and `src/db/connection.ts:47-50` registers a SIGINT listener that closes the DB and immediately calls `process.exit(130)`. EventEmitter listeners run synchronously in registration order, so the later `readLine()` listener in `src/utils/stdin.ts:154` cannot run and the newly persisted prompt is left open. This also invalidates the proposed SIGINT integration test.

**Requirement:** Decide and document a single signal-ownership/lifecycle approach that permits an active prompt to atomically abandon its row before the process exits, while retaining safe DB and lock cleanup for every other command. Update the plan with the affected connection/CLI/lock lifecycle files, ordering rules, and a real-process test that opens the DB, interrupts an active prompt, verifies exit 130, and verifies `abandon_reason = 'interrupted'`.

**Implementation guidance:** This cannot be solved solely by adding `AbortSignal` to stdin: the connection-level exit listener is installed before prompt reads begin. The design must move or coordinate process-exit behavior at the lifecycle boundary rather than relying on listener ordering.

---

## High priority (P1)

### P1.1 — Fully specify cancellation of both race branches and multiline interrupt semantics

**Action:** `auto_fix`

The plan says to race `waitForPromptAnswer` with abortable stdin, but only specifies aborting stdin after a store win. It must also abort the poll branch after a terminal/default/EOF result and abort the pending stdin branch on timeout; otherwise the losing promise can continue polling/listening and keep the process alive. In addition, current `readAll()` resolves partial text on SIGINT (`src/utils/stdin.ts:182-188`), whereas the proposed plan only gives a sentinel signature for `readLine`. Define compatible sentinel/result behavior for `readAll`, map it to `interrupted`, and add tests for timeout cleanup, terminal-win poll cleanup, store-win read cleanup, and multiline SIGINT.

### P1.2 — Enforce abandonment-pair integrity in the schema

**Action:** `auto_fix`

Migration 6 prevents simultaneous answer and abandonment timestamps, but it permits `abandoned_at` without `abandon_reason`, an abandonment reason without an abandonment timestamp, and an answered row carrying an abandonment reason. Add a CHECK that makes the abandonment timestamp and reason an all-or-nothing pair (and keeps those fields null for answered/open rows), then test the invalid combinations. This makes the plan's stated first-class abandonment state enforceable at the authoritative store rather than only by repository discipline.

---

## Medium priority (P2)

- **P2.1 — Validate timeout inputs:** **Action:** `auto_fix`. Specify rejection of non-finite, negative, and ambiguous `--timeout` / `FIVEX_PROMPT_TIMEOUT_MS` values before inserting a prompt. Commander `parseInt` can yield `NaN` or silently accept trailing characters; without a defined validation path these values can accidentally disable the intended bounded-wait behavior.

---

## Readiness checklist

**P0 blockers**
- [ ] Select and document SIGINT ownership that allows a DB-backed prompt to abandon before process exit, with an end-to-end interrupt test.

**P1 recommended**
- [ ] Specify cancellation and cleanup for both sides of every input/poll/timeout race, including multiline SIGINT.
- [ ] Add database constraints and migration tests for complete, mutually exclusive abandonment state.
- [ ] Define strict CLI/environment timeout validation.
