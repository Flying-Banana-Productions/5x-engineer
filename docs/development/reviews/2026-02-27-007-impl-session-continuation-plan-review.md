# Review: Session Continuation at Escalation Gate

**Review type:** `5x-cli/docs/development/007-impl-session-continuation.md`  \
**Scope:** Add a `c = continue session` escalation-gate option that reuses an existing OpenCode session instead of starting fresh; plumb session IDs from adapter -> orchestrators -> gates; update headless + TUI parsers; add tests.  \
**Reviewer:** Staff engineer (reliability, operability, UX semantics)  \
**Local verification:** Not run (static review)

**Implementation plan:** `5x-cli/docs/development/007-impl-session-continuation.md`  \
**Technical design:** N/A

## Summary

The direction is solid (session continuation via additional `session.prompt()` calls is the right primitive), but the plan as written will introduce type/behavior mismatches across orchestrators and has unresolved semantics around *which* escalations can safely continue the prior session (especially reviewer-originated escalations that route to `AUTO_FIX`).

**Readiness:** Not ready — needs a small set of human decisions on semantics/scope, plus mechanical fixes to avoid runtime hangs and keep other loops compiling/behaving safely.

---

## Strengths

- Reuses existing OpenCode SDK session model; avoids inventing a parallel continuation mechanism.
- Correct instinct to carry `sessionId` through the in-memory escalation event rather than adding DB coupling in the hot path.
- Keeps `f` (fresh session) as an escape hatch; continuation is additive.
- Identifies the reviewer-session vs author-fix mismatch and attempts to prevent offering a broken `c` path.

---

## Production readiness blockers

### P0.1 — `EscalationResponse` union expansion must be handled everywhere

**Risk:** Adding `{ action: "continue_session" }` to the shared `EscalationResponse` type can create unhandled switch cases (notably in `5x-cli/src/orchestrator/plan-review-loop.ts`), leading to loops that never advance (re-prompt forever / hang) or silently ignore the new action.

**Requirement:** All orchestrator and gate-call sites that consume `EscalationResponse` must explicitly handle `continue_session` (either implementing it or mapping it deterministically to existing behavior).

**Implementation guidance:** Audit `switch (response.action)` across `5x-cli/src/orchestrator/phase-execution-loop.ts`, `5x-cli/src/orchestrator/plan-review-loop.ts`, and any TUI wrappers in `5x-cli/src/tui/gates.ts`. Add tests proving `continue_session` cannot strand the state machine.

---

### P0.2 — Define and enforce safe eligibility for `continue_session`

**Risk:** Continuing the *wrong* session (e.g., reviewer session) while routing to an author state (`AUTO_FIX`) is correctness-breaking and will confuse users; offering `c` when it cannot work (timeout-aborted sessions, non-agent escalations) erodes trust.

**Requirement:** A crisp policy for when `c` is offered and what session it continues, with enforcement in code (not just UI text). At minimum:

- `c` only when the continued session’s role matches the next invocation role/state.
- `c` never shown for verdict-driven escalations that route to a different state/role (e.g., `retryState: "AUTO_FIX"` created from reviewer verdicts).
- Document whether `c` is supported in plan-review loop, phase-execution loop, or both.

**Implementation guidance:** Prefer encoding eligibility into `EscalationEvent` (e.g., `originState`/`originRole`/`resumeState` alongside `sessionId`) so gates don’t need implicit knowledge. Avoid trying to infer eligibility solely from `preEscalateState` at render time.

---

## High priority (P1)

### P1.1 — Timeout semantics vs continuation need a decision

Today `OpenCodeAdapter._invoke()` aborts the session on timeout (`client.session.abort(...)`). That likely makes continuation impossible in the most common “interrupted” case the plan calls out.

Recommendation: decide whether timeout should (a) abort and make `c` best-effort/rare, or (b) *not* abort and instead detach/stop streaming locally to preserve the ability to continue. This is a product/reliability trade-off and should be explicit in the plan.

---

### P1.2 — Plan references don’t match current code structure

The plan references functions/locations that don’t exist as named (e.g., `createHeadlessEscalationGate()`; current headless gate is `escalationGate()` in `5x-cli/src/gates/human.ts`).

Recommendation: update the plan to the actual symbols/paths, or add the referenced helper(s) if you truly want the refactor.

---

### P1.3 — Test plan needs adjustment for interactive headless gates

`5x-cli/src/gates/human.ts` is stdin-driven and intentionally non-interactive under `NODE_ENV=test`, so “unit tests for the escalation gate” as proposed won’t be straightforward without PTY simulation or refactoring.

Recommendation: validate parsing/behavior via the existing TUI gate tests (`5x-cli/test/tui/gates.test.ts`) and via orchestrator integration tests (injecting an escalation gate function that returns `continue_session`).

---

## Medium priority (P2)

- **Dashboard/docs compatibility:** `5x-cli/docs/10-dashboard.md` documents escalation gate response shapes; it should be updated to include `continue_session` (even if dashboard bridge is future work).
- **TUI ergonomics:** If continuation skips session creation, consider whether `InvokeOptions.onSessionCreated` should be complemented by an `onSessionReady`/`onSessionReused` callback so the UI can reliably focus the continued session.
- **Persistence expectations:** With `sessionId` only carried in-memory, continuation won’t survive process restarts/resume. That’s fine, but should be stated as an explicit limitation.

---

## Readiness checklist

**P0 blockers**
- [ ] All consumers of `EscalationResponse` handle `continue_session` safely (no hangs, no silent ignore).
- [ ] Eligibility policy for `continue_session` is defined + encoded so gates only offer it when correct.

**P1 recommended**
- [ ] Timeout vs abort behavior is decided and reflected in adapter + UX.
- [ ] Plan references updated to match actual code symbols/paths.
- [ ] Tests updated to cover `continue_session` without relying on interactive stdin in unit tests.
