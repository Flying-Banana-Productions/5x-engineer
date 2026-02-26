# Review: 5x CLI — TUI Integration

**Review type:** `5x-cli/docs/development/004-impl-5x-cli-tui.md` (v1.1)  
**Scope:** Add OpenCode TUI as display layer for `5x run` / `5x plan-review` / `5x plan`; randomize OpenCode server port; TUI lifecycle/session focusing; replace readline human gates when TUI owns terminal.  
**Reviewer:** Staff engineer (reliability, UX/DX, operability)  
**Local verification:** Static review; additionally verified `opencode attach --help` supports `--dir` and URL attach.

**Implementation plan:** `5x-cli/docs/development/004-impl-5x-cli-tui.md`  
**Technical design / related docs:** `5x-cli/docs/development/003-impl-5x-cli-opencode.md`, `5x-cli/docs/development/002-impl-realtime-agent-logs.md`; existing code in `5x-cli/src/agents/opencode.ts`, `5x-cli/src/orchestrator/*`, `5x-cli/src/gates/human.ts`.

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

**Reviewed:** `450964c` (`5x-cli/docs/development/004-impl-5x-cli-tui.md` v1.2)

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

**Reviewed:** `abe12b7` (`5x-cli/docs/development/004-impl-5x-cli-tui.md` v1.3)

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

<!-- 5x:structured:v1 eyJzY2hlbWEiOjEsInR5cGUiOiJzdGF0dXMiLCJwaGFzZSI6IjEiLCJpdGVyYXRpb24iOjAsImRhdGEiOnsicmVzdWx0IjoiY29tcGxldGUiLCJjb21taXQiOiI4NWZkMWQwIiwibm90ZXMiOiJQaGFzZSAxIG9mIDAwNC1pbXBsLTV4LWNsaS10dWkgY29tcGxldGUuIEFsbCA0IGNoZWNrbGlzdCBpdGVtcyBpbXBsZW1lbnRlZDpcblxuMS4gYE9wZW5Db2RlQWRhcHRlci5jcmVhdGUoKWAgbm93IHBhc3NlcyBgeyBob3N0bmFtZTogXCIxMjcuMC4wLjFcIiwgcG9ydDogMCwgdGltZW91dDogMTVfMDAwIH1gIHRvIGBjcmVhdGVPcGVuY29kZSgpYCDigJQgT1MgYXNzaWducyBlcGhlbWVyYWwgcG9ydCwgbm8gVE9DVE9VIHJhY2UuXG4yLiBgZ2V0IHNlcnZlclVybCgpOiBzdHJpbmdgIGdldHRlciBhZGRlZCB0byBgT3BlbkNvZGVBZGFwdGVyYCAocmV0dXJucyBgdGhpcy5zZXJ2ZXIudXJsYCkuXG4zLiBgcmVhZG9ubHkgc2VydmVyVXJsOiBzdHJpbmdgIGFkZGVkIHRvIGBBZ2VudEFkYXB0ZXJgIGludGVyZmFjZSBpbiBgdHlwZXMudHNgLlxuNC4gVGVzdHMgYWRkZWQ6IHNlcnZlclVybCBleHBvc3VyZSwgaG9zdG5hbWUvcG9ydCBmb3JtYXQgdmFsaWRhdGlvbiwgcG9ydC1ub3QtNDA5NiBhc3NlcnRpb24uXG5cbk1vY2sgYWRhcHRlcnMgaW4gb3JjaGVzdHJhdG9yIHRlc3RzIHVwZGF0ZWQgdG8gc2F0aXNmeSB0aGUgbmV3IGludGVyZmFjZSBjb250cmFjdC4gQWxsIDM2MyB0ZXN0cyBwYXNzLCB0eXBlY2hlY2sgY2xlYW4sIGxpbnQgY2xlYW4uIE5vIGhhcmRjb2RlZCA0MDk2IHJlZmVyZW5jZXMgcmVtYWluIGluIGFkYXB0ZXIgY29kZS4ifX0 -->

---

## Addendum (2026-02-19) — Implementation review (Phase 1)

**Reviewed:** `85fd1d0` (no follow-on commits)

### What shipped

- **Port randomization**: `OpenCodeAdapter.create()` now passes `{ hostname: "127.0.0.1", port: 0 }` to `createOpencode()` (OS-assigned ephemeral port; no probe/TOCTOU).
- **Server URL surface**: `OpenCodeAdapter.serverUrl` returns `server.url`; `AgentAdapter` contract now includes `readonly serverUrl: string`.
- **Tests**: Adds unit coverage for `serverUrl` shape + non-4096 port assumptions; updates orchestrator mocks for the new adapter interface.
- **Plan compliance**: Phase 1 checklist in `5x-cli/docs/development/004-impl-5x-cli-tui.md` is marked complete.

