# Review: 203 recovery and doctor — Phase 1

**Review type:** `c3cfcf19d62cc85ec45994d389082ef3ebbd9006` and `41d957d0d1f8253f1e4682d077d30ad390e2b84e`  
**Scope:** Lock inventory and unlock CLI surface, enriched `PLAN_LOCKED` detail, and the macOS path-containment follow-on.  
**Reviewer:** Staff engineer (correctness, security, reliability, operability, and tests)  
**Local verification:** `bun test --concurrent` — 2479 passed, 8 skipped, 0 failed; focused Phase 1 unit/integration suites also passed.

**Implementation plan:** `docs/development/plans/203-recovery-and-doctor-plan.md` (Phase 1)

## Summary

Phase 1 delivers the planned exported lock inventory/inspection/removal primitives, `lock list` and top-level `unlock` commands, and additive holder/remediation details at all three `PLAN_LOCKED` sites. Lock cleanup remains confined to a direct lock-directory child and revalidates corruption before unlinking; live holders require explicit force and expose the displaced holder. The follow-on broadly replaces lexical containment with realpath-aware containment and is directionally correct and test-backed, but its helper does not implement its documented longest-existing-prefix behavior for paths with more than one missing component.

**Readiness:** Ready with corrections — no Phase 1 blocker remains; make the containment helper complete before relying on the broad follow-on as the general macOS path fix.

---

## What shipped

- **Lock primitives:** `listLocks`, `inspectLock`, and confined `removeCorruptLock`, re-exported from the public index.
- **CLI recovery surface:** JSON/text `5x lock list` and top-level `5x unlock <plan> [--force]` with stale/corrupt/live behavior aligned to the plan.
- **Run diagnostics:** Additive `holder`, `stale`, and actionable remediation in init, complete, and reopen lock failures.
- **Path containment follow-on:** Shared realpath-aware containment used in affected config, run, init, plan, and control-plane flows.

---

## Strengths

- The lock listing deliberately preserves corrupt entries rather than inheriting `isLocked`'s concealment of them.
- `removeCorruptLock` rejects escapes and nested children, then re-reads before deletion, preserving its path-addressed safety boundary.
- Unlock refusal and force output carry the exact holder data operators need to make an informed recovery decision.
- The `PLAN_LOCKED` shape is additive, retaining compatibility fields while supplying the new nested holder and remediation contract.
- Full concurrent tests and focused command tests pass; the macOS alias test exercises `/var`/`/private/var` where applicable.

---

## Medium priority (P2)

- **P2.1 — Complete longest-existing-prefix canonicalization** (`auto_fix`): `realpathExisting()` only realpaths the target or its immediate parent. For an in-repository target with two or more missing components (for example an absolute `/var/.../repo/new/subproject` alias when `new` does not yet exist), it returns the unresolved `/var` spelling rather than the documented longest existing `/private/var` prefix, and `isPathUnder` can still false-reject it. Walk ancestors until an existing prefix is found, append all missing suffix components, and add a nested-missing-component alias test. `src/paths.ts:27-39`

---

## Readiness checklist

**P0 blockers**
- [x] None identified.

**P1 recommended**
- [x] None identified.

**P2 follow-up**
- [ ] P2.1 (`auto_fix`): canonicalize through the actual longest existing prefix and cover nested missing paths.

## Issue classification

| Issue | Action |
|---|---|
| P2.1 longest-existing-prefix gap | `auto_fix` |

**Human-required issues:** None.
