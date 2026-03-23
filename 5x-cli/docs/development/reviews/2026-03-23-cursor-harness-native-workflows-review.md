# Review: Cursor Harness for Native 5x Workflows

**Review type:** `5x-cli/docs/027-cursor-harness-native-workflows.prd.md`
**Scope:** Bundled `cursor` harness (skills + subagents + orchestrator rule) + harness framework extension for managed rule files
**Reviewer:** Principal PM + Staff engineer (product UX, correctness, operability)
**Local verification:** Not run (static review: PRD + current harness implementation in `5x-cli/src/harnesses/*`)

**Implementation plan:** N/A
**Technical design:** `5x-cli/docs/development/014-harness-native-subagent-orchestration.md` (existing harness/skill architecture baseline)

## Summary

The PRD is directionally correct: Cursor is the next logical harness after OpenCode, and using Cursor project rules as the "primary orchestrator" layer is the right native substitution for OpenCode's `mode: primary` agent.

However, several "Verified Platform Constraints" are currently asserted without evidence and directly drive file-path and frontmatter decisions; if any of those assumptions are wrong, we will ship a harness that installs dead assets. There is also a UX contract gap: the PRD requires explicit messaging for user-scope rule omission, but the current harness install/list surfaces do not have a clean way to represent "unsupported asset type for this scope" without additional result/printing structure.

**Readiness:** Ready with corrections -- proceed once P0s add explicit verification + tighten the rule/UX contract.

---

## Strengths

- **Correct product framing:** One `cursor` harness for both IDE + CLI matches user mental model and reduces support surface.
- **Good v1 scoping:** Filesystem install only, no new protocol/DB semantics, and explicit non-goal of guessing undocumented user rule paths.
- **Architecture consistency:** Mirrors the proven OpenCode harness pattern (`src/harnesses/<name>/plugin.ts` + local skill loader + model injection) and keeps `5x template render` / `5x protocol validate` as the invariant workflow bridge.
- **Clear asset set:** 4 skills + 3 subagents + 1 orchestrator artifact is coherent and maps cleanly to current 5x roles.

---

## Production readiness blockers

### P0.1 -- "Verified Platform Constraints" need concrete verification + OS path reality

**Risk:** If Cursor's actual on-disk locations, file extensions, or frontmatter schema differ (especially for user scope), installs will succeed but Cursor will not discover assets. This creates a high-friction failure mode ("5x installed, nothing shows up") that's expensive to debug.

**Requirement:** Update the PRD to include explicit verification steps (and/or citations) for:
- Project discovery paths for rules/skills/agents (`.cursor/rules/`, `.cursor/skills/`, `.cursor/agents/`)
- User discovery paths for skills/agents (the PRD assumes `~/.cursor/...`; confirm per-OS)
- Rule file format/extension expectations (`.mdc` vs `.md`) and how rules are invoked (`@rule-name` semantics)
- Subagent frontmatter fields and allowed values (especially `model: inherit`)

**Implementation guidance:** Follow the precedent from `5x-cli/docs/development/014-harness-native-subagent-orchestration.md` Phase 2: add a short "Verified (date): ..." block with what was checked and how.

---

### P0.2 -- Worktree-aware execution with Cursor must be explicitly constrained

**Risk:** 5x's worktree mapping commonly points authors at paths like `<repo>/.5x/worktrees/...`. If Cursor agents can't reliably read/write in those directories (hidden dir indexing, workspace boundary rules, nested git confusion), the code-author workflow will silently edit the wrong checkout or fail.

