# Orchestrator Improvements

**Version:** 1.3
**Created:** March 14, 2026
**Status:** Draft

## Overview

Post-run analysis identified five pain points in the 5x-cli orchestration system. This plan addresses: sub-project config path resolution (bug), template variable defaults, quality gate no-op ambiguity, protocol validate checklist gates, and skill-level review path fixes. Phases are ordered so the config path bug (which blocks `run init` for sub-projects) is fixed first, followed by self-contained CLI improvements, then skill-only changes last.

## Design Decisions

**Fix sub-project config paths before other changes.** The relative-path resolution bug in `resolveLayeredConfig()` prevents `5x run init` from working with sub-project configs. All other improvements depend on a working run infrastructure, so this must come first.

**All `paths.*` values become absolute after any config load.** Every config-loading entry point — `resolveLayeredConfig()`, `loadConfig()`, and any other function that returns a `FiveXConfig` — must normalize `paths.*` values to absolute before returning. The `resolveRawConfigPaths()` helper resolves raw configured values against their config file's directory. After Zod parsing (which applies defaults), a second pass resolves any remaining relative default paths against the workspace root (or `projectRoot` for `loadConfig()`). This ensures uniform absolute semantics regardless of which entry point loaded the config, whether values came from explicit config or Zod defaults. Callers should never need to resolve paths themselves.

**Checklist gate fails closed on explicit inputs, open on auto-discovery.** When `--plan` or `--phase` are explicitly provided, lookup failures (file not found, phase not found) must surface a validation error — silent skip would defeat the purpose of explicit args. Silent skip only applies to the best-effort auto-discovery path (no `--plan`, no `--run`).

**`variable_defaults` in template frontmatter rather than optional-suffix convention.** The loader already has a "not yet implemented" comment about optional variables (line ~333). A `variable_defaults` YAML key is more explicit than naming conventions (`_optional` suffix), keeps frontmatter self-documenting, and avoids changing the variable regex.

**Checklist validation in `protocol validate author` rather than a separate command.** Embedding the check in the existing validate flow means the skill doesn't need to parse plans itself. The `--no-phase-checklist-validate` flag preserves backward compatibility.

**`skipQualityGates` config key for intentional no-op.** Distinguishes between "I have no gates and forgot to add them" (warning) vs "I intentionally skip gates" (silent). Produces a `skipped: true` field for the skill to route on.

**Skill edits are last phase.** The CLI must be solid before modifying skill prose that depends on CLI behavior.

## Phase 1: Sub-project Config Path Resolution

**Completion gate:** Both `resolveLayeredConfig()` and `loadConfig()` produce all-absolute `paths.*` values regardless of source (explicit config, Zod defaults, or merged layers). No config-loading entry point returns relative `paths.*` values. Existing config-layering tests pass (expectations updated for absolute paths). New tests validate sub-project paths, Zod defaults, `loadConfig()` normalization, and the integration workflow.

**Path contract:** After any config load (`resolveLayeredConfig()`, `loadConfig()`, or any other entry point), every `paths.*` value is an absolute path. Raw configured values are resolved against their config file's directory (or `projectRoot` for `loadConfig()`). Zod default values (e.g., `"docs/development"`) are resolved against the workspace root after schema parsing. Callers never receive relative paths and should never need to resolve paths themselves.

