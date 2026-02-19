# Review: 5x CLI — TUI Integration

**Review type:** `docs/development/004-impl-5x-cli-tui.md` (v1.1)  
**Scope:** Add OpenCode TUI as display layer for `5x run` / `5x plan-review` / `5x plan`; randomize OpenCode server port; TUI lifecycle/session focusing; replace readline human gates when TUI owns terminal.  
**Reviewer:** Staff engineer (reliability, UX/DX, operability)  
**Local verification:** Static review; additionally verified `opencode attach --help` supports `--dir` and URL attach.

**Implementation plan:** `docs/development/004-impl-5x-cli-tui.md`  
**Technical design / related docs:** `docs/development/003-impl-5x-cli-opencode.md`, `docs/development/002-impl-realtime-agent-logs.md`; existing code in `5x-cli/src/agents/opencode.ts`, `5x-cli/src/orchestrator/*`, `5x-cli/src/gates/human.ts`.

## Summary

This is directionally correct: the OpenCode TUI can be treated as a bolt-on display client while the orchestrator continues to drive `client.session.prompt()` with structured output unchanged. However, the plan currently leaves several production-critical behaviors underspecified (permission prompts, human gates, signal/exit flow with a terminal-owning child process, and stdout interleaving). These require explicit decisions and acceptance criteria before implementation.

**Readiness:** Not ready — core interactive/control-plane behaviors (gates, permissions, signal handling, output ownership) need concrete design choices to avoid hangs, broken UX, and cleanup regressions.

---

## Strengths

- Clear containment: orchestration + structured output stay unchanged; only the presentation / gating surface changes.
- Correctly identifies the port-4096 conflict risk; per-invocation server avoids stale server collisions.
- Good UX instincts: session titles + session focusing are the right primitives for a TUI-first experience.
- Uses existing “quiet” pathway to suppress stdout formatting when TUI is active (keeps logs intact).

---

## Production readiness blockers

### P0.1 — Interactive gates are underspecified and likely brittle via SSE-only parsing

**Risk:** Non-auto mode can hang or mis-route if the CLI cannot reliably observe “user typed continue/abort” in the attached TUI. Parsing “session.idle” + “first message text” is not yet a concrete, testable contract.

**Requirement:** Define a deterministic gate protocol that works with (a) TUI attached, (b) headless TTY, (c) non-interactive stdin, and (d) resume flows. Must include: timeout/cancel semantics, what event(s) are listened for, how the user input is retrieved, and how the gate session is cleaned up.

**Implementation guidance:** Prefer an explicit control channel if available (OpenCode SDK exposes TUI endpoints under `client.tui.*` and `client.tui.control.*`) rather than inferring user intent from generic SSE event ordering.

---

### P0.2 — Permission prompt model is an open question but affects correctness (hang risk)

**Risk:** If OpenCode tool permissions require an explicit reply, headless mode (including CI / non-TTY) can block indefinitely mid-invocation, and TUI mode behavior will diverge from headless.

**Requirement:** Specify and implement a permission policy for `5x run/plan/plan-review` across modes (TUI attached vs headless), including defaults in `--auto` vs non-auto. Document it and add at least one test that would hang without the policy.

**Implementation guidance:** If the SDK provides a permission API (e.g., `client.permission.reply()`), wire it behind a policy object; keep policy decisions out of the adapter.

---

### P0.3 — Terminal ownership and stdout/stderr interleaving

**Risk:** Once `opencode attach` takes over the terminal (`stdio: inherit`), any parent-process `console.log`/stdout writes (phase headers, verdict lines, prompts) may corrupt the TUI display or make the UX unusable.

**Requirement:** Define “output ownership” rules for TUI mode: what (if anything) the parent prints, and where (stderr vs toast vs log file). Make this explicit for run start banner, per-phase headers, escalations, and final summary.

**Implementation guidance:** Treat TUI mode as “no stdout from 5x-cli after attach”; use `client.tui.showToast()` and/or stderr for minimal non-TUI overlays.

---

### P0.4 — Signal handling / cleanup behavior conflicts with the stated Ctrl-C flow

**Risk:** Current code path uses process-level signal handlers (see `5x-cli/src/agents/factory.ts`) that call `process.exit(...)`, which can skip async `finally` cleanup in command handlers and is not aligned with “TUI gets Ctrl-C first, then 5x aborts naturally”. This can leak locks/worktrees/server processes or leave DB state inconsistent.

**Requirement:** Specify and test Ctrl-C semantics in TUI mode and headless mode, including: whether the orchestrator receives an AbortSignal, whether the adapter session is aborted, and guaranteed execution of lock + server cleanup.

**Implementation guidance:** Prefer “set exitCode + cooperative cancellation + finally cleanup” over hard `process.exit()` in the hot path.

