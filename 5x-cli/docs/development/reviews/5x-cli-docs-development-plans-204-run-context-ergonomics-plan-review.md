# Review: Run-Context Ergonomics — Ambient Identity, Pointer, Composite, Pipe Warning

**Review type:** `docs/development/plans/204-run-context-ergonomics-plan.md`  
**Scope:** Ambient run identity, focus-pointer lifecycle, run-scoped command wiring, `phase finish`, pipe warning, and skill/documentation updates.  
**Reviewer:** Staff engineer (correctness, reliability, idempotency, operability)  
**Local verification:** Not run (static plan and implementation review)

**Implementation plan:** `docs/development/plans/204-run-context-ergonomics-plan.md`  
**Technical design:** `docs/v2/204-run-context-ergonomics.md`

## Summary

The plan is well structured and preserves the important separation between ambient identity discovery and the existing execution-context resolver. It gives unusually complete precedence, compatibility, idempotency, and two-worktree test coverage, and keeps the composite grounded in the existing primitive contracts. Two mechanical corrections are needed before implementation: the pointer path must support the documented absolute `db.path` state directory, and `phase finish` must preserve the protocol command's conditional checklist behavior.

**Readiness:** Ready with corrections — the remaining issues have direct, codebase-derived fixes and do not require a design decision.

---

## Strengths

- **Strict identity model:** Explicit flag, environment, unique worktree mapping, pointer, and pipe precedence is specified clearly, including ambiguity and incompatibility failures rather than guessing.
- **Worktree safety:** Canonical physical-path matching and the rule that a shared pointer cannot cross linked checkouts correctly preserve isolation without adding another registry.
- **Idempotent composite design:** The plan recognizes the existing unique step key, avoids recording failed quality checks, and requires explicit phase and iteration for safe resume.
- **Test strategy:** Unit coverage targets precedence and path aliases, while integration coverage exercises actual shared-DB linked worktrees and stdout/stderr contracts.
- **Compatibility discipline:** Optional no-run commands retain their current behavior, granular commands remain available, and skill changes retain recovery paths.

---

## High priority (P1)

### P1.1 — Resolve the pointer under an absolute configured state directory

**Action:** `auto_fix`

`ControlPlaneResult.stateDir` explicitly supports absolute paths (`src/commands/control-plane.ts:32`, `166-179`), but the proposed `currentRunPath()` unconditionally uses `join(controlPlaneRoot, stateDir, "current-run")` (plan lines 381-386). Node's `join` does not make the later absolute segment replace the preceding root, so an absolute state directory such as `/var/lib/project-state` would incorrectly become `<controlPlaneRoot>/var/lib/project-state/current-run`. The focus pointer would then be written and read outside the actual DB state root, violating the documented configured-state-root behavior.

**Requirement:** Define pointer-path resolution as `join(stateDir, "current-run")` when `stateDir` is absolute, otherwise `join(controlPlaneRoot, stateDir, "current-run")`. Cover both relative and absolute configured `db.path` cases in `run-pointer` tests and lifecycle integration coverage.

---

### P1.2 — Make the checklist sub-step conditional on an author `complete` result

**Action:** `auto_fix`

The existing granular protocol command only invokes `validatePhaseChecklist` for an author result whose `result` is `"complete"` (`src/commands/protocol.handler.ts:376-385`). The composite algorithm instead always evaluates the checklist after protocol success unless validation is disabled or the phase is non-numeric (plan lines 657-660). This changes behavior for valid author outputs such as a non-complete/blocked result: `phase finish` can return `PHASE_CHECKLIST_INCOMPLETE` even though `protocol validate author --record` would not run the checklist. The resume description also lacks a way to retrieve the existing author result before deciding whether the checklist applies.