**Requirement:** Document the expected Cursor behavior for worktree runs:
- Whether Cursor agents can edit files under `.5x/worktrees/...` reliably
- Whether the orchestrator rule must instruct authors to use the `## Context` "Effective working directory" path for *all* edits
- Any recommended repo settings (e.g., don't exclude `.5x/` from indexing if Cursor does that)

**Implementation guidance:** Add a manual verification checklist item that exercises a real `5x run init --worktree` + Cursor author edit + `5x diff --run` showing changes in the mapped worktree (not the main checkout).

---

### P0.3 -- User-scope "rules unsupported" UX contract is underspecified

**Risk:** The PRD requires install output to explain why the orchestrator rule is missing in user scope. If the CLI silently omits it, users will assume install is broken and churn.

**Requirement:** Define the harness framework contract for "asset type unsupported in this scope" (at minimum for rules): install/list output must surface it explicitly.

**Implementation guidance:** Prefer a typed result surface over ad-hoc `console.log` inside plugins:
- Extend install results to include `warnings: string[]` or an `unsupported: { rules?: true }` summary per scope.
- Ensure `5x harness list` can represent "rules not applicable for user scope" without implying "not installed".

---

### P0.4 -- Cursor model injection semantics must specify YAML escaping and omission rules

**Risk:** The PRD proposes `model: inherit` when unset, but does not specify quoting/escaping when set. We already hit YAML injection/escaping edge cases in OpenCode (`yamlQuote()` in `5x-cli/src/harnesses/opencode/loader.ts`); Cursor will have the same risk.

**Requirement:** Specify:
- Whether Cursor allows omitting `model` entirely (preferred if supported), vs requiring `inherit`
- If injecting a configured model, it must be YAML-safe (escaped/quoted) with tests

**Implementation guidance:** Reuse the OpenCode pattern (`yamlQuote()` + "inject immediately after `---`"). Add unit tests with model strings containing `:`, `"`, `\\`, and newlines.

---

## High priority (P1)

### P1.1 -- Harness rule support should stay optional and non-breaking for external plugins

The PRD's "optional rule support" approach is the right compatibility stance. Make sure all new fields are optional in:
- `HarnessLocations` (e.g., `rulesDir?: string`)
- `HarnessDescription` (e.g., `ruleNames?: string[]`)
- install/uninstall result types (e.g., `rules?: InstallSummary`)

Also update the harness docs (`5x-cli/src/harnesses/README.md`) to match the expanded contract.

### P1.2 -- Rule naming and invocation semantics need to be pinned down

The PRD assumes users can "attach `@5x-orchestrator`". Confirm whether Cursor's rule selector uses filename, `description`, or an explicit `name` field (and whether `.mdc` supports it). Update the rule template and UX copy accordingly.

### P1.3 -- Cursor-local skills need stronger guidance on native delegation mechanics

Replacing "Task tool / task_id" wording is necessary but not sufficient; Cursor skills should include one canonical example showing how the *main agent* delegates to subagents in Cursor UX (IDE and CLI), analogous to the canonical bash snippet in the OpenCode skills.

---

## Medium priority (P2)

- **Drift control:** Consider a light process to keep OpenCode vs Cursor skill semantics aligned (e.g., shared source with small harness-specific overlays) to avoid long-term divergence.
- **Install prerequisite clarity:** Project-scope `5x harness install` currently requires `5x init` (state DB). The PRD should mention this explicitly in UX expectations.
- **List output ergonomics:** With three asset types (skills/agents/rules), ensure `5x harness list` remains readable and stable for scripts.

---

## Readiness checklist

**P0 blockers**
- [ ] Add concrete verification evidence/steps for Cursor paths + formats (project + user, per OS where relevant)
- [ ] Document Cursor worktree behavior and add a manual verification scenario proving edits land in the mapped worktree
- [ ] Define CLI UX contract for "rules unsupported in user scope" (install + list)
- [ ] Specify Cursor `model` handling + YAML escaping strategy with tests

**P1 recommended**
- [ ] Keep rule support fully optional to preserve external plugin compatibility
- [ ] Pin down Cursor rule invocation semantics (`@5x-orchestrator` vs other)
- [ ] Add a canonical Cursor-native delegation example into Cursor-local skills

---

## Addendum (2026-03-23) -- Re-review of PRD v0.2 updates

**Reviewed:** `5x-cli/docs/027-cursor-harness-native-workflows.prd.md` v0.2

### What's addressed (OK)

- **P0.1 (verification + paths):** PRD now includes explicit Cursor doc citations, OS path notes, and a Phase 0 pre-ship verification gate.
- **P0.2 (worktree constraints):** PRD now treats worktree compatibility as a ship gate, and requires explicit guidance to honor the rendered `## Context` working directory.
- **P0.3 (user-scope rules UX):** PRD now defines a typed contract for `rules: unsupported` at user scope (vs silent omission) and calls out handler/plugin shape changes needed to represent it.
- **P0.4 (model injection safety):** PRD now specifies omitting `model` when unset (Cursor default inherit), and YAML-safe quoting/escaping when injecting configured models (explicitly reusing the OpenCode `yamlQuote()` approach).
- **P1.3 (canonical delegation example):** PRD now requires a Cursor-native delegation example inside Cursor-local skills.
- **Install prerequisite clarity:** PRD now states project-scope install requires `5x init` first (consistent with current handler behavior).

### Remaining concerns

- **Manual verification is still required before promising UX:** Rule invocation semantics and Windows path behavior remain explicitly unverified (appropriately). Keep docs conservative until Phase 0 is done.
- **Typed UX contract needs careful implementation:** The PRD correctly calls for typed `unsupported` + warnings, but the current `harness` handler prints summaries directly and the plugin contract currently returns only skills/agents. Implementers should ensure the new typed surfaces do not regress JSON stability for scripts.

### Updated readiness

- **PRD correctness:** Ready -- the earlier P0 gaps are addressed in the document.
- **Ready to implement:** OK, with Phase 0 verification treated as a release gate (not optional).