---

## High priority (P1)

### P1.1 — Port selection should use `port: 0` if supported (avoid TOCTOU)

The implementation plan proposes `findFreePort()` + probing a range. The OpenCode CLI supports `--port 0` (ephemeral) and the SDK’s server wrapper parses the actual URL from server output; using port 0 eliminates probe races and reduces code surface.

Recommendation: call `createOpencode({ hostname: '127.0.0.1', port: 0 })` and surface `serverUrl` from the returned `server.url`.

---

### P1.2 — TUI mode detection should include `stdin` TTY

The plan keys off `process.stdout.isTTY`. A TUI requires interactive input; cases exist where stdout is a TTY but stdin is not (pipes, redirected input). Detection should be `process.stdin.isTTY && process.stdout.isTTY` (and still respect `--no-tui`).

---

### P1.3 — Flag semantics: `--quiet` vs TUI default

Plan text says `--quiet` is ignored in TUI mode, but the current CLI uses `--quiet` as a strong user intent signal. Decide whether `--quiet` should imply `--no-tui` (likely), or whether it only suppresses non-TUI stdout while still attaching the TUI.

---

## Medium priority (P2)

- **Session focus parameters:** `client.tui.selectSession()` supports an optional `directory`; confirm whether multi-workdir runs (worktree) need it and codify usage.
- **Gate session deletion:** deleting the gate session removes a potentially useful audit trail; consider retaining it (or writing an explicit DB/audit record) for postmortems.
- **Test plan gaps:** add at least one integration-ish test that simulates “TUI active” behavior (no-op controller + forced quiet) to prevent regressions where stdout formatting reappears.

---

## Readiness checklist

**P0 blockers**
- [ ] Gate protocol in TUI mode is concrete, observable, and tested
- [ ] Permission prompt policy defined + wired (no hangs in headless/CI)
- [ ] No stdout corruption when TUI owns terminal; clear output ownership rules
- [ ] Ctrl-C/cancellation semantics ensure adapter + lock cleanup always run

**P1 recommended**
- [ ] Use `port: 0` rather than `findFreePort()` probing
- [ ] Require `stdin` + `stdout` TTY for default TUI mode
- [ ] Decide/document `--quiet` vs `--no-tui` semantics

---

## Addendum (2026-02-19) — Re-review after plan corrections (v1.2)

**Reviewed:** `450964c` (`docs/development/004-impl-5x-cli-tui.md` v1.2)

### What's addressed (✅)

- **P0.1 gates:** Deterministic, injectable gate protocol (TUI via explicit `client.tui.showDialog()`/control channel; no SSE inference), with timeout/cancel semantics and no create/delete of “gate sessions”.
- **P0.2 permissions:** Permission policy specified for `--auto`/TUI/headless/CI with a `PermissionPolicy` type + handler design; includes a hang-prevention test requirement.
- **P0.3 output ownership:** Explicit “no stdout after attach” rule; routes user messaging through TUI toasts; confines stderr to pre-attach startup + post-exit summary.
- **P0.4 cancellation/cleanup:** Cooperative cancellation via shared `AbortController` + `registerAdapterShutdown(..., { tuiMode, cancelController })`; acceptance criteria emphasize `finally` cleanup.
- **P1.1 port selection:** Uses `port: 0` (OS-assigned) and exposes `serverUrl` for TUI attach.
- **P1.2 TTY detection:** Requires `stdin.isTTY && stdout.isTTY`.
- **P1.3 flag semantics:** `--quiet` implies `--no-tui`.
- **P2 items:** Always pass `directory: workdir` to `selectSession()`; avoids gate-session deletion/audit concern; adds a stdout-leak regression-test requirement for TUI-active mode.

### Remaining concerns

- **SDK surface confirmation:** Plan assumes `client.tui.showDialog()`/`client.tui.control.*` and `client.permission.*` + reply APIs. Validate early (start of Phase 2/3) and keep the documented fallback for gates if no dialog API exists.
- **Security posture in non-interactive mode:** Treating non-TTY stdin as auto-approve-all (even without `--auto`) avoids hangs but may be a surprising default; consider requiring explicit `--auto`/`--ci`, otherwise fail closed with an actionable message.
- **Output-ownership wording:** Scope “writes nothing to stdout/stderr” to “while TUI active”; ensure stderr writes are guarded on `tuiController.active` to prevent interleaving.

### Updated readiness

- **Plan correctness (v1.2):** ✅ — prior P0/P1 blockers are now concrete and testable.
- **Ready for next phase:** ⚠️ — proceed through Phase 4; treat Phase 5 (TUI human gates) as gated on confirming the TUI dialog/control API surface (fallback exists but should be exercised).

---

## Addendum (2026-02-19) — Remaining concerns addressed (v1.3)

