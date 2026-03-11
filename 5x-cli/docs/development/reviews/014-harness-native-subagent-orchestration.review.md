# Review: Harness-Native Subagent Orchestration

**Review type:** 5x-cli/docs/development/014-harness-native-subagent-orchestration.md
**Scope:** Full implementation plan — Phases 1–5
**Reviewer:** Staff engineer
**Local verification:** Read invoke.handler.ts, protocol.ts, templates/loader.ts, init.ts, init.handler.ts, skills.handler.ts, bin.ts, all three SKILL.md files

## Summary

The plan is well-structured and correctly identifies the core architectural
problem: `5x invoke` is a monolithic orchestration path that couples prompt
rendering, provider execution, structured validation, and recording into a
single command. Extracting rendering and validation as standalone primitives
is the right decomposition and enables the native subagent path without
forking the contract.

The plan is close to ready but has several issues ranging from a missing
design consideration for the `5x template render` envelope (P0 — skills
need specific fields to work) to scope gaps in the init command restructuring
and agent template content specification.

**Readiness:** Not ready — one design gap requires human judgment on the
render envelope contract, and several items need clarification before
implementation can proceed cleanly.

## Strengths

- Clean separation of concerns: rendering and validation become standalone
  primitives that both native and fallback paths share. This avoids the
  "two implementations, one contract" drift problem.
- Phasing is correctly ordered by dependency: primitives first, then install
  abstractions, then the init command, then skill rewrites, then docs.
  Each phase has a clear completion gate.
- The plan explicitly preserves backward compatibility for `5x invoke` and
  the existing `skills install` command. No breaking changes.
- Non-goals are well-scoped. Avoiding DB schema changes, per-harness prompt
  forks, and multi-harness installers in v1 keeps the scope manageable.
- The design decision to keep task prompts universal while moving harness
  role framing into agent profiles is the right layering.

## Production Readiness Blockers

### P0.1 — `5x template render` envelope contract underspecified for run/worktree context

**Risk:** Skills calling `5x template render` won't have the information they
need to pass to native subagents (effective working directory, resolved plan
path, worktree mapping). The current `5x invoke` resolves all of this
internally. If `template render` only returns the prompt text, the skill
prose must re-derive run context separately, duplicating the complex
resolution logic from invoke.handler.ts lines 332–381.

The plan says the envelope should include "any resolved worktree context
fields that downstream skills need" but does not specify which fields, nor
whether `template render` should accept `--run` and perform run context
resolution itself.

**Requirement:** Decide whether `5x template render` is run-aware (accepts
`--run`, resolves worktree context, includes effective_workdir/plan_path
in the envelope) or prompt-only (just renders text). If prompt-only, the
plan must add a separate `5x run context --run <id>` command or document
how skills derive this context. The native delegation pattern in Phase 4
depends on this contract.

### P0.2 — No specification for how native subagents receive the working directory

**Risk:** The current `5x invoke` sets the provider's `workingDirectory` to
the resolved worktree path (invoke.handler.ts:506–508). Native subagents
launched by OpenCode's built-in subagent mechanism will execute in whatever
directory OpenCode defaults to — likely the project root, not the mapped
worktree. If the skill doesn't explicitly instruct the subagent to `cd` or
pass context, author work happens in the wrong directory.

**Requirement:** The plan must specify how the native delegation pattern
communicates the effective working directory to the subagent. Options: (a)
include it in the rendered prompt text, (b) rely on OpenCode's subagent
launch API to set cwd, (c) add a `workdir` instruction in the agent profile.
This affects the agent template content in Phase 2 and the skill prose in
Phase 4.

## High Priority (P1)

### P1.1 — `init.ts` restructuring for subcommands not detailed

The current `init.ts` is a flat `defineCommand` with no subcommands. Adding
`5x init opencode <scope>` requires either: (a) making `init` a parent
command with `subCommands: { opencode: ... }` while keeping bare `5x init`
as the default run handler, or (b) parsing positional args manually.

Citty's `defineCommand` with both a `run` handler and `subCommands` is
supported but has specific behavior — the parent `run` fires only when no
subcommand matches. The plan should specify which approach to use, since
getting this wrong breaks the existing `5x init [--force]` behavior.

Recommendation: Use citty's parent-with-subcommands pattern. Document that
bare `5x init` continues to run `initScaffold`, and `5x init opencode` is
a separate subcommand.

### P1.2 — Agent template content is unspecified

