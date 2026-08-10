# Review: Phase 7 upgrade freshness sweep

**Review type:** `9dd5fcf83b3de8210299a3d5058a2417f3d23940`  
**Scope:** Upgrade detection, sync permission/safety gates, scope handling, output, and tests.  
**Reviewer:** Staff engineer (correctness, safety, operability)  
**Local verification:** `bun test test/unit/commands/upgrade.test.ts && bun test test/integration/commands/upgrade.test.ts`; `bunx tsc --noEmit`; `bun run lint` — passed.

**Implementation plan:** `docs/development/plans/201-harness-freshness-plan.md`  
**Technical design:** N/A

## Summary

Phase 7 implements the planned Tier 2 bundled-harness sweep and delegates writes to the established sync core. Permission precedence is independent from safety blockers, retaining report-only defaults and protecting user scope, unverified baselines, and edited assets. Tests cover the required flag, stale, scope, blocker, and output paths.

**Readiness:** Ready — phase acceptance criteria met.

---

## What shipped

- **Upgrade sweep:** Always reports installed bundled harness freshness and coverage caveat.
- **Sync controls:** Adds tri-state `--sync` / `--no-sync` and config-driven `harness.autoSync` permission.
- **Safety:** Permits only lossless project writes; explicit sync only overrides context mismatch.
- **Tests:** Adds integration coverage for default, auto-sync, flags, user scope, blockers, and CLI-version staleness.

---

## Strengths

- Permission and lossless safety are explicitly separated.
- Tier 2 checks prevent writes from incomplete asset evidence.
- Reuses `harnessSyncCore`, preserving existing write and manifest semantics.
- Tests verify no-write behavior by bytes, mtimes, and manifest contents.

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

## Readiness checklist

**P0 blockers**
- [x] None identified.

**P1 recommended**
- [x] None identified.
