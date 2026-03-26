# Review: Windows support — Phase 2 (blocking fixes)

**Review type:** commit `8eba1a4f77d94f6881349cb5f56eca2f7012ee8e`
**Scope:** Phase 2 deliverable per `029-windows-support.plan.md` — `shellArgs` in `subprocess.ts` and `quality.ts`, `homedir()` / locations fallback, permission-mode guard in `run-v1.handler.ts`, JSDoc alignment in `harness.handler.ts` and `types.ts`, plan checklist
**Reviewer:** Staff engineer
**Local verification:** `bun test --concurrent --dots` (from `5x-cli/`) — 1729 pass, 1 skip, 0 fail; `rg '\\["sh",\\s*"-c"' src` — only `src/utils/platform.ts`; `rg 'process\\.env\\.HOME' src` — no matches

## Summary

The commit wires the Phase 1 `shellArgs()` helper into the two shell-spawn call sites that blocked Windows (`subprocess.execShell` and quality-gate command execution), replaces fragile `process.env.HOME` usage with `homedir()` for CLI-passed harness home and simplifies location resolvers to `homeDir ?? homedir()`, and skips the Unix-only permission-bit warning on `win32` so watch mode does not emit spurious stderr. JSDoc now matches implementation. Plan Phase 2 checkboxes are marked complete. Automated verification is green; manual Windows smoke tests from the plan remain the next confidence step before declaring end-to-end Windows readiness.

**Readiness:** Ready — Phase 2 acceptance criteria are met; proceed to Phase 3 (test infrastructure) or parallel manual Windows verification.

### Dimensional assessment

| Dimension | Notes |
|-----------|--------|
| **Correctness** | `shellArgs(command)` preserves prior semantics on non-Windows; on Windows uses `cmd /c` per plan. `homedir()` is the correct canonical home source. Permission check is correctly gated — `stat` mode bits are not portable on Windows. |
| **Architecture** | Platform branching stays centralized in `platform.ts`; call sites import `shellArgs` rather than duplicating `win32` checks. |
| **Security** | Shell execution still runs user-authored commands; no broadening of trust. Home resolution is more reliable on Windows (no `undefined` from missing `HOME`). |
| **Performance** | No meaningful change; one extra import path. |
| **Operability** | Quality gates and `execShell` can run on Windows; harness user scope resolves under `%USERPROFILE%`-equivalent via `homedir()`. Watch log-dir warning noise eliminated on Windows. |
| **Test strategy** | Existing suite covers regressions; no Windows CI in this commit — acceptable for Phase 2 scope. |
| **Plan compliance** | Matches Phase 2 file list and behaviors; plan doc updated with completed checklist lines. |

## Strengths

- End-to-end use of `shellArgs()` at the two P0 spawn sites called out in the audit; `rg` confirms no stray `["sh","-c",…]` outside `platform.ts`.
- Harness CLI and resolver paths consistently use `homedir()`; `process.env.HOME` removed from `src/` production code.
- Permission-mode warning is documented as Unix-only at the call site, avoiding misleading octal modes on Windows.

## Production Readiness Blockers

None for Phase 2 scope.

## High Priority (P1)

### P1.1 — Manual verification on Windows (plan “Verification → Manual”)

**Risk:** Linux-only CI cannot prove `cmd /c` behavior for real quality gates, Cursor harness paths under `%USERPROFILE%`, or IDE discovery.

**Requirement:** Run the manual checklist in `029-windows-support.plan.md` (CLI boot, harness install user/project, quality gate with a simple command, etc.) on a Windows 10/11 machine with Bun + Git for Windows.

## Medium Priority (P2)

- **Phase 3 (separate commit):** `package.json` test script without bash `unset`, `lock.test.ts` sleep replacement — still listed in the plan; not required to approve Phase 2.

## Readiness Checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] Manual Windows smoke tests (before calling the overall Windows initiative “done”)

## Phase readiness (next phase)

**Assessment:** Proceed to **Phase 3: Test infrastructure** per plan, and schedule **manual Windows verification** when a Windows host is available.
