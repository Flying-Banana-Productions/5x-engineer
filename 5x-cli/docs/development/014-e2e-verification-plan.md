# End-to-End Verification Plan: Native OpenCode Subagent Workflow

**Feature:** Harness-Native Subagent Orchestration (014)  
**Date:** March 2026  
**Scope:** Manual verification in OpenCode TUI — native path, fallback path, recording

This document describes the manual verification steps for the native-first OpenCode
workflow introduced in feature 014. Automated unit and integration tests cover
individual commands; this plan covers the full end-to-end path in a live OpenCode
session.

---

## Prerequisites

- OpenCode installed and on `PATH`
- `5x` CLI installed (`npm install -g @5x-ai/5x-cli` or `bun link` from source)
- A test git repository with at least one plan file and a valid `5x.toml`
- Provider API keys configured (e.g., `ANTHROPIC_API_KEY`)

---

## Scenario 1: Native subagents installed — full native path

### Setup

```bash
cd /path/to/test-repo
5x init
5x init opencode project   # installs .opencode/skills/ and .opencode/agents/
```

Verify installed files:

```bash
ls .opencode/agents/
# Expected: 5x-code-author.md  5x-orchestrator.md  5x-plan-author.md  5x-reviewer.md

ls .opencode/skills/
# Expected: 5x-phase-execution.md  5x-plan-review.md  5x-plan.md
```

### Verification steps

1. **Start OpenCode and select the 5x-orchestrator:**

   ```bash
   opencode
   ```

   In the TUI, select or `@mention` the `5x-orchestrator` agent.

2. **Load the 5x-plan skill and run a plan workflow:**

   Prompt the orchestrator:
   > "Use the 5x-plan skill to generate an implementation plan from
   > `docs/product/my-feature-prd.md`"

3. **Verify native child sessions appear in TUI:**

   - When the orchestrator delegates to `5x-plan-author`, a native child
     session should appear in the OpenCode TUI (visible as a sub-session or
     child task entry).
   - The child session should complete and return a result to the orchestrator.

4. **Verify prompt rendering:**

   In orchestrator tool output, look for a `5x template render` call. The output
   envelope should include:

   ```json
   {
     "ok": true,
     "data": {
       "template": "author-generate-plan",
       "selected_template": "author-generate-plan",
       "step_name": "author:generate-plan",
       "prompt": "...",
       "declared_variables": ["prd_path", "plan_path"],
       "run_id": "run_...",
       "plan_path": "...",
       "worktree_root": "..."
     }
   }
   ```

5. **Verify Context block in rendered prompt:**

   The rendered prompt (`.data.prompt`) should end with:

   ```markdown
   ## Context

   - Effective working directory: /abs/path/to/worktree
   ```

6. **Verify validated JSON result records correctly:**

   After the plan author subagent returns, look for a `5x protocol validate`
   call in orchestrator tool output. Verify:

   - The command succeeds (exit 0).
   - The output envelope includes the validated `AuthorStatus` payload.
   - Running `5x run state --run <run_id>` shows a recorded `author:generate-plan`
     step with the correct result.

7. **Run a reviewer delegation step:**

   Continue the workflow (plan review). The orchestrator should:
   - Call `5x template render reviewer-plan --run <id> ...`
   - Launch the `5x-reviewer` native subagent with the rendered prompt
   - Call `5x protocol validate reviewer --run <id> --record ...`

   Verify `5x run state` shows a recorded `reviewer:review` step.

8. **Verify `5x run state` after workflow completion:**

   ```bash
   5x run state --run <run_id>
   ```

   Expected recorded steps: `author:generate-plan`, `reviewer:review`,
   `author:revise-plan` (if applicable), `reviewer:review` (subsequent),
   and eventually the run completion.

---

## Scenario 2: Native subagents absent — fallback to `5x invoke`

### Setup

Remove (or rename) the installed agent files to simulate a clean environment
without native agents:

```bash
mv .opencode/agents .opencode/agents.bak
```

Also ensure user-scope agents are absent:
```bash
ls ~/.config/opencode/agents/
# Should be empty or the files should not be present
```

### Verification steps

1. **Start OpenCode and load a 5x skill directly:**

   Open OpenCode and load the `5x-plan` skill (e.g., via a system prompt or
   skill discovery in `.opencode/skills/`).

