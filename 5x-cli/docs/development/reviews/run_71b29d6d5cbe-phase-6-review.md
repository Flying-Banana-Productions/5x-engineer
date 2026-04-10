# Review: Mixed-Mode Delegation Phase 6

**Review type:** commit `40afa520662c53bc7d9d15aeb9d7975acb031ff8`
**Scope:** Phase 6 orchestrator profile updates for OpenCode and Cursor, plus follow-on commits
**Reviewer:** Staff engineer
**Local verification:** Not run — doc-only diff review against plan

## Summary

Phase 6 intent is mostly met. Both orchestrator profiles now tell the orchestrator to follow the skill's per-step delegation pattern and explicitly call out `5x invoke` JSON-envelope handling. That closes the main mixed-mode guidance gap from the plan.

**Readiness:** Ready with corrections — static guidance is correct in the key workflow section, but a few summary lines still describe the orchestrator as native-subagent-only.

## Strengths

- Updates the highest-signal section (`Key principles`) in both harness profiles, matching the Phase 6 plan.
- Correctly distinguishes native-subagent validation from `5x invoke` stdout-envelope handling.
- Keeps the change scoped to static orchestrator guidance, consistent with the phase design.

## Production Readiness Blockers

- None.

## High Priority (P1)

- None.

## Medium Priority (P2)

- Cursor and OpenCode profile metadata/intro text still frame the orchestrator as delegating only to native subagents (`src/harnesses/cursor/5x-orchestrator.mdc:2,9`, `src/harnesses/opencode/5x-orchestrator.md:11`). This is now inaccurate in mixed mode and can mislead users or tooling that surfaces only the header/intro instead of the full principles section.

## Readiness Checklist

**P0 blockers**
- [x] None.

**P1 recommended**
- [ ] Update orchestrator descriptions/intros to acknowledge mixed native + `5x invoke` delegation, not just native subagents.
