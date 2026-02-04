## Implementation Feedback — Start / Stop / Continue (30-day growth check-in)

**Date:** 2026-02-01  
**Perspective:** Staff engineer (code quality, correctness, security/tenancy, operability, testing)  
**Inputs:** Sampling of review docs in `docs/development/reviews` + spot-checks of related implementation code.

---

## Summary

You're consistently delivering meaningful cross-stack features (backend + frontend + docs) with strong follow-through on review feedback. The biggest quality unlock for the next 30 days is shifting a few recurring "late-stage fixes" into **upfront patterns**: single-source-of-truth registries, enforceable invariants at the boundary (not in UI render paths), and deterministic acceptance tests for end-to-end contracts.

---

## Start

- **Start establishing single sources of truth earlier** for cross-cutting surfaces (shared schemas, config registries, domain logic modules, error-code tables). The repo becomes noticeably safer once canonical modules exist and all consumers import from them.
- **Start writing 1-2 deterministic acceptance tests per phase before calling the phase complete**, especially for:
  - Async/streaming flows (request lifecycle + error semantics)
  - UI correctness edge-cases (focus/navigation, render precision, state-merging behaviors)
- **Start enforcing invariants at the boundary, not in the render path**:
  - If something "should never happen" (invalid state transitions, missing tenant context, malformed input), enforce it in the API/service layer and treat the UI as non-fatal fallback, not a place that can crash a whole view.
- **Start documenting (and applying) a consistent transaction + tenant-context rule of thumb**:
  - Wrapper-pattern helpers for standalone operations
  - Transaction-threaded patterns for anything that must compose inside an existing transaction
  - Explicitly avoid "hidden nested transactions" in code that claims atomicity
