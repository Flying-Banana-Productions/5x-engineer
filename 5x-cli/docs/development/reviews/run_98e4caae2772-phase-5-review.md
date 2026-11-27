# Review: OpenCode 2.x documentation and final verification

**Review type:** Implementation commit `abc52ae820fdcdb032664262fbdd3ccb635267be`  
**Scope:** Phase 5 documentation, release notes and final verification  
**Reviewer:** Staff engineer  
**Local verification:** `git diff --check a76a718..abc52ae` passed; `opencode --version` reported `opencode v2.4.2`. Inspected the author command outputs and phase-finish journal; did not rerun the full or live suites.

## Review Context

- Phase / review kind: 5; initial material pass; enforced.
- Reviewed range: `a76a718a1196a7d54526134dd5b95dfa2f2fa3a6..abc52ae820fdcdb032664262fbdd3ccb635267be` (complete context-specified diff).
- Binding: `d175e674-cbdd-4fff-90f3-93619ffe02fc`; review context: `bbf05f94-8bf4-4587-91ae-c12a54bef378`.
- Effective plan revision: `amendment:9284200c43a9379afe49ff0d13d65fc0ec48fb249895d2143fd368b110da089e`. No due claims or required prior outcomes.

## Summary

The phase changes only documentation and plan checkboxes, apart from workflow-generated records. The upgrade order, minimum version, harness refresh, private server isolation, busy/ambiguous turn errors, TUI removal, and doctor check are covered. The harness README already states the OpenCode 2.x requirement, and AGENTS.md is unchanged in this range.

**Readiness:** Ready with corrections — verification passed; three documentation corrections are needed. No production-code or approved-plan change is needed for them.

## Strengths

- Author logs show lint, typecheck, build, 4,490 full-suite passes, and 61 passes in the AGENTS.md acceptance suite. The phase-finish journal independently reports lint and the full suite passing at the reviewed commit.
- The opted-in provider suite ran at `opencode v2.4.2` (matches `MIN_OPENCODE_VERSION`) with `opencode/big-pickle`: 5 passed, 0 failed, 0 skipped. Its raw observer connected before prompts and remained live through the deny execution's `session.execution.succeeded`. The control emitted the matching `question` form; the deny arm ended in provider `done` with no error, `question` call, or form.
- The seeded temp project explicitly selected `opencode` for both roles. The password-protected server reported the four installed agents with their expected permissions and all eight 5x skills, with no ignored-agent-field log. The installed orchestrator produced two separately validated completion payloads from a single reviewer child using `sessionID` continuation. The child had the `subagent` deny rule and made no nested delegation.
- Both modes streamed author output and returned valid `AuthorStatus` results. Both unrecorded reviewer invocations exited zero with CLI-validated verdicts and distinct review files. The fixture used budget mode off, so the v1 verdict fields were sufficient. The run had no recorded reviewer step, no managed server child remained, the external test server still answered HTTP 200, and removing the password caused the expected error. Doctor reported no OpenCode finding at 2.4.2 and `opencode-outdated` with the major-upgrade hint at fake 1.2.3.

## Medium Priority (P2)

### P2.1 — Describe timeout and cancellation as evidence-dependent cleanup

**Classification:** `implementation_defect`, `auto_fix`; approved work item `W6`.

`docs/configuration.md` says the turn cancels the queued prompt and managed mode interrupts the running execution; the CHANGELOG also says cancellation removes the queued prompt. In `src/providers/opencode.ts`, exact-ID cancellation is an attempt, and managed session interruption is attempted only after evidence of delivery. If the outcome is unresolved, neither mode interrupts and the prompt may still be queued or run. The external left-running note is for confirmed delivery. Revise both documents to preserve these distinctions so operators do not mistake the timeout or cancellation error for a guarantee that their work stopped.

### P2.2 — Explain when external authentication is required and where to set the environment variable

