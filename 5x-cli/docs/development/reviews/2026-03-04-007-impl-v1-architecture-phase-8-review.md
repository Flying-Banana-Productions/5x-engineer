# Review: 007 impl v1 architecture - Phase 8 (Config Schema Extension)

**Review type:** commit `ca220bb`
**Scope:** Phase 8 config schema extension (`provider`, `opencode`, `maxStepsPerRun`), unknown/deprecated key warnings, provider factory typing, tests
**Reviewer:** Staff engineer
**Local verification:** `bun test` (pass)

## Summary

Implements Phase 8 largely as written: schema accepts new fields, plugin config passthrough is enabled, unknown-key warnings are suppressed for configured provider keys, and tests cover the behavior.

Primary gap is backward-compat semantics for `maxAutoIterations`: it is deprecated + warned, but currently not honored as an alias for `maxStepsPerRun`, which can silently increase run length/cost for existing configs.

**Readiness:** Ready with corrections — mechanical compat + CLI wiring items remain.

## Strengths

- `src/config.ts` uses `.passthrough()` to preserve plugin-specific config keys without core validation, matching the plugin architecture intent.
- `warnUnknownConfigKeys()` suppression logic for provider-matching top-level keys is simple and effective.
- `OpenCodeConfigSchema` adds basic URL validation, preventing obvious misconfig.
- Test coverage is strong for defaults, validation, warnings, and passthrough (`test/config-v1.test.ts`).

## Production Readiness Blockers

### P0.1 — Deprecated `maxAutoIterations` not honored as alias for `maxStepsPerRun`

**Risk:** Existing configs that set `maxAutoIterations` for safety/cost limits will now default to `maxStepsPerRun=50` unless they also set `maxStepsPerRun`. This can materially increase agent/runtime work and spend while only emitting a warning.

**Requirement:** If `maxStepsPerRun` is unset and `maxAutoIterations` is set, treat `maxAutoIterations` as the effective `maxStepsPerRun` (while still warning). Ensure this applies to the value persisted into `runs.config_json` and to enforcement.

## High Priority (P1)

### P1.1 — Phase-8 CLI overrides not wired (provider/opencode URL)

`applyModelOverrides()` supports `authorProvider`, `reviewerProvider`, `opencodeUrl` in `src/config.ts`, but no commands/arg parsing pass these overrides (grep shows no `--author-provider` / `--reviewer-provider` / `--opencode-url` flags).

Recommendation: add the flags to the relevant commands (likely `src/commands/invoke.ts`) and apply them before provider creation/session start.

### P1.2 — Provider factory “forward-compatible” comment no longer matches behavior

`src/providers/factory.ts` still claims defaulting when provider keys are absent, but now reads `config[role].provider` directly. Either restore the fallback for defensive robustness or update the comment to match the Phase 8 reality.

## Medium Priority (P2)

- Consider hardening `getPluginConfig()` (`src/providers/factory.ts`) to reject `null`/arrays (current `typeof === "object"` accepts both) to reduce surprising plugin inputs.
- UX: `warnUnknownConfigKeys()` only considers provider names present in the config file, not provider overrides supplied via CLI flags. If/when CLI overrides are added, decide whether warnings should reflect the effective provider set.

## Readiness Checklist

**P0 blockers**
- [ ] Map `maxAutoIterations` -> effective `maxStepsPerRun` when `maxStepsPerRun` is absent; enforce consistently (e.g. `src/commands/run-v1.ts`).

**P1 recommended**
- [ ] Add CLI flags for provider/opencode URL overrides and apply them in invocation flow.
- [ ] Align provider factory comments (and/or behavior) with the post-Phase-8 typed config.

## Addendum (2026-03-05) — Follow-up on `2aec3db`

All previously raised items (P0.1, P1.1, P1.2, P2.1, P2.2) are addressed by `2aec3db`. Local `bun test` passes.

### What's Addressed

- P0.1: `maxAutoIterations` honored as an alias when `maxStepsPerRun` is absent (`src/config.ts`, plus fallback in `src/commands/run-v1.ts`); new tests added in `test/config-v1.test.ts`.
- P1.1: `5x invoke` now supports `--author-provider`, `--reviewer-provider`, `--opencode-url`; overrides applied via `applyModelOverrides()` before `createProvider()` (`src/commands/invoke.ts`).
- P1.2: Provider factory docs updated to match Phase-8 typed config defaults (`src/providers/factory.ts`).
- P2.1: `getPluginConfig()` rejects `null`/arrays (`src/providers/factory.ts`).
- P2.2: Unknown-key warnings now suppress top-level keys matching CLI provider overrides (`src/config.ts` + `test/config-v1.test.ts`).

### Remaining Concerns

- New: `--opencode-url` override is not URL-validated (schema validates file config, but CLI path bypasses it). Recommendation: validate in `src/commands/invoke.ts` (or inside `applyModelOverrides`) using `new URL()` / `z.string().url()`.
