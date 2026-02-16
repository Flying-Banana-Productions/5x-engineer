# Review: 5x CLI Phase 2 (Agent Adapters)

**Review type:** `aea0cb2540`  \
**Scope:** Phase 2 adapter abstraction + Claude Code CLI adapter + factory + tests in `5x-cli/`  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, performance, operability, test strategy)  \
**Local verification:** `cd 5x-cli && bun test` PASS (141 pass, 1 skip); `bun run typecheck` PASS; `bun run lint` FAIL (Biome)

**Implementation plan:** `docs/development/001-impl-5x-cli.md`  \
**Technical design:** N/A

## Summary

Phase 2 delivers a clean adapter seam (`AgentAdapter`) and a working Claude Code CLI implementation with env-gated schema probing and unit tests. The direction matches the plan (minimal required contract; signals parsed from `output`; optional tokens/cost only for display).

Key remaining risk is correctness/operability around subprocess timeout semantics (timeout path can still block while draining streams) and error interpretation (`is_error` vs exit code). Lint currently fails on formatting/import ordering.

**Readiness:** Ready with corrections - fix P0s before building Phase 3 templates that rely on stable invocation semantics.

---

## What shipped

- **Adapter contract:** `AgentAdapter`, `InvokeOptions`, `AgentResult` (`5x-cli/src/agents/types.ts`).
- **Claude Code adapter:** Bun subprocess invocation + JSON parsing + timeout handling (`5x-cli/src/agents/claude-code.ts`).
- **Factory:** config-driven adapter creation + availability verification (`5x-cli/src/agents/factory.ts`).
- **Public exports:** adapter types/impl exported for downstream config + reuse (`5x-cli/src/index.ts`).
- **Tests:** unit tests for arg building/JSON parsing/invoke behavior + env-gated live schema probe (`5x-cli/test/agents/*.test.ts`).

---

## Strengths

- **Minimal contract aligns with plan:** required fields are exactly what orchestration can safely depend on; optional fields are explicitly non-routing.
- **Graceful degradation:** JSON parse failures fall back to raw stdout rather than hard-failing.
- **Env-gated live probe:** catches upstream JSON schema drift without making CI depend on external services.
- **Straightforward extensibility:** factory/typing is OpenCode-ready without entangling orchestration logic.

---

## Production readiness blockers

### P0.1 — Timeout must bound total wall time (no hangs while draining)

**Risk (operability/correctness):** `invoke()` can exceed the requested timeout if the process doesn’t terminate promptly or if stdout/stderr draining blocks. This defeats the timeout guarantee and can wedge orchestration loops.

**Requirement:** `invoke(timeout=X)` must return in O(X + small_delta) regardless of subprocess behavior.

**Implementation guidance:** after timeout, send `SIGTERM`, wait a short grace, then `SIGKILL`; make stdout/stderr read bounded (e.g., `Response(stream).text()` with an abort signal, or wrap draining in its own timeout and return best-effort partial output).

### P0.2 — Treat JSON-level errors as failures, not just exit code

**Risk (correctness):** Claude Code JSON includes `is_error`/`subtype`. If CLI exits 0 but `is_error=true` (or vice versa), orchestration may misclassify failures as success and proceed to later phases incorrectly.

**Requirement:** Define failure semantics: `exitCode != 0` OR `parsed.is_error === true` must map to `AgentResult.exitCode != 0` and populate `error` with subtype/stderr context.

---

## High priority (P1)

### P1.1 — Fix Biome lint failures and keep lint green

`bun run lint` currently fails on import ordering / formatting in `5x-cli/src/index.ts` and tests. If lint is a gate, this blocks landing follow-on work; even if not, it increases churn in subsequent commits.

### P1.2 — Avoid passing full prompt on argv (process list leak + cmdline length)

The adapter passes the entire prompt via `-p <prompt>` argv. On multi-user systems, argv can be visible to other users via `ps`, and long prompts can exceed OS command-line limits.

Recommendation: prefer stdin or a temp file if Claude supports it; otherwise, document the limitation and ensure templates avoid embedding secrets.

### P1.3 — Schema probe should not require optional fields

The live probe currently asserts presence/types for `usage` and `total_cost_usd`. Adapter correctness does not require those fields.

Recommendation: probe only the required subset (at least `result`; optionally `type`), and treat tokens/cost as “if present, validate type.”

