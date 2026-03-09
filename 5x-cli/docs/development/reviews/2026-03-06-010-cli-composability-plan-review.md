# Review: CLI Composability Implementation Plan

**Review type:** Implementation plan review (`5x-cli/docs/development/010-cli-composability.md`)
**Scope:** Unix-pipe composability for v1 commands: TTY-aware JSON formatting, stdin envelope ingestion, invoke/run-record interoperability, implicit template var fallback, `--var @-`/`@path`, and `--record` sugar
**Reviewer:** Staff engineer (CLI contracts, workflow semantics, reliability, operability)
**Local verification:** Not run (static review: plan + design docs + code inspection)

**Implementation plan:** `5x-cli/docs/development/010-cli-composability.md`
**Technical design:** `5x-cli/docs/v1/100-architecture.md`, `5x-cli/docs/v1/101-cli-primitives.md`, `5x-cli/docs/v1/102-agent-skills.md`, `5x-cli/docs/development/009-run-watch-and-stderr.md`

## Summary

This is a worthwhile feature. The current envelope-only producer model clearly makes shell composition too expensive, and the Phase 1/2 direction (TTY auto-detect, clean stdout/stderr separation, shared pipe utility) fits the repo's recent evolution well.

The plan is not implementation-ready yet. Three issues would cause either broken stdout behavior or incorrect workflow history: `--record` currently reuses a CLI handler that writes its own envelope, the proposed default step names conflict with established workflow semantics, and the `run record` stdin merge logic does not satisfy the plan's own completion gates.

**Readiness:** Not ready -- fix the P0 contract/semantics issues before implementation.

---

## Strengths

- Solves a real ergonomics gap: current scripts burn too much logic on `jq` plumbing instead of workflow intent.
- Builds on recent output-contract work correctly: `skills install` stdout cleanup and TTY-aware JSON are the right first steps (`5x-cli/src/commands/skills.handler.ts:76`, `5x-cli/src/output.ts:99`).
- Shared pipe parsing is the right abstraction boundary; `invoke` and `run record` should not each invent their own stdin envelope rules.
- Preserves the human-first exceptions intentionally: `init` and `upgrade` are already console-oriented commands and should stay that way (`5x-cli/src/commands/init.handler.ts:166`, `5x-cli/src/commands/upgrade.handler.ts:328`).

---

## Production readiness blockers

### P0.1 -- Split recording persistence from CLI output before adding `--record`

**Risk:** The plan says `invoke`/`quality` should call `runV1Record()` internally (`5x-cli/docs/development/010-cli-composability.md:403`). That handler currently performs CLI behavior, not just persistence: it validates args, emits its own success envelope to stdout, and throws `CliError` on failure (`5x-cli/src/commands/run-v1.handler.ts:282`). As written, `invoke --record` would produce multiple stdout payloads on success, and could emit a success envelope followed by an error envelope on failure.

**Requirement:**
- Extract a pure recording service/helper that performs DB validation + `recordStep()` and returns structured results without writing to stdout.
- Keep `runV1Record()` as the CLI wrapper around that helper.
- Have `invoke --record` / `quality --record` call the helper directly and define explicit failure policy for side-effect recording vs primary command success.

**Implementation guidance:**
- Refactor around a shared internal function near `recordStep()` usage (`5x-cli/src/commands/run-v1.handler.ts:331`).
- Do not call `outputSuccess()` or `outputError()` from the internal recording path used by `invoke`/`quality`.

---

### P0.2 -- Preserve semantic `step_name` identity; do not default to template-derived names

