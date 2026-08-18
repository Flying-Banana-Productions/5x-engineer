# Review: 203 recovery and doctor — Phase 4

**Reviewed commit:** `fb23b4069b9059d7c2ad787341ef8109fb284645`  
**Plan:** `docs/development/plans/203-recovery-and-doctor-plan.md` (Phase 4)

## Summary

The registry/types, identity keys, diagnostic success envelope, text formatter, exit semantics, and detect→fix→re-detect behavior are implemented and the focused doctor tests plus lint pass. However, a repair exception escapes the handler, aborting the doctor sweep instead of producing a `CHECK_FAILED` finding. This violates the safe per-check isolation required for the registry and can prevent the report from being emitted.

## Readiness

Not ready — one P1 auto-fix is required.

## Items

- **P1 — Isolate exceptions from `DoctorCheck.fix`** (`auto_fix`; `human_required: false`): `await check.fix(candidate, ctx)` is outside a `try/catch`. A failed deterministic repair (for example an unlink, sync, or database write error) rejects `doctorRun`, so later checks do not run and no successful diagnostic envelope/report is output. Catch repair failures, append `checkFailedFinding(check.id, err)`, retain/report the current findings consistently, and continue with sibling checks. Add a unit test whose fix throws and asserts `CHECK_FAILED`, retained detection, sibling execution, and the diagnostic exit/report behavior. `src/commands/doctor.handler.ts:143`

## Verification

- `bun run lint` — passed.
- `bun test test/unit/doctor/` — 32 passed, 0 failed.
- `git diff --check fb23b4069b9059d7c2ad787341ef8109fb284645^ fb23b4069b9059d7c2ad787341ef8109fb284645` — passed.