### Assessment

- **Correctness**: Matches Phase 1 intent; no residual hardcoded `4096` usage in adapter code.
- **Architecture**: Minimal, well-contained surface-area change (getter + interface); mock adapters updated consistently.
- **Security**: Binding explicitly to `127.0.0.1` reduces exposure vs default bind-all; URL exposure is low risk and required for later `opencode attach`.
- **Performance**: No meaningful impact.
- **Operability**: Startup error message remains actionable; `close()` remains idempotent.
- **Test strategy**: Reasonable unit coverage for the new contract; repo tests pass locally.

### Local verification

- `bun test` (in `5x-cli/`): 363 pass, 1 skip, 0 fail

### Remaining concerns

- None for Phase 1. Proceed to Phase 2; treat the plan’s “SDK surface validation” step as the first gate.

### Updated readiness

- **Phase 1 completion:** ✅ — complete and green.
- **Ready for next phase:** ✅ — proceed to Phase 2.

<!-- 5x:structured:v1 eyJzY2hlbWEiOjEsInR5cGUiOiJ2ZXJkaWN0IiwicGhhc2UiOiIxIiwiaXRlcmF0aW9uIjoxLCJkYXRhIjp7InJlYWRpbmVzcyI6InJlYWR5IiwiaXRlbXMiOltdLCJzdW1tYXJ5IjoiQ29tbWl0IDg1ZmQxZDAgY2xlYW5seSBjb21wbGV0ZXMgUGhhc2UgMSAoZXBoZW1lcmFsIHBvcnQgKyBzZXJ2ZXJVcmwgc3VyZmFjZSkgcGVyIHRoZSBwbGFuLCB3aXRoIHBhc3NpbmcgdGVzdHMgYW5kIG5vIGZvbGxvdy1vbiBjb21taXRzLiBSZWFkeSB0byBwcm9jZWVkIHRvIFBoYXNlIDIgKFRVSSBsaWZlY3ljbGUpLCBzdGFydGluZyB3aXRoIHRoZSBwbGFu4oCZcyBTREsgc3VyZmFjZSB2YWxpZGF0aW9uIGdhdGUuIn19 -->

---

## Addendum (2026-02-19) — Implementation review (Phase 2)

**Reviewed:** `ae43cb0` (no follow-on commits)

### What shipped

- **TUI controller**: Adds `5x-cli/src/tui/controller.ts` with a `TuiController` interface, no-op controller, and active controller that spawns `opencode attach <serverUrl> --dir <workdir>` via `Bun.spawn(..., { stdio: inherit })`.
- **TUI detection**: Adds `5x-cli/src/tui/detect.ts` (`stdin.isTTY && stdout.isTTY && !--no-tui && !--quiet`).
- **Command wiring**: Adds `--no-tui` to `5x-cli/src/commands/run.ts`, `5x-cli/src/commands/plan-review.ts`, `5x-cli/src/commands/plan.ts`; spawns TUI and calls `tui.kill()` in `finally`; passes `quiet: effectiveQuiet || tui.active`.
- **SDK validation note**: Documents verified SDK surface at top of `5x-cli/src/tui/controller.ts`.
- **Tests**: Adds `5x-cli/test/tui/controller.test.ts` for controller lifecycle behavior.

### Production readiness blockers

### P0.5 — Headless runs emit a false “TUI exited” warning

**Risk:** In headless mode (`enabled: false`), `TuiController.onExit()` fires immediately and the command layer prints `"TUI exited — continuing headless"` even though no TUI was started.

**Requirement:** `onExit` in headless mode must not trigger “TUI exited” messaging, or the command layer must only register the warning handler when TUI was actually spawned.

**Implementation guidance:** Gate the `tui.onExit(...)` registration on `isTuiMode` (or change the no-op controller `onExit` semantics to a no-op).

---

### P0.6 — TUI mode currently corrupts the terminal and breaks interactive control flows

**Risk:** With the TUI attached (`stdio: inherit`), the parent process continues to write extensively to stdout (and in `plan-review-loop` writes interactive prompts to stdout). This will interleave with and corrupt the TUI display. Additionally, non-auto human gates currently require readline/stdin ownership (Phase 5), which cannot work once the TUI owns the terminal.

