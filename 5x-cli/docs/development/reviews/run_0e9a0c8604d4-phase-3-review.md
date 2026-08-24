# Review: Phase 3 run-scoped resolver wiring

**Review type:** `596cf39d406a3137cff23158bfcc0b0561d77143` and follow-on commits  
**Scope:** Phase 3 ambient run identity wiring for all `--run` command surfaces.  
**Reviewer:** Staff engineer (correctness, reliability, operability, security, tests)  
**Local verification:** `bun run lint` — passed; `bun test` — 2658 passed, 0 failed.

**Implementation plan:** `docs/development/plans/204-run-context-ergonomics-plan.md`  
**Technical design:** `docs/v2/204-run-context-ergonomics.md`

## Summary

The implementation removes parse-time `--run` requirements, resolves ambient identity after control-plane/DB discovery, and preserves the explicit selector and optional no-run paths specified for Phase 3. Required commands now fail closed with `RUN_CONTEXT_REQUIRED`; pipe identity remains lower precedence than environment and pointer resolution. Targeted integration coverage and the full lint/test suite pass.

**Readiness:** `ready` — Phase 3 acceptance criteria are met; no corrections are required.

---

## What shipped

- **Ambient wiring:** Resolver integration across run state/record/complete/reopen/relink/watch, commit, invoke, quality, protocol validation, template rendering, and diff.
- **CLI ergonomics:** `--run` is optional in adapters and help text documents ambient resolution sources.
- **Precedence safety:** Invoke and record retain pipe metadata while passing its run id as the resolver’s lowest-priority source.
- **Tests:** Added handler and integration coverage for pointer/environment identity, missing required identity, `--plan` precedence, and record behavior.

---

## Strengths

- Required handlers consistently resolve identity only after obtaining the control-plane DB.
- Optional quality/diff/template/protocol flows retain a no-run route when no ambient signal is available.
- `run state --plan` intentionally bypasses ambient identity, including a conflicting `FIVEX_RUN`.
- The resolver’s shared worktree predicate eliminates duplicate linked-worktree logic.
- Full repository verification is clean: lint passed and 2,658 tests passed.

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

## Review items

No findings. Therefore no `auto_fix` or `human_required` items apply.

---

## Readiness checklist

**P0 blockers**
- [x] No blocking correctness, security, operability, or Phase 3 compliance findings.

**P1 recommended**
- [x] No follow-up corrections required for Phase 3.