**Reviewed:** `abe12b7` (`docs/development/004-impl-5x-cli-tui.md` v1.3)

### What's addressed (✅)

- **SDK surface confirmation:** Adds an explicit “SDK surface validation” step before Phase 2/3 work, with documented fallback paths if `client.tui.showDialog()` or permission reply APIs are missing.
- **Non-interactive security posture:** Changes default from “non-TTY stdin => auto-approve-all” to fail-closed unless `--auto` or new `--ci` is set, with an actionable error message.
- **Output ownership scoping:** Scopes “write nothing” rule to `tuiController.active === true`, adds explicit stderr guard pattern, and clarifies `onExit` fires after `active` is already false.

### Remaining concerns

- None at the plan level; residual risk is implementation drift vs these contracts (tests should enforce).

### Updated readiness

- **Plan correctness (v1.3):** ✅ — ready to implement.
- **Ready for next phase:** ✅ — proceed to Phase 2; treat the SDK surface validation as the first acceptance gate.

<!-- 5x:structured:v1 eyJzY2hlbWEiOjEsInR5cGUiOiJ2ZXJkaWN0IiwicGhhc2UiOiItMSIsIml0ZXJhdGlvbiI6MCwiZGF0YSI6eyJyZWFkaW5lc3MiOiJub3RfcmVhZHkiLCJpdGVtcyI6W3siaWQiOiJQMC4xIiwidGl0bGUiOiJEZWZpbmUgZGV0ZXJtaW5pc3RpYyBUVUkgaHVtYW4gZ2F0ZSBwcm90b2NvbCAobm8gU1NFIGd1ZXNzd29yaykiLCJhY3Rpb24iOiJodW1hbl9yZXF1aXJlZCIsInJlYXNvbiI6IkN1cnJlbnQgcGxhbiBwcm9wb3NlcyBwYXJzaW5nIHVzZXIgaW50ZW50IGZyb20gZ2VuZXJpYyBTU0Uvc2Vzc2lvbiBpZGxlIGJlaGF2aW9yIHdpdGhvdXQgYSBjb25jcmV0ZSwgdGVzdGFibGUgY29udHJhY3Q7IHRoaXMgY2FuIGhhbmcgb3IgbWlzLXJvdXRlIGluIG5vbi1hdXRvIG1vZGUgYW5kIHJlc3VtZSBmbG93cy4iLCJwcmlvcml0eSI6IlAwIn0seyJpZCI6IlAwLjIiLCJ0aXRsZSI6IlNwZWNpZnkgYW5kIGltcGxlbWVudCBPcGVuQ29kZSB0b29sIHBlcm1pc3Npb24gcG9saWN5IGZvciBUVUkgdnMgaGVhZGxlc3MiLCJhY3Rpb24iOiJodW1hbl9yZXF1aXJlZCIsInJlYXNvbiI6IlBlcm1pc3Npb24gcHJvbXB0cyBjYW4gYmxvY2sgaGVhZGxlc3MvQ0kgaW5kZWZpbml0ZWx5IHVubGVzcyBhbiBleHBsaWNpdCBwb2xpY3kgKyByZXBseSBtZWNoYW5pc20gaXMgZGVmaW5lZDsgcGxhbiBsZWF2ZXMgdGhpcyBhcyBhbiBvcGVuIHF1ZXN0aW9uIGJ1dCBpdCBpbXBhY3RzIGNvcnJlY3RuZXNzLiIsInByaW9yaXR5IjoiUDAifSx7ImlkIjoiUDAuMyIsInRpdGxlIjoiUHJldmVudCBzdGRvdXQgY29ycnVwdGlvbiBvbmNlIG9wZW5jb2RlIFRVSSBvd25zIHRoZSB0ZXJtaW5hbCIsImFjdGlvbiI6Imh1bWFuX3JlcXVpcmVkIiwicmVhc29uIjoiV2l0aCBgb3BlbmNvZGUgYXR0YWNoYCB1c2luZyBgc3RkaW86IGluaGVyaXRgLCBwYXJlbnQgYGNvbnNvbGUubG9nYC9zdGRvdXQgd3JpdGVzIGNhbiBpbnRlcmxlYXZlIGFuZCBicmVhayB0aGUgVFVJOyBwbGFuIG5lZWRzIGV4cGxpY2l0IG91dHB1dC1vd25lcnNoaXAgcnVsZXMgKHRvYXN0IHZzIHN0ZGVyciB2cyBsb2cpLiIsInByaW9yaXR5IjoiUDAifSx7ImlkIjoiUDAuNCIsInRpdGxlIjoiUmVjb25jaWxlIEN0cmwtQy9zaWduYWwgaGFuZGxpbmcgd2l0aCBndWFyYW50ZWVkIGZpbmFsbHkgY2xlYW51cCIsImFjdGlvbiI6Imh1bWFuX3JlcXVpcmVkIiwicmVhc29uIjoiQ3VycmVudCBjb2RlYmFzZSB1c2VzIGBwcm9jZXNzLmV4aXQoLi4uKWAgaW4gc2lnbmFsIGhhbmRsZXJzIChhZGFwdGVyIHNodXRkb3duKSwgd2hpY2ggY2FuIGJ5cGFzcyBhc3luYyBgZmluYWxseWAgY2xlYW51cDsgcGxhbuKAmXMgaW50ZW5kZWQgQ3RybC1DIGZsb3cgaW4gVFVJIG1vZGUgcmVxdWlyZXMgY29vcGVyYXRpdmUgY2FuY2VsbGF0aW9uIGFuZCBkZXRlcm1pbmlzdGljIGNsZWFudXAuIiwicHJpb3JpdHkiOiJQMCJ9LHsiaWQiOiJQMS4xIiwidGl0bGUiOiJVc2UgYHBvcnQ6IDBgIGluc3RlYWQgb2YgYGZpbmRGcmVlUG9ydCgpYCBwcm9iaW5nIiwiYWN0aW9uIjoiYXV0b19maXgiLCJyZWFzb24iOiJPcGVuQ29kZSBDTEkgc3VwcG9ydHMgZXBoZW1lcmFsIHBvcnQgc2VsZWN0aW9uIChgLS1wb3J0IDBgKSwgYW5kIHRoZSBTREsgc2VydmVyIHdyYXBwZXIgcmV0dXJucyB0aGUgcGFyc2VkIFVSTDsgdGhpcyByZW1vdmVzIFRPQ1RPVSBwcm9iZSByYWNlcyBhbmQgcmVkdWNlcyBjb2RlIHN1cmZhY2UuIiwicHJpb3JpdHkiOiJQMSJ9LHsiaWQiOiJQMS4yIiwidGl0bGUiOiJUVUkgbW9kZSBkZXRlY3Rpb24gc2hvdWxkIHJlcXVpcmUgc3RkaW4rc3Rkb3V0IFRUWSIsImFjdGlvbiI6ImF1dG9fZml4IiwicmVhc29uIjoiQSBUVUkgcmVxdWlyZXMgaW50ZXJhY3RpdmUgaW5wdXQ7IGBzdGRvdXQuaXNUVFlgIGFsb25lIGlzIGluc3VmZmljaWVudCAoc3Rkb3V0IFRUWSB3aXRoIHN0ZGluIHJlZGlyZWN0ZWQvcGlwZWQpLiIsInByaW9yaXR5IjoiUDEifSx7ImlkIjoiUDEuMyIsInRpdGxlIjoiRGVjaWRlIHNlbWFudGljcyBmb3IgYC0tcXVpZXRgIHZzIGRlZmF1bHQgVFVJIGF0dGFjaCIsImFjdGlvbiI6Imh1bWFuX3JlcXVpcmVkIiwicmVhc29uIjoiUGxhbiBzYXlzIGAtLXF1aWV0YCBpcyBpZ25vcmVkIGluIFRVSSBtb2RlLCBidXQgZXhpc3RpbmcgQ0xJIHRyZWF0cyBgLS1xdWlldGAgYXMgc3Ryb25nIHVzZXIgaW50ZW50OyBjaG9vc2luZyB3aGV0aGVyIGl0IGltcGxpZXMgYC0tbm8tdHVpYCBpcyBhIFVYL3Byb2R1Y3QgZGVjaXNpb24uIiwicHJpb3JpdHkiOiJQMSJ9XSwic3VtbWFyeSI6IlRoZSBib2x0LW9uIFRVSSBhcHByb2FjaCBpcyB2aWFibGUgYW5kIHRoZSBTREsgc3VwcG9ydHMgdGhlIG5lZWRlZCBgY2xpZW50LnR1aS4qYCBwcmltaXRpdmVzLCBidXQgdGhlIHBsYW4gbmVlZHMgZXhwbGljaXQgZGVjaXNpb25zIGZvciBnYXRlcywgcGVybWlzc2lvbnMsIHNpZ25hbC9jYW5jZWxsYXRpb24sIGFuZCB0ZXJtaW5hbCBvdXRwdXQgb3duZXJzaGlwIHRvIGF2b2lkIGhhbmdzIGFuZCBicm9rZW4gVVguIE9uY2UgdGhvc2UgYXJlIHJlc29sdmVkLCB0aGUgcmVtYWluaW5nIGNoYW5nZXMgYXJlIG1vc3RseSBtZWNoYW5pY2FsIGludGVncmF0aW9uIHdvcmsuIn19 -->
