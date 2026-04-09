# Review: Mixed-mode delegation Phase 4 stale-agent cleanup

**Review type:** commit `78612b1cf563010c65d43f02445d3de4ff1eb142`
**Scope:** Phase 4 follow-up for stale agent cleanup during harness reinstall in OpenCode and Cursor
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/harnesses test/integration/commands/harness.test.ts` ✅; targeted repro via `bun -e` calling `removeStaleAgentFiles()` confirmed unrelated `custom.md` is deleted

## Summary

The follow-up closes the original stale-asset gap for managed 5x agent files, but the cleanup implementation is too broad: reinstall now deletes any `.md` file in the harness agents directory that is not in the current keep-set. In shared agent directories, that can remove user-authored or third-party agent profiles during a normal `harness install --force` transition.

**Readiness:** Not ready — install path can delete unrelated agent files outside 5x ownership.

## Strengths

- Fix is small and aligned with Phase 4 intent: stale managed assets are considered during reinstall, not only uninstall.
- Existing mixed-mode lifecycle integration tests still pass, so the intended native→invoke transition path remains covered for 5x-managed files.

## Production Readiness Blockers

### P0.1 — Stale cleanup deletes non-5x agent files

**Risk:** Reinstall can silently remove user-created or third-party agent profiles from the shared harness agents directory, causing data loss and breaking unrelated tooling.

**Requirement:** Restrict stale cleanup to 5x-managed agent filenames only (e.g. from `listAgentTemplates()` / static bundled inventory), and add regression coverage proving unrelated files in the agents directory survive reinstall across delegation-mode transitions.

## High Priority (P1)

- None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [ ] Limit stale-agent deletion to 5x-managed agent files only.
- [ ] Add regression tests covering preservation of non-5x `.md` files in the agents directory.

**P1 recommended**
- [ ] None.
