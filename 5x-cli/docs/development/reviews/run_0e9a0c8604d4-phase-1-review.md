# Review: Phase 1 ambient identity resolver

**Review type:** `afde2d648bcb0d08b9fe040333a8c59e627b15aa`  
**Scope:** Phase 1 ambient run identity resolution, focus-pointer helpers, and state-path exports.  
**Reviewer:** Staff engineer (correctness, reliability, security, operability)  
**Local verification:** `bun test test/unit/commands/run-identity.test.ts` (20 pass); `bun test test/unit/` (2000 pass); `bun run lint` (pass)

**Implementation plan:** `docs/development/plans/204-run-context-ergonomics-plan.md`  
**Technical design:** `docs/v2/204-run-context-ergonomics.md`

## Summary

The implementation adds a standalone ambient identity resolver with the specified flag, environment, linked-worktree, pointer, pipe, and absent-context ordering. Pointer compatibility and stale/invalid cases fail closed, canonical worktree comparisons are delegated to the existing path and plan helpers, and the new state-path helper correctly preserves absolute configured state roots. The Phase 1 unit coverage exercises the planned precedence, ambiguity, canonicalization, pointer, and required-versus-optional cases.

**Readiness:** Ready — Phase 1 acceptance criteria are met with no blocking findings.

---

## What shipped

- **Ambient identity resolver:** Resolves run identity without changing command adapters.
- **Focus pointer utilities:** Provides read, write, and conditional-clear operations at the control-plane state root.
- **State-path helpers:** Exports DB and general state-file path construction that handles absolute state directories.
- **Unit coverage:** Adds resolver precedence, error, symlink, nested-root, and absolute-state-path tests.

---

## Strengths

- Strict resolution ordering prevents a lower-priority pointer or pipe value from overriding explicit session intent.
- Ambiguous linked-worktree mappings and incompatible pointers return explicit remediation instead of guessing.
- Pointer validation requires an active known run, while explicit and environment selection retain the intended terminal-run behavior.
- Canonical path handling reuses the existing worktree-plan lookup and realpath behavior.
- Focus-pointer I/O is small, synchronous, and correctly treats a missing pointer as a no-op.

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
- [x] No production readiness blockers identified.

**P1 recommended**
- [x] No pre-rollout corrections identified.
