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
