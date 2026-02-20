# Review: Console Output Cleanup (005)

**Review type:** `docs/development/005-impl-console-output-cleanup.md`  \
**Scope:** Headless (non-TUI) console rendering for OpenCode SSE streams: word-wrapped streaming text, optional reasoning display, simplified tool/result formatting, step-finish suppression, ANSI dim styling (NO_COLOR/non-TTY aware).  \
**Reviewer:** Staff engineer (DX/UX, correctness, testability, operability)  \
**Local verification:** Not run (static review + inspected current log artifacts and formatter/adaptor code)

**Implementation plan:** `docs/development/005-impl-console-output-cleanup.md`  \
**Technical design / related docs:** `docs/development/004-impl-5x-cli-tui.md`, `docs/development/003-impl-5x-cli-opencode.md`, `docs/development/002-impl-realtime-agent-logs.md`; implementation in `5x-cli/src/agents/opencode.ts`, `5x-cli/src/utils/sse-formatter.ts`.

## Summary

Direction is right: current headless output is hard to follow (bracket noise, multi-line tool results from `read`/`write`, per-turn step-finish spam, no wrapping). The plan’s separation (formatter returns semantic text + style hint; a writer owns wrapping/styling/newline placement) is a good architecture.

However, the current plan has a few correctness/testability gaps that will likely cause regressions (whitespace preservation, code/preformatted output wrapping, width accounting with indent, Unicode/icon assumptions, and phase-gating that won’t compile if executed literally).

**Readiness:** Not ready — needs P0 corrections to avoid output corruption/regressions and to make phases buildable/testable.

---

## Strengths

- Keeps log artifacts authoritative: full SSE events remain in `.ndjson` logs; console is a derived view.
- Good containment: changes live in adapter console path (`writeEventsToLog`) and formatter; TUI mode remains quiet-gated.
- Correct goal state: tool chatter should visually recede; step-finish should not dominate; results should be single-line.
- Test intent is strong (StreamWriter unit tests + formatter assertions + integration smoke).

---

## Production readiness blockers

### P0.1 — Phase 2/3 gating is not buildable as written (API break without caller update)

**Risk:** Phase 2 changes `formatSseEvent()` return type, but the only caller in `5x-cli/src/agents/opencode.ts` expects `string | null`. If Phase 2 lands “formatter-only”, TypeScript/build breaks (or runtime breaks if typed loosely). This undermines the phased rollout gates.

**Requirement:** Each phase must leave the repo compiling + tests passing.

**Implementation guidance:** Either:
- Keep `formatSseEvent()` stable and introduce `formatSseEventV2()` (or similar) for Phase 2, then switch the adapter in Phase 3; or
- Update `opencode.ts` in Phase 2 to consume the new return type while preserving current visual output (then do the real visual changes in Phase 3).

---

### P0.2 — StreamWriter wrapping must preserve whitespace + not corrupt preformatted/code output

**Risk:** A naive “word buffer + drop whitespace at line start” wrapper will:
- Destroy intentional indentation (bullets, nested lists, markdown code blocks)
- Potentially change meaning of output (leading spaces, tab alignment)
- Hard-wrap code/table lines in a way that is worse than terminal soft-wrap

**Requirement:** Define and implement explicit wrapping semantics:
- Preserve input whitespace/newlines exactly unless wrapping inserts an extra newline.
- Never drop leading whitespace that exists in the delta.
- Provide a strategy for preformatted regions (at minimum fenced code blocks ```…```; ideally also indented code blocks) where wrapping is disabled and lines are passed through.

**Implementation guidance:** Track a simple “inFence” state in the writer (streaming-safe) and bypass wrapping while in fenced blocks; preserve runs of whitespace; ensure wrapping does not reflow lines that the model already line-broke.

---

### P0.3 — Width accounting is inconsistent (indent + truncation + single-line contract)

**Risk:** The plan truncates in `formatSseEvent(event, maxWidth)` using terminal width, but the writer then adds indent, potentially exceeding width. Also, any formatted event that still contains `\n` will break the “single-line dim tool/result” goal and can desync column tracking.

**Requirement:** One component owns width math, and all formatted events are single-line.

**Implementation guidance:** Prefer: formatter returns semantic text (no newlines, no indent); StreamWriter applies indent and does truncation against `(width - indent.length)` for `writeLine()`.

---

### P0.4 — ANSI/color + Unicode assumptions need tightening

**Risk:** Using Unicode glyphs (`✗`, `…`) based on “color supported” is the wrong proxy (color != Unicode support) and violates the repo’s general ASCII-first convention. Import-time color detection also makes tests flaky under module caching and concurrent env changes.

**Requirement:**
- Keep console markers ASCII-first (e.g. `! bash: ...`, `...`), or add an explicit “unicode ok” detector/config.
- Color detection must be deterministic and unit-testable without relying on `process.stdout.isTTY` in the test runner.
- Respect common env semantics (`NO_COLOR` should win; `FORCE_COLOR=0` should disable).

**Implementation guidance:** Implement a pure resolver (`resolveAnsi({ isTTY, env })`) and call it at StreamWriter construction; avoid import-time evaluation.

---

### P0.5 — Tool output collapsing/truncation must be bounded for huge outputs

**Risk:** Real tool outputs (notably `read`) can be very large (full file contents in the SSE event). Collapsing newlines across the entire string (or regex replace on the full output) can allocate/scan megabytes per event and hurt interactivity.

**Requirement:** Formatting must be O(k) in the displayed width, not O(n) in the tool output size.

**Implementation guidance:** Operate on a slice/window sized to the target width (+small slack), collapse whitespace within that window, then truncate; avoid scanning the full output string.

---

## High priority (P1)

### P1.1 — Make “show reasoning/thinking” a deliberate policy (default vs opt-in)

Showing reasoning inline is a major UX change and can increase noise or expose sensitive intermediate content. Decide whether:
- It is default-on in headless TTY mode, or
- It is opt-in via flag/env (recommended), with the writer still supporting it when enabled.

### P1.2 — Add a focused integration test for `writeEventsToLog()` rendering behavior

Unit tests for writer/formatter are good, but add a small adapter-level test that:
- Feeds a synthetic event stream with text deltas + tool running/completed + step-finish
- Asserts: (a) step-finish suppressed, (b) tool lines are single-line, (c) text wrapping preserves whitespace around newlines

---

## Medium priority (P2)

- **Terminal resize:** optional follow-up—consider reacting to `SIGWINCH` (or re-reading `process.stdout.columns`) to avoid wrapping at stale widths for long runs.
- **Consistency:** ensure orchestrator status messages and agent output share a consistent indent/prefix policy (document it explicitly in the plan).
- **Docs/examples:** add a before/after snippet in `docs/development/005-impl-console-output-cleanup.md` so reviewers can evaluate UX outcomes without running the CLI.

---

## Readiness checklist

**P0 blockers**
- [ ] Phase boundaries are buildable (no type break landing alone)
- [ ] Wrapping preserves whitespace and does not hard-wrap fenced/preformatted output
- [ ] Width accounting is centralized; formatted events are single-line; indent is included in truncation
- [ ] ANSI/color detection is deterministic/testable and ASCII-first markers are used (or unicode support is explicit)
- [ ] Tool output collapse/truncation is bounded (no full-string scans on huge outputs)

**P1 recommended**
- [ ] Reasoning display policy decided (default vs opt-in) and documented
- [ ] Adapter-level rendering test added to prevent regressions
