# Review: 5x CLI Phase 3 (Prompt Templates + Init)

**Review type:** `afedc94`  \
**Scope:** Phase 3 template loader + bundled prompt templates + `init` command + tests in `5x-cli/`  \
**Reviewer:** Staff engineer (correctness, architecture, security/tenancy, performance, operability, test strategy)  \
**Local verification:** `cd 5x-cli && bun test` PASS (186 pass, 1 skip); `bun run typecheck` PASS; `bun run lint` PASS

**Implementation plan:** `5x-cli/docs/development/001-impl-5x-cli.md`  \
**Technical design:** N/A

## Summary

Phase 3 adds a bundled prompt-template system (YAML frontmatter + `{{var}}` rendering) and an `init` command that bootstraps `5x.config.js`, `.5x/`, and `.gitignore` updates. Overall direction matches the implementation plan and is well-covered by tests.

Main gap is correctness around the documented escape sequence: `\{{...}}` currently becomes a hard error via the unresolved-variable check, so you cannot safely include literal `{{token}}` examples in templates as intended. Fix is mechanical; once addressed, Phase 3 is solid to build Phase 4 loops on.

**Readiness:** Ready with corrections - fix P0 escape semantics + add regression test.

---

## What shipped

- **Template loader:** YAML frontmatter parsing + variable substitution + template registry (`5x-cli/src/templates/loader.ts`).
- **Bundled templates:** 3 author + 2 reviewer prompt templates with 5x protocol output specs (`5x-cli/src/templates/*.md`).
- **Init command:** create config + `.5x/` dir + idempotent `.gitignore` update (`5x-cli/src/commands/init.ts`, `5x-cli/src/bin.ts`).
- **Public exports:** template types and APIs exposed from package entry (`5x-cli/src/index.ts`).
- **Tests:** loader unit tests + init integration-ish tests using temp dirs (`5x-cli/test/templates/loader.test.ts`, `5x-cli/test/commands/init.test.ts`).

---

## Strengths

- **Simple, explicit registry:** bundled imports remove runtime file discovery complexity and keep distribution deterministic.
- **Good error surfaces:** template-frontmatter validation errors include template names and actionable messages.
- **Init idempotency:** `.gitignore` append logic handles missing file, duplicates, and trailing newline edge.
- **Test coverage is pragmatic:** most behaviors that could regress (missing vars, unknown template, init overwrite/skip) are covered.

---

## Production readiness blockers

### P0.1 - Escaped literal `{{...}}` handling is incorrect

**Risk (correctness/operability):** Template author cannot include literal `{{token}}` examples (e.g., documenting placeholders, showing protocol examples) despite the plan/commit claiming `\\{{` escape support; `renderTemplate()` will throw due to the unresolved-variable check.

**Requirement:** `\{{foo}}` in a template must render to literal `{{foo}}` without substitution and without triggering the unresolved-variable error.

**Implementation guidance:** treat escaped open braces as a sentinel before substitution/unresolved checks, then restore after (or make unresolved-variable detection ignore previously-escaped tokens); add a focused regression test in `5x-cli/test/templates/loader.test.ts`.

---

## High priority (P1)

### P1.1 - Enforce frontmatter `name` matches registry key

`loadTemplate(name)` returns `metadata.name` without asserting it equals the registry key. A mismatch would silently confuse `listTemplates()` outputs and downstream routing. Recommendation: validate `fm.name === templateName` in `parseTemplate()`.

### P1.2 - Cache parsed templates (avoid repeated YAML parse)

`listTemplates()` currently parses YAML for every template on each call; `renderTemplate()` re-parses per render. Low scale today, but caching parsed results is easy and avoids avoidable overhead.

---

## Medium priority (P2)

- **Signal-block safety hardening:** variables substituted into prompt examples that contain `<!-- ... -->` blocks should be validated to not contain newlines or `-->` (defense-in-depth against confusing the agent and downstream parsers).
- **Variable naming flexibility:** `[a-z_]+` is fine for now, but consider allowing digits if future templates want `phase_1`-style names.

---

## Readiness checklist

**P0 blockers**
- [ ] Fix escaped literal `{{...}}` rendering; add regression test.

**P1 recommended**
- [ ] Assert frontmatter `name` matches registry key.
- [ ] Cache parsed templates to avoid repeated YAML parsing.

---

## Readiness assessment vs implementation plan

- **Phase 3 completion:** ⚠️ - checklist is mostly satisfied, but escape semantics are currently incorrect and untested.
- **Ready for next phase (Phase 4: Plan Generation + Review Loop):** ⚠️ - proceed after P0.1 is fixed (mechanical) so templates are reliable for subsequent orchestration.

<!-- 5x:verdict
protocolVersion: 1
readiness: ready_with_corrections
reviewPath: 5x-cli/docs/development/reviews/2026-02-16-5x-cli-phase-3-templates-init-review.md
items:
  - id: p0-1
    title: Fix escaped literal {{...}} handling in template renderer
    action: auto_fix
    reason: Current escape logic conflicts with unresolved-variable check and lacks regression coverage
  - id: p1-1
    title: Validate frontmatter name matches registry key
    action: auto_fix
    reason: Prevents silent template identity mismatches across list/render APIs
  - id: p1-2
    title: Cache parsed templates to avoid repeated YAML parsing
    action: auto_fix
    reason: Improves efficiency and reduces repeated parsing work without changing behavior
  - id: p2-1
    title: Validate rendered signal-block variables are safe scalars
    action: auto_fix
    reason: Defense-in-depth against newline or comment-terminator injection into protocol examples
-->

---

## Addendum (2026-02-16) - Validation of remediation commit

**Reviewed:** `31b8cdef`

**Local verification:** `cd 5x-cli && bun test` PASS (197 pass, 1 skip); `bun run typecheck` PASS; `bun run lint` PASS

### What's addressed (✅)

- **P0.1 escaped literal braces:** `\{{...}}` now renders to literal `{{...}}` via a sentinel approach and no longer trips unresolved-variable detection; regression tests added (`5x-cli/src/templates/loader.ts`, `5x-cli/test/templates/loader.test.ts`).
- **P1.1 frontmatter name vs registry key:** hard validation added in `parseTemplate()`; tests ensure bundled templates pass (`5x-cli/src/templates/loader.ts`, `5x-cli/test/templates/loader.test.ts`).
- **P1.2 parsed template caching:** `loadTemplate()` now caches parsed results; tests verify stable reference reuse (`5x-cli/src/templates/loader.ts`, `5x-cli/test/templates/loader.test.ts`).
- **P2-1 signal-block safety:** declared variable values are validated to reject newlines and `-->`; regression tests added (`5x-cli/src/templates/loader.ts`, `5x-cli/test/templates/loader.test.ts`).

### Remaining concerns

- No further required changes from this review.

### Updated readiness

- **Phase 3 completion:** ✅ - all items from the initial review are addressed with tests and local suite green.
- **Ready for next phase (Phase 4: Plan Generation + Review Loop):** ✅

<!-- 5x:verdict
protocolVersion: 1
readiness: ready
reviewPath: 5x-cli/docs/development/reviews/2026-02-16-5x-cli-phase-3-templates-init-review.md
items: []
-->
