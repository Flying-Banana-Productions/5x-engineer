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
