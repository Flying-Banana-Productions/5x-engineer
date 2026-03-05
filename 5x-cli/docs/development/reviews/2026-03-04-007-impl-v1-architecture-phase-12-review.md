# Review: 007-impl-v1-architecture Phase 12 (Sample Provider Plugin)

**Review type:** commit `805bf8a`
**Scope:** `@5x-ai/provider-sample` workspace package, provider factory plugin loading path, Phase 12 tests
**Reviewer:** Staff engineer
**Local verification:** `bun test test/providers/plugin-loading.test.ts` (pass)

## Summary

Phase intent (validate external provider plugin architecture) is mostly met via a minimal sample provider and basic error-case tests, but the current error plumbing does not reliably preserve required exit codes in the CLI path, and the test suite does not actually exercise the dynamic-import success path or invalid-plugin validation described in the plan.

**Readiness:** Ready with corrections — issues are mechanical but should be fixed before calling Phase 12 complete.

## Strengths

- `packages/provider-sample/` is small, dependency-free, and implements the `ProviderPlugin` contract cleanly.
- Root workspace wiring is in place (`workspaces: ["packages/*"]`) and lockfile reflects it.
- `test/providers/plugin-loading.test.ts` runs fast and covers the direct plugin lifecycle + missing plugin error.

## Production Readiness Blockers

### P0.1 — Provider plugin errors lose deterministic exit codes

**Risk:** Missing/invalid provider packages surface as `INTERNAL_ERROR` or exit with code `1`, breaking orchestrator branching on exit codes and violating the CLI error-handling contract.

**Requirement:** Ensure provider-plugin failures propagate as `CliError` with the correct exit code.

- In `5x-cli/src/commands/invoke.ts`, the factory error bridge currently calls `outputError(err.code, err.message)` but drops `err.exitCode`, so the process exits `1` even when the error type carries `exitCode=2`.
- Preferred fix: have `5x-cli/src/providers/factory.ts` throw `CliError` directly for `PROVIDER_NOT_FOUND` / `INVALID_PROVIDER`, and delete the ad-hoc `ProviderNotFoundError` / `InvalidProviderError` types.
- Acceptable alternative: keep those error types but plumb `exitCode` through `outputError(..., exitCode)` everywhere they’re translated.

## High Priority (P1)

### P1.1 — Phase 12 tests don’t cover dynamic import success path

The phase goal is to validate external plugin loading via `import()`; current tests validate the plugin implementation via direct relative import, but never assert that `createProvider()` can resolve `provider: "sample"` to `@5x-ai/provider-sample` and instantiate it.

Add an integration test that:

- Builds a config with `author.provider = "sample"` and `sample: { echo: false }`.
- Calls `createProvider("author", config)` and asserts the returned provider/session behavior reflects the plugin config (proves passthrough + dynamic import).

### P1.2 — No invalid-plugin module test

The plan calls for validating that a module exists but does not default-export a valid `ProviderPlugin`, resulting in `INVALID_PROVIDER`.

- Add a minimal intentionally-invalid workspace package (or a test fixture resolvable as a package) and assert `createProvider()` throws `INVALID_PROVIDER`.

### P1.3 — Sample plugin package.json diverges from plan

`packages/provider-sample/package.json` uses `devDependencies` on `@5x-ai/5x-cli` instead of a `peerDependencies` entry as described in the Phase 12 plan.

- Align with the plan so the example reflects the intended distribution model for third-party providers.

## Medium Priority (P2)

- `packages/provider-sample/src/index.ts` stores `model`/`workingDirectory` but doesn’t use them; either use them or remove to keep the sample crisp.
- `resumeSession()` hardcodes `workingDirectory` to `/tmp`; prefer `process.cwd()` or track the prior working directory when resuming an existing session ID.
- Consider validating `plugin.name` matches the configured provider name (or document why it’s intentionally not enforced).

## Readiness Checklist

**P0 blockers**
- [ ] Provider plugin errors return correct `code` and deterministic `exitCode` through the CLI surface

**P1 recommended**
- [ ] Add dynamic-import success-path test for `provider: "sample"` via `createProvider()`
- [ ] Add invalid-plugin test for `INVALID_PROVIDER`
- [ ] Align sample plugin `package.json` dependency model with the plan (`peerDependencies`)

## Addendum (2026-03-05) — Review Follow-up for `669dafc2`

### What's Addressed

- P0.1 exit code propagation: `5x-cli/src/commands/invoke.ts` now passes `exitCode` into `outputError(...)` when bridging provider factory errors.
- P1.3 dependency model: `5x-cli/packages/provider-sample/package.json` now uses `peerDependencies` (instead of `devDependencies`).
- Fixture added: `5x-cli/packages/provider-invalid/` exists to support invalid-plugin testing.

### Remaining Concerns

- P1.1 still not validated: `5x-cli/test/providers/plugin-loading.test.ts` does not exercise the factory dynamic-import success path (`createProvider()` with `provider: "sample"` resolving `@5x-ai/provider-sample`). The new “file URL” import test bypasses `createProvider()`/`loadPlugin()`.
- P1.2 still not validated: there is no test that asserts `createProvider()` (or `loadPlugin()`) throws `INVALID_PROVIDER` when the invalid package is selected. The current “invalid plugin” test only asserts the fixture shape is invalid; it does not assert factory behavior.
- New: `5x-cli/packages/provider-invalid/package.json` uses the name `@5x-ai/provider-provider-invalid`; this works if config uses `provider: "provider-invalid"`, but it’s confusing and makes tests harder to read.
- New: `peerDependencies` values use `file:../..` (both sample + invalid). For an example meant to mirror third-party publishing, `workspace:*` (or a semver range) is closer to the plan.
- Architectural follow-up (optional): `5x-cli/src/providers/factory.ts` still throws non-`CliError` types even though the v1 CLI has `CliError` available; today it’s bridged in `invoke`, but future call sites could regress exit-code determinism unless they replicate the bridge.

## Addendum (2026-03-05) — Review Follow-up for `32576d07`

### What's Addressed

- P1.1 validated: `5x-cli/test/providers/plugin-loading.test.ts` now exercises the factory dynamic-import success path for `provider: "sample"` and asserts config passthrough impacts behavior (`echo: false` and `echo: true`).
- P1.2 validated: `5x-cli/test/providers/plugin-loading.test.ts` now asserts `createProvider()` throws `InvalidProviderError` with `code=INVALID_PROVIDER` and `exitCode=2` when loading the invalid provider plugin.
- Fixture cleanup: `5x-cli/packages/provider-invalid/package.json` renamed to `@5x-ai/provider-invalid` (removed the duplicate `provider-` prefix).

### New Concerns

- `5x-cli/package.json` now includes `@5x-ai/provider-sample` and `@5x-ai/provider-invalid` as `devDependencies` to make dynamic import resolution work in tests. That’s reasonable for tests, but it slightly muddles the story that external providers are separately installed packages; ensure this doesn’t accidentally ship/publish or become a runtime expectation.
- The provider plugin `peerDependencies` still use `file:../..`; if these packages are meant as a publishing example, consider switching to `workspace:*` (within the monorepo) or a normal semver range.

### Remaining Concerns

- P0.1 note (from original review) is addressed in `invoke`, but `5x-cli/src/providers/factory.ts` still throws non-`CliError` errors. If any other command starts using `createProvider()` without the same bridging, exit-code determinism can regress. Treat as a low-severity architecture hygiene item.

**Provisional readiness update:** Phase 12’s plan compliance gaps (P1.1/P1.2) are now closed; remaining items are mostly hygiene/documentation-level.