**Requirement:** Do not enable TUI for flows that still rely on stdout/readline gates; and enforce “no parent stdout/stderr while `tuiController.active`” as a hard contract.

**Implementation guidance:** Either (a) defer enabling TUI by default until Phase 3–5 land (permissions + cooperative cancellation + TUI gates + output ownership), or (b) complete the missing phases in the same rollout and add regression tests that assert zero parent stdout writes when TUI is active.

---

### P0.7 — Signal handling still uses hard `process.exit()` (cleanup risk in TUI mode)

**Risk:** Existing `registerAdapterShutdown()` installs SIGINT/SIGTERM handlers that call `process.exit(...)`, bypassing async `finally` cleanup. In TUI mode, signal routing is more complex; if SIGINT lands on the parent, this can leak locks/worktrees/server processes.

**Requirement:** Before TUI is enabled by default, implement Phase 3’s cooperative cancellation semantics (exitCode + AbortController + finally cleanup) for TUI mode.

**Implementation guidance:** Update `registerAdapterShutdown(adapter, { tuiMode, cancelController })` per the plan and plumb `signal` into orchestrator loops.

---

## High priority (P1)

### P1.4 — “Continue headless” doesn’t actually restore headless output

The command layer computes `quiet: effectiveQuiet || tui.active` once. If the TUI exits early, `tui.active` flips to false, but the loop stays in `quiet: true`, so headless output remains suppressed. Consider making `quiet` depend on current TUI state (or explicitly re-enable output on TUI exit) if “continue headless” is intended to be visible.

### P1.5 — Missing `opencode` binary handling

`createTuiController()` assumes `opencode` is on PATH; if spawn throws or the process exits immediately, the UX is likely a hard failure instead of the planned Phase 6 fallback (warn + continue headless).

---

## Medium priority (P2)

- **Adapter coupling:** Commands cast `adapter` to `OpenCodeAdapter` to reach `_clientForTui`. If/when other adapters exist, consider formalizing a minimal “tui client surface” on the `AgentAdapter` contract or providing it via the adapter factory.

---

### Updated readiness

- **Phase 2 completion:** ❌ — spawning the TUI without output ownership, gate integration, and updated signal handling makes default TUI mode unsafe/unusable.
- **Ready for next phase:** ⚠️ — proceed, but address P0.5 immediately and treat Phases 3–5 as the real enablement gate for TUI-by-default.

---

## Addendum (2026-02-19) — Phase 2 review fixes closure + follow-on correctness review

**Reviewed:** `bfefdca2c`, `5acfb08`

### What's addressed (✅)

- **P0.5 (spurious headless “TUI exited”)**: Fixed by making the no-op controller `onExit` a true no-op and gating handler registration on `isTuiMode` in `5x-cli/src/commands/run.ts`, `5x-cli/src/commands/plan-review.ts`, `5x-cli/src/commands/plan.ts`.
- **P1.4 (dynamic quiet after TUI exit)**: `quiet` now accepts `boolean | (() => boolean)` in `5x-cli/src/orchestrator/phase-execution-loop.ts` and `5x-cli/src/orchestrator/plan-review-loop.ts`; command layer passes `() => effectiveQuiet || tui.active`.
- **P1.5 (missing `opencode` binary)**: `createTuiController()` catches spawn errors and falls back to headless with a warning; `_spawner` injection makes it testable (`5x-cli/src/tui/controller.ts`).
- **P2 (adapter coupling)**: Called out explicitly as future work in `5x-cli/docs/development/004-impl-5x-cli-tui.md` (tracks the risk intentionally).
- **Correctness (escalation continue)**: Escalation “continue” now resumes the originating state instead of hard-resetting to EXECUTE/REVIEW (`5x-cli/src/orchestrator/phase-execution-loop.ts`, `5x-cli/src/orchestrator/plan-review-loop.ts`).

### Remaining concerns

- **P0.6 still open (output ownership + non-auto incompatibility)**:
  - Command-layer stdout/stderr guards help, but orchestrator loops still print to stdout and agent event formatting can still write unless `quiet` is set consistently across all invocations.
  - `5x-cli/src/commands/plan.ts` still calls `invokeForStatus({ quiet: effectiveQuiet })` (does not include `tui.active`), so TUI mode can still interleave agent output with the attached TUI.
  - TUI remains default-on in any TTY (`5x-cli/src/tui/detect.ts`), including non-`--auto` flows where readline gates are incompatible with a terminal-owning child process. This needs fail-closed behavior (disable TUI) until Phase 5 gates exist.
