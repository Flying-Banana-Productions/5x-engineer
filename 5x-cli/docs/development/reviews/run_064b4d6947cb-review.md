# Review: Cursor Harness Phase 1 — optional harness rule support

**Review type:** commit `d678d275b90fcefd69f99a7c5c7583614f560ce1`
**Scope:** Phase 1 changes for optional harness rule support in shared harness framework
**Reviewer:** Staff engineer
**Local verification:** `bun test test/unit/harnesses/installer.test.ts test/unit/commands/harness.test.ts` ✅, `bun test test/integration/commands/harness.test.ts test/integration/commands/harness-universal.test.ts test/integration/commands/text-output.test.ts` ✅

## Summary

Phase 1 is complete. The change cleanly extends the harness contract with optional rule support, keeps existing harnesses source-compatible, and adds solid unit/integration coverage around the new list/install surface.

**Readiness:** Ready — Phase 1 completion gate met; no blocking correctness, architecture, or operability gaps found.

## Strengths

- Rule support is added as optional contract surface (`rulesDir`, `ruleNames`, `capabilities`, `unsupported`, `warnings`) without forcing churn through existing harness implementations.
- The list path now uses scope-aware `describe(scope)` metadata, which matches the plan and sets up Cursor's project-vs-user rule behavior cleanly.
- Installer helper coverage is good: create/overwrite/skip semantics and empty-directory cleanup are all exercised.
- Regression coverage hits both unit and integration layers, including JSON/text list output paths and existing OpenCode behavior.

## Production Readiness Blockers

None.

## High Priority (P1)

None.

## Medium Priority (P2)

- None.

## Readiness Checklist

**P0 blockers**
- [x] Optional harness rule contract added without breaking existing bundled harnesses
- [x] Rule install/uninstall helpers implemented and tested
- [x] `harness list` updated for scope-aware rule metadata and file detection
- [x] Install summary updated for rules and warnings

**P1 recommended**
- [x] Proceed to Phase 2
