# Review: OpenCode 2.x harness assets and skill tokens

**Review type:** Implementation commit `9c8694cce4299c990a5211cc3decb3893c9677f5`  
**Scope:** Phase 4, including W5 and the installed-harness acceptance criterion AC3  
**Reviewer:** Staff engineer  
**Local verification:** 338 passed, 0 failed across 11 focused test files, including the AGENTS.md acceptance pair and native/invoke appended-context parity tests. The configured `phase finish` passed before review.

## Review Context

- Phase / review kind: Phase 4, initial material pass
- Reviewed range: `5ca4052d84598b2aa6644270c6c4c97dff4549fc..9c8694cce4299c990a5211cc3decb3893c9677f5`
- Binding / review context: `d175e674-cbdd-4fff-90f3-93619ffe02fc` / `9a697969-ab5f-452e-994c-22df8b354671`

## Summary

**Readiness:** Ready with corrections — the shipped lifecycle and installed continuation work; strengthen the render regression test so it verifies each launch against that step's own result consumer.

## Strengths

- Fresh project install from the reviewed build produced four agent files matching the reviewed source and eight skills. A separate password-protected OpenCode v2.4.2 server with isolated config and data listed the four agents with the intended permission rules and all eight skills, with no unsupported-agent-field warning. The installed all-native skill set has ten launch and ten child-ID capture lines. The focused suite also exercises stale 1.x install detection and byte-for-byte agent restoration by `harness sync opencode`.
- The recorded live model exercise shows installed `5x-orchestrator` session `ses_de177a4b7ffeO5E5nh7GRvYrNL` launching `5x-reviewer` and continuing `ses_de17797abffeL6sU89yzJdXpzu` with `sessionID`. Each tool response was only a launch acknowledgment; each distinct answer appeared in a separate completed background report for that child, and each parent's reported JSON matched the corresponding report and passed `5x protocol validate reviewer` without recording. The child listing contained one reviewer with both requests; the separate denial probe found no `subagent` tool or grandchildren. The live exercise's reviewer body preceded the final restoration of `write` to its tool list; the fresh install/API check above covered the final asset and its unchanged deny rule. Carry this transcript summary into the PR description.
- Independently rendered Cursor skills from the base and reviewed trees. All 32 SHA-256 digests (eight skills in four modes) match one another and the checked-in fixture. The transport-wording grep found no hits in bundled role prompts or `default-artifacts.ts`; neither needed changes. Runtime-appended native/invoke context parity passed unchanged.

## Medium Priority (P2)

### I1 — Bind lifecycle assertions to every expected native launch and its own consumer

**Classification:** `implementation_defect`, `auto_fix`  
**Approved work items:** W5  
**Risk:** The current render is correct, but its regression test can pass when an author step no longer validates/records its completion.  
**Requirement:** Phase 4.3–4.4 requires checking the launch/child ID/completed result sequence before each step's own validation or recording, across all delegation modes.  
**Evidence / correction:** In `5x-cli/test/unit/harnesses/opencode-skills.test.ts`, the four-mode lifecycle test searches to the end of the skill for `consumerIdx`. Its next-launch check compares against `resultIdx`, not the consumer. If the Step 2 `phase finish` consumer disappears from `5x-phase-execution`, Step 1 can borrow Step 2a's validation and the test still passes. The role checks also use nonzero counts, allowing a required site to disappear while another of the same role remains. Assert the planned launch sites per mode and require each matched consumer to appear before the next launch (or within the expected step), still reading `$RESULT`. No shipped workflow change is needed.