- **P0.7 still open (signal/cleanup)**: `process.exit()`-based signal handlers remain; Phase 3 cooperative cancellation is still required before TUI-by-default.
- **State-machine nuance (P1)**: In `runPhaseExecutionLoop`, “continue” guidance is stored even when resuming non-EXECUTE states (e.g. REVIEW), so it can leak into a later author prompt unexpectedly.
- **Tests**:
  - The “quiet function form” test asserts plumbing but does not prove re-evaluation across invocations (it never flips the function result between calls).
  - No regression test enforces “no stdout writes while TUI is active” at the orchestrator boundary (needed for Phase 4).

### Updated readiness

- **Phase 2 completion:** ⚠️ — the review fixes are real, but default-on TUI is still unsafe in non-auto flows and output ownership is not enforced end-to-end.
- **Ready for next phase:** ⚠️ — proceed to Phase 3, but treat “TUI opt-in/auto-only gating” and “no stdout while active” as early Phase 3/4 acceptance gates.

---

## Addendum (2026-02-19) — Phase 2 output-ownership closure (stdout quiet-gating)

**Reviewed:** `c8a24ef35`

### What's addressed (✅)

- **P0.6 output ownership**: Orchestrator stdout is now quiet-gated via a local `log()` helper in both loops (`5x-cli/src/orchestrator/phase-execution-loop.ts`, `5x-cli/src/orchestrator/plan-review-loop.ts`). This closes the biggest remaining “parent stdout corrupts TUI” risk for auto-mode TUI runs.
- **P0.6 plan command gap**: `5x-cli/src/commands/plan.ts` now passes `quiet: effectiveQuiet || tui.active` to `invokeForStatus()`, preventing SSE/event formatting from printing while the TUI owns the terminal.
- **Non-auto TUI fail-closed**: `5x-cli/src/tui/detect.ts` now requires `--auto` to enable TUI (explicitly gates off readline-based flows until Phase 5 TUI gates exist). `5x plan` is correctly exempted since it has no human gates.
- **State-machine correctness**: Escalation guidance is only stored when resuming to EXECUTE, preventing stale guidance from leaking into later phases.
- **Tests now actually test stdout silence**: Regression test intercepts `console.log` directly (Bun bypasses `process.stdout.write`), plus a companion sanity test that proves output exists when `quiet=false`.

### Remaining concerns

- **P0.7 still open (signal/cleanup)**: TUI safety is still gated on Phase 3’s cooperative cancellation; `process.exit()`-style signal handlers remain a cleanup risk.
- **Test isolation risk (P1)**: Overriding global `console.log` in tests can be flaky if the runner executes tests concurrently. Prefer a test framework spy/mock if available, or ensure these tests run serially.
- **Coverage gap (P1)**: There is a regression test for `runPhaseExecutionLoop` stdout silence; consider adding the same for `runPlanReviewLoop` so both loops are protected.

### Updated readiness

- **Phase 2 completion:** ✅ — TUI is now safe for `--auto` flows from an output-ownership standpoint (stdout quiet-gated + detector fails closed for non-auto).
- **Ready for next phase:** ⚠️ — proceed to Phase 3; treat signal/cleanup semantics (P0.7) as the next hard production gate.

---

## Addendum (2026-02-19) — Test hardening for quiet-gated stdout (logger DI)

**Reviewed:** `1a7759a35`, `e555d06`

### What's addressed (✅)

- **P1 test isolation risk (global console mutation)**: Closed by adding an injectable `_log` sink to both option types (`5x-cli/src/orchestrator/phase-execution-loop.ts`, `5x-cli/src/orchestrator/plan-review-loop.ts`) and updating tests to assert output via DI rather than overriding `console.log`.
- **Coverage gap**: `5x-cli/test/orchestrator/plan-review-loop.test.ts` now has the same quiet=true/quiet=false regression pair as the phase loop, protecting both loops.
- **Test correctness/maintainability**: Follow-on cleanup removes non-null assertions / `any` casts in the quiet re-eval test via type narrowing (`5x-cli/test/orchestrator/phase-execution-loop.test.ts`).

### Remaining concerns

- **Auto/TUI resume prompting (P0/P1)**: Both loops can still invoke interactive resume gates even in `--auto` mode when an active run exists (run loop via `../gates/human.js`, plan-review loop via `defaultResumeGate`). In TUI mode this can (a) write to stdout/stderr while the child owns the terminal and (b) block on stdin. Before treating TUI auto mode as robust, auto runs should have a deterministic, non-interactive resume policy (e.g. auto-resume, or auto-start-fresh with explicit audit logging).
- **P0.7 still open (signal/cleanup)**: unchanged.

