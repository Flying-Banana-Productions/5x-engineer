# Review: Windows support — Phase 1 (platform helper)

**Review type:** commit `a7297b25583c5277a2ff7206f8cf1e715c0bb156` (HEAD; no subsequent implementation commits)
**Scope:** Phase 1 deliverable — `src/utils/platform.ts`, plan checkbox update in `029-windows-support.plan.md`
**Reviewer:** Staff engineer
**Local verification:** `bun test --concurrent --dots` — 1729 pass, 1 skip, 0 fail; `bunx @biomejs/biome check src/ test/` — clean

## Summary

The change adds the centralized `shellArgs()` and `userHomeDir()` helpers exactly as specified in the implementation plan, marks Phase 1 complete in the plan, and keeps behavior unchanged for callers because integration is explicitly deferred to Phase 2. Full test suite and Biome checks pass; the new module is currently unused, which is expected for this phase boundary.

**Readiness:** Ready — Phase 1 plan items are satisfied; unblock Phase 2 (wire `subprocess.ts`, `quality.ts`, harness/locations, run-v1 guard).

### Dimensional assessment

| Dimension | Notes |
|-----------|--------|
| **Correctness** | `shellArgs` uses `cmd /c` on `win32` and `sh -c` elsewhere; `userHomeDir` delegates to `os.homedir()` per design. No logic errors in the trivial mapping. |
| **Architecture** | Matches the “single helper, no scattered `process.platform` checks” decision. Call sites remain on legacy paths until Phase 2 — intentional. |
| **Security** | No new attack surface: helpers are not yet invoked; semantics match existing shell-spawn intent once wired. |
| **Performance** | Negligible; one `process.platform` read at module load. |
| **Operability** | No user-visible change until Phase 2; Windows shell behavior still broken for quality gates until callers adopt `shellArgs`. |
| **Test strategy** | No dedicated unit tests for `platform.ts`; acceptable for thin wrappers but small targeted tests in Phase 2 would lock the contract. |
| **Plan compliance** | Phase 1 checklist and embedded snippet are implemented; Phases 2–3 correctly not started. |

## Strengths

- Implementation mirrors the plan’s code block (including `userHomeDir()` naming and `cmd`/`sh` split).
- Keeps platform branching in one module for Phase 2 imports (`./platform.js` as planned).
- Documentation in the plan is updated with a checked Phase 1 item.

## Production Readiness Blockers

None.

## High Priority (P1)

None for Phase 1 scope. (Stale JSDoc on `subprocess.execShell` still describing `sh -c` is expected until Phase 2 — **action:** `auto_fix` when wiring `shellArgs`.)

## Medium Priority (P2)

### P2.1 — Optional unit tests for `platform.ts`

Thin functions, but a tiny table-driven test (mock `process.platform` or assert structure on current OS) would document the contract for future refactors.

- **action:** `auto_fix`

## Readiness Checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [x] None blocking Phase 2 kickoff

## Phase readiness (next phase)

**Assessment:** Proceed to **Phase 2: Fix blocking issues** — replace `["sh", "-c", …]` in `subprocess.ts` and `quality.ts`, switch harness/locations home resolution, and guard the permission-mode warning in `run-v1.handler.ts` per the plan.
