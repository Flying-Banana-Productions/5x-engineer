# Review: 5x CLI — OpenCode-First Refactor (Plan)

**Review type:** `5x-cli/docs/development/003-impl-5x-cli-opencode.md`  \
**Scope:** Remove Claude Code harness; OpenCode SDK adapter; structured output protocol; orchestrator/DB refactor; reporting/polish  \
**Reviewer:** Staff engineer (correctness, operability, security, incremental delivery)  \
**Local verification:** Not run (static review: docs + repo code)

**Implementation plan:** `5x-cli/docs/development/003-impl-5x-cli-opencode.md`  \
**Technical design:** `5x-cli/docs/development/001-impl-5x-cli.md` (baseline system)

## Summary

This plan is directionally correct: OpenCode structured output is a much stronger contract than “signals embedded in free-text,” and eliminating `PARSE_*` states will simplify the orchestrator substantially.

Main gaps are around (1) incremental delivery safety (Phase 1 deletes the only working adapter), (2) “remote server” semantics vs local filesystem/tooling access, and (3) schema/identity/upgrade story (DB reset + new uniqueness constraints) that currently risks breaking resume/history and worktree associations.

**Readiness:** Not ready — address P0s so the refactor is implementable without breaking the CLI mid-flight or baking in incorrect assumptions about OpenCode runtime/API.

---

## Strengths

- **Correct goal:** remove text parsing fragility; structured output + typed results is the right boundary.
- **State machine simplification:** dropping `PARSE_*` states reduces surface area and failure modes.
- **Server lifecycle thought-through:** managed vs remote is a useful split if semantics are clarified.
- **Keeps quality/human gates agent-agnostic:** good separation of concerns; minimizes churn.

---

## Production readiness blockers

### P0.1 — Re-phase to keep the CLI functional after each phase

**Risk:** Phase 1 deletes `5x-cli/src/agents/claude-code.ts` and related code before `5x-cli/src/agents/opencode.ts` exists. If merged incrementally, this leaves `5x plan|plan-review|run` non-functional (factory throws) and forces “big bang” merge pressure.

**Requirement:** Each phase must leave the repo in a shippable state (tests passing is necessary but not sufficient). At minimum, the CLI must remain runnable for existing flows until OpenCode parity is proven.

**Implementation guidance:**
- Implement `opencode` adapter first behind existing adapter selection (or a feature flag), keep Claude Code as fallback until Phase 4+.
- Only delete Claude Code harness + NDJSON formatter after OpenCode end-to-end parity exists (plan-review + run loops + logs).
- Add an env-gated live OpenCode smoke test early (similar to `FIVE_X_TEST_LIVE_AGENTS=1` pattern) to validate SDK API shapes before broad refactors.

---

### P0.2 — Clarify “remote OpenCode server” semantics vs filesystem/tool execution

**Risk:** The plan claims remote/container servers are supported, but does not define how agent tools (file edits, git operations, test runs) execute relative to the CLI’s local repo/worktree. If the server runs on a different machine/filesystem, the agent cannot safely operate on the same working tree the CLI is gating/locking.

**Requirement:** Define the supported execution topologies explicitly and make them fail-closed:
- **Local/managed:** server runs where the repo/worktree exists; agent tool execution affects the same filesystem the CLI is gating.
- **Containerized:** server runs in a container with the repo mounted; CLI must also run in the same mounted environment *or* paths must be guaranteed equivalent.
- **Truly remote:** either out of scope for v1, or requires a concrete “remote FS/tool execution” design (not implied).

**Implementation guidance:**
- If “remote” is retained, add explicit validation: paths passed to prompts must be meaningful on the server side; warn/fail when `workdir`/`plan_path` are not accessible.
- Consider scoping “remote” to “existing local server” only for v1 (same host), and defer cross-host to a later plan.

---

### P0.3 — DB upgrade/reset story and new `agent_results` identity constraints are underspecified

**Risk:**
- “DB discarded and re-initialized” can silently erase run history + plan/worktree associations (`plans` table) and break `status`/resume expectations.
- New `agent_results` uniqueness (`UNIQUE(run_id, phase, iteration, role)`) is likely insufficient for the current orchestration model which can invoke multiple templates per role/phase across iterations (today uniqueness includes `template_name`). Incorrect uniqueness will cause overwrites or prevent resume-by-replay.

**Requirement:**
- Make DB reset explicit and user-controlled (or at least explicit + fail-closed): detect schema mismatch and provide a clear message/instruction; do not silently delete user data.
- Define (and enforce) the step identity used for idempotency/resume. It must uniquely represent “this invocation site” (template/result type/role/phase/iteration/attempt).

**Implementation guidance:**
- Prefer a deterministic `step_key` column (string) as the uniqueness target (e.g., `run:<id>|phase:<p>|iter:<n>|role:<r>|template:<t>|type:<status|verdict>`), and keep `id` as invocation ULID/UUID for log filenames.
- If you keep composite uniqueness: include at least `template` and `result_type` in the unique key, matching how the orchestrators actually schedule invocations.
- Replace “discard DB” with: bump schema version; on mismatch, error with: “delete `.5x/5x.db` to reset” or implement `5x db reset`.