### Updated readiness

- **Phase 2 completion:** ✅ — unchanged.
- **Ready for next phase:** ⚠️ — proceed to Phase 3; include “auto resume policy (no prompts)” alongside cooperative cancellation as early acceptance gates for reliable TUI auto runs.

---

## Addendum (2026-02-19) — Auto-mode resume policy implemented (no interactive gate)

**Reviewed:** `899a4d3`

### What's addressed (✅)

- **Auto/TUI resume prompting (P0/P1)**: Closed. When `auto=true` and no explicit `resumeGate` override is provided, both loops deterministically resume the active run without prompting (`5x-cli/src/orchestrator/phase-execution-loop.ts`, `5x-cli/src/orchestrator/plan-review-loop.ts`). This avoids stdout writes + stdin blocking in TUI/CI.
- **Test coverage**: Adds explicit tests that (a) auto mode resumes without calling a gate and (b) an explicit `resumeGate` override is still honored in auto mode (`5x-cli/test/orchestrator/phase-execution-loop.test.ts`, `5x-cli/test/orchestrator/plan-review-loop.test.ts`).

### Remaining concerns

- **Policy nuance (P1)**: Auto-resume is unconditional for any active run. If a run is “active” but already in a human-required state (e.g. `ESCALATE`), auto-resume will likely just abort again. Consider explicitly documenting/encoding the desired behavior (auto-abort vs auto-start-fresh) to avoid surprising no-progress loops.
- **P0.7 still open (signal/cleanup)**: unchanged.

### Updated readiness

- **Phase 2 completion:** ✅ — auto-mode TUI flows are now non-interactive end-to-end (no resume prompts, stdout quiet-gated).
- **Ready for next phase:** ⚠️ — proceed to Phase 3; cooperative cancellation / no-`process.exit()` cleanup remains the next hard production gate.

---

## Addendum (2026-02-19) — Auto-resume terminal-state guard (start fresh + audit)

**Reviewed:** `ef863465c`

### What's addressed (✅)

- **No-progress loop prevention (P1)**: Auto mode no longer blindly resumes runs stuck in `ESCALATE` or `ABORTED`. Instead it deterministically `start-fresh`, preventing repeated immediate aborts (`5x-cli/src/orchestrator/phase-execution-loop.ts`, `5x-cli/src/orchestrator/plan-review-loop.ts`).
- **Operability/audit trail**: Records an `auto_start_fresh` run event on the old run with a reason string, improving postmortem/debuggability.
- **Tests**: Adds coverage for both loops for ESCALATE and ABORTED cases, including validating the audit event is recorded (`5x-cli/test/orchestrator/phase-execution-loop.test.ts`, `5x-cli/test/orchestrator/plan-review-loop.test.ts`).
- **Plan alignment**: Implementation plan updated to v1.7 describing this policy (`5x-cli/docs/development/004-impl-5x-cli-tui.md`).

### Remaining concerns

- **Policy completeness (P2)**: Other “bad resume” cases can exist (e.g. active run missing context, or stuck on repeated quality failures). This change covers the terminal auto-mode states; consider whether additional states should trigger start-fresh vs resume.
- **P0.7 still open (signal/cleanup)**: unchanged.

### Updated readiness

- **Phase 2 completion:** ✅ — unchanged.
- **Ready for next phase:** ⚠️ — proceed to Phase 3; cooperative cancellation / no-`process.exit()` cleanup remains the next hard production gate.