- [x] Add `resolveRawConfigPaths(raw: unknown, baseDir: string): unknown` helper function in `src/config.ts` (after `isRecord()` helper, ~line 183). Walks `raw.paths` and resolves each relative string value against `baseDir` using `resolve(baseDir, value)`. Handles nested `paths.templates.plan` and `paths.templates.review`. Returns a new object with only `paths` modified; non-path fields untouched. Already-absolute paths pass through unchanged.
- [x] Call `resolveRawConfigPaths()` on `rootRaw` with `dirname(rootConfigPath)` as `baseDir` in `resolveLayeredConfig()` (~line 489, after loading root config).
- [x] Call `resolveRawConfigPaths()` on `nearestRaw` with `dirname(nearestConfigPath)` as `baseDir` in `resolveLayeredConfig()` (~line 521, after loading nearest config).
- [x] After Zod schema parsing (which applies defaults for unset paths), call `resolveRawConfigPaths()` on the parsed `config.paths` with the workspace root as `baseDir`. This ensures Zod default relative paths (e.g., `"docs/development"`) also become absolute. Apply this to the final merged config object before returning.
- [x] Add path normalization to `loadConfig()` in `src/config.ts` (~line 394, after `applyDeprecatedAliases`): call `resolveRawConfigPaths()` on `config.paths` with `projectRoot` as `baseDir`. This ensures `loadConfig()` also returns absolute `paths.*` values, matching the same contract as `resolveLayeredConfig()`. Both explicit config values (resolved against `dirname(configPath)` or `projectRoot`) and Zod defaults (resolved against `projectRoot`) become absolute.
- [x] If `configPath` is non-null in `loadConfig()`, resolve raw `paths` values against `dirname(configPath)` before Zod parsing (same pattern as `resolveLayeredConfig()`), then resolve Zod defaults against `projectRoot` after parsing. If `configPath` is null (no config file, pure defaults), resolve only Zod defaults against `projectRoot`.
- [x] Audit downstream callers of `resolveLayeredConfig()` that manually resolve paths (e.g., `src/commands/template-vars.ts`, `src/commands/run.handler.ts`). Remove redundant `resolve()` calls that are now unnecessary since config always returns absolute paths. Add inline comments noting the contract.
- [x] Audit downstream callers of `loadConfig()` that use `paths.*` values: `src/commands/run-v1.handler.ts`, `src/commands/harness.handler.ts`, `src/commands/invoke.handler.ts`, `src/commands/template.handler.ts`, `src/commands/context.ts`. Verify none of these callers perform their own `resolve()` on `config.paths.*` values — if they do, remove the redundant resolution and add inline comments noting the absolute-path contract. These callers should work unchanged since absolute paths are a superset of the prior behavior.
- [x] Add unit tests in `test/unit/config-layering.test.ts`:
  - Sub-project `paths.plans = "docs/development"` resolves to `<sub-project-dir>/docs/development` (absolute), not `<root>/docs/development`.
  - Root `paths.plans = "docs/plans"` still resolves to `<root>/docs/plans` (absolute).
  - Absolute paths (`paths.plans = "/opt/plans"`) pass through unchanged.
  - Nested `paths.templates.plan` resolves correctly for sub-project.
  - Merged config produces all-absolute paths.
  - Config with no explicit paths (Zod defaults only) produces absolute paths resolved against workspace root.
  - Non-layered config (single config file) also produces absolute paths (same contract).
- [x] Add unit tests for `loadConfig()` path normalization in `test/unit/config.test.ts` (or `test/unit/config-paths.test.ts`):
  - `loadConfig()` with a config file containing relative `paths.plans` returns an absolute path resolved against the config file's directory.
  - `loadConfig()` with no config file (Zod defaults only) returns absolute `paths.*` values resolved against `projectRoot`.
  - `loadConfig()` with already-absolute paths passes them through unchanged.
  - `loadConfig()` with nested `paths.templates.plan` relative value resolves correctly.
- [x] Update operator-facing config reference docs (`docs/development/016-review-artifacts-and-phase-checks.md` or `docs/configuration.md`) to describe the new absolute-path contract: `paths.*` values are always resolved to absolute paths by the CLI after config loading, regardless of whether they were written as relative or absolute. Update any examples that assume repo-relative defaults.
- [x] Verify all existing `test/unit/config-layering.test.ts` tests pass — update string expectations from relative to absolute where the fix changes returned values.
- [x] Add integration test in `test/integration/commands/` for sub-project `5x run init`:
  - Create a temp repo with a root `5x.toml` and a sub-project `packages/foo/5x.toml` with relative `paths.plans = "docs/dev"`.
  - Run `5x run init --plan packages/foo/docs/dev/some-plan.md` from the repo root.
  - Assert the run record resolves the plan path correctly (absolute, under `packages/foo/`).

## Phase 2: Template Variable Defaults

**Completion gate:** Templates declaring `variable_defaults` render without explicit `--var` for defaulted variables. Missing-var errors still fire for non-defaulted variables.