**Risk:** The plan proposes auto-populating `step_name` as `${role}:${template}` and `quality:run` (`5x-cli/docs/development/010-cli-composability.md:149`, `5x-cli/docs/development/010-cli-composability.md:167`). That conflicts with the existing workflow contract, examples, and skills, which use semantic step names like `author:implement`, `author:fix-review`, `reviewer:review`, and `quality:check` (`5x-cli/src/skills/5x-phase-execution/SKILL.md:106`, `5x-cli/src/skills/5x-phase-execution/SKILL.md:118`, `5x-cli/src/skills/5x-phase-execution/SKILL.md:154`, `5x-cli/examples/author-review-loop.sh:81`). It also conflicts with the documented reserved step-name semantics in the v1 architecture plan (`5x-cli/docs/development/007-impl-v1-architecture.md:47`). Changing step identity changes idempotency keys, resume logic, and summary interpretation.

**Requirement:**
- Keep workflow step names semantic and stable across manual recording, pipe recording, and `--record`.
- Define an explicit mapping strategy for auto-record flows, or require the caller to provide the step name when semantics are ambiguous.

**Implementation guidance:**
- Preferred: make `--record` require/encourage an explicit step name (`--record-step` or equivalent) for workflow-grade usage.
- If you want defaults, they must map to existing workflow semantics, not template filenames.

---

### P0.3 -- Rewrite stdin resolution so partial overrides still consume the pipe

**Risk:** Phase 3 only reads stdin when both `params.result` and `params.run` are missing (`5x-cli/docs/development/010-cli-composability.md:223`). That does not satisfy the plan's own completion gate `5x quality run | 5x run record --run R1` (`5x-cli/docs/development/010-cli-composability.md:190`), because `--run` is present while `stepName` and `result` still need to come from the pipe. The same bug appears for any "some flags explicit, rest from pipe" path.

**Requirement:**
- Define stdin ingestion based on unresolved required fields, not just `run` + `result` together.
- Make precedence explicit across all consumers: `--result -`, `--var key=@-`, automatic envelope parsing, and explicit flags overriding piped values field-by-field.

**Implementation guidance:**
- Resolve raw-stdin consumers first.
- If stdin remains available and any pipe-resolvable field is missing (`run`, `stepName`, `result`, `phase`, invoke metadata), parse the upstream envelope once and merge.
- Validate after merge, not before.

---

## High priority (P1)

### P1.1 -- Reconcile the plan with the actual `invoke`/`quality` output contracts

Current code is the de facto contract: `invoke` returns `{ result, session_id, duration_ms, tokens: { in, out }, cost_usd, log_path }` (`5x-cli/src/commands/invoke.handler.ts:335`), while `docs/v1/101-cli-primitives.md` still documents older `status`/`verdict` shapes and flat token fields (`5x-cli/docs/v1/101-cli-primitives.md:277`, `5x-cli/docs/v1/101-cli-primitives.md:351`). `quality run` currently returns only `{ passed, results }` (`5x-cli/src/commands/quality-v1.handler.ts:41`). Update the design docs first, then define the new pipe-enriched shapes once.

### P1.2 -- Decide phase propagation semantics explicitly

The plan treats `phase` as if it will always be available from `variables.phase_number`, but current recording semantics allow `phase` to be null and use it in the uniqueness key (`5x-cli/src/db/schema.ts:347`, `5x-cli/src/db/operations-v1.ts:108`). Decide whether auto-recorded author/reviewer/quality steps may legitimately be phase-less, and what that means for resumability and duplicate detection.

### P1.3 -- Use a dedicated pipe detector; do not reuse prompt-oriented TTY helpers

`src/utils/stdin.ts` is built for interactive prompts, including `/dev/tty` fallback and test overrides (`5x-cli/src/utils/stdin.ts:50`). That is correct for prompts, wrong for envelope ingestion. A dedicated `isStdinPiped()` + raw reader in `src/pipe.ts` is the safer design.

### P1.4 -- Decide whether invocation metadata should include `model`

`RunRecordParams` and the DB both support `model` (`5x-cli/src/commands/run-v1.handler.ts:64`, `5x-cli/src/db/schema.ts:354`), but `RunResult` and `invoke` output do not expose it (`5x-cli/src/providers/types.ts:59`, `5x-cli/src/commands/invoke.handler.ts:335`). Either add `model` to the pipe/record contract or explicitly drop it from the plan's metadata claims.