<!-- 5x:structured:v1 eyJzY2hlbWEiOjEsInR5cGUiOiJzdGF0dXMiLCJwaGFzZSI6IjIiLCJpdGVyYXRpb24iOjAsImRhdGEiOnsicmVzdWx0IjoiY29tcGxldGUiLCJjb21taXQiOiJhZTQzY2IwIiwibm90ZXMiOiJQaGFzZSAyIChUVUkgc3Bhd24gKyBsaWZlY3ljbGUpIGltcGxlbWVudGVkIG9uIGJyYW5jaCBgaW1wbC8wMDQtNXgtY2xpLXR1aWAuXG5cbioqTmV3IGZpbGVzOioqXG4tIGBzcmMvdHVpL2NvbnRyb2xsZXIudHNgIOKAlCBUdWlDb250cm9sbGVyIGludGVyZmFjZSArIGBjcmVhdGVUdWlDb250cm9sbGVyKClgIGZhY3RvcnkuIEFjdGl2ZSBjb250cm9sbGVyIHNwYXducyBgb3BlbmNvZGUgYXR0YWNoIDx1cmw-IC0tZGlyIDx3b3JrZGlyPmAgdmlhIEJ1bi5zcGF3biB3aXRoIHN0ZGlvOiBpbmhlcml0LiBOby1vcCBjb250cm9sbGVyIGZvciBoZWFkbGVzcyBtb2RlIHdpdGggaWRlbnRpY2FsIGludGVyZmFjZS4gU0RLIHN1cmZhY2UgdmFsaWRhdGlvbiBkb2N1bWVudGVkIGF0IGZpbGUgdG9wIHBlciBwbGFuIHJlcXVpcmVtZW50cy5cbi0gYHNyYy90dWkvZGV0ZWN0LnRzYCDigJQgYHNob3VsZEVuYWJsZVR1aSgpYCBpbXBsZW1lbnRpbmcgVFRZIGF1dG8tZGV0ZWN0aW9uIChzdGRpbitzdGRvdXQgVFRZLCAtLW5vLXR1aSwgLS1xdWlldCBmbGFncykuXG4tIGB0ZXN0L3R1aS9jb250cm9sbGVyLnRlc3QudHNgIOKAlCAyNSB0ZXN0cyBjb3ZlcmluZyBuby1vcCBjb250cm9sbGVyIGJlaGF2aW9yLCBhY3RpdmUgY29udHJvbGxlciBsaWZlY3ljbGUgKGFjdGl2ZSBmbGFnLCBzZWxlY3RTZXNzaW9uLCBzaG93VG9hc3QsIG9uRXhpdCBoYW5kbGVycywga2lsbCwgZXJyb3Igc3dhbGxvd2luZykuXG5cbioqTW9kaWZpZWQgZmlsZXM6Kipcbi0gYHNyYy9hZ2VudHMvb3BlbmNvZGUudHNgIOKAlCBBZGRlZCBgX2NsaWVudEZvclR1aWAgZ2V0dGVyIHRvIGV4cG9zZSBTREsgY2xpZW50IGZvciBUVUkgQVBJIGNhbGxzLlxuLSBgc3JjL2NvbW1hbmRzL3J1bi50c2Ag4oCUIEFkZGVkIGAtLW5vLXR1aWAgZmxhZywgVFVJIG1vZGUgZGV0ZWN0aW9uLCBUVUkgc3Bhd24va2lsbCBpbiBsaWZlY3ljbGUuXG4tIGBzcmMvY29tbWFuZHMvcGxhbi1yZXZpZXcudHNgIOKAlCBTYW1lIFRVSSBpbnRlZ3JhdGlvbiBwYXR0ZXJuLlxuLSBgc3JjL2NvbW1hbmRzL3BsYW4udHNgIOKAlCBTYW1lIFRVSSBpbnRlZ3JhdGlvbiBwYXR0ZXJuLlxuLSBgZG9jcy9kZXZlbG9wbWVudC8wMDQtaW1wbC01eC1jbGktdHVpLm1kYCDigJQgQWxsIFBoYXNlIDIgY2hlY2tsaXN0IGl0ZW1zIG1hcmtlZCBbeF0uXG5cbioqU0RLIHZhbGlkYXRpb24gZmluZGluZ3MgKGRvY3VtZW50ZWQgaW4gY29udHJvbGxlci50cyk6Kipcbi0gYGNsaWVudC50dWkuc2hvd1RvYXN0KClgIOKAlCBFWElTVFMsIG1lc3NhZ2UrdmFyaWFudCByZXF1aXJlZFxuLSBgY2xpZW50LnR1aS5zZWxlY3RTZXNzaW9uKClgIOKAlCBFWElTVFMsIHN1cHBvcnRzIGRpcmVjdG9yeSBwYXJhbWV0ZXJcbi0gYGNsaWVudC50dWkuc2hvd0RpYWxvZygpYCDigJQgRE9FUyBOT1QgRVhJU1QgKG5vdGVkIGZvciBQaGFzZSA1IGZhbGxiYWNrKVxuLSBgY2xpZW50LnBlcm1pc3Npb24ucmVwbHkoKWAg4oCUIEVYSVNUUyAocHJlZmVycmVkIG92ZXIgZGVwcmVjYXRlZCAucmVzcG9uZCgpKVxuLSBgY2xpZW50LnR1aS5jb250cm9sLm5leHQoKS8ucmVzcG9uc2UoKWAg4oCUIEVYSVNUUyAoZm9yIFBoYXNlIDUgZ2F0ZSBmYWxsYmFjaylcblxuQWxsIDM4OCB0ZXN0cyBwYXNzICgyNSBuZXcgKyAzNjMgZXhpc3RpbmcpLiBQcmUtY29tbWl0IGhvb2tzIChiaW9tZSBsaW50ICsgdHNjKSBwYXNzZWQuIn19 -->