- [x] Add `variableDefaults: Record<string, string>` to `TemplateMetadata` interface in `src/templates/loader.ts` (line ~32, after `stepName`). Default to `{}`.
- [x] In `parseTemplate()` (~line 126): after existing frontmatter validation, parse optional `variable_defaults` key from frontmatter. Validate: must be a plain object, all keys must exist in the `variables` list, all values must be strings. Store in `metadata.variableDefaults`.
- [x] In `renderTemplate()` (~line 338): before the missing-vars check (line ~345), pre-populate absent variables from `metadata.variableDefaults`. Explicit vars always win — only fill in keys not already in `variables` record.
- [x] Remove the stale comment on line ~335: `"not yet implemented; all are required"`.
- [x] Add `variable_defaults:\n  user_notes: ""` to frontmatter of `src/templates/author-next-phase.md` (between `step_name` and `---`).
- [x] Add `variable_defaults:\n  user_notes: ""` to frontmatter of `src/templates/author-fix-quality.md`.
- [x] Add `variable_defaults:\n  user_notes: ""` to frontmatter of `src/templates/author-process-plan-review.md`.
- [x] Add `variable_defaults:\n  user_notes: ""` to frontmatter of `src/templates/author-process-impl-review.md`.
- [x] Add unit tests in `test/unit/templates/loader.test.ts`:
  - `parseTemplate` with `variable_defaults` parses correctly and populates `metadata.variableDefaults`.
  - `renderTemplate` for `author-next-phase` renders without providing `user_notes` (uses default empty string).
  - Explicit `user_notes="custom"` overrides the default.
  - `variable_defaults` key referencing a variable not in `variables` list throws.
  - `variable_defaults` with non-string value throws.
  - Templates without `variable_defaults` still work (backward compatible).
- [x] Verify existing loader tests pass (especially the `author-next-phase` and `author-fix-quality` tests that currently pass `user_notes` explicitly).
- [x] Update template authoring reference docs (in `docs/` or inline in `016-review-artifacts-and-phase-checks.md`) to document `variable_defaults` frontmatter key: syntax, validation rules (keys must exist in `variables`, values must be strings), and precedence (explicit `--var` > default > missing-var error).

## Phase 3: Quality Gate No-op Ambiguity

**Completion gate:** `5x quality run` with empty gates and `skipQualityGates: false` emits a stderr warning. With `skipQualityGates: true`, output includes `skipped: true` and no warning.

- [x] Add `skipQualityGates: z.boolean().default(false)` to `FiveXConfigSchema` in `src/config.ts` (~line 51, after `qualityGates`).
- [x] Add `"skipQualityGates"` to the `allowedRoot` set in `warnUnknownConfigKeys()` (~line 195).
- [x] Add an optional `warn?: (...args: unknown[]) => void` parameter to `runQuality()` (defaulting to `console.error`), following the same dependency-injection pattern used by `loadConfig()`.
- [x] Modify the no-op short-circuit in `runQuality()` (`src/commands/quality-v1.handler.ts`, ~line 173):
  - Read `skipQualityGates` from resolved config (alongside `qualityGates`).
  - If `skipQualityGates: true`: output `{ passed: true, results: [], skipped: true }`, no warning.
  - If `qualityGates.length === 0` and `skipQualityGates: false`: call `warn("Warning: no quality gates configured. Add qualityGates to 5x.toml or set skipQualityGates: true to suppress this warning.")`, then output `{ passed: true, results: [] }`.
  - If `qualityGates.length > 0`: execute normally (unchanged).
- [x] Add unit tests in `test/unit/config.test.ts` or `test/unit/config-v1.test.ts`:
  - `skipQualityGates` defaults to `false` when not set.
  - `skipQualityGates: true` parses correctly.
  - `skipQualityGates` appears in allowed keys (no unknown-key warning).
- [x] Add handler-level unit test for the quality handler using the existing `warn` dependency-injection pattern (see `loadConfig()` signature in `src/config.ts` which already accepts an optional `warn` function). Add an optional `warn` parameter to `runQuality()` (defaulting to `console.error`). Unit tests inject a mock `warn` sink and assert on calls to it — this avoids capturing `console.error` output directly, which is reserved for integration tests per AGENTS.md:
  - Empty gates + `skipQualityGates: false` → output has no `skipped` field, `warn` sink received the warning message.
  - Empty gates + `skipQualityGates: true` → output has `skipped: true`, `warn` sink not called.
  - Non-empty gates → normal execution (no `skipped` field, `warn` sink not called).
- [x] Add integration test in `test/integration/commands/` for `5x quality run` with no gates configured:
  - Create a temp repo with a `5x.toml` that has no `qualityGates` and `skipQualityGates = false`.
  - Spawn `5x quality run`, assert stderr contains the warning message and stdout JSON has `passed: true` without `skipped`.
  - Repeat with `skipQualityGates = true`, assert no stderr warning and stdout JSON has `skipped: true`.
- [x] Update config reference docs to document `skipQualityGates` key: type (boolean), default (`false`), behavior when `true` (silent skip with `skipped: true` output), and interaction with empty `qualityGates`.

