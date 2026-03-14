# Orchestrator Improvements

**Version:** 1.0
**Created:** March 14, 2026
**Status:** Draft

## Overview

Post-run analysis identified five pain points in the 5x-cli orchestration system. This plan addresses: sub-project config path resolution (bug), template variable defaults, quality gate no-op ambiguity, protocol validate checklist gates, and skill-level review path fixes. Phases are ordered so the config path bug (which blocks `run init` for sub-projects) is fixed first, followed by self-contained CLI improvements, then skill-only changes last.

## Design Decisions

**Fix sub-project config paths before other changes.** The relative-path resolution bug in `resolveLayeredConfig()` prevents `5x run init` from working with sub-project configs. All other improvements depend on a working run infrastructure, so this must come first.

**`variable_defaults` in template frontmatter rather than optional-suffix convention.** The loader already has a "not yet implemented" comment about optional variables (line ~333). A `variable_defaults` YAML key is more explicit than naming conventions (`_optional` suffix), keeps frontmatter self-documenting, and avoids changing the variable regex.

**Checklist validation in `protocol validate author` rather than a separate command.** Embedding the check in the existing validate flow means the skill doesn't need to parse plans itself. The `--no-phase-checklist-validate` flag preserves backward compatibility.

**`skipQualityGates` config key for intentional no-op.** Distinguishes between "I have no gates and forgot to add them" (warning) vs "I intentionally skip gates" (silent). Produces a `skipped: true` field for the skill to route on.

**Skill edits are last phase.** The CLI must be solid before modifying skill prose that depends on CLI behavior.

## Phase 1: Sub-project Config Path Resolution

**Completion gate:** `resolveLayeredConfig()` resolves relative `paths.*` values against their config file's directory. Existing config-layering tests pass. New tests validate the fix with sub-project relative paths.

- [ ] Add `resolveRawConfigPaths(raw: unknown, baseDir: string): unknown` helper function in `src/config.ts` (after `isRecord()` helper, ~line 183). Walks `raw.paths` and resolves each relative string value against `baseDir` using `resolve(baseDir, value)`. Handles nested `paths.templates.plan` and `paths.templates.review`. Returns a new object with only `paths` modified; non-path fields untouched.
- [ ] Call `resolveRawConfigPaths()` on `rootRaw` with `dirname(rootConfigPath)` as `baseDir` in `resolveLayeredConfig()` (~line 489, after loading root config).
- [ ] Call `resolveRawConfigPaths()` on `nearestRaw` with `dirname(nearestConfigPath)` as `baseDir` in `resolveLayeredConfig()` (~line 521, after loading nearest config).
- [ ] Add unit tests in `test/unit/config-layering.test.ts`:
  - Sub-project `paths.plans = "docs/development"` resolves to `<sub-project-dir>/docs/development` (absolute), not `<root>/docs/development`.
  - Root `paths.plans = "docs/plans"` still resolves to `<root>/docs/plans` (no behavior change).
  - Absolute paths (`paths.plans = "/opt/plans"`) pass through unchanged.
  - Nested `paths.templates.plan` resolves correctly for sub-project.
  - Merged config produces all-absolute paths.
- [ ] Verify all existing `test/unit/config-layering.test.ts` tests pass (they use string comparisons on `paths.*` — update expectations if the fix changes values from relative to absolute).

## Phase 2: Template Variable Defaults

**Completion gate:** Templates declaring `variable_defaults` render without explicit `--var` for defaulted variables. Missing-var errors still fire for non-defaulted variables.

- [ ] Add `variableDefaults: Record<string, string>` to `TemplateMetadata` interface in `src/templates/loader.ts` (line ~32, after `stepName`). Default to `{}`.
- [ ] In `parseTemplate()` (~line 126): after existing frontmatter validation, parse optional `variable_defaults` key from frontmatter. Validate: must be a plain object, all keys must exist in the `variables` list, all values must be strings. Store in `metadata.variableDefaults`.
- [ ] In `renderTemplate()` (~line 338): before the missing-vars check (line ~345), pre-populate absent variables from `metadata.variableDefaults`. Explicit vars always win — only fill in keys not already in `variables` record.
- [ ] Remove the stale comment on line ~335: `"not yet implemented; all are required"`.
- [ ] Add `variable_defaults:\n  user_notes: ""` to frontmatter of `src/templates/author-next-phase.md` (between `step_name` and `---`).
- [ ] Add `variable_defaults:\n  user_notes: ""` to frontmatter of `src/templates/author-fix-quality.md`.
- [ ] Add `variable_defaults:\n  user_notes: ""` to frontmatter of `src/templates/author-process-plan-review.md`.
- [ ] Add `variable_defaults:\n  user_notes: ""` to frontmatter of `src/templates/author-process-impl-review.md`.
- [ ] Add unit tests in `test/unit/templates/loader.test.ts`:
  - `parseTemplate` with `variable_defaults` parses correctly and populates `metadata.variableDefaults`.
  - `renderTemplate` for `author-next-phase` renders without providing `user_notes` (uses default empty string).
  - Explicit `user_notes="custom"` overrides the default.
  - `variable_defaults` key referencing a variable not in `variables` list throws.
  - `variable_defaults` with non-string value throws.
  - Templates without `variable_defaults` still work (backward compatible).
