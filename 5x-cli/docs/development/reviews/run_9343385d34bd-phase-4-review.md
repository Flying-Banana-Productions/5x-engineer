# Review: Git-native run records — Phase 4

**Review type:** `d85497a9ee039179532fb3dc3ede6fe8eb2654e6` (including follow-ons through `HEAD`)  
**Scope:** Phase 4 dual-write, worktree-rooted records, origin attribution/redaction, prompt decisions, commit staging, safety exemption, and sealing.  
**Reviewer:** Staff engineer (correctness, durability, security, operability)  
**Local verification:** Targeted Phase 4 unit and integration suites: 212 pass, 0 fail. `git diff --check` passes.

**Implementation plan:** `docs/development/plans/212-git-native-run-records-plan.md`

## Summary

The implementation establishes the intended record-first writer, re-roots records for linked worktrees, stamps live origins through the shared context factory, and covers seal ordering and attribution with substantial tests. It is not ready because the dirty-tree exemption cannot match real Git paths: the repository root returned by Git retains its trailing newline before absolute-path matching. Consequently, record-only dirt still blocks a subsequent `run init`, violating the Phase 4 completion gate.

**Readiness:** Not ready — correct the safety-exemption root normalization and add a real-git regression test.

---

## What shipped

- **Record writer/context:** Working-tree `RecordStore` wiring, redacted recorder/origin factory, record-first SQLite projection, and human decision snapshots.
- **Worktree and staging:** Canonical records-root resolution plus record staging for `5x commit --files`.
- **Sealing:** Future-format preflight, terminal record/seal summary, and records-only seal commit.
- **Attribution:** Explicit invoke/protocol agent performers and redaction coverage.

---

## Strengths

- The record context consistently re-roots the store to the run effective worktree rather than the control-plane checkout.
- Terminal completion checks a newer summary before terminal-step mutation and performs the seal commit before SQLite completion.
- `originFor` and `redactedRecorder` centralize attribution and avoid Git/host identity leakage.
- The targeted unit and integration suites exercise worktree, seal, protocol/invoke performer, and redaction scenarios.

---

## Production readiness blockers

### P0.1 — Records dirty-tree exemption never matches in a real repository

**Risk:** `checkGitSafety` uses the raw stdout of `git rev-parse --show-toplevel` as `repoRoot`. Git terminates that output with a newline, so `resolve(repoRoot, porcelainPath)` produces a path rooted at (for example) `/repo\n/...`, which is not under the canonical exempt records root. A repository containing only uncommitted run-record files is therefore reported dirty and `run init` fails, defeating the required path-scoped exemption and obstructing normal record/commit workflows.

**Requirement:** Normalize the Git top-level path before resolving porcelain paths and returning it (for example, trim the `rev-parse` stdout). Add a non-mocked, temporary-git-repository regression that creates only an uncommitted records-root file and verifies `checkGitSafety(..., { exemptRoots })` is safe; retain the mixed dirty-path case.

**Location:** `src/git.ts:125, 105-106`

---

## Readiness checklist

**P0 blockers**
- [ ] Normalize `repoRoot` and demonstrate real-Git records-root exemption behavior.

**P1 recommended**
- [x] Targeted Phase 4 test suites pass.

---

## Addendum (2026-09-03) — Safety-exemption follow-up

**Reviewed:** `e2102e6a08ef7105e06b83fcb66ad00e44f61fdd`

### What's addressed (✅)
- **P0.1 — Records dirty-tree exemption:** `checkGitSafety` now normalizes `git rev-parse --show-toplevel` output before using it as an absolute-path base. It also requests individual untracked files, preventing Git's collapsed untracked-directory entry from defeating a path-scoped exemption.
- **Regression coverage:** A real temporary Git repository confirms the newline-bearing top-level output, records-only exemption, correct returned root, and rejection of a mixed non-record dirty path. The focused unit and integration tests pass (62 tests, 0 failures).

### Remaining concerns
- None in the follow-up diff.

### Updated readiness
- **Phase 4 safety exemption:** ✅ — the prior blocker is resolved without weakening non-record dirty-path detection.
- **Ready for next phase:** ✅