**Requirement:** Retain the validated result (or parse the existing author step's `result_json` on resume) and run the checklist only when the author result is `complete`. Report checklist as `skipped` when it is inapplicable, and add unit tests for both fresh and resumed non-complete author results.

---

## Medium priority (P2)

- None.

---

## Readiness checklist

**P0 blockers**
- [x] None identified.

**P1 recommended**
- [ ] Make `current-run` path construction honor absolute `stateDir` values and test it.
- [ ] Gate composite checklist validation on an author `complete` result, including resume behavior.

---

## Addendum (2026-08-24) — Protocol metadata recovery review

**Reviewed:** `docs/development/plans/204-run-context-ergonomics-plan.md` version 1.0 (unchanged)

The plan and the referenced control-plane and protocol implementations were re-checked. The original assessment remains valid: both open corrections are directly derivable from existing behavior and require no policy or architectural decision.

### Remaining concerns

- **P1.1 — Absolute configured state directory:** **Action:** `auto_fix`. Make `currentRunPath` use `join(stateDir, "current-run")` when `stateDir` is absolute; otherwise use `join(controlPlaneRoot, stateDir, "current-run")`. Test both configured path forms.
- **P1.2 — Conditional checklist gate:** **Action:** `auto_fix`. Preserve the validated author result (and parse the existing recorded result on resume), then run the checklist only for `result: "complete"`; report it as skipped otherwise. Test fresh and resumed non-complete author results.

### Updated readiness

- **Plan readiness:** ⚠️ — ready with corrections; both remaining items are mechanical `auto_fix` work.
- **Ready for implementation:** ⚠️ — after P1.1 and P1.2 are incorporated into the plan.

---

## Addendum (2026-08-24) — Revision 1.1 re-review

**Reviewed:** `f9f659bb1fb42af9c2f992d91b7ad880558ff64a` — plan version 1.1

### Prior issues

- **P1.1 — Absolute configured state directory:** **Addressed.** The revised `currentRunPath` branches on absolute `stateDir`, requires the init/complete lifecycle to pass it through unchanged, and adds unit plus integration coverage for both path forms.
- **P1.2 — Conditional checklist gate:** **Addressed.** The composite now retains the fresh validated result, reads `result_json` for resumed author steps, runs the checklist only for `result: "complete"`, and covers fresh/resumed non-complete results.

### Remaining concerns

#### P1.3 — Make control-plane database resolution honor absolute `stateDir`

**Action:** `auto_fix`

The pointer fix correctly recognizes that `path.join(controlPlaneRoot, absoluteStateDir, ...)` does not reset to the absolute segment, but the plan still relies on that same broken construction for the database used by the run-scoped commands. `resolveDbContext` currently builds `join(controlPlane.stateDir, DB_FILENAME)` before passing it to `getDb(controlPlaneRoot, ...)` (`src/commands/context.ts`), while several direct handlers do the same. For an absolute configured `db.path`, this opens `<controlPlaneRoot>/<absolute-state-dir-without-leading-slash>/5x.db` rather than the database that `resolveControlPlaneRoot` discovered at `<absolute-state-dir>/5x.db`. The planned absolute-path lifecycle test would therefore initialize/read a shadow DB and cannot validate the intended pointer behavior.

**Requirement:** Add a shared control-plane state-file/DB-path helper that returns `join(stateDir, DB_FILENAME)` for absolute state directories and `join(controlPlaneRoot, stateDir, DB_FILENAME)` otherwise. Use it in `resolveDbContext`, `runV1Init`, and every direct run-scoped handler named in the plan that currently derives a DB path from `controlPlane.stateDir`; add an integration assertion that `run init` and a subsequent run-scoped read use the pre-existing DB in the configured absolute state root and never create the shadow path.

### Updated readiness

- **Plan readiness:** ⚠️ — ready with corrections; P1.3 is a mechanical `auto_fix`.
- **Ready for implementation:** ⚠️ — after P1.3 is incorporated.

---

## Addendum (2026-08-24) — Revision 1.2 re-review

**Reviewed:** `e9b31cf266a4c17f678adcc7ec2a9c82ffa3a96a` — plan version 1.2

### Prior issues

- **P1.1 — Absolute configured state directory:** **Addressed.** `currentRunPath` now delegates to the shared state-root helper and retains relative/absolute coverage.
- **P1.2 — Conditional checklist gate:** **Addressed.** The prior result-aware fresh and resumed checklist semantics and tests remain intact.
- **P1.3 — Absolute `stateDir` DB resolution:** **Addressed.** The plan adds `controlPlaneStatePath` / `controlPlaneDbPath`, applies them to `resolveDbContext`, `runV1Init`, and the direct in-scope run-scoped handlers, and specifies an integration test that pre-creates the real absolute-root database and rejects shadow DB/pointer paths.

### Remaining concerns

- None identified. The revised helper contract, call-site inventory, and absolute-path integration scenario close the prior correctness gap without introducing a conflicting resolution path.

### Updated readiness

- **Plan readiness:** ✅ — ready; no corrections remain.
- **Ready for implementation:** ✅