<!-- 5x:structured:v1 eyJzY2hlbWEiOjEsInR5cGUiOiJ2ZXJkaWN0IiwicGhhc2UiOiIyIiwiaXRlcmF0aW9uIjoxLCJkYXRhIjp7InJlYWRpbmVzcyI6Im5vdF9yZWFkeSIsIml0ZW1zIjpbeyJpZCI6IlAwLjUiLCJ0aXRsZSI6IkhlYWRsZXNzIHJ1bnMgcHJpbnQgZmFsc2UgXCJUVUkgZXhpdGVkXCIgd2FybmluZyIsImFjdGlvbiI6ImF1dG9fZml4IiwicmVhc29uIjoiTm8tb3AgVHVpQ29udHJvbGxlci5vbkV4aXQgZmlyZXMgaW1tZWRpYXRlbHk7IGNvbW1hbmRzIHJlZ2lzdGVyIGFuIG9uRXhpdCBoYW5kbGVyIHVuY29uZGl0aW9uYWxseSBhbmQgZW1pdCBcIlRVSSBleGl0ZWQg4oCUIGNvbnRpbnVpbmcgaGVhZGxlc3NcIiBldmVuIHdoZW4gVFVJIHdhcyBuZXZlciBzdGFydGVkLiIsInByaW9yaXR5IjoiUDAifSx7ImlkIjoiUDAuNiIsInRpdGxlIjoiVFVJIG1vZGUgY29ycnVwdHMgdGVybWluYWwgKyBicmVha3MgaW50ZXJhY3RpdmUgZ2F0ZXMiLCJhY3Rpb24iOiJodW1hbl9yZXF1aXJlZCIsInJlYXNvbiI6Ik9uY2UgYG9wZW5jb2RlIGF0dGFjaGAgb3ducyB0aGUgdGVybWluYWwgKHN0ZGlvIGluaGVyaXQpLCBjdXJyZW50IG9yY2hlc3RyYXRvciBsb29wcyBhbmQgcGxhbi1yZXZpZXcgZ2F0ZXMgc3RpbGwgd3JpdGUgdG8gc3Rkb3V0IGFuZCB1c2UgcmVhZGxpbmUtc3R5bGUgcHJvbXB0cywgd2hpY2ggd2lsbCBpbnRlcmxlYXZlIHdpdGgvY29ycnVwdCB0aGUgVFVJIGFuZCBjYW4gaGFuZyBub24tYXV0byBmbG93cy4gUmVxdWlyZXMgYSBkZWxpYmVyYXRlIHJvbGxvdXQgZGVjaXNpb246IGRpc2FibGUgVFVJIHVudGlsIFBoYXNlcyAz4oCTNSBsYW5kIHZzIGltcGxlbWVudCBvdXRwdXQgb3duZXJzaGlwICsgVFVJIGdhdGVzIG5vdy4iLCJwcmlvcml0eSI6IlAwIn0seyJpZCI6IlAwLjciLCJ0aXRsZSI6IlNpZ25hbCBoYW5kbGluZyBzdGlsbCB1c2VzIHByb2Nlc3MuZXhpdCAoY2xlYW51cCByZWdyZXNzaW9ucyBpbiBUVUkgbW9kZSkiLCJhY3Rpb24iOiJhdXRvX2ZpeCIsInJlYXNvbiI6IkV4aXN0aW5nIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIGNhbGwgYHByb2Nlc3MuZXhpdCguLi4pYCwgYnlwYXNzaW5nIGFzeW5jIGBmaW5hbGx5YCBjbGVhbnVwOyBwbGFuIFBoYXNlIDMgc3BlY2lmaWVzIGNvb3BlcmF0aXZlIGNhbmNlbGxhdGlvbiAoQWJvcnRDb250cm9sbGVyICsgZXhpdENvZGUpIGJ1dCBpdCBpcyBub3QgaW1wbGVtZW50ZWQgd2hpbGUgVFVJIGlzIGVuYWJsZWQuIiwicHJpb3JpdHkiOiJQMCJ9LHsiaWQiOiJQMS40IiwidGl0bGUiOiJcIkNvbnRpbnVlIGhlYWRsZXNzXCIgZG9lcyBub3QgcmVzdG9yZSBoZWFkbGVzcyBvdXRwdXQgYWZ0ZXIgVFVJIGV4aXQiLCJhY3Rpb24iOiJhdXRvX2ZpeCIsInJlYXNvbiI6ImBxdWlldGAgaXMgY29tcHV0ZWQgb25jZSBhcyBgZWZmZWN0aXZlUXVpZXQgfHwgdHVpLmFjdGl2ZWA7IGlmIHRoZSBUVUkgZXhpdHMgZWFybHksIGxvb3BzIHJlbWFpbiBpbiBxdWlldCBtb2RlIGFuZCBtYXkgc3VwcHJlc3MgdGhlIGludGVuZGVkIGhlYWRsZXNzIG91dHB1dCBwYXRoLiIsInByaW9yaXR5IjoiUDEifSx7ImlkIjoiUDEuNSIsInRpdGxlIjoiTm8gZmFsbGJhY2sgaWYgYG9wZW5jb2RlYCBiaW5hcnkgaXMgbWlzc2luZy91bnNwYXduYWJsZSIsImFjdGlvbiI6ImF1dG9fZml4IiwicmVhc29uIjoiYGNyZWF0ZVR1aUNvbnRyb2xsZXIoKWAgYXNzdW1lcyBgb3BlbmNvZGVgIGlzIG9uIFBBVEggYW5kIGRvZXNu4oCZdCBjYXRjaCBzcGF3biBmYWlsdXJlczsgUGhhc2UgNiBleHBlY3RzIGEgd2Fybi1hbmQtZmFsbGJhY2stdG8taGVhZGxlc3MgYmVoYXZpb3IgaW5zdGVhZCBvZiBoYXJkIGZhaWx1cmUuIiwicHJpb3JpdHkiOiJQMSJ9LHsiaWQiOiJQMi4xIiwidGl0bGUiOiJDb21tYW5kIGxheWVyIGRlcGVuZHMgb24gT3BlbkNvZGVBZGFwdGVyIHByaXZhdGUgY2xpZW50IHN1cmZhY2UiLCJhY3Rpb24iOiJodW1hbl9yZXF1aXJlZCIsInJlYXNvbiI6IkNvbW1hbmRzIGNhc3QgYEFnZW50QWRhcHRlcmAgdG8gYE9wZW5Db2RlQWRhcHRlcmAgdG8gYWNjZXNzIGBfY2xpZW50Rm9yVHVpYDsgaWYgYWRkaXRpb25hbCBhZGFwdGVycyBhcmUgaW50cm9kdWNlZCwgZGVjaWRlIHdoZXRoZXIgdG8gZm9ybWFsaXplIGEgbWluaW1hbCBUVUktY2FwYWJsZSBhZGFwdGVyIGludGVyZmFjZSBvciByZWZhY3RvciB0aGUgZmFjdG9yeSB0byBwcm92aWRlIHRoZSBuZWVkZWQgY2xpZW50IHdpdGhvdXQgY2FzdGluZy4iLCJwcmlvcml0eSI6IlAyIn1dLCJzdW1tYXJ5IjoiUmV2aWV3IHdyaXR0ZW4gdG8gYGRvY3MvZGV2ZWxvcG1lbnQvcmV2aWV3cy8yMDI2LTAyLTE5LTAwNC1pbXBsLTV4LWNsaS10dWktcmV2aWV3Lm1kYCBhcyBhIG5ldyBBZGRlbmR1bSBmb3IgUGhhc2UgMi4gVGhlIFBoYXNlIDIgaW1wbGVtZW50YXRpb24gbWF0Y2hlcyB0aGUgcGxhbuKAmXMgd2lyaW5nLCBidXQgZW5hYmxpbmcgVFVJIGF0IHRoaXMgcG9pbnQgaXMgbm90IHNoaXBwYWJsZSBkdWUgdG8gdGVybWluYWwgb3V0cHV0IGludGVybGVhdmluZywgbWlzc2luZyBUVUkgZ2F0ZSBpbnRlZ3JhdGlvbiwgYW5kIHVuc2FmZSBzaWduYWwvY2xlYW51cCBzZW1hbnRpY3MuIn19 -->