- [ ] Verify existing loader tests pass (especially the `author-next-phase` and `author-fix-quality` tests that currently pass `user_notes` explicitly).

## Phase 3: Quality Gate No-op Ambiguity

**Completion gate:** `5x quality run` with empty gates and `skipQualityGates: false` emits a stderr warning. With `skipQualityGates: true`, output includes `skipped: true` and no warning.

- [ ] Add `skipQualityGates: z.boolean().default(false)` to `FiveXConfigSchema` in `src/config.ts` (~line 51, after `qualityGates`).
- [ ] Add `"skipQualityGates"` to the `allowedRoot` set in `warnUnknownConfigKeys()` (~line 195).
- [ ] Modify the no-op short-circuit in `runQuality()` (`src/commands/quality-v1.handler.ts`, ~line 173):
  - Read `skipQualityGates` from resolved config (alongside `qualityGates`).
  - If `skipQualityGates: true`: output `{ passed: true, results: [], skipped: true }`, no warning.
  - If `qualityGates.length === 0` and `skipQualityGates: false`: emit `console.error("Warning: no quality gates configured. Add qualityGates to 5x.toml or set skipQualityGates: true to suppress this warning.")`, then output `{ passed: true, results: [] }`.
  - If `qualityGates.length > 0`: execute normally (unchanged).
- [ ] Add unit tests in `test/unit/config.test.ts` or `test/unit/config-v1.test.ts`:
  - `skipQualityGates` defaults to `false` when not set.
  - `skipQualityGates: true` parses correctly.
  - `skipQualityGates` appears in allowed keys (no unknown-key warning).
- [ ] Add integration test (or handler-level unit test) for the quality handler:
  - Empty gates + `skipQualityGates: false` → output has no `skipped` field, stderr has warning.
  - Empty gates + `skipQualityGates: true` → output has `skipped: true`, no stderr warning.
  - Non-empty gates → normal execution (no `skipped` field).

## Phase 4: Protocol Validate Author Checklist Gate

**Completion gate:** `5x protocol validate author` with `result: "complete"` checks plan phase checklist. Emits `PHASE_CHECKLIST_INCOMPLETE` error when phase is not done. `--no-phase-checklist-validate` suppresses the check.

- [ ] Add CLI args to `authorCmd` in `src/commands/protocol.ts` (~line 39):
  - `plan: { type: "string", description: "Path to plan file for checklist validation" }` (optional).
  - `"phase-checklist-validate": { type: "boolean", default: true, description: "Validate phase checklist completion (use --no-phase-checklist-validate to skip)" }` (optional).
- [ ] Pass new args to `protocolValidate()` in the `authorCmd` `run` handler (~line 53): `plan: args.plan as string | undefined`, `phaseChecklistValidate: args["phase-checklist-validate"] as boolean | undefined`.
- [ ] Add `plan?: string` and `phaseChecklistValidate?: boolean` to `ProtocolValidateParams` in `src/commands/protocol.handler.ts` (~line 24).
- [ ] Implement checklist gate logic in `protocolValidate()`, after `validateStructuredOutputOrThrow` returns (line ~127) and before `outputSuccess()` (line ~159):
  - Only for `role === "author"` and `validated.result === "complete"` and `params.phaseChecklistValidate !== false`.
  - Resolve plan path: try `params.plan` first. If not provided and `params.run` is set, use `resolveRunExecutionContext` to get the plan path (reuse existing DB/control-plane infrastructure from the handler). If neither available, skip silently.
  - If plan path and `params.phase` are both available: read the plan file, call `parsePlan()`, find the phase matching `params.phase`, check `phase.isComplete`. If `false`: `outputError("PHASE_CHECKLIST_INCOMPLETE", "Phase ${phase} checklist is not complete. Mark all items [x] before returning result: complete.")`.
  - If plan file doesn't exist or phase not found: skip silently (graceful degradation).