---

## Medium priority (P2)

- **Implicit template var scope:** injecting every string `data.*` field is convenient, but noisy; consider a documented exclusion list broader than `session_id`/`log_path`/`step_name` if accidental collisions show up.
- **TTY auto-detect tests:** add adapter-level coverage for `--pretty`/`--no-pretty` parsing in `bin.ts`, not just serializer behavior.
- **Quality metadata:** if quality is meant to compose as a first-class primitive, consider whether it should eventually emit richer run/phase metadata instead of only `step_name`.

---

## Readiness checklist

**P0 blockers**
- [ ] Recording side effects are split from CLI envelope output before `--record` is implemented
- [ ] Auto-record / pipe-record step naming preserves existing workflow semantics
- [ ] `run record` stdin merge logic supports partial explicit overrides and matches the documented completion gates

**P1 recommended**
- [ ] `invoke` and `quality` output contracts are updated in docs before pipe consumers are built on top
- [ ] Phase propagation/null-phase semantics are explicitly defined for auto-recorded steps
- [ ] `src/pipe.ts` uses dedicated pipe detection rather than prompt TTY helpers
- [ ] Metadata contract explicitly includes or excludes `model`

---

## Addendum (2026-03-07) -- Re-review after plan revisions

**Reviewed:** `5x-cli/docs/development/010-cli-composability.md` (v1.2)

### What's addressed (✅)

- **P0.1 double-envelope risk:** Plan now separates persistence from CLI output via `recordStepInternal()` and explicitly forbids `invoke`/`quality` from calling `runV1Record()` directly (`5x-cli/docs/development/010-cli-composability.md:45`, `5x-cli/docs/development/010-cli-composability.md:294`, `5x-cli/docs/development/010-cli-composability.md:540`).
- **P0.2 semantic step names:** Template-derived `role:template` defaults are gone. The plan now uses semantic `step_name` values defined in template frontmatter, with `--record-step` only as an override (`5x-cli/docs/development/010-cli-composability.md:22`, `5x-cli/docs/development/010-cli-composability.md:47`, `5x-cli/docs/development/010-cli-composability.md:103`).
- **P0.3 partial override flow:** The main broken case from the first review is fixed. The plan now explicitly supports `5x quality run | 5x run record "quality:check" --run R1` and validates after merge (`5x-cli/docs/development/010-cli-composability.md:43`, `5x-cli/docs/development/010-cli-composability.md:292`, `5x-cli/docs/development/010-cli-composability.md:347`).
- **P1 contract cleanup:** The revised plan now calls out the stale `docs/v1/101-cli-primitives.md` invoke examples and updates them before pipe-enriched fields are added (`5x-cli/docs/development/010-cli-composability.md:61`, `5x-cli/docs/development/010-cli-composability.md:97`).
- **P1 phase/null semantics:** The plan now explicitly defines null-phase behavior instead of assuming all auto-recorded steps are phase-scoped (`5x-cli/docs/development/010-cli-composability.md:57`).
- **P1 stdin detection + model propagation:** The dedicated pipe-detector requirement and `model` enrichment are now explicit (`5x-cli/docs/development/010-cli-composability.md:55`, `5x-cli/docs/development/010-cli-composability.md:59`).

### Remaining concerns

### P2 -- Pre-release tester compatibility for scaffolded prompt templates

This is not a deployment blocker if v1 has not shipped yet. Still, for local branch testers, the plan makes `step_name` required in template frontmatter (`5x-cli/docs/development/010-cli-composability.md:22`, `5x-cli/docs/development/010-cli-composability.md:103`), while template loading prefers on-disk project overrides in `.5x/templates/prompts/` (`5x-cli/src/templates/loader.ts:187`) and current `init`/`upgrade` scaffolding skips existing prompt files unless forced (`5x-cli/src/commands/init.handler.ts:105`, `5x-cli/src/commands/upgrade.handler.ts:297`). So older locally scaffolded prompt copies may fail after this change.