## Phase 4: Protocol Validate Author Checklist Gate

**Completion gate:** `5x protocol validate author` with `result: "complete"` checks plan phase checklist. Emits `PHASE_CHECKLIST_INCOMPLETE` error when phase is not done. `--no-phase-checklist-validate` suppresses the check. Explicit `--plan`/`--phase` with invalid targets fail with a validation error (fail-closed).

- [x] Add CLI args to `authorCmd` in `src/commands/protocol.ts` (~line 39):
  - `plan: { type: "string", description: "Path to plan file for checklist validation" }` (optional).
  - `"phase-checklist-validate": { type: "boolean", default: true, description: "Validate phase checklist completion (use --no-phase-checklist-validate to skip)" }` (optional).
- [x] Pass new args to `protocolValidate()` in the `authorCmd` `run` handler (~line 53): `plan: args.plan as string | undefined`, `phaseChecklistValidate: args["phase-checklist-validate"] as boolean | undefined`.
- [x] Add `plan?: string` and `phaseChecklistValidate?: boolean` to `ProtocolValidateParams` in `src/commands/protocol.handler.ts` (~line 24).
- [x] Implement checklist gate logic in `protocolValidate()`, after `validateStructuredOutputOrThrow` returns (line ~127) and before `outputSuccess()` (line ~159):
  - Only for `role === "author"` and `validated.result === "complete"` and `params.phaseChecklistValidate !== false`.
  - Resolve plan path: try `params.plan` first. If not provided and `params.run` is set, use `resolveRunExecutionContext` to get the plan path (reuse existing DB/control-plane infrastructure from the handler). If neither available, skip silently (auto-discovery best-effort).
  - **Fail-closed for explicit inputs:** If `params.plan` was explicitly provided but the file does not exist, emit `outputError("PLAN_NOT_FOUND", "Plan file not found: ${params.plan}")` — do not skip. If `params.phase` was explicitly provided but the phase is not found in the parsed plan, emit `outputError("PHASE_NOT_FOUND", "Phase '${params.phase}' not found in plan: ${params.plan}")` — do not skip.
  - **Fail-open for auto-discovery only:** If the plan path was derived from `resolveRunExecutionContext` (not explicit `--plan`) and the file doesn't exist or the phase isn't found, skip silently (graceful degradation for best-effort path).
  - If plan path and phase are both resolved: read the plan file, call `parsePlan()`, find the phase matching `params.phase`, check `phase.isComplete`. If `false`: `outputError("PHASE_CHECKLIST_INCOMPLETE", "Phase ${phase} checklist is not complete. Mark all items [x] before returning result: complete.")`.
- [x] Add unit tests in `test/unit/commands/protocol-validate.test.ts`:
  - Author `result: "complete"` with `--plan` pointing to a plan where phase is incomplete → `PHASE_CHECKLIST_INCOMPLETE` error.
  - Author `result: "complete"` with `--plan` pointing to a plan where phase is complete → success.
  - Author `result: "complete"` with `--no-phase-checklist-validate` and incomplete phase → success (check suppressed).
  - Author `result: "needs_human"` → no checklist check regardless.
  - Reviewer role → no checklist check.
  - No `--plan` and no `--run` → checklist check skipped silently, validation succeeds.
  - `--plan` with non-existent file → `PLAN_NOT_FOUND` validation error (fail-closed).
  - `--plan` with valid file but `--phase` not found in plan → `PHASE_NOT_FOUND` validation error (fail-closed).
  - Auto-discovered plan path (via `--run`) where file doesn't exist → graceful skip, validation succeeds.
- [x] Add integration test in `test/integration/commands/` for `5x protocol validate author --run ...` with a mapped worktree plan:
  - Set up a temp repo with a run record pointing to a plan file.
  - Run `5x protocol validate author --run <id> --phase <phase>` with incomplete checklist.
  - Assert `PHASE_CHECKLIST_INCOMPLETE` error in output.
- [x] Update protocol validate command reference docs to document `--plan` and `--no-phase-checklist-validate` flags, including fail-closed vs fail-open behavior.

## Phase 5: Skill Updates

**Completion gate:** SKILL.md changes are syntactically correct. The `reviewer-commit` and `author-process-impl-review` render calls no longer pass `--var review_path=...`. Quality gate routing handles `skipped: true`.