- **Start treating operability as part of "done"** for features that introduce new surfaces:
  - End-to-end correlation IDs (propagate, don't regenerate)
  - Stable domain error codes (not "internal error" everywhere)
  - Explicit logging/redaction defaults for any user-input-bearing flows

---

## Stop

- **Stop relying on prompt compliance for safety/authorization/confirmation UX**. If an action needs confirmation (or role gating), enforce it in code, not only in prompt wording.
- **Stop shipping fail-open defaults for sensitive discovery/permissions surfaces** unless explicitly dev-gated (feature discovery, "context missing => allow reads," overly permissive access policies).
- **Stop duplicating complex logic across layers** (precedence rules, boundary semantics, temporal logic, schema metadata). Duplications repeatedly show up later as subtle inconsistencies.
- **Stop logging raw user inputs/PII by default**, even temporarily (stubs echoing params, form submissions to logs). Default to redaction; require explicit debug switches for raw values.

---

## Continue

- **Continue the strong cadence and follow-through**: you close review loops with targeted fixes and usually add tests, which is a strong reliability signal.
- **Continue leaning into DI/testability** (constructor injection, service container overrides, mock tooling). This enables meaningful tests without brittle module mocking.
- **Continue "operator-first" UX improvements** (focus management, reduced motion, scroll/highlight affordances, clear error semantics). When you finish the last-mile edge cases, the result is production-grade.
- **Continue treating multi-tenancy as a first-class invariant** (access control hardening, tenant-context discipline, isolation tests). This is a standout strength and reduces future risk.

---

## Job ladder calibration (typical web-tech ladder)

Based on recent scope (cross-cutting backend+frontend+docs, security/tenancy, test strategy, operability) and execution quality, I'd place you as a **strong Senior Engineer (often Senior II / L5 scope)** with a **clear staff trajectory**.

The main gap to consistent Staff (L6) signal is **proactive risk elimination**: anticipating the edge-case/testability/SSOT pitfalls before implementation (vs. addressing them quickly and well after review).

---

## Suggested follow-up in ~30 days

- Re-sample recent reviews and compare:
  - **How often** issues are "caught in review" vs pre-empted by design/patterns
  - Presence of **SSOT modules** for cross-layer contracts
  - Whether each phase has at least **1-2 deterministic acceptance tests** proving the end-to-end contract
  - Whether invariants are enforced at **service/API boundaries** (UI as resilient fallback)

---

## AGENTS.md-ready guidance — 30-day measurable uplift (coding agent)

> Copy/paste-able rules for `AGENTS.md`. These are intentionally **measurable** and tuned to the patterns observed in the review artifacts.

### Output-quality goals

- **Fewer late-stage fixes**: reduce "review-found P0/P1 correctness issues" by **~50%** by shifting them into pre-implementation patterns (SSOT + acceptance tests + boundary invariants).
- **Deterministic proof per phase**: every non-trivial phase ships with **at least 1-2 deterministic acceptance tests** proving the end-to-end contract (not just unit coverage of helpers).
- **Zero accidental PII leakage**: no new code paths log/store raw PII by default (params echoing, form logs, input dumps).
- **No fail-open security defaults**: sensitive discovery/permission surfaces fail closed unless explicitly dev-gated.

### Required implementation rules (do these every time)

- **Single Source of Truth (SSOT) first**
  - If a feature spans **API + web + docs**, define a **single canonical module** for the contract (schemas/registry/constants) and import it from all consumers.
  - **Do not** duplicate: shared schemas, config registries, domain logic, error-code tables.

- **Boundary invariants over UI guards**
  - Enforce "must never happen" invariants in **service/API boundaries** (validation + normalization) and make UI protections **non-fatal**.
  - UI/render paths must not throw in a way that can crash a whole screen; prefer "graceful fallback + safe log".

- **Transaction + tenant-context discipline**
  - For any operation that must be atomic with other reads/writes, use a **transaction-threaded pattern** end-to-end.
  - Do not "claim atomic validation" while calling helpers that silently use a default connection or open their own transaction.
  - Use constructor-based DI for services; allow injecting DB handles for tests.

- **No prompt-only enforcement**
  - Prompt guidance is never a security or UX boundary.
  - If an action needs **approval/confirmation/role gating**, enforce it in code (approval flow, explicit client state gates, server-side auth checks).

- **Fail closed on sensitive surfaces**
  - Feature discovery, authorization, and access-control "context missing" cases must not default to exposing more data or capabilities.
  - If dev ergonomics need fail-open, gate behind an explicit env flag defaulted off.

- **PII-safe logging defaults**
  - Never log raw user input / emails / phones by default.
  - Redact by key *and* by value-pattern (API keys, JWTs, bearer tokens).
  - Any "debug raw logging" must be explicitly gated and documented.

### Minimum "done" checklist for non-trivial work

- **SSOT**
  - [ ] Contract defined once (schema/registry/constants) and reused everywhere
  - [ ] No duplicated contract tables living in docs + server + web separately

- **Tests (deterministic)**
  - [ ] Added **1-2 acceptance tests** that prove the end-to-end contract
  - [ ] For async/streaming: deterministic provider injection exists for tests (no external keys)
  - [ ] For UI edge cases: at least one targeted regression test (unit/component acceptable; E2E when interaction-heavy)

- **Correctness boundaries**
  - [ ] Validation/invariants enforced at API/service boundary (not only UI)
  - [ ] Client failures degrade gracefully (no render-path throws that can blank the view)

- **Security/tenancy**
  - [ ] Authorization enforced in services (not filtering/prompt-only)
  - [ ] Tenant context is required for tenant-scoped reads/writes; no "context missing => allow all"

- **Operability**
  - [ ] Correlation/request IDs propagate end-to-end (reuse inbound IDs when present)
  - [ ] Errors use stable domain codes (not generic "internal error")
  - [ ] Logs/audit events are redacted by default

### Review-gate metrics (track weekly; target improvement in 30 days)

- **Review-found P0/P1 count**: trend down by ~50% (especially "contract drift," "missing deterministic test," "fail-open," "UI-only invariant").
- **SSOT adoption**: 100% of cross-layer features add/extend an SSOT module (or explicitly justify why not).
- **Acceptance tests**: >=90% of non-trivial phases include at least 1 deterministic end-to-end contract test.
- **PII regression**: 0 new instances of raw param echoing or raw form-input logging.