- [ ] Add unit tests in `test/unit/commands/protocol-validate.test.ts`:
  - Author `result: "complete"` with `--plan` pointing to a plan where phase is incomplete → `PHASE_CHECKLIST_INCOMPLETE` error.
  - Author `result: "complete"` with `--plan` pointing to a plan where phase is complete → success.
  - Author `result: "complete"` with `--no-phase-checklist-validate` and incomplete phase → success (check suppressed).
  - Author `result: "needs_human"` → no checklist check regardless.
  - Reviewer role → no checklist check.
  - No `--plan` and no `--run` → checklist check skipped silently, validation succeeds.
  - `--plan` with non-existent file → graceful skip, validation succeeds.

## Phase 5: Skill Updates

**Completion gate:** SKILL.md changes are syntactically correct. The `reviewer-commit` and `author-process-impl-review` render calls no longer pass `--var review_path=...`. Quality gate routing handles `skipped: true`.

- [ ] Edit `src/skills/5x-phase-execution/SKILL.md` Step 3 (reviewer-commit, ~line 276): remove `--var review_path=$REVIEW_PATH` from both the `5x template render` and `5x invoke reviewer` calls. After the render call, add: `REVIEW_PATH=$(echo "$RENDERED" | jq -r '.data.variables.review_path')` to extract the auto-derived path.
- [ ] Edit `src/skills/5x-phase-execution/SKILL.md` Step 5 (author-process-impl-review, ~line 328): remove `--var review_path=$REVIEW_PATH` from both the `5x template render` and `5x invoke author` calls. The review_path is already auto-derived by the CLI for this template.
- [ ] Remove any stale `REVIEW_PATH=...` initialization from the phase loop header if present (check ~line 188-191 for any per-run initialization).
- [ ] Edit `src/skills/5x-phase-execution/SKILL.md` Step 2 quality gate routing (~line 228): add handling for `skipped: true` in the quality result — treat as `passed: true` (continue to Step 3). Add a brief note: "If `skipped: true`, quality gates are intentionally disabled — proceed to review."
- [ ] Verify the SKILL.md parses correctly as a skill (has valid frontmatter).

## Files Touched

| File | Change |
|------|--------|
| `src/config.ts` | Add `resolveRawConfigPaths()` helper; add `skipQualityGates` to schema and allowlist |
| `src/templates/loader.ts` | Add `variableDefaults` to `TemplateMetadata`; parse `variable_defaults` frontmatter; pre-populate defaults before missing-var check; remove stale comment |
| `src/templates/author-next-phase.md` | Add `variable_defaults: {user_notes: ""}` to frontmatter |
| `src/templates/author-fix-quality.md` | Add `variable_defaults: {user_notes: ""}` to frontmatter |
| `src/templates/author-process-plan-review.md` | Add `variable_defaults: {user_notes: ""}` to frontmatter |
| `src/templates/author-process-impl-review.md` | Add `variable_defaults: {user_notes: ""}` to frontmatter |
| `src/commands/quality-v1.handler.ts` | Read `skipQualityGates`; modify no-op short-circuit with warning vs skipped logic |
| `src/commands/protocol.ts` | Add `--plan` and `--phase-checklist-validate` args to `authorCmd` |
| `src/commands/protocol.handler.ts` | Add `plan`/`phaseChecklistValidate` to params; implement checklist gate logic |
| `src/skills/5x-phase-execution/SKILL.md` | Remove explicit `review_path` vars from Steps 3 & 5; extract auto-derived path; handle `skipped: true` in Step 2 |
| `test/unit/config-layering.test.ts` | Tests for path resolution fix |
| `test/unit/config.test.ts` | Tests for `skipQualityGates` schema |
| `test/unit/templates/loader.test.ts` | Tests for `variable_defaults` |
| `test/unit/commands/protocol-validate.test.ts` | Tests for checklist gate |

## Tests

| Type | Scope | Validates |
|------|-------|-----------|
| Unit | `test/unit/config-layering.test.ts` | Sub-project relative paths resolve against config file dir, not root |
| Unit | `test/unit/config.test.ts` | `skipQualityGates` schema parsing and allowlist |
| Unit | `test/unit/templates/loader.test.ts` | `variable_defaults` parsing, default population, override behavior |
| Unit | `test/unit/commands/protocol-validate.test.ts` | Checklist gate fires on incomplete phase, suppressed by flag, skipped gracefully |
| Unit/Integration | quality handler test | `skipQualityGates` + empty gates produces correct output and warnings |

## Not In Scope

- Changes to `5x run init` or run infrastructure (only config resolution is fixed)
- New templates or template variables beyond `variable_defaults`
- Changes to `5x plan phases` command output format
- Migration of existing plan review files or config files
- Changes to reviewer protocol validation (checklist gate is author-only)

## Revision History

### v1.0 (March 14, 2026) — Initial draft

- Five pain points organized into five phases with dependency ordering