- [x] Edit `src/skills/5x-phase-execution/SKILL.md` Step 3 (reviewer-commit, ~line 276): remove `--var review_path=$REVIEW_PATH` from both the `5x template render` and `5x invoke reviewer` calls. After the render call, add: `REVIEW_PATH=$(echo "$RENDERED" | jq -r '.data.variables.review_path')` to extract the auto-derived path.
- [x] Edit `src/skills/5x-phase-execution/SKILL.md` Step 5 (author-process-impl-review, ~line 328): remove `--var review_path=$REVIEW_PATH` from both the `5x template render` and `5x invoke author` calls. The review_path is already auto-derived by the CLI for this template.
- [x] Remove any stale `REVIEW_PATH=...` initialization from the phase loop header if present (check ~line 188-191 for any per-run initialization).
- [x] Edit `src/skills/5x-phase-execution/SKILL.md` Step 2 quality gate routing (~line 228): add handling for `skipped: true` in the quality result — treat as `passed: true` (continue to Step 3). Add a brief note: "If `skipped: true`, quality gates are intentionally disabled — proceed to review."
- [x] Verify the SKILL.md parses correctly as a skill (has valid frontmatter).

## Files Touched

| File | Change |
|------|--------|
| `src/config.ts` | Add `resolveRawConfigPaths()` helper; normalize paths in both `resolveLayeredConfig()` and `loadConfig()`; add `skipQualityGates` to schema and allowlist |
| `src/templates/loader.ts` | Add `variableDefaults` to `TemplateMetadata`; parse `variable_defaults` frontmatter; pre-populate defaults before missing-var check; remove stale comment |
| `src/templates/author-next-phase.md` | Add `variable_defaults: {user_notes: ""}` to frontmatter |
| `src/templates/author-fix-quality.md` | Add `variable_defaults: {user_notes: ""}` to frontmatter |
| `src/templates/author-process-plan-review.md` | Add `variable_defaults: {user_notes: ""}` to frontmatter |
| `src/templates/author-process-impl-review.md` | Add `variable_defaults: {user_notes: ""}` to frontmatter |
| `src/commands/quality-v1.handler.ts` | Add injectable `warn` parameter; read `skipQualityGates`; modify no-op short-circuit with warning vs skipped logic |
| `src/commands/protocol.ts` | Add `--plan` and `--phase-checklist-validate` args to `authorCmd` |
| `src/commands/protocol.handler.ts` | Add `plan`/`phaseChecklistValidate` to params; implement checklist gate logic |
| `src/skills/5x-phase-execution/SKILL.md` | Remove explicit `review_path` vars from Steps 3 & 5; extract auto-derived path; handle `skipped: true` in Step 2 |
| `docs/development/016-review-artifacts-and-phase-checks.md` (or equivalent) | Document absolute-path contract for `paths.*`, `variable_defaults` frontmatter, `skipQualityGates` config key, `--plan`/`--no-phase-checklist-validate` flags |
| `test/unit/config-layering.test.ts` | Tests for path resolution fix (including Zod defaults) |
| `test/unit/config.test.ts` (or `test/unit/config-paths.test.ts`) | Tests for `loadConfig()` path normalization; tests for `skipQualityGates` schema |
| `test/unit/templates/loader.test.ts` | Tests for `variable_defaults` |
| `test/unit/commands/protocol-validate.test.ts` | Tests for checklist gate (fail-closed on explicit args) |
| `test/integration/commands/run-init-subproject.test.ts` | Integration test for sub-project `5x run init` with relative paths |
| `test/integration/commands/quality-run-noop.test.ts` | Integration test for `5x quality run` with empty gates and skip flag |
| `test/integration/commands/protocol-validate-checklist.test.ts` | Integration test for `5x protocol validate author` with run-mapped plan |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/config-layering.test.ts` | Sub-project relative paths resolve against config file dir; Zod defaults resolve against workspace root; all paths absolute |
| Unit | `test/unit/config.test.ts` (or `test/unit/config-paths.test.ts`) | `loadConfig()` returns absolute `paths.*` values (explicit config, defaults-only, nested templates); `skipQualityGates` schema parsing and allowlist |
| Unit | `test/unit/templates/loader.test.ts` | `variable_defaults` parsing, default population, override behavior |
| Unit | `test/unit/commands/protocol-validate.test.ts` | Checklist gate fires on incomplete phase; fail-closed on explicit `--plan`/`--phase` errors; suppressed by flag |
| Unit | quality handler test | `skipQualityGates` + empty gates produces correct output; injected `warn` sink receives warning (no stderr capture) |
| Integration | `test/integration/commands/run-init-subproject.test.ts` | Sub-project `5x run init` resolves plan path correctly with layered config |
| Integration | `test/integration/commands/quality-run-noop.test.ts` | `5x quality run` stderr warning with empty gates; silent skip with `skipQualityGates` |
| Integration | `test/integration/commands/protocol-validate-checklist.test.ts` | `5x protocol validate author --run` with worktree-mapped plan and incomplete checklist |

## Reference Documentation Updates

The following inline doc updates ensure operators can discover new config keys and frontmatter behavior without reading source:

- Phase 1: Update the config reference in `docs/development/016-review-artifacts-and-phase-checks.md` (or `docs/configuration.md` if one exists) to document the new absolute-path contract: all `paths.*` values in `5x.toml` are resolved to absolute paths by the CLI after config loading, regardless of whether they were written as relative or absolute. Relative paths are resolved against the config file's directory (or workspace/project root for defaults). Callers always receive absolute paths. Update any operator-facing examples that show or assume repo-relative `paths.*` values to reflect the new behavior.
- Phase 2: Add a `variable_defaults` section to the template authoring reference in `docs/development/016-review-artifacts-and-phase-checks.md` (or the relevant template docs). Document the YAML key, validation rules, and precedence (explicit vars > defaults > error).
- Phase 3: Add `skipQualityGates` to the config reference section in `docs/development/016-review-artifacts-and-phase-checks.md` (or `docs/configuration.md` if one exists). Document the key, its default, and behavior with empty `qualityGates`.
- Phase 4: Document `--plan` and `--no-phase-checklist-validate` flags in the protocol validate command reference.

## Not In Scope

- Changes to `5x run init` or run infrastructure (only config resolution is fixed)
- New templates or template variables beyond `variable_defaults`
- Changes to `5x plan phases` command output format
- Migration of existing plan review files or config files
- Changes to reviewer protocol validation (checklist gate is author-only)

## Revision History

### v1.3 (March 14, 2026) — Review iteration 3 feedback (019-orchestrator-improvements-review.md addendum)

- **P2.1 (absolute-path config contract docs):** Added a Phase 1 checklist item and a Reference Documentation Updates entry to document the new absolute-path contract for `paths.*` in operator-facing docs. Existing docs described repo-relative defaults; the new entry requires updating those docs to reflect that all `paths.*` values are resolved to absolute paths by the CLI after config loading.

### v1.2 (March 14, 2026) — Review iteration 2 feedback (019-orchestrator-improvements-review.md addendum)

- **R4 / P1.1 (path contract across all entry points):** Extended the absolute-path contract to cover ALL config-loading paths, not just `resolveLayeredConfig()`. Phase 1 now includes `loadConfig()` normalization steps, a caller audit for `loadConfig()` call sites (`run-v1.handler`, `harness.handler`, `invoke.handler`, `template.handler`, `context.ts`), and dedicated unit tests for `loadConfig()` path normalization. Design Decision updated to state the contract applies to every config-loading entry point.
- **R5 (quality handler stderr test):** Replaced the handler-level unit test that asserted on stderr output with a dependency-injected `warn` sink pattern (matching the existing `loadConfig()` convention). Unit tests now inject a mock `warn` function and assert on its calls. Stderr assertions remain in the integration test only, per AGENTS.md test-tier rules.

### v1.1 (March 14, 2026) — Review feedback (019-orchestrator-improvements-review.md)

- **P0.1 (checklist fail-closed):** Phase 4 now distinguishes explicit `--plan`/`--phase` args (fail-closed: `PLAN_NOT_FOUND` / `PHASE_NOT_FOUND` errors) from auto-discovery path (fail-open: silent skip). Added corresponding unit tests and design decision.
- **P1.1 (path semantics contract):** Phase 1 now states an explicit contract: all `paths.*` values are absolute after `resolveLayeredConfig()`. Added a post-Zod-parse resolution step for default values against workspace root. Added caller audit checklist item. Added design decision documenting the contract.
- **P1.2 (integration test coverage):** Added integration tests for the three user-visible workflows: sub-project `5x run init`, `5x quality run` with empty gates, and `5x protocol validate author --run` with worktree plan.
- **P2 (reference docs):** Added Reference Documentation Updates section and per-phase checklist items for documenting `variable_defaults`, `skipQualityGates`, and `--plan`/`--no-phase-checklist-validate` flags.

### v1.0 (March 14, 2026) — Initial draft

- Five pain points organized into five phases with dependency ordering
