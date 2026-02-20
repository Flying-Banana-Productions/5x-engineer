# Review: Console Output Cleanup (005) — Phase 3 Implementation

**Review type:** `66910abb`  \
**Scope:** Wire `StreamWriter` into OpenCode headless console rendering; add `--show-reasoning` flag and plumb it through commands + orchestrators into adapter invoke options.  \
**Reviewer:** Staff engineer (correctness, architecture, tenancy/security, performance, operability, test strategy)  \
**Local verification:** `bun test --concurrent --dots`, `bun run lint`, `bun run typecheck` (pass)

**Implementation plan:** `5x-cli/docs/development/005-impl-console-output-cleanup.md`  \
**Technical design:** `5x-cli/docs/development/002-impl-realtime-agent-logs.md`, `5x-cli/docs/development/003-impl-5x-cli-opencode.md`, `5x-cli/docs/development/004-impl-5x-cli-tui.md`

## Summary

Phase 3 lands the intended integration: headless output now uses a single component (`StreamWriter`) for wrapping, truncation, and dim styling, and reasoning display is a deliberate opt-in policy (`--show-reasoning`) rather than an accidental behavior. The plumbing is end-to-end (CLI -> orchestrators -> adapter) and tests/lint/typecheck are clean.

Primary remaining gap is defensive handling of extremely small/odd terminal widths inside `StreamWriter` (constructor currently accepts `0`/tiny widths), which can break truncation guarantees.

**Readiness:** Ready with corrections — ship after clamping `StreamWriter` width; then do a quick manual smoke (`TTY` + `NO_COLOR=1`).

---

## What shipped

- **Adapter console rendering:** `5x-cli/src/agents/opencode.ts` routes text deltas to `StreamWriter.writeText()`, formatted tool/result events to `StreamWriter.writeLine()`, and optional reasoning deltas to `StreamWriter.writeThinking()`.
- **Reasoning flag:** `--show-reasoning` added to `5x-cli/src/commands/run.ts`, `5x-cli/src/commands/plan.ts`, `5x-cli/src/commands/plan-review.ts`; plumbed via `showReasoning` through `5x-cli/src/orchestrator/phase-execution-loop.ts` and `5x-cli/src/orchestrator/plan-review-loop.ts` into `5x-cli/src/agents/types.ts` / invoke options.
- **Removal of Phase 2 shim:** Drops the temporary `(columns - indent)` truncation shim + streamingLine bookkeeping in favor of `StreamWriter`.

---

## Strengths

- **Correct separation of concerns:** formatter remains semantic (`{ text, dim }`); writer owns width math + ANSI transitions; adapter only routes events.
- **Tenancy/security posture preserved:** default remains "reasoning suppressed"; enabling reasoning is explicit and scoped to headless output (quiet/TUI suppresses console writes).
- **Test posture remains strong:** existing rendering pipeline tests continue to lock observable formatting behavior; CI-relevant commands pass locally.

---

## Production readiness blockers

### P0.1 — Clamp `StreamWriter` width defensively

**Risk:** `StreamWriter.truncate()` assumes `width >= 3`; widths like `0`, `1`, `2`, or negative can cause negative-slice behavior and violate the "output length <= width" contract (and can also create wrap anomalies).

**Requirement:** `StreamWriter` must normalize width at construction so wrapping/truncation are well-defined (minimum usable width) even in odd terminals or test injection.

**Implementation guidance:** In `5x-cli/src/utils/stream-writer.ts`, coerce to an integer and clamp (e.g. `Math.max(4, width)`), treating non-finite values as a safe default.

---

## High priority (P1)

### P1.1 — Reasoning is visually indistinguishable when ANSI is disabled

When `NO_COLOR`/non-TTY, dim sequences are empty strings; enabling `--show-reasoning` then renders reasoning the same as normal prose. Recommendation: add a non-ANSI fallback marker/prefix for reasoning when `ansi.colorEnabled` is false (or put reasoning on its own line).

### P1.2 — Rendering test mirrors adapter routing logic (drift risk)

`5x-cli/test/agents/opencode-rendering.test.ts` intentionally duplicates the routing state machine; now that Phase 3 is wired, this can drift. Recommendation: extract a small shared pure helper (route event -> writer calls) used by both adapter and test.

---

## Medium priority (P2)

- **Unicode width correctness:** wrap/truncation use JS `string.length` (code units), not terminal column width; consider documenting this limitation or adding a best-effort wcwidth for later.
- **Resize behavior:** width is captured once at writer creation; `SIGWINCH` handling is still out of scope but worth tracking as a follow-up if long runs are common.
- **Interleaving stdout writes:** orchestrator status messages (`console.log`) could interleave with streaming output in rare cases; consider routing orchestrator logs through the same writer or enforcing phase-boundary-only logging.

---

## Readiness checklist

**P0 blockers**
- [x] Clamp `StreamWriter` width in `5x-cli/src/utils/stream-writer.ts`.

**P1 recommended**
- [x] Add a no-ANSI reasoning marker/policy for `--show-reasoning`.
- [x] De-duplicate adapter routing logic between `5x-cli/src/agents/opencode.ts` and `5x-cli/test/agents/opencode-rendering.test.ts`.

---

## Plan phase mapping + readiness

- **Phase 3 (Integration):** ✅ functionally complete (matches `5x-cli/docs/development/005-impl-console-output-cleanup.md`)
- **Plan completeness:** No remaining implementation phases; manual smoke test remains the only explicit plan checkbox.

---

## Addendum (2026-02-20) — Re-review after fixes (`ef967d9cf4a`)

**Reviewed:** `ef967d9cf4a`  \
**Local verification:** `bun test --concurrent --dots`, `bun run lint`, `bun run typecheck` (pass)

### What's addressed (✅)

- **P0.1 width clamping:** `5x-cli/src/utils/stream-writer.ts` clamps width to `MIN_WIDTH` (4), floors fractional, defaults to 80 for non-finite; adds targeted tests.
- **P1.1 reasoning distinguishability (no ANSI):** `5x-cli/src/utils/stream-writer.ts` adds `> ` prefix for thinking at start-of-line when color is disabled; tests cover newlines + wrap-inserted breaks.
- **P1.2 test drift:** shared routing state machine extracted to `5x-cli/src/utils/event-router.ts`; both `5x-cli/src/agents/opencode.ts` and `5x-cli/test/agents/opencode-rendering.test.ts` use `routeEventToWriter()`.

### Remaining concerns

- **Router return value semantics:** `routeEventToWriter()` returns `false` even when it emits formatted lines (only used as a helper today). Consider returning `true` on any emitted output, or dropping the return value to avoid future misuse.

### Updated readiness

- **Phase 3 (Integration) completion:** ✅
- **Production readiness:** Ready — remaining work is manual smoke (TTY + `NO_COLOR=1`, with and without `--show-reasoning`).