---

### P0.4 — Structured output schemas need post-validation and routing invariants

**Risk:** The JSON schema shown does not enforce critical conditional requirements (e.g., `reason` required for `needs_human|failed`, `commit` required for phase completion when reviewer-commit needs it). Without explicit invariants, routing can proceed with missing data and create confusing escalations later.

**Requirement:** Add a single canonical validator that enforces routing-critical invariants *after* structured output parsing:
- Author: if `result === "complete"` for phase execution, require `commit` (or define the alternative contract).
- Author: if `result !== "complete"`, require `reason`.
- Reviewer: if `readiness !== "ready"`, require `items.length > 0` and require each item’s `action`.

**Implementation guidance:**
- Implement `assertAuthorStatus(status, context)` / `assertReviewerVerdict(verdict)` and treat invariant failures as escalation (fail-closed).
- Align enums with existing naming (`completed` vs `complete`) or explicitly document the breaking change.

---

### P0.5 — Preserve log/UX parity when switching from NDJSON to OpenCode SSE events

**Risk:** Current implementation has real-time agent logging + `--quiet` semantics + escalation logPath plumbing (`5x-cli/src/utils/agent-event-helpers.ts`, `.5x/logs/<runId>/agent-<id>.ndjson`). Plan 003 deletes `ndjson-formatter` and does not specify console output formatting or how SSE events map to the existing log artifacts/diagnostics.

**Requirement:** OpenCode adapter must maintain the existing observability contract:
- Always write per-invocation logs to `.5x/logs/<runId>/agent-<resultId>.ndjson` (or explicitly version/change it).
- Escalations must always include `logPath`.
- `--quiet` must continue to suppress console streaming without disabling log writing.

**Implementation guidance:**
- Keep the NDJSON log file contract: serialize SSE event payloads as one JSON object per line.
- Either adapt `formatNdjsonEvent()` to the new event shapes or introduce a parallel formatter; avoid deleting console-streaming behavior unless explicitly called out as a v1 regression.

---

## High priority (P1)

### P1.1 — Credentials and auth for remote mode

Storing `server.password` in `5x.config.js` is easy to leak (commits, screenshots, logs). Prefer env (`OPENCODE_SERVER_PASSWORD`) or a prompt-based flow; ensure the CLI never prints secrets.

### P1.2 — Tokens/cost metrics are needed for Phase 6 history/cost tally

The new `agent_results` schema omits tokens/cost fields but Phase 6 wants cost reporting. Either store token/cost when available (nullable columns) or explicitly drop cost reporting from v1.

### P1.3 — Artifact/audit trail: keep structured verdict/status persisted in review artifacts

Even if the orchestrator no longer parses `<!-- 5x:* -->`, it is still valuable to persist the structured verdict/status payload into the review doc (append-only) for auditability and for humans inspecting reviews outside the DB.

Recommendation: keep writing a compact, single-line JSON blob in an HTML comment (or a fenced code block) at the end of the review file. Make parsing optional; DB remains SOT.

---

## Medium priority (P2)

- **Naming consistency:** pick one set of result enums (`completed` vs `complete`) across protocol/types/DB.
- **Factory semantics:** the plan alternates between “adapter created per role” and “single adapter for both roles.” Pick one and describe exactly how model selection is applied per invocation.
- **Explicit Bun/compiled-binary compatibility gate:** add a checklist item to verify `@opencode-ai/sdk` works under Bun and `bun build --compile` (at least a smoke import + one prompt call in an env-gated test).

---

## Readiness checklist

**P0 blockers**
- [ ] Reorder phases to keep CLI runnable until OpenCode parity exists (no “delete only adapter first”).
- [ ] Define and enforce supported “remote server” topologies (fail-closed when filesystem/tooling access is ambiguous).
- [ ] Specify DB reset/upgrade behavior explicitly; fix `agent_results` uniqueness/step identity for resume correctness.
- [ ] Add post-parse invariant validation for structured status/verdict objects.
- [ ] Preserve log file + `--quiet` + escalation `logPath` behavior under OpenCode SSE.

**P1 recommended**
- [ ] Prefer env/prompt for remote server password; never print secrets.
- [ ] Add tokens/cost storage if Phase 6 wants cost reporting.
- [ ] Persist structured verdict/status payloads into review artifacts for auditability (even if not parsed).

---

## Addendum (2026-02-18) — Re-scope for local-only, speed-first refactor

**Reviewed:** `5x-cli/docs/development/003-impl-5x-cli-opencode.md` (v1.0) with additional context: local-only branch, single contributor, DB can be wiped.

### Updates to prior feedback

- **P0.1 (incremental shippability):** If you are intentionally doing a big-bang refactor and accept interim non-functional commits on this local branch, the “keep CLI runnable after each phase” framing is no longer a production blocker. Downgrade to **P1 (workflow risk)**: it’s about avoiding long dead periods / hard-to-debug partial states, not about protecting users.
- **P0.3 (DB reset/upgrade):** If wiping `.5x/5x.db` is acceptable for this effort, the “preserve history/associations” portion is no longer a blocker. However, the **step identity / uniqueness** aspect remains **P0 for correctness**, because it affects behavior *within a single run* even on a fresh DB (overwrites / resume-by-replay / multiple templates per phase/iteration).

