# Review: Windows support — Phase 3 (test infrastructure)

**Review type:** commit `646997ef4345262f91a52051f89aa64b19252f4f`
**Scope:** Phase 3 deliverable per `029-windows-support.plan.md` — cross-platform `package.json` test script (remove bash `unset` wrapper), `lock.test.ts` long-running subprocess via `bun -e` + `Bun.sleep` instead of `sleep`, plan checklist updates
**Reviewer:** Staff engineer
**Local verification:** `bun test --concurrent --dots` (from `5x-cli/`) — 1729 pass, 1 skip, 0 fail

## Summary

The commit removes a POSIX-shell–only `test` script wrapper so `bun run test` works under Windows and other environments that do not execute the prior `(unset …; …)` subshell the same way. Integration lock tests no longer depend on a `sleep` binary (absent or nonstandard on typical Windows shells), using a Bun subprocess that sleeps in-process instead. `029-windows-support.plan.md` Phase 3 checkboxes match the delivered changes. The suite passes locally; this is appropriate scope for Phase 3.

**Readiness:** Ready — Phase 3 acceptance criteria are met; continue with later plan phases and manual Windows verification when available.

### Dimensional assessment

| Dimension | Notes |
|-----------|--------|
| **Correctness** | `lock.test.ts` still uses `env: cleanGitEnv()` on the spawned children; behavior matches the prior “hold PID alive” intent. `bun -e "await Bun.sleep(60000)"` is valid for the Bun test runner. |
| **Architecture** | Test script stays a single Bun invocation; no new abstraction layers. Aligns with existing `bunfig.toml` preload + `test/setup.ts` + `cleanGitEnv()` pattern documented for `GIT_*` hygiene. |
| **Security** | No change to trust boundaries; subprocess remains a test-only helper. |
| **Performance** | Same 60s nominal sleep duration; no hot-path impact. |
| **Operability** | `npm run test` / `bun run test` no longer requires bash `unset`; lock tests runnable where `sleep` is unavailable. |
| **Test strategy** | Full integration/unit suite green; cross-platform ergonomics improved without skipping coverage. |
| **Plan compliance** | Plan Phase 3 lines marked complete; implementation matches stated items. |

## Strengths

- **`package.json`:** Drops bash-specific `unset` while relying on established preload + `cleanGitEnv()` discipline already described in `test/setup.ts` and `test/helpers/clean-env.ts`.
- **`lock.test.ts`:** Three call sites updated consistently; subprocess remains a real PID for lock ownership tests without relying on coreutils `sleep`.
- **Plan doc:** Checklist entries are concrete and traceable to files.

## Production Readiness Blockers

None for Phase 3 scope.

## High Priority (P1)

### P1.1 — Manual verification on Windows (plan “Verification → Manual”)

**Risk:** Linux CI alone does not prove `bun run test` from cmd/PowerShell, or `bun`/`git` on PATH behavior for the new spawn pattern.

**Requirement:** Run the manual checklist in `029-windows-support.plan.md` on Windows 10/11 when possible.

## Medium Priority (P2)

- **Docs vs. behavior:** `test/setup.ts` notes that `delete process.env.*` may not clear C-level env for children; the codebase already requires `cleanGitEnv()` on spawns. If any future test omits that, removing the shell-level `unset` offers less belt-and-suspenders—acceptable if contributors follow the helper; no action required for this commit if the suite stays green under hook environments.

## Readiness Checklist

**P0 blockers**
- [x] None

**P1 recommended**
- [ ] Manual Windows smoke tests (before calling the overall Windows initiative “done”)

## Phase readiness (next phase)

**Assessment:** Phase 3 test infrastructure is complete per plan; proceed to subsequent `029-windows-support.plan.md` phases and parallel manual Windows verification as capacity allows.
