# Orchestration Reliability Improvements

**Version:** 1.2
**Created:** March 17, 2026
**Status:** Draft

### Revision History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-17 | Initial draft |
| 1.1 | 2026-03-17 | Address review feedback (review round 1): P0.1 — narrow session enforcement default to `false`, require explicit opt-in per template set; P0.2 — define `protocol emit` raw stdout contract (no `outputSuccess` envelope); P1.1 — reorder session validation so `--new-session` skips continued-template check; P1.2 — change missing `action` default from `auto_fix` to `human_required`; P2 — tighten Phase 3 dependency note. |
| 1.2 | 2026-03-17 | Address review addendum 2: align `protocol emit` error-path contract — success writes raw JSON, errors use `outputError()` (standard `{ ok: false, error }` envelope to stdout with non-zero exit); updated Design Decisions, handler (3e), and integration tests (3j) to agree on the same convention. |

## Overview

Post-mortem analysis of a 5x plan review orchestration session revealed four
categories of friction that reduced reliability and increased manual
intervention. This plan addresses each with targeted tooling and skill
improvements:

1. **Review file misplacement.** The orchestrator passed an explicit
   `--var review_path` that bypassed correct auto-generation, placing the
   review file adjacent to the plan instead of in the configured reviews
   directory. The auto-generation logic already works correctly — the problem
   is that explicit overrides silently win without warning.

2. **Session continuity not enforced.** The orchestrator never reused
   reviewer sessions across review iterations, causing redundant context
   loading and wasted tokens. The infrastructure for session reuse exists
   (continued templates, provider session resumption, DB session tracking)
   but the skill describes it as "optional and best-effort," so the
   orchestrator ignored it.

3. **Reviewer structured output schema non-compliance.** Native subagents
   (Task tool) lack API-level structured output constraints. The reviewer
   produced `verdict`/`issues`/`severity` instead of the expected
   `readiness`/`items`/`action` field names, requiring manual translation.
   The `5x invoke` provider path enforces the schema at the API level, but
   the native subagent path relies solely on prompt instructions.

4. **Protocol validator rejects plan revision recordings.** `5x protocol
   validate author --record --phase plan` triggers the phase checklist gate,
   which searches for a phase named "plan" in the plan file. Since the plan
   parser only recognizes numeric phase headings (`Phase 1`, `Phase 2.1`),
   the lookup fails with `PHASE_NOT_FOUND`. The checklist gate is also
   semantically wrong for plan review — there are no completed checklist
   items to validate before execution begins.

## Design Decisions

**Review path: warn on override, don't block.** The auto-generation logic in
`generateReviewPath()` correctly places reviews in the configured directory.
Rather than removing the ability to override (which has legitimate uses), the
tool emits a warning when `--var review_path` resolves outside the configured
directory. The skill examples are updated to omit `--var review_path` so
auto-generation is the default path. This is A+B: remove from skill examples
(A) and warn on mismatch (B).

**Session continuity: config-driven enforcement.** A new
`continuePhaseSessions` boolean on the `[author]` and `[reviewer]` config
sections controls whether session reuse is enforced. When enabled, the tool
requires `--session <id>` or `--new-session` when prior steps exist for the
same run/step/phase. Enforcement is scoped per-phase: new phases always start
clean, and the prior-step check queries `(run_id, step_name, phase)`.

The config flag (rather than implicit detection from continued-template
existence) makes the enforcement explicit and operator-controlled. If the
flag is `true` and no `-continued` template variant exists when one is needed,
the tool errors — forcing template completeness.

Role is inferred from the template's `step_name` prefix (`reviewer:*` →
reviewer config, `author:*` → author config), avoiding a new `--role` flag.
Phase is derived automatically for plan-review templates (`"plan"`) or from
`--var phase_number` for implementation templates. If phase can't be
determined, enforcement is skipped (graceful degradation).

Default is `false` for both `[author]` and `[reviewer]`. The scaffolded
`5x.default.toml` keeps the default as `false` with a comment explaining the
option. Projects opt in explicitly once they have confirmed that all relevant
templates have `-continued` variants. This avoids shipping a default that
breaks existing review loops where no continued template exists (e.g.,
`reviewer-commit` has no `reviewer-commit-continued` variant today).

