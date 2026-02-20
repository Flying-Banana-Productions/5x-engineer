# Review: Console Output Cleanup (005) — Phase 1-2 Implementation

**Review type:** `be03c0e936..d25d3058`  \
**Scope:** 005 console output cleanup Phase 1 (ANSI utils + StreamWriter) and Phase 2 (formatter contract + caller update) in `5x-cli`.  \
**Reviewer:** Staff engineer (correctness, architecture, tenancy/security, performance, operability, test strategy)  \
**Local verification:** `bun test --concurrent --dots` (pass: 444, skip: 1, fail: 0)

**Implementation plan:** `docs/development/005-impl-console-output-cleanup.md`  \
**Technical design / related docs:** `docs/development/002-impl-realtime-agent-logs.md`, `docs/development/003-impl-5x-cli-opencode.md`, `docs/development/004-impl-5x-cli-tui.md`

## Summary

Phases 1-2 land the right primitives and contracts: deterministic ANSI enablement (`NO_COLOR`/`FORCE_COLOR`/TTY), a streaming word-wrapper that understands fenced blocks, and a semantic formatter that returns `{ text, dim }` with bounded tool-output collapsing. Unit tests are thorough and fast.

Main correctness gap: `StreamWriter` currently drops trailing whitespace immediately before an explicit `\n` outside fences, violating the plan invariant (“never removes whitespace”) and potentially changing markdown semantics (hard line breaks).

**Readiness:** Ready with corrections — proceed to Phase 3 after fixing the newline whitespace loss; consider limiting Phase 2 console output length until StreamWriter truncation is wired.

---

## What shipped

- **ANSI detection utility:** `5x-cli/src/utils/ansi.ts` adds pure `resolveAnsi({ isTTY, env })` returning `{ dim, reset, colorEnabled }`.
- **Streaming writer:** `5x-cli/src/utils/stream-writer.ts` provides streaming word-wrap, fence-aware bypass, `writeLine()` truncation, and dim/reset style transitions.
- **Formatter contract + semantics:** `5x-cli/src/utils/sse-formatter.ts` now returns `FormattedEvent` (`{ text, dim } | null`), simplifies tool/input summaries, collapses tool outputs to single-line snippets, suppresses step-finish.
- **Caller compatibility:** `5x-cli/src/agents/opencode.ts` updated to consume `.text` (keeps current 2-space indent and direct stdout writes in Phase 2).
- **Tests:** new/updated unit suites for ANSI, StreamWriter, and SSE formatter.

---

## Strengths

- **Correct phase architecture:** formatter returns semantic content; writer owns width/ANSI/newline placement (good separation of concerns).
- **Deterministic ANSI behavior:** no import-time globals; precedence is explicit (`NO_COLOR` wins; `FORCE_COLOR=0` disables).
- **Performance boundedness:** tool output collapsing slices before regex replacement; avoids O(n) scans of megabyte outputs.
- **Testability:** injectable writer/width/ansi makes StreamWriter unit tests precise; formatter tests cover tool-specific summaries and legacy shapes.

---

## Production readiness blockers

### P0.1 — StreamWriter drops trailing whitespace before explicit newline

**Risk:** Input like `"two-spaces  \n"` becomes `"two-spaces\n"` (outside fences). This violates the plan’s “whitespace preservation” invariant and can change markdown semantics (two-space hard breaks) and alignment.

**Requirement:** If the model emits spaces/tabs immediately before an explicit `\n`, those characters must be preserved exactly.

**Implementation guidance:** In `5x-cli/src/utils/stream-writer.ts`, on `ch === "\n"`, emit any buffered `spaceBuf` (outside fences too) before writing the newline.

---

## High priority (P1)

### P1.1 — Phase 2 console output length increased prior to Phase 3 truncation

Phase 2 prints up to ~500 chars of tool output (`TOOL_OUTPUT_MAX_SLICE`) vs prior 200-char behavior. Until Phase 3 routes formatted events through `StreamWriter.writeLine()` truncation, this can increase terminal noise and slightly increases accidental secret exposure surface.

Recommendation: reduce `TOOL_OUTPUT_MAX_SLICE` for Phase 2, or add a temporary `process.stdout.columns`-based truncation shim at the Phase 2 call site.

### P1.2 — Add the planned adapter-level rendering regression test early

Unit tests are strong, but the riskiest behavior is in the adapter loop (interleaving deltas with formatted tool/result events, newline termination, reasoning gating in Phase 3). Land `5x-cli/test/agents/opencode-rendering.test.ts` early in Phase 3 to lock observable behavior.

---

## Medium priority (P2)

- **Fence detection robustness:** current fence toggle checks `trimStart().startsWith("```")` on newline; OK for the plan, but won’t catch indented fences or other preformatted regions (acceptable if explicitly out of scope).
- **Terminal width edge cases:** `process.stdout.columns` can be `0`/undefined in some environments; behavior should be defined (today it falls back to 80).

---

## Readiness checklist

**P0 blockers**
- [x] Preserve trailing whitespace before explicit `\n` in `StreamWriter`.

**P1 recommended**
- [x] Constrain Phase 2 displayed tool output length until Phase 3 truncation is active.
- [x] Add adapter-level rendering regression test (`opencode` event loop).

---

## Plan phase mapping + readiness

- **Phase 1 (Foundation):** ✅ complete (matches plan; tests present and passing).
- **Phase 2 (Formatter + caller update):** ✅ complete (new `FormattedEvent` contract; caller updated; bounded collapse implemented; tests updated).
- **Ready to start Phase 3 (Integration):** ⚠️ after P0.1 fix; otherwise risk of subtle output corruption on explicit newlines.