2. **Run the plan workflow:**

   Prompt the agent to run the 5x-plan workflow. The skill detects no native
   agents at `.opencode/agents/5x-plan-author.md` or
   `~/.config/opencode/agents/5x-plan-author.md` and falls back to `5x invoke`.

3. **Verify fallback invocation:**

   In tool output, look for a `5x invoke author author-generate-plan` call
   (without `--record`, since `5x protocol validate --record` is the recording
   point). The `5x invoke` call should include `2>/dev/null` to suppress
   streaming output.

4. **Verify `5x protocol validate` still records:**

   After `5x invoke` completes, look for a `5x protocol validate author --record`
   call. Verify the step is recorded correctly in `5x run state`.

5. **Verify end-to-end completion:**

   The workflow should complete successfully via the fallback path, with all
   steps recorded identically to the native path (minus provider session metadata
   such as `session_id`, `model`, and `cost_usd` which are not available to
   `5x protocol validate` in the fallback case — this is an accepted limitation).

---

## Scenario 3: User-scope install (`5x init opencode user`)

### Setup

```bash
5x init opencode user
```

Verify correct paths (XDG-style, NOT `~/.opencode/`):

```bash
ls ~/.config/opencode/agents/
# Expected: 5x-code-author.md  5x-orchestrator.md  5x-plan-author.md  5x-reviewer.md

ls ~/.config/opencode/skills/
# Expected: 5x-phase-execution.md  5x-plan-review.md  5x-plan.md
```

Confirm that `~/.opencode/` does NOT contain 5x agents (that path is incorrect
for OpenCode):

```bash
ls ~/.opencode/agents/ 2>/dev/null || echo "correct: ~/.opencode/agents/ does not exist"
```

### Verification steps

1. **Start a new project repository without project-scope agents:**

   ```bash
   mkdir /tmp/test-repo && cd /tmp/test-repo && git init
   5x init
   # Do NOT run 5x init opencode project
   ```

2. **Start OpenCode and verify user-scope agents are discovered:**

   OpenCode should discover agents from `~/.config/opencode/agents/`. The
   `5x-orchestrator`, `5x-plan-author`, `5x-code-author`, and `5x-reviewer`
   agents should be available.

3. **Run a workflow and verify native subagents are used:**

   The skill's detection logic checks user scope
   (`~/.config/opencode/agents/<name>.md`) after project scope. Since user-scope
   agents are present, the native path should be used.

---

## Scenario 4: `--force` overwrite behavior

```bash
# Install once
5x init opencode project

# Modify an installed file
echo "# custom" >> .opencode/agents/5x-reviewer.md

# Re-install without --force — should skip existing files
5x init opencode project
# Expected output: 5x-reviewer.md — skipped (already exists)

# Re-install with --force — should overwrite
5x init opencode project --force
# Expected output: 5x-reviewer.md — overwritten
```

---

## Scenario 5: `5x protocol validate` auto-detection

Verify that `5x protocol validate` handles both input formats:

**Raw native subagent output:**

```bash
echo '{"result":"complete","commit":"abc123","notes":"done"}' | \
  5x protocol validate author --no-require-commit
# Expected: ok: true, data contains the AuthorStatus payload
```

**`outputSuccess` envelope from `5x invoke`:**

```bash
echo '{"ok":true,"data":{"result":{"result":"complete","commit":"abc123","notes":"done"},"step_name":"author:implement"}}' | \
  5x protocol validate author --no-require-commit
# Expected: ok: true, data contains the unwrapped AuthorStatus payload
# (auto-detected the ok field and unwrapped .data.result)
```

---

## Pass Criteria

| Check | Expected |
|---|---|
| `5x init opencode project` installs 4 agents + 3 skills | ✓ |
| `5x init opencode user` installs to `~/.config/opencode/` (not `~/.opencode/`) | ✓ |
| OpenCode TUI shows native child sessions for delegated tasks | ✓ |
| `5x template render` output includes `## Context` block with worktree path | ✓ |
| `5x protocol validate --record` records step in `5x run state` | ✓ |
| Fallback path uses `5x invoke` when agents absent, records via `protocol validate` | ✓ |
| Auto-detection handles raw JSON and `outputSuccess` envelope | ✓ |
| `--force` overwrites; idempotent re-run without `--force` skips | ✓ |
| Existing `5x invoke` workflows unchanged when native agents absent | ✓ |