Phase 2 says "Define prompt, tool, permission, mode, description, and
optional model frontmatter for each OpenCode agent template" but provides
no detail on what the agent profiles actually contain. The reviewer agent's
read-only constraint ("denies direct file edits while still allowing
read-only investigation commands") needs specific OpenCode agent frontmatter
to enforce — OpenCode uses `allowedTools` / `disallowedTools` in agent
definitions.

The plan should include at minimum a skeleton of the agent markdown for
`5x-reviewer` showing the tool restrictions, so the implementation doesn't
have to guess at OpenCode's agent spec.

### P1.3 — Skill rewrite complexity is underestimated

The current skills have ~50 lines of subprocess invocation guidance
("CRITICAL: Always run 5x invoke as a subprocess", timeout layers,
monitoring). The native-first rewrite needs to replace this with a
multi-path delegation pattern:

1. Check if native agent exists (how? `5x` command? File existence check?)
2. Render prompt with `5x template render`
3. Launch native subagent (harness-specific syntax)
4. Validate with `5x protocol validate`
5. Record with `5x run record`
6. Fallback to `5x invoke` if native agent unavailable

This is significantly more complex than the current single-path approach.
The plan should include a concrete example of the delegation pattern as it
would appear in one skill (e.g., `5x-plan-review` Step 1), so reviewers
can evaluate whether the skill prose is tractable for LLM orchestrators
to follow.

### P1.4 — No `--run` support specified for `5x protocol validate`

The current `invoke.handler.ts` auto-records steps via `--record`. The plan's
`5x protocol validate` accepts JSON and validates it, but doesn't mention
whether it also supports `--run` / `--record` to maintain the auto-record
convenience. If skills must manually call `5x run record` after every
validation, that's three commands per delegation instead of one (`5x invoke
--record`). This regression in ergonomics should be acknowledged or
addressed.

Recommendation: Either add `--record` to `5x protocol validate` or
explicitly document that the three-command pattern (render → subagent →
validate + record) is the intended native flow.

## Medium Priority (P2)

- **Detection of installed agents**: The plan doesn't specify how skills
  detect whether native agents are installed. File existence check under
  `.opencode/agents/`? A new `5x` command? The fallback logic in Phase 4
  depends on this.

- **`--require-commit` semantics in validate**: The plan mentions
  `--require-commit` for author validation, which mirrors the existing
  `assertAuthorStatus({ requireCommit: true })` behavior. But the current
  invoke handler always requires commit for author role. Should
  `--require-commit` default to true for author validation, or is this
  opt-in? If opt-in, skills must always pass it, which is error-prone.

- **Template render should output to stdout, not file**: The plan says
  JSON envelope output but doesn't specify stdout vs file. Given the
  existing CLI convention (all structured output to stdout), this should
  be explicit.

- **OpenCode agents dir convention**: The plan assumes `.opencode/agents/`
  but should verify this matches OpenCode's actual agent discovery path.
  If OpenCode looks in a different location, the installer will produce
  dead files.

- **`5x init opencode` should not require prior `5x init`**: It's unclear
  whether `5x init opencode project` depends on `.5x/` and `5x.toml`
  already existing. If it does, the docs should say "run `5x init` first".
  If it doesn't, it should scaffold the minimum required config.

- **Test coverage for refactored invoke.handler.ts**: Phase 1 refactors
  invoke to reuse extracted helpers. The existing 1462-line invoke test
  suite must continue passing. The plan mentions "Regression: existing
  invoke tests" but should call out that the refactoring must not change
  any invoke test assertions — this is a pure extraction, not a behavior
  change.

## Readiness Checklist

**P0 blockers**
- [ ] Specify `5x template render` envelope fields and run-awareness
- [ ] Specify how native subagents receive effective working directory

**P1 recommended**
- [ ] Detail init.ts restructuring approach for citty subcommands
- [ ] Include skeleton of at least the reviewer agent template
- [ ] Add concrete delegation pattern example for one skill step
- [ ] Clarify recording ergonomics in native flow (3-cmd vs integrated)

---

## Addendum: Human Guidance on All Items

The following resolutions have been approved by the human and should be incorporated verbatim into the plan.

### P0.1 — `5x template render` envelope fields

Specify the exact envelope fields output by `5x template render`:

```json
{
  "template": "reviewer-plan",
  "selected_template": "reviewer-plan-continued",
  "step_name": "reviewer:review",
  "prompt": "<rendered markdown>",
  "declared_variables": ["plan_path", "review_path"],
  "run_id": "run_abc123",
  "plan_path": "/abs/path/to/plan.md",
  "worktree_root": "/abs/path/to/worktree"
}
```

`run_id`, `plan_path`, and `worktree_root` are only included when `--run` is passed. The command must explicitly accept `--run <id>` and perform run/worktree context resolution mirroring `invoke.handler.ts` lines 332–381. This must be stated in the Phase 1 checklist and Design Decisions.

### P0.2 — Effective working directory for native subagents

The primary mechanism is to embed the effective working directory in the rendered prompt text. When `5x template render` resolves a worktree root via `--run`, it must inject a `## Context` block (or `{{effective_workdir}}` variable) into the rendered prompt so the native subagent sees it in its instructions. This approach is harness-agnostic. Additionally, the OpenCode agent profiles (Phase 2) should set a `cwd` frontmatter field if OpenCode supports it — as a belt-and-suspenders secondary layer, not the primary mechanism. The plan must state both layers explicitly.

### P1.1 — `init.ts` subcommand approach

Use citty's parent-with-subcommands pattern (same pattern as the existing `skills` command). The existing flat `init` handler is preserved at the no-arg/default path. `5x init opencode` is registered as a `subCommands` entry on the `init` parent. Add an explicit checklist item to write a compatibility test that `5x init --force` still works without arguments.

### P1.2 — Agent template skeletons

Include a skeleton for each of the three OpenCode agent templates in the plan. At minimum, the `5x-reviewer` skeleton must be shown:

```markdown
---
name: 5x-reviewer
description: 5x quality reviewer — read-only investigation and structured verdict
model: <omit or from [reviewer].model>
mode: subagent
allowedTools: [read_file, search_files, run_terminal_cmd, list_directory]
disallowedTools: [write_file, edit_file, delete_file]
---
```

For `5x-plan-author` and `5x-code-author`, the `disallowedTools` restriction does not apply. All three have `mode: subagent`. The plan should reference these skeletons in Phase 2 so the implementation has a concrete target.

### P1.3 — Concrete native delegation example

Add the following delegation sequence to the plan as the canonical example (e.g., for `reviewer:review` in `5x-plan-review`):

```bash
# 1. Render the prompt
RENDERED=$(5x template render reviewer-plan --run $RUN \
  --var plan_path=$PLAN_PATH --var review_path=$REVIEW_PATH)
PROMPT=$(echo "$RENDERED" | jq -r '.prompt')
STEP=$(echo "$RENDERED" | jq -r '.step_name')

# 2. Detect native agent (project scope first, then user scope)
if [[ -f ".opencode/agents/5x-reviewer.md" ]] || \
   [[ -f "$HOME/.config/opencode/agents/5x-reviewer.md" ]]; then
  # 3a. Launch native subagent (harness provides child session)
  RESULT=<native subagent result JSON>
else
  # 3b. Fallback to 5x invoke
  RESULT=$(5x invoke reviewer reviewer-plan --run $RUN --record ...)
fi

# 4. Validate + record (combined)
echo "$RESULT" | 5x protocol validate reviewer --run $RUN --record --step $STEP
```

This example must appear in Phase 4 of the plan so implementers and reviewers can evaluate the skill prose before implementation begins.

### P1.4 — `5x protocol validate` recording ergonomics

Add `--run <id>`, `--record`, and `--step <name>` flags to `5x protocol validate` so validation and recording are combined in one command. This preserves the ergonomics of `5x invoke --record`. Add this as an explicit Phase 1 checklist item: "Support `--run`, `--record`, and `--step` on `5x protocol validate` to preserve auto-record ergonomics."

### P2.1 — Native agent detection mechanism

Detection is a two-location file existence check: project scope (`.opencode/agents/<name>.md`) first, then user scope (`~/.config/opencode/agents/<name>.md`). Skills should check project scope first, then user scope, then fall back to `5x invoke`. Document this order in the Phase 4 skill rewrite section.

### P2.2 — `--require-commit` default

`--require-commit` must default to `true` for author validation to match existing `5x invoke` behavior. Document it as an opt-out flag (i.e., `--no-require-commit` to disable). Update the Phase 1 checklist item accordingly.

### P2.3 — `5x init opencode` prerequisite

`5x init opencode project` requires `.5x/` and `5x.toml` to already exist (i.e., `5x init` must have been run first). Add a prerequisite check to the command that exits with a clear error message if these are absent. Document this dependency in Phase 3.

### P2.4 — Verify `.opencode/agents/` discovery path

Add an explicit verification step in Phase 2: confirm that `.opencode/agents/` is the correct agent discovery path for OpenCode project installs, and `~/.config/opencode/agents/` for user installs, before writing the installer. Reference OpenCode documentation or source as evidence.

---

## Addendum (March 10, 2026) — Re-review of v1.1

### What's Addressed

All previously raised issues have been addressed in v1.1. The revision
history at the bottom of the plan provides clear traceability.

- **P0.1 (envelope contract):** Resolved. The plan now specifies the exact
  JSON envelope fields for `5x template render`, including the conditional
  `run_id`, `plan_path`, `worktree_root` fields. The command accepts
  `--run <id>` and performs run/worktree context resolution. The Design
  Decisions section and Phase 1 checklist both reflect this.

- **P0.2 (working directory):** Resolved. Two-layer approach: primary is
  `{{effective_workdir}}` injected into rendered prompt text; secondary is
  `cwd` frontmatter in OpenCode agent profiles. Both layers documented in
  Design Decisions and reflected in Phase 1/Phase 2 checklists.

- **P1.1 (init.ts restructuring):** Resolved. Phase 3 specifies the citty
  parent-with-subcommands pattern and includes a compatibility test for
  bare `5x init --force`.

- **P1.2 (agent template skeletons):** Resolved. All three agent template
  skeletons are now in Phase 2 with concrete frontmatter including
  `allowedTools`/`disallowedTools` for the reviewer.

- **P1.3 (delegation example):** Resolved. Phase 4 includes a canonical
  native delegation example showing the full render → detect → subagent →
  validate+record sequence.

- **P1.4 (recording ergonomics):** Resolved. `5x protocol validate` now
  supports `--run`, `--record`, and `--step` flags.

- **P2.1–P2.4:** All resolved. Detection mechanism, `--require-commit`
  default, init prerequisite check, and OpenCode path verification are all
  documented.

### Remaining Concerns

#### P1.5 — `{{effective_workdir}}` injection conflicts with template variable system

The plan says `5x template render` injects `{{effective_workdir}}` into
the rendered prompt when `--run` resolves a worktree. However, the
existing template system (`templates/loader.ts`) requires all variables
to be declared in the template's YAML frontmatter `variables` array
(`loader.ts:342`). Any `{{effective_workdir}}` placeholder in a template
body that is not declared in frontmatter will cause a hard error in
`renderBody()` at the unresolved-variable check (`loader.ts:311–318`).

This means either:

1. All 7 bundled templates must add `effective_workdir` to their
   `variables` array (and callers without `--run` must still provide a
   value or it becomes optional — but the system has no optional variable
   support yet).
2. The injection happens *after* `renderBody()` returns — appending a
   context block to the already-rendered prompt string rather than using
   the `{{var}}` substitution mechanism.
3. The template system is extended to support optional variables.

Option (2) is the simplest and avoids changing all templates. The plan
should specify which approach is used. If option (2), the
`{{effective_workdir}}` wording in the plan is misleading because it
implies template variable syntax but the injection would be post-render
string concatenation.

#### P2.5 — Canonical delegation example has a double-validation gap

In the canonical delegation example (Phase 4), when the fallback path
fires (`5x invoke reviewer ... --record`), `5x invoke` already validates
and records the result internally. The example then pipes the result
through `5x protocol validate reviewer --run $RUN --record --step $STEP`
unconditionally (step 4), which would double-validate and double-record
the fallback case. The example should either:

- Skip step 4 when using the fallback path (since `5x invoke --record`
  already handles it), or
- Have the fallback path omit `--record` on `5x invoke` and let
  `5x protocol validate --record` be the single recording point.

The second option is cleaner — it makes `5x protocol validate --record`
the universal recording point for both paths. But this requires that
the skill prose explicitly instruct the orchestrating agent to omit
`--record` on the fallback `5x invoke` call. The plan should clarify
which approach is canonical.

#### P2.6 — `5x protocol validate --record` needs `--phase` and `--iteration`

The current `5x invoke --record` supports `--phase` and `--iteration`
flags (`invoke.handler.ts:655–656`) which are passed through to
`recordStepInternal()`. The plan's `5x protocol validate` specifies
`--run`, `--record`, and `--step` but omits `--phase` and `--iteration`.
Without these, the recorded step will be missing phase/iteration metadata
that the existing run state model expects. Add `--phase` and
`--iteration` to the `5x protocol validate` flag set.

#### P2.7 — Agent template `allowedTools`/`disallowedTools` values need OpenCode verification

The reviewer skeleton uses `allowedTools: [read_file, search_files,
run_terminal_cmd, list_directory]` and `disallowedTools: [write_file,
edit_file, delete_file]`. These tool names are assumed but not verified
against OpenCode's actual tool naming convention. If OpenCode uses
different names (e.g., `readFile`, `Read`, `bash`), the restrictions
will silently not apply. Phase 2 already has a verification step for
directory paths — extend it to also verify the tool names used in agent
frontmatter against OpenCode's tool registry.

### Updated Readiness Assessment

**Readiness:** Ready with corrections — all P0 blockers from the initial
review are resolved. The remaining items are:

- P1.5 (effective_workdir injection mechanism) requires a design choice
  but the options are clear and bounded. This is the only item that
  could surprise implementation.
- P2.5–P2.7 are mechanical clarifications that an implementation agent
  can resolve.

The plan is substantively ready for implementation. P1.5 should be
resolved before Phase 1 implementation begins; the P2 items can be
resolved during implementation.

---

## Addendum 2: Human Guidance on Iteration 2 Items

### P1.5 — `{{effective_workdir}}` injection approach

Use **post-render string concatenation** (option 2). `5x template render` appends a `## Context` block to the already-rendered prompt string after `renderBody()` returns, bypassing the `{{var}}` mechanism entirely. No changes to existing template frontmatter are needed. The block is only appended when `--run` resolves a worktree root:

```markdown
## Context

- Effective working directory: /abs/path/to/worktree
```

Update the P0.2 wording in Design Decisions and the Phase 1 checklist to use "appended Context block" instead of `{{effective_workdir}}` to avoid implying template variable syntax.

### P2.5 — Delegation example fallback double-records

Use the single-recording-point approach: the fallback `5x invoke` call omits `--record`, and `5x protocol validate --record` is the universal recording point for both native and fallback paths. Update the canonical example in Phase 4 accordingly and add a note explaining why `--record` is omitted from the fallback invocation.

### P2.6 — `5x protocol validate --record` needs `--phase` and `--iteration`

Add `--phase` and `--iteration` flags alongside `--run`, `--record`, and `--step`. Update the Phase 1 checklist item to list all five flags explicitly. Update the canonical delegation example in Phase 4 to pass `--phase` where appropriate.

### P2.7 — Agent tool name verification

Extend the Phase 2 verification step (already covering directory paths) to also verify OpenCode's exact tool naming convention before finalizing `allowedTools`/`disallowedTools` in the agent skeletons. Annotate the skeletons in the plan as "assumed names — verify against OpenCode tool registry in Phase 2."

---

## Addendum (March 10, 2026) — Re-review of v1.2

### What's Addressed

All items from the previous re-review (Addendum, March 10 2026) have been
addressed in v1.2:

- **P1.5 (effective_workdir injection):** Resolved. The plan now explicitly
  specifies post-render string concatenation — `5x template render` appends
  a `## Context` block after `renderBody()` returns, bypassing the `{{var}}`
  mechanism entirely. Design Decisions (lines 115–127) and Phase 1 checklist
  (lines 230–234) both use clear "post-render concatenation" language. No
  changes to existing template frontmatter are needed.

- **P2.5 (double-validation in fallback):** Resolved. The canonical
  delegation example (lines 442–460) now omits `--record` from the fallback
  `5x invoke` call and includes an explanatory comment. `5x protocol validate
  --record` is the single recording point for both paths.

- **P2.6 (`--phase`/`--iteration` on validate):** Resolved. Design Decisions
  (lines 136–141) and Phase 1 checklist (lines 249–253) now list all five
  flags: `--run`, `--record`, `--step`, `--phase`, `--iteration`. The
  canonical example passes `--phase` and `--iteration`.

- **P2.7 (tool name verification):** Resolved. Phase 2 has a dedicated
  verification checklist item (lines 273–277) and the agent skeletons are
  annotated as "assumed — verify against OpenCode tool registry" (line 311).

### Remaining Concerns

#### P1.6 — `5x protocol validate` input format mismatch between native and fallback paths

The canonical delegation example (Phase 4, lines 429–460) pipes `$RESULT`
to `5x protocol validate` for both the native and fallback paths. However,
the two paths produce structurally different output:

- **Native subagent** returns raw structured JSON (the `AuthorStatus` or
  `ReviewerVerdict` object directly).
- **`5x invoke` fallback** returns the full `outputSuccess()` envelope:
  `{ "ok": true, "data": { "run_id": "...", "result": { ... }, ... } }`.
  The actual structured result is nested at `.data.result`.

`5x protocol validate` needs to know which format it's receiving — raw
structured JSON or wrapped envelope — to extract the correct payload for
schema validation. The plan specifies that `protocol validate` "accepts
JSON from stdin or `--input`" but doesn't address this format ambiguity.

Options:
1. `5x protocol validate` always expects raw structured JSON; the skill
   prose must extract `.data.result` from `5x invoke` output before piping.
2. `5x protocol validate` auto-detects the envelope format (if `ok` field
   is present, unwrap `.data.result`; otherwise treat as raw).
3. Add `--envelope` flag to signal that input is a `5x invoke` envelope.

This affects the canonical example and all skill prose. If option (1),
the fallback path in the example needs `jq -r '.data.result'` before
piping. If option (2), it works as-is but adds implicit behavior.

#### P2.8 — Fallback `5x invoke` without `--record` loses session/cost metadata in recording

When the fallback uses `5x invoke` without `--record` and then records via
`5x protocol validate --record`, the recorded step will be missing metadata
that `5x invoke --record` normally captures from the provider session:
`session_id`, `model`, `duration_ms`, `tokens.in`, `tokens.out`, and
`cost_usd` (see `invoke.handler.ts:651–663`). `5x protocol validate` has
no provider session to extract this metadata from.

For v1, this may be acceptable — the structured result and step name are
the critical recording fields. But the plan should acknowledge this
metadata loss and document it as a known limitation. If it matters, the
skill prose could extract these fields from the `5x invoke` envelope and
pass them to `5x protocol validate` via additional flags, but that adds
complexity.

#### P2.9 — `5x template render` envelope uses `outputSuccess` wrapper or bare JSON?

The plan specifies the render envelope fields (lines 93–110) but doesn't
say whether the output is wrapped in the standard `outputSuccess()` envelope
(`{ "ok": true, "data": { ... } }`) used by all other 5x commands, or is
a bare JSON object. Given the existing CLI convention where every command
uses `outputSuccess()`/`outputError()`, the render command should follow
suit. The canonical example (line 433) uses `jq -r '.prompt'` which implies
bare JSON. If the output uses `outputSuccess()`, the correct extraction
would be `jq -r '.data.prompt'`.

This affects all downstream consumers. The plan should explicitly state
whether `template render` follows the standard envelope convention.

### Updated Readiness Assessment

**Readiness:** Ready with corrections — all previous blockers are resolved.
The remaining items are:

- P1.6 (validate input format mismatch) is a real gap that will cause
  the fallback path to fail at runtime if not addressed. It can be resolved
  mechanically (auto-detect or document extraction) but the choice of
  approach should be made before Phase 1 implementation.
- P2.8 (metadata loss) is a known limitation to document, not a blocker.
- P2.9 (output envelope convention) is a mechanical clarification.

The plan is ready for implementation with these corrections. None require
human judgment — they are all mechanical fixes with clear best-practice
answers.

---

## Addendum (March 10, 2026) — Re-review of v1.3

### What's Addressed

All items from the previous re-review have been addressed in v1.3:

- **P1.6 (validate input format mismatch):** Resolved. New Design Decision
  (lines 151–163) specifies auto-detection: if parsed JSON contains an `ok`
  field, unwrap `.data.result`; otherwise treat as raw structured JSON.
  Phase 1 checklist (lines 283–286) has a corresponding implementation item.
  Tests table (line 553) covers both input formats.

- **P2.8 (session metadata loss):** Resolved. New Design Decision
  (lines 165–180) documents this as a known v1 limitation with clear
  rationale: critical recording fields (result, step, phase, iteration) are
  preserved; informational metadata (session_id, model, duration, tokens,
  cost) is lost in the fallback-via-validate path. Deferred enhancement
  path documented.

- **P2.9 (output envelope convention):** Resolved. Design Decision
  (lines 87–114) now explicitly shows the full `outputSuccess()` wrapper
  with `{ "ok": true, "data": { ... } }` shape. Phase 1 checklist
  (lines 273–277) specifies standard envelope. Canonical example (line 474)
  correctly uses `.data.prompt` and `.data.step_name`. Tests table
  (line 552) covers `outputSuccess()` wrapping and `outputError()` cases.

### Final Assessment

No remaining concerns. The plan at v1.3 is complete and internally
consistent:

- **Correctness:** The two new CLI primitives (`template render`,
  `protocol validate`) cleanly decompose the monolithic `invoke` path.
  The auto-detect input format for `validate` handles the structural
  difference between native and fallback output. Post-render Context block
  injection avoids template system conflicts.

- **Architecture:** The harness location registry, agent template
  parameterization, and citty parent-with-subcommands pattern all follow
  existing codebase conventions. The extraction from `invoke.handler.ts` is
  a pure refactor with explicit regression guard.

- **Completeness:** All edge cases identified across four review iterations
  are addressed: envelope format, working directory communication, input
  format ambiguity, double-recording prevention, metadata loss
  acknowledgment, template variable system compatibility, init prerequisite
  checks, tool name verification.

- **Phasing:** Dependencies are correctly ordered. Each phase has a clear
  completion gate. No phase depends on work from a later phase.

- **Testability:** Unit, integration, regression, and manual test scopes
  are well-defined. The test table covers all new behaviors introduced by
  the plan.

- **Risks:** Acknowledged and bounded. The skill complexity increase is
  mitigated by the canonical delegation example. The metadata loss
  limitation is documented with a deferred enhancement path.

**Readiness:** Ready — the plan can proceed to implementation as-is.

---

## Addendum (March 11, 2026) — Implementation review of `a7a5c84`

### What's Addressed

Phase 1 is mostly implemented as planned.

- `5x template render` landed with run-aware rendering, continued-template
  selection, standard `outputSuccess()` envelope output, and post-render
  `## Context` block injection in `5x-cli/src/commands/template.handler.ts`.
- `5x protocol validate` landed with stdin / `--input` support, raw-vs-envelope
  auto-detection, author/reviewer schema validation, and combined record flags
  in `5x-cli/src/commands/protocol.handler.ts`.
- `5x invoke` kept passing its regression suite after the extraction, and the
  new command coverage is strong: `5x-cli/test/commands/template-render.test.ts`,
  `5x-cli/test/commands/protocol-validate.test.ts`, and the existing invoke
  tests all pass locally.

### Remaining Concerns

#### P1.7 — `protocol validate --record` can corrupt stdout with a second JSON envelope

`5x-cli/src/commands/protocol.handler.ts:173` writes the success envelope before
recording preconditions are fully validated. If `--record` is used with an
invalid run id, `validateRunId()` at `5x-cli/src/commands/protocol.handler.ts:188`
throws after success output has already been emitted, so stdout contains both a
success envelope and an error envelope. Repro: `5x protocol validate author
--record --run ../bad --step test`.

This breaks the machine-readable single-envelope contract and can mislead the
orchestrator into treating a failed validate+record call as successful.

Recommendation: validate all `--record` prerequisites (`--run`, run id format,
`--step`) before calling `outputSuccess()`, and add a regression test for the
invalid-run-id case.

#### P2.10 — Phase 1 did not actually extract shared render/validate helpers for `invoke`

The plan called for `invoke.handler.ts` to reuse extracted render/validate
helpers so native and fallback paths share one contract. This commit extracts
shared variable parsing in `5x-cli/src/commands/template-vars.ts`, but
`5x-cli/src/commands/invoke.handler.ts:312`-`5x-cli/src/commands/invoke.handler.ts:360`
still reimplements template selection / rendering flow, and
`5x-cli/src/commands/invoke.handler.ts:460`-`5x-cli/src/commands/invoke.handler.ts:493`
still reimplements structured-output validation.

Functionally this works today, but it leaves the exact drift risk Phase 1 was
meant to remove. A later contract change will need to be updated in two places.

Recommendation: factor a shared render helper and a shared validate helper out
of the new command handlers, then have both `template render` / `protocol
validate` and `invoke` call those helpers.

### Updated Readiness Assessment

**Readiness:** Ready with corrections — Phase 1 is substantively complete and
the test strategy is good, but one correctness issue remains in the new
validate+record path and the planned invoke/helper consolidation is incomplete.
Both are mechanical fixes. Phase 2 should wait until P1.7 is fixed.
