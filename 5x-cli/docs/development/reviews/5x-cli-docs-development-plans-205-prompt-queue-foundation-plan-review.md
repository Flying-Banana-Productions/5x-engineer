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

---

## Addendum (2026-08-24) — Revision 1.1 re-review

**Reviewed:** `docs/development/plans/205-prompt-queue-foundation-plan.md` version 1.1

### What's addressed (✅)
- **P0.1 — CLI signal ownership:** Resolved. Phase 4 makes `src/bin.ts` the sole SIGINT/SIGTERM lifecycle owner, removes early exits from DB and lock utilities, retains exit-time cleanup, and requires an end-to-end SIGINT test that proves the persisted row is abandoned before exit 130.
- **P1.1 — Race cleanup and multiline interruption:** Resolved. The plan now uses distinct stdin and polling controllers, aborts both in `finally`, gives `readAll` a SIGINT sentinel, and tests timeout/store/TTY cleanup paths.
- **P1.2 — Abandonment integrity:** Resolved. Migration 6 now pairs `abandoned_at` with `abandon_reason` and tests both incomplete-pair and answered-plus-abandonment-invalid cases.
- **P2.1 — Timeout parsing:** Resolved. The plan specifies the existing strict integer parser for flags and environment values, validates before persistence, and covers invalid input with no-row tests.

### Remaining concerns

#### P1.3 — Wire the lifecycle abort signal into every active prompt race

**Action:** `auto_fix`

Phase 4 aborts `getCliAbortSignal()` for both SIGINT and SIGTERM, but Phase 6 races only stdin and polling signals. SIGINT happens to reach the stdin listener, while SIGTERM does not; therefore a waiting prompt will not observe the lifecycle abort, CAS-abandon, or unwind before the two-second force exit. Add the lifecycle signal as an explicit race participant (or propagate it to both prompt controllers), define SIGTERM’s durable abandonment mapping, and test first-SIGTERM against a real DB-backed waiting prompt. This is required by the selected centralized-lifecycle contract and is mechanically derivable from it.

#### P1.4 — Make `--timeout` and control-plane answers work for non-TTY piped input

**Action:** `auto_fix`

The Phase 6 `no-TTY input + pipe` branch unconditionally awaits `readStdinPipe()`. It bypasses the positive-timeout race, cannot be interrupted when a store writer wins, and contradicts the stated rule that `--timeout` applies to no-TTY prompts without defaults. Specify an abortable/raced pipe-reader path for opt-in waiting (or explicitly constrain and document the flag semantics), then add timeout and store-wins-pipe tests. The stated all-writers CAS contract and existing stdin utilities make the needed behavior derivable without a policy decision.

#### P1.5 — Provide the run-validation dependency required by the handler flow

**Action:** `auto_fix`

The proposed handler dependencies expose only `PromptStore`/`resolveStore`, but the shared flow requires `getRunV1` before `createPrompt`. A `PromptStore` does not expose a run lookup and the handler no longer has the `Database` returned by `resolveDbContext`; as written, `--run` validation cannot be implemented without adding an unplanned direct-DB path. Add a small injected `runExists`/prompt-context resolver backed by the already-resolved DB (and matching unit tests), keeping prompt handlers independent of `bun:sqlite` as the plan requires.

### Updated readiness
- **Prompt-queue foundation plan:** ⚠️ — Revision 1.1 resolves all prior findings and the centralized lifecycle is sound, but the three mechanical wiring gaps above must be specified before implementation.
- **Ready for next phase:** ⚠️ — **Ready with corrections** once P1.3–P1.5 are incorporated; no further human decision is required.