### What still needs to be true to go fast without thrash

- **Fastest path recommendation:** scope v1 to **managed/local OpenCode server only** (same host + same filesystem). Treat “remote/cross-host” as out of scope until you have a concrete shared-filesystem/tool-execution story.
- **Keep P0.3 (step identity):** ensure the new `agent_results` schema can represent distinct invocation sites (template + result_type at least) without collisions.
- **Keep P0.4/P0.5:** post-validate structured outputs for routing invariants and preserve the existing log/`--quiet`/`logPath` contract; otherwise you’ll lose debuggability exactly when you need it most.

### Updated readiness

- **If remote mode is deferred and DB wipe is explicitly accepted:** ⚠️ **Ready with corrections** — proceed, but keep “step identity correctness” as a hard gate.
- **If remote mode remains in-scope for this pass:** ❌ **Not ready** — semantics are still underspecified and likely to create a false sense of support.

---

## Addendum (2026-02-18) — Re-review after plan updates (v1.1)

**Reviewed:** `5x-cli/docs/development/003-impl-5x-cli-opencode.md` (v1.1)

### What's addressed (✅)

- **P0.2 remote semantics:** Explicitly deferred; v1 is managed/local only (same host + same filesystem).
- **P0.3 step identity:** `agent_results` uniqueness now includes `template` + `result_type` and documents monotonic per-phase iteration semantics; avoids collisions and supports resume-by-replay.
- **P0.4 routing invariants:** Adds `assertAuthorStatus()` / `assertReviewerVerdict()` and calls them out explicitly at routing points (fail-closed).
- **P0.5 log/quiet parity:** Preserves `.ndjson` log file contract, ensures `logPath` is computed pre-invoke, and carries `quiet` as “console only” (logs always written).
- **Cost/tokens:** Adds nullable `tokens_in/out` + `cost_usd` columns to support `5x history` cost reporting.
- **Audit trail:** Adds explicit, append-only structured audit record writing to review artifacts to survive DB resets.

### Remaining concerns / change requests

- **P1 — Audit record encoding safety:** `<!-- 5x:structured {json} -->` can be broken by `--` / `-->` appearing in string fields (e.g., review item titles/reasons). If you keep HTML comments, encode payload (e.g., base64url JSON) or use a fenced code block instead of a comment.
- **P1 — Plan consistency on formatter deletion:** Phase 1 deletes `src/utils/ndjson-formatter.ts`, but Phase 3/4 still require console streaming parity via an SSE formatter. Update the file plan so there is always a formatter module (rename/repurpose rather than delete, or add an explicit `src/utils/sse-formatter.ts`).
- **P2 — Migration mismatch rule:** The plan says to error when DB is “behind by more than one version.” With an additive migrator, “behind” is normally safe; the only hard mismatch is “DB ahead of CLI.” Tighten wording/logic so the behavior is unambiguous.
- **P2 — Phase 1 description drift:** Phase 1 says “No functional changes yet,” but it deletes the only working harness and will necessarily make `5x` commands non-functional mid-refactor. If that’s intentional (speed-first), call it out explicitly to avoid confusion.

### Updated readiness

- **Plan correctness:** ✅
- **Ready to implement:** ⚠️ **Ready with corrections** — proceed; I’d fix the audit-record encoding + formatter-plan consistency early (cheap, prevents churn).

---

## Addendum (2026-02-18) — Re-review after latest plan updates

**Reviewed:** `5x-cli/docs/development/003-impl-5x-cli-opencode.md` (v1.1, updated)

### What's addressed (✅)

- **Audit record safety:** Audit record payload is now base64url-encoded (`<!-- 5x:structured:v1 <payload> -->`) with decode instructions + explicit test cases.
- **Formatter continuity:** Phase 1 now renames `src/utils/ndjson-formatter.ts` → `src/utils/sse-formatter.ts` (vs deleting), and Phase 3 explicitly reuses it for SSE console formatting.
- **Migration mismatch rule:** Clarified: only “DB ahead of CLI” is a hard error; “behind” applies pending migrations.
- **Phase 1 expectations:** Explicit note that Phase 1 intentionally creates an interim non-functional window until Phase 3.- ￼￼P2 — HTML comment strictness:￼￼ base64url prevents accidental ￼￼-->￼￼ termination, which is the practical risk. If you care about strict HTML comment validity (￼￼--￼￼ disallowed), consider switching to standard base64 (no ￼￼-￼￼) or using a fenced block instead. Not a blocker.

### Remaining concerns

- **P2 — HTML comment strictness:** base64url prevents accidental `-->` termination, which is the practical risk. If you care about strict HTML comment validity (`--` disallowed), consider switching to standard base64 (no `-`) or using a fenced block instead. Not a blocker.

### Updated readiness

- **Plan correctness:** ✅
- **Ready to implement:** ✅ **Ready**
