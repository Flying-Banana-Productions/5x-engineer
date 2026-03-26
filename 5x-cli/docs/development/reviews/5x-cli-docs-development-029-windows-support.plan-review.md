# Review: Windows 10/11 Support (implementation plan)

**Review type:** `5x-cli/docs/development/029-windows-support.plan.md`
**Scope:** Windows support plan — shell execution, home resolution, permission warnings, test infra, and verification steps; cross-check against `5x-cli` sources and related PRD.
**Reviewer:** Staff engineer
**Local verification:** Grep and read of `src/utils/subprocess.ts`, `src/gates/quality.ts`, `src/commands/harness.ts`, `src/harnesses/locations.ts`, `src/commands/run-v1.handler.ts`, `package.json`, `test/integration/lock.test.ts`, `bunfig.toml`, `test/setup.ts`, `src/harnesses/cursor/loader.ts`, `src/utils/stdin.ts`, `docs/027-cursor-harness-native-workflows.prd.md` (lines 95–107)

## Summary

The plan’s core audit matches the codebase: `["sh", "-c", …]` appears only in `subprocess.ts` (line 73) and `quality.ts` (line 245); `harness.ts` passes `process.env.HOME` at lines 54, 66, 95; `locations.ts` uses `homeDir ?? process.env.HOME ?? homedir()` at lines 89, 126, 166; the log-directory permission warning in `run-v1.handler.ts` is at lines 1306–1315; `package.json` `test` script uses bash `unset` at line 41; `lock.test.ts` uses `sleep` at lines 110, 245, 324. There are no `process.platform` checks under `src/` today (claim verified). The centralized `platform.ts` + `shellArgs()` approach is consistent with the stated goal of avoiding scattered branching.

**Phase 3** should be aligned with the repo’s existing `bunfig.toml` preload (`./test/setup.ts`), which already deletes `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE`. The plan text reads as if a new preload file were required; that is redundant with current setup and should be clarified so implementers do not duplicate preload or misunderstand the role of the bash `unset` wrapper relative to hook-inherited `GIT_*` and `cleanGitEnv()` in tests.

The **“Verification”** section’s grep target for `process.env.HOME` is too strict as written: `src/commands/harness.handler.ts` and `src/harnesses/types.ts` document `process.env.HOME` in JSDoc and will still match after the harness CLI changes unless those docs are updated or the plan explicitly lists them.

**Issue 9** (`examples/author-review-loop.sh`) is called out in the audit table but **not** in the Files Changed table — scope is unclear (port vs. document vs. defer).

Minor doc hygiene: graceful-degradation **stdin** references should use `src/utils/stdin.ts` (not bare `stdin.ts`); the PRD line reference for Cursor discovery is correct in substance (`5x-cli/docs/027-cursor-harness-native-workflows.prd.md` §95–107).

**Readiness:** Ready with corrections — implementation direction is sound; update the plan text for Phase 3/preload, verification criteria, HOME-related JSDoc, and example-script scope before coding.

## Strengths

- **Correct problem framing:** Pinpoints the two real `sh -c` spawn sites and ties them to quality gates and shared subprocess helpers.
- **Architecture:** Single `platform.ts` with `shellArgs()` and `os.homedir()` avoids platform checks scattered across call sites.
- **Pragmatic scope:** Explicitly defers “graceful degradation” items (signals, `/dev/tty`, `mode: 0o700`) with a clear rationale.
- **Phasing:** P0 blocking fixes vs. P1/P2 test infra is clear; manual verification on Windows is appropriately scoped.

## Production Readiness Blockers

None — no P0 blockers in the **plan document** itself; blocking issues are correctly described as **implementation** targets.

## High Priority (P1)

### P1.1 — Align Phase 3 with existing test preload

**Risk:** Implementers may add a redundant preload or remove the bash `unset` without validating behavior when `npm test` / `bun test` is invoked from a git hook with `GIT_*` set.

**Requirement:** Clarify in the plan that `bunfig.toml` already preloads `test/setup.ts`, and state whether the `package.json` change is strictly “remove bash-only `unset`” plus any additional cross-platform guarantee (e.g. document reliance on `cleanGitEnv()` for spawns). (`action: auto_fix`)

### P1.2 — Tighten post-change verification for `process.env.HOME`

**Risk:** The plan’s grep step would fail or be misleading unless JSDoc in `harness.handler.ts` / `types.ts` is updated or excluded from the criterion.

**Requirement:** Either list those files for JSDoc updates, or narrow the verification grep to production paths only. (`action: auto_fix`)

## Medium Priority (P2)

- **Example script (Issue 9):** Add `examples/author-review-loop.sh` to Files Changed, or mark it as out-of-scope with a follow-up issue. (`action: human_required`)
- **Path references:** Use `src/utils/stdin.ts` in the audit table for consistency. (`action: auto_fix`)
- **Quality-gate portability:** Users may author bash-specific gates; the plan could add one short bullet that `cmd /c` implies CMD semantics on Windows (mitigation: PowerShell or explicit `sh` from Git for Windows if desired). (`action: human_required` — optional doc note)

## Readiness Checklist

**P0 blockers**
- [x] Core file references and line numbers match the repository (verified March 25, 2026)

**P1 recommended**
- [ ] Phase 3 text reconciled with `bunfig.toml` + `test/setup.ts` (`auto_fix`)
- [ ] Verification grep / JSDoc for `HOME` harmonized (`auto_fix`)

## Addendum

### Re-review (March 25, 2026 — revised plan)

The plan at `029-windows-support.plan.md` was updated per the revision history. Cross-check against prior feedback:

| Prior issue | Status |
|-------------|--------|
| **P1.1 Phase 3 / preload** | **Addressed.** Phase 3 now states that `bunfig.toml` already preloads `./test/setup.ts` (GIT_* cleanup), explicitly forbids a second preload, and describes `package.json` as removing the bash `unset` wrapper while relying on that preload — consistent with this repo’s `bunfig.toml`. |
| **P1.2 HOME verification / JSDoc** | **Addressed.** Verification lists Option A (update JSDoc in `harness.handler.ts` / `types.ts`) or Option B (grep excluding comments / production-only). |
| **P2 example script (Issue 9)** | **Addressed.** Audit marks `examples/author-review-loop.sh` as out of scope; Phase 4 and Known limitations repeat that; Files Changed lists it under “Out of scope (not modified).” |
| **P2 stdin path** | **Addressed.** Graceful-degradation row uses `src/utils/stdin.ts:35-41`. |
| **P2 CMD semantics (optional)** | **Unchanged.** No new bullet on `cmd /c` vs user-authored bash gates; still an optional doc enhancement, not blocking. |

**Assessment:** Prior P1 items are resolved in the plan text. The document is **ready for implementation** with the same overall strengths noted in the initial review. Update the Readiness Checklist P1 rows to `[x]` when tracking this work if desired.
</think>
Removing accidental duplicate content from the addendum.

<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>
Read