---

## Medium priority (P2)

- **Stream decoding correctness:** `drainStream()` never flushes the final decoder state; add a final `decoder.decode()` or use `new Response(stream).text()`.
- **Test fidelity:** `MockableClaudeCodeAdapter` duplicates parsing/arg logic; prefer injecting spawn/drain/time sources so tests exercise the real implementation.
- **Factory doc mismatch:** `createAdapter()` comment says it validates availability and logs warnings, but only `createAndVerifyAdapter()` checks availability; align comments/behavior.

---

## Readiness checklist

**P0 blockers**
- [ ] Enforce timeout upper bound (no drain-related hangs).
- [ ] Map Claude JSON `is_error`/`subtype` into failure semantics.

**P1 recommended**
- [ ] Fix Biome lint failures; keep lint green.
- [ ] Mitigate argv prompt exposure / length limit.
- [ ] Relax schema probe to required fields; keep it CI-safe.

---

## Readiness assessment vs implementation plan

- **Phase 2 completion:** ⚠️ — core adapter seam + Claude adapter exist and are tested, but P0.1/P0.2 should be fixed to make invocation semantics reliable enough to depend on in Phase 3/4 loops.
- **Ready for next phase (Phase 3: Prompt Templates + Init):** ⚠️ — proceed after P0s + lint cleanup.

---

## Addendum (2026-02-16) — Validation of remediation commit

**Reviewed:** `088083aac8`

**Local verification:** `cd 5x-cli && bun test` PASS (143 pass, 1 skip); `bun run typecheck` PASS; `bun run lint` PASS

### What's addressed (✅)

- **P0.1 timeout upper bound:** Timeout path now does bounded SIGTERM→grace→SIGKILL and uses bounded draining so `invoke()` has an explicit wall-time cap (`5x-cli/src/agents/claude-code.ts`).
- **P0.2 JSON-level error semantics:** `is_error=true` now forces a non-zero `exitCode` (even if process exit is 0) and surfaces `subtype`/stderr context; unit coverage added (`5x-cli/src/agents/claude-code.ts`, `5x-cli/test/agents/claude-code.test.ts`).
- **P1.1 lint hygiene:** Biome issues fixed; lint now green.
- **P1.2 argv prompt limitations:** Limitation is documented and a `MAX_PROMPT_LENGTH` guard prevents pathological failures (`5x-cli/src/agents/claude-code.ts`).
- **P1.3 schema probe correctness:** Live probe asserts only required fields (`type`, `result`) and validates optional fields only when present (`5x-cli/test/agents/claude-code-schema-probe.test.ts`).
- **P2 stream decoding correctness:** Stream draining uses `new Response(stream).text()` (correct EOF flush) (`5x-cli/src/agents/claude-code.ts`).
- **P2 test fidelity:** Tests inject at `spawnProcess()` boundary so real `invoke()` logic is exercised (no duplicate parser implementation) (`5x-cli/test/agents/claude-code.test.ts`).
- **P2 factory docs:** Comments now match actual `createAdapter()` vs `createAndVerifyAdapter()` behavior (`5x-cli/src/agents/factory.ts`).

### Remaining concerns / follow-ups

- **P2 prompt length check should be byte-based:** `MAX_PROMPT_LENGTH` is described as bytes but enforced via JS string length (chars). Prefer `new TextEncoder().encode(prompt).length` (or `Buffer.byteLength`) so the limit matches OS argv reality for non-ASCII prompts (`5x-cli/src/agents/claude-code.ts`).
- **P2 bounded drain abort semantics are non-standard:** `boundedDrain()` relies on passing `signal` into `ResponseInit` via cast; confirm Bun actually aborts body reads on signal. If not, implement bounded draining via `stream.getReader()` + explicit cancellation, and add a unit test with a non-terminating stream to prove timeout boundedness without risking a hung test (`5x-cli/src/agents/claude-code.ts`).
- **P2 error context on non-zero failures:** If `exitCode != 0` and there is no stderr and no `(is_error && subtype)`, `error` can be undefined; consider always including at least `exit code N` and/or `subtype` when present.

### Updated readiness

- **Phase 2 completion:** ✅ — review P0/P1 items are addressed with code + tests; local suite green.
- **Ready for next phase (Phase 3: Prompt Templates + Init):** ✅ — proceed; keep the remaining P2s as hardening.