**Recommendation:**
- Track this as a pre-release compatibility cleanup, not a P0 blocker.
- Before merge/release, either teach `upgrade` to patch missing `step_name` non-destructively, or provide a temporary loader fallback for known templates with a warning.

### P1 -- `recordStepInternal()` needs structured domain errors, not plain `Error`

The revised plan improves the side-effect boundary, but it over-corrects by specifying that `recordStepInternal()` throws plain `Error` on validation failures (`5x-cli/docs/development/010-cli-composability.md:308`). `runV1Record()` currently has structured CLI failure behavior (`RUN_NOT_FOUND`, `RUN_NOT_ACTIVE`, `MAX_STEPS_EXCEEDED`, `INVALID_JSON`, etc.) (`5x-cli/src/commands/run-v1.handler.ts:286`). A plain error loses code/detail unless the wrapper reparses messages.

**Recommendation:**
- Use a small typed domain error/result shape (`code`, `message`, optional `detail`) for `recordStepInternal()`.
- Keep stdout concerns out of the helper, but preserve machine-meaningful failure classification.

### P1 -- Clarify explicit `--result` vs pipe-fallback semantics; the doc still says two different things

The design section says stdin is read whenever any pipe-resolvable field is unset (`5x-cli/docs/development/010-cli-composability.md:43`), but the Phase 3 pseudocode only parses the envelope when `!params.result` (`5x-cli/docs/development/010-cli-composability.md:356`). The risk section then says that if the user pipes data and provides `--result` explicitly, the pipe is ignored (`5x-cli/docs/development/010-cli-composability.md:689`). Pick one rule and use it consistently across the design notes, pseudocode, and tests.

### Updated readiness

- **Plan quality:** Much improved -- the original P0 design issues are largely resolved.
- **Ready to implement:** Yes, with P1 follow-ups. I no longer consider prompt-template migration a branch-blocking issue given the pre-release status.

---

## Addendum (2026-03-08) -- Re-review after latest revisions

**Reviewed:** `5x-cli/docs/development/010-cli-composability.md` (v1.3)

### What's addressed (✅)

- **Structured domain errors:** The plan now introduces `RecordError` for `recordStepInternal()`, preserving machine-readable error codes without re-coupling the helper to CLI stdout behavior (`5x-cli/docs/development/010-cli-composability.md:311`). This resolves the main concern with throwing plain `Error`.
- **Consistent `--result` vs pipe semantics:** The doc now clearly states a single rule: parse the envelope whenever stdin is piped unless stdin is consumed by `--result -`; explicit inline/file `--result` values still allow pipe-derived context (`5x-cli/docs/development/010-cli-composability.md:43`, `5x-cli/docs/development/010-cli-composability.md:381`, `5x-cli/docs/development/010-cli-composability.md:735`). The tests also now cover inline/file/raw-stdin variants (`5x-cli/docs/development/010-cli-composability.md:442`).
- **Pre-release prompt-template compatibility:** The plan now adds an explicit fallback path for pre-existing scaffolded prompt copies, including warning behavior and null `stepName` for unknown custom templates (`5x-cli/docs/development/010-cli-composability.md:63`, `5x-cli/docs/development/010-cli-composability.md:118`). That is an appropriate pre-release compatibility story.

### Residual notes (non-blocking)

- Emitting the missing-`step_name` warning from `parseTemplate()` is acceptable for this branch. Before release, it may be worth deduplicating warnings per template/path if loader call frequency makes stderr noisy, but this is operational polish, not a plan issue.
- Phase 1 implementation is already underway and should still be reviewed separately, as noted by the team.

### Updated readiness

- **Plan quality:** Implementation-ready.
- **Ready to implement:** Yes. The previously open design concerns are adequately resolved for plan approval.
