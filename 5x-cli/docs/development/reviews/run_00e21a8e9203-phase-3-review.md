# Review: Prompt Queue Foundation — Phase 3 Doctor Prompts

**Review type:** `3e2b928360190c2c4b84dcf568c645dcc6edbb29`  
**Scope:** Orphaned open-prompt doctor detection, deterministic remediation, registry identity, and Phase 3 tests.  
**Reviewer:** Staff engineer (correctness, reliability, security, operability, testing, plan compliance)  
**Local verification:** `bun test test/unit/ --concurrent` (2086 pass); `bun test test/integration/ --concurrent` (654 pass)

**Implementation plan:** `docs/development/plans/205-prompt-queue-foundation-plan.md`  
**Technical design:** `docs/v2/202-control-plane.md`

## Summary

Phase 3 correctly adds a read-only orphan-prompt check, a CAS-based deterministic repair, and prompt-specific finding identity. Detection excludes standalone and closed prompts, reports missing/completed/aborted runs, and revalidates the prompt and run before mutation. The implementation follows the control-plane abstraction and safely closes database connections; test coverage includes detection, repair races, registry identity, and healthy CLI registration.

**Readiness:** Ready — Phase 3 completion criteria are met with no blocking findings.

---

## What shipped

- **Doctor prompts check:** Detects open prompts associated with missing or terminal runs and emits actionable `PROMPT_ORPHANED` findings.
- **Deterministic repair:** Revalidates and CAS-abandons only still-open orphaned prompts using `run-terminal`.
- **Doctor registry:** Registers the check last and keys fixable prompt findings by `detail.promptId`.
- **Coverage:** Adds focused unit coverage and updates healthy-doctor integration expectations.

---

## Strengths

- Detection uses a read-only connection and does not create or migrate a missing database.
- Repair rechecks both prompt openness and run terminality before the CAS write, preserving the detect/fix/re-detect contract.
- `findingKey` prevents multiple prompt findings from collapsing to a code-only identity.
- Failure to read the prompt database is surfaced as a non-fixable, diagnosable finding rather than crashing the doctor sweep.
- Unit and integration suites pass under concurrent execution.

---

## Production readiness blockers

None.

---

## High priority (P1)

None.

---

## Medium priority (P2)

None.

---

## Finding classification

- **auto_fix:** None.
- **human_required:** None.

---

## Readiness checklist

**P0 blockers**
- [x] Orphaned prompts are detected and safely abandoned only after revalidation.

**P1 recommended**
- [x] Registry identity distinguishes individual prompt findings.