**Classification:** `implementation_defect`, `auto_fix`; approved work item `W6`.

`docs/configuration.md` and `docs/upgrading.md` describe all external OpenCode 2.x servers as password-protected, while the approved plan explicitly covers an unprotected server and `OpenCodeProvider.createExternal()` sends no Authorization header when no password is supplied. The CHANGELOG also attributes the environment fallback to the server rather than the invoking 5x process. Qualify the instructions for password-protected servers and say that 5x reads the credentials in its own process, retaining the existing variable order and missing-password diagnostic.

### P2.3 — Distinguish internal provider exports from package-root exports

**Classification:** `implementation_defect`, `auto_fix`; approved work item `W6`.

The CHANGELOG lists the event mapper, listen parser, factory dependency type and structured-output helpers as exports without identifying their module. `package.json` exposes only the package root (`src/index.ts`), which exports `MIN_OPENCODE_VERSION` and `OpenCodeProvider` but not those helpers. The helpers are exported through the internal provider barrel. Identify the boundary in the release note so consumers do not try imports that the package does not support. Do not change the package exports.

## Nonblocking follow-ups

- **PR handoff:** No PR was opened or pushed in this review. Copy the full verification summary above and the exact `opencode --version` output (`opencode v2.4.2`) into the future PR description, including the live question comparison and installed delegation transcript summary. The implementation commit message also records these results.
- **Operator warning:** The informational plan header still says the Phase 2 amendment is pending review. It does not supersede the registered amendment in the bound review context; do not read it as a requirement to reopen approval.

## Addendum (2026-11-27) — Phase 5 closure

**Reviewed range / context:** `abc52ae820fdcdb032664262fbdd3ccb635267be..9be9318c60430217372ab5e52f00143f60e537b1`; context `e8a29cd0-d8fb-473a-9df4-8a96bdb354ac`. Reviewed the complete recorded diff. The effective plan and runtime code are unchanged in this range.

### Prior-finding outcomes

| Finding ID | Outcome | Evidence |
|---|---|---|
| P2.1 | Addressed | `docs/configuration.md:133–147` and `CHANGELOG.md:59–66` present exact-ID cancellation as an attempt, distinguish confirmed delivery from unresolved cleanup, and limit interruption to a managed private server after delivery. External sessions are never interrupted. |
| P2.2 | Addressed | `docs/configuration.md:102–110`, `docs/upgrading.md:49–52`, and `CHANGELOG.md:24–31` state that the invoking 5x process needs credentials for a protected server. The configuration guide and changelog retain the fallback and missing-password message, and explain that an unprotected server can work without credentials. |
| P2.3 | Addressed | `CHANGELOG.md:39–52` identifies the package-root `OpenCodeProvider` and `MIN_OPENCODE_VERSION` exports and separately identifies the mapper and helpers as internal exports, consistent with `package.json`, `src/index.ts`, and `src/providers/index.ts`. |

### Updated readiness and credit realization

**Readiness:** Ready. All three findings are addressed and the revision introduced no new blocker. No credit claims are due.

The iteration-1 phase-finish journal records lint and the full test suite passing at `9be9318c` (4,490 passed, zero failed). The whitespace check on the three revised product documents passed. The prior typecheck, build, 61-test acceptance suite, live provider suite (5 passed, zero skipped, including the complete headless `question` comparison), and temp-project checks still apply: the correction changed no runtime code, harness assets, or tests. I verified the recorded evidence rather than rerunning the live exercise.

### Nonblocking follow-ups

- Delivery is evidence that execution began, not proof it is still active when cleanup runs. The parenthetical “its execution is running” in the configuration guide could be dropped for precision; the stated interrupt-attempt and no-interrupt rules are correct.
- Carry forward the initial review’s verification summary and exact `opencode --version` output (`opencode v2.4.2`) to the future PR description, including the live comparison and installed orchestrator delegation/continuation evidence. No push or PR was performed.