**Structured output: `5x protocol emit` command.** Instead of relying on the
native subagent to produce schema-conforming JSON from memory, provide a CLI
tool the agent calls to produce its structured output. The agent invokes
`5x protocol emit reviewer` or `5x protocol emit author` with human-friendly
flags, and the tool outputs canonical JSON. The schema lives in the tool,
not in the agent's memory.

**`protocol emit` stdout contract.** Two distinct paths:

- **Success (exit 0):** Write raw canonical JSON to stdout — no
  `outputSuccess()` envelope. The agent includes this stdout verbatim as its
  structured result. This matches the schema expected by provider
  structured-output validation and by `5x protocol validate`. The `5x invoke`
  pipeline already handles both raw JSON and `outputSuccess` envelopes via
  `extractResult()`, but raw JSON is the correct path for `emit` because the
  agent is the one returning the JSON to the provider, not the CLI returning
  it to a caller. Template instructions say: "Include the command's JSON
  output as your structured result."

- **Error (exit ≠ 0):** Use `outputError()` like every other CLI command.
  This writes the standard `{ ok: false, error: { code, message } }` envelope
  to stdout (per the CLI's global error-handling convention in `bin.ts`). The
  non-zero exit code tells the agent the command failed; the agent reads the
  error envelope to understand why (e.g., missing flags, validation failure)
  and either retries or reports the failure. The agent does **not** include
  error output in its structured result.

The `emit` command also accepts JSON on stdin for normalization — mapping
alternative field names (`verdict` → `readiness`, `issues` → `items`,
`severity` → `priority`) to the canonical schema. This normalization logic
is the single source of truth shared with `5x protocol validate`, which
uses it as a safety net when agents don't use `emit`.

Reviewer templates are updated to make `emit` the mandatory output mechanism.
Author templates are updated similarly.

**Reviewer readiness flags.** Two orthogonal flags instead of three mutually
exclusive ones:

- `--ready` / `--no-ready` — required, sets the readiness assessment
- `--item <json>` — repeatable, implies corrections when present

The presence of items determines the readiness mapping:

| `--[no]-ready` | Items present | Maps to                       |
|----------------|---------------|-------------------------------|
| `--ready`      | no            | `"ready"`                     |
| `--ready`      | yes           | `"ready_with_corrections"`    |
| `--no-ready`   | yes           | `"not_ready"`                 |
| `--no-ready`   | no            | `"not_ready"` (escalate)      |

The `--no-ready` without items case produces `{"readiness":"not_ready","items":[]}`
and the orchestrator escalates (the skill already routes "not_ready with no
actionable items" to the human). The `assertReviewerVerdict` invariant is
relaxed from hard error to warning for empty items.

**Plan revision checklist gate: auto-skip for non-numeric phases.** When the
`--phase` value doesn't match the plan parser's numeric format
(`/^\d+(?:\.\d+)?$/`), the checklist gate is skipped instead of failing with
`PHASE_NOT_FOUND`. Non-numeric phase values like `"plan"` are semantic context
identifiers, not plan file phase references. The skill is also updated to
pass `--no-phase-checklist-validate` explicitly for belt-and-suspenders
clarity.

## Phase 1: Review Path Override Warning

Add a warning when `--var review_path` resolves outside the configured review
directory. Update skill examples to omit `--var review_path` so
auto-generation is the default.

- [x] **1a. Add `checkReviewPathMismatch` helper to `src/commands/template-vars.ts`**

  Add function that compares an explicit `review_path` against the configured
  review directory. Uses `isPlanReviewTemplate()` to determine whether to
  check `config.paths.planReviews ?? config.paths.reviews` (plan reviews) or
  `config.paths.runReviews ?? config.paths.reviews` (implementation reviews).
  Resolves both paths against `projectRoot` for comparison. Returns a warning
  string if the explicit path's parent directory differs from the configured
  directory, `null` otherwise.

  Warning text format:
  `review_path "<explicit>" resolves outside configured review directory "<configured>". Omit --var review_path to use the auto-generated path.`

- [x] **1b. Add `warnings` to `ResolvedTemplate` and `resolveAndRenderTemplate`**

  Add `warnings: string[]` field to the `ResolvedTemplate` interface in
  `src/commands/template-vars.ts`. In `resolveAndRenderTemplate`, after
  variable resolution, if `opts.explicitVars.review_path` was provided,
  call `checkReviewPathMismatch`. Collect any warnings into the array.

- [x] **1c. Surface warnings in template render output**

  In `src/commands/template.handler.ts`:
  - Add `warnings?: string[]` to `TemplateRenderOutput`
  - After `resolveAndRenderTemplate`, if warnings exist, include in the
    envelope data and write each to stderr for human visibility

- [x] **1d. Surface warnings in invoke output**

  In `src/commands/invoke.handler.ts`:
  - Add `warnings?: string[]` to `InvokeResult`
  - Same pattern: surface warnings from template resolution in both the
    envelope and stderr

- [x] **1e. Update skill to omit `--var review_path`**

  In `src/skills/5x-plan-review/SKILL.md`:
  - Remove `--var review_path=$REVIEW_PATH` from all `5x template render`
    and `5x invoke` code examples (lines 76, 91-92, 141, 151, 195, 203)
  - Remove `$REVIEW_PATH` tracking variable (line 133). Add note: read
    `review_path` from `.data.variables.review_path` in the template render
    output
  - Update "Review document is at $REVIEW_PATH" (line 251) and the invariant
    "review file must exist at $REVIEW_PATH" (line 258) to reference the
    auto-generated path from the render output

- [x] **1f. Unit tests for `checkReviewPathMismatch`**

  New file `test/unit/commands/template-vars.test.ts` (or add to existing):
  - Test: explicit path in configured directory → returns null
  - Test: explicit path outside configured directory → returns warning string
  - Test: plan-review template uses `planReviews`/`reviews` config
  - Test: impl-review template uses `runReviews`/`reviews` config

- [x] **1g. Integration tests for review path warnings**

  In `test/integration/commands/template-render.test.ts`:
  - New test: "warns when explicit review_path is outside configured review
    directory" — setup project with default config, pass
    `--var review_path=docs/development/wrong-place.md` with `--run`, assert
    `data.warnings` contains mismatch message
  - New test: "no warning when explicit review_path matches configured
    directory" — pass `--var review_path=<configured-dir>/custom.md`, assert
    `data.warnings` is empty or absent
  - Verify existing test "explicit --var review_path overrides auto-generated
    value" (line 685) still passes — the override still works, warning is
    additive

## Phase 2: Session Management Enforcement

Add `continuePhaseSessions` config option and `--new-session` CLI flag.
Enforce session continuity when configured: require `--session <id>` or
`--new-session` when prior steps exist for the same run/step/phase.

- [ ] **2a. Add `continuePhaseSessions` to config schema**

  In `src/config.ts`, add to `AgentConfigSchema`:
  ```ts
  continuePhaseSessions: z.boolean().default(false),
  ```

  In `src/templates/5x.default.toml`:
  - Under `[reviewer]`, add commented-out `# continuePhaseSessions = false`
    with an explanatory comment: `# Enable after confirming all reviewer
    templates have -continued variants`
  - Under `[author]`, add commented-out `# continuePhaseSessions = false`

- [ ] **2b. Add `--new-session` CLI flag**

  In `src/commands/template.ts`:
  - Add `.option("--new-session", "Force a new session (skip continued-template selection)")`
  - Pass `newSession: opts.newSession` to handler

  In `src/commands/invoke.ts`:
  - Add `.option("--new-session", "Force a new session instead of resuming")`
    to `addInvokeOptions`
  - Pass `newSession: opts.newSession` in both author and reviewer actions

  In `src/commands/template.handler.ts`:
  - Add `newSession?: boolean` to `TemplateRenderParams`

  In `src/commands/invoke.handler.ts`:
  - Add `newSession?: boolean` to `InvokeParams`

- [ ] **2c. Session validation helper**

  New file `src/commands/session-check.ts`. Export `validateSessionContinuity`:

  ```ts
  interface SessionCheckOptions {
    templateName: string;
    session?: string;
    newSession?: boolean;
    runId?: string;
    db?: Database;
    config: Pick<FiveXConfig, "author" | "reviewer">;
    explicitVars?: Record<string, string>;
  }
  ```

  Logic:
  1. Mutual exclusivity: if both `session` and `newSession` →
     `INVALID_ARGS` error
  2. Early exit if no `runId` or no `db` (no run context)
  3. Load template metadata via `loadTemplate(templateName)`. Extract role
     from `step_name` prefix (`reviewer:*` → `"reviewer"`,
     `author:*` → `"author"`). If role undetermined → return
  4. Check `config[role].continuePhaseSessions`. If false → return
  5. Derive phase: if `isPlanReviewTemplate(templateName)` → `"plan"`;
     else `explicitVars?.phase_number ?? null`. If null → return (can't
     scope the check)
  6. Query: `SELECT COUNT(*) FROM steps WHERE run_id = ?1 AND step_name = ?2 AND phase IS ?3`
  7. If prior steps exist:
     - If `newSession` is true → return (skip all further checks;
       `--new-session` is the recovery escape hatch and always uses the
       full template — no continued-template requirement)
     - If `session` is provided → verify the continued template exists.
       Try `loadTemplate(templateName + "-continued")`. If not found →
       `TEMPLATE_NOT_FOUND` error: `"${role}.continuePhaseSessions is enabled
       and prior "${stepName}" steps exist for phase "${phase}", but no
       "${templateName}-continued" template was found."`
       If found → return (valid resumption)
     - If neither `session` nor `newSession` → check continued-template
       existence first. If no continued template exists →
       `TEMPLATE_NOT_FOUND` error (same as above). If continued template
       exists → `SESSION_REQUIRED` error: `"Template "${templateName}" has
       session continuity enabled and prior "${stepName}" steps exist for
       run "${runId}" phase "${phase}". Pass --session <id> to continue or
       --new-session to start fresh."`

- [ ] **2d. Add `SESSION_REQUIRED` error code**

  In `src/output.ts`, add `SESSION_REQUIRED: 9` to `EXIT_CODE_MAP`.

- [ ] **2e. Integrate validation in handlers**

  In `src/commands/template.handler.ts`:
  - After DB open + run context resolution, before `resolveAndRenderTemplate`:
    call `validateSessionContinuity({ templateName, session, newSession,
    runId, db, config, explicitVars })`
  - When `newSession` is true, pass `session: undefined` to
    `resolveAndRenderTemplate` (ensures full template is selected)

  In `src/commands/invoke.handler.ts`:
  - Same validation call after DB/run context resolution
  - When `newSession` is true: call `provider.startSession()` (not
    `resumeSession`), and pass `session: undefined` to
    `resolveAndRenderTemplate`

- [ ] **2f. Respect `--new-session` in template selection**

  In `src/commands/template-vars.ts` `resolveAndRenderTemplate`:
  - Add `newSession?: boolean` to `ResolveAndRenderOptions`
  - In the continued-template selection block: skip continued-template probe
    when `newSession` is true. `--new-session` always means full template.

- [ ] **2g. Update skill file**

  In `src/skills/5x-plan-review/SKILL.md`:
  - Replace "optional and best-effort" (lines 100-104) with: "Session reuse
    is expected when `reviewer.continuePhaseSessions` is enabled. The tool
    enforces this: if a prior reviewer step exists for the current phase,
    `--session <id>` or `--new-session` is required. Use `--new-session`
    only for recovery (context loss, empty output)."
  - Add a note that projects using plan-review should enable
    `reviewer.continuePhaseSessions = true` in their `5x.toml` (it is not
    enabled by default — the plan-review skill is the canonical use case
    that warrants opt-in)
  - Update canonical delegation example (lines 73-97) to show session
    lifecycle: first review without flags, capture `$REVIEWER_SESSION`,
    subsequent reviews with `--session $REVIEWER_SESSION`
  - Update workflow Step 1 (lines 139-166) with
    `${REVIEWER_SESSION:+--session $REVIEWER_SESSION}` pattern
  - Update Recovery section to mention `--new-session` as the recovery flag

- [ ] **2h. Unit tests for session validation**

  New file `test/unit/commands/session-check.test.ts`:
  - Test: mutual exclusivity (both session and newSession → error)
  - Test: config disabled → no enforcement
  - Test: no prior steps → no enforcement
  - Test: prior steps exist, no flags, continued template exists →
    SESSION_REQUIRED error
  - Test: prior steps exist, no flags, no continued template →
    TEMPLATE_NOT_FOUND error
  - Test: prior steps exist, session provided, continued template exists →
    no error
  - Test: prior steps exist, session provided, no continued template →
    TEMPLATE_NOT_FOUND error
  - Test: prior steps exist, newSession → no error (skips continued-template
    check entirely; `--new-session` is the recovery escape hatch)
  - Test: role inference from step_name prefix
  - Test: phase derivation (plan-review → "plan", explicit phase_number)
  - Test: no run context → no enforcement

- [ ] **2i. Integration tests for session enforcement**

  In `test/integration/commands/template-render.test.ts`:

  Add helper: `insertStep(dir, runId, stepName, phase)` to insert a step
  row directly into the DB.

  New tests:
  - "first review succeeds without session flags when continuePhaseSessions
    enabled" — config with `reviewer.continuePhaseSessions = true`, insert
    run (no prior steps), render `reviewer-plan --run $RUN`, assert success
  - "SESSION_REQUIRED when prior step exists and no session flag" — insert
    run + prior `reviewer:review` step with phase `"plan"`, render without
    flags, assert error code `SESSION_REQUIRED`
  - "--session selects continued template on subsequent review" — insert
    run + prior step, render with `--session sess_123`, assert
    `selected_template = "reviewer-plan-continued"`
  - "--new-session uses full template on subsequent review" — insert run +
    prior step, render with `--new-session`, assert
    `selected_template = "reviewer-plan"`
  - "--session and --new-session together errors" — assert `INVALID_ARGS`
  - "no enforcement for template without continued variant when
    continuePhaseSessions disabled" — config with `false`, insert run +
    prior `author:implement` step, render `author-next-phase --run $RUN`,
    assert success
  - "TEMPLATE_NOT_FOUND when continuePhaseSessions enabled but no continued
    variant and --session used" — config with
    `reviewer.continuePhaseSessions = true`, insert run + prior step for
    `reviewer:review` phase `"phase-1"`, render
    `reviewer-commit --run $RUN --var phase_number=1 --session sess_123`,
    assert error about missing `reviewer-commit-continued`
  - "--new-session bypasses TEMPLATE_NOT_FOUND for missing continued variant"
    — same setup as above but render with `--new-session` instead of
    `--session`, assert success (full template selected)
  - "no enforcement without --run" — render `reviewer-plan` without `--run`,
    assert success regardless of flags
  - "phase scoping: new phase has no prior steps" — insert run + prior step
    for phase `"phase-1"`, render with `--var phase_number=2`, assert
    success (no prior steps in phase-2)
  - Verify existing "continued-template selection with --session" test
    (line 255) still passes (no `--run`, no enforcement)

## Phase 3: Protocol Emit Command and Shared Normalization

Add `5x protocol emit` command that agents call to produce schema-conforming
structured output. Extract normalization logic into a shared module used by
both `emit` and `validate`.

- [ ] **3a. Shared normalization module**

  New file `src/protocol-normalize.ts`:

  `normalizeReviewerVerdict(input: unknown): object` — maps alternative
  field names to canonical schema:
  - Top-level: `verdict` → `readiness` (with value mapping: `"rejected"` →
    `"not_ready"`, `"approved"` → `"ready"`, `"conditionally_approved"` →
    `"ready_with_corrections"`)
  - Top-level: `issues` → `items`
  - Per-item: `severity` → `priority` (with mapping: `"critical"` → `"P0"`,
    `"major"` → `"P0"`, `"moderate"` → `"P1"`, `"minor"` → `"P2"`)
  - Per-item: auto-generates `id` if missing (`"R1"`, `"R2"`, ...)
  - Per-item: defaults `action` to `"human_required"` if missing (conservative
    default — missing action should not silently route to the least-safe
    automation path; this aligns with the reviewer instructions that say
    ambiguous items should lean `human_required`)
  - Passes through already-conforming input unchanged

  `normalizeAuthorStatus(input: unknown): object` — maps alternative field
  names:
  - `status` → `result` (with value mapping: `"done"` → `"complete"`,
    `"blocked"` → `"needs_human"`, `"error"` → `"failed"`)
  - Passes through already-conforming input unchanged
  - Replaces `normalizeLegacyAuthorStatus` in `protocol-helpers.ts`

- [ ] **3b. Wire normalization into `5x protocol validate`**

  In `src/commands/protocol-helpers.ts`:
  - Replace inline `normalizeLegacyAuthorStatus` call with
    `normalizeAuthorStatus` from the shared module
  - Add `normalizeReviewerVerdict` call for the reviewer path (currently
    no normalization exists for reviewer — this is the safety net)

- [ ] **3c. Relax `assertReviewerVerdict` for empty items**

  In `src/protocol.ts`, change the `items` invariant for `not_ready` with
  empty items from a hard error to a warning field on the return value.
  The verdict is still valid — the orchestrator routes it to escalation.
  Add a `warnings: string[]` field to the assertion result (or return a
  structured object instead of throwing).

- [ ] **3d. Register `5x protocol emit` command**

  In `src/commands/protocol.ts`, add two subcommands under `protocol emit`:

  `5x protocol emit reviewer`:
  ```
  --[no]-ready       Required. Readiness assessment.
  --item <json>      Repeatable. Review item as JSON. Implies corrections.
  --summary <text>   Optional. 1-3 sentence assessment.
  ```

  `5x protocol emit author`:
  ```
  --complete         Result: work finished (mutually exclusive with below)
  --needs-human      Result: human intervention needed
  --failed           Result: unable to complete
  --commit <hash>    Required with --complete
  --reason <text>    Required with --needs-human or --failed
  --notes <text>     Optional
  ```

  Both support stdin fallback: if no result/readiness flags are provided and
  stdin is piped, read JSON from stdin and normalize it.

- [ ] **3e. Protocol emit handler**

  New file `src/commands/protocol-emit.handler.ts`:

  `protocolEmitReviewer(params)`:
  1. Validate flags: `--ready` or `--no-ready` required (unless stdin mode)
  2. Parse `--item` JSON strings (repeatable via `collect`)
  3. Assemble object: derive `readiness` from flags + item presence
     (`--ready` + items → `"ready_with_corrections"`, `--ready` no items →
     `"ready"`, `--no-ready` + items → `"not_ready"`, `--no-ready` no
     items → `"not_ready"`)
  4. Run through `normalizeReviewerVerdict` (handles defaults, id
     generation)
  5. Validate via `assertReviewerVerdict`
  6. Write raw canonical JSON to stdout via `process.stdout.write(
     JSON.stringify(result))`. Do **not** use `outputSuccess()` — the agent
     includes this output directly as its structured result, and the
     `{ ok, data }` envelope would not match the provider schema contract.
  7. On validation or flag errors: use `outputError()` — this follows the
     standard CLI error convention (writes `{ ok: false, error }` to stdout
     with non-zero exit code). The agent distinguishes success from failure
     by exit code and does not include error output in its structured result.

  `protocolEmitAuthor(params)`:
  1. Validate flags: exactly one of `--complete`, `--needs-human`, `--failed`
  2. Validate conditional requirements: `--commit` with `--complete`,
     `--reason` with `--needs-human`/`--failed`
  3. Assemble object
  4. Run through `normalizeAuthorStatus`
  5. Validate via `assertAuthorStatus`
  6. Write raw canonical JSON to stdout (same contract as reviewer emit).
  7. On errors: use `outputError()` (same contract as reviewer emit).

  Stdin fallback for both: if no primary flags and stdin is piped, read
  JSON, normalize, validate, output raw canonical JSON to stdout.

- [ ] **3f. Update reviewer templates to use `emit`**

  In `src/templates/reviewer-plan.md` and `src/templates/reviewer-commit.md`:
  - Replace "Your structured response will include: readiness, items,
    summary" with instructions to call `5x protocol emit reviewer`:
    ```
    When your review is complete, produce your structured verdict by running:

        5x protocol emit reviewer --not-ready \
          --item '{"title":"...","action":"auto_fix","reason":"..."}' \
          --summary "..."

    Use --ready or --no-ready. Items imply corrections.
    Include the command's JSON output verbatim as your structured result.
    The output is raw canonical JSON — do not wrap or modify it.
    ```

  In `src/templates/reviewer-plan-continued.md`:
  - Add brief reference to the same `emit` pattern

- [ ] **3g. Update author templates to use `emit`**

  In `src/templates/author-next-phase.md`,
  `src/templates/author-process-plan-review.md`,
  `src/templates/author-process-impl-review.md`,
  `src/templates/author-fix-quality.md`:
  - Replace structured output instructions with `5x protocol emit author`
    usage:
    ```
    When finished, produce your structured result by running:

        5x protocol emit author --complete --commit <hash>

    Or if you need human help:

        5x protocol emit author --needs-human --reason "..."
    ```

- [ ] **3h. Unit tests for normalization**

  New file `test/unit/protocol-normalize.test.ts`:

  Reviewer normalization:
  - Test: canonical input passes through unchanged
  - Test: `verdict` → `readiness` mapping (`"rejected"` → `"not_ready"`, etc.)
  - Test: `issues` → `items` mapping
  - Test: per-item `severity` → `priority` mapping
  - Test: auto-generates missing `id` fields
  - Test: defaults missing `action` to `"human_required"`
  - Test: mixed canonical and alternative fields (partial normalization)

  Author normalization:
  - Test: canonical input passes through unchanged
  - Test: `status` → `result` mapping (`"done"` → `"complete"`, etc.)
  - Test: replaces legacy `normalizeLegacyAuthorStatus` behavior

- [ ] **3i. Unit tests for emit handler**

  New file `test/unit/commands/protocol-emit.test.ts`:

  Reviewer emit:
  - Test: `--ready` with no items → `{"readiness":"ready","items":[]}`
  - Test: `--ready` with items → `{"readiness":"ready_with_corrections",...}`
  - Test: `--no-ready` with items → `{"readiness":"not_ready",...}`
  - Test: `--no-ready` without items → `{"readiness":"not_ready","items":[]}`
  - Test: auto-generates item ids when missing
  - Test: defaults item action to `"human_required"` when missing
  - Test: `--summary` included in output
  - Test: missing `--ready`/`--no-ready` without stdin → error

  Author emit:
  - Test: `--complete --commit abc123` → `{"result":"complete","commit":"abc123"}`
  - Test: `--needs-human --reason "..."` → `{"result":"needs_human","reason":"..."}`
  - Test: `--failed --reason "..."` → `{"result":"failed","reason":"..."}`
  - Test: `--complete` without `--commit` → error
  - Test: `--needs-human` without `--reason` → error
  - Test: multiple result flags → error

- [ ] **3j. Integration tests for `5x protocol emit`**

  New file `test/integration/commands/protocol-emit.test.ts`:

  - Test: end-to-end reviewer emit via subprocess, verify stdout is raw
    canonical JSON (not wrapped in `{ ok, data }`), parses correctly, and
    passes `5x protocol validate reviewer`
  - Test: end-to-end author emit via subprocess, verify raw JSON output
  - Test: stdin normalization mode — pipe non-conforming JSON, verify
    canonical output (raw JSON, no envelope)
  - Test: error cases (missing required flags) — verify non-zero exit code
    and stdout contains standard `{ ok: false, error: { code, message } }`
    envelope (the CLI's global error convention via `outputError()`)

## Phase 4: Plan Revision Checklist Gate Fix

Fix the `PHASE_NOT_FOUND` error when `--phase plan` is used with
`5x protocol validate author --record`. The phase checklist gate should
not fire for non-numeric phase identifiers.

- [ ] **4a. Auto-skip checklist gate for non-numeric phases**

  In `src/commands/protocol.handler.ts` `validatePhaseChecklist`:
  - Before the phase-matching loop, check if the phase value matches the
    numeric format used by the plan parser (`/^\d+(?:\.\d+)?$/` or common
    prefixed forms like `phase-1`, `Phase 2`). Specifically: attempt to
    extract a numeric phase identifier. If the value is purely semantic
    (like `"plan"`, `"review"`, `"setup"`) — not parseable as a plan
    file phase — skip the checklist gate and return early.
  - This is safe because the plan parser's `PHASE_HEADING_RE` requires
    `Phase <number>` — a non-numeric value can never match any parsed
    phase heading.

- [ ] **4b. Update skill to pass `--no-phase-checklist-validate`**

  In `src/skills/5x-plan-review/SKILL.md` Step 3 (lines 207-208):
  - Add `--no-phase-checklist-validate` to the `5x protocol validate author`
    command for plan review recording. Belt and suspenders — explicit intent
    even though 4a handles it automatically.

- [ ] **4c. Tests**

  In `test/integration/commands/` (existing protocol validate test file or
  new file):
  - Test: `--phase plan` with `--record` succeeds (no `PHASE_NOT_FOUND`)
  - Test: `--phase 1` still triggers checklist gate normally
  - Test: `--phase setup` (non-numeric) skips checklist gate

## Files Touched

| File | Phases | Change type |
|------|--------|-------------|
| `src/commands/template-vars.ts` | 1, 2 | Modified — warnings, newSession |
| `src/commands/template.ts` | 2 | Modified — --new-session flag |
| `src/commands/template.handler.ts` | 1, 2 | Modified — warnings, session check |
| `src/commands/invoke.ts` | 2 | Modified — --new-session flag |
| `src/commands/invoke.handler.ts` | 1, 2 | Modified — warnings, session check |
| `src/commands/session-check.ts` | 2 | New — validation helper |
| `src/commands/protocol.ts` | 3 | Modified — emit subcommands |
| `src/commands/protocol.handler.ts` | 4 | Modified — checklist gate |
| `src/commands/protocol-emit.handler.ts` | 3 | New — emit handler |
| `src/commands/protocol-helpers.ts` | 3 | Modified — shared normalization |
| `src/protocol.ts` | 3 | Modified — relax empty items invariant |
| `src/protocol-normalize.ts` | 3 | New — shared normalization module |
| `src/config.ts` | 2 | Modified — continuePhaseSessions |
| `src/output.ts` | 2 | Modified — SESSION_REQUIRED exit code |
| `src/templates/5x.default.toml` | 2 | Modified — commented-out continuePhaseSessions option |
| `src/templates/reviewer-plan.md` | 3 | Modified — emit instructions |
| `src/templates/reviewer-plan-continued.md` | 3 | Modified — emit reference |
| `src/templates/reviewer-commit.md` | 3 | Modified — emit instructions |
| `src/templates/author-next-phase.md` | 3 | Modified — emit instructions |
| `src/templates/author-process-plan-review.md` | 3 | Modified — emit instructions |
| `src/templates/author-process-impl-review.md` | 3 | Modified — emit instructions |
| `src/templates/author-fix-quality.md` | 3 | Modified — emit instructions |
| `src/skills/5x-plan-review/SKILL.md` | 1, 2, 4 | Modified — all three fixes |
| `test/unit/commands/template-vars.test.ts` | 1 | New — warning tests |
| `test/unit/commands/session-check.test.ts` | 2 | New — validation tests |
| `test/unit/protocol-normalize.test.ts` | 3 | New — normalization tests |
| `test/unit/commands/protocol-emit.test.ts` | 3 | New — emit handler tests |
| `test/integration/commands/template-render.test.ts` | 1, 2 | Modified — new tests |
| `test/integration/commands/protocol-emit.test.ts` | 3 | New — e2e emit tests |
| `test/integration/commands/protocol-validate.test.ts` | 4 | New or modified — phase tests |

## Tests

Run with `bun test`. All phases include unit and integration tests.
Phase 1 and 2 add to the existing `template-render.test.ts`. Phase 3 and 4
add new test files. Existing tests must continue to pass — changes are
additive or backward-compatible (config defaults to `false`, warning is
non-breaking, normalization passes through conforming input unchanged,
checklist gate relaxation is strictly less restrictive).

## Estimated Scope

| Phase | Description | Size |
|-------|-------------|------|
| 1 | Review path warning | Small (~100 LOC + tests) |
| 2 | Session enforcement | Medium (~250 LOC + tests) |
| 3 | Protocol emit + normalization | Medium (~400 LOC + tests) |
| 4 | Checklist gate fix | Small (~30 LOC + tests) |

Phases 1, 2, and 4 are independent — no code dependencies between them.
Phase 3 has an internal coupling: it modifies both template instructions
(3f, 3g) and protocol validation/normalization behavior (3a, 3b, 3c)
together. These sub-items within Phase 3 must ship atomically — deploying
updated templates that reference `5x protocol emit` without the `emit`
command and normalization logic would break agent workflows. Rollback for
Phase 3 means reverting all of 3a–3j together.

Suggested execution order: Phase 1, Phase 4, Phase 2, Phase 3 (ascending
complexity; Phase 4 is trivial and unblocks plan review workflows
immediately).

## Not In Scope

- Creating `reviewer-commit-continued.md` template (prerequisite for
  enabling `continuePhaseSessions = true` on implementation reviews —
  follow-up work; until this template exists, enabling the flag for the
  reviewer role will cause `TEMPLATE_NOT_FOUND` on implementation review
  flows, which is why the scaffold default is `false`)
- Adding `action: "informational"` item type for non-actionable review
  observations (future protocol schema extension)
- `5x check` command for validating template completeness against config
  (future tooling)
- Retry-on-schema-failure logic in the skill (the `emit` command makes
  this largely unnecessary; existing recovery logic handles edge cases)
