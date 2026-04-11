# Review: Skills Session Semantics Clarification

**Review type:** `b6ff0e3`  \
**Scope:** 5x-cli shared skill templates (native vs invoke semantics), Cursor harness terminology adaptation, unit test updates  \
**Reviewer:** Staff engineer (correctness, operability, workflow UX)  \
**Local verification:** `bun test test/unit/` (PASS; warnings present but unrelated)

**Implementation plan:** N/A  \
**Technical design:** N/A

## Summary

This commit aims to de-confuse two similarly-named concepts: (1) orchestrator subagent continuity (native delegation) and (2) CLI template/invoke “session” continuity (`--session` / `--new-session`). The direction is correct and the Cursor harness loader becomes less invasive.

However, the shared base skill templates now use Cursor-style `resume=...` terminology/parameterization, while the OpenCode harness appears to expect `task_id` (and does no terminology adaptation). This is likely a correctness regression for the default OpenCode harness docs/skills and will cause native workflows to fail or be followed incorrectly.

**Readiness:** Not ready — base skills appear to be harness-incompatible (OpenCode vs Cursor) and can mislead core workflows.

---

## What shipped

- **Cursor harness skill loader (`5x-cli/src/harnesses/cursor/skills/loader.ts`)**: Removed broad “task/session id” terminology rewrites; kept `subagent_type` → `subagent` and “Task tool” wording adaptation.
- **Base skill templates (`5x-cli/src/skills/base/*/SKILL.tmpl.md`)**: Rewrote prose + examples to distinguish Task reuse vs CLI `--session`; removed Cursor-specific naming in some places; changed “needs_human” guidance to defer to the Human Interaction Model.
- **Cursor orchestrator rule (`5x-cli/src/harnesses/cursor/5x-orchestrator.mdc`)**: Added a short clarification section on native vs `5x invoke`.
- **Tests**: Updated cursor skills loader expectations; added a regression assertion that phase-execution “needs_human” references the Human Interaction Model.

---

## Strengths

- **Correct problem framing:** The separation of “subagent continuity” vs “CLI template session continuity” is the right mental model and reduces the chance of misusing provider sessions.
- **Reduced brittle rewriting:** Removing the broad `task_id` string replacement in the Cursor loader lowers accidental corruption risk in skill text.
- **Better human-gate ergonomics:** Pointing “needs_human” to the Human Interaction Model and warning about `5x prompt` TTY constraints is an operability improvement.
- **Unit test coverage added where semantics are easy to regress:** The “needs_human references Human Interaction Model” assertion is a good guardrail.

---

## Production readiness blockers

### P0.1 — Shared base skills appear Cursor-specific (OpenCode harness mismatch)

**Risk:** The OpenCode harness skill loader returns base skill templates “raw” (no terminology adaptation). Base skills now instruct native reuse via `resume=...` and “omit `resume`”, but OpenCode harness docs still describe “fresh task (omit `task_id`)” and the OpenCode Task tool contract in practice is `task_id`-based. This mismatch will confuse operators and may cause workflow steps to fail at the delegation boundary.

**Requirement:**
- Base skill templates MUST be correct for the default OpenCode harness output, or the OpenCode harness MUST adapt base templates to the OpenCode tool parameter names.
- Cursor-specific parameter names MUST NOT leak into OpenCode-installed skills.

**Implementation guidance:**
- Prefer keeping base templates in OpenCode-native terminology (`task_id`), and re-introduce a Cursor-only adaptation that maps OpenCode’s `task_id` concept to Cursor’s `resume` parameter.
- If the intent is to make base templates harness-neutral, introduce explicit placeholders/markers in templates and have each harness loader render them appropriately (avoid global string replaces that can hit unrelated contexts).
- Update/align `5x-cli/src/harnesses/opencode/5x-orchestrator.md` with whatever final semantics are chosen.

---

## High priority (P1)

### P1.1 — Clarify `5x template render --session` semantics (not only “invoke provider sessions”)

Current prose leans toward “`--session` is for invoke-mode provider sessions and `*-continued` selection.” In code, `--session` is also the mechanism for continued-template selection for `5x template render` regardless of delegation mode, and it is the knob used by `continuePhaseSessions` validation. The docs should explicitly state that `--session` is a CLI concept controlling continued-template selection and continuity enforcement, and it is orthogonal to the orchestrator’s subagent resume id.

---

## Medium priority (P2)

- **Harness parity tests:** Add a unit test asserting OpenCode-rendered skills contain the expected OpenCode-native Task invocation shape (e.g., `task_id=`) and do not contain Cursor-only parameter names.
- **Terminology consistency:** If “agent id” is the canonical term, standardize what the tool returns (“task_id” vs “agent id”) per harness to avoid mixed naming in one doc set.

---

## Readiness checklist

**P0 blockers**
- [ ] Base skill templates are correct for OpenCode installs (no Cursor-only `resume=` guidance), or OpenCode harness adapts terminology explicitly

**P1 recommended**
- [ ] Skill prose clearly separates CLI `--session` / `--new-session` behavior from orchestrator subagent continuity; no “invoke-only” ambiguity
- [ ] Add harness parity tests to prevent future parameter-name drift

---

## Addendum (2026-04-11) — Harness-Specific Native Continuation Tokens

**Reviewed:** `59e5eed53f18`

### What's addressed (✅)

- **P0.1 harness mismatch:** Base skills no longer hardcode Cursor-specific `resume=`. Shared templates now use a semantic placeholder (`[[NATIVE_CONTINUE_PARAM]]`) and each harness resolves it (`task_id` for OpenCode, `resume` for Cursor) via `src/skills/harness-tokens.ts` and harness loaders.
- **P1.1 `--session` semantics clarity:** Updated base skill prose plus top-level docs (`5x-cli/README.md`, `docs/v1/100-architecture.md`, OpenCode/Cursor orchestrator docs) to treat `5x template render --session/--new-session` as CLI continuity control (continued-template selection + `continuePhaseSessions` enforcement), orthogonal to native subagent continuation ids.
- **P2 harness parity tests:** Added unit coverage to ensure Cursor and OpenCode rendered skills (1) do not leak unresolved token placeholders and (2) contain the correct harness-specific continuation parameter names.

### Remaining concerns

- None blocking identified in this change. The token mechanism is intentionally strict (unknown `[[...]]` patterns throw); that’s good for catching template authoring mistakes early.

### Updated readiness

- **Production readiness:** Ready — prior P0 mismatch is resolved and guarded by tests; documentation now matches the actual continuity model.
